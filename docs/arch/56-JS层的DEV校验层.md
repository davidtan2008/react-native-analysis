---
id: 56
title: "JS 层的 `__DEV__` 校验层：一个永远不会触发的 `invariant`、两个 release 下变空的导出函数、66 个文件的校验密度"
topic: FD.api
symptoms: [debug]
platforms: [cross]
architecture: [cross]
layer: T2
symbols: ["__DEV__", "invariant"]
sourceRoot: react-native
claims: [VV-1, VV-2, VV-3, VV-4, VV-5, VV-6, VV-7, VV-8]
---
# 56 · JS 层的 `__DEV__` 校验层：一个永远不会触发的 `invariant`、两个 release 下变空的导出函数、66 个文件的校验密度

> **模块**：E8 + B4 ·
> `packages/react-native/Libraries/StyleSheet/processAspectRatio.js`（62）、
> `Libraries/Components/TextInput/TextInputState.js`、
> `Libraries/Modal/Modal.js:194-223`、
> `Libraries/EventEmitter/NativeEventEmitter.js:110-133`
>
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · JS 层 · **仅生产构建受影响**
>
> **前置**：[54 文档](./54-iOS参数转换层的构建分层防护.md) 记录
> **iOS 原生侧**的同类现象：`RCT_DEBUG` 下 5 层防护、release 下 0 层。
> 本文记录 **JS 侧的同一现象**（`__DEV__` 门控），
> 并指出一个**54 文档没有的关键差别**：
> **JS 侧不只是「检查被排除」，还存在「检查本身就不可能触发」。**
>
> 另附一组**实测数据**：`Libraries/` 下 **66 个文件**使用 `__DEV__`，
> Top 20 的分布已量化（§4）。

---

## 1. 两套等价的门控机制

| 层 | 宏 | 定义处 | 覆盖 |
| --- | --- | --- | --- |
| **原生（iOS/ObjC）** | `RCT_DEBUG` | `packages/react-native/React/Base/RCTDefines.h:29-35` | `React/**`、`ReactAndroid/**` |
| **JS** | `__DEV__` | 由打包器/Metro 在构建期定义 | `Libraries/**`、`src/**` |

**两者注释的措辞几乎一致**（54 文档 §2）：

| 宏 | 注释原文 |
| --- | --- |
| `RCT_DEBUG` | `exclude error checking and logging code from release builds to improve performance and reduce binary size` |
| `__DEV__` | 由 RN 的构建脚本在 `__DEV__` 为假时移除 |

**即：这是一个**有意设计**的双端机制**，不是疏漏。本文记录的是它的代价。

---

## 2. 【核心 VV-1】一个在 dev 下也永远不会触发的 `invariant`

### 2.1 代码原文

```javascript
// packages/react-native/Libraries/StyleSheet/processAspectRatio.js:32-43
  const matches = aspectRatio.split('/').map(s => s.trim());

  if (matches.includes('auto')) {
    if (__DEV__) {
      invariant(
        matches.length,
        'aspectRatio does not support `auto <ratio>`. You passed: %s',
        aspectRatio,
      );
    }
    return;
  }
```

### 2.2 为什么它不可能触发

**逐步推导**：

| 步 | 事实 | 依据 |
| --- | --- | --- |
| ① | `matches` 是 `split('/')` 的结果 | `:32` |
| ② | 分支条件是 `matches.includes('auto')` | `:34` |
| ③ | **`includes` 为真 ⟹ 数组长度 ≥ 1** | 数组语义 |
| ④ | 故 `matches.length` **恒为真值** | ①+②+③ |
| ⑤ | `invariant(truthy, ...)` **不抛** | `invariant` 语义 |

> **即：这个 `invariant` 的条件是一个在该分支内恒真的表达式。**
> **它在 `__DEV__` 为真时也不会抛，在 release 时更不会。**
> **本仓库没有任何输入能让它产生任何效果。**

### 2.3 它本来想拦的是什么

**错误消息揭示了意图**：

```
'aspectRatio does not support `auto <ratio>`. You passed: %s'
```

**即作者想拦的是 `auto 16/9` 这类「`auto` 后面还跟了比例」的写法。**

**而正确写法应是 `matches.length !== 1`** —— 现在写的是 `matches.length`（真值即通过）。

> **这个 bug 的性质**：**检查存在、消息正确、但判定条件写反了方向**。
>
> **它不会导致错误行为** —— 因为无论 `invariant` 抛不抛，
> 下一行都是 `return;`，即 **`auto` 开头的输入一律被丢弃**。
>
> **即：`auto 16/9` 与 `auto` 的处理结果相同（都返回 undefined），
> 只是本该报的警告永远不会出现。**

### 2.4 对照：同文件里**能**触发的检查

```javascript
// packages/react-native/Libraries/StyleSheet/processAspectRatio.js:45-52
  const hasNonNumericValues = matches.some(n => Number.isNaN(Number(n)));
  if (__DEV__) {
    invariant(
      !hasNonNumericValues && (matches.length === 1 || matches.length === 2),
      'aspectRatio must either be a number, a ratio string or `auto`. You passed: %s',
      aspectRatio,
    );
  }
```

**这一处的条件是复合的，且真的可假**：
`!hasNonNumericValues && (matches.length === 1 || matches.length === 2)` ——
输入 `'a/b/c'` 会让 `matches.length === 3` 使条件为假 → **抛**。

**同一个文件里，一个检查有效、一个检查恒真** —— 这是并排的可信度对照。

### 2.5 还有一处自带 Flow 压制

```javascript
// packages/react-native/Libraries/StyleSheet/processAspectRatio.js:19-30
  if (typeof aspectRatio !== 'string') {
    if (__DEV__) {
      invariant(
        /* $FlowFixMe[constant-condition] Error discovered during Constant
         * Condition roll out. See https://fburl.com/workplace/1v97vimq. */
        !aspectRatio,
        'aspectRatio must either be a number, a ratio string or `auto`. You passed: %s',
        aspectRatio,
      );
    }
    return;
  }
```

**这一处抛得出来**（`typeof aspectRatio !== 'string'` 且 `aspectRatio` 为真值时）。

**但它带着 `$FlowFixMe[constant-condition]`** —— Flow 的
「Constant Condition roll out」规则发现 `!aspectRatio` 在此分支是常量判定。
**即：Flow 已经在抱怨这段检查本身可疑，作者用压制注释确认了这一点并保留。**

> **三处检查的完整评级**：
>
> | 位置 | dev 下能否触发 | 判定 |
> | --- | --- | --- |
> | `:20-28` | ✅ 能 | **有效**，但带 Flow 压制 |
> | `:35-41` | ❌ **不能** | **恒真条件，VV-1** |
> | `:46-51` | ✅ 能 | **有效** |

---

## 3. 【核心 VV-2】两个导出函数在 release 下是空壳

### 3.1 两个函数的完整形态

```javascript
// packages/react-native/Libraries/Components/TextInput/TextInputState.js:56-70
function focusField(textFieldID: ?number): void {
  if (__DEV__) {
    console.error('focusField no longer works. Use focusInput');
  }

  return;
}

function blurField(textFieldID: ?number) {
  if (__DEV__) {
    console.error('blurField no longer works. Use blurInput');
  }

  return;
}
```

**两个函数的函数体 = 一个 `if (__DEV__)` + 一个 `return;`。**

| 构建 | `focusField(x)` 的行为 |
| --- | --- |
| **dev** | 打印 `console.error` 后返回 |
| **release** | **直接返回，函数体等价于 `{}`** |

**注意签名：第一个显式标 `: void`，第二个没有标 `void`（Kotlin 风格残留）。**

### 3.2 三个函数的分级

**同文件的第三个弃用函数行为不同**：

```javascript
// packages/react-native/Libraries/Components/TextInput/TextInputState.js:34-42
function currentlyFocusedField(): ?number {
  if (__DEV__) {
    console.error(
      'currentlyFocusedField is deprecated and will be removed in a future release. Use currentlyFocusedInput',
    );
  }

  return findNodeHandle<$FlowFixMe>(currentlyFocusedInputRef);
}
```

**它在 `console.error` 之后仍然执行 `findNodeHandle(...)` 并返回结果。**

| 函数 | dev 行为 | **release 行为** | 分级 |
| --- | --- | --- | --- |
| `currentlyFocusedField`（`:34`） | 报错 + **正常工作** | **正常工作** | **被弃用但可用** |
| `focusField`（`:56`） | 报错 + **不做事** | **不做事** | **被弃用且已是空壳** |
| `blurField`（`:64`） | 报错 + **不做事** | **不做事** | **被弃用且已是空壳** |

> **三者的弃用程度不同，但对外的信号完全一样** ——
> 都是「调了就报错」。
>
> **即：开发者无法从 dev 的报错中区分「这个还能用（但不建议）」与
> 「这个根本没用」。**

### 3.3 三者都在默认导出里，且全仓库零调用方

```javascript
// packages/react-native/Libraries/Components/TextInput/TextInputState.js:181-198
const TextInputState = {
  currentlyFocusedInput,
  focusInput,
  blurInput,

  currentlyFocusedField,
  focusField,
  blurField,
  focusTextInput,
  blurTextInput,
  registerInput,
  unregisterInput,
  isTextInput,
};

export default TextInputState;
```

**11 个导出成员，其中 3 个是弃用项。**

**全仓库检索 `focusField` / `blurField`（排除测试目录与本文件）**：

| 符号 | 命中位置 | 性质 |
| --- | --- | --- |
| `focusField` | 本文件 `:56`（定义）、`:58`（错误消息）、`:189`（导出） | **全部在定义文件内** |
| `blurField` | 本文件 `:64`、`:66`、`:190` | **全部在定义文件内** |

**零外部调用方。**

> **这构成一个完整的形态**：**导出的公开 API + dev 下有报错 + release 下为空壳 + 零调用方。**
>
> **它的存在意义只是「给从旧版本迁移的代码一个可解释的失败」**——
> 即这是一种**有意的兼容垫片**，不是忘记删的代码。
>
> **但「有意的垫片」与「release 下静默失败」之间没有区别**：
> 调用方的代码在生产环境里不会有任何提示。

---

## 4. `Libraries/` 的 `__DEV__` 使用分布（实测）

**两套口径必须分开统计（初稿曾混用，已修正）**：

| 口径 | 定义 | 文件数 | 行数 |
| --- | --- | --- | --- |
| **A** | 文件中**出现 `__DEV__` 任何形式** | **66** | — |
| **B** | 文件中**出现 `if (__DEV__)` 或 `__DEV__ ?`** | **53** | **114** |

**下表的 Top 20 采用口径 B 的「按出现次数」（`if (__DEV__)` 或 `__DEV__ ?` 的行数）**：

| # | 次数 | 文件 |
| --- | --- | --- |
| 1 | 27 | `Libraries/Core/__tests__/ExceptionsManager-test.js`（**测试文件**） |
| 2 | 8 | `Libraries/Components/TextInput/TextInputState.js` |
| 3 | 7 | `Libraries/BatchedBridge/MessageQueue.js` |
| 4 | 4 | `Libraries/Pressability/PressabilityDebug.js` |
| 5 | 4 | `Libraries/Modal/Modal.js` |
| 6 | 3 | `Libraries/StyleSheet/processTransform.js` |
| 7 | 3 | `Libraries/StyleSheet/processAspectRatio.js` |
| 8 | 3 | `Libraries/Animated/nodes/AnimatedInterpolation.js` |
| 9 | 2 | `Libraries/Text/Text.js` |
| 10 | 2 | `Libraries/StyleSheet/StyleSheetExports.js` |
| 11 | 2 | `Libraries/ReactNative/ReactNativeRuntimeDiagnostics.js` |
| 12 | 2 | `Libraries/Core/Timers/JSTimers.js` |
| 13 | 2 | `Libraries/Core/setUpReactDevTools.js` |
| 14 | 2 | `Libraries/Core/ExceptionsManager.js` |
| 15 | 2 | `Libraries/Components/ScrollView/ScrollView.js` |
| 16 | 2 | `Libraries/Animated/nodes/AnimatedStyle.js` |
| 17 | 2 | `Libraries/Animated/nodes/AnimatedNode.js` |
| 18 | 2 | `Libraries/Animated/animations/Animation.js` |
| 19 | 1 | `Libraries/Utilities/Platform.ios.js` |
| 20 | 1 | `Libraries/Utilities/Platform.android.js` |

> **第一名是测试文件**（27 次，占口径 B 全部 114 行的近四分之一），
> 应从「生产校验密度」中剔除。
>
> **剔除测试后，生产侧的第一名是 `TextInputState.js`（8 行）** —— 与 §3 完全对应：
> 该文件是「弃用垫片 + dev-only 报错」的最密集处。
> 第二名 `MessageQueue.js`（7 行）、并列第四 `PressabilityDebug.js` 与 `Modal.js`（各 4 行）。

### 4.1 一个必须注意的口径问题

| 项 | 说明 |
| --- | --- |
| **口径 A（66 文件）** | 只要文件里**提到** `__DEV__` 就计入 —— 含 `__DEV__ &&`、含仅作条件判断的写法 |
| **口径 B（53 文件 / 114 行）** | 只计 `if (__DEV__)` 与 `__DEV__ ?` 两种**守卫形态**的行数 |
| 两口径差 13 个文件 | 这些文件用了 `__DEV__ &&` 等其他形态，**在 B 中不可见** |
| 「行数」≠「校验点数」 | 一行里可能有多个条件；一个 `if (__DEV__)` 可能包多条校验 |
| 排除 `node_modules` | — |

**因此这组数字只能作为「分布指示」，不能作为「校验总数」。**
**引用时必须连口径一起引用** —— 这正是本文 §9 修正 VV-8 的方式。

---

## 5. 对照组：`Modal` 的 prop 冲突校验也是 dev-only

```javascript
// packages/react-native/Libraries/Modal/Modal.js:194-223
function confirmProps(props: ModalProps) {
  if (__DEV__) {
    if (
      props.presentationStyle &&
      props.presentationStyle !== 'overFullScreen' &&
      props.transparent === true
    ) {
      console.warn(
        `Modal with '${props.presentationStyle}' presentation style and 'transparent' value is not supported.`,
      );
    }
    if (
      props.navigationBarTranslucent === true &&
      props.statusBarTranslucent !== true
    ) {
      console.warn(
        'Modal with translucent navigation bar and without translucent status bar is not supported.',
      );
    }

    if (
      Platform.OS === 'ios' &&
      props.allowSwipeDismissal === true &&
      !props.onRequestClose
    ) {
      console.warn(
        'Modal requires the onRequestClose prop when used with `allowSwipeDismissal`. This is necessary to prevent state corruption.',
      );
    }
  }
}
```

**三条 prop 冲突校验（其中一条还带 `Platform.OS === 'ios'` 门控）整体在 `__DEV__` 内。**

**后果**：这三条描述的都是**「不支持的组合」**，
例如 `presentationStyle + transparent`（iOS 上透明背景与某些呈现样式互斥）。

> **release 下传入不支持的组合不会警告** ——
> 行为上表现为「样式没按预期生效」，**且没有任何提示**。
>
> **第三条的消息最强硬**：`This is necessary to prevent state corruption.`
> **即作者知道不传 `onRequestClose` 会导致「状态损坏」，
> 而这条防止措施在生产环境下不存在。**

---

## 6. 与 `NativeEventEmitter` 的对照：一处「iOS only」注释是对的

作为**反向对照**，记录一处注释**准确**的同类代码。

### 6.1 `AppState` 按平台条件传模块

```javascript
// packages/react-native/Libraries/AppState/AppState.js:83-89
      const emitter: NativeEventEmitter<NativeAppStateEventDefinitions> =
        new NativeEventEmitter(
          // T88715063: NativeEventEmitter only used this parameter on iOS. Now it uses it on all platforms, so this code was modified automatically to preserve its behavior
          // If you want to use the native module on other platforms, please remove this condition and test its behavior
          Platform.OS !== 'ios' ? null : NativeAppState,
        );
```

**注释带一个工单号 `T88715063`**，说明**这段平台条件是自动化改写的结果**，
并给出建议：「若要在其他平台使用该原生模块，请删掉此条件并测试其行为」。

### 6.2 Android 侧的两个空实现

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/appstate/AppStateModule.kt:79-85
  override fun addListener(eventName: String?) {
    // iOS only
  }

  override fun removeListeners(count: Double) {
    // iOS only
  }
```

### 6.3 交叉验证：`NativeEventEmitter` 的可选调用

```javascript
// packages/react-native/Libraries/EventEmitter/NativeEventEmitter.js:116-131
    this._nativeModule?.addListener(eventType);
    let subscription: ?EventSubscription = RCTDeviceEventEmitter.addListener(
      eventType,
      listener,
      context,
    );

    return {
      remove: () => {
        if (subscription != null) {
          this._nativeModule?.removeListeners(1);
          // $FlowFixMe[incompatible-use]
          subscription.remove();
          subscription = null;
        }
      },
    };
```

**两处都是 `?.`** ——
`_nativeModule` 为 `null` 时**不调用**，因此 Android 的两个空实现**在 `AppState` 这条路径上根本不会被触达**。

> **结论：Android 那两个 `// iOS only` 空实现，其注释是准确的** ——
> 在 `AppState` 的实际用法下它们确实只在 iOS 生效。
>
> **这与 §2/§3/§5 形成鲜明对照**：
>
> | 位置 | 注释 | 是否准确 |
> | --- | --- | --- |
> | `AppStateModule.kt:79-85` | `// iOS only` | ✅ **准确**（有 `?.` 与平台条件双重保证） |
> | `TextInputState.js:56-70` | `console.error('focusField no longer works...')` | ⚠️ **不准确** —— 「不再工作」在 dev 成立，但 release 连提示都没有 |
> | `packages/react-native/Libraries/Modal/Modal.js:194-223` | 三条 `not supported` | ⚠️ **仅 dev 成立** |

**并且 `removeListeners(1)` 的调用被 `if (subscription != null)` 包住** ——
**重复 `remove()` 不会重复减计数**，这一处顺序与幂等处理是对的。

---

## 7. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **VV-1** | **【核心】`processAspectRatio.js:36` 的 `invariant(matches.length, ...)` 条件在该分支内恒真 —— 即使在 dev 下也永远不会抛** | `packages/react-native/Libraries/StyleSheet/processAspectRatio.js:35-41` | **「`auto 16/9` 不支持」这条警告在任何构建下都不会出现**；不导致错误行为（下一行就是 `return`），但**检查完全无效** |
| **VV-2** | **【核心】`focusField` / `blurField` 的函数体只有一个 `if (__DEV__)` + `return` —— release 下是空函数**；两者都在默认导出里但全仓库零调用方 | `packages/react-native/Libraries/Components/TextInput/TextInputState.js:56-70`、`:189-190` | **生产环境调用它们静默无效**；无法从 dev 报错区分「可用但弃用」与「根本没用」 |
| **VV-3** | VV-1 的姊妹问题：`:21-28` 的 `invariant` 带 `$FlowFixMe[constant-condition]` 压制，Flow 已判定该判定可疑 | `processAspectRatio.js:21-24` | **同类信号**：作者知道检查可疑但保留 |
| **VV-4** | `Modal.confirmProps` 的三条 prop 冲突校验（含「necessary to prevent state corruption」那条）整体在 `__DEV__` 内 | `packages/react-native/Libraries/Modal/Modal.js:194-223` | **生产环境传入不支持的组合无提示**，表现为「样式未按预期生效」 |
| VV-5 | `currentlyFocusedField` 与 `focusField`/`blurField` 的弃用程度不同（前者仍工作）但**报错文案无法区分** | `TextInputState.js:34-42` vs `:56-70` | 开发者无法判断迁移代价 |
| VV-6 | `packages/react-native/Libraries/AppState/AppState.js:83-89` 的平台条件是**自动化改写**的结果（带工单号 `T88715063`），注释建议「删掉此条件并测试」—— **未见跟进** | `packages/react-native/Libraries/AppState/AppState.js:83-89` | 工单未闭环；注释是唯一的说明 |
| VV-7 | `focusField` 显式标注 `: void`，`blurField` 未标注 | `TextInputState.js:56`、`:64` | 风格不一致 |
| VV-8 | **`__DEV__` 的统计必须带口径**：口径 A（提及即计）为 **66 文件**；口径 B（只计 `if (__DEV__)` 与 `__DEV__ ?`）为 **53 文件 / 114 行** | `packages/react-native/Libraries/` | **两口径差 13 个文件**（用 `__DEV__ &&` 等形态）；**不带口径的数字不可引用** |

### VV-1 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | 双端（JS 层） |
| **构建** | **全部构建**（dev 与 release 均不触发） |
| **触发输入** | 任何 `aspectRatio` 字符串，使 `matches.includes('auto')` 为真 |
| **实际行为后果** | **无功能后果**（下一行 `return`）；**仅警告缺失** |
| **严重性** | **低（功能）/ 中（可观测性）** —— 一个永远不响的告警比没有告警更糟，因为它给人「已有防护」的错觉 |

### VV-2 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | 双端 |
| **构建** | **仅 release 受影响**（dev 会 `console.error`） |
| **触发条件** | 调用 `TextInputState.focusField()` 或 `.blurField()` |
| **实际后果** | **聚焦/失焦不发生，且无任何提示** |
| **仓库内调用方** | **0** —— 影响的是**外部使用方**（RN 是库） |

---

## 8. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 54 文档：iOS 原生侧 `RCT_DEBUG` 下 5 层防护、release 下 0 层 | **本文是 JS 侧的同一现象**，并**指出一处 54 文档没有的差别**：JS 侧还存在「检查本身不可能触发」（VV-1），而原生侧只是「检查被排除」 |
| 46 文档：三类问题形态（历史承诺 / 自认边界 / 结构脆弱） | **新增两种**：**「恒真的检查」**（VV-1：检查存在但无效，比缺失更危险）与 **「兼容垫片」**（VV-2：有意的空函数） |
| 49 文档 OO-2：缺工具链时静默通过（有意的门禁放宽） | **同源**：`__DEV__`/`RCT_DEBUG` 是同一类「有意的门禁放宽」，代价同样未被文档化 |
| 33 文档：带工单号的 TODO（`T207198334`、`T58784068`） | **新增同型**：VV-6 的工单号 `T88715063`（自动化改写遗留），同样未见闭环 |
| 46 文档：注释与代码不符的两类区分 | **新增第三类实例**：VV-4 的 `not supported` 警告**仅 dev 成立**，但措辞是无条件的 |
| 52 文档 §1：`specs_DEPRECATED` 目录 50 文件 / 2 225 行 | **对照**：VV-2 的三个弃用函数是**同一「弃用流程」在 API 层的体现** |
| 55 文档 UU-1：无实现时 `?.` 静默 no-op（明确声明的约定） | **对照**：VV-2 的 release 空壳**没有**这样的声明 —— 差异在于是否把「静默」写进契约 |

---

## 9. 本文提出的最小改进方向（不改变既有设计）

**保留 `__DEV__` 排除检查的决定**，仅需三处低成本修改即可消除本文记录的最坏后果：

| # | 目标 | 改法 | 成本 |
| --- | --- | --- | --- |
| 1 | **VV-1** | 把 `invariant(matches.length, ...)` 改为 `invariant(matches.length === 1, ...)` | **1 个字符级修改** |
| 2 | **VV-2** | 给 `focusField`/`blurField` 加 `@deprecated` JSDoc，说明 release 下为空操作 | 注释 |
| 3 | **VV-4** | 把三条 `not supported` 的**行为后果**（而非检测）移到非 `__DEV__` 路径 | 行为改动，需评估体积 |

**第 1 项是本文认为最值得立即修的**：
一个永不触发的 `invariant` 会让维护者误以为该输入已被防护。