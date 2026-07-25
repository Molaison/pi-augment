import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type Model,
  type Usage,
} from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import {
  buildSessionContext,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  commitPersistentSideTurn,
  preparePersistentSideTurn,
  SIDE_SYSTEM_PROMPT,
  sideEpochDebugData,
} from "./side-epoch.js";

const COMMAND = "augment";
const DEBUG_FLAG = "augment-debug";
const SUPPORTED_API = "openai-codex-responses";
const SENTINEL_OPEN = "<pi-augment>";
const SENTINEL_CLOSE = "</pi-augment>";
const PARENT_WAIT_TIMEOUT_MS = 120_000;
const SIDE_REQUEST_TIMEOUT_MS = 45_000;
const ESCAPE = "\x1b";

type JsonRecord = Record<string, unknown>;
type DebugData = Record<string, unknown>;
type StageReporter = (label: string, data?: DebugData) => void;

interface CodexPayload extends JsonRecord {
  model: string;
  input: unknown[];
}

interface ConfiguredModel {
  provider: string;
  id: string;
}

interface SessionInvariant {
  sessionId: string;
  contextHash: string;
}

interface AugmentResult {
  prompt: string;
  usage: Usage;
  modelLabel: string;
  elapsedMs: number;
  epochHash: string;
  turn: number;
  restored: boolean;
  rotatedReason?: string;
}

class AugmentCancelledError extends Error {}
class AugmentTimeoutError extends Error {}

export default function piAugment(pi: ExtensionAPI): void {
  let activeController: AbortController | undefined;

  pi.registerFlag(DEBUG_FLAG, {
    description: "输出 pi-augment 阶段、路由、payload 和 usage 调试信息",
    type: "boolean",
    default: false,
  });

  const debug = (stage: string, data: DebugData = {}): void => {
    if (pi.getFlag(DEBUG_FLAG) !== true) return;
    console.error(
      `[pi-augment:debug] ${JSON.stringify({ stage, timestamp: Date.now(), ...data })}`,
    );
  };

  pi.registerCommand(COMMAND, {
    description: "使用持久连续 side cache epoch 增强提示词",
    async handler(args, ctx) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify(`/${COMMAND} 仅支持 Pi 交互模式。`, "error");
        return;
      }

      const draft = args.trim();
      if (!draft) {
        ctx.ui.notify(`用法：/${COMMAND} <提示词>`, "error");
        return;
      }
      if (activeController) {
        ctx.ui.notify(
          "已有一个 Augment 正在运行；请先等待或按 Esc 取消。",
          "warning",
        );
        return;
      }

      const controller = new AbortController();
      activeController = controller;
      const startedAt = Date.now();
      const parentSessionId = ctx.sessionManager.getSessionId();
      let phase = "准备";
      const updateStatus = (): void => {
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        ctx.ui.setStatus(
          COMMAND,
          `${phase} · ${seconds}s · Esc 仅取消 Augment`,
        );
      };
      const reportStage: StageReporter = (label, data = {}) => {
        phase = label;
        updateStatus();
        debug(label, {
          elapsedMs: Date.now() - startedAt,
          parentSessionHash: hashValue(parentSessionId).slice(0, 12),
          ...data,
        });
      };
      const statusTimer = setInterval(updateStatus, 1000);
      const removeTerminalListener = ctx.ui.onTerminalInput((data) => {
        if (data !== ESCAPE || controller.signal.aborted) return undefined;
        controller.abort(new AugmentCancelledError("用户已取消 Augment。"));
        return { consume: true };
      });

      try {
        if (!ctx.isIdle()) {
          reportStage("1/5 等待父 turn 完成");
          await waitWithAbortAndTimeout(
            ctx.waitForIdle(),
            controller.signal,
            PARENT_WAIT_TIMEOUT_MS,
            "等待父 turn 完成超时；父 turn 未被中断。",
          );
        }
        throwIfAborted(controller.signal);
        if (ctx.sessionManager.getSessionId() !== parentSessionId) {
          throw new Error("等待期间活动 Pi session 已改变；未启动 side 请求。");
        }

        reportStage("2/5 恢复或创建持久 side epoch");
        const sideTimeout = AbortSignal.timeout(SIDE_REQUEST_TIMEOUT_MS);
        const sideSignal = AbortSignal.any([controller.signal, sideTimeout]);
        let result: AugmentResult;
        try {
          result = await augmentFromCurrentContext(
            pi,
            ctx,
            draft,
            parentSessionId,
            sideSignal,
            reportStage,
          );
        } catch (error) {
          if (sideTimeout.aborted && !controller.signal.aborted) {
            throw new AugmentTimeoutError(
              "Prompt Enhance 超过 45 秒，side 请求已取消。",
            );
          }
          throw error;
        }
        throwIfAborted(controller.signal);

        reportStage("5/5 回填输入框", {
          model: result.modelLabel,
          usage: compactUsage(result.usage),
        });
        ctx.ui.setEditorText(result.prompt);
        const cacheStatus =
          result.usage.cacheRead > 0
            ? `side cacheRead=${result.usage.cacheRead}`
            : "side cacheRead=0";
        const rotation = result.rotatedReason
          ? `，新 epoch 原因=${result.rotatedReason}`
          : result.restored
            ? "，已恢复持久 epoch"
            : "，已创建持久 epoch";
        ctx.ui.notify(
          `已回填增强提示词；${result.modelLabel}，epoch=${result.epochHash} turn=${result.turn}${rotation}，reasoning=none，${cacheStatus}，请求 ${result.elapsedMs}ms；side 状态已持久化，父模型上下文未写入。`,
          "info",
        );
      } catch (error) {
        const normalized = normalizeFlowError(error, controller.signal);
        if (!ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(draft);
        if (normalized instanceof AugmentCancelledError) {
          debug("cancelled", { elapsedMs: Date.now() - startedAt });
          ctx.ui.notify(
            "已取消 Augment；父 turn 和父会话未被中断。",
            "warning",
          );
        } else {
          const message = errorMessage(normalized);
          console.error(`[pi-augment] ${message}`);
          ctx.ui.notify(message, "error");
        }
      } finally {
        clearInterval(statusTimer);
        removeTerminalListener();
        ctx.ui.setStatus(COMMAND, undefined);
        if (activeController === controller) activeController = undefined;
      }
    },
  });
}

async function augmentFromCurrentContext(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  draft: string,
  parentSessionId: string,
  signal: AbortSignal,
  reportStage: StageReporter,
): Promise<AugmentResult> {
  const parentModel = ctx.model;
  if (!isSupportedModel(parentModel)) {
    throw new Error(
      `/${COMMAND} 要求父模型 API ${SUPPORTED_API}；当前模型为 ${parentModel ? `${parentModel.provider}/${parentModel.id} (${parentModel.api})` : "无"}。`,
    );
  }

  const sideModel = resolveObservationalMemoryModel(ctx);
  const modelLabel = `${sideModel.provider}/${sideModel.id}`;
  const beforeSession = sessionInvariant(ctx);
  const prepared = preparePersistentSideTurn(pi, ctx, sideModel, draft);
  assertParentSessionUnchanged(ctx, beforeSession);
  const epochDebug = sideEpochDebugData(prepared);
  const sideSessionId = prepared.epoch.created.sideSessionId;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(sideModel);
  if (!auth.ok) throw new Error(auth.error);
  if (!auth.apiKey) throw new Error(`${modelLabel} 没有可用的 API key。`);

  reportStage("3/5 持久连续 side 请求", {
    model: modelLabel,
    ...epochDebug,
    identitiesSeparated: sideSessionId !== parentSessionId,
    reasoning: "none",
    tools: 0,
  });

  throwIfAborted(signal);
  const startedAt = Date.now();
  let submitted = false;
  const response = await complete(
    sideModel,
    {
      systemPrompt: SIDE_SYSTEM_PROMPT,
      messages: prepared.messages,
      tools: [],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      env: auth.env,
      signal,
      cacheRetention: "long",
      reasoningEffort: "none",
      sessionId: sideSessionId,
      transport: "sse",
      maxRetries: 0,
      onPayload: (generatedPayload) => {
        const generated = requireCodexPayload(generatedPayload);
        const sidePayload: CodexPayload = {
          ...generated,
          prompt_cache_key: sideSessionId,
          store: false,
          stream: true,
        };
        delete sidePayload.previous_response_id;
        assertSidePayload(
          sidePayload,
          sideModel.id,
          sideSessionId,
          parentSessionId,
        );
        submitted = true;
        reportStage("3/5 持久连续 side 请求", {
          model: modelLabel,
          ...epochDebug,
          inputItems: sidePayload.input.length,
          payloadBytes: JSON.stringify(sidePayload).length,
          reasoning: sidePayload.reasoning,
          tools: Array.isArray(sidePayload.tools)
            ? sidePayload.tools.length
            : 0,
          identitiesSeparated: true,
        });
        return sidePayload;
      },
    },
  );

  if (!submitted) throw new Error("provider 未构建 side payload。");
  throwIfAborted(signal);
  assertParentSessionUnchanged(ctx, beforeSession);
  reportStage("4/5 校验增强结果", {
    model: modelLabel,
    stopReason: response.stopReason,
    usage: compactUsage(response.usage),
  });
  const prompt = extractAugmentedPrompt(response);
  commitPersistentSideTurn(pi, prepared, response);
  assertParentSessionUnchanged(ctx, beforeSession);
  return {
    prompt,
    usage: response.usage,
    modelLabel,
    elapsedMs: Date.now() - startedAt,
    epochHash: epochDebug.epochHash as string,
    turn: prepared.turn,
    restored: prepared.restored,
    rotatedReason: prepared.rotatedReason,
  };
}

function resolveObservationalMemoryModel(
  ctx: ExtensionCommandContext,
): Model<Api> {
  const configured = readObservationalMemoryModel(ctx.cwd);
  if (!configured) {
    throw new Error(
      "未配置 observational-memory.model；拒绝静默退回昂贵的主模型。",
    );
  }
  const model = ctx.modelRegistry.find(configured.provider, configured.id);
  if (!model) {
    throw new Error(
      `Observational Memory 模型 ${configured.provider}/${configured.id} 不在 Pi model registry 中。`,
    );
  }
  const modelApi = model.api;
  if (modelApi !== SUPPORTED_API) {
    throw new Error(
      `Observational Memory 模型必须使用 ${SUPPORTED_API}；当前为 ${modelApi}。`,
    );
  }
  return model as Model<Api>;
}

function readObservationalMemoryModel(
  cwd: string,
): ConfiguredModel | undefined {
  const globalModel = readModelFromSettings(
    join(getAgentDir(), "settings.json"),
  );
  const projectModel = readModelFromSettings(join(cwd, ".pi", "settings.json"));
  return projectModel ?? globalModel;
}

function readModelFromSettings(path: string): ConfiguredModel | undefined {
  if (!existsSync(path)) return undefined;
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 ${path}：${errorMessage(error)}`);
  }
  if (!isRecord(settings)) return undefined;
  const namespace = settings["observational-memory"];
  if (!isRecord(namespace) || !isRecord(namespace.model)) return undefined;
  const provider = namespace.model.provider;
  const id = namespace.model.id;
  if (
    typeof provider !== "string" ||
    !provider ||
    typeof id !== "string" ||
    !id
  ) {
    return undefined;
  }
  return { provider, id };
}

function assertParentSessionUnchanged(
  ctx: ExtensionCommandContext,
  before: SessionInvariant,
): void {
  const after = sessionInvariant(ctx);
  if (
    after.sessionId !== before.sessionId ||
    after.contextHash !== before.contextHash
  ) {
    throw new Error("增强期间父 Pi 模型上下文发生变化；结果未写入输入框。");
  }
}

function extractAugmentedPrompt(response: AssistantMessage): string {
  if (response.stopReason !== "stop") {
    throw new Error(
      response.errorMessage ??
        `增强 side 请求以 stopReason=${response.stopReason} 结束；未接受部分结果。`,
    );
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    throw new Error("side 模型请求了工具；未执行工具，也未接受结果。");
  }
  if (
    response.content.some(
      (block) => block.type === "thinking" && block.thinking.trim().length > 0,
    ) ||
    (response.usage.reasoning ?? 0) > 0
  ) {
    throw new Error(
      "provider 在 reasoning=none 下仍生成了 thinking；结果未接受。",
    );
  }

  const text = response.content
    .filter(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
  return parseStrictSentinel(text);
}

function requireCodexPayload(value: unknown): CodexPayload {
  if (!isRecord(value)) throw new Error("provider payload 不是对象");
  if (typeof value.model !== "string" || value.model.length === 0) {
    throw new Error("provider payload 缺少 model");
  }
  if (!Array.isArray(value.input)) {
    throw new Error("provider payload input 不是数组");
  }
  return value as CodexPayload;
}

function assertSidePayload(
  payload: CodexPayload,
  modelId: string,
  sideSessionId: string,
  parentSessionId: string,
): void {
  if (payload.model !== modelId) {
    throw new Error("side payload 与配置的 OM 模型不匹配。");
  }
  if (
    payload.prompt_cache_key !== sideSessionId ||
    sideSessionId === parentSessionId ||
    payload.prompt_cache_key === parentSessionId
  ) {
    throw new Error("side payload 未与父 session/cache route 完全分离。");
  }
  if ("previous_response_id" in payload) {
    throw new Error("side payload 意外保留了 previous_response_id。");
  }
  if (payload.store !== false) {
    throw new Error("side payload 必须使用 store=false。");
  }
  if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    throw new Error("side payload 不允许声明工具。");
  }
  const reasoning = payload.reasoning;
  if (!isRecord(reasoning) || reasoning.effort !== "none") {
    throw new Error("side payload 未强制 reasoning.effort=none。");
  }
}

function sessionInvariant(ctx: ExtensionCommandContext): SessionInvariant {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    contextHash: hashValue(getSessionMessages(ctx)),
  };
}

function getSessionMessages(ctx: ExtensionContext): AgentMessage[] {
  return buildSessionContext(
    ctx.sessionManager.getBranch(),
    ctx.sessionManager.getLeafId(),
  ).messages;
}

function parseStrictSentinel(text: string): string {
  const openIndex = text.indexOf(SENTINEL_OPEN);
  const closeIndex = text.indexOf(SENTINEL_CLOSE);
  if (
    openIndex < 0 ||
    closeIndex < 0 ||
    text.indexOf(SENTINEL_OPEN, openIndex + SENTINEL_OPEN.length) >= 0 ||
    text.indexOf(SENTINEL_CLOSE, closeIndex + SENTINEL_CLOSE.length) >= 0
  ) {
    throw new Error("增强输出违反严格 sentinel 协议。");
  }

  const before = text.slice(0, openIndex).trim();
  const body = text.slice(openIndex + SENTINEL_OPEN.length, closeIndex).trim();
  const after = text.slice(closeIndex + SENTINEL_CLOSE.length).trim();
  if (before || after || !body || closeIndex < openIndex) {
    throw new Error("增强输出在 sentinel 外包含文本，或提示词为空。");
  }
  return body;
}

async function waitWithAbortAndTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void =>
      finish(() => reject(normalizeAbortReason(signal.reason)));
    const timeout = setTimeout(
      () => finish(() => reject(new AugmentTimeoutError(timeoutMessage))),
      timeoutMs,
    );
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw normalizeAbortReason(signal.reason);
}

function normalizeAbortReason(reason: unknown): Error {
  if (reason instanceof AugmentCancelledError) return reason;
  if (reason instanceof Error) return reason;
  return new AugmentCancelledError("Augment 已取消。");
}

function normalizeFlowError(error: unknown, signal: AbortSignal): Error {
  if (signal.aborted) return normalizeAbortReason(signal.reason);
  return error instanceof Error ? error : new Error(String(error));
}

function compactUsage(usage: Usage): DebugData {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    reasoning: usage.reasoning ?? 0,
    cost: usage.cost.total,
  };
}

function isSupportedModel(model: Model<Api> | undefined): model is Model<Api> {
  return model?.api === SUPPORTED_API;
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
