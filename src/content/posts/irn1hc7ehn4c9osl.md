---
title: "内存的修改案例(hook)"
date: "2026-03-03"
updated: "2026-03-03T12:08:06.000Z"
category: "koo1se"
tags: ["eBPF", "Linux", "Kernel"]
slug: "irn1hc7ehn4c9osl"
---

```c
SEC("tracepoint/raw_syscalls/sys_exit")
int tracepoint__raw_syscalls__sys_exit(struct trace_event_raw_sys_exit *ctx) {
    struct event event = {};
    struct args_t *ap;
    uintptr_t stack[3];
    long int ret;
    u32 pid = bpf_get_current_pid_tgid();

    ap = bpf_map_lookup_elem(&start, &pid);
    if (!ap)
        return 0; /* missed entry */

    ret = ctx->ret;
    if (targ_failed && ret >= 0)
        goto cleanup; /* want failed only */

    /* event data */
    event.pid = bpf_get_current_pid_tgid() >> 32;
    event.uid = bpf_get_current_uid_gid();
    bpf_get_current_comm(&event.comm, sizeof(event.comm));

    event.ret = ret;
    event.sys_id = ap->sys_id;

    // 判断文件读取调用号
    //arm64: openat-56, read-63
    //x86_64: openat-257, read-0
    if (event.sys_id == 257) { //读取调用号
        //读取参数
        bpf_probe_read_user_str(&event.fname, sizeof(event.fname), (void *)ap->args[1]);
    } else if (event.sys_id == 0) {
        //read 内容
        bpf_probe_read_user_str(&event.fname, sizeof(event.fname), (void *)ap->args[1]);
        //修改内容
        if (event.fname[0] == 'a' && event.fname[1] == 'b' && event.fname[2] == 'c' && event.fname[3] == 'd') {
            event.fname[0] = 'd';
            event.fname[1] = 'c';
            event.fname[2] = 'b';
            event.fname[3] = 'a';
            event.fname[4] = '\0';
            bpf_probe_write_user((void *)(long)ap->args[1], (const void *)event.fname, (u32) 5);
        }
        
    }

    bpf_get_stack(ctx, &stack, sizeof(stack), BPF_F_USER_STACK);
    /* Skip the first address that is usually the syscall itself */
    event.callers[0] = stack[1];
    event.callers[1] = stack[2];

    /* emit event */
    bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU, &event, sizeof(event));

cleanup:
    bpf_map_delete_elem(&start, &pid);
    return 0;
}
```

使用bpf_probe_write_user将数据写回用户态内存，

这里是将原结果"abcd"修改为"dcba"写回

![](https://cdn.nlark.com/yuque/0/2025/png/25955198/1760792553037-56060f8b-e31b-4dff-937b-4714ca17cdc0.png)

