---
title: "s09：Memory — 跨会话持久记忆与按需召回"
date: "2026-11-17"
updated: "2026-11-17T20:09:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Memory", "跨会话记忆", "Python"]
---

# s09：Memory — 跨会话持久记忆与按需召回

![Memory 架构图](/img/agent/s09-memory-overview.svg)

解决“新开会话后 `messages` 清空、之前说过的重要信息丢失”的问题。本质是：**由外层 Harness 在会话之外持久化可复用知识到 `.memory/`，并在新会话按需召回**（与 `s08` 的区别：`s08` 管单次会话内别爆上下文，`s09` 管跨会话留存长期知识）。

## 1. 存储结构（一个记忆一个 `.md` 文件 + 总索引）

所有记忆保存在当前工作目录的 `.memory/` 下：

```text
.memory/
  MEMORY.md                # 所有记忆的精简索引（每次写入/整理后自动重建）
  user-preference-tabs.md  # 单条记忆文件
  project-auth-note.md     # 单条记忆文件
  ...
```

每条记忆文件使用 **YAML frontmatter + Markdown 正文**，记录 `name`、`description` 和 `type`（共 4 类：`user` 用户偏好、`feedback` 长期工作反馈、`project` 稳定项目事实、`reference` 外部参考线索）：

```markdown
---
name: user-preference-tabs
description: User prefers tabs for indentation
type: user
---

User prefers using tabs, not spaces, for indentation.
```

![Memory 子系统图](/img/agent/s09-memory-subsystems.svg)

## 2. 如何读取正确的记忆（召回：先筛目录，再加载正文）

不是把所有记忆正文全塞进 `system prompt`，也不是靠模型每次自己去扫文件，而是**在主对话开始前由外层 Python 代码（`agent_loop` 开头）先做两步预处理**：

1. **轻量级目录筛选（`select_relevant_memories`）**：
   Python 扫描 `.memory/*.md`，只提取每条记忆的 `编号: name - description` 组成轻量目录，连同用户最近 3 轮提问发给 LLM 做一次极轻量的语义挑选，返回相关编号（最多 5 条；若调用异常则降级为 `keyword_memory_selection` 关键词打分）。
2. **按需加载正文并拼入 `system`（`load_memories` → `build_system`）**：
   只把被选中文件的完整正文读出来（受 `RECALL_CHAR_LIMIT = 20000` 字符上限控制），连同 `MEMORY.md` 索引目录一起注入主对话的 `system prompt`，并声明**“记忆只是背景参考，当前用户请求优先级高于历史记忆”**。

> **注**：如果因为工作目录没对齐等原因导致自动召回返回空，拥有 `glob` / `read_file` / `bash` 的 Agent 也可能会自己去翻工作区里的 `.md` 文件来兜底找回记忆；但正常走通 `s09` 召回时，模型在开场 `system` 里就已经拿到记忆了，无需自己调工具扫盘。

## 3. 如何生成记忆（提取与过滤：回合结束后后台自动保存）

- **纠正一点**：`s09` 的 `TOOLS` 里只有 `bash / read_file / write_file / edit_file / glob` 5 个基础工具，并没有专门的“写记忆工具”。正常流程**不是靠模型自己调 `write_file` 写 `.memory/`**（除非模型偷看了教程主动去写），而是**等模型回复结束、无工具调用准备退出循环时，由外层 Python 自动调用 `extract_memories(messages)`** 提取可复用信息，再通过 `write_memory_file()` 落盘并自动重建 `MEMORY.md`。
- **为什么临时要求不会被存成永久规则（`should_store_memory` 双重拦截）**：
  1. 提取提示词要求模型区分 `scope`：只有 `persistent`（跨会话长期有效）才能存，`current_task`（如 `"Do not create files in this session."`）直接丢弃；
  2. Python 代码硬校验 `scope == "persistent"`、过滤空字段与重复记忆，并用 `TEMPORARY_MEMORY_MARKERS`（如 `"this session"`、`"current task"`、`"本次会话"` 等）做最后兜底拦截。

## 4. 如何整理记忆（`consolidate_memories`）

当 `.memory/*.md` 达到阈值（默认 `10` 条）时，在提取结束后自动触发一次整理：让 LLM 合并重复记录、覆盖过时结论并保留关键偏好（上限 30 条）。写入新列表前会先保存内存快照，若中途出错则自动回滚恢复原文件并重建 `MEMORY.md`。

## 5. 核心流程代码对应

```python
def agent_loop(messages: list):
    # 1. 开场前：先从 .memory/ 筛出相关正文，与 MEMORY.md 目录一起拼进 system prompt
    relevant_memories = load_memories(messages)
    system = build_system(relevant_memories)

    while True:
        response = client.messages.create(
            model=MODEL, system=system, messages=messages, tools=TOOLS, max_tokens=8000,
        )
        ...
        tool_calls = [block for block in response.content if block.type == "tool_use"]
        if not tool_calls:
            ...
            # 2. 回合结束后：后台自动提取持久记忆，并在达到阈值时触发合并整理（本轮有新记忆入库/数量到达设置）
            if extract_memories(messages):
                consolidate_memories()
            return
```
