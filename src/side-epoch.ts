import { createHash, randomUUID } from "node:crypto";
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
  convertToLlm,
  sessionEntryToContextMessages,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export const SIDE_EPOCH_CUSTOM_TYPE = "pi-augment.side-epoch.v1";
export const SIDE_EVENT_VERSION = 2;
export const SIDE_TEMPLATE_VERSION = 1;
export const SIDE_OUTPUT_RESERVE_TOKENS = 8_192;

const OM_OBSERVATIONS_RECORDED = "om.observations.recorded";
const OM_REFLECTIONS_RECORDED = "om.reflections.recorded";
const OM_OBSERVATIONS_DROPPED = "om.observations.dropped";
const SOURCE_ENTRY_TYPES = new Set([
  "message",
  "custom_message",
  "branch_summary",
]);
const MEMORY_ID_PATTERN = /^[a-f0-9]{12}$/;
const RELEVANCE_VALUES = new Set(["low", "medium", "high", "critical"]);

const OM_CONTEXT_INSTRUCTIONS = `These are condensed memories from earlier in this session.

- Reflections: stable, long-lived facts about the user, project, decisions, and constraints. New reflection lines may include ids in brackets.
- Observations: timestamped events from the conversation history, in chronological order. Observation lines include ids in brackets.

Treat these as past records. When entries conflict, the most recent observation reflects the latest known state. Work that prior observations describe as completed should not be redone unless the user explicitly asks to revisit it.

When exact source context is needed for precision or traceability, use the recall tool with the relevant observation or reflection id. This is especially useful when a reflection materially affects a decision or is too compressed to continue confidently. Do not use recall as broad search or inject raw source unless it is needed.`;

export const SIDE_SYSTEM_PROMPT = `You are an isolated persistent prompt-rewriting conversation for a parent Pi coding agent.

The first user message freezes the parent system prompt and an Observational Memory summary. Every later user message contains only newly completed parent-session source entries plus the current draft. Previous assistant messages are your own accepted rewrites from earlier turns in this same side conversation.

For each latest user turn, rewrite only its draft into a stronger prompt for the parent agent.
- Resolve references such as “刚才”, “这个方案”, and “those files” from the frozen memory, appended parent deltas, and relevant prior side turns.
- Newer parent deltas override older memory or side assumptions when they conflict.
- Preserve the user's language, objective, scope, paths, commands, constraints, and acceptance criteria.
- Add only context and execution structure supported by the supplied history; invent nothing.
- For non-trivial work, make objective, constraints, verification, and definition of done explicit and proportional.
- Keep the rewrite concise: do not copy context the parent already has; only resolve implicit references and add the execution contract needed for this task.
- Do not answer the draft, continue the parent task, call tools, modify files, or discuss this rewrite.
- Do not deliberate beyond what is needed for the rewrite.
- Return exactly one <pi-augment>...</pi-augment> block and nothing else.`;

interface OmObservation {
  id: string;
  content: string;
  timestamp: string;
  relevance: string;
  sourceEntryIds: string[];
  tokenCount: number;
}

interface OmReflection {
  id: string;
  content: string;
  supportingObservationIds: string[];
  tokenCount: number;
}

interface EpochModel {
  provider: string;
  id: string;
  api: string;
}

type SideEventVersion = 1 | typeof SIDE_EVENT_VERSION;

interface EpochCreatedEvent {
  version: SideEventVersion;
  kind: "created";
  epochId: string;
  sideSessionId: string;
  promptCacheKey: string;
  parentSessionId: string;
  model: EpochModel;
  templateVersion: number;
  templateHash: string;
  parentSystemHash: string;
  summaryHash: string;
  coverageEntryId: string;
  seedMessage: Message;
  createdAt: number;
}

interface EpochTurnEvent {
  version: SideEventVersion;
  kind: "turn";
  epochId: string;
  turn: number;
  fromParentEntryId: string;
  throughParentEntryId: string;
  parentSourceEntryIds: string[];
  userMessage: Message;
  assistantMessage: AssistantMessage;
  committedAt: number;
}

interface EpochClosedEvent {
  version: SideEventVersion;
  kind: "closed";
  epochId: string;
  reason: string;
  closedAt: number;
}

type EpochEvent = EpochCreatedEvent | EpochTurnEvent | EpochClosedEvent;

interface CompactCreatedRecord {
  version: typeof SIDE_EVENT_VERSION;
  kind: "created";
  epochId: string;
  sideSessionId: string;
  parentSessionId: string;
  model: EpochModel;
  templateVersion: number;
  templateHash: string;
  coverageEntryId: string;
  parentSystemPrompt: string;
  summary: string;
  seedTimestamp: number;
  createdAt: number;
}

interface CompactParentDelta {
  afterEntryId: string;
  throughEntryId: string;
  sourceEntryIds: string[];
  conversation: string;
}

interface CompactTurnRecord {
  version: typeof SIDE_EVENT_VERSION;
  kind: "turn";
  epochId: string;
  turn: number;
  parentDelta: CompactParentDelta;
  draft: string;
  userTimestamp: number;
  assistantMessage: AssistantMessage;
  committedAt: number;
}

interface CompactClosedRecord {
  version: typeof SIDE_EVENT_VERSION;
  kind: "closed";
  epochId: string;
  reason: string;
  closedAt: number;
}

export interface SideEpochState {
  created: EpochCreatedEvent;
  turns: EpochTurnEvent[];
  closedReason?: string;
}

export interface PreparedSideTurn {
  epoch: SideEpochState;
  messages: Message[];
  userMessage: Message;
  fromParentEntryId: string;
  throughParentEntryId: string;
  parentSourceEntryIds: string[];
  parentDeltaConversation: string;
  draft: string;
  turn: number;
  restored: boolean;
  rotatedReason?: string;
  estimatedInputTokens: number;
}

interface OmSnapshot {
  summary: string;
  summaryHash: string;
  coverageEntryId: string;
}

interface ParentDelta {
  text: string;
  sourceEntryIds: string[];
  throughEntryId: string;
}

type JsonRecord = Record<string, unknown>;

export function preparePersistentSideTurn(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  sideModel: Model<Api>,
  draft: string,
): PreparedSideTurn {
  const parentSessionId = ctx.sessionManager.getSessionId();
  const parentSystemPrompt = ctx.getSystemPrompt();
  const parentSystemHash = hashValue(parentSystemPrompt);
  const branch = ctx.sessionManager.getBranch();
  let epoch = restoreLatestEpoch(branch);
  let restored = epoch !== undefined;
  let rotatedReason: string | undefined;

  const compatibilityReason = epochCompatibilityFailure(
    epoch,
    branch,
    parentSessionId,
    parentSystemHash,
    sideModel,
  );
  if (compatibilityReason && epoch) {
    closeEpoch(pi, epoch, compatibilityReason);
    epoch = undefined;
    restored = false;
    rotatedReason = compatibilityReason;
  }

  if (!epoch) {
    epoch = createEpoch(
      pi,
      ctx.sessionManager.getBranch(),
      parentSessionId,
      parentSystemPrompt,
      parentSystemHash,
      sideModel,
    );
  }

  let prepared = buildPreparedTurn(
    epoch,
    ctx.sessionManager.getBranch(),
    draft,
    restored,
    rotatedReason,
  );

  if (requestExceedsContext(prepared, sideModel)) {
    if (epoch.turns.length === 0) {
      throw contextLimitError(prepared, sideModel);
    }
    const reason = `context_budget:${prepared.estimatedInputTokens}>${sideModel.contextWindow - SIDE_OUTPUT_RESERVE_TOKENS}`;
    closeEpoch(pi, epoch, reason);
    epoch = createEpoch(
      pi,
      ctx.sessionManager.getBranch(),
      parentSessionId,
      parentSystemPrompt,
      parentSystemHash,
      sideModel,
    );
    prepared = buildPreparedTurn(
      epoch,
      ctx.sessionManager.getBranch(),
      draft,
      false,
      reason,
    );
    if (requestExceedsContext(prepared, sideModel)) {
      throw contextLimitError(prepared, sideModel);
    }
  }

  return prepared;
}

export function commitPersistentSideTurn(
  pi: ExtensionAPI,
  prepared: PreparedSideTurn,
  assistantMessage: AssistantMessage,
): void {
  const committedAt = Date.now();
  const record: CompactTurnRecord = {
    version: SIDE_EVENT_VERSION,
    kind: "turn",
    epochId: prepared.epoch.created.epochId,
    turn: prepared.turn,
    parentDelta: {
      afterEntryId: prepared.fromParentEntryId,
      throughEntryId: prepared.throughParentEntryId,
      sourceEntryIds: prepared.parentSourceEntryIds,
      conversation: prepared.parentDeltaConversation,
    },
    draft: prepared.draft,
    userTimestamp: prepared.userMessage.timestamp,
    assistantMessage,
    committedAt,
  };
  pi.appendEntry(SIDE_EPOCH_CUSTOM_TYPE, record);
  prepared.epoch.turns.push({
    version: SIDE_EVENT_VERSION,
    kind: "turn",
    epochId: record.epochId,
    turn: record.turn,
    fromParentEntryId: record.parentDelta.afterEntryId,
    throughParentEntryId: record.parentDelta.throughEntryId,
    parentSourceEntryIds: record.parentDelta.sourceEntryIds,
    userMessage: prepared.userMessage,
    assistantMessage,
    committedAt,
  });
}

export function sideEpochDebugData(prepared: PreparedSideTurn): JsonRecord {
  return {
    epochHash: hashValue(prepared.epoch.created.epochId).slice(0, 12),
    sideSessionHash: hashValue(prepared.epoch.created.sideSessionId).slice(
      0,
      12,
    ),
    turn: prepared.turn,
    previousTurns: prepared.epoch.turns.length,
    sideMessageCount: prepared.messages.length,
    priorAssistantHash: prepared.epoch.turns.length
      ? hashValue(prepared.epoch.turns.at(-1)!.assistantMessage).slice(0, 12)
      : undefined,
    transcriptHash: hashValue(prepared.messages).slice(0, 12),
    restored: prepared.restored,
    rotatedReason: prepared.rotatedReason,
    parentDeltaEntries: prepared.parentSourceEntryIds.length,
    estimatedInputTokens: prepared.estimatedInputTokens,
    restoredStorageVersion:
      prepared.epoch.turns.at(-1)?.version ?? prepared.epoch.created.version,
    nextStorageVersion: SIDE_EVENT_VERSION,
  };
}

function buildPreparedTurn(
  epoch: SideEpochState,
  branch: SessionEntry[],
  draft: string,
  restored: boolean,
  rotatedReason?: string,
): PreparedSideTurn {
  const fromParentEntryId = latestParentBoundary(epoch);
  const delta = collectParentDelta(branch, fromParentEntryId);
  const turn = epoch.turns.length + 1;
  const parentDelta: CompactParentDelta = {
    afterEntryId: fromParentEntryId,
    throughEntryId: delta.throughEntryId,
    sourceEntryIds: delta.sourceEntryIds,
    conversation: delta.text,
  };
  const user = sideTurnUserMessage(
    epoch.created.epochId,
    turn,
    parentDelta,
    draft,
  );
  const messages = [
    epoch.created.seedMessage,
    ...epoch.turns.flatMap((item) => [item.userMessage, item.assistantMessage]),
    user,
  ];
  return {
    epoch,
    messages,
    userMessage: user,
    fromParentEntryId,
    throughParentEntryId: delta.throughEntryId,
    parentSourceEntryIds: delta.sourceEntryIds,
    parentDeltaConversation: delta.text,
    draft,
    turn,
    restored,
    rotatedReason,
    estimatedInputTokens: estimateRequestTokens(messages),
  };
}

function createEpoch(
  pi: ExtensionAPI,
  branch: SessionEntry[],
  parentSessionId: string,
  parentSystemPrompt: string,
  parentSystemHash: string,
  sideModel: Model<Api>,
): SideEpochState {
  const snapshot = buildOmSnapshot(branch);
  const epochId = randomUUID();
  const sideSessionId = randomUUID();
  const seedTimestamp = Date.now();
  const seedMessage = sideEpochSeedMessage(
    epochId,
    parentSystemPrompt,
    snapshot.summary,
    snapshot.coverageEntryId,
    seedTimestamp,
  );
  const createdAt = Date.now();
  const model: EpochModel = {
    provider: sideModel.provider,
    id: sideModel.id,
    api: sideModel.api,
  };
  const record: CompactCreatedRecord = {
    version: SIDE_EVENT_VERSION,
    kind: "created",
    epochId,
    sideSessionId,
    parentSessionId,
    model,
    templateVersion: SIDE_TEMPLATE_VERSION,
    templateHash: hashValue(SIDE_SYSTEM_PROMPT),
    coverageEntryId: snapshot.coverageEntryId,
    parentSystemPrompt,
    summary: snapshot.summary,
    seedTimestamp,
    createdAt,
  };
  pi.appendEntry(SIDE_EPOCH_CUSTOM_TYPE, record);
  return {
    created: {
      version: SIDE_EVENT_VERSION,
      kind: "created",
      epochId,
      sideSessionId,
      promptCacheKey: sideSessionId,
      parentSessionId,
      model,
      templateVersion: record.templateVersion,
      templateHash: record.templateHash,
      parentSystemHash,
      summaryHash: snapshot.summaryHash,
      coverageEntryId: snapshot.coverageEntryId,
      seedMessage,
      createdAt,
    },
    turns: [],
  };
}

function closeEpoch(
  pi: ExtensionAPI,
  epoch: SideEpochState,
  reason: string,
): void {
  const event: CompactClosedRecord = {
    version: SIDE_EVENT_VERSION,
    kind: "closed",
    epochId: epoch.created.epochId,
    reason,
    closedAt: Date.now(),
  };
  pi.appendEntry(SIDE_EPOCH_CUSTOM_TYPE, event);
  epoch.closedReason = reason;
}

function restoreLatestEpoch(
  branch: SessionEntry[],
): SideEpochState | undefined {
  const epochs = new Map<string, SideEpochState>();
  const order: string[] = [];
  for (const entry of branch) {
    if (
      entry.type !== "custom" ||
      entry.customType !== SIDE_EPOCH_CUSTOM_TYPE
    ) {
      continue;
    }
    const event = parseEpochEvent(entry.data);
    if (event.kind === "created") {
      if (epochs.has(event.epochId)) {
        throw new Error("side epoch 包含重复 created 事件。");
      }
      epochs.set(event.epochId, { created: event, turns: [] });
      order.push(event.epochId);
      continue;
    }
    const epoch = epochs.get(event.epochId);
    if (!epoch) throw new Error("side epoch 事件缺少对应 created 事件。");
    if (event.kind === "closed") {
      if (epoch.closedReason) throw new Error("side epoch 被重复关闭。");
      epoch.closedReason = event.reason;
      continue;
    }
    if (epoch.closedReason) throw new Error("已关闭 side epoch 后出现 turn。");
    const expectedTurn = epoch.turns.length + 1;
    if (event.turn !== expectedTurn) {
      throw new Error(
        `side epoch turn 不连续：期望 ${expectedTurn}，实际 ${event.turn}。`,
      );
    }
    const expectedBoundary = latestParentBoundary(epoch);
    if (event.fromParentEntryId !== expectedBoundary) {
      throw new Error("side epoch parent source 边界不连续。");
    }
    epoch.turns.push(event);
  }

  for (let index = order.length - 1; index >= 0; index -= 1) {
    const epoch = epochs.get(order[index]);
    if (epoch && !epoch.closedReason) return epoch;
  }
  return undefined;
}

function epochCompatibilityFailure(
  epoch: SideEpochState | undefined,
  branch: SessionEntry[],
  parentSessionId: string,
  parentSystemHash: string,
  sideModel: Model<Api>,
): string | undefined {
  if (!epoch) return undefined;
  const created = epoch.created;
  if (created.parentSessionId !== parentSessionId)
    return "parent_session_changed";
  if (
    created.model.provider !== sideModel.provider ||
    created.model.id !== sideModel.id ||
    created.model.api !== sideModel.api
  ) {
    return "side_model_changed";
  }
  if (
    created.templateVersion !== SIDE_TEMPLATE_VERSION ||
    created.templateHash !== hashValue(SIDE_SYSTEM_PROMPT)
  ) {
    return "side_template_changed";
  }
  if (created.parentSystemHash !== parentSystemHash) {
    return "parent_system_changed";
  }
  const ids = new Set(branch.map((entry) => entry.id));
  if (!ids.has(created.coverageEntryId)) return "om_coverage_left_branch";
  if (!ids.has(latestParentBoundary(epoch)))
    return "parent_boundary_left_branch";
  return undefined;
}

function buildOmSnapshot(branch: SessionEntry[]): OmSnapshot {
  const indexes = new Map(branch.map((entry, index) => [entry.id, index]));
  const observations = new Map<string, OmObservation>();
  const reflections = new Map<string, OmReflection>();
  const dropped = new Set<string>();
  let coverageEntryId: string | undefined;
  let coverageIndex = -1;

  for (const entry of branch) {
    if (entry.type !== "custom") continue;
    if (entry.customType === OM_OBSERVATIONS_RECORDED) {
      const data = parseObservationsRecorded(entry.data);
      if (!data) continue;
      const coveredIndex = indexes.get(data.coversUpToId);
      if (coveredIndex === undefined) continue;
      for (const observation of data.observations) {
        if (!observations.has(observation.id)) {
          observations.set(observation.id, observation);
        }
      }
      if (coveredIndex > coverageIndex) {
        coverageIndex = coveredIndex;
        coverageEntryId = data.coversUpToId;
      }
      continue;
    }
    if (entry.customType === OM_REFLECTIONS_RECORDED) {
      const data = parseReflectionsRecorded(entry.data);
      if (!data) continue;
      for (const reflection of data.reflections) {
        if (!reflections.has(reflection.id)) {
          reflections.set(reflection.id, reflection);
        }
      }
      continue;
    }
    if (entry.customType === OM_OBSERVATIONS_DROPPED) {
      const data = parseObservationsDropped(entry.data);
      if (!data) continue;
      for (const observationId of data.observationIds)
        dropped.add(observationId);
    }
  }

  if (!coverageEntryId || coverageIndex < 0) {
    throw new Error(
      "当前 branch 没有可解析的 Observational Memory observations coversUpToId；拒绝静默回退到完整父会话。",
    );
  }
  if (!SOURCE_ENTRY_TYPES.has(branch[coverageIndex].type)) {
    throw new Error("Observational Memory coversUpToId 未指向 source entry。");
  }
  const activeObservations = [...observations.values()].filter(
    (observation) => !dropped.has(observation.id),
  );
  const summary = renderOmSummary(
    [...reflections.values()],
    activeObservations,
  );
  if (!summary) throw new Error("Observational Memory summary 为空。");
  return {
    summary,
    summaryHash: hashValue(summary),
    coverageEntryId,
  };
}

function collectParentDelta(
  branch: SessionEntry[],
  afterEntryId: string,
): ParentDelta {
  const boundaryIndex = branch.findIndex((entry) => entry.id === afterEntryId);
  if (boundaryIndex < 0)
    throw new Error("side epoch parent source 边界不在当前 branch。 ");
  const sourceEntries = branch
    .slice(boundaryIndex + 1)
    .filter((entry) => SOURCE_ENTRY_TYPES.has(entry.type));
  const sourceEntryIds = sourceEntries.map((entry) => entry.id);
  return {
    text: serializeSourceEntries(sourceEntries),
    sourceEntryIds,
    throughEntryId: sourceEntryIds.at(-1) ?? afterEntryId,
  };
}

function serializeSourceEntries(entries: SessionEntry[]): string {
  const blocks: string[] = [];
  for (const entry of entries) {
    const messages = convertToLlm(sessionEntryToContextMessages(entry));
    const body = serializeMessages(messages);
    if (body) blocks.push(`[Source entry id: ${entry.id}]\n${body}`);
  }
  return blocks.join("\n\n");
}

function serializeMessages(messages: Message[]): string {
  return messages
    .map((message) => {
      if (message.role === "user") {
        return `[User]: ${serializeContent(message.content)}`;
      }
      if (message.role === "assistant") {
        return `[Assistant]: ${serializeAssistantContent(message)}`;
      }
      const toolResult = message as ToolResultMessage;
      return `[Tool result: ${toolResult.toolName}]: ${serializeContent(toolResult.content)}`;
    })
    .filter(Boolean)
    .join("\n\n");
}

function serializeAssistantContent(message: AssistantMessage): string {
  return message.content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "thinking") return `[thinking: ${block.thinking}]`;
      return `[tool call: ${block.name}(${JSON.stringify(block.arguments)})]`;
    })
    .filter(Boolean)
    .join("\n");
}

function serializeContent(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : "[image omitted]"))
    .join("\n");
}

function renderOmSummary(
  reflections: OmReflection[],
  observations: OmObservation[],
): string {
  if (reflections.length === 0 && observations.length === 0) return "";
  const parts = [OM_CONTEXT_INSTRUCTIONS];
  if (reflections.length > 0) {
    parts.push(
      `## Reflections\n${reflections.map((item) => `[${item.id}] ${item.content}`).join("\n")}`,
    );
  }
  if (observations.length > 0) {
    parts.push(
      `## Observations\n${observations
        .map(
          (item) =>
            `[${item.id}] ${item.timestamp} [${item.relevance}] ${item.content}`,
        )
        .join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

function latestParentBoundary(epoch: SideEpochState): string {
  return (
    epoch.turns.at(-1)?.throughParentEntryId ?? epoch.created.coverageEntryId
  );
}

function estimateRequestTokens(messages: Message[]): number {
  const characters =
    SIDE_SYSTEM_PROMPT.length +
    messages.reduce(
      (total, message) => total + JSON.stringify(message).length,
      0,
    );
  return Math.ceil(characters / 4) + messages.length * 8;
}

function requestExceedsContext(
  prepared: PreparedSideTurn,
  model: Model<Api>,
): boolean {
  return (
    prepared.estimatedInputTokens + SIDE_OUTPUT_RESERVE_TOKENS >=
    model.contextWindow
  );
}

function contextLimitError(
  prepared: PreparedSideTurn,
  model: Model<Api>,
): Error {
  return new Error(
    `side epoch 输入估算 ${prepared.estimatedInputTokens} tokens，加输出预留 ${SIDE_OUTPUT_RESERVE_TOKENS} 后超过 ${model.provider}/${model.id} 的 ${model.contextWindow} context window；未截断或降级。`,
  );
}

function parseEpochEvent(value: unknown): EpochEvent {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new Error("side epoch custom entry 格式无效。");
  }
  if (value.version === 1) {
    if (value.kind === "created" && isLegacyCreatedEvent(value)) return value;
    if (value.kind === "turn" && isLegacyTurnEvent(value)) return value;
    if (value.kind === "closed" && isClosedRecord(value)) return value;
    throw new Error("side epoch version 1 custom entry 内容无效。");
  }
  if (value.version === SIDE_EVENT_VERSION) {
    if (value.kind === "created") {
      const event = parseCompactCreatedRecord(value);
      if (event) return event;
    }
    if (value.kind === "turn") {
      const event = parseCompactTurnRecord(value);
      if (event) return event;
    }
    if (value.kind === "closed" && isClosedRecord(value)) return value;
    throw new Error("side epoch version 2 custom entry 内容无效。");
  }
  throw new Error(
    `side epoch event version=${String(value.version)} 不受支持。`,
  );
}

function isLegacyCreatedEvent(value: unknown): value is EpochCreatedEvent {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    hasStrings(value, [
      "epochId",
      "sideSessionId",
      "promptCacheKey",
      "parentSessionId",
      "templateHash",
      "parentSystemHash",
      "summaryHash",
      "coverageEntryId",
    ]) &&
    value.kind === "created" &&
    Number.isInteger(value.templateVersion) &&
    (value.templateVersion as number) > 0 &&
    typeof value.createdAt === "number" &&
    value.promptCacheKey === value.sideSessionId &&
    value.sideSessionId !== value.parentSessionId &&
    isEpochModel(value.model) &&
    isMessage(value.seedMessage, "user")
  );
}

function isLegacyTurnEvent(value: unknown): value is EpochTurnEvent {
  if (!isRecord(value)) return false;
  return (
    value.version === 1 &&
    value.kind === "turn" &&
    hasStrings(value, [
      "epochId",
      "fromParentEntryId",
      "throughParentEntryId",
    ]) &&
    Number.isInteger(value.turn) &&
    (value.turn as number) > 0 &&
    Array.isArray(value.parentSourceEntryIds) &&
    value.parentSourceEntryIds.every(isNonEmptyString) &&
    validParentBoundary(
      value.fromParentEntryId as string,
      value.throughParentEntryId as string,
      value.parentSourceEntryIds as string[],
    ) &&
    isMessage(value.userMessage, "user") &&
    isMessage(value.assistantMessage, "assistant") &&
    typeof value.committedAt === "number"
  );
}

function parseCompactCreatedRecord(
  value: JsonRecord,
): EpochCreatedEvent | undefined {
  if (
    value.version !== SIDE_EVENT_VERSION ||
    value.kind !== "created" ||
    !hasStrings(value, [
      "epochId",
      "sideSessionId",
      "parentSessionId",
      "templateHash",
      "coverageEntryId",
      "parentSystemPrompt",
      "summary",
    ]) ||
    value.sideSessionId === value.parentSessionId ||
    !Number.isInteger(value.templateVersion) ||
    (value.templateVersion as number) <= 0 ||
    typeof value.seedTimestamp !== "number" ||
    typeof value.createdAt !== "number" ||
    !isEpochModel(value.model)
  ) {
    return undefined;
  }
  const summaryHash = hashValue(value.summary);
  return {
    version: SIDE_EVENT_VERSION,
    kind: "created",
    epochId: value.epochId as string,
    sideSessionId: value.sideSessionId as string,
    promptCacheKey: value.sideSessionId as string,
    parentSessionId: value.parentSessionId as string,
    model: value.model,
    templateVersion: value.templateVersion as number,
    templateHash: value.templateHash as string,
    parentSystemHash: hashValue(value.parentSystemPrompt),
    summaryHash,
    coverageEntryId: value.coverageEntryId as string,
    seedMessage: sideEpochSeedMessage(
      value.epochId as string,
      value.parentSystemPrompt as string,
      value.summary as string,
      value.coverageEntryId as string,
      value.seedTimestamp,
    ),
    createdAt: value.createdAt,
  };
}

function parseCompactTurnRecord(value: JsonRecord): EpochTurnEvent | undefined {
  if (
    value.version !== SIDE_EVENT_VERSION ||
    value.kind !== "turn" ||
    !hasStrings(value, ["epochId", "draft"]) ||
    !Number.isInteger(value.turn) ||
    (value.turn as number) <= 0 ||
    typeof value.userTimestamp !== "number" ||
    typeof value.committedAt !== "number" ||
    !isMessage(value.assistantMessage, "assistant") ||
    !isCompactParentDelta(value.parentDelta)
  ) {
    return undefined;
  }
  return {
    version: SIDE_EVENT_VERSION,
    kind: "turn",
    epochId: value.epochId as string,
    turn: value.turn as number,
    fromParentEntryId: value.parentDelta.afterEntryId,
    throughParentEntryId: value.parentDelta.throughEntryId,
    parentSourceEntryIds: value.parentDelta.sourceEntryIds,
    userMessage: sideTurnUserMessage(
      value.epochId as string,
      value.turn as number,
      value.parentDelta,
      value.draft as string,
      value.userTimestamp,
    ),
    assistantMessage: value.assistantMessage as AssistantMessage,
    committedAt: value.committedAt,
  };
}

function isCompactParentDelta(value: unknown): value is CompactParentDelta {
  if (
    !isRecord(value) ||
    !hasStrings(value, ["afterEntryId", "throughEntryId"]) ||
    typeof value.conversation !== "string" ||
    !Array.isArray(value.sourceEntryIds) ||
    !value.sourceEntryIds.every(isNonEmptyString)
  ) {
    return false;
  }
  return validParentBoundary(
    value.afterEntryId as string,
    value.throughEntryId as string,
    value.sourceEntryIds as string[],
  );
}

function validParentBoundary(
  fromEntryId: string,
  throughEntryId: string,
  sourceEntryIds: string[],
): boolean {
  return (
    (sourceEntryIds.length === 0 && throughEntryId === fromEntryId) ||
    (sourceEntryIds.length > 0 && sourceEntryIds.at(-1) === throughEntryId)
  );
}

function isClosedRecord(value: unknown): value is EpochClosedEvent {
  if (!isRecord(value)) return false;
  return (
    (value.version === 1 || value.version === SIDE_EVENT_VERSION) &&
    value.kind === "closed" &&
    hasStrings(value, ["epochId", "reason"]) &&
    typeof value.closedAt === "number"
  );
}

function isEpochModel(value: unknown): value is EpochModel {
  return isRecord(value) && hasStrings(value, ["provider", "id", "api"]);
}

function isMessage(
  value: unknown,
  role: "user" | "assistant",
): value is Message {
  return (
    isRecord(value) &&
    value.role === role &&
    Array.isArray(value.content) &&
    typeof value.timestamp === "number"
  );
}

function parseObservationsRecorded(
  value: unknown,
): { observations: OmObservation[]; coversUpToId: string } | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.coversUpToId) ||
    !Array.isArray(value.observations) ||
    value.observations.length === 0 ||
    !value.observations.every(isObservation)
  ) {
    return undefined;
  }
  return {
    observations: value.observations as OmObservation[],
    coversUpToId: value.coversUpToId,
  };
}

function parseReflectionsRecorded(
  value: unknown,
): { reflections: OmReflection[]; coversUpToId: string } | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.coversUpToId) ||
    !Array.isArray(value.reflections) ||
    value.reflections.length === 0 ||
    !value.reflections.every(isReflection)
  ) {
    return undefined;
  }
  return {
    reflections: value.reflections as OmReflection[],
    coversUpToId: value.coversUpToId,
  };
}

function parseObservationsDropped(
  value: unknown,
): { observationIds: string[]; coversUpToId: string } | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.coversUpToId) ||
    !Array.isArray(value.observationIds) ||
    value.observationIds.length === 0 ||
    !value.observationIds.every(isNonEmptyString)
  ) {
    return undefined;
  }
  return {
    observationIds: value.observationIds as string[],
    coversUpToId: value.coversUpToId,
  };
}

function isObservation(value: unknown): value is OmObservation {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    MEMORY_ID_PATTERN.test(value.id) &&
    isNonEmptyString(value.content) &&
    isNonEmptyString(value.timestamp) &&
    typeof value.relevance === "string" &&
    RELEVANCE_VALUES.has(value.relevance) &&
    Array.isArray(value.sourceEntryIds) &&
    value.sourceEntryIds.length > 0 &&
    value.sourceEntryIds.every(isNonEmptyString) &&
    typeof value.tokenCount === "number" &&
    Number.isFinite(value.tokenCount) &&
    value.tokenCount >= 0
  );
}

function isReflection(value: unknown): value is OmReflection {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    MEMORY_ID_PATTERN.test(value.id) &&
    isNonEmptyString(value.content) &&
    Array.isArray(value.supportingObservationIds) &&
    value.supportingObservationIds.length > 0 &&
    value.supportingObservationIds.every(isNonEmptyString) &&
    typeof value.tokenCount === "number" &&
    Number.isFinite(value.tokenCount) &&
    value.tokenCount >= 0
  );
}

function hasStrings(value: JsonRecord, keys: string[]): boolean {
  return keys.every((key) => isNonEmptyString(value[key]));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function sideEpochSeedMessage(
  epochId: string,
  parentSystemPrompt: string,
  summary: string,
  coverageEntryId: string,
  timestamp = Date.now(),
): Message {
  return userMessage(
    JSON.stringify({
      type: "pi-augment-side-epoch",
      version: 1,
      epochId,
      parentSystemPrompt,
      observationalMemory: {
        summary,
        summaryHash: hashValue(summary),
        coversUpToId: coverageEntryId,
      },
    }),
    timestamp,
  );
}

function sideTurnUserMessage(
  epochId: string,
  turn: number,
  parentDelta: CompactParentDelta,
  draft: string,
  timestamp = Date.now(),
): Message {
  return userMessage(
    JSON.stringify({
      type: "pi-augment-side-turn",
      version: 1,
      epochId,
      turn,
      parentDelta,
      draft,
    }),
    timestamp,
  );
}

function userMessage(text: string, timestamp = Date.now()): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  };
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
