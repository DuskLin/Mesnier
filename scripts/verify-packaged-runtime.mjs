import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** 签名会改变 Mach-O 文件；完整复制检查必须在 afterPack、代码签名之前执行。 */
export async function verifyPackagedRuntime(source, destination) {
  const modules = await stat(path.join(destination, 'node_modules')).catch(() => undefined);
  assert.ok(modules?.isDirectory(), '安装包缺少内置运行时的 node_modules 目录');
  let count = 0;
  const visit = async relative => {
    for (const entry of await readdir(path.join(source, relative), { withFileTypes: true })) {
      const child = path.join(relative, entry.name);
      const target = path.join(destination, child);
      assert.equal(entry.isSymbolicLink(), false, `分发不能依赖外部符号链接：${child}`);
      if (entry.isDirectory()) { assert.equal((await stat(target)).isDirectory(), true, `缺少分发目录：${child}`); await visit(child); }
      else if (entry.isFile()) {
        const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex');
        assert.equal(await digest(target), await digest(path.join(source, child)), `运行时分发文件缺失或不一致：${child}`);
        count++;
      }
    }
  };
  await visit('');
  process.stdout.write(`已核对安装包运行时 ${count} 个文件与签名前来源完全一致。\n`);
  return count;
}
