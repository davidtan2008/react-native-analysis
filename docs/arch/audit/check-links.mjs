#!/usr/bin/env node
/**
 * 文档间链接检查器
 *
 * 用途：找出 docs/arch/*.md 中所有 markdown 相对链接，验证
 *   1) 目标文件存在
 *   2) 锚点（#heading）在目标文件中真实存在
 *
 * 为什么需要：audit-citations.mjs 只管「指向源码的引用」，
 * verify-quotes.mjs 只管「代码块内容」，两者都不管文档之间的交叉引用。
 * 而交叉引用是本目录最容易被批量改名破坏的部分（新增文档后旧链接指向的
 * 章节标题可能已改、或锚点因中文标点而失配）。
 *
 * 用法：node docs/arch/audit/check-links.mjs
 * 退出码：0 = 全部有效；1 = 存在断链
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS = path.resolve(__dirname, '..');

/** GitHub 风格锚点：小写、非字母数字删除、空格转连字符、连字符转义 */
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function anchorsOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = new Set();
  const lines = text.split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {inFence = !inFence; continue;}
    if (inFence) continue;
    // ATX 标题：# / ## / ### …
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      out.add(slug(m[2].replace(/\s*#+\s*$/, '')));
      continue;
    }
    // Setext 风格：当前行是标题，下一行全是 === 或 ---
    const next = lines[i + 1];
    if (line.trim() && next && /^\s*(=+|-{3,})\s*$/.test(next)) {
      out.add(slug(line));
    }
  }
  return out;
}

const anchorCache = new Map();
function getAnchors(file) {
  if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(file));
  return anchorCache.get(file);
}

const problems = [];
let checked = 0;
let linkCount = 0;

const docFiles = fs
  .readdirSync(DOCS)
  .filter(f => f.endsWith('.md'))
  .sort();

for (const name of docFiles) {
  const file = path.join(DOCS, name);
  const text = fs.readFileSync(file, 'utf8');

  // 去掉围栏代码块，避免把示例中的路径当链接
  const lines = text.split('\n');
  let inFence = false;
  lines.forEach((line, i) => {
    if (/^\s*```/.test(line)) {inFence = !inFence; return;}
    if (inFence) return;

    // ![img](x) 与 [text](x)
    const re = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const target = m[1];
      linkCount++;
      // 跳过外部链接与锚点自引用
      if (/^(https?:|mailto:)/.test(target)) continue;

      const [relPath, hash] = target.split('#');
      const targetFile = relPath
        ? path.resolve(path.dirname(file), decodeURIComponent(relPath))
        : file;

      if (!fs.existsSync(targetFile)) {
        problems.push({
          doc: name,
          line: i + 1,
          kind: 'FILE_NOT_FOUND',
          target,
        });
        continue;
      }
      checked++;
      if (hash) {
        const anchors = getAnchors(targetFile);
        if (!anchors.has(decodeURIComponent(hash).toLowerCase())) {
          problems.push({
            doc: name,
            line: i + 1,
            kind: 'ANCHOR_NOT_FOUND',
            target,
            inFile: path.basename(targetFile),
          });
        }
      }
    }
  });
}

console.log('════════ 文档间链接检查 ════════');
console.log(`文档: ${docFiles.length}   链接: ${linkCount}   已校验: ${checked}`);

// ── 附带检查：表格行重复 ──────────────────────────────────────────────
// 批量编辑文档时很容易把同一行插两次（本次复核就发生过）。
// 表格首列是稳定 ID，可能是单值（`C1`）也可能是区间（`C24-C26`），
// 两种都要能识别 —— 只匹配单值会让区间行全部漏检。
//
// 注意：要扫 docs/arch/ 下的全部 md（含 audit/ 子目录），
// 否则 audit/README.md 里的断言表根本不会被检查到。
function allMarkdownFiles() {
  const out = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'diagrams') continue; // 图表目录无 markdown 索引表
        walk(p);
      } else if (e.name.endsWith('.md')) {
        out.push(p);
      }
    }
  };
  walk(DOCS);
  return out.sort();
}

const dupRows = [];
for (const file of allMarkdownFiles()) {
  const rel = path.relative(DOCS, file);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const seen = new Map();
  lines.forEach((l, i) => {
    const m = /^\|\s*((?:C|D)\d+[a-z]?(?:\s*-\s*(?:C|D)?\d+[a-z]?)?)\s*\|/.exec(l);
    if (!m) return;
    const id = m[1].replace(/\s+/g, '');
    if (seen.has(id)) dupRows.push({name: rel, id, first: seen.get(id), again: i + 1});
    else seen.set(id, i + 1);
  });
}

if (dupRows.length) {
  console.log(`\n── 重复表格行 (${dupRows.length}) ──`);
  for (const d of dupRows) console.log(`  ${d.name}:${d.again}  重复 ID ${d.id}（首次在 :${d.first}）`);
  console.log('');
}

if (problems.length === 0 && dupRows.length === 0) {
  console.log('\n✓ 所有文档间链接与锚点均有效，且无重复表格行\n');
  process.exit(0);
}

const byKind = {};
for (const p of problems) (byKind[p.kind] ??= []).push(p);

for (const [kind, list] of Object.entries(byKind)) {
  console.log(`\n── ${kind} (${list.length}) ──`);
  for (const p of list) {
    const where = p.inFile ? ` → ${p.inFile}` : '';
    console.log(`  ${p.doc}:${p.line}  ${p.target}${where}`);
  }
}
console.log(
  `\n✗ 共 ${problems.length} 处断链` +
  (dupRows.length ? ` + ${dupRows.length} 处重复表格行` : '') +
  '\n',
);
process.exit(1);
