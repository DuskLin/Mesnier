import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell, Menu, clipboard } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { Workbench } from './workbench';
import { Store, Secrets } from './store';
import { RuntimeClient } from './runtime-client';

const dataRoot = path.resolve(process.env.MESNIER_HOME ?? path.join(os.homedir(), '.mesnier'));
fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
app.setName('Mesnier');
app.setPath('userData', path.join(dataRoot, 'desktop'));
app.setPath('sessionData', path.join(dataRoot, 'cache', 'chromium'));
app.setAppLogsPath(path.join(dataRoot, 'logs'));
const gotLock = app.requestSingleInstanceLock();
let window: BrowserWindow | undefined;
let workbench: Workbench | undefined;
let quitting = false;
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    const store = new Store(dataRoot, app.getVersion());
    const secrets = new Secrets(dataRoot, {
      encrypt(value) { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，未保存密钥。请检查 macOS 钥匙串权限。'); return safeStorage.encryptString(value).toString('base64'); },
      decrypt(value) { if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法读取密钥。'); return safeStorage.decryptString(Buffer.from(value, 'base64')); }
    });
    const runtimeRoot = app.isPackaged ? path.join(process.resourcesPath, 'runtime') : path.join(app.getAppPath(), 'build', 'runtime');
    const runtime = new RuntimeClient(path.join(runtimeRoot, 'bin', 'node'), path.join(runtimeRoot, 'worker.mjs'), dataRoot, message => {
      try {
        fs.mkdirSync(path.join(dataRoot, 'logs'), { recursive: true });
        fs.appendFileSync(path.join(dataRoot, 'logs', 'runtime.log'), secrets.redact(message), { mode: 0o600 });
      } catch (error) { workbench?.stopForStorageFailure(error); }
    });
    workbench = new Workbench(store, secrets, runtime, snapshot => { if (window && !window.isDestroyed()) window.webContents.send('mesnier:snapshot', snapshot); });
    const indexPath = path.join(__dirname, '../renderer/index.html');
    const indexUrl = pathToFileURL(indexPath).href;
    const methods = ['createProject', 'removeProject', 'createSession', 'renameSession', 'sendMessage', 'cancelRun', 'respondApproval', 'createTask', 'updateTask', 'enqueueTask', 'acceptTask', 'saveModelConfig', 'testModel', 'setDefaultModel', 'deleteModel', 'readArtifact'] as const;
    const handlers: Record<string, (...args: any[]) => unknown> = {
      getSnapshot: () => workbench!.snapshot(),
      selectDirectory: async () => { const result = await dialog.showOpenDialog(window!, { title: '选择工作目录', properties: ['openDirectory', 'createDirectory'] }); return result.canceled ? null : result.filePaths[0] ?? null; },
      openArtifact: async (id: string) => { const file = await workbench!.artifactPath(id); shell.showItemInFolder(file); },
      revealProject: async (id: string) => {
        const directory = workbench!.projectPath(id);
        if (!fs.statSync(directory).isDirectory()) throw new Error('项目路径当前不是文件夹。');
        const error = await shell.openPath(directory); if (error) throw new Error(error);
      },
      openExternal: async (value: string) => {
        const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('仅允许打开 HTTP(S) 链接。');
        await shell.openExternal(url.toString());
      },
      copyText: (value: string) => { if (typeof value !== 'string' || value.length > 1024 * 1024) throw new Error('复制内容格式或长度无效。'); clipboard.writeText(value); }
    };
    for (const method of methods) handlers[method] = (input: any) => {
      if (method !== 'readArtifact' && method !== 'cancelRun') workbench!.ensureWritable();
      return (workbench![method] as (input: any) => unknown).call(workbench, input);
    };
    for (const [name, handler] of Object.entries(handlers)) {
      ipcMain.handle(`mesnier:${name}`, async (event, ...args) => {
        if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== indexUrl) throw new Error('拒绝来自非应用界面的请求。');
        try { return await handler(...args); }
        catch (error) { throw new Error(secrets.redact(error instanceof Error ? error.message : String(error))); }
      });
    }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Mesnier', submenu: [{ role: 'about', label: '关于 Mesnier' }, { type: 'separator' }, { role: 'hide', label: '隐藏 Mesnier' }, { role: 'hideOthers', label: '隐藏其他' }, { type: 'separator' }, { role: 'quit', label: '退出 Mesnier' }] },
      { label: '编辑', submenu: [{ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
      { label: '视图', submenu: [{ role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
      { label: '窗口', submenu: [{ role: 'minimize', label: '最小化' }, { role: 'zoom', label: '缩放' }] }
    ]));
    const createWindow = () => {
      window = new BrowserWindow({ width: 1440, height: 930, minWidth: 1000, minHeight: 700, title: 'Mesnier', backgroundColor: '#f7f8f6', titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
        webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true } });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event, url) => { if (url !== indexUrl) event.preventDefault(); });
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.on('closed', () => { window = undefined; });
      void window.loadFile(indexPath);
    };
    createWindow(); await workbench.initialize();
    app.on('activate', () => { if (!window) createWindow(); else window.show(); });
  }).catch(error => {
    dialog.showErrorBox('Mesnier 无法启动', `${error instanceof Error ? error.message : String(error)}\n数据保存在 ${dataRoot}，原文件不会被自动删除。`); app.exit(1);
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (quitting || !workbench) return;
    event.preventDefault(); quitting = true;
    workbench.close().catch(error => {
      dialog.showErrorBox('退出前核对未完成', `未能确认所有运行资源已经停止，请核对任务目录和执行状态。\n${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => app.quit());
  });
}
