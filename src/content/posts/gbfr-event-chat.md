---
title: "GBFR 战斗事件 → 游戏聊天 桥接脚本"
date: "2026-08-12"
updated: "2026-08-12T16:18:38.063Z"
category: "game-hacking"
tags: ["GBFR", "JavaScript", "游戏", "逆向"]
---

# GBFR 战斗事件 → 游戏聊天 桥接脚本（console.log 捕获版）

把 `relink-logs` 调试模式下打印到浏览器控制台的游戏事件 JSON，自动转换成喊话文本，POST 到 GBFR PE Patch Tool 的本地 HTTP 接口发送到游戏聊天。适用于碧蓝幻想：Relink（Granblue Fantasy: Relink）。

## 原理

- `relink-logs` 调试模式会把每条游戏事件以 JSON 打印到控制台（形如 `{"DamageEvent":{...}}`，带 `index-*.js:339` 行号前缀）。
- 脚本 monkey-patch `console.log` 捕获这些 JSON 行 → 规则匹配 → POST 到工具的本地 HTTP 接口发送到游戏聊天。

## 前提

1. GBFR PE Patch Tool 已启动外部接入服务（默认端口 `17395`）
2. `relink-logs` 调试模式已开启（能看到 DamageEvent JSON 输出）

## 使用方法

1. 启动 GBFR PE Patch Tool，开启外部接入服务
2. 打开 relink-logs 页面，F12 打开控制台
3. 粘贴下方完整脚本，回车运行
4. 看到 `[gbfr-chat] 桥接已启动` 即生效

手动测试：控制台执行 `console.log('{"DamageEvent":{"damage":99999}}')`

## 自定义规则

规则写在 `RULES` 数组中，每条规则包含：

- `name`：规则名（仅日志显示）
- `test: (ev) => boolean`：事件是否命中（ev 是事件 JSON 对象）
- `text: (ev) => string | null`：命中后返回要发送的文本；null 则不发送
- `cooldownMs`：可选，覆盖全局冷却

`ONLY_SELF = true` 时只触发"自己"的事件（联机建议开启），会自动从 `PlayerIdentityEvent` 学习本机玩家的 `actor_index`。

## 完整脚本

```javascript
/*
 * GBFR 战斗事件 → 游戏聊天 桥接脚本（console.log 捕获版）
 * 粘贴到 relink-logs 的浏览器 F12 控制台后回车运行。
 *
 * 原理：
 *   relink-logs 调试模式会把每条游戏事件以 JSON 打印到控制台
 *   （形如 {"DamageEvent":{...}}，带 index-*.js:339 行号前缀）。
 *   本脚本 monkey-patch console.log，捕获这些 JSON 行 → 规则匹配
 *   → POST 到工具的本地 HTTP 接口发送到游戏聊天。
 *
 * 前提：
 *   1. GBFR PE Patch Tool 已启动外部接入服务（默认端口 17395）
 *   2. relink-logs 调试模式已开启（能看到 DamageEvent JSON 输出）
 *
 * 自定义规则：改下面的 RULES 数组。
 */

// 工具的外部接入地址（与工具的端口一致）
const GBFR_CHAT_URL = "http://127.0.0.1:17395/api/chat/send";

// 同一规则最少间隔毫秒（工具自身还有 1 秒全局限制）
const RULE_COOLDOWN_MS = 2000;

/*
 * RULES：事件 → 文本 规则列表。每条规则：
 *   {
 *     name: 规则名（仅日志显示）
 *     test: (ev) => boolean,        // 事件是否命中（ev 是事件 JSON 对象）
 *     text: (ev) => string | null,  // 命中后返回要发送的文本；null 则不发送
 *     cooldownMs: 可选，覆盖全局冷却
 *   }
 *
 * ev 形如：
 *   { "DamageEvent": { "source": {...}, "target": {...}, "damage": 6348,
 *                      "flags": 165920, "action_id": {"Normal":1600}, ... } }
 *   { "OnUpdateSBA": { "actor_index":..., "sba_value":93.15, "sba_added":8.77 } }
 *   { "PlayerIdentityEvent": {...} }  等
 */
const RULES = [
  // 示例 1：玩家造成单次伤害 ≥ 10000000 时喊话
  // {
  //   name: "大伤害",
  //   test: (ev) => {
  //     const d = ev.DamageEvent;
  //     return !!d && d.damage >= 10000000;
  //   },
  //   text: (ev) => `这刀 ${ev.DamageEvent.damage}!`,
  // },

  // 示例 2：SBA 条满（≥100）时提醒
  {
    name: "SBA 满",
    test: (ev) => {
      const s = ev.OnUpdateSBA;
      return !!s && s.sba_value >= 100;
    },
    text: () => "不接的是gayyyyyyyyyyyyyyyyyyy!",
    cooldownMs: 15000,
  },

  // 示例 3：玩家死亡时提醒
  {
    name: "阵亡",
    test: (ev) => !!ev.OnDeathEvent,
    text: () => "what can i say. manba out!",
  },

  // 示例 4/5：技能伤害喊话（伤害数值 + 技能名连在一起）
  // Pl1900 角色 action id → 技能名（skill-name-sources.json + abilities.json 提取）
  // 任何已知技能的伤害事件 → "技能名 造成 xx 伤害!"
  {
    name: "技能伤害",
    test: (ev) => {
      const d = ev.DamageEvent;
      if (!d || !d.action_id) return false;
      const aid = d.action_id.Normal || d.action_id.SupplementaryDamage;
      return !!aid && !!SKILL_NAMES[aid];
    },
    text: (ev) => {
      const d = ev.DamageEvent;
      const aid = d.action_id.Normal || d.action_id.SupplementaryDamage;
      return `伊德大人使用 ${SKILL_NAMES[aid]} 造成了 ${d.damage}! 伤害 帅爆了！`;
    },
    cooldownMs: 8000,
  },
];

/*
 * Pl1900（你当前角色）action id → 技能名。
 * 换角色时：查 src-tauri/assets/skill-name-sources.json 对应 Pl#### 块，
 * 或告诉我新角色技能名，我帮你生成。
 */
const SKILL_NAMES = {
  1: "圣迹再临",
  2: "无缚之斩",
  3: "赎罪",
  4: "末日形态",
  5: "天谴",
  6: "神愿之力",
  7: "永无止境",
  8: "乐园之噬",
  10: "圣迹再临",
  20: "赎罪",
  21: "赎罪",
  22: "赎罪",
  23: "赎罪",
  24: "赎罪",
};

/*
 * ── 只触发"自己"的事件（可选）──
 * ONLY_SELF = true 时：
 *   - 从 PlayerIdentityEvent 自动记录自己的 actor_index（本机玩家，is_online=false 那条）
 *   - DamageEvent 只匹配 source.parent_index == 自己的 actor_index
 * ONLY_SELF = false 时：所有事件都进规则（队友/怪物伤害也会触发）。
 * 联机时建议 true（避免别人的伤害触发你的喊话）。
 */
const ONLY_SELF = true;

// ── 以下为运行时，一般无需修改 ──
(() => {
  const lastFire = new Map();
  let selfActorIndex = null; // 本机玩家的 actor_index（从 PlayerIdentityEvent 学习）

  // 若 ONLY_SELF，事件进来先判断是否属于自己。
  function isSelf(ev) {
    if (!ONLY_SELF) return true;
    const pid = ev.PlayerIdentityEvent;
    if (pid) {
      // is_online=false 的是本机玩家；记录其 actor_index
      if (!pid.is_online && pid.actor_index != null) {
        selfActorIndex = pid.actor_index;
      }
      return true; // 身份事件本身放行（不触发规则，但学习 actor_index）
    }
    // 其他事件：若有 actor_index 字段且不是自己 → 跳过
    if (ev.DamageEvent) {
      const d = ev.DamageEvent;
      if (selfActorIndex != null && d.source) {
        return d.source.parent_index === selfActorIndex;
      }
      return selfActorIndex == null; // 还没学到身份时暂时放行（避免误杀）
    }
    if (ev.OnUpdateSBA || ev.OnAttemptSBA || ev.OnPerformSBA) {
      const s = ev.OnUpdateSBA || ev.OnAttemptSBA || ev.OnPerformSBA;
      if (selfActorIndex != null && s.actor_index != null) {
        return s.actor_index === selfActorIndex;
      }
      return selfActorIndex == null;
    }
    if (ev.OnDeathEvent) {
      const d = ev.OnDeathEvent;
      if (selfActorIndex != null && d.actor_index != null) {
        return d.actor_index === selfActorIndex;
      }
      return selfActorIndex == null;
    }
    return true; // 未知事件类型放行
  }

  async function send(text) {
    try {
      const resp = await fetch(GBFR_CHAT_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await resp.json();
      if (!data.ok) console.warn("[gbfr-chat] 发送被拒:", data.error);
      else console.log("[gbfr-chat] 已发送:", text);
    } catch (e) {
      console.error("[gbfr-chat] 发送失败（工具外部接入服务启动了吗?）:", e);
    }
  }

  function cooldownOk(name, ms) {
    const now = Date.now();
    const last = lastFire.get(name) || 0;
    if (now - last < ms) return false;
    lastFire.set(name, now);
    return true;
  }

  function handleLine(str) {
    if (typeof str !== "string") return;
    const s = str.trim();
    if (!s.startsWith("{")) return; // 只处理 JSON 行
    let ev;
    try {
      ev = JSON.parse(s);
    } catch {
      return; // 不是合法 JSON，忽略
    }
    if (!ev || typeof ev !== "object") return;
    // ONLY_SELF 过滤：非自己事件直接跳过（PlayerIdentityEvent 用于学习 actor_index）
    if (!isSelf(ev)) return;
    for (const rule of RULES) {
      try {
        if (rule.test(ev)) {
          const text = rule.text(ev);
          if (text) {
            const cd = rule.cooldownMs || RULE_COOLDOWN_MS;
            if (cooldownOk(rule.name, cd)) send(text);
          }
          break; // 一个事件只匹配第一条命中的规则
        }
      } catch (e) {
        console.error(`[gbfr-chat] 规则 "${rule.name}" 异常:`, e);
      }
    }
  }

  // monkey-patch 所有 console 方法：捕获事件 JSON 行，同时保留原有行为
  const METHODS = ["log", "debug", "info", "warn", "error"];
  const orig = {};
  for (const m of METHODS) {
    orig[m] = console[m];
    console[m] = function (...args) {
      try {
        for (const a of args) {
          if (typeof a === "string") handleLine(a);
          else if (a && typeof a === "object") {
            try { handleLine(JSON.stringify(a)); } catch { /* ignore */ }
          }
        }
      } finally {
        orig[m].apply(console, args);
      }
    };
  }

  // 诊断：捕获到 JSON 行但规则未命中时也提示（便于排查）
  const origHandle = handleLine;
  handleLine = function (str) {
    if (typeof str !== "string") return;
    const s = str.trim();
    if (!s.startsWith("{")) return;
    let ev;
    try { ev = JSON.parse(s); } catch { return; }
    if (!ev || typeof ev !== "object") return;
    // 仅打印诊断：捕获到的顶层事件类型
    const top = Object.keys(ev)[0];
    if (top && top !== "PlayerIdentityEvent") {
      orig.log("[gbfr-chat][cap]", top);
    }
    origHandle(s);
  };

  console.log("[gbfr-chat] 桥接已启动: 捕获 console 事件 →", GBFR_CHAT_URL);
  console.log("[gbfr-chat] 规则:", RULES.map((r) => r.name).join(", "));
  console.log("[gbfr-chat] 手动测试: console.log('{\"DamageEvent\":{\"damage\":99999}}')");
})();
```

> 注意：脚本内含脏话/玩梗文本（SBA 满、阵亡时的喊话），仅为脚本原有内容原样展示。
