import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
export interface FileStamp { size: number; hash: string }
export type FileInventory = Map<string, FileStamp>;
const ignored = new Set(['.git', 'node_modules', '.venv', '__pycache__', '.DS_Store']);
export async function inventory(root: string): Promise<FileInventory> {
  const result: FileInventory = new Map();
  const visit = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await visit(file); continue; }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(file);
      const hash = stat.size <= 8 * 1024 * 1024 ? createHash('sha256').update(await fs.readFile(file)).digest('hex') : `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
      result.set(path.relative(root, file), { size: stat.size, hash });
      if (result.size > 20000) throw new Error('工作目录超过 20,000 个文件，请选择更具体的子目录以跟踪产物。');
    }
  };
  await visit(root); return result;
}
export async function withinWorkspace(root: string, file: string) {
  const realRoot = await fs.realpath(root); const realFile = await fs.realpath(file);
  const relative = path.relative(realRoot, realFile);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('产物不在当前项目目录内，不能通过工作台读取。');
  return realFile;
}
