const fs = require('fs');
const path = require('path');
const ROOT = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react';

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, {withFileTypes: true})) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); }
    else if (/\.(kt|java)$/.test(e.name) && !e.name.includes('Test')) files.push(p);
  }
})(ROOT);

const rows = [];
for (const f of files) {
  const t = fs.readFileSync(f, 'utf8');
  const lines = t.split('\n');
  // 找出「空方法体」：形如 `fun x(...){}` 或 `...: Type = null/Unit` 且缩进独立成行
  const emptyBodies = lines.filter(l =>
    /^\s*(public |private |internal |protected )?fun .*\{\s*\}\s*$/.test(l) ||
    /^\s*(public |private |internal |protected )?\w+.*:\s*(Unit|Int|Long|Boolean|String|View\??|Map<[^>]*>)\s*=\s*(Unit|null|0|false|HashMap\(\))\s*$/.test(l)
  ).length;
  const total = (t.match(/^\s*(public |private |internal |protected )?(open |override |abstract )*fun /gm) ?? []).length +
                (t.match(/^\s*(public |private |internal |protected )[\w<>\[\],. ?]+\s+\w+\([^)]*\)\s*\{/gm) ?? []).length;
  const legacy = /@LegacyArchitecture/.test(t);
  if (emptyBodies >= 3 || (legacy && total > 5)) {
    rows.push({f: f.replace(ROOT + '/', ''), lines: lines.length, total, empty: emptyBodies, legacy});
  }
}
rows.sort((a, b) => (b.empty / Math.max(b.total, 1)) - (a.empty / Math.max(a.total, 1)));
console.log('文件'.padEnd(52), '行数', ' 方法', ' 空体', ' Legacy');
for (const r of rows.slice(0, 25)) {
  console.log(r.f.padEnd(52), String(r.lines).padStart(4), String(r.total).padStart(5), String(r.empty).padStart(5), r.legacy ? '  是' : '');
}
console.log('\n命中文件数:', rows.length, '/ 扫描', files.length);
