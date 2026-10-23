import type { ConfigGroup } from 'cortico/core/types.ts';

/** config.json 的 worlds.zcode 段，默认禁用；bot 或部署可启用。 */
export interface ZcodeConfigSection {
  enabled: boolean;
  /** 接收 ZCode 钩子事件的本机端口;改动后需重启实例。 */
  port: number;
  /** 定时进展汇报的间隔(分钟);0 关闭;改动立即生效。 */
  intervalMinutes: number;
  /** zcode CLI 的路径;留空时自动探测 ZCode Desktop 的安装位置;改动后需重启实例。 */
  cliPath: string;
  /** 后台任务的超时(分钟);到点终止任务并通知;派任务时读取。 */
  taskTimeoutMinutes: number;
  /** 启动时检测 zcode 的钩子转发,缺失时自动补写 ~/.zcode/cli/config.json;重启实例生效。 */
  autoConfigureHooks: boolean;
  /** HTTP 监听地址;127.0.0.1 只收本机,0.0.0.0 或具体网卡地址供远端钩子访问;重启实例生效。 */
  listenAddress: string;
  /** 钩子访问口令;非空时钩子 URL 必须带 ?token= 才被接受;重启实例生效。 */
  hookToken: string;
}

export const ZCODE_DEFAULTS: ZcodeConfigSection = {
  enabled: false,
  port: 4761,
  intervalMinutes: 10,
  cliPath: '',
  taskTimeoutMinutes: 30,
  autoConfigureHooks: true,
  listenAddress: '127.0.0.1',
  hookToken: '',
};

/** World 配置的 JSON Schema 声明。 */
export const ZCODE_CONFIG_GROUP: ConfigGroup = {
  id: 'world:zcode',
  owner: 'world:zcode',
  schema: {
    type: 'object',
    title: 'ZCode',
    properties: {
      'worlds.zcode.port': {
        type: 'number',
        title: '接收端口',
        description: '在本机回环地址监听 ZCode 钩子事件的端口;zcode 侧的钩子需 POST 到同一端口。',
        'x-hot': false,
      },
      'worlds.zcode.intervalMinutes': {
        type: 'number',
        title: '进展汇报间隔(分钟)',
        description: '把近期 ZCode 活动汇总推给桌宠的间隔;0 关闭定时汇报。',
        'x-hot': true,
      },
      'worlds.zcode.cliPath': {
        type: 'string',
        title: 'zcode 程序路径',
        description: 'zcode CLI(.cjs)的完整路径;留空则自动探测 ZCode Desktop 的安装位置。',
        'x-hot': false,
      },
      'worlds.zcode.taskTimeoutMinutes': {
        type: 'number',
        title: '后台任务超时(分钟)',
        description: '派出的后台任务超过该时长后终止并通知。',
        'x-hot': true,
      },
      'worlds.zcode.autoConfigureHooks': {
        type: 'boolean',
        title: '自动配置 zcode 钩子',
        description: '启动时检测 zcode 的钩子转发,缺 Stop/PostToolUse 时自动补写到 ~/.zcode/cli/config.json 并启用 hooks;只追加,不改已有条目。',
        'x-hot': false,
      },
      'worlds.zcode.listenAddress': {
        type: 'string',
        title: '监听地址',
        description: '127.0.0.1 只收本机钩子;要让远程机器的钩子转发过来,填 0.0.0.0 并配置访问口令,同时在防火墙放行端口。',
        'x-hot': false,
      },
      'worlds.zcode.hookToken': {
        type: 'string',
        title: '钩子访问口令',
        description: '非空时钩子 URL 必须带 ?token=<口令> 才被接受;对外监听时务必设置。',
        'x-hot': false,
      },
    },
  },
};
