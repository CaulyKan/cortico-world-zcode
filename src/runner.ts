/** 后台任务执行器:把任务派给本机 zcode 无头实例,在专属空目录里全自动运行。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ZcodeConfigSection } from './config.ts';

export interface RunningTask {
  id: string;
  task: string;
  startedAt: number;
  child: ChildProcess;
}

export interface TaskDoneInfo {
  id: string;
  task: string;
  exitCode: number | null;
  timedOut: boolean;
  /** stdout 尾部文本,给桌宠做结果摘要。 */
  outputTail: string;
  durationMs: number;
}

export type TaskDoneListener = (info: TaskDoneInfo) => void;

/** stdout 最多保留的尾部长度:够看结论,不把长输出塞进事件。 */
const OUTPUT_TAIL_CHARS = 2000;
const TASK_PREFIX_RE = /^[a-z0-9-]+$/;

/**
 * 无头 CLI 的 provider 定位:Desktop 安装布局下 CLI 自带的候选路径
 * (`<cli目录>/provider/` 与上五级的 `config/provider/`)都落空,要用官方
 * 环境变量把内置配置与个人配置指到实际位置。已由外层环境指定的不覆盖。
 */
export const providerEnv = (
  cliPath: string,
  homeDir: string = homedir(),
): Record<string, string> => {
  const cliDir = dirname(cliPath);
  if (existsSync(join(cliDir, 'provider', 'zcode-builtin.json'))) return {};
  const env: Record<string, string> = {};
  // Desktop 布局:resources/glm/zcode.cjs → resources/config/provider/zcode-builtin.json
  const desktopBuiltin = join(dirname(cliDir), 'config', 'provider', 'zcode-builtin.json');
  if (existsSync(desktopBuiltin)) env['ZCODE_BUILTIN_PROVIDER_CONFIG_FILE'] = desktopBuiltin;
  const personal = join(homeDir, '.zcode', 'v2', 'provider_config.json');
  if (existsSync(personal)) env['ZCODE_PERSONAL_PROVIDER_CONFIG_FILE'] = personal;
  return env;
};

export class TaskRunner {
  private running = new Map<string, RunningTask>();
  private counter = 0;

  constructor(
    private readonly opts: {
      cfg: ZcodeConfigSection;
      /** 部署数据目录;任务工作区在其 zcode-tasks 子目录下。 */
      dataDir: string;
      onDone: TaskDoneListener;
    },
  ) {}

  /** 任务工作区的根目录;钩子侧用它识别后台任务会话。 */
  get tasksRoot(): string {
    return join(this.opts.dataDir, 'zcode-tasks');
  }

  list(): Array<{ id: string; task: string; startedAt: number }> {
    return [...this.running.values()].map(({ id, task, startedAt }) => ({ id, task, startedAt }));
  }

  /** 解析 zcode CLI 路径:配置优先,留空则探测 ZCode Desktop 的安装位置。 */
  resolveCli(): string | null {
    const configured = this.opts.cfg.cliPath.trim();
    if (configured) return existsSync(configured) ? configured : null;
    const localAppData = process.env['LOCALAPPDATA'];
    if (!localAppData) return null;
    const candidate = join(localAppData, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs');
    return existsSync(candidate) ? candidate : null;
  }

  /** 派出任务;失败时返回错误文本。 */
  run(task: string): { ok: true; id: string } | { ok: false; error: string } {
    const trimmed = task.trim();
    if (!trimmed) return { ok: false, error: '任务描述为空。' };
    const cli = this.resolveCli();
    if (!cli) {
      return {
        ok: false,
        error: '找不到 zcode 程序:请在 ZCode 世界设置里填写 cliPath(zcode CLI 的完整路径)。',
      };
    }
    this.counter += 1;
    const id = `zc-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${this.counter}`;
    if (!TASK_PREFIX_RE.test(id)) return { ok: false, error: '任务编号生成失败。' };
    const taskDir = join(this.tasksRoot, id);
    mkdirSync(taskDir, { recursive: true });

    const startedAt = Date.now();
    // --mode yolo:后台任务无人值守,全自动执行;--cwd 指向专属空目录,不绑定任何项目。
    const child = spawn(
      process.execPath,
      [cli, '-p', trimmed, '--mode', 'yolo', '--cwd', taskDir],
      { cwd: taskDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...providerEnv(cli) } },
    );
    this.running.set(id, { id, task: trimmed, startedAt, child });

    let tail = '';
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer): void => {
      tail = (tail + chunk.toString('utf8')).slice(-OUTPUT_TAIL_CHARS);
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    // 分钟级的配置,下限 5 秒:既防误杀,也留出可测试的区间。
    const timeoutMs = Math.max(5_000, this.opts.cfg.taskTimeoutMinutes * 60_000);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    const settle = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.running.delete(id);
      this.opts.onDone({
        id,
        task: trimmed,
        exitCode,
        timedOut,
        outputTail: tail.trim(),
        durationMs: Date.now() - startedAt,
      });
    };
    child.once('close', settle);
    child.once('error', (error) => {
      tail += `\n[启动失败] ${String(error)}`;
      settle(null);
    });

    return { ok: true, id };
  }

  /** World 停止时终止全部子进程;进程已退出时 kill 是空操作。 */
  stopAll(): void {
    for (const { child } of this.running.values()) child.kill();
    this.running.clear();
  }
}
