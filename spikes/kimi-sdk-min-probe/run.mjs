#!/usr/bin/env node
/**
 * Mesnier 最小接入入口。
 *
 * 在导入 Kimi SDK 之前固定遥测开关和数据目录。KIMI_CODE_HOME 必须与
 * createKimiHarness 的 homeDir 是同一个任务目录：ripgrep 缓存只读这个环境变量，
 * 未传 homeDir 时内核也会回退到它，再不行就落到用户的 ~/.kimi-code。
 */

import { pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sandbox = resolve(process.env.MESNIER_PROBE_OUTPUT_ROOT ?? here, 'sandbox');

process.env.KIMI_DISABLE_TELEMETRY = '1';
process.env.KIMI_CODE_HOME = sandbox;

const main = pathToFileURL(resolve(here, 'probe.ts'));
const probe = await import(main.href);
process.exitCode = await probe.main();
