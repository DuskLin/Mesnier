import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hostRoot = process.env.MESNIER_REVIEW_HOST_ROOT ?? repository;
const { RuntimeClient } = await import(pathToFileURL(path.join(hostRoot, 'apps/desktop/src/main/runtime-client.ts')).href);
const { redactCredential } = await import(pathToFileURL(path.join(hostRoot, 'apps/desktop/src/main/store.ts')).href);
const baseUrl = process.env.MESNIER_REAL_BASE_URL;
const model = process.env.MESNIER_REAL_MODEL;
if (!baseUrl || !model) throw new Error('需要明确指定 MESNIER_REAL_BASE_URL 和 MESNIER_REAL_MODEL；本入口不使用模拟响应。');
const key = process.env.MESNIER_REAL_API_KEY ?? '';
const worker = process.env.MESNIER_RUNTIME_WORKER ?? path.join(repository, 'packages/runtime/dist/worker.mjs');
const node = process.env.MESNIER_RUNTIME_NODE ?? process.execPath;
const output = await mkdtemp(path.join(process.env.MESNIER_ACCEPTANCE_PARENT ?? tmpdir(), 'mesnier-real-model-'));
const profile = path.join(output, 'profile'); await mkdir(profile);
const gitTemplate = path.join(output, 'git-template'); await mkdir(gitTemplate);
// Git 样例不读取用户或系统配置，不加载全局模板及 hooks。
const gitEnv = { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string, args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', `init.templateDir=${gitTemplate}`, ...args], { cwd, env: gitEnv, encoding: 'utf8' });
const logs: string[] = [];
const clean = (value: string) => redactCredential(value, key);
const client = new RuntimeClient(node, worker, profile, (message: string) => logs.push(clean(message)));
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function runtimeSnapshot() {
  const values: Record<string, string> = {};
  async function visit(directory: string, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), `${relative}/`);
      else if (entry.isFile()) values[relative] = sha(await readFile(path.join(directory, entry.name)));
    }
  }
  await visit(path.dirname(worker));
  values['host/runtime-client.ts'] = sha(await readFile(path.join(hostRoot, 'apps/desktop/src/main/runtime-client.ts')));
  values['host/process-tracker.ts'] = sha(await readFile(path.join(hostRoot, 'apps/desktop/src/main/process-tracker.ts')));
  values['host/store.ts'] = sha(await readFile(path.join(hostRoot, 'apps/desktop/src/main/store.ts')));
  return values;
}

type ProductEvent = { id: string; runId: string; kind: string; payload: Record<string, any>; at: string };
const events: ProductEvent[] = [];
const approvals: Array<{ runId: string; tool: string; decision: string; detail: string }> = [];
let current: { runId: string; workspace: string; writable: Set<string>; coding: boolean } | undefined;
client.on('event', (event: ProductEvent) => {
  events.push(event);
  if (event.kind !== 'approval.requested' || current?.runId !== event.runId) return;
  const display = event.payload.display ?? {};
  const tool = String(event.payload.toolName ?? '');
  const filename = typeof display.path === 'string' ? path.resolve(display.path) : '';
  const command = typeof display.command === 'string' ? display.command : '';
  const allowedFile = ['Write', 'Edit'].includes(tool) && current.writable.has(filename);
  // 只批准本次统计样例的测试命令；验证无需执行任意外部 shell 指令。
  const allowedTest = current.coding && tool === 'Bash' && /^(?:node|[^\s]+\/node)\s+--test\s+(?:\.\/)?summary\.test\.mjs\s*$/.test(command.trim());
  const decision = allowedFile || allowedTest ? 'approved' : 'rejected';
  approvals.push({ runId: event.runId, tool, decision, detail: filename || command });
  void client.request('approve', { runId: event.runId, requestId: event.payload.requestId, decision }).catch((error: Error) => logs.push(clean(error.message)));
});

async function run(workspace: string, prompt: string, writable: string[], coding = false) {
  const runId = randomUUID();
  current = { runId, workspace, writable: new Set(writable.map((file) => path.resolve(workspace, file))), coding };
  let stopWatch: (() => void) | undefined;
  const terminal = new Promise<ProductEvent>((resolve, reject) => {
    const timer = setTimeout(() => { stopWatch?.(); reject(new Error('真实模型回合超过 12 分钟，未计为通过')); }, 12 * 60_000);
    const listener = (event: ProductEvent) => {
      if (event.runId !== runId || !['run.completed', 'run.failed', 'run.cancelled'].includes(event.kind)) return;
      clearTimeout(timer); client.off('event', listener); resolve(event);
    };
    stopWatch = () => { clearTimeout(timer); client.off('event', listener); };
    client.on('event', listener);
  });
  try {
    await client.request('run', {
      runId, profileRoot: profile, workspace, prompt, approvalMode: 'manual',
      modelConfig: { provider: 'openai', baseUrl, model, apiKey: key, maxContextSize: 32768 },
    });
    const result = await terminal;
    assert.equal(result.kind, 'run.completed', JSON.stringify(result.payload));
    return { runId, result };
  } finally { stopWatch?.(); }
}

const beforeRuntime = await runtimeSnapshot();
const workOnly = process.env.MESNIER_REAL_SCENARIOS === 'work';
const result: Record<string, unknown> = { output, scope: workOnly ? 'work-only-precheck' : 'work-and-coding', modelSource: '本地真实开源权重推理', model, baseUrl, startedAt: new Date().toISOString(), runtimeFiles: beforeRuntime, runnerSha256: sha(await readFile(fileURLToPath(import.meta.url))), hostBase: git(hostRoot, ['rev-parse', 'HEAD']).trim(), runnerBase: git(repository, ['rev-parse', 'HEAD']).trim() };
try {
  result.runtime = await client.request('info');
  const work = path.join(output, 'work'); await mkdir(work);
  const facts = '项目名称：北极星\n本周完成：搜索筛选修复 13 项；导出功能改进 8 项。\n下周待办：补充离线文档。\n';
  await writeFile(path.join(work, 'facts.txt'), facts);
  const workRun = await run(work,
    '你正在普通非 Git 工作目录中。读取 facts.txt，根据其中的事实生成 report.md，标题为“# 北极星周报”。准确列出两项已完成工作、下周待办，并写明“总计：21 项”。必须使用真实文件工具完成，不要只在回复中展示内容。不要创建其他文件。', ['report.md']);
  const report = await readFile(path.join(work, 'report.md'), 'utf8');
  assert.match(report, /北极星/); assert.match(report, /搜索筛选/); assert.match(report, /导出/); assert.match(report, /21\s*项/); assert.match(report, /离线文档/);
  assert.match(report, /13|十三/); assert.match(report, /8|八/);
  assert.ok(events.some((event) => event.runId === workRun.runId && event.kind === 'tool.started' && event.payload.name === 'Read'));
  assert.ok(events.some((event) => event.runId === workRun.runId && event.kind === 'tool.started' && event.payload.name === 'Write'));
  assert.ok(approvals.some((approval) => approval.runId === workRun.runId && approval.tool === 'Write' && approval.decision === 'approved'), '普通目录写入须经过人工审批通道');
  result.work = { ...workRun, reportSha256: sha(report), report, sourceSha256: sha(facts), gitRequired: false };

  if (!workOnly) {
    const coding = path.join(output, 'coding'); await mkdir(coding);
    const source = 'export function summarize(values) {\n  const total = values.reduce((sum, value) => sum + value, 1);\n  return { count: values.length, total, average: total / values.length };\n}\n';
    const suite = [
      "import assert from 'node:assert/strict';",
      "import test from 'node:test';",
      "import { summarize } from './summary.mjs';",
      "test('空列表', () => assert.deepEqual(summarize([]), { count: 0, total: 0, average: 0 }));",
      "test('正数', () => assert.deepEqual(summarize([2, 4, 6]), { count: 3, total: 12, average: 4 }));",
      "test('负数与小数', () => assert.deepEqual(summarize([-2, 3]), { count: 2, total: 1, average: 0.5 }));",
      '',
    ].join('\n');
    await writeFile(path.join(coding, 'summary.mjs'), source); await writeFile(path.join(coding, 'summary.test.mjs'), suite);
    git(coding, ['init', '-q']);
    git(coding, ['add', 'summary.mjs', 'summary.test.mjs']);
    git(coding, ['-c', 'user.name=Mesnier Acceptance', '-c', 'user.email=acceptance@example.invalid', 'commit', '-qm', '测试输入基线']);
    const before = spawnSync(node, ['--test', 'summary.test.mjs'], { cwd: coding, encoding: 'utf8' });
    assert.notEqual(before.status, 0, '初始样例必须真实复现错误');
    await writeFile(path.join(output, 'coding-before.log'), before.stdout + before.stderr);
    const codingRun = await run(coding,
      '修复当前项目 summary.mjs 中 summarize(values) 的统计错误：total 是所有数字之和，空列表 total 与 average 都应为 0，其他列表 average 是 total/count。保持导出 API，不修改 summary.test.mjs，也不要创建额外文件。修改后必须使用 Bash 执行 node --test summary.test.mjs 验证，最后准确报告结果。', ['summary.mjs'], true);
    const after = spawnSync(node, ['--test', 'summary.test.mjs'], { cwd: coding, encoding: 'utf8' });
    await writeFile(path.join(output, 'coding-after.log'), after.stdout + after.stderr);
    assert.equal(after.status, 0, after.stdout + after.stderr);
    assert.equal(sha(await readFile(path.join(coding, 'summary.test.mjs'))), sha(suite), '不能通过改写测试来伪装修复');
    assert.notEqual(sha(await readFile(path.join(coding, 'summary.mjs'))), sha(source));
    const bash = events.filter((event) => event.runId === codingRun.runId && event.kind === 'tool.started' && event.payload.name === 'Bash');
    assert.ok(bash.length > 0, '真实模型须调用 Bash 运行测试');
    assert.ok(bash.some((start) => events.some((event) => event.runId === codingRun.runId && event.kind === 'tool.result' && event.payload.toolCallId === start.payload.toolCallId && event.payload.isError !== true)));
    assert.ok(approvals.some((approval) => approval.runId === codingRun.runId && ['Write', 'Edit'].includes(approval.tool) && approval.decision === 'approved'), 'Git 项目修改须经过人工审批通道');
    assert.ok(approvals.some((approval) => approval.runId === codingRun.runId && approval.tool === 'Bash' && approval.decision === 'approved'), 'Git 项目测试命令须经过人工审批通道');
    assert.equal(git(coding, ['status', '--porcelain']).trimEnd(), ' M summary.mjs', '只能修改任务指定源码文件');
    result.coding = { ...codingRun, initialExit: before.status, finalExit: after.status, unchangedTestSha256: sha(suite), diff: git(coding, ['diff', '--', 'summary.mjs']) };
  }
  result.passed = true;
} catch (error) {
  result.passed = false; result.error = clean(error instanceof Error ? error.stack ?? error.message : String(error)); process.exitCode = 1;
} finally {
  try { await client.close(); }
  catch (error) { result.closeError = clean(String(error)); result.passed = false; process.exitCode = 1; }
  try { result.runtimeUnchanged = JSON.stringify(beforeRuntime) === JSON.stringify(await runtimeSnapshot()); }
  catch (error) { result.runtimeSnapshotError = clean(String(error)); result.runtimeUnchanged = false; }
  if (!result.runtimeUnchanged) { result.passed = false; process.exitCode = 1; }
  result.endedAt = new Date().toISOString();
  await writeFile(path.join(output, 'events.json'), clean(JSON.stringify(events, null, 2)));
  await writeFile(path.join(output, 'approvals.json'), clean(JSON.stringify(approvals, null, 2)));
  await writeFile(path.join(output, 'runtime.log'), logs.join('\n'));
  await writeFile(path.join(output, 'result.json'), clean(JSON.stringify(result, null, 2)));
  process.stdout.write(`${JSON.stringify({ output, scope: result.scope, passed: result.passed, error: result.error, model, runtimeUnchanged: result.runtimeUnchanged }, null, 2)}\n`);
}
