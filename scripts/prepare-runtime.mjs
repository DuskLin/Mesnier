import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(resolve(root, 'packages/runtime/package.json'));
const { build } = await import(require.resolve('tsdown'));
const vendor = resolve(root, 'vendor/kimi');
const runtimePackage = JSON.parse(readFileSync(resolve(root, 'packages/runtime/package.json'), 'utf8'));
const externalDependencies = Object.keys(runtimePackage.dependencies)
  .filter((name) => name !== 'ajv' && name !== 'ajv-formats')
  .map((name) => new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$)`));
const manifest = JSON.parse(readFileSync(resolve(vendor, 'upstream.json'), 'utf8'));
const patches = JSON.parse(readFileSync(resolve(vendor, 'patches/manifest.json'), 'utf8'));
for (const [file, upstreamHash] of Object.entries(manifest.files)) {
  const expected = patches[file]?.patchedSha256 ?? upstreamHash;
  const actual = createHash('sha256').update(readFileSync(resolve(vendor, file))).digest('hex');
  if (actual !== expected) throw new Error(`上游来源校验失败，请复核补丁与来源记录：${file}`);
}
if (process.argv.includes('--verify-sources')) {
  process.stdout.write(`已校验 ${Object.keys(manifest.files).length} 个上游文件和 ${Object.keys(patches).length} 个派生补丁文件。\n`);
  process.exit(0);
}
const packages = manifest.packages.map((folder) => {
  const directory = resolve(vendor, 'packages', folder);
  return { directory, ...JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) };
});

// 保留上游包的目录和导出约定，内部包直接解析到已纳入仓库的源码。
const workspacePlugin = {
  name: 'mesnier-vendored-kimi',
  enforce: 'pre',
  resolveId(source) {
    // 桌面打包器可能在根目录安装 ajv 6；内核固定使用 runtime 依赖的 ajv 8。
    if (/^(ajv|ajv-formats)(?:\/|$)/.test(source)) return require.resolve(source);
    const pkg = packages.find((item) => source === item.name || source.startsWith(`${item.name}/`));
    if (!pkg) return;
    const subpath = source.slice(pkg.name.length);
    const key = subpath ? `.${subpath}` : '.';
    let target = pkg.exports[key];
    if (!target) {
      for (const [pattern, value] of Object.entries(pkg.exports)) {
        if (pattern.endsWith('/*') && key.startsWith(pattern.slice(0, -1))) {
          target = Object.fromEntries(Object.entries(value).map(([kind, path]) =>
            [kind, path.replace('*', key.slice(pattern.length - 1))]));
          break;
        }
      }
    }
    if (!target) throw new Error(`未找到已固定的上游导出：${source}`);
    return resolve(pkg.directory, typeof target === 'string' ? target : target.default);
  },
};

await build({
  cwd: root,
  entry: {
    worker: resolve(root, 'packages/runtime/src/worker.ts'),
    engine: resolve(root, 'packages/runtime/src/engine.ts'),
    sdk: resolve(vendor, 'packages/node-sdk/src/index.ts'),
  },
  outDir: resolve(root, 'packages/runtime/dist'),
  format: 'esm',
  platform: 'node',
  target: 'node24',
  tsconfig: resolve(vendor, 'tsconfig.json'),
  dts: false,
  clean: true,
  plugins: [workspacePlugin, {
    name: 'mesnier-raw-text',
    enforce: 'pre',
    load(id) {
      const [path, query = ''] = id.split('?', 2);
      if (!query.split('&').includes('raw')) return;
      return { code: `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`, map: null };
    },
  }],
  // ajv 的部分深层导出没有 .js 后缀，打包后才能在 Node ESM 中直接加载。
  deps: { alwaysBundle: [/^@moonshot-ai\//, /^ajv(?:\/|$)/, /^ajv-formats/], neverBundle: externalDependencies, onlyBundle: false },
  banner: {
    js: "import { fileURLToPath as __cjsFileURLToPath } from 'node:url';\nimport { dirname as __cjsDirname } from 'node:path';\nconst __filename = __cjsFileURLToPath(import.meta.url);\nconst __dirname = __cjsDirname(__filename);",
  },
});

if (!process.argv.includes('--bundle-only')) await import('./prepare-runtime-distribution.mjs');
