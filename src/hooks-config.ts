/** zcode 侧钩子的自动配置:检测 ~/.zcode/cli/config.json 的转发,缺失时原子补写;只追加,不改已有条目。 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface EnsureHooksResult {
  /** 是否写回了文件。 */
  changed: boolean;
  /** 新增转发的事件名。 */
  added: string[];
  /** hooks.enabled 从非 true 翻成了 true。 */
  enabledSet: boolean;
  /** 有值时不做任何写入,原因进事件文本。 */
  error?: string;
}

/** 本 World 依赖的两条转发:事件名 → /api/event 的查询参数。 */
const FORWARDS: ReadonlyArray<readonly [string, string]> = [
  ['Stop', 'stop'],
  ['PostToolUse', 'tool'],
];

export const hookForwardUrl = (port: number, query: string): string =>
  `http://127.0.0.1:${port}/api/event?type=${query}`;

export const zcodeConfigPath = (homeDir: string): string =>
  join(homeDir, '.zcode', 'cli', 'config.json');

type HookEntry = { type?: unknown; command?: unknown; args?: unknown[]; timeoutMs?: unknown };
type MatcherGroup = { hooks?: HookEntry[] };

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 一组 matcher 条目里是否已有指向目标地址的 process 钩子。 */
const hasForward = (groups: unknown, url: string): boolean => {
  if (!Array.isArray(groups)) return false;
  for (const group of groups) {
    if (!isPlainObject(group) || !Array.isArray(group['hooks'])) continue;
    for (const hook of group['hooks']) {
      if (!isPlainObject(hook) || hook['type'] !== 'process') continue;
      if (Array.isArray(hook['args']) && hook['args'].includes(url)) return true;
    }
  }
  return false;
};

/** 与手工配置一致的转发钩子:超时和 curl 参数照抄 zcode 钩子文档的推荐形态。 */
const forwardHook = (url: string): HookEntry => ({
  type: 'process',
  command: 'curl',
  args: ['-s', '--max-time', '2', '--data-binary', '@-', url],
  timeoutMs: 4000,
});

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function ensureHooks(configPath: string, port: number): EnsureHooksResult {
  const untouched = { changed: false, added: [] as string[], enabledSet: false };
  let root: Record<string, unknown>;
  if (existsSync(configPath)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch (error) {
      return { ...untouched, error: `zcode 配置不是合法 JSON,未改动:${message(error)}` };
    }
    if (!isPlainObject(parsed)) {
      return { ...untouched, error: 'zcode 配置顶层不是 JSON 对象,未改动。' };
    }
    root = parsed;
  } else {
    root = {};
  }

  const hooks: Record<string, unknown> = isPlainObject(root['hooks'])
    ? { ...(root['hooks'] as Record<string, unknown>) }
    : {};
  const events: Record<string, unknown> = isPlainObject(hooks['events'])
    ? { ...(hooks['events'] as Record<string, unknown>) }
    : {};
  const added: string[] = [];
  for (const [event, query] of FORWARDS) {
    const url = hookForwardUrl(port, query);
    if (hasForward(events[event], url)) continue;
    // 只追加条目:已有的 matcher 组与别的钩子原样保留。
    const groups = Array.isArray(events[event]) ? [...(events[event] as unknown[])] : [];
    groups.push({ hooks: [forwardHook(url)] });
    events[event] = groups;
    added.push(event);
  }
  let enabledSet = false;
  if (hooks['enabled'] !== true) {
    hooks['enabled'] = true;
    enabledSet = true;
  }
  if (added.length === 0 && !enabledSet) return { ...untouched, added };

  hooks['events'] = events;
  root['hooks'] = hooks;
  try {
    mkdirSync(dirname(configPath), { recursive: true });
    // 原子替换:写临时文件再改名,失败时不留半个配置。
    const tmp = `${configPath}.zcode-world-tmp`;
    writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, 'utf8');
    renameSync(tmp, configPath);
  } catch (error) {
    return { changed: false, added, enabledSet, error: `写入 zcode 配置失败:${message(error)}` };
  }
  return { changed: true, added, enabledSet };
}
