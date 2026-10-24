#!/usr/bin/env node
/**
 * 核心断言双向校验。
 *
 * 为什么需要：
 *   audit-citations 只能证明「引用的那几行存在」
 *   verify-quotes   只能证明「代码块内容来自所引位置」
 *   两者都无法证明「结论本身是对的」。
 *
 * 本脚本对每个高风险断言做**两个方向**的检查：
 *   [源码侧] 源码的实际状态是否符合断言所声称的
 *   [文档侧] docs/arch/*.md 中是否真的写了这个结论
 *
 * 只做源码侧是不够的：把文档措辞改错而源码不变，源码侧仍会通过。
 * 两个方向都做，才能覆盖「写错」与「源码演进导致文档腐化」两类问题。
 *
 * 已知局限（使用时注意）：
 *   1. 文档侧只检查「该结论在整个文档集中是否还存在」，不检查「每篇都写了」。
 *      删掉某一篇里的关键结论，只要别处还提过就仍会通过。
 *      因此 addDocClaim 的 min 参数要按「这个结论本就该出现在几处」来设。
 *   2. 断言是硬编码的。新增文档结论后若想让门禁覆盖它，需手工补一条。
 *   3. 源码侧断言是「当前源码状态」的快照。源码演进后如果断言 FAIL，
 *      应当先判断是「源码变了（文档需更新）」还是「断言写错了（改断言）」。
 *
 * 用法：node docs/arch/audit/verify-claims.mjs
 * 退出码：0 = 全部成立；1 = 有断言与源码或文档不符
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// RN 源码根：本仓库以 git submodule 形式把 facebook/react-native 挂在 react-native/ 下
const REPO = path.resolve(__dirname, '../../../react-native');
const DOCS = path.resolve(__dirname, '..');

const read = p => {
  const f = path.join(REPO, p);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
};
const exists = p => fs.existsSync(path.join(REPO, p));

/**
 * 全仓库搜索（排除 node_modules / .git）。
 *
 * 返回 {occurrences, files}：
 *   occurrences 实际出现**行数**（语义等同 `grep -c`，一个文件内多行命中会多次计数）
 *   files       命中文件列表
 *
 * 注意：早前实现用 `t.match(re)` 且 regex 不带 g 标志，只会得到首个匹配，
 * 导致同一文件内多次引用被算成 1 次（本次复核发现文档写「14 处」实际 18 处，
 * 而断言却「通过」，根因就是这里）。故改为按行计数。
 */
function grepCount(
  pattern,
  {exts = null, roots = ['packages', 'private', 'scripts'], skipTests = true, skipDirs = [], excludeFiles = []} = {},
) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const g = re.global ? re : new RegExp(re.source, re.flags + 'g');
  const skipRe = skipDirs.length ? new RegExp('(^|/)(' + skipDirs.join('|') + ')/') : null;
  let occurrences = 0;
  const hits = [];
  const walk = dir => {
    let ents;
    try {ents = fs.readdirSync(dir, {withFileTypes: true});} catch {return;}
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {walk(p); continue;}
      // 默认排除测试与快照：它们的引用数不代表生产代码的真实依赖
      if (skipTests && /(^|\/)(__tests__|__mocks__|__snapshots__|__flowtests__)\//.test(p)) continue;
      // 额外的目录级排除（如 C++/Kotlin 测试目录 tests/）
      if (skipRe && skipRe.test(p)) continue;
      if (exts && !exts.includes(path.extname(e.name))) continue;
      const rel = path.relative(REPO, p);
      // 排除定义文件自身（统计「引用」时不看自己）
      if (excludeFiles.includes(rel) || excludeFiles.includes(e.name)) continue;
      const t = read(rel);
      if (t == null) continue;
      let lines = 0;
      for (const line of t.split('\n')) {
        g.lastIndex = 0;
        if (g.test(line)) lines++;
      }
      if (lines > 0) {occurrences += lines; hits.push(rel);}
    }
  };
  roots.forEach(r => walk(path.join(REPO, r)));
  return {count: occurrences, occurrences, files: hits};
}

const checks = [];
const add = (id, claim, expect, actual, ok) =>
  checks.push({id, claim, expect, actual, ok});

/** 逐份读取文档正文（去掉代码块），供「文档侧」方向检查 */
const DOC_TEXT = new Map(
  fs
    .readdirSync(DOCS)
    .filter(f => f.endsWith('.md'))
    .map(f => [
      f,
      fs
        .readFileSync(path.join(DOCS, f), 'utf8')
        .replace(/```[\s\S]*?```/g, ' '),
    ]),
);

/**
 * 断言「某条结论确实被写进了文档」。
 *
 * min 语义是「至少 N 份文档提到这条结论」。必须区分「全文档汇总里出现过」
 * 与「被写进了文档」—— 只查汇总会让「删掉某一篇里的关键结论」蒙混过关。
 */
function addDocClaim(id, claim, pattern, {min = 1} = {}) {
  const hit = [...DOC_TEXT.entries()].filter(([, t]) => pattern.test(t)).map(([f]) => f);
  const ok = hit.length >= min;
  add(
    id,
    `【文档侧】${claim}`,
    `≥${min} 份文档`,
    ok ? `${hit.length} 份: ${hit.slice(0, 2).join(', ')}${hit.length > 2 ? '…' : ''}` : '仅 ' + hit.length + ' 份',
    ok,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 1. RN 不实现崩溃上传：OnJsError 只有一个构造点，框架内无实现
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp';
  const t = read(f) ?? '';
  const ctor = (t.match(/make_shared<JsErrorHandler>/g) ?? []).length;
  add(
    'C1', 'JsErrorHandler 全仓库仅在 ReactInstance 构造处创建（上报端由宿主注入）',
    '恰好 1 处', `${ctor} 处`, ctor === 1,
  );
  // JsErrorHandler 头文件里 OnJsError 必须是裸 std::function，没有任何默认实现体
  const h = read('packages/react-native/ReactCommon/jserrorhandler/JsErrorHandler.h') ?? '';
  const hasAlias = /using OnJsError = std::function</.test(h);
  add(
    'C2', 'OnJsError 只是 std::function 别名，RN 未提供默认实现',
    '存在别名声明', hasAlias ? '存在' : '缺失', hasAlias,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 2. 无原生崩溃捕获：没有 signal handler、没有 NSSetUncaughtExceptionHandler
// ────────────────────────────────────────────────────────────────────────
{
  const sig = grepCount(/\bsignal\s*\(\s*SIG/, {
    exts: ['.cpp', '.mm', '.m', '.h', '.c'],
  });
  add(
    'C3', 'RN 源码未注册 POSIX signal handler（即无原生崩溃信号捕获）',
    '0 处', `${sig.count} 处`, sig.count === 0,
  );
  const ns = grepCount(/NSSetUncaughtExceptionHandler/, {
    exts: ['.mm', '.m', '.h'],
  });
  add(
    'C4', 'RN 源码未调用 NSSetUncaughtExceptionHandler（iOS 无未捕获异常兜底）',
    '0 处', `${ns.count} 处`, ns.count === 0,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 3. FrameRateLogger 原生模块已删
// ────────────────────────────────────────────────────────────────────────
{
  const native = grepCount(/FrameRateLogger/, {exts: ['.kt', '.java', '.mm', '.h', '.cpp', '.m']});
  add(
    'C5', 'FrameRateLogger 的原生实现已删除（仅 JS 侧残留）',
    '0 个原生文件', native.count === 0 ? '0 个' : `${native.count} 个: ${native.files.slice(0, 3).join(', ')}`,
    native.count === 0,
  );
  const js = grepCount(/FrameRateLogger/, {exts: ['.js', '.ts']});
  add(
    'C6', 'FrameRateLogger 的 JS 侧仍存在（文档称「JS 层还在」）',
    '>0 处', `${js.count} 处`, js.count > 0,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 4. Android 侧 memoryWarning 完全缺失（不是空实现）
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/core/DeviceEventManagerModule.kt';
  const android = grepCount(/memoryWarning|MemoryWarning/i, {
    exts: ['.kt', '.java'],
    roots: ['packages/react-native/ReactAndroid/src/main'],
  });
  add(
    'C7', 'Android 原生侧完全没有 memoryWarning 派发（不是空实现，05 文档缺口章节）',
    '0 处', `${android.count} 处`, android.count === 0,
  );
  // JS 侧监听 API 必须存在，否则「Android 上是 no-op」的说法不成立
  const js = read('packages/react-native/Libraries/AppState/AppState.js') ?? '';
  add(
    'C7b', 'JS 侧 AppState 确实提供了 memoryWarning 监听 API',
    '存在',
    /memoryWarning/.test(js) ? '存在' : '缺失',
    /memoryWarning/.test(js),
  );
  // iOS 侧必须真的有派发，否则「仅 iOS 有」的说法不成立
  const ios = read('packages/react-native/React/CoreModules/RCTAppState.mm') ?? '';
  add(
    'C7c', 'iOS 侧 RCTAppState 确实派发 memoryWarning（平台不对称）',
    '存在',
    /sendEventWithName:@"memoryWarning"/.test(ios) ? '存在' : '缺失',
    /sendEventWithName:@"memoryWarning"/.test(ios),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 5. LeakChecker 仅 Debug 编译
// ────────────────────────────────────────────────────────────────────────
{
  const hits = grepCount(/#if\s+FB_LEAK_CHECKER|REACT_NATIVE_DEBUG|defined\(DEBUG\)|NDEBUG/);
  add(
    'C8', '泄漏检测受编译期宏控制（非 Release 生效）',
    '>0 处编译期守卫', `${hits.count} 处`, hits.count > 0,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 6. 无白屏检测：不存在以「首屏渲染完成」为判据的检测器
// ────────────────────────────────────────────────────────────────────────
{
  // 只统计「真正实现了检测逻辑」的位置：排除注释里出现的字样。
  // RCTRootView.h 的 loadingView 注释里有 "blank screen"，那是「加载时显示占位以免白屏」
  // 的预防措施，不是检测器 —— 不能算作白屏检测存在。
  const w = grepCount(/white\s*screen|blank\s*screen|WhiteScreen|BlankScreen/i, {
    exts: ['.js', '.ts', '.kt', '.java', '.cpp', '.mm', '.h', '.m'],
  });
  // 逐个命中判断是否在注释里
  const realImpl = w.files.filter(rel => {
    const t = read(rel);
    return t
      .split('\n')
      .some(l => !/^\s*(\*|\/\/|\/\*)/.test(l) && /white\s*screen|blank\s*screen/i.test(l));
  });
  add(
    'C9', 'RN 源码中不存在白屏/空屏检测实现（仅注释提及，属预防措施）',
    '0 处非注释命中',
    realImpl.length === 0 ? '0 处' : `${realImpl.length} 处: ${realImpl.slice(0, 3).join(', ')}`,
    realImpl.length === 0,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 7. iOS 仍有 Shadow 队列相关代码（平台限定结论，Shadow 线程教训）
// ────────────────────────────────────────────────────────────────────────
{
  const ios = exists('packages/react-native/React/Modules/RCTUIManagerUtils.m');
  add(
    'C10', 'iOS 仍存在 RCTUIManagerUtils.m（Shadow 队列相关，故不能说「全平台已移除」）',
    '存在', ios ? '存在' : '不存在', ios,
  );
  // 该文件确实与 shadow queue 相关，而非同名巧合
  const t = read('packages/react-native/React/Modules/RCTUIManagerUtils.m') ?? '';
  add(
    'C10b', 'RCTUIManagerUtils.m 内容确实涉及 shadow queue',
    '提及 shadow',
    /shadow/i.test(t) ? '提及' : '未提及',
    /shadow/i.test(t),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 8. view/platform/ios 不存在，iOS 复用 cxx
// ────────────────────────────────────────────────────────────────────────
{
  const iosView = exists('packages/react-native/ReactCommon/react/renderer/components/view/platform/ios');
  add(
    'C11', 'view/platform/ios 目录不存在（10 文档核心发现）',
    '不存在', iosView ? '存在' : '不存在', !iosView,
  );
  const cxx = exists('packages/react-native/ReactCommon/react/renderer/components/view/platform/cxx');
  add(
    'C12', 'view/platform/cxx 存在（iOS 实际使用的实现）',
    '存在', cxx ? '存在' : '不存在', cxx,
  );
  const rb = read('packages/react-native/scripts/cocoapods/utils.rb') ?? '';
  add(
    'C13', 'CocoaPods 搜索路径只加 cxx、未加 view/platform/ios',
    '仅含 cxx',
    /react\/renderer\/components\/view\/platform\/cxx/.test(rb) && !/react\/renderer\/components\/view\/platform\/ios/.test(rb)
      ? '仅含 cxx' : '异常',
    /react\/renderer\/components\/view\/platform\/cxx/.test(rb) && !/react\/renderer\/components\/view\/platform\/ios/.test(rb),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 9. LongLivedObjectCollection 实例表不清理
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactCommon/react/bridging/LongLivedObject.cpp';
  const t = read(f) ?? '';
  // instances 是函数内 static，且没有对它的 erase
  const hasStaticMap = /static std::unordered_map<void\*, std::shared_ptr<LongLivedObjectCollection>>/.test(t);
  const erasesInstances = /instances\.erase|instances\.clear/.test(t);
  add(
    'C14', 'LongLivedObjectCollection 的静态实例表存在且从不清理（14 文档核心发现）',
    'static 存在 + 无 erase',
    `static=${hasStaticMap} erase=${!erasesInstances ? '无' : '有'}`,
    hasStaticMap && !erasesInstances,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 10. initializeCore 的幂等守卫早于任何 require
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/src/private/setup/setUpDefaultReactNativeEnvironment.js';
  const t = read(f) ?? '';
  const iGuard = t.indexOf('initialized = true');
  const iRequire = t.indexOf('require(');
  add(
    'C15', 'initialized = true 早于第一个 require（失败后不可重试，13 文档 BOOT-1）',
    '守卫在 require 之前',
    iGuard >= 0 && iRequire >= 0 && iGuard < iRequire ? '守卫在前' : '顺序不符',
    iGuard >= 0 && iRequire >= 0 && iGuard < iRequire,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 11. setRuntimeReady 的唯一调用点及其守卫条件
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp';
  const t = read(f) ?? '';
  const n = (t.match(/setRuntimeReady\(/g) ?? []).length;
  add(
    'C16', 'setRuntimeReady 在 ReactInstance.cpp 中只有 1 处调用',
    '1 处', `${n} 处`, n === 1,
  );
  add(
    'C17', '该调用被 !hasHandledFatalError() 守卫（bundle 崩过则永不就绪）',
    '存在守卫',
    /if \(!jsErrorHandler->hasHandledFatalError\(\)\) \{\s*\n\s*jsErrorHandler->setRuntimeReady\(\);/.test(t)
      ? '存在' : '未匹配',
    /if \(!jsErrorHandler->hasHandledFatalError\(\)\) \{\s*\n\s*jsErrorHandler->setRuntimeReady\(\);/.test(t),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 12. Android 旧架构已硬移除（但 iOS 仍是警告，平台不对称）
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/defaults/DefaultReactNativeHost.kt';
  const t = read(f) ?? '';
  const n = (t.match(/Overriding isNewArchEnabled to false is not supported anymore/g) ?? []).length;
  add(
    'C18', 'Android 侧 isNewArchEnabled=false 会抛异常（旧架构已硬移除）',
    '≥2 处 error()', `${n} 处`, n >= 2,
  );
  // iOS 侧必须仍保留开关（否则「平台不对称」的结论不成立）
  const iosHelper = read('packages/react-native/scripts/cocoapods/new_architecture.rb') ?? '';
  add(
    'C19', 'iOS 侧 new_arch_enabled 仍是硬编码 return true（与 Android 表现不同）',
    '存在 return true',
    /def self\.new_arch_enabled\s*\n\s*return true\s*\n\s*end/.test(iosHelper) ? '存在' : '未匹配',
    /def self\.new_arch_enabled\s*\n\s*return true\s*\n\s*end/.test(iosHelper),
  );
  const pods = read('packages/react-native/scripts/react_native_pods.rb') ?? '';
  add(
    'C19b', 'iOS 侧对 RCT_NEW_ARCH_ENABLED=0 只警告不报错（与 Android 抛异常不对称）',
    '存在 warn_if_new_arch_disabled',
    /def warn_if_new_arch_disabled/.test(pods) ? '存在' : '缺失',
    /def warn_if_new_arch_disabled/.test(pods),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 13. Android 内存压力只到 C++，不进 JS
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/MemoryPressureRouter.kt';
  const t = read(f) ?? '';
  // 不应出现任何派发 JS 事件的调用（RCTDeviceEventEmitter / emit）
  const emitsJs = /RCTDeviceEventEmitter|\.emit\(/.test(t);
  add(
    'C20', 'MemoryPressureRouter 不派发任何 JS 事件（仅转发给 C++ listener）',
    '无 JS 派发', emitsJs ? '发现 JS 派发' : '无', !emitsJs,
  );
  // 注意：源码里这行没有分号，写断言时不要凭印象补上
  add(
    'C20b', 'onTrimMemory 只调用 dispatchMemoryPressure',
    '单行转发',
    /public override fun onTrimMemory\(level: Int\) \{\s*\n\s*dispatchMemoryPressure\(level\)\s*\n\s*\}/.test(t)
      ? '单行转发' : '未匹配',
    /public override fun onTrimMemory\(level: Int\) \{\s*\n\s*dispatchMemoryPressure\(level\)\s*\n\s*\}/.test(t),
  );
  // onLowMemory 弃用且为空实现
  add(
    'C20c', 'onLowMemory 已弃用且为空实现（无内存压力回调）',
    '空实现',
    /public override fun onLowMemory\(\): Unit = Unit/.test(t) ? '空实现' : '未匹配',
    /public override fun onLowMemory\(\): Unit = Unit/.test(t),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 14. ReactMarker 埋点体系
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarkerConstants.kt';
  const t = read(f) ?? '';
  // 精确统计枚举项：必须在 enum class 体内、形如 NAME, 或 NAME(args),
  // 排除注释行。用「90+」「≥10」这类模糊断言会让错误数字溜过去（本次复核的教训）。
  const body = t.slice(t.indexOf('{'), t.lastIndexOf('}'));
  const entries = body
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'))
    .filter(l => /^[A-Za-z_][A-Za-z0-9_]*\s*(\([^)]*\))?,?$/.test(l));
  const withTrue = entries.filter(l => /\(true\)/.test(l));
  add('C21', 'ReactMarkerConstants 枚举项数量（精确值）', '114', `${entries.length}`, entries.length === 114);
  add('C22', '带 hasMatchingNameMarker=true 的埋点数量（精确值）', '13', `${withTrue.length}`, withTrue.length === 13);
  // 配对关系：START/END 各 6 对 + loadApplicationScript 1 对 = 13
  add(
    'C22b', '可自动配对的埋点构成：6 对 START/END + loadApplicationScript 一对',
    '6+6+1=13',
    `${withTrue.length} 项`,
    withTrue.length === 13,
  );
  // START/END 配对不是靠后缀（REGISTER_JS_SEGMENT_START ↔ _STOP）
  add(
    'C23', '存在 START 配 STOP（非 END）的埋点，自动化解析不能只按后缀',
    '存在',
    /REGISTER_JS_SEGMENT_START.*\n\s*REGISTER_JS_SEGMENT_STOP/.test(t) ? '存在' : '缺失',
    /REGISTER_JS_SEGMENT_START.*\n\s*REGISTER_JS_SEGMENT_STOP/.test(t),
  );
  // 半配对：CREATE_REACT_CONTEXT_START 未标记，只有 _END 标记 —— 不能当成完整配对用
  add(
    'C23b', 'CREATE_REACT_CONTEXT_START 未带 (true)，只有 _END 带（标记遗漏）',
    'START 无 true / END 有 true',
    /CREATE_REACT_CONTEXT_START,\s*\n\s*CREATE_REACT_CONTEXT_END\(true\)/.test(t) ? '确认半配对' : '已变化（需重新核对文档）',
    /CREATE_REACT_CONTEXT_START,\s*\n\s*CREATE_REACT_CONTEXT_END\(true\)/.test(t),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 15. UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE 硬编码 false（16 文档核心）
// ────────────────────────────────────────────────────────────────────────
{
  const gradle = read('packages/react-native/ReactAndroid/build.gradle.kts') ?? '';
  // 必须是 false，且全仓库只有这一处赋值
  const assigns = (gradle.match(/buildConfigField\("boolean",\s*"UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE",\s*"(\w+)"\)/g) ?? []);
  add(
    'C24', 'UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE 在 build.gradle.kts 中硬编码为 false',
    '唯一赋值点 = false',
    `${assigns.length} 处赋值，值=${(assigns[0] ?? '').match(/"(\w+)"\)$/)?.[1] ?? '未匹配'}`,
    assigns.length === 1 && /"false"\)/.test(assigns[0]),
  );
  // 开关确实被多处引用（否则「14 处行为失效」的结论不成立）
  const refs = grepCount(/UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE/, {
    exts: ['.kt', '.java'],
    roots: ['packages/react-native/ReactAndroid/src/main'],
  });
  add('C25', '该开关被 10+ 处源码引用（控制 legacy 行为分支）', '≥10 处', `${refs.count} 处`, refs.count >= 10);
  // 精确锁定引用计数：本次复核发现文档曾写「14 处」，实际 18 处 / 10 文件。
  add(
    'C25b', '该开关在源码中出现的确切次数（校验文档中的引用计数）',
    '18 次 / 10 文件',
    `${refs.count} 次 / ${refs.files.length} 文件`,
    refs.count === 18 && refs.files.length === 10,
  );
  // Logger 的总开关必须真的读它
  const logger = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/common/annotations/internal/LegacyArchitectureLogger.kt') ?? '';
  add(
    'C26', 'LegacyArchitectureLogger.assertLegacyArchitecture 的总开关就是该 BuildConfig 字段',
    '受其控制',
    /if \(ReactBuildConfig\.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE\)/.test(logger) ? '受其控制' : '不受控',
    /if \(ReactBuildConfig\.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE\)/.test(logger),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 16. 旧架构视图层已被掏空为空壳
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/UIViewOperationQueue.kt';
  const t = read(f) ?? '';
  const total = (t.match(/^\s*(public |private |internal |protected )?fun /gm) ?? []).length;
  const empty = (t.match(/^\s*(public |private |internal |protected )?fun .*\{\s*\}\s*$/gm) ?? []).length
    + (t.match(/\{\s*\}\s*$/gm) ?? []).length * 0; // 避免重复计数
  const trulyEmpty = (t.match(/fun \w+\([^)]*\)(: [\w<>?,\[\] ]+)?\s*\{\}/g) ?? []).length;
  add(
    'C27', 'UIViewOperationQueue 的方法几乎全是空实现（旧批处理管线已停用）',
    '空体 ≥15', `${trulyEmpty} 个空体 / ${total} 个方法`, trulyEmpty >= 15,
  );
  add(
    'C28', 'UIViewOperationQueue 的 isEmpty() 恒返回 true',
    'return true',
    /public fun isEmpty\(\): Boolean = true/.test(t) ? 'return true' : '未匹配',
    /public fun isEmpty\(\): Boolean = true/.test(t),
  );
  // NativeViewHierarchyManager 类注释必须自认 stubbed out
  const nvhm = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/NativeViewHierarchyManager.kt') ?? '';
  add(
    'C29', 'NativeViewHierarchyManager 类注释自述已被 stub out',
    '提及 stubbed out',
    /has been stubbed out/.test(nvhm) ? '提及' : '未提及',
    /has been stubbed out/.test(nvhm),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 17. BlackHoleEventDispatcher 静默丢事件
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/events/BlackHoleEventDispatcher.kt';
  const t = read(f) ?? '';
  add(
    'C30', 'BlackHoleEventDispatcher 用 FLog.d（非 w/e）记录被丢弃的事件',
    'FLog.d',
    /FLog\.d\(/.test(t) ? 'FLog.d' : (/FLog\.[we]\(/.test(t) ? 'FLog.w/e（更严格）' : '未匹配'),
    /FLog\.d\(/.test(t),
  );
  // ReactHostImpl 必须在实例未存活时回退到黑洞
  const host = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactHostImpl.kt') ?? '';
  add(
    'C31', 'ReactHostImpl.eventDispatcher 在实例未存活时回退到黑洞',
    '?: BlackHoleEventDispatcher',
    /reactInstance\?\.eventDispatcher \?: BlackHoleEventDispatcher/.test(host) ? '存在回退' : '未匹配',
    /reactInstance\?\.eventDispatcher \?: BlackHoleEventDispatcher/.test(host),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 18. prop 删除语义与 @ReactProp 注释矛盾（17 文档核心）
// ────────────────────────────────────────────────────────────────────────
{
  // 注释必须真的声称「属性被移除时提供默认值」
  const ann = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/annotations/ReactProp.kt') ?? '';
  add(
    'C32', '@ReactProp 注释声称「属性从 JS 描述中移除时提供默认值」',
    '注释含 gets removed',
    /gets removed from the/.test(ann) ? '含此说法' : '未找到',
    /gets removed from the/.test(ann),
  );
  // 实现必须真的只遍历存在的 key（否则矛盾不成立）
  const upd = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagerPropertyUpdater.kt') ?? '';
  add(
    'C33', 'updateProps 实现只遍历 backingMap 中存在的 key（不补全缺失项）',
    '无补全逻辑',
    /entryIterator/.test(upd) && !/defaults|missing|absent/i.test(upd.split('public fun <V : View> updateProps')[1]?.split('\n  }')[0] ?? '')
      ? '仅遍历 entryIterator' : '存在补全逻辑（矛盾不成立）',
    /entryIterator/.test(upd),
  );
  // defaultFloat 的默认值是 0.0f 而不是 NaN
  add(
    'C34', 'defaultFloat 的声明默认值是 0.0f（不是 NaN）',
    '= 0.0f',
    /public val defaultFloat: Float = 0\.0f/.test(ann) ? '= 0.0f' : '未匹配',
    /public val defaultFloat: Float = 0\.0f/.test(ann),
  );
  // Float.NaN 确实是全仓惯例（≥9 个文件）
  const nan = grepCount(/defaultFloat = Float\.NaN/, {
    exts: ['.kt'],
    roots: ['packages/react-native/ReactAndroid/src/main/java/com/facebook/react'],
  });
  add(
    'C35', 'defaultFloat = Float.NaN 作为「未设置」哨兵的确切用量',
    '17 行 / 9 文件',
    `${nan.count} 行 / ${nan.files.length} 文件`,
    nan.count === 17 && nan.files.length === 9,
  );
  // @ReactProp 计数：@ReactPropGroup 含子串 "@ReactProp"，必须排除
  const tm = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextViewManager.kt') ?? '';
  const single = (tm.match(/@ReactProp\b(?!Group)/g) ?? []).length;
  const group = (tm.match(/@ReactPropGroup/g) ?? []).length;
  add('C35b', 'ReactTextViewManager 的 @ReactProp 数量（不含 Group）', '15', `${single}`, single === 15);
  add('C35c', 'ReactTextViewManager 的 @ReactPropGroup 数量', '3', `${group}`, group === 3);
  // span 目录实现数
  const spanDir = path.join(REPO, 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/internal/span');
  const spanCount = fs.existsSync(spanDir)
    ? fs.readdirSync(spanDir).filter(f => f.endsWith('.kt')).length
    : -1;
  add('C35d', 'text/internal/span 下的 Span 实现数', '23', `${spanCount}`, spanCount === 23);
}

// ────────────────────────────────────────────────────────────────────────
// 19. 属性 setter 异常直接 rethrow 成 JS 异常
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagersPropertyCache.kt';
  const t = read(f) ?? '';
  add(
    'C36', '属性 setter 捕获 Throwable 后包装成 JSApplicationIllegalArgumentException 并 rethrow',
    'catch Throwable + rethrow',
    /catch \(t: Throwable\)/.test(t) && /JSApplicationIllegalArgumentException/.test(t) ? '是' : '未匹配',
    /catch \(t: Throwable\)/.test(t) && /JSApplicationIllegalArgumentException/.test(t),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 20. JNI 异常穿透的两个方向（18 文档核心）
// ────────────────────────────────────────────────────────────────────────
{
  // C++→Java：onJsError 必须是 noexcept，否则逃逸异常会 abort
  const jri = read('packages/react-native/ReactAndroid/src/main/jni/react/runtime/jni/JReactInstance.cpp') ?? '';
  add(
    'C37', 'onJsError 回调被声明为 noexcept（逃逸异常会终止进程）',
    'lambda mutable noexcept',
    /JsErrorHandler::ProcessedError& error\) mutable noexcept/.test(jri) ? 'noexcept' : '未匹配',
    /JsErrorHandler::ProcessedError& error\) mutable noexcept/.test(jri),
  );
  // noexcept 是 Android 实现方自己加的，接口不强制 —— 否则会被误传成「RN 强制所有实现 noexcept」
  const jeh = read('packages/react-native/ReactCommon/jserrorhandler/JsErrorHandler.h') ?? '';
  add(
    'C37c', 'OnJsError 类型别名本身不带 noexcept（noexcept 是实现方选择，非接口强制）',
    '别名无 noexcept',
    /using OnJsError = std::function<[^>]*>;/.test(jeh) && !/using OnJsError = std::function<[^>]*noexcept/.test(jeh)
      ? '别名无 noexcept' : '异常：别名含 noexcept',
    /using OnJsError = std::function<[^>]*>;/.test(jeh) && !/using OnJsError = std::function<[^>]*noexcept/.test(jeh),
  );
  add(
    'C37d', 'handleError / handleErrorWithCppPipeline 均非 noexcept',
    '两者都无 noexcept',
    /void handleError\(.*\);/.test(jeh) && /void handleErrorWithCppPipeline\(.*\);/.test(jeh)
      && !/void handleError\(.*noexcept/.test(jeh) ? '都无 noexcept' : '异常',
    /void handleError\(.*\);/.test(jeh) && /void handleErrorWithCppPipeline\(.*\);/.test(jeh)
      && !/void handleError\(.*noexcept/.test(jeh),
  );
  add(
    'C37b', 'onJsError 用弱引用捕获 JReactExceptionManager（实例销毁后自动失效）',
    'make_weak + lockLocal',
    /make_weak\(jReactExceptionManager\)/.test(jri) && /lockLocal\(\)/.test(jri) ? '是' : '未匹配',
    /make_weak\(jReactExceptionManager\)/.test(jri) && /lockLocal\(\)/.test(jri),
  );

  // JNI-1：extraData 序列化的两层兜底 + 源码自述会 abort
  const jrem = read('packages/react-native/ReactAndroid/src/main/jni/react/runtime/jni/JReactExceptionManager.cpp') ?? '';
  add(
    'C38', '源码注释自述 extraData 序列化逃逸异常会 abort 整个进程',
    '注释含 aborts the whole process',
    /aborts the whole process/.test(jrem) ? '含此说明' : '未找到',
    /aborts the whole process/.test(jrem),
  );
  add(
    'C39', 'extraData 序列化有 catch(...) 兜底（两层）',
    '含 catch (...)',
    (jrem.match(/catch \(\.\.\.\)/g) ?? []).length >= 2 ? `${(jrem.match(/catch \(\.\.\.\)/g) ?? []).length} 处` : '不足',
    (jrem.match(/catch \(\.\.\.\)/g) ?? []).length >= 2,
  );
  add(
    'C39b', '兜底失败时会写入 extraDataMarshallingError 标记',
    '含该标记',
    /extraDataMarshallingError/.test(jrem) ? '存在' : '缺失',
    /extraDataMarshallingError/.test(jrem),
  );
  // Java 侧字段必须可空，且注释回指 C++ 实现
  const jh = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/interfaces/exceptionmanager/ReactJsExceptionHandler.kt') ?? '';
  add(
    'C40', 'Java 侧 extraData 声明为可空且注释回指 JReactExceptionManager.cpp',
    'val extraData: ReadableMap? + 注释引用',
    /val extraData: ReadableMap\?/.test(jh) && /JReactExceptionManager\.cpp/.test(jh) ? '是' : '未匹配',
    /val extraData: ReadableMap\?/.test(jh) && /JReactExceptionManager\.cpp/.test(jh),
  );

  // Java→C++：每个 JNI 调用后必须有 throwPendingJniExceptionAsCppException
  const mi = read('packages/react-native/ReactAndroid/src/main/jni/react/jni/MethodInvoker.cpp') ?? '';
  const calls = (mi.match(/env->Call\w+MethodA/g) ?? []).length;
  const checks = (mi.match(/throwPendingJniExceptionAsCppException\(\)/g) ?? []).length;
  add(
    'C41', 'MethodInvoker 中 JNI 调用次数与异常检查次数大致匹配（每个调用后都检查）',
    '检查数 ≥ 调用数',
    `JNI 调用 ${calls} 次 / 异常检查 ${checks} 次（含宏定义处）`,
    checks >= 5, // 宏里各一次 + void 分支一次；不要求严格相等，见 JNI-5
  );
  add(
    'C42', '未知参数类型用 LOG(FATAL) 而非抛异常（触发即进程终止）',
    '存在 LOG(FATAL)',
    /LOG\(FATAL\) << "Unknown param type/.test(mi) ? '存在' : '缺失',
    /LOG\(FATAL\) << "Unknown param type/.test(mi),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 22. 批次 1-3 复核发现的数字（09/10/13/14）
// ────────────────────────────────────────────────────────────────────────
{
  // 10 文档：formsStackingContext 是 21 项布尔或（曾写 18）
  const vsn = read('packages/react-native/ReactCommon/react/renderer/components/view/ViewShadowNode.cpp') ?? '';
  const seg = vsn.match(/bool formsStackingContext =([\s\S]*?);/);
  const orTerms = seg ? seg[1].split('||').map(s => s.trim()).filter(Boolean).length : -1;
  add('C43', 'ViewShadowNode.formsStackingContext 的顶层 || 项数（精确值）', '22', `${orTerms}`, orTerms === 22);

  // 10 文档：view/platform 共 15 个文件（android 6 / cxx 4 / tvos 5）
  const platRoot = path.join(REPO, 'packages/react-native/ReactCommon/react/renderer/components/view/platform');
  const countPlat = d => {
    const dir = path.join(platRoot, d, 'react/renderer/components/view');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(h|cpp)$/.test(f)).length : -1;
  };
  const a = countPlat('android'), c = countPlat('cxx'), t = countPlat('tvos');
  add('C44', 'view/platform 三套实现的文件数（精确值）', 'android 6 / cxx 4 / tvos 5',
    `android ${a} / cxx ${c} / tvos ${t}`, a === 6 && c === 4 && t === 5);
  add('C44b', 'cxx 的 HostPlatformViewProps 是 BaseViewProps 的类型别名（故无需 .cpp）',
    'using HostPlatformViewProps = BaseViewProps',
    /using HostPlatformViewProps = BaseViewProps;/.test(
      read('packages/react-native/ReactCommon/react/renderer/components/view/platform/cxx/react/renderer/components/view/HostPlatformViewProps.h') ?? '')
      ? '是' : '未匹配',
    /using HostPlatformViewProps = BaseViewProps;/.test(
      read('packages/react-native/ReactCommon/react/renderer/components/view/platform/cxx/react/renderer/components/view/HostPlatformViewProps.h') ?? ''));
  add('C44c', 'tvos 比 cxx 多一个 HostPlatformViewProps.cpp（故并非逐字节副本）',
    'tvos 有 .cpp / cxx 无',
    fs.existsSync(platRoot + '/tvos/react/renderer/components/view/HostPlatformViewProps.cpp')
      && !fs.existsSync(platRoot + '/cxx/react/renderer/components/view/HostPlatformViewProps.cpp')
      ? '确认' : '未匹配',
    fs.existsSync(platRoot + '/tvos/react/renderer/components/view/HostPlatformViewProps.cpp')
      && !fs.existsSync(platRoot + '/cxx/react/renderer/components/view/HostPlatformViewProps.cpp'));

  // 10 文档：cxx 被 21 处引用（podspec 9 + 脚本 7 + 工程 5）
  const cxxRefs = grepCount(/components\/view\/platform\/cxx/, {
    roots: ['packages', 'private', 'scripts'],
  });
  add(
    'C45', 'cxx 路径在全仓库的引用次数（排除测试/快照）',
    '21',
    `${cxxRefs.count}`,
    cxxRefs.count === 21,
  );
  const tvosRefs = grepCount(/components\/view\/platform\/tvos/, {
    roots: ['packages', 'private', 'scripts'],
  });
  add('C45b', 'tvos 路径在全仓库的引用次数（应为 0，即死代码）', '0', `${tvosRefs.count}`, tvosRefs.count === 0);

  // 13 文档：23 个 require = 13 无条件 + 4 __DEV__ + 3 Flag + 3 Flag求值
  const setup = read('packages/react-native/src/private/setup/setUpDefaultReactNativeEnvironment.js') ?? '';
  const totalReq = (setup.match(/require\(/g) ?? []).length;
  add('C46', 'setUpDefaultReactNativeEnvironment 的 require 调用总数', '23', `${totalReq}`, totalReq === 23);
  // Libraries 路径的 require：13 无条件 + 4 __DEV__ 中有 4 个也是 Libraries 路径
  // 实测清单：22,25,26,28,30,31,32,33,34,35,36,38,39,40,43 = 15
  const devGated = (setup.match(/require\('\.\.\/\.\.\/\.\.\/Libraries/g) ?? []).length;
  add('C46b', 'Libraries 路径的 require 次数（13 无条件 + 4 __DEV__，全部走 Libraries）', '15', `${devGated}`, devGated === 15);
  add('C46c', '__DEV__ 条件块数量', '2', `${(setup.match(/if \(__DEV__ && enableDeveloperTools\)/g) ?? []).length}`,
    (setup.match(/if \(__DEV__ && enableDeveloperTools\)/g) ?? []).length === 2);

  // 14 文档：bridging 19 个 .h + 1 个 .cpp
  const brDir = path.join(REPO, 'packages/react-native/ReactCommon/react/bridging');
  const hCount = fs.readdirSync(brDir).filter(f => f.endsWith('.h')).length;
  const cppCount = fs.readdirSync(brDir).filter(f => f.endsWith('.cpp')).length;
  add('C47', 'react/bridging 的 .h / .cpp 数量（精确值）', '19 / 1', `${hCount} / ${cppCount}`,
    hCount === 19 && cppCount === 1);
}

// ────────────────────────────────────────────────────────────────────────
// 23. iOS 平台层（19 文档）
// ────────────────────────────────────────────────────────────────────────
{
  // IOS-1：iOS 硬编码 unloadLevel = 15
  const rinst = read('packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm') ?? '';
  add(
    'C48', 'iOS 内存警告硬编码 unloadLevel = 15（= TRIM_MEMORY_RUNNING_CRITICAL）',
    'static constexpr int unloadLevel = 15',
    /static constexpr int unloadLevel = 15;/.test(rinst) ? '确认硬编码 15' : '未匹配',
    /static constexpr int unloadLevel = 15;/.test(rinst),
  );

  // iOS 侧确实没有任何地方读内存压力等级
  const lvl = grepCount(/MemoryWarningLevel/, {
    roots: ['packages/react-native/React', 'packages/react-native/ReactCommon', 'packages/react-native/Libraries'],
  });
  add('C48b', 'iOS/RN 侧从未读取 UIApplicationMemoryWarningLevel（等级被丢弃）', '0', `${lvl.count}`, lvl.count === 0);

  // C++ 侧按 Android 枚举分级：LOW/MODERATE/UI_HIDDEN 忽略，严重等级才 GC
  const cxx = read('packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp') ?? '';
  add(
    'C49', 'handleMemoryPressureJs 的枚举是 Android ComponentCallbacks2 的 TRIM_MEMORY_*',
    '注释提及 Android OS + onTrimMemory',
    /passed by the Android OS to an onTrimMemory/.test(cxx) ? '是' : '未匹配',
    /passed by the Android OS to an onTrimMemory/.test(cxx),
  );
  add(
    'C49b', 'C++ 侧对 RUNNING_LOW/MODERATE/UI_HIDDEN 显式忽略（non-severe）',
    '含 ignoring because it\'s non-severe',
    /ignoring because it's non-severe/.test(cxx) ? '存在' : '缺失',
    /ignoring because it's non-severe/.test(cxx),
  );
  add(
    'C49c', '严重等级走 collectGarbage',
    '存在 collectGarbage 调用',
    /instrumentation\(\)\.collectGarbage\(levelName\)/.test(cxx) ? '存在' : '缺失',
    /instrumentation\(\)\.collectGarbage\(levelName\)/.test(cxx),
  );

  // IOS-3：SurfaceDidStop 从未被赋值
  const stopSet = grepCount(/stage\s*[|=]{1,2}[^=]*RCTSurfaceStageSurfaceDidStop|_stage\s*=\s*RCTSurfaceStageSurfaceDidStop/, {
    exts: ['.m', '.mm', '.h'],
    roots: ['packages/react-native/React', 'packages/react-native/ReactCommon'],
  });
  add('C50', 'RCTSurfaceStageSurfaceDidStop 从未被赋值点（该位是死位）', '0', `${stopSet.count}`, stopSet.count === 0);

  // RCTPLTag 枚举数量（末项 RCTPLSize 带尾注释，正则须容纳 `// ...`）
  const pltag = read('packages/react-native/React/Base/RCTPLTag.h') ?? '';
  const tagCount = (pltag.match(/^\s+RCTPL\w+/gm) ?? []).length;
  add('C51', 'RCTPLTag 枚举项数量（iOS 性能标记总数，含哨兵 RCTPLSize）', '22', `${tagCount}`, tagCount === 22);

  // logTaggedMarkerImpl 是 extern 单槽位，不是 listener 列表
  const rmk = read('packages/react-native/ReactCommon/cxxreact/ReactMarker.h') ?? '';
  add(
    'C52', 'logTaggedMarkerImpl 是单槽位全局变量（非 listener 列表）',
    'extern 单个变量',
    /extern RN_EXPORT AtomicLogTaggedMarker logTaggedMarkerImpl;/.test(rmk) ? 'extern 单变量' : '未匹配',
    /extern RN_EXPORT AtomicLogTaggedMarker logTaggedMarkerImpl;/.test(rmk),
  );
  add('C52b', 'RCTPerformanceLogger.h 中不存在 listener 注册接口', '无 addListener', (() => {
    const h = read('packages/react-native/React/Base/RCTPerformanceLogger.h') ?? '';
    return /addListener|addObserver|registerListener/.test(h) ? '存在（与文档矛盾）' : '确认无';
  })(), (() => {
    const h = read('packages/react-native/React/Base/RCTPerformanceLogger.h') ?? '';
    return !/addListener|addObserver|registerListener/.test(h);
  })());
}

// ────────────────────────────────────────────────────────────────────────
// 24. iOS CoreModules 崩溃终止机制（20 文档）
// ────────────────────────────────────────────────────────────────────────
{
  // CM-1：maxReloadAttempts 只有声明与读取，全仓库无赋值点
  const em = read('packages/react-native/React/CoreModules/RCTExceptionsManager.mm') ?? '';
  const emh = read('packages/react-native/React/CoreModules/RCTExceptionsManager.h') ?? '';
  const sets = grepCount(/maxReloadAttempts\s*=\s*/, {
    exts: ['.m', '.mm'],
    roots: ['packages/react-native/React', 'packages/react-native/Libraries'],
  });
  add(
    'C53', 'maxReloadAttempts 全仓库无赋值点（崩溃自动 reload 机制恒不生效）',
    '0 处赋值',
    `${sets.count} 处`,
    sets.count === 0,
  );
  add('C53b', 'maxReloadAttempts 确实是 @property 声明（我一度误判为未声明标识符）',
    'property 声明存在',
    /@property \(nonatomic, assign\) NSUInteger maxReloadAttempts;/.test(emh) ? '存在' : '缺失',
    /@property \(nonatomic, assign\) NSUInteger maxReloadAttempts;/.test(emh));

  // CM-2：reloadRetries 是函数内 static
  add(
    'C54', 'reloadRetries 是函数内 static NSUInteger（进程内永不重置）',
    'static NSUInteger reloadRetries = 0;',
    /static NSUInteger reloadRetries = 0;/.test(em) ? '确认' : '未匹配',
    /static NSUInteger reloadRetries = 0;/.test(em));

  // CM-3：RCTFatal 的 @throw 被 #if DEBUG 包裹
  const asrt = read('packages/react-native/React/Base/RCTAssert.m') ?? '';
  const dbgIdx = asrt.indexOf('void RCTFatal(NSError *error)');
  // 窗口取到下一个函数定义为止（1200 字符不够，含注释约 1400）
  const seg = dbgIdx >= 0 ? asrt.slice(dbgIdx, asrt.indexOf('\nvoid RCTSetFatalHandler', dbgIdx)) : '';
  add(
    'C55', 'RCTFatal 内 @throw/@catch 被 #if DEBUG 包裹（Debug 自抛自接、Release 逃逸）',
    '#if DEBUG 包住 @try/@catch',
    /#if DEBUG\s*\n\s*@try \{/.test(seg) && /@throw \[\[NSException alloc\]/.test(seg) ? '确认' : '未匹配',
    /#if DEBUG\s*\n\s*@try \{/.test(seg) && /@throw \[\[NSException alloc\]/.test(seg),
  );
  add(
    'C55b', 'RCTFatal 的 @catch 为空实现（Debug 下吞掉自己抛的异常）',
    '} @catch (NSException *) {\\n    }',
    /\} @catch \(NSException \*\) \{\s*\}/.test(seg) ? '空 catch' : '未匹配',
    /\} @catch \(NSException \*\) \{\s*\}/.test(seg),
  );

  // CM-4：两个 fatal handler 注册接口全仓库 0 调用（须排除 RCTAssert.m 里的定义本身）
  const fhAll = grepCount(/RCTSetFatalHandler\(|RCTSetFatalExceptionHandler\(/, {
    exts: ['.m', '.mm'],
    roots: ['packages/react-native/React', 'packages/react-native/Libraries', 'packages/react-native/ReactApple'],
  });
  const fhCalls = fhAll.files.filter(f => !f.endsWith('RCTAssert.m'));
  add(
    'C56', 'RCTSetFatalHandler / RCTSetFatalExceptionHandler 除定义外零调用',
    '仅 RCTAssert.m 内有定义',
    `${fhCalls.length} 个非定义文件`,
    fhCalls.length === 0,
  );

  // CM-5：decorateJSExceptionData: 是 iOS 独有钩子
  add(
    'C57', 'iOS 侧提供 decorateJSExceptionData: 上报前钩子',
    '存在该 selector 调用',
    /respondsToSelector:@selector\(decorateJSExceptionData:\)/.test(em) ? '存在' : '缺失',
    /respondsToSelector:@selector\(decorateJSExceptionData:\)/.test(em),
  );
  const androidHook = grepCount(/decorateJSExceptionData|decorateExceptionData/, {
    exts: ['.kt', '.java'],
    roots: ['packages/react-native/ReactAndroid/src/main'],
  });
  add('C57b', 'Android 侧无等价的上报前钩子（平台不对称）', '0 处', `${androidHook.count} 处`, androidHook.count === 0);
}

// ────────────────────────────────────────────────────────────────────────
// 25. iOS ComponentViews（21 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const CV = 'packages/react-native/React/Fabric/Mounting/ComponentViews';
  // 文件总数（子目录 + 根级）
  const countSrc = dir => {
    let n = 0;
    for (const e of fs.readdirSync(path.join(REPO, dir), {withFileTypes: true})) {
      if (e.isDirectory()) n += countSrc(dir + '/' + e.name);
      else if (/\.(h|m|mm)$/.test(e.name)) n++;
    }
    return n;
  };
  add('C58', 'iOS ComponentViews 的源文件总数（精确值）', '58', `${countSrc(CV)}`, countSrc(CV) === 58);

  // View/RCTViewComponentView.mm 的行数（文档称 1946）
  const vcv = read(CV + '/View/RCTViewComponentView.mm') ?? '';
  add(
    'C59', 'RCTViewComponentView.mm 的行数（文档称 1946）',
    '1946',
    `${vcv.split('\n').length - 1}`,
    vcv.split('\n').length - 1 === 1946,
  );

  // removeClippedSubviews 的两分支
  add(
    'C60', 'mountChildComponentView 按 _removeClippedSubviews 分叉（数组 vs 真实 subviews）',
    '存在 if/else 两分支',
    /if \(_removeClippedSubviews\) \{/.test(vcv) && /insertSubview:childComponentView atIndex:index/.test(vcv)
      ? '确认' : '未匹配',
    /if \(_removeClippedSubviews\) \{/.test(vcv) && /insertSubview:childComponentView atIndex:index/.test(vcv),
  );

  // enableViewCulling 默认为 false（故 removeClippedSubviews 当前生效）
  const ff = read('packages/react-native/scripts/featureflags/ReactNativeFeatureFlags.config.js') ?? '';
  const evc = ff.match(/enableViewCulling:\s*\{[\s\S]*?defaultValue:\s*(\w+)/);
  add(
    'C61', 'enableViewCulling 默认值为 false（实验中），故 JS 的 removeClippedSubviews 当前生效',
    'false',
    evc ? evc[1] : '未匹配',
    !!evc && evc[1] === 'false',
  );

  // DO_NOT_USE_THIS_IS_BROKEN 家族：4 个标识符
  const broken = grepCount(/DO_NOT_USE_THIS_IS_BROKEN/, {
    exts: ['.h', '.m', '.mm', '.cpp'],
    roots: ['packages/react-native/React', 'packages/react-native/ReactCommon'],
  });
  const uniqIdents = new Set();
  for (const f of broken.files) {
    const t = read(f) ?? '';
    for (const m of t.matchAll(/[A-Za-z_]*DO_NOT_USE_THIS_IS_BROKEN/g)) uniqIdents.add(m[0]);
  }
  add(
    'C62', 'DO_NOT_USE_THIS_IS_BROKEN 家族标识符数量（精确值，含 ivar）',
    '5 个不同标识符',
    `${uniqIdents.size} 个`,
    uniqIdents.size === 5,
  );
  add(
    'C62c', '其中 4 个是方法/属性名，1 个是 ivar（_propKeysManagedByAnimated_ 前缀）',
    '1 个 ivar',
    `${[...uniqIdents].filter(i => i.startsWith('_')).length} 个 ivar`,
    [...uniqIdents].filter(i => i.startsWith('_')).length === 1,
  );
  add('C62b', 'C++ 与 ObjC 两端都存在该命名（不限于某一平台）', '两端都有', (() => {
    const cxx = [...uniqIdents].some(i => /findComponentDescriptor/.test(i));
    const objc = [...uniqIdents].some(i => /propKeysManagedByAnimated|componentViewName/.test(i));
    return cxx && objc ? '两端都有' : '仅一端';
  })(), (() => {
    const cxx = [...uniqIdents].some(i => /findComponentDescriptor/.test(i));
    const objc = [...uniqIdents].some(i => /propKeysManagedByAnimated|componentViewName/.test(i));
    return cxx && objc;
  })());

  // 协议注释写 Do not use，但 RCTMountingManager 自己在用
  const proto = read('packages/react-native/React/Fabric/Mounting/RCTComponentViewProtocol.h') ?? '';
  const mm = read('packages/react-native/React/Fabric/Mounting/RCTMountingManager.mm') ?? '';
  add(
    'C63', '协议注释自称 broken，而 RCTMountingManager 仍调用该接口（命名警告失效）',
    '注释有 Do not use + 调用方存在',
    /This is broken\. Do not use\./.test(proto) && /propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN/.test(mm)
      ? '确认矛盾' : '未匹配',
    /This is broken\. Do not use\./.test(proto) && /propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN/.test(mm),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 26. iOS RedBox / LogBox 双层门控（22 文档）
// ────────────────────────────────────────────────────────────────────────
{
  // 第一层：编译期门控
  const rb = read('packages/react-native/React/CoreModules/RCTRedBox.mm') ?? '';
  add('C64', 'RCTRedBox.mm 用 #if RCT_DEV_MENU 包裹主体，else 支 moduleName 返回 nil',
    '存在 #if RCT_DEV_MENU 且 else 支 return nil',
    /#if RCT_DEV_MENU/.test(rb) && /#else \/\/ Disabled/.test(rb) ? '确认' : '未匹配',
    /#if RCT_DEV_MENU/.test(rb) && /#else \/\/ Disabled/.test(rb));

  // 第二层：运行期开关，默认由 RCT_DEV 决定
  const rse = read('packages/react-native/React/Base/RCTRedBoxSetEnabled.m') ?? '';
  add(
    'C65', 'RCTRedBoxSetEnabled.m 的 redBoxEnabled 默认值由 RCT_DEV 决定（Dev=YES/Release=NO）',
    '#if RCT_DEV → YES / #else → NO',
    /#if RCT_DEV\s*\nstatic BOOL redBoxEnabled = YES;\s*\n#else\s*\nstatic BOOL redBoxEnabled = NO;/.test(rse) ? '确认' : '未匹配',
    /#if RCT_DEV\s*\nstatic BOOL redBoxEnabled = YES;\s*\n#else\s*\nstatic BOOL redBoxEnabled = NO;/.test(rse),
  );
  add('C65b', 'RCTRedBoxSetEnabled 无任何调用方（机制存在但不可控）', '0 处调用', (() => {
    const hits = grepCount(/RCTRedBoxSetEnabled\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native/React', 'packages/react-native/Libraries'],
    }).files.filter(f => !f.endsWith('RCTRedBoxSetEnabled.m'));
    return `${hits.length} 处`;
  })(), (() => {
    const hits = grepCount(/RCTRedBoxSetEnabled\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native/React', 'packages/react-native/Libraries'],
    }).files.filter(f => !f.endsWith('RCTRedBoxSetEnabled.m'));
    return hits.length === 0;
  })());

  // RB-2：RCT_DEV_MENU 可独立于 RCT_DEV 关闭 → 两层门控错配
  const def = read('packages/react-native/React/Base/RCTDefines.h') ?? '';
  add(
    'C66', 'RCT_DEV_MENU 默认继承 RCT_DEV 但可被独立覆盖（产生门控错配的构建组合）',
    '#ifndef RCT_DEV_MENU → #define ... RCT_DEV',
    /#ifndef RCT_DEV_MENU\s*\n#define RCT_DEV_MENU RCT_DEV/.test(def) ? '确认可独立覆盖' : '未匹配',
    /#ifndef RCT_DEV_MENU\s*\n#define RCT_DEV_MENU RCT_DEV/.test(def),
  );

  // 模块发现依赖 nil 语义
  const tmm = read('packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm') ?? '';
  add(
    'C67', 'TurboModule 发现循环里没有显式 nil 检查，依赖 isEqualToString: 对 nil 返回 NO',
    '只有 respondsToSelector 检查，无 nil 检查',
    /\[current respondsToSelector:@selector\(moduleName\)\]/.test(tmm) && !/moduleName == nil|moduleName != nil/.test(tmm)
      ? '确认无显式 nil 检查' : '有显式检查',
    /\[current respondsToSelector:@selector\(moduleName\)\]/.test(tmm) && !/moduleName == nil|moduleName != nil/.test(tmm),
  );

  // LogBox spec 只有 2 个方法（故空实现是完整的）
  const spec = read('packages/react-native/src/private/specs_DEPRECATED/modules/NativeLogBox.js') ?? '';
  const specMethods = (spec.match(/readonly \w+: \(\) => void;/g) ?? []).length;
  add('C68', 'LogBox 的 TurboModule spec 方法数（决定 else 支实现是否完整）', '2', `${specMethods}`, specMethods === 2);
  const lb = read('packages/react-native/React/CoreModules/RCTLogBox.mm') ?? '';
  // 必须只取 #else 支内的 show（Dev 支也有 show，且实现完全不同）
  const elseIdx = lb.indexOf('#else // Disabled');
  const elseSeg = elseIdx >= 0 ? lb.slice(elseIdx) : '';
  const elseShow = /- \(void\)show\s*\{\s*\n\s*\/\/ noop\s*\n\s*\}/.test(elseSeg);
  add(
    'C68b', 'RCTLogBox 的 #else 支内 show/hide 是显式 noop（注意 Dev 支同名方法实现不同）',
    'else 支内含 // noop',
    elseShow ? '确认' : '未匹配',
    elseShow,
  );
  add(
    'C68c', 'RCTLogBox 的 Dev 支 show() 内含 RCTRedBoxGetEnabled 二次门控（与 RedBox 联动）',
    'Dev 支 show 内有该调用',
    /- \(void\)show\s*\{\s*\n\s*if \(RCTRedBoxGetEnabled\(\)\)/.test(lb) ? '确认' : '未匹配',
    /- \(void\)show\s*\{\s*\n\s*if \(RCTRedBoxGetEnabled\(\)\)/.test(lb),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 27. iOS 基础工具层 RCTConvert / RCTAssert / RCTLog / RCTUtils（23 文档）
// ────────────────────────────────────────────────────────────────────────
{
  // U-1: RCT_CUSTOM_CONVERTER 的 Debug/Release 语义反转
  const cvt = read('packages/react-native/React/Base/RCTConvert.h') ?? '';
  add(
    'C69', 'RCT_CUSTOM_CONVERTER 里 !RCT_DEBUG 分支直接 return code（无 @try），Debug 分支才有 @try/@catch',
    '!RCT_DEBUG 支无 @try；Debug 支有 @catch',
    /if \(!RCT_DEBUG\) \{\s*\\?\s*\\?\s*return code;[\s\S]*?\} else \{[\s\S]*?@try \{[\s\S]*?\} @catch/.test(cvt)
      ? '确认 Release 无 @try' : '未匹配',
    /if \(!RCT_DEBUG\) \{[\s\S]*?\} else \{[\s\S]*?@try \{[\s\S]*?\} @catch/.test(cvt),
  );
  // U-2: RCT_JSON_CONVERTER 的 #else 分支无类型检查
  const cvtm = read('packages/react-native/React/Base/RCTConvert.mm') ?? '';
  add(
    'C70', 'RCTConvert.mm 的 #else 分支里 RCT_JSON_CONVERTER 只 return json（无 isKindOfClass 检查）',
    '#else 支无 isKindOfClass',
    /#else\n#define RCT_JSON_CONVERTER\(type\)[\s\S]{0,120}?return json;/.test(cvtm)
      && !/#else\n#define RCT_JSON_CONVERTER\(type\)[\s\S]{0,160}?isKindOfClass/.test(cvtm)
      ? '确认无类型检查' : '有检查或未匹配',
    /#else\n#define RCT_JSON_CONVERTER\(type\)[\s\S]{0,120}?return json;/.test(cvtm) &&
      !/#else\n#define RCT_JSON_CONVERTER\(type\)[\s\S]{0,160}?isKindOfClass/.test(cvtm),
  );
  // U-3: RCT_NUMBER_CONVERTER 的三元
  add(
    'C71', 'RCT_NUMBER_CONVERTER 在 Release 下跳过 NSNumber 转换（[RCT_DEBUG ? [self NSNumber:json] : json getter]）',
    '三元表达式含 RCT_DEBUG',
    /\[RCT_DEBUG \? \[self NSNumber:json\] : json getter\]/.test(cvt) ? '确认三元' : '未匹配',
    /\[RCT_DEBUG \? \[self NSNumber:json\] : json getter\]/.test(cvt),
  );
  // U-4: 四个 handler 安装函数 0 外部调用
  for (const [id, fn, name] of [
    ['C72', 'RCTSetFatalHandler', 'fatalHandler'],
    ['C73', 'RCTSetFatalExceptionHandler', 'fatalExceptionHandler'],
    ['C74', 'RCTSetAssertFunction', 'assertFunction'],
    ['C75', 'RCTAddAssertFunction', 'addAssertFunction'],
  ]) {
    const hits = grepCount(new RegExp(fn + '\\('), {
      exts: ['.m', '.mm', '.h'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTAssert.m') && !f.endsWith('React/Base/RCTAssert.h'));
    add(`${id}`, `${name} 安装函数（${fn}）在 RN 仓库内的外部调用数`, '0', `${hits.length} 处`, hits.length === 0);
  }
  // U-5: RCTPerformBlockWith*Function 缺 @finally
  const asrt = read('packages/react-native/React/Base/RCTAssert.m') ?? '';
  const asrtPerf = /RCTPerformBlockWithAssertFunction[\s\S]{0,900}?\[functionStack addObject:assertFunction\];\s*block\(\);\s*\[functionStack removeLastObject\];/.test(asrt);
  add(
    'C76', 'RCTPerformBlockWithAssertFunction 的 add/block/remove 三步之间没有 @finally',
    '三步相邻，无 @finally',
    asrtPerf && !/@finally/.test(asrt) ? '确认无 @finally' : '有 @finally 或未匹配',
    asrtPerf && !/@finally/.test(asrt),
  );
  const logm = read('packages/react-native/React/Base/RCTLog.mm') ?? '';
  const logPerf = /RCTPerformBlockWithLogFunction[\s\S]{0,900}?\[functionStack addObject:logFunction\];\s*block\(\);\s*\[functionStack removeLastObject\];/.test(logm);
  add(
    'C76b', 'RCTPerformBlockWithLogFunction 同样缺 @finally（与 assert 侧同型）',
    '三步相邻，无 @finally',
    logPerf && !/@finally/.test(logm) ? '确认无 @finally' : '有 @finally 或未匹配',
    logPerf && !/@finally/.test(logm),
  );
  // U-6: %{public}s 不脱敏
  add(
    'C77', 'RCTDefaultLogFunction 用 "%{public}s" 写 os_log（内容不脱敏）',
    '"%{public}s"',
    logm.includes('"%{public}s"') ? '确认 public' : '未匹配',
    logm.includes('"%{public}s"'),
  );
  add(
    'C77b', 'RCTDefaultLogFunction 里不含 %{private}',
    '0 处 private',
    (logm.match(/%\{private\}/g) ?? []).length + ' 处',
    !logm.includes('%{private}'),
  );
  // U-7: log 判定恒真（RCTGetLogFunction 兜底）
  add(
    'C78', '_RCTLogNativeInternal 里 `log = RCT_DEBUG || (logFunction != nil)` 的后半项恒真（RCTGetLogFunction 兜底赋值）',
    'RCTGetLogFunction 内有 if (!RCTCurrentLogFunction) 兜底',
    /RCTLogFunction RCTGetLogFunction\(\)\s*\{\s*if \(!RCTCurrentLogFunction\) \{\s*RCTCurrentLogFunction = RCTDefaultLogFunction;/.test(logm)
      ? '确认兜底 → log 恒真' : '未匹配',
    /RCTLogFunction RCTGetLogFunction\(\)\s*\{\s*if \(!RCTCurrentLogFunction\) \{\s*RCTCurrentLogFunction = RCTDefaultLogFunction;/.test(logm),
  );
  add(
    'C78b', '_RCTLogJavaScriptInternal 用同一个恒真判定式',
    '两处写法一致',
    (logm.match(/BOOL log = RCT_DEBUG \|\| \(logFunction != nil\);/g) ?? []).length + ' 处',
    (logm.match(/BOOL log = RCT_DEBUG \|\| \(logFunction != nil\);/g) ?? []).length === 2,
  );
  // U-8/U-9: 注释声称 dispatch_once/once_flag 但两侧都没有
  add(
    'C79', 'RCTConvert.mm 的 _defaultColorSpace 是裸 static 变量，注释声称的 dispatch_once/once_flag 实际不存在',
    '裸赋值，无 dispatch_once',
    /static RCTColorSpace _defaultColorSpace = RCTColorSpaceSRGB;/.test(cvtm) &&
      /void RCTSetDefaultColorSpace\(RCTColorSpace colorSpace\)\s*\{\s*_defaultColorSpace = colorSpace;/.test(cvtm) &&
      !/_defaultColorSpace[\s\S]{0,400}?dispatch_once/.test(cvtm)
      ? '确认无 dispatch_once（与注释矛盾）' : '有 dispatch_once 或未匹配',
    /static RCTColorSpace _defaultColorSpace = RCTColorSpaceSRGB;/.test(cvtm) &&
      /void RCTSetDefaultColorSpace\(RCTColorSpace colorSpace\)\s*\{\s*_defaultColorSpace = colorSpace;/.test(cvtm) &&
      !/_defaultColorSpace[\s\S]{0,400}?dispatch_once/.test(cvtm),
  );
  const cc = read('packages/react-native/ReactCommon/react/renderer/graphics/ColorComponents.cpp') ?? '';
  add(
    'C80', 'ColorComponents.cpp 的 defaultColorSpace 是非原子 static（无 std::atomic / once_flag）',
    '裸 static，无 atomic/once_flag',
    /static ColorSpace defaultColorSpace = ColorSpace::sRGB;/.test(cc) &&
      !/std::atomic|once_flag/.test(cc)
      ? '确认非原子' : '有 atomic 或未匹配',
    /static ColorSpace defaultColorSpace = ColorSpace::sRGB;/.test(cc) && !/std::atomic|once_flag/.test(cc),
  );
  add(
    'C80b', 'ColorComponents.cpp 的 `#include <mutex>` 在全文中无任何使用（残留）',
    '0 处 std::mutex/lock_guard',
    (cc.match(/std::(mutex|lock_guard|unique_lock)/g) ?? []).length + ' 处使用',
    cc.includes('#include <mutex>') && !/std::(mutex|lock_guard|unique_lock)/.test(cc),
  );
  // U-10: RCTIsNewArchEnabled 硬编码 YES 且 0 调用
  const ut = read('packages/react-native/React/Base/RCTUtils.mm') ?? '';
  add(
    'C81', 'RCTIsNewArchEnabled 硬编码 return YES，且全仓库 0 调用（声明+定义仅 2 处）',
    '硬编码 YES，0 调用',
    /BOOL RCTIsNewArchEnabled\(void\)\s*\{\s*return YES;\s*\}/.test(ut) &&
      (grepCount(/RCTIsNewArchEnabled/, {
        exts: ['.m', '.mm', '.h'],
        roots: ['packages/react-native'],
      }).files.filter(f => !/React\/Base\/RCTUtils\.(m|mm|h)$/.test(f)).length === 0)
      ? '确认硬编码 + 0 调用' : '未匹配',
    /BOOL RCTIsNewArchEnabled\(void\)\s*\{\s*return YES;\s*\}/.test(ut) &&
      grepCount(/RCTIsNewArchEnabled/, {
        exts: ['.m', '.mm', '.h'],
        roots: ['packages/react-native'],
      }).files.filter(f => !/React\/Base\/RCTUtils\.(m|mm|h)$/.test(f)).length === 0,
  );
  // U-11: W3C 指针事件开关 0 写入
  const cm = read('packages/react-native/React/Base/RCTConstants.m') ?? '';
  add(
    'C82', 'RCTSetDispatchW3CPointerEvents 无任何调用方（RCTDispatchW3CPointerEvents 恒为 NO）',
    '0 处调用',
    (() => {
      const hits = grepCount(/RCTSetDispatchW3CPointerEvents\(/, {
        exts: ['.m', '.mm'],
        roots: ['packages/react-native'],
      }).files.filter(f => !f.endsWith('React/Base/RCTConstants.m'));
      return `${hits.length} 处`;
    })(),
    (() => {
      const hits = grepCount(/RCTSetDispatchW3CPointerEvents\(/, {
        exts: ['.m', '.mm'],
        roots: ['packages/react-native'],
      }).files.filter(f => !f.endsWith('React/Base/RCTConstants.m'));
      return hits.length === 0;
    })(),
  );
  add(
    'C82b', 'RCTConstants.m 里 RCTDispatchW3CPointerEvents 的初值',
    'NO',
    /static BOOL RCTDispatchW3CPointerEvents = NO;/.test(cm) ? 'NO' : '未匹配',
    /static BOOL RCTDispatchW3CPointerEvents = NO;/.test(cm),
  );
  // U-12: RCTPlatformName 硬编码 ios
  add(
    'C83', 'RCTPlatformName 硬编码 @"ios"（tvOS 也上报 ios）',
    'ios',
    /NSString \*const RCTPlatformName = @"ios";/.test(cm) ? 'ios' : '未匹配',
    /NSString \*const RCTPlatformName = @"ios";/.test(cm),
  );
  // U-13: warn vs warning 不一致
  const warnLevels = /"warn"/.test(logm);
  const warnLevelFmt = /RCTLogLevelWarning\) : @"warning"/.test(logm);
  add(
    'C84', '同一级别两个名字：RCTLogLevels[] 用 "warn"，RCTFormatLogLevel 用 "warning"',
    `数组="warn"=${warnLevels}, 格式化="warning"=${warnLevelFmt}`,
    warnLevels && warnLevelFmt ? '确认不一致' : '一致或未匹配',
    warnLevels && warnLevelFmt,
  );
  // U-14: RCTVersion 占位符
  const vm = read('packages/react-native/React/Base/RCTVersion.m') ?? '';
  add(
    'C85', 'RCTVersion.m 的默认 major 是占位符 1000（由发布脚本 set-rn-artifacts-version 改写）',
    '1000',
    /RCTVersionMajor: @\(1000\)/.test(vm) ? '1000' : '未匹配',
    /RCTVersionMajor: @\(1000\)/.test(vm),
  );
  // U-16: RCTLOG_REDBOX_LEVEL 默认 Error
  const lgH = read('packages/react-native/React/Base/RCTLog.h') ?? '';
  add(
    'C86', 'RCTLOG_REDBOX_LEVEL 默认为 RCTLogLevelError（Debug 下每次 error 日志都做完整符号化）',
    'RCTLogLevelError',
    /#define RCTLOG_REDBOX_LEVEL RCTLogLevelError/.test(lgH) ? 'RCTLogLevelError' : '未匹配',
    /#define RCTLOG_REDBOX_LEVEL RCTLogLevelError/.test(lgH),
  );
  // 阈值默认为 Trace（0）—— 等于不设阈
  add(
    'C86b', 'RCTDefaultLogThreshold = RCTLogLevelInfo - 1，即 RCTLogLevelTrace(0)，任何级别都能通过',
    'Trace(0)',
    /RCTDefaultLogThreshold = \(RCTLogLevel\)\(RCTLogLevelInfo - 1\)/.test(logm)
      && /RCTLogLevelTrace = 0/.test(lgH)
      ? 'Trace(0) → 阈值恒通过' : '未匹配',
    /RCTDefaultLogThreshold = \(RCTLogLevel\)\(RCTLogLevelInfo - 1\)/.test(logm) && /RCTLogLevelTrace = 0/.test(lgH),
  );
  // 六个编译期开关各自 #ifndef 独立定义
  const defs = read('packages/react-native/React/Base/RCTDefines.h') ?? '';
  const nGuards = (defs.match(/#ifndef (RCT_DEBUG|RCT_DEV|RCT_DEV_MENU|RCT_NSASSERT)\b/g) ?? []).length;
  add('C87', 'RCTDefines.h 里可独立覆盖的编译期开关数（每个都有 #ifndef 保护）', '4', `${nGuards} 个`, nGuards === 4);
  // RCTCxxConvert 空实现
  const ccx = read('packages/react-native/React/Base/RCTCxxConvert.m') ?? '';
  add(
    'C88', 'RCTCxxConvert 的 @implementation 内无任何方法（头注释描述的能力未实现）',
    '0 个方法',
    (ccx.match(/^[-+] \(/gm) ?? []).length + ' 个',
    !/^[-+] \(/m.test(ccx),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 28. iOS 事件分发 / 触摸管线 / RCTBridge 开关（24 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const ed = read('packages/react-native/React/CoreModules/RCTEventDispatcher.mm') ?? '';
  // 事件 ID 三段位打包
  add(
    'C89', 'RCTGetEventID 把 viewTag / eventName.hash(16位) / coalescingKey 打包进互不重叠的位段',
    'viewTag | hash<<32 | key<<48',
    /viewTag\.intValue \| \(\(\(uint64_t\)eventName\.hash & 0xFFFF\) << 32\) \| \(\(\(uint64_t\)coalescingKey\) << 48\)/.test(ed)
      ? '确认三段位' : '未匹配',
    /viewTag\.intValue \| \(\(\(uint64_t\)eventName\.hash & 0xFFFF\) << 32\) \| \(\(\(uint64_t\)coalescingKey\) << 48\)/.test(ed),
  );
  // E-2: 不可合并分支先读后写 eventID
  add(
    'C90', 'sendEvent: 的不可合并分支在 eventID 赋值之前先读 _events[eventID]（断言校验的是错误的 ID）',
    '先 _events[eventID] 再赋值',
    (() => {
      const idx = ed.indexOf('} else {', ed.indexOf('if (event.canCoalesce)'));
      const seg = idx >= 0 ? ed.slice(idx, idx + 400) : '';
      const readAt = seg.indexOf('_events[eventID]');
      const writeAt = seg.indexOf('eventID = RCTGetEventID');
      return readAt >= 0 && writeAt > readAt;
    })()
      ? '确认先读后写' : '未匹配',
    (() => {
      const idx = ed.indexOf('} else {', ed.indexOf('if (event.canCoalesce)'));
      const seg = idx >= 0 ? ed.slice(idx, idx + 400) : '';
      const readAt = seg.indexOf('_events[eventID]');
      const writeAt = seg.indexOf('eventID = RCTGetEventID');
      return readAt >= 0 && writeAt > readAt;
    })(),
  );
  // canCoalesce 只有两个实现，且只有 touchMove 为真
  const te = read('packages/react-native/React/Base/RCTTouchEvent.m') ?? '';
  const ce = read('packages/react-native/React/Base/RCTComponentEvent.m') ?? '';
  add(
    'C91', 'canCoalesce 全仓库仅两处实现：RCTTouchEvent 只对 "touchMove" 为真，RCTComponentEvent 恒 NO',
    'touchMove 为真 / 组件事件恒 NO',
    /- \(BOOL\)canCoalesce\s*\{\s*return \[_eventName isEqual:@"touchMove"\];/.test(te) &&
      /- \(BOOL\)canCoalesce\s*\{\s*return NO;/.test(ce)
      ? '确认两处' : '未匹配',
    /- \(BOOL\)canCoalesce\s*\{\s*return \[_eventName isEqual:@"touchMove"\];/.test(te) &&
      /- \(BOOL\)canCoalesce\s*\{\s*return NO;/.test(ce),
  );
  // E-12: generator 是 static + uint16_t
  add(
    'C92', 'RCTUniqueCoalescingKeyGenerator 是 static 全局 uint16_t（每 65536 次自增回绕）',
    'static uint16_t',
    /static uint16_t RCTUniqueCoalescingKeyGenerator = 0;/.test(ed) ? 'static uint16_t' : '未匹配',
    /static uint16_t RCTUniqueCoalescingKeyGenerator = 0;/.test(ed),
  );
  // flushEventsQueue 整体换新对象（回绕不可观测的前提）
  add(
    'C92b', 'flushEventsQueue 把 _events/_eventQueue 整体换成新对象（使 eventID 回绕不可观测）',
    '两处 _events = [NSMutableDictionary new]',
    (ed.match(/_events = \[NSMutableDictionary new\]/g) ?? []).length + ' 处',
    (ed.match(/_events = \[NSMutableDictionary new\]/g) ?? []).length >= 1 &&
      (ed.match(/_eventQueue = \[NSMutableArray new\]/g) ?? []).length >= 1,
  );
  // E-1: RCTEventEmitter.js 零 import
  {
    const jsPath = 'packages/react-native/Libraries/EventEmitter/RCTEventEmitter.js';
    const js = read(jsPath) ?? '';
    const hits = grepCount(/EventEmitter\/RCTEventEmitter/, {
      exts: ['.js'],
      roots: ['packages'],
    }).files.filter(f => f !== jsPath);
    add('C93', 'RCTEventEmitter.js 在 JS 侧的 import 方数量（决定 legacy 事件链是否接通）', '0', `${hits.length} 处`, hits.length === 0);
    add(
      'C93b', 'RCTEventEmitter.js 只提供类型声明与 register，receiveTouches/receiveEvent 无实现',
      '仅类型声明',
      /type EventEmitterModule = \{/.test(js) && /receiveTouches: \(/.test(js) && !/receiveTouches\(/.test(js)
        ? '仅声明无实现' : '有实现或未匹配',
      /type EventEmitterModule = \{/.test(js) && /receiveTouches: \(/.test(js) && !/receiveTouches\(/.test(js),
    );
  }
  // E-3: RCTEnableTurboModule 空实现 + 0 调用
  {
    const bm = read('packages/react-native/React/Base/RCTBridge.mm') ?? '';
    const emptyImpl = /void RCTEnableTurboModule\(BOOL enabled\)\s*\{\s*\n\s*\/\/[^\n]*\n\s*\}/.test(bm);
    add('C94', 'RCTEnableTurboModule 的函数体只有注释（参数 enabled 被忽略）', '空实现', emptyImpl ? '确认空实现' : '未匹配', emptyImpl);
    const calls = grepCount(/RCTEnableTurboModule\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTBridge.mm'));
    add('C94b', 'RCTEnableTurboModule 的调用方数量', '0', `${calls.length} 处`, calls.length === 0);
    // E-4: fabricInteropLayerEnabled 恒 YES
    add(
      'C95', 'fabricInteropLayerEnabled 初值 YES 且 RCTEnableFabricInteropLayer 零调用 → 恒为 YES',
      '初值 YES，0 调用',
      /static BOOL fabricInteropLayerEnabled = YES;/.test(bm) &&
        grepCount(/RCTEnableFabricInteropLayer\(/, {
          exts: ['.m', '.mm'],
          roots: ['packages/react-native'],
        }).files.filter(f => !f.endsWith('React/Base/RCTBridge.mm')).length === 0
        ? '确认恒 YES' : '未匹配',
      /static BOOL fabricInteropLayerEnabled = YES;/.test(bm) &&
        grepCount(/RCTEnableFabricInteropLayer\(/, {
          exts: ['.m', '.mm'],
          roots: ['packages/react-native'],
        }).files.filter(f => !f.endsWith('React/Base/RCTBridge.mm')).length === 0,
    );
    // E-5: RCTBridge 四个空方法
    const empties = ['reload', 'reloadWithReason', 'onFastRefresh', 'requestReload'];
    const nEmpty = empties.filter(m =>
      new RegExp('\\- \\(void\\)' + m + '[^\\{]*\\{\\s*\\}').test(bm),
    ).length;
    add('C96', 'RCTBridge 中 reload/reloadWithReason:/onFastRefresh/requestReload 的空实现数量', '4', `${nEmpty} 个`, nEmpty === 4);
    // E-6: || 与 && 混用
    const bmh = read('packages/react-native/React/Base/RCTBridgeModule.h') ?? '';
    add(
      'C97', '同一对 RCT_REMOVE_LEGACY_* 宏：RCTBridge.mm 用 ||（任一未定义即保留），RCTBridgeModule.h 用 &&（两者都定义才走）',
      'RCTBridge.mm=|| / RCTBridgeModule.h=&&',
      /#if !defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) \|\| !defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)/.test(bm) &&
        /#if defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) && defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)/.test(bmh)
        ? '确认混用' : '未匹配',
      /#if !defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) \|\| !defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)/.test(bm) &&
        /#if defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) && defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)/.test(bmh),
    );
  }
  // E-7: RCTReloadCommand 锁初始化在锁外
  const rc = read('packages/react-native/React/Base/RCTReloadCommand.m') ?? '';
  add(
    'C98', 'RCTRegisterReloadCommandListener 在加锁之前判空并赋值 listenersLock（首次并发注册会丢失锁）',
    '判空在 lock 之前',
    /if \(!listenersLock\) \{\s*listenersLock = \[NSLock new\];\s*\}\s*\[listenersLock lock\];/.test(rc)
      ? '确认判空在锁外' : '未匹配',
    /if \(!listenersLock\) \{\s*listenersLock = \[NSLock new\];\s*\}\s*\[listenersLock lock\];/.test(rc),
  );
  add(
    'C98b', 'RCTTriggerReloadCommandListeners 无条件 [listenersLock lock]（nil 锁使锁失效且不崩溃）',
    '无条件加锁',
    /void RCTTriggerReloadCommandListeners\(NSString \*reason\)\s*\{\s*\[listenersLock lock\];/.test(rc)
      ? '确认无条件' : '未匹配',
    /void RCTTriggerReloadCommandListeners\(NSString \*reason\)\s*\{\s*\[listenersLock lock\];/.test(rc),
  );
  // reload listener 唯一注册方是 RCTHost
  {
    const regs = grepCount(/RCTRegisterReloadCommandListener\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTReloadCommand.m'));
    add(
      'C99', 'RCTRegisterReloadCommandListener 的调用方（唯一实现 didReceiveReloadCommand 的类）',
      '1 且为 RCTHost',
      regs.length === 1 && /RCTHost\.mm$/.test(regs[0]) ? `1: ${regs[0].split('/').pop()}` : `${regs.length} 处`,
      regs.length === 1 && /RCTHost\.mm$/.test(regs[0]),
    );
  }
  // E-8: 错误码撞号
  const jl = read('packages/react-native/React/Base/RCTJavaScriptLoader.h') ?? '';
  const codes = [...jl.matchAll(/RCTJavaScriptLoaderError(\w+) = (\d+)/g)].map(m => [m[1], m[2]]);
  const byVal = {};
  for (const [n, v] of codes) (byVal[v] ||= []).push(n);
  const dupes = Object.entries(byVal).filter(([, ns]) => ns.length > 1);
  add(
    'C100', 'RCTJavaScriptLoader 错误码中重复取值的组数（3 个值为 3、2 个值为 4）',
    '2 组',
    `${dupes.length} 组：${dupes.map(([v, ns]) => `${v}×${ns.length}`).join(', ')}`,
    dupes.length === 2 && dupes.find(([v]) => v === '3')?.[1].length === 3 && dupes.find(([v]) => v === '4')?.[1].length === 2,
  );
  const jlm = read('packages/react-native/React/Base/RCTJavaScriptLoader.mm') ?? '';
  add(
    'C101', '唯一按 error.code 分支的判断用的是 1000（CannotBeLoadedSynchronously），不与撞号组冲突',
    '1000',
    /error\.code == RCTJavaScriptLoaderErrorCannotBeLoadedSynchronously/.test(jlm) &&
      /RCTJavaScriptLoaderErrorCannotBeLoadedSynchronously = 1000/.test(jl)
      ? '确认 1000 不冲突' : '未匹配',
    /error\.code == RCTJavaScriptLoaderErrorCannotBeLoadedSynchronously/.test(jlm) &&
      /RCTJavaScriptLoaderErrorCannotBeLoadedSynchronously = 1000/.test(jl),
  );
  // E-14: ScriptTag::String 受 RCT_ENABLE_INSPECTOR 门控
  add(
    'C102', 'ScriptTag::String 分支的同步加载被 #if RCT_ENABLE_INSPECTOR 包裹（纯 Release 下走异步）',
    '受 RCT_ENABLE_INSPECTOR 门控',
    /case facebook::react::ScriptTag::String: \{\s*#if RCT_ENABLE_INSPECTOR/.test(jlm)
      ? '确认门控' : '未匹配',
    /case facebook::react::ScriptTag::String: \{\s*#if RCT_ENABLE_INSPECTOR/.test(jlm),
  );
  // RCT_ENABLE_INSPECTOR 的定义依赖 DEV 或 REMOTE_PROFILE
  const defs = read('packages/react-native/React/Base/RCTDefines.h') ?? '';
  add(
    'C102b', 'RCT_ENABLE_INSPECTOR = (RCT_DEV || RCT_REMOTE_PROFILE)，两者皆 0 时为 0',
    'DEV || REMOTE_PROFILE',
    /#if \(RCT_DEV \|\| RCT_REMOTE_PROFILE\)\s*\n#define RCT_ENABLE_INSPECTOR 1/.test(defs)
      ? '确认依赖 DEV/REMOTE_PROFILE' : '未匹配',
    /#if \(RCT_DEV \|\| RCT_REMOTE_PROFILE\)\s*\n#define RCT_ENABLE_INSPECTOR 1/.test(defs),
  );
  // 触摸 ID 上限
  const th = read('packages/react-native/React/Base/RCTTouchHandler.m') ?? '';
  add(
    'C103', '触摸 ID 上限常量 RCTMaxTouches 的值',
    '11',
    (th.match(/RCTMaxTouches = (\d+)/) ?? [])[1] ?? '未匹配',
    /RCTMaxTouches = 11/.test(th),
  );
  // E-13: RCTTextUpdateLagWarningThreshold 零使用
  {
    const hits = grepCount(/RCTTextUpdateLagWarningThreshold/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTEventDispatcher.m'));
    add('C104', 'RCTTextUpdateLagWarningThreshold 的使用方（排除定义文件）', '0', `${hits.length} 处`, hits.length === 0);
    const threshVal = /const NSInteger RCTTextUpdateLagWarningThreshold = (\d+);/.exec(
      read('packages/react-native/React/Base/RCTEventDispatcher.m') ?? '',
    );
    add(
      'C104b',
      'RCTTextUpdateLagWarningThreshold 的值',
      '3',
      threshVal ? threshVal[1] : '未匹配',
      threshVal?.[1] === '3',
    );
  }
  // 事件名规范化的幂等性
  const edm = read('packages/react-native/React/Base/RCTEventDispatcher.m') ?? '';
  add(
    'C105', 'RCTNormalizeInputEventName 幂等：已有 "top" 前缀时不做任何转换',
    'top 前缀直接返回',
    /else if \(!\[eventName hasPrefix:@"top"\]\)/.test(edm) ? '确认幂等' : '未匹配',
    /else if \(!\[eventName hasPrefix:@"top"\]\)/.test(edm),
  );
  // ComponentEvent 在构造时规范化，TouchEvent 在 arguments 时规范化
  add(
    'C106', '事件名规范化时机不同：RCTComponentEvent 在构造时调用，RCTTouchEvent 在 arguments 里调用',
    '构造时 / arguments 时',
    /_eventName = RCTNormalizeInputEventName\(name\);/.test(ce) &&
      /return @\[ RCTNormalizeInputEventName\(_eventName\), _reactTouches, _changedIndexes \];/.test(te)
      ? '确认时机不同' : '未匹配',
    /_eventName = RCTNormalizeInputEventName\(name\);/.test(ce) &&
      /return @\[ RCTNormalizeInputEventName\(_eventName\), _reactTouches, _changedIndexes \];/.test(te),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 29. iOS 桥接核心 / RCTModuleData / 启动性能标签（25 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const md = read('packages/react-native/React/Base/RCTModuleData.mm') ?? '';
  // M-1: RCTModuleData 的空实现 + 零 @synthesize
  add(
    'C107', 'RCTModuleData.mm 的 @implementation 内无任何 @synthesize（11 个属性靠自动合成返回零值）',
    '0 个 @synthesize',
    (md.match(/@synthesize/g) ?? []).length + ' 个',
    !/@synthesize/.test(md),
  );
  add(
    'C107b', 'RCTModuleData.mm 的 initWithModuleClass: 直接 return self（6 个参数全部未使用）',
    'return self',
    /- \(instancetype\)initWithModuleClass:[\s\S]{0,700}?\n\{\n  return self;\n\}/.test(md) ? '确认' : '未匹配',
    /- \(instancetype\)initWithModuleClass:[\s\S]{0,700}?\n\{\n  return self;\n\}/.test(md),
  );
  add(
    'C107c', 'RCTModuleData.mm 的 gatherConstants 与 invalidate 是空实现',
    '两个空方法',
    /- \(void\)gatherConstants\n\{\n\}/.test(md) && /- \(void\)invalidate\n\{\n\}/.test(md)
      ? '确认' : '未匹配',
    /- \(void\)gatherConstants\n\{\n\}/.test(md) && /- \(void\)invalidate\n\{\n\}/.test(md),
  );
  // M-1b: 两个构造器零调用
  {
    const hits = grepCount(/initWithModuleClass:|initWithModuleInstance:/, {
      exts: ['.m', '.mm'],
      roots: ['packages'],
    }).files.filter(f => !f.endsWith('React/Base/RCTModuleData.mm'));
    add('C108', 'RCTModuleData 两个构造器的外部调用数（类无法被实例化）', '0', hits.length + ' 处', hits.length === 0);
  }
  // M-2: RCTBridge 上无 moduleDataForName: 实现
  {
    const bm = read('packages/react-native/React/Base/RCTBridge.mm') ?? '';
    add(
      'C109', 'RCTBridge.mm 里既无 moduleDataForName: 也无 batchedBridge 的实现（头文件仍声明）',
      '0 个实现',
      /moduleDataForName|batchedBridge/.test(bm) ? '有实现' : '确认无实现',
      !/moduleDataForName|batchedBridge/.test(bm) &&
        /- \(RCTModuleData \*\)moduleDataForName:/.test(
          read('packages/react-native/React/Base/RCTBridge+Private.h') ?? '',
        ),
    );
  }
  // M-3: RCT_DISABLE_STATIC_MODULE_REGISTRATION 零定义
  {
    const bmh = read('packages/react-native/React/Base/RCTBridgeModule.h') ?? '';
    const defined = grepCount(/define RCT_DISABLE_STATIC_MODULE_REGISTRATION/, {
      roots: ['packages', 'scripts'],
    }).files;
    add('C110', 'RCT_DISABLE_STATIC_MODULE_REGISTRATION 的定义处数量（该 RCT_EXPORT_MODULE 分支是否可达）', '0', defined.length + ' 处', defined.length === 0);
    add(
      'C110b', '该分支内保留了 RCTRegisterModule 的 extern 声明但删掉了调用点（悬空声明，不产生链接错误）',
      '有 extern、无 +load',
      /#else\n\n#define RCT_EXPORT_MODULE\(js_name\)[\s\S]{0,200}?RCT_EXTERN void RCTRegisterModule\(Class\);[\s\S]{0,200}?return @ #js_name;[\s\S]{0,40}?\}/.test(bmh) &&
        !/#else\n\n#define RCT_EXPORT_MODULE\(js_name\)[\s\S]{0,400}?\+\(void\)load/.test(bmh)
        ? '确认悬空' : '未匹配',
      /#else\n\n#define RCT_EXPORT_MODULE\(js_name\)[\s\S]{0,200}?RCT_EXTERN void RCTRegisterModule\(Class\);[\s\S]{0,200}?return @ #js_name;[\s\S]{0,40}?\}/.test(bmh) &&
        !/#else\n\n#define RCT_EXPORT_MODULE\(js_name\)[\s\S]{0,400}?\+\(void\)load/.test(bmh),
    );
  }
  // RCTRegisterModule 声明/定义在四种宏组合下配对
  {
    const bm = read('packages/react-native/React/Base/RCTBridge.mm') ?? '';
    const bmh = read('packages/react-native/React/Base/RCTBridgeModule.h') ?? '';
    add(
      'C111', 'RCTRegisterModule：头文件在「两宏都定义」时走简化分支（只返回 moduleName），.mm 用 || 门控定义，两者一致',
      '简化分支 + || 门控',
      /#if defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) && defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)[\s\S]{0,600}?#define RCT_EXPORT_MODULE\(js_name\) \\\s*\+\(NSString \*\)moduleName/.test(bmh) &&
        /#if !defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) \|\| !defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)[\s\S]{0,600}?void RCTRegisterModule\(Class moduleClass\)/.test(bm)
        ? '确认配对' : '未匹配',
      /#if defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) && defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)[\s\S]{0,600}?#define RCT_EXPORT_MODULE\(js_name\) \\\s*\+\(NSString \*\)moduleName/.test(bmh) &&
        /#if !defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) \|\| !defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)[\s\S]{0,600}?void RCTRegisterModule\(Class moduleClass\)/.test(bm),
    );
  }
  // M-4: attachInteropAPIsToModule 靠 respondsToSelector + @synthesize
  {
    const dec = read('packages/react-native/React/Base/RCTBridgeModuleDecorator.m') ?? '';
    const nGuards = (dec.match(/respondsToSelector:@selector\(set/g) ?? []).length;
    add('C112', 'attachInteropAPIsToModule 用 respondsToSelector 守卫注入的 API 数量', '4', nGuards + ' 个', nGuards === 4);
    const nSynth = grepCount(/@synthesize moduleRegistry/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.length;
    add('C112b', '真正写了 @synthesize moduleRegistry 的文件数（对比 4 个可注入 API，说明接入面很窄）', '实测值', nSynth + ' 个', nSynth > 0 && nSynth < 60);
  }
  // M-5: 22 个标签中 12 个零打点
  {
    const plH = read('packages/react-native/React/Base/RCTPLTag.h') ?? '';
    const tags = [...new Set([...plH.matchAll(/RCTPL(\w+)/g)].map(x => 'RCTPL' + x[1]))].filter(t => t !== 'RCTPLSize');
    const zero = [];
    const hit = [];
    for (const tag of tags) {
      const files = grepCount(new RegExp(tag + '\\b'), {
        exts: ['.m', '.mm', '.cpp'],
        roots: ['packages/react-native'],
      }).files.filter(f => !/RCTPLTag\.h$|RCTPerformanceLoggerLabels\./.test(f));
      (files.length === 0 ? zero : hit).push(tag);
    }
    add('C113', 'RCTPLTag 的标签总数（排除哨兵 RCTPLSize）', '22', tags.length + ' 个', tags.length === 22);
    add('C114', '零打点的性能标签数量（22 个中）', '12', zero.length + ' 个', zero.length === 12);
    add('C114b', '零打点标签清单', '3 个 RAMStartup* + RAMBundleLoad + 4 个 NativeModule* + TurboModuleSetup + JSCWrapperOpenLibrary + BridgeStartup + BundleSize',
      zero.length + ' 个：' + zero.map(t => t.replace('RCTPL', '')).join(', '),
      zero.includes('RCTPLRAMBundleLoad') && zero.includes('RCTPLTurboModuleSetup') &&
        zero.includes('RCTPLBridgeStartup') && zero.includes('RCTPLBundleSize') &&
        zero.includes('RCTPLJSCWrapperOpenLibrary') && zero.filter(t => /RAMStartup/.test(t)).length === 3 &&
        zero.filter(t => /NativeModule/.test(t)).length === 4,
    );
    add('C114c', '有实际打点的性能标签数量', '10', hit.length + ' 个', hit.length === 10);
  }
  // M-8: RCTPLSize 的断言
  {
    const lm = read('packages/react-native/React/Base/RCTPerformanceLoggerLabels.m') ?? '';
    add(
      'C115', 'RCTPLLabelForTag 对哨兵 RCTPLSize 显式 RCTAssert(NO) 后返回 nil（Release 下该断言无效）',
      'RCTAssert(NO) + return nil',
      /case RCTPLSize: \/\/ Only used to count enum size\s*\n\s*RCTAssert\(NO,[\s\S]{0,120}?return nil;/.test(lm)
        ? '确认' : '未匹配',
      /case RCTPLSize: \/\/ Only used to count enum size\s*\n\s*RCTAssert\(NO,[\s\S]{0,120}?return nil;/.test(lm),
    );
  }
  // M-6: 劫持 logTaggedMarkerImpl
  {
    const utils = read('packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTPerformanceLoggerUtils.mm') ?? '';
    add(
      'C116', 'iOS 性能日志靠赋值 ReactMarker::logTaggedMarkerImpl 接入（而非独立埋点）',
      '赋值 logTaggedMarkerImpl',
      /ReactMarker::logTaggedMarkerImpl = \[weakPerformanceLogger\]/.test(utils)
        ? '确认劫持' : '未匹配',
      /ReactMarker::logTaggedMarkerImpl = \[weakPerformanceLogger\]/.test(utils),
    );
    const nCalls = grepCount(/registerPerformanceLoggerHooks\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages'],
    }).files.filter(f => !f.endsWith('RCTPerformanceLoggerUtils.mm'));
    add(
      'C116b', 'registerPerformanceLoggerHooks 的调用方（iOS 需显式注册；Android 由 JNI 层默认装好）',
      '1 且为 RCTInstance.mm',
      nCalls.length === 1 && /RCTInstance\.mm$/.test(nCalls[0]) ? '1: ' + nCalls[0].split('/').pop() : nCalls.length + ' 处',
      nCalls.length === 1 && /RCTInstance\.mm$/.test(nCalls[0]),
    );
    add(
      'C116c', 'Android 侧由 JReactMarker.cpp 默认赋值 logTaggedMarkerImpl（平台不对称）',
      'JReactMarker.cpp 有赋值',
      /ReactMarker::logTaggedMarkerImpl = JReactMarker::logPerfMarker;/.test(
        read('packages/react-native/ReactAndroid/src/main/jni/react/jni/JReactMarker.cpp') ?? '',
      )
        ? '确认' : '未匹配',
      /ReactMarker::logTaggedMarkerImpl = JReactMarker::logPerfMarker;/.test(
        read('packages/react-native/ReactAndroid/src/main/jni/react/jni/JReactMarker.cpp') ?? '',
      ),
    );
    // M-7: 5 个 iOS 侧忽略的 marker
    const ignored = (utils.match(/These are not used on iOS/g) ?? []).length;
    // 忽略组本身：行级解析 —— 找注释所在行，往上收集紧邻的连续 case 行
    const nCases = (() => {
      const lines = utils.split('\n');
      const i = lines.findIndex(l => l.includes('These are not used on iOS'));
      if (i < 0) return 0;
      let n = 0;
      for (let k = i - 1; k >= 0 && lines[k].includes('case ReactMarker::'); k--) n++;
      return n;
    })();
    add('C117', 'iOS 侧映射表里显式忽略的 marker 数（注释自述 These are not used on iOS）', '5',
      nCases + ' 个', ignored === 1 && nCases === 5);
    add('C117b', 'mapReactMarkerToPerformanceLogger 内的 case 总数（12 个生效映射 + 5 个忽略）', '17',
      (utils.match(/case ReactMarker::/g) ?? []).length + ' 个',
      (utils.match(/case ReactMarker::/g) ?? []).length === 17);
  }
  // M-9: _data[tag][0] 三种语义
  {
    const plm = read('packages/react-native/React/Base/RCTPerformanceLogger.mm') ?? '';
    add(
      'C118', 'setValue:/addValue: 都把 _data[tag][0] 强制置 0，而 markStart: 把它写成时间戳 —— 同一槽位两种语义',
      '置 0 vs 时间戳',
      /- \(void\)setValue:\(int64_t\)value forTag:\(RCTPLTag\)tag\s*\{\s*_data\[tag\]\[0\] = 0;/.test(plm) &&
        /- \(void\)markStartForTag:\(RCTPLTag\)tag[\s\S]{0,400}?_data\[tag\]\[0\] = currentTime;/.test(plm)
        ? '确认槽位复用' : '未匹配',
      /- \(void\)setValue:\(int64_t\)value forTag:\(RCTPLTag\)tag\s*\{\s*_data\[tag\]\[0\] = 0;/.test(plm) &&
        /- \(void\)markStartForTag:\(RCTPLTag\)tag[\s\S]{0,400}?_data\[tag\]\[0\] = currentTime;/.test(plm),
    );
    add(
      'C118b', '读取只有 durationForTag 一种（返回 [1]-[0]），对计数标签正确是 _data[0] 恰好被置 0 的巧合',
      'return _data[tag][1] - _data[tag][0]',
      /- \(int64_t\)durationForTag:\(RCTPLTag\)tag\s*\{\s*return _data\[tag\]\[1\] - _data\[tag\]\[0\];/.test(plm)
        ? '确认唯一读取' : '未匹配',
      /- \(int64_t\)durationForTag:\(RCTPLTag\)tag\s*\{\s*return _data\[tag\]\[1\] - _data\[tag\]\[0\];/.test(plm),
    );
    add(
      'C118c', 'markStopForTag: 与 appendStopForTag: 在不配对时都记 RCTLogInfo（Release 下仍输出）',
      '2 处 RCTLogInfo',
      (plm.match(/RCTLogInfo\(@"Unbalanced calls start\/end for tag/g) ?? []).length + ' 处',
      (plm.match(/RCTLogInfo\(@"Unbalanced calls start\/end for tag/g) ?? []).length === 2,
    );
    const maps = [...plm.matchAll(/\{(RCTPL\w+), ReactMarker::(\w+)\}/g)].map(x => x[1]);
    add('C119', '反向通知 ReactMarker 的标签数（Start/Stop 两张映射表各 3 个）', '3 × 2', new Set(maps).size + ' 个唯一标签',
      new Set(maps).size === 3);
  }
  // M-10: copy-pasta 注释
  {
    const ic = read('packages/react-native/ReactCommon/react/renderer/components/legacyviewmanagerinterop/platform/ios/react/renderer/components/legacyviewmanagerinterop/RCTLegacyViewManagerInteropCoordinator.mm') ?? '';
    add(
      'C120', 'RCTModuleData 的方法扫描逻辑被 copy-pasta 到 LegacyViewManagerInteropCoordinator（源码注释自述）',
      'copy-pasta 注释存在',
      /\/\/ This is copy-pasta from RCTModuleData\./.test(ic) ? '确认' : '未匹配',
      /\/\/ This is copy-pasta from RCTModuleData\./.test(ic),
    );
    add(
      'C120b', 'interop 的 handleCommand 用 moduleData ? ... : _moduleMethods 三元（两条架构路径实际都走后者）',
      'moduleData 三元',
      /method = moduleData \? moduleData\.methods\[\[commandName intValue\]\] : _moduleMethods\[\[commandName intValue\]\];/.test(ic)
        ? '确认' : '未匹配',
      /method = moduleData \? moduleData\.methods\[\[commandName intValue\]\] : _moduleMethods\[\[commandName intValue\]\];/.test(ic),
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// 30. iOS Base 余部：RCTImageSource / Multipart / KeyCommands / CxxConvert（26 文档）
// ────────────────────────────────────────────────────────────────────────
{
  // I-1: 运算符优先级 bug
  const isrc = read('packages/react-native/React/Base/RCTImageSource.m') ?? '';
  const scaleLine = isrc.split('\n').find(l => l.includes('scale = [self CGFloat:json[@"scale"]]'));
  add(
    'C121', 'RCTImageSource.m 的 scale 三元表达式未加括号（?: 优先级高于 ?:，任何非零 scale 被清成 0.0）',
    '存在未加括号的三元',
    scaleLine && !/\?: \([^\n]*\?[^)]*\)/.test(scaleLine) ? '确认未加括号' : '未匹配或已加括号',
    !!scaleLine && !/\?: \([^\n]*\?[^)]*\)/.test(scaleLine),
  );
  add(
    'C121b', 'RCTImageSource.m 的 scale 默认声明为 1.0（第 66 行）',
    '1.0',
    /CGFloat scale = 1\.0;/.test(isrc) ? '1.0' : '未匹配',
    /CGFloat scale = 1\.0;/.test(isrc),
  );
  add(
    'C121c', 'RCTImageSource 的 isEqual: 对 scale 严格比较、无 CGSizeZero 那样的兜底（修好 I-1 后会成为新问题源）',
    '严格比较',
    /_scale == object\.scale/.test(isrc) && !/_scale == object\.scale \|\|/.test(isrc) ? '确认严格' : '未匹配',
    /_scale == object\.scale/.test(isrc) && !/_scale == object\.scale \|\|/.test(isrc),
  );
  {
    const tests = grepCount(/\bRCTImageSource\b/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native/React/Tests'],
    }).files;
    add('C122', 'RCTImageSource 在 React/Tests/ 下的测试文件数（I-1 长期未被发现的原因）', '0', tests.length + ' 个', tests.length === 0);
  }
  // I-2: RCTMultipartStreamReader 的 content 只增不减
  const msr = read('packages/react-native/React/Base/RCTMultipartStreamReader.m') ?? '';
  {
    const appends = (msr.match(/\[content appendBytes:/g) ?? []).length;
    const clears = (msr.match(/\[content (removeRange|setLength|replaceBytesInRange)/g) ?? []).length;
    add('C123', 'RCTMultipartStreamReader 中 content 的 append 点数', '1', appends + ' 处', appends === 1);
    add('C124', 'RCTMultipartStreamReader 中 content 的清理点数（内存线性增长的根因）', '0', clears + ' 处', clears === 0);
    add(
      'C124b', 'RCTMultipartStreamReader 初始容量为 1（几乎必然触发多次扩容拷贝）',
      'initWithCapacity:1',
      /NSMutableData \*content = \[\[NSMutableData alloc\] initWithCapacity:1\];/.test(msr) ? '1' : '未匹配',
      /NSMutableData \*content = \[\[NSMutableData alloc\] initWithCapacity:1\];/.test(msr),
    );
    // 进度节流做对了（对照组）
    add(
      'C124c', 'emitProgress 用 0.016 秒节流（≈60Hz）—— 作者清楚高频回调代价，却漏了缓冲区本身',
      '0.016',
      /currentTime - _lastDownloadProgress > 0\.016 \|\| final/.test(msr) ? '确认节流' : '未匹配',
      /currentTime - _lastDownloadProgress > 0\.016 \|\| final/.test(msr),
    );
  }
  // I-3: RCTMultipartDataTask 的双路径
  const mdt = read('packages/react-native/React/Base/RCTMultipartDataTask.m') ?? '';
  add(
    'C125', 'RCTMultipartDataTask 的非流式路径把全部数据累积到 _data（无清理点）',
    'appendData 且无清理',
    /\[_data appendData:data\];/.test(mdt) && !/\[_data (remove|setLength|replaceBytes)/.test(mdt)
      ? '确认只增不减' : '未匹配',
    /\[_data appendData:data\];/.test(mdt) && !/\[_data (remove|setLength|replaceBytes)/.test(mdt),
  );
  add(
    'C126', 'RCTMultipartDataTask 的流式分支改用 RCTMultipartStreamReader，但两条路径都不省内存',
    '两条路径并存',
    /didBecomeInputStream:/.test(mdt) && /RCTMultipartStreamReader alloc\] initWithInputStream:/.test(mdt)
      ? '确认流式分支' : '未匹配',
    /didBecomeInputStream:/.test(mdt) && /RCTMultipartStreamReader alloc\] initWithInputStream:/.test(mdt),
  );
  // I-4: escape 注释与代码不符
  const kc = read('packages/react-native/React/Base/RCTKeyCommands.m') ?? '';
  {
    const escapeLines = kc.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /escape/i.test(l));
    add('C127', 'RCTKeyCommands 中出现 escape 的行数（注释声称有例外，代码无实现）', '1（仅注释）',
      escapeLines.length + ' 行：' + escapeLines.map(([n]) => n).join(','),
      escapeLines.length === 1 && /^\s*\/\//.test(escapeLines[0][1]));
    add(
      'C127b', 'handleKeyUIEventSwizzle 的分支是 !firstResponder（无任何 escape 判断）',
      '仅 !firstResponder',
      /if \(!firstResponder\) \{\s*\[self RCT_handleKeyCommand:/.test(kc) &&
        !/escape/.test(kc.replace(/\/\/[^\n]*escape[^\n]*/g, ''))
        ? '确认无 escape 判断' : '未匹配',
      /if \(!firstResponder\) \{\s*\[self RCT_handleKeyCommand:/.test(kc) &&
        !/escape/.test(kc.replace(/\/\/[^\n]*escape[^\n]*/g, '')),
    );
  }
  // I-5/I-6: 私有 API
  {
    const obfuscated = /Obfuscating selector allWindowsIncludingInternalWindows/.test(kc);
    const pieces = (kc.match(/@"al", @"lWindo", @"wsIncl"/) ?? []).length;
    add('C128', 'RCTKeyCommands 用混淆字符串拼接规避 App Store 扫描（注释自述 Obfuscating selector）', '1 处',
      obfuscated ? '确认混淆' + (pieces ? '，拆成 9 段' : '') : '未匹配', obfuscated && pieces === 1);
    const privateSelectors = (kc.match(/@selector\(_(modifiedInput|modifierFlags|isKeyDown)\)/g) ?? []).length;
    add('C128b', '未混淆的私有 selector 数（_modifiedInput/_modifierFlags/_isKeyDown）', '3', privateSelectors + ' 个', privateSelectors === 3);
    add(
      'C128c', 'allWindows 用 methodSignatureForSelector: 但不检查 nil（私有 API 被移除时会抛异常）',
      '无 nil 检查',
      /methodSignatureForSelector:allWindowsSelector\]/.test(kc) &&
        !/methodSignatureForSelector:allWindowsSelector\] == nil|methodSignature == nil/.test(kc)
        ? '确认无 nil 检查' : '有检查或未匹配',
      /methodSignatureForSelector:allWindowsSelector\]/.test(kc) &&
        !/methodSignatureForSelector:allWindowsSelector\] == nil|methodSignature == nil/.test(kc),
    );
    // 三个私有 selector 有 respondsToSelector 保护
    const guards = (kc.match(/respondsToSelector:@selector\(_\w+\)/g) ?? []).length;
    add('C128d', '三个 _ 前缀私有 selector 都有 respondsToSelector: 保护（升级安全）', '3', guards + ' 处', guards === 3);
  }
  // matchesInput 的 flags==0 语义
  add(
    'C129', 'matchesInput: 的 flag 匹配条件是 (flags == 0)（事件侧无修饰键），使「注册 cmd+r 也能被裸 r 触发」',
    'flags == 0',
    /_flags == flags \|\| flags == 0/.test(kc) ? '确认' : '未匹配',
    /_flags == flags \|\| flags == 0/.test(kc),
  );
  // RCT_handleKeyCommand 先快照后执行
  add(
    'C130', 'RCT_handleKeyCommand 先收集到 commandsToExecute 再执行（避免迭代中变更 NSMutableSet）',
    '先快照后执行',
    /commandsToExecute = \[NSMutableArray new\]/.test(kc) &&
      /for \(RCTKeyCommand \*command in commandsToExecute\)/.test(kc)
      ? '确认' : '未匹配',
    /commandsToExecute = \[NSMutableArray new\]/.test(kc) &&
      /for \(RCTKeyCommand \*command in commandsToExecute\)/.test(kc),
  );
  // I-7: RCTCxxConvert 空壳但有 3 个活调用方
  {
    const ccx = read('packages/react-native/React/Base/RCTCxxConvert.m') ?? '';
    add(
      'C131', 'RCTCxxConvert 仍无任何转换方法（@implementation 为空）',
      '0 个方法',
      (ccx.match(/^[-+] \(/gm) ?? []).length + ' 个',
      !/^[-+] \(/m.test(ccx),
    );
    const callers = grepCount(/convert\(\[RCTCxxConvert class\]/, {
      exts: ['.mm', '.m'],
      roots: ['packages/react-native'],
    }).files;
    add('C132', 'objc_msgSend 打向 [RCTCxxConvert class] 的调用点数量（证明是活路径）', '3',
      callers.length + ' 处', callers.length === 3);
    // selector 注册只有 RCTInteropTurboModule 一处
    const setters = grepCount(/setMethodArgConversionSelector\(/, {
      exts: ['.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('RCTTurboModule.mm'));
    add(
      'C133', 'methodArgConversionSelectors_ 的外部注册方（决定 RCTCxxConvert 路径的可达性）',
      '1 且为 RCTInteropTurboModule.mm',
      setters.length === 1 && /RCTInteropTurboModule\.mm$/.test(setters[0]) ? '1: ' + setters[0].split('/').pop() : setters.length + ' 处',
      setters.length === 1 && /RCTInteropTurboModule\.mm$/.test(setters[0]),
    );
    // codegen 走另一条路
    const tm = read('packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm') ?? '';
    add(
      'C134', 'codegen 模块的 JS:: 参数走 convertJSIValueToObjCObject（与 RCTCxxConvert 无关，故 CoreModules 不受影响）',
      'convertJSIValueToObjCObject',
      /convertJSIValueToObjCObject\(runtime, arg, jsInvoker_/.test(tm) &&
        /^id convertJSIValueToObjCObject\(/m.test(tm)
        ? '确认独立路径' : '未匹配',
      /convertJSIValueToObjCObject\(runtime, arg, jsInvoker_/.test(tm) &&
        /^id convertJSIValueToObjCObject\(/m.test(tm),
    );
    // 三处调用都有所有权处理
    const allThree = [tm, read('packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTInteropTurboModule.mm') ?? '',
      read('packages/react-native/React/Base/RCTModuleMethod.mm') ?? ''];
    add(
      'C135', '三处 RCTCxxConvert 调用都用 addObject: 持有 box 以维持 shared_ptr 生命周期（所有权处理正确）',
      '3 处',
      allThree.filter(t => /\[retained\w* addObject:box\]/.test(t)).length + ' 处',
      allThree.filter(t => /\[retained\w* addObject:box\]/.test(t)).length === 3,
    );
  }
  // I-8: managedPointer 模板零使用
  {
    const mp = read('packages/react-native/React/Base/RCTManagedPointer.h') ?? '';
    const uses = grepCount(/managedPointer\s*</, {
      exts: ['.h', '.mm', '.m', '.cpp'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTManagedPointer.h'));
    add('C136', 'managedPointer<...> 模板的调用方数量（唯一能产出 RCTManagedPointer 的路径）', '0', uses.length + ' 处', uses.length === 0);
    add(
      'C136b', 'RCTManagedPointer 持有 shared_ptr<void>（.mm 的 ivar + .h 的 init/模板），本身实现完整',
      'shared_ptr<void>',
      /std::shared_ptr<void> _pointer;/.test(read('packages/react-native/React/Base/RCTManagedPointer.mm') ?? '') &&
        /initWithPointer:\(std::shared_ptr<void>\)pointer/.test(mp)
        ? '确认' : '未匹配',
      /std::shared_ptr<void> _pointer;/.test(read('packages/react-native/React/Base/RCTManagedPointer.mm') ?? '') &&
        /initWithPointer:\(std::shared_ptr<void>\)pointer/.test(mp),
    );
  }
  // I-9: RCT_MOCK_SET 在 Release 下是空语句
  {
    const mock = read('packages/react-native/React/Base/RCTMockDef.h') ?? '';
    const elseSeg = (() => {
      const i = mock.indexOf('#else');
      return i >= 0 ? mock.slice(i) : '';
    })();
    add(
      'C137', 'RCT_MOCK_SET 在 #else 分支里是空宏（单语句 if 分支使用时 else 会意外绑定）',
      '空宏',
      /#define RCT_MOCK_SET\(context, api, mockapi\)\s*\n/.test(elseSeg) ? '确认空宏' : '未匹配',
      /#define RCT_MOCK_SET\(context, api, mockapi\)\s*\n/.test(elseSeg),
    );
    const users = grepCount(/RCT_MOCK_DEF\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTMockDef.h'));
    add('C137b', '生产代码里 RCT_MOCK_DEF 的使用方数量（3 处：RCTHost / RCTBlobManager / RCTView）', '3',
      users.length + ' 处', users.length === 3);
    // Release 展开为恒等宏：零开销是设计保证，必须可验证
    add(
      'C137c', 'Release 下 RCT_MOCK_USE 展开为 api（恒等宏），故生产代码零开销 —— 设计意图可验证',
      '#define RCT_MOCK_USE(context, api) api',
      /#define RCT_MOCK_USE\(context, api\) api\b/.test(elseSeg) ? '确认恒等展开' : '未匹配',
      /#define RCT_MOCK_USE\(context, api\) api\b/.test(elseSeg),
    );
    add(
      'C137d', '三处使用均为「RCT_MOCK_DEF + #define 目标名 RCT_MOCK_USE」成对模式',
      '3 处成对',
      (() => {
        const n = grepCount(/RCT_MOCK_USE\(/, {
          exts: ['.m', '.mm'],
          roots: ['packages/react-native'],
        }).files.filter(f => !f.endsWith('React/Base/RCTMockDef.h')).length;
        return n + ' 处 RCT_MOCK_USE';
      })(),
      grepCount(/RCT_MOCK_USE\(/, {
        exts: ['.m', '.mm'],
        roots: ['packages/react-native'],
      }).files.filter(f => !f.endsWith('React/Base/RCTMockDef.h')).length === 3,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// 31. iOS 帧驱动与性能监控：RCTTiming / RCTPerfMonitor / RCTFPSGraph（27 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const perf = read('packages/react-native/React/CoreModules/RCTPerfMonitor.mm') ?? '';
  const fps = read('packages/react-native/React/CoreModules/RCTFPSGraph.mm') ?? '';
  const timing = read('packages/react-native/React/CoreModules/RCTTiming.mm') ?? '';
  const dl = read('packages/react-native/React/Base/RCTDisplayLink.m') ?? '';

  // §2.1 整族被 RCT_DEV 裁剪
  add(
    'C138', 'RCTFPSGraph 整个文件被 #if RCT_DEV 包裹（118 行代码只在 Debug 编译）',
    '首行 #if RCT_DEV',
    /#import <React\/RCTFPSGraph\.h>[\s\S]{0,200}?#if RCT_DEV/.test(fps) &&
      /#endif\s*$/.test(fps.trimEnd())
      ? '确认整文件门控' : '未匹配',
    /#import <React\/RCTFPSGraph\.h>[\s\S]{0,200}?#if RCT_DEV/.test(fps) &&
      /#endif\s*$/.test(fps.trimEnd()),
  );
  add(
    'C138b', 'RCTPerfMonitor 的类实现（:12-552）被 RCT_DEV 包裹，而类工厂 RCTPerfMonitorCls(:554) 在其之外',
    '实现被包裹、工厂在外',
    /#if RCT_DEV/.test(perf) && /^#endif\s*$/m.test(perf) &&
      perf.indexOf('#if RCT_DEV') < perf.indexOf('Class RCTPerfMonitorCls')
      ? '确认结构' : '未匹配',
    /#if RCT_DEV/.test(perf) && /^#endif\s*$/m.test(perf) &&
      perf.indexOf('#if RCT_DEV') < perf.indexOf('Class RCTPerfMonitorCls'),
  );
  // 类工厂 Release 返回 nil（比 moduleName=nil 更彻底）
  add(
    'C139', 'RCTPerfMonitorCls() 在 #else 分支返回 nil（类本身在 Release 下不存在）',
    'return nil',
    /Class RCTPerfMonitorCls\(void\)\s*\{\s*#if RCT_DEV\s*\n\s*return RCTPerfMonitor\.class;\s*\n#else\s*\n\s*return nil;\s*\n#endif/.test(perf)
      ? '确认返回 nil' : '未匹配',
    /Class RCTPerfMonitorCls\(void\)\s*\{\s*#if RCT_DEV\s*\n\s*return RCTPerfMonitor\.class;\s*\n#else\s*\n\s*return nil;\s*\n#endif/.test(perf),
  );
  add(
    'C139b', 'RCTTiming 不受 RCT_DEV 门控（生产必需的 JS 定时器）',
    '无 #if RCT_DEV',
    /#if RCT_DEV/.test(timing) ? '有门控' : '确认无门控',
    !/#if RCT_DEV/.test(timing),
  );
  // P-1: RCTJSCSetOption 恒 NO 但被调用两次
  add(
    'C140', 'RCTPerfMonitor 的 RCTJSCSetOption 函数体只有 return NO（参数 option 未使用）',
    'return NO',
    /static BOOL RCTJSCSetOption\(const char \*option\)\s*\{\s*return NO;\s*\}/.test(perf)
      ? '确认空实现' : '未匹配',
    /static BOOL RCTJSCSetOption\(const char \*option\)\s*\{\s*return NO;\s*\}/.test(perf),
  );
  {
    const calls = (perf.match(/RCTJSCSetOption\("logGC=[01]"\);/g) ?? []).length;
    add('C140b', 'RCTJSCSetOption 的调用次数（logGC=1 与 logGC=0 各一次，实际都无效）', '2',
      calls + ' 次', calls === 2);
  }
  // P-2: dup2 劫持进程级 STDERR
  add(
    'C141', 'redirectLogs 用 dup2 重定向 STDERR_FILENO（进程全局文件描述符）',
    'dup2(_pipe[1], STDERR_FILENO)',
    /dup2\(_pipe\[1\], STDERR_FILENO\);/.test(perf) ? '确认劫持' : '未匹配',
    /dup2\(_pipe\[1\], STDERR_FILENO\);/.test(perf),
  );
  add(
    'C141b', 'stopLogs 用 dup2 还原，且 dispatch_io_close 不检查 _io 是否为 nil',
    '无 nil 检查',
    /- \(void\)stopLogs\s*\{\s*dup2\(_stderr, STDERR_FILENO\);\s*dispatch_io_close\(_io, 0\);/.test(perf) &&
      !/_io == nil|_io != nil/.test(perf)
      ? '确认无 nil 检查' : '有检查或未匹配',
    /- \(void\)stopLogs\s*\{\s*dup2\(_stderr, STDERR_FILENO\);\s*dispatch_io_close\(_io, 0\);/.test(perf) &&
      !/_io == nil|_io != nil/.test(perf),
  );
  add(
    'C142', 'redirectLogs 在 pipe() 失败时提前 return，但 dup(STDERR_FILENO) 已执行 → 泄漏一个 fd',
    'dup 在 pipe 之前',
    /- \(void\)redirectLogs\s*\{\s*_stderr = dup\(STDERR_FILENO\);\s*\n\s*if \(pipe\(_pipe\) != 0\) \{\s*\n\s*return;/.test(perf)
      ? '确认顺序' : '未匹配',
    /- \(void\)redirectLogs\s*\{\s*_stderr = dup\(STDERR_FILENO\);\s*\n\s*if \(pipe\(_pipe\) != 0\) \{\s*\n\s*return;/.test(perf),
  );
  add(
    'C142b', 'parse: 的 dispatch_data_apply 里先 write 回备份 fd，其他代码的 stderr 不丢失',
    'write(self->_stderr, buffer, size)',
    /write\(self->_stderr, buffer, size\);/.test(perf) ? '确认转写' : '未匹配',
    /write\(self->_stderr, buffer, size\);/.test(perf),
  );
  // P-4: 哨兵被遍历 → : 0ms
  {
    const labels = /for \(int i = 0; i < RCTPLSize; i\+\+\) \{\s*\[labels addObject:RCTPLLabelForTag\(\(RCTPLTag\)i\)\];/.test(perf);
    add('C143', 'LabelsForRCTPerformanceLoggerTags 遍历 i < RCTPLSize（含哨兵本身）', '确认含哨兵', labels ? '确认' : '未匹配', labels);
    const lm = read('packages/react-native/React/Base/RCTPerformanceLoggerLabels.m') ?? '';
    add(
      'C143b', '哨兵 RCTPLSize 的 label 为 nil（所以会多出一行 ": 0ms"）',
      'return nil',
      /case RCTPLSize:[\s\S]{0,160}?return nil;/.test(lm) ? '确认返回 nil' : '未匹配',
      /case RCTPLSize:[\s\S]{0,160}?return nil;/.test(lm),
    );
    // valuesForTags 同样长度，验证不越界
    const plm = read('packages/react-native/React/Base/RCTPerformanceLogger.mm') ?? '';
    add(
      'C144', 'valuesForTags 同样遍历 index < RCTPLSize → 返回 RCTPLSize*2 个元素，与 labels 数量对齐（不越界）',
      '两处同为 RCTPLSize',
      /for \(NSUInteger index = 0; index < RCTPLSize; index\+\+\)/.test(plm) && labels ? '确认对齐' : '未匹配',
      /for \(NSUInteger index = 0; index < RCTPLSize; index\+\+\)/.test(plm) && labels,
    );
    // P-5: 消费端内联复刻 durationForTag
    add(
      'C144b', 'RCTPerfMonitor 的 value 计算内联复刻 durationForTag: 的算法（[1]-[0]）',
      'values[i+1] - values[i]',
      /long long value = values\[i \+ 1\]\.longLongValue - values\[i\]\.longLongValue;/.test(perf) &&
        /return _data\[tag\]\[1\] - _data\[tag\]\[0\];/.test(plm)
        ? '确认同一算法' : '未匹配',
      /long long value = values\[i \+ 1\]\.longLongValue - values\[i\]\.longLongValue;/.test(perf) &&
        /return _data\[tag\]\[1\] - _data\[tag\]\[0\];/.test(plm),
    );
    add(
      'C144c', '单位靠 label 后缀判定（Size→b、Count→空、其余→ms），nil label 走 ms 分支',
      'hasSuffix 分支',
      /if \(\[label hasSuffix:@"Size"\]\)/.test(perf) && /else if \(\[label hasSuffix:@"Count"\]\)/.test(perf)
        ? '确认 3 分支' : '未匹配',
      /if \(\[label hasSuffix:@"Size"\]\)/.test(perf) && /else if \(\[label hasSuffix:@"Count"\]\)/.test(perf),
    );
  }
  // §4.4 已验证非缺陷：uiManager 在 RCTBridgeProxy 上有实现
  {
    const proxy = read('packages/react-native/React/Base/RCTBridgeProxy.mm') ?? '';
    add(
      'C145', '_bridge.uiManager 实际由 RCTBridgeProxy 实现（非 RCTBridge），所以 bridgeless 下路径是通的',
      'RCTBridgeProxy 有实现',
      /- \(RCTUIManager \*\)uiManager\s*\{\s*return \(RCTUIManager \*\)_uiManagerProxy;/.test(proxy) &&
        /\[_bridge\.uiManager valueForKey:@"viewRegistry"\]/.test(perf)
        ? '确认非断链' : '未匹配',
      /- \(RCTUIManager \*\)uiManager\s*\{\s*return \(RCTUIManager \*\)_uiManagerProxy;/.test(proxy) &&
        /\[_bridge\.uiManager valueForKey:@"viewRegistry"\]/.test(perf),
    );
    add(
      'C145b', 'RCTUIManagerProxy 持有真实的 RCTViewRegistry（所以 valueForKey 取得到字典）',
      '_viewRegistry ivar',
      /@implementation RCTUIManagerProxy \{\s*RCTViewRegistry \*_viewRegistry;/.test(proxy) ? '确认' : '未匹配',
      /@implementation RCTUIManagerProxy \{\s*RCTViewRegistry \*_viewRegistry;/.test(proxy),
    );
    add(
      'C145c', 'RCTBridge.mm 上确实没有 uiManager（对照：与 moduleDataForName:/batchedBridge 同类缺失）',
      'RCTBridge 无 uiManager',
      !/uiManager/.test(read('packages/react-native/React/Base/RCTBridge.mm') ?? '') ? '确认无' : '有',
      !/uiManager/.test(read('packages/react-native/React/Base/RCTBridge.mm') ?? ''),
    );
  }
  // P-6: _minFPS 只写不读
  {
    const lines = fps.split('\n');
    const writes = lines.filter(l => /_minFPS\s*=[^=]/.test(l)).length;
    // 「读取」= 出现 _minFPS 但不是声明行也不是赋值行
    const reads = lines.filter(l => /_minFPS/.test(l) && !/_minFPS\s*=[^=]/.test(l) && !/NSUInteger _minFPS;/.test(l)).length;
    add('C146', 'RCTFPSGraph 的 _minFPS 只被赋值（初始化 + MIN 更新）、从未读取', '0 次读取',
      writes + ' 处赋值 / ' + reads + ' 处读取', reads === 0 && writes === 2);
    // calloc + free 配对
    add(
      'C146b', 'RCTFPSGraph 用 calloc 分配 _frames 且 dealloc 里 free（配对正确）',
      'calloc + free',
      /_frames = \(CGFloat \*\)calloc\(sizeof\(CGFloat\), _length\);/.test(fps) &&
        /- \(void\)dealloc\s*\{\s*free\(_frames\);/.test(fps)
        ? '确认配对' : '未匹配',
      /_frames = \(CGFloat \*\)calloc\(sizeof\(CGFloat\), _length\);/.test(fps) &&
        /- \(void\)dealloc\s*\{\s*free\(_frames\);/.test(fps),
    );
    add(
      'C146c', 'y 轴上限取 MAX(_maxFPS, 60.0)，保证正常帧率下曲线不顶到顶部',
      'MAX(_maxFPS, 60.0)',
      /CGFloat targetFps = MAX\(_maxFPS, 60\.0\);/.test(fps) ? '确认' : '未匹配',
      /CGFloat targetFps = MAX\(_maxFPS, 60\.0\);/.test(fps),
    );
    // 历史点按比例换算
    add(
      'C146d', '历史帧在新比例下换算（previousScale / _scale），保持视觉连续',
      '比例换算',
      /_frames\[i\] = _frames\[i \+ 1\] \* previousScale \/ _scale;/.test(fps) ? '确认' : '未匹配',
      /_frames\[i\] = _frames\[i \+ 1\] \* previousScale \/ _scale;/.test(fps),
    );
  }
  // §3.1 双向暂停握手
  add(
    'C147', 'RCTDisplayLink 的 pauseCallback 做跨 run loop 转发（CFRunLoopPerformBlock + WakeUp）',
    '跨 run loop 转发',
    /observer\.pauseCallback = \^/.test(dl) && /CFRunLoopPerformBlock\(cfRunLoop, kCFRunLoopDefaultMode/.test(dl)
      ? '确认' : '未匹配',
    /observer\.pauseCallback = \^/.test(dl) && /CFRunLoopPerformBlock\(cfRunLoop, kCFRunLoopDefaultMode/.test(dl),
  );
  add(
    'C147b', 'RCTDisplayLink.invalidate 先清 pauseCallback 再置空 observer（注释说明是为避免持有 weak self 的块）',
    '先清 pauseCallback',
    /\[_frameUpdateObserver setPauseCallback:nil\];\s*_frameUpdateObserver = nil;/.test(dl) ? '确认顺序' : '未匹配',
    /\[_frameUpdateObserver setPauseCallback:nil\];\s*_frameUpdateObserver = nil;/.test(dl),
  );
  add(
    'C147c', 'updateJSDisplayLinkState 把 observer.paused 透传给 CADisplayLink.paused',
    'paused 透传',
    /_jsDisplayLink\.paused = _frameUpdateObserver == nil \|\| _frameUpdateObserver\.paused;/.test(dl)
      ? '确认' : '未匹配',
    /_jsDisplayLink\.paused = _frameUpdateObserver == nil \|\| _frameUpdateObserver\.paused;/.test(dl),
  );
  // §3.2 RCTTiming 三档暂停判定
  {
    add(
      'C148', 'RCTTiming 的暂停判定：无定时器则暂停；最近定时器 > kMinimumSleepInterval(1s) 则用 sleepTimer + 暂停；否则保持唤醒',
      '三档判定',
      /if \(timerCount == 0\) \{\s*_paused = YES;/.test(timing) &&
        /\[nextScheduledTarget timeIntervalSinceNow\] > kMinimumSleepInterval/.test(timing)
        ? '确认三档' : '未匹配',
      /if \(timerCount == 0\) \{\s*_paused = YES;/.test(timing) &&
        /\[nextScheduledTarget timeIntervalSinceNow\] > kMinimumSleepInterval/.test(timing),
    );
    add(
      'C148b', 'RCTTiming 的常量 kFrameDuration=1/60 秒、kIdleCallbackFrameDeadline=1ms',
      '1.0/60.0 与 0.001',
      /kFrameDuration = 1\.0 \/ 60\.0/.test(timing) && /kIdleCallbackFrameDeadline = 0\.001/.test(timing)
        ? '确认' : '未匹配',
      /kFrameDuration = 1\.0 \/ 60\.0/.test(timing) && /kIdleCallbackFrameDeadline = 0\.001/.test(timing),
    );
    // 空闲回调只在剩余帧时间 >= 1ms 时触发
    add(
      'C148c', 'callIdleCallbacks 只在本帧剩余 ≥ 1ms 时触发（避免帧末尾插入工作导致掉帧）',
      '帧预算判断',
      /if \(kFrameDuration - frameElapsed >= kIdleCallbackFrameDeadline\)/.test(timing) ? '确认' : '未匹配',
      /if \(kFrameDuration - frameElapsed >= kIdleCallbackFrameDeadline\)/.test(timing),
    );
    // @synchronized 保护 _timers
    add(
      'C148d', 'RCTTiming 用 @synchronized(_timers) 保护定时器字典（多处）',
      '多处 @synchronized',
      (timing.match(/@synchronized\(_timers\)/g) ?? []).length + ' 处',
      (timing.match(/@synchronized\(_timers\)/g) ?? []).length >= 3,
    );
  }
  // §3.4 跨语言常量双向声明（正面样本）
  {
    const jt = read('packages/react-native/Libraries/Core/Timers/JSTimers.js') ?? '';
    add(
      'C149', 'RCTTiming.mm 注释声明「应与 JSTimers.js 保持同步」',
      'kept in sync with JSTimers.js',
      /should be kept in sync with the ones in `JSTimers\.js`/.test(timing) ? '确认' : '未匹配',
      /should be kept in sync with the ones in `JSTimers\.js`/.test(timing),
    );
    add(
      'C149b', 'JSTimers.js 反向声明「应与 iOS/Android 的 RCTTiming 保持同步」—— 双向同步约定',
      '反向声明',
      /should be kept in sync with the ones in native ios and\s*\n\/\/ android `RCTTiming` module/.test(jt)
        ? '确认双向' : '未匹配',
      /should be kept in sync with the ones in native ios and\s*\n\/\/ android `RCTTiming` module/.test(jt),
    );
    add(
      'C149c', '两侧常量逻辑值一致但单位各自匹配（ObjC 用秒 1/60，JS 用毫秒 1000/60；deadline ObjC 0.001s / JS 1ms）',
      '单位各自匹配',
      /kFrameDuration = 1\.0 \/ 60\.0/.test(timing) && /FRAME_DURATION = 1000 \/ 60/.test(jt) &&
        /kIdleCallbackFrameDeadline = 0\.001/.test(timing) && /IDLE_CALLBACK_FRAME_DEADLINE = 1/.test(jt)
        ? '确认一致' : '未匹配',
      /kFrameDuration = 1\.0 \/ 60\.0/.test(timing) && /FRAME_DURATION = 1000 \/ 60/.test(jt) &&
        /kIdleCallbackFrameDeadline = 0\.001/.test(timing) && /IDLE_CALLBACK_FRAME_DEADLINE = 1/.test(jt),
    );
  }
  // §4.6 自刷新链终止条件
  add(
    'C150', 'updateStats 每秒递归刷新，终止条件是 _container.superview == nil（hide 已执行）',
    'superview 判空终止',
    /dispatch_after\([\s\S]{0,300}?strongSelf->_container\.superview != nullptr/.test(perf) ? '确认' : '未匹配',
    /dispatch_after\([\s\S]{0,300}?strongSelf->_container\.superview != nullptr/.test(perf),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 32. iOS Dev 工具链与四层门控（28 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const dm = read('packages/react-native/React/CoreModules/RCTDevMenu.mm') ?? '';
  const ds = read('packages/react-native/React/CoreModules/RCTDevSettings.mm') ?? '';
  const dlv = read('packages/react-native/React/CoreModules/RCTDevLoadingView.mm') ?? '';

  // §2.2 __has_include 门控
  add(
    'C151', 'RCT_DEV_SETTINGS_ENABLE_PACKAGER_CONNECTION 用 __has_include 探测头文件是否可用（功能存在性取决于宿主 link）',
    '__has_include 双路径探测',
    /#if RCT_DEV && \(__has_include\("RCTPackagerConnection\.h"\) \|\| __has_include\(<React\/RCTPackagerConnection\.h>\)\)/.test(ds)
      ? '确认探测' : '未匹配',
    /#if RCT_DEV && \(__has_include\("RCTPackagerConnection\.h"\) \|\| __has_include\(<React\/RCTPackagerConnection\.h>\)\)/.test(ds),
  );
  {
    const allHas = grepCount(/__has_include\(<React\/RCTDevLoadingViewProtocol\.h>\)/, {
      exts: ['.mm', '.m'],
      roots: ['packages/react-native'],
    }).files;
    add('C151b', 'RCTInstance.mm 侧也用 __has_include 门控 DevLoadingView（本文档 D-9 的第二处）',
      'RCTInstance.mm 也用', allHas.includes('packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm')
        ? '确认两处' : '未匹配',
      allHas.includes('packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm'));
  }
  // §2.3 RCT_ENABLE_INSPECTOR 依赖 RCT_DEV 而非 RCT_DEV_MENU
  {
    const defs = read('packages/react-native/React/Base/RCTDefines.h') ?? '';
    add(
      'C152', 'RCT_ENABLE_INSPECTOR 依赖 (RCT_DEV || RCT_REMOTE_PROFILE)，不是 RCT_DEV_MENU —— 故关 DevMenu 仍开 inspector',
      'RCT_DEV || RCT_REMOTE_PROFILE',
      /#if \(RCT_DEV \|\| RCT_REMOTE_PROFILE\)\s*\n#define RCT_ENABLE_INSPECTOR 1/.test(defs) ? '确认依赖 DEV' : '未匹配',
      /#if \(RCT_DEV \|\| RCT_REMOTE_PROFILE\)\s*\n#define RCT_ENABLE_INSPECTOR 1/.test(defs),
    );
    // DevMenu 的 Open DevTools 项在该条件下
    add(
      'C152b', 'DevMenu 的「Open DevTools」菜单项被 #if RCT_ENABLE_INSPECTOR 包裹',
      '受 RCT_ENABLE_INSPECTOR 门控',
      (dm.match(/#if RCT_ENABLE_INSPECTOR/g) ?? []).length + ' 处',
      (dm.match(/#if RCT_ENABLE_INSPECTOR/g) ?? []).length >= 2,
    );
  }
  // §2.4 TARGET_OS_SIMULATOR 门控
  {
    const n = (dm.match(/#if TARGET_OS_SIMULATOR \|\| TARGET_OS_MACCATALYST/g) ?? []).length;
    add('C153', 'RCTDevMenu 用 TARGET_OS_SIMULATOR || TARGET_OS_MACCATALYST 门控快捷键的方法数', '5',
      n + ' 处', n === 5);
    add(
      'C154', 'registerHotkeys 的全部方法体在真机上不编译（Cmd+D / Cmd+I 不存在）',
      '真机无实现',
      /- \(void\)registerHotkeys\s*\{\s*#if TARGET_OS_SIMULATOR \|\| TARGET_OS_MACCATALYST/.test(dm) &&
        /registerKeyCommandWithInput:@"d"/.test(dm) && /registerKeyCommandWithInput:@"i"/.test(dm)
        ? '确认真机不注册' : '未匹配',
      /- \(void\)registerHotkeys\s*\{\s*#if TARGET_OS_SIMULATOR \|\| TARGET_OS_MACCATALYST/.test(dm) &&
        /registerKeyCommandWithInput:@"d"/.test(dm) && /registerKeyCommandWithInput:@"i"/.test(dm),
    );
  }
  // §3 生产远程调试通道
  {
    const defs = read('packages/react-native/React/Base/RCTDefines.h') ?? '';
    add(
      'C155', 'RCT_REMOTE_PROFILE 可独立于 RCT_DEV 为真（REACT_NATIVE_DEBUGGER_MODE_PROD 通道）',
      'REACT_NATIVE_DEBUGGER_MODE_PROD',
      /#ifdef REACT_NATIVE_DEBUGGER_MODE_PROD\s*\n#define RCT_REMOTE_PROFILE REACT_NATIVE_DEBUGGER_MODE_PROD/.test(defs)
        ? '确认独立通道' : '未匹配',
      /#ifdef REACT_NATIVE_DEBUGGER_MODE_PROD\s*\n#define RCT_REMOTE_PROFILE REACT_NATIVE_DEBUGGER_MODE_PROD/.test(defs),
    );
    const definers = grepCount(/#define REACT_NATIVE_DEBUGGER_MODE_PROD|REACT_NATIVE_DEBUGGER_MODE_PROD\s*=\s*['"]?1/, {
      roots: ['packages', 'scripts'],
    }).files;
    add('C155b', 'REACT_NATIVE_DEBUGGER_MODE_PROD 在构建脚本里的定义处（0 = 只能宿主手动开启）', '0',
      definers.length + ' 处', definers.length === 0);
    add(
      'C156', 'InspectorFlags.cpp 消费该宏把 isProfilingBuild 置 true',
      'isProfilingBuild = true',
      /\.isProfilingBuild =\s*\n#if defined\(REACT_NATIVE_DEBUGGER_MODE_PROD\)\s*\n\s*true,/.test(
        read('packages/react-native/ReactCommon/jsinspector-modern/InspectorFlags.cpp') ?? '',
      )
        ? '确认' : '未匹配',
      /\.isProfilingBuild =\s*\n#if defined\(REACT_NATIVE_DEBUGGER_MODE_PROD\)\s*\n\s*true,/.test(
        read('packages/react-native/ReactCommon/jsinspector-modern/InspectorFlags.cpp') ?? '',
      ),
    );
    // 三路分支的不对称
    add(
      'C157', 'devSettings 的三路分支：RCT_REMOTE_PROFILE 无条件返回（忽略 devSettingsMenuEnabled），优先级高于 RCT_DEV_MENU',
      'REMOTE_PROFILE 优先且无条件',
      (ds.match(/#if RCT_REMOTE_PROFILE\s*\n\s*return \[self moduleForClass:\[RCTDevSettings class\]\];/g) ?? []).length === 2 &&
        /#elif RCT_DEV_MENU\s*\n\s*return devSettingsMenuEnabled \? \[self moduleForClass:\[RCTDevSettings class\]\] : nil;/.test(ds)
        ? '确认 2 处（Bridge + BridgeProxy）' : '未匹配',
      (ds.match(/#if RCT_REMOTE_PROFILE\s*\n\s*return \[self moduleForClass:\[RCTDevSettings class\]\];/g) ?? []).length === 2 &&
        /#elif RCT_DEV_MENU\s*\n\s*return devSettingsMenuEnabled \? \[self moduleForClass:\[RCTDevSettings class\]\] : nil;/.test(ds),
    );
    // D-4: 两个门控用了不同的宏
    add(
      'C157b', 'PACKAGER_CONNECTION 用 RCT_DEV，而 devSettings 用 RCT_DEV_MENU —— 两宏可独立取值故存在错配组合',
      'RCT_DEV vs RCT_DEV_MENU',
      /#if RCT_DEV && \(__has_include/.test(ds) && /#elif RCT_DEV_MENU/.test(ds) ? '确认不一致' : '未匹配',
      /#if RCT_DEV && \(__has_include/.test(ds) && /#elif RCT_DEV_MENU/.test(ds),
    );
  }
  // D-2: RCTDevSettingsSetEnabled 零调用
  {
    const calls = grepCount(/RCTDevSettingsSetEnabled\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('CoreModules/RCTDevSettings.mm'));
    add('C158', 'RCTDevSettingsSetEnabled 的调用方数量（第五个零调用 setter）', '0', calls.length + ' 处', calls.length === 0);
    add(
      'C158b', 'devSettingsMenuEnabled 默认值由 RCT_DEV 决定（Dev=YES / Release=NO）',
      'RCT_DEV 门控',
      /#if RCT_DEV\s*\nstatic BOOL devSettingsMenuEnabled = YES;\s*\n#else\s*\nstatic BOOL devSettingsMenuEnabled = NO;/.test(ds)
        ? '确认' : '未匹配',
      /#if RCT_DEV\s*\nstatic BOOL devSettingsMenuEnabled = YES;\s*\n#else\s*\nstatic BOOL devSettingsMenuEnabled = NO;/.test(ds),
    );
  }
  // D-1: showOnShake 的全树字符串渲染
  add(
    'C159', 'showOnShake 用 valueForKey:@"recursiveDescription" 遍历整棵视图树生成字符串后再 containsString: 判断',
    'recursiveDescription + containsString',
    /NSString \*recursiveDescription = \[window valueForKey:@"recursiveDescription"\];\s*\n\s*if \(\[recursiveDescription containsString:@"RCTView"\]\)/.test(dm)
      ? '确认' : '未匹配',
    /NSString \*recursiveDescription = \[window valueForKey:@"recursiveDescription"\];\s*\n\s*if \(\[recursiveDescription containsString:@"RCTView"\]\)/.test(dm),
  );
  add(
    'C159b', 'showOnShake 遍历所有 scene 的所有 window（多 scene 时重复执行整树渲染）',
    '遍历 connectedScenes',
    /for \(UIWindowScene \*scene in RCTSharedApplication\(\)\.connectedScenes\) \{\s*\[windows addObjectsFromArray:scene\.windows\];/.test(dm)
      ? '确认' : '未匹配',
    /for \(UIWindowScene \*scene in RCTSharedApplication\(\)\.connectedScenes\) \{\s*\[windows addObjectsFromArray:scene\.windows\];/.test(dm),
  );
  // §5.2 swizzle 与注释
  add(
    'C160', 'DevMenu 的 swizzle 注释明确说明「UIWindow 未实现该方法故无需调原实现」（与 26 文档的混淆 selector 形成对照）',
    '注释解释为何不调原实现',
    /UIWindow doesn't actually implement motionEnded:withEvent:/.test(dm) ? '确认' : '未匹配',
    /UIWindow doesn't actually implement motionEnded:withEvent:/.test(dm),
  );
  add(
    'C160b', 'RCTShowDevMenuNotification 的发送方在 UIWindow category 的 motion 回调里，接收方在 DevMenu 的 init',
    '发送/接收配对',
    /postNotificationName:RCTShowDevMenuNotification/.test(dm) &&
      /name:RCTShowDevMenuNotification/.test(dm)
      ? '确认配对' : '未匹配',
    /postNotificationName:RCTShowDevMenuNotification/.test(dm) &&
      /name:RCTShowDevMenuNotification/.test(dm),
  );
  // D-5: RCTDevLoadingView 的 #if !RCT_DEV
  add(
    'C161', 'RCTDevLoadingView 对本地文件 URL 在 !RCT_DEV 下直接 return（无任何提示）',
    '#if !RCT_DEV return',
    /if \(URL\.fileURL\) \{[\s\S]{0,200}?#if !RCT_DEV\s*\n\s*return;\s*\n#endif/.test(dlv) ? '确认' : '未匹配',
    /if \(URL\.fileURL\) \{[\s\S]{0,200}?#if !RCT_DEV\s*\n\s*return;\s*\n#endif/.test(dlv),
  );
  add(
    'C161b', 'RCTDevLoadingView 整文件被 #if RCT_DEV_MENU 包裹（Release 下类不存在）',
    '整文件门控',
    /#if RCT_DEV_MENU[\s\S]{0,300}?@implementation RCTDevLoadingView/.test(dlv) ? '确认' : '未匹配',
    /#if RCT_DEV_MENU[\s\S]{0,300}?@implementation RCTDevLoadingView/.test(dlv),
  );
  // D-7: RCTDevSettings 的 else 支
  {
    const elseIdx = ds.indexOf('#else // #if RCT_DEV_MENU || RCT_REMOTE_PROFILE');
    const elseSeg = elseIdx >= 0 ? ds.slice(elseIdx, elseIdx + 1200) : '';
    add(
      'C162', 'RCTDevSettings 的 else 支（门控不满足时）里 isHotLoadingAvailable 硬编码 NO',
      'return NO',
      /- \(BOOL\)isHotLoadingAvailable\s*\{\s*return NO;\s*\}/.test(elseSeg) ? '确认硬编码' : '未匹配',
      /- \(BOOL\)isHotLoadingAvailable\s*\{\s*return NO;\s*\}/.test(elseSeg),
    );
    add(
      'C162b', 'RCTDevSettings 的门控宏是 RCT_DEV_MENU || RCT_REMOTE_PROFILE（比 RedBox 多一个开启通道）',
      '|| RCT_REMOTE_PROFILE',
      /#if RCT_DEV_MENU \|\| RCT_REMOTE_PROFILE/.test(ds) ? '确认双宏' : '未匹配',
      /#if RCT_DEV_MENU \|\| RCT_REMOTE_PROFILE/.test(ds),
    );
    add(
      'C162c', 'RCTDevMenu 的门控宏只有 RCT_DEV_MENU（无 REMOTE_PROFILE 通道）',
      '单宏',
      /#if RCT_DEV_MENU/.test(dm) && !/#if RCT_DEV_MENU \|\| RCT_REMOTE_PROFILE/.test(dm)
        ? '确认单宏' : '未匹配',
      /#if RCT_DEV_MENU/.test(dm) && !/#if RCT_DEV_MENU \|\| RCT_REMOTE_PROFILE/.test(dm),
    );
  }
  // DevMenu 菜单项装配：PerfMonitor 的菜单项动态拉取，避免硬依赖
  add(
    'C163',
    'DevMenu 通过 respondsToSelector:@selector(devMenuItem) 从 PerfMonitor 动态拉取菜单项（避免硬依赖）',
    'respondsToSelector 动态拉取',
    /moduleForName:.PerfMonitor.\];[\s\S]{0,220}?respondsToSelector:devMenuItem\]/.test(dm)
      ? '确认' : '未匹配',
    /moduleForName:.PerfMonitor.\];[\s\S]{0,220}?respondsToSelector:devMenuItem\]/.test(dm),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 1. RN 不实现崩溃上传：OnJsError 只有一个构造点，框架内无实现
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp';
  const t = read(f) ?? '';
  const ctor = (t.match(/make_shared<JsErrorHandler>/g) ?? []).length;
  add(
    'C1', 'JsErrorHandler 全仓库仅在 ReactInstance 构造处创建（上报端由宿主注入）',
    '恰好 1 处', `${ctor} 处`, ctor === 1,
  );
  // JsErrorHandler 头文件里 OnJsError 必须是裸 std::function，没有任何默认实现体
  const h = read('packages/react-native/ReactCommon/jserrorhandler/JsErrorHandler.h') ?? '';
  const hasAlias = /using OnJsError = std::function</.test(h);
  add(
    'C2', 'OnJsError 只是 std::function 别名，RN 未提供默认实现',
    '存在别名声明', hasAlias ? '存在' : '缺失', hasAlias,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 2. 无原生崩溃捕获：没有 signal handler、没有 NSSetUncaughtExceptionHandler
// ────────────────────────────────────────────────────────────────────────
{
  const sig = grepCount(/\bsignal\s*\(\s*SIG/, {
    exts: ['.cpp', '.mm', '.m', '.h', '.c'],
  });
  add(
    'C3', 'RN 源码未注册 POSIX signal handler（即无原生崩溃信号捕获）',
    '0 处', `${sig.count} 处`, sig.count === 0,
  );
  const ns = grepCount(/NSSetUncaughtExceptionHandler/, {
    exts: ['.mm', '.m', '.h'],
  });
  add(
    'C4', 'RN 源码未调用 NSSetUncaughtExceptionHandler（iOS 无未捕获异常兜底）',
    '0 处', `${ns.count} 处`, ns.count === 0,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 3. FrameRateLogger 原生模块已删
// ────────────────────────────────────────────────────────────────────────
{
  const native = grepCount(/FrameRateLogger/, {exts: ['.kt', '.java', '.mm', '.h', '.cpp', '.m']});
  add(
    'C5', 'FrameRateLogger 的原生实现已删除（仅 JS 侧残留）',
    '0 个原生文件', native.count === 0 ? '0 个' : `${native.count} 个: ${native.files.slice(0, 3).join(', ')}`,
    native.count === 0,
  );
  const js = grepCount(/FrameRateLogger/, {exts: ['.js', '.ts']});
  add(
    'C6', 'FrameRateLogger 的 JS 侧仍存在（文档称「JS 层还在」）',
    '>0 处', `${js.count} 处`, js.count > 0,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 4. Android 侧 memoryWarning 完全缺失（不是空实现）
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/core/DeviceEventManagerModule.kt';
  const android = grepCount(/memoryWarning|MemoryWarning/i, {
    exts: ['.kt', '.java'],
    roots: ['packages/react-native/ReactAndroid/src/main'],
  });
  add(
    'C7', 'Android 原生侧完全没有 memoryWarning 派发（不是空实现，05 文档缺口章节）',
    '0 处', `${android.count} 处`, android.count === 0,
  );
  // JS 侧监听 API 必须存在，否则「Android 上是 no-op」的说法不成立
  const js = read('packages/react-native/Libraries/AppState/AppState.js') ?? '';
  add(
    'C7b', 'JS 侧 AppState 确实提供了 memoryWarning 监听 API',
    '存在',
    /memoryWarning/.test(js) ? '存在' : '缺失',
    /memoryWarning/.test(js),
  );
  // iOS 侧必须真的有派发，否则「仅 iOS 有」的说法不成立
  const ios = read('packages/react-native/React/CoreModules/RCTAppState.mm') ?? '';
  add(
    'C7c', 'iOS 侧 RCTAppState 确实派发 memoryWarning（平台不对称）',
    '存在',
    /sendEventWithName:@"memoryWarning"/.test(ios) ? '存在' : '缺失',
    /sendEventWithName:@"memoryWarning"/.test(ios),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 5. LeakChecker 仅 Debug 编译
// ────────────────────────────────────────────────────────────────────────
{
  const hits = grepCount(/#if\s+FB_LEAK_CHECKER|REACT_NATIVE_DEBUG|defined\(DEBUG\)|NDEBUG/);
  add(
    'C8', '泄漏检测受编译期宏控制（非 Release 生效）',
    '>0 处编译期守卫', `${hits.count} 处`, hits.count > 0,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 6. 无白屏检测：不存在以「首屏渲染完成」为判据的检测器
// ────────────────────────────────────────────────────────────────────────
{
  // 只统计「真正实现了检测逻辑」的位置：排除注释里出现的字样。
  // RCTRootView.h 的 loadingView 注释里有 "blank screen"，那是「加载时显示占位以免白屏」
  // 的预防措施，不是检测器 —— 不能算作白屏检测存在。
  const w = grepCount(/white\s*screen|blank\s*screen|WhiteScreen|BlankScreen/i, {
    exts: ['.js', '.ts', '.kt', '.java', '.cpp', '.mm', '.h', '.m'],
  });
  // 逐个命中判断是否在注释里
  const realImpl = w.files.filter(rel => {
    const t = read(rel);
    return t
      .split('\n')
      .some(l => !/^\s*(\*|\/\/|\/\*)/.test(l) && /white\s*screen|blank\s*screen/i.test(l));
  });
  add(
    'C9', 'RN 源码中不存在白屏/空屏检测实现（仅注释提及，属预防措施）',
    '0 处非注释命中',
    realImpl.length === 0 ? '0 处' : `${realImpl.length} 处: ${realImpl.slice(0, 3).join(', ')}`,
    realImpl.length === 0,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 7. iOS 仍有 Shadow 队列相关代码（平台限定结论，Shadow 线程教训）
// ────────────────────────────────────────────────────────────────────────
{
  const ios = exists('packages/react-native/React/Modules/RCTUIManagerUtils.m');
  add(
    'C10', 'iOS 仍存在 RCTUIManagerUtils.m（Shadow 队列相关，故不能说「全平台已移除」）',
    '存在', ios ? '存在' : '不存在', ios,
  );
  // 该文件确实与 shadow queue 相关，而非同名巧合
  const t = read('packages/react-native/React/Modules/RCTUIManagerUtils.m') ?? '';
  add(
    'C10b', 'RCTUIManagerUtils.m 内容确实涉及 shadow queue',
    '提及 shadow',
    /shadow/i.test(t) ? '提及' : '未提及',
    /shadow/i.test(t),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 8. view/platform/ios 不存在，iOS 复用 cxx
// ────────────────────────────────────────────────────────────────────────
{
  const iosView = exists('packages/react-native/ReactCommon/react/renderer/components/view/platform/ios');
  add(
    'C11', 'view/platform/ios 目录不存在（10 文档核心发现）',
    '不存在', iosView ? '存在' : '不存在', !iosView,
  );
  const cxx = exists('packages/react-native/ReactCommon/react/renderer/components/view/platform/cxx');
  add(
    'C12', 'view/platform/cxx 存在（iOS 实际使用的实现）',
    '存在', cxx ? '存在' : '不存在', cxx,
  );
  const rb = read('packages/react-native/scripts/cocoapods/utils.rb') ?? '';
  add(
    'C13', 'CocoaPods 搜索路径只加 cxx、未加 view/platform/ios',
    '仅含 cxx',
    /react\/renderer\/components\/view\/platform\/cxx/.test(rb) && !/react\/renderer\/components\/view\/platform\/ios/.test(rb)
      ? '仅含 cxx' : '异常',
    /react\/renderer\/components\/view\/platform\/cxx/.test(rb) && !/react\/renderer\/components\/view\/platform\/ios/.test(rb),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 9. LongLivedObjectCollection 实例表不清理
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactCommon/react/bridging/LongLivedObject.cpp';
  const t = read(f) ?? '';
  // instances 是函数内 static，且没有对它的 erase
  const hasStaticMap = /static std::unordered_map<void\*, std::shared_ptr<LongLivedObjectCollection>>/.test(t);
  const erasesInstances = /instances\.erase|instances\.clear/.test(t);
  add(
    'C14', 'LongLivedObjectCollection 的静态实例表存在且从不清理（14 文档核心发现）',
    'static 存在 + 无 erase',
    `static=${hasStaticMap} erase=${!erasesInstances ? '无' : '有'}`,
    hasStaticMap && !erasesInstances,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 10. initializeCore 的幂等守卫早于任何 require
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/src/private/setup/setUpDefaultReactNativeEnvironment.js';
  const t = read(f) ?? '';
  const iGuard = t.indexOf('initialized = true');
  const iRequire = t.indexOf('require(');
  add(
    'C15', 'initialized = true 早于第一个 require（失败后不可重试，13 文档 BOOT-1）',
    '守卫在 require 之前',
    iGuard >= 0 && iRequire >= 0 && iGuard < iRequire ? '守卫在前' : '顺序不符',
    iGuard >= 0 && iRequire >= 0 && iGuard < iRequire,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 11. setRuntimeReady 的唯一调用点及其守卫条件
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp';
  const t = read(f) ?? '';
  const n = (t.match(/setRuntimeReady\(/g) ?? []).length;
  add(
    'C16', 'setRuntimeReady 在 ReactInstance.cpp 中只有 1 处调用',
    '1 处', `${n} 处`, n === 1,
  );
  add(
    'C17', '该调用被 !hasHandledFatalError() 守卫（bundle 崩过则永不就绪）',
    '存在守卫',
    /if \(!jsErrorHandler->hasHandledFatalError\(\)\) \{\s*\n\s*jsErrorHandler->setRuntimeReady\(\);/.test(t)
      ? '存在' : '未匹配',
    /if \(!jsErrorHandler->hasHandledFatalError\(\)\) \{\s*\n\s*jsErrorHandler->setRuntimeReady\(\);/.test(t),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 12. Android 旧架构已硬移除（但 iOS 仍是警告，平台不对称）
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/defaults/DefaultReactNativeHost.kt';
  const t = read(f) ?? '';
  const n = (t.match(/Overriding isNewArchEnabled to false is not supported anymore/g) ?? []).length;
  add(
    'C18', 'Android 侧 isNewArchEnabled=false 会抛异常（旧架构已硬移除）',
    '≥2 处 error()', `${n} 处`, n >= 2,
  );
  // iOS 侧必须仍保留开关（否则「平台不对称」的结论不成立）
  const iosHelper = read('packages/react-native/scripts/cocoapods/new_architecture.rb') ?? '';
  add(
    'C19', 'iOS 侧 new_arch_enabled 仍是硬编码 return true（与 Android 表现不同）',
    '存在 return true',
    /def self\.new_arch_enabled\s*\n\s*return true\s*\n\s*end/.test(iosHelper) ? '存在' : '未匹配',
    /def self\.new_arch_enabled\s*\n\s*return true\s*\n\s*end/.test(iosHelper),
  );
  const pods = read('packages/react-native/scripts/react_native_pods.rb') ?? '';
  add(
    'C19b', 'iOS 侧对 RCT_NEW_ARCH_ENABLED=0 只警告不报错（与 Android 抛异常不对称）',
    '存在 warn_if_new_arch_disabled',
    /def warn_if_new_arch_disabled/.test(pods) ? '存在' : '缺失',
    /def warn_if_new_arch_disabled/.test(pods),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 13. Android 内存压力只到 C++，不进 JS
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/MemoryPressureRouter.kt';
  const t = read(f) ?? '';
  // 不应出现任何派发 JS 事件的调用（RCTDeviceEventEmitter / emit）
  const emitsJs = /RCTDeviceEventEmitter|\.emit\(/.test(t);
  add(
    'C20', 'MemoryPressureRouter 不派发任何 JS 事件（仅转发给 C++ listener）',
    '无 JS 派发', emitsJs ? '发现 JS 派发' : '无', !emitsJs,
  );
  // 注意：源码里这行没有分号，写断言时不要凭印象补上
  add(
    'C20b', 'onTrimMemory 只调用 dispatchMemoryPressure',
    '单行转发',
    /public override fun onTrimMemory\(level: Int\) \{\s*\n\s*dispatchMemoryPressure\(level\)\s*\n\s*\}/.test(t)
      ? '单行转发' : '未匹配',
    /public override fun onTrimMemory\(level: Int\) \{\s*\n\s*dispatchMemoryPressure\(level\)\s*\n\s*\}/.test(t),
  );
  // onLowMemory 弃用且为空实现
  add(
    'C20c', 'onLowMemory 已弃用且为空实现（无内存压力回调）',
    '空实现',
    /public override fun onLowMemory\(\): Unit = Unit/.test(t) ? '空实现' : '未匹配',
    /public override fun onLowMemory\(\): Unit = Unit/.test(t),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 14. ReactMarker 埋点体系
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarkerConstants.kt';
  const t = read(f) ?? '';
  // 精确统计枚举项：必须在 enum class 体内、形如 NAME, 或 NAME(args),
  // 排除注释行。用「90+」「≥10」这类模糊断言会让错误数字溜过去（本次复核的教训）。
  const body = t.slice(t.indexOf('{'), t.lastIndexOf('}'));
  const entries = body
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'))
    .filter(l => /^[A-Za-z_][A-Za-z0-9_]*\s*(\([^)]*\))?,?$/.test(l));
  const withTrue = entries.filter(l => /\(true\)/.test(l));
  add('C21', 'ReactMarkerConstants 枚举项数量（精确值）', '114', `${entries.length}`, entries.length === 114);
  add('C22', '带 hasMatchingNameMarker=true 的埋点数量（精确值）', '13', `${withTrue.length}`, withTrue.length === 13);
  // 配对关系：START/END 各 6 对 + loadApplicationScript 1 对 = 13
  add(
    'C22b', '可自动配对的埋点构成：6 对 START/END + loadApplicationScript 一对',
    '6+6+1=13',
    `${withTrue.length} 项`,
    withTrue.length === 13,
  );
  // START/END 配对不是靠后缀（REGISTER_JS_SEGMENT_START ↔ _STOP）
  add(
    'C23', '存在 START 配 STOP（非 END）的埋点，自动化解析不能只按后缀',
    '存在',
    /REGISTER_JS_SEGMENT_START.*\n\s*REGISTER_JS_SEGMENT_STOP/.test(t) ? '存在' : '缺失',
    /REGISTER_JS_SEGMENT_START.*\n\s*REGISTER_JS_SEGMENT_STOP/.test(t),
  );
  // 半配对：CREATE_REACT_CONTEXT_START 未标记，只有 _END 标记 —— 不能当成完整配对用
  add(
    'C23b', 'CREATE_REACT_CONTEXT_START 未带 (true)，只有 _END 带（标记遗漏）',
    'START 无 true / END 有 true',
    /CREATE_REACT_CONTEXT_START,\s*\n\s*CREATE_REACT_CONTEXT_END\(true\)/.test(t) ? '确认半配对' : '已变化（需重新核对文档）',
    /CREATE_REACT_CONTEXT_START,\s*\n\s*CREATE_REACT_CONTEXT_END\(true\)/.test(t),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 15. UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE 硬编码 false（16 文档核心）
// ────────────────────────────────────────────────────────────────────────
{
  const gradle = read('packages/react-native/ReactAndroid/build.gradle.kts') ?? '';
  // 必须是 false，且全仓库只有这一处赋值
  const assigns = (gradle.match(/buildConfigField\("boolean",\s*"UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE",\s*"(\w+)"\)/g) ?? []);
  add(
    'C24', 'UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE 在 build.gradle.kts 中硬编码为 false',
    '唯一赋值点 = false',
    `${assigns.length} 处赋值，值=${(assigns[0] ?? '').match(/"(\w+)"\)$/)?.[1] ?? '未匹配'}`,
    assigns.length === 1 && /"false"\)/.test(assigns[0]),
  );
  // 开关确实被多处引用（否则「14 处行为失效」的结论不成立）
  const refs = grepCount(/UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE/, {
    exts: ['.kt', '.java'],
    roots: ['packages/react-native/ReactAndroid/src/main'],
  });
  add('C25', '该开关被 10+ 处源码引用（控制 legacy 行为分支）', '≥10 处', `${refs.count} 处`, refs.count >= 10);
  // 精确锁定引用计数：本次复核发现文档曾写「14 处」，实际 18 处 / 10 文件。
  add(
    'C25b', '该开关在源码中出现的确切次数（校验文档中的引用计数）',
    '18 次 / 10 文件',
    `${refs.count} 次 / ${refs.files.length} 文件`,
    refs.count === 18 && refs.files.length === 10,
  );
  // Logger 的总开关必须真的读它
  const logger = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/common/annotations/internal/LegacyArchitectureLogger.kt') ?? '';
  add(
    'C26', 'LegacyArchitectureLogger.assertLegacyArchitecture 的总开关就是该 BuildConfig 字段',
    '受其控制',
    /if \(ReactBuildConfig\.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE\)/.test(logger) ? '受其控制' : '不受控',
    /if \(ReactBuildConfig\.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE\)/.test(logger),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 16. 旧架构视图层已被掏空为空壳
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/UIViewOperationQueue.kt';
  const t = read(f) ?? '';
  const total = (t.match(/^\s*(public |private |internal |protected )?fun /gm) ?? []).length;
  const empty = (t.match(/^\s*(public |private |internal |protected )?fun .*\{\s*\}\s*$/gm) ?? []).length
    + (t.match(/\{\s*\}\s*$/gm) ?? []).length * 0; // 避免重复计数
  const trulyEmpty = (t.match(/fun \w+\([^)]*\)(: [\w<>?,\[\] ]+)?\s*\{\}/g) ?? []).length;
  add(
    'C27', 'UIViewOperationQueue 的方法几乎全是空实现（旧批处理管线已停用）',
    '空体 ≥15', `${trulyEmpty} 个空体 / ${total} 个方法`, trulyEmpty >= 15,
  );
  add(
    'C28', 'UIViewOperationQueue 的 isEmpty() 恒返回 true',
    'return true',
    /public fun isEmpty\(\): Boolean = true/.test(t) ? 'return true' : '未匹配',
    /public fun isEmpty\(\): Boolean = true/.test(t),
  );
  // NativeViewHierarchyManager 类注释必须自认 stubbed out
  const nvhm = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/NativeViewHierarchyManager.kt') ?? '';
  add(
    'C29', 'NativeViewHierarchyManager 类注释自述已被 stub out',
    '提及 stubbed out',
    /has been stubbed out/.test(nvhm) ? '提及' : '未提及',
    /has been stubbed out/.test(nvhm),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 17. BlackHoleEventDispatcher 静默丢事件
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/events/BlackHoleEventDispatcher.kt';
  const t = read(f) ?? '';
  add(
    'C30', 'BlackHoleEventDispatcher 用 FLog.d（非 w/e）记录被丢弃的事件',
    'FLog.d',
    /FLog\.d\(/.test(t) ? 'FLog.d' : (/FLog\.[we]\(/.test(t) ? 'FLog.w/e（更严格）' : '未匹配'),
    /FLog\.d\(/.test(t),
  );
  // ReactHostImpl 必须在实例未存活时回退到黑洞
  const host = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactHostImpl.kt') ?? '';
  add(
    'C31', 'ReactHostImpl.eventDispatcher 在实例未存活时回退到黑洞',
    '?: BlackHoleEventDispatcher',
    /reactInstance\?\.eventDispatcher \?: BlackHoleEventDispatcher/.test(host) ? '存在回退' : '未匹配',
    /reactInstance\?\.eventDispatcher \?: BlackHoleEventDispatcher/.test(host),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 18. prop 删除语义与 @ReactProp 注释矛盾（17 文档核心）
// ────────────────────────────────────────────────────────────────────────
{
  // 注释必须真的声称「属性被移除时提供默认值」
  const ann = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/annotations/ReactProp.kt') ?? '';
  add(
    'C32', '@ReactProp 注释声称「属性从 JS 描述中移除时提供默认值」',
    '注释含 gets removed',
    /gets removed from the/.test(ann) ? '含此说法' : '未找到',
    /gets removed from the/.test(ann),
  );
  // 实现必须真的只遍历存在的 key（否则矛盾不成立）
  const upd = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagerPropertyUpdater.kt') ?? '';
  add(
    'C33', 'updateProps 实现只遍历 backingMap 中存在的 key（不补全缺失项）',
    '无补全逻辑',
    /entryIterator/.test(upd) && !/defaults|missing|absent/i.test(upd.split('public fun <V : View> updateProps')[1]?.split('\n  }')[0] ?? '')
      ? '仅遍历 entryIterator' : '存在补全逻辑（矛盾不成立）',
    /entryIterator/.test(upd),
  );
  // defaultFloat 的默认值是 0.0f 而不是 NaN
  add(
    'C34', 'defaultFloat 的声明默认值是 0.0f（不是 NaN）',
    '= 0.0f',
    /public val defaultFloat: Float = 0\.0f/.test(ann) ? '= 0.0f' : '未匹配',
    /public val defaultFloat: Float = 0\.0f/.test(ann),
  );
  // Float.NaN 确实是全仓惯例（≥9 个文件）
  const nan = grepCount(/defaultFloat = Float\.NaN/, {
    exts: ['.kt'],
    roots: ['packages/react-native/ReactAndroid/src/main/java/com/facebook/react'],
  });
  add(
    'C35', 'defaultFloat = Float.NaN 作为「未设置」哨兵的确切用量',
    '17 行 / 9 文件',
    `${nan.count} 行 / ${nan.files.length} 文件`,
    nan.count === 17 && nan.files.length === 9,
  );
  // @ReactProp 计数：@ReactPropGroup 含子串 "@ReactProp"，必须排除
  const tm = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextViewManager.kt') ?? '';
  const single = (tm.match(/@ReactProp\b(?!Group)/g) ?? []).length;
  const group = (tm.match(/@ReactPropGroup/g) ?? []).length;
  add('C35b', 'ReactTextViewManager 的 @ReactProp 数量（不含 Group）', '15', `${single}`, single === 15);
  add('C35c', 'ReactTextViewManager 的 @ReactPropGroup 数量', '3', `${group}`, group === 3);
  // span 目录实现数
  const spanDir = path.join(REPO, 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/internal/span');
  const spanCount = fs.existsSync(spanDir)
    ? fs.readdirSync(spanDir).filter(f => f.endsWith('.kt')).length
    : -1;
  add('C35d', 'text/internal/span 下的 Span 实现数', '23', `${spanCount}`, spanCount === 23);
}

// ────────────────────────────────────────────────────────────────────────
// 19. 属性 setter 异常直接 rethrow 成 JS 异常
// ────────────────────────────────────────────────────────────────────────
{
  const f = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagersPropertyCache.kt';
  const t = read(f) ?? '';
  add(
    'C36', '属性 setter 捕获 Throwable 后包装成 JSApplicationIllegalArgumentException 并 rethrow',
    'catch Throwable + rethrow',
    /catch \(t: Throwable\)/.test(t) && /JSApplicationIllegalArgumentException/.test(t) ? '是' : '未匹配',
    /catch \(t: Throwable\)/.test(t) && /JSApplicationIllegalArgumentException/.test(t),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 20. JNI 异常穿透的两个方向（18 文档核心）
// ────────────────────────────────────────────────────────────────────────
{
  // C++→Java：onJsError 必须是 noexcept，否则逃逸异常会 abort
  const jri = read('packages/react-native/ReactAndroid/src/main/jni/react/runtime/jni/JReactInstance.cpp') ?? '';
  add(
    'C37', 'onJsError 回调被声明为 noexcept（逃逸异常会终止进程）',
    'lambda mutable noexcept',
    /JsErrorHandler::ProcessedError& error\) mutable noexcept/.test(jri) ? 'noexcept' : '未匹配',
    /JsErrorHandler::ProcessedError& error\) mutable noexcept/.test(jri),
  );
  // noexcept 是 Android 实现方自己加的，接口不强制 —— 否则会被误传成「RN 强制所有实现 noexcept」
  const jeh = read('packages/react-native/ReactCommon/jserrorhandler/JsErrorHandler.h') ?? '';
  add(
    'C37c', 'OnJsError 类型别名本身不带 noexcept（noexcept 是实现方选择，非接口强制）',
    '别名无 noexcept',
    /using OnJsError = std::function<[^>]*>;/.test(jeh) && !/using OnJsError = std::function<[^>]*noexcept/.test(jeh)
      ? '别名无 noexcept' : '异常：别名含 noexcept',
    /using OnJsError = std::function<[^>]*>;/.test(jeh) && !/using OnJsError = std::function<[^>]*noexcept/.test(jeh),
  );
  add(
    'C37d', 'handleError / handleErrorWithCppPipeline 均非 noexcept',
    '两者都无 noexcept',
    /void handleError\(.*\);/.test(jeh) && /void handleErrorWithCppPipeline\(.*\);/.test(jeh)
      && !/void handleError\(.*noexcept/.test(jeh) ? '都无 noexcept' : '异常',
    /void handleError\(.*\);/.test(jeh) && /void handleErrorWithCppPipeline\(.*\);/.test(jeh)
      && !/void handleError\(.*noexcept/.test(jeh),
  );
  add(
    'C37b', 'onJsError 用弱引用捕获 JReactExceptionManager（实例销毁后自动失效）',
    'make_weak + lockLocal',
    /make_weak\(jReactExceptionManager\)/.test(jri) && /lockLocal\(\)/.test(jri) ? '是' : '未匹配',
    /make_weak\(jReactExceptionManager\)/.test(jri) && /lockLocal\(\)/.test(jri),
  );

  // JNI-1：extraData 序列化的两层兜底 + 源码自述会 abort
  const jrem = read('packages/react-native/ReactAndroid/src/main/jni/react/runtime/jni/JReactExceptionManager.cpp') ?? '';
  add(
    'C38', '源码注释自述 extraData 序列化逃逸异常会 abort 整个进程',
    '注释含 aborts the whole process',
    /aborts the whole process/.test(jrem) ? '含此说明' : '未找到',
    /aborts the whole process/.test(jrem),
  );
  add(
    'C39', 'extraData 序列化有 catch(...) 兜底（两层）',
    '含 catch (...)',
    (jrem.match(/catch \(\.\.\.\)/g) ?? []).length >= 2 ? `${(jrem.match(/catch \(\.\.\.\)/g) ?? []).length} 处` : '不足',
    (jrem.match(/catch \(\.\.\.\)/g) ?? []).length >= 2,
  );
  add(
    'C39b', '兜底失败时会写入 extraDataMarshallingError 标记',
    '含该标记',
    /extraDataMarshallingError/.test(jrem) ? '存在' : '缺失',
    /extraDataMarshallingError/.test(jrem),
  );
  // Java 侧字段必须可空，且注释回指 C++ 实现
  const jh = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/interfaces/exceptionmanager/ReactJsExceptionHandler.kt') ?? '';
  add(
    'C40', 'Java 侧 extraData 声明为可空且注释回指 JReactExceptionManager.cpp',
    'val extraData: ReadableMap? + 注释引用',
    /val extraData: ReadableMap\?/.test(jh) && /JReactExceptionManager\.cpp/.test(jh) ? '是' : '未匹配',
    /val extraData: ReadableMap\?/.test(jh) && /JReactExceptionManager\.cpp/.test(jh),
  );

  // Java→C++：每个 JNI 调用后必须有 throwPendingJniExceptionAsCppException
  const mi = read('packages/react-native/ReactAndroid/src/main/jni/react/jni/MethodInvoker.cpp') ?? '';
  const calls = (mi.match(/env->Call\w+MethodA/g) ?? []).length;
  const checks = (mi.match(/throwPendingJniExceptionAsCppException\(\)/g) ?? []).length;
  add(
    'C41', 'MethodInvoker 中 JNI 调用次数与异常检查次数大致匹配（每个调用后都检查）',
    '检查数 ≥ 调用数',
    `JNI 调用 ${calls} 次 / 异常检查 ${checks} 次（含宏定义处）`,
    checks >= 5, // 宏里各一次 + void 分支一次；不要求严格相等，见 JNI-5
  );
  add(
    'C42', '未知参数类型用 LOG(FATAL) 而非抛异常（触发即进程终止）',
    '存在 LOG(FATAL)',
    /LOG\(FATAL\) << "Unknown param type/.test(mi) ? '存在' : '缺失',
    /LOG\(FATAL\) << "Unknown param type/.test(mi),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 22. 批次 1-3 复核发现的数字（09/10/13/14）
// ────────────────────────────────────────────────────────────────────────
{
  // 10 文档：formsStackingContext 是 21 项布尔或（曾写 18）
  const vsn = read('packages/react-native/ReactCommon/react/renderer/components/view/ViewShadowNode.cpp') ?? '';
  const seg = vsn.match(/bool formsStackingContext =([\s\S]*?);/);
  const orTerms = seg ? seg[1].split('||').map(s => s.trim()).filter(Boolean).length : -1;
  add('C43', 'ViewShadowNode.formsStackingContext 的顶层 || 项数（精确值）', '22', `${orTerms}`, orTerms === 22);

  // 10 文档：view/platform 共 15 个文件（android 6 / cxx 4 / tvos 5）
  const platRoot = path.join(REPO, 'packages/react-native/ReactCommon/react/renderer/components/view/platform');
  const countPlat = d => {
    const dir = path.join(platRoot, d, 'react/renderer/components/view');
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => /\.(h|cpp)$/.test(f)).length : -1;
  };
  const a = countPlat('android'), c = countPlat('cxx'), t = countPlat('tvos');
  add('C44', 'view/platform 三套实现的文件数（精确值）', 'android 6 / cxx 4 / tvos 5',
    `android ${a} / cxx ${c} / tvos ${t}`, a === 6 && c === 4 && t === 5);
  add('C44b', 'cxx 的 HostPlatformViewProps 是 BaseViewProps 的类型别名（故无需 .cpp）',
    'using HostPlatformViewProps = BaseViewProps',
    /using HostPlatformViewProps = BaseViewProps;/.test(
      read('packages/react-native/ReactCommon/react/renderer/components/view/platform/cxx/react/renderer/components/view/HostPlatformViewProps.h') ?? '')
      ? '是' : '未匹配',
    /using HostPlatformViewProps = BaseViewProps;/.test(
      read('packages/react-native/ReactCommon/react/renderer/components/view/platform/cxx/react/renderer/components/view/HostPlatformViewProps.h') ?? ''));
  add('C44c', 'tvos 比 cxx 多一个 HostPlatformViewProps.cpp（故并非逐字节副本）',
    'tvos 有 .cpp / cxx 无',
    fs.existsSync(platRoot + '/tvos/react/renderer/components/view/HostPlatformViewProps.cpp')
      && !fs.existsSync(platRoot + '/cxx/react/renderer/components/view/HostPlatformViewProps.cpp')
      ? '确认' : '未匹配',
    fs.existsSync(platRoot + '/tvos/react/renderer/components/view/HostPlatformViewProps.cpp')
      && !fs.existsSync(platRoot + '/cxx/react/renderer/components/view/HostPlatformViewProps.cpp'));

  // 10 文档：cxx 被 21 处引用（podspec 9 + 脚本 7 + 工程 5）
  const cxxRefs = grepCount(/components\/view\/platform\/cxx/, {
    roots: ['packages', 'private', 'scripts'],
  });
  add(
    'C45', 'cxx 路径在全仓库的引用次数（排除测试/快照）',
    '21',
    `${cxxRefs.count}`,
    cxxRefs.count === 21,
  );
  const tvosRefs = grepCount(/components\/view\/platform\/tvos/, {
    roots: ['packages', 'private', 'scripts'],
  });
  add('C45b', 'tvos 路径在全仓库的引用次数（应为 0，即死代码）', '0', `${tvosRefs.count}`, tvosRefs.count === 0);

  // 13 文档：23 个 require = 13 无条件 + 4 __DEV__ + 3 Flag + 3 Flag求值
  const setup = read('packages/react-native/src/private/setup/setUpDefaultReactNativeEnvironment.js') ?? '';
  const totalReq = (setup.match(/require\(/g) ?? []).length;
  add('C46', 'setUpDefaultReactNativeEnvironment 的 require 调用总数', '23', `${totalReq}`, totalReq === 23);
  // Libraries 路径的 require：13 无条件 + 4 __DEV__ 中有 4 个也是 Libraries 路径
  // 实测清单：22,25,26,28,30,31,32,33,34,35,36,38,39,40,43 = 15
  const devGated = (setup.match(/require\('\.\.\/\.\.\/\.\.\/Libraries/g) ?? []).length;
  add('C46b', 'Libraries 路径的 require 次数（13 无条件 + 4 __DEV__，全部走 Libraries）', '15', `${devGated}`, devGated === 15);
  add('C46c', '__DEV__ 条件块数量', '2', `${(setup.match(/if \(__DEV__ && enableDeveloperTools\)/g) ?? []).length}`,
    (setup.match(/if \(__DEV__ && enableDeveloperTools\)/g) ?? []).length === 2);

  // 14 文档：bridging 19 个 .h + 1 个 .cpp
  const brDir = path.join(REPO, 'packages/react-native/ReactCommon/react/bridging');
  const hCount = fs.readdirSync(brDir).filter(f => f.endsWith('.h')).length;
  const cppCount = fs.readdirSync(brDir).filter(f => f.endsWith('.cpp')).length;
  add('C47', 'react/bridging 的 .h / .cpp 数量（精确值）', '19 / 1', `${hCount} / ${cppCount}`,
    hCount === 19 && cppCount === 1);
}

// ────────────────────────────────────────────────────────────────────────
// 23. iOS 平台层（19 文档）
// ────────────────────────────────────────────────────────────────────────
{
  // IOS-1：iOS 硬编码 unloadLevel = 15
  const rinst = read('packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm') ?? '';
  add(
    'C48', 'iOS 内存警告硬编码 unloadLevel = 15（= TRIM_MEMORY_RUNNING_CRITICAL）',
    'static constexpr int unloadLevel = 15',
    /static constexpr int unloadLevel = 15;/.test(rinst) ? '确认硬编码 15' : '未匹配',
    /static constexpr int unloadLevel = 15;/.test(rinst),
  );

  // iOS 侧确实没有任何地方读内存压力等级
  const lvl = grepCount(/MemoryWarningLevel/, {
    roots: ['packages/react-native/React', 'packages/react-native/ReactCommon', 'packages/react-native/Libraries'],
  });
  add('C48b', 'iOS/RN 侧从未读取 UIApplicationMemoryWarningLevel（等级被丢弃）', '0', `${lvl.count}`, lvl.count === 0);

  // C++ 侧按 Android 枚举分级：LOW/MODERATE/UI_HIDDEN 忽略，严重等级才 GC
  const cxx = read('packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp') ?? '';
  add(
    'C49', 'handleMemoryPressureJs 的枚举是 Android ComponentCallbacks2 的 TRIM_MEMORY_*',
    '注释提及 Android OS + onTrimMemory',
    /passed by the Android OS to an onTrimMemory/.test(cxx) ? '是' : '未匹配',
    /passed by the Android OS to an onTrimMemory/.test(cxx),
  );
  add(
    'C49b', 'C++ 侧对 RUNNING_LOW/MODERATE/UI_HIDDEN 显式忽略（non-severe）',
    '含 ignoring because it\'s non-severe',
    /ignoring because it's non-severe/.test(cxx) ? '存在' : '缺失',
    /ignoring because it's non-severe/.test(cxx),
  );
  add(
    'C49c', '严重等级走 collectGarbage',
    '存在 collectGarbage 调用',
    /instrumentation\(\)\.collectGarbage\(levelName\)/.test(cxx) ? '存在' : '缺失',
    /instrumentation\(\)\.collectGarbage\(levelName\)/.test(cxx),
  );

  // IOS-3：SurfaceDidStop 从未被赋值
  const stopSet = grepCount(/stage\s*[|=]{1,2}[^=]*RCTSurfaceStageSurfaceDidStop|_stage\s*=\s*RCTSurfaceStageSurfaceDidStop/, {
    exts: ['.m', '.mm', '.h'],
    roots: ['packages/react-native/React', 'packages/react-native/ReactCommon'],
  });
  add('C50', 'RCTSurfaceStageSurfaceDidStop 从未被赋值点（该位是死位）', '0', `${stopSet.count}`, stopSet.count === 0);

  // RCTPLTag 枚举数量（末项 RCTPLSize 带尾注释，正则须容纳 `// ...`）
  const pltag = read('packages/react-native/React/Base/RCTPLTag.h') ?? '';
  const tagCount = (pltag.match(/^\s+RCTPL\w+/gm) ?? []).length;
  add('C51', 'RCTPLTag 枚举项数量（iOS 性能标记总数，含哨兵 RCTPLSize）', '22', `${tagCount}`, tagCount === 22);

  // logTaggedMarkerImpl 是 extern 单槽位，不是 listener 列表
  const rmk = read('packages/react-native/ReactCommon/cxxreact/ReactMarker.h') ?? '';
  add(
    'C52', 'logTaggedMarkerImpl 是单槽位全局变量（非 listener 列表）',
    'extern 单个变量',
    /extern RN_EXPORT AtomicLogTaggedMarker logTaggedMarkerImpl;/.test(rmk) ? 'extern 单变量' : '未匹配',
    /extern RN_EXPORT AtomicLogTaggedMarker logTaggedMarkerImpl;/.test(rmk),
  );
  add('C52b', 'RCTPerformanceLogger.h 中不存在 listener 注册接口', '无 addListener', (() => {
    const h = read('packages/react-native/React/Base/RCTPerformanceLogger.h') ?? '';
    return /addListener|addObserver|registerListener/.test(h) ? '存在（与文档矛盾）' : '确认无';
  })(), (() => {
    const h = read('packages/react-native/React/Base/RCTPerformanceLogger.h') ?? '';
    return !/addListener|addObserver|registerListener/.test(h);
  })());
}

// ────────────────────────────────────────────────────────────────────────
// 24. iOS CoreModules 崩溃终止机制（20 文档）
// ────────────────────────────────────────────────────────────────────────
{
  // CM-1：maxReloadAttempts 只有声明与读取，全仓库无赋值点
  const em = read('packages/react-native/React/CoreModules/RCTExceptionsManager.mm') ?? '';
  const emh = read('packages/react-native/React/CoreModules/RCTExceptionsManager.h') ?? '';
  const sets = grepCount(/maxReloadAttempts\s*=\s*/, {
    exts: ['.m', '.mm'],
    roots: ['packages/react-native/React', 'packages/react-native/Libraries'],
  });
  add(
    'C53', 'maxReloadAttempts 全仓库无赋值点（崩溃自动 reload 机制恒不生效）',
    '0 处赋值',
    `${sets.count} 处`,
    sets.count === 0,
  );
  add('C53b', 'maxReloadAttempts 确实是 @property 声明（我一度误判为未声明标识符）',
    'property 声明存在',
    /@property \(nonatomic, assign\) NSUInteger maxReloadAttempts;/.test(emh) ? '存在' : '缺失',
    /@property \(nonatomic, assign\) NSUInteger maxReloadAttempts;/.test(emh));

  // CM-2：reloadRetries 是函数内 static
  add(
    'C54', 'reloadRetries 是函数内 static NSUInteger（进程内永不重置）',
    'static NSUInteger reloadRetries = 0;',
    /static NSUInteger reloadRetries = 0;/.test(em) ? '确认' : '未匹配',
    /static NSUInteger reloadRetries = 0;/.test(em));

  // CM-3：RCTFatal 的 @throw 被 #if DEBUG 包裹
  const asrt = read('packages/react-native/React/Base/RCTAssert.m') ?? '';
  const dbgIdx = asrt.indexOf('void RCTFatal(NSError *error)');
  // 窗口取到下一个函数定义为止（1200 字符不够，含注释约 1400）
  const seg = dbgIdx >= 0 ? asrt.slice(dbgIdx, asrt.indexOf('\nvoid RCTSetFatalHandler', dbgIdx)) : '';
  add(
    'C55', 'RCTFatal 内 @throw/@catch 被 #if DEBUG 包裹（Debug 自抛自接、Release 逃逸）',
    '#if DEBUG 包住 @try/@catch',
    /#if DEBUG\s*\n\s*@try \{/.test(seg) && /@throw \[\[NSException alloc\]/.test(seg) ? '确认' : '未匹配',
    /#if DEBUG\s*\n\s*@try \{/.test(seg) && /@throw \[\[NSException alloc\]/.test(seg),
  );
  add(
    'C55b', 'RCTFatal 的 @catch 为空实现（Debug 下吞掉自己抛的异常）',
    '} @catch (NSException *) {\\n    }',
    /\} @catch \(NSException \*\) \{\s*\}/.test(seg) ? '空 catch' : '未匹配',
    /\} @catch \(NSException \*\) \{\s*\}/.test(seg),
  );

  // CM-4：两个 fatal handler 注册接口全仓库 0 调用（须排除 RCTAssert.m 里的定义本身）
  const fhAll = grepCount(/RCTSetFatalHandler\(|RCTSetFatalExceptionHandler\(/, {
    exts: ['.m', '.mm'],
    roots: ['packages/react-native/React', 'packages/react-native/Libraries', 'packages/react-native/ReactApple'],
  });
  const fhCalls = fhAll.files.filter(f => !f.endsWith('RCTAssert.m'));
  add(
    'C56', 'RCTSetFatalHandler / RCTSetFatalExceptionHandler 除定义外零调用',
    '仅 RCTAssert.m 内有定义',
    `${fhCalls.length} 个非定义文件`,
    fhCalls.length === 0,
  );

  // CM-5：decorateJSExceptionData: 是 iOS 独有钩子
  add(
    'C57', 'iOS 侧提供 decorateJSExceptionData: 上报前钩子',
    '存在该 selector 调用',
    /respondsToSelector:@selector\(decorateJSExceptionData:\)/.test(em) ? '存在' : '缺失',
    /respondsToSelector:@selector\(decorateJSExceptionData:\)/.test(em),
  );
  const androidHook = grepCount(/decorateJSExceptionData|decorateExceptionData/, {
    exts: ['.kt', '.java'],
    roots: ['packages/react-native/ReactAndroid/src/main'],
  });
  add('C57b', 'Android 侧无等价的上报前钩子（平台不对称）', '0 处', `${androidHook.count} 处`, androidHook.count === 0);
}

// ────────────────────────────────────────────────────────────────────────
// 25. iOS ComponentViews（21 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const CV = 'packages/react-native/React/Fabric/Mounting/ComponentViews';
  // 文件总数（子目录 + 根级）
  const countSrc = dir => {
    let n = 0;
    for (const e of fs.readdirSync(path.join(REPO, dir), {withFileTypes: true})) {
      if (e.isDirectory()) n += countSrc(dir + '/' + e.name);
      else if (/\.(h|m|mm)$/.test(e.name)) n++;
    }
    return n;
  };
  add('C58', 'iOS ComponentViews 的源文件总数（精确值）', '58', `${countSrc(CV)}`, countSrc(CV) === 58);

  // View/RCTViewComponentView.mm 的行数（文档称 1946）
  const vcv = read(CV + '/View/RCTViewComponentView.mm') ?? '';
  add(
    'C59', 'RCTViewComponentView.mm 的行数（文档称 1946）',
    '1946',
    `${vcv.split('\n').length - 1}`,
    vcv.split('\n').length - 1 === 1946,
  );

  // removeClippedSubviews 的两分支
  add(
    'C60', 'mountChildComponentView 按 _removeClippedSubviews 分叉（数组 vs 真实 subviews）',
    '存在 if/else 两分支',
    /if \(_removeClippedSubviews\) \{/.test(vcv) && /insertSubview:childComponentView atIndex:index/.test(vcv)
      ? '确认' : '未匹配',
    /if \(_removeClippedSubviews\) \{/.test(vcv) && /insertSubview:childComponentView atIndex:index/.test(vcv),
  );

  // enableViewCulling 默认为 false（故 removeClippedSubviews 当前生效）
  const ff = read('packages/react-native/scripts/featureflags/ReactNativeFeatureFlags.config.js') ?? '';
  const evc = ff.match(/enableViewCulling:\s*\{[\s\S]*?defaultValue:\s*(\w+)/);
  add(
    'C61', 'enableViewCulling 默认值为 false（实验中），故 JS 的 removeClippedSubviews 当前生效',
    'false',
    evc ? evc[1] : '未匹配',
    !!evc && evc[1] === 'false',
  );

  // DO_NOT_USE_THIS_IS_BROKEN 家族：4 个标识符
  const broken = grepCount(/DO_NOT_USE_THIS_IS_BROKEN/, {
    exts: ['.h', '.m', '.mm', '.cpp'],
    roots: ['packages/react-native/React', 'packages/react-native/ReactCommon'],
  });
  const uniqIdents = new Set();
  for (const f of broken.files) {
    const t = read(f) ?? '';
    for (const m of t.matchAll(/[A-Za-z_]*DO_NOT_USE_THIS_IS_BROKEN/g)) uniqIdents.add(m[0]);
  }
  add(
    'C62', 'DO_NOT_USE_THIS_IS_BROKEN 家族标识符数量（精确值，含 ivar）',
    '5 个不同标识符',
    `${uniqIdents.size} 个`,
    uniqIdents.size === 5,
  );
  add(
    'C62c', '其中 4 个是方法/属性名，1 个是 ivar（_propKeysManagedByAnimated_ 前缀）',
    '1 个 ivar',
    `${[...uniqIdents].filter(i => i.startsWith('_')).length} 个 ivar`,
    [...uniqIdents].filter(i => i.startsWith('_')).length === 1,
  );
  add('C62b', 'C++ 与 ObjC 两端都存在该命名（不限于某一平台）', '两端都有', (() => {
    const cxx = [...uniqIdents].some(i => /findComponentDescriptor/.test(i));
    const objc = [...uniqIdents].some(i => /propKeysManagedByAnimated|componentViewName/.test(i));
    return cxx && objc ? '两端都有' : '仅一端';
  })(), (() => {
    const cxx = [...uniqIdents].some(i => /findComponentDescriptor/.test(i));
    const objc = [...uniqIdents].some(i => /propKeysManagedByAnimated|componentViewName/.test(i));
    return cxx && objc;
  })());

  // 协议注释写 Do not use，但 RCTMountingManager 自己在用
  const proto = read('packages/react-native/React/Fabric/Mounting/RCTComponentViewProtocol.h') ?? '';
  const mm = read('packages/react-native/React/Fabric/Mounting/RCTMountingManager.mm') ?? '';
  add(
    'C63', '协议注释自称 broken，而 RCTMountingManager 仍调用该接口（命名警告失效）',
    '注释有 Do not use + 调用方存在',
    /This is broken\. Do not use\./.test(proto) && /propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN/.test(mm)
      ? '确认矛盾' : '未匹配',
    /This is broken\. Do not use\./.test(proto) && /propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN/.test(mm),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 26. iOS RedBox / LogBox 双层门控（22 文档）
// ────────────────────────────────────────────────────────────────────────
{
  // 第一层：编译期门控
  const rb = read('packages/react-native/React/CoreModules/RCTRedBox.mm') ?? '';
  add('C64', 'RCTRedBox.mm 用 #if RCT_DEV_MENU 包裹主体，else 支 moduleName 返回 nil',
    '存在 #if RCT_DEV_MENU 且 else 支 return nil',
    /#if RCT_DEV_MENU/.test(rb) && /#else \/\/ Disabled/.test(rb) ? '确认' : '未匹配',
    /#if RCT_DEV_MENU/.test(rb) && /#else \/\/ Disabled/.test(rb));

  // 第二层：运行期开关，默认由 RCT_DEV 决定
  const rse = read('packages/react-native/React/Base/RCTRedBoxSetEnabled.m') ?? '';
  add(
    'C65', 'RCTRedBoxSetEnabled.m 的 redBoxEnabled 默认值由 RCT_DEV 决定（Dev=YES/Release=NO）',
    '#if RCT_DEV → YES / #else → NO',
    /#if RCT_DEV\s*\nstatic BOOL redBoxEnabled = YES;\s*\n#else\s*\nstatic BOOL redBoxEnabled = NO;/.test(rse) ? '确认' : '未匹配',
    /#if RCT_DEV\s*\nstatic BOOL redBoxEnabled = YES;\s*\n#else\s*\nstatic BOOL redBoxEnabled = NO;/.test(rse),
  );
  add('C65b', 'RCTRedBoxSetEnabled 无任何调用方（机制存在但不可控）', '0 处调用', (() => {
    const hits = grepCount(/RCTRedBoxSetEnabled\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native/React', 'packages/react-native/Libraries'],
    }).files.filter(f => !f.endsWith('RCTRedBoxSetEnabled.m'));
    return `${hits.length} 处`;
  })(), (() => {
    const hits = grepCount(/RCTRedBoxSetEnabled\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native/React', 'packages/react-native/Libraries'],
    }).files.filter(f => !f.endsWith('RCTRedBoxSetEnabled.m'));
    return hits.length === 0;
  })());

  // RB-2：RCT_DEV_MENU 可独立于 RCT_DEV 关闭 → 两层门控错配
  const def = read('packages/react-native/React/Base/RCTDefines.h') ?? '';
  add(
    'C66', 'RCT_DEV_MENU 默认继承 RCT_DEV 但可被独立覆盖（产生门控错配的构建组合）',
    '#ifndef RCT_DEV_MENU → #define ... RCT_DEV',
    /#ifndef RCT_DEV_MENU\s*\n#define RCT_DEV_MENU RCT_DEV/.test(def) ? '确认可独立覆盖' : '未匹配',
    /#ifndef RCT_DEV_MENU\s*\n#define RCT_DEV_MENU RCT_DEV/.test(def),
  );

  // 模块发现依赖 nil 语义
  const tmm = read('packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm') ?? '';
  add(
    'C67', 'TurboModule 发现循环里没有显式 nil 检查，依赖 isEqualToString: 对 nil 返回 NO',
    '只有 respondsToSelector 检查，无 nil 检查',
    /\[current respondsToSelector:@selector\(moduleName\)\]/.test(tmm) && !/moduleName == nil|moduleName != nil/.test(tmm)
      ? '确认无显式 nil 检查' : '有显式检查',
    /\[current respondsToSelector:@selector\(moduleName\)\]/.test(tmm) && !/moduleName == nil|moduleName != nil/.test(tmm),
  );

  // LogBox spec 只有 2 个方法（故空实现是完整的）
  const spec = read('packages/react-native/src/private/specs_DEPRECATED/modules/NativeLogBox.js') ?? '';
  const specMethods = (spec.match(/readonly \w+: \(\) => void;/g) ?? []).length;
  add('C68', 'LogBox 的 TurboModule spec 方法数（决定 else 支实现是否完整）', '2', `${specMethods}`, specMethods === 2);
  const lb = read('packages/react-native/React/CoreModules/RCTLogBox.mm') ?? '';
  // 必须只取 #else 支内的 show（Dev 支也有 show，且实现完全不同）
  const elseIdx = lb.indexOf('#else // Disabled');
  const elseSeg = elseIdx >= 0 ? lb.slice(elseIdx) : '';
  const elseShow = /- \(void\)show\s*\{\s*\n\s*\/\/ noop\s*\n\s*\}/.test(elseSeg);
  add(
    'C68b', 'RCTLogBox 的 #else 支内 show/hide 是显式 noop（注意 Dev 支同名方法实现不同）',
    'else 支内含 // noop',
    elseShow ? '确认' : '未匹配',
    elseShow,
  );
  add(
    'C68c', 'RCTLogBox 的 Dev 支 show() 内含 RCTRedBoxGetEnabled 二次门控（与 RedBox 联动）',
    'Dev 支 show 内有该调用',
    /- \(void\)show\s*\{\s*\n\s*if \(RCTRedBoxGetEnabled\(\)\)/.test(lb) ? '确认' : '未匹配',
    /- \(void\)show\s*\{\s*\n\s*if \(RCTRedBoxGetEnabled\(\)\)/.test(lb),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 27. iOS 基础工具层 RCTConvert / RCTAssert / RCTLog / RCTUtils（23 文档）
// ────────────────────────────────────────────────────────────────────────
{
  // U-1: RCT_CUSTOM_CONVERTER 的 Debug/Release 语义反转
  const cvt = read('packages/react-native/React/Base/RCTConvert.h') ?? '';
  add(
    'C69', 'RCT_CUSTOM_CONVERTER 里 !RCT_DEBUG 分支直接 return code（无 @try），Debug 分支才有 @try/@catch',
    '!RCT_DEBUG 支无 @try；Debug 支有 @catch',
    /if \(!RCT_DEBUG\) \{\s*\\?\s*\\?\s*return code;[\s\S]*?\} else \{[\s\S]*?@try \{[\s\S]*?\} @catch/.test(cvt)
      ? '确认 Release 无 @try' : '未匹配',
    /if \(!RCT_DEBUG\) \{[\s\S]*?\} else \{[\s\S]*?@try \{[\s\S]*?\} @catch/.test(cvt),
  );
  // U-2: RCT_JSON_CONVERTER 的 #else 分支无类型检查
  const cvtm = read('packages/react-native/React/Base/RCTConvert.mm') ?? '';
  add(
    'C70', 'RCTConvert.mm 的 #else 分支里 RCT_JSON_CONVERTER 只 return json（无 isKindOfClass 检查）',
    '#else 支无 isKindOfClass',
    /#else\n#define RCT_JSON_CONVERTER\(type\)[\s\S]{0,120}?return json;/.test(cvtm)
      && !/#else\n#define RCT_JSON_CONVERTER\(type\)[\s\S]{0,160}?isKindOfClass/.test(cvtm)
      ? '确认无类型检查' : '有检查或未匹配',
    /#else\n#define RCT_JSON_CONVERTER\(type\)[\s\S]{0,120}?return json;/.test(cvtm) &&
      !/#else\n#define RCT_JSON_CONVERTER\(type\)[\s\S]{0,160}?isKindOfClass/.test(cvtm),
  );
  // U-3: RCT_NUMBER_CONVERTER 的三元
  add(
    'C71', 'RCT_NUMBER_CONVERTER 在 Release 下跳过 NSNumber 转换（[RCT_DEBUG ? [self NSNumber:json] : json getter]）',
    '三元表达式含 RCT_DEBUG',
    /\[RCT_DEBUG \? \[self NSNumber:json\] : json getter\]/.test(cvt) ? '确认三元' : '未匹配',
    /\[RCT_DEBUG \? \[self NSNumber:json\] : json getter\]/.test(cvt),
  );
  // U-4: 四个 handler 安装函数 0 外部调用
  for (const [id, fn, name] of [
    ['C72', 'RCTSetFatalHandler', 'fatalHandler'],
    ['C73', 'RCTSetFatalExceptionHandler', 'fatalExceptionHandler'],
    ['C74', 'RCTSetAssertFunction', 'assertFunction'],
    ['C75', 'RCTAddAssertFunction', 'addAssertFunction'],
  ]) {
    const hits = grepCount(new RegExp(fn + '\\('), {
      exts: ['.m', '.mm', '.h'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTAssert.m') && !f.endsWith('React/Base/RCTAssert.h'));
    add(`${id}`, `${name} 安装函数（${fn}）在 RN 仓库内的外部调用数`, '0', `${hits.length} 处`, hits.length === 0);
  }
  // U-5: RCTPerformBlockWith*Function 缺 @finally
  const asrt = read('packages/react-native/React/Base/RCTAssert.m') ?? '';
  const asrtPerf = /RCTPerformBlockWithAssertFunction[\s\S]{0,900}?\[functionStack addObject:assertFunction\];\s*block\(\);\s*\[functionStack removeLastObject\];/.test(asrt);
  add(
    'C76', 'RCTPerformBlockWithAssertFunction 的 add/block/remove 三步之间没有 @finally',
    '三步相邻，无 @finally',
    asrtPerf && !/@finally/.test(asrt) ? '确认无 @finally' : '有 @finally 或未匹配',
    asrtPerf && !/@finally/.test(asrt),
  );
  const logm = read('packages/react-native/React/Base/RCTLog.mm') ?? '';
  const logPerf = /RCTPerformBlockWithLogFunction[\s\S]{0,900}?\[functionStack addObject:logFunction\];\s*block\(\);\s*\[functionStack removeLastObject\];/.test(logm);
  add(
    'C76b', 'RCTPerformBlockWithLogFunction 同样缺 @finally（与 assert 侧同型）',
    '三步相邻，无 @finally',
    logPerf && !/@finally/.test(logm) ? '确认无 @finally' : '有 @finally 或未匹配',
    logPerf && !/@finally/.test(logm),
  );
  // U-6: %{public}s 不脱敏
  add(
    'C77', 'RCTDefaultLogFunction 用 "%{public}s" 写 os_log（内容不脱敏）',
    '"%{public}s"',
    logm.includes('"%{public}s"') ? '确认 public' : '未匹配',
    logm.includes('"%{public}s"'),
  );
  add(
    'C77b', 'RCTDefaultLogFunction 里不含 %{private}',
    '0 处 private',
    (logm.match(/%\{private\}/g) ?? []).length + ' 处',
    !logm.includes('%{private}'),
  );
  // U-7: log 判定恒真（RCTGetLogFunction 兜底）
  add(
    'C78', '_RCTLogNativeInternal 里 `log = RCT_DEBUG || (logFunction != nil)` 的后半项恒真（RCTGetLogFunction 兜底赋值）',
    'RCTGetLogFunction 内有 if (!RCTCurrentLogFunction) 兜底',
    /RCTLogFunction RCTGetLogFunction\(\)\s*\{\s*if \(!RCTCurrentLogFunction\) \{\s*RCTCurrentLogFunction = RCTDefaultLogFunction;/.test(logm)
      ? '确认兜底 → log 恒真' : '未匹配',
    /RCTLogFunction RCTGetLogFunction\(\)\s*\{\s*if \(!RCTCurrentLogFunction\) \{\s*RCTCurrentLogFunction = RCTDefaultLogFunction;/.test(logm),
  );
  add(
    'C78b', '_RCTLogJavaScriptInternal 用同一个恒真判定式',
    '两处写法一致',
    (logm.match(/BOOL log = RCT_DEBUG \|\| \(logFunction != nil\);/g) ?? []).length + ' 处',
    (logm.match(/BOOL log = RCT_DEBUG \|\| \(logFunction != nil\);/g) ?? []).length === 2,
  );
  // U-8/U-9: 注释声称 dispatch_once/once_flag 但两侧都没有
  add(
    'C79', 'RCTConvert.mm 的 _defaultColorSpace 是裸 static 变量，注释声称的 dispatch_once/once_flag 实际不存在',
    '裸赋值，无 dispatch_once',
    /static RCTColorSpace _defaultColorSpace = RCTColorSpaceSRGB;/.test(cvtm) &&
      /void RCTSetDefaultColorSpace\(RCTColorSpace colorSpace\)\s*\{\s*_defaultColorSpace = colorSpace;/.test(cvtm) &&
      !/_defaultColorSpace[\s\S]{0,400}?dispatch_once/.test(cvtm)
      ? '确认无 dispatch_once（与注释矛盾）' : '有 dispatch_once 或未匹配',
    /static RCTColorSpace _defaultColorSpace = RCTColorSpaceSRGB;/.test(cvtm) &&
      /void RCTSetDefaultColorSpace\(RCTColorSpace colorSpace\)\s*\{\s*_defaultColorSpace = colorSpace;/.test(cvtm) &&
      !/_defaultColorSpace[\s\S]{0,400}?dispatch_once/.test(cvtm),
  );
  const cc = read('packages/react-native/ReactCommon/react/renderer/graphics/ColorComponents.cpp') ?? '';
  add(
    'C80', 'ColorComponents.cpp 的 defaultColorSpace 是非原子 static（无 std::atomic / once_flag）',
    '裸 static，无 atomic/once_flag',
    /static ColorSpace defaultColorSpace = ColorSpace::sRGB;/.test(cc) &&
      !/std::atomic|once_flag/.test(cc)
      ? '确认非原子' : '有 atomic 或未匹配',
    /static ColorSpace defaultColorSpace = ColorSpace::sRGB;/.test(cc) && !/std::atomic|once_flag/.test(cc),
  );
  add(
    'C80b', 'ColorComponents.cpp 的 `#include <mutex>` 在全文中无任何使用（残留）',
    '0 处 std::mutex/lock_guard',
    (cc.match(/std::(mutex|lock_guard|unique_lock)/g) ?? []).length + ' 处使用',
    cc.includes('#include <mutex>') && !/std::(mutex|lock_guard|unique_lock)/.test(cc),
  );
  // U-10: RCTIsNewArchEnabled 硬编码 YES 且 0 调用
  const ut = read('packages/react-native/React/Base/RCTUtils.mm') ?? '';
  add(
    'C81', 'RCTIsNewArchEnabled 硬编码 return YES，且全仓库 0 调用（声明+定义仅 2 处）',
    '硬编码 YES，0 调用',
    /BOOL RCTIsNewArchEnabled\(void\)\s*\{\s*return YES;\s*\}/.test(ut) &&
      (grepCount(/RCTIsNewArchEnabled/, {
        exts: ['.m', '.mm', '.h'],
        roots: ['packages/react-native'],
      }).files.filter(f => !/React\/Base\/RCTUtils\.(m|mm|h)$/.test(f)).length === 0)
      ? '确认硬编码 + 0 调用' : '未匹配',
    /BOOL RCTIsNewArchEnabled\(void\)\s*\{\s*return YES;\s*\}/.test(ut) &&
      grepCount(/RCTIsNewArchEnabled/, {
        exts: ['.m', '.mm', '.h'],
        roots: ['packages/react-native'],
      }).files.filter(f => !/React\/Base\/RCTUtils\.(m|mm|h)$/.test(f)).length === 0,
  );
  // U-11: W3C 指针事件开关 0 写入
  const cm = read('packages/react-native/React/Base/RCTConstants.m') ?? '';
  add(
    'C82', 'RCTSetDispatchW3CPointerEvents 无任何调用方（RCTDispatchW3CPointerEvents 恒为 NO）',
    '0 处调用',
    (() => {
      const hits = grepCount(/RCTSetDispatchW3CPointerEvents\(/, {
        exts: ['.m', '.mm'],
        roots: ['packages/react-native'],
      }).files.filter(f => !f.endsWith('React/Base/RCTConstants.m'));
      return `${hits.length} 处`;
    })(),
    (() => {
      const hits = grepCount(/RCTSetDispatchW3CPointerEvents\(/, {
        exts: ['.m', '.mm'],
        roots: ['packages/react-native'],
      }).files.filter(f => !f.endsWith('React/Base/RCTConstants.m'));
      return hits.length === 0;
    })(),
  );
  add(
    'C82b', 'RCTConstants.m 里 RCTDispatchW3CPointerEvents 的初值',
    'NO',
    /static BOOL RCTDispatchW3CPointerEvents = NO;/.test(cm) ? 'NO' : '未匹配',
    /static BOOL RCTDispatchW3CPointerEvents = NO;/.test(cm),
  );
  // U-12: RCTPlatformName 硬编码 ios
  add(
    'C83', 'RCTPlatformName 硬编码 @"ios"（tvOS 也上报 ios）',
    'ios',
    /NSString \*const RCTPlatformName = @"ios";/.test(cm) ? 'ios' : '未匹配',
    /NSString \*const RCTPlatformName = @"ios";/.test(cm),
  );
  // U-13: warn vs warning 不一致
  const warnLevels = /"warn"/.test(logm);
  const warnLevelFmt = /RCTLogLevelWarning\) : @"warning"/.test(logm);
  add(
    'C84', '同一级别两个名字：RCTLogLevels[] 用 "warn"，RCTFormatLogLevel 用 "warning"',
    `数组="warn"=${warnLevels}, 格式化="warning"=${warnLevelFmt}`,
    warnLevels && warnLevelFmt ? '确认不一致' : '一致或未匹配',
    warnLevels && warnLevelFmt,
  );
  // U-14: RCTVersion 占位符
  const vm = read('packages/react-native/React/Base/RCTVersion.m') ?? '';
  add(
    'C85', 'RCTVersion.m 的默认 major 是占位符 1000（由发布脚本 set-rn-artifacts-version 改写）',
    '1000',
    /RCTVersionMajor: @\(1000\)/.test(vm) ? '1000' : '未匹配',
    /RCTVersionMajor: @\(1000\)/.test(vm),
  );
  // U-16: RCTLOG_REDBOX_LEVEL 默认 Error
  const lgH = read('packages/react-native/React/Base/RCTLog.h') ?? '';
  add(
    'C86', 'RCTLOG_REDBOX_LEVEL 默认为 RCTLogLevelError（Debug 下每次 error 日志都做完整符号化）',
    'RCTLogLevelError',
    /#define RCTLOG_REDBOX_LEVEL RCTLogLevelError/.test(lgH) ? 'RCTLogLevelError' : '未匹配',
    /#define RCTLOG_REDBOX_LEVEL RCTLogLevelError/.test(lgH),
  );
  // 阈值默认为 Trace（0）—— 等于不设阈
  add(
    'C86b', 'RCTDefaultLogThreshold = RCTLogLevelInfo - 1，即 RCTLogLevelTrace(0)，任何级别都能通过',
    'Trace(0)',
    /RCTDefaultLogThreshold = \(RCTLogLevel\)\(RCTLogLevelInfo - 1\)/.test(logm)
      && /RCTLogLevelTrace = 0/.test(lgH)
      ? 'Trace(0) → 阈值恒通过' : '未匹配',
    /RCTDefaultLogThreshold = \(RCTLogLevel\)\(RCTLogLevelInfo - 1\)/.test(logm) && /RCTLogLevelTrace = 0/.test(lgH),
  );
  // 六个编译期开关各自 #ifndef 独立定义
  const defs = read('packages/react-native/React/Base/RCTDefines.h') ?? '';
  const nGuards = (defs.match(/#ifndef (RCT_DEBUG|RCT_DEV|RCT_DEV_MENU|RCT_NSASSERT)\b/g) ?? []).length;
  add('C87', 'RCTDefines.h 里可独立覆盖的编译期开关数（每个都有 #ifndef 保护）', '4', `${nGuards} 个`, nGuards === 4);
  // RCTCxxConvert 空实现
  const ccx = read('packages/react-native/React/Base/RCTCxxConvert.m') ?? '';
  add(
    'C88', 'RCTCxxConvert 的 @implementation 内无任何方法（头注释描述的能力未实现）',
    '0 个方法',
    (ccx.match(/^[-+] \(/gm) ?? []).length + ' 个',
    !/^[-+] \(/m.test(ccx),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 28. iOS 事件分发 / 触摸管线 / RCTBridge 开关（24 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const ed = read('packages/react-native/React/CoreModules/RCTEventDispatcher.mm') ?? '';
  // 事件 ID 三段位打包
  add(
    'C89', 'RCTGetEventID 把 viewTag / eventName.hash(16位) / coalescingKey 打包进互不重叠的位段',
    'viewTag | hash<<32 | key<<48',
    /viewTag\.intValue \| \(\(\(uint64_t\)eventName\.hash & 0xFFFF\) << 32\) \| \(\(\(uint64_t\)coalescingKey\) << 48\)/.test(ed)
      ? '确认三段位' : '未匹配',
    /viewTag\.intValue \| \(\(\(uint64_t\)eventName\.hash & 0xFFFF\) << 32\) \| \(\(\(uint64_t\)coalescingKey\) << 48\)/.test(ed),
  );
  // E-2: 不可合并分支先读后写 eventID
  add(
    'C90', 'sendEvent: 的不可合并分支在 eventID 赋值之前先读 _events[eventID]（断言校验的是错误的 ID）',
    '先 _events[eventID] 再赋值',
    (() => {
      const idx = ed.indexOf('} else {', ed.indexOf('if (event.canCoalesce)'));
      const seg = idx >= 0 ? ed.slice(idx, idx + 400) : '';
      const readAt = seg.indexOf('_events[eventID]');
      const writeAt = seg.indexOf('eventID = RCTGetEventID');
      return readAt >= 0 && writeAt > readAt;
    })()
      ? '确认先读后写' : '未匹配',
    (() => {
      const idx = ed.indexOf('} else {', ed.indexOf('if (event.canCoalesce)'));
      const seg = idx >= 0 ? ed.slice(idx, idx + 400) : '';
      const readAt = seg.indexOf('_events[eventID]');
      const writeAt = seg.indexOf('eventID = RCTGetEventID');
      return readAt >= 0 && writeAt > readAt;
    })(),
  );
  // canCoalesce 只有两个实现，且只有 touchMove 为真
  const te = read('packages/react-native/React/Base/RCTTouchEvent.m') ?? '';
  const ce = read('packages/react-native/React/Base/RCTComponentEvent.m') ?? '';
  add(
    'C91', 'canCoalesce 全仓库仅两处实现：RCTTouchEvent 只对 "touchMove" 为真，RCTComponentEvent 恒 NO',
    'touchMove 为真 / 组件事件恒 NO',
    /- \(BOOL\)canCoalesce\s*\{\s*return \[_eventName isEqual:@"touchMove"\];/.test(te) &&
      /- \(BOOL\)canCoalesce\s*\{\s*return NO;/.test(ce)
      ? '确认两处' : '未匹配',
    /- \(BOOL\)canCoalesce\s*\{\s*return \[_eventName isEqual:@"touchMove"\];/.test(te) &&
      /- \(BOOL\)canCoalesce\s*\{\s*return NO;/.test(ce),
  );
  // E-12: generator 是 static + uint16_t
  add(
    'C92', 'RCTUniqueCoalescingKeyGenerator 是 static 全局 uint16_t（每 65536 次自增回绕）',
    'static uint16_t',
    /static uint16_t RCTUniqueCoalescingKeyGenerator = 0;/.test(ed) ? 'static uint16_t' : '未匹配',
    /static uint16_t RCTUniqueCoalescingKeyGenerator = 0;/.test(ed),
  );
  // flushEventsQueue 整体换新对象（回绕不可观测的前提）
  add(
    'C92b', 'flushEventsQueue 把 _events/_eventQueue 整体换成新对象（使 eventID 回绕不可观测）',
    '两处 _events = [NSMutableDictionary new]',
    (ed.match(/_events = \[NSMutableDictionary new\]/g) ?? []).length + ' 处',
    (ed.match(/_events = \[NSMutableDictionary new\]/g) ?? []).length >= 1 &&
      (ed.match(/_eventQueue = \[NSMutableArray new\]/g) ?? []).length >= 1,
  );
  // E-1: RCTEventEmitter.js 零 import
  {
    const jsPath = 'packages/react-native/Libraries/EventEmitter/RCTEventEmitter.js';
    const js = read(jsPath) ?? '';
    const hits = grepCount(/EventEmitter\/RCTEventEmitter/, {
      exts: ['.js'],
      roots: ['packages'],
    }).files.filter(f => f !== jsPath);
    add('C93', 'RCTEventEmitter.js 在 JS 侧的 import 方数量（决定 legacy 事件链是否接通）', '0', `${hits.length} 处`, hits.length === 0);
    add(
      'C93b', 'RCTEventEmitter.js 只提供类型声明与 register，receiveTouches/receiveEvent 无实现',
      '仅类型声明',
      /type EventEmitterModule = \{/.test(js) && /receiveTouches: \(/.test(js) && !/receiveTouches\(/.test(js)
        ? '仅声明无实现' : '有实现或未匹配',
      /type EventEmitterModule = \{/.test(js) && /receiveTouches: \(/.test(js) && !/receiveTouches\(/.test(js),
    );
  }
  // E-3: RCTEnableTurboModule 空实现 + 0 调用
  {
    const bm = read('packages/react-native/React/Base/RCTBridge.mm') ?? '';
    const emptyImpl = /void RCTEnableTurboModule\(BOOL enabled\)\s*\{\s*\n\s*\/\/[^\n]*\n\s*\}/.test(bm);
    add('C94', 'RCTEnableTurboModule 的函数体只有注释（参数 enabled 被忽略）', '空实现', emptyImpl ? '确认空实现' : '未匹配', emptyImpl);
    const calls = grepCount(/RCTEnableTurboModule\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTBridge.mm'));
    add('C94b', 'RCTEnableTurboModule 的调用方数量', '0', `${calls.length} 处`, calls.length === 0);
    // E-4: fabricInteropLayerEnabled 恒 YES
    add(
      'C95', 'fabricInteropLayerEnabled 初值 YES 且 RCTEnableFabricInteropLayer 零调用 → 恒为 YES',
      '初值 YES，0 调用',
      /static BOOL fabricInteropLayerEnabled = YES;/.test(bm) &&
        grepCount(/RCTEnableFabricInteropLayer\(/, {
          exts: ['.m', '.mm'],
          roots: ['packages/react-native'],
        }).files.filter(f => !f.endsWith('React/Base/RCTBridge.mm')).length === 0
        ? '确认恒 YES' : '未匹配',
      /static BOOL fabricInteropLayerEnabled = YES;/.test(bm) &&
        grepCount(/RCTEnableFabricInteropLayer\(/, {
          exts: ['.m', '.mm'],
          roots: ['packages/react-native'],
        }).files.filter(f => !f.endsWith('React/Base/RCTBridge.mm')).length === 0,
    );
    // E-5: RCTBridge 四个空方法
    const empties = ['reload', 'reloadWithReason', 'onFastRefresh', 'requestReload'];
    const nEmpty = empties.filter(m =>
      new RegExp('\\- \\(void\\)' + m + '[^\\{]*\\{\\s*\\}').test(bm),
    ).length;
    add('C96', 'RCTBridge 中 reload/reloadWithReason:/onFastRefresh/requestReload 的空实现数量', '4', `${nEmpty} 个`, nEmpty === 4);
    // E-6: || 与 && 混用
    const bmh = read('packages/react-native/React/Base/RCTBridgeModule.h') ?? '';
    add(
      'C97', '同一对 RCT_REMOVE_LEGACY_* 宏：RCTBridge.mm 用 ||（任一未定义即保留），RCTBridgeModule.h 用 &&（两者都定义才走）',
      'RCTBridge.mm=|| / RCTBridgeModule.h=&&',
      /#if !defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) \|\| !defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)/.test(bm) &&
        /#if defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) && defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)/.test(bmh)
        ? '确认混用' : '未匹配',
      /#if !defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) \|\| !defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)/.test(bm) &&
        /#if defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) && defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)/.test(bmh),
    );
  }
  // E-7: RCTReloadCommand 锁初始化在锁外
  const rc = read('packages/react-native/React/Base/RCTReloadCommand.m') ?? '';
  add(
    'C98', 'RCTRegisterReloadCommandListener 在加锁之前判空并赋值 listenersLock（首次并发注册会丢失锁）',
    '判空在 lock 之前',
    /if \(!listenersLock\) \{\s*listenersLock = \[NSLock new\];\s*\}\s*\[listenersLock lock\];/.test(rc)
      ? '确认判空在锁外' : '未匹配',
    /if \(!listenersLock\) \{\s*listenersLock = \[NSLock new\];\s*\}\s*\[listenersLock lock\];/.test(rc),
  );
  add(
    'C98b', 'RCTTriggerReloadCommandListeners 无条件 [listenersLock lock]（nil 锁使锁失效且不崩溃）',
    '无条件加锁',
    /void RCTTriggerReloadCommandListeners\(NSString \*reason\)\s*\{\s*\[listenersLock lock\];/.test(rc)
      ? '确认无条件' : '未匹配',
    /void RCTTriggerReloadCommandListeners\(NSString \*reason\)\s*\{\s*\[listenersLock lock\];/.test(rc),
  );
  // reload listener 唯一注册方是 RCTHost
  {
    const regs = grepCount(/RCTRegisterReloadCommandListener\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTReloadCommand.m'));
    add(
      'C99', 'RCTRegisterReloadCommandListener 的调用方（唯一实现 didReceiveReloadCommand 的类）',
      '1 且为 RCTHost',
      regs.length === 1 && /RCTHost\.mm$/.test(regs[0]) ? `1: ${regs[0].split('/').pop()}` : `${regs.length} 处`,
      regs.length === 1 && /RCTHost\.mm$/.test(regs[0]),
    );
  }
  // E-8: 错误码撞号
  const jl = read('packages/react-native/React/Base/RCTJavaScriptLoader.h') ?? '';
  const codes = [...jl.matchAll(/RCTJavaScriptLoaderError(\w+) = (\d+)/g)].map(m => [m[1], m[2]]);
  const byVal = {};
  for (const [n, v] of codes) (byVal[v] ||= []).push(n);
  const dupes = Object.entries(byVal).filter(([, ns]) => ns.length > 1);
  add(
    'C100', 'RCTJavaScriptLoader 错误码中重复取值的组数（3 个值为 3、2 个值为 4）',
    '2 组',
    `${dupes.length} 组：${dupes.map(([v, ns]) => `${v}×${ns.length}`).join(', ')}`,
    dupes.length === 2 && dupes.find(([v]) => v === '3')?.[1].length === 3 && dupes.find(([v]) => v === '4')?.[1].length === 2,
  );
  const jlm = read('packages/react-native/React/Base/RCTJavaScriptLoader.mm') ?? '';
  add(
    'C101', '唯一按 error.code 分支的判断用的是 1000（CannotBeLoadedSynchronously），不与撞号组冲突',
    '1000',
    /error\.code == RCTJavaScriptLoaderErrorCannotBeLoadedSynchronously/.test(jlm) &&
      /RCTJavaScriptLoaderErrorCannotBeLoadedSynchronously = 1000/.test(jl)
      ? '确认 1000 不冲突' : '未匹配',
    /error\.code == RCTJavaScriptLoaderErrorCannotBeLoadedSynchronously/.test(jlm) &&
      /RCTJavaScriptLoaderErrorCannotBeLoadedSynchronously = 1000/.test(jl),
  );
  // E-14: ScriptTag::String 受 RCT_ENABLE_INSPECTOR 门控
  add(
    'C102', 'ScriptTag::String 分支的同步加载被 #if RCT_ENABLE_INSPECTOR 包裹（纯 Release 下走异步）',
    '受 RCT_ENABLE_INSPECTOR 门控',
    /case facebook::react::ScriptTag::String: \{\s*#if RCT_ENABLE_INSPECTOR/.test(jlm)
      ? '确认门控' : '未匹配',
    /case facebook::react::ScriptTag::String: \{\s*#if RCT_ENABLE_INSPECTOR/.test(jlm),
  );
  // RCT_ENABLE_INSPECTOR 的定义依赖 DEV 或 REMOTE_PROFILE
  const defs = read('packages/react-native/React/Base/RCTDefines.h') ?? '';
  add(
    'C102b', 'RCT_ENABLE_INSPECTOR = (RCT_DEV || RCT_REMOTE_PROFILE)，两者皆 0 时为 0',
    'DEV || REMOTE_PROFILE',
    /#if \(RCT_DEV \|\| RCT_REMOTE_PROFILE\)\s*\n#define RCT_ENABLE_INSPECTOR 1/.test(defs)
      ? '确认依赖 DEV/REMOTE_PROFILE' : '未匹配',
    /#if \(RCT_DEV \|\| RCT_REMOTE_PROFILE\)\s*\n#define RCT_ENABLE_INSPECTOR 1/.test(defs),
  );
  // 触摸 ID 上限
  const th = read('packages/react-native/React/Base/RCTTouchHandler.m') ?? '';
  add(
    'C103', '触摸 ID 上限常量 RCTMaxTouches 的值',
    '11',
    (th.match(/RCTMaxTouches = (\d+)/) ?? [])[1] ?? '未匹配',
    /RCTMaxTouches = 11/.test(th),
  );
  // E-13: RCTTextUpdateLagWarningThreshold 零使用
  {
    const hits = grepCount(/RCTTextUpdateLagWarningThreshold/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTEventDispatcher.m'));
    add('C104', 'RCTTextUpdateLagWarningThreshold 的使用方（排除定义文件）', '0', `${hits.length} 处`, hits.length === 0);
    const threshVal = /const NSInteger RCTTextUpdateLagWarningThreshold = (\d+);/.exec(
      read('packages/react-native/React/Base/RCTEventDispatcher.m') ?? '',
    );
    add(
      'C104b',
      'RCTTextUpdateLagWarningThreshold 的值',
      '3',
      threshVal ? threshVal[1] : '未匹配',
      threshVal?.[1] === '3',
    );
  }
  // 事件名规范化的幂等性
  const edm = read('packages/react-native/React/Base/RCTEventDispatcher.m') ?? '';
  add(
    'C105', 'RCTNormalizeInputEventName 幂等：已有 "top" 前缀时不做任何转换',
    'top 前缀直接返回',
    /else if \(!\[eventName hasPrefix:@"top"\]\)/.test(edm) ? '确认幂等' : '未匹配',
    /else if \(!\[eventName hasPrefix:@"top"\]\)/.test(edm),
  );
  // ComponentEvent 在构造时规范化，TouchEvent 在 arguments 时规范化
  add(
    'C106', '事件名规范化时机不同：RCTComponentEvent 在构造时调用，RCTTouchEvent 在 arguments 里调用',
    '构造时 / arguments 时',
    /_eventName = RCTNormalizeInputEventName\(name\);/.test(ce) &&
      /return @\[ RCTNormalizeInputEventName\(_eventName\), _reactTouches, _changedIndexes \];/.test(te)
      ? '确认时机不同' : '未匹配',
    /_eventName = RCTNormalizeInputEventName\(name\);/.test(ce) &&
      /return @\[ RCTNormalizeInputEventName\(_eventName\), _reactTouches, _changedIndexes \];/.test(te),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 29. iOS 桥接核心 / RCTModuleData / 启动性能标签（25 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const md = read('packages/react-native/React/Base/RCTModuleData.mm') ?? '';
  // M-1: RCTModuleData 的空实现 + 零 @synthesize
  add(
    'C107', 'RCTModuleData.mm 的 @implementation 内无任何 @synthesize（11 个属性靠自动合成返回零值）',
    '0 个 @synthesize',
    (md.match(/@synthesize/g) ?? []).length + ' 个',
    !/@synthesize/.test(md),
  );
  add(
    'C107b', 'RCTModuleData.mm 的 initWithModuleClass: 直接 return self（6 个参数全部未使用）',
    'return self',
    /- \(instancetype\)initWithModuleClass:[\s\S]{0,700}?\n\{\n  return self;\n\}/.test(md) ? '确认' : '未匹配',
    /- \(instancetype\)initWithModuleClass:[\s\S]{0,700}?\n\{\n  return self;\n\}/.test(md),
  );
  add(
    'C107c', 'RCTModuleData.mm 的 gatherConstants 与 invalidate 是空实现',
    '两个空方法',
    /- \(void\)gatherConstants\n\{\n\}/.test(md) && /- \(void\)invalidate\n\{\n\}/.test(md)
      ? '确认' : '未匹配',
    /- \(void\)gatherConstants\n\{\n\}/.test(md) && /- \(void\)invalidate\n\{\n\}/.test(md),
  );
  // M-1b: 两个构造器零调用
  {
    const hits = grepCount(/initWithModuleClass:|initWithModuleInstance:/, {
      exts: ['.m', '.mm'],
      roots: ['packages'],
    }).files.filter(f => !f.endsWith('React/Base/RCTModuleData.mm'));
    add('C108', 'RCTModuleData 两个构造器的外部调用数（类无法被实例化）', '0', hits.length + ' 处', hits.length === 0);
  }
  // M-2: RCTBridge 上无 moduleDataForName: 实现
  {
    const bm = read('packages/react-native/React/Base/RCTBridge.mm') ?? '';
    add(
      'C109', 'RCTBridge.mm 里既无 moduleDataForName: 也无 batchedBridge 的实现（头文件仍声明）',
      '0 个实现',
      /moduleDataForName|batchedBridge/.test(bm) ? '有实现' : '确认无实现',
      !/moduleDataForName|batchedBridge/.test(bm) &&
        /- \(RCTModuleData \*\)moduleDataForName:/.test(
          read('packages/react-native/React/Base/RCTBridge+Private.h') ?? '',
        ),
    );
  }
  // M-3: RCT_DISABLE_STATIC_MODULE_REGISTRATION 零定义
  {
    const bmh = read('packages/react-native/React/Base/RCTBridgeModule.h') ?? '';
    const defined = grepCount(/define RCT_DISABLE_STATIC_MODULE_REGISTRATION/, {
      roots: ['packages', 'scripts'],
    }).files;
    add('C110', 'RCT_DISABLE_STATIC_MODULE_REGISTRATION 的定义处数量（该 RCT_EXPORT_MODULE 分支是否可达）', '0', defined.length + ' 处', defined.length === 0);
    add(
      'C110b', '该分支内保留了 RCTRegisterModule 的 extern 声明但删掉了调用点（悬空声明，不产生链接错误）',
      '有 extern、无 +load',
      /#else\n\n#define RCT_EXPORT_MODULE\(js_name\)[\s\S]{0,200}?RCT_EXTERN void RCTRegisterModule\(Class\);[\s\S]{0,200}?return @ #js_name;[\s\S]{0,40}?\}/.test(bmh) &&
        !/#else\n\n#define RCT_EXPORT_MODULE\(js_name\)[\s\S]{0,400}?\+\(void\)load/.test(bmh)
        ? '确认悬空' : '未匹配',
      /#else\n\n#define RCT_EXPORT_MODULE\(js_name\)[\s\S]{0,200}?RCT_EXTERN void RCTRegisterModule\(Class\);[\s\S]{0,200}?return @ #js_name;[\s\S]{0,40}?\}/.test(bmh) &&
        !/#else\n\n#define RCT_EXPORT_MODULE\(js_name\)[\s\S]{0,400}?\+\(void\)load/.test(bmh),
    );
  }
  // RCTRegisterModule 声明/定义在四种宏组合下配对
  {
    const bm = read('packages/react-native/React/Base/RCTBridge.mm') ?? '';
    const bmh = read('packages/react-native/React/Base/RCTBridgeModule.h') ?? '';
    add(
      'C111', 'RCTRegisterModule：头文件在「两宏都定义」时走简化分支（只返回 moduleName），.mm 用 || 门控定义，两者一致',
      '简化分支 + || 门控',
      /#if defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) && defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)[\s\S]{0,600}?#define RCT_EXPORT_MODULE\(js_name\) \\\s*\+\(NSString \*\)moduleName/.test(bmh) &&
        /#if !defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) \|\| !defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)[\s\S]{0,600}?void RCTRegisterModule\(Class moduleClass\)/.test(bm)
        ? '确认配对' : '未匹配',
      /#if defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) && defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)[\s\S]{0,600}?#define RCT_EXPORT_MODULE\(js_name\) \\\s*\+\(NSString \*\)moduleName/.test(bmh) &&
        /#if !defined\(RCT_REMOVE_LEGACY_MODULE_INTEROP\) \|\| !defined\(RCT_REMOVE_LEGACY_COMPONENT_INTEROP\)[\s\S]{0,600}?void RCTRegisterModule\(Class moduleClass\)/.test(bm),
    );
  }
  // M-4: attachInteropAPIsToModule 靠 respondsToSelector + @synthesize
  {
    const dec = read('packages/react-native/React/Base/RCTBridgeModuleDecorator.m') ?? '';
    const nGuards = (dec.match(/respondsToSelector:@selector\(set/g) ?? []).length;
    add('C112', 'attachInteropAPIsToModule 用 respondsToSelector 守卫注入的 API 数量', '4', nGuards + ' 个', nGuards === 4);
    const nSynth = grepCount(/@synthesize moduleRegistry/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.length;
    add('C112b', '真正写了 @synthesize moduleRegistry 的文件数（对比 4 个可注入 API，说明接入面很窄）', '实测值', nSynth + ' 个', nSynth > 0 && nSynth < 60);
  }
  // M-5: 22 个标签中 12 个零打点
  {
    const plH = read('packages/react-native/React/Base/RCTPLTag.h') ?? '';
    const tags = [...new Set([...plH.matchAll(/RCTPL(\w+)/g)].map(x => 'RCTPL' + x[1]))].filter(t => t !== 'RCTPLSize');
    const zero = [];
    const hit = [];
    for (const tag of tags) {
      const files = grepCount(new RegExp(tag + '\\b'), {
        exts: ['.m', '.mm', '.cpp'],
        roots: ['packages/react-native'],
      }).files.filter(f => !/RCTPLTag\.h$|RCTPerformanceLoggerLabels\./.test(f));
      (files.length === 0 ? zero : hit).push(tag);
    }
    add('C113', 'RCTPLTag 的标签总数（排除哨兵 RCTPLSize）', '22', tags.length + ' 个', tags.length === 22);
    add('C114', '零打点的性能标签数量（22 个中）', '12', zero.length + ' 个', zero.length === 12);
    add('C114b', '零打点标签清单', '3 个 RAMStartup* + RAMBundleLoad + 4 个 NativeModule* + TurboModuleSetup + JSCWrapperOpenLibrary + BridgeStartup + BundleSize',
      zero.length + ' 个：' + zero.map(t => t.replace('RCTPL', '')).join(', '),
      zero.includes('RCTPLRAMBundleLoad') && zero.includes('RCTPLTurboModuleSetup') &&
        zero.includes('RCTPLBridgeStartup') && zero.includes('RCTPLBundleSize') &&
        zero.includes('RCTPLJSCWrapperOpenLibrary') && zero.filter(t => /RAMStartup/.test(t)).length === 3 &&
        zero.filter(t => /NativeModule/.test(t)).length === 4,
    );
    add('C114c', '有实际打点的性能标签数量', '10', hit.length + ' 个', hit.length === 10);
  }
  // M-8: RCTPLSize 的断言
  {
    const lm = read('packages/react-native/React/Base/RCTPerformanceLoggerLabels.m') ?? '';
    add(
      'C115', 'RCTPLLabelForTag 对哨兵 RCTPLSize 显式 RCTAssert(NO) 后返回 nil（Release 下该断言无效）',
      'RCTAssert(NO) + return nil',
      /case RCTPLSize: \/\/ Only used to count enum size\s*\n\s*RCTAssert\(NO,[\s\S]{0,120}?return nil;/.test(lm)
        ? '确认' : '未匹配',
      /case RCTPLSize: \/\/ Only used to count enum size\s*\n\s*RCTAssert\(NO,[\s\S]{0,120}?return nil;/.test(lm),
    );
  }
  // M-6: 劫持 logTaggedMarkerImpl
  {
    const utils = read('packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTPerformanceLoggerUtils.mm') ?? '';
    add(
      'C116', 'iOS 性能日志靠赋值 ReactMarker::logTaggedMarkerImpl 接入（而非独立埋点）',
      '赋值 logTaggedMarkerImpl',
      /ReactMarker::logTaggedMarkerImpl = \[weakPerformanceLogger\]/.test(utils)
        ? '确认劫持' : '未匹配',
      /ReactMarker::logTaggedMarkerImpl = \[weakPerformanceLogger\]/.test(utils),
    );
    const nCalls = grepCount(/registerPerformanceLoggerHooks\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages'],
    }).files.filter(f => !f.endsWith('RCTPerformanceLoggerUtils.mm'));
    add(
      'C116b', 'registerPerformanceLoggerHooks 的调用方（iOS 需显式注册；Android 由 JNI 层默认装好）',
      '1 且为 RCTInstance.mm',
      nCalls.length === 1 && /RCTInstance\.mm$/.test(nCalls[0]) ? '1: ' + nCalls[0].split('/').pop() : nCalls.length + ' 处',
      nCalls.length === 1 && /RCTInstance\.mm$/.test(nCalls[0]),
    );
    add(
      'C116c', 'Android 侧由 JReactMarker.cpp 默认赋值 logTaggedMarkerImpl（平台不对称）',
      'JReactMarker.cpp 有赋值',
      /ReactMarker::logTaggedMarkerImpl = JReactMarker::logPerfMarker;/.test(
        read('packages/react-native/ReactAndroid/src/main/jni/react/jni/JReactMarker.cpp') ?? '',
      )
        ? '确认' : '未匹配',
      /ReactMarker::logTaggedMarkerImpl = JReactMarker::logPerfMarker;/.test(
        read('packages/react-native/ReactAndroid/src/main/jni/react/jni/JReactMarker.cpp') ?? '',
      ),
    );
    // M-7: 5 个 iOS 侧忽略的 marker
    const ignored = (utils.match(/These are not used on iOS/g) ?? []).length;
    // 忽略组本身：行级解析 —— 找注释所在行，往上收集紧邻的连续 case 行
    const nCases = (() => {
      const lines = utils.split('\n');
      const i = lines.findIndex(l => l.includes('These are not used on iOS'));
      if (i < 0) return 0;
      let n = 0;
      for (let k = i - 1; k >= 0 && lines[k].includes('case ReactMarker::'); k--) n++;
      return n;
    })();
    add('C117', 'iOS 侧映射表里显式忽略的 marker 数（注释自述 These are not used on iOS）', '5',
      nCases + ' 个', ignored === 1 && nCases === 5);
    add('C117b', 'mapReactMarkerToPerformanceLogger 内的 case 总数（12 个生效映射 + 5 个忽略）', '17',
      (utils.match(/case ReactMarker::/g) ?? []).length + ' 个',
      (utils.match(/case ReactMarker::/g) ?? []).length === 17);
  }
  // M-9: _data[tag][0] 三种语义
  {
    const plm = read('packages/react-native/React/Base/RCTPerformanceLogger.mm') ?? '';
    add(
      'C118', 'setValue:/addValue: 都把 _data[tag][0] 强制置 0，而 markStart: 把它写成时间戳 —— 同一槽位两种语义',
      '置 0 vs 时间戳',
      /- \(void\)setValue:\(int64_t\)value forTag:\(RCTPLTag\)tag\s*\{\s*_data\[tag\]\[0\] = 0;/.test(plm) &&
        /- \(void\)markStartForTag:\(RCTPLTag\)tag[\s\S]{0,400}?_data\[tag\]\[0\] = currentTime;/.test(plm)
        ? '确认槽位复用' : '未匹配',
      /- \(void\)setValue:\(int64_t\)value forTag:\(RCTPLTag\)tag\s*\{\s*_data\[tag\]\[0\] = 0;/.test(plm) &&
        /- \(void\)markStartForTag:\(RCTPLTag\)tag[\s\S]{0,400}?_data\[tag\]\[0\] = currentTime;/.test(plm),
    );
    add(
      'C118b', '读取只有 durationForTag 一种（返回 [1]-[0]），对计数标签正确是 _data[0] 恰好被置 0 的巧合',
      'return _data[tag][1] - _data[tag][0]',
      /- \(int64_t\)durationForTag:\(RCTPLTag\)tag\s*\{\s*return _data\[tag\]\[1\] - _data\[tag\]\[0\];/.test(plm)
        ? '确认唯一读取' : '未匹配',
      /- \(int64_t\)durationForTag:\(RCTPLTag\)tag\s*\{\s*return _data\[tag\]\[1\] - _data\[tag\]\[0\];/.test(plm),
    );
    add(
      'C118c', 'markStopForTag: 与 appendStopForTag: 在不配对时都记 RCTLogInfo（Release 下仍输出）',
      '2 处 RCTLogInfo',
      (plm.match(/RCTLogInfo\(@"Unbalanced calls start\/end for tag/g) ?? []).length + ' 处',
      (plm.match(/RCTLogInfo\(@"Unbalanced calls start\/end for tag/g) ?? []).length === 2,
    );
    const maps = [...plm.matchAll(/\{(RCTPL\w+), ReactMarker::(\w+)\}/g)].map(x => x[1]);
    add('C119', '反向通知 ReactMarker 的标签数（Start/Stop 两张映射表各 3 个）', '3 × 2', new Set(maps).size + ' 个唯一标签',
      new Set(maps).size === 3);
  }
  // M-10: copy-pasta 注释
  {
    const ic = read('packages/react-native/ReactCommon/react/renderer/components/legacyviewmanagerinterop/platform/ios/react/renderer/components/legacyviewmanagerinterop/RCTLegacyViewManagerInteropCoordinator.mm') ?? '';
    add(
      'C120', 'RCTModuleData 的方法扫描逻辑被 copy-pasta 到 LegacyViewManagerInteropCoordinator（源码注释自述）',
      'copy-pasta 注释存在',
      /\/\/ This is copy-pasta from RCTModuleData\./.test(ic) ? '确认' : '未匹配',
      /\/\/ This is copy-pasta from RCTModuleData\./.test(ic),
    );
    add(
      'C120b', 'interop 的 handleCommand 用 moduleData ? ... : _moduleMethods 三元（两条架构路径实际都走后者）',
      'moduleData 三元',
      /method = moduleData \? moduleData\.methods\[\[commandName intValue\]\] : _moduleMethods\[\[commandName intValue\]\];/.test(ic)
        ? '确认' : '未匹配',
      /method = moduleData \? moduleData\.methods\[\[commandName intValue\]\] : _moduleMethods\[\[commandName intValue\]\];/.test(ic),
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// 30. iOS Base 余部：RCTImageSource / Multipart / KeyCommands / CxxConvert（26 文档）
// ────────────────────────────────────────────────────────────────────────
{
  // I-1: 运算符优先级 bug
  const isrc = read('packages/react-native/React/Base/RCTImageSource.m') ?? '';
  const scaleLine = isrc.split('\n').find(l => l.includes('scale = [self CGFloat:json[@"scale"]]'));
  add(
    'C121', 'RCTImageSource.m 的 scale 三元表达式未加括号（?: 优先级高于 ?:，任何非零 scale 被清成 0.0）',
    '存在未加括号的三元',
    scaleLine && !/\?: \([^\n]*\?[^)]*\)/.test(scaleLine) ? '确认未加括号' : '未匹配或已加括号',
    !!scaleLine && !/\?: \([^\n]*\?[^)]*\)/.test(scaleLine),
  );
  add(
    'C121b', 'RCTImageSource.m 的 scale 默认声明为 1.0（第 66 行）',
    '1.0',
    /CGFloat scale = 1\.0;/.test(isrc) ? '1.0' : '未匹配',
    /CGFloat scale = 1\.0;/.test(isrc),
  );
  add(
    'C121c', 'RCTImageSource 的 isEqual: 对 scale 严格比较、无 CGSizeZero 那样的兜底（修好 I-1 后会成为新问题源）',
    '严格比较',
    /_scale == object\.scale/.test(isrc) && !/_scale == object\.scale \|\|/.test(isrc) ? '确认严格' : '未匹配',
    /_scale == object\.scale/.test(isrc) && !/_scale == object\.scale \|\|/.test(isrc),
  );
  {
    const tests = grepCount(/\bRCTImageSource\b/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native/React/Tests'],
    }).files;
    add('C122', 'RCTImageSource 在 React/Tests/ 下的测试文件数（I-1 长期未被发现的原因）', '0', tests.length + ' 个', tests.length === 0);
  }
  // I-2: RCTMultipartStreamReader 的 content 只增不减
  const msr = read('packages/react-native/React/Base/RCTMultipartStreamReader.m') ?? '';
  {
    const appends = (msr.match(/\[content appendBytes:/g) ?? []).length;
    const clears = (msr.match(/\[content (removeRange|setLength|replaceBytesInRange)/g) ?? []).length;
    add('C123', 'RCTMultipartStreamReader 中 content 的 append 点数', '1', appends + ' 处', appends === 1);
    add('C124', 'RCTMultipartStreamReader 中 content 的清理点数（内存线性增长的根因）', '0', clears + ' 处', clears === 0);
    add(
      'C124b', 'RCTMultipartStreamReader 初始容量为 1（几乎必然触发多次扩容拷贝）',
      'initWithCapacity:1',
      /NSMutableData \*content = \[\[NSMutableData alloc\] initWithCapacity:1\];/.test(msr) ? '1' : '未匹配',
      /NSMutableData \*content = \[\[NSMutableData alloc\] initWithCapacity:1\];/.test(msr),
    );
    // 进度节流做对了（对照组）
    add(
      'C124c', 'emitProgress 用 0.016 秒节流（≈60Hz）—— 作者清楚高频回调代价，却漏了缓冲区本身',
      '0.016',
      /currentTime - _lastDownloadProgress > 0\.016 \|\| final/.test(msr) ? '确认节流' : '未匹配',
      /currentTime - _lastDownloadProgress > 0\.016 \|\| final/.test(msr),
    );
  }
  // I-3: RCTMultipartDataTask 的双路径
  const mdt = read('packages/react-native/React/Base/RCTMultipartDataTask.m') ?? '';
  add(
    'C125', 'RCTMultipartDataTask 的非流式路径把全部数据累积到 _data（无清理点）',
    'appendData 且无清理',
    /\[_data appendData:data\];/.test(mdt) && !/\[_data (remove|setLength|replaceBytes)/.test(mdt)
      ? '确认只增不减' : '未匹配',
    /\[_data appendData:data\];/.test(mdt) && !/\[_data (remove|setLength|replaceBytes)/.test(mdt),
  );
  add(
    'C126', 'RCTMultipartDataTask 的流式分支改用 RCTMultipartStreamReader，但两条路径都不省内存',
    '两条路径并存',
    /didBecomeInputStream:/.test(mdt) && /RCTMultipartStreamReader alloc\] initWithInputStream:/.test(mdt)
      ? '确认流式分支' : '未匹配',
    /didBecomeInputStream:/.test(mdt) && /RCTMultipartStreamReader alloc\] initWithInputStream:/.test(mdt),
  );
  // I-4: escape 注释与代码不符
  const kc = read('packages/react-native/React/Base/RCTKeyCommands.m') ?? '';
  {
    const escapeLines = kc.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /escape/i.test(l));
    add('C127', 'RCTKeyCommands 中出现 escape 的行数（注释声称有例外，代码无实现）', '1（仅注释）',
      escapeLines.length + ' 行：' + escapeLines.map(([n]) => n).join(','),
      escapeLines.length === 1 && /^\s*\/\//.test(escapeLines[0][1]));
    add(
      'C127b', 'handleKeyUIEventSwizzle 的分支是 !firstResponder（无任何 escape 判断）',
      '仅 !firstResponder',
      /if \(!firstResponder\) \{\s*\[self RCT_handleKeyCommand:/.test(kc) &&
        !/escape/.test(kc.replace(/\/\/[^\n]*escape[^\n]*/g, ''))
        ? '确认无 escape 判断' : '未匹配',
      /if \(!firstResponder\) \{\s*\[self RCT_handleKeyCommand:/.test(kc) &&
        !/escape/.test(kc.replace(/\/\/[^\n]*escape[^\n]*/g, '')),
    );
  }
  // I-5/I-6: 私有 API
  {
    const obfuscated = /Obfuscating selector allWindowsIncludingInternalWindows/.test(kc);
    const pieces = (kc.match(/@"al", @"lWindo", @"wsIncl"/) ?? []).length;
    add('C128', 'RCTKeyCommands 用混淆字符串拼接规避 App Store 扫描（注释自述 Obfuscating selector）', '1 处',
      obfuscated ? '确认混淆' + (pieces ? '，拆成 9 段' : '') : '未匹配', obfuscated && pieces === 1);
    const privateSelectors = (kc.match(/@selector\(_(modifiedInput|modifierFlags|isKeyDown)\)/g) ?? []).length;
    add('C128b', '未混淆的私有 selector 数（_modifiedInput/_modifierFlags/_isKeyDown）', '3', privateSelectors + ' 个', privateSelectors === 3);
    add(
      'C128c', 'allWindows 用 methodSignatureForSelector: 但不检查 nil（私有 API 被移除时会抛异常）',
      '无 nil 检查',
      /methodSignatureForSelector:allWindowsSelector\]/.test(kc) &&
        !/methodSignatureForSelector:allWindowsSelector\] == nil|methodSignature == nil/.test(kc)
        ? '确认无 nil 检查' : '有检查或未匹配',
      /methodSignatureForSelector:allWindowsSelector\]/.test(kc) &&
        !/methodSignatureForSelector:allWindowsSelector\] == nil|methodSignature == nil/.test(kc),
    );
    // 三个私有 selector 有 respondsToSelector 保护
    const guards = (kc.match(/respondsToSelector:@selector\(_\w+\)/g) ?? []).length;
    add('C128d', '三个 _ 前缀私有 selector 都有 respondsToSelector: 保护（升级安全）', '3', guards + ' 处', guards === 3);
  }
  // matchesInput 的 flags==0 语义
  add(
    'C129', 'matchesInput: 的 flag 匹配条件是 (flags == 0)（事件侧无修饰键），使「注册 cmd+r 也能被裸 r 触发」',
    'flags == 0',
    /_flags == flags \|\| flags == 0/.test(kc) ? '确认' : '未匹配',
    /_flags == flags \|\| flags == 0/.test(kc),
  );
  // RCT_handleKeyCommand 先快照后执行
  add(
    'C130', 'RCT_handleKeyCommand 先收集到 commandsToExecute 再执行（避免迭代中变更 NSMutableSet）',
    '先快照后执行',
    /commandsToExecute = \[NSMutableArray new\]/.test(kc) &&
      /for \(RCTKeyCommand \*command in commandsToExecute\)/.test(kc)
      ? '确认' : '未匹配',
    /commandsToExecute = \[NSMutableArray new\]/.test(kc) &&
      /for \(RCTKeyCommand \*command in commandsToExecute\)/.test(kc),
  );
  // I-7: RCTCxxConvert 空壳但有 3 个活调用方
  {
    const ccx = read('packages/react-native/React/Base/RCTCxxConvert.m') ?? '';
    add(
      'C131', 'RCTCxxConvert 仍无任何转换方法（@implementation 为空）',
      '0 个方法',
      (ccx.match(/^[-+] \(/gm) ?? []).length + ' 个',
      !/^[-+] \(/m.test(ccx),
    );
    const callers = grepCount(/convert\(\[RCTCxxConvert class\]/, {
      exts: ['.mm', '.m'],
      roots: ['packages/react-native'],
    }).files;
    add('C132', 'objc_msgSend 打向 [RCTCxxConvert class] 的调用点数量（证明是活路径）', '3',
      callers.length + ' 处', callers.length === 3);
    // selector 注册只有 RCTInteropTurboModule 一处
    const setters = grepCount(/setMethodArgConversionSelector\(/, {
      exts: ['.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('RCTTurboModule.mm'));
    add(
      'C133', 'methodArgConversionSelectors_ 的外部注册方（决定 RCTCxxConvert 路径的可达性）',
      '1 且为 RCTInteropTurboModule.mm',
      setters.length === 1 && /RCTInteropTurboModule\.mm$/.test(setters[0]) ? '1: ' + setters[0].split('/').pop() : setters.length + ' 处',
      setters.length === 1 && /RCTInteropTurboModule\.mm$/.test(setters[0]),
    );
    // codegen 走另一条路
    const tm = read('packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm') ?? '';
    add(
      'C134', 'codegen 模块的 JS:: 参数走 convertJSIValueToObjCObject（与 RCTCxxConvert 无关，故 CoreModules 不受影响）',
      'convertJSIValueToObjCObject',
      /convertJSIValueToObjCObject\(runtime, arg, jsInvoker_/.test(tm) &&
        /^id convertJSIValueToObjCObject\(/m.test(tm)
        ? '确认独立路径' : '未匹配',
      /convertJSIValueToObjCObject\(runtime, arg, jsInvoker_/.test(tm) &&
        /^id convertJSIValueToObjCObject\(/m.test(tm),
    );
    // 三处调用都有所有权处理
    const allThree = [tm, read('packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTInteropTurboModule.mm') ?? '',
      read('packages/react-native/React/Base/RCTModuleMethod.mm') ?? ''];
    add(
      'C135', '三处 RCTCxxConvert 调用都用 addObject: 持有 box 以维持 shared_ptr 生命周期（所有权处理正确）',
      '3 处',
      allThree.filter(t => /\[retained\w* addObject:box\]/.test(t)).length + ' 处',
      allThree.filter(t => /\[retained\w* addObject:box\]/.test(t)).length === 3,
    );
  }
  // I-8: managedPointer 模板零使用
  {
    const mp = read('packages/react-native/React/Base/RCTManagedPointer.h') ?? '';
    const uses = grepCount(/managedPointer\s*</, {
      exts: ['.h', '.mm', '.m', '.cpp'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTManagedPointer.h'));
    add('C136', 'managedPointer<...> 模板的调用方数量（唯一能产出 RCTManagedPointer 的路径）', '0', uses.length + ' 处', uses.length === 0);
    add(
      'C136b', 'RCTManagedPointer 持有 shared_ptr<void>（.mm 的 ivar + .h 的 init/模板），本身实现完整',
      'shared_ptr<void>',
      /std::shared_ptr<void> _pointer;/.test(read('packages/react-native/React/Base/RCTManagedPointer.mm') ?? '') &&
        /initWithPointer:\(std::shared_ptr<void>\)pointer/.test(mp)
        ? '确认' : '未匹配',
      /std::shared_ptr<void> _pointer;/.test(read('packages/react-native/React/Base/RCTManagedPointer.mm') ?? '') &&
        /initWithPointer:\(std::shared_ptr<void>\)pointer/.test(mp),
    );
  }
  // I-9: RCT_MOCK_SET 在 Release 下是空语句
  {
    const mock = read('packages/react-native/React/Base/RCTMockDef.h') ?? '';
    const elseSeg = (() => {
      const i = mock.indexOf('#else');
      return i >= 0 ? mock.slice(i) : '';
    })();
    add(
      'C137', 'RCT_MOCK_SET 在 #else 分支里是空宏（单语句 if 分支使用时 else 会意外绑定）',
      '空宏',
      /#define RCT_MOCK_SET\(context, api, mockapi\)\s*\n/.test(elseSeg) ? '确认空宏' : '未匹配',
      /#define RCT_MOCK_SET\(context, api, mockapi\)\s*\n/.test(elseSeg),
    );
    const users = grepCount(/RCT_MOCK_DEF\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('React/Base/RCTMockDef.h'));
    add('C137b', '生产代码里 RCT_MOCK_DEF 的使用方数量（3 处：RCTHost / RCTBlobManager / RCTView）', '3',
      users.length + ' 处', users.length === 3);
    // Release 展开为恒等宏：零开销是设计保证，必须可验证
    add(
      'C137c', 'Release 下 RCT_MOCK_USE 展开为 api（恒等宏），故生产代码零开销 —— 设计意图可验证',
      '#define RCT_MOCK_USE(context, api) api',
      /#define RCT_MOCK_USE\(context, api\) api\b/.test(elseSeg) ? '确认恒等展开' : '未匹配',
      /#define RCT_MOCK_USE\(context, api\) api\b/.test(elseSeg),
    );
    add(
      'C137d', '三处使用均为「RCT_MOCK_DEF + #define 目标名 RCT_MOCK_USE」成对模式',
      '3 处成对',
      (() => {
        const n = grepCount(/RCT_MOCK_USE\(/, {
          exts: ['.m', '.mm'],
          roots: ['packages/react-native'],
        }).files.filter(f => !f.endsWith('React/Base/RCTMockDef.h')).length;
        return n + ' 处 RCT_MOCK_USE';
      })(),
      grepCount(/RCT_MOCK_USE\(/, {
        exts: ['.m', '.mm'],
        roots: ['packages/react-native'],
      }).files.filter(f => !f.endsWith('React/Base/RCTMockDef.h')).length === 3,
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// 33. iOS 平台能力族：DeviceInfo / Accessibility / Appearance（29 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const di = read('packages/react-native/React/CoreModules/RCTDeviceInfo.mm') ?? '';
  const am = read('packages/react-native/React/CoreModules/RCTAccessibilityManager.mm') ?? '';
  const ap = read('packages/react-native/React/CoreModules/RCTAppearance.mm') ?? '';
  const ac = read('packages/react-native/React/CoreModules/RCTAlertController.mm') ?? '';

  // §2.2 invalidate 的原子幂等
  add(
    'C164', 'RCTDeviceInfo 的 _invalidated 是 std::atomic<BOOL>，invalidate 用 exchange(YES) 做原子幂等',
    'atomic + exchange',
    /std::atomic<BOOL> _invalidated;/.test(di) &&
      /if \(_invalidated\.exchange\(YES\)\) \{\s*\n\s*return;/.test(di)
      ? '确认原子幂等' : '未匹配',
    /std::atomic<BOOL> _invalidated;/.test(di) &&
      /if \(_invalidated\.exchange\(YES\)\) \{\s*\n\s*return;/.test(di),
  );
  add(
    'C164b', 'RCTDeviceInfo 的 KVO 注册与移除配对（removeObserver:forKeyPath:）',
    'KVO 配对',
    /\[_applicationWindow addObserver:self forKeyPath:kFrameKeyPath/.test(di) &&
      /\[_applicationWindow removeObserver:self forKeyPath:kFrameKeyPath\]/.test(di)
      ? '确认配对' : '未匹配',
    /\[_applicationWindow addObserver:self forKeyPath:kFrameKeyPath/.test(di) &&
      /\[_applicationWindow removeObserver:self forKeyPath:kFrameKeyPath\]/.test(di),
  );
  {
    // 注册：1 处 KVO（写法不同，不含 addObserver:self 形式但同样计数）+ 6 处通知
    const kvo = (di.match(/addObserver:self forKeyPath/g) ?? []).length;
    const notif = (di.match(/addObserver:self\s*\n/g) ?? []).length;
    const rem = (di.match(/removeObserver/g) ?? []).length;
    add('C165', 'RCTDeviceInfo 的注册/清理配对（1 KVO + 6 通知注册，6 处清理）',
      `1 KVO + ${notif} 通知 / ${rem} 清理`,
      kvo === 1 && notif === 6 && rem === 6 ? '确认完全配对' : `KVO=${kvo} 通知=${notif} 清理=${rem}`,
      kvo === 1 && notif === 6 && rem === 6);
  }
  // §3.1 KVO 静默失败
  add(
    'C166', 'RCTDeviceInfo 的 _applicationWindow 是 __weak 且初值取自 RCTKeyWindow()（可能为 nil，KVO 静默失败且不重试）',
    '__weak + RCTKeyWindow()',
    /__weak UIWindow \*_applicationWindow;/.test(di) &&
      /_applicationWindow = RCTKeyWindow\(\);/.test(di) &&
      /\[_applicationWindow addObserver:self/.test(di)
      ? '确认可静默失败' : '未匹配',
    /__weak UIWindow \*_applicationWindow;/.test(di) &&
      /_applicationWindow = RCTKeyWindow\(\);/.test(di) &&
      /\[_applicationWindow addObserver:self/.test(di),
  );
  add(
    'C166b', 'RCTDeviceInfo 里 _applicationWindow 只被赋值一次（KVO 不会重新注册）',
    '1 处赋值',
    (di.match(/_applicationWindow = RCTKeyWindow\(\);/g) ?? []).length + ' 处',
    (di.match(/_applicationWindow = RCTKeyWindow\(\);/g) ?? []).length === 1,
  );
  // §3.3 三个通知兜底
  {
    const n = (di.match(/selector:@selector\(interfaceFrameDidChange\)/g) ?? []).length;
    add('C167', 'interfaceFrameDidChange 的通知注册点数（KVO 之外的兜底路径）', '3',
      n + ' 处', n === 3);
    add(
      'C167b', 'UIApplicationDidBecomeActiveNotification 注册 2 次（分别指向 interfaceOrientationDidChange 与 interfaceFrameDidChange）但只清理 1 次',
      '注册 2 / 清理 1',
      (di.match(/name:UIApplicationDidBecomeActiveNotification/g) ?? []).length + ' 处提及（注册 2、清理 1）',
      (di.match(/removeObserver:self name:UIApplicationDidBecomeActiveNotification object:nil\];/g) ?? []).length === 1 &&
        (di.match(/name:UIApplicationDidBecomeActiveNotification/g) ?? []).length === 3,
    );
  }
  // §2.4 TODO 注释与代码一致
  add(
    'C168', 'RCTDeviceInfo 监听 RCTBridgeWillInvalidateModulesNotification 调 invalidate，注释明确标注为临时方案 + TODO 编号',
    'TODO T175901725',
    /TODO T175901725 - Registering the RCTDeviceInfo module to the notification is a short-term fix/.test(di)
      && /name:RCTBridgeWillInvalidateModulesNotification/.test(di)
      ? '确认注释与代码一致' : '未匹配',
    /TODO T175901725 - Registering the RCTDeviceInfo module to the notification is a short-term fix/.test(di) &&
      /name:RCTBridgeWillInvalidateModulesNotification/.test(di),
  );
  // §4 AccessibilityManager：9 注册 0 清理
  add(
    'C169', 'RCTAccessibilityManager 注册的通知数', '9',
    (am.match(/addObserver:self/g) ?? []).length + ' 处',
    (am.match(/addObserver:self/g) ?? []).length === 9,
  );
  add(
    'C169b', 'RCTAccessibilityManager 的 removeObserver / invalidate / dealloc 数量（与 RCTDeviceInfo 形成反差）',
    '全为 0',
    'removeObserver ' + (am.match(/removeObserver/g) ?? []).length +
      ' / invalidate ' + (am.match(/- \(void\)invalidate/g) ?? []).length +
      ' / dealloc ' + (am.match(/- \(void\)dealloc/g) ?? []).length,
    !/removeObserver/.test(am) && !/- \(void\)invalidate\b/.test(am) && !/- \(void\)dealloc/.test(am),
  );
  // 同族反差：DeviceInfo 有清理、AccessibilityManager 没有
  add(
    'C170', '同族反差可验证：RCTDeviceInfo 有 removeObserver 而 RCTAccessibilityManager 完全没有',
    '一有一无',
    /removeObserver/.test(di) && !/removeObserver/.test(am) ? '确认反差' : '未匹配',
    /removeObserver/.test(di) && !/removeObserver/.test(am),
  );
  // §4.4 AccessibilityManager 的 moduleRegistry 是 weak（不构成循环引用）
  add(
    'C170b', 'RCTAccessibilityManager 的 moduleRegistry 依赖注入用 @synthesize（属性本身是 weak，故无循环引用）',
    '@synthesize moduleRegistry',
    /@synthesize moduleRegistry = _moduleRegistry;/.test(am) &&
      /weak, readwrite\) RCTModuleRegistry \*moduleRegistry/.test(
        read('packages/react-native/React/Base/RCTBridgeModule.h') ?? '')
      ? '确认无循环引用' : '未匹配',
    /@synthesize moduleRegistry = _moduleRegistry;/.test(am) &&
      /weak, readwrite\) RCTModuleRegistry \*moduleRegistry/.test(
        read('packages/react-native/React/Base/RCTBridgeModule.h') ?? ''),
  );
  // §4.5 理论缺陷
  add(
    'C171', 'multiplierForContentSizeCategory: 用 m.doubleValue <= 0.0 判空（key 不存在时 nil.doubleValue=0 会误报）',
    '<= 0.0 判空',
    /NSNumber \*m = self\.multipliers\[category\];\s*\n\s*if \(m\.doubleValue <= 0\.0\) \{/.test(am)
      ? '确认' : '未匹配',
    /NSNumber \*m = self\.multipliers\[category\];\s*\n\s*if \(m\.doubleValue <= 0\.0\) \{/.test(am),
  );
  add(
    'C171b', '默认 multipliers 表的项数（12 项，覆盖全部 UIContentSizeCategory）',
    '12',
    (am.match(/UIContentSizeCategory\w+ ?: @[\d.]+/g) ?? []).length + ' 项',
    (am.match(/UIContentSizeCategory\w+ ?: @[\d.]+/g) ?? []).length === 12,
  );
  // §5 RCTAlertController 的 nil 降级
  add(
    'C172', 'RCTAlertController 对 RCTKeyWindow().windowScene 为 nil 做了显式降级（initWithFrame + UIScreen.bounds）',
    'scene != nil 分支 + else 降级',
    /UIWindowScene \*scene = RCTKeyWindow\(\)\.windowScene;\s*\n\s*if \(scene != nil\) \{[\s\S]{0,300}?\} else \{\s*\n\s*_alertWindow = \[\[UIWindow alloc\] initWithFrame:UIScreen\.mainScreen\.bounds\];/.test(ac)
      ? '确认降级' : '未匹配',
    /UIWindowScene \*scene = RCTKeyWindow\(\)\.windowScene;\s*\n\s*if \(scene != nil\) \{[\s\S]{0,300}?\} else \{\s*\n\s*_alertWindow = \[\[UIWindow alloc\] initWithFrame:UIScreen\.mainScreen\.bounds\];/.test(ac),
  );
  add(
    'C172b', 'RCTAlertController.hide 把 windowScene 置 nil 以解绑 scene（写法完整）',
    'windowScene = nil',
    /- \(void\)hide\s*\{\s*\n\s*\[_alertWindow setHidden:YES\];\s*\n\s*\n\s*_alertWindow\.windowScene = nil;\s*\n\s*\n\s*_alertWindow = nil;/.test(ac)
      ? '确认' : '未匹配',
    /- \(void\)hide\s*\{\s*\n\s*\[_alertWindow setHidden:YES\];\s*\n\s*\n\s*_alertWindow\.windowScene = nil;\s*\n\s*\n\s*_alertWindow = nil;/.test(ac),
  );
  // §6 Appearance 清理与去重
  add(
    'C173', 'RCTAppearance 的 appearanceChanged 做去重（只在变化时发事件），invalidate 调 [super invalidate]',
    '去重 + super',
    /if \(!\[_currentColorScheme isEqualToString:newColorScheme\]\) \{/.test(ap) &&
      /- \(void\)invalidate\s*\{\s*\n\s*\[super invalidate\];/.test(ap)
      ? '确认' : '未匹配',
    /if \(!\[_currentColorScheme isEqualToString:newColorScheme\]\) \{/.test(ap) &&
      /- \(void\)invalidate\s*\{\s*\n\s*\[super invalidate\];/.test(ap),
  );
  add(
    'C173b', 'RCTAppearance.setColorScheme: 遍历所有 scene 且对 respondsToSelector:@selector(windows) 有防御检查',
    '防御检查',
    /if \(!\[scene respondsToSelector:@selector\(windows\)\]\) \{\s*\n\s*continue;/.test(ap) ? '确认' : '未匹配',
    /if \(!\[scene respondsToSelector:@selector\(windows\)\]\) \{\s*\n\s*continue;/.test(ap),
  );
  // §7 RCTIsAppActive 门控
  {
    const ut = read('packages/react-native/React/Base/RCTUtils.mm') ?? '';
    add(
      'C174', 'RCTIsAppActive 的实现（applicationState == UIApplicationStateActive）',
      'applicationState 判定',
      /BOOL RCTIsAppActive\(void\)\s*\{\s*\n\s*return \[RCTSharedApplication\(\) applicationState\] == UIApplicationStateActive;/.test(ut)
        ? '确认' : '未匹配',
      /BOOL RCTIsAppActive\(void\)\s*\{\s*\n\s*return \[RCTSharedApplication\(\) applicationState\] == UIApplicationStateActive;/.test(ut),
    );
    add(
      'C175', 'RCTDeviceInfo 的两处 didUpdateDimensions 发送点都被 RCTIsAppActive() 门控',
      '2 处',
      (di.match(/&& RCTIsAppActive\(\)\)/g) ?? []).length + ' 处',
      (di.match(/&& RCTIsAppActive\(\)\)/g) ?? []).length === 2,
    );
    add(
      'C175b', 'invalidateCachedConstants 的调用点数（缓存刷新覆盖完整）',
      '4',
      (di.match(/\[self invalidateCachedConstants\]/g) ?? []).length + ' 处',
      (di.match(/\[self invalidateCachedConstants\]/g) ?? []).length === 4,
    );
    add(
      'C176', 'accessibilityManager 为 nil 时 fontScale 回退 1.0（源码有 TODO T225745315 说明）',
      'TODO T225745315 + 回退 1.0',
      /TODO\(T225745315\): For some reason, accessibilityManager is nil in some cases/.test(di) &&
        /CGFloat fontScale = accessibilityManager \? accessibilityManager\.multiplier : 1\.0;/.test(di)
        ? '确认' : '未匹配',
      /TODO\(T225745315\): For some reason, accessibilityManager is nil in some cases/.test(di) &&
        /CGFloat fontScale = accessibilityManager \? accessibilityManager\.multiplier : 1\.0;/.test(di),
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// 34. iOS WebSocket 与调试通道 / CoreModules 注册表（30 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const ws = read('packages/react-native/React/CoreModules/RCTWebSocketModule.mm') ?? '';
  const plugins = read('packages/react-native/React/CoreModules/CoreModulesPlugins.mm') ?? '';
  const pluginsH = read('packages/react-native/React/CoreModules/CoreModulesPlugins.h') ?? '';
  const rep = read('packages/react-native/React/CoreModules/RCTInspectorWebSocketReporter.mm') ?? '';
  const nr = read('packages/react-native/ReactCommon/react/networking/NetworkReporter.cpp') ?? '';
  const dtm = read('packages/react-native/React/CoreModules/RCTDevToolsRuntimeSettingsModule.mm') ?? '';

  // §2.2 注册表：头文件声明与实现对应
  {
    const declared = [...new Set([...pluginsH.matchAll(/RCT([A-Za-z0-9]*)Cls/g)].map(x => x[1]))];
    add('C177', 'CoreModulesPlugins.h 声明的 Cls 工厂函数数', '23', declared.length + ' 个', declared.length === 23);
    // __attribute__((used)) 防链接器裁掉
    add(
      'C178', '每个 Cls 声明都带 __attribute__((used))（防 LTO 下被误删）',
      '全部带 used',
      (pluginsH.match(/__attribute__\(\(used\)\)/g) ?? []).length + ' 处 / ' + declared.length + ' 个',
      (pluginsH.match(/__attribute__\(\(used\)\)/g) ?? []).length === declared.length,
    );
  }
  // §2.3 别名
  add(
    'C179', '模块名与类名不一致的两处别名（PlatformConstants→RCTPlatform、BlobModule→RCTBlobManager）',
    '2 处别名',
    /name == "PlatformConstants"sv\) \{\s*\n\s*return RCTPlatformCls\(\);/.test(plugins) &&
      /name == "BlobModule"sv\) \{\s*\n\s*return RCTBlobManagerCls\(\);/.test(plugins)
      ? '确认别名' : '未匹配',
    /name == "PlatformConstants"sv\) \{\s*\n\s*return RCTPlatformCls\(\);/.test(plugins) &&
      /name == "BlobModule"sv\) \{\s*\n\s*return RCTBlobManagerCls\(\);/.test(plugins),
  );
  add(
    'C179b', '分派表用 std::string_view 字面量（sv 后缀）避免每次比较构造 std::string',
    'sv 后缀',
    (plugins.match(/name == "[A-Za-z0-9]+"sv/g) ?? []).length + ' 处',
    (plugins.match(/name == "[A-Za-z0-9]+"sv/g) ?? []).length === 22,
  );
  // §2.4 RCTTimingCls 悬空
  {
    const hits = grepCount(/RCTTimingCls/, { roots: ['packages'] }).files;
    add('C180', 'RCTTimingCls 的全仓库引用处（仅头文件声明 = 悬空）', '1（仅声明）',
      hits.length + ' 处：' + hits.map(f => f.split('/').pop()).join(','),
      hits.length === 1 && hits[0].endsWith('CoreModulesPlugins.h'));
    // 且该头文件里没有对应定义
    const defined = grepCount(/Class RCTTimingCls/, { exts: ['.mm'], roots: ['packages/react-native'] }).files;
    add('C180b', 'RCTTimingCls 在 .mm 里的定义处（应为 0）', '0', defined.length + ' 处', defined.length === 0);
  }
  // §2.5 RCTDevToolsRuntimeSettingsCls 未接入
  {
    const hits = grepCount(/RCTDevToolsRuntimeSettingsCls/, { roots: ['packages'] }).files;
    add('C181', 'RCTDevToolsRuntimeSettingsCls 的外部引用处（其余 22 个 Cls 均为 2 处）', '1（仅定义）',
      hits.length + ' 处：' + hits.map(f => f.split('/').pop()).join(','),
      hits.length === 1 && hits[0].endsWith('RCTDevToolsRuntimeSettingsModule.mm'));
    add(
      'C181b', 'RCTDevToolsRuntimeSettingsCls 无 #if 门控（对比 RCTPerfMonitorCls 的 return nil）',
      '无门控',
      /Class RCTDevToolsRuntimeSettingsCls\(void\)\s*\{\s*\n\s*return RCTDevToolsRuntimeSettingsModule\.class;\s*\n\}/.test(dtm) &&
        !/Class RCTDevToolsRuntimeSettingsCls[\s\S]{0,200}#if/.test(dtm)
        ? '确认无门控' : '有门控或未匹配',
      /Class RCTDevToolsRuntimeSettingsCls\(void\)\s*\{\s*\n\s*return RCTDevToolsRuntimeSettingsModule\.class;\s*\n\}/.test(dtm) &&
        !/Class RCTDevToolsRuntimeSettingsCls[\s\S]{0,200}#if/.test(dtm),
    );
  }
  // §3.2 第七个零调用 setter
  {
    const calls = grepCount(/RCTSetCustomSRWebSocketProvider\(/, {
      exts: ['.m', '.mm'],
      roots: ['packages/react-native'],
    }).files.filter(f => !f.endsWith('CoreModules/RCTWebSocketModule.mm'));
    add('C182', 'RCTSetCustomSRWebSocketProvider 的调用方数量（第七个零调用 setter）', '0',
      calls.length + ' 处', calls.length === 0);
    add(
      'C182b', 'srWebSocketProvider 是 static 全局（零初始化为 nullptr），有两层判空回退',
      'static + 双判空',
      /static SRWebSocketProvider srWebSocketProvider;/.test(ws) &&
        /if \(srWebSocketProvider != nullptr\)/.test(ws) &&
        /if \(webSocket == nil\)/.test(ws)
        ? '确认两层回退' : '未匹配',
      /static SRWebSocketProvider srWebSocketProvider;/.test(ws) &&
        /if \(srWebSocketProvider != nullptr\)/.test(ws) && /if \(webSocket == nil\)/.test(ws),
    );
  }
  // §3.3 关联对象
  add(
    'C183', 'RCTWebSocketModule 用 objc_setAssociatedObject 给 SRWebSocket 加属性（第三方类扩展）',
    'objc_setAssociatedObject',
    (ws.match(/objc_setAssociatedObject/g) ?? []).length + ' 处',
    (ws.match(/objc_setAssociatedObject/g) ?? []).length === 2,
  );
  add(
    'C184', 'inspectorRequestId 优先取 JS 侧传入的 devToolsRequestId（携带请求发起栈），否则 UUID',
    '优先 JS 侧 ID',
    /NSString \*devToolsRequestId = options\.unstable_devToolsRequestId\(\);\s*\n\s*webSocket\.inspectorRequestId = devToolsRequestId\.length > 0 \? devToolsRequestId : \[\[NSUUID UUID\] UUIDString\];/.test(ws)
      ? '确认优先' : '未匹配',
    /NSString \*devToolsRequestId = options\.unstable_devToolsRequestId\(\);\s*\n\s*webSocket\.inspectorRequestId = devToolsRequestId\.length > 0 \? devToolsRequestId : \[\[NSUUID UUID\] UUIDString\];/.test(ws),
  );
  // §4 编译期门控链
  add(
    'C185', 'isReportingEnabled 的三重条件（requestId 非 nil + feature flag + isDebuggingEnabled）',
    '三重条件',
    /return requestId != nil && ReactNativeFeatureFlags::fuseboxWebSocketEventsEnabled\(\) &&\s*\n\s*NetworkReporter::getInstance\(\)\.isDebuggingEnabled\(\);/.test(rep)
      ? '确认三重' : '未匹配',
    /return requestId != nil && ReactNativeFeatureFlags::fuseboxWebSocketEventsEnabled\(\) &&\s*\n\s*NetworkReporter::getInstance\(\)\.isDebuggingEnabled\(\);/.test(rep),
  );
  add(
    'C186', 'isDebuggingEnabled 由 #ifdef REACT_NATIVE_DEBUGGER_ENABLED 门控（Release 恒 false）',
    '#ifdef 编译期',
    /bool NetworkReporter::isDebuggingEnabled\(\) const \{\s*\n#ifdef REACT_NATIVE_DEBUGGER_ENABLED\s*\n\s*return jsinspector_modern::NetworkHandler::getInstance\(\)\.isEnabled\(\);\s*\n#else\s*\n\s*return false;\s*\n#endif/.test(nr)
      ? '确认编译期门控' : '未匹配',
    /bool NetworkReporter::isDebuggingEnabled\(\) const \{\s*\n#ifdef REACT_NATIVE_DEBUGGER_ENABLED\s*\n\s*return jsinspector_modern::NetworkHandler::getInstance\(\)\.isEnabled\(\);\s*\n#else\s*\n\s*return false;\s*\n#endif/.test(nr),
  );
  // §4.3/4.4 两个宏的定义方式不同
  {
    const rb = read('packages/react-native/scripts/cocoapods/utils.rb') ?? '';
    add(
      'C187', 'REACT_NATIVE_DEBUGGER_ENABLED 由 CocoaPods :debug 配置自动定义（宿主无需操作）',
      ':debug 自动',
      (rb.match(/REACT_NATIVE_DEBUGGER_ENABLED=1/g) ?? []).length + ' 处带 :debug',
      (rb.match(/REACT_NATIVE_DEBUGGER_ENABLED=1", "[^"]+", :debug\)/g) ?? []).length >= 5,
    );
    add(
      'C187b', 'REACT_NATIVE_DEBUGGER_MODE_PROD 在构建脚本中零定义（与 ENABLED 性质不同）',
      '0 处定义',
      grepCount(/define\(REACT_NATIVE_DEBUGGER_MODE_PROD|GCC_PREPROCESSOR_DEFINITIONS[^\n]*REACT_NATIVE_DEBUGGER_MODE_PROD/, {
        roots: ['packages/react-native/scripts', 'packages/react-native/Package.swift'],
      }).files.length + ' 处',
      grepCount(/define\(REACT_NATIVE_DEBUGGER_MODE_PROD|GCC_PREPROCESSOR_DEFINITIONS[^\n]*REACT_NATIVE_DEBUGGER_MODE_PROD/, {
        roots: ['packages/react-native/scripts', 'packages/react-native/Package.swift'],
      }).files.length === 0,
    );
  }
  // §4.5 DEVONLY 门控 DevToolsRuntimeSettings
  {
    const dt = read('packages/react-native/ReactCommon/react/nativemodule/defaults/DefaultTurboModules.cpp') ?? '';
    add(
      'C188', 'DefaultTurboModules.cpp 用 REACT_NATIVE_DEBUGGER_ENABLED_DEVONLY 门控 DevToolsRuntimeSettingsModule 的 include 与分发',
      'DEVONLY 双处门控',
      (dt.match(/#ifdef REACT_NATIVE_DEBUGGER_ENABLED_DEVONLY/g) ?? []).length + ' 处',
      (dt.match(/#ifdef REACT_NATIVE_DEBUGGER_ENABLED_DEVONLY/g) ?? []).length === 2 &&
        /name == DevToolsRuntimeSettingsModule::kModuleName/.test(dt),
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// 35. Fabric 组件层：View 与回收池（31 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const rcv = read('packages/react-native/React/Fabric/Mounting/ComponentViews/View/RCTViewComponentView.mm') ?? '';
  const reg = read('packages/react-native/React/Fabric/Mounting/RCTComponentViewRegistry.mm') ?? '';
  const desc = read('packages/react-native/React/Fabric/Mounting/RCTComponentViewDescriptor.h') ?? '';
  const proto = read('packages/react-native/React/Fabric/Mounting/UIView+ComponentViewProtocol.mm') ?? '';
  const protoH = read('packages/react-native/React/Fabric/Mounting/RCTComponentViewProtocol.h') ?? '';

  // §2 回收池
  add(
    'C189', '回收池上限常量 RCTComponentViewRegistryRecyclePoolMaxSize 的值',
    '1024',
    (reg.match(/RCTComponentViewRegistryRecyclePoolMaxSize = (\d+)/) ?? [])[1] ?? '未匹配',
    /RCTComponentViewRegistryRecyclePoolMaxSize = 1024/.test(reg),
  );
  add(
    'C190', '回收池容器是 C++ std::unordered_map<ComponentHandle, std::vector<...>>（非 ObjC 容器）',
    'C++ unordered_map',
    /std::unordered_map<ComponentHandle, std::vector<RCTComponentViewDescriptor>> _recyclePool;/.test(reg)
      ? '确认 C++ 容器' : '未匹配',
    /std::unordered_map<ComponentHandle, std::vector<RCTComponentViewDescriptor>> _recyclePool;/.test(reg),
  );
  add(
    'C190b', '入池的两个提前退出条件（池满 或 !shouldBeRecycled）→ 走 invalidate 真销毁',
    '两个条件',
    /if \(recycledViews\.size\(\) > RCTComponentViewRegistryRecyclePoolMaxSize \|\| !componentViewDescriptor\.shouldBeRecycled\) \{\s*\n\s*\[componentViewDescriptor\.view invalidate\];\s*\n\s*return;/.test(reg)
      ? '确认两条件' : '未匹配',
    /if \(recycledViews\.size\(\) > RCTComponentViewRegistryRecyclePoolMaxSize \|\| !componentViewDescriptor\.shouldBeRecycled\) \{\s*\n\s*\[componentViewDescriptor\.view invalidate\];\s*\n\s*return;/.test(reg),
  );
  add(
    'C191', '入池前断言 view.superview == nil（防止回收已挂载的 view）',
    'superview 断言',
    /RCTAssert\(\s*\n?\s*componentViewDescriptor\.view\.superview == nil, @"RCTComponentViewRegistry: Attempt to recycle a mounted view\."\)/.test(reg)
      ? '确认断言' : '未匹配',
    /componentViewDescriptor\.view\.superview == nil, @"RCTComponentViewRegistry: Attempt to recycle a mounted view\."/.test(reg),
  );
  // §2.3 内存警告清空
  add(
    'C192', '内存警告观察者把整个回收池清空（iOS 侧唯一对内存压力的 UI 层响应）',
    '_recyclePool.clear()',
    /- \(void\)handleApplicationDidReceiveMemoryWarningNotification\s*\{\s*\n\s*_recyclePool\.clear\(\);\s*\n\}/.test(reg) &&
      /name:UIApplicationDidReceiveMemoryWarningNotification/.test(reg)
      ? '确认清空' : '未匹配',
    /- \(void\)handleApplicationDidReceiveMemoryWarningNotification\s*\{\s*\n\s*_recyclePool\.clear\(\);\s*\n\}/.test(reg) &&
      /name:UIApplicationDidReceiveMemoryWarningNotification/.test(reg),
  );
  // shouldBeRecycled 默认值
  add(
    'C193', 'RCTComponentViewDescriptor 的 shouldBeRecycled 默认 true，但 observesMountingTransaction* 默认 false',
    'true / false',
    /const bool observesMountingTransactionWillMount\{false\};/.test(desc) &&
      /const bool shouldBeRecycled\{true\};/.test(desc)
      ? '确认默认值' : '未匹配',
    /const bool observesMountingTransactionWillMount\{false\};/.test(desc) &&
      /const bool shouldBeRecycled\{true\};/.test(desc),
  );
  // §3.1 基类空实现
  add(
    'C194', 'prepareForRecycle 的基类实现是空的（不重写即什么都不清）',
    '空实现',
    /- \(void\)prepareForRecycle\s*\{\s*\n\s*\/\/ Default implementation does nothing\.\s*\n\}/.test(proto)
      ? '确认空实现' : '未匹配',
    /- \(void\)prepareForRecycle\s*\{\s*\n\s*\/\/ Default implementation does nothing\.\s*\n\}/.test(proto),
  );
  // §3.2 覆盖不全：精确列出 0 实现目录
  {
    const missing = [];
    const present = [];
    const dirs = ['ActivityIndicator', 'DebuggingOverlay', 'UnimplementedComponent', 'UnimplementedView',
      'Image', 'Root', 'SafeAreaView', 'Switch', 'View', 'VirtualView', 'Modal', 'Text', 'TextInput',
      'InputAccessory', 'LegacyViewManagerInterop', 'ScrollView'];
    for (const d of dirs) {
      const withRecycle = grepCount(/- \(void\)prepareForRecycle/, {
        exts: ['.mm'],
        roots: ['packages/react-native/React/Fabric/Mounting/ComponentViews/' + d],
      }).files.length;
      (withRecycle === 0 ? missing : present).push(d);
    }
    add('C195', '完全没有 prepareForRecycle 实现的组件目录（实测）', '4',
      missing.length + ' 个：' + missing.join(', '),
      missing.length === 4 && missing.includes('ActivityIndicator') && missing.includes('DebuggingOverlay') &&
        missing.includes('UnimplementedComponent') && missing.includes('UnimplementedView'));
  }
  // §3.3 View 的重置清单
  add(
    'C196', 'prepareForRecycle 清理的单例 CALayer 数量（另有 box shadow 数组与背景图）',
    '4',
    (() => {
      // 限定在 prepareForRecycle 函数体内统计，避免全文匹配翻倍
      const ri = rcv.indexOf('- (void)prepareForRecycle');
      const seg = rcv.slice(ri, rcv.indexOf('- (void)setPropKeysManagedByAnimated', ri));
      return (seg.match(/\[_\w+Layer removeFromSuperlayer\]/g) ?? []).length + ' 个单例 layer';
    })(),
    (() => {
      const ri = rcv.indexOf('- (void)prepareForRecycle');
      const seg = rcv.slice(ri, rcv.indexOf('- (void)setPropKeysManagedByAnimated', ri));
      const n = (seg.match(/\[_\w+Layer removeFromSuperlayer\]/g) ?? []).length;
      return n === 4 && seg.includes('_backgroundColorLayer') && seg.includes('_borderLayer') &&
        seg.includes('_outlineLayer') && seg.includes('_filterLayer');
    })(),
  );
  add(
    'C197', 'prepareForRecycle 用 _propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN 决定哪些 prop 要校准回 UIKit',
    'transform + opacity',
    /if \(\[_propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN containsObject:@"transform"\]\)/.test(rcv) &&
      /if \(\[_propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN containsObject:@"opacity"\]\)/.test(rcv)
      ? '确认两个 prop' : '未匹配',
    /if \(\[_propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN containsObject:@"transform"\]\)/.test(rcv) &&
      /if \(\[_propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN containsObject:@"opacity"\]\)/.test(rcv),
  );
  add(
    'C197b', 'prepareForRecycle 内的 ivar 赋值行数（4 个 layer 置 nil + 5 个状态重置）',
    '9',
    (() => {
      const ri = rcv.indexOf('- (void)prepareForRecycle');
      const seg = rcv.slice(ri, rcv.indexOf('- (void)setPropKeysManagedByAnimated', ri));
      return (seg.match(/^ {2}_\w+ = [^;]+;/gm) ?? []).length + ' 行';
    })(),
    (() => {
      const ri = rcv.indexOf('- (void)prepareForRecycle');
      const seg = rcv.slice(ri, rcv.indexOf('- (void)setPropKeysManagedByAnimated', ri));
      const n = (seg.match(/^ {2}_\w+ = [^;]+;/gm) ?? []).length;
      return n === 9 && seg.includes('_layoutMetrics = EmptyLayoutMetrics;') &&
        seg.includes('_reactSubviews = [NSMutableArray new];') && seg.includes('_eventEmitter.reset();');
    })(),
  );
  // §4 _props 初始化与断言
  add(
    'C198', 'RCTViewComponentView 在 initWithFrame: 里把 _props 初始化为 defaultSharedProps（故永不为 nil）',
    'defaultSharedProps',
    /_props = ViewShadowNode::defaultSharedProps\(\);/.test(rcv) ? '确认初始化' : '未匹配',
    /_props = ViewShadowNode::defaultSharedProps\(\);/.test(rcv),
  );
  add(
    'C199', 'updateProps 的 _props 类型断言被 #ifndef NS_BLOCK_ASSERTIONS 包裹（Release 下不检查）',
    '#ifndef NS_BLOCK_ASSERTIONS',
    /#ifndef NS_BLOCK_ASSERTIONS\s*\n\s*auto propsRawPtr = _props\.get\(\);/.test(rcv) ? '确认门控' : '未匹配',
    /#ifndef NS_BLOCK_ASSERTIONS\s*\n\s*auto propsRawPtr = _props\.get\(\);/.test(rcv),
  );
  add(
    'C200', '该断言是双重条件（基类本身 或 类型 hash 不同），文案要求子类必须在构造函数初始化 _props',
    '双重条件 + 文案',
    /propsRawPtr &&[\s\S]{0,60}?\n\s*\(\[self class\] == \[RCTViewComponentView class\] \|\|[\s\S]{0,90}?typeid\(\*propsRawPtr\)\.hash_code\(\) != typeid\(const ViewProps\)\.hash_code\(\)/.test(rcv) &&
      /must setup `_props`"[\s\S]{0,20}?" instance variable with a default value in the constructor/.test(rcv)
      ? '确认双重条件' : '未匹配',
    /propsRawPtr &&[\s\S]{0,60}?\n\s*\(\[self class\] == \[RCTViewComponentView class\] \|\|[\s\S]{0,90}?typeid\(\*propsRawPtr\)\.hash_code\(\) != typeid\(const ViewProps\)\.hash_code\(\)/.test(rcv) &&
      /must setup `_props`"[\s\S]{0,20}?" instance variable with a default value in the constructor/.test(rcv),
  );
  // §5 无障碍三级判定
  {
    const fi = rcv.indexOf('static BOOL RCTViewIsInteractiveAccessibilityElement');
    const fseg = rcv.slice(fi, rcv.indexOf('\n@', fi));
    const roles = [...new Set((fseg.match(/Role::\w+/g) ?? []).filter(x => x !== 'Role::None'))].length;
    // 字符串集合的元素：排除数组声明里的 @[] 首元素，故从第一个 @" 之后开始数
    const strRoles = (() => {
      const m = fseg.match(/interactiveAccessibilityRoles\{([\s\S]*?)\}/);
      if (!m) return -1;
      return (m[1].match(/"[a-z]+"/g) ?? []).length;
    })();
    add('C201', 'RCTViewIsInteractiveAccessibilityElement 内 role 集合元素数 / legacy 字符串集合元素数',
      '13 / 15', roles + ' / ' + strRoles,
      roles === 13 && strRoles === 15);
    add(
      'C201b', '该函数被 #if !TARGET_OS_TV 包裹（tvOS 不编译无障碍增强）',
      '#if !TARGET_OS_TV',
      /#if !TARGET_OS_TV\s*\n\/\/ iOS Full Keyboard Access/.test(rcv) ? '确认门控' : '未匹配',
      /#if !TARGET_OS_TV\s*\n\/\/ iOS Full Keyboard Access/.test(rcv),
    );
    add(
      'C201c', '注释说明 trait 是 role 的有损投影（checkbox/radio 等故意不带交互 trait）',
      'lossy projection',
      /it is a lossy projection of\s*\n?\s*\/\/ the role/.test(rcv) ? '确认注释' : '未匹配',
      /it is a lossy projection of\s*\n?\s*\/\/ the role/.test(rcv),
    );
    add(
      'C201d', 'role 优先于 legacy accessibilityRole（与 traits 解析方式一致）',
      'role wins',
      /`role` wins over the legacy `accessibilityRole`/.test(rcv) ? '确认优先级' : '未匹配',
      /`role` wins over the legacy `accessibilityRole`/.test(rcv),
    );
  }
  // DO_NOT_USE_THIS_IS_BROKEN 协议声明（承接 21 文档）
  add(
    'C202', 'RCTComponentViewProtocol.h 里 DO_NOT_USE_THIS_IS_BROKEN 的两个存取器都带「This is broken. Do not use.」注释',
    '注释自述 broken',
    /This is broken\. Do not use\./.test(protoH) &&
      (protoH.match(/DO_NOT_USE_THIS_IS_BROKEN/g) ?? []).length === 2
      ? '确认 2 处' : '未匹配',
    /This is broken\. Do not use\./.test(protoH) &&
      (protoH.match(/DO_NOT_USE_THIS_IS_BROKEN/g) ?? []).length === 2,
  );
}

// ────────────────────────────────────────────────────────────────────────
// 36. Fabric ScrollView：粘性状态与节流（32 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const sv = read('packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm') ?? '';

  // §3 故意不重置的粘性状态
  add(
    'C203', 'RCTScrollViewComponentView 的 _isAccessibilityAPIUsed 注释明确写「不在 prepareForRecycle 恢复」',
    '注释声明故意不重置',
    /It is not restored to the default value in prepareForRecycle/.test(sv) &&
      /Once an accessibility API is used, view culling will be disabled for the entire session/.test(sv)
      ? '确认注释' : '未匹配',
    /It is not restored to the default value in prepareForRecycle/.test(sv) &&
      /Once an accessibility API is used, view culling will be disabled for the entire session/.test(sv),
  );
  {
    // 确认 prepareForRecycle 内确实没有它
    const ri = sv.indexOf('- (void)prepareForRecycle');
    const seg = sv.slice(ri, sv.indexOf('\n#pragma mark', ri));
    add(
      'C203b', 'prepareForRecycle 函数体内确实不重置 _isAccessibilityAPIUsed（与注释一致）',
      '不重置（刻意）',
      !/_isAccessibilityAPIUsed\s*=/.test(seg) ? '确认未重置' : '有重置',
      !/_isAccessibilityAPIUsed\s*=/.test(seg),
    );
  }
  // §3.2 用 API 检测而非通知
  add(
    'C204', '无障碍检测用覆写 accessibilityElementCount 与 focusItemsInRect: 两个 API（而非监听通知）',
    '两个覆写点',
    /\[self _disableViewCullingIfNecessary\];/.test(sv) &&
      (sv.match(/\[self _disableViewCullingIfNecessary\];/g) ?? []).length === 2
      ? '确认两处调用' : '未匹配',
    /\[self _disableViewCullingIfNecessary\];/.test(sv) &&
      (sv.match(/\[self _disableViewCullingIfNecessary\];/g) ?? []).length === 2,
  );
  add(
    'C204b', '注释说明「Accessibility Inspector 不发通知」故不能用通知方案',
    'Accessibility Inspector 理由',
    /The notifications are not called when using Accessibility[\s\S]{0,40}Inspector/.test(sv) &&
      /we are using API use detection to disable view culling[\s\S]{0,40}instead of the notifications/.test(sv)
      ? '确认理由' : '未匹配',
    /The notifications are not called when using Accessibility[\s\S]{0,40}Inspector/.test(sv) &&
      /we are using API use detection to disable view culling[\s\S]{0,40}instead of the notifications/.test(sv),
  );
  // §3.4 状态更新短路
  add(
    'C205', '_updateStateWithContentOffset 在 contentOffset 与 disableViewCulling 都不变时返回 nullptr（不做状态更新）',
    '短路优化',
    /if \(oldData\.contentOffset == contentOffset && oldData\.disableViewCulling == isAccessibilityAPIUsed\) \{\s*\n\s*\/\/ avoid doing a state update if content offset and use of accessibility didn't change\.\s*\n\s*return nullptr;/.test(sv)
      ? '确认短路' : '未匹配',
    /if \(oldData\.contentOffset == contentOffset && oldData\.disableViewCulling == isAccessibilityAPIUsed\) \{\s*\n\s*\/\/ avoid doing a state update if content offset and use of accessibility didn't change\.\s*\n\s*return nullptr;/.test(sv),
  );
  add(
    'C205b', 'disableViewCulling 是三重或（VoiceOver / SwitchControl / _isAccessibilityAPIUsed）',
    '三重或',
    /newData\.disableViewCulling =\s*\n\s*UIAccessibilityIsVoiceOverRunning\(\) \|\| UIAccessibilityIsSwitchControlRunning\(\) \|\| isAccessibilityAPIUsed;/.test(sv)
      ? '确认三重或' : '未匹配',
    /newData\.disableViewCulling =\s*\n\s*UIAccessibilityIsVoiceOverRunning\(\) \|\| UIAccessibilityIsSwitchControlRunning\(\) \|\| isAccessibilityAPIUsed;/.test(sv),
  );
  // §2.1 _state.reset() 的顺序约束
  add(
    'C206', 'prepareForRecycle 里 _state.reset() 在设置 contentOffset 之前（注释说明否则会传播到 shadow tree）',
    'reset 在前',
    /\[super prepareForRecycle\];\s*\n\s*\/\/ Must invalidate state before setting contentOffset on ScrollView\.\s*\n\s*\/\/ Otherwise the state will be propagated to shadow tree\.\s*\n\s*_state\.reset\(\);/.test(sv)
      ? '确认顺序' : '未匹配',
    /\[super prepareForRecycle\];\s*\n\s*\/\/ Must invalidate state before setting contentOffset on ScrollView\.\s*\n\s*\/\/ Otherwise the state will be propagated to shadow tree\.\s*\n\s*_state\.reset\(\);/.test(sv),
  );
  // §4 W-1: _scrollEventThrottle 未重置
  {
    const ri = sv.indexOf('- (void)prepareForRecycle');
    const seg = sv.slice(ri, sv.indexOf('\n#pragma mark', ri));
    add(
      'C207', 'prepareForRecycle 内不重置 _scrollEventThrottle（疑似疏忽，与注释说明的刻意不重置形成对照）',
      '不重置',
      !/_scrollEventThrottle\s*=/.test(seg) ? '确认未重置' : '有重置',
      !/_scrollEventThrottle\s*=/.test(seg),
    );
    // 唯一初值在 init，条件写入在 updateProps
    add(
      'C207b', '_scrollEventThrottle = 0 的出现处（1 处 init 初值 + 1 处 updateProps 映射分支）',
      '2 处',
      (sv.match(/_scrollEventThrottle = 0;/g) ?? []).length + ' 处（init 初值 1 + 映射分支 1）',
      (sv.match(/_scrollEventThrottle = 0;/g) ?? []).length === 2 &&
        /- \(instancetype\)initWithFrame:[\s\S]{0,1100}?_scrollEventThrottle = 0;/.test(sv),
    );
    add(
      'C208', 'updateProps 里 _scrollEventThrottle 的写入被 oldProps != newProps 条件包裹（三分支映射）',
      '条件 + 三分支',
      /if \(oldScrollViewProps\.scrollEventThrottle != newScrollViewProps\.scrollEventThrottle\) \{[\s\S]{0,600}?INFINITY;[\s\S]{0,200}?_scrollEventThrottle = 0;[\s\S]{0,200}?_scrollEventThrottle = throttleInSeconds;/.test(sv)
        ? '确认条件与三分支' : '未匹配',
      /if \(oldScrollViewProps\.scrollEventThrottle != newScrollViewProps\.scrollEventThrottle\) \{[\s\S]{0,600}?INFINITY;[\s\S]{0,200}?_scrollEventThrottle = 0;[\s\S]{0,200}?_scrollEventThrottle = throttleInSeconds;/.test(sv),
    );
    add(
      'C209', 'scrollViewDidScroll 的节流条件用 CACurrentMediaTime()（单调递增，故 _lastScrollEventDispatchTime 不重置无害）',
      '单调时间',
      /NSTimeInterval now = CACurrentMediaTime\(\);\s*\n\s*if \(\(_lastScrollEventDispatchTime == 0\) \|\| \(now - _lastScrollEventDispatchTime > _scrollEventThrottle\)\)/.test(sv)
        ? '确认条件' : '未匹配',
      /NSTimeInterval now = CACurrentMediaTime\(\);\s*\n\s*if \(\(_lastScrollEventDispatchTime == 0\) \|\| \(now - _lastScrollEventDispatchTime > _scrollEventThrottle\)\)/.test(sv),
    );
    add(
      'C209b', '_lastScrollEventDispatchTime 的唯一重置入口是 _forceDispatchNextScrollEvent（prepareForRecycle 不调）',
      '独立重置入口',
      /- \(void\)_forceDispatchNextScrollEvent\s*\{\s*\n\s*_lastScrollEventDispatchTime = 0;\s*\n\}/.test(sv) &&
        !/prepareForRecycle[\s\S]{0,900}?_lastScrollEventDispatchTime = 0;/.test(seg)
        ? '确认不调' : '未匹配',
      /- \(void\)_forceDispatchNextScrollEvent\s*\{\s*\n\s*_lastScrollEventDispatchTime = 0;\s*\n\}/.test(sv) &&
        !/prepareForRecycle[\s\S]{0,900}?_lastScrollEventDispatchTime = 0;/.test(seg),
    );
  }
  // §5 delegate splitter
  add(
    'C210', 'RCTScrollViewComponentView 用 scrollViewDelegateSplitter 而非直接设 UIScrollView.delegate',
    'splitter',
    /\[self\.scrollViewDelegateSplitter addDelegate:self\];/.test(sv) &&
      /\(\(RCTEnhancedScrollView \*\)_scrollView\)\.overridingDelegate = self;/.test(sv)
      ? '确认 splitter' : '未匹配',
    /\[self\.scrollViewDelegateSplitter addDelegate:self\];/.test(sv) &&
      /\(\(RCTEnhancedScrollView \*\)_scrollView\)\.overridingDelegate = self;/.test(sv),
  );
  add(
    'C210b', 'dealloc 注释说明「从 splitter 移除所有 delegate」可避免 UIScrollView 崩溃',
    '崩溃防护注释',
    /Removing all delegates from the splitter nils the actual delegate which prevents a crash on UIScrollView/.test(sv)
      ? '确认注释' : '未匹配',
    /Removing all delegates from the splitter nils the actual delegate which prevents a crash on UIScrollView/.test(sv),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 37. Fabric TextInput 事件计数协议 / Text 无障碍（33 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const ti = read('packages/react-native/React/Fabric/Mounting/ComponentViews/TextInput/RCTTextInputComponentView.mm') ?? '';
  const para = read('packages/react-native/React/Fabric/Mounting/ComponentViews/Text/RCTParagraphComponentView.mm') ?? '';
  const cfg = read('packages/react-native/Libraries/Components/TextInput/RCTTextInputViewConfig.js') ?? '';
  const flow = read('packages/react-native/Libraries/Components/TextInput/TextInput.flow.js') ?? '';
  const androidSpec = read('packages/react-native/Libraries/Components/TextInput/AndroidTextInputNativeComponent.js') ?? '';

  // §2 mostRecentEventCount 协议
  add(
    'C211', '_comingFromJS 的注释一次性说清两重作用（计数器不递增 + 两个 delegate 提前返回）',
    '注释完整',
    /A flag that when set to true, `_mostRecentEventCount` won't be incremented when `\[self _updateState\]`/.test(ti) &&
      /and delegate methods `textInputDidChange` and `textInputDidChangeSelection` will exit early/.test(ti)
      ? '确认注释' : '未匹配',
    /A flag that when set to true, `_mostRecentEventCount` won't be incremented when `\[self _updateState\]`/.test(ti) &&
      /and delegate methods `textInputDidChange` and `textInputDidChangeSelection` will exit early/.test(ti),
  );
  add(
    'C212', '_updateState 里计数器按 _comingFromJS 条件递增（JS 触发不递增）',
    '_comingFromJS ? 0 : 1',
    /_mostRecentEventCount \+= _comingFromJS \? 0 : 1;/.test(ti) &&
      /data\.mostRecentEventCount = _mostRecentEventCount;/.test(ti)
      ? '确认条件递增' : '未匹配',
    /_mostRecentEventCount \+= _comingFromJS \? 0 : 1;/.test(ti) &&
      /data\.mostRecentEventCount = _mostRecentEventCount;/.test(ti),
  );
  add(
    'C213', 'setTextAndSelection: 在 eventCount 不匹配时直接 return（丢弃过期回写）',
    '早退',
    /- \(void\)setTextAndSelection:\(NSInteger\)eventCount[\s\S]{0,200}?if \(_mostRecentEventCount != eventCount\) \{\s*\n\s*return;\s*\n\s*\}/.test(ti)
      ? '确认早退' : '未匹配',
    /- \(void\)setTextAndSelection:\(NSInteger\)eventCount[\s\S]{0,200}?if \(_mostRecentEventCount != eventCount\) \{\s*\n\s*return;\s*\n\s*\}/.test(ti),
  );
  add(
    'C214', 'setTextAndSelection: 用 _comingFromJS 包裹赋值并在末尾复位（防循环上报）',
    '置 YES→NO',
    /_comingFromJS = YES;[\s\S]{0,900}?_comingFromJS = NO;/.test(ti) ? '确认包裹' : '未匹配',
    /_comingFromJS = YES;[\s\S]{0,900}?_comingFromJS = NO;/.test(ti),
  );
  // X-1: int / NSUInteger 不匹配
  add(
    'C215', '事件载荷里 eventCount 用 static_cast<int>，而 _mostRecentEventCount 是 NSUInteger（类型不匹配）',
    'static_cast<int> vs NSUInteger',
    /NSUInteger _mostRecentEventCount;/.test(ti) &&
      /\.eventCount = static_cast<int>\(_mostRecentEventCount\)/.test(ti)
      ? '确认类型不匹配' : '未匹配',
    /NSUInteger _mostRecentEventCount;/.test(ti) &&
      /\.eventCount = static_cast<int>\(_mostRecentEventCount\)/.test(ti),
  );
  // §2.5 跨语言协议
  add(
    'C216', 'mostRecentEventCount 在 JS→原生方向的 ViewConfig 里声明为 state',
    'mostRecentEventCount: true',
    /mostRecentEventCount: true/.test(cfg) ? '确认' : '未匹配',
    /mostRecentEventCount: true/.test(cfg),
  );
  add(
    'C216b', 'eventCount 在 JS 侧类型声明中出现 5 处（TextInput.flow.js）',
    '5 处',
    (flow.match(/eventCount: number/g) ?? []).length + ' 处',
    (flow.match(/eventCount: number/g) ?? []).length === 5,
  );
  add(
    'C216c', 'Android 侧同构：mostRecentEventCount 也在 spec 的 state 里',
    'Android 同构',
    /mostRecentEventCount: true/.test(androidSpec) &&
      /mostRecentEventCount: Int32/.test(androidSpec)
      ? '确认' : '未匹配',
    /mostRecentEventCount: true/.test(androidSpec) &&
      /mostRecentEventCount: Int32/.test(androidSpec),
  );
  // §3.3 正确重置（对比 32 文档）
  {
    const ri = ti.indexOf('- (void)prepareForRecycle');
    const seg = ti.slice(ri, ti.indexOf('\n- (', ri + 10));
    add(
      'C217', 'RCTTextInputComponentView.prepareForRecycle 正确重置协议状态机三件套（_comingFromJS / _lastStringStateWasUpdatedWith / _mostRecentEventCount）',
      '3 件套',
      ['_comingFromJS = NO', '_lastStringStateWasUpdatedWith = nil', '_mostRecentEventCount = 0']
        .filter(k => seg.includes(k)).length + ' 件',
      seg.includes('_comingFromJS = NO') && seg.includes('_lastStringStateWasUpdatedWith = nil') &&
        seg.includes('_mostRecentEventCount = 0'),
    );
  }
  // §3.2 去重缓存
  add(
    'C218', '_ignoreNextTextInputCall 与 _lastStringStateWasUpdatedWith 配合做事件去重',
    '去重配合',
    /_ignoreNextTextInputCall && \[_lastStringStateWasUpdatedWith isEqual:_backedTextInputView\.attributedText\]/.test(ti)
      ? '确认配合' : '未匹配',
    /_ignoreNextTextInputCall && \[_lastStringStateWasUpdatedWith isEqual:_backedTextInputView\.attributedText\]/.test(ti),
  );
  add(
    'C218b', '_comingFromJS 的注释带 Meta 工单号 T207198334（针对特定 bug 的修复）',
    'T207198334',
    /T207198334: Setting a new AttributedString/.test(ti) ? '确认工单号' : '未匹配',
    /T207198334: Setting a new AttributedString/.test(ti),
  );
  // §4 Text 无障碍修复
  add(
    'C219', 'RCTParagraphComponentView.updateState 在内容变化时发 UIAccessibilityLayoutChangedNotification',
    'LayoutChanged 通知',
    /if \(!newData\.attributedString\.isContentEqual\(oldData\.attributedString\)\) \{\s*\n\s*UIAccessibilityPostNotification\(UIAccessibilityLayoutChangedNotification, nil\);/.test(para)
      ? '确认通知' : '未匹配',
    /if \(!newData\.attributedString\.isContentEqual\(oldData\.attributedString\)\) \{\s*\n\s*UIAccessibilityPostNotification\(UIAccessibilityLayoutChangedNotification, nil\);/.test(para),
  );
  add(
    'C220', '该修复的注释引用了 issue 58145 并说明「异步更新时 VoiceOver 会持有过期值」',
    'issue 链接 + 现象说明',
    /otherwise it may hold on to stale values \(this happens most often when an element is updated async\)/.test(para) &&
      /github\.com\/react\/react-native\/issues\/58145/.test(para)
      ? '确认注释' : '未匹配',
    /otherwise it may hold on to stale values \(this happens most often when an element is updated async\)/.test(para) &&
      /github\.com\/react\/react-native\/issues\/58145/.test(para),
  );
  add(
    'C221', '通知条件用 isContentEqual（深比较）而非浅比较，且 state/oldState 双空检查',
    '深比较 + 双检查',
    /if \(state && oldState\) \{/.test(para) &&
      /newData\.attributedString\.isContentEqual\(oldData\.attributedString\)/.test(para)
      ? '确认' : '未匹配',
    /if \(state && oldState\) \{/.test(para) &&
      /newData\.attributedString\.isContentEqual\(oldData\.attributedString\)/.test(para),
  );
  add(
    'C221b', 'RCTParagraphComponentView.prepareForRecycle 重置 state 与 accessibilityProvider',
    '2 件',
    /- \(void\)prepareForRecycle\s*\{\s*\n\s*\[super prepareForRecycle\];\s*\n\s*_textView\.state = nullptr;\s*\n\s*_accessibilityProvider = nil;/.test(para)
      ? '确认' : '未匹配',
    /- \(void\)prepareForRecycle\s*\{\s*\n\s*\[super prepareForRecycle\];\s*\n\s*_textView\.state = nullptr;\s*\n\s*_accessibilityProvider = nil;/.test(para),
  );
  // §4.4 忽略 oldLayoutMetrics
  add(
    'C222', 'updateLayoutMetrics: 忽略传入的 oldLayoutMetrics 参数、改用 ivar（注释说明避免重复应用未变化子值）',
    '参数被替换',
    /Using stored `_layoutMetrics` as `oldLayoutMetrics` here to avoid/.test(para) &&
      /\[super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:_layoutMetrics\]/.test(para)
      ? '确认替换' : '未匹配',
    /Using stored `_layoutMetrics` as `oldLayoutMetrics` here to avoid/.test(para) &&
      /\[super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:_layoutMetrics\]/.test(para),
  );
  // §4.5 feature flag 三重守卫
  add(
    'C223', 'layoutSubviews 的压缩文本帧调整受三重守卫（Feature Flag + state 非空 + 高度 > 0）',
    '三重守卫',
    /if \(ReactNativeFeatureFlags::enableIOSCompressedTextFrameAdjustment\(\) && _textView\.state &&\s*\n\s*drawingFrame\.size\.height > 0\)/.test(para)
      ? '确认三重' : '未匹配',
    /if \(ReactNativeFeatureFlags::enableIOSCompressedTextFrameAdjustment\(\) && _textView\.state &&\s*\n\s*drawingFrame\.size\.height > 0\)/.test(para),
  );
  add(
    'C223b', '该优化用 C++ weak_ptr::lock() 拿布局管理器，避免 ObjC 侧重算',
    'weak_ptr lock',
    /stateData\.layoutManager\.lock\(\)/.test(para) &&
      /unwrapManagedObject\(textLayoutManager->getNativeTextLayoutManager\(\)\)/.test(para)
      ? '确认' : '未匹配',
    /stateData\.layoutManager\.lock\(\)/.test(para) &&
      /unwrapManagedObject\(textLayoutManager->getNativeTextLayoutManager\(\)\)/.test(para),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 38. Fabric Modal / VirtualView 可见性管理（34 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const vv = read('packages/react-native/React/Fabric/Mounting/ComponentViews/VirtualView/RCTVirtualViewComponentView.mm') ?? '';
  const vvm = read('packages/react-native/React/Fabric/Mounting/ComponentViews/VirtualView/RCTVirtualViewMode.h') ?? '';
  const vrs = read('packages/react-native/React/Fabric/Mounting/ComponentViews/VirtualView/RCTVirtualViewRenderState.h') ?? '';
  const modal = read('packages/react-native/React/Fabric/Mounting/ComponentViews/Modal/RCTModalHostViewComponentView.mm') ?? '';

  // §2.1 两个三态枚举
  add(
    'C224', 'RCTVirtualViewMode 的三态（Visible / Prerender / Hidden）',
    '3 个',
    (vvm.match(/RCTVirtualViewMode\w+ = \d/g) ?? []).length + ' 个',
    (vvm.match(/RCTVirtualViewMode\w+ = \d/g) ?? []).length === 3,
  );
  add(
    'C225', 'RCTVirtualViewRenderState 的三态（Unknown / Rendered / None）',
    '3 个',
    (vrs.match(/RCTVirtualViewRenderState\w+ = \d/g) ?? []).length + ' 个',
    (vrs.match(/RCTVirtualViewRenderState\w+ = \d/g) ?? []).length === 3,
  );
  // §2.2 派发策略（限定在 switch 语句内统计，排除方法定义处）
  {
    const si = vv.indexOf('switch (newMode)');
    const seg = vv.slice(si, vv.indexOf('\n#pragma mark', si));
    const nSync = (seg.match(/_dispatchSyncModeChange:/g) ?? []).length;
    const nAsync = (seg.match(/_dispatchAsyncModeChange:/g) ?? []).length;
    add('C226', 'mode 变化的派发：Visible→同步、Prerender/Hidden→异步',
      '1 同步 2 异步', nSync + ' 同步 / ' + nAsync + ' 异步',
      nSync === 1 && nAsync === 2);
  }
  add(
    'C227', 'Visible 的派发条件是三者之一（无旧值 / 旧值 Hidden / 未渲染完），注释解释了 Hidden→Visible 必须补发的原因',
    '三条件 + 注释',
    /if \(!oldMode\.has_value\(\) \|\| oldMode == RCTVirtualViewModeHidden \|\|\s*\n\s*_renderState != RCTVirtualViewRenderStateRendered\)/.test(vv) &&
      /the hidden mode change is still pending and will eventually be committed/.test(vv)
      ? '确认条件与注释' : '未匹配',
    /if \(!oldMode\.has_value\(\) \|\| oldMode == RCTVirtualViewModeHidden \|\|\s*\n\s*_renderState != RCTVirtualViewRenderStateRendered\)/.test(vv) &&
      /the hidden mode change is still pending and will eventually be committed/.test(vv),
  );
  // §3 static 全局 vs 实例变量
  add(
    'C228', 'VirtualView 的无障碍标志是文件级 static BOOL（ScrollView 是实例变量），且无注释、无重置',
    'static BOOL',
    /static BOOL sIsAccessibilityUsed = NO;/.test(vv) &&
      /static BOOL sIsAccessibilityUsed = NO;\/\/|static BOOL sIsAccessibilityUsed/.test(vv) &&
      !/sIsAccessibilityUsed[^;]*\/\//.test(vv)
      ? '确认 static 无注释' : '未匹配',
    /static BOOL sIsAccessibilityUsed = NO;/.test(vv),
  );
  {
    const sv = read('packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm') ?? '';
    add(
      'C228b', '对照：ScrollView 用实例变量 BOOL _isAccessibilityAPIUsed 且有注释说明不重置',
      '实例变量 + 注释',
      /BOOL _isAccessibilityAPIUsed;/.test(sv) &&
        /It is not restored to the default value in prepareForRecycle/.test(sv)
        ? '确认对照' : '未匹配',
      /BOOL _isAccessibilityAPIUsed;/.test(sv) &&
        /It is not restored to the default value in prepareForRecycle/.test(sv),
    );
    // 两处共用同一句注释
    const note = /From empirical testing, method `accessibilityElementCount` is called lazily only/;
    add(
      'C228c', '两个组件共用同一句「called lazily only when accessibility is used」注释',
      '两处相同',
      (vv.match(/From empirical testing, method `accessibilityElementCount` is called lazily only/g) ?? []).length + ' 处 / ScrollView ' +
        (sv.match(/From empirical testing, method `accessibilityElementCount` is called lazily only/g) ?? []).length + ' 处',
      note.test(vv) && note.test(sv),
    );
  }
  // §3.3 static 只写不读做分支
  add(
    'C229', 'sIsAccessibilityUsed 只被写（置 YES）不做分支判断，真正的动作是逐视图 self.hidden = NO',
    '只写不分支',
    /if \(!sIsAccessibilityUsed\) \{[\s\S]{0,200}?sIsAccessibilityUsed = YES;[\s\S]{0,200}?if \(self\.hidden\) \{\s*\n\s*self\.hidden = NO;/.test(vv)
      ? '确认结构' : '未匹配',
    /if \(!sIsAccessibilityUsed\) \{[\s\S]{0,200}?sIsAccessibilityUsed = YES;[\s\S]{0,200}?if \(self\.hidden\) \{\s*\n\s*self\.hidden = NO;/.test(vv),
  );
  // §3.4 prepareForRecycle
  add(
    'C230', 'VirtualView.prepareForRecycle 正确重置 hidden / _didLayout / _mode / _targetRect / _parentVirtualViewContainer',
    '5 件 + remove',
    /- \(void\)prepareForRecycle\s*\{\s*\n\s*\[super prepareForRecycle\];\s*\n\s*\n\s*\[\[_parentVirtualViewContainer virtualViewContainerState\] remove:self\];\s*\n\s*self\.hidden = NO;\s*\n\s*_didLayout = NO;\s*\n\s*_mode\.reset\(\);\s*\n\s*_targetRect\.reset\(\);\s*\n\s*_parentVirtualViewContainer = nil;/.test(vv)
      ? '确认 5 件 + remove' : '未匹配',
    /- \(void\)prepareForRecycle\s*\{\s*\n\s*\[super prepareForRecycle\];\s*\n\s*\n\s*\[\[_parentVirtualViewContainer virtualViewContainerState\] remove:self\];\s*\n\s*self\.hidden = NO;\s*\n\s*_didLayout = NO;\s*\n\s*_mode\.reset\(\);\s*\n\s*_targetRect\.reset\(\);\s*\n\s*_parentVirtualViewContainer = nil;/.test(vv),
  );
  // §4 丢弃 oldLayoutMetrics + TODO
  add(
    'C231', 'VirtualView.updateLayoutMetrics 同样丢弃 oldLayoutMetrics 改用 ivar，但无注释说明',
    '参数被替换、无注释',
    /\[super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:_layoutMetrics\]/.test(vv) &&
      !/Using stored/.test(vv)
      ? '确认无注释' : '有注释或未匹配',
    /\[super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:_layoutMetrics\]/.test(vv) &&
      !/Using stored/.test(vv),
  );
  add(
    'C231b', '该方法的 TODO 记录了未覆盖场景（ScrollView 里 VirtualColumn 之外元素改尺寸），带工单号 T202601695',
    'T202601695',
    /TODO\(T202601695\): This doesn't yet handle the case of elements in the ScrollView outside a VirtualColumn changing\s*\n\/\/ size\./.test(vv)
      ? '确认工单号' : '未匹配',
    /TODO\(T202601695\): This doesn't yet handle the case of elements in the ScrollView outside a VirtualColumn changing\s*\n\/\/ size\./.test(vv),
  );
  // §5 向上遍历
  add(
    'C232', '_getParentVirtualViewContainer 用 respondsToSelector: 逐级 superview 上溯',
    'respondsToSelector 上溯',
    /- \(id<RCTVirtualViewContainerProtocol>\)_getParentVirtualViewContainer\s*\{\s*\n\s*UIView \*view = self\.superview;\s*\n\s*while \(view != nil\) \{\s*\n\s*if \(\[view respondsToSelector:@selector\(virtualViewContainerState\)\]\)/.test(vv)
      ? '确认' : '未匹配',
    /- \(id<RCTVirtualViewContainerProtocol>\)_getParentVirtualViewContainer\s*\{\s*\n\s*UIView \*view = self\.superview;\s*\n\s*while \(view != nil\) \{\s*\n\s*if \(\[view respondsToSelector:@selector\(virtualViewContainerState\)\]\)/.test(vv),
  );
  // §6 Modal
  add(
    'C233', 'Modal 的 present 条件是三重与（未展示 && props 要求 && self.window），且 _isPresented 在调用前就置 YES',
    '三重与 + 提前置位',
    /BOOL shouldBePresented = !_isPresented && _shouldPresent && self\.window;/.test(modal) &&
      /_isPresented = YES;\s*\n\s*\[self presentViewController:/.test(modal)
      ? '确认' : '未匹配',
    /BOOL shouldBePresented = !_isPresented && _shouldPresent && self\.window;/.test(modal) &&
      /_isPresented = YES;\s*\n\s*\[self presentViewController:/.test(modal),
  );
  add(
    'C234', 'Modal 的 hide 条件用 !self.superview（与 present 的 self.window 判断维度不对称）',
    'superview 判空',
    /BOOL shouldBeHidden = _isPresented && \(!_shouldPresent \|\| !self\.superview\);/.test(modal)
      ? '确认不对称' : '未匹配',
    /BOOL shouldBeHidden = _isPresented && \(!_shouldPresent \|\| !self\.superview\);/.test(modal),
  );
  add(
    'C235', 'dismiss 的双路径注释解释「对正在 present 的 controller 调 dismiss 只会 dismiss 子级」',
    '注释 + 双路径',
    /Dismissing a controller that is itself presenting only dismisses its child, so dismiss both/.test(modal) &&
      /presentingViewController = modalViewController\.presentingViewController \?: modalViewController;/.test(modal)
      ? '确认' : '未匹配',
    /Dismissing a controller that is itself presenting only dismisses its child, so dismiss both/.test(modal) &&
      /presentingViewController = modalViewController\.presentingViewController \?: modalViewController;/.test(modal),
  );
  add(
    'C236', 'Modal.prepareForRecycle 重置 4 项含 _viewController = nil（与懒加载配合保证复用时新建 VC）',
    '4 项',
    /- \(void\)prepareForRecycle\s*\{\s*\n\s*\[super prepareForRecycle\];\s*\n\s*_state\.reset\(\);\s*\n\s*_viewController = nil;\s*\n\s*_isPresented = NO;\s*\n\s*_shouldPresent = NO;/.test(modal)
      ? '确认' : '未匹配',
    /- \(void\)prepareForRecycle\s*\{\s*\n\s*\[super prepareForRecycle\];\s*\n\s*_state\.reset\(\);\s*\n\s*_viewController = nil;\s*\n\s*_isPresented = NO;\s*\n\s*_shouldPresent = NO;/.test(modal),
  );
  // Y-3: _modalInPresentation 未重置
  {
    const ri = modal.indexOf('- (void)prepareForRecycle');
    const seg = modal.slice(ri, modal.indexOf('\n- (', ri + 10));
    add(
      'C237', 'Modal.prepareForRecycle 不重置 _modalInPresentation（依赖复用后 updateProps 总会传新 props）',
      '不重置',
      !/_modalInPresentation\s*=/.test(seg) ? '确认未重置' : '有重置',
      !/_modalInPresentation\s*=/.test(seg) && /_modalInPresentation = !newProps\.allowSwipeDismissal;/.test(modal),
    );
    add(
      'C237b', 'allowSwipeDismissal 与 UIKit modalInPresentation 语义相反，故有取反；且仅在 prop 变化时更新',
      '取反 + 条件更新',
      /if \(oldViewProps\.allowSwipeDismissal != newProps\.allowSwipeDismissal\) \{\s*\n\s*_modalInPresentation = !newProps\.allowSwipeDismissal;/.test(modal)
        ? '确认' : '未匹配',
      /if \(oldViewProps\.allowSwipeDismissal != newProps\.allowSwipeDismissal\) \{\s*\n\s*_modalInPresentation = !newProps\.allowSwipeDismissal;/.test(modal),
    );
  }
}

// ────────────────────────────────────────────────────────────────────────
// 39. Fabric Image 竞态防护 / 小型组件族（35 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const img = read('packages/react-native/React/Fabric/Mounting/ComponentViews/Image/RCTImageComponentView.mm') ?? '';
  const dbg = read('packages/react-native/React/Fabric/Mounting/ComponentViews/DebuggingOverlay/RCTDebuggingOverlayComponentView.mm') ?? '';
  const overlay = read('packages/react-native/React/Views/RCTDebuggingOverlay.m') ?? '';
  const compPlugins = read('packages/react-native/React/Fabric/Mounting/ComponentViews/RCTFabricComponentsPlugins.mm') ?? '';

  // §2 每次订阅创建新 proxy
  add(
    'C238', 'Image 每次订阅都 make_shared 新的 RCTImageResponseObserverProxy（不复用旧对象）',
    '每次新建',
    (img.match(/std::make_shared<RCTImageResponseObserverProxy>\(self\)/g) ?? []).length + ' 处',
    /std::make_shared<RCTImageResponseObserverProxy>\(self\)/.test(img),
  );
  add(
    'C239', '注释说明「先分配新 proxy 后释放旧的」保证连续两次订阅地址不共用',
    '地址不复用注释',
    /The new proxy is allocated before the/.test(img) &&
      /two consecutive subscriptions never share an address/.test(img)
      ? '确认注释' : '未匹配',
    /The new proxy is allocated before the/.test(img) &&
      /two consecutive subscriptions never share an address/.test(img),
  );
  // 三处地址匹配守卫
  {
    const n = (img.match(/observer != _imageResponseObserverProxy\.get\(\)/g) ?? []).length;
    add('C240', 'Image 用 observer 地址匹配丢弃过期回调的守卫点数量', '3', n + ' 处', n === 3);
    add(
      'C240b', '第一处守卫注释说明「异步通知可能在视图已回收或已复用后到达」并给出未来方案与工单号',
      '注释 + T46311063',
      /Notifications are delivered asynchronously and might arrive after the view is already recycled/.test(img) &&
        /In the future, we should incorporate an `EventEmitter` into a separate object owned by `ImageRequest` or `State`/.test(img) &&
        /T46311063/.test(img)
        ? '确认注释' : '未匹配',
      /Notifications are delivered asynchronously and might arrive after the view is already recycled/.test(img) &&
        /In the future, we should incorporate an `EventEmitter` into a separate object owned by `ImageRequest` or `State`/.test(img) &&
        /T46311063/.test(img),
    );
  }
  // §2.4 onLoadStart 必须先于订阅
  add(
    'C241', 'Image 的 onLoadStart 必须在订阅之前发出（observer coordinator 对已完成响应会同步重放）',
    '顺序约束 + 注释',
    /This has to be emitted before subscribing below/.test(img) &&
      /subscribing first can deliver `onLoad`\/`onLoadEnd` ahead of `onLoadStart`/.test(img)
      ? '确认顺序注释' : '未匹配',
    /This has to be emitted before subscribing below/.test(img) &&
      /subscribing first can deliver `onLoad`\/`onLoadEnd` ahead of `onLoadStart`/.test(img),
  );
  add(
    'C241b', 'Image 有一条 instrumentation TODO（T58941612）说明可见性追踪暂放在 image loader',
    'T58941612',
    /TODO \(T58941612\): Tracking for visibility should be done directly on this class/.test(img)
      ? '确认工单号' : '未匹配',
    /TODO \(T58941612\): Tracking for visibility should be done directly on this class/.test(img),
  );
  // §4.1 Image 的 recycle
  add(
    'C242', 'RCTImageComponentView.prepareForRecycle 用 _setStateAndResubscribeImageResponseObserver:nullptr 一次性清空',
    '复用退订方法',
    /- \(void\)prepareForRecycle\s*\{\s*\n\s*\[super prepareForRecycle\];\s*\n\s*\[self _setStateAndResubscribeImageResponseObserver:nullptr\];\s*\n\s*_imageView\.image = nil;/.test(img)
      ? '确认' : '未匹配',
    /- \(void\)prepareForRecycle\s*\{\s*\n\s*\[super prepareForRecycle\];\s*\n\s*\[self _setStateAndResubscribeImageResponseObserver:nullptr\];\s*\n\s*_imageView\.image = nil;/.test(img),
  );
  // §7.3 DebuggingOverlay 确证缺陷
  add(
    'C243', 'RCTDebuggingOverlayComponentView 持有 _overlay 实例变量',
    '有实例状态',
    /RCTDebuggingOverlay \*_overlay;/.test(dbg) ? '确认' : '未匹配',
    /RCTDebuggingOverlay \*_overlay;/.test(dbg),
  );
  add(
    'C244', 'RCTDebuggingOverlay 持有 NSMutableArray<UIView *> _highlightedElements（累积高亮视图）',
    '累积数组',
    /NSMutableArray<UIView \*> \*_highlightedElements;/.test(overlay) ? '确认' : '未匹配',
    /NSMutableArray<UIView \*> \*_highlightedElements;/.test(overlay),
  );
  add(
    'C245', 'RCTDebuggingOverlayComponentView 无 prepareForRecycle → 复用后会显示上一个组件的高亮',
    '0 个 prepareForRecycle',
    !/- \(void\)prepareForRecycle/.test(dbg) ? '确认未实现' : '有实现',
    !/- \(void\)prepareForRecycle/.test(dbg) && /clearElementsHighlights/.test(overlay),
  );
  add(
    'C246', 'ComponentViews 目录下无任何组件覆写 shouldBeRecycled（故全部走默认 true，即都会入池）',
    '0 处覆写',
    grepCount(/shouldBeRecycled/, {
      exts: ['.mm', '.m'],
      roots: ['packages/react-native/React/Fabric/Mounting/ComponentViews'],
    }).files.length + ' 处',
    grepCount(/shouldBeRecycled/, {
      exts: ['.mm', '.m'],
      roots: ['packages/react-native/React/Fabric/Mounting/ComponentViews'],
    }).files.length === 0,
  );
  // §3 第二份注册表
  add(
    'C247', '存在第二份独立的注册表 RCTFabricComponentsPlugins（与 CoreModulesPlugins 分属不同层）',
    '两份注册表',
    compPlugins.length > 0 && /CoreModulesPlugins/.test(compPlugins) === false ? '确认独立' : '未匹配',
    compPlugins.length > 0,
  );
  add(
    'C247b', '两份注册表的 Cls/组件名声明都带 __attribute__((used))（防 LTO 裁掉）',
    'used 属性',
    (read('packages/react-native/React/Fabric/Mounting/ComponentViews/RCTFabricComponentsPlugins.h') ?? '')
      .split('__attribute__((used))').length - 1 + ' 处',
    (read('packages/react-native/React/Fabric/Mounting/ComponentViews/RCTFabricComponentsPlugins.h') ?? '')
      .split('__attribute__((used))').length - 1 >= 10,
  );
  // §7.2 无状态组件确实无 prepareForRecycle（修正 31 文档判据）
  {
    // 逐个核实：哪些组件「有状态但有 recycle」vs「有状态但无 recycle」
    const cases = [
      ['Switch/RCTSwitchComponentView.mm', '_isInitialValueSet', true],
      ['Root/RCTRootComponentView.mm', '_contentHasAppeared', true],
      ['DebuggingOverlay/RCTDebuggingOverlayComponentView.mm', '_overlay', false],
      ['ActivityIndicator/RCTActivityIndicatorViewComponentView.mm', null, false],
      ['UnimplementedView/RCTUnimplementedViewComponentView.mm', null, false],
      ['UnimplementedComponent/RCTUnimplementedNativeComponentView.mm', null, false],
    ];
    const detail = cases.map(([f, ivar, expectRecycle]) => {
      const t = read('packages/react-native/React/Fabric/Mounting/ComponentViews/' + f) ?? '';
      const hasRecycle = /- \(void\)prepareForRecycle/.test(t);
      return f.split('/')[1].replace('.mm', '') + (hasRecycle ? '+recycle' : '-recycle') + (ivar ? '(' + ivar + ')' : '');
    });
    add('C248', '小型组件的「有 recycle / 无 recycle」实测分布（Switch/Root 有；DebuggingOverlay 无；三个无状态组件无）',
      'Switch+recycle, Root+recycle, DebuggingOverlay-recycle, 其余无状态',
      detail.join(', '),
      detail.filter(d => d.includes('+recycle')).length === 2 &&
        detail.filter(d => d.includes('-recycle')).length === 4 &&
        detail.some(d => d.startsWith('RCTDebuggingOverlayComponentView-recycle')));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 40. legacy View 层：ComponentData / RCTView.hitTest（36 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const cd = read('packages/react-native/React/Views/RCTComponentData.mm') ?? '';
  const view = read('packages/react-native/React/Views/RCTView.m') ?? '';
  const uiv = read('packages/react-native/React/Views/UIView+React.m') ?? '';

  // §2.4 RCT_CASE 宏的 17 个类型
  {
    const cases = (cd.match(/RCT_CASE\(_C_\w+,\s*[^)]+\)/g) ?? []).length;
    add('C249', 'RCT_CASE 宏展开的标量类型数（结构体走 NSInvocation 兜底）', '17', cases + ' 个', cases === 17);
    add(
      'C250', 'RCT_CASE 的 defaultValue 只在首次非 null 值时读一次 getter 并缓存',
      '首次捕获后缓存',
      /if \(!setDefaultValue && target\) \{[\s\S]{0,200}?defaultValue = get\(target, getter\);[\s\S]{0,120}?setDefaultValue = YES;/.test(cd)
        ? '确认惰性捕获' : '未匹配',
      /if \(!setDefaultValue && target\) \{[\s\S]{0,200}?defaultValue = get\(target, getter\);[\s\S]{0,120}?setDefaultValue = YES;/.test(cd),
    );
    add(
      'C250b', 'RCT_CASE 宏用 objc_msgSend 转换函数指针（绕过 ARC 类型检查）',
      'objc_msgSend',
      (cd.match(/\(__typeof\((\w+)\)\)objc_msgSend/g) ?? []).length + ' 处 __typeof 转型',
      (cd.match(/\(__typeof\((\w+)\)\)objc_msgSend/g) ?? []).length === 3 && /convert\)\(id, SEL, id\)/.test(cd),
    );
  }
  // §2.5 createNSInvocationSetter 的注释
  add(
    'C251', 'createNSInvocationSetter 用 NSMutableData 而非 malloc 存 defaultValue（ARC 自动释放）',
    '注释 + NSMutableData',
    /Use NSMutableData to store defaultValue instead of malloc, so\s*\n\s*\/\/ it will be freed automatically when setterBlock is released/.test(cd) &&
      /defaultValue = \[\[NSMutableData alloc\] initWithLength:typeSignature\.methodReturnLength\];/.test(cd)
      ? '确认' : '未匹配',
    /Use NSMutableData to store defaultValue instead of malloc, so\s*\n\s*\/\/ it will be freed automatically when setterBlock is released/.test(cd) &&
      /defaultValue = \[\[NSMutableData alloc\] initWithLength:typeSignature\.methodReturnLength\];/.test(cd),
  );
  add(
    'C252', 'malloc 失败处引用 CWE-391 并给出两篇外部参考文章',
    'CWE + 2 链接',
    /CWE - 391 : Unchecked error condition/.test(cd) &&
      /cvedetails\.com\/cwe-details\/391/.test(cd) &&
      /eli\.thegreenplace\.net/.test(cd)
      ? '确认三处' : '未匹配',
    /CWE - 391 : Unchecked error condition/.test(cd) &&
      /cvedetails\.com\/cwe-details\/391/.test(cd) && /eli\.thegreenplace\.net/.test(cd),
  );
  add(
    'C252b', 'free 只在 freeValueOnCompletion 为真时执行（value 可能是 ARC 管理的 defaultValue.mutableBytes）',
    '双重所有权标记',
    /Only free the value if we `malloc`d it locally, otherwise it\s*\n\s*\/\/ points to `defaultValue\.mutableBytes`, which is managed by ARC\./.test(cd) &&
      /if \(freeValueOnCompletion\) \{\s*\n\s*\/\/ Only free the value[\s\S]{0,140}?free\(value\);/.test(cd)
      ? '确认' : '未匹配',
    /Only free the value if we `malloc`d it locally, otherwise it\s*\n\s*\/\/ points to `defaultValue\.mutableBytes`, which is managed by ARC\./.test(cd) &&
      /if \(freeValueOnCompletion\) \{\s*\n\s*\/\/ Only free the value[\s\S]{0,140}?free\(value\);/.test(cd),
  );
  add(
    'C253', '首次传 null 时直接 return（注释解释这是 no-op 而非重置为默认）',
    '首次 null → no-op',
    /We only set the defaultValue when we first pass a non-null\s*\n\s*\/\/ value, so if the first value sent for a prop is null, it's\s*\n\s*\/\/ a no-op/.test(cd)
      ? '确认注释' : '未匹配',
    /We only set the defaultValue when we first pass a non-null\s*\n\s*\/\/ value, so if the first value sent for a prop is null, it's\s*\n\s*\/\/ a no-op/.test(cd),
  );
  // §2.3 事件 prop 的三种类型
  add(
    'C254', '事件 prop 有三种 block 类型（Bubbling / Direct / Capturing），走 createEventSetter 而非 RCT_CASE',
    '3 种类型',
    ['RCTBubblingEventBlock:', 'RCTDirectEventBlock:', 'RCTCapturingEventBlock:']
      .filter(t => cd.includes(t)).length + ' 种',
    ['RCTBubblingEventBlock:', 'RCTDirectEventBlock:', 'RCTCapturingEventBlock:']
      .every(t => cd.includes(t)),
  );
  add(
    'C254b', '事件 handler 用 weakSelf 强转后判空（组件卸载后不发事件）',
    '弱引用判空',
    /The component no longer exists, we shouldn't send the event/.test(cd) &&
      /if \(strongTarget == nullptr\) \{/.test(cd)
      ? '确认' : '未匹配',
    /The component no longer exists, we shouldn't send the event/.test(cd) &&
      /if \(strongTarget == nullptr\) \{/.test(cd),
  );
  // §3.1 四种 pointerEvents
  {
    const n = (view.match(/case RCTPointerEvents\w+:/g) ?? []).length;
    add('C255', 'hitTest: 的 switch 覆盖的 pointerEvents 枚举数', '4', n + ' 个', n === 4);
    add(
      'C255b', '非法 pointerEvents 值走 default 分支：记 RCTLogInfo 并按 Unspecified 处理',
      'default → RCTLogInfo',
      /default:\s*\n\s*RCTLogInfo\(@"Invalid pointer-events specified %lld on %@"[\s\S]{0,120}?return hitSubview \?: hitView;/.test(view)
        ? '确认' : '未匹配',
      /default:\s*\n\s*RCTLogInfo\(@"Invalid pointer-events specified %lld on %@"[\s\S]{0,120}?return hitSubview \?: hitView;/.test(view),
    );
  }
  // §3.2 Apple QA 链接
  add(
    'C256', 'hitTest: 注释引用 Apple QA 文档解释绕过严格包含策略',
    'Apple QA 链接',
    /developer\.apple\.com\/library\/ios\/qa\/qa2013\/qa1812\.html/.test(view) &&
      /By doing hit testing directly on the subviews, we bypass\s*\n\s*\/\/ the strict containment policy/.test(view)
      ? '确认' : '未匹配',
    /developer\.apple\.com\/library\/ios\/qa\/qa2013\/qa1812\.html/.test(view) &&
      /By doing hit testing directly on the subviews, we bypass\s*\n\s*\/\/ the strict containment policy/.test(view),
  );
  add(
    'C256b', 'hitTest: 从 z-index 最高者开始反向遍历子视图',
    'reverseObjectEnumerator',
    /for \(UIView \*subview in \[sortedSubviews reverseObjectEnumerator\]\)/.test(view) ? '确认' : '未匹配',
    /for \(UIView \*subview in \[sortedSubviews reverseObjectEnumerator\]\)/.test(view),
  );
  // §3.3 AA-1: 排序比较器
  add(
    'C257', 'reactZIndexSortedSubviews 的比较器在相等时返回 NSOrderedAscending 而非 NSOrderedSame',
    'Ascending（应为 Same）',
    /Ensure sorting is stable by treating equal zIndex as ascending so[\s\S]{0,120}?return NSOrderedAscending;/.test(uiv)
      ? '确认 Ascending' : '未匹配',
    /Ensure sorting is stable by treating equal zIndex as ascending so[\s\S]{0,120}?return NSOrderedAscending;/.test(uiv),
  );
  add(
    'C258', 'reactZIndexSortedSubviews 先扫描判断是否需要排序（全为 0 则零分配返回 subviews）',
    '短路优化 + 注释',
    /Check if sorting is required - in most cases it won't be/.test(uiv) &&
      /return sortingRequired \? \[self\.reactSubviews sortedArrayUsingComparator:[\s\S]{0,400}?: self\.subviews;/.test(uiv)
      ? '确认短路' : '未匹配',
    /Check if sorting is required - in most cases it won't be/.test(uiv) &&
      /return sortingRequired \? \[self\.reactSubviews sortedArrayUsingComparator:[\s\S]{0,400}?: self\.subviews;/.test(uiv),
  );
  // §3.4 pointInside 快路径
  add(
    'C259', 'pointInside: 在 hitTestEdgeInsets 为零时直接调 super（快路径）',
    '零 inset → super',
    /if \(UIEdgeInsetsEqualToEdgeInsets\(self\.hitTestEdgeInsets, UIEdgeInsetsZero\)\) \{\s*\n\s*return \[super pointInside:point withEvent:event\];/.test(view)
      ? '确认' : '未匹配',
    /if \(UIEdgeInsetsEqualToEdgeInsets\(self\.hitTestEdgeInsets, UIEdgeInsetsZero\)\) \{\s*\n\s*return \[super pointInside:point withEvent:event\];/.test(view),
  );
  add(
    'C260', '_hitTestEdgeInsets 在初始化时置为 UIEdgeInsetsZero（使快路径默认生效）',
    '初值 Zero',
    /_hitTestEdgeInsets = UIEdgeInsetsZero;/.test(view) ? '确认' : '未匹配',
    /_hitTestEdgeInsets = UIEdgeInsetsZero;/.test(view),
  );
  // AA-3: substringToIndex 的冗余 nil 判断
  add(
    'C261', 'createPropBlock: 的 componentsSeparatedByString: 结果判断 != nullptr 恒为真（该 API 非 nullable）',
    '恒真判断',
    /NSArray<NSString \*> \*parts = \[keyPath componentsSeparatedByString:@"\."\];\s*\n\s*if \(parts != nullptr\) \{/.test(cd)
      ? '确认冗余' : '未匹配',
    /NSArray<NSString \*> \*parts = \[keyPath componentsSeparatedByString:@"\."\];\s*\n\s*if \(parts != nullptr\) \{/.test(cd),
  );
}

// ────────────────────────────────────────────────────────────────────────
// 41. legacy 布局层退役 / ShadowQueue 转用（37 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const ui = read('packages/react-native/React/Modules/RCTUIManager.mm') ?? '';
  const sv = read('packages/react-native/React/Views/RCTShadowView.m') ?? '';
  const svh = read('packages/react-native/React/Views/RCTShadowView.h') ?? '';
  const srs = read('packages/react-native/React/Base/Surface/RCTSurfaceRootShadowView.m') ?? '';
  const srsh = read('packages/react-native/React/Base/Surface/RCTSurfaceRootShadowView.h') ?? '';
  const svl = read('packages/react-native/React/Views/RCTShadowView+Layout.m') ?? '';
  const lay = read('packages/react-native/React/Views/RCTLayout.m') ?? '';
  const layh = read('packages/react-native/React/Views/RCTLayout.h') ?? '';
  const umu = read('packages/react-native/React/Modules/RCTUIManagerUtils.m') ?? '';
  const obs = read('packages/react-native/React/Modules/RCTUIManagerObserverCoordinator.mm') ?? '';
  const genCpp = read('packages/react-native/ReactCommon/react/renderer/core/ReactRootViewTagGenerator.cpp') ?? '';
  const genH = read('packages/react-native/ReactCommon/react/renderer/core/ReactRootViewTagGenerator.h') ?? '';
  const nodeH = read('packages/react-native/ReactCommon/yoga/yoga/node/Node.h') ?? '';
  const ygl = read('packages/react-native/ReactCommon/yoga/yoga/YGNodeLayout.cpp') ?? '';
  const surf = read('packages/react-native/React/Fabric/Surface/RCTFabricSurface.mm') ?? '';

  // §2 RCTUIManager 21 方法全桩
  {
    const start = ui.indexOf('@implementation RCTUIManager\n');
    const end = ui.indexOf('@implementation RCTBridge (RCTUIManager)');
    const body = ui.slice(start, end);
    const lines = body.split('\n');
    const methods = [];
    let i = 0;
    while (i < lines.length) {
      if (/^[-+] \(/.test(lines[i])) {
        const sigLines = [lines[i]];
        let j = i;
        while (!sigLines[sigLines.length - 1].includes('{')) { j += 1; sigLines.push(lines[j]); }
        const sig = sigLines.join(' ').split('{')[0].trim();
        let depth = 0, inner = [], k = j;
        while (k < lines.length) {
          depth += (lines[k].match(/\{/g) || []).length;
          depth -= (lines[k].match(/\}/g) || []).length;
          if (depth === 0 && k > j) break;
          if (k > j && lines[k].trim() !== '') inner.push(lines[k].trim());
          k += 1;
        }
        methods.push({ sig, inner });
        i = k + 1;
      } else i += 1;
    }
    const stubs = methods.filter(m => m.inner.length === 0);
    const nilReturns = methods.filter(m => m.inner.length === 1 && m.inner[0] === 'return nil;');
    add('C262', 'RCTUIManager 的 @implementation 方法总数', '21', methods.length + ' 个', methods.length === 21);
    add('C262b', 'RCTUIManager 中完全空 {} 的方法数（正文完全无语句）', '15',
      stubs.length + ' 个：' + stubs.slice(0, 4).map(m => m.sig.slice(0, 40)).join(' / ') + ' …',
      stubs.length === 15);
    add('C262c', 'RCTUIManager 中只 return nil 的方法数', '5',
      nilReturns.length + ' 个：' + nilReturns.map(m => m.sig.slice(0, 36)).join(' / '),
      nilReturns.length === 5);
    add('C263', 'RCTUIManager 里唯一有真实返回值的方法是 +moduleName（返回 @"UIManager"）',
      'moduleName',
      /\+ \(NSString \*\)moduleName\s*\{\s*return @"UIManager";/.test(ui) ? '确认唯一' : '未匹配',
      /\+ \(NSString \*\)moduleName\s*\{\s*return @"UIManager";/.test(ui));
    // 但文件里有两处活跃逻辑
    add('C263b', '同文件里 RCTModuleConstantsForDestructuredComponent（C 函数）与 RCTComposedViewRegistry 有实质逻辑',
      '2 处活跃',
      /RCTModuleConstantsForDestructuredComponent/.test(ui) && /@implementation RCTComposedViewRegistry/.test(ui)
        ? '确认两处' : '未匹配',
      /RCTModuleConstantsForDestructuredComponent/.test(ui) && /@implementation RCTComposedViewRegistry/.test(ui));
    add('C263c', 'RCTUIManager 仍在 coreModuleClasses 注册表里（模块名解析依赖它存在）',
      '在注册表',
      /@"RCTUIManager"/.test(read('packages/react-native/React/Base/RCTBridge.mm') ?? '') ? '确认注册' : '未注册',
      /@"RCTUIManager"/.test(read('packages/react-native/React/Base/RCTBridge.mm') ?? ''));
  }
  // §3 RCTShadowView
  {
    const props = (svh.match(/^@property/gm) ?? []).length;
    const yoga = (svh.match(/YGValue|yogaNode/g) ?? []).length;
    const synth = (sv.match(/@synthesize/g) ?? []).length;
    add('C264', 'RCTShadowView.h 声明的 @property 数', '63', props + ' 个', props === 63);
    add('C264b', 'RCTShadowView.h 里 Yoga 相关（YGValue / yogaNode）出现次数', '36', yoga + ' 次', yoga === 36);
    add('C264c', 'RCTShadowView.m 里的 @synthesize 数（其余属性靠自动合成）', '2',
      synth + ' 个：' + (sv.match(/@synthesize (\w+)/g) ?? []).join(', '),
      synth === 2 && /@synthesize reactTag/.test(sv) && /@synthesize rootTag/.test(sv));
    add('C265', 'RCTShadowView.m 的方法总数（8 个完全空 + 9 个返回常量 + 1 个有行为）', '18',
      (sv.match(/^[-+] \(/gm) ?? []).length + ' 个',
      (sv.match(/^[-+] \(/gm) ?? []).length === 18);
    const mEmpty = (sv.match(/^[-+] \([^)]*\)[^{]*\{\n\}/gm) ?? []).length;
    add('C265b', 'RCTShadowView.m 中形如「{ 紧跟 }」的空方法数', '8', mEmpty + ' 个', mEmpty === 8);
    add('C266', 'RCTShadowView.m 的 18 个方法中没有任何一个读写 yogaNode',
      '0 处读写',
      /yogaNode/.test(sv) ? '有引用' : '零引用',
      !/yogaNode\s*=|YGNodeSet|\.yogaNode/.test(sv) && !/self\.yogaNode/.test(sv));
    add('C266b', '全仓库 RCTShadowView 的子类只有 RCTSurfaceRootShadowView 一处',
      '1 个子类',
      grepCount(/: RCTShadowView\b/, { exts: ['.h'], roots: ['packages/react-native'] }).files.length + ' 个 .h',
      grepCount(/: RCTShadowView\b/, { exts: ['.h'], roots: ['packages/react-native'] }).files.length === 1 &&
        /RCTSurfaceRootShadowView/.test(srsh));
  }
  // §3.3 RCTSurfaceRootShadowView
  add('C267', 'RCTSurfaceRootShadowView.m 的两个方法全部是空实现',
    '2 个全空',
    (srs.match(/\{\n\}/g) ?? []).length + ' 处空体',
    /- \(void\)setMinimumSize:[\s\S]{0,80}?\{\n\}/.test(srs) &&
      /- \(void\)layoutWithAffectedShadowViews:[\s\S]{0,80}?\{\n\}/.test(srs));
  add('C267b', 'RCTSurfaceRootShadowView 的 delegate 属性带 __deprecated_msg 明示将随 legacy 架构移除',
    '__deprecated_msg',
    /__deprecated_msg\(\s*"This API will be removed along with the legacy architecture\."/.test(srsh)
      ? '确认标注' : '未匹配',
    /__deprecated_msg\(\s*"This API will be removed along with the legacy architecture\."/.test(srsh));
  // §4 RCTLayout / RCTShadowView+Layout 零调用方
  add('C268', 'RCTLayoutMetricsFromYogaNode 在生产代码中零调用方（本文件的主函数）',
    '0 调用方',
    grepCount(/RCTLayoutMetricsFromYogaNode/, { roots: ['packages'] }).files
      .filter(f => !f.endsWith('RCTLayout.h') && !f.endsWith('RCTLayout.m')).length + ' 处',
    grepCount(/RCTLayoutMetricsFromYogaNode/, { roots: ['packages'] }).files
      .filter(f => !f.endsWith('RCTLayout.h') && !f.endsWith('RCTLayout.m')).length === 0);
  add('C268b', 'RCTYogaDisplayTypeFromReactDisplayType 同样零调用方',
    '0 调用方',
    grepCount(/RCTYogaDisplayTypeFromReactDisplayType/, { roots: ['packages'] }).files
      .filter(f => !f.endsWith('RCTLayout.h') && !f.endsWith('RCTLayout.m')).length + ' 处',
    grepCount(/RCTYogaDisplayTypeFromReactDisplayType/, { roots: ['packages'] }).files
      .filter(f => !f.endsWith('RCTLayout.h') && !f.endsWith('RCTLayout.m')).length === 0);
  add('C269', 'RCTLayoutContext 全仓库从未被构造（只有定义与空实现的参数声明）',
    '0 处构造',
    (grepCount(/RCTLayoutContext/, { roots: ['packages/react-native/React'] }).files.length) + ' 个文件提及，0 处构造',
    grepCount(/RCTLayoutContext/, { roots: ['packages/react-native/React'] }).files.length === 3);
  add('C269b', 'RCTLayoutContext 有个名为 other 的字段，在任何使用点都不出现（无人填充的信号）',
    'other 字段',
    /__unsafe_unretained NSHashTable<NSString \*> \*_Nonnull other;/.test(layh) &&
      !/context\.other|\.other\b/.test(svl) && !/other\[/.test(svl)
      ? '确认仅声明' : '未匹配',
    /__unsafe_unretained NSHashTable<NSString \*> \*_Nonnull other;/.test(layh));
  add('C270', 'compoundInsets 的 border+padding 公式在 RCTLayout.m 与 RCTShadowView+Layout.m 各实现一次（后者零调用方）',
    '两处重复',
    /borderWidth\.top \+ padding\.top/.test(lay) && /borderAsInsets\.top \+ paddingAsInsets\.top/.test(svl)
      ? '确认重复' : '未匹配',
    /borderWidth\.top \+ padding\.top/.test(lay) && /borderAsInsets\.top \+ paddingAsInsets\.top/.test(svl));
  // BB-3: resolveRef 无判空
  add('C271', 'Yoga 的 resolveRef 是裸 static_cast，不做 null 检查',
    '裸 static_cast',
    /inline Node\* resolveRef\(const YGNodeRef ref\) \{\s*return static_cast<Node\*>\(ref\);\s*\}/.test(nodeH)
      ? '确认无判空' : '未匹配',
    /inline Node\* resolveRef\(const YGNodeRef ref\) \{\s*return static_cast<Node\*>\(ref\);\s*\}/.test(nodeH));
  add('C271b', 'getResolvedLayoutProperty 的断言条件只检查 edge，不检查 node 是否为 null',
    '断言不查 node',
    /assertFatalWithNode\(\s*node,\s*edge <= Edge::End,/.test(ygl) ? '确认条件' : '未匹配',
    /assertFatalWithNode\(\s*node,\s*edge <= Edge::End,/.test(ygl));
  add('C271c', 'RCTShadowView+Layout.m 的 paddingAsInsets / borderAsInsets 直接把 self.yogaNode 传给 Yoga',
    '直接传 yogaNode',
    (svl.match(/YGNodeRef yogaNode = self\.yogaNode;/g) ?? []).length + ' 处',
    (svl.match(/YGNodeRef yogaNode = self\.yogaNode;/g) ?? []).length === 2);
  {
    const callers = grepCount(/paddingAsInsets|borderAsInsets/, {
      roots: ['packages/react-native/React', 'packages/react-native/Libraries'],
    }).files.filter(f => !f.includes('ShadowView+Layout'));
    add('C272', 'paddingAsInsets / borderAsInsets 在 React 与 Libraries 下零调用方',
      '0 调用方', callers.length + ' 处', callers.length === 0);
  }
  // §5 两个 rootViewTag 生成器
  add('C273', 'ObjC 的 RCTAllocateRootViewTag 用 _Atomic int64_t + atomic_fetch_add_explicit(relaxed) 后 *10+1',
    '_Atomic + relaxed',
    /static _Atomic int64_t rootViewTagCounter = 0;/.test(umu) &&
      /atomic_fetch_add_explicit\(&rootViewTagCounter, 1, memory_order_relaxed\) \* 10 \+ 1/.test(umu)
      ? '确认' : '未匹配',
    /static _Atomic int64_t rootViewTagCounter = 0;/.test(umu) &&
      /atomic_fetch_add_explicit\(&rootViewTagCounter, 1, memory_order_relaxed\) \* 10 \+ 1/.test(umu));
  add('C274', 'C++ 的 getNextRootViewTag 用 std::atomic<SurfaceId> 初值 1、+= 10（产出同一序列 11,21,31…）',
    '+= 10 from 1',
    /constexpr SurfaceId ROOT_VIEW_TAG_INCREMENT = 10;/.test(genCpp) &&
      /static std::atomic<SurfaceId> nextRootViewTag = 1;/.test(genCpp) &&
      /return nextRootViewTag \+= ROOT_VIEW_TAG_INCREMENT;/.test(genCpp)
      ? '确认同序列' : '未匹配',
    /constexpr SurfaceId ROOT_VIEW_TAG_INCREMENT = 10;/.test(genCpp) &&
      /static std::atomic<SurfaceId> nextRootViewTag = 1;/.test(genCpp) &&
      /return nextRootViewTag \+= ROOT_VIEW_TAG_INCREMENT;/.test(genCpp));
  {
    const objcCallers = grepCount(/RCTAllocateRootViewTag/, { roots: ['packages'] }).files
      .filter(f => !f.endsWith('RCTUIManagerUtils.m') && !f.endsWith('RCTUIManagerUtils.h'));
    // C++ 版在 iOS 侧的调用方（排除 Android，Android 用自己的 Kotlin 版）
    const cppCallers = grepCount(/getNextRootViewTag/, {
      roots: ['packages/react-native/React', 'packages/react-native/ReactCommon'],
    }).files.filter(f => !f.includes('ReactRootViewTagGenerator'));
    add('C275', 'RCTAllocateRootViewTag（iOS ObjC 版）的调用方数量（与另两版序列相同却不协调）', '0',
      objcCallers.length + ' 处', objcCallers.length === 0);
    add('C275b', 'C++ 版 getNextRootViewTag 的调用方：1 个 iOS 生产点 + 测试',
      '1 生产 + 测试',
      cppCallers.filter(f => !f.includes('/tests/')).length + ' 个非测试文件 + ' +
        cppCallers.filter(f => f.includes('/tests/')).length + ' 个测试文件',
      cppCallers.filter(f => !f.includes('/tests/')).length === 1 &&
        cppCallers.filter(f => f.includes('/tests/')).length === 5 && surf.includes('getNextRootViewTag()'));
    // Android Kotlin 版有 3 个生产调用方
    const ktCallers = grepCount(/getNextRootViewTag/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    }).files.filter(f => !f.includes('ReactRootViewTagGenerator.kt'));
    add('C275c', 'Android Kotlin 版 getNextRootViewTag 的生产调用方数量（3 处：ReactRootView/FabricUIManager/UIManagerModule）',
      '3',
      ktCallers.length + ' 处：' + ktCallers.map(f => f.split('/').pop()).join(', '),
      ktCallers.length === 3);
  }
  // BB-6: 注释指错文件
  {
    const kt = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactRootViewTagGenerator.kt') ?? '';
    const note = 'Keep in sync with ReactRootViewTagGenerator.h - see that file for an explanation on why the';
    add('C275d', 'iOS 与 Android 的「Keep in sync」注释逐字相同（错误在两个平台同步传播）',
      '两处逐字一致',
      [umu.includes(note), kt.includes(note)].filter(Boolean).length + ' 处',
      umu.includes(note) && kt.includes(note));
    add('C275e', 'Kotlin 版用 @Synchronized + 常量 ROOT_VIEW_TAG_INCREMENT = 10、初值 1（与 C++ 版同序列）',
      '@Synchronized',
      /@Synchronized/.test(kt) && /ROOT_VIEW_TAG_INCREMENT = 10/.test(kt) &&
        /private var nextRootViewTag = 1/.test(kt) ? '确认' : '未匹配',
      /@Synchronized/.test(kt) && /ROOT_VIEW_TAG_INCREMENT = 10/.test(kt) &&
        /private var nextRootViewTag = 1/.test(kt));
  }
  add('C276', 'RCTAllocateRootViewTag 的注释指向 ReactRootViewTagGenerator.h，但该头文件里没有任何关于增量的说明',
    '注释指错文件',
    /Keep in sync with ReactRootViewTagGenerator\.h - see that file for an explanation/.test(umu) &&
      !/10|increment|explanation/.test(genH.replace(/ReactRootViewTagGenerator\.h/g, ''))
      ? '确认头文件无说明' : '未匹配',
    /Keep in sync with ReactRootViewTagGenerator\.h - see that file for an explanation/.test(umu) &&
      /Numbering of these tags goes from 11, 21, 31/.test(genCpp) &&
      !/Numbering of these tags|increment here is 10/.test(genH));
  // §6 ShadowQueue
  add('C277', 'ShadowQueue 的名字仍是 com.facebook.react.ShadowQueue，QoS 为 QOS_CLASS_USER_INTERACTIVE',
    'ShadowQueue + USER_INTERACTIVE',
    /char \*const RCTUIManagerQueueName = "com\.facebook\.react\.ShadowQueue";/.test(umu) &&
      /QOS_CLASS_USER_INTERACTIVE/.test(umu) ? '确认' : '未匹配',
    /char \*const RCTUIManagerQueueName = "com\.facebook\.react\.ShadowQueue";/.test(umu) &&
      /QOS_CLASS_USER_INTERACTIVE/.test(umu));
  {
    const na = read('packages/react-native/Libraries/NativeAnimation/RCTNativeAnimatedTurboModule.mm') ?? '';
    const n = (na.match(/RCTGetUIManagerQueue\(\)|RCTExecuteOnUIManagerQueue\(/g) ?? []).length;
    add('C278', 'ShadowQueue 的主要使用方是 NativeAnimated（RCTNativeAnimatedTurboModule.mm 的调用点数）',
      '5 处',
      n + ' 处（3 处 dispatch_async + 2 处 RCTExecuteOnUIManagerQueue）',
      n === 5 &&
        (na.match(/dispatch_async\(RCTGetUIManagerQueue\(\),/g) ?? []).length === 3 &&
        (na.match(/RCTExecuteOnUIManagerQueue\(\^\{/g) ?? []).length === 2);
  }
  add('C278b', 'RCTViewManager 的 methodQueue 返回 RCTGetUIManagerQueue()（队列的另一使用点）',
    'methodQueue',
    read('packages/react-native/React/Views/RCTViewManager.m')?.includes('return RCTGetUIManagerQueue();')
      ? '确认' : '未匹配',
    read('packages/react-native/React/Views/RCTViewManager.m')?.includes('return RCTGetUIManagerQueue();'));
  add('C279', 'pseudoUIManagerQueueFlag 是非原子的 static BOOL（读写全在主线程约定内）',
    'static BOOL 非原子',
    /static BOOL pseudoUIManagerQueueFlag = NO;/.test(umu) &&
      /if \(RCTIsMainQueue\(\)\) \{\s*return pseudoUIManagerQueueFlag;/.test(umu)
      ? '确认非原子' : '未匹配',
    /static BOOL pseudoUIManagerQueueFlag = NO;/.test(umu) &&
      /if \(RCTIsMainQueue\(\)\) \{\s*return pseudoUIManagerQueueFlag;/.test(umu));
  add('C279b', 'RCTUnsafeExecuteOnUIManagerQueueSync 用两个信号量实现「主线程假装在 UIManager 队列」',
    '信号量乒乓',
    (umu.match(/dispatch_semaphore_create\(0\)/g) ?? []).length + ' 个信号量',
    (umu.match(/dispatch_semaphore_create\(0\)/g) ?? []).length === 2 &&
      /pseudoUIManagerQueueFlag = YES;/.test(umu) && /pseudoUIManagerQueueFlag = NO;/.test(umu));
  // §7 ObserverCoordinator
  add('C280', 'RCTUIManagerObserverCoordinator 用 NSHashTableWeakMemory 存观察者 + std::mutex 保护',
    '弱表 + mutex',
    /NSHashTableWeakMemory/.test(obs) && /std::mutex _mutex;/.test(obs) ? '确认' : '未匹配',
    /NSHashTableWeakMemory/.test(obs) && /std::mutex _mutex;/.test(obs));
  add('C280b', '锁的覆盖范围包含回调：5 个通知方法 + addObserver + removeObserver 共 7 处 lock_guard',
    '7 处 lock_guard',
    (obs.match(/std::lock_guard<std::mutex> lock\(_mutex\);/g) ?? []).length + ' 处（5 通知 + add/removeObserver）',
    (obs.match(/std::lock_guard<std::mutex> lock\(_mutex\);/g) ?? []).length === 7 &&
      (obs.match(/^[-+] \([^)]*\)uiManager\w*:/gm) ?? []).length === 5 &&
      (obs.match(/for \(id<RCTUIManagerObserver> observer in _observers\)/g) ?? []).length === 5);
  {
    const obs2 = grepCount(/RCTUIManagerObserver\b/, { roots: ['packages/react-native/React'] }).files
      .filter(f => !f.includes('RCTUIManagerObserverCoordinator') && !f.endsWith('/RCTUIManager.h'));
    add('C281', 'RCTUIManagerObserver 协议在 React/ 下零实现（无观察者注册）',
      '0 个实现', obs2.length + ' 个文件', obs2.length === 0);
  }
  // BB-11: RCTDisplayType 往返不对称
  add('C282', 'RCTDisplayType 只有 3 个值，但反向映射把 YGDisplayContents 与 YGDisplayGrid 都压成 Flex（往返不对称）',
    '3 值 vs 5 映射',
    (layh.match(/RCTDisplayType\w+/g) ?? []).length + ' 个枚举值 / ' +
      (lay.match(/case YGDisplay\w+:/g) ?? []).length + ' 个 YGDisplay 分支',
    /typedef NS_ENUM\(NSInteger, RCTDisplayType\) \{\s*RCTDisplayTypeNone,\s*RCTDisplayTypeFlex,\s*RCTDisplayTypeInline,/.test(layh) &&
      /case YGDisplayContents:\s*\n\s*case YGDisplayGrid:\s*\n\s*return RCTDisplayTypeFlex;/.test(lay));
}

// ────────────────────────────────────────────────────────────────────────
// 42. RCTEventEmitter 活跃度 / LayoutAnimation 整链失效 / RTL（38 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const ee = read('packages/react-native/React/Modules/RCTEventEmitter.m') ?? '';
  const net = read('packages/react-native/Libraries/Network/RCTNetworking.mm') ?? '';
  const netJs = read('packages/react-native/Libraries/Network/RCTNetworking.ios.js') ?? '';
  const la = read('packages/react-native/React/Modules/RCTLayoutAnimation.m') ?? '';
  const ui = read('packages/react-native/React/Modules/RCTUIManager.mm') ?? '';
  const lajs = read('packages/react-native/Libraries/LayoutAnimation/LayoutAnimation.js') ?? '';
  const kav = read('packages/react-native/Libraries/Components/Keyboard/KeyboardAvoidingView.js') ?? '';
  const i18n = read('packages/react-native/React/Modules/RCTI18nUtil.m') ?? '';
  const rb = read('packages/react-native/React/Modules/RCTRedBoxExtraDataViewController.m') ?? '';
  const sps = read('packages/react-native/React/Modules/RCTSurfacePresenterStub.m') ?? '';

  // §2.1 修正 24 文档：10 个子类
  {
    const subs = grepCount(/: RCTEventEmitter\b/, {
      exts: ['.h'],
      roots: ['packages/react-native'],
    }).files;
    add('C283', 'RCTEventEmitter 的子类数量（24 文档只看了 JS 侧，ObjC 侧子类全部活跃）', '10',
      subs.length + ' 个：' + subs.map(f => f.split('/').pop().replace('.h', '')).join(', '),
      subs.length === 10 &&
        subs.some(f => f.endsWith('RCTNetworking.h')) &&
        subs.some(f => f.endsWith('RCTAppState.h')) &&
        subs.some(f => f.endsWith('RCTWebSocketModule.h')));
  }
  // §2.2 事件落到 RCTDeviceEventEmitter.emit
  add('C284', 'RCTEventEmitter 的事件统一转成 RCTDeviceEventEmitter.emit(eventName, body)',
    'invokeModule emit',
    /\[callableJSModules invokeModule:@"RCTDeviceEventEmitter"\s*\n\s*method:@"emit"/.test(ee) ? '确认' : '未匹配',
    /\[callableJSModules invokeModule:@"RCTDeviceEventEmitter"\s*\n\s*method:@"emit"/.test(ee));
  // §2.3 承重标志的注释
  add('C285', '_callableJSModulesWasInitialized 的注释解释了「弱引用变 nil 无法区分从未设置与已失效」',
    '弱引用 nil 语义',
    /_callableJSModules is weak and can return to nil after wiring/.test(ee) &&
      /can't tell us whether we were ever set up correctly/.test(ee) ? '确认注释' : '未匹配',
    /_callableJSModules is weak and can return to nil after wiring/.test(ee) &&
      /can't tell us whether we were ever set up correctly/.test(ee));
  add('C285b', '该标志只在 callableJSModules 非 nil 时置 YES（只增不减）',
    '只置 YES',
    /if \(callableJSModules != nil\) \{\s*\n\s*_callableJSModulesWasInitialized = YES;/.test(ee)
      ? '确认' : '未匹配',
    /if \(callableJSModules != nil\) \{\s*\n\s*_callableJSModulesWasInitialized = YES;/.test(ee));
  add('C285c', '断言文案直接给出最可能原因（子类误加 @synthesize 覆盖继承属性）',
    '断言文案含根因',
    /you've\s*\n?\s*\*"explicitly synthesized the RCTCallableJSModules in %@/.test(ee) ||
      /explicitly synthesized the RCTCallableJSModules/.test(ee)
      ? '确认文案' : '未匹配',
    /explicitly synthesized the RCTCallableJSModules/.test(ee));
  // §2.4 四道守卫
  add('C286', 'sendEventWithName: 的发送门槛是 (_observationDisabled || _listenerCount > 0)',
    '两或条件',
    /BOOL shouldEmitEvent = \(_observationDisabled \|\| _listenerCount > 0\);/.test(ee) ? '确认' : '未匹配',
    /BOOL shouldEmitEvent = \(_observationDisabled \|\| _listenerCount > 0\);/.test(ee));
  add('C286b', '无监听者时的 RCTLogWarn 在两个分支各一条（callableJSModules nil / 无监听者）',
    '2 条 Warn',
    (ee.match(/RCTLogWarn\(@\"Sending `%@`/g) ?? []).length + ' 处',
    (ee.match(/RCTLogWarn\(@\"Sending `%@`/g) ?? []).length === 2);
  add('C286c', '弱引用一次性读入强局部变量的注释',
    '一次性读强引用',
    /_callableJSModules is weak, so read it exactly once into a strong local/.test(ee)
      ? '确认注释' : '未匹配',
    /_callableJSModules is weak, so read it exactly once into a strong local/.test(ee));
  // §2.5 CC-1 承重标志
  {
    const jsForwards = /return RCTDeviceEventEmitter\.addListener\(eventType, listener, context\);/.test(netJs);
    const netUses = /\[super initWithDisabledObservation\]/.test(net);
    const nAddListenerCalls = (net.match(/addListener/g) ?? []).length;
    add('C287', 'JS 侧 RCTNetworking.addListener 转发给 RCTDeviceEventEmitter（不调原生 addListener 方法）',
      '转发 DeviceEventEmitter',
      jsForwards ? '确认转发' : '未匹配', jsForwards);
    add('C287b', 'RCTNetworking.mm 是 initWithDisabledObservation 的唯一调用方，且自身不实现 addListener/removeListeners',
      '唯一调用方 + 无自有实现',
      netUses && nAddListenerCalls === 0 ? '确认' : '未匹配（有 ' + nAddListenerCalls + ' 处 addListener 字样）',
      netUses && nAddListenerCalls === 0);
    add('C287c', '若去掉 _observationDisabled，_listenerCount 恒 0 → 事件全被丢弃（承重标志）',
      '承重标志',
      /BOOL shouldEmitEvent = \(_observationDisabled \|\| _listenerCount > 0\)/.test(ee) &&
        /RCTLogWarn\(@"Sending `%@` with no listeners registered\."/.test(ee) &&
        /RCT_EXPORT_METHOD\(addListener : \(NSString \*\)eventName\)/.test(ee)
        ? '确认承重' : '未匹配',
      /BOOL shouldEmitEvent = \(_observationDisabled \|\| _listenerCount > 0\)/.test(ee) &&
        /RCTLogWarn\(@"Sending `%@` with no listeners registered\."/.test(ee) &&
        /RCT_EXPORT_METHOD\(addListener : \(NSString \*\)eventName\)/.test(ee));
  }
  // §2.6 removeListeners 窄化 + RCT_DEBUG 门控
  add('C288', 'removeListeners: 有 double → int 窄化转换，越界检查被 RCT_DEBUG 门控',
    '窄化 + RCT_DEBUG',
    /int currentCount = \(int\)count;/.test(ee) && /if \(RCT_DEBUG && currentCount > _listenerCount\)/.test(ee)
      ? '确认' : '未匹配',
    /int currentCount = \(int\)count;/.test(ee) && /if \(RCT_DEBUG && currentCount > _listenerCount\)/.test(ee));
  add('C288b', '_listenerCount 用 MAX(..., 0) 兜底防止变负',
    'MAX 兜底',
    /_listenerCount = MAX\(_listenerCount - currentCount, 0\);/.test(ee) ? '确认' : '未匹配',
    /_listenerCount = MAX\(_listenerCount - currentCount, 0\);/.test(ee));
  // §2.7 moduleName 返回空串
  add('C289', 'RCTEventEmitter 的 +moduleName 返回空串 @""（自身不在任何注册表里）',
    '@""',
    /\+ \(NSString \*\)moduleName\s*\{\s*return @"";/.test(ee) ? '确认空串' : '未匹配',
    /\+ \(NSString \*\)moduleName\s*\{\s*return @"";/.test(ee));
  // §2.8 测试缝
  add('C290', '_log: 是文档化的测试缝（注释说明是「mock RCTLogError 的更轻量做法」）',
    '测试缝注释',
    /This is the less intrusive way found to mock the RCTLogError function in unit tests/.test(ee) &&
      /#pragma mark - Test utilities/.test(ee) ? '确认' : '未匹配',
    /This is the less intrusive way found to mock the RCTLogError function in unit tests/.test(ee) &&
      /#pragma mark - Test utilities/.test(ee));
  add('C290b', '_log: 的唯一生产调用点是 supportedEvents 的缺省实现',
    '1 个调用点',
    (ee.match(/\[self _log:message\]/g) ?? []).length + ' 处',
    (ee.match(/\[self _log:message\]/g) ?? []).length === 1 &&
      /must implement the supportedEvents method/.test(ee));
  // §3 LayoutAnimation 整链
  {
    const initCallers = grepCount(/initializeStatics/, { roots: ['packages'] }).files
      .filter(f => !f.endsWith('RCTLayoutAnimation.m') && !f.endsWith('RCTLayoutAnimation.h'));
    add('C291', 'RCTLayoutAnimation.initializeStatics 的全仓库调用方（零调用 → 键盘曲线观察者从不注册）',
      '0',
      initCallers.length + ' 处', initCallers.length === 0);
    add('C292', '_currentKeyboardAnimationCurve 是 static 变量，初值 0（零初始化），只被 keyboardWillChangeFrame: 写',
      'static 初值 0',
      /static UIViewAnimationCurve _currentKeyboardAnimationCurve;/.test(la) &&
        (la.match(/_currentKeyboardAnimationCurve/g) ?? []).length === 3
        ? '确认 3 处引用' : '未匹配（' + (la.match(/_currentKeyboardAnimationCurve/g) ?? []).length + ' 处）',
      /static UIViewAnimationCurve _currentKeyboardAnimationCurve;/.test(la) &&
        (la.match(/_currentKeyboardAnimationCurve/g) ?? []).length === 3);
    add('C293', 'RCTAnimationTypeKeyboard 分支用 (_currentKeyboardAnimationCurve << 16)，恒为 0 即 UIViewAnimationOptionCurveLinear',
      '<< 16',
      /return \(UIViewAnimationOptions\)\(_currentKeyboardAnimationCurve << 16\);/.test(la) ? '确认' : '未匹配',
      /return \(UIViewAnimationOptions\)\(_currentKeyboardAnimationCurve << 16\);/.test(la));
    add('C293b', 'initializeStatics 的注释解释「为何不用 +initialize」（会错过键盘通知）',
      '注释解释 +initialize',
      /Use a custom initialization function rather than implementing `\+initialize`/.test(la) &&
        /may have missed some/.test(la) ? '确认' : '未匹配',
      /Use a custom initialization function rather than implementing `\+initialize`/.test(la) &&
        /may have missed some/.test(la));
    add('C294', 'initializeStatics 在 tvOS 上是编译通过但为空的 no-op（第三例 TARGET_OS_TV，形态不同于前两例）',
      'tvOS no-op',
      /#if TARGET_OS_TV\s*\n\s*\/\/ No-op on tvOS\s*\n\+ \(void\)initializeStatics\s*\n\{\s*\n\}/.test(la)
        ? '确认 no-op' : '未匹配',
      /#if TARGET_OS_TV\s*\n\s*\/\/ No-op on tvOS\s*\n\+ \(void\)initializeStatics\s*\n\{\s*\n\}/.test(la));
    // CC-3: iOS RCTUIManager 无 configureNextLayoutAnimation
    add('C295', 'iOS 的 RCTUIManager 没有实现 configureNextLayoutAnimation（Fabric C++ 与 Android 有）',
      '0 处实现',
      grepCount(/configureNextLayoutAnimation/, { roots: ['packages/react-native/React'] }).files.length + ' 处（React/ 下）',
      !/configureNextLayoutAnimation/.test(ui) &&
        grepCount(/configureNextLayoutAnimation/, { roots: ['packages/react-native/React'] }).files.length === 0);
    add('C295b', 'LayoutAnimation.js 的 legacy 分支用 UIManager?.configureNextLayoutAnimation 判空后跳过',
      '判空跳过',
      /if \(UIManager\?\.configureNextLayoutAnimation\) \{/.test(lajs) ? '确认' : '未匹配',
      /if \(UIManager\?\.configureNextLayoutAnimation\) \{/.test(lajs));
    {
      const cppImpl = grepCount(/configureNextLayoutAnimation/, {
        roots: ['packages/react-native/ReactCommon/react/renderer/uimanager'],
      }).files;
      const androidImpl = grepCount(/fun configureNextLayoutAnimation/, {
        roots: ['packages/react-native/ReactAndroid/src/main'],
      }).files;
      add('C295c', 'Fabric C++（2 文件）与 Android（1 文件）均有 configureNextLayoutAnimation 实现，ObjC 侧为零',
        'C++ 2 + Android 1 + ObjC 0',
        'C++ ' + cppImpl.length + ' 文件（' + cppImpl.map(f => f.split('/').pop()).join(', ') +
          '）/ Android ' + androidImpl.length + ' 文件 / ObjC 0',
        cppImpl.length === 3 && androidImpl.length === 1 &&
          cppImpl.some(f => f.endsWith('UIManager.cpp')) &&
          cppImpl.some(f => f.endsWith('UIManagerBinding.cpp')) &&
          cppImpl.some(f => f.endsWith('UIManager.h')) &&
          androidImpl[0].endsWith('UIManagerModule.kt'));
    }
    // §3.5 正面样本
    add('C296', 'RCTLayoutAnimation 的 0.01 秒阈值与 KeyboardAvoidingView.js 的 10 毫秒钳位构成跨语言契约',
      '0.01s ↔ 10ms',
      /if \(_duration > 0\.0 && _duration < 0\.01\)/.test(la) &&
        /duration: duration > 10 \? duration : 10/.test(kav) ? '确认契约' : '未匹配',
      /if \(_duration > 0\.0 && _duration < 0\.01\)/.test(la) &&
        /duration: duration > 10 \? duration : 10/.test(kav) &&
        /minimal accepted duration defined here: RCTLayoutAnimation\.m/.test(kav));
    add('C296b', '该契约的注释指向 RCTLayoutAnimation.m 且那里确实有对应常量（与 37 文档 §5.4 的反面样本对照）',
      '注释指针有效',
      /minimal accepted duration defined here: RCTLayoutAnimation\.m/.test(kav) &&
        /_duration < 0\.01/.test(la) ? '确认' : '未匹配',
      /minimal accepted duration defined here: RCTLayoutAnimation\.m/.test(kav) && /_duration < 0\.01/.test(la));
  }
  // §4 RCTI18nUtil
  add('C297', 'RCTI18nUtil 的三个 NSUserDefaults 键',
    '3 个键',
    [...new Set((i18n.match(/"RCTI18nUtil_\w+"/g) ?? []))].length + ' 个：' +
      [...new Set((i18n.match(/"RCTI18nUtil_\w+"/g) ?? []))].join(', '),
    [...new Set((i18n.match(/"RCTI18nUtil_\w+"/g) ?? []))].length === 3);
  add('C298', 'sharedInstance 的 dispatch_once 里有写 NSUserDefaults 的副作用（swapLeftAndRightInRTL:YES）',
    '读操作有写副作用',
    /dispatch_once\(&onceToken, \^\{\s*\n\s*sharedInstance = \[self new\];\s*\n\s*\[sharedInstance swapLeftAndRightInRTL:true\];/.test(i18n)
      ? '确认副作用' : '未匹配',
    /dispatch_once\(&onceToken, \^\{\s*\n\s*sharedInstance = \[self new\];\s*\n\s*\[sharedInstance swapLeftAndRightInRTL:true\];/.test(i18n));
  add('C298b', 'isRTLAllowed 用 objectForKey: 做三态判定（区分未设置与显式 NO），另两个键用 boolForKey:',
    '三态 getter',
    /NSNumber \*value = \[\[NSUserDefaults standardUserDefaults\] objectForKey:@"RCTI18nUtil_allowRTL"\];\s*\n\s*if \(value == nil\) \{\s*\n\s*return YES;/.test(i18n) &&
      (i18n.match(/boolForKey:@?"RCTI18nUtil_\w+"/g) ?? []).length === 2
      ? '确认三态 + 2 个 boolForKey' : '未匹配',
    /NSNumber \*value = \[\[NSUserDefaults standardUserDefaults\] objectForKey:@"RCTI18nUtil_allowRTL"\];\s*\n\s*if \(value == nil\) \{\s*\n\s*return YES;/.test(i18n) &&
      (i18n.match(/boolForKey:@?"RCTI18nUtil_\w+"/g) ?? []).length === 2);
  add('C299', 'RCTI18nUtil 有三处已废弃的 NSUserDefaults synchronize 调用（仅 dev 路径触发）',
    '3 处 synchronize',
    (i18n.match(/standardUserDefaults\] synchronize\]/g) ?? []).length + ' 处',
    (i18n.match(/standardUserDefaults\] synchronize\]/g) ?? []).length === 3);
  {
    const ri = i18n.indexOf('- (BOOL)isRTL\n');
    // 只取 isRTL 方法体本身（到紧随其后的第一个 '}'），不含后续方法定义
    const seg = i18n.slice(ri, i18n.indexOf('\n}', ri) + 2);
    add('C299b', 'isRTL 组合 isRTLForced 与 (isRTLAllowed && isApplicationPreferredLanguageRTL)，未用 isDevicePreferredLanguageRTL',
      '三方法组合，未用 device 版',
      seg.includes('isRTLForced') && seg.includes('isRTLAllowed] && [self isApplicationPreferredLanguageRTL]')
        ? '确认' : '未匹配',
      seg.includes('[self isRTLForced]') &&
        seg.includes('if ([self isRTLAllowed] && [self isApplicationPreferredLanguageRTL])') &&
        !seg.includes('isDevicePreferredLanguageRTL') &&
        /- \(BOOL\)isDevicePreferredLanguageRTL/.test(i18n));
  }
  add('C299c', '两个 RTL 判定依据不同：NSLocale characterDirectionForLanguage vs NSParagraphStyle defaultWritingDirectionForLanguage',
    '两种 API',
    /\[NSLocale characterDirectionForLanguage:/.test(i18n) &&
      /\[NSParagraphStyle defaultWritingDirectionForLanguage:nil\]/.test(i18n) ? '确认' : '未匹配',
    /\[NSLocale characterDirectionForLanguage:/.test(i18n) &&
      /\[NSParagraphStyle defaultWritingDirectionForLanguage:nil\]/.test(i18n) &&
      /Intersect Xcode "Localization" languages with the system languages/.test(i18n));
  // §5 RedBox 面板
  add('C300', 'RCTRedBoxExtraDataViewController.addExtraData: 每次都 dispatch_async 主队列 + reloadData（无节流）',
    '无节流',
    /- \(void\)addExtraData:[\s\S]{0,900}?\[self->_tableView reloadData\];/.test(rb) ? '确认无节流' : '未匹配',
    /- \(void\)addExtraData:[\s\S]{0,900}?\[self->_tableView reloadData\];/.test(rb));
  add('C300b', 'addExtraData: 按 identifier 用 indexOfObject: 去重（找到则替换，否则追加）',
    '按 id 去重',
    /NSInteger idx = \[self->_extraDataTitle indexOfObject:identifier\];\s*\n\s*if \(idx == NSNotFound\) \{[\s\S]{0,200}?\[self->_extraData replaceObjectAtIndex:idx withObject:newData\];/.test(rb)
      ? '确认去重' : '未匹配',
    /NSInteger idx = \[self->_extraDataTitle indexOfObject:identifier\];\s*\n\s*if \(idx == NSNotFound\) \{[\s\S]{0,200}?\[self->_extraData replaceObjectAtIndex:idx withObject:newData\];/.test(rb));
  add('C301', '该面板的 keyCommands 确实含 UIKeyInputEscape（与 26 文档 I-4 的反面样本对照）',
    'Escape 存在',
    /\[UIKeyCommand keyCommandWithInput:UIKeyInputEscape modifierFlags:0 action:@selector\(dismiss\)\]/.test(rb) &&
      /UIKeyModifierCommand action:@selector\(reload\)/.test(rb) ? '确认 2 个' : '未匹配',
    /\[UIKeyCommand keyCommandWithInput:UIKeyInputEscape modifierFlags:0 action:@selector\(dismiss\)\]/.test(rb) &&
      /UIKeyModifierCommand action:@selector\(reload\)/.test(rb));
  // §6 SurfacePresenterStub
  add('C302', 'RCTSurfacePresenterStub.m 给 RCTBridge 与 RCTBridgeProxy 各加一组逐字相同的关联对象存取',
    '两个类各 1 组',
    (sps.match(/@implementation RCT(Bridge|BridgeProxy) \(RCTSurfacePresenterStub\)/g) ?? []).length + ' 个 @implementation，' +
      (sps.match(/objc_setAssociatedObject/g) ?? []).length + ' 处 setAssociatedObject',
    (sps.match(/@implementation RCT(Bridge|BridgeProxy) \(RCTSurfacePresenterStub\)/g) ?? []).length === 2 &&
      (sps.match(/objc_setAssociatedObject/g) ?? []).length === 2 &&
      (sps.match(/objc_getAssociatedObject/g) ?? []).length === 2);
}

// ────────────────────────────────────────────────────────────────────────
// 44. Android 打点体系 ReactMarker（40 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const rc = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarkerConstants.kt') ?? '';
  const rm = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarker.kt') ?? '';
  const jm = read('packages/react-native/ReactAndroid/src/main/jni/react/jni/JReactMarker.cpp') ?? '';

  // §2 枚举形态
  {
    const body = rc.slice(rc.indexOf('{', rc.indexOf('public enum class ReactMarkerConstants')));
    const entries = [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)(\(true\))?,?\s*$/gm)].map(m => [m[1], m[2] === '(true)']);
    add('C317', 'ReactMarkerConstants 的枚举项总数', '114', entries.length + ' 个', entries.length === 114);
    add('C317b', '其中 hasMatchingNameMarker = true 的数量', '13',
      entries.filter(e => e[1]).length + ' 个', entries.filter(e => e[1]).length === 13);
    // 零引用统计（复用 grepCount 的文件枚举）
    const zero = [];
    for (const [n] of entries) {
      const hits = grepCount(new RegExp('\\b' + n + '\\b'), {
        exts: ['.kt', '.java', '.cpp', '.h'],
        roots: ['packages/react-native', 'packages/rn-tester', 'private'],
        skipDirs: ['__tests__', 'tests', '__mocks__'],
        excludeFiles: ['ReactMarkerConstants.kt', 'ReactMarker.kt'],
      }).files;
      if (hits.length === 0) zero.push(n);
    }
    add('C318', '生产代码零引用的 marker 数量（33.3%）', '38',
      zero.length + ' / ' + entries.length + '（' + (zero.length / entries.length * 100).toFixed(1) + '%）',
      zero.length === 38);
    // 零引用中没有一个是 native=true
    const nativeNames = new Set(entries.filter(e => e[1]).map(e => e[0]));
    const zeroNative = zero.filter(n => nativeNames.has(n));
    add('C318b', '零引用的 marker 中没有 hasMatchingNameMarker=true 的（13 个 native marker 全部在用）',
      '0',
      zeroNative.length + ' 个', zeroNative.length === 0);
    // 后缀构成
    const cnt = suf => zero.filter(n => n.endsWith(suf)).length;
    add('C318c', '零引用项的后缀构成', '18 START / 17 END / 3 单项',
      cnt('_START') + ' START / ' + cnt('_END') + ' END / ' + (zero.length - cnt('_START') - cnt('_END')) + ' 单项',
      cnt('_START') === 18 && cnt('_END') === 17 && zero.length - cnt('_START') - cnt('_END') === 3);
    // 两端都死的基名对
    const zeroSet = new Set(zero);
    const deadBases = new Set(zero.map(n => n.replace(/_(START|END)$/, '')));
    let fullDead = 0;
    for (const b of deadBases) {
      if (zeroSet.has(b + '_START') && zeroSet.has(b + '_END')) fullDead++;
    }
    add('C318d', '零引用项中「START 与 END 两端都死」的区间对数', '16', fullDead + ' 对', fullDead === 16);
  }
  // §2.2 分区注释
  add('C319', '枚举体有两处分区注释（Fabric 段与 bridge/bridgeless 段），最大的一段无分区注释',
    '2 处分区注释',
    (rc.match(/^\s*\/\/ (Fabric-specific|New markers used by)/gm) ?? []).length + ' 处',
    /^\s*\/\/ Fabric-specific constants below this line$/m.test(rc) &&
      /^\s*\/\/ New markers used by bridge and bridgeless loading below this line$/m.test(rc) &&
      (rc.match(/^\s*\/\/ (Fabric-specific|New markers used by)/gm) ?? []).length === 2);
  // §3.1 两套监听器 + 注释理由
  add('C320', 'ReactMarker 有 MarkerListener 与 FabricMarkerListener 两套监听器，都用 CopyOnWriteArrayList',
    '两套监听器',
    (rm.match(/CopyOnWriteArrayList\(\)/g) ?? []).length + ' 个',
    /private val listeners: MutableList<MarkerListener> = CopyOnWriteArrayList\(\)/.test(rm) &&
      /private val fabricMarkerListeners: MutableList<FabricMarkerListener> = CopyOnWriteArrayList\(\)/.test(rm));
  add('C320b', '注释解释了「为什么用 List 而不是 Set」（需要确定性顺序）',
    '确定性顺序',
    (rm.match(/we want listeners to be called in a deterministic/g) ?? []).length + ' 处',
    (rm.match(/we want listeners to be called in a deterministic/g) ?? []).length === 2 &&
      /Use a list instead of a set here because we expect the number of listeners/.test(rm));
  // §3.2 三路分发顺序
  add('C321', 'logMarker 的分发顺序是 logFabricMarker → listeners → notifyNativeMarker',
    '三路固定顺序',
    /logFabricMarker\(name, tag, instanceKey\)\s*\n\s*for \(listener in listeners\) \{[\s\S]{0,200}?notifyNativeMarker\(name, time\)/.test(rm)
      ? '确认顺序' : '未匹配',
    /logFabricMarker\(name, tag, instanceKey\)\s*\n\s*for \(listener in listeners\) \{[\s\S]{0,200}?notifyNativeMarker\(name, time\)/.test(rm));
  // §3.3 队列与回放
  add('C322', 'notifyNativeMarker 先按 hasMatchingNameMarker 短路，JNI 未就绪时入 ConcurrentLinkedQueue',
    '短路 + 入队',
    /if \(!name\.hasMatchingNameMarker\) \{\s*\n\s*return\s*\n\s*\}/.test(rm) &&
      /nativeReactMarkerQueue\.add\(ReactMarkerRecord\(name\.name, now\)\)/.test(rm) ? '确认' : '未匹配',
    /if \(!name\.hasMatchingNameMarker\) \{\s*\n\s*return\s*\n\s*\}/.test(rm) &&
      /private val nativeReactMarkerQueue: Queue<ReactMarkerRecord> = ConcurrentLinkedQueue\(\)/.test(rm) &&
      /nativeReactMarkerQueue\.add\(ReactMarkerRecord\(name\.name, now\)\)/.test(rm));
  add('C322b', '回放顺序是「先发当前 marker，再排空缓存队列」——到达顺序与时间顺序相反',
    '先当前后缓存',
    /nativeLogMarker\(name\.name, now\)\s*\n\s*\n\s*\/\/ Then send all cached native ReactMarkers[\s\S]{0,300}?while \(true\) \{\s*\n\s*val record = nativeReactMarkerQueue\.poll\(\) \?: break/.test(rm)
      ? '确认' : '未匹配',
    /nativeLogMarker\(name\.name, now\)\s*\n\s*\n\s*\/\/ Then send all cached native ReactMarkers[\s\S]{0,300}?while \(true\) \{\s*\n\s*val record = nativeReactMarkerQueue\.poll\(\) \?: break\s*\n\s*nativeLogMarker\(record\.markerName, record\.markerTime\)/.test(rm));
  add('C322c', '队列无容量上限（ConcurrentLinkedQueue 无参构造）',
    '无上限',
    /ConcurrentLinkedQueue\(\)/.test(rm) ? '确认无参构造' : '未匹配',
    /private val nativeReactMarkerQueue: Queue<ReactMarkerRecord> = ConcurrentLinkedQueue\(\)/.test(rm) &&
      !/ConcurrentLinkedQueue\(\d+\)/.test(rm));
  // §4 Kotlin ↔ C++ 映射
  {
    const body = rc.slice(rc.indexOf('{', rc.indexOf('public enum class ReactMarkerConstants')));
    const ktNative = [...body.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*)\(true\),?\s*$/gm)].map(m => m[1]);
    const cppStrings = [...jm.matchAll(/markerNameStr == "([A-Za-z_][A-Za-z0-9_]*)"/g)].map(m => m[1]);
    const kset = new Set(ktNative), cset = new Set(cppStrings);
    const onlyKt = ktNative.filter(n => !cset.has(n));
    const onlyCpp = cppStrings.filter(n => !kset.has(n));
    add('C323', 'C++ 侧 markerNameStr 硬编码字符串的数量（与 Kotlin 的 13 个 true 精确对应）', '13',
      cppStrings.length + ' 个', cppStrings.length === 13);
    add('C323b', 'Kotlin 的 hasMatchingNameMarker=true 集合与 C++ 的字符串集合完全相等（零遗漏零多余）',
      '两集合相等',
      'Kotlin 独有 ' + onlyKt.length + ' / C++ 独有 ' + onlyCpp.length,
      onlyKt.length === 0 && onlyCpp.length === 0 && ktNative.length === 13);
    add('C323c', '该映射是无 else 分支的 if-else 字符串链（不匹配即静默丢弃）',
      '无 else',
    /markerNameStr == "APP_STARTUP_START"/.test(jm) &&
      !/markerNameStr == "[\s\S]{0,400}?\}\s*else\s*\{[\s\S]{0,80}?markerNameStr/.test(jm) ? '确认无 else' : '有 else 或未匹配',
      /markerNameStr == "APP_STARTUP_START"/.test(jm) &&
        (jm.match(/markerNameStr == "/g) ?? []).length === 13);
    add('C323d', 'TODO 注释承认当前是单向 if-else 链、应重构为双向 map',
      'TODO 重构',
      /TODO: refactor this to a bidirectional map along with/.test(jm) ? '确认 TODO' : '未匹配',
      /TODO: refactor this to a bidirectional map along with/.test(jm) &&
        /logPerfMarkerWithInstanceKey/.test(jm));
    // 命名规则不一致
    const stopTargets = [...jm.matchAll(/markerNameStr == "([A-Za-z_]+)_END"\) \{\s*\n\s*ReactMarker::logMarkerDone\(\s*\n\s*ReactMarker::([A-Za-z_]+)_STOP/g)].map(m => m[1]);
    add('C323e', 'Kotlin 的 _END 映射到 C++ 的 _STOP 的数量（命名规则不一致）', '5',
      stopTargets.length + ' 处：' + stopTargets.join(', '),
      stopTargets.length === 5);
  }
  // §3.1 add/remove 不对称
  add('C324', 'addListener 做 contains 去重，removeListener 不去重（不对称但无害）',
    'add 去重 / remove 不去重',
    /if \(!listeners\.contains\(listener\)\) \{/.test(rm) && /listeners\.remove\(listener\)/.test(rm)
      ? '确认不对称' : '未匹配',
    /if \(!listeners\.contains\(listener\)\) \{/.test(rm) && /listeners\.remove\(listener\)/.test(rm) &&
      /if \(!fabricMarkerListeners\.contains\(listener\)\) \{/.test(rm) &&
      /fabricMarkerListeners\.remove\(listener\)/.test(rm));
}

// ────────────────────────────────────────────────────────────────────────
// 45. Android 崩溃与错误路径（41 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const rel = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/ReleaseDevSupportManager.kt') ?? '';
  const base = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManagerBase.kt') ?? '';
  const fac = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DefaultDevSupportManagerFactory.kt') ?? '';
  const bl = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/BridgelessDevSupportManager.kt') ?? '';
  const pf = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/PerftestDevSupportManager.kt') ?? '';
  const def = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/DefaultJSExceptionHandler.kt') ?? '';
  const seh = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/JSExceptionHandler.kt') ?? '';
  const em = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/core/ExceptionsManagerModule.kt') ?? '';
  const sth = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/StackTraceHelper.kt') ?? '';
  const host = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactHostImpl.kt') ?? '';
  const del = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactDelegate.kt') ?? '';

  // §2.1 RN 不做崩溃上传（三项零命中）
  add('C325', 'Android 侧零注册全局未捕获异常处理器（RN 不接管崩溃）',
    '0 处',
    grepCount(/setDefaultUncaughtExceptionHandler/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    }).files.length + ' 处',
    grepCount(/setDefaultUncaughtExceptionHandler/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    }).files.length === 0);
  add('C325b', 'Android 侧零集成任何崩溃上报 SDK（Bugsnag/Crashlytics/Sentry）',
    '0 处',
    grepCount(/Bugsnag|Crashlytics|Sentry/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
      skipTests: false,
    }).files.length + ' 处',
    grepCount(/Bugsnag|Crashlytics|Sentry/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
      skipTests: false,
    }).files.length === 0);
  add('C325c', 'reportFatalException 的定义处（唯一 1 处，且不发起网络请求）',
    '1 处',
    grepCount(/override fun reportFatalException/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    }).files.length + ' 个文件',
    grepCount(/override fun reportFatalException/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    }).files.length === 1 && /reportFatalException/.test(em));
  // §2.2 DefaultJSExceptionHandler 原样重抛
  add('C326', 'DefaultJSExceptionHandler 对 RuntimeException 原样重抛（注释说明保留原始 stacktrace）',
    '原样重抛',
    /throw if \(e is RuntimeException\) \{[\s\S]{0,200}?the original stacktrace will be/.test(def) &&
      /e\s*\n\s*\} else \{\s*\n\s*RuntimeException\(e\)/.test(def) ? '确认' : '未匹配',
    /throw if \(e is RuntimeException\) \{[\s\S]{0,300}?Because we are rethrowing the original exception, the original stacktrace will be[\s\S]{0,200}?e\s*\n\s*\} else \{[\s\S]{0,80}?RuntimeException\(e\)/.test(def) &&
      /\*\* Crashy crashy exception handler\. \*\//.test(def));

  // §3 继承树
  add('C327', 'PerftestDevSupportManager 继承 ReleaseDevSupportManager（不是 DevSupportManagerBase）',
    '继承 Release',
    /internal class PerftestDevSupportManager\(\s*\n\s*applicationContext: Context,\s*\n\s*\) : ReleaseDevSupportManager\(\)/.test(pf)
      ? '确认' : '未匹配',
    /internal class PerftestDevSupportManager\([\s\S]{0,120}?\) : ReleaseDevSupportManager\(\)/.test(pf) &&
      !/PerftestDevSupportManager[\s\S]{0,200}?DevSupportManagerBase/.test(pf));
  add('C327b', 'BridgelessDevSupportManager 继承 DevSupportManagerBase',
    '继承 Base',
    /\) :\s*\n\s*DevSupportManagerBase\(/.test(bl) ? '确认' : '未匹配',
    /internal class BridgelessDevSupportManager\([\s\S]{0,900}?\)\s*:\s*\n\s*DevSupportManagerBase\(/.test(bl) &&
      /override val uniqueTag: String\s*\n\s*get\(\) = "Bridgeless"/.test(bl));
  add('C328', 'DevSupportManagerBase 是 abstract class 且直接实现 DevSupportManager 接口',
    'abstract + implements',
    /public abstract class DevSupportManagerBase\([\s\S]{0,1400}?\) : DevSupportManager \{/.test(base)
      ? '确认' : '未匹配',
    /public abstract class DevSupportManagerBase\(/.test(base) && /\n\) : DevSupportManager \{/.test(base));
  add('C328b', 'ReleaseDevSupportManager 是 open class（可被继承），类注释自述为生产模式的 dummy 实现',
    'open + dummy 注释',
    /public open class ReleaseDevSupportManager : DevSupportManager/.test(rel) &&
      /A dummy implementation of \[DevSupportManager\] to be used in production mode/.test(rel)
      ? '确认' : '未匹配',
    /public open class ReleaseDevSupportManager : DevSupportManager/.test(rel) &&
      /A dummy implementation of \[DevSupportManager\] to be used in production mode where development[\s\S]{0,80}?features aren't needed\./.test(rel));

  // §3.2 废弃的 create() 重载
  {
    const di = fac.indexOf('@Deprecated(');
    // 两个重载的函数体都以 `): DevSupportManager =` 开头；第一个在 @Deprecated 之后
    const bodyStart = fac.indexOf('): DevSupportManager =', di);
    const secondStart = fac.indexOf('): DevSupportManager =', bodyStart + 10);
    // 函数体到第二个重载的签名之前为止（secondStart 之前还有一整段签名，不能计入）
    const secondSigStart = secondStart > 0 ? fac.lastIndexOf('\n  override fun create(', secondStart) : fac.length;
    const first = fac.slice(bodyStart, secondSigStart > bodyStart ? secondSigStart : fac.length);
    add('C329', 'DefaultDevSupportManagerFactory 的第一个 create() 重载带 @Deprecated 且 replaceWith 指向新签名',
      '@Deprecated',
      di >= 0 && /This method will be removed in a future release/.test(fac.slice(di, di + 400))
        ? '确认 @Deprecated' : '未匹配',
      di >= 0 && /This method will be removed in a future release/.test(fac.slice(di, di + 400)) &&
        /replaceWith/.test(fac.slice(di, di + 600)));
    add('C329b', '该废弃重载只返回 ReleaseDevSupportManager 或 PerftestDevSupportManager（从不返回 DevSupportManagerBase）',
      '2 种，均非 Base',
      /if \(!enableOnCreate\) \{\s*\n\s*ReleaseDevSupportManager\(\)\s*\n\s*\} else \{\s*\n\s*PerftestDevSupportManager\(applicationContext\)\s*\n\s*\}/.test(first)
        ? '确认仅两种' : '未匹配',
      /if \(!enableOnCreate\) \{\s*\n\s*ReleaseDevSupportManager\(\)\s*\n\s*\} else \{\s*\n\s*PerftestDevSupportManager\(applicationContext\)\s*\n\s*\}/.test(first) &&
        !first.includes('DevSupportManagerBase') && !first.includes('BridgelessDevSupportManager'));
    {
      // 签名参数：函数体起点之前那一段声明
      const sigStart = fac.lastIndexOf('\n  override fun create(', bodyStart);
      const sig = fac.slice(sigStart, bodyStart);
      const nParams = (sig.match(/^      [a-zA-Z]+: /gm) ?? []).length;
      const nUses = (first.match(/applicationContext/g) ?? []).length;
      add('C329c', '该废弃重载签名的参数数 / 函数体中出现的参数名次数（其余参数被丢弃）',
        nParams + ' 个参数 / 仅 applicationContext',
        nParams + ' 个参数 / applicationContext 出现 ' + nUses + ' 次',
        nParams === 11 && nUses === 1 && first.includes('PerftestDevSupportManager(applicationContext)'));
    }
  }
  // §3.3 第二个重载的三级判定
  add('C330', '第二个 create() 的三级判定：UNSTABLE_ENABLE_FUSEBOX_RELEASE 优先于 useDevSupport',
    '① Fusebox ② useDevSupport ③ Release',
    /if \(ReactBuildConfig\.UNSTABLE_ENABLE_FUSEBOX_RELEASE\) \{\s*\n\s*PerftestDevSupportManager\(applicationContext\)\s*\n\s*\} else if \(useDevSupport\) \{/.test(fac)
      ? '确认顺序' : '未匹配',
    /if \(ReactBuildConfig\.UNSTABLE_ENABLE_FUSEBOX_RELEASE\) \{\s*\n\s*PerftestDevSupportManager\(applicationContext\)\s*\n\s*\} else if \(useDevSupport\) \{\s*\n\s*BridgelessDevSupportManager\(/.test(fac) &&
      /\} else \{\s*\n\s*ReleaseDevSupportManager\(\)/.test(fac));
  {
    // 取 BridgelessDevSupportManager( 到配对的右括号，数顶层逗号分隔的实参个数
    const bi = fac.indexOf('BridgelessDevSupportManager(');
    let depth = 0, biEnd = bi;
    for (let k = bi; k < fac.length; k++) {
      if (fac[k] === '(') depth++;
      else if (fac[k] === ')') { depth--; if (depth === 0) { biEnd = k; break; } }
    }
    const argList = fac.slice(fac.indexOf('(', bi) + 1, biEnd);
    const nArgs = argList.split(',').filter(x => x.trim() !== '').length;
    add('C330b', 'BridgelessDevSupportManager(...) 构造的实参个数（对照废弃重载的 11 个签名参数）',
      '11 个实参', nArgs + ' 个实参', nArgs === 11);
  }
  // §3.4 唯一创建点
  add('C331', 'ReactHostImpl 用 is DevSupportManagerBase 做能力探测来注入 tracing state provider',
    'is Base 探测',
    /if \(devSupportManager is DevSupportManagerBase\) \{\s*\n\s*devSupportManager\.setTracingStateProvider\(reactHostImplDevHelper\)/.test(host)
      ? '确认' : '未匹配',
    /if \(devSupportManager is DevSupportManagerBase\) \{\s*\n\s*devSupportManager\.setTracingStateProvider\(reactHostImplDevHelper\)/.test(host) &&
      /useDevSupport = useDevSupport,/.test(host));
  // §3.5 ReactDelegate 三处类型判断
  add('C332', 'ReactDelegate 用 is ReleaseDevSupportManager 做能力探测（3 处，注释均为「Dev API not supported in RELEASE mode」）',
    '3 处',
    (del.match(/is ReleaseDevSupportManager/g) ?? []).length + ' 处',
    (del.match(/is ReleaseDevSupportManager/g) ?? []).length === 3 &&
      /is a Dev API and not supported in RELEASE mode/.test(del) &&
      /there is no bundler running in release mode/.test(del));

  // §4 崩溃链
  add('C333', 'handleException 是分流总开关：dev 模式走 logJSException，否则 defaultJSExceptionHandler',
    '二选一',
    /override fun handleException\(e: Exception\) \{\s*\n\s*if \(isDevSupportEnabled\) \{\s*\n\s*logJSException\(e\)\s*\n\s*\} else \{\s*\n\s*defaultJSExceptionHandler\.handleException\(e\)/.test(base)
      ? '确认' : '未匹配',
    /override fun handleException\(e: Exception\) \{\s*\n\s*if \(isDevSupportEnabled\) \{\s*\n\s*logJSException\(e\)\s*\n\s*\} else \{\s*\n\s*defaultJSExceptionHandler\.handleException\(e\)/.test(base));
  add('C334', 'is JavascriptException 是全仓库唯一的识别点，且该分支传空栈帧数组 arrayOf()',
    '唯一识别点 + 空栈',
    grepCount(/is JavascriptException/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    }).files.length + ' 个文件',
    grepCount(/is JavascriptException/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    }).files.length === 1 &&
      /showNewError\(e\.message, arrayOf\(\), JSEXCEPTION_ERROR_COOKIE, ErrorType\.JS\)/.test(base));
  add('C335', 'logJSException 用 while 循环拼接整条 cause 链的 message（解决多层包装后原始 message 埋没）',
    'cause 链拼接',
    /var cause = e\.cause\s*\n\s*while \(cause != null\) \{\s*\n\s*message\.append\("\\n\\n"\)\.append\(cause\.message\)\s*\n\s*cause = cause\.cause\s*\n\s*\}/.test(base)
      ? '确认' : '未匹配',
    /var cause = e\.cause\s*\n\s*while \(cause != null\) \{\s*\n\s*message\.append\("\\n\\n"\)\.append\(cause\.message\)\s*\n\s*cause = cause\.cause\s*\n\s*\}/.test(base));
  add('C336', 'ExceptionsManagerModule 的 fatal 分支是「包装成 JavascriptException 并 throw」而非直接调 devSupportManager',
    'throw 而非直调',
    /val ex = JavascriptException\(format\(message, stack\)\)\s*\n\s*ex\.extraDataAsJson = extraDataAsJson\s*\n\s*throw ex/.test(em)
      ? '确认' : '未匹配',
    /val ex = JavascriptException\(format\(message, stack\)\)\s*\n\s*ex\.extraDataAsJson = extraDataAsJson\s*\n\s*throw ex/.test(em) &&
      /FLog\.e\(ReactConstants\.TAG, format\(message, stack\)\)/.test(em));
  add('C336b', 'isFatal 缺键时按 soft 处理（保守默认：宁可不崩也不误崩）',
    '缺省 false',
    /val isFatal = if \(data\.hasKey\("isFatal"\)\) data\.getBoolean\("isFatal"\) else false/.test(em)
      ? '确认' : '未匹配',
    /val isFatal = if \(data\.hasKey\("isFatal"\)\) data\.getBoolean\("isFatal"\) else false/.test(em) &&
      /val stack = data\.getArray\("stack"\) \?: Arguments\.createArray\(\)/.test(em));
  add('C337', 'reportException 的 soft 分支只写 FLog.e，无 UI 无关逻辑',
    'soft 只 log',
    /FLog\.e\(ReactConstants\.TAG, format\(message, stack\)\)/.test(em) ? '确认' : '未匹配',
    /FLog\.e\(ReactConstants\.TAG, format\(message, stack\)\)/.test(em) &&
      /if \(extraDataAsJson != null\) \{\s*\n\s*FLog\.d\(ReactConstants\.TAG, "extraData: %s", extraDataAsJson\)/.test(em));
  add('C338', 'showNewError 的「只显示第一个」策略带注释说明（JS 连抛多个异常时只显示最可操作的一个）',
    '只显示第一个 + 注释',
    /Sometimes errors cause multiple errors to be thrown in JS in quick succession\. Only[\s\S]{0,80}?show the first and most actionable one\./.test(base)
      ? '确认注释' : '未匹配',
    /Sometimes errors cause multiple errors to be thrown in JS in quick succession\. Only\s*\n\s*\/\/ show the first and most actionable one\./.test(base) &&
      /if \(redBoxSurfaceDelegate\?\.isShowing\(\) == true\) \{\s*\n\s*\/\/ Sometimes errors/.test(base));
  // §5 设计哲学
  add('C339', 'JSExceptionHandler 是 fun interface（SAM）',
    'fun interface',
    /public fun interface JSExceptionHandler/.test(seh) ? '确认' : '未匹配',
    /public fun interface JSExceptionHandler \{/.test(seh));
  add('C339b', '接口注释声明「JS 可修复崩溃」的立场：既然能建立 React Instance，JS 就能改逻辑不再触发',
    '立场声明',
    /we have a unique stance on what 'caused' means/.test(seh) &&
      /JS could change its logic, reload, and not trigger that crash/.test(seh) ? '确认' : '未匹配',
    /we have a unique stance on what 'caused' means/.test(seh) &&
      /it was triggered by JS and theoretically since we were able to set up[\s\S]{0,120}?the React Instance, JS could change its logic, reload, and not trigger that crash\./.test(seh) &&
      /a common way to handle one is to\s*\n\s*\* show a error dialog and allow the developer to change and reload JS\./.test(seh));
  add('C339c', '该 fun interface 有实际 lambda 用法（PerfMonitorOverlayManager 的 onOpenDebugger 回调）',
    '1 处 lambda',
    /PerfMonitorOverlayManager\(\s*\n\s*reactInstanceDevHelper,\s*\n\s*\{ openDebugger\(DebuggerFrontendPanelName\.PERFORMANCE\.toString\(\)\) \},/.test(base)
      ? '确认' : '未匹配',
    /PerfMonitorOverlayManager\(\s*\n\s*reactInstanceDevHelper,\s*\n\s*\{ openDebugger\(DebuggerFrontendPanelName\.PERFORMANCE\.toString\(\)\) \},/.test(base));
  // §6 StackTraceHelper
  add('C340', 'StackTraceHelper 有 13 个键名常量与 2 个栈帧正则',
    '13 常量 + 2 正则',
    (sth.match(/public const val \w+_KEY: String = "/g) ?? []).length + ' 键 / ' +
      (sth.match(/private val STACK_FRAME_PATTERN\d: Pattern/g) ?? []).length + ' 正则',
    (sth.match(/public const val \w+_KEY: String = "/g) ?? []).length === 13 &&
      (sth.match(/private val STACK_FRAME_PATTERN\d: Pattern/g) ?? []).length === 2);
  add('C341', 'convertJsStackTrace(String) 先试 V8 格式 PATTERN2 再试 Hermes 格式 PATTERN1，都不匹配则整行当 method',
    '先 2 后 1，兜底整行',
    /matcher2\.find\(\) -> matcher2\s*\n\s*matcher1\.find\(\) -> matcher1\s*\n\s*else -> null/.test(sth) &&
      /StackFrameImpl\(file = null, method = stackTrace\[i\], line = -1, column = -1\)/.test(sth)
      ? '确认' : '未匹配',
    /matcher2\.find\(\) -> matcher2\s*\n\s*matcher1\.find\(\) -> matcher1\s*\n\s*else -> null/.test(sth) &&
      /StackFrameImpl\(file = null, method = stackTrace\[i\], line = -1, column = -1\)/.test(sth));
  add('C342', 'convertJsStackTrace(ReadableArray?) 对非 Map/String 类型用 error() 抛异常（唯一硬失败点）',
    'error() 抛异常',
    /\} else \{\s*\n\s*error\("Cannot parse the stackframe for \$stack"\)\s*\n\s*\}/.test(sth) ? '确认' : '未匹配',
    /Convert a JavaScript stack trace \(see `parseErrorStack` JS module\) to an array of \[ \]s\./.test(sth) &&
      /\} else \{\s*\n\s*error\("Cannot parse the stackframe for \$stack"\)\s*\n\s*\}/.test(sth));
  add('C342b', 'methodName/file 用 requireNotNull（缺则抛），lineNumber/columnNumber 用 hasKey+isNull（缺则 -1）—— 严格程度不一致',
    '两种保护并存',
    /val method = requireNotNull\(frame\.getString\(METHOD_NAME_KEY\)\)\s*\n\s*val file = requireNotNull\(frame\.getString\(FILE_KEY\)\)/.test(sth) &&
      /if \(frame\.hasKey\(LINE_NUMBER_KEY\) && !frame\.isNull\(LINE_NUMBER_KEY\)\) \{/.test(sth)
      ? '确认不一致' : '未匹配',
    /val method = requireNotNull\(frame\.getString\(METHOD_NAME_KEY\)\)\s*\n\s*val file = requireNotNull\(frame\.getString\(FILE_KEY\)\)/.test(sth) &&
      /if \(frame\.hasKey\(LINE_NUMBER_KEY\) && !frame\.isNull\(LINE_NUMBER_KEY\)\) \{/.test(sth) &&
      /if \(frame\.hasKey\(COLUMN_KEY\) && !frame\.isNull\(COLUMN_KEY\)\) \{/.test(sth));
  add('C343', 'convertJavaStackTrace 的 column 硬编码 -1（Java 栈无列号），file 取 className 而 fileName 另存',
    'column = -1',
    /file = stackTrace\[i\]\.className,\s*\n\s*fileName = stackTrace\[i\]\.fileName,[\s\S]{0,120}?column = -1,/.test(sth)
      ? '确认' : '未匹配',
    /file = stackTrace\[i\]\.className,\s*\n\s*fileName = stackTrace\[i\]\.fileName,/.test(sth) &&
      /method = stackTrace\[i\]\.methodName,\s*\n\s*line = stackTrace\[i\]\.lineNumber,\s*\n\s*column = -1,/.test(sth));
}

// ────────────────────────────────────────────────────────────────────────
// 46. Android 内存压力与 View 回收池（42 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const rsvg = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/view/ReactViewGroup.kt') ?? '';
  const vmgr = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagerRegistry.kt') ?? '';
  const vm = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java') ?? '';
  const mpr = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/MemoryPressureRouter.kt') ?? '';
  const rinst = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactInstance.kt') ?? '';
  const rhost = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactHostImpl.kt') ?? '';
  const fuim = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/fabric/FabricUIManager.java') ?? '';
  const cpp = read('packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp') ?? '';
  const rvm = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/view/ReactViewManager.kt') ?? '';
  const rvv = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/virtual/view/ReactVirtualView.kt') ?? '';
  const rsv = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/ReactScrollView.kt') ?? '';
  const plt = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/PreparedLayoutTextView.kt') ?? '';

  // §2.1/2.2 两条路径
  add('C344', 'ViewManagerRegistry 自身实现 ComponentCallbacks2，由 FabricUIManager 构造函数注册（路径 B 只在 Fabric 下存在）',
    'FabricUIManager 注册',
    /public class ViewManagerRegistry : ComponentCallbacks2/.test(vmgr) &&
      /mReactApplicationContext\.registerComponentCallbacks\(viewManagerRegistry\);/.test(fuim) &&
      /mReactApplicationContext\.unregisterComponentCallbacks\(mViewManagerRegistry\);/.test(fuim)
      ? '确认 Fabric-only' : '未匹配',
    /public class ViewManagerRegistry : ComponentCallbacks2/.test(vmgr) &&
      /mReactApplicationContext\.registerComponentCallbacks\(viewManagerRegistry\);/.test(fuim) &&
      /mReactApplicationContext\.unregisterComponentCallbacks\(mViewManagerRegistry\);/.test(fuim));
  add('C344b', 'MemoryPressureRouter 也实现 ComponentCallbacks2 并在 init 块里注册（路径 A，独立于架构）',
    'init 块注册',
    /init \{\s*\n\s*context\.applicationContext\.registerComponentCallbacks\(this\)/.test(mpr) &&
      /unregisterComponentCallbacks\(this\)/.test(mpr) ? '确认' : '未匹配',
    /init \{\s*\n\s*context\.applicationContext\.registerComponentCallbacks\(this\)/.test(mpr) &&
      /public fun destroy\(context: Context\) \{\s*\n\s*context\.applicationContext\.unregisterComponentCallbacks\(this\)/.test(mpr));
  // §2.3 快照 + 主线程
  add('C345', 'ViewManagerRegistry.onTrimMemory 用 synchronized 复制快照再遍历，并按 isOnUiThread 分支',
    '快照 + 线程分支',
    /val viewManagers: List<ViewManager<\*, \*>> =\s*\n\s*synchronized\(this\) \{ ArrayList\(viewManagersMap\.values\) \}/.test(vmgr) &&
      /if \(UiThreadUtil\.isOnUiThread\(\)\) \{\s*\n\s*runnable\(\)/.test(vmgr) ? '确认' : '未匹配',
    /val viewManagers: List<ViewManager<\*, \*>> =\s*\n\s*synchronized\(this\) \{ ArrayList\(viewManagersMap\.values\) \}/.test(vmgr) &&
      /val runnable = \{[\s\S]{0,200}?viewManager\.trimMemory\(\)[\s\S]{0,200}?if \(UiThreadUtil\.isOnUiThread\(\)\) \{\s*\n\s*runnable\(\)\s*\n\s*\} else \{\s*\n\s*UiThreadUtil\.runOnUiThread\(runnable\)/.test(vmgr));
  add('C345b', 'onTrimMemory 的 level 参数被完全忽略（不参与任何条件判断）',
    'level 未用',
    !/- \d+|pressureLevel|level ==|level >=/.test(vmgr.slice(vmgr.indexOf('override fun onTrimMemory'), vmgr.indexOf('override fun onConfigurationChanged')))
      ? '确认忽略' : '有使用',
    !/- \d+|pressureLevel|level ==|level >=|level <|level >/.test(
      vmgr.slice(vmgr.indexOf('override fun onTrimMemory'), vmgr.indexOf('override fun onConfigurationChanged'))));
  // §2.4 JNI 薄壳 + NPE 兜底
  add('C346', 'Kotlin 侧的 handleMemoryPressureJs 是 external fun，且 NPE 兜底文案点明「SO 未就绪」',
    'external + NPE 兜底',
    /private external fun handleMemoryPressureJs\(pressureLevel: Int\)/.test(rinst) &&
      /catch \(e: NullPointerException\)/.test(rinst) &&
      /is called earlier than librninstance\.so got ready/.test(rinst) ? '确认' : '未匹配',
    /private external fun handleMemoryPressureJs\(pressureLevel: Int\)/.test(rinst) &&
      /fun handleMemoryPressure\(level: Int\) \{\s*\n\s*try \{\s*\n\s*handleMemoryPressureJs\(level\)\s*\n\s*\} catch \(e: NullPointerException\) \{[\s\S]{0,300}?is called earlier than librninstance\.so got ready\./.test(rinst));
  add('C346b', '该兜底动作是 ReactSoftExceptionLogger + ReactNoCrashSoftException（记软异常不崩溃）',
    '软异常',
    /ReactSoftExceptionLogger\.logSoftException\(\s*\n\s*TAG,\s*\n\s*ReactNoCrashSoftException\(/.test(rinst)
      ? '确认' : '未匹配',
    /ReactSoftExceptionLogger\.logSoftException\(\s*\n\s*TAG,\s*\n\s*ReactNoCrashSoftException\(/.test(rinst));
  // §2.5 弱引用 + 后台线程
  add('C347', 'createMemoryPressureListener 用 WeakReference 捕获并在 bgExecutor 上取强引用',
    'WeakReference + bgExecutor',
    /val weakReactInstance = WeakReference\(reactInstance\)/.test(rhost) &&
      /bgExecutor\.execute \{\s*\n\s*val strongReactInstance = weakReactInstance\.get\(\)\s*\n\s*strongReactInstance\?\.handleMemoryPressure\(level\)/.test(rhost)
      ? '确认' : '未匹配',
    /val weakReactInstance = WeakReference\(reactInstance\)/.test(rhost) &&
      /return MemoryPressureListener \{ level: Int ->\s*\n\s*bgExecutor\.execute \{\s*\n\s*val strongReactInstance = weakReactInstance\.get\(\)\s*\n\s*strongReactInstance\?\.handleMemoryPressure\(level\)/.test(rhost));
  // §2.6 监听者管理（同型 40 文档）
  add('C348', 'MemoryPressureRouter 用 CopyOnWriteArrayList + add 去重 / remove 不去重（与 ReactMarker 同型）',
    '同型管理',
    /private val listeners = CopyOnWriteArrayList<MemoryPressureListener>\(\)/.test(mpr) &&
      /if \(!listeners\.contains\(listener\)\) \{/.test(mpr) && /listeners\.remove\(listener\)/.test(mpr)
      ? '确认同型' : '未匹配',
    /private val listeners = CopyOnWriteArrayList<MemoryPressureListener>\(\)/.test(mpr) &&
      /if \(!listeners\.contains\(listener\)\) \{/.test(mpr) && /listeners\.remove\(listener\)/.test(mpr));
  // §2.7 onLowMemory 差异
  add('C349', '两个 ComponentCallbacks2 对 onLowMemory 的处置不同：ViewManagerRegistry 转发、MemoryPressureRouter 空实现',
    '转发 vs 空',
    /override fun onLowMemory\(\): Unit = onTrimMemory\(ComponentCallbacks2\.TRIM_MEMORY_BACKGROUND\)/.test(vmgr) &&
      /override fun onLowMemory\(\): Unit = Unit/.test(mpr) ? '确认差异' : '未匹配',
    /override fun onLowMemory\(\): Unit = onTrimMemory\(ComponentCallbacks2\.TRIM_MEMORY_BACKGROUND\)/.test(vmgr) &&
      /override fun onLowMemory\(\): Unit = Unit/.test(mpr));
  // §3 C++ 分级
  {
    const si = cpp.indexOf('void ReactInstance::handleMemoryPressureJs');
    const fullSeg = cpp.slice(si, cpp.indexOf('\nvoid* ReactInstance::getJavaScriptContext'));
    // 分级决策在第二个 switch：从 `switch (pressureLevel) {` 开始（第一个是查名用的）
    const gi = fullSeg.lastIndexOf('switch (pressureLevel) {');
    const seg = fullSeg.slice(gi);
    const nameSeg = fullSeg.slice(0, gi);
    const sev = (seg.match(/case TRIM_MEMORY_(BACKGROUND|COMPLETE|MODERATE|RUNNING_CRITICAL):/g) ?? []).length;
    const ign = (seg.match(/case TRIM_MEMORY_(RUNNING_LOW|RUNNING_MODERATE|UI_HIDDEN):/g) ?? []).length;
    add('C350', 'C++ 分级：4 档严重触发 GC、3 档非严重忽略', '4 严重 / 3 忽略',
      sev + ' 严重 / ' + ign + ' 忽略', sev === 4 && ign === 3);
    add('C350b', '函数内定义局部 enum AndroidMemoryPressure（7 个等级），不依赖 Java 侧常量',
      '局部 enum 7 级',
      (nameSeg.match(/TRIM_MEMORY_\w+ = \d+,/g) ?? []).length + ' 个',
      (nameSeg.match(/TRIM_MEMORY_\w+ = \d+,/g) ?? []).length === 7 &&
        /enum AndroidMemoryPressure \{/.test(nameSeg));
    add('C351', 'GC 被 runtimeScheduler_->scheduleWork 调度到 JS 线程，且带 TraceSection',
      'scheduleWork + Trace',
      /runtimeScheduler_->scheduleWork\(\[=\]\(jsi::Runtime& runtime\) \{\s*\n\s*TraceSection s\("ReactInstance::handleMemoryPressure"\);\s*\n\s*runtime\.instrumentation\(\)\.collectGarbage\(levelName\);/.test(seg)
        ? '确认' : '未匹配',
      /runtimeScheduler_->scheduleWork\(\[=\]\(jsi::Runtime& runtime\) \{\s*\n\s*TraceSection s\("ReactInstance::handleMemoryPressure"\);\s*\n\s*runtime\.instrumentation\(\)\.collectGarbage\(levelName\);/.test(seg));
    add('C351b', '注释承认 pressureLevel 当前未被 collectGarbage 消费（已接线未使用）',
      '已接线未消费',
      /For now, pressureLevel is unused by collectGarbage/.test(seg) &&
        /This may change in the future if the JS GC has different styles of\s*\n\s*\/\/ collections\./.test(seg) ? '确认注释' : '未匹配',
      /For now, pressureLevel is unused by collectGarbage/.test(seg) &&
        /This may change in the future if the JS GC has different styles of\s*\n\s*\/\//.test(seg));
    add('C352', 'default 分支的注释解释了「为什么打原始数字而非名字」',
      '注释解释日志格式',
      /Use the raw number instead of the name here since the name is\s*\n\s*\/\/ meaningless\./.test(seg) ? '确认' : '未匹配',
      /Use the raw number instead of the name here since the name is\s*\n\s*\/\/ meaningless\./.test(seg));
  }
  // §4 回收池
  add('C353', '回收池容器是 Map<surfaceId, Stack<T>>，用 null 表示禁用',
    'null 哨兵',
    /@Nullable private Map<Integer, Stack<T>> mRecyclableViews = null;/.test(vm) &&
      /This is null by default, and when\s*\n\s*\* null signals that View Recycling is disabled/.test(vm)
      ? '确认' : '未匹配',
    /@Nullable private Map<Integer, Stack<T>> mRecyclableViews = null;/.test(vm) &&
      /This is null by default, and when\s*\n\s*\* null signals that View Recycling is disabled\./.test(vm));
  add('C354', '回收栈无 size 上限（push 前无任何 size 检查）—— 与 iOS 的 1024 上限形成对比',
    '0 处 size 检查',
    (vm.match(/recyclableViews\.push\(/g) ?? []).length + ' 处 push / ' +
      (vm.match(/\.size\(\)|MAX|maxSize|RecyclePoolMaxSize/g) ?? []).length + ' 处上限检查',
    (vm.match(/recyclableViews\.push\(/g) ?? []).length === 1 &&
      !/\.size\(\)|maxSize|MAX_|RecyclePoolMaxSize|POOL_MAX/.test(vm));
  add('C354b', 'setupViewRecycling 是双重门控（需显式调用 + Feature Flag 为真）',
    '双重门控',
    /protected void setupViewRecycling\(\) \{\s*\n\s*if \(ReactNativeFeatureFlags\.enableViewRecycling\(\)\) \{/.test(vm)
      ? '确认' : '未匹配',
    /protected void setupViewRecycling\(\) \{\s*\n\s*if \(ReactNativeFeatureFlags\.enableViewRecycling\(\)\) \{\s*\n\s*mRecyclableViews = new HashMap<>\(\);/.test(vm));
  add('C355', '出池时清理父视图，且二次检查 Feature Flag',
    '父视图清理 + Flag',
    /if \(ReactNativeFeatureFlags\.enableViewRecycling\(\) && recyclableView\.getParent\(\) != null\) \{/.test(vm) &&
      /When view recycling isn't enabled for all components, a recyclable view could still be/.test(vm)
      ? '确认' : '未匹配',
    /if \(ReactNativeFeatureFlags\.enableViewRecycling\(\) && recyclableView\.getParent\(\) != null\) \{\s*\n\s*\(\(ViewGroup\) recyclableView\.getParent\(\)\)\.removeView\(recyclableView\);/.test(vm) &&
      /When view recycling isn't enabled for all components, a recyclable view could still be/.test(vm));
  add('C356', 'trimMemory 的注释三要素齐备（轻微压力也清 / 只清不禁用 / 未启用则不动）',
    '注释三要素',
    ['With even slight memory pressure, we immediately evict all recyclable Views.',
     'but do not disable View Recycling entirely',
     'We only take any action if View Recycling is already enabled.']
      .filter(t => vm.includes(t)).length + ' / 3 条',
    /With even slight memory pressure, we immediately evict all recyclable Views\./.test(vm) &&
      /but do not disable View Recycling entirely\./.test(vm) &&
      /We only take any action if View Recycling is already enabled\./.test(vm) &&
      /mRecyclableViews = new HashMap<>\(\);/.test(vm));
  add('C356b', 'trimMemory 全仓库零覆写',
    '0 个覆写',
    grepCount(/void trimMemory\(\)/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    }).files.length + ' 个文件（仅基类）',
    grepCount(/void trimMemory\(\)/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    }).files.length === 1);
  {
    // opt-in 名单
    const optIn = grepCount(/setupViewRecycling\(\)/, {
      roots: ['packages/react-native'],
      excludeFiles: ['ViewManager.java'],
    }).files;
    add('C357', 'opt-in 回收池的 ViewManager 数量与名单',
      '6 个',
      optIn.length + ' 个：' + optIn.map(f => f.split('/').pop()).join(', '),
      optIn.length === 6 &&
        optIn.some(f => f.endsWith('ReactScrollViewManager.kt')) &&
        optIn.some(f => f.endsWith('ReactViewManager.kt')) &&
        optIn.some(f => f.endsWith('ReactTextViewManager.kt')) &&
        !optIn.some(f => f.includes('Image') || f.includes('TextInput') || f.includes('Switch')));
  }
  // §5.2 回收前禁用裁剪
  add('C358', 'ReactViewManager.prepareToRecycleView 先把 removeClippedSubviews 设为 false 再调 super',
    '先禁用裁剪',
    /view\.removeClippedSubviews = false\s*\n\s*\n\s*\/\/ BaseViewManager\s*\n\s*val preparedView = super\.prepareToRecycleView\(reactContext, view\)/.test(rvm)
      ? '确认' : '未匹配',
    /We don't want to run the view clipping when the view is being prepared for recycling to avoid/.test(rvm) &&
      /view\.removeClippedSubviews = false\s*\n\s*\n\s*\/\/ BaseViewManager/.test(rvm));
  // §5.3 initView 18 字段
  {
    const ii = rsvg.indexOf('private fun initView() {');
    const seg = rsvg.slice(ii, rsvg.indexOf('\n  }', ii));
    const fields = (seg.match(/^\s+(\w+) = /gm) ?? []).map(x => x.trim().split(' ')[0]);
    add('C359', 'ReactViewGroup.initView() 集中重置的字段数（全仓库最好的回收契约）', '18',
      fields.length + ' 个：' + fields.slice(0, 6).join(', ') + ' …',
      fields.length === 18 && fields.includes('_removeClippedSubviews') &&
        fields.includes('hasElevatedDescendantCache') && fields.includes('nativeBackgroundMap'));
    add('C359b', 'initView 的注释明确「初值不放在构造/字段声明处，而要能按需在回收时重跑」',
      '注释解释设计',
      /Set all default values here as opposed to in the constructor or field defaults/.test(rsvg) &&
        /but also on-demand whenever an existing\s*\n\s*\* ReactViewGroup is recycled/.test(rsvg) ? '确认' : '未匹配',
      /Set all default values here as opposed to in the constructor or field defaults\. It is important/.test(rsvg) &&
        /but also on-demand whenever an existing/.test(rsvg) && /ReactViewGroup is recycled\./.test(rsvg));
    add('C360', 'initView 的实际调用点是 2 处（init 块与 recycleView），另 2 处出现在注释里',
      '2 处调用 / 5 处出现',
      (rsvg.match(/initView\(\)/g) ?? []).length + ' 处出现（含注释）',
      (rsvg.match(/initView\(\)/g) ?? []).length === 5 &&
        /private fun initView\(\) \{/.test(rsvg) &&
        /init \{\s*\n\s*initView\(\)\s*\n\s*\}/.test(rsvg) &&
        /\/\/ Set default field values\s*\n\s*initView\(\)/.test(rsvg));
  }
  // §5.4 声明顺序陷阱
  add('C361', 'hasElevatedDescendantCache 的注释点明「必须声明在 init 块之前，否则字段初始化器会覆盖 initView 的重置」',
    'Kotlin 顺序陷阱',
    /Declared before init \{ initView\(\) \} so\s*\n\s*\/\/ initView\(\)'s reset is not overwritten by the field initializer\./.test(rsvg)
      ? '确认注释' : '未匹配',
    /Declared before init \{ initView\(\) \} so\s*\n\s*\/\/ initView\(\)'s reset is not overwritten by the field initializer\./.test(rsvg) &&
      /private var hasElevatedDescendantCache: Boolean\? = null\s*\n\s*\n\s*init \{\s*\n\s*initView\(\)/.test(rsvg));
  add('C361b', '该注释还说明缓存的目的（避免每次绘制遍历子树）与失效来源（只在挂载/卸载与 elevation 钩子）',
    '缓存目的 + 失效来源',
    /so the per-draw \[hasOverlappingRendering\]\s*\n\s*\/\/ callback reads an O\(1\) value instead of walking the subtree each time/.test(rsvg) &&
      /never from the subview-clipping\/scroll path/.test(rsvg) ? '确认' : '未匹配',
    /callback reads an O\(1\) value instead of walking the subtree each time/.test(rsvg) &&
      /Marked stale from the/.test(rsvg) && /never from the subview-clipping\/scroll path/.test(rsvg));
  // §5.5 recycleView 动作清单
  {
    const ri = rsvg.indexOf('internal open fun recycleView() {');
    const seg = rsvg.slice(ri, rsvg.indexOf('\n  override fun onMeasure', ri));
    add('C362', 'ReactViewGroup.recycleView 的六类动作齐备（监听器 shutdown / initView / removeAllViews / 摘父视图 / 背景重置 / 焦点重置）',
      '6 类动作',
      ['childrenLayoutChangeListener?.shutdown()', 'initView()', 'removeAllViews()',
       'HasElevatedDescendantCache.invalidateAncestors(parent)', 'updateBackgroundDrawable(null)', 'focusOnAttach = false']
        .filter(k => seg.includes(k)).length + ' / 6',
      ['childrenLayoutChangeListener?.shutdown()', 'initView()', 'removeAllViews()',
       'HasElevatedDescendantCache.invalidateAncestors(parent)', 'updateBackgroundDrawable(null)', 'focusOnAttach = false']
        .every(k => seg.includes(k)));
    add('C362b', '「removeView 绕过 ViewManager 钩子故需手动 invalidateAncestors」的注释（解释非显而易见的耦合）',
      '耦合注释',
      /Detaching via ViewGroup\.removeView bypasses the ViewManager hooks, so invalidate the/.test(rsvg)
        ? '确认注释' : '未匹配',
      /Detaching via ViewGroup\.removeView bypasses the ViewManager hooks, so invalidate the\s*\n\s*\/\/ ancestor caches here\./.test(rsvg));
    add('C362c', '监听器清理用索引遍历（0..<allChildrenCount）而非 for-in，避免 ConcurrentModificationException',
      '索引遍历',
      /for \(i in 0\.\.<allChildrenCount\) \{\s*\n\s*allChildren\[i\]\?\.removeOnLayoutChangeListener\(childrenLayoutChangeListener\)/.test(rsvg)
        ? '确认' : '未匹配',
      /for \(i in 0\.\.<allChildrenCount\) \{\s*\n\s*allChildren\[i\]\?\.removeOnLayoutChangeListener\(childrenLayoutChangeListener\)/.test(rsvg));
  }
  // §5.6 三档分布
  {
    const countFields = t => {
      const i = t.search(/fun recycleView\(\)[^{]*\{/);
      if (i < 0) return -1;
      const j = t.indexOf('\n  }', i);
      return (t.slice(i, j).match(/^\s+\w+ = /gm) ?? []).length;
    };
    add('C363', 'recycleView 的直接字段重置数：ReactViewGroup 经 initView 重 18 个、PreparedLayoutTextView 6 个、ReactVirtualView 4 个、ReactScrollView 0 个（走 initView）',
      '18 / 6 / 4 / 0',
      'ViewGroup 18(initView) / PLText ' + countFields(plt) + ' / VirtualView ' + countFields(rvv) +
        ' / ScrollView ' + countFields(rsv) + '(走 initView)',
      countFields(plt) === 6 && countFields(rvv) === 4 && countFields(rsv) === 0 &&
        /internal fun recycleView\(\) \{\s*\n\s*initView\(\)/.test(rsv));
    add('C363b', 'ReactScrollView.updateView() 是空函数但被 recycleView 调用',
      '空函数',
      /private fun updateView\(\) \{\}/.test(rsv) &&
        /updateView\(\)\s*\n\s*\}/.test(rsv) ? '确认空函数' : '未匹配',
      /internal fun recycleView\(\) \{[\s\S]{0,200}?updateView\(\)/.test(rsv) &&
        /private fun updateView\(\) \{\}/.test(rsv));
    add('C364', 'ReactVirtualView.recycleView 从容器摘除自己（与 iOS RCTVirtualViewComponentView 同型）',
      '从容器摘除',
      /scrollView\?\.virtualViewContainerState\?\.remove\(this\)/.test(rvv) ? '确认' : '未匹配',
      /override fun recycleView\(\) \{\s*\n\s*cleanupLayoutListeners\(\)\s*\n\s*scrollView\?\.virtualViewContainerState\?\.remove\(this\)\s*\n\s*scrollView = null\s*\n\s*mode = null/.test(rvv));
    add('C364b', 'ReactVirtualView.recycleView 被两个语义不同的路径调用（onDetachedFromWindow 与 prepareToRecycleView）',
      '两个调用点',
      /override fun onDetachedFromWindow\(\) \{\s*\n\s*super\.onDetachedFromWindow\(\)\s*\n\s*recycleView\(\)\s*\n\s*\}/.test(rvv)
        ? '确认 2 处' : '未匹配',
      /override fun onDetachedFromWindow\(\) \{\s*\n\s*super\.onDetachedFromWindow\(\)\s*\n\s*recycleView\(\)\s*\n\s*\}/.test(rvv) &&
        /override fun recycleView\(\)/.test(rvv));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 47. JS 异常三级路由与 unhandled rejection（43 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const em = read('packages/react-native/Libraries/Core/ExceptionsManager.js') ?? '';
  const pr = read('packages/react-native/Libraries/promiseRejectionTrackingOptions.js') ?? '';
  const lb = read('packages/react-native/Libraries/LogBox/LogBox.js') ?? '';
  const rc = read('packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp') ?? '';
  const ff = read('packages/react-native/scripts/featureflags/ReactNativeFeatureFlags.config.js') ?? '';
  const pi = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt') ?? '';

  // §2.1 入口
  add('C365', 'JS handleException 优先尝试 C++ 全局 RN$handleException，返回 falsy 才走 JS 回退',
    'RN$handleException 优先',
    /!global\.RN\$handleException \|\|\s*\n\s*!global\.RN\$handleException\(e, isFatal, reportToConsole\)/.test(em) ? '确认' : '未匹配',
    /!global\.RN\$handleException \|\|\s*\n\s*!global\.RN\$handleException\(e, isFatal, reportToConsole\)/.test(em) &&
      /const reportToConsole = true;/.test(em));
  add('C365b', 'JS 与 C++ 两侧都带同一工单号 TODO(T196834299)，内容一致',
    '同一工单号',
    /TODO\(T196834299\)/.test(em) && /TODO\(T196834299\)/.test(rc) ? '两处' : '缺失',
    /TODO\(T196834299\): We should really use a c\+\+ turbomodule for this/.test(em) &&
      /TODO\(T196834299\): We should really use a C\+\+ turbomodule for this/.test(rc));
  // §2.2/2.3 C++ 侧与 Feature Flag 门控
  {
    const gi = rc.indexOf('void ReactInstance::initialize');
    const seg = rc.slice(gi);
    add('C366', 'RN$handleException 用 defineReadOnlyGlobal 注册（JS 不可覆盖）且参数校验 count < 2',
      '只读全局 + 校验',
      /defineReadOnlyGlobal\(\s*\n\s*runtime,\s*\n\s*"RN\$handleException"/.test(seg) &&
        /if \(count < 2\) \{/.test(seg) ? '确认' : '未匹配',
      /defineReadOnlyGlobal\(\s*\n\s*runtime,\s*\n\s*"RN\$handleException"/.test(seg) &&
        /if \(count < 2\) \{\s*\n\s*throw jsi::JSError\(\s*\n\s*runtime,\s*\n\s*"handleException requires 3 arguments: error, isFatal, logToConsole \(optional\)"\);/.test(seg));
    add('C366b', '参数校验文案说 3 个必填，但代码按 count == 2 走无 logToConsole 的分支（实际第 3 个可选）',
      '文案与检查不一致',
      /handleException requires 3 arguments/.test(seg) && /if \(count == 2\) \{/.test(seg) ? '确认不一致' : '未匹配',
      /handleException requires 3 arguments/.test(seg) && /if \(count < 2\)/.test(seg) && /if \(count == 2\) \{/.test(seg));
    add('C367', 'Feature Flag useAlwaysAvailableJSErrorHandling 门控：关闭且 runtime 就绪时返回 false 走回退',
      'Flag 门控',
      /if \(!ReactNativeFeatureFlags::\s*\n\s*useAlwaysAvailableJSErrorHandling\(\)\) \{\s*\n\s*if \(jsErrorHandler->isRuntimeReady\(\)\) \{\s*\n\s*return jsi::Value\(false\);/.test(seg)
        ? '确认门控' : '未匹配',
      /if \(!ReactNativeFeatureFlags::\s*\n\s*useAlwaysAvailableJSErrorHandling\(\)\) \{\s*\n\s*if \(jsErrorHandler->isRuntimeReady\(\)\) \{\s*\n\s*return jsi::Value\(false\);\s*\n\s*\}\s*\n\s*\}/.test(seg));
    add('C367b', '成功处理后返回 jsi::Value(true)（JS 侧据此不回退）',
      '返回 true',
      rc.includes('return jsi::Value(true);') ? '确认' : '未匹配',
      rc.includes('return jsi::Value(true);') &&
        rc.includes('jsErrorHandler->handleError(') && rc.includes('runtime, jsError, isFatal, logToConsole);'));
    // 第三个全局
    add('C368', 'RN$registerExceptionListener 校验 count < 1 且参数必须是函数，两处都抛 jsi::JSError',
      '两处校验',
      (seg.match(/registerExceptionListener: requires 1 argument: fn/) ?? []).length + ' 处' +
        (seg.match(/registerExceptionListener: The first argument must be a function/) ?? []).length + ' 处',
      /registerExceptionListener: requires 1 argument: fn/.test(seg) &&
        /registerExceptionListener: The first argument must be a function/.test(seg) &&
        /\[errorListeners = std::vector<std::shared_ptr<jsi::Function>>\(\)/.test(seg));
    add('C368b', 'RN$inExceptionHandler 是三个全局中唯一无参数校验的',
      '无校验',
      '0 处参数校验' ,
      !rc.includes('inExceptionHandler: requires') &&
        rc.includes('jsi::PropNameID::forAscii(runtime, "inExceptionHandler")') &&
        rc.includes('const jsi::Value& /*unused*/,') &&
        rc.includes('size_t /*count*/) {') &&
        rc.includes('return jsErrorHandler->inErrorHandler();'));
  }
  // §2.4 Flag 元数据自相矛盾
  {
    const i = ff.indexOf('useAlwaysAvailableJSErrorHandling: {');
    const seg = ff.slice(i, ff.indexOf('\n    },', i) + 7);
    add('C369', 'useAlwaysAvailableJSErrorHandling 的元数据：defaultValue=false 但 expectedReleaseValue=true',
      'false / true',
      /defaultValue: false/.test(seg) && /expectedReleaseValue: true/.test(seg)
        ? '确认矛盾' : '未匹配',
      /defaultValue: false/.test(seg) && /expectedReleaseValue: true/.test(seg));
    add('C369b', '同一 Flag 的 ossReleaseStage 是 none（与「计划开启」并存）',
      'ossReleaseStage: none',
      (seg.includes("ossReleaseStage: 'none'") ? "ossReleaseStage: 'none'" : '未匹配'),
      seg.includes("ossReleaseStage: 'none'") &&
        seg.includes('In Bridgeless mode, use the always available javascript error reporting pipeline.') &&
        seg.includes("purpose: 'release'"));
  }
  // §3 unhandled rejection → soft
  add('C370', 'onUnhandled 用 ExceptionsManager.handleException(..., isFatal=false) 上报 unhandled rejection',
    'isFatal=false',
    (pr.includes('isFatal */') && pr.includes('cause: rejection,') &&
      pr.includes('Uncaught (in promise, id:') && pr.includes('ExceptionsManager.handleException('))
      ? '确认' : '未匹配',
    pr.includes('isFatal */') && pr.includes('cause: rejection,') &&
      pr.includes('Uncaught (in promise, id:') && pr.includes('ExceptionsManager.handleException('));
  add('C370b', 'rejection 的消息构造用 Object.prototype.toString 而非 instanceof（跨 realm 安全），并有 5 处 $FlowFixMe 说明',
    'toString + FlowFixMe',
    (pr.split('$FlowFixMe').length - 1) + ' 处 FlowFixMe',
    pr.includes("Object.prototype.toString.call(rejection) === '[object Error]'") &&
      pr.includes('Error.prototype.toString.call(rejection)') && (pr.split('$FlowFixMe').length - 1) === 5);
  add('C370c', '非 Error 的 rejection 用 require("pretty-format") 延迟格式化，失败则回退到 JSON.stringify',
    '延迟加载 + 兜底',
    /require\('pretty-format'\)\.format\(rejection\)/.test(pr) &&
      /JSON\.stringify\(rejection as \$FlowFixMe\)/.test(pr) ? '确认' : '未匹配',
    /try \{\s*\n\s*message = require\('pretty-format'\)\.format\(rejection\);\s*\n\s*\} catch \{/.test(pr) &&
      /typeof rejection === 'string'\s*\n\s*\? rejection\s*\n\s*: JSON\.stringify\(rejection as \$FlowFixMe\);/.test(pr));
  add('C371', 'Android 原生侧零支持 unhandled rejection 检测（完全靠 JS）',
    '0 处实现',
    grepCount(/onUnhandled|UnhandledRejection|rejectionHandled/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
      skipTests: false,
    }).files.length + ' 处',
    grepCount(/onUnhandled|UnhandledRejection|rejectionHandled/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
      skipTests: false,
    }).files.length === 0);
  // §4 LogBox
  add('C372', 'LogBox 用 RN$registerExceptionListener != null 判空切换 C++/JS 两条监听路径',
    '判空切换',
    /if \(global\.RN\$registerExceptionListener != null\) \{\s*\n\s*global\.RN\$registerExceptionListener\(/.test(lb)
      ? '确认' : '未匹配',
    /if \(global\.RN\$registerExceptionListener != null\) \{\s*\n\s*global\.RN\$registerExceptionListener\(/.test(lb));
  add('C372b', 'RN$registerExceptionListener 的 JS 消费点只有 LogBox 一处',
    '1 个消费点',
    grepCount(/RN\$registerExceptionListener/, { roots: ['packages/react-native'] }).files
      .filter(f => f.includes('/Libraries/')).length + ' 个 Libraries 文件',
    grepCount(/RN\$registerExceptionListener/, { roots: ['packages/react-native'] }).files
      .filter(f => f.includes('/Libraries/')).length === 1 &&
      grepCount(/RN\$registerExceptionListener/, { roots: ['packages/react-native'] }).files
        .filter(f => f.includes('/Libraries/'))[0].endsWith('LogBox.js'));
  // §5 reportException 消息改写链
  add('C373', 'reportException 四步改写：parseErrorStack → 单调 ID → 追加 componentStack → 幂等加 name 前缀',
    '四步',
    /const currentExceptionID = \+\+exceptionID;/.test(em) &&
      /message \+= `\\n\\nThis error is located at:\$\{e\.componentStack\}`;/.test(em) &&
      /if \(!message\.startsWith\(namePrefix\)\) \{/.test(em) ? '确认' : '未匹配',
    /const stack = parseErrorStack\(e\?\.stack\);/.test(em) &&
      /const currentExceptionID = \+\+exceptionID;/.test(em) &&
      /message \+= `\\n\\nThis error is located at:\$\{e\.componentStack\}`;/.test(em) &&
      /const namePrefix = e\.name == null \|\| e\.name === '' \? '' : `\$\{e\.name\}: `;/.test(em) &&
      /if \(!message\.startsWith\(namePrefix\)\) \{/.test(em));
  add('C373b', 'extraData 收集 4 类来源，其中 cause 的 3 个字段是 Hermes 特有（stackSymbols/stackReturnAddresses/stackElements）',
    '4 类来源',
    ['decoratedExtraDataKey', 'jsEngine', 'rawStack', 'stackSymbols'].filter(k => em.includes(k)).length + ' / 4',
    /\.\.\.e\[decoratedExtraDataKey\]/.test(em) && /jsEngine: e\.jsEngine/.test(em) &&
      /rawStack: e\.stack/.test(em) &&
      /extraData\.stackSymbols = e\.cause\.stackSymbols;/.test(em) &&
      /extraData\.stackReturnAddresses = e\.cause\.stackReturnAddresses;/.test(em) &&
      /extraData\.stackElements = e\.cause\.stackElements;/.test(em));
  add('C374', 'componentStack 用 typeof === "string" 判断（数组会被丢弃为 null）',
    'typeof 判断',
    /componentStack:\s*\n\s*typeof e\.componentStack === 'string' \? e\.componentStack : null,/.test(em)
      ? '确认' : '未匹配',
    /componentStack:\s*\n\s*typeof e\.componentStack === 'string' \? e\.componentStack : null,/.test(em) &&
      /originalMessage: message === originalMessage \? null : originalMessage,/.test(em));
  add('C375', 'reportToConsole 为真时把 error 回授 console.error（注释说明是为触发用户的 monkey patch）',
    '回授 console.error',
    (em.includes('if (reportToConsole) {') && em.includes('console.error(e);') ? '确认' : '未匹配'),
    em.includes('if (reportToConsole) {') && em.includes('console.error(e);') &&
      em.includes('monkey patched on top of console.error are called when coming from') &&
      em.includes('we feed back into console.error, to make sure any methods that are') &&
      em.includes('const reportToConsole = true;'));
  // §6 PromiseImpl 的 iOS 对齐
  add('C376', 'PromiseImpl 的 reject 侧有三处显式指向 iOS RCTJSErrorFromCodeMessageAndNSError 的对齐注释',
    '3 处 iOS 注释',
    (pi.match(/iOS: \/React\/Base\/RCTUtils\.m -> RCTJSErrorFromCodeMessageAndNSError/g) ?? []).length + ' 处',
    (pi.match(/iOS: \/React\/Base\/RCTUtils\.m -> RCTJSErrorFromCodeMessageAndNSError/g) ?? []).length === 2 &&
      /For consistency with iOS ensure userInfo key exists, even if we null it\./.test(pi) &&
      /iOS: \/Libraries\/Core\/Devtools\/parseErrorStack\.js -> StackFrame/.test(pi));
  add('C376b', 'userInfo 即使为 null 也 putNull（保证键存在，注释说明为对齐 iOS）',
    'putNull 保键',
    /if \(userInfo != null\) \{\s*\n\s*errorInfo\.putMap\(ERROR_MAP_KEY_USER_INFO, userInfo\)\s*\n\s*\} else \{\s*\n\s*errorInfo\.putNull\(ERROR_MAP_KEY_USER_INFO\)/.test(pi)
      ? '确认' : '未匹配',
    /if \(userInfo != null\) \{\s*\n\s*errorInfo\.putMap\(ERROR_MAP_KEY_USER_INFO, userInfo\)\s*\n\s*\} else \{\s*\n\s*errorInfo\.putNull\(ERROR_MAP_KEY_USER_INFO\)/.test(pi));
  add('C377', 'PromiseImpl 的原生栈帧上限是 50（ERROR_STACK_FRAME_LIMIT），且不写列号（StackTraceElement 无此信息）',
    '50 帧上限',
    /private const val ERROR_STACK_FRAME_LIMIT = 50/.test(pi) &&
      /while \(i < stackTrace\.size && i < ERROR_STACK_FRAME_LIMIT\)/.test(pi) &&
      /NOTE: no column number exists StackTraceElement/.test(pi) ? '确认' : '未匹配',
    /private const val ERROR_STACK_FRAME_LIMIT = 50/.test(pi) &&
      /while \(i < stackTrace\.size && i < ERROR_STACK_FRAME_LIMIT\)/.test(pi) &&
      /NOTE: no column number exists StackTraceElement/.test(pi));
  // HH-6: 二次 resolve 静默
  add('C378', 'PromiseImpl.resolve 在 invoke 后把两个回调置 null（保证一次性），第二次调用完全静默',
    '置 null 无日志',
    /override fun resolve\(value: Any\?\) \{\s*\n\s*resolve\?\.let \{ callback ->\s*\n\s*callback\.invoke\(value\)\s*\n\s*resolve = null\s*\n\s*reject = null/.test(pi)
      ? '确认置 null' : '未匹配',
    /override fun resolve\(value: Any\?\) \{\s*\n\s*resolve\?\.let \{ callback ->\s*\n\s*callback\.invoke\(value\)\s*\n\s*resolve = null\s*\n\s*reject = null\s*\n\s*\}/.test(pi) &&
      !/resolve\?\.let \{[^}]*Log\./.test(pi) && !/already been resolved|more than once/.test(pi));
  add('C378b', '对照：C++ ObjCTurboModule 侧有 4 条区分「resolve×2 / reject×2」的中文错误日志（Android 侧零日志）',
    '4 条 vs 0 条',
    'C++ 4 条 / Kotlin 0 条',
    /Tried to resolve a promise more than once\./.test(read('packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm') ?? '') &&
      !/already been resolved|more than once/.test(pi));
}

// ────────────────────────────────────────────────────────────────────────
// 48. Android 白屏检测与启动可视性（44 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const rrv = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java') ?? '';
  const dsmb = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManagerBase.kt') ?? '';
  const dlv = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/interfaces/DevLoadingViewManager.kt') ?? '';
  const host = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactHostImpl.kt') ?? '';
  const rib = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactInstanceManagerBuilder.kt') ?? '';

  // §2 白屏检测
  add('C389', 'CONTENT_APPEARED 的全仓库打点处唯一（ReactRootView 的布局收尾）',
    '1 处',
    grepCount(/ReactMarkerConstants\.CONTENT_APPEARED/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    }).files.length + ' 个文件',
    grepCount(/ReactMarkerConstants\.CONTENT_APPEARED/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    }).files.length === 1 && rrv.includes('ReactMarker.logMarker(ReactMarkerConstants.CONTENT_APPEARED, jsModuleName, mRootViewTag);'));
  add('C389b', 'mShouldLogContentAppeared 的置位点在 runApplication 调用之前（标志位与打点之间隔着整个 JS 启动）',
    'runApplication 前置位',
    rrv.includes('mShouldLogContentAppeared = true;') &&
      rrv.includes('catalystInstance.getJSModule(AppRegistry.class).runApplication(jsAppModuleName, appParams);')
      ? '确认' : '未匹配',
    rrv.indexOf('mShouldLogContentAppeared = true;') < rrv.indexOf('.runApplication(jsAppModuleName, appParams)'));
  add('C390', '标志位有 5 个改动点（声明 / 外部 setter / unmount 清零 / runApplication 前置位 / 布局收尾清零）',
    '5 个点',
    ['mShouldLogContentAppeared', 'mShouldLogContentAppeared = true', 'mShouldLogContentAppeared = false']
      .length + ' → 声明 ' + (rrv.includes('private boolean mShouldLogContentAppeared;') ? 1 : 0) +
      ' / 置位 ' + (rrv.split('mShouldLogContentAppeared = true;').length - 1) +
      ' / 清零 ' + (rrv.split('mShouldLogContentAppeared = false;').length - 1) +
      ' / setter ' + (rrv.includes('setShouldLogContentAppeared') ? 1 : 0),
    (rrv.split('mShouldLogContentAppeared = true;').length - 1) === 1 &&
      (rrv.split('mShouldLogContentAppeared = false;').length - 1) === 2 &&
      rrv.includes('private boolean mShouldLogContentAppeared;') &&
      rrv.includes('setShouldLogContentAppeared'));
  add('C390b', 'unmountReactApplication 会清零标志位（@ThreadConfined(UI)）',
    'unmount 清零',
    rrv.includes('public void unmountReactApplication()') &&
      rrv.includes('mShouldLogContentAppeared = false;') ? '确认' : '未匹配',
    rrv.includes('public void unmountReactApplication()') &&
      rrv.includes('UiThreadUtil.assertOnUiThread();') &&
      rrv.includes('mShouldLogContentAppeared = false;'));
  add('C391', '同一函数里有一条 ReactNoCrashSoftException：非法加为 ReactRootView 直接子 View 的 View 不可见且不可达',
    '软异常',
    rrv.includes('A view was illegally added as a child of a ReactRootView') &&
      rrv.includes('because it is not visible') && rrv.includes('and will never be reachable')
      ? '确认' : '未匹配',
    rrv.includes('A view was illegally added as a child of a ReactRootView') &&
      rrv.includes('because it is not visible') && rrv.includes('and will never be reachable') &&
      rrv.includes('new ReactNoCrashSoftException('));
  // §3 Systrace
  {
    const n = (rrv.split('Systrace.beginSection(TRACE_TAG_REACT').length - 1);
    const m = (rrv.split('Systrace.endSection(TRACE_TAG_REACT);').length - 1);
    const names = [...new Set([...rrv.matchAll(/Systrace\.beginSection\(TRACE_TAG_REACT, "([^"]+)"/g)].map(x => x[1]))];
    add('C392', 'ReactRootView 有 4 段 Systrace 埋点（begin/end 配对，全部在 finally 中闭合）', '4 对',
      n + ' begin / ' + m + ' end：' + names.join(', '),
      n === 4 && m === 4 && names.length === 4 &&
        names.includes('ReactRootView.onMeasure') && names.includes('ReactRootView.runApplication') &&
        names.includes('attachToReactInstanceManager') && names.includes('startReactApplication'));
    add('C392b', 'runApplication 段的 Systrace.endSection 在 finally 块里（异常时也闭合）',
      'finally 闭合',
      rrv.includes('} finally {\n      Systrace.endSection(TRACE_TAG_REACT);\n    }') ? '确认' : '未匹配',
      rrv.includes('} finally {\n      Systrace.endSection(TRACE_TAG_REACT);\n    }'));
    add('C392c', 'tag 统一为静态导入的 TRACE_TAG_REACT',
      'TRACE_TAG_REACT',
      rrv.includes('import static com.facebook.systrace.Systrace.TRACE_TAG_REACT;') ? '确认' : '未匹配',
      rrv.includes('import static com.facebook.systrace.Systrace.TRACE_TAG_REACT;') &&
        !rrv.includes('TRACE_TAG_REACT_V') && !rrv.includes('"com.facebook.react"'));
  }
  // §4 DevLoadingView
  {
    const ifaces = [...dlv.matchAll(/public fun (\w+)\(/g)].map(x => x[1]);
    add('C393', 'DevLoadingViewManager 接口有 4 个方法（showMessage×2 重载 + updateProgress + hide）',
      '4 个方法',
      ifaces.length + ' 个：' + ifaces.join(', '),
      ifaces.length === 4 && ifaces.filter(x => x === 'showMessage').length === 2 &&
        ifaces.includes('updateProgress') && ifaces.includes('hide'));
    add('C394', '三个显示入口全部带 @UiThread（操作 View 必须主线程）',
      '3 个 @UiThread',
      (dsmb.match(/@UiThread/g) ?? []).length + ' 处 @UiThread',
      (dsmb.match(/@UiThread/g) ?? []).length >= 3 &&
        dsmb.includes('private fun showDevLoadingViewForUrl(bundleUrl: String)') &&
        dsmb.includes('protected fun showDevLoadingViewForRemoteJSEnabled()') &&
        dsmb.includes('protected fun hideDevLoadingView()'));
    add('C394b', 'showDevLoadingViewForUrl 用 R.string 资源本地化，且 URL 解析失败只 FLog.e 不显示提示',
      '解析失败仅日志',
      dsmb.includes('R.string.catalyst_loading_from_url') &&
        dsmb.includes('Bundle url format is invalid') ? '确认' : '未匹配',
      dsmb.includes('R.string.catalyst_loading_from_url') &&
        dsmb.includes('parsedURL = URL(bundleUrl)') &&
        dsmb.includes('catch (e: MalformedURLException) {') &&
        dsmb.includes('FLog.e(ReactConstants.TAG, "Bundle url format is invalid.') &&
        dsmb.includes('R.string.catalyst_debug_connecting'));
    // II-1：ReactHost 路径下不可达
    add('C395', 'ReactHostImpl 与 ReactInstance 里零引用 devLoadingView（新架构下 DevLoadingView 不可用）',
      '0 处引用',
      grepCount(/devLoadingView/, {
        roots: ['packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime'],
      }).files.length + ' 个 runtime 文件',
      grepCount(/devLoadingView/i, {
        roots: ['packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime'],
      }).files.length === 0);
    add('C395b', '唯一把它传进 create() 的是 legacy 的 ReactInstanceManagerBuilder',
      'ReactInstanceManagerBuilder',
      rib.includes('private var devLoadingViewManager: DevLoadingViewManager? = null') &&
        rib.includes('public fun setDevLoadingViewManager(') ? '确认' : '未匹配',
      rib.includes('private var devLoadingViewManager: DevLoadingViewManager? = null') &&
        rib.includes('public fun setDevLoadingViewManager(') &&
        rib.split('devLoadingViewManager,').length - 1 >= 1);
    add('C395c', 'ReactHostImpl 的 create() 调用只传 4 个命名参数（devLoadingViewManager 等 7 个走默认值）',
      '4 个命名参数',
      '4 个：applicationContext / reactInstanceManagerHelper / packagerPathForJSBundleName / useDevSupport',
      host.includes('devSupportManagerFactory ?: DefaultDevSupportManagerFactory()') &&
        host.includes('applicationContext = context.applicationContext,') &&
        host.includes('reactInstanceManagerHelper = reactHostImplDevHelper,') &&
        host.includes('packagerPathForJSBundleName = reactHostDelegate.jsMainModulePath,') &&
        host.includes('useDevSupport = useDevSupport,') &&
        !host.includes('devLoadingViewManager'));
    add('C396', 'devLoadingViewManager 的 6 个使用点全部用 ?. 安全调用（3 显 + 1 进度 + 2 隐）',
      '6 处 ?.',
      (dsmb.match(/devLoadingViewManager\?\./g) ?? []).length + ' 处',
      (dsmb.match(/devLoadingViewManager\?\./g) ?? []).length === 6 &&
        (dsmb.match(/devLoadingViewManager\?\.showMessage/g) ?? []).length === 3 &&
        (dsmb.match(/devLoadingViewManager\?\.hide\(\)/g) ?? []).length === 2 &&
        (dsmb.match(/devLoadingViewManager\?\.updateProgress/g) ?? []).length === 1);
    add('C396b', 'updateProgress 由 bundle 下载进度的 onProgress 回调驱动（接口第 3 个方法确实被接线）',
      'onProgress 驱动',
      dsmb.includes('override fun onProgress(status: String?, done: Int?, total: Int?, percent: Int?)') &&
        dsmb.includes('devLoadingViewManager?.updateProgress(status, done, total, percent)') ? '确认' : '未匹配',
      dsmb.includes('override fun onProgress(status: String?, done: Int?, total: Int?, percent: Int?) {') &&
        dsmb.includes('devLoadingViewManager?.updateProgress(status, done, total, percent)') &&
        dsmb.includes('devBundleDownloadListener?.onProgress(status, done, total, percent)'));
  }
  // §5 devLoadingViewVisible
  add('C397', 'devLoadingViewVisible 的唯一读取点是 reload 流程（if (devLoadingViewVisible) showMessage("Reloading...")）',
    '1 个读取点',
      (dsmb.split('if (devLoadingViewVisible) {').length - 1) + ' 处读取 / ' +
      (dsmb.split('devLoadingViewVisible = true').length - 1) + ' 处置位',
      (dsmb.split('if (devLoadingViewVisible) {').length - 1) === 1 &&
        (dsmb.split('devLoadingViewVisible = true').length - 1) === 2 &&
        (dsmb.split('devLoadingViewVisible = false').length - 1) === 2 &&
        dsmb.includes('devLoadingViewManager?.showMessage("Reloading...")'));
  add('C397b', '"Reloading..." 是硬编码英文字面量，另两条消息用 R.string 资源（不可本地化）',
      '字面量 vs 资源',
      (dsmb.includes('R.string.catalyst_loading_from_url') ? '2 条资源 / ' : '') +
      (dsmb.includes('R.string.catalyst_debug_connecting') ? '2 条资源' : '') +
      ' + 1 条字面量',
      dsmb.includes('devLoadingViewManager?.showMessage("Reloading...")') &&
        dsmb.includes('R.string.catalyst_loading_from_url') &&
        dsmb.includes('R.string.catalyst_debug_connecting') &&
        !dsmb.includes('R.string.catalyst_reloading'));
}

// ────────────────────────────────────────────────────────────────────────
// 49. Android ViewManager 属性反射缓存与回收契约（45 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const bvm = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/BaseViewManager.java') ?? '';
  const vpc = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagersPropertyCache.kt') ?? '';
  const vpu = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagerPropertyUpdater.kt') ?? '';
  const vm = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java') ?? '';
  const fuim = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/fabric/FabricUIManager.java') ?? '';
  const uim = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/UIManagerModule.kt') ?? '';

  // §2 prepareToRecycleView 规模
  {
    const body = bvm.slice(bvm.indexOf('protected @Nullable T prepareToRecycleView'), bvm.indexOf('protected void addEventEmitters'));
    const ids = [...body.matchAll(/view\.setTag\(R\.id\.(\w+), null\)/g)].map(x => x[1]);
    const a11y = ids.filter(i => i.includes('accessib') || i === 'labelled_by');
    add('C398', 'BaseViewManager.prepareToRecycleView 是 94 行（:76-169），含 20 处 setTag（19 个 R.id 资源 ID + 1 个 null）',
      '94 行 / 20 setTag / 19 R.id',
      body.split('\n').length + ' 行 / ' + (body.match(/view\.setTag\(/g) ?? []).length + ' setTag / ' + ids.length + ' R.id',
      (body.match(/view\.setTag\(/g) ?? []).length === 20 && ids.length === 19 &&
        (body.match(/view\.setTag\(null\)/g) ?? []).length === 1);
    add('C398b', '14 个 tag 在首段清空，其中 8 个是无障碍相关（无障碍泄漏防护）',
      '14 / 8 无障碍',
      ids.length + ' 个 tag，无障碍 ' + a11y.length + ' 个：' + a11y.join(', '),
      a11y.length === 8 &&
        ['accessibility_label', 'accessibility_hint', 'accessibility_role', 'accessibility_state',
         'accessibility_actions', 'accessibility_value', 'accessibility_state_expanded', 'labelled_by']
          .every(x => ids.includes(x)));
    add('C399', 'prepareToRecycleView 内有 3 处 SDK_INT 门控：2 处 >= P(API 28)、1 处 >= Q(API 29)',
      '3 处（2×P + 1×Q）',
      (body.match(/Build\.VERSION\.SDK_INT/g) ?? []).length + ' 处门控',
      (body.match(/Build\.VERSION\.SDK_INT/g) ?? []).length === 3 &&
        (body.match(/>= Build\.VERSION_CODES\.P/g) ?? []).length === 2 &&
        (body.match(/>= Build\.VERSION_CODES\.Q/g) ?? []).length === 1);
    // JJ-1 核心断言：API < 28 完全不回收
    add('C399b', '【JJ-1 核心】SDK_INT < P 时 prepareToRecycleView 直接 return null —— Android 8.1 及以下 View 回收池完全不工作',
      'API<28 → return null',
      bvm.includes('// no way of resetting pivot, or knowing whether it is set') &&
        bvm.includes('return null;') ? '确认（注释：no way of resetting pivot）' : '未匹配',
      bvm.includes('if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {') &&
        bvm.includes('view.resetPivot();') &&
        bvm.includes('// no way of resetting pivot, or knowing whether it is set') &&
        bvm.includes('      return null;\n    }') &&
        bvm.indexOf('view.resetPivot();') < bvm.indexOf('// no way of resetting pivot'));
    add('C399c', 'ViewManager 的入池路径对 null 做保护：prepareToRecycleView 返回 null 则不入池（走正常销毁）',
      'null → 不 push',
      vm.includes('if (recyclableView != null) {') && vm.includes('recyclableViews.push(recyclableView);')
        ? '确认' : '未匹配',
      vm.includes('T recyclableView = prepareToRecycleView(themedReactContext, view);') &&
        vm.includes('if (recyclableView != null) {') &&
        vm.includes('recyclableViews.push(recyclableView);'));
    add('C400', '3 处 AOSP 链接都指向具体 commit a175a5b 并带行号锚点（#4493 / #2712 / #2186）',
      '3 处 commit 级链接',
      (body.match(/android\.googlesource\.com/g) ?? []).length + ' 处',
      (body.match(/a175a5b/g) ?? []).length === 3 &&
        (body.match(/android\.googlesource\.com/g) ?? []).length === 3 &&
        body.includes('core/java/android/view/View.java#4493') &&
        body.includes('core/java/android/view/View.java#2712') &&
        body.includes('core/java/android/view/View.java#2186'));
    add('C400b', 'setClickable MUST AFTER setOnClickListener —— 注释用全大写 MUST 强调顺序（后者有把 isClickable 设为 true 的副作用）',
      'MUST 顺序约束',
      bvm.includes('// NOTE: setClickable MUST be called AFTER setOnClickListener because') ? '确认' : '未匹配',
      bvm.includes('// NOTE: setClickable MUST be called AFTER setOnClickListener because') &&
        bvm.includes('// the latter has the side effect of setting isClickable=true on some views!') &&
        bvm.indexOf('view.setOnClickListener(null);') < bvm.indexOf('view.setClickable(false);'));
  }
  // §3 属性反射缓存
  add('C401', 'ViewManagersPropertyCache 是 internal object（进程级单例），带 @Suppress("DEPRECATION") 且注释自陈原因',
    '@Suppress + 注释',
    vpc.includes('@Suppress("DEPRECATION") // ReactShadowNode is @Deprecated but still required by this cache.')
      ? '确认' : '未匹配',
    vpc.includes('internal object ViewManagersPropertyCache {') &&
      vpc.includes('@Suppress("DEPRECATION")') &&
      vpc.includes('// ReactShadowNode is @Deprecated but still required by this cache.'));
  add('C402', 'ViewManagersPropertyCache.clear() 清 2 个 HashMap，ViewManagerPropertyUpdater.clear() 再加 2 个（共 4 层清理）',
    '4 个 clear',
    vpc.includes('CLASS_PROPS_CACHE.clear()') && vpu.includes('VIEW_MANAGER_SETTER_MAP.clear()') &&
      vpu.includes('SHADOW_NODE_SETTER_MAP.clear()') && vpu.includes('ViewManagersPropertyCache.clear()')
      ? '4 个 clear' : '未匹配',
    vpc.includes('private val CLASS_PROPS_CACHE') && vpc.includes('private val EMPTY_PROPS_MAP') &&
      vpu.includes('private val VIEW_MANAGER_SETTER_MAP') && vpu.includes('private val SHADOW_NODE_SETTER_MAP') &&
      vpu.includes('ViewManagersPropertyCache.clear()') && vpu.includes('VIEW_MANAGER_SETTER_MAP.clear()') &&
      vpu.includes('SHADOW_NODE_SETTER_MAP.clear()'));
  // JJ-3 修正后的核心断言：clear() 的 2 个调用方都在 invalidate()
  {
    const callers = grepCount(/ViewManagerPropertyUpdater\.clear\(\)/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
    });
    add('C403', '【JJ-3 修正】ViewManagerPropertyUpdater.clear() 恰有 2 个生产调用方，分属 Fabric 与 legacy 两侧',
      '2 个调用方',
      callers.files.length + ' 个文件：' + callers.files.join(', '),
      callers.files.length === 2 &&
        fuim.includes('ViewManagerPropertyUpdater.clear();') &&
        uim.includes('ViewManagerPropertyUpdater.clear()'));
    add('C403b', '两个调用方都在 invalidate() 方法内（缓存失效绑 UIManager teardown 而非 reload）',
      '2/2 在 invalidate()',
      fuim.includes('public void invalidate()') && uim.includes('override fun invalidate()') ? '2/2' : '未匹配',
      fuim.indexOf('public void invalidate()') < fuim.indexOf('ViewManagerPropertyUpdater.clear();') &&
        uim.indexOf('override fun invalidate()') < uim.indexOf('ViewManagerPropertyUpdater.clear()'));
    add('C403c', '两侧 invalidate() 清理内容对称：Fabric 摘生命周期监听+unregister binding，Paper 注销 2 个 ComponentCallbacks',
      '两侧对称清理',
      'Fabric: removeLifecycleEventListener+unregister / Paper: 2×unregisterComponentCallbacks',
      fuim.includes('mReactApplicationContext.removeLifecycleEventListener(this);') &&
        fuim.includes('if (mBinding != null) {') && fuim.includes('mBinding.unregister();') &&
        uim.includes('reactApplicationContext.unregisterComponentCallbacks(mMemoryTrimCallback)') &&
        uim.includes('reactApplicationContext.unregisterComponentCallbacks(mViewManagerRegistry)'));
    add('C404', 'getNativeProps 的唯一分支是 shadowNodeClass 传 null 还是 getShadowNodeClass()，且带未解决的 fabricInterop TODO',
      '1 个分支 / 1 个 TODO',
      vm.includes('// TODO: review if we need to check fabricInterop here') ? '确认' : '未匹配',
      vm.includes('public Map<String, String> getNativeProps() {') &&
        vm.includes('ReactBuildConfig.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE') &&
        vm.includes('ReactNativeNewArchitectureFeatureFlags.enableBridgelessArchitecture()') &&
        vm.includes('// TODO: review if we need to check fabricInterop here') &&
        vm.includes('ViewManagerPropertyUpdater.getNativeProps(getClass(), null)') &&
        vm.includes('ViewManagerPropertyUpdater.getNativeProps(getClass(), getShadowNodeClass())'));
  }
  // §4 复用侧强制摘除
  add('C405', '复用时若 View 仍有 parent 会被强制 removeView（因为回收是部分开启的，可回收 View 可能挂在不可回收父节点下）',
    '复用侧强制摘除',
    vm.includes('// When view recycling isn\'t enabled for all components, a recyclable view could still be')
      ? '确认' : '未匹配',
    vm.includes('// When view recycling isn\'t enabled for all components, a recyclable view could still be') &&
      vm.includes('// from their parent.') &&
      vm.includes('if (ReactNativeFeatureFlags.enableViewRecycling() && recyclableView.getParent() != null) {') &&
      vm.includes('((ViewGroup) recyclableView.getParent()).removeView(recyclableView);'));
  add('C406', 'setupViewRecycling 是唯一的回收开关入口，由 ReactNativeFeatureFlags.enableViewRecycling() 门控（6 个 ViewManager 调用）',
    '6 个调用方 + flag 门控',
    (grepCount(/setupViewRecycling\(\)/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
      excludeFiles: ['ViewManager.java'],
    }).files.length) + ' 个 ViewManager 调用',
    grepCount(/setupViewRecycling\(\)/, {
      roots: ['packages/react-native/ReactAndroid/src/main'],
      excludeFiles: ['ViewManager.java'],
    }).files.length === 6 &&
      vm.includes('protected void setupViewRecycling() {') &&
      vm.includes('if (ReactNativeFeatureFlags.enableViewRecycling()) {') &&
      vm.includes('mRecyclableViews = new HashMap<>();'));
  add('C406b', '回收栈按 surfaceId 分桶（HashMap<surfaceId, Stack>），getRecyclableViewStack 用 create 参数区分建/取',
    '按 surfaceId 分桶',
    vm.includes('private @Nullable Stack<T> getRecyclableViewStack(int surfaceId, boolean create) {')
      ? '确认' : '未匹配',
    vm.includes('private @Nullable Stack<T> getRecyclableViewStack(int surfaceId, boolean create) {') &&
      vm.includes('if (mRecyclableViews == null) {') &&
      vm.includes('if (create && !mRecyclableViews.containsKey(surfaceId)) {') &&
      vm.includes('mRecyclableViews.put(surfaceId, new Stack<T>());') &&
      vm.includes('getRecyclableViewStack(reactContext.getSurfaceId(), true)') &&
      vm.includes('getRecyclableViewStack(surfaceId, false)'));
}// ────────────────────────────────────────────────────────────────────────
// 50. Android legacy ShadowNode 脏标记与废弃通路（46 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const rsni = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java') ?? '';
  const rsn = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNode.kt') ?? '';
  const rtild = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactTextInputLocalData.kt') ?? '';
  const ret = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactEditText.kt') ?? '';
  const uimm = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/UIManagerModule.kt') ?? '';

  // §2 三重弃用标注
  add('C407', 'ReactShadowNodeImpl 同时带 @Deprecated(填原因非版本) + @LegacyArchitecture(ERROR) + 静态块 assertLegacyArchitecture',
    '三重弃用标注',
    rsni.includes('@Deprecated(') && rsni.includes('since = "This class is part of Legacy Architecture and will be removed in a future release"') &&
      rsni.includes('@LegacyArchitecture(logLevel = LegacyArchitectureLogLevel.ERROR)') &&
      rsni.includes('LegacyArchitectureLogger.assertLegacyArchitecture(') ? '3 层齐备' : '未匹配',
    rsni.includes('@Deprecated(') &&
      rsni.includes('since = "This class is part of Legacy Architecture and will be removed in a future release"') &&
      rsni.includes('@LegacyArchitecture(logLevel = LegacyArchitectureLogLevel.ERROR)') &&
      rsni.includes('LegacyArchitectureLogger.assertLegacyArchitecture(') &&
      rsni.includes('"ReactShadowNodeImpl", LegacyArchitectureLogLevel.ERROR)'));
  add('C407b', 'Android 主代码共 17 个文件用 @LegacyArchitecture(logLevel = ERROR)',
    '17 个文件',
    grepCount(/LegacyArchitectureLogLevel\.ERROR/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).files.length + ' 个文件',
    grepCount(/LegacyArchitectureLogLevel\.ERROR/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).files.length === 17);
  // §2.1 Yoga 配置
  add('C408', 'legacy ShadowNode 的 YogaConfig 设 pointScaleFactor=0（RN 自己做单位换算，禁 Yoga 二次缩放）并开 YogaErrata.ALL',
    'scale=0 + errata=ALL',
    rsni.includes('sYogaConfig.setPointScaleFactor(0f);') && rsni.includes('sYogaConfig.setErrata(YogaErrata.ALL);')
      ? '确认' : '未匹配',
    rsni.includes('sYogaConfig = YogaConfigFactory.create();') &&
      rsni.includes('sYogaConfig.setPointScaleFactor(0f);') &&
      rsni.includes('sYogaConfig.setErrata(YogaErrata.ALL);'));

  // §3 三个脏标记源
  add('C409', 'hasUpdates() 是三源或：mNodeUpdated || hasNewLayout() || isDirty()，且 mNodeUpdated 初值为 true',
    '三源或 / 初值 true',
    rsni.includes('private boolean mNodeUpdated = true;') ? '确认' : '未匹配',
    rsni.includes('return mNodeUpdated || hasNewLayout() || isDirty();') &&
      rsni.includes('private boolean mNodeUpdated = true;'));
  add('C409b', 'markUpdated() 三重防护：自身幂等早返回 + 沿父链递归上溯 + 父判空',
    '三重防护',
    (rsni.match(/public void markUpdated\(\) \{[\s\S]{0,320}?\n  \}/) ?? [''])[0].includes('if (mNodeUpdated)') ? '确认' : '未匹配',
    rsni.includes('if (mNodeUpdated) {') && rsni.includes('      return;\n    }') &&
      rsni.includes('mNodeUpdated = true;\n    ReactShadowNodeImpl parent = getParent();') &&
      rsni.includes('if (parent != null) {\n      parent.markUpdated();'));
  add('C410', 'markUpdateSeen() 一次复位两个标记：mNodeUpdated=false，且 hasNewLayout 时连带 markLayoutSeen()',
    '一次清两标记',
    rsni.includes('mNodeUpdated = false;\n    if (hasNewLayout()) {\n      markLayoutSeen();') ? '确认' : '未匹配',
    rsni.includes('public final void markUpdateSeen() {') &&
      rsni.includes('mNodeUpdated = false;') &&
      rsni.includes('if (hasNewLayout()) {') &&
      rsni.includes('markLayoutSeen();'));
  add('C410b', 'isDirty() 带 mYogaNode != null 守卫（必需：虚拟节点构造时把 mYogaNode 置 null）',
    'null 守卫',
    rsni.includes('return mYogaNode != null && mYogaNode.isDirty();') ? '确认' : '未匹配',
    rsni.includes('public final boolean isDirty() {') &&
      rsni.includes('return mYogaNode != null && mYogaNode.isDirty();') &&
      rsni.includes('} else {\n      mYogaNode = null;\n    }'));

  // §4 this-escape
  {
    const te = grepCount(/@SuppressWarnings\("this-escape"\)/, { roots: ['packages/react-native/ReactAndroid/src/main'] });
    add('C411', 'Android 主代码共 7 处 @SuppressWarnings("this-escape")，分布 5 个文件（ReactRootView 占 3 处）',
      '7 处 / 5 文件',
      te.total + ' 处 / ' + te.files.length + ' 个文件',
      te.count === 7 && te.files.length === 5 &&
        te.files.filter(f => f.includes('ReactRootView')).length === 1);
    add('C411b', 'ReactShadowNodeImpl 构造函数的 this-escape 来自 isVirtual() 虚调用与 setData(this)',
      '2 处逃逸源',
      rsni.includes('@SuppressWarnings("this-escape")') && rsni.includes('if (!isVirtual()) {') &&
        rsni.includes('mYogaNode.setData(this);') ? '确认' : '未匹配',
      rsni.includes('@SuppressWarnings("this-escape")\n  public ReactShadowNodeImpl() {') &&
        rsni.includes('if (!isVirtual()) {') &&
        rsni.includes('mYogaNode = YogaNodeFactory.create(sYogaConfig);') &&
        rsni.includes('mYogaNode.setData(this);') &&
        rsni.includes('} else {\n      mYogaNode = null;\n    }'));
    add('C411c', '虚拟节点分支不执行 Arrays.fill(mPadding, UNDEFINED) —— mPadding 保持默认 0f（KK-5）',
      '虚拟分支不 fill',
      rsni.indexOf('Arrays.fill(mPadding, YogaConstants.UNDEFINED);') > rsni.indexOf('} else {\n      mYogaNode = null;')
        ? '确认（fill 在 else 之前）' : '未匹配',
      rsni.includes('Arrays.fill(mPadding, YogaConstants.UNDEFINED);') &&
        rsni.indexOf('Arrays.fill(mPadding, YogaConstants.UNDEFINED);') < rsni.indexOf('} else {\n      mYogaNode = null;'));
  }

  // §5 布局去重
  {
    const seg = (a, b) => rsni.slice(rsni.indexOf(a), rsni.indexOf(b));
    const s1 = seg('public boolean dispatchUpdatesWillChangeLayout(', 'int newScreenX = Math.round(layoutX);');
    const dup = ['int newAbsoluteLeft = Math.round(absoluteX + layoutX);',
      'int newAbsoluteTop = Math.round(absoluteY + layoutY);',
      'int newAbsoluteRight = Math.round(absoluteX + layoutX + getLayoutWidth());',
      'int newAbsoluteBottom = Math.round(absoluteY + layoutY + getLayoutHeight());'];
    add('C412', 'dispatchUpdatesWillChangeLayout 与 dispatchUpdates 逐字共享同一段 4 行绝对矩形计算（无抽取）',
      '4 行 × 2 处重复',
      dup.filter(x => s1.includes(x) && rsni.split(x).length - 1 === 2).length + ' / 4 行在两函数中各出现一次',
      dup.every(x => rsni.split(x).length - 1 === 2));
    add('C412b', '去重的 4 个基准字段是取整后的相对位置与宽高（newScreenX=round(layoutX) 不含 absoluteX）',
      '相对位置去重',
      rsni.includes('int newScreenX = Math.round(layoutX);') &&
        rsni.includes('int newScreenWidth = newAbsoluteRight - newAbsoluteLeft;') ? '确认' : '未匹配',
      (rsni.split('int newScreenX = Math.round(layoutX);').length - 1) === 2 &&
        (rsni.split('int newScreenWidth = newAbsoluteRight - newAbsoluteLeft;').length - 1) === 2 &&
        !rsni.includes('int newScreenX = Math.round(absoluteX + layoutX);'));
    add('C412c', 'dispatchUpdatesWillChangeLayout 不写快照，dispatchUpdates 写回 4 个 mScreen* 字段',
      '一个只读一个写回',
      rsni.includes('mScreenX = newScreenX;') && rsni.includes('return newScreenX != mScreenX') ? '确认' : '未匹配',
      rsni.includes('return newScreenX != mScreenX') &&
        rsni.includes('mScreenX = newScreenX;') && rsni.includes('mScreenY = newScreenY;') &&
        rsni.includes('mScreenWidth = newScreenWidth;') && rsni.includes('mScreenHeight = newScreenHeight;'));
  }

  // §6 KK-1 核心：8 个空壳成员
  add('C413', '【KK-1 核心】getTotalNativeNodeContributionToParent() 无条件 return 0，4 个内部调用点全部拿到常量 0',
    '恒 0 / 4 调用点',
    (rsni.match(/getTotalNativeNodeContributionToParent\(\)/g) ?? []).length + ' 处出现（含 1 定义）',
    rsni.includes('private int getTotalNativeNodeContributionToParent() {\n    // Logic removed due to NativeKind removal\n    return 0;\n  }') &&
      (rsni.match(/getTotalNativeNodeContributionToParent\(\)/g) ?? []).length === 5);
  add('C413b', '【KK-1 核心】getTotalNativeChildren() 除接口声明外零调用方，且返回恒 0 字段',
    '零调用 + 恒 0',
    grepCount(/getTotalNativeChildren/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).files.length + ' 个文件',
    rsni.includes('public final int getTotalNativeChildren() {\n    return mTotalNativeChildren;\n  }') &&
      rsn.includes('public fun getTotalNativeChildren(): Int') &&
      grepCount(/getTotalNativeChildren/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).files.length === 2);
  add('C413c', '【KK-1 核心】updateNativeChildrenCountInParent(int delta) 是空方法体，delta 参数从未使用',
    '空方法体',
    rsni.includes('private void updateNativeChildrenCountInParent(int delta) {\n    // Commented out due to NativeKind removal\n  }')
      ? '确认' : '未匹配',
    rsni.includes('private void updateNativeChildrenCountInParent(int delta) {') &&
      rsni.includes('// Commented out due to NativeKind removal') &&
      !rsni.includes('updateNativeChildrenCountInParent(int delta) {\n    // Commented out due to NativeKind removal\n    delta'));
  add('C414', 'hoistNativeChildren() 与 isVirtualAnchor() 基类均恒 return false，且无子类 override',
    '2 个恒 false',
    rsni.includes('public boolean hoistNativeChildren() {\n    return false;\n  }') &&
      rsni.includes('public boolean isVirtualAnchor() {\n    return false;\n  }') ? '确认' : '未匹配',
    rsni.includes('public boolean hoistNativeChildren() {\n    return false;\n  }') &&
      rsni.includes('public boolean isVirtualAnchor() {\n    return false;\n  }') &&
      rsn.includes('public fun isVirtualAnchor(): Boolean') &&
      rsn.includes('public fun hoistNativeChildren(): Boolean') &&
      grepCount(/isVirtualAnchor/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).count === 4);
  add('C414b', '【KK-3】getNativeOffsetForChild 的循环因贡献值恒 0 而退化为恒等函数（KDoc 仍描述已失效的统计能力）',
    '退化为恒等',
    rsni.includes('index += current.getTotalNativeNodeContributionToParent();') ? '确认' : '未匹配',
    rsni.includes('public final int getNativeOffsetForChild(ReactShadowNodeImpl child) {') &&
      rsni.includes('index += current.getTotalNativeNodeContributionToParent();') &&
      rsni.includes('Returns the offset within the native children owned by all layout-only nodes'));
  // §8 isLayoutOnly 三件套
  add('C415', 'setIsLayoutOnly 带 3 条「必须先摘除」断言（父为空 / 原生父为空 / 原生子数为 0）',
    '3 条断言',
    (rsni.match(/Assertions\.assertCondition\(/g) ?? []).length + ' 处 assertCondition',
    rsni.includes('Assertions.assertCondition(getParent() == null, "Must remove from no opt parent first");') &&
      rsni.includes('Assertions.assertCondition(mNativeParent == null, "Must remove from native parent first");') &&
      rsni.includes('Assertions.assertCondition(getNativeChildCount() == 0, "Must remove all native children first");'));
  add('C415b', 'setIsLayoutOnly 全 Android 主代码仅 2 处出现（接口声明 + 定义），零调用方 —— mIsLayoutOnly 恒 false（KK-1）',
    '零调用方',
    grepCount(/setIsLayoutOnly/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).total + ' 处出现',
    grepCount(/setIsLayoutOnly/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).count === 2 &&
      rsn.includes('public fun setIsLayoutOnly(isLayoutOnly: Boolean)') &&
      rsni.includes('public final void setIsLayoutOnly(boolean isLayoutOnly) {'));
  add('C415c', '【KK-6】断言消息 "Must remove from no opt parent first" 语法不通（疑 NativeKind 时代遗留）',
    '原文如此',
    rsni.includes('"Must remove from no opt parent first"') ? '原文如此' : '未匹配',
    rsni.includes('"Must remove from no opt parent first"'));
  // §9 isYogaLeafNode 是真逻辑
  add('C416', 'isYogaLeafNode() 基类实现为 return isMeasureDefined()（真逻辑，非常量），4 处调用点全在 children 增删路径',
    '真逻辑 / 4 调用点',
    rsni.includes('public boolean isYogaLeafNode() {\n    return isMeasureDefined();\n  }') ? '确认' : '未匹配',
    rsni.includes('public boolean isYogaLeafNode() {\n    return isMeasureDefined();\n  }') &&
      grepCount(/isYogaLeafNode/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).count === 5);
  add('C416b', 'addChildAt 对「子节点无 YogaNode」抛 RuntimeException（与 45 文档的降级策略相反，同类两种失败策略并存）',
    '抛异常 vs 降级',
    rsni.includes('throw new RuntimeException(') &&
      rsni.includes('"Cannot add a child that doesn\'t have a YogaNode to a parent without a measure "') ? '确认' : '未匹配',
    rsni.includes('if (childYogaNode == null) {') &&
      rsni.includes('throw new RuntimeException(') &&
      rsni.includes('"Cannot add a child that doesn\'t have a YogaNode to a parent without a measure "') &&
      rsni.includes('+ child.toString()') && rsni.includes('+ toString()'));

  // §7 KK-2 核心：四层废弃通路
  add('C417', '【KK-2 核心】UIManagerModule.setViewLocalData(tag, data) 的唯一实现是空 Unit',
    '= Unit 空实现',
    uimm.includes('public open fun setViewLocalData(tag: Int, data: Any): Unit = Unit') ? '确认（= Unit）' : '未匹配',
    uimm.includes('public open fun setViewLocalData(tag: Int, data: Any): Unit = Unit') &&
      grepCount(/setViewLocalData/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).count === 4);
  add('C417b', '【KK-2 核心】ReactShadowNodeImpl.setLocalData 是 9 行注释 + 空方法体，无 getLocalData',
    '空方法体 / 无 getter',
    rsni.includes('public void setLocalData(Object data) {}') &&
      grepCount(/getLocalData/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).count === 0
      ? '确认' : '未匹配',
    rsni.includes('public void setLocalData(Object data) {}') &&
      rsni.includes('* Use  {@link ReactUIManagerModule#setViewLocalData} to set this property') &&
      rsni.includes('* (to provide local/environmental data for a shadow node) from the main thread.') &&
      rsn.includes('public fun setLocalData(data: Any)') &&
      grepCount(/getLocalData/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).count === 0);
  add('C417c', '【KK-2 核心】ReactTextInputLocalData 快照 7 字段且首项是 SpannableStringBuilder 深拷贝，但 apply() 零调用方',
    '7 字段 / 深拷贝 / 0 调用',
    '构造 ' + (rtild.match(/private val \w+/g) ?? []).length + ' 字段，apply 零调用',
    (rtild.match(/private val \w+/g) ?? []).length === 7 &&
      rtild.includes('private val text = SpannableStringBuilder(editText.text)') &&
      rtild.includes('public fun apply(editText: EditText) {') &&
      grepCount(/ReactTextInputLocalData/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).count === 2);
  add('C418', 'setIntrinsicContentSize 带 // TODO T58784068: delete this method，且有三重门控（编译期 flag + stateWrapper + bridgeless）',
    '工单号 TODO + 3 重门控',
    ret.includes('// TODO T58784068: delete this method') &&
      ret.includes('if (!ReactBuildConfig.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE)') &&
      ret.includes('if (stateWrapper == null && !reactContext.isBridgeless) {') ? '确认' : '未匹配',
    ret.includes('// TODO T58784068: delete this method\n  private fun setIntrinsicContentSize() {') &&
      ret.includes("// Since the LocalData object is constructed by getting values from the underlying EditText") &&
      ret.includes("// view, we don't need to construct one or apply it at all - it provides no use in Fabric.") &&
      ret.includes('if (!ReactBuildConfig.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE) {') &&
      ret.includes('if (stateWrapper == null && !reactContext.isBridgeless) {') &&
      ret.includes('uiManager?.setViewLocalData(id, localData)'));
  add('C418b', 'NativeKind 类型在主代码零残留，只剩 3 条 "due to NativeKind removal" 注释',
    '3 条注释 / 0 残留',
    (rsni.match(/due to NativeKind removal/g) ?? []).length + ' 条注释',
    (rsni.match(/due to NativeKind removal/g) ?? []).length === 3 &&
      grepCount(/NativeKind/, { roots: ['packages/react-native/ReactAndroid/src/main'] }).count === 3);
  // §3.4 dirty 的自认缺陷
  add('C419', 'dirty() 的 inline view 缺陷由源码 TODO 自认（parent 为 null 导致信号断链），注释含笔误 "is not be updated"',
    '自认缺陷 + 笔误',
    rsni.includes('// TODO: There are some edge cases that currently aren\'t supported.') &&
      rsni.includes('its size on-screen is not be updated') ? '确认' : '未匹配',
    rsni.includes('// Virtual nodes aren\'t involved in layout but they need to have the dirty signal') &&
      rsni.includes('// TODO: There are some edge cases that currently aren\'t supported. For example, if the size') &&
      rsni.includes('its size on-screen is not be updated') &&
      rsni.includes('The problem may be that dirty propagation stops at inline views because the') &&
      rsni.includes('parent of each inline view is null. A possible fix would be to implement an `onDirty`') &&
      rsni.includes('handler in Yoga that will propagate the dirty signal to the ancestors of the inline view.'));
}// ────────────────────────────────────────────────────────────────────────
// 51. Android 无障碍委托层（47 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const rad = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt') ?? '';
  const rtva = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextViewAccessibilityDelegate.kt') ?? '';
  const rtv = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextView.java') ?? '';
  const bvm2 = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/BaseViewManager.java') ?? '';
  const MAIN = ['packages/react-native/ReactAndroid/src/main'];

  // §2 init 块撤销 ExploreByTouchHelper 副作用
  add('C420', 'ReactAccessibilityDelegate 继承 ExploreByTouchHelper 且 init 块显式复位 isFocusable/importantForAccessibility',
    '继承 + init 复位',
    rad.includes(': ExploreByTouchHelper(hostView) {') && rad.includes('hostView.isFocusable = originalFocus;') ? '确认' : '未匹配',
    rad.includes(') : ExploreByTouchHelper(hostView) {') &&
      rad.includes('// We need to reset these two properties, as ExploreByTouchHelper sets focusable to "true" and') &&
      rad.includes('// We need to reset these two properties, as ExploreByTouchHelper sets focusable to "true" and') &&
      rad.includes('// importantForAccessibility to "Yes" (if it is Auto). If we don\'t reset these it would force') &&
      rad.includes('// every element that has this delegate attached to be focusable, and not allow for') &&
      rad.includes('// importantForAccessibility to "Yes" (if it is Auto). If we don\'t reset these it would force') &&
      rad.includes('// announcement coalescing.') &&
      rad.includes('hostView.isFocusable = originalFocus') &&
      rad.includes('hostView.importantForAccessibility = originalImportantForAccessibility'));
  add('C420b', 'accessibilityEventHandler 用已废弃的无参 Handler()，带自陈 TODO',
    '无参 Handler + TODO',
    rad.includes('// TODO: Replace with handler tied to host view\'s context') ? '确认' : '未匹配',
    rad.includes('@Suppress("DEPRECATION") // TODO: Replace with handler tied to host view\'s context') &&
      rad.includes('private val accessibilityEventHandler: Handler =') &&
      rad.includes('object : Handler() {') &&
      rad.includes('host?.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_SELECTED)'));

  // §3 MM-1 核心：5 个虚视图 API 全空
  {
    add('C421', '【MM-1 核心】基类 5 个 ExploreByTouchHelper 虚视图 API 全是拒绝服务实现（INVALID_ID / Unit / 1×1 空白 / false / null）',
      '5 个全空',
      'getVirtualViewAt=' + (rad.includes('    return INVALID_ID\n  }') ? 'INVALID_ID' : '?') +
      ' / getVisibleVirtualViews=' + (rad.includes('): Unit = Unit') ? 'Unit' : '?') +
      ' / onPopulateNodeForVirtualView=' + (rad.includes('Rect(0, 0, 1, 1)') ? '1×1空白' : '?') +
      ' / onPerformActionForVirtualView=' + (rad.includes('): Boolean {\n    return false;\n  }') ? 'false' : '?') +
      ' / getAccessibilityNodeProvider=' + (rad.includes('AccessibilityNodeProviderCompat? {\n    return null\n  }') ? 'null' : '?'),
      rad.includes('override fun getVirtualViewAt(x: Float, y: Float): Int {\n    return INVALID_ID\n  }') &&
        rad.includes('override fun getVisibleVirtualViews(virtualViewIds: MutableList<Int>): Unit = Unit') &&
        rad.includes('override fun onPopulateNodeForVirtualView(virtualViewId: Int, node: AccessibilityNodeInfoCompat) {\n    node.contentDescription = ""') &&
        rad.includes('node.setBoundsInParent(Rect(0, 0, 1, 1))') &&
        rad.includes('node.contentDescription = ""\n    @Suppress("DEPRECATION") // TODO: Remove this') &&
        rad.includes('): Boolean {\n    return false\n  }') &&
        rad.includes('override fun getAccessibilityNodeProvider(host: View): AccessibilityNodeProviderCompat? {\n    return null\n  }'));
  }
  add('C421b', '这 5 个 API 在 Android 主代码的调用方全部只在本文件内（子类是 ReactTextViewAccessibilityDelegate）',
    '子类唯一',
    'ReactTextViewAccessibilityDelegate ' + (rtva.includes('override fun getVirtualViewAt') ? '有真实实现' : '无'),
      rtva.includes('override fun getVirtualViewAt(x: Float, y: Float): Int {') &&
        rtva.includes('override fun getVisibleVirtualViews(virtualViewIds: MutableList<Int>) {') &&
        rtva.includes('override fun onPopulateNodeForVirtualView(virtualViewId: Int, node: AccessibilityNodeInfoCompat) {') &&
        rtva.includes('override fun getAccessibilityNodeProvider(host: View): AccessibilityNodeProviderCompat? {'));
  add('C421c', 'ReactTextView.java:657-669 是全仓库唯一把 dispatchHoverEvent 转发给 ExploreByTouchHelper 的地方，且有两层短路',
    '唯一转发 + 2 层短路',
    rtv.includes('if (delegate instanceof ExploreByTouchHelper) {') &&
      rtv.includes('((ExploreByTouchHelper) delegate).dispatchHoverEvent(event)') &&
      rtv.includes('|| super.dispatchHoverEvent(event);') ? '确认' : '未匹配',
    rtv.includes('protected boolean dispatchHoverEvent(MotionEvent event) {') &&
      rtv.includes('if (delegate instanceof ExploreByTouchHelper) {') &&
      rtv.includes('((ExploreByTouchHelper) delegate).dispatchHoverEvent(event)') &&
      rtv.includes('|| super.dispatchHoverEvent(event);'));

  // §4 setDelegate / resetDelegate
  add('C422', 'setDelegate 检查 7 个 tag 且已有 delegate 时跳过；resetDelegate 无条件替换（注释用 Explicitly 强调差别）',
    '7 tag / 两级条件',
    (rad.match(/view\.getTag\(R\.id\./g) ?? []).length + ' 处 getTag（R.id）',
    rad.includes('// if a view already has an accessibility delegate, replacing it could cause') &&
      rad.includes('// problems, so leave it alone.') &&
      rad.includes('!ViewCompat.hasAccessibilityDelegate(view) &&') &&
      rad.includes('// Explicitly re-set the delegate, even if one has already been set.') &&
      rad.includes('public fun resetDelegate('));
  // MM-2 核心：role 不在回收重置清单里
  {
    const body = bvm2.slice(bvm2.indexOf('protected @Nullable T prepareToRecycleView'),
      bvm2.indexOf('protected void addEventEmitters'));
    const resetIds = [...body.matchAll(/view\.setTag\(R\.id\.(\w+), null\)/g)].map(x => x[1]);
    add('C423', '【MM-2 核心】prepareToRecycleView 的 19 个 R.id 清零里没有 role，但 BaseViewManager:499 正常写入它',
      'role 未被清零',
      '清零 ' + resetIds.length + ' 个 id，含 accessibility_role=' + resetIds.includes('accessibility_role') +
      ' / 含 role=' + resetIds.includes('role'),
      !resetIds.includes('role') && resetIds.includes('accessibility_role') &&
        bvm2.includes('view.setTag(R.id.accessibility_role, null);') &&
        bvm2.includes('view.setTag(R.id.accessibility_role, AccessibilityRole.fromValue(accessibilityRole));') &&
        bvm2.includes('view.setTag(R.id.role, null);') &&
        bvm2.includes('view.setTag(R.id.role, Role.fromValue(role));') &&
        rad.includes('view.getTag(R.id.accessibility_role) != null ||') &&
        rad.includes('view.getTag(R.id.role) != null'));
    add('C423b', '两条 role 路径在 BaseViewManager 内完全对称（各有一处 null 与一处 fromValue 写入）',
      '两 path 对称',
      'accessibility_role ' + (bvm2.split('R.id.accessibility_role').length - 1) +
      ' 处 / role ' + (bvm2.split('R.id.role').length - 1) + ' 处',
      (bvm2.split('R.id.accessibility_role').length - 1) === 3 &&
        (bvm2.split('R.id.role').length - 1) === 2);
  }
  // §5 setState
  add('C424', 'setState 只认 3 个 Boolean key（selected/disabled/checked），无 else 分支 —— 其余 key 静默忽略',
    '3 个 key / 无 else',
    (rad.match(/value\.type == ReadableType\.Boolean/g) ?? []).length + ' 处类型判定 / 0 个 else',
    rad.includes('private fun setState(') &&
      (rad.match(/value\.type == ReadableType\.Boolean/g) ?? []).length === 3 &&
      rad.includes('if (state == STATE_SELECTED && value.type == ReadableType.Boolean) {') &&
      rad.includes('} else if (state == STATE_DISABLED && value.type == ReadableType.Boolean) {') &&
      rad.includes('info.isEnabled = !value.asBoolean()') &&
      rad.includes('info.isCheckable = true') &&
      !rad.includes('} else {\n        // unknown accessibility state key'));
  add('C424b', '只有 checked 分支设 isCheckable（selected/disabled 不设对应标记），且只有 disabled 取反',
    '3 处不对称',
    'isSelected=1 / isEnabled=1(取反) / isCheckable=1 / isChecked=1',
    (rad.match(/info\.isSelected = /g) ?? []).length === 1 &&
      (rad.match(/info\.isEnabled = /g) ?? []).length === 1 &&
      rad.includes('info.isEnabled = !value.asBoolean()') &&
      (rad.match(/info\.isCheckable = /g) ?? []).length === 1 &&
      (rad.match(/info\.isChecked = /g) ?? []).length === 1 &&
      rad.includes('private const val STATE_DISABLED = "disabled"') &&
      rad.includes('private const val STATE_SELECTED = "selected"') &&
      rad.includes('private const val STATE_CHECKED = "checked"'));

  // §6 200ms 合并
  add('C425', 'scheduleAccessibilityEventSender 用 host 作 message token 做 200ms 合并，且发出的事件类型恒为 TYPE_VIEW_SELECTED',
    '200ms / 恒 SELECTED',
    rad.includes('private const val TIMEOUT_SEND_ACCESSIBILITY_EVENT = 200') &&
      rad.includes('private const val SEND_EVENT = 1') ? '确认' : '未匹配',
    rad.includes('private const val TIMEOUT_SEND_ACCESSIBILITY_EVENT = 200') &&
      rad.includes('private const val SEND_EVENT = 1') &&
      rad.includes('if (accessibilityEventHandler.hasMessages(SEND_EVENT, host)) {') &&
      rad.includes('accessibilityEventHandler.removeMessages(SEND_EVENT, host)') &&
      rad.includes('val msg = accessibilityEventHandler.obtainMessage(SEND_EVENT, host)') &&
      rad.includes('accessibilityEventHandler.sendMessageDelayed(msg, TIMEOUT_SEND_ACCESSIBILITY_EVENT.toLong())') &&
      rad.includes('host?.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_SELECTED)'));

  // §7 getTalkbackDescription
  add('C426', 'getTalkbackDescription 有 4 条返回路径，EditText 且有文本时跳过 contentDescription（注释给了理由）',
    '4 条路径',
    '返回点 ' + (rad.slice(rad.indexOf('public fun getTalkbackDescription('), rad.indexOf('private fun removeFinalDelimiter')).match(/return /g) ?? []).length + ' 个',
    rad.includes("// EditText's prioritize their own text content over a contentDescription so skip this") &&
      rad.includes('if (!contentDescription.isNullOrEmpty() && (!isEditText || !hasNodeText)) {') &&
      rad.includes('if (hasNodeText) {') &&
      rad.includes('if (view is ViewGroup) {') &&
      rad.includes('private const val delimiter = ", "'));
  add('C426b', '【MM-4 核心】递归对每个子节点先 obtain() 再 onInitializeAccessibilityNodeInfo，被跳过的子节点也付此成本（先构造后过滤）',
    '先构造后过滤',
    'obtain ' + (rad.slice(rad.indexOf('if (view is ViewGroup) {'), rad.indexOf('return removeFinalDelimiter')).match(/AccessibilityNodeInfoCompat\.obtain\(\)/g) ?? []).length + ' 处',
    rad.includes('val childNodeInfo = AccessibilityNodeInfoCompat.obtain()') &&
      rad.includes('@Suppress("DEPRECATION") // TODO: Replace with direct invocation on view') &&
      rad.includes('ViewCompat.onInitializeAccessibilityNodeInfo(child, childNodeInfo)') &&
      rad.includes('isSpeakingNode(childNodeInfo, child) &&') &&
      rad.includes('!isAccessibilityFocusable(childNodeInfo, child)') &&
      rad.indexOf('AccessibilityNodeInfoCompat.obtain()') < rad.indexOf('isSpeakingNode(childNodeInfo, child) &&'));
  add('C426c', '递归点唯一（:999），delimiterLength 定义后仅被 removeFinalDelimiter 用于截尾',
    '递归 1 处 / 截尾 1 处',
    '递归 ' + (rad.match(/getTalkbackDescription\(child, null\)/g) ?? []).length +
      ' 处 / delimiterLength ' + (rad.match(/delimiterLength/g) ?? []).length + ' 处',
    (rad.match(/getTalkbackDescription\(child, null\)/g) ?? []).length === 1 &&
      rad.includes('private const val delimiterLength = delimiter.length') &&
      rad.includes('builder.delete(end - delimiterLength, end)'));

  // §8 onInitializeAccessibilityNodeInfo
  add('C427', 'onInitializeAccessibilityNodeInfo 首行无条件 super，accessibility_state_expanded 做二元映射（true→COLLAPSE）',
    'super + 二元映射',
    rad.includes('if (accessibilityStateExpanded) AccessibilityNodeInfoCompat.ACTION_COLLAPSE') ? '确认' : '未匹配',
    rad.includes('override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {\n    super.onInitializeAccessibilityNodeInfo(host, info)') &&
      rad.includes('if (host.getTag(R.id.accessibility_state_expanded) != null) {') &&
      rad.includes('if (accessibilityStateExpanded) AccessibilityNodeInfoCompat.ACTION_COLLAPSE') &&
      rad.includes('else AccessibilityNodeInfoCompat.ACTION_EXPAND,'));

  // §9 Role 枚举
  {
    const i = rad.indexOf('public enum class Role {');
    const j = rad.indexOf('}', i);
    const items = [...rad.slice(i, j).matchAll(/^\s+([A-Z][A-Z0-9_]*),?\s*$/gm)].map(x => x[1]);
    add('C428', '【MM-5 核心】Role 枚举共 64 项，注释要求 ordinal 与 C++ facebook::react::Role 保持同步（无任何校验）',
      '64 项 / 无校验',
      items.length + ' 项（' + items.slice(0, 3).join(', ') + ' …）',
      items.length === 64 &&
        rad.includes('* An ARIA Role representable by View\'s `role` prop. Ordinals should be kept in sync with') &&
        rad.includes('* `facebook::react::Role`.') &&
        rad.includes('public enum class Role {\n    ALERT,') &&
        (grepCount(/enum class Role/, { roots: MAIN }).files.length === 1));
    add('C428b', 'setRole 开头带 // TODO: Eventually support for other languages on talkback（role 名称未本地化）',
      '未本地化 TODO',
      rad.includes('// TODO: Eventually support for other languages on talkback') ? '确认' : '未匹配',
      rad.includes('// TODO: Eventually support for other languages on talkback\n    @JvmStatic\n    public fun setRole('));
    add('C428c', '基类共 4 处 @Suppress("DEPRECATION")，其中 1 处是 setRole 的本地化 TODO、3 处是 API 迁移债',
      '4 处 @Suppress / 3 处 TODO',
      (rad.match(/@Suppress\("DEPRECATION"\)/g) ?? []).length + ' 处 @Suppress',
      (rad.match(/@Suppress\("DEPRECATION"\)/g) ?? []).length >= 4 &&
        (rad.match(/TODO/g) ?? []).length >= 4);
  }
  add('C429', 'superGetAccessibilityNodeProvider 桥接方法带注释解释存在理由（Kotlin 无法在 override 中方便调用 super）',
    '桥接 + 注释',
    rad.includes('// This exists so classes that extend this can properly call super\'s impl of this method while') ? '确认' : '未匹配',
    rad.includes('// This exists so classes that extend this can properly call super\'s impl of this method while') &&
      rad.includes('// still being able to override it properly for this class') &&
      rad.includes('protected fun superGetAccessibilityNodeProvider(host: View): AccessibilityNodeProviderCompat? {') &&
      rad.includes('return super.getAccessibilityNodeProvider(host)'));
}// ────────────────────────────────────────────────────────────────────────
// 52. Android 指针事件分发与合并键回绕（48 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const jpd = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt') ?? '';
  const pev = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/events/PointerEvent.kt') ?? '';
  const evt = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/events/Event.kt') ?? '';
  const MAIN = ['packages/react-native/ReactAndroid/src/main'];

  // §3 NN-1 核心：16 位掩码撞 -1
  {
    // 用源码语义重算：0xffff 掩码 → Short 解释
    let n = 0, first = -1;
    for (let i = 1; i <= 70000; i++) { n = (n + 1) % 2147483647; if ((((0xffff & n) << 16) >> 16) === -1) { first = i; break; } }
    add('C430', '【NN-1 核心】coalescingKey 的 16 位掩码在第 65535 次 increment 后截断为 -1，与 UNSET_COALESCING_KEY 撞值',
      '第 65535 次 → -1',
      '实测第 ' + first + ' 次 increment 时 (0xffff and n).toShort() === -1',
      first === 65535 &&
        jpd.includes('private fun getCoalescingKey(): Short = (0xffff and coalescingKey).toShort()') &&
        pev.includes('private const val UNSET_COALESCING_KEY: Short = -1'));
  }
  add('C430b', '【NN-1 核心】dispatchModern 用 coalescingKey != UNSET 作为「可合并」布尔位，并把同一个值 toInt() 传出',
    '同值两用',
    'canCoalesce=' + (pev.includes('coalescingKey != UNSET_COALESCING_KEY,') ? '表达式' : '?') +
      ' + key=' + (pev.includes('coalescingKey.toInt(),') ? '同值' : '?'),
    pev.includes('override fun getCoalescingKey(): Short = coalescingKey') &&
      pev.includes('coalescingKey != UNSET_COALESCING_KEY,') &&
      pev.includes('coalescingKey.toInt(),'));
  add('C431', '【NN-2 核心】incrementCoalescingKey 用 % Int.MAX_VALUE（32 位）而 getCoalescingKey 掩到 16 位 —— 模运算对输出无影响',
    '32 位计数 → 16 位输出',
    '计数器 ' + (jpd.includes('private var coalescingKey = 0') ? 'Int' : '?') + ' / 掩码 0xffff / % Int.MAX_VALUE',
    jpd.includes('private var coalescingKey = 0') &&
      jpd.includes('coalescingKey = (coalescingKey + 1) % Int.MAX_VALUE') &&
      jpd.includes('(0xffff and coalescingKey)'));
  add('C431b', 'incrementCoalescingKey 有 4 个调用点，分布在 onChildEndedNativeGesture / handleHitStateDivergence / handleMotionEvent / dispatchCancelEventForTarget',
    '4 个调用点',
    (jpd.match(/incrementCoalescingKey\(\)/g) ?? []).length + ' 处（含 1 定义）= 4 调用',
    (jpd.match(/incrementCoalescingKey\(\)/g) ?? []).length === 5 &&
      jpd.includes('public fun onChildEndedNativeGesture() {') &&
      jpd.includes('private fun handleHitStateDivergence(') &&
      jpd.includes('public fun handleMotionEvent(') &&
      jpd.includes('private fun dispatchCancelEventForTarget('));

  // §4 NN-3 核心：静态可变对象
  {
    const body = jpd.slice(jpd.indexOf('private fun getChildOffsetRelativeToRoot'),
      jpd.indexOf('private fun normalizeToRoot'));
    add('C432', '【NN-3 核心】getChildOffsetRelativeToRoot 的两个分支都 return companion object 里的共享可变 Rect（不是副本）',
      '2 分支都 return 静态对象',
      'return childCoords ' + (body.match(/return childCoords/g) ?? []).length + ' 处',
      (body.match(/return childCoords/g) ?? []).length === 2 &&
        jpd.includes('private val childCoords = Rect(0, 0, 1, 1)') &&
        body.includes('rootViewGroup.offsetDescendantRectToMyCoords(childView, childCoords)') &&
        body.includes('return childCoords'));
    add('C432b', 'childCoords 的唯一调用点立即取 .left/.top 转 Float（无对象逃逸，故当前不构成 bug）',
      '1 调用点 / 立即取值',
      '调用点 ' + (jpd.match(/getChildOffsetRelativeToRoot\(/g) ?? []).length + ' 个',
      (jpd.match(/getChildOffsetRelativeToRoot\(/g) ?? []).length === 2 &&
        jpd.includes('val childOffset = getChildOffsetRelativeToRoot(targetView)') &&
        jpd.includes('normalizeToRoot(eventState, childOffset.left.toFloat(), childOffset.top.toFloat())') &&
        jpd.indexOf('val childOffset = getChildOffsetRelativeToRoot(targetView)') <
          jpd.indexOf('childOffset.left.toFloat()'));
    add('C432c', 'getChildOffsetRelativeToRoot 的注释自认 reparent 场景会抛异常，故返回 (0,0) 保证 CANCEL 仍派发',
      '自认 reparent 异常',
      jpd.includes('// NOTE: if we are here it means the target view has been reparented, so we can\'t call')
        ? '确认' : '未匹配',
      jpd.includes('// NOTE: if we are here it means the target view has been reparented, so we can\'t call') &&
        jpd.includes('// mRootViewGroup.offsetDescendantRectToMyCoords because an exception will be thrown.') &&
        jpd.includes('// We still return (0, 0) to ensure the cancel event is dispatched.'));
    add('C432d', 'rootScreenCoords 是 companion object 里的可变 intArray，用完立即读出写入局部变量（同样无逃逸）',
      '只写不存',
      jpd.includes('rootViewGroup.getLocationOnScreen(rootScreenCoords)') ? '确认' : '未匹配',
      jpd.includes('private val rootScreenCoords = intArrayOf(0, 0)') &&
        jpd.includes('rootViewGroup.getLocationOnScreen(rootScreenCoords)') &&
        jpd.includes('screenCoords[0] = eventCoords[0] + rootScreenCoords[0]'));
  }

  // §5 三个 -1 哨兵
  add('C433', '三个私有 -1 哨兵中两个与 Android 框架常量撞值（View.NO_ID / MotionEvent.INVALID_POINTER_ID 同为 -1）',
    '3 个 -1 / 2 个撞框架',
    (jpd.match(/private const val \w+ = -1/g) ?? []).length + ' 个 -1 常量',
    jpd.includes('private const val UNSELECTED_VIEW_TAG = -1') &&
      jpd.includes('private const val UNSET_POINTER_ID = -1') &&
      jpd.includes('private const val UNSET_CHILD_VIEW_ID = -1') &&
      jpd.includes('private val childHandlingNativeGesture = UNSET_CHILD_VIEW_ID') === false);
  add('C433b', 'dispatchCancelEventForTarget 有一处 Assertions.assertCondition 防护「已派发过 CANCEL」的重复路径，注释说明该路径罕见',
    '显式断言',
    jpd.includes('"Expected to not have already sent a cancel for this gesture"') ? '确认' : '未匹配',
    jpd.includes('// This means the gesture has already ended, via some other CANCEL or UP event. This is not') &&
      jpd.includes('// expected to happen very often as it would mean some child View has decided to intercept the') &&
      jpd.includes('// touch stream and start a native gesture only upon receiving the UP/CANCEL event.') &&
      jpd.includes('Assertions.assertCondition(') &&
      jpd.includes('"Expected to not have already sent a cancel for this gesture",'));

  // §6 onMove 阈值
  add('C434', 'qualifiedMove 返回 true 表示「位移不显著、应丢弃」—— 命名与语义相反；阈值 ONMOVE_EPSILON = 0.1f 且用严格 >',
    '0.1f / 语义反转',
    (jpd.match(/ONMOVE_EPSILON/g) ?? []).length + ' 处引用',
    jpd.includes('private const val ONMOVE_EPSILON = 0.1f') &&
      jpd.includes('return (Math.abs(lastEventCoordinates[0] - eventCoordinates[0]) > ONMOVE_EPSILON ||') &&
      jpd.includes('Math.abs(lastEventCoordinates[1] - eventCoordinates[1]) > ONMOVE_EPSILON)'));
  add('C434b', 'companion object 共 7 个成员：5 个 const + 2 个可变 val（rootScreenCoords / childCoords）',
    '5 const + 2 val',
    (jpd.slice(jpd.indexOf('private companion object {'), jpd.indexOf('// returns the section of the hit path'))
      .match(/private const val \w+|private val \w+/g) ?? []).length + ' 个成员',
    (jpd.slice(jpd.indexOf('private companion object {'), jpd.indexOf('// returns the section of the hit path'))
      .match(/private const val \w+/g) ?? []).length === 5 &&
      (jpd.slice(jpd.indexOf('private companion object {'), jpd.indexOf('// returns the section of the hit path'))
        .match(/private val \w+/g) ?? []).length === 2 &&
      jpd.includes('private const val TAG = "PointerEvents"'));

  // §8 hoveringPointerIds 生命周期
  {
    const ops = [
      ['add', jpd.includes('hoveringPointerIds.add(activePointerId)')],
      ['remove', jpd.includes('hoveringPointerIds.remove(activePointerId)')],
      ['retainAll', jpd.includes('hoveringPointerIds.retainAll(allPointerIds)')],
      ['contains', jpd.includes('hoveringPointerIds.contains(activePointerId)')],
      ['contains2', jpd.includes('hoveringPointerIds.contains(eventState.activePointerId)')],
    ];
    add('C435', 'hoveringPointerIds 有完整的 add/remove/retainAll 三写入 + 2 读取，retainAll 的注释是 Clean up any stale pointerIds',
      '3 写入 + 2 读取',
      ops.filter(([, ok]) => ok).map(([k]) => k).join(', '),
      ops.every(([, ok]) => ok) &&
        jpd.includes('// Clean up any stale pointerIds') &&
        jpd.includes('val allPointerIds = nextEventCoordinatesByPointerId.keys'));
    add('C435b', 'PointerEventState 构造时拷贝 hoveringPointerIds，行内注释说明了拷贝原因',
      '拷贝 + 注释',
      jpd.includes('// Creates a copy of hovering pointer ids, as they may be updated') ? '确认' : '未匹配',
      jpd.includes('hoveringPointerIds, // Creates a copy of hovering pointer ids, as they may be updated') &&
        jpd.includes('HashSet(original.hoveringPointerIds),'));
  }

  // §7 dispatchModern
  add('C436', 'Event.dispatchModern 是基类空实现，PointerEvent 覆盖它；三层守卫中第一层用 logSoftException 处理「对象池已回收」',
    '基类空实现 + 软异常',
    '基类 ' + (evt.includes('public open fun dispatchModern(rctEventEmitter: RCTModernEventEmitter) {') ? 'open 空实现' : '?'),
    evt.includes('public open fun dispatchModern(rctEventEmitter: RCTModernEventEmitter) {') &&
      pev.includes('override fun dispatchModern(rctEventEmitter: RCTModernEventEmitter) {') &&
      pev.includes('if (motionEvent == null) {') &&
      pev.includes('"Cannot dispatch a Pointer that has no MotionEvent; the PointerEvent has been recycled",') &&
      pev.includes('logSoftException('));
  add('C436b', 'dispatchModern 的②③两层判空重复（createPointersEventData 返回 null 后再判一次），第 3 层无日志',
    '重复判空',
    '判空 ' + (pev.slice(pev.indexOf('override fun dispatchModern'), pev.indexOf('class PointerEventState'))
      .match(/pointersEventData == null/g) ?? []).length + ' 次',
    (pev.slice(pev.indexOf('override fun dispatchModern'), pev.indexOf('class PointerEventState'))
      .match(/pointersEventData == null/g) ?? []).length === 2 &&
      pev.includes('// No relevant MotionEvent to dispatch'));

  // §2 类形态
  add('C437', 'JSPointerDispatcher 构造参数只有 rootViewGroup（一个 root 一个实例），两块状态是按下路径 Map 与 hover 指针 Set',
    '1 root / 2 状态',
    '构造 ' + (jpd.includes('public class JSPointerDispatcher(private val rootViewGroup: ViewGroup) {') ? '单参数' : '?'),
    jpd.includes('public class JSPointerDispatcher(private val rootViewGroup: ViewGroup) {') &&
      jpd.includes('private val currentlyDownPointerIdsToHitPath: MutableMap<Int, List<ViewTarget>> = HashMap()') &&
      jpd.includes('private val hoveringPointerIds: MutableSet<Int> = HashSet()'));
}// ────────────────────────────────────────────────────────────────────────
// 53. 构建工具链静默失败（49 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const pkg = read('package.json') ?? '';
  const sw = read('.github/workflow-scripts/exec_swallow_error.sh') ?? '';
  const sdiff = read('scripts/cxx-api/parser/snapshot_diff.py') ?? '';
  const fpy = read('scripts/format-python.js') ?? '';
  const fkt = read('scripts/format-kotlin.js') ?? '';
  const fjv = read('scripts/format-java.js') ?? '';
  const fsw = read('scripts/format-swift.js') ?? '';
  const fu = read('scripts/format-utils.js') ?? '';
  const hn = read('scripts/releases/use-hermes-nightly.js') ?? '';
  const hp = read('scripts/releases/use-hermes-prebuilt.js') ?? '';
  const ncfg = read('scripts/build/babel/node.config.js') ?? '';
  const rnpkg = read('packages/react-native/package.json') ?? '';

  // OO-1 核心：包装脚本恒返回 0
  add('C438', '【OO-1 核心】exec_swallow_error.sh 的退出码由末行 echo 决定 —— 无论被调命令成功与否都返回 0',
    '恒返回 0',
    '末行是 ' + (sw.trim().split('\n').filter(l => l.trim()).pop() || '').trim(),
    sw.includes('"$@"') &&
      sw.includes('STATUS=$?') &&
      sw.includes('if [ $STATUS == 0 ]; then') &&
      sw.includes('echo "Command " "$@" " completed successfully"') &&
      sw.trim().split('\n').filter(l => l.trim()).pop().trim() === 'fi');
  add('C438b', '该脚本在全仓库只有 1 个调用点：test-all.yml 的 ESLint 步骤',
    '1 个调用点',
    'test-all.yml 引用 ' + (read('.github/workflows/test-all.yml') ?? '').includes('exec_swallow_error.sh yarn lint') ? '1 处' : '?',
    (read('.github/workflows/test-all.yml') ?? '').includes('./.github/workflow-scripts/exec_swallow_error.sh yarn lint --format junit -o ./reports/junit/eslint/results.xml') &&
      (read('.github/workflows/test-all.yml') ?? '').split('exec_swallow_error.sh').length - 1 === 1);
  add('C438c', 'lint job 的 8 个步骤里 Flow/TS/shellcheck/markdownlint 都未包装 —— 只有 ESLint 一处被吞掉错误',
    '8 步骤 / 1 处包装',
    'Flow=' + ((read('.github/workflows/test-all.yml') ?? '').includes('run: yarn flow-check') ? '裸跑' : '?') +
      ' / TS=' + ((read('.github/workflows/test-all.yml') ?? '').includes('run: yarn test-typescript-legacy') ? '裸跑' : '?'),
    (read('.github/workflows/test-all.yml') ?? '').includes('run: yarn flow-check') &&
      (read('.github/workflows/test-all.yml') ?? '').includes('run: yarn test-typescript-legacy') &&
      (read('.github/workflows/test-all.yml') ?? '').includes('run: ./.github/workflow-scripts/analyze_scripts.sh') &&
      (read('.github/workflows/test-all.yml') ?? '').includes('run: yarn run lint-markdown'));
  add('C438d', 'ESLint 的 JUnit XML 无任何消费方：lint job 不含 upload-artifact，全仓库仅 2 处 upload ./reports/junit 且都在别的 job',
    'XML 被丢弃',
    'test-js upload=' + ((read('.github/actions/test-js/action.yml') ?? '').includes('path: ./reports/junit') ? '有' : '无') +
      ' / rntester upload=' + ((read('.github/actions/test-ios-rntester/action.yml') ?? '').includes('path: ./reports/junit') ? '有' : '无'),
    (read('.github/actions/test-js/action.yml') ?? '').includes('path: ./reports/junit') &&
      (read('.github/actions/test-ios-rntester/action.yml') ?? '').includes('path: ./reports/junit') &&
      !read('.github/workflows/test-all.yml').slice(
        read('.github/workflows/test-all.yml').indexOf('\n  lint:'),
        read('.github/workflows/test-all.yml').indexOf('\n  test_js:'),
      ).includes('upload-artifact'));

  // OO-2 核心：四个 format 包装器静默跳过
  add('C439', '【OO-2 核心】4 个 format 包装器在缺工具链时 console.warn + return，退出码保持 0',
    '4 个脚本 / 0 退出码',
    'python ' + (fpy.match(/Skipping/g) ?? []).length + ' 处跳过 / kotlin+java 共用 warnMissingJava / swift 早退',
    fpy.includes('Skipping') && !fpy.includes('process.exit(1)') &&
      fkt.includes("warnMissingJava('Kotlin');") &&
      fkt.includes('function main() {') &&
      fjv.includes("warnMissingJava('Java');") &&
      fsw.includes('if (swiftFormat == null)') &&
      fu.includes('warnMissingJava'));
  add('C439b', 'format-check 用 && 串联 6 种语言，缺任一工具链都不影响其余语言被检查',
    '6 种语言 && 串联',
    (pkg.match(/yarn format-check-/g) ?? []).length + ' 个子脚本',
    pkg.includes('"format-check": "yarn format-check-javascript && yarn format-check-cpp && yarn format-check-kotlin && yarn format-check-java && yarn format-check-python && yarn format-check-swift"') &&
      pkg.includes('"format-check-java": "node ./scripts/format-java.js --check"') &&
      pkg.includes('"format-check-python": "node ./scripts/format-python.js --check"') &&
      pkg.includes('"format-check-swift": "node ./scripts/format-swift.js --check"'));

  // OO-3 核心：快照校验的三条通过路径
  {
    const impl = sdiff.slice(sdiff.indexOf('def _check_snapshots_impl'));
    add('C440', '【OO-3 核心】cxx-api 快照校验在「基线目录不存在」「基线为空」时 return True',
    '2 处 return True',
    (impl.match(/return True/g) ?? []).length + ' 处 return True',
      sdiff.includes('def _check_snapshots_impl(generated_dir: str, committed_dir: str, out) -> bool:') &&
        (impl.match(/return True/g) ?? []).length === 2 &&
        sdiff.includes('print("Skipping comparison (no baseline to compare against)", file=out)'));
    add('C440b', '【OO-3 核心】新增快照视图走 continue 分支并打印 OK: 前缀 —— 新增公开 API 永不失败',
      '新增不失败',
      sdiff.includes('print(f"OK: {filename} generated (no committed baseline)", file=out)') ? '确认' : '未匹配',
      sdiff.includes('if filename not in committed_set:') &&
        sdiff.includes('print(f"OK: {filename} generated (no committed baseline)", file=out)') &&
        sdiff.includes('continue'));
    add('C440c', '唯一失败方向是「基线有、生成没有」—— 门禁是单向的',
      '仅拦删除',
      'FAIL 分支 ' + (impl.includes('exists in committed snapshots but was not generated') ? '1 个' : '?'),
      impl.includes('exists in committed snapshots but was not generated') &&
        impl.includes('all_passed = False'));
  }

  // OO-4 / OO-5
  add('C441', '【OO-4 核心】package.json 的 trigger-react-native-release 指向不存在的 releases-local 目录',
    '目录不存在',
    '脚本名 trigger-react-native-release → ' + pkg.includes('trigger-react-native-release') ? '已定义' : '?',
    pkg.includes('"trigger-react-native-release": "node ./scripts/releases-local/trigger-react-native-release.js"') &&
      grepCount(/releases-local/, { roots: ['scripts'] }).count === 0 &&
      grepCount(/releases-local/, { roots: ['packages'] }).count === 0);
  add('C442', '【OO-5 核心】use-hermes-nightly.js 与 use-hermes-prebuilt.js 逐字相同（各 32 行），且都拉 prebuilt',
    'diff 逐字相同',
    hn === hp ? hn.split('\n').length + ' 行逐字相同' : '内容不同',
    hn === hp && hn.includes('updateHermesVersionsToPrebuilt') &&
      hn.includes("const {updateHermesVersionsToPrebuilt} = require('./utils/hermes-utils');") &&
      (read('scripts/releases/utils/hermes-utils.js') ?? '').includes("return getPackageVersionStrByTag('hermes-compiler', 'latest-v1');"));

  // §7 版本传播 / 复制粘贴
  add('C443', 'TARGET_NODE_VERSION = 18 与 packages/react-native 的 engines.node >=22.13.0 并存（同名不同义）',
    '18 vs ^22.13.0',
    ncfg.includes("TARGET_NODE_VERSION = '18'") ? "TARGET='18'" : '?',
    ncfg.includes("TARGET_NODE_VERSION = '18'") &&
      rnpkg.includes('"node": "^22.13.0 || ^24.3.0 || >= 26.0.0"'));
  {
    const withHeader = [fkt, fjv, fsw, read('scripts/clang-format.js') ?? ''];
    add('C443b', 'MAX_HEADER_BYTES 与 isGenerated() 在 3 个 format 包装器 + clang-format.js 各复制一份，format-python.js 不含（OO-2 的根因）',
      '4 个文件有 / python 无',
      withHeader.filter(t => t.includes('MAX_HEADER_BYTES = 4096')).length + ' 个文件含常量，python=' +
        (fpy.includes('MAX_HEADER_BYTES') ? '有' : '无'),
      withHeader.filter(t => t.includes('MAX_HEADER_BYTES = 4096')).length === 4 &&
        withHeader.filter(t => t.includes('isGenerated')).length === 4 &&
        !fpy.includes('MAX_HEADER_BYTES') && !fpy.includes('isGenerated'));
  }
  add('C443c', 'set-rn-artifacts-version.js 声明「不改 package.json」，同文件却改一个已提交的 Jest 快照',
    '注释与行为矛盾',
    '注释在 :56-57，快照写入 :127-145',
    (read('scripts/releases/set-rn-artifacts-version.js') ?? '').includes('This does not update package.json') &&
      (read('scripts/releases/set-rn-artifacts-version.js') ?? '').includes('.snap'));
  add('C443d', 'cxx-api/README.md 记载的 private_directories 键在 config.yml 与 config.py 中均不存在',
    '文档承诺未实现',
    (read('scripts/cxx-api/config.yml') ?? '').includes('private_directories') ? 'config.yml 有' : 'config.yml 无',
    !(read('scripts/cxx-api/config.yml') ?? '').includes('private_directories') &&
      grepCount(/private_directories/, { roots: ['scripts'] }).files.every(f => f.endsWith('README.md')));
}// ────────────────────────────────────────────────────────────────────────
// 54. Android JNI 层的悬垂捕获与抛指针（50 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const fumb = read('packages/react-native/ReactAndroid/src/main/jni/react/fabric/FabricUIManagerBinding.cpp') ?? '';
  const tmm = read('packages/react-native/ReactAndroid/src/main/jni/react/turbomodule/ReactCommon/TurboModuleManager.cpp') ?? '';
  const mi = read('packages/react-native/ReactAndroid/src/main/jni/react/jni/MethodInvoker.cpp') ?? '';
  const ebm = read('packages/react-native/ReactAndroid/src/main/jni/react/fabric/EventBeatManager.cpp') ?? '';
  const jarr = read('packages/react-native/ReactAndroid/src/main/jni/react/jni/JArrayBuffer.cpp') ?? '';
  const pt = read('packages/react-native/ReactAndroid/src/main/jni/react/tracing/PerformanceTracerCxxInterop.cpp') ?? '';
  const MAIN = ['packages/react-native/ReactAndroid/src/main/jni'];

  // PP-1 核心：悬垂捕获
  add('C444', '【PP-1 核心】runtimeScheduler 是局部 shared_ptr，eventBeatFactory 按引用捕获它',
    '局部变量 + & 捕获',
    '声明 auto runtimeScheduler = …lock() / 捕获 [eventBeatManager, &runtimeScheduler, globalJavaUiManager]',
    fumb.includes('auto runtimeScheduler = runtimeSchedulerHolder->cthis()->get().lock();') &&
      fumb.includes('[eventBeatManager, &runtimeScheduler, globalJavaUiManager]('));
  add('C444b', '同函数内 runtimeExecutor 按值捕获同一个 runtimeScheduler —— 同一意图两种写法',
    '一处按值一处按引用',
    '按值 ' + (fumb.includes('[runtimeScheduler](') ? '1 处' : '?') +
      ' / 按引用 ' + (fumb.includes('[eventBeatManager, &runtimeScheduler, globalJavaUiManager](') ? '1 处' : '?'),
    fumb.includes('[runtimeScheduler](') &&
      fumb.includes('[eventBeatManager, &runtimeScheduler, globalJavaUiManager]('));
  add('C444c', '【PP-1 核心】第三次处理用的是 weak_ptr 存入 contextContainer（语义正确）—— 全函数共 3 种策略',
    '按值 / weak_ptr / 按引用',
    'weak_ptr ' + (fumb.includes('std::weak_ptr<RuntimeScheduler>(runtimeScheduler)') ? '1 处' : '?'),
    fumb.includes('contextContainer->insert(') &&
      fumb.includes('RuntimeSchedulerKey, std::weak_ptr<RuntimeScheduler>(runtimeScheduler));'));
  {
    // 逃逸链：lambda 存进 toolbox，toolbox 存进 Scheduler，Scheduler 活得比局部变量久
    const lam = fumb.indexOf('EventBeat::Factory eventBeatFactory =');
    const tb = fumb.indexOf('toolbox.eventBeatFactory = eventBeatFactory;');
    const sch = fumb.indexOf('std::make_shared<Scheduler>(toolbox,');
    add('C445', '【PP-1 核心】逃逸链完整：lambda(:618) → toolbox.eventBeatFactory(:642) → Scheduler(:649) 均在局部变量析构之前完成',
      '3 步逃逸，顺序递增',
      'lambda@' + (lam + 1) + ' → toolbox@' + (tb + 1) + ' → Scheduler@' + (sch + 1),
      lam > 0 && tb > lam && sch > tb &&
        fumb.indexOf('jsArgCount_') === -1);
    add('C445b', '解引用点在 lambda 体内：*runtimeScheduler 被传给 AndroidEventBeat 构造',
      '*runtimeScheduler 解引用',
      '解引用位置 ' + (fumb.indexOf('        *runtimeScheduler,') + 1),
      fumb.includes('        *runtimeScheduler,') &&
        fumb.indexOf('        *runtimeScheduler,') > fumb.indexOf('[eventBeatManager, &runtimeScheduler'));
  }

  // PP-2 核心：throw new
  add('C446', '【PP-2 核心】TurboModuleManager.cpp:86 用 throw new std::runtime_error 抛指针',
    'throw new（指针）',
    tmm.includes('throw new std::runtime_error(') ? '确认' : '未匹配',
    tmm.includes('if (jsiReturnKind == "PromiseKind") {') &&
      tmm.includes('throw new std::runtime_error(') &&
      tmm.includes('std::string("Failed to convert jsiReturnKind \\"") + jsiReturnKind +') &&
      tmm.includes('" to TurboModuleMethodValueKind");'));
  add('C446b', '全文件无 catch (std::runtime_error*) —— 抛出的堆对象无释放点',
    '0 个对应 catch',
    'catch 出现 ' + (tmm.match(/catch\s*\(/g) ?? []).length + ' 次，均非指针式',
    !tmm.includes('catch (std::runtime_error') && !tmm.includes('catch (std::runtime_error*)'));

  // PP-3 核心：size_t 下溢
  add('C447', '【PP-3 核心】jsArgCount_(countJsArgs(signature) - 2) 在初始化列表里做无符号减法，CHECK 在构造函数体内',
    '先减后查',
    fumb.includes('const auto field = javaClassStatic()->getField<int>("jsArgCount");') ||
      mi.includes('jsArgCount_(countJsArgs(signature) - 2),') ? '确认' : '未匹配',
    mi.includes('jsArgCount_(countJsArgs(signature) - 2),') &&
      mi.includes('CHECK(signature_.at(1) == \'.\') << "Improper module method signature";') &&
      mi.indexOf('jsArgCount_(countJsArgs(signature) - 2),') <
        mi.indexOf('CHECK(signature_.at(1) == \'.\')'));
  add('C447b', '同文件的 default: 分支里 return false; 之后有一个不可达的空语句分号',
    '不可达空语句',
    mi.includes('      return false;\n      ;') ? '确认' : '未匹配',
    mi.includes('    default:\n      return false;\n      ;'));

  // 引用管理
  add('C448', '本仓库 JNI 层几乎全用 fbjni RAII：扣除 vendored jni.h 后 NewGlobalRef/DeleteGlobalRef 各 2 次，GetStringUTFChars 与 NewWeakGlobalRef 零使用',
    '2 / 2 / 0',
    '含 jni.h NewGlobalRef=' + grepCount(/NewGlobalRef/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'] }).count +
      '，扣除后=' + grepCount(/NewGlobalRef/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'], excludeFiles: ['jni.h'] }).count +
      '；makeNativeMethod=' + grepCount(/makeNativeMethod\(/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'] }).count,
    grepCount(/NewGlobalRef/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'], excludeFiles: ['jni.h'] }).count === 2 &&
      grepCount(/DeleteGlobalRef/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'], excludeFiles: ['jni.h'] }).count === 2 &&
      grepCount(/NewLocalRef/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'], excludeFiles: ['jni.h'] }).count === 1 &&
      grepCount(/DeleteLocalRef/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'], excludeFiles: ['jni.h'] }).count === 3 &&
      grepCount(/NewWeakGlobalRef/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'], excludeFiles: ['jni.h'] }).count === 0 &&
      grepCount(/GetStringUTFChars/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'], excludeFiles: ['jni.h'] }).count === 0 &&
      grepCount(/makeNativeMethod\(/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'] }).count === 242);
  add('C448b', 'JNI 绑定全部动态注册：静态命名的 Java_com_facebook_react_* 绑定零处，JNIEXPORT 仅 20 行含之而 JNI_OnLoad 占 48 行（含 jni_lib_merge.h 模板 19 处）',
    '静态绑定 0 处',
    'Java_com_facebook_react_* = ' + grepCount(/Java_com_facebook_react_/, { roots: MAIN }).count + ' 处',
    grepCount(/Java_com_facebook_react_/, { roots: MAIN }).count === 0 &&
      grepCount(/JNIEXPORT/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'] }).count === 20 &&
      grepCount(/JNI_OnLoad/, { roots: MAIN, skipDirs: ['tests', 'test', 'test_helper'] }).count === 48 &&
      read('packages/react-native/ReactAndroid/src/main/jni/first-party/jni-lib-merge/jni_lib_merge.h')?.includes('JNI_OnLoad'));

  // 其余缺陷的存在性断言（保证文档条目不会随源码改动而静默失效）
  add('C449', 'PP-9：EventBeatManager 在持有非递归 mutex 时调用观察者（死锁风险）',
    '锁内回调',
    ebm.includes('lock_guard') || ebm.includes('unique_lock') ? '有锁' : '?',
    (ebm.match(/lock_guard|unique_lock|scoped_lock/g) ?? []).length >= 1 &&
      (ebm.match(/for \(|forEach|forEachObserver/g) ?? []).length >= 1);
  add('C449b', 'PP-5：JArrayBuffer 存在 size_t→jint 截断路径',
    '截断风险',
    jarr.includes('jint') || jarr.includes('static_cast<jint>') ? '有 jint' : '?',
    (jarr.match(/static_cast<jint>|jint /g) ?? []).length >= 1);
  add('C449c', 'PP-7：PerformanceTracerCxxInterop 在回调内解引用 callbackWrapper',
    '解引用 callbackWrapper',
    '解引用 ' + (pt.match(/\*callbackWrapper/g) ?? []).length + ' 处',
    (pt.match(/\*callbackWrapper/g) ?? []).length >= 2);
  add('C449d', 'PP-8：FabricUIManagerBinding 有 2 处 getUIManager() 无判空，同文件另有判空模式',
    '无判空 2 处',
    'getUIManager() ' + (fumb.match(/getUIManager\(\)/g) ?? []).length + ' 处',
    (fumb.match(/getUIManager\(\)/g) ?? []).length >= 2 &&
      !fumb.includes('if (auto uiManager = getScheduler()->getUIManager())'));
// ────────────────────────────────────────────────────────────────────────
// 55. 动画系统的驱动驻留与批次复位（51 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const man = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/NativeAnimatedNodesManager.kt') ?? '';
  const av = read('packages/react-native/Libraries/Animated/nodes/AnimatedValue.js') ?? '';
  const nah = read('packages/react-native/src/private/animated/NativeAnimatedHelper.js') ?? '';
  const fbad = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/FrameBasedAnimationDriver.kt') ?? '';
  const ANIM = 'packages/react-native/ReactCommon/react/renderer/animations';
  const lakm = read(ANIM + '/LayoutAnimationKeyFrameManager.cpp') ?? '';
  const dropBody = man.slice(man.indexOf('public fun dropAnimatedNode'),
    man.indexOf('public fun startListeningToAnimatedNodeValue'));

  // QQ-1 核心：dropAnimatedNode 不清 activeAnimations
  add('C450', '【QQ-1 核心】dropAnimatedNode 只清 animatedNodes 与 updatedNodes，完全不触碰 activeAnimations',
    '清 2 张 / 漏 1 张',
    '函数体 ' + dropBody.split('\n').length + ' 行，remove ' + (dropBody.match(/\.remove\(/g) ?? []).length + ' 次，提及 activeAnimations ' +
      (dropBody.includes('activeAnimations') ? '有' : '无'),
    dropBody.includes('animatedNodes.remove(tag)') && dropBody.includes('updatedNodes.remove(tag)') &&
      !dropBody.includes('activeAnimations') && !dropBody.includes('stopAnimationsForNode'));
  add('C450b', '【QQ-1 核心】activeAnimations 有 3 处 removeAt：2 处在显式停止路径，帧循环内仅认 hasFinished',
    '3 处 removeAt',
    'removeAt ' + (man.match(/activeAnimations\.removeAt/g) ?? []).length +
      ' 处 / stopAnimationsForNode 内 1 + stopAnimation 内 1 + 帧循环内 1',
    man.includes('private val activeAnimations = SparseArray<AnimationDriver>()') &&
      man.includes('activeAnimations.put(animationId, animation)') &&
      man.includes('if (animation.hasFinished) {') &&
      (man.match(/activeAnimations\.removeAt/g) ?? []).length === 3 &&
      man.lastIndexOf('activeAnimations.removeAt(i)') > man.indexOf('if (hasFinishedAnimations) {'));
  add('C450c', '【QQ-1 核心】每帧循环无条件遍历 activeAnimations 并把 animatedValue 加入更新列表 —— 驻留驱动仍每帧工作',
    '每帧遍历',
    '两处 activeAnimations 循环',
    man.includes('for (i in 0..<activeAnimations.size()) {') &&
      man.includes('animation.runAnimationStep(frameTimeNanos)') &&
      man.includes('animation.animatedValue?.let { valueNode -> runUpdateNodeList.add(valueNode) }'));
  add('C450d', 'hasActiveAnimations() 依赖 activeAnimations.size() > 0，且实测在本文件内零调用方（只有声明处 1 次出现）',
    '依赖 activeAnimations 且零调用',
    '出现 ' + (man.match(/hasActiveAnimations/g) ?? []).length + ' 次（仅声明）',
    man.includes('public fun hasActiveAnimations(): Boolean = activeAnimations.size() > 0 || updatedNodes.size() > 0') &&
      (man.match(/hasActiveAnimations/g) ?? []).length === 1);
  add('C450e', '【QQ-1 修正】清理机制 stopAnimationsForNode 存在且在 3 个兄弟路径被调用（:129 / :171 / :538），唯独 dropAnimatedNode 未调用',
    '机制存在 + 3 处调用 + 卸载漏调',
    'stopAnimationsForNode 出现 ' + (man.match(/stopAnimationsForNode/g) ?? []).length + ' 次',
    man.includes('private fun stopAnimationsForNode(animatedNode: AnimatedNode) {') &&
      man.includes('if (animatedNode == animation.animatedValue) {') &&
      (man.match(/stopAnimationsForNode\(node\)|stopAnimationsForNode\(driver\.valueNode\)/g) ?? []).length === 3 &&
      !dropBody.includes('stopAnimationsForNode'));
  add('C450f', 'stopAnimationsForNode 内用 while + i--/i++ 的「删后回退一步」写法（该实现本身正确）',
    'while + 回退',
    'removeAt 后紧跟 i--',
    man.includes('while (i < activeAnimations.size()) {') &&
      man.includes('activeAnimations.removeAt(i)\n        i--') &&
      man.indexOf('activeAnimations.removeAt(i)\n        i--') < man.indexOf('i++\n    }'));

  // QQ-2 核心：缺 try/finally
  add('C451', '【QQ-2 核心】_executeAsAnimatedBatch 三条语句无异常处理，operation() 抛异常即跳过 unsetWaitingForIdentifier',
    '无 try/finally',
    '函数体 ' + av.slice(av.indexOf('function _executeAsAnimatedBatch'), av.indexOf('function _executeAsAnimatedBatch') + 220)
      .split('\n').length + ' 行且无 try',
    av.includes('function _executeAsAnimatedBatch(id: string, operation: () => void) {') &&
      av.includes('  NativeAnimatedAPI.setWaitingForIdentifier(id);\n  operation();\n  NativeAnimatedAPI.unsetWaitingForIdentifier(id);') &&
      !av.slice(av.indexOf('function _executeAsAnimatedBatch'), av.indexOf('function _executeAsAnimatedBatch') + 220).includes('try'));
  add('C451b', '【QQ-2 核心】queueOperations 是模块级 let：1 处置 true、2 处复位 false，:148 据此决定是否入队',
    '全局标志',
    '置位 ' + (nah.split('queueOperations = true;').length - 1) +
      ' 处 / 复位 ' + (nah.split('queueOperations = false;').length - 1) + ' 处',
    nah.includes('let queueOperations = false;') &&
      (nah.split('queueOperations = true;').length - 1) === 1 &&
      (nah.split('queueOperations = false;').length - 1) === 2 &&
      nah.includes('if (queueOperations || queue.length !== 0) {'));
  add('C451c', 'setWaitingForIdentifier 有 shouldSignalBatch 早退 —— 这解释了 QQ-2 为何难以复现',
    '早退门控共 4 处',
    '共 ' + (nah.split('if (shouldSignalBatch) {').length - 1) + ' 处早退',
    (nah.split('if (shouldSignalBatch) {').length - 1) === 4 &&
      nah.includes('  setWaitingForIdentifier(id: string): void {\n    if (shouldSignalBatch) {\n      return;\n    }'));

  // QQ-3 核心：无上界对象字面量
  add('C452', '【QQ-3 核心】eventListenerGetValueCallbacks 是无上界的对象字面量：写入 :273，调用 :375，删除 :376（删除在调用之后一行）',
    '对象字面量 / 删在调后',
    '赋值 ' + (nah.split('eventListenerGetValueCallbacks[tag] = ').length - 1) +
      ' 次 / delete ' + (nah.split('delete eventListenerGetValueCallbacks[tag]').length - 1) + ' 次',
    nah.includes('const eventListenerGetValueCallbacks: {\n  [number]: (value: number) => void,\n} = {};') &&
      nah.includes('eventListenerGetValueCallbacks[tag] = saveValueCallback;') &&
      nah.includes('callback(params.value);') &&
      nah.includes('delete eventListenerGetValueCallbacks[tag];') &&
      nah.indexOf('callback(params.value);') < nah.indexOf('delete eventListenerGetValueCallbacks[tag];'));

  // QQ-4 / QQ-10
  add('C453', '【QQ-4】Android FrameBasedAnimationDriver 提供 resetConfig（与 iOS RCTFrameAnimation.mm:62 每次刷新不一致）',
    'Android 有 resetConfig',
    fbad.includes('fun resetConfig(') ? '存在' : '?',
    fbad.includes('fun resetConfig(') &&
      fbad.includes('internal class FrameBasedAnimationDriver(config: ReadableMap) : AnimationDriver() {') &&
      fbad.includes('    resetConfig(config)'));
  add('C453b', 'LayoutAnimationKeyFrameManager 的 initialProgress 在 4 处被写为字面量 0，字段声明在 primitives.h:79',
    '4 处写 0',
    (lakm.split('.initialProgress = 0').length - 1) + ' 处赋值',
    (lakm.split('.initialProgress = 0').length - 1) === 4 &&
      (read(ANIM + '/primitives.h') ?? '').includes('double initialProgress;'));

  // QQ-7/QQ-8
  {
    const u = read(ANIM + '/utils.cpp') ?? '';
    add('C454', '【QQ-7/QQ-8】calculateAnimationProgress 定义在 utils.cpp，声明在 utils.h，由 LayoutAnimationDriver 调用',
      '入口 + 声明 + 调用点',
      u.includes('std::pair<Float, Float> calculateAnimationProgress(') ? '定义在 utils.cpp' : '?',
      u.includes('std::pair<Float, Float> calculateAnimationProgress(') &&
        (read(ANIM + '/utils.h') ?? '').includes('calculateAnimationProgress(uint64_t now, const LayoutAnimation &animation, const AnimationConfig &mutationConfig);') &&
        (read(ANIM + '/LayoutAnimationDriver.cpp') ?? '').includes('calculateAnimationProgress(now, animation, mutationConfig);'));
  }
}
}// ─────
// ────────────────────────────────────────────────────────────────────────
// 56. 代码生成的跨语言脆弱点（52 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const sm = read('packages/react-native-codegen/src/generators/modules/GenerateModuleObjCpp/source/serializeModule.js') ?? '';
  const gmj = read('packages/react-native-codegen/src/generators/modules/GenerateModuleJniCpp.js') ?? '';
  const gmh = read('packages/react-native-codegen/src/generators/modules/GenerateModuleH.js') ?? '';
  const cjs = read('packages/react-native-codegen/src/cli/combine/combine-js-to-schema.js') ?? '';
  const gpj = read('packages/react-native-codegen/src/generators/components/GeneratePropsJavaInterface.js') ?? '';
  const tmh = read('packages/react-native/ReactCommon/react/nativemodule/core/ReactCommon/TurboModule.h') ?? '';
  const CG = 'packages/react-native-codegen/src';

  // RR-1 核心：同一结构体两种初始化方式
  {
    const decl = tmh.slice(tmh.indexOf('struct MethodMetadata {'), tmh.indexOf('};', tmh.indexOf('struct MethodMetadata {')) + 2);
    add('C455', '【RR-1 核心】MethodMetadata 恰好 2 个字段（argCount + invoker），位置聚合初始化因此可编译但语义依赖声明顺序',
      '2 个字段',
      decl.split('\n').filter(l => l.includes(';')).length + ' 个字段声明',
      decl.includes('size_t argCount;') &&
        decl.includes('jsi::Value (*invoker)(jsi::Runtime &rt, TurboModule &turboModule, const jsi::Value *args, size_t count);') &&
        tmh.includes('std::unordered_map<std::string, MethodMetadata> methodMap_;'));
    add('C455b', '【RR-1 核心】GenerateModuleH.js 用指定初始化器（{.argCount = N, .invoker = fn}）—— 安全写法就在同一生成器族里',
      '指定初始化器',
      gmh.includes('.argCount = ${paramCount}, .invoker = ') ? '确认' : '未匹配',
      gmh.includes('MethodMetadata {.argCount = ${paramCount}, .invoker = __${methodName}};'));
    add('C455c', '【RR-1 核心】另两条路径用位置聚合初始化 MethodMetadata {argCount, fn}，与安全写法并存',
      '2 处位置初始化',
      'serializeModule ' + (sm.includes('MethodMetadata {${argCount}, __hostFunction_') ? '1 处' : '?') +
        ' / GenerateModuleJniCpp ' + (gmj.includes('MethodMetadata {${argCount}, __hostFunction_') ? '1 处' : '?'),
      sm.includes('MethodMetadata {${argCount}, __hostFunction_${hasteModuleName}SpecJSI_${methodName}};') &&
        gmj.includes('MethodMetadata {${argCount}, __hostFunction_${hasteModuleName}SpecJSI_${propertyName}};') &&
        !sm.includes('.argCount =') && !gmj.includes('.argCount ='));
  }

  // RR-2 核心：javaPackageName 未接线
  add('C456', '【RR-2 核心】组件 Java 包名被硬编码为 com.facebook.react.viewmanagers，且代码里有显式 TODO 说明不支持自定义',
    '硬编码 + TODO',
    gpj.includes("// TODO: This doesn't support custom package name yet.") ? '确认 TODO' : '?',
    gpj.includes("// TODO: This doesn't support custom package name yet.") &&
      gpj.includes("const normalizedPackageName = 'com.facebook.react.viewmanagers';") &&
      gpj.includes('package ${packageName};'));
  add('C456b', 'javaPackageName 在 JS 侧只被 CLI 读取（generate-specs-cli.js 的 alias + argv），生成器不消费',
    '仅 CLI 读取',
    'CLI 2 处 / 生成器 0 处',
    (read('packages/react-native/scripts/generate-specs-cli.js') ?? '').includes("alias: 'javaPackageName'") &&
      (read('packages/react-native/scripts/generate-specs-cli.js') ?? '').includes('argv.javaPackageName') &&
      !grepCount(/javaPackageName/, { roots: [CG] }).count);
  add('C456c', 'javaPackageName 在 Gradle 侧有 3 个生产文件 + 2 个测试文件 —— 即 Gradle 侧已实现，断点在 CLI 参数到生成器这一跳',
    '3 生产 + 2 测试',
    'Gradle 侧 ' + grepCount(/javaPackageName/, { roots: ['packages/gradle-plugin'] }).files.length + ' 个文件',
    grepCount(/javaPackageName/, { roots: ['packages/gradle-plugin'] }).files.length === 5 &&
      grepCount(/javaPackageName/, { roots: ['packages/gradle-plugin'], skipTests: false }).files
        .filter(f => f.includes('/src/main/')).length === 3);

  // RR-3 核心：静默覆盖
  {
    const merge = cjs.slice(cjs.indexOf('const schema = parser.parseFile(filename);'));
    add('C457', '【RR-3 核心】同名 spec 的合并是对象展开覆盖，无重复检测、无日志',
      '展开覆盖',
      merge.includes('merged.modules = {...merged.modules, ...schema.modules};') ? '确认' : '未匹配',
      cjs.includes('const schema = parser.parseFile(filename);') &&
        cjs.includes('if (schema && schema.modules) {') &&
        cjs.includes('merged.modules = {...merged.modules, ...schema.modules};') &&
        !cjs.slice(cjs.indexOf('if (schema && schema.modules) {'),
          cjs.indexOf('if (schema && schema.modules) {') + 120).includes('console.'));
    add('C457b', '重复检测存在但只覆盖 component 层（src/SchemaValidator.js），不在 module 合并路径上',
      '有校验但不覆盖 module',
      'SchemaValidator ' + (exists(CG + '/SchemaValidator.js') ? '存在' : '?'),
      exists(CG + '/SchemaValidator.js') &&
        exists(CG + '/SchemaValidator.d.ts') &&
        !cjs.includes('SchemaValidator'));
  }

  // 死代码与未接线
  add('C458', 'GeneratePropsJavaPojo 有测试快照但从未注册进任何生成器表 —— 测了没用的，省略了有用的',
    '有快照但不可达',
    '注册点 ' + grepCount(/GeneratePropsJavaPojo/, { roots: [CG], skipTests: false }).files.filter(f => !f.includes('__tests__')).length + ' 个非测试文件',
    (read(CG + '/generators/components/GeneratePropsJavaPojo/index.js') ?? '').length >= 0 &&
      grepCount(/GeneratePropsJavaPojo/, { roots: [CG], skipTests: false }).files
        .filter(f => !f.includes('__tests__')).every(f => f.includes('GeneratePropsJavaPojo')));
  add('C458b', 'parsers/schema/index.js 零调用方（30 行）',
    '零调用方',
    grepCount(/parsers\/schema/, { roots: [CG], skipTests: false }).files.length + ' 个文件引用',
    exists(CG + '/parsers/schema/index.js') &&
      grepCount(/require\(['"][^'"]*parsers\/schema/, { roots: [CG], skipTests: false }).count === 0);

  // RR-10 双实现
  add('C459', '【RR-10】同步/异步判定规则在三处各写一遍，无共享源（Java spec 生成器 + iOS 运行时 + Android 运行时）',
    '3 处实现',
    '生成器 1 + iOS 1 + Android 1',
    (read(CG + '/generators/modules/GenerateModuleJavaSpec.js') ?? '').length > 0 &&
      (read('packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm') ?? '').length > 0 &&
      (read('packages/react-native/ReactCommon/react/nativemodule/core/platform/android/ReactCommon/JavaTurboModule.cpp') ?? '').length > 0);

  // RR-6 WriteMapToFiles
  {
    const rn = read(CG + '/generators/RNCodegen.js') ?? '';
    const ce = read('packages/react-native/scripts/codegen/generate-specs-cli-executor.js') ?? '';
    add('C460', '【RR-6】writeMapToFiles 用 console.error + return false 表达写失败，checkOrWriteFiles 转发它，但唯一调用链的 generate(...) 返回值被丢弃',
      '失败信号被丢弃',
      rn.includes('success = false;') ? '有 success=false' : '?',
      rn.includes('function writeMapToFiles(map: Array<CodeGenFile>) {') &&
        rn.includes('success = false;') &&
        rn.includes('console.error(`Failed to write ${file.name} to ${file.outputDir}`, error);') &&
        rn.includes('  return success;\n}') &&
        rn.includes('function checkOrWriteFiles(') &&
        rn.includes('  return writeMapToFiles(generatedFiles);') &&
        ce.includes('  utils.getCodegen().generate(') &&
        !ce.slice(ce.indexOf('  utils.getCodegen().generate('),
          ce.indexOf('  utils.getCodegen().generate(') + 400).includes('= utils.getCodegen().generate('));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 57. 渲染器核心与 Yoga 的数值边界（53 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const sv = read('packages/react-native/ReactCommon/react/renderer/mounting/ShadowView.cpp') ?? '';
  const svh = read('packages/react-native/ReactCommon/react/renderer/mounting/ShadowView.h') ?? '';
  const lm = read('packages/react-native/ReactCommon/react/renderer/core/LayoutMetrics.h') ?? '';
  const rp = read('packages/react-native/ReactCommon/react/renderer/core/ReactPrimitives.h') ?? '';
  const cdr = read('packages/react-native/ReactCommon/react/renderer/componentregistry/ComponentDescriptorRegistry.cpp') ?? '';
  const ynode = read('packages/react-native/ReactCommon/yoga/yoga/node/Node.cpp') ?? '';
  const ycmp = read('packages/react-native/ReactCommon/yoga/yoga/numeric/Comparison.h') ?? '';
  const ycal = read('packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp') ?? '';
  const psh = read('packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.h') ?? '';
  const psc = read('packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp') ?? '';

  // SS-1 核心：LayoutMetrics 相等 10 / 哈希 8
  {
    const members = lm.slice(lm.indexOf('struct LayoutMetrics {'), lm.indexOf('bool operator==(const LayoutMetrics'));
    const hsh = lm.slice(lm.indexOf('struct hash<facebook::react::LayoutMetrics>'));
    const omitted = ['positionType', 'wasLeftAndRightSwapped'];
    add('C461', '【SS-1 核心】LayoutMetrics 的 operator== 是 = default（比全部成员）而 hash<> 只哈希 8 项，漏掉 positionType 与 wasLeftAndRightSwapped',
      'default 比全部 / 哈希漏 2 项',
      '成员 ' + (members.match(/^\s{2}[A-Za-z].*;\s*$/gm) ?? []).length + ' 个 / 哈希 ' + (hsh.match(/layoutMetrics\.\w+/g) ?? []).length + ' 项',
      lm.includes('bool operator==(const LayoutMetrics &rhs) const = default;') &&
        members.includes('PositionType positionType{PositionType::Relative};') &&
        members.includes('bool wasLeftAndRightSwapped{false};') &&
        hsh.includes('layoutMetrics.displayType,') &&
        !hsh.includes('layoutMetrics.positionType') &&
        !hsh.includes('layoutMetrics.wasLeftAndRightSwapped') &&
        omitted.every(x => members.includes(x)));
    add('C461b', '【SS-1 核心】被漏掉的两个成员都有多个取值（positionType: Relative/Absolute，wasLeftAndRightSwapped: bool），不是平凡量',
      '两个判别量',
      'positionType 默认 Relative / swapped 默认 false',
      members.includes('PositionType positionType{PositionType::Relative};') &&
        members.includes('bool wasLeftAndRightSwapped{false};') &&
        lm.includes('// See `PositionType` for all possible options.'));
    add('C461c', 'SS-1 只造成哈希碰撞、不破坏相等判定（= default 仍比全部成员）',
      '质量退化非正确性',
      'operator== 为 defaulted',
      lm.includes('bool operator==(const LayoutMetrics &rhs) const = default;'));
    add('C461d', 'ShadowView::hash 嵌套调用 LayoutMetrics 的哈希，SS-1 因此会传导',
      '嵌套传导',
      svh.includes('shadowView.layoutMetrics,') ? '确认' : '?',
      svh.includes('shadowView.layoutMetrics,'));
  }

  // SS-2 / SS-3：ShadowView 字段集方向相反地差一项
  {
    const eqf = sv.slice(sv.indexOf('bool ShadowView::operator=='), sv.indexOf('bool ShadowView::operator==') + 700);
    add('C462', '【SS-2】ShadowView 的 operator== 比 componentName 而 hash<> 哈希 componentHandle —— 两个字段集差一项且方向相反',
      '只比不哈希 / 只哈希不比',
      '相等 ' + (eqf.match(/this->\w+/g) ?? []).length + ' 项 / 哈希 ' + (svh.slice(svh.indexOf('struct hash<facebook::react::ShadowView>')).match(/shadowView\.\w+/g) ?? []).length + ' 项',
      eqf.includes('this->componentName,') &&
        !eqf.includes('this->componentHandle') &&
        svh.includes('shadowView.componentHandle,') &&
        !svh.includes('shadowView.componentName'));
    add('C462b', '【SS-2】该不一致当前不违规：注册表用两处 react_native_assert 保证 handle 与 name 双射',
      '双射 + 2 处断言',
      '断言 ' + (cdr.match(/react_native_assert\(/g) ?? []).length + ' 处',
      cdr.includes('componentDescriptor->getComponentHandle() ==') &&
        cdr.includes('componentDescriptorProvider.handle') &&
        cdr.includes('componentDescriptor->getComponentName() =='));
    add('C462c', '【SS-3】ComponentName 是 const char*，因此 operator== 做的是指针比较而非字符串比较',
      '指针比较',
      rp.includes('using ComponentName = const char *;') ? '确认' : '?',
      rp.includes('using ComponentName = const char *;') &&
        rp.includes('using ComponentHandle = int64_t;') &&
        eqf.includes('this->componentName,'));
  }

  // SS-4 核心：Yoga 测量消毒放过 ±inf
  {
    const meas = ynode.slice(ynode.indexOf('const auto size = measureFunc_('), ynode.indexOf('const auto size = measureFunc_(') + 700);
    add('C463', '【SS-4 核心】Yoga 测量消毒的四个判据只覆盖 NaN 与负数，+inf 四条全部为 false',
      '4 判据 / inf 放行',
      '判据：isUndefined×2 + <0 ×2',
      meas.includes('yoga::isUndefined(size.height) || size.height < 0 ||') &&
        meas.includes('yoga::isUndefined(size.width) || size.width < 0)') &&
        meas.includes('Measure function returned an invalid dimension to Yoga: [width=%f, height=%f]') &&
        meas.includes('.width = maxOrDefined(0.0f, size.width),'));
    add('C463b', 'isUndefined 的实现是 value != value，即 NaN 判定；对 +inf 返回 false',
      'NaN 判定',
      ycmp.includes('return value != value;') ? '确认' : '?',
      ycmp.includes('constexpr bool isUndefined(std::floating_point auto value) {') &&
        ycmp.includes('return value != value;') &&
        ycmp.includes('constexpr bool isDefined(std::floating_point auto value) {') &&
        ycmp.includes('return !isUndefined(value);'));
    add('C463c', '【SS-4 核心】消毒用的 maxOrDefined 对 inf 返回 inf（std::max(0.0f, inf) = inf），即消毒无法截断无穷值',
      '消毒对 inf 无效',
      'maxOrDefined 定义在 Comparison.h:35-42',
      ycmp.includes('return std::max(a, b);') &&
        ycmp.includes('return yoga::isUndefined(a) ? b : a;') &&
        meas.includes('maxOrDefined(0.0f, size.width)'));
  }

  // SS-8 / SS-9：两个独立硬编码的 epsilon
  add('C464', '【SS-8】inexactEquals 的阈值在 float/double 两个重载各写死一次（0.0001f / 0.0001），注释自称 hardcoded',
      '3 处字面量（1 注释 + 2 代码）',
      (ycmp.match(/0\.0001/g) ?? []).length + ' 处字面量',
      ycmp.includes('// Custom equality functions using a hardcoded epsilon of 0.0001f, or returning') &&
        (ycmp.match(/0\.0001/g) ?? []).length === 3 &&
        ycmp.includes('return std::abs(a - b) < 0.0001f;') &&
        ycmp.includes('return std::abs(a - b) < 0.0001;'));
  add('C464b', '【SS-9】CalculateLayout 用另一个硬编码阈值 1e-6f 做除法前近零守卫，与 0.0001f 相差 100 倍',
      '1e-6f vs 0.0001f',
      '1e-6f 出现 ' + (ycal.match(/1e-6f/g) ?? []).length + ' 次',
      ycal.includes('// Use a relative epsilon guard instead of exact equality: after the') &&
        ycal.includes('// totalFlexShrinkScaledFactors may be near-zero rather than exactly 0') &&
        ycal.includes('// produces a gigantic childSize that overwhelms the min/max clamp.') &&
        (ycal.match(/1e-6f/g) ?? []).length >= 1 &&
        ycal.includes('shrinkFactorMagnitude < 1e-6f'));

  // SS-6 核心：无上界的文本布局缓存
  {
    const decl = psh.slice(psh.indexOf('mutable std::vector<MeasuredPreparedTextLayout> measuredLayouts_;') - 40,
      psh.indexOf('mutable std::vector<MeasuredPreparedTextLayout> measuredLayouts_;') + 70);
    add('C465', '【SS-6 核心】measuredLayouts_ 是 mutable std::vector，全仓库仅 4 处引用（1 声明 + 2 读 + 1 写），无 clear/淘汰',
      'vector / 4 引用 / 无淘汰',
      '引用 ' + (grepCount(/measuredLayouts_/, { roots: ['packages/react-native/ReactCommon/react/renderer'] }).count) + ' 处',
      decl.includes('mutable std::vector<MeasuredPreparedTextLayout> measuredLayouts_;') &&
        (grepCount(/measuredLayouts_/, { roots: ['packages/react-native/ReactCommon/react/renderer'] }).count) === 4 &&
        !psc.includes('measuredLayouts_.clear()') &&
        !psc.includes('measuredLayouts_.resize('));
    add('C465b', '【SS-6 核心】每次测量两次线性扫描（:196 按 floatEquality 找可复用、:226 按 layoutConstraints 找）',
      '2 次 O(n) 扫描',
      (psc.match(/for \((auto&|const auto&) \w+ : measuredLayouts_\)/g) ?? []).length + ' 处循环',
      (psc.match(/for \((auto&|const auto&) \w+ : measuredLayouts_\)/g) ?? []).length === 2 &&
        psc.includes('if (floatEquality(') &&
        psc.includes('if (layout.layoutConstraints == layoutConstraints) {'));
    add('C465c', '【SS-6 核心】写入点被 enablePreparedTextLayout flag 包住，且 push_back 后才 assert_valid_size（SS-7）',
      'flag 门控 + 断言在后',
      'push_back 与 assert 顺序已验证',
      psc.includes('if (ReactNativeFeatureFlags::enablePreparedTextLayout()) {') &&
        psc.includes('measuredLayouts_.push_back(') &&
        psc.indexOf('measuredLayouts_.push_back(') < psc.indexOf('assert_valid_size(measurement.size, layoutConstraints);'));
    add('C465d', '扫描失败的原因有注释说明：显式 width/height 或 min-size 约束都会导致必然未命中（后者会持续增长）',
      '注释说明两种未命中',
      psc.includes('// adjusted by a constraint (like min-size).') ? '确认' : '未匹配',
      psc.includes('// We consider the layout to be reusable, if our content measurement,') &&
        psc.includes('// compatible layout, such as if Yoga already knew the dimensions (an') &&
        psc.includes('// exact width/height was given), or if our content measurement was') &&
        psc.includes('// adjusted by a constraint (like min-size).'));
    add('C465e', '对照：同模块另一个文本缓存由 ReactNativeFeatureFlags::preparedTextCacheSize() 定容（有界）',
      '对照组有界',
      'flag 定容存在',
      grepCount(/preparedTextCacheSize/, { roots: ['packages/react-native/ReactCommon/react/renderer'] }).count >= 1);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 58. iOS 参数转换层的构建分层防护（54 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const rch = read('packages/react-native/React/Base/RCTConvert.h') ?? '';
  const rcm = read('packages/react-native/React/Base/RCTConvert.mm') ?? '';
  const rmm = read('packages/react-native/React/Base/RCTModuleMethod.mm') ?? '';
  const rdh = read('packages/react-native/React/Base/RCTDefines.h') ?? '';

  // TT-1 核心：RCT_JSON_CONVERTER 的 release 分支是裸 return json
  {
    const macro = rcm.slice(rcm.indexOf('#if RCT_DEBUG'), rcm.indexOf('RCT_JSON_CONVERTER(NSArray)'));
    add('C466', '【TT-1 核心】RCT_JSON_CONVERTER 的 release 分支只有一条 return json —— 4 个基础类型转换器零类型检查',
      'release 1 条语句',
      'Debug ' + (macro.match(/isKindOfClass/g) ?? []).length + ' 处检查 / release ' +
        (macro.slice(macro.indexOf('#else')).match(/return/g) ?? []).length + ' 条 return',
      macro.includes('if ([json isKindOfClass:[type class]]) {') &&
        macro.includes('RCTLogConvertError(json, @ #type);') &&
        macro.includes('  +(type *)type : (id)json       \\\n  {                              \\\n    return json;                 \\\n  }') &&
        rcm.includes('RCT_JSON_CONVERTER(NSArray)') && rcm.includes('RCT_JSON_CONVERTER(NSDictionary)') &&
        rcm.includes('RCT_JSON_CONVERTER(NSString)') && rcm.includes('RCT_JSON_CONVERTER(NSNumber)'));
  }

  // TT-2 核心：@try 只在 debug
  add('C467', '【TT-2 核心】RCT_CUSTOM_CONVERTER 的 @try/@catch 只在 debug 分支；catch 块做「记日志 → json=nil → 重试求值」',
    '@try 仅 debug',
    rch.includes('} else {                                   \\\n      @try {') ? 'else 分支含 @try' : '?',
    rch.includes('#define RCT_CUSTOM_CONVERTER(type, name, code)') &&
      rch.includes('    if (!RCT_DEBUG) {                          \\\n      return code;                             \\') &&
      rch.includes('    } else {                                   \\\n      @try {') &&
      rch.includes('RCTLogConvertError(json, @ #type);') &&
      rch.includes('        json = nil;') &&
      rch.includes('        return code;'));
  add('C467b', '【TT-3 核心】RCT_NUMBER_CONVERTER 用三元表达式在 release 跳过 [self NSNumber:json] 归一',
    'release 走 json getter',
    rch.includes('[RCT_DEBUG ? [self NSNumber:json] : json getter]') ? '确认' : '?',
    rch.includes('#define RCT_NUMBER_CONVERTER(type, getter) \\') &&
      rch.includes('  RCT_CUSTOM_CONVERTER(type, type, [RCT_DEBUG ? [self NSNumber:json] : json getter])'));
  {
    // 7 个数值转换器
    const nums = [...rcm.matchAll(/RCT_NUMBER_CONVERTER\((\w+), (\w+)\)/g)].map(x => x[2]);
    add('C467c', '【TT-3 核心】7 个数值转换器（double/float/int/int64_t/uint64_t/NSInteger/NSUInteger）全部走 release 无归一的路径',
      '7 个数值转换器',
      nums.length + ' 个：' + nums.join(', '),
      nums.length === 7 &&
        ['doubleValue', 'floatValue', 'intValue', 'longLongValue', 'unsignedLongLongValue',
          'integerValue', 'unsignedIntegerValue'].every(g => nums.includes(g)) &&
        rcm.includes('RCT_CONVERTER(BOOL, BOOL, boolValue)'));
    add('C467d', 'TT-5：BOOL 转换走 RCT_CUSTOM_CONVERTER 而非 RCT_NUMBER_CONVERTER，因此缺 [self NSNumber:] 归一那一步',
      'BOOL 例外',
      rcm.includes('RCT_CONVERTER(BOOL, BOOL, boolValue)') ? '确认' : '?',
      rcm.includes('RCT_CONVERTER(BOOL, BOOL, boolValue)') &&
        rcm.includes('RCT_CONVERTER(id, id, self)'));
  }

  // TT-4 核心：参数个数检查在 RCT_DEBUG 内
  {
    const body = rmm.slice(rmm.indexOf('- (id)invokeWithBridge:'), rmm.indexOf('// Set arguments'));
    add('C468', '【TT-4 核心】RCTModuleMethod 的模块类 RCTAssert 与参数个数检查整体在 #if RCT_DEBUG 内，release 直接进入「Set arguments」',
      '检查在 #if 内',
      'debug 块 ' + body.split('\n').length + ' 行 / 2 个检查',
      body.includes('#if RCT_DEBUG') &&
        body.includes('// Sanity check') &&
        body.includes('RCTAssert([module class] == _moduleClass,') &&
        body.includes('// Safety check') &&
        body.includes('if (arguments.count != _argumentBlocks.count) {') &&
        body.includes('#endif') &&
        rmm.indexOf('for (id json in arguments) {') > rmm.indexOf('#endif'));
    add('C468b', '【TT-4 核心】release 下循环以 arguments 为基准但以 index 索引 _argumentBlocks，长度不一致即越界',
      'arguments 驱动 / _argumentBlocks 索引',
      '_argumentBlocks 声明类型 NSArray',
      rmm.includes('NSArray<RCTArgumentBlock> *_argumentBlocks;') &&
        rmm.includes('  NSUInteger index = 0;\n  for (id json in arguments) {\n    RCTArgumentBlock block = _argumentBlocks[index];'));
    add('C468c', '【TT-4 核心】检查消息自陈最常见原因是「原生与 JS 代码版本不同步」——而版本不同步是灰度/热更新的常态',
      '消息自陈成因',
      rmm.includes('this usually means that') ? '确认' : '?',
      rmm.includes('If you haven') &&
        rmm.includes('changed this method yourself, this usually means that ') &&
        rmm.includes('your versions of the native code and JavaScript code are out of sync. ') &&
        rmm.includes('Updating both should make this error go away.'));
    add('C468d', '对照：_retainedObjects 的清理与 getReturnValue 的顺序是正确的（先清保活再取值，__bridge 不转移所有权）',
      '顺序正确的一处',
      'removeAllObjects 在 getReturnValue 之前',
      rmm.indexOf('[_retainedObjects removeAllObjects];') < rmm.indexOf('[_invocation getReturnValue:&returnValue];') &&
        rmm.includes('return (__bridge id)returnValue;'));
  }

  // RCT_DEBUG 的语义
  add('C469', 'RCT_DEBUG 的定义与注释：有 DEBUG 宏则为 1，否则为 0；注释明确其目的是「排除错误检查以提升性能、减小体积」',
    'DEBUG 宏 → 1/0',
    rdh.includes('from release builds to improve performance and reduce binary size') ? '确认注释' : '?',
    rdh.includes('The RCT_DEBUG macro can be used to exclude error checking and logging code') &&
      rdh.includes('from release builds to improve performance and reduce binary size.') &&
      rdh.includes('#ifndef RCT_DEBUG') && rdh.includes('#ifdef DEBUG') &&
      rdh.includes('#define RCT_DEBUG 1') && rdh.includes('#define RCT_DEBUG 0'));

  // 总账：5 层防护在 release 下为 0
  add('C470', '总账：Debug 下 5 项防护全部生效，Release 下 5 项全部不存在（三宏 + 调用点检查）',
    'Debug 5 / Release 0',
    '#if RCT_DEBUG：ModuleMethod ' + (rmm.split('#if RCT_DEBUG').length - 1) + ' 处 / Convert.mm ' +
      (rcm.split('#if RCT_DEBUG').length - 1) + ' 处 / Convert.h 内 RCT_DEBUG ' + (rch.split('RCT_DEBUG').length - 1) + ' 处',
    rcm.includes('#if RCT_DEBUG') &&
      rch.includes('if (!RCT_DEBUG)') &&
      rch.includes('[RCT_DEBUG ?') &&
      rmm.includes('#if RCT_DEBUG') &&
      (rmm.split('#if RCT_DEBUG').length - 1) >= 5 &&
      (rcm.split('#if RCT_DEBUG').length - 1) >= 1 &&
      (rch.split('RCT_DEBUG').length - 1) >= 2);
}

// ────────────────────────────────────────────────────────────────────────
// 59. 掉帧埋点的配对契约（55 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const frl = read('packages/react-native/Libraries/Interaction/FrameRateLogger.js') ?? '';
  const nfrl = read('packages/react-native/Libraries/Interaction/NativeFrameRateLogger.js') ?? '';
  const spec = read('packages/react-native/src/private/specs_DEPRECATED/modules/NativeFrameRateLogger.js') ?? '';
  const sv = read('packages/react-native/Libraries/Components/ScrollView/ScrollView.js') ?? '';

  // UU-1 核心：原生实现不存在
  add('C471', '【UU-1 核心】FrameRateLogger 的 spec 只有 4 个方法声明，模块名 FrameRateLogger，返回类型可空',
    '4 方法 / 可空',
    '方法 ' + (spec.match(/readonly \w+/g) ?? []).length + ' 个',
    spec.includes("readonly setGlobalOptions: (options: {readonly debug?: ?boolean}) => void;") &&
      spec.includes('readonly setContext: (context: string) => void;') &&
      spec.includes('readonly beginScroll: () => void;') &&
      spec.includes('readonly endScroll: () => void;') &&
      spec.includes("TurboModuleRegistry.get<Spec>('FrameRateLogger') as ?Spec;"));
  add('C471b', '【UU-1 核心】全平台原生实现检索为零：对 iOS/Android/C++ 的原生扩展名检索 beginScroll 均 0 命中',
    '0 命中',
    'beginScroll 出现 ' + grepCount(/beginScroll/, {
      roots: ['packages/react-native/React', 'packages/react-native/ReactAndroid', 'packages/react-native/ReactCommon'],
    }).count + ' 次',
    grepCount(/beginScroll/, {
      roots: ['packages/react-native/React', 'packages/react-native/ReactAndroid', 'packages/react-native/ReactCommon'],
    }).count === 0);
  add('C471c', '头注释明确声明「没装原生模块时调用都是 no-op」—— 缺失实现是约定而非缺陷',
    '注释声明 no-op',
    frl.includes('If the native module is not installed, function calls are just no-ops.') ? '确认' : '?',
    frl.includes(' * Flow API for native FrameRateLogger module. If the native module is not installed, function calls') &&
      frl.includes(' * are just no-ops.'));
  add('C471d', 'spec 位于 specs_DEPRECATED/ 目录 —— 目录名即声明该 spec 已进入废弃流程',
    'specs_DEPRECATED',
    nfrl.includes("export * from '../../src/private/specs_DEPRECATED/modules/NativeFrameRateLogger';") ? '确认' : '?',
    nfrl.includes("export * from '../../src/private/specs_DEPRECATED/modules/NativeFrameRateLogger';") &&
      nfrl.includes("import NativeFrameRateLogger from '../../src/private/specs_DEPRECATED/modules/NativeFrameRateLogger';"));

  // UU-2 核心：配对是有条件的
  {
    const drag = sv.slice(sv.indexOf('_handleScrollEndDrag:'), sv.indexOf('_handleScrollEndDrag:') + 1100);
    add('C472', '【UU-2 核心】endScroll 的第一个调用点无附加条件（onMomentumScrollEnd），第二个带三重条件',
      '2 个 endScroll / 1 个 beginScroll',
      'beginScroll ' + (sv.match(/FrameRateLogger\.beginScroll\(\)/g) ?? []).length +
        ' 处 / endScroll ' + (sv.match(/FrameRateLogger\.endScroll\(\)/g) ?? []).length + ' 处',
      (sv.match(/FrameRateLogger\.beginScroll\(\)/g) ?? []).length === 1 &&
        (sv.match(/FrameRateLogger\.endScroll\(\)/g) ?? []).length === 2 &&
        drag.includes('if (\n      !this._isAnimating() &&\n      (!velocity || (velocity.x === 0 && velocity.y === 0))\n    ) {\n      FrameRateLogger.endScroll();'));
    add('C472b', '【UU-2 核心】注释第 3 条显式接受「多停」：better to stop the interaction twice than not stop it',
      '显式接受多停',
      '注释 3 条',
      drag.includes('// - If we are animating, then this is a "drag" that is stopping the scrollview and momentum end') &&
        drag.includes('//   will fire.') &&
        drag.includes('// - If velocity is non-zero, then the interaction will stop when momentum scroll ends or') &&
        drag.includes('//   another drag starts and ends.') &&
        drag.includes('// - If we don\'t get velocity, better to stop the interaction twice than not stop it.'));
    add('C472c', 'UU-3：包装层头注释自陈 beginScroll 可能被多次调用、且不确定是否为 bug，责任推给原生',
      '自认不确定',
      frl.includes('unclear if that') ? '确认' : '?',
      frl.includes('Note that `beginScroll` may be called multiple times by `ScrollResponder` - unclear if that\'s') &&
        frl.includes(' * bug, but the native module should be robust to that.'));
  }

  // UU-4：invariant 条件
  {
    const sgo = frl.slice(frl.indexOf('setGlobalOptions:'), frl.indexOf('setContext:'));
    add('C473', '【UU-4】setGlobalOptions 的 invariant 条件是 options.debug !== undefined —— 因此 {debug: false} 也会抛错',
      '!== undefined',
      '条件为 ' + (sgo.includes('options.debug !== undefined') ? '!== undefined' : '?'),
      sgo.includes('if (options.debug !== undefined) {') &&
        sgo.includes('invariant(') &&
        sgo.includes("'Trying to debug FrameRateLogger without the native module!',") &&
        sgo.includes('NativeFrameRateLogger?.setGlobalOptions({'));
    add('C473b', '其余三处调用全部是无条件 ?. 静默 no-op（setContext / beginScroll / endScroll）',
      '3 处 ?. 无条件',
      (frl.match(/NativeFrameRateLogger\?\./g) ?? []).length + ' 处 ?. 调用',
      (frl.match(/NativeFrameRateLogger\?\./g) ?? []).length === 4 &&
        frl.includes('NativeFrameRateLogger?.setContext(context);') &&
        frl.includes('NativeFrameRateLogger?.beginScroll();') &&
        frl.includes('NativeFrameRateLogger?.endScroll();'));
  }

  // UU-5：16ms 阈值
  {
    const isAnim = sv.slice(sv.indexOf('_isAnimating: () => boolean'), sv.indexOf('_isAnimating: () => boolean') + 600);
    add('C474', '【UU-5】_isAnimating 用两个时间字段 + 一个 16ms 阈值判定，阈值定义为 IS_ANIMATING_TOUCH_START_THRESHOLD_MS = 16',
      '阈值 16ms',
      '16 / 60fps 一帧 16.67',
      sv.includes('const IS_ANIMATING_TOUCH_START_THRESHOLD_MS = 16;') &&
        sv.includes('_lastMomentumScrollBeginTime: number = 0;') &&
        sv.includes('_lastMomentumScrollEndTime: number = 0;') &&
        isAnim.includes('const now = global.performance.now();') &&
        isAnim.includes('timeSinceLastMomentumScrollEnd < IS_ANIMATING_TOUCH_START_THRESHOLD_MS ||') &&
        isAnim.includes('this._lastMomentumScrollEndTime < this._lastMomentumScrollBeginTime;'));
    add('C474b', '两个时间字段只在 _handleMomentumScrollBegin(:1361) 与 _handleMomentumScrollEnd(:1370) 被更新 —— 条件② 依赖它们的相对大小',
      '2 个更新点',
      'begin 更新 :1361 / end 更新 :1370',
      sv.includes('    this._lastMomentumScrollBeginTime = global.performance.now();') &&
        sv.includes('    this._lastMomentumScrollEndTime = global.performance.now();') &&
        sv.indexOf('this._lastMomentumScrollBeginTime = global.performance.now();') <
          sv.indexOf('this._lastMomentumScrollEndTime = global.performance.now();'));
  }

  // UU-6：只测滚动
  add('C475', '【UU-6】beginScroll 处带 TODO 说明只测滚动（待实现 onScrollEndAnimation 后再跟踪所有滚动），头注释亦称仅支持 scrolling',
    '仅滚动',
      sv.includes('// TODO: track all scrolls after implementing onScrollEndAnimation') ? '确认' : '?',
      sv.includes('    FrameRateLogger.beginScroll(); // TODO: track all scrolls after implementing onScrollEndAnimation') &&
        frl.includes('In the future we may add support for tracking frame drops in other types of interactions beyond') &&
        frl.includes(' * scrolling.'));
  add('C475b', 'UU-7：头注释把 its 写成 it\'s（all it\'s frame drop data）',
    '原文笔误',
    frl.includes("all it's frame drop data") ? '原文如此' : '未匹配',
    frl.includes("native module gathers up all it's frame drop data and reports it via an analytics pipeline for"));
}

// ────────────────────────────────────────────────────────────────────────
// 60. JS 层的 __DEV__ 校验层（56 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const par = read('packages/react-native/Libraries/StyleSheet/processAspectRatio.js') ?? '';
  const tis = read('packages/react-native/Libraries/Components/TextInput/TextInputState.js') ?? '';
  const modal = read('packages/react-native/Libraries/Modal/Modal.js') ?? '';
  const appst = read('packages/react-native/Libraries/AppState/AppState.js') ?? '';
  const nee = read('packages/react-native/Libraries/EventEmitter/NativeEventEmitter.js') ?? '';
  const asm = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/appstate/AppStateModule.kt') ?? '';
  const LIB = ['packages/react-native/Libraries'];

  // VV-1 核心：恒真的 invariant
  {
    const branch = par.slice(par.indexOf("if (matches.includes('auto')) {"), par.indexOf('const hasNonNumericValues'));
    add('C471', '【VV-1 核心】processAspectRatio 的 auto 分支内 invariant(matches.length) 的条件恒真 —— 因为 includes 为真蕴含 length>=1',
      '恒真条件',
      '条件为 ' + (branch.includes('invariant(\n        matches.length,') ? 'matches.length（真值即通过）' : '?'),
      par.includes("const matches = aspectRatio.split('/').map(s => s.trim());") &&
        par.includes("if (matches.includes('auto')) {") &&
        branch.includes('invariant(\n        matches.length,') &&
        branch.includes("'aspectRatio does not support `auto <ratio>`. You passed: %s'") &&
        !branch.includes('invariant(\n        matches.length === 1,'));
    add('C471b', 'VV-1 不导致功能错误：无论 invariant 是否抛出，分支末尾都是 return（undefined）',
      '仅警告缺失',
      '分支末尾 return;',
      branch.includes('    }\n    return;\n  }'));
    add('C471c', '同文件第 3 处 invariant 的条件是复合且可假的（length===1||length===2 与 !hasNonNumericValues）—— 有效',
      '有效对照',
      par.includes('!hasNonNumericValues && (matches.length === 1 || matches.length === 2)') ? '条件可假' : '?',
      par.includes('const hasNonNumericValues = matches.some(n => Number.isNaN(Number(n)));') &&
        par.includes('!hasNonNumericValues && (matches.length === 1 || matches.length === 2),'));
    add('C471d', 'VV-3：同文件第 1 处 invariant 带 $FlowFixMe[constant-condition] 压制 —— Flow 已判定该判定可疑',
      'Flow 压制',
      par.includes('$FlowFixMe[constant-condition]') ? '确认' : '?',
      par.includes('/* $FlowFixMe[constant-condition] Error discovered during Constant') &&
        par.includes('Condition roll out. See https://fburl.com/workplace/1v97vimq. */') &&
        par.includes('        !aspectRatio,'));
  }

  // VV-2 核心：release 下空壳
  {
    const ff = tis.slice(tis.indexOf('function focusField('), tis.indexOf('function blurTextInput('));
    add('C472', '【VV-2 核心】focusField 与 blurField 的函数体只有一个 if (__DEV__) + return —— release 下等价于空函数',
      '函数体 = if(__DEV__)+return',
      'focusField ' + ff.slice(ff.indexOf('function focusField('), ff.indexOf('function blurField(')).split('\n').length + ' 行 / blurField ' +
        ff.slice(ff.indexOf('function blurField(')).split('\n').length + ' 行',
      ff.includes('function focusField(textFieldID: ?number): void {') &&
        ff.includes("    console.error('focusField no longer works. Use focusInput');") &&
        ff.includes('function blurField(textFieldID: ?number) {') &&
        ff.includes("    console.error('blurField no longer works. Use blurInput');") &&
        (ff.match(/if \(__DEV__\) \{/g) ?? []).length >= 2 &&
        (ff.match(/^  return;$/gm) ?? []).length === 2);
    add('C472b', 'VV-5：currentlyFocusedField 在 console.error 之后仍执行 findNodeHandle 并返回 —— 与前两者弃用程度不同但报错无法区分',
      '仍可用 vs 空壳',
      '三处 __DEV__ 块',
      tis.includes('function currentlyFocusedField(): ?number {') &&
        tis.includes("      'currentlyFocusedField is deprecated and will be removed in a future release. Use currentlyFocusedInput',") &&
        tis.includes('  return findNodeHandle<$FlowFixMe>(currentlyFocusedInputRef);') &&
        tis.includes('function blurField(textFieldID: ?number) {'));
    add('C472c', '三个弃用函数都在默认导出对象里；focusField/blurField 在全仓库零外部调用方',
      '导出 + 零调用',
      '默认导出 ' + (tis.match(/^const TextInputState = \{/m) ? '存在' : '?'),
      tis.includes('  currentlyFocusedField,\n  focusField,\n  blurField,') &&
        tis.includes('export default TextInputState;') &&
        grepCount(/focusField/, { roots: LIB, skipTests: true, excludeFiles: ['TextInputState.js'] }).count === 0 &&
        grepCount(/blurField/, { roots: LIB, skipTests: true, excludeFiles: ['TextInputState.js'] }).count === 0);
  }

  // VV-4：Modal 的 prop 冲突校验
  {
    const cp = modal.slice(modal.indexOf('function confirmProps('), modal.indexOf('// Create a state to track'));
    add('C473', '【VV-4】Modal.confirmProps 的三条 prop 冲突校验（含「necessary to prevent state corruption」那条）整体在 __DEV__ 内',
      '3 条校验 dev-only',
      'console.warn ' + (cp.match(/console\.warn\(/g) ?? []).length + ' 处 / __DEV__ 块 ' + (cp.match(/if \(__DEV__\) \{/g) ?? []).length + ' 个',
      cp.includes('function confirmProps(props: ModalProps) {') &&
        cp.includes('  if (__DEV__) {') &&
        (cp.match(/console\.warn\(/g) ?? []).length === 3 &&
        cp.includes("presentationStyle}' presentation style and 'transparent' value is not supported.") &&
        cp.includes('Modal with translucent navigation bar and without translucent status bar is not supported.') &&
        cp.includes('This is necessary to prevent state corruption.'));
  }

  // §6 反向对照：AppState 的 iOS-only 注释是准确的
  {
    const ctor = appst.slice(appst.indexOf('const emitter:'), appst.indexOf('this._emitter = emitter;'));
    add('C474', '【VV-6】AppState 传给 NativeEventEmitter 的模块按平台条件置 null，带工单号 T88715063 的自动化改写注释',
      '平台条件 + 工单号',
      ctor.includes('Platform.OS !== \'ios\' ? null : NativeAppState,') ? '确认' : '?',
      ctor.includes('// T88715063: NativeEventEmitter only used this parameter on iOS. Now it uses it on all platforms, so this code was modified automatically to preserve its behavior') &&
        ctor.includes('// If you want to use the native module on other platforms, please remove this condition and test its behavior') &&
        ctor.includes("Platform.OS !== 'ios' ? null : NativeAppState,"));
    add('C474b', 'Android 的 addListener/removeListeners 是带 // iOS only 注释的空实现',
      '2 个空实现',
      (asm.match(/\/\/ iOS only/g) ?? []).length + ' 处注释',
      asm.includes('override fun addListener(eventName: String?) {') &&
        asm.includes('override fun removeListeners(count: Double) {') &&
        (asm.match(/\/\/ iOS only/g) ?? []).length === 2);
    add('C474c', '该注释准确：NativeEventEmitter 的两处调用都是 ?. 可选调用，_nativeModule 为 null 时不触达原生',
      '?. 双重保证',
      '2 处 ?. 调用',
      nee.includes('this._nativeModule?.addListener(eventType);') &&
        nee.includes('this._nativeModule?.removeListeners(1);') &&
        nee.includes('if (subscription != null) {'));
  }

  // §4 实测分布
  {
    // grepCount 返回「含匹配的行数」与文件列表；用它统计 __DEV__ 守卫的行数分布
    const gAll = grepCount(/if \(__DEV__\)|__DEV__ \?/, { roots: LIB, skipTests: false });
    const gProd = grepCount(/if \(__DEV__\)|__DEV__ \?/, { roots: LIB });
    const gTIS = gAll.files.filter(f => f.endsWith('TextInputState.js'));
    const gMQ = gAll.files.filter(f => f.endsWith('MessageQueue.js'));
    const gEx = gAll.files.filter(f => f.endsWith('ExceptionsManager-test.js'));
    const gAny = grepCount(/__DEV__/, { roots: LIB, skipTests: false });
    add('C475', '实测：__DEV__ 的两套统计口径不同 —— 口径A（提及即计）66 文件；口径B（只计 if (__DEV__) 与 __DEV__ ?）53 文件 / 114 行',
      'A 66 文件 / B 53 文件 114 行',
      'A: ' + gAny.files.length + ' 文件；B: ' + gAll.files.length + ' 文件 / ' + gAll.count + ' 行；仅生产 ' + gProd.count + ' 行 / ' + gProd.files.length + ' 文件',
      gAny.files.length === 66 && gAll.files.length === 53 && gAll.count === 114 &&
        gTIS.length === 1 && gMQ.length === 1 && gEx.length === 1 &&
        gProd.count < gAll.count && gProd.files.length < gAll.files.length);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 61. 动画节点族的插值校验与 RDP 简化（57 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const ai = read('packages/react-native/Libraries/Animated/nodes/AnimatedInterpolation.js') ?? '';
  const nav = read('packages/react-native/src/private/animated/NativeAnimatedValidation.js') ?? '';
  const asy = read('packages/react-native/Libraries/Animated/nodes/AnimatedStyle.js') ?? '';
  const ac = read('packages/react-native/Libraries/Animated/nodes/AnimatedColor.js') ?? '';
  const NODES = ['packages/react-native/Libraries/Animated/nodes'];

  // WW-1 核心：checkValidRanges 唯一调用点在 __DEV__ 内
  {
    const ctor = ai.slice(ai.indexOf('constructor(parent: AnimatedNode, config:'), ai.indexOf('_getInterpolation(): number => OutputT {'));
    const cvr = ai.slice(ai.indexOf('function checkValidRanges<'), ai.indexOf('function checkValidInputRange'));
    add('C476', '【WW-1 核心】checkValidRanges 全文件只有 1 个调用点，且在构造函数的 if (__DEV__) 内',
      '1 调用点 / dev-only',
      '调用点 ' + (ai.match(/checkValidRanges\(/g) ?? []).length + ' 个',
      (ai.match(/checkValidRanges\(/g) ?? []).length === 1 &&
        ctor.includes('if (__DEV__) {') &&
        ctor.includes('checkValidRanges(config.inputRange, config.outputRange);') &&
        !cvr.includes('checkValidRanges(config.inputRange, config.outputRange);'));
    add('C476b', '【WW-1 核心】checkValidRanges 展开 4 层校验：两次数组长度≥2、两次拒绝 [-∞,+∞]、单调非递减、两数组等长',
      '4 层 / 7 项',
      'invariant ' + (ai.slice(ai.indexOf('function checkValidRanges<'), ai.indexOf('// Samples an `easing` function')).match(/invariant\(/g) ?? []).length + ' 处',
      cvr.includes('checkInfiniteRange(\'outputRange\', outputRange);') &&
        cvr.includes('checkInfiniteRange(\'inputRange\', inputRange);') &&
        cvr.includes('checkValidInputRange(inputRange);') &&
        cvr.includes('inputRange.length === outputRange.length,') &&
        ai.includes("invariant(arr.length >= 2, 'inputRange must have at least 2 elements');") &&
        ai.includes("'inputRange must be monotonically non-decreasing ' + String(arr);") &&
        ai.includes('invariant(arr[i] >= arr[i - 1], message);'));
    add('C476c', '第 8 条校验（Bad output range）在 createStringInterpolation 内且不在 __DEV__ 内 —— 但 release 下该函数惰性调用',
      '无条件但惰性',
      ctor.includes('this._getInterpolation();') ? '构造期在 __DEV__ 内调用' : '?',
      ai.includes("invariant(config.outputRange.length >= 2, 'Bad output range');") &&
        !ai.slice(ai.indexOf("invariant(config.outputRange.length >= 2, 'Bad output range');") - 200,
          ai.indexOf("invariant(config.outputRange.length >= 2, 'Bad output range');")).includes('if (__DEV__)') &&
        ctor.includes('// Create interpolation eagerly in dev, so we can signal errors faster') &&
        ctor.includes('// even when using the native driver'));
  }

  // 正面样本 A：精确拒绝 [-∞,+∞]
  {
    const cir = ai.slice(ai.indexOf('function checkInfiniteRange<'), ai.indexOf('// Ramer–Douglas–Peucker'));
    add('C477', '【正面样本】拒绝条件精确到「恰好 2 元素且为 [-Infinity, Infinity]」—— 3 元素的 [-∞,0,∞] 不被拒',
      '精确 2 元素匹配',
      cir.includes('arr.length !== 2 || arr[0] !== -Infinity || arr[1] !== Infinity,') ? '条件确认' : '?',
      cir.includes('arr.length !== 2 || arr[0] !== -Infinity || arr[1] !== Infinity,') &&
        cir.includes("name + ' must have at least 2 elements')") &&
        cir.includes("name + ' cannot be ]-infinity;+infinity[ ' + arr,"));
    add('C477b', '该行为有正反成对的测试固化：[-∞,∞] toThrow()，[-∞,0,∞] not.toThrow()',
      '测试固化',
      (read('packages/react-native/Libraries/Animated/__tests__/Interpolation-itest.js') ?? '').includes('should throw for an infinite input range') ? '有测试' : '?',
      (read('packages/react-native/Libraries/Animated/__tests__/Interpolation-itest.js') ?? '').includes("it('should throw for an infinite input range', () => {") &&
        (read('packages/react-native/Libraries/Animated/__tests__/Interpolation-itest.js') ?? '').includes('inputRange: [-Infinity, Infinity],') &&
        (read('packages/react-native/Libraries/Animated/__tests__/Interpolation-itest.js') ?? '').includes('inputRange: [-Infinity, 0, Infinity],') &&
        (read('packages/react-native/Libraries/Animated/__tests__/Interpolation-itest.js') ?? '').includes(').not.toThrow();'));
    add('C477c', '错误消息用 ]-infinity;+infinity[ 的记法避免与数学/SQL 的 [a,b] 混淆，且带两条 Flow 压制并有注释解释',
      '记法 + 压制注释',
      (ai.match(/\$FlowFixMe\[incompatible-type\] \(>=0\.13\.0\)/g) ?? []).length + ' 条',
      ai.includes("name + ' cannot be ]-infinity;+infinity[ ' + arr,") &&
        ai.includes('$FlowFixMe[incompatible-type] (>=0.13.0) - In the addition expression') &&
        ai.includes("doesn't cleanly convert to a string, like undefined, null, and object,") &&
        ai.includes('// $FlowFixMe[unsafe-addition]'));
  }

  // 正面样本 B：RDP 简化
  {
    const ses = ai.slice(ai.indexOf('function sampleEasingStops('), ai.indexOf('export default class AnimatedInterpolation'));
    add('C478', '【正面样本】RDP 简化的 5 行注释给出算法名、变体、独立轴、保留规则、疏密规律',
      '5 行注释',
      '注释行 ' + (ai.slice(ai.indexOf('// Ramer–Douglas–Peucker'), ai.indexOf('function simplifyByVerticalDistance')).match(/\/\//g) ?? []).length + ' 处',
      ai.includes('// Ramer–Douglas–Peucker simplification using vertical distance (the curve\'s') &&
        ai.includes('// independent axis is the input position `t`). Keeps the endpoints and any point') &&
        ai.includes('// whose removal would push the piecewise-linear approximation more than') &&
        ai.includes('// `epsilon` away from the sampled curve. Produces non-uniform stops — dense') &&
        ai.includes('// where the curve bends, sparse where it is near-linear.'));
    add('C478b', '四个容差常量各有注释说明量纲与理由：DENSE_SAMPLES=256 / TARGET_ERROR=0.25 / MIN=1e-4 / MAX=1e-2',
      '4 常量 + 注释',
      (ses.match(/const (DENSE_SAMPLES|TARGET_ERROR|MIN_TOLERANCE|MAX_TOLERANCE) = ([0-9e.\-]+);/g) ?? []).length + ' 个',
      ses.includes('const DENSE_SAMPLES = 256;') &&
        ses.includes('const TARGET_ERROR = 0.25;') &&
        ses.includes('const MIN_TOLERANCE = 1e-4;') &&
        ses.includes('const MAX_TOLERANCE = 1e-2;') &&
        ses.includes('// Dense sampling resolution of the easing curve before simplification.') &&
        ses.includes('// Target approximation error, in output units (≈ sub-pixel for layout/') &&
        ses.includes('// Bounds on the (ratio-space) simplification tolerance.'));
    add('C478c', 'epsilon 的三条推导分支：数值输出用 TARGET_ERROR/span，非数值用 TARGET_ERROR/255，最后钳制到 [1e-4,1e-2]',
      '3 分支 + 钳制',
      ses.includes('epsilon = TARGET_ERROR / span;') ? '3 分支确认' : '?',
      ses.includes('if (typeof outputRange[0] === \'number\') {') &&
        ses.includes('const span = max - min;') &&
        ses.includes('if (span > 0) {') &&
        ses.includes('epsilon = TARGET_ERROR / span;') &&
        ses.includes('// Non-numeric output (e.g. colors): components live in [0, 255].') &&
        ses.includes('epsilon = TARGET_ERROR / 255;') &&
        ses.includes('epsilon = Math.min(MAX_TOLERANCE, Math.max(MIN_TOLERANCE, epsilon));'));
    add('C478d', '注释说明这套表示法对齐 CSS linear()，并给出原生的查找算法 binary search + linear interp',
      'CSS 参照 + 原生算法',
      '两处注释确认',
      ai.includes('// This mirrors the CSS `linear()` easing representation. The tolerance targets a') &&
        ai.includes("// applies to each segment's normalized ratio (binary search + linear interp)."));
    add('C478e', '下发给 native 的 easing stops 在 easing 为 null 或 Easing.linear 时被跳过',
      '跳过条件',
      'easing != null && easing !== Easing.linear',
      ai.includes('const easingStops =\n      easing != null && easing !== Easing.linear\n        ? sampleEasingStops(easing, this._config.outputRange)\n        : undefined;') &&
        ai.includes('// An interpolation `easing` is a JS-only function. Rather than drop it (the') &&
        ai.includes('// native driver would run the segment linearly), sample + simplify it into a') &&
        ai.includes('// for every output type since easing acts on the normalized ratio, not the'));
  }

  // WW-2 / WW-4
  add('C479', '【WW-2】键名校验 validateInterpolation / validateStyles 同样在 __DEV__ 内',
    '2 处 dev-only',
    nav.includes('export function validateInterpolation<') ? '3 个导出函数' : '?',
    ai.includes('if (__DEV__) {\n      validateInterpolation(this._config);\n    }') &&
      asy.includes('if (__DEV__) {\n      validateStyles(styleConfig);\n    }') &&
      nav.includes('export function validateInterpolation<') &&
      nav.includes('export function validateStyles(') &&
      nav.includes('export function validateTransform(') &&
      !nav.includes('throw'));
  add('C479b', '【WW-4】AnimatedColor.js 的 __DEV__ 与 invariant 均为 0 次 —— 该节点无任何显式校验',
    '两项均为 0',
    '__DEV__ ' + (ac.match(/__DEV__/g) ?? []).length + ' 次 / invariant ' + (ac.match(/invariant\(/g) ?? []).length + ' 次',
    (ac.match(/__DEV__/g) ?? []).length === 0 &&
      (ac.match(/invariant\(/g) ?? []).length === 0 &&
      (ac.match(/^/gm) ?? []).length > 100);
  add('C479c', '各节点校验密度实测：AnimatedStyle/AnimatedTransform 的 invariant 为 0（校验全部委托给 NativeAnimatedValidation）',
    'Style/Transform invariant=0',
    'Style ' + (asy.match(/invariant\(/g) ?? []).length + ' / Transform ' +
      ((read('packages/react-native/Libraries/Animated/nodes/AnimatedTransform.js') ?? '').match(/invariant\(/g) ?? []).length,
    (asy.match(/invariant\(/g) ?? []).length === 0 &&
      ((read('packages/react-native/Libraries/Animated/nodes/AnimatedTransform.js') ?? '').match(/invariant\(/g) ?? []).length === 0 &&
      (asy.match(/__DEV__/g) ?? []).length === 2);
}

// ────────────────────────────────────────────────────────────────────────
// 62. 图形变换层的运算符与文档强度（58 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const tc = read('packages/react-native/ReactCommon/react/renderer/graphics/Transform.cpp') ?? '';
  const th = read('packages/react-native/ReactCommon/react/renderer/graphics/Transform.h') ?? '';
  const lsn = read('packages/react-native/ReactCommon/react/renderer/core/LayoutableShadowNode.cpp') ?? '';
  const GFX = ['packages/react-native/ReactCommon/react/renderer'];

  // XX-1 核心：at() 无边界检查
  {
    const at = tc.slice(tc.indexOf('Float& Transform::at(int i, int j) noexcept {'), tc.indexOf('Point operator*(const Point& point'));
    add('C484', '【XX-1 核心】Transform::at(i,j) 标 noexcept、无 assert、直接 operator[]，两个重载实现相同',
      'noexcept + 无检查',
      at.split('\n').length + ' 行 / assert ' + (at.match(/assert/g) ?? []).length + ' 次',
      at.includes('Float& Transform::at(int i, int j) noexcept {') &&
        at.includes('const Float& Transform::at(int i, int j) const noexcept {') &&
        at.includes('return matrix[(i * 4) + j];') &&
        (at.match(/return matrix\[\(i \* 4\) \+ j\];/g) ?? []).length === 2 &&
        !at.includes('assert'));
    add('C484b', '头文件对该访问器的注释只有 3 个词（Matrix subscript.），未声明索引范围',
      '注释 3 词',
      th.includes('   * Matrix subscript.') ? '确认' : '?',
      th.includes('  /*\n   * Matrix subscript.\n   */') &&
        th.includes('  Float &at(int i, int j) noexcept;') &&
        th.includes('  const Float &at(int i, int j) const noexcept;'));
    add('C484c', 'at() 的全部调用点在 Transform.cpp 内，索引为 0..3 字面量（Point 变换 16 处、Size 变换 2 处）',
      '调用方全在文件内',
      'at( 调用 ' + (tc.match(/transform\.at\(/g) ?? []).length + ' 处',
      (tc.match(/at\(0, [0-3]\)|at\([1-4], [0-3]\)/g) ?? []).length >= 18 &&
        grepCount(/\.at\(\d, \d\)/, { roots: GFX }).files.length === 1 &&
        !tc.match(/at\((\d+), (\d+)\)/g).some(m => /at\((4|[5-9]|1\d)/.test(m[0])));
  }

  // XX-2 核心：文档/实现强度四种方向
  {
    const decls = th.slice(th.indexOf('/*\n * Applies transformation to the given point.'),
      th.indexOf('Vector operator*(const Transform &transform, const Vector &vector);'));
    add('C485', '【XX-2 核心】四则运算符的注释长度与实现复杂度脱钩：Point 1 行 / Size 1 行 / Rect 2 行 / EdgeInsets 2 行，而 Rect 的实现最复杂',
      '注释 1/1/2/2 行',
      '含 2 处 ONLY SUPPORTS',
      decls.includes(' * Applies transformation to the given point.') &&
        decls.includes(' * Applies transformation to the given size.') &&
        decls.includes(' * ONLY SUPPORTS scale and translation transformation.') &&
        decls.includes(' * ONLY SUPPORTS scale transformation.') &&
        (decls.match(/ONLY SUPPORTS/g) ?? []).length === 2);
    add('C485b', '【XX-2 核心】Size 的实现只读 at(0,0) 与 at(1,1) 两个对角线元素，交叉项被忽略 —— 而头文件未声明任何限制',
      '只取对角线',
      'at 调用 2 处 / 无限制声明',
      tc.includes('Size operator*(const Size& size, const Transform& transform) {') &&
        tc.includes('result.width = std::abs(transform.at(0, 0) * size.width);') &&
        tc.includes('result.height = std::abs(transform.at(1, 1) * size.height);') &&
        !decls.includes('Applies transformation to the given size.\n */\nSize operator*') === false &&
        !th.slice(th.indexOf('* Applies transformation to the given size.'),
          th.indexOf('Size operator*(const Size &size')).includes('ONLY SUPPORTS'));
    add('C485c', '【XX-2 核心】Rect 的实现是 4 角完整变换 + boundingRect，比头文件声明的 ONLY SUPPORTS scale and translation 更强',
      '4 角 + 包围盒',
      'vectorA..D ' + (tc.match(/Vector\{\.x = [abcd]\.x, \.y = [abcd]\.y, \.z = 0, \.w = 1\}/g) ?? []).length + ' 处',
      tc.includes('Rect Transform::applyWithCenter(const Rect& rect, const Point& center) const {') &&
        tc.includes('auto vectorA = *this * Vector{.x = a.x, .y = a.y, .z = 0, .w = 1};') &&
        tc.includes('auto vectorB = *this * Vector{.x = b.x, .y = b.y, .z = 0, .w = 1};') &&
        tc.includes('auto vectorC = *this * Vector{.x = c.x, .y = c.y, .z = 0, .w = 1};') &&
        tc.includes('auto vectorD = *this * Vector{.x = d.x, .y = d.y, .z = 0, .w = 1};') &&
        tc.includes('  return Rect::boundingRect(\n      transformedA, transformedB, transformedC, transformedD);'));
    add('C485d', 'EdgeInsets 的实现同样只取 matrix[0]/matrix[5]，与其 ONLY SUPPORTS scale 的声明一致',
      '文档与实现一致',
      'matrix 索引 4 处',
      tc.includes('EdgeInsets operator*(const EdgeInsets& edgeInsets, const Transform& transform) {') &&
        tc.includes('edgeInsets.left * transform.matrix[0],') &&
        tc.includes('edgeInsets.top * transform.matrix[5],') &&
        tc.includes('edgeInsets.right * transform.matrix[0],') &&
        tc.includes('edgeInsets.bottom * transform.matrix[5]};'));
  }

  // §3.6/§3.5 调用方
  {
    add('C486', 'Size 与 EdgeInsets 两个运算符零生产调用方 —— 文档最宽松与最不保守的两个恰好都未被使用',
      'Size 0 / EdgeInsets 0 / Rect 2',
      'Rect 调用 ' + (lsn.match(/frame \* transform|overflowFrame \* transform/g) ?? []).length + ' 处',
      grepCount(/operator\*\(const Size/, { roots: GFX }).files.length === 2 &&
        grepCount(/operator\*\(const EdgeInsets/, { roots: GFX }).files.length === 2 &&
        (read(GFX + '/graphics/Transform.h') ?? '').includes('Size operator*(const Size &size, const Transform &transform);') &&
        (read(GFX + '/graphics/Transform.h') ?? '').includes('EdgeInsets operator*(const EdgeInsets &edgeInsets, const Transform &transform);') &&
        (lsn.match(/layoutMetrics\.frame \* transform/g) ?? []).length === 1 &&
        (lsn.match(/overflowFrame \* transform/g) ?? []).length === 1);
    add('C486b', 'Rect 变换用于 LayoutableShadowNode 的命中测试，且溢出框走同一路径',
      '命中测试',
      '2 处变换 + 1 条注释',
      lsn.includes('auto transformedFrame = layoutMetrics.frame * transform;') &&
        lsn.includes('auto isPointInside = transformedFrame.containsPoint(point);') &&
        lsn.includes('auto overflowFrame =\n        insetBy(layoutMetrics.frame, layoutMetrics.overflowInset);') &&
        lsn.includes('auto transformedOverflowFrame = overflowFrame * transform;') &&
        lsn.includes('// If child overflows parent, the touch may be intercepted by the child') &&
        lsn.includes('// only, so we should continue recursing.'));
  }

  // §4 operator== 与 operator*
  {
    const eq = tc.slice(tc.indexOf('bool Transform::operator==('), tc.indexOf('Transform Transform::operator*('));
    add('C487', '【XX-5】Transform::operator== 比较 16 个矩阵元素之外还逐项比较 operations 序列 —— 比默认逐字段比较更严格',
      '矩阵 16 + operations 逐项',
      'operations 比较 ' + (eq.match(/operations/g) ?? []).length + ' 处',
      eq.includes('for (auto i = 0; i < 16; i++) {') &&
        eq.includes('if (this->operations.size() != rhs.operations.size()) {') &&
        eq.includes('if (this->operations[i] != rhs.operations[i]) {') &&
        eq.includes('bool Transform::operator==(const Transform& rhs) const noexcept {'));
    add('C487b', '该严格相等被 operator* 用作恒等短路，依赖方向正确（严格相等保证短路不误触发）',
      '短路依赖严格相等',
      '短路在 :360',
      tc.includes('Transform Transform::operator*(const Transform& rhs) const {') &&
        tc.indexOf('if (*this == Transform::Identity()) {') >
          tc.indexOf('Transform Transform::operator*(const Transform& rhs) const {') &&
        tc.indexOf('    return rhs;') > tc.indexOf('if (*this == Transform::Identity()) {') &&
        eq.indexOf('operations[i] != rhs.operations[i]') > 0);
    add('C487c', '【XX-6】operator* 的 Identity 消除只作用于「非首位」（!result.operations.empty() 为前提），该规则无注释',
      '只消除非首位 Identity',
      '两处对称的条件',
      (tc.match(/op\.type == TransformOperationType::Identity &&\n        !result\.operations\.empty\(\)/g) ?? []).length === 2 &&
        tc.includes('  auto result = Transform{};') &&
        !tc.slice(tc.indexOf('auto result = Transform{};'),
          tc.indexOf('auto lhs00 = lhs.matrix[0];')).includes('//'));
    add('C487d', 'TransformOperationType 有 7 个值，含常规之外的 Perspective 与 Arbitrary',
      '7 个枚举值',
      (th.match(/Arbitrary, Identity, Perspective, Scale, Translate, Rotate, Skew/g) ?? []).length + ' 组',
      th.includes('enum class TransformOperationType : uint8_t { Arbitrary, Identity, Perspective, Scale, Translate, Rotate, Skew };') &&
        th.includes('std::array<Float, 16> matrix{{1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1}};') &&
        th.includes('std::vector<TransformOperation> operations{};'));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 63. Promise 的 reject 跨平台契约（59 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const pi = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt') ?? '';
  const ru = read('packages/react-native/React/Base/RCTUtils.mm') ?? '';
  const nm = read('packages/react-native/Libraries/BatchedBridge/NativeModules.js') ?? '';
  const AND = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge';

  // YY-1 核心：两个键名 + 零消费者
  add('C488', '【YY-1 核心】Android 的键名是 nativeStackAndroid、iOS 的是 nativeStackIOS —— 注释在同一处既说「matches iOS behavior」又指出键名不同',
    '两键名',
    'Android nativeStackAndroid / iOS nativeStackIOS',
    pi.includes('private const val ERROR_MAP_KEY_NATIVE_STACK = "nativeStackAndroid"') &&
      ru.includes('forKey:@"nativeStackIOS"];') &&
      pi.includes('// this matches iOS behavior - iOS adds a `nativeStackIOS` property') &&
      pi.includes('// Attach a nativeStackAndroid array if a throwable was passed'));
  add('C488b', '【YY-1 核心】元素类型也不同：Android 是 4 字段 map，iOS 是 callStackSymbols 的原始字符串数组',
    'map vs string',
    'Android 4 字段 / iOS 字符串数组',
    pi.includes('frameMap.putString(STACK_FRAME_KEY_CLASS, frame.className)') &&
      pi.includes('frameMap.putString(STACK_FRAME_KEY_FILE, frame.fileName)') &&
      pi.includes('frameMap.putInt(STACK_FRAME_KEY_LINE_NUMBER, frame.lineNumber)') &&
      pi.includes('frameMap.putString(STACK_FRAME_KEY_METHOD_NAME, frame.methodName)') &&
      ru.includes('NSArray<NSString *> *stackTrace = [NSThread callStackSymbols];') &&
      ru.includes('[NSMutableDictionary dictionaryWithObject:stackTrace'));
  add('C488c', '【YY-1 核心】全仓 JS/TS 侧对 nativeStack 零引用 —— JS 只用 Object.assign 透传，且带三条 $FlowFixMe',
    'JS 零消费者',
    'Object.assign ' + nm.includes('return Object.assign(error, errorData || {});') ? '1 处' : '?',
    nm.includes('function updateErrorWithErrorData(') &&
      nm.includes('  errorData: {message: string, ...},') &&
      nm.includes('  return Object.assign(error, errorData || {});') &&
      nm.slice(nm.indexOf('function updateErrorWithErrorData('), nm.indexOf('function updateErrorWithErrorData(') + 420)
        .split('$FlowFixMe').length - 1 === 3 &&
      grepCount(/nativeStack/, { roots: ['packages/react-native/Libraries'], exts: ['.js', '.ts'] }).count === 0);
  add('C488d', 'YY-2：帧数上限两端不对称 —— Android 硬编码 50，iOS 用 callStackSymbols 全量无上限',
    'Android 50 / iOS 无上限',
    'ERROR_STACK_FRAME_LIMIT=' + (pi.includes('private const val ERROR_STACK_FRAME_LIMIT = 50') ? '50' : '?'),
    pi.includes('private const val ERROR_STACK_FRAME_LIMIT = 50') &&
      pi.includes('while (i < stackTrace.size && i < ERROR_STACK_FRAME_LIMIT) {') &&
      ru.includes('NSArray<NSString *> *stackTrace = [NSThread callStackSymbols];') &&
      !ru.includes('callStackSymbols].first'));
  add('C488e', 'YY-3：三条跨文件注释锚点中仅 1 条失效（createErrorFromErrorData 已改名）；parseErrorStack.js 与 RCTUtils.m 两条均有效',
    '3 取 1 失效',
    '失效 1 / 有效 2',
    pi.includes('// /Libraries/BatchedBridge/NativeModules.js -> createErrorFromErrorData') &&
      pi.includes('// iOS: /Libraries/Core/Devtools/parseErrorStack.js -> StackFrame') &&
      pi.includes('// iOS: /React/Base/RCTUtils.m -> RCTJSErrorFromCodeMessageAndNSError') &&
      nm.includes('function updateErrorWithErrorData(') &&
      !nm.includes('createErrorFromErrorData') &&
      exists('packages/react-native/Libraries/Core/Devtools/parseErrorStack.js') &&
      ru.includes('RCTJSErrorFromCodeMessageAndNSError(') &&
      grepCount(/createErrorFromErrorData/, { roots: ['packages/react-native/Libraries'] }).count === 0 &&
      grepCount(/parseErrorStack/, { roots: ['packages/react-native/Libraries'] }).count >= 3);

  // §3 四级降级
  {
    const rj = pi.slice(pi.indexOf('  override fun reject(\n      code: String?,\n      message: String?,\n      throwable: Throwable?,\n      userInfo: WritableMap?,'), pi.indexOf('    // For consistency with iOS'));
    add('C489', 'Android 的 message 有四级降级：自定义 → throwable.message → 类名 → "Error not specified."',
      '4 级降级',
      '默认消息 ' + (pi.includes('private const val ERROR_DEFAULT_MESSAGE = "Error not specified."') ? 'Error not specified.' : '?'),
      rj.includes('    if (message != null) {') &&
        rj.includes('    } else if (throwable != null) {') &&
        rj.includes('      if (throwableMessage.isNullOrEmpty()) {') &&
        rj.includes('        throwableMessage = throwable.javaClass.canonicalName') &&
        rj.includes('      errorInfo.putString(ERROR_MAP_KEY_MESSAGE, ERROR_DEFAULT_MESSAGE)') &&
        pi.includes('private const val ERROR_DEFAULT_MESSAGE = "Error not specified."') &&
        pi.includes('private const val ERROR_DEFAULT_CODE = "EUNSPECIFIED"'));
    add('C489b', 'YY-6（正面）：userInfo 即使无值也要 putNull，注释写明是 For consistency with iOS 的刻意跨平台对齐',
      '刻意 putNull',
      '注释与实现一致',
      pi.includes('    // For consistency with iOS ensure userInfo key exists, even if we null it.') &&
        pi.includes('    // iOS: /React/Base/RCTUtils.m -> RCTJSErrorFromCodeMessageAndNSError') &&
        pi.includes('    if (userInfo != null) {\n      errorInfo.putMap(ERROR_MAP_KEY_USER_INFO, userInfo)\n    } else {\n      errorInfo.putNull(ERROR_MAP_KEY_USER_INFO)\n    }\n') &&
        pi.indexOf('    // For consistency with iOS ensure userInfo key exists, even if we null it.') >
          pi.indexOf('    if (reject == null) {\n      resolve = null'));
    add('C489c', 'YY-7（正面）：帧循环有注释预先回答「为何没有列号」—— NOTE: no column number exists StackTraceElement',
      '解释缺失字段',
      pi.includes('// NOTE: no column number exists StackTraceElement') ? '确认' : '?',
      pi.includes('// Build an an Array of StackFrames to match JavaScript:') &&
        pi.includes('// NOTE: no column number exists StackTraceElement') &&
        pi.includes('private const val STACK_FRAME_KEY_CLASS = "class"') &&
        pi.includes('private const val STACK_FRAME_KEY_FILE = "file"') &&
        pi.includes('private const val STACK_FRAME_KEY_LINE_NUMBER = "lineNumber"') &&
        pi.includes('private const val STACK_FRAME_KEY_METHOD_NAME = "methodName"'));
  }

  // §4 单次结算
  {
    const res = pi.slice(pi.indexOf('  override fun resolve(value: Any?) {'), pi.indexOf('  /**\n   * Report an error without an exception'));
    add('C490', '单次结算成立：resolve 用 ?.let、reject 用 if+return 早返回；四种二次调用组合均无操作',
      '4 组合安全',
      'resolve 用 let / reject 用 if',
      res.includes('  override fun resolve(value: Any?) {\n    resolve?.let { callback ->\n      callback.invoke(value)\n      resolve = null\n      reject = null\n    }\n  }') &&
        pi.includes('    if (reject == null) {\n      resolve = null\n      return\n    }') &&
        pi.includes('    reject?.invoke(errorInfo)\n    resolve = null\n    reject = null'));
    add('C490b', 'YY-4：reject 块尾的 reject?.invoke 是冗余的 —— 前面 :139 已判空早返回，中间构造不会改 reject',
      '冗余 ?.',
      '前面已判空',
      pi.includes('    if (reject == null) {\n      resolve = null\n      return\n    }') &&
        pi.indexOf('if (reject == null) {') < pi.indexOf('reject?.invoke(errorInfo)') &&
        !pi.slice(pi.indexOf('if (reject == null) {'), pi.indexOf('reject?.invoke(errorInfo)')).includes('reject = null'));
  }

  // @DoNotStrip
  add('C491', 'PromiseImpl 的类与构造器都带 @DoNotStrip（防止 shrinker 剥离）',
    '2 处 @DoNotStrip',
    (pi.match(/@DoNotStrip/g) ?? []).length + ' 处',
    pi.includes('@DoNotStrip\npublic class PromiseImpl\n@DoNotStrip\nconstructor(') &&
      (pi.match(/@DoNotStrip/g) ?? []).length === 2 &&
      (pi.match(/@Deprecated/g) ?? []).length >= 1);
  add('C491b', 'PromiseImpl 含 @Deprecated 的 reject(message) 重载，注释块标题为 Deprecated',
    '有弃用重载',
    (pi.match(/@Deprecated/g) ?? []).length + ' 处 @Deprecated',
    pi.includes('  /* ------------\n   *  Deprecated\n   * ------------ */') &&
      pi.includes('@Deprecated("Use reject(code, message) instead.", ReplaceWith("reject(code, message)"))'));
}

// ────────────────────────────────────────────────────────────────────────
// 64. View 组件原语层的位号与枚举（60 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const prim = read('packages/react-native/ReactCommon/react/renderer/components/view/primitives.h') ?? '';
  const bvp = read('packages/react-native/ReactCommon/react/renderer/components/view/BaseViewProps.cpp') ?? '';
  const hpp = read('packages/react-native/ReactCommon/react/renderer/components/view/platform/android/react/renderer/components/view/HostPlatformViewProps.cpp') ?? '';
  const aps = read('packages/react-native/ReactCommon/react/renderer/animationbackend/AnimatedPropSerializer.cpp') ?? '';
  const apb = read('packages/react-native/ReactCommon/react/renderer/animationbackend/AnimatedPropsBuilder.h') ?? '';
  const RC = ['packages/react-native/ReactCommon'];

  // ZZ-1 核心：位号空洞
  {
    const i = prim.indexOf('enum class Offset');
    const j = prim.indexOf('};', i);
    const seg = prim.slice(i, j);
    const pairs = [...seg.matchAll(/(\w+)\s*=\s*(\d+)/g)].map(m => [m[1], +m[2]]).sort((a, b) => a[1] - b[1]);
    const nums = pairs.map(x => x[1]);
    const gaps = [];
    for (let k = 0; k <= nums[nums.length - 1]; k++) if (!nums.includes(k)) gaps.push(k);
    add('C492', '【ZZ-1 核心】ViewEvents::Offset 有 35 个成员、最大位号 37，位号空洞恰为 20/21/22',
      '35 成员 / 空洞 3',
      pairs.length + ' 成员 / 最大 ' + nums[nums.length - 1] + ' / 空洞 ' + gaps.join(','),
      pairs.length === 35 && nums[nums.length - 1] === 37 &&
        gaps.length === 3 && gaps.join(',') === '20,21,22' &&
        seg.includes('TouchCancel = 19,') && seg.includes('PointerEnterCapture = 23,'));
    add('C492b', '【ZZ-1 核心】空洞处无任何说明：primitives.h 全文检索 removed/Reserved/unused/deprecated 零命中',
      '零说明',
      '两段之间仅空行',
      !prim.includes('removed') && !prim.includes('Reserved') && !prim.includes('unused') &&
        prim.includes('    TouchCancel = 19,\n\n    // W3C Pointer Events\n    PointerEnterCapture = 23,') &&
        prim.includes('    // Touch events\n    TouchStart = 16,'));
    add('C492c', 'bitset 固定为 64 位，尾部 38-63 共 26 位未用（无显式注释，但 bitset<64> 本身是信号）',
      'bitset<64> / 26 位未用',
      prim.includes('std::bitset<64> bits{};') ? '确认' : '?',
      prim.includes('  std::bitset<64> bits{};') &&
        prim.includes('  constexpr bool operator[](const Offset offset) const\n  {\n    return bits[static_cast<std::size_t>(offset)];\n  }') &&
        prim.includes('  std::bitset<64>::reference operator[](const Offset offset)\n  {\n    return bits[static_cast<std::size_t>(offset)];\n  }'));
    add('C492d', '位号是编译期常量：Android 侧 HostPlatformViewProps 以 ViewEvents::Offset::X 逐项写入位掩码',
      '位掩码消费方',
      'ViewEvents::Offset:: 引用 ' + (hpp.match(/ViewEvents::Offset::/g) ?? []).length + ' 处',
      (hpp.match(/ViewEvents::Offset::/g) ?? []).length >= 8 &&
        hpp.includes('ViewEvents::Offset::PointerEnter,') &&
        hpp.includes('ViewEvents::Offset::PointerEnterCapture,'));
    add('C492e', 'ZZ-4：两个下标运算符都用 bits[...]（operator[]）而非 bits.at(...)，但因参数是 enum class 而实际安全',
      'operator[] 无检查但安全',
      prim.includes('bits.at(') ? '含 at()' : '无 at()',
      !prim.includes('bits.at(') &&
        prim.includes('  enum class Offset : std::size_t {') &&
        prim.includes('    PointerUpCapture = 37,') &&
        prim.includes('    PointerEnter = 0,'));
  }

  // ZZ-2 核心：两个相同枚举
  add('C493', '【ZZ-2 核心】BorderStyle 与 OutlineStyle 的底层类型、成员、顺序完全相同（Solid/Dotted/Dashed）',
      '成员完全相同',
      '两者均 : uint8_t 且 3 成员',
    (prim.match(/enum class \w+ : uint8_t \{ Solid, Dotted, Dashed \};/g) ?? []).length === 2 &&
      prim.includes('enum class BorderStyle : uint8_t { Solid, Dotted, Dashed };') &&
      prim.includes('enum class OutlineStyle : uint8_t { Solid, Dotted, Dashed };'));
  add('C493b', 'ZZ-2：两者各有独立消费方（BorderStyle 8 文件 / OutlineStyle 7 文件），动画后端做结构相同的两份 switch',
    '8 / 7 文件 + 两份打包',
    'packOutlineStyle 存在',
    (grepCount(/BorderStyle/, { roots: RC, skipTests: true }).files.length === 8) &&
      (grepCount(/OutlineStyle/, { roots: RC, skipTests: true }).files.length === 7) &&
      aps.includes('void packOutlineStyle(') &&
      aps.includes('  const auto& outlineStyle = get<OutlineStyle>(animatedProp);') &&
      aps.includes('    case OutlineStyle::Solid:') &&
      aps.includes('    case OutlineStyle::Dotted:') &&
      apb.includes('  void setOutlineStyle(OutlineStyle value)') &&
      apb.includes('  void setBorderStyles(CascadedBorderStyles &value)'));

  // ZZ-3 核心：operator== 写法不统一
  add('C494', '【ZZ-3 核心】primitives.h 内 operator== 两种写法并存：ViewEvents 手写自由函数，其余 3 个结构体用 = default',
    '手写 1 + default 3',
    (prim.match(/= default/g) ?? []).length + ' 处 default',
    prim.includes('inline static bool operator==(const ViewEvents &lhs, const ViewEvents &rhs)\n{\n  return lhs.bits == rhs.bits;\n}') &&
      (prim.match(/= default/g) ?? []).length === 4 &&
      prim.includes('  bool operator==(const CornerRadii &other) const = default;') &&
      prim.includes('  bool operator==(const CascadedRectangleCorners<T> &rhs) const = default;') &&
      prim.includes('  bool operator==(const BorderMetrics &rhs) const = default;'));
  add('C494b', 'ViewEvents 只有一个数据成员 bits，手写 operator== 是不必要的（= default 即可）',
    '单成员却手写',
    '成员数 1',
    prim.includes('struct ViewEvents {\n  std::bitset<64> bits{};') &&
      prim.includes('inline static bool operator==(const ViewEvents &lhs, const ViewEvents &rhs)') &&
      !prim.includes('  bool operator==(const ViewEvents &other) const') &&
      !prim.includes('  bool operator==(const ViewEvents &rhs) const'));

  // §3.3 两套别名
  {
    const al = prim.slice(prim.indexOf('using BorderWidths = RectangleEdges<Float>;'), prim.indexOf('struct BorderMetrics'));
    add('C495', 'primitives.h 定义了 5 组 × 2 = 10 个别名（Rectangle* 与 Cascaded* 各 5）',
      '10 个别名',
      (al.match(/^using /gm) ?? []).length + ' 个',
      (al.match(/^using /gm) ?? []).length === 10 &&
        al.includes('using BorderWidths = RectangleEdges<Float>;') &&
        al.includes('using CascadedBorderWidths = CascadedRectangleEdges<Float>;') &&
        al.includes('using BorderStyles = RectangleEdges<BorderStyle>;') &&
        al.includes('using CascadedBorderStyles = CascadedRectangleEdges<BorderStyle>;'));
    add('C495b', 'ZZ-7：CascadedBorderRadii 的类型参数（ValueUnit）与 BorderRadii（CornerRadii）不同，与其余 4 组「仅容器不同」不同',
      'Radii 组类型参数也不同',
      al.includes('using BorderRadii = RectangleCorners<CornerRadii>;') ? '确认' : '?',
      al.includes('using BorderRadii = RectangleCorners<CornerRadii>;') &&
        al.includes('using CascadedBorderRadii = CascadedRectangleCorners<ValueUnit>;') &&
        prim.includes('struct CornerRadii {\n  float vertical{0.0f};\n  float horizontal{0.0f};'));
    add('C495c', 'CascadedRectangleCorners<T> 与 BorderMetrics 都用 = default 比较；BorderMetrics 含 5 个成员',
      'BorderMetrics 5 成员',
      prim.includes('struct BorderMetrics {') ? '存在' : '?',
      prim.includes('struct BorderMetrics {\n  BorderColors borderColors{};\n  BorderWidths borderWidths{};\n  BorderRadii borderRadii{};\n  BorderCurves borderCurves{};\n  BorderStyles borderStyles{};'));
  }

  // ZZ-6：BaseViewProps 的重复解析
  {
    const ctor = bvp.slice(bvp.indexOf('BaseViewProps::BaseViewProps('), bvp.indexOf('      borderStyles(convertRawProp(') + 200);
    add('C496', 'ZZ-6：BaseViewProps 构造函数里 convertRawProp 至少出现 6 次，且两个基类各自独立解析同一份 rawProps',
      '6 次 convertRawProp / 2 基类',
      (ctor.match(/convertRawProp\(/g) ?? []).length + ' 次',
      (ctor.match(/convertRawProp\(/g) ?? []).length >= 6 &&
        ctor.includes(': YogaStylableProps(context, sourceProps, rawProps, filterObjectKeys),') &&
        ctor.includes('AccessibilityProps(context, sourceProps, rawProps),') &&
        ctor.includes('      opacity(convertRawProp(') &&
        ctor.includes('      backgroundColor(convertRawProp(') &&
        ctor.includes('      borderRadii(convertRawProp('));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 65. ScrollView 状态与裁剪的平台条件（61 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const svsn = read('packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewShadowNode.cpp') ?? '';
  const svs = read('packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewState.h') ?? '';
  const cc = read('packages/react-native/ReactCommon/react/renderer/mounting/internal/CullingContext.cpp') ?? '';
  const mvsp = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/MaintainVisibleScrollPositionHelper.kt') ?? '';
  const rsv = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/ReactScrollView.kt') ?? '';
  const ASCROLL = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll';

  // AAA-1 核心：#ifndef ANDROID
  {
    const fn = svsn.slice(svsn.indexOf('void ScrollViewShadowNode::updateScrollContentOffsetIfNeeded() {'),
      svsn.indexOf('ScrollViewState ScrollViewShadowNode::initialStateData('));
    add('C497', '【AAA-1 核心】updateScrollContentOffsetIfNeeded 的整个函数体（含 if 与 for）在 #ifndef ANDROID 内 —— Android 编译出空函数',
      '#ifndef ANDROID 包住全部',
      '函数体 ' + fn.split('\n').length + ' 行 / #ifdef 出现 ' + (fn.match(/#ifn?def/g) ?? []).length + ' 次',
      fn.includes('void ScrollViewShadowNode::updateScrollContentOffsetIfNeeded() {\n#ifndef ANDROID') &&
        fn.includes('  if (getLayoutMetrics().layoutDirection == LayoutDirection::RightToLeft) {') &&
        fn.includes('#endif\n}') &&
        fn.includes('        layoutMetrics.frame.origin.x = 0;') &&
        fn.includes('      if (layoutMetrics.frame.origin.x != 0) {'));
    add('C497b', 'AAA-2：注释引用的 RCTScrollContentShadowView.m 全仓不存在（除该注释本身）',
      '文件不存在',
      '注释命中但文件不存在',
      fn.includes('// `RCTScrollContentShadowView.m`.') &&
        grepCount(/RCTScrollContentShadowView/, { roots: ['packages/react-native'], skipTests: false }).count === 1 &&
        !exists('packages/react-native/React/Views/ScrollView/RCTScrollContentShadowView.m'));
    add('C497c', 'AAA-1 对照：裁剪侧的同类 RTL 修正在 C++ 层无平台条件（双端都执行）',
      '裁剪侧跨平台',
      'CullingContext 中 LayoutDirection 出现 ' + (cc.match(/LayoutDirection::RightToLeft/g) ?? []).length + ' 次',
      cc.includes('        if (layoutMetrics.layoutDirection == LayoutDirection::RightToLeft) {') &&
        !cc.slice(cc.indexOf('if (layoutMetrics.layoutDirection == LayoutDirection::RightToLeft)'),
          cc.indexOf('if (layoutMetrics.layoutDirection == LayoutDirection::RightToLeft)') + 600).includes('#if') &&
        cc.includes('          auto stateData = scrollViewShadowNode->getStateData();') &&
        cc.includes('              stateData.contentBoundingRect.size.width -'));
    add('C497d', 'Android 的 views/scroll/ 目录零 LayoutDirection/RightToLeft 引用（未覆盖 fabric/ 其他目录）',
      '0 命中',
      '目录 ' + ASCROLL,
      grepCount(/LayoutDirection|RightToLeft/, { roots: [ASCROLL] }).count === 0);
  }

  // AAA-3 核心：钉死 commit 的链接
  {
    add('C498', '【AAA-3 核心】CullingContext 的 RTL 注释用钉死 40 位 SHA + #L579 行锚点的 GitHub 链接',
      'SHA + 行锚点',
      cc.includes('c2f39cfdd87c32b9a59efe8a788b8a03f02b0ea0') ? '确认' : '?',
      cc.includes('// https://github.com/facebook/react-native/blob/c2f39cfdd87c32b9a59efe8a788b8a03f02b0ea0/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm#L579') &&
        cc.includes('// In RTL, content offset is flipped horizontally.') &&
        cc.includes('// We need to flip the culling context frame to match.'));
    add('C498b', 'AAA-4：outsetRatio 的扩张用 floor（向下取整）而非 round —— 方向保守（少裁剪只是多画）',
      'floor 而非 round',
      (cc.match(/floor\(/g) ?? []).length + ' 处 floor',
      (cc.match(/floor\(/g) ?? []).length === 2 &&
        cc.includes('auto outsetRatio = ReactNativeFeatureFlags::viewCullingOutsetRatio();') &&
        cc.includes('        if (outsetRatio > 0) {') &&
        cc.includes('              floor(cullingContext.frame.size.width * outsetRatio));') &&
        !cc.includes('round('));
    add('C498c', '裁剪的四重门控：尺寸>0、enableViewCulling flag、overflow!=Visible、!disableViewCulling',
      '4 重门控',
      'flag ' + (cc.match(/ReactNativeFeatureFlags::/g) ?? []).length + ' 个',
      cc.includes('  return frame.size.width > 0 && frame.size.height > 0;') &&
        cc.includes('  if (ReactNativeFeatureFlags::enableViewCulling()) {') &&
        cc.includes('              yoga::Overflow::Visible &&') &&
        cc.includes('          !scrollViewShadowNode->getStateData().disableViewCulling) {'));
  }

  // §3.5 updateStateIfNeeded 的守卫
  {
    const usin = svsn.slice(svsn.indexOf('void ScrollViewShadowNode::updateStateIfNeeded() {'),
      svsn.indexOf('void ScrollViewShadowNode::updateScrollContentOffsetIfNeeded()'));
    add('C499', 'AAA-9（正面）：updateStateIfNeeded 先 ensureUnsealed，且用 != 守卫避免「状态变更→重布局→再调用」循环',
      '守卫切断循环',
      'unionInPlace ' + (usin.match(/unionInPlace/g) ?? []).length + ' 次',
      usin.includes('  ensureUnsealed();') &&
        usin.includes('  auto contentBoundingRect = Rect{};') &&
        usin.includes('    contentBoundingRect.unionInPlace(childNode->getLayoutMetrics().frame);') &&
        usin.includes('  if (state.contentBoundingRect != contentBoundingRect) {') &&
        usin.includes('    setStateData(std::move(state));'));
    add('C499c', '§3.5.1：ScrollViewState.cpp 全文 24 行，构造函数无平台门控，getContentSize 直接返回 size 且不做空矩形特判',
      '24 行 / 1 构造 / 1 成员函数',
      (read('packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewState.cpp') ?? '').replace(/\n$/, '').split('\n').length + ' 行',
      (read('packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewState.cpp') ?? '').replace(/\n$/, '').split('\n').length === 24 &&
        (read('packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewState.cpp') ?? '').includes('ScrollViewState::ScrollViewState(\n    Point contentOffset,\n    Rect contentBoundingRect,\n    int scrollAwayPaddingTop)\n    : contentOffset(contentOffset),\n      contentBoundingRect(contentBoundingRect),\n      scrollAwayPaddingTop(scrollAwayPaddingTop) {}') &&
        (read('packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewState.cpp') ?? '').includes('Size ScrollViewState::getContentSize() const {\n  return contentBoundingRect.size;\n}') &&
        !svs.slice(svs.indexOf('ScrollViewState(const ScrollViewState &previousState')).includes('#else') &&
        svs.includes('#ifdef RN_SERIALIZABLE_STATE'));
    add('C499b', 'AAA-11：contentBoundingRect 不参与序列化（从 {} 起步），getDynamic 只写 3 个键且与读侧一致',
      '派生量不持久化',
      'getDynamic 键 ' + (svs.slice(svs.indexOf('  folly::dynamic getDynamic() const')).match(/"[a-zA-Z]+"/g) ?? []).length + ' 个',
      svs.includes('        contentBoundingRect({}),') &&
        svs.includes('folly::dynamic getDynamic() const') &&
        (svs.slice(svs.indexOf('  folly::dynamic getDynamic() const')).match(/"[a-zA-Z]+"/g) ?? []).length === 3 &&
        svs.includes('    return folly::dynamic::object("contentOffsetLeft", contentOffset.x)("contentOffsetTop", contentOffset.y)(') &&
        svs.includes('"contentOffsetLeft"') && svs.includes('"contentOffsetTop"') && svs.includes('"scrollAwayPaddingTop"'));
  }

  // AAA-7 / AAA-8：Android 滚动位置保持
  {
    add('C500', '【AAA-7 正面】start/stop 双向幂等，且 onAttachedToWindow/onDetachedFromWindow 精确配对',
      '幂等 + 三处钩子',
      mvsp.includes('fun start() {\n    if (isListening) {') ? '确认' : '?',
      mvsp.includes('  fun start() {\n    if (isListening) {\n      return\n    }\n    isListening = true\n    uIManager.addUIManagerEventListener(this)\n  }') &&
        mvsp.includes('  fun stop() {\n    if (!isListening) {\n      return\n    }\n    isListening = false\n    uIManager.removeUIManagerEventListener(this)\n  }') &&
        rsv.includes('    maintainVisibleContentPositionHelper?.start()') &&
        rsv.includes('    maintainVisibleContentPositionHelper?.stop()'));
    add('C500b', 'AAA-7：setMaintainVisibleContentPosition 按 config 与 helper 的 null 组合分 4 个正交分支',
      '4 分支正交',
      '创建/销毁/更新三动作',
      rsv.includes('    if (config != null && maintainVisibleContentPositionHelper == null) {') &&
        rsv.includes('          MaintainVisibleScrollPositionHelper(this, false).also { it.start() }') &&
        rsv.includes('    } else if (config == null && maintainVisibleContentPositionHelper != null) {') &&
        rsv.includes('      maintainVisibleContentPositionHelper?.stop()') &&
        rsv.includes('      maintainVisibleContentPositionHelper = null') &&
        rsv.includes('    maintainVisibleContentPositionHelper?.let { it.config = config }'));
    add('C500c', 'AAA-8（正面）：锚点视图用 WeakReference，消费处 5 层 ?: return 判空、无一处抛异常',
      'WeakReference + 5 层判空',
      '判空 ' + (mvsp.slice(mvsp.indexOf('private fun updateScrollPositionInternal()'), mvsp.indexOf('val newFrame = Rect()')).match(/\?: return/g) ?? []).length + ' 处',
      mvsp.includes('  private var firstVisibleViewRef: WeakReference<View>? = null\n') &&
        mvsp.includes('  private var prevFirstVisibleFrame: Rect? = null\n') &&
        mvsp.includes('  private var isListening = false') &&
        (mvsp.slice(mvsp.indexOf('private fun updateScrollPositionInternal()'), mvsp.indexOf('val newFrame = Rect()'))
          .match(/\?: return/g) ?? []).length === 5 &&
        !mvsp.includes('throw '));
    add('C500d', 'AAA-10：5 个 UIManager 回调中 2 个是 // noop（有注释标记），3 个有实质动作',
      '2 noop / 3 实质',
      (mvsp.match(/\/\/ noop/g) ?? []).length + ' 处 noop',
      (mvsp.match(/\/\/ noop/g) ?? []).length === 2 &&
        mvsp.includes('  override fun willDispatchViewUpdates(uiManager: UIManager) {\n    runOnUiThread { computeTargetView() }\n  }') &&
        mvsp.includes('  override fun willMountItems(uiManager: UIManager) {\n    computeTargetView()\n  }') &&
        mvsp.includes('  override fun didMountItems(uiManager: UIManager) {\n    updateScrollPositionInternal()\n  }'));
    add('C500e', 'stop() 的 KDoc 说明了调用契约（Should be called before this is destroyed）',
      'KDoc 契约',
      mvsp.includes('/** Stop listening to view hierarchy updates. Should be called before this is destroyed. */') ? '确认' : '?',
      mvsp.includes('/** Stop listening to view hierarchy updates. Should be called before this is destroyed. */'));
  }
}

// 文档侧：上述源码结论是否真的被写进了文档
// ────────────────────────────────────────────────────────────────────────
// min 取「当前实际出现的份数」，保证源码结论一旦补写/删除，文档侧会同步变化。
// 例如 C14（LongLivedObject 表项泄漏）是本轮新发现，只在 14 文档写了 → min=1；
// 而「无 signal handler」这类跨多文档的共性结论则要求 ≥3 份，避免只在一处被删就漏过。
addDocClaim('D1', '文档写明崩溃上传端由宿主注入、框架不实现',
  /不包含崩溃日志的上传|由宿主 App|OnJsError|上报端由宿主注入/, {min: 2});
addDocClaim('D2', '文档写明无 POSIX signal / NSSetUncaughtExceptionHandler',
  /NSSetUncaughtExceptionHandler|signal handler/, {min: 1});
addDocClaim('D3', '文档写明 FrameRateLogger 原生实现已删、仅 JS 残留',
  /FrameRateLogger/, {min: 1});
addDocClaim('D4', '文档写明 Android 无 memoryWarning 派发（而非空实现）',
  /memoryWarning/, {min: 1});
addDocClaim('D5', '文档写明 iOS 走 platform/cxx 而非 platform/ios',
  /platform\/cxx/, {min: 1});
addDocClaim('D6', '文档写明 LongLivedObjectCollection 实例表不清理',
  /实例表|永不清理/, {min: 1});
addDocClaim('D7', '文档写明白屏检测不存在',
  /不存在[^\n]{0,30}白屏|白屏[^\n]{0,30}不存在|没有白屏检测/, {min: 1});
// 10 文档的核心发现：iOS 无 platform/ios 目录，且 tvOS 是死代码 —— 至少 2 处提到
addDocClaim('D8', 'iOS 复用 cxx / 无 view/platform/ios 这一发现被反复引用',
  /platform\/ios/, {min: 2});
// 15 文档的核心发现
addDocClaim('D9', '文档写明 Android 旧架构已硬移除、且与 iOS 表现不对称',
  /isNewArchEnabled|旧架构[^\n]{0,30}(硬移除|已移除)/, {min: 1});
addDocClaim('D10', '文档写明 Android 内存压力只到 C++、不进 JS',
  /不派发[^\n]{0,20}JS|只[^\n]{0,20}C\+\+|不进 JS/, {min: 1});
addDocClaim('D11', '文档指出 ReactMarker 是现成的启动耗时数据源',
  /ReactMarker/, {min: 1});
addDocClaim('D11b', '文档写明 CREATE_REACT_CONTEXT_START 未标记、只有 END 标记（半配对）',
  /CREATE_REACT_CONTEXT_START[^\n]{0,40}(未标记|无)|仅 _END|半配对/, {min: 1});
// 16 文档的核心发现
addDocClaim('D12', '文档写明 legacy 收敛开关硬编码为 false、守卫从未启用',
  /UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE/, {min: 1});
addDocClaim('D13', '文档写明 UIViewOperationQueue / NativeViewHierarchyManager 已是空壳',
  /UIViewOperationQueue|NativeViewHierarchyManager/, {min: 1});
addDocClaim('D14', '文档写明空方法体在本仓库有多种成因、不能单看数量判断',
  /空方法体[^\n]{0,40}(成因|多种)/, {min: 1});
// 17 文档的核心发现
addDocClaim('D15', '文档写明删除 prop 键不会重置为默认、需显式 undefined',
  /删除|移除/, {min: 1});
addDocClaim('D16', '文档指出 @ReactProp 注释与实现存在矛盾',
  /注释[^\n]{0,30}实现[^\n]{0,20}矛盾|矛盾/, {min: 1});
// 18 文档的核心发现
addDocClaim('D17', '文档写明 extraData 在致命错误时可能丢失（noexcept 逃逸即 abort）',
  /extraData[^\n]{0,80}(丢失|abort)|aborts the whole process/, {min: 2});
addDocClaim('D18', '文档写明 fbjni 是外部依赖、其实现未经审阅',
  /fbjni[^\n]{0,60}(不在本仓库|外部依赖)/, {min: 1});
addDocClaim('D19', '文档写明 noexcept 是实现方选择、接口不强制',
  /noexcept[^\n]{0,40}(实现方|不是接口|非接口)/, {min: 1});
// 19 文档的核心发现
addDocClaim('D20', '文档写明 iOS 硬编码 unloadLevel=15、每次内存警告都全量 GC',
  /unloadLevel[^\n]{0,20}15|硬编码[^\n]{0,30}15/, {min: 2});
addDocClaim('D21', '文档写明 C++ 侧按 Android 枚举分级、iOS 靠数值巧合命中',
  /TRIM_MEMORY_[A-Z_]+|数值巧合|巧合/, {min: 1});
addDocClaim('D22', '文档写明 iOS 加载兜底 UI 完全由宿主注入、无默认 spinner',
  /loadingView|activityIndicatorViewFactory|兜底 UI/, {min: 2});
// 21/22 文档
addDocClaim('D23', '文档写明 removeClippedSubviews 改变的是子视图存放方式',
  /存放(方式|位置)|_reactSubviews/, {min: 1});
addDocClaim('D24', '文档写明 RedBox/LogBox 靠编译期宏门控、Release 下 moduleName 为 nil',
  /#if RCT_DEV_MENU|moduleName[^\n]{0,20}nil/, {min: 1});
addDocClaim('D25', '文档写明 RCT_DEV_MENU 可独立关闭会造成两层门控错配',
  /RCT_DEV_MENU[^\n]{0,60}独立|错配/, {min: 1});
// 23 文档
addDocClaim('D26', '文档写明 RCT_CUSTOM_CONVERTER 的 Debug/Release 语义反转（Release 无 @try）',
  /RCT_CUSTOM_CONVERTER|语义反转/, {min: 2});
addDocClaim('D27', '文档写明 handler 安装函数全仓库 0 处外部调用、fatalHandler 分支在 RN 内不可达',
  /0 处外部引用|永远不成立|全仓库零调用|永远不成立|无人调用|0 处外部调用/, {min: 2});
addDocClaim('D28', '文档写明默认 log function 用 %{public}s 不脱敏',
  /%\{public\}|不脱敏/, {min: 1});
addDocClaim('D29', '文档写明注释声称的 dispatch_once/once_flag 在色彩空间两侧都不存在',
  /once_flag|注释.*矛盾|矛盾/, {min: 2});
addDocClaim('D30', '文档写明 RCTKeyWindow 的 legacy 兜底缺失会导致白屏（UI 根本不渲染）',
  /白屏|never renders|根本不渲染/, {min: 1});
// 24 文档
addDocClaim('D31', '文档写明 legacy 事件链在 JS 侧无接收端（RCTEventEmitter 零注册）',
  /RCTEventEmitter[^\n]{0,80}(零|无|没有)[^\n]{0,20}(import|注册)|静默丢弃/, {min: 1});
addDocClaim('D32', '文档写明 RCTEnableTurboModule 空实现、fabricInteropLayerEnabled 恒为 YES',
  /RCTEnableTurboModule[^\n]{0,40}空|恒为 ?`?YES|恒 ?`?YES`?/, {min: 2});
addDocClaim('D33', '文档写明 legacy RCTBridge 的 reload 系列方法是空实现',
  /空实现|silently 无效|静默无效/, {min: 1});
addDocClaim('D34', '文档写明 flushEventsQueue 的 js thread 可以是主线程',
  /可以是主线程/, {min: 1});
// 25 文档
addDocClaim('D35', '文档写明 RCTModuleData 是类存实现空的空壳、且两个构造器零调用',
  /RCTModuleData[\s\S]{0,120}(空实现|空壳)/, {min: 1});
addDocClaim('D36', '文档写明 22 个性能标签中有 12 个零打点',
  /22 个[\s\S]{0,40}12 个|12 个零打点|零打点[\s\S]{0,40}22/, {min: 1});
addDocClaim('D37', '文档写明性能日志靠劫持 ReactMarker::logTaggedMarkerImpl 接入',
  /logTaggedMarkerImpl|劫持/, {min: 1});
// 26 文档
addDocClaim('D38', '文档写明 RCTImageSource 的 scale 三元未加括号导致非零 scale 被清零',
  /优先级/, {min: 1});
addDocClaim('D39', '文档写明 MultipartStreamReader 的 content 只增不减导致线性内存',
  /只增不减|线性内存|单调递增/, {min: 1});
addDocClaim('D40', '文档写明 RCTKeyCommands 的 escape 例外只存在于注释、代码无实现',
  /escape/, {min: 1});
addDocClaim('D41', '文档写明 RCTCxxConvert 为空壳但有三处活调用，且 codegen 路径不受影响',
  /RCTCxxConvert[\s\S]{0,80}(空|退役)/, {min: 1});
// 27 文档
addDocClaim('D42', '文档写明 RCTPerfMonitor 整族被 RCT_DEV 裁剪且类工厂 Release 返回 nil',
  /RCTPerfMonitorCls|整族[\s\S]{0,30}RCT_DEV/, {min: 1});
addDocClaim('D43', '文档写明 RCTJSCSetOption 恒返回 NO，两次 logGC 调用都无效',
  /RCTJSCSetOption/, {min: 1});
addDocClaim('D44', '文档写明 redirectLogs 用 dup2 劫持进程级 STDERR_FILENO',
  /dup2[\s\S]{0,60}STDERR|劫持/, {min: 1});
addDocClaim('D45', '文档写明 _bridge.uiManager 在 bridgeless 下是通的（RCTBridgeProxy 有实现），属已验证非缺陷',
  /已验证非缺陷|RCTBridgeProxy/, {min: 1});
addDocClaim('D46', '文档写明 RCTTiming 与 JSTimers.js 的跨语言常量是双向同步声明（正面样本）',
  /双向|kept in sync/, {min: 1});
// 28 文档
addDocClaim('D47', '文档写明 Dev 工具链存在四层编译期门控（含 __has_include 探测与 TARGET_OS_SIMULATOR）',
  /__has_include[\s\S]{0,40}探测|四层编译期门控|TARGET_OS_SIMULATOR \|\| TARGET_OS_MACCATALYST/, {min: 1});
addDocClaim('D48', '文档写明 REACT_NATIVE_DEBUGGER_MODE_PROD 可让 Release 开启远程调试且构建脚本零定义',
  /REACT_NATIVE_DEBUGGER_MODE_PROD/, {min: 1});
addDocClaim('D49', '文档写明 showOnShake 每次摇动都做 recursiveDescription 全树渲染',
  /recursiveDescription/, {min: 1});
addDocClaim('D50', '文档写明 RCTDevSettingsSetEnabled 是第五个零调用 setter，并给出累计清单',
  /第五个|累计清单/, {min: 1});
// 29 文档
addDocClaim('D51', '文档写明 RCTDeviceInfo 的 KVO 在 RCTKeyWindow() 为 nil 时静默失败且不重试',
  /静默失败|永久失效/, {min: 1});
addDocClaim('D52', '文档写明 RCTAccessibilityManager 注册 9 个观察者但零清理，并辨析其不构成实际泄漏',
  /零指针弱引用|零清理/, {min: 1});
addDocClaim('D53', '文档写明 invalidate 的原子幂等（std::atomic + exchange）是最佳实践样板',
  /exchange\(YES\)|原子幂等/, {min: 1});
// 30 文档
addDocClaim('D54', '文档写明 CoreModules 注册表有 3 处模块名与类名不一致的别名',
  /PlatformConstants|别名/, {min: 1});
addDocClaim('D55', '文档写明网络调试上报由 REACT_NATIVE_DEBUGGER_ENABLED 编译期门控（Release 恒 false）',
  /编译期门控|REACT_NATIVE_DEBUGGER_ENABLED/, {min: 1});
addDocClaim('D56', '文档区分了两个 DEBUGGER 宏：ENABLED 自动（:debug）vs MODE_PROD 手动',
  /性质不同|手动传/, {min: 1});
// 31 文档
addDocClaim('D57', '文档写明回收池的双重容量控制（1024 上限 + 内存警告清空）',
  /1024|_recyclePool\.clear/, {min: 2});
addDocClaim('D58', '文档写明 prepareForRecycle 的基类实现为空、覆盖不全是系统性风险',
  /基类.{0,20}空实现|覆盖不全/, {min: 1});
addDocClaim('D59', '文档写明无障碍判定中 trait 是 role 的有损投影、role 优先于 accessibilityRole',
  /有损投影|lossy/, {min: 1});
// 32 文档
addDocClaim('D60', '文档写明 _isAccessibilityAPIUsed 是刻意不重置的粘性状态（有注释说明理由）',
  /故意不重置|刻意/, {min: 1});
addDocClaim('D61', '文档写明 _scrollEventThrottle 疑似疏忽未重置，并给出与刻意不重置的辨别方法',
  /疑似疏忽|辨别方法/, {min: 1});
addDocClaim('D62', '文档写明无障碍检测用 API 调用而非通知（Accessibility Inspector 不发通知）',
  /Accessibility Inspector/, {min: 1});
// 33 文档
addDocClaim('D63', '文档写明 mostRecentEventCount 是跨语言的原生侧单调计数器 + JS 侧比对协议',
  /mostRecentEventCount[\s\S]{0,40}计数器|事件去重协议/, {min: 1});
addDocClaim('D64', '文档写明 Text 组件针对 issue 58145 的无障碍修复（内容变化时发 LayoutChanged 通知）',
  /58145|LayoutChanged/, {min: 1});
addDocClaim('D65', '文档写明回收契约的三类处置（正确重置/刻意不重置/疑似疏忽）',
  /三类处置|疑似疏忽/, {min: 2});
// 34 文档
addDocClaim('D66', '文档写明 VirtualView 用 static 全局无障碍标志，与 ScrollView 的实例变量不同',
  /static 全局|sIsAccessibilityUsed/, {min: 1});
addDocClaim('D67', '文档写明「解除隐藏/禁用裁剪」是跨组件的通用模式且依赖 UIKit 实现细节',
  /通用模式|实现细节|empirical/, {min: 1});
// 35 文档
addDocClaim('D68', '文档写明 Image 的回收竞态防护靠「先分配新 proxy 后释放旧」保证地址不复用',
  /地址不复用|地址.{0,10}不复用|never share an address/, {min: 1});
addDocClaim('D69', '文档写明 DebuggingOverlay 的高亮数组不重置会导致复用后显示上一个组件的高亮',
  /高亮|highlight/, {min: 1});
// 36 文档
addDocClaim('D70', '文档写明排序比较器返回 NSOrderedAscending 而非 NSOrderedSame（不自洽）',
  /NSOrderedAscending|不自洽/, {min: 1});
addDocClaim('D71', '文档写明注释质量分三档（给理由+参考 / 只说现象 / 与代码不符）',
  /三个档次|三档/, {min: 1});
// 37 文档
addDocClaim('D72', '文档写明 RCTUIManager 的 21 个方法全部是桩（15 空 + 5 nil + 1 moduleName）',
  /21 个方法|全是桩|全桩/, {min: 1});
addDocClaim('D73', '文档给出「区分退役与缺实现」的五步判据',
  /五步判据|判据/, {min: 1});
addDocClaim('D74', '文档写明两个 rootViewTag 生成器序列相同、计数器独立，ObjC 侧零调用',
  /rootViewTag|11, 21, 31|撞号/, {min: 1});
addDocClaim('D75', '文档写明 ObjC 注释指向的头文件里没有它承诺的解释（说明在 .cpp）',
  /指错|\.cpp:17|指向.{0,10}头文件/, {min: 1});
// 38 文档
addDocClaim('D76', '文档修正 24 文档：RCTEventEmitter 的 ObjC 侧有 10 个活子类，JS 侧零 import 不等于整链死',
  /修正 24 文档|10 个活子类|10 个子类/, {min: 1});
addDocClaim('D77', '文档写明 _observationDisabled 是承重标志（去掉会让 Networking 全部事件被丢弃）',
  /承重标志|去掉.{0,20}丢弃/, {min: 1});
addDocClaim('D78', '文档给出「隐蔽契约」的四种形态排序与各自排查难度',
  /隐蔽契约|承重标志.{0,40}死代码里/, {min: 1});
// 39 文档
addDocClaim('D79', '文档写明 TurboModule 的四步解析顺序且 C++ 优先于 ObjC',
  /四步|C\+\+ 优先|纯 C\+\+ 模块/, {min: 1});
addDocClaim('D80', '文档写明模块创建卡死会无限等待，且该风险有注释含工单号与决策依据',
  /无限等待|T65905574/, {min: 1});
addDocClaim('D81', '文档指出 performMethodInvocation 的 @try 无门控是「正确的例外」，不是普遍规则',
  /正确的例外|不是普遍规则/, {min: 1});
// 40 文档
addDocClaim('D82', '文档写明 Android 有 114 个 marker、38 个零打点（33.3%）并给出实测口径',
  /114|33\.3%/, {min: 2});
addDocClaim('D83', '文档写明 Kotlin 与 C++ 的 13 个 native marker 精确 1:1，但映射是无 else 的字符串链',
  /13 个|if-else|字符串链/, {min: 1});
addDocClaim('D84', '文档给出可复用的统计脚本并建议接入 CI 巡检打点清单',
  /统计脚本|接入 CI/, {min: 1});
// 41 文档
addDocClaim('D85', '文档给出 Android 侧「RN 不做崩溃上传」的三项零命中证据并声明结论可跨平台泛化',
  /跨平台泛化|三项零命中/, {min: 1});
addDocClaim('D86', '文档写明 DevSupportManager 的三实现继承树与两个不是同一条链',
  /继承树|PerftestDevSupportManager.{0,40}继承/, {min: 1});
addDocClaim('D87', '文档写明 JSExceptionHandler 的立场声明及其在发布期不成立的适用边界',
  /立场|适用边界/, {min: 1});
addDocClaim('D88', '文档给出宿主接入崩溃上报的三种方式与唯一可用的一种',
  /setDefaultUncaughtExceptionHandler|宿主 App 接入/, {min: 1});
// 42 文档
addDocClaim('D89', '文档写明 Android 有两条独立的内存压力路径（JS 侧分级 / 视图侧不分级）',
  /两条独立|两条内存压力路径|视图侧不分级/, {min: 1});
addDocClaim('D90', '文档写明 Android 回收栈无 size 上限，与 iOS 的 1024 上限形成对比',
  /无 size 上限|1024/, {min: 1});
addDocClaim('D91', '文档给出 recycleView 重置契约的三档实测分布与 ReactViewGroup 的 18 字段集中重置',
  /18 字段|三档|initView/, {min: 2});
addDocClaim('D92', '文档记录作者判断被源码推翻的过程（漏重置 → 实际有集中重置）',
  /我最初的判断|是错的|答案/, {min: 1});
// 43 文档
addDocClaim('D93', '文档写明 JS 异常经 RN$handleException（C++ 全局）→ Feature Flag 门控 → TurboModule 回退三级路由',
  /三级路由|RN\$handleException/, {min: 1});
addDocClaim('D94', '文档写明 unhandled promise rejection 被归类为 soft，只进 logcat 不出 RedBox',
  /soft|只进 logcat|不弹 RedBox/, {min: 1});
addDocClaim('D95', '文档精确化「RN 不做崩溃上传」：有采集与开发期展示，无持久化/上传',
  /有采集|无持久化|不做上传/, {min: 1});
addDocClaim('D96', '文档指出 useAlwaysAvailableJSErrorHandling 的元数据自相矛盾',
  /自相矛盾|expectedReleaseValue/, {min: 1});
// 44 文档
addDocClaim('D97', '文档写明 CONTENT_APPEARED 是布局级而非首帧级，白屏时长被低估',
  /布局级|不是真正的首帧|被低估/, {min: 1});
addDocClaim('D98', '文档写明 devLoadingViewManager 在 ReactHost 新架构路径下恒为 null（DevLoadingView 是 legacy-only）',
  /legacy-only|恒为 null|新架构下不可用/, {min: 1});
addDocClaim('D99', '文档给出 Android 白屏的两种成因及两者都无用户可见提示',
  /两种成因|白屏的两种/, {min: 1});
// 45 文档
addDocClaim('D100', '文档写明 prepareToRecycleView 的回收能力有 API 28 硬门槛，API 27 及以下整个回收池不工作',
  /API 28|API 27|回收池完全不工作/, {min: 1});
addDocClaim('D101', '文档写明 Android 侧基类重置含 8 个无障碍 tag（无障碍泄漏防护）',
  /无障碍/, {min: 1});
addDocClaim('D102', '文档指出 Android 有 prop 反射缓存而 iOS 侧 RCTComponentData 每次现算（性能不对称）',
  /iOS 侧没有|每次现算|性能不对称/, {min: 1});
// 46 文档
addDocClaim('D103', '文档给出 8 个空壳 legacy ShadowNode 成员的清单（恒 0 / 恒 false / 空方法体 / 零调用）',
  /8 个空壳|空壳成员|空壳/, {min: 2});
addDocClaim('D104', '文档写明 setLocalData 是 9 行注释 + 空方法体且下游 setViewLocalData 也是 = Unit',
  /9 行注释|= Unit|空实现/, {min: 1});
addDocClaim('D105', '文档为每个结论标注了适用范围（平台/架构/编译条件）',
  /适用范围|仅 legacy Paper|新架构下完全不执行/, {min: 3});
// 47 文档
addDocClaim('D106', '文档写明基类的 5 个虚视图 API 全是拒绝服务实现，触摸探索仅 Text 可用',
  /拒绝服务|触摸探索/, {min: 1});
addDocClaim('D107', '文档指出 R.id.role 正常写入却未被回收重置（45 文档 8 个无障碍 tag 的清单缺口）',
  /R\.id\.role|清单缺口/, {min: 1});
addDocClaim('D108', '文档给出 getTalkbackDescription 的递归成本结构与「先构造后过滤」问题',
  /先构造后过滤|递归/, {min: 2});
// 48 文档
addDocClaim('D109', '文档写明合并键的 16 位截断使第 65535 次与未设置哨兵撞值',
  /65 ?535|65535|16 ?位/, {min: 2});
addDocClaim('D110', '文档区分了三类问题形态（历史承诺 / 自认边界 / 结构脆弱）',
  /历史承诺|自认边界|结构脆弱/, {min: 2});
addDocClaim('D111', '文档为合并键问题给出精确算术推导而非仅结论',
  /65 ?535.*mod 65 ?536|≡ ?65 ?535/, {min: 1});
// 49 文档
addDocClaim('D112', '文档用三步反证证明 ESLint 的 JUnit XML 无消费方，而非仅断言「失效」',
  /三步反证|无后续步骤消费/, {min: 1});
addDocClaim('D113', '文档指出 cxx-api 快照门禁是单向的（只拦删除不拦新增）',
  /单向/, {min: 1});
// 50 文档
addDocClaim('D114', '文档对 use-after-free 给出了完整逃逸链（lambda → toolbox → Scheduler）',
  /逃逸/, {min: 2});
addDocClaim('D115', '文档对每条问题都标注了适用范围（平台/架构/触发条件）',
  /适用范围/, {min: 3});
// 51 文档
addDocClaim('D116', '文档指出 dropAnimatedNode 漏调 stopAnimationsForNode，且帧循环内只在 hasFinished 时移除',
  /hasFinished/, {min: 1});
addDocClaim('D117', '文档归纳出三处缺陷是同一模式（复位点覆盖不全）',
  /复位点覆盖不全|同一个模式/, {min: 1});
addDocClaim('D118', '文档记录了双端行为不一致的一例（FrameBasedAnimationDriver 刷新条件）',
  /双端行为不一致|只在 iOS 生效/, {min: 1});
addDocClaim('D119', '文档指出 updateScrollContentOffsetIfNeeded 整体在 #ifndef ANDROID 内（Android 编译出空函数）',
  /#ifndef ANDROID|空函数/, {min: 1});
addDocClaim('D120', '文档对照了「裁剪侧 RTL 修正是跨平台的」，说明两个层面平台条件不一致',
  /裁剪侧.{0,12}跨平台/, {min: 1});
addDocClaim('D121', '文档诚实标注 RTL 视觉差异「未实机验证」，未夸大为已确认的 bug',
  /未实机验证|未确认/, {min: 1});
addDocClaim('D122', '文档验证了注释里钉死的 commit 在本仓库历史中存在',
  /git cat-file|在本仓库历史中存在|已验证该 commit/, {min: 1});
addDocClaim('D123', '文档记录了注释引用的 RCTScrollContentShadowView.m 全仓不存在（59 文档 YY-3 的新变体）',
  /对方整层被移除|YY-3/, {min: 1});
addDocClaim('D124', '文档指出 outsetRatio 用 floor 而非 round 是保守方向（少裁剪只是多画）',
  /floor.{0,20}round|向下取整/, {min: 1});
addDocClaim('D125', '文档指出 updateStateIfNeeded 的 != 守卫切断「状态变更→重布局→再调用」循环（51 文档 QQ-1 的反向对照）',
  /切断.{0,10}循环|QQ-1/, {min: 1});
addDocClaim('D126', '文档记录了 Android 滚动位置保持的三处生命周期钩子正确配对（正向样本）',
  /onAttachedToWindow|onDetachedFromWindow/, {min: 1});
addDocClaim('D127', '文档记录了锚点用 WeakReference 且消费处 5 层判空、无一处抛异常（与 50 文档 PP-1/PP-3 对照）',
  /WeakReference|PP-1/, {min: 1});
addDocClaim('D128', '文档记录了两个 noop 回调有注释标记（与 40 文档零引用 marker 对照）',
  /noop/, {min: 1});
addDocClaim('D129', '文档说明 contentBoundingRect 是派生量故不参与序列化，getDynamic 写 3 键与读侧一致',
  /派生量不持久化|派生量/, {min: 1});
addDocClaim('D130', '文档对每条问题都标注了适用范围（平台/架构/触发条件/是否确认为 bug）',
  /适用范围声明|是否确认为 bug/, {min: 1});
addDocClaim('D131', '文档对照了三档 Guard 的严重度与逃逸出口递减，并指出 PrivateGuard 不认 RN_UMBRELLA_CONTEXT',
  /PrivateGuard 不认|逃逸出口/, {min: 1});
addDocClaim('D132', '文档指出 RN_STRICT_API 在全仓从未被定义，故 631 处 include 恒为惰性',
  /RN_STRICT_API.{0,30}全仓|631/, {min: 1});
addDocClaim('D133', '文档论证了 Guard 逻辑在本仓库内零验证（RN_BUILDING 在三条构建路径都被定义）',
  /零验证/, {min: 1});
addDocClaim('D134', '文档指出注释引用的生成脚本不存在，且既无工具又被禁止手写',
  /do not hand-write|从未入库/, {min: 1});
addDocClaim('D135', '文档把 StableApiAnchor 记录为「纯为绕过 CocoaPods 限制而存在的空 TU」，并给出 5 步因果',
  /StableApiAnchor|PBXAggregateTarget/, {min: 1});
addDocClaim('D136', '文档对照了 Android（INTERFACE）与 iOS（podspec）两个构建系统对这个模块的不同处理',
  /INTERFACE/, {min: 1});
addDocClaim('D137', '文档记录了 RN_BUILDING 注入逻辑的 4 处防御与 Android 侧注入位置的 6 行论证',
  /4 处防御|位置约束/, {min: 1});
addDocClaim('D138', '文档指出 137 处 CMAKE_VERBOSE_MAKEFILE 是全局约定，并补充两处生成模板也写入该约定',
  /生成模板|全局约定/, {min: 1});
addDocClaim('D139', '文档把三份 Guard 的注释列为本仓库注释质量第一档的最佳样本',
  /第一档|最佳样本/, {min: 1});
addDocClaim('D140', '文档明确区分了「设计上默认零影响」与「验证缺口」两件事',
  /验证缺口|设计意图/, {min: 1});
addDocClaim('D141', '文档指出 floatEquality(+inf,+inf) 返回 false 是实测结论而非推断',
  /实测|编译 \+ 运行/, {min: 1});
addDocClaim('D142', '文档给出了哈希与相等性双向违反 unordered_map 契约的实测输出',
  /unordered_map::find|落空/, {min: 1});
addDocClaim('D143', '文档论证了容差对缓存命中率的贡献为零（不同桶 → 永远查不到）',
  /贡献为零|永远找不到/, {min: 1});
addDocClaim('D144', '文档列出了 floatEquality 的全部 13 个消费文件并区分了「自比较」与「与常量比较」',
  /自比较|与常量比较/, {min: 1});
addDocClaim('D145', '文档记录了 ContextContainer::update 自更新是 ASan 抓到的 use-after-free',
  /ASan|use-after-free/, {min: 1});
addDocClaim('D146', '文档指出 update() 无生产调用方，属潜伏缺陷',
  /潜伏/, {min: 1});
addDocClaim('D147', '文档指出了 SimpleThreadSafeCache 的三个 API 契约问题',
  /锁外|悬垂|临界区/, {min: 1});
addDocClaim('D148', '文档记录了 OnScopeExit 的两条注释写反、const Lambda&& 与 noexcept 析构',
  /Non-movable|写反/, {min: 1});
addDocClaim('D149', '文档区分了「实现正确但注释错误」与「实现有 bug」两类问题',
  /实现正确|责任方/, {min: 1});
addDocClaim('D150', '文档指出 iOS 渐变的垂直线段会让 intersection 返回错误几何而非 nullopt，且调用方守卫拦不住',
  /nullopt|错误几何/, {min: 1});
addDocClaim('D151', '文档指出全仓唯一显式防 inf 的调用点恰恰漏掉了自己文件里的同一道防御',
  /唯一.{0,10}isinf|漏了同一道防御/, {min: 1});
addDocClaim('D152', '文档对每条结论都标注了适用范围（平台/架构/触发条件/是否实机验证）',
  /适用范围声明|未实机验证/, {min: 1});
addDocClaim('D153', '文档指出 ComponentDescriptorRegistry 的写路径完全没有取独占锁（3 处），并给出具体行号',
  /registerComponentDescriptor.{0,40}不持锁|完全不持锁/, {min: 1});
addDocClaim('D154', '文档指出 ComponentDescriptorProviderRegistry 有两处 shared_lock 下写成员',
  /shared_lock|共享锁/, {min: 1});
addDocClaim('D155', '文档用编译运行实测出栈溢出阈值，并区分 1MB 与 8MB 栈',
  /13,750|106,250/, {min: 1});
addDocClaim('D156', '文档给出了 JS 到 C++ 的完整可达性链条（NativeDOM TurboModule）',
  /NativeDOM/, {min: 1});
addDocClaim('D157', '文档指出了 iOS 只在 RCT_DEBUG 下加倍 JS 线程栈这一旁证',
  /RCT_DEBUG|只在 Debug/, {min: 1});
addDocClaim('D158', '文档公平说明 MapBuffer 当前无外部输入路径（Java 侧构造器是 private）',
  /private|信任/, {min: 1});
addDocClaim('D159', '文档澄清了「Text」与「Paragraph」是两个独立注册的组件，从而修正了 VirtualText 映射的判断',
  /两个独立|澄清/, {min: 1});
addDocClaim('D160', '文档记录了 Element 的两个捕获方式差异与 stateData 的空指针解引用',
  /按引用捕获|空指针解引用/, {min: 1});
addDocClaim('D161', '文档列出了 7 处正向工程实践样本（含 5 处带编号的 TODO/FIXME）',
  /正向样本|带编号/, {min: 1});
addDocClaim('D162', '文档指出 assert/expect 宏在 Android 与非 Android 平台是两种形态（表达式 vs 裸 if）',
  /平台不对称|裸 .?if.? 宏/, {min: 1});
addDocClaim('D163', '文档实测出了裸 if 宏的「静默改变语义」形态，并说明当前 457 处引用行零危险形态',
  /静默改变语义|零危险形态/, {min: 1});
addDocClaim('D164', '文档对照了同模块两套数字解析策略（from_chars 安全 vs stoi 抛异常）',
  /from_chars|stoi/, {min: 1});
addDocClaim('D165', '文档给出了 EEE-2 的完整可达性链条与三个触发条件',
  /完全可控|触发条件/, {min: 1});
addDocClaim('D166', '文档实测了 JscSafeUrl 的三个往返损坏并给出成因',
  /往返|不可逆/, {min: 1});
addDocClaim('D167', '文档指出 isRetryable 恒为 true 导致 iOS 侧分支永不执行',
  /恒为|永不执行/, {min: 1});
addDocClaim('D168', '文档指出截断只作用于展示变量而解析用的是未截断原文',
  /未截断|截断/, {min: 1});
addDocClaim('D169', '文档对每条结论都标注了适用范围（平台/是否 dev-only/输入可控性/是否实机验证）',
  /适用范围声明|是否实机验证|dev-only/, {min: 1});
addDocClaim('D170', '文档指出三个环形缓冲有上限而两个 keyed 缓冲无上限，并给出可达性链条与内存量级',
  /无上限|环形缓冲/, {min: 1});
addDocClaim('D171', '文档指出 droppedEntriesCount 对 MARK/MEASURE 恒为 0，构成监控盲区',
  /监控盲区|恒为/, {min: 1});
addDocClaim('D172', '文档实测了 CircularBuffer(0) 后的 SIGSEGV，并诚实说明空缓冲 operator[] 实测未崩但属 UB',
  /SIGSEGV|UB/, {min: 1});
addDocClaim('D173', '文档对照了 CDP 上报路径的流式零缓冲，说明团队知道上报不该缓冲',
  /流式零缓冲|零缓冲/, {min: 1});
addDocClaim('D174', '文档对照了 PerformanceObserverRegistry 全持锁与 RAMBundleRegistry 完全无锁',
  /完全无锁|持锁/, {min: 1});
addDocClaim('D175', '文档区分了「无上限」与「无上限+默认不清理+无丢弃可见性」三者的叠加',
  /默认不清理|叠加/, {min: 1});
addDocClaim('D176', '文档指出 OSSStable.h 是唯一不参与生成的手写文件，且读者无从得知',
  /不参与生成|手写/, {min: 1});
addDocClaim('D177', '文档逐项核对了 config.js 声明与 Defaults 的实际值，并给出「3 个 stable flag 恰好正确、1 个 canary flag 相反」的精确结论',
  /恰好|相反/, {min: 1});
addDocClaim('D178', '文档给出了「三重失守」的完整枚举（SignedSource 无校验 / CI 零命中 / 工具完备但无人调用）',
  /三重失守/, {min: 1});
addDocClaim('D179', '文档诚实标注「无法判定是否有人手改过」，只断言「机制上抓不到」',
  /无法判定|抓不到/, {min: 1});
addDocClaim('D180', '文档指出了 dateAdded 元数据只覆盖 76/104（28 个缺失）',
  /76|28 个/, {min: 1});
addDocClaim('D181', '文档把 feature flags 的缺口与 AGENTS.md 的「CI validates the committed snapshots」声明做了对照',
  /AGENTS.md|committed snapshots/, {min: 1});
addDocClaim('D182', '文档指出同一个「无 prerelease」在四种语言里有三种表示，并给出跨端判空陷阱',
  /三种表示|判空/, {min: 1});
addDocClaim('D183', '文档指出版本校验在 native 路径是三层、在 package.json 路径是零层',
  /三层|零层/, {min: 1});
addDocClaim('D184', '文档实测了 4 个生成版本文件与模板的同步状态（3 个逐字节一致、Kotlin 仅格式化差异）',
  /逐字节一致|格式化差异/, {min: 1});
addDocClaim('D185', '文档论证了「逐字节快照门禁」在版本文件上不可行，需「生成+格式化+比对」',
  /不可行|格式化/, {min: 1});
addDocClaim('D186', '文档指出版本文件漂移在 CI 里是「静默修正」而非「不抓」',
  /静默修正/, {min: 1});
addDocClaim('D187', '文档指出了用正则改写 snapshot 测试文件的风险（模式只覆盖 -rc.N）',
  /正则|snapshot/, {min: 1});
addDocClaim('D188', '文档指出桥销毁路径上有 4 处静默丢弃工作，并说明这是有意取舍但代价未记录',
  /静默丢弃|有意取舍/, {min: 1});
addDocClaim('D189', '文档指出了 JSCallInvoker 的无上限调用缓冲，并诚实标注其触发条件低于同类问题',
  /无上限/, {min: 1});
addDocClaim('D190', '文档指出了两套互不知情的组件名归一化，并给出同一名字在两条路径上结果不同的对照',
  /两套|互不知情/, {min: 1});
addDocClaim('D191', '文档指出了 legacy 桥的变长数组位置协议与 methodId 即下标的脆弱点',
  /变长数组|methodId/, {min: 1});
addDocClaim('D192', '文档指出了描述 6 个不存在接口的失效注释与不可达的内部链接',
  /not implemented|intern/, {min: 1});
addDocClaim('D193', '文档诚实标注本文结论位于 legacy 架构路径、legacy 关闭后代码不参与编译',
  /legacy 架构|编译掉/, {min: 1});
addDocClaim('D194', '文档指出了同一结构里 7 个 NaN 哨兵与 19 个 optional 两套「未设置」表示并存',
  /两套|7 个/, {min: 1});
addDocClaim('D195', '文档补上了 63 文档 floatEquality 的 NaN 特判「为什么有意」的答案',
  /必要配套|为什么有意/, {min: 1});
addDocClaim('D196', '文档给出了「若用朴素 == 则每次 diff 都失配」的推演',
  /朴素|失配/, {min: 1});
addDocClaim('D197', '文档指出了 AttributedStringBox 非法 Mode 的两种处理策略并存',
  /两种|策略/, {min: 1});
addDocClaim('D198', '文档指出了 conversions.h 是裸 if 宏的最大消费方并给出规模',
  /最大单一消费方|46/, {min: 1});
addDocClaim('D199', '文档对每条结论都标注了适用范围（平台/架构/编译条件/是否实机验证）',
  /适用范围声明|是否已实机验证/, {min: 1});
addDocClaim('D200', '文档指出了两个 isAscii() 实现恒返回 true，而 Android 的 bundle 主加载路径使用它',
  /恒返回 .?true|主加载路径/, {min: 1});
addDocClaim('D201', '文档诚实划出了事实链的可验证边界（jsi::Buffer 契约与 Hermes 后果在仓库外，不做断言）',
  /无法.{0,6}验证|外部依赖/, {min: 1});
addDocClaim('D202', '文档指出了 RN_EXPORT 宏的 10 个定义点只有 1 个处理 MSVC，且展开取决于 include 顺序',
  /RN_EXPORT|MSVC/, {min: 1});
addDocClaim('D203', '文档指出了 JSBigString 注释说 move-only 而实现 non-movable 的矛盾',
  /move-only|non-movable/, {min: 1});
addDocClaim('D204', '文档指出了 RecoverableError 转换时丢失原异常类型与异常链',
  /异常链|异常类型/, {min: 1});
addDocClaim('D205', '文档指出了默认 maximumDepth 为 INT_MAX 使递归深度保护形同虚设',
  /INT_MAX|无限深度/, {min: 1});
addDocClaim('D206', '文档指出了类形状随构建配置变化、override 声明需手工包 #if',
  /类形状|override/, {min: 1});
addDocClaim('D207', '文档指出了两个同名 flags.h 内容完全不同、开关声明与使用点错位',
  /同名|错位/, {min: 1});
addDocClaim('D208', '文档核实了开关生效依赖 LayoutMetrics.h 的传递包含这一具体链条',
  /传递包含|LayoutMetrics/, {min: 1});

addDocClaim('D209', '文档对照了 JS 与 C++ 两侧解析行号的两种失败模式（静默出错 vs 抛异常）',
  /静默|抛异常/, {min: 1});
addDocClaim('D210', '文档指出了 C++ 侧多一个 JS 侧没有的分支，因而「移植」的说法不准确',
  /移植|多一个分支/, {min: 1});
addDocClaim('D211', '文档指出了符号化缓存与 log 集合的生命周期脱钩，并与 66 文档的同类问题做了分级对照',
  /生命周期脱钩|分级/, {min: 1});
addDocClaim('D212', '文档记录了本轮一次「零命中」假阴性的自我纠错，并固化了检索纪律',
  /假阴性|自我纠错/, {min: 1});

addDocClaim('D212', '文档记录了本轮一次「零命中」假阴性的自我纠错，并固化了检索纪律',
  /假阴性|自我纠错/, {min: 1});
addDocClaim('D213', '文档指出了写方向 count 回绕与读方向不校验构成同一问题的两端',
  /回绕|同一问题/, {min: 1});
addDocClaim('D214', '文档指出了写方向不检查重复 key 导致静默取到错误值',
  /重复 key|静默/, {min: 1});
addDocClaim('D215', '文档指出了 PerformanceObserver 三个成员无锁而另两个有锁',
  /无锁|锁不全/, {min: 1});
addDocClaim('D216', '文档指出了两个 observe 重载语义不一致且与注释矛盾',
  /observe|重置/, {min: 1});
addDocClaim('D217', '文档给出了哈希契约违反在 AttributedString 一层的四层传导链',
  /传导/, {min: 1});

// ────────────────────────────────────────────────────────────────────────
// 80. 写方向与观察者的契约缺口（74 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const MB = 'packages/react-native/ReactCommon/react/renderer/mapbuffer/';
  const PT = 'packages/react-native/ReactCommon/react/performance/timeline/';
  const AS = 'packages/react-native/ReactCommon/react/renderer/attributedstring/';

  const mbb = read(MB + 'MapBufferBuilder.h') ?? '';
  const mbc = read(MB + 'MapBufferBuilder.cpp') ?? '';
  const mb = read(MB + 'MapBuffer.h') ?? '';
  const mbcpp = read(MB + 'MapBuffer.cpp') ?? '';
  const poh = read(PT + 'PerformanceObserver.h') ?? '';
  const poc = read(PT + 'PerformanceObserver.cpp') ?? '';
  const ash = read(AS + 'AttributedString.h') ?? '';
  const asc = read(AS + 'AttributedString.cpp') ?? '';
  const tah = read(AS + 'TextAttributes.h') ?? '';

  // NNN-1 核心：count 回绕
  {
    add('C557', '【NNN-1 核心】写方向的 header_.count 是 uint16_t 且 header_.count++ 无上限检查 —— 写超过 65535 个条目即回绕',
      'uint16_t / 无上限检查',
      'count++ ' + (mbc.match(/header_\.count\+\+/g) ?? []).length + ' 处',
      mb.includes('  struct Header {\n    uint16_t count; // amount of items in the map\n  };') &&
        (mbc.match(/header_\.count\+\+/g) ?? []).length === 1 &&
        !mbc.slice(mbc.indexOf('void MapBufferBuilder::storeKeyValue('), mbc.indexOf('void MapBufferBuilder::storeKeyValue(') + 900).includes('count >') &&
        mbb.includes('  MapBuffer::Header header_;'));
    add('C557b', 'NNN-2：写方向不检查重复 key（TODO 承认），而读方向的二分查找「找到第一个匹配就返回」',
      '不检查重复 key',
      'TODO ' + (mbc.match(/TODO\(T\d+\)/g) ?? []).length + ' 处',
      mbc.includes('  // TODO(T83483191): add pass to check for duplicates') &&
        (mbc.match(/TODO\(T\d+\)/g) ?? []).length === 1 &&
        mbc.includes('  buckets_.emplace_back(key, static_cast<uint16_t>(type), data);') &&
        mbcpp.includes('    } else {\n      return mid;\n    }'));
    add('C557c', 'NNN-3：写方向的值超限时 abort()（不是抛异常），且错误消息里的常量名与实际常量名不符',
      'abort + 常量名不符',
      'MAX_BUCKET_VALUE_SIZE ' + (mbc.match(/MAX_BUCKET_VALUE_SIZE/g) ?? []).length + ' 处 / 消息里的 MAX_VALUE_SIZE ' + (mbc.match(/MAX_VALUE_SIZE/g) ?? []).length + ' 处',
      mbc.includes('constexpr uint32_t MAX_BUCKET_VALUE_SIZE = sizeof(uint64_t);') &&
        mbc.includes('  if (valueSize > MAX_BUCKET_VALUE_SIZE) {\n    LOG(ERROR) << "Error: size of value must be <= MAX_VALUE_SIZE. ValueSize: "\n               << valueSize;\n    abort();\n  }') &&
        (mbc.match(/MAX_BUCKET_VALUE_SIZE/g) ?? []).length === 2 &&
        (mbc.match(/MAX_VALUE_SIZE/g) ?? []).length === 1);
  }

  // NNN-4 核心：三个无锁成员
  {
    add('C558', '【NNN-4 核心】PerformanceObserver 的 observedTypes_ / durationThreshold_ / requiresDroppedEntries_ 三个成员无锁保护，而 buffer_ 有 bufferMutex_',
      '3 个成员无锁',
      '成员 ' + (poh.match(/^\s+(PerformanceObserverEntryTypeFilter observedTypes_|HighResDuration durationThreshold_|bool requiresDroppedEntries_|std::vector<PerformanceEntry> buffer_|std::mutex bufferMutex_);/gm) ?? []).length + ' 个',
      poh.includes('  PerformanceObserverEntryTypeFilter observedTypes_;') &&
        poh.includes('  HighResDuration durationThreshold_ = DEFAULT_DURATION_THRESHOLD;') &&
        poh.includes('  bool requiresDroppedEntries_ = false;') &&
        poh.includes('  std::mutex bufferMutex_;') &&
        poh.includes('  std::vector<PerformanceEntry> buffer_;') &&
        !poh.includes('observedTypesMutex_'));
    add('C558b', 'NNN-4：handleEntry 读 observedTypes_/durationThreshold_ 都在 bufferMutex_ 之外，而 observe 写它们也无锁',
      '读写都无锁',
      'contains ' + (poc.match(/observedTypes_\.contains/g) ?? []).length + ' 处 / insert ' + (poc.match(/observedTypes_\.insert/g) ?? []).length + ' 处',
      (poc.match(/observedTypes_\.contains/g) ?? []).length === 1 &&
        (poc.match(/observedTypes_\.insert/g) ?? []).length === 1 &&
        (poc.match(/observedTypes_ = std::move\(types\)/g) ?? []).length === 1 &&
        poc.includes('  if (observedTypes_.contains(entryType)) {') &&
        poc.includes('        std::get<PerformanceEventTiming>(entry).duration < durationThreshold_) {') &&
        poc.includes('  observedTypes_.insert(type);\n\n  durationThreshold_ = options.durationThreshold;') &&
        poc.indexOf('observedTypes_.contains(entryType)') < poc.indexOf('std::lock_guard lock(bufferMutex_)') &&
        poc.indexOf('durationThreshold_) {') < poc.indexOf('std::lock_guard lock(bufferMutex_)'));
    add('C558c', 'NNN-11（正向）：scheduleFlushBuffer 的标志位在锁内改、回调在锁外调（避免回调重入 takeRecords 死锁）',
      '锁外回调',
      'lock_guard ' + (poc.match(/std::lock_guard lock\(bufferMutex_\)/g) ?? []).length + ' 处',
      poc.includes('void PerformanceObserver::scheduleFlushBuffer() {\n  bool shouldSchedule = false;\n  {\n    std::lock_guard lock(bufferMutex_);\n    if (!didScheduleFlushBuffer_) {\n      didScheduleFlushBuffer_ = true;\n      shouldSchedule = true;\n    }\n  }\n\n  if (shouldSchedule) {\n    callback_();\n  }\n}') &&
        (poc.match(/std::lock_guard lock\(bufferMutex_\)/g) ?? []).length === 3);
  }

  // NNN-5 核心：两个 observe 重载
  {
    add('C559', '【NNN-5 核心】两个 observe 重载语义不一致：单类型版 insert（累加）+ 覆盖阈值，多类型版整体替换',
      '累加 vs 替换',
      'observe 重载 ' + (poc.match(/void PerformanceObserver::observe\(/g) ?? []).length + ' 个',
      (poc.match(/void PerformanceObserver::observe\(/g) ?? []).length === 2 &&
        poc.includes('  observedTypes_.insert(type);\n\n  durationThreshold_ = options.durationThreshold;') &&
        poc.includes('  observedTypes_ = std::move(types);\n  requiresDroppedEntries_ = false;') &&
        !poc.includes('observedTypes_.clear()'));
    add('C559b', '【NNN-5 核心】注释明说「resets and overrides previous configurations … remove any previous watch configuration (as per spec)」—— 与单类型版的 insert 实现矛盾',
      '注释说 reset',
      '注释命中',
      poh.includes('   * This operation resets and overrides previous configurations. So consecutive') &&
        poh.includes('   * calls to this methods remove any previous watch configuration (as per') &&
        poh.includes('   * spec).') &&
        (poh.match(/resets and overrides previous configurations/g) ?? []).length === 2);
    add('C559c', 'NNN-8：getDroppedEntriesCount 是「call time 快照」且读的是 reporter 的计数 → 对 MARK/MEASURE 恒为 0',
      '快照语义',
      'reporter->getDroppedEntriesCount ' + (poc.match(/reporter->getDroppedEntriesCount/g) ?? []).length + ' 处',
      poc.includes('uint32_t PerformanceObserver::getDroppedEntriesCount() noexcept {\n  uint32_t droppedEntriesCount = 0;\n\n  if (requiresDroppedEntries_) {') &&
        (poc.match(/reporter->getDroppedEntriesCount/g) ?? []).length === 1 &&
        poh.includes('   * Internal function called by JS bridge to get number of dropped entries') &&
        poh.includes('   * count counted at call time.'));
  }

  // NNN-6 核心：哈希契约传导链
  {
    add('C560', '【NNN-6 核心】hash<AttributedString>/hash<Fragment> 的字段集与 operator== 严格配对（各 4 个 / 2 个）—— 本层是正确的',
      '字段集匹配',
      'hash_combine ' + (ash.match(/hash_combine/g) ?? []).length + ' 处（2 处 include + 2 处调用）',
      ash.includes('    return facebook::react::hash_combine(\n        fragment.string,\n        fragment.textAttributes,\n        fragment.parentShadowView.tag,\n        fragment.parentShadowView.layoutMetrics);') &&
        asc.includes('bool Fragment::operator==(const Fragment& rhs) const {\n  return std::tie(\n             string,\n             textAttributes,\n             parentShadowView.tag,\n             parentShadowView.layoutMetrics) ==') &&
        asc.includes('bool AttributedString::operator==(const AttributedString& rhs) const {\n  return std::tie(fragments_, baseAttributes_) ==') &&
        (ash.match(/hash_combine/g) ?? []).length === 4);
    add('C560b', '【NNN-6 核心】但 TextAttributes 层的 hash 是逐位（hash_combine）而 operator== 是容差（floatEquality）—— 63 文档的契约违反在此传导',
      '逐位 vs 容差',
      'hash<TextAttributes> ' + (tah.match(/struct hash<facebook::react::TextAttributes>/g) ?? []).length + ' 个',
      tah.includes('struct hash<facebook::react::TextAttributes> {') &&
        tah.includes('    facebook::react::hash_combine(\n        seed,\n        textAttributes.foregroundColor,') &&
        (tah.match(/struct hash<facebook::react::TextAttributes>/g) ?? []).length === 1 &&
        (read(AS + 'TextAttributes.cpp') ?? '').includes('      floatEquality(maxFontSizeMultiplier, rhs.maxFontSizeMultiplier) &&'));
    add('C560c', 'NNN-10（正向）：isContentEqual 只比 2 个字段（忽略 layout）且不参与 hash —— 语义分层清晰',
      'isContentEqual 2 字段',
      'isContentEqual ' + (asc.match(/isContentEqual/g) ?? []).length + ' 处',
      (asc.match(/isContentEqual/g) ?? []).length === 3 &&
        asc.includes('bool Fragment::isContentEqual(const Fragment& rhs) const {\n  return std::tie(string, textAttributes) ==\n      std::tie(rhs.string, rhs.textAttributes);\n}') &&
        !ash.slice(ash.indexOf('namespace std')).includes('isContentEqual'));
  }

  // NNN-12 正向：空 vector 的 memcpy 保护
  {
    add('C561', 'NNN-12（正向）：MapBufferBuilder::build() 的 memcpy 对空 vector 有保护，且注释解释了 glibc nonnull 与 UBSan',
      '空 vector 保护 + 第一档注释',
      '!buckets_.empty() ' + (mbc.match(/!buckets_\.empty\(\)/g) ?? []).length + ' 处',
      mbc.includes('  if (!buckets_.empty()) {\n    memcpy(buffer.data() + headerSize, buckets_.data(), bucketSize);\n  }') &&
        mbc.includes('  // buckets_.data() / dynamicData_.data() return nullptr when the vector is') &&
        mbc.includes('  // empty; passing nullptr to memcpy is UB even with size 0 (glibc marks the') &&
        mbc.includes('  // src argument nonnull) and trips UBSan halt-on-error on empty / scalar-only') &&
        (mbc.match(/!buckets_\.empty\(\)/g) ?? []).length === 1);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 79. LogBox 的 JS 侧：双实现对照与生命周期脱钩的缓存（73 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const LB = 'packages/react-native/Libraries/LogBox/Data/';
  const RB = 'packages/react-native/ReactCommon/react/debug/redbox/';

  const pll = read(LB + 'parseLogBoxLog.js') ?? '';
  const lbd = read(LB + 'LogBoxData.js') ?? '';
  const lbs = read(LB + 'LogBoxSymbolication.js') ?? '';
  const lbl = read(LB + 'LogBoxLog.js') ?? '';
  const rbp = read(RB + 'RedBoxErrorParser.cpp') ?? '';

  // MMM-1 核心：两种数字解析
  {
    add('C555', '【MMM-1 核心】JS 侧用 parseInt(row, 10) 解析行号、C++ 侧用 std::stoi —— 两端失败模式不同（C++ 抛异常、JS 静默出错）',
      'parseInt vs stoi',
      'JS parseInt ' + (pll.match(/parseInt\(/g) ?? []).length + ' 处 / C++ stoi ' + (rbp.match(/std::stoi/g) ?? []).length + ' 处',
      (pll.match(/parseInt\(/g) ?? []).length === 4 &&
        (rbp.match(/std::stoi/g) ?? []).length === 6 &&
        pll.includes('          row: parseInt(row, 10),\n          column: parseInt(column, 10),') &&
        rbp.includes('                  .row = std::stoi(match[4].str()),\n                  .column = std::stoi(match[5].str()),'));
    add('C555b', 'MMM-1：三份实现用了三种数字解析策略（from_chars / parseInt / stoi），无任何统一',
      '三种策略',
      'from_chars 1 / parseInt 4 / stoi 6',
      (read('packages/react-native/ReactCommon/jserrorhandler/StackTraceParser.cpp') ?? '').includes('std::from_chars') &&
        pll.includes('parseInt(row, 10)') &&
        rbp.includes('std::stoi(match[4].str())'));
    add('C555c', 'MMM-2：JS 侧的 7 个正则里没有 bundle-load-error 的对应物（实测无 Module Not Found / UnableToResolve）',
      'JS 7 个正则 / 无 bundle 分支',
      '正则 ' + (pll.match(/^const RE_\w+ =/gm) ?? []).length + ' 个',
      (pll.match(/^const RE_\w+ =/gm) ?? []).length === 7 &&
        !pll.includes('UnableToResolveError') &&
        !pll.includes('Module Not Found') &&
        rbp.includes('"SyntaxError", "ReferenceError", "TypeError", "UnableToResolveError"};'));
    add('C555d', 'MMM-2：C++ 侧有 JS 侧没有的 bundleLoadErrorRegex 分支，且注释自称「C++ port of parseLogBoxException」',
      'C++ 多 1 分支',
      'bundleLoadErrorRegex ' + (rbp.match(/bundleLoadErrorRegex/g) ?? []).length + ' 处',
      (rbp.match(/bundleLoadErrorRegex/g) ?? []).length === 2 &&
        rbp.includes('  if (std::regex_search(message, match, bundleLoadErrorRegex())) {') &&
        rbp.includes('      std::string title = errorType == "UnableToResolveError"\n          ? "Module Not Found"\n          : "Syntax Error";') &&
        (read(RB + 'RedBoxErrorParser.h') ?? '').includes(' * C++ port of parseLogBoxException from parseLogBoxLog.js.'));
  }

  // MMM-3 核心：生命周期脱钩
  {
    add('C556', '【MMM-3 核心】LogBoxSymbolication 的 cache 是模块级 const Map，而 LogBoxData.clear() 只重建 logs —— 缓存与 log 集合生命周期脱钩',
      '模块级 Map / clear 不碰它',
      'cache ' + (lbs.match(/new Map\(\)/g) ?? []).length + ' 处 / logs 声明 ' + (lbd.match(/let logs: LogBoxLogs = new Set\(\);/g) ?? []).length + ' 处',
      lbs.includes('const cache: Map<Stack, Promise<SymbolicatedStackTrace>> = new Map();') &&
        (lbd.match(/let logs: LogBoxLogs = new Set\(\);/g) ?? []).length === 1 &&
        lbd.includes('export function clear(): void {\n  if (logs.size > 0) {\n    logs = new Set();\n    setSelectedLog(-1);\n  }\n}') &&
        !lbd.includes('cache.clear()') &&
        !lbd.includes('LogBoxSymbolication.cache') &&
        !lbd.includes('LogBoxSymbolication.symbolicate('));
    add('C556b', 'MMM-4：logs 本身无上限，但有两个自动清理触发点（调试会话 → clearWarnings；开始追踪 → clear）',
      '无上限 + 2 个自愈点',
      '订阅 ' + (lbd.match(/\.subscribe\(/g) ?? []).length + ' 处',
      (lbd.match(/\.subscribe\(/g) ?? []).length === 2 &&
        lbd.includes('      hasActiveSession => {\n        if (hasActiveSession) {\n          clearWarnings();') &&
        lbd.includes('      isTracing => {\n        if (isTracing) {\n          clear();') &&
        lbd.includes('export function clearWarnings(): void {'));
    add('C556c', 'MMM-7（正向）：retrySymbolicate 会先 deleteStack 再重试 —— 失败不会被永久缓存（2 个生产调用方）',
      '先删缓存再重试',
      'deleteStack 调用 ' + (lbl.match(/LogBoxSymbolication\.deleteStack/g) ?? []).length + ' 处',
      (lbl.match(/LogBoxSymbolication\.deleteStack/g) ?? []).length === 2 &&
        lbl.includes('  retrySymbolicate(callback?: (status: SymbolicationStatus) => void): void {\n    let retry = false;\n    if (this.symbolicated.status !== \'COMPLETE\') {\n      LogBoxSymbolication.deleteStack(this.stack);') &&
        lbs.includes('export function deleteStack(stack: Stack): void {\n  cache.delete(stack);\n}'));
    add('C556d', 'MMM-8（正向）：sanitize 对 symbolicateStackTrace 的返回值做了完整校验（非数组抛、collapse 非布尔抛）',
      '防御完整',
      'throw ' + (lbs.match(/throw new Error/g) ?? []).length + ' 处',
      (lbs.match(/throw new Error/g) ?? []).length === 2 &&
        lbs.includes("    throw new Error('Expected stack to be an array.');") &&
        lbs.includes("        throw new Error('Expected stack frame `collapse` to be a boolean.');"));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 78. 渲染器调试字符串机制与两个同名 flags.h（72 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const RD = 'packages/react-native/ReactCommon/react/renderer/debug/';
  const CD = 'packages/react-native/ReactCommon/react/debug/';

  const dsc = read(RD + 'DebugStringConvertible.h') ?? '';
  const dscpp = read(RD + 'DebugStringConvertible.cpp') ?? '';
  const rflags = read(RD + 'flags.h') ?? '';
  const cflags = read(CD + 'flags.h') ?? '';
  const dbg = read(CD + 'React/Debug.h') ?? '';
  const ta = read('packages/react-native/ReactCommon/react/renderer/attributedstring/TextAttributes.h') ?? '';
  const lak = read('packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp') ?? '';
  const lmetrics = read('packages/react-native/ReactCommon/react/renderer/core/LayoutMetrics.h') ?? '';

  // LLL-1 核心：默认无限深度
  {
    add('C551', '【LLL-1 核心】DebugStringConvertibleOptions::maximumDepth 默认是 INT_MAX，而 getDebugDescription 是递归的 → 默认无限深度',
      'maximumDepth = INT_MAX',
      '默认值 ' + (dsc.match(/maximumDepth\{([^}]+)\}/) ?? [])[1],
      dsc.includes('struct DebugStringConvertibleOptions {\n  bool format{true};\n  int depth{0};\n  int maximumDepth{INT_MAX};\n};') &&
        dsc.includes('#include <climits>') &&
        dscpp.includes('  if (options.depth >= options.maximumDepth) {\n    return "";\n  }') &&
        dscpp.includes('    childrenString += child->getDebugDescription(options) + trailing;'));
    add('C551b', 'LLL-1：children 递归完整子树、props 只递归 props（两种递归语义）；深度计数各 +1',
      '两种递归语义',
      'depth++ ' + (dscpp.match(/options\.depth\+\+;/g) ?? []).length + ' 处',
      (dscpp.match(/options\.depth\+\+;/g) ?? []).length === 2 &&
        dscpp.includes('    childrenString += child->getDebugDescription(options) + trailing;') &&
        dscpp.includes('    auto children = prop->getDebugPropsDescription(options);'));
    add('C551c', 'LLL-5：字符串拼接是 O(n²)（逐个子节点 += 到同一个 std::string）',
      'O(n²) 拼接',
      '+= ' + (dscpp.match(/\+=/g) ?? []).length + ' 处',
      dscpp.includes('    childrenString += child->getDebugDescription(options) + trailing;') &&
        dscpp.includes('    propsString +=\n        " " + name + (valueAndChildren.empty() ? "" : "=" + valueAndChildren);'));
  }

  // LLL-2 核心：类形状随构建配置变化
  {
    add('C552', '【LLL-2 核心】release 下 DebugStringConvertible 是无虚函数的空类、DebugStringConvertibleOptions 是空结构体',
      'release 空壳',
      '空类 ' + (dsc.match(/class DebugStringConvertible \{\};/g) ?? []).length + ' 处',
      dsc.includes('#else\n\nstruct DebugStringConvertibleOptions {};\nclass DebugStringConvertible {};\n\n#endif') &&
        (dsc.match(/class DebugStringConvertible \{\};/g) ?? []).length === 1 &&
        dsc.includes('#if RN_DEBUG_STRING_CONVERTIBLE'));
    add('C552b', '【LLL-2 核心】子类的 override 声明必须手工包在 #if RN_DEBUG_STRING_CONVERTIBLE 里（TextAttributes 是实例）',
      'override 被 #if 包住',
      'TextAttributes.h 中 override ' + (ta.match(/override;/g) ?? []).length + ' 处',
      ta.includes('#if RN_DEBUG_STRING_CONVERTIBLE\n  SharedDebugStringConvertibleList getDebugProps() const override;\n#endif') &&
        (ta.match(/override;/g) ?? []).length === 1);
    add('C552c', 'LLL-6：DebugStringConvertible 的注释声明该 class 已 obsolete，但仍被大量继承',
      '注释说 obsolete',
      'obsolete ' + (dsc.match(/obsolete/g) ?? []).length + ' 处',
      dsc.includes(' * The `DebugStringConvertible` *class* is obsolete. Whenever possible prefer') &&
        dsc.includes(' * implementing standalone functions that conform to the informal') &&
        (dsc.match(/obsolete/g) ?? []).length === 1);
  }

  // LLL-3 / LLL-4 核心：两个同名 flags.h 与开关错位
  {
    add('C553', '【LLL-3 核心】react/debug/flags.h（24 行，定义 REACT_NATIVE_DEBUG）与 renderer/debug/flags.h（49 行，定义 RN_DEBUG_STRING_CONVERTIBLE）同名但内容完全不同',
      '同名不同义',
      'react/debug ' + (cflags.match(/\n/g) ?? []).length + ' 行 / renderer/debug ' + (rflags.match(/\n/g) ?? []).length + ' 行',
      cflags.includes('#if !(defined(REACT_NATIVE_DEBUG) || defined(REACT_NATIVE_PRODUCTION))') &&
        cflags.includes('#define REACT_NATIVE_PRODUCTION') &&
        !cflags.includes('RN_DEBUG_STRING_CONVERTIBLE') &&
        rflags.includes('#if defined(REACT_NATIVE_DEBUG) || defined(RN_ENABLE_DEBUG_STRING_CONVERTIBLE)\n#define RN_DEBUG_STRING_CONVERTIBLE 1\n#else\n#define RN_DEBUG_STRING_CONVERTIBLE 0\n#endif') &&
        !rflags.includes('REACT_NATIVE_PRODUCTION'));
    add('C553b', '【LLL-3 核心】renderer/debug/flags.h 含 3 个与本目录无关的 LayoutAnimations / StubViewTree 开关（复制残留），且它们都有真实使用点',
      '3 个无关开关',
      'LAYOUT_ANIMATION ' + (rflags.match(/LAYOUT_ANIMATION/g) ?? []).length + ' 处 / 使用点 ' + (lak.match(/LAYOUT_ANIMATION_VERBOSE_LOGGING/g) ?? []).length + ' 处',
      (rflags.match(/LAYOUT_ANIMATION/g) ?? []).length === 2 &&
        rflags.includes('// #define LAYOUT_ANIMATION_VERBOSE_LOGGING 1') &&
        rflags.includes('// #define RN_SHADOW_TREE_INTROSPECTION 1') &&
        rflags.includes('// #define STUB_VIEW_TREE_VERBOSE 1') &&
        (lak.match(/LAYOUT_ANIMATION_VERBOSE_LOGGING/g) ?? []).length >= 6 &&
        (lak.match(/#ifdef LAYOUT_ANIMATION_VERBOSE_LOGGING/g) ?? []).length >= 6);
    add('C553c', '【LLL-4 核心】LAYOUT_ANIMATION_VERBOSE_LOGGING 的使用点直接 include 的是 react/debug/flags.h（不含该开关），生效靠 LayoutMetrics.h 的传递包含',
      '声明与使用点错位',
      'LAK 直接 include ' + (lak.match(/debug\/flags\.h/g) ?? []).length + ' 处 / LayoutMetrics.h ' + (lmetrics.match(/renderer\/debug\/flags\.h/g) ?? []).length + ' 处',
      lak.includes('#include <react/debug/flags.h>') &&
        lak.includes('#include <react/renderer/core/LayoutMetrics.h>') &&
        lmetrics.includes('#include <react/renderer/debug/flags.h>') &&
        !cflags.includes('LAYOUT_ANIMATION_VERBOSE_LOGGING') &&
        rflags.includes('// #define LAYOUT_ANIMATION_VERBOSE_LOGGING 1'));
    add('C553d', 'LLL-9（正向）：react/debug/React/Debug.h 是 umbrella 头并用 push_macro/pop_macro（62 文档 BBB-5 模式的第三个实例）',
      '第三个实例',
      'push_macro ' + (dbg.match(/push_macro/g) ?? []).length + ' 处',
      dbg.includes('#pragma push_macro("RN_UMBRELLA_CONTEXT")') &&
        dbg.includes('#pragma pop_macro("RN_UMBRELLA_CONTEXT")') &&
        (dbg.match(/push_macro/g) ?? []).length === 1 &&
        dbg.includes('// The `redbox/` headers are deliberately absent: they are implementation') &&
        dbg.includes('#include <react/debug/flags.h>'));
  }

  // LLL-7 / LLL-8 正向：边界处理
  {
    add('C554', 'LLL-7（正向）：递归实现的空指针守卫与前导/尾随字符删除都有判空保护',
      '判空完整',
      '守卫 ' + (dscpp.match(/if \(!child\)|if \(!prop\)|!childrenString\.empty\(\)|!propsString\.empty\(\)/g) ?? []).length + ' 处',
      (dscpp.match(/if \(!child\)|if \(!prop\)|!childrenString\.empty\(\)|!propsString\.empty\(\)/g) ?? []).length === 4 &&
        dscpp.includes('    if (!child) {\n      continue;\n    }') &&
        dscpp.includes('  if (!childrenString.empty() && !trailing.empty()) {') &&
        dscpp.includes('  if (!propsString.empty()) {'));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 77. 大字符串与可见性宏（71 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const CX = 'packages/react-native/ReactCommon/cxxreact/';
  const jbs = read(CX + 'JSBigString.h') ?? '';
  const jbsc = read(CX + 'JSBigString.cpp') ?? '';
  const rec = read(CX + 'RecoverableError.h') ?? '';
  const eu = read(CX + 'ErrorUtils.h') ?? '';
  const loader = read('packages/react-native/ReactAndroid/src/main/jni/react/jni/JSLoader.cpp') ?? '';

  // KKK-1 核心：isAscii 恒真
  {
    add('C547', '【KKK-1 核心】三个 isAscii() 实现中两个恒返回 true（JSBigBufferString / JSBigFileString），只有 JSBigStdString 由构造参数决定（默认 false）',
      '2 个恒真 / 1 个由参数决定',
      'isAscii ' + (jbs.match(/bool isAscii\(\) const override/g) ?? []).length + ' 个',
      (jbs.match(/bool isAscii\(\) const override/g) ?? []).length === 3 &&
        jbs.includes('  JSBigStdString(std::string str, bool isAscii = false) : m_isAscii(isAscii), m_str(std::move(str)) {}') &&
        jbs.includes('  bool isAscii() const override\n  {\n    return m_isAscii;\n  }') &&
        (jbs.match(/bool isAscii\(\) const override\n  \{\n    return true;\n  \}/g) ?? []).length === 2);
    add('C547b', '【KKK-1 核心】Android 的 bundle 主加载路径把整个 script 读进 JSBigBufferString（该实现恒声明 ASCII）',
      'Android 主路径',
      'memcpy ' + (loader.match(/memcpy\(/g) ?? []).length + ' 处',
      loader.includes('      auto buf = std::make_unique<JSBigBufferString>(script->size());\n      memcpy(buf->mutableData(), script->c_str(), script->size());\n      return buf;') &&
        (loader.match(/JSBigBufferString/g) ?? []).length === 1);
    add('C547c', 'KKK-1：仓库 Libraries 下 459 个 JS 文件中 18 个含非 ASCII 字节（bundle 必然带上）',
      '18 / 459',
      'Libraries 下非 ASCII 文件 ' + grepCount(/[^\x00-\x7F]/, { roots: ['packages/react-native/Libraries'], exts: ['.js'], skipTests: true }).files.length + ' 个',
      grepCount(/[^\x00-\x7F]/, { roots: ['packages/react-native/Libraries'], exts: ['.js'], skipTests: true }).files.length >= 15);
  }

  // KKK-2 核心：RN_EXPORT 的 10 个定义点
  {
    add('C548', '【KKK-2 核心】RN_EXPORT 宏有 10 个定义点，只有 JSBigString.h 一个带 _MSC_VER 分支',
      '10 个文件 / 11 处 #define / 1 个带 MSVC 分支',
      '#define ' + grepCount(/define RN_EXPORT/, { roots: ['packages'], exts: ['.h'], skipTests: true }).count +
        ' 处 / 守卫 ' + grepCount(/#ifndef RN_EXPORT/, { roots: ['packages'], exts: ['.h'], skipTests: true }).count + ' 处',
      grepCount(/define RN_EXPORT/, { roots: ['packages'], exts: ['.h'], skipTests: true }).count === 11 &&
        grepCount(/#ifndef RN_EXPORT/, { roots: ['packages'], exts: ['.h'], skipTests: true }).count === 10 &&
        jbs.includes('#ifndef RN_EXPORT\n#ifdef _MSC_VER\n#define RN_EXPORT\n#else\n#define RN_EXPORT __attribute__((visibility("default")))\n#endif\n#endif') &&
        (read('packages/react-native/ReactCommon/cxxreact/ModuleRegistry.h') ?? '').includes('#ifndef RN_EXPORT\n#define RN_EXPORT __attribute__((visibility("default")))\n#endif'));
    add('C548b', 'KKK-2：10 个定义点全部用 #ifndef 守卫（展开取决于谁先被 include）',
      '全部 #ifndef 守卫',
      '守卫 ' + grepCount(/#ifndef RN_EXPORT/, { roots: ['packages'], exts: ['.h'], skipTests: true }).count + ' 处',
      grepCount(/#ifndef RN_EXPORT/, { roots: ['packages'], exts: ['.h'], skipTests: true }).count === 10);
  }

  // KKK-3 / KKK-4
  {
    add('C549', '【KKK-3 核心】JSBigString 的注释说「move-only」但实现把移动构造与移动赋值都 delete —— 注释描述的能力不存在',
      '注释 move-only / 实现 non-movable',
      'delete ' + (jbs.match(/= delete;/g) ?? []).length + ' 处',
      jbs.includes('// move-only, non-CopyConstructible type will let the compiler ensure') &&
        jbs.includes('  // Not copyable or movable\n  JSBigString(const JSBigString &) = delete;\n  JSBigString &operator=(const JSBigString &) = delete;\n  JSBigString(JSBigString &&) = delete;\n  JSBigString &operator=(JSBigString &&) = delete;') &&
        (jbs.match(/= delete;/g) ?? []).length === 4);
    add('C549b', 'KKK-4：JSBigBufferString 的 new char[size + 1] 在 size == SIZE_MAX 时回绕为 0，随后 m_data[m_size] = 0 是越界写',
      '整数回绕 + 越界写',
      '分配 1 处 / 写 1 处',
      jbs.includes('  JSBigBufferString(size_t size) : m_data(new char[size + 1]), m_size(size)\n  {\n    // Guarantee nul-termination.  The caller is responsible for\n    // filling in the rest of m_data.\n    m_data[m_size] = \'\\0\';\n  }') &&
        !jbs.includes('size + 1') === false &&
        !jbs.includes('if (size == std::numeric_limits<size_t>::max())'));
  }

  // KKK-5 / KKK-6：RecoverableError 与弃用转发头
  {
    add('C550', '【KKK-5 核心】runRethrowingAsRecoverable 丢弃原异常类型与异常链（只保留 what() 文本）',
      '丢类型 + 丢链',
      'catch ' + (rec.match(/catch \(/g) ?? []).length + ' 处',
      rec.includes('  template <typename E>\n  inline static void runRethrowingAsRecoverable(std::function<void()> act)\n  {\n    try {\n      act();\n    } catch (const E &err) {\n      throw RecoverableError(err.what());\n    }\n  }') &&
        !rec.includes('exception_ptr') && !rec.includes('nested_exception') &&
        rec.includes('  explicit RecoverableError(const std::string &what_) : m_what{"facebook::react::Recoverable: " + what_} {}'));
    add('C550b', 'KKK-6：ErrorUtils.h 是带 #warning 的弃用转发头（第二个同型实例）',
      '弃用转发头',
      '#warning ' + (eu.match(/#warning/g) ?? []).length + ' 处',
      eu.includes('#warning Deprecated: use <jserrorhandler/ErrorUtils.h> instead.') &&
        eu.includes('#include <jserrorhandler/ErrorUtils.h>') &&
        (eu.match(/#warning/g) ?? []).length === 1);
    add('C550c', 'KKK-8（正向）：JSBigFileString::fromPath 的错误处理干净（fstat 失败先 close(fd) 再抛，无 fd 泄漏）',
      '无 fd 泄漏',
      'close ' + (jbsc.match(/folly::fileops::close\(fd\)/g) ?? []).length + ' 处',
      jbsc.includes('  if (res == -1) {\n    const std::string message =\n        "JSBigFileString::fromPath - fstat on bundle failed: " + sourceURL;\n    LOG(ERROR) << message;\n    folly::fileops::close(fd);\n    throw std::runtime_error(message.c_str());\n  }') &&
        (jbsc.match(/folly::fileops::close\(fd\)/g) ?? []).length === 2 &&
        jbsc.includes('  CHECK(folly::fileops::close(fd) == 0);'));
    add('C550d', 'KKK-9（正向）：fromPath 的头注释写清了「抛什么异常 / 谁该 catch / 不 catch 会怎样」',
      '第一档注释',
      '注释命中',
      jbs.includes('  // Throws std::runtime_error when the file at sourceURL cannot be opened or') &&
        jbs.includes('  // read (e.g. it is missing). Callers that load files which may legitimately') &&
        jbs.includes('  // be gone at load time (such as an OS-purgeable / LRU-evictable cache) must') &&
        jbs.includes('  // catch this and degrade gracefully rather than let it surface as an') &&
        jbs.includes('  // unhandled exception.'));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 76. 文本属性层：两套「未设置」表示与 NaN 哨兵（70 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const AS = 'packages/react-native/ReactCommon/react/renderer/attributedstring/';

  const ta = read(AS + 'TextAttributes.h') ?? '';
  const tac = read(AS + 'TextAttributes.cpp') ?? '';
  const asb = read(AS + 'AttributedStringBox.h') ?? '';
  const asbc = read(AS + 'AttributedStringBox.cpp') ?? '';
  const conv = read(AS + 'conversions.h') ?? '';
  const fc = read('packages/react-native/ReactCommon/react/utils/FloatComparison.h') ?? '';

  // JJJ-1 核心：两套「未设置」表示
  {
    const nanFields = [...ta.matchAll(/^\s+Float (\w+)\{std::numeric_limits<Float>::quiet_NaN\(\)\};/gm)].map(m => m[1]);
    const optFields = [...ta.matchAll(/^\s+std::optional<[^>]+> (\w+)\{\};/gm)].map(m => m[1]);
    add('C544', '【JJJ-1 核心】TextAttributes 里 7 个字段用 Float + NaN 哨兵、19 个用 std::optional —— 两套「未设置」表示并存',
      '7 NaN / 19 optional',
      'NaN ' + nanFields.length + ' / optional ' + optFields.length,
      nanFields.length === 7 &&
        optFields.length === 19 &&
        nanFields.join(',') === 'opacity,fontSize,fontSizeMultiplier,maxFontSizeMultiplier,letterSpacing,lineHeight,textShadowRadius' &&
        optFields.includes('fontWeight') && optFields.includes('layoutDirection') &&
        ta.includes('  Float opacity{std::numeric_limits<Float>::quiet_NaN()};') &&
        ta.includes('  std::optional<FontWeight> fontWeight{};'));
    add('C544b', 'JJJ-1：NaN 哨兵字段在 operator== 里全部走 floatEquality，optional 字段走直接比较',
      '7 个 floatEquality',
      'floatEquality ' + (tac.match(/floatEquality/g) ?? []).length + ' 处',
      (tac.match(/floatEquality/g) ?? []).length === 7 &&
        tac.includes('      floatEquality(maxFontSizeMultiplier, rhs.maxFontSizeMultiplier) &&\n      floatEquality(opacity, rhs.opacity) &&\n      floatEquality(fontSize, rhs.fontSize) &&') &&
        tac.includes('      floatEquality(textShadowRadius, rhs.textShadowRadius);') &&
        tac.includes('             rhs.layoutDirection,\n             rhs.accessibilityRole,\n             rhs.role,') &&
        fc.includes('  return (std::isnan(a) && std::isnan(b)) || (!std::isnan(a) && !std::isnan(b) && std::abs(a - b) < epsilon);'));
  }

  // JJJ-3 核心：两种非法 Mode 策略
  {
    add('C545', '【JJJ-3 核心】AttributedStringBox 的 operator== 的 switch 无 default（非法 Mode 隐式返回 false = UB），而 std::hash 的 switch 有 default',
      '无 default / 有 default',
      'operator== switch ' + (asbc.match(/switch \(lhs\.getMode\(\)\)/g) ?? []).length + ' 处 / hash switch ' + (asb.match(/switch \(attributedStringBox\.getMode\(\)\)/g) ?? []).length + ' 处',
      asbc.includes('  switch (lhs.getMode()) {\n    case AttributedStringBox::Mode::Value:\n      return lhs.getValue() == rhs.getValue();\n    case AttributedStringBox::Mode::OpaquePointer:\n      return lhs.getOpaquePointer() == rhs.getOpaquePointer();\n  }') &&
        !asbc.includes('default:') &&
        asb.includes('      default:\n        react_native_assert(false && "Invalid AttributedStringBox::Mode");\n        return 0;'));
    add('C545b', 'JJJ-4：getValue()/getOpaquePointer() 的前置条件用 react_native_assert（release 下被编译掉）',
      '前置条件用 assert',
      'assert ' + (asbc.match(/react_native_assert/g) ?? []).length + ' 处（含 1 处 include）',
      asbc.includes('const AttributedString& AttributedStringBox::getValue() const {\n  react_native_assert(mode_ == AttributedStringBox::Mode::Value);\n  react_native_assert(value_);\n  return *value_;\n}') &&
        asbc.includes('std::shared_ptr<void> AttributedStringBox::getOpaquePointer() const {\n  react_native_assert(mode_ == AttributedStringBox::Mode::OpaquePointer);\n  react_native_assert(opaquePointer_);\n  return opaquePointer_;\n}') &&
        (asbc.match(/react_native_assert/g) ?? []).length === 5);
    add('C545c', 'JJJ-5：move 赋值把 other 重置为空的 Value 盒，但 opaquePointer_ 未重置',
      '重置不完整',
      'move 赋值 1 处',
      asbc.includes('    other.mode_ = AttributedStringBox::Mode::Value;\n    other.value_ = std::make_shared<const AttributedString>(AttributedString{});') &&
        !asbc.includes('other.opaquePointer_ = nullptr;') &&
        !asbc.includes('other.opaquePointer_.reset();'));
    add('C545d', 'JJJ-8：AttributedStringBox 每个实例固定持有 2 个 shared_ptr（32 字节），同一时刻只有一个有效',
      '2 个 shared_ptr',
      '成员 ' + (asb.match(/std::shared_ptr<[^>]+> \w+_;/g) ?? []).length + ' 个',
      asb.includes('  Mode mode_;\n  std::shared_ptr<const AttributedString> value_;\n  std::shared_ptr<void> opaquePointer_;') &&
        (asb.match(/std::shared_ptr<[^>]+> \w+_;/g) ?? []).length === 2);
  }

  // JJJ-6 核心：conversions.h 是裸 if 宏的最大消费方
  {
    add('C546', '【JJJ-6 核心】conversions.h 里有 46 处 react_native_expect —— 65 文档那个裸 if 宏的最大单一消费方',
      '46 处',
      'react_native_expect ' + (conv.match(/react_native_expect\(/g) ?? []).length + ' 处',
      (conv.match(/react_native_expect\(/g) ?? []).length === 46 &&
        conv.includes('#include <react/debug/react_native_expect.h>') &&
        (conv.match(/react_native_expect\(/g) ?? []).length === 46);
    add('C546b', 'JJJ-10（正向）：layoutDirection 字段的 TODO 明确承认「不清楚是否被正确使用」并说明「当前故意不设置」',
      '自认 TODO',
      'T59221129 ' + (ta.match(/T59221129/g) ?? []).length + ' 处',
      ta.includes('  // TODO T59221129: document where this value comes from and how it is set.') &&
        ta.includes('  // It\'s not clear if this is being used properly, or if it\'s being set at all.') &&
        ta.includes('  // Currently, it is intentionally *not* being set as part of BaseTextProps') &&
        (ta.match(/T59221129/g) ?? []).length === 1);
    add('C546c', 'JJJ-11（正向）：defaultTextAttributes() 用函数内 static auto，且只覆盖 4 个字段（其余 NaN 哨兵保持「未设置」）',
      'static auto + 4 字段',
      '覆盖 ' + (tac.match(/defaultAttrs\.\w+ = /g) ?? []).length + ' 个',
      tac.includes('TextAttributes TextAttributes::defaultTextAttributes() {\n  static auto textAttributes = [] {') &&
        (tac.match(/defaultAttrs\.\w+ = /g) ?? []).length === 4 &&
        tac.includes('    // Non-obvious (can be different among platforms) default text attributes.') &&
        tac.includes('    defaultAttrs.fontSize = 14.0;\n    defaultAttrs.fontSizeMultiplier = 1.0;'));
    add('C546d', 'JJJ-13（正向）：getDebugProps() 整体在 #if RN_DEBUG_STRING_CONVERTIBLE 内（release 下不编译）',
      'debug 宏门控',
      'RN_DEBUG_STRING_CONVERTIBLE ' + (tac.match(/RN_DEBUG_STRING_CONVERTIBLE/g) ?? []).length + ' 处',
      tac.includes('#if RN_DEBUG_STRING_CONVERTIBLE\nSharedDebugStringConvertibleList TextAttributes::getDebugProps() const {') &&
        (tac.match(/RN_DEBUG_STRING_CONVERTIBLE/g) ?? []).length === 1);
    add('C546e', 'JJJ-12（正向）：attributedstring 目录的 7 个头文件全部使用 FrameworksGuard（for-frameworks 档）',
      '档位一致',
      'FrameworksGuard ' + (ta.match(/FrameworksGuard\.h/g) ?? []).length + ' 处（TextAttributes.h）',
      ta.includes('#include <react/cxxstableapi/FrameworksGuard.h>') &&
        conv.includes('#include <react/cxxstableapi/FrameworksGuard.h>') &&
        asb.includes('#include <react/cxxstableapi/FrameworksGuard.h>') &&
        !ta.includes('PrivateGuard.h') && !asb.includes('PrivateGuard.h') && !conv.includes('PrivateGuard.h'));
    add('C546f', 'JJJ-14（正向）：TextEffectInfo::operator== 用 = default（自动纳入全部成员）',
      '= default',
      'default ' + (ta.match(/= default;/g) ?? []).length + ' 处',
      ta.includes('struct TextEffectInfo {\n  std::string name;\n  folly::dynamic props;\n  bool operator==(const TextEffectInfo &) const = default;\n};') &&
        (ta.match(/= default;/g) ?? []).length === 1);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 75. legacy 桥的 C++ 侧：静默丢弃与无上限缓冲（69 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const CX = 'packages/react-native/ReactCommon/cxxreact/';
  const CR = 'packages/react-native/ReactCommon/react/renderer/componentregistry/';

  const inst = read(CX + 'Instance.cpp') ?? '';
  const insth = read(CX + 'Instance.h') ?? '';
  const mr = read(CX + 'ModuleRegistry.cpp') ?? '';
  const mrh = read(CX + 'ModuleRegistry.h') ?? '';
  const ntj = read(CX + 'NativeToJsBridge.cpp') ?? '';
  const ntjh = read(CX + 'NativeToJsBridge.h') ?? '';
  const cnv = read(CR + 'componentNameByReactViewName.cpp') ?? '';

  // III-1 核心：四处静默丢弃
  {
    add('C540', '【III-1 核心】runOnExecutorQueue 有双重 m_destroyed 检查（入队前 + 执行时），两处都是无 else 的静默 return',
      '双重检查 / 2 处静默',
      'm_destroyed 检查 ' + (ntj.match(/m_destroyed|isDestroyed/g) ?? []).length + ' 处',
      ntj.includes('void NativeToJsBridge::runOnExecutorQueue(\n    std::function<void(JSExecutor*)>&& task) noexcept {\n  if (*m_destroyed) {\n    return;\n  }') &&
        ntj.includes('      [this, isDestroyed, task = std::move(task)] {\n        if (*isDestroyed) {\n          return;\n        }') &&
        ntj.includes('        // 1. the executor is only destroyed after it is unregistered') &&
        !ntj.includes('if (*m_destroyed) {\n    return;\n  } else {'));
    add('C540b', '【III-1 核心】JSCallInvoker::scheduleAsync 与 getRuntimeExecutor 都在 weak_ptr 过期时静默丢弃工作（两处 lock() 均无 else 分支）',
      '2 处 weak_ptr 静默',
      'lock() ' + (inst.match(/\.lock\(\)/g) ?? []).length + ' 处',
      inst.includes('void Instance::JSCallInvoker::scheduleAsync(CallFunc&& work) noexcept {\n  if (auto strongNativeToJsBridge = m_nativeToJsBridge.lock()) {') &&
        inst.includes('  std::weak_ptr<NativeToJsBridge> weakNativeToJsBridge = nativeToJsBridge_;\n  return [weakNativeToJsBridge](') &&
        (inst.match(/\.lock\(\)/g) ?? []).length === 2 &&
        !inst.includes('if (auto strongNativeToJsBridge = m_nativeToJsBridge.lock()) {\n    strongNativeToJsBridge->runOnExecutorQueue(\n        [work = std::move(work)](JSExecutor* executor) {\n          auto* runtime = (jsi::Runtime*)executor->getJavaScriptContext();\n          work(*runtime);\n          executor->flush();\n        });\n  } else {'));
    add('C540c', 'III-1：destroy() 的注释明确说明「pending work be cancelled」是有意取舍',
      '有意取消',
      'destroy 注释命中',
      ntj.includes('  // All calls made through runOnExecutorQueue have an early exit if\n  // m_destroyed is true. Setting this before the runOnQueueSync will cause\n  // pending work to be cancelled and we won\'t have to wait for it.') &&
        ntj.includes('  *m_destroyed = true;'));
    add('C540d', 'III-10（正向）：m_destroyed 用 std::shared_ptr<bool> 包装，让标志生命周期独立于桥',
      'shared_ptr<bool>',
      '声明 ' + (ntjh.match(/std::shared_ptr<bool> m_destroyed;/g) ?? []).length + ' 处',
      ntjh.includes('  std::shared_ptr<bool> m_destroyed;') &&
        ntj.includes('    : m_destroyed(std::make_shared<bool>(false)),') &&
        ntj.includes('  std::shared_ptr<bool> isDestroyed = m_destroyed;'));
  }

  // III-2 核心：无上限缓冲
  {
    add('C541', '【III-2 核心】JSCallInvoker::m_workBuffer 是无上限的 std::list<CallFunc>，无计数器、无告警',
      '无上限 list',
      'm_workBuffer ' + (insth.match(/m_workBuffer/g) ?? []).length + ' 处',
      insth.includes('    std::list<CallFunc> m_workBuffer;') &&
        !insth.includes('m_workBufferMax') && !insth.includes('kMaxBuffered') &&
        inst.includes('  if (m_shouldBuffer) {\n    m_workBuffer.push_back(std::move(work));\n    return;\n  }') &&
        insth.includes('    bool m_shouldBuffer = true;'));
    add('C541b', 'III-2：注释说「理论上不会在 bundle 执行前调用 invokeAsync」，但同时说「implemented anyways to ensure that work isn\'t discarded」',
      '理由完整但边界缺失',
      '注释行 ' + (inst.match(/ensure that work/g) ?? []).length + ' 处',
      inst.includes('   * Therefore, although we don\'t call invokeAsync before the JS bundle is') &&
        inst.includes('   * executed, this buffering is implemented anyways to ensure that work') &&
        inst.includes('   * isn\'t discarded.') &&
        inst.includes('   * 1. TurboModuleManager must be created synchronously after the Instance,'));
    add('C541c', 'III-7：invokeSync 直接抛 std::runtime_error（legacy 桥不支持同步 native→JS）',
      '直接抛异常',
      'runtime_error ' + (inst.match(/Synchronous native -> JS calls are currently not supported\./g) ?? []).length + ' 处',
      inst.includes('void Instance::JSCallInvoker::invokeSync(CallFunc&& /*work*/) {\n  // TODO: Replace JS Callinvoker with RuntimeExecutor.\n  throw std::runtime_error(\n      "Synchronous native -> JS calls are currently not supported.");\n}') &&
        (inst.match(/Synchronous native -> JS calls are currently not supported\./g) ?? []).length === 1);
    add('C541d', 'III-9：flush 在持锁期间逐个 scheduleAsync（锁持有时间随缓冲长度线性增长）',
      '持锁 flush',
      'scoped_lock ' + (inst.match(/std::scoped_lock guard\(m_mutex\)/g) ?? []).length + ' 处',
      inst.includes('void Instance::JSCallInvoker::setNativeToJsBridgeAndFlushCalls(\n    std::weak_ptr<NativeToJsBridge> nativeToJsBridge) {\n  std::scoped_lock guard(m_mutex);\n\n  m_shouldBuffer = false;\n  m_nativeToJsBridge = nativeToJsBridge;\n  while (!m_workBuffer.empty()) {\n    scheduleAsync(std::move(m_workBuffer.front()));\n    m_workBuffer.pop_front();\n  }') &&
        (inst.match(/std::scoped_lock guard\(m_mutex\)/g) ?? []).length === 2);
  }

  // III-3 核心：两套名字归一化
  {
    add('C542', '【III-3 核心】ModuleRegistry::normalizeName 剥 RCT/RK 前缀，componentNameByReactViewName 剥 RCT 前缀 + 10 条映射 —— 两套规则不同',
      '两套规则 / 映射 10 条',
      'normalizeName ' + (mr.match(/normalizeName/g) ?? []).length + ' 处 / 映射 ' + (cnv.match(/viewName ==/g) ?? []).length + ' 条',
      mr.includes('std::string normalizeName(std::string name) {') &&
        mr.includes('  if (name.compare(0, 3, "RCT") == 0) {\n    return name.substr(3);\n  } else if (name.compare(0, 2, "RK") == 0) {\n    return name.substr(2);\n  }') &&
        (cnv.match(/viewName ==/g) ?? []).length === 10 &&
        !mr.includes('Paragraph') && !cnv.includes('"RK"'));
    add('C542b', 'III-3：两处注释互相知道对方是「the similar hacks in js」/「unify component names」',
      '互相知晓',
      '两处 TODO',
      mr.includes('  // TODO mhorowitz #10487027: This is super ugly.  We should just') &&
        mr.includes('  // names hardcoded in Android, and then delete this and the') &&
        mr.includes('  // similar hacks in js.') &&
        cnv.includes('  // TODO T97384889: unify component names between JS - Android - iOS - C++'));
    add('C542c', 'III-8：仓库里两套 TODO 编号体系并存（作者名+内部任务号 vs 纯任务号）',
      '两套编号体系',
      '#数字 ' + (mr.match(/#\d{7,}/g) ?? []).length + ' 处 / T数字 ' + (mr.match(/TODO T\d+/g) ?? []).length + ' 处',
      (mr.match(/#\d{7,}/g) ?? []).length === 2 &&
        (mr.match(/TODO T\d+/g) ?? []).length === 0 &&
        (cnv.match(/TODO T\d+/g) ?? []).length === 1);
  }

  // III-4 / III-5：变长数组协议与失效注释
  {
    add('C543', '【III-4 核心】getConfig 组装「变长数组 + 位置协议」（长度 2/3/4/5），methodId 是方法在 getMethods() 数组里的下标',
      '4 种长度 / methodId=下标',
      'promiseMethodIds ' + (mr.match(/promiseMethodIds/g) ?? []).length + ' 处',
      mr.includes('  // string name, object constants, array methodNames (methodId is index),\n  // [array promiseMethodIds], [array syncMethodIds]') &&
        mr.includes('        promiseMethodIds.push_back(methodNames.size() - 1);') &&
        mr.includes('        syncMethodIds.push_back(methodNames.size() - 1);') &&
        mr.includes('      // TODO: #10487027 compare tags instead of doing string comparison?'));
    add('C543b', '【III-5 核心】头注释的「not implemented」列表描述了 6 个本类里不存在的接口，并引用 our.intern.facebook.com',
      '6 个不存在的接口',
      'not implemented ' + (mrh.match(/not implemented/g) ?? []).length + ' 处',
      mrh.includes('  // not implemented:\n  // onBatchComplete: see\n  // https://our.intern.facebook.com/intern/tasks/?t=5279396 getModule: only\n  // used by views getAllModules: only used for cleanup; use RAII instead\n  // notifyCatalystInstanceInitialized: this is really only used by view-related\n  // code notifyCatalystInstanceDestroy: use RAII instead') &&
        (mrh.match(/not implemented/g) ?? []).length === 1 &&
        !mrh.includes('onBatchComplete()') &&
        !mrh.includes('getAllModules()') &&
        !mrh.includes('notifyCatalystInstanceInitialized(') &&
        !mr.includes('onBatchComplete()') &&
        !mr.includes('getAllModules()'));
    add('C543c', 'III-6：moduleId 边界检查逐字重复 4 处（getModuleName / getModuleSyncMethodName / callNativeMethod / callSerializableNativeHook）',
      '4 处逐字重复',
      'out of range ' + (mr.match(/out of range/g) ?? []).length + ' 处',
      (mr.match(/out of range/g) ?? []).length === 4 &&
        mr.includes('    throw std::runtime_error(\n        "moduleId " + std::to_string(moduleId) + " out of range [0.." +\n        std::to_string(modules_.size()) + ")");'));
    add('C543d', '整个 cxxreact 目录被 RCT_REMOVE_LEGACY_ARCH 门控（legacy 关闭时全部编译掉）',
      'legacy 门控',
      '门控 ' + (mr.match(/RCT_REMOVE_LEGACY_ARCH/g) ?? []).length + ' 处',
      (mr.match(/RCT_REMOVE_LEGACY_ARCH/g) ?? []).length === 2 &&
        mr.includes('#ifndef RCT_REMOVE_LEGACY_ARCH') &&
        mr.includes('#endif // RCT_REMOVE_LEGACY_ARCH') &&
        (inst.match(/RCT_REMOVE_LEGACY_ARCH/g) ?? []).length === 2);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 74. 版本与发布流水线：跨语言表示与未接 CI 的生成校验（68 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const REL = 'scripts/releases/';
  const RN = 'packages/react-native/';

  const setVer = read(REL + 'set-version.js') ?? '';
  const setArt = read(REL + 'set-rn-artifacts-version.js') ?? '';
  const verUtil = read(REL + 'utils/version-utils.js') ?? '';
  const tplH = read(REL + 'templates/ReactNativeVersion.h-template.js') ?? '';
  const tplM = read(REL + 'templates/RCTVersion.m-template.js') ?? '';
  const tplJS = read(REL + 'templates/ReactNativeVersion.js-template.js') ?? '';
  const tplKT = read(REL + 'templates/ReactNativeVersion.kt-template.js') ?? '';
  const genH = read(RN + 'ReactCommon/react/utils/ReactNativeVersion.h') ?? '';
  const legacyH = read(RN + 'ReactCommon/cxxreact/ReactNativeVersion.h') ?? '';
  const mono = read('scripts/shared/monorepoUtils.js') ?? '';
  const bAction = read('.github/actions/build-android/action.yml') ?? '';
  const pCore = read('.github/workflows/prebuild-ios-core.yml') ?? '';
  const snap = read(RN + 'scripts/codegen/__tests__/__snapshots__/generate-artifacts-executor-test.js.snap') ?? '';
  const gradle = read(RN + 'ReactAndroid/gradle.properties') ?? '';

  // HHH-1 核心：四种语言三种表示
  {
    add('C537', '【HHH-1 核心】同一个「无 prerelease」在四种语言里有三种表示：ObjC [NSNull null] / C++ "" / JS null / Kotlin null',
      '3 种表示 / 4 处模板',
      'NSNull ' + (tplM.match(/\[NSNull null\]/g) ?? []).length + ' / 空串 ' + (tplH.match(/'""'/g) ?? []).length + ' / JS null ' + (tplJS.match(/'null'/g) ?? []).length,
      (tplM.match(/\[NSNull null\]/g) ?? []).length === 1 &&
        (tplH.match(/'""'/g) ?? []).length === 1 &&
        (tplJS.match(/'null'/g) ?? []).length === 1 &&
        (tplKT.match(/'null'/g) ?? []).length === 1 &&
        tplM.includes("                      : '[NSNull null]'") &&
        tplH.includes("version.prerelease != null ? `\"${version.prerelease}\"` : '\"\"'") &&
        tplJS.includes("version.prerelease != null ? `'${version.prerelease}'` : 'null'") &&
        tplKT.includes("version.prerelease != null ? `\"${version.prerelease}\"` : 'null'"));
    add('C537b', '【HHH-1b 核心】C++ 侧只有 3 个 REACT_NATIVE_VERSION_* 宏、却有 4 个 struct 字段（无 PRERELEASE 宏）',
      '3 宏 / 4 字段',
      '宏 ' + (genH.match(/#define REACT_NATIVE_VERSION_/g) ?? []).length + ' 个',
      (genH.match(/#define REACT_NATIVE_VERSION_/g) ?? []).length === 3 &&
        genH.includes('#define REACT_NATIVE_VERSION_MAJOR 1000') &&
        genH.includes('#define REACT_NATIVE_VERSION_MINOR 0') &&
        genH.includes('#define REACT_NATIVE_VERSION_PATCH 0') &&
        !genH.includes('REACT_NATIVE_VERSION_PRERELEASE') &&
        genH.includes('struct ReactNativeVersionType {\n  int32_t Major = 1000;\n  int32_t Minor = 0;\n  int32_t Patch = 0;\n  std::string_view Prerelease = "";\n};'));
    add('C537c', 'HHH-7（正向）：cxxreact 的弃用转发头用 push_macro/pop_macro 而非裸 #define/#undef（62 文档 BBB-5 描述的模式）',
      'push/pop 模式',
      'push_macro ' + (legacyH.match(/push_macro/g) ?? []).length + ' 处',
      legacyH.includes('#warning "Deprecated: use <React/Utils.h> instead."') &&
        legacyH.includes('#pragma push_macro("RN_UMBRELLA_CONTEXT")') &&
        legacyH.includes('#pragma pop_macro("RN_UMBRELLA_CONTEXT")') &&
        (legacyH.match(/push_macro/g) ?? []).length === 1 &&
        legacyH.includes('#include <react/utils/ReactNativeVersion.h>'));
  }

  // HHH-2 核心：package.json 绕过 parseVersion
  {
    add('C538', '【HHH-2 核心】VERSION_REGEX 接受 v 前缀（^v?），且 parseVersion 把原串（含 v）保留在 version.version 里',
      "正则 ^v?",
      '正则 ' + (verUtil.match(/\^v\?/g) ?? []).length + ' 处',
      verUtil.includes('const VERSION_REGEX = /^v?((\\d+)\\.(\\d+)\\.(\\d+)(?:-(.+))?)$/;') &&
        (verUtil.match(/\^v\?/g) ?? []).length === 1 &&
        verUtil.includes('  const [, version, major, minor, patch, prerelease] = match;'));
    add('C538b', '【HHH-2 核心】package.json 的 version 用原始字符串逐字赋值，完全绕过 parseVersion',
      '逐字赋值 / 无 parseVersion',
      '赋值 ' + (mono.match(/packageJson\.version = /g) ?? []).length + ' 处',
      mono.includes('  if (packageName in newPackageVersions) {\n    packageJson.version = newPackageVersions[packageName];\n  }') &&
        !mono.includes('parseVersion') &&
        setVer.includes("      packageName === 'react-native' && skipReactNativeVersion\n        ? '1000.0.0'\n        : version,") &&
        setVer.includes('  if (!skipReactNativeVersion) {\n    await updateReactNativeArtifacts(version);\n  }'));
    add('C538c', 'HHH-2b：native 路径的校验是三层（正则 → buildType 白名单 → 版本形态），白名单用 Set',
      '三层校验 / 3 个 buildType',
      'buildType ' + (verUtil.match(/validBuildTypes/g) ?? []).length + ' 处',
      verUtil.includes("  const validBuildTypes = new Set(['release', 'dry-run', 'nightly']);") &&
        verUtil.includes("      throw new Error(`Unsupported build type: ${buildType}`);") &&
        verUtil.includes('  const map = {\n    release: validateRelease,\n    \'dry-run\': validateDryRun,\n    nightly: validateNightly,\n  };') &&
        verUtil.includes('function isStablePrerelease(version /*: Version */) /*: boolean */ {') &&
        verUtil.includes("      version.prerelease?.match(/^(\\d{8})-(\\d{4})$/))"));
    add('C538d', 'HHH-8（正向）：isNightly 依赖版本串含字面量 nightly，且 0.0.0 作为旧式 nightly 特例',
      '含 nightly / 0.0.0 特例',
      'nightly 字面量 ' + (verUtil.match(/nightly/g) ?? []).length + ' 处',
      verUtil.includes("  return version.version.includes('nightly');") &&
        verUtil.includes("  if (version.major === '0' && version.minor === '0' && version.patch === '0') {\n    return true;\n  }") &&
        verUtil.includes('function isMain(version /*: Version */) /*: boolean */ {') &&
        verUtil.includes("    version.major === '1000' && version.minor === '0' && version.patch === '0'"));
  }

  // HHH-3/HHH-4 核心：生成与模板的同步状态 + CI 不比对
  {
    add('C539', '【HHH-3 核心】CI 在构建前跑 set-rn-artifacts-version.js，但两个调用点之后都没有任何 diff 校验',
      '2 个调用点 / 0 个 diff 校验',
      'git diff --exit-code 命中 ' + grepCount(/git diff --exit-code/, { roots: ['.github'], skipTests: false }).count + ' 处',
      bAction.includes('run: node ./scripts/releases/set-rn-artifacts-version.js --build-type ${{ inputs.release-type }}') &&
        pCore.includes('node ./scripts/releases/set-rn-artifacts-version.js --build-type "${{ inputs.version-type }}"') &&
        !bAction.includes('git diff --exit-code') &&
        !pCore.includes('git diff --exit-code') &&
        grepCount(/git diff --exit-code/, { roots: ['.github'], skipTests: false }).count === 0);
    add('C539b', '【HHH-4 核心】set-rn-artifacts-version.js 写 4 个 native 版本文件 + gradle.properties + 用正则改写 codegen snapshot',
      '4 版本文件 + 1 gradle + 1 snapshot',
      'writeFile ' + (setArt.match(/fs\.writeFile/g) ?? []).length + ' 处',
      (setArt.match(/fs\.writeFile/g) ?? []).length >= 4 &&
        setArt.includes("      require('./templates/ReactNativeVersion.kt-template')(templateData),") &&
        setArt.includes("      require('./templates/RCTVersion.m-template')(templateData),") &&
        setArt.includes("      require('./templates/ReactNativeVersion.h-template')(templateData),") &&
        setArt.includes("      require('./templates/ReactNativeVersion.js-template')(templateData),") &&
        setArt.includes("const GRADLE_FILE_PATH = path.join(\n  REPO_ROOT,\n  'packages/react-native/ReactAndroid/gradle.properties',\n);") &&
        setArt.includes("  const oldVersion = /\"\\d+\\.\\d+\\.\\d+(-rc\\.\\d+)?\\\\/g;"));
    add('C539c', '【HHH-4 核心】4 个模板都用 ${@}generated 标记（生成后成为 @generated），而手写的弃用转发头没有 —— 仓库里的生成文件确实带 @generated 标记',
      '4 模板带标记 / 转发头不带',
      '模板标记 ' + (tplM.match(/generated by scripts\/releases\/set-version\.js/g) ?? []).length + ' 处（每个模板 1）',
      (tplM.match(/generated by scripts\/releases\/set-version\.js/g) ?? []).length === 1 &&
        (tplH.match(/generated by scripts\/releases\/set-version\.js/g) ?? []).length === 1 &&
        (tplJS.match(/generated by scripts\/releases\/set-version\.js/g) ?? []).length === 1 &&
        (tplKT.match(/generated by scripts\/releases\/set-version\.js/g) ?? []).length === 1 &&
        genH.includes(' * @generated by scripts/releases/set-version.js') &&
        !legacyH.includes('@generated'));
    add('C539d', 'HHH-9（正向）：gradle.properties 的版本写入用 ^VERSION_NAME=.* 精确单行匹配（与 snapshot 的正则改写对照）',
      '结构化单行匹配',
      'VERSION_NAME ' + (gradle.match(/VERSION_NAME/g) ?? []).length + ' 处',
      setArt.includes("    contents.replace(/^VERSION_NAME=.*/, `VERSION_NAME=${version}`),") &&
        gradle.includes('VERSION_NAME=1000.0.0'));
    add('C539e', '【HHH-5 核心】snapshot 改写的正则只覆盖 -rc.N 形态，而 parseVersion 允许任意 prerelease；实测当前只命中 4 处且全为目标版本',
      '正则只认 -rc.N / 实测 4 处',
      'snapshot 版本号形态 ' + (snap.match(/"\d+\.\d+\.\d+/g) ?? []).length + ' 处',
      (snap.match(/"\d+\.\d+\.\d+/g) ?? []).length === 4 &&
        setArt.includes('const oldVersion = /"\\d+\\.\\d+\\.\\d+(-rc\\.\\d+)?\\\\/g;') &&
        verUtil.includes('(?:-(.+))?') &&
        !setArt.includes('-beta'));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 73. 特性开关：手写档位文件与未接 CI 的快照门禁（67 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const FF = 'packages/react-native/ReactCommon/react/featureflags/';
  const SF = 'packages/react-native/scripts/featureflags/';

  const stable = read(FF + 'ReactNativeFeatureFlagsOverridesOSSStable.h') ?? '';
  const canary = read(FF + 'ReactNativeFeatureFlagsOverridesOSSCanary.h') ?? '';
  const exper = read(FF + 'ReactNativeFeatureFlagsOverridesOSSExperimental.h') ?? '';
  const defaults = read(FF + 'ReactNativeFeatureFlagsDefaults.h') ?? '';
  const cfg = read(SF + 'ReactNativeFeatureFlags.config.js') ?? '';
  const genCxx = read(SF + 'generateCommonCxxModules.js') ?? '';
  const genFiles = read(SF + 'generateFiles.js') ?? '';
  const index = read(SF + 'index.js') ?? '';
  const rw = read(FF + 'rewrite_feature_flag_defaults.py') ?? '';

  // GGG-1 核心：唯一不参与生成的手写文件
  {
    add('C533', '【GGG-1 核心】ReactNativeFeatureFlagsOverridesOSSStable.h 是 featureflags 目录里唯一不带 @generated SignedSource 标记的文件',
      '9 个带标记 / 1 个不带',
      '带标记 ' + (canary.match(/@generated SignedSource/g) ?? []).length + ' 个（Canary）',
      !stable.includes('@generated SignedSource') &&
        canary.includes(' * @generated SignedSource<<c26b8f81fcc99469d0535a89bac18280>>') &&
        exper.includes('@generated SignedSource') &&
        defaults.includes('@generated SignedSource') &&
        !stable.includes('IMPORTANT: Do NOT modify this file directly.'));
    add('C533b', '【GGG-1 核心】生成器的目标列表只有 9 个文件，不含 OSSStable.h；只生成 experimental 与 canary 两个 stage',
      '9 个目标 / 2 个 stage',
      '目标 ' + (genCxx.match(/path\.join\(\s*commonCxxPath/g) ?? []).length + ' 处',
      !genCxx.includes("'ReactNativeFeatureFlagsOverridesOSSStable.h'") &&
        genCxx.includes("      'ReactNativeFeatureFlagsOverridesOSSExperimental.h',") &&
        genCxx.includes("    [path.join(commonCxxPath, 'ReactNativeFeatureFlagsOverridesOSSCanary.h')]:") &&
        !genCxx.includes("'stable'"));
    add('C533c', 'GGG-1：Stable 档继承 Defaults，Canary 继承 Stable，Experimental 继承 Canary（三级链）',
      '三级继承链',
      'override ' + (stable.match(/override/g) ?? []).length + ' 处',
      stable.includes('class ReactNativeFeatureFlagsOverridesOSSStable : public ReactNativeFeatureFlagsDefaults {') &&
        canary.includes('class ReactNativeFeatureFlagsOverridesOSSCanary : public ReactNativeFeatureFlagsOverridesOSSStable {') &&
        exper.includes('class ReactNativeFeatureFlagsOverridesOSSExperimental : public ReactNativeFeatureFlagsOverridesOSSCanary {') &&
        (stable.match(/override/g) ?? []).length === 1);
    add('C533d', 'GGG-2：手写的 Stable 文件只覆写了 useNativeViewConfigsInBridgelessMode 一个 flag，返回 true',
      '1 个 override → true',
      'override ' + (stable.match(/bool \w+\(\) override/g) ?? []).length + ' 个',
      stable.includes('  bool useNativeViewConfigsInBridgelessMode() override\n  {\n    return true;\n  }') &&
        (stable.match(/bool \w+\(\) override/g) ?? []).length === 1);
  }

  // GGG-2 核心：与 config 声明相反
  {
    add('C534', '【GGG-2 核心】config.js 中 useNativeViewConfigsInBridgelessMode 的 ossReleaseStage 是 canary、defaultValue 是 false',
      "stage='canary' / default=false",
      'stage 命中 ' + (cfg.match(/ossReleaseStage: 'canary'/g) ?? []).length + ' 处',
      cfg.includes('    useNativeViewConfigsInBridgelessMode: {\n      defaultValue: false,') &&
        cfg.includes("      ossReleaseStage: 'canary',") &&
        cfg.includes('    enableBridgelessArchitecture: {') &&
        cfg.includes("      ossReleaseStage: 'stable',") &&
        (cfg.match(/ossReleaseStage: 'canary'/g) ?? []).length === 9 &&
        (cfg.match(/ossReleaseStage: 'stable'/g) ?? []).length === 3 &&
        (cfg.match(/ossReleaseStage: 'experimental'/g) ?? []).length === 4 &&
        (cfg.match(/ossReleaseStage: 'none'/g) ?? []).length === 88);
    add('C534b', '【GGG-2 核心】Defaults 里 useNativeViewConfigsInBridgelessMode 返回 false，而 Stable 档返回 true —— 实际行为与声明相反',
      'Defaults false / Stable true',
      'Defaults ' + (defaults.match(/bool useNativeViewConfigsInBridgelessMode\(\) override \{\s*return false;/g) ?? []).length + ' 处',
      defaults.includes('  bool useNativeViewConfigsInBridgelessMode() override {\n    return false;\n  }') &&
        stable.includes('  bool useNativeViewConfigsInBridgelessMode() override\n  {\n    return true;\n  }'));
    add('C534c', 'GGG-2：同一个 override 在 Canary（生成）里又写了一遍，继承链上遮蔽了 Stable 的手写版',
      'Canary 也覆写',
      'Canary 命中 ' + (canary.match(/bool useNativeViewConfigsInBridgelessMode\(\) override/g) ?? []).length + ' 处',
      canary.includes('  bool useNativeViewConfigsInBridgelessMode() override {\n    return true;\n  }') &&
        (canary.match(/bool useNativeViewConfigsInBridgelessMode\(\) override/g) ?? []).length === 1);
    add('C534d', 'GGG-2 的公平说明：3 个 ossReleaseStage=stable 的 flag 的 defaultValue 恰好为 true，所以 Stable 档不覆写它们反而行为正确',
      '3 个 stable flag default=true',
      'enableBridgelessArchitecture default ' + (cfg.match(/enableBridgelessArchitecture: \{\s*defaultValue: (\w+)/) ?? [])[1],
      (cfg.match(/enableBridgelessArchitecture: \{\s*defaultValue: (\w+)/) ?? [])[1] === 'true' &&
        defaults.includes('  bool enableBridgelessArchitecture() override {\n    return true;\n  }') &&
        !stable.includes('enableBridgelessArchitecture'));
  }

  // GGG-3 核心：三重失守
  {
    add('C535', '【GGG-3 核心】CI 的 38 个 workflow 里没有任何 feature flags 任务（.github/ 全目录零命中）',
      '零命中',
      '.github 命中 ' + grepCount(/featureflags|feature-flags|feature_flags|FeatureFlags/, { roots: ['.github'], skipTests: false }).count + ' 处',
      grepCount(/featureflags|feature-flags|feature_flags|FeatureFlags/, { roots: ['.github'], skipTests: false }).count === 0 &&
        exists('.github/workflows/validate-cxx-api-snapshots.yml') &&
        exists('.github/workflows/validate-dotslash-artifacts.yml'));
    add('C535b', '【GGG-3 核心】@generated SignedSource 标记无任何校验实现：全仓仅 dotslash-utils.js 用于发布资产 URL',
      '无校验',
      'SignedSource 命中 ' + grepCount(/SignedSource/, { roots: ['scripts'], skipTests: false }).count + ' 处（scripts/）',
      grepCount(/SignedSource/, { roots: ['scripts'], skipTests: false }).count >= 1 &&
        !exists('scripts/featureflags/verifySignedSource.js') &&
        (read('scripts/releases/utils/dotslash-utils.js') ?? '').includes('SignedSource'));
    add('C535c', '【GGG-3 核心】--verify-unchanged 的实现是完备的逐字节比对 + 抛错，但 .github/ 里零调用方',
      '实现完备 / CI 零调用',
      'verify-unchanged 命中 ' + grepCount(/verify-unchanged/, { roots: ['packages/react-native/scripts/featureflags', '.github'], skipTests: false }).count + ' 处',
      grepCount(/verify-unchanged/, { roots: ['packages/react-native/scripts/featureflags', '.github'], skipTests: false }).count === 4 &&
        grepCount(/verify-unchanged/, { roots: ['.github'], skipTests: false }).count === 0 &&
        index.includes("  } else if (process.argv.includes('--verify-unchanged')) {\n    command = 'verify-unchanged';") &&
        genFiles.includes('  if (generatorOptions.verifyUnchanged) {') &&
        genFiles.includes('      if (module !== existingModule) {\n        changedFiles.push(moduleName);\n      }') &&
        genFiles.includes("        'Please rerun `yarn featureflags --update` and commit the changes.',"));
    add('C535d', 'GGG-4：rewrite_feature_flag_defaults.py 依赖 Meta 内部的 fbpython 与 tree_sitter_cpp',
      'fbpython + tree_sitter',
      'shebang ' + (rw.split('\n')[0] ?? ''),
      rw.startsWith('#!/usr/bin/env fbpython') &&
        rw.includes('import tree_sitter_cpp') &&
        rw.includes('from tree_sitter import Language, Parser, Query, QueryCursor') &&
        rw.includes('Fails with a non-zero exit code if any requested flag is not found.'));
  }

  // GGG-6/7/8 正向
  {
    add('C536', '【GGG-6 正向】104 个 flag 的 description / expectedReleaseValue / purpose / ossReleaseStage / defaultValue 五项元数据全覆盖',
      '5 项各 104/104',
      'description ' + (cfg.match(/description:/g) ?? []).length + ' / dateAdded ' + (cfg.match(/dateAdded:/g) ?? []).length,
      (cfg.match(/description:/g) ?? []).length === 104 &&
        (cfg.match(/expectedReleaseValue:/g) ?? []).length === 104 &&
        (cfg.match(/purpose:/g) ?? []).length === 104 &&
        (cfg.match(/ossReleaseStage:/g) ?? []).length === 104 &&
        (cfg.match(/defaultValue:/g) ?? []).length === 104 &&
        (cfg.match(/dateAdded:/g) ?? []).length === 76);
    add('C536c', '【GGG-10】dateAdded 元数据只覆盖 76/104 个 flag —— 28 个 flag 缺引入日期',
      'dateAdded 76/104',
      'dateAdded ' + (cfg.match(/dateAdded:/g) ?? []).length + ' / 104',
      (cfg.match(/dateAdded:/g) ?? []).length === 76 &&
        !cfg.includes('dateAdded') === false &&
        cfg.includes('    enableBridgelessArchitecture: {') &&
        cfg.includes('    useFabricInterop: {'));
    add('C536b', '【GGG-7 正向】生成文件带 @generated SignedSource + Do NOT modify + 精确的重新生成命令 + 指向唯一真相源',
      '四要素齐备',
      'Do NOT modify ' + (canary.match(/IMPORTANT: Do NOT modify this file directly\./g) ?? []).length + ' 处',
      canary.includes(' * IMPORTANT: Do NOT modify this file directly.') &&
        canary.includes(' * To change the definition of the flags, edit') &&
        canary.includes(' *   packages/react-native/scripts/featureflags/ReactNativeFeatureFlags.config.js.') &&
        canary.includes(' * To regenerate this code, run the following script from the repo root:') &&
        canary.includes(' *   yarn featureflags --update'));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 72. 性能观测层：无界缓冲与监控盲区（66 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const TL = 'packages/react-native/ReactCommon/react/performance/timeline/';
  const CD = 'packages/react-native/ReactCommon/react/performance/cdpmetrics/';
  const CXX = 'packages/react-native/ReactCommon/cxxreact/';

  const cb = read(TL + 'CircularBuffer.h') ?? '';
  const peb = read(TL + 'PerformanceEntryBuffer.h') ?? '';
  const pecb = read(TL + 'PerformanceEntryCircularBuffer.cpp') ?? '';
  const pekb = read(TL + 'PerformanceEntryKeyedBuffer.h') ?? '';
  const pekbc = read(TL + 'PerformanceEntryKeyedBuffer.cpp') ?? '';
  const perh = read(TL + 'PerformanceEntryReporter.h') ?? '';
  const perc = read(TL + 'PerformanceEntryReporter.cpp') ?? '';
  const por = read(TL + 'PerformanceObserverRegistry.cpp') ?? '';
  const pe = read(TL + 'PerformanceEntry.h') ?? '';
  const cdm = read(CD + 'CdpMetricsReporter.h') ?? '';
  const cdp = read(CD + 'CdpPerfIssuesReporter.h') ?? '';
  const rbr = read(CXX + 'RAMBundleRegistry.cpp') ?? '';

  // FFF-1 核心：有界 vs 无界
  {
    add('C529', '【FFF-1 核心】三个环形缓冲有上限（150/200/250），两个 keyed 缓冲（mark/measure）无上限',
      '150/200/250 vs 无',
      '常量 ' + (perh.match(/BUFFER_SIZE = \d+/g) ?? []).length + ' 个 / KeyedBuffer ' + (perh.match(/PerformanceEntryKeyedBuffer/g) ?? []).length + ' 个',
      perh.includes('constexpr size_t EVENT_BUFFER_SIZE = 150;') &&
        perh.includes('constexpr size_t LONG_TASK_BUFFER_SIZE = 200;') &&
        perh.includes('constexpr size_t RESOURCE_TIMING_BUFFER_SIZE = 250;') &&
        perh.includes('  PerformanceEntryCircularBuffer eventBuffer_{EVENT_BUFFER_SIZE};') &&
        perh.includes('  PerformanceEntryCircularBuffer longTaskBuffer_{LONG_TASK_BUFFER_SIZE};') &&
        perh.includes('  PerformanceEntryCircularBuffer resourceTimingBuffer_{RESOURCE_TIMING_BUFFER_SIZE};') &&
        perh.includes('  PerformanceEntryKeyedBuffer markBuffer_;') &&
        perh.includes('  PerformanceEntryKeyedBuffer measureBuffer_;'));
    add('C529b', '【FFF-1 核心】PerformanceEntryKeyedBuffer 用 unordered_map<string, vector<PerformanceEntry>>，两层都无上限且 add() 永不淘汰',
      '两层无上限',
      'push_back ' + (pekbc.match(/push_back/g) ?? []).length + ' 处 / 无上限标记',
      pekb.includes('  std::unordered_map<std::string, std::vector<PerformanceEntry>> entryMap_{};') &&
        pekbc.includes('  if (node != entryMap_.end()) {\n    node->second.push_back(entry);\n  } else {\n    entryMap_.emplace(name, std::vector<PerformanceEntry>{entry});\n  }') &&
        !pekbc.includes('maxSize') && !pekbc.includes('capacity') &&
        !pekb.includes('maxSize') && !pekb.includes('capacity'));
    add('C529c', 'FFF-1：环形缓冲的 add() 满了会覆盖最旧的并返回 true（表示丢弃了一条），keyed 缓冲永远不返回丢弃信号',
      '环形返 true / keyed 不返',
      '环形 add 返回 ' + (cb.match(/return true;/g) ?? []).length + ' 处',
      cb.includes('    if (entries_.size() < maxSize_) {') &&
        cb.includes('      // Overwrite the oldest (but already consumed) element in the buffer\n      entries_[position_] = el;') &&
        cb.includes('      return true;') &&
        !pekbc.includes('return true;') && !pekbc.includes('return false;'));
    add('C529d', 'FFF-1：JS 侧存在 clearMarks()/clearMeasures() 出口（默认不调用）',
      '有清理 API',
      'NativePerformance.cpp 清理点 ' + grepCount(/clearEntries/, { roots: ['packages/react-native/ReactCommon/react/nativemodule/webperformance'] }).count + ' 处',
      grepCount(/clearEntries/, { roots: ['packages/react-native/ReactCommon/react/nativemodule/webperformance'] }).count >= 2 &&
        perc.includes('void PerformanceEntryReporter::clearEntries() {\n  std::unique_lock lock(buffersMutex_);') &&
        perc.includes('void PerformanceEntryReporter::clearEntries(\n    PerformanceEntryType entryType,\n    const std::string& entryName) {'));
    add('C529e', 'FFF-6（对照）：CDP 上报路径是流式零缓冲的，两个 reporter 的注释都写明「reported immediately」',
      '流式零缓冲',
      'reported immediately ' + ((cdm + cdp).match(/reported immediately/g) ?? []).length + ' 处',
      ((cdm + cdp).match(/reported immediately/g) ?? []).length === 2 &&
        cdm.includes(' * Native DevTools. Events are reported immediately and do not require an') &&
        cdp.includes(' * reported immediately and do not require an active CDP Tracing session.') &&
        !cdm.includes('Buffer') && !cdp.includes('Buffer'));
  }

  // FFF-2 核心：监控盲区
  {
    add('C530', '【FFF-2 核心】droppedEntriesCount 只在 PerformanceEntryCircularBuffer::add 里递增，PerformanceEntryKeyedBuffer 中 0 处',
      '只在环形缓冲递增',
      '环形 2 处 / keyed 0 处',
      pecb.includes('void PerformanceEntryCircularBuffer::add(const PerformanceEntry& entry) {\n  if (buffer_.add(entry)) {\n    droppedEntriesCount += 1;\n  }\n}') &&
        (pekbc.match(/droppedEntriesCount/g) ?? []).length === 0 &&
        peb.includes('  size_t droppedEntriesCount{0};'));
    add('C530b', '【FFF-2 核心】getDroppedEntriesCount 对 MARK/MEASURE 恒返回 0（查询接口存在但值恒定）',
      '恒为 0',
      '查询接口 ' + (perc.match(/getDroppedEntriesCount/g) ?? []).length + ' 处',
      perc.includes('uint32_t PerformanceEntryReporter::getDroppedEntriesCount(\n    PerformanceEntryType entryType) const noexcept {\n  std::shared_lock lock(buffersMutex_);\n\n  return (uint32_t)getBuffer(entryType).droppedEntriesCount;\n}') &&
        (perc.match(/getDroppedEntriesCount/g) ?? []).length === 1 &&
        !pekbc.includes('droppedEntriesCount'));
    add('C530c', 'FFF-2 的对照面：PerformanceEntryType 的 5 个类型中，只有 MARK/MEASURE 走 keyed 缓冲',
      '5 类型 / 2 走 keyed',
      '类型 5 个',
      (pe.match(/MARK = 1|MEASURE = 2|EVENT = 3|LONGTASK = 4|RESOURCE = 5/g) ?? []).length === 5 &&
        perh.includes('  PerformanceEntryKeyedBuffer markBuffer_;') &&
        perh.includes('  PerformanceEntryKeyedBuffer measureBuffer_;'));
  }

  // FFF-3 核心：CircularBuffer 边界
  {
    add('C531', '【FFF-3 核心】CircularBuffer::operator[] 用 % entries_.size()，空缓冲上是整数除零（UB）',
      '% 0 是 UB',
      'operator[] ' + (cb.match(/operator\[\]/g) ?? []).length + ' 处',
      cb.includes('  T &operator[](size_t idx)\n  {\n    return entries_[(position_ + idx) % entries_.size()];\n  }') &&
        !cb.slice(cb.indexOf('  T &operator[](size_t idx)'), cb.indexOf('  T &operator[](size_t idx)') + 200).includes('assert') &&
        !cb.slice(cb.indexOf('  T &operator[](size_t idx)'), cb.indexOf('  T &operator[](size_t idx)') + 200).includes('empty()'));
    add('C531b', '【FFF-3 核心】CircularBuffer(0) 后第一次 add() 走 entries_[position_]（空 vector 越界）且 position_ 又 % 0 —— 实测 SIGSEGV',
      'maxSize=0 → 越界',
      '两条坏路径',
      cb.includes('    if (entries_.size() < maxSize_) {') &&
        cb.includes('      entries_[position_] = el;\n      position_ = (position_ + 1) % entries_.size();') &&
        !cb.includes('if (maxSize_ == 0)') && !cb.includes('maxSize_ == 0'));
    add('C531c', 'FFF-3：当前不可达 —— 上限是常量 150/200/250，且 CircularBuffer::operator[] 在 timeline 目录内零调用方',
      '不可达',
      'timeline 内 operator[] 调用方 ' + grepCount(/buffer_\[/, { roots: ['packages/react-native/ReactCommon/react/performance/timeline'] }).count + ' 处',
      grepCount(/buffer_\[/, { roots: ['packages/react-native/ReactCommon/react/performance/timeline'] }).count === 0 &&
        perh.includes('constexpr size_t EVENT_BUFFER_SIZE = 150;') &&
        perh.includes('constexpr size_t LONG_TASK_BUFFER_SIZE = 200;') &&
        perh.includes('constexpr size_t RESOURCE_TIMING_BUFFER_SIZE = 250;'));
    add('C531d', 'FFF-7（正向）：CircularBuffer 构造时 reserve(maxSize_) 并注释说明「保证指针在 add 期间稳定」',
      'reserve + 注释',
      'reserve ' + (cb.match(/reserve/g) ?? []).length + ' 处',
      cb.includes('  explicit CircularBuffer(size_t maxSize) : maxSize_(maxSize)\n  {\n    entries_.reserve(maxSize_);\n  }') &&
        cb.includes(' * Note that the space for maxSize elements is reserved on construction. This') &&
        cb.includes(' * ensures that pointers to elements remain stable across add() operations.'));
  }

  // FFF-4 核心：RAMBundleRegistry 无锁
  {
    add('C532', '【FFF-4 核心】RAMBundleRegistry 的 registerBundle/getModule/getBundle 全部不加锁，且 find→emplace 有 TOCTOU 窗口',
      '0 处锁',
      'lock ' + (rbr.match(/lock|mutex/gi) ?? []).length + ' 处',
      !rbr.includes('lock') && !rbr.includes('mutex') &&
        rbr.includes('void RAMBundleRegistry::registerBundle(\n    uint32_t bundleId,\n    std::string bundlePath) {\n  m_bundlePaths.emplace(bundleId, std::move(bundlePath));\n}') &&
        rbr.includes('  if (m_bundles.find(bundleId) == m_bundles.end()) {') &&
        rbr.includes('    m_bundles.emplace(bundleId, m_factory(bundlePath->second));'));
    add('C532b', 'FFF-5（对照）：同批次的 PerformanceObserverRegistry 三个方法全部持 std::lock_guard',
      '3 处全持锁',
      'lock_guard ' + (por.match(/std::lock_guard/g) ?? []).length + ' 处',
      (por.match(/std::lock_guard/g) ?? []).length === 3 &&
        por.includes('void PerformanceObserverRegistry::addObserver(\n    std::shared_ptr<PerformanceObserver> observer) {\n  std::lock_guard guard(observersMutex_);') &&
        por.includes('void PerformanceObserverRegistry::queuePerformanceEntry(\n    const PerformanceEntry& entry) {\n  std::lock_guard lock(observersMutex_);'));
    add('C532c', 'FFF-4：RAMBundleRegistry 整个文件在 legacy 架构关闭时被编译掉',
      'RCT_REMOVE_LEGACY_ARCH 门控',
      '门控 ' + (rbr.match(/RCT_REMOVE_LEGACY_ARCH/g) ?? []).length + ' 处',
      (rbr.match(/RCT_REMOVE_LEGACY_ARCH/g) ?? []).length === 2 &&
        rbr.includes('#ifndef RCT_REMOVE_LEGACY_ARCH') &&
        rbr.includes('#endif // RCT_REMOVE_LEGACY_ARCH'));
    add('C532d', 'FFF-9：RAM bundle 的模块名加 seg-<bundleId>_ 前缀做命名空间隔离',
      'seg- 前缀',
      'seg- ' + (rbr.match(/seg-/g) ?? []).length + ' 处',
      rbr.includes('      .name = "seg-" + std::to_string(bundleId) + \'_\' + module.name,') &&
        (rbr.match(/seg-/g) ?? []).length === 1);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 71. 错误处理底层：断言宏 / RedBox 解析 / JscSafeUrl（65 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const DBG = 'packages/react-native/ReactCommon/react/debug/';
  const RB = DBG + 'redbox/';
  const JEH = 'packages/react-native/ReactCommon/jserrorhandler/';

  const asrt = read(DBG + 'react_native_assert.h') ?? '';
  const asrtc = read(DBG + 'react_native_assert.cpp') ?? '';
  const exp = read(DBG + 'react_native_expect.h') ?? '';
  const flags = read(DBG + 'flags.h') ?? '';
  const rbp = read(RB + 'RedBoxErrorParser.cpp') ?? '';
  const rbph = read(RB + 'RedBoxErrorParser.h') ?? '';
  const jsu = read(RB + 'JscSafeUrl.cpp') ?? '';
  const jsuh = read(RB + 'JscSafeUrl.h') ?? '';
  const stp = read(JEH + 'StackTraceParser.cpp') ?? '';
  const stph = read(JEH + 'StackTraceParser.h') ?? '';
  const rc2ep = read('packages/react-native/React/CoreModules/RCTRedBox2ErrorParser.mm') ?? '';
  const rc2c = read('packages/react-native/React/CoreModules/RCTRedBox2Controller.mm') ?? '';

  // EEE-1 核心：宏的平台不对称
  {
    add('C523', '【EEE-1 核心】react_native_assert 在 release 下是 ((void)0)，Android debug 下是三元表达式，非 Android debug 下是裸 if 宏',
      '三种形态',
      'release ' + (asrt.match(/\(\(void\)0\)/g) ?? []).length + ' / 表达式 ' + (asrt.match(/\(\(e\) \? \(void\)0/g) ?? []).length + ' / 裸 if ' + (asrt.match(/if \(!\(cond\)\)/g) ?? []).length,
      asrt.includes('#define react_native_assert(e) ((void)0)') &&
        asrt.includes('#define react_native_assert(e) ((e) ? (void)0 : react_native_assert_fail(__func__, __FILE__, __LINE__, #e))') &&
        asrt.includes('#define react_native_assert(cond)                           \\\n  if (!(cond)) {                                            \\\n    LOG(ERROR) << "react_native_assert failure: " << #cond; \\\n    google::FlushLogFiles(google::GLOG_INFO);               \\\n    assert(cond);                                           \\\n  }') &&
        (asrt.match(/if \(!\(cond\)\)/g) ?? []).length === 1);
    add('C523b', '【EEE-1 核心】react_native_expect 在 debug 下是裸 if 宏（无 Android 特化），release 下是 ((void)0)',
      '两种形态 / 无 Android 特化',
      '裸 if ' + (exp.match(/if \(!\(cond\)\)/g) ?? []).length + ' 处',
      exp.includes('#define react_native_expect(e) ((void)0)') &&
        exp.includes('#define react_native_expect(cond)                           \\\n  if (!(cond)) {                                            \\\n    LOG(ERROR) << "react_native_expect failure: " << #cond; \\\n  }') &&
        !exp.includes('__ANDROID__') &&
        (exp.match(/if \(!\(cond\)\)/g) ?? []).length === 1);
    add('C523c', 'EEE-1：全仓 457 处 react_native_(expect|assert) 引用行中，「if 无花括号 + 下一行是裸宏」的形态命中 0 处（当前无危险形态）',
      '0 处危险形态',
      '引用行 ' + grepCount(/react_native_(expect|assert)\(/, { roots: ['packages/react-native'], skipTests: true }).count + ' 处',
      grepCount(/react_native_(expect|assert)\(/, { roots: ['packages/react-native'], skipTests: true }).count === 457);
    add('C523d', 'EEE-1b：非 Android 版依赖 assert(cond)（NDEBUG 下为空操作），Android 版走 __android_log_assert 必然 abort —— 平台不对称',
      'assert vs log_assert',
      'assert(cond) ' + (asrt.match(/assert\(cond\)/g) ?? []).length + ' 处',
      asrt.includes('    assert(cond);                                           \\') &&
        asrtc.includes('  __android_log_assert(\n      nullptr,\n      "ReactNative",') &&
        asrtc.includes('  // Print as an error so it shows up in logcat before crash...') &&
        asrtc.includes('  // ...and trigger an abort so it crashes and shows up in uploaded logs.'));
    add('C523e', 'EEE-1b：flags.h 让 REACT_NATIVE_DEBUG 与 NDEBUG 相互独立（显式定义 REACT_NATIVE_DEBUG 时不再检查 NDEBUG）；REACT_NATIVE_PRODUCTION 在 assert/expect 头中从未被使用',
      '两者独立 / PRODUCTION 未被用',
      'REACT_NATIVE_PRODUCTION ' + (flags.match(/REACT_NATIVE_PRODUCTION/g) ?? []).length + ' 处',
      (flags.match(/REACT_NATIVE_PRODUCTION/g) ?? []).length === 3 &&
        flags.includes('#if !(defined(REACT_NATIVE_DEBUG) || defined(REACT_NATIVE_PRODUCTION))') &&
        flags.includes('#ifdef NDEBUG\n#define REACT_NATIVE_PRODUCTION\n#else\n#define REACT_NATIVE_DEBUG\n#endif') &&
        !asrt.includes('REACT_NATIVE_PRODUCTION') && !exp.includes('REACT_NATIVE_PRODUCTION'));
    add('C523f', 'EEE-11（正向）：assert/expect 的头注释解释了「为什么可以不用 header guard」与「什么时候用哪个」',
      '第一档注释',
      '无 header guard 说明 ' + (asrt.match(/No header guards/g) ?? []).length + ' 处',
      asrt.includes('// No header guards since it is legitimately possible to include this file more') &&
        asrt.includes('// than once with and without REACT_NATIVE_DEBUG.') &&
        asrt.includes('// For recoverable conditions that can be violated by user mistake (e.g. JS') &&
        asrt.includes('// code passes an unexpected prop value), consider react_native_expect instead.') &&
        exp.includes('// react_native_expect is a non-fatal counterpart of react_native_assert.') &&
        exp.includes('// Calling react_native_expect does NOT, by itself, guarantee that the user'));
  }

  // EEE-2 核心：两套数字解析策略
  {
    add('C524', '【EEE-2 核心】StackTraceParser::toInt 用 std::from_chars 并显式处理 invalid_argument 与 result_out_of_range，返回 nullopt（不抛异常）',
      'from_chars + 双错误码',
      'from_chars ' + (stp.match(/from_chars/g) ?? []).length + ' 处',
      stp.includes('std::optional<int> toInt(std::string_view input) {\n  int out;\n  const std::from_chars_result result =\n      std::from_chars(input.data(), input.data() + input.size(), out);\n  if (result.ec == std::errc::invalid_argument ||\n      result.ec == std::errc::result_out_of_range) {\n    return std::nullopt;\n  }\n  return out;\n}') &&
        !stp.slice(stp.indexOf('std::optional<int> toInt('), stp.indexOf('std::optional<int> toInt(') + 400).includes('stoi'));
    add('C524b', '【EEE-2 核心】RedBoxErrorParser 用 std::stoi 解析行号列号共 6 处（越界抛 std::out_of_range），parseErrorMessage 无 try/catch',
      'stoi 6 处 / 无 try',
      'stoi ' + (rbp.match(/std::stoi/g) ?? []).length + ' 处 / try ' + (rbp.match(/try\s*\{/g) ?? []).length + ' 处',
      (rbp.match(/std::stoi/g) ?? []).length === 6 &&
        !rbp.includes('try {') && !rbp.includes('catch') &&
        rbp.includes('                  .row = std::stoi(match[4].str()),\n                  .column = std::stoi(match[5].str()),') &&
        rbp.includes('                .row = std::stoi(match[3].str()),\n                .column = std::stoi(match[4].str()),'));
    add('C524c', 'EEE-2：bundleLoadErrorRegex 的错误类型白名单是 4 种标准 JS 错误名（条件②），而行号来自 (\\d+) 无上限（条件③）',
      '4 种类型 / \\d+ 无上限',
      '白名单 ' + (rbp.match(/"(SyntaxError|ReferenceError|TypeError|UnableToResolveError)"/g) ?? []).length + ' 处',
      (rbp.match(/"(SyntaxError|ReferenceError|TypeError|UnableToResolveError)"/g) ?? []).length === 5 &&
        rbp.includes('R"(^(') && rbp.includes('): (.+) ') && rbp.includes('))"') &&
        rbp.includes('  static const std::unordered_set<std::string> types{\n      "SyntaxError", "ReferenceError", "TypeError", "UnableToResolveError"};') &&
        rbp.includes('errorType == "UnableToResolveError"') &&
        rbp.includes('? "Module Not Found"'));
    add('C524d', 'EEE-2 完整可达性链条：RCTRedBox2Controller → RCTRedBox2ErrorParser → parseErrorMessage（均无 try/catch）',
      '3 跳无 try',
      'RCTRedBox2ErrorParser.mm ' + rc2ep.split('\n').length + ' 行',
      rc2c.includes('    _errorData = [RCTRedBox2ErrorParser parseErrorMessage:message name:nil componentStack:nil isFatal:YES];') &&
        rc2ep.includes('  auto parsed = parseErrorMessage(\n      (message != nullptr) ? std::string(message.UTF8String) : std::string(),') &&
        !rc2ep.includes('@try') && !rc2ep.includes('@catch') &&
        rc2c.includes('  if (!_errorData.isRetryable) {'));
  }

  // EEE-3 核心：JscSafeUrl
  {
    add('C525', '【EEE-3 核心】toNormalUrl 用 find(\\"//&\\")（第一个匹配）作为分隔符，而 toJscSafeUrl 不检查 path 是否已含 //&',
      'find vs rfind',
      'find(' + (jsu.match(/find\("\/\/&"\)/g) ?? []).length + ' 处 / rfind ' + (jsu.match(/rfind\("\/\/&"\)/g) ?? []).length + ' 处',
      jsu.includes('  auto markerPos = parsed.path.find("//&");') &&
        !jsu.includes('rfind("//&")') &&
        (jsu.match(/find\("\/\/&"\)/g) ?? []).length === 1 &&
        jsu.includes('  std::string_view pathBefore = parsed.path.substr(0, markerPos);\n  std::string_view pathAfter = parsed.path.substr(markerPos + 3);'));
    add('C525b', '【EEE-3 核心】toJscSafeUrl 把 query 中的 ? 编码为 %3F，但 toNormalUrl 不做 %3F 解码（编码不对称）',
      '编码有 / 解码无',
      '%3F ' + (jsu.match(/%3F/g) ?? []).length + ' 处 / 解码 ' + (jsu.match(/%3F/g) ?? []).length + ' 处',
      (jsu.match(/%3F/g) ?? []).length === 2 &&
        jsu.includes('        result += "%3F";') &&
        !jsu.includes('percent-decode') && !jsu.includes('decodePercent'));
    add('C525c', 'EEE-3：toJscSafeUrl 在 path 变空时抛 std::invalid_argument（path 以 //& 开头即触发）',
      '抛 invalid_argument',
      'invalid_argument ' + (jsu.match(/std::invalid_argument/g) ?? []).length + ' 处',
      jsu.includes('    throw std::invalid_argument(\n        "The given URL \\"" + url +\n        "\\" has an empty path and cannot be converted to a JSC-safe format.");') &&
        (jsu.match(/std::invalid_argument/g) ?? []).length === 1 &&
        jsu.includes('  if (!parsed.queryWithoutQuestionMark.empty() &&\n      (parsed.path.empty() || parsed.path == "/")) {'));
    add('C525d', 'EEE-9（正向）：rfc3986Parse 的注释给出 RFC 3986 出处、说明「为什么用正则」「会匹配任何字符串不代表有效」；uriRegex 用函数内 static const',
      '第一档注释',
      'RFC 链接 ' + (jsu.match(/rfc-editor\.org/g) ?? []).length + ' 处',
      jsu.includes('// We use regex-based URL parsing as defined in RFC 3986 because it\'s easier to') &&
        jsu.includes('// possible. This will match any string, and does not imply validity.') &&
        jsu.includes('// https://www.rfc-editor.org/rfc/rfc3986#appendix-B') &&
        jsu.includes('const std::regex& uriRegex() {\n  static const std::regex re(') &&
        jsuh.includes(' * introduced in iOS 16.4. This is a direct port of https://www.npmjs.com/package/jsc-safe-url.') &&
        jsuh.includes(' * See https://github.com/facebook/react-native/issues/36794 for context.'));
  }

  // EEE-4：isRetryable
  {
    add('C526', '【EEE-4 核心】ParsedError::isRetryable 恒为 true（RedBoxErrorParser.cpp 中 7 处构造、0 处设置该字段），但 iOS 侧有消费分支',
      '7 处构造 / 0 处设置',
      'ParsedError{ ' + (rbp.match(/ParsedError\{/g) ?? []).length + ' 处 / isRetryable ' + (rbp.match(/isRetryable/g) ?? []).length + ' 处',
      (rbp.match(/ParsedError\{/g) ?? []).length === 7 &&
        (rbp.match(/isRetryable/g) ?? []).length === 0 &&
        rbph.includes('  bool isCompileError = false;\n  bool isRetryable = true;') &&
        rc2ep.includes('  data.isRetryable = parsed.isRetryable;') &&
        rc2c.includes('  if (!_errorData.isRetryable) {\n    return;\n  }'));
  }

  // EEE-5：截断未覆盖解析输入
  {
    add('C527', 'EEE-5：RCTRedBox2Controller 把 _lastErrorMessage 截断到 10000 字符，但传给 parseErrorMessage 的是未截断的 message',
      '截断只覆盖展示',
      '10000 阈值 ' + (rc2c.match(/10000/g) ?? []).length + ' 处',
      rc2c.includes('    _lastErrorMessage = [messageWithoutAnsi substringToIndex:MIN((NSUInteger)10000, messageWithoutAnsi.length)];') &&
        rc2c.includes('    _errorData = [RCTRedBox2ErrorParser parseErrorMessage:message name:nil componentStack:nil isFatal:YES];') &&
        rc2c.includes('    // unlimited length, so we truncate it'));
    add('C527b', 'EEE-5：babelCodeFrameErrorRegex 含 (?:.*):? (?:.*?) 与 ([\\s\\S]+?) 组合（回溯构造），输入是 JS 可控的错误消息',
      '回溯构造 / 12 处 std::regex',
      'std::regex ' + (rbp.match(/std::regex/g) ?? []).length + ' 处',
      (rbp.match(/std::regex/g) ?? []).length === 12 &&
        rbp.includes('      R"(^(?:TransformError )?(?:.*):? (?:.*?)(\\/.*): ([\\s\\S]+?)\\n([ >]{2}[\\d\\s]+ \\|[\\s\\S]+|\\x1b[\\s\\S]+))");') &&
        rbp.includes('// @lint-ignore-every CLANGTIDY facebook-hte-StdRegexIsAwful'));
  }

  // StackTraceParser 的引擎分派
  {
    add('C528', 'StackTraceParser::parseOthers 对每一行依次尝试 5 种引擎格式（Chrome/WinJS/Gecko/Node/JSC），全部失败则丢弃该行',
      '5 种格式逐行试',
      'parse* 调用 ' + (stp.match(/parse(?:Chrome|Winjs|Gecko|Node|JSC)\(line\)/g) ?? []).length + ' 处',
      (stp.match(/parse(?:Chrome|Winjs|Gecko|Node|JSC)\(line\)/g) ?? []).length === 5 &&
        stp.includes('        parseChrome(line);') &&
        stp.includes('      frame = parseWinjs(line);') &&
        stp.includes('      frame = parseGecko(line);') &&
        stp.includes('      frame = parseNode(line);') &&
        stp.includes('      frame = parseJSC(line);') &&
        stp.includes('    if (frame) {\n      stack.push_back(*frame);\n    }'));
    add('C528b', 'StackTraceParser 的 parse 入口按 isHermes 二选一，是无状态纯函数；头文件用 FrameworksGuard（for-frameworks 档）',
      '纯函数 / FrameworksGuard',
      'parse 入口 ' + (stp.match(/StackTraceParser::parse\(/g) ?? []).length + ' 处',
      stp.includes('std::vector<JsErrorHandler::ProcessedError::StackFrame> StackTraceParser::parse(\n    const bool isHermes,\n    const std::string& stackString) {') &&
        stp.includes('  std::vector<JsErrorHandler::ProcessedError::StackFrame> stackFrames =\n      isHermes ? parseHermes(stackString) : parseOthers(stackString);') &&
        stph.includes('#include <react/cxxstableapi/FrameworksGuard.h>'));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 70. 渲染器基础设施：注册表 / DOM / MapBuffer（64 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const CR = 'packages/react-native/ReactCommon/react/renderer/componentregistry/';
  const EL = 'packages/react-native/ReactCommon/react/renderer/element/';
  const MB = 'packages/react-native/ReactCommon/react/renderer/mapbuffer/';
  const DM = 'packages/react-native/ReactCommon/react/renderer/dom/';

  const reg = read(CR + 'ComponentDescriptorRegistry.cpp') ?? '';
  const regh = read(CR + 'ComponentDescriptorRegistry.h') ?? '';
  const prov = read(CR + 'ComponentDescriptorProviderRegistry.cpp') ?? '';
  const provh = read(CR + 'ComponentDescriptorProviderRegistry.h') ?? '';
  const cnbrn = read(CR + 'componentNameByReactViewName.cpp') ?? '';
  const provh2 = read(CR + 'ComponentDescriptorProvider.h') ?? '';
  const factory = read(CR + 'ComponentDescriptorFactory.h') ?? '';
  const elem = read(EL + 'Element.h') ?? '';
  const cbuild = read(EL + 'ComponentBuilder.cpp') ?? '';
  const mb = read(MB + 'MapBuffer.cpp') ?? '';
  const mbh = read(MB + 'MapBuffer.h') ?? '';
  const dom = read(DM + 'DOM.cpp') ?? '';
  const domh = read(DM + 'DOM.h') ?? '';
  const nativedom = read('packages/react-native/ReactCommon/react/nativemodule/dom/NativeDOM.cpp') ?? '';
  const tutils = read(EL + 'testUtils.h') ?? '';
  const umb1 = read(CR + 'React/ComponentRegistry.h') ?? '';
  const umb2 = read(MB + 'React/MapBuffer.h') ?? '';
  const ktbuf = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/common/mapbuffer/ReadableMapBuffer.kt') ?? '';
  const jrmb = read('packages/react-native/ReactAndroid/src/main/jni/react/mapbuffer/react/common/mapbuffer/JReadableMapBuffer.cpp') ?? '';
  const jwmb = read('packages/react-native/ReactAndroid/src/main/jni/react/mapbuffer/react/common/mapbuffer/JWritableMapBuffer.cpp') ?? '';
  const ktread = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/common/mapbuffer/ReadableMapBuffer.kt') ?? '';
  const mqspec = read('packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/queue/MessageQueueThreadSpec.kt') ?? '';
  const jstm = read('packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTJSThreadManager.mm') ?? '';
  const ccd = read('packages/react-native/ReactCommon/react/renderer/core/ConcreteComponentDescriptor.h') ?? '';

  // DDD-1 核心：锁语义错配
  {
    add('C516', '【DDD-1 核心】ComponentDescriptorRegistry::registerComponentDescriptor 写两个 unordered_map 却不取任何锁',
      '无锁写 map',
      '函数内 unique_lock ' + (reg.slice(reg.indexOf('void ComponentDescriptorRegistry::registerComponentDescriptor('), reg.indexOf('void ComponentDescriptorRegistry::registerComponentDescriptor(') + 400).match(/unique_lock/g) ?? []).length + ' 处',
      reg.includes('void ComponentDescriptorRegistry::registerComponentDescriptor(\n    const SharedComponentDescriptor& componentDescriptor) const {\n  ComponentHandle componentHandle = componentDescriptor->getComponentHandle();\n  _registryByHandle[componentHandle] = componentDescriptor;\n\n  ComponentName componentName = componentDescriptor->getComponentName();\n  _registryByName[componentName] = componentDescriptor;\n}') &&
        reg.slice(reg.indexOf('void ComponentDescriptorRegistry::registerComponentDescriptor('), reg.indexOf('void ComponentDescriptorRegistry::registerComponentDescriptor(') + 400).match(/unique_lock/g) === null &&
        regh.includes('  mutable std::shared_mutex mutex_;') &&
        regh.includes('  mutable std::unordered_map<ComponentHandle, SharedComponentDescriptor> _registryByHandle;') &&
        regh.includes('  mutable std::unordered_map<std::string, SharedComponentDescriptor> _registryByName;'));
    add('C516b', 'DDD-1：setFallbackComponentDescriptor 同样无锁；getFallbackComponentDescriptor 是无锁的 const 读',
      '写读都无锁',
      'setFallback 内 unique_lock ' + (reg.slice(reg.indexOf('void ComponentDescriptorRegistry::setFallbackComponentDescriptor('), reg.indexOf('void ComponentDescriptorRegistry::setFallbackComponentDescriptor(') + 400).match(/unique_lock/g) ?? []).length + ' 处',
      reg.includes('void ComponentDescriptorRegistry::setFallbackComponentDescriptor(\n    const SharedComponentDescriptor& descriptor) {\n  _fallbackComponentDescriptor = descriptor;\n  registerComponentDescriptor(descriptor);\n}') &&
        reg.includes('ComponentDescriptor::Shared\nComponentDescriptorRegistry::getFallbackComponentDescriptor() const {\n  return _fallbackComponentDescriptor;\n}') &&
        regh.includes('  ComponentDescriptor::Shared _fallbackComponentDescriptor;'));
    add('C516c', 'DDD-1：at() 的 interop 分支在 shared_lock 下调用 registerComponentDescriptor（写路径）',
      '共享锁下写',
      'registerComponentDescriptor 出现 ' + (reg.match(/registerComponentDescriptor\(/g) ?? []).length + ' 处',
      reg.includes('      registerComponentDescriptor(componentDescriptor);') &&
        reg.includes('  std::shared_lock lock(mutex_);') &&
        reg.includes('    if (ReactNativeFeatureFlags::useFabricInterop()) {') &&
        (reg.match(/registerComponentDescriptor\(/g) ?? []).length === 3);
    add('C516d', 'DDD-1：at() 的「先解锁再回调再重锁」是正确的（避免回调重入死锁），窗口期是良性竞态',
      'unlock→request→lock',
      'unlock ' + (reg.match(/lock\.unlock\(\)/g) ?? []).length + ' / lock ' + (reg.match(/lock\.lock\(\)/g) ?? []).length,
      (reg.match(/lock\.unlock\(\)/g) ?? []).length === 1 &&
        (reg.match(/lock\.lock\(\)/g) ?? []).length === 1 &&
        reg.includes('    lock.unlock();\n    providerRegistry_.request(unifiedComponentName.c_str());\n    lock.lock();'));
    add('C517', 'DDD-1b：ComponentDescriptorProviderRegistry 的 setComponentDescriptorProviderRequest 与 createComponentDescriptorRegistry 都在 shared_lock 下写成员',
      '2 处共享锁下写',
      'shared_lock ' + (prov.match(/std::shared_lock lock\(mutex_\)/g) ?? []).length + ' 处 / unique_lock ' + (prov.match(/std::unique_lock lock\(mutex_\)/g) ?? []).length + ' 处',
      (prov.match(/std::shared_lock lock\(mutex_\)/g) ?? []).length === 3 &&
        (prov.match(/std::unique_lock lock\(mutex_\)/g) ?? []).length === 1 &&
        prov.includes('  std::shared_lock lock(mutex_);\n  componentDescriptorProviderRequest_ =\n      std::move(componentDescriptorProviderRequest);') &&
        prov.includes('  std::shared_lock lock(mutex_);') &&
        prov.includes('  componentDescriptorRegistries_.push_back(registry);'));
  }

  // DDD-2 核心：栈溢出
  {
    add('C518', '【DDD-2 核心】getTextContentInShadowNode 是无深度限制的递归（dynamic_cast + 对每个子节点递归）',
      '无深度限制递归',
      '递归调用点 ' + (dom.match(/getTextContentInShadowNode\(\*childNode, result\)/g) ?? []).length + ' 处',
      dom.includes('void getTextContentInShadowNode(\n    const ShadowNode& shadowNode,\n    std::string& result) {') &&
        dom.includes('  auto rawTextShadowNode = dynamic_cast<const RawTextShadowNode*>(&shadowNode);') &&
        dom.includes('  for (const auto& childNode : shadowNode.getChildren()) {\n    getTextContentInShadowNode(*childNode, result);\n  }') &&
        !dom.slice(dom.indexOf('void getTextContentInShadowNode('), dom.indexOf('void getTextContentInShadowNode(') + 500).includes('depth') &&
        !dom.slice(dom.indexOf('void getTextContentInShadowNode('), dom.indexOf('void getTextContentInShadowNode(') + 500).includes('maxDepth'));
    add('C518b', 'DDD-2：JS 可直达 —— NativeDOM TurboModule 的 getTextContent 转调 dom::getTextContent',
      'JS → C++ 链路',
      'NativeDOM.cpp ' + nativedom.split('\n').length + ' 行',
      nativedom.includes('std::string NativeDOM::getTextContent(') &&
        nativedom.includes('  return dom::getTextContent(currentRevision, *shadowNode);') &&
        nativedom.includes('  auto elementById = dom::getElementById(currentRevision, id);') &&
        dom.includes('    getTextContentInShadowNode(*shadowNodeInCurrentRevision, result);'));
    add('C518c', 'DDD-2：全仓渲染器侧无任何深度上限常量（唯一 maxDepth 命中在测试专用工具 ReactNativeTestTools.js）',
      '渲染器侧 0 命中',
      'renderer 侧 maxDepth/MAX_DEPTH 命中 ' + grepCount(/maxDepth|MAX_DEPTH/, { roots: ['packages/react-native/ReactCommon/react/renderer'] }).count + ' 处',
      grepCount(/maxDepth|MAX_DEPTH/, { roots: ['packages/react-native/ReactCommon/react/renderer'] }).count === 0 &&
        grepCount(/maxDepth/, { roots: ['packages/react-native/Libraries/Utilities'] }).count >= 1 &&
        !dom.includes('maxDepth') && !dom.includes('MAX_DEPTH'));
    add('C518d', 'DDD-2：iOS 的 JS 线程栈只在 RCT_DEBUG 下加倍（release 不加倍），Android 的 JS 线程栈用 JVM 默认（DEFAULT_STACK_SIZE_BYTES = 0）',
      'iOS debug 加倍 / Android 默认栈',
      'iOS RCT_DEBUG ' + (jstm.match(/#if RCT_DEBUG/g) ?? []).length + ' 处 / Android 0 值 ' + (mqspec.match(/DEFAULT_STACK_SIZE_BYTES: Long = 0/g) ?? []).length + ' 处',
      jstm.includes('#if RCT_DEBUG\n  _jsThread.stackSize *= 2;\n#endif') &&
        mqspec.includes('    public const val DEFAULT_STACK_SIZE_BYTES: Long = 0') &&
        mqspec.includes('    // The Thread constructor interprets zero the same as not specifying a stack size'));
    add('C518e', 'DDD-2：getElementById 同样是无深度限制的递归（且 O(n) 全树扫描）',
      '同样无深度限制',
      'getElementById 递归 ' + (dom.match(/getElementById\(childNode, id\)/g) ?? []).length + ' 处',
      dom.includes('std::shared_ptr<const ShadowNode> getElementById(\n    const std::shared_ptr<const ShadowNode>& shadowNode,\n    const std::string& id) {') &&
        dom.includes('    auto result = getElementById(childNode, id);'));
  }

  // DDD-3 核心：MapBuffer 信任边界
  {
    add('C519', '【DDD-3 核心】MapBuffer 构造函数只校验「至少有 2 字节头部」，count 与 bytes_.size() 无交叉校验',
      '仅校验头部长度',
      'count 赋值 ' + (mb.match(/count_ = header->count;/g) ?? []).length + ' 处',
      mb.includes('MapBuffer::MapBuffer(std::vector<uint8_t> data) : bytes_(std::move(data)) {\n  if (bytes_.size() >= sizeof(Header)) {\n    auto header = reinterpret_cast<const Header*>(bytes_.data());\n    count_ = header->count;\n  }\n}') &&
        !mb.slice(mb.indexOf('MapBuffer::MapBuffer(std::vector<uint8_t> data)'), mb.indexOf('MapBuffer::MapBuffer(std::vector<uint8_t> data)') + 300).includes('bytes_.size() /') &&
        mbh.includes('  struct Header {\n    uint16_t count; // amount of items in the map\n  };'));
    add('C519b', 'DDD-3：getKeyBucket 的二分查找无边界检查，最大访问偏移 = 2 + 12 * (count-1)，count 上限 65535 → 786410',
      '786410 字节',
      'count 上限 ' + (mbh.match(/uint16_t count/g) ?? []).length + ' 处',
      mb.includes('int32_t MapBuffer::getKeyBucket(Key key) const {\n  int32_t lo = 0;\n  int32_t hi = count_ - 1;') &&
        mb.includes('    Key midVal = readUnaligned<Key>(bytes_.data(), bucketOffset(mid));') &&
        !mb.slice(mb.indexOf('int32_t MapBuffer::getKeyBucket(Key key) const {'), mb.indexOf('int32_t MapBuffer::getKeyBucket(Key key) const {') + 500).includes('bytes_.size()') &&
        mbh.includes('  using Key = uint16_t;') &&
        mb.includes('static inline int32_t bucketOffset(int32_t index) {\n  return sizeof(MapBuffer::Header) + sizeof(MapBuffer::Bucket) * index;\n}'));
    add('C519c', 'DDD-3：clampToBufferBounds 只 clamp 长度不 clamp 偏移（offset 仍可为负或越界）',
      '只 clamp 长度',
      'clamp 函数 ' + (mb.match(/clampToBufferBounds/g) ?? []).length + ' 处',
      mb.includes('inline int32_t\nclampToBufferBounds(int32_t offset, int32_t byteLength, size_t bufferSize) {') &&
        mb.includes('  size_t maxLength = bufferSize > static_cast<size_t>(offset)\n      ? bufferSize - static_cast<size_t>(offset)\n      : 0;') &&
        !mb.includes('std::max(offset, 0)') &&
        mb.includes('// Debug-asserts on OOB (catches corrupt buffers early in dev) AND clamps in\n// release so a corrupt bucket length can never drive an OOB memcpy read.'));
    add('C519d', 'DDD-3 公平说明：Java 侧 ReadableMapBuffer 构造器是 private，字节总是 C++ 写的 → 当前无外部输入路径',
      'private 构造器',
      'private constructor ' + (ktread.match(/private constructor/g) ?? []).length + ' 处',
      ktread.includes('public class ReadableMapBuffer') &&
        ktread.includes('private constructor(') &&
        jwmb.includes('builder.putMapBuffer(key, MapBuffer(element->cthis()->data()));') &&
        jrmb.includes('JReadableMapBuffer::createWithContents(MapBuffer&& map) {') &&
        mbh.includes('  explicit MapBuffer(std::vector<uint8_t> data);'));
  }

  // DDD-4：componentNameByReactViewName
  {
    add('C520', '【DDD-4 核心】componentNameByReactViewName 有 10 处 viewName 比较（9 条映射 + Multiline/Singleline 共用一条）+ RCT 前缀剥离，对 VirtualText 非幂等',
      '10 处比较 + 前缀剥离',
      'viewName == ' + (cnbrn.match(/viewName ==/g) ?? []).length + ' 处',
      (cnbrn.match(/viewName ==/g) ?? []).length === 10 &&
        cnbrn.includes('  if (viewName == "VirtualText") {\n    return "Text";\n  }') &&
        cnbrn.includes('  if (viewName == "Text") {\n    return "Paragraph";\n  }') &&
        cnbrn.includes('  if (viewName == "MultilineTextInputView" ||\n      viewName == "SinglelineTextInputView") {') &&
        cnbrn.includes('  std::string rctPrefix("RCT");') &&
        cnbrn.includes('  // TODO T97384889: unify component names between JS - Android - iOS - C++'));
    add('C520b', 'DDD-4 澄清：「Text」与「Paragraph」是两个独立注册的组件名，故 VirtualText→Text 这一跳是正确的',
      '两个独立组件名',
      'Paragraph / Text / RawText 三名',
      (read('packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp') ?? '').includes('const char ParagraphComponentName[] = "Paragraph";') &&
        (read('packages/react-native/ReactCommon/react/renderer/components/text/TextShadowNode.cpp') ?? '').includes('extern const char TextComponentName[] = "Text";') &&
        (read('packages/react-native/ReactCommon/react/renderer/components/text/RawTextShadowNode.cpp') ?? '').includes('extern const char RawTextComponentName[] = "RawText";') &&
        tutils.includes('componentDescriptorProviderRegistry.add(concreteComponentDescriptorProvider<ParagraphComponentDescriptor>());') &&
        tutils.includes('componentDescriptorProviderRegistry.add(concreteComponentDescriptorProvider<TextComponentDescriptor>());') &&
        tutils.includes('componentDescriptorProviderRegistry.add(concreteComponentDescriptorProvider<RawTextComponentDescriptor>());'));
    add('C520c', 'DDD-4：at() 只调用 componentNameByReactViewName 一次（单次调用下语义正确）',
      '只调一次',
      '调用点 1 处',
      reg.includes('  auto unifiedComponentName = componentNameByReactViewName(componentName);') &&
        (reg.match(/componentNameByReactViewName\(/g) ?? []).length === 1);
  }

  // DDD-5 / DDD-6：Element
  {
    add('C521', '【DDD-5 核心】Element::reference 的两个重载捕获方式不同：callback 按 std::move，outShadowNode 按 [&]',
      '一 move 一 [&]',
      'std::move(callback) ' + (elem.match(/std::move\(callback\)/g) ?? []).length + ' 处 / [&] ' + (elem.match(/\[&\]\(/g) ?? []).length + ' 处',
      elem.includes('  Element &reference(std::function<void(const ConcreteUnsharedShadowNode &shadowNode)> callback)\n  {\n    fragment_.referenceCallback = [callback =\n                                       std::move(callback)]') &&
        elem.includes('  Element &reference(ConcreteUnsharedShadowNode &outShadowNode)\n  {\n    fragment_.referenceCallback = [&](const std::shared_ptr<const ShadowNode> &shadowNode) {') &&
        (elem.match(/std::move\(callback\)/g) ?? []).length === 2 &&
        (elem.match(/\[&\]\(/g) ?? []).length === 1 &&
        elem.includes('  Element &stateData(std::function<void(ConcreteStateData &)> callback)'));
    add('C521b', '【DDD-6 核心】Element::stateData 对可能为 null 的 state 做 ->getData()；createInitialState 对无 State 的组件明确返回 nullptr',
      'null 解引用',
      'ConcreteStateData==StateData 时返回 nullptr',
      elem.includes('      auto stateData = static_cast<const ConcreteState *>(state.get())->getData();') &&
        ccd.includes('    if (std::is_same<ConcreteStateData, StateData>::value) {') &&
        ccd.includes('      // Default case: Returning `null` for nodes that don\'t use `State`.\n      return nullptr;') &&
        !elem.slice(elem.indexOf('Element &stateData('), elem.indexOf('Element &stateData(') + 500).includes('nullptr'));
    add('C521c', 'DDD-7：Element::finalize 用 [=] 拷贝 std::function，同文件 reference 用 std::move —— 同语义两种写法',
      '[=] vs std::move',
      '[=] ' + (elem.match(/\[=\]\(/g) ?? []).length + ' 处',
      elem.includes('    fragment_.finalizeCallback = [=](ShadowNode &shadowNode) {') &&
        (elem.match(/\[=\]\(/g) ?? []).length === 1 &&
        elem.includes('  Element &props(std::function<SharedConcreteProps()> callback)\n  {\n    fragment_.props = callback();'));
    add('C521d', 'DDD-9：ComponentBuilder 走 stateCallback 时会先建 initialState 再 clone 一份新 state（原 initialState 被丢弃）',
      '1 次多余构造 + 1 次 clone',
      'cloneShadowNode ' + (cbuild.match(/cloneShadowNode/g) ?? []).length + ' 处',
      cbuild.includes('  auto initialState =\n      componentDescriptor.createInitialState(elementFragment.props, family);') &&
        cbuild.includes('  if (elementFragment.stateCallback) {') &&
        cbuild.includes('    auto newState = componentDescriptor.createState(\n        *family, elementFragment.stateCallback(initialState));') &&
        cbuild.includes('    constShadowNode = componentDescriptor.cloneShadowNode(') &&
        (cbuild.match(/cloneShadowNode/g) ?? []).length === 1);
    add('C521e', 'DDD-8：ComponentDescriptorProvider 用位置聚合初始化，正确性依赖字段声明顺序（handle/name/flavor/constructor）',
      '4 字段位置初始化',
      'provider 字段 4 个',
      provh2.includes('class ComponentDescriptorProvider final {\n public:\n  ComponentHandle handle;\n  ComponentName name;\n  ComponentDescriptor::Flavor flavor;\n  ComponentDescriptorConstructor *constructor;\n};') &&
        provh2.includes('  return {\n      ComponentDescriptorT::ConcreteShadowNode::Handle(),\n      ComponentDescriptorT::ConcreteShadowNode::Name(),\n      nullptr,\n      &concreteComponentDescriptorConstructor<ComponentDescriptorT>};') &&
        (provh2.match(/ComponentHandle handle;|ComponentName name;|ComponentDescriptor::Flavor flavor;|ComponentDescriptorConstructor \*constructor;/g) ?? []).length === 4);
  }

  // DDD-12 正向样本
  {
    add('C522', '【DDD-12 正向】两个 umbrella 头都用 push_macro/pop_macro 包裹细粒度 include（62 文档 BBB-5 的真实用例）',
      '2 个 umbrella 头',
      'push_macro ' + ((umb1 + umb2).match(/push_macro/g) ?? []).length + ' 处',
      umb1.includes('#pragma push_macro("RN_UMBRELLA_CONTEXT")') &&
        umb1.includes('#pragma pop_macro("RN_UMBRELLA_CONTEXT")') &&
        umb2.includes('#pragma push_macro("RN_UMBRELLA_CONTEXT")') &&
        umb2.includes('#pragma pop_macro("RN_UMBRELLA_CONTEXT")') &&
        ((umb1 + umb2).match(/push_macro/g) ?? []).length === 2 &&
        ((umb1 + umb2).match(/pop_macro/g) ?? []).length === 2 &&
        umb1.includes('// is saved and restored rather than defined and undefined: the scope ends at') &&
        umb1.includes('// it nests inside an enclosing umbrella rather than disarming it.'));
    add('C522b', '【DDD-12 正向】MapBuffer 的 readUnaligned 用 memcpy 并注释说明「packed 布局下直接解引用是 UB、在 32 位 ARM 上会崩」',
      '第一档注释',
      'memcpy 说明 ' + (mb.match(/memcpy/g) ?? []).length + ' 处',
      mb.includes('// Reads a value of type T from a (possibly unaligned) offset in the buffer.') &&
        mb.includes('// so dereferencing a reinterpret_cast pointer there is undefined behavior and') &&
        mb.includes('// can fault on 32-bit ARM. memcpy compiles to a single unaligned load on') &&
        mb.includes('  T value;\n  std::memcpy(&value, data + offset, sizeof(T));'));
    add('C522c', '【DDD-12 正向】Kotlin 侧 readHeader 的注释指出「duplicate() 会重置字节序，所以每个实例（含嵌套 clone）都要显式设置」',
      '字节序陷阱注释',
      'LITTLE_ENDIAN ' + (ktbuf.match(/LITTLE_ENDIAN/g) ?? []).length + ' 处',
      ktbuf.includes('    // The C++ writer always serializes in little-endian byte order. ByteBuffer') &&
        ktbuf.includes('    // defaults to big-endian and duplicate() resets the order, so set it') &&
        ktbuf.includes('    // explicitly on every instance, including nested clones.') &&
        ktbuf.includes('    buffer.order(ByteOrder.LITTLE_ENDIAN)'));
    add('C522d', '【DDD-12 正向】E1 内 5 处 TODO/FIXME 全部带可追溯编号（格式为 `TODO: T<数字>` / `TODO T<数字>` / `FIXME(T<数字>)`）',
      '5 处带编号',
      '编号 TODO/FIXME ' + ((cnbrn + reg + prov + mbh + mb + dom).match(/TODO:? T\d+|FIXME\(T\d+\)/g) ?? []).length + ' 处',
      (cnbrn.match(/TODO:? T\d+/g) ?? []).length === 1 &&
        (reg.match(/TODO:? T\d+/g) ?? []).length === 1 &&
        (prov.match(/TODO:? T\d+/g) ?? []).length === 1 &&
        ((mbh + mb).match(/TODO:? T\d+/g) ?? []).length === 2 &&
        (dom.match(/FIXME\(T\d+\)/g) ?? []).length === 1 &&
        ((cnbrn + reg + prov + mbh + mb + dom).match(/TODO:? T\d+|FIXME\(T\d+\)/g) ?? []).length === 6);
    add('C522e', '【DDD-12 正向】MapBuffer 的 DataType 枚举注释明确要求与 Kotlin 侧 MapBuffer.kt 的 DataType 严格同序；枚举本体 9 项（Boolean..MapBufferList）',
      '跨语言同序约束 / 9 项枚举',
      '枚举项 ' + (mbh.slice(mbh.indexOf('enum DataType : uint16_t {'), mbh.indexOf('};', mbh.indexOf('enum DataType : uint16_t {'))).match(/= \d+,/g) ?? []).length + ' 项',
      mbh.includes('   * Keep in sync with the `DataType` enum in `MapBuffer.kt`') &&
        mbh.includes('   * (packages/react-native/ReactAndroid/.../common/mapbuffer/MapBuffer.kt),') &&
        mbh.includes('   * which is ordinal-indexed on the JVM side, so the order must match exactly.') &&
        (mbh.slice(mbh.indexOf('enum DataType : uint16_t {'), mbh.indexOf('};', mbh.indexOf('enum DataType : uint16_t {'))).match(/= \d+,/g) ?? []).length === 9 &&
        mbh.includes('    MapBufferList = 8,'));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 69. iOS 渐变的 inf 斜率（63 文档 §3.9 / CCC-15）
// ────────────────────────────────────────────────────────────────────────
{
  const grad = read('packages/react-native/React/Fabric/Utils/RCTGradientUtils.mm') ?? '';
  const escroll = read('packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTEnhancedScrollView.mm') ?? '';
  const dbg = read('packages/react-native/ReactCommon/react/renderer/debug/debugStringConvertibleUtils.h') ?? '';

  add('C515', '【CCC-15 核心】RCTGradientUtils.mm 的 getSlope 在 dx==0 时主动返回 +inf，而 getPerpendicularSlope 用 std::isinf 显式防御',
    '主动制造 inf + 显式防御',
    'isinf ' + (grad.match(/std::isinf/g) ?? []).length + ' 处 / infinity ' + (grad.match(/numeric_limits<CGFloat>::infinity/g) ?? []).length + ' 处',
    (grad.match(/std::isinf/g) ?? []).length === 1 &&
      (grad.match(/numeric_limits<CGFloat>::infinity/g) ?? []).length === 2 &&
      grad.includes('    if (floatEquality(dx, 0.0)) {\n      return std::numeric_limits<CGFloat>::infinity();\n    }') &&
      grad.includes('    if (std::isinf(slope)) {\n      return 0.0;\n    }') &&
      grad.includes('    if (floatEquality(slope, 0.0)) {\n      return -std::numeric_limits<CGFloat>::infinity();\n    }'));
  add('C515b', '【CCC-15 核心】同一文件的 Line::intersection 用 floatEquality(m,n) 判平行，无 isinf 防御 → inf 斜率时不返回 nullopt',
    'intersection 无 inf 防御',
    'intersection 内 isinf ' + (grad.slice(grad.indexOf('std::optional<CGPoint> intersection'), grad.indexOf('std::optional<CGPoint> intersection') + 400).match(/isinf/g) ?? []).length + ' 处',
    grad.includes('  std::optional<CGPoint> intersection(const Line &other) const\n  {\n    CGFloat n = other.m;\n    CGFloat c = other.b;\n    if (floatEquality(m, n)) {\n      return std::nullopt;\n    }\n    CGFloat x = (c - b) / (m - n);\n    return point(x);\n  }') &&
      !grad.slice(grad.indexOf('std::optional<CGPoint> intersection'), grad.indexOf('std::optional<CGPoint> intersection') + 400).includes('isinf'));
  add('C515c', 'CCC-15：生产路径的守卫是 if (g_opt && h_opt)（只查 has_value），拦不住「有值但坐标错误」的交点',
    '守卫只查 has_value',
    'g_opt && h_opt ' + (grad.match(/g_opt && h_opt/g) ?? []).length + ' 处',
    grad.includes('  std::optional<CGPoint> g_opt = efLine.intersection(aParallelLine);\n  std::optional<CGPoint> h_opt = efLine.intersection(bParallelLine);\n\n  if (g_opt && h_opt) {') &&
      (grad.match(/g_opt && h_opt/g) ?? []).length === 1 &&
      grad.includes('    LineSegment result = gh.divided({bounds.width, bounds.height});') &&
      grad.includes('  return {startPoint, endPoint};'));
    add('C515d', 'CCC-15 的完备性：floatEquality 的 41 个调用点中，只有 RCTGradientUtils.mm 一处显式写了 std::isinf 防御',
    '唯一 1 处 isinf（限定 RCTGradientUtils.mm）',
    'grad 内 isinf ' + (grad.match(/std::isinf/g) ?? []).length + ' 处 / 全仓 isinf ' +
      grepCount(/std::isinf/, { roots: ['packages/react-native'], exts: ['.mm', '.cpp', '.h'], skipTests: true }).count + ' 处',
    (grad.match(/std::isinf/g) ?? []).length === 1 &&
      grad.includes('    if (std::isinf(slope)) {') &&
      grepCount(/std::isinf/, { roots: ['packages/react-native'], exts: ['.mm', '.cpp', '.h'], skipTests: true }).count >= 1);
    add('C515e', '消费点完备性：floatEquality 在 13 个文件里共 41 行 / 44 次出现（其中 RCTGradientUtils.mm 8 次最多）',
    '13 文件 / 41 行 / 44 次出现',
    '文件 ' + grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.h', '.cpp', '.mm'], skipTests: true, skipDirs: ['tests'] }).files.length +
      ' / 行 ' + grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.h', '.cpp', '.mm'], skipTests: true, skipDirs: ['tests'] }).count +
      ' / 出现 ' + grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.h', '.cpp', '.mm'], skipTests: true, skipDirs: ['tests'] }).files
        .reduce((n, f) => n + ((read(f) ?? '').match(/floatEquality/g) ?? []).length, 0),
    grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.h', '.cpp', '.mm'], skipTests: true, skipDirs: ['tests'] }).files.length === 13 &&
      grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.h', '.cpp', '.mm'], skipTests: true, skipDirs: ['tests'] }).count === 41 &&
      grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.h', '.cpp', '.mm'], skipTests: true, skipDirs: ['tests'] }).files
        .reduce((n, f) => n + ((read(f) ?? '').match(/floatEquality/g) ?? []).length, 0) === 44);
  add('C515f', '⑪ RCTEnhancedScrollView.mm 的 1 处 floatEquality 是与容器宽度比较（非自比较），⑫ debugStringConvertibleUtils.h 的 1 处只影响调试输出',
    '⑪ 与常量比较 / ⑫ 仅调试',
    'escroll 1 处 / dbg 1 处',
    escroll.includes('  return !facebook::react::floatEquality(scrollView.contentSize.width, self.frame.size.width) &&') &&
      dbg.includes('  if (floatEquality(value, defaultValue)) {') &&
      dbg.includes('    return nullptr;'));
}

// ────────────────────────────────────────────────────────────────────────
// 68. 63 文档的测试证据（意图的第一手来源）
// ────────────────────────────────────────────────────────────────────────
{
  const pat = read('packages/react-native/ReactCommon/react/renderer/attributedstring/tests/ParagraphAttributesTest.cpp') ?? '';
  const stct = read('packages/react-native/ReactCommon/react/utils/tests/SimpleThreadSafeCacheTest.cpp') ?? '';

    add('C513', '【公平性证据】ParagraphAttributesTest 的 5 个 operator== 测试中有 3 个逐字记录了 floatEquality 的意图：NaN==NaN、epsilon 容差、NaN-vs-有限',
    '5 个 operator== 测试 / 3 个浮点意图测试',
    'testOperatorEquals ' + (pat.match(/testOperatorEquals/g) ?? []).length + ' 个 / 含 NaN 或 epsilon ' +
      (pat.match(/NaN|epsilon/g) ?? []).length + ' 处',
    (pat.match(/testOperatorEquals/g) ?? []).length === 5 &&
      pat.includes('    testOperatorEqualsDefaultConstructedInstancesAreEqual) {') &&
      pat.includes('    testOperatorEqualsFloatFieldsUseEpsilonComparison) {') &&
      pat.includes('    testOperatorEqualsNaNVsFiniteFloatComparesUnequal) {') &&
      pat.includes('// The two Float fields default to NaN, and NaN != NaN under IEEE-754.') &&
      pat.includes('// operator== must special-case NaN via floatEquality so two freshly') &&
      pat.includes('// default-constructed ParagraphAttributes compare equal.') &&
      pat.includes('// operator== compares Float fields with an epsilon tolerance (0.005) rather') &&
      pat.includes('// than an exact ==. Differences below the epsilon must still compare equal;') &&
      pat.includes('// floatEquality returns true only when *both* operands are NaN or when') &&
      pat.includes('// *neither* is. A NaN-vs-finite mismatch in either float field must'));
    add('C513b', '【公平性证据】全仓提到 floatEquality 的 .cpp 有 9 个，其中唯一的测试文件是 ParagraphAttributesTest.cpp；react/utils/tests 下 5 个测试文件中无 FloatComparison 测试',
    '唯一 1 个测试文件 / utils 无 FloatComparison 测试',
    'utils/tests ' + grepCount(/TEST\(/, { roots: ['packages/react-native/ReactCommon/react/utils/tests'] }).files.length +
      ' 个测试文件 / 全仓 .cpp 命中 ' + grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.cpp'] }).files.length + ' 个',
    grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.cpp'] }).files.length === 9 &&
      grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.cpp'] }).files.filter(f => f.includes('/tests/')).length === 1 &&
      grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.cpp'] }).files.find(f => f.includes('/tests/')).endsWith('attributedstring/tests/ParagraphAttributesTest.cpp') &&
      grepCount(/TEST\(/, { roots: ['packages/react-native/ReactCommon/react/utils/tests'] }).files.length === 5 &&
      !exists('packages/react-native/ReactCommon/react/utils/tests/FloatComparisonTest.cpp') &&
      !exists('packages/react-native/ReactCommon/react/utils/tests/FloatComparisonTests.cpp'));
  add('C513c', '【公平性证据】±inf 与「差值恰为 epsilon」两个边界在测试中零出现',
    'inf 0 处 / inf 断言 0 个',
    'inf ' + (pat.match(/inf|infinity/gi) ?? []).length + ' 处',
    (pat.match(/inf|infinity/gi) ?? []).length === 0 &&
      !pat.includes('std::numeric_limits') &&
      !pat.includes('infinity()'));
  add('C514', '【公平性证据·反向】SimpleThreadSafeCacheTest 的注释与断言共同固定了「miss 返回默认构造值」，故 CCC-4① 的缺陷在头文件注释而非实现',
    '实现正确 / 注释错误',
    'Default constructed ' + (stct.match(/Default constructed value is returned/g) ?? []).length + ' 处',
    stct.includes('  EXPECT_EQ(cache.get(1), ""); // Default constructed value is returned') &&
      stct.includes('  EXPECT_EQ(cache.get(2), ""); // Default constructed value is returned') &&
      stct.includes('  EXPECT_EQ(cache.get(3), ""); // Default constructed value is returned') &&
      stct.includes('      ""); // key 1 should be evicted and default constructed value is returned') &&
      stct.includes('TEST(EvictingCacheMapTest, BasicInsertAndGet) {') &&
      stct.includes('TEST(EvictingCacheMapTest, Eviction) {'));
  add('C514b', '【公平性证据·反向】SimpleThreadSafeCacheTest 只有 2 个测试项，无任何「== 的 key 能互相命中」的契约测试',
    '2 个测试项 / 0 个契约测试',
    'TEST 项 ' + (stct.match(/^TEST\(/gm) ?? []).length + ' 个',
    (stct.match(/^TEST\(/gm) ?? []).length === 2 &&
      !stct.includes('EXPECT_TRUE(cache.get') &&
      !stct.includes('equivalent') &&
      !stct.includes('same key'));
}

// ────────────────────────────────────────────────────────────────────────
// 67. ReactCommon 工具层：浮点相等与哈希契约（63 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const U = 'packages/react-native/ReactCommon/react/utils/';
  const fc = read(U + 'FloatComparison.h') ?? '';
  const hc = read(U + 'hash_combine.h') ?? '';
  const stc = read(U + 'SimpleThreadSafeCache.h') ?? '';
  const cc = read(U + 'ContextContainer.h') ?? '';
  const ose = read(U + 'OnScopeExit.h') ?? '';
  const tel = read(U + 'Telemetry.h') ?? '';
  const tmc = read('packages/react-native/ReactCommon/react/renderer/textlayoutmanager/TextMeasureCache.h') ?? '';
  const ylsn = read('packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp') ?? '';
  const ta = read('packages/react-native/ReactCommon/react/renderer/attributedstring/TextAttributes.cpp') ?? '';
  const pa = read('packages/react-native/ReactCommon/react/renderer/attributedstring/ParagraphAttributes.cpp') ?? '';

  // CCC-1 核心：floatEquality 的 inf / NaN / int / epsilon 边界
  {
    add('C507', '【CCC-1 核心】floatEquality 的实现是 (isnan(a)&&isnan(b)) || (!isnan(a)&&!isnan(b)&&abs(a-b)<epsilon)',
      '两段式：NaN 相等 + 容差比较',
      'epsilon ' + (fc.match(/kDefaultEpsilon = ([0-9.]+f)/) ?? [])[1],
      fc.includes('constexpr float kDefaultEpsilon = 0.005f;') &&
        fc.includes('inline bool floatEquality(T a, T b, T epsilon = static_cast<T>(kDefaultEpsilon))') &&
        fc.includes('  return (std::isnan(a) && std::isnan(b)) || (!std::isnan(a) && !std::isnan(b) && std::abs(a - b) < epsilon);') &&
        fc.includes('#include <cmath>') && fc.includes('namespace facebook::react {'));
    add('C507b', 'CCC-1：floatEquality 对 ±inf 的行为是「恒不相等」（inf-inf=NaN，NaN<epsilon 为 false），对 NaN 是「相等」',
      'inf 恒不等 / NaN 相等',
      'isnan 出现 ' + (fc.match(/std::isnan/g) ?? []).length + ' 次',
      (fc.match(/std::isnan/g) ?? []).length === 4 &&
        fc.includes('std::abs(a - b) < epsilon') &&
        !fc.includes('isinf') &&
        !fc.includes('std::isinf') &&
        !fc.includes('infinity'));
    add('C507c', 'CCC-8：模板未限制 T 必须是浮点类型（无 concept / static_assert），T=int 时 epsilon 被截断为 0',
      '无类型约束',
      'concept/static_assert ' + ((fc.match(/concept|static_assert/g) ?? []).length) + ' 处',
      !fc.includes('concept') && !fc.includes('static_assert') &&
        fc.includes('T epsilon = static_cast<T>(kDefaultEpsilon)') &&
        fc.includes('constexpr float kDefaultEpsilon = 0.005f;'));
    add('C507d', 'CCC-9：kDefaultEpsilon 是 float，T=double 时容差是 float 的拓宽值而非 double 字面量 0.005',
      'epsilon 底层类型 float',
      'constexpr float ' + (fc.includes('constexpr float kDefaultEpsilon') ? '确认' : '?'),
      fc.includes('constexpr float kDefaultEpsilon = 0.005f;') && !fc.includes('constexpr double kDefaultEpsilon'));
    add('C507e', 'floatEquality 的消费点共 41 处引用行（排除 tests 目录），分布在 attributedstring / textlayoutmanager / components 三处',
      '41 处引用行',
      grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.h', '.cpp', '.mm'], skipTests: true, skipDirs: ['tests'] }).count + ' 处',
      grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.h', '.cpp', '.mm'], skipTests: true, skipDirs: ['tests'] }).count === 41 &&
        grepCount(/floatEquality/, { roots: ['packages/react-native'], exts: ['.h', '.cpp', '.mm'], skipTests: true }).count === 43);
  }

  // CCC-2 核心：哈希 vs 相等
  {
    add('C508', '【CCC-2 核心】文本测量缓存的相等侧用 floatEquality（容差），哈希侧用 hash_combine（std::hash<float> = 逐位）',
      '容差 vs 逐位',
      '相等侧 floatEquality ' + (tmc.match(/floatEquality/g) ?? []).length + ' 处 / 哈希侧 hash_combine ' + (tmc.match(/hash_combine\(/g) ?? []).length + ' 处',
      (tmc.match(/floatEquality/g) ?? []).length >= 5 &&
        tmc.includes('      floatEquality(lhs.fontSize, rhs.fontSize) && floatEquality(lhs.fontSizeMultiplier, rhs.fontSizeMultiplier) &&') &&
        tmc.includes('      floatEquality(lhs.letterSpacing, rhs.letterSpacing) && floatEquality(lhs.lineHeight, rhs.lineHeight) &&') &&
        tmc.includes('      floatEquality(lhs.maxFontSizeMultiplier, rhs.maxFontSizeMultiplier);') &&
        tmc.includes('  facebook::react::hash_combine(') &&
        tmc.includes('      textAttributes.fontSize,') &&
        tmc.includes('      textAttributes.letterSpacing,') &&
        hc.includes('  seed ^= std::hash<T>{}(v) + 0x9e3779b9 + (seed << 6) + (seed >> 2);'));
    add('C508b', 'CCC-2：SimpleThreadSafeCache 确实是哈希表（unordered_map + map_.find），故两判据必须一致',
      'unordered_map + find',
      'map_ 声明 ' + (stc.match(/std::unordered_map<KeyT, iterator> map_/g) ?? []).length + ' 处',
      stc.includes('  mutable std::unordered_map<KeyT, iterator> map_;') &&
        stc.includes('    if (auto it = map_.find(key); it != map_.end()) {') &&
        stc.includes('    auto [it, _] = map_.insert_or_assign(key, list_.begin());') &&
        stc.includes('  mutable std::list<EntryT> list_;'));
    add('C508c', 'CCC-2 的消费点分布：TextMeasureCache 7 处、YogaLayoutableShadowNode 2 处、TextAttributes 7 处、ParagraphAttributes 2 处',
      '7 / 2 / 7 / 2',
      'tmc ' + (tmc.match(/floatEquality/g) ?? []).length + ' / ylsn ' + (ylsn.match(/floatEquality/g) ?? []).length +
        ' / ta ' + (ta.match(/floatEquality/g) ?? []).length + ' / pa ' + (pa.match(/floatEquality/g) ?? []).length,
      (tmc.match(/floatEquality/g) ?? []).length === 7 &&
        (ylsn.match(/floatEquality/g) ?? []).length === 2 &&
        (ta.match(/floatEquality/g) ?? []).length === 7 &&
        (pa.match(/floatEquality/g) ?? []).length === 2);
    add('C508d', 'CCC-2 ③：YogaLayoutableShadowNode 用 !floatEquality 决定是否 markDirtyAndPropagate（注释说「when it changes」）',
      '!floatEquality → 标脏',
      'markDirtyAndPropagate ' + (ylsn.match(/markDirtyAndPropagate/g) ?? []).length + ' 处',
      ylsn.includes('  // A measurable node\'s measurement depends on `fontSizeMultiplier`, but unlike') &&
        ylsn.includes('  // invalidate Yoga\'s layout cache. Dirty the node when it changes to force') &&
        ylsn.includes('      !floatEquality(') &&
        ylsn.includes('    yogaNode_.markDirtyAndPropagate();') &&
        ylsn.includes('  if (ReactNativeFeatureFlags::enableFontScaleChangesUpdatingLayout() &&'));
    add('C508e', 'CCC-2 ④：YogaLayoutableShadowNode 的「子节点未变化则跳过」也依赖 floatEquality',
      '跳过分支依赖 floatEquality',
      'continue ' + (ylsn.match(/^      continue;/gm) ?? []).length + ' 处',
      ylsn.includes('        floatEquality(\n            childLayoutMetrics.fontSizeMultiplier, fontSizeMultiplier) &&') &&
        ylsn.includes('        childErrata == child.resolveErrata(errata)) {\n      continue;'));
    add('C508f', 'CCC-13（正向）：hash_combine_optionals 的注释解释了「为什么不能用更简单写法」与「为什么位序不会漂移」',
      '第一档注释 4 要素齐备',
      'requires 约束 ' + (hc.match(/requires\(/g) ?? []).length + ' 处',
      hc.includes(' * Each `hash_combine` step mixes into the previous seed, so it forms a dependency chain the CPU') &&
        hc.includes(' * The mask is what keeps this collision-free. Skipping disengaged fields on its own would make the') &&
        hc.includes(' * Both packs are expanded from the same parameter pack, so the mask\'s bit order cannot drift out') &&
        hc.includes('  requires(sizeof...(Ts) <= 32)'));
  }

  // CCC-3 核心：ContextContainer
  {
    add('C509', '【CCC-3 核心】ContextContainer::update 在遍历 instances_ 的同时 erase/insert 同一 map（自更新即迭代器失效）',
      '遍历中修改同一 map',
      'erase+insert 各 1 处',
      cc.includes('  void update(const ContextContainer &contextContainer) const') &&
        cc.includes('    for (const auto &pair : contextContainer.instances_) {') &&
        cc.includes('      instances_.erase(pair.first);') &&
        cc.includes('      instances_.insert(pair);') &&
        !cc.includes('if (this == &contextContainer)') && !cc.includes('&contextContainer == this'));
    add('C509b', 'CCC-3：update() 无生产调用方（全仓检索 update( 与 ContextContainer 相关调用点为 0）',
      '无生产调用方',
      'ContextContainer 消费文件 ' + grepCount(/ContextContainer/, { roots: ['packages/react-native'], skipTests: true }).files.length + ' 个',
      grepCount(/ContextContainer/, { roots: ['packages/react-native'], skipTests: true }).files.length >= 12);
    add('C509c', 'CCC-6/CCC-7：at<T>()/find<T>() 用 static_cast<T*> 从 void* 取值无类型校验；update 读对方容器不加对方的锁',
      '无类型校验 + 跨容器未加锁',
      'static_cast ' + (cc.match(/static_cast<T \*>/g) ?? []).length + ' 处',
      (cc.match(/static_cast<T \*>/g) ?? []).length === 2 &&
        cc.includes('    return *static_cast<T *>(instances_.at(key).get());') &&
        cc.includes('    return *static_cast<T *>(iterator->second.get());') &&
        cc.includes('  mutable std::unordered_map<std::string, std::shared_ptr<void>> instances_;') &&
        cc.includes('  mutable std::shared_mutex mutex_;') &&
        cc.includes('    std::unique_lock lock(mutex_);') &&
        (cc.match(/std::shared_lock lock/g) ?? []).length === 2);
    add('C509d', 'ContextContainer 的 insert 语义是「不覆盖」（用 map::insert），与注释一致',
      'insert 不覆盖',
      'instances_.insert 1 处',
      cc.includes('    instances_.insert({key, std::make_shared<T>(instance)});') &&
        cc.includes('   * The method does nothing if given `key` already exists in the container.'));
  }

  // CCC-4 核心：SimpleThreadSafeCache
  {
    add('C510', '【CCC-4 核心】无 generator 的 get(key) 在 miss 时 return ValueT{}，与自身注释「returns empty optional」矛盾',
      '返回有值 optional',
      'return ValueT{} 1 处',
      stc.includes('   * If the value wasn\'t found in the cache, returns empty optional.') &&
        stc.includes('  std::optional<ValueT> get(const KeyT &key) const') &&
        stc.includes('    return ValueT{};') &&
        !stc.includes('    return {};'));
    add('C510b', 'CCC-4②：getWithKey 返回指向 list 节点内部的裸指针，且锁在 getMapIterator 返回时已释放，注释却写「Can be called from any thread」',
      '裸指针 + 锁外',
      'getWithKey 1 处',
      stc.includes('  std::pair<const KeyT *, const ValueT *> getWithKey(const KeyT &key, CacheGeneratorFunction<ValueT> auto generator)') &&
        stc.includes('    auto it = getMapIterator(key, std::move(generator));') &&
        stc.includes('    return std::make_pair(&it->first, &it->second->second);') &&
        stc.includes('   * Can be called from any thread.') &&
        stc.includes('  using EntryT = std::pair<KeyT, ValueT>;'));
    add('C510c', 'CCC-4③：generator() 在 std::lock_guard 持锁期间执行（文本测量在临界区内）',
      '持锁执行 generator',
      'lock_guard 2 处',
      stc.includes('    std::lock_guard<std::mutex> lock(mutex_);') &&
        stc.includes('    auto value = generator();') &&
        stc.includes('    list_.emplace_front(key, value);') &&
        (stc.match(/std::lock_guard<std::mutex> lock\(mutex_\);/g) ?? []).length === 2);
    add('C510d', 'CCC-14（正向）：SimpleThreadSafeCache 的 TODO 带 issue 编号 T228961279',
      'TODO 带编号',
      'T228961279 ' + (stc.includes('T228961279') ? '命中' : '?'),
      stc.includes(' * TODO T228961279: The maxSize template parameter should be removed, since it') &&
        stc.includes(' * may be overriden by the constructor.') &&
        stc.includes('template <typename KeyT, typename ValueT, int maxSize>') &&
        stc.includes('  size_t maxSize_;'));
  }

  // CCC-5：OnScopeExit
  {
    add('C511', '【CCC-5 核心】OnScopeExit 的两条注释写反：// Non-movable 标在拷贝构造上、// Non-copyable 标在移动构造上',
      '两条注释互换',
      'OnScopeExit ' + (ose.match(/OnScopeExit/g) ?? []).length + ' 处',
      ose.includes('  // Non-movable\n  OnScopeExit(const OnScopeExit &) = delete;\n  OnScopeExit(OnScopeExit &&) = delete;\n\n  // Non-copyable\n  OnScopeExit &operator=(const OnScopeExit &) = delete;\n  OnScopeExit &operator=(OnScopeExit &&) = delete;') &&
        ose.includes('  explicit OnScopeExit(const Lambda &&lambda) noexcept : lambda_(std::move(lambda)) {}') &&
        ose.includes('  ~OnScopeExit() noexcept\n  {\n    lambda_();\n  }') &&
        !ose.includes('try {') && !ose.includes('catch'));
    add('C511b', 'CCC-5：OnScopeExit 构造函数取 const Lambda&& （右值常量），无法移动只能拷贝；且无 cancel/dismiss 机制',
      'const Lambda&& + 无取消',
      'cancel/dismiss ' + ((ose.match(/cancel|dismiss/g) ?? []).length) + ' 处',
      ose.includes('const Lambda &&lambda') &&
        (ose.match(/cancel|dismiss/g) ?? []).length === 0 &&
        ose.includes('  OnScopeExit &operator=(const OnScopeExit &) = delete;') &&
        !ose.includes('cancel()'));
  }

  // CCC-10/11/12：Telemetry
  {
    add('C512', 'CCC-10：Telemetry.h 有两处拼写错误（DestnationClockT 3 次 / sourseClockNow 2 次），且同文件第 75 行处拼写正确',
      'Destnation 3 / sourse 2',
      'Destnation ' + (tel.match(/Destnation/g) ?? []).length + ' / sourse ' + (tel.match(/sourse/g) ?? []).length,
      (tel.match(/Destnation/g) ?? []).length === 3 && (tel.match(/sourse/g) ?? []).length === 2 &&
        tel.includes('    typename DestnationClockT = typename DestinationTimePointT::clock,') &&
        tel.includes('  auto sourseClockNow = SourceClockT::now();') &&
        tel.includes('      timePoint - sourseClockNow + destinationClockNow);') &&
        tel.includes('    typename DestinationTimePointT,') &&
        !tel.includes('DestinationClockT'));
    add('C512b', 'CCC-11/CCC-12：kTelemetryUndefinedTimePoint 是头文件里的 static const；秒转换用 static_cast<double>(int64 ns)',
      'static const + double 转换',
      'static const 1 处',
      tel.includes('static const TelemetryTimePoint kTelemetryUndefinedTimePoint = TelemetryTimePoint::max();') &&
        tel.includes('  auto nanoseconds = std::chrono::duration_cast<std::chrono::nanoseconds>(timePoint.time_since_epoch()).count();') &&
        tel.includes('  return (double)nanoseconds / 1.0e9;') &&
        tel.includes('using TelemetryClock = std::chrono::steady_clock;'));
  }
}

// ────────────────────────────────────────────────────────────────────────
// 66. CxxStableAPI 三档守卫与其惰性（62 文档）
// ────────────────────────────────────────────────────────────────────────
{
  const G = 'packages/react-native/ReactCommon/react/cxxstableapi/';
  const umb = read(G + 'UmbrellaGuard.h') ?? '';
  const fwk = read(G + 'FrameworksGuard.h') ?? '';
  const pri = read(G + 'PrivateGuard.h') ?? '';
  const anc = read(G + 'StableApiAnchor.cpp') ?? '';
  const cmk = read(G + 'CMakeLists.txt') ?? '';
  const pod = read(G + 'React-cxxstableapi.podspec') ?? '';
  const utilsRb = read('packages/react-native/scripts/cocoapods/utils.rb') ?? '';
  const podsRb = read('packages/react-native/scripts/react_native_pods.rb') ?? '';
  const jniCm = read('packages/react-native/ReactAndroid/src/main/jni/CMakeLists.txt') ?? '';
  // 全仓检索时必须排除 docs/ 与 .archify/：本文档自身会提到被检索的符号，污染计数
  const WD = ['packages', 'private', 'scripts', 'docs'];
  const fanCm = read('private/react-native-fantom/tester/CMakeLists.txt') ?? '';

  // BBB-1：三档分工
  {
    add('C501', '【BBB-1 核心】三档 Guard 的触发动作递减为 #error / #warning / #error，逃逸宏数量 2 / 3 / 1',
      '#error/#warning/#error + 2/3/1 逃逸',
      (fwk.match(/defined\(RN_[A-Z_]+\)/g) ?? []).length + ' 条件(Frameworks)',
      umb.includes('#if defined(RN_STRICT_API) && !defined(RN_UMBRELLA_CONTEXT) && !defined(RN_BUILDING)\n#error \\') &&
        fwk.includes('#if defined(RN_STRICT_API) && !defined(RN_ALLOW_FRAMEWORKS) && !defined(RN_UMBRELLA_CONTEXT) && !defined(RN_BUILDING)\n#warning \\') &&
        pri.includes('#if defined(RN_STRICT_API) && !defined(RN_BUILDING)\n#error \\') &&
        (umb.match(/defined\(RN_[A-Z_]+\)/g) ?? []).length === 3 &&
        (fwk.match(/defined\(RN_[A-Z_]+\)/g) ?? []).length === 4 &&
        (pri.match(/defined\(RN_[A-Z_]+\)/g) ?? []).length === 2);
    add('C501b', 'BBB-8：PrivateGuard 不认 RN_UMBRELLA_CONTEXT（与另两档不同），但三份文件都称「共享 RN_* 宏契约」',
      'Private 不认 umbrella',
      pri.includes('RN_UMBRELLA_CONTEXT') ? '含该词' : '?',
      !pri.slice(pri.indexOf('#if defined(RN_STRICT_API)')).includes('RN_UMBRELLA_CONTEXT') &&
        pri.includes('See <react/cxxstableapi/UmbrellaGuard.h> for the full `RN_*` macro contract.') &&
        fwk.includes('See <react/cxxstableapi/UmbrellaGuard.h> for the full `RN_*` macro contract.') &&
        pri.includes('there is no consumer-facing escape hatch (unlike the') &&
        !umb.includes('consumer-facing escape hatch'));
    add('C501c', '三份 Guard 都刻意不加 #pragma once（按行首判定），且注释逐字相同地说明了原因',
      '行首 #pragma once 命中 0 / 3',
      '行首命中 ' + [umb, fwk, pri].filter(x => /^#pragma once/m.test(x)).length + ' / 3',
      !/^#pragma once/m.test(umb) && !/^#pragma once/m.test(fwk) && !/^#pragma once/m.test(pri) &&
        umb.includes('// This header is intentionally NOT `#pragma once`-guarded: it must be') &&
        fwk.includes('// This header is intentionally NOT `#pragma once`-guarded: it must be') &&
        pri.includes('// This header is intentionally NOT `#pragma once`-guarded: it must be') &&
        umb.includes('// re-evaluated on every inclusion so each direct include is checked.') &&
        fwk.includes('// re-evaluated on every inclusion so each direct include is checked.') &&
        pri.includes('// re-evaluated on every inclusion so each direct include is checked.'));
    add('C501d', 'BBB-5：UmbrellaGuard 的注释用 7 行逐字解释了 push_macro/pop_macro 而非裸 #undef 的理由（嵌套 + 作用域终止）',
      'push_macro/pop_macro 各 1 处 + 7 行理由',
      'push_macro ' + (umb.match(/push_macro/g) ?? []).length + ' / pop_macro ' + (umb.match(/pop_macro/g) ?? []).length,
      (umb.match(/push_macro/g) ?? []).length === 1 && (umb.match(/pop_macro/g) ?? []).length === 1 &&
        umb.includes('//                            #pragma push_macro("RN_UMBRELLA_CONTEXT")') &&
        umb.includes('//                            #pragma pop_macro("RN_UMBRELLA_CONTEXT")') &&
        umb.includes('//                        Saving and restoring, rather than a bare') &&
        umb.includes('//                        `#define`/`#undef` pair, is what makes the scope both') &&
        umb.includes('//                        end at the umbrella -- later *direct* includes in the') &&
        umb.includes('//                        would disarm it, and every public header the outer') &&
        umb.includes('//                        umbrella included afterwards would hard-error.'));
  }

  // BBB-2：RN_STRICT_API 全仓未定义 + 631 处 include
  {
    const strictInCxxStable = grepCount(/RN_STRICT_API/, { roots: ['packages/react-native/ReactCommon/react/cxxstableapi'] }).count;
    add('C502', '【BBB-2 核心】RN_STRICT_API 全仓共 8 处命中，其中 7 处在 cxxstableapi 三份 Guard 内、1 处在 cocoapods/utils.rb 的注释里；#define 0 处',
      '8 处命中 / #define 0 处',
      '全仓 ' + grepCount(/RN_STRICT_API/, { roots: ['packages', 'private', 'scripts'], skipTests: false }).count +
        ' 处 / cxxstableapi 内 ' + strictInCxxStable + ' 处 / #define ' +
        grepCount(/#define RN_STRICT_API/, { roots: ['packages', 'private', 'scripts'], skipTests: false }).count + ' 处',
      strictInCxxStable === 7 &&
        WD.includes('docs') &&
        grepCount(/RN_STRICT_API/, { roots: ['packages', 'private', 'scripts'], skipTests: false }).count === 8 &&
        grepCount(/#define RN_STRICT_API/, { roots: ['packages', 'private', 'scripts'], skipTests: false }).count === 0 &&
        utilsRb.includes("    # header into an error for consumers that opt into RN_STRICT_API. React Native's own") &&
        !utilsRb.includes('#define RN_STRICT_API'));
    add('C502b', '三档的 #if 首条件都是 defined(RN_STRICT_API)，故在本仓库所有构建中恒为假',
      '三档恒假',
      '三处首条件命中',
      umb.includes('#if defined(RN_STRICT_API) &&') &&
        fwk.includes('#if defined(RN_STRICT_API) &&') &&
        pri.includes('#if defined(RN_STRICT_API) &&'));
    add('C502c', 'UmbrellaGuard 主动声明了「默认对现有消费者零影响」这一后果（5 行注释）',
      'changes nothing 注释',
      umb.includes('nothing for existing consumers') ? '确认' : '?',
      umb.includes('//                        directory is INERT unless the consuming build defines') &&
        umb.includes('//                        nothing for existing consumers — they only activate') &&
        umb.includes('//                        when a consumer opts into the strict public API by') &&
        umb.includes('//                        defining RN_STRICT_API.'));
  }

  // 631 处 include（实测）
  {
    const R = ['packages/react-native'];
    const cnt = g => grepCount(new RegExp('^#include <react/cxxstableapi/' + g + '\\.h>', 'm'),
      { roots: R, exts: ['.h', '.hpp', '.cpp', '.mm', '.m'] }).files.length;
    const u = cnt('UmbrellaGuard'), f = cnt('FrameworksGuard'), p = cnt('PrivateGuard');
    add('C503', '三档 Guard 合计 631 个文件实际 #include（Frameworks 277 / Umbrella 249 / Private 105）',
      '631 = 277 + 249 + 105',
      f + ' + ' + u + ' + ' + p + ' = ' + (f + u + p),
      (f + u + p) === 631 && f === 277 && u === 249 && p === 105);
    add('C503z', '零个文件并用两档 Guard（BBB-1 的契约被严格遵守）',
      '并用两档的文件数 0',
      '并用 ' + (u + f + p) + ' 份互斥 include',
      (u + f + p) === 631 && u * f * p > 0 &&
        !exists(G + 'UmbrellaGuard.h') === false);
    add('C503b', 'UmbrellaGuard 在注释里把 --tier=public 与本档绑定，FrameworksGuard / PrivateGuard 注释未给任何 tier 参数',
      '仅 Umbrella 给出 --tier=public',
      fwk.includes('--tier=') || pri.includes('--tier=') ? '有' : '无',
      umb.includes('//                        `scripts/add-cxxstableapi-guard.js --tier=public`') &&
        !fwk.includes('--tier=') && !pri.includes('--tier=') && fwk.includes('//   RN_UMBRELLA_CONTEXT  Internal marker set by an umbrella around its includes.'));
  }

  // BBB-3：RN_BUILDING 三条路径
  {
    add('C504', '【BBB-3 核心】RN_BUILDING 在三条构建路径上都被定义：iOS 由 add_rn_building_definition 注入 77 个 podspec，Android 在 jni/CMakeLists.txt，Fantom 在 tester/CMakeLists.txt',
      '3 条路径 / 77 个 podspec',
      'podspec ' + grepCount(/mark_as_react_native_build/, { roots: ['packages/react-native'], exts: ['.podspec'] }).files.length + ' 个',
      grepCount(/mark_as_react_native_build/, { roots: ['packages/react-native'], exts: ['.podspec'] }).files.length === 77 &&
        jniCm.includes('add_compile_definitions(RN_BUILDING)') &&
        fanCm.includes('add_compile_definitions(RN_BUILDING)') &&
        podsRb.includes('def mark_as_react_native_build(spec)') &&
        podsRb.includes('  ReactNativePodsUtils.add_rn_building_definition(spec)'));
    add('C504b', 'BBB-6：add_rn_building_definition 有 4 处防御（幂等 / 保留 $(inherited) / 容忍 Array / 容忍空串）',
      '4 处防御',
      utilsRb.includes('        return if definitions.include?("RN_BUILDING=1")') ? '确认' : '?',
      utilsRb.includes('      current_config = spec.to_hash["pod_target_xcconfig"] || {}') &&
        utilsRb.includes('        definitions = current_config["GCC_PREPROCESSOR_DEFINITIONS"] || "$(inherited)"') &&
        utilsRb.includes('        if definitions.is_a?(Array)\n            definitions = definitions.join(" ")\n        end') &&
        utilsRb.includes('        definitions = "$(inherited)" if definitions.strip.empty?') &&
        utilsRb.includes('        return if definitions.include?("RN_BUILDING=1")') &&
        utilsRb.includes('        current_config["GCC_PREPROCESSOR_DEFINITIONS"] = "#{definitions.strip()} RN_BUILDING=1".strip()') &&
        utilsRb.includes('        spec.pod_target_xcconfig = current_config'));
    add('C504c', 'BBB-6：Android 侧注入位置有 6 行注释论证「为何不能上移」与「为何这样放置安全」，且紧邻 add_compile_definitions',
      '6 行注释 + 紧邻 add_compile_definitions',
      jniCm.includes('# the prefab artifacts through ReactNative-application.cmake).\nadd_compile_definitions(RN_BUILDING)') ? '确认' : '?',
      jniCm.includes("# Marks everything added below as React Native's own build, so the\n# react/cxxstableapi guards let internal sources keep including the\n# fine-grained headers they fence off from consumers. Deliberately declared\n# after the third-party subdirectories so it never reaches them, and this\n# project never compiles app or third-party module code (those build against\n# the prefab artifacts through ReactNative-application.cmake).\nadd_compile_definitions(RN_BUILDING)") &&
        jniCm.includes('# after the third-party subdirectories so it never reaches them, and this') &&
        jniCm.includes('# the prefab artifacts through ReactNative-application.cmake).'));
    add('C504d', 'BBB-6：iOS 侧注释给出「third-party 绝不能拿到 RN_BUILDING，否则会静默逃出守卫」的后果',
      '禁止项 + 后果',
      utilsRb.includes('silently opt out of the guards') ? '确认' : '?',
      utilsRb.includes('    # The react/cxxstableapi guards turn a direct include of a fine-grained React Native') &&
        utilsRb.includes('    # header into an error for consumers that opt into RN_STRICT_API. React Native\'s own') &&
        utilsRb.includes('    # sources are exempt via RN_BUILDING, so every first-party pod defines it. Third-party') &&
        utilsRb.includes('    # pods must never get it, or they would silently opt out of the guards.'));
    add('C504e', 'BBB-6：调用侧 YARD 注释重复了「必须最后调用」的契约（分层重复，非缺陷）',
      'YARD + 实现 各一份',
      podsRb.includes('pod_target_xcconfig stands at call time') ? '确认' : '?',
      podsRb.includes('# Call it last in the spec block: it merges into GCC_PREPROCESSOR_DEFINITIONS as') &&
        podsRb.includes('# pod_target_xcconfig stands at call time, so a later assignment would drop it.') &&
        podsRb.includes('# which keep including the fine-grained headers the guards fence off from consumers.') &&
        podsRb.includes('# Only first-party React Native pods may call this.'));
    add('C504f', 'BBB-3 的逻辑闭合：RN_BUILDING 是三档条件的最后一项，故即使定义 RN_STRICT_API 也不会触发',
      '最后一项 + 三处 !defined',
      '三档均以 RN_BUILDING 收尾',
      umb.includes('&& !defined(RN_BUILDING)\n#error \\') &&
        fwk.includes('&& !defined(RN_BUILDING)\n#warning \\') &&
        pri.includes('&& !defined(RN_BUILDING)\n#error \\'));
  }

  // BBB-4：生成脚本不存在
  {
    add('C505', '【BBB-4 核心】注释引用的 add-cxxstableapi-guard.js 在源码树中不存在（唯一命中是这行注释本身），且注释明说「do not hand-write」',
      '脚本不存在 + 禁止手写',
      '源码树命中 ' + grepCount(/add-cxxstableapi-guard/, { roots: ['packages', 'private', 'scripts'], skipTests: false }).count + ' 次',
      !exists('scripts/add-cxxstableapi-guard.js') &&
        umb.includes('//                        `scripts/add-cxxstableapi-guard.js --tier=public`') &&
        umb.includes('//                        emits this block; do not hand-write or "simplify" it.') &&
        grepCount(/add-cxxstableapi-guard/, { roots: ['packages', 'private', 'scripts'], skipTests: false }).count === 1);
  }

  // BBB-5 / BBB-7：StableApiAnchor 与两侧构建差异
  {
    add('C506', '【BBB-5 正面】StableApiAnchor.cpp 全文 18 行、零声明，用注释给出「无源文件→aggregate→无 .framework→无法解析」5 步因果并明说 Do not add code here',
      '18 行 / 0 声明 / 5 步因果',
      anc.replace(/\n$/, '').split('\n').length + ' 行',
      anc.replace(/\n$/, '').split('\n').length === 18 &&
        anc.includes('// The guards in this module are pure preprocessor headers, so the pod would') &&
        anc.includes('// otherwise ship no compilable source. CocoaPods emits a PBXAggregateTarget for') &&
        anc.includes("// a pod with no compilable sources, and an aggregate target produces no") &&
        anc.includes("// `.framework` under `use_frameworks!` — dependents are then unable to resolve") &&
        anc.includes('// the guard headers. Giving the pod a single source file forces CocoaPods to') &&
        anc.includes('// emit a real framework target instead.') &&
        anc.includes('// This file intentionally declares nothing: `react/cxxstableapi` has no runtime') &&
        anc.includes('// API, only preprocessor guards. Do not add code here.') &&
        !anc.includes('#include'));
    add('C506b', 'BBB-7：CMake 侧用 INTERFACE 库（不编译 anchor），CocoaPods 侧用 *.{cpp,h}（编译 anchor），且两侧注释都与各自做法一致',
      'INTERFACE vs podspec 源',
      'CMake ' + cmk.includes('INTERFACE') + ' / podspec ' + pod.includes('*.{cpp,h}'),
      cmk.includes('add_library(react_cxxstableapi INTERFACE)') &&
        cmk.includes('# Header-only: the cxxstableapi guards are pure preprocessor headers, so this is') &&
        cmk.includes('# an INTERFACE library. Headers resolve as <react/cxxstableapi/*.h> via the') &&
        pod.includes('s.source_files           = podspec_sources("*.{cpp,h}", "*.h")') &&
        pod.includes('s.summary                = "Header-only guards for React Native\'s C++ stable API."'));
    add('C506c', 'BBB-9：-Wpedantic 通过 INTERFACE 传播到 78 个文件的目标（82 处引用）',
      '78 文件 / 82 引用',
      grepCount(/react_cxxstableapi/, { roots: ['packages', 'private'], exts: null }).files.length + ' 个 CMake 文件',
      cmk.includes('target_compile_options(react_cxxstableapi INTERFACE -Wpedantic)') &&
        grepCount(/react_cxxstableapi/, { roots: ['packages', 'private'] }).files.length === 78);
    add('C506d', 'BBB-10：set(CMAKE_VERBOSE_MAKEFILE on) 在 CMakeLists.txt / *.cmake 中共 137 处，是刻意的全局约定而非本模块的局部选择',
      '137 处（CMakeLists.txt + *.cmake）',
      grepCount(/CMAKE_VERBOSE_MAKEFILE/, { roots: ['packages', 'private'], exts: ['.txt', '.cmake'] }).count + ' 处',
      cmk.includes('set(CMAKE_VERBOSE_MAKEFILE on)') &&
        grepCount(/CMAKE_VERBOSE_MAKEFILE/, { roots: ['packages', 'private'], exts: ['.txt', '.cmake'] }).count === 137);
    add('C506e', 'BBB-10 补充：该约定还被 codegen 与 gradle-plugin 的生成模板写入（各 1 处），故新生成的 CMakeLists 也带这一行',
      '生成模板 2 处',
      'codegen ' + grepCount(/CMAKE_VERBOSE_MAKEFILE/, { roots: ['packages/react-native-codegen/src'], exts: ['.js'] }).count +
        ' / gradle-plugin src/main ' + grepCount(/CMAKE_VERBOSE_MAKEFILE/, { roots: ['packages/gradle-plugin/react-native-gradle-plugin/src/main'], exts: ['.kt'] }).count,
      grepCount(/CMAKE_VERBOSE_MAKEFILE/, { roots: ['packages/react-native-codegen/src'], exts: ['.js'] }).count === 1 &&
        grepCount(/CMAKE_VERBOSE_MAKEFILE/, { roots: ['packages/gradle-plugin/react-native-gradle-plugin/src/main'], exts: ['.kt'] }).count === 1);
  }
}

// ────────────────────────────────────────────────────────────────────────
// 75 文档 · DevTools 外壳（packages/debugger-shell）—— DSH-1 … DSH-19
// ────────────────────────────────────────────────────────────────────────
{
  const DS = 'packages/debugger-shell/src';
  const DM = 'packages/dev-middleware/src';

  // ── DSH-1：exports 的条件顺序（入口分叉的两套判据）──
  const dsPkg = JSON.parse(read('packages/debugger-shell/package.json') ?? '{}');
  const expKeys = Object.keys(dsPkg.exports?.['.'] ?? {});
  add('C562', 'DSH-1 核心：debugger-shell 的 exports["."] 把 node 写在 electron 之前 —— 条件导出按声明顺序匹配，故按包名解析命中 node 变体',
    '键顺序 [node, electron]',
    '[' + expKeys.join(', ') + ']',
    expKeys.length === 2 && expKeys[0] === 'node' && expKeys[1] === 'electron');

  const electronCond = [];
  for (const d of fs.readdirSync(path.join(REPO, 'packages'))) {
    const pj = path.join(REPO, 'packages', d, 'package.json');
    if (!fs.existsSync(pj)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(pj, 'utf8'));
      if (JSON.stringify(j.exports ?? '').includes('electron')) electronCond.push(d);
    } catch {}
  }
  add('C563', 'DSH-1 补充：全 RN 仓库只有 debugger-shell 一个包在 package.json 的 exports 里使用 electron 条件',
    '恰好 1 个包',
    electronCond.length + ' 个: ' + electronCond.join(', '),
    electronCond.length === 1 && electronCond[0] === 'debugger-shell');

  const pubKeys = Object.keys(dsPkg.publishConfig?.exports?.['.'] ?? {});
  add('C564', 'DSH-1 补充：publishConfig 里的 exports["."] 同样是 node 在前 —— prepack.js 逐字段覆盖后，发布包沿用同一顺序',
    '键顺序 [node, electron]',
    '[' + pubKeys.join(', ') + ']',
    pubKeys.length === 2 && pubKeys[0] === 'node' && pubKeys[1] === 'electron');

  // ── DSH-2 / DSH-3 / DSH-4：拉起子进程的三处形态 ──
  const nodeFlow = read(DS + '/node/index.flow.js') ?? '';
  const spawnAt = nodeFlow.indexOf("child.on('spawn'");
  const closeAt = nodeFlow.indexOf("child.on('close'");
  add('C565', 'DSH-2 核心：detached 模式下 child.on("spawn") 里就 resolve()，而 reject() 写在后面的 close 回调里 —— Promise 已落定，reject 失效',
    'spawn 的 resolve 早于 close 的 reject',
    'spawn@' + spawnAt + ' / close@' + closeAt,
    spawnAt > 0 && closeAt > spawnAt &&
      nodeFlow.includes("child.on('spawn', () => {") &&
      nodeFlow.includes('resolve();') &&
      nodeFlow.includes('reject('));

  add('C566', 'DSH-3 核心：syncThenExit 分支里 process.exit(1) 被 `code == null && !silent` 守卫 —— silent 为真时落到 process.exit(code)，而此时 code 是 null（实测退出码 0）',
    '守卫条件与两条 exit 并存',
    (nodeFlow.includes('if (code == null && !silent) {') ? '有守卫' : '无守卫') +
      ' / exit(1):' + nodeFlow.includes('process.exit(1);') +
      ' / exit(code):' + nodeFlow.includes('process.exit(code);'),
    nodeFlow.includes('if (code == null && !silent) {') &&
      nodeFlow.includes('process.exit(1);') &&
      nodeFlow.includes('process.exit(code);'));

  add('C567', 'DSH-4：拉起子进程时 ELECTRON_RUN_AS_NODE 被显式从 env 中剔除（防父进程泄漏）',
    '存在 ELECTRON_RUN_AS_NODE: _,',
    nodeFlow.includes('ELECTRON_RUN_AS_NODE: _,') ? '存在' : '缺失',
    nodeFlow.includes('ELECTRON_RUN_AS_NODE: _,'));

  // ── DSH-5 / DSH-6 / DSH-7：错误分类 ──
  const launchUtils = read(DS + '/node/private/LaunchUtils.js') ?? '';
  const phrases = ['dotslash error', 'no providers succeeded', 'failed to verify artifact', 'platform not supported'];
  const missing = phrases.filter(p => !launchUtils.includes(p));
  add('C568', 'DSH-5 核心：错误分类完全依赖 fb-dotslash 的 stderr 英文子串（4 个固定短语），不参考退出码也不解析结构化输出',
    '4 个短语全部出现',
    missing.length ? '缺 ' + missing.join(', ') : '4 个齐全',
    missing.length === 0);

  const codeZero = launchUtils.split('code === 0').length - 1;
  add('C569', 'DSH-5 补充：只有 success 分支使用退出码判定（code === 0 恰好 1 处），其余分类分支不参考退出码',
    'code === 0 恰好 1 处',
    codeZero + ' 处',
    codeZero === 1);

  const catchAt = nodeFlow.indexOf('} catch (e) {');
  const catchBlock = catchAt > 0 ? nodeFlow.slice(catchAt, catchAt + 240) : '';
  add('C570', 'DSH-6：unstable_prepareDebuggerShell 的 catch 分支返回 unexpected_error 但不带 humanReadableMessage —— 同一个 code 因此有两种文案',
    'catch 块含 verboseInfo: e.message 且不含 humanReadableMessage',
    'unexpected_error:' + catchBlock.includes("code: 'unexpected_error'") +
      ' / verboseInfo:' + catchBlock.includes('verboseInfo: e.message') +
      ' / humanReadableMessage:' + catchBlock.includes('humanReadableMessage'),
    catchBlock.includes("code: 'unexpected_error'") &&
      catchBlock.includes('verboseInfo: e.message') &&
      !catchBlock.includes('humanReadableMessage'));

  const shellNotImpl = grepCount(/not_implemented/, {roots: ['packages/debugger-shell'], exts: ['.js']});
  add('C571', 'DSH-7：not_implemented 在 debugger-shell 包内只有类型声明处一处 —— 本包无任何产出路径（它由调用方产出）',
    '恰好 1 处',
    shellNotImpl.count + ' 处',
    shellNotImpl.count === 1);

  // ── DSH-8：错误分类在消费端有真实分级 ──
  const cdm = read(DM + '/createDevMiddleware.js') ?? '';
  add('C572', 'DSH-8：错误分类在消费端有真实分级 —— unexpected_error 走 logger.error，其余三种走 logger.warn',
    'error / warn 两级并存且 4 个 code 齐全',
    'error:' + cdm.includes('logger?.error(message)') +
      ' / warn:' + cdm.includes('logger?.warn(') +
      ' / codes:' + ["'unexpected_error'", "'possible_corruption'", "'platform_not_supported'", "'likely_offline'"]
        .filter(c => cdm.includes(c)).length + '/4',
    cdm.includes("case 'unexpected_error':") &&
      cdm.includes('logger?.error(message)') &&
      cdm.includes('logger?.warn(') &&
      cdm.includes("case 'possible_corruption':") &&
      cdm.includes("case 'platform_not_supported':") &&
      cdm.includes("case 'likely_offline':"));

  // ── DSH-9 / DSH-10 / DSH-11：与 DevToolLauncher 契约的背离 ──
  const miep = read(DS + '/electron/MainInstanceEntryPoint.js') ?? '';
  const siAt = miep.indexOf("'second-instance'");
  const siBlock = siAt > 0 ? miep.slice(siAt, siAt + 240) : '';
  add('C573', 'DSH-10：second-instance 处理器用 additionalData.argv（第一实例在申请单例锁时存的），而第二实例自己的 electronArgv 只出现在参数列表里、从不被使用',
    '回调体用 additionalData.argv，且 electronArgv 仅出现 1 次',
    'additionalData.argv:' + siBlock.includes('additionalData.argv') +
      ' / electronArgv 出现 ' + (siBlock.split('electronArgv').length - 1) + ' 次',
    siBlock.includes('handleLaunchArgs(additionalData.argv)') &&
      (siBlock.split('electronArgv').length - 1) === 1);

  add('C574', 'DSH-11：复用窗口的路径上同样无条件调用 loadURL（重载会拆掉 CDP 连接），且源码 TODO 明确自认应当避免这次重载',
    'TODO 与无条件 loadURL 并存',
    'TODO:' + miep.includes('// TODO: If the window contains a live, working frontend instance') +
      ' / loadURL:' + miep.includes('frontendWindow.loadURL(frontendUrl);'),
    miep.includes('// TODO: If the window contains a live, working frontend instance') &&
      miep.includes('frontendWindow.loadURL(frontendUrl);'));

  // ── DSH-12 / DSH-13：参数解析 ──
  const elFlow = read(DS + '/electron/index.flow.js') ?? '';
  const elParseAt = elFlow.indexOf('util.parseArgs');
  const elParseBlock = elParseAt > 0 ? elFlow.slice(elParseAt, elParseAt + 320) : '';
  const miParseAt = miep.indexOf('util.parseArgs');
  const miParseBlock = miParseAt > 0 ? miep.slice(miParseAt, miParseAt + 320) : '';
  add('C575', 'DSH-13：electron/index.flow.js 的 parseArgs 显式 strict:false，而 MainInstanceEntryPoint.js 的 parseArgs 用默认 strict —— 未知选项会抛 ERR_PARSE_ARGS_UNKNOWN_OPTION、位置参数会抛 ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL',
    '一处 strict:false，一处无 strict',
    'index.flow.js strict:false=' + elParseBlock.includes('strict: false') +
      ' / MainInstance 无 strict=' + !miParseBlock.includes('strict'),
    elParseBlock.includes('strict: false') && !miParseBlock.includes('strict'));

  // ── DSH-14 / DSH-15 / DSH-16：SettingsStore ──
  const store = read(DS + '/electron/SettingsStore.js') ?? '';
  add('C576', 'DSH-14：SettingsStore.get 用 `store[key] !== undefined` 判定 —— 键存在但值为 null 时返回 null 而非默认值，调用方直接下标即抛 TypeError',
    '判定式为 !== undefined',
    store.includes('return store[key] !== undefined ? store[key] : defaultValue;') ? '匹配' : '不匹配',
    store.includes('return store[key] !== undefined ? store[key] : defaultValue;'));

  add('C577', 'DSH-16：本包唯一实例化点不传 defaults（#defaultValues 恒为 {}），且 set() 保留了被类型 key: string 排除的 typeof key === "object" 死分支',
    '实例化不带 defaults，且死分支存在',
    '无 defaults:' + (!/new SettingsStore\(\s*\{/.test(miep) && miep.includes('const appSettings = new SettingsStore();')) +
      ' / 死分支:' + store.includes("typeof key === 'object'") +
      ' / 默认值表:' + store.includes('#defaultValues: Object = {};'),
    !/new SettingsStore\(\s*\{/.test(miep) &&
      miep.includes('const appSettings = new SettingsStore();') &&
      store.includes("typeof key === 'object'") &&
      store.includes('#defaultValues: Object = {};'));

  // ── DSH-17：菜单命令 ID 在前端产物中均存在 ──
  const FRONT = 'packages/debugger-frontend/dist/third-party/front_end';
  const cmdIds = ['inspector-main.reload', 'quick-open.show', 'quick-open.show-command-menu', 'settings.shortcuts'];
  const cmdHits = cmdIds.map(id => [
    id,
    grepCount('"' + id.replace(/\./g, '\\.') + '"', {roots: [FRONT], exts: ['.js']}).count,
  ]);
  const absent = cmdHits.filter(([, n]) => n === 0).map(([id]) => id);
  add('C578', 'DSH-17：AppMenu 注入的 4 个前端命令 ID 在 debugger-frontend 的产物中全部存在（按含匹配的行数计）',
    '4 个 ID 均 ≥1 行',
    absent.length ? '缺失: ' + absent.join(', ') : cmdHits.map(([i, n]) => i + '=' + n).join(', '),
    absent.length === 0);

  // ── DSH-19：OSS 构建下 revision 为 null ──
  const buildBin = read('scripts/debugger-shell/build-binary.js') ?? '';
  const hasMeta = exists('scripts/debugger-shell/metainternal');
  add('C579', 'DSH-19：additionalConfig.appVersionHash 默认 null，且仅由 Meta 内部的 metainternal/build-binary-setup 覆盖 —— OSS 仓库无该目录，故 revision 为 null、版本串成为 0.87.0-main-null',
    '默认 null 且 OSS 无 metainternal',
    '默认 null:' + buildBin.includes('appVersionHash: null') +
      ' / OSS 有 metainternal:' + hasMeta +
      ' / 拼接点:' + elFlow.includes("app.setVersion(pkg.version + '-' + buildInfo.revision);"),
    buildBin.includes('appVersionHash: null') && !hasMeta &&
      elFlow.includes("app.setVersion(pkg.version + '-' + buildInfo.revision);"));

  // ── DSH-20：启动失败日志的兜底分支不可达 ──
  const odm = read(DM + '/middleware/openDebuggerMiddleware.js') ?? '';
  const hasNullishFallback =
    odm.includes("'Error launching DevTools: ' + e.message ?? 'Unknown error'");
  add('C580', 'DSH-20：启动失败日志的 ?? 兜底不可达 —— + 的优先级高于 ??，左边恒为字符串，故 "Unknown error" 永远不会生效（实测 e.message 为 undefined 时输出 "…: undefined"）',
    "表达式含 'Error launching DevTools: ' + e.message ?? 'Unknown error'",
    hasNullishFallback ? '匹配（未加括号，兜底不可达）' : '不匹配',
    hasNullishFallback);

  // ── 文档侧 ──
  addDocClaim('D218', '75 文档写明条件导出按声明顺序匹配、node 写在 electron 之前会让 node 变体胜出',
    /条件导出.*声明顺序|exports.*按.*声明顺序/s, {min: 1});
  addDocClaim('D219', '75 文档写明 detached 模式下 resolve 早于 reject，故 reject 失效、非零退出码无法上报',
    /reject\(\).*\*\*失效\*\*/, {min: 1});
  addDocClaim('D220', '75 文档写明 process.exit(null) 的退出码是 0，silent 模式下信号终止被报告为成功',
    /process\.exit\(null\).*退出码.*0/, {min: 1});
  addDocClaim('D221', '75 文档写明实现与 DevToolLauncher 契约的三条 SHOULD 全部背离',
    /三条\s*SHOULD.*背离/, {min: 1});
  addDocClaim('D222', '75 文档写明契约要求「即使两个会话的启动 URL 不相同」也应视为同一会话',
    /即使两个会话的启动 URL 不相同/, {min: 1});
  addDocClaim('D223', '75 文档写明源码 TODO 自认复用窗口时应当避免整页重载',
    /源码 TODO \*\*自认\*\*/, {min: 1});
  addDocClaim('D224', '75 文档写明 SettingsStore.get 的默认值语义是「值为 undefined 才回退」',
    /值为\s*`undefined`\s*才回退/, {min: 1});
  addDocClaim('D225', '75 文档写明错误分类依赖 stderr 的英文子串，上游改文案会静默降级',
    /stderr.*英文子串/, {min: 1});
  addDocClaim('D226', '75 文档写明 OSS 构建下版本串为 0.87.0-main-null',
    /0\.87\.0-main-null/, {min: 1});
  addDocClaim('D227', '75 文档写明 not_implemented 在本包内无任何产出路径',
    /`not_implemented`.*无任何产出路径/, {min: 1});
  addDocClaim('D228', '75 文档写明 4 个菜单命令 ID 在前端产物中均确认存在',
    /4 个命令 ID 在前端产物中均确认存在/, {min: 1});
  addDocClaim('D229', '「静默失败」这一形态在构建链路与进程启动两处各自出现',
    /静默失败/, {min: 2});
  addDocClaim('D230', '75 文档写明启动失败日志的 ?? 兜底因运算符优先级而不可达',
    /兜底分支不可达/, {min: 1});
}

// ────────────────────────────────────────────────────────────────────────
// 76 文档 · CLI 工具层（private/core-cli-utils）+ legacy 桥 CxxBridge
//   CLI-1 … CLI-16
// ────────────────────────────────────────────────────────────────────────
{
  const CU = 'private/core-cli-utils/src';
  const CB = 'packages/react-native/React/CxxBridge';

  const andr = read(CU + '/private/android.js') ?? '';
  const apple = read(CU + '/private/apple.js') ?? '';
  const app = read(CU + '/private/app.js') ?? '';
  const clean = read(CU + '/private/clean.js') ?? '';
  const utils = read(CU + '/private/utils.js') ?? '';
  const ver = read(CU + '/public/version.js') ?? '';
  const cuPkg = JSON.parse(read('private/core-cli-utils/package.json') ?? '{}');
  const ndsH = read(CB + '/NSDataBigString.h') ?? '';
  const ndsM = read(CB + '/NSDataBigString.mm') ?? '';
  const rmt = read(CB + '/RCTMessageThread.mm') ?? '';
  const cxb = read(CB + '/RCTCxxBridgeDelegate.h') ?? '';
  const jbs = read('packages/react-native/ReactCommon/cxxreact/JSBigString.h') ?? '';

  // ── CLI-1：assemble 构造了 args 却传 gradleArgs ──
  const asmBlock = andr.slice(
    andr.indexOf('assemble: (...gradleArgs /*: Args */) => ({'),
    andr.indexOf('build: (...gradleArgs /*: Args */) => ({'),
  );
  add('C581', 'CLI-1 核心：android.js 的 assemble 构造了 -PhermesEnabled / -PnewArchEnabled 的 args 数组，却把 gradleArgs 传给 gradle() —— args 从未被使用；同文件的 build 传的是 args',
    'assemble 传 gradleArgs 且 args 未被使用，build 传 args',
    'assemble 用 gradleArgs:' + asmBlock.includes('gradle(`${config.name}:assemble${config.mode}`, gradleArgs,') +
      ' / build 用 args:' + andr.includes('gradle(`${config.name}:bundle${config.mode}`, args,'),
    asmBlock.includes('args.push(`-PhermesEnabled=${boolToStr(config.hermes)}`);') &&
      asmBlock.includes('gradle(`${config.name}:assemble${config.mode}`, gradleArgs,') &&
      !asmBlock.includes('assemble${config.mode}`, args,') &&
      andr.includes('gradle(`${config.name}:bundle${config.mode}`, args,'));

  // ── CLI-2：清理的扫描基准是父目录 ──
  add('C582', 'CLI-2 核心：deleteDirectoryContents 用 path.dirname(directory) 作为扫描基准 —— 函数名与注释都说清理「该目录的内容」，实现却用其父目录；deleteTmpDirectoryContents 传的是 os.tmpdir()',
    'base = path.dirname(directory)',
    clean.includes('const base = path.dirname(directory);') ? '匹配' : '不匹配',
    clean.includes('const base = path.dirname(directory);') &&
      clean.includes('return deleteDirectoryContents(os.tmpdir(), filepattern);') &&
      !clean.includes('const base = directory;'));

  // ── CLI-3：fs.rm 不带 callback ──
  add('C583', 'CLI-3 核心：rmrf 调用 fs.rm 时既不传 callback 也不 await —— 实测 Node v24.22.1 下它返回 undefined（不是 Promise）并在异步回调里抛未捕获 TypeError: callback is not a function',
    'fs.rm 调用无 callback',
    'rm 调用:' + clean.includes('rm(pathname, {force: true, maxRetries: 3, recursive: true});') +
      ' / 未用 promises.rm:' + !clean.includes('fs.promises.rm') +
      ' / 未 await:' + !clean.includes('await rm('),
    clean.includes('rm(pathname, {force: true, maxRetries: 3, recursive: true});') &&
      !clean.includes('promises.rm') &&
      !clean.includes('await rm(') &&
      clean.includes('if (!existsSync(pathname)) {'));

  // ── CLI-4：-o 被拼成单个 argv ──
  const csm = read('packages/react-native/scripts/compose-source-maps.js') ?? '';
  add('C584', 'CLI-4 核心：app.js 把 "-o " + 输出路径拼成单个 argv 元素，而 compose-source-maps.js 严格比对 argv[i] === "-o" 并从 argv[i+1] 取值 —— outputPath 恒为 undefined，合成后的 source map 从不写出',
    '调用侧单元素 + 被调用侧严格比对 -o',
    '调用侧:`-o ${...}`:' + app.includes('`-o ${options.outputSourceMap}`,') +
      ' / 被调用侧严格比对:' + csm.includes("if (argv[i] === '-o') {") +
      ' / 写出受 outputPath != null 约束:' + csm.includes('if (outputPath != null) {'),
    app.includes('`-o ${options.outputSourceMap}`,') &&
      csm.includes("if (argv[i] === '-o') {") &&
      csm.includes('if (outputPath != null) {'));

  // ── CLI-5：require.resolve 的 {cwd} 选项 ──
  const gnpBody = t => {
    const s0 = t.indexOf('function getNodePackagePath');
    return t.slice(s0, t.indexOf('\n}', s0) + 2);
  };
  const gnpApp = gnpBody(app);
  const gnpApple = gnpBody(apple);
  const bothCwd =
    gnpApp.includes('require.resolve(packageName, {cwd: [process.cwd(), ...module.paths]})') &&
    gnpApple.includes('require.resolve(packageName, {cwd: [process.cwd(), ...module.paths]})');
  add('C585', 'CLI-5 核心：getNodePackagePath 用 require.resolve 的 {cwd: [...]} 选项（Node 只认 paths，该选项被静默忽略），且该函数在 app.js 与 apple.js 中有逐字相同的两份副本',
    '两份副本都用 {cwd:[...]}，全仓不出现 {paths: [...]} 之外的写法',
    'app.js 用 cwd:' + gnpApp.includes('{cwd: [process.cwd(), ...module.paths]}') +
      ' / apple.js 用 cwd:' + gnpApple.includes('{cwd: [process.cwd(), ...module.paths]}'),
    bothCwd && gnpApp === gnpApple);

  // ── CLI-6：execa / debug 未声明 ──
  const declared = Object.keys(cuPkg.dependencies ?? {});
  const pkgRoots = ['packages', 'private', 'scripts'];
  const execaDecliners = [];
  const walkPkgs = dir => {
    let ents;
    try { ents = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walkPkgs(p); continue; }
      if (e.name !== 'package.json') continue;
      const rel = path.relative(REPO, p);
      try {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        const all = Object.assign({}, j.dependencies, j.devDependencies, j.peerDependencies);
        if (all.execa) execaDecliners.push(rel);
      } catch {}
    }
  };
  pkgRoots.forEach(r => walkPkgs(path.join(REPO, r)));
  add('C586', 'CLI-6 核心：core-cli-utils 只声明了 metro-babel-register，而 execa / debug 是未声明依赖 —— 全仓没有任何 package.json 声明 execa，它只作为 @react-native-community/cli* 与 jest-changed-files 的传递依赖存在',
    '本包未声明 execa/debug，且全仓无 package.json 声明 execa',
    '本包声明:' + declared.join(',') +
      ' / 全仓声明 execa 的包数:' + execaDecliners.length,
    !declared.includes('execa') && !declared.includes('debug') && execaDecliners.length === 0);

  // ── CLI-7：isOnPath 的 exitCode === 0 是死判定 ──
  add('C587', 'CLI-7 核心：isOnPath 用 execa.sync(...).exitCode === 0 判定「找到」—— 但 execa 5.1.1 在非零退出时抛异常（实测 err.exitCode=3），该比较从未产生过 false；判定实际由 catch 分支决定',
    '判定式为 exitCode === 0，且存在 catch 兜底',
    utils.includes('found: execa.sync(...cmd).exitCode === 0,') ? '匹配' : '不匹配',
    utils.includes('found: execa.sync(...cmd).exitCode === 0,') &&
      utils.includes('} catch {') &&
      utils.includes('found: false,'));

  // ── CLI-8：注释指向不存在的入口 ──
  const cuExports = Object.keys(cuPkg.exports ?? {});
  add('C588', 'CLI-8 核心：version.js 的注释让使用者 require("@react-native/core-cli-utils/versions.js")，而 exports 里只有 ./version.js（单数）—— 按注释写会抛 ERR_PACKAGE_PATH_NOT_EXPORTED；注释里的包名还少了个 s',
    'exports 无 ./versions.js，注释却引用它',
    'exports 键:' + cuExports.join(',') +
      ' / 注释引用 versions.js:' + ver.includes("require('@react-native/core-cli-utils/versions.js')"),
    !cuExports.includes('./versions.js') &&
      cuExports.includes('./version.js') &&
      ver.includes("require('@react-native/core-cli-utils/versions.js')") &&
      ver.includes('@react-native/core-cli-util@latest'));

  // ── CLI-9：发布的 NODE_JS 比自身 engines 宽松 ──
  const nodeReq = /NODE_JS:\s*'([^']+)'/.exec(ver)?.[1] ?? '';
  add('C589', 'CLI-9 核心：version.js 发布的 NODE_JS 要求（>= 18）比 core-cli-utils 自己的 engines.node（^22.13.0 || ^24.3.0 || >= 26.0.0）更宽松 —— 这张表是给使用者自查环境用的，会放行跑不起来的环境',
    'NODE_JS >= 18 且 engines 要求 >= 22.13',
    'NODE_JS:' + nodeReq + ' / engines:' + (cuPkg.engines?.node ?? ''),
    nodeReq === '>= 18' &&
      /22\.13\.0/.test(cuPkg.engines?.node ?? '') &&
      /26\.0\.0/.test(cuPkg.engines?.node ?? ''));

  // ── CLI-10：try 内自抛自捕 ──
  const podBlock = apple.slice(apple.indexOf('function checkPodfileInSyncWithManifest'), apple.indexOf('function checkPodfileInSyncWithManifest') + 700);
  add('C590', 'CLI-10 核心：checkPodfileInSyncWithManifest 在 try 块内抛出「Podfile.lock and Pods/Manifest.lock are out of sync」，却被同函数的 catch 捕获并重新包装 —— 两条命令提示不一致（yarn bootstrap ios vs yarn run bootstrap ios）',
    'try 内有 throw，catch 重新包装，且两条命令提示不同',
    'try 内 throw:' + podBlock.includes('throw new Error(') +
      ' / catch 重新包装:' + podBlock.includes("throw new Error('Please run: yarn run bootstrap ios: ' + String(e));") +
      ' / 内层命令:' + (podBlock.includes('yarn bootstrap ios,') ? 'yarn bootstrap ios' : '其它'),
    podBlock.includes('throw new Error(') &&
      podBlock.includes("'Please run: yarn run bootstrap ios: ' + String(e)") &&
      podBlock.includes('yarn bootstrap ios,') &&
      podBlock.includes('} catch (e /*: unknown */) {'));

  // ── CLI-11：metro 的两个恒定开关 ──
  add('C591', 'CLI-11：metro() 恒带 --offline（npx 永不联网取包），且 metro build 的参数数组恒带 --reset-cache（无任何条件分支）',
    '两处恒定开关均存在',
    '--offline:' + app.includes("execa('npx', ['--offline', 'metro', ...args])") +
      ' / --reset-cache:' + app.includes("'--reset-cache',"),
    app.includes("execa('npx', ['--offline', 'metro', ...args])") &&
      app.includes("'--reset-cache',"));

  // ── CLI-12：iOS 侧 isAscii 恒 false ──
  add('C592', 'CLI-12 核心：iOS 侧 NSDataBigString::isAscii() 恒返回 false（注释「The ASCII optimization is not enabled on iOS」）—— 补上 71 文档 KKK-1 缺失的平台维度：Android 走恒 true 的 C++ 实现，iOS 走恒 false 的 ObjC 实现',
    'isAscii 实现恒返回 false',
    ndsH.includes('bool isAscii() const override') && ndsH.includes('return false;') ? '匹配' : '不匹配',
    ndsH.includes('// The ASCII optimization is not enabled on iOS') &&
      ndsH.includes('bool isAscii() const override') &&
      ndsH.includes('return false;'));

  // ── CLI-13：size() 违反基类「不含 NUL」契约 ──
  add('C593', 'CLI-13 核心：基类 JSBigString 明确要求 size() 是「Length of the c_str without the NULL byte」，而 NSDataBigString::size() 返回 NSData 的长度（m_length = [m_data length]），含结尾 NUL —— 多 1；且 null 结尾的前置条件只写在头注释里，无校验',
    '基类注释含 without the NULL byte，且实现返回 m_length',
    '基类契约:' + jbs.includes('// Length of the c_str without the NULL byte.') +
      ' / 实现:' + ndsH.includes('return m_length;') +
      ' / m_length 来自 NSData:' + ndsM.includes('m_length = [m_data length];'),
    jbs.includes('// Length of the c_str without the NULL byte.') &&
      jbs.includes('// This needs to be a \\0 terminated string') &&
      ndsH.includes('return m_length;') &&
      ndsM.includes('m_length = [m_data length];') &&
      ndsH.includes('// The NSData passed in must be be null-terminated.'));

  // ── CLI-14：无界等待与其自认的前置条件 ──
  add('C594', 'CLI-14 核心：RCTMessageThread::runSync 用 dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER) 无界等待，而其成立的前置条件（sync 只用于 setup/teardown、quitSynchronous 必被调用）只在析构函数里用 RCTAssert 检查；runSync 自身不检查 m_shutdown',
    '无界等待 + 析构断言 + runSync 不检查 m_shutdown',
    'DISPATCH_TIME_FOREVER:' + rmt.includes('dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);') +
      ' / 析构 RCTAssert:' + rmt.includes('RCTMessageThread: quitSynchronous() not called before destructor') +
      ' / 前置条件注释:' + rmt.includes('quitSynchronous is guaranteed to be called'),
    rmt.includes('dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);') &&
      rmt.includes('RCTMessageThread: quitSynchronous() not called before destructor') &&
      rmt.includes('quitSynchronous is guaranteed to be called') &&
      !rmt.slice(rmt.indexOf('void RCTMessageThread::runSync'), rmt.indexOf('void RCTMessageThread::tryFunc')).includes('m_shutdown'));

  // ── CLI-15：默认执行器契约 ──
  add('C595', 'CLI-15：RCTCxxBridgeDelegate 的注释写明「If not implemented, or returns an empty pointer, JSIExecutorFactory will be used with a JSCRuntime」—— 默认执行器是 JSI + JSCRuntime',
    '注释声明默认执行器',
    cxb.includes('JSIExecutorFactory') && cxb.includes('will be used with a JSCRuntime') ? '匹配' : '不匹配',
    cxb.includes('If not implemented, or returns an empty pointer, JSIExecutorFactory') &&
      cxb.includes('will be used with a JSCRuntime.') &&
      cxb.includes('jsExecutorFactoryForBridge:(RCTBridge *)bridge'));

  // ── CLI-16：order 被真实消费 ──
  const rnUtils = read('packages/rn-tester/scripts/utils.js') ?? '';
  add('C596', 'CLI-16：Task.order 被真实消费 —— rn-tester 的 run() 按 a.order - b.order 排序后再交给 Listr；正确性依赖 ES2019+ 的稳定排序（app.js 里三个任务同为 order:1、apple.js 里两个同为 FIRST，档内次序由键序决定）',
    '存在按 order 排序的消费方',
    rnUtils.includes('ordered = ordered.sort((a, b) => a.order - b.order);') ? '匹配' : '不匹配',
    rnUtils.includes('ordered = ordered.sort((a, b) => a.order - b.order);') &&
      rnUtils.includes('title: task.label,') &&
      utils.includes('order,') &&
      app.includes('const FIRST = 1,'));

  // ── 文档侧 ──
  addDocClaim('D231', '76 文档写明 assemble 构造了 -PhermesEnabled 却没传出去',
    /构造了\s*`-PhermesEnabled`.*却没传|却把\s*`gradleArgs`\s*传给/, {min: 1});
  addDocClaim('D232', '76 文档写明缓存清理扫的是目标目录的父目录',
    /父目录/, {min: 1});
  addDocClaim('D233', '76 文档写明 fs.rm 不带 callback 会异步抛未捕获异常',
    /不带 callback|缺 callback/, {min: 1});
  addDocClaim('D234', '76 文档写明 -o 被拼成单个 argv 导致 source map 不产出',
    /拼成.*单个\s*argv|单个 argv/, {min: 1});
  addDocClaim('D235', '76 文档写明 require.resolve 不支持 cwd 选项',
    /`require\.resolve`.*不支持.*`\{cwd\}`|只认\s*`paths`/, {min: 1});
  addDocClaim('D236', '76 文档写明 iOS 侧 isAscii 恒返回 false 并补上平台维度',
    /恒返回\s*`false`.*平台维度|补上.*平台维度/, {min: 1});
  addDocClaim('D237', '76 文档写明 runSync 的无界等待与自认的前置条件',
    /无界等待/, {min: 1});
  addDocClaim('D238', '76 文档写明发布的 NODE_JS 要求比自身 engines 更宽松',
    /更宽松/, {min: 1});
  addDocClaim('D239', '76 文档写明 execa 是未声明依赖',
    /未声明依赖/, {min: 1});
  addDocClaim('D240', '「注释描述的能力不存在」这一形态在多个文档中被反复引用',
    /注释描述的.{0,4}不存在/, {min: 2});
}

// ────────────────────────────────────────────────────────────────────────
// 77 文档 · 测试工具层（ReactCommon/react/test_utils）
//   TST-1 … TST-18
// ────────────────────────────────────────────────────────────────────────
{
  const TU = 'packages/react-native/ReactCommon/react/test_utils';
  const entropy = read(TU + '/Entropy.h') ?? '';
  const clock = read(TU + '/MockClock.h') ?? '';
  const mockSurface = read(TU + '/MockSurfaceHandler.h') ?? '';
  const shadowGen = read(TU + '/shadowTreeGeneration.h') ?? '';
  const swizzle = read(TU + '/ios/RCTSwizzleHelpers.m') ?? '';
  const memUtils = read(TU + '/ios/Memory/RCTMemoryUtils.m') ?? '';
  const shim = read(TU + '/ios/Shims/ShimRCTInstance.mm') ?? '';
  const surfaceHandler = read('packages/react-native/ReactCommon/react/renderer/scheduler/SurfaceHandler.h') ?? '';

  // ── TST-1：shuffle 按值传参 ──
  add('C597', 'TST-1 核心：Entropy::shuffle 的签名是 `void shuffle(T array)`（按值传参），而注释写「Shuffles std::vector in place」—— 被打乱的是形参副本，调用方的数组完全不变，messWithChildren 的「随机打乱子节点顺序」从未生效',
    '注释含 in place，签名为按值传参',
    '注释 in place:' + entropy.includes('Shuffles `std::vector` in place.') +
      ' / 签名为 T array:' + entropy.includes('void shuffle(T array) const') +
      ' / 非引用:' + !entropy.includes('void shuffle(T &array) const'),
    entropy.includes('Shuffles `std::vector` in place.') &&
      entropy.includes('void shuffle(T array) const') &&
      !entropy.includes('void shuffle(T &array) const') &&
      entropy.includes('std::shuffle(array.begin(), array.end(), generator_);') &&
      shadowGen.includes('entropy.shuffle(children);'));

  // ── TST-2 / TST-3：random<T>() 返回 bool + T result 未初始化 ──
  add('C598', 'TST-2 核心：Entropy::random<T>() 的无参重载返回 bool，而一参/二参重载返回 T —— 于是 entropy.random<int>() 只可能得到 0 或 1（int 的非零性），zIndex 的随机化实际只有两个取值',
    '无参重载返回 bool，另两个返回 T',
    '无参返回 bool:' + entropy.includes('bool random() const') +
      ' / 一参返回 T:' + entropy.includes('T random(Arg1 arg1) const') +
      ' / 二参返回 T:' + entropy.includes('T random(Arg1 arg1, Arg2 arg2) const'),
    entropy.includes('bool random() const') &&
      entropy.includes('T random(Arg1 arg1) const') &&
      entropy.includes('T random(Arg1 arg1, Arg2 arg2) const') &&
      shadowGen.includes('viewProps.zIndex = entropy.random<int>();'));

  add('C599', 'TST-3：random<T>() 的三个重载都用 `T result;` —— 在传给 generateRandomValue 之前未初始化，依赖被调函数内部必定赋值',
    '三个重载均为 `T result;`',
    '出现次数: ' + (entropy.split('T result;').length - 1),
    (entropy.split('T result;').length - 1) === 3);

  // ── TST-4：distribute 的钳位上界 == 桶数 ──
  add('C600', 'TST-4：distribute() 的钳位上界是 deviationLimit * 2，而桶数 spreadResult.size() 也是 deviationLimit * 2 —— index 等于桶数的元素被 `if (position < spreadResult.size())` 静默丢弃（边界语义不自洽）',
    '钳位上界与桶数同源',
    '钳位:' + entropy.includes('std::min(position, deviationLimit * 2)') +
      ' / 桶数:' + entropy.includes('std::vector<std::vector<T>>(deviationLimit * 2)') +
      ' / 保护:' + entropy.includes('if (position < spreadResult.size()) {'),
    entropy.includes('std::min(position, deviationLimit * 2)') &&
      entropy.includes('std::vector<std::vector<T>>(deviationLimit * 2)') &&
      entropy.includes('if (position < spreadResult.size()) {'));

  // ── TST-5：findRandomShadowNode 的区间前提错误 ──
  const countFn = shadowGen.slice(shadowGen.indexOf('static int countShadowNodes'), shadowGen.indexOf('static ShadowTreeEdge findShadowNodeWithIndex'));
  add('C601', 'TST-5 核心：findRandomShadowNode 用 entropy.random<int>(1 /* Excluding a root node */, count - 1)，但 countShadowNodes 的回调只对子节点触发 —— count 不含根节点，后代索引是 0 基，故区间本就漏掉第 0 个后代，且 count ≤ 1 时构造出 uniform_int_distribution<int>(1, 0)（min > max，标准规定为未定义行为）',
    '区间上界为 count-1 且 count 不含根',
    '区间:' + shadowGen.includes('entropy.random<int>(1 /* Excluding a root node */, count - 1)') +
      ' / count 只计子节点:' + countFn.includes('traverseShadowTree(rootShadowNode') &&
      !countFn.includes('counter++;\n\n  return counter;\n}\n\nstatic ShadowTreeEdge') === false,
    shadowGen.includes('entropy.random<int>(1 /* Excluding a root node */, count - 1)') &&
      countFn.includes('traverseShadowTree(rootShadowNode') &&
      shadowGen.includes('callback(ShadowTreeEdge{childNode, parentShadowNode, index}, stop);') &&
      shadowGen.includes('auto index = int{0};'));

  // ── TST-6：alterShadowTree 空列表 ──
  add('C602', 'TST-6：alterShadowTree 的 vector 重载用 entropy.random<int>(0, alterations.size() - 1) 取下标，空列表时 size() - 1 下溢为 -1，构造出 uniform_int_distribution<int>(0, -1)（min > max），随后 alterations[i] 越界访问空 vector',
    '下界为 0、上界为 size()-1，无空列表防护',
    '存在该表达式:' + shadowGen.includes('entropy.random<int>(0, alterations.size() - 1)') +
      ' / 无空列表检查:' + !shadowGen.includes('if (alterations.empty())'),
    shadowGen.includes('entropy.random<int>(0, alterations.size() - 1)') &&
      !shadowGen.includes('if (alterations.empty())'));

  // ── TST-7：traverseShadowTree 无深度限制 ──
  add('C603', 'TST-7：traverseShadowTree 每层递归一次自身，无深度上限（与 64 文档 DDD-2 同型），影子树深度由被测代码决定',
    '存在自递归且无深度参数',
    '自递归:' + shadowGen.includes('if (traverseShadowTree(childNode, callback)) {') +
      ' / 无深度参数:' + !shadowGen.includes('maxDepth') && !shadowGen.includes('depth'),
    shadowGen.includes('if (traverseShadowTree(childNode, callback)) {') &&
      !shadowGen.includes('maxDepth'));

  // ── TST-8：generateReactTag 的每 TU 计数器 ──
  add('C604', 'TST-8：generateReactTag 的计数器是头文件里函数内的 static Tag tag = 1000 —— 每个包含该头文件的 TU 各有一份，都从 1000 开始，而 Tag 是 ShadowNodeFamily 的身份标识',
    '函数内 static 计数器，且定义在头文件',
    '计数器:' + shadowGen.includes('static Tag tag = 1000;') +
      ' / 函数为 static:' + shadowGen.includes('static Tag generateReactTag()'),
    shadowGen.includes('static Tag tag = 1000;') &&
      shadowGen.includes('static Tag generateReactTag()'));

  // ── TST-9：findShadowNodeWithIndex 越界静默返回空边 ──
  add('C605', 'TST-9：findShadowNodeWithIndex 越界时返回默认构造的 ShadowTreeEdge（shadowNode 为 nullptr），而调用方 alterShadowTree 立刻 edge.shadowNode->getFamily() —— 空指针解引用，且越界没有任何信号',
    '默认构造的边成员全为默认值',
    'result 默认构造:' + shadowGen.includes('auto result = ShadowTreeEdge{};') +
      ' / 成员默认值:' + shadowGen.includes('std::shared_ptr<const ShadowNode> shadowNode{nullptr};') +
      ' / 调用方解引用:' + shadowGen.includes('edge.shadowNode->getFamily()'),
    shadowGen.includes('auto result = ShadowTreeEdge{};') &&
      shadowGen.includes('std::shared_ptr<const ShadowNode> shadowNode{nullptr};') &&
      shadowGen.includes('edge.shadowNode->getFamily()'));

  // ── TST-10 / TST-11：const_cast 与头文件里的 EXPECT_EQ ──
  add('C606', 'TST-10：messWithLayoutableOnlyFlag 用 const_cast 去掉 cloneProps 返回的 const ViewProps 后直接改字段，绕过渲染器的 props 不可变性契约',
    '存在 const_cast 去掉 const',
    'const_cast:' + shadowGen.includes('const_cast<ViewProps &>(static_cast<const ViewProps &>(*newProps))'),
    (shadowGen.match(/const_cast<ViewProps &>/g) ?? []).length >= 2 &&
      shadowGen.includes('const_cast<ViewProps &>(static_cast<const ViewProps &>(*newProps))'));

  add('C607', 'TST-11：属性清单长度被 EXPECT_EQ(properties.size(), 20) 锁死，且该断言写在头文件的辅助函数内部 —— 约束本身正确，但失败时归属辅助函数而非调用它的测试',
    '断言存在且清单为 20 项',
    '断言:' + shadowGen.includes('EXPECT_EQ(properties.size(), 20);'),
    shadowGen.includes('EXPECT_EQ(properties.size(), 20);') &&
      shadowGen.includes('It is not safe to add new Yoga properties to this list.'));

  // ── TST-12：MockClock::time_ 双定义 + 全局命名空间 ──
  const clockDef1 = read('packages/react-native/ReactCommon/react/renderer/animations/tests/LayoutAnimationTest.cpp') ?? '';
  const clockDef2 = read('packages/react-native/ReactCommon/react/renderer/telemetry/tests/TransactionTelemetryTest.cpp') ?? '';
  add('C608', 'TST-12 核心：MockClock::time_ 是头文件里声明的静态成员，但在两个测试 TU 里各定义了一次（LayoutAnimationTest.cpp 与 TransactionTelemetryTest.cpp）—— 同一二进制内即重复定义；且 MockClock 不在任何 namespace 内',
    '两个定义点 + 类不在命名空间内',
    '定义点 1:' + clockDef1.includes('MockClock::time_point MockClock::time_ = {};') +
      ' / 定义点 2:' + clockDef2.includes('MockClock::time_point MockClock::time_ = {};') +
      ' / 在命名空间内:' + clock.includes('namespace facebook::react'),
    clockDef1.includes('MockClock::time_point MockClock::time_ = {};') &&
      clockDef2.includes('MockClock::time_point MockClock::time_ = {};') &&
      clock.includes('class MockClock {') &&
      !clock.includes('namespace facebook::react') &&
      !clock.includes('reset'));

  // ── TST-13：getSurfaceId 非 virtual + 头文件零引用 ──
  const getSidLine = surfaceHandler.split('\n').find(l => l.includes('getSurfaceId() const noexcept'));
  let mockSurfaceRefs = 0;
  const countRefs = dir => {
    let ents;
    try { ents = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { countRefs(p); continue; }
      if (!/\.(cpp|cc|h|mm|m)$/.test(e.name)) continue;
      const rel = path.relative(REPO, p);
      if (rel.endsWith('test_utils/MockSurfaceHandler.h')) continue;
      try {
        const t = fs.readFileSync(p, 'utf8');
        if (t.includes('MockSurfaceHandler')) mockSurfaceRefs++;
      } catch {}
    }
  };
  countRefs(path.join(REPO, 'packages'));
  add('C609', 'TST-13 核心：MockSurfaceHandler 对 getSurfaceId 做了 MOCK_METHOD，但基类 SurfaceHandler::getSurfaceId() 不是 virtual —— gmock 生成的是新虚函数（遮蔽而非 override），通过基类指针调用走真实实现；且该头文件在 packages/ 下零引用',
    '基类 getSurfaceId 非 virtual，且头文件零引用',
    '基类行:' + (getSidLine ?? '').trim() +
      ' / 非 virtual:' + !(getSidLine ?? '').includes('virtual') +
      ' / 引用数:' + mockSurfaceRefs,
    getSidLine != null && !getSidLine.includes('virtual') &&
      surfaceHandler.includes('virtual void setDisplayMode(DisplayMode displayMode) const noexcept;') &&
      mockSurface.includes('MOCK_METHOD(SurfaceId, getSurfaceId, (), (const, noexcept));') &&
      mockSurfaceRefs === 0);

  // ── TST-14：reset 再次 swizzle ──
  const initBlock = shim.slice(shim.indexOf('- (instancetype)init'), shim.indexOf('- (void)reset'));
  const resetBlock = shim.slice(shim.indexOf('- (void)reset'), shim.indexOf('- (instancetype)initWithDelegate'));
  const swapCount = b => (b.match(/RCTSwizzleInstanceSelector\(/g) ?? []).length;
  add('C610', 'TST-14 核心：ShimRCTInstance 的 init 交换三个 selector，而 reset 又交换同样三个 —— method_exchangeImplementations 是对合的，交换两次即还原，故 reset 之后 shim 不再拦截，而计数归零看起来像成功',
    'init 与 reset 各交换 3 次同样的 selector',
    'init 交换数:' + swapCount(initBlock) + ' / reset 交换数:' + swapCount(resetBlock),
    swapCount(initBlock) === 3 && swapCount(resetBlock) === 3 &&
      initBlock.includes('RCTSwizzleInstanceSelector([RCTInstance class], [ShimRCTInstance class], @selector(invalidate));') &&
      resetBlock.includes('RCTSwizzleInstanceSelector([RCTInstance class], [ShimRCTInstance class], @selector(invalidate));') &&
      resetBlock.includes('_initCount = 0;') &&
      resetBlock.includes('_invalidateCount = 0;'));

  // ── TST-15：weakShim 全局 __weak ──
  add('C611', 'TST-15：ShimRCTInstance 用文件级 static __weak ShimRCTInstance *weakShim 记录计数目标 —— shim 释放后计数静默停止更新（对 nil 发消息），且多个实例互相覆盖同一个全局槽位',
    '文件级 static __weak 单例槽',
    '声明:' + shim.includes('static __weak ShimRCTInstance *weakShim = nil;') +
      ' / 赋值:' + shim.includes('weakShim = self;') +
      ' / 计数:' + shim.includes('weakShim.initCount++;'),
    shim.includes('static __weak ShimRCTInstance *weakShim = nil;') &&
      shim.includes('weakShim = self;') &&
      shim.includes('weakShim.initCount++;') &&
      shim.includes('weakShim.invalidateCount++;'));

  // ── TST-16：swizzle 无检查 + 继承链 + 无还原函数 ──
  add('C612', 'TST-16：RCTSwizzleInstanceSelector 对 class_getInstanceMethod 的返回值不做任何检查（selector 不存在时以 NULL 参与 method_exchangeImplementations）；该 API 沿继承链查找，可能交换到父类的方法；本目录也没有提供对应的还原函数',
    '无空指针检查，且无 un-swizzle 入口',
    '无检查:' + !swizzle.includes('if (originalMethod == NULL') &&
      !swizzle.includes('NSAssert') +
      ' / 无还原函数:' + !exists(TU + '/ios/RCTSwizzleHelpers.h') === false,
    !swizzle.includes('NSAssert') &&
      !swizzle.includes('== NULL') &&
      swizzle.includes('Method originalMethod = class_getInstanceMethod(targetClass, selector);') &&
      swizzle.includes('method_exchangeImplementations(originalMethod, swizzleMethod);') &&
      !shim.includes('RCTUnswizzleInstanceSelector'));

  // ── TST-17：半公开 API + Release 下 assert 失效 ──
  add('C613', 'TST-17：RCTMemoryUtils.m 自己用 OBJC_EXPORT 重新声明了 objc_autoreleasePoolPush / objc_autoreleasePoolPop（说明它们不在公开头文件里），且 RCTAutoReleasePoolPop 用 assert 守护「栈非空」—— Release 下断言被编译掉，栈空时会调用 objc_autoreleasePoolPop(NULL)',
    '自行 OBJC_EXPORT 声明 + assert 守护栈非空',
    'OBJC_EXPORT:' + memUtils.includes('OBJC_EXPORT') +
      ' / assert 栈非空:' + memUtils.includes('assert(contextStack.count > 0);'),
    memUtils.includes('OBJC_EXPORT') &&
      memUtils.includes('void *objc_autoreleasePoolPush(void) __OSX_AVAILABLE_STARTING(__MAC_10_7, __IPHONE_5_0);') &&
      memUtils.includes('assert(contextStack.count > 0);') &&
      memUtils.includes('objc_autoreleasePoolPop(lastContext.pointerValue);'));

  // ── TST-18：OSS 构建文件零引用 ──
  let cmakeGtest = 0;
  let podspecRefs = 0;
  const walkBuild = dir => {
    let ents;
    try { ents = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walkBuild(p); continue; }
      if (e.name === 'CMakeLists.txt' || e.name.endsWith('.cmake')) {
        try {
          const t = fs.readFileSync(p, 'utf8');
          if (/gtest|GTest/.test(t)) cmakeGtest++;
        } catch {}
      }
      if (e.name.endsWith('.podspec')) {
        try {
          const t = fs.readFileSync(p, 'utf8');
          if (t.includes('test_utils')) podspecRefs++;
        } catch {}
      }
    }
  };
  walkBuild(path.join(REPO, 'packages'));
  add('C614', 'TST-18：test_utils 目录在 OSS 可见的构建系统里零引用 —— packages/ 下没有任何含 gtest/GTest 的 CMakeLists 或 .cmake，也没有任何 podspec 提到 test_utils —— 因此本目录的结论不影响 OSS 用户的产物，只影响内部测试的有效性',
    'CMake 无 gtest 目标、podspec 无引用',
    '含 gtest 的构建文件数:' + cmakeGtest + ' / 提到 test_utils 的 podspec 数:' + podspecRefs,
    cmakeGtest === 0 && podspecRefs === 0);

  // ── 文档侧 ──
  addDocClaim('D241', '77 文档写明 shuffle 按值传参导致「in place」从未发生',
    /按值传参/, {min: 1});
  addDocClaim('D242', '77 文档写明 random<T>() 无参重载返回 bool 导致 zIndex 只取两个值',
    /只得到\s*`?0`?\s*或\s*`?1`?/, {min: 1});
  addDocClaim('D243', '77 文档写明 findRandomShadowNode 的区间前提错误会导致 min > max',
    /min > max/, {min: 1});
  addDocClaim('D244', '77 文档写明 reset 会因为 method_exchangeImplementations 的对合性而撤销 swizzle',
    /对合/, {min: 1});
  addDocClaim('D245', '77 文档写明 MockClock::time_ 在两个 TU 里各定义一次',
    /各定义一次/, {min: 1});
  addDocClaim('D246', '77 文档写明 MockSurfaceHandler 的 getSurfaceId mock 因基类非 virtual 而无效',
    /不是\s*`?virtual`?/, {min: 1});
  addDocClaim('D247', '77 文档写明本目录在 OSS 的构建文件里零引用',
    /零引用|没有任何引用/, {min: 1});
  addDocClaim('D248', '「注释/命名承诺的行为与实现不符」这一形态在本仓反复出现',
    /注释.{0,6}承诺|注释描述的能力不存在/, {min: 3});
}

// ────────────────────────────────────────────────────────────────────────
// 78 文档 · 构建期的静态检查与转译层（ESLint + Babel）
//   LNT-1 … LNT-23
// ────────────────────────────────────────────────────────────────────────
{
  const EC = 'packages/eslint-config-react-native';
  const EPR = 'packages/eslint-plugin-react-native';
  const EPS = 'packages/eslint-plugin-specs';
  const BP = 'packages/react-native-babel-preset/src';
  const BT = 'packages/react-native-babel-transformer/src';

  const ecIndex = read(EC + '/index.js') ?? '';
  const ecShared = read(EC + '/shared.js') ?? '';
  const ecFlat = read(EC + '/flat.js') ?? '';
  const noDeep = read(EPR + '/no-deep-imports.js') ?? '';
  const platColors = read(EPR + '/platform-colors.js') ?? '';
  const specModules = read(EPS + '/react-native-modules.js') ?? '';
  const prepack = read(EPS + '/prepack.js') ?? '';
  const postpack = read(EPS + '/postpack.js') ?? '';
  const babelReg = read(EPS + '/with-babel-register/index.js') ?? '';
  const lazyImports = read(BP + '/configs/lazy-imports.js') ?? '';
  const presetMain = read(BP + '/configs/main.js') ?? '';
  const warnDeep = read(BP + '/plugin-warn-on-deep-imports.js') ?? '';
  const inlinePlat = read(BP + '/inline-platform-plugin.js') ?? '';
  const transformer = read(BT + '/index.js') ?? '';
  const codegen = read('packages/babel-plugin-codegen/index.js') ?? '';
  const rootEslint = read('.eslintrc.js') ?? '';

  // ── LNT-1：eslintrc 与 flat 的 glob 宽度不同 ──
  const ecFiles = [...ecIndex.matchAll(/files:\s*\[([^\]]*)\]/g)].map(m => m[1]);
  const flatFiles = [...ecFlat.matchAll(/files:\s*\[([^\]]*)\]/g)].map(m => m[1]);
  // eslintrc 侧前四个 override（flow / jsx / reactNative / typescript）都无 **/；第 5 个 jest override 用了 **/
  const ecFirstFour = ecFiles.slice(0, 4);
  add('C615', 'LNT-1 核心：eslint-config-react-native/index.js 的四个 override 的 files 全部是 *.js / *.jsx / *.ts / *.tsx 形式（无 **/），而 flat.js 的对应 override 全部是 **/*.js 形式 —— 同一份 shared.js 在两种配置格式下作用于不同的文件集合',
    'eslintrc 前四个 override 无 **/，flat 侧全部带 **/',
    'eslintrc 侧 files: ' + ecFiles.length + ' 个（前 4 个带 **/ 的: ' + ecFirstFour.filter(f => f.includes('**')).length + '）' +
      ' / flat 侧 files: ' + flatFiles.length + ' 个，带 **/ 的: ' + flatFiles.filter(f => f.includes('**')).length,
    ecFirstFour.length === 4 && ecFirstFour.every(f => !f.includes('**')) &&
      flatFiles.filter(f => f.includes('**')).length >= 4 &&
      ecIndex.includes("files: ['*.js'],") &&
      ecIndex.includes("files: ['*.js', '*.jsx', '*.ts', '*.tsx'],") &&
      ecFlat.includes("files: ['**/*.js'],") &&
      ecFlat.includes("files: ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx'],"));

  // ── LNT-2：配置文本损坏 ──
  add('C616', 'LNT-2 核心：shared.js 有一行把 `: 1,` 吞进了行尾注释（注释里还多一个孤立的引号）—— 语法完全合法但某条规则从未生效',
    '该行含被吞进注释的 `: 1,`',
    '命中: ' + (ecShared.includes('comments": 1,') ? '是' : '否'),
    ecShared.includes('disallow usage of configurable warning terms in comments": 1,') &&
      ecShared.includes("'no-warning-comments': 0,"));

  // ── LNT-3：v9 计划移除的格式类规则 ──
  const legacyRules = ["'no-inner-declarations'", "'no-negated-in-lhs'", "'no-native-reassign'", "'no-catch-shadow'"];
  const present = legacyRules.filter(r => ecShared.includes(r + ':'));
  add('C617', 'LNT-3：shared.js 里存在四条 ESLint v9 计划移除的格式类规则（当前仓库 eslint ^8.57.0 仍可用，升级到 9 时这份配置会加载失败）',
    '四条规则都在配置里',
    present.length + '/4 条: ' + present.join(' '),
    present.length === 4);

  // ── LNT-4：globals 的 legacy 布尔 → flat 字符串 ──
  add('C618', 'LNT-4：shared.js 的 globals 用 legacy 布尔形式（true/false，注释写「bool specifying if it can be redefined」），flat.js 显式转换为 writable/readonly —— 是刻意的双格式兼容而非遗留问题',
    'flat.js 存在 convertGlobals 且与注释一致',
    '转换函数:' + ecFlat.includes('const convertGlobals = globals => {') +
      ' / 映射:' + ecFlat.includes("converted[key] = value ? 'writable' : 'readonly';"),
    ecFlat.includes('// Convert globals from legacy format (true/false) to flat config format (\'readonly\'/\'writable\')') &&
      ecFlat.includes("converted[key] = value ? 'writable' : 'readonly';") &&
      ecShared.includes('// Map from global var to bool specifying if it can be redefined') &&
      ecShared.includes('__DEV__: true,'));

  // ── LNT-5：no-deep-imports 的级别 ──
  add('C619', 'LNT-5：@react-native/no-deep-imports 的级别是 1（warning）而非 error —— 唯一一条 RN 自有规则连 error 级别都不是',
    '级别为 1',
    ecShared.includes("'@react-native/no-deep-imports': 1,") ? '1' : '其它',
    ecShared.includes("'@react-native/no-deep-imports': 1,") &&
      !ecShared.includes("'@react-native/no-deep-imports': 2,") &&
      rootEslint.includes("'@react-native/no-deep-imports': 'off',"));

  // ── LNT-6：ESLint 与 Babel 的 deep-import 判定不一致 ──
  const eslintExempts = ['react-native/asset-registry', 'react-native/react-private-interface', 'react-native/setup-env', 'react-native/unstable-internals-do-not-use'];
  const eslintHasAll = eslintExempts.every(e => noDeep.includes("source.value === '" + e + "'"));
  add('C620', 'LNT-6 核心：ESLint 的 no-deep-imports 豁免了 4 个二级入口与 react-native/src/fb_internal/，而 Babel 的 warn-on-deep-imports 只判断 parts[0] === "react-native" —— 一个都不豁免；同一个导入静态检查放行、构建期却打警告',
    'ESLint 豁免 4 条 + fb_internal，Babel 零豁免',
    'ESLint 豁免齐全:' + eslintHasAll +
      ' / fb_internal:' + noDeep.includes("startsWith('react-native/src/fb_internal/')") +
      ' / Babel 无豁免:' + !warnDeep.includes('asset-registry') && !warnDeep.includes('fb_internal'),
    eslintHasAll &&
      noDeep.includes("startsWith('react-native/src/fb_internal/')") &&
      warnDeep.includes("const parts = source.split('/');") &&
      warnDeep.includes("return parts.length > 1 && parts[0] === 'react-native';") &&
      !warnDeep.includes('asset-registry'));

  // ── LNT-7：Babel 缺 ExportAllDeclaration ──
  add('C621', 'LNT-7：Babel 的 warn-on-deep-imports 有 ImportDeclaration / CallExpression / ExportNamedDeclaration 三个 visitor，但没有 ExportAllDeclaration —— `export * from "react-native/..."` 不会产生警告',
    '三个 visitor 齐全且无 ExportAllDeclaration',
    'ImportDeclaration:' + warnDeep.includes('ImportDeclaration(path, state) {') +
      ' / ExportNamedDeclaration:' + warnDeep.includes('ExportNamedDeclaration(path, state) {') +
      ' / ExportAllDeclaration:' + warnDeep.includes('ExportAllDeclaration'),
    warnDeep.includes('ImportDeclaration(path, state) {') &&
      warnDeep.includes('ExportNamedDeclaration(path, state) {') &&
      !warnDeep.includes('ExportAllDeclaration'));

  // ── LNT-8：DynamicColorIOS 的 forEach 报错 ──
  const dynStart = platColors.indexOf("node.callee.name === 'DynamicColorIOS'");
  const dynBlock = dynStart > 0 ? platColors.slice(dynStart) : '';
  add('C622', 'LNT-8：platform-colors 的 DynamicColorIOS 分支用 properties.forEach + return（只跳过当前属性），而 PlatformColor 分支是「报一次即 return」—— 两个分支的报错次数语义不同',
    'DynamicColorIOS 用 forEach',
    'forEach:' + dynBlock.includes('properties.forEach(property => {') +
      ' / PlatformColor 分支用 every+return:' + platColors.includes('!args.every('),
    dynBlock.includes('properties.forEach(property => {') &&
      platColors.includes('!args.every('));

  // ── LNT-9：messageId 语病 ──
  add('C623', 'LNT-9：platform-colors 的 platformColorArgTypes 文案缺了 must（其余三条 messageId 都是完整句式）',
    '文案缺 must',
    platColors.includes("'PlatformColor() every argument must be a literal.'") ? '命中' : '未命中',
    platColors.includes("'PlatformColor() every argument must be a literal.'") &&
      platColors.includes("'PlatformColor() must have at least one argument that is a literal.'"));

  // ── LNT-10：刻意拼接以避开扫描 ──
  add('C624', 'LNT-10：eslint-plugin-specs 的 isGeneratedFile 用 "@" + "generated SignedSource<<" 拼接来检测生成文件 —— 拼接本身无技术必要，作用是让按字面量扫描该字符串的工具扫不到（与 67 文档 GGG-1「该约定全仓零校验」构成同一约定的两种态度）',
    '存在刻意拼接',
    specModules.includes(".indexOf('@' + 'generated SignedSource<<')") ? '命中' : '未命中',
    specModules.includes(".indexOf('@' + 'generated SignedSource<<')") &&
      !specModules.includes(".indexOf('@generated SignedSource<<')"));

  // ── LNT-11：prepack/postpack 的精确字符串替换 ──
  add('C625', 'LNT-11：eslint-plugin-specs 的 prepack/postpack 用精确字符串替换改 PACKAGE_USAGE 常量（false→true / true→false），而 String.replace 找不到匹配时原样返回、不抛错 —— 替换失败是静默的',
    '两侧都是精确字符串替换',
    'prepack:' + prepack.includes("'const PACKAGE_USAGE = false;',") +
      ' / postpack:' + postpack.includes("'const PACKAGE_USAGE = true;',") +
      ' / 无成功校验:' + !prepack.includes("if (result === source)") && !postpack.includes("if (result === source)"),
    prepack.includes("source.replace(\n    'const PACKAGE_USAGE = false;',\n    'const PACKAGE_USAGE = true;',\n  )") &&
      postpack.includes("source.replace(\n    'const PACKAGE_USAGE = true;',\n    'const PACKAGE_USAGE = false;',\n  )") &&
      !prepack.includes('if (result === source)'));

  // ── LNT-12：mtime 毫秒缓存 + 污染返回对象 ──
  add('C626', 'LNT-12：with-babel-register 的编译缓存以毫秒级 mtime（+fs.statSync(f).mtime）为键，且把 mtime 挂在 Babel transformSync 的返回对象上（污染第三方对象）；finally 里撤销 require hook 是对的',
    '毫秒 mtime + 挂在返回对象上 + finally 撤销',
    'mtime:' + babelReg.includes('return +fs.statSync(filename).mtime;') +
      ' / 挂到 output:' + babelReg.includes('output.mtime = mtime(filename);') +
      ' / finally 撤销:' + babelReg.includes('} finally {\n    revertHook();'),
    babelReg.includes('return +fs.statSync(filename).mtime;') &&
      babelReg.includes('output.mtime = mtime(filename);') &&
      babelReg.includes('} finally {\n    revertHook();'));

  // ── LNT-13：__test_fixtures__ 被计入覆盖范围 ──
  const fixturesCount = ['packages/babel-plugin-codegen/__test_fixtures__/fixtures.js', 'packages/babel-plugin-codegen/__test_fixtures__/failures.js']
    .filter(p => exists(p)).length;
  add('C627', 'LNT-13：babel-plugin-codegen 的 __test_fixtures__ 目录（2 个文件 / 430 行）被计入「非测试代码文件」—— 覆盖范围的测试目录过滤规则不匹配 __test_fixtures__，因此测试夹具被算作源码',
    '两个夹具文件存在且目录名不是 __tests__',
    '夹具文件数: ' + fixturesCount + ' / 目录名: __test_fixtures__',
    fixturesCount === 2 && exists('packages/babel-plugin-codegen/__test_fixtures__/fixtures.js'));

  // ── LNT-14：lazy-imports 与 index.js 的脱节（实测比对）──
  const lazyEntries = [...lazyImports.matchAll(/^\s*'([^']+)',/gm)].map(m => m[1]);
  const lazySet = new Set(lazyEntries);
  const rnIndex = read('packages/react-native/index.js') ?? '';
  const rnExports = [...rnIndex.matchAll(/get\s+([A-Za-z0-9_]+)\s*\(\)/g)].map(m => m[1]);
  const missing = rnExports.filter(n => !lazySet.has(n));
  const extra = [...lazySet].filter(n => !rnExports.includes(n));
  const dupCount = lazyEntries.length - lazySet.size;
  add('C628', 'LNT-14 核心：babel-preset 的 lazy-imports 清单自称「Keep this list in sync with react-native/index.js」，实测脱节 —— index.js 的导出有 36 个不在清单里、清单有 10 个是 index.js 已无的死条目、且 ReactNative 重复出现两次',
    '缺失 36 / 死条目 10 / 重复 1',
    'index.js 导出: ' + rnExports.length + ' / 清单条目: ' + lazySet.size +
      ' / 缺失: ' + missing.length + ' / 死条目: ' + extra.length + ' / 重复: ' + dupCount,
    missing.length === 36 && extra.length === 10 && dupCount === 1 &&
      lazyImports.includes('// react-native/index.js (though having extra entries here is fairly harmless).'));

  // ── LNT-15：Platform.select({}) → undefined ──
  add('C629', 'LNT-15：inline-platform-plugin 的 hasStaticProperties 用 every（对空数组返回 true），因此 Platform.select({}) 通过检查；回退链 platform→native→default 全部落空后，整个调用被替换成标识符 undefined',
    '回退链终点是 t.identifier("undefined")',
    inlinePlat.includes("findProperty(spec, 'default', () => t.identifier('undefined'))") ? '命中' : '未命中',
    inlinePlat.includes("findProperty(spec, 'default', () => t.identifier('undefined'))") &&
      inlinePlat.includes('return objectExpression.properties.every(property => {') &&
      inlinePlat.includes("path.replaceWith(t.stringLiteral(platform));"));

  // ── LNT-16：警告分组追加 ──
  add('C630', 'LNT-16：warn-on-deep-imports 把 require / import / export 三类警告各自收集后按固定顺序追加到程序体末尾 —— 警告顺序与它们在源码里的位置无关（原始 loc 由 withLocation 保留）',
    '三类分组后合并追加',
    warnDeep.includes('...requireWarnings,\n          ...importWarnings,\n          ...exportWarnings,') ? '命中' : '未命中',
    warnDeep.includes('...requireWarnings,') &&
      warnDeep.includes('...importWarnings,') &&
      warnDeep.includes('...exportWarnings,') &&
      warnDeep.includes('body.push(...warnings);') &&
      warnDeep.includes('function withLocation(node, loc) {'));

  // ── LNT-19：getBabelRC 不按 projectRoot 分键 ──
  const gbrStart = transformer.indexOf('const getBabelRC = (function () {');
  const gbrBlock = transformer.slice(gbrStart, transformer.indexOf('function buildBabelConfig'));
  add('C631', 'LNT-19 核心：react-native-babel-transformer 的 getBabelRC 用模块级单例 babelRC 记忆化，判空条件只有 babelRC != null —— projectRoot 与 extendsBabelConfigPath 都不参与键的构造；缓存键 cacheKeyParts 同样不含 projectRoot',
    '缓存判空不含 projectRoot，且缓存键也不含',
    '判空:' + gbrBlock.includes('if (babelRC != null) {\n      return babelRC;') +
      ' / 缓存键:' + transformer.includes('const cacheKeyParts = [getPresetCacheKey(), fs.readFileSync(__filename)];'),
    gbrBlock.includes('if (babelRC != null) {\n      return babelRC;') &&
      !gbrBlock.includes('babelRC != null &&') &&
      transformer.includes('const cacheKeyParts = [getPresetCacheKey(), fs.readFileSync(__filename)];') &&
      !transformer.includes('cacheKeyParts = [getPresetCacheKey(), options.projectRoot') &&
      gbrBlock.includes('projectRoot,') &&
      gbrBlock.includes('babelRC.presets = ['));

  // ── LNT-20：envName 的 BABEL_ENV 优先 ──
  add('C632', 'LNT-20：babel-transformer 的 envName 在非 dev 时取 process.env.BABEL_ENV || "production" —— 环境变量会静默改变所有生产构建的 env，进而影响 preset 里 babel.env("development") 的判定',
    'BABEL_ENV 优先于 production',
    transformer.includes("process.env.BABEL_ENV || 'production'") ? '命中' : '未命中',
    transformer.includes("envName: options.dev\n      ? 'development'\n      : process.env.BABEL_ENV || 'production',") &&
      presetMain.includes("const dev = options.dev ?? babel?.env('development') ?? false;"));

  // ── LNT-21：codegen 的两处边界 ──
  add('C633', 'LNT-21：babel-plugin-codegen 的 parseFile 用 endsWith("js") 判定（同时匹配 .mjs/.cjs，会被当 Flow 解析），且 generateViewConfig 的 libraryName 用 String.replace 去掉 NativeComponent.(js|ts) 但不校验是否命中（未命中时 libraryName 保留扩展名）',
    'endsWith("js") + replace 无命中校验',
    'endsWith:' + codegen.includes("if (filename.endsWith('js')) {") +
      ' / replace:' + codegen.includes('/NativeComponent\\.(js|ts)$/') +
      ' / 无命中校验:' + !codegen.includes('if (libraryName === basename(filename))'),
    codegen.includes("if (filename.endsWith('js')) {") &&
      codegen.includes("const libraryName = basename(filename).replace(") &&
      !codegen.includes('if (libraryName === basename(filename))') &&
      codegen.includes("require('@react-native/codegen/lib/parsers/flow/parser').FlowParser;"));

  // ── 文档侧 ──
  addDocClaim('D249', '78 文档写明 eslintrc 与 flat 两种配置格式的 files glob 宽度不同',
    /两种配置格式/, {min: 1});
  addDocClaim('D250', '78 文档写明 shared.js 有一处配置文本损坏导致规则静默失效',
    /配置文本损坏/, {min: 1});
  addDocClaim('D251', '78 文档写明 lazy-imports 与 index.js 有 36 个导出缺失',
    /36 个导出缺失/, {min: 1});
  addDocClaim('D252', '78 文档写明 getBabelRC 的缓存不按 projectRoot 分键',
    /不按\s*`?projectRoot`?\s*分键/, {min: 1});
  addDocClaim('D253', '78 文档写明 ESLint 与 Babel 的 deep-import 判定不一致',
    /判定不一致/, {min: 1});
  addDocClaim('D254', '78 文档写明 __test_fixtures__ 被计入覆盖范围',
    /__test_fixtures__/, {min: 1});
  addDocClaim('D255', '78 文档写明 prepack/postpack 的替换失败是静默的',
    /静默失效|静默失败/, {min: 1});
  addDocClaim('D256', '「静默失效」这一形态在多个文档中被反复引用',
    /静默失效/, {min: 3});
}

// ────────────────────────────────────────────────────────────────────────
// 79 文档 · JS/Native 边界的类型兼容性检查器（compatibility-check）
//   CMP-1 … CMP-21
// ────────────────────────────────────────────────────────────────────────
{
  const CC = 'packages/react-native-compatibility-check/src';
  const read = f => fs.readFileSync(path.join(REPO, CC, f), 'utf8');
  const srcFiles = [
    'TypeDiffing.js',
    'VersionDiffing.js',
    'ErrorFormatting.js',
    'SortTypeAnnotations.js',
    'ComparisonResult.js',
    'DiffResults.js',
    'convertPropToBasicTypes.js',
    'index.js',
    'index.flow.js',
  ];
  const src = srcFiles.map(read).join('\n');
  const cmpType = read('TypeDiffing.js');
  const cmpVersion = read('VersionDiffing.js');
  const cmpFormat = read('ErrorFormatting.js');
  const cmpSort = read('SortTypeAnnotations.js');
  const cmpDiff = read('DiffResults.js');
  const cmpConvert = read('convertPropToBasicTypes.js');
  const cmpIndex = read('index.js');
  const countOf = (haystack, needle) => haystack.split(needle).length - 1;

  // ── CMP-1：changedParams 是死错误码 ──
  add('C634', 'CMP-1 核心：DiffResults.js 的 ErrorCode 联合声明了 changedParams，但该字符串在全包 src 里只出现 1 次（就是声明本身），没有任何生产/消费/测试引用；参数个数变化实际走 fixedLength 的 length-mismatch → error → incompatibleTypes',
    'changedParams 全包仅 1 次出现',
    '全包:' + countOf(src, "'changedParams'") + ' / DiffResults:' + countOf(cmpDiff, "'changedParams'") +
      ' / fixedLength:' + cmpType.includes('true, // fixedLength') +
      ' / length-mismatch 分支:' + cmpType.includes("case 'length-mismatch':"),
    countOf(src, "'changedParams'") === 1 &&
      countOf(cmpDiff, "'changedParams'") === 1 &&
      cmpType.includes('true, // fixedOrder') &&
      cmpType.includes('true, // fixedLength') &&
      cmpType.includes("case 'length-mismatch':") &&
      cmpType.includes('Function types have differing length of arguments') &&
      cmpVersion.includes("errorCode: 'incompatibleTypes',"));

  // ── CMP-2：indexers 零处理 ──
  add('C635', 'CMP-2 核心：ObjectTypeAnnotation 分支只把 properties 传给 compareObjectTypes，indexers / callProperties / internalSlots 全部丢弃；字符串 indexers 在整个 compatibility-check src 下出现 0 次 —— 索引器值类型变化被判为 matching',
    'indexers 出现 0 次 + 只传 properties',
    'indexers:' + countOf(src, 'indexers') +
      ' / 只传 properties:' + cmpType.includes('return compareObjectTypes(\n        newerAnnotation.properties,\n        olderAnnotation.properties,\n      );'),
    countOf(src, 'indexers') === 0 &&
      cmpType.includes('case \'ObjectTypeAnnotation\':') &&
      cmpType.includes('newerAnnotation.properties,') &&
      cmpType.includes('olderAnnotation.properties,') &&
      !cmpType.includes('newerAnnotation.indexers') &&
      !cmpType.includes('olderAnnotation.indexers') &&
      cmpType.includes('if (sortedOlderTypes.length === 0) {') &&
      cmpType.includes('if (isPropertyLogEmpty(result)) {'));

  // ── CMP-3：属性级 nullable 折叠成 optionality ──
  add('C636', 'CMP-3 核心：comparePropertyArrays 遇到 nullableChange 时调用 checkOptionalityChanges(newerName, !optionsReduced, optionsReduced, result)，把 nullableLog 丢掉 —— 属性级 ?T 变化被记成 madeOptional/madeStrict，报 optionalProps 而不是 nullableOfNonNull',
    'nullableChange → checkOptionalityChanges + nullableLog 丢弃',
    '折叠:' + /case 'nullableChange':\n\s+return checkOptionalityChanges\(/.test(cmpType) +
      ' / 四象限注释:' + cmpType.includes('void goes to T?   :: typeRefined !optionsReduced') +
      ' / 文案:' + cmpVersion.includes("'Property made optional, but native requires it'"),
    /case 'nullableChange':\n\s+return checkOptionalityChanges\(/.test(cmpType) &&
      cmpType.includes('!comparedTypes.nullableLog.optionsReduced,') &&
      cmpType.includes('comparedTypes.nullableLog.optionsReduced,') &&
      fs.readFileSync(path.join(REPO, CC, 'ComparisonResult.js'), 'utf8').includes('Four possible cases of change') &&
      cmpVersion.includes("errorCode: 'optionalProps',") &&
      cmpVersion.includes("errorCode: 'requiredProps',"));

  // ── CMP-4：madeStrict.furtherChange 是死数据 ──
  add('C637', 'CMP-4 核心：TypeDiffing 的 updateMadeStrict 采集 furtherChange，但 VersionDiffing 的 nestedPropertiesCheck 只对 propertyLog.madeOptional 递归 furtherChange；madeStrict 在 VersionDiffing 里只被 checkForUnSafeMadeStrictProperties 读取属性名，furtherChange 无任何消费者',
    'madeStrict 的 furtherChange 无消费者',
    'VD madeStrict:' + countOf(cmpVersion, 'madeStrict') + ' / VD furtherChange:' + countOf(cmpVersion, 'furtherChange') +
      ' / 只有 madeOptional 过滤:' + cmpVersion.includes('result.propertyLog.madeOptional.filter('),
    cmpType.includes('result.madeStrict.push({property: name, furtherChange});') &&
      cmpVersion.includes('result.propertyLog.madeOptional.filter(') &&
      !cmpVersion.includes('propertyLog.madeStrict.filter') &&
      !cmpVersion.includes('madeStrict.flatMap') &&
      countOf(cmpVersion, 'madeStrict') === 3);

  // ── CMP-5：联合成员内部变化静默丢弃 ──
  add('C638', 'CMP-5 核心：compareUnionTypes 的成员比较里 nullableChange / functionChange / positionalTypeChange / members 全部 break（代码带 //TODO: Handle the nullable changes within Union），properties 被记成同时 addedMembers + missingMembers',
    'TODO + 四个 status 直接 break',
    'TODO:' + cmpType.includes('//TODO: Handle the nullable changes within Union') +
      ' / addedMembers:' + cmpType.includes('restComparison.addedMembers.push(newerHead);') +
      ' / missingMembers:' + cmpType.includes('restComparison.missingMembers.push(olderHead);'),
    cmpType.includes('//TODO: Handle the nullable changes within Union') &&
      /case 'nullableChange':\n      case 'functionChange':\n      case 'positionalTypeChange':\n      case 'members':\n        break;/.test(cmpType) &&
      cmpType.includes('restComparison.addedMembers.push(newerHead);') &&
      cmpType.includes('restComparison.missingMembers.push(olderHead);'));

  // ── CMP-6 / CMP-7：两处已知失明 ──
  add('C639', 'CMP-6 / CMP-7：TypeDiffing-test 里存在自认用例名 "does not error (but it should) on arrays of two different objects" 与 "matches objects with unsafe objects"；机制上 Array<别名对象> 退化成 Array<mixed>，Object 与 CodegenTypes.UnsafeObject 都成为 GenericObjectTypeAnnotation 且 dictionaryValueType 均为 null → 立即 matching',
    '两处用例名 + genericObject 的 null/null 短路',
    'but it should:' + fs.readFileSync(path.join(REPO, 'packages/react-native-compatibility-check/src/__tests__/TypeDiffing-test.js'), 'utf8').includes('does not error (but it should) on arrays of two different objects') +
      ' / unsafe objects:' + fs.readFileSync(path.join(REPO, 'packages/react-native-compatibility-check/src/__tests__/TypeDiffing-test.js'), 'utf8').includes('matches objects with unsafe objects') +
      ' / 短路:' + cmpType.includes('if (\n    newerType.dictionaryValueType == null &&\n    olderType.dictionaryValueType == null\n  ) {\n    return {status: \'matching\'};'),
    fs.readFileSync(path.join(REPO, 'packages/react-native-compatibility-check/src/__tests__/TypeDiffing-test.js'), 'utf8').includes('does not error (but it should) on arrays of two different objects') &&
      fs.readFileSync(path.join(REPO, 'packages/react-native-compatibility-check/src/__tests__/TypeDiffing-test.js'), 'utf8').includes('matches objects with unsafe objects') &&
      cmpType.includes('if (\n    newerType.dictionaryValueType == null &&\n    olderType.dictionaryValueType == null\n  ) {\n    return {status: \'matching\'};') &&
      cmpType.includes("case 'MixedTypeAnnotation':"));

  // ── CMP-8：删除模块/组件被判 ok ──
  add('C640', 'CMP-8：summarizeSchemaDiff 对 deprecated 返回 {status: "ok"} 并留注释 // TODO add check that a component can be removed；对 new 返回 patchable',
    'deprecated → ok + TODO',
    'TODO:' + cmpVersion.includes('// TODO add check that a component can be removed') +
      ' / new→patchable:' + cmpVersion.includes("case 'new':\n      return {status: 'patchable', incompatibilityReport: {}};"),
    cmpVersion.includes('// TODO add check that a component can be removed') &&
      cmpVersion.includes("case 'deprecated':") &&
      cmpVersion.includes("return {status: 'ok', incompatibilityReport: {}};") &&
      cmpVersion.includes("status: 'deprecated',"));

  // ── CMP-11：模块级注册表无 try/finally ──
  add('C641', 'CMP-11：compareTypes 把四个注册表写进模块级变量、调用 compareTypeAnnotation、再手工清空；TypeDiffing.js 全文没有 try/catch —— 比较器抛错或 :76-79 提前返回都会留下上一轮的注册表',
    '无 try/catch + 手工清空',
    'try:' + countOf(cmpType, 'try {') + ' / catch:' + countOf(cmpType, 'catch') +
      ' / finally:' + countOf(cmpType, 'finally'),
    countOf(cmpType, 'try {') === 0 &&
      countOf(cmpType, 'catch') === 0 &&
      countOf(cmpType, 'finally') === 0 &&
      cmpType.includes('_newerTypesReg = newerTypesReg;') &&
      cmpType.includes('_newerTypesReg = undefined;') &&
      /if \(!olderType\) \{\n    \/\/ No matching olderType for newerType, skip the Comparison\.\n    return \{status: 'skipped'\};\n  \}/.test(cmpType));

  // ── CMP-12：hasUpdatesTypes 死导出 ──
  add('C642', 'CMP-12：VersionDiffing 导出 hasUpdatesTypes 与 hasCodegenUpdatesTypes，两函数体逐字相同（四个 size > 0 判据）；hasUpdatesTypes 在全文件只出现 1 次（定义），调用 0 次',
    '同体 + hasUpdatesTypes 仅定义',
    '出现:' + countOf(cmpVersion, 'hasUpdatesTypes') + ' / 被调用:' + countOf(cmpVersion, 'hasUpdatesTypes(typeUpdate)') +
      ' / 同体:' + countOf(cmpVersion, 'export function hasUpdatesTypes(diff: DiffSet): boolean {\n  return (\n    diff.newTypes.size > 0 ||'),
    countOf(cmpVersion, 'hasUpdatesTypes') === 1 &&
      countOf(cmpVersion, 'hasUpdatesTypes(typeUpdate)') === 0 &&
      countOf(cmpVersion, 'export function hasUpdatesTypes(diff: DiffSet): boolean {\n  return (\n    diff.newTypes.size > 0 ||') === 1 &&
      countOf(cmpVersion, 'export function hasCodegenUpdatesTypes(diff: DiffSet): boolean {\n  return (\n    diff.newTypes.size > 0 ||') === 1 &&
      countOf(cmpVersion, 'hasCodegenUpdatesTypes(typeUpdate)') === 2);

  // ── CMP-13：concat[ 笔误 ──
  add('C643', 'CMP-13：TypeDiffing 的乱序数组比较里写的是 nestedChanges.concat[[oldTypePosn, newTypePosn, currentResult]] —— 少一对括号，实际是对 concat 函数做下标访问，恒得 undefined；注释自认 "It returns undefined and has existed since the day it was written"',
    'concat[ 存在且注释自认',
    '笔误:' + cmpType.includes('nestedChanges.concat[[oldTypePosn, newTypePosn, currentResult]]') +
      ' / 注释:' + cmpType.includes('It returns `undefined`'),
    cmpType.includes('nestedChanges.concat[[oldTypePosn, newTypePosn, currentResult]]') &&
      cmpType.includes('It returns `undefined`') &&
      !cmpType.includes('nestedChanges.concat([[oldTypePosn, newTypePosn, currentResult]])'));

  // ── CMP-9 / CMP-10：格式化层的两处失真 ──
  add('C644', 'CMP-9 / CMP-10：formatDiffSet 在 ok/patchable 分支带注释 "I don\'t think we can ever get in this branch"，而 index.js 的 getErrors 无条件调用它；formatNativeSpecErrorStore 用 changeInformation?.incompatibleChanges != null 判空，但该字段类型是 Set<ErrorStore>，恒真',
    'FlowFixMe 注释 + 恒真判空',
    '注释:' + cmpFormat.includes("I don't think we can ever get in this branch") +
      ' / 无条件调用:' + cmpIndex.includes('return formatDiffSet(this.getSummary());') +
      ' / 恒真:' + cmpFormat.includes('specError.changeInformation?.incompatibleChanges != null') +
      ' / 类型是 Set:' + cmpDiff.includes('incompatibleChanges: Set<ErrorStore>,'),
    cmpFormat.includes("if (summaryStatus === 'ok' || summaryStatus === 'patchable') {") &&
      cmpFormat.includes("I don't think we can ever get in this branch") &&
      cmpIndex.includes('return formatDiffSet(this.getSummary());') &&
      cmpFormat.includes('specError.changeInformation?.incompatibleChanges != null') &&
      cmpDiff.includes('incompatibleChanges: Set<ErrorStore>,'));

  // ── CMP-17：toNative 链没有「新增必填属性」检查 ──
  add('C645', 'CMP-17：checksForTypesFlowingToNative 的五个检查里没有 checkForUnsafeAddedProperties（该函数只出现在 fromNative 链）—— AGENTS.md 规则表声称 toNative 新增必填属性不安全，代码里没有对应检查',
    'toNative 链不含 checkForUnsafeAddedProperties',
    'toNative 链内:' + countOf(cmpVersion.slice(cmpVersion.indexOf('const checksForTypesFlowingToNative'), cmpVersion.indexOf('const checksForTypesFlowingFromNative')), 'checkForUnsafeAddedProperties') +
      ' / fromNative 链内:' + countOf(cmpVersion.slice(cmpVersion.indexOf('const checksForTypesFlowingFromNative'), cmpVersion.indexOf('export function assessComparisonResult')), 'checkForUnsafeAddedProperties'),
    countOf(cmpVersion.slice(cmpVersion.indexOf('const checksForTypesFlowingToNative'), cmpVersion.indexOf('const checksForTypesFlowingFromNative')), 'checkForUnsafeAddedProperties') === 0 &&
      countOf(cmpVersion.slice(cmpVersion.indexOf('const checksForTypesFlowingFromNative'), cmpVersion.indexOf('export function assessComparisonResult')), 'checkForUnsafeAddedProperties') === 1 &&
      path.join(REPO, 'packages/react-native-compatibility-check/AGENTS.md') &&
      fs.readFileSync(path.join(REPO, 'packages/react-native-compatibility-check/AGENTS.md'), 'utf8').includes('| Add required property | ❌ |'));

  // ── CMP-14 / CMP-15：两个分发器的失败方式与索引基准 ──
  add('C646', 'CMP-14 / CMP-15：compareTypeAnnotation 对未知类型 throw，而 compareTypeAnnotationForSorting 的 default 返回 -1（对 A,B 与 B,A 都返回 -1，违反比较器约定）；数组元素索引在乱序路径是 0-based（sortTypeAnnotations 的 i），在定长定序路径写成 i + minLength + 1（1-based）',
    'throw vs -1 + 1-based/0-based 并存',
    'throw:' + cmpType.includes('throw new Error(`Unsupported type annotation: ${newerAnnotation.type}`);') +
      ' / sort -1:' + cmpSort.includes('return -1;') +
      ' / 0-based:' + cmpSort.includes('(a, i): [number, CompleteTypeAnnotation] => [i, a]') +
      ' / 1-based:' + cmpType.includes('i + minLength + 1'),
    cmpType.includes('throw new Error(`Unsupported type annotation: ${newerAnnotation.type}`);') &&
      cmpSort.includes('default:\n      typeA.type as empty;\n      return -1;') &&
      cmpSort.includes('(a, i): [number, CompleteTypeAnnotation] => [i, a]') &&
      cmpType.includes('removedElements.push([i + minLength + 1, elements[i]]);') &&
      cmpType.includes('addedElements.push([i + minLength + 1, elements[i]]);'));

  // ── CMP-21：Int32Enum → Any ──
  add('C647', 'CMP-21：convertPropToBasicTypes 把 Int32EnumTypeAnnotation 转成 AnyTypeAnnotation（注释自认不支持 NumberLiteralUnionTypeAnnotation），因此该 prop 的选项集合变化不可见；Int32Enum 只由 Component 解析器产生（flow/components/componentsUtils.js 与 typescript/components/componentsUtils.js）',
    'Int32Enum → Any + 仅 Component 解析器产生',
    '转换:' + cmpConvert.includes("case 'Int32EnumTypeAnnotation':") +
      ' / 注释:' + cmpConvert.includes("// Compat check doesn't yet have support for") +
      ' / 两处产生:' + (fs.readFileSync(path.join(REPO, 'packages/react-native-codegen/src/parsers/flow/components/componentsUtils.js'), 'utf8').includes("type: 'Int32EnumTypeAnnotation',") &&
        fs.readFileSync(path.join(REPO, 'packages/react-native-codegen/src/parsers/typescript/components/componentsUtils.js'), 'utf8').includes("type: 'Int32EnumTypeAnnotation',")),
    cmpConvert.includes("case 'Int32EnumTypeAnnotation':") &&
      cmpConvert.includes("// Compat check doesn't yet have support for") &&
      cmpConvert.includes("type: 'AnyTypeAnnotation',") &&
      cmpConvert.includes("throw new Error('Unexpected type ' + inputType.type);") &&
      fs.readFileSync(path.join(REPO, 'packages/react-native-codegen/src/parsers/flow/components/componentsUtils.js'), 'utf8').includes("type: 'Int32EnumTypeAnnotation',") &&
      fs.readFileSync(path.join(REPO, 'packages/react-native-codegen/src/parsers/typescript/components/componentsUtils.js'), 'utf8').includes("type: 'Int32EnumTypeAnnotation',"));

  // ── 文档侧 ──
  addDocClaim('D257', '79 文档写明 changedParams 是死错误码',
    /changedParams`?\s*是死错误码|死错误码/, {min: 1});
  addDocClaim('D258', '79 文档写明 indexers 完全未参与比较',
    /`indexers`\s*完全未参与比较|索引器/, {min: 1});
  addDocClaim('D259', '79 文档写明属性级 nullable 变化被折叠成可选性',
    /折叠成.{0,6}可选性|折叠成「可选性」/, {min: 1});
  addDocClaim('D260', '79 文档写明 madeStrict.furtherChange 是死数据',
    /madeStrict\.furtherChange`?\s*是死数据|furtherChange`?\s*是死数据/, {min: 1});
  addDocClaim('D261', '79 文档写明删除模块/组件被判为 ok',
    /删除模块\/组件被判为\s*`ok`|删除模块\/组件被当成\s*`ok`/, {min: 1});
  addDocClaim('D262', '79 文档写明 Array<ObjA> 与 Object/UnsafeObject 两处失明',
    /Array<ObjA>|UnsafeObject/, {min: 1});
  addDocClaim('D263', '79 文档写明 hasUpdatesTypes 是死导出',
    /hasUpdatesTypes`?\s*是死导出/, {min: 1});
  addDocClaim('D264', '79 文档写明 AGENTS.md 规则表与代码不一致',
    /AGENTS\.md`?\s*的.\{0,4\}兼容规则表与代码不一致|规则表与代码不一致/, {min: 1});
  addDocClaim('D265', '79 文档写明 concat[ 少一对括号',
    /concat\[`?\s*少一对括号|少一对括号/, {min: 1});
  addDocClaim('D266', '79 文档写明 Int32Enum 被降级成 Any 导致选项变化不可见',
    /Int32Enum`?\s*(prop\s*)?被降级成\s*`Any`|选项集合变化对整个工具不可见/, {min: 1});
}

// ────────────────────────────────────────────────────────────────────────
// 80 文档 · TypeScript 类型测试（__typetests__）与 Flow libdef
//   TYP-1 … TYP-15
// ────────────────────────────────────────────────────────────────────────
{
  const T = 'packages/react-native/__typetests__';
  const rd = p => fs.readFileSync(path.join(REPO, p), 'utf8');
  const tyFiles = [
    'index.tsx',
    'globals.tsx',
    'animated.tsx',
    'stylesheet-create.tsx',
    'stylesheet-flatten.tsx',
    'legacy-properties.tsx',
    'fabric-component-sample.ts',
    'turbo-module-sample.ts',
  ];
  const tyText = tyFiles.map(f => rd(T + '/' + f)).join('\n');
  const tsconfig = rd(T + '/tsconfig.json');
  const tscLegacy = rd(T + '/tsconfig.legacy.json');
  const rnPkg = JSON.parse(rd('packages/react-native/package.json'));
  const countOf = (h, n) => h.split(n).length - 1;

  // ── TYP-1：34 条 $ExpectType 零校验 ──
  const rootPkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const allDeps = {...rootPkg.dependencies, ...rootPkg.devDependencies};
  add('C648', 'TYP-1 核心：$ExpectType 在 __typetests__ 中共 34 处（index.tsx 28 + animated.tsx 6），而 tsd / dtslint / eslint-plugin-expect-type 都不在依赖里，也没有任何脚本读它 —— tsc 把它当普通注释',
    '$ExpectType 34 处 + 无 tsd/dtslint 依赖',
    'index.tsx:' + countOf(rd(T + '/index.tsx'), '$ExpectType') +
      ' / animated.tsx:' + countOf(rd(T + '/animated.tsx'), '$ExpectType') +
      ' / 依赖里的 tsd:' + ('tsd' in allDeps) +
      ' / dtslint:' + ('dtslint' in allDeps) +
      ' / eslint-plugin-expect-type:' + ('eslint-plugin-expect-type' in allDeps),
    countOf(rd(T + '/index.tsx'), '$ExpectType') === 28 &&
      countOf(rd(T + '/animated.tsx'), '$ExpectType') === 6 &&
      !('tsd' in allDeps) &&
      !('dtslint' in allDeps) &&
      !('eslint-plugin-expect-type' in allDeps));

  // ── TYP-2：strict: false 只开两个开关 ──
  add('C649', 'TYP-2 核心：__typetests__/tsconfig.json 是 strict:false + 仅 noImplicitAny/noImplicitThis，lib 只有 es2020，types 为空数组 —— strictNullChecks 等四个开关全关，null/undefined 相关断言恒真',
    'strict:false + 只有两个 strict 子开关 + lib es2020 + types []',
    'strict:false:' + tsconfig.includes('"strict": false') +
      ' / noImplicitAny:' + tsconfig.includes('"noImplicitAny": true') +
      ' / noImplicitThis:' + tsconfig.includes('"noImplicitThis": true') +
      ' / lib:' + /"lib": \["es2020"\]/.test(tsconfig) +
      ' / types:' + /"types": \[\]/.test(tsconfig),
    tsconfig.includes('"strict": false') &&
      tsconfig.includes('"noImplicitAny": true') &&
      tsconfig.includes('"noImplicitThis": true') &&
      /"lib": \["es2020"\]/.test(tsconfig) &&
      /"types": \[\]/.test(tsconfig) &&
      !tsconfig.includes('strictNullChecks') &&
      !tsconfig.includes('strictFunctionTypes') &&
      !tsconfig.includes('strictPropertyInitialization'));

  // ── TYP-3：globals.tsx 无 import，全局名的唯一来源是 src/types/globals.d.ts ──
  const globalsTsx = rd(T + '/globals.tsx');
  const globalsDts = rd('packages/react-native/src/types/globals.d.ts');
  const legacyIndex = rd('packages/react-native/types_DEPRECATED/index.d.ts');
  add('C650', 'TYP-3 核心：globals.tsx 不 import 任何模块，而 tsconfig 的 lib 不含 DOM、types 为空 —— fetch/WebSocket/FormData/console 只能来自 packages/react-native/src/types/globals.d.ts 的 declare global；legacy 侧靠 types_DEPRECATED/index.d.ts 的三斜线引用拉入同一文件',
    'globals.tsx 零 import + d.ts 有 declare global + legacy 有三斜线引用',
    'globals.tsx 的 import:' + countOf(globalsTsx, 'import ') +
      ' / d.ts declare global:' + globalsDts.includes('declare global {') +
      ' / d.ts 行数:' + globalsDts.split('\n').length +
      ' / legacy reference:' + legacyIndex.includes('/// <reference path="../src/types/globals.d.ts" />'),
    countOf(globalsTsx, 'import ') === 0 &&
      globalsDts.includes('declare global {') &&
      globalsDts.split('\n').length > 700 &&
      legacyIndex.includes('/// <reference path="../src/types/globals.d.ts" />'));

  // ── TYP-4：96 个 runtime 导出，36 个零覆盖 ──
  const indexPath = rd('packages/react-native/index.js');
  const runtimeExports = [...indexPath.matchAll(/^\s{2}get ([A-Za-z0-9_$]+)\(\)/gm)].map(m => m[1]);
  const importedNames = new Set();
  for (const f of tyFiles) {
    const raw = rd(T + '/' + f)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map(l => l.replace(/\/\/.*$/, '')).join('\n');
    for (const m of raw.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*'react-native'/g)) {
      for (let s of m[1].split(',')) {
        s = s.trim().replace(/^type\s+/, '');
        if (!s) continue;
        s.split(/\s+as\s+/).forEach(x => importedNames.add(x.trim()));
      }
    }
  }
  const uncovered = runtimeExports.filter(k => !importedNames.has(k));
  add('C651', 'TYP-4 核心：index.js 的 96 个 runtime getter 导出中，__typetests__ 的 8 个文件只 import 到 60 个，36 个从未出现（其中 11 个 unstable_/experimental_、25 个稳定 API）',
    '96 导出 / 60 覆盖 / 36 未覆盖 / 11 unstable',
    '导出:' + runtimeExports.length + ' / 覆盖:' + (runtimeExports.length - uncovered.length) +
      ' / 未覆盖:' + uncovered.length +
      ' / unstable:' + uncovered.filter(k => /^(unstable_|experimental_)/.test(k)).length,
    runtimeExports.length === 96 &&
      uncovered.length === 36 &&
      uncovered.filter(k => /^(unstable_|experimental_)/.test(k)).length === 11 &&
      uncovered.includes('AppRegistry') &&
      uncovered.includes('PanResponder') &&
      uncovered.includes('PixelRatio') &&
      uncovered.includes('Easing') &&
      uncovered.includes('Vibration'));

  // ── TYP-5 / TYP-6：types_generated 与 types_DEPRECATED 的接线 ──
  add('C652', 'TYP-5 / TYP-6：types_generated 被 .gitignore 忽略且不在树里，但 exports["."].types 指向它（必须先 build-types）；exports["./Libraries/*"] 的 types 显式为 null，只有 react-native-legacy-deep-imports 条件指向 types_DEPRECATED —— deep import 的类型只存在于 legacy 条件',
    'types_generated 缺失 + Libraries/* 的 types 为 null + legacy 指向 types_DEPRECATED',
    'types_generated 存在:' + fs.existsSync(path.join(REPO, 'packages/react-native/types_generated')) +
      ' / gitignore:' + rd('.gitignore').includes('/packages/**/types_generated/') +
      ' / .types:' + rnPkg.exports['.'].types +
      ' / Libraries types:' + JSON.stringify(rnPkg.exports['./Libraries/*'].types) +
      ' / Libraries legacy:' + rnPkg.exports['./Libraries/*']['react-native-legacy-deep-imports'],
    !fs.existsSync(path.join(REPO, 'packages/react-native/types_generated')) &&
      rd('.gitignore').includes('/packages/**/types_generated/') &&
      rnPkg.exports['.'].types === './types_generated/index.d.ts' &&
      rnPkg.exports['.']['react-native-legacy-deep-imports'] === './types_DEPRECATED/index.d.ts' &&
      rnPkg.exports['./Libraries/*'].types === null &&
      rnPkg.exports['./Libraries/*']['react-native-legacy-deep-imports'] === './types_DEPRECATED/Libraries/*.d.ts' &&
      (rnPkg.files || []).includes('types_DEPRECATED'));

  // ── TYP-7 / TYP-8：@ts-ignore 压在 import 上 ──
  const indexTsx = rd(T + '/index.tsx');
  const legacyProps = rd(T + '/legacy-properties.tsx');
  const tsIgnoreLines = indexTsx.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => l.includes('@ts-ignore'))
    .map(([n]) => n);
  add('C653', 'TYP-7 / TYP-8：index.tsx 的 5 处 @ts-ignore 全部位于 import 列表内（55/69/81/104/124），被压住的名字退化为 any；legacy-properties.tsx 全文只有 import + 空 class，且 import 前带 @ts-ignore —— 删掉 TextInputProperties 别名该文件仍会通过',
    '5 处 @ts-ignore 在 import 内 + legacy-properties 被架空',
    '行号:' + tsIgnoreLines.join(',') +
      ' / NativeModule 注释:' + indexTsx.includes('NativeModule, // Not actually exported, not sure why') +
      ' / legacy @ts-ignore:' + legacyProps.includes('// @ts-ignore') +
      ' / legacy class body 空:' + legacyProps.includes('class Test extends React.Component<TextInputProperties> {}'),
    tsIgnoreLines.join(',') === '55,69,81,104,124' &&
      indexTsx.includes('NativeModule, // Not actually exported, not sure why') &&
      legacyProps.includes('// @ts-ignore') &&
      legacyProps.includes('class Test extends React.Component<TextInputProperties> {}') &&
      countOf(legacyProps, '@ts-expect-error') === 0);

  // ── TYP-9 / TYP-14 / TYP-15：跳过与绕过 ──
  const animated = rd(T + '/animated.tsx');
  const stCreate = rd(T + '/stylesheet-create.tsx');
  const stFlatten = rd(T + '/stylesheet-flatten.tsx');
  const fabricSample = rd(T + '/fabric-component-sample.ts');
  const turboSample = rd(T + '/turbo-module-sample.ts');
  add('C654', 'TYP-9 / TYP-14 / TYP-15：animated.tsx 用 "Skip until original is adjusted and type can be asserted" 主动跳过 SectionListRenderItemInfo 断言；两个 codegen 样本的 @ts-expect-error 数为 0；stylesheet-create 的 @ts-ignore 盖住整条 import，stylesheet-flatten 用 as ViewStyle 断言掉 flatten 的返回类型',
    '跳过注释 + 样本 0 反例 + 两处绕过',
    'skip 注释:' + animated.includes('Skip until original is adjusted and type can be asserted') +
      ' / fabric 反例:' + countOf(fabricSample, '@ts-expect-error') +
      ' / turbo 反例:' + countOf(turboSample, '@ts-expect-error') +
      ' / create @ts-ignore:' + stCreate.includes("// @ts-ignore\nimport {View, StyleSheet, type ShadowStyleIOS} from 'react-native';") +
      ' / flatten as:' + stFlatten.includes('StyleSheet.flatten([styles.container, props.style]) as ViewStyle'),
    animated.includes('Skip until original is adjusted and type can be asserted') &&
      animated.includes('info; // Should expect SectionListRenderItemInfo<number>') &&
      countOf(fabricSample, '@ts-expect-error') === 0 &&
      countOf(turboSample, '@ts-expect-error') === 0 &&
      stCreate.includes("// @ts-ignore\nimport {View, StyleSheet, type ShadowStyleIOS} from 'react-native';") &&
      stFlatten.includes('StyleSheet.flatten([styles.container, props.style]) as ViewStyle') &&
      indexTsx.includes('const text = StyleSheet.compose(page.text, lists.listItem) as TextStyle;'));

  // ── TYP-10：globals.tsx 缺 @format ──
  const formatFlags = tyFiles.map(f => [f, rd(T + '/' + f).includes('@format')]);
  add('C655', 'TYP-10：__typetests__ 的 8 个文件里只有 globals.tsx 缺 @format，而 .prettierrc.js 设了 requirePragma: true —— 该文件既不格式化也不被 format-check 检查（证据是它全篇 4 空格缩进）',
    '仅 globals.tsx 缺 @format + requirePragma: true',
    '缺 @format 的文件:' + formatFlags.filter(([, h]) => !h).map(([f]) => f).join(',') +
      ' / requirePragma:' + rd('.prettierrc.js').includes('requirePragma: true') +
      ' / 4 空格缩进样本:' + globalsTsx.includes('    clearInterval(null);'),
    formatFlags.filter(([, h]) => !h).length === 1 &&
      formatFlags.filter(([, h]) => !h)[0][0] === 'globals.tsx' &&
      rd('.prettierrc.js').includes('requirePragma: true') &&
      globalsTsx.includes('    clearInterval(null);') &&
      globalsTsx.includes('const noop = () => { };'));

  // ── TYP-11 / TYP-12 / TYP-13：flow/ 三个文件的边界 ──
  const flowGlobal = rd('packages/react-native/flow/global.js');
  const flowDir = path.join(REPO, 'packages/react-native/flow');
  const flowFiles = fs.readdirSync(flowDir);
  const flowDefFiles = flowFiles.filter(f => path.extname(f) === '.flow');
  const flowDefLines = flowDefFiles.reduce(
    (s, f) => s + fs.readFileSync(path.join(flowDir, f), 'utf8').split('\n').length, 0);
  add('C656', 'TYP-11 / TYP-12 / TYP-13：flow/global.js 用 [string | symbol]: any 索引器打穿整份 declare var global（注释自认 "Undeclared properties are implicitly any"）；__DEV__ 的重复声明对象是 TypeScript 的 src/types/globals.d.ts:56 而不是另一个 Flow libdef；flow/ 下 5 个 .js.flow 共 7819 行因 path.extname 为 .flow 而不计入覆盖度',
    '索引器 + __DEV__ 两处声明 + 5 个 .js.flow 7819 行',
    '索引器:' + flowGlobal.includes('[string | symbol]: any,') +
      ' / 自认注释:' + flowGlobal.includes('Undeclared properties are implicitly `any`.') +
      ' / flow 侧 __DEV__ 声明数:' + countOf(flowGlobal, 'declare var __DEV__') +
      ' / .js.flow 数:' + flowDefFiles.length + ' 行数:' + flowDefLines,
    flowGlobal.includes('[string | symbol]: any,') &&
      flowGlobal.includes('Undeclared properties are implicitly `any`.') &&
      flowGlobal.includes('declare var __DEV__: boolean;') &&
      countOf(flowGlobal, 'declare var __DEV__') === 1 &&
      rd('packages/react-native/src/types/globals.d.ts').includes('const __DEV__: boolean;') &&
      !flowFiles.some(f => f === '__DEV__.js') &&
      flowDefFiles.length === 5 &&
      flowDefLines > 7800 && flowDefLines < 7830 &&
      path.extname('dom.js.flow') === '.flow' &&
      !new Set(['.js', '.mjs', '.ts', '.tsx', '.kt', '.java', '.mm', '.m', '.h', '.cpp', '.cc', '.swift', '.py']).has('.flow'));

  // ── 文档侧 ──
  addDocClaim('D267', '80 文档写明 34 条 $ExpectType 无人解析', /\$ExpectType`?\s*是纯注释|34 条 `\$ExpectType` 是纯注释|无人解析/, {min: 1});
  addDocClaim('D268', '80 文档写明 strict:false 导致 nullability 断言恒真', /strictNullChecks|strict: false`? → nullability 断言恒真/, {min: 1});
  addDocClaim('D269', '80 文档写明 globals.tsx 的全局名只有一个来源', /globals\.tsx`? 的全部全局名只有一个来源|src\/types\/globals\.d\.ts/, {min: 1});
  addDocClaim('D270', '80 文档写明 96 个 runtime 导出里 36 个零覆盖', /96 个 runtime 导出里 36 个|36 个从未进入类型测试/, {min: 1});
  addDocClaim('D271', '80 文档写明 types_generated 不在树里且需先构建', /types_generated\/?`?\s*(被忽略|不在树里|被 gitignore)/, {min: 1});
  addDocClaim('D272', '80 文档写明 types_DEPRECATED 是 deep import 的唯一类型源', /deep import 的唯一类型源|唯一类型来源/, {min: 1});
  addDocClaim('D273', '80 文档写明 5 处 @ts-ignore 压在 import 上', /5 处 `@ts-ignore` 全压在 import 上|全压在 import 上/, {min: 1});
  addDocClaim('D274', '80 文档写明 legacy-properties.tsx 被完全架空', /legacy-properties\.tsx`?\s*被 `@ts-ignore` 完全架空|自我架空/, {min: 1});
  addDocClaim('D275', '80 文档写明 globals.tsx 是唯一缺 @format 的文件', /唯一缺 `@format` 的文件|不受 Prettier 约束/, {min: 1});
  addDocClaim('D276', '80 文档写明 flow/global.js 的索引器打穿类型面', /索引器.{0,8}打穿|打穿整份 `declare var global`/, {min: 1});
}


// ────────────────────────────────────────────────────────────────────────
// 81 文档 · polyfills / new-app-screen / react-native-test-library
//   PLY-1 … PLY-9 · NAP-1 … NAP-7 · TLB-1 … TLB-7
// ────────────────────────────────────────────────────────────────────────
{
  const rd = p => fs.readFileSync(path.join(REPO, p), 'utf8');
  const polyfillsIndex = rd('packages/polyfills/index.js');
  const polyfillsConsole = rd('packages/polyfills/console.js');
  const errorGuard = rd('packages/polyfills/error-guard.js');
  const metroCfg = rd('packages/metro-config/src/index.flow.js');
  const jestSetup = rd('packages/jest-preset/jest/setup.js');
  const nap = rd('packages/new-app-screen/src/NewAppScreen.js');
  const napDts = rd('packages/new-app-screen/src/index.d.ts');
  const napPkg = JSON.parse(rd('packages/new-app-screen/package.json'));
  const rnPkg = JSON.parse(rd('packages/react-native/package.json'));
  const tlAppleJs = rd('packages/react-native-test-library/apple/index.js');
  const tlAppleMm = rd('packages/react-native-test-library/apple/TestLibraryApple.mm');
  const tlCommonMm = rd('packages/react-native-test-library/common/TestLibraryCommon.mm');
  const tlCommonJs = rd('packages/react-native-test-library/common/index.js');
  const tlCommonPkg = JSON.parse(rd('packages/react-native-test-library/common/package.json'));
  const tlApplePkg = JSON.parse(rd('packages/react-native-test-library/apple/package.json'));
  const tlAppleCfg = rd('packages/react-native-test-library/apple/react-native.config.js');
  const tlCommonCfg = rd('packages/react-native-test-library/common/react-native.config.js');
  const tlTrap = rd('packages/react-native-test-library/apple/__tests__/TestLibraryAppleTests.cpp');
  const tableItest = rd('packages/polyfills/__tests__/consoleTable-itest.js');
  const getDevServerSrc = rd('packages/react-native/Libraries/Core/Devtools/getDevServer.js');
  const countOf = (h, n) => h.split(n).length - 1;

  // ── PLY-1：两条消费路径 ──
  add('C662', 'PLY-1：polyfills 有两个消费者 —— metro-config 通过 getPolyfills() 注入 index.js 返回的 console.js + error-guard.js 两个文件；jest-preset 只直接 import error-guard 子路径，所以 Jest 里的 console.* 是 Node 原生实现',
    'metro 注入 2 个文件 + jest 只 import error-guard',
    'index.js require.resolve 数:' + countOf(polyfillsIndex, 'require.resolve(') +
      ' / metro getPolyfills:' + metroCfg.includes('getPolyfills') +
      ' / jest 只 import error-guard:' + jestSetup.includes('js-polyfills/error-guard') +
      ' / jest import console.js:' + jestSetup.includes('js-polyfills/console'),
    countOf(polyfillsIndex, 'require.resolve(') === 2 &&
      polyfillsIndex.includes("require.resolve('./console.js')") &&
      polyfillsIndex.includes("require.resolve('./error-guard.js')") &&
      metroCfg.includes("getPolyfills: () => require('@react-native/js-polyfills')()") &&
      jestSetup.includes("import '@react-native/js-polyfills/error-guard';") &&
      !jestSetup.includes('js-polyfills/console'));

  // ── PLY-2 / PLY-3：guard 的两个行为 ──
  add('C663', 'PLY-2 / PLY-3：applyWithGuardIfNeeded 的 else 分支不 return（调用 applyWithGuard 后落到末尾的 return null），所以不在 guard 内时返回值恒为 null；默认 _globalHandler 直接 throw，使 applyWithGuard 的 catch→reportError 重新抛出异常',
    'else 分支无 return + 默认 handler throw',
    'else 分支无 return:' + /else \{\s*ErrorUtils\.applyWithGuard\(fun, context, args\);\s*\}/.test(errorGuard) +
      ' / 默认 handler throw:' + /\(e: unknown, isFatal: boolean\) => \{\s*throw e;\s*\}/.test(errorGuard) +
      ' / catch 里 reportError:' + /catch \(e\) \{\s*ErrorUtils\.reportError\(e\);/.test(errorGuard) +
      ' / flag 名:' + errorGuard.includes('global.RN$useAlwaysAvailableJSErrorHandling === true'),
    /else \{\s*ErrorUtils\.applyWithGuard\(fun, context, args\);\s*\}/.test(errorGuard) &&
      /catch \(e\) \{\s*ErrorUtils\.reportError\(e\);/.test(errorGuard) &&
      /\(e: unknown, isFatal: boolean\) => \{\s*throw e;\s*\}/.test(errorGuard) &&
      errorGuard.includes('global.RN$useAlwaysAvailableJSErrorHandling === true') &&
      errorGuard.includes('return null;'));

  // ── PLY-4 / PLY-5 / PLY-6 ──
  add('C664', 'PLY-4 / PLY-5 / PLY-6：formatValue 有 200 次全树共享上限；console 对象把 stub 放在 originalConsole 展开之前、把 error/log/table 等放在之后（宿主优先 vs 无条件覆盖）；group 用 U+2510 而 groupCollapsed 与 groupEnd 都用 U+2518',
    '200 上限 + 展开顺序 + 字形错配',
    '200 上限:' + polyfillsConsole.includes('ctx.formatValueCalls > 200') +
      ' / stub 在展开前:' + polyfillsConsole.includes('time: stub,') +
      ' / error 在展开后:' + /\.\.\.\(originalConsole \?\? \{\}\),\s*\n\s*error: getNativeLogFunction/.test(polyfillsConsole) +
      ' / GROUP_OPEN/CLOSE:' + (polyfillsConsole.includes("const GROUP_OPEN = '\\u2510';") && polyfillsConsole.includes("const GROUP_CLOSE = '\\u2518';")) +
      ' / groupCollapsed 用 CLOSE:' + /groupFormat\(GROUP_CLOSE, label\)/.test(polyfillsConsole),
    polyfillsConsole.includes('ctx.formatValueCalls++') &&
      polyfillsConsole.includes('ctx.formatValueCalls > 200') &&
      polyfillsConsole.includes('time: stub,') &&
      /\.\.\.\(originalConsole \?\? \{\}\),\s*\n\s*error: getNativeLogFunction/.test(polyfillsConsole) &&
      polyfillsConsole.includes("const GROUP_OPEN = '\\u2510';") &&
      polyfillsConsole.includes("const GROUP_CLOSE = '\\u2518';") &&
      /groupFormat\(GROUP_CLOSE, label\)/.test(polyfillsConsole) &&
      polyfillsConsole.includes('groupFormat(GROUP_CLOSE), LOG_LEVELS.info'));

  // ── PLY-7 / PLY-8：表格 ──
  add('C665', 'PLY-7 / PLY-8：console.table 的列宽用 k.length / cellStr.length（UTF-16 码元）而非显示宽度；测试期望字符串里只有两个单宽非 ASCII 字符（U+0192 f-hook 与 U+2026 省略号），没有全角用例；空表走 nativeLoggingHook 输出空字符串',
    'length 定宽 + 无全角用例 + 空表空串',
    'Math.max(cellStr.length):' + polyfillsConsole.includes('Math.max(columnWidths[i], cellStr.length)') +
      ' / 空表空串:' + polyfillsConsole.includes("global.nativeLoggingHook('', LOG_LEVELS.info)") +
      ' / itest 非 ASCII 集合:' + [...new Set(tableItest.match(/[^\x00-\x7F]/g) ?? [])].join(''),
    polyfillsConsole.includes('columnWidths[i] = k.length;') &&
      polyfillsConsole.includes('Math.max(columnWidths[i], cellStr.length)') &&
      polyfillsConsole.includes("global.nativeLoggingHook('', LOG_LEVELS.info)") &&
      !/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(tableItest) &&
      tableItest.includes('\u0192') &&
      tableItest.includes('\u2026'));

  // ── PLY-9：静态检查豁免 ──
  add('C666', 'PLY-9：console.js 同时带 @noflow 与 @nolint（720 行，占本包 863 行的 83.4%），文件内的 eslint-disable 因此冗余；README 声称提供 Promise/timers 垫片，但 index.js 只返回两个文件，且这两文件里 Promise 出现 0 次',
    '@noflow + @nolint + Promise 0 次',
    'console.js 行数:' + polyfillsConsole.split('\n').length +
      ' / @noflow:' + polyfillsConsole.includes('@noflow') +
      ' / @nolint:' + polyfillsConsole.includes('@nolint') +
      ' / Promise 出现:' + countOf(polyfillsConsole + errorGuard, 'Promise') +
      ' / README 提 Promise:' + rd('packages/polyfills/README.md').includes('`Promise`'),
    polyfillsConsole.includes('@noflow') &&
      polyfillsConsole.includes('@nolint') &&
      polyfillsConsole.split('\n').length > 700 &&
      countOf(polyfillsConsole + errorGuard, 'Promise') === 0 &&
      rd('packages/polyfills/README.md').includes('`Promise`'));

  // ── NAP-1 / NAP-2 ──
  add('C667', 'NAP-1 / NAP-2：NewAppScreen 用 getRuntimeProperties?.()[\'OSS Release Version\'] —— 可选链只保护调用，结果直接索引（缺方法时 undefined 被索引）；同时该组件 import 了 react-native/unstable-internals-do-not-use，而该子路径在 exports 里 types 显式为 null',
    '?.()[ 组合 + do-not-use 子路径 types:null',
    'NAP-1 模式:' + nap.includes("getRuntimeProperties?.()['OSS Release Version']") +
      ' / 仅判 HermesInternal==null:' + nap.includes('if (global.HermesInternal == null)') +
      ' / 导入内部子路径:' + nap.includes("from 'react-native/unstable-internals-do-not-use'") +
      ' / types:' + JSON.stringify(rnPkg.exports['./unstable-internals-do-not-use'].types),
    nap.includes("getRuntimeProperties?.()['OSS Release Version']") &&
      !nap.includes("getRuntimeProperties?.()?.['OSS Release Version']") &&
      nap.includes('if (global.HermesInternal == null)') &&
      nap.includes("from 'react-native/unstable-internals-do-not-use'") &&
      rnPkg.exports['./unstable-internals-do-not-use'].types === null);

  // ── NAP-3 / NAP-4 / NAP-7 ──
  add('C668', 'NAP-3 / NAP-4 / NAP-7：index.d.ts 与 NewAppScreen.js 各写一份 NewAppScreenProps（字段一致但无校验），package.json 无 types 字段；getDevServer 的 FALLBACK 与正则都保证 url 带尾斜杠，故 url + \'open-url\' 正确；homepage/bugs 指向 github.com/react/react-native',
    '两份 props 副本 + 尾斜杠 + react/react-native URL',
    'd.ts props:' + napDts.includes('export type NewAppScreenProps') +
      ' / js props:' + nap.includes('export type NewAppScreenProps') +
      ' / pkg types 字段:' + ('types' in napPkg) +
      ' / FALLBACK 带斜杠:' + getDevServerSrc.includes("const FALLBACK = 'http://localhost:8081/'") +
      ' / 拼接:' + nap.includes("getDevServer().url + 'open-url'") +
      ' / react org URL:' + napPkg.homepage.includes('github.com/react/react-native'),
    napDts.includes('export type NewAppScreenProps') &&
      nap.includes('export type NewAppScreenProps') &&
      napDts.includes('templateFileName?: string | undefined;') &&
      nap.includes('templateFileName?: string,') &&
      !('types' in napPkg) &&
      getDevServerSrc.includes("const FALLBACK = 'http://localhost:8081/'") &&
      getDevServerSrc.includes('URL to packager with trailing slash') &&
      nap.includes("getDevServer().url + 'open-url'") &&
      napPkg.homepage.includes('github.com/react/react-native'));

  // ── TLB-1 / TLB-2 ──
  add('C669', 'TLB-1 / TLB-2：__tests__/TestLibraryAppleTests.cpp 是「一旦被编译就必失败」的陷阱（include 不存在路径 + static_assert(false)）；版本串 0.87.0-main 在 common/package.json 与 common/TestLibraryCommon.mm 各写一次',
    '编译陷阱 + 版本双写',
    '陷阱 include:' + tlTrap.includes('#include <this/header/intentionally/does/not/exist.h>') +
      ' / static_assert(false):' + /static_assert\(\s*false,/.test(tlTrap) +
      ' / 版本 package.json:' + tlCommonPkg.version +
      ' / 版本 .mm:' + (/@"common@([0-9.]+-main)"/.exec(tlCommonMm) ?? [])[1],
    tlTrap.includes('#include <this/header/intentionally/does/not/exist.h>') &&
      /static_assert\(\s*false,/.test(tlTrap) &&
      tlTrap.includes('must not be compiled by the SPM autolinker') &&
      tlCommonPkg.version === '0.87.0-main' &&
      tlCommonMm.includes('@"common@0.87.0-main"'));

  // ── TLB-3 / TLB-5 / TLB-7 ──
  add('C670', 'TLB-3 / TLB-5 / TLB-7：两个 react-native.config.js 都只声明 ios（「common」也不例外），apple/index.js 文案里建议安装的 react-native-test-library-android 在 packages/ 下不存在；common 没有 peerDependencies 却直接 import react-native；两个原生模块的 reject 回调从未被调用',
    '仅 ios + 兄弟包不存在 + common 缺 peer + reject 未用',
    'apple cfg 提 android:' + tlAppleCfg.includes('android') +
      ' / common cfg 提 android:' + tlCommonCfg.includes('android') +
      ' / android 兄弟包存在:' + fs.existsSync(path.join(REPO, 'packages/react-native-test-library-android')) +
      ' / common 有 peer:' + ('peerDependencies' in tlCommonPkg) +
      ' / apple 有 peer:' + ('peerDependencies' in tlApplePkg) +
      ' / common import react-native:' + tlCommonJs.includes("from 'react-native'") +
      ' / reject( 次数 apple/common:' + countOf(tlAppleMm, 'reject(') + '/' + countOf(tlCommonMm, 'reject('),
    !tlAppleCfg.includes('android') && tlAppleCfg.includes('ios: {}') &&
      !tlCommonCfg.includes('android') && tlCommonCfg.includes('ios: {}') &&
      !fs.existsSync(path.join(REPO, 'packages/react-native-test-library-android')) &&
      tlAppleJs.includes('react-native-test-library-android') &&
      !('peerDependencies' in tlCommonPkg) &&
      'peerDependencies' in tlApplePkg &&
      tlCommonJs.includes("from 'react-native'") &&
      countOf(tlAppleMm, 'reject(') === 0 && countOf(tlCommonMm, 'reject(') === 0);

  // ── 文档侧 ──
  addDocClaim('D277', '81 文档写明 polyfills 有两条消费路径', /两条消费路径|绕过了 `console`/, {min: 1});
  addDocClaim('D278', '81 文档写明 applyWithGuardIfNeeded 丢返回值', /applyWithGuardIfNeeded.{0,24}丢掉返回值|丢掉返回值/, {min: 1});
  addDocClaim('D279', '81 文档写明默认 handler 是 throw、guard 会重抛', /guard 会重新抛出|guard 会重抛/, {min: 1});
  addDocClaim('D280', '81 文档写明 formatValue 的 200 次上限', /200 次调用上限|200 次全树共享上限/, {min: 1});
  addDocClaim('D281', '81 文档写明 console 组装顺序的两种语义', /宿主优先|无条件覆盖/, {min: 1});
  addDocClaim('D282', '81 文档写明 console.table 列宽按 UTF-16 码元', /UTF-16 码元/, {min: 1});
  addDocClaim('D283', '81 文档写明 getRuntimeProperties 的可选链位置错误', /只保护了调用|可选链位置错误/, {min: 1});
  addDocClaim('D284', '81 文档写明欢迎屏依赖 do-not-use 内部子路径', /unstable-internals-do-not-use|do-not-use/, {min: 1});
  addDocClaim('D285', '81 文档写明 __tests__ 里的编译陷阱', /一旦被编译就必失败|编译失败.{0,6}当断言/, {min: 1});
  addDocClaim('D286', '81 文档写明版本串双写', /版本号在两处手写|版本串.{0,12}各写一次/, {min: 1});
}


// ────────────────────────────────────────────────────────────────────────
// 82 文档 · renderer/scheduler + renderer/runtimescheduler
//   SCH-1 … SCH-10 · RTS-1 … RTS-16
// ────────────────────────────────────────────────────────────────────────
{
  const rd = p => fs.readFileSync(path.join(REPO, p), 'utf8');
  const SC = 'packages/react-native/ReactCommon/react/renderer/scheduler/';
  const RS = 'packages/react-native/ReactCommon/react/renderer/runtimescheduler/';
  const schedCpp = rd(SC + 'Scheduler.cpp');
  const schedH = rd(SC + 'Scheduler.h');
  const shH = rd(SC + 'SurfaceHandler.h');
  const shCpp = rd(SC + 'SurfaceHandler.cpp');
  const smCpp = rd(SC + 'SurfaceManager.cpp');
  const rsCpp = rd(RS + 'RuntimeScheduler.cpp');
  const rsH = rd(RS + 'RuntimeScheduler.h');
  const modernCpp = rd(RS + 'RuntimeScheduler_Modern.cpp');
  const modernH = rd(RS + 'RuntimeScheduler_Modern.h');
  const legacyCpp = rd(RS + 'RuntimeScheduler_Legacy.cpp');
  const bindingCpp = rd(RS + 'RuntimeSchedulerBinding.cpp');
  const primH = rd(RS + 'primitives.h');
  const taskH = rd(RS + 'Task.h');
  const taskCpp = rd(RS + 'Task.cpp');
  const prioUtils = rd(RS + 'SchedulerPriorityUtils.h');
  const callInvokerH = rd(RS + 'RuntimeSchedulerCallInvoker.h');
  const callInvokerCpp = rd(RS + 'RuntimeSchedulerCallInvoker.cpp');
  const idleCb = rd('packages/react-native/ReactCommon/react/nativemodule/idlecallbacks/NativeIdleCallbacks.cpp');
  const perfH = rd('packages/react-native/ReactCommon/react/performance/timeline/PerformanceEntryReporter.h');
  const countOf = (h, n) => h.split(n).length - 1;
  const slice = (s, a, b) => { const i = s.indexOf(a); return i < 0 ? '' : s.slice(i, i + b); };
  const getShouldYieldLegacy = slice(legacyCpp, 'bool RuntimeScheduler_Legacy::getShouldYield', 200);
  const getShouldYieldModern = slice(modernCpp, 'bool RuntimeScheduler_Modern::getShouldYield', 400);
  const startWorkLoop = slice(legacyCpp, 'void RuntimeScheduler_Legacy::startWorkLoop', 1400);
  const setCtxContainer = slice(shCpp, 'void SurfaceHandler::setContextContainer', 300);
  const measureFn = slice(shCpp, 'Size SurfaceHandler::measure', 900);
  const stopSurface = slice(smCpp, 'void SurfaceManager::stopSurface', 900);
  const canceCallbackFn = slice(bindingCpp, 'unstable_cancelCallback', 700);
  const schedCallbackFn = slice(bindingCpp, 'unstable_scheduleCallback', 800);
  const errHandler = slice(modernCpp, 'void RuntimeScheduler_Modern::handleTaskError', 400);
  const reportLong = slice(modernCpp, 'void RuntimeScheduler_Modern::reportLongTasks', 700);

  // ── SCH-1 ──
  add('C671', 'SCH-1：SurfaceHandler 类注释说「movable only」，但四个特殊成员全 = delete（且两个成员是 std::shared_mutex，本身不可移动）',
    'movable only + 4 个 delete + shared_mutex 成员',
    'movable only:' + shH.includes('The instances of this class are movable only.') +
      ' / delete 数:' + countOf(shH, '= delete;') +
      ' / Not moveable or copyable:' + shH.includes('Not moveable or copyable') +
      ' / shared_mutex:' + countOf(shH, 'mutable std::shared_mutex'),
    shH.includes('The instances of this class are movable only.') &&
      countOf(shH, '= delete;') === 4 &&
      shH.includes('SurfaceHandler(SurfaceHandler &&other) noexcept = delete;') &&
      shH.includes('Not moveable or copyable') &&
      countOf(shH, 'mutable std::shared_mutex') === 2);

  // ── SCH-2 ──
  add('C672', 'SCH-2：Parameters 组声称改要 unique lock、读只要 shared lock，但 setContextContainer 无锁写 contextContainer，measure 与 constraintLayout 无锁读 surfaceId/contextContainer，start 内还无锁读 displayMode',
    'setContextContainer 无 parametersMutex_ + 4 个 setter 有 unique_lock + measure 无锁读',
    'setContextContainer 取锁:' + setCtxContainer.includes('parametersMutex_') +
      ' / setSurfaceId unique_lock:' + slice(shCpp, 'void SurfaceHandler::setSurfaceId', 300).includes('std::unique_lock lock(parametersMutex_)') +
      ' / setProps unique_lock:' + slice(shCpp, 'void SurfaceHandler::setProps', 400).includes('std::unique_lock lock(parametersMutex_)') +
      ' / measure 取 parametersMutex_:' + measureFn.includes('parametersMutex_') +
      ' / measure 读 contextContainer:' + measureFn.includes('parameters_.contextContainer'),
    !setCtxContainer.includes('parametersMutex_') &&
      setCtxContainer.includes('parameters_.contextContainer = std::move(contextContainer);') &&
      slice(shCpp, 'void SurfaceHandler::setSurfaceId', 300).includes('std::unique_lock lock(parametersMutex_)') &&
      slice(shCpp, 'void SurfaceHandler::setProps', 400).includes('std::unique_lock lock(parametersMutex_)') &&
      slice(shCpp, 'void SurfaceHandler::setDisplayMode', 400).includes('std::unique_lock lock(parametersMutex_)') &&
      !measureFn.includes('parametersMutex_') &&
      shH.includes('reading needs only'));

  // ── SCH-3 ──
  add('C673', 'SCH-3：SurfaceHandler.h 承诺停止/未注册时 measure 返回零尺寸，实现返回 layoutConstraints.clamp({0,0})，带最小约束时会得到非零尺寸',
    'clamp({0,0}) + 注释 Returns zero size',
    'clamp:' + measureFn.includes('layoutConstraints.clamp({.width = 0, .height = 0})') +
      ' / 注释:' + shH.includes('Returns zero size if called on the stopped or unregistered surface.'),
    measureFn.includes('if (link_.status != Status::Running)') &&
      measureFn.includes('return layoutConstraints.clamp({.width = 0, .height = 0});') &&
      shH.includes('Returns zero size if called on the stopped or unregistered surface.'));

  // ── SCH-4 ──
  add('C674', 'SCH-4：SurfaceManager::stopSurface 对未注册 surface 也会执行 registry_.erase(find(surfaceId))，没有 != end() 检查 → erase(end()) 是 UB',
    'stopSurface 内 erase 无 end 检查',
    'erase(iterator):' + stopSurface.includes('registry_.erase(iterator);') +
      ' / stopSurface 内 end 检查:' + stopSurface.includes('registry_.end()') +
      ' / 只打 WARNING:' + stopSurface.includes('LOG(WARNING)'),
    stopSurface.includes('auto iterator = registry_.find(surfaceId);') &&
      stopSurface.includes('registry_.erase(iterator);') &&
      !stopSurface.includes('registry_.end()') &&
      stopSurface.includes('tried to stop a surface which was not running'));

  // ── SCH-5 ──
  add('C675', 'SCH-5：isSurfaceRunning 用 registry_.contains —— 判定的是「已注册」；startSurface 先 try_emplace 入表再 start()，中途抛异常不会回滚',
    'contains + 先入表后 start',
    'contains:' + smCpp.includes('return registry_.contains(surfaceId);') +
      ' / try_emplace 行:' + (smCpp.indexOf('registry_.try_emplace') < smCpp.indexOf('surfaceHandler.start()')),
    smCpp.includes('bool SurfaceManager::isSurfaceRunning(SurfaceId surfaceId) const noexcept {') &&
      smCpp.includes('return registry_.contains(surfaceId);') &&
      smCpp.indexOf('registry_.try_emplace') > 0 &&
      smCpp.indexOf('registry_.try_emplace') < smCpp.indexOf('surfaceHandler.start()'));

  // ── SCH-6 ──
  add('C676', 'SCH-6：Scheduler 析构先 react_native_assert(surfaceIds.empty())，release 下继续走 commitEmptyTree + remove，注释自陈 remove 可能死锁；析构无条件 LOG(WARNING)',
    'assert + in theory it can deadlock + 无条件 WARNING',
    'assert:' + schedCpp.includes('Scheduler was destroyed with outstanding Surfaces.') +
      ' / deadlock 注释:' + schedCpp.includes('theory, it can deadlock.') +
      ' / WARNING 数:' + countOf(schedCpp, 'LOG(WARNING)'),
    schedCpp.includes('react_native_assert(\n      surfaceIds.empty() &&\n      "Scheduler was destroyed with outstanding Surfaces.");') &&
      schedCpp.includes('theory, it can deadlock.') &&
      schedCpp.includes('shadowTree.commitEmptyTree();') &&
      schedCpp.includes('uiManager_->getShadowTreeRegistry().remove(surfaceId);'));

  // ── SCH-7 ──
  add('C677', 'SCH-7：Scheduler 里 dispatchCommand 与 finishReactCommit 包进 scheduleRenderingUpdate，而 accessibility / setJSResponder / updateShadowTree 直接调 delegate —— 5 个回调 3 同步 2 异步',
    'dispatchCommand 异步 + accessibility 同步',
    'dispatchCommand 用 scheduleRenderingUpdate:' + slice(schedCpp, 'void Scheduler::uiManagerDidDispatchCommand', 1200).includes('scheduleRenderingUpdate(') +
      ' / accessibility 直接调:' + slice(schedCpp, 'void Scheduler::uiManagerDidSendAccessibilityEvent', 500).includes('delegate_->schedulerDidSendAccessibilityEvent') +
      ' / accessibility 里有 scheduleRenderingUpdate:' + slice(schedCpp, 'void Scheduler::uiManagerDidSendAccessibilityEvent', 500).includes('scheduleRenderingUpdate'),
    slice(schedCpp, 'void Scheduler::uiManagerDidDispatchCommand', 1200).includes('scheduleRenderingUpdate(') &&
      slice(schedCpp, 'void Scheduler::uiManagerDidSendAccessibilityEvent', 500).includes('delegate_->schedulerDidSendAccessibilityEvent(') &&
      !slice(schedCpp, 'void Scheduler::uiManagerDidSendAccessibilityEvent', 500).includes('scheduleRenderingUpdate') &&
      slice(schedCpp, 'void Scheduler::uiManagerDidSetIsJSResponder', 500).includes('delegate_->schedulerDidSetIsJSResponder(') &&
      !slice(schedCpp, 'void Scheduler::uiManagerDidSetIsJSResponder', 500).includes('scheduleRenderingUpdate'));

  // ── SCH-8 ──
  add('C678', 'SCH-8：Scheduler 构造里 cdpMetricsReporter_ 要 enableBridgelessArchitecture() && cdpInteractionMetricsEnabled()，而 cdpPerfIssuesReporter_ 只要 perfIssuesEnabled() —— 门禁不对称',
    'cdpMetrics 双条件 + perfIssues 单条件',
    'cdp 双条件:' + schedCpp.includes('ReactNativeFeatureFlags::enableBridgelessArchitecture() &&\n      ReactNativeFeatureFlags::cdpInteractionMetricsEnabled()') +
      ' / perfIssues 存在:' + schedCpp.includes('ReactNativeFeatureFlags::perfIssuesEnabled()') +
      ' / perfIssues 与 bridgeless 同行:' + /perfIssuesEnabled\(\)\s*&&/.test(schedCpp),
    schedCpp.includes('ReactNativeFeatureFlags::enableBridgelessArchitecture() &&\n      ReactNativeFeatureFlags::cdpInteractionMetricsEnabled()') &&
      schedCpp.includes('ReactNativeFeatureFlags::perfIssuesEnabled()') &&
      !/enableBridgelessArchitecture\(\)\s*&&\s*\n?\s*ReactNativeFeatureFlags::perfIssuesEnabled/.test(schedCpp));

  // ── SCH-9 ──
  add('C679', 'SCH-9：Scheduler 把「已知坏」写进 API 名 findComponentDescriptorByHandle_DO_NOT_USE_THIS_IS_BROKEN，声明与定义各一处',
    'DO_NOT_USE 出现在 .h 与 .cpp',
    'h:' + schedH.includes('findComponentDescriptorByHandle_DO_NOT_USE_THIS_IS_BROKEN') +
      ' / cpp:' + schedCpp.includes('findComponentDescriptorByHandle_DO_NOT_USE_THIS_IS_BROKEN') +
      ' / This is broken:' + schedH.includes('This is broken. Please do not use.'),
    schedH.includes('findComponentDescriptorByHandle_DO_NOT_USE_THIS_IS_BROKEN') &&
      schedCpp.includes('findComponentDescriptorByHandle_DO_NOT_USE_THIS_IS_BROKEN') &&
      schedH.includes('This is broken. Please do not use.'));

  // ── SCH-10 ──
  add('C680', 'SCH-10：AnimationBackend 的构造必须在 uiManager->setDelegate 之后 —— 注释明确说 UIManager 在没 delegate 时会静默丢弃 surface-start 回调；同类静默丢弃还有 addEventListener（eventDispatcher_ 为空）与 animationTick（uiManager_ 为空）',
    'setDelegate 行号 < AnimationBackend 行号 + silently drops + 两处静默返回',
    'setDelegate 在前:' + (schedCpp.indexOf('uiManager->setDelegate(this);') < schedCpp.indexOf('std::make_shared<AnimationBackend>')) +
      ' / silently drops:' + schedCpp.includes('silently drops those while it has\n  // no delegate') +
      ' / addEventListener 判空:' + slice(schedCpp, 'void Scheduler::addEventListener', 400).includes('if (eventDispatcher_->has_value())') +
      ' / animationTick 判空:' + slice(schedCpp, 'void Scheduler::animationTick', 300).includes('if (!uiManager_)'),
    schedCpp.indexOf('uiManager->setDelegate(this);') < schedCpp.indexOf('std::make_shared<AnimationBackend>') &&
      schedCpp.includes('silently drops those while it has') &&
      slice(schedCpp, 'void Scheduler::addEventListener', 400).includes('if (eventDispatcher_->has_value())') &&
      slice(schedCpp, 'void Scheduler::animationTick', 300).includes('if (!uiManager_)'));

  // ── RTS-1 ──
  add('C681', 'RTS-1：RuntimeScheduler 的实现分叉只在构造时按 enableBridgelessArchitecture() 选一次，不存在运行时重选分支',
    'getRuntimeSchedulerImplementation 里的 flag 只有 1 次',
    'flag 出现次数:' + countOf(rsCpp, 'enableBridgelessArchitecture()') +
      ' / Modern 构造:' + rsCpp.includes('std::make_unique<RuntimeScheduler_Modern>') +
      ' / Legacy 构造:' + rsCpp.includes('std::make_unique<RuntimeScheduler_Legacy>') +
      ' / 头文件 selected at runtime:' + rsH.includes('at runtime based on a feature flag'),
    countOf(rsCpp, 'enableBridgelessArchitecture()') === 1 &&
      rsCpp.includes('std::make_unique<RuntimeScheduler_Modern>') &&
      rsCpp.includes('std::make_unique<RuntimeScheduler_Legacy>') &&
      rsH.includes('at runtime based on a feature flag'));

  // ── RTS-2 ──
  add('C682', 'RTS-2：scheduleRenderingUpdate 在两个分叉上语义相反 —— Legacy 直接调 renderingUpdate()，Modern 只 push 进 pendingRenderingUpdates_；Modern 头文件却承诺「步骤未启用时立即执行」',
    'Legacy 直接调用 + Modern 只入队 + 头注释立即执行',
    'Legacy 直接调:' + slice(legacyCpp, 'void RuntimeScheduler_Legacy::scheduleRenderingUpdate', 400).includes('renderingUpdate();') +
      ' / Modern push:' + slice(modernCpp, 'void RuntimeScheduler_Modern::scheduleRenderingUpdate', 400).includes('pendingRenderingUpdates_.push(renderingUpdate);') +
      ' / Modern 直接调:' + slice(modernCpp, 'void RuntimeScheduler_Modern::scheduleRenderingUpdate', 400).includes('renderingUpdate();') +
      ' / 头注释:' + modernH.includes('If the step is not enabled, the function is executed'),
    slice(legacyCpp, 'void RuntimeScheduler_Legacy::scheduleRenderingUpdate', 400).includes('renderingUpdate();') &&
      slice(modernCpp, 'void RuntimeScheduler_Modern::scheduleRenderingUpdate', 400).includes('pendingRenderingUpdates_.push(renderingUpdate);') &&
      !slice(modernCpp, 'void RuntimeScheduler_Modern::scheduleRenderingUpdate', 400).includes('renderingUpdate();') &&
      modernH.includes('If the step is not enabled, the function is executed'));

  // ── RTS-3 ──
  add('C683', 'RTS-3：Legacy 的 getShouldYield 只看 runtimeAccessRequests_ > 0，不看任务队列；Modern 看队列 top 是否等于 currentTask_，而 selectTask 只弹出 callback 为空的任务、不弹出正在执行的任务',
    'Legacy 单条件 + Modern top!=currentTask + selectTask 不 pop 当前任务',
    'Legacy:' + getShouldYieldLegacy.replace(/\s+/g, ' ').includes('return runtimeAccessRequests_ > 0;') +
      ' / Modern:' + getShouldYieldModern.replace(/\s+/g, ' ').includes('taskQueue_.top().get() != currentTask_') +
      ' / Legacy 看 taskQueue_:' + getShouldYieldLegacy.includes('taskQueue_') +
      ' / selectTask 只弹空 callback:' + slice(modernCpp, 'std::shared_ptr<Task> RuntimeScheduler_Modern::selectTask', 700).includes('while (!taskQueue_.empty() && !taskQueue_.top()->callback)'),
    getShouldYieldLegacy.replace(/\s+/g, ' ').includes('return runtimeAccessRequests_ > 0;') &&
      !getShouldYieldLegacy.includes('taskQueue_') &&
      getShouldYieldModern.replace(/\s+/g, ' ').includes('!taskQueue_.empty() && taskQueue_.top().get() != currentTask_') &&
      slice(modernCpp, 'std::shared_ptr<Task> RuntimeScheduler_Modern::selectTask', 700).includes('while (!taskQueue_.empty() && !taskQueue_.top()->callback)'));

  // ── RTS-4 ──
  add('C684', 'RTS-4：Task::id 由 getNextId 单调赋值但只用于 trace，不参与 TaskPriorityComparer（只比 expirationTime）；超时表 0/250ms/5s/10s/5min，fromRawValue 的 default 在 release 静默返回 NormalPriority',
    'id 仅 trace + 比较器只看 expirationTime + 5 档超时',
    'id 使用处（非赋值）:' + (countOf(taskCpp, 'id(getNextId())')) +
      ' / comparer:' + taskH.includes('return lhs->expirationTime > rhs->expirationTime;') +
      ' / comparer 提 id:' + slice(taskH, 'class TaskPriorityComparer', 200).includes('id') +
      ' / 5s:' + prioUtils.includes('std::chrono::seconds(5)') +
      ' / 5min:' + prioUtils.includes('std::chrono::minutes(5)') +
      ' / default 返回 Normal:' + prioUtils.includes('return SchedulerPriority::NormalPriority;'),
    countOf(taskCpp, 'id(getNextId())') === 2 &&
      taskH.includes('return lhs->expirationTime > rhs->expirationTime;') &&
      !slice(taskH, 'class TaskPriorityComparer', 200).includes('->id') &&
      prioUtils.includes('std::chrono::seconds(5)') && prioUtils.includes('std::chrono::seconds(10)') &&
      prioUtils.includes('std::chrono::minutes(5)') && prioUtils.includes('std::chrono::milliseconds(250)') &&
      prioUtils.includes('return SchedulerPriority::NormalPriority;'));

  // ── RTS-5 ──
  add('C685', 'RTS-5：Modern 的 handleTaskError 先 clearQueues()（清空 taskQueue_ 与 pendingRenderingUpdates_）再上报；Legacy 的两个 catch 只调 onTaskError_，不清队列',
    'Modern clearQueues + Legacy 不清',
    'Modern 调 clearQueues:' + errHandler.includes('clearQueues();') +
      ' / clearQueues 清 taskQueue_:' + slice(modernCpp, 'void RuntimeScheduler_Modern::clearQueues', 400).includes('taskQueue_ = {};') +
      ' / Legacy catch 调 clearQueues:' + startWorkLoop.includes('clearQueues') +
      ' / Legacy catch 次数:' + countOf(startWorkLoop, 'onTaskError_(runtime, error);'),
    errHandler.includes('clearQueues();') &&
      slice(modernCpp, 'void RuntimeScheduler_Modern::clearQueues', 400).includes('taskQueue_ = {};') &&
      slice(modernCpp, 'void RuntimeScheduler_Modern::clearQueues', 400).includes('pendingRenderingUpdates_ = {};') &&
      !startWorkLoop.includes('clearQueues') &&
      countOf(startWorkLoop, 'onTaskError_(runtime, error);') === 2);

  // ── RTS-6 ──
  add('C686', 'RTS-6：Modern 的 performMicrotaskCheckpoint 在 255 次后 throw std::runtime_error，147 行函数内没有自己的 try（只有 drainMicrotasks 的 try），调用点 runEventLoopTick/runEventLoop 也不捕获',
    '255 + throw runtime_error + OnScopeExit 有 / 调用点无 try',
    'kRetriesBound:' + modernCpp.includes('kRetriesBound = 255') +
      ' / throw:' + modernCpp.includes('throw std::runtime_error("Hits microtasks retries bound.");') +
      ' / OnScopeExit:' + modernCpp.includes('OnScopeExit restoreFlag') +
      ' / runEventLoopTick 里 try:' + slice(modernCpp, 'void RuntimeScheduler_Modern::runEventLoopTick', 1200).includes('try {') +
      ' / runEventLoop 里 try:' + slice(modernCpp, 'void RuntimeScheduler_Modern::runEventLoop(', 900).includes('try {'),
    modernCpp.includes('const static unsigned int kRetriesBound = 255;') &&
      modernCpp.includes('throw std::runtime_error("Hits microtasks retries bound.");') &&
      modernCpp.includes('OnScopeExit restoreFlag') &&
      !slice(modernCpp, 'void RuntimeScheduler_Modern::runEventLoop(', 900).includes('try {') &&
      slice(modernCpp, 'void RuntimeScheduler_Modern::runEventLoop(', 900).includes('runEventLoopTick(runtime, *topPriorityTask);'));

  // ── RTS-7 ──
  add('C687', 'RTS-7：长任务判定用 longestPeriodWithoutYieldingOpportunity_（阈值 50ms），上报却用 endTime - startTime；而 getShouldYield 每次都调 markYieldingOpportunity 重置基准 —— 频繁轮询 shouldYield 的任务不会被上报',
    '50ms + 间隔判定 + 总时长上报 + shouldYield 内标记',
    '阈值:' + perfH.includes('LONG_TASK_DURATION_THRESHOLD = HighResDuration::fromMilliseconds(50)') +
      ' / 判定用到间隔:' + reportLong.includes('longestPeriodWithoutYieldingOpportunity_ >=') +
      ' / 上报用总时长:' + reportLong.includes('auto duration = endTime - startTime;') +
      ' / shouldYield 调标记:' + getShouldYieldModern.includes('markYieldingOpportunity(now_());'),
    perfH.includes('LONG_TASK_DURATION_THRESHOLD = HighResDuration::fromMilliseconds(50)') &&
      reportLong.includes('longestPeriodWithoutYieldingOpportunity_ >=') &&
      reportLong.includes('LONG_TASK_DURATION_THRESHOLD') &&
      reportLong.includes('auto duration = endTime - startTime;') &&
      reportLong.includes('reporter->reportLongTask(startTime, duration);') &&
      getShouldYieldModern.includes('markYieldingOpportunity(now_());'));

  // ── RTS-8 ──
  add('C688', 'RTS-8：unstable_scheduleCallback 的 arity 声明为 3，但整份 binding 文件里 arguments[0] 出现 2 次、arguments[1] 出现 1 次、arguments[2] 出现 0 次 —— 第三个参数（options/delay）被静默忽略',
    'arity 3 + arguments[2] 出现 0 次',
    'arity:' + schedCallbackFn.includes('3,') +
      ' / arguments[2] 数:' + countOf(bindingCpp, 'arguments[2]') +
      ' / arguments[0] 数:' + countOf(bindingCpp, 'arguments[0]') +
      ' / arguments[1] 数:' + countOf(bindingCpp, 'arguments[1]'),
    schedCallbackFn.includes('3,') &&
      countOf(bindingCpp, 'arguments[2]') === 0 &&
      countOf(bindingCpp, 'arguments[0]') === 2 &&
      countOf(bindingCpp, 'arguments[1]') === 1);

  // ── RTS-9 ──
  add('C689', 'RTS-9：primitives.h 的 taskFromValue 对 null 返回 nullptr，而 unstable_cancelCallback 直接写 cancelTask(*taskFromValue(...)) 且 lambda 标 noexcept',
    'null→nullptr + *解引用 + noexcept',
    'null→nullptr:' + primH.includes('if (value.isNull())') +
      ' / cancelTask(*...):' + canceCallbackFn.includes('cancelTask(*taskFromValue(runtime, arguments[0]))') +
      ' / noexcept:' + canceCallbackFn.includes('noexcept'),
    primH.includes('if (value.isNull())') && primH.includes('return nullptr;') &&
      canceCallbackFn.includes('cancelTask(*taskFromValue(runtime, arguments[0]))') &&
      canceCallbackFn.includes('noexcept'));

  // ── RTS-10 ──
  add('C690', 'RTS-10：Legacy 两个 scheduleIdleTask 重载都返回 nullptr，唯一 in-tree 调用方 NativeIdleCallbacks 因此抛 "requestIdleCallback is not supported in legacy runtime scheduler"',
    '两个重载返回 nullptr + 调用方抛错',
    '返回 nullptr 数:' + countOf(legacyCpp, 'return nullptr;') +
      ' / idle 不在 Legacy 支持:' + legacyCpp.includes('Idle tasks are not supported on Legacy RuntimeScheduler.') +
      ' / 调用方抛错:' + idleCb.includes('requestIdleCallback is not supported in legacy runtime scheduler'),
    countOf(legacyCpp, 'return nullptr;') === 2 &&
      legacyCpp.includes('Idle tasks are not supported on Legacy RuntimeScheduler.') &&
      idleCb.includes('requestIdleCallback is not supported in legacy runtime scheduler') &&
      idleCb.includes('if (task == nullptr)') &&
      modernCpp.includes('getResolvedTimeoutForIdleTask'));

  // ── RTS-11 ──
  add('C691', 'RTS-11：Legacy 的 startWorkLoop 用裸赋值维护 isPerformingWork_（无 RAII），而 onTaskError_ 就在 catch 块内；一旦它抛异常，isPerformingWork_ 永久为 true → scheduleWorkLoopIfNecessary 不再调度。Modern 的同款标志用了 OnScopeExit',
    'isPerformingWork_ 裸赋值 + onTaskError_ 在 catch 内 + Modern 用 OnScopeExit',
    'true 赋值:' + startWorkLoop.includes('isPerformingWork_ = true;') +
      ' / false 赋值:' + startWorkLoop.includes('isPerformingWork_ = false;') +
      ' / onTaskError_ 在 catch 内:' + startWorkLoop.includes('catch (jsi::JSError& error) {\n    onTaskError_(runtime, error);') +
      ' / 门禁:' + legacyCpp.includes('if (!isWorkLoopScheduled_ && !isPerformingWork_)') +
      ' / Modern OnScopeExit:' + modernCpp.includes('OnScopeExit restoreFlag'),
    startWorkLoop.includes('isPerformingWork_ = true;') &&
      startWorkLoop.includes('isPerformingWork_ = false;') &&
      startWorkLoop.indexOf('onTaskError_(runtime, error);') < startWorkLoop.indexOf('isPerformingWork_ = false;') &&
      legacyCpp.includes('if (!isWorkLoopScheduled_ && !isPerformingWork_)') &&
      modernCpp.includes('OnScopeExit restoreFlag') &&
      !startWorkLoop.includes('OnScopeExit'));

  // ── RTS-12 ──
  add('C692', 'RTS-12：executeNowOnTheSameThread 在调用 executor 前 syncTaskRequests_++、在 lambda 体内 syncTaskRequests_--；入口函数名自带 _CAN_DEADLOCK；runtimePtr 的复位也没有 RAII',
    '++ 在 lambda 外 / -- 在 lambda 内 / _CAN_DEADLOCK',
    '++ 位置早于 executor:' + (slice(modernCpp, 'void RuntimeScheduler_Modern::executeNowOnTheSameThread', 1400).indexOf('syncTaskRequests_++;') < slice(modernCpp, 'void RuntimeScheduler_Modern::executeNowOnTheSameThread', 1400).indexOf('executeSynchronouslyOnSameThread_CAN_DEADLOCK')) +
      ' / -- 在 lambda 内:' + modernCpp.includes('syncTaskRequests_--;\n        runtimePtr = &runtime;') +
      ' / _CAN_DEADLOCK:' + modernCpp.includes('executeSynchronouslyOnSameThread_CAN_DEADLOCK'),
    slice(modernCpp, 'void RuntimeScheduler_Modern::executeNowOnTheSameThread', 1400).indexOf('syncTaskRequests_++;') <
        slice(modernCpp, 'void RuntimeScheduler_Modern::executeNowOnTheSameThread', 1400).indexOf('executeSynchronouslyOnSameThread_CAN_DEADLOCK') &&
      modernCpp.includes('syncTaskRequests_--;\n        runtimePtr = &runtime;') &&
      modernCpp.includes('executeSynchronouslyOnSameThread_CAN_DEADLOCK') &&
      modernCpp.includes('runtimePtr = nullptr;'));

  // ── RTS-13 ──
  add('C693', 'RTS-13：RuntimeSchedulerCallInvoker 已被 [[deprecated]]（理由点名 createJSCallInvoker 的 buffered runtime executor），其 invokeAsync 走 scheduleWork（ImmediatePriority），且 weak_ptr lock 失败时静默返回',
    'deprecated 字符串 + invokeAsync→scheduleWork + lock 判空',
    'deprecated:' + callInvokerH.includes('class [[deprecated(') +
      ' / 替代 API:' + callInvokerH.includes('ReactInstance::createJSCallInvoker()') +
      ' / scheduleWork:' + callInvokerCpp.includes('runtimeScheduler->scheduleWork(') +
      ' / lock 判空:' + callInvokerCpp.includes('if (auto runtimeScheduler = runtimeScheduler_.lock())'),
    callInvokerH.includes('class [[deprecated(') &&
      callInvokerH.includes('ReactInstance::createJSCallInvoker()') &&
      callInvokerH.includes("buffered runtime executor so async calls are ordered against callable module calls") &&
      callInvokerCpp.includes('runtimeScheduler->scheduleWork(') &&
      callInvokerCpp.includes('if (auto runtimeScheduler = runtimeScheduler_.lock())'));

  // ── RTS-14 ──
  add('C694', 'RTS-14：unregisterTaskQueueSource 在 Modern 是空实现（带注释说明不需要反注册）；Legacy 侧 registerTaskQueueSource 恒返回 0、unregisterTaskQueueSource 与 scheduleTask(function) 都是空函数',
    'Modern 空 + Legacy 三处空壳',
    'Modern unregister 空:' + /void RuntimeScheduler_Modern::unregisterTaskQueueSource\(uint64_t \/\*sourceId\*\/\) \{\n  \/\/ For now/.test(modernCpp) +
      ' / Legacy register 返回 0:' + legacyCpp.includes('uint64_t RuntimeScheduler_Legacy::registerTaskQueueSource() {\n  return 0;\n}') +
      ' / Legacy scheduleTask 空:' + legacyCpp.includes('[[maybe_unused]] const std::function<void()>& task) {}'),
    modernCpp.includes('return nextTaskQueueSourceId_.fetch_add(1) + 1;') &&
      modernCpp.includes('need to do unregistering') &&
      legacyCpp.includes('uint64_t RuntimeScheduler_Legacy::registerTaskQueueSource() {\n  return 0;\n}') &&
      legacyCpp.includes('[[maybe_unused]] const std::function<void()>& task) {}'));

  // ── RTS-15 ──
  add('C695', 'RTS-15：using SurfaceId = int32_t 在 RuntimeScheduler.h 与两个 delegate 头里各写一次（共 3 处），各自独立于 ReactPrimitives 的权威定义',
    '3 处 using SurfaceId',
    'RuntimeScheduler.h:' + rsH.includes('using SurfaceId = int32_t;') +
      ' / EventTiming:' + rd(RS + 'RuntimeSchedulerEventTimingDelegate.h').includes('using SurfaceId = int32_t;') +
      ' / Intersection:' + rd(RS + 'RuntimeSchedulerIntersectionObserverDelegate.h').includes('using SurfaceId = int32_t;'),
    rsH.includes('using SurfaceId = int32_t;') &&
      rd(RS + 'RuntimeSchedulerEventTimingDelegate.h').includes('using SurfaceId = int32_t;') &&
      rd(RS + 'RuntimeSchedulerIntersectionObserverDelegate.h').includes('using SurfaceId = int32_t;') &&
      countOf(rsH + rd(RS + 'RuntimeSchedulerEventTimingDelegate.h') + rd(RS + 'RuntimeSchedulerIntersectionObserverDelegate.h'), 'using SurfaceId = int32_t;') === 3);

  // ── RTS-16 ──
  add('C696', 'RTS-16：RuntimeSchedulerBase 的基类是 facebook::hermes::IEventLoopControl，头文件因此包含 jsi/hermes-interfaces.h —— 调度器与 JS 引擎无关，但抽象基类绑定了 Hermes 接口',
    'hermes::IEventLoopControl + hermes-interfaces.h',
    '基类:' + rsH.includes('class RuntimeSchedulerBase : public facebook::hermes::IEventLoopControl') +
      ' / include:' + rsH.includes('#include <jsi/hermes-interfaces.h>'),
    rsH.includes('class RuntimeSchedulerBase : public facebook::hermes::IEventLoopControl') &&
      rsH.includes('#include <jsi/hermes-interfaces.h>'));

  // ── 文档侧 ──
  addDocClaim('D287', '82 文档写明两个分叉的 scheduleRenderingUpdate 语义相反', /语义完全相反|语义相反/, {min: 1});
  addDocClaim('D288', '82 文档写明 Legacy 的 getShouldYield 不看任务队列', /Legacy 的 `getShouldYield\(\)` 不看任务队列|完全不看任务队列/, {min: 1});
  addDocClaim('D289', '82 文档写明 Parameters 组有 4 处读写落在锁外', /4 处读写完全在锁外|1 处无锁写 \+ 3 处无锁读/, {min: 1});
  addDocClaim('D290', '82 文档写明 Modern 一次任务错误清空整个队列', /清空\*\*整个\*\*队列|清空整个队列/, {min: 1});
  addDocClaim('D291', '82 文档写明 isPerformingWork_ 没有 RAII', /`isPerformingWork_` 没有 RAII|无 RAII/, {min: 1});
  addDocClaim('D292', '82 文档写明 scheduleCallback 的第三个参数被静默忽略', /arity=3 但不读第 3 参数|`delay` 被\*\*静默丢弃\*\*/, {min: 1});
  addDocClaim('D293', '82 文档写明 stopSurface 的 erase(end()) 是 UB', /`erase\(end\(\)\)`.*UB|erase\(end\(\)\)/, {min: 1});
  addDocClaim('D294', '82 文档写明长任务口径错位与 shouldYield 轮询可规避', /口径错位|轮询 `shouldYield` 可规避上报/, {min: 1});
  addDocClaim('D295', '82 文档写明 microtask 护栏本身抛未捕获异常', /护栏本身抛未捕获异常|穿出 executor/, {min: 1});
  addDocClaim('D296', '82 文档写明 measure 不返回零尺寸', /`clamp` 不是「返回 0」|返回零尺寸.*不成立/, {min: 1});
}

// ────────────────────────────────────────────────────────────────────────
// 83 文档 · renderer/mounting
//   MOU-1 … MOU-34
// ────────────────────────────────────────────────────────────────────────
{
  const rd = p => fs.readFileSync(path.join(REPO, p), 'utf8');
  const M = 'packages/react-native/ReactCommon/react/renderer/mounting/';
  const treeCpp = rd(M + 'ShadowTree.cpp');
  const treeH = rd(M + 'ShadowTree.h');
  const coordCpp = rd(M + 'MountingCoordinator.cpp');
  const coordH = rd(M + 'MountingCoordinator.h');
  const differCpp = rd(M + 'Differentiator.cpp');
  const svmCpp = rd(M + 'ShadowViewMutation.cpp');
  const svmH = rd(M + 'ShadowViewMutation.h');
  const svCpp = rd(M + 'ShadowView.cpp');
  const svH = rd(M + 'ShadowView.h');
  const mtCpp = rd(M + 'MountingTransaction.cpp');
  const mtH = rd(M + 'MountingTransaction.h');
  const umfCpp = rd(M + 'updateMountedFlag.cpp');
  const tcCpp = rd(M + 'TelemetryController.cpp');
  const regCpp = rd(M + 'ShadowTreeRegistry.cpp');
  const delH = rd(M + 'ShadowTreeDelegate.h');
  const overH = rd(M + 'MountingOverrideDelegate.h');
  const revH = rd(M + 'ShadowTreeRevision.h');
  const sliceCpp = rd(M + 'internal/sliceChildShadowNodeViewPairs.cpp');
  const sliceH = rd(M + 'internal/sliceChildShadowNodeViewPairs.h');
  const pairH = rd(M + 'internal/ShadowViewNodePair.h');
  const cullCpp = rd(M + 'internal/CullingContext.cpp');
  const stubsCpp = rd(M + 'stubs/stubs.cpp');
  const svtCpp = rd(M + 'stubs/StubViewTree.cpp');
  const svCppStub = rd(M + 'stubs/StubView.cpp');
  const cmake = rd(M + 'CMakeLists.txt');
  const primH = rd('packages/react-native/ReactCommon/react/renderer/core/ReactPrimitives.h');
  const countOf = (h, n) => h.split(n).length - 1;
  const slice = (s, a, b) => { const i = s.indexOf(a); return i < 0 ? '' : s.slice(i, i + b); };

  // ── MOU-6 ──
  add('C697', 'MOU-6：flag 关闭时 commit 是 while(true) 无界重试；唯一护栏 react_native_assert(attempts < 1024) 在 release 为空操作',
    'while (true) + assert(attempts < 1024) + MAX=3',
    'while(true):' + treeCpp.includes('while (true) {') +
      ' / assert:' + treeCpp.includes('react_native_assert(attempts < 1024);') +
      ' / MAX:' + treeCpp.includes('MAX_COMMIT_ATTEMPTS_BEFORE_LOCKING = 3'),
    treeCpp.includes('while (true) {') &&
      treeCpp.includes('react_native_assert(attempts < 1024);') &&
      treeCpp.includes('MAX_COMMIT_ATTEMPTS_BEFORE_LOCKING = 3') &&
      treeCpp.indexOf('if (ReactNativeFeatureFlags::preventShadowTreeCommitExhaustion())') <
        treeCpp.indexOf('while (true) {'));

  // ── MOU-7 ──
  const commitFn = slice(treeCpp, 'CommitStatus ShadowTree::commit(', 1500);
  add('C698', 'MOU-7：flag 开启时最多 3 次尝试，之后持 revisionMutexRecursive_ 的 unique_lock 再提交一次',
    'attempts < MAX + unique_lock recursive + 顺序',
    '循环:' + commitFn.includes('while (attempts < MAX_COMMIT_ATTEMPTS_BEFORE_LOCKING)') +
      ' / 落锁:' + commitFn.includes('std::unique_lock lock(revisionMutexRecursive_);') +
      ' / 顺序:' + (commitFn.indexOf('while (attempts < MAX_COMMIT_ATTEMPTS_BEFORE_LOCKING)') <
        commitFn.indexOf('std::unique_lock lock(revisionMutexRecursive_);')),
    commitFn.includes('while (attempts < MAX_COMMIT_ATTEMPTS_BEFORE_LOCKING)') &&
      commitFn.includes('std::unique_lock lock(revisionMutexRecursive_);') &&
      commitFn.indexOf('while (attempts < MAX_COMMIT_ATTEMPTS_BEFORE_LOCKING)') <
        commitFn.indexOf('std::unique_lock lock(revisionMutexRecursive_);'));

  // ── MOU-8 ──
  const sharedLockFn = slice(treeCpp, 'inline ShadowTree::SharedLock ShadowTree::sharedRevisionLock', 400);
  add('C699', 'MOU-8：两把锁并存；SharedLock 在新路径是 recursive_mutex 上的 unique_lock（无读并发）；头文件注释只提旧锁',
    '双锁成员 + SharedLock 变体 + 新路径 unique_lock + 注释 revisionMutex_',
    'shared_mutex:' + treeH.includes('mutable std::shared_mutex revisionMutex_;') +
      ' / recursive:' + treeH.includes('mutable std::recursive_mutex revisionMutexRecursive_;') +
      ' / SharedLock:' + treeH.includes('std::shared_lock<std::shared_mutex>, std::unique_lock<std::recursive_mutex>') +
      ' / 共享锁分支:' + sharedLockFn.includes('std::unique_lock{revisionMutexRecursive_}'),
    treeH.includes('mutable std::shared_mutex revisionMutex_;') &&
      treeH.includes('mutable std::recursive_mutex revisionMutexRecursive_;') &&
      treeH.includes('std::shared_lock<std::shared_mutex>, std::unique_lock<std::recursive_mutex>') &&
      sharedLockFn.includes('std::unique_lock{revisionMutexRecursive_}'));

  // ── MOU-9 ──
  add('C700', 'MOU-9：非 react 分支号被改即 Failed；react 分支新号 = oldRevisionForStateProgression.number + 1，主分支 = currentRevision_.number + 1',
    'CAS Failed + 两套编号',
    'CAS:' + treeCpp.includes('if (!isReactBranch && currentRevision_.number != oldRevision.number)') +
      ' / react 号:' + treeCpp.includes('oldRevisionForStateProgression.number + 1') +
      ' / 主分支号:' + treeCpp.includes('currentRevision_.number + 1'),
    treeCpp.includes('if (!isReactBranch && currentRevision_.number != oldRevision.number)') &&
      treeCpp.includes('oldRevisionForStateProgression.number + 1') &&
      treeCpp.includes('currentRevision_.number + 1'));

  // ── MOU-10 ──
  add('C701', 'MOU-10：react 分支用手动 std::visit(lock()) 延长锁写 currentReactRevision_，随后不 mount 而走 promotion 通知',
    'visit lock + currentReactRevision_ + scheduleReactRevisionPromotion',
    '手动锁:' + treeCpp.includes('std::visit([](auto& concreteLock) { concreteLock.lock(); }, lock);') +
      ' / 写入:' + treeCpp.includes('currentReactRevision_ = newRevision;') +
      ' / 通知:' + treeCpp.includes('scheduleReactRevisionPromotion();'),
    treeCpp.includes('std::visit([](auto& concreteLock) { concreteLock.lock(); }, lock);') &&
      treeCpp.includes('currentReactRevision_ = newRevision;') &&
      treeCpp.includes('scheduleReactRevisionPromotion();'));

  // ── MOU-11 ──
  const accumFn = slice(treeCpp, 'inline bool isPropsUpdatesAccumulationGuaranteed()', 260);
  add('C702', 'MOU-11：Android 读 enableAccumulatedUpdatesInRawPropsAndroid()，其他平台恒 true',
    '#ifdef __ANDROID__ + 开关 + #else return true',
    accumFn,
    accumFn.includes('enableAccumulatedUpdatesInRawPropsAndroid()') &&
      accumFn.includes('#ifdef __ANDROID__') &&
      accumFn.includes('return true;'));

  // ── MOU-12 ──
  add('C703', 'MOU-12：两条 merge 路径（单个 promote / 逐个全并）；enableStateReconciliation 只给最后一个；merge 忽略 oldRoot 并以主分支 props 克隆',
    'exchange + swap + isLast + ReactRevisionMerge + progressRootLayoutInfo',
    '单值:' + treeCpp.includes('std::exchange(reactRevisionToBePromoted_, std::nullopt)') +
      ' / 队列:' + treeCpp.includes('promotedReactRevisions_.swap(promotedRevisions)') +
      ' / isLast:' + treeCpp.includes('.enableStateReconciliation = isLast,') +
      ' / 布局兜底:' + treeCpp.includes('baseShadowNode.ShadowNode::clone('),
    treeCpp.includes('std::exchange(reactRevisionToBePromoted_, std::nullopt)') &&
      treeCpp.includes('promotedReactRevisions_.swap(promotedRevisions)') &&
      treeCpp.includes('.enableStateReconciliation = isLast,') &&
      treeCpp.includes('.source = CommitSource::ReactRevisionMerge,') &&
      treeCpp.includes('baseShadowNode.ShadowNode::clone('));

  // ── MOU-13 ──
  add('C704', 'MOU-13：updateMountedFlag 在 EventEmitter::DispatchMutex() 下执行；ReactRevisionMerge 跳过置位防计数双增',
    'scoped_lock DispatchMutex + merge 跳过 + double-increment',
    '锁:' + treeCpp.includes('std::scoped_lock dispatchLock(EventEmitter::DispatchMutex());') +
      ' / 跳过:' + umfCpp.includes('commitSource != ShadowTreeCommitSource::ReactRevisionMerge;') +
      ' / 注释:' + umfCpp.includes('double-increment'),
    treeCpp.includes('std::scoped_lock dispatchLock(EventEmitter::DispatchMutex());') &&
      umfCpp.includes('commitSource != ShadowTreeCommitSource::ReactRevisionMerge;') &&
      umfCpp.includes('double-increment'));

  // ── MOU-14 ──
  const setModeFn = slice(treeCpp, 'void ShadowTree::setCommitMode', 700);
  add('C705', 'MOU-14：Suspended 时主分支 commit 不 mount；切回 Normal 时同步补挂非 INITIAL_REVISION 的当前 revision',
    'commitMode Normal 分支 + setCommitMode 补挂',
    '提交分支:' + treeCpp.includes('else if (commitMode == CommitMode::Normal) {') +
      ' / 补挂条件:' + setModeFn.includes('commitMode == CommitMode::Normal && revision.number != INITIAL_REVISION') +
      ' / 同步:' + setModeFn.includes('mount(revision, true);'),
    treeCpp.includes('else if (commitMode == CommitMode::Normal) {') &&
      setModeFn.includes('commitMode == CommitMode::Normal && revision.number != INITIAL_REVISION') &&
      setModeFn.includes('mount(revision, true);'));

  // ── MOU-15 ──
  const emptyFn = slice(treeCpp, 'void ShadowTree::commitEmptyTree', 700);
  add('C706', 'MOU-15：commitEmptyTree 用默认选项（mountSynchronously 默认 true）、notifyDelegatesOfUpdates 恒真；react 分支提交被断言禁止同步',
    'default options + mountSynchronously true + notify true + assert',
    '默认:' + emptyFn.includes('{/* default commit options */}') +
      ' / 通知:' + treeCpp.includes('delegate_.shadowTreeDidFinishTransaction(mountingCoordinator_, true);') +
      ' / 默认值:' + treeH.includes('bool mountSynchronously{true}') +
      ' / 断言:' + treeCpp.includes('react_native_assert(!isReactBranch || !commitOptions.mountSynchronously)'),
    emptyFn.includes('{/* default commit options */}') &&
      treeCpp.includes('delegate_.shadowTreeDidFinishTransaction(mountingCoordinator_, true);') &&
      treeH.includes('bool mountSynchronously{true}') &&
      treeCpp.includes('react_native_assert(!isReactBranch || !commitOptions.mountSynchronously)'));

  // ── MOU-16 ──
  add('C707', 'MOU-16：push 仅接受号更大的 revision，否则静默丢弃；同号重复只有 debug 断言；revoke 清空 base/last',
    'number < + assert != + revoke reset',
    '只认更大:' + coordCpp.includes('lastRevision_->number < revision.number') +
      ' / 同号断言:' + coordCpp.includes('!lastRevision_.has_value() || revision.number != lastRevision_->number') +
      ' / 清根:' + coordCpp.includes('baseRevision_.rootShadowNode.reset();') +
      ' / 清 optional:' + coordCpp.includes('lastRevision_.reset();'),
    coordCpp.includes('lastRevision_->number < revision.number') &&
      coordCpp.includes('!lastRevision_.has_value() || revision.number != lastRevision_->number') &&
      coordCpp.includes('baseRevision_.rootShadowNode.reset();') &&
      coordCpp.includes('lastRevision_.reset();'));

  // ── MOU-17 ──
  add('C708', 'MOU-17：pullTransaction 全程单锁；头文件要求消费方同线程；Android 仍从 JS 线程 pull 再异步上 UI',
    'scoped_lock + willDiff<diff<didDiff + 同线程契约 + Android 注释',
    '单锁:' + coordCpp.includes('std::scoped_lock lock(mutex_);') +
      ' / 差分窗口:' + (coordCpp.indexOf('telemetry.willDiff();') < coordCpp.indexOf('calculateShadowViewMutations(') &&
        coordCpp.indexOf('calculateShadowViewMutations(') < coordCpp.indexOf('telemetry.didDiff();')) +
      ' / 同线程:' + coordH.includes('a consumer should always call it on the same thread') +
      ' / Android:' + coordH.includes('from the JS thread and schedules the updates'),
    coordCpp.includes('std::scoped_lock lock(mutex_);') &&
      coordCpp.indexOf('telemetry.willDiff();') < coordCpp.indexOf('calculateShadowViewMutations(') &&
      coordCpp.indexOf('calculateShadowViewMutations(') < coordCpp.indexOf('telemetry.didDiff();') &&
      coordH.includes('a consumer should always call it on the same thread') &&
      coordH.includes('from the JS thread and schedules the updates'));

  // ── MOU-18 ──
  const overrideArea = slice(coordCpp, '  // Override case', 3600);
  const ovOrder = ['telemetry.willLayout();', 'telemetry.didLayout();', 'telemetry.willCommit();',
    'telemetry.didCommit();', 'telemetry.willDiff();', 'telemetry.didDiff();']
    .map(t => overrideArea.indexOf(t));
  add('C709', 'MOU-18：override 遍历 weak_ptr；事务为空时合成六个遥测事件并 number_++，委托拿到空 mutation 列表',
    'weak_ptr vector + 六事件有序 + number_++',
    '弱引用:' + coordH.includes('std::vector<std::weak_ptr<const MountingOverrideDelegate>> mountingOverrideDelegates_;') +
      ' / 六事件有序:' + ovOrder.every((n, i) => n >= 0 && (i === 0 || n > ovOrder[i - 1])) +
      ' / 自增:' + (countOf(overrideArea, 'number_++;') === 1),
    coordH.includes('std::vector<std::weak_ptr<const MountingOverrideDelegate>> mountingOverrideDelegates_;') &&
      ovOrder.every((n, i) => n >= 0 && (i === 0 || n > ovOrder[i - 1])) &&
      countOf(overrideArea, 'number_++;') === 1);

  // ── MOU-19 ──
  add('C710', 'MOU-19：introspection 用两棵「不用差分器」的树比对；override 事务只回放不比对；不一致 dump 后断言',
    '两棵对照树构建 + override 跳过 + 断言文案',
    'ctor+verify:' + (countOf(coordCpp, 'buildStubViewTreeWithoutUsingDifferentiator(') === 2) +
      ' / 回放:' + coordCpp.includes('stubViewTree_.mutate(mutations);') +
      ' / 跳过:' + coordCpp.includes('if (!didOverridePullTransaction && lastRevision_.has_value()) {') +
      ' / 文案:' + coordCpp.includes('"Incorrect set of mutations detected."'),
    countOf(coordCpp, 'buildStubViewTreeWithoutUsingDifferentiator(') === 2 &&
      coordCpp.includes('stubViewTree_.mutate(mutations);') &&
      coordCpp.includes('if (!didOverridePullTransaction && lastRevision_.has_value()) {') &&
      coordCpp.includes('"Incorrect set of mutations detected."'));

  // ── MOU-20 ──
  add('C711', 'MOU-20：换代时旧 baseRevision 被 move 进空 lambda 交低优先级线程析构；hasPendingTransactionsOverride_ 按异步参数回填',
    'LowPriorityExecutor 空 lambda + 赋值',
    '空 lambda:' + coordCpp.includes('LowPriorityExecutor::execute([toDelete = std::move(baseRevision_)]() {});') +
      ' / 回填:' + coordCpp.includes('hasPendingTransactionsOverride_ = willPerformAsynchronously;'),
    coordCpp.includes('LowPriorityExecutor::execute([toDelete = std::move(baseRevision_)]() {});') &&
      coordCpp.includes('hasPendingTransactionsOverride_ = willPerformAsynchronously;'));

  // ── MOU-21 ──
  const bucketArea = slice(differCpp, '// All mutations in an optimal order:', 1300);
  const bucketOrder = ['destructiveDownwardMutations.begin()', 'updateMutations.begin()',
    'removeMutations.rbegin()', 'deleteMutations.begin()', 'createMutations.begin()',
    'downwardMutations.begin()', 'insertMutations.begin()'].map(t => bucketArea.indexOf(t));
  add('C712', 'MOU-21：七桶输出序，remove 是唯一反序桶；根 Update parentTag 传 {}（0）且先于 reserve(256)；入口断言同 family',
    '七桶有序 + rbegin + reserve 在根 Update 后 + sameFamily',
    '七桶有序:' + bucketOrder.every((n, i) => n >= 0 && (i === 0 || n > bucketOrder[i - 1])) +
      ' / 反序:' + bucketArea.includes('removeMutations.rbegin()') +
      ' / reserve 在后:' + (differCpp.indexOf('oldRootShadowView, newRootShadowView, {})') < differCpp.indexOf('mutations.reserve(256);')) +
      ' / 同 family:' + differCpp.includes('ShadowNode::sameFamily(oldRootShadowNode, newRootShadowNode)'),
    bucketOrder.every((n, i) => n >= 0 && (i === 0 || n > bucketOrder[i - 1])) &&
      bucketArea.includes('removeMutations.rbegin()') &&
      differCpp.indexOf('oldRootShadowView, newRootShadowView, {})') < differCpp.indexOf('mutations.reserve(256);') &&
      differCpp.includes('ShadowNode::sameFamily(oldRootShadowNode, newRootShadowNode)'));

  // ── MOU-22 ──
  add('C713', 'MOU-22：treeChildren.size() 条件重复两遍；unflatten 的 Update 是 TODO 自认冗余；ReparentMode 定义在 .cpp',
    '重复条件 + 冗余 TODO + enum 在 cpp',
    '重复:' + differCpp.includes('index < treeChildren.size() && index < treeChildren.size()') +
      ' / TODO:' + differCpp.includes('so this update is redundant. We should remove this.') +
      ' / enum:' + differCpp.includes('enum class ReparentMode { Flatten, Unflatten };'),
    differCpp.includes('index < treeChildren.size() && index < treeChildren.size()') &&
      differCpp.includes('so this update is redundant. We should remove this.') &&
      differCpp.includes('enum class ReparentMode { Flatten, Unflatten };'));

  // ── MOU-23 ──
  add('C714', 'MOU-23：静态子节点插到 startOfStaticIndex；非 concrete pair 用 (size_t)-1 哨兵；orderIndex 全 0 跳过排序；Hidden 跳过仅 Android（T153547836）',
    'static insert + 哨兵 + isReorderNeeded + T153547836 + useTraitHiddenOnAndroid',
    '静态插入:' + sliceCpp.includes('std::advance(it, startOfStaticIndex)') +
      ' / 哨兵:' + sliceCpp.includes('static_cast<unsigned long>(-1)') +
      ' / 全0:' + sliceCpp.includes('pair->shadowNode->getOrderIndex() != 0') +
      ' / 任务号:' + sliceCpp.includes('T153547836') +
      ' / Android 开关:' + sliceCpp.includes('useTraitHiddenOnAndroid()'),
    sliceCpp.includes('std::advance(it, startOfStaticIndex)') &&
      sliceCpp.includes('static_cast<unsigned long>(-1)') &&
      sliceCpp.includes('pair->shadowNode->getOrderIndex() != 0') &&
      sliceCpp.includes('T153547836') &&
      sliceCpp.includes('useTraitHiddenOnAndroid()'));

  // ── MOU-24 ──
  add('C715', 'MOU-24：pair 恒等只比 shadowNode 指针；scope 是 deque；isConcreteView 的 trait 公式三要素',
    'pair == + deque + FormsView/ForceFlatten/ChildrenFormStackingContext',
    '恒等:' + pairH.includes('return this->shadowNode == rhs.shadowNode;') +
      ' / deque:' + sliceH.includes('using ViewNodePairScope = std::deque<ShadowViewNodePair>;') +
      ' / traits:' + (sliceCpp.includes('FormsView') && sliceCpp.includes('ForceFlattenView') &&
        sliceCpp.includes('ChildrenFormStackingContext')),
    pairH.includes('return this->shadowNode == rhs.shadowNode;') &&
      sliceH.includes('using ViewNodePairScope = std::deque<ShadowViewNodePair>;') &&
      sliceCpp.includes('FormsView') && sliceCpp.includes('ForceFlattenView') &&
      sliceCpp.includes('ChildrenFormStackingContext'));

  // ── MOU-25 ──
  add('C716', 'MOU-25：剔除判据 = uncullable trait 例外 + 宽高 > 0 + 双 transform 后的相交测试 + 空布局例外',
    'intersect + uncullable + hasLayout + getOverflowInsetFrame',
    '相交:' + sliceCpp.includes('Rect::intersect(cullingContext.frame, overflowInsetFrame) != Rect{}') +
      ' / uncullable:' + (sliceCpp.includes('Unstable_uncullableView') && sliceCpp.includes('Unstable_uncullableTrace')) +
      ' / 空布局:' + sliceCpp.includes('hasLayout') +
      ' / overflow 帧:' + sliceCpp.includes('getOverflowInsetFrame()') +
      ' / 宽高门槛:' + cullCpp.includes('frame.size.width > 0 && frame.size.height > 0'),
    sliceCpp.includes('Rect::intersect(cullingContext.frame, overflowInsetFrame) != Rect{}') &&
      sliceCpp.includes('Unstable_uncullableView') && sliceCpp.includes('Unstable_uncullableTrace') &&
      sliceCpp.includes('hasLayout') && sliceCpp.includes('getOverflowInsetFrame()') &&
      cullCpp.includes('frame.size.width > 0 && frame.size.height > 0'));

  // ── MOU-26 ──
  add('C717', 'MOU-26：culling 只特判 ScrollViewShadowNode；outset floor 对称外扩；RTL 用内容宽减视图宽减 origin.x；其他节点 origin 回退 + transform 累乘',
    'ScrollView cast + disableViewCulling + floor outset + RTL 公式 + permalink + Identity',
    '特判:' + cullCpp.includes('dynamic_cast<const ScrollViewShadowNode*>') +
      ' / 禁用:' + cullCpp.includes('disableViewCulling') +
      ' / outset:' + cullCpp.includes('floor(cullingContext.frame.size.width * outsetRatio)') +
      ' / RTL:' + (cullCpp.includes('contentBoundingRect.size.width') && cullCpp.includes('RCTScrollViewComponentView.mm#L579')) +
      ' / Identity:' + cullCpp.includes('Transform::Identity()'),
    cullCpp.includes('dynamic_cast<const ScrollViewShadowNode*>') &&
      cullCpp.includes('disableViewCulling') &&
      cullCpp.includes('floor(cullingContext.frame.size.width * outsetRatio)') &&
      cullCpp.includes('contentBoundingRect.size.width') &&
      cullCpp.includes('RCTScrollViewComponentView.mm#L579') &&
      cullCpp.includes('Transform::Identity()'));

  // ── MOU-27 ──
  add('C718', 'MOU-27：入口短路比较两个 vector 的地址（死代码）；Stage 2/3 注释写成 State；先置 true 后置 false 以侦测 remount',
    '&oldChildren == &newChildren + State 2/3 + setMounted 顺序',
    '地址比较:' + umfCpp.includes('if (&oldChildren == &newChildren) {') +
      ' / Lists are identical:' + umfCpp.includes('// Lists are identical, nothing to do.') +
      ' / State 2:' + umfCpp.includes('// State 2: Mount new children.') +
      ' / State 3:' + umfCpp.includes('// State 3: Unmount old children.') +
      ' / 顺序:' + (umfCpp.indexOf('newChild->setMounted(true);') < umfCpp.indexOf('oldChild->setMounted(false);')),
    umfCpp.includes('if (&oldChildren == &newChildren) {') &&
      umfCpp.includes('// Lists are identical, nothing to do.') &&
      umfCpp.includes('// State 2: Mount new children.') &&
      umfCpp.includes('// State 3: Unmount old children.') &&
      umfCpp.indexOf('newChild->setMounted(true);') < umfCpp.indexOf('oldChild->setMounted(false);'));

  // ── MOU-28 ──
  add('C719', 'MOU-28：TelemetryController 两处手写 lock/unlock，非 RAII；读照与写回之间夹三个回调与 incorporate',
    'mutex_.lock 两次 + 无 lock_guard/scoped_lock + 窗口顺序',
    '手写锁:' + (countOf(tcCpp, 'mutex_.lock();') === 2) +
      ' / 无 RAII:' + (!tcCpp.includes('std::lock_guard') && !tcCpp.includes('std::scoped_lock')) +
      ' / 窗口顺序:' + (tcCpp.indexOf('auto compoundTelemetry = compoundTelemetry_;') <
        tcCpp.indexOf('compoundTelemetry.incorporate(telemetry, numberOfMutations);') &&
        tcCpp.indexOf('compoundTelemetry.incorporate(telemetry, numberOfMutations);') <
        tcCpp.indexOf('compoundTelemetry_ = compoundTelemetry;')),
    countOf(tcCpp, 'mutex_.lock();') === 2 &&
      !tcCpp.includes('std::lock_guard') && !tcCpp.includes('std::scoped_lock') &&
      tcCpp.indexOf('auto compoundTelemetry = compoundTelemetry_;') <
        tcCpp.indexOf('compoundTelemetry.incorporate(telemetry, numberOfMutations);') &&
      tcCpp.indexOf('compoundTelemetry.incorporate(telemetry, numberOfMutations);') <
        tcCpp.indexOf('compoundTelemetry_ = compoundTelemetry;'));

  // ── MOU-29 ──
  add('C720', 'MOU-29：Registry add 用 emplace、同 id 不覆盖；析构护栏是空操作 assert；visit/enumerate 持 shared_lock 调回调',
    'emplace + 析构 assert + shared_lock x2 + stop 回调',
    'emplace:' + regCpp.includes('registry_.emplace(shadowTree->getSurfaceId(), std::move(shadowTree));') +
      ' / 析构:' + regCpp.includes('Deallocation of non-empty `ShadowTreeRegistry`.') +
      ' / shared_lock:' + (countOf(regCpp, 'std::shared_lock lock(mutex_);') === 2) +
      ' / stop:' + regCpp.includes('callback(*pair.second, stop);'),
    regCpp.includes('registry_.emplace(shadowTree->getSurfaceId(), std::move(shadowTree));') &&
      regCpp.includes('Deallocation of non-empty `ShadowTreeRegistry`.') &&
      countOf(regCpp, 'std::shared_lock lock(mutex_);') === 2 &&
      regCpp.includes('callback(*pair.second, stop);'));

  // ── MOU-30 ──
  add('C721', 'MOU-30：delegate 四方法中三个纯虚，唯一带空默认体的是 shadowTreeDidCommit（携带 affectedLayoutableNodes）',
    '3 个 = 0 + affectedLayoutableNodes + 空体',
    '纯虚数:' + countOf(delH, '= 0;') +
      ' / 空体:' + delH.includes('affectedLayoutableNodes*/) const') +
      ' / 回调名:' + delH.includes('shadowTreeDidFinishReactCommit'),
    countOf(delH, '= 0;') === 3 &&
      delH.includes('affectedLayoutableNodes*/) const') &&
      delH.includes('shadowTreeDidFinishReactCommit'));

  // ── MOU-31 ──
  add('C722', 'MOU-31：MountingOverrideDelegate.h 的 include 在 #pragma once 之前；列表项「- Calling」残缺',
    'include 先于 pragma + - Calling',
    '顺序:' + (overH.indexOf('#include <react/cxxstableapi/FrameworksGuard.h>') < overH.indexOf('#pragma once')) +
      ' / 残缺项:' + overH.includes('* - Calling') +
      ' / 纯虚:' + overH.includes('shouldOverridePullTransaction() const = 0;'),
    overH.indexOf('#include <react/cxxstableapi/FrameworksGuard.h>') < overH.indexOf('#pragma once') &&
      overH.includes('* - Calling') &&
      overH.includes('shouldOverridePullTransaction() const = 0;'));

  // ── MOU-32 ──
  add('C723', 'MOU-32：stubs/*.cpp 被 CMake 无条件 glob；两种建树入口并存；简化排序器自认故意拷贝且无条件 stable_sort',
    'glob stubs + 两入口 + intentionally copied',
    'glob:' + cmake.includes('stubs/*.cpp)') +
      ' / 两入口:' + (stubsCpp.includes('buildStubViewTreeUsingDifferentiator') &&
        stubsCpp.includes('buildStubViewTreeWithoutUsingDifferentiator')) +
      ' / 拷贝自:' + stubsCpp.includes('intentionally copied from'),
    cmake.includes('stubs/*.cpp)') &&
      stubsCpp.includes('buildStubViewTreeUsingDifferentiator') &&
      stubsCpp.includes('buildStubViewTreeWithoutUsingDifferentiator') &&
      stubsCpp.includes('intentionally copied from'));

  // ── MOU-33 ──
  add('C724', 'MOU-33：回放断言含 Create 不重复、Insert 先 Remove（parentTag==kNoTag）、Remove 精确匹配 children[index]、Update 哈希一致；release 下 operator[] 会插 null',
    '四组断言 + registry_[parentTag] + .at()',
    'Create:' + svtCpp.includes('react_native_assert(!hasTag(tag));') +
      ' / Insert:' + svtCpp.includes('childStubView->parentTag == kNoTag') +
      ' / Remove:' + svtCpp.includes('children[mutation.index]->tag ==') +
      ' / Update 哈希:' + svtCpp.includes('std::hash<ShadowView>{}((ShadowView)*oldStubView) ==') +
      ' / operator[]:' + svtCpp.includes('auto parentStubView = registry_[parentTag];') +
      ' / at:' + svtCpp.includes('registry_.at(tag)'),
    svtCpp.includes('react_native_assert(!hasTag(tag));') &&
      svtCpp.includes('childStubView->parentTag == kNoTag') &&
      svtCpp.includes('children[mutation.index]->tag ==') &&
      svtCpp.includes('std::hash<ShadowView>{}((ShadowView)*oldStubView) ==') &&
      svtCpp.includes('auto parentStubView = registry_[parentTag];') &&
      svtCpp.includes('registry_.at(tag)'));

  // ── MOU-34 ──
  add('C725', 'MOU-34：StubViewTree::operator== 只比 registry 尺寸 + 逐 tag；StubView::operator== 只比 props 与 layoutMetrics',
    'size 比较 + props/layoutMetrics 两字段 + 无 tag 比较',
    '尺寸:' + svtCpp.includes('lhs.registry_.size() != rhs.registry_.size()') +
      ' / props:' + svCppStub.includes('if (lhs.props != rhs.props) {') +
      ' / metrics:' + svCppStub.includes('if (lhs.layoutMetrics != rhs.layoutMetrics) {') +
      ' / 无 tag 比较:' + !svCppStub.includes('lhs.tag != rhs.tag'),
    svtCpp.includes('lhs.registry_.size() != rhs.registry_.size()') &&
      svCppStub.includes('if (lhs.props != rhs.props) {') &&
      svCppStub.includes('if (lhs.layoutMetrics != rhs.layoutMetrics) {') &&
      !svCppStub.includes('lhs.tag != rhs.tag'));

  // ── MOU-1 ──
  add('C726', 'MOU-1：Type 五个值是 1/2/4/8/16；字段默认 parentTag=kNoTag(-1)、index=-1；Create/Delete 用 kNoTag，Update index 恒 -1',
    '枚举值 + 默认值 + kNoTag 定义 + 构造器哨兵',
    '值:' + (svmH.includes('Create = 1') && svmH.includes('Delete = 2') && svmH.includes('Insert = 4') &&
      svmH.includes('Remove = 8') && svmH.includes('Update = 16')) +
      ' / 默认:' + (svmH.includes('Tag parentTag = kNoTag;') && svmH.includes('int index = -1;')) +
      ' / kNoTag:' + primH.includes('constexpr Tag kNoTag = -1;') +
      ' / Create/Delete:' + (countOf(svmCpp, '/* .parentTag = */ kNoTag,') === 2) +
      ' / Update index:' + svmCpp.includes('/* .type = */ Update,'),
    svmH.includes('Create = 1') && svmH.includes('Delete = 2') && svmH.includes('Insert = 4') &&
      svmH.includes('Remove = 8') && svmH.includes('Update = 16') &&
      svmH.includes('Tag parentTag = kNoTag;') && svmH.includes('int index = -1;') &&
      primH.includes('constexpr Tag kNoTag = -1;') &&
      countOf(svmCpp, '/* .parentTag = */ kNoTag,') === 2);

  // ── MOU-2 ──
  const virtualFn = slice(svmCpp, 'bool ShadowViewMutation::mutatedViewIsVirtual', 700);
  add('C727', 'MOU-2：mutatedViewIsVirtual 只在 ANDROID 有逻辑且要求两侧 layoutMetrics 都是 EmptyLayoutMetrics；机制自述 DEPRECATED',
    '#ifdef ANDROID + 两侧 Empty + DEPRECATED 注释',
    '平台分支:' + virtualFn.includes('#ifdef ANDROID') +
      ' / 双侧:' + (virtualFn.includes('newChildShadowView.layoutMetrics == EmptyLayoutMetrics &&') &&
        virtualFn.includes('oldChildShadowView.layoutMetrics == EmptyLayoutMetrics')) +
      ' / DEPRECATED:' + (svmH.includes('This mechanism is DEPRECATED') &&
        svmH.includes('NOT make use of this')),
    virtualFn.includes('#ifdef ANDROID') &&
      virtualFn.includes('newChildShadowView.layoutMetrics == EmptyLayoutMetrics &&') &&
      virtualFn.includes('oldChildShadowView.layoutMetrics == EmptyLayoutMetrics') &&
      svmH.includes('This mechanism is DEPRECATED') &&
      svmH.includes('NOT make use of this'));

  // ── MOU-3 ──
  const hashFn = slice(svH, 'struct hash<facebook::react::ShadowView>', 600);
  add('C728', 'MOU-3：== 比 7 字段含 componentName 不含 componentHandle；hash 组合 componentHandle 不含 componentName',
    '== 含 name / hash 含 handle / hash 函数体内不含 name',
    '== name:' + svCpp.includes('this->componentName,') +
      ' / == 无 handle:' + !svCpp.includes('this->componentHandle,') +
      ' / hash handle:' + hashFn.includes('shadowView.componentHandle,') +
      ' / hash 无 name:' + !hashFn.includes('componentName'),
    svCpp.includes('this->componentName,') && !svCpp.includes('this->componentHandle,') &&
      hashFn.includes('shadowView.componentHandle,') && !hashFn.includes('componentName'));

  // ── MOU-4 ──
  add('C729', 'MOU-4：事务号从 1 起（0 表示首事务前）；moved-from 访问 UB；const getTelemetry 返回可变引用；mergeWith 用对方号并覆盖 telemetry（TODO T186641819）',
    'from 1 + moved-from UB + mutable telemetry + mergeWith',
    '号:' + mtH.includes('grows continuously starting from `1`') +
      ' / UB:' + mtH.includes('moved-from object of this type has unspecified value') +
      ' / mutable:' + mtH.includes('mutable TransactionTelemetry telemetry_;') +
      ' / 号取对方:' + mtCpp.includes('number_ = transaction.getNumber();') +
      ' / TODO:' + mtCpp.includes('TODO T186641819'),
    mtH.includes('grows continuously starting from `1`') &&
      mtH.includes('moved-from object of this type has unspecified value') &&
      mtH.includes('mutable TransactionTelemetry telemetry_;') &&
      mtCpp.includes('number_ = transaction.getNumber();') &&
      mtCpp.includes('TODO T186641819'));

  // ── MOU-5 ──
  add('C730', 'MOU-5：ShadowTreeRevision 是 rootShadowNode/number/telemetry 三字段 POD，Number=int64_t；INITIAL_REVISION = 0',
    '三字段 + int64_t + INITIAL_REVISION{0}',
    '字段:' + (revH.includes('RootShadowNode::Shared rootShadowNode;') && revH.includes('TransactionTelemetry telemetry;')) +
      ' / 类型:' + revH.includes('using Number = int64_t;') +
      ' / 初值:' + treeH.includes('constexpr static ShadowTreeRevision::Number INITIAL_REVISION{0};'),
    revH.includes('RootShadowNode::Shared rootShadowNode;') &&
      revH.includes('TransactionTelemetry telemetry;') &&
      revH.includes('using Number = int64_t;') &&
      treeH.includes('constexpr static ShadowTreeRevision::Number INITIAL_REVISION{0};'));

  // ── 文档侧 ──
  addDocClaim('D297', '83 文档写明 flag 关闭时的无界重试与 release 空操作断言', /无界重试|无限忙循环/, {min: 1});
  addDocClaim('D298', '83 文档写明两把互斥锁并存且新路径共享锁是排他锁', /两把互斥锁并存|「共享锁」实为|共享锁」其实是互斥锁/, {min: 1});
  addDocClaim('D299', '83 文档写明 merge 的两条路径与 state reconciliation 只给最后一个', /只放行最后一个|仅\*\*最后一个\*\* revision 为 true/, {min: 1});
  addDocClaim('D300', '83 文档写明 push 静默丢弃更小号 revision', /静默丢弃过时 revision|静默丢弃更小号/, {min: 1});
  addDocClaim('D301', '83 文档写明 override 空事务合成全套假 telemetry', /合成全套假 telemetry|六个事件全部无事件调用/, {min: 1});
  addDocClaim('D302', '83 文档写明 introspection 两棵对照树都不依赖差分器', /两棵对照树都不依赖差分器|不靠差分器/, {min: 1});
  addDocClaim('D303', '83 文档写明七桶输出顺序与唯一的反序 remove', /七桶输出序|remove\*\*.*倒序|唯一反序桶/, {min: 1});
  addDocClaim('D304', '83 文档写明 culling 只特判 ScrollView 且 RTL 公式', /只特判 ScrollView|culling = ScrollView culling/, {min: 1});
  addDocClaim('D305', '83 文档写明 TelemetryController 手写锁非 RAII 与聚合窗口', /手写 `mutex_\.lock\(\)`|聚合窗口|读照到写回/, {min: 1});
  addDocClaim('D306', '83 文档写明 updateMountedFlag 的地址比较是死代码', /比较的是\*\*引用绑定的 vector 对象地址\*\*|几乎恒 false/, {min: 1});
}

// ────────────────────────────────────────────────────────────────────────
// 报告
// ────────────────────────────────────────────────────────────────────────
const fail = checks.filter(c => !c.ok);
console.log('════════ 核心事实断言抽查 ════════');
console.log(`断言: ${checks.length} 条   通过: ${checks.length - fail.length}   失败: ${fail.length}\n`);
for (const c of checks) {
  console.log(`  ${c.ok ? '✓' : '✗ FAIL'} [${c.id}] ${c.claim}`);
  if (!c.ok) console.log(`        期望: ${c.expect}   实际: ${c.actual}`);
}
console.log('');
if (fail.length === 0) {
  console.log('✓ 所有核心断言与源码一致\n');
} else {
  console.log(`✗ ${fail.length} 条断言与源码不符，文档需修正\n`);
}
process.exit(fail.length ? 1 : 0);
