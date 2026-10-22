---
id: 48
title: "Android 指针事件分发：801 行的命中路径管理、16 位合并键回绕与 0.1px 阈值"
topic: PL.android
symptoms: [gesture]
platforms: [android]
architecture: [cross]
layer: T3
symbols: ["JSPointerDispatcher", "PointerEvents"]
claims: [NN-1, NN-2, NN-3, NN-4, NN-5, NN-6, NN-7]
---
# 48 · Android 指针事件分发：801 行的命中路径管理、16 位合并键回绕与 0.1px 阈值

> **模块**：C2 ·
> `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt`（801）、
> `uimanager/events/PointerEvent.kt`、
> `uimanager/PointerEvents.kt`
>
> **基线**：react-native @ `9b131e42` · Android 侧 · **新旧架构共用**
> （Paper 与 Fabric 走同一条 `JSPointerDispatcher`）
>
> **前置**：[03 文档](./03-核心技术原理.md) §事件系统记录 JS 侧合成事件与优先级；
> [47 文档](./47-Android无障碍委托层.md) 记录同层的无障碍委托。
>
> 本文记录两条**可用算术精确推导**的问题：
> ① **合并键的 16 位截断使第 65535 次之后的按键与「未设置」哨兵值撞值**；
> ② **companion object 里的两个可变静态对象被当作返回值交出**。
> 另有 0.1px 的 `onMove` 过滤阈值与一个含 4 个 `-1` 哨兵值的常量组。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt` | 801 | 命中路径、状态机、事件构造 |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/events/PointerEvent.kt` | — | `dispatchModern` 与 `PointerEventState` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/PointerEvents.kt` | 49 | `PointerEvents` 枚举 + 3 个判定函数 |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/events/Event.kt` | — | `:190` `dispatchModern` 基类空实现 |

---

## 2. 类的形态：单个 rootViewGroup 驱动整棵树

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt:31-41
public class JSPointerDispatcher(private val rootViewGroup: ViewGroup) {
  ...
  private val currentlyDownPointerIdsToHitPath: MutableMap<Int, List<ViewTarget>> = HashMap()
  private val hoveringPointerIds: MutableSet<Int> = HashSet()
```

**构造参数只有一个 `rootViewGroup`** —— 即**一个 root 对应一个 dispatcher 实例**。

**两块状态**：

| 字段 | 类型 | 语义 |
| --- | --- | --- |
| `currentlyDownPointerIdsToHitPath` | `Map<Int, List<ViewTarget>>` | **按下中的指针 → 命中路径** |
| `hoveringPointerIds` | `Set<Int>` | 悬停（hover）中的指针 |

> **`MutableMap<Int, List<ViewTarget>>` 的容量与最大同时按下数成正比** ——
> 实践中手指数 ≤ 10，故不构成内存问题。
> **但 `List<ViewTarget>` 的长度 = 命中路径的 View 层数** ——
> 深树上每个指针的路径是 O(depth) 对象。

---

## 3. 【核心发现 A】合并键的 16 位截断与 `-1` 哨兵撞值

### 3.1 计数与截断的两段代码

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt:165-169
  private fun incrementCoalescingKey() {
    coalescingKey = (coalescingKey + 1) % Int.MAX_VALUE
  }

  private fun getCoalescingKey(): Short = (0xffff and coalescingKey).toShort()
```

**计数器声明**（`:40`）：`private var coalescingKey = 0` —— **`Int`**。

**两段实现的宽度不一致**：

| 环节 | 宽度 | 上限 |
| --- | --- | --- |
| `incrementCoalescingKey()` | **32 位**（`Int`） | `% Int.MAX_VALUE` = **2 147 483 646** |
| `getCoalescingKey()` | **16 位**（`0xffff` 掩码 → `Short`） | **65 535** |

> **32 位的计数器被截成 16 位输出 —— `% Int.MAX_VALUE` 这段模运算对最终值毫无影响。**
> 有效周期是 **65 536** 而不是 2 147 483 647。

### 3.2 撞值的精确算术

`(0xffff and n).toShort()` 在 Kotlin 中把 16 位无符号值按**有符号**解释，因此：

| `n`（Int） | `0xffff and n` | `.toShort()` |
| --- | --- | --- |
| 0 | 0 | 0 |
| 1 | 1 | 1 |
| **65 535** | **65 535** | **−1** |
| 65 536 | 0 | 0 |
| 131 071 | 65 535 | **−1** |

**即 `n ≡ 65 535 (mod 65 536)` 时截断结果恒为 `-1`。**

**首次命中于第 65 535 次 `incrementCoalescingKey()` 之后**（起始值 0）。

**`incrementCoalescingKey()` 有 4 个调用点**，均位于手势状态机的分支内：

| 调用点 | 所在路径 |
| --- | --- |
| `:180` | `onChildEndedNativeGesture`（原生手势结束） |
| `:390` | `handleHitStateDivergence`（命中状态分歧） |
| `:481` | `handleMotionEvent` 内 |
| `:628` | `dispatchCancelEventForTarget`（派发 CANCEL 后） |

### 3.3 撞值的后果：`UNSET_COALESCING_KEY` 也是 `-1`

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/events/PointerEvent.kt:278-291
    val pointersEventData = checkNotNull(pointersEventData)
    val shouldCopy = pointersEventData.size > 1
    for (singleData in pointersEventData) {
      val eventData = if (shouldCopy) singleData.copy() else singleData
      rctEventEmitter.receiveEvent(
          surfaceId,
          viewTag,
          _eventName,
          coalescingKey != UNSET_COALESCING_KEY,
          coalescingKey.toInt(),
          eventData,
          getEventCategory(_eventName),
          timestampMs,
      )
    }
```

**哨兵定义**（`PointerEvent.kt:320`）：

```kotlin
    private const val UNSET_COALESCING_KEY: Short = -1
```

**第 4 个参数即「是否可合并」的布尔标志**：`coalescingKey != UNSET_COALESCING_KEY`。

| 时刻 | `coalescingKey`（`Short`） | `!= UNSET` | 传入的第 5 参数 `coalescingKey.toInt()` |
| --- | --- | --- | --- |
| 从未赋值（默认） | `-1` | **false** | `-1` |
| 第 1–65 534 次 | `0 … 65 534` | true | `0 … 65 534` |
| **第 65 535 次** | **`-1`** | **false** | **`-1`** |
| 第 65 536 次 | `0` | true | `0` |

> **第 65 535 次的那一批事件被当作「没有合并键」处理** ——
> 即 JS 侧收到 `canCoalesce = false` 且 `coalescingKey = -1`，
> **与「事件从未被赋予合并键」完全无法区分。**
>
> **修复成本极低**（把 `UNSET_COALESCING_KEY` 改成某个不可能由
> `0xffff and n` 产生的值，或把掩码宽度从 16 位扩到 32 位），
> **但当前实现是错的。**

### 3.4 触发门槛的适用范围

| 维度 | 条件 |
| --- | --- |
| **平台** | Android 全部 |
| **架构** | 新旧架构共用 |
| **触发点** | `incrementCoalescingKey()` 的 **4 处**调用（`:180`、`:390`、`:481`、`:628`） |
| **门槛** | **同一 root view 上累计 65 535 次该调用** |
| **每次手势 +1 吗** | **不止一次** —— 4 个调用点分布在 UP / CANCEL / 原生手势交接等路径 |

> **不是理论问题**：长生命周期的应用（如电商首页、IM 聊天列表）
> 在用户一天的使用中轻易超过 65 535 次手势。
>
> **触发后的表现**：每 65 536 个手势里，**有 1 个手势的 MOVE 事件批次
> 丢失合并能力** —— 表现为该批次事件在 JS 侧被逐个处理而非合并，
> 滑动时可能看到额外的 `onPointerMove` 调用。

### 3.5 对照 JS 侧的定义

**JS 侧同样有合并键概念**，但宽度不同 —— 这正是跨语言边界的脆弱点：

| 端 | 类型 | 范围 |
| --- | --- | --- |
| Android 原生 | `Short`（**16 位**） | −32 768 … 32 767 |
| JS | `number`（双精度） | 无上限 |

**跨 JNI 传递时被 `toInt()` 提升为 32 位**（`:284`），因此**边界只由 Android 侧决定**。

---

## 4. 【核心发现 B】companion object 里的可变静态对象

### 4.1 两个静态可变字段

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt:687-696
  private companion object {
    private const val UNSELECTED_VIEW_TAG = -1
    private const val UNSET_POINTER_ID = -1
    private const val UNSET_CHILD_VIEW_ID = -1
    private const val ONMOVE_EPSILON = 0.1f
    private const val TAG = "PointerEvents"

    private val rootScreenCoords = intArrayOf(0, 0)
    private val childCoords = Rect(0, 0, 1, 1)
```

**7 个成员里 5 个是 `const`（编译期常量，安全），2 个是 `val` 但持有可变对象**：

| 成员 | 声明 | 可变性 | 共享范围 |
| --- | --- | --- | --- |
| `rootScreenCoords` | `intArrayOf(0, 0)` | **数组内容可写** | **全部实例** |
| `childCoords` | `Rect(0, 0, 1, 1)` | **Rect 可写** | **全部实例** |

**`private companion object` 的成员是 JVM `static`** —— 即**同一 ClassLoader 下所有实例共享**。

### 4.2 `rootScreenCoords` 的用法：只写不存

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt:237-245
  private fun eventCoordsToScreenCoords(eventCoords: FloatArray): FloatArray {
    ...
    rootViewGroup.getLocationOnScreen(rootScreenCoords)
    ...
    screenCoords[0] = eventCoords[0] + rootScreenCoords[0]
    screenCoords[1] = eventCoords[1] + rootScreenCoords[1]
```

**用完立即读出并写进局部 `screenCoords`** —— 无滞留引用。**当前安全。**

### 4.3 `childCoords` 的用法：**被当作返回值交出**

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt:633-644
  // returns child (0, 0) relative to root coordinate system
  private fun getChildOffsetRelativeToRoot(childView: View): Rect {
    childCoords.set(0, 0, 1, 1)
    if (childView.rootView !== rootViewGroup.rootView) {
      // NOTE: if we are here it means the target view has been reparented, so we can't call
      // mRootViewGroup.offsetDescendantRectToMyCoords because an exception will be thrown.
      // We still return (0, 0) to ensure the cancel event is dispatched.
      return childCoords
    }
    rootViewGroup.offsetDescendantRectToMyCoords(childView, childCoords)
    return childCoords
  }
```

**两个分支都 `return childCoords`** —— **返回的是共享静态对象本身，不是副本**。

**注释记录了一个真实的失败场景**：

| 注释要点 | 内容 |
| --- | --- |
| 触发条件 | 目标 View **已被 reparent** |
| 后果 | `offsetDescendantRectToMyCoords` **会抛异常** |
| 应对 | **返回 `(0, 0)` 以保证 CANCEL 事件仍被派发** |

> **注释的判断是对的**：`offsetDescendantRectToMyCoords` 对非后代会抛
> `IllegalArgumentException`。用「返回 (0,0) 兜底」保证事件不丢，
> **这是正确的降级选择**。

**但返回共享对象是隐患**：唯一调用点立即取值，**当前不构成 bug**。

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt:612-616
        // cancel events need to report client coordinates of (0, 0) and offset coordinates relative
        // to the root view
        val childOffset = getChildOffsetRelativeToRoot(targetView)
        val normalizedEventState =
            normalizeToRoot(eventState, childOffset.left.toFloat(), childOffset.top.toFloat())
```

**唯一调用点在下一行就把 `.left/.top` 转成 `Float`** —— 无对象逃逸。

> **诚实结论（区别于 46 文档的「历史承诺」与 §3.4 的「自认边界」）：
> 这是第三类 ——「当前安全但结构脆弱」**。
>
> | 类别 | 含义 | 本例 |
> | --- | --- | --- |
> | 历史承诺 | 注释描述的能力不存在 | 46 文档 `setLocalData` |
> | 自认边界 | 注释承认的已知失效 | 46 文档 `dirty()` 的 TODO |
> | **结构脆弱** | **代码正确但改动一行即引入 bug** | **本例 `childCoords`** |
>
> **任何未来给 `getChildOffsetRelativeToRoot` 增加第二个调用点并持有返回值的改动，
> 都会立刻产生跨手势的坐标污染。**

---

## 5. 四个 `-1` 哨兵常量

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt:688-690
    private const val UNSELECTED_VIEW_TAG = -1
    private const val UNSET_POINTER_ID = -1
    private const val UNSET_CHILD_VIEW_ID = -1
```

**三个 `-1` 哨兵，语义各不相同**：

| 常量 | 哨兵含义 | 与 Android 内置值的关系 |
| --- | --- | --- |
| `UNSELECTED_VIEW_TAG` | 未选中任何 View | **`View.NO_ID` 也是 −1** |
| `UNSET_POINTER_ID` | 无活动指针 | **`MotionEvent.INVALID_POINTER_ID` 也是 −1** |
| `UNSET_CHILD_VIEW_ID` | 无子 View 接管原生手势 | — |

**前两个与 Android 框架常量撞值**：

| Android 常量 | 值 |
| --- | --- |
| `android.view.View.NO_ID` | `-1` |
| `android.view.MotionEvent.INVALID_POINTER_ID` | `-1` |

> **即 RN 的三个私有 `-1` 与框架的两个 `-1` 数值相同** ——
> **一旦某个 `-1` 被误当真实 tag/pointerId 传入框架 API，不会立即抛错。**
>
> **这是「用同一个数值表示不同的无效状态」的典型风险**，
> 与 §3.3 的 `coalescingKey` 撞值属**同一类错误模式**：
> **哨兵值与合法值域重叠。**
>
> **但本仓库在这一点上做对了关键一步**：
> `childHandlingNativeGesture` 的判定带**显式断言**：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt:598-601
    Assertions.assertCondition(
        childHandlingNativeGesture == UNSET_CHILD_VIEW_ID,
        "Expected to not have already sent a cancel for this gesture",
    )
```

**断言消息说明了这条路径的预期稀有度**：只有「子 View 在 UP/CANCEL 才拦截手势」才会重复触发。

---

## 6. `onMove` 的 0.1px 过滤阈值

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/JSPointerDispatcher.kt:792-799
    private fun qualifiedMove(
        eventCoordinates: FloatArray,
        lastEventCoordinates: FloatArray,
    ): Boolean {
      return (Math.abs(lastEventCoordinates[0] - eventCoordinates[0]) > ONMOVE_EPSILON ||
          Math.abs(lastEventCoordinates[1] - eventCoordinates[1]) > ONMOVE_EPSILON)
    }
```

**常量**（`:691`）：`private const val ONMOVE_EPSILON = 0.1f`

**语义**：`qualifiedMove` 返回 **`true` 表示「位移不显著，应丢弃」`** ——
因为判据是 `> epsilon`，即**超过**阈值才算「合格」。

> **命名与语义相反**：`qualifiedMove` 返回 `true` 表示**不合格**（位移太小）。
> **阅读时极易误解。**

**阈值本身**：

| 项 | 值 |
| --- | --- |
| 阈值 | **`0.1f`**（0.1 像素） |
| 比较方式 | **严格大于**（`>`），故恰好 `0.1f` **不算**不显著 |
| 作用轴 | X 与 Y **任一**轴超过即视为「不显著」 |

> **与 §3 的 16 位截断对照**：
> 这里作者明确选了 `0.1f` 这个「亚像素但有意义」的值，
> **说明对浮点阈值的取舍是有意识的**；
> **而 §3.3 的 `-1` 撞值则完全没有对应的意识** ——
> **同一文件内两种数值严谨度并存。**

---

## 7. `dispatchModern` 的 4 层早退与对象池保护

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/events/PointerEvent.kt:255-273
  override fun dispatchModern(rctEventEmitter: RCTModernEventEmitter) {
    if (motionEvent == null) {
      logSoftException(
          TAG,
          IllegalStateException(
              "Cannot dispatch a Pointer that has no MotionEvent; the PointerEvent has been recycled",
          ),
      )
      return
    }

    if (pointersEventData == null) {
      pointersEventData = createPointersEventData()
    }

    if (pointersEventData == null) {
      // No relevant MotionEvent to dispatch
      return
    }
```

**基类 `Event.kt:190` 是 `public open fun dispatchModern(rctEventEmitter: RCTModernEventEmitter)`** ——
`PointerEvent` 覆盖它。基类实现为空，**只有 `PointerEvent` 一处真正派发**。

**三层守卫**：

| # | 条件 | 处理 | 是否上报 |
| --- | --- | --- | --- |
| ① | `motionEvent == null` | **`logSoftException`** + 返回 | ✅ **软异常上报** |
| ② | `createPointersEventData()` 返回 `null` | 直接返回 | ❌ |
| ③ | 兜底再判一次 `null` | 直接返回 | ❌ |

> **① 是对象池误用的防御** —— 异常消息
> `"Cannot dispatch a Pointer that has no MotionEvent; the PointerEvent has been recycled"`
> **明确指出 `PointerEvent` 被复用（recycled）**。
>
> **这与 42 文档记录的 Android View 回收池是同一套「复用即必须重置」的思路**，
> **但这里用的是软异常而非崩溃** ——
> **对照 44 文档 §2 的 `ReactNoCrashSoftException`，同一策略。**

**② 与 ③ 重复判 `null`**：② 之后已经赋值，再判一次是**防御性冗余** ——
若 `createPointersEventData()` 返回 `null` 则 `pointersEventData` 仍为 `null`，③ 命中。
**逻辑上 ② 里的判空已足够**，③ 是重复。

---

## 8. 状态机的四条终止路径

`JSPointerDispatcher` 的 `onUp`（`:81`）与 `dispatchCancelEventForTarget`（`:588`）是仅有的两条终止路径，
另有 `onChildEndedNativeGesture`（`:76`）作为原生手势的收尾。

**`dispatchCancelEventForTarget` 的收尾动作**（`:629-632`）：

```kotlin
      incrementCoalescingKey()
      primaryPointerId = UNSET_POINTER_ID
```

**两行收尾**：递增合并键 + 清空活动指针。

**`onUp` 的收尾**（`:159-162`）多一步：

```kotlin
      primaryPointerId = UNSET_POINTER_ID
    }
    hoveringPointerIds.remove(activePointerId)
  }
```

**从 `hoveringPointerIds` 移除指针** —— 这是 `hoveringPointerIds` 的**唯一**写入侧的对称操作。

> **`hoveringPointerIds` 的完整生命周期（5 处操作，全部实测）**：
>
> | 操作 | 行号 | 作用 |
> | --- | --- | --- |
> | `contains` | `:111`、`:181` | 读 —— 判断是否支持 hover |
> | **`add`** | `:324` | 写入 —— hover 指针进入 |
> | **`remove`** | `:162` | 写入 —— 指针抬起 |
> | **`retainAll`** | `:423` | 批量清理 —— 注释：`Clean up any stale pointerIds` |
> | 拷贝 | `:289`、`:683` | **`:289` 的行内注释说明为何要拷贝** |
>
> **`:289` 的注释是本文件少有的「解释为什么」**：
> `hoveringPointerIds, // Creates a copy of hovering pointer ids, as they may be updated`
>
> **即状态快照必须拷贝，因为集合随后会被 `retainAll` 改动** ——
> **这是「可变状态跨对象传递」的正确处理方式**，
> **与 §4 的 `childCoords` 静态共享形成鲜明对照**：
> **同一文件内，一处知道要拷贝，一处直接交出静态对象。**
>
> **`retainAll` 的存在排除了「指针 id 滞留」的可能** ——
> 即使有路径漏了 `remove`，`retainAll` 也会在下次 `handleMotionEvent` 时清掉。

---

## 9. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| NN-1 | **【核心 A】`getCoalescingKey()` 的 16 位掩码使 `n ≡ 65535 (mod 65536)` 时返回 `-1`，与 `UNSET_COALESCING_KEY` 撞值** | `JSPointerDispatcher.kt:169`；`events/PointerEvent.kt:320`、`:283` | **第 65 535 次手势的 MOVE 批次被判为「无合并键」**（`canCoalesce=false` + `key=-1`），与真正的「未设置」不可区分 |
| NN-2 | **`incrementCoalescingKey()` 用 `% Int.MAX_VALUE`（32 位）而 `getCoalescingKey()` 掩到 16 位** —— 前者的模运算对输出无影响 | `JSPointerDispatcher.kt:165-169` | **有效周期 65 536，而非 2 147 483 647**；代码暗示的范围与实际不符 |
| NN-3 | **【核心 B】`childCoords` 是 companion object 里的可变静态 `Rect`，被 `getChildOffsetRelativeToRoot` 当返回值交出** | `JSPointerDispatcher.kt:695`、`:634-644` | **当前唯一调用点立即取值，安全**；但任何新增「持有返回值」的调用点会立刻造成跨手势坐标污染 |
| NN-4 | 三个私有 `-1` 哨兵中两个与框架常量撞值（`View.NO_ID`、`MotionEvent.INVALID_POINTER_ID` 同为 −1） | `JSPointerDispatcher.kt:688-690` | 误传时**不会立即抛错**；`dispatchCancelEventForTarget` 有显式断言防护（做对了） |
| NN-5 | `qualifiedMove` 返回 `true` 表示「位移不显著、应丢弃」，**命名与语义相反** | `JSPointerDispatcher.kt:792-799` | 阅读时极易误解 |
| NN-6 | `dispatchModern` 中②③两层判空重复（`createPointersEventData()` 返回 null 后再判一次） | `events/PointerEvent.kt:265-272` | 冗余但无害 |
| NN-7 | `ONMOVE_EPSILON = 0.1f` 的比较用严格 `>`，恰好 0.1px 的位移**不被过滤** | `JSPointerDispatcher.kt:691`、`:797-798` | 边界值行为与直觉相差一根头发丝 |

### NN-1 / NN-2 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | Android 全部 |
| **架构** | **新旧架构共用** —— `JSPointerDispatcher` 不区分 Paper/Fabric |
| **作用对象** | 仅 **modern（Fabric）事件分发路径** —— `dispatchModern` 是 `dispatchModern` 接口的实现 |
| **触发门槛** | **同一 root view 累计 65 535 次手势结束** |
| **是否可观测** | 该批 MOVE 事件在 JS 侧**不合并**（性能损失），**不崩溃、不丢事件** |

**即 NN-1 是性能与可观测性问题，不是正确性问题**（事件本身仍被送达）。

### NN-3 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | Android 全部 |
| **架构** | 新旧架构共用 |
| **触发条件** | **子 View 已在 UP/CANCEL 时才接管原生手势**（注释自认「不常发生」） |
| **当前是否触发 bug** | **否** —— 唯一调用点立即取值 |
| **风险** | **未来修改**：新增调用点并持有 `Rect` 引用 |

---

## 10. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 03 文档：事件系统的合成事件与优先级 | **补上原生侧的前半段**：命中路径管理与 coalescing key 的产生（§3） |
| 44 文档 §2：`ReactNoCrashSoftException` 的软异常分流 | **同型**：`dispatchModern` 对「对象池误用」用 `logSoftException` 而非崩溃（§7） |
| 42 文档：Android View 回收池「复用必须重置」 | **同型**：`PointerEvent` 是对象池，`motionEvent == null` 即「已被回收」（§7） |
| 45 文档：`prepareToRecycleView` 的 3 处 API 版本门控 | **对照**：本文件的 `0.1f` 阈值与 16 位掩码**没有任何门控或断言** |
| 46 文档：`isYogaLeafNode` 处「主动失败」vs 45 文档「降级」两种策略并存 | **新增第三类策略**：`Assertions.assertCondition` **只在「不该发生」的路径上**（§5），主路径全部静默 |
| 47 文档 MM-5：`Role` 枚举靠序号与 C++ 同步，无校验 | **同型但方向相反**：`coalescingKey` 是**运行时数值**撞上**哨兵值**（NN-1），而非声明期错位 |
| 47 文档 §10 MM-3：`setState` 无 `else` 导致静默忽略 | **对照**：本文件在「不该发生」处**有**断言（§5）—— **断言用在对的地方** |