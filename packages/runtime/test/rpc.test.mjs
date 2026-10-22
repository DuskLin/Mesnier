import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixturePrompt, startModelServer } from '../../../tests/acceptance/fixtures/model-server.mjs';

const require = createRequire(import.meta.url);
const distribution = process.env['MESNIER_TEST_RUNTIME_ROOT'];
const executable = distribution ? join(distribution, 'bin', process.platform === 'win32' ? 'node.exe' : 'node') : require.resolve(process.platform === 'win32' ? 'node/bin/node.exe' : 'node/bin/node');
const workerPath = distribution ? join(distribution, 'worker.mjs') : fileURLToPath(new URL('../dist/worker.mjs', import.meta.url));

async function setup(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'mesnier-runtime-test-'));
  const profileRoot = join(root, 'profile');
  const workspace = join(root, 'work');
  await mkdir(workspace);
  const userHome = join(root, 'os-home');
  const temp = join(root, 'tmp');
  await mkdir(userHome); await mkdir(temp);
  const fixture = await startModelServer(options);
  const worker = spawn(executable, [workerPath], {
    stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32', cwd: root,
    env: {
      PATH: `${dirname(executable)}${delimiter}/usr/bin${delimiter}/bin${delimiter}/usr/sbin${delimiter}/sbin`,
      HOME: userHome, USERPROFILE: userHome, TMPDIR: temp, TMP: temp, TEMP: temp,
      XDG_CONFIG_HOME: join(userHome, '.config'), XDG_DATA_HOME: join(userHome, '.local/share'), XDG_CACHE_HOME: join(root, 'cache'),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
      SHELL: '/bin/sh', LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    },
  });
  const events = [];
  const replies = new Map();
  const listeners = new Set();
  let sequence = 0;
  let stdout = '';
  let stderr = '';
  worker.stderr.on('data', (data) => { stderr += data; });
  worker.stdout.setEncoding('utf8');
  worker.stdout.on('data', (data) => {
    stdout += data;
    let end;
    while ((end = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, end); stdout = stdout.slice(end + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.event) {
        events.push(message.event);
        for (const listener of listeners) listener(message.event);
      } else {
        const pending = replies.get(message.id);
        if (pending) {
          replies.delete(message.id);
          if (message.error) pending.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
          else pending.resolve(message.result);
        }
      }
    }
  });
  const exit = new Promise((resolve) => worker.once('exit', (code, signal) => {
    for (const pending of replies.values()) pending.reject(new Error(`worker 提前退出 ${code}/${signal}：${stderr}`));
    replies.clear();
    resolve({ code, signal });
  }));
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = `rpc-${++sequence}`;
    replies.set(id, { resolve, reject });
    worker.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const waitEvent = (predicate, timeoutMs = 20000) => {
    const event = events.find(predicate);
    if (event) return Promise.resolve(event);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`等待事件超时；events=${JSON.stringify(events)}；stderr=${stderr}`)); }, timeoutMs);
      const listener = (event) => {
        if (!predicate(event)) return;
        clearTimeout(timer); listeners.delete(listener); resolve(event);
      };
      listeners.add(listener);
    });
  };
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) {
      const timer = setTimeout(() => {
        if (process.platform !== 'win32') process.kill(-worker.pid, 'SIGKILL');
        else worker.kill('SIGKILL');
      }, 5000);
      timer.unref();
      await rpc('shutdown').catch(() => {});
      await exit;
      clearTimeout(timer);
    }
    await fixture.close();
  });
  const run = (runId, scenario, extra = {}) => rpc('run', {
    runId, profileRoot, workspace,
    prompt: fixturePrompt(scenario),
    modelConfig: { id: 'fixture', provider: 'openai', baseUrl: fixture.baseUrl, model: 'mesnier-fixture', apiKey: fixture.apiKey },
    approvalMode: 'manual', ...extra,
  });
  const end = (runId) => waitEvent((event) => event.runId === runId && /^run\.(completed|failed|cancelled)$/.test(event.kind));
  return { root, profileRoot, workspace, fixture, worker, events, rpc, run, end, waitEvent, exit, stderr: () => stderr };
}

test('真实内核写入文件、会话恢复、重复执行拦截与凭据隔离', { timeout: 45000 }, async (t) => {
  const app = await setup(t);
  const info = await app.rpc('info');
  assert.equal(info.name, 'Mesnier Agent');
  assert.equal(info.nodeVersion, '24.15.0');
  const path = join(app.workspace, 'work.txt');
  await app.run('write-1', { kind: 'write', path, content: '真实 Write 工具完成\n' });
  const approval = await app.waitEvent((event) => event.kind === 'approval.requested');
  assert.equal(approval.payload.toolName, 'Write');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  await app.rpc('approve', { runId: 'write-1', requestId: approval.payload.requestId, decision: 'approved' });
  const completed = await app.end('write-1');
  assert.equal(completed.kind, 'run.completed', JSON.stringify(completed));
  assert.equal(await readFile(path, 'utf8'), '真实 Write 工具完成\n');
  assert.ok(app.events.some((event) => event.kind === 'tool.result' && !event.payload.isError));
  assert.ok(app.events.some((event) => event.kind === 'assistant.delta' && event.payload.text));
  await assert.rejects(app.rpc('approve', { runId: 'write-1', requestId: approval.payload.requestId, decision: 'approved' }));
  await assert.rejects(app.run('write-1', { kind: 'text' }), { code: 'run.duplicate' });
  await app.run('resume-1', { kind: 'text', text: '继续同一会话' }, { sessionId: completed.payload.sessionId });
  const resumed = await app.end('resume-1');
  assert.equal(resumed.kind, 'run.completed', JSON.stringify(resumed));
  assert.equal(resumed.payload.sessionId, completed.payload.sessionId);
  assert.equal(app.events.find((event) => event.runId === 'resume-1' && event.kind === 'session.ready').payload.resumed, true);
  assert.equal(app.fixture.requests.filter((request) => request.kind === 'write' && !request.resultSeen).length, 1);
  const config = await readFile(join(app.profileRoot, 'agent', 'config.toml'), 'utf8');
  assert.ok(config.includes('MESNIER_RUNTIME_API_KEY'));
  assert.ok(!config.includes(app.fixture.apiKey));
  assert.ok(!JSON.stringify(app.events).includes(app.fixture.apiKey));
  assert.ok(!app.stderr().includes(app.fixture.apiKey));
  await app.rpc('shutdown');
  await app.exit;
  for (const file of await filesUnder(app.profileRoot)) {
    assert.ok(!(await readFile(file)).includes(Buffer.from(app.fixture.apiKey)), `发现明文凭据：${file}`);
  }
});

test('拒绝工具请求不会产生文件，重复审批不会放行', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  const path = join(app.workspace, 'must-not-exist.txt');
  await app.run('reject-1', { kind: 'reject', path, content: '不应落盘' });
  const approval = await app.waitEvent((event) => event.kind === 'approval.requested');
  await app.rpc('approve', { runId: 'reject-1', requestId: approval.payload.requestId, decision: 'rejected' });
  await assert.rejects(app.rpc('approve', { runId: 'reject-1', requestId: approval.payload.requestId, decision: 'approved' }));
  await app.end('reject-1');
  await assert.rejects(readFile(path), { code: 'ENOENT' });
  assert.ok(app.events.some((event) => event.kind === 'approval.resolved' && event.payload.decision === 'rejected'));
});

for (const git of [false, true]) {
  test(`${git ? 'Git' : '非 Git'} 目录首次与恢复后的写入、编辑和命令逐次审批`, { timeout: 35000 }, async (t) => {
    const app = await setup(t);
    const workspace = await realpath(app.workspace);
    if (git) execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '--quiet', workspace], {
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(app.root, 'gitconfig') },
    });
    const path = join(workspace, 'manual-write.txt');
    const approvalOrEnd = (runId) => app.waitEvent((event) => event.runId === runId && (event.kind === 'approval.requested' || /^run\./.test(event.kind)));
    await app.run('manual-reject', { kind: 'write', path, content: '先拒绝' }, { workspace });
    const first = await approvalOrEnd('manual-reject');
    assert.equal(first.kind, 'approval.requested', '首次写入不能被上游 Git 自动放行策略绕过');
    await app.rpc('approve', { runId: 'manual-reject', requestId: first.payload.requestId, decision: 'rejected' });
    const rejected = await app.end('manual-reject');
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    await app.run('manual-approve', { kind: 'write', path, content: '再次审批后写入' }, { workspace, sessionId: rejected.payload.sessionId });
    const second = await approvalOrEnd('manual-approve');
    assert.equal(second.kind, 'approval.requested', '恢复后的写入仍须单次审批');
    await assert.rejects(readFile(path), { code: 'ENOENT' });
    await app.rpc('approve', { runId: 'manual-approve', requestId: second.payload.requestId, decision: 'approved' });
    const written = await app.end('manual-approve');
    assert.equal(written.kind, 'run.completed');
    assert.equal(await readFile(path, 'utf8'), '再次审批后写入');
    await app.run('edit-reject', { kind: 'edit', path, oldString: '再次审批后写入', newString: '编辑已批准' }, { workspace, sessionId: written.payload.sessionId });
    const editRejected = await approvalOrEnd('edit-reject');
    assert.equal(editRejected.kind, 'approval.requested');
    assert.equal(editRejected.payload.toolName, 'Edit');
    await app.rpc('approve', { runId: 'edit-reject', requestId: editRejected.payload.requestId, decision: 'rejected' });
    await app.end('edit-reject');
    assert.equal(await readFile(path, 'utf8'), '再次审批后写入');
    await app.run('edit-approve', { kind: 'edit', path, oldString: '再次审批后写入', newString: '编辑已批准' }, { workspace, sessionId: written.payload.sessionId });
    const editApproved = await approvalOrEnd('edit-approve');
    assert.equal(editApproved.kind, 'approval.requested');
    assert.equal(editApproved.payload.toolName, 'Edit');
    await app.rpc('approve', { runId: 'edit-approve', requestId: editApproved.payload.requestId, decision: 'approved' });
    assert.equal((await app.end('edit-approve')).kind, 'run.completed');
    assert.equal(await readFile(path, 'utf8'), '编辑已批准');
    await app.run('safe-command', { kind: 'bash', command: 'pwd' }, { workspace, sessionId: written.payload.sessionId });
    const bash = await approvalOrEnd('safe-command');
    assert.equal(bash.kind, 'approval.requested');
    assert.equal(bash.payload.toolName, 'Bash');
    await app.rpc('approve', { runId: 'safe-command', requestId: bash.payload.requestId, decision: 'approved' });
    assert.equal((await app.end('safe-command')).kind, 'run.completed');
  });
}

test('取消等待中的模型流，收到停止确认后才记录取消', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  await app.run('cancel-1', { kind: 'hold' });
  await app.waitEvent((event) => event.kind === 'assistant.delta');
  assert.ok(!app.events.some((event) => event.kind === 'run.cancelled'));
  await app.rpc('cancel', { runId: 'cancel-1' });
  assert.equal((await app.end('cancel-1')).kind, 'run.cancelled');
  assert.ok(app.fixture.requests.some((request) => request.kind === 'hold' && request.closed));
});

test('供应方认证失败与错误工作目录明确失败', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  await app.run('failure-1', { kind: 'error', status: 401 });
  const failure = await app.end('failure-1');
  assert.equal(failure.kind, 'run.failed');
  assert.ok(failure.payload.error.message);
  const count = app.fixture.requests.length;
  await app.run('missing-directory', { kind: 'text' }, { workspace: join(app.root, 'missing') });
  assert.equal((await app.end('missing-directory')).kind, 'run.failed');
  assert.equal(app.fixture.requests.length, count);
});

test('不加载项目旧 Kimi 配置、指令或插件', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  const foreign = join(app.workspace, '.kimi-code');
  await mkdir(foreign);
  const sentinel = 'MESNIER_FOREIGN_CONFIG_SENTINEL';
  await writeFile(join(foreign, 'local.toml'), '这不是有效的 TOML [[[');
  await writeFile(join(foreign, 'AGENTS.md'), sentinel);
  await writeFile(join(foreign, 'mcp.json'), '这不是有效的 JSON');
  await app.run('foreign-config', { kind: 'text' });
  assert.equal((await app.end('foreign-config')).kind, 'run.completed');
  await app.rpc('shutdown');
  await app.exit;
  for (const file of await filesUnder(app.profileRoot)) {
    assert.ok(!(await readFile(file)).includes(Buffer.from(sentinel)), `加载了旧 Kimi 指令：${file}`);
  }
  assert.equal(await readFile(join(foreign, 'local.toml'), 'utf8'), '这不是有效的 TOML [[[');
});

test('stdin 关闭时取消活动流并退出，不留下孤立运行时', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  await app.run('eof-cancel', { kind: 'hold' });
  await app.waitEvent((event) => event.kind === 'assistant.delta');
  app.worker.stdin.end();
  const result = await app.exit;
  assert.equal(result.code, 0);
  assert.ok(app.events.some((event) => event.kind === 'run.cancelled'));
});

test('供应方错误回显凭据时事件和持久化记录仍然脱敏', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  await app.run('redaction', { kind: 'error', status: 401, echoCredential: true });
  assert.equal((await app.end('redaction')).kind, 'run.failed');
  assert.ok(!JSON.stringify(app.events).includes(app.fixture.apiKey));
  assert.ok(!app.stderr().includes(app.fixture.apiKey));
  await app.rpc('shutdown');
  await app.exit;
  for (const file of await filesUnder(app.profileRoot)) {
    assert.ok(!(await readFile(file)).includes(Buffer.from(app.fixture.apiKey)), `错误记录包含明文凭据：${file}`);
  }
});

for (const kind of ['error', 'sse-error']) {
  test(`带 JSON 转义的凭据在 ${kind} 中也不会进入会话`, { timeout: 35000 }, async (t) => {
    const app = await setup(t, { apiKey: 'fixture"secret\\token' });
    await app.run('encoded-secret', { kind, status: 401, echoCredential: true });
    assert.equal((await app.end('encoded-secret')).kind, 'run.failed');
    await app.rpc('shutdown');
    await app.exit;
    assert.ok(!JSON.stringify(app.events).includes(JSON.stringify(app.fixture.apiKey).slice(1, -1)));
    for (const file of await filesUnder(app.profileRoot)) {
      const content = await readFile(file, 'utf8');
      assert.ok(!content.includes(app.fixture.apiKey) && !content.includes(JSON.stringify(app.fixture.apiKey).slice(1, -1)), `编码凭据进入记录：${file}`);
    }
  });
}

test('真实 Bash 工具通过批准后修改文件', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  const path = join(app.workspace, 'shell.txt');
  await app.run('bash-write', { kind: 'bash', command: "printf 'shell-ok' > shell.txt" });
  const approval = await app.waitEvent((event) => event.kind === 'approval.requested');
  assert.equal(approval.payload.toolName, 'Bash');
  await app.rpc('approve', { runId: 'bash-write', requestId: approval.payload.requestId, decision: 'approved' });
  const completed = await app.end('bash-write');
  assert.equal(completed.kind, 'run.completed', JSON.stringify(completed));
  assert.equal(await readFile(path, 'utf8'), 'shell-ok');
});

test('模型密钥不进入真实 Bash 子进程环境或工具历史', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  await app.run('bash-secret', { kind: 'bash', command: 'printf "credential=[%s]" "${MESNIER_RUNTIME_API_KEY-unset}"' });
  const approval = await app.waitEvent((event) => event.kind === 'approval.requested');
  await app.rpc('approve', { runId: 'bash-secret', requestId: approval.payload.requestId, decision: 'approved' });
  assert.equal((await app.end('bash-secret')).kind, 'run.completed');
  const result = app.events.find((event) => event.kind === 'tool.result');
  assert.ok(JSON.stringify(result).includes('credential=[unset]'), JSON.stringify(result));
  await app.rpc('shutdown');
  await app.exit;
  for (const file of await filesUnder(app.profileRoot)) {
    assert.ok(!(await readFile(file)).includes(Buffer.from(app.fixture.apiKey)), `子进程历史包含明文凭据：${file}`);
  }
});

test('stdin 关闭会停止已经启动的长时间 Bash 进程组', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  const marker = join(app.workspace, 'process.pid');
  await app.run('bash-eof', { kind: 'bash', command: 'echo $$ > process.pid; sleep 30' });
  const approval = await app.waitEvent((event) => event.kind === 'approval.requested');
  await app.rpc('approve', { runId: 'bash-eof', requestId: approval.payload.requestId, decision: 'approved' });
  let pid;
  for (let attempt = 0; attempt < 300 && !pid; attempt++) {
    try { pid = Number((await readFile(marker, 'utf8')).trim()); } catch {}
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(pid > 0, 'Bash 应实际启动并写入 PID 哨兵');
  assert.ok(app.events.some((event) => event.kind === 'process.started' && event.payload.pid === pid && event.payload.pgid === pid));
  app.worker.stdin.end();
  assert.equal((await app.exit).code, 0);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.ok(app.events.some((event) => event.kind === 'process.exited' && event.payload.pid === pid));
});

test('worker 被强制结束后，宿主可根据已报告 PGID 清理实际工具进程', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  await app.run('bash-force-exit', { kind: 'bash', command: 'echo $$ > process.pid; sleep 30' });
  const approval = await app.waitEvent((event) => event.kind === 'approval.requested');
  await app.rpc('approve', { runId: 'bash-force-exit', requestId: approval.payload.requestId, decision: 'approved' });
  let pid;
  for (let attempt = 0; attempt < 300 && !pid; attempt++) {
    try { pid = Number((await readFile(join(app.workspace, 'process.pid'), 'utf8')).trim()); } catch {}
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const observed = app.events.find((event) => event.kind === 'process.started' && event.payload.pid === pid);
  assert.ok(observed?.payload.pgid > 0, '宿主必须在 worker 结束前收到工具进程组身份');
  const pgid = observed.payload.pgid;
  t.after(() => { try { process.kill(-pgid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  app.worker.kill('SIGKILL');
  assert.equal((await app.exit).signal, 'SIGKILL');
  assert.doesNotThrow(() => process.kill(pid, 0), '强制结束 worker 不会替代工具组清理');
  process.kill(-pgid, 'SIGTERM');
  let alive = true;
  for (let attempt = 0; attempt < 300 && alive; attempt++) {
    try { process.kill(-pgid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; else throw error; }
    if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(alive, false, '已记录的工具进程组应确认全部退出');
});

test('Bash leader 退出时同步报告同组后台后代身份', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  await app.run('background-child', { kind: 'bash', command: 'sleep 30 >/dev/null 2>&1 & echo $! > descendant.pid' });
  const approval = await app.waitEvent((event) => event.kind === 'approval.requested');
  await app.rpc('approve', { runId: 'background-child', requestId: approval.payload.requestId, decision: 'approved' });
  let descendant;
  for (let attempt = 0; attempt < 300 && !descendant; attempt++) {
    try { descendant = Number((await readFile(join(app.workspace, 'descendant.pid'), 'utf8')).trim()); } catch {}
    if (!descendant) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(descendant > 0, '后台命令也必须先进入工作目录再产生文件');
  const observed = await app.waitEvent((event) => event.kind === 'process.exited' && Array.isArray(event.payload.members) && event.payload.members.some((item) => item.pid === descendant));
  const pgid = observed.payload.pgid;
  t.after(() => { try { process.kill(-pgid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  const member = observed.payload.members.find((item) => item.pid === descendant);
  assert.ok(member && member.pgid === pgid && typeof member.born === 'string');
  assert.doesNotThrow(() => process.kill(descendant, 0));
  process.kill(-pgid, 'SIGTERM');
  assert.equal((await app.end('background-child')).kind, 'run.completed');
});

test('父端所有管道断开时继续收尾，清理忽略 TERM 的真实 Bash', { timeout: 35000 }, async (t) => {
  const app = await setup(t);
  await app.run('pipes-closed', { kind: 'bash', command: "trap '' TERM; echo $$ > pipe-process.pid; while :; do printf 'active\\n'; sleep 0.05; done" });
  const approval = await app.waitEvent((event) => event.kind === 'approval.requested');
  await app.rpc('approve', { runId: 'pipes-closed', requestId: approval.payload.requestId, decision: 'approved' });
  let pid;
  for (let attempt = 0; attempt < 300 && !pid; attempt++) {
    try { pid = Number((await readFile(join(app.workspace, 'pipe-process.pid'), 'utf8')).trim()); } catch {}
    if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const owned = app.events.find((event) => event.kind === 'process.started' && event.payload.pid === pid);
  assert.equal(owned?.payload.pgid, pid);
  t.after(() => { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  app.worker.stdin.destroy(); app.worker.stdout.destroy(); app.worker.stderr.destroy();
  assert.equal((await app.exit).code, 0, '不能因未捕获 EPIPE 提前结束 worker');
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

async function filesUnder(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}
