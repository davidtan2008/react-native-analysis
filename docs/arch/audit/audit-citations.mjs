#!/usr/bin/env node
/**
 * 文档事实审计器
 *
 * 用途：从 docs/arch/*.md 中抽取所有 `路径:行号` / `路径:行号-行号` 形式的源码引用，
 * 逐条到仓库中核验：
 *   1. 文件是否存在
 *   2. 行号是否在文件实际行数范围内
 *   3. 引用的那一行（及整段）实际内容是什么（供人工复核语义是否相符）
 *
 * 用法：
 *   node docs/arch/audit/audit-citations.mjs              # 汇总报告
 *   node docs/arch/audit/audit-citations.mjs --detail     # 逐条打印引用行内容
 *   node docs/arch/audit/audit-citations.mjs --json out.json
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// RN 源码根：本仓库以 git submodule 形式把 facebook/react-native 挂在 react-native/ 下
const REPO = path.resolve(__dirname, '../../../react-native');
const DOCS = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const DETAIL = args.includes('--detail');
const JSON_OUT = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;

/** 仓库中用于搜索源码的根目录白名单（避免命中 .archify / node_modules） */
const SEARCH_ROOTS = [
  // RN 仓库根：仓库根级的配置文件（.eslintrc.js / .babelrc / .flowconfig …）
  // 是可审计源码，必须能被引用到行号；'' 表示 REPO 本身。
  '',
  'packages',
  'private',
  'scripts',
  'jest',
  'flow-typed',
  // CI 编排同样是可审计源码：workflow / composite action 里的路径与行号必须能被校验。
  // walk() 默认跳过点目录，所以显式把 .github 作为根加入（见 walk 的 allowDot 参数）。
  '.github',
];

/** 文档里出现的、可能带或不带行号的源码文件后缀 */
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|kt|java|mm|m|h|cpp|cc|c|hpp|py|rb|json|gradle|swift|podspec|xml|pro|yml|yaml|snap)$/;

function walk(dir, out = [], allowDot = false) {
  let ents;
  try {
    ents = fs.readdirSync(dir, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const e of ents) {
    // .git 永远跳过；其余点目录只在根被显式列入 SEARCH_ROOTS 时才进入
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!allowDot && e.name.startsWith('.')) continue;
      walk(p, out, false);
    } else {
      // 点「文件」是正规源码（.eslintrc.js / .babelrc / .flowconfig …），一律收录，
      // 否则仓库根级的配置文件无法被引用审计（曾经是盲区）。
      out.push(p);
    }
  }
  return out;
}

/** 建立 仓库相对路径 -> 绝对路径 索引 */
function buildIndex() {
  const index = new Map();
  for (const root of SEARCH_ROOTS) {
    const abs = path.join(REPO, root);
    if (!fs.existsSync(abs)) continue;
    // 被显式列入 SEARCH_ROOTS 的点目录（如 .github）允许进入，其余子目录仍跳过点目录
    for (const f of walk(abs, [], root.startsWith('.'))) {
      const rel = path.relative(REPO, f);
      index.set(rel, f);
      // 同时以去掉 packages/ 前缀的形式建索引，便于匹配文档里的简写
      const m = rel.match(/^packages\/[^/]+\/(.+)$/);
      if (m) index.set(m[1], f);
    }
  }
  return index;
}

/**
 * 从 markdown 抽取引用。
 * 匹配反引号内形如 `some/path/File.ext:12` 或 `File.ext:12-34` 或 `File.ext:12,34`
 * 也匹配裸形式的 `File.ext:12`（行内）。
 */
const CITATION_RE = /([A-Za-z0-9_./+-]+\.(?:js|mjs|ts|tsx|jsx|kt|java|mm|m|h|cpp|cc|pro|json|gradle|swift|xml|yml|yaml|snap)):(\d+)(?:\s*[-–]\s*(\d+))?/g;

/**
 * 只带路径、不带行号的引用（例如 01 文档功能总览里的
 * `ReactCommon/react/renderer/mounting/Differentiator.cpp`）。
 * 这类引用此前不在 CITATION_RE 覆盖范围内，等于完全没被审计过。
 * 这里单独抽出来，至少验证「路径确实存在」。
 */
const PATH_ONLY_RE = /`([A-Za-z0-9_./+-]*(?:ReactCommon|ReactAndroid|ReactApple|ReactCxxPlatform|Libraries|src|packages|private|scripts)[A-Za-z0-9_./+-]*\.(?:js|mjs|ts|tsx|kt|java|mm|m|h|cpp|cc|swift|rb|py))`/g;

function extractPathOnly(text, file) {
  const out = [];
  let m;
  while ((m = PATH_ONLY_RE.exec(text)) !== null) {
    const upto = text.slice(0, m.index);
    out.push({file, docLine: upto.split('\n').length, path: m[1]});
  }
  return out;
}

function extractCitations(text, file) {
  const out = [];
  let m;
  while ((m = CITATION_RE.exec(text)) !== null) {
    const [full, p, l1, l2] = m;
    // 计算行号在文档中的位置，便于定位
    const upto = text.slice(0, m.index);
    const line = upto.split('\n').length;
    out.push({file, docLine: line, raw: full, path: p, line: Number(l1), endLine: l2 ? Number(l2) : null});
  }
  return out;
}

/**
 * 展开 `ReactAndroid/.../runtime/Foo.kt:12` 这类「省略中间目录 + 行号」的写法。
 * 04 文档里有 10 处这种引用，若不展开则其行号断言完全逃过机器校验。
 * 策略：取文件名的 basename，在仓库索引里按 basename 反查，
 * 若唯一匹配则用真实路径继续校验行号；不唯一则保持 ELIDED 并列出候选。
 */
function expandElided(index) {
  const byBase = new Map();
  for (const [k, v] of index) {
    const base = path.basename(k);
    if (!byBase.has(base)) byBase.set(base, new Map());
    byBase.get(base).set(v, k);
  }

  const out = [];
  for (const df of fs.readdirSync(DOCS)) {
    if (!df.endsWith('.md')) continue;
    const txt = fs.readFileSync(path.join(DOCS, df), 'utf8');
    const cleaned = txt.replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' '));
    // ReactAndroid/.../<subpath>/File.ext:<lines>
    const re = /`([A-Za-z0-9_.-]+\/\.\.\.\/[A-Za-z0-9_./+-]*?\.([a-z]+)):(\d+)(?:\s*[-–]\s*(\d+))?`/g;
    let m;
    while ((m = re.exec(cleaned)) !== null) {
      const [raw, p, ext, l1, l2] = m;
      const base = path.basename(p);
      const hits = byBase.get(base);
      const uniq = hits && hits.size === 1 ? [...hits.values()][0] : null;
      out.push({
        file: df,
        docLine: cleaned.slice(0, m.index).split('\n').length,
        raw,
        path: uniq ?? p,
        line: Number(l1),
        endLine: l2 ? Number(l2) : null,
        elided: true,
        candidates: hits && hits.size > 1 ? [...hits.values()].sort() : null,
      });
    }
  }
  return out;
}

function lineCount(abs) {
  const txt = fs.readFileSync(abs, 'utf8');
  return {count: txt.split('\n').length, txt};
}

function main() {
  const index = buildIndex();
  const docFiles = fs.readdirSync(DOCS).filter(f => f.endsWith('.md')).map(f => path.join(DOCS, f));

  const citations = [];
  for (const df of docFiles) {
    const txt = fs.readFileSync(df, 'utf8');
    citations.push(...extractCitations(txt, path.basename(df)));
  }
  // 省略路径 + 行号的引用，展开后并入同一批校验
  const elided = expandElided(index);
  citations.push(...elided.filter(e => !e.candidates));

  const results = citations.map(c => {
    // 解析路径：可能是完整相对路径，或仅文件名
    const candidates = [c.path, `packages/react-native/${c.path}`];
    let abs = null;
    let resolved = null;
    for (const cand of candidates) {
      if (index.has(cand)) { abs = index.get(cand); resolved = cand; break; }
    }
    // 兜底：按 basename 唯一匹配（按绝对路径去重，因为索引同时存了完整与去前缀两种键）
    if (!abs) {
      const base = path.basename(c.path);
      const seen = new Map();
      for (const [k, v] of index) {
        if (path.basename(k) === base && !seen.has(v)) seen.set(v, k);
      }
      if (seen.size === 1) {
        abs = [...seen.keys()][0];
        resolved = [...seen.values()][0];
      } else if (seen.size > 1) {
        const list = [...seen.values()].sort();
        return {...c, status: 'AMBIGUOUS_BASENAME', detail: `文件名 ${base} 有 ${seen.size} 处匹配: ${list.slice(0, 4).join(', ')}${list.length > 4 ? ' …' : ''}`};
      }
    }
    if (!abs) {
      return {...c, status: 'FILE_NOT_FOUND', detail: `无法在仓库中定位 ${c.path}`};
    }
    const {count, txt} = lineCount(abs);
    const end = c.endLine ?? c.line;
    if (c.line < 1 || c.line > count) {
      return {...c, status: 'LINE_OUT_OF_RANGE', resolved, fileLines: count, detail: `行号 ${c.line} 超出文件范围 (1..${count})`};
    }
    if (end > count) {
      return {...c, status: 'END_LINE_OUT_OF_RANGE', resolved, fileLines: count, detail: `结束行 ${end} 超出文件范围 (1..${count})`};
    }
    const lines = txt.split('\n');
    const snippet = lines.slice(c.line - 1, end).map((s, i) => `${c.line + i}: ${s}`).join('\n');
    return {...c, status: 'OK', resolved, fileLines: count, snippet};
  });

  // ── 第三路：表格中声明的文件行数 vs 实际 ────────────────────────────
  // 本次复核发现 8 处行数偏差（都差 1，源于扫描脚本用 split('\n').length
  // 把末尾换行算成一行）。肉眼无法发现，必须机械化。
  // 匹配形如： | `path/to/File.kt` | 185 | 26 | **26** | 是 |
  const lineCountRows = [];
  for (const df of docFiles) {
    const txt = fs.readFileSync(df, 'utf8').replace(/```[\s\S]*?```/g, '');
    const re = /\|\s*`([A-Za-z0-9_./-]+\.(?:kt|java|cpp|h|js|mm|m))`\s*\|\s*(\d{2,6})\s*\|/g;
    let m;
    while ((m = re.exec(txt)) !== null) {
      const [, rel, claimed] = m;
      // 解析真实路径（同 expandElided 的候选策略）
      const cands = [
        path.join(REPO, rel),
        path.join(REPO, 'packages/react-native', rel),
        path.join(REPO, 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react', rel),
        path.join(REPO, 'packages/react-native/ReactCommon', rel),
      ];
      const abs = cands.find(p => fs.existsSync(p));
      if (!abs) continue;
      // 以 wc -l 语义计数（末尾换行不额外计一行），与读者习惯一致
      const actual = fs.readFileSync(abs, 'utf8').replace(/\n$/, '').split('\n').length;
      const line = txt.slice(0, m.index).split('\n').length;
      if (Number(claimed) !== actual) {
        lineCountRows.push({
          file: path.basename(df), docLine: line, rel,
          detail: `文档声明 ${claimed} 行，实际 ${actual} 行`,
        });
      }
    }
  }

  const byStatus = {};
  for (const r of results) (byStatus[r.status] ??= []).push(r);

  // ── 第二路：无行号的纯路径引用（只验证存在性）────────────────────────
  const pathOnly = [];
  for (const df of docFiles) {
    const txt = fs.readFileSync(df, 'utf8');
    // 去掉围栏代码块，避免把示例里的路径算进来
    const cleaned = txt.replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' '));
    for (const c of extractPathOnly(cleaned, path.basename(df))) {
      // 已被带行号的正则覆盖的，跳过
      if (new RegExp(c.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\d').test(cleaned)) continue;

      // 含省略号的写法（`ReactAndroid/.../foo.kt`）机器无法定位。
      // 但若带行号，已由 expandElided 单独展开校验；此处只收无行号且无法展开的。
      if (c.path.includes('...')) {
        pathOnly.push({...c, status: 'ELIDED'});
        continue;
      }
      // 文档里的路径常相对 packages/react-native/ 简写，逐个候选前缀尝试
      const candidates = [
        path.join(REPO, c.path),
        path.join(REPO, 'packages/react-native', c.path),
        path.join(REPO, 'packages', c.path),
      ];
      const abs = candidates.find(p => fs.existsSync(p));
      pathOnly.push({
        ...c,
        status: abs ? 'OK' : 'PATH_NOT_FOUND',
        resolved: abs ? path.relative(REPO, abs) : null,
      });
    }
  }
  const pathProblems = pathOnly.filter(p => p.status !== 'OK');
  for (const p of pathOnly) (byStatus[p.status] ??= []).push(p);

  const problems = [...results.filter(r => r.status !== 'OK'), ...pathProblems];

  // 报告
  const lines = [];
  lines.push('════════ 文档源码引用审计报告 ════════');
  lines.push(`仓库根: ${REPO}`);
  lines.push(`文档: ${docFiles.length} 个`);
  lines.push(`带行号引用: ${results.length} 条（校验文件存在 + 行号范围）`);
  lines.push(`纯路径引用: ${pathOnly.length} 条（仅校验路径存在）`);
  lines.push('');
  lines.push('── 汇总 ──');
  for (const [k, v] of Object.entries(byStatus).sort()) {
    const note = k === 'ELIDED' ? '  ← 含 `...` 省略写法，机器无法定位，需人工确认' : '';
    lines.push(`  ${k.padEnd(24)} ${v.length}${note}`);
  }
  lines.push('');

  if (lineCountRows.length) {
    lines.push('── 表格中声明的行数与实际不符 ──');
    for (const r of lineCountRows) {
      lines.push(`  ${r.file}:${r.docLine}  \`${r.rel}\`  ${r.detail}`);
    }
    lines.push('');
  }

  // lineCountRows 也要计入 problems，否则退出码仍为 0（门禁失效）
  const totalProblems = problems.length + lineCountRows.length;

  if (problems.length) {
    lines.push('── 需要人工处理的问题 ──');
    for (const p of problems) {
      lines.push('');
      lines.push(`[${p.status}] ${p.file}:${p.docLine}`);
      lines.push(`  引用: \`${p.raw ?? p.path}\``);
      lines.push(`  详情: ${p.detail ?? '该路径在仓库中不存在'}`);
      if (p.snippet) lines.push(`  实际:\n${p.snippet.split('\n').map(s => '    ' + s).join('\n')}`);
    }
  } else {
    lines.push(`✓ 所有引用有效（${results.length} 条带行号 + ${pathOnly.length} 条纯路径）`);
  }

  if (DETAIL) {
    lines.push('');
    lines.push('── 全部引用明细（供语义复核）──');
    for (const r of results.filter(r => r.status === 'OK')) {
      lines.push('');
      lines.push(`${r.file}:${r.docLine}  \`${r.raw}\`  → ${r.resolved}`);
      lines.push(r.snippet.split('\n').map(s => '    ' + s).join('\n'));
    }
  }

  const report = lines.join('\n');
  console.log(report);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      repo: REPO,
      docCount: docFiles.length,
      citationCount: results.length,
      byStatus: Object.fromEntries(Object.entries(byStatus).map(([k, v]) => [k, v.length])),
      results,
    }, null, 2));
    console.error(`\n(JSON 已写入 ${JSON_OUT})`);
  }

  process.exitCode = totalProblems ? 1 : 0;
}

main();
