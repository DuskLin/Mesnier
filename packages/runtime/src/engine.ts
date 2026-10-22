import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { access, chmod, mkdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { stringify } from 'smol-toml';
import {
  createKimiHarness,
  type ApprovalResponse,
  type Event as KimiEvent,
  type KimiHarness,
  type Session,
} from '@moonshot-ai/kimi-code-sdk';
import type { RunInput, RuntimeEvent, RuntimeEventKind } from './protocol';
export type { RunInput, RuntimeEvent, RuntimeModelConfig } from './protocol';

export const RUNTIME_VERSION = '0.1.0';
export const UPSTREAM_COMMIT = '44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1';
const CREDENTIAL_ENV = 'MESNIER_RUNTIME_API_KEY';

interface ActiveRun {
  input: RunInput;
  harness?: KimiHarness;
  session?: Session;
  cancelRequested: boolean;
  finish: Promise<void>;
  approvals: Map<string, (value: ApprovalResponse) => void>;
  processGroups: Map<number, number | undefined>;
}

export class RuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class MesnierRuntime {
  private active?: ActiveRun;
  private readonly seen = new Set<string>();
  private closing = false;

  constructor(private readonly onEvent: (event: RuntimeEvent) => void) {}

  info() {
    return {
      name: 'Mesnier Agent',
      version: RUNTIME_VERSION,
      upstreamCommit: UPSTREAM_COMMIT,
      sdkVersion: '0.21.1',
      nodeVersion: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      activeRunId: this.active?.input.runId,
      capabilities: { approval: true, cancel: true, resume: true, steer: false },
    };
  }

  start(input: RunInput): { accepted: true; runId: string } {
    validateInput(input);
    if (this.closing) throw new RuntimeError('runtime.closing', '运行时正在关闭');
    if (this.seen.has(input.runId)) throw new RuntimeError('run.duplicate', '该执行已接收，不会重复运行');
    if (this.active) throw new RuntimeError('runtime.busy', '运行时已有活动执行');
    const run: ActiveRun = {
      input: structuredClone(input),
      cancelRequested: false,
      finish: Promise.resolve(),
      approvals: new Map(),
      processGroups: new Map(),
    };
    this.seen.add(input.runId);
    this.active = run;
    run.finish = this.execute(run);
    return { accepted: true, runId: input.runId };
  }

  approve(runId: string, requestId: string, decision: 'approved' | 'rejected') {
    const run = this.requireRun(runId);
    if (decision !== 'approved' && decision !== 'rejected') {
      throw new RuntimeError('approval.invalid', '不支持的权限决定');
    }
    const resolveApproval = run.approvals.get(requestId);
    if (!resolveApproval) throw new RuntimeError('approval.stale', '权限请求已处理或已失效');
    run.approvals.delete(requestId);
    resolveApproval({ decision });
    this.emit(run, 'approval.resolved', { requestId, decision });
    return { accepted: true };
  }

  async cancel(runId: string) {
    const run = this.requireRun(runId);
    run.cancelRequested = true;
    this.resolvePending(run);
    await run.session?.cancel();
    return { accepted: true };
  }

  async dispose() {
    this.closing = true;
    const run = this.active;
    if (!run) return;
    await this.cancel(run.input.runId);
    await run.finish;
  }

  private requireRun(runId: string): ActiveRun {
    if (!this.active || this.active.input.runId !== runId) {
      throw new RuntimeError('run.inactive', '该执行已结束或不属于当前运行时');
    }
    return this.active;
  }

  private emit(run: ActiveRun, kind: RuntimeEventKind, payload: Record<string, unknown>) {
    const safe = redact(payload, run.input.modelConfig.apiKey);
    this.onEvent({ id: randomUUID(), runId: run.input.runId, kind, payload: safe, at: new Date().toISOString() });
  }

  private resolvePending(run: ActiveRun) {
    for (const [requestId, resolver] of run.approvals) {
      resolver({ decision: 'cancelled' });
      this.emit(run, 'approval.resolved', { requestId, decision: 'cancelled' });
    }
    run.approvals.clear();
  }

  private observeProcess(run: ActiveRun, event: { kind: 'started' | 'exited'; pid: number; pgid?: number }) {
    const { kind, ...identity } = event;
    if (kind === 'started') run.processGroups.set(event.pid, event.pgid);
    let members: Array<{ pid: number; pgid: number; born: string }> | undefined;
    if (kind === 'exited' && event.pgid && run.processGroups.get(event.pid) === event.pgid && process.platform !== 'win32') {
      try {
        // 在实际子进程退出回调内采集，同步保留 leader 退出后的同组成员归属。
        members = execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat=,lstart='], {
          encoding: 'utf8', timeout: 1000, env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
        }).split('\n').flatMap((line) => {
          const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
          return match && Number(match[2]) === event.pgid && !match[3]!.startsWith('Z')
            ? [{ pid: Number(match[1]), pgid: Number(match[2]), born: match[4]! }] : [];
        });
      } catch { /* 采集失败不猜测归属，宿主保持待核对边界。 */ }
    }
    this.emit(run, `process.${kind}`, { ...identity, ...(members ? { members } : {}) });
  }

  private async execute(run: ActiveRun) {
    let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    let failure: { code: string; message: string } | undefined;
    let unsubscribe: (() => void) | undefined;
    let restoreFetch: (() => void) | undefined;
    try {
      const input = run.input;
      const workspace = await realpath(input.workspace);
      if (!(await stat(workspace)).isDirectory()) throw new RuntimeError('workspace.invalid', '工作路径不是目录');
      await access(workspace, constants.R_OK | constants.W_OK | constants.X_OK);
      const homeDir = join(resolve(input.profileRoot), 'agent');
      await mkdir(homeDir, { recursive: true, mode: 0o700 });
      await chmod(homeDir, 0o700);
      await mkdir(join(homeDir, 'skills'), { recursive: true, mode: 0o700 });
      const configPath = join(homeDir, 'config.toml');

      // 运行时由独立子进程持有，凭据仅注入本次进程，配置文件只保存引用。
      process.env['KIMI_CODE_HOME'] = homeDir;
      process.env['KIMI_CODE_REGION_MARKER'] = 'off';
      // 上游诊断可能包含供应方原始错误正文，产品只保存已脱敏的结构化事件。
      process.env['KIMI_LOG_LEVEL'] = 'off';
      restoreFetch = guardProviderErrors(input.modelConfig.apiKey);
      const config = {
        telemetry: false,
        autoSessionTitle: false,
        defaultProvider: 'mesnier',
        defaultModel: 'mesnier',
        defaultPermissionMode: input.approvalMode === 'auto' ? 'yolo' : 'manual',
        permission: { rules: input.approvalMode === 'manual'
          ? ['Write', 'Edit', 'Bash'].map((pattern) => ({ decision: 'ask', scope: 'user', pattern }))
          : [] },
        providers: { mesnier: {
          type: input.modelConfig.provider,
          baseUrl: input.modelConfig.baseUrl,
          apiKeyEnv: CREDENTIAL_ENV,
        } },
        models: { mesnier: {
          provider: 'mesnier',
          model: input.modelConfig.model,
          maxContextSize: input.modelConfig.maxContextSize ?? 128000,
        } },
        modelCatalog: { refreshOnStart: false, refreshIntervalMs: 0 },
        loopControl: { maxStepsPerTurn: 100, maxAttemptsPerStep: 2 },
        background: { keepAliveOnExit: false },
      };
      const pendingPath = `${configPath}.${process.pid}.tmp`;
      await writeFile(pendingPath, stringify(config), { mode: 0o600 });
      await rename(pendingPath, configPath);
      const harness = createKimiHarness({
        homeDir,
        osHomeDir: homeDir,
        env: { ...process.env, [CREDENTIAL_ENV]: input.modelConfig.apiKey || 'not-required' },
        configPath,
        displayName: 'Mesnier Agent',
        processObserver: (event) => this.observeProcess(run, event),
        identity: { productName: 'Mesnier-Agent', version: RUNTIME_VERSION, platform: 'mesnier_desktop' },
        skillDirs: [join(homeDir, 'skills')],
        telemetry: { track() {} },
      });
      run.harness = harness;
      const session = input.sessionId
        ? await harness.resumeSession({ id: input.sessionId })
        : await harness.createSession({
            workDir: workspace,
            model: 'mesnier',
            permission: input.approvalMode === 'auto' ? 'yolo' : 'manual',
          });
      run.session = session;
      if (await realpath(session.workDir) !== workspace) {
        throw new RuntimeError('session.workspace_mismatch', '原会话的工作目录与当前项目不一致，未提交输入');
      }
      await session.setModel('mesnier');
      await session.setPermission(input.approvalMode === 'auto' ? 'yolo' : 'manual');
      this.emit(run, 'session.ready', { sessionId: session.id, resumed: Boolean(input.sessionId), workspace });

      let resolveEnd!: (event: Extract<KimiEvent, { type: 'turn.ended' }>) => void;
      const ended = new Promise<Extract<KimiEvent, { type: 'turn.ended' }>>((resolve) => { resolveEnd = resolve; });
      unsubscribe = session.onEvent((event) => {
        this.forwardEvent(run, event);
        if (event.type === 'turn.ended' && event.agentId === 'main') resolveEnd(event);
      });
      session.setApprovalHandler((request) => {
        if (run.cancelRequested) return { decision: 'cancelled' };
        const requestId = randomUUID();
        return new Promise<ApprovalResponse>((resolve) => {
          run.approvals.set(requestId, resolve);
          this.emit(run, 'approval.requested', { requestId, ...request });
        });
      });
      session.setQuestionHandler(() => {
        this.emit(run, 'warning', { message: '当前版本暂不支持工具问卷，请在对话中补充信息后再次提交。' });
        return null;
      });
      if (run.cancelRequested) {
        outcome = 'cancelled';
      } else {
        await session.prompt(input.prompt, { promptId: input.runId });
        const result = await ended;
        outcome = result.reason === 'completed' ? 'completed' : result.reason === 'cancelled' ? 'cancelled' : 'failed';
        if (outcome === 'failed') failure = {
          code: result.error?.code ?? `run.${result.reason}`,
          message: result.error?.message ?? (result.reason === 'blocked' ? '执行受到阻塞，需要检查上下文与权限' : '执行失败'),
        };
        const status = await session.getStatus();
        this.emit(run, 'usage', { available: Boolean(status.usage), usage: status.usage ?? null });
      }
    } catch (error) {
      failure = errorPayload(error);
      outcome = 'failed';
    } finally {
      this.resolvePending(run);
      unsubscribe?.();
      try {
        await run.harness?.close();
      } catch (error) {
        outcome = 'failed';
        failure = { code: 'runtime.close_failed', message: `运行时收尾失败：${errorPayload(error).message}` };
      }
      restoreFetch?.();
      this.active = undefined;
    }
    // 收尾检查结束后才发布最终结果，避免成功结果掩盖关闭失败。
    this.emit(run, `run.${outcome}`, {
      sessionId: run.session?.id,
      ...(failure ? { error: failure } : {}),
    });
  }

  private forwardEvent(run: ActiveRun, event: KimiEvent) {
    if (event.type === 'assistant.delta' || event.type === 'thinking.delta') {
      this.emit(run, event.type, { text: event.delta, agentId: event.agentId });
    } else if (event.type === 'tool.call.started') {
      this.emit(run, 'tool.started', { ...event });
    } else if (event.type === 'tool.result' || event.type === 'tool.progress') {
      this.emit(run, event.type, { ...event });
    } else if (event.type === 'error' || event.type === 'warning' || event.type === 'turn.step.retrying') {
      this.emit(run, event.type, { ...event });
    }
  }
}

function validateInput(input: RunInput) {
  if (!input || typeof input !== 'object') throw new RuntimeError('input.invalid', '执行参数无效');
  for (const key of ['runId', 'profileRoot', 'workspace', 'prompt'] as const) {
    if (typeof input[key] !== 'string' || !input[key].trim()) throw new RuntimeError('input.invalid', `缺少执行参数：${key}`);
  }
  if (!isAbsolute(input.profileRoot) || !isAbsolute(input.workspace)) throw new RuntimeError('input.invalid', '配置目录和工作目录必须使用绝对路径');
  if (!['manual', 'auto'].includes(input.approvalMode)) throw new RuntimeError('input.invalid', '权限模式无效');
  const config = input.modelConfig;
  if (!config || !['openai', 'openai_responses', 'anthropic'].includes(config.provider)) throw new RuntimeError('model.invalid', '模型协议无效');
  if (typeof config.model !== 'string' || !config.model.trim() || typeof config.apiKey !== 'string') throw new RuntimeError('model.invalid', '模型名称或凭据格式无效');
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { throw new RuntimeError('model.invalid', '模型服务地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new RuntimeError('model.invalid', '模型服务地址必须是无内嵌凭据的 HTTP(S) URL');
  if (config.maxContextSize !== undefined && (!Number.isInteger(config.maxContextSize) || config.maxContextSize < 1024)) throw new RuntimeError('model.invalid', '上下文长度至少为 1024');
}

export function errorPayload(error: unknown): { code: string; message: string } {
  return {
    code: typeof error === 'object' && error && 'code' in error ? String(error.code) : 'runtime.error',
    message: error instanceof Error ? error.message : String(error),
  };
}

function redact(value: Record<string, unknown>, apiKey: string): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'string' && apiKey ? item.split(apiKey).join('[已隐藏凭据]') : item));
}

function guardProviderErrors(apiKey: string): () => void {
  const originalFetch = globalThis.fetch;
  if (!apiKey) return () => {};
  // 在 HTTP / SSE 错误进入内核会话持久化之前脱敏，同时覆盖 JSON 转义形式。
  const forms = new Set([apiKey, encodeURIComponent(apiKey)]);
  let escaped = apiKey;
  for (let depth = 0; depth < 3; depth++) { escaped = JSON.stringify(escaped).slice(1, -1); forms.add(escaped); }
  const needles = [...forms].sort((left, right) => right.length - left.length);
  const clean = (text: string) => {
    for (const needle of needles) text = text.split(needle).join('[已隐藏凭据]');
    return text;
  };
  globalThis.fetch = async (...args) => {
    const response = await originalFetch(...args);
    const contentType = response.headers.get('content-type') ?? '';
    const streaming = contentType.includes('text/event-stream');
    if (response.ok && !streaming && !contentType.includes('json')) return response;
    const headers = new Headers();
    response.headers.forEach((value, key) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding'].includes(key)) headers.set(key, clean(value));
    });
    let body: BodyInit | null;
    if (streaming && response.body) {
      let pending = '';
      const redactor = new TransformStream<string, string>({
        transform(chunk, controller) {
          pending += chunk;
          let end;
          while ((end = pending.indexOf('\n')) >= 0) {
            controller.enqueue(clean(pending.slice(0, end + 1)));
            pending = pending.slice(end + 1);
          }
        },
        flush(controller) { if (pending) controller.enqueue(clean(pending)); },
      });
      body = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(redactor).pipeThrough(new TextEncoderStream());
    } else body = response.status === 304 ? null : clean(await response.text());
    return new Response(body, {
      status: response.status,
      statusText: clean(response.statusText),
      headers,
    });
  };
  return () => { globalThis.fetch = originalFetch; };
}
