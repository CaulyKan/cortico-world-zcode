## 0.2.0

- 监听地址与钩子访问口令(`listenAddress` / `hookToken`):支持把接收端开放给局域网内的远程机器,远程 zcode 的钩子也能转发过来;本地自动配置的转发 URL 同步携带口令。

## 0.1.0

首个版本:ZCode 会话完成通知、定时进展汇报、后台无头任务(`zcode_run` / `zcode_tasks`)。
启动时自动检测并补写 zcode 钩子转发(`autoConfigureHooks`,默认开启);Desktop 安装布局下自动用官方环境变量补齐无头 CLI 的 provider 配置定位。
