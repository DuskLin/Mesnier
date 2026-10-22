import { createHash } from 'node:crypto';
import { cp, chmod, copyFile, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageFile = resolve(root, 'packages/runtime/package.json');
const runtimeRequire = createRequire(packageFile);
const runtimePackage = JSON.parse(await readFile(packageFile, 'utf8'));
const output = resolve(root, 'build/runtime');
const staging = resolve(root, `build/.runtime-staging-${process.pid}`);
const rootModules = join(staging, 'node_modules');
const copied = new Map();
const reserved = new Map();
const versions = [];

await rm(staging, { recursive: true, force: true });
await mkdir(rootModules, { recursive: true });

function findPackage(name, from) {
  const requester = createRequire(join(from, 'package.json'));
  let current;
  try { current = dirname(requester.resolve(`${name}/package.json`)); } catch {
    current = dirname(requester.resolve(name));
  }
  while (dirname(current) !== current) {
    const candidate = join(current, 'package.json');
    if (existsSync(candidate)) {
      const metadata = JSON.parse(readFileSync(candidate, 'utf8'));
      if (metadata.name === name) return current;
    }
    current = dirname(current);
  }
  throw new Error(`无法解析分发依赖：${name}`);
}

async function copyDependency(name, from, parentDestination, optional = false) {
  let source;
  try { source = await realpath(findPackage(name, from)); } catch (error) {
    if (optional) return;
    throw error;
  }
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  let destination = join(rootModules, name);
  const prior = copied.get(destination);
  if ((reserved.has(name) && reserved.get(name) !== source) || (prior && prior !== source)) destination = join(parentDestination, 'node_modules', name);
  if (copied.get(destination) === source) return;
  if (copied.has(destination)) throw new Error(`分发依赖出现无法解析的版本冲突：${name}`);
  copied.set(destination, source);
  await mkdir(dirname(destination), { recursive: true });
  // 保留包自身的源码、资源、原生文件和许可证，依赖按实际解析关系单独复制。
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: (path) => path === source || basename(path) !== 'node_modules',
  });
  if (name === 'node-pty' && process.platform !== 'win32') {
    for (const helper of [join(destination, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), join(destination, 'build/Release/spawn-helper')]) {
      if (existsSync(helper)) await chmod(helper, 0o755);
    }
  }
  versions.push({ name, version: metadata.version, location: destination.slice(staging.length + 1), license: metadata.license ?? null });
  const optionalDeps = metadata.optionalDependencies ?? {};
  const peers = metadata.peerDependencies ?? {};
  const dependencies = { ...metadata.dependencies, ...optionalDeps, ...peers };
  for (const dependency of Object.keys(dependencies).sort()) {
    const isOptional = dependency in optionalDeps || (dependency in peers && metadata.peerDependenciesMeta?.[dependency]?.optional === true);
    await copyDependency(dependency, source, destination, isOptional);
  }
}

try {
  await cp(resolve(root, 'packages/runtime/dist'), staging, { recursive: true });
  // 先保留直接依赖的根槽位，避免旧版传递依赖抢占运行时指定的版本。
  for (const name of Object.keys(runtimePackage.dependencies)) {
    if (name !== 'node') reserved.set(name, await realpath(findPackage(name, dirname(packageFile))));
  }
  for (const name of Object.keys(runtimePackage.dependencies).sort()) {
    if (name === 'node') continue;
    await copyDependency(name, dirname(packageFile), staging);
  }
  // ajv 已进入 bundle，但其许可证仍随分发保留。
  await mkdir(join(staging, 'licenses'), { recursive: true });
  for (const name of ['ajv', 'ajv-formats']) {
    const source = findPackage(name, dirname(packageFile));
    for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
      if (existsSync(join(source, filename))) await copyFile(join(source, filename), join(staging, 'licenses', `${name}-${filename}`));
    }
  }
  let nodeSource = process.env['MESNIER_NODE_BINARY'];
  if (!nodeSource) {
    try { nodeSource = runtimeRequire.resolve(process.platform === 'win32' ? 'node/bin/node.exe' : 'node/bin/node'); }
    catch { nodeSource = process.execPath; }
  }
  const version = execFileSync(nodeSource, ['--version'], { encoding: 'utf8' }).trim();
  if (version !== 'v24.15.0') throw new Error(`分发需要 Node v24.15.0，实际为 ${version}`);
  const nodePlatform = process.platform === 'win32' ? 'win' : process.platform;
  const nodeArch = process.platform === 'win32' && process.arch === 'ia32' ? 'x86' : process.arch;
  const nodePrefix = process.platform === 'darwin' && process.arch === 'arm64' ? 'node-bin' : 'node';
  let packagedNodeLicense;
  try { packagedNodeLicense = join(dirname(runtimeRequire.resolve('node/package.json')), 'node_modules', `${nodePrefix}-${nodePlatform}-${nodeArch}`, 'LICENSE'); } catch {}
  const nodeLicense = process.env['MESNIER_NODE_LICENSE'] ?? [
    join(dirname(dirname(nodeSource)), 'LICENSE'), packagedNodeLicense,
  ].find((candidate) => candidate && existsSync(candidate));
  if (!nodeLicense) throw new Error('未找到 Node 许可证，请通过 MESNIER_NODE_LICENSE 明确指定对应的 LICENSE');
  await mkdir(join(staging, 'bin'), { recursive: true });
  const nodeTarget = join(staging, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  await copyFile(nodeSource, nodeTarget);
  await chmod(nodeTarget, 0o755);
  await copyFile(nodeLicense, join(staging, 'licenses', 'NODE-LICENSE'));
  await copyFile(resolve(root, 'vendor/kimi/LICENSE'), join(staging, 'licenses', 'KIMI-LICENSE'));
  await copyFile(resolve(root, 'vendor/kimi/upstream.json'), join(staging, 'upstream.json'));
  // 个别 npm 发布包缺少完整许可正文，固定来源后随运行时补齐并阻止版本漂移。
  const noticeRoot = resolve(root, 'vendor/third-party');
  const noticeManifest = JSON.parse(await readFile(join(noticeRoot, 'manifest.json'), 'utf8'));
  for (const notice of noticeManifest.licenses) {
    const installed = versions.filter(item => item.name === notice.name);
    if (!installed.length || installed.some(item => item.version !== notice.version)) throw new Error(`补充许可需要重新核对依赖版本：${notice.name}@${notice.version}`);
    const actual = createHash('sha256').update(await readFile(join(noticeRoot, notice.file))).digest('hex');
    if (actual !== notice.sha256) throw new Error(`补充许可原文校验失败：${notice.file}`);
  }
  await cp(noticeRoot, join(staging, 'licenses/third-party'), { recursive: true });
  const provenance = join(staging, 'provenance/kimi');
  await mkdir(join(provenance, 'patches'), { recursive: true });
  for (const file of ['README.md', 'LICENSE', 'upstream.json', 'patches/manifest.json', 'patches/mesnier-isolation.patch']) {
    await copyFile(resolve(root, 'vendor/kimi', file), join(provenance, file));
  }
  await writeFile(join(staging, 'provenance/README.md'), '# 运行时来源记录\n\n`kimi/` 保留 Kimi Code 的固定基线、版权和 Mesnier 派生补丁。上游基线逐文件哈希和补丁后哈希用于源码核对；源文件位于 Mesnier 源码仓库。复制的维护文档内，指向构建脚本和源码包的相对链接仍以源码仓库为上下文。\n');
  await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'mesnier-agent-distribution', version: runtimePackage.version, private: true, type: 'module' }, null, 2));
  await writeFile(join(staging, 'distribution.json'), JSON.stringify({
    version: runtimePackage.version,
    nodeVersion: version.slice(1),
    platform: process.platform,
    arch: process.arch,
    nodeSha256: createHash('sha256').update(await readFile(nodeTarget)).digest('hex'),
    provenance: { upstream: 'provenance/kimi/upstream.json', patches: 'provenance/kimi/patches/manifest.json', supplementalLicenses: 'licenses/third-party/manifest.json' },
    dependencies: versions,
  }, null, 2));
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
  process.stdout.write(`已生成独立运行时：${output}（Node ${version}，${versions.length} 个依赖实例）\n`);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}
