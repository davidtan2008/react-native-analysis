---
id: 42
title: "Android 侧的两条内存压力路径与 View 回收池：无上限栈与 18 字段重置的正面样本"
topic: DG.mem
symptoms: [mempressure, oom, memleak]
platforms: [android]
architecture: [cross]
layer: T1
symbols: ["onTrimMemory", "ViewPool", "ReactNativeApplicationEntryPoint"]
sourceRoot: react-native
claims: [GG-1, GG-2, GG-3, GG-4, GG-5, GG-6, GG-7, GG-8, GG-9]
---
# 42 · Android 侧的两条内存压力路径与 View 回收池：无上限栈与 18 字段重置的正面样本

> **模块**：C2 ·
> `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/MemoryPressureRouter.kt`
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/MemoryPressureListener.kt`
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactInstance.kt`
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactHostImpl.kt`
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagerRegistry.kt`
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java`
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/fabric/FabricUIManager.java`
> + 6 个 opt-in 回收池的 ViewManager 与 6 个 `recycleView()` 实现
> + `packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp:652-720`
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · Android 侧
> **前置**：[05 文档](./05-监控检测原理与流程.md) 记录内存警告的六个 iOS 观察者与
> `handleMemoryPressureJs` 的分级；[31 文档](./31-Fabric组件层View与回收池.md) 记录 iOS 侧
> `RCTComponentViewRegistryRecyclePoolMaxSize = 1024` 与内存警告整池清空；
> [35 文档](./35-Fabric组件层Image竞态防护.md) 记录 `DebuggingOverlay` 高亮数组不重置的缺陷；
> [40 文档](./40-Android打点体系ReactMarker.md) 记录 Android 侧 114 个 marker 的实测使用率。
>
> 本文给出 **Android 侧两条独立的内存压力路径**（JS 侧 / 视图侧），
> 记录 **回收池「无 size 上限」这一与 iOS 的关键差异**，
> 并给出 **`recycleView()` 重置契约的三档实测分布**——
> 其中 `ReactViewGroup` 的 18 字段集中重置是全仓库最好的回收契约实现。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `uimanager/ViewManager.java` | ~490 | **回收池实现（栈式，无上限）** |
| `uimanager/ViewManagerRegistry.kt` | ~180 | **视图侧 `ComponentCallbacks2`** |
| `runtime/ReactHostImpl.kt` | 1673 | JS 侧监听器注册（`:560-569`、`:1051`） |
| `runtime/ReactInstance.kt` | 633 | **JNI 薄壳 + NPE 兜底**（`:461-476`） |
| `MemoryPressureRouter.kt` | ~55 | 路由器（`ComponentCallbacks2` → 多监听者） |
| `bridge/MemoryPressureListener.kt` | 14 | `fun interface` |
| `fabric/FabricUIManager.java` | — | 路径 B 的注册点（`:261`） |
| `ReactCommon/.../ReactInstance.cpp` | — | **真正的分级逻辑**（`:652-720`） |
| `views/view/ReactViewGroup.kt` | — | **`recycleView()` 的最佳实现（18 字段）** |

---

## 2. 两条独立的内存压力路径

### 2.1 总览

```
Android 系统 onTrimMemory(level)
  │
  ├─ 路径 A：JS 堆
  │    MemoryPressureRouter.onTrimMemory(level)              [MemoryPressureRouter.kt:40]
  │      → 每个 MemoryPressureListener                      [dispatchMemoryPressure]
  │        → ReactHostImpl 创建的 listener                  [ReactHostImpl.kt:560-569]
  │          → WeakReference.get() → ReactInstance.handleMemoryPressure(level)
  │            → handleMemoryPressureJs(level)  ← external (JNI)
  │              → C++ ReactInstance::handleMemoryPressureJs(int)  [ReactInstance.cpp:652]
  │                → 分级：4 档严重 → collectGarbage；3 档非严重 → 忽略
  │
  └─ 路径 B：原生 View
       ViewManagerRegistry.onTrimMemory(level)               [ViewManagerRegistry.kt:139]
         → synchronized 快照 viewManagers 列表
         → 每个 viewManager.trimMemory()                     [ViewManager.java:474]
           → mRecyclableViews = new HashMap<>()   ← 整池丢弃
```

**两条路径完全独立、互不知晓**：

| | 路径 A（JS 堆） | 路径 B（原生 View） |
| --- | --- | --- |
| 入口 | `MemoryPressureRouter` | `ViewManagerRegistry`（**自身即 `ComponentCallbacks2`**） |
| 分级 | ✅ 有（4 档严重 / 3 档忽略） | ❌ **无分级，任意 level 都整池清空** |
| 动作 | `runtime.instrumentation().collectGarbage(levelName)` | `mRecyclableViews = new HashMap<>()` |
| 作用对象 | Hermes/JSC 堆 | 每个 ViewManager 的回收栈 |
| 执行线程 | 后台线程（`bgExecutor`） | 主线程（`UiThreadUtil.runOnUiThread`） |
| legacy 架构下是否存在 | ✅ 存在 | ❌ **不存在**（见 §2.2） |

### 2.2 路径 B 只在 Fabric 下存在

`fabric/FabricUIManager.java:260-261`：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/fabric/FabricUIManager.java:260-261
    mViewManagerRegistry = viewManagerRegistry;
    mReactApplicationContext.registerComponentCallbacks(viewManagerRegistry);
```

`:485` 有对应的 `unregisterComponentCallbacks(mViewManagerRegistry)`。

`uimanager/ViewManagerRegistry.kt:18`：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagerRegistry.kt:18
public class ViewManagerRegistry : ComponentCallbacks2 {
```

| 观察 | 说明 |
| --- | --- |
| 注册点 | `FabricUIManager` 构造函数（`:261`） |
| 注销点 | 同类（`:485`） |
| **是否只 Fabric** | ✅ 是 |

> **推论：legacy（Paper）架构下路径 B 不存在。**
> 但 `ViewManager` 的回收池是两种架构共用的基础设施（`ViewManager.java` 不区分架构）
> —— **即：legacy 模式下有回收池但没有内存警告清空。**
>
> **这与 37 文档记录的 iOS 侧 legacy 布局层退役是同一趋势的两面**：
> iOS 是「接口保留但实现退役」，Android 是「功能保留但触发条件随架构收窄」。

### 2.3 `ViewManagerRegistry.onTrimMemory` 的三级防御

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagerRegistry.kt:139-153
  public override fun onTrimMemory(level: Int) {
    val viewManagers: List<ViewManager<*, *>> =
        synchronized(this) { ArrayList(viewManagersMap.values) }

    val runnable = {
      for (viewManager in viewManagers) {
        viewManager.trimMemory()
      }
    }

    if (UiThreadUtil.isOnUiThread()) {
      runnable()
    } else {
      UiThreadUtil.runOnUiThread(runnable)
    }
```

**三个正确性处理**：

| 处理 | 理由 |
| --- | --- |
| `synchronized(this) { ArrayList(...) }` | **先复制快照再遍历** —— 避免 `ConcurrentModificationException` |
| 快照在闭包外捕获 | 遍历期间注册表变化不影响本次遍历 |
| `isOnUiThread()` 分支 | 避免不必要的线程切换（`runOnUiThread` 内部会判重） |

**但 `level` 参数被完全忽略** —— 连 `TRIM_MEMORY_UI_HIDDEN = 20`
（界面隐藏，**非内存压力**）都会清空所有回收池。

> **对照 iOS**：31 文档 §2.3 记录 iOS 的 `RCTComponentViewRegistry`
> 在 `UIApplicationDidReceiveMemoryWarningNotification` 时整池清空；
> **iOS 侧同样不分级**（该通知本身不带等级）。
>
> **结论：两端一致 —— 视图侧不分级，任意内存提示都清池。**
> 这是**保守但正确**的取舍：误清池只损失性能，不损失正确性。

### 2.4 路径 A 的 JNI 薄壳与必需的 NPE 兜底

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactInstance.kt:461-476
  private external fun handleMemoryPressureJs(pressureLevel: Int)

  @ThreadConfined(ThreadConfined.UI) external fun unregisterFromInspector()

  fun handleMemoryPressure(level: Int) {
    try {
      handleMemoryPressureJs(level)
    } catch (e: NullPointerException) {
      ReactSoftExceptionLogger.logSoftException(
          TAG,
          ReactNoCrashSoftException(
              "Native method handleMemoryPressureJs is called earlier than librninstance.so got ready.",
          ),
      )
    }
  }
```

**`handleMemoryPressureJs` 是 `external fun`** —— 05 文档记录的
`ReactInstance.cpp:652-720` 分级逻辑仍在，但 **Kotlin 侧已退化为 JNI 薄壳**。

**NPE 兜底的文案点明了真实场景**：

> Native method handleMemoryPressureJs is called earlier than librninstance.so got ready.

**为什么这个兜底是必需的**：

| 步骤 | 事实 |
| --- | --- |
| ① `MemoryPressureRouter` 在 `init` 块里 `registerComponentCallbacks`（`:19-21`） | **构造即注册，早于 SO 加载** |
| ② 系统的第一次 `onTrimMemory` 可能在 SO 就绪前到达 | — |
| ③ JNI 方法未初始化 → `NullPointerException` | — |

**即这不是防御性冗余，是必需的时序兜底。**

**兜底动作是「记软异常」而非崩溃** —— 与 41 文档 §5 的
`ReactNoCrashSoftException` 模式一致。

### 2.5 弱引用 + 后台线程

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactHostImpl.kt:560-569
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

| 处理 | 说明 |
| --- | --- |
| `WeakReference` | 不阻止 `ReactInstance` 被 GC |
| **`bgExecutor.execute`** | 切到后台线程 —— C++ 侧要 `scheduleWork` 到 JS 线程 |
| `?.` 安全调用 | 实例已回收则静默跳过 |

> **与 38 文档 §2.4（`RCTEventEmitter` 的 `callableJSModules` 弱引用）同型** ——
> 弱引用 → 一次性强引用 → 判空 → 静默返回。

### 2.6 `MemoryPressureRouter` 与 40 文档 `ReactMarker` 的同型

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/MemoryPressureRouter.kt:11-38
  private val listeners = CopyOnWriteArrayList<MemoryPressureListener>()

  init {
    context.applicationContext.registerComponentCallbacks(this)
  }

  public fun destroy(context: Context) {
    context.applicationContext.unregisterComponentCallbacks(this)
  }

  /** Add a listener to be notified of memory pressure events. */
  public fun addMemoryPressureListener(listener: MemoryPressureListener) {
    if (!listeners.contains(listener)) {
      listeners.add(listener)
    }
  }

  /** Remove a listener previously added with [addMemoryPressureListener]. */
  public fun removeMemoryPressureListener(listener: MemoryPressureListener) {
    listeners.remove(listener)
  }
```

**与 40 文档 §3.1 的 `ReactMarker` 完全同型**：
`CopyOnWriteArrayList` + `add` 去重 + `remove` 不去重。

**`ReactMarker` 侧给了容器选择的理由**：

> Use a list instead of a set here because we expect the number of listeners to be very small, and we want listeners to be called in a deterministic order.

**两处的代码与措辞一致** —— 说明这是**团队约定**而非偶然。

**`destroy(context)` 的参数是多余的**：`init` 里注册用的是
`context.applicationContext`，`destroy` 也用 `context.applicationContext`，
**传入的 `context` 参数只用于取 `applicationContext`，可以省掉**。

### 2.7 两个 `ComponentCallbacks2` 对 `onLowMemory` 的处置不同

`ViewManagerRegistry.kt:160-161`：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagerRegistry.kt:160-161
  @Deprecated("Overrides deprecated ComponentCallbacks2.onLowMemory()")
  public override fun onLowMemory(): Unit = onTrimMemory(ComponentCallbacks2.TRIM_MEMORY_BACKGROUND)
```

`MemoryPressureRouter.kt`：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/MemoryPressureRouter.kt:44-48
  @Deprecated(
      "onLowMemory is deprecated, use onTrimMemory instead.",
      ReplaceWith("onTrimMemory(level)"),
  )
  public override fun onLowMemory(): Unit = Unit
```

| 类 | `onLowMemory()` | 后果 |
| --- | --- | --- |
| `ViewManagerRegistry` | **转发到 `onTrimMemory(40)`** | **会清空回收池** |
| `MemoryPressureRouter` | **空实现** | 不分发 |

> **这是一个真实的行为差异，两边都有 `@Deprecated` 但都没解释「为什么不同」。**
>
> 推断：`ViewManagerRegistry` 早于 `ComponentCallbacks2.onTrimMemory` 存在，
> 转发是向后兼容；`MemoryPressureRouter` 是新代码，只面向 `onTrimMemory`。
>
> **后果**：`onLowMemory()` 触发时 **JS 侧收不到通知、视图侧会清池** ——
> 两条路径的响应不对等。

---

## 3. C++ 侧的分级逻辑

### 3.1 函数内的局部 enum

```cpp
// packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp:652-663
void ReactInstance::handleMemoryPressureJs(int pressureLevel) {
  // The level is an enum value passed by the Android OS to an onTrimMemory
  // event callback. Defined in ComponentCallbacks2.
  enum AndroidMemoryPressure {
    TRIM_MEMORY_BACKGROUND = 40,
    TRIM_MEMORY_COMPLETE = 80,
    TRIM_MEMORY_MODERATE = 60,
    TRIM_MEMORY_RUNNING_CRITICAL = 15,
    TRIM_MEMORY_RUNNING_LOW = 10,
    TRIM_MEMORY_RUNNING_MODERATE = 5,
    TRIM_MEMORY_UI_HIDDEN = 20,
  };
```

**7 个等级，定义在函数内的局部 enum**（不复用 Java 侧常量，
因为 C++ 不依赖 `android.content.ComponentCallbacks2`）。

### 3.2 两个 switch：先查名，再分级

`:664-690` 的第一个 switch 只为得到 `levelName`；
`:692-719` 的第二个 switch 做实际决策：

```cpp
// packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp:692-719
  switch (pressureLevel) {
    case TRIM_MEMORY_RUNNING_LOW:
    case TRIM_MEMORY_RUNNING_MODERATE:
    case TRIM_MEMORY_UI_HIDDEN:
      // For non-severe memory trims, do nothing.
      LOG(INFO) << "Memory warning (pressure level: " << levelName
                << ") received by JS VM, ignoring because it's non-severe";
      break;
    case TRIM_MEMORY_BACKGROUND:
    case TRIM_MEMORY_COMPLETE:
    case TRIM_MEMORY_MODERATE:
    case TRIM_MEMORY_RUNNING_CRITICAL:
      // For now, pressureLevel is unused by collectGarbage.
      // This may change in the future if the JS GC has different styles of
      // collections.
      LOG(INFO) << "Memory warning (pressure level: " << levelName
                << ") received by JS VM, running a GC";
      runtimeScheduler_->scheduleWork([=](jsi::Runtime& runtime) {
        TraceSection s("ReactInstance::handleMemoryPressure");
        runtime.instrumentation().collectGarbage(levelName);
      });
      break;
    default:
      // Use the raw number instead of the name here since the name is
      // meaningless.
      LOG(WARNING) << "Memory warning (pressure level: " << pressureLevel
                   << ") received by JS VM, unrecognized pressure level";
      break;
  }
```

| 档 | 等级值 | 动作 |
| --- | --- | --- |
| **忽略** | `RUNNING_LOW(10)`、`RUNNING_MODERATE(5)`、`UI_HIDDEN(20)` | 只 `LOG(INFO)` |
| **GC** | `BACKGROUND(40)`、`COMPLETE(80)`、`MODERATE(60)`、`RUNNING_CRITICAL(15)` | `collectGarbage(levelName)` |
| **未知** | 其他 | `LOG(WARNING)` + **原始数字** |

### 3.3 三条注释的信息量都属第一档

| 注释 | 信息 |
| --- | --- |
| `For non-severe memory trims, do nothing.` | 为什么忽略 |
| `For now, pressureLevel is unused by collectGarbage. This may change in the future if the JS GC has different styles of collections.` | **承认 `levelName` 传了但没用**，并说明将来的可能 |
| `Use the raw number instead of the name here since the name is meaningless.` | **为什么 default 分支打数字而非名字** |

**第三条尤其好** —— 它解释了「看起来不一致的日志格式」的原因，
属 [36 文档 §5.1](./36-legacy-View层ComponentData与hitTest.md) 的第一档。

### 3.4 `levelName` 已接线但下游未消费

```cpp
runtime.instrumentation().collectGarbage(levelName);
```

**第一个 switch 的全部工作就是为这个参数算出一个可读字符串。**

**注释明说「当前未使用」** —— 这是**为将来准备的接口**。

> **与 40 文档 §2 的 38 个零引用 marker 的关键区别**：
>
> | | 40 文档的零引用 marker | 本文的 `levelName` |
> | --- | --- | --- |
> | 是否接线 | ❌ 完全没接 | ✅ **已传进 `collectGarbage`** |
> | 下游是否消费 | — | ❌ 当前不消费 |
> | 发现难度 | 中（grep 可查） | **高（要读三层才能发现）** |
>
> **「接了线但没人用」比「没接线」更难发现** ——
> 因为 grep 得到的结果是「有引用」，看起来一切正常。

### 3.5 GC 排在 JS 线程队列后面

**GC 被 `runtimeScheduler_->scheduleWork` 调度**，且带 `TraceSection`。

> **若 JS 线程被长任务阻塞（如死循环的 JS 代码），
> 内存警告触发的 GC 也永远不会执行。**
>
> **这是「JS 侧 OOM 无法自救」的机制性原因**：
> 系统已在杀进程，而唯一能缓解的手段排在被阻塞的队列后面。
>
> **路径 B 同样如此**（`UiThreadUtil.runOnUiThread` 也要排队）——
> **两条路径都不能在 JS 死循环时执行。**

---

## 4. View 回收池：无上限栈

### 4.1 容器：`Map<surfaceId, Stack<T>>`

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java:50-56
  /**
   * For View recycling: we store a Stack of unused, dead Views. This is null by default, and when
   * null signals that View Recycling is disabled. `enableViewRecycling` must be explicitly called
   * in a concrete constructor to enable View Recycling per ViewManager.
   */
  @Nullable private Map<Integer, Stack<T>> mRecyclableViews = null;
```

**三层设计**：

| 设计 | 说明 |
| --- | --- |
| `null` 表示关闭 | 用哨兵值表达「禁用」 |
| 按 `surfaceId` 分桶 | **每个 Surface 一个独立栈** |
| 需显式 opt-in | `setupViewRecycling()` 必须在具体 ViewManager 构造函数里调 |

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java:65-71
  /** Call in constructor of concrete ViewManager class to enable. */
  protected void setupViewRecycling() {
    if (ReactNativeFeatureFlags.enableViewRecycling()) {
      mRecyclableViews = new HashMap<>();
    }
  }
```

**双重门控**：必须调 `setupViewRecycling()` **且** Feature Flag 为真。

### 4.2 【核心差异】没有 size 上限

`:264-272` 的入池路径：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java:264-273
    // View recycling
    ThemedReactContext themedReactContext = (ThemedReactContext) viewContext;
    int surfaceId = themedReactContext.getSurfaceId();
    @Nullable Stack<T> recyclableViews = getRecyclableViewStack(surfaceId, false);
    if (recyclableViews != null) {
      T recyclableView = prepareToRecycleView(themedReactContext, view);
      if (recyclableView != null) {
        recyclableViews.push(recyclableView);
      }
    }
```

**`push` 之前没有任何 size 检查**（实测：`push` 仅 1 处、`.pop()` 仅 1 处、
无 `MAX`/`maxSize`/`.size()` 比较）。

`:211-213` 的出池路径同样简单：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java:211-213
    if (recyclableViews != null && !recyclableViews.empty()) {
      T recyclableView = recyclableViews.pop();
```

### 4.3 与 iOS 的对照

| | iOS `RCTComponentViewRegistry`（31 文档 §2） | Android `ViewManager`（本文） |
| --- | --- | --- |
| 容器 | `unordered_map<ComponentHandle, vector<...>>` | `Map<Integer, Stack<T>>` |
| **size 上限** | ✅ **`RCTComponentViewRegistryRecyclePoolMaxSize = 1024`** | ❌ **无** |
| 超限行为 | `[view invalidate]`（真销毁） | — |
| 内存警告清空 | ✅ `_recyclePool.clear()` | ✅ `mRecyclableViews = new HashMap<>()` |
| 分桶键 | `ComponentHandle`（**组件类型**） | `surfaceId`（**Surface**） |
| 回收重置 | `prepareForRecycle`（协议方法） | `prepareToRecycleView`（abstract） |

> **两端在内存上界上的关键差异**：
>
> | | iOS | Android |
> | --- | --- | --- |
> | 常驻上界 | `1024 × 组件类型数` | **`Stack.size()` 无界** |
> | 何时收缩 | 超过 1024 时逐出 | **只在内存警告时** |
> | 上界由什么决定 | **代码常数 × 类型数** | **运行时卸载/复用比** |
>
> **Android 的上界由「Surface 生命周期内的最大同时卸载数」决定**，而非固定常数。
>
> **实际风险评估**：栈里的 View **已从视图树移除**，
> 每个几百字节到几 KB（`TextView` 更重）。
> 一个极端场景（一次卸载 10000 个 TextView）会占用数十 MB 且**不会自动收缩**。
> **但这需要恰好在内存压力到来之前卸载过大量视图** ——
> 内存警告一到就全清了。
>
> **归类：设计上界不精确，实际风险依赖时序。**
> 与 31 文档 V-4 同类但方向相反 ——
> **iOS 有上界但不精确，Android 连上界都没有。**

### 4.4 出池时的父视图清理

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java:215-220
      // When view recycling isn't enabled for all components, a recyclable view could still be
      // attached to a non-recyclable view. This guarantees that recycled view have been removed
      // from their parent.
      if (ReactNativeFeatureFlags.enableViewRecycling() && recyclableView.getParent() != null) {
        ((ViewGroup) recyclableView.getParent()).removeView(recyclableView);
      }
```

**注释说明了必要性**：当**部分组件**启用回收而另一部分没启用时，
回收栈里的 View 可能仍挂在某个**不可回收**的父视图上。

**双重 Flag 检查不是冗余** —— `setupViewRecycling` 内也检查一次。
**它防御的是「Flag 在 ViewManager 构造后被改」**
（Feature Flag 运行期可改）。**这是正确的。**

### 4.5 内存警告清空：注释质量极高

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java:473-480
  /** With even slight memory pressure, we immediately evict all recyclable Views. */
  /* package */ void trimMemory() {
    // Wipe out all existing recyclable Views, but do not disable View Recycling entirely.
    // We only take any action if View Recycling is already enabled.
    if (mRecyclableViews != null) {
      mRecyclableViews = new HashMap<>();
    }
  }
```

**三句话交代三件事**：

| 注释 | 信息 |
| --- | --- |
| `With even slight memory pressure, we immediately evict all recyclable Views.` | **明确「轻微压力也立刻清」** —— 解释了 §2.3 里为什么忽略 `level` |
| `but do not disable View Recycling entirely.` | **只清空不禁用** —— Feature Flag 不变 |
| `We only take any action if View Recycling is already enabled.` | **未启用的 ViewManager 不动** |

**第一句同时解释了 `ViewManagerRegistry.onTrimMemory` 忽略 `level` 的原因** ——
两处的注释是配套的（一个说「轻微也清」，一个说「所以不分级」）。

**`new HashMap<>()` 而非 `.clear()`** —— 换新对象让所有旧引用失效。
语义与 iOS 的 `_recyclePool.clear()` 相同、手段不同。

`:466-470` 还有一个按 surface 的移除（Surface 停止时清掉自己那个桶）。

### 4.6 `trimMemory()` 零覆写

**全仓库只有 `ViewManager.java` 自身的定义，无任何覆写。**

> **即「哪些组件在内存压力下释放了什么」是固定的**：
> 全部 opt-in 的 ViewManager 清空自己的回收栈，**没有额外行为**。

---

## 5. 【核心发现】`recycleView()` 重置契约的三档实测

### 5.1 opt-in 名单：只有 6 个 ViewManager

```
$ grep -rn "setupViewRecycling()" packages/react-native --include="*.java" --include="*.kt" | grep -v "uimanager/ViewManager.java"
views/scroll/ReactNestedScrollViewManager.kt:70
views/scroll/ReactScrollViewManager.kt:62
views/scroll/ReactHorizontalScrollViewManager.kt:61
views/view/ReactViewManager.kt:72
views/text/ReactTextViewManager.kt:64
views/text/PreparedLayoutTextViewManager.kt:50
```

| # | ViewManager | 组件 |
| --- | --- | --- |
| 1 | `ReactScrollViewManager` | 垂直 ScrollView |
| 2 | `ReactHorizontalScrollViewManager` | 水平 ScrollView |
| 3 | `ReactNestedScrollViewManager` | 嵌套滚动 ScrollView |
| 4 | `ReactViewManager` | `View` |
| 5 | `ReactTextViewManager` | `Text` |
| 6 | `PreparedLayoutTextViewManager` | 预布局 Text |

**没有 `Image`、`TextInput`、`Switch`** —— 这些组件的 View 创建成本高，
或含不可复用状态（`EditText` 的 `TextWatcher`、Bitmap 等）。

### 5.2 `ReactViewManager` 在回收前禁用裁剪

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/view/ReactViewManager.kt:76-88
  override fun prepareToRecycleView(
      reactContext: ThemedReactContext,
      view: ReactViewGroup,
  ): ReactViewGroup? {
    // We don't want to run the view clipping when the view is being prepared for recycling to avoid
    // have size changes iterate over child view that should be removed anyway
    view.removeClippedSubviews = false

    // BaseViewManager
    val preparedView = super.prepareToRecycleView(reactContext, view)
    preparedView?.recycleView()
    return preparedView
```

**它把 `removeClippedSubviews` 设为 `false`** —— 注释给了理由：

> We don't want to run the view clipping when the view is being prepared for recycling to avoid have size changes iterate over child view that should be removed anyway

**即：回收期间禁用裁剪，避免「尺寸变化 → 遍历即将被移除的子视图」。**

**注释只说了「为什么设为 false」，没说「谁负责设回 true」。**

### 5.3 答案：`ReactViewGroup.recycleView()` 确实重置了

**我最初的判断（「6 个 `prepareToRecycleView` 都漏了重置」）是错的。**
核实后发现 `ReactViewGroup` 有一个**专门为回收设计的集中重置方法**：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/view/ReactViewGroup.kt:178-205
  /**
   * Set all default values here as opposed to in the constructor or field defaults. It is important
   * that these properties are set during the constructor, but also on-demand whenever an existing
   * ReactViewGroup is recycled.
   */
  private fun initView() {
    clipChildren = false

    _removeClippedSubviews = false
    inSubviewClippingLoop = false
    allChildren = null
    allChildrenCount = 0
    clippingRect = null
    hitSlopRect = null
    // pointerEvents setter reads _overflow, so _overflow must be assigned first.
    _overflow = Overflow.VISIBLE
    pointerEvents = PointerEvents.AUTO
    childrenLayoutChangeListener = null
    onInterceptTouchEventListener = null
    needsOffscreenAlphaCompositing = false
    hasElevatedDescendantCache = null
    backfaceOpacity = 1f
    backfaceVisible = true
    childrenRemovedWhileTransitioning = null
    nativeBackgroundMap = null
    nativeForegroundMap = null
  }
```

**实测 `initView()` 赋值 18 个字段。**

**关键设计**：注释明说

> Set all default values here **as opposed to in the constructor or field defaults**. It is important that these properties are set during the constructor, **but also on-demand whenever an existing ReactViewGroup is recycled**.

**即：初值不在字段声明处也不在构造函数里，而集中在这一个方法里，
构造函数（`:174-176` 的 `init { initView() }`）与 `recycleView()`（`:219`）都调它。**

### 5.4 声明顺序陷阱及其注释

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/view/ReactViewGroup.kt:166-176
  // Cached result of the descendant-elevation scan so the per-draw [hasOverlappingRendering]
  // callback reads an O(1) value instead of walking the subtree each time. null means invalid
  // (recomputed lazily on the next query); true/false is the memoized answer. Marked stale from the
  // logical mount/unmount and elevation hooks via [HasElevatedDescendantCache.invalidateAncestors]
  // -- never from the subview-clipping/scroll path. Declared before init { initView() } so
  // initView()'s reset is not overwritten by the field initializer.
  private var hasElevatedDescendantCache: Boolean? = null

  init {
    initView()
  }
```

**注释的最后一句点明了一个真实的 Kotlin 陷阱**：

> Declared **before** init { initView() } so initView()'s reset is not overwritten by the field initializer.

**Kotlin 的字段初始化器在 `init` 块之前执行。**
若 `hasElevatedDescendantCache` 声明在 `init` 块之后，
其字段初始化器 `= null` 会在 `initView()` 之后执行，
**把 `initView()` 的重置覆盖掉**。

**注释还解释了缓存本身的设计**（避免 `hasOverlappingRendering` 每次绘制都遍历子树），
并明确它**只在挂载/卸载与 elevation 钩子时失效，绝不从子视图裁剪/滚动路径失效**。

### 5.5 `recycleView()` 的完整动作清单

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/view/ReactViewGroup.kt:206-242
  internal open fun recycleView() {
    recycleCount++

    // Remove dangling listeners
    val allChildren = allChildren
    if (allChildren != null && childrenLayoutChangeListener != null) {
      childrenLayoutChangeListener?.shutdown()
      for (i in 0..<allChildrenCount) {
        allChildren[i]?.removeOnLayoutChangeListener(childrenLayoutChangeListener)
      }
    }

    // Set default field values
    initView()
    overflowInset.setEmpty()

    // Remove any children
    removeAllViews()

    // If the view is still attached to a parent, we need to remove it from the parent
    // before we can recycle it.
    if (parent != null) {
      // Detaching via ViewGroup.removeView bypasses the ViewManager hooks, so invalidate the
      // ancestor caches here.
      HasElevatedDescendantCache.invalidateAncestors(parent)
      (parent as ViewGroup).removeView(this)
    }

    // Reset background, borders
    updateBackgroundDrawable(null)

    resetPointerEvents()

    // In case a focus was attempted but the view never attached, reset to false
    focusOnAttach = false
  }
```

**六类动作**：

| 类 | 动作 | 为什么必要 |
| --- | --- | --- |
| ① 计数器 | `recycleCount++` | 可观测性（复用次数） |
| ② 监听器 | `childrenLayoutChangeListener?.shutdown()` + 逐个 `removeOnLayoutChangeListener` | **避免监听器泄漏** |
| ③ 字段 | `initView()`（18 个）+ `overflowInset.setEmpty()` | 状态重置 |
| ④ 子视图 | `removeAllViews()` | — |
| ⑤ 父视图 | `parent as ViewGroup).removeView(this)` | 注释说明：**`ViewGroup.removeView` 绕过 ViewManager 钩子，故需手动 `invalidateAncestors`** |
| ⑥ 外观 | `updateBackgroundDrawable(null)` | 背景与边框 |
| ⑦ 焦点 | `focusOnAttach = false` | 注释：*In case a focus was attempted but the view never attached* |

**⑤ 的注释是一流的** —— 它解释了一个**非显而易见的耦合**：
直接调 `ViewGroup.removeView` 会绕过 RN 的 ViewManager 钩子，
所以必须手动调 `HasElevatedDescendantCache.invalidateAncestors`。

**② 用 `for (i in 0..<allChildrenCount)` 而非 `for (child in allChildren)`** ——
因为 `allChildren` 是 `Array<View?>?`（可含 null），且遍历期间会修改数组内容，
**用索引避免 `ConcurrentModificationException`**。

### 5.6 三档实测分布

`recycleView()` 在 6 个类中被定义（`ReactViewGroup` 与 5 个子类的 `internal fun`），
实测各自动作数：

| 类 | 直接重置字段数 | 机制 |
| --- | --- | --- |
| **`ReactViewGroup`** | **18（经 `initView()`）+ 6（方法内）** | **集中重置，最佳实践** |
| `ReactScrollView` / `ReactHorizontalScrollView` / `ReactNestedScrollView` | **0（直接）** | 调 `initView()` + `updateView()` |
| `PreparedLayoutTextView` | 6 | 直接赋值 + `BackgroundStyleApplicator.reset(this)` |
| `ReactVirtualView` | 4 | 直接赋值 + `cleanupLayoutListeners()` |

**三个 ScrollView 的 `recycleView()` 最简单**：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/ReactScrollView.kt:266-274
  internal fun recycleView() {
    initView()
    if (parent != null) {
      (parent as ViewGroup).removeView(this)
    }
    updateView()
  }

  private fun updateView() {}
```

**注意 `updateView()` 是空函数**（`:274`）——
即 `:271` 的调用目前无效果。

**`ReactScrollView` 的 `initView()` 不像 `ReactViewGroup` 那样被复用** ——
它是一个 ScrollView 自己的字段重置方法。

**`ReactVirtualView` 的覆写最特殊**：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/virtual/view/ReactVirtualView.kt:116-126
  override fun recycleView() {
    cleanupLayoutListeners()
    scrollView?.virtualViewContainerState?.remove(this)
    scrollView = null
    mode = null
    modeChangeEmitter = null
    hadLayout = false
    lastContainerRelativeRect.setEmpty()
    lastClippingRect.setEmpty()
    containerRelativeRect.setEmpty()
  }
```

**它 `override` 而非 `internal fun`** —— 与 34 文档 §3.4 记录的
iOS `RCTVirtualViewComponentView.prepareForRecycle` 的「从容器状态里 `remove:self`」
**完全同型**：

| | iOS `RCTVirtualViewComponentView`（34 文档 §3.4） | Android `ReactVirtualView` |
| --- | --- | --- |
| 从容器摘除 | `[[_parentVirtualViewContainer virtualViewContainerState] remove:self]` | `scrollView?.virtualViewContainerState?.remove(this)` |
| 重置 `hidden` | `self.hidden = NO` | — |
| 重置 mode | `_mode.reset()` | `mode = null` |
| 重置几何 | `_targetRect.reset()` | 3 个 `Rect.setEmpty()` |

**两端一致。**

### 5.7 `ReactVirtualView.onDetachedFromWindow` 也调 `recycleView()`

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/virtual/view/ReactVirtualView.kt:114-117
  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    recycleView()
  }
```

**注意：`onDetachedFromWindow` 是 view 被移除的回调，
但 `recycleView()` 也由 `prepareToRecycleView` 调用。**

**即 `recycleView()` 有两个调用点**：
① 真正的回收（`prepareToRecycleView`）；② 只是从窗口分离（还没进池）。

**② 的场景下 view 可能马上被重新挂载到同一棵树** ——
此时 `mode`/`hadLayout` 被重置了，**语义上是安全的**（重新布局会重算）。

> **但这是一个「同一个方法被两个语义不同的路径调用」的形态。**
> 与 39 文档 §3.2 的 `performMethodInvocation`（同步/异步共用）同型：
> **共享实现，但两条路径的语义不同，必须靠阅读全部调用点才能确认正确性。**

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| GG-1 | **回收栈无 size 上限**（`push` 无检查），与 iOS 的 1024 上限形成对比 | `uimanager/ViewManager.java:271` | 常驻上界由运行时卸载数决定；**内存警告才收缩** |
| GG-2 | **`ViewManagerRegistry.onTrimMemory` 完全忽略 `level`** | `uimanager/ViewManagerRegistry.kt:139` | `UI_HIDDEN(20)` 也清池；**但 `trimMemory()` 的注释说明了理由**，故属有意 |
| GG-3 | **路径 B 只在 Fabric 下存在**，legacy 模式有回收池但无清空 | `fabric/FabricUIManager.java:261` | legacy 模式下回收池**只在内存警告时不被清理** |
| GG-4 | **两个 `ComponentCallbacks2` 对 `onLowMemory` 处置不同**（转发 vs 空实现） | `ViewManagerRegistry.kt:161` vs `MemoryPressureRouter.kt:47` | `onLowMemory()` 时**视图侧清池、JS 侧无响应** |
| GG-5 | `levelName` 传进 `collectGarbage` 但当前不消费（注释承认） | `ReactCommon/.../ReactInstance.cpp:707` | **已接线未消费**，比「没接线」更难发现 |
| GG-6 | **GC 排在 `scheduleWork` 之后**，JS 死循环时无法执行 | `ReactCommon/.../ReactInstance.cpp:708-711` | **JS 侧 OOM 无法自救的机制性原因** |
| GG-7 | `ReactScrollView.updateView()` 是空函数但被 `recycleView()` 调用 | `views/scroll/ReactScrollView.kt:271, 274` | 当前无效果；**疑似未完成的清理** |
| GG-8 | `ReactVirtualView.recycleView()` 被 `onDetachedFromWindow` 与 `prepareToRecycleView` 两条语义不同的路径调用 | `views/virtual/view/ReactVirtualView.kt:114-117` | 当前安全（重算即可）；**共享实现需全读调用点才能确认** |
| GG-9 | `MemoryPressureRouter.destroy(context)` 的 `context` 参数多余（只用 `applicationContext`） | `MemoryPressureRouter.kt:25-27` | 无害；签名冗余 |

### GG-1 与 GG-2 的定性

**GG-1 是「设计上界不精确」而非「缺陷」**：
栈里的 View 已从视图树移除，单个成本有限；
而内存警告一到就全清。**风险窗口是「大量卸载后、内存警告前」。**

**GG-2 是「有意」** —— `ViewManager.trimMemory()` 的注释
*With even slight memory pressure, we immediately evict all recyclable Views*
**明确说明了这是刻意的**。

> **GG-1 与 GG-2 的组合效果**：
> **无上界 + 任意等级都清空 = 「平时无界，压力一来清零」**。
> 这是一个**合理的设计取舍**：用「平时的内存占用」换「压力时的响应速度」。
>
> **若要让上界明确**，最小改动是在 `push` 前加一个与 iOS 相同的常数检查。

---

## 7. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 05 文档：iOS 6 个内存警告观察者 | **补上 Android 侧的两条路径**（JS 侧 / 视图侧）与其分工（§2.1） |
| 05 文档：`handleMemoryPressureJs` 的分级（4 严重 / 3 忽略） | **确认仍准确**（§3.2）；**补上 Kotlin 侧已退化为 JNI 薄壳 + NPE 兜底**（§2.4） |
| 31 文档 §2.1：iOS 回收池上限 1024 | **对照**：Android **无上限**（GG-1）；并给出两端在「上界由什么决定」上的差异（§4.3） |
| 31 文档 §2.3：iOS 内存警告整池清空 | **对照**：Android 同样清空但**换新对象而非 `clear()`**（§4.5） |
| 31 文档 V-4：iOS 上界不精确 | **补上更弱的一端**：Android 连上界都没有 |
| 34 文档 §3.4：iOS `RCTVirtualView.prepareForRecycle` 从容器摘除 | **对照**：Android `ReactVirtualView.recycleView` 完全同型（§5.6） |
| 35 文档 Z-5：`DebuggingOverlay` 高亮数组不重置 | **对照**：Android 侧 `ReactViewGroup.recycleView()` 的 18 字段集中重置是**最佳实践**（§5.3） |
| 36 文档 §5：注释质量三档 | **新增第一档的两个新实例**：Kotlin 字段顺序陷阱（§5.4）、`removeView` 绕过钩子（§5.5 ⑤） |
| 38 文档 §2.4：弱引用 + 一次性强引用 | **新增同型**：`createMemoryPressureListener`（§2.5） |
| 40 文档 §3.1：`CopyOnWriteArrayList` + add 去重 / remove 不去重 | **新增同型**：`MemoryPressureRouter`（§2.6），确认是团队约定 |
| 40 文档 §2：38 个零引用 marker | **对照**：`levelName` 是「已接线未消费」，**更难发现**（§3.4） |
| 37 文档：legacy 退役 | **新增另一形态**：Android 是「功能保留但触发条件随架构收窄」（§2.2） |
| 39 文档 §3.2：同一实现被两条语义不同的路径调用 | **新增同型**：`ReactVirtualView.recycleView()`（GG-8） |
