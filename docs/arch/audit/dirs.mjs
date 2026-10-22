#!/usr/bin/env node
/**
 * 目录清单：枚举仓库中所有非测试代码目录及其文件数，
 * 作为重建「目录级模块划分」的事实依据。
 *
 * 用法：node docs/arch/audit/dirs.mjs [--depth N] [--min N]
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// RN 源码根：本仓库以 git submodule 形式把 facebook/react-native 挂在 react-native/ 下
const REPO = path.resolve(__dirname, '../../../react-native');

const argv = process.argv.slice(2);
const getArg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 ? argv[i + 1] : d;
};
const DEPTH = Number(getArg('--depth', 4));
const MIN = Number(getArg('--min', 1));

const CODE = new Set(['.js', '.mjs', '.ts', '.tsx', '.kt', '.java', '.mm', '.m', '.h', '.cpp', '.cc', '.swift', '.py']);
// 明确排除的「非框架代码」：预编译产物、第三方副本、类型声明
const EXCLUDE = [
  'packages/debugger-frontend/dist',   // 预编译 DevTools 前端（Chromium 副本）
  'packages/react-native/types_DEPRECATED', // 手写旧版 .d.ts
  'packages/rn-tester',                 // 示例 App
  'packages/jest-preset/jest/mocks',    // jest mock
];
const isExcluded = p => EXCLUDE.some(e => p.startsWith(e));
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

const agg = new Map();
for (const f of files) {
  const p = f.split('/');
  const key = p.slice(0, Math.min(DEPTH, p.length - 1)).join('/');
  agg.set(key, (agg.get(key) ?? 0) + 1);
}

const sorted = [...agg.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const shown = sorted.filter(([, n]) => n >= MIN);

const excludedCount = (() => {
  let n = 0;
  for (const r of ['packages', 'private', 'scripts']) {
    const abs = path.join(REPO, r);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      const rel = path.relative(REPO, f);
      if (!CODE.has(path.extname(f))) continue;
      if (isTest(rel)) continue;
      if (isExcluded(rel)) n++;
    }
  }
  return n;
})();

console.log(`计入模块划分的代码文件: ${files.length}`);
console.log(`排除（预编译/示例/类型声明/mock）: ${excludedCount}`);
console.log(`聚合到 depth=${DEPTH}，共 ${sorted.length} 个目录（>=${MIN} 文件的 ${shown.length} 个）`);
console.log('');
let cum = 0;
for (const [k, n] of shown) {
  cum += n;
  console.log(`${String(n).padStart(5)}  ${String(cum).padStart(5)}  ${k}`);
}
