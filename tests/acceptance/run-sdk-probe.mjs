import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startModelServer } from './fixtures/model-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const directory = await mkdtemp(join(tmpdir(), 'mesnier-sdk-acceptance-'));
const sdkPath = process.env.MESNIER_PROBE_SDK_PATH ?? join(root, 'packages/runtime/dist/sdk.mjs');
async function sdkSnapshot() {
  const files = [];
  async function visit(folder, prefix = '') {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(folder, entry.name), `${relative}/`);
      else if (entry.isFile()) files.push({ file: relative, sha256: createHash('sha256').update(await readFile(join(folder, entry.name))).digest('hex') });
    }
  }
  await visit(dirname(sdkPath));
  return files;
}
const sdkBefore = await sdkSnapshot();
const fixture = await startModelServer();
let child;
try {
  await mkdir(join(directory, 'logs'));
  const result = await new Promise((resolveResult, reject) => {
    child = spawn(process.execPath, [join(root, 'spikes/kimi-sdk-min-probe/run.mjs')], {
      cwd: directory,
      env: {
        ...process.env, MESNIER_PROBE_API_KEY: fixture.apiKey,
        MESNIER_PROBE_BASE_URL: fixture.baseUrl, MESNIER_PROBE_MODEL: 'mesnier-fixture',
        MESNIER_PROBE_MODEL_KIND: 'controlled', MESNIER_PROBE_OUTPUT_ROOT: directory,
        MESNIER_PROBE_SDK_PATH: sdkPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (value) => { stdout += value; });
    child.stderr.on('data', (value) => { stderr += value; });
    const timer = setTimeout(() => { child.kill(); reject(new Error('SDK 探针总执行时间超过 180 秒')); }, 180_000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stdout, stderr }); });
  });
  await writeFile(join(directory, 'logs/child.log'), `${result.stdout}\n${result.stderr}`);
  const evidence = JSON.parse(await readFile(join(directory, 'evidence/latest.json'), 'utf8'));
  const sdkAfter = await sdkSnapshot();
  const sdkUnchanged = JSON.stringify(sdkBefore) === JSON.stringify(sdkAfter);
  const summary = {
    directory, actualExit: result.code, reportedExit: evidence.退出码, modelKind: evidence.模型来源,
    sdkPath, sdkUnchanged, sdkFiles: sdkBefore,
    scenarios: evidence.场景, requestCount: fixture.requests.length, requests: fixture.requests,
  };
  await writeFile(join(directory, 'result.json'), JSON.stringify(summary, null, 2));
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exitCode = result.code === 0 && evidence.退出码 === 0 && sdkUnchanged ? 0 : 1;
} finally {
  if (child !== undefined && child.exitCode === null) child.kill();
  await fixture.close();
}
