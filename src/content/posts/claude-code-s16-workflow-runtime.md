---
title: "s16：Workflow Runtime — 工作流运行时与断点续跑"
date: "2026-11-19"
updated: "2026-11-19T17:51:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Workflow Runtime", "Journal", "Python"]
---

# s16：Workflow Runtime — 工作流运行时与断点续跑

![Workflow Runtime 总览](/img/agent/s16-workflow-runtime-overview.svg)

其实就是将重复的、步骤已知的工作流程，编排成一条由代码驱动的可靠流水线，并打包成一个 `Workflow` 工具挂载给 Agent 调用。

例如代码审查可以同时检查多个维度，再逐条验证发现、合并重复项并按严重程度排序。执行前已经知道步骤及其先后关系，这时宿主需要三样东西：

1. **并行**：别一个一个串着等；
2. **稳定的结果结构**：即使每个 agent 的回答会变化，输出也必须符合 Schema；
3. **可恢复**：跑到一半断了，已经做完的部分别从头再来。

如果这套编排只存在于对话历史里，步骤顺序和检查点也只存在于历史里。保存好的 workflow 把固定流程写进代码（*"The plan is code, not a chat turn."*），并在 `journal`（运行日志/流水账）中记录已经完成的调用；若中途中断，下次继续可通过查询日志快速走过已经执行的步骤。

---

## 1. `journal`（流水日志 / 断点续跑缓存）

![parallel vs pipeline 与 Journal 续跑](/img/agent/s16-parallel-vs-pipeline.svg)

对应类 `WorkflowJournal`（`s16_workflow_runtime/code_.py` L345–L391）和磁盘文件 `.runtime/<runId>.journal.jsonl`。

- **解决什么问题**：多 Agent 工作流跑到一半失败（网络超时、限流、预算耗尽）时，重跑不想让前面已经成功跑完的子 Agent 重新调大模型、白烧 token。
- **三步工作机制**（见 `ExecutionState.agent`，`s16_workflow_runtime/code_.py` L480–L530）：
  1. **确定性语义 key**（`key()`，L376–L380）：对 `kind|label|prompt|schema` 做稳定 SHA-256 哈希。因为不依赖执行顺序，就算 `parallel()` 并发顺序每次不同，同一个调用算出的 key 依然一致。
  2. **先查缓存**（`cached()`，L382–L383）：`resume=True` 时启动前先把 `.journal.jsonl` 读进内存 `self.cache`。若命中缓存（不是 `MISS`），直接返回旧结果，不调 LLM、不扣 token，状态标为 `cached`。
  3. **跑完立刻落盘**（`record()`，L385–L388）：以 append-only JSONL 追加写入并立刻 `flush()`，防进程崩溃丢记录。
- **实测对照**：
  - `demo`（`resume=False`）：`status=done`，消耗 `agents=11 tokens=883`；
  - `resume`（`resume=True`）：全部 `status=cached`，消耗 `agents=0 tokens=0`，产出完全一致的 6 条结果。

---

## 2. 编排原语：`parallel`（同步屏障）vs `pipeline`（无阶段屏障）

源码见 `ExecutionState.parallel`（`s16_workflow_runtime/code_.py` L531–L540）与 `ExecutionState.pipeline`（L542–L553）：

```python
async def pipeline(self, items, *stages):
    async def run_item(item, idx):
        value = item
        for stage in stages:
            value = await stage(value, item, idx)
        return value
    return await self.parallel([
        lambda it=it, i=i: run_item(it, i) for i, it in enumerate(items)
    ])
```

- **`parallel`（BARRIER）**：横向并发启动所有 thunk，通过 `await asyncio.gather(..., return_exceptions=True)` 等**全部分支收尾**后才检查异常并返回（防止某分支报错时提前关闭 `journal` 导致其他已完成分支丢失记录）。
- **`pipeline`（NO barrier between stages）**：
  - 为什么底层调了 `self.parallel`，却说“阶段之间没有屏障”？因为 `parallel` 包在**最外层（按元素并发）**，而不是包在每个 `stage` 上（按阶段并发）。
  - 每个 `item` 拥有自己独立的串行流水线 `run_item`（`stage1 -> stage2 -> ...`，每步接收 `(prev_value, original_item, idx)`）。
  - 不同 `item` 之间互不等待：比如 `audit:correctness` 一跑完就立刻进入 `Verify` 阶段，而此时 `security` / `performance` / `style` 还在 `Review` 阶段。只有所有 `item` 都走完全部阶段后，最外层 `parallel` 才汇总返回。
  - 细节：`lambda it=it, i=i: run_item(it, i)` 用默认参数锁住循环变量，避免 Python 闭包晚绑定陷阱。

---

## 3. 为什么 s16 里找不到 `agent_loop`？Agent 是如何进入 Workflow 的？

1. **直接复用 s15 的 `agent_loop`**（`load_integrated_host` L851–L860、`install_workflow_tool` L832–L848、`run_cli` L895–L929）：
   - s16 没有重写调度循环，而是在 CLI 启动时懒加载 `s15_integrated_harness/code_.py` 作为 `host`，通过包装 `host.assemble_tool_pool` 把 `Workflow` 注入工具池，然后直接调 `host.agent_loop(...)`。
   - 核心理念：**Workflow Runtime 本身只是挂在已有 Agent Loop 上的一个普通 Tool**。
2. **不是靠关键词匹配触发，而是大模型自主 Tool Use**：
   - 代码里没有任何 `if "review" in query:` 逻辑。
   - 大模型通过阅读 `WORKFLOW_TOOL`（`s16_workflow_runtime/code_.py` L765–L783）的 `description`（里面列出了所有已注册工作流的名称和描述，如 `review-changes`）和 `input_schema`，结合用户意图自主决定是否输出 `tool_use: Workflow(name="review-changes", args=...)`。

```text
用户输入提示词
  ▼
s15 agent_loop ──► 把 messages + tools(含 Workflow 说明书) 发给大模型
  ▼
大模型语义判断需要跑工作流，输出 tool_use: Workflow(name="review-changes", args=...)
  ▼
s15 分发 handlers["Workflow"] -> run_workflow_sync()
  ▼
进入 s16 Workflow Runtime（文件锁 + journal + budget + parallel/pipeline 并发跑子 agent）
  ▼
返回最终 JSON 作为 tool_result ──► s15 agent_loop ──► 大模型总结回复用户
```

---

## 4. Workflow Runtime（s16）vs Task System（s10）

Task System 也能把同样的事做成，但两者**控制流归属不同，是互补而非替代关系**：

| 对比维度 | Task System（s10 任务系统） | Workflow Runtime（s16 工作流引擎） |
| :--- | :--- | :--- |
| **谁控制流程** | **大模型动态决策**（边做边看任务板、临时拆解） | **Python 代码写死**（确定性编排，绝不漏步） |
| **中间传话开销** | 主 Agent 背着长上下文一轮轮建任务、收结果、再派活，慢且费 token | **省掉了主 Agent 中间传话**：主 Agent 只调 1 次 `Workflow`，内部全由 Python 代码 0 成本调度与传参 |
| **子任务如何产生** | 大模型每轮手动 `task_create` | 代码搭骨架 + **按上一步结果动态长出新任务**（如 `verify` 的数量取决于 `audit` 查出几条 finding） |
| **子 Agent 调 LLM 吗？** | 调 | **照样调！** 每个 `ctx.agent(...)` 都要独立调一次大模型（只是上下文极短且高并发） |
| **工程治理** | 偏自然语言协作，难做硬性约束 | 内置 `journal` 断点续跑、JSON Schema 校验与重试、并发信号量（8）、Token Budget 熔断 |
| **适用场景** | **探索型难题**（排查未知 bug、开放式重构，走一步看一步） | **固定 SOP / 高并发批处理**（多维度 PR 审查、批量文档提取-校验-汇总） |

> 真实系统里两者配合使用：**宏观用 Task System 管理动态目标，微观遇到固定套路直接一键调 Workflow。**

---

## 5. Workflow 里的子 `agent()` 是之前的 `sub-agent` 循环吗？

需要区分 **s16 教学源码** 与 **真实生产级 Agent 工具**：

- **在当前 s16 源码里：不是**。`AnthropicAgentRunner.run`（`s16_workflow_runtime/code_.py` L317–L341）只是**单轮、无 `tools`、无 `while True` 循环**的纯 `client.messages.create(...)` 调用（聚焦演示 Workflow Runtime 本身，避免工具副作用让 `resume` 重放复杂化）。
- **在真实 Agent 工具里：是的**。因为 s16 把执行器抽象成了可插拔的 `runner`，在生产级工具中，工作流的每个 `agent()` 节点通常就是拉起完整的 `sub-agent`（独立 `sub-loop`，能自己调 `read_file` / `grep` / `bash` 查证），最后按 Schema 把结构化结果交回给外层 Workflow。

---

## 6. Windows 本地运行踩坑记录

1. **`ModuleNotFoundError: No module named 'fcntl'`**：`fcntl` 是 Unix 专属模块，已将 `workflow_run_lock`（`s16_workflow_runtime/code_.py` L101–L139）改为 Unix 用 `fcntl.flock`、Windows 回退到标准库 `msvcrt.locking`。
2. **`FileNotFoundError: .../s15_integrated_harness/code_.py`**：原 `load_integrated_host()`（L851–L860）硬编码了 `code_.py`，已修正为 `code_.py`。
