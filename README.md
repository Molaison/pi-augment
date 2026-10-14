<h1 align="center">pi-augment</h1>

<p align="center">
  <strong>让 Pi 根据已有对话，把草稿补全成可执行的 Prompt。</strong><br>
  一个支持跨轮连续上下文、恢复与 Prompt Cache 的 <a href="https://github.com/earendil-works/pi">Pi</a> 扩展。
</p>

<p align="center">
  <a href="https://github.com/Molaison/pi-augment/stargazers"><img src="https://img.shields.io/github/stars/Molaison/pi-augment" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT license"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/version-0.4.2-blue" alt="Version 0.4.2"></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#工作方式">工作方式</a> ·
  <a href="#使用限制">使用限制</a> ·
  <a href="docs/implementation.md">技术细节</a>
</p>

---

## 它能做什么？

当你在 Pi 中输入“把刚才的方案整理成任务”时，**`/augment`** 会参考当前对话中已记录的上下文和自己的历史增强结果，把模糊草稿改写为更明确的任务描述。增强后的内容**只回填编辑框，由你决定是否发送**。

| 能力 | 具体行为 |
| --- | --- |
| **连续增强** | 同一 side epoch 保留上次生成的结果；下一轮在此基础上继续理解“刚才”“这个方案”等引用。 |
| **跨重载恢复** | 持久化 side transcript，正常落盘后可跨 `/reload`、Pi 重启或 session restore 恢复。 |
| **隔离父会话** | Side 请求单独运行，不自动发送增强后的 Prompt，也不向父模型上下文注入 side 对话。 |
| **缓存与费用** | 同一 epoch 复用 side session/cache identity；从 provider 返回的真实 usage 计入 Nano Context External。 |
| **可控失败** | 不满足上下文、模型或 usage 条件时明确报错；不会静默换模型或伪造缓存命中。 |

## 快速开始

本扩展适用于使用 **`openai-codex-responses`** API 的 Pi 交互会话，要求 Node.js 22.19+，并需要：

1. 已配置可访问的 **Observational Memory 模型**（`observational-memory.model`）；有历史对话时还需要有效的 OM V3 ledger。
2. 当前会话已激活 **Nano Context usage listener**，用于记录每次 side 调用的费用。

安装扩展：

```bash
pi install git:github.com/Molaison/pi-augment
```

在 Pi 中执行 `/reload`。在全局 Pi settings 或项目的 `.pi/settings.json` 中配置 side 模型（下面仅为格式示例，替换成你已接入的模型）：

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

然后在 **交互式 Pi TUI** 中输入：

```text
/augment 把刚才讨论的优化方案整理成可以交给 Codex 执行的任务
```

完成后，增强后的 Prompt 会出现在编辑框中，供检查和修改。后续再次使用 `/augment` 会延续同一个有效 epoch，并在通知里显示 `epoch`、`turn` 与本次 `cacheRead`。

## 工作方式

```text
父 Pi 会话 ── OM summary + 新增消息 + 当前草稿 ──▶ 独立 side 模型
       ▲                                         │
       │                                         ▼
       └────────────── 编辑框回填 ◀──────── 增强后的 Prompt
                            │
               side epoch 写入 session JSONL
               usage 写入 Nano Context External
```

- 每次 side 调用都重放已持久化的连续 transcript 并追加新的父会话片段。它使用稳定的 `prompt_cache_key`、`cacheRetention=long`，但 **cache hit 不保证发生**。
- 请求采用 `reasoning=none`、`store=false`，不提供 tools；side identity 与父会话隔离。
- `Esc` 只取消当前 Augment，不中断父会话；同一时间只允许一个增强请求。
- **真正空的新会话**可以启动 empty-parent epoch；已有聊天历史而 OM 尚未形成有效覆盖时则会明确失败。

## 使用限制

**Side 请求会发送当前草稿及相关父会话上下文到配置的模型 Provider**；请按该 Provider 的数据政策使用，不要在草稿中放入密钥。Side 结果及其必要上下文被写入 Pi session JSONL，用于恢复；它们不会作为父模型消息发送。

当 side 模型、模板、父系统 Prompt 或上下文边界变化，或 context window 不足时，插件会轮换 epoch。首轮新会话若尚未完成 Pi 的正常父消息持久化，直接退出进程可能无法恢复此次 side 记录。

报错可用 `pi --augment-debug` 查看阶段、hash、payload 大小与用量；调试日志不记录 Prompt 正文或 API key。更多边界及实现细节见 [完整技术文档](docs/implementation.md)。

## 开发与许可

扩展入口为 [`src/index.ts`](src/index.ts)，持续会话的生成和校验位于 [`src/side-epoch.ts`](src/side-epoch.ts)。许可证：[MIT](LICENSE)。
