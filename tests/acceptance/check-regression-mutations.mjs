import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidenceRoot = await mkdtemp(join(tmpdir(), 'mesnier-probe-mutations-'));
const cases = [
  {
    name: 'premature-return',
    file: 'spikes/kimi-sdk-min-probe/probe.ts',
    pattern: 'finalizer',
    from: 'exitCode = await deps.runCredentialed(evidence, dirs);',
    to: 'exitCode = await deps.runCredentialed(evidence, dirs); return exitCode;',
  },
  {
    name: 'directory-only',
    file: 'spikes/kimi-sdk-min-probe/guards.ts',
    pattern: '已有配置原地改写',
    from: 'for (const name of (await readdir(path)).sort())',
    to: 'for (const name of [])',
  },
  {
    name: 'missed-resume-write',
    file: 'spikes/kimi-sdk-min-probe/guards.ts',
    pattern: '恢复返回前同内容重写',
    from: 'unchanged: changeEvents === 0 && metadataUnchanged(before, after)',
    to: 'unchanged: true',
  },
];
const results = [];
for (const mutation of cases) {
  const isolated = join(evidenceRoot, mutation.name);
  await mkdir(isolated);
  await cp(join(root, 'spikes/kimi-sdk-min-probe'), join(isolated, 'spikes/kimi-sdk-min-probe'), {
    recursive: true,
    filter: (path) => !/(?:^|\/)(?:sandbox|evidence|node_modules)(?:\/|$)/.test(path),
  });
  await cp(join(root, 'tests/acceptance'), join(isolated, 'tests/acceptance'), { recursive: true });
  const target = join(isolated, mutation.file);
  const source = await readFile(target, 'utf8');
  assert.equal(source.split(mutation.from).length, 2, `${mutation.name} 的修改位置必须唯一`);
  await writeFile(target, source.replace(mutation.from, mutation.to));
  const result = spawnSync(process.execPath, [
    '--test', `--test-name-pattern=${mutation.pattern}`, 'tests/acceptance/probe-regressions.test.mjs',
  ], { cwd: isolated, encoding: 'utf8' });
  await writeFile(join(isolated, 'mutation-test.log'), `${result.stdout}\n${result.stderr}`);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, `${mutation.name} 未能触发测试失败`);
  assert.match(result.stdout, /AssertionError|ERR_ASSERTION/, '必须因行为断言失败，编译或导入失败不算捕获原缺陷');
  results.push({ mutation: mutation.name, processExit: result.status, caughtByAssertion: true });
}
await writeFile(join(evidenceRoot, 'results.json'), JSON.stringify(results, null, 2));
process.stdout.write(`${JSON.stringify({ evidenceRoot, results }, null, 2)}\n`);
