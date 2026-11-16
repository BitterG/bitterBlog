---
title: "s04：Hooks — 钩子机制与主循环解耦"
date: "2026-11-16"
updated: "2026-11-16T16:04:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Hooks", "AOP", "Python"]
---

# s04：Hooks — 钩子机制与主循环解耦

![Hooks 架构图](/img/agent/s04-hooks-overview.svg)

## 1. 为什么需要 Hooks

第四节 `hooks`，目的在于：防止每一次添加一个功能都需要去改主循环。

主循环应当保持稳定，防止出现以下情况：

```python
def agent_loop(messages):
    while True:
        # ... LLM call ...
        for block in response.content:
            if block.type != "tool_use":
                continue
            log_to_file(block)          # 加一行
            check_permission(block)     # 加一行
            notify_slack(block)         # 又加一行
            output = execute(block)
            auto_git_add(block)         # 再加一行
            # ... 很快循环就认不出来了
```

每次加一个新检查，比如“记录每次 bash 调用”、“操作后自动 git add”，都要修改 `agent_loop` 函数。

你想扩展的是 Agent 的行为，但你改的却是循环本身。**循环应该是一个稳定的核心，扩展应该挂在外面。**

解决方法是：`s03` 的循环和权限逻辑完全保留，唯一的变动是把 `check_permission()` 从循环体内移到了 hook 上。循环不再直接调用任何检查函数，改为 `trigger_hooks("PreToolUse", block)`，由注册表决定跑什么。

## 2. 以 UserPromptSubmit 为例进行提示词注入

| 事件 | 触发时机 | 典型用途 |
| --- | --- | --- |
| `UserPromptSubmit` | 用户输入提交后、进入 LLM 前 | 输入验证、注入上下文 |

我们这里将终端输入的内容直接替换为 `"hello"`，原理很简单，发送到 AI 之前进行修改即可，如下图所示：

![UserPromptSubmit 提示词注入调试截图](/img/agent/s04-img.png)

## 3. 将权限校验迁移到 PreToolUse / PostToolUse

我们将第三节的权限校验也搬到 hooks 里，通过：

```python
register_hook("PreToolUse", permission_hook)

def register_hook(event: str, callback):
    HOOKS[event].append(callback)
```

加入到 `"PreToolUse"` 对应的列表中即可，调用放到执行命令之前：

```python
for block in tool_calls:
    # s04 change: hook replaces hard-coded check_permission()
    blocked = trigger_hooks("PreToolUse", block)
    if blocked:
        results.append({"type": "tool_result", "tool_use_id": block.id,
                        "content": str(blocked)})
        continue

    handler = TOOL_HANDLERS.get(block.name)
    output = handler(**block.input) if handler else f"Unknown: {block.name}"

    trigger_hooks("PostToolUse", block, output)  # s04: post hook

    results.append({"type": "tool_result", "tool_use_id": block.id, "content": output})
```

## 4. 总结与理解

本次 hooks 共增加了四个时机：**提示词发送前 / 执行命令前 / 执行命令后 / 结束之前**。

原理也并不难，因为我之前也写 Java 后端 / 游戏 Mod 修改，感觉和 AOP 和反射那种差不多，这种还是正向开发甚至更简单——插入到函数执行前后等位置，执行我们自己的逻辑后返回。
