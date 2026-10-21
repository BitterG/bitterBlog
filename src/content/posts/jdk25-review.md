---
title: "重温 JDK 25 特性"
date: "2026-10-21"
updated: "2026-10-21T12:00:00.000Z"
category: "jvm"
tags: ["Java", "JDK 25", "LTS", "虚拟线程", "ScopedValue", "结构化并发", "StableValue"]
---

# 重温 JDK 25 特性

![重温 JDK 25 特性封面](/img/jvm/jdk25-review/cover.png)

本文章是根据我的学习和问题记录由AI整理生成

JDK 25 于 2025-09-16 正式发布，是继 JDK 21 之后的又一个 LTS。它一共包含 18 个 JEP，真正值得记住的主线只有三条：

- **并发闭环**：`ScopedValue` 转正（JEP 506），结构化并发第 5 次预览（JEP 505），和 JDK 21 已转正的虚拟线程组成一套完整的并发上下文方案。
- **语言易用性**：紧凑源文件与实例 `main`（JEP 512）、模块导入声明（JEP 511）、灵活构造器（JEP 513）全部转正。
- **JVM 与可观测性**：紧凑对象头（JEP 519）、AOT 缓存（JEP 514/515）、JFR 三项增强（JEP 509/518/520）。

## 1. 速览：18 个 JEP

别速览了，太多了 : (

## 2. 虚拟线程：不是 JDK 25 的新东西，但必须补课（看完不用这一块）

先纠正一个常见误解：**虚拟线程不是 JDK 25 的新特性**。它在 JDK 21 就以 JEP 444 正式落地了。JDK 25 的意义是把配套的 `ScopedValue` 转正、把结构化并发推进到第 5 次预览，让“虚拟线程三件套”真正能一起用。

### 2.1 先看它能干什么

20000 个任务，每个睡 1 秒：

```java
try (var executor = Executors.newVirtualThreadPerTaskExecutor()) {
    for (int i = 0; i < 20_000; i++) {
        executor.submit(() -> {
            Thread.sleep(Duration.ofSeconds(1));
            return null;
        });
    }
}
```

本机输出：

```text
20000 tasks on 20000 virtual threads, elapsed = 1142 ms
```

总耗时约 1.1 秒，不是 20000 秒。这里的关键不是“创建一个虚拟线程只要几纳秒”，而是**阻塞睡得起的线程变多了**。

| 维度 | 平台线程 | 虚拟线程 |
| --- | --- | --- |
| 调度者 | 操作系统 | JVM（ForkJoinPool carrier） |
| 栈 | 默认预留约 1 MB 地址空间 | 栈帧放在堆上，按需增长 |
| 阻塞 | 占着一个 OS 线程 | unmount，把 carrier 让出来 |
| 适用场景 | CPU 密集型 | IO 密集型、大量阻塞任务 |
| 池化 | 常用 | **不要池化** |
| 守护线程 | 可配置 | 固定为 daemon |

### 2.2 `start` 和 `unstarted` 的区别

```java
Thread a = Thread.ofVirtual().start(() -> System.out.println("run"));
Thread b = Thread.ofVirtual().unstarted(() -> System.out.println("run later"));

System.out.println(b.getState()); // NEW
b.start();                        // 现在才真正启动
b.join();
```

- `start(task)`：创建并立即启动，等价于 `unstarted(task).start()`。
- `unstarted(task)`：只创建线程对象，任务已绑定但还没跑，状态是 `NEW`。
- 线程只能 `start()` 一次。虚拟线程跑完即销毁，不能复用；要再跑就重新创建。
- `unstarted` 的用途是“先创建、后启动”：先做检查、注册、交给别的组件，或者延迟到某个条件满足再启动。

### 2.3 虚拟线程是谁的守护线程

答案是：**不是“谁的”，是 JVM 的。**

`daemon` 只是一个布尔属性，表示“不阻止 JVM 退出”，不表示线程从属关系。JDK 25 实测：

```java
Thread t = Thread.ofVirtual().unstarted(() -> {});
System.out.println(t.isDaemon());       // true
System.out.println(t.getThreadGroup()); // ThreadGroup[name=VirtualThreads,...]
try {
    t.setDaemon(false);
} catch (IllegalArgumentException e) {
    System.out.println("setDaemon(false) -> " + e.getClass().getSimpleName());
}
```

- 虚拟线程永远 daemon，`setDaemon(false)` 直接失败。
- `getThreadGroup()` 返回 `VirtualThreads`，但 `ThreadGroup` 只是历史遗留的分类容器，不是 owner。
- 真正调度它的是 JVM 的 carrier 线程池。虚拟线程阻塞时会被卸载，唤醒后可能换一个 carrier，所以它不“属于”任何平台线程。
- `main` 返回后 JVM 不会等虚拟线程跑完。需要等结果就 `join()`、`await()`，或者让 `ExecutorService.close()` 收口。

### 2.4 优势不只是“创建开销小”

这个说法容易被带偏。创建成本低只是附带效果，核心是**阻塞变便宜**：

- 平台线程一阻塞，就占着一个 OS 线程干等；虚拟线程阻塞时 unmount，carrier 转头去跑别的任务。
- 20000 个平台线程各睡 1 秒，瓶颈不是“上下文切换频率”——睡着的线程根本不参与调度。瓶颈是 20000 个 OS 线程的栈内存、内核结构和创建/销毁成本。
- 虚拟线程的 mount/unmount 是用户态操作，但要做 continuation 的冻结/解冻，栈越深越贵，**不一定比一次 OS 上下文切换便宜**。
- 虚拟线程是协作式的，不做时间片抢占。一个死循环的虚拟线程会一直占着 carrier，直到它阻塞。CPU 密集型任务不要指望它。

所以正确的预期是：**虚拟线程提升的是大量阻塞任务的吞吐和内存可扩展性，不是单个任务的延迟，也不是每次切换的纳秒数。**

### 2.5 钉住（pinning）

JDK 24 的 JEP 491 已经让 `synchronized` 块里的阻塞不再钉住 carrier，JDK 25 可以直接迁移老式同步代码。仍然会钉住的主要是 native 方法、FFI 调用等场景。排查时优先看 JFR、线程转储和 `-Xlog`；旧版常用的 `-Djdk.tracePinnedThreads` 在 JDK 24+ 已不是主要手段，是否还有输出以当前 JDK 文档为准。

如果你的虚拟线程池里大量任务卡在 native 调用上，carrier 被占满，吞吐会掉下来。这不是虚拟线程本身的问题，是底层阻塞点没有卸载。

## 3. ScopedValue：不可变、带作用域、自动失效

`ScopedValue` 在 JDK 25 转正（JEP 506）。它解决的是 `ThreadLocal` 的三个老问题：可变、生命周期不明确、跨线程继承成本高。

### 3.1 基本用法

```java
static final ScopedValue<String> USER = ScopedValue.newInstance();
static final ScopedValue<String> TRACE_ID = ScopedValue.newInstance();

ScopedValue.where(USER, "alice").run(() -> {
    System.out.println(USER.get()); // alice

    ScopedValue.where(USER, "bob").run(() -> {
        System.out.println(USER.get()); // bob，内层遮蔽
    });

    System.out.println(USER.get()); // alice，自动恢复
});

String result = ScopedValue.where(USER, "carol")
        .where(TRACE_ID, "trace-42")
        .call(() -> "handled by " + USER.get() + ", trace=" + TRACE_ID.get());
```

本机输出：

```text
bound before = false
outer binding: alice
inner binding: bob
restored: alice
bound after = false
handled by carol, trace=trace-42
get() outside scope -> NoSuchElementException
orElse outside scope = <anonymous>
```

### 3.2 API 清单

`ScopedValue<T>` 本身：

| 方法 | 说明 |
| --- | --- |
| `static <T> ScopedValue<T> newInstance()` | 创建 key，初始未绑定 |
| `static <T> Carrier where(ScopedValue<T>, T)` | 创建绑定载体，不执行代码 |
| `T get()` | 取当前作用域的值；未绑定抛 `NoSuchElementException` |
| `boolean isBound()` | 当前作用域是否绑定 |
| `T orElse(T other)` | 未绑定返回 `other`，`other` 不能为 null |
| `<X extends Throwable> T orElseThrow(Supplier<? extends X>)` | 未绑定抛自定义异常 |
| `int hashCode()` | 基于内部 key，日常基本不用 |

`ScopedValue.Carrier`：

| 方法 | 说明 |
| --- | --- |
| `Carrier where(ScopedValue<T>, T)` | 链式追加绑定，返回新 Carrier，原对象不变 |
| `void run(Runnable)` | 在绑定作用域内执行 |
| `<R, X extends Throwable> R call(CallableOp<? extends R, X>)` | 有返回值版本，可抛受检异常 |
| `<T> T get(ScopedValue<T>)` | 查询这个 Carrier 自己的绑定集合，不依赖当前线程 |

`ScopedValue.CallableOp<T, X extends Throwable>` 只有一个方法 `T call() throws X`。

### 3.3 几个必须记住的规则

- **没有 `set()`、没有 `remove()`**。值不可变，生命周期由 `run`/`call` 的动态作用域决定，离开作用域自动失效。
- **内层同名绑定是遮蔽**，不是修改。内层结束后外层值恢复。
- **`get()` 在作用域外抛异常**，所以常用 `orElse` 或 `orElseThrow` 兜底。
- **跨线程继承只支持 `StructuredTaskScope.fork()`**。普通 `new Thread(...)`、`Thread.ofVirtual().start(...)` 不会继承绑定。
- **值应该是不可变对象**。如果是可变对象，跨线程共享时仍然要自己同步。
- **`ScopedValue` 不是 `ThreadLocal` 的 drop-in replacement**。它只读、绑定范围明确，适合请求上下文、traceId、用户身份这类“一次绑定、整条调用链只读”的数据。

## 4. record 补课：它到底生成了什么（这次看完了我感觉我下次用也记不住）

record 不是 JDK 25 的新特性（JDK 16 正式），但结构化并发示例里用 `record Result(...)` 装返回值，学习时很容易把它和“普通类加 getter”混为一谈，这里单独补一节。

### 4.1 record 就是一个 final 类

```java
record Result(String service, String trace, boolean virtualThread) {}
```

编译产物是 `StructuredConcurrencyDemo$Result.class`（因为它是嵌套 record）。`javap` 看到的是：

```text
final class StructuredConcurrencyDemo$Result extends java.lang.Record {
  private final java.lang.String service;
  private final java.lang.String trace;
  private final boolean virtualThread;
  StructuredConcurrencyDemo$Result(java.lang.String, java.lang.String, boolean);
  public final java.lang.String toString();
  public final int hashCode();
  public final boolean equals(java.lang.Object);
  public java.lang.String service();
  public java.lang.String trace();
  public boolean virtualThread();
}
```

注意：示例里的 `call(...)` 是外层类 `StructuredConcurrencyDemo` 的静态方法，不是 `Result` 的成员。`record Result(...) {}` 的大括号已经闭合，`call` 只是返回 `Result`，不代表它属于 `Result`。

它自动生成了：

- 全参规范构造器；
- `private final` 字段；
- 与组件同名的访问器（不是 `getXxx()`，boolean 也不会变成 `isXxx()`）；
- `equals` / `hashCode` / `toString`；
- 隐式 `final`，并继承 `java.lang.Record`。

### 4.2 实例化时值就固定了

```java
record MyClass(String name, int age) {}

MyClass obj = new MyClass("Alice", 30);
System.out.println(obj.name()); // Alice
System.out.println(obj.age());  // 30
```

`new` 的那一刻，规范构造器把两个值写进 final 字段，之后没有 setter，也不能 `obj.name = "Bob"`。想改只能新建对象。

但要注意两点：

1. **允许 null**，除非你在构造器里校验。
2. **只是浅不可变**。`record MyClass(List<String> names)` 只保证 `names` 引用不变，不保证 list 内容不变。需要真不可变就用 `List.copyOf(...)` 做防御性拷贝。

### 4.3 修饰符位置

| 位置 | 可以写 | 不能写 |
| --- | --- | --- |
| 顶层 record 声明 | `public`、包私有、`final`（冗余） | `private`、`protected`、`static`、`abstract`、`sealed` |
| 嵌套 record 声明 | `public`/`protected`/`private`/包私有，`static` 可写可不写 | `abstract`、`sealed` |
| 组件（括号里） | 注解、最后一个组件的 `...` | `public`/`private`/`protected`/`final`/`static` |
| 类体成员 | 静态字段、方法、构造器、嵌套类型，访问修饰符按普通类规则 | 实例字段（任何修饰符都不行） |

几个实测结论：

- `record R(private int x) {}`：编译错误，记录组件不能有修饰符。
- `record R(int x) { private int y; }`：编译错误，字段必须是 static。
- `record R(int x) { private String x() { ... } }`：编译错误，访问器必须是 public。
- `public record R(int x) { R {} }`：编译错误，public record 的规范构造器必须 public。
- `final record R(int x) {}`：可以编译，但 final 本来就是隐式的。

### 4.4 紧凑构造器 (感觉这个用的比较少)

紧凑构造器是规范构造器的简写：不写参数列表，编译器自动补全参数，并在体尾补 `this.x = x`。

```java
record User(String name, int age, List<String> roles) {
    User {
        Objects.requireNonNull(name, "name must not be null");
        name = name.trim();
        if (age < 0 || age > 150) {
            throw new IllegalArgumentException("invalid age: " + age);
        }
        roles = List.copyOf(roles);
    }
}
```

编译器大致生成：

```java
User(String name, int age, List<String> roles) {
    // 你的校验、规范化、防御性拷贝
    name = name.trim();
    ...
    // 编译器在末尾补
    this.name = name;
    this.age = age;
    this.roles = roles;
}
```

规则和坑：

- 不能写参数列表；`User {` 才是紧凑构造器。
- 可以直接给参数重新赋值，最终字段用赋值后的值。
- 不能写 `this.name = name`；字段由编译器统一赋值。
- 不能 `return`，不能 `this(...)`。
- 不能加实例字段，静态字段可以。
- 访问修饰符不能比 record 更窄；`public record` 必须 `public User { ... }`。
- 一个 record 只能有一个规范构造器，紧凑构造器就是它。
- 它**不是无参构造器**，调用时仍然要传全部组件。

一句话：record 是“构造时赋值、之后只读”的不可变数据载体；紧凑构造器是字段落库前的校验和加工钩子。

## 5. 结构化并发：JDK 25 的 `Joiner` 形状

JDK 25 的结构化并发是 JEP 505，第 5 次预览。这个 API 和 JDK 21~24 的 `ShutdownOnFailure` / `ShutdownOnSuccess` 完全不同，网上很多旧教程不能直接抄。

### 5.1 一段能跑的示例

```java
static final ScopedValue<String> TRACE_ID = ScopedValue.newInstance();

record Result(String service, String trace, boolean virtualThread) {}

static Result call(String service, long delayMs) throws InterruptedException {
    Thread.sleep(delayMs);
    return new Result(service, TRACE_ID.orElse("none"),
            Thread.currentThread().isVirtual());
}

static void allSuccessful() throws InterruptedException {
    try (var scope = StructuredTaskScope.open(Joiner.<Result>allSuccessfulOrThrow())) {
        var users  = scope.fork(() -> call("users", 200));
        var orders = scope.fork(() -> call("orders", 300));

        scope.join();

        System.out.println("users  = " + users.get());
        System.out.println("orders = " + orders.get());
    }
}

static void failureCancelsSiblings() {
    try (var scope = StructuredTaskScope.open(Joiner.<Result>allSuccessfulOrThrow())) {
        var slow = scope.fork(() -> {
            try {
                return call("slow-service", 1500);
            } catch (InterruptedException e) {
                System.out.println("slow sibling was cancelled");
                throw e;
            }
        });

        var failing = scope.fork(() -> {
            Thread.sleep(100);
            throw new IllegalStateException("orders returned 500");
        });

        scope.join();
    } catch (FailedException e) {
        System.out.println("FailedException, cause = " + e.getCause());
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
    }
}
```

在 `ScopedValue` 作用域里调用：

```java
ScopedValue.where(TRACE_ID, "req-1001").call(() -> {
    allSuccessful();
    failureCancelsSiblings();
    return null;
});
```

输出：

```text
== all successful ==
users  = Result[service=users, trace=req-1001, virtualThread=true]
orders = Result[service=orders, trace=req-1001, virtualThread=true]
== failure cancels siblings ==
slow sibling was cancelled
FailedException, cause = java.lang.IllegalStateException: orders returned 500
```

### 5.2 JDK 25 的 API

| API | 作用 |
| --- | --- |
| `StructuredTaskScope.open(Joiner)` | 打开作用域，指定收口策略 |
| `scope.fork(Callable)` | 提交子任务，返回 `Subtask<T>`，默认跑在虚拟线程 |
| `scope.join()` | 等待收口；失败时抛 `FailedException` |
| `scope.close()` | 等所有子任务终止；`try-with-resources` 自动调用 |
| `Subtask.get()` | 取成功结果；状态不是 `SUCCESS` 时抛 `IllegalStateException` |
| `Subtask.exception()` | 取失败异常；状态不是 `FAILED` 时抛 `IllegalStateException` |
| `Subtask.state()` | `UNAVAILABLE` / `SUCCESS` / `FAILED` |
| `FailedException` | `join()` 抛出的异常，原始异常在 `getCause()` |

常用 `Joiner`：

| 工厂方法 | 行为 | `join()` 返回 |
| --- | --- | --- |
| `allSuccessfulOrThrow()` | 全部成功；任一失败取消其他并抛异常 | `Stream<Subtask<T>>` |
| `anySuccessfulResultOrThrow()` | 任一成功即返回，取消其他 | `T` |
| `awaitAllSuccessfulOrThrow()` | 等全部完成，失败则抛异常 | `Void` |
| `awaitAll()` | 等全部完成，不因失败提前退出 | `Void` |
| `allUntil(predicate)` | 自定义何时收网 | `Stream<Subtask<T>>` |

### 5.3 踩坑一：`fork` 是异步的

`fork` 提交任务后立刻返回 `Subtask`，任务体在另一个虚拟线程里跑。它不是 `CompletableFuture` 那种“放出去不管”的异步，而是**结构化的异步**：

- `fork` 不等待任务体；
- `join` 是同步点；
- `close` 等所有子任务终止；
- 子任务不能脱离 scope 生命周期。

所以下面这种写法没有意义：

```java
try {
    var users = scope.fork(() -> call("users", 500));
} catch (Exception e) {
    // 抓不到 users 里的异常
}
```

`fork` 只会在同步阶段抛异常（例如 scope 已关闭），子任务里的异常发生在另一个线程，最终在 `join()` 处变成 `FailedException`。

### 5.4 踩坑二：异常要 catch 在 `join()` 上

错误写法：

```java
try {
    var users = scope.fork(() -> call("users", 500));
    var orders = scope.fork(() -> {
        Thread.sleep(300);
        throw new IllegalStateException("orders returned 500");
    });
} catch (Exception e) {
    System.out.println("catch 不到");
}
```

正确写法：

```java
var users = scope.fork(() -> call("users", 500));
var orders = scope.fork(() -> {
    Thread.sleep(300);
    throw new IllegalStateException("orders returned 500");
});

try {
    scope.join();
} catch (FailedException e) {
    System.out.println("cause = " + e.getCause());
}
```

### 5.5 踩坑三：取消只作用于还在跑的子任务

如果 `users` 200ms 完成，`orders` 300ms 失败：

```text
t=200  users 已经 SUCCESS
t=300  orders 失败 -> scope 取消
```

`users` 已经完成，不会再被取消，状态仍是 `SUCCESS`。但 `join()` 会抛 `FailedException`，所以后面的 `users.get()` 不会执行。要在 catch 里自己查看：

```java
} catch (FailedException e) {
    System.out.println("users state  = " + users.state());   // SUCCESS
    System.out.println("orders state = " + orders.state());  // FAILED
    System.out.println("users result = " + users.get());     // 仍可读
}
```

如果 `users` 睡 500ms，`orders` 300ms 失败，`users` 还在跑，就会被取消：

- `Thread.sleep` 抛 `InterruptedException`；
- 子任务在 scope 取消后才结束，状态是 `UNAVAILABLE`；
- `users.get()` 抛 `IllegalStateException`，拿不到结果。

### 5.6 `allSuccessful` 和 `failureCancelsSiblings` 的区别

两个方法用的是同一个 `allSuccessfulOrThrow`，区别在子任务结果：

| 方法 | 子任务 | 结果 |
| --- | --- | --- |
| `allSuccessful` | 两个都成功 | `join()` 正常返回，打印两个结果 |
| `failureCancelsSiblings` | 一个慢任务 + 一个 100ms 后失败的任务 | 失败触发取消，慢任务被中断，`join()` 抛 `FailedException` |

`allSuccessful` 的重点是“全部成功才收口”；`failureCancelsSiblings` 的重点是“失败传播 + 自动取消兄弟任务”。两者都不是线程池的替代品，而是把子任务的生命周期绑定到代码块。

### 5.7 超时

JDK 25 用 `Configuration.withTimeout`：

```java
try (var scope = StructuredTaskScope.open(
        Joiner.<Result>anySuccessfulResultOrThrow(),
        cfg -> cfg.withTimeout(Duration.ofMillis(200)))) {

    scope.fork(() -> call("too-slow", 2000));
    Result result = scope.join();
}
```

超时后 `join()` 抛 `StructuredTaskScope.TimeoutException`。注意：这是 JDK 25 的异常类型；JDK 27 的 API 又变了，具体看上一篇，不要把两代代码混写。

## 6. StableValue：并发下只初始化一次

`StableValue` 是 JDK 25 的预览特性（JEP 502），解决的是“延迟初始化 + 线程安全 + 读取快”三个问题。它和 JDK 27 的 `LazyConstant` 目标相近，但 API 和状态不同，不能直接替换。

### 6.1 API 一览

| API | 说明 |
| --- | --- |
| `StableValue.of()` | 创建未设置的值 |
| `StableValue.of(value)` | 创建已设置的值 |
| `orElseSet(Supplier)` | 未设置则调用 supplier；并发下至多执行一次 |
| `setOrThrow(value)` | 设置值；已设置则抛 `IllegalStateException` |
| `trySet(value)` | 设置成功返回 true，已设置返回 false |
| `orElse(value)` / `orElseThrow()` / `isSet()` | 读取/判断 |
| `StableValue.list(n, fn)` / `map(keys, fn)` | 惰性集合，元素第一次访问时才计算 |
| `supplier(fn)` / `function(...)` / `intFunction(...)` | 包装成惰性函数 |

### 6.2 并发初始化

```java
static final StableValue<String> CONFIG = StableValue.of();

String value = CONFIG.orElseSet(() -> {
    supplierCalls.incrementAndGet();
    return "expensive-config";
});
```

100 个虚拟线程同时调用，输出：

```text
value = expensive-config
isSet = true, supplierCalls = 1
setOrThrow after set -> IllegalStateException
before access: calls = 0
get(2) = item-2, calls = 1
lazy list = [.unset, .unset, item-2, .unset]
```

`supplierCalls = 1` 说明并发下只有一个线程真正执行了初始化。之后 `orElseThrow()` 读取的是已经稳定的值，JIT 可以按常量优化。

### 6.3 为什么 `start.await()` 能一次放行所有线程

demo 里用了两个 `CountDownLatch`：

```java
CountDownLatch start = new CountDownLatch(1);
CountDownLatch done = new CountDownLatch(workers);

// worker
start.await();
try {
    CONFIG.orElseSet(...);
} finally {
    done.countDown();
}

// main
start.countDown();
done.await();
```

`start` 是发令枪，不是“每个线程一个许可”：

- `CountDownLatch(1)` 的计数是 1；
- `await()` 的条件是 `count == 0`，不是“轮到我了”；
- 主线程 `countDown()` 把 1 减到 0，**所有**等待者一起被放行；
- 实现上走 AQS 的共享模式：`releaseShared` 减到 0 后 `unpark` 整个等待队列；
- 虚拟线程在 `await()` 里 park 时会 unmount，不占 carrier；unpark 后重新挂到 carrier 上继续跑。

如果不用这个门闩，前面的 worker 可能已经把 `CONFIG` 初始化完，后面的线程才启动，根本测不到并发竞争。

注意 `start.await()` 在 demo 里放在 `try` 外面。如果它被中断，`done.countDown()` 不会执行，主线程会卡在 `done.await()`。更稳妥的写法是把它放进 `try`：

```java
executor.submit(() -> {
    try {
        start.await();
        CONFIG.orElseSet(...);
    } finally {
        done.countDown();
    }
    return null;
});
```

另外，`try-with-resources` 的 `executor.close()` 本身就会等所有任务结束，`done.await()` 有点冗余，但它的作用是让主线程在退出 try 块前明确等到全部完成，读起来更直观。

### 6.4 和 JDK 27 的 `LazyConstant` 怎么区分

| | JDK 25 `StableValue` | JDK 27 `LazyConstant` |
| --- | --- | --- |
| JEP | 502，预览 | 531，第 3 次预览 |
| 创建 | `StableValue.of()` | `LazyConstant.of(() -> ...)` |
| 读取 | `orElseThrow()` / `orElseSet(...)` | `get()` |
| 惰性集合 | `StableValue.list/map` | `List.ofLazy` / `Map.ofLazy` / `Set.ofLazy` |
| 定位 | 一次性初始化的稳定值 | 惰性常量，目标相近但 API 不同 |

两代代码不要混用。JDK 27 的 `LazyConstant` 用法在上一篇已经写过，这里只保留对比，不重复贴代码。

## 7. 语言易用性：三件套转正

### 7.1 紧凑源文件与实例 `main`（JEP 512）

文件里可以没有 `class` 声明，`main` 也不需要 `static`/`public`：

```java
// Hello.java
void main() {
    IO.println("Hello, JDK 25!");
    var langs = List.of("Java", "Kotlin", "Scala");
    langs.forEach(IO::println);
}
```

运行：

```bash
java Hello.java
```

输出：

```text
Hello, JDK 25!
Java
Kotlin
Scala
```

普通类也支持实例 `main`：

```java
public class InstanceMainDemo {
    private final String message = "instance main() works in a regular class";

    void main() {
        IO.println(message);
    }
}
```

`java.base` 被隐式导入，`List` 不用 import；`IO` 位于 `java.lang`。适合教学、脚本和小工具。

### 7.2 模块导入声明（JEP 511）

```java
import module java.base;
import module java.sql;

Map<String, Object> row = Map.of("id", 1, "name", "Alice");
System.out.println(DriverManager.class.getName());
System.out.println(Level.INFO.getName()); // 来自 java.sql 的传递依赖 java.logging
```

输出：

```text
JDBC entry point = java.sql.DriverManager
registered drivers = 0
logging level (transitive java.logging) = INFO
java.sql.Date = java.sql.Date
java.base date class = 2026-10-21
```

注意：`import module` 导入的是模块导出的包，不是“所有模块”。两个模块导出同名类时（例如 `java.sql.Date` 和 `java.util.Date`），仍然要用全限定名或单类型导入消歧。

### 7.3 灵活构造器主体（JEP 513）

`super(...)` 之前可以写前导语句：校验参数、声明局部变量、给本类字段赋值。

```java
final class EmailContact extends Contact {
    private final String address;

    EmailContact(String rawAddress) {
        String normalized = rawAddress == null ? "" : rawAddress.trim().toLowerCase();
        if (!normalized.contains("@")) {
            throw new IllegalArgumentException("invalid email: " + rawAddress);
        }
        this.address = normalized;   // 可以写自己的字段
        // String peek = this.address; // 但不能在读 super 之前读取

        super(normalized.substring(0, normalized.indexOf('@')));
    }
}
```

输出：

```text
Contact constructor: ada
EmailContact constructor body
ada <ada@example.com>
rejected before super(): invalid email: not-an-email
```

规则：可以写本类字段、可以校验、可以声明局部变量；不能读取 `this` 或本类字段，不能调用实例方法。非法参数在 `super()` 之前就被拒绝，不会构造出半成品对象。

### 7.4 原始类型模式（JEP 507，第 3 次预览）

JDK 25 的原始类型模式是第 3 次预览，`switch`/`instanceof` 可以直接匹配 `int`、`long`、`double`、`boolean`、`char`：

```java
static String describe(Object value) {
    return switch (value) {
        case null -> "null";
        case char c -> "char: " + c;             // char 必须先于 int
        case int i when i < 0 -> "negative int: " + i;
        case int i -> "int: " + i;
        case long l -> "long: " + l;
        case double d -> "double: " + d;
        case boolean b -> "boolean: " + b;
        default -> "other: " + value.getClass().getSimpleName();
    };
}
```

本机输出片段：

```text
int: 42
negative int: -7
long: 9000000000
double: 3.5
boolean: true
char: A
other: Float
instanceof int works: 100
```

注意 `case char c` 要放在 `case int i` 前面，因为 `char` 可以拓宽为 `int`；`case long` 只匹配 `Long`，不会把 `Integer` 当成 `long`。JDK 27 把这个特性推进到第 5 次预览，新增了更多安全窄化规则，完整示例看上一篇，这里不重复。

## 8. 安全与加密：PEM 与 KDF （这个看不懂O.o）

### 8.1 PEM API（JEP 470，预览）

```java
String publicPem = PEMEncoder.of().encodeToString(pair.getPublic());
String privatePem = PEMEncoder.of()
        .withEncryption("changeit".toCharArray())
        .encodeToString(pair.getPrivate());

PublicKey publicKey = PEMDecoder.of().decode(publicPem, PublicKey.class);
PrivateKey privateKey = PEMDecoder.of()
        .withDecryption("changeit".toCharArray())
        .decode(privatePem, PrivateKey.class);
```

输出：

```text
-----BEGIN PUBLIC KEY-----
-----BEGIN ENCRYPTED PRIVATE KEY-----
signature verifies = true
private key format = PKCS#8
wrong password -> IllegalArgumentException
```

以前要自己拼 Base64、处理头尾和加密私钥格式，现在一行 API 搞定。注意这是预览特性。

### 8.2 KDF API（JEP 510，正式）

JDK 25 正式提供 `javax.crypto.KDF`，支持 HKDF：

```java
KDF kdf = KDF.getInstance("HKDF-SHA256");

var rfcParams = HKDFParameterSpec.ofExtract()
        .addIKM(ikm)
        .addSalt(salt)
        .thenExpand(info, 42);

byte[] okm = kdf.deriveData(rfcParams);

byte[] sharedSecret = "ecdh-shared-secret".getBytes();
byte[] appSalt = "application-salt".getBytes();
byte[] context = "aes-256-gcm-key".getBytes();

var aesParams = HKDFParameterSpec.ofExtract()
        .addIKM(sharedSecret)
        .addSalt(appSalt)
        .thenExpand(context, 32);
SecretKey aesKey = kdf.deriveKey("AES", aesParams);
```

用 RFC 5869 Test Case 1 验证：

```text
RFC 5869 test case 1 matches = true
derived key algorithm = AES
derived AES key = 800c8c452063a89b945207d242ee3779ba44541c0abb58e407614f06ba532953
expand-only result = 6b2eb5efe1a64ced6d39ec35602f188f
```

KDF 是正式特性，不需要 `--enable-preview`。它适合从 ECDH 共享密钥派生 AES 密钥，替代手写 HKDF 的样板代码。

## 9. JVM：紧凑对象头、AOT、JFR（这一块其实我没怎么关注doge）

### 9.1 紧凑对象头（JEP 519）

JDK 25 里这是显式开启的产品特性：

```bash
java -Xmx1g -cp build CompactHeadersDemo
java -Xmx1g -XX:+UseCompactObjectHeaders -cp build CompactHeadersDemo
```

本机实测：

```text
4000000 objects, delta=92 MB, bytes/object=24.2
4000000 objects, delta=61 MB, bytes/object=16.1
```

对象头从 96 位压到 64 位，单对象约从 24.2 字节降到 16.1 字节。收益取决于对象布局和堆压力；开启前要在测试环境验证 JNI、`Unsafe`、序列化和内存分析工具。JDK 27 把这个特性变成默认启用（JEP 534），上一篇已经提过，这里只记录 25 的开关和实测。

### 9.2 AOT 缓存（JEP 514/515）

JDK 25 的一步式用法：

```bash
# 要求 classpath 是 JAR/模块路径；非空 class 目录会被跳过
jar --create --file build/aotdemo.jar -C build/12 AotDemo.class

# 训练运行 + 生成缓存
java -XX:AOTCacheOutput=build/app.aot -cp build/aotdemo.jar AotDemo

# 使用缓存，观察命中
java -XX:AOTCache=build/app.aot -Xlog:aot=info -cp build/aotdemo.jar AotDemo
```

AOT 缓存是环境绑定的产物：不要跨 JDK 版本、跨机器、跨 classpath 复用。把它当“可再生的加速缓存”，不要当发布物。JEP 515 让缓存携带方法 profile，启动后 JIT 能更快进入状态。

### 9.3 JFR 三项增强

方法计时/追踪（JEP 520）：

```bash
java -XX:StartFlightRecording:method-timing=JfrDemo::work,filename=timing.jfr JfrDemo
jfr view method-timing timing.jfr

java -XX:StartFlightRecording:method-trace=JfrDemo::work,filename=trace.jfr JfrDemo
jfr print --events jdk.MethodTrace trace.jfr
```

协作采样（JEP 518）降低了采样对应用的扰动；CPU-Time Profiling（JEP 509）是实验特性，主要在 Linux 上使用。方法过滤器要写 `Class::method`，不匹配时事件数为 0，这是实际踩过的坑。

### 9.4 分代 Shenandoah（JEP 521）

Windows 不支持，Linux 上使用：

```bash
java -XX:+UseShenandoahGC -XX:ShenandoahGCMode=generational -cp build AotDemo
```

### 9.5 Vector API（JEP 508，第 10 次孵化）

```bash
javac --add-modules jdk.incubator.vector -d build VectorApiDemo.java
java --add-modules jdk.incubator.vector -cp build VectorApiDemo
```

本机输出：

```text
species = Species[float, 8, S_256_BIT], lanes = 8
y[0] = 1.0 (expected 1.0)
dot = 999000.0, scalar = 999000.0, equal = true
```

仍是 incubator，API 可能变化。适合数值计算、图像处理、批量 SIMD 场景；普通业务代码不要为了“看起来快”硬上。

### 9.6 移除 32 位 x86（JEP 503）

JDK 25 移除了 32 位 x86 移植。构建脚本、CI、本地 native 库依赖都要检查位数；Windows 上只保留 x64/aarch64 等受支持平台。

## 10. 迁移与版本差异

### 10.1 JDK 25 的升级注意

1. **预览特性 class 文件绑定版本**：`--enable-preview` 编译出的 class 只能在 JDK 25 上跑，升级 JDK 后必须重新编译。
2. **结构化并发 API 大变**：JDK 21~24 的 `ShutdownOnFailure`、`ShutdownOnSuccess`、`throwIfFailed()` 在 JDK 25 不适用；改用 `Joiner` + `join()` + `FailedException`。
3. **ScopedValue 只在结构化并发中自动继承**：裸线程不继承，别把它当 `InheritableThreadLocal` 用。
4. **StableValue 和 LazyConstant 不要混用**：一个是 JDK 25 预览，一个是 JDK 27 预览，API 不同。
5. **AOT 缓存不可移植**：跨 JDK/机器/classpath 复用会失效，构建流水线里要可再生。
6. **紧凑对象头先测试**：JNI、`Unsafe`、序列化、内存分析工具都可能受影响。
7. **32 位 x86 已移除**：依赖 32 位 native 库的项目要先解决兼容性。

JDK 25 作为 LTS，真正值得投入时间的是三块：

- **并发**：虚拟线程解决“阻塞成本”，`ScopedValue` 解决“上下文传递”，结构化并发解决“子任务生命周期”。三者要一起理解，单独背 API 很容易写出 `fork` 外包 `try/catch` 这种无效代码。
- **语言**：紧凑源文件、模块导入、灵活构造器都是降低样板代码的实用特性，适合脚本、教学和小工具。
- **JVM**：紧凑对象头、AOT、JFR 是运维和性能层面的收益，升级前要做兼容性验证。

## 参考

- [OpenJDK JDK 25 Project](https://openjdk.org/projects/jdk/25/)
- [Oracle JDK 25 Release Notes](https://www.oracle.com/cn/java/technologies/javase/25all-relnotes.html)
- [JEP 506: Scoped Values](https://openjdk.org/jeps/506)
- [JEP 505: Structured Concurrency (Fifth Preview)](https://openjdk.org/jeps/505)
- [JEP 502: Stable Values (Preview)](https://openjdk.org/jeps/502)
- [JEP 512: Compact Source Files and Instance Main Methods](https://openjdk.org/jeps/512)
- [JEP 511: Module Import Declarations](https://openjdk.org/jeps/511)
- [JEP 513: Flexible Constructor Bodies](https://openjdk.org/jeps/513)
- [JEP 507: Primitive Types in Patterns, instanceof, and switch (Third Preview)](https://openjdk.org/jeps/507)
- [JEP 470: PEM Encodings of Cryptographic Objects (Preview)](https://openjdk.org/jeps/470)
- [JEP 510: Key Derivation Function API](https://openjdk.org/jeps/510)
- [JEP 519: Compact Object Headers](https://openjdk.org/jeps/519)
- [JEP 514: Ahead-of-Time Command-Line Ergonomics](https://openjdk.org/jeps/514)
- [JEP 515: Ahead-of-Time Method Profiling](https://openjdk.org/jeps/515)
- [JEP 518: JFR Cooperative Sampling](https://openjdk.org/jeps/518)
- [JEP 520: JFR Method Timing & Tracing](https://openjdk.org/jeps/520)
- [JEP 509: JFR CPU-Time Profiling (Experimental)](https://openjdk.org/jeps/509)
- [JEP 521: Generational Shenandoah](https://openjdk.org/jeps/521)
- [JEP 508: Vector API (Tenth Incubator)](https://openjdk.org/jeps/508)
- [JEP 503: Remove the 32-bit x86 Port](https://openjdk.org/jeps/503)
