---
title: "Unity IL2CPP 游戏逆向全流程：从符号提取到注入 Hook 的完整方法论"
date: "2026-05-29"
updated: "2026-05-29T00:00:00.000Z"
category: "nohhgp"
tags: ["IL2CPP", "Unity", "Game Hacking", "Reverse Engineering", "DLL Injection"]
---

# Unity IL2CPP 游戏逆向全流程：从符号提取到注入 Hook 的完整方法论

> 以 Phasmophobia 的 GhostAI 为例，构建一个可复用的 IL2CPP 游戏内部注入框架。

---

## 为什么写这篇

市面上 IL2CPP 逆向的教程不少，但大多停留在"用 Il2CppDumper 跑一下"或者"用 Cheat Engine 改个值"。真正要写一个**能注入、能调方法、能稳定运行**的内部 DLL，中间有大量工程细节和踩坑点。

这篇文章把整个流程抽象成一个可复现的框架——你换一个 IL2CPP 游戏，换一个目标类，步骤完全一样。

---

## 整体流程概览

```
[1] Il2CppDumper 提取符号
        ↓
[2] 构建 C++ SDK（类布局 + 方法签名）
        ↓
[3] 运行时解析方法指针（不走硬编码 RVA）
        ↓
[4] 找到目标组件实例（三步查找法）
        ↓
[5] Hook Update 获得主线程执行上下文
        ↓
[6] 命令队列模式：后台线程发令，主线程执行
        ↓
[7] Photon 房主权限检查 + 字段直写回退
```

---

## 第一步：符号提取

Il2CppDumper 传入两个文件：

```bash
Il2CppDumper.exe GameAssembly.dll global-metadata.dat ./output
```

**元数据版本对应关系：**

| 元数据版本 | Unity 版本 | 工具 |
|---|---|---|
| ≤ 29 | 2021 及之前 | 原版 Il2CppDumper |
| 31 | 2022 | 原版 Il2CppDumper |
| 39 | 6000.x (Unity 6) | roytu/Il2CppDumper v39 fork |

如果自动模式失败（`CodeRegistration : 0`），切到手动模式，用 Cheat Engine 扫描特征码找到注册地址。

输出文件的关键角色：

- **`dump.cs`** — 你的日常参考。类名、字段偏移、方法签名。**但它会猜错参数类型**（后面详述）。
- **`script.json`** — IDA/Ghidra 导入用。函数地址 + 方法名映射。
- **`il2cpp.h`** — C 结构体定义。

---

## 第二步：理解 Il2Cpp 运行时

### 对象内存布局

每个托管对象在 Il2Cpp 中由 GC 头（16 字节）+ 实例字段组成：

```
┌─────────────────┐
│  klass  (0x00)  │  指向 Il2CppClass 类型元数据
├─────────────────┤
│  monitor (0x08) │  GC 同步块 / 锁
├─────────────────┤
│  实例字段...     │  dump.cs 中的偏移从对象起始算起
└─────────────────┘
```

`dump.cs` 标记的字段偏移量是**从对象基址起算**的，包含 GC 头。比如 `GhostAI.currentState` 标在 `0x30`，直接 `*(int*)(ptr + 0x30)` 读取即可。

### 方法在内存中的形态

Il2Cpp 把每个 C# 方法编译成一个独立的原生函数，遵循 x64 fastcall 调用约定。函数指针存在 `MethodInfo` 结构体的第一个字段：

```cpp
struct MethodInfo {
    void*    methodPointer;         // 0x00 — 原生函数入口
    void*    virtualMethodPointer;  // 0x08
    void*    invoker_method;        // 0x10
    // ...
    uint8_t  parameters_count;      // C# 参数个数
};
```

### 方法指针的动态解析

**不要硬编码 RVA。** 用 Il2Cpp 的元数据 API 按名查找：

```cpp
void* dom   = il2cpp_domain_get();
void* asm_  = il2cpp_domain_assembly_open(dom, "Assembly-CSharp");
void* img   = il2cpp_assembly_get_image(asm_);
void* klass = il2cpp_class_from_name(img, "", "GhostAI");
MethodInfo* mi = il2cpp_class_get_method_from_name(klass, "ChangeState", 3);
uintptr_t fn  = mi->methodPointer;  // ← 这就是要调的原生函数地址
```

这条链上的每一步都可能返回 `null`，务必逐层判空。

### argsCount 的约定

`il2cpp_class_get_method_from_name` 的 `argsCount` 是 **C# 层面的参数个数**（不含 `this`）：

| C# 签名 | argsCount | 原生签名 | 说明 |
|---|---|---|---|
| `void Update()` | 0 | `void Update(this, MethodInfo*)` | 2 个原生参数 |
| `void Appear(int)` | 1 | `void Appear(this, int, MethodInfo*)` | 3 个原生参数 |
| `void ChangeState(enum, object, object[])` | 3 | `void ChangeState(this, int, void*, void*, MethodInfo*)` | 5 个原生参数 |

**所有原生签名末尾固定跟一个 `MethodInfo*`**，调用时传 `nullptr` 即可。

---

## 第三步：创建 Unity 字符串（最关键的一个坑）

在 Il2Cpp 中创建字符串**必须用 UTF-16 接口**：

```cpp
// ✅ 正确方式
Il2CppString* MakeString(const char* s) {
    int len = MultiByteToWideChar(CP_UTF8, 0, s, -1, nullptr, 0);
    std::wstring w(len, 0);
    MultiByteToWideChar(CP_UTF8, 0, s, -1, &w[0], len);
    return il2cpp_string_new_utf16(w.c_str(), len - 1);
}

// ❌ 错误：il2cpp_string_new 创建的字符串在类型系统中不匹配
//    导致 Type.GetType() 等需要字符串匹配的接口返回 null 或崩溃
```

这个坑的典型症状：`Type.GetType("GhostAI")` 在调用栈深处产生 `R/W=0x0` 访问违规。原因是用 `il2cpp_string_new` 创建的字符串在 GC 堆上的内部编码与类型系统的字符串哈希表键值不一致。

---

## 第四步：找到目标组件实例

用 Unity 自带的查找 API，三步定位：

```cpp
// 1. 按 Tag 找所有 Ghost GameObject
void* tag = MakeString("Ghost");
GameObjectArray* arr = FindGameObjectsWithTag(tag, nullptr);

// 2. 获取 GhostAI 的 System.Type
void* typeName = MakeString("GhostAI");
void* aiType   = Type_GetType(typeName, nullptr);

// 3. 遍历取组件
for (int i = 0; i < arr->length; i++) {
    void* obj = arr->items[i];
    if (!obj) break;
    void* ai = GameObject_GetComponent(obj, aiType, nullptr);
    if (ai) return ai;
}
```

备用方案：如果 `Type.GetType` 失败，直接从 Il2Cpp 元数据获取 `System.Type`：

```cpp
Il2CppClass* klass = il2cpp_class_from_name(img, "", "GhostAI");
void* ilType = il2cpp_class_get_type(klass);
void* sysType = il2cpp_type_get_object(ilType);
```

---

## 第五步：线程安全

这是最容易被忽视、但最容易导致崩溃和死锁的环节。

### 规则 1：每个线程必须 attach 到 Il2Cpp

```cpp
static DWORD WINAPI MyThread(LPVOID) {
    il2cpp_thread_attach(il2cpp_domain_get());  // ← 放第一行
    // ...
}
```

不 attach 的症状：访问托管字符串或对象时在 `R/W=0x0` 处崩溃。

### 规则 2：Unity/Photon API 必须在主线程调用

从 `CreateThread` 创建的线程直接调 `ChangeState`、`Hunting` 等 Photon 相关方法，会导致两种结果：
- **崩溃**（访问违规）
- **死锁**（Photon 内部等待主线程消息泵回调，永远等不到）

**解决方案：Hook `Update()` 拿到主线程执行上下文。**

---

## 第六步：MethodInfo 指针替换 —— 零代码修改的 Hook

传统 detour（覆盖函数机器码）有三大问题：
1. 需反汇编处理 RIP-relative 指令
2. Microsoft Detours 的 `.lib` 与 g++ ABI 不兼容
3. MinHook 引入外部依赖

**更巧妙的方案：直接改 Il2Cpp 方法表里的函数指针。**

```cpp
// 拿到 MethodInfo 表中 Update 函数的指针字段地址
uintptr_t* pp = ResolvePP("Assembly-CSharp","","GhostAI","Update",0);

// 保存原始值
g_OrigUpdate = *pp;

// 替换
DWORD old;
VirtualProtect(pp, 8, PAGE_READWRITE, &old);
*pp = (uintptr_t)HookedUpdate;
VirtualProtect(pp, 8, old, &old);
```

原理：Unity 每帧调 `Update()` 时从 `MethodInfo` 表读取指针后 `call`。替换后所有对原 `Update` 的调用自动流入 `HookedUpdate`，运行在**调用方所在线程（Unity 主线程）**。

### 命令队列模式

输入线程（后台）只写标志位，Hook 函数（主线程）只读标志位并执行：

```cpp
// === 输入线程（后台）===
if (GetAsyncKeyState(VK_F3)) g_Cmd = CMD_HUNT;

// === HookedUpdate（主线程）===
static void HookedUpdate(void* _this, void* mi) {
    int cmd = g_Cmd;
    g_Cmd = 0;

    switch (cmd) {
    case CMD_HUNT:
        ChangeState(_this, 2);        // 主线程安全！
        break;
    case CMD_APPEAR:
        Appear(_this, -1, nullptr);   // 主线程安全！
        break;
    }
    ((UpdateFn)g_OrigUpdate)(_this, mi);  // 别忘了调原始函数
}
```

---

## 第七步：Photon 网络方法的安全调用

### 房主权限

带 `[PunRPC]` 标记的方法和状态同步方法（如 `ChangeState`）会通过 Photon Network 广播。只有房主（MasterClient）才有权发起。

**所有这类方法调用前必须检查：**

```cpp
bool IsHost() {
    return PhotonNetwork_get_IsMasterClient(nullptr);
}
```

### 分级策略

| 操作 | 要求 | 非房主回退方案 |
|---|---|---|
| `ChangeState(Hunting)` | 必须是房主 | 无法回退，提示用户 |
| `ChangeState(Wander/Idle)` | 必须是房主 | **字段直写** `*(int*)(ptr+0x30)=1` |
| `Appear/UnAppear` | 无要求 | 不需要回退 |
| 速度/字段修改 | 无要求 | 不需要回退 |

字段直写的缺点：可能被下一帧的 `Update()` 覆盖（因为网络同步或逻辑条件不满足）。但作为非房主的本地回退方案，聊胜于无。

---

## 第八步：dump.cs 类型验证

**`dump.cs` 的反混淆器会猜错参数类型。** 以 `ChangeState` 为例：

```csharp
// dump.cs 的显示（错误）
public void ChangeState(GhostState, PhotonObjectInteract, bool = False) { }

// 实际 Il2Cpp 原生签名（正确）
void ChangeState(GhostAI*, int, void*, void*, MethodInfo*)
//                          state  ↑    ↑ 第三个参数是 void*，不是 bool！
```

传 `bool`（1 字节）替代 `void*`（8 字节）导致寄存器/栈对齐错乱 → 崩溃。

**铁律：如果有可参考的开源项目（如 PhasmoCheatV），以其 SDK 声明为准，dump.cs 仅作参考。**

---

## Hook 方案对比

| 方案 | 优点 | 缺点 | 推荐 |
|---|---|---|---|
| **MethodInfo 指针替换** | 零代码修改、跨编译器 | 仅限 Il2Cpp 方法 | ⭐⭐⭐ |
| Microsoft Detours | 处理 RIP-relative，SEH | MSVC only | ⭐⭐ |
| MinHook | g++ 兼容 | 外部依赖 | ⭐⭐ |
| 裸 detour patch | 无依赖 | **别用，会崩** | ✗ |

---

## 完整 Dump → 调用流程速查

```
1. Il2CppDumper → dump.cs（偏移量）、script.json（地址）
2. 运行时 GetModuleHandle("GameAssembly.dll")
3. GetProcAddress 解析 il2cpp_domain_get 等导出函数
4. assembly→image→class→method 链解析方法指针
5. il2cpp_string_new_utf16 创建 Unity 字符串
6. il2cpp_thread_attach 附加所有工作线程
7. FindGameObjectsWithTag + GetComponent 定位实例
8. 替换 MethodInfo->methodPointer 挂载 Update Hook
9. 命令队列：后台线程写标志 → Hook 主线程执行
10. IsMasterClient 检查后调用 Photon 方法
```

---

## 最容易被忽略的五个细节

1. **字符串创建必须用 UTF-16** — `il2cpp_string_new` 在 Il2Cpp 中的行为与 Mono 不同
2. **每个 CreateThread 都要 attach** — 遗忘导致 `R/W=0x0` 崩溃
3. **后台线程调 Photon 必死锁** — 必须是 Hook 的主线程上下文
4. **dump.cs 参数类型可能错误** — 参考开源 SDK 交叉验证
5. **非房主调 ChangeState 必炸** — 检测 `IsMasterClient` 是关键防护

---

## 结语

IL2CPP 游戏逆向的难点不在 dump 本身，而在"稳定地让游戏代码执行你想做的事"。这个框架把线程安全、方法调用、权限检查三大核心问题全部覆盖，换一个游戏、换一个目标类，整个流程可以直接套用。

> 本文对应的 Claude Code Skill 仓库：[BitterG/il2cpp-game-hacking-techniques-skill](https://github.com/BitterG/il2cpp-game-hacking-techniques-skill)
