/** ZCode World:接收本机 ZCode 钩子事件(完成通知、活动记账),并把大任务派给后台 ZCode 无头实例。 */
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import type { ToolDef, World, WorldWebUiDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { ZCODE_CONFIG_GROUP, type ZcodeConfigSection } from './config.ts';
import { HookServer, type HookPayload } from './server.ts';
import { ActivityTracker, describeSnapshot, excerpt, type ActivitySnapshot } from './tracker.ts';
import { TaskRunner, type TaskDoneInfo } from './runner.ts';
import { ensureHooks, zcodeConfigPath } from './hooks-config.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
/** 定时器的唤醒粒度:间隔配置热改后最迟一个周期内跟上。 */
const TICK_MS = 30_000;

export interface ZcodeWorldOptions {
  /** `worlds.zcode` 的活引用。 */
  cfg: ZcodeConfigSection;
  timezone: string;
  /** 部署数据目录;后台任务工作区在其 zcode-tasks 子目录下。 */
  dataDir: string;
  /** 用户主目录,钩子自动配置写到其 .zcode/cli/config.json;缺省取当前用户。 */
  homeDir?: string;
}

/** 全部工具的声明;定义里的 describe 与 `tools()` 都取它。 */
export const ZCODE_TOOL_DECLS: ReadonlyArray<Omit<ToolDef, 'handler'>> = [
  {
    name: 'zcode_run',
    description:
      'Dispatch a coding task to a headless ZCode instance. It runs unattended (full-auto) in its own scratch directory and a zcode.task_done event arrives when it finishes, so return immediately without polling.',
    tags: ['act'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        task: {
          type: 'string',
          description: 'Complete, self-contained task description in the language ZCode should work in.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'zcode_tasks',
    description:
      'List background ZCode tasks still running and the tool activity bookkept from local ZCode hook events.',
    tags: ['read', 'snapshot'],
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
];

export class ZcodeWorld implements World {
  readonly id = 'zcode';

  private host: WorldHost | null = null;
  private server: HookServer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReportAt = Date.now();
  private readonly tracker = new ActivityTracker();
  private readonly runner: TaskRunner;

  constructor(private readonly opts: ZcodeWorldOptions) {
    this.homeDir = opts.homeDir ?? homedir();
    this.runner = new TaskRunner({
      cfg: opts.cfg,
      dataDir: opts.dataDir,
      onDone: (info) => void this.onTaskDone(info),
    });
  }

  private readonly homeDir: string;

  envPromptVars(): Record<string, string> {
    return {};
  }

  tools(): ToolDef[] {
    return [this.runTool(), this.tasksTool()];
  }

  webUi(): WorldWebUiDecl {
    return {
      config: [ZCODE_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.zcode.envPrompt',
          title: 'ZCode · 环境提示词',
          description: 'ZCode World 进 system 前缀的那一段。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    this.server = new HookServer(
      {
        port: this.opts.cfg.port,
        address: this.opts.cfg.listenAddress.trim() || '127.0.0.1',
        token: this.opts.cfg.hookToken.trim(),
      },
      (payload) => this.onHookEvent(payload),
    );
    await this.server.start();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    const note = [
      `ZCode World 已挂载,钩子接收端监听 ${this.listeningAddress}。`,
      this.listeningAddress.startsWith('127.0.0.1') ? '' : '对外监听已开启,钩子 URL 须带 token。',
      this.hookSetupNote(),
    ]
      .filter(Boolean)
      .join('');
    await host.pushEvent({
      type: 'zcode.started',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: note,
      meta: { port: this.server.actualPort, address: this.listeningAddress },
    });
  }

  /** 对外展示的监听口径:127.0.0.1 用端口表述,其他地址带完整地址。 */
  private get listeningAddress(): string {
    const address = this.opts.cfg.listenAddress.trim() || '127.0.0.1';
    return address === '127.0.0.1'
      ? `127.0.0.1:${this.server?.actualPort ?? this.opts.cfg.port}`
      : `${address}:${this.server?.actualPort ?? this.opts.cfg.port}`;
  }

  /** 钩子自动配置的结果说明,拼进挂载事件让桌宠能转达配置状态。 */
  private hookSetupNote(): string {
    if (!this.opts.cfg.autoConfigureHooks) {
      return ' 自动配置钩子已关闭;若 zcode 侧没有指向本端口的转发,将收不到通知。';
    }
    const result = ensureHooks(
      zcodeConfigPath(this.homeDir),
      this.server?.actualPort ?? this.opts.cfg.port,
      this.opts.cfg.hookToken.trim(),
    );
    if (result.error) return ` 钩子自动配置失败:${result.error}`;
    if (!result.changed) return ' zcode 钩子转发已就绪。';
    const parts: string[] = [];
    if (result.added.length > 0) parts.push(`已补写 ${result.added.join('、')} 的转发`);
    if (result.enabledSet) parts.push('已启用 hooks');
    return ` 钩子自动配置:${parts.join(',')};从新起的 zcode 会话开始生效。`;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.runner.stopAll();
    await this.server?.stop();
    this.server = null;
    this.host = null;
  }

  /** 实际监听端口;未启动时为 null。 */
  get listeningPort(): number | null {
    return this.server ? this.server.actualPort : null;
  }

  private isTaskCwd(cwd: string): boolean {
    return cwd.length > 0 && cwd.startsWith(this.runner.tasksRoot);
  }

  private onHookEvent(payload: HookPayload): void {
    if (payload.kind === 'tool') {
      this.tracker.recordTool(payload);
      return;
    }
    if (payload.kind === 'stop') {
      if (!payload.sessionId) return;
      // 后台任务会话的完成由 TaskRunner 的进程退出负责通知,避免双份。
      if (this.isTaskCwd(payload.cwd)) {
        this.tracker.dropSession(payload.sessionId);
        return;
      }
      const snapshot = this.tracker.settleSession(payload);
      if (!snapshot) return;
      const text = [
        `[zcode] 一轮工作完成:${describeSnapshot(snapshot)}。`,
        payload.lastAssistantMessage
          ? `最终回复:\n${excerpt(payload.lastAssistantMessage)}`
          : '最终回复为空。',
      ].join('\n');
      void this.pushExternal(`zcode:session:${snapshot.sessionId}`, 'zcode.session_done', text, {
        sessionId: snapshot.sessionId,
        cwd: snapshot.cwd,
        toolCalls: snapshot.toolCalls,
      });
    }
    // permission:本版不处理,收到即忽略。
  }

  private async onTaskDone(info: TaskDoneInfo): Promise<void> {
    const minutes = Math.max(1, Math.round(info.durationMs / 60_000));
    const lines = [
      `[zcode] 后台任务 ${info.id} 结束:${info.timedOut ? '超过时限被终止' : `退出码 ${info.exitCode ?? '未知'}`},用时约 ${minutes} 分钟。`,
      `任务:${excerpt(info.task, 120)}`,
    ];
    if (info.outputTail) lines.push(`输出结尾:\n${info.outputTail}`);
    await this.pushExternal(`zcode:task:${info.id}`, 'zcode.task_done', lines.join('\n'), {
      taskId: info.id,
      exitCode: info.exitCode,
      timedOut: info.timedOut,
    });
  }

  private tick(): void {
    void this.reportProgress();
  }

  /** 到点的进展汇报:有未汇报活动才推;间隔与超时均为热配置,每次现读。 */
  async reportProgress(): Promise<void> {
    const minutes = this.opts.cfg.intervalMinutes;
    if (minutes <= 0) return;
    const now = Date.now();
    if (now - this.lastReportAt < minutes * 60_000) return;
    const active = this.tracker.collectUnreported(now);
    if (active.length === 0) return;
    this.lastReportAt = now;
    const running = this.runner.list();
    const lines = active.map((snap) => `[zcode] 近期活动:${describeSnapshot(snap)}。`);
    for (const t of running) {
      const minutes2 = Math.max(1, Math.round((now - t.startedAt) / 60_000));
      lines.push(`[zcode] 后台任务 ${t.id} 仍在运行(约 ${minutes2} 分钟):${excerpt(t.task, 80)}`);
    }
    const text = lines.join('\n');
    await this.pushExternal('zcode:progress', 'zcode.progress', text, {
      sessions: active.map((s): ActivitySnapshot => s),
      runningTasks: running.length,
    });
  }

  private async pushExternal(
    senderKey: string,
    type: string,
    text: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const host = this.host;
    if (!host) return;
    await host.pushEvent(
      {
        type,
        ts: nowIso(this.opts.timezone),
        source: this.id,
        senderKey,
        text,
        meta,
      },
      { trigger: 'flush' },
    );
  }

  private runTool(): ToolDef {
    return {
      ...ZCODE_TOOL_DECLS[0]!,
      handler: async (args) => {
        const task = typeof args['task'] === 'string' ? args['task'] : '';
        const result = this.runner.run(task);
        if (!result.ok) return { text: `派出失败:${result.error}`, failed: true };
        return `任务已派出:编号 ${result.id}。它在独立空目录里全自动运行,结束时我会收到 zcode.task_done 通知再转达,无需等待或轮询。`;
      },
    };
  }

  private tasksTool(): ToolDef {
    return {
      ...ZCODE_TOOL_DECLS[1]!,
      handler: async () => {
        const running = this.runner.list();
        const active = this.tracker.listActive();
        const lines: string[] = [];
        if (running.length === 0 && active.length === 0) {
          return '当前没有在运行的后台任务,近期也没有钩子报来的会话活动。';
        }
        const now = Date.now();
        for (const t of running) {
          const minutes = Math.max(1, Math.round((now - t.startedAt) / 60_000));
          lines.push(`后台任务 ${t.id}:已运行约 ${minutes} 分钟。任务:${excerpt(t.task, 100)}`);
        }
        for (const snap of active) {
          lines.push(`会话活动:${describeSnapshot(snap)}。`);
        }
        return lines.join('\n');
      },
    };
  }
}
