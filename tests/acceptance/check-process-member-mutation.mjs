import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hostRoot = process.env.MESNIER_REVIEW_HOST_ROOT ?? root;
const directory = await mkdtemp(path.join(tmpdir(), 'mesnier-process-member-mutation-'));
const file = 'apps/desktop/src/main/process-tracker.ts';
const source = await readFile(path.join(hostRoot, file), 'utf8');
const from = 'for (const member of members ?? [])';
assert.equal(source.split(from).length, 2);
await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
await writeFile(path.join(directory, 'package.json'), '{"type":"module"}\n');
await writeFile(path.join(directory, file), source.replace(from, 'for (const member of [])'));
const result = spawnSync(process.execPath, [
  ...process.execArgv, '--test', '--test-name-pattern=leader 注册后', path.join(root, 'tests/host/process-members.test.ts'),
], { cwd: process.cwd(), env: { ...process.env, MESNIER_REVIEW_HOST_ROOT: directory }, encoding: 'utf8', timeout: 15000 });
await writeFile(path.join(directory, 'test.log'), `${result.stdout}\n${result.stderr}`);
assert.equal(result.signal, null);
assert.equal(result.status, 1);
assert.match(result.stdout, /AssertionError|ERR_ASSERTION/);
const summary = { directory, originalSha256: createHash('sha256').update(source).digest('hex'), processExit: result.status, caughtByAssertion: true };
await writeFile(path.join(directory, 'result.json'), JSON.stringify(summary, null, 2));
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
