export const CATEGORY_MAP: Record<string, string> = {
  dbhknw: 'Android 内核',
  kb: 'Go',
  koo1se: 'eBPF',
  nohhgp: 'Windows',
  frida: 'Frida Android',
  lsposed: 'LSPosed',
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
