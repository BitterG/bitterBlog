---
title: "s02：Tool Use — 工具扩展与分发映射"
date: "2026-11-16"
updated: "2026-11-16T16:02:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Tool Use", "Python", "LLM"]
---

# s02：Tool Use — 工具扩展与分发映射

![Tool Dispatch 架构图](/img/agent/s02-tool-dispatch.svg)

## 1. 为什么要提供专用工具

本节为第二节，为工具提供新的五个工具：`write` / `read` / `edit` / `glob` / `path`。

改善的是**模型与 Harness 之间的接口**。调用带有 `path` 参数的 `read_file` 时，模型不必把意图翻译成 shell 语法，因此能减少引号和转义错误。

## 2. 注册 TOOLS 工具描述

我们只需要为 `TOOLS` 添加新工具和描述：

```python
TOOLS = [
    {"name": "bash",       "description": "Run a shell command.", ...},
    {"name": "read_file",  "description": "Read file contents.",  ...},
    {"name": "write_file", "description": "Write content to file.", ...},
    {"name": "edit_file",  "description": "Replace text in file once.", ...},
    {"name": "glob",       "description": "Find files by pattern.", ...},
]
```

## 3. 实现每个工具对应的处理函数

然后实现每一个工具对应的函数（这里只是简单实现）：

```python
def run_read(path, limit=None):
    lines = safe_path(path).read_text(encoding="utf-8").splitlines()
    if limit:
        lines = lines[:limit]
    return "\n".join(lines)

def run_write(path, content):
    safe_path(path).write_text(content, encoding="utf-8")
    return f"Wrote {len(content)} bytes to {path}"

def run_edit(path, old_text, new_text):
    text = safe_path(path).read_text(encoding="utf-8")
    if old_text not in text:
        return "Error: text not found"
    safe_path(path).write_text(text.replace(old_text, new_text, 1), encoding="utf-8")
    return f"Edited {path}"

def run_glob(pattern):
    import glob as g
    matches = sorted(set(g.glob(
        pattern, root_dir=WORKDIR, recursive=True)))
    shown = matches[:200]
    if len(matches) > 200:
        shown.append("... (more matches omitted; narrow the pattern)")
    return "\n".join(shown)
```

## 4. 工具名称到函数的映射与分发调用

我们从 AI 响应中取出调用工具依次执行，需要 `str` 到函数的一个映射：

```python
TOOL_HANDLERS = {
    "bash": run_bash,
    "read_file": run_read,
    "write_file": run_write,
    "edit_file": run_edit,
    "glob": run_glob,
}
```

调用（替换原 `run_bash` 的位置）：

```python
results = []
for block in tool_calls:
    print(f"\033[33m> {block.name}\033[0m")
    # 映射对应函数
    # 原 output = run_bash(block.input["command"])
    handler = TOOL_HANDLERS.get(block.name)
    # 调用取返回值
    output = handler(**block.input) if handler else f"Unknown: {block.name}"
    print(str(output)[:200])
    results.append({
        "type": "tool_result",
        "tool_use_id": block.id,
        "content": output,
    })
```
