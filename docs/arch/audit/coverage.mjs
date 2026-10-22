#!/usr/bin/env node
/**
 * 覆盖度分析（目录级）：把 module-manifest.json 中每个模块的 dirs 展开为文件集合，
 * 与仓库全部非测试代码文件求交集，输出真实覆盖率与未读清单。
 *
 * 用法：
 *   node docs/arch/audit/coverage.mjs            # 汇总
 *   node docs/arch/audit/coverage.mjs --gaps     # 追加未读模块队列
 *   node docs/arch/audit/coverage.mjs --detail   # 追加每模块实际命中文件
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// RN 源码根：本仓库以 git submodule 形式把 facebook/react-native 挂在 react-native/ 下
const REPO = path.resolve(__dirname, '../../../react-native');
const MANIFEST = path.join(__dirname, 'module-manifest.json');

const argv = process.argv.slice(2);
const SHOW_GAPS = argv.includes('--gaps');
const DETAIL = argv.includes('--detail');

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

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const EXCLUDE = Object.keys(manifest.baseline.excluded.paths);
const isExcluded = p => EXCLUDE.some(e => p === e || p.startsWith(e + '/'));

// 收集计入范围的文件
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
const ALL = files;

const perModule = [];
const claimed = new Set();

for (const mod of manifest.modules) {
  const hit = new Set();
  for (const d of mod.dirs ?? []) {
    for (const f of ALL) {
      if (f === d || f.startsWith(d + '/')) { hit.add(f); claimed.add(f); }
    }
  }
  perModule.push({
    ...mod,
    matched: hit.size,
    read: mod.readFiles ?? 0,
    gap: hit.size - (mod.readFiles ?? 0),
    hitRatio: hit.size ? (mod.readFiles ?? 0) / hit.size : 0,
    files: [...hit],
  });
}

const unclaimed = ALL.filter(f => !claimed.has(f));

console.log('════════ 覆盖度分析（目录级）════════');
console.log(`计入范围的代码文件:        ${ALL.length}`);
console.log(`manifest 声明覆盖:        ${claimed.size}  (${((claimed.size / ALL.length) * 100).toFixed(1)}%)`);
console.log(`已读并被文档引用（readFiles 合计）: ${perModule.reduce((s, m) => s + m.read, 0)}  (${((perModule.reduce((s, m) => s + m.read, 0) / ALL.length) * 100).toFixed(1)}%)`);
console.log(`未被任何模块声明:         ${unclaimed.length}`);
console.log('');

console.log('── 各模块：声明范围 / 已读 / 缺口 ──');
const sorted = [...perModule].sort((a, b) => b.gap - a.gap);
const maxGap = Math.max(1, ...sorted.map(m => m.gap));
for (const m of sorted) {
  const bar = '#'.repeat(Math.round((m.gap / maxGap) * 26));
  const ratio = (m.hitRatio * 100).toFixed(0);
  console.log(`  ${m.id.padEnd(4)} ${String(m.matched).padStart(4)} 读${String(m.read).padStart(4)}(${ratio.padStart(3)}%) 缺${String(m.gap).padStart(4)}  ${m.tier} ${m.name.slice(0, 34).padEnd(34)} ${bar}`);
}
console.log('');

if (unclaimed.length) {
  const outFile = path.join(__dirname, 'unclaimed.json');
  fs.writeFileSync(outFile, JSON.stringify(unclaimed, null, 2));
  console.log('── 未被任何模块声明 ──');
  const agg = new Map();
  for (const f of unclaimed) {
    const p = f.split('/');
    const k = p.slice(0, Math.min(4, p.length - 1)).join('/');
    agg.set(k, (agg.get(k) ?? 0) + 1);
  }
  for (const [k, n] of [...agg.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${String(n).padStart(5)}  ${k}`);
  }
  console.log(`  （完整清单已写入 audit/unclaimed.json，共 ${unclaimed.length} 个文件）`);
  console.log('');
}

if (SHOW_GAPS) {
  console.log('── 推进队列（按未读缺口降序）──');
  for (const m of sorted) {
    if (m.gap <= 0) continue;
    console.log(`  [${m.tier}] ${m.id} ${m.name}  —— 缺 ${m.gap} / ${m.matched} (已读 ${(m.hitRatio * 100).toFixed(0)}%)`);
  }
  console.log('');
  const batches = manifest.queue?.batches;
  if (Array.isArray(batches)) {
    console.log(`── manifest 中预设的批次（共 ${batches.length} 批；取舍理由见 ${manifest.planDoc ?? 'READ-PLAN.md'}）──`);
    for (const b of batches) {
      const mods = (b.modules ?? []).map(id => perModule.find(x => x.id === id)).filter(Boolean);
      const liveGap = mods.reduce((s, m) => s + Math.max(0, m.gap), 0);
      console.log(`  ${String(b.n).padStart(2)}. ${b.name}  —— 当前缺 ${liveGap}（manifest 记录 ${b.gap}）`);
      for (const m of mods) {
        if (m.gap <= 0) continue;
        console.log(`        [${m.tier}] ${m.id} ${m.name}  缺 ${m.gap}`);
      }
    }
  }
}

if (DETAIL) {
  console.log('');
  console.log('── 各模块命中文件（前 10）──');
  for (const m of sorted) {
    console.log('');
    console.log(`[${m.id}] ${m.name}  ${m.matched} 个文件`);
    for (const f of m.files.slice(0, 10)) console.log(`   ${f}`);
    if (m.files.length > 10) console.log(`   ... 其余 ${m.files.length - 10}`);
  }
}
