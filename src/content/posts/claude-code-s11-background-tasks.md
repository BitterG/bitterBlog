---
title: "s11：Background Tasks — 后台异步执行与通知注入"
date: "2026-11-18"
updated: "2026-11-18T17:32:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Background Tasks", "多线程", "Python"]
---

# s11：Background Tasks — 后台异步执行与通知注入

![Background Tasks 架构图](/img/agent/s11-background-tasks-overview.svg)

解决耗时 `bash` 命令（如安装依赖、全量测试、构建项目）阻塞主 `agent_loop` 的问题。本质是：**让显式标记为后台执行的命令放进守护子线程里跑，主循环立刻拿占位结果继续往下走，后续轮次开始时再把已完成的输出作为通知注入对话**。

> 注：本节笔记是我使用语音与 Gemini 4 Hydrogen 探讨完成的。

---

## 1. 你的理解中，哪些完全正确？

1. **加了一个显式字段 `run_in_background`**：
   - 在 `bash` 工具的 `input_schema` 里新增布尔字段 `run_in_background`（`s11_background_tasks/code.py` L202–L208）。
   - 只有当 `tool_name == "bash"` 且 `run_in_background is True` 时才走后台路径（不靠 `install` / `test` 等关键词猜测）。
2. **开子线程异步跑，主循环先拿占位结果继续**：
   - `execute_tool()` 命中 `should_run_background()` 后调用 `BackgroundManager.start()`，分配 `bg_0001` 并启动 `daemon=True` 守护子线程去跑 `_run()`（底层 `subprocess.Popen` 执行，超时 120s）。
   - 主线程不等命令结束，立刻返回占位字符串 `"[Background task bg_0001 started] The result will be collected on a later turn."`，紧接着处理同一回复里的其他工具或进入下一轮 LLM 调用。
3. **趁下一轮顺手收集完成结果**：
   - 子线程执行结束后，将结果写入 `self.results` 并把 `task_id` 放进 `self._ready` 队列。
   - 每次 `agent_loop` 准备调用 LLM 前，都会先执行 `inject_background_results(messages)`：若 `_ready` 中刚好有跑完的任务，就收集并格式化为 `<task_notification>` 文本块注入最近一条 `user` 消息里一并发给 LLM（不复用原 `tool_use_id`，遵守一个 `tool_use` 只对应一个 `tool_result` 的 API 契约）。

`collect()` 生成的通知结构如下（`<summary>` 截断至前 500 字符）：

```xml
<task_notification>
  <task_id>bg_0001</task_id>
  <status>completed</status>
  <command>npm install</command>
  <summary>...</summary>
</task_notification>
```

---

## 2. 两个容易误判的关键细节（代码实际行为 vs 直觉）

### 细节一：主任务跑完但子任务还没完，主循环会“一直干等”吗？—— **不会！在 `s11` 里甚至不会主动唤醒**

- **不等待直接退出当前轮次**：在 `agent_loop` 中，只要模型本轮不再返回 `tool_use`（`if not tool_calls:`），函数**直接 `return`** 回到终端 `s11 >> ` 输入提示符，不会阻塞等待后台子线程。
- **如果用户一直不输入下一条消息**：
  - 后台线程跑完后只是把结果塞进内存队列 `_ready` 里“候着”，**既不会主动调用 LLM，也不会往终端打印完成提示**，页面就会一直停在 `s11 >> ` 没有任何反应；
  - 直到用户下次在 `s11 >> ` 输入任意新消息再次进入 `agent_loop` 时，开头的 `inject_background_results()` 才会把刚才积累的通知顺手一起带给 LLM。
- **如果用户直接退出程序（`q` / `Ctrl+C`）**：
  - 因为后台线程是 `daemon=True` 守护线程，且通过 `atexit.register(_stop_all_shell_processes)` 注册了清理钩子，主进程**不会等子线程跑完**，而是直接退出并终止未结束的后台子进程。

### 细节二：后台任务有持久化 / 写到磁盘吗？—— **没有，纯内存存储**

- `BackgroundManager` 里的 `self.tasks`、`self.results`、`self._ready` 全是 Python 内存里的 `dict` 与 `list`。
- 命令标准输出/错误也仅保存在内存字符串里（总输出截断至 50,000 字符，`<task_notification>` 的 `<summary>` 截断至前 500 字符）。
- 除了后台 Shell 命令本身产生的文件副作用（如 `npm install` 生成的 `node_modules`），**`s11` 不把后台任务状态或运行日志落盘**；进程一退出全部清零（与 `s10` 落盘到 `.tasks/` 的持久化任务图完全不同）。

---

## 3. 为什么真实 Agent 产品“子任务跑完自己就会响”？（`s11` vs `s15`）

![s11 被动收集 vs s15 自动唤醒对比图](/img/agent/s11-wakeup-comparison.svg)

实际使用成熟的 CLI / IDE Agent 产品（如 Claude Code 等）时，确实不会出现“后台跑完却死寂无声”，这通常靠两种机制实现：

1. **事件驱动的自动唤醒（Reactive Wake-up）**：
   主任务先结束并将控制权还给用户（不卡住交互），但后台有一个事件监听线程一直在检查完成队列。只要子任务一完成，Harness 就会自动抢锁把 `<task_notification>` 塞回 `messages` 并**主动拉起一轮新的 LLM 调用**向用户汇报或接续处理。
2. **有强依赖时的显式等待或 `Stop` 门控**：
   若主任务必须拿到后台结果才能收尾，产品通常会提供显式的阻塞查询/等待工具，或在 `Stop` 钩子 / 目标检查阶段（如 `s17 Goal Loop`）拦截尚未闭环的退出请求。

### 为什么 `s11` 本身没做自动唤醒？

在终端 `input()` 同步命令行里做到“用户不敲回车（甚至正在输入一半）时，后台一完成就自动唤醒 LLM 并将结果印在终端上且不打乱输入行”，需要额外引入一套并发基础设施：

- `agent_lock` 互斥锁（防止后台线程和用户输入并发改写 `history`）；
- `async_event_loop` 独立唤醒线程；
- `ConsoleBroker` / `terminal_print`（通过 `readline` 擦除并重绘用户输入一半的提示符）。

为了保持 `s11` 教学主题的纯粹性，作者刻意把这部分留白（`s11` 代码第 463–465 行注释也明确写了：`# Kept for independent reuse or future wake-up from background tasks.`），直到后面的 **`s13`（收件箱事件唤醒 Lead）** 与 **`s15` 集成版**（`s15_integrated_harness/code.py` L3289–L3316）才把 `async_event_loop` + `has_pending_background()` + `ConsoleBroker` 全部接起来，还原真实产品的异步自动响应体验。

---

## 4. 核心流程代码对应（`s11_background_tasks/code.py`）

```python
def execute_tool(block) -> str:
    blocked = trigger_hooks("PreToolUse", block)
    if blocked is not None:
        return str(blocked)

    if should_run_background(block.name, block.input):
        task_id = start_background_task(block)  # 开 daemon=True 子线程跑 _run()
        output = (
            f"[Background task {task_id} started] "
            "The result will be collected on a later turn."
        )
    else:
        output = call_tool(block)

    trigger_hooks("PostToolUse", block, output)
    return output


def agent_loop(messages: list):
    while True:
        inject_background_results(messages)  # 每轮调 LLM 前先收集已完成的后台通知
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages, tools=TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})

        tool_calls = [block for block in response.content if block.type == "tool_use"]
        if not tool_calls:
            force = trigger_hooks("Stop", messages)
            if force:
                messages.append({"role": "user", "content": force})
                continue
            return  # 直接退出回到 input("s11 >> ")，不会阻塞等待后台子线程

        results = []
        for block in tool_calls:
            output = execute_tool(block)
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": output})
        messages.append({"role": "user", "content": results})
```
