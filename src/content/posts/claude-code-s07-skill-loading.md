---
title: "s07：Skill Loading — Agent 按需加载技能（Skill）"
date: "2026-11-17"
updated: "2026-11-17T20:07:00.000Z"
category: "agent"
categories: ["agent"]
tags: ["Claude Code", "Agent", "Skill Loading", "Context", "Python"]
---

# s07：Skill Loading — Agent 按需加载技能（Skill）

![Skill Loading 架构图](/img/agent/s07-skill-overview.svg)

## 1. 两个常见的加载时机

1. **模型自主加载（本节核心）**：`system prompt` 中只放技能目录，LLM 返回后自己判断需要哪个技能，再通过调用 `load_skill` 工具加载。
2. **用户显式触发（常见产品交互）**：用户发送消息时直接输入 `/skill`（如 `/code-review`），由客户端在发给 LLM 前提前拦截并展开对应技能内容。

## 2. 工作原理

### 2.1 `SKILL.md` 的目录结构

按规则分类将不同技能放在对应的子目录中，每个技能以 `SKILL.md` 作为入口文件：

```text
skills/
  agent-builder/SKILL.md
  code-review/SKILL.md
  mcp-builder/SKILL.md
  pdf/SKILL.md
```

### 2.2 两阶段读取流程

- **启动时扫描建索引**：扫描 `skills/*/SKILL.md` 头部（YAML frontmatter）中的 `name` 和 `description` 属性，只把这份轻量的技能目录拼进 `system prompt`，并在内存中缓存对应关系（如 `name` / `description` / `content`）。
- **运行时按需加载全文**：当需要用到某个技能时，通过 `load_skill(name)` 查表读取完整的 `SKILL.md` 内容作为 `tool_result` 返回给模型（若技能目录下还包含更深层的参考文档或脚本，再继续按需读取）。

## 3. 核心目的

用尽可能少的上下文 Token 维持“技能索引”，只在真正需要时才按需加载完整技能指南，既节省 Token，又避免无关规范污染当前对话上下文。

## 4. SkillLoader 与工具注册核心代码

本节没什么复杂的逻辑，核心就是 `SkillLoader` 的 `load` / `catalog` / `scan` / `parse_frontmatter` 这些方法；在基础工具里加入 `load_skill`，LLM 接收到就可以返回查找加载 `skill` 的响应了：

```python
class SkillLoader:
    def __init__(self, skills_dir: Path):
        self.skills_dir = skills_dir
        self.skills: dict[str, dict[str, str]] = {}
        self.scan()

    def scan(self):
        self.skills.clear()
        for manifest in sorted(self.skills_dir.glob("*/SKILL.md")):
            content = manifest.read_text(encoding="utf-8")
            metadata, body = self.parse_frontmatter(content)
            name = metadata.get("name") or manifest.parent.name
            description = metadata.get("description") or body.split("\n", 1)[0]
            self.skills[name] = {
                "name": name,
                "description": description,
                "content": content,
            }

    def catalog(self) -> str:
        """拼入 system prompt 的轻量技能目录"""
        return "\n".join(
            f"- {skill['name']}: {skill['description']}"
            for skill in self.skills.values()
        )

    def load(self, name: str) -> str:
        """模型调用 load_skill(name) 时按需返回完整 SKILL.md"""
        skill = self.skills.get(name)
        if not skill:
            return f"Error: Unknown skill '{name}'."
        return skill["content"]
```
