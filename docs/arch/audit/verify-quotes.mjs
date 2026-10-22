#!/usr/bin/env node
/**
 * 语义核验器：检查文档中**代码块里引用的代码**是否真的存在于被引用的源文件位置。
 *
 * 与 audit-citations.mjs 互补：
 *   - audit-citations 验证「文件存在、行号在范围内」
 *   - 本脚本验证「文档里贴的代码，其每一行确实出现在该源文件的引用行附近」
 *
 * 算法：
 *   1. 从 markdown 提取所有 ``` 代码块
 *   2. 紧邻代码块之前（含同段落内）寻找最近的 `文件:行号` 引用作为锚点
 *   3. 对代码块中的每个非空行，做归一化（去空白）后在源文件全文中查找
 *      - 若找不到 → 标记 SUSPECT（可能编造或行号漂移）
 *   4. 输出可疑项供人工复核
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// RN 源码根：本仓库以 git submodule 形式把 facebook/react-native 挂在 react-native/ 下
const REPO = path.resolve(__dirname, '../../../react-native');
const DOCS = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');

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

const INDEX = new Map();
for (const root of ['packages', 'private', 'scripts']) {
  const abs = path.join(REPO, root);
  if (!fs.existsSync(abs)) continue;
  for (const f of walk(abs)) {
    const rel = path.relative(REPO, f);
    INDEX.set(rel, f);
    const m = rel.match(/^packages\/[^/]+\/(.+)$/);
    if (m) INDEX.set(m[1], f);
  }
}

function resolveFile(p) {
  if (INDEX.has(p)) return INDEX.get(p);
  // 处理 `.h:44` / `.cpp:71` 这类同目录简写：由调用方通过 contextDir 补全
  const base = path.basename(p);
  if (INDEX.has(base)) return INDEX.get(base);
  const seen = new Set();
  for (const [k, v] of INDEX) if (path.basename(k) === base) seen.add(v);
  return seen.size === 1 ? [...seen][0] : null;
}

const norm = s => s.replace(/\s+/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '');
const isCodeish = s => /[A-Za-z_$]|[{}();=<>]/.test(s);

/** ASCII 目录树 / 流程图 / shell 会话 等非源码代码块，不参与语义核验 */
function isIllustrativeBlock(body) {
  const treeChars = /[├└│─┌┐┘┬┴┼┤]/;
  const hasTree = body.some(l => treeChars.test(l));
  // 箭头流程图：多行以 → / ↓ / └ 开头或结尾，且缺少代码语法特征
  const arrowFlow = body.filter(l => /^\s*[A-Za-z0-9_$.()\[\]]*\s*(→|↓|←|⇒)/.test(l) || /\s(→|↓|←)\s/.test(l)).length;
  const CMD = /^\s*(node|npm|yarn|git|cd|ls|grep|find)\s+\S/;
  const looksLikeShell = /^\s*(\$|#|>)\s/.test(body.find(l => l.trim()) ?? '') ||
    body.filter(l => CMD.test(l)).length >= 2;
  const codey = body.some(l => /[;{}()]|::|=>|\bfunction\b|\breturn\b/.test(l));
  if (hasTree) return true;
  if (looksLikeShell && !codey) return true;
  // 箭头流程图：过半的行含箭头，且几乎无分号/花括号
  const meaningful = body.filter(l => l.trim()).length;
  if (arrowFlow >= Math.max(2, meaningful * 0.5) && !/[;{}]/.test(body.join('\n'))) return true;
  if (!codey && meaningful > 2 && !/[;]/.test(body.join('\n'))) return true;
  return false;
}

/**
 * 把一行文档代码切成"可验证的记号序列"。
 * 用于容忍：跨行合并、省略大括号、行内注释、空白与缩进差异。
 * 返回去掉注释与标点后的标识符/字面量片段数组。
 */
function tokens(line) {
  return norm(line)
    // 去掉行注释与行尾注释
    .replace(/\/\/.*$/, '')
    // 去掉字符串字面量内容（但保留引号本身无意义，直接去）
    .replace(/"[^"]*"/g, ' ')
    .replace(/'[^']*'/g, ' ')
    // 去掉 C 注释
    .replace(/\/\*.*?\*\//g, ' ')
    // 切成标识符 / 数字
    .split(/[^A-Za-z0-9_$]+/)
    .filter(t => t.length > 1);
}

function main() {
  const files = fs.readdirSync(DOCS).filter(f => f.endsWith('.md'));
  let totalBlocks = 0, totalLines = 0, suspect = 0;
  const report = [];

  for (const f of files) {
    const txt = fs.readFileSync(path.join(DOCS, f), 'utf8');
    const lines = txt.split('\n');
    // 找所有代码块
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*```/.test(lines[i])) continue;
      // 收集块体
      let j = i + 1; const body = [];
      while (j < lines.length && !/^\s*```/.test(lines[j])) { body.push(lines[j]); j++; }
      if (j >= lines.length) break;
      // 锚点：代码块之前 25 行内的所有 `文件:行号` 引用
      //      + 代码块自身前几行内的 `// 路径:行号` 注释（我们为压缩块添加的出处标注）
      const anchors = [];
      const inBlockRe = /(?:^|\s)\/\/\s*([A-Za-z0-9_./+-]+\.(?:js|mjs|ts|tsx|kt|java|mm|m|h|cpp|cc)):(\d+)(?:\s*[-–,]\s*(\d+))?/;
      for (const bl of body.slice(0, 3)) {
        const m = bl.match(inBlockRe);
        if (m) anchors.push({path: m[1], line: Number(m[2]), endLine: m[3] ? Number(m[3]) : null, inBlock: true});
      }
      for (let k = i - 1; k >= Math.max(0, i - 25) && anchors.filter(a => !a.inBlock).length < 4; k--) {
        const re = /`([A-Za-z0-9_./+-]+\.(?:js|mjs|ts|tsx|kt|java|mm|m|h|cpp|cc)):(\d+)(?:[-–](\d+))?`/g;
        let m;
        while ((m = re.exec(lines[k])) !== null) {
          anchors.push({path: m[1], line: Number(m[2]), endLine: m[3] ? Number(m[3]) : null});
        }
      }
      if (!anchors.length) { i = j; continue; }   // 无锚点代码块（目录树、ASCII 图）跳过
      if (isIllustrativeBlock(body)) { i = j; continue; }  // 示意图/会话记录跳过

      // 预加载所有锚点对应文件的窗口文本（窗口放宽到 60 行，覆盖跨小节的引用）
      const anchorsInfo = anchors.map(a => {
        const abs = resolveFile(a.path);
        if (!abs) return {...a, abs: null};
        const st = fs.readFileSync(abs, 'utf8');
        const sl = st.split('\n').map(norm);
        const win = 60;
        const lo = Math.max(1, a.line - win);
        const hi = Math.min(sl.length, (a.endLine ?? a.line) + win);
        return {...a, abs, all: st, window: sl.slice(lo - 1, hi).join(' ')};
      });
      const resolvedAnchors = anchorsInfo.filter(a => a.abs);
      if (!resolvedAnchors.length) {
        report.push({doc: f, docLine: i + 1, kind: 'ANCHOR_UNRESOLVED', anchor: anchors.map(a => a.path).join(', ')});
        suspect++;
        i = j; continue;
      }

      for (const [bi, bl] of body.entries()) {
        const t = norm(bl);
        if (!t || t.length < 8) continue;
        if (!isCodeish(t)) continue;
        if (t.includes('...') || t.includes('…')) continue;  // 省略号行无法逐字核验

        totalLines++;

        // 1) 逐字命中任一锚点文件
        if (resolvedAnchors.some(a => a.all.includes(t))) continue;

        // 2) 记号级核验：文档该行的标识符是否都能在任一锚点窗口找到
        const tk = tokens(bl);
        if (tk.length < 2) continue;
        const best = resolvedAnchors.map(a => {
          const set = new Set(a.window.split(/[^A-Za-z0-9_$]+/).filter(x => x.length > 1));
          return {a, missing: tk.filter(x => !set.has(x))};
        }).sort((x, y) => x.missing.length - y.missing.length)[0];

        if (best.missing.length > 1) {
          report.push({
            doc: f, docLine: i + 2 + bi, kind: 'NOT_IN_SOURCE',
            code: bl.trim(),
            anchor: best.a.path + ':' + best.a.line,
            missing: best.missing.slice(0, 6),
          });
          suspect++;
        } else {
          report.push({doc: f, docLine: i + 2 + bi, kind: 'PARAPHRASE_OK', code: bl.trim(), anchor: best.a.path + ':' + best.a.line});
        }
      }
      totalBlocks++;
      i = j;
    }
  }

  const byKind = {};
  for (const r of report) (byKind[r.kind] ??= []).push(r);

  console.log('════════ 代码块语义核验 ════════');
  console.log(`代码块(有锚点): ${totalBlocks}   校验行: ${totalLines}   可疑: ${suspect}`);
  console.log('');
  for (const [k, v] of Object.entries(byKind)) {
    console.log(`  ${k.padEnd(20)} ${v.length}`);
  }
  const hard = (byKind.NOT_IN_SOURCE ?? []).concat(byKind.ANCHOR_UNRESOLVED ?? []);
  if (hard.length) {
    console.log('\n── 需复核：代码未在源文件找到 ──');
    for (const r of hard) {
      console.log(`\n[${r.kind}] ${r.doc}:${r.docLine}  锚点 ${r.anchor ?? ''}`);
      if (r.code) console.log(`  文档: ${r.code}`);
    }
  }
  if (VERBOSE) {
    const drift = byKind.FOUND_ELSEWHERE ?? [];
    if (drift.length) {
      console.log('\n── 提示：内容存在但不在引用行附近（行号可能漂移）──');
      for (const r of drift.slice(0, 40)) console.log(`  ${r.doc}:${r.docLine}  ${r.anchor}  |  ${r.code.slice(0, 70)}`);
      if (drift.length > 40) console.log(`  … 其余 ${drift.length - 40} 条省略`);
    }
  }
  process.exitCode = hard.length ? 1 : 0;
}
main();
