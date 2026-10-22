import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { ArtifactContent, ModelConfig, ModelInput, Project, Run, RunEvent, SendInput, Session, Snapshot, Task, TaskInput } from '@mesnier/shared';
import { Store, Secrets, RUNTIME_VERSION, UPSTREAM_COMMIT } from './store';
import { RuntimeRequestError, type RuntimePort } from './runtime-client';
import { inventory, withinWorkspace, type FileInventory } from './artifacts';

const now = () => new Date().toISOString();
const active = (run: Run) => ['queued', 'running', 'waiting_approval', 'cancelling'].includes(run.status);
const text = (value: unknown, field: string, maximum = 100000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) throw new Error(`${field}不能为空且不能超过 ${maximum} 个字符。`);
  return value.trim();
};
const optionalText = (value: unknown, field: string, maximum = 100000) => value === undefined || value === '' ? '' : text(value, field, maximum);
function approvalDetail(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const display = value as Record<string, unknown>;
  const strings = (...values: unknown[]) => values.filter(item => typeof item === 'string' && item).join('\n\n');
  if (display.kind === 'command') return strings(display.cwd && `工作目录：${display.cwd}`, display.description, display.command);
  if (display.kind === 'file_io') return strings(`文件：${display.path}`, display.detail, display.content, typeof display.before === 'string' && `修改前：\n${display.before}`, typeof display.after === 'string' && `修改后：\n${display.after}`);
  if (display.kind === 'diff') return strings(`文件：${display.path}`, `修改前：\n${display.before}`, `修改后：\n${display.after}`);
  if (display.kind === 'url_fetch') return strings(`${display.method ?? 'GET'} ${display.url}`);
  if (display.kind === 'agent_call') return strings(`Agent：${display.agent_name}`, display.prompt);
  if (display.kind === 'generic') return strings(display.summary, typeof display.detail === 'string' ? display.detail : JSON.stringify(display.detail, null, 2));
  return JSON.stringify(display, null, 2);
}

export class Workbench {
  private busy?: string;
  private accepted = new Set<string>();
  private secretsForRun = new Map<string, string>();
  private beforeFiles = new Map<string, FileInventory>();
  private seenEvents = new Set<string>();
  private resolving = new Set<string>();
  private finalizing = new Map<string, Promise<void>>();
  private starting = new Set<string>();
  private cancellationTimers = new Map<string, NodeJS.Timeout>();
  private flushTimer?: NodeJS.Timeout;
  private closing = false;
  private recovering = false;
  constructor(readonly store: Store, readonly secrets: Secrets, readonly runtime: RuntimePort, private changed: (snapshot: Snapshot) => void) {
    runtime.on('event', event => { void this.event(event).catch(error => this.emergency(error)); });
    runtime.on('exit', reason => {
      this.state.runtime.ready = false; this.state.runtime.error = reason;
      if (this.busy) void this.finish(this.busy, 'interrupted', reason).catch(error => this.emergency(error));
      else this.publish();
    });
  }
  get state() { return this.store.data; }
  snapshot() { return this.store.snapshot(); }
  private clean(value: string) {
    let clean = this.secrets.redact(value);
    for (const secret of this.secretsForRun.values()) if (secret) clean = clean.split(secret).join('[已隐藏凭据]');
    return clean;
  }
  private emergency(error: unknown) {
    this.state.runtime.error = this.clean(error instanceof Error ? error.message : String(error));
    this.changed(this.snapshot());
  }
  private publish(immediate = true) {
    this.state.revision++;
    if (immediate) {
      if (this.flushTimer) clearTimeout(this.flushTimer); this.flushTimer = undefined;
      this.store.save(); this.changed(this.snapshot());
    } else if (!this.flushTimer) this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      try { this.store.save(); this.changed(this.snapshot()); } catch (error) { this.emergency(error); }
    }, 80);
  }
  async initialize() {
    try {
      const info = await this.runtime.request('info');
      this.state.runtime = { ready: true, version: info.version ?? RUNTIME_VERSION, upstreamCommit: info.upstreamCommit ?? UPSTREAM_COMMIT };
    } catch (error) { this.state.runtime.error = this.clean(String(error)); this.state.runtime.ready = false; }
    this.publish();
  }
  private getSession(id: string) { const value = this.state.sessions.find(item => item.id === id); if (!value) throw new Error('会话不存在。'); return value; }
  private getProject(id: string) { const value = this.state.projects.find(item => item.id === id); if (!value) throw new Error('项目不存在。'); return value; }
  private getRun(id: string) { const value = this.state.runs.find(item => item.id === id); if (!value) throw new Error('执行不存在。'); return value; }
  private getTask(id: string) { const value = this.state.tasks.find(item => item.id === id); if (!value) throw new Error('任务不存在。'); return value; }
  private getModel(id?: string) { const value = this.state.models.find(item => item.id === (id ?? this.state.defaultModelId)); if (!value) throw new Error('请先在设置中添加模型。'); return value; }
  private async checkDirectory(directory: string) {
    if (!path.isAbsolute(directory)) throw new Error('工作目录必须是绝对路径。');
    const real = await fs.realpath(directory);
    if (!(await fs.stat(real)).isDirectory()) throw new Error('工作路径不是目录。');
    await fs.access(real, constants.R_OK | constants.W_OK | constants.X_OK); return real;
  }
  async createProject(input: { name?: string; path: string }): Promise<Project> {
    const directory = await this.checkDirectory(text(input.path, '工作目录', 4096));
    const exists = this.state.projects.find(item => item.path === directory); if (exists) return structuredClone(exists);
    const project = { id: randomUUID(), path: directory, name: input.name ? text(input.name, '项目名称', 160) : path.basename(directory), createdAt: now() };
    this.state.projects.push(project); this.publish(); return structuredClone(project);
  }
  removeProject(id: string) {
    this.getProject(id);
    if (this.state.sessions.some(item => item.projectId === id)) throw new Error('此项目已有会话历史，为保留执行记录不能直接移除。');
    this.state.projects = this.state.projects.filter(item => item.id !== id); this.publish();
  }
  createSession(input: { projectId: string; title?: string }): Session {
    this.getProject(input.projectId);
    const session = { id: randomUUID(), projectId: input.projectId, title: input.title ? text(input.title, '会话标题', 200) : '新的对话', createdAt: now(), updatedAt: now() };
    this.state.sessions.push(session); this.publish(); return structuredClone(session);
  }
  renameSession(input: { sessionId: string; title: string }) { this.getSession(input.sessionId).title = text(input.title, '会话标题', 200); this.publish(); }
  async sendMessage(input: SendInput): Promise<Run> {
    if (this.closing) throw new Error('应用正在退出。');
    const requestId = text(input.requestId, '请求标识', 200);
    const existing = this.state.runs.find(item => item.requestId === requestId);
    if (existing) {
      if (existing.sessionId !== input.sessionId || existing.prompt !== input.text.trim()) throw new Error('重复请求标识与原执行内容不一致。');
      return structuredClone(existing);
    }
    const session = this.getSession(input.sessionId); const project = this.getProject(session.projectId);
    if (this.state.runs.some(item => item.sessionId === session.id && active(item))) throw new Error('当前会话正在执行。输入会保留，请等待结束或取消后再发送。');
    if (!this.state.runtime.ready) { await this.initialize(); if (!this.state.runtime.ready) throw new Error(this.state.runtime.error ?? '内置运行时尚未就绪。'); }
    const workspace = await this.checkDirectory(project.path);
    // 异步目录检查之后再检查，防止同一时刻的多次 IPC 重入。
    const duplicate = this.state.runs.find(item => item.requestId === requestId);
    if (duplicate) {
      if (duplicate.sessionId !== input.sessionId || duplicate.prompt !== input.text.trim()) throw new Error('重复请求标识与原执行内容不一致。');
      return structuredClone(duplicate);
    }
    if (this.state.runs.some(item => item.sessionId === session.id && active(item))) throw new Error('当前会话已有执行，请等待结束。');
    const model = this.getModel(input.modelId);
    if (model.status === 'error') throw new Error('模型连接检查未通过，请更新配置或重新测试。');
    const task = this.state.tasks.find(item => item.sessionId === session.id);
    const agent = this.state.agents.find(item => item.id === (input.agentId ?? task?.agentId ?? 'general')); if (!agent) throw new Error('Agent 配置不存在。');
    if (input.retryOf && this.getRun(input.retryOf).sessionId !== session.id) throw new Error('只能重试当前会话中的执行。');
    const prompt = text(input.text, '消息');
    const run: Run = {
      id: randomUUID(), requestId, sessionId: session.id, projectId: project.id, taskId: task?.id,
      prompt, status: 'queued', agent: structuredClone(agent), model: structuredClone(model), workspace,
      runtimeVersion: this.state.runtime.version, upstreamCommit: this.state.runtime.upstreamCommit, createdAt: now(), retryOf: input.retryOf
    };
    const credential = this.secrets.get(model.id); this.secretsForRun.set(run.id, credential);
    this.state.runs.push(run);
    this.state.messages.push({ id: randomUUID(), runId: run.id, sessionId: session.id, role: 'user', text: prompt, createdAt: now() });
    session.updatedAt = now(); if (session.title === '新的对话') session.title = prompt.slice(0, 48);
    if (task) { task.status = 'in_progress'; task.updatedAt = now(); delete task.acceptedAt; delete task.acceptanceNote; }
    this.publish(); void this.pump(); return structuredClone(run);
  }
  private async pump() {
    if (this.busy || this.closing || this.recovering || this.starting.size) return;
    const run = this.state.runs.find(item => item.status === 'queued'); if (!run) return;
    this.busy = run.id; run.status = 'running'; run.startedAt = now(); this.publish();
    try {
      if (!this.state.runtime.ready) { await this.initialize(); if (!this.state.runtime.ready) throw new Error(this.state.runtime.error ?? '运行时未就绪'); }
      await this.checkDirectory(run.workspace);
      this.beforeFiles.set(run.id, await inventory(run.workspace));
      if (this.getRun(run.id).status === 'cancelling') { await this.finish(run.id, 'cancelled'); return; }
      const session = this.getSession(run.sessionId);
      // 配置和凭据在入队时捕获，不受后续默认模型修改影响。
      this.starting.add(run.id);
      await this.runtime.request('run', {
        runId: run.id, profileRoot: path.join(this.store.root, 'runtime'), workspace: run.workspace,
        sessionId: session.runtimeSessionId,
        prompt: `${run.agent.instructions}\n\n用户目标：\n${run.prompt}`,
        modelConfig: { ...run.model, apiKey: this.secretsForRun.get(run.id) ?? '' }, approvalMode: 'manual'
      });
      if (active(run)) this.accepted.add(run.id);
      if (this.getRun(run.id).status === 'cancelling') await this.runtime.request('cancel', { runId: run.id });
    } catch (error) {
      if (error instanceof RuntimeRequestError && error.uncertain) await this.stopUncertain(run.id, this.clean(error.message));
      else await this.finish(run.id, 'failed', this.clean(String(error)));
    } finally {
      this.starting.delete(run.id);
      if (!this.closing && !this.recovering) void this.pump();
    }
  }
  private async stopUncertain(id: string, reason: string) {
    this.recovering = true;
    await this.runtime.close();
    await this.finish(id, 'interrupted', reason);
    this.recovering = false;
    if (!this.closing) void this.pump();
  }
  async cancelRun(id: string) {
    const run = this.getRun(id); if (!active(run)) throw new Error('执行已经结束。');
    if (run.status === 'cancelling') return;
    if (run.status === 'queued') { await this.finish(id, 'cancelled'); return; }
    run.status = 'cancelling'; this.publish();
    const timer = setTimeout(() => {
      void (async () => {
        // 超时只停止本应用 worker；未确认工具结果保持待核对，不宣称撤销副作用。
        await this.stopUncertain(id, '取消超时，运行时已停止；请核对已发生的文件和外部副作用。');
      })().catch(error => this.emergency(error));
    }, 15000);
    this.cancellationTimers.set(id, timer);
    if (this.accepted.has(id)) {
      try { await this.runtime.request('cancel', { runId: id }); }
      catch (error) { if (active(run)) { run.error = this.clean(String(error)); this.publish(); } }
    }
  }
  async respondApproval(input: { runId: string; requestId: string; decision: 'approved' | 'rejected' }) {
    if (!['approved', 'rejected'].includes(input.decision)) throw new Error('无效的权限决定。');
    const approval = this.state.approvals.find(item => item.requestId === input.requestId && item.runId === input.runId);
    if (!approval || this.resolving.has(input.requestId) || this.getRun(input.runId).status === 'cancelling') throw new Error('权限请求已经处理或失效。');
    this.resolving.add(input.requestId);
    try { await this.runtime.request('approve', input); }
    finally { this.resolving.delete(input.requestId); }
  }
  createTask(input: TaskInput): Task {
    const session = this.getSession(input.sessionId);
    const existing = this.state.tasks.find(item => item.sessionId === session.id); if (existing) return structuredClone(existing);
    const agentId = input.agentId ?? 'general'; if (!this.state.agents.some(item => item.id === agentId)) throw new Error('Agent 配置不存在。');
    const runs = this.state.runs.filter(item => item.sessionId === session.id); const last = runs.at(-1);
    const task: Task = {
      id: randomUUID(), sessionId: session.id, projectId: session.projectId, title: text(input.title, '任务标题', 200),
      description: optionalText(input.description, '任务描述'), acceptanceCriteria: optionalText(input.acceptanceCriteria, '验收标准'), agentId,
      status: last && active(last) ? 'in_progress' : last?.status === 'succeeded' ? 'review' : 'todo', createdAt: now(), updatedAt: now()
    };
    this.state.tasks.push(task); for (const run of runs) run.taskId = task.id;
    this.publish(); return structuredClone(task);
  }
  updateTask(input: { taskId: string; title?: string; description?: string; acceptanceCriteria?: string; agentId?: string }): Task {
    const task = this.getTask(input.taskId);
    if (input.title !== undefined) task.title = text(input.title, '任务标题', 200);
    if (input.description !== undefined) task.description = optionalText(input.description, '任务描述');
    if (input.acceptanceCriteria !== undefined) task.acceptanceCriteria = optionalText(input.acceptanceCriteria, '验收标准');
    if (input.agentId !== undefined) { if (!this.state.agents.some(item => item.id === input.agentId)) throw new Error('Agent 配置不存在。'); task.agentId = input.agentId; }
    task.updatedAt = now(); this.publish(); return structuredClone(task);
  }
  enqueueTask(input: { taskId: string; requestId: string; modelId?: string }) {
    const task = this.getTask(input.taskId);
    const last = this.state.runs.filter(item => item.taskId === task.id).at(-1);
    return this.sendMessage({ sessionId: task.sessionId, requestId: input.requestId, modelId: input.modelId, agentId: task.agentId,
      text: [task.title, task.description, task.acceptanceCriteria && `验收标准：\n${task.acceptanceCriteria}`].filter(Boolean).join('\n\n'),
      retryOf: last && ['failed', 'cancelled', 'interrupted'].includes(last.status) ? last.id : undefined });
  }
  acceptTask(input: { taskId: string; note?: string }): Task {
    const task = this.getTask(input.taskId);
    const last = this.state.runs.filter(item => item.taskId === task.id).at(-1);
    if (task.status !== 'review' || last?.status !== 'succeeded') throw new Error('任务尚未进入待验收状态，不能直接完成。');
    task.status = 'done'; task.acceptedAt = now(); task.updatedAt = now(); task.acceptanceNote = optionalText(input.note, '验收说明', 10000);
    this.publish(); return structuredClone(task);
  }
  saveModelConfig(input: ModelInput): ModelConfig {
    if (!['openai', 'openai_responses', 'anthropic'].includes(input.provider)) throw new Error('请选择支持的模型协议。');
    const url = new URL(text(input.baseUrl, '服务地址', 4096));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('服务地址须为不含凭据、查询参数或片段的 HTTP(S) URL。');
    const context = input.maxContextSize ?? 128000;
    if (!Number.isInteger(context) || context < 1024 || context > 10000000) throw new Error('上下文长度需为 1024 至 10000000 之间的整数。');
    const id = input.id ?? randomUUID(); if (input.id) this.getModel(id);
    const model: ModelConfig = { id, name: text(input.name, '配置名称', 100), provider: input.provider, baseUrl: url.toString().replace(/\/$/, ''), model: text(input.model, '模型名称', 200), maxContextSize: context, hasApiKey: false, status: 'untested' };
    if (input.apiKey !== undefined) {
      if (typeof input.apiKey !== 'string' || input.apiKey.length > 16384) throw new Error('凭据格式无效。');
      this.secrets.set(id, input.apiKey.trim());
    }
    model.hasApiKey = this.secrets.has(id);
    const index = this.state.models.findIndex(item => item.id === id); if (index < 0) this.state.models.push(model); else this.state.models[index] = model;
    this.state.defaultModelId ??= id; this.publish(); return structuredClone(model);
  }
  setDefaultModel(id: string) { this.getModel(id); this.state.defaultModelId = id; this.publish(); }
  deleteModel(id: string) {
    this.getModel(id); this.state.models = this.state.models.filter(item => item.id !== id); this.secrets.set(id, '');
    if (this.state.defaultModelId === id) this.state.defaultModelId = this.state.models[0]?.id;
    this.publish();
  }
  async testModel(id: string): Promise<{ ok: boolean; message: string }> {
    const current = this.getModel(id); const model = structuredClone(current); const key = this.secrets.get(id);
    const tool = { name: 'mesnier_connection_check', description: 'Confirm that tool calling works.', parameters: { type: 'object', properties: { ready: { type: 'boolean' } }, required: ['ready'], additionalProperties: false } };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    let endpoint: string; let body: Record<string, unknown>;
    if (model.provider === 'anthropic') {
      endpoint = `${model.baseUrl.replace(/\/v1$/, '')}/v1/messages`;
      if (key) headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
      body = { model: model.model, max_tokens: 256, messages: [{ role: 'user', content: 'Call mesnier_connection_check with ready=true.' }], tools: [{ name: tool.name, description: tool.description, input_schema: tool.parameters }], tool_choice: { type: 'tool', name: tool.name } };
    } else if (model.provider === 'openai_responses') {
      endpoint = `${model.baseUrl}/responses`; if (key) headers.Authorization = `Bearer ${key}`;
      body = { model: model.model, input: 'Call mesnier_connection_check with ready=true.', tools: [{ type: 'function', ...tool }], tool_choice: 'required' };
    } else {
      endpoint = `${model.baseUrl}/chat/completions`; if (key) headers.Authorization = `Bearer ${key}`;
      body = { model: model.model, messages: [{ role: 'user', content: 'Call mesnier_connection_check with ready=true.' }], tools: [{ type: 'function', function: tool }], tool_choice: 'required', max_tokens: 256 };
    }
    let ok = false; let message = '';
    try {
      const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw new Error(`模型服务返回 HTTP ${response.status}：${(await response.text()).slice(0, 800)}`);
      const result: any = await response.json();
      const calls = model.provider === 'anthropic' ? result.content?.filter((item: any) => item.type === 'tool_use') : model.provider === 'openai_responses' ? result.output?.filter((item: any) => item.type === 'function_call') : result.choices?.[0]?.message?.tool_calls;
      if (!calls?.some((item: any) => (item.function?.name ?? item.name) === tool.name)) throw new Error('服务已响应，但没有返回要求的工具调用；请检查模型是否支持工具调用。');
      ok = true; message = '连接与基础工具调用检查通过。实际任务能力以执行结果为准。';
    } catch (error) { message = this.clean(error instanceof Error ? error.message : String(error)); if (key) message = message.split(key).join('[已隐藏凭据]'); }
    // 测试期间若用户修改/删除配置，旧结果不能覆盖新配置。
    if (this.state.models.find(item => item.id === id) === current) {
      current.status = ok ? 'ready' : 'error'; current.lastTestedAt = now(); current.error = ok ? undefined : message; this.publish();
    }
    return { ok, message };
  }
  private async event(event: RunEvent) {
    if (!event || typeof event.id !== 'string' || this.seenEvents.has(event.id)) return;
    const run = this.state.runs.find(item => item.id === event.runId); if (!run || !active(run)) return;
    this.seenEvents.add(event.id);
    const safe = JSON.parse(this.clean(JSON.stringify(event))) as RunEvent;
    const payload = safe.payload;
    this.state.events.push(safe);
    if (safe.kind === 'session.ready' && typeof payload.sessionId === 'string') this.getSession(run.sessionId).runtimeSessionId = payload.sessionId;
    if (safe.kind === 'assistant.delta' && typeof payload.text === 'string' && (!payload.agentId || payload.agentId === 'main')) {
      let message = this.state.messages.find(item => item.runId === run.id && item.role === 'assistant');
      if (!message) { message = { id: randomUUID(), runId: run.id, sessionId: run.sessionId, role: 'assistant', text: '', createdAt: safe.at }; this.state.messages.push(message); }
      message.text += payload.text;
    }
    if (safe.kind === 'approval.requested' && typeof payload.requestId === 'string') {
      if (run.status === 'cancelling') { void this.runtime.request('cancel', { runId: run.id }).catch(error => this.emergency(error)); }
      else {
        const name = payload.toolName ?? payload.tool ?? payload.action ?? '工具操作';
        this.state.approvals.push({ requestId: payload.requestId, runId: run.id, toolName: String(name), description: String(payload.description ?? payload.message ?? payload.action ?? '此操作需要你的批准'), details: approvalDetail(payload.display), createdAt: safe.at });
        run.status = 'waiting_approval';
      }
    }
    if (safe.kind === 'approval.resolved') {
      this.state.approvals = this.state.approvals.filter(item => !(item.runId === run.id && item.requestId === payload.requestId));
      if (run.status === 'waiting_approval' && !this.state.approvals.some(item => item.runId === run.id)) run.status = 'running';
    }
    if (safe.kind === 'usage' && payload.available && payload.usage && typeof payload.usage === 'object') {
      const usage = (payload.usage as Record<string, unknown>).currentTurn as Record<string, unknown> | undefined;
      if (usage) {
        const inputParts = [usage.inputOther, usage.inputCacheRead, usage.inputCacheCreation];
        run.usage = {
          inputTokens: inputParts.every(item => typeof item === 'number') ? (inputParts as number[]).reduce((sum, item) => sum + item, 0) : undefined,
          outputTokens: typeof usage.output === 'number' ? usage.output : undefined
        };
      }
    }
    const terminals = { 'run.completed': 'succeeded', 'run.failed': 'failed', 'run.cancelled': 'cancelled' } as const;
    if (safe.kind in terminals) {
      const error = payload.error as { message?: string } | undefined;
      await this.finish(run.id, terminals[safe.kind as keyof typeof terminals], error?.message); return;
    }
    this.publish(safe.kind !== 'assistant.delta' && safe.kind !== 'thinking.delta');
  }
  private async finish(id: string, status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted', error?: string) {
    const pending = this.finalizing.get(id); if (pending) return pending;
    const operation = this.finishRun(id, status, error); this.finalizing.set(id, operation);
    try { await operation; } finally { this.finalizing.delete(id); }
  }
  private async finishRun(id: string, status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted', error?: string) {
    const run = this.getRun(id); if (!active(run)) return;
    const timer = this.cancellationTimers.get(id); if (timer) clearTimeout(timer); this.cancellationTimers.delete(id);
    try {
      const before = this.beforeFiles.get(id);
      if (before) {
        const after = await inventory(run.workspace);
        for (const relative of new Set([...before.keys(), ...after.keys()])) {
          const previous = before.get(relative); const current = after.get(relative);
          if (previous?.hash === current?.hash) continue;
          this.state.artifacts.push({ id: randomUUID(), runId: id, sessionId: run.sessionId, projectId: run.projectId, path: path.join(run.workspace, relative), relativePath: relative, change: !current ? 'deleted' : !previous ? 'created' : 'modified', size: current?.size ?? 0, createdAt: now() });
        }
      }
    } catch (failure) {
      this.state.events.push({ id: randomUUID(), runId: id, kind: 'warning', payload: { message: this.clean(`产物扫描未完成：${String(failure)}`) }, at: now() });
    }
    run.status = status; run.endedAt = now(); run.error = error ? this.clean(error) : undefined;
    this.state.approvals = this.state.approvals.filter(item => item.runId !== id);
    const task = this.state.tasks.find(item => item.id === run.taskId);
    if (task) { task.status = status === 'succeeded' ? 'review' : 'todo'; task.updatedAt = now(); }
    this.beforeFiles.delete(id); this.secretsForRun.delete(id); this.accepted.delete(id);
    if (this.busy === id) this.busy = undefined;
    this.publish(); if (!this.closing && !this.recovering) void this.pump();
  }
  async readArtifact(id: string): Promise<ArtifactContent> {
    const artifact = this.state.artifacts.find(item => item.id === id); if (!artifact) throw new Error('产物记录不存在。');
    try {
      const file = await withinWorkspace(this.getProject(artifact.projectId).path, artifact.path);
      const stat = await fs.stat(file); if (!stat.isFile()) throw new Error('产物当前不是普通文件。');
      const handle = await fs.open(file, 'r'); const buffer = Buffer.alloc(Math.min(stat.size, 256 * 1024));
      try { await handle.read(buffer, 0, buffer.length, 0); } finally { await handle.close(); }
      if (buffer.includes(0)) return { artifact: structuredClone(artifact), binary: true };
      return { artifact: structuredClone(artifact), text: buffer.toString('utf8'), truncated: stat.size > buffer.length };
    } catch (error) { return { artifact: structuredClone(artifact), error: this.clean(`文件无法访问：${String(error)}`) }; }
  }
  async artifactPath(id: string) {
    const artifact = this.state.artifacts.find(item => item.id === id); if (!artifact) throw new Error('产物记录不存在。');
    return withinWorkspace(this.getProject(artifact.projectId).path, artifact.path);
  }
  projectPath(id: string) { return this.getProject(id).path; }
  async close() {
    this.closing = true; if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const timer of this.cancellationTimers.values()) clearTimeout(timer);
    await this.runtime.close();
    for (const run of this.state.runs.filter(active)) await this.finish(run.id, 'interrupted', '应用已退出；请检查已有文件后明确继续。');
    await Promise.all(this.finalizing.values());
    this.store.save();
  }
}
