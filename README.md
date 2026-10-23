# cortico-world-zcode

Owner: `src/definition.ts`

让 Coopanion 感知本机 ZCode 的任务动向,并把大任务派给后台 ZCode 无头实例的 World 扩展。

- **任务完成通知**:ZCode 会话完成一轮实际工作(改过文件、跑过命令)时推送 `zcode.session_done`,正文带工作目录、工具用量、涉及文件和最终回复摘要;短问答不打扰。
- **定时进展汇报**:把钩子报来的工具调用记账,每隔 `intervalMinutes` 分钟汇总推送 `zcode.progress`;无活动时静默,设 0 关闭。
- **派后台任务**:桌宠调用 `zcode_run` 把编码任务派给 `zcode -p --mode yolo` 的无头实例,在部署数据目录的 `zcode-tasks/<编号>/` 专属空目录里全自动运行(不绑定任何项目),结束或超时推送 `zcode.task_done`;`zcode_tasks` 查询在跑的任务与近期活动。

## ZCode 侧配置

本 World 在 `127.0.0.1:<port>`(默认 4761)监听 `POST /api/event?type=stop|tool|permission`,正文是 ZCode 钩子的输入 JSON。

默认**自动配置**(`autoConfigureHooks: true`):启动时检测 `~/.zcode/cli/config.json` 的 hooks,缺 `Stop` / `PostToolUse` 转发时自动补写并启用 hooks——只追加条目,不改已有钩子与其他配置;文件损坏或不是 JSON 对象时拒绝改写。配置写好后从新起的 zcode 会话开始生效。手工配置的等价写法:

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PostToolUse": [
        { "hooks": [{ "type": "process", "command": "curl", "args": ["-s", "--max-time", "2", "--data-binary", "@-", "http://127.0.0.1:4761/api/event?type=tool"], "timeoutMs": 4000 }] }
      ],
      "Stop": [
        { "hooks": [{ "type": "process", "command": "curl", "args": ["-s", "--max-time", "2", "--data-binary", "@-", "http://127.0.0.1:4761/api/event?type=stop"], "timeoutMs": 4000 }] }
      ]
    }
  }
}
```

`PostToolUse` 负责活动记账(进展汇报与"干过活"判定都依赖它),`Stop` 负责完成通知。`PermissionRequest` 可选,本版收到即忽略。

## 远程机器的钩子(ssh/wsl/docker 源服务器)

钩子在**会话执行端**运行:远程 zcode 会话的钩子跑在远程机器上,读它自己的 `~/.zcode/cli/config.json`,`127.0.0.1` 也指向远程自己。要让远程会话的通知到达本机,需要两端各配一步:

1. **本机扩展开放对外监听**:设置 `listenAddress` 为 `0.0.0.0`(或本机局域网 IP),并设置 `hookToken`(随机长字符串;对外监听必须设),重启实例。首次启动时 Windows 防火墙会询问,放行 Node.js/该端口。
2. **远程机器配置钩子**:编辑远程的 `~/.zcode/cli/config.json`,把转发地址指向本机(用本机局域网 IP 或 `host.docker.internal` 等可达地址),并带上同一口令:

```json
{
  "hooks": {
    "enabled": true,
    "events": {
      "PostToolUse": [
        { "hooks": [{ "type": "process", "command": "curl", "args": ["-s", "--max-time", "2", "--data-binary", "@-", "http://<本机IP>:4761/api/event?token=<口令>&type=tool"], "timeoutMs": 4000 }] }
      ],
      "Stop": [
        { "hooks": [{ "type": "process", "command": "curl", "args": ["-s", "--max-time", "2", "--data-binary", "@-", "http://<本机IP>:4761/api/event?token=<口令>&type=stop"], "timeoutMs": 4000 }] }
      ]
    }
  }
}
```

wsl 源服务器可用宿主 IP(WSL 内 `grep nameserver /etc/resolv.conf` 的地址或宿主局域网 IP);docker 源服务器用 `host.docker.internal`;ssh 服务器用本机局域网 IP,要求两端网络互通。远程新起的会话生效。

本机的自动配置不受影响:口令非空时,写入本机钩子的转发 URL 会自动带上同一口令。

## 配置项(`worlds.zcode`)

| 键 | 默认 | 说明 |
|---|---|---|
| `port` | 4761 | 本机监听端口,须与 zcode 钩子的目标一致;重启实例生效 |
| `intervalMinutes` | 10 | 进展汇报间隔(分钟),0 关闭;热改生效 |
| `cliPath` | 空 | zcode CLI(`zcode.cjs`)完整路径;留空自动探测 ZCode Desktop 安装位置;重启实例生效 |
| `taskTimeoutMinutes` | 30 | 后台任务超时;到点终止并通知 |
| `autoConfigureHooks` | true | 启动时自动补写 zcode 钩子转发;重启实例生效 |
| `listenAddress` | 127.0.0.1 | 接收端绑定地址;`0.0.0.0` 供远程钩子访问;重启实例生效 |
| `hookToken` | 空 | 钩子访问口令;非空时钩子 URL 须带 `?token=`;对外监听时务必设置 |

## 从本机目录安装

在 Coopanion 的扩展页选择从本机目录安装(以 link 方式装入),选本包目录;或命令行:

```
cd <部署>/extensions && corepack pnpm add <本包的绝对路径>
```

改代码后重启进程生效。

## 网络与文件

- 只在本机回环地址 `127.0.0.1` 监听一个端口,不访问外网。
- 后台任务工作区只写在部署数据目录的 `zcode-tasks/` 子目录下。
- 钩子报来的会话内容只存内存,不落盘;不读取 ZCode 的会话文件,不接触任何密钥。
- 钩子自动配置只在 `~/.zcode/cli/config.json` 的 hooks 段追加转发条目,其余内容原样保留;可用 `autoConfigureHooks: false` 关闭。
- Desktop 安装布局下 CLI 自带的 provider 配置探测会落空,派任务时自动用官方环境变量
  (`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` / `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE`)指向实际位置,无需手动设置。

## 许可

MIT。全部代码与图标(`icon.svg`)为本包原创,未引入第三方代码或素材。
