#!/usr/bin/env node
/**
 * 归一化 manifest：消除模块间目录声明的重复与父子重叠，
 * 然后按实测文件数重算每个模块的 fileCount / 缺口 / 批次 gap。
 *
 * 用法：node docs/arch/audit/normalize-manifest.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// RN 源码根：本仓库以 git submodule 形式把 facebook/react-native 挂在 react-native/ 下
const REPO = path.resolve(__dirname, '../../../react-native');
const MANIFEST = path.join(__dirname, 'module-manifest.json');

const CODE = new Set(['.js', '.mjs', '.ts', '.tsx', '.kt', '.java', '.mm', '.m', '.h', '.cpp', '.cc', '.swift', '.py']);
const isTest = p =>
  /(^|\/)(__tests__|__mocks__|__flowtests__|tests?)\//.test(p) ||
  /\.(test|itest|spec)\.[jt]sx?$/.test(p);

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, {withFileTypes: true}); } catch { return out; }
  for (const e of ents) {
    if (['node_modules', '.git'].includes(e.name) || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const EXCLUDE = Object.keys(m.baseline.excluded.paths);
const isExcluded = p => EXCLUDE.some(e => p === e || p.startsWith(e + '/'));

// 1) 收集计入范围的真实文件
const files = [];
for (const r of ['packages', 'private', 'scripts']) {
  const abs = path.join(REPO, r);
  if (!fs.existsSync(abs)) continue;
  for (const f of walk(abs)) {
    const rel = path.relative(REPO, f);
    if (!CODE.has(path.extname(f))) continue;
    if (isTest(rel) || isExcluded(rel)) continue;
    files.push(rel);
  }
}

// 2) 消除重复声明
const owner = new Map();
let removed = 0;
for (const mod of m.modules) {
  const keep = [];
  for (const d of mod.dirs ?? []) {
    if (owner.has(d)) { removed++; continue; }
    owner.set(d, mod.id);
    keep.push(d);
  }
  mod.dirs = keep;
}

// 3) 消除父子重叠
const allDirs = [...owner.keys()].sort((a, b) => a.length - b.length);
for (const mod of m.modules) {
  const keep = mod.dirs.filter(d => !allDirs.some(o => o !== d && d.startsWith(o + '/')));
  removed += mod.dirs.length - keep.length;
  mod.dirs = keep;
}

// 4) 实测每个模块的 fileCount / gap
const gapOf = {};
for (const mod of m.modules) {
  const hit = files.filter(f => mod.dirs.some(d => f === d || f.startsWith(d + '/')));
  mod.fileCount = hit.length;
  mod.gap = hit.length - (mod.readFiles ?? 0);
  gapOf[mod.id] = mod.gap;
  mod.$comment = 'fileCount/gap 由 normalize-manifest.mjs 实测重算，勿手工填写';
  delete mod.fileCount_note;
}

// 5) 重算批次 gap
if (m.queue?.batches) {
  for (const b of m.queue.batches) {
    b.gap = b.modules.reduce((s, id) => s + (gapOf[id] ?? 0), 0);
  }
  m.queue.totalGap = m.queue.batches.reduce((s, b) => s + b.gap, 0);
}

fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2));

const claimed = m.modules.reduce((s, x) => s + (x.fileCount ?? 0), 0);
const read = m.modules.reduce((s, x) => s + (x.readFiles ?? 0), 0);
console.log('════════ manifest 归一化完成 ════════');
console.log(`移除重复/重叠目录声明: ${removed}`);
console.log(`计入范围文件:         ${files.length}`);
console.log(`模块声明覆盖:         ${claimed}  (${((claimed / files.length) * 100).toFixed(1)}%)`);
console.log(`已读:                 ${read}  (${((read / files.length) * 100).toFixed(1)}%)`);
console.log(`模块缺口合计:         ${m.queue?.totalGap ?? '-'}`);
if (m.queue?.batches) {
  for (const b of m.queue.batches) {
    console.log(`  批次${String(b.n).padStart(2)} ${b.name.padEnd(20)} ${b.gap}`);
  }
}
