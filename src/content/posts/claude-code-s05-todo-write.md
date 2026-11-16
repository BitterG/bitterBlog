---
title: "s05：Todo Write — 任务追踪与防遗忘软提醒机制"
date: "2026-11-16"
updated: "2026-11-16T16:05:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Todo Write", "Context", "Python"]
---

# s05：Todo Write — 任务追踪与防遗忘软提醒机制

![Todo Overview 架构图](/img/agent/s05-todo-overview.svg)

## 1. 防遗忘提醒机制原理

第五节：本节是一个**防止模型遗忘主要任务的提醒功能**。有一个 `todo` 记录先列出每一个关键步骤后开工，防止模型进行一段后自由发挥导致跑偏方向。

机制就是有一个计数器，每 3 轮消息若没有更新 `todo` 记录，则在本次最后返回结果时，注入更新 `todo` 的提醒后重置计数器：

```python
rounds_since_todo = 0 if used_todo else rounds_since_todo + 1
if rounds_since_todo >= 3:
    # todo 提醒
    results.append({
        "type": "text",
        "text": "<reminder>Update your todos.</reminder>"
    })
    rounds_since_todo = 0
# 提醒随下一轮发送到模型
messages.append({"role": "user", "content": results})
```

> **注意**：触发提醒后下一轮也不一定就会立即更新 `todo`，这仅仅是一个提醒防止模型遗忘，而不是强制模型一定要来更新 `todo` 记录。

## 2. PyCharm Debug 抓包流程分析

下面我将使用 PyCharm Debug 的 `messages` 列表交由 Gemini 4 分析得出如下流程：

![PyCharm Debug Message 列表分析](/img/agent/s05-img.png)

### 2.1 前 5 轮：模型其实很自觉，甚至没等 `<reminder>` 就主动更新了一次

- **第 1 轮**：调了 `bash(dir /b)` 和 `glob` 探路 → 没调 `todo`，计数器 `rounds_since_todo = 1`
- **第 2 轮**：读 `hello.py` + 第 1 次调用 `todo_write`，列了 5 步，把第 1 步标为 `[>] in_progress`（`0/5 completed`）→ 计数器归零 `0`
- **第 3 轮**：检查 `pytest` + 写 `utils.py` → 计数器 = `1`
- **第 4 轮**：改 `utils.py` + 写 `test_utils.py` → 计数器 = `2`
- **第 5 轮**：写 `__init__.py` + 第 2 次调用 `todo_write`！

注意看：此时计数器才到 `2`（还没触发 `<reminder>`），模型因为一口气把 3 个文件全写完了，主动把前 4 步全部勾成 `[x] completed`，并把第 5 步设为正在进行：

```text
[x] Inspect existing example/ files for conventions
[x] Create demo_pkg/__init__.py with public exports
[x] Create demo_pkg/utils.py with implementation
[x] Create demo_pkg/tests/test_utils.py with tests
[>] Run tests to verify the package works   <-- 当前卡在这一步！
(4/5 completed)
```

此时计数器再次归零 `0`。

### 2.2 第 6 ~ 14 轮：为什么连续触发了 3 次 `<reminder>` 模型却“按兵不动”？

因为从第 6 轮开始，模型一直在做第 5 步（`[>] Run tests to verify the package works`），但测试一路报错，第 5 步一直没做完！

你看每一轮发生了什么：

#### 第一次累计到 3（第 6 ~ 8 轮）

- **第 6 轮 (计数=1)**：微调 `__init__.py` 的相对导入。
- **第 7 轮 (计数=2)**：跑 `unittest discover` → 报错 `ImportError`！
- **第 8 轮 (计数=3)**：换参数再跑 `unittest` → 报错 `FAIL: test_empty (1 != 0)`！

此时 `rounds_since_todo == 3`，Harness 塞入了**第 1 个** `<reminder>Update your todos.</reminder>`。

**为什么模型第 9 轮没调 `todo_write`？** 因为此时第 1~4 步早就是 `[x]` 了，而第 5 步（跑测试验证）刚刚 FAIL 了，状态依然是 `[>] in_progress`！计划表上的 5 个状态没有任何变化，去调一次 `todo_write` 传一模一样的内容毫无意义，所以模型选择先修 Bug。

#### 第二次累计到 3（第 9 ~ 11 轮）

- **第 9 轮 (计数=1)**：修好 `utils.py` 的 Bug 并重跑测试（23 个测试通过）。
- **第 10 轮 (计数=2)**：模型测试直接运行 `python demo_pkg/tests/test_utils.py` → 又报错 `ModuleNotFoundError`！
- **第 11 轮 (计数=3)**：修改 `test_utils.py` 和 `__init__.py` 里的文档说明。

此时 `rounds_since_todo == 3`，Harness 塞入了**第 2 个** `<reminder>Update your todos.</reminder>`。

**为什么模型第 12 轮还是没调 `todo_write`？** 看第 12 轮的 `ThinkingBlock`：模型发现文件开头的 `#!/usr/bin/env python3` 还没删、`doctest` 还没验证完，它认为第 5 步的“验证”还没收尾，状态依然是 `[>] in_progress`。

#### 第三次累计到 3（第 12 ~ 14 轮）

- **第 12 轮 (计数=1)**：想用 `bash <<"EOF"` 删 shebang → Windows `cmd.exe` 报错 `此时不应有 <<`。
- **第 13 轮 (计数=2)**：改用 `edit_file` 删掉两个文件的 shebang。
- **第 14 轮 (计数=3)**：最终跑了一遍 `unittest` + `doctest` → 23 个单元测试 + 3 个文档测试全部 OK！

此时恰好触发**第 3 个** `<reminder>Update your todos.</reminder>`。

- **第 15 轮**：测试彻底通过，第 5 步终于从 `in_progress` 变成了 `completed`！模型立刻调用 `todo_write` 把最后一步打上 `[x]`（`5/5 completed`）。

## 3. 从这个 Debug 结果能悟出什么设计精髓？

（这段话由 AI 总结，我觉得很不错，摘抄在此）

你抓到的这个现象，恰恰体现了 **Harness 软提醒 (`<reminder>`)** 和 **传统死板代码控制** 的本质区别：

1. **为什么颗粒度大时，中间不频繁调 `todo_write`？**
   模型在第 2 轮定下的第 5 步叫 `"Run tests to verify the package works"`（一个宏大的目标），结果这一个步骤里遇到了 3 次报错、花了 9 轮工具调用才搞定。因为始终处于第 5 步内部，Todo 的状态一直保持 `[>]` 不变，所以它不需要重复刷屏调用 `todo_write`。
2. **`<reminder>` 的真正作用是“防走神”，而不是“逼它喜新厌旧”**：
   如果没有那 3 次 `<reminder>`，模型在第 7 轮修 `ImportError`、第 8 轮修 `AssertionError`、第 12 轮修 `cmd.exe <<` 语法报错的过程中，很容易修完眼前的报错就直接停下来说“我修好了”，忘掉自己还有一个 Todo 列表没闭环。正是因为每 3 轮都有一个 `<reminder>` 提醒它看一眼 Todo，它才会在第 14 轮所有测试真正跑通的瞬间，记得去把第 5 步标为 `completed` 并清理现场。
