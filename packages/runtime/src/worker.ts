import { createInterface } from 'node:readline';
import { format } from 'node:util';
import { MesnierRuntime, RuntimeError, errorPayload, type RunInput } from './engine';

// 子进程不继承其他 Agent 或模型 SDK 的账号覆盖项；所有认证从本次 RPC 显式传入。
for (const key of Object.keys(process.env)) {
  if (/^(KIMI_|KIMI_CODE_|ANTHROPIC_|OPENAI_)/.test(key) || ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'MESNIER_RUNTIME_API_KEY'].includes(key)) {
    delete process.env[key];
  }
}

const secrets = new Set<string>();
let stdoutOpen = true;
let stderrOpen = true;
function redact(text: string) {
  for (const secret of secrets) text = text.split(secret).join('[已隐藏凭据]');
  return text;
}
function diagnostic(message: string) {
  if (!stderrOpen || process.stderr.destroyed) return;
  try { process.stderr.write(message); } catch { stderrOpen = false; void stop(); }
}
for (const name of ['log', 'info', 'debug', 'warn', 'error'] as const) {
  console[name] = (...args: unknown[]) => { diagnostic(`${redact(format(...args))}\n`); };
}
const send = (message: unknown) => {
  if (!stdoutOpen || process.stdout.destroyed) return;
  try { process.stdout.write(`${JSON.stringify(message, (_key, item: unknown) => typeof item === 'string' ? redact(item) : item)}\n`); }
  catch { stdoutOpen = false; void stop(); }
};
const runtime = new MesnierRuntime((event) => send({ event }));
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closing = false;
// 宿主崩溃会同时关闭所有管道；EPIPE 不能绕过内核与工具组的停止收尾。
process.stdout.on('error', () => { stdoutOpen = false; void stop(); });
process.stderr.on('error', () => { stderrOpen = false; void stop(); });
process.stdin.on('error', () => { void stop(); });

lines.on('line', (line) => {
  void dispatch(line);
});

async function dispatch(line: string) {
  let id: string | null = null;
  try {
    if (line.length > 4 * 1024 * 1024) throw new RuntimeError('rpc.too_large', '请求超过 4 MiB 限制');
    let request: { id: string; method: string; params?: Record<string, unknown> };
    try { request = JSON.parse(line); } catch { throw new RuntimeError('rpc.invalid_json', '请求不是有效 JSON'); }
    if (typeof request.id !== 'string' || !request.id || typeof request.method !== 'string') throw new RuntimeError('rpc.invalid', '请求必须包含 id 和 method');
    id = request.id;
    const params = request.params ?? {};
    let result: unknown;
    if (closing) throw new RuntimeError('runtime.closing', '运行时正在关闭');
    switch (request.method) {
      case 'info': result = runtime.info(); break;
      case 'run': {
        const input = params as unknown as RunInput;
        if (typeof input.modelConfig?.apiKey === 'string' && input.modelConfig.apiKey) secrets.add(input.modelConfig.apiKey);
        result = runtime.start(input);
        break;
      }
      case 'approve': result = runtime.approve(String(params.runId), String(params.requestId), params.decision as 'approved' | 'rejected'); break;
      case 'cancel': result = await runtime.cancel(String(params.runId)); break;
      case 'shutdown':
        closing = true;
        await runtime.dispose();
        result = { closed: true };
        break;
      default: throw new RuntimeError('rpc.method_unknown', `未知方法：${request.method}`);
    }
    send({ id, result });
    if (request.method === 'shutdown') {
      lines.close();
      if (stdoutOpen && !process.stdout.destroyed) process.stdout.write('', () => process.exit(0));
      else process.exit(0);
    }
  } catch (error) {
    send({ id, error: errorPayload(error) });
  }
}

async function stop() {
  if (closing) return;
  closing = true;
  try {
    await runtime.dispose();
  } catch (error) {
    diagnostic(`Mesnier Agent 关闭失败：${errorPayload(error).message}\n`);
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

lines.on('close', () => { if (!closing) void stop(); });
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
