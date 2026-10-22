---
id: 40
title: "Android 侧打点体系：ReactMarker 的 114 个常量、38 个零打点与 JNI 字符串映射"
topic: PL.android
symptoms: [debug, jank]
platforms: [android]
architecture: [cross]
layer: T3
symbols: ["ReactMarkerConstants", "ReactMarker"]
claims: [EE-1, EE-2, EE-3, EE-4, EE-5, EE-6, EE-7, EE-8]
---
# 40 · Android 侧打点体系：ReactMarker 的 114 个常量、38 个零打点与 JNI 字符串映射

> **模块**：C2 · `ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarker.kt`
> （207 行）+ `ReactMarkerConstants.kt`（130 行）
> + `ReactAndroid/src/main/jni/react/jni/JReactMarker.cpp`
> **基线**：react-native @ `9b131e42` · Android 侧
> **前置**：[05 文档](./05-监控检测原理与流程.md) 记录了检测/监控/上报原理；
> [06 文档](./06-问题清单与优化建议.md) 记录了 iOS 侧
> 「22 个 `RCTPLTag` 中 12 个零打点」的 P2-3 清单；
> [25 文档](./25-iOS桥接核心与启动性能标签.md) 记录了 iOS 的启动性能标签体系。
>
> 本文给出 **Android 侧启动性能打点的完整清单与实测使用率**，
> 补上 06 文档 P2-3 清单在 Android 上的对应数据，
> 并记录 **Kotlin↔C++ 两侧 13 个 native marker 的手工字符串映射**
> （正面对照 + 一处静默失效风险）。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `bridge/ReactMarker.kt` | 207 | 打点分发器 |
| `bridge/ReactMarkerConstants.kt` | 130 | **114 个常量定义** |
| `jni/react/jni/JReactMarker.cpp` | ~160 | **Kotlin → C++ 的字符串映射** |
| `bridge/ReactContext.java` | 668 | 上下文（打点的调用方之一） |

---

## 2. `ReactMarkerConstants`：114 个常量

### 2.1 定义形式

`ReactMarkerConstants.kt:10-14`：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarkerConstants.kt:10-14
/** Constants used by ReactMarker. */
public enum class ReactMarkerConstants(
    @get:JvmName("hasMatchingNameMarker") public val hasMatchingNameMarker: Boolean = false,
) {
```

**一个枚举项 + 一个布尔属性**，默认 `false`。

**`hasMatchingNameMarker` 的语义**（从 §4 的 JNI 侧确认）：
「这个名字在 C++ 的 `ReactMarker` 里有对应项，需要跨 JNI 转发」。

### 2.2 分区注释

枚举体用注释分成 4 段：

| 段 | 分区注释 | 项数（实测） |
| --- | --- | --- |
| ① 启动/生命周期段 | **无分区注释** | **94**（`:14-108`） |
| ② Fabric 段 | `// Fabric-specific constants below this line`（`:109`） | **14**（`:110-123`） |
| ③ bridge / bridgeless 段 | `// New markers used by bridge and bridgeless loading below this line`（`:125`） | **4**（`:126-129`） |

**② 与 ③ 段首有注释，① 段（最大，94 项）没有** ——
与 39 文档 §2.2（TurboModule 四步解析中只有一步无注释）属同一类问题：
**最大的那一段最缺文档**。

### 2.3 【核心数据】实测使用率

**统计口径**：全仓库（`packages/react-native`、`packages/rn-tester`、`private`）
的 `.kt` / `.java` / `.cpp` / `.h` 文件，排除 `__tests__`、`tests/`、`__mocks__/`、
以及 `ReactMarkerConstants.kt` 与 `ReactMarker.kt` 自身。

| 指标 | 数值 |
| --- | --- |
| 枚举项总数 | **114** |
| 其中 `hasMatchingNameMarker = true` | **13** |
| 生产代码**有引用** | **76（66.7%）** |
| 生产代码**零引用** | **38（33.3%）** |
| 零引用中 `hasMatchingNameMarker = true` 的 | **0** |

> **第一个关键结论：13 个 native marker 全部在用。**
> 这修正了「声明为要跨 JNI 转发但实际没人打」的潜在担忧 —— **不存在这种情况**。

### 2.4 38 个零打点的构成

| 后缀 | 数量 | 说明 |
| --- | --- | --- |
| `*_START` | **18** | 起点 |
| `*_END` | **17** | 终点 |
| 单项（无 START/END 后缀） | **3** | `UNPACKING_JS_BUNDLE_LOADER_EXTRACTED`、`UNPACKING_JS_BUNDLE_LOADER_BLOCKED`、`ON_FRAGMENT_CREATE` |

按「基名」聚合（一个 `_START` + 一个 `_END` 视为一对）：

| 类别 | 对/项数 |
| --- | --- |
| **两端都死**（完整失效的区间） | **16 对** |
| **只死一端** | **3 项**：`CREATE_REACT_CONTEXT`（START 死/END 活）、`PRE_REACT_CONTEXT`（START 不存在/END 死）、`PRE_RUN_JS_BUNDLE`（START 死/END 不存在） |
| **单项死** | **3 项**（上表） |

**16 个完整失效的区间**：

```
PROCESS_PACKAGES                     LOAD_REACT_NATIVE_FABRIC_SO_FILE
BUILD_NATIVE_MODULE_REGISTRY         CREATE_MC_MODULE
CREATE_CATALYST_INSTANCE             CREATE_MC_MODULE_GET_METADATA
DESTROY_CATALYST_INSTANCE            JAVASCRIPT_EXECUTOR_FACTORY_INJECT
CREATE_UI_MANAGER_MODULE             PROCESS_INFRA_PACKAGE
PROCESS_CORE_REACT_PACKAGE           PROCESS_PRODUCT_PACKAGE
CREATE_I18N_MODULE_CONSTANTS         GET_REACT_INSTANCE_HOLDER_SPEC
I18N_MODULE_CONSTANTS_CONVERT        UNPACKING_JS_BUNDLE_LOADER_CHECK
```

### 2.5 【核心观察】这 38 个零打点有什么共同点

**逐条看下来，它们集中在两类：**

**① 已被新架构取代的旧路径**

| 基名 | 为什么死 |
| --- | --- |
| `CREATE_CATALYST_INSTANCE` | 「CatalystInstance」是 legacy bridge 的核心类名，新架构下是 `ReactInstance` |
| `DESTROY_CATALYST_INSTANCE` | 同上 |
| `BUILD_NATIVE_MODULE_REGISTRY` | 被 `TurboModuleManager` 的解析机制取代 |
| `PROCESS_PACKAGES` / `PROCESS_CORE_REACT_PACKAGE` / `PROCESS_INFRA_PACKAGE` / `PROCESS_PRODUCT_PACKAGE` | ReactPackage 的处理流程被 `ReactHost` 取代 |
| `CREATE_MC_MODULE*` | MC（Microfrontend）模块机制已移除 |

**② 从未实现的功能点**

| 基名 | 说明 |
| --- | --- |
| `GET_REACT_INSTANCE_HOLDER_SPEC` | 有 START/END 但无人打 —— 功能可能未完成 |
| `JAVASCRIPT_EXECUTOR_FACTORY_INJECT` | 同上 |
| `LOAD_REACT_NATIVE_FABRIC_SO_FILE` | Fabric SO 单独加载可能已合并到统一加载流程 |
| `UNPACKING_JS_BUNDLE_LOADER_*` | bundle 解压相关，可能从未接线 |
| `ON_FRAGMENT_CREATE` | 单项，可能是 Fragment 生命周期追踪的预留项 |

> **两类问题的处置方式不同，但代码上无差别** ——
> 枚举里看不出一个 marker 是「退役」还是「未实现」。
>
> **与 37 文档 §8 的五步判据对照**：
> 那套判据用于判断一个**类**是否退役；
> 本文说明**枚举常量**没有等价的判据，
> 只能靠命名与所属技术栈推断。

### 2.6 与 iOS 侧 `RCTPLTag` 的对照

[06 文档 P2-3](./06-问题清单与优化建议.md) 记录 iOS 侧
「22 个 `RCTPLTag` 中 12 个零打点」（**54.5%**）。
本文实测 Android 侧「114 个中 38 个零打点」（**33.3%**）。

| | iOS `RCTPLTag` | Android `ReactMarkerConstants` |
| --- | --- | --- |
| 总数 | 22 | **114** |
| 零打点 | 12 | **38** |
| 零打点比例 | **54.5%** | **33.3%** |
| 载体 | C 宏 + 函数 | Kotlin 枚举 |
| 静态可查 | ✅ `grep RCTPLTag` | ✅ `grep ReactMarkerConstants.X` |
| 是否有编译期检查 | ❌ 宏未使用不报错 | ❌ 枚举项未使用不报错 |

> **Android 侧比例更低，但绝对数量大得多（38 vs 12）。**
>
> **两者都不是「bug」** —— 打点清单总是先于或后于功能演进，
> 关键是**没有机制识别退役项**。
>
> **一个可行的改进**：给枚举加 `@Deprecated` 或在 CI 里跑
> 「零引用常量」检查（本文的统计脚本即是原型）。

---

## 3. `ReactMarker.kt`：两套监听器与一条 JNI 队列

### 3.1 两套监听器

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarker.kt:25-33
  // Use a list instead of a set here because we expect the number of listeners
  // to be very small, and we want listeners to be called in a deterministic
  // order.
  private val listeners: MutableList<MarkerListener> = CopyOnWriteArrayList()

  // Use a list instead of a set here because we expect the number of listeners
  // to be very small, and we want listeners to be called in a deterministic
  // order. For Fabric-specific events.
  private val fabricMarkerListeners: MutableList<FabricMarkerListener> = CopyOnWriteArrayList()
```

**注释解释了「为什么用 List 而不是 Set」** —— 需要确定性顺序。
**这是第一档注释**（给了理由），与 39 文档 §2.1 的
`conformsToProtocol: is expensive` 同级。

| 监听器 | 分发方法 | 载荷 |
| --- | --- | --- |
| `MarkerListener` | `logMarker`（`:148-155`） | `(name, tag, instanceKey)` |
| `FabricMarkerListener` | `logFabricMarker`（`:71-95`） | `(name, tag, instanceKey, timestamp, counter)` |

**Fabric 版多两个字段**（`timestamp`、`counter`）。

`addListener` / `addFabricListener` 都做**去重**（`if (!listeners.contains(listener))`），
`removeListener` 不去重（`remove` 对重复项只删一个）。

### 3.2 `logMarker` 的三路分发

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarker.kt:148-155
  public fun logMarker(name: ReactMarkerConstants, tag: String?, instanceKey: Int, time: Long?) {
    logFabricMarker(name, tag, instanceKey)
    for (listener in listeners) {
      listener.logMarker(name, tag, instanceKey)
    }

    notifyNativeMarker(name, time)
  }
```

**顺序固定**：

```
① logFabricMarker（Fabric 监听器，永远收到）
② listeners（通用监听器）
③ notifyNativeMarker（跨 JNI，仅 13 个 marker 会真正下发）
```

> **注意 ① 无条件执行** ——
> 即便 marker 与 Fabric 无关（如 `APP_STARTUP_START`），
> 也会走一遍 `logFabricMarker` 的空循环。
> `CopyOnWriteArrayList` 的迭代在空列表上几乎零成本，但**这是每次打点的一次多余调用**。

### 3.3 【核心】JNI 未就绪时的队列缓存与回放

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarker.kt:159-179
  @JvmStatic
  @DoNotStrip
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
    } else {
      // The native JNI method is not loaded at this point.
      nativeReactMarkerQueue.add(ReactMarkerRecord(name.name, now))
    }
  }
```

**机制**：

| 条件 | 行为 |
| --- | --- |
| `!hasMatchingNameMarker` | **立即返回**（101 个 marker 走这条路，零开销） |
| JNI 已就绪 | 先发当前 marker，再**排空**队列里缓存的历史 marker |
| JNI 未就绪 | **入队**（`ConcurrentLinkedQueue`） |

**这是一个解决「启动早期打点早于 SO 加载」的方案。**

**因为 `APP_STARTUP_START` 是启动的第一个 marker**，
它几乎必然发生在 SO 加载完成之前 —— 若不入队就会丢失启动耗时的起点。

> **顺序保证**：回放时**先发当前、后发缓存**，
> 即缓存的历史 marker 时间戳**早于**当前 marker，
> 但**发送顺序**在时间轴上是「历史 → 当前」，**时间戳本身保证了正确排序**。
> 下游若按到达顺序处理而不看时间戳，会得到**倒序的时间线**。

**这是本文最值得注意的一处设计权衡**：

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| **入队 + 回放**（当前） | 不丢启动早期 marker | 下游须按时间戳而非到达顺序排序 |
| 直接丢弃 | 无排序问题 | 丢失 `APP_STARTUP_START` → **启动耗时无法计算** |

**选择入队是对的**，但**注释没有说明「下游必须按时间戳排序」这一隐含契约**。

### 3.4 队列无上限

`nativeReactMarkerQueue` 是 `ConcurrentLinkedQueue`（`:23`），**无容量上限**。

**风险**：若 SO 长时间未加载且持续打 native marker，队列会增长。

**实际约束**：只有 13 个 marker 会入队，且其中大部分集中在启动阶段
（`APP_STARTUP_*`、`INIT_REACT_RUNTIME_*`、`RUN_JS_BUNDLE_*`、`REGISTER_JS_SEGMENT_*`），
**总量在数十量级** —— 不构成实际内存风险。

> **与 [05 文档](./05-监控检测原理与流程.md) 的内存监控对照**：
> 这是一个「理论上无界、实际上有界」的容器，
> 属于**可接受但未加保护**的设计。

---

## 4. Kotlin → C++ 的手工字符串映射

### 4.1 13 个 marker 的 `if-else` 链

```cpp
// packages/react-native/ReactAndroid/src/main/jni/react/jni/JReactMarker.cpp:108-111
  // TODO: refactor this to a bidirectional map along with
  // logPerfMarkerWithInstanceKey
  if (markerNameStr == "APP_STARTUP_START") {
```

**13 个 `if/else if` 硬编码字符串比较**，无 `else`、无 `default`、无 `switch`。

**Kotlin 侧的 13 个 `hasMatchingNameMarker=true` 与 C++ 侧的 13 个字符串
完全一一对应**（实测）：

| # | Kotlin 常量（`true`） | C++ `ReactMarker::` 目标 | 命名是否一致 |
| --- | --- | --- | --- |
| 1 | `APP_STARTUP_START` | `APP_STARTUP_START` | ✅ |
| 2 | `APP_STARTUP_END` | **`APP_STARTUP_STOP`** | ❌ END→STOP |
| 3 | `INIT_REACT_RUNTIME_START` | `INIT_REACT_RUNTIME_START` | ✅ |
| 4 | `INIT_REACT_RUNTIME_END` | **`INIT_REACT_RUNTIME_STOP`** | ❌ END→STOP |
| 5 | `RUN_JS_BUNDLE_START` | `RUN_JS_BUNDLE_START` | ✅ |
| 6 | `RUN_JS_BUNDLE_END` | **`RUN_JS_BUNDLE_STOP`** | ❌ END→STOP |
| 7 | `CREATE_REACT_CONTEXT_END` | **`CREATE_REACT_CONTEXT_STOP`** | ❌ END→STOP |
| 8 | `loadApplicationScript_startStringConvert` | **`JS_BUNDLE_STRING_CONVERT_START`** | ❌ 完全不同的名字 |
| 9 | `loadApplicationScript_endStringConvert` | **`JS_BUNDLE_STRING_CONVERT_STOP`** | ❌ 完全不同的名字 |
| 10 | `NATIVE_MODULE_SETUP_START` | `NATIVE_MODULE_SETUP_START` | ✅ |
| 11 | `NATIVE_MODULE_SETUP_END` | **`NATIVE_MODULE_SETUP_STOP`** | ❌ END→STOP |
| 12 | `REGISTER_JS_SEGMENT_START` | `REGISTER_JS_SEGMENT_START` | ✅ |
| 13 | `REGISTER_JS_SEGMENT_STOP` | `REGISTER_JS_SEGMENT_STOP` | ✅ |

**两侧的对应关系是精确的 1:1**，但**命名规则不一致**：

| 命名差异 | 数量 |
| --- | --- |
| 名字完全相同 | 6 |
| Kotlin `_END` → C++ `_STOP` | 5 |
| Kotlin 与 C++ 名字完全不同 | 2 |

> **「13 对 13，零遗漏、零多余」是本手册第一个可机器校验的跨语言同步断言**
> （见 §5 的 C320）。
>
> 这与 27 文档的 `RCTTiming` ↔ `JSTimers.js` 帧常量属同类正面样本。

### 4.2 【风险】不匹配时静默丢弃

**`if-else` 链没有 `else` 分支。** 若某 marker 名字写错（或将来新增未同步），
`nativeLogMarker` **什么都不做** —— 无日志、无断言、无异常。

**这是纯字符串比较，编译器无法检查。**

**最可能的出错场景**：新增一个 `hasMatchingNameMarker = true` 的 marker，
只改 Kotlin 侧不改 C++ 侧 → **该 marker 永远到不了 native tracing**，
且**没有任何症状**。

> **对比 30 文档 §5.4**（`RCTEventEmitter` 的断言文案给出根因）、
> 39 文档 `:309`（注释解释取舍）——
> **这里是「该有防护而没有」的第四例**。
> TODO 注释承认了这一点（`refactor this to a bidirectional map`），
> 但**在重构前，缺一层断言的成本很低**（在链尾加一个 `else` 打日志即可）。

### 4.3 注释里的反模式承认

`:108-109`：

```cpp
// packages/react-native/ReactAndroid/src/main/jni/react/jni/JReactMarker.cpp:108-109
  // TODO: refactor this to a bidirectional map along with
  // logPerfMarkerWithInstanceKey
```

**注释明说当前实现是「单向的 if-else 链」，应重构为「双向 map」**。

这与 [33 文档](./33-Fabric组件层TextInput事件计数.md) 的
`T207198334`、[34 文档](./34-Fabric组件层Modal与VirtualView.md) 的 `T202601695`、
39 文档的 `T65905574` 同属**「带工单号的已知改进项」**。

**四个文档、四个不同的工单号格式**（`T58941612`、`T202601695`、`T207198334`、`T65905574`）
—— **RN 内部用同一个 `T` 前缀 + 数字，但没有统一登记处**，
只能靠 `grep 'T[0-9]\{8\}'` 找全。这是本文附带的一条可执行建议。

---

## 5. 可机器校验的断言

本文的核心数据可用以下方式**持续校验**（源码变化即失败）：

| 断言 | 期望 |
| --- | --- |
| `ReactMarkerConstants` 枚举项数 | 114 |
| 其中 `hasMatchingNameMarker = true` | 13 |
| 生产代码零引用的 marker 数 | 38 |
| 零引用中 `true` 的数量 | **0** |
| C++ 侧 `markerNameStr == "..."` 的数量 | 13 |
| 两侧 `true` 集合与 C++ 字符串集合**完全相等** | ✅ |
| 「两端都死」的区间对数 | 16 |

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| EE-1 | **38/114 个 marker（33.3%）在生产代码零引用**，其中 16 对是完整失效的区间 | `bridge/ReactMarkerConstants.kt` | 打点清单与实际脱节；**无法从枚举本身区分「退役」与「未实现」** |
| EE-2 | **Kotlin↔C++ 的 13 个映射是无 `else` 的 `if-else` 字符串链**，不匹配时静默丢弃 | `jni/react/jni/JReactMarker.cpp:110-150` | 新增 marker 漏改一侧即**永久静默失效**，无任何症状 |
| EE-3 | 两侧命名规则不一致（5 处 END→STOP、2 处完全不同） | 同上 | 人工对照易错；是 EE-2 的放大因素 |
| EE-4 | **队列回放时「先发当前、后发缓存」**，到达顺序与时间顺序相反 | `bridge/ReactMarker.kt:167-174` | **隐含契约：下游必须按时间戳排序**；无注释说明 |
| EE-5 | `nativeReactMarkerQueue` 无容量上限 | `bridge/ReactMarker.kt:23` | 理论无界；**实际有界**（只有 13 个 marker 入队且集中在启动期） |
| EE-6 | `logMarker` 无条件先调 `logFabricMarker`，Fabric 监听器会收到非 Fabric marker | `bridge/ReactMarker.kt:149` | 每次打点一次多余调用；语义上需监听者自行过滤 |
| EE-7 | 枚举的最大一段（~68 项）无分区注释，另两段有 | `bridge/ReactMarkerConstants.kt:14-93` | 与 39 文档 DD-2 同类：**最大的段落最缺文档** |
| EE-8 | `addListener` 去重而 `removeListener` 不去重 | `bridge/ReactMarker.kt:37-50` | 重复 add 不会双计，但重复 remove 只删一个 —— **不对称但无害** |

### EE-1 与 EE-2 的叠加风险

**最坏情况**：某开发者新增一个 native marker（如 `FOO_START`/`FOO_END`），
在 Kotlin 枚举里加了 `(true)` 标志并在业务代码打点，
但**忘记改 C++ 侧**。

| 现象 | 结果 |
| --- | --- |
| Kotlin 侧打点 | ✅ 正常，`logFabricMarker` 与 `listeners` 都能收到 |
| 通用监听器（如 `ReactInstanceEventListener`） | ✅ 正常 |
| **native tracing（`ReactMarker::logMarkerDone`）** | ❌ **静默丢弃** |
| 日志/告警 | ❌ **无** |
| 症状 | native 侧 trace 时间线**缺一段**，但无崩溃、无警告 |

**这是「监控盲区」而非「功能缺陷」** ——
恰好落在本手册关注的「启动速度变慢检测」主题上：
**若缺失的 marker 恰好是耗时区间的某一端，启动耗时会算错而不是算不出**。

---

## 7. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 06 文档 P2-3：iOS `RCTPLTag` 22 个中 12 个零打点（54.5%） | **补上 Android 对应数据**：114 个中 38 个零打点（**33.3%**）；并给出「两端都死 / 只死一端」的细化分类（§2.4） |
| 05 文档：启动速度检测原理 | **补上 Android 的打点载体与实现细节**：枚举 + 监听器 + JNI 队列（§2、§3、§4） |
| 25 文档：iOS 启动性能标签 | **对照**：iOS 用 `RCTPLTag` 宏，Android 用枚举 —— **Android 侧可静态穷举，iOS 侧不能** |
| 27 文档：`RCTTiming` ↔ `JSTimers.js` 帧常量双向同步 | **新增第二个跨语言同步样本**（§4.1）：13 个 native marker 精确 1:1；但**同步方式是手工 if-else 字符串链**（EE-2） |
| 30 文档 §5.4：断言文案给出根因 | **对照**：EE-2 是「该有防护而没有」的反例 |
| 33/34/39 文档：带工单号的 TODO | **汇总**：四篇文档四个工单号，**无统一登记处**（§4.3） |
| 39 文档 DD-2：四步解析只有一步无注释 | **同类**：枚举最大段无分区注释（EE-7） |
| 39 文档 §3.2：TurboModule 层的注释质量高于 legacy 层 | **扩展**：**Android 侧的注释质量也高于 iOS legacy 侧**（`logMarker` 的 List vs Set 理由、TODO 的决策依据） |

---

## 8. 统计脚本（可复用）

本文的数据由以下脚本得出（可直接复制运行）：

~~~bash
# 统计 ReactMarkerConstants 的零引用项
cd <repo-root>
python3 - <<'PYEOF'
import io, re, os
root = os.getcwd()
src = 'packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/ReactMarkerConstants.kt'
t = io.open(os.path.join(root, src), encoding='utf-8').read()
body = t[t.index('{', t.index('public enum class ReactMarkerConstants')):]
entries = re.findall(r'^ {2}([A-Za-z_][A-Za-z0-9_]*)(\(true\))?,?\s*$', body, re.M)
entries = [(n, f == '(true)') for n, f in entries]

exts = {'.kt', '.java', '.cpp', '.h'}
cache = {}
for base in ['packages/react-native', 'packages/rn-tester', 'private']:
    for dp, dn, fn in os.walk(os.path.join(root, base)):
        if '__tests__' in dp or '/tests/' in dp or '__mocks__' in dp:
            continue
        for f in fn:
            if os.path.splitext(f)[1] not in exts:
                continue
            rel = os.path.relpath(os.path.join(dp, f), root)
            if rel.endswith('ReactMarkerConstants.kt') or rel.endswith('ReactMarker.kt'):
                continue
            try:
                cache[rel] = io.open(os.path.join(dp, f), encoding='utf-8', errors='ignore').read()
            except Exception:
                pass

zero = [n for n, flag in entries
        if not any(re.search(r'\b' + n + r'\b', c) for c in cache.values())]
print('总数 %d / 零引用 %d (%.1f%%)' % (len(entries), len(zero), len(zero) / len(entries) * 100))
for n in zero:
    print('  ' + n)
PYEOF
~~~

**建议**：把这段（或其 Node 等价物）接进 CI，
作为「打点清单与实际使用率」的定期巡检。
