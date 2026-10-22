import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../../../spikes/kimi-sdk-min-probe/probe.ts';

const [mode, directory] = process.argv.slice(2);
// 所有数据均为本测试创建；不会导入 SDK、访问模型或读取个人配置。
for (const name of ['MESNIER_PROBE_API_KEY', 'MESNIER_PROBE_BASE_URL', 'MESNIER_PROBE_MODEL']) {
  if (mode === 'missing') delete process.env[name];
  else process.env[name] = 'fixture-only';
}
let upstreamChecks = 0;
const result = await main({
  async snapshotPersonals() {
    if (mode === 'snapshot-failure') throw new Error('受控初始快照失败');
    return new Map();
  },
  personalUnchanged() {
    if (mode === 'personal') throw new Error('受控个人目录变化');
    return { fixture: '受控目录未变化' };
  },
  assertUpstreamClean() {
    upstreamChecks += 1;
    if (mode === 'finalizer' && upstreamChecks === 2) throw new Error('受控收尾失败');
    return { head: 'fixture', bytes: 0 };
  },
  async prepareRunDirs() {
    return { homeDir: directory, workDir: directory, configPath: join(directory, 'config.toml') };
  },
  async runCredentialed(evidence) {
    if (mode === 'runtime-failure') throw new Error('受控运行失败');
    for (const scenario of Object.values(evidence.场景)) {
      scenario.状态 = '通过';
      scenario.说明 = '替身结果，仅验证判定逻辑';
    }
    if (mode === 'unchecked') evidence.场景.恢复.状态 = '未覆盖';
    return 0;
  },
  async writeEvidence(evidence) {
    if (mode === 'evidence-failure') throw new Error('受控证据写入失败');
    await writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence));
  },
});
process.exitCode = result;
