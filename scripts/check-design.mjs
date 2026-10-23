import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

// 只检查可机械约束的设计规则；视觉、对比度和响应式仍需真实窗口验收。
export function inspectDesign(source, extension) {
  const issues = [];
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '');
  if (extension === '.css') {
    const components = text.replace(/:root(?:\[data-theme=['"]dark['"]\])?\s*\{[^}]*\}/g, '');
    if (/(?:#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab)\s*\()/i.test(components)) issues.push('组件颜色必须引用主题 token');
    for (const match of text.matchAll(/(?<![\w-])font-size\s*:\s*([^;}]+)/g)) {
      if (!/^(?:var\(--text-ui-[a-z-]+\)|inherit|1em)$/.test(match[1].trim())) issues.push(`字号必须引用语义 token：${match[1].trim()}`);
    }
    for (const match of text.matchAll(/(?<![\w-])font\s*:\s*([^;}]+)/g)) {
      if (!match[1].includes('var(--text-ui-') && match[1].trim() !== 'inherit') issues.push('font 简写必须使用语义字号');
    }
  } else {
    if (/\bfontSize\s*:/.test(text)) issues.push('TSX 不得以内联 fontSize 绕过字号角色');
    if (/\b(?:color|background|backgroundColor|borderColor)\s*:\s*['"`](?:#|rgba?\(|hsla?\()/i.test(text)) issues.push('TSX 内联颜色必须使用语义 token');
  }
  return issues;
}

function contrast(foreground, background) {
  const luminance = (hex) => {
    const channels = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
    const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return linear.reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  };
  const [low, high] = [luminance(foreground), luminance(background)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
}

if (process.argv.includes('--self-test')) {
  assert.equal(inspectDesign(':root { --ui-font-size: 14px; --text: #123456; } .title { color: var(--text); font-size: var(--text-ui-base); }', '.css').length, 0);
  assert.ok(inspectDesign('.title { font-size: 11px; color: #123456; }', '.css').length === 2);
  assert.ok(inspectDesign('.title { font: 11px/1.5 sans-serif; }', '.css').length === 1);
  assert.ok(inspectDesign('<h1 style={{ fontSize: 17, color: "#123456" }} />', '.tsx').length === 2);
  assert.equal(contrast('#000000', '#ffffff'), 21);
  assert.ok(contrast('#687384', '#f3f5f7') < 4.5);
  console.log('设计规则反例检查通过：任意字号、颜色与简写均被捕获。');
} else {
  const root = path.resolve('apps/desktop/src/renderer');
  let count = 0;
  let failed = false;
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    const extension = path.extname(entry.name);
    if (!entry.isFile() || !['.css', '.tsx'].includes(extension)) continue;
    const file = path.join(entry.parentPath, entry.name);
    count++;
    for (const issue of inspectDesign(fs.readFileSync(file, 'utf8'), extension)) {
      console.error(`${path.relative(process.cwd(), file)}: ${issue}`);
      failed = true;
    }
  }
  const stylesheet = fs.readFileSync(path.join(root, 'styles.css'), 'utf8');
  const palette = (selector) => {
    const body = stylesheet.slice(stylesheet.indexOf(selector)).split('}')[0];
    return Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[\da-f]{6})\b/gi)].map((match) => [match[1], match[2]]));
  };
  const light = palette(':root {');
  const dark = { ...light, ...palette(":root[data-theme='dark']") };
  const pairs = [['--text', '--bg'], ['--muted', '--sidebar'], ['--muted', '--surface-hover'], ['--secondary', '--surface'], ['--on-accent', '--accent'], ['--accent-ink', '--accent-soft'], ['--success-ink', '--success-soft'], ['--warning', '--warning-soft'], ['--danger', '--danger-soft'], ['--text', '--sidebar-selected'], ['--muted', '--sidebar-selected']];
  for (const [theme, tokens] of Object.entries({ light, dark })) {
    for (const [foreground, background] of pairs) {
      const ratio = tokens[foreground] && tokens[background] ? contrast(tokens[foreground], tokens[background]) : NaN;
      if (!(ratio >= 4.5)) {
        console.error(`${theme}: ${foreground} / ${background} 文字对比度不足4.5:1或缺少色值（${ratio.toFixed(2)}）`);
        failed = true;
      }
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`设计静态检查通过（${count} 份 renderer 文件、${pairs.length * 2}组主题文字对比度）；视觉与响应式需单独验收。`);
}
