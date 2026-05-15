---
title: "Hello World模板"
date: "2026-03-03"
updated: "2026-03-03T12:08:06.000Z"
category: "koo1se"
tags: ["eBPF", "Linux", "Kernel"]
slug: "ppdppbnd89233how"
---

## 1.用户态代码
```c
#include <stdio.h>
#include <signal.h>
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include <unistd.h>

#include "hello_world.skel.h"

static volatile bool exiting = false;

static void sig_handler(int signo) {
    exiting = true;
}

int main(int argc, char **argv) {
    struct hello_world_bpf *skel;
    int err;
    //监听键盘
    //Ctrl + C
    signal(SIGINT, sig_handler);
    //系统或其他程序请求终止进程
    signal(SIGTERM, sig_handler);

    // 加载ebpf程序
    skel = hello_world_bpf__open_and_load();
    if (!skel) {
        fprintf(stderr, "Failed to open and load BPF skeleton\n");
        return 1;
    }
    // 附加ebpf程序
    err = hello_world_bpf__attach(skel);
    if (err) {
        fprintf(stderr, "Failed to attach BPF skeleton\n");
        goto cleanup;
    }
    printf("Successfully started!\n");
    while(!exiting) {
        sleep(1);
    }
    return 0;

    cleanup:
    //释放资源
    hello_world_bpf__destroy(skel);
    return err < 0 ? -err : err;

}
```

#include "hello_world.skel.h"需要先编译生成，先加入makefile文件

```makefile
...
APPS = \
      hello_world \
      ...
      $(BZ_APPS) \
...
```

这里通过bear插件完成编译 sudo bear -- make hello_world

## 2. 内核态代码
```c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

SEC("tracepoint/syscalls/sys_enter_execve")
int handle__sys_enter_execve(void *ctx) {
      bpf_printk("Hello, World! execve called\n");
      return 0;
}

// 证书
char _license[] SEC("license") = "GPL";
```

**tracepoint**：  
`/sys/kernel/debug/tracing/events/syscalls/sys_enter_execve`

 每次有进程调用 `execve()`（执行新程序）时，内核会触发这个 tracepoint，然后运行该函数。  

 参数 `ctx` 是上下文（tracepoint 的参数指针），这里没用到  

