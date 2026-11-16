---
title: "s03：Permission — 权限审查三道闸门"
date: "2026-11-16"
updated: "2026-11-16T16:03:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Permission", "安全审查", "Python"]
---

# s03：Permission — 权限审查三道闸门

![Permission Pipeline 架构图](/img/agent/s03-permission-pipeline.svg)

## 1. 权限审查入口

第三节加了一个权限审查，包含三个闸门：**黑名单 / 规则匹配 / 询问用户**。

审查入口加在了 `agent_loop` 中，执行命令之前：

```python
def agent_loop(messages: list):
    while True:
        response = client.messages.create(
            model=MODEL, system=SYSTEM, messages=messages,
            tools=TOOLS, max_tokens=8000,
        )
        messages.append({"role": "assistant", "content": response.content})

        tool_calls = [
            block for block in response.content if block.type == "tool_use"
        ]
        if not tool_calls:
            return

        results = []
        for block in tool_calls:
            print(f"\033[36m> {block.name}\033[0m")

            # s03 change: run through permission pipeline before executing
            if not check_permission(block):
                results.append({"type": "tool_result", "tool_use_id": block.id,
                                "content": "Permission denied."})
                continue

            handler = TOOL_HANDLERS.get(block.name)
            output = handler(**block.input) if handler else f"Unknown: {block.name}"
            print(str(output)[:200])
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": output})

        messages.append({"role": "user", "content": results})
```

大致检查伪代码如下：

```python
def check_permission(block) -> bool:
    # 黑名单() true/false
    # 规则()   true/false
    # 用户同意() true/false
    return True
```

## 2. 三道审查闸门实现

### 2.1 第一道：命中黑名单（一些危险命令）

```python
DENY_LIST = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if=", "> /dev/sda"]
```

### 2.2 第二道：规则匹配（看是否是我们支持的工具调用 / 是否在工作区路径）

```python
PERMISSION_RULES = [
    # 路径检查规则
    {"tools": ["read_file", "write_file", "edit_file"],
     "check": lambda args: not (WORKDIR / args.get("path", "")).resolve().is_relative_to(WORKDIR),
     "message": "Writing outside workspace"},
    # 敏感命令规则
    {"tools": ["bash"],
     "check": lambda args: contains_destructive_command(args.get("command", "")) or
     any(kw in args.get("command", "") for kw in ["rm ", "> /etc/", "chmod 777"]),
     "message": "Potentially destructive command"},
]

def check_rules(tool_name: str, args: dict) -> str | None:
    for rule in PERMISSION_RULES:
        if tool_name in rule["tools"] and rule["check"](args):
            return rule["message"]
    return None
```

### 2.3 第三道：询问用户（若匹配规则命中）

```python
reason = check_rules(block.name, block.input)
if reason:
    decision = ask_user(block.name, block.input, reason)
```

```python
# 用户从命令行回复 yes/no
def ask_user(tool_name: str, args: dict, reason: str) -> str:
    print(f"\n\033[33m[permission] {reason}\033[0m")
    print(f"   Tool: {tool_name}({args})")
    choice = input("   Allow? [y/N] ").strip().lower()
    return "allow" if choice in ("y", "yes") else "deny"
```
