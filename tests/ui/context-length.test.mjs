import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright-core';

const repository = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const appRoot = path.resolve(process.env.MESNIER_APP_ROOT ?? repository);
const installedApp = process.env.MESNIER_INSTALLED_APP ? path.resolve(process.env.MESNIER_INSTALLED_APP) : undefined;
const evidence = path.resolve(process.env.MESNIER_UI_EVIDENCE ?? path.join(repository, '.evidence/ui', `context-length-${Date.now()}`));
const executablePath = installedApp ? path.join(installedApp, 'Contents/MacOS/Mesnier') : process.env.MESNIER_ELECTRON_PATH ?? path.join(repository, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const hash = async (file) => createHash('sha256').update(await fs.readFile(file)).digest('hex');

// 仅返回模型设置入口要求的工具能力探测；不使用真实服务或用户密钥。
async function startModelServer() {
  const apiKey = 'mesnier-context-length-local-fixture';
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || !['/v1/chat/completions', '/v1/responses'].includes(request.url)) { response.writeHead(404).end(); return; }
    if (request.headers.authorization !== `Bearer ${apiKey}`) { response.writeHead(401).end(); return; }
    try {
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      const responses = request.url === '/v1/responses';
      const name = responses ? payload.tools?.[0]?.name : payload.tools?.[0]?.function?.name;
      assert.equal(name, 'mesnier_connection_check');
      requests.push({ provider: responses ? 'openai_responses' : 'openai', kind: 'connection-check' });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(responses
        ? { output: [{ type: 'function_call', id: 'call-context', call_id: 'call-context', name, arguments: '{"ready":true}' }] }
        : { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'call-context', type: 'function', function: { name, arguments: '{"ready":true}' } }] }, finish_reason: 'tool_calls' }] }));
    } catch { response.writeHead(400).end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { apiKey, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, async close() {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

test('上下文长度通过真实界面、宿主与持久化保持一致', { timeout: 90_000 }, async () => {
  await fs.mkdir(evidence, { recursive: true });
  const dataRoot = path.join(evidence, 'data');
  const launchRoot = path.join(evidence, 'app-snapshot');
  // 开发构建仅固定宿主与界面；安装包直接使用包内资源，两种模式均隔离应用数据。
  await fs.mkdir(launchRoot, { recursive: true });
  const buildHashes = {};
  const collect = async (directory) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) {
        const relative = path.relative(launchRoot, file);
        buildHashes[relative] = await hash(file);
        assert.equal(await hash(path.join(appRoot, relative)), buildHashes[relative], `冻结期间构建变化：${relative}`);
      }
    }
  };
  if (installedApp) {
    for (const file of ['Contents/Resources/app.asar', 'Contents/MacOS/Mesnier']) buildHashes[file] = await hash(path.join(installedApp, file));
  } else {
    await fs.copyFile(path.join(appRoot, 'package.json'), path.join(launchRoot, 'package.json'), constants.COPYFILE_FICLONE);
    await fs.cp(path.join(appRoot, 'dist'), path.join(launchRoot, 'dist'), { recursive: true, mode: constants.COPYFILE_FICLONE });
    buildHashes['package.json'] = await hash(path.join(launchRoot, 'package.json'));
    await collect(path.join(launchRoot, 'dist'));
  }
  const report = {
    kind: 'real-electron-context-length-controlled-service', startedAt: new Date().toISOString(),
    sourceBase: process.env.MESNIER_UI_SOURCE_BASE ?? null, appRoot, dataRoot, installedApp,
    testSourceSha256: await hash(fileURLToPath(import.meta.url)), buildHashes,
    environment: { platform: os.platform(), architecture: os.arch(), node: process.version },
    checks: [], pageErrors: [], passed: false,
  };
  let app;
  let page;
  let fixture;
  let failure;
  const snapshot = () => page.evaluate(() => window.mesnier.getSnapshot());
  const screenshot = async (name) => {
    const box = await page.getByRole('dialog', { name: '工作台设置' }).boundingBox();
    assert.ok(box);
    // 截取真实设置操作区，证据不包含下方的本机绝对数据路径。
    await page.screenshot({ path: path.join(evidence, `${name}.png`), clip: { ...box, height: Math.min(box.height, 720) }, animations: 'disabled', scale: 'css' });
  };
  const disk = async () => JSON.parse(await fs.readFile(path.join(dataRoot, 'state.json'), 'utf8'));
  const waitModel = async (predicate) => {
    for (let index = 0; index < 100; index++) {
      const value = await snapshot();
      if (predicate(value.models[0])) return value;
      await delay(50);
    }
    throw new Error('模型配置未按界面操作保存到宿主');
  };
  try {
    fixture = await startModelServer();
    app = await electron.launch({ executablePath, args: installedApp ? [] : [launchRoot], cwd: launchRoot, env: { ...process.env, MESNIER_HOME: dataRoot }, timeout: 30_000 });
    page = await app.firstWindow(); page.setDefaultTimeout(10_000);
    report.environment.electron = await app.evaluate(() => process.versions.electron);
    if (installedApp) {
      report.application = await app.evaluate(({ app }) => ({ isPackaged: app.isPackaged, executable: app.getPath('exe'), resources: process.resourcesPath, version: app.getVersion() }));
      assert.equal(report.application.isPackaged, true);
      assert.equal(await fs.realpath(report.application.executable), await fs.realpath(executablePath));
      assert.equal(await fs.realpath(report.application.resources), await fs.realpath(path.join(installedApp, 'Contents/Resources')));
    }
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    await page.getByRole('button', { name: '设置与模型' }).click();
    const dialog = page.getByRole('dialog', { name: '工作台设置' });
    assert.equal((await snapshot()).app.dataRoot, dataRoot);
    assert.equal((await snapshot()).models.length, 0);
    await dialog.getByLabel('配置名称').fill('上下文长度回归');
    await dialog.getByLabel('API 地址').fill(fixture.baseUrl);
    await dialog.getByLabel('模型名称').fill('mesnier-context-fixture');
    await dialog.getByLabel('API 密钥').fill(fixture.apiKey);
    const input = dialog.getByLabel('上下文长度');
    const save = dialog.getByRole('button', { name: '保存配置', exact: true });
    const verify = dialog.getByRole('button', { name: '保存并验证', exact: true });

    for (const provider of ['openai', 'openai_responses']) {
      await dialog.getByLabel('接口协议').selectOption(provider);
      await dialog.getByLabel('API 地址').fill(fixture.baseUrl);
      for (const value of [200000, 1024, 10000000, 100000]) {
        await input.fill(String(value));
        const before = fixture.requests.length;
        await verify.click();
        await delay(150);
        const validity = await input.evaluate((element) => ({ valid: element.validity.valid, stepMismatch: element.validity.stepMismatch, min: element.min, max: element.max, step: element.step }));
        const current = await snapshot();
        report.lastAttempt = { provider, value, action: '保存并验证', validity, modelCount: current.models.length, requestCount: fixture.requests.length };
        // 旧构建必须经真实点击后失败，保留“未进入宿主”的状态和本地服务请求数。
        assert.equal(validity.valid, true, `${value} 应允许保存并验证；浏览器实际 validity=${JSON.stringify(validity)}`);
        const ready = await waitModel((model) => model?.maxContextSize === value && model.status === 'ready');
        assert.equal(fixture.requests.length, before + 1);
        assert.equal(fixture.requests.at(-1).kind, 'connection-check');
        assert.equal(fixture.requests.at(-1).provider, provider);
        assert.equal((await disk()).models[0].maxContextSize, value);
        assert.equal(JSON.stringify(ready).includes(fixture.apiKey), false);
        report.checks.push({ provider, value, action: '保存并验证', persisted: value, passed: true });
        if (provider === 'openai_responses' && value === 200000) await screenshot('context-length-responses-200000');

        await dialog.getByLabel('配置名称').fill(`上下文回归-${provider}-${value}`);
        await save.click();
        await waitModel((model) => model?.name === `上下文回归-${provider}-${value}` && model.maxContextSize === value && model.status === 'untested');
        assert.equal((await disk()).models[0].maxContextSize, value);
        assert.equal(fixture.requests.length, before + 1, '只保存配置不能额外调用模型服务');
        report.checks.push({ provider, value, action: '保存配置', persisted: value, passed: true });
      }

      for (const value of [100000.5, 1023, 10000001]) {
        const before = await disk();
        const requests = fixture.requests.length;
        await input.fill(String(value));
        assert.equal(await input.evaluate((element) => element.validity.valid), false);
        assert.equal(await save.isDisabled(), true, `${value} 必须禁用保存配置`);
        assert.equal(await verify.isDisabled(), true, `${value} 必须禁用保存并验证`);
        for (const button of [save, verify]) {
          const box = await button.boundingBox();
          assert.ok(box);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
        await input.press('Enter');
        await delay(100);
        assert.deepEqual(await disk(), before, '无效上下文不能写入模型配置');
        assert.equal(fixture.requests.length, requests, '无效上下文不能发起连接验证');
        report.checks.push({ provider, value, action: '两个保存按钮及回车', rejected: true, passed: true });
      }
    }
    await input.fill('100000');
    await screenshot('context-length-valid');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '设置与模型' }).click();
    assert.equal(await page.getByLabel('上下文长度').inputValue(), '100000');
    assert.equal((await disk()).models[0].maxContextSize, 100000);
    report.checks.push({ action: '重新打开设置保持精确上下文值', persisted: 100000, passed: true });
    assert.deepEqual(report.pageErrors, []);
    report.connectionRequests = fixture.requests;
    report.passed = true;
  } catch (error) {
    failure = error; report.error = error.message;
    if (page && !page.isClosed()) await screenshot('failure').catch(() => {});
  } finally {
    for (const resource of [app, fixture]) {
      if (!resource) continue;
      try { await resource.close(); } catch (error) { failure ??= error; report.passed = false; report.teardownError = error.message; }
    }
    if (installedApp) {
      try {
        for (const [file, value] of Object.entries(buildHashes)) assert.equal(await hash(path.join(installedApp, file)), value, `安装包在验收期间变化：${file}`);
        report.packagedFilesUnchanged = true;
      } catch (error) { failure ??= error; report.passed = false; report.versionError = error.message; }
    }
    report.finishedAt = new Date().toISOString();
    await fs.writeFile(path.join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failure) throw failure;
});
