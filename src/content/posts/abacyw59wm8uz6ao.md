---
title: "窗口绘制"
date: "2026-04-06"
updated: "2026-04-06T12:34:07.000Z"
category: "nohhgp"
tags: ["Windows", "DLL"]
slug: "abacyw59wm8uz6ao"
---

```plain
.386
.model flat, stdcall
option casemap:none
include D:\masm32\include\windows.inc
include D:\masm32\include\user32.inc
include D:\masm32\include\kernel32.inc
includelib D:\masm32\lib\user32.lib
includelib D:\masm32\lib\kernel32.lib

.const
szClassName     db 'MyClass', 0
szWindowName    db 'MyWindow', 0

.data?
hInstance       dd ?
hWinMain        dd ?

.code

; 窗口过程
_ProcWinMain proc hWnd:HWND, Msg:UINT, wParam:WPARAM, lParam:LPARAM
    cmp Msg, WM_DESTROY
    jne @default
    invoke PostQuitMessage, 0    ; ← 发送 WM_QUIT，让消息循环退出
    xor eax, eax
    ret
@default:
    invoke DefWindowProcA, hWnd, Msg, wParam, lParam
    ret
_ProcWinMain endp

; 主窗口函数
_WinMain proc
    local @nWndClass:WNDCLASSEXA
    local @nMsg:MSG

    ; 初始化结构体内存为0
    invoke RtlZeroMemory, addr @nWndClass, sizeof WNDCLASSEXA

    ; 获取实例句柄
    invoke GetModuleHandleA, NULL
    mov hInstance, eax

    ; 填充 WNDCLASSEXA 结构体
    mov @nWndClass.cbSize,          sizeof WNDCLASSEXA
    mov @nWndClass.style,           CS_HREDRAW or CS_VREDRAW
    mov @nWndClass.lpfnWndProc,     offset _ProcWinMain
    mov eax, hInstance
    mov @nWndClass.hInstance,       eax
    mov @nWndClass.hbrBackground,   COLOR_WINDOW + 1
    mov @nWndClass.lpszClassName,   offset szClassName

    ; 注册窗口类
    invoke RegisterClassExA, addr @nWndClass

    ; 创建窗口（用A版本，与RegisterClassExA匹配）
    invoke CreateWindowExA, WS_EX_CLIENTEDGE, offset szClassName, offset szWindowName,\
        WS_OVERLAPPEDWINDOW, 100, 100, 500, 400, NULL, NULL, hInstance, NULL
    mov hWinMain, eax

    ; 显示窗口
    invoke ShowWindow, hWinMain, SW_SHOWNORMAL
    invoke UpdateWindow, hWinMain

    ; 消息循环
    .while TRUE
        invoke GetMessageA, addr @nMsg, NULL, 0, 0
        .break .if eax == 0
        invoke TranslateMessage, addr @nMsg
        invoke DispatchMessageA, addr @nMsg
    .endw

    ret
_WinMain endp

_main proc
    call _WinMain
    invoke ExitProcess, NULL
_main endp

end _main
```

