---
title: "epbf与用户态的数据读写/BPF maps"
date: "2026-03-03"
updated: "2026-03-03T12:08:06.000Z"
category: "koo1se"
tags: ["eBPF", "Linux", "Kernel"]
slug: "lo1gnm1c70f8sxc0"
---

 所有 perf buffer 和 ring buffer 本质上都是 BPF map 的一种特化形式

`ring buffer` 是 Linux 5.8+ 引入的新机制，用来**取代 perf buffer**  

| 对象 | 类型 | 作用 | 是否属于 map | 与用户态关系 |
| --- | --- | --- | --- | --- |
| `BPF_MAP_TYPE_HASH`<br/> 等 | 通用 map | 存储静态数据（key-value） | ✅ 是 | 用户态主动读写 |
| `BPF_MAP_TYPE_PERF_EVENT_ARRAY` | perf buffer map | 推送事件（旧） | ✅ 是 | 用户态被动回调 |
| `BPF_MAP_TYPE_RINGBUF` | ring buffer map | 推送事件（新） | ✅ 是 | 用户态轮询读取 |


## 1.BPF map
```c
/* SPDX-License-Identifier: (LGPL-2.1 OR BSD-2-Clause) */
#define BPF_NO_GLOBAL_DATA
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>

typedef unsigned int u32;
typedef int pid_t;

char LICENSE[] SEC("license") = "Dual BSD/GPL";

/*
定义一个 BPF map
type	BPF_MAP_TYPE_ARRAY 表示是一个数组 map（键是索引）
max_entries	表示数组长度为 1（即只有一个槽位）
key	类型为 u32，用于访问数组下标
value	类型为 pid_t（保存目标进程的 PID）
SEC(".maps")	表示这段数据放在 ELF 的 .maps 段中，libbpf 会自动加载它 
*/
struct {
    __uint(type, BPF_MAP_TYPE_ARRAY);
    __uint(max_entries, 1);
    __type(key, u32);
    __type(value, pid_t);
} my_pid_map SEC(".maps");

// 指定触发时机tracepoint write()
SEC("tp/syscalls/sys_enter_write")
int handle_tp(void *ctx) {
    u32 index = 0;
    // 获取前线程id
    pid_t pid = bpf_get_current_pid_tgid() >> 32;
    // 从struct my_pid_map获取pid，
    // 值是从用户程序中写入的bpf_map_update_elem(fd, &key, &pid, BPF_ANY);
    pid_t *my_pid = bpf_map_lookup_elem(&my_pid_map, &index);

    if (!my_pid || *my_pid != pid)
        return 1;

    bpf_printk("BPF triggered from PID %d.\n", pid);

    return 0;
}
```

```c
/* SPDX-License-Identifier: (LGPL-2.1 OR BSD-2-Clause) */
#include <stdio.h>
#include <unistd.h>
#include <sys/resource.h>
#include <bpf/libbpf.h>
#include "minimal_legacy.skel.h"

//日志回调函数
static int libbpf_print_fn(enum libbpf_print_level level, const char *format, va_list args)
{
	return vfprintf(stderr, format, args);
}

int main(int argc, char **argv)
{
    // 定义了 skeleton 实例 skel
	struct minimal_legacy_bpf *skel; // 由bpftool自动生成
	int err;
	pid_t pid;
	unsigned index = 0;

	// 设置之前定义的日志回调
	libbpf_set_print(libbpf_print_fn);

	// 打开并加载
	skel = minimal_legacy_bpf__open_and_load();
	if (!skel) {
		fprintf(stderr, "Failed to open and load BPF skeleton\n");
		return 1;
	}

	/* ensure BPF program only handles write() syscalls from our process */
	pid = getpid();
    // 写入数据
	err = bpf_map__update_elem(skel->maps.my_pid_map, &index, sizeof(index), &pid,
				   sizeof(pid_t), BPF_ANY);
	if (err < 0) {
		fprintf(stderr, "Error updating map with pid: %s\n", strerror(err));
		goto cleanup;
	}

	// 附加
	err = minimal_legacy_bpf__attach(skel);
	if (err) {
		fprintf(stderr, "Failed to attach BPF skeleton\n");
		goto cleanup;
	}

	printf("Successfully started! Please run `sudo cat /sys/kernel/debug/tracing/trace_pipe` "
	       "to see output of the BPF programs.\n");

	for (;;) {
		// 这里打印会触发write(),会触发内核自定义的trace point
		fprintf(stderr, ".");
		sleep(1);
	}

cleanup:
	minimal_legacy_bpf__destroy(skel);
	return -err;
}
```

![](https://cdn.nlark.com/yuque/0/2025/png/25955198/1760263673276-79103be0-0348-4a35-9ff2-37bd34ea18be.png)

查看对应的输出通道信息sudo cat /sys/kernel/debug/tracing/trace_pipe

![](https://cdn.nlark.com/yuque/0/2025/png/25955198/1760263706477-42693631-9af1-4f42-b350-8c32fc2b9966.png)

## 2.Perf Buffer
**监听系统调用 **`**execve**`** 的执行事件**（即当一个进程执行新程序时触发），并把相关信息（PID、进程名、执行的命令路径等）发送到用户空间。  

```c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
// 自定义发送到用户态的struct数据结构
#include "trans_data.h"

/*
perf event array 类型的 map，用于：
内核态 → 用户态 数据传输；
用户态通过 perf_buffer__new() 接收内核发来的事件。
每个 CPU 对应一个 entry，内核会根据当前 CPU 向相应 entry 写数据。
这类 map 通常搭配 bpf_perf_event_output() 使用。
*/
struct {
      __uint(type, BPF_MAP_TYPE_PERF_EVENT_ARRAY);
      __uint(key_size, sizeof(u32));
      __uint(value_size, sizeof(u32));
} events SEC(".maps");

//指定触发时机
SEC("tracepoint/syscalls/sys_enter_execve")
int handle__sys_enter_execve(struct trace_event_raw_sys_enter *ctx) {
      struct event event = {};
      u64 id = bpf_get_current_pid_tgid();
      event.pid = id >> 32;
      event.tgid = (u32)id;
      //获取进程名并存入
      bpf_get_current_comm(&event.comm, sizeof(event.comm));
      /*
      ctx->args[0] 是 execve(const char *filename, char *const argv[], char *const envp[])
      的第一个参数 → 可执行文件路径
      */
      char *name = (char *) ctx->args[0];
      // 存入执行程序的路径
      bpf_probe_read_user_str(&event.name, sizeof(event.name), name);

      // 发送到用户空间
      bpf_perf_event_output(ctx, &events, BPF_F_CURRENT_CPU, &event, sizeof(event));
      return 0;
}

// 证书
char _license[] SEC("license") = "GPL";
```

```c
struct event 
{
      __u32 pid;
      __u32 tgid;
      char comm[32];
      char name[32];
};
```

```c
#include <stdio.h>
#include <signal.h>
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include <unistd.h>

#include "trans_data.h"
#include "trans_data.skel.h"

static volatile bool exiting = false;

static void sig_handler(int signo) { exiting = true; }

// 接受数据的回调函数
static void handle_event(void *ctx, int cpu, void *data, __u32 size) {
      struct event *e = data;
      printf("PID: %d, TGID: %d, COMM: %s, NAME: %s\n", e->pid, e->tgid, e->comm, e->name);
}

int main(int argc, char **argv) {
      struct trans_data_bpf *skel;
      // 接收数据的api结构体
      struct perf_buffer *pb = NULL;
      int err;
      signal(SIGINT, sig_handler);
      signal(SIGTERM, sig_handler);

      // 加载ebpf程序
      skel = trans_data_bpf__open_and_load();
      if (!skel) {
            fprintf(stderr, "Failed to open and load BPF skeleton\n");
            return 1;
      }
      // 附加ebpf程序
      err = trans_data_bpf__attach(skel);
      if (err) {
            fprintf(stderr, "Failed to attach BPF skeleton\n");
            goto cleanup;
      }
      printf("Successfully started!\n");
      // 取出从内核发来的数据(需要传入回调函数来读取)
      pb = perf_buffer__new(bpf_map__fd(skel->maps.events), 8, handle_event, NULL, NULL, NULL);
      if (!pb) {
            fprintf(stderr, "Failed to open perf buffer\n");
            goto cleanup;
      }

      while(!exiting) {
            // 这里的时间为超时机制，防止卡死，内核事件驱动 + 超时机制
            // 调用系统调用 poll(时间) 等待内核事件
            err = perf_buffer__poll(pb, 100);
      }
      return 0;

      cleanup:
            // 释放 perf_buffer 资源
            perf_buffer__free(pb);
            trans_data_bpf__destroy(skel);
            return err < 0 ? -err : err;

}
```

## 3.Ring Buffer
与使用perf方式代码类似

```c
#include "vmlinux.h"
#include <bpf/bpf_helpers.h>
#include <bpf/bpf_tracing.h>
#include "trans_data.h"

/*
BPF_MAP_TYPE_RINGBUF 表示使用 环形缓冲区 map；
max_entries 表示缓冲区的大小（这里是 16MB）；
它的作用类似一个 共享内存区域，用于 eBPF 和用户态双向通信；
用户态通过 ring_buffer__poll() 等函数读取数据。
*/
struct {
      __uint(type, BPF_MAP_TYPE_RINGBUF);
      __uint(max_entries, 1 << 24); // 16MB
} events SEC(".maps");

SEC("tracepoint/syscalls/sys_enter_execve")
int handle__sys_enter_execve(struct trace_event_raw_sys_enter *ctx) {
      // 获取组装各种数据
      struct event event = {};
      u64 id = bpf_get_current_pid_tgid();
      event.pid = id >> 32;
      event.tgid = (u32)id;
      bpf_get_current_comm(&event.comm, sizeof(event.comm));
      char *name = (char *) ctx->args[0];
      bpf_probe_read_user_str(&event.name, sizeof(event.name), name);

      // 发送到用户空间
      // perf方式使用的是bpf_perf_event_output，参数略有区别
      bpf_ringbuf_output(&events, &event, sizeof(event), 0);
      return 0;
}

// 证书
char _license[] SEC("license") = "GPL";
```

| 特性 | perf buffer | ring buffer |
| --- | --- | --- |
| Map 类型 | `BPF_MAP_TYPE_PERF_EVENT_ARRAY` | `BPF_MAP_TYPE_RINGBUF` |
| 数据发送函数 | `bpf_perf_event_output()` | `bpf_ringbuf_output()` |
| 用户态读取函数 | `perf_buffer__poll()` | `ring_buffer__poll()` |
| 每 CPU 缓冲区 | ✅ | ❌（单一缓冲区） |
| 性能 | 一般 | 更高（零拷贝） |
| 内核要求 | 较低 | Linux ≥ 5.8 |


```c
#include <stdio.h>
#include <signal.h>
#include <bpf/libbpf.h>
#include <bpf/bpf.h>
#include <unistd.h>

#include "trans_data.h"
#include "trans_data_ring.skel.h"

static volatile bool exiting = false;

static void sig_handler(int signo) { exiting = true; }

// 接受数据的回调函数
// typedef int (*ring_buffer_sample_fn)(void *ctx, void *data, size_t size);
static int handle_event(void *ctx, void *data, size_t size) {
      struct event *e = data;
      printf("PID: %d, TGID: %d, COMM: %s, NAME: %s\n", e->pid, e->tgid, e->comm, e->name);
      return 0;
}


int main(int argc, char **argv) {
      struct trans_data_ring_bpf *skel;
      // 接收数据的api结构体
      struct ring_buffer *rb = NULL;
      int err;
      signal(SIGINT, sig_handler);
      signal(SIGTERM, sig_handler);

      // 加载ebpf程序
      skel = trans_data_ring_bpf__open_and_load();
      if (!skel) {
            fprintf(stderr, "Failed to open and load BPF skeleton\n");
            return 1;
      }
      // 附加ebpf程序
      err = trans_data_ring_bpf__attach(skel);
      if (err) {
            fprintf(stderr, "Failed to attach BPF skeleton\n");
            goto cleanup;
      }
      printf("Successfully started!\n");
      // 取出数据
      rb = ring_buffer__new(bpf_map__fd(skel->maps.events), handle_event, NULL, NULL);
      if (!rb) {
            fprintf(stderr, "Failed to open perf buffer\n");
            goto cleanup;
      }

      while(!exiting) {
            //这里为主动轮询查看缓冲区变化，是libbpf内部实现的循环机制
            err = ring_buffer__poll(rb, 100);
      }
      return 0;

      cleanup:
            // 释放 perf_buffer 资源
            ring_buffer__free(rb);
            trans_data_ring_bpf__destroy(skel);
            return err < 0 ? -err : err;
}
```

## 4.poll的差异
不是说perf和ring是被动回调和主动推送 为什么都是用xx__poll()在循环中?

`perf_buffer__poll()` 和 `ring_buffer__poll()` 的“poll”名字一样，但**语义不同**：

| 项目 | perf buffer | ring buffer |
| --- | --- | --- |
| 调用 `poll()`<br/> 的作用 | 让内核唤醒用户态（事件到达） | 主动检查共享内存中有没有新事件 |
| 数据传递方式 | 内核写入 + 唤醒 → 用户态读取 | 用户态主动读取共享缓冲区 |
| 回调触发方式 | 内核触发 → 回调 | 用户态循环检测 → 回调 |
| 行为模式 | 被动（事件驱动） | 主动（轮询读取） |


perf_buffer__poll(pb, 100) 这一步其实是调用了内核的 `poll()` 系统调用，意思是：

“我现在挂在这儿睡觉，有新事件到达时请唤醒我。”

因此它是 **被动唤醒机制**：

+ eBPF 内核端写入事件；
+ 内核唤醒 poll；
+ `perf_buffer__poll()` 调用你注册的回调 `handle_event()`；
+ 用户态被动地收到事件。

🧠 所以它看起来像“push”模型，但其实是**内核 push，用户 pull 回调**。



`ring_buffer__poll()`**不是** 内核 `poll()` 系统调用，而是 libbpf 内部做的轮询逻辑：

+ 每次检查 ring buffer 头尾指针；
+ 如果发现有新数据，就调用回调；
+ 如果没有，就 sleep 一下；
+ 然后继续下一轮。

所以它是一个 **主动拉取（polling）** 模型。

