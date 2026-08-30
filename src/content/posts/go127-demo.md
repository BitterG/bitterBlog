---
title: "Go 1.27 新特性 Demo 合集"
date: "2026-08-30"
updated: "2026-08-30T20:01:59.000Z"
category: "golang"
tags: ["Go", "Go 1.27", "泛型", "JSON", "uuid"]
---

# Go 1.27 新特性 Demo 合集

一组在 `go 1.27.0` 环境下跑通的小 demo，覆盖泛型方法/类型推断、新版 JSON API、嵌入字段初始化、标准库 `uuid`。全部代码均在本机验证运行。

## 环境

- Go 版本：`go1.27.0 windows/amd64`
- `go.mod`：`go 1.27.0`

## 1. 方法可以声明自己的类型参数（generic_methods）

### 背景：方法原来不能单独加泛型参数

泛型（类型参数）从 Go 1.18 起支持，但只允许加在**普通函数**或**结构体本身**上，给结构体绑定的**普通方法**不能拥有自己的独立泛型参数，否则编译报错：

```go
// 编译报错：methods cannot have type parameters
// func (m MyStruct) DoSomething[T any](val T) {
//     // ...
// }
```

### 新写法：方法泛型

Go 1.27 起方法可以声明自己的类型参数：

```go
package main

import "fmt"

type Box struct {
	Name string
}

// Go 1.27：方法可以声明自己的类型参数
func (b Box) Convert[T any](value T) T {
	fmt.Println("box:", b.Name)
	return value
}

func main() {
	box := Box{Name: "demo"}
	r1 := box.Convert(123)
	r2 := box.Convert("ciallo")
	fmt.Println(r1)
	fmt.Println(r2)
}
```

运行输出：

```text
box: demo
box: demo
123
ciallo
```

同一方法按调用时的实参自动推断 `T`：第一次是 `int`（123），第二次是 `string`（"ciallo"）。

## 2. 按目标函数类型推断类型参数（generic methods_type_Inference）

Go 1.27 还可以**根据目标函数类型推断**泛型参数：把泛型函数赋值给一个具体签名的变量时，`T` 会被自动推断出来，无需显式指定。

```go
package main

import "fmt"

type IntTransformer func(int) int

func Double[T ~int](i int) int {
	return i * 2
}

func Identity[T any](value T) T {
	return value
}

func main() {
	// Go 1.27 可以根据目标函数类型推断 T 为 int
	var intIdentity func(int) int = Identity

	// 也可以推断 T 为 string
	var stringIdentity func(string) string = Identity

	fmt.Println(intIdentity(100))
	fmt.Println(stringIdentity("hello"))

	// 还可以转换为自定义函数类型：
	IntTransformerDouble := IntTransformer(Double[int])
	fmt.Println(IntTransformerDouble(100))
}
```

运行输出：

```text
100
hello
200
```

`var intIdentity func(int) int = Identity` 一句中，目标类型 `func(int) int` 直接决定了 `T = int`，赋值处不需要写 `Identity[int]`。

## 3. encoding/json/v2（json_v2）

Go 1.27 正式提供新版 JSON API：

- `encoding/json/v2`：新版 JSON 编解码 API；
- `encoding/json/jsontext`：更底层的 JSON Token/Value 处理。

新版默认行为**更加严格**：

- 拒绝 JSON 字符串中的无效 UTF-8；
- 拒绝 JSON 对象中的重复字段名；
- API 支持更多可配置的 `Options`。

原有的 `encoding/json` 仍然继续支持，用户不需要立即迁移。官方说明中，旧包的底层实现也将由新版实现支撑，但会尽量保持原有行为兼容。

```go
package main

import (
	jsonv2 "encoding/json/v2"
	"fmt"
)

type User struct {
	Name  string `json:"name"`
	Age   int    `json:"age"`
	Score []int  `json:"score"`
}

func main() {
	user1 := User{
		Name:  "Alice",
		Age:   30,
		Score: []int{90, 85, 92},
	}
	data, err := jsonv2.Marshal(user1)
	if err != nil {
		fmt.Println("Error marshaling user:", err)
		return
	}
	fmt.Println(string(data))
}
```

运行输出：

```text
{"name":"Alice","age":30,"score":[90,85,92]}
```

## 4. 嵌入字段提升名直接初始化（struct_key_select）

Go 1.27 可以直接使用**嵌入字段提升后的字段名**来初始化结构体，不需要显式地写出嵌入字段的名称：

```go
package main

import "fmt"

type Device struct {
	DeviceType string
}

type NetWork struct {
	Device
	Host string
	Port int
}

type ServerConfig struct {
	NetWork
	Name string
}

func main() {
	// Go 1.27
	// 可以直接使用嵌入字段提升后的字段名来初始化结构体，
	// 而不需要显式地指定嵌入字段的名称。
	cfg := ServerConfig{
		DeviceType: "eth0",
		Host:       "localhost",
		Port:       8080,
		Name:       "api-server",
	}
	fmt.Printf("%+v\n", cfg) //%+v 结构体占位符号
}
```

运行输出：

```text
{NetWork:{Device:{DeviceType:eth0} Host:localhost Port:8080} Name:api-server}
```

`DeviceType` 是 `NetWork` 里嵌入的 `Device` 提升上来的字段，现在可以直接在 `ServerConfig` 的字面量里平铺写出，`Host`/`Port` 同理。

## 5. 标准库 uuid（uuid）

`uuid` 包进入 Go 标准库，直接 `import "uuid"` 即可生成/解析 UUID，无需第三方依赖：

```go
package main

import (
	"fmt"
	"uuid"
)

func main() {
	id := uuid.New()
	fmt.Println(id)

	parsed, err := uuid.Parse(id.String())
	if err != nil {
		panic(err)
	}
	fmt.Println(parsed == id)
}
```

运行输出（UUID 为随机值，每次不同）：

```text
e7962a88-df58-4710-8530-935f0a94e48c
true
```

`uuid.Parse` 解析回原值后与 `id` 相等（`true`）。

## 源码

demo 项目位于本地 `go27_test` 目录，每个特性一个独立子目录：

```
go27_test/
├── go.mod                          # go 1.27.0
├── generic_methods/                # 方法泛型
├── generic methods_type_Inference/ # 按目标函数类型推断类型参数
├── fan_xing/                       # 泛型基础（含方法限制说明）
├── json_v2/                        # encoding/json/v2
├── struct_key_select/              # 嵌入字段提升名初始化
└── uuid/                           # 标准库 uuid
```

运行方式：`go run .`（在对应子目录下）。

## 注意事项

- 若本机同时装有多个 Go 版本，注意 `GOROOT` 环境变量别指向旧版本：实测 `GOROOT` 指向 `go1.23.12` 时运行 `uuid` demo 会报 `package uuid is not in std`，因为旧版标准库还没有 `uuid`；将 `GOROOT` 指向 `go1.27.0` 即可正常运行。
- 目录名 `generic methods_type_Inference` 含空格，模块路径不能含空格，`go run .` 会报 `malformed import path`，需用 `go run main.go` 运行。
