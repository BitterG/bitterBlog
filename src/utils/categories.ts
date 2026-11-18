export const CATEGORY_MAP: Record<string, string> = {
  agent: 'Agent 实现原理（Claude code）',
  dbhknw: 'Android 内核',
  kb: 'Go',
  golang: 'Go',
  koo1se: 'eBPF',
  nohhgp: 'Windows',
  frida: 'Frida',
  lsposed: 'LSPosed',
  'game-hacking': '游戏逆向',
  'java-proxy': 'Java 代理',
  jvm: 'JVM',
  nio: 'Java NIO',
  netty: 'Netty',
  rabbitmq: 'RabbitMQ',
  zookeeper: 'ZooKeeper',
  mongodb: 'MongoDB',
  log4j2: 'Log4j2',
  'spring-interceptor': 'Spring 拦截器',
  'spring-exception': 'Spring 异常处理',
  juc: 'JUC',
  projects: '项目',
};

export function getCategoryName(categoryId: string): string {
  return CATEGORY_MAP[categoryId] ?? categoryId;
}

export interface MajorCategory {
  id: string;
  name: string;
  shortName: string;
  eyebrow: string;
  glyph: string;
  description: string;
  topics: string[];
}

export const MAJOR_CATEGORIES: MajorCategory[] = [
  {
    id: 'agent',
    name: 'Agent 实现原理（Claude code）',
    shortName: 'Agent 原理',
    eyebrow: 'CLAUDE CODE HARNESS',
    glyph: 'AG',
    description: '从零拆解 Claude Code 核心实现原理：Agent 主循环、工具与权限、Hooks、Todo、Subagent、Skill、上下文压缩、持久记忆、任务图、后台/定时调度、多 Agent 团队与 MCP 接入。',
    topics: ['Agent Loop', 'Context & Memory', 'Task & Cron', 'Agent Teams', 'MCP Tools'],
  },
  {
    id: 'frida',
    name: 'Frida 逆向',
    shortName: 'Frida',
    eyebrow: 'FRIDA HOOK',
    glyph: 'FR',
    description: 'Frida 环境搭建、Java / SO Native Hook、Frida Gadget 免 Root 注入、反检测与双向校验逆向。',
    topics: ['Java Hook', 'SO Hook', 'Frida Gadget', '防检测', 'ReactNative'],
  },
  {
    id: 'android',
    name: 'Android 逆向与内核',
    shortName: 'Android',
    eyebrow: 'ANDROID & KERNEL',
    glyph: 'AN',
    description: 'Android 内核源码编译与修补、KernelPatch / KPM 模块、LSPosed 注入、加固脱壳与 Frida 移动逆向。',
    topics: ['Android 内核', 'KernelPatch', 'LSPosed', 'Frida Android', 'Native Hook'],
  },
  {
    id: 'java',
    name: 'Java 与后端',
    shortName: 'Java',
    eyebrow: 'JAVA & BACKEND',
    glyph: 'JV',
    description: 'JVM 内存与类加载、JDK 25/27 新特性、JUC 并发编程、Java NIO、Netty 网络框架与 Spring 生态。',
    topics: ['JVM & JDK', 'JUC 并发', 'Netty', 'Java NIO', 'Spring', '动态代理'],
  },
  {
    id: 'projects',
    name: '项目与实战',
    shortName: '项目',
    eyebrow: 'PROJECTS & TOOLS',
    glyph: 'PJ',
    description: '从零手写迷你 Clash 内核、BitterGate 微服务网关、游戏存档转换/修改工具与开源项目实战记录。',
    topics: ['Mini Clash', 'BitterGate 网关', 'GBFR 工具链', 'Phasmophobia 工具', '开源 PR'],
  },
  {
    id: 'game',
    name: '游戏逆向与辅助',
    shortName: '游戏',
    eyebrow: 'GAME HACKING',
    glyph: 'GM',
    description: 'Unity IL2CPP / Mono 注入、Unreal 逆向、Cheat Engine 汇编脚本、ESP 透视绘制、存档解析与 Steam DLC 解锁。',
    topics: ['Unity IL2CPP', 'Cheat Engine', 'GBFR', 'Phasmophobia', 'REPO ESP', 'Steam DLC'],
  },
  {
    id: 'golang',
    name: 'Go 语言',
    shortName: 'Go',
    eyebrow: 'GOLANG',
    glyph: 'GO',
    description: 'Go 1.27 新特性、QUIC / Hysteria2 / SOCKS5 代理协议实现、Wails 桌面开发、微服务网关与 Go eBPF。',
    topics: ['Go 1.27', '网络协议栈', 'Wails 桌面应用', '微服务', 'Go eBPF'],
  },
  {
    id: 'ebpf',
    name: 'eBPF 与 Linux 内核',
    shortName: 'eBPF',
    eyebrow: 'EBPF & LINUX',
    glyph: 'BP',
    description: 'BPF Maps 用户态通信、Perf / Ring Buffer、用户层与内核函数 Hook、文件重定向与栈内存限制突破。',
    topics: ['BPF Maps', 'Ring Buffer', 'Uprobe / Hook', '文件重定向', 'Linux Kernel'],
  },
  {
    id: 'windows',
    name: 'Windows 与底层逆向',
    shortName: 'Windows',
    eyebrow: 'WINDOWS & X64',
    glyph: 'WN',
    description: 'Windows 窗口绘制、MASM 汇编、DLL 注入与代理劫持、vtable Hook、PE 文件补丁与 x64 反汇编分析。',
    topics: ['DLL 注入', 'MASM 汇编', 'PE Patch', 'x64 逆向', 'vtable Hook'],
  },
  {
    id: 'middleware',
    name: '中间件与数据库',
    shortName: '中间件',
    eyebrow: 'MIDDLEWARE & DB',
    glyph: 'MW',
    description: 'RabbitMQ 消息队列、ZooKeeper 分布式锁与 ZAB 协议、MongoDB 分片集群与副本集、Docker 部署实践。',
    topics: ['RabbitMQ', 'ZooKeeper', 'MongoDB', '分布式锁', 'Docker'],
  },
];

export const MAJOR_CATEGORY_MAP: Record<string, MajorCategory> = Object.fromEntries(
  MAJOR_CATEGORIES.map((c) => [c.id, c])
);

export interface CategorizablePost {
  slug: string;
  title: string;
  category: string; // raw category id from frontmatter
  categories?: string[]; // optional explicit multi-categories
  tags?: string[];
}

/**
 * 识别一篇文章所属的所有大类（支持跨分类文章同时归属多个分类）
 */
export function resolvePostMajorCategories(post: CategorizablePost): string[] {
  const matched = new Set<string>();
  const rawCat = (post.category || '').toLowerCase().trim();
  const tags = (post.tags || []).map((t) => t.toLowerCase().trim());
  const titleLower = (post.title || '').toLowerCase();

  // 0. 显式指定的 categories
  if (Array.isArray(post.categories)) {
    for (const c of post.categories) {
      if (MAJOR_CATEGORY_MAP[c]) matched.add(c);
    }
  }

  const hasTag = (keywords: string[]) =>
    tags.some((t) => keywords.some((k) => t === k.toLowerCase() || t.includes(k.toLowerCase())));

  // 0.5 Agent 实现原理（Claude code）
  if (rawCat === 'agent' || hasTag(['claude code', 'agent loop', 'agent'])) {
    matched.add('agent');
  }

  // 1. Frida
  if (rawCat === 'frida' || hasTag(['frida']) || titleLower.includes('frida')) {
    matched.add('frida');
  }

  // 2. Android（涵盖 Android 内核、LSPosed、Frida Android 跨类文章）
  if (
    ['dbhknw', 'lsposed', 'frida'].includes(rawCat) ||
    hasTag(['android', 'lsposed', 'kernelpatch']) ||
    titleLower.includes('安卓') ||
    titleLower.includes('android')
  ) {
    matched.add('android');
  }

  // 3. Java 与后端（涵盖 JVM、JUC、NIO、Netty、代理、Spring、Log4j2 及 Java 跨类文章）
  if (
    [
      'jvm',
      'juc',
      'nio',
      'netty',
      'java-proxy',
      'spring-interceptor',
      'spring-exception',
      'log4j2',
    ].includes(rawCat) ||
    hasTag(['java', 'jvm', 'juc', 'nio', 'netty', 'spring', 'spring boot', 'log4j2', 'cglib']) ||
    titleLower.includes('java') ||
    titleLower.includes('springboot') ||
    titleLower.includes('jdk')
  ) {
    matched.add('java');
  }

  // 4. 项目与实战（涵盖 projects 及实战工具/教程类跨类文章）
  if (
    rawCat === 'projects' ||
    ['steam-id', 'mini-clash-tutorial', '6007be752708edaf', 'gbfr-event-chat', 'repo-esp'].includes(
      post.slug
    )
  ) {
    matched.add('projects');
  }

  // 5. 游戏逆向与辅助（涵盖 game-hacking 及所有涉及游戏逆向/修改器/CE/Unity/Unreal 的跨类文章）
  if (
    rawCat === 'game-hacking' ||
    post.slug === 'steam-id' ||
    hasTag([
      'game hacking',
      '游戏注入',
      '游戏',
      'gbfr',
      'gbf relink',
      'phasmophobia',
      'repo',
      'il2cpp',
      'unity',
      'unreal engine',
      'cheat engine',
      'ce',
      'steam',
      'dlc',
      'esp',
      'bepinex',
      '深岩银河',
    ])
  ) {
    matched.add('game');
  }

  // 6. Go 语言（涵盖 golang 及使用 Go 开发的网关/Clash/桌面工具/eBPF 跨类文章）
  if (
    rawCat === 'golang' ||
    rawCat === 'kb' ||
    hasTag(['go', 'golang', 'wails']) ||
    titleLower.includes('golang')
  ) {
    matched.add('golang');
  }

  // 7. eBPF 与 Linux 内核（涵盖 eBPF 及 Linux 内核 Hook 跨类文章）
  if (
    rawCat === 'koo1se' ||
    hasTag(['ebpf']) ||
    titleLower.includes('ebpf') ||
    titleLower.includes('bpf') ||
    (rawCat === 'dbhknw' && hasTag(['kernel', 'linux']))
  ) {
    matched.add('ebpf');
  }

  // 8. Windows 与底层逆向（涵盖 Windows / MASM / DLL 注入 / PE / x64 跨类文章）
  if (
    rawCat === 'nohhgp' ||
    hasTag(['windows', 'masm', 'dll注入', 'dll injection', 'dll proxy', 'pe', 'x64', 'asm']) ||
    post.slug === '1ac3ba4470eb3a26' ||
    post.slug === 'smokeapi-dlc-unlock'
  ) {
    matched.add('windows');
  }

  // 9. 中间件与数据库（涵盖 RabbitMQ、ZooKeeper、MongoDB 及网关/Docker 跨类文章）
  if (
    ['rabbitmq', 'zookeeper', 'mongodb'].includes(rawCat) ||
    hasTag(['rabbitmq', 'zookeeper', 'mongodb', '消息队列', '分布式', 'nosql', 'docker'])
  ) {
    matched.add('middleware');
  }

  // 兜底：若未命中任何预设规则，归入项目或对应分类
  if (matched.size === 0) {
    matched.add('projects');
  }

  // 保持与 MAJOR_CATEGORIES 定义顺序一致，但将最匹配原 category 的主类排在第一位
  const ordered = MAJOR_CATEGORIES.map((c) => c.id).filter((id) => matched.has(id));
  const primaryMap: Record<string, string> = {
    agent: 'agent',
    frida: 'frida',
    dbhknw: 'android',
    lsposed: 'android',
    jvm: 'java',
    juc: 'java',
    nio: 'java',
    netty: 'java',
    'java-proxy': 'java',
    'spring-interceptor': 'java',
    'spring-exception': 'java',
    log4j2: 'java',
    projects: 'projects',
    'game-hacking': 'game',
    golang: 'golang',
    kb: 'golang',
    koo1se: 'ebpf',
    nohhgp: 'windows',
    rabbitmq: 'middleware',
    zookeeper: 'middleware',
    mongodb: 'middleware',
  };
  const preferredPrimary = primaryMap[rawCat];
  if (preferredPrimary && ordered.includes(preferredPrimary)) {
    return [preferredPrimary, ...ordered.filter((id) => id !== preferredPrimary)];
  }
  return ordered;
}
