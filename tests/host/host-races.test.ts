import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

// 独立 worktree 审查时可指向被审查宿主；合并后默认使用本仓库源码。
const hostRoot = process.env.MESNIER_REVIEW_HOST_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { Workbench } = await import(pathToFileURL(path.join(hostRoot, 'apps/desktop/src/main/workbench.ts')).href);
const { Store, Secrets } = await import(pathToFileURL(path.join(hostRoot, 'apps/desktop/src/main/store.ts')).href);
const { RuntimeClient, RuntimeRequestError } = await import(pathToFileURL(path.join(hostRoot, 'apps/desktop/src/main/runtime-client.ts')).href);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function until(predicate: () => boolean, detail: string) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待失败：${detail}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

class ControlledRuntime extends EventEmitter {
  calls: Array<Record<string, unknown>> = [];
  closeCalls = 0;
  onRun: (params: Record<string, unknown>) => Promise<unknown> = async () => ({});
  onClose: () => Promise<void> = async () => { this.emit('exit', '受控进程已停止'); };
  async request(method: string, params: Record<string, unknown> = {}) {
    if (method === 'info') return { version: 'fixture', upstreamCommit: 'fixture' };
    if (method === 'run') { this.calls.push(params); return this.onRun(params); }
    return {};
  }
  async close() { this.closeCalls += 1; await this.onClose(); }
  completed(runId: string) {
    this.emit('event', { id: randomUUID(), runId, kind: 'run.completed', payload: {}, at: new Date().toISOString() });
  }
}

async function setup(t: TestContext, runtime = new ControlledRuntime()) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mesnier-host-races-'));
  const workspace = path.join(directory, 'workspace'); await mkdir(workspace);
  const store = new Store(path.join(directory, 'data'));
  const secrets = new Secrets(store.root, { encrypt: (value: string) => `fixture:${value}`, decrypt: (value: string) => value.slice(8) });
  const workbench = new Workbench(store, secrets, runtime, () => {});
  await workbench.initialize();
  workbench.saveModelConfig({ name: '受控模型', provider: 'openai', baseUrl: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: 'fixture-key' });
  const project = await workbench.createProject({ path: workspace });
  const session = workbench.createSession({ projectId: project.id });
  t.after(async () => { await workbench.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, workspace, store, workbench, runtime, project, session };
}

test('并发相同 requestId 不同正文不能静默覆盖或复用', async (t) => {
  const { workbench, session } = await setup(t);
  const results = await Promise.allSettled([
    workbench.sendMessage({ sessionId: session.id, requestId: 'same-id', text: '第一份请求' }),
    workbench.sendMessage({ sessionId: session.id, requestId: 'same-id', text: '不同请求' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.ok(rejected?.status === 'rejected');
  assert.match(String(rejected.reason), /不一致/);
  assert.equal(workbench.state.runs.length, 1);
});

test('run 回执不确定时必须等旧 worker 停止后才启动下一条', async (t) => {
  const runtime = new ControlledRuntime();
  const started = deferred<unknown>(); const stopped = deferred();
  runtime.onRun = () => runtime.calls.length === 1 ? started.promise : Promise.resolve({});
  runtime.onClose = async () => { await stopped.promise; runtime.emit('exit', '受控旧进程停止'); };
  const { workbench, session, project } = await setup(t, runtime);
  try {
    const first = await workbench.sendMessage({ sessionId: session.id, requestId: 'first', text: '第一条' });
    const secondSession = workbench.createSession({ projectId: project.id });
    const second = await workbench.sendMessage({ sessionId: secondSession.id, requestId: 'second', text: '第二条' });
    await until(() => runtime.calls.length === 1, '首条进入 worker');
    started.reject(new RuntimeRequestError('受控回执超时', true));
    await until(() => runtime.closeCalls > 0 || workbench.state.runs[0].status === 'failed', '超时处理');
    assert.equal(runtime.closeCalls, 1, '回执不确定必须先停止旧 worker');
    assert.equal(runtime.calls.length, 1);
    assert.equal(workbench.state.runs.find((run: { id: string }) => run.id === second.id).status, 'queued');
    stopped.resolve();
    await until(() => runtime.calls.length === 2, '停止确认后下一条开始');
    assert.equal(workbench.state.runs.find((run: { id: string }) => run.id === first.id).status, 'interrupted');
  } finally { stopped.resolve(); }
});

test('终止事件先于 run 回执也不能提前重叠下一次调度', async (t) => {
  const runtime = new ControlledRuntime(); const acknowledgement = deferred<unknown>();
  runtime.onRun = () => runtime.calls.length === 1 ? acknowledgement.promise : Promise.resolve({});
  const { workbench, session, project } = await setup(t, runtime);
  try {
    const first = await workbench.sendMessage({ sessionId: session.id, requestId: 'first', text: '第一条' });
    const secondSession = workbench.createSession({ projectId: project.id });
    await workbench.sendMessage({ sessionId: secondSession.id, requestId: 'second', text: '第二条' });
    await until(() => runtime.calls.length === 1, '首条进入 worker');
    runtime.completed(first.id);
    await until(() => workbench.state.runs[0].status === 'succeeded', '首条终止事件落盘');
    assert.equal(runtime.calls.length, 1);
    assert.equal(workbench.state.runs[1].status, 'queued');
    acknowledgement.resolve({});
    await until(() => runtime.calls.length === 2, '回执返回后下一条开始');
  } finally { acknowledgement.resolve({}); }
});

test('应用关闭等待正在完成的产物扫描与终态落盘', async (t) => {
  const { workbench, runtime, session, workspace, store } = await setup(t);
  const run = await workbench.sendMessage({ sessionId: session.id, requestId: 'close-race', text: '产生文件' });
  await until(() => runtime.calls.length === 1, '初始文件扫描完成');
  await writeFile(path.join(workspace, 'result.txt'), '关闭前已生成的产物');
  runtime.onClose = async () => { runtime.completed(run.id); };
  await workbench.close();
  const saved = JSON.parse(await readFile(store.file, 'utf8'));
  assert.equal(saved.runs[0].status, 'succeeded');
  assert.ok(saved.artifacts.some((artifact: { relativePath: string }) => artifact.relativePath === 'result.txt'));
});

test('RuntimeClient 关闭真实子进程后允许重新启动', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mesnier-runtime-restart-'));
  const entry = path.join(directory, 'worker.mjs');
  await writeFile(entry, `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: message.id, result: { pid: process.pid } }) + '\\n');
  if (message.method === 'shutdown') setImmediate(() => process.exit(0));
});\n`);
  const client = new RuntimeClient(process.execPath, entry, directory, () => {});
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  const first = await client.request('info');
  await client.close();
  let second: { pid: number } | undefined;
  await assert.doesNotReject(async () => { second = await client.request('info'); });
  assert.ok(second);
  assert.notEqual(first.pid, second.pid);
  assert.throws(() => process.kill(first.pid, 0), { code: 'ESRCH' });
});

test('模型错误正文中的 JSON 转义凭据也必须脱敏', async (t) => {
  const key = 'fixture"secret\\token';
  const server = createServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: `认证失败：${key}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const { workbench } = await setup(t);
  const model = workbench.saveModelConfig({ name: '转义凭据', provider: 'openai', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', apiKey: key });
  const result = await workbench.testModel(model.id);
  assert.equal(result.ok, false);
  assert.equal(result.message.includes(key), false);
  assert.equal(result.message.includes(JSON.stringify(key).slice(1, -1)), false, '不能把转义后的凭据当成已脱敏');
  assert.match(result.message, /隐藏凭据/);
});
