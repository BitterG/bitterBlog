---
title: "s06：Subagent — 子 Agent 与受限子循环"
date: "2026-11-17"
updated: "2026-11-17T20:06:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Subagent", "Python", "LLM"]
---

# s06：Subagent — 子 Agent 与受限子循环

![Subagent 架构图](/img/agent/s06-subagent-overview.svg)

## 1. 主循环注册与触发子 Agent

本第六节，为 Agent 添加开启子 Agent 的能力（其实就是开了一个新的、限制轮数的子循环，与主循环共用工作区、工具）：

```python
TOOL_HANDLERS = {**BASE_HANDLERS, "task": run_subagent}

# -- Parent agent loop --

def agent_loop(messages: list):
    while True:
        response = client.messages.create(
            model=MODEL,
            system=SYSTEM,
            messages=messages,
            tools=TOOLS,
            max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})

        tool_calls = [
            block for block in response.content if block.type == "tool_use"
        ]
        if not tool_calls:
            force = trigger_hooks("Stop", messages)
            if force:
                messages.append({"role": "user", "content": force})
                continue
            return

        results = []
        for block in tool_calls:
            # 主循环开启子循环的位置
            # TOOL_HANDLERS 由基础工具和 "task": run_subagent 合并来的，见代码块开头
            output = execute_tool(block, TOOL_HANDLERS)
            results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": output,
            })
        messages.append({"role": "user", "content": results})
```

## 2. 子循环实现与防无限递归

子循环如下，与主循环相比基本一致，但是我们没有给子循环继续添加开启子循环的能力，而是只提供基础工具：

```python
SUB_TOOLS = list(BASE_TOOLS)
SUB_HANDLERS = dict(BASE_HANDLERS)

def run_subagent(prompt: str) -> str:
    print("\n\033[35m[Subagent started]\033[0m")
    messages = [{"role": "user", "content": prompt}]

    for _ in range(30):
        response = client.messages.create(
            model=MODEL,
            system=SUB_SYSTEM,
            messages=messages,
            tools=SUB_TOOLS,
            max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})

        tool_calls = [
            block for block in response.content if block.type == "tool_use"
        ]
        if not tool_calls:
            force = trigger_hooks("Stop", messages)
            if force:
                messages.append({"role": "user", "content": force})
                continue
            print("\033[35m[Subagent done]\033[0m")
            # 子循环结束，返回最终结果给主循环
            return extract_text(response.content) or "(no summary)"

        results = []
        for block in tool_calls:
            # 这里 SUB_HANDLERS 是来自 dict(BASE_HANDLERS)，没有开启子循环的能力
            output = execute_tool(block, SUB_HANDLERS)
            print(f"  \033[90m[sub] {block.name}: {output[:100]}\033[0m")
            results.append({
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": output,
            })
        messages.append({"role": "user", "content": results})

    print("\033[35m[Subagent stopped]\033[0m")
    return "Subagent stopped after 30 turns without a final answer."
```

## 3. 上下文隔离与单线程说明

- **上下文隔离**：子 Agent 拥有独立的 `messages = [{"role": "user", "content": prompt}]`，中间的 30 轮工具探索过程不会塞满主 Agent 的上下文，最后只把精炼总结 `extract_text(response.content)` 作为一条 `tool_result` 返回给主循环。
- **执行模型**：到目前为止，子 / 主 Agent 是**单线程的**（同步阻塞调用），后续才会引入多线程与后台任务。
