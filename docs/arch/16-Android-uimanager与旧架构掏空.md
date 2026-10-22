---
id: 16
title: "Android uimanager：旧架构的掏空状态与属性反射机制"
topic: PL.android
symptoms: [prop]
platforms: [android]
architecture: [legacy]
layer: T3
symbols: ["UIManagerModule", "NativeViewHierarchyManager"]
claims: [AIM-1, AIM-2, AIM-3, AIM-4, AIM-5, AIM-6, AIM-7, AIM-8]
---
# 16 · Android uimanager：旧架构的掏空状态与属性反射机制

> **模块**：C2 · 子批次 4b（`ReactAndroid/.../uimanager`，130 个非测试文件）
> **基线**：react-native @ `9b131e42` · Android 侧
> **前置**：[15 文档](./15-Android启动与宿主API.md) 讲了宿主与启动；[10 文档](./10-Fabric组件层与视图扁平化.md) 讲了 C++ 侧扁平化。
> 本文讲 **Android 的 uimanager 层现在还剩什么** —— 答案是：**一半已被系统性掏空成空壳**。

---

## 1. 目录构成（uimanager 全部子目录）

| 子目录 | 文件数 | 状态 |
| --- | --- | --- |
| `events/` | 24 | 部分有效（`EventDispatcher` 仍是活的） |
| `style/` | 18 | 有效（样式解析） |
| `drawable/` | 8 | 有效（背景/边框绘制） |
| `annotations/` | 3 | 有效（`@ReactProp` 等） |
| `common/` | 2 | 有效 |
| `util/` `internal/` | 2 | 有效 |
| 根级 | 73 | **混杂**：一部分空壳，一部分仍完整 |

**根级 73 个文件是本模块的核心矛盾所在**：`ViewManager.java`（503 行）、
`BaseViewManager.java`（1085 行）仍有完整实现，
而 `UIViewOperationQueue.kt`（142 行）已全是空函数。

---

## 2. 关键发现：旧架构视图层已被系统性掏空

### 2.1 `UIViewOperationQueue` 整个类是空壳

`uimanager/UIViewOperationQueue.kt:56-71`：

```kotlin
  /** Profiles the next batch of UI operations. */
  public fun profileNextBatch() {}

  /** Returns profiled batch performance counters. */
  public fun getProfiledBatchPerfCounters(): Map<String, Long> = HashMap()

  /** Returns whether the operation queue is empty. */
  public fun isEmpty(): Boolean = true

  /** Adds a root view with the given tag. */
  public fun addRootView(tag: Int, rootView: View) {}
```

**23 个方法全部是空实现**（另有一个 `UIOperation.execute()` 接口声明无实现）。`isEmpty()` 恒返回 `true`，
`getProfiledBatchPerfCounters()` 恒返回空 Map。

类注释（`:18-29`）仍完整描述了它本应承担的职责：

```
 * This class acts as a buffer for command executed on [NativeViewHierarchyManager]. It expose
 * similar methods as mentioned classes but instead of executing commands immediately it enqueues
 * those operations in a queue that is then flushed from [UIManagerModule] once JS batch of ui
 * operations is finished. This is to make sure that we execute all the JS operation coming from a
 * single batch a single loop of the main (UI) android looper.
```

> **批处理管线（把一个 JS 批次的全部 UI 操作压进一次主线程 looper）已完全停用。**
> 这曾是 RN 性能的核心设计之一。类注释与实现严重脱节 —— 读注释会误以为它还在工作。

### 2.2 `NativeViewHierarchyManager` 同样被掏空

`uimanager/NativeViewHierarchyManager.kt:17-23`：

```kotlin
 * This class is part of Legacy Architecture and has been stubbed out. It will be removed in a
...
@LegacyArchitecture(logLevel = LegacyArchitectureLogLevel.ERROR)
@Deprecated("This class is part of Legacy Architecture and will be removed in a future release")
public open class NativeViewHierarchyManager {
```

**类注释直接写明 "has been stubbed out"**（比 `UIViewOperationQueue` 诚实）。

**全部 26 个方法定义都是空实现**（`:33` 起，其中 `updateLayout` 与 `dispatchCommand` 各有 2 个重载）：

```kotlin
  public fun resolveView(tag: Int): View? = null

  public fun resolveViewManager(tag: Int): ViewManager<*, *>? = null

  public open fun setLayoutAnimationEnabled(enabled: Boolean): Unit = Unit
```

`updateLayout`、`createView`、`manageChildren`、`setChildren`、`addRootView` **全部无效**。

### 2.3 但 `UIManagerModule` 仍有完整实现

**这是最容易误判的地方**。`UIManagerModule.kt` 有 645 行、59 个方法，
虽然同样标注了：

```kotlin
@LegacyArchitecture(logLevel = LegacyArchitectureLogLevel.ERROR)
@Deprecated("This class is part of Legacy Architecture and will be removed in a future release")
```

但它**不是空壳** —— `invalidate()`（`:149-155`）有真实的清理逻辑：

```kotlin
  override fun invalidate() {
    super.invalidate()

    val reactApplicationContext = getReactApplicationContext()
    reactApplicationContext.unregisterComponentCallbacks(mMemoryTrimCallback)
    reactApplicationContext.unregisterComponentCallbacks(mViewManagerRegistry)
    ViewManagerPropertyUpdater.clear()
  }
```

**结论：旧架构是「标记弃用 + 选择性掏空」，不是「整体删除」。**
不能因为 `UIViewOperationQueue` 是空壳就推断整个 uimanager 层都没用了。

### 2.4 空壳分布（实测）

扫描 `ReactAndroid/src/main/java/com/facebook/react` 全部 696 个非测试源码文件，
按「空方法体数」排序：

| 文件 | 行数 | 方法数 | 空体数 | `@LegacyArchitecture` |
| --- | --- | --- | --- | --- |
| `uimanager/NativeViewHierarchyManager.kt` | 184 | 26 | **26** | 是 |
| `uimanager/UIViewOperationQueue.kt` | 142 | 23 | **23** | 是 |
| `uimanager/events/BlackHoleEventDispatcher.kt` | 37 | 7 | **5** | 否 |
| `devsupport/ReleaseDevSupportManager.kt` | 167 | 29 | **27** | 否 |
| `internal/featureflags/ReactNativeFeatureFlagsDefaults.kt` | 203 | 89 | 73 | 否 |
| `uimanager/UIManagerModule.kt` | 645 | 59 | 25 | 是 |
| `uimanager/events/Event.kt` | 213 | 20 | 6 | 否 |
| `views/scroll/ReactNestedScrollView.kt` | 1324 | 87 | 6 | 否 |

**两个「高比例空体」需要区分对待**：

| 文件 | 空体多的原因 | 是否有害 |
| --- | --- | --- |
| `NativeViewHierarchyManager` / `UIViewOperationQueue` | 旧架构被移除 | 无（旧路径已不走） |
| `ReleaseDevSupportManager` | **Release 模式的设计**：见 §3.1 | 无（Debug 有另一份实现） |
| `ReactNativeFeatureFlagsDefaults` | **codegen 产物**：每个 flag 一个 getter 委托给动态 provider | 无（是设计） |
| `UIManagerModule` | 部分方法标记 deprecated 保留签名 | **需逐个确认** |

> **`ReactNativeFeatureFlagsDefaults.kt` 的 73/89 不代表失效** ——
> 它是 `yarn featureflags` 生成的访问器，每个 flag 一个方法。
> 这是本模块「不要只看数字下结论」的典型例子。

### 2.5 `ReleaseDevSupportManager`：空体是设计而非缺陷

`devsupport/ReleaseDevSupportManager.kt:31-35`：

```kotlin
/**
 * A dummy implementation of [DevSupportManager] to be used in production mode where development
 * features aren't needed.
 */
public open class ReleaseDevSupportManager : DevSupportManager {
```

**类注释写明是 "A dummy implementation ... to be used in production mode"。**
27/29 个空方法是有意的 —— 生产环境不需要 RedBox、DevMenu、reload。

**但保留了一个真实实现**（`:37`）：

```kotlin
  private val defaultJSExceptionHandler: JSExceptionHandler = DefaultJSExceptionHandler()
```

**这正是 04 文档所述「Release 下 rethrow → 崩溃」的关键节点** ——
空壳不等于「什么都不做」，异常处理路径仍在。

---

## 3. 守卫机制：`@LegacyArchitecture` 及其从未启用的开关

### 3.1 注解与 Logger

`common/annotations/internal/LegacyArchitectureLogger.kt:34-45`：

```kotlin
  @JvmStatic
  public fun assertLegacyArchitecture(
      name: String,
      logLevel: LegacyArchitectureLogLevel = LegacyArchitectureLogLevel.WARNING,
  ) {
    if (ReactBuildConfig.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE) {
      executeAssert(name, logLevel)
    }
  }
```

`executeAssert`（`:47-66`）在 DEBUG 下按 `logLevel` 分流：

```kotlin
    if (ReactBuildConfig.DEBUG) {
      val exceptionMessage = "is being executed when app is fully running on the NEW Architecture."
      when (logLevel) {
        LegacyArchitectureLogLevel.ERROR -> {
          throw AssertionException("$name $exceptionMessage")
        }

        LegacyArchitectureLogLevel.WARNING -> {
          ReactSoftExceptionLogger.logSoftException(
              ReactSoftExceptionLogger.Categories.SOFT_ASSERTIONS,
              ReactNoCrashSoftException("$name $exceptionMessage"),
          )
        }
      }
    }
```

两层门控：`UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE` **且** `DEBUG`。

注释坦承这是临时状态（`:49-51`）：

> Assert is being reported only in DEBUG mode to prevent over logging in production
> while we are working on decoupling legacy / new architecture.
> Long term the assert will be executed in production and debug environments.

### 3.2 开关硬编码为 false —— 守卫从未启用

`ReactAndroid/build.gradle.kts:601`：

```kotlin
    buildConfigField("boolean", "UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE", "false")
```

**全仓库只有这一处赋值**（无 flavor 覆盖）。源码中它出现在 **18 处、涉及 10 个文件**
（其中 `common/build/ReactBuildConfig.kt` 的 2 处是字段声明本身，不算行为分支，
故**实际行为分支 16 处、9 个文件**）：

| 引用位置 | 控制的行为 |
| --- | --- |
| `common/annotations/internal/LegacyArchitectureLogger.kt:39` | **整个断言机制的总开关** |
| `runtime/ReactHostImpl.kt:605, 857` | legacy 组件裁剪；与 `useFabricInterop` / `useTurboModuleInterop` 互斥检查 |
| `runtime/BridgelessReactContext.kt:83` | legacy 清理 |
| `internal/featureflags/ReactNativeNewArchitectureFeatureFlags.kt:28, 40, 52` | 强制关闭互相关 Feature Flag |
| `uimanager/ViewManager.java:409` | `getNativeProps()` 走哪条路径 |
| `views/textinput/ReactEditText.kt:997` | legacy 行为分支 |
| `views/modal/ReactModalHostView.kt:559-560` | legacy 行为分支 |
| `views/safeareaview/ReactSafeAreaView.kt:57` | legacy 行为分支 |
| `modules/debug/FpsDebugFrameCallback.kt:57` | legacy 行为分支 |

> **这是本模块最重要的单条事实**：
> **「检测旧架构误用」的整套机制在 OSS 构建中从未启用。**
> 一个误用 legacy API 的调用在 Release 下**完全不会被发现**。
>
> 同时 `ReactHostImpl.kt:857-864` 的互斥检查也一并失效：

```kotlin
    if (ReactBuildConfig.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE) {
      ...
          "useFabricInterop FeatureFlag must be false when UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE == true.",
      ...
          "useTurboModuleInterop FeatureFlag must be false when UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE == true.",
```

**这套「旧架构收敛」的自我保护机制是关闭的** —— 与 [08 文档](./08-组件注册表与惰性注册.md) E1-1
（`ComponentDescriptorProviderRegistry` 的 assert 被注释掉）属同一类问题：
**关键不变量缺少运行期校验。**

---

## 4. 属性机制：反射 + 缓存

`ViewManagersPropertyUpdater` 委托给 `ViewManagersPropertyCache`（552 行）。

### 4.1 递归扫描父类 + 一次性缓存

`ViewManagersPropertyCache.kt:346-366`：

```kotlin
  @JvmStatic
  internal fun getNativePropSettersForViewManagerClass(
      cls: Class<out ViewManager<*, *>>,
  ): Map<String, PropSetter> {
    if (cls == ViewManager::class.java) {
      return EMPTY_PROPS_MAP
    }
    CLASS_PROPS_CACHE[cls]?.let {
      return it
    }
    // This is to include all the setters from parent classes. Once calculated the result will be
    // stored in CLASS_PROPS_CACHE so that we only scan for @ReactProp annotations once per class.
    @Suppress("UNCHECKED_CAST")
    val props: MutableMap<String, PropSetter> =
        HashMap(
            getNativePropSettersForViewManagerClass(cls.superclass as Class<out ViewManager<*, *>>),
        )
    extractPropSettersFromViewManagerClassDefinition(cls, props)
    CLASS_PROPS_CACHE[cls] = props
    return props
  }
```

**递归收集父类 setter，合并进 `HashMap` 后缓存。**
注释明说目的：「only scan for @ReactProp annotations once per class」。

`:350-352` 的基类判断是一个**递归终止条件** —— `ViewManager::class.java` 返回空 Map，
防止向上无限递归。

### 4.2 反射读取注解

`:484` / `:526`：

```
      val annotation = method.getAnnotation(ReactProp::class.java)
```

**`@ReactProp` 是运行时保留注解**（否则 `getAnnotation` 拿不到），
每个 ViewManager 类首次访问时扫描全部方法。

### 4.3 缓存持有 Class 强引用

`:32` / `:36-37`：

```
  private val CLASS_PROPS_CACHE: MutableMap<Class<*>, Map<String, PropSetter>> = HashMap()
  fun clear() {
    CLASS_PROPS_CACHE.clear()
```

`HashMap<Class<*>, ...>` 持有 `Class` 强引用 → 持有 `ClassLoader`。
`ViewManagerPropertyUpdater.kt:34-35` 还有两个同类静态 Map。

**清理时机（已核实，非缺失）**：

| 调用点 | 时机 |
| --- | --- |
| `fabric/FabricUIManager.java:499` | `onCatalystInstanceDestroy()` 路径 |
| `uimanager/UIManagerModule.kt:154` | `invalidate()` |

```kotlin
  public fun clear() {
    ViewManagersPropertyCache.clear()
    VIEW_MANAGER_SETTER_MAP.clear()
    SHADOW_NODE_SETTER_MAP.clear()
  }
```

**设计是完整的** —— 实例销毁时清理，类引用不会跨实例累积。

> 但要注意：**`clear()` 只在实例销毁时调用，不在类卸载时调用。**
> 若 App 长期只创建一个实例（`DefaultReactHost` 单例的正常用法，见 15 文档 §2），
> 这些 `Class` 引用会一直存在 —— 这本身是正确的（缓存本就该存活），
> 但意味着**热重载类路径的场景下缓存不会失效**。

---

## 5. 事件黑洞：`BlackHoleEventDispatcher`

`uimanager/events/BlackHoleEventDispatcher.kt:16-22`：

```kotlin
internal object BlackHoleEventDispatcher : EventDispatcher {
  override fun dispatchEvent(event: Event<*>) {
    FLog.d(
        "BlackHoleEventDispatcher",
        "Trying to emit event to JS, but the React instance isn't ready. Event: ${event.getEventName()}",
    )
  }
```

**唯一有实现的方法只打 logcat，然后丢弃。**
其余 6 个方法（`dispatchAllEvents` / `addListener` / `removeListener` /
`addBatchEventDispatchedListener` / `removeBatchEventDispatchedListener` /
`onCatalystInstanceDestroyed`）全是 `= Unit`。

### 5.1 何时启用

`runtime/ReactHostImpl.kt:582-591`：

```kotlin
  internal val eventDispatcher: EventDispatcher
    /**
     * Get the [EventDispatcher] from the [FabricUIManager]. This always returns an EventDispatcher,
     * even if the instance isn't alive; in that case, it returns a [BlackHoleEventDispatcher] which
     * no-ops.
     *
     * @return The real [EventDispatcher] if the instance is alive; otherwise, a
     *   [BlackHoleEventDispatcher].
     */
    get() = reactInstance?.eventDispatcher ?: BlackHoleEventDispatcher
```

**实例未存活时返回黑洞。**

`UIManagerModule.kt:464-468` 的实现更彻底 —— **恒定返回黑洞，无条件判断**：

```kotlin
  // Java original returned null, but the UIManager interface requires non-null.
  // BlackHoleEventDispatcher silently discards events, matching the legacy no-op behavior.
  override val eventDispatcher: EventDispatcher
    get() = BlackHoleEventDispatcher
```

**第一行注释记录了一次接口重构的痕迹**：Java 版返回 `null`，
但 `UIManager` 接口要求非空，于是改成返回一个「永不派发」的对象。
**这正是把 null 语义编码进类型的做法** —— 比返回 null 更安全，因为调用方不会漏判空，
但代价是**调用方无法从类型上区分「真的没有 dispatcher」和「有但是黑洞」**。

`events/EventDispatcherProvider.kt:15-21` 明确了接口契约：

```
  /**
   * This should always return an [EventDispatcher], even if the instance doesn't exist; in that
   * case it should return the empty [BlackHoleEventDispatcher].
   *
   * @return An [EventDispatcher] to emit events to JS.
   */
```

> **对监控/排障的影响**：实例未就绪期间产生的事件**只进 logcat，不进任何 JS 侧通道**。
> 用 `FLog.d` 而非 `FLog.w`/`FLog.e` —— **Release 下 logcat 通常被裁剪，等于静默丢失**。
> 这与 [08 文档](./08-组件注册表与惰性注册.md) 的「UnimplementedView 在 Release 下变空视图」
> 是同一类问题：**调试期有提示，生产期完全静默。**

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| AIM-1 | `UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE` 硬编码 `false`，**16 处行为分支**（10 文件 / 18 处引用）与整套 legacy 断言全部关闭 | `ReactAndroid/build.gradle.kts:601` | 旧架构误用无任何检测；`ReactHostImpl.kt:857-864` 的 FeatureFlag 互斥检查也失效 |
| AIM-2 | `UIViewOperationQueue` 23 个方法全空，但类注释仍完整描述其职责 | `uimanager/UIViewOperationQueue.kt:18-29` | 读注释会误判它仍在工作；这是最容易踩的文档陷阱 |
| AIM-3 | `NativeViewHierarchyManager` 26 个方法全部空实现 | 同上目录 `NativeViewHierarchyManager.kt:33-174` | 旧路径误调用会静默无效（`resolveView` 返回 null、`updateLayout` 无副作用） |
| AIM-4 | `BlackHoleEventDispatcher` 用 `FLog.d` 记录被丢弃的事件 | `uimanager/events/BlackHoleEventDispatcher.kt:17-22` | Release 下 logcat 裁剪 → 事件彻底静默丢失 |
| AIM-5 | `UIManagerModule.eventDispatcher` 恒返回黑洞，调用方无法区分「无 dispatcher」与「黑洞」 | `uimanager/UIManagerModule.kt:464-468` | 旧路径上所有事件无条件丢弃；无任何信号 |
| AIM-6 | `CLASS_PROPS_CACHE` 等 3 个静态 Map 持有 `Class` 强引用，仅在实例销毁时清理 | `ViewManagersPropertyCache.kt:32`、`ViewManagerPropertyUpdater.kt:34-35` | 单例长驻时缓存不失效（符合设计，但热重载场景需注意） |
| AIM-7 | `ViewManager.getNativeProps()` 的 legacy 分支永不执行 | `uimanager/ViewManager.java:409-415` | `getShadowNodeClass()` 分支恒定被使用 |
| AIM-8 | 空体比例高的文件成因各异（移除/dummy/codegen/弃用），无统一标识可机读 | 见 §2.4 | 静态分析工具无法区分「有意空实现」与「失效代码」 |

AIM-8 是方法论问题：**「空方法体」在本仓库有 4 种截然不同的成因**，
不能单靠数量判断，必须结合 `@LegacyArchitecture` 注解与类注释。

---

## 7. 与其他文档的衔接

- 旧架构不可关闭的平台不对称 → [15 文档 §1.1-1.2](./15-Android启动与宿主API.md)
- C++ 侧扁平化与 Trait（决定哪些节点真的有原生 View）→ [10 文档](./10-Fabric组件层与视图扁平化.md)
- 事件分发链路与 `EventDispatcher` → [03 文档](./03-核心技术原理.md)
- 「调试有提示、生产静默」这一模式 → [08 文档 E1-4](./08-组件注册表与惰性注册.md)
- Android 崩溃上报（`ReleaseDevSupportManager` 的例外路径）→ [04 文档](./04-崩溃日志捕获收集处理上传.md)
- Android 原生 View 实现 → 批次 4c

---

## 8. 验证方式

```bash
node docs/arch/audit/audit-citations.mjs    # 引用可达性
node docs/arch/audit/verify-quotes.mjs      # 代码块语义
node docs/arch/audit/verify-claims.mjs      # 核心事实断言
```
