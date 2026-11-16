---
title: "s01：Agent Loop — Agent 主循环与工具执行流程"
date: "2026-11-16"
updated: "2026-11-16T16:01:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Agent Loop", "Python", "LLM"]
---

# s01：Agent Loop — Agent 主循环与工具执行流程

![Agent Loop 架构图](/img/agent/s01-agent-loop.svg)

## 1. 接收用户输入的主循环

Agent 依赖于一个接收用户输入消息的主循环：

```python
# -- Entry point --
if __name__ == "__main__":
    print("s01: Agent Loop")
    print("Enter a question, press Enter to send. Type q to quit.\n")

    history = []
    while True:
        try:
            # 这里接收用户输入的文本消息
            # \001/\002 tell Readline the ANSI escapes have zero display width.
            query = input("\001\033[36m\002s01 >> \001\033[0m\002")
        except (EOFError, KeyboardInterrupt):
            break
        if not query.strip():
            continue
        if query.strip().lower() in ("q", "exit"):
            break
        history.append({"role": "user", "content": query})
        # 这里开启 agent 子循环
        agent_loop(history)
        # Print the model's final text response
        response_content = history[-1]["content"]
        if isinstance(response_content, list):
            for block in response_content:
                if getattr(block, "type", None) == "text":
                    print(block.text)
        print()
```

在主循环中等待用户输入，有消息输入、格式化/加入角色等操作后，开启 `agent` 子循环。

## 2. 子循环与工具调用检测

在子循环中，将**用户消息 / 模型 / 系统提示词 / 工具列表**等参数组合发送至模型后，等待被调用模型回复。

回复中包含 `id`、是否调用及调用哪些工具等参数，如 `"type": "tool_use"` 等。

例如我发送：

```text
Create a file called hello.py that prints "Hello, World!"
```

模型会回复包括：

```python
{'command': 'echo print("Hello, World!") > hello.py && type hello.py && python hello.py'}
```

随后我们从响应体中遍历查找是否有调用工具及对应命令的标志和命令：

```python
tool_calls = [
    block for block in response.content if block.type == "tool_use"
]
if not tool_calls:
    return
```

## 3. 执行工具命令与安全检测

若有，我们则执行对应命令（执行前我们会做一些检测，防止执行一些危险命令）：

```python
# Execute each tool call, collect results
results = []
for block in tool_calls:
    print(f"\033[33m$ {block.input['command']}\033[0m")
    # 执行命令
    output = run_bash(block.input["command"])
    print(output[:200])
    results.append({
        "type": "tool_result",
        "tool_use_id": block.id,
        "content": output,
    })
```

具体执行函数如下：

```python
# -- Tool execution --
def run_bash(command: str) -> str:
    dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"]
    if any(d in command for d in dangerous):
        return "Error: Dangerous command blocked"
    try:
        r = subprocess.run(command, shell=True, cwd=os.getcwd(),
                           capture_output=True, text=True, errors="replace", timeout=120)
        out = (r.stdout + r.stderr).strip()
        return out[:50000] if out else "(no output)"
    except subprocess.TimeoutExpired:
        return "Error: Timeout (120s)"
    except (FileNotFoundError, OSError) as e:
        return f"Error: {e}"
```

## 4. 结果回传与多轮闭环

执行完毕后我们会拿到命令的返回值，再次放入 `messages`，开启下一轮循环，将执行结果交给 AI 再次等待返回：

```python
# Feed tool results back, loop continues
messages.append({"role": "user", "content": results})
```

AI 收到创建 `hello.py` 的内容后，会返回执行该文件的命令 `python hello.py`。

同理，我们在循环中判断命令执行后，再次拿到结果后放入 `messages`，进入下轮循环再返回给 AI，等待 AI 返回结果。这一次 AI 没有返回带执行命令的响应：

```python
TextBlock(
    citations=None,
    text='Created `hello.py` in `C:\\Users\\xxx\\xxx\\xxx\\xxx` — it prints "Hello, World!" when run.',
    type='text'
)
```
