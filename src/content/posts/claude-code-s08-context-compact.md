---
title: "s08：Context Compact — 上下文溢出控制与多级压缩"
date: "2026-11-17"
updated: "2026-11-17T20:08:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Context Compact", "Token优化", "Python"]
---

# s08：Context Compact — 上下文溢出控制与多级压缩

![Context Compact 架构图](/img/agent/s08-compact-overview.svg)

主要分 **4 个步骤**（外加报错时的 `reactive_compact` 兜底与模型主动调 `compact` 工具）：

## 1. 文件转储（`tool_result_budget` — 每轮检查）

当本轮返回的一批 `tool_result` 总字符数超过 `200,000` 时，按从大到小把超过 `30,000` 字符的结果完整写入磁盘 `.task_outputs/tool-results/`，并把 `block["content"]` 替换成 `<persisted-output>`（文件路径 + 前 2000 字符预览）。

## 2. 保留头尾，归档中间（`snip_compact` — 每轮按条数检查）

当 `messages` 总条数达到 `50` 条时，保留开头 3 条与末尾约 26 条，裁剪掉中间部分（并保证不拆散 `tool_use` / `tool_result` 配对）。

- **设计赌注**：赌头部定方向、尾部是最新进度、中间多为已过时的排查过程，实际大部分长任务确实如此。
- **可恢复留档**：裁剪前会把完整历史写入 `.transcripts/transcript_xxx.jsonl`，并在裁剪位置留下一条索引标记；如果当前请求恰好落在被砍掉的中间段，`prepare` 会自动补回 `active_request`。
- **局限性**：比如在第 6 条对话中说过某个重要约束，一旦被归档进 `.transcripts/`，模型通常不会主动去翻旧账，后续可能遗忘。这类跨阶段关键约束需要靠 **`s09_memory`（持久记忆）** 和 **`s10_task_system`（持久化任务）** 来解决。

---

> 当总字符数依然 `> 50,000` 时，进入下面逐级加码的压缩流程，目标压到上限的 `80%` 即 `40,000`，留出缓冲防止每轮抖动。

![多级压缩分层图](/img/agent/s08-compaction-layers.svg)

## 3. 清理旧工具结果 → 截断超大新结果（依然零 API 成本）

### 3.1 保近压远（`micro_compact`，最温柔）

保留最近 3 条已读工具结果（以及刚返回还未读的新结果），只把更早且超过 `120` 字符的已读结果落盘并替换为路径引用 `[Earlier tool result saved at ...]`，直到降到 `40,000` 以下。

### 3.2 动真格截断（`fit_tool_results`，保大放小）

- **何时进入**：做完 `micro_compact` 依然 `> 50,000`！最常见的原因是这一轮刚返回的新结果（或最近那 3 条）自己就特别大——比如并行读了 3 个各 2.5 万字符的文件，合计 7.5 万字符（没触及第 1 步的 20 万上限，却直接爆了 5 万总限）。
- **怎么动**：不再偏袒“新结果 / 最近 3 条”，按长度从大到小把最大结果落盘，只保留 `1000` 字符预览 + 路径。这依然是纯磁盘操作（不花钱调 LLM），且至少给模型留了 1000 字预览，避免模型一眼都没看到就被总结掉。

## 4. Agents 说：我超没招了（`compact_history` — 最后大招，有损且花钱）

- **何时进入**：把所有能落盘的工具结果都榨干了，总长度还是 `> 50,000`！说明是用户与模型之间大量的对话文本、推理输出或上百条短消息本身把上下文塞满了。
- **怎么动**：在终端打印 `[auto compact]`，先把完整历史备份到 `.transcripts/`，再额外花一次 API 调用让模型将历史提炼为客观摘要，最后清空历史，只保留一条 `[Compacted]` 消息（并将 `Current user request` 与历史摘要明确隔离）。

## 5. 报错重试（`reactive_compact`）

**什么情况报错**：`prepare()` 判断要不要压缩，看的是字符数估算（`CONTEXT_CHAR_LIMIT = 50000`），而模型 API 真正校验的是 **Token 总数**。下面这几种情况都会漏网并导致 API 直接报错拒收：

1. **字符数没超，但 Token 超了**：比如一段密集的符号、代码、Unicode/中文或特殊 JSON，`len(json.dumps(messages))` 只有 4.5 万字符（没到 5 万），但分词后的 Token 数已经撑爆了当前模型的上下文窗口。
2. **`prepare()` 没算进 `SYSTEM`、`TOOLS` 和 `max_tokens`**：发请求时实际占用窗口的是 `SYSTEM + TOOLS + messages + max_tokens(8000)`，而 `estimate_chars` 只算了 `messages`。
3. **使用的模型窗口本身较小**：如果接的是 32K / 64K 窗口的模型，`50,000` 字符的阈值本来就偏大，没到 `prepare()` 触发线就已经先被服务端拒绝了。
4. **极端情况（重试后依然报错）**：如果一共只有 `≤ 5` 条消息，但单条内容就已经超过模型最大上下文，或者 `reactive_compact` 保留的最近 5 条加起来依然超限，哪怕急救压缩一次也救不回来。

## 6. 核心流程代码对应

```python
def prepare(self, messages: list, active_request: str) -> list:
    # 1. 文件转储（单轮大结果超限）
    messages = self.tool_result_budget(messages)

    # 2. 保留头尾，归档中间（消息条数 >= 50）
    before_snip = messages
    messages = self.snip_compact(messages)
    ... # 若裁剪后丢失了当前请求，自动补回 active_request

    # 若总字符仍超过 50,000，进入逐级降压（目标压到 80% = 40,000）
    if self.estimate_chars(messages) > self.CONTEXT_CHAR_LIMIT:
        target = int(self.CONTEXT_CHAR_LIMIT * 0.8)

        # 3-A. 保近压远（替换早期已读工具结果）
        messages = self.micro_compact(messages, target)

        if self.estimate_chars(messages) > self.CONTEXT_CHAR_LIMIT:
            # 3-B. 动真格（连最新/最近的大工具结果也截成 1000 字预览）
            messages = self.fit_tool_results(messages, target)

        if self.estimate_chars(messages) > self.CONTEXT_CHAR_LIMIT:
            print("[auto compact]")
            # 4. Agents 说：我超没招了（调 LLM 总结历史）
            messages = self.compact_history(messages, active_request)

    return messages
```
