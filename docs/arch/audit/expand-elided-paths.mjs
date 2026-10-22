#!/usr/bin/env node
/**
 * 把文档里 `ReactAndroid/.../x/y.kt` 这类省略写法补成完整路径。
 * 省略写法让行号断言逃过机器校验（本次复核发现 10 处）。
 * 只替换已人工确认 basename 在仓库中唯一的项。
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// RN 源码根：本仓库以 git submodule 形式把 facebook/react-native 挂在 react-native/ 下
const REPO = path.resolve(__dirname, '../../../react-native');
const DOCS = path.resolve(__dirname, '..');
const PREFIX = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/';

function findUnique(rel) {
  const abs = path.join(REPO, PREFIX, rel);
  return fs.existsSync(abs) ? PREFIX + rel : null;
}

let total = 0;
for (const name of fs.readdirSync(DOCS).filter(f => f.endsWith('.md'))) {
  const file = path.join(DOCS, name);
  let s = fs.readFileSync(file, 'utf8');
  let n = 0;
  // `ReactAndroid/.../<rest>`
  s = s.replace(/ReactAndroid\/\.\.\.\/([A-Za-z0-9_./-]+\.[a-z]+)/g, (all, rest) => {
    const full = findUnique(rest);
    if (!full) return all; // 无法唯一确认，保持原样
    n++;
    return full;
  });
  if (n > 0) {
    fs.writeFileSync(file, s);
    console.log(`✓ ${name}  补全 ${n} 处`);
    total += n;
  }
}
console.log(`\n合计补全 ${total} 处`);
