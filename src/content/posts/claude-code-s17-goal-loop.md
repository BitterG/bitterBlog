---
title: "s17：Goal Loop — 目标循环与 Stop 边界评估"
date: "2026-11-19"
updated: "2026-11-19T17:52:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Goal Loop", "Stop Hook", "Python"]
---

# s17：Goal Loop — 目标循环与 Stop 边界评估

![Goal Loop 总览](/img/agent/s17-goal-loop-overview.svg)

在之前的 Agent Loop 里，“模型不再输出 `tool_use`”就意味着这一轮直接结束。但在长耗时或强验收标准的任务里，模型经常会半途而废、漏掉验证、或者口头宣称“已经修好了”就交卷。

**s17 的核心思想**：在“模型想交卷停止”的出口处挂一个**会话级 Stop 拦截器（`GoalController`）**，由一个**独立的、无工具的评估器模型（`PromptGoalEvaluator`）**审阅对话证据：

- 证据满足目标条件 → 放行结束（`achieved`）；
- 证据不足 → **拦截（`block`）**，把缺失原因塞回 `messages` 踢回同一个 `agent_loop` 继续干活。

```text
  +------------+     +--------------+     +-------------------+
  | messages[] | --> | Worker model | --> | no tool_use(交卷) |
  +-----+------+     +--------------+     +---------+---------+
        ^                                           |
        |         +------ GoalController -------+   |
        +---------| evaluator: block（打回重做） |<--+
                  +--------------+--------------+
                                 | allow / achieved / failed / limit / defer / error
                               return（真正结束）
```

---

## 1. 进入路径与退出边界：没有工具调用 ≠ 直接结束

源码见 `AgentSession._run_query`（`s17_goal_loop/code_.py` L681–L764）：

1. **有 `tool_use`**：执行工具，把 `tool_result` 追加进 `messages`，`continue` 走下一轮（不会触发 Goal 评估）。
2. **没有 `tool_use`**（模型以为干完了、想结束）：进入 `decision = await self.goal.evaluate_after_turn(self.messages, ...)`：
   - **`decision.action == "block"`**：**不准结束！** 将评估器指出的缺失点拼成 `[Goal still active]` 作为 `user` 消息追加进 `messages`，`continue` 强行拉回循环继续工作。
   - **其他结果（`allow` / `achieved` / `failed` / `limit` / `defer` / `error`）**：触发 `Stop` hook，真正 `return` 把控制权交还给用户。

---

## 2. 独立评估器（`PromptGoalEvaluator`）的设计要点

![GoalController 状态分支与独立裁判机制](/img/agent/s17-goal-controller-states.svg)

源码见 `PromptGoalEvaluator`（`s17_goal_loop/code_.py` L218–L273）：

- **裁判与运动员分离**：单独调用一个**没有工具权限**的模型（可通过 `GOAL_EVALUATOR_MODEL_ID` 指定更轻量的模型）只读 `transcript_text(messages)` 做判断。
- **只看证据，不盲信口头声明**：明确要求 *“Do not assume commands succeeded unless their results appear in the conversation”*，同时把 `completion_condition` 和 `conversation` 当作纯 JSON 数据，防止被对话内容里的提示注入带偏。
- **严格三元结构化输出**（`_parse_json_object`，L185–L215）：
  ```json
  {"ok": boolean, "reason": string, "impossible": boolean}
  ```
  且校验 `ok` 与 `impossible` 不能同时为 `true`。
- **Worker 侧配合**：Worker 的 system prompt 会提示 *“Report concrete command results so an independent evaluator can judge completion”*（实测中 Worker 甚至会主动打印 `EXITCODE=0` / `%errorlevel%`，给评估器留下铁证）。

---

## 3. 为什么 `GoalController` 要写 200 行这么多？

如果是玩具 demo，`if not ok: continue` 5 行就能写完；但要做到**可控、可观测、可熔断、可恢复**，`GoalController`（`s17_goal_loop/code_.py` L275–L480）必须兜底 6 类真实工程边界：

| 机制 | 代码位置 | 解决什么问题 |
| :--- | :--- | :--- |
| **连续拦截熔断** | `L413–L428` | `consecutive_blocks > block_cap`（默认 8 次）时返回 `"limit"` 强行交还控制权，防止 Worker 死活修不好导致无限烧 token；同时保留 `active` 目标方便用户介入后继续 |
| **区分“未完成”与“做不到”** | `L402–L411` | 评估器返回 `impossible=True` 时，直接判 `"failed"` 并清空目标，避免 Worker 徒劳撞墙 |
| **后台任务竞态延后** | `L367–L370` | 还有后台命令在跑（`background_running=True`）时返回 `"defer"` 先挂起，等 `submit_background_result`（`L665–L679`）回来再评估，防止误判证据不足 |
| **评估器自身故障兜底** | `L373–L386` | 捕获评估器网络超时或非法 JSON，记录错误并返回 `"error"`，既不崩溃也不误放行，且保留 `active` 状态 |
| **目标命令与状态管理** | `L296–L358` | 管理 `/goal <条件>`（非空与 4000 字符校验、覆盖旧目标）、`/goal clear` 取消、`/goal` 展示耗时/评估次数/token 消耗/上次原因 |
| **事件日志与断点恢复** | `L430–L479` | 每次状态变更通过 `_record()` 写入 `goal_status` 事件，会话重启后可用 `GoalController.restore(evaluator, events)` 恢复未完成的 `active` goal |

---

## 4. 本地实测与踩坑记录

1. **为什么 `/goal python -m pytest 退出码为 0` 跑了很久不结束？**
   - 根目录 `pytest.ini` 指向 `tests/`，全量共有 **503 个用例**，跑一遍要 1~2 分钟，极易撞上 `bash` 工具的 `timeout=120` 秒超时（`s17_goal_loop/code_.py` L782）。
   - 只要有 1 个用例失败或超时，Stop Hook 就会反复 `block` 让模型改代码并重跑全量 503 个用例（且 `max_turns` 默认无上限）。
   - `subprocess.run(..., capture_output=True)` 是全缓冲的，跑完前终端无实时进度，看起来像卡死。
2. **推荐测试方式**：
   - 缩小目标范围到单个测试文件（实测 3.27 秒跑完 20 个用例并触发 `[goal] achieved`）：
     ```text
     /goal python -m pytest tests/test_workflow_goal_lessons.py -k goal 退出码为 0
     ```
   - 可通过环境变量 `MAX_TURNS=6`（`s17_goal_loop/code_.py` L860）给测试会话加上硬性最大轮数上限，防止意外多轮烧 token。
