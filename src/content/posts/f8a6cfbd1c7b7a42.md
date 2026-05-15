---
title: "Netty群聊的简单实现"
date: "2026-05-15"
updated: "2026-05-15T01:38:32.539Z"
category: "netty"
tags: ["Netty", "Java"]
---

# Netty群聊的简单实现

## 服务端实现
```java
package netty.groupChat;

import io.netty.bootstrap.ServerBootstrap;
import io.netty.channel.*;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioServerSocketChannel;
import io.netty.handler.codec.string.StringDecoder;
import io.netty.handler.codec.string.StringEncoder;

public class GroupChatServer {

    private int port;   //监听端口

    public GroupChatServer(int port) {
        this.port = port;
    }

    //处理客户端请求
    public void run() throws Exception {
        //创建两个线程组
        EventLoopGroup bossGroup = new NioEventLoopGroup(1);
        EventLoopGroup workerGroup = new NioEventLoopGroup(8); //8个 NioEventLoopGroup


        try {
            ServerBootstrap bootstrap = new ServerBootstrap();
            bootstrap.group(bossGroup, workerGroup)
            .channel(NioServerSocketChannel.class)
            .option(ChannelOption.SO_BACKLOG, 128) //等待队列长度
            .childOption(ChannelOption.SO_KEEPALIVE, true)
            .childHandler(new ChannelInitializer<SocketChannel>() {
                @Override
                protected void initChannel(SocketChannel socketChannel) throws Exception {
                    //获取pipeline
                    ChannelPipeline pipeline = socketChannel.pipeline();
                    pipeline.addLast("deCoder", new StringDecoder()) //加入解码器
                    .addLast("encoder", new StringEncoder()) //加入编码器
                    .addLast(new GroupChatServerHandler()); //自己的业务处理handler
                }
            });
            System.out.println("Netty服务器启动成功！");
            ChannelFuture cf = bootstrap.bind(port).sync();

            //监听关闭时事件
            cf.channel().closeFuture().sync();

        } finally {
            bossGroup.shutdownGracefully();
            workerGroup.shutdownGracefully();
        }

    }

    public static void main(String[] args) throws Exception {

        //启动！
        new GroupChatServer(9090).run();

    }
}
```

## 客户端的实现
```java
package netty.groupChat;

import io.netty.bootstrap.Bootstrap;
import io.netty.channel.Channel;
import io.netty.channel.ChannelFuture;
import io.netty.channel.ChannelInitializer;
import io.netty.channel.ChannelPipeline;
import io.netty.channel.nio.NioEventLoopGroup;
import io.netty.channel.socket.SocketChannel;
import io.netty.channel.socket.nio.NioSocketChannel;
import io.netty.handler.codec.string.StringDecoder;
import io.netty.handler.codec.string.StringEncoder;

import java.util.Scanner;

public class GroupChatClient {
    //属性
    private final String host;
    private final int port;

    //构造器初始化
    public GroupChatClient(String host, int port) {
        this.host = host;
        this.port = port;
    }

    public void run() throws Exception{
        NioEventLoopGroup eventLoopGroup = new NioEventLoopGroup();

        try {
            Bootstrap bootstrap = new Bootstrap();

            bootstrap.group(eventLoopGroup)
            .channel(NioSocketChannel.class)
            .handler(new ChannelInitializer<SocketChannel>() {
                @Override
                protected void initChannel(SocketChannel socketChannel) throws Exception {
                    //得到pipeline
                    ChannelPipeline pipeline = socketChannel.pipeline();
                    pipeline.addLast("decoder", new StringDecoder())
                    .addLast("encoder", new StringEncoder())
                    .addLast(new GroupChatClientHandler()); //自定义handler
                }
            });

            ChannelFuture cf = bootstrap.connect(host, port).sync();
            Channel channel = cf.channel();
            System.out.println("客户端" + channel.localAddress() + "启动完成");

            //输入信息的扫描器
            Scanner scanner = new Scanner(System.in);
            while (scanner.hasNextLine()) {
                String msg = scanner.nextLine();
                //发送信息
                channel.writeAndFlush(msg + "\r\n");
            }
        } finally {
            eventLoopGroup.shutdownGracefully();
        }

    }

    public static void main(String[] args) throws Exception {
        new GroupChatClient("127.0.0.1", 9090).run();
    }
}
```

## 服务端自定义handler的实现
1.实际的channel的集中管理不使用ChannelGroup不好区分channel，

  使用<font style="color:#000000;">ConcurrentHashMap<唯一表示, Channel></font>

<font style="color:#000000;">  来管理或者其他线程安全的的适合容器来做集中管理</font>

```java
package netty.groupChat;

import io.netty.channel.Channel;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.channel.group.ChannelGroup;
import io.netty.channel.group.DefaultChannelGroup;
import io.netty.util.concurrent.GlobalEventExecutor;

import java.text.SimpleDateFormat;
import java.util.Date;

public class GroupChatServerHandler extends SimpleChannelInboundHandler<String> {

    //定义channel组，管理所有channel
    //GlobalEventExecutor.INSTANCE 表示是一个全局的单例
    private static final ChannelGroup channelGroup = new DefaultChannelGroup(GlobalEventExecutor.INSTANCE);

    SimpleDateFormat dateFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss");

    //handlerAdded 连接建立，触发此方法
    //将当前Channel加入全局Group管理中
    @Override
    public void handlerAdded(ChannelHandlerContext ctx) throws Exception {
        Channel channel = ctx.channel();
        //将当前用户的上线信息推送给其他所有用户
        channelGroup.writeAndFlush( "[客户端]" + channel.remoteAddress() + "加入聊天\n");
        channelGroup.add(channel);
    }

    //主逻辑编写
    @Override
    protected void channelRead0(ChannelHandlerContext ctx, String msg) throws Exception {
        //读取数据
        Channel channel = ctx.channel();
        //根据不同情况回送不用的信息
        channelGroup.forEach(ch -> {
            //排除当前channel自己
            if (ch != channel) {
                //直接转发
                ch.writeAndFlush(dateFormat.format(new Date()) + "[用户]" + channel.remoteAddress() + "说：" + msg + "\n");
            } else {
                //自己
                ch.writeAndFlush(dateFormat.format(new Date()) + "[我]" + channel.remoteAddress() + "说：" + msg + "\n");
            }
        });
    }

    //channel处于活动状态（这里给服务端自己用了）
    @Override
    public void channelActive(ChannelHandlerContext ctx) throws Exception {
        System.out.println("[客户端]" + ctx.channel().remoteAddress() + "上线");
    }

    //channel处于非活动状态，提示离线信息
    @Override
    public void channelInactive(ChannelHandlerContext ctx) throws Exception {
        System.out.println("[客户端]" + ctx.channel().remoteAddress() + "离线");
    }

    //表示断开连接,将离线客户的信息推送给当前在线的用户
    //触发该方法会自动从channelGroup中移除，不需要手动移除
    @Override
    public void handlerRemoved(ChannelHandlerContext ctx) throws Exception {
        Channel channel = ctx.channel();
        channelGroup.writeAndFlush("[客户端]" + channel.remoteAddress() + "离开聊天\n");
        System.out.println("当前在线人数: " +  channelGroup.size());
    }

    //发生异常
    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) throws Exception {
        ctx.close(); //关闭
    }
}
```

## 客户端handler的实现
```java
package netty.groupChat;

import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.SimpleChannelInboundHandler;

public class GroupChatClientHandler extends SimpleChannelInboundHandler<String> {
    @Override
    protected void channelRead0(ChannelHandlerContext channelHandlerContext, String msg) throws Exception {
        System.out.println(msg.trim());
    }
}
```

## 关于私聊的实现
1.使用ConcurrentHashMap管理channel

```java
//自己使用hashmap实现channel管理
private static final ConcurrentHashMap<String, Channel> GlobalChannelMap = new ConcurrentHashMap<>();
```

2.判断消息类型

```java
//私聊
private static final String PRIVATE_CHAT_TYPE = "^#";
//群聊
private static final String GROUP_CHAT_TYPE = "^*";
```

3.处理数据判断 群聊/私聊

```java
//主逻辑编写
@Override
protected void channelRead0(ChannelHandlerContext ctx, String msg) throws Exception {
    //读取数据
    Channel channel = ctx.channel();
    String[] data = null;
    if (msg != null && !msg.isBlank()) {
        data = msg.split(" ");
    } else {
        return;
    }

    //私聊
    if (PRIVATE_CHAT_TYPE.equals(data[0])) {
        String to = data[1];
        Channel c = GlobalChannelMap.get(to);
        //放给指定用户
        c.writeAndFlush(dateFormat.format(new Date()) + "[私聊]" + channel.remoteAddress() + "对你说：" + data[2] + "\n");
        //回显给自己
        channel.writeAndFlush(dateFormat.format(new Date()) + "[私聊]你对" + to +  "说：" + data[2] + "\n");
    }
        //群聊
    else if (GROUP_CHAT_TYPE.equals(data[0])) {
        String[] finalData = data;
        GlobalChannelMap.forEach((s, c) -> {
            if (c != channel) {
                //直接转发
                c.writeAndFlush(dateFormat.format(new Date()) + "[用户]" + channel.remoteAddress() + "说：" + finalData[1] + "\n");
            } else {
                //自己
                c.writeAndFlush(dateFormat.format(new Date()) + "[我]" + channel.remoteAddress() + "说：" + finalData[1] + "\n");
            }
        });
    }
}
```



> 更新: 2023-12-08 16:56:52  
> 原文: <https://www.yuque.com/kugua-4bekq/xdngkn/ngacml4vobictr4t>