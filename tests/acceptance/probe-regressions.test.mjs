import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { beginSideEffectObservation, metadataUnchanged, snapshotTreeMetadata } from '../../spikes/kimi-sdk-min-probe/guards.ts';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const hash = (contents) => createHash('sha256').update(contents).digest('hex');
const oldDirectorySignature = async (path) => {
  const value = await stat(path);
  return `${value.mtimeMs}:${value.ctimeMs}:${value.ino}:${value.size}`;
};
async function withDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'mesnier-probe-regression-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
async function runChild(mode, directory) {
  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(fixtures, 'probe-child.mjs'), mode, directory], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_HOME: directory },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveResult({ code, signal, stderr }));
  });
}

for (const [mode, expected] of [
  ['success', 0], ['finalizer', 1], ['personal', 1], ['snapshot-failure', 1],
  ['unchecked', 1], ['runtime-failure', 1], ['missing', 2],
]) {
  test(`真实 main 子进程：${mode} 的进程码与证据一致`, async (t) => {
    const directory = await withDirectory(t);
    const child = await runChild(mode, directory);
    assert.equal(child.signal, null, child.stderr);
    assert.equal(child.code, expected, child.stderr);
    const evidence = JSON.parse(await readFile(join(directory, 'evidence.json'), 'utf8'));
    assert.equal(evidence.退出码, expected);
    if (mode === 'missing') {
      assert.ok(Object.values(evidence.场景).every((scenario) => scenario.状态 === '未运行'));
    }
  });
}

test('证据无法写入时不能成功退出', async (t) => {
  const directory = await withDirectory(t);
  const child = await runChild('evidence-failure', directory);
  assert.equal(child.code, 1);
  assert.match(child.stderr, /验收证据写入失败/);
  await assert.rejects(readFile(join(directory, 'evidence.json')), { code: 'ENOENT' });
});

test('已有配置原地改写：旧顶层签名漏报，递归元数据捕获', async (t) => {
  const directory = await withDirectory(t);
  const config = join(directory, 'config.toml');
  await writeFile(config, 'fixture = "old"\n');
  const oldBefore = await oldDirectorySignature(directory);
  const before = await snapshotTreeMetadata(directory);
  await writeFile(config, 'fixture = "new"\n');
  const after = await snapshotTreeMetadata(directory);
  assert.equal(await oldDirectorySignature(directory), oldBefore, '此反例要求顶层目录签名保持不变');
  assert.equal(metadataUnchanged(before, after), false);
});

test('递归快照不跟随符号链接，不读取外部测试文件内容', async (t) => {
  const directory = await withDirectory(t);
  const protectedDir = join(directory, 'protected');
  const outside = join(directory, 'outside');
  await mkdir(protectedDir);
  await mkdir(outside);
  await writeFile(join(outside, 'config.toml'), 'fixture-one');
  await symlink(outside, join(protectedDir, 'link'));
  const before = await snapshotTreeMetadata(protectedDir);
  await writeFile(join(outside, 'config.toml'), 'fixture-two');
  const after = await snapshotTreeMetadata(protectedDir);
  assert.equal(before.entries, 2);
  assert.equal(metadataUnchanged(before, after), true);
});

test('恢复返回前同内容重写：旧哈希判定漏报，预先观察捕获', async (t) => {
  const directory = await withDirectory(t);
  const target = join(directory, 'artifact.txt');
  const body = '同一份测试产物\n';
  await writeFile(target, body);
  const hashBefore = hash(await readFile(target));
  const observation = await beginSideEffectObservation(directory);
  t.after(() => observation.close());
  let writesDuringResume = 0;
  async function controlledResume() {
    await writeFile(target, body);
    writesDuringResume += 1;
    return { id: 'same-session' };
  }
  await controlledResume();
  const result = await observation.finish();
  assert.equal(hash(await readFile(target)), hashBefore, '旧判定只看内容哈希，会将此重写判成通过');
  assert.equal(writesDuringResume, 1);
  assert.equal(result.unchanged, false);
  assert.equal(metadataUnchanged(result.before, result.after), false);
});

test('只读恢复观察不会制造文件副作用', async (t) => {
  const directory = await withDirectory(t);
  const target = join(directory, 'artifact.txt');
  await writeFile(target, '只读恢复\n');
  const observation = await beginSideEffectObservation(directory);
  t.after(() => observation.close());
  await readFile(target);
  const result = await observation.finish();
  assert.equal(result.unchanged, true);
});

test('受保护目录新增与删除均被捕获', async (t) => {
  const directory = await withDirectory(t);
  const target = join(directory, 'new.toml');
  const before = await snapshotTreeMetadata(directory);
  await writeFile(target, 'created');
  const created = await snapshotTreeMetadata(directory);
  await rm(target);
  const deleted = await snapshotTreeMetadata(directory);
  assert.equal(metadataUnchanged(before, created), false);
  assert.equal(metadataUnchanged(created, deleted), false);
});
