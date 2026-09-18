---
title: "Steam 游戏 DLC 解锁原理：从 winmm.dll 代理到 SmokeAPI vtable Hook"
date: "2026-09-18"
updated: "2026-09-18T19:40:00.000Z"
category: "game-hacking"
tags: ["Steam", "SmokeAPI", "Koaloader", "DLC", "DLL Proxy", "vtable Hook", "逆向工程"]
---

# Steam 游戏 DLC 解锁原理：从 winmm.dll 代理到 SmokeAPI vtable Hook

![游戏目录中的 SmokeAPI 与 Koaloader DLL](/img/game-hacking/smokeapi-dlc-unlock/cover.png)

> 目标：以《雨中冒险 2》为例，搞清楚为什么只放 `smoke_api64.dll` 和 `winmm.dll` 两个文件，就能让 Steam 游戏把未购买的 DLC 识别为已解锁。
> 核心结论：`winmm.dll` 来自 Koaloader，是一个 DLL 代理/加载器；`smoke_api64.dll` 来自 SmokeAPI，在运行时 hook `steamclient.dll` 并替换 Steam 接口的 vtable 函数。

项目仓库：

- [acidicoala/SmokeAPI](https://github.com/acidicoala/SmokeAPI)
- [acidicoala/Koaloader](https://github.com/acidicoala/Koaloader)

---

## 一、现象：两个 DLL 就能解锁 DLC

把下面两个文件放到游戏根目录：

```text
Risk of Rain 2/
├── smoke_api64.dll
└── winmm.dll
```

其中 `winmm.dll` 来自 Koaloader，`smoke_api64.dll` 来自 SmokeAPI。游戏启动后，Steam 的 DLC 查询被 SmokeAPI 包装过，最终告诉游戏“这些 DLC 已经可用”。

## 二、为什么 `winmm.dll` 会被自动加载

先用 PE 工具看游戏本体 `Risk of Rain 2.exe` 的导入表。

![Risk of Rain 2.exe 的导入表](/img/game-hacking/smokeapi-dlc-unlock/game-exe-imports.png)

这个启动器很干净，只导入了 `UnityPlayer.dll` 和 `KERNEL32.dll`。继续看 `UnityPlayer.dll`，里面导入了大量系统 DLL，其中就包括 `WINMM.dll`。

![UnityPlayer.dll 的 WINMM.dll 导入](/img/game-hacking/smokeapi-dlc-unlock/unityplayer-winmm-imports.png)

Windows 加载 `UnityPlayer.dll` 时，会按 DLL 搜索顺序找 `winmm.dll`。游戏根目录里的 `winmm.dll` 会被优先命中，因此 Koaloader 被当成系统多媒体 DLL 加载。

这个 `winmm.dll` 不是普通 DLL，而是一个 proxy：它把原版 `winmm.dll` 的导出全部转发给系统目录里的真实 `winmm.dll`，所以游戏的多媒体功能不会坏，同时它的 `DllMain` 会执行 Koaloader 逻辑。

实际加载链是：

```text
Risk of Rain 2.exe
  -> UnityPlayer.dll
    -> winmm.dll (Koaloader proxy)
      -> smoke_api64.dll (auto_load=true，无需 Koaloader.config.json)
```

## 三、Koaloader 如何把 SmokeAPI 拉起来

Koaloader 的入口在 `src/main.cpp`：

```cpp
DLL_EXPORT(BOOL) DllMain(const HMODULE module_handle, const DWORD reason, LPVOID) {
    if (reason == DLL_PROCESS_ATTACH) {
        koaloader::init(module_handle);
    } else if (reason == DLL_PROCESS_DETACH) {
        koaloader::shutdown();
    }

    return TRUE;
}
```

`koaloader::init()` 解析配置后进入 `auto_load` 模式，扫描当前目录和父目录里的 `.dll`，其中“知名模块”列表包含：

```text
SmokeAPI.dll
SmokeAPI64.dll
smoke_api.dll
smoke_api64.dll
...
```

扫到 `smoke_api64.dll` 后执行 `LoadLibrary`。于是 SmokeAPI 的 `DllMain` 被触发，真正开始 hook Steam。

## 四、SmokeAPI 的启动流程

Windows 下 SmokeAPI 的入口位于 `src/main_win.cpp`：

```cpp
DLL_MAIN(void* handle, const uint32_t reason, void*) {
    if(reason == DLL_PROCESS_ATTACH) {
        smoke_api::init(handle);
    } else if(reason == DLL_PROCESS_DETACH) {
        smoke_api::shutdown();
    }

    return TRUE;
}
```

`smoke_api::init()` 主要做这些事：

1. 解析配置文件。
2. 初始化日志。
3. 调用 `kb::hook::init(true)`，注册 PolyHook2 日志器。
4. 判断运行模式：因为目录里同时存在原始 `steam_api64.dll` 和独立的 `smoke_api64.dll`，所以走 hook mode。
5. 注册 DLL 加载监听，等待 `steamclient.dll` 被加载。

```cpp
void init(void* self_module_handle) {
    // ...
    kb::globals::init_globals(self_module_handle, PROJECT_NAME);

    // 解析配置文件
    config::get() = kb::config::parse<config::Config>();

    // ...

    // 初始化 PolyHook2 / KoalaBox hook 封装
    kb::hook::init(true);

    // 当前目录同时存在 steam_api64.dll 和 smoke_api64.dll，所以是 hook mode
    if(kb::hook::is_hook_mode(self_module_handle, STEAM_API_MODULE)) {
        LOG_INFO("Detected hook mode");
        init_hook_mode(self_module_handle);
    } else {
        LOG_INFO("Detected proxy mode");
        init_proxy_mode(self_module_handle);
    }

    // 监听 steamclient.dll
    init_lib_monitor();

    // ...
}
```

## 五、拦截 `steamclient.dll` 的 `CreateInterface`

SmokeAPI 并没有修改 `steam_api64.dll`，而是等 `steamclient.dll` 加载后，先 detour 它的 `CreateInterface`。

`init_lib_monitor()` 注册回调：

```cpp
void init_lib_monitor() {
    kb::lib_monitor::init_listener({{STEAMCLIENT_DLL, on_steamclient_loaded}});
}
```

`on_steamclient_loaded()` 中关键一步是：

```cpp
bool on_steamclient_loaded(void* steamclient_handle) {
    // 先 detour 原版 steamclient.dll 的 CreateInterface
    KB_HOOK_DETOUR_MODULE(CreateInterface, steamclient_handle);

    // ...
}
```

SmokeAPI 提供自己的替代版 `CreateInterface`：

```cpp
C_DECL(void*) CreateInterface(const char* interface_version, create_interface_result* out_result) {
    static std::mutex section;
    const std::lock_guard lock(section);

    static std::once_flag once_flag;
    std::call_once(once_flag, smoke_api::post_init);

    return steam_client::GetGenericInterface(
        __func__,
        interface_version,
        [&] {
            static const auto CreateInterface$ = KB_HOOK_GET_HOOKED_FN(CreateInterface);
            return CreateInterface$(interface_version, out_result);
        }
    );
}
```

这里的关键是：lambda 里的 `CreateInterface$` 是 detour 后保存的 trampoline，也就是真正的 `steamclient.dll!CreateInterface`。SmokeAPI 先调用原函数拿到 Steam 接口对象，再对这个对象做 vtable hook。

`steam_client::GetGenericInterface()` 负责调用原函数，并交给 `hook_virtuals()` 处理：

```cpp
void* GetGenericInterface(
    const std::string& function_name,
    const char* interface_version,
    const std::function<void*()>& original_function
) noexcept {
    auto* const interface = original_function();

    if(interface_version && interface) {
        steam_interfaces::hook_virtuals(interface, interface_version);
    }

    return interface;
}
```

## 六、vtable Hook：把 Steam 查询函数换成 SmokeAPI 包装函数

`hook_virtuals()` 会遍历 `get_virtual_hook_map()`，按接口版本找到要替换的函数，然后调用：

```cpp
kb::hook::swap_virtual_func(
    interface_ptr,
    entry.function_name,
    lookup.at(function),
    entry.function_address
);
```

四个参数分别是：

- `interface_ptr`：当前 Steam 接口对象，例如 `ISteamApps` 实例。
- `entry.function_name`：例如 `"ISteamApps_BIsDlcInstalled"`。
- `lookup.at(function)`：从 `res/interface_lookup.json` 查到的 vtable 序号，例如 `BIsDlcInstalled` 是 `7`。
- `entry.function_address`：SmokeAPI 包装函数的地址。

函数地址来自这个宏：

```cpp
#define ENTRY(INTERFACE, FUNC) \
    { \
        #FUNC, { \
            #INTERFACE "_" #FUNC, reinterpret_cast<void*>(INTERFACE##_##FUNC) \
        } \
    }
```

例如：

```cpp
ENTRY(ISteamApps, BIsDlcInstalled),
```

展开后等价于：

```cpp
{
    "BIsDlcInstalled",
    {
        "ISteamApps_BIsDlcInstalled",
        reinterpret_cast<void*>(ISteamApps_BIsDlcInstalled)
    }
}
```

也就是说，`ISteamApps_BIsDlcInstalled` 是 C++ 编译期符号，链接器会把它接到 `isteamapps.cpp` 中定义的函数，最后 `swap_virtual_func` 把地址写进 Steam 接口的 vtable。

`swap_virtual_func` 不在 SmokeAPI 本体里，它在 KoalaBox 中，底层使用 PolyHook2 的 `PLH::VFuncSwapHook`，本质就是替换 `vtable[ordinal]`。

对应的 SmokeAPI 包装函数如下：

```cpp
VIRTUAL(bool) ISteamApps_BIsSubscribedApp(PARAMS(const AppId_t dlc_id)) noexcept {
    return smoke_api::steam_apps::IsDlcUnlocked(
        __func__,
        smoke_api::get_app_id(),
        dlc_id,
        SWAPPED_CALL_CLOSURE(ISteamApps_BIsSubscribedApp, ARGS(dlc_id))
    );
}

VIRTUAL(bool) ISteamApps_BIsDlcInstalled(PARAMS(const AppId_t dlc_id)) noexcept {
    return smoke_api::steam_apps::IsDlcUnlocked(
        __func__,
        smoke_api::get_app_id(),
        dlc_id,
        SWAPPED_CALL_CLOSURE(ISteamApps_BIsDlcInstalled, ARGS(dlc_id))
    );
}

VIRTUAL(int) ISteamApps_GetDLCCount(PARAMS()) noexcept {
    return smoke_api::steam_apps::GetDLCCount(
        __func__,
        smoke_api::get_app_id(),
        SWAPPED_CALL_CLOSURE(ISteamApps_GetDLCCount, ARGS())
    );
}

VIRTUAL(bool) ISteamApps_BGetDLCDataByIndex(
    PARAMS(
        const int iDLC,
        AppId_t* p_dlc_id,
        bool* pbAvailable,
        char* pchName,
        const int cchNameBufferSize
    )
) noexcept {
    return smoke_api::steam_apps::GetDLCDataByIndex(
        __func__,
        smoke_api::get_app_id(),
        iDLC,
        p_dlc_id,
        pbAvailable,
        pchName,
        cchNameBufferSize,
        SWAPPED_CALL_CLOSURE(
            ISteamApps_BGetDLCDataByIndex,
            ARGS(iDLC, p_dlc_id, pbAvailable, pchName, cchNameBufferSize)
        ),
        SWAPPED_CALL_CLOSURE(
            ISteamApps_BIsSubscribedApp,
            ARGS(*p_dlc_id)
        )
    );
}
```

## 七、真正决定 DLC 是否解锁的逻辑

`ISteamApps_BIsSubscribedApp` 和 `ISteamApps_BIsDlcInstalled` 最终都调用：

```cpp
bool IsDlcUnlocked(
    const std::string& function_name,
    const AppId_t app_id,
    const AppId_t dlc_id,
    const std::function<bool()>& original_function
) noexcept {
    // 按照配置文件设置 id 对应的 DLC 是否解锁
    const auto unlocked = config::is_dlc_unlocked(
        app_id,
        dlc_id,
        original_function
    );

    // ...
    return unlocked;
}
```

`GetDLCDataByIndex` 则用来枚举每个 DLC。关键写入点在 `output_dlc` lambda 中：

```cpp
const auto output_dlc = [&](const DLC& dlc) {
    *pDlcId = dlc.get_id();

    // 这里就是真正设置了 DLC 的启用状态
    *pbAvailable = config::is_dlc_unlocked(app_id, *pDlcId, is_originally_unlocked);

    const auto& name = dlc.get_name();

    const auto bytes_to_copy = std::min(static_cast<size_t>(cchNameBufferSize - 1), name.size());
    std::memcpy(pchName, name.c_str(), bytes_to_copy);
    pchName[bytes_to_copy] = '\0';
};
```

默认配置中：

```cpp
AppStatus default_app_status = AppStatus::UNLOCKED;
```

所以 `config::is_dlc_unlocked` 默认走 `UNLOCKED` 分支：

```cpp
switch(status) {
    case AppStatus::UNLOCKED: // 默认就进这个分支
        is_unlocked = true;
        break;
    // ...
}
```

## 八、总结

- Steam 游戏调 `BGetDLCDataByIndex(iDLC, ..., pbAvailable, ...)` 来枚举 DLC。
- SmokeAPI 在 `get_app_dlc_map()` 中有对应 app 的 DLC 列表时，走 `output_dlc`。
- `*pbAvailable` 被写成 `config::is_dlc_unlocked` 的返回值。
- 默认配置下 `default_app_status = AppStatus::UNLOCKED`，因此未购买的 DLC 也会被标记为可用。
- 整个过程没有修改 `steam_api64.dll`，而是在运行时替换 `steamclient.dll` 接口对象的 vtable。

更准确地讲，SmokeAPI 做的是“在正确的时机，把游戏对 Steam 的 DLC 查询请求转发到自己的包装函数，再按配置返回结果”。