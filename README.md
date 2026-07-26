# pi-augment

面向 Pi `openai-codex-responses` 的持久化连续 Prompt Enhance 插件。

`/augment` 不再为每次调用创建一次性 side route，而是在当前 Pi branch 内维护一个独立的 **side cache epoch**：

```text
固定 side system prompt
+ 冻结 parent system prompt
+ 冻结 Observational Memory summary（真正空会话则为显式 empty-parent root）
+ 第 1 轮 parent 原始尾部与 draft
+ 第 1 轮 side assistant
+ 第 2 轮新增 parent 尾部与 draft
+ 第 2 轮 side assistant
+ ...
```

同一 epoch 始终复用同一个 side `sessionId/prompt_cache_key`。每轮请求完整重放已持久化 transcript，并只追加新的 parent source entries 与当前 draft，因此 provider 输入保持 append-only。上一轮 side 输出会参与下一轮增强语义。

增强结果仍只通过 `setEditorText()` 自动回填，不自动发送，也不成为父模型消息。

## 上下文来源

Epoch 创建时读取 Observational Memory V3 ledger：

- `om.observations.recorded`
- `om.reflections.recorded`
- `om.observations.dropped`

插件冻结当前 reflections + active observations，并以最新有效 observation `coversUpToId` 为边界。边界之后的 `message`、`custom_message` 和 `branch_summary` 作为未压缩原始尾部；后续调用只追加上次边界之后的新 source entries。

首次新开会话即使已有 `model_change` 等设置 entry，只要还没有任何 `message`、`custom_message`、`branch_summary`，且没有任何 OM ledger entry，插件会建立显式 empty-parent bootstrap epoch：其概念根边界固定为 `pi-augment:empty-parent-root:v1`，seed 标记 `emptyParentContext`，第一轮 parent delta 为空。它不是 OM summary，不写 `om.*`，也不读取另一套 fallback 上下文；后续轮次继续同一 side epoch，出现真实 parent source entries 后会从该概念根收集并转入普通真实 entry 边界。

Pi core 对全新 session 会把首次 JSONL flush 延迟到正常 parent assistant message 出现。此前 empty-parent side events 可跨 `/reload` 保持，但若直接终止整个 Pi 进程，尚无磁盘 session 可供恢复；插件不会为了强制落盘而写入父消息。第一个正常 parent turn 完成后，Pi 会把先前 side custom events 一并持久化，之后的进程重启/session restore 继续恢复同一 epoch。

若已有任何 parent source entry 却没有可解析的 OM summary/`coversUpToId`，插件仍明确失败，不静默退回完整父会话或短摘要。没有 source entry 但已出现 OM ledger 的不一致状态也明确失败。

## 持久恢复

插件将 epoch 状态写入 `pi-augment.side-epoch.v1` custom entries。customType 为兼容已有 epoch 保持不变；新记录使用 compact event `version: 2`：

- `created`：结构化持久一次 summary 或 empty-parent 描述、coverage/概念根、模型、模板、side identity 和 parent system；恢复时重建 seed message 及可派生 hash，不再双重 JSON 编码大字段；
- `turn`：结构化持久一次 parent delta 与 draft，并保留完整 accepted side assistant；恢复时确定性重建 user message，不再重复存储 epoch/turn/boundary/source IDs；
- `closed`：epoch 轮换原因。

有效 event `version: 1` 会原样恢复，并可在同一 epoch、同一 side cache identity 后直接追加 version 2 turn；不会为布局升级强制冷启动。未知 version、损坏字段或不连续 boundary 会明确失败，不跳过、不截断。

普通 Pi `CustomEntry` 不参与 `buildSessionContext()`，所以这些数据会进入 session JSONL 并跨 `/reload`、Pi 重启和 session restore 保留，但不会进入父 LLM context。插件每次调用都从活动 branch 重建并严格校验连续 turn 序号和 parent source 边界。

## 模型配置

插件继续使用 `observational-memory.model` 指定的模型与认证，但不复用或写入 OM worker 状态：

```json
{
  "observational-memory": {
    "model": {
      "provider": "openai-codex",
      "id": "gpt-5.4"
    }
  }
}
```

插件强制 `reasoning.effort=none`。模型配置缺失、不可解析或不是 `openai-codex-responses` 时直接报错，不回退到主模型。

## 安装与使用

```bash
pi install git:github.com/Molaison/pi-augment
```

执行 `/reload` 后：

```text
/augment 把刚才确认的连续 side epoch 方案改成可执行任务
```

连续调用会恢复同一 epoch，并显示递增的 `turn`：

```text
epoch=12ab34cd56ef turn=1
 epoch=12ab34cd56ef turn=2
```

## 流程、取消和调试

Footer 显示：

```text
等待父 turn → 恢复/创建 epoch → 持久连续 side 请求 → 校验并提交 turn → 回填
```

- 父 turn 未完成时可取消地等待，最长 120 秒；
- side provider 请求最长 45 秒；
- `Esc` 只取消当前 Augment，不调用 `ctx.abort()`；
- 同一时刻只允许一个 Augment；
- provider 失败或取消不会提交 `turn`；若 provider 已返回真实 usage，即使随后因 invalid sentinel、tool call 或意外 reasoning 拒绝结果，usage 仍会记入 Nano Context External。

调试模式：

```bash
pi --augment-debug
```

stderr 的 `[pi-augment:debug]` JSON 行包含 epoch hash、side identity hash、turn、是否恢复、轮换原因、parent delta 条目数、payload items/bytes 和 usage；不记录 prompt、summary、draft、assistant 文本或 API key。

## Nano Context External usage

`/augment` 要求当前 session 已激活 Nano Context usage listener。每次 provider 返回后，插件从真实 `AssistantMessage.usage` 发出兼容的 `nano-context:usage` event：

- `source=pi-augment/side`；
- `sessionId` 为父 Pi session；
- `input/output/cacheRead/cacheWrite/cost` 原样取自 provider usage；
- Nano Context 负责持久化为 `nano-context.usage` custom entry、去重并刷新 footer `External`。

插件会确认对应 usage entry 已实际持久化；listener 未激活时在 provider 调用前明确失败，持久化失败时不提交 side turn。它不会伪造 usage，也不会写父会话可见 message。usage custom entry 与 side epoch entry 都不属于 `om.*`。

## Cache 与 provider 路由

同一 epoch：

- 固定独立 side `sessionId`；
- `prompt_cache_key` 与 side identity 相同；
- `cacheRetention=long`；
- SSE；
- `store=false`；
- 删除 `previous_response_id`；
- `tools=[]`；
- `maxRetries=0`。

不用 `previous_response_id` 是为了让重启恢复只依赖持久 transcript，而不依赖可能过期的 provider response state。稳定 key 与 append-only 输入为 prompt-cache 复用创造条件，但 OpenAI 仍可能驱逐缓存；`cacheRead=0` 会明确显示，不触发静默重试，也不拒绝有效 rewrite。

Side identity 永不等于父 session/cache identity，因而不会显式绑定父 cache route。

## Epoch 轮换

以下变化会关闭旧 epoch 并冷启动新 epoch：

- side 模型变化；
- side template 变化；
- parent system prompt 变化；
- branch 不再包含冻结 coverage 或最后 parent source 边界；
- 下一轮输入加 8192-token 输出预留后超过 side 模型 context window。

轮换会显示原因。新 epoch 不继承旧 side 对话；历史 custom entries 保留。若新 epoch 的冻结 summary + 原始尾部仍超过模型窗口，命令明确失败，不截断、不改用短摘要，也不切换昂贵模型。

## 当前边界

- 连续语义以 epoch 为界，轮换后开始新 side 对话；
- 其他扩展只在 provider hook 中瞬时改写、但未写入 session source entries 的内容不会进入 parent delta；
- side usage 由 provider 计量并通过 Nano Context 的既有 event/persistence 协议进入 `External`；
- empty-parent bootstrap 只支持真正没有 parent source entries 且没有 OM ledger 的首次启动；“已有历史但 OM 尚未覆盖”仍不支持并显式失败；
- compact event version 2 减少 session JSONL 重复与双重编码，但冻结上下文和连续 transcript 仍会占用磁盘，不会增加父模型上下文；
- 客户端只能保持稳定 cache identity 和前缀，不能保证 OpenAI 必然返回 cache hit。
