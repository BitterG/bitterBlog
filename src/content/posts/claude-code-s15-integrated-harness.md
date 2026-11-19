---
title: "s15：Integrated Harness — 多种机制，一个主循环"
date: "2026-11-19"
updated: "2026-11-19T17:50:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Integrated Harness", "Agent Loop", "Python"]
---

# s15：Integrated Harness — 多种机制，一个主循环

![Integrated Harness 架构图](/img/agent/s15-system-architecture.svg)

第15节，本节没有新增内容，是对s1-s14的功能总结和拼装在一起

---

## 1. 组件在循环中的位置

| 位置 | 组件 | 作用 |
| --- | --- | --- |
| 用户输入前后 | `UserPromptSubmit` hooks | 记录、注入、审计用户输入 |
| LLM 前 | cron queue | 把定时触发的 prompt 注入 `messages` |
| LLM 前 | background notifications | 后台任务完成后以 `<task_notification>` 注入 |
| LLM 前 | compaction pipeline | 先压大输出，再裁历史，再压旧 tool_result，必要时摘要 |
| LLM 前 | memory / skills / MCP state | 组装 system prompt，让模型看到当前能力和长期上下文 |
| LLM 调用 | error recovery | 429/529 重试，`max_tokens` 升级，prompt too long 触发 reactive compact |
| 工具执行前 | `PreToolUse` hooks + permission | 拦截危险命令、写越界、破坏性 MCP 工具 |
| 工具分发 | `assemble_tool_pool` | 组装内置工具和 MCP 动态工具 |
| 工具执行时 | background dispatch | 显式标记的 bash 操作放入 daemon thread，主循环先返回占位结果 |
| 工具执行后 | `PostToolUse` hooks | 大输出告警、日志等后处理 |
| 返回循环 | tool_result | 每个 `tool_use` 对应一个 `tool_result`，再回到下一轮 |
| 本轮没有 tool_use / 停止时 | `Stop` hooks | 统计、清理、审计 |

---

## 2. 集成主循环核心代码（`agent_loop`）

![s15 agent_loop 单轮内部关键机制](/img/agent/s15-loop-lifecycle.svg)

```python
def agent_loop(messages: list, context: dict, active_request: str):
    global rounds_since_todo
    tools, handlers = assemble_tool_pool()
    state = RecoveryState()
    max_tokens = DEFAULT_MAX_TOKENS

    unacknowledged_cron_jobs: list[CronJob] = []
    while True:
        # One cycle: inject scheduled/background work, prepare context, call
        # the model, execute tool_use blocks, append tool_results, repeat.
        fired = consume_cron_queue()
        unacknowledged_cron_jobs.extend(fired)
        for job in fired:
            messages.append({"role": "user",
                             "content": f"[Scheduled] {job.prompt}"})
            print(f"  \033[35m[cron inject] {job.prompt[:60]}\033[0m")
        if fired:
            scheduled_requests = "\n".join(
                f"Run scheduled task: {job.prompt}" for job in fired)
            active_request = f"{active_request}\n{scheduled_requests}".strip()

        inject_background_notifications(messages)
        # 每轮 while True 开始
        #   ├─ 1. consume_cron_queue() ──► 取出到期定时任务，先记入 unacknowledged_cron_jobs（防 LLM 报错丢失）
        #   ├─ 2. messages.append(...) ──► 伪装成 user 消息喂给模型
        #   ├─ 3. 更新 active_request  ──► 防止接下来 prepare_context 压缩上下文时把定时任务压没了
        #   └─ 4. inject_background_notifications() ──► 收取跑完的后台任务结果，也塞进 messages
        #   ▼
        # 进入 prepare_context() -> call_llm()
        #   ├─ 成功 ──► acknowledge_cron_jobs() 确认消化
        #   └─ 失败 ──► restore_cron_jobs() 放回队列下次再试

        # 防止模型忘记更新todo清单 三轮计数
        if rounds_since_todo >= 3:
            messages.append({"role": "user",
                             "content": "<reminder>Update your todos.</reminder>"})
            rounds_since_todo = 0

        # 分别把要喂给大模型的 messages（历史消息）、
        # system（动态上下文）、tools（可用工具） 刷新到最新且合规的状态
        prepare_context(messages, active_request)
        context = update_context(context, messages)
        tools, handlers = assemble_tool_pool()

        try:
            response = call_llm(messages, context, tools, state, max_tokens)
        except Exception as e:
            if is_prompt_too_long_error(e) and not state.has_attempted_reactive_compact:
                messages[:] = reactive_compact(messages, active_request)
                state.has_attempted_reactive_compact = True
                continue
            restore_cron_jobs(unacknowledged_cron_jobs)
            messages.append({"role": "assistant", "content": [
                {"type": "text", "text": f"[Error] {type(e).__name__}: {e}"}]})
            release_completed_assignment("agent")
            return

        # 针对一次性任务（recurring=False）：既然大模型已经成功收到它的 prompt 并返回了结果，就可以安全地把它从 scheduled_jobs 里彻底删除；如果是持久化任务（durable=True），再调用 save_durable_jobs() 同步到磁盘，防止程序重启后又跑一遍。
        # 针对周期性任务（recurring=True）：不会删除，继续留在 scheduled_jobs 里等下次到点再触发。
        acknowledge_cron_jobs(unacknowledged_cron_jobs)
        # 把当前轮次的“待确认列表”清空，表示这批任务已经送达完毕。
        # 这样如果下一轮（例如工具跑完后再次 call_llm）发生异常走 except 里的 restore_cron_jobs(unacknowledged_cron_jobs)，
        # 就不会把上一轮已经成功送达的定时任务误塞回队列重复执行。
        unacknowledged_cron_jobs.clear()
        # 这是经典的消息队列 ACK（签收）机制，用来防止 call_llm 失败导致一次性任务永久丢失：
        # 定时任务到点（_enqueue_due_job）
        #   └─ 一次性任务先不删，只标记 pending_delivery = True（防重复入队）并进 cron_queue
        #         │
        #         ▼
        # agent_loop 开头
        #   └─ consume_cron_queue() 取出，暂存到 unacknowledged_cron_jobs，注入 messages
        #         │
        #         ▼
        # call_llm(...)
        #   ├─ 失败（except）──► restore_cron_jobs() 放回 cron_queue，下次重试（不丢任务）
        #   └─ 成功          ──► acknowledge_cron_jobs() 正式删除一次性任务 + clear()（不重复执行）

        # 提额重来
        # 把 max_tokens 从 DEFAULT_MAX_TOKENS（8000）翻倍到 ESCALATED_MAX_TOKENS（16000），标记 has_escalated = True，直接 continue 重新调用模型。
        # 细节：注意这里没有把截断的 response.content 塞进 messages——直接丢弃这次半截输出，给足额度让模型重新一口气完整生成。
        # 如果这次重跑成功没再截断，后面的代码会自动把 max_tokens 重置回 8000 并把 state.has_escalated 设回 False（code_.py）。
        if response.stop_reason == "max_tokens":
            if not state.has_escalated:
                max_tokens = ESCALATED_MAX_TOKENS
                state.has_escalated = True
                print(f"  \033[33m[max_tokens] retry with {max_tokens}\033[0m")
                continue
            messages.append({"role": "assistant", "content": response.content})
            if state.recovery_count < MAX_RECOVERY_RETRIES:
                messages.append({"role": "user", "content": CONTINUATION_PROMPT})
                state.recovery_count += 1
                continue
            release_completed_assignment("agent")
            return

        # 看有没工具调用，没有直接返回结果;有进行调用后结果加到message走下一轮
        max_tokens = DEFAULT_MAX_TOKENS
        state.has_escalated = False
        messages.append({"role": "assistant", "content": response.content})
        if not has_tool_use(response.content):
            trigger_hooks("Stop", messages)
            remember_after_turn(messages)
            release_completed_assignment("agent")
            return

        # 有工具调用
        results = []
        compact_requested = False
        for block in response.content:
            if block.type != "tool_use":
                continue
            print(f"\033[36m> {block.name}\033[0m")

            # 工具主动调用压缩上下文，这里设置标志，压缩在本轮末尾
            if block.name == "compact":
                results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": "[Compaction requested. This completed turn will be summarized.]",
                })
                compact_requested = True
                continue
            # 权限日志等hooks
            blocked = trigger_hooks("PreToolUse", block)
            if blocked:
                results.append({"type": "tool_result",
                                "tool_use_id": block.id,
                                "content": str(blocked)})
                continue
            # 后台任务标志
            if should_run_background(block.name, block.input):
                try:
                    bg_id = start_background_task(block, handlers)
                    output = (f"[Background task {bg_id} started] "
                              "Result will arrive as a task_notification.")
                except Exception as exc:
                    output = (f"Error: Failed to start background task: "
                              f"{type(exc).__name__}: {exc}")
                results.append({"type": "tool_result",
                                "tool_use_id": block.id,
                                "content": output})
                continue
            # 取工具映射
            handler = handlers.get(block.name)
            # 执行工具
            output = call_tool_handler(handler, block.input, block.name)
            # 执行之后的hooks
            trigger_hooks("PostToolUse", block, output)
            print(str(output)[:300])
            
            # 这里是提醒模型更新todo的计数器
            if block.name == "todo_write":
                rounds_since_todo = 0
            else:
                rounds_since_todo += 1

            results.append({"type": "tool_result",
                            "tool_use_id": block.id, "content": output})

        messages.append({"role": "user", "content": build_user_content(results)})
        # 这里执行模型主动调用的压缩
        if compact_requested:
            messages[:] = compact_history(messages, active_request)
```
