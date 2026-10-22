import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

// 独立审查可指定宿主源码；集成后默认验证本仓库，所有数据保持隔离。
const hostRoot = process.env.MESNIER_REVIEW_HOST_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { Workbench } = await import(pathToFileURL(path.join(hostRoot, 'apps/desktop/src/main/workbench.ts')).href);
const { Store, Secrets } = await import(pathToFileURL(path.join(hostRoot, 'apps/desktop/src/main/store.ts')).href);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

test('入队成功但运行状态保存失败时，不产生未处理拒绝或启动工具', { timeout: 10000 }, async () => {
  const directory = await fs.mkdtemp(path.join(tmpdir(), 'mesnier-host-review-process-'));
  const entry = path.join(directory, 'probe.mjs');
  await fs.writeFile(entry, `
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
const { Workbench } = await import(pathToFileURL(path.join(process.env.MESNIER_REVIEW_HOST_ROOT, 'apps/desktop/src/main/workbench.ts')));
const { Store, Secrets } = await import(pathToFileURL(path.join(process.env.MESNIER_REVIEW_HOST_ROOT, 'apps/desktop/src/main/store.ts')));
class Runtime extends EventEmitter {
  runCalls = 0; closeCalls = 0;
  async request(method) { if (method === 'run') this.runCalls++; return {}; }
  async close() { this.closeCalls++; this.emit('exit', 'review close'); }
}
const root = process.env.MESNIER_REVIEW_TEMP;
const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
const store = new Store(path.join(root, 'profile'));
const secrets = new Secrets(store.root, { encrypt: value => value, decrypt: value => value });
const runtime = new Runtime(); const bench = new Workbench(store, secrets, runtime, () => {});
await bench.initialize(); const project = await bench.createProject({ path: workspace });
const session = bench.createSession({ projectId: project.id });
bench.saveModelConfig({ name: 'fixture', provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' });
const save = store.save.bind(store); let writes = 0;
store.save = () => { if (++writes === 2) throw new Error('review running ENOSPC'); save(); };
await bench.sendMessage({ sessionId: session.id, text: 'review', requestId: 'save-window' });
await new Promise(resolve => setTimeout(resolve, 50));
store.save = save; await bench.close();
process.stdout.write(JSON.stringify({ runCalls: runtime.runCalls, closeCalls: runtime.closeCalls, status: bench.state.runs[0].status, error: bench.state.runtime.error }));
`);
  try {
    const child = spawn(process.execPath, ['--unhandled-rejections=strict', '--import', import.meta.resolve('tsx'), entry], {
      cwd: directory,
      env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, MESNIER_REVIEW_HOST_ROOT: hostRoot, MESNIER_REVIEW_TEMP: directory },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(result.code, 0, stderr);
    assert.equal(result.signal, null);
    const evidence = JSON.parse(stdout);
    assert.equal(evidence.runCalls, 0); assert.ok(evidence.closeCalls > 0);
    assert.equal(evidence.status, 'interrupted'); assert.match(evidence.error, /无法保存/);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

class ReviewRuntime extends EventEmitter {
  calls: Array<{ method: string; afterClose: boolean }> = [];
  closed = false;
  async request(method: string) {
    this.calls.push({ method, afterClose: this.closed });
    return { version: 'review-fixture', upstreamCommit: 'review-fixture', accepted: true };
  }
  async close() { this.closed = true; this.emit('exit', '受控运行时已停止'); }
}

for (const failure of ['close', 'save'] as const) {
  test(`${failure === 'close' ? '退出应用' : '持久化失败'}后，未完成的目录扫描不能重新启动执行`, { timeout: 10000 }, async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'mesnier-host-review-'));
    const workspace = path.join(directory, 'workspace'); await fs.mkdir(workspace);
    const store = new Store(path.join(directory, 'profile'));
    const save = store.save.bind(store);
    const secrets = new Secrets(store.root, {
      encrypt: (value: string) => Buffer.from(value).toString('base64'),
      decrypt: (value: string) => Buffer.from(value, 'base64').toString(),
    });
    const runtime = new ReviewRuntime(); const bench = new Workbench(store, secrets, runtime, () => {});
    await bench.initialize();
    const project = await bench.createProject({ path: workspace });
    const session = bench.createSession({ projectId: project.id });
    bench.saveModelConfig({ name: '本地测试', provider: 'openai', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' });
    const scanned = deferred(); const release = deferred();
    const originalReaddir = fs.readdir;
    const realWorkspace = await fs.realpath(workspace);
    let pauseOnce = true;
    // 只暂停本用例的第一次工作区读取，复现慢磁盘窗口，实际读取仍使用文件系统。
    fs.readdir = (async (...args: Parameters<typeof fs.readdir>) => {
      if (pauseOnce && String(args[0]) === realWorkspace) {
        pauseOnce = false; scanned.resolve(); await release.promise;
      }
      return originalReaddir(...args);
    }) as typeof fs.readdir;
    let closed: Promise<void> | undefined;
    try {
      await bench.sendMessage({ sessionId: session.id, text: '验证关闭边界', requestId: randomUUID() });
      await scanned.promise;
      if (failure === 'close') closed = bench.close();
      else {
        store.save = () => { throw new Error('review ENOSPC'); };
        assert.throws(() => bench.renameSession({ sessionId: session.id, title: '触发保存失败' }), /无法保存/);
      }
      release.resolve();
      await closed;
      // 让暂停读取的异步续体和事件回调都得到执行机会。
      await new Promise<void>(resolve => setTimeout(resolve, 50));
      assert.equal(runtime.calls.filter(call => call.method === 'run').length, 0, '关闭确认后不得重新向 worker 提交 run');
      assert.equal(bench.state.runs[0].status, 'interrupted');
    } finally {
      release.resolve(); fs.readdir = originalReaddir; store.save = save;
      await closed?.catch(() => {}); await bench.close(); await fs.rm(directory, { recursive: true, force: true });
    }
  });
}
