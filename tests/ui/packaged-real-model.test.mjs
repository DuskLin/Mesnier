import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';

const installedApp = process.env.MESNIER_INSTALLED_APP;
const modelUrl = process.env.MESNIER_REAL_MODEL_URL;
const modelName = process.env.MESNIER_REAL_MODEL;
const repository = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin';

async function fileHash(file) { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }

async function resourceTree(root) {
  const entries = [];
  const walk = async (directory) => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (item.isDirectory()) await walk(file);
      else if (item.isSymbolicLink()) entries.push({ path: relative, target: await fs.readlink(file) });
      else if (item.isFile()) entries.push({ path: relative, sha256: await fileHash(file) });
      else throw new Error(`安装包包含不支持的资源类型：${relative}`);
    }
  };
  await walk(root);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries };
}

test('已安装 Mesnier.app 以系统 PATH 完成真实模型文件任务和重启', {
  skip: !installedApp || !modelUrl || !modelName,
  timeout: 900_000,
}, async () => {
  const application = await fs.realpath(installedApp);
  const evidence = path.resolve(process.env.MESNIER_UI_EVIDENCE ?? path.join(repository, '.evidence/ui', `packaged-real-${new Date().toISOString().replaceAll(':', '-')}`));
  await fs.mkdir(evidence, { recursive: true });
  const dataRoot = path.join(evidence, 'data');
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mesnier-real-ui-work-')));
  const inputFile = path.join(workspace, 'source-notes.txt');
  const outputFile = path.join(workspace, 'reading-plan.md');
  await fs.writeFile(inputFile, '客户：晨星书店\n工作目标：周末读书会\n日期：本周六 14:00\n参与人数：12 人\n准备事项：座位、饮用水、签到表\n');
  const resources = path.join(application, 'Contents/Resources');
  const initialTree = await resourceTree(resources);
  await fs.writeFile(path.join(evidence, 'installed-resources.json'), `${JSON.stringify(initialTree, null, 2)}\n`);
  const executablePath = path.join(application, 'Contents/MacOS/Mesnier');
  const signing = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', application], { encoding: 'utf8' });
  assert.equal(signing.status, 0, `安装包签名校验失败：${signing.stderr}`);
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = spawnSync('/usr/bin/git', ['-C', workspace, 'rev-parse', '--is-inside-work-tree'], { env: { ...gitEnv, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, encoding: 'utf8' });
  assert.notEqual(git.status, 0, '真实 Work 验收目录不能位于 Git 工作树中');
  const cliNames = ['kimi', 'kimi-code', 'codex', 'claude', 'opencode'];
  const cliSearch = {};
  for (const name of cliNames) {
    const found = [];
    for (const directory of systemPath.split(':')) {
      try { await fs.access(path.join(directory, name), constants.X_OK); found.push(path.join(directory, name)); } catch { /* 记录实际不存在的可执行文件。 */ }
    }
    cliSearch[name] = found;
    assert.equal(found.length, 0, `系统搜索路径中仍存在 ${name}，不能声称本次不依赖已有 CLI。`);
  }
  const report = {
    kind: 'installed-app-real-local-model', startedAt: new Date().toISOString(),
    appPath: application, executablePath, evidence, dataRoot, workspace,
    model: { baseUrl: modelUrl, model: modelName, kind: 'real-model' },
    environment: { platform: os.platform(), release: os.release(), architecture: os.arch(), driverNode: process.version, appPathEnvironment: systemPath },
    testSourceSha256: await fileHash(fileURLToPath(import.meta.url)),
    installedResources: { sha256: initialTree.sha256, files: initialTree.entries.length },
    codesign: { exitCode: signing.status }, directoryCheck: { exitCode: git.status, stdout: git.stdout.trim() },
    cliSearch, checks: [], approvals: [], pageErrors: [], passed: false,
  };
  let app;
  let page;
  let failure;
  const launch = async () => {
    app = await electron.launch({ executablePath, args: [], env: { ...process.env, PATH: systemPath, MESNIER_HOME: dataRoot, NODE_ENV: 'test' }, timeout: 45_000 });
    page = await app.firstWindow(); page.setDefaultTimeout(20_000);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    await page.getByRole('button', { name: '添加项目', exact: true }).waitFor();
    const info = await app.evaluate(({ app }) => ({ isPackaged: app.isPackaged, version: app.getVersion(), executable: app.getPath('exe'), resources: process.resourcesPath, path: process.env.PATH, electron: process.versions.electron }));
    assert.equal(info.isPackaged, true); assert.equal(info.path, systemPath);
    assert.equal(await fs.realpath(info.executable), executablePath);
    assert.equal(await fs.realpath(info.resources), resources);
    report.application = info;
  };
  const state = () => page.evaluate(() => window.mesnier.getSnapshot());
  const waitState = async (predicate, description, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await state(); if (predicate(value)) return value; await delay(100); }
    throw new Error(`等待超时：${description}`);
  };
  const screenshot = async (name) => {
    const success = page.locator('.toast.success');
    if (await success.count()) await success.getByRole('button', { name: '关闭提示' }).click();
    await page.screenshot({ path: path.join(evidence, `${name}.png`), animations: 'disabled', scale: 'css' });
  };
  const record = (name, details = {}) => report.checks.push({ name, passed: true, ...details });
  try {
    await launch();
    await waitState((value) => value.runtime.ready, '安装包内置运行时就绪');
    assert.equal((await state()).app.dataRoot, dataRoot);
    await screenshot('01-installed-welcome');
    record('从安装路径启动真实打包应用，系统 PATH 内无独立 Agent CLI');

    await page.getByRole('button', { name: '设置与模型' }).click();
    const settings = page.getByRole('dialog', { name: '工作台设置' });
    await settings.getByLabel('配置名称').fill('本地真实模型');
    await settings.getByLabel('API 地址').fill(modelUrl);
    await settings.getByLabel('模型名称').fill(modelName);
    if (process.env.MESNIER_REAL_API_KEY) await settings.getByLabel('API 密钥').fill(process.env.MESNIER_REAL_API_KEY);
    await settings.getByRole('button', { name: '保存并验证', exact: true }).click();
    await waitState((value) => {
      const model = value.models[0];
      if (model?.status === 'error') throw new Error(`真实模型连接验证失败：${model.error ?? '未提供原因'}`);
      return model?.status === 'ready';
    }, '真实模型连接验证', 90_000);
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    record('通过界面配置真实模型并完成工具能力连接验证');

    await page.getByRole('button', { name: '添加项目', exact: true }).click();
    const projectDialog = page.getByRole('dialog', { name: '添加工作项目' });
    await projectDialog.getByLabel('项目名称').fill('书店读书会');
    await projectDialog.getByLabel('工作目录').fill(workspace);
    await projectDialog.getByRole('button', { name: '添加项目', exact: true }).click();
    await waitState((value) => value.projects.length === 1, '真实工作目录');
    await page.getByRole('button', { name: /新建对话/ }).click();
    let snapshot = await waitState((value) => value.sessions.length === 1, '真实任务会话');
    const sessionId = snapshot.sessions[0].id;
    await page.getByRole('button', { name: '重命名会话' }).click();
    const rename = page.getByRole('dialog', { name: '重命名会话' });
    await rename.getByLabel('会话标题').fill('准备周末读书会');
    await rename.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByLabel('消息输入').fill(`请使用 Read 工具读取 ${inputFile}，然后使用 Write 工具在 ${outputFile} 创建一份中文 Markdown 读书会安排。请根据实际读到的笔记整理标题、日期、参与人数和准备清单，保留笔记中的时间与人数数字。只读取这份笔记、写入这个目标文件，不要运行终端或访问网络。完成后简短说明结果。`);
    await page.getByRole('button', { name: '发送', exact: true }).click();
    snapshot = await waitState((value) => value.runs.length === 1, '真实模型执行建立');
    const runId = snapshot.runs[0].id;
    let taskId;
    const deadline = Date.now() + 600_000;
    let previousStatus;
    while (Date.now() < deadline) {
      snapshot = await state();
      const run = snapshot.runs.find((item) => item.id === runId);
      if (run.status !== previousStatus) { process.stdout.write(`真实模型界面状态：${run.status}\n`); previousStatus = run.status; }
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) break;
      for (const approval of snapshot.approvals.filter((item) => item.runId === runId)) {
        if (report.approvals.some((item) => item.requestId === approval.requestId)) continue;
        const event = snapshot.events.find((item) => item.kind === 'approval.requested' && item.runId === runId && item.payload.requestId === approval.requestId);
        const display = event?.payload.display;
        const permitted = approval.toolName === 'Write' && display?.kind === 'file_io' && path.resolve(display.path) === outputFile;
        if (!taskId) {
          await page.getByRole('button', { name: '加入看板', exact: true }).click();
          const taskDialog = page.getByRole('dialog', { name: '将对话加入看板' });
          await taskDialog.getByLabel('任务标题').fill('整理读书会安排');
          await taskDialog.getByLabel('目标与背景').fill('根据本地笔记生成可直接使用的读书会说明。');
          await taskDialog.getByLabel('验收标准').fill('包含周六 14:00、12 人，以及座位、饮用水、签到表准备清单。');
          await taskDialog.getByRole('button', { name: '加入看板', exact: true }).click();
          const linked = await waitState((value) => value.tasks.length === 1, '执行中关联看板');
          taskId = linked.tasks[0].id;
          assert.equal(linked.runs.length, 1); assert.equal(linked.runs[0].id, runId);
          await page.getByRole('button', { name: permitted ? '允许本次' : '拒绝本次', exact: true }).scrollIntoViewIfNeeded();
          await screenshot('02-real-model-approval-board');
        }
        await page.getByRole('button', { name: permitted ? '允许本次' : '拒绝本次', exact: true }).click();
        report.approvals.push({ requestId: approval.requestId, tool: approval.toolName, decision: permitted ? 'approved' : 'rejected', targetMatchesExpected: permitted });
        if (!permitted) throw new Error('真实模型请求了范围外的操作，已拒绝并停止验收。');
      }
      await delay(250);
    }
    snapshot = await state();
    const completed = snapshot.runs.find((item) => item.id === runId);
    assert.equal(completed.status, 'succeeded', completed.error ?? '真实模型未在规定时间内完成');
    assert.ok(report.approvals.some((item) => item.tool === 'Write' && item.decision === 'approved'));
    const tools = snapshot.events.filter((item) => item.runId === runId && item.kind === 'tool.started').map((item) => item.payload.name);
    assert.ok(tools.includes('Read')); assert.ok(tools.includes('Write'));
    const content = await fs.readFile(outputFile, 'utf8');
    for (const word of ['读书会', '14:00', '12', '座位', '饮用水', '签到表']) assert.ok(content.includes(word), `真实产物遗漏笔记事实：${word}`);
    assert.equal(snapshot.tasks.find((item) => item.id === taskId).status, 'review');
    report.result = { runId, sessionId, taskId, tools, artifact: 'reading-plan.md', sha256: await fileHash(outputFile) };
    record('真实模型读取笔记、请求写入授权并生成包含源事实的 Markdown');

    await page.locator('.artifact-row').filter({ hasText: 'reading-plan.md' }).click();
    const artifactDialog = page.getByRole('dialog', { name: 'reading-plan.md', exact: true });
    await artifactDialog.locator('.artifact-preview').waitFor();
    assert.equal(await artifactDialog.locator('.artifact-preview pre').textContent(), content);
    await screenshot('03-real-model-artifact');
    await artifactDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '验收通过', exact: true }).click();
    const acceptance = page.getByRole('dialog', { name: '确认任务验收' });
    await acceptance.getByLabel('验收说明（可选）').fill('已核对源笔记的时间、人数及准备清单，与真实文件一致。');
    await acceptance.getByRole('button', { name: '确认验收通过', exact: true }).click();
    snapshot = await waitState((value) => value.tasks[0]?.status === 'done', '真实产物明确验收');
    await screenshot('04-real-model-task-accepted');
    record('实际产物预览一致，明确验收后任务完成');

    const eventCount = snapshot.events.length;
    const fileBefore = await fs.stat(outputFile);
    await app.close(); app = undefined;
    await launch();
    snapshot = await waitState((value) => value.runtime.ready && value.tasks[0]?.status === 'done', '安装应用重启后的历史');
    assert.equal(snapshot.runs.length, 1); assert.equal(snapshot.runs[0].id, runId); assert.equal(snapshot.events.length, eventCount);
    assert.equal(await fileHash(outputFile), report.result.sha256); assert.equal((await fs.stat(outputFile)).mtimeMs, fileBefore.mtimeMs);
    await page.getByRole('button', { name: '看板', exact: true }).click();
    await page.locator(`[data-task-id="${taskId}"]`).click();
    await screenshot('05-installed-app-restarted');
    record('重启安装应用恢复同一会话、任务和执行，不重写产物');
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } catch (error) {
    failure = error; report.error = error.message;
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  } finally {
    if (app) {
      try { await app.close(); } catch (error) { failure ??= error; report.passed = false; report.teardownError = error.message; }
    }
    try {
      const finalTree = await resourceTree(resources);
      assert.equal(finalTree.sha256, initialTree.sha256, '验收过程中安装应用资源发生变化');
      report.installedResourcesUnchanged = true;
    } catch (error) { failure ??= error; report.passed = false; report.resourceError = error.message; }
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) throw failure;
});
