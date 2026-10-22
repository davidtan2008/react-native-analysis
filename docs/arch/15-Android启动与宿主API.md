---
id: 15
title: "Android 启动与宿主 API：ReactHost / ReactInstanceManager"
topic: RT.host
symptoms: [slowstart, whitescreen]
platforms: [android]
architecture: [cross]
layer: T3
symbols: ["ReactActivity", "ReactHost", "ReactInstance"]
sourceRoot: react-native
claims: []
---
# 15 · Android 启动与宿主 API：ReactHost / ReactInstanceManager

> **模块**：E7（`ReactAndroid/src/main/java/com/facebook/react` 根级 API 与横切小包，135 个非测试文件）
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · Android 侧
> **前置**：[11 文档](./11-运行时与错误桥.md) 讲了 C++ 侧 `ReactInstance`；[13 文档](./13-JS启动装配.md) 讲了 JS 侧装配。
> 本文讲 **Android 的 Java/Kotlin 层如何把这两端接起来**，以及启动过程中**已经埋好的监控数据源**。

---

## 1. 两条并存的宿主 API

Android 侧有两套宿主抽象，**同时存在**：

| API | 状态 | 文件 | 说明 |
| --- | --- | --- | --- |
| `ReactNativeHost` | 旧（bridge 模式） | `ReactNativeHost.kt` | 抽象类，需继承 |
| **`ReactHost`** | **新（bridgeless 模式）** | `ReactHost.kt` | 接口，`DefaultReactHost` 提供默认实现 |

`ReactHost.kt:23-30` 的类注释说明了设计意图：

```kotlin
/**
 * A ReactHost is an object that manages a single [com.facebook.react.runtime.ReactInstance]. A
 * ReactHost can be constructed without initializing the ReactInstance, and it will continue to
 * exist after the instance is destroyed.
 *
 * The implementation of this interface should be Thread Safe
 */
public interface ReactHost {
```

三个要点：

1. **宿主与实例生命周期解耦** —— Host 活得比 ReactInstance 长
2. **可以先构造后初始化**（`start()` 是可选的，见 §3.1）
3. **契约要求线程安全**，但接口本身不提供任何同步保证 —— 责任在实现方

### 1.1 旧架构已在 Android 硬移除

`DefaultReactNativeHost.kt:42-48`：

```kotlin
      if (isNewArchEnabled) {
        DefaultTurboModuleManagerDelegate.Builder()
      } else {
        error(
            "Overriding isNewArchEnabled to false is not supported anymore since React Native 0.82. Please check your MainApplication.kt file, and remove the override for `isNewArchEnabled`.",
        )
      }
```

同样的 `error(...)` 在该文件出现**两次**（`:46`、`:77`），分别覆盖
`getReactPackageTurboModuleManagerDelegateBuilder()` 与 `getUIManagerProvider()`。

`isNewArchEnabled` 本身的默认值（`:94-95`）：

```kotlin
  protected open val isNewArchEnabled: Boolean
    get() = true
```

**即「返回 false 会直接崩溃」，无法降级到旧架构。**
全仓库 `isNewArchEnabled` 只有这 5 处引用（都在同一文件），说明开关已经收口。

### 1.2 但 iOS 仍保留该开关 —— 平台不对称

这一点必须精确表述，**不能写成「RN 已移除旧架构开关」**：

| 平台 | 现状 | 依据 |
| --- | --- | --- |
| **Android** | 开关保留但**返回 false 即抛异常** | `DefaultReactNativeHost.kt:46, 77` |
| **iOS** | 开关保留且**仍读环境变量**，仅打警告 | `scripts/react_native_pods.rb:92, 100, 537-552` |

`scripts/react_native_pods.rb:89-100`：

```ruby
def use_react_native! (
  path: "../node_modules/react-native",
  fabric_enabled: false,
  new_arch_enabled: NewArchitectureHelper.new_arch_enabled,
  ...
)
  error_if_try_to_use_jsc_from_core()
  warn_if_new_arch_disabled()
```

而 `NewArchitectureHelper.new_arch_enabled`（`scripts/cocoapods/new_architecture.rb:169-171`）：

```ruby
    def self.new_arch_enabled
        return true
    end
```

**硬编码 `return true`，入参被完全忽略。**
所以 iOS 侧「关掉新架构」实际不可行，只是从「静默忽略」变成了「打印警告」：

```ruby
def warn_if_new_arch_disabled
  if ENV["RCT_NEW_ARCH_ENABLED"] == "1" || ENV["RCT_NEW_ARCH_ENABLED"] == nil
    return
  end
  ...
  puts 'WARNING: Calling pod install with `RCT_NEW_ARCH_ENABLED=0'.yellow
  puts 'is not supported anymore since React Native 0.82.'.yellow
```

> **执行顺序核实**：`warn_if_new_arch_disabled()` 在 `:100` 调用，
> 而 `ENV["RCT_NEW_ARCH_ENABLED"] = "1"` 的无条件赋值在 `:144`。
> **警告在赋值之前，所以警告能正常打印** —— 这段代码是活的，不是死代码。

**结论**：新旧架构在两端都已不可关闭，但**表现形式不同**（Android 抛异常 / iOS 打警告）。

---

## 2. `DefaultReactHost` 是进程级单例

`defaults/DefaultReactHost.kt:35-36`：

```kotlin
public object DefaultReactHost {
  private var reactHost: ReactHost? = null
```

**Kotlin `object` 声明 = 单例**，且持有静态 `reactHost` 引用。

`getDefaultReactHost()` 开头（`:74-76`）：

```kotlin
    reactHost?.let {
      return it
    }
```

**第二次调用直接返回缓存**，忽略所有新参数（`jsMainModulePath`、`useDevSupport` 等）。

唯一的清理入口是 `invalidate()`（`:145-147`）：

```kotlin
  internal fun invalidate() {
    reactHost = null
  }
```

它只被 `DefaultReactNativeHost.clear()` 调用（`defaults/DefaultReactNativeHost.kt:81-84`）：

```kotlin
  override fun clear() {
    super.clear()
    DefaultReactHost.invalidate()
  }
```

### 2.1 共享范围

实测调用方（排除测试）：

| 调用方 | 位置 |
| --- | --- |
| `DefaultReactNativeHost.toReactHost()` | `defaults/DefaultReactNativeHost.kt:121` |
| `RNTesterApplication` | `packages/rn-tester/android/.../RNTesterApplication.kt:114` |

**同一进程内多个 Activity / 多次调用共享同一个 `ReactHost` 实例。**

这与 `ReactHost.kt:155-164` 的设计说明是一致的：

```
 * Applications where the ReactHost may be destroyed before the end of the process SHOULD call
 * invalidate() before releasing the reference to the ReactHost, to ensure resources are freed in
 * a timely manner.
 *
 * NOTE: This method is designed for complex integrations. Integrators MAY instead hold a
 * long-lived reference to a single ReactHost for the lifetime of the Application, without ever
 * calling invalidate(). This is explicitly allowed.
```

**「长期持有单例、终生不调 invalidate」是官方明确允许的用法。**

> **需要注意的资源语义**：`reactHost` 持有 `ReactHostImpl`，
> 后者持有 `Context`（`DefaultReactHost.kt:105` 传入的 `context`）。
> 如果传入的是 Activity Context 且长期不 `invalidate()`，**会泄漏 Activity**。
> 传入 `applicationContext` 则是安全的。

---

## 3. 启动链路

### 3.1 `start()` 是可选的

`ReactHost.kt:90-99`：

```kotlin
  /**
   * This function can be used to initialize the ReactInstance in a background thread before a
   * surface needs to be rendered. It is not necessary to call this function; startSurface() will
   * initialize the ReactInstance if it hasn't been preloaded.
   *
   * @return A Task that completes when the instance is initialized. The task will be faulted if any
   *   errors occur during initialization, and will be cancelled if ReactHost.destroy() is called
   *   before it completes.
   */
  public fun start(): TaskInterface<Void>
```

**提供预热能力**：`start()` 提前在后台线程初始化实例，让首帧更快。
不调用也能工作 —— `startSurface()` 会兜底初始化。

返回值是 `TaskInterface<Void>`，**失败会 faulted、`destroy()` 会 cancel**。

### 3.2 `destroy()` 的死锁警告

`ReactHost.kt:114-119`：

```
   * The destroy operation is asynchronous and the task returned by this method will complete when
   * React Native gets destroyed. Note that the destroy operation will execute in multiple threads,
   * in particular some of the sub-tasks will run in the UIThread. Calling
   * [TaskInterface.waitForCompletion] from the UIThread will lead into a deadlock. Use [destroy]
   * passing the onDestroyFinished callback to be notified when React Native gets destroyed.
```

**明确警告：在 UI 线程调用 `waitForCompletion()` 会死锁。**
替代方案是 `destroy(reason, ex, onDestroyFinished)`（`:148-152`），
回调**运行在后台线程**。

---

## 4. `ReactInstanceManager`：实际的创建执行者

`ReactInstanceManager.java` 有 1369 行，是 Android 侧最大的单文件。

### 4.1 独立的创建线程

`ReactInstanceManager.java:1140-1143`（线程创建，线程名见 `:1198`）：

```java
    mCreateReactContextThread =
        new Thread(
            null,
            () -> {
```

线程名为 `"create_react_context"`（`:1198`）。

线程体内的第一步是**等待销毁完成**（`:1145-1154`）：

```java
              synchronized (ReactInstanceManager.this.mHasStartedDestroyingLock) {
                while (ReactInstanceManager.this.mHasStartedDestroying) {
                  try {
                    ReactInstanceManager.this.mHasStartedDestroyingLock.wait();
                  } catch (InterruptedException e) {
                    // Interrupted while waiting for destruction to complete, just retry
                    continue;
                  }
                }
              }
```

**用 `while` + `wait()` 而非 `if`**，且 `InterruptedException` 时 `continue` 重试。
这是正确的 `wait()` 惯用法（防止虚假唤醒与中断吞掉信号）。

### 4.2 单槽位 pending 槽：并发 reload 会丢请求

`ReactInstanceManager.java:1112-1118`：

```java
    final ReactContextInitParams initParams =
        new ReactContextInitParams(jsExecutorFactory, jsBundleLoader);
    if (mCreateReactContextThread == null) {
      runCreateReactContextOnNewThread(initParams);
    } else {
      mPendingReactContextInitParams = initParams;
    }
```

**只有一个 `mPendingReactContextInitParams` 槽位**（`:145` 声明）。
若创建线程正忙，**后续所有请求互相覆盖，只有最后一个存活**。

消费点在 UI 线程（`:1176-1182`）：

```java
                    final Runnable maybeRecreateReactContextRunnable =
                        () -> {
                          if (mPendingReactContextInitParams != null) {
                            runCreateReactContextOnNewThread(mPendingReactContextInitParams);
                            mPendingReactContextInitParams = null;
                          }
                        };
```

**这是「最后一次 reload 生效」语义** —— 对 reload 场景合理（用户连点 Reload 只需最后意图），
但源码**没有任何注释说明这是有意设计**，容易被误读为竞态 bug。

`mPendingReactContextInitParams` 全部读写点仅 4 处（`:145, 1117, 1178, 1180`），
全部 `@ThreadConfined(UI)` —— 线程约束是明确的。

### 4.3 失败可重试

`:1166-1172`：

```java
              } catch (Exception e) {
                // Reset state and bail out. This lets us try again later.
                mHasStartedCreatingInitialContext = false;
                mCreateReactContextThread = null;
                mDevSupportManager.handleException(e);
                return;
              }
```

**失败时把 `mCreateReactContextThread` 置 null**，使下次请求能重新创建线程。
注释明说 "This lets us try again later"。

后续的 `setupReactContext` 失败（`:1187-1189`）**不做同样重置**，只上报 —— 状态不对称。

---

## 5. 现成的启动耗时埋点：`ReactMarker`

这是本模块对监控主题最大的价值。

`bridge/ReactMarkerConstants.kt:11-130` 定义了 **114 个枚举项**，
其中 **13 个带 `hasMatchingNameMarker = true`**（`:12` 的构造参数）。

`ReactMarker.kt:159-174` 说明了「配对」语义：

```kotlin
  private fun notifyNativeMarker(name: ReactMarkerConstants, time: Long?) {
    if (!name.hasMatchingNameMarker) {
      return
    }

    val now = time ?: SystemClock.uptimeMillis()

    if (ReactNativeJniCommonSoLoader.initialized) {
      // First send the current marker
      nativeLogMarker(name.name, now)

      // Then send all cached native ReactMarkers
      while (true) {
        val record = nativeReactMarkerQueue.poll() ?: break
        nativeLogMarker(record.markerName, record.markerTime)
      }
    }
```

### 5.1 三条分发路径

`ReactMarker.kt:148-155`：

```kotlin
  public fun logMarker(name: ReactMarkerConstants, tag: String?, instanceKey: Int, time: Long?) {
    logFabricMarker(name, tag, instanceKey)
    for (listener in listeners) {
      listener.logMarker(name, tag, instanceKey)
    }

    notifyNativeMarker(name, time)
  }
```

| 路径 | 条件 | 用途 |
| --- | --- | --- |
| `logFabricMarker` | 全部 | Fabric 渲染埋点 |
| `listeners` 回调 | 全部 | **App 可注册监听**（Java 层） |
| `notifyNativeMarker` | **仅 `hasMatchingNameMarker=true`** | 跨 JNI 传给 C++ |

**`hasMatchingNameMarker` 的语义是「这个点有配对的 END 点」**，
只有这类点才值得跨语言传递（因为要算耗时）。

### 5.2 13 个带 `true` 标记的埋点

| 标记 | 枚举项 | 配对情况 |
| --- | --- | --- |
| `true` | `APP_STARTUP_START` / `APP_STARTUP_END` | 完整配对 |
| `true` | `INIT_REACT_RUNTIME_START` / `INIT_REACT_RUNTIME_END` | 完整配对 |
| `true` | `RUN_JS_BUNDLE_START` / `RUN_JS_BUNDLE_END` | 完整配对 |
| `true` | `NATIVE_MODULE_SETUP_START` / `NATIVE_MODULE_SETUP_END` | 完整配对 |
| `true` | `loadApplicationScript_startStringConvert` / `_endStringConvert` | 完整配对（命名非 START/END） |
| **仅 `_END`** | `CREATE_REACT_CONTEXT_END` | ⚠ **START 未标记**，实际不成对 |
| `true` | `REGISTER_JS_SEGMENT_START` / `REGISTER_JS_SEGMENT_STOP` | 完整配对（`_STOP` 非 `_END`） |

**两处命名/标记不一致，都是「不能按后缀自动配对」的直接证据：**

| 反例 | 实际情况 | 后果 |
| --- | --- | --- |
| `CREATE_REACT_CONTEXT_START` **无** `(true)`，只有 `_END` 有（`:16-17`） | 只有 END 会被传给 C++，**START 不会** | 按「有 END 就算配对」解析会得到不完整的时间段 |
| `REGISTER_JS_SEGMENT_START` 配的是 `_STOP` 而非 `_END` | 完整配对，但命名不统一 | 按 `_START`/`_END` 后缀配对会漏 |

> **这直接说明 `hasMatchingNameMarker` 不是「这个点有配对 END」那么简单** ——
> `CREATE_REACT_CONTEXT` 的标记缺失看起来是遗漏（否则 START/END 只有一个跨界），
> 而 `REGISTER_JS_SEGMENT` 的 `_STOP` 更像是历史命名遗留。
> **做启动耗时统计时，这 13 个点不能当作 6.5 对自动使用，必须逐个确认。**

其余 101 个枚举项**没有** `true` 标记，因此**不会传给 C++**，
但**仍会走 `listeners` 路径**（`:150-152`）—— App 侧仍可监听。

### 5.3 SO 未加载时的缓存队列

`ReactMarker.kt:166-174` 显示：`ReactNativeJniCommonSoLoader.initialized` 为 false 时
**先入队，SO 加载后再回放**。这保证启动早期的埋点不丢失。

**注意**：`nativeReactMarkerQueue` 是无界队列（`poll()` 到空为止），
启动早期的 marker 若 SO 迟迟不加载会持续堆积。

### 5.4 对 05 文档启动专题的意义

[05 文档](./05-监控检测原理与流程.md) 指出 RN 没有开箱的启动耗时采集。
**但 `ReactMarker` 就是现成的数据源** —— 只需实现 `MarkerListener` 并注册
（`packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarker.kt:35-41, 185-187`）：

```kotlin
  public fun interface MarkerListener {
    public fun logMarker(name: ReactMarkerConstants, tag: String?, instanceKey: Int)
  }

  @JvmStatic
  public fun addListener(listener: MarkerListener) {
    if (!listeners.contains(listener)) {
      listeners.add(listener)
    }
  }
```

`addListener` 有去重（`:38`），但**回调侧没有任何过滤** —— 114 个枚举项全部会送到 listener。
App 需自行按 `hasMatchingNameMarker` 或所需常量名筛选，否则会收到大量无用事件。

`APP_STARTUP_START → APP_STARTUP_END` 就是端到端启动耗时。

**这不是「不存在」，而是「存在但需要主动接入」** —— 属于 05 文档「扩展点」而非「缺口」，
但容易被误判为缺口。相关埋点在 `ReactInstanceManager.java:1130`、
`ReactInstance.java`（`ReactMarker.INIT_REACT_RUNTIME_STOP` / `APP_STARTUP_STOP`）。

---

## 6. 内存压力路由：到 C++ 为止，不进 JS

`MemoryPressureRouter.kt:17-22`：

```kotlin
public class MemoryPressureRouter(context: Context) : ComponentCallbacks2 {
  private val listeners = CopyOnWriteArrayList<MemoryPressureListener>()

  init {
    context.applicationContext.registerComponentCallbacks(this)
  }
```

实现 `ComponentCallbacks2`，在 `init` 块里**自动注册**到 application context。

`onTrimMemory`（`:40-42`）只做一件事：

```kotlin
  public override fun onTrimMemory(level: Int) {
    dispatchMemoryPressure(level)
  }
```

`onLowMemory`（`:50`）已被弃用且是空实现：

```kotlin
  public override fun onLowMemory(): Unit = Unit
```

### 6.1 完整路由链路

`dispatchMemoryPressure`（`:52-56`）遍历 listener →
`ReactHostImpl.kt:560-568`：

```kotlin
  private fun createMemoryPressureListener(reactInstance: ReactInstance): MemoryPressureListener {
    val weakReactInstance = WeakReference(reactInstance)
    return MemoryPressureListener { level: Int ->
      bgExecutor.execute {
        val strongReactInstance = weakReactInstance.get()
        strongReactInstance?.handleMemoryPressure(level)
      }
    }
  }
```

→ JNI：`ReactAndroid/src/main/jni/react/runtime/jni/JReactInstance.cpp:203-204`：

```cpp
void JReactInstance::handleMemoryPressureJs(jint level) {
  instance_->handleMemoryPressureJs(level);
```

→ C++ `ReactInstance::handleMemoryPressureJs`（见 [11 文档](./11-运行时与错误桥.md) 的 `ReactInstance`）。

**四个设计要点：**

| 要点 | 说明 |
| --- | --- |
| **不派发 JS 事件** | 与 `memoryWarning`（iOS 独有，见 05 文档）形成平台不对称 |
| 弱引用 + 后台线程 | 避免持有已销毁实例；`strongReactInstance?.` 判空 |
| `CopyOnWriteArrayList` | 读多写少场景免锁 |
| 无节流 | 每次 `onTrimMemory` 都转发，无合并 |

**这修正了 05 文档的一处措辞**：Android **有**内存压力回调（只是不进 JS），
真正缺的是 JS 可见性。

---

## 7. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| E7-1 | `DefaultReactHost` 是单例且缓存参数，第二次调用忽略所有新参数 | `defaults/DefaultReactHost.kt:35-36, 74-76` | 换 `jsMainModulePath` / `useDevSupport` 无效，且静默 |
| E7-2 | 单例持有传入的 `Context` 且不自动 `invalidate()` | 同上 `:105-111` | 传 Activity Context 且长期持有会泄漏 Activity |
| E7-3 | `mPendingReactContextInitParams` 是单槽位，并发 reload 静默丢请求 | `ReactInstanceManager.java:1112-1118` | 中间请求丢失；无注释说明是有意设计，易被误判为竞态 |
| E7-4 | `createReactContext` 失败会重置状态可重试，`setupReactContext` 失败不会 | 同上 `:1166-1172` vs `:1187-1189` | 状态处理不对称，后续重试行为不可预测 |
| E7-5 | 旧架构开关的平台处理不一致（Android 抛异常 / iOS 仅警告） | `DefaultReactNativeHost.kt:46` vs `scripts/react_native_pods.rb:537-552` | 跨平台文档与排查口径需分别对待 |
| E7-6 | `REGISTER_JS_SEGMENT_START` 配对的是 `_STOP` 而非 `_END` | `bridge/ReactMarkerConstants.kt:95-96` | 按 `_START`/`_END` 后缀自动配对会漏 |
| E7-7 | `nativeReactMarkerQueue` 无界，SO 未加载时持续堆积 | `bridge/ReactMarker.kt:171-174` | SO 加载失败/延迟时内存增长 |
| E7-8 | `MemoryPressureRouter` 转发内存压力但不派发 JS 事件 | `MemoryPressureRouter.kt:40-42` | JS 侧完全不可见；与 iOS 的 `memoryWarning` 不对称 |
| E7-9 | `onLowMemory` 弃用后为空实现，旧系统无回调 | 同上 `:50` | API level 过低时内存压力完全无感知 |
| E7-10 | `MarkerListener` 回调无过滤，114 个枚举项全部下发 | `bridge/ReactMarker.kt:150-152, 185-187` | App 侧必须自行筛选，否则回调被高频无用事件淹没 |

---

## 8. 与其他文档的衔接

- C++ 侧 `ReactInstance` 与 `RN$*` 全局 → [11 文档](./11-运行时与错误桥.md)
- JS 侧装配顺序（bundle 求值后才 ready）→ [13 文档](./13-JS启动装配.md)
- 启动耗时监控主题与扩展点 → [05 文档](./05-监控检测原理与流程.md)
- Android 崩溃上报链路（`DevSupportManagerBase`）→ [04 文档](./04-崩溃日志捕获收集处理上传.md)
- Fabric 组件在 Android 的落地 → 批次 4b/4c
- JNI 胶水层细节 → 批次 4d

---

## 9. 验证方式

```bash
node docs/arch/audit/audit-citations.mjs    # 引用可达性
node docs/arch/audit/verify-quotes.mjs      # 代码块语义
node docs/arch/audit/verify-claims.mjs      # 核心事实断言
```
