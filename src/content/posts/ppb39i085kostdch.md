---
title: "使用golang编写ebpf程序"
date: "2026-03-03"
updated: "2026-03-03T12:08:06.000Z"
category: "koo1se"
tags: ["eBPF", "Linux", "Kernel"]
slug: "ppb39i085kostdch"
---

使用项目 [https://github.com/cilium/ebpf](https://github.com/cilium/ebpf)

![](https://github.com/cilium/ebpf/raw/main/docs/ebpf/ebpf-go.png)

## 1.步骤
1.克隆项目 [https://github.com/cilium/ebpf](https://github.com/cilium/ebpf)

2.例子创建一个文件夹在ebpf/examples/test/

3.将examples/headers文件复制到/test/中，之后编译需要这些头文件

4.以examples中的kprobe为例复制到/test/中，只有kprobe.c和main.go是必要文件

其余为go generate生成的中间文件，可删除

5.使用gomod初始化项目go mod init 项目名(自定义写)，最终生成go.mod文件

  	例如go mod init kugua/ebpf-tools

6.执行go tidy下载需要依赖

7.执行go generate .完成中间文件生成

可能遇到bpf2go工具缺失可在go文件中替换//go:generate

```go
//go:generate go run github.com/cilium/ebpf/cmd/bpf2go@latest -tags linux bpf 对应c文件.c -- -I../headers
```

8.执行go build生成对应架构的二进制可执行程序

![](https://cdn.nlark.com/yuque/0/2025/png/25955198/1761045009728-874ef65c-5204-47c4-8888-7cd1e9ae5e8f.png)

## 2.附加
1.根据epbf-go文档[https://ebpf-go.dev/guides/portable-ebpf/](https://ebpf-go.dev/guides/portable-ebpf/)

在编译时加入参数生成arm64的可执行文件完成交叉编译

```go
CGO_ENABLED=0 GOARCH=arm64 go build
```

![](https://cdn.nlark.com/yuque/0/2025/png/25955198/1761044701949-eb59b14f-5fef-4746-988d-e232cfe8cf6b.png)

2.编写Makefile文件实现 generate/build/清理 一步到位 

```makefile
.PHONY: all build generate clean

# 二进制文件名
BIN := kprobe

all: generate build

generate:
	go generate ./...
build: generate
	CGO_ENABLED=0 GOARCH=arm64 go build -o $(BIN) .

clean:
	rm -f $(BIN)
	rm -f bpf_*.o
	rm -f bpf_*.go

```

![](https://cdn.nlark.com/yuque/0/2025/png/25955198/1761044970409-43025c12-724d-44bb-afed-6dd9cfd64e9c.png)

