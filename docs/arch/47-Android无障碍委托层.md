---
id: 47
title: "Android 无障碍委托层：1021 行的基类、5 个空实现与一个 O(n) 递归描述器"
topic: PL.android
symptoms: [a11y]
platforms: [android]
architecture: [cross]
layer: T3
symbols: ["AccessibilityDelegate", "ReactAccessibilityDelegate"]
claims: [MM-1, MM-2, MM-3, MM-4, MM-5, MM-6, MM-7, MM-8]
---
# 47 · Android 无障碍委托层：1021 行的基类、5 个空实现与一个 O(n) 递归描述器

> **模块**：C2 ·
> `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt`（1021）、
> `views/text/ReactTextViewAccessibilityDelegate.kt`（366）、
> `views/text/ReactTextView.java:657-669`
>
> **基线**：react-native @ `9b131e42` · Android 侧 · **新旧架构共用**
>
> **前置**：[45 文档](./45-Android-ViewManager属性缓存与回收契约.md) §2.2 记录
> `BaseViewManager.prepareToRecycleView` 清空 **8 个无障碍 tag**（无障碍泄漏防护）；
> [46 文档](./46-Android-ShadowNode脏标记与废弃通路.md) 记录 legacy 层被掏空的 8 个空壳成员。
>
> 本文记录：**基类 `ReactAccessibilityDelegate` 的 5 个
> `ExploreByTouchHelper` 虚视图 API 全部是空实现**（基类不提供触摸探索），
> 以及 **`getTalkbackDescription` 的递归对子 ViewGroup 逐个
> `AccessibilityNodeInfoCompat.obtain()`** 的成本结构。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt` | 1021 | **基类** + 静态工具 |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextViewAccessibilityDelegate.kt` | 366 | **唯一子类**，真实实现虚视图 |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextView.java` | 727 | `:657-669` 转发 `dispatchHoverEvent` |

---

## 2. 类结构与「继承但不用」

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:44-69
public open class ReactAccessibilityDelegate( // The View this delegate is attached to
    protected val hostView: View,
    originalFocus: Boolean,
    originalImportantForAccessibility: Int,
) : ExploreByTouchHelper(hostView) {
  @Suppress("DEPRECATION") // TODO: Replace with handler tied to host view's context
  private val accessibilityEventHandler: Handler =
      object : Handler() {
        override fun handleMessage(msg: Message) {
          val host = msg.obj as View?
          host?.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_SELECTED)
        }
      }
  private val accessibilityActionsMap = HashMap<Int, String?>()
  private var accessibilityLabelledBy: View? = null

  init {
    // We need to reset these two properties, as ExploreByTouchHelper sets focusable to "true" and
    // importantForAccessibility to "Yes" (if it is Auto). If we don't reset these it would force
    // every element that has this delegate attached to be focusable, and not allow for
    // announcement coalescing.
    hostView.isFocusable = originalFocus
    hostView.importantForAccessibility = originalImportantForAccessibility
  }
```

**`init` 块的存在理由完整写在注释里**（第一档注释：现象 + 原因 + 后果）：

| 项 | 值 |
| --- | --- |
| `ExploreByTouchHelper` 副作用 1 | 把 `focusable` 设为 `true` |
| `ExploreByTouchHelper` 副作用 2 | 把 `importantForAccessibility` 设为 `Yes`（若原为 `Auto`） |
| 不复位的后果 | **每个挂了此 delegate 的元素都被强制可聚焦** |
| 第二个后果 | **失去 announcement coalescing（播报合并）** |

> **这就是「继承一个类，就必须撤销它的副作用」的完整实例** ——
> 与 46 文档 §8 的 `setIsLayoutOnly` 三条前置断言同属「继承/组合的隐含代价」，
> **但此处做对了**：把两个字段作为构造参数传入并存回。
>
> **注释还解释了第二个后果（announcement coalescing）** ——
> 这不是随手写的，是知道 TalkBack 行为后刻意处理的。

**`@Suppress("DEPRECATION")` 的自陈债务**：

```kotlin
      @Suppress("DEPRECATION") // TODO: Replace with handler tied to host view's context
```

**无参 `Handler()` 构造器已废弃**（需 Looper）。注释给出的修法是
「换成绑定到 host view context 的 handler」—— **自陈未做**。

---

## 3. 【核心发现 A】5 个虚视图 API 在基类全是空实现

### 3.1 逐个核实

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:279-301
  override fun getVirtualViewAt(x: Float, y: Float): Int {
    return INVALID_ID
  }

  override fun getVisibleVirtualViews(virtualViewIds: MutableList<Int>): Unit = Unit

  override fun onPopulateNodeForVirtualView(virtualViewId: Int, node: AccessibilityNodeInfoCompat) {
    node.contentDescription = ""
    @Suppress("DEPRECATION") // TODO: Remove this
    node.setBoundsInParent(Rect(0, 0, 1, 1))
  }

  override fun onPerformActionForVirtualView(
      virtualViewId: Int,
      action: Int,
      arguments: Bundle?,
  ): Boolean {
    return false
  }

  override fun getAccessibilityNodeProvider(host: View): AccessibilityNodeProviderCompat? {
    return null
  }
```

| # | API | 基类实现 | 实质 |
| --- | --- | --- | --- |
| ① | `getVirtualViewAt(x, y)` | **`return INVALID_ID`** | **命中测试恒失败** |
| ② | `getVisibleVirtualViews(list)` | **`= Unit`** | **不填任何虚拟视图** |
| ③ | `onPopulateNodeForVirtualView(id, node)` | `contentDescription = ""` + `setBoundsInParent(Rect(0,0,1,1))` | **1×1 像素的空白节点** |
| ④ | `onPerformActionForVirtualView(...)` | **`return false`** | **拒绝一切动作** |
| ⑤ | `getAccessibilityNodeProvider(host)` | **`return null`** | **不提供节点提供者** |

### 3.2 这 5 个方法在 RN 主代码无任何其他调用方

| API | 主代码调用方（排除本文件） |
| --- | --- |
| `getVirtualViewAt` | **0** |
| `getVisibleVirtualViews` | **0** |
| `onPopulateNodeForVirtualView` | **0** |
| `onPerformActionForVirtualView` | **0** |
| `getAccessibilityNodeProvider` | **0** |

> **这些是 `ExploreByTouchHelper` 的抽象方法** —— **必须 override 才能实例化**。
> RN 全部给了「拒绝服务」的实现。

### 3.3 唯一的转发点与它的短路条件

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextView.java:657-669
  protected boolean dispatchHoverEvent(MotionEvent event) {
    ...
      if (delegate instanceof ExploreByTouchHelper) {
        return ((ExploreByTouchHelper) delegate).dispatchHoverEvent(event)
            || super.dispatchHoverEvent(event);
      }
    ...
    return super.dispatchHoverEvent(event);
  }
```

**这是全仓库唯一把 `dispatchHoverEvent` 交给 `ExploreByTouchHelper` 的地方**
（另有一处 `PreparedLayoutTextView.kt:407` 直接透传 `super`）。

**两层短路**：

| # | 条件 | 结果 |
| --- | --- | --- |
| ① | delegate **不是** `ExploreByTouchHelper` 实例 | 直接 `super.dispatchHoverEvent` |
| ② | 是，但 `dispatchHoverEvent` 返回 `false` | 落到 `super.dispatchHoverEvent` |

**① 对绝大多数 RN View 成立** —— 因为挂的是基类 `ReactAccessibilityDelegate`，
而基类确实**是** `ExploreByTouchHelper` 子类（§2），
所以 ① 成立但 ② 会命中。

> **结论（限定适用范围）**：
>
> | 场景 | 触摸探索（TalkBack 手指滑动朗读） |
> | --- | --- |
> | **通用 RN View（挂基类 delegate）** | **不可用** —— `getVirtualViewAt` 恒返回 `INVALID_ID`，`getAccessibilityNodeProvider` 恒 `null` |
> | **`ReactTextView`（挂 `ReactTextViewAccessibilityDelegate`）** | **可用** —— 366 行子类真实实现了 8 个 override |
>
> **即「触摸探索」这个 Android 无障碍核心能力，RN 只在 Text 组件上实现。**

### 3.4 唯一子类 `ReactTextViewAccessibilityDelegate` 的 8 个 override

**366 行，8 个 override**：

| override | 行号 | 说明 |
| --- | --- | --- |
| `onVirtualViewKeyboardFocusChanged` | `:74` | 虚拟视图键盘焦点变化 |
| `onPerformActionForVirtualView` | `:96` | **真实实现**（基类恒 false） |
| `getVisibleVirtualViews` | `:117` | **真实实现**（基类 `= Unit`） |
| `getVirtualViewAt` | `:125` | **真实实现**（基类 `INVALID_ID`） |
| `onInitializeAccessibilityNodeInfo` | `:187` | 叠加基类之上 |
| `onPopulateNodeForVirtualView` | `:197` | **真实实现**（基类 1×1 空白） |
| `getAccessibilityNodeProvider` | `:279` | **真实实现**（基类 `null`） |

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextViewAccessibilityDelegate.kt:280-284
    // no virtual children will fall back to using ExploreByTouchHelper's onPopulateNodeForHost
```

**这条注释解释了子类的设计意图**：
「没有虚拟子节点时回落到 `onPopulateNodeForHost`」——
即子类**动态决定**是否有虚拟子节点（无则退化为普通节点）。

> **这是基类与子类职责划分的正确形态**：
> 基类提供「不支持」的默认（诚实返回 `null`/`false`），
> 子类按需开启能力。**问题不在设计，而在覆盖面**（只有 Text 一处）。

---

## 4. delegate 的安装：7 个 tag 任一非空才装，且不替换

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:588-610
    public fun setDelegate(
        view: View,
        originalFocus: Boolean,
        originalImportantForAccessibility: Int,
    ) {
      // if a view already has an accessibility delegate, replacing it could cause
      // problems, so leave it alone.
      if (
          !ViewCompat.hasAccessibilityDelegate(view) &&
              (view.getTag(R.id.accessibility_role) != null ||
                  view.getTag(R.id.accessibility_state) != null ||
                  view.getTag(R.id.accessibility_actions) != null ||
                  view.getTag(R.id.react_test_id) != null ||
                  view.getTag(R.id.accessibility_collection_item) != null ||
                  view.getTag(R.id.accessibility_links) != null ||
                  view.getTag(R.id.role) != null)
      ) {
        ViewCompat.setAccessibilityDelegate(
            view,
            ReactAccessibilityDelegate(view, originalFocus, originalImportantForAccessibility),
        )
      }
    }
```

**安装条件是 8 项合取**：

| # | 条件 | 语义 |
| --- | --- | --- |
| ① | `!ViewCompat.hasAccessibilityDelegate(view)` | **已有 delegate 则跳过** |
| ②–⑧ | 7 个 tag 任一非空 | 有无障碍相关 prop |

**7 个 tag**：

| # | tag | 对应 prop |
| --- | --- | --- |
| 1 | `R.id.accessibility_role` | `accessibilityRole` |
| 2 | `R.id.accessibility_state` | `accessibilityState` |
| 3 | `R.id.accessibility_actions` | `accessibilityActions` |
| 4 | `R.id.react_test_id` | `testID` |
| 5 | `R.id.accessibility_collection_item` | `accessibilityCollectionItem` |
| 6 | `R.id.accessibility_links` | `accessibilityLinks` |
| 7 | `R.id.role` | **`role`**（新命名） |

**注释解释了条件 ①**：`"if a view already has an accessibility delegate, replacing it could cause problems, so leave it alone."`

> **第 7 项 `R.id.role` 与第 1 项 `R.id.accessibility_role` 并存** ——
> **同名概念的两个 tag ID**。这是 API 迁移期的双写。
>
> **两者都是活跃被写入的 tag**：
>
> | tag | 写入处 | 清零处（`prepareToRecycleView`） |
> | --- | --- | --- |
> | `R.id.accessibility_role` | `BaseViewManager.java:348` | ✅ `:86` |
> | `R.id.role` | `BaseViewManager.java:499` | ❌ **无** |
>
> **即 `role` 是「正常设置但不复位」的 tag** —— 见 §10 MM-2。

### 4.3 `Role` 枚举有 64 项，序号契约无校验

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/BaseViewManager.java:495-500
      view.setTag(R.id.role, null);
    ...
      view.setTag(R.id.role, Role.fromValue(role));
```

**`R.id.role` 的 setter 存在且被使用** —— 与 `accessibility_role`（`:346`/`:348`）完全对称。

> **两条路径的 tag ID 不同但能力对称**；
> **唯独回收重置只覆盖了旧的一条**（`:86` 有 `accessibility_role`，无 `role`）。

### 4.1 `resetDelegate` 是无条件替换

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:612-624
    // Explicitly re-set the delegate, even if one has already been set.
    @JvmStatic
    public fun resetDelegate(
        view: View,
        originalFocus: Boolean,
        originalImportantForAccessibility: Int,
    ) {
      ViewCompat.setAccessibilityDelegate(
          view,
          ReactAccessibilityDelegate(view, originalFocus, originalImportantForAccessibility),
      )
    }
```

**`resetDelegate` 不检查任何 tag，也不检查已有 delegate** —— 注释 `Explicitly` 强调了这与 `setDelegate` 的差别。

| | `setDelegate` | `resetDelegate` |
| --- | --- | --- |
| 检查已有 delegate | ✅ | ❌ |
| 检查 7 个 tag | ✅ | ❌ |
| 用途 | **首次安装**（props 变更时） | **强制重装**（View 复用后） |

**这一对设计正是 45 文档 §2.2 回收契约的配套** ——
复用后的 View 需要 `resetDelegate` 而非 `setDelegate`（因为 delegate 已存在）。

### 4.2 「super 转发」辅助方法

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:303-307
  // This exists so classes that extend this can properly call super's impl of this method while
  // still being able to override it properly for this class
  protected fun superGetAccessibilityNodeProvider(host: View): AccessibilityNodeProviderCompat? {
    return super.getAccessibilityNodeProvider(host)
  }
```

**注释解释了它存在的理由**：Kotlin 的 `super.xxx()` 在 override 中可用，
但若子类要「既 override 又调用父类实现」，需要显式桥接方法。

> **这是 Kotlin 特有的语法限制导致的设计** ——
> 与 46 文档的 `@Suppress("this-escape")` 同属「语言约束在代码里留下的痕迹」。

---

## 5. 状态写入：只认 3 个 Boolean key

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:626-647
    private fun setState(
        info: AccessibilityNodeInfoCompat,
        accessibilityState: ReadableMap,
    ) {
      val i = accessibilityState.keySetIterator()
      while (i.hasNextKey()) {
        val state = i.nextKey()
        val value = accessibilityState.getDynamic(state)
        if (state == STATE_SELECTED && value.type == ReadableType.Boolean) {
          info.isSelected = value.asBoolean()
        } else if (state == STATE_DISABLED && value.type == ReadableType.Boolean) {
          info.isEnabled = !value.asBoolean()
        } else if (state == STATE_CHECKED && value.type == ReadableType.Boolean) {
          val boolValue = value.asBoolean()
          info.isCheckable = true
          info.isChecked = boolValue
        }
      }
    }
```

**3 个字符串常量**（`:584-586`）：

| 常量 | 值 | 写入的 `AccessibilityNodeInfoCompat` 字段 | 取反 |
| --- | --- | --- | --- |
| `STATE_SELECTED` | `disabled` 之外… `"selected"` | `isSelected` | ❌ 直接赋值 |
| `STATE_DISABLED` | `"disabled"` | `isEnabled` | ✅ **`!value`** |
| `STATE_CHECKED` | `"checked"` | `isCheckable = true` + `isChecked` | ❌ 直接赋值 |

**两处不对称**：

| 不对称点 | 说明 |
| --- | --- |
| **① 取反仅 `disabled`** | JS 侧 `accessibilityState={{disabled: true}}` → `isEnabled = false`。**语义正确**（disabled=true 即不可用），但与另两个不同构 |
| **② 只有 `checked` 设 `isCheckable`** | `selected`/`disabled` **不设**对应的 `isSelectable`/`isEnabled` 之外的标记 |

**其余 key 静默忽略** —— `else if` 链无 `else`，无日志、无警告。

> **这是「静默降级」的典型形态**：
> `accessibilityState` 里写了不认识的 key，开发者与用户都得不到任何提示。
>
> **对照 42 文档记录的 Android 内存侧行为**：
> 那里的失败是「不回收」（安全降级），
> **这里是「不播报」（用户可感知的功能缺失）** ——
> **严重性更高，因为无障碍缺失对用户是不可见的**。

---

## 6. 200ms 播报合并：延迟与原因

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:271-277
  private fun scheduleAccessibilityEventSender(host: View) {
    if (accessibilityEventHandler.hasMessages(SEND_EVENT, host)) {
      accessibilityEventHandler.removeMessages(SEND_EVENT, host)
    }
    val msg = accessibilityEventHandler.obtainMessage(SEND_EVENT, host)
    accessibilityEventHandler.sendMessageDelayed(msg, TIMEOUT_SEND_ACCESSIBILITY_EVENT.toLong())
  }
```

**常量**（`:578-580`）：

| 常量 | 值 |
| --- | --- |
| `TIMEOUT_SEND_ACCESSIBILITY_EVENT` | **`200`**（ms） |
| `SEND_EVENT` | `1` |

**「先撤销再延迟」的合并模式**：

| 步 | 动作 | 效果 |
| --- | --- | --- |
| ① | `hasMessages(SEND_EVENT, host)` → `removeMessages` | 撤销上一次未发的 |
| ② | `obtainMessage(SEND_EVENT, host)` | 以 `host` 为 token |
| ③ | `sendMessageDelayed(msg, 200)` | **推迟 200ms** |

> **用 `host` 作 message token** 是关键 —— 同一 View 的多次状态变更被合并为一次播报。
>
> **`init` 块注释提到的「announcement coalescing」在此实现** ——
> 即：**`ExploreByTouchHelper` 的合并能力与 RN 的 200ms 合并是两套并存机制**，
> 前者被 `init` 撤销（不 focusable），后者由 RN 自己实现。

**最终发送的是 `TYPE_VIEW_SELECTED`**：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:53-58
        override fun handleMessage(msg: Message) {
          val host = msg.obj as View?
          host?.sendAccessibilityEvent(AccessibilityEvent.TYPE_VIEW_SELECTED)
        }
```

> **注意：无论 `scheduleAccessibilityEventSender` 的调用方想表达什么状态变化，
> 发出的事件类型恒为 `TYPE_VIEW_SELECTED`。**
> **即「200ms 合并」+「恒发 selected 事件」—— 表达力被压到只剩一种。**

---

## 7. 【核心发现 B】`getTalkbackDescription` 的递归成本

### 7.1 四条返回路径

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:946-1010
    public fun getTalkbackDescription(
        view: View,
        info: AccessibilityNodeInfoCompat?,
    ): CharSequence? {
      val node =
          if (info == null) createNodeInfoFromView(view)
          else AccessibilityNodeInfoCompat.obtain(info)

      if (node == null) {
        return null
      }

      val contentDescription = node.contentDescription
      val nodeText = node.text

      val hasNodeText = !nodeText.isNullOrEmpty()
      val isEditText = view is EditText

      val talkbackSegments = StringBuilder()

      // EditText's prioritize their own text content over a contentDescription so skip this
      if (!contentDescription.isNullOrEmpty() && (!isEditText || !hasNodeText)) {
        // next add content description
        talkbackSegments.append(contentDescription)
        return talkbackSegments
      }

      // TextView
      if (hasNodeText) {
        talkbackSegments.append(nodeText)
        return talkbackSegments
      }

      // If there are child views and no contentDescription the text of all non-focusable
      // children,
      // comma separated, becomes the description.
      if (view is ViewGroup) {
        val concatChildDescription = StringBuilder()
        val viewGroup = view

        var i = 0
        val count = viewGroup.childCount
        while (i < count) {
          val child = viewGroup.getChildAt(i)

          val childNodeInfo = AccessibilityNodeInfoCompat.obtain()
          @Suppress("DEPRECATION") // TODO: Replace with direct invocation on view
          ViewCompat.onInitializeAccessibilityNodeInfo(child, childNodeInfo)

          if (
              isSpeakingNode(childNodeInfo, child) &&
                  !isAccessibilityFocusable(childNodeInfo, child)
          ) {
            val childNodeDescription = getTalkbackDescription(child, null)
            if (!childNodeDescription.isNullOrEmpty()) {
              concatChildDescription.append(childNodeDescription.toString() + delimiter)
            }
          }
          i++
        }

        return removeFinalDelimiter(concatChildDescription)
      }

      return null
    }
```

**四条返回路径，按优先级**：

| # | 条件 | 返回 | 分配 |
| --- | --- | --- | --- |
| ① | 有 `contentDescription` 且（不是 EditText 或无文本） | 该 description | 1 个 `StringBuilder` |
| ② | 有 `nodeText` | 该文本 | 1 个 `StringBuilder` |
| ③ | 是 `ViewGroup` | **子节点描述的逗号连接** | 2 个 `StringBuilder` + 每子节点 1 个 `AccessibilityNodeInfoCompat` |
| ④ | 其他 | `null` | — |

**路径 ① 的条件最微妙**：`(isEditText || !hasNodeText)` 取反 —— 
即 **EditText 且有文本时，跳过 contentDescription**。

**注释给了理由**：`"EditText's prioritize their own text content over a contentDescription so skip this"`

### 7.2 递归结构与成本

**递归点唯一**（`:999`）：`getTalkbackDescription(child, null)`

**每个子节点的成本**：

| 步 | 操作 | 分配 |
| --- | --- | --- |
| ① | `AccessibilityNodeInfoCompat.obtain()` | **1 个原生 NodeInfo 包装** |
| ② | `ViewCompat.onInitializeAccessibilityNodeInfo(child, childNodeInfo)` | 触发子 View 的完整无障碍初始化 |
| ③ | `isSpeakingNode(...)` + `isAccessibilityFocusable(...)` | — |
| ④ | 递归 `getTalkbackDescription(child, null)` | 子树的全部成本 |
| ⑤ | `concatChildDescription.append(desc + delimiter)` | **字符串拼接**（`delimiter = ", "`，`:580`） |

> **成本是 O(子树节点数)，且每节点 1 次 `AccessibilityNodeInfoCompat.obtain()`。**
>
> **两处放大因素**：
> ① `onInitializeAccessibilityNodeInfo` 会走子 View 自己的 delegate
> —— **若子 View 是 `ReactTextView`，会命中 366 行子类的 `:197` override**；
> ② 递归**没有深度上限，也没有结果缓存**。
>
> **`delimiter = ", "` 且 `delimiterLength` 单独定义为常量**（`:580-581`）——
> `delimiterLength` 只被 `removeFinalDelimiter` 用（见下），
> **即「拼完再截掉最后一个分隔符」的 O(n) 收尾**。

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:1013-1021
    private fun removeFinalDelimiter(builder: StringBuilder): String {
      val end = builder.length
      if (end > 0) {
```

**用 `delimiterLength` 截尾**，而不是 `joinToString` —— 
**说明这条路径早于 Kotlin 集合 API 的普及，或为避免额外分配。**

### 7.3 「非聚焦子节点才播报」的过滤条件

```kotlin
          if (
              isSpeakingNode(childNodeInfo, child) &&
                  !isAccessibilityFocusable(childNodeInfo, child)
          ) {
```

**两个谓词**：

| 谓词 | 行号 | 判据 |
| --- | --- | --- |
| `isSpeakingNode(node, view)` | `:823` | 有文本 / 有 description / 有 range info / 有 state description |
| `isAccessibilityFocusable(node, view)` | `:864` | 可聚焦则**跳过**（用户可自己聚焦到它） |

**语义正确**：父节点只播报「用户无法单独聚焦到」的子节点内容。

> **但注意顺序**：`AccessibilityNodeInfoCompat.obtain()` 与
> `onInitializeAccessibilityNodeInfo` **在谓词判定之前就已执行** ——
> **即被跳过的子节点也付了 obtain + initialize 的成本**。
>
> **这是「先构造后过滤」的常见形态**：过滤依赖 node info 的内容，
> 无法在构造前判断。**属结构性成本，非实现疏忽。**

### 7.4 `getTalkbackDescription` 的调用方

| 调用方 | 说明 |
| --- | --- |
| `ReactAccessibilityDelegate.kt:999` | **自身递归** |
| 主代码其他位置 | 由 RN 内部按需调用（TalkBack 活跃时） |

**这条路径只在无障碍服务活跃时被触发** —— 
**因此它的成本不会出现在普通性能剖析里，但在开启 TalkBack 的设备上是真实开销。**

---

## 8. `onInitializeAccessibilityNodeInfo` 的展开动作

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:70-81
  override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
    super.onInitializeAccessibilityNodeInfo(host, info)

    if (host.getTag(R.id.accessibility_state_expanded) != null) {
      val accessibilityStateExpanded = host.getTag(R.id.accessibility_state_expanded) as Boolean
      info.addAction(
          if (accessibilityStateExpanded) AccessibilityNodeInfoCompat.ACTION_COLLAPSE
          else AccessibilityNodeInfoCompat.ACTION_EXPAND,
      )
    }
```

**首行无条件 `super`**，随后按 tag 逐项叠加：

| 动作 | 依赖 tag |
| --- | --- |
| `ACTION_COLLAPSE` / `ACTION_EXPAND` | `R.id.accessibility_state_expanded` |
| `isSelected` / `isEnabled` / `isCheckable`+`isChecked` | `R.id.accessibility_state`（§5） |
| 各类 `AccessibilityActionCompat` | `R.id.accessibility_actions` |
| `CollectionItemInfoCompat` | `R.id.accessibility_collection_item` |
| `RangeInfoCompat` | range info 相关 |

**`accessibility_state_expanded` 的处理是「二元映射」**：

| tag 值 | 动作 |
| --- | --- |
| `true` | `ACTION_COLLAPSE` |
| `false`（或非 null） | `ACTION_EXPAND` |

> **注意条件是 `!= null` 而非取值判断** ——
> 即「只要设了这个 tag（哪怕 `false`），就一定会加一个动作」。
> **这是有意的**：展开态 View 应播报「折叠」，收起态应播报「展开」。

---

## 9. `setRole` 的未完成国际化

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:648-650
    // TODO: Eventually support for other languages on talkback
    @JvmStatic
    public fun setRole(
        nodeInfo: AccessibilityNodeInfoCompat,
        role: AccessibilityRole?,
```

**`setRole` 开头即 `// TODO: Eventually support for other languages on talkback`** ——
**自陈缺陷：role 名称硬编码英文，未接入 TalkBack 的本地化资源。**

**同类 TODO 共 3 处**（第 4 处是 `:53` 的 Handler）：

| # | 位置 | 内容 | 类型 |
| --- | --- | --- | --- |
| ① | `:53` | `// TODO: Replace with handler tied to host view's context` | 技术债 |
| ② | `:288` | `@Suppress("DEPRECATION") // TODO: Remove this`（`setBoundsInParent`） | 技术债 |
| ③ | `:649` | `// TODO: Eventually support for other languages on talkback` | **功能缺失** |
| ④ | `:991` | `@Suppress("DEPRECATION") // TODO: Replace with direct invocation on view` | 技术债 |

**③ 是唯一影响用户可见行为的**（其余 3 处是 API 迁移债）。

### 9.1 `Role` 枚举与 `facebook::react::Role` 的同步约束

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactAccessibilityDelegate.kt:309-315
  /**
   * An ARIA Role representable by View's `role` prop. Ordinals should be kept in sync with
   * `facebook::react::Role`.
   */
  public enum class Role {
    ALERT,
    ALERTDIALOG,
    APPLICATION,
    ARTICLE,
    BANNER,
    BUTTON,
    CELL,
```

**注释给出一条硬约束**：**「Ordinals should be kept in sync with `facebook::react::Role`」**。

> **即 Kotlin 枚举的序号必须与 C++ 枚举一致** ——
> 跨语言契约靠**声明顺序**而非名称传递，**没有任何编译期或运行期校验**。
>
> **在 `Role` 中间插入一个枚举值就会静默破坏契约。**
> **这是本仓库发现的最脆弱的跨语言约定之一。**

---

## 10. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| MM-1 | **基类的 5 个 `ExploreByTouchHelper` 虚视图 API 全部是「拒绝服务」实现**：`INVALID_ID` / `= Unit` / 1×1 空白 / `false` / `null` | `ReactAccessibilityDelegate.kt:279-301` | **触摸探索（TalkBack 手指滑动朗读）只在 `ReactTextView` 上可用**，其余所有 RN View 均不可用 |
| MM-2 | `setDelegate` 检查 7 个 tag 含 `R.id.role`（正常由 `BaseViewManager.java:499` 写入），但 **回收重置清单只清了 `accessibility_role`（`:86`），没有清 `role`** | `ReactAccessibilityDelegate.kt:601`；`BaseViewManager.java:86` vs `:497-499` | **复用 View 上的 `R.id.role` 不会被清空** —— 若该 tag 被设过，下一个组件挂上时会误判「有无障碍属性」而装 delegate |
| MM-3 | `setState` 只认 3 个 Boolean key，其余 `accessibilityState` 的 key **静默忽略**（无 `else`、无日志） | `ReactAccessibilityDelegate.kt:626-647` | **无障碍功能缺失对用户不可见**，开发者也无从得知 |
| MM-4 | `getTalkbackDescription` 递归对每个子节点 `AccessibilityNodeInfoCompat.obtain()` + 完整 `onInitializeAccessibilityNodeInfo`，**无深度上限、无缓存**，且被跳过的子节点也付此成本 | `ReactAccessibilityDelegate.kt:985-1002` | **TalkBack 活跃时，容器描述成本 O(子树节点数)**，与内容规模线性相关 |
| MM-5 | `Role` 枚举共 **64 项**，序号必须与 C++ `facebook::react::Role` 手工保持同步，**无任何编译期或运行期校验** | `ReactAccessibilityDelegate.kt:309-315` | **在 64 项枚举中间插入值会静默破坏跨语言契约** |
| MM-6 | `scheduleAccessibilityEventSender` 无论何种状态变更，**恒发 `TYPE_VIEW_SELECTED`**，且引入 **200ms 固定延迟** | `ReactAccessibilityDelegate.kt:271-277`、`:53-58` | 播报表达力被压到一种；且状态变更到播报至少延迟 200ms |
| MM-7 | `// TODO: Eventually support for other languages on talkback` —— role 名称未本地化 | `ReactAccessibilityDelegate.kt:649` | 非英语用户的 TalkBack 播报为英文 |
| MM-8 | `accessibilityEventHandler` 用已废弃的无参 `Handler()`，带 TODO 自陈 | `ReactAccessibilityDelegate.kt:52-53` | 依赖隐式 Looper |

### MM-1 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | Android 全部 |
| **架构** | 新旧架构共用（无架构门控） |
| **组件** | **仅 `ReactTextView` 及其子类** 具备触摸探索 |
| **前提** | TalkBack 活跃 + `ReactTextView.java:657` 的 `dispatchHoverEvent` 被调用 |

### MM-2 的交叉引用（本条最值得跟进）

**两处清单必须同步，但只有一处更新了**：

| 清单 | 位置 | 含 `accessibility_role` | 含 `role` |
| --- | --- | --- | --- |
| delegate 安装条件（7 个 tag） | `ReactAccessibilityDelegate.kt:601-607` | ✅ | ✅ |
| 回收重置（14 个 tag） | `BaseViewManager.java:78-91` | ✅ | ❌ |

> **这是 45 文档 §2.2 「14 个 tag 里 8 个是无障碍」的清单缺口** ——
> 该清单以 `accessibility_*` 前缀整理，**漏掉了新命名的 `role`**。
>
> **风险路径**：仅对 6 个 opt-in 的可回收 ViewManager 生效（45 文档 JJ-1），
> 且需 `API 28+` —— **影响面小但确实存在**。

---

## 11. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 45 文档 §2.2：`prepareToRecycleView` 清 14 个 tag，其中 8 个无障碍（**做对了**） | **指出清单缺口**：`R.id.role` 正常被 `:499` 写入却未被清零（MM-2），且它**正是** delegate 安装条件之一 —— **45 文档「8 个无障碍 tag」的清单需补第 9 个** |
| 45 文档：`setDelegate` / `resetDelegate` 的分工 | **补上依据**：`setDelegate` 检查已有 delegate，`resetDelegate` 无条件替换（§4.1） |
| 45 文档 JJ-1：`prepareToRecycleView` 在 `API < 28` 返回 `null` | MM-2 的风险因此**同时受平台与 opt-in 双重限制**（§10 MM-2 表） |
| 46 文档：`setLocalData` 空实现 → `ReactTextInputShadowNode` 的能力失效 | **补上无障碍侧的对称事实**：基类声明虚视图能力却全部拒服务（MM-1），**只有 Text 一处真实实现** |
| 46 文档：`superGetAccessibilityNodeProvider` 同型的「语言约束痕迹」 | **新增同型**：Kotlin 无法在 override 中方便地 `super` 调用，故需桥接方法（§4.2） |
| 46 文档：`@Suppress("DEPRECATION")` + TODO 是本仓库处理技术债的方式 | **本文 4 处同型**（`:53`、`:288`、`:649`、`:991`），其中 1 处是用户可见缺陷（MM-7） |
| 33 文档：带工单号的 TODO（`T207198334`、`T58784068`） | **本文 4 处 TODO 均无工单号** —— **两种 TODO 风格并存**（有号 / 无号） |
| 42 文档：内容增长过快的检测原理 | **新增一处与内容规模线性相关的成本**：`getTalkbackDescription` 递归（MM-4） |