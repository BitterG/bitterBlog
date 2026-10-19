---
title: "随便试试 JDK 27 新特性"
date: "2026-10-20"
updated: "2026-10-20T01:10:00.000Z"
category: "jvm"
tags: ["Java", "JDK 27", "预览特性", "模式匹配", "结构化并发"]
---

# 随便试试 JDK 27 新特性

![JDK 27 新特性封面](/img/jvm/jdk27-features/cover.png)

JDK 27 于 2026-09-15 发布（build 27+35），共包含 9 个 JEP。本文整理其中最值得学习的新用法，配上在 `27+35` 环境下跑通的小 demo，并附迁移注意事项。注意：JDK 27 **不是 LTS**，上一个 LTS 是 25，下一个是 29。全部示例代码均在本机验证运行。

## 环境

- JDK 版本：`java version "27" 2026-09-15`（Oracle JDK，build 27+35）
- 预览特性需加 `--enable-preview`：

```powershell
javac --release 27 --enable-preview -encoding UTF-8 -d out examples\XxxDemo.java
java  --enable-preview "-Dstdout.encoding=UTF-8" -cp out XxxDemo
```

## 0. 总览：9 个 JEP

| JEP | 名称 | 状态 |
| --- | --- | --- |
| [532](https://openjdk.org/jeps/532) | 模式匹配中的原始类型 | 第五次预览 |
| [531](https://openjdk.org/jeps/531) | 惰性常量 LazyConstant | 第三次预览 |
| [533](https://openjdk.org/jeps/533) | 结构化并发 | 第七次预览 |
| [537](https://openjdk.org/jeps/537) | Vector API | 第十二次孵化 |
| [527](https://openjdk.org/jeps/527) | TLS 1.3 后量子混合密钥交换 | 正式 |
| [538](https://openjdk.org/jeps/538) | PEM 编码 API | 第三次预览 |
| [523](https://openjdk.org/jeps/523) | G1 成为所有环境默认 GC | 正式 |
| [534](https://openjdk.org/jeps/534) | 紧凑对象头默认启用 | 正式 |
| [536](https://openjdk.org/jeps/536) | JFR 进程内数据脱敏 | 正式 |

## 1. 原始类型进入模式匹配（JEP 532）

### 背景：instanceof 和 switch 不认原始类型

Java 21 定稿的模式匹配只支持引用类型，窄化转换要手写范围检查：

```java
// 以前：手工保证不丢信息
int i = 1000;
if (i >= -128 && i <= 127) {
    byte b = (byte) i;
}
```

`switch` 也只认 `byte/short/char/int`，`long`、`float`、`boolean` 一律不行。

### 新写法：instanceof 变成"无损转换检查器"

```java
int i = 1000;
if (i instanceof byte b) {   // 转换安全才匹配，b 已就绪
    use(b);
} else {
    // 1000 超出 byte 范围，不匹配，自动走这里——永远不会悄悄丢数据
}

int big = 16_777_217;        // 2^24 + 1
boolean r1 = big instanceof float;    // false：int→float 在此值会丢精度
boolean r2 = big instanceof double;   // true：无条件精确
```

### 新写法：switch 支持全部原始类型

```java
// long switch：以前大常量只能 if-else
long v = 10_000_000_000L;
String desc = switch (v) {
    case 1L               -> "one";
    case 10_000_000_000L  -> "百亿";
    case long x when x < 0 -> "负数: " + x;
    case long x           -> "其他: " + x;
};

// boolean switch：比三元运算符强，分支里可以写语句
boolean loggedIn = false;
int userId = switch (loggedIn) {
    case true  -> 42;
    case false -> { log("未登录"); yield -1; }
};
```

### 新写法：记录模式支持安全窄化

```java
record JsonNumber(double d) {}
Object value = new JsonNumber(30.0);

// 以前：必须按 double 解构再手动强转（可能悄悄丢数据）
// JDK 27：double→int 无损时才匹配
if (value instanceof JsonNumber(int age)) {
    // age = 30，安全
}
// JsonNumber(30.5) 则不匹配 JsonNumber(int age)：30.5 无法无损转 int
```

运行输出（PrimitivePatternsDemo）：

```text
== instanceof 原始类型 ==
1000 instanceof byte -> 不匹配(1000 超出 byte 范围,窄化会丢信息)
16777217 instanceof float  -> false
16777217 instanceof double -> true
16777217 instanceof Integer -> true

== 记录模式安全窄化 ==
JsonNumber(30.0) 匹配 JsonNumber(int age), age = 30
JsonNumber(30.5) 不匹配 JsonNumber(int age):30.5 无法无损转 int

== long / boolean switch ==
百亿
(记录:未登录用户被拒绝)
userId = -1
```

## 2. 惰性常量 LazyConstant（JEP 531）

### 背景：final 与懒加载不可兼得

`final` 字段不可变、JIT 可常量折叠，但必须急切初始化；可变字段能懒加载，但线程不安全且 JIT 无法优化。双检锁正确但啰嗦。`LazyConstant` = final 的性能 + 懒加载的灵活性。

### 新写法

```java
import java.lang.LazyConstant;

static final LazyConstant<ExpensiveService> SERVICE =
        LazyConstant.of(() -> new ExpensiveService());
// 第一次 get() 才真正创建；并发 get() 也只执行一次（"赢家生效"）
```

配套懒集合三件套：`List.ofLazy`、`Map.ofLazy`、`Set.ofLazy`（最后一个 JDK 27 新增）。

### 踩坑：Map.ofLazy 只给 key，值哪去了

`Map.ofLazy` 第二个参数不是值，是"值的配方"（`Function`）。构造时只有键集就绪，每个键背后是一个待初始化的空盒子，第一次 `get(k)` 才用配方算值并封存。两个硬性要求：

1. 块体 lambda **所有路径都要 return**（`Function` 的普遍规则）；
2. **不能返回 null**（懒常量禁止 null），所以必须给键集里每个键兜底。

```java
// ❌ 编译不过：z 不是 "dev" 时没有返回值，也没覆盖其他键
Map.ofLazy(Set.of("dev", "prod"), z -> {
    if (z.equals("dev")) return "Asia/Shanghai";
});

// ✅ switch 表达式 + default 兜底
Map<String, String> zones =
        Map.ofLazy(Set.of("dev", "prod", "test", "kugua"), z -> {
            System.out.println("  (按需计算 " + z + " 的时区...)");
            return switch (z) {
                case "dev"  -> "Asia/Shanghai";
                case "prod" -> "UTC";
                case "test" -> "Europe/Berlin";
                default     -> "Asia/Tokyo";
            };
        });
```

运行输出（LazyConstantDemo）：

```text
程序启动... SERVICE 尚未初始化, initCount = 0
>> ExpensiveService 被创建(仅此一次)
两次并发 get() 后, initCount = 1
SERVICE.get() 返回同一实例: true

== 懒集合 ==
List.ofLazy: #1 号连接(惰性创建) / #1 号连接(惰性创建)
  (按需计算 dev 的时区...)
Map.ofLazy: dev   -> Asia/Shanghai
  (按需计算 kugua 的时区...)
Map.ofLazy: kugua -> Asia/Tokyo
```

`prod`/`test` 从没被 get 过，配方对它们一次都没执行——没用到就不付初始化成本，这正是 JEP 531 的动机：**启动性能**。

## 3. 结构化并发（JEP 533）

### 背景：ExecutorService 的线程泄漏

用 `ExecutorService` + `Future` 并发跑两个子任务：一个失败，另一个还在跑（线程泄漏）；父线程被中断不会传给子任务；线程转储里看不出任务间的父子关系。

### 新写法：子任务同生共死

```java
import java.util.concurrent.StructuredTaskScope;

Response handle() throws ExecutionException, InterruptedException {
    try (var scope = StructuredTaskScope.open()) {
        var user  = scope.fork(() -> findUser());     // 默认虚拟线程
        var order = scope.fork(() -> fetchOrder());
        scope.join();       // 任一失败 → 其余自动取消
        return new Response(user.get(), order.get());
    }   // close 保证所有子线程已终止
}
```

常用 Joiner 策略：`allSuccessfulOrThrow()`（全成才返回列表）、`anySuccessfulOrThrow()`（竞速，胜出即返回）。JDK 27 相对 26 的变化：新增第三个类型参数 `R_X`（join 可抛的异常类型）、`onTimeout()` 改名 `timeout()`、`awaitAll()` 移除。

```java
// 竞速：三个冗余镜像，最快的胜出，其余自动取消
try (var scope = StructuredTaskScope.open(Joiner.<String>anySuccessfulOrThrow())) {
    mirrors.forEach(scope::fork);
    return scope.join();
}

// 超时：200ms 内没跑完就取消全部子任务
try (var scope = StructuredTaskScope.open(
        Joiner.<String>allSuccessfulOrThrow(),
        cf -> cf.withTimeout(Duration.ofMillis(200)))) {
    scope.fork(() -> { Thread.sleep(5000); return "必然超时"; });
    scope.join();
}   // 抛 ExecutionException，cause 为 CancelledByTimeoutException
```

运行输出（StructuredConcurrencyDemo）：

```text
== 1. 全部成功 ==
组合结果: Response[user=alice, order=1001]

== 2. 失败自动取消兄弟任务 ==
捕获异常: 查询订单失败!
总耗时 0.1 秒(慢任务已被取消,没有线程泄漏)

== 3. 竞速(冗余服务) ==
胜出者: 镜像 B

== 4. 超时控制(JDK 27 的 timeout() 机制) ==
超时被取消: CancelledByTimeoutException (join 抛出,cause 为 CancelledByTimeoutException)
```

第 2 节的慢任务本来要跑 3 秒，兄弟任务 0.1 秒失败后它被立即取消——这就是"同生共死"。

## 4. 正式特性速览（升级即得，零代码改动）

- **后量子 TLS（JEP 527）**：`X25519MLKEM768` 混合组默认启用且最优先，防"先存储后解密"攻击。对端支持时 `javax.net.ssl` 应用自动用上。
- **G1 全环境默认（JEP 523）**：小内存/单核机器（容器小规格实例）不再回落 SerialGC。
- **紧凑对象头（JEP 534）**：对象头 96 位→64 位，堆更省；关闭用 `-XX:-UseCompactObjectHeaders`。
- **JFR 脱敏（JEP 536）**：录制默认抹掉命令行参数/环境变量/系统属性，`-XX:FlightRecorderOptions:redact-key=+*secret*` 可加自定义过滤器。
- **PEM API（JEP 538，预览）**：`PEMEncoder.of().encodeToString(key)` 一行搞定密钥 PEM 编解码，加密私钥往返三行。

## 5. 移除项与迁移注意

| 移除/变化 | 影响 |
| --- | --- |
| JVMCI / Graal JIT（`-XX:+UseGraalJIT` 等） | 用 Graal 的脚本失效，改用 GraalVM 发行版 |
| `-Xverify:none`、`-noverify` 等启动选项 | 启动报错，无替代 |
| `ThreadPoolExecutor.finalize()` | 覆写它的代码可能编译不过 |
| HttpServer 路径匹配 | `/foo` 不再匹配 `/foobar`（字符串前缀→路径段前缀） |
| ML-KEM/ML-DSA 私钥编码默认改 `seed` | JDK 27 生成的密钥旧 JDK 默认读不了，需互操作时设 `expandedKey` |
| `-XX:InitiatingHeapOccupancyPercent` | 改名 `-XX:G1IHOP`，旧名暂留为别名 |
| Windows 时区 ID | `TimeZone.getDefault()` 返回 `Asia/Kolkata` 等新 IANA ID |
