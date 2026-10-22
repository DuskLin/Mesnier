import { build } from 'electron-builder';
import { mkdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { verifyPackagedRuntime } from './verify-packaged-runtime.mjs';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('本发行脚本当前只验证 macOS arm64。');
await access('build/runtime/bin/node');
await access('build/runtime/worker.mjs');
const icons = path.resolve('build/icon.iconset'); await mkdir(icons, { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const output = path.join(icons, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`);
    const result = spawnSync('sips', ['-z', String(size * scale), String(size * scale), 'assets/brand/mesnier-logo.png', '--out', output], { encoding: 'utf8' });
    if (result.status) throw new Error(result.stderr);
  }
}
const converted = spawnSync('iconutil', ['-c', 'icns', icons, '-o', 'build/icon.icns'], { encoding: 'utf8' });
if (converted.status) throw new Error(converted.stderr);
// 使用工程内已校验的 Electron，打包时不额外依赖远端二进制下载。
// 当前是本机分发的临时签名，不自动选用用户钥匙串中的开发者证书。
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
await build({ config: {
  electronDist: path.resolve('node_modules/electron/dist'), electronVersion: '41.0.3',
  // electron-builder 默认忽略映射根下的 node_modules；签名前按完整来源核对，防止仓库祖先依赖掩盖缺包。
  afterPack: async context => verifyPackagedRuntime(path.resolve('build/runtime'), path.join(context.appOutDir, 'Mesnier.app/Contents/Resources/runtime')),
}, publish: 'never' });
