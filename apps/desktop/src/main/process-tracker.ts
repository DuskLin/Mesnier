import { execFileSync } from 'node:child_process';

interface Identity { pid: number; pgid: number; state: string; born: string }
export interface ProcessMember { pid: number; pgid: number; born: string }
interface OwnedProcess { pid: number; pgid?: number; runId?: string; identities: Map<number, string> }
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 只管理本 worker 报告的工具进程；记录出生时间，拒绝对复用的 PID 发信号。 */
export class ProcessTracker {
  private owned = new Map<number, OwnedProcess>();
  private list(): Identity[] {
    if (process.platform === 'win32') throw new Error('当前进程组确认只在 macOS/Linux 实现。');
    return execFileSync('/bin/ps', ['-axo', 'pid=,pgid=,stat=,lstart='], { encoding: 'utf8', timeout: 3000, env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } })
      .split('\n').flatMap(line => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
        return match && !match[3].startsWith('Z') ? [{ pid: Number(match[1]), pgid: Number(match[2]), state: match[3], born: match[4] }] : [];
      });
  }
  register(pid: number, pgid?: number, runId?: string) {
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid || (pgid !== undefined && pgid !== pid)) throw new Error('运行时报告了无效的工具进程身份。');
    const entries = this.list().filter(item => pgid ? item.pgid === pgid : item.pid === pid);
    this.owned.set(pid, { pid, pgid, runId, identities: new Map(entries.map(item => [item.pid, item.born])) });
  }
  private live(record: OwnedProcess) {
    const members = this.list().filter(item => record.pgid ? item.pgid === record.pgid : item.pid === record.pid);
    if (!members.length) { this.owned.delete(record.pid); return []; }
    if (!members.some(item => record.identities.get(item.pid) === item.born)) throw new Error('工具进程身份已经变化，未终止无法确认归属的进程。');
    for (const member of members) record.identities.set(member.pid, member.born);
    return members;
  }
  exited(pid: number, pgid?: number, runId?: string, members?: ProcessMember[]) {
    const record = this.owned.get(pid); if (!record) return;
    if (record.pgid !== pgid || record.runId !== runId) throw new Error('工具退出事件与已记录的进程组不一致。');
    // 原生工具退出回调提供同组后代快照；只延续已记录组的归属，不接收任意 PID。
    for (const member of members ?? []) {
      if (record.pgid !== undefined && member.pgid === record.pgid && Number.isInteger(member.pid) && member.pid > 1 && member.pid !== process.pid && typeof member.born === 'string') {
        record.identities.set(member.pid, member.born);
      }
    }
    this.live(record);
  }
  async cleanup(runId?: string) {
    const records = [...this.owned.values()].filter(item => runId === undefined || item.runId === runId);
    const signal = async (record: OwnedProcess, value: NodeJS.Signals) => {
      if (!this.live(record).length) return;
      try { process.kill(record.pgid ? -record.pgid : record.pid, value); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
        // macOS 在刚退出、等待父进程回收的窗口可能返回 EPERM。
        if ((error as NodeJS.ErrnoException).code === 'EPERM') { await delay(30); if (!this.live(record).length) return; }
        throw error;
      }
    };
    await Promise.all(records.map(record => signal(record, 'SIGTERM')));
    let deadline = Date.now() + 1000;
    while (records.some(record => this.live(record).length) && Date.now() < deadline) await delay(40);
    await Promise.all(records.map(record => signal(record, 'SIGKILL')));
    deadline = Date.now() + 3000;
    while (records.some(record => this.live(record).length)) {
      if (Date.now() > deadline) throw new Error('工具进程组仍未确认退出，已暂停后续执行。');
      await delay(40);
    }
  }
}
