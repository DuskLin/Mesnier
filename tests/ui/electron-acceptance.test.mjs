import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { _electron as electron } from 'playwright-core';

const repository = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const appRoot = path.resolve(process.env.MESNIER_APP_ROOT ?? repository);
const evidenceRoot = path.resolve(process.env.MESNIER_UI_EVIDENCE ?? path.join(repository, '.evidence/ui', new Date().toISOString().replaceAll(':', '-')));
const runtimeEnabled = process.env.MESNIER_UI_MODE !== 'smoke';
const executablePath = process.env.MESNIER_ELECTRON_PATH ?? path.join(appRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');

async function hashFile(filename) {
  return createHash('sha256').update(await fs.readFile(filename)).digest('hex');
}

async function hashTree(root) {
  const entries = [];
  const walk = async (directory) => {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, item.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (item.isDirectory()) await walk(absolute);
      else if (item.isSymbolicLink()) entries.push({ path: relative, kind: 'symlink', target: await fs.readlink(absolute) });
      else if (item.isFile()) {
        const stat = await fs.stat(absolute);
        entries.push({ path: relative, kind: 'file', mode: stat.mode & 0o777, bytes: stat.size, sha256: await hashFile(absolute) });
      } else throw new Error(`运行时分发包含不支持的文件类型：${relative}`);
    }
  };
  await walk(root);
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return { sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries };
}

test('真实 Electron 工作台验收（独立数据；可控模型单独标注）', { timeout: 360_000 }, async (t) => {
  await fs.mkdir(evidenceRoot, { recursive: true });
  const dataRoot = path.join(evidenceRoot, 'data');
  const launchRoot = path.join(evidenceRoot, 'app-snapshot');
  await fs.mkdir(launchRoot, { recursive: true });
  await fs.copyFile(path.join(appRoot, 'package.json'), path.join(launchRoot, 'package.json'), constants.COPYFILE_FICLONE);
  await fs.cp(path.join(appRoot, 'dist'), path.join(launchRoot, 'dist'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  if (runtimeEnabled) await fs.cp(path.join(appRoot, 'build/runtime'), path.join(launchRoot, 'build/runtime'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  const workRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mesnier-ui-work-')));
  const projectRoot = path.join(workRoot, 'ordinary-work-project');
  const codingRoot = path.join(workRoot, 'coding-project');
  const gitTemplate = path.join(workRoot, 'empty-git-template');
  const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(gitTemplate);
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', `--template=${gitTemplate}`, codingRoot], { env: gitEnv });
  const workGit = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', env: gitEnv });
  const codingGit = spawnSync('git', ['-C', codingRoot, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8', env: gitEnv });
  assert.notEqual(workGit.status, 0, 'Work 目录必须确实没有 Git 祖先');
  assert.equal(codingGit.status, 0); assert.equal(codingGit.stdout.trim(), 'true');
  const report = {
    kind: runtimeEnabled ? 'real-electron-controlled-model' : 'real-electron-no-runtime-smoke',
    startedAt: new Date().toISOString(), appRoot, launchRoot, dataRoot, projectRoot, codingRoot,
    directoryChecks: { work: { exitCode: workGit.status, stdout: workGit.stdout.trim(), stderr: workGit.stderr.trim() }, coding: { exitCode: codingGit.status, stdout: codingGit.stdout.trim() } },
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: appRoot, encoding: 'utf8' }).trim(),
    worktree: execFileSync('git', ['status', '--short'], { cwd: appRoot, encoding: 'utf8' }).trim(),
    testSourceSha256: await hashFile(fileURLToPath(import.meta.url)),
    environment: { platform: os.platform(), release: os.release(), architecture: os.arch(), node: process.version },
    buildHashes: {}, checks: [], pageErrors: [], passed: false,
  };
  for (const file of ['dist/main/index.cjs', 'dist/preload/index.cjs', 'dist/renderer/index.html']) {
    report.buildHashes[file] = await hashFile(path.join(launchRoot, file));
  }
  for (const name of await fs.readdir(path.join(launchRoot, 'dist/renderer/assets'))) {
    report.buildHashes[`dist/renderer/assets/${name}`] = await hashFile(path.join(launchRoot, 'dist/renderer/assets', name));
  }
  if (runtimeEnabled) {
    for (const name of ['worker.mjs', 'bin/node']) report.buildHashes[`build/runtime/${name}`] = await hashFile(path.join(launchRoot, 'build/runtime', name));
    const copiedTree = await hashTree(path.join(launchRoot, 'build/runtime'));
    const sourceTree = await hashTree(path.join(appRoot, 'build/runtime'));
    assert.equal(copiedTree.sha256, sourceTree.sha256, '复制期间运行时分发发生变化，请重新验收。');
    report.runtimeTree = { sha256: copiedTree.sha256, files: copiedTree.entries.length };
    await fs.writeFile(path.join(evidenceRoot, 'runtime-tree.json'), `${JSON.stringify(copiedTree, null, 2)}\n`);
  }
  for (const [file, hash] of Object.entries(report.buildHashes)) assert.equal(await hashFile(path.join(appRoot, file)), hash, `复制期间应用构建发生变化：${file}，请重新验收。`);
  let app;
  let page;
  let fixture;
  let failure;
  let clipboardRestore;
  let clipboardTestText;
  const screenshots = [];
  const ownRuntimePids = () => {
    const workerPath = path.join(launchRoot, 'build/runtime/worker.mjs');
    const result = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    return result.stdout.split('\n').filter((line) => line.includes(workerPath)).map((line) => Number(line.trim().match(/^\d+/)?.[0])).filter((pid) => Number.isInteger(pid) && pid > 1);
  };
  const launch = async () => {
    app = await electron.launch({ executablePath, args: [launchRoot], cwd: launchRoot, env: { ...process.env, MESNIER_HOME: dataRoot, NODE_ENV: 'test' }, timeout: 30_000 });
    page = await app.firstWindow();
    report.environment.electron = await app.evaluate(() => process.versions.electron);
    page.setDefaultTimeout(12_000);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    await page.getByRole('button', { name: '添加项目', exact: true }).waitFor();
  };
  const snapshot = () => page.evaluate(() => window.mesnier.getSnapshot());
  const waitState = async (predicate, label, timeout = 25_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const value = await snapshot();
      if (predicate(value)) return value;
      await delay(80);
    }
    throw new Error(`状态等待超时：${label}`);
  };
  const screenshot = async (name) => {
    const filename = `${name}.png`;
    await page.screenshot({ path: path.join(evidenceRoot, filename), animations: 'disabled', scale: 'css' });
    screenshots.push(filename);
  };
  const check = async (name, work) => {
    const startedAt = new Date().toISOString();
    await t.test(name, async () => {
      try { await work(); report.checks.push({ name, startedAt, passed: true }); }
      catch (error) { report.checks.push({ name, startedAt, passed: false, error: error.message }); throw error; }
    });
    if (report.checks.at(-1)?.passed === false) throw new Error(`中止后续场景：${name}`);
  };
  try {
    if (runtimeEnabled) {
      const fixturePath = process.env.MESNIER_UI_FIXTURE_MODULE ?? path.join(repository, 'tests/acceptance/fixtures/model-server.mjs');
      const module = await import(pathToFileURL(fixturePath).href);
      fixture = await module.startModelServer();
      fixture.prompt = module.fixturePrompt;
    }
    await launch();
    await check('首次启动无演示记录，深浅主题可切换', async () => {
      const value = await snapshot();
      assert.equal(value.projects.length, 0); assert.equal(value.sessions.length, 0); assert.equal(value.tasks.length, 0); assert.equal(value.runs.length, 0);
      await page.getByRole('heading', { name: /在对话中探索/ }).waitFor();
      assert.equal(await page.locator('.welcome-description').evaluate((element) => getComputedStyle(element).fontSize), '14px');
      await screenshot('01-welcome-light');
      await page.getByRole('button', { name: '切换深色外观' }).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      await screenshot('02-welcome-dark');
      await page.getByRole('button', { name: '切换浅色外观' }).click();
    });
    let modelId;
    await check('模型设置可创建与编辑，不向快照泄露密钥', async () => {
      await page.getByRole('button', { name: '设置与模型' }).click();
      const dialog = page.getByRole('dialog', { name: '工作台设置' });
      await dialog.getByLabel('配置名称').fill('界面验收模型');
      await dialog.getByLabel('API 地址').fill(fixture?.baseUrl ?? 'http://127.0.0.1:9/v1');
      await dialog.getByLabel('模型名称').fill('mesnier-fixture');
      if (fixture) await dialog.getByLabel('API 密钥').fill(fixture.apiKey);
      await dialog.getByRole('button', { name: fixture ? '保存并验证' : '保存配置', exact: true }).click();
      const value = await waitState((state) => state.models.length === 1 && (!fixture || state.models[0].status === 'ready'), '模型配置保存与验证');
      modelId = value.models[0].id;
      assert.equal(Object.hasOwn(value.models[0], 'apiKey'), false);
      if (fixture) assert.equal(JSON.stringify(value).includes(fixture.apiKey), false);
      await dialog.getByLabel('配置名称').fill('界面验收模型（已编辑）');
      await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
      await waitState((state) => state.models[0].name === '界面验收模型（已编辑）', '模型编辑');
      await screenshot('03-model-settings');
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    });
    let projectId;
    let sessionId;
    let taskId;
    await check('真实普通目录可创建项目，会话草稿保留且新建任务不自动执行', async () => {
      await page.getByRole('button', { name: '添加项目', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '添加工作项目' });
      await dialog.getByLabel('项目名称').fill('普通文件工作');
      await dialog.getByLabel('工作目录').fill(projectRoot);
      await dialog.getByRole('button', { name: '添加项目', exact: true }).click();
      let value = await waitState((state) => state.projects.length === 1, '项目创建');
      projectId = value.projects[0].id;
      assert.equal(value.projects[0].path, projectRoot);
      await page.getByRole('button', { name: /新建对话/ }).click();
      value = await waitState((state) => state.sessions.length === 1, '会话创建');
      sessionId = value.sessions[0].id;
      await page.getByLabel('消息输入').fill('这是一份暂不发送的会话草稿。');
      await page.getByRole('button', { name: '加入看板', exact: true }).click();
      const taskDialog = page.getByRole('dialog', { name: '将对话加入看板' });
      await taskDialog.getByLabel('任务标题').fill('整理普通目录中的资料');
      await taskDialog.getByLabel('目标与背景').fill('创建一份便于阅读的资料清单。');
      await taskDialog.getByLabel('验收标准').fill('清单文件存在，内容可以预览。');
      await taskDialog.getByRole('button', { name: '加入看板', exact: true }).click();
      value = await waitState((state) => state.tasks.length === 1, '对话关联任务');
      taskId = value.tasks[0].id;
      assert.equal(value.tasks[0].sessionId, sessionId); assert.equal(value.tasks[0].status, 'todo'); assert.equal(value.runs.length, 0); assert.equal(value.sessions.length, 1);
      await page.getByRole('button', { name: '进入对话', exact: true }).click();
      assert.equal(await page.getByLabel('消息输入').inputValue(), '这是一份暂不发送的会话草稿。');
      await page.getByRole('button', { name: '查看任务', exact: true }).click();
      assert.equal((await snapshot()).tasks.length, 1);
      await screenshot('04-board-task-details');
    });
    await check('看板筛选、任务编辑和会话重命名保留关联身份', async () => {
      await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('不存在的标题');
      assert.equal(await page.locator('[data-task-id]').count(), 0);
      await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('');
      await page.getByRole('button', { name: '编辑', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '编辑任务' });
      await dialog.getByLabel('验收标准').fill('清单文件存在，内容可预览，并由用户明确验收。');
      await dialog.getByRole('button', { name: '保存修改' }).click();
      await waitState((state) => state.tasks[0].acceptanceCriteria.includes('明确验收'), '编辑验收标准');
      await page.getByRole('button', { name: '进入对话', exact: true }).click();
      await page.getByRole('button', { name: '重命名会话' }).click();
      const rename = page.getByRole('dialog', { name: '重命名会话' });
      await rename.getByLabel('会话标题').fill('资料整理会话');
      await rename.getByRole('button', { name: '保存', exact: true }).click();
      const value = await waitState((state) => state.sessions[0].title === '资料整理会话', '会话重命名');
      assert.equal(value.sessions[0].id, sessionId); assert.equal(value.tasks[0].id, taskId);
      await page.getByRole('button', { name: '项目目录与设置' }).click();
      const projectDialog = page.getByRole('dialog', { name: '普通文件工作' });
      assert.equal(await projectDialog.getByRole('button', { name: '移除空项目' }).isDisabled(), true);
      await projectDialog.getByRole('button', { name: '关闭', exact: true }).click();
    });
    await check('新增默认模型立即用于后续选择，删除后回到保留的模型', async () => {
      await page.getByRole('button', { name: '设置与模型' }).click();
      const dialog = page.getByRole('dialog', { name: '工作台设置' });
      await dialog.getByRole('button', { name: '新增', exact: true }).click();
      await dialog.getByLabel('配置名称').fill('临时第二模型');
      await dialog.getByLabel('API 地址').fill(fixture?.baseUrl ?? 'http://127.0.0.1:9/v1');
      await dialog.getByLabel('模型名称').fill('mesnier-fixture-second');
      if (fixture) await dialog.getByLabel('API 密钥').fill(fixture.apiKey);
      await dialog.getByRole('button', { name: '保存配置', exact: true }).click();
      const value = await waitState((state) => state.models.length === 2, '第二模型保存');
      const secondId = value.models.find((model) => model.id !== modelId).id;
      await dialog.getByRole('button', { name: '设为默认模型', exact: true }).click();
      await waitState((state) => state.defaultModelId === secondId, '默认模型更改');
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      assert.equal(await page.getByLabel('本次执行模型').inputValue(), secondId);
      await page.getByRole('button', { name: '设置与模型' }).click();
      await dialog.getByRole('button', { name: '删除配置', exact: true }).click();
      await dialog.getByRole('button', { name: '确认删除配置', exact: true }).click();
      await waitState((state) => state.models.length === 1 && state.defaultModelId === modelId, '删除后默认模型回退');
      await dialog.getByRole('button', { name: '关闭', exact: true }).click();
      assert.equal(await page.getByLabel('本次执行模型').inputValue(), modelId);
    });
    await check(runtimeEnabled ? '可发送状态下中文组合输入不发送，会话切换保留各自草稿' : '会话切换保留各自草稿（IME 可发送状态留待运行时场景）', async () => {
      if (runtimeEnabled) {
        await waitState((state) => state.runtime.ready, 'IME 测试前运行时就绪', 45_000);
        assert.equal(await page.getByRole('button', { name: '发送', exact: true }).isEnabled(), true);
        await page.getByLabel('消息输入').dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, keyCode: 229 });
        await delay(150);
        assert.equal((await snapshot()).runs.length, 0);
        assert.equal(await page.getByLabel('消息输入').inputValue(), '这是一份暂不发送的会话草稿。');
      }
      await page.getByRole('button', { name: /新建对话/ }).click();
      await waitState((state) => state.sessions.length === 2, '第二会话创建');
      await page.getByLabel('消息输入').fill('第二个会话的独立草稿。');
      await page.getByRole('button', { name: '资料整理会话', exact: true }).click();
      assert.equal(await page.getByLabel('消息输入').inputValue(), '这是一份暂不发送的会话草稿。');
      await page.getByRole('button', { name: '切换产物与记录面板' }).click();
    });
    await check('最小窗口不溢出应用，主题和历史在真实重启后恢复', async () => {
      await page.getByRole('button', { name: '切换深色外观' }).click();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
      await page.locator('.shell.inspector-overlay').waitFor();
      await screenshot('05-chat-narrow-dark');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.equal(await page.locator('.main-pane').evaluate((element) => element.inert), true, '覆盖详情时底层工作区不可误操作');
      const overlay = await page.locator('.inspector').boundingBox();
      assert.ok(overlay.x >= 0 && overlay.x + overlay.width <= 1000 && overlay.y + overlay.height <= 700);
      assert.equal(await page.getByRole('button', { name: '关闭详情面板' }).evaluate((element) => document.activeElement === element), true);
      await page.keyboard.press('Escape');
      await page.locator('.inspector').waitFor({ state: 'detached' });
      assert.equal(await page.locator('.main-pane').evaluate((element) => element.inert), false);
      assert.equal(await page.getByLabel('消息输入').inputValue(), '这是一份暂不发送的会话草稿。');
      const visibleComposer = await page.locator('.composer').boundingBox();
      assert.ok(visibleComposer.width >= 480 && visibleComposer.x + visibleComposer.width <= 1000, '关闭详情后保留可读的输入区域');
      await screenshot('05b-chat-narrow-uncovered');
      await page.getByRole('button', { name: '切换浅色外观' }).click();
      await page.getByRole('button', { name: '设置与模型' }).click();
      const settings = page.getByRole('dialog', { name: '工作台设置' });
      await settings.locator('.model-fields').evaluate((element) => { element.scrollTop = element.scrollHeight; });
      const settingsBox = await settings.boundingBox();
      const headingBox = await settings.locator('.settings-frame-header').boundingBox();
      assert.ok(headingBox.y >= settingsBox.y && headingBox.y + headingBox.height <= settingsBox.y + settingsBox.height, '滚动设置时标题与关闭按钮保持可访问');
      assert.ok(headingBox.y - settingsBox.y <= 6, '固定标题贴合设置内容框上沿，不让滚动正文从上方露出');
      assert.equal(await settings.evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, '设置中的长路径不能水平溢出');
      await screenshot('05d-settings-narrow-light');
      await settings.getByRole('button', { name: '关闭', exact: true }).click();
      await page.getByRole('button', { name: '切换深色外观' }).click();
      await page.getByRole('button', { name: '查看任务', exact: true }).click();
      await page.getByRole('button', { name: '进入对话', exact: true }).click();
      await page.locator('.inspector').waitFor({ state: 'detached' });
      assert.equal(await page.getByLabel('消息输入').inputValue(), '这是一份暂不发送的会话草稿。');
      await page.getByRole('button', { name: '切换产物与记录面板' }).click();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 930));
      await page.locator('.shell:not(.inspector-overlay)').waitFor();
      const wideComposer = await page.locator('.composer').boundingBox();
      const wideInspector = await page.locator('.inspector').boundingBox();
      assert.ok(wideComposer.x + wideComposer.width <= wideInspector.x, '宽窗口恢复并排且不遮挡发送区');
      assert.equal(await page.locator('.main-pane').evaluate((element) => element.inert), false);
      await screenshot('05c-chat-wide-dark');
      await app.close(); app = undefined;
      await launch();
      await waitState((state) => state.projects[0]?.id === projectId && state.sessions[0]?.id === sessionId && state.tasks[0]?.id === taskId, '重启历史恢复');
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      assert.equal((await snapshot()).runs.length, 0);
      await screenshot('06-restarted-history');
      await page.getByRole('button', { name: '切换浅色外观' }).click();
    });
    if (runtimeEnabled) {
      await waitState((state) => state.runtime.ready, '真实内置运行时就绪', 45_000);
      report.runtime = (await snapshot()).runtime;
      report.modelKind = 'controlled-http-fixture';
      report.modelId = modelId;
      const newChat = async () => {
        const previous = (await snapshot()).sessions.length;
        await page.getByRole('button', { name: /新建对话/ }).click();
        const value = await waitState((state) => state.sessions.length === previous + 1, '新建场景会话');
        return value.sessions.at(-1).id;
      };
      const sendScenario = async (targetSessionId, scenario) => {
        const previous = (await snapshot()).runs.length;
        await page.getByLabel('消息输入').fill(fixture.prompt(scenario));
        await page.getByRole('button', { name: '发送', exact: true }).click();
        const value = await waitState((state) => state.runs.length === previous + 1 && state.runs.at(-1).sessionId === targetSessionId, '创建真实执行');
        return value.runs.at(-1).id;
      };
      const waitApproval = (id) => waitState((state) => {
        if (state.approvals.some((item) => item.runId === id)) return true;
        const run = state.runs.find((item) => item.id === id);
        if (run && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)) throw new Error(`工具授权未出现，执行已进入 ${run.status}：${run.error ?? '无错误说明'}`);
        return false;
      }, '真实工具授权');
      const waitEnded = (id) => waitState((state) => state.runs.some((run) => run.id === id && ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(run.status)), '执行结束');
      const approveInChat = () => page.locator('.conversation').getByRole('button', { name: '允许本次', exact: true });
      const rejectInChat = () => page.locator('.conversation').getByRole('button', { name: '拒绝本次', exact: true });
      const deliverable = path.join(projectRoot, 'deliverable.md');
      const deliverableText = '# 工作产物\n\n此内容由真实 Kimi Write 工具写入。\n';
      let workRunId;
      await check('Chat → Board → Chat 保持同一审批与执行，允许后真实文件写入且进入待验收', async () => {
        workRunId = await sendScenario(sessionId, { kind: 'write', path: deliverable, content: deliverableText });
        let value = await waitApproval(workRunId);
        const approvalId = value.approvals.find((approval) => approval.runId === workRunId).requestId;
        assert.equal(value.tasks.find((item) => item.id === taskId).status, 'in_progress');
        await page.getByRole('button', { name: '看板', exact: true }).click();
        await page.locator(`[data-task-id="${taskId}"]`).click();
        await page.getByRole('button', { name: '允许本次', exact: true }).waitFor();
        assert.equal(await page.locator('.inspector-content').evaluate((element) => element.scrollWidth <= element.clientWidth + 1), true, '工具授权中的长路径不能撑出详情面板');
        value = await snapshot();
        assert.equal(value.runs.length, 1); assert.equal(value.approvals[0].requestId, approvalId);
        await screenshot('07-approval-on-board');
        await page.getByRole('button', { name: '进入对话', exact: true }).click();
        value = await snapshot();
        assert.equal(value.runs[0].id, workRunId); assert.equal(value.approvals[0].requestId, approvalId);
        // 同一事件循环重复点击，验证界面锁与宿主只放行一次。
        await approveInChat().evaluate((element) => { element.click(); element.click(); });
        value = await waitEnded(workRunId);
        assert.equal(value.runs.find((run) => run.id === workRunId).status, 'succeeded');
        assert.equal(value.runs.length, 1);
        assert.equal(value.events.filter((event) => event.runId === workRunId && event.kind === 'approval.resolved' && event.payload.requestId === approvalId).length, 1);
        assert.equal(value.tasks.find((item) => item.id === taskId).status, 'review');
        assert.equal(await fs.readFile(deliverable, 'utf8'), deliverableText);
        assert.ok(value.artifacts.some((artifact) => artifact.runId === workRunId && artifact.path === deliverable));
        await page.locator('.tool-event summary').first().click();
        await screenshot('08-tool-result-and-review');
      });
      await check('真实产物可预览与复制，丢失文件明确报错，明确验收才成为已完成', async () => {
        const fileButton = page.locator('.artifact-row').filter({ hasText: 'deliverable.md' });
        await fileButton.click();
        let dialog = page.getByRole('dialog', { name: 'deliverable.md', exact: true });
        await dialog.locator('.artifact-preview').waitFor();
        assert.equal(await dialog.locator('.artifact-preview pre').textContent(), deliverableText);
        // 剪贴板是共享资源；旧内容只保留在测试进程内存，不进入日志或证据。
        const previousClipboard = await app.evaluate(({ clipboard }) => ({ formats: clipboard.availableFormats(), text: clipboard.readText() }));
        const textFormats = new Set(['text/plain', 'public.utf8-plain-text', 'public.utf16-external-plain-text', 'NSStringPboardType']);
        if (previousClipboard.formats.every((format) => textFormats.has(format))) {
          clipboardRestore = previousClipboard.text;
          clipboardTestText = deliverableText;
          await dialog.getByRole('button', { name: '复制内容', exact: true }).click();
          await dialog.getByRole('button', { name: '已复制', exact: true }).waitFor();
          assert.equal(await app.evaluate(({ clipboard }) => clipboard.readText()), deliverableText);
          await app.evaluate(({ clipboard }, previous) => clipboard.writeText(previous), clipboardRestore);
          clipboardRestore = undefined;
          report.clipboard = { tested: true, restored: true };
        } else {
          report.clipboard = { tested: false, reason: '开始时剪贴板含非文本格式；为完整保留用户内容，未修改剪贴板。' };
        }
        await screenshot('09-artifact-preview');
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await fs.unlink(deliverable);
        await fileButton.click();
        dialog = page.getByRole('dialog', { name: 'deliverable.md', exact: true });
        await dialog.getByRole('alert').waitFor();
        assert.match(await dialog.getByRole('alert').textContent(), /文件无法访问/);
        assert.equal(await dialog.getByRole('button', { name: '在文件夹中显示' }).isDisabled(), true);
        await screenshot('10-missing-artifact');
        await fs.writeFile(deliverable, deliverableText);
        await dialog.getByRole('button', { name: '刷新', exact: true }).click();
        await dialog.locator('.artifact-preview').waitFor();
        assert.equal(await dialog.locator('.artifact-preview pre').textContent(), deliverableText);
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await page.getByRole('button', { name: '验收通过', exact: true }).click();
        const accept = page.getByRole('dialog', { name: '确认任务验收' });
        await accept.getByLabel('验收说明（可选）').fill('已核对真实文件与预览内容，验收通过。');
        await accept.getByRole('button', { name: '确认验收通过', exact: true }).click();
        const value = await waitState((state) => state.tasks.find((item) => item.id === taskId)?.status === 'done', '明确验收');
        assert.ok(value.tasks[0].acceptedAt); assert.equal(value.runs.length, 1);
        await page.getByRole('button', { name: '看板', exact: true }).click();
        await screenshot('11-accepted-board-task');
      });
      await check('拒绝真实 Write 授权不写文件，界面保留拒绝事实', async () => {
        const rejectSession = await newChat();
        const rejectedFile = path.join(projectRoot, 'must-not-be-written.txt');
        const runId = await sendScenario(rejectSession, { kind: 'reject', path: rejectedFile, content: '不得落盘' });
        await waitApproval(runId);
        await rejectInChat().click();
        const value = await waitEnded(runId);
        await assert.rejects(fs.access(rejectedFile));
        assert.ok(value.events.some((event) => event.runId === runId && event.kind === 'approval.resolved' && event.payload.decision === 'rejected'));
        await page.getByText('已拒绝本次工具操作', { exact: true }).waitFor();
        await screenshot('12-permission-rejected');
      });
      let cancellationRunId;
      let followupModelId;
      await check('执行中修改默认模型保留启动快照，取消确认且保留已经写入的文件', async () => {
        const cancelSession = await newChat();
        const sideEffect = path.join(projectRoot, 'cancel-side-effect.txt');
        cancellationRunId = await sendScenario(cancelSession, { kind: 'bash', command: "printf 'retained-ui-cancel\\n' > cancel-side-effect.txt; sleep 30", cwd: projectRoot });
        await waitApproval(cancellationRunId);
        await approveInChat().click();
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) { try { await fs.access(sideEffect); break; } catch { await delay(60); } }
        assert.equal(await fs.readFile(sideEffect, 'utf8'), 'retained-ui-cancel\n');
        await page.getByLabel('消息输入').fill('执行期间留下的下一步草稿。');
        await page.getByLabel('消息输入').press('Enter');
        assert.equal(await page.getByLabel('消息输入').inputValue(), '执行期间留下的下一步草稿。');
        await page.getByRole('button', { name: '设置与模型' }).click();
        const settings = page.getByRole('dialog', { name: '工作台设置' });
        await settings.getByRole('button', { name: '新增', exact: true }).click();
        await settings.getByLabel('配置名称').fill('后续执行模型');
        await settings.getByLabel('API 地址').fill(fixture.baseUrl);
        await settings.getByLabel('模型名称').fill('mesnier-fixture-next');
        await settings.getByLabel('API 密钥').fill(fixture.apiKey);
        await settings.getByRole('button', { name: '保存配置', exact: true }).click();
        let value = await waitState((state) => state.models.length === 2, '活动期间保存新模型');
        followupModelId = value.models.find((model) => model.id !== modelId).id;
        await settings.getByRole('button', { name: '设为默认模型', exact: true }).click();
        await waitState((state) => state.defaultModelId === followupModelId, '活动期间更改默认模型');
        await settings.getByRole('button', { name: '关闭', exact: true }).click();
        value = await snapshot();
        assert.equal(value.runs.find((run) => run.id === cancellationRunId).model.id, modelId);
        assert.equal(await page.getByLabel('本次执行模型').inputValue(), followupModelId);
        await page.getByRole('button', { name: '停止执行', exact: true }).click();
        value = await waitEnded(cancellationRunId);
        assert.equal(value.runs.find((run) => run.id === cancellationRunId).status, 'cancelled');
        assert.equal(await fs.readFile(sideEffect, 'utf8'), 'retained-ui-cancel\n');
        assert.equal(await page.getByLabel('消息输入').inputValue(), '执行期间留下的下一步草稿。');
        await screenshot('13-cancelled-with-side-effect');
      });
      await check('显式重试生成新身份，使用新模型且不覆盖原取消记录', async () => {
        const previous = (await snapshot()).runs.length;
        const fileBefore = await fs.stat(path.join(projectRoot, 'cancel-side-effect.txt'));
        await page.getByRole('button', { name: '显式重试', exact: true }).click();
        const retry = page.getByRole('dialog', { name: '重试这次执行' });
        await retry.getByText(/已发生的文件改动不会自动回滚/).waitFor();
        await retry.getByRole('button', { name: '确认重试', exact: true }).click();
        let value = await waitState((state) => state.runs.length === previous + 1, '显式重试产生执行');
        const run = value.runs.at(-1);
        assert.notEqual(run.id, cancellationRunId); assert.equal(run.retryOf, cancellationRunId); assert.equal(run.model.id, followupModelId);
        await waitApproval(run.id);
        await rejectInChat().click();
        value = await waitEnded(run.id);
        assert.equal(value.runs.find((item) => item.id === cancellationRunId).status, 'cancelled');
        assert.equal((await fs.stat(path.join(projectRoot, 'cancel-side-effect.txt'))).mtimeMs, fileBefore.mtimeMs);
        await screenshot('14-retry-preserves-history');
      });
      await check('模型失败传播到真实界面，服务回显的凭据被脱敏', async () => {
        const failedSession = await newChat();
        const runId = await sendScenario(failedSession, { kind: 'error', status: 401, echoCredential: true });
        const value = await waitEnded(runId);
        assert.equal(value.runs.find((run) => run.id === runId).status, 'failed');
        assert.equal(JSON.stringify(value).includes(fixture.apiKey), false);
        assert.equal((await page.locator('body').innerText()).includes(fixture.apiKey), false);
        await screenshot('15-model-error');
      });
      await check('正常关闭保留已确认取消，重启不重放，显式新输入恢复同一会话', async () => {
        const resumeSession = await newChat();
        const runId = await sendScenario(resumeSession, { kind: 'hold' });
        let value = await waitState((state) => state.messages.some((message) => message.runId === runId && message.text.includes('等待取消')), '重启前流式内容');
        const nativeSessionId = value.sessions.find((item) => item.id === resumeSession).runtimeSessionId;
        const runCount = value.runs.length;
        const requestsBefore = fixture.requests.length;
        await app.close(); app = undefined;
        await launch();
        value = await waitState((state) => state.runtime.ready && ['cancelled', 'interrupted'].includes(state.runs.find((run) => run.id === runId)?.status), '重启保留停止结果', 45_000);
        const cancelledConfirmed = value.events.some((event) => event.runId === runId && event.kind === 'run.cancelled');
        const expectedStatus = cancelledConfirmed ? 'cancelled' : 'interrupted';
        assert.equal(value.runs.find((run) => run.id === runId).status, expectedStatus);
        report.normalExitStatus = expectedStatus;
        assert.equal(value.runs.length, runCount);
        assert.equal(fixture.requests.length, requestsBefore);
        assert.equal(value.approvals.length, 0);
        await page.locator(`[data-session-id="${resumeSession}"]`).click();
        await screenshot('16-normal-exit-after-restart');
        const continued = await sendScenario(resumeSession, { kind: 'text', text: '显式继续后，会话已经恢复。' });
        value = await waitEnded(continued);
        assert.equal(value.runs.find((run) => run.id === continued).status, 'succeeded');
        assert.equal(value.sessions.find((item) => item.id === resumeSession).runtimeSessionId, nativeSessionId);
        assert.equal(value.runs.find((run) => run.id === runId).status, expectedStatus);
        await screenshot('17-resumed-session');
      });
      await check('实际强杀应用后未确认执行标为中断，无孤立运行时和自动重放', async () => {
        const crashedSession = await newChat();
        const runId = await sendScenario(crashedSession, { kind: 'hold' });
        let value = await waitState((state) => state.messages.some((message) => message.runId === runId && message.text.includes('等待取消')), '强杀前流式执行');
        const nativeSessionId = value.sessions.find((item) => item.id === crashedSession).runtimeSessionId;
        const runCount = value.runs.length;
        const requestsBefore = fixture.requests.length;
        const child = app.process();
        const runtimePids = ownRuntimePids();
        assert.equal(runtimePids.length, 1, '本次应用应持有一个独立运行时');
        report.forcedExit = { electronPid: child.pid, runtimePids };
        // 等待已观察的会话事实落盘，随后用真实 SIGKILL 绕过正常退出流程。
        const flushDeadline = Date.now() + 5_000;
        while (Date.now() < flushDeadline) {
          const persisted = JSON.parse(await fs.readFile(path.join(dataRoot, 'state.json'), 'utf8'));
          if (persisted.messages.some((message) => message.runId === runId && message.text.includes('等待取消'))) break;
          await delay(60);
        }
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
        app = undefined;
        const cleanupDeadline = Date.now() + 8_000;
        while (ownRuntimePids().length && Date.now() < cleanupDeadline) await delay(100);
        assert.equal(ownRuntimePids().length, 0, '应用被强杀后不得留下孤立运行时');
        await launch();
        value = await waitState((state) => state.runtime.ready && state.runs.find((run) => run.id === runId)?.status === 'interrupted', '非正常退出恢复中断状态', 45_000);
        assert.equal(value.runs.length, runCount); assert.equal(fixture.requests.length, requestsBefore);
        assert.equal(value.approvals.length, 0);
        await page.locator(`[data-session-id="${crashedSession}"]`).click();
        await screenshot('18-forced-exit-interrupted');
        const continued = await sendScenario(crashedSession, { kind: 'text', text: '强制退出后由用户明确继续。' });
        value = await waitEnded(continued);
        assert.equal(value.runs.find((run) => run.id === continued).status, 'succeeded');
        assert.equal(value.sessions.find((item) => item.id === crashedSession).runtimeSessionId, nativeSessionId);
        assert.equal(value.runs.find((run) => run.id === runId).status, 'interrupted');
        await screenshot('19-forced-exit-explicit-resume');
      });
      await check('Git Coding 项目从看板启动，拒绝不改文件，批准后留下真实代码差异', async () => {
        const codingFile = path.join(codingRoot, 'sum.js');
        const original = 'export const sum = (a, b) => a - b;\n';
        const changed = 'export const sum = (a, b) => a + b;\n';
        await fs.writeFile(codingFile, original);
        execFileSync('git', ['-C', codingRoot, 'add', 'sum.js'], { env: gitEnv });
        execFileSync('git', ['-C', codingRoot, '-c', 'user.name=Mesnier UI 验收', '-c', 'user.email=ui-test@mesnier.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', '测试基线'], { env: gitEnv });
        report.codingBaseline = execFileSync('git', ['-C', codingRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', env: gitEnv }).trim();
        await page.getByRole('button', { name: '添加项目', exact: true }).click();
        const projectDialog = page.getByRole('dialog', { name: '添加工作项目' });
        await projectDialog.getByLabel('项目名称').fill('代码修改验收');
        await projectDialog.getByLabel('工作目录').fill(codingRoot);
        await projectDialog.getByRole('button', { name: '添加项目', exact: true }).click();
        await waitState((state) => state.projects.length === 2, '添加 Coding 项目');
        const codingSession = await newChat();
        const scenario = { kind: 'coding', path: codingFile, content: changed };
        await page.getByRole('button', { name: '加入看板', exact: true }).click();
        const taskDialog = page.getByRole('dialog', { name: '将对话加入看板' });
        await taskDialog.getByLabel('任务标题').fill('修复加法函数');
        await taskDialog.getByLabel('目标与背景').fill(fixture.prompt(scenario));
        await taskDialog.getByLabel('验收标准').fill('sum 返回两数之和，Git diff 中只有这一处行为修正。');
        const codingAgent = (await snapshot()).agents.find((agent) => agent.id === 'coding');
        if (codingAgent) await taskDialog.getByLabel('指派 Agent').selectOption(codingAgent.id);
        await taskDialog.getByRole('button', { name: '加入看板', exact: true }).click();
        let value = await waitState((state) => state.tasks.length === 2, '创建 Coding 看板任务');
        const previous = value.runs.length;
        await page.getByRole('button', { name: '开始执行', exact: true }).click();
        value = await waitState((state) => state.runs.length === previous + 1, '从看板启动真实 Coding 执行');
        const firstRun = value.runs.at(-1);
        assert.equal(firstRun.sessionId, codingSession);
        if (codingAgent) assert.equal(firstRun.agent.id, codingAgent.id);
        await waitApproval(firstRun.id);
        await screenshot('20-coding-git-approval');
        await page.getByRole('button', { name: '拒绝本次', exact: true }).click();
        await waitEnded(firstRun.id);
        assert.equal(await fs.readFile(codingFile, 'utf8'), original);
        assert.equal(execFileSync('git', ['-C', codingRoot, 'diff', '--', 'sum.js'], { encoding: 'utf8', env: gitEnv }), '');
        await page.getByRole('button', { name: '进入对话', exact: true }).click();
        const secondRun = await sendScenario(codingSession, scenario);
        await waitApproval(secondRun);
        await approveInChat().click();
        value = await waitEnded(secondRun);
        assert.equal(value.runs.find((run) => run.id === secondRun).status, 'succeeded');
        assert.equal(await fs.readFile(codingFile, 'utf8'), changed);
        report.codingDiff = execFileSync('git', ['-C', codingRoot, 'diff', '--', 'sum.js'], { encoding: 'utf8', env: gitEnv });
        assert.match(report.codingDiff, /\+export const sum = \(a, b\) => a \+ b;/);
        const codingTask = value.tasks.find((item) => item.sessionId === codingSession);
        assert.equal(codingTask.status, 'review'); assert.equal(codingTask.acceptedAt, undefined);
        await page.locator('.artifact-row').filter({ hasText: 'sum.js' }).click();
        const artifactDialog = page.getByRole('dialog', { name: 'sum.js', exact: true });
        await artifactDialog.locator('.artifact-preview').waitFor();
        assert.equal(await artifactDialog.locator('.artifact-preview pre').textContent(), changed);
        await screenshot('21-coding-file-result');
        await artifactDialog.getByRole('button', { name: '关闭', exact: true }).click();
      });
      await check('缺失用量显示未提供，真实零和含缓存的正数保留实际值', async () => {
        const usageSession = await newChat();
        const missing = await sendScenario(usageSession, { kind: 'text', text: '这次响应没有提供用量。' });
        let value = await waitEnded(missing);
        assert.equal(value.runs.find((run) => run.id === missing).usage, undefined);
        await page.getByRole('button', { name: '切换产物与记录面板' }).click();
        assert.match(await page.locator('.run-history').first().textContent(), /输入用量：未提供/);
        const zero = await sendScenario(usageSession, { kind: 'text', text: '这次响应显式提供真实零值。', usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
        value = await waitEnded(zero);
        assert.deepEqual(value.runs.find((run) => run.id === zero).usage, { inputTokens: 0, outputTokens: 0 });
        assert.match(await page.locator('.run-history').first().textContent(), /输入用量：0 tokens/);
        const positive = await sendScenario(usageSession, { kind: 'text', text: '这次响应包含实际输入、缓存和输出计数。', usage: { prompt_tokens: 21, completion_tokens: 8, total_tokens: 29, prompt_tokens_details: { cached_tokens: 5 } } });
        value = await waitEnded(positive);
        assert.deepEqual(value.runs.find((run) => run.id === positive).usage, { inputTokens: 21, outputTokens: 8 });
        assert.match(await page.locator('.run-history').first().textContent(), /输入用量：21 tokens/);
        assert.match(await page.locator('.run-history').first().textContent(), /输出用量：8 tokens/);
        const missingAgain = await sendScenario(usageSession, { kind: 'text', text: '恢复同一会话，但本次仍然没有用量。' });
        value = await waitEnded(missingAgain);
        assert.equal(value.runs.find((run) => run.id === missingAgain).usage, undefined);
        assert.deepEqual(value.runs.find((run) => run.id === positive).usage, { inputTokens: 21, outputTokens: 8 });
        assert.match(await page.locator('.run-history').first().textContent(), /输入用量：未提供/);
        await screenshot('22-usage-availability');
      });
      const finalState = await snapshot();
      report.finalState = { projects: finalState.projects.length, sessions: finalState.sessions.length, tasks: finalState.tasks.map(({ id, status }) => ({ id, status })), runs: finalState.runs.map(({ id, status, retryOf, model }) => ({ id, status, retryOf, modelId: model.id })), artifacts: finalState.artifacts.map(({ id, runId, relativePath, change }) => ({ id, runId, relativePath, change })) };
      report.modelRequests = fixture.requests;
    }
    assert.deepEqual(report.pageErrors, []);
    report.passed = true;
  } catch (error) {
    report.error = error.message;
    failure = error;
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  } finally {
    const teardownErrors = [];
    if (clipboardRestore !== undefined) {
      try {
        if (!app) await launch();
        const restored = await app.evaluate(({ clipboard }, { previous, ownText }) => {
          if (clipboard.readText() !== ownText) return false;
          clipboard.writeText(previous); return true;
        }, { previous: clipboardRestore, ownText: clipboardTestText });
        report.clipboard = { tested: true, restored, ...(restored ? {} : { reason: '测试期间剪贴板已变化，保留更新后的内容。' }) };
      } catch (error) { teardownErrors.push(error); }
      clipboardRestore = undefined;
    }
    if (app) { try { await app.close(); } catch (error) { teardownErrors.push(error); } }
    const orphaned = ownRuntimePids();
    if (orphaned.length) {
      teardownErrors.push(new Error('应用退出后仍有本任务运行时存活，已清理并判定失败。'));
      for (const pid of orphaned) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') teardownErrors.push(error); } }
      await delay(400);
      for (const pid of ownRuntimePids()) { try { process.kill(pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') teardownErrors.push(error); } }
    }
    if (fixture) { try { await fixture.close(); } catch (error) { teardownErrors.push(error); } }
    if (teardownErrors.length) {
      report.passed = false;
      report.teardownErrors = teardownErrors.map((error) => error.message);
      failure ??= new AggregateError(teardownErrors, '验收资源收尾失败');
    }
    report.screenshots = screenshots;
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(evidenceRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) throw failure;
});
