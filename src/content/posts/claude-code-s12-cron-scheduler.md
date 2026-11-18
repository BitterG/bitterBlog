---
title: "s12：Cron Scheduler — 定时调度器与非主线程审批边界"
date: "2026-11-18"
updated: "2026-11-18T17:33:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Cron Scheduler", "定时调度", "Python"]
---

# s12：Cron Scheduler — 定时调度器与非主线程审批边界

![Cron Scheduler 架构图](/img/agent/s12-cron-scheduler-overview.svg)

解决 `s11` 只能对当前命令做异步后台执行、但无法按未来时间点自动触发任务的问题。本质是：**在进程内用调度线程盯本地时间 + 队列唤醒线程盯 `cron_queue`，到点后自动抢锁把 `[Scheduled] {prompt}` 注入会话并拉起一轮 `agent_loop` 交给 LLM 处理**。

---

## 1. 核心原理：定时器 + 主动唤醒（对比 `s11`）

你的理解完全正确：`s12` 相当于一个**进程内定时器**，到点后给 LLM 发一条定时消息，由 LLM 决定这一轮是直接文字提醒还是调用 `bash` / 文件工具去干活。

与 `s11` 最大的一点不同是：**`s12` 真的实现了“用户不输入，后台到点也会主动调 LLM 响应”**。CLI 启动后会拉起两条守护线程：

1. **定时器线程 `cron_scheduler_loop`（只管看表 + 入队）**（`s12_cron_scheduler/code.py` L644–L646）：
   - 每 **1 秒**读取一次本地时间 `datetime.now()`；
   - 遍历 `scheduled_jobs`，若匹配五段式 Cron 表达式（支持 `*`、`*/N`、`N`、`N-M`、`N,M,...`）且当前分钟尚未触发（`last_fired` 去重），就将 `pending_delivery` 置为 `True` 落盘后放入内存队列 `cron_queue`。
2. **队列唤醒线程 `queue_processor_loop`（管抢锁 + 自动调 LLM）**（`s12_cron_scheduler/code.py` L727–L735）：
   - 每 **0.2 秒**检查 `cron_queue` 是否非空；
   - 只要非空且通过 `agent_lock.acquire(blocking=False)` 抢到了锁（说明主线程当前没在执行用户手动提问），就**自动调用 `run_agent_turn_locked()` → `agent_loop()`**。
3. **伪装成 `user` 消息投喂 LLM**（`s12_cron_scheduler/code.py` L650–L654）：
   - `agent_loop` 开头消费 `cron_queue`，把到期任务拼成 `{"role": "user", "content": f"[Scheduled] {job.prompt}"}` 追加进会话；
   - LLM 收到后，像处理普通请求一样自主决策要回复还是继续调工具。

*（工具登记仍走老套路：在 `TOOLS` / `TOOL_HANDLERS` 中注册 `schedule_cron`、`list_crons`、`cancel_cron` 三个工具。）*

---

## 2. 持久化与运行边界

- **持久化文件（`durable=True`）**：任务定义与 `pending_delivery` 状态会通过临时文件 + `os.replace()` 原子写入工作目录下的 `.scheduled_tasks.json`（`durable=False` 则仅存内存，重启消失）。
- **至少一次交付（at-least-once）**：只有当 `client.messages.create` 成功拿到响应后才调用 `acknowledge_cron_jobs`（一次性任务删除，周期任务清 `pending_delivery`）；若调用 LLM 报错，会回滚刚塞进来的 `[Scheduled]` 消息并把任务放回 `cron_queue`。
- **进程级边界**：定时器依赖 `s12` 进程存活。程序关闭后定时线程即停止；重启时只恢复配置，**不补跑**停机期间错过的时间点（需要关机后仍按时执行，必须交给系统级 `crontab` 或 `systemd timer`）。

| 数据字段 / 配置 | 作用 | 说明 |
| --- | --- | --- |
| `cron` | 五段式表达式（`分 时 日 月 周`） | `schedule_job()` 保存前用 `validate_cron()` 校验格式与取值范围 |
| `prompt` | 到期后投喂给模型的任务文本 | 包装为 `[Scheduled] {job.prompt}` 作为 `user` 消息加入对话 |
| `recurring` | 是否周期重复 | `False` 表示一次性任务，LLM 成功收包后即移除 |
| `durable` | 是否持久化到 `.scheduled_tasks.json` | `False` 仅存内存；`True` 支持重启恢复 |
| `pending_delivery` / `last_fired` | 交付状态与同分钟去重标记 | 保证同一分钟不重复入队，并支撑至少一次交付语义 |

---

## 3. 重点思考：为什么非主线程（定时子线程）禁止 `input()` 人工确认？

![非主线程 stdin 争抢与 GUI 异步审批对比图](/img/agent/s12-thread-stdin-boundary.svg)

### （1）原因不是“子线程不抢键盘”，恰恰是为了防它跟主线程抢同一个 `stdin`

- 当定时子线程到期醒来时，**主线程正卡在 `query = input("s12 >> ")` 上死等用户输入**（`s12_cron_scheduler/code.py` L782）。
- 如果子线程此时也弹出 `input("Allow? [y/N] ")`，进程里就会同时有两个线程阻塞在同一个键盘字节流 `stdin` 上——你敲下 `y` 回车，根本无法确定会被主线程当成新聊天消息吞掉，还是被子线程的权限确认吞掉。
- **只有在主线程跑用户手动发起的那轮对话时**，主线程已经暂时离开了 `s12 >> ` 的 `input()`，整个进程里没有别的线程在读 `stdin`，此时弹 `input()` 才是安全的。
- 因此 `request_permission()`（`s12_cron_scheduler/code.py` L194–L203）做了硬限制：只要 `threading.current_thread() is not threading.main_thread()`，需要人工审批的危险操作一律直接拒绝，防止争抢 `stdin`。

### （2）对比：为什么 `s11` 的后台子线程不会遇到这个问题？

- `s11` 是在**主线程创建后台线程之前**，就已经走完了 `PreToolUse` 权限检查与 `input()` 确认；后台线程里**不跑 LLM 也不跑 Hooks**，只负责拿着已放行的命令去 `subprocess.Popen(...)`。
- `s12` 的后台线程跑的是**完整的 `agent_loop`**，工具调用由后台轮次里的 LLM 临时发起，所以 `PreToolUse` 会落在非主线程上。

### （3）如果给 Agent 加上交互界面（GUI / Web UI / IDE 插件）呢？

- **完全可以让子线程弹出人工审批并点击确认！**
- 因为在 GUI 里，聊天输入框与审批弹窗是**天然分离的独立事件通道**，不再共用 `stdin` 字节流。工程改造方式是把同步阻塞的 `input()` 替换为 **“带 `request_id` 的异步审批事件 + 挂起等待”**：
  1. 子线程需要确认时生成唯一 `request_id`，向前端推送一条带任务来源与操作的审批卡片事件；
  2. 只让**当前这条子线程**在 `threading.Event` / `Future` 上等待（不阻塞主聊天界面与其他线程）；
  3. 用户点击界面上的“允许 / 拒绝”按钮，前端回传 `{request_id, approved}`，后端唤醒对应的 `Event` 让子线程继续执行。
- **落地时顺带注意两点**：① 如果前后台共享同一个 `messages[]`，仍需保留 `agent_lock` 防止并发写乱历史（或像 `s13` 那样给后台任务独立会话上下文）；② 给 `event.wait(timeout=...)` 加超时兜底，无人点击时自动按拒绝返回，避免子线程长期挂死。

---

## 4. 核心流程代码对应（`s12_cron_scheduler/code.py`）

```python
def request_permission(block, reason: str) -> str | None:
    if threading.current_thread() is not threading.main_thread():
        return "Permission denied: scheduled turns cannot request interactive approval"

    choice = input("   Allow? [y/N] ").strip().lower()
    if choice not in ("y", "yes"):
        return "Permission denied by user"
    return None


def cron_scheduler_loop(stop_event: threading.Event = RUNTIME_STOP):
    while not stop_event.wait(1.0):
        poll_due_jobs(datetime.now())


def queue_processor_loop(stop_event: threading.Event = RUNTIME_STOP):
    while not stop_event.wait(0.2):
        if not has_cron_queue() or not agent_lock.acquire(blocking=False):
            continue
        try:
            if has_cron_queue():
                run_agent_turn_locked()
        finally:
            agent_lock.release()


def agent_loop(messages: list, context: dict | None = None):
    fired = consume_cron_queue()
    scheduled_start = len(messages)
    for job in fired:
        messages.append({"role": "user", "content": f"[Scheduled] {job.prompt}"})

    waiting_for_ack = list(fired)
    while True:
        try:
            response = client.messages.create(
                model=MODEL, system=SYSTEM, messages=messages, tools=TOOLS, max_tokens=8000,
            )
        except Exception as error:
            if waiting_for_ack:
                del messages[scheduled_start:]
                restore_cron_jobs(waiting_for_ack)
            return context

        messages.append({"role": "assistant", "content": response.content})
        if waiting_for_ack:
            acknowledge_cron_jobs(waiting_for_ack)
            waiting_for_ack = []
        ...
```
