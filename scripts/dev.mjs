import { spawn } from 'node:child_process';
// 开发同样加载构建后的静态界面，避免运行时依赖开发服务器。
const build = spawn(process.execPath, ['scripts/build-app.mjs'], { stdio: 'inherit' });
build.on('exit', code => {
  if (code) { process.exitCode = code; return; }
  const app = spawn('node_modules/.bin/electron', ['.'], { stdio: 'inherit', env: process.env });
  app.on('exit', result => { process.exitCode = result ?? 1; });
});
