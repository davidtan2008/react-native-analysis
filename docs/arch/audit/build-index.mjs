#!/usr/bin/env node
// ────────────────────────────────────────────────────────────────────────
// build-index.mjs —— 从每篇文档的 front-matter 生成检索索引
//
//   输入：docs/arch/[0-9][0-9]-*.md 的 front-matter
//         docs/arch/INDEX/_taxonomy.json（主题树 + 症状词表）
//   输出：docs/arch/INDEX/00-主题地图.md
//         docs/arch/INDEX/01-症状排查手册.md
//         docs/arch/INDEX/02-结论速查表.md
//         docs/arch/INDEX/03-符号与源码入口.md
//
// 索引**由脚本生成**，不允许手写 —— 否则索引会与文档漂移。
// check-index.mjs 校验生成物是最新的（重新生成后必须零 diff）。
// ────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

// 分析仓库根：从脚本自身位置推导，不依赖调用方的 cwd
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../../..');
const ARCH = path.join(REPO, 'docs/arch');
const OUT = path.join(ARCH, 'INDEX');
const TAX = JSON.parse(fs.readFileSync(path.join(OUT, '_taxonomy.json'), 'utf8'));

const parseList = s =>
  (s || '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map(x => x.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);

function readFrontMatter(file) {
  const t = fs.readFileSync(file, 'utf8');
  if (!t.startsWith('---\n')) return null;
  const end = t.indexOf('\n---\n', 4);
  if (end < 0) return null;
  const head = t.slice(4, end);
  const fm = {};
  for (const line of head.split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/\\"/g, '"');
    fm[k] = v;
  }
  fm._symptoms = parseList(fm.symptoms);
  fm._platforms = parseList(fm.platforms);
  fm._architecture = parseList(fm.architecture);
  fm._symbols = parseList(fm.symbols);
  fm._claims = parseList(fm.claims);
  fm._id = Number(fm.id);
  return fm;
}

const docs = [];
for (const f of fs.readdirSync(ARCH).filter(x => /^\d\d-.*\.md$/.test(x)).sort()) {
  const fm = readFrontMatter(path.join(ARCH, f));
  if (!fm) {
    console.error(`✗ ${f} 缺少 front-matter`);
    process.exit(1);
  }
  fm._file = f;
  docs.push(fm);
}

// 症状 → 小节标题关键词（用于「无编号结论」的早期文档做小节级回退）
const SYMPTOM_KEYWORDS = {
  crash: ['崩溃', '异常', 'Fatal', 'fatal', 'terminate', '异常处理', '错误路径'],
  whitescreen: ['白屏', '首帧', '可见', '空', 'CONTENT_APPEARED'],
  oom: ['OOM', '内存暴涨', '分配', '内存'],
  memleak: ['泄漏', 'leak', '释放'],
  mempressure: ['内存压力', 'onTrimMemory', '回收', '池', '内存警告'],
  slowstart: ['启动', '初始化', '耗时', '性能标记', '预热'],
  jank: ['掉帧', '卡顿', '帧', 'jank', 'FPS'],
  contentgrowth: ['增长', '膨胀', '列表', '缓存', '复用'],
  layout: ['布局', '度量', '裁剪', 'RTL', '尺寸', '矩形'],
  gesture: ['手势', '触摸', '命中', '指针', '事件'],
  animation: ['动画', 'Animated'],
  text: ['文本', '字体', '字号', '排版', '测量'],
  bridge: ['桥接', 'JNI', 'TurboModule', '序列化', '跨线程', '调用'],
  prop: ['属性', '脏标记', 'diff', '差分', 'Props'],
  build: ['构建', '门禁', '快照', '打包', '脚本'],
  debug: ['调试', '日志', '注释', 'Dev', '符号'],
  a11y: ['无障碍', '辅助功能', '朗读', '语义'],
};

const subOf = new Map();
const domOf = new Map();
for (const d of TAX.domains) {
  domOf.set(d.id, d);
  for (const s of d.subs) subOf.set(`${d.id}.${s.id.split('.').pop()}`, s);
}

const link = d => `[${d.id}·${d.title}](./${d._file})`;
const byId = new Map(docs.map(d => [d._id, d]));

// ── 00 主题地图 ────────────────────────────────────────────────────────
{
  const L = [];
  L.push('# 00 · 主题地图');
  L.push('');
  L.push('> **本文件由 `docs/arch/audit/build-index.mjs` 生成，请勿手改。**');
  L.push('> 修改方式：编辑对应文档的 front-matter（`topic:` / `symptoms:` / `symbols:`），然后重新运行该脚本。');
  L.push('');
  L.push(`共 **${docs.length}** 篇文档，覆盖 **${TAX.domains.length}** 个主题域。`);
  L.push('');
  L.push('## 三条检索路径');
  L.push('');
  L.push('| 我想知道 | 走哪条路径 |');
  L.push('| --- | --- |');
  L.push('| 某个子系统整体是怎么工作的 | **本文件** → 主题域 → 子主题 → 文档 |');
  L.push('| 我遇到了某个**现象**，怎么定位 | [01-症状排查手册](./01-症状排查手册.md) |');
  L.push('| 我知道源码里的**符号/目录**，想找到讲解 | [03-符号与源码入口](./03-符号与源码入口.md) |');
  L.push('| 我想直接看**某条结论** | [02-结论速查表](./02-结论速查表.md) |');
  L.push('');
  for (const dom of TAX.domains) {
    L.push(`## ${dom.id} · ${dom.name}`);
    L.push('');
    L.push(`> ${dom.intent}`);
    L.push('');
    for (const s of dom.subs) {
      const key = `${dom.id}.${s.id.split('.').pop()}`;
      const items = docs.filter(d => d.topic === key);
      L.push(`### ${s.id.split('.')[1]} · ${s.name}`);
      L.push('');
      L.push(`> ${s.intent}`);
      L.push('');
      if (!items.length) {
        L.push('_（暂无文档）_');
        L.push('');
        continue;
      }
      L.push('| 文档 | 覆盖的现象 | 平台 / 架构 | 关键结论 |');
      L.push('| --- | --- | --- | --- |');
      for (const d of items) {
        const sym = d._symptoms.map(x => TAX.symptoms[x]?.name ?? x).join('、') || '—';
        const pa = `${d._platforms.join('/')} · ${d._architecture.join('/')}`;
        const cl = d._claims.length ? `${d._claims.length} 条` : '—';
        L.push(`| ${link(d)} | ${sym} | ${pa} | ${cl} |`);
      }
      L.push('');
    }
  }
  fs.writeFileSync(path.join(OUT, '00-主题地图.md'), L.join('\n') + '\n');
}

// ── 01 症状排查手册 ────────────────────────────────────────────────────
{
  const L = [];
  L.push('# 01 · 症状排查手册');
  L.push('');
  L.push('> **本文件由 `docs/arch/audit/build-index.mjs` 生成，请勿手改。**');
  L.push('');
  L.push('**用法**：从左侧选现象 → 逐条读「结论」→ 跳到对应文档的对应小节 → 按结论里的 `文件:行号` 定位源码。');
  L.push('');
  L.push('每条结论都带**适用范围**（平台 / 架构 / 触发条件）—— **先看适用范围，再决定是否适用你的现场**。');
  L.push('');
  const used = new Set();
  for (const [key, meta] of Object.entries(TAX.symptoms)) {
    const items = docs.filter(d => d._symptoms.includes(key));
    items.forEach(d => d._symptoms.forEach(s => used.add(s)));
    L.push(`## ${meta.name} \`${key}\``);
    L.push('');
    L.push(`> ${meta.hint}`);
    L.push('');
    if (!items.length) {
      L.push('_（尚无文档覆盖该现象）_');
      L.push('');
      continue;
    }
    L.push('| 文档 | 结论 | 平台 / 架构 |');
    L.push('| --- | --- | --- |');
    for (const d of items) {
      const cl = d._claims.length ? d._claims.join('、') : '（无编号结论）';
      L.push(`| ${link(d)} | ${cl} | ${d._platforms.join('/')} · ${d._architecture.join('/')} |`);
    }
    L.push('');
    // 列出每篇文档里该现象相关的结论标题
    L.push('<details><summary>展开：各文档中与该现象直接相关的结论标题</summary>');
    L.push('');
    for (const d of items) {
      const t = fs.readFileSync(path.join(ARCH, d._file), 'utf8');
      const rows = t.split('\n').filter(l => /^\|\s*\*{0,2}[A-Z]{2,4}-\d+[a-z]?\*{0,2}\s*\|/.test(l));
      if (!rows.length) continue;
      L.push(`**${d.id} · ${d.title}**`);
      L.push('');
      for (const r of rows) {
        const cells = r.split('|').map(x => x.trim()).filter(x => x.length);
        const code = cells[0].replace(/\*/g, '');
        const title = (cells[1] || '').replace(/\*\*/g, '').replace(/<br\s*\/?>/g, ' ');
        L.push(`- \`${code}\` ${title}`);
      }
      L.push('');
    }
    L.push('</details>');
    L.push('');
    // 回退：没有编号结论表的早期文档，按小节标题给出定位
    const noClaims = items.filter(d => !d._claims.length);
    if (noClaims.length) {
      L.push('<details><summary>展开：无编号结论的文档 —— 按相关小节定位</summary>');
      L.push('');
      for (const d of noClaims) {
        const t = fs.readFileSync(path.join(ARCH, d._file), 'utf8');
        const heads = t.split('\n').filter(l => /^#{2,3}\s+\S/.test(l));
        const kws = SYMPTOM_KEYWORDS[key] || [];
        const hit = heads.filter(h => kws.some(k => h.includes(k)));
        if (!hit.length) continue;
        L.push(`**${d.id} · ${d.title}**`);
        L.push('');
        for (const h of hit) L.push(`- ${h.replace(/^#+\s*/, '')}`);
        L.push('');
      }
      L.push('</details>');
      L.push('');
    }
  }
  const unused = Object.keys(TAX.symptoms).filter(k => !used.has(k));
  if (unused.length) {
    L.push('## 尚未被任何文档覆盖的现象');
    L.push('');
    for (const k of unused) L.push(`- \`${k}\` —— ${TAX.symptoms[k].name}`);
    L.push('');
  }
  fs.writeFileSync(path.join(OUT, '01-症状排查手册.md'), L.join('\n') + '\n');
}

// ── 02 结论速查表 ──────────────────────────────────────────────────────
{
  const L = [];
  L.push('# 02 · 结论速查表');
  L.push('');
  L.push('> **本文件由 `docs/arch/audit/build-index.mjs` 生成，请勿手改。**');
  L.push('');
  L.push('每条结论的完整论证（含逐字代码、行号、适用范围）在其所属文档中。');
  L.push('**点击结论编号即跳到对应文档。**');
  L.push('');
  const all = [];
  for (const d of docs) {
    const t = fs.readFileSync(path.join(ARCH, d._file), 'utf8');
    for (const line of t.split('\n')) {
      const m = line.match(/^\|\s*\*{0,2}([A-Z]{2,4}-\d+[a-z]?)\*{0,2}\s*\|/);
      if (!m) continue;
      const cells = line.split('|').map(x => x.trim());
      const code = m[1];
      const title = (cells[2] || '').replace(/\*\*/g, '').replace(/<br\s*\/?>/g, ' ').replace(/\|/g, '/');
      const where = (cells[3] || '').replace(/`/g, '');
      all.push({ code, title, where, d });
    }
  }
  all.sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }));
  L.push(`共 **${all.length}** 条编号结论。`);
  L.push('');
  L.push('| 结论 | 摘要 | 源码位置 | 文档 |');
  L.push('| --- | --- | --- | --- |');
  for (const a of all) {
    const short = a.title.length > 150 ? a.title.slice(0, 150) + '…' : a.title;
    L.push(`| \`${a.code}\` | ${short} | ${a.where.slice(0, 90)} | [${a.d.id}·${a.d.title.slice(0, 40)}](./${a.d._file}) |`);
  }
  L.push('');
  fs.writeFileSync(path.join(OUT, '02-结论速查表.md'), L.join('\n') + '\n');
}

// ── 03 符号与源码入口 ──────────────────────────────────────────────────
{
  const L = [];
  L.push('# 03 · 符号与源码入口');
  L.push('');
  L.push('> **本文件由 `docs/arch/audit/build-index.mjs` 生成，请勿手改。**');
  L.push('');
  L.push('## 按关键符号检索');
  L.push('');
  const sym = new Map();
  for (const d of docs) for (const s of d._symbols) {
    if (!sym.has(s)) sym.set(s, []);
    sym.get(s).push(d);
  }
  L.push('| 符号 | 所在文档 |');
  L.push('| --- | --- |');
  for (const [s, ds] of [...sym.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    L.push(`| \`${s}\` | ${ds.map(d => `[${d.id}](./${d._file})`).join(' ')} |`);
  }
  L.push('');
  L.push('## 按模块目录检索');
  L.push('');
  const man = JSON.parse(fs.readFileSync(path.join(ARCH, 'audit/module-manifest.json'), 'utf8'));
  const byMod = new Map();
  for (const d of docs) {
    const t = fs.readFileSync(path.join(ARCH, d._file), 'utf8');
    const m = t.match(/^> \*\*模块\*\*：([A-Z]\d)\b/m);
    if (!m) continue;
    if (!byMod.has(m[1])) byMod.set(m[1], []);
    byMod.get(m[1]).push(d);
  }
  L.push('| 模块 | 名称 | 已读/总数 | 缺口 | 文档 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const mod of man.modules) {
    const ds = byMod.get(mod.id) || [];
    if (!ds.length) continue;
    L.push(`| ${mod.id} | ${mod.name} | ${mod.readFiles || 0}/${mod.fileCount} | ${mod.gap} | ${ds.map(d => `[${d.id}](./${d._file})`).join(' ')} |`);
  }
  L.push('');
  fs.writeFileSync(path.join(OUT, '03-符号与源码入口.md'), L.join('\n') + '\n');
}

console.log(`✓ 已生成 4 个索引文件（${docs.length} 篇文档 / ${TAX.domains.length} 个主题域）`);
