---
title: "kpm模块helloWorld代码"
date: "2026-03-03"
updated: "2026-03-03T12:08:13.000Z"
category: "dbhknw"
tags: ["Android", "Kernel", "Linux"]
slug: "xcwvug2c91rt489z"
---

```c
/* SPDX-License-Identifier: GPL-2.0-or-later */
/* 
 * Copyright (C) 2023 bmax121. All Rights Reserved.
 */

#include <asm/current.h>
#include <compiler.h>
#include <kpmodule.h>
#include <linux/printk.h>
#include <common.h>
#include <kputils.h>
#include <linux/string.h>
#include <linux/cred.h>
#include <linux/sched.h>
#include <linux/uaccess.h>
#include <linux/pid.h>

///< The name of the module, each KPM must has a unique name.
KPM_NAME("kpm-hello-demo");

///< The version of the module.
KPM_VERSION("1.0.0");

///< The license type.
KPM_LICENSE("GPL v2");

///< The author.
KPM_AUTHOR("bmax121");

///< The description.
KPM_DESCRIPTION("KernelPatch Module Example");

/**
 * @brief hello world initialization
 * @details 
 * 
 * @param args 
 * @param reserved 
 * @return int 
 */
static long hello_init(const char *args, const char *event, void *__user reserved)
{
    pr_info("kpm hello init, event: %s, args: %s\n", event, args);
    pr_info("kernelpatch version: %x\n", kpver);
    return 0;
}
//定义函数指针类型
//它代表一种函数形式，task_pid_nr_ns_fn_t 是一种指向返回 pid_t 且带上述三个参数的函数指针类型
//关键字 返回值类型 函数指针名称(参数类型1, 参数类型2, ...);
typedef pid_t (*task_pid_nr_ns_fn_t)(struct task_struct *task, enum pid_type type, struct pid_namespace *ns);

task_pid_nr_ns_fn_t task_pid_nr_ns_fn = NULL;

//我的逻辑
static long hello_control0(const char *args, char *__user out_msg, int outlen)
{
    pr_info("kpm hello control0, args: %s\n", args);
    if (!task_pid_nr_ns_fn) {
        task_pid_nr_ns_fn = (task_pid_nr_ns_fn_t)kallsyms_lookup_name("__task_pid_nr_ns");
        pr_info("__task_pid_nr_ns %llx\n", task_pid_nr_ns_fn);
    }

    //获取进程pid和线程tgid
    struct task_struct *task = current;
    pid_t pid = -1, tgid = -1; 
    if (task_pid_nr_ns_fn) {
        pid = task_pid_nr_ns_fn(task, PIDTYPE_PID, 0);
        tgid = task_pid_nr_ns_fn(task, PIDTYPE_TGID, 0);
    }

    //获取uid
    uid_t uid = -1;
    struct cred *cred = *(struct cred **)((uintptr_t)task + task_struct_offset.cred_offset);
    if (cred) {
        uid = *(uid_t *)((uintptr_t)cred + cred_offset.uid_offset);
    }
    //获取进程名
    char proc_name[16] = {0};
    const char *comm = (const char *)((uintptr_t)task + task_struct_offset.comm_offset);
    if (comm) {
        strlcpy(proc_name, comm, sizeof(proc_name));
        proc_name[15] = 0;
    }

    pr_info("[kpm] Task | pid: %d, tgid: %d, uid: %d, proc_name: %s\n", pid, tgid, uid, proc_name);

    char echo[64] = "echo: ";
    strncat(echo, args, 48);
    compat_copy_to_user(out_msg, echo, sizeof(echo));
    return 0;
}

static long hello_control1(void *a1, void *a2, void *a3)
{
    pr_info("kpm hello control1, a1: %llx, a2: %llx, a3: %llx\n", a1, a2, a3);
    return 0;
}

static long hello_exit(void *__user reserved)
{
    pr_info("kpm hello exit\n");
    return 0;
}

KPM_INIT(hello_init);
KPM_CTL0(hello_control0);
KPM_CTL1(hello_control1);
KPM_EXIT(hello_exit);

```

使用make编译须先配置编译工具链(从armdeveloper下载)

```c
export TARGET_COMPILE=/home/kugua/arm-gnu-toolchain-14.3.rel1-x86_64-aarch64-none-elf/bin/aarch64-none-elf-
// 或者在MakeFile中加入变量不需要每次都设置👇
TARGET_COMPILE ?= /home/kugua/arm-gnu-toolchain-14.3.rel1-x86_64-aarch64-none-elf/bin/aarch64-none-elf-
```

```shell
dmesg -w -t | grep "kpm"
[+] KP D load_module_path: /data/user/0/me.bmax.apatch/kpm/xpcp.kpm
[+] KP D     name: kpm-hello-demo
[+] KP D     .kpm.info ffffffe7e2001132 67
[+] KP D     .kpm.ctl0 ffffffe7e2002008 8
[+] KP D     .kpm.ctl1 ffffffe7e2002010 8
[+] KP D     .kpm.exit ffffffe7e2002018 8
[+] KP D     .kpm.init ffffffe7e2002020 8
kpm hello init, event: load-file, args: (null)
[+] KP I load_module: [kpm-hello-demo] succeed with [(null)] 
[+] KP D get_module_info: name=kpm-hello-demo\x0aversion=1.0.0\x0alicense=GPL v2\x0aauthor=bmax121\x0adescription=KernelPatch Module Example\x0aargs=(null)
[+] KP I module_control0: name kpm-hello-demo, args: cccccc
kpm hello control0, args: cccccc
[kpm] Task | pid: 7629, tgid: 7570, uid: 10243, proc_name: DefaultDispatch
[+] KP I module_control0: name: kpm-hello-demo, rc: 0
```

