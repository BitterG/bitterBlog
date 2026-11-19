---
title: "补充笔记：Agent 中的 Prompt Cache（提示词缓存）命中率"
date: "2026-11-19"
updated: "2026-11-19T17:53:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Prompt Cache", "KV Cache", "性能优化"]
---

# 补充笔记：Agent 中的 Prompt Cache（提示词缓存）命中率

![Prompt Cache 前缀匹配与连锁失效机制](/img/agent/prompt-cache-prefix-matching.svg)

在使用 Coding Agent 时，常能看到高达 **90% ~ 99%** 的“缓存命中率”。它指的是大模型服务端的 **Prompt Caching（KV Cache 前缀缓存）** 复用比例——不仅决定响应速度（大幅降低首字延迟 TTFT），更直接决定 Token 成本（命中缓存的输入 Token 通常便宜 **75% ~ 90%**）。

---

## 1. 缓存命中率是怎么算的？（不是估算，是服务端精确回传）

因为缓存命中的 Token 价格不同，大模型厂商的计费系统必须**精确统计**每一个 Token 是新计算的还是从缓存读取的，并在每次 API 响应的 `usage` 字段中直接返回给 Agent 客户端。

### 通用计算公式

```text
缓存命中率 = 命中缓存的输入 Token ÷ 总输入 Token
```

- **单轮命中率**：本轮读取缓存的输入 Token ÷ 本轮总输入 Token；
- **会话累计命中率**：Agent 把每轮返回的精确数字累加起来计算 `sum(cache_read) / sum(total_input)` 后展示在界面上。

### 主流厂商 API 返回字段对照

- **Anthropic (Claude)**：
  ```json
  "usage": {
    "input_tokens": 500,
    "cache_creation_input_tokens": 1200,
    "cache_read_input_tokens": 98000,
    "output_tokens": 300
  }
  ```
  总输入 = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` = `99700`
  命中率 = `98000 / 99700 ≈ 98.3%`

- **OpenAI (GPT)**：
  ```json
  "usage": {
    "prompt_tokens": 99700,
    "prompt_tokens_details": {
      "cached_tokens": 98000
    },
    "completion_tokens": 300
  }
  ```
  命中率 = `98000 / 99700 ≈ 98.3%`

- **Google Gemini**：
  ```json
  "usageMetadata": {
    "promptTokenCount": 99700,
    "cachedContentTokenCount": 98000,
    "candidatesTokenCount": 300
  }
  ```
  命中率 = `98000 / 99700 ≈ 98.3%`

---

## 2. 为什么必须严格“前缀匹配”？（底层 Transformer 架构约束）

Prompt Caching 复用的本质是复用服务端显存里算好的 **KV Cache（Key/Value 矩阵）**。它之所以必须从第 1 个 Token 开始**一字不差地前缀匹配（Prefix Matching）**，是由现代主流 LLM（Decoder-only Transformer）的两个底层机制决定的：

1. **因果注意力掩码（Causal Attention Mask）**：
   - 计算第 `i` 个 Token 的 KV 时，它**只依赖第 `1 ~ i` 个 Token**，完全看不到后面的 Token。
   - **向后追加可完美复用**：只要第 `1 ~ N` 个 Token 不变，无论后面第 `N+1` 个位置追加什么新内容，前面 `1 ~ N` 个 Token 的 KV 在数学上完全一致，可直接复用。
   - **中间改动引发多米诺骨牌失效**：一旦改了第 3 个 Token，第 3 个的 KV 变了 → 依赖第 3 个的第 4 个也变了 → 第 5、6……直到末尾**全部连锁失效**，必须重算。
2. **位置编码（如 RoPE）对位置敏感**：
   - 哪怕只是在开头插入一句话（后面内容一字没改），后面原本在第 100 位的 Token 挪到了第 120 位，位置编码作用后的向量也全变了，无法复用旧缓存。

---

## 3. 为什么 Agent 场景下命中率能高达 90% ~ 99%？

Agent 的核心是 `while True` 工具循环，天然是 **Append-only（只往末尾追加）** 的：

| 轮次 | 本轮输入构成 | 命中率 |
| :--- | :--- | :--- |
| **第 1 轮** | `system (5k) + tools (10k) + 用户问题 (0.5k)` = 15.5k（全部新建缓存） | **0%** |
| **第 2 轮** | 前面 15.5k（完全不变） + 新增 `tool_result (1k)` = 16.5k | **93.9%** (`15.5 / 16.5`) |
| **第 20 轮** | 前面 100k（完全不变） + 新增 `tool_result (0.5k)` = 100.5k | **99.5%** (`100 / 100.5`) |

连续执行几十轮工具调用时，越来越长的前缀被反复命中，整场会话的平均命中率就会非常接近 95% ~ 99%。

---

## 4. 它如何反过来决定 Agent Harness 的工程设计？

![Prompt Caching 与 Agent Harness 设计法则](/img/agent/prompt-cache-harness-design.svg)

同样的大模型，Agent 框架写得好不好，缓存命中率可以差出十倍。回顾 `s01 ~ s17` 的架构，很多看似“绕路”的设计其实都是为了**死保前缀不失效**：

1. **静态前缀置顶，动态信息全部追加到 `messages` 末尾**：
   - 为什么 `s15` 里的 `<reminder>Update your todos.</reminder>`、`[Scheduled]` 定时任务、`<task_notification>` 后台通知全都要作为 `user` 消息追加到 `messages` 末尾，而不去修改开头的 `system prompt`？
   - 因为一旦在 `system prompt` 里放了每秒都在变的动态信息（如当前时间、实时 todo 状态），**从开头往后的整条缓存每轮都会全部作废**。
2. **保持 `tools` 定义与顺序高度稳定**：
   - 服务端构建缓存前缀的顺序通常是 `tools -> system -> messages`。
   - 如果每轮 `assemble_tool_pool()` 导致工具顺序漂移，或频繁动态增删 MCP 工具，`tools` 一变，后面的 `system` 和全部 `messages` 缓存都会一起失效。
3. **历史消息只追加不修改，必要时再集中 `compact`**：
   - 不随意编辑或删除早期轮次的某条 `tool_result`（否则该位置之后的缓存全废），直到逼近上下文窗口上限时，再集中做一次 `compaction` 总结，并以新的稳定前缀重建缓存。
4. **缓存有效期（TTL，例如 Anthropic 默认 5 分钟）**：
   - Agent 自动连续调工具时，每轮间隔只有几秒，每次命中都会自动续期，命中率维持高位；
   - 如果用户中途停顿超过 5 分钟再发下一句，缓存过期后会触发一次重建，紧接着后面的工具循环又会立刻恢复 95%+ 的命中率。
