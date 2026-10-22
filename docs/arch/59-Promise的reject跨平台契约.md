---
id: 59
title: "Promise 的 reject 契约：双平台两个不同的栈键名、50 帧硬上限、以及 JS 侧零消费者的 `nativeStack*`"
topic: FD.promise
symptoms: [bridge, crash]
platforms: [cross]
architecture: [cross]
layer: T2
symbols: ["PromiseImpl", "updateErrorFromErrorData"]
claims: [YY-1, YY-2, YY-3, YY-4, YY-5]
---
# 59 · Promise 的 reject 契约：双平台两个不同的栈键名、50 帧硬上限、以及 JS 侧零消费者的 `nativeStack*`

> **模块**：C2 + C1 ·
> `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt`（240）、
> `packages/react-native/React/Base/RCTUtils.mm:551-565`、
> `packages/react-native/Libraries/BatchedBridge/NativeModules.js`（225）
>
> **基线**：react-native @ `9b131e42` · 双端 · **仅 legacy 架构（Bridge）**
>
> **前置**：[54 文档](./54-iOS参数转换层的构建分层防护.md) 记录 legacy 桥接的构建分层问题；
> [23 文档](./23-iOS基础工具层ConvertAssertLogUtils.md) 记录 iOS 的 `RCTConvert`/`RCTAssert`/`RCTLog`；
> [41 文档](./41-Android崩溃与错误路径.md) 记录崩溃采集。
>
> 本文记录 `Promise.reject` 的**跨平台错误载荷契约**：
> 双平台**产出两个不同键名的原生栈**（`nativeStackAndroid` / `nativeStackIOS`），
> 帧数上限硬编码为 **50**，而**JS 侧没有任何消费者**——
> 只用一次 `Object.assign` 把它们原样挂到 Error 上。

---

## 1. 三层结构

| 层 | 文件 | 行数 | 职责 |
| --- | --- | --- | --- |
| **Android 产出** | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt` | 240 | 构造 `WritableNativeMap` 错误载荷 |
| **iOS 产出** | `packages/react-native/React/Base/RCTUtils.mm` | — | `RCTJSErrorFromCodeMessageAndNSError` |
| **JS 消费** | `packages/react-native/Libraries/BatchedBridge/NativeModules.js` | 225 | `updateErrorWithErrorData` |

---

## 2. 【核心 YY-1】双平台两个不同的栈键名

### 2.1 Android 侧的键名与注释

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:176-180
    // Attach a nativeStackAndroid array if a throwable was passed
    // this matches iOS behavior - iOS adds a `nativeStackIOS` property
    // iOS: /React/Base/RCTUtils.m -> RCTJSErrorFromCodeMessageAndNSError
    if (throwable != null) {
      errorInfo.putString(ERROR_MAP_KEY_NAME, throwable.javaClass.canonicalName)
```

**注释第一句说「matches iOS behavior」，第二句立刻指出 iOS 用的是另一个键名 `nativeStackIOS`。**

**即注释在同一处既说「与 iOS 一致」又说「但键名不同」** —— 
**「一致」指行为一致（都附加原生栈），不是键名一致。**

### 2.2 iOS 侧的键名

```objc
// packages/react-native/React/Base/RCTUtils.mm:555-558
  NSMutableDictionary *errorInfo = [NSMutableDictionary dictionaryWithObject:stackTrace
                                                                                      forKey:@"nativeStackIOS"];
```

| 平台 | 键名 | 值类型 |
| --- | --- | --- |
| **Android** | **`nativeStackAndroid`** | `WritableNativeArray`，每项是 4 字段的 map |
| **iOS** | **`nativeStackIOS`** | `NSArray<NSString*>`，每项是 `callStackSymbols` 的**字符串** |

**两处差异**：

| # | 差异 | Android | iOS |
| --- | --- | --- | --- |
| ① | **键名** | `nativeStackAndroid` | `nativeStackIOS` |
| ② | **元素类型** | 结构化 map（4 字段） | **原始字符串** |

**② 比 ① 更重要**：即两端产出的**数据形状都不同**，
**任何消费者都必须写两套解析逻辑**。

### 2.3 关键实测：JS 侧零消费者

**对全仓库（排除 `node_modules`）检索 `nativeStack`：**

| 位置 | 命中数 | 性质 |
| --- | --- | --- |
| `PromiseImpl.kt:176`、`:177`、`:183`、`:196`、`:200`、`:232` | **6** | **Android 产出侧** |
| `React/Base/RCTUtils.mm:558` | **1** | **iOS 产出侧** |
| `React/Base/RCTLog.mm:236`、`:280` | 2 | **同名但不同物**（`nativeStackFrameRegex`，是**正则名**，与本契约无关） |
| **所有 `.js` / `.ts` 文件** | **0** | **JS 侧零引用** |

**即 `nativeStackAndroid` 与 `nativeStackIOS` 在 JS 侧从未被读取。**

### 2.4 JS 侧实际做的事：整体赋值

```javascript
// packages/react-native/Libraries/BatchedBridge/NativeModules.js:171-179
function updateErrorWithErrorData(
  errorData: {message: string, ...},
  error: ExtendedError,
): ExtendedError {
  /* $FlowFixMe[class-object-subtyping] added when improving typing for this
   * parameters */
  // $FlowFixMe[incompatible-type]
  // $FlowFixMe[unsafe-object-assign]
  return Object.assign(error, errorData || {});
}
```

**唯一的动作是 `Object.assign(error, errorData || {})`。**

| 观察 | 含义 |
| --- | --- |
| 不解析任何字段 | `code`/`message`/`name`/`userInfo`/`nativeStack*` 全部原样挂到 Error 上 |
| Flow 类型只要求 `message` | 其余字段用 `...`（inexact）放行 |
| **三条 `$FlowFixMe`** | `class-object-subtyping` / `incompatible-type` / `unsafe-object-assign` |

**即：这是一个「不解释载荷」的透传设计。**

### 2.5 三个后果

| # | 后果 | 说明 |
| --- | --- | --- |
| ① | **50 帧的原生栈常驻在每个被 reject 的 Error 上** | 若业务把 Error 存入数组或上报，这些帧对象一起被持有 |
| ② | **消费者必须处理两个键名 + 两种元素类型** | 而本仓库内没有这样的消费者 —— **需求由外部应用承担** |
| ③ | 帧的字段名两端**不一致** | Android 是 `{class, file, lineNumber, methodName}`；iOS 是无法解析的字符串 |

### 2.6 YY-1 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | 双端，但**载荷形状不同** |
| **架构** | **仅 legacy 架构**（`RCTJSErrorFromCodeMessageAndNSError` 与 `PromiseImpl` 均属 Bridge 路径） |
| **触发条件** | `Promise.reject(...)` 且传入 `throwable` |
| **帧数上限** | **Android 硬编码 50**；iOS **无上限**（`callStackSymbols` 全量） |
| **JS 侧处理** | 透传，无解析 |
| **本仓库内消费者** | **0** |

**帧数上限的不对称值得单独指出**：

| 平台 | 上限 | 位置 |
| --- | --- | --- |
| Android | **50** | `PromiseImpl.kt` 的 `ERROR_STACK_FRAME_LIMIT` |
| iOS | **无**（`[NSThread callStackSymbols]` 全量） | `RCTUtils.mm:556` |

**即同一份错误载荷契约在两端的「大小上限」不同。**

---

## 3. Android 侧的四级消息降级链

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:149-166
    // Use the custom message if provided otherwise use the throwable message.
    if (message != null) {
      errorInfo.putString(ERROR_MAP_KEY_MESSAGE, message)
    } else if (throwable != null) {
      var throwableMessage = throwable.message
      // Fallback to the throwable name, so we record some useful information
      if (throwableMessage.isNullOrEmpty()) {
        throwableMessage = throwable.javaClass.canonicalName
      }
      errorInfo.putString(ERROR_MAP_KEY_MESSAGE, throwableMessage)
    } else {
      // The JavaScript side expects a map with at least an error message.
      // /Libraries/BatchedBridge/NativeModules.js -> createErrorFromErrorData
      errorInfo.putString(ERROR_MAP_KEY_MESSAGE, ERROR_DEFAULT_MESSAGE)
    }
```

**四级降级，注释给了两处理由**：

| 级别 | 条件 | 取值 | 注释 |
| --- | --- | --- | --- |
| ① | `message != null` | `message` | 「Use the custom message if provided」 |
| ② | `throwable != null` 且有 message | `throwable.message` | — |
| ③ | `throwable.message` 为空 | **`throwable.javaClass.canonicalName`** | 「Fallback to the throwable name, so we record some useful information」 |
| ④ | 都没有 | `ERROR_DEFAULT_MESSAGE` = **`"Error not specified."`** | 「The JavaScript side expects a map with at least an error message」 |

**注释 ④ 引用了一个函数名**：`/Libraries/BatchedBridge/NativeModules.js -> createErrorFromErrorData`

> **该函数名在本仓库的 JS 侧不存在** ——
> 全仓检索 `createErrorFromErrorData` **零命中**，
> `NativeModules.js` 里的函数是 `updateErrorWithErrorData`（`:172`）。
>
> **即注释引用了一个已被重命名或不存在的函数。**
> 这是 46 文档定义的「历史承诺」类的轻量实例：**注释指向的锚点已失效**，
> 但注释要传达的事实（「JS 侧至少需要 message」）仍然成立。

### 3.1 `code` 的降级

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:143-147
    if (code == null) {
      errorInfo.putString(ERROR_MAP_KEY_CODE, ERROR_DEFAULT_CODE)
    } else {
      errorInfo.putString(ERROR_MAP_KEY_CODE, code)
    }
```

**默认值 `ERROR_DEFAULT_CODE` = `"EUNSPECIFIED"`**（`:229`）。

### 3.2 `userInfo` 的「即使置 null 也要存在」

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:168-174
    // For consistency with iOS ensure userInfo key exists, even if we null it.
    // iOS: /React/Base/RCTUtils.m -> RCTJSErrorFromCodeMessageAndNSError
    if (userInfo != null) {
      errorInfo.putMap(ERROR_MAP_KEY_USER_INFO, userInfo)
    } else {
      errorInfo.putNull(ERROR_MAP_KEY_USER_INFO)
    }
```

**这是一个刻意的跨平台对齐**，注释写明理由：`For consistency with iOS`。

| 项 | 值 |
| --- | --- |
| 键名 | `userInfo` |
| 有值 | `putMap` |
| 无值 | **`putNull`**（不是省略） |

> **即「键必须存在」是契约的一部分** ——
> 这与 YY-1 的「JS 侧不解析」形成对照：
> **`userInfo` 的存在性被刻意保证，而 `nativeStack*` 的存在性只是附带。**

---

## 4. 单次结算的保证：两处清空写法不同

### 4.1 `resolve` 的写法

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:27-34
  override fun resolve(value: Any?) {
    resolve?.let { callback ->
      callback.invoke(value)
      resolve = null
      reject = null
    }
  }
```

**用 `?.let`**，清空两个字段**在 `let` 块内**。

### 4.2 `reject` 的写法

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:138-142
    if (reject == null) {
      resolve = null
      return
    }
```

**以及块尾**：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:205-208
    reject?.invoke(errorInfo)
    resolve = null
    reject = null
  }
```

**三处差异**：

| # | `resolve` | `reject` |
| --- | --- | --- |
| 判空方式 | `resolve?.let { }` | `if (reject == null) { … return }` |
| 已结算后的二次调用 | `let` 不进入，**什么都不做** | 早返回，**只把 `resolve` 置 null** |
| 块尾清空 | 在 `let` 内 | 在 `if` 之外（`:206-207`） |

### 4.3 二次调用的实际效果

**`resolve` 后再 `resolve`**：`resolve` 已是 `null` → `let` 不进入 → 无操作。✅

**`reject` 后再 `reject`**：`reject == null` → 早返回 → **只执行 `resolve = null`**。
此时 `reject` 本就是 `null`，故**净效果是无操作**。✅

**`resolve` 后再 `reject`**：`resolve = null`、`reject = null` → 早返回 → 无操作。✅

**`reject` 后再 `resolve`**：同上。✅

> **结论：四种二次调用组合都安全**，单次结算保证成立。
>
> **但实现上 `resolve` 与 `reject` 用了两种不同的判空风格**
> （`?.let` vs `if + return`），
> **且 `reject` 的块尾那句 `reject?.invoke(errorInfo)`（`:205`）是冗余的** ——
> 前面已在 `:139` 判过 `reject == null` 并早返回，
> 中间的 `errorInfo` 构造也不会改 `reject`，
> **故此处 `reject` 必非 null，`?.` 不起作用。**

**冗余的 `?.` 是无害的**（若 `reject` 真为 null，`invoke` 被跳过也不会崩），
**但它掩盖了「此处不可能为 null」这一事实。**

---

## 5. 50 帧上限的实现

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:185-198
      // Build an an Array of StackFrames to match JavaScript:
      // iOS: /Libraries/Core/Devtools/parseErrorStack.js -> StackFrame
      var i = 0
      while (i < stackTrace.size && i < ERROR_STACK_FRAME_LIMIT) {
        val frame = stackTrace[i]
        val frameMap: WritableMap = WritableNativeMap()
        // NOTE: no column number exists StackTraceElement
        frameMap.putString(STACK_FRAME_KEY_CLASS, frame.className)
        frameMap.putString(STACK_FRAME_KEY_FILE, frame.fileName)
        frameMap.putInt(STACK_FRAME_KEY_LINE_NUMBER, frame.lineNumber)
        frameMap.putString(STACK_FRAME_KEY_METHOD_NAME, frame.methodName)
        nativeStackAndroid.pushMap(frameMap)
        i++
      }
```

**循环条件有两个**：`i < stackTrace.size && i < ERROR_STACK_FRAME_LIMIT`。

| 项 | 值 |
| --- | --- |
| 上限常量 | **`ERROR_STACK_FRAME_LIMIT = 50`** |
| 循环条件 | **双重上界**（栈本身长度 + 50） |
| 每帧字段数 | **4**（`class`、`file`、`lineNumber`、`methodName`） |

**两处注释**：

| 注释 | 内容 | 评价 |
| --- | --- | --- |
| `:185-186` | `Build an an Array of StackFrames to match JavaScript:` + `iOS: .../parseErrorStack.js -> StackFrame` | **有效锚点** —— 该文件确实存在（§5.1）。**注：`Build an an Array` 有语法笔误（多一个 `an`）** |
| `:189` | `// NOTE: no column number exists StackTraceElement` | **解释了为何只有 4 个字段**（无 column） |

> **`:189` 是本文件最有价值的一行注释** ——
> 它把「为什么少一个字段」这个必然会被问到的问题预先回答了。

### 5.1 第二个失效锚点的核查

**对全仓库检索 `parseErrorStack`**：

| 检索对象 | 结果 |
| --- | --- |
| `.js` / `.ts` 文件 | **0 命中**（下详） |

> **`:185-186` 引用的 `/Libraries/Core/Devtools/parseErrorStack.js` 同样不存在。**
>
> **即 `PromiseImpl.kt` 里的三条跨文件引用有两条失效**：
> | # | 引用 | 是否存在 |
> | --- | --- | --- |
> | ① | `/Libraries/BatchedBridge/NativeModules.js -> createErrorFromErrorData` | ❌ 函数名已变为 `updateErrorFromErrorData` |
> | ② | `iOS: /React/Base/RCTUtils.m -> RCTJSErrorFromCodeMessageAndNSError` | ✅ **存在**（`RCTUtils.mm:552`） |
> | ③ | `iOS: /Libraries/Core/Devtools/parseErrorStack.js -> StackFrame` | ❌ **文件不存在** |
>
> **三取二失效**。这是「注释作为跨文件导航」的可靠性问题：
> **注释能让读者快速找到对应实现，但一旦对方重命名/移动，注释就成了误导。**

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **YY-1** | **【核心】双平台产出两个不同键名（`nativeStackAndroid` / `nativeStackIOS`）且元素类型也不同（结构化 map / 原始字符串），而 JS 侧零消费者、只做 `Object.assign` 透传** | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:232`；`packages/react-native/React/Base/RCTUtils.mm:558`；`packages/react-native/Libraries/BatchedBridge/NativeModules.js:178` | **两端载荷形状不同却无统一契约**；消费者需写两套解析；**50 帧结构常驻在每个被 reject 的 Error 上** |
| **YY-2** | **帧数上限两端不对称**：Android 硬编码 `ERROR_STACK_FRAME_LIMIT = 50`，iOS 用 `[NSThread callStackSymbols]` 全量** | `PromiseImpl.kt:229`（常量）、`:187`（循环）；`RCTUtils.mm:556` | **同一契约的「大小上限」不同**；深栈下 iOS 载荷显著更大 |
| **YY-3** | **三条跨文件注释锚点中 1 条失效**：`createErrorFromErrorData`（已改名为 `updateErrorFromErrorData`，全仓 0 命中）；另两条（`RCTUtils.m` 的函数、`parseErrorStack.js`）**均有效** | `PromiseImpl.kt:153-155`、`:185-186` | **注释作为导航的价值随对方改名而衰减**，会误导读者 |
| YY-4 | `reject` 块尾的 `reject?.invoke(errorInfo)`（`:205`）是冗余的 —— 前面 `:139` 已判空早返回 | `PromiseImpl.kt:205` | 无害，但**掩盖了「此处必非 null」** |
| YY-5 | `resolve` 用 `?.let` 而 `reject` 用 `if + return`，两种判空风格并存 | `PromiseImpl.kt:27-34` vs `:138-142` | 风格不一致；四种二次调用组合均安全（已逐条推导） |
| **YY-6（正面）** | **`userInfo` 的「即使无值也要 `putNull`」是刻意的跨平台对齐**，注释写明 `For consistency with iOS` | `PromiseImpl.kt:168-174` | **与 YY-1 的「附带字段」形成对照**：有意识的契约 vs 顺带的契约 |
| **YY-7（正面）** | 四级消息降级链，每级有注释说明理由；`:189` 的 `NOTE: no column number exists StackTraceElement` **预先回答了「为何少一列」** | `PromiseImpl.kt:149-166`、`:189` | **本仓库注释质量的上游样本** |

### YY-1 / YY-2 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | 双端，**但载荷形状不同** |
| **架构** | **仅 legacy 架构（Bridge）** |
| **触发条件** | `Promise.reject(...)` 传入 `throwable` |
| **有无消费者** | **本仓库内 0 个**；需求由外部应用承担 |
| **是否影响正确性** | **否** —— 载荷正确送达，只是无人解读 |
| **是否影响体积/内存** | **是** —— 每个被 reject 的 Error 携带至多 50 个 frame 对象 |

---

## 7. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 54 文档：legacy 桥接层的构建分层问题 | **同属 legacy 桥接**，但本文是**跨平台一致性**问题，与构建无关 |
| 41 文档：崩溃有采集无持久化、无上传 | **对照**：Promise 拒绝的错误**送达 JS 但不被解读**，与崩溃「采集但不处理」是同一类「数据到位但消费缺失」 |
| 46 文档：三类问题形态（历史承诺 / 自认边界 / 结构脆弱） | **新增轻量实例**：YY-3 的失效注释锚点 —— **文件曾存在但已改名/移动** |
| 47 文档 §9.1：`Role` 枚举靠序号与 C++ 同步，无校验 | **同型**：YY-1 的双平台载荷靠**注释约定**同步，无编译期校验；**且约定本身已不一致（键名 + 元素类型）** |
| 23 文档：iOS `RCTUtils`/`RCTLog` 层 | **本文给出 `RCTUtils.mm:552` 的具体职责**（`RCTJSErrorFromCodeMessageAndNSError`），并记录 `:550` 的 `// TODO: Can we just replace RCTMakeError with this function instead?` |
| 38 文档：第一档注释 = 理由 + 外部参考 | **本文给出正反两面**：YY-7 是一档注释；YY-3 是「外部参考失效」的反例 |
| 53 文档 §4：`assert_valid_size` 在破坏性操作之后 | **对照**：YY-5 的冗余 `?.` 同样是「防护早于使用」的痕迹 —— 只是方向相反（多余而非缺失） |