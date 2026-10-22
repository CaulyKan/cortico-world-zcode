/** 本机回环地址上的钩子接收端:ZCode 的 hooks 把事件 POST 到 /api/event?type=…,body 是钩子输入 JSON。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

/** 从钩子 JSON 里解析出的、本 World 关心的字段。 */
export interface HookPayload {
  /** URL 查询参数 type:stop | tool | permission。 */
  kind: 'stop' | 'tool' | 'permission';
  sessionId: string;
  cwd: string;
  toolName: string;
  /** 钩子输入的 tool_input;对象或字符串。 */
  toolInput: unknown;
  toolResponse: string;
  /** Stop 事件带的最终回复全文。 */
  lastAssistantMessage: string;
}

export type HookHandler = (payload: HookPayload) => void | Promise<void>;

/** 请求体上限:钩子输入含 transcript 摘要,留足余量也防滥用。 */
const MAX_BODY_BYTES = 2 * 1024 * 1024;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export class HookServer {
  private server: Server | null = null;
  private boundPort = 0;

  constructor(
    private readonly port: number,
    private readonly handler: HookHandler,
  ) {}

  /** 实际监听的端口;配置为 0 时是系统分配的随机端口。 */
  get actualPort(): number {
    return this.boundPort;
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => {
      this.route(req, res).catch(() => this.reply(res, 500));
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // 只绑回环地址:事件来自本机的 zcode 钩子,不对外网开放。
      server.listen(this.port, '127.0.0.1', () => {
        const address = server.address();
        this.boundPort = typeof address === 'object' && address ? address.port : this.port;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    // fetch 的连接池会保持 keep-alive 连接,一并掐断,让 close 立即完成。
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.boundPort = 0;
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'POST' || url.pathname !== '/api/event') {
      this.reply(res, 404);
      return;
    }
    const kind = url.searchParams.get('type');
    if (kind !== 'stop' && kind !== 'tool' && kind !== 'permission') {
      this.reply(res, 404);
      return;
    }
    const body = await this.readBody(req);
    if (body === null) {
      this.reply(res, 413);
      return;
    }
    let parsed: unknown = {};
    try {
      parsed = body.length ? (JSON.parse(body.toString('utf8')) as unknown) : {};
    } catch {
      // 钩子配置了 --max-time 2:内容异常也尽快回应,不让 curl 挂着。
      this.reply(res, 204);
      return;
    }
    const input = (parsed ?? {}) as Record<string, unknown>;
    try {
      await this.handler({
        kind,
        sessionId: str(input.session_id),
        cwd: str(input.cwd),
        toolName: str(input.tool_name),
        toolInput: input.tool_input,
        toolResponse: str(input.tool_response),
        lastAssistantMessage: str(input.last_assistant_message),
      });
    } catch {
      // 处理失败不影响回应:钩子无需重试。
    }
    // 空响应:钩子的 stdout 会被 zcode 按 JSON 解析,必须保持为空。
    this.reply(res, 204);
  }

  private readBody(req: IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          resolve(null);
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', () => resolve(Buffer.concat(chunks)));
    });
  }

  private reply(res: ServerResponse, status: number): void {
    if (!res.headersSent) res.writeHead(status);
    res.end();
  }
}
