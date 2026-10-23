import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { _electron as electron } from 'playwright-core';

const repository = path.resolve(import.meta.dirname, '../..');
const installedApp = process.env.MESNIER_INSTALLED_APP ? path.resolve(process.env.MESNIER_INSTALLED_APP) : undefined;
const evidence = path.resolve(process.env.MESNIER_UI_EVIDENCE ?? path.join(repository, '.evidence', `sidebar-${Date.now()}`));
const data = path.join(evidence, 'data');
const launch = path.join(evidence, 'app');
const hash = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

test('侧栏层级、搜索、历史与折叠使用同一工作记录', { timeout: 90_000 }, async () => {
  await fs.mkdir(data, { recursive: true });
  await fs.mkdir(launch, { recursive: true });
  await fs.cp(path.join(repository, 'dist'), path.join(launch, 'dist'), { recursive: true });
  await fs.copyFile(path.join(repository, 'package.json'), path.join(launch, 'package.json'));
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mesnier-sidebar-'));
  const now = Date.now();
  const at = (hours) => new Date(now - hours * 3600_000).toISOString();
  const projects = [{ id: 'alpha', name: 'Mesnier' }, { id: 'beta', name: 'SDrama' }, { id: 'empty', name: '资料工作区' }].map((item) => ({ ...item, path: path.join(work, item.id), createdAt: at(100) }));
  for (const project of projects) await fs.mkdir(project.path);
  const titles = ['整理产品需求与界面参考', 'Kimi Code 底座接入验证', '检查桌面工作台的交互细节', '准备发布说明与验收记录', '梳理项目中的文件与资料', '完善模型设置的错误提示', '核对长标题在侧栏中的截断与项目层级是否仍然清晰可读', '复查历史执行与工作产物'];
  const sessions = titles.map((title, index) => ({ id: `alpha-${index}`, projectId: 'alpha', title, createdAt: at(100), updatedAt: at(index * 24 + 2) }));
  sessions.push({ id: 'beta-0', projectId: 'beta', title: '渠道管理三态拆分任务进度', createdAt: at(100), updatedAt: at(17) }, { id: 'beta-1', projectId: 'beta', title: '清理 native 项目硬盘占用', createdAt: at(100), updatedAt: at(78) });
  // 只为界面导航预置隔离历史；不伪造运行结果，不用此数据证明执行能力。
  await fs.writeFile(path.join(data, 'state.json'), JSON.stringify({ schemaVersion: 1, revision: 1, projects, sessions, tasks: [], runs: [], messages: [], events: [], approvals: [], artifacts: [], models: [], agents: [{ id: 'general', name: '通用助手', instructions: '' }], runtime: {}, app: {} }));
  const report = { passed: false, checks: [], pageErrors: [], sourceHashes: {}, buildHashes: {}, screenshots: [] };
  for (const name of ['apps/desktop/src/renderer/App.tsx', 'apps/desktop/src/renderer/components/Sidebar.tsx', 'apps/desktop/src/renderer/navigation.ts', 'apps/desktop/src/renderer/styles.css', 'tests/ui/sidebar.test.mjs']) report.sourceHashes[name] = await hash(path.join(repository, name));
  for (const name of await fs.readdir(path.join(launch, 'dist/renderer/assets'))) report.buildHashes[name] = await hash(path.join(launch, 'dist/renderer/assets', name));
  let app; let page;
  const start = async () => {
    const executablePath = installedApp ? path.join(installedApp, 'Contents/MacOS/Mesnier') : path.join(repository, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
    app = await electron.launch({ executablePath, args: installedApp ? [] : [launch], cwd: launch, env: { ...process.env, MESNIER_HOME: data }, timeout: 30_000 });
    if (installedApp) {
      report.application = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), executable: app.getPath('exe') }));
      assert.equal(report.application.packaged, true);
      assert.equal(await fs.realpath(report.application.executable), await fs.realpath(executablePath));
      report.asarHash = await hash(path.join(installedApp, 'Contents/Resources/app.asar'));
    }
    page = await app.firstWindow(); page.setDefaultTimeout(8000);
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    await page.locator('.shell').waitFor();
  };
  const selected = (id) => page.locator(`[data-session-id="${id}"][aria-current="page"]`).waitFor();
  const screenshot = async (name, sidebarOnly = false) => {
    await (sidebarOnly ? page.locator('.sidebar') : page).screenshot({ path: path.join(evidence, `${name}.png`), animations: 'disabled', scale: 'css' });
    report.screenshots.push(`${name}.png`);
  };
  try {
    await start();
    const sidebar = () => page.getByRole('complementary', { name: '项目与会话导航' });
    await selected('alpha-0');
    assert.equal(await sidebar().locator('.brand').count(), 0);
    assert.equal(await sidebar().locator('[data-project-id="alpha"] [data-session-id]').count(), 6);
    const row = page.locator('[data-session-id="alpha-0"]');
    assert.equal((await row.boundingBox()).height, 32);
    assert.equal(await row.evaluate((element) => getComputedStyle(element).fontSize), '14px');
    assert.equal(await row.locator('time').evaluate((element) => getComputedStyle(element).fontSize), '12px');
    assert.equal(await row.evaluate((element) => getComputedStyle(element).boxShadow), 'none');
    await screenshot('01-sidebar-light', true);
    await screenshot('02-workbench-light');
    report.checks.push('264px侧栏、32px嵌套会话行、14/12px文字与中性选中层级');

    await page.getByRole('button', { name: '显示更多项目会话' }).click();
    await page.locator('[data-session-id="alpha-7"]').click();
    await page.getByLabel('消息输入').fill('Alpha 草稿，切换后保留。');
    await page.locator('[data-session-id="beta-1"]').click();
    await page.getByLabel('消息输入').fill('Beta 独立草稿。');
    await page.getByRole('button', { name: '后退', exact: true }).click();
    await selected('alpha-7');
    assert.equal(await page.getByLabel('消息输入').inputValue(), 'Alpha 草稿，切换后保留。');
    await page.getByRole('button', { name: '前进', exact: true }).click();
    await selected('beta-1');
    assert.equal(await page.getByLabel('消息输入').inputValue(), 'Beta 独立草稿。');
    await page.getByRole('button', { name: '后退', exact: true }).click();
    await selected('alpha-7');
    await page.locator('[data-session-id="alpha-1"]').click();
    await selected('alpha-1');
    await page.waitForFunction(() => document.querySelector('[aria-label="前进"]')?.disabled === true);
    assert.equal(await page.getByRole('button', { name: '前进', exact: true }).isDisabled(), true);
    report.checks.push('跨项目前后导航保留草稿，新选择截断前进分支');

    await page.getByRole('button', { name: '搜索任务列表' }).click();
    await page.getByLabel('搜索会话与项目').fill('长标题');
    assert.equal(await sidebar().locator('[data-session-id]').count(), 1);
    await page.locator('[data-session-id="alpha-6"]').click();
    await selected('alpha-6');
    await page.getByRole('button', { name: '清除搜索' }).click();
    await page.getByRole('button', { name: '按最近更新显示' }).click();
    await page.getByLabel('搜索会话与项目').fill('SDrama');
    assert.equal(await sidebar().locator('[data-session-id]').count(), 2);
    await page.getByRole('button', { name: '搜索任务列表' }).click();
    await page.getByRole('button', { name: '按项目显示' }).click();
    await sidebar().getByRole('button', { name: 'Mesnier', exact: true }).click();
    assert.equal(await sidebar().getByRole('button', { name: 'Mesnier', exact: true }).getAttribute('aria-expanded'), 'false');
    assert.equal(await sidebar().locator('[data-project-id="alpha"] [data-session-id]').count(), 0);
    await sidebar().getByRole('button', { name: 'Mesnier', exact: true }).click();
    await page.locator('[data-session-id="alpha-7"]').click();
    report.checks.push('搜索越过默认条数限制，项目/最近更新视图及项目展开可用');

    const width = (await page.locator('.workspace').boundingBox()).width;
    await page.getByRole('button', { name: '收起侧栏' }).click();
    assert.equal(await sidebar().isVisible(), false);
    assert.ok((await page.locator('.workspace').boundingBox()).width >= width + 260);
    assert.equal(await page.getByRole('button', { name: '展开侧栏' }).evaluate((element) => document.activeElement === element), true);
    await page.getByRole('button', { name: '展开侧栏' }).click();
    await selected('alpha-7');
    assert.equal(await page.getByLabel('消息输入').inputValue(), 'Alpha 草稿，切换后保留。');
    await sidebar().getByRole('button', { name: '新建任务', exact: true }).click();
    await page.getByRole('dialog', { name: '新建任务', exact: true }).getByRole('button', { name: '取消', exact: true }).click();
    const state = await page.evaluate(() => window.mesnier.getSnapshot());
    assert.equal(state.sessions.length, 10); assert.equal(state.runs.length, 0); assert.equal(state.tasks.length, 0);
    await page.getByRole('button', { name: '收起侧栏' }).click();
    await app.close(); app = undefined;
    await start();
    await page.getByRole('button', { name: '展开侧栏' }).click();
    await selected('alpha-7');
    assert.equal(await sidebar().locator('[data-project-id="alpha"] [data-session-id]').count(), 7, '分页之外的当前会话重启后仍显示');
    report.checks.push('收起恢复、焦点、偏好持久化、选中项可见且导航不创建执行');

    await page.getByRole('button', { name: '切换深色外观' }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1000, 700));
    const footer = await sidebar().locator('.sidebar-footer').boundingBox();
    assert.ok(footer.y + footer.height <= 700);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await sidebar().evaluate((element) => element.scrollWidth <= element.clientWidth), true);
    await screenshot('03-sidebar-dark', true); await screenshot('04-narrow-dark');
    assert.deepEqual(report.pageErrors, []);
    report.checks.push('最小窗口深色侧栏无溢出，底部设置保持可见');
    report.passed = true;
  } catch (error) {
    report.error = String(error); if (page) await screenshot('failure').catch(() => {}); throw error;
  } finally {
    if (app) await app.close();
    await fs.writeFile(path.join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
});
