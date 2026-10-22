---
id: 73
title: "LogBox 的 JS 侧：与 C++ 解析器的双实现对照、一个与 log 生命周期脱钩的符号化缓存，以及一次自我纠错"
topic: DG.logbox
symptoms: [crash, debug]
platforms: [cross]
architecture: [cross]
layer: T2
symbols: ["parseLogBoxLog", "LogBoxData", "LogBoxSymbolication", "LogBoxLog"]
claims: [MMM-1, MMM-2, MMM-3, MMM-4, MMM-5, MMM-6, MMM-7, MMM-8, MMM-9, MMM-10]
---
# 73 · LogBox 的 JS 侧：与 C++ 解析器的双实现对照、一个与 log 生命周期脱钩的符号化缓存，以及一次自我纠错

> **模块**：A4 · `packages/react-native/Libraries/LogBox/Data/`（`parseLogBoxLog.js` / `LogBoxData.js` /
> `LogBoxSymbolication.js` / `LogBoxLog.js`）
>
> **基线**：react-native @ `9b131e42` · JS（`Libraries/`）· **dev-only**（LogBox 只在开发模式显示）
>
> **前置**：[04 文档](./04-崩溃日志捕获收集处理上传.md) 记录崩溃采集与上传全链路；
> [22 文档](./22-iOS崩溃UI层RedBox与LogBox.md) 记录 iOS RedBox/LogBox 双层门控；
> [43 文档](./43-JS异常三级路由与unhandled-rejection.md) 记录 JS 异常三级路由；
> [65 文档](./65-错误处理底层的断言宏与RedBox解析.md) 记录 C++ 侧 `RedBoxErrorParser` 的三个实测缺陷；
> [66 文档](./66-性能观测层的无界缓冲与监控盲区.md) 记录「无上限 + 无丢弃可见性」的风险分级；
> [67 文档](./67-特性开关的四级继承链与未接CI的快照门禁.md) 记录「需要统一的地方有多份手写副本」。
>
> 本文记录三条结论：
> ① **【核心】同一个「解析错误消息里的行号」的任务，JS 与 C++ 用了两种解析方式，失败模式不同** ——
> **JS 的 `parseInt` 静默返回一个错误值（实测 20 位数字 → `100000000000000000000`），
> C++ 的 `std::stoi` 抛未捕获异常**（65 文档 EEE-2）；
> ② **【核心】C++ 侧有一个 JS 侧完全没有的分支** → **两份实现不是等价移植**
> （而 65 文档的注释自称「C++ port of parseLogBoxException from parseLogBoxLog.js」）；
> ③ **【核心】`LogBoxSymbolication` 的符号化缓存是模块级 `Map`，与 `logs` 的生命周期脱钩** ——
> **`clear()` 清了 log 集合却不清缓存** → **一个真正无界、且无任何自动清理的容器**。

---

## 1. 文件构成（本轮读 4 个文件）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/Libraries/LogBox/Data/parseLogBoxLog.js` | **420** | **JS 侧的错误消息解析器**（与 C++ 的 `RedBoxErrorParser` 对应） |
| `packages/react-native/Libraries/LogBox/Data/LogBoxData.js` | **558** | log 集合、订阅、清理 |
| `packages/react-native/Libraries/LogBox/Data/LogBoxSymbolication.js` | **65** | **source map 符号化 + 模块级缓存** |
| `packages/react-native/Libraries/LogBox/Data/LogBoxLog.js` | — | 单条 log 的状态机（`symbolicate` / `retrySymbolicate`） |

**证据文件**：`packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.cpp`（65 文档已读）。

---

## 2. 【核心 MMM-1】同一任务、两种解析方式、两种失败模式

### 2.1 JS 侧的行号解析

```javascript
// packages/react-native/Libraries/LogBox/Data/parseLogBoxLog.js:223-226
      codeFrame: {
        fileName,
        location: {
          row: parseInt(row, 10),
          column: parseInt(column, 10),
        },
        content: codeFrame,
      },
```

**JS 用 `parseInt(row, 10)`。**

### 2.2 C++ 侧的行号解析

```cpp
// packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.cpp:120-121
                  .row = std::stoi(match[4].str()),
                  .column = std::stoi(match[5].str()),
```

**C++ 用 `std::stoi`（65 文档 EEE-2：越界抛 `std::out_of_range`，且 `parseErrorMessage` 无 try/catch）。**

### 2.3 实测：JS 的 `parseInt` **不抛，但静默给出错误值**

| 输入 | `parseInt(x, 10)` 实测 | C++ `std::stoi` 实测 |
| --- | --- | --- |
| `"12"` | `12` | `12` |
| **`"2147483648"`** | **`2147483648`**（**不抛**） | **抛 `std::out_of_range`** |
| **`"99999999999999999999"`**（20 位） | **`100000000000000000000`**（**静默丢失精度**） | **抛 `std::out_of_range`** |

**即：两者都不是「正确」，但失败模式截然不同**：

| | JS | C++ |
| --- | --- | --- |
| **超大行号** | **静默返回一个错得离谱的值**（`1e20`） | **抛未捕获异常** |
| **对调用方的影响** | 该行号被写进 `codeFrame.location` 与 `category`（`${fileName}-${row}-${column}`）→ **RedBox 里显示一个荒谬的行号** | **RedBox 解析器崩溃** → **无法显示错误** |
| **可恢复性** | 用户可从别的信息推断 | **不可恢复** |

**即：JS 侧「错得离谱但能显示」，C++ 侧「直接崩掉」** ——
**后者严格更差**。

### 2.4 这补强了 65 文档 EEE-2 的结论

**65 文档当时的结论**：「`std::stoi` 越界抛未捕获异常，而 `StackTraceParser::toInt` 用 `from_chars` 安全返回 `nullopt`」——
**即「同一模块内两套策略，一套安全一套抛」**。

**本轮补上了第三处证据**：**JS 侧用的是第三种策略（`parseInt`，静默出错）**。

| 实现 | 策略 | 超大数字的行为 |
| --- | --- | --- |
| `StackTraceParser::toInt`（C++） | `std::from_chars` + 显式错误码 | **返回 `nullopt`** ✓ 最安全 |
| `parseLogBoxLog.js`（JS） | `parseInt` | **静默返回错误值** ⚠️ |
| `RedBoxErrorParser`（C++） | `std::stoi` | **抛未捕获异常** ❌ 最危险 |

**三份实现、三种策略、无任何统一** —— 与 67 文档 GGG-1、69 文档 III-3 同型。

### 2.5 而 `parseLogBoxLog.js` 的注释解释了这个设计

```javascript
// packages/react-native/Libraries/LogBox/Data/parseLogBoxLog.js:266-268
  // Perform a cheap match first before trying to parse the full message, which
  // can get expensive for arbitrary input.
  if (RE_BABEL_CODE_FRAME_MARKER_PATTERN.test(message)) {
```

**即：JS 侧有「先做廉价匹配再全量解析」的性能优化** —— 而 **C++ 侧没有这一步**（65 文档记录 C++ 侧直接依次 `regex_search` 4 个正则）。

**即：两份实现的性能特征也不同**。

---

## 3. 【核心 MMM-2】C++ 侧有一个 JS 侧完全没有的分支

### 3.1 逐项对照

| 错误类型 | **JS `parseLogBoxException`** | **C++ `parseErrorMessage`** |
| --- | --- | --- |
| Metro 内部错误 | ✅ `RE_METRO_ERROR_FORMAT` | ✅ `metroErrorRegex` |
| Babel transform 错误 | ✅ `RE_BABEL_TRANSFORM_ERROR_FORMAT` | ✅ `babelTransformErrorRegex` |
| Babel code frame 错误 | ✅ `RE_BABEL_CODE_FRAME_ERROR_FORMAT` | ✅ `babelCodeFrameErrorRegex` |
| 通用 transform 错误 | ✅ `RE_TRANSFORM_ERROR` | ✅ `startsWithTransformError` |
| **Bundle 加载错误** | ❌ **完全没有** | ✅ **`bundleLoadErrorRegex`** + `knownBundleLoadErrorTypes()` 白名单 |
| **行号解析** | `parseInt` | `std::stoi` |
| **先做廉价匹配** | ✅ 有 | ❌ 无 |

**C++ 侧独有的 `bundleLoadErrorRegex` 分支**：

```cpp
// packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.cpp:113-137
  if (std::regex_search(message, match, bundleLoadErrorRegex())) {
    const auto& errorType = match[1].str();
    if (knownBundleLoadErrorTypes().count(errorType) > 0) {
      std::string title = errorType == "UnableToResolveError"
          ? "Module Not Found"
          : "Syntax Error";
```

**而 JS 侧的 5 个正则里没有任何一个对应它**（实测：`RE_METRO_ERROR_FORMAT` / `RE_BABEL_TRANSFORM_ERROR_FORMAT` / `RE_BABEL_CODE_FRAME_ERROR_FORMAT` / `RE_TRANSFORM_ERROR` / `RE_BABEL_CODE_FRAME_MARKER_PATTERN`）。

### 3.2 但 C++ 的注释自称是「移植」

```cpp
// packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.h:22-24
/**
 * Parse a raw error message into structured components.
 * C++ port of parseLogBoxException from parseLogBoxLog.js.
 */
```

**即：注释说的是「移植」，实现多了一个分支、少了一个性能优化、且数字解析策略不同。**

**「移植」的说法不准确** —— 更像「**独立重写**」。

**后果**：
| 项 | 影响 |
| --- | --- |
| **JS 侧无法处理 bundle 加载错误** | 若 JS 侧收到这种消息 → 落入「通用」分支 → **RedBox 展示不出「Module Not Found」** |
| **两端行为不一致** | 同一份错误消息在 iOS 的 RedBox2（C++）与 LogBox（JS）里**展示不同** |
| **修一处不会修另一处** | 无共享测试、无共享正则定义 |

**与 67 文档 GGG-1、69 文档 III-3 同型**：**需要统一的地方有多份独立副本，且没有机制让它们保持一致。**

### 3.3 另一处细节差异：JS 侧在无行列号时用 `"1-1"` 占位

```javascript
// packages/react-native/Libraries/LogBox/Data/parseLogBoxLog.js:279-283
      codeFrame: {
        fileName,
        location: null, // We are not given the location.
        content: codeFrame,
      },
      ...
      category: `${fileName}-${1}-${1}`,
```

**`category` 用字面量 `"1-1"`** —— 而 `codeFrame.location` 是 `null`。
**即：category 暗示「第 1 行第 1 列」，而实际位置未知** —— **一个可能误导的分类键**。

**C++ 侧没有 `category` 概念** → 又一处行为差异。

---

## 4. 【核心 MMM-3】符号化缓存：模块级 `Map`，与 `logs` 生命周期脱钩

### 4.1 缓存是模块级常量

```javascript
// packages/react-native/Libraries/LogBox/Data/LogBoxSymbolication.js:20
const cache: Map<Stack, Promise<SymbolicatedStackTrace>> = new Map();
```

**`const cache = new Map()` 是模块级单例** —— **不随 `logs` 集合的生命周期变化**。

### 4.2 而 `clear()` 只重建 `logs`

```javascript
// packages/react-native/Libraries/LogBox/Data/LogBoxData.js:291-295
export function clear(): void {
  if (logs.size > 0) {
    logs = new Set();
    setSelectedLog(-1);
  }
}
```

**`clear()` 完全不触碰 `LogBoxSymbolication` 的 `cache`。**

### 4.3 对比：`logs` 本身**有**两个自动清理触发点

```javascript
// packages/react-native/Libraries/LogBox/Data/LogBoxData.js:196-219
export function addLog(log: LogData): void {
  if (hostTargetSessionObserverSubscription == null) {
    hostTargetSessionObserverSubscription = DebuggerSessionObserver.subscribe(
      hasActiveSession => {
        if (hasActiveSession) {
          clearWarnings();
        }
        ...
      },
    );
  }

  if (tracingStateObserverSubscription == null) {
    tracingStateObserverSubscription = TracingStateObserver.subscribe(
      isTracing => {
        if (isTracing) {
          clear();
        }
      },
    );
  }
```

| 集合 | 是否有自动清理 |
| --- | --- |
| **`logs`**（`LogBoxData.js:69` `let logs: LogBoxLogs = new Set();`） | ✅ **有** —— ① 有调试会话时 `clearWarnings()`；② 开始追踪时 `clear()` |
| **`LogBoxSymbolication` 的 `cache`** | ❌ **完全没有** —— 只能靠 `deleteStack` 逐条删 |

**即：`logs` 是「无上限但有自愈」，`cache` 是「无上限且无自愈」。**

### 4.4 与 66 文档 FFF-1 的对照

| | 66 文档 FFF-1（`PerformanceEntryKeyedBuffer`） | 本文 MMM-3（符号化 `cache`） |
| --- | --- | --- |
| **容器** | `unordered_map<string, vector<Entry>>` | `Map<Stack, Promise<...>>` |
| **上限** | ❌ 无 | ❌ 无 |
| **淘汰** | ❌ 无 | ❌ 无 |
| **自动清理触发点** | ❌ **无** | ❌ **无** |
| **显式清理 API** | ❌ **无** | ✅ `deleteStack`（有 2 个生产调用方） |
| **失效与主体生命周期同步** | ❌ | ❌ **`clear()` 不清它** |
| **dev-only** | ❌（生产也跑） | ✅（LogBox 仅 dev） |
| **每条的大小** | ≥ 50–60 字节 | **一个 source map 符号化结果 + 一个 promise**（**可能很大**） |
| **综合严重性** | **高** | **低**（dev-only） |

**即：MMM-3 的机制比 FFF-1 更完整（有 `deleteStack`），但**生命周期脱钩**是 FFF-1 没有的新问题**。

### 4.5 `deleteStack` 与 `retrySymbolicate` 的配合是正确的 ✓

```javascript
// packages/react-native/Libraries/LogBox/Data/LogBoxLog.js:93-106
  retrySymbolicate(callback?: (status: SymbolicationStatus) => void): void {
    let retry = false;
    if (this.symbolicated.status !== 'COMPLETE') {
      LogBoxSymbolication.deleteStack(this.stack);
      retry = true;
    }
    if (this.symbolicatedComponentStack.status !== 'COMPLETE') {
      LogBoxSymbolication.deleteStack(this.componentStack);
      retry = true;
    }
    if (retry) {
      this.handleSymbolicate(callback);
    }
  }
```

**即：重试前先删缓存条目 → 失败不会被永久缓存** ✓ **设计正确**。

**且 `symbolicate()` 的「同一 log 实例」语义也是自洽的**：

```javascript
// packages/react-native/Libraries/LogBox/Data/LogBoxLog.js:108-112
  symbolicate(callback?: (status: SymbolicationStatus) => void): void {
    if (this.symbolicated.status === 'NONE') {
      this.handleSymbolicate(callback);
    }
  }
```

**`this.stack` 是实例字段（引用稳定）→ 同一 log 实例重复调用会命中缓存** ✓。

### 4.6 但缓存的 key 是**数组引用**，不是内容

**`Map` 用引用相等比较 key** → 两个**内容相同但数组对象不同**的 stack 会各占一个条目。

**实际影响有限**（每个 log 有自己的 stack 数组），但**若同一份 stack 被拷贝成新数组再传入（如 `retrySymbolicate` 之外的路径），缓存会 miss**。

**且 `deleteStack(stack)` 同样用引用相等** → **必须传同一个数组对象才能删掉** ✓（`LogBoxLog.js` 传的是 `this.stack` / `this.componentStack` ✓ 一致）。

---

## 5. 一次自我纠错（本轮的方法论记录）

### 5.1 事件

**我在检索 `deleteStack` 的调用方时，得到「零命中」**，并据此写下「`deleteStack` 无任何调用方 → 缓存无法失效 → 失败 promise 被永久缓存 → `retrySymbolicate` 对失败场景无效」这条**三段推理**。

### 5.2 实际原因：**检索命令在错误的 cwd 下执行**

```bash
# 当时（在 .../Libraries/LogBox/Data 目录下执行）
grep -rn "deleteStack" --include="*.js" packages/react-native/Libraries/
→ 无输出（因为该相对路径在当前 cwd 下不存在）
```

```bash
# 在仓库根重跑（完全相同的检索根）
grep -rn "deleteStack" --include="*.js" packages/react-native/Libraries/
→ 4 处命中
```

### 5.3 结论

| 项 | 判定 |
| --- | --- |
| **原结论** | **完全错误** —— `deleteStack` 有 **2 个生产调用方**（`LogBoxLog.js:96`、`:100`） |
| **「失败 promise 被永久缓存」** | **不成立** —— `retrySymbolicate` 会先 `deleteStack` 再重试 ✓ |
| **「缓存无法失效」** | **不成立** ✓ |
| **错误的原因** | **检索根用绝对形式、却在子目录下执行** → 静默返回空 → **假阴性** |

### 5.4 固化的纪律

> **检索命令必须在仓库根执行，或使用与当前 cwd 匹配的路径。**
> **「零命中」在下结论前必须用「另一条等价的检索方式」复核** —— 例如
> ① 换一条 grep 模式；② 用 Python 直接遍历；③ 换 cwd 重跑。

**这与我在项目初期总结的「探查子代理的报告不可直接采信」是同一条纪律 ——
**只不过这一次犯错的是我自己。**

**为什么值得写进文档**：因为这类假阴性**看起来和真阴性完全一样**，
且会**沿着推理链放大**（零命中 → 缓存无法失效 → 重试无效 → 三段结论全错）。

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **MMM-1** | **【核心】同一个「解析错误消息里的行号」的任务，JS 用 `parseInt`（**静默返回错误值**，实测 20 位数字 → `100000000000000000000`）、C++ 用 `std::stoi`（**抛未捕获异常**）** —— **两端的失败模式不同，且 C++ 严格更差** | `packages/react-native/Libraries/LogBox/Data/parseLogBoxLog.js:224-225`；`packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.cpp:120-121` | **C++ 侧会让 RedBox 解析器崩溃（错误根本显示不出来）**；**JS 侧显示一个荒谬的行号**；**补强了 65 文档 EEE-2**（此前只知道 C++ 会抛，现知 JS 静默出错） |
| **MMM-2** | **【核心】C++ 侧有 JS 侧完全没有的 `bundleLoadErrorRegex` 分支**（+ 4 种错误类型的白名单），**且缺少 JS 侧的「先廉价匹配」优化**；**而 C++ 的注释自称「C++ port of parseLogBoxException」** | `packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.cpp:113-137`、`.h:22-24`；`packages/react-native/Libraries/LogBox/Data/parseLogBoxLog.js:266-268` | **「移植」的说法不准确**（实为独立重写）；**同一份消息在 iOS RedBox2 与 LogBox 里展示不同**；**JS 侧无法处理 bundle 加载错误**（落入通用分支，展示不出「Module Not Found」）；**修一处不会修另一处** |
| **MMM-3** | **【核心】`LogBoxSymbolication` 的 `cache` 是模块级 `Map`，与 `logs` 集合的生命周期脱钩** —— **`clear()` 只重建 `logs`、不清缓存**；**该缓存无上限、无淘汰、无自动清理** | `packages/react-native/Libraries/LogBox/Data/LogBoxSymbolication.js:20`；`packages/react-native/Libraries/LogBox/Data/LogBoxData.js:291-295` | **一个真正无界、且无任何自愈的容器**；**每条保存一个 source map 符号化结果 + 一个 promise（可能很大）**；**与 66 文档 FFF-1 的对比见 §4.4**（本条有 `deleteStack`，但生命周期脱钩是 FFF-1 没有的新问题）；**dev-only，严重性低** |
| **MMM-4** | **`logs` 本身是无上限的 `Set`**，但有**两个自动清理触发点**（有调试会话 → `clearWarnings()`；开始追踪 → `clear()`） | `packages/react-native/Libraries/LogBox/Data/LogBoxData.js:69`、`:196-219` | **「无上限但有自愈」** —— **与 FFF-1（无上限且无自愈）不同**；**设计上是有意的** |
| MMM-5 | JS 侧在无行列号时把 `category` 填成字面量 `"1-1"`（而 `codeFrame.location` 是 `null`）→ **一个可能误导的分类键**；**C++ 侧无 `category` 概念** | `packages/react-native/Libraries/LogBox/Data/parseLogBoxLog.js:279-289` | 又一处两端行为差异 |
| MMM-6 | 符号化缓存的 key 是**数组引用**（`Map` 用引用相等）→ **内容相同但数组对象不同会各占一条**；`deleteStack` 同样要求同一引用 | `packages/react-native/Libraries/LogBox/Data/LogBoxSymbolication.js:20`、`:50-52` | **实际影响有限**（每个 log 有自己的 stack 数组）；**但依赖「引用稳定」这一隐含约定** |
| **MMM-7** | **`retrySymbolicate` 会先 `deleteStack` 再重试** → **失败不会被永久缓存** ✓ | `packages/react-native/Libraries/LogBox/Data/LogBoxLog.js:93-106` | ✓ **设计正确**（**本轮一度被我错误地判为缺陷**） |
| **MMM-8** | **`sanitize` 对 `symbolicateStackTrace` 的返回值做了完整校验**（非数组则抛、`collapse` 非布尔则抛） | `packages/react-native/Libraries/LogBox/Data/LogBoxSymbolication.js:25-48` | ✓ **防御充足** —— 与 65 文档 EEE-2 的 C++ 侧形成正反对照 |
| **MMM-9** | **`addLog` 订阅了 `DebuggerSessionObserver` 与 `TracingStateObserver`**，在会话/追踪开始时自动清理 | `packages/react-native/Libraries/LogBox/Data/LogBoxData.js:196-219` | ✓ **自愈机制** |
| **MMM-10** | **一次「零命中」假阴性**：检索根用绝对形式却在子目录下执行 → 沿推理链放大成三条错误结论 | 本轮 | **纪律**：检索必须在仓库根执行；**「零命中」必须用另一条等价检索复核** |

---

## 7. 适用范围声明

| 维度 | MMM-1 / MMM-2 | MMM-3 / MMM-4 |
| --- | --- | --- |
| **平台** | 双端（JS 侧）+ iOS（C++ 侧 RedBox2） | 双端（JS 侧） |
| **架构** | 与架构无关 | 与架构无关 |
| **是否 dev-only** | **是**（RedBox/LogBox 只在开发模式显示） | **是** |
| **触发条件** | ① 行号/列号 > `INT_MAX`；② 错误消息是 bundle 加载错误格式 | 长会话中产生大量不同的 log |
| **当前是否造成功能问题** | **是**（C++ 侧会崩）；**两端展示不一致** | **否**（dev-only，内存增长有限） |
| **是否已实机验证** | **是**（`parseInt` 与 `std::stoi` 均实测；分支差异逐项核对） | **否**（代码级认定） |

---

## 8. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 65 文档 EEE-2：`std::stoi` 越界抛未捕获异常 | **本文 MMM-1 补上了第三处证据** —— 此前只知 C++ 会抛；**现知 JS 侧的 `parseInt` 静默出错** → **三份实现、三种策略**（`from_chars` / `parseInt` / `stoi`），**无任何统一** |
| 65 文档：`RedBoxErrorParser.h` 自称「C++ port of parseLogBoxException」 | **本文 MMM-2 证明该「移植」说法不准确** —— **C++ 多一个分支、少一个性能优化、数字解析策略不同** |
| 66 文档 FFF-1：无上限 + 无丢弃可见性 | **本文 MMM-3 是同类但形态更复杂的变体** —— **有 `deleteStack` 但与主体生命周期脱钩**；**而 MMM-4 的 `logs` 是「无上限但有自愈」** → **同为「无界容器」，风险分三档** |
| 67 文档 GGG-1：需要统一的地方有多份手写副本 | **本文 MMM-2 是同一形态在错误处理层的实例** —— **同一任务两份独立实现，且注释误称为「移植」** |
| 69 文档 III-3：两套互不知情的组件名归一化 | **并列** —— **本文是「同一任务的两份解析器」** |
| 22 文档：iOS RedBox/LogBox 双层门控 | **本文 MMM-2 说明这两层在「同一份错误消息」上会展示不同** —— 门控是分开的，**内容解析也是分开的** |
| 04 文档：崩溃日志的采集与上传 | **本文 MMM-3 是「符号化」环节** —— **04 记录采集上传，本文记录「把栈帧变成可点击源码链接」的那一步** |
| **本轮 §5 的自我纠错** | **与项目初期总结的「探查报告不可采信」是同一条纪律** —— **只不过这次犯错的是自己**；**「零命中」在下结论前必须用另一条等价检索复核** |
