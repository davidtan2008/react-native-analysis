#!/usr/bin/env node
/**
 * 章节编号连续性检查：找出「子节编号与父节编号不一致」的文档。
 * 01 文档曾出现「## 5. 功能总览」下挂「### 4.x」子节的情况，
 * 肉眼容易漏，故机械化。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(__dirname, '..');

const problems = [];
for (const name of fs.readdirSync(DOCS).filter(f => f.endsWith('.md'))) {
  const text = fs.readFileSync(path.join(DOCS, name), 'utf8');
  let parent = null;
  let inFence = false;
  text.split('\n').forEach((line, i) => {
    if (/^\s*```/.test(line)) {inFence = !inFence; return;}
    if (inFence) return;
    const m = /^(#{2,3})\s+(\d+)(?:\.(\d+))?\.?\s/.exec(line);
    if (!m) return;
    const [, hashes, a, b] = m;
    if (hashes === '##') {
      parent = Number(a);
    } else if (hashes === '###' && b != null) {
      // 子节第一个数字应与父节一致
      if (parent != null && Number(a) !== parent) {
        problems.push({name, line: i + 1, got: `${a}.${b}`, want: `${parent}.${b}`, text: line.trim()});
      }
    }
  });
}

console.log('════════ 章节编号检查 ════════');
if (!problems.length) {
  console.log('✓ 所有文档的子节编号与父节一致\n');
  process.exit(0);
}
for (const p of problems) {
  console.log(`  ${p.name}:${p.line}  应为 ${p.want}，实为 ${p.got}`);
  console.log(`      ${p.text}`);
}
console.log(`\n✗ ${problems.length} 处编号错位\n`);
process.exit(1);
