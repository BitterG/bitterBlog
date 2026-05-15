---
title: "512字节栈内存限制解决"
date: "2026-03-03"
updated: "2026-03-03T12:08:06.000Z"
category: "koo1se"
tags: ["eBPF", "Linux", "Kernel"]
slug: "az4z67aslw2fg6la"
---

方案1.添加static关键字使用静态变量

```c
SEC("tracepoint/raw_syscalls/sys_exit")
int tracepoint__raw_syscalls__sys_exit(struct trace_event_raw_sys_exit *ctx) {
    static struct event event = {};	//添加static关键字
    ...
}
```

+ 该变量**不再分配在栈上**，而是被放在 **全局（BSS 或 DATA）段**。
+ eBPF verifier **不会把它算入栈空间**，所以绕过了 512B 限制。
+ 它在 **整个 eBPF 程序生命周期内只存在一份实例**（所有 CPU/线程共享）。

方案2.使用map将内存分配在堆上

```c
//定义一个map
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, u32);
    __type(value, struct event);
} envent_tmp SEC(".maps");

...
    
SEC("tracepoint/raw_syscalls/sys_exit")
int tracepoint__raw_syscalls__sys_exit(struct trace_event_raw_sys_exit *ctx) {
    // struct event event = {};
    //获取定义的map，使用map来替代event
    struct event *event;
    event = bpf_map_lookup_elem(&envent_tmp, &(u32){0});
    if (!event) return 0;

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
    event->pid = bpf_get_current_pid_tgid() >> 32;
    event->uid = bpf_get_current_uid_gid();
    bpf_get_current_comm(event->comm, sizeof(event->comm));

    event->ret = ret;
    event->sys_id = ap->sys_id;

    // 判断文件读取调用号
    //arm64: openat-56, read-63
    //x86_64: openat-257, read-0
    if (event->sys_id == 257) { //读取调用号
        //读取参数
        bpf_probe_read_user_str(event->fname, sizeof(event->fname), (void *)ap->args[1]);
    } else if (event->sys_id == 0) {
        //read 内容
        bpf_probe_read_user_str(event->fname, sizeof(event->fname), (void *)ap->args[1]);
        //修改内容
        if (event->fname[0] == 'a' && event->fname[1] == 'b' && event->fname[2] == 'c' && event->fname[3] == 'd') {
            event->fname[0] = 'd';
            event->fname[1] = 'c';
            event->fname[2] = 'b';
            event->fname[3] = 'a';
            event->fname[4] = '\0';
            bpf_probe_write_user((void *)(long)ap->args[1], (const void *)event->fname, (u32) 5);
        }
        
    }

    bpf_get_stack(ctx, &stack, sizeof(stack), BPF_F_USER_STACK);
    /* Skip the first address that is usually the syscall itself */
    event->callers[0] = stack[1];
    event->callers[1] = stack[2];

    /* emit event */
    bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU, event, sizeof(struct event));

cleanup:
    bpf_map_delete_elem(&start, &pid);
    return 0;
}
```

注意 使用自定义map替代event来使用，将从原event取对象的"."替换为从结构体指针去对象的"->"(语法问题)，不要使用&event,它本身就是指针，不要使用sizeof(event)结构体指针为定长，要使用sizeof(struct event)

