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
  if (prior && prior !== source) destination = join(parentDestination, 'node_modules', name);
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
  const nodeSource = process.env['MESNIER_NODE_BINARY'] ?? runtimeRequire.resolve(process.platform === 'win32' ? 'node/bin/node.exe' : 'node/bin/node');
  const version = execFileSync(nodeSource, ['--version'], { encoding: 'utf8' }).trim();
  if (version !== 'v24.15.0') throw new Error(`分发需要 Node v24.15.0，实际为 ${version}`);
  const nodePlatform = process.platform === 'win32' ? 'win' : process.platform;
  const nodeArch = process.platform === 'win32' && process.arch === 'ia32' ? 'x86' : process.arch;
  const nodePrefix = process.platform === 'darwin' && process.arch === 'arm64' ? 'node-bin' : 'node';
  const nodeLicense = process.env['MESNIER_NODE_LICENSE'] ?? join(
    dirname(runtimeRequire.resolve('node/package.json')),
    'node_modules',
    `${nodePrefix}-${nodePlatform}-${nodeArch}`,
    'LICENSE',
  );
  await mkdir(join(staging, 'bin'), { recursive: true });
  const nodeTarget = join(staging, 'bin', process.platform === 'win32' ? 'node.exe' : 'node');
  await copyFile(nodeSource, nodeTarget);
  await chmod(nodeTarget, 0o755);
  await copyFile(nodeLicense, join(staging, 'licenses', 'NODE-LICENSE'));
  await copyFile(resolve(root, 'vendor/kimi/LICENSE'), join(staging, 'licenses', 'KIMI-LICENSE'));
  await copyFile(resolve(root, 'vendor/kimi/upstream.json'), join(staging, 'upstream.json'));
  await writeFile(join(staging, 'package.json'), JSON.stringify({ name: 'mesnier-agent-distribution', version: runtimePackage.version, private: true, type: 'module' }, null, 2));
  await writeFile(join(staging, 'distribution.json'), JSON.stringify({
    version: runtimePackage.version,
    nodeVersion: version.slice(1),
    platform: process.platform,
    arch: process.arch,
    nodeSha256: createHash('sha256').update(await readFile(nodeTarget)).digest('hex'),
    dependencies: versions,
  }, null, 2));
  await rm(output, { recursive: true, force: true });
  await rename(staging, output);
  process.stdout.write(`已生成独立运行时：${output}（Node ${version}，${versions.length} 个依赖实例）\n`);
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}
