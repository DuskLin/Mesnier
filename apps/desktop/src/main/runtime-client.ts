import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { RunEvent } from '@mesnier/shared';

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
    const child = spawn(this.nodePath, [this.entry], { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: this.dataRoot, detached: process.platform !== 'win32' });
    this.child = child; this.closing = false;
    createInterface({ input: child.stdout }).on('line', line => {
      try {
        const message = JSON.parse(line);
        if (message.event) { this.emit('event', message.event); return; }
        const entry = this.pending.get(message.id); if (!entry) return;
        clearTimeout(entry.timer); this.pending.delete(message.id);
        if (message.error) entry.reject(new RuntimeRequestError(message.error.message ?? '运行时调用失败')); else entry.resolve(message.result);
      } catch { this.log('运行时输出了无效协议行，已忽略。'); }
    });
    child.stderr.on('data', chunk => this.log(String(chunk)));
    const fail = (reason: string) => {
      if (this.child !== child) return;
      this.child = undefined;
      for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(new RuntimeRequestError(reason, true)); }
      this.pending.clear();
      this.emit('exit', reason);
    };
    child.on('error', error => fail(error.message));
    child.on('exit', (code, signal) => fail(`运行时进程已退出（${signal ?? code ?? '未知'}）`));
  }
  request(method: string, params: Record<string, unknown> = {}) {
    if (this.closing && method !== 'shutdown') return Promise.reject(new Error('运行时正在关闭'));
    this.start(); const id = randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RuntimeRequestError(`运行时 ${method} 请求超时，执行状态待核对。`, true)); }, method === 'shutdown' ? 8000 : 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new RuntimeRequestError(error.message, true)); }
      });
    });
  }
  async close() {
    const child = this.child; if (!child) { this.closing = false; return; }
    this.closing = true;
    let exited = child.exitCode !== null || child.signalCode !== null;
    const exit = new Promise<void>(resolve => {
      if (exited) resolve();
      else child.once('exit', () => { exited = true; resolve(); });
    });
    const pause = (duration: number) => new Promise<void>(resolve => setTimeout(resolve, duration));
    const signal = (value: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, value); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    };
    try { await this.request('shutdown'); } catch { /* 超时后只终止本应用创建的进程组 */ }
    signal('SIGTERM');
    if (!exited) await Promise.race([exit, pause(2000)]);
    // 即使 leader 已退出，也清理同组遗留的工具子进程。
    signal('SIGKILL');
    if (!exited) await Promise.race([exit, pause(2000)]);
    if (!exited && child.pid) throw new RuntimeRequestError('无法确认运行时已经停止，已暂停后续执行。', true);
    if (child.pid && process.platform !== 'win32') {
      const deadline = Date.now() + 2000;
      while (true) {
        try { process.kill(-child.pid, 0); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') break; throw error; }
        if (Date.now() >= deadline) throw new RuntimeRequestError('运行时工具进程组尚未确认退出，已暂停后续执行。', true);
        await pause(50);
      }
    }
    if (this.child === child) this.child = undefined;
    this.closing = false;
  }
}
