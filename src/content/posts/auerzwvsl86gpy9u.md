---
title: "go文件映射"
date: "2026-04-13"
updated: "2026-04-13T16:17:27.000Z"
category: "kb"
tags: ["Go", "Golang"]
slug: "auerzwvsl86gpy9u"
---

```go
package main

import (
	"fmt"
	mmap "github.com/edsrzf/mmap-go"
	"os"
	"sync/atomic"
	"time"
	"unsafe"
)

func main() {

	f, err := os.OpenFile("test.txt", os.O_RDWR|os.O_CREATE, 0644)
	// 写入初始内容，前4字节必须是 0x00000000
	buf := make([]byte, 4)                           // 4字节零值锁
	buf = append(buf, []byte("Ciallo～(∠・ω< )⌒★")...) // 实际数据
	f.Write(buf)

	if err != nil {
		panic(err)
	}
	defer f.Close()

	m, err := mmap.Map(f, mmap.RDWR, 0)
	if err != nil {
		panic(err)
	}
	defer m.Unmap()

	for i := 0; i < 25; i++ {
		// 约定 m[0] 为锁标志位，用原子操作
		for !atomic.CompareAndSwapUint32((*uint32)(unsafe.Pointer(&m[0])), 0, 1) {
			time.Sleep(time.Millisecond)
		}
		m[4] = m[4] + byte(1)
		m.Flush()
		fmt.Println(string(m[4:]))
		//解锁
		atomic.StoreUint32((*uint32)(unsafe.Pointer(&m[0])), 0)
		time.Sleep(time.Second)
	}

	time.Sleep(100 * time.Second)
}

```

```go
package main

import (
	"fmt"
	"os"
	"time"

	mmap "github.com/edsrzf/mmap-go"
)

func main() {

	f, err := os.OpenFile("test.txt", os.O_RDWR|os.O_CREATE, 0644)
	if err != nil {
		panic(err)
	}
	defer f.Close()

	m, err := mmap.Map(f, mmap.RDWR, 0)
	if err != nil {
		panic(err)
	}
	defer m.Unmap()

	for {
		// 输出跳过前四个设定为锁标志位的数据
		fmt.Println("读取:", string(m[4:]))
		time.Sleep(time.Second)
	}

}

```

# Go 文件内存映射（mmap）笔记
## 1. 什么是 mmap
将文件映射到进程的虚拟内存空间，直接用指针/切片操作文件内容。

**优势：**

+ 避免内核→用户空间的数据拷贝
+ 按需加载（懒加载），内存占用低
+ 随机访问效率高（直接下标）
+ 多进程共享同一物理内存页
+ 写操作直接落盘

**不适合场景：**

+ 小文件（< 1MB）
+ 顺序一次性读取
+ 频繁追加写入
+ NFS 网络文件系统

---

## 2. Go 中使用 mmap
**推荐库（跨平台）：**

```bash
go get github.com/edsrzf/mmap-go
```

**基本用法：**

```go
// 只读
f, _ := os.Open("test.txt")
m, _ := mmap.Map(f, mmap.RDONLY, 0)
defer m.Unmap()

// 读写（必须用 OpenFile，不能用 Open）
f, _ := os.OpenFile("test.txt", os.O_RDWR, 0644)
m, _ := mmap.Map(f, mmap.RDWR, 0)
m[0] = 'B'
m.Flush() // 刷新到磁盘
```

**注意事项：**

+ `os.Open` 只读，写映射必须用 `os.OpenFile(..., os.O_RDWR, ...)`
+ 文件大小不能为 0，否则映射失败
+ `string(m[0])` 是错的（byte 转 string 得到 Unicode 码点），应用 `string(m[0:1])`

---

## 3. 多进程通信（mmap IPC）
多个进程映射同一文件，共享同一块物理内存页。

**文件布局约定：**

```plain
[0:4]   锁标志位（uint32，初始必须是数值 0）
[4:]    实际数据
```

**初始化文件：**

```go
buf := make([]byte, 4)                  // 4字节零值锁
buf = append(buf, []byte("实际数据")...)
f.Write(buf)
```

---

## 4. 自旋锁实现（跨平台）
```go
import (
    "sync/atomic"
    "time"
    "unsafe"
)

// 加锁（注意必须有 !）
for !atomic.CompareAndSwapUint32((*uint32)(unsafe.Pointer(&m[0])), 0, 1) {
    time.Sleep(time.Millisecond)
}

// 临界区操作（数据从 m[4] 开始）
m[4] = m[4] + 1
m.Flush()

// 解锁
atomic.StoreUint32((*uint32)(unsafe.Pointer(&m[0])), 0)
```

**CAS 原理：**

```plain
atomic.CompareAndSwapUint32(addr, old, new)
// if *addr == old { *addr = new; return true }
// else { return false }

加锁：m[0]==0(空闲) → CAS成功返回true → 取反false → 退出循环 → 拿到锁
等待：m[0]==1(已锁) → CAS失败返回false → 取反true → 继续循环等待
```

**常见错误：** 忘记 `!` 取反，导致拿到锁反而在睡觉，没拿到锁反而进入临界区。

---

## 5. 多 main 项目结构
```plain
myproject/
├── cmd/
│   ├── writer/
│   │   └── main.go
│   └── reader/
│       └── main.go
└── go.mod
```

```bash
go run ./cmd/writer
go run ./cmd/reader
go build ./cmd/writer
```

---

## 6. Windows 跨进程同步方案对比
| 方案 | 跨进程 | 复杂度 | 推荐度 |
| --- | --- | --- | --- |
| 自旋锁（标志位 + atomic） | 是 | 低 | ★★★ |
| 命名互斥量（windows.CreateMutex） | 是 | 中 | ★★★★ |
| 文件锁（LockFileEx） | 是 | 中 | ★★★ |
| `unix.Flock` | 否（Linux/macOS 专属） | 低 | - |


