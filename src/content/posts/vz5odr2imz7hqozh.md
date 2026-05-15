---
title: "内核代码符号修复"
date: "2026-03-03"
updated: "2026-03-03T12:08:13.000Z"
category: "dbhknw"
tags: ["Android", "Kernel", "Linux"]
slug: "vz5odr2imz7hqozh"
---

1.从手机中取出boot.img文件(如下)/从刷机包或官方镜像中解压出来

```shell
//查看分区与挂载信息
ls -l /dev/block/by-name/
lrwxrwxrwx 1 root root 16 2025-10-30 18:04 boot_a -> /dev/block/sdaXX
lrwxrwxrwx 1 root root 16 2025-10-30 18:04 boot_b -> /dev/block/sdaXX

//使用dd提取img
dd if=/dev/block/sdaXX of=/sdcard/boot.img
```

2.将提取的img从中取出kernel，这里使用magisk自带的magiskboot工具

```shell
magiskboot unpack boot.img
```

2.使用[https://github.com/marin-m/vmlinux-to-elf](https://github.com/marin-m/vmlinux-to-elf)修复符号

```shell
./vmlinux-to-elf <input_kernel.bin> <output_kernel.elf>
```

3.最终导出一个elf文件，可使用IDA查看

