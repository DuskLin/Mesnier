import type { Run, RunStatus, TaskStatus } from '@mesnier/shared';

export const runLabels: Record<RunStatus, string> = {
  queued: '排队中', running: '执行中', waiting_approval: '等待授权', cancelling: '正在停止',
  succeeded: '执行成功', failed: '执行失败', cancelled: '已取消', interrupted: '已中断 · 待核对',
};
export const taskLabels: Record<TaskStatus, string> = { todo: '待办', in_progress: '进行中', review: '待验收', done: '已完成' };
export const activeStatuses = new Set<RunStatus>(['queued', 'running', 'waiting_approval', 'cancelling']);
export function isActive(run: Run) { return activeStatuses.has(run.status); }
export function latestRun(runs: Run[], sessionId: string) {
  return runs.filter((run) => run.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).at(0);
}
export function eventText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
