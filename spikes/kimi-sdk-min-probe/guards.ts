import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface MetadataSnapshot {
  exists: boolean;
  signature: string;
  entries: number;
}

/** 只读取目录项和 lstat；不读取文件内容，也不跟随符号链接进入其他目录。 */
export async function snapshotTreeMetadata(root: string): Promise<MetadataSnapshot> {
  const digest = createHash('sha256');
  let entries = 0;
  async function visit(path: string, relativePath: string): Promise<void> {
    const info = await lstat(path, { bigint: true });
    // atime 会受到只读检查影响，不能用作写入证据。
    digest.update(JSON.stringify([
      relativePath, info.mode.toString(), info.dev.toString(), info.ino.toString(),
      info.size.toString(), info.mtimeNs.toString(), info.ctimeNs.toString(),
    ]));
    entries += 1;
    if (info.isDirectory() && !info.isSymbolicLink()) {
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name), relativePath.length === 0 ? name : `${relativePath}/${name}`);
      }
    }
  }
  try {
    await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, signature: 'absent', entries: 0 };
    }
    throw error;
  }
  // 遍历时出现消失、权限错误等竞争必须失败，不能误记为整个目录原本不存在。
  await visit(root, '');
  return { exists: true, signature: digest.digest('hex'), entries };
}

export function metadataUnchanged(before: MetadataSnapshot, after: MetadataSnapshot): boolean {
  return before.exists === after.exists && before.signature === after.signature && before.entries === after.entries;
}

export interface SideEffectObservation {
  before: MetadataSnapshot;
  after: MetadataSnapshot;
  changeEvents: number;
  unchanged: boolean;
}

/** 必须在 resume 调用之前创建；观察所有工作文件，捕获同内容重写及临时文件副作用。 */
export async function beginSideEffectObservation(directory: string): Promise<{
  finish(): Promise<SideEffectObservation>;
  close(): void;
}> {
  let watcher: FSWatcher | undefined;
  let changeEvents = 0;
  let watchError: Error | undefined;
  watcher = watch(directory, { recursive: true }, () => { changeEvents += 1; });
  watcher.on('error', (error) => { watchError = error; });
  let before: MetadataSnapshot;
  try {
    before = await snapshotTreeMetadata(directory);
  } catch (error) {
    watcher.close();
    throw error;
  }
  let finished = false;
  return {
    async finish() {
      if (finished) throw new Error('副作用观察已结束，不能重复读取结果');
      finished = true;
      try {
        const after = await snapshotTreeMetadata(directory);
        // 让本轮 fs.watch 事件有机会入队；最终判定仍包含纳秒级文件元数据。
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (watchError !== undefined) throw watchError;
        return { before, after, changeEvents, unchanged: changeEvents === 0 && metadataUnchanged(before, after) };
      } finally {
        watcher?.close();
      }
    },
    close() { watcher?.close(); },
  };
}
