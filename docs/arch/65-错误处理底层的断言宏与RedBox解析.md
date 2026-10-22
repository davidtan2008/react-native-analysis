---
id: 65
title: "错误处理的 C++ 底层：assert 宏的平台不对称、同模块两套数字解析策略、RedBox URL 还原的三个往返损坏"
topic: DG.infra
symptoms: [crash, debug]
platforms: [cross]
architecture: [cross]
layer: T1
symbols: ["react_native_assert", "react_native_expect", "RedBoxErrorParser", "JscSafeUrl", "StackTraceParser"]
claims: [EEE-1, EEE-1b, EEE-2, EEE-3, EEE-4, EEE-5, EEE-6, EEE-7]
---
# 65 · 错误处理的 C++ 底层：assert 宏的平台不对称、同模块两套数字解析策略、RedBox URL 还原的三个往返损坏

> **模块**：A4 · `packages/react-native/ReactCommon/react/debug/`（11 文件）
> + `packages/react-native/ReactCommon/jserrorhandler/`（6 文件）+ `Libraries/LogBox/`（JS 侧）
>
> **基线**：react-native @ `9b131e42` · 双端 C++ · **与架构无关**
>
> **前置**：[04 文档](./04-崩溃日志捕获收集处理上传.md) 记录崩溃采集与上传全链路；
> [22 文档](./22-iOS崩溃UI层RedBox与LogBox.md) 记录 iOS RedBox/LogBox 双层门控；
> [41 文档](./41-Android崩溃与错误路径.md) 记录 Android 崩溃路径；
> [43 文档](./43-JS异常三级路由与unhandled-rejection.md) 记录 JS 异常三级路由；
> [59 文档](./59-Promise的reject跨平台契约.md) 记录跨平台错误契约；
> [63 文档](./63-ReactCommon工具层的浮点相等与哈希契约.md) 记录「锁内执行用户代码」；
> [64 文档](./64-渲染器基础设施的注册表与DOM层.md) 记录 JS 可控的栈溢出向量。
>
> 本文记录 A4 底层的五条结论，其中三条**经过编译运行实测**：
> ① **【核心】`react_native_expect` 与 iOS 版 `react_native_assert` 是裸 `if` 宏**，
> **与 Android 版（表达式形式）平台不对称** —— 实测出**静默改变语义**的形态；
> ② **【核心】同一个「解析错误消息里的行号」的任务，本模块存在两套策略** ——
> `StackTraceParser` 用 `std::from_chars` 安全返回 `nullopt`，
> **`RedBoxErrorParser` 用 `std::stoi` 抛未捕获异常**（实测 `out_of_range`）；
> ③ **【核心】`JscSafeUrl` 的 `toJscSafeUrl`/`toNormalUrl` 有三个往返损坏**（实测）。

---

## 1. 文件构成

| 目录 | 文件数 | 职责 |
| --- | --- | --- |
| `packages/react-native/ReactCommon/react/debug` | 11 | `react_native_assert` / `react_native_expect` 宏、`flags.h`、RedBox 的 ANSI/URL/错误消息解析器 |
| `packages/react-native/ReactCommon/jserrorhandler` | 6 | `JsErrorHandler`（C++ 侧错误中枢）、`ErrorUtils`、`StackTraceParser`（5 种 JS 引擎的栈格式解析） |
| `packages/react-native/Libraries/LogBox` | 30+ | JS 侧 LogBox UI 与数据层 |

**本轮完整读完 9 个 C++ 文件**（`react/debug` 的 6 个 + `redbox` 的 3 个头文件 + `jserrorhandler/StackTraceParser.h/.cpp`），
并以 iOS 侧 `RCTRedBox2ErrorParser.mm` / `RCTRedBox2Controller.mm` 作为可达性证据。

---

## 2. 【核心 EEE-1】assert/expect 宏的平台不对称与「悬挂 if」

### 2.1 三种宏定义，逐字对照

```cpp
// packages/react-native/ReactCommon/react/debug/react_native_assert.h:29-33
#ifndef REACT_NATIVE_DEBUG

#define react_native_assert(e) ((void)0)

#else // REACT_NATIVE_DEBUG
```

**Android 路径（表达式形式，安全）**：

```cpp
// packages/react-native/ReactCommon/react/debug/react_native_assert.h:48
#define react_native_assert(e) ((e) ? (void)0 : react_native_assert_fail(__func__, __FILE__, __LINE__, #e))
```

**非 Android 路径（裸 `if` 宏）**：

```cpp
// packages/react-native/ReactCommon/react/debug/react_native_assert.h:58-63
#define react_native_assert(cond)                           \
  if (!(cond)) {                                            \
    LOG(ERROR) << "react_native_assert failure: " << #cond; \
    google::FlushLogFiles(google::GLOG_INFO);               \
    assert(cond);                                           \
  }
```

**`react_native_expect` 同样**（且**只有**裸 `if` 版本，**没有 Android 特化**）：

```cpp
// packages/react-native/ReactCommon/react/debug/react_native_expect.h:31-35
#define react_native_expect(cond)                           \
  if (!(cond)) {                                            \
    LOG(ERROR) << "react_native_expect failure: " << #cond; \
  }
```

### 2.2 三者的形态对照

| 宏 | 平台 | 形态 | 是否可作为表达式 |
| --- | --- | --- | --- |
| `react_native_assert` | **release（无 `REACT_NATIVE_DEBUG`）** | `((void)0)` | ✅ |
| `react_native_assert` | **Android debug** | **三元表达式** | ✅ |
| `react_native_assert` | **非 Android debug** | **裸 `if { }`** | ❌ |
| `react_native_expect` | **release** | `((void)0)` | ✅ |
| `react_native_expect` | **debug（所有平台）** | **裸 `if { }`** | ❌ |

> **即：Android 的 assert 是安全的表达式形式，其余平台的 assert 与所有平台的 expect 都是裸 `if` 形式。**

### 2.3 实测：裸 `if` 宏的三种使用形态

**用与 `react_native_expect.h` 逐字相同的定义复刻**（把 `LOG(ERROR)` 换成 `printf`）：

| 形态 | 写法 | 编译结果 | 运行结果 |
| --- | --- | --- | --- |
| **A**：`if` 后**写分号** + 有 `else` | `if (a) react_native_expect(b); else calls++;` | **编译错误**（`else` 无法匹配） | — |
| **B**：`if` 后**不写分号** + 有 `else` | `if (a) react_native_expect(b)`⏎`else calls++;` | **仅 `-Wdangling-else` 警告**（默认不开） | **语义静默改变** |
| **C**：无 `else` | `if (a) react_native_expect(b);` | 通过 | 语义正确 |

**形态 B 的实测输出**：

```
形态 B（不写分号 + 有 else）: a=0 → else 执行次数 = 0
形态 B: a=1 → else 执行次数 = 0
```

**`a=0` 时期望走 `else`（`calls++`），实测 `calls++` 一次都没执行。**

**原因**：宏展开后

```cpp
if (a)                 // 外层 if
  if (!(b)) { printf(...); }   // 内层 if（来自宏）
  else                 // ← 这个 else 绑定到了【内层】if！
    calls++;
```

→ `a=0` 时**整个 if-else 都不执行** → **本该执行的 `else` 分支被静默跳过**。

### 2.4 公平说明：**全仓 457 处引用行（含 2 个宏定义头文件）当前零危险形态**

**实测**：扫描 `packages/react-native/` 全部 `.cpp/.h/.mm`，
查找「`if (...)` 行末无 `{` 且下一行是裸 `react_native_expect(`/`react_native_assert(`」的模式 ——
**命中 0 处**（所有 `if` 都带花括号）。

| 项 | 判定 |
| --- | --- |
| **当前是否造成功能问题** | **否** |
| **风险类型** | **结构脆弱** —— 代码正确，但改动一行即引入 bug |
| **触发条件** | 有人写成 `if (x) react_native_expect(y)`（不写分号）且上下文有 `else` |
| **正确修法** | 改成 `do { ... } while (0)` 形式（并去掉结尾分号要求） |

> **与 63 文档 CCC-4 的对照**：63 记录的是「锁内执行用户代码」；
> **本文是「宏展开改变了宿主的控制流」** ——
> **两者都是「局部写法正确、全局语义可能被改变」的同一类脆弱性**。

### 2.5 另一处平台不对称：**iOS 的 `assert(cond)` 在 `NDEBUG` 下是空操作**

```cpp
// packages/react-native/ReactCommon/react/debug/react_native_assert.h:59-62
    LOG(ERROR) << "react_native_assert failure: " << #cond; \
    google::FlushLogFiles(google::GLOG_INFO);               \
    assert(cond);                                           \
```

**Android 路径的 `react_native_assert_fail` 会 `__android_log_assert` → abort（必然终止）**；
**非 Android 路径依赖 `assert(cond)`，而 `assert` 在 `NDEBUG` 定义时是空操作**。

| 宏组合 | Android | 非 Android |
| --- | --- | --- |
| `REACT_NATIVE_DEBUG` + 无 `NDEBUG` | **abort** | **abort** |
| `REACT_NATIVE_DEBUG` + 有 `NDEBUG` | **abort** | **只打日志，不中止** ⚠️ |

**而 `flags.h` 让 `REACT_NATIVE_DEBUG` 与 `NDEBUG` 相互独立**：

```cpp
// packages/react-native/ReactCommon/react/debug/flags.h:16-22
#if !(defined(REACT_NATIVE_DEBUG) || defined(REACT_NATIVE_PRODUCTION))
#ifdef NDEBUG
#define REACT_NATIVE_PRODUCTION
#else
#define REACT_NATIVE_DEBUG
#endif
#endif
```

**即：只要显式定义 `REACT_NATIVE_DEBUG`，`NDEBUG` 的值就不再影响 `REACT_NATIVE_DEBUG`** ——
**于此同时 `NDEBUG` 仍会让 `assert()` 失效** → **上表第 2 行可达**。

**注释里的 `REACT_NATIVE_PRODUCTION` 在 `react_native_assert.h` / `react_native_expect.h` 中从未被使用** ——
两处都只检查 `!REACT_NATIVE_DEBUG`。

### 2.6 `flags.h` 的一处「无 header guard」的刻意设计

```cpp
// packages/react-native/ReactCommon/react/debug/react_native_assert.h:8-9
// No header guards since it is legitimately possible to include this file more
// than once with and without REACT_NATIVE_DEBUG.
```

**配合 `#undef react_native_assert` + 重新 `#define`** —— **每次包含都重新求值**，
与 62 文档 BBB-5 描述的 `RN_UMBRELLA_CONTEXT` 思路**同源**（都是「让宏在每次包含时重新决定」）。

**但两处有差别**：

| | `UmbrellaGuard.h` | `react_native_assert.h` |
| --- | --- | --- |
| 依赖的宏 | `RN_UMBRELLA_CONTEXT`（由 umbrella 显式 push/pop） | `REACT_NATIVE_DEBUG`（由 `flags.h` 派生） |
| **`flags.h` 自身有 `#pragma once`** | — | ✅ → **`REACT_NATIVE_DEBUG` 在一个 TU 内只会派生一次** |
| 重复包含的实际效果 | 重新求值守卫条件 | 重新定义 `react_native_assert`（值相同） |

**结论**：注释描述的场景（同一 TU 内 `REACT_NATIVE_DEBUG` 前后不一致）**需要有人在 include 之间改 `NDEBUG`** ——
**极罕见，但防御是零成本的**。

### 2.7 Android 的 `react_native_assert_fail` 设计良好

```cpp
// packages/react-native/ReactCommon/react/debug/react_native_assert.cpp:22-35
extern "C" void react_native_assert_fail(
    const char* func, const char* file, int line, const char* expr) {
  // Print as an error so it shows up in logcat before crash...
  __android_log_print(ANDROID_LOG_ERROR, "ReactNative", "%s:%d: function %s: assertion failed (%s)", file, line, func, expr);
  // ...and trigger an abort so it crashes and shows up in uploaded logs.
  __android_log_assert(nullptr, "ReactNative", "%s:%d: function %s: assertion failed (%s)", file, line, func, expr);
}
```

**两次输出，一次打日志（崩溃前可见）、一次触发 abort（保证进崩溃日志）** —— **注释把意图写清楚了** ✓。

---

## 3. 【核心 EEE-2】同模块两套数字解析策略：一套安全、一套抛未捕获异常

### 3.1 安全的那一套：`StackTraceParser::toInt`

```cpp
// packages/react-native/ReactCommon/jserrorhandler/StackTraceParser.cpp:29-38
std::optional<int> toInt(std::string_view input) {
  int out;
  const std::from_chars_result result =
      std::from_chars(input.data(), input.data() + input.size(), out);
  if (result.ec == std::errc::invalid_argument ||
      result.ec == std::errc::result_out_of_range) {
    return std::nullopt;
  }
  return out;
}
```

**`std::from_chars` + 显式处理两种错误码 + 返回 `std::optional`** ✓ —— **不抛异常**。

### 3.2 抛异常的那一套：`RedBoxErrorParser` 的 `std::stoi`

```cpp
// packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.cpp:76-90
  if (std::regex_search(message, match, bundleLoadErrorRegex())) {
    const auto& errorType = match[1].str();
    if (knownBundleLoadErrorTypes().count(errorType) > 0) {
      ...
      return ParsedError{
          ...
              CodeFrame{
                  .content = codeFrameContent.value_or(""),
                  .fileName = match[2].str(),
                  .row = std::stoi(match[4].str()),
                  .column = std::stoi(match[5].str()),
              },
```

**`std::stoi` 在越界时抛 `std::out_of_range`，而 `parseErrorMessage` 没有任何 `try/catch`。**

**同样的 `std::stoi` 还出现在另外两个分支**（Metro 错误 `:70-71`、Babel transform 错误 `:90-91`）。

### 3.3 实测：`std::stoi` 的越界行为

| 输入 | 实测结果 |
| --- | --- |
| `std::stoi("12")` | `12` |
| `std::stoi("2147483648")`（超过 `INT_MAX`） | **抛 `std::out_of_range`** |
| `std::stoi("99999999999999999999")`（20 位） | **抛 `std::out_of_range`** |

### 3.4 完整的可达性链条

| 步骤 | 位置 | 证据 |
| --- | --- | --- |
| ① JS 抛出一个 `Error`，其 `message` 形如 `TypeError in /a/b.js: xxx (99999999999999999999:1)` | — | **message 内容完全由 JS 决定** |
| ② iOS RedBox 控制器调用 C++ 解析器 | `packages/react-native/React/CoreModules/RCTRedBox2Controller.mm:285` | `_errorData = [RCTRedBox2ErrorParser parseErrorMessage:message name:nil componentStack:nil isFatal:YES];` |
| ③ ObjC 桥接层调用 C++，**无 try/catch** | `packages/react-native/React/CoreModules/RCTRedBox2ErrorParser.mm:47-52` | `auto parsed = parseErrorMessage((message != nullptr) ? std::string(message.UTF8String) : std::string(), ...)` |
| ④ C++ 解析器调用 `std::stoi` | `packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.cpp:85`、`:86` | **抛 `std::out_of_range`** |

**触发条件**（三个都要满足）：

| # | 条件 | 说明 |
| --- | --- | --- |
| ① | 消息匹配 `^(\w+) in (\S+): (.+) \((\d+):(\d+)\)` | `bundleLoadErrorRegex` |
| ② | 错误类型 ∈ {`SyntaxError`, `ReferenceError`, `TypeError`, `UnableToResolveError`} | `knownBundleLoadErrorTypes()` |
| ③ | **行号或列号 > `INT_MAX`** | `std::stoi` 越界 |

**条件 ② 的四个类型都是 JS 的标准错误类型名** —— **JS 完全可以构造出满足全部三条的消息**。

### 3.5 对照表：同一个模块，两种策略

| | `StackTraceParser::toInt` | `RedBoxErrorParser` 的 `std::stoi` |
| --- | --- | --- |
| 解析方式 | `std::from_chars` | `std::stoi` |
| 越界行为 | **返回 `std::nullopt`** | **抛 `std::out_of_range`** |
| 调用方是否处理 | 不需要 | **无 try/catch → 异常逃逸** |
| 输入是否可控 | 栈帧行号（引擎生成） | **错误消息（JS 完全可控）** |

> **这是本文最有说服力的一条**：
> **同一个「把字符串解析成整数」的任务，同一个错误处理模块内有两套实现**，
> **一套用了 `from_chars` 并显式处理 `result_out_of_range`，另一套用了会抛异常的 `stoi`** ——
> **而后者处理的输入恰恰是 JS 完全可控的**。
>
> **修复成本极低**：把 `std::stoi` 换成 `toInt` 同款写法即可。

### 3.6 顺带：`RedBoxErrorParser` 的正则本身也有回溯风险

```cpp
// packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.cpp:33-35
const std::regex& babelCodeFrameErrorRegex() {
  static const std::regex re(
      R"(^(?:TransformError )?(?:.*):? (?:.*?)(\/.*): ([\s\S]+?)\n([ >]{2}[\d\s]+ \|[\s\S]+|\x1b[\s\S]+))");
```

**含 `(?:.*):? (?:.*?)` 与 `([\s\S]+?)` 的组合** —— **存在灾难性回溯（ReDoS）的构造**。
**输入是 JS 可控的错误消息**。

**更关键的是：截断只作用于一处，解析用的是未截断的原文**：

```objc
// packages/react-native/React/CoreModules/RCTRedBox2Controller.mm:279-285
    // unlimited length, so we truncate it
    _lastErrorMessage = [messageWithoutAnsi substringToIndex:MIN((NSUInteger)10000, messageWithoutAnsi.length)];
    _lastErrorCookie = errorCookie;

    // Parse the message to extract structure (title, code frame, etc.)
    _errorData = [RCTRedBox2ErrorParser parseErrorMessage:message name:nil componentStack:nil isFatal:YES];
```

| 变量 | 是否截断 | 用途 |
| --- | --- | --- |
| `_lastErrorMessage` | ✅ 截断到 10000 字符 | 重试时展示 |
| **`message`（传给解析器的）** | ❌ **未截断** | **正则匹配 + `std::stoi`** |

**即截断的意图（「unlimited length」）并没有覆盖到真正做正则匹配的那个输入。**

---

## 4. 【核心 EEE-3】`JscSafeUrl` 的三个往返损坏（实测）

### 4.1 背景与设计

```cpp
// packages/react-native/ReactCommon/react/debug/redbox/JscSafeUrl.h:13-21
/**
 * These functions are for handling of query-string free URLs, necessitated
 * by query string stripping of URLs in JavaScriptCore stack traces
 * introduced in iOS 16.4. This is a direct port of https://www.npmjs.com/package/jsc-safe-url.
 *
 * See https://github.com/facebook/react-native/issues/36794 for context.
 */
```

**背景**：iOS 16.4 起 JSC 的栈帧 URL 会被剥掉 query string，
所以 RN 用「把 query 塞进 path」的方式把 URL 编码成 JSC-safe 形式，再在展示时还原。

**编码约定**：query 部分用 **`//&`** 作分隔符，query 里的 `?` 编码成 **`%3F`**。

```cpp
// packages/react-native/ReactCommon/react/debug/redbox/JscSafeUrl.cpp:143-153
  if (hasQuery) {
    result += "//&";
    for (char c : parsed.queryWithoutQuestionMark) {
      if (c == '?') {
        result += "%3F";
      } else {
        result += c;
      }
    }
  }
```

**还原时用「第一个 `//&`」作为分隔符**：

```cpp
// packages/react-native/ReactCommon/react/debug/redbox/JscSafeUrl.cpp:106-109
  auto parsed = rfc3986Parse(url);
  auto markerPos = parsed.path.find("//&");
  if (markerPos == std::string_view::npos) {
    return url;
  }
```

### 4.2 实测：三个往返结果

**用与源码逐字等价的复刻编译运行**：

| 输入 URL | JSC-safe 形式 | 还原结果 | 判定 |
| --- | --- | --- | --- |
| `http://x/p?a=1&b=2` | `http://x/p//&a=1&b=2` | `http://x/p?a=1&b=2` | ✅ 往返一致 |
| `http://x/p?a=1?b=2` | `http://x/p//&a=1%3Fb=2` | `http://x/p?a=1%3Fb=2` | ❌ **query 里的 `?` 变成字面 `%3F`，不可逆** |
| `http://x/a//&b?c=1` | `http://x/a//&b&c=1` | `http://x/a?b&c=1` | ❌ **path 里的 `//&` 被误当分隔符，`//&b` 丢失** |
| `http://x//&p?c=1` | — | **抛 `std::invalid_argument`** | ❌ **一个正常 URL 直接抛异常** |
| `http://x/p?q=//&` | `http://x/p//&q=//&` | `http://x/p?q=//&` | ✅ 往返一致 |

### 4.3 三条成因

| # | 成因 | 根因 |
| --- | --- | --- |
| ① | **query 中的 `?` 不可逆** | `toJscSafeUrl` 把 `?` → `%3F`，但 **`toNormalUrl` 不做 `%3F` 解码** —— **编码不对称** |
| ② | **path 含 `//&` 时分隔符歧义** | `toJscSafeUrl` **不检查 path 是否已含 `//&`**；`toNormalUrl` 用 `find`（**第一个**匹配） |
| ③ | **path 以 `//&` 开头时抛异常** | `toJscSafeUrl` 先调 `toNormalUrl` → path 被截成空 → 触发 `parsed.path.empty()` 的抛异常分支 |

**第 ③ 条的完整链条**：

```cpp
// packages/react-native/ReactCommon/react/debug/redbox/JscSafeUrl.cpp:130-136
  url = toNormalUrl(std::move(url));
  auto parsed = rfc3986Parse(url);
  if (!parsed.queryWithoutQuestionMark.empty() &&
      (parsed.path.empty() || parsed.path == "/")) {
    throw std::invalid_argument(
        "The given URL \"" + url +
        "\" has an empty path and cannot be converted to a JSC-safe format.");
  }
```

**`http://x//&p?c=1`** → `toNormalUrl` → path=`//&p` → `find("//&")`=0 → pathBefore=`""` → pathAfter=`"p"` → 还原成 `http://x?p` → **path 变空** → 抛异常。

### 4.4 影响范围

**`JscSafeUrl` 的唯一消费者**是 iOS 侧的 RedBox 栈帧链接：

```cpp
// packages/react-native/React/CoreModules/RCTJscSafeUrl.mm:15-17
using facebook::react::unstable_redbox::isJscSafeUrl;
using facebook::react::unstable_redbox::toJscSafeUrl;
using facebook::react::unstable_redbox::toNormalUrl;
```

| 后果 | 说明 |
| --- | --- |
| **①** | 崩溃栈里含 `?` 的 URL → 展示给用户的链接**带着字面 `%3F`**，点开是坏链接 |
| **②** | 路径含 `//&` 的 URL → 还原后**路径被截断**，指向错误的文件 |
| **③** | 路径以 `//&` 开头的 URL → **抛 `std::invalid_argument`** → 若调用方无 try/catch 则**异常逃逸** |

### 4.5 公允说明：**上游 `jsc-safe-url` 包本身可能也有同样的缺陷**

**注释明说这是 `jsc-safe-url` 的直接移植**：
`This is a direct port of https://www.npmjs.com/package/jsc-safe-url.`

**因此第 ① 条（`%3F` 不对称）很可能是上游缺陷的忠实移植** ——
**修复时应同时向上游反馈**。

**但第 ② ③ 条（分隔符歧义与抛异常）是本仓库可独立加固的部分**：
`toJscSafeUrl` 可以在编码前检查 path 是否含 `//&`，`toNormalUrl` 可以用 `rfind`（**最后一个**）而不是 `find`。

### 4.6 正向：`rfc3986Parse` 的注释与引用规范

```cpp
// packages/react-native/ReactCommon/react/debug/redbox/JscSafeUrl.cpp:26-33
// We use regex-based URL parsing as defined in RFC 3986 because it's easier to
// determine whether the input is a complete URI, a path-absolute or a
// path-rootless (as defined in the spec), and be as faithful to the input as
// possible. This will match any string, and does not imply validity.
//
// https://www.rfc-editor.org/rfc/rfc3986#appendix-B
```

**说明了「为什么用正则而不是手写解析器」（更忠实于输入）**、**给出了规范出处**、
**并明确声明「会匹配任何字符串，不代表有效」** ✓ —— **第一档注释**。

**同时 `uriRegex()` 用函数内 `static const`（C++11 起线程安全的一次性初始化）** ✓。

---

## 5. 【核心 EEE-4】`ParsedError::isRetryable` 恒为 `true`，消费分支永不执行

### 5.1 字段定义与默认值

```cpp
// packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.h:24-30
struct ParsedError {
  std::string title;
  std::string message;
  std::optional<CodeFrame> codeFrame;
  bool isCompileError = false;
  bool isRetryable = true;
};
```

### 5.2 实测：**7 处构造，0 处设置该字段**

| 位置 | 构造次数 | 设置 `isRetryable` 的次数 |
| --- | --- | --- |
| `packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.cpp` | **7** | **0** |

**即 `isRetryable` 恒为默认值 `true`。**

### 5.3 它确实有消费者

```objc
// packages/react-native/React/CoreModules/RCTRedBox2ErrorParser.mm:24
  data.isRetryable = parsed.isRetryable;
```

```objc
// packages/react-native/React/CoreModules/RCTRedBox2Controller.mm:349-356
- (void)startAutoRetryIfApplicable
{
  [self stopAutoRetry];
  if (!_errorData.isRetryable) {
    return;
  }
  _autoRetryCountdown = (NSInteger)kAutoRetryInterval;
```

**即「不可重试 → 不启动自动重试倒计时」这个分支永不执行** —— **iOS RedBox 总是会自动重试**。

| 项 | 判定 |
| --- | --- |
| 是否缺陷 | **无法判定** —— C++ 解析器**没有任何机制**能产出 `isRetryable == false`；字段存在是为了将来使用 |
| 风险类型 | **死字段 / 预留字段**（不是「错误的实现」） |
| 后果 | **当前无功能影响**；但**未来若有人只在 C++ 侧设置该字段，行为会立刻改变**，而**今天无法从 iOS 侧设置** |

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **EEE-1** | **【核心】`react_native_expect` 与非 Android 版 `react_native_assert` 是裸 `if` 宏**（无 `do{}while(0)`），而 **Android 版 `react_native_assert` 是三元表达式** → **平台不对称**；实测形态 B（`if` 后不写分号 + 有 `else`）**静默改变语义**（`else` 分支被跳过），仅 `-Wdangling-else` 警告（默认不开） | `packages/react-native/ReactCommon/react/debug/react_native_assert.h:58-63`、`:48`；`packages/react-native/ReactCommon/react/debug/react_native_expect.h:31-35` | **当前零危险形态**（实测全仓 457 处引用行（含 2 个宏定义头文件），`if` 无花括号 + 裸宏的组合命中 **0**）→ **结构脆弱**；**正确修法：`do { } while (0)`** |
| **EEE-1b** | **平台不对称：`REACT_NATIVE_DEBUG` + `NDEBUG` 的组合下，Android 的 assert 仍 `abort`，非 Android 的只打日志不中止**（`assert(cond)` 在 `NDEBUG` 下是空操作） | `react_native_assert.h:59-62`；`react_native_assert.cpp:31-35`；`packages/react-native/ReactCommon/react/debug/flags.h:16-22` | `flags.h` 让两者**相互独立** → 该组合可达；**「debug 下不中止」的平台差异** |
| **EEE-2** | **【核心】`RedBoxErrorParser` 的 `std::stoi` 越界抛 `std::out_of_range`，`parseErrorMessage` 无 try/catch**；**输入（错误消息）由 JS 完全可控**；实测 `2147483648` 与 20 位数字均抛异常；**同模块的 `StackTraceParser::toInt` 用 `std::from_chars` 安全返回 `nullopt`** → **两套策略并存** | `packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.cpp:70-71`、`:85-86`、`:90-91`；`packages/react-native/ReactCommon/jserrorhandler/StackTraceParser.cpp:29-38`；`packages/react-native/React/CoreModules/RCTRedBox2ErrorParser.mm:47` | **未捕获异常逃逸出 RedBox 解析器**；**触发条件**：消息匹配 `^(\w+) in (\S+): (.+) \((\d+):(\d+)\)` + 类型 ∈ 4 种标准错误名 + **行号 > `INT_MAX`**（**JS 可构造**）；**修复成本极低** |
| **EEE-3** | **【核心】`JscSafeUrl` 的 `toJscSafeUrl`/`toNormalUrl` 有三个往返损坏**（实测）：① query 中的 `?` 被编码成 `%3F` 但**还原不解码** → 不可逆；② **path 含 `//&` 时 `find` 误取第一个** → 路径被截断；③ **path 以 `//&` 开头时抛 `std::invalid_argument`**（一个正常 URL） | `packages/react-native/ReactCommon/react/debug/redbox/JscSafeUrl.cpp:106-109`、`:130-136`、`:143-153` | **iOS RedBox 栈帧链接损坏**（坏链接 / 指向错误文件 / 抛异常）；**① 可能是上游 `jsc-safe-url` 的忠实移植**（应同时向上游反馈），**② ③ 可本地加固** |
| **EEE-4** | **【核心】`ParsedError::isRetryable` 恒为 `true`**（7 处构造 0 处设置），而 iOS `startAutoRetryIfApplicable` 有 `if (!_errorData.isRetryable) return;` 分支 | `packages/react-native/ReactCommon/react/debug/redbox/RedBoxErrorParser.h:29`、`.cpp`（7 处构造）；`packages/react-native/React/CoreModules/RCTRedBox2Controller.mm:352` | **该分支永不执行**；**当前无功能影响**（属预留字段），但**今天无法从 C++ 侧产出 `false`** |
| **EEE-5** | **RedBox 消息的截断只作用于 `_lastErrorMessage`，真正做正则匹配的 `message` 未截断** | `packages/react-native/React/CoreModules/RCTRedBox2Controller.mm:281-285` | 截断意图（「unlimited length」）**未覆盖到正则与 `std::stoi` 的实际输入**；叠加 `babelCodeFrameErrorRegex` 的 `(?:.*):? (?:.*?)` + `([\s\S]+?)` 组合 → **ReDoS 构造**（输入 JS 可控） |
| EEE-6 | `react_native_expect.h` 的裸 `if` 宏**没有 Android 特化**（与 `react_native_assert` 不同） | `packages/react-native/ReactCommon/react/debug/react_native_expect.h:31-35` | Android 的 expect 也是裸 if 形式（与 assert 不同） |
| EEE-7 | `flags.h` 定义的 `REACT_NATIVE_PRODUCTION` 在 `react_native_assert.h` / `react_native_expect.h` 中**从未被使用**（两处只判 `!REACT_NATIVE_DEBUG`） | `packages/react-native/ReactCommon/react/debug/flags.h:19`、`:21` | 语义冗余（`REACT_NATIVE_PRODUCTION` ≡ `!REACT_NATIVE_DEBUG`） |
| **EEE-8（正向）** | **`StackTraceParser::toInt` 用 `std::from_chars` + 显式处理 `invalid_argument` 与 `result_out_of_range`**，返回 `std::optional` —— **不抛异常** | `packages/react-native/ReactCommon/jserrorhandler/StackTraceParser.cpp:29-38` | **与 EEE-2 形成同模块内的直接对照** —— **正确做法已在仓库里存在，只需复用** |
| **EEE-9（正向）** | **`rfc3986Parse` 的注释给出 RFC 3986 出处、说明「为什么用正则」「会匹配任何字符串不代表有效」**；`uriRegex()` 用函数内 `static const`（线程安全的一次性初始化） | `packages/react-native/ReactCommon/react/debug/redbox/JscSafeUrl.cpp:26-33`、`:34-38` | **第一档注释** |
| **EEE-10（正向）** | **Android 的 `react_native_assert_fail` 两次输出并注释说明意图**（先 `__android_log_print` 让崩溃前可见、再 `__android_log_assert` 保证进崩溃日志） | `packages/react-native/ReactCommon/react/debug/react_native_assert.cpp:22-35` | **注释写清了「为什么两次」** |
| **EEE-11（正向）** | **`react_native_assert.h` 的头部注释解释了「为什么可以不用 header guard」**，并给出 `assert` 与 `expect` 的选用准则（可恢复/用户错误 → `expect`；内部不变量 → `assert`） | `packages/react-native/ReactCommon/react/debug/react_native_assert.h:8-21`；`react_native_expect.h:8-17` | **把「什么时候用哪个」写清楚了** —— 与 EEE-1 的实现缺陷形成对照：**准则清晰，实现有瑕疵** |

---

## 7. 适用范围声明

| 维度 | EEE-1 / EEE-1b | EEE-2 | EEE-3 | EEE-4 |
| --- | --- | --- | --- | --- |
| **平台** | 非 Android 侧（裸 if 宏）/ Android 侧（表达式形式） | **iOS**（`RCTRedBox2*`） | **iOS** | **iOS** |
| **架构** | 与架构无关 | 与架构无关（RedBox 错误 UI） | 与架构无关 | 与架构无关 |
| **编译条件** | EEE-1：`REACT_NATIVE_DEBUG`；EEE-1b：额外需 `NDEBUG` | 无 | 无 | 无 |
| **是否 dev-only** | **是**（release 下宏为 `((void)0)`） | **是**（RedBox 仅 dev 显示） | **是** | **是** |
| **输入可控性** | — | **JS 完全可控**（错误消息） | **JS 可控**（栈帧 URL） | — |
| **当前是否造成功能问题** | **否**（零危险形态） | **是**（异常逃逸） | **是**（链接损坏） | **否**（预留字段） |
| **是否实机验证** | **是**（编译运行复刻） | **是**（编译运行复刻 `std::stoi`） | **是**（编译运行复刻全流程） | 否（静态认定） |

> **重要提醒**：EEE-1 / EEE-2 / EEE-3 / EEE-4 **全部位于 RedBox/LogBox 这条 dev-only 的错误展示链路上**。
> **它们不会影响生产环境的业务逻辑或稳定性** ——
> **但 EEE-2 与 EEE-3 会让「开发期排查问题」本身变得不可靠**（RedBox 崩掉 / 源码链接点不开）。

---

## 8. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 04 文档：崩溃采集与上传全链路 | **本文补上「错误消息如何被解析成结构化数据」这一环** —— 04 记录了错误如何被捕获与上报，**本文记录它如何被展示**（RedBox2 → C++ 解析器 → `ParsedError` → ObjC） |
| 22 文档：iOS RedBox/LogBox 双层门控 | **本文是 22 文档的下游** —— 22 记录「何时显示 RedBox」，**本文记录「显示时的内容是怎么解析出来的」**，并发现该解析层有 3 个实测缺陷 |
| 41 文档：Android 崩溃与错误路径 | **平台对照**：Android 的 `react_native_assert_fail` 会 abort 并写 logcat（EEE-10），**iOS 侧的对应链路在本文 EEE-2/EEE-3** |
| 43 文档：JS 异常三级路由 | **本文 EEE-2 的起点** —— JS 异常经三级路由后落到 RedBox，**而 RedBox 的解析器对 JS 可控的消息缺少数字边界检查** |
| 63 文档 CCC-4：锁内执行用户代码 | **对照 EEE-1** —— 两者都是「局部写法正确、全局语义可能被改变」：63 是并发语义，**本文是控制流语义** |
| 64 文档 DDD-2：JS 可控的栈溢出 | **并列** —— 64 是「树太深 → 栈溢出」，**本文 EEE-2 是「数字太大 → 异常逃逸」**；**两者都是 JS 可控的崩溃向量，且都在 dev-only 链路上** |
| 59 文档 YY-3：注释锚点失效 | **对照 EEE-9/EEE-10** —— 本模块的注释**全部有效且是第一档**（给了 RFC 出处、解释了「为什么两次输出」、解释了「为什么不用 header guard」）—— **与 59 文档的失效锚点形成鲜明对照** |
| 50 文档 PP-1/PP-3：JNI 层防御不足 | **对照 EEE-8** —— `StackTraceParser::toInt` 的 `from_chars` + 显式错误处理是**防御充足**的正样本，**说明正确做法在本仓库已经存在**（只是没被复用） |
