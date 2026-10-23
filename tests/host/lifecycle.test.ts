import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Store, Secrets } from '../../apps/desktop/src/main/store';
import { Workbench } from '../../apps/desktop/src/main/workbench';
import type { RuntimePort } from '../../apps/desktop/src/main/runtime-client';

class ControlledRuntime extends EventEmitter implements RuntimePort {
  calls: Array<{ method: string; params: any }> = [];
  async request(method: string, params: any = {}) {
    this.calls.push({ method, params });
    if (method === 'info') return { version: 'test', upstreamCommit: 'test' };
    return { accepted: true };
  }
  event(runId: string, kind: string, payload: Record<string, unknown> = {}, id: string = randomUUID()) { this.emit('event', { id, runId, kind, payload, at: new Date().toISOString() }); }
  async close() { this.emit('exit', '受控运行时停止'); }
}
async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error('等待条件超时'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mesnier-host-'));
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const store = new Store(path.join(root, 'profile'));
  // 只测宿主契约；这个替身不代表系统加密或真实 harness。
  const secrets = new Secrets(store.root, { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() });
  const runtime = new ControlledRuntime(); const bench = new Workbench(store, secrets, runtime, () => {}); await bench.initialize();
  const project = await bench.createProject({ path: workspace }); const session = bench.createSession({ projectId: project.id });
  const model = bench.saveModelConfig({ name: '测试模型', provider: 'openai', model: 'fixture', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'fixture-secret' });
  return { root, workspace, store, bench, runtime, project, session, model,
    send: (prompt = '生成报告') => bench.sendMessage({ sessionId: session.id, text: prompt, requestId: randomUUID() }),
    dispose: async () => { await bench.close(); await fs.rm(root, { recursive: true, force: true }); }
  };
}

test('同一请求去重，Chat 关联 Board 不重发，完成执行仍需用户验收', async () => {
  const f = await fixture();
  try {
    const input = { sessionId: f.session.id, text: '生成报告', requestId: randomUUID() };
    const first = await f.bench.sendMessage(input); const second = await f.bench.sendMessage(input);
    assert.equal(first.id, second.id); await waitUntil(() => f.runtime.calls.some(item => item.method === 'run'));
    const task = f.bench.createTask({ sessionId: f.session.id, title: '报告' });
    assert.equal(f.bench.createTask({ sessionId: f.session.id, title: '重复' }).id, task.id);
    assert.equal(f.bench.snapshot().runs.length, 1);
    f.runtime.event(first.id, 'assistant.delta', { text: '完成' }, 'same-event'); f.runtime.event(first.id, 'assistant.delta', { text: '完成' }, 'same-event');
    await fs.writeFile(path.join(f.workspace, 'report.md'), '# 报告\n实际文件');
    f.runtime.event(first.id, 'run.completed'); await waitUntil(() => f.bench.state.runs[0].status === 'succeeded');
    assert.equal(f.bench.state.tasks[0].status, 'review'); assert.equal(f.bench.state.messages.filter(item => item.role === 'assistant')[0].text, '完成');
    assert.equal(f.bench.state.artifacts.length, 1); assert.equal(f.bench.acceptTask({ taskId: task.id }).status, 'done');
    assert.equal(f.runtime.calls.filter(item => item.method === 'run').length, 1);
    assert.ok(!(JSON.stringify(f.bench.snapshot())).includes('fixture-secret'));
  } finally { await f.dispose(); }
});

test('权限回应只发送一次；拒绝按运行时事件更新，取消先等待停止确认', async () => {
  const f = await fixture();
  try {
    const run = await f.send(); await waitUntil(() => f.runtime.calls.some(item => item.method === 'run'));
    f.runtime.event(run.id, 'approval.requested', { requestId: 'permission', toolName: 'Shell', action: '写文件' });
    assert.equal(f.bench.state.runs[0].status, 'waiting_approval');
    const one = f.bench.respondApproval({ runId: run.id, requestId: 'permission', decision: 'rejected' });
    await assert.rejects(f.bench.respondApproval({ runId: run.id, requestId: 'permission', decision: 'approved' })); await one;
    f.runtime.event(run.id, 'approval.resolved', { requestId: 'permission', decision: 'rejected' });
    await assert.rejects(f.bench.respondApproval({ runId: run.id, requestId: 'permission', decision: 'approved' }));
    await f.bench.cancelRun(run.id); assert.equal(f.bench.state.runs[0].status, 'cancelling');
    f.runtime.event(run.id, 'run.cancelled'); await waitUntil(() => f.bench.state.runs[0].status === 'cancelled');
    assert.equal(f.runtime.calls.filter(item => item.method === 'approve').length, 1);
  } finally { await f.dispose(); }
});

test('串行队列保存启动配置和凭据快照，删除默认模型不改变已入队执行', async () => {
  const f = await fixture();
  try {
    const first = await f.send(); await waitUntil(() => f.runtime.calls.some(item => item.method === 'run'));
    const session2 = f.bench.createSession({ projectId: f.project.id });
    const second = await f.bench.sendMessage({ sessionId: session2.id, text: '第二个任务', requestId: randomUUID() });
    assert.equal(second.status, 'queued');
    f.bench.saveModelConfig({ id: f.model.id, name: '已修改', provider: 'openai', model: 'new-model', baseUrl: 'http://127.0.0.1:2/v1', apiKey: 'new-secret' });
    f.bench.deleteModel(f.model.id);
    f.runtime.event(first.id, 'run.completed'); await waitUntil(() => f.runtime.calls.filter(item => item.method === 'run').length === 2);
    const submitted = f.runtime.calls.filter(item => item.method === 'run')[1].params;
    assert.equal(submitted.runId, second.id); assert.equal(submitted.modelConfig.model, 'fixture'); assert.equal(submitted.modelConfig.apiKey, 'fixture-secret');
    f.runtime.event(second.id, 'run.completed'); await waitUntil(() => f.bench.state.runs[1].status === 'succeeded');
  } finally { await f.dispose(); }
});

test('失败保留错误与产物，不能验收；重试创建新执行并沿用原生会话', async () => {
  const f = await fixture();
  try {
    const task = f.bench.createTask({ sessionId: f.session.id, title: '失败重试' });
    const first = await f.bench.enqueueTask({ taskId: task.id, requestId: randomUUID() }); await waitUntil(() => f.runtime.calls.some(item => item.method === 'run'));
    f.runtime.event(first.id, 'session.ready', { sessionId: 'native-session' });
    await fs.writeFile(path.join(f.workspace, 'partial.txt'), '部分结果');
    f.runtime.event(first.id, 'run.failed', { error: { message: '模型失败 fixture-secret' } }); await waitUntil(() => f.bench.state.runs[0].status === 'failed');
    assert.throws(() => f.bench.acceptTask({ taskId: task.id })); assert.equal(f.bench.state.artifacts.length, 1);
    assert.equal(f.bench.state.runs[0].error, '模型失败 [已隐藏凭据]');
    const second = await f.bench.enqueueTask({ taskId: task.id, requestId: randomUUID() }); assert.notEqual(second.id, first.id); assert.equal(second.retryOf, first.id);
    await waitUntil(() => f.runtime.calls.filter(item => item.method === 'run').length === 2);
    assert.equal(f.runtime.calls.filter(item => item.method === 'run')[1].params.sessionId, 'native-session');
    f.runtime.event(second.id, 'run.completed'); await waitUntil(() => f.bench.state.runs[1].status === 'succeeded');
  } finally { await f.dispose(); }
});

test('重启保留会话与产物，不自动重放活动执行', async () => {
  const f = await fixture();
  try {
    const run = await f.send(); await waitUntil(() => f.runtime.calls.some(item => item.method === 'run'));
    f.runtime.event(run.id, 'session.ready', { sessionId: 'native-restore' });
    const reopened = new Store(f.store.root);
    assert.equal(reopened.data.runs[0].status, 'interrupted'); assert.equal(reopened.data.sessions[0].runtimeSessionId, 'native-restore');
    const isolatedRuntime = new ControlledRuntime(); const resumed = new Workbench(reopened, f.bench.secrets, isolatedRuntime, () => {}); await resumed.initialize();
    assert.equal(isolatedRuntime.calls.filter(item => item.method === 'run').length, 0); await resumed.close();
  } finally { await f.dispose(); }
});

test('文件失效与符号链接逃逸明确失败，未知数据版本不覆盖原文件', async () => {
  const f = await fixture();
  try {
    const run = await f.send(); await waitUntil(() => f.runtime.calls.some(item => item.method === 'run'));
    const file = path.join(f.workspace, 'out.txt'); await fs.writeFile(file, 'hello');
    f.runtime.event(run.id, 'run.completed'); await waitUntil(() => f.bench.state.runs[0].status === 'succeeded');
    const artifact = f.bench.state.artifacts[0]; assert.equal((await f.bench.readArtifact(artifact.id)).text, 'hello');
    await fs.unlink(file); assert.ok((await f.bench.readArtifact(artifact.id)).error);
    const outside = path.join(f.root, 'private.txt'); await fs.writeFile(outside, 'outside'); await fs.symlink(outside, file);
    assert.ok((await f.bench.readArtifact(artifact.id)).error);
    const futureRoot = path.join(f.root, 'future'); await fs.mkdir(futureRoot); const future = '{"schemaVersion":999,"runs":[],"sessions":[]}'; await fs.writeFile(path.join(futureRoot, 'state.json'), future);
    assert.throws(() => new Store(futureRoot)); assert.equal(await fs.readFile(path.join(futureRoot, 'state.json'), 'utf8'), future);
  } finally { await f.dispose(); }
});

test('模型连接检查验证工具调用并对错误凭据脱敏，旧测试不能覆盖新配置', async () => {
  const { createServer } = await import('node:http');
  const f = await fixture();
  let mode: 'good' | 'error' | 'delayed' = 'good';
  let release: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body);
    assert.equal(input.tools[0].function.name, 'mesnier_connection_check');
    assert.equal(request.headers.authorization, 'Bearer fixture-secret');
    if (mode === 'delayed') await new Promise<void>(resolve => { release = resolve; });
    response.setHeader('Content-Type', 'application/json');
    if (mode === 'error') { response.writeHead(401); response.end(JSON.stringify({ error: 'bad key fixture-secret' })); }
    else response.end(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'mesnier_connection_check', arguments: '{"ready":true}' } }] } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const settings = { id: f.model.id, name: '本地模型', provider: 'openai' as const, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture' };
  try {
    f.bench.saveModelConfig(settings); assert.equal((await f.bench.testModel(f.model.id)).ok, true); assert.equal(f.bench.state.models[0].status, 'ready');
    mode = 'error'; const result = await f.bench.testModel(f.model.id); assert.equal(result.ok, false); assert.ok(!result.message.includes('fixture-secret'));
    mode = 'delayed'; const pending = f.bench.testModel(f.model.id); await waitUntil(() => Boolean(release));
    f.bench.saveModelConfig({ ...settings, model: 'changed' }); release!(); await pending;
    assert.equal(f.bench.state.models[0].model, 'changed'); assert.equal(f.bench.state.models[0].status, 'untested');
  } finally { release?.(); await new Promise<void>(resolve => server.close(() => resolve())); await f.dispose(); }
});

test('保存失败不启动未持久化执行，凭据变更不会破坏旧配置引用', async () => {
  const f = await fixture();
  const save = f.store.save.bind(f.store);
  try {
    const originalRef = f.model.credentialRef ?? f.model.id;
    f.store.save = () => { throw new Error('fixture ENOSPC'); };
    assert.throws(() => f.bench.saveModelConfig({ id: f.model.id, name: '新服务', provider: 'openai', model: 'new', baseUrl: 'http://127.0.0.1:2/v1', apiKey: 'new-service-key' }), /无法保存/);
    assert.equal(f.bench.secrets.get(originalRef), 'fixture-secret');
    await assert.rejects(f.send(), /无法保存/);
    assert.equal(f.runtime.calls.filter(item => item.method === 'run').length, 0);
    const persisted = JSON.parse(await fs.readFile(f.store.file, 'utf8'));
    assert.equal(persisted.models[0].model, 'fixture'); assert.equal(persisted.models[0].credentialRef, originalRef);
  } finally { f.store.save = save; await f.dispose(); }
});
