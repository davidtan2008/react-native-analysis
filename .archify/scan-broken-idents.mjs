const fs = require('fs'), path = require('path');
const ROOT = 'packages/react-native';
const IDENTS = [
  'propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN',
  'setPropKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN',
  'componentViewName_DO_NOT_USE_THIS_IS_BROKEN',
  'findComponentDescriptorByHandle_DO_NOT_USE_THIS_IS_BROKEN',
];
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, {withFileTypes: true})) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p); }
    else if (/\.(h|m|mm|cpp|kt|java)$/.test(e.name)) files.push(p);
  }
})(ROOT);

console.log('标识符'.padEnd(52), '声明', ' 实现', ' 调用', ' 文件');
for (const id of IDENTS) {
  let decl = 0, impl = 0, call = 0;
  const hit = new Set();
  for (const f of files) {
    const t = fs.readFileSync(f, 'utf8');
    if (!t.includes(id)) continue;
    hit.add(f);
    const lines = t.split('\n');
    lines.forEach(l => {
      if (!l.includes(id)) return;
      // 声明：- (void)xxx:  或  Return xxx:  或 xxx(  开头
      if (/^\s*[-+]\s*\(/.test(l) && l.includes(id)) decl++;
      else if (new RegExp('^\\s*[\\w:<>,\\* ]+\\s+' + id + '\\b').test(l)) decl++;
      else if (new RegExp('\\b' + id + '\\s*:\\s*$|\\b' + id + '\\s*\\{').test(l)) impl++;
      else call++;
    });
  }
  console.log(id.padEnd(52), String(decl).padStart(4), String(impl).padStart(5), String(call).padStart(5), '  ' + hit.size);
}
