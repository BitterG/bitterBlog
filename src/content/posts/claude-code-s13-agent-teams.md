---
title: "s13：Agent Teams — 多 Agent 团队协作、Worktree 与协议机制"
date: "2026-11-18"
updated: "2026-11-18T17:34:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Agent Teams", "MessageBus", "Worktree", "Python"]
---

# s13：Agent Teams — 多 Agent 团队协作、Worktree 与协议机制

![Agent Teams 架构图](/img/agent/s13-agent-teams-overview.svg)

解决单个 Agent 面对大型并行工作时上下文易爆、耗时过长，以及 `s06 Subagent` 一次性用完即丢、无法跨任务持续协作的问题。本质是：**在 `s10` 持久化任务看板之上，引入由 Lead 协调的多条持久队友线程（`TeammateRuntime`）、基于收件箱的异步 `MessageBus`，以及协作协议与任务级 Worktree**。

---

## 1. 先串起全局定位：`s06`、`s10`、`s13` 的关系与区别

**关键认知：`s13` 创建的队友线程 ≠ `s10` 的 Task System**——两者是**“员工”与“工单”**的关系：

- **`s10` Task System** = 任务看板上的静态工单（`.tasks/*.json`：记做什么、依赖谁、状态、归属谁）。
- **`s13` Teammate** = 活着的持久员工线程（会主动认领工单、做完后回 `IDLE` 再去抢下一张解锁工单）。

| 章节 / 概念 | 本质是什么 | 生命周期 | 上下文与状态 | 通信与协作 | 形象类比 |
| --- | --- | --- | --- | --- | --- |
| **`s10` Task System** | 落盘的 DAG 任务状态表 | 跨会话持久（写死在 `.tasks/`） | 只存结构化字段，不存对话 | 被动记录，供认领与解锁 | **任务看板上的工单** |
| **`s06` Subagent（`task` 工具）** | 一次性同步子循环 | 一次调用后立刻销毁 | 全新 `messages[]`，做完丢弃 | 单向委派，只返回一次最终文本 | **临时外包跑腿**（不看看板，做完就走） |
| **`s13` Teammate（`spawn_teammate`）** | 独立线程中的持久循环 | `WORK ↔ IDLE` 长期存活直到关机 | 有身份、跨任务保留 `self.messages` | 通过 `MessageBus` 与 Lead 双向收发事件 | **长期队友员工**（会去 `s10` 看板抢单、解锁下游、汇报进度） |

---

## 2. 核心工作原理（第 1～12 步）

> 注：第 1～8 步为个人学习笔记原文，第 9～12 步根据 `s13_agent_teams/README.zh.md` 与 `code.py` 源码补全 Worktree 隔离与协作协议部分。

### 第 1 步：Lead 先提案分工，用户确认后再建任务、招队友

- Lead 收到大需求后不能擅自开多线程，需先提出分工方案等用户确认（控制并发度与修改边界）。
- 用户确认后，Lead 先按 `s10` 两阶段契约建好 `.tasks/` 工单与依赖，再调 `spawn_teammate(name, role, prompt, task_id=...)`（`s13_agent_teams/code.py` L1398–L1437）：
  - 若传入 `task_id`，线程启动前会先调 `claim_task(task_id, owner=name)` 绑定工单；
  - 若不传 `task_id`，队友启动进入 `IDLE` 后也会自己去任务板扫 ready task 抢单。

### 第 2 步：每个队友拥有独立的持久循环与隔离上下文

- 每个 `TeammateRuntime` 在独立线程里跑自己的 `WORK ↔ IDLE` 循环，维护私有的 `self.messages`。
- **隔离目的**：防止 A 队友调工具查出来的一堆结果混进 Lead 或 B 队友的推理上下文造成污染；同时单个队友做完一单后不会销毁，而是保留自己的上下文继续接下一单。

![Team Topology 通信拓扑图](/img/agent/s13-team-topology.svg)

### 第 3 步：`MessageBus` + 线程锁 + 共用 `Condition`（带闹钟的公用门铃）

- **每人一个信箱文件，全进程共用一个 `MessageBus` / `Condition`**：
  - 收件箱文件按人名严格隔离：Lead 对应 `.mailboxes/lead.jsonl`，队友 `auth` 对应 `.mailboxes/auth.jsonl`；
  - 但进程里只有一个全局单例 `BUS = MessageBus()`，只有一把内存线程锁 `self._lock = threading.RLock()` 和**一个共用的条件变量 `self._changed = threading.Condition(self._lock)`**（`s13_agent_teams/code.py` L855–L912）（注：保护 `.tasks/` 的文件锁是第 7 步的 `task_store_lock()`）。
- **`Condition` 只负责“通知”（不存任务内容），怎么兼顾立刻唤醒、IDLE 短睡与不拿错信？**
  看 `send`（L876–L885）和 `wait_for_messages`（L898–L909）：
  1. **消息到达立刻唤醒（广播敲门铃 + 各自查自己信箱）**：队友进 `IDLE` 后信箱为空，调用 `self._changed.wait(remaining)` 休眠。当有人调 `BUS.send(..., to_agent="auth", ...)` 时，消息只写进 `auth.jsonl`，随后调 `self._changed.notify_all()` 敲响公共门铃；所有休眠队友瞬间醒来执行 `while not self.peek(self.name):` 检查**自己的**信箱——`auth` 发现有信就读走切回 `WORK`，而 `tests` 发现自己信箱还是空的，便用未重置的剩余倒计时 `remaining` 重新 `wait(remaining)` 躺回去接着睡，**绝不会拿错写给别人的信**。
  2. **`IDLE` 下的短时等待（最多睡 2 秒巡检看板）**：如果没人发私信（门铃一直不响），但共享 `.tasks/` 任务板可能刚有前置任务完成解锁了下游，因此 `wait(IDLE_SCAN_INTERVAL=2.0)` 最多睡 2 秒自动醒来，去 `.tasks/` 扫一圈有没有新解锁的 ready task（避免死循环空转烧 CPU）。

### 第 4 步：Lead 收件箱同样在 `MessageBus` 里（0.25 秒轮询 + 4 类消息用途）

- **接收方式（点对点邮箱 + 0.25 秒短轮询，不是广播式 Pub/Sub）**：
  - Lead 主线程要同时兼顾**“键盘输入 `sys.stdin`”**和**“队友来信 `lead.jsonl`”**，不能像队友那样睡死在 `Condition` 上，因此在 `wait_for_cli_event`（`s13_agent_teams/code.py` L1850–L1865）中使用 `select([sys.stdin], ..., 0.25)` + `BUS.peek("lead")` 每 0.25 秒轮询两边的动静；
  - 检测到队友来信后，自动调用 `consume_lead_inbox()` 消费消息、匹配协议状态，将 `[Team events]` 注入主对话并自动拉起新一轮 `agent_loop`（Lead 模型本身无需轮询）。
- **收件箱承担的 4 类通信用途**：
  1. **完成汇报与空闲通知**：队友做完一轮工作进 `IDLE` 时连续向 `lead` 发送 `result`（产出总结）和 `idle_notification`（我空闲了）（L1316–L1325）；
  2. **普通点对点交流（`message`）**：Lead 与队友、队友之间通过 `send_message` 互通指示或中间状态；
  3. **异常告警（`error`）**：队友线程报错时将异常信息发回 `lead`（L1292–L1293）；
  4. **协作协议握手**：计划审批（`plan_request` / `plan_approval_request` / `plan_approval_response`）与平滑关机（`shutdown_request` / `shutdown_response`）。

*（注：Lead 知道队友完成任务靠 **`MessageBus` 收件箱**；其他空闲队友知道下游工单解锁则靠每 2 秒去扫 **`.tasks/*.json` 任务板**。）*

### 第 5 步：`result` 与 `idle_notification` 是两个独立事件（队友主动挂起，无需 Lead 批准）

- **不需要等 Lead 回复“允许挂起”**：队友这轮不再调用工具准备结束时，会在 `TeammateRuntime.work()` 末尾自己发通知后直接 `return "idle"` 进 `wait_for_work()` 挂起（`s13_agent_teams/code.py` L1313–L1326）。
- **为什么要拆成两条事件**：
  1. **`result` 回答“产出什么成果”**（业务结论）；
  2. **`idle_notification` 回答“这个队友现在能否再接活/关机”**（线程可用状态）。
  - 例如队友提交计划正等 Lead 审批（`plan_gates == "pending"`）时，虽也暂停调工具，但状态是 `waiting_approval`，既不发 `result` 也不发 `idle_notification`，避免 Lead 误以为它闲了或去接新单。

![IDLE 唤醒、消息隔离与双检抢单流程图](/img/agent/s13-idle-dcl-flow.svg)

### 第 6 步：`IDLE` 优先序、什么是 `assignment`、为什么会被遗忘在未完成态？

- **`IDLE` 醒来顺序**：先处理邮箱消息 → 再恢复自己未完成的 `assignment` → 最后去任务板抢新工单（L1331–L1348）。
- **`assignment` 是什么**：指“绑在当前队友名下尚未结单的任务及其工作目录租约”——磁盘 `.tasks/` 上体现为 `status == "in_progress"` 且 `owner == 自己`（`_owner_in_progress`），内存 `teammate_assignments[owner]` 记录 `{"task_id": ..., "cwd": ...}`（L64–L66）。
- **为什么已经进 `IDLE` 还会带着未完的 `assignment`？**
  - **最常见原因（LLM 健忘缺陷）**：模型改完代码直接输出文本总结、忘了调 `complete_task` 结单，`work()` 见无 `tool_use` 便把它切进 `IDLE`（`release_completed_assignment` 只释放 `completed` 任务）；
  - **系统原因**：中途暂停协调或进程重启遗留了旧 `in_progress` 任务。
  - **必须先恢复它**：既防烂尾，也因为 `claim_task` 限制同一 `owner` 只能同时持有一个 `in_progress` 任务；`resumable_task()` 会塞入 `[Resume task ...]` 把它拉回闭环（与 `s05 <reminder>`、`s17 Goal Stop` 同属用 Harness 兜底模型不可靠性）。

### 第 7 步：发现与认领两步走 ——“公共白板抢单”与文件系统双检原子锁

- **为什么每个队友有私有 `self.messages` 还要加锁抢单？**
  - 新建或刚解锁的任务一开始躺在**公共白板 `.tasks/*.json`** 上，不在任何人的 `self.messages` 里！如果两个空闲队友同一毫秒扫到同一张任务，不加锁就会把同一任务同时写进两份私有 `self.messages` 造成重复执行与文件冲突。
  - 只有谁在 `claim_task` 里加锁抢赢了，才写进谁私有的 `self.messages`（连 Lead 用 `spawn_teammate(..., task_id=...)` 派初始单也是先走加锁 `claim_task`）。
- **怎么实现类似 Redis Lua / Java 双检锁（DCL）的原子性？**（L70–L89、L205–L217、L281–L307）
  1. **外面粗筛提性能**：`scan_unclaimed_tasks()` 先筛 `status == "pending" and owner is None`；一旦被别人抢走 `owner` 不再为 `None`，后续线程在外面直接跳过，无需进锁争抢；
  2. **双锁串行化（`task_store_lock()`）**：先拿进程内线程锁 `task_lock`（`RLock`），再对空文件 `.tasks/.lock` 拿操作系统内核 **`fcntl.flock(LOCK_EX)`**（**锁文件里不写名字、出块用 `LOCK_UN` 解锁但不删 `.lock` 文件**，进程崩溃时内核自动释放防死锁；*注：Windows 原生无 `fcntl`，需 WSL 或改用跨平台锁*）；
  3. **锁内二次校验 + 原子替换**：进锁后重新 `load_task()` 核对 `status`、`owner is None`、依赖完成与目录有效，最后写临时 `.tmp` 文件再 `os.replace()` 原子覆盖（与 Java 单例的区别：若队友线程异常退出，`release_teammate_assignment` 会将 `owner` 退回 `None` 供重抢）。

### 第 8 步：认领后的工作复用同一个 `WORK` 循环

- **任务信息谁放进 `self.messages`？**
  - 开局 `spawn_teammate(..., task_id=...)` 时，由 `TeammateRuntime.__init__` 拼成 `[Assigned task ...]`（L1178–L1184）；
  - `IDLE` 空闲抢单或恢复时，**完全不经过 Lead**，由队友自己的 `wait_for_work()` 抢单成功后直接往 `self.messages` 追加 `[Auto-claimed task ...]` / `[Resume task ...]`（L1350–L1357）。
- **“复用同一个 `WORK` 循环”的意思**：`TeammateRuntime.run()` 只交替运行 `wait_for_work()`（`IDLE`）和 `self.work()`（`WORK`）。不管任务来自开局指派、Lead 私信还是自主抢单，都只是往 `self.messages` 塞一条 `user` 消息，随后全部走完全相同的 `self.work()` 执行引擎，无需多套循环。

### 第 9 步：由任务选择工具的工作目录（`Task.worktree` 与目录租约）

多个队友如果同时改仓库里的同一片代码，直接共用 `WORKDIR` 很容易互相覆盖。`s13` 在 `Task` 上增加了可选字段 `worktree: str | None = None`（`s13_agent_teams/code.py` L112–L120）：

- **只有 Lead 能创建绑定**：Lead 调用 `create_worktree(name, task_id)`（L489–L565），要求目标任务处于 `pending`、无人认领且未绑定；随后校验名称、路径越界、Git 仓库根、分支名 `wt/<name>` 和 Git worktree 注册表，在 `.worktrees/<name>` 检出独立工作树后再写回 `task.worktree`。若 `git worktree add` 半途报错留下残留目录或分支，会返回 `Partial operation` 并保持任务未绑定，留给人工恢复。
- **认领即绑定目录，失败直接拒认领（Fail Closed）**：`claim_task()` 调用 `task_worktree_cwd(task)`（L426–L431）解析目录并记录到 `teammate_assignments[owner] = {"task_id": task.id, "cwd": cwd}`；未绑定 worktree 时回落到仓库 `WORKDIR`，一旦绑定损坏则直接拒绝认领，绝不静默切换回主目录。
- **整轮工具统一读租约目录**：队友的 `bash`、`read_file`、`write_file`、`edit_file`、`glob` 都通过 `current_cwd()` → `assignment_cwd()` 取目录（L434–L455、L1204–L1230）；没有认领任务的队友无法使用任何工作区工具。
- **租约延后到轮次结束释放**：`complete_task()` 只把任务标为 `completed`，**不会立刻清掉** `teammate_assignments`，当前模型轮次剩下的工具调用仍能继续访问该任务目录，直到 `TeammateRuntime.work()` 结束切回 `IDLE` 时才调用 `release_completed_assignment()` 释放（L457–L470、L1321）。

> **安全边界提醒**：Worktree 只隔离 Git 工作目录与分支，**不是安全沙箱**——Shell 命令依然能访问父进程有权触达的系统路径。

### 第 10 步：Worktree 移除保留在宿主侧（`remove_worktree`）

模型可以调用 `create_worktree`，但**工具列表里故意不提供 `remove_worktree`**——清理目录与分支保留为宿主侧函数 `remove_worktree(name, discard_changes=False)`（L568–L618）：

```text
待办/进行中任务，或当前轮次 lease 未释放 → 拒绝移除
工作区有未提交/未跟踪/忽略文件          → 默认拒绝（需用户明确确认后才传 discard_changes=True）
干净的已完成 worktree                    → 移除 .worktrees/<name> 目录，始终保留 wt/<name> 分支并清空 task.worktree
```

这样既能防止队友干完活误删未合并提交，也允许宿主或用户在事后安全审查、合并或丢弃变更。

![Team Protocols 协作协议状态机图](/img/agent/s13-team-protocols-overview.svg)

### 第 11 步：类型化控制协议与 `request_id` 关联状态机

普通协作可以发自由文本，但**关机**和**计划审批**这类控制流不能靠模型猜意图，必须依赖结构化状态机 `ProtocolState` 与全局字典 `pending_requests`（L921–L967）：

```python
@dataclass
class ProtocolState:
    request_id: str
    type: str           # "shutdown" | "plan_approval"
    sender: str
    target: str
    status: str         # "pending" -> "approved" | "rejected"
    payload: str
    work_version: int | None = None
    task_id: str | None = None
```

以 **Shutdown 平滑关机协议**为例：

1. Lead 调用 `request_shutdown(teammate)` 生成 `req_xxxxxx` 写入 `pending_requests`，通过 `BUS` 发送 `type="shutdown_request"`；
2. 队友在 `handle_inbox()` 收到后由 `apply_shutdown_request()` 核对收发双方、类型与 `pending` 状态（L1091–L1109），回发 `shutdown_response`（携带同一 `request_id`）并退出循环；
3. 主循环在 `consume_lead_inbox()` 中自动执行 `match_response()`，将 `pending_requests[request_id].status` 推进为 `approved`（校验 `request_id`、期望响应类型、双方身份与状态，防止乱匹配或重复消费）。

### 第 12 步：计划审批协议与 `Plan Gate` 执行约束

当高风险重构需要先看方案再改代码时，Lead 可在 `spawn_teammate(..., require_plan=True)` 开启闸门，或对运行中队友调用 `request_plan(teammate, task)`。协议流向与关机相反（队友发起提交 → Lead 审批）：

```text
Lead: request_plan ──→ 队友: submit_plan(plan) [记录 work_version, task_id]
                   ──→ Lead: review_plan(request_id, approve, feedback)
                   ──→ 队友: apply_plan_response() 解锁或打回修改
```

工具分发层 `_run_teammate_tool()`（L1038–L1057）会在执行工具前做两重硬门控：

```python
def _run_teammate_tool(name: str, block, handlers: dict) -> str:
    gate = plan_gates.get(name, "not_required")
    if block.name in {"bash", "write_file", "edit_file"}:
        if gate != "approved" and gate != "not_required":
            return (f"Blocked: plan status is {gate}. Submit or revise the "
                    "plan and wait for approval before changing the workspace.")
        blocked = check_permission(block, prompt_user=False)
        if blocked:
            return blocked
    ...
```

- **未获批前只读不改**：处于 `required`、`pending`、`rejected` 时，队友仍可调用 `read_file` / `glob` 调研或重新 `submit_plan`，但无法执行 `bash`、`write_file`、`edit_file`，也无法 `complete_task`（L320–L322）。
- **防旧审批串单失效（`assignment_versions`）**：每次认领或释放任务都会调用 `advance_assignment_version()` 递增版本号；`review_plan()` 与 `apply_plan_response()` 会严格比对 `(work_version, task_id)` 是否与当前任务一致，防止上一单的批准跨任务误放行。
- **后台禁止 `stdin` 交互**：队友线程中 `check_permission(block, prompt_user=False)` 遇到危险命令或越界路径不会阻塞等待键盘，而是直接返回错误让 Lead 与用户处理。

---

## 3. 并发架构感悟：它是“有状态、有上下文”的定制版 Worker 线程池

从底层并发模型上看，**`TeammateRuntime` 线程 + `Condition` 条件变量 + `.tasks/` 共享任务板** 的骨架就是一个典型的 **Worker 线程池（生产者–消费者模型）**，但它有 4 个 Agent 专属差异：

1. **Worker 是有身份、有上下文记忆的**
   普通线程池里的线程无状态且互相等价，跑完就清空栈帧；这里每个队友线程都有固定 `name` / `role`、专属收件箱 `.mailboxes/<name>.jsonl`，并在 `self.messages` 中**跨任务持续保留自己的记忆上下文**。
2. **任务队列是带 `blockedBy` 的 DAG 依赖图，还能绑定目录**
   不是普通 FIFO 队列，而是前置全 `completed` 才能认领，且可按任务绑定独立的 Git `.worktrees/` 工作目录。
3. **动态招人 / 优雅关机，而非固定池容量**
   由 Lead 提案并经用户确认后按需 `spawn_teammate` 拉起，任务完成后通过 `shutdown_request` 协议优雅退出。
4. **带协同审批闸门（Plan Gate）**
   处于 `plan_gates == "pending"` 等待计划审批的队友，在审批通过前即便闲着也不能继续抢单或修改文件（`s13_agent_teams/code.py` L1340–L1341）。

---

## 4. 关键边界追问：有身份的队友会“抢错不是自己那类”的活吗？

这里要区分**“收件箱”**和**“任务板”**两个层面：

1. **从 `MessageBus` 收件箱拿指令：绝对不会拿错**
   `Condition` 只是通知门铃，不存消息；每个队友只读各自名下的 `.mailboxes/<name>.jsonl`（`peek(self.name)` / `_read_unlocked(self.name)`），写给 `auth` 的指令 `tests` 绝不可能取走。
2. **从 `.tasks/` 任务板自动抢单：教学版 `s13` 确实可能“跨角色抢单”！**
   - `Task` 数据结构里只有 `id`、`subject`、`description`、`status`、`owner`、`blockedBy`、`worktree`（`s13_agent_teams/code.py` L113–L120），**没有 `role` / 标签字段**；
   - 空闲队友每 2 秒调用 `scan_unclaimed_tasks()` + `claim_next_task(self.name)`（L1125–L1154）时，只是按顺序抢下第一张 `pending`、无 `owner` 且前置全完成的工单，**不会过滤任务是否匹配自己的 `role`**。
   - **`s13` 为什么还能跑通**：① Lead 在 `spawn_teammate(..., task_id=...)` 时就已经定向绑好了核心初始工单，干完后可先发 `shutdown_request` 让专职队友下班；② 底层所有队友用的其实是同一个通用 LLM 与同样的 5 个文件/Shell 工具，`role` 只是 `self.system` 里的提示词。
   - **如果要做严格“专人专岗”的改进方向**：在 `Task` 上加 `required_role` / `labels` 过滤 `scan_unclaimed_tasks()`，或者不让运行时盲抢第一单，而是由醒来的队友调 `list_tasks()` 让 LLM 自己判断是否符合职责后再调 `claim_task`。

---

## 5. 常见工程译名速查（还原为后端直觉）

| 中文译名 | 英文原词 | 白话 / 后端类比 | 本仓库里的具体对应 |
| --- | --- | --- | --- |
| **闸门** | `Gate` | **拦截关卡 / 开关 / Interceptor**（没开闸前不放行） | `s13` 的 `plan_gates`（未 `approved` 前拦截 `bash` / `write_file` / `edit_file`，L1038–L1044）；`s17` 在 `Stop` 时拦截未达标退出的目标闸门 |
| **契约** | `Contract` | **接口约定 / 调用规范 / DTO 协议**（双方必须遵守的规则） | `s10` 单条增改查 vs `s05` 整表替换的“更新契约”；先 `create_task` 拿真 ID 再 `update_task` 连边的“两阶段契约” |
| **夹具 / 载具** | `Harness` | **模型之外的全部外围工程底座**（测试夹具 / 马具） | 去掉调用 LLM API 那一行，其余主循环、工具、权限、Hooks、记忆、任务板、总线、Worktree、MCP 全属于 Harness |
