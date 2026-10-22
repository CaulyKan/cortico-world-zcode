import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { ZCODE_DEFAULTS, type ZcodeConfigSection } from './config.ts';
import { ZCODE_TOOL_DECLS, ZcodeWorld } from './world.ts';

export const ZCODE: WorldDefinition<ZcodeConfigSection> = {
  id: 'zcode',
  label: 'ZCode',
  defaults: () => ({ ...ZCODE_DEFAULTS }),
  // `ctx.cfg` 是 `worlds.zcode` 的活引用:热改的键现读即生效。
  create: (ctx) => new ZcodeWorld({ cfg: ctx.cfg, timezone: ctx.timezone, dataDir: ctx.dataDir }),
  // 自描述:可能出现的全部工具与会推出的全部事件,不进提示词。
  describe: {
    tools: describeTools(ZCODE_TOOL_DECLS, {
      zcode_run: {
        zh: '把一个编码任务派给后台 ZCode 无头实例(独立空目录、全自动),结束时会另行通知。',
        en: 'Dispatch a coding task to a headless ZCode instance; a follow-up event reports the result.',
      },
      zcode_tasks: {
        zh: '列出仍在运行的后台 ZCode 任务和钩子报来的近期会话活动。',
        en: 'List running background ZCode tasks and recent hook-reported session activity.',
      },
    }),
    events: [
      {
        type: 'zcode.started',
        description: { zh: 'World 挂载完成,钩子接收端已监听本机端口。', en: 'The World was mounted and the hook listener is up.' },
      },
      {
        type: 'zcode.session_done',
        description: { zh: '主人的 ZCode 会话完成了一轮实际工作,正文带工具用量与最终回复摘要。', en: 'A ZCode session finished a round of real work, with tool usage and a reply excerpt.' },
      },
      {
        type: 'zcode.progress',
        description: { zh: 'ZCode 近期活动的定时汇总;无活动时不推送。', en: 'Periodic summary of recent ZCode activity; silent when idle.' },
      },
      {
        type: 'zcode.task_done',
        description: { zh: '派出的后台 ZCode 任务结束(完成、失败或超时)。', en: 'A dispatched background ZCode task finished (done, failed or timed out).' },
      },
    ],
  },
};
