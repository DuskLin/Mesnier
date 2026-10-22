import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hostRoot = process.env.MESNIER_REVIEW_HOST_ROOT ?? root;
const evidenceRoot = await mkdtemp(path.join(tmpdir(), 'mesnier-host-mutations-'));
const files = ['workbench.ts', 'store.ts', 'artifacts.ts', 'runtime-client.ts', 'process-tracker.ts'];
// 所有变体使用同一份源码快照，防止并行改动让各项验证绑定不同版本。
const originals = Object.fromEntries(await Promise.all(files.map(async file => [file, await readFile(path.join(hostRoot, 'apps/desktop/src/main', file), 'utf8')])));
const sha = value => createHash('sha256').update(value).digest('hex');
await writeFile(path.join(evidenceRoot, 'input-manifest.json'), JSON.stringify({
  hostRoot, sources: Object.fromEntries(files.map(file => [file, sha(originals[file])])),
  runner: sha(await readFile(fileURLToPath(import.meta.url))),
  tests: sha(await readFile(path.join(root, 'tests/host/host-races.test.ts'))),
}, null, 2));
const cases = [
  {
    name: 'duplicate-conflict', file: 'workbench.ts', pattern: '并发相同 requestId',
    from: "if (duplicate.sessionId !== input.sessionId || duplicate.prompt !== input.text.trim()) throw new Error('重复请求标识与原执行内容不一致。');",
    to: '/* 受控破坏：异步重入后遗漏冲突检查 */',
  },
  {
    name: 'timeout-starts-next', file: 'workbench.ts', pattern: 'run 回执不确定',
    from: 'if (error instanceof RuntimeRequestError && error.uncertain) await this.stopUncertain(run.id, this.clean(error.message));',
    to: "if (error instanceof RuntimeRequestError && error.uncertain) await this.finish(run.id, 'failed', this.clean(error.message));",
  },
  {
    name: 'terminal-before-ack', file: 'workbench.ts', pattern: '终止事件先于',
    // 准备过程与待回执集合都可阻止重叠；需同时移除才构成原缺陷。
    from: ' || this.starting.size || this.preparation', to: '',
  },
  {
    name: 'cannot-restart', file: 'runtime-client.ts', pattern: 'RuntimeClient 关闭真实子进程',
    from: 'this.stopping = this.stop().then(() => { this.closing = false; }).finally(() => { this.stopping = undefined; });',
    to: 'this.stopping = this.stop().finally(() => { this.stopping = undefined; });',
  },
  {
    name: 'escaped-credential', file: 'store.ts', pattern: 'JSON 转义凭据',
    from: 'for (let depth = 0; depth < 3; depth++) { escaped = JSON.stringify(escaped).slice(1, -1); forms.add(escaped); }',
    to: '/* 受控破坏：只处理原始或 URL 编码形式 */',
  },
];
const results = [];
for (const mutation of cases) {
  const snapshot = path.join(evidenceRoot, mutation.name);
  const main = path.join(snapshot, 'apps/desktop/src/main');
  await mkdir(main, { recursive: true });
  await writeFile(path.join(snapshot, 'package.json'), '{"type":"module"}\n');
  for (const file of files) await writeFile(path.join(main, file), originals[file]);
  const file = path.join(main, mutation.file);
  const before = await readFile(file, 'utf8');
  assert.equal(before.split(mutation.from).length, 2, `${mutation.name} 的变体位置不唯一或不存在`);
  await writeFile(file, before.replace(mutation.from, mutation.to));
  const result = spawnSync(process.execPath, [
    ...process.execArgv, '--test', `--test-name-pattern=${mutation.pattern}`,
    path.join(root, 'tests/host/host-races.test.ts'),
  ], { cwd: process.cwd(), env: { ...process.env, MESNIER_REVIEW_HOST_ROOT: snapshot }, encoding: 'utf8', timeout: 20_000 });
  await writeFile(path.join(snapshot, 'mutation-test.log'), `${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null, `${mutation.name} 不应以信号或超时结束`);
  assert.equal(result.status, 1, `${mutation.name} 未能捕获目标缺陷`);
  assert.match(result.stdout, /AssertionError|ERR_ASSERTION/, `${mutation.name} 必须因行为断言失败`);
  results.push({ mutation: mutation.name, processExit: result.status, caughtByAssertion: true });
}
await writeFile(path.join(evidenceRoot, 'results.json'), JSON.stringify(results, null, 2));
process.stdout.write(`${JSON.stringify({ evidenceRoot, results }, null, 2)}\n`);
