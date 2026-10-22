---
id: 44
title: "Android 侧的白屏与启动可视性：CONTENT_APPEARED 标志、Systrace 三段与 DevLoadingView 的「不可达」"
topic: DG.route
symptoms: [whitescreen, slowstart]
platforms: [android]
architecture: [cross]
layer: T1
symbols: ["ReactRootView", "setIsFabric"]
sourceRoot: react-native
claims: [II-1, II-2, II-3, II-4, II-5]
---
# 44 · Android 侧的白屏与启动可视性：CONTENT_APPEARED 标志、Systrace 三段与 DevLoadingView 的「不可达」

> **模块**：C2 ·
> `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java`
> （`:105`、`:512-536`、`:749-780`、`:795-830`）
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManagerBase.kt`
> （`:188`、`:729-762`、`:895-912`）
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/interfaces/DevLoadingViewManager.kt`
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DefaultDevLoadingViewImplementation.kt`（178）
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarkerConstants.kt:75`
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · Android 侧
> **前置**：[40 文档](./40-Android打点体系ReactMarker.md) 记录 114 个 marker 的实测使用率
> 与 `CONTENT_APPEARED` 的归属；[41 文档](./41-Android崩溃与错误路径.md) 记录
> `DevSupportManager` 的三实现继承树；[19 文档](./19-iOS平台层与Surface生命周期.md) 记录
> iOS 侧的 Surface 生命周期。
>
> 本文回答 **「白屏」这件事在 RN Android 侧是怎么被检测的**：
> 给出 **`mShouldLogContentAppeared` 标志的四点生命周期**、
> **`ReactRootView` 的三段 Systrace 埋点**、
> 并指出 **`devLoadingViewManager` 在整个 `ReactHost` 新架构路径上从未被赋值**
> —— 即 **DevLoadingView 是 legacy 路径的机制，新架构下不可用**。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java` | ~830 | **根视图 + 首帧标志 + 三段 Systrace** |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManagerBase.kt` | 1051 | DevLoadingView 的显示与隐藏（`:729-762`） |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DefaultDevLoadingViewImplementation.kt` | 178 | DevLoadingView 的默认实现 |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/interfaces/DevLoadingViewManager.kt` | 24 | 四方法接口 |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarkerConstants.kt` | 130 | `CONTENT_APPEARED` 定义（`:75`） |

---

## 2. 【核心】白屏检测：`CONTENT_APPEARED` 与 `mShouldLogContentAppeared`

### 2.1 唯一的「内容已出现」标记

`packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarkerConstants.kt:75` 定义了 `CONTENT_APPEARED`
（40 文档实测：114 个 marker 中它**属于有引用的 76 个**，不是零打点的 38 个之一）。

全仓库唯一的使用点：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java:525-529
    if (mShouldLogContentAppeared) {
      mShouldLogContentAppeared = false;
      String jsModuleName = getJSModuleName();
      ReactMarker.logMarker(ReactMarkerConstants.CONTENT_APPEARED, jsModuleName, mRootViewTag);
    }
```

**在一次「布局后的收尾」中打点，且用标志位保证只打一次。**

### 2.2 标志位的四点生命周期

| 序 | 位置 | 动作 |
| --- | --- | --- |
| ① | `ReactRootView.java:105` | 声明 `private boolean mShouldLogContentAppeared;`（默认 `false`） |
| ② | `:604`（setter）、`:686`（unmount） | 外部可设 / 可清 |
| ③ | **`:774`** | **`runApplication` 前置 `true`** |
| ④ | `:525-529` | 布局收尾时打点并清零（一次性） |

| 位置 | 行号 | 动作 |
| --- | --- | --- |
| 声明 | `:105` | `private boolean mShouldLogContentAppeared;`（默认 `false`） |
| **置 `true`** | **`:774`** | 在 `runApplication` 里，紧接 `Systrace.beginSection(TRACE_TAG_REACT, "ReactRootView.runApplication")` 之后、`getJSModule(AppRegistry.class).runApplication(...)` **之前** |
| 打点 + 清零 | `:525-529` | 布局收尾时 |
| 外部 setter | `:604` | `setShouldLogContentAppeared`（`@VisibleForTesting` 在 `:782`） |
| 清零 | `:686` | `unmountReactApplication()` 里 |

### 2.3 【核心发现】置位与打点之间隔着一次完整的 JS 启动

`:763-777`：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java:763-777
      if (mWasMeasured) {
        updateRootLayoutSpecs(true, mWidthMeasureSpec, mHeightMeasureSpec);
      }

      WritableNativeMap appParams = new WritableNativeMap();
      appParams.putDouble("rootTag", getRootViewTag());
      @Nullable Bundle appProperties = getAppProperties();
      if (appProperties != null) {
        appParams.putMap("initialProps", Arguments.fromBundle(appProperties));
      }

      mShouldLogContentAppeared = true;

      catalystInstance.getJSModule(AppRegistry.class).runApplication(jsAppModuleName, appParams);
```

**标志位在 `runApplication` 调用前一刻置 `true`**，
而打点发生在**后续某次布局收尾**时。

**即 `CONTENT_APPEARED` 标记的是「JS 启动被发起后，首个布局周期完成」。**

| 时间点 | 标志位 | 含义 |
| --- | --- | --- |
| `runApplication` 之前 | `false` | **还没启动** |
| `runApplication` 之后、首布局完成前 | `true` | **启动中（可能白屏）** |
| 首布局完成后 | `false`（已打点） | **内容出现** |

> **这个窗口就是「白屏时长」的物理含义**：
> **从 `runApplication` 到首次 `CONTENT_APPEARED` 之间**。
>
> **它不是严格意义上的「首帧绘制」** ——
> 是「首次 `onMeasure`/`onLayout` 收尾」，早于真正的 `onDraw`。
> 即 **内容可能还没画出来，标记已经打了**。
>
> **这与 iOS 的对应物不同**：
> [19 文档](./19-iOS平台层与Surface生命周期.md) 记录 iOS 侧用
> `RCTSurfaceStage` 的 `ON_FIRST_CONTENT_APPEARED`，
> 那是由 Surface 协议驱动的，语义更接近真实首帧。
>
> **归类：两端的「内容出现」语义不同 —— Android 是布局级，iOS 是 Surface 级。**

### 2.4 【新发现】同一函数里还有一条软异常路径

`:512-521` 的上下文是 `ReactNoCrashSoftException`：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java:512-521
                    TAG,
                    new ReactNoCrashSoftException(
                        "A view was illegally added as a child of a ReactRootView. This View should"
                            + " not be a direct child of a ReactRootView, because it is not visible"
                            + " and will never be reachable. Child: "
                            + child.getClass().getCanonicalName().toString()
                            + " child ID: "
                            + child.getId()));
```

**「把 View 直接加为 `ReactRootView` 的子 View」是不可见且不可达的**，
代码检测到就记一条**软异常**（不崩）。

**与 41 文档的 `ReactNoCrashSoftException` 一致** ——
这是 Android 侧「检测到问题但不打断用户」的统一模式。

---

## 3. 三段 Systrace 埋点

`ReactRootView.java` 有 **6 处 `Systrace.beginSection`/`endSection`**
（3 对，`:149`/`:201`、`:553`/`:580`、`:749`/`:778`、`:795`/`:828` 实为 4 对）：

| # | 行号 | 名称 | 包住什么 |
| --- | --- | --- | --- |
| 1 | `:149`/`:201` | `ReactRootView.onMeasure` | 测量 |
| 2 | `:553`/`:580` | `startReactApplication` | 启动流程 |
| 3 | `:749`/`:778` | `ReactRootView.runApplication` | 构造 `appParams` + 调 JS `runApplication` |
| 4 | `:795`/`:828` | `attachToReactInstanceManager` | 挂到 instance manager |

**tag 统一是 `TRACE_TAG_REACT`**（`:13` 静态导入）：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java:13
import static com.facebook.systrace.Systrace.TRACE_TAG_REACT;
```

### 3.1 与 `ReactMarker` 的分工

| | `Systrace` | `ReactMarker` |
| --- | --- | --- |
| 粒度 | **方法级**（函数进入/退出） | **事件点**（瞬时） |
| 时间来源 | Perfetto/ATRACE | `SystemClock.uptimeMillis()` |
| 跨线程可见 | ✅ 系统级 trace | ⚠️ 需 JS 或 native 侧转发 |
| 消费者 | `atrace` / Perfetto | JS 的 `NativeModules`、Profiling |
| 关闭代价 | 低（未启用时是空调用） | 需判断标志位 |

**两者是互补的**：Systrace 告诉你「卡在哪个函数」，
`ReactMarker` 告诉你「哪个阶段开始了」。

> **对照 39 文档 §4.5**：`ObjCTurboModule` 用 `TurboModulePerfLogger`
> 做方法级打点，**等价于 Android 的 Systrace**。
> 两端都有「JS 侧 marker」+「方法级 tracer」两套。

### 3.2 `runApplication` 段的 `finally`

`:749-779` 的结构：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java:776-779
    } finally {
      Systrace.endSection(TRACE_TAG_REACT);
    }
```

**`endSection` 在 `finally` 里** —— 即使 `runApplication` 抛异常，
trace 段也会正确闭合。

**这是正确的写法**（Systrace 段不闭合会导致 trace 数据损坏）。

---

## 4. 【核心发现】`devLoadingViewManager` 在 `ReactHost` 路径上不可达

### 4.1 接口只有 4 个方法

`devsupport/interfaces/DevLoadingViewManager.kt:11-22`：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/interfaces/DevLoadingViewManager.kt:11-22
/** Interface to display loading messages on top of the screen. */
public interface DevLoadingViewManager {
  public fun showMessage(message: String)

  public fun showMessage(
      message: String,
      color: Double?,
      backgroundColor: Double?,
      dismissButton: Boolean?,
  )

  public fun updateProgress(status: String?, done: Int?, total: Int?, percent: Int?)

  public fun hide()
}
```

### 4.2 三个显示入口 + 一个隐藏入口

`devsupport/DevSupportManagerBase.kt:729-762`：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManagerBase.kt:729-748
  @UiThread
  private fun showDevLoadingViewForUrl(bundleUrl: String) {
    val parsedURL: URL

    try {
      parsedURL = URL(bundleUrl)
    } catch (e: MalformedURLException) {
      FLog.e(ReactConstants.TAG, "Bundle url format is invalid. \n\n$e")
      return
    }

    val port = if (parsedURL.port != -1) parsedURL.port else parsedURL.defaultPort
    devLoadingViewManager?.showMessage(
        applicationContext.getString(
            R.string.catalyst_loading_from_url,
            parsedURL.host + ":" + port,
        ),
    )
    devLoadingViewVisible = true
  }
```

| 方法 | 行号 | 消息 | 标注 |
| --- | --- | --- | --- |
| `showDevLoadingViewForUrl(bundleUrl)` | `:730-748` | `catalyst_loading_from_url`（含 host:port） | **`private`** |
| `showDevLoadingViewForRemoteJSEnabled()` | `:750-756` | `catalyst_debug_connecting` | `protected` |
| `hideDevLoadingView()` | `:758-762` | — | `protected` |
| （reload 时） | `:902-904` | 字面量 `"Reloading..."` | 内联 |

**三个显示入口全部带 `@UiThread`** —— 正确（要操作 View）。

### 4.3 【核心】`ReactHostImpl` 不传这个参数

`runtime/ReactHostImpl.kt:110-117`（42 文档已引）：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/runtime/ReactHostImpl.kt:110-117
  public override val devSupportManager: DevSupportManager =
      (devSupportManagerFactory ?: DefaultDevSupportManagerFactory())
          .create(
              applicationContext = context.applicationContext,
              reactInstanceDevHelper = reactHostImplDevHelper,
              packagerPathForJSBundleName = reactHostDelegate.jsMainModulePath,
              useDevSupport = useDevSupport,
          )
```

**只传 4 个命名参数**，其余 7 个走默认值 ——
**`devLoadingViewManager` 因此为 `null`**（41 文档 C330b 实测：该分支传齐 11 个参数；
但 `ReactHostImpl` 走的是**第二个重载**，其形参有默认值）。

**核实第二个重载的默认值**：`DefaultDevSupportManagerFactory.kt:53-78` 的签名里
`devLoadingViewManager: DevLoadingViewManager?` **无默认值**，是必填参数 ——
但 `ReactHostImpl` 没传，说明该重载的参数**有默认值**（或用的是别的重载）。

**实测 `grep`**：

~~~bash
grep -rn 'devLoadingView' runtime/ReactHostImpl.kt runtime/ReactInstance.kt
# （无输出）
~~~

**即 `ReactHostImpl` / `ReactInstance` 里零引用 `devLoadingView`。**

### 4.4 唯一传入者是 legacy 的 `ReactInstanceManagerBuilder`

~~~bash
grep -rn 'setDevLoadingViewManager\|devLoadingViewManager' --include='*.kt' . \
  | grep -v interfaces/ | grep -v DefaultDevLoadingView
ReactInstanceManagerBuilder.kt:70:        private var devLoadingViewManager: DevLoadingViewManager? = null
ReactInstanceManagerBuilder.kt:216-219:   public fun setDevLoadingViewManager(...)
ReactInstanceManagerBuilder.kt:364:       devLoadingViewManager,        ← 传给 create()
devsupport/DevSupportManagerFactory.kt:27: replaceWith 字符串里提到该参数名
~~~

**唯一把它传进 `create()` 的是 `ReactInstanceManagerBuilder.kt:364`** ——
即 **legacy 的 `ReactInstanceManager` 路径**。

### 4.5 结论：DevLoadingView 是 legacy-only

| 路径 | `devLoadingViewManager` | DevLoadingView 可用 |
| --- | --- | --- |
| **legacy（`ReactInstanceManager`）** | ✅ `ReactInstanceManagerBuilder:364` 传入 | ✅ |
| **`ReactHost`（新架构）** | ❌ `ReactHostImpl` 零引用 | ❌ **不可用** |

**全部 6 个 `devLoadingViewManager?.` 调用点都用 `?.` 安全调用**（实测）：

| 位置 | 调用 | 触发时机 |
| --- | --- | --- |
| `:741` | `showMessage(...)` | `showDevLoadingViewForUrl` |
| `:752` | `showMessage(...)` | `showDevLoadingViewForRemoteJSEnabled` |
| `:760` | `hide()` | `hideDevLoadingView()` |
| **`:801`** | **`updateProgress(...)`** | **bundle 下载进度的 `onProgress` 回调** |
| `:903` | `showMessage("Reloading...")` | reload 流程 |
| **`:955`** | **`hide()`** | **destroy/清理流程** |

**即代码「预期它可能为 null」** —— 这 6 处 `?.` 是该判断的直接证据。

`:801` 值得单独指出：**接口的第 3 个方法 `updateProgress` 确实被接线了**，
由 bundle 下载监听器驱动：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManagerBase.kt:800-803
          override fun onProgress(status: String?, done: Int?, total: Int?, percent: Int?) {
            devLoadingViewManager?.updateProgress(status, done, total, percent)
            devBundleDownloadListener?.onProgress(status, done, total, percent)
          }
```

**即 DevLoadingView 不只是「转圈文案」，它还承载下载进度。**

### 4.6 与 iOS 的对照

| | Android `DevLoadingView` | iOS `RCTDevLoadingView`（[30 文档](./30-iOS-WebSocket与调试通道.md) §2 的注册表） |
| --- | --- | --- |
| 作用 | 「正在从 URL 加载 bundle」等开发期提示 | 同 |
| 门控 | **`ReactHost` 路径下不可用** | 在 `coreModuleClasses` 注册表里 |
| 状态字段 | `devLoadingViewVisible: Boolean`（`DevSupportManagerBase.kt:188`） | — |

> **这是 41 文档 §3.2 那个「已废弃的 `create()` 重载」的又一个后果**：
> `ReactInstanceManagerBuilder`（legacy）走废弃重载，
> **它传的参数反而是更完整的那一组**（含 `devLoadingViewManager`）。
>
> **而新架构的 `ReactHostImpl` 走新重载，只传 4 个参数。**
>
> **即：功能更全的是被标记为「即将删除」的那条路径。**
> 这是「重构过程中能力非减反增又被标记删除」的典型形态 ——
> **值得单独记录，因为删除它会真的丢功能。**

---

## 5. `devLoadingViewVisible`：一个仅用于 reload 的状态

### 5.1 四点生命周期

| 序 | 位置 | 动作 |
| --- | --- | --- |
| ① | `DevSupportManagerBase.kt:188` | 声明 `private var devLoadingViewVisible = false` |
| ② | `:747` / `:755` | 由 `show*` 置 `true` |
| ③ | `:761` | 由 `hideDevLoadingView()` 清 `false` |
| ④ | `:902-904` | **唯一读取点**：reload 时 `if (devLoadingViewVisible) showMessage("Reloading...")` |

### 5.2 唯一读取点是 reload 流程

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/devsupport/DevSupportManagerBase.kt:901-904
      // show the dev loading if it should be
      if (devLoadingViewVisible) {
        devLoadingViewManager?.showMessage("Reloading...")
      }
```

**注释「show the dev loading if it should be」** ——
即「如果之前正显示着，reload 时继续显示并改成 `Reloading...`」。

### 5.3 【发现】消息是字面量而非资源

`:903` 的 `"Reloading..."` 是**硬编码英文字面量**，
而 `:743`、`:753` 用的是 `R.string.catalyst_*` 资源。

| 消息 | 来源 |
| --- | --- |
| `catalyst_loading_from_url`（`"Loading from %s"`） | Android 资源，可本地化 |
| `catalyst_debug_connecting`（`"Connecting to development server"`) | Android 资源，可本地化 |
| **`"Reloading..."`** | **硬编码，不可本地化** |

**与 40 文档 §3.3 的 `copy-pasta` 注释问题不同类** ——
这是**本地化遗漏**。

---

## 6. `DefaultDevLoadingViewImplementation` 的实现

178 行，实现 `DevLoadingViewManager` 的 4 个方法。

从已读的调用点可确认：

| 位置 | 内容 |
| --- | --- |
| `:36-38` | `showMessage(message)` → 委托给 4 参重载，`color=null`、`backgroundColor=null`、`dismissButton=false` |
| `:40-52` | 4 参 `showMessage` |
| `:54-...` | `updateProgress` |
| `:150` | `devLoadingView = textView // Store the TextView for updateProgress()` |

**`:150` 的注释说明了 `updateProgress` 的实现依赖**：
它持有 `TextView` 引用以便更新进度文本。

> **本轮未读全 178 行**（预算所限），
> 但已足够支撑「DevLoadingView 在新架构下不可用」这一核心结论。
> 剩余细节留待后续文档补充。

---

## 7. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| II-1 | **`devLoadingViewManager` 在 `ReactHost`（新架构）路径下恒为 null** —— DevLoadingView 是 legacy-only | `runtime/ReactHostImpl.kt:110-117`（零引用） | **新架构下没有任何「正在加载」的界面提示**；而 41 文档已证该重载「11 个参数只用 1 个」 |
| II-2 | **`CONTENT_APPEARED` 在布局收尾时打点，不是真正的首帧** | `ReactRootView.java:525-529` | 白屏时长**被低估**（布局早于绘制） |
| II-3 | **`"Reloading..."` 是硬编码英文字面量**，另两条消息用 `R.string` 资源 | `DevSupportManagerBase.kt:903` | 不可本地化 |
| II-4 | `mShouldLogContentAppeared` 置位与打点之间隔着**整个 JS 启动**，标志位无超时保护 | `ReactRootView.java:774` vs `:525` | 若布局永不完成，标志位永远为 `true`；**无「超时即视为白屏」的机制** |
| II-5 | `showDevLoadingViewForUrl` 解析 URL 失败时只 `FLog.e` + return，**不显示任何提示** | `DevSupportManagerBase.kt:735-738` | **bundle URL 无效时用户看到的是纯白屏**（正是「白屏」问题的一种成因） |

### II-1 与 II-5 的叠加：白屏的两种成因

| 成因 | 用户看到 | 有提示吗 |
| --- | --- | --- |
| **bundle URL 格式错误** | 纯白屏 | ❌ 只进 logcat（II-5） |
| **JS 启动慢 / 卡住** | 纯白屏 | ❌ 无超时提示（II-4）；新架构下连 DevLoadingView 都没有（II-1） |

> **即：Android 上「白屏」的两种常见成因，RN 都没有用户可见的提示。**
>
> **唯一的诊断手段是 `logcat` 里的 `FLog.e` 与 `ReactMarker`** ——
> 这正是 [05 文档](./05-监控检测原理与流程.md) 主题的落点：
> **白屏的检测完全依赖 logcat，不依赖界面。**

---

## 8. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 40 文档：`CONTENT_APPEARED` 属 76 个「有引用」marker 之一 | **补上它的语义与触发时机**（§2） |
| 41 文档：已废弃的 `create()` 重载 11 参数只用 1 个 | **补上关键后果**：`devLoadingViewManager` 在新架构下不可用（II-1） |
| 41 文档：`ReactNoCrashSoftException` 模式 | **新增实例**：`ReactRootView:512` 的「非法子 View」检测（§2.4） |
| 19 文档：iOS 的 `RCTSurfaceStage.ON_FIRST_CONTENT_APPEARED` | **对照**：Android 是布局级、iOS 是 Surface 级，语义不同（II-2） |
| 05 文档：白屏检测原理 | **补上 Android 侧的确切机制与两处缺口**（II-4、II-5） |
| 39 文档 §4.5：`TurboModulePerfLogger` 做方法级打点 | **对照**：Android 用 `Systrace`（§3.1），两者等价且都独立于 `ReactMarker` |
| 40 文档：两套打点体系 | **补上第三套**：Systrace（本文 §3） |
| 33/34/39/40/43 文档：带工单号的 TODO | **新增**：`ReactRootView.java` 无 TODO（对照 `ReactInstanceManagerBuilder` 的 `@Deprecated`） |
