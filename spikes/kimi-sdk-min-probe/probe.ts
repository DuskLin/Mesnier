/**
 * MIT License
 *
 * Copyright (c) 2026 Moonshot AI
 *
 * 本文件接入 MoonshotAI/kimi-code 的 node-sdk 源码（exports 指向源码，不是 dist）。
 * 版权声明按上游根 LICENSE 原样保留。本次不复制、不修改、不构建上游仓库。
 *
 * Mesnier 最小接入探针。只验证隔离边界和退出码，不把未发生的模型或工具步骤记为通过。
 * 1.1 / 1.2 在改掉复核指出的问题之前不能记为通过；本程序也不勾选这两项。
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type {
  ApprovalRequest,
  Event,
  KimiHarness,
  Session,
} from '@moonshot-ai/kimi-code-sdk';
import { beginSideEffectObservation, metadataUnchanged, snapshotTreeMetadata, type MetadataSnapshot } from './guards.ts';

const UPSTREAM_SHA = '44cdf8f4039e2ff20d3fe8a4e7868bd90fd786e1';
const UPSTREAM_REPO = resolve('/Users/liujialin/project/kimi-code');
const TURN_TIMEOUT_MS = 120_000;
const EXPECTED_WRITE_CONTENT = 'mesnier-kimi-sdk-min-probe\n';

const SPIKE_ROOT = resolve(import.meta.dirname);
const SANDBOX = resolve(SPIKE_ROOT, 'sandbox');
const EVIDENCE_PATH = resolve(SPIKE_ROOT, 'evidence', 'latest.json');
const PERSONAL_DIRS = [resolve(homedir(), '.kimi'), resolve(homedir(), '.kimi-code')];

type ScenarioStatus = '通过' | '未通过' | '未运行' | '未覆盖' | '待核对';

interface ScenarioRecord {
  状态: ScenarioStatus;
  说明: string;
}

interface EventSummary {
  type: string;
  turnId?: number;
  reason?: string;
  name?: string;
  isError?: boolean;
  toolCallId?: string;
  path?: string;
}

interface ApprovalRecord {
  toolName: string;
  path: string | null;
  decision: 'approved' | 'rejected';
}

interface Evidence {
  说明: string;
  复核通过: false;
  任务1_1与1_2: '未通过';
  退出码: number;
  未覆盖项: string[];
  node版本: string;
  构建命令: string;
  上游SHA: string;
  上游HEAD: string | null;
  上游工作区字节数: number | null;
  个人目录对照: Record<string, string>;
  homeDir: string | null;
  configPath: string | null;
  workDir: string | null;
  KIMI_CODE_HOME: string | null;
  凭据: {
    MESNIER_PROBE_API_KEY: '已设置' | '缺失';
    MESNIER_PROBE_BASE_URL: '已设置' | '缺失';
    MESNIER_PROBE_MODEL: '已设置' | '缺失';
  };
  场景: {
    会话建立: ScenarioRecord;
    模型调用: ScenarioRecord;
    文件工具: ScenarioRecord;
    权限拒绝: ScenarioRecord;
    取消: ScenarioRecord;
    恢复: ScenarioRecord;
  };
  事件摘要: EventSummary[];
  增量事件数: number;
  模型名: string | null;
  目标文件: string | null;
  恢复前哈希: string | null;
  恢复后哈希: string | null;
  恢复副作用: { 文件事件数: number; 元数据一致: boolean; 历史一致: boolean } | null;
  副作用: string;
}

type PersonalSnapshot = MetadataSnapshot;

interface TurnWatch {
  ended: Promise<Event>;
  sawTurnEnded(): boolean;
  sawAnyEvent(): boolean;
  newTurnEnded(): boolean;
  dispose(): void;
}

const events: EventSummary[] = [];
const seenTurnIds = new Set<number>();
const uncovered: string[] = [];
let deltaCount = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function blankEvidence(): Evidence {
  const missing = (name: string): '已设置' | '缺失' =>
    envValue(name) === undefined ? '缺失' : '已设置';
  return {
    说明:
      '本次只接入隔离后的 SDK 入口。没有运行 pnpm install 或 pnpm build，node-sdk 的 exports 指向源码，dist 不可用。1.1 与 1.2 未通过。',
    复核通过: false,
    任务1_1与1_2: '未通过',
    退出码: 1,
    未覆盖项: [],
    node版本: process.version,
    构建命令: '未运行。本次禁止在参考仓库执行 pnpm install 与 pnpm build，dist 接入不可用。',
    上游SHA: UPSTREAM_SHA,
    上游HEAD: null,
    上游工作区字节数: null,
    个人目录对照: {},
    homeDir: null,
    configPath: null,
    workDir: null,
    KIMI_CODE_HOME: process.env.KIMI_CODE_HOME ?? null,
    凭据: {
      MESNIER_PROBE_API_KEY: missing('MESNIER_PROBE_API_KEY'),
      MESNIER_PROBE_BASE_URL: missing('MESNIER_PROBE_BASE_URL'),
      MESNIER_PROBE_MODEL: missing('MESNIER_PROBE_MODEL'),
    },
    场景: {
      会话建立: { 状态: '未运行', 说明: '尚未创建会话。' },
      模型调用: { 状态: '未运行', 说明: '尚未订阅 turn.ended。' },
      文件工具: { 状态: '未运行', 说明: '尚未由模型调用 Write。' },
      权限拒绝: { 状态: '未运行', 说明: '尚未注册 approval handler。' },
      取消: { 状态: '未运行', 说明: '尚未调用 Session.cancel。' },
      恢复: { 状态: '未运行', 说明: '尚未 close 后 resumeSession。' },
    },
    事件摘要: [],
    增量事件数: 0,
    模型名: null,
    目标文件: null,
    恢复前哈希: null,
    恢复后哈希: null,
    恢复副作用: null,
    副作用: '未发生文件副作用。取消没有撤销已写文件的接口；取消前已经写出的文件必须继续保留。',
  };
}

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function missingCredentials(): string[] {
  return ['MESNIER_PROBE_API_KEY', 'MESNIER_PROBE_BASE_URL', 'MESNIER_PROBE_MODEL'].filter(
    (name) => envValue(name) === undefined,
  );
}

function note(scenario: ScenarioRecord, status: ScenarioStatus, detail: string): void {
  scenario.状态 = status;
  scenario.说明 = detail;
  if (status === '未运行' || status === '未覆盖' || status === '待核对') {
    uncovered.push(`${status}：${detail}`);
  }
}

function remember(event: Event): void {
  if ('turnId' in event && typeof event.turnId === 'number') seenTurnIds.add(event.turnId);
  if (event.type === 'assistant.delta' || event.type === 'thinking.delta' || event.type === 'tool.call.delta') {
    deltaCount += 1;
    return;
  }
  const summary: EventSummary = { type: event.type };
  if ('turnId' in event && typeof event.turnId === 'number') summary.turnId = event.turnId;
  if (event.type === 'turn.ended') summary.reason = event.reason;
  if (event.type === 'tool.call.started') {
    summary.name = event.name;
    summary.toolCallId = event.toolCallId;
    const path = event.display === undefined ? null : approvalPath(event.display);
    if (path !== null) summary.path = path;
  }
  if (event.type === 'tool.result') {
    summary.toolCallId = event.toolCallId;
    summary.isError = event.isError === true;
  }
  events.push(summary);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function assertSandboxPath(label: string, value: string): void {
  const resolved = resolve(value);
  if (!isInside(resolved, SANDBOX)) {
    throw new Error(`${label} 不在 sandbox 内：${resolved}`);
  }
  if (resolved === resolve(homedir()) || PERSONAL_DIRS.some((dir) => isInside(resolved, dir) || isInside(dir, resolved))) {
    throw new Error(`${label} 指向个人目录：${resolved}`);
  }
}

async function snapshotPersonal(dir: string): Promise<PersonalSnapshot> {
  return snapshotTreeMetadata(dir);
}

async function snapshotPersonals(): Promise<Map<string, PersonalSnapshot>> {
  const result = new Map<string, PersonalSnapshot>();
  for (const dir of PERSONAL_DIRS) {
    result.set(dir, await snapshotPersonal(dir));
  }
  return result;
}

function personalUnchanged(
  before: Map<string, PersonalSnapshot>,
  after: Map<string, PersonalSnapshot>,
): Record<string, string> {
  const report: Record<string, string> = {};
  for (const dir of PERSONAL_DIRS) {
    const left = before.get(dir);
    const right = after.get(dir);
    const same = left !== undefined && right !== undefined && metadataUnchanged(left, right);
    report[dir] = same ? '递归目录项元数据未观察到变化；未读取内容，不证明从未访问或写入' : '已观察到变化';
    if (!same) {
      throw new Error(`个人目录项元数据发生变化：${dir}`);
    }
  }
  return report;
}

function upstreamStatus(): { head: string; bytes: number } {
  const head = execFileSync('git', ['-C', UPSTREAM_REPO, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const status = execFileSync('git', ['-C', UPSTREAM_REPO, 'status', '--porcelain=v1', '-uall'], {
    encoding: 'utf8',
  });
  return { head, bytes: Buffer.byteLength(status, 'utf8') };
}

function assertUpstreamClean(stage: string): { head: string; bytes: number } {
  const status = upstreamStatus();
  if (status.head !== UPSTREAM_SHA) {
    throw new Error(`${stage}：参考仓库 HEAD 不是 ${UPSTREAM_SHA}，实际是 ${status.head}`);
  }
  if (status.bytes !== 0) {
    throw new Error(`${stage}：参考仓库 git status 字节数为 ${status.bytes}，必须为 0`);
  }
  return status;
}

async function prepareRunDirs(): Promise<{ homeDir: string; configPath: string; workDir: string }> {
  await mkdir(SANDBOX, { recursive: true });
  const stamp = `${nowIso().replace(/[:.]/g, '-')}-${process.pid}`;
  const homeDir = resolve(SANDBOX, `home-${stamp}`);
  const workDir = resolve(SANDBOX, `work-${stamp}`);
  await mkdir(homeDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  const configPath = join(homeDir, 'config.toml');
  assertSandboxPath('homeDir', homeDir);
  assertSandboxPath('workDir', workDir);
  assertSandboxPath('configPath', configPath);
  if (process.env.KIMI_CODE_HOME !== SANDBOX && process.env.KIMI_CODE_HOME !== homeDir) {
    throw new Error('KIMI_CODE_HOME 必须与本次任务目录一致，当前不是 sandbox 或其子目录');
  }
  process.env.KIMI_CODE_HOME = homeDir;
  process.env.KIMI_DISABLE_TELEMETRY = '1';
  return { homeDir, configPath, workDir };
}

function watchTurn(
  session: Session,
  timeoutMs: number,
  options?: { readonly ignoreKnownTurns?: boolean },
): TurnWatch {
  let settled = false;
  let sawEnded = false;
  let sawNewEnded = false;
  let sawAny = false;
  const knownTurnIds = new Set(seenTurnIds);
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveEnded: (event: Event) => void = () => {};
  let rejectEnded: (error: Error) => void = () => {};
  const ended = new Promise<Event>((resolve, reject) => {
    resolveEnded = resolve;
    rejectEnded = reject;
  });
  const finish = (callback: () => void): void => {
    if (settled) return;
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    unsubscribe?.();
    callback();
  };
  timer = setTimeout(() => {
    finish(() => rejectEnded(new Error(`等待 turn.ended 超时（${timeoutMs}ms），不能把 prompt() 返回当成回合结束`)));
  }, timeoutMs);
  unsubscribe = session.onEvent((event) => {
    const turnId = 'turnId' in event && typeof event.turnId === 'number' ? event.turnId : undefined;
    if (options?.ignoreKnownTurns === true && turnId !== undefined && knownTurnIds.has(turnId)) {
      return;
    }
    sawAny = true;
    remember(event);
    if (event.type === 'error') {
      finish(() => rejectEnded(new Error(`会话错误 ${event.code}`)));
      return;
    }
    if (event.type === 'turn.ended') {
      const isNew = turnId === undefined || !knownTurnIds.has(turnId);
      sawEnded = true;
      if (isNew) sawNewEnded = true;
      finish(() => resolveEnded(event));
    }
  });
  return {
    ended,
    sawTurnEnded: () => sawEnded,
    sawAnyEvent: () => sawAny,
    newTurnEnded: () => sawNewEnded,
    dispose(): void {
      finish(() => {});
    },
  };
}

async function fileSha256(path: string): Promise<string | null> {
  try {
    const body = await readFile(path);
    return createHash('sha256').update(body).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function approvalPath(display: ApprovalRequest['display']): string | null {
  if (display.kind === 'file_io' || display.kind === 'diff') {
    return resolve(display.path);
  }
  return null;
}

function redact(text: string, secrets: readonly string[]): string {
  let output = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    output = output.split(secret).join('[已省略凭据]');
  }
  return output;
}

async function writeEvidence(evidence: Evidence): Promise<void> {
  evidence.事件摘要 = events;
  evidence.增量事件数 = deltaCount;
  evidence.未覆盖项 = [...new Set(uncovered)];
  evidence.KIMI_CODE_HOME = process.env.KIMI_CODE_HOME ?? null;
  const secrets = ['MESNIER_PROBE_API_KEY', 'MESNIER_PROBE_BASE_URL', 'MESNIER_PROBE_MODEL']
    .map((name) => envValue(name))
    .filter((value): value is string => value !== undefined);
  const serialized = redact(JSON.stringify(evidence, null, 2), secrets);
  await mkdir(resolve(SPIKE_ROOT, 'evidence'), { recursive: true });
  await writeFile(EVIDENCE_PATH, `${serialized}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function actualModelName(session: Session, harness: KimiHarness): Promise<string | null> {
  const status = await session.getStatus();
  if (status.model === undefined) return null;
  const config = await harness.getConfig();
  const aliases: Record<string, { readonly model?: string }> = config.models ?? {};
  const alias = aliases[status.model];
  return alias?.model ?? status.model;
}

async function runCredentialed(evidence: Evidence, dirs: { homeDir: string; configPath: string; workDir: string }): Promise<number> {
  const apiKey = envValue('MESNIER_PROBE_API_KEY');
  const baseUrl = envValue('MESNIER_PROBE_BASE_URL');
  const modelName = envValue('MESNIER_PROBE_MODEL');
  if (apiKey === undefined || baseUrl === undefined || modelName === undefined) {
    throw new Error('凭据检查后仍缺失，拒绝调用模型');
  }

  const targetFile = resolve(dirs.workDir, 'probe-write.txt');
  const rejectFile = resolve(dirs.workDir, 'probe-rejected.txt');
  evidence.目标文件 = targetFile;
  let harness: KimiHarness | undefined;
  let exitCode = 1;

  try {
    const sdk = await import('@moonshot-ai/kimi-code-sdk');
    harness = sdk.createKimiHarness({
      homeDir: dirs.homeDir,
      configPath: dirs.configPath,
      identity: {
        productName: 'mesnier-probe',
        version: '0.0.0-spike',
        platform: 'mesnier_probe',
      },
    });
    evidence.homeDir = harness.homeDir;
    evidence.configPath = harness.configPath;
    evidence.workDir = dirs.workDir;
    assertSandboxPath('返回的 homeDir', harness.homeDir);
    assertSandboxPath('返回的 configPath', harness.configPath);
    if (resolve(harness.homeDir) !== dirs.homeDir) {
      throw new Error(`返回的 homeDir 与任务目录不一致：${harness.homeDir}`);
    }
    if (resolve(process.env.KIMI_CODE_HOME ?? '') !== dirs.homeDir) {
      throw new Error('KIMI_CODE_HOME 与 homeDir 不一致');
    }

    await harness.setConfig({
      defaultModel: 'probe',
      providers: {
        probe: { type: 'openai', apiKey, baseUrl },
      },
      models: {
        probe: {
          provider: 'probe',
          model: modelName,
          maxContextSize: 262144,
          capabilities: ['thinking'],
        },
      },
    });

    const session = await harness.createSession({
      workDir: dirs.workDir,
      model: 'probe',
      permission: 'manual',
      additionalDirs: [],
    });
    const listed = (await harness.listSessions({ workDir: dirs.workDir })).find((item) => item.id === session.id);
    const sessionDir = listed?.sessionDir;
    if (sessionDir === undefined || !isInside(resolve(sessionDir), join(dirs.homeDir, 'sessions'))) {
      note(evidence.场景.会话建立, '未通过', `sessionDir 不在 homeDir/sessions：${sessionDir ?? '缺失'}`);
      return 1;
    }
    note(evidence.场景.会话建立, '通过', `sessionDir 位于 ${sessionDir}`);

    await session.setPermission('manual');
    const approvals: ApprovalRecord[] = [];
    let approvedWrite = false;
    session.setApprovalHandler((request) => {
      const requested = approvalPath(request.display);
      const decision: ApprovalRecord['decision'] =
        !approvedWrite && request.toolName === 'Write' && requested === targetFile ? 'approved' : 'rejected';
      if (decision === 'approved') approvedWrite = true;
      approvals.push({ toolName: request.toolName, path: requested, decision });
      return { decision };
    });

    const writeWatch = watchTurn(session, TURN_TIMEOUT_MS);
    try {
      await session.prompt(
        [
          '使用 Write 工具一次。',
          `path 必须是这个绝对路径：${targetFile}`,
          'mode 使用 overwrite。',
          `content 必须正好是：${JSON.stringify(EXPECTED_WRITE_CONTENT)}`,
          '写完后不要再调用其他工具，只用一句话结束。',
        ].join('\n'),
      );
      const ended = await writeWatch.ended;
      if (!writeWatch.sawAnyEvent() || ended.type !== 'turn.ended') {
        note(evidence.场景.模型调用, '未覆盖', '没有收到该次 turn 的事件。prompt() 返回不算结束。');
        note(evidence.场景.文件工具, '未覆盖', '模型回合没有事件，不能把文件工具记为通过。');
        return 1;
      }
      if (ended.reason === 'failed' || ended.reason === 'blocked') {
        note(evidence.场景.模型调用, '未覆盖', `turn.ended reason=${ended.reason}，认证错误或失败不算 1.2 通过。`);
        note(evidence.场景.文件工具, '未覆盖', '模型回合失败，文件工具未覆盖。');
        return 1;
      }
      if (ended.reason !== 'completed') {
        note(evidence.场景.模型调用, '未覆盖', `没有收到 reason 为 completed 的 turn.ended，实际为 ${ended.reason}`);
        note(evidence.场景.文件工具, '未覆盖', '模型回合未 completed，不能把文件工具记为通过。');
        return 1;
      }
      evidence.模型名 = await actualModelName(session, harness);
      note(evidence.场景.模型调用, '通过', `turn.ended reason=completed，实际模型名 ${evidence.模型名 ?? '未知'}`);
      const hash = await fileSha256(targetFile);
      const expectedHash = createHash('sha256').update(EXPECTED_WRITE_CONTENT).digest('hex');
      const started = events.find(
        (item) =>
          item.type === 'tool.call.started' &&
          item.turnId === ended.turnId &&
          item.name === 'Write' &&
          item.path !== undefined &&
          resolve(item.path) === targetFile,
      );
      const wrote =
        started !== undefined &&
        events.some(
          (item) => item.type === 'tool.result' && item.toolCallId === started.toolCallId && item.isError === false,
        );
      if (!wrote || hash === null || hash !== expectedHash) {
        note(evidence.场景.文件工具, '未覆盖', '模型没有成功调用预期路径上的 Write，或目标文件不存在、哈希与期望内容不一致。禁止用宿主写文件冒充。');
        return 1;
      }
      note(evidence.场景.文件工具, '通过', `Write 的 tool.result isError=false，哈希 ${hash}`);
      evidence.恢复前哈希 = hash;
    } catch (error) {
      note(evidence.场景.模型调用, '未覆盖', `模型调用失败或没有事件：${error instanceof Error ? error.message : '未知错误'}`);
      note(evidence.场景.文件工具, '未覆盖', '模型调用未完成，文件工具未覆盖。');
      return 1;
    } finally {
      writeWatch.dispose();
    }

    const rejectBefore = await fileSha256(rejectFile);
    const rejectWatch = watchTurn(session, TURN_TIMEOUT_MS);
    try {
      await session.prompt(
        [
          '使用 Write 工具一次，且只能调用这一次。',
          `path 必须是这个绝对路径：${rejectFile}`,
          'content 必须正好是 rejected-should-not-land。',
          '这次请求会被拒绝。被拒绝后不要改用其他路径或工具，直接结束。',
        ].join('\n'),
      );
      const ended = await rejectWatch.ended;
      const rejectAfter = await fileSha256(rejectFile);
      const rejected = approvals.some((item) => item.path === rejectFile && item.decision === 'rejected');
      if (ended.type === 'turn.ended' && rejectAfter === rejectBefore && rejected) {
        note(evidence.场景.权限拒绝, '通过', '本次 approval handler 对预期绝对路径返回 rejected，目标文件没有落地。没有 handler 会被记成 cancelled，本次没有把 cancelled 当成拒绝。');
      } else if (!rejected) {
        note(evidence.场景.权限拒绝, '未覆盖', '模型没有请求预期路径上的 Write，权限拒绝未覆盖。此前已放行的 Write 不算这次拒绝。');
        return 1;
      } else {
        note(evidence.场景.权限拒绝, '未通过', '拒绝后的目标文件哈希发生变化，或回合没有结束。');
        return 1;
      }
    } catch (error) {
      const rejectAfter = await fileSha256(rejectFile);
      const rejected = approvals.some((item) => item.path === rejectFile && item.decision === 'rejected');
      if (rejected && rejectAfter === rejectBefore) {
        note(evidence.场景.权限拒绝, '通过', '预期路径已被 handler 拒绝且文件没有落地；回合本身没有正常结束，但拒绝结果不依赖 prompt() 返回。');
      } else {
        note(evidence.场景.权限拒绝, '未覆盖', `权限拒绝场景没有跑完：${error instanceof Error ? error.message : '未知错误'}`);
        return 1;
      }
    } finally {
      rejectWatch.dispose();
    }

    const cancelBefore = await fileSha256(targetFile);
    const cancelWatch = watchTurn(session, TURN_TIMEOUT_MS);
    try {
      await session.prompt('请连续写三段关于取消语义的说明，每段至少八十个字，不要调用工具。');
      await session.cancel();
      const ended = await cancelWatch.ended;
      const cancelAfter = await fileSha256(targetFile);
      if (ended.type !== 'turn.ended' || ended.reason !== 'cancelled') {
        note(evidence.场景.取消, '待核对', '取消超时或没有收到 turn.ended reason=cancelled，不能记为已取消。');
        return 1;
      }
      if (cancelBefore !== null && cancelAfter === cancelBefore) {
        evidence.副作用 = '取消前已写出的文件仍在，副作用保留，文件内容没有被程序清除。';
      }
      note(evidence.场景.取消, '通过', '收到 turn.ended reason=cancelled。已有文件副作用保留。');
    } catch (error) {
      note(evidence.场景.取消, '待核对', `没有收到取消事件：${error instanceof Error ? error.message : '未知错误'}`);
      return 1;
    } finally {
      cancelWatch.dispose();
    }

    const sessionId = session.id;
    evidence.恢复前哈希 = await fileSha256(targetFile);
    await session.close();
    await harness.close();
    harness = undefined;

    const sideEffects = await beginSideEffectObservation(dirs.workDir);
    const wirePath = join(sessionDir, 'agents', 'main', 'wire.jsonl');
    try {
      const historyBefore = await fileSha256(wirePath);
      const resumed = sdk.createKimiHarness({
        homeDir: dirs.homeDir,
        configPath: dirs.configPath,
        identity: {
          productName: 'mesnier-probe',
          version: '0.0.0-spike',
          platform: 'mesnier_probe',
        },
      });
      harness = resumed;
      const again = await resumed.resumeSession({ id: sessionId });
      if (again.id !== sessionId || resolve(again.workDir) !== dirs.workDir) {
        note(evidence.场景.恢复, '未通过', '恢复返回的会话身份或工作目录与原会话不一致。');
        return 1;
      }
      const resumeWatch = watchTurn(again, 2_000, { ignoreKnownTurns: true });
      try {
        await resumeWatch.ended.catch(() => undefined);
        evidence.恢复后哈希 = await fileSha256(targetFile);
        const historyAfter = await fileSha256(wirePath);
        const observation = await sideEffects.finish();
        const historyUnchanged = historyBefore !== null && historyBefore === historyAfter;
        evidence.恢复副作用 = {
          文件事件数: observation.changeEvents,
          元数据一致: metadataUnchanged(observation.before, observation.after),
          历史一致: historyUnchanged,
        };
        if (resumeWatch.newTurnEnded() || resumeWatch.sawAnyEvent() || !observation.unchanged || !historyUnchanged) {
          note(evidence.场景.恢复, '未通过', '从 resumeSession 前开始的观察发现新回合事件、文件副作用或原生 wire 历史变化。相同内容重写也属于重复副作用。');
          return 1;
        }
        if (evidence.恢复前哈希 !== evidence.恢复后哈希) {
          note(evidence.场景.恢复, '未通过', '恢复前后目标文件哈希不同。');
          return 1;
        }
        note(evidence.场景.恢复, '通过', '会话与工作目录相同；恢复调用前至返回后 2 秒内未观察到工作文件事件、递归元数据变化、新回合事件或 wire 历史变化。此结论只覆盖该观察窗口。');
        await again.close();
      } finally {
        resumeWatch.dispose();
      }
    } finally {
      sideEffects.close();
    }
    exitCode = 0;
    return exitCode;
  } finally {
    if (harness !== undefined) {
      await harness.close();
    }
  }
}

interface ProbeDependencies {
  snapshotPersonals: typeof snapshotPersonals;
  personalUnchanged: typeof personalUnchanged;
  assertUpstreamClean: typeof assertUpstreamClean;
  prepareRunDirs: typeof prepareRunDirs;
  runCredentialed: typeof runCredentialed;
  writeEvidence: typeof writeEvidence;
}

/** 注入边界用于子进程负向验证；正常入口不传覆盖项。返回值只在所有收尾检查后产生。 */
export async function main(overrides: Partial<ProbeDependencies> = {}): Promise<number> {
  const deps: ProbeDependencies = {
    snapshotPersonals, personalUnchanged, assertUpstreamClean,
    prepareRunDirs, runCredentialed, writeEvidence, ...overrides,
  };
  events.length = 0;
  seenTurnIds.clear();
  uncovered.length = 0;
  deltaCount = 0;
  const evidence = blankEvidence();
  let beforePersonal: Map<string, PersonalSnapshot> | undefined;
  let exitCode = 1;
  try {
    beforePersonal = await deps.snapshotPersonals();
    const beforeUpstream = deps.assertUpstreamClean('开始前');
    evidence.上游HEAD = beforeUpstream.head;
    evidence.上游工作区字节数 = beforeUpstream.bytes;

    const missing = missingCredentials();
    if (missing.length > 0) {
      exitCode = 2;
      evidence.homeDir = SANDBOX;
      evidence.configPath = null;
      evidence.workDir = null;
      for (const key of ['文件工具', '权限拒绝', '取消', '恢复'] as const) {
        note(evidence.场景[key], '未运行', `${key}缺少 ${missing.join('、')}，不调用模型。`);
      }
      note(evidence.场景.会话建立, '未运行', '凭据不全，不创建 harness，也不创建会话。');
      note(evidence.场景.模型调用, '未运行', '凭据不全，不发起模型请求。prompt() 返回不算回合结束，本次没有订阅 turn.ended。');
      evidence.说明 = `凭据缺失（${missing.join('、')}）。未调用模型，文件写入、权限拒绝、取消和恢复均为未运行。1.1 与 1.2 不能记为通过。`;
    } else {
      const dirs = await deps.prepareRunDirs();
      evidence.homeDir = dirs.homeDir;
      evidence.configPath = dirs.configPath;
      evidence.workDir = dirs.workDir;
      exitCode = await deps.runCredentialed(evidence, dirs);
    }
  } catch (error) {
    exitCode = 1;
    const message = error instanceof Error ? error.message : '未知错误';
    evidence.说明 = `探针失败：${message}`;
    uncovered.push(`失败：${message}`);
  } finally {
    try {
      const afterUpstream = deps.assertUpstreamClean('结束时');
      evidence.上游HEAD = afterUpstream.head;
      evidence.上游工作区字节数 = afterUpstream.bytes;
    } catch (error) {
      exitCode = 1;
      evidence.说明 = error instanceof Error ? error.message : evidence.说明;
    }
    try {
      if (beforePersonal === undefined) throw new Error('开始前目录快照失败，无法作隔离对照');
      evidence.个人目录对照 = deps.personalUnchanged(beforePersonal, await deps.snapshotPersonals());
    } catch (error) {
      exitCode = 1;
      evidence.个人目录对照 = { 错误: error instanceof Error ? error.message : '个人目录对照失败' };
    }
    evidence.退出码 = exitCode;
    const failed = Object.values(evidence.场景).some((item) => item.状态 !== '通过');
    if (failed && exitCode === 0) exitCode = 1;
    evidence.退出码 = exitCode;
    try {
      await deps.writeEvidence(evidence);
    } catch {
      exitCode = 1;
      // 证据可能无法落盘；不要继续以成功结束，也不要输出底层错误里的敏感路径或内容。
      process.stderr.write('验收证据写入失败；本次探针未通过。\n');
    }
  }
  return exitCode;
}
