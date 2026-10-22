---
id: 43
title: "JS 异常的三级路由：RN$handleException 全局函数、Feature Flag 门控与 unhandled rejection 的软异常归属"
topic: DG.route
symptoms: [crash]
platforms: [cross]
architecture: [cross]
layer: T1
symbols: ["handleException", "unhandledrejection"]
claims: [HH-1, HH-2, HH-3, HH-4, HH-5, HH-6, HH-7, HH-8]
---
# 43 · JS 异常的三级路由：RN$handleException 全局函数、Feature Flag 门控与 unhandled rejection 的软异常归属

> **模块**：B1 · `Libraries/Core/ExceptionsManager.js`、
> `Libraries/promiseRejectionTrackingOptions.js`、`Libraries/LogBox/LogBox.js:86-95`
> + `packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp:505-600`
> + `packages/react-native/scripts/featureflags/ReactNativeFeatureFlags.config.js:883-891`
> + `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt`
> **基线**：react-native @ `9b131e42` · 跨平台（JS + C++）
> **前置**：[41 文档](./41-Android崩溃与错误路径.md) 记录 Android 侧异常链的全貌
> 与「RN 不做崩溃上传」的确证；[22 文档](./22-iOS崩溃UI层RedBox与LogBox.md) 记录
> iOS 的 RedBox/LogBox；[28 文档](./28-iOS-Dev工具链与四层门控.md) 记录 Dev 工具链门控。
>
> 本文记录 **JS 异常从 `handleException` 到原生的三级路由**
> （C++ 全局函数 → Feature Flag 门控 → TurboModule 回退），
> 指出 **`RN$handleException` 与 `registerExceptionListener` 是本仓库最接近
> 「崩溃采集」的机制**（但它仍不上报），并给出
> **Unhandled promise rejection 被归类为 soft（不崩、不出 RedBox）的确切位置**。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/Libraries/Core/ExceptionsManager.js` | ~250 | **JS 侧异常入口** |
| `packages/react-native/Libraries/promiseRejectionTrackingOptions.js` | ~60 | **unhandled rejection → soft 异常** |
| `packages/react-native/Libraries/LogBox/LogBox.js` | — | **注册 native 异常监听器**（`:86-95`） |
| `packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp` | — | **`RN$handleException` / `RN$inExceptionHandler` / `RN$registerExceptionListener`**（`:505-600`） |
> + `packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp`:505-600`
> + `packages/react-native/scripts/featureflags/ReactNativeFeatureFlags.config.js`:883-891`
> + `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt`
---

## 2. 【核心】JS 异常的三级路由

### 2.1 入口：`handleException(e, isFatal)`

`Libraries/Core/ExceptionsManager.js:151-157`：

```js
// packages/react-native/Libraries/Core/ExceptionsManager.js:151-157
function handleException(e: unknown, isFatal: boolean) {
  // TODO(T196834299): We should really use a c++ turbomodule for this
  const reportToConsole = true;
  if (
    !global.RN$handleException ||
    !global.RN$handleException(e, isFatal, reportToConsole)
  ) {
```

**路由条件**：C++ 全局函数**不存在** 或 **返回 falsy** → 走 JS 回退路径。

**注释带工单号 `T196834299`**：

> TODO(T196834299): We should really use a c++ turbomodule for this

**即当前的「C++ host function」形态被认为是权宜之计，作者希望改成 TurboModule。**

### 2.2 C++ 侧的 `RN$handleException`

`ReactInstance.cpp:529-570`：

```cpp
// packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp:529-556
    // TODO(T196834299): We should really use a C++ turbomodule for this
    defineReadOnlyGlobal(
        runtime,
        "RN$handleException",
        jsi::Function::createFromHostFunction(
            runtime,
            jsi::PropNameID::forAscii(runtime, "handleException"),
            3,
            [jsErrorHandler = jsErrorHandler_](
                jsi::Runtime& runtime,
                const jsi::Value& /*unused*/,
                const jsi::Value* args,
                size_t count) {
              if (count < 2) {
                throw jsi::JSError(
                    runtime,
                    "handleException requires 3 arguments: error, isFatal, logToConsole (optional)");
              }

              auto isFatal = isTruthy(runtime, args[1]);

              if (!ReactNativeFeatureFlags::
                      useAlwaysAvailableJSErrorHandling()) {
                if (jsErrorHandler->isRuntimeReady()) {
                  return jsi::Value(false);
                }
              }
```

**`defineReadOnlyGlobal`** —— 属性只读（不可被 JS 覆盖）。

**参数校验**：`count < 2` 抛 `jsi::JSError`，
文案说「requires 3 arguments」但实际只检查 `< 2` —— **文案与检查不一致**
（3 个参数中第 3 个是可选的，`:559-566` 的 `count == 2` 分支证实）。

**第二参数 `isFatal` 之后的分支**（`:558-566`）：

```cpp
              auto jsError =
                  jsi::JSError(runtime, jsi::Value(runtime, args[0]));

              if (count == 2) {
                jsErrorHandler->handleError(runtime, jsError, isFatal);
              } else {
                auto logToConsole = isTruthy(runtime, args[2]);
                jsErrorHandler->handleError(
                    runtime, jsError, isFatal, logToConsole);
              }

              return jsi::Value(true);
```

**成功时返回 `true`** → JS 侧的 `if` 条件为假 → **不回退**。

### 2.3 【核心】Feature Flag 门控：决定「走 C++ 还是回退」

```cpp
              if (!ReactNativeFeatureFlags::
                      useAlwaysAvailableJSErrorHandling()) {
                if (jsErrorHandler->isRuntimeReady()) {
                  return jsi::Value(false);
                }
              }
```

**双重否定，等价于**：

```
if (flag 为假 且 runtime 已就绪) → 返回 false → JS 走 TurboModule 回退路径
否则                              → 继续处理 → 返回 true
```

**即：Flag 关闭时，「已就绪的 runtime」仍然走旧的 TurboModule 通道。**

| `useAlwaysAvailableJSErrorHandling` | `isRuntimeReady()` | 走哪条路 |
| --- | --- | --- |
| `true` | 任意 | **C++ host function** |
| `false` | `true` | **TurboModule 回退** |
| `false` | `false` | **C++ host function**（提前 `handleError`，不等就绪） |

**第三行是设计要点**：runtime 未就绪时**只有 C++ 通道可用**，
因为 TurboModule 需要一个可工作的 runtime。

### 2.4 Flag 的元数据

`scripts/featureflags/ReactNativeFeatureFlags.config.js:883-891`：

```js
// packages/react-native/scripts/featureflags/ReactNativeFeatureFlags.config.js:883-891
    useAlwaysAvailableJSErrorHandling: {
      defaultValue: false,
      metadata: {
        description:
          'In Bridgeless mode, use the always available javascript error reporting pipeline.',
        expectedReleaseValue: true,
        purpose: 'release',
      },
      ossReleaseStage: 'none',
    },
```

| 字段 | 值 | 含义 |
| --- | --- | --- |
| `defaultValue` | **`false`** | 当前默认关闭 |
| `description` | **`In Bridgeless mode`** | **仅在 Bridgeless 模式下生效** |
| `expectedReleaseValue` | **`true`** | **计划在正式版开启** |
| `purpose` | `release` | 属发布相关 |
| `ossReleaseStage` | `none` | OSS 尚未分阶段 |

> **`expectedReleaseValue: true` + `ossReleaseStage: none` 是矛盾的组合**：
> 一个声明「正式版应开启」的 Flag，在 OSS 里却「无发布阶段」。
> 这意味着**它计划开启但尚未开始推进**。
>
> **这是本批文档里第一个「Flag 元数据自身矛盾」的实例** ——
> 40 文档的 38 个零引用 marker 是「清单与现实脱节」，
> 这里是「Flag 自己的两份元数据互相矛盾」。

### 2.5 第三个全局：`RN$registerExceptionListener`

`ReactInstance.cpp:572-600+`：

```cpp
// packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp:572-588
    defineReadOnlyGlobal(
        runtime,
        "RN$registerExceptionListener",
        jsi::Function::createFromHostFunction(
            runtime,
            jsi::PropNameID::forAscii(runtime, "registerExceptionListener"),
            1,
            [errorListeners = std::vector<std::shared_ptr<jsi::Function>>(),
             jsErrorHandler = jsErrorHandler_](
                jsi::Runtime& runtime,
                const jsi::Value& /*unused*/,
                const jsi::Value* args,
                size_t count) mutable {
              if (count < 1) {
                throw jsi::JSError(
                    runtime,
                    "registerExceptionListener: requires 1 argument: fn");
              }

              if (!args[0].isObject() ||
                  !args[0].getObject(runtime).isFunction(runtime)) {
                throw jsi::JSError(
                    runtime,
                    "registerExceptionListener: The first argument must be a function");
              }
```

**两处参数校验都抛 `jsi::JSError`** —— 且文案给出了具体格式。

**注意 `mutable` 的 lambda** —— 因为它要往捕获的 `errorListeners` vector 里 push。

### 2.6 三个全局函数的完整清单

| 全局名 | 定义位置 | 参数校验 | 返回 |
| --- | --- | --- | --- |
| `RN$handleException` | `ReactInstance.cpp:530-570` | `count < 2` 抛 JSError | `bool`（受 Flag 与就绪状态影响） |
| `RN$inExceptionHandler` | `ReactInstance.cpp:514-527` | **无校验** | `jsErrorHandler->inErrorHandler()` |
| `RN$registerExceptionListener` | `ReactInstance.cpp:572-600+` | `count < 1` + 类型检查 | — |

**`RN$inExceptionHandler` 是唯一无参数校验的**（`:519` 的 lambda 直接忽略所有参数）。

**JS 侧两个消费点**：

~~~bash
grep -rn 'RN\$handleException\|RN\$inExceptionHandler\|RN\$registerExceptionListener' Libraries
Libraries/Core/ExceptionsManager.js:155-156: RN$handleException（handleException 内）
Libraries/Core/ExceptionsManager.js:188:     RN$inExceptionHandler?.()
Libraries/Core/ExceptionsManager.js:239-240: RN$handleException（第二个 handleException 重载）
Libraries/LogBox/LogBox.js:86-87:           RN$registerExceptionListener
~~~

**`:239-240` 是第二个 `handleException` 入口**（`:229-241`）——
即 41 文档记录的 Android `ExceptionsManagerModule` 侧路径的 JS 端对应物。

---

## 3. 【核心】Unhandled promise rejection 归类为 soft

### 3.1 唯一的检测点

`Libraries/promiseRejectionTrackingOptions.js` 全文只有两个回调，
`onUnhandled` 是关键：

```js
// packages/react-native/Libraries/promiseRejectionTrackingOptions.js:44-54
    ExceptionsManager.handleException(
      new Error(
        `Uncaught (in promise, id: ${id})${message ? `: "${message}"` : ''}`,
        {
          cause: rejection,
        },
      ),
      false /* isFatal */,
    );
```

**`false /* isFatal */` 是全仓库最关键的一个字面量**。

### 3.2 三级消息构造

```js
// packages/react-native/Libraries/promiseRejectionTrackingOptions.js:24-43
  onUnhandled: (id, rejection) => {
    let message: string;

    if (rejection === undefined) {
      message = '';
    } else if (
      // $FlowFixMe[method-unbinding] added when improving typing for this parameters
      /* $FlowFixMe[invalid-this-arg] Error exposed after fixing this typing
       * unsoundness in flow */
      Object.prototype.toString.call(rejection) === '[object Error]'
    ) {
      // $FlowFixMe[method-unbinding] added when improving typing for this parameters
      /* $FlowFixMe[invalid-this-arg] Error exposed after fixing this typing
       * unsoundness in flow */
      message = Error.prototype.toString.call(rejection);
    } else {
      try {
        message = require('pretty-format').format(rejection);
      } catch {
        message =
          typeof rejection === 'string'
            ? rejection
            : JSON.stringify(rejection as $FlowFixMe);
      }
    }
```

| 情形 | 消息构造 | 备注 |
| --- | --- | --- |
| `rejection === undefined` | `''` | — |
| `Object.prototype.toString` 是 `'[object Error]'` | `Error.prototype.toString.call()` | **`Object.prototype.toString` 而非 `instanceof`** —— 跨 realm 安全 |
| 其他 | `require('pretty-format').format()` | **`require` 而非 `import`** —— 延迟加载，避免启动时开销 |
| `pretty-format` 抛异常 | 字符串则直接用，否则 `JSON.stringify` | 二级兜底 |

**五处 `$FlowFixMe`（实测）注释解释了「为什么不用 `instanceof`」**：
*method-unbinding*（避免解绑 `toString`）+ *invalid-this-arg*（`call` 的 this），
加上 *unsoundness in flow* —— **即作者知道这不 sound 但为了跨 realm 正确性而接受**。

### 3.3 【发现】Android 原生侧零支持

~~~bash
grep -rn 'unhandled\|onUnhandled\|UnhandledRejection\|rejectionHandled' ReactAndroid/src/main --include='*.kt' --include='*.java'
（仅 ForwardingCookieHandler.kt:85 的 "unhandled conditions" 无关命中）
~~~

**Android 原生侧零实现** —— 完全靠 JS。

> **这与 41 文档 §2.1 的结论一致**：
> RN 的异常机制**在 JS 侧是完整的，在原生侧只是通道**。

### 3.4 后果链条

```
Unhandled promise rejection
  ↓ JS: ExceptionsManager.handleException(new Error(...), isFatal=false)
  ↓ RN$handleException 或 TurboModule
  ↓ 原生：ExceptionsManagerModule.reportException(data)
  ↓ isFatal == false → soft 分支
  ↓
FLog.e(ReactConstants.TAG, format(message, stack))
    ← 只写日志，无 RedBox，无崩溃
```

**即：Unhandled promise rejection 在 Android 上只进 logcat，不弹 RedBox。**

> **这是有意设计还是遗漏？**
> JS 侧的注释 `false /* isFatal */` 说明是**显式选择**。
>
> **理由合理**：大量第三方库的 promise rejection 是「已处理的边界情况」，
> 按 fatal 处理会造成 RedBox 噪音。
>
> **但代价是：真正的 unhandled rejection（代码 bug）也不会被发现** ——
> 它只混在 logcat 里。
>
> **这是「崩溃检测」的盲区**：
> 与 40 文档 EE-2 的「marker 静默丢弃」同类 ——
> **都「不崩」但「不出现在开发者可见的地方」**。

---

## 4. `LogBox` 注册原生异常监听器

`Libraries/LogBox/LogBox.js:86-95`：

```js
// packages/react-native/Libraries/LogBox/LogBox.js:86-95
      if (global.RN$registerExceptionListener != null) {
        global.RN$registerExceptionListener(
```

**这是 `RN$registerExceptionListener` 的唯一消费点**，
且有 `!= null` 判空（因为该全局只在 C++ 通道下存在）。

**即：LogBox 在 C++ 通道可用时改用原生监听器，否则用自己的 JS 拦截。**

**这是 42 文档「两条路径并存」模式在 JS 侧的对应** ——
同一能力有 JS 与 C++ 两套实现，靠 `global.XXX != null` 判空切换。

---

## 5. `reportException` 的消息改写链

`Libraries/Core/ExceptionsManager.js:60-110` 的完整流程：

### 5.1 四步改写

```js
// packages/react-native/Libraries/Core/ExceptionsManager.js:65-76
  const parseErrorStack = require('./Devtools/parseErrorStack').default;
  const stack = parseErrorStack(e?.stack);
  const currentExceptionID = ++exceptionID;
  const originalMessage = e.message || '';
  let message = originalMessage;
  if (e.componentStack != null) {
    message += `\n\nThis error is located at:${e.componentStack}`;
  }
  const namePrefix = e.name == null || e.name === '' ? '' : `${e.name}: `;

  if (!message.startsWith(namePrefix)) {
    message = namePrefix + message;
  }
```

| 步 | 动作 | 目的 |
| --- | --- | --- |
| ① | `parseErrorStack(e?.stack)` | **Symbol 化的栈解析**（Hermes） |
| ② | `++exceptionID` | 单调 ID（对应原生侧的 `errorCookie`） |
| ③ | `message += '\n\nThis error is located at:' + componentStack` | **追加组件栈** |
| ④ | `namePrefix + message` | **加 `Name: ` 前缀**（且幂等：已带前缀则不重复加） |

**第 ④ 步的幂等检查 `if (!message.startsWith(namePrefix))`**
说明它可能被多次调用。

### 5.2 `extraData` 的四个来源

```js
// packages/react-native/Libraries/Core/ExceptionsManager.js:79-90
  // $FlowFixMe[unclear-type]
  const extraData: Object = {
    // $FlowFixMe[incompatible-use] we can't define a type with a Symbol-keyed field in flow
    ...e[decoratedExtraDataKey],
    jsEngine: e.jsEngine,
    rawStack: e.stack,
  };
  if (e.cause != null && typeof e.cause === 'object') {
    extraData.stackSymbols = e.cause.stackSymbols;
    extraData.stackReturnAddresses = e.cause.stackReturnAddresses;
    extraData.stackElements = e.cause.stackElements;
  }
```

| 来源 | 字段 | 注释 |
| --- | --- | --- |
| `e[decoratedExtraDataKey]` | **Symbol 键**（`decoratedExtraDataKey`） | `$FlowFixMe[incompatible-use] we can't define a type with a Symbol-keyed field in flow` |
| `e.jsEngine` | 引擎名 | — |
| `e.stack` | **原始栈字符串** | `rawStack` |
| `e.cause` | 三个 Hermes 符号栈字段 | `stackSymbols` / `stackReturnAddresses` / `stackElements` |

**`cause` 的三个字段是 Hermes 特有的**（用于 Symbol 化的栈）——
普通 V8/JSC 引擎下 `e.cause` 是普通 Error 或 undefined，这三项会是 `undefined`。

### 5.3 十个传出字段

```js
// packages/react-native/Libraries/Core/ExceptionsManager.js:92-104
  const data = preprocessException({
    message,
    originalMessage: message === originalMessage ? null : originalMessage,
    name: e.name == null || e.name === '' ? null : e.name,
    componentStack:
      typeof e.componentStack === 'string' ? e.componentStack : null,
    stack,
    id: currentExceptionID,
    isFatal,
    extraData,
  });
```

| 字段 | 类型 | 空值处理 |
| --- | --- | --- |
| `message` | string | 必填 |
| `originalMessage` | string \| null | **仅在 message 被改写时非 null** |
| `name` | string \| null | 空串也转 `null` |
| `componentStack` | string \| null | **检查 `typeof === 'string'`**（可能是数组） |
| `stack` | Array | `parseErrorStack` 的结果 |
| `id` | number | 单调 ID |
| `isFatal` | boolean | — |
| `extraData` | Object | 见 §5.2 |

### 5.4 `reportToConsole` 的回授机制

```js
// packages/react-native/Libraries/Core/ExceptionsManager.js:105-110
  if (reportToConsole) {
    // we feed back into console.error, to make sure any methods that are
    // monkey patched on top of console.error are called when coming from
    // handleException
    console.error(e);
  }
```

**注释解释了这个「绕一圈」的设计**：

> we feed back into console.error, to make sure any methods that are monkey patched on top of console.error are called when coming from handleException

**即：绕过 `console.error` 的 monkey patch 会导致用户的日志采集失效，
所以特意回授一次。**

**而 `reportToConsole` 只在 `handleException` 入口为 `true`**（`:153`），
`reportException` 被直接调用时为 `false` —— 避免重复 log。

**与 40 文档的 `ReactMarker.logMarker` 的 `hasMatchingNameMarker` 同型** ——
一个「标志位决定是否走某条额外路径」的设计。

---

## 6. `PromiseImpl` 的 iOS 对齐注释（Android 侧）

`packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt`
有三处显式的 iOS 对齐注释：

### 6.1 `userInfo` 键必须存在

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:167-173
    // For consistency with iOS ensure userInfo key exists, even if we null it.
    // iOS: /React/Base/RCTUtils.m -> RCTJSErrorFromCodeMessageAndNSError
    if (userInfo != null) {
      errorInfo.putMap(ERROR_MAP_KEY_USER_INFO, userInfo)
    } else {
      errorInfo.putNull(ERROR_MAP_KEY_USER_INFO)
    }
```

**注释明确指向 iOS 的具体函数** —— 属**跨平台契约的显式声明**。

**即：即使 `userInfo` 是 null 也要 `putNull`**，
因为 JS 侧 `createErrorFromErrorData` 会无条件读该键。

### 6.2 `nativeStackAndroid` 对齐 iOS 的 `nativeStackIOS`

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:175-179
    // Attach a nativeStackAndroid array if a throwable was passed
    // this matches iOS behavior - iOS adds a `nativeStackIOS` property
    // iOS: /React/Base/RCTUtils.m -> RCTJSErrorFromCodeMessageAndNSError
```

**iOS 的 `RCTJSErrorFromCodeMessageAndNSError` 正是 30 文档 §2.5 引用的那个函数**
（`RCTEventEmitter` 的 `rejectBlock` 用它构造 `jsErrorDetails`）。

### 6.3 栈帧格式对齐 JS 的 `parseErrorStack`

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:184-198
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

**`ERROR_STACK_FRAME_LIMIT = 50`**（`:222`）—— **栈帧上限**，
防止深递归异常产生巨大的错误对象。

**注释 `NOTE: no column number exists StackTraceElement`** ——
与 41 文档 §6.3 的 `convertJavaStackTrace` 的 `column = -1` 同一约束。

**三处注释都指向 iOS 的具体文件** ——
**这是本仓库跨平台一致性做得最好的地方之一**。

### 6.4 `resolve` 的一次性消费

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/PromiseImpl.kt:27-33
  override fun resolve(value: Any?) {
    resolve?.let { callback ->
      callback.invoke(value)
      resolve = null
      reject = null
    }
  }
```

**`invoke` 后立刻把两个回调置 null** —— **保证只能消费一次**。

**这与 39 文档 §5 的 Promise 四态防护同型，但实现更简单**：
Android 侧用「置 null」实现「已消费」，
C++ 侧用 `std::optional` 置 `nullopt`。

> **副作用**：第二次 `resolve` 是**完全静默的**（`resolve?.let` 的 null 分支不做事），
> **无日志、无异常**。
> 而 C++ 侧（39 文档 C313）有**四条明确的中文错误日志**。
>
> **即：同一契约，两端的可观测性不同。**

---

## 7. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| HH-1 | **`useAlwaysAvailableJSErrorHandling` 的元数据自相矛盾**：`expectedReleaseValue: true` 但 `ossReleaseStage: 'none'` | `scripts/featureflags/ReactNativeFeatureFlags.config.js:883-891` | 「计划开启」与「未开始推进」并存；读者无法判断当前该期待什么 |
| HH-2 | **Unhandled promise rejection 归类为 soft**，只进 logcat 不弹 RedBox | `Libraries/promiseRejectionTrackingOptions.js:53` | 真正的代码 bug 若以 unhandled rejection 形式出现则**不会被开发者发现** |
| HH-3 | Android 原生侧零支持 unhandled rejection 检测 | `ReactAndroid/src/main`（0 命中） | 完全依赖 JS；若 JS bundle 未加载则无此检测 |
| HH-4 | `RN$handleException` 的参数校验文案（`requires 3 arguments`）与实际检查（`count < 2`）不一致 | `ReactInstance.cpp:539-542` | 文案说 3 个必填，实际第 3 个可选 |
| HH-5 | **`RN$inExceptionHandler` 无参数校验**（另两个都有） | `ReactInstance.cpp:514-527` | JS 传任意参数都被忽略；无诊断 |
| HH-6 | **Android `PromiseImpl` 的第二次 `resolve`/`reject` 完全静默**（置 null 后 `?.let` 不做事） | `bridge/PromiseImpl.kt:27-33` | 与 C++ 侧的四条错误日志不对称；**排查时无任何线索** |
| HH-7 | `reportException` 的 `componentStack` 用 `typeof === 'string'` 判断，但 React 的 `componentStack` 在某些版本是数组 | `Libraries/Core/ExceptionsManager.js:96-97` | 数组时会被转 `null` 丢弃 |
| HH-8 | `T196834299` 同时出现在 JS 与 C++ 两侧（同一 TODO，两处表述略有差异：`a c++ turbomodule` vs `a C++ turbomodule`） | `ExceptionsManager.js:152`、`ReactInstance.cpp:529` | 表述不一致但工单号一致；**属可改进的一致性问题** |

### HH-6 与 39 文档 C313 的对照

| | C++ `ObjCTurboModule`（39 文档 §5） | Android `PromiseImpl`（本文） |
| --- | --- | --- |
| 「已消费」标记 | `std::optional` 置 `nullopt` + `resolveWasCalled` 布尔 | 字段置 `null` |
| 重复调用检测 | ✅ 区分 4 种非法组合 | ❌ 不检测 |
| 错误日志 | **4 条**（resolve×2 / reject×2） | **0 条** |
| 并发保护 | `std::mutex` | 无（假定单线程） |

> **即：同一份 JS↔原生的 Promise 契约，Android 的可观测性明显弱于 C++/iOS 侧。**
> **重复 resolve 是 JS 开发者的常见错误**（如 `Promise` 在多个 then 分支里被 resolve），
> 而 Android 上它**完全无声**。

---

## 8. 「RN 不上报」的补充：这三个全局是最接近的机制

[04 文档](./04-崩溃日志捕获收集处理上传.md) 与 41 文档都得出
「RN 不实现崩溃上传」。**但需要精确区分三个层次**：

| 层次 | 机制 | 是否存在 |
| --- | --- | --- |
| **采集** | 把异常送到一个中心点 | ✅ **有**（`RN$registerExceptionListener` + `jsErrorHandler`） |
| **展示** | RedBox / LogBox | ✅ 有（**仅开发模式**） |
| **持久化/上传** | 写文件、HTTP 上报、崩溃 SDK | ❌ **完全没有** |

**即：RN 有「采集」与「开发期展示」，但没有「持久化」。**

**`RN$registerExceptionListener` 是宿主可用的接入点**：

```js
// packages/react-native/Libraries/LogBox/LogBox.js:86-87
      if (global.RN$registerExceptionListener != null) {
        global.RN$registerExceptionListener(
```

**LogBox 已经在用它** —— 宿主可以用同样方式注册自己的监听器。

> **修正 04 文档与 41 文档的表述**：
> 「RN 不做崩溃上传」的**准确含义是「不做上传」**，
> **而不是「不采集」**。
>
> **这对宿主有意义**：
> 若宿主需要崩溃统计，可以注册 `RN$registerExceptionListener`
> 在应用内自行上报 —— **前提是不上传到 RN 的服务，而是自己的**。
>
> 但要注意：**该全局只在 C++ 通道（`useAlwaysAvailableJSErrorHandling` 或
> runtime 未就绪）下存在**；Flag 关闭且 runtime 就绪时走 TurboModule，
> 此时**没有等价的注册接口**（41 文档 §4.1 的 `ExceptionsManagerModule` 无对应方法）。

---

## 9. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 04 文档：RN 不实现崩溃上传（三项零命中） | **精确化**：RN **有采集**（`RN$registerExceptionListener`）**无持久化/上传**（§8） |
| 05 文档：异常检测/上报原理 | **补上 JS 侧三级路由与 Feature Flag 门控**（§2） |
| 22 文档：iOS `RCTRedBox` / LogBox | **对照**：Android 的 `ExceptionsManagerModule` + `DevSupportManagerBase`（41 文档） |
| 28 文档：Dev 工具链四层门控 | **新增第五个门控**：`useAlwaysAvailableJSErrorHandling`（§2.3），并发现其元数据自相矛盾（HH-1） |
| 30 文档 §2.5：`RCTJSErrorFromCodeMessageAndNSError` | **补上 Android 侧的对齐实现** `PromiseImpl`（§6），三处注释都指向该 iOS 函数 |
| 39 文档 §5：Promise 四态防护（4 条日志） | **对照**：Android `PromiseImpl` 用置 null 但**零日志**（HH-6） |
| 40 文档：`hasMatchingNameMarker` 标志位决定路径 | **新增同型**：`reportToConsole` 决定是否回授 `console.error`（§5.4） |
| 40 文档 EE-2：监控盲区（静默丢弃） | **新增第二类盲区**：unhandled rejection 被归为 soft（HH-2） |
| 41 文档：Android 异常链 | **补上它的 JS 侧入口与路由**（§2、§3） |
| 42 文档：两条路径并存 | **新增同型**：JS 侧 `RN$registerExceptionListener` 靠 `!= null` 判空切换（§4） |
| 33/34/39/40 文档：带工单号的 TODO | **新增 `T196834299`**，且**同一工单号在 JS 与 C++ 两侧都出现**（HH-8） |
