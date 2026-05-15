---
title: "内核日志查看"
date: "2026-03-03"
updated: "2026-03-03T12:08:13.000Z"
category: "dbhknw"
tags: ["Android", "Kernel", "Linux"]
slug: "ken1tlqgm2iwkxud"
---

dmesg命令

```shell
oriole:/ # dmesg --help
Toybox 0.8.6-android multicall binary (see toybox --help)

usage: dmesg [-Cc] [-r|-t|-T] [-n LEVEL] [-s SIZE] [-w]

Print or control the kernel ring buffer.

-C      Clear ring buffer without printing	清除缓冲区
-c      Clear ring buffer after printing	输出后清除缓冲区
-n      Set kernel logging LEVEL (1-9)	设置日志等级
-r      Raw output (with <level markers>) 输出“原始格式”，带 <level> 前缀，例如 <3>[ 123.456789]
-S      Use syslog(2) rather than /dev/kmsg 通过 syslog 系统调用读取日志（不是直接读取 /dev/kmsg）
                                            某些受限系统中用它可绕过权限问题。
-s      Show the last SIZE many bytes	只显示最近 SIZE 字节的日志
-T      Human readable timestamps	把时间戳转换成人类可读的时间
-t      Don't print timestamps	不显示时间戳
-w      Keep waiting for more output (aka --follow)	实时监听日志输出，类似 tail -f/aka --follow

```

