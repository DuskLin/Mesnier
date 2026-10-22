import fs from 'node:fs';
import path from 'node:path';
import type { Snapshot } from '@mesnier/shared';

export const UPSTREAM_COMMIT = '44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1';
export const RUNTIME_VERSION = 'mesnier-runtime/0.1.0';
const active = new Set(['queued', 'running', 'waiting_approval', 'cancelling']);
export class Store {
  data: Snapshot;
  readonly file: string;
  constructor(readonly root: string, version = '0.1.0') {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.file = path.join(root, 'state.json');
    if (fs.existsSync(this.file)) {
      // 损坏或未知版本不静默重建，避免覆盖可恢复的历史。
      const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (state.schemaVersion !== 1 || !Array.isArray(state.runs) || !Array.isArray(state.sessions)) throw new Error('应用数据版本不兼容或文件损坏，请保留原文件后恢复备份。');
      this.data = state;
    } else {
      this.data = {
        schemaVersion: 1, revision: 0, projects: [], sessions: [], tasks: [], runs: [], messages: [], events: [], approvals: [], artifacts: [], models: [],
        agents: [
          { id: 'general', name: '通用助手', instructions: '你是 Mesnier 的通用工作助手。使用中文与用户协作，准确完成目标。需要生成或修改文件时使用工具，并在结束时说明实际结果及验证情况。' },
          { id: 'coding', name: '代码助手', instructions: '你是 Mesnier 的编程助手。先理解项目约定，聚焦用户要求修改代码，运行相关验证并准确报告结果。不要提交或推送，除非用户明确要求。' },
          { id: 'work', name: '工作助手', instructions: '你是 Mesnier 的工作助手。帮助用户整理资料、分析和撰写内容；将要求的文件保存在当前工作目录，并在结束时说明文件位置、来源和未验证项。' }
        ],
        runtime: { ready: false, version: RUNTIME_VERSION, upstreamCommit: UPSTREAM_COMMIT },
        app: { version, dataRoot: root, platform: process.platform }
      };
    }
    this.data.app = { version, dataRoot: root, platform: process.platform };
    this.data.runtime = { ready: false, version: RUNTIME_VERSION, upstreamCommit: UPSTREAM_COMMIT };
    for (const run of this.data.runs) {
      if (active.has(run.status)) {
        run.status = 'interrupted'; run.endedAt = new Date().toISOString();
        run.error = '上次应用退出时执行尚未确认结束。已保留历史与文件；请检查产物后明确重试或发送新指令。';
        const task = this.data.tasks.find(item => item.id === run.taskId);
        if (task && task.status !== 'done') task.status = 'todo';
      }
    }
    this.data.approvals = [];
    this.save();
  }
  save() {
    const temporary = `${this.file}.next`;
    const payload = JSON.stringify(this.data, null, 2);
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    fs.renameSync(temporary, this.file);
  }
  snapshot() { return structuredClone(this.data); }
}

export interface Cipher { encrypt(value: string): string; decrypt(value: string): string }
/** 同时处理服务错误中常见的 JSON/URL 转义，避免转义后的密钥绕过替换。 */
export function redactCredential(value: string, secret: string) {
  if (!secret) return value;
  const forms = new Set([secret, encodeURIComponent(secret)]);
  let escaped = secret;
  for (let depth = 0; depth < 3; depth++) { escaped = JSON.stringify(escaped).slice(1, -1); forms.add(escaped); }
  let result = value;
  for (const form of [...forms].sort((left, right) => right.length - left.length)) result = result.split(form).join('[已隐藏凭据]');
  return result;
}
export class Secrets {
  private values: Record<string, string>;
  private file: string;
  constructor(root: string, private cipher: Cipher) {
    this.file = path.join(root, 'credentials.json');
    this.values = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
  }
  get(id: string): string { return this.values[id] ? this.cipher.decrypt(this.values[id]) : ''; }
  has(id: string) { return Boolean(this.values[id]); }
  set(id: string, key: string) {
    const next = { ...this.values };
    if (key) next[id] = this.cipher.encrypt(key); else delete next[id];
    fs.writeFileSync(`${this.file}.next`, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(`${this.file}.next`, this.file); this.values = next;
  }
  removeModel(id: string) {
    const next = Object.fromEntries(Object.entries(this.values).filter(([reference]) => reference !== id && !reference.startsWith(`${id}:`)));
    fs.writeFileSync(`${this.file}.next`, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(`${this.file}.next`, this.file); this.values = next;
  }
  redact(text: string) {
    let result = text;
    for (const id of Object.keys(this.values)) {
      try { result = redactCredential(result, this.get(id)); } catch { /* 不覆盖原始解密错误 */ }
    }
    return result.replace(/(Bearer\s+)[^\s"']+/gi, '$1[已隐藏凭据]');
  }
}
