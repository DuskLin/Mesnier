import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { RunEvent } from '@mesnier/shared';
import { ProcessTracker, type ProcessMember } from './process-tracker';

export class RuntimeRequestError extends Error {
  constructor(message: string, readonly uncertain = false) { super(message); }
}
export interface RuntimePort {
  request(method: string, params?: Record<string, unknown>): Promise<any>;
  on(event: 'event', callback: (event: RunEvent) => void): this;
  on(event: 'exit', callback: (reason: string) => void): this;
  close(): Promise<void>;
}
export class RuntimeClient extends EventEmitter implements RuntimePort {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private closing = false;
  private stopping?: Promise<void>;
  private processes = new ProcessTracker();
  constructor(private nodePath: string, private entry: string, private dataRoot: string, private log: (message: string) => void) { super(); }
  private start() {
    if (this.child) return;
    if (!fs.existsSync(this.nodePath) || !fs.existsSync(this.entry)) throw new Error('内置运行时文件缺失，请重新构建或安装 Mesnier。');
    const home = path.join(this.dataRoot, 'runtime-home'); fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    const temp = path.join(this.dataRoot, 'cache', 'tmp'); fs.mkdirSync(temp, { recursive: true });
    // 不继承其他 Agent 的认证变量、HOME 或配置搜索路径。
    const env: NodeJS.ProcessEnv = {
      PATH: `${path.dirname(this.nodePath)}${path.delimiter}${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`, HOME: home, USERPROFILE: home,
      TMPDIR: temp, TMP: temp, TEMP: temp, LANG: process.env.LANG ?? 'en_US.UTF-8',
      SHELL: '/bin/zsh', TERM: 'xterm-256color', NO_COLOR: '1',
      XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(this.dataRoot, 'cache'),
      XDG_DATA_HOME: path.join(home, '.local/share'), MESNIER_HOME: this.dataRoot
    };
    const child = spawn(this.nodePath, [this.entry], { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: this.dataRoot, detached: true });
    this.child = child;
    if (child.pid) this.processes.register(child.pid, child.pid);
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.event) { void this.forward(message.event).catch(error => { this.log(String(error)); this.emit('exit', String(error)); }); return; }
        const entry = this.pending.get(message.id); if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(message.id);
        if (message.error) entry.reject(new RuntimeRequestError(message.error.message ?? '运行时调用失败')); else entry.resolve(message.result);
      } catch { this.log('运行时输出了无效协议行，已忽略。'); }
    });
    child.stderr.on('data', chunk => this.log(String(chunk)));
    const fail = (reason: string) => {
      if (this.child !== child) return;
      this.child = undefined; this.closing = true;
      for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(new RuntimeRequestError(reason, true)); }
      this.pending.clear(); this.emit('exit', reason);
    };
    child.on('error', error => fail(error.message));
    child.stdin.on('error', error => fail(error.message));
    child.on('exit', (code, signal) => fail(`运行时进程已退出（${signal ?? code ?? '未知'}）`));
  }
  private async forward(event: RunEvent) {
    if (event.kind === 'process.started') this.processes.register(Number(event.payload.pid), event.payload.pgid === undefined ? undefined : Number(event.payload.pgid), event.runId);
    if (event.kind === 'process.exited') this.processes.exited(Number(event.payload.pid), event.payload.pgid === undefined ? undefined : Number(event.payload.pgid), event.runId, Array.isArray(event.payload.members) ? event.payload.members as ProcessMember[] : undefined);
    if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.kind)) {
      try { await this.processes.cleanup(event.runId); }
      catch (error) {
        this.closing = true;
        // 进程未确认结束不能作为终态交给队列；先走宿主的隔离恢复路径。
        this.emit('exit', error instanceof Error ? error.message : String(error)); return;
      }
    }
    this.emit('event', event);
  }
  request(method: string, params: Record<string, unknown> = {}) {
    if (this.closing && method !== 'shutdown') return Promise.reject(new RuntimeRequestError('运行时正在关闭或等待进程核对。', true));
    this.start(); const id = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RuntimeRequestError(`运行时 ${method} 请求超时，执行状态待核对。`, true)); }, method === 'shutdown' ? 8000 : 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new RuntimeRequestError(error.message, true)); }
      });
    });
  }
  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closing = true;
    this.stopping = this.stop().then(() => { this.closing = false; }).finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private async stop() {
    const child = this.child;
    if (child) {
      try { await this.request('shutdown'); } catch { /* 仍需核对并停止所有已报告进程组 */ }
    }
    await this.processes.cleanup();
    if (child && child.exitCode === null && child.signalCode === null && child.pid) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new RuntimeRequestError('无法确认运行时已停止，已暂停后续执行。', true)), 2000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
    if (this.child === child) this.child = undefined;
  }
}
