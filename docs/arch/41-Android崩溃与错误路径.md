---
id: 41
title: "Android 侧的崩溃与错误路径：DevSupportManager 的三实现继承树与「RN 不上报」的确证"
topic: DG.route
symptoms: [crash]
platforms: [android]
architecture: [cross]
layer: T1
symbols: ["NativeModuleCallExceptionHandler", "JSApplicationIllegalArgumentException"]
claims: [FF-1, FF-2, FF-3, FF-4, FF-5, FF-6, FF-7, FF-8]
---
# 41 · Android 侧的崩溃与错误路径：DevSupportManager 的三实现继承树与「RN 不上报」的确证

> **模块**：C2 · `ReactAndroid/.../devsupport/` 的异常处理族
> （`DevSupportManagerBase.kt` 1051、`StackTraceHelper.kt` 262、
> `ReleaseDevSupportManager.kt` 167、`DefaultDevSupportManagerFactory.kt` 87、
> `BridgelessDevSupportManager.kt` 87、`PerftestDevSupportManager.kt` 48）
> + `modules/core/ExceptionsManagerModule.kt`
> + `bridge/JSExceptionHandler.kt`、`bridge/DefaultJSExceptionHandler.kt`
> + `ReactDelegate.kt` 的四处类型判断
> **基线**：react-native @ `9b131e42` · Android 侧
> **前置**：[04 文档](./04-崩溃日志捕获收集处理上传.md) 在 iOS 侧得出
> 「RN 不实现崩溃上传」的结论；[05 文档](./05-监控检测原理与流程.md) 记录检测/上报原理；
> [22 文档](./22-iOS崩溃UI层RedBox与LogBox.md) 记录 iOS 的 RedBox/LogBox；
> [28 文档](./28-iOS-Dev工具链与四层门控.md) 记录 iOS 的 Dev 工具链门控。
>
> 本文给出 **Android 侧同一结论的独立证据链**、
> **`DevSupportManager` 的三实现继承树（其中两个不是同一条链）**，
> 以及 **`JSExceptionHandler` 接口注释里的设计哲学**
> —— 它解释了「RN 不内建上报」为何是设计选择而非遗漏。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `devsupport/DevSupportManagerBase.kt` | 1051 | **开发模式完整实现（RedBox/LogBox）** |
| `devsupport/StackTraceHelper.kt` | 262 | **栈帧解析（JS 与 Java 双通道）** |
| `devsupport/ReleaseDevSupportManager.kt` | 167 | **发布模式：全部空实现** |
| `devsupport/interfaces/DevSupportManager.kt` | — | 接口 |
| `devsupport/DefaultDevSupportManagerFactory.kt` | 87 | **两个 `create()` 重载（其一已废弃）** |
| `devsupport/BridgelessDevSupportManager.kt` | 87 | 新架构实现（继承 Base） |
| `devsupport/PerftestDevSupportManager.kt` | 39 | 性能测试模式（**继承 Release**） |
| `modules/core/ExceptionsManagerModule.kt` | ~75 | **JS 侧异常上报入口** |
| `bridge/JSExceptionHandler.kt` | 22 | **异常处理接口（含设计哲学注释）** |
| `bridge/DefaultJSExceptionHandler.kt` | 21 | **默认实现：原样重抛** |

---

## 2. 【核心】Android 侧同样不做崩溃上传

### 2.1 检索证据（三项）

```
$ grep -rn "setDefaultUncaughtExceptionHandler\|UncaughtExceptionHandler" \
    ReactAndroid/src/main --include="*.kt" --include="*.java"
（无输出）

$ grep -rn "Bugsnag\|Crashlytics\|Sentry" ReactAndroid/src/main --include="*.kt"
（无输出）

$ grep -rn "reportFatalException" ReactAndroid/src/main --include="*.kt"
modules/core/ExceptionsManagerModule.kt:26
```

| 检索项 | 结果 | 含义 |
| --- | --- | --- |
| `setDefaultUncaughtExceptionHandler` | **0 处** | RN 不注册全局未捕获异常处理器 |
| `Bugsnag` / `Crashlytics` / `Sentry` | **0 处** | RN 不集成崩溃上报 SDK |
| `reportFatalException` | **1 处** | 只是 **JS 侧调原生**的入口，不发网络请求 |

> **与 [04 文档](./04-崩溃日志捕获收集处理上传.md) 在 iOS 侧的三项零命中
> （`JsErrorHandler` 仅 1 处创建、无 `signal(SIG*)`、无 `NSSetUncaughtExceptionHandler`）
> 完全对应。**
>
> **结论可跨平台泛化**：
> **React Native 不提供崩溃采集与上传；崩溃上报由宿主 App 或第三方 SDK 负责。**
>
> 宿主需自行调用 `Thread.setDefaultUncaughtExceptionHandler`
> 才能拿到崩溃 —— **而这正是本仓库的缺失点**：
> 没有文档说明这一点，开发者容易以为 RN 会「自动上报」。

### 2.2 `DefaultJSExceptionHandler`：原样重抛

`bridge/DefaultJSExceptionHandler.kt`（全文）：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/DefaultJSExceptionHandler.kt:14-22
/** Crashy crashy exception handler. */
public class DefaultJSExceptionHandler : JSExceptionHandler {
  override fun handleException(e: Exception) {
    throw if (e is RuntimeException) {
      // Because we are rethrowing the original exception, the original stacktrace will be
      // preserved.
      e
    } else {
      RuntimeException(e)
    }
  }
}
```

**类注释只有三个词：`Crashy crashy exception handler.`**

| 分支 | 行为 | 代价 |
| --- | --- | --- |
| `e is RuntimeException` | **原样重抛**（注释：保留原始 stacktrace） | 无 |
| 否则 | 包成 `RuntimeException(e)` 再抛 | 类型信息丢失一层 |

**最终结果**：异常继续上抛 → Android 默认未捕获处理器 → **进程崩溃**。

**崩溃被系统捕获（tombstone / logcat），RN 自身不上报任何内容。**

---

## 3. 【核心发现】`DevSupportManager` 的三实现继承树

### 3.1 继承关系（实测）

```
DevSupportManager（接口，interfaces/DevSupportManager.kt）
│
├── ReleaseDevSupportManager（open class，167 行）────── 全部空实现
│   │
│   └── PerftestDevSupportManager（internal，48 行）─── 只覆写 3 个成员
│
└── DevSupportManagerBase（abstract，1051 行）────────── 完整实现
    │
    └── BridgelessDevSupportManager（internal，87 行）
```

**关键点：`PerftestDevSupportManager` 继承的是 `ReleaseDevSupportManager`，
不是 `DevSupportManagerBase`。**

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/PerftestDevSupportManager.kt:17-19
internal class PerftestDevSupportManager(
    applicationContext: Context,
) : ReleaseDevSupportManager() {
```

**即「性能测试模式」继承的是「空实现」**，它只覆写 3 个成员：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/PerftestDevSupportManager.kt:21-37
  override val devSettings: DeveloperSettings =
      DevInternalSettings(
          applicationContext,
          object : DevInternalSettings.Listener {
            override fun onInternalSettingsChanged() = Unit
          },
      )

  private val devServerHelper: DevServerHelper =
      DevServerHelper(devSettings, applicationContext, devSettings.packagerConnectionSettings)

  override fun startInspector() {
    devServerHelper.openInspectorConnection()
  }

  override fun stopInspector() {
    devServerHelper.closeInspectorConnection()
  }
```

类注释说明了它的定位：

> Interface for accessing and interacting with development features related to performance testing. Communication is enabled **via the Inspector, but everything else is disabled**.

**即：只开 Inspector 通道，其余全关** —— 与类注释完全一致。

### 3.2 两个 `create()` 重载的第一个有致命缺陷

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DefaultDevSupportManagerFactory.kt:28-52
  @Deprecated(
      "Use the other create() method with useDevSupport parameter for New Architecture. This method will be removed in a future release.",
      replaceWith =
          ReplaceWith(
              "create(applicationContext, reactInstanceManagerHelper, packagerPathForJSBundleName, enableOnCreate, redBoxHandler, devBundleDownloadListener, minNumShakes, customPackagerCommandHandlers, surfaceDelegateFactory, devLoadingViewManager, pausedInDebuggerOverlayManager)",
          ),
  )
  override fun create(
      applicationContext: Context,
      reactInstanceDevHelper: ReactInstanceDevHelper,
      packagerPathForJSBundleName: String?,
      enableOnCreate: Boolean,
      redBoxHandler: RedBoxHandler?,
      devBundleDownloadListener: DevBundleDownloadListener?,
      minNumShakes: Int,
      customPackagerCommandHandlers: Map<String, RequestHandler>?,
      surfaceDelegateFactory: SurfaceDelegateFactory?,
      devLoadingViewManager: DevLoadingViewManager?,
      pausedInDebuggerOverlayManager: PausedInDebuggerOverlayManager?,
  ): DevSupportManager =
      if (!enableOnCreate) {
        ReleaseDevSupportManager()
      } else {
        PerftestDevSupportManager(applicationContext)
      }
```

**【核心发现】这个重载从不返回 `DevSupportManagerBase`。**

| `enableOnCreate` | 返回 |
| --- | --- |
| `false` | `ReleaseDevSupportManager`（全空） |
| `true` | `PerftestDevSupportManager`（继承全空，只加 Inspector） |

**即：走这个已废弃重载时，`enableOnCreate = true` 也只得到「Inspector 可用」，
RedBox / LogBox / shake 手势 / reload 全部不可用。**

**所有传入参数被全部丢弃** —— `redBoxHandler`、`devBundleDownloadListener`、
`minNumShakes`、`customPackagerCommandHandlers`、`surfaceDelegateFactory`、
`devLoadingViewManager`、`pausedInDebuggerOverlayManager`、
`reactInstanceDevHelper`、`packagerPathForJSBundleName`、`applicationContext`
（除 `PerftestDevSupportManager` 用到的 `applicationContext`）**一个都没用**。

> **签名有 11 个参数，函数体只用了 1 个。**
> 这是编译器**不会警告**的类型（因为参数在 Kotlin 里不必使用），
> 静态分析工具能发现但默认不作为错误。

**为什么还能用**：`PerftestDevSupportManager` 内部自己 new 了
`DevInternalSettings` 与 `DevServerHelper`（§3.1），
**不依赖传入的 `devBundleDownloadListener` 等**。

### 3.3 第二个重载（新架构）才有完整实现

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DefaultDevSupportManagerFactory.kt:63-86
      if (ReactBuildConfig.UNSTABLE_ENABLE_FUSEBOX_RELEASE) {
        PerftestDevSupportManager(applicationContext)
      } else if (useDevSupport) {
        BridgelessDevSupportManager(
            applicationContext,
            reactInstanceDevHelper,
            packagerPathForJSBundleName,
            enableOnCreate,
            redBoxHandler,
            devBundleDownloadListener,
            minNumShakes,
            customPackagerCommandHandlers,
            surfaceDelegateFactory,
            devLoadingViewManager,
            pausedInDebuggerOverlayManager,
        )
      } else {
        ReleaseDevSupportManager()
      }
```

**三级判定，优先级严格**：

| 序 | 条件 | 返回 | 效果 |
| --- | --- | --- | --- |
| ① | **`ReactBuildConfig.UNSTABLE_ENABLE_FUSEBOX_RELEASE`** | `PerftestDevSupportManager` | **只开 Inspector** |
| ② | `useDevSupport == true` | `BridgelessDevSupportManager` | **完整实现** |
| ③ | 否则 | `ReleaseDevSupportManager` | 全空 |

**关键：① 优先于 ②。** 即便 `useDevSupport = true`，
只要 `UNSTABLE_ENABLE_FUSEBOX_RELEASE` 为真，就只得到 Inspector。

**这是「加能力」的第三例编译期开关**（承接 30 文档 §4.4、39 文档 §6.3）：

| 宏 | 语义 | 默认 |
| --- | --- | --- |
| `RCT_REMOVE_LEGACY_MODULE_INTEROP` | **移除** legacy 互操作 | 关（宿主手动开） |
| `REACT_NATIVE_DEBUGGER_MODE_PROD` | **加** 生产调试通道 | 关（宿主手动开） |
| **`ReactBuildConfig.UNSTABLE_ENABLE_FUSEBOX_RELEASE`** | **把调试能力降级为 Inspector-only** | **需查 `ReactBuildConfig`** |

**第三个是「降级」语义而非「增删」** —— 新增一类门控形态。

### 3.4 `DevSupportManagerBase` 的唯一创建点

`runtime/ReactHostImpl.kt:110-123`：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactHostImpl.kt:110-123
  public override val devSupportManager: DevSupportManager =
      (devSupportManagerFactory ?: DefaultDevSupportManagerFactory())
          .create(
              applicationContext = context.applicationContext,
              reactInstanceDevHelper = reactHostImplDevHelper,
              packagerPathForJSBundleName = reactHostDelegate.jsMainModulePath,
              useDevSupport = useDevSupport,
          )
          .also { devSupportManager ->
            // Wire up the tracing state provider
            if (devSupportManager is DevSupportManagerBase) {
              devSupportManager.setTracingStateProvider(reactHostImplDevHelper)
            }
          }
```

**两个观察**：

**① 只传 4 个命名参数**，其余 7 个走默认值 ——
**必须走第二个（带 `useDevSupport`）重载**，第一个没有这个参数。

**② `.also { if (it is DevSupportManagerBase) ... }`** ——
**用 `is DevSupportManagerBase` 做能力探测**。

这印证了 §3.1 的继承树结论：**`DevSupportManagerBase` 是「有额外能力」的标记**，
代码里通过类型判断来启用 tracing。

> **与 37 文档 `RCTModuleData` 的 11 个「靠自动合成返回零值」的性质对照**：
> 那处是「接口在但行为消失」；
> 这里是「**用继承树 + `is` 判断来区分能力集**」——
> **同一份接口，三种能力等级（空 / Inspector / 完整）**。

### 3.5 `ReactDelegate` 用类型判断做能力探测（四处）

```
$ grep -n "is ReleaseDevSupportManager" ReactDelegate.kt
267: if (devSupportManager != null && devSupportManager !is ReleaseDevSupportManager) {
288: if (devSupportManager is ReleaseDevSupportManager) {
394: devSupportManager is ReleaseDevSupportManager
```

| 位置 | 判断 | 用途 |
| --- | --- | --- |
| `:267` | `!is ReleaseDevSupportManager` | 长按 → 显示 Dev Options 菜单（**注释：onKeyLongPress is a Dev API and not supported in RELEASE mode**） |
| `:288` | `is ReleaseDevSupportManager` | reload 时走 `reactHost?.reload(...)` 而非从 JS reload（**注释：there is no bundler running in release mode**） |
| `:394` | `is ReleaseDevSupportManager` | `shouldShowDevMenuOrReload` 返回 `false`（**注释：shouldShowDevMenuOrReload is a Dev API and not supported in RELEASE mode**） |

**三处注释都是同一句模式的变体：`... is a Dev API and not supported in RELEASE mode`。**

> **这是 Android 侧对应 iOS `RCT_DEV_MENU` 门控的机制**
> （28 文档 §2.1 的第一层门控）。
> 但实现方式不同：
>
> | | iOS | Android |
> | --- | --- | --- |
> | 门控手段 | 编译期 `#if RCT_DEV_MENU` 裁剪整个 `RCTRedBox` 实现 | **运行期 `is ReleaseDevSupportManager` 类型判断** |
> | 产物 | Release 包里**没有该类** | Release 包里**有空实现类在** |
> | 成本 | 编译期裁剪，运行时零分支 | 运行时分支（3 处） |
>
> **iOS 是「编译期消除」，Android 是「运行期分流」。**

### 3.6 但 `PerftestDevSupportManager` 也是 `ReleaseDevSupportManager` 的子类

**这是 3.5 的一个漏洞**：

```
$ grep -rn "PerftestDevSupportManager" --include="*.kt" .
（除自身外，仅 DefaultDevSupportManagerFactory 的两处构造）
```

**`PerftestDevSupportManager` 在运行期满足 `is ReleaseDevSupportManager`。**

| `create()` 分支 | `useDevSupport` | 长按 Dev Options（`:267`） | `shouldShowDevMenuOrReload`（`:394`） |
| --- | --- | --- | --- |
| ② `Bridgeless` | `true` | ✅ 显示 | ✅ `true` |
| ① `Perftest`（Fusebox release） | `true` | ❌ **不显示** | ❌ **`false`** |
| ③ `Release` | `false` | ❌ 不显示 | ❌ `false` |

**即：`UNSTABLE_ENABLE_FUSEBOX_RELEASE = true` 时，尽管 `useDevSupport = true`，
Dev Options 菜单与 dev-menu 快捷键仍被禁用。**

> **这大概率是有意的**（Fusebox release 模式下只留 Inspector），
> **但没有任何注释说明这个耦合**。
> §3.3 的注释只解释了「① 优先于 ②」这个判定顺序，
> 没说「① 会连带禁用 Dev Options 与快捷键」。

---

## 4. 崩溃的两条入口

### 4.1 JS 侧主动上报

`modules/core/ExceptionsManagerModule.kt:26-60`：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/core/ExceptionsManagerModule.kt:26-46
  override fun reportFatalException(message: String?, stack: ReadableArray?, idDouble: Double) {
    val id = idDouble.toInt()
    val data = JavaOnlyMap()
    data.putString("message", message)
    data.putArray("stack", stack)
    data.putInt("id", id)
    data.putBoolean("isFatal", true)
    reportException(data)
  }
```

**三个方法**：

| 方法 | `isFatal` | 动作 |
| --- | --- | --- |
| `reportFatalException` | **`true`（写死）** | → `reportException` |
| `reportSoftException` | **`false`（写死）** | → `reportException` |
| `reportException` | 读 `data`，**缺省 `false`** | 见下 |

`reportException` 的两个分支：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/core/ExceptionsManagerModule.kt:47-60
  override fun reportException(data: ReadableMap) {
    val message = data.getString("message").orEmpty()
    val stack = data.getArray("stack") ?: Arguments.createArray()
    val isFatal = if (data.hasKey("isFatal")) data.getBoolean("isFatal") else false
    val extraDataAsJson = getExtraDataAsJson(data)
    if (isFatal) {
      val ex = JavascriptException(format(message, stack))
      ex.extraDataAsJson = extraDataAsJson
      throw ex
    } else {
      FLog.e(ReactConstants.TAG, format(message, stack))
      if (extraDataAsJson != null) {
        FLog.d(ReactConstants.TAG, "extraData: %s", extraDataAsJson)
      }
    }
  }
```

| 分支 | 动作 |
| --- | --- |
| **fatal** | 包装成 `JavascriptException` 并 **`throw`** —— **不直接调 devSupportManager** |
| **soft** | 只写 `FLog.e` —— 无 UI、无上报 |

**即：JS 侧上报的「fatal」异常，也是靠抛异常传播到 `handleException` 链。**

**`isFatal` 的读取有默认值保护**：缺键时按 **soft** 处理。
**一个字段缺失会让 fatal 降级为 soft** —— 这是保守默认（宁可不崩也不误崩）。

**`stack` 缺省为 `Arguments.createArray()`**（空数组），不是 `null` —— 下游无需判空。

### 4.2 `JavascriptException` 的唯一识别点

```
$ grep -rn "JavascriptException" --include="*.kt" . | grep -v ExceptionsManagerModule
devsupport/DevSupportManagerBase.kt:45:   import ...
devsupport/DevSupportManagerBase.kt:305:  if (e is JavascriptException) {
common/JavascriptException.kt:17:        public open class JavascriptException(...)
```

**`DevSupportManagerBase.kt:305` 是全仓库唯一的 `is JavascriptException` 判断**：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManagerBase.kt:298-310
  private fun logJSException(e: Exception) {
    val message = StringBuilder(e.message ?: "Exception in native call from JS")
    var cause = e.cause
    while (cause != null) {
      message.append("\n\n").append(cause.message)
      cause = cause.cause
    }
    if (e is JavascriptException) {
      FLog.e(ReactConstants.TAG, "Exception in native call from JS", e)
      showNewError(e.message, arrayOf(), JSEXCEPTION_ERROR_COOKIE, ErrorType.JS)
    } else {
      showNewJavaError(message.toString(), e)
    }
  }
```

| 条件 | 动作 |
| --- | --- |
| `e is JavascriptException` | `showNewError(e.message, **arrayOf() 空数组**, JSEXCEPTION_ERROR_COOKIE, ErrorType.JS)` |
| 其他 Exception | `showNewJavaError(拼接的 cause 链, e)` |

**【发现】`JavascriptException` 分支传的是 `arrayOf()` —— 结构化栈帧数组为空。**

| 侧 | RedBox 拿到的 `stack` |
| --- | --- |
| **Android（JS 异常）** | **`arrayOf()` 空**（栈已格式化进 `e.message`） |
| iOS（22 文档） | `details` 参数，**有结构化栈** |

**排查影响**：Android 上 JS 异常的 RedBox 里，
栈**不是可折叠的组件栈**，而是一段已格式化的文本。

**`cause` 链拼接**（`:300-304`）用 `\n\n` 连接整条链 ——
解决「异常被多层包装后原始 message 被埋没」。

### 4.3 分流总开关

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManagerBase.kt:247-253
  override fun handleException(e: Exception) {
    if (isDevSupportEnabled) {
      logJSException(e)
    } else {
      defaultJSExceptionHandler.handleException(e)
    }
  }
```

**完整链路**：

```
异常发生（Java 侧或 JS 侧 throw）
  ↓
DevSupportManagerBase.handleException(e)          [DevSupportManagerBase.kt:247]
  ├─ isDevSupportEnabled == true（开发模式）
  │    └─ logJSException(e)                        [:298]
  │         ├─ JavascriptException
  │         │    → FLog.e + showNewError(空栈, JSEXCEPTION_ERROR_COOKIE, ErrorType.JS) → RedBox
  │         └─ 其他 Exception
  │              → showNewJavaError(cause 链拼接, e)          [:256]
  │                   → FLog.e + showNewError(Java 栈帧, JAVA_ERROR_COOKIE, ErrorType.NATIVE) → RedBox
  └─ isDevSupportEnabled == false
       └─ defaultJSExceptionHandler.handleException(e)      [DefaultJSExceptionHandler.kt:15]
            └─ throw e（RuntimeException 原样重抛）→ 进程崩溃
```

**`defaultJSExceptionHandler` 是 `DevSupportManagerBase` 的私有字段**，
`ReleaseDevSupportManager` 也自己 new 了一个（`:37`）——
但发布模式下 `DevSupportManagerBase` 根本不会被创建（§3.4）。

### 4.4 `showNewError` 的「只显示第一个」策略

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManagerBase.kt:336-339
      if (redBoxSurfaceDelegate?.isShowing() == true) {
        // Sometimes errors cause multiple errors to be thrown in JS in quick succession. Only
        // show the first and most actionable one.
        return@runOnUiThread
      }
```

**注释说明了策略**：JS 短时间内连抛多个异常时，**只显示第一个**。

**对照 iOS**：22 文档记录的 `RCTRedBox` 侧有 `errorCookie` 机制用于关联
「RedBox 里点 Reload 后 JS 侧知道该 rethrow 哪个异常」。

**Android 侧同样有 `errorCookie`**（`JSEXCEPTION_ERROR_COOKIE` / `JAVA_ERROR_COOKIE`），
但「只显示第一个」的策略意味着**后续异常的 cookie 被丢弃**。

---

## 5. 【核心发现】`JSExceptionHandler` 接口注释里的设计哲学

`bridge/JSExceptionHandler.kt:10-21`：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/JSExceptionHandler.kt:10-21
/**
 * Interface for a class that knows how to handle an Exception invoked from JS. Since these
 * Exceptions are triggered by JS calls (and can be fixed in JS), a common way to handle one is to
 * show a error dialog and allow the developer to change and reload JS.
 *
 * We should also note that we have a unique stance on what 'caused' means: even if there's a bug in
 * the framework/native code, it was triggered by JS and theoretically since we were able to set up
 * the React Instance, JS could change its logic, reload, and not trigger that crash.
 */
public fun interface JSExceptionHandler {
  /** Do something to display or log the exception. */
  public fun handleException(e: Exception)
}
```

**第二段是全仓库少见的「立场声明」**：

> 「我们对于『谁导致了崩溃』持有一个**独特的立场**：
> 即使 bug 在框架/原生代码里，**它也是被 JS 触发的**，
> 而且理论上既然我们能建立起 React Instance，
> **JS 可以改变逻辑、reload，从而不再触发这个崩溃。**」

**这解释了为什么「显示错误对话框 + 允许开发者改代码并 reload」是一等公民处理方式**
（第一段：*a common way to handle one is to show a error dialog and allow the developer to
change and reload JS*）。

| 立场 | 后果 |
| --- | --- |
| 崩溃「可由 JS 修复」 | 不需要精确的崩溃归因 → **不需要内建上报** |
| 「reload 可能修复」 | 提供 reload 快捷键比提供崩溃报告更有价值 → `DoubleTapReloadRecognizer` |

**`fun interface`（SAM）** 的设计意图也被印证 ——
`DevSupportManagerBase.kt:236-245` 有一处 lambda 用法：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManagerBase.kt:236-245
          PerfMonitorOverlayManager(
              reactInstanceDevHelper,
              { openDebugger(DebuggerFrontendPanelName.PERFORMANCE.toString()) },
          )
```

> **这是 RN 「不上报崩溃」的哲学依据**，与 04 文档的 iOS 事实互为解释。
>
> **但这个立场有明显的适用边界**：
>
> | 场景 | 该立场是否成立 |
> | --- | --- |
> | **开发期**（RedBox + reload） | ✅ 成立 —— 开发者确实会改代码 |
> | **发布期**（`ReleaseDevSupportManager` 丢弃 + `DefaultJSExceptionHandler` 重抛） | ❌ **不成立** —— 用户不会改代码，且没有崩溃报告 |
>
> **即：「不上报崩溃」在开发期是设计选择，在发布期是缺失。**
> 同一段注释只解释了前者。

---

## 6. `StackTraceHelper`：JS 与 Java 双通道的栈解析

`devsupport/StackTraceHelper.kt:27-46` 定义 **13 个键名常量** 与 **2 个正则**：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/StackTraceHelper.kt:42-46
  private val STACK_FRAME_PATTERN1: Pattern =
      Pattern.compile("^(?:(.*?)@)?(.*?)\\:([0-9]+)\\:([0-9]+)$")
  private val STACK_FRAME_PATTERN2: Pattern =
      Pattern.compile("\\s*(?:at)\\s*(.+?)\\s*[@(](.*):([0-9]+):([0-9]+)[)]$")
```

| 正则 | 处理的格式 | 捕获组 |
| --- | --- | --- |
| `PATTERN1` | `method@file:line:col`（Hermes） | 1=method, 2=file, 3=line, 4=col |
| `PATTERN2` | `  at method (file:line:col)`（V8/JSC） | 1=method, 2=file, 3=line, 4=col |

### 6.1 三个 `convertJsStackTrace` 重载

| 重载 | 入参 | 场景 |
| --- | --- | --- |
| `(ReadableArray?)` | TurboModule 边界类型 | **主路径**（`:49`） |
| `(JSONArray?)` | 旧 JSON API | 兼容（`:95`） |
| `(String)` | 已格式化的栈文本 | **兜底**（`:129`） |

`(String)` 重载用两条正则逐行匹配，**都不匹配就把整行当 `method`**：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/StackTraceHelper.kt:136-153
      if (matcher != null) {
        val file = matcher.group(2)
        val method = matcher.group(1) ?: "(unknown)"
        val lineString = matcher.group(3)
        val columnString = matcher.group(4)
        StackFrameImpl(
            file = file,
            method = method,
            line = checkNotNull(lineString).toInt(),
            column = checkNotNull(columnString).toInt(),
        )
      } else {
        StackFrameImpl(file = null, method = stackTrace[i], line = -1, column = -1)
      }
```

**先试 `PATTERN2` 再试 `PATTERN1`**（`:131-138` 的 `when` 顺序）——
**V8 格式优先**，因为 `at method (file:...)` 更具体。

**兜底分支把整行文本当 method 名** —— 保证「解析失败不丢帧」，但该帧不可点击跳转。

### 6.2 主路径（`ReadableArray`）的三分支

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/StackTraceHelper.kt:56-88
      val type = stack.getType(i)
      if (type == ReadableType.Map) {
        val frame = requireNotNull(stack.getMap(i))
        ...
        StackFrameImpl(file = file, method = method, line = lineNumber, column = columnNumber, isCollapsed = collapse)
      } else if (type == ReadableType.String) {
        StackFrameImpl(file = null, method = checkNotNull(stack.getString(i)), line = -1, column = -1)
      } else {
        error("Cannot parse the stackframe for $stack")
      }
```

| `type` | 处理 |
| --- | --- |
| `Map` | 完整解析（`requireNotNull` 强制 `methodName`/`file` 存在） |
| `String` | 整个字符串当 method，`line`/`column` 为 `-1` |
| **其他** | **`error(...)` 抛 `IllegalStateException`** |

**`error()` 分支是唯一的硬失败点** —— 若 JS 侧传了数字或 null 元素，
**整个栈解析抛异常**，进而可能掩盖原始错误。

**`lineNumber`/`columnNumber` 有 `hasKey` + `isNull` 双重保护**（缺省 `-1`），
而 `methodName`/`file` 用 `requireNotNull` **无保护** —— 两者严格程度不同。

**`collapse` 字段**（`:61-64`）标记「该帧是否被折叠」——
用于把 bundle 内部的连续帧折叠成一行。

### 6.3 `convertJavaStackTrace` 的 `column` 恒为 -1

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/StackTraceHelper.kt:158-170
  public fun convertJavaStackTrace(exception: Throwable): Array<StackFrame> {
    val stackTrace = exception.stackTrace
    return Array(stackTrace.size) { i ->
      StackFrameImpl(
          file = stackTrace[i].className,
          fileName = stackTrace[i].fileName,
          method = stackTrace[i].methodName,
          line = stackTrace[i].lineNumber,
          column = -1,
      )
    }
  }
```

| 字段 | 来源 |
| --- | --- |
| `file` | `stackTrace[i].className`（**类名，不是文件名**） |
| `fileName` | `stackTrace[i].fileName`（可能为 `null`） |
| `method` | `stackTrace[i].methodName` |
| `line` | `stackTrace[i].lineNumber` |
| **`column`** | **硬编码 `-1`** |

**Java 栈无列号信息** —— 这是语言层面的限制，硬编码 `-1` 是正确的。

**注意 `file` 与 `fileName` 是两个不同字段**：
前者是类名（用于匹配源码位置），后者是文件名字符串（可能为 null）。

---

## 7. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| FF-1 | **已废弃的 `create()` 重载从不返回 `DevSupportManagerBase`** —— `enableOnCreate=true` 也只给 Inspector | `devsupport/DefaultDevSupportManagerFactory.kt:47-52` | **11 个参数中 10 个被丢弃**；RedBox/LogBox/shake/reload 全不可用 |
| FF-2 | `UNSTABLE_ENABLE_FUSEBOX_RELEASE` 优先于 `useDevSupport`，**连带禁用 Dev Options 与快捷键**（因 `PerftestDevSupportManager` 是 `ReleaseDevSupportManager` 的子类） | `DefaultDevSupportManagerFactory.kt:63` + `ReactDelegate.kt:267,394` | 大概率有意，**但无注释说明这个耦合** |
| FF-3 | `StackTraceHelper.convertJsStackTrace(ReadableArray?)` 对非 Map/String 类型 `error(...)` 抛异常 | `StackTraceHelper.kt:86` | **可能掩盖原始 JS 错误**；无兜底 |
| FF-4 | `JavascriptException` 分支传 `arrayOf()` 空栈帧数组，RedBox 里栈不可折叠 | `DevSupportManagerBase.kt:307` | 与 iOS 侧行为不一致（22 文档） |
| FF-5 | `isFatal` 缺键时降级为 soft（fatal → 只 log 不崩） | `ExceptionsManagerModule.kt:52` | 保守默认；**但 JS 侧字段名拼错会导致静默降级** |
| FF-6 | 「只显示第一个」策略丢弃后续异常的 `errorCookie` | `DevSupportManagerBase.kt:336-339` | 注释解释了「只显示最可操作的」，但 cookie 丢失无说明 |
| FF-7 | `convertJsStackTrace(ReadableArray?)` 对 `methodName`/`file` 用 `requireNotNull`，对 `line`/`column` 用 `hasKey` 保护 —— 严格程度不一致 | `StackTraceHelper.kt:58-70` | `methodName` 缺失会抛；`lineNumber` 缺失只降级 |
| FF-8 | 「JS 可修复崩溃」的立场在发布期不成立，但注释只解释了开发期 | `bridge/JSExceptionHandler.kt:15-18` | 哲学的适用边界未被文档化 |

### FF-1 的清理建议

`@Deprecated` 已标记，但**函数体仍是「只返回两种空实现」的实质**。
两个选择：

| 方案 | 说明 |
| --- | --- |
| **A** | 删掉该重载（`@Deprecated` 的 `replaceWith` 已指向新签名） |
| **B** | 补上 `DevSupportManagerBase` 分支，传齐 11 个参数 |

**当前状态是两者之间的一个模糊地带**：有 `@Deprecated` 标记（意图删除），
但仍会被外部调用方（若未迁移）用错。

---

## 8. 「空实现」的两种处置方式（与 37 文档对照）

37 文档记录 iOS `RCTUIManager` 的 21 个方法全桩且**无任何标注**；
本文的 Android `ReleaseDevSupportManager` 是同类但**处置更规范**：

| 维度 | iOS `RCTUIManager`（37 文档） | Android `ReleaseDevSupportManager`（本文） |
| --- | --- | --- |
| 是否注释说明 | ❌ 无 | ✅ **类注释明说「dummy for production」** |
| 是否标注 `@Deprecated`/门控 | ❌ | ✅ 工厂里的 `useDevSupport` 分支 |
| 是否有替代实现 | ✅ `DevSupportManagerBase` | ✅ `DevSupportManagerBase` + `Bridgeless` |
| 运行期是否裁剪 | 编译期（`RCT_DEV_MENU`） | **运行期类型判断**（`ReactDelegate` 4 处） |
| 类名是否自解释 | ❌ `RCTUIManager` | ✅ **`ReleaseDevSupportManager`** |

> **「类名即文档」是一个廉价的但有效的做法** ——
> `ReleaseDevSupportManager` 一眼就能看出用途，
> 而 `RCTUIManager` 的空实现必须读完全文才能发现。

---

## 9. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 04 文档：iOS 侧 RN 不实现崩溃上传（三项零命中） | **补上 Android 侧独立证据**（三项零命中）→ **结论可跨平台泛化**（§2.1） |
| 05 文档：检测/上报原理 | **补上 Android 的异常链全貌**（§4.3）与栈解析三通道（§6） |
| 22 文档：iOS `RCTRedBox` 与 `errorCookie` | **对照**：Android 侧 JS 异常传空栈帧数组（FF-4）；且「只显示第一个」丢弃 cookie（FF-6） |
| 28 文档：`RCT_DEV_MENU` 编译期门控 | **对照**：Android 是**运行期** `is ReleaseDevSupportManager`（§3.5），且多一层编译期 `UNSTABLE_ENABLE_FUSEBOX_RELEASE`（§3.3） |
| 30 文档 §4.4 / 39 文档 §6.3：两个 DEBUGGER/INTEROP 宏 | **新增第三种形态**：「降级」语义的 `UNSTABLE_ENABLE_FUSEBOX_RELEASE`（§3.3） |
| 37 文档：iOS 侧「接口在、实现空」的判据 | **补上 Android 的对照**（§8），并给出继承树这个更强的判据（§3.4） |
| 39 文档 DD-2：最大的段落最缺文档 | **同类**：§3.2 的 11 参数重载函数体只用 1 个 |

---

## 10. 宿主 App 接入崩溃上报的正确位置

**RN 不提供上报，但提供了接入点**。三种方式：

| 方式 | 接入点 | 能拿到什么 |
| --- | --- | --- |
| **① 全局未捕获处理器**（推荐） | 宿主 `Application.onCreate` 里 `Thread.setDefaultUncaughtExceptionHandler` | **所有**崩溃，含非 RN 的 |
| ② `RedBoxHandler` | 传给 `create(...)` 的 `redBoxHandler` 参数 | 开发期的 JS/native 错误（**仅 dev 有效**，FF-1） |
| ③ `ExceptionsManagerModule.reportException` | JS 侧 `ExceptionsManager.reportException(...)` | JS 主动上报的非 fatal |

**① 是唯一在发布环境可用的方式** —— 且 RN 完全不占用该位置，不冲突。

> **这是本文对宿主最实用的一条结论**：
> **RN 既不注册也不禁止全局 handler**，
> 宿主可以放心安装自己的崩溃上报 SDK。