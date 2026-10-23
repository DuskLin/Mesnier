import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { RuntimeClient } from '../../apps/desktop/src/main/runtime-client';
import type { RunEvent } from '@mesnier/shared';

const wait = async (predicate: () => boolean) => { const end = Date.now() + 10000; while (!predicate()) { if (Date.now() > end) throw new Error('进程检查超时'); await new Promise(resolve => setTimeout(resolve, 20)); } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mesnier-process-groups-'));
  const entry = path.join(root, 'worker.mjs');
  await fs.writeFile(entry, `
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
const send=(x)=>process.stdout.write(JSON.stringify(x)+'\\n');
const event=(runId,kind,payload)=>send({event:{id:randomUUID(),runId,kind,payload,at:new Date().toISOString()}});
createInterface({input:process.stdin}).on('line',line=>{
 const {id,method,params={}}=JSON.parse(line);
 if(method==='run'){
   const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
   child.unref(); event(params.runId,'process.started',{pid:child.pid,pgid:child.pid});
   send({id,result:{pid:child.pid}});
   if(params.complete) setTimeout(()=>event(params.runId,'run.completed',{}),100);
 } else if(method==='crash') process.exit(17);
 else {send({id,result:{pid:process.pid}});if(method==='shutdown')setImmediate(()=>process.exit(0));}
});`);
  const client = new RuntimeClient(process.execPath, entry, root, () => {});
  const events: RunEvent[] = []; client.on('event', event => events.push(event));
  return { root, client, events, dispose: async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); } };
}

test('终态确认前停止工具独立进程组，包括忽略TERM的进程', async () => {
  const f = await fixture();
  try {
    const result = await f.client.request('run', { runId: 'complete', complete: true });
    await wait(() => f.events.some(event => event.kind === 'run.completed'));
    assert.equal(alive(result.pid), false);
  } finally { await f.dispose(); }
});

test('worker异常退出后仍清理已记录的独立工具组，确认后可以重启', async () => {
  const f = await fixture();
  try {
    const first = await f.client.request('info');
    const tool = await f.client.request('run', { runId: 'crash' });
    assert.equal(alive(tool.pid), true);
    await assert.rejects(f.client.request('crash'));
    await f.client.close();
    await wait(() => !alive(tool.pid));
    const next = await f.client.request('info'); assert.notEqual(next.pid, first.pid);
  } finally { await f.dispose(); }
});
