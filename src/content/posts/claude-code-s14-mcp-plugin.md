---
title: "s14：MCP Tools — 外部工具动态发现、传输协议与权限隔离"
date: "2026-11-18"
updated: "2026-11-18T17:35:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "MCP", "JSON-RPC", "Python"]
---

# s14：MCP Tools — 外部工具动态发现、传输协议与权限隔离

![MCP Tools 架构图](/img/agent/s14-mcp-architecture.svg)

解决每接入一个外部系统（文档库、部署平台、Jira 等）就必须修改 Agent 源码、硬编码工具定义和调用逻辑的问题。本质是：**外部系统通过 MCP Server 暴露工具清单（`tools/list`）与执行入口（`tools/call`）；Agent Harness（宿主程序）充当中间人（MCP Client），在运行时动态发现外部工具、加上命名空间前缀、挂上宿主权限策略后，混入同一个 `tools[]` 工具池交给模型调度**。

---

## 1. 核心链路澄清：不是 LLM 连端口，而是 Agent Harness 做中间人

**大模型（LLM）本身没有任何发网络请求或拉起本地子进程的能力**，真实调用永远是两段式的（`s14_mcp_plugin/code.py` L8–L22）：

```text
[AI 模型 (LLM)]  <-- tool_use / tool_result -->  [Agent Harness (内置 MCPClient)]  <-- 传输层 -->  [MCP Server]
```

1. **对模型“伪装成普通本地工具”**：Harness 连接 MCP Server 拿到工具定义后，通过 `assemble_tool_pool()`（`s14_mcp_plugin/code.py` L328–L368）将外部工具统一重命名为 `mcp__{server}__{tool}`，和内置 `bash`、`read_file` 拼进同一个 `tools=[...]` 参数里发给模型。对 LLM 而言，MCP 工具与内置工具在格式上毫无区别。
2. **由 Harness 拦截鉴权并代发调用**：模型输出 `tool_use` JSON 后，Harness 先经过 `permission_hook()`（`s14_mcp_plugin/code.py` L403–L429）校验宿主权限，放行后再由 `MCPClient.call_tool()` 真正去调用 MCP Server，拿回结果再包装成 `tool_result` 塞回 `messages`（L518–L528）。

*（注：教学版 `s14` 为了聚焦协议边界，用内存类 `MCPClient`（L170–L198）+ `MOCK_SERVERS` 模拟 `docs` / `deploy` 两个 Server，省略了真实传输层，见 `s14_mcp_plugin/README.zh.md` L29。）*

---

## 2. 真实传输层协议：`stdio`（管道）vs `HTTP`（网络端口）

![MCP 传输形态与宿主安全网关](/img/agent/s14-mcp-transport-and-security.svg)

无论走哪种传输层，**MCP 里面跑的应用层协议都是同一个 JSON-RPC 2.0**（如仓库里 `skills/mcp-builder/SKILL.md` L203 演示的 `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`），区别只在于“JSON-RPC 消息通过什么通道传输”：

### （1）本地 `stdio transport` 是什么协议？

- **本质**：操作系统父子进程之间的**标准输入/输出匿名管道（`stdin` / `stdout`）+ 换行符分隔 JSON（NDJSON）**，跟 LSP（Language Server Protocol）设计一致——**不走 TCP/IP，不占网络端口**。
- **运行方式**：
  1. 配置里填的是启动命令而非 URL（如 `skills/mcp-builder/SKILL.md` L76–L84 的 `"command": "python3", "args": [...]`）；
  2. Harness 启动时通过类似 `subprocess.Popen(..., stdin=PIPE, stdout=PIPE)` 把 MCP Server 作为**子进程**拉起；
  3. Harness 往子进程 `stdin` 写一行 JSON-RPC 请求；Server 执行完把结果写回自己的 `stdout`，Harness 从管道另一端按行读回。
- **经典踩坑点**：`stdio` 模式下的 MCP Server **绝不能随便 `print(...)` 到 `stdout`**（会直接污染协议流），调试日志必须输出到 `stderr` 或文件。

### （2）为什么平时还是见到很多开放 HTTP 的 MCP？

单论编码难度，`stdio` 反而更简单（`skills/mcp-builder/SKILL.md` L64–L66 几行即跑）；现实里大量 MCP 走 **HTTP（Streamable HTTP / 早期 SSE）** 主要是**生命周期与部署形态**决定的：

| 对比维度 | `stdio`（本地子进程管道） | `HTTP`（Streamable HTTP / SSE） |
| --- | --- | --- |
| **典型适用场景** | 随用随起的本地工具（查本地 DB、读本地文件、跑本地 CLI） | ① **已运行的重型桌面软件桥接**（如 Blender / IDE / 浏览器插件，不能由 Agent 另起新进程，只能操作当前打开的窗口现场）；<br>② **远程云端 SaaS 服务**（GitHub、Notion、Linear 等）；<br>③ **跨容器 / 多客户端共享同一常驻状态** |
| **端口与环境配置** | 零端口占用，父进程关闭时子进程自动回收；但用户本机要配好 Python/Node 等运行环境 | 需要监听端口与鉴权（如 OAuth/Token）；但云端部署后用户端填 URL 即可使用，免去本地配环境门槛 |
| **安全性** | 天然隔离在父子进程内，不暴露本机端口给其他程序 | 需注意绑定地址（`127.0.0.1` vs `0.0.0.0`）、鉴权与防未授权访问 |

---

## 3. `s14` 重点展示的 4 个 Harness 设计细节

1. **延迟连接与动态工具池**（`connect_mcp` L289–L302、`agent_loop` L488–L498）
   开局只把 5 个基础工具和 `connect_mcp` 放进工具池；连接 Server 后，下一轮循环通过 `assemble_tool_pool()` 动态把新发现的工具加入 `tools`，避免未用先塞爆上下文。
2. **命名空间前缀与规范化碰撞检查**（`s14_mcp_plugin/code.py` L340–L356）
   不同 Server 都可能有 `search` / `status`，统一拼成 `mcp__{server}__{tool}`，并检查替换非法字符后是否跨源碰撞（如 `docs.one` 与 `docs_one`）以及是否超过模型工具名 64 字符上限。
3. **闭包绑定防参数调包**（`make_mcp_handler` L323–L325）
   用闭包锁死 `(client, raw_name)` 而不用带默认参数 `lambda tool=raw_name, **kwargs`——因为默认参数仍是关键字参数，模型若传入 `{"tool": "trigger"}` 会把已放行的调用篡改到同 Server 的另一个高危工具上（见 `s14_mcp_plugin/README.zh.md` L125）。
4. **对外部 Server 零信任的宿主权限策略**（`MCP_HOST_POLICY` L204–L210、`permission_hook` L423–L428）
   即使外部 Server 自己在描述里标了 `readOnlyHint: True`，Harness 也**不采信**；授权完全由宿主白名单 `MCP_HOST_POLICY` 控制，未配置的工具默认走 `"confirm"` 人工确认。

---

## 4. 接入 MCP 时，Agent 到底要做什么适配？

要拆成**“模型（LLM）本身”**和**“Agent Harness（宿主底座）”**两层来看：

- **对 LLM 本身：几乎零特殊适配**。只要模型支持标准的 Function Calling / Tool Use，把 MCP 工具变成普通工具定义传进去即可（最多在 system prompt 里提示当前已连接的 server，如 `s14_mcp_plugin/code.py` L54–L58、L371–L374）。
- **对 Agent Harness（宿主工程底座）：需要做 6 块核心适配**（工作量全在这里）：
  1. **MCP Client 协议与生命周期管理**：对接 `stdio` 子进程管道（启停、防僵尸进程、防 `stdout` 污染）或 HTTP/SSE 传输层（重连、OAuth/Token 鉴权），实现 `initialize`、`tools/list`、`tools/call` 等交互。
  2. **动态工具池与 Schema 方言对齐**：每轮动态组装或监听 `tools/list_changed` 刷新；做 `mcp__{server}__{tool}` 前缀与长度/字符校验；把 MCP 的驼峰 `inputSchema` 转换成对应模型 API 的字段名（如 Anthropic 的 `input_schema`）并清洗不兼容的 JSON Schema 关键字。
  3. **路由分发与防篡改绑定**：将带前缀工具名路由回原 `(server, raw_tool)` 并锁死闭包绑定。
  4. **返回内容适配、截断与错误兜底**：MCP 返回的可能是多块内容（text/image/resource）及 `isError`，需转为模型认得的 `tool_result`；捕获超时/参数错误回传给模型自愈（L190–L197、L478–L481），并对大输出做截断/落盘保护上下文。
  5. **宿主侧零信任权限网关**：用宿主策略管控 `allow` / `confirm` / `deny`，不盲信外部 Server 自报的注解。
  6. **工具膨胀治理（按需/懒加载）**：挂多个 Server 时几十上百个工具 schema 会直接挤爆上下文、降低选工具准确率，因此成熟 Agent 通常还会做延迟连接（如 `s14` 的 `connect_mcp`）或懒加载（先只暴露工具名索引，用到再查完整 schema）。

---

## 5. 核心流程代码对应（`s14_mcp_plugin/code.py`）

```python
MCP_HOST_POLICY = {
    ("docs", "search"): "allow",
    ("docs", "get_version"): "allow",
    ("deploy", "status"): "allow",
    ("deploy", "trigger"): "confirm",
}


def make_mcp_handler(client: MCPClient, tool: str):
    """用闭包锁死 client 与 raw_name，防止工具参数里的 tool 键篡改目标函数"""
    return lambda **kwargs: client.call_tool(tool, kwargs)


def assemble_tool_pool() -> tuple[list[dict], dict[str, callable]]:
    global mcp_tool_policies
    tools = list(BUILTIN_TOOLS)
    handlers = dict(BUILTIN_HANDLERS)
    policies: dict[str, str] = {}
    origins = {tool["name"]: f"built-in tool {tool['name']!r}" for tool in tools}

    for server_name, server in mcp_clients.items():
        safe_server = normalize_mcp_name(server_name)
        for tool_def in server.tools:
            raw_name = tool_def["name"]
            prefixed = f"mcp__{safe_server}__{normalize_mcp_name(raw_name)}"
            if len(prefixed) > 64:
                raise ValueError(f"MCP tool name is longer than 64 characters: {prefixed}")
            origin = f"MCP tool {server_name!r}/{raw_name!r}"
            if prefixed in origins:
                raise ValueError(f"MCP tool name collision after normalization: {prefixed!r}")
            origins[prefixed] = origin
            tools.append({
                "name": prefixed,
                "description": tool_def.get("description", ""),
                "input_schema": tool_def.get("inputSchema", {}),
            })
            handlers[prefixed] = make_mcp_handler(server, raw_name)
            policies[prefixed] = MCP_HOST_POLICY.get((server_name, raw_name), "confirm")

    mcp_tool_policies = policies
    return tools, handlers
```
