import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { dryMountWorld, fakeWorldContext } from 'cortico/extensions/dry-mount.ts';
import { ZCODE } from '../src/definition.ts';
import { ZCODE_DEFAULTS, type ZcodeConfigSection } from '../src/config.ts';
import { ZcodeWorld } from '../src/world.ts';
import { providerEnv } from '../src/runner.ts';
import { ensureHooks, hookForwardUrl } from '../src/hooks-config.ts';
import { FakeHost } from './helpers/fake-host.ts';

interface Mounted {
  world: ZcodeWorld;
  host: FakeHost;
  cfg: ZcodeConfigSection;
  scratchDir: string;
  port: number;
}

const active: Array<{ world: ZcodeWorld; scratchDir: string }> = [];

afterEach(async () => {
  while (active.length > 0) {
    const { world, scratchDir } = active.pop()!;
    await world.stop();
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

/** 起一个挂载好的 World:port 0 让系统分配随机端口;homeDir 指向临时目录,钩子自动配置不会碰真实用户目录。 */
async function mounted(overrides: Partial<ZcodeConfigSection> = {}): Promise<Mounted> {
  const scratchDir = mkdtempSync(join(tmpdir(), 'zcode-world-'));
  const ctx = fakeWorldContext(ZCODE, { scratchDir });
  const cfg = ctx.cfg;
  Object.assign(cfg, ZCODE_DEFAULTS, { port: 0 }, overrides);
  const world = new ZcodeWorld({
    cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    homeDir: join(scratchDir, 'home'),
  });
  const host = new FakeHost();
  await world.start(host);
  active.push({ world, scratchDir });
  const port = world.listeningPort!;
  expect(port).toBeGreaterThan(0);
  return { world, host, cfg, scratchDir, port };
}

async function post(port: number, type: string, body: Record<string, unknown>): Promise<number> {
  const res = await fetch(`http://127.0.0.1:${port}/api/event?type=${type}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await res.arrayBuffer();
  return res.status;
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const callTool = async (world: ZcodeWorld, name: string, args: Record<string, unknown> = {}) => {
  const tool = world.tools().find((t) => t.name === name)!;
  const ctx = {} as ToolCallContext;
  const out = await tool.handler(args, ctx);
  return typeof out === 'string' ? out : out.text;
};

/** 假 zcode CLI:打印参数后退出。 */
const quickCli = (dir: string): string => {
  const path = join(dir, 'fake-zcode.cjs');
  writeFileSync(path, "console.log('FAKE_OK ' + process.argv.slice(2).join(' '));\n");
  return path;
};

describe('ZCode World', () => {
  it('干装载不报失败:装载器会接受它', async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), 'zcode-world-'));
    const report = await dryMountWorld(ZCODE, { scratchDir });
    rmSync(scratchDir, { recursive: true, force: true });
    expect(report.failures).toEqual([]);
  });

  it('挂载时投一条 zcode.started 事件,origin 是 internal', async () => {
    const { world, host } = await mounted();
    expect(host.events.map((e) => e.type)).toEqual(['zcode.started']);
    expect(host.events[0]!.origin).toBe('internal');
    expect(world.listeningPort).toBeGreaterThan(0);
  });

  it('启动时自动补写 zcode 钩子并保留原有内容,挂载事件带说明', async () => {
    const { host, scratchDir } = await mounted();
    const configPath = join(scratchDir, 'home', '.zcode', 'cli', 'config.json');
    const saved = JSON.parse(readFileSync(configPath, 'utf8')) as {
      hooks: { enabled: boolean; events: Record<string, Array<{ hooks: Array<{ args: string[] }> }>> };
    };
    expect(saved.hooks.enabled).toBe(true);
    const urls = (saved.hooks.events['Stop'] ?? []).flatMap((g) => g.hooks.flatMap((h) => h.args));
    expect(urls.some((a) => a.includes('/api/event?type=stop'))).toBe(true);
    expect(host.events[0]!.text).toContain('钩子自动配置');
  });

  it('关闭自动配置时不写 zcode 配置', async () => {
    const { scratchDir } = await mounted({ autoConfigureHooks: false });
    expect(existsSync(join(scratchDir, 'home', '.zcode', 'cli', 'config.json'))).toBe(false);
  });

  it('配置口令后,带错口令的钩子请求被拒绝,带对口的正常处理', async () => {
    const { host, port } = await mounted({ hookToken: 's3cret' });
    const wrong = await post(port, 'stop', { session_id: 's-t', cwd: 'Y:\\proj', last_assistant_message: 'x' });
    expect(wrong).toBe(403);
    const ok = await fetch(`http://127.0.0.1:${port}/api/event?type=stop&token=s3cret`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 's-t', cwd: 'Y:\\proj', last_assistant_message: 'x' }),
    });
    expect(ok.status).toBe(204);
    await new Promise((r) => setTimeout(r, 100));
    // 没干过活,合法请求也不会推 session_done;这里只验证鉴权分支。
    expect(host.events.map((e) => e.type)).toEqual(['zcode.started']);
  });

  it('未干活的会话结束不推送 session_done', async () => {
    const { host, port } = await mounted();
    const status = await post(port, 'stop', {
      session_id: 's-plain',
      cwd: 'Y:\\proj',
      last_assistant_message: '你好,有什么可以帮你?',
    });
    expect(status).toBe(204);
    await new Promise((r) => setTimeout(r, 200));
    expect(host.events.map((e) => e.type)).toEqual(['zcode.started']);
  });

  it('干过活的会话结束推送 session_done,正文带事实与回复摘要', async () => {
    const { host, port } = await mounted();
    await post(port, 'tool', {
      session_id: 's-work',
      cwd: 'Y:\\proj',
      tool_name: 'Edit',
      tool_input: { file_path: 'Y:\\proj\\a.ts' },
    });
    await post(port, 'tool', {
      session_id: 's-work',
      cwd: 'Y:\\proj',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' },
    });
    await post(port, 'stop', {
      session_id: 's-work',
      cwd: 'Y:\\proj',
      last_assistant_message: '测试全部通过,共 12 项。',
    });
    await waitFor(() => host.events.some((e) => e.type === 'zcode.session_done'));
    const done = host.events.find((e) => e.type === 'zcode.session_done')!;
    expect(done.origin).toBe('external');
    expect(done.text).toContain('调用工具 2 次');
    expect(done.text).toContain('Edit×1');
    expect(done.text).toContain('a.ts');
    expect(done.text).toContain('测试全部通过');
    expect(done.meta).toMatchObject({ sessionId: 's-work', cwd: 'Y:\\proj', toolCalls: 2 });
  });

  it('后台任务目录里的 stop 不推 session_done', async () => {
    const { host, port, scratchDir } = await mounted();
    const taskCwd = join(scratchDir, 'deployment', 'data', 'zcode-tasks', 'zc-test-1');
    await post(port, 'tool', {
      session_id: 's-task',
      cwd: taskCwd,
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    });
    await post(port, 'stop', { session_id: 's-task', cwd: taskCwd, last_assistant_message: 'done' });
    await new Promise((r) => setTimeout(r, 200));
    expect(host.events.map((e) => e.type)).toEqual(['zcode.started']);
  });

  it('到点且有活动才推 progress;无活动、未到点或关闭时不推', async () => {
    const { world, host, cfg, port } = await mounted({ intervalMinutes: 10 });

    const postTool = () =>
      post(port, 'tool', {
        session_id: 's-progress',
        cwd: 'Y:\\proj',
        tool_name: 'Read',
        tool_input: { file_path: 'Y:\\proj\\b.ts' },
      });

    // 未到点:间隔 10 分钟,刚挂载不久,有活动也不推。
    await postTool();
    await world.reportProgress();
    expect(host.events.filter((e) => e.type === 'zcode.progress').length).toBe(0);

    // 热改间隔到极短,越过间隔后推送。
    cfg.intervalMinutes = 0.001;
    await new Promise((r) => setTimeout(r, 80));
    await world.reportProgress();
    await waitFor(() => host.events.some((e) => e.type === 'zcode.progress'));
    const progress = host.events.find((e) => e.type === 'zcode.progress')!;
    expect(progress.text).toContain('Read×1');

    // 无新增活动:再次到点也不推。
    await new Promise((r) => setTimeout(r, 80));
    await world.reportProgress();
    expect(host.events.filter((e) => e.type === 'zcode.progress').length).toBe(1);

    // intervalMinutes = 0 时彻底关闭。
    cfg.intervalMinutes = 0;
    await post(port, 'tool', {
      session_id: 's-progress',
      cwd: 'Y:\\proj',
      tool_name: 'Bash',
      tool_input: { command: 'echo more' },
    });
    await new Promise((r) => setTimeout(r, 80));
    await world.reportProgress();
    expect(host.events.filter((e) => e.type === 'zcode.progress').length).toBe(1);
  });

  it('zcode_run 派出后台任务,进程退出后推 task_done', async () => {
    const cli = quickCli(mkdtempSync(join(tmpdir(), 'zcode-fakecli-')));
    const { world, host } = await mounted({ cliPath: cli });
    const receipt = await callTool(world, 'zcode_run', { task: '把示例目录整理一遍' });
    expect(receipt).toContain('已派出');
    await waitFor(() => host.events.some((e) => e.type === 'zcode.task_done'));
    const done = host.events.find((e) => e.type === 'zcode.task_done')!;
    expect(done.text).toContain('把示例目录整理一遍');
    expect(done.text).toContain('FAKE_OK');
    expect(done.meta).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it('zcode_tasks 列出运行中的任务,结束后清空', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-fakecli-'));
    const cli = join(dir, 'slow-zcode.cjs');
    writeFileSync(cli, "setTimeout(() => console.log('SLOW_DONE'), 400);\n");
    const { world, host } = await mounted({ cliPath: cli });
    await callTool(world, 'zcode_run', { task: '慢任务' });
    const listing = await callTool(world, 'zcode_tasks');
    expect(listing).toContain('慢任务');
    await waitFor(() => host.events.some((e) => e.type === 'zcode.task_done'));
    const after = await callTool(world, 'zcode_tasks');
    expect(after).not.toContain('慢任务');
  });

  it('CLI 路径无效时 zcode_run 给失败回执', async () => {
    const { world } = await mounted({ cliPath: 'Z:\\不存在\\zcode.cjs' });
    const receipt = await callTool(world, 'zcode_run', { task: '任何任务' });
    expect(receipt).toContain('派出失败');
  });

  it('后台任务超时被终止并在 task_done 里注明', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zcode-fakecli-'));
    const cli = join(dir, 'hang-zcode.cjs');
    writeFileSync(cli, "setTimeout(() => {}, 1e9);\n");
    const { world, host } = await mounted({ cliPath: cli, taskTimeoutMinutes: 0.001 });
    await callTool(world, 'zcode_run', { task: '卡住的任务' });
    await waitFor(() => host.events.some((e) => e.type === 'zcode.task_done'), 15000);
    const done = host.events.find((e) => e.type === 'zcode.task_done')!;
    expect(done.text).toContain('超过时限被终止');
    expect(done.meta).toMatchObject({ timedOut: true });
  });
});

describe('providerEnv', () => {
  const touch = (path: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{}');
  };

  it('Desktop 布局:用环境变量指向实际的内置与个人配置', () => {
    const root = mkdtempSync(join(tmpdir(), 'zcode-penv-'));
    const cli = join(root, 'resources', 'glm', 'zcode.cjs');
    const home = join(root, 'home');
    touch(join(root, 'resources', 'config', 'provider', 'zcode-builtin.json'));
    touch(join(home, '.zcode', 'v2', 'provider_config.json'));
    expect(providerEnv(cli, home)).toEqual({
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(root, 'resources', 'config', 'provider', 'zcode-builtin.json'),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(home, '.zcode', 'v2', 'provider_config.json'),
    });
  });

  it('CLI 旁自带 provider 目录时不注入', () => {
    const root = mkdtempSync(join(tmpdir(), 'zcode-penv-'));
    const cli = join(root, 'glm', 'zcode.cjs');
    touch(join(root, 'glm', 'provider', 'zcode-builtin.json'));
    expect(providerEnv(cli, join(root, 'home'))).toEqual({});
  });

  it('两处都找不到配置时不注入', () => {
    const root = mkdtempSync(join(tmpdir(), 'zcode-penv-'));
    const cli = join(root, 'resources', 'glm', 'zcode.cjs');
    expect(providerEnv(cli, join(root, 'home'))).toEqual({});
  });
});

describe('ensureHooks', () => {
  it('文件不存在时创建完整转发并启用 hooks', () => {
    const configPath = join(mkdtempSync(join(tmpdir(), 'zcode-hooks-')), 'config.json');
    const result = ensureHooks(configPath, 4761);
    expect(result).toMatchObject({ changed: true, added: ['Stop', 'PostToolUse'], enabledSet: true });
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    const urls: string[] = saved.hooks.events.Stop.flatMap((g: { hooks: Array<{ args: string[] }> }) =>
      g.hooks.flatMap((h) => h.args),
    );
    expect(urls).toContain(hookForwardUrl(4761, 'stop'));
  });

  it('已就绪时幂等:不改文件', () => {
    const configPath = join(mkdtempSync(join(tmpdir(), 'zcode-hooks-')), 'config.json');
    ensureHooks(configPath, 4761);
    const before = readFileSync(configPath, 'utf8');
    const result = ensureHooks(configPath, 4761);
    expect(result.changed).toBe(false);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  it('只追加缺失的条目,保留已有钩子与其他顶层键', () => {
    const configPath = join(mkdtempSync(join(tmpdir(), 'zcode-hooks-')), 'config.json');
    const original = {
      plugins: { keep: true },
      hooks: {
        enabled: true,
        events: {
          Stop: [{ hooks: [{ type: 'process', command: 'notify-send', args: ['done'] }] }],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(original, null, 2));
    const result = ensureHooks(configPath, 4761);
    // Stop 里只有别的钩子、没有转发,所以两条都补。
    expect(result).toMatchObject({ changed: true, added: ['Stop', 'PostToolUse'], enabledSet: false });
    const saved = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(saved.plugins).toEqual({ keep: true });
    const stopCommands = saved.hooks.events.Stop.flatMap((g: { hooks: Array<{ command: string }> }) =>
      g.hooks.map((h) => h.command),
    );
    expect(stopCommands).toContain('notify-send');
    expect(stopCommands).toContain('curl');
  });

  it('配置损坏时拒绝改写', () => {
    const configPath = join(mkdtempSync(join(tmpdir(), 'zcode-hooks-')), 'config.json');
    writeFileSync(configPath, '{broken json');
    const result = ensureHooks(configPath, 4761);
    expect(result.changed).toBe(false);
    expect(result.error).toContain('合法 JSON');
    expect(readFileSync(configPath, 'utf8')).toBe('{broken json');
  });
});
