/** 会话活动账本:记下钩子报来的工具调用,汇总成给桌宠看的事实文本。不落盘,重启即清。 */
import type { HookPayload } from './server.ts';

interface SessionActivity {
  sessionId: string;
  cwd: string;
  firstToolTs: number;
  lastToolTs: number;
  toolCalls: number;
  /** 已计入上一次 progress 汇报的调用数。 */
  reportedCalls: number;
  toolCounts: Map<string, number>;
  files: Set<string>;
  commands: string[];
}

/** 单会话的活动摘要,供事件正文与 meta 使用。 */
export interface ActivitySnapshot {
  sessionId: string;
  cwd: string;
  toolCalls: number;
  toolCounts: Array<[string, number]>;
  files: string[];
  commands: string[];
  spanMs: number;
}

const collectFiles = (toolName: string, toolInput: unknown, files: Set<string>): void => {
  if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'Read') return;
  const path =
    typeof toolInput === 'object' && toolInput !== null
      ? (toolInput as Record<string, unknown>).file_path
      : undefined;
  if (typeof path === 'string' && path) files.add(path);
};

const collectCommand = (toolName: string, toolInput: unknown, commands: string[]): void => {
  if (toolName !== 'Bash') return;
  const command =
    typeof toolInput === 'object' && toolInput !== null
      ? (toolInput as Record<string, unknown>).command
      : undefined;
  if (typeof command === 'string' && command) commands.push(command);
};

export class ActivityTracker {
  private sessions = new Map<string, SessionActivity>();

  /** 钩子的 tool 事件:只记账,不推送。 */
  recordTool(payload: HookPayload, now = Date.now()): void {
    if (!payload.sessionId || !payload.toolName) return;
    let s = this.sessions.get(payload.sessionId);
    if (!s) {
      s = {
        sessionId: payload.sessionId,
        cwd: payload.cwd,
        firstToolTs: now,
        lastToolTs: now,
        toolCalls: 0,
        reportedCalls: 0,
        toolCounts: new Map(),
        files: new Set(),
        commands: [],
      };
      this.sessions.set(payload.sessionId, s);
    }
    s.lastToolTs = now;
    if (!s.cwd && payload.cwd) s.cwd = payload.cwd;
    s.toolCalls += 1;
    s.toolCounts.set(payload.toolName, (s.toolCounts.get(payload.toolName) ?? 0) + 1);
    collectFiles(payload.toolName, payload.toolInput, s.files);
    collectCommand(payload.toolName, payload.toolInput, s.commands);
  }

  /** 钩子的 stop 事件:干过活才值得通知。返回摘要;没干过活或会话未知返回 null。 */
  settleSession(payload: HookPayload, now = Date.now()): ActivitySnapshot | null {
    const s = this.sessions.get(payload.sessionId);
    if (!s || s.toolCalls <= 0) return null;
    const snapshot = this.snapshot(s, now);
    this.sessions.delete(payload.sessionId);
    return snapshot;
  }

  /** 当前的全部活动快照,供查询工具使用。 */
  listActive(now = Date.now()): ActivitySnapshot[] {
    return [...this.sessions.values()].map((s) => this.snapshot(s, now));
  }

  /** 定时汇报:有未汇报的活动时返回摘要列表,并把账目记为已汇报;否则返回空数组。 */
  collectUnreported(now = Date.now()): ActivitySnapshot[] {
    const active: ActivitySnapshot[] = [];
    for (const s of this.sessions.values()) {
      if (s.toolCalls <= s.reportedCalls) continue;
      active.push(this.snapshot(s, now));
      s.reportedCalls = s.toolCalls;
    }
    return active;
  }

  /** 结束一轮但没到 stop(如进程退出)时的兜底清理。 */
  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private snapshot(s: SessionActivity, now: number): ActivitySnapshot {
    return {
      sessionId: s.sessionId,
      cwd: s.cwd,
      toolCalls: s.toolCalls,
      toolCounts: [...s.toolCounts.entries()].sort((a, b) => b[1] - a[1]),
      files: [...s.files],
      commands: s.commands.slice(-3),
      spanMs: Math.max(0, now - s.firstToolTs),
    };
  }
}

/** 把摘要列成事实文本:工具用量、涉及文件与命令,不替桌宠下结论。 */
export const describeSnapshot = (snap: ActivitySnapshot): string => {
  const tools = snap.toolCounts.map(([name, n]) => `${name}×${n}`).join('、');
  const parts: string[] = [`调用工具 ${snap.toolCalls} 次(${tools})`];
  if (snap.files.length) {
    const shown = snap.files.slice(0, 6).map((f) => f.split(/[\\/]/).pop() ?? f);
    parts.push(`涉及文件 ${shown.join('、')}${snap.files.length > 6 ? ' 等' : ''}`);
  }
  if (snap.commands.length) {
    const cmds = snap.commands.map((c) => (c.length > 60 ? `${c.slice(0, 60)}…` : c));
    parts.push(`最近的命令:${cmds.join(' | ')}`);
  }
  const minutes = Math.round(snap.spanMs / 60000);
  parts.push(minutes >= 1 ? `持续约 ${minutes} 分钟` : '持续不足 1 分钟');
  const where = snap.cwd ? `(${snap.cwd})` : '';
  return `${where}${parts.join(';')}`;
};

/** 截取回复开头若干字,作为气泡总结的素材。 */
export const excerpt = (text: string, limit = 500): string => {
  const clean = text.trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
};
