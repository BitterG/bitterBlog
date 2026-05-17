---
title: "对象内存布局"
date: "2026-05-15"
updated: "2026-05-15T01:35:01.523Z"
category: "juc"
tags: ["Java", "JUC", "并发"]
---

# 对象内存布局

## 布局结构
![图片](/img/juc/bb318aa6fa6aee87/1674295838636-343e3749-4493-4ffb-b253-19a42937b2f6-302071.webp)

对象头包括<font style="color:#117CEE;">对象标记</font>Mark Word和<font style="color:#117CEE;">类元信息</font>（又叫类型指针）

![图片](/img/juc/bb318aa6fa6aee87/1674296496625-f14145b1-47a9-41fb-b1e2-c1c01f6c832d-472368.webp)

对象标记记录了哈希码，GC标记、次数，各种锁标记信息

![图片](/img/juc/bb318aa6fa6aee87/1674297382084-a6f4f305-61d3-42ec-a54d-c99c1cdb732a-677132.webp)



![图片](/img/juc/bb318aa6fa6aee87/1674298174750-147e64b1-2f85-46ed-81df-b97631b2e1d8-503757.webp)

![图片](/img/juc/bb318aa6fa6aee87/1674298190323-f163f4f0-dadc-42ee-b139-fb32c7c83ed8-747346.webp)

<font style="color:#74B602;">在64位系统中，Mark Word占了8个字节，类型指针占了8个字节，共计16个字节</font>

## 类元信息
<font style="color:#117CEE;">类型指针</font>（类元信息）指向方法区的Klass(类模板)，类中若有属性则存在堆中实例的实例数据区

即：对象指向它类元数据的指针，虚拟机通过这个指针来确定这个对象是来自于那个类的实例。

<font style="background-color:#D8DAD9;">类元信息有时为4字节并非8字节（因为默认开启了压缩类型指针）</font>

<font style="background-color:#D8DAD9;">使用java -XX:+PrintCommandLineFlags -version 可查看尾巴参数（打印使用的参数）其中包括如下参数</font>

<font style="background-color:#D8DAD9;">参数(开启压缩类型指针) -XX:+UseCompressedClassPointers</font>

![图片](/img/juc/bb318aa6fa6aee87/1674305315912-f160507a-5d3d-4a44-baf4-5b9dbb286a22-906965.webp)（使用了jol工具类查看）

## 填对齐充
确保实例对象大小为<font style="color:#1DC0C9;">8的整数倍</font>个字节，不是8的倍数则填充，是8的倍数则不填充

## 分代年龄
分代年龄由4bit存储在二进制中最大为“1111”即十进制的15 所以最大值为15,默认值也为15。



> 更新: 2023-01-21 20:56:28  
> 原文: <https://www.yuque.com/kugua-4bekq/fo2wrz/qy593dtqkno9z7u0>