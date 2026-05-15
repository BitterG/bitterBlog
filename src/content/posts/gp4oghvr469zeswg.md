---
title: "1.修补过程"
date: "2026-03-03"
updated: "2026-03-03T12:08:13.000Z"
category: "dbhknw"
tags: ["Android", "Kernel", "Linux"]
slug: "gp4oghvr469zeswg"
---

1.bl锁开启

```shell
adb reboot bootloader

//fastboot模式下
fastboot flashing unlock
//部分设备 fastboot oem unlock
```

2.uname -a 查看内核版本是否满足4+或者5+之后一般都支持

3.zcat /proc/config.gz | grep CONFIG_KALLSYMS 查看属性保证开启

```shell
oriole:/ $ zcat /proc/config.gz | grep CONFIG_KALLSYMS
//保证以下属性为开启
CONFIG_KALLSYMS=y
CONFIG_KALLSYMS_ALL=y
```

4.下载apatch管理器(APK)在手机上安装 [https://github.com/bmax121/APatch/releases](https://github.com/bmax121/APatch/releases)

5.这里使用的是pixel6去谷歌官方下载镜像(注意和系统版本一致)，从中取出boot.img。将img推送到手机，使用apatch管理器进行修补并设置管理密码。

6.使用adb reboot bootloader进入fastboot模式，刷入修补后的.img文件并重启

7.打开apatch管理器输入之前设置的密码

![](https://cdn.nlark.com/yuque/0/2025/png/25955198/1761733380305-db4a76e9-ab2c-4bfa-b417-fcaff704dec4.png)



卸载方式:与安装类似，将未修补的原始boot.img文件刷入即可

