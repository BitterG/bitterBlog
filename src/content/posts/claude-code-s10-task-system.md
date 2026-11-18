---
title: "s10：Task System — 持久化任务图与依赖解锁"
date: "2026-11-18"
updated: "2026-11-18T17:31:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Task System", "DAG", "Python"]
---

# s10：Task System — 持久化任务图与依赖解锁

![Task System 架构图](/img/agent/s10-task-system-overview.svg)

解决 `s05 TodoWrite` 只能存在于单次会话内存、没有依赖关系、没有认领归属的问题。本质是：**把大目标拆成带 `blockedBy` 依赖边的结构化任务图，持久化到磁盘 `.tasks/*.json`**，为跨会话追踪与 `s13` 多 Agent 协作打基础。

---

## 1. 先理清几个容易混的概念

### （1）`s10` 任务系统 vs `s06` 子 Agent（虽然工具名都带 `task`）

- **`s06` Subagent（工具名 `task`）**：属于**委派执行层**。每次调用会同步开一个全新的嵌套 `messages[]` 子循环干某件孤立的脏活，做完只返回最终文本总结，中间过程丢弃；它没有任务看板工具（`SUB_TOOLS` 里不含 `claim_task` / `complete_task`）。
- **`s10` Task System（`create_task` / `claim_task` / `complete_task` 等）**：属于**任务状态层**。只读写 `.tasks/*.json` 记录任务、依赖、状态与归属人，本身**不会启动任何子循环**。
- **一句话区分**：`s10` 管“有哪些事要按什么顺序做、做到哪了”；`s06` 管“派一个临时分身去干净地跑一段独立子对话”。

### （2）`s10` Task System vs `s05` TodoWrite

- `s05` 是进程内内存清单（整表替换、无依赖、无 `owner`，重启或上下文压缩后就没了）。
- `s10` 是磁盘持久化 DAG 任务图（单条记录按 ID 增改查、有 `blockedBy` 与 `owner`，新开会话依然存在）。

| 对比维度 | `TodoWrite (s05)` | `Task System (s10)` |
| --- | --- | --- |
| **定位** | 当前任务的执行清单 | 可恢复的任务系统 |
| **存储** | 进程内 / 会话内存 | `.tasks/{id}.json` |
| **依赖** | 无 | `blockedBy` 依赖图 |
| **生命周期** | 当前会话 / 当前任务 | 跨会话保留 |
| **分工** | 不负责任务认领 | `owner` / `claim_task` |
| **更新契约** | 整表替换 | 按 ID 单条增、读、改、列举 |

---

## 2. 存储结构与状态机

![Task DAG 依赖图](/img/agent/s10-task-dag.svg)

### （1）存储位置与数据结构

任务文件存放在**启动命令时当前工作目录**（`WORKDIR = Path.cwd()`）下的 `.tasks/` 目录（如根目录 `learn-claude-code/.tasks/task_xxxxxxxx.json`，该目录已被 `.gitignore` 忽略）。

每个 JSON 文件包含 6 个字段：

- `id`：`task_` + 8 位随机十六进制字符（排他创建，避免冲突）
- `subject`：任务标题
- `description`：任务详细描述
- `status`：`pending` / `in_progress` / `completed`
- `owner`：当前认领执行的 Agent（未认领为 `null`，`s10` 单人模式默认为 `"agent"`）
- `blockedBy`：前置依赖的任务 ID 列表

```python
@dataclass
class Task:
    id: str
    subject: str
    description: str
    status: str
    owner: str | None
    blockedBy: list[str]
```

### （2）两阶段建图 & 状态机

- **两阶段建图**：先用 `create_task` 创建所有节点拿到运行时生成的 ID，再用 `update_task(task_id, addBlockedBy=[...])` 添加依赖边（会自动校验存在性、禁止自依赖和依赖环，且仅允许在 `pending` 且无人认领时修改依赖）。
- **两个动作，三个状态**（`claim` 是动作，不是状态）：

```text
pending ──(claim_task)──→ in_progress ──(complete_task)──→ completed
```

> **重要细节**：`claim_task` 只检查前置是否完成并把状态改为 `in_progress`、写上 `owner`，**不会**解锁下游任务；只有调用 `complete_task` 变成 `completed` 后，下游任务才会解锁。
> 另外，新版实现**不会**在完成时把前置 ID 从下游任务的 `blockedBy` 数组中删除，而是通过 `can_start()` 动态读取前置任务状态是否为 `completed` 来判断是否阻塞——这样既能准确判断解锁，又能完整保留整张 DAG 的历史依赖拓扑。

---

## 3. 核心问题：任务完成后，下游任务如何被感知并执行？

![任务解锁与消费流转图](/img/agent/s10-unlock-loop.svg)

先明确一个前提：**`.tasks/*.json` 只是磁盘上被动保存的数据文件，不是后台活着的线程或进程。**

### （1）在 `s10`（单线程单 Agent）中

整个 `s10_task_system/code.py` 只有 **1 个单线程的 `agent_loop`**。既不是任务之间互相轮询，也不是父任务去发消息唤醒子任务，而是**“同步写盘 + 现场扫表返回 + 单 Agent 依次接手”**：

1. **记录完成**：当前正在执行的任务调用 `complete_task(task_id)`，函数校验 `status == "in_progress"` 且 `owner` 匹配后，把当前任务写盘标为 `completed`。
2. **现场扫表算解锁**：`complete_task` 紧接着调用 `list_tasks()` 遍历所有任务文件，用 `can_start()` 检查每个待执行任务的 `blockedBy` 前置是否已经全部 `completed`，找出**本次刚被解锁**的下游任务。
3. **当前帧返回 `tool_result` → 下一轮交给 LLM 决定**：
   - **当前这一帧结束时**：`complete_task` 把 `"Completed ...\nUnblocked: <任务标题>"` 作为 `tool_result` 塞回 `messages`；
   - **`agent_loop` 的 `while True` 进入下一轮**：把更新后的 `messages` 发给 LLM；
   - **下一轮由 LLM 自己决策**：LLM 看到新解锁的任务后，自行决定下一轮要不要调 `claim_task` 认领并继续执行（还是先停下来向用户汇报 / 等下一步指令）。

> **核心结论**：从 `s01` 到 `s10`，Harness 主循环始终没有变——**控制权一直在 LLM 手里**，任务系统（以及 Harness 代码）不会替模型自动“接单开跑”，只负责在磁盘上维护状态并把依赖/解锁依据通过 `tool_result` 喂给下一轮的 LLM。

### （2）对比 `s13`（多 Agent 团队模式）

真正出现多个执行者时，因为下游任务刚被解锁的瞬间 `owner` 还是 `null`（不知道该通知谁），才采用分工解耦的机制：

- **抢单靠短周期轮询**：空闲（IDLE）队友通过 `wait_for_messages(name, IDLE_SCAN_INTERVAL=2.0)` 每 2 秒扫一次 `.tasks/`，发现 `pending`、无 `owner` 且 `can_start() == True` 的任务就加锁原子 `claim_task` 并切回 `WORK` 执行。
- **汇报与点名靠事件唤醒**：队友向 Lead 汇报（`result` / `idle_notification`）或 Lead 发定向消息（`send_message`），则通过 `MessageBus` 写收件箱并用线程 `Condition` 立刻唤醒，不走轮询。

---

## 4. 跨会话持久化与中断恢复边界

- **能接上什么**：退出重启（`history = []` 清空）后，新会话只要调 `list_tasks` / `get_task` 就能恢复全部任务清单、完成进度、`description` 和依赖图；已经 `completed` 的不会重做。
- **接不上什么**：`.tasks/` **不保存对话上下文（`messages[]`）**。如果一个任务做到一半程序崩溃中断：
  - 推理过程、读过哪些文件、排查到哪一行都会丢失；
  - 在 `s10` 中该任务会停在 `in_progress`（`owner: "agent"`），不能再调 `claim_task`，新会话只能靠 `get_task` 读目标描述并检查工作区已修改的文件现场，接着干完后再调 `complete_task`；
  - 到 `s13` 才会补充队友退出时由 `release_teammate_assignment` 把任务重置回 `pending`，以及空闲时 `resumable_task` 优先接回自己名下未完成任务的恢复逻辑。
  - *（上下文/断点级别的持久能力分别在 `s09_memory` 长期记忆与 `s16_workflow_runtime` journal 续跑中解决。）*

---

## 5. 实操观察记录（与模型 Agency 的边界）

- 用官方示例 prompt 在教程仓库直接测试 `Claim the first unblocked task and complete it` 时，模型 `claim_task` 后用 `bash` 查了目录，发现本仓库没有真实数据库代码，于是**主动停下拒绝调用 `complete_task`**（不肯在没写 schema 的情况下假装完成）。
- 只有明确提示“这是任务系统练习，无需修改项目文件”，模型才会调用 `complete_task` 解锁后续节点——说明 **Harness 只提供状态与依赖规则，何时算真正完成仍由模型自身判断（Agency）**。

---

## 6. 核心流程代码对应（`s10_task_system/code.py`）

```python
def can_start(task_id: str) -> bool:
    return not incomplete_dependencies(load_task(task_id))


def claim_task(task_id: str, owner: str = "agent") -> str:
    task = load_task(task_id)
    if task.status != "pending":
        return f"Task {task_id} is {task.status}, cannot claim"
    dependencies = incomplete_dependencies(task)
    if dependencies:
        return f"Blocked by: {dependencies}"
    task.owner = owner
    task.status = "in_progress"
    TASKS.save(task)
    return f"Claimed {task.id} ({task.subject})"


def complete_task(task_id: str, owner: str = "agent") -> str:
    task = load_task(task_id)
    if task.status != "in_progress":
        return f"Task {task_id} is {task.status}, cannot complete"
    if task.owner != owner:
        return f"Task {task_id} is owned by {task.owner}, not {owner}"
    ready_before = {
        candidate.id
        for candidate in list_tasks()
        if candidate.status == "pending"
        and candidate.blockedBy
        and can_start(candidate.id)
    }
    task.status = "completed"
    TASKS.save(task)
    unblocked = [candidate.subject for candidate in list_tasks()
                 if candidate.status == "pending"
                 and candidate.blockedBy
                 and candidate.id not in ready_before
                 and can_start(candidate.id)]
    message = f"Completed {task.id} ({task.subject})"
    if unblocked:
        message += f"\nUnblocked: {', '.join(unblocked)}"
    return message
```
