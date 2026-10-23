import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { type TestContext } from 'node:test';

const hostRoot = process.env.MESNIER_REVIEW_HOST_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { ProcessTracker } = await import(pathToFileURL(path.join(hostRoot, 'apps/desktop/src/main/process-tracker.ts')).href);
const psEnv = { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' };
type Member = { pid: number; pgid: number; born: string };

function identity(pid: number): Member | undefined {
  try {
    const output = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8', env: psEnv });
    const match = output.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    return match && !match[3].startsWith('Z') ? { pid: Number(match[1]), pgid: Number(match[2]), born: match[4] } : undefined;
  } catch { return undefined; }
}

async function stopOwnGroup(group: number, member: number) {
  // 清理仅作用于本测试创建并核对仍属于同组的进程。
  if (identity(member)?.pgid === group) {
    try { process.kill(-group, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 3000;
  while (identity(member)) {
    assert.ok(Date.now() < deadline, '测试进程必须清理完毕');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function idle(t: TestContext) {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  await once(child.stdout!, 'data');
  const pid = child.pid!;
  t.after(async () => { await stopOwnGroup(pid, pid); child.stdout?.destroy(); });
  const member = identity(pid); assert.ok(member); return { child, member };
}

async function leaderWithLaterChild(t: TestContext) {
  const source = `const {spawn}=require('node:child_process');process.stdout.write('ready\\n');
process.stdin.once('data',()=>{const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();process.stdout.write(String(child.pid)+'\\n',()=>process.exit(0));});`;
  const leader = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: leader.stdout });
  await once(lines, 'line');
  const pid = leader.pid!;
  let descendant: number | undefined;
  t.after(async () => {
    await stopOwnGroup(pid, descendant ?? pid);
    if (leader.exitCode === null && leader.signalCode === null) leader.kill('SIGKILL');
    lines.close();
  });
  return {
    pid,
    async spawnAndExit() {
      const next = once(lines, 'line'); const exit = once(leader, 'exit');
      leader.stdin.write('spawn\n'); descendant = Number((await next)[0]); await exit;
      const member = identity(descendant); assert.ok(member); assert.equal(member.pgid, pid);
      return member;
    },
  };
}

test('leader 注册后创建同组后代再退出，退出快照可延续归属并清理', async (t) => {
  const tracker = new ProcessTracker(); const leader = await leaderWithLaterChild(t);
  tracker.register(leader.pid, leader.pid, 'one');
  const member = await leader.spawnAndExit();
  assert.doesNotThrow(() => tracker.exited(leader.pid, leader.pid, 'one', [member]));
  await tracker.cleanup('one');
  assert.equal(identity(member.pid), undefined);
});

test('错误 pgid 不得把本测试另一组进程纳入清理', async (t) => {
  const tracker = new ProcessTracker(); const owner = await idle(t); const other = await idle(t);
  tracker.register(owner.member.pid, owner.member.pgid, 'one');
  assert.throws(() => tracker.exited(owner.member.pid, other.member.pgid, 'one', [other.member]), /不一致/);
  await tracker.cleanup('one');
  assert.ok(identity(other.member.pid));
});

test('未知 PID 的退出快照不得创建新的进程归属', async (t) => {
  const tracker = new ProcessTracker(); const owner = await idle(t); const other = await idle(t);
  tracker.register(owner.member.pid, owner.member.pgid, 'one');
  tracker.exited(other.member.pid, other.member.pgid, 'one', [other.member]);
  await tracker.cleanup('one');
  assert.ok(identity(other.member.pid));
});

test('出生时间不匹配时拒绝清理且保留其他测试进程', async (t) => {
  const tracker = new ProcessTracker(); const leader = await leaderWithLaterChild(t); const other = await idle(t);
  tracker.register(leader.pid, leader.pid, 'one');
  const member = await leader.spawnAndExit();
  assert.throws(() => tracker.exited(leader.pid, leader.pid, 'one', [{ ...member, born: 'invalid-birth-fixture' }]), /身份已经变化/);
  await assert.rejects(tracker.cleanup('one'), /身份已经变化/);
  assert.ok(identity(member.pid));
  assert.ok(identity(other.member.pid));
});

test('错误执行身份不得接纳已有组的新成员', async (t) => {
  const tracker = new ProcessTracker(); const owner = await idle(t); const other = await idle(t);
  tracker.register(owner.member.pid, owner.member.pgid, 'one');
  assert.throws(() => tracker.exited(owner.member.pid, owner.member.pgid, 'other-run', [other.member]), /不一致/);
  await tracker.cleanup('one');
  assert.ok(identity(other.member.pid));
});
