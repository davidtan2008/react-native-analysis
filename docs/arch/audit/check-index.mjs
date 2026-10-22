#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────
// check-index.mjs —— 索引体系门禁（第八项门禁）
//
// 校验五件事：
//   1. 每篇文档都有完整且合法的 front-matter（必填字段 + 枚举值合法）
//   2. front-matter 里的 claims 与文档「已发现的问题」表一致（双向）
//   3. symbols / symptoms 至少一项非空（避免「检索不到」）
//   4. INDEX/ 下的 4 个生成文件与重新生成的结果**逐字节一致**（防止索引漂移）
//   5. 症状词表里的每个词都至少被一篇文档使用（避免死词条）
//
// 退出码 0 = 全部通过；非 0 = 有问题。
// ────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 分析仓库根：从脚本自身位置推导，不依赖调用方的 cwd
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const ARCH = path.join(REPO, 'docs/arch');
// RN 源码根（git submodule）
const RN_ROOT = path.join(REPO, 'react-native');
const OUT = path.join(ARCH, 'INDEX');
const TAX = JSON.parse(fs.readFileSync(path.join(OUT, '_taxonomy.json'), 'utf8'));

const problems = [];
const ok = [];
const bad = (kind, msg) => problems.push(`[${kind}] ${msg}`);

const TOPICS = new Set();
for (const d of TAX.domains) for (const s of d.subs) TOPICS.add(`${d.id}.${s.id.split('.').pop()}`);
const SYMPTOMS = new Set(Object.keys(TAX.symptoms));
const DOMAINS = new Set(TAX.domains.map(d => d.id));

const parseList = s =>
  (s || '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map(x => x.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

const docs = [];
for (const f of fs.readdirSync(ARCH).filter(x => /^\d\d-.*\.md$/.test(x)).sort()) {
  const t = fs.readFileSync(path.join(ARCH, f), 'utf8');
  if (!t.startsWith('---\n')) {
    bad('NO_FRONTMATTER', f);
    continue;
  }
  const end = t.indexOf('\n---\n', 4);
  if (end < 0) {
    bad('NO_FRONTMATTER', f + '（front-matter 未闭合）');
    continue;
  }
  const fm = {};
  for (const line of t.slice(4, end).split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
    fm[k] = v;
  }
  fm._file = f;
  fm._body = t.slice(end + 5);
  fm._id = Number(fm.id);
  fm._symptoms = parseList(fm.symptoms);
  fm._symbols = parseList(fm.symbols);
  fm._claims = parseList(fm.claims);
  fm._platforms = parseList(fm.platforms);
  fm._architecture = parseList(fm.architecture);
  docs.push(fm);
}

// ── 0. 前置：RN 源码 submodule 必须已初始化 ──
if (!fs.existsSync(path.join(RN_ROOT, 'packages/react-native'))) {
  bad('SUBMODULE_MISSING',
    `RN 源码 submodule 未初始化（${path.relative(REPO, RN_ROOT)}/packages/react-native 不存在）` +
    ` —— 请先执行 \`git submodule update --init --recursive\`；否则源码侧断言会大面积误报`);
}

// ── 1. 必填字段 + 枚举合法 ────────────────────────────────────────────
const REQUIRED = ['id', 'title', 'topic', 'symptoms', 'platforms', 'architecture', 'layer', 'symbols', 'claims'];
for (const d of docs) {
  for (const k of REQUIRED) {
    if (d[k] === undefined) bad('MISSING_FIELD', `${d._file} 缺少 front-matter 字段 \`${k}\``);
  }
  if (d.id !== String(d._id)) bad('BAD_ID', `${d._file} 的 id 与文件名序号不一致`);
  if (!TOPICS.has(d.topic)) bad('BAD_TOPIC', `${d._file} 的 topic \`${d.topic}\` 不在主题树内`);
  else if (!DOMAINS.has(d.topic.split('.')[0])) bad('BAD_TOPIC', `${d._file} 的 topic 域非法`);
  for (const s of d._symptoms) if (!SYMPTOMS.has(s)) bad('BAD_SYMPTOM', `${d._file} 的症状 \`${s}\` 不在词表内`);
  for (const p of d._platforms) if (!['cross', 'ios', 'android'].includes(p)) bad('BAD_PLATFORM', `${d._file} 的 platform \`${p}\` 非法`);
  for (const a of d._architecture) if (!['cross', 'fabric', 'legacy'].includes(a)) bad('BAD_ARCH', `${d._file} 的 architecture \`${a}\` 非法`);
  if (!/^T[0-4]$/.test(d.layer || '')) bad('BAD_LAYER', `${d._file} 的 layer \`${d.layer}\` 非法`);
  // ── 2b. sourceRoot 字段：路径基准声明 ──
  if (d.sourceRoot !== 'react-native') {
    bad('BAD_SOURCE_ROOT', `${d._file} 的 sourceRoot 应为 \`react-native\`（当前 ${d.sourceRoot}）`);
  }

  // ── 3. 至少一项可检索维度非空 ──
  if (!d._symptoms.length && !d._symbols.length) bad('UNRETRIEVABLE', `${d._file} 既无 symptoms 也无 symbols —— 无法被检索到`);
}

// ── 2. claims 与「已发现的问题」表双向一致 ─────────────────────────────
for (const d of docs) {
  const inTable = [];
  for (const line of d._body.split('\n')) {
    const m = line.match(/^\|\s*\*{0,2}([A-Z]{2,4}-\d+[a-z]?)\*{0,2}\s*\|/);
    if (m && !inTable.includes(m[1])) inTable.push(m[1]);
  }
  for (const c of inTable) if (!d._claims.includes(c)) bad('CLAIM_NOT_LISTED', `${d._file} 的结论 \`${c}\` 未登记进 front-matter 的 claims`);
  for (const c of d._claims) if (!inTable.includes(c)) bad('CLAIM_NOT_IN_TABLE', `${d._file} 的 front-matter 声明了 \`${c}\`，但文档的问题表里没有`);
}

// ── 5. 症状词表无死词条 ────────────────────────────────────────────────
const usedSymptoms = new Set(docs.flatMap(d => d._symptoms));
for (const s of SYMPTOMS) if (!usedSymptoms.has(s)) bad('DEAD_SYMPTOM', `症状 \`${s}\`（${TAX.symptoms[s].name}）没有任何文档覆盖`);

// ── 4. 生成物是最新的 ─────────────────────────────────────────────────
const GEN = ['00-主题地图.md', '01-症状排查手册.md', '02-结论速查表.md', '03-符号与源码入口.md'];
const snapshot = new Map();
for (const g of GEN) {
  const p = path.join(OUT, g);
  if (!fs.existsSync(p)) {
    bad('INDEX_MISSING', `缺少生成文件 ${g}`);
    continue;
  }
  snapshot.set(g, fs.readFileSync(p, 'utf8'));
}
// 重新生成到临时目录后比对
const tmp = fs.mkdtempSync(path.join(REPO, '.archify', 'indexchk-'));
try {
  for (const g of GEN) {
    const p = path.join(OUT, g);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(tmp, g));
  }
  try {
    execFileSync('node', [path.join(ARCH, 'audit/build-index.mjs')], { cwd: REPO, stdio: 'ignore' });
  } catch (e) {
    bad('BUILD_INDEX_FAILED', `build-index.mjs 执行失败 —— 多半是某篇文档缺少或非法 front-matter（详见上方 build-index 的报错）`);
  }
  for (const g of GEN) {
    const p = path.join(OUT, g);
    const now = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    if (now !== (snapshot.get(g) ?? '')) bad('INDEX_STALE', `${g} 与重新生成的结果不一致 —— 索引已漂移，请运行 build-index.mjs`);
  }
} finally {
  // 还原（若 build-index 产生了差异，还原原文件以免掩盖问题）
  for (const g of GEN) {
    const p = path.join(OUT, g);
    if (snapshot.has(g)) fs.writeFileSync(p, snapshot.get(g));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── 报告 ──────────────────────────────────────────────────────────────
console.log('════════ 索引体系门禁 ════════');
console.log(`文档 ${docs.length} 篇 · 主题域 ${TAX.domains.length} 个 · 子主题 ${TOPICS.size} 个 · 症状词 ${SYMPTOMS.size} 个`);
console.log(`结论登记 ${docs.reduce((n, d) => n + d._claims.length, 0)} 条 · 生成文件 ${GEN.length} 个`);
console.log('');
if (!problems.length) {
  console.log('✓ 全部通过');
  console.log('  · front-matter 完整且枚举值合法（含 sourceRoot 路径基准声明）');
  console.log('  · RN 源码 submodule 已初始化（路径基准可用）');
  console.log('  · claims 与各文档的「已发现的问题」表双向一致');
  console.log('  · 每篇文档至少有一个可检索维度');
  console.log('  · 4 个生成文件与重新生成的结果逐字节一致');
  console.log('  · 症状词表无死词条');
  process.exit(0);
}
console.log(`✗ 发现 ${problems.length} 个问题：`);
for (const p of problems.slice(0, 60)) console.log('  ' + p);
if (problems.length > 60) console.log(`  …… 另有 ${problems.length - 60} 个`);
process.exit(1);
