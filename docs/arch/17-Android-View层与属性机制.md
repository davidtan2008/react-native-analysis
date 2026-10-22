---
id: 17
title: "Android View 层：属性反射分派与 props 差异语义"
topic: PL.android
symptoms: [prop]
platforms: [android]
architecture: [legacy]
layer: T3
symbols: ["ViewManager", "BaseViewManager"]
sourceRoot: react-native
claims: [VW-1, VW-2, VW-3, VW-4, VW-5, VW-6, VW-7, VW-8, VW-9]
---
# 17 · Android View 层：属性反射分派与 props 差异语义

> **模块**：C2 · 子批次 4c（`ReactAndroid/.../views`，137 个非测试文件 + `uimanager` 属性机制补充）
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · Android 侧
> **前置**：[10 文档](./10-Fabric组件层与视图扁平化.md) 讲了 C++ 侧扁平化；[16 文档](./16-Android-uimanager与旧架构掏空.md) 讲了 uimanager 的掏空状态。
> 本文讲 **JS 样式如何变成原生 View 属性**，以及一个容易踩的语义陷阱：**删除属性 ≠ 恢复默认**。

---

## 1. views 目录构成（137 个文件）

| 子目录 | 文件数 | 内容 |
| --- | --- | --- |
| `text/` | 44 | Text / 文本布局 / 23 个 Span 实现 |
| `scroll/` | 20 | ScrollView / NestedScroll |
| `textinput/` | 17 | TextInput |
| `view/` | 10 | View（对应 C++ 侧 `RCTView`） |
| `image/` | 10 | Image |
| `virtual/` | 6 | 虚拟化列表（FlatList 支撑） |
| `drawer/` | 6 | 抽屉布局（已被 RN 移除，待确认） |
| `modal/` `switchview/` `swiperefresh/` `imagehelper/` `debuggingoverlay/` `unimplementedview/` `safeareaview/` `progressbar/` `common/` | 3-4 each | 各组件 |

**`text/` 一个目录占 44 个文件**，其中 23 个是 `internal/span/` 下的 Span 实现 ——
这是 Android 文本渲染的核心（一个 `Text` 节点在原生侧展开成多个 `Span`）。

---

## 2. 属性机制：`@ReactProp` / `@ReactPropGroup`

### 2.1 单值属性

`views/text/ReactTextViewManager.kt` 共 **15 个 `@ReactProp`**（另有 3 个 `@ReactPropGroup`，见 §2.2）。
典型形态（`:280-288`）：

```
  @ReactProp(name = ViewProps.FONT_SIZE)
  public fun setFontSize(view: ReactTextView, fontSize: Float) {

  @ReactProp(name = ViewProps.LETTER_SPACING, defaultFloat = 0f)
  public fun setLetterSpacing(view: ReactTextView, letterSpacing: Float) {
```

带类型的自定义标记（`:310-311`）：

```
  @ReactProp(name = "selectionColor", customType = "Color")
  public fun setSelectionColor(view: ReactTextView, color: Int?) {
```

`customType = "Color"` 让该 prop 在 JS 侧被识别为颜色类型
（影响代码生成的类型检查与自动转换）。

### 2.2 分组属性：一个方法管 N 个同类属性

`ReactTextViewManager.kt:329-348`：

```kotlin
  @ReactPropGroup(
      names =
          [
              ViewProps.BORDER_RADIUS,
              ViewProps.BORDER_TOP_LEFT_RADIUS,
              ViewProps.BORDER_TOP_RIGHT_RADIUS,
              ViewProps.BORDER_BOTTOM_RIGHT_RADIUS,
              ViewProps.BORDER_BOTTOM_LEFT_RADIUS,
          ],
      defaultFloat = Float.NaN,
  )
  public fun setBorderRadius(view: ReactTextView, index: Int, borderRadius: Float) {
    val radius =
        if (borderRadius.isNaN()) {
          null
        } else {
          LengthPercentage(borderRadius, LengthPercentageType.POINT)
        }
    BackgroundStyleApplicator.setBorderRadius(view, BorderRadiusProp.values()[index], radius)
  }
```

**关键点：`index` 参数由框架注入**（见 §2.3），setter 自己不关心是哪个属性。
这避免了为 5 个圆角写 5 个几乎相同的方法。

`defaultFloat = Float.NaN` 是「未设置」哨兵 —— 见 §3。

`setBorderWidth`（`:369-371`）用同一模式管理 **7 个**方向/边宽度：

```kotlin
  public fun setBorderWidth(view: ReactTextView, index: Int, width: Float) {
    BackgroundStyleApplicator.setBorderWidth(view, LogicalEdge.values()[index], width)
  }
```

**`index` 既是属性下标，也是 `LogicalEdge` 枚举下标** —— 两者顺序必须严格对应，
这是隐式契约，源码无断言保护。

---

## 3. 核心机制：类型分派与 `Float.NaN` 哨兵

### 3.1 反射构建 `PropSetter`

`ViewManagersPropertyCache.kt:484`（见 16 文档 §4.2）读取 `@ReactProp` 注解，
按类型创建不同的 `PropSetter` 子类：

| `PropSetter` 子类 | `propType` | 行号 |
| --- | --- | --- |
| `IntPropSetter` | `"Int"` | `:162-163` |
| `ColorPropSetter` | `"mixed"` | `:166-195` |
| `DimensionPropSetter` | `"mixed"` | `:197-204` |
| `BooleanPropSetter` | `"boolean"` | `:206-216` |
| `FloatPropSetter` | `"number"` | `:218-243` |
| `ArrayPropSetter` | `"Array"` | `:245-249` |
| `MapPropSetter` | `"Map"` | `:251-254` |
| `StringPropSetter` | `"String"` | `:256-` |

`FloatPropSetter`（`:239-242`）：

```kotlin
    override fun getValueOrDefault(value: Any?, context: Context): Any {
      // All numbers from JS are Doubles which can't be simply cast to Float
      return if (value == null) defaultValue else (value as Double).toFloat()
    }
```

**注释点明了 JS→Java 的类型鸿沟**：JS 数字全是 `Double`，必须显式 `toFloat()`。

**`Float.NaN` 不会被特殊处理** —— 它只作为 `value == null` 时的 `defaultValue` 返回。
调用方在 setter 里用 `isNaN()` 判断「未设置」（见 §2.2）。

### 3.2 `Float.NaN` 是全局惯例，不是局部写法

实测：`defaultFloat = Float.NaN` 在 **9 个文件出现 17 处**：

| 文件 |
| --- |
| `views/view/ReactViewManager.kt` |
| `views/text/ReactTextViewManager.kt` |
| `views/text/PreparedLayoutTextViewManager.kt` |
| `views/scroll/ReactScrollViewManager.kt` |
| `views/scroll/ReactNestedScrollViewManager.kt` |
| `views/scroll/ReactHorizontalScrollViewManager.kt` |
| `views/textinput/ReactTextInputManager.kt` |
| `views/drawer/ReactDrawerLayoutManager.kt` |
| `uimanager/LayoutShadowNode.kt` |

**全部用于「可以显式设为无」的属性**：圆角、边框宽/色、margin、padding。
这类属性的「默认值」就是「不设置」，用 `NaN` 与 `0` 区分开。

对比 `BaseViewManager.java` 里的普通默认值（`:267, 510-516`）：

```
  @ReactProp(name = ViewProps.OPACITY, defaultFloat = 1.f)
  @ReactProp(name = ViewProps.SCALE_X, defaultFloat = 1f)
  @ReactProp(name = ViewProps.TRANSLATE_X, defaultFloat = 0f)
```

**语义区别清晰**：`scaleX` 默认 `1f`（有实际含义），
`borderRadius` 默认 `NaN`（无实际含义 = 不设置）。

### 3.3 关键：为什么需要哨兵 —— 删除属性 ≠ 恢复默认

`ViewManagerPropertyUpdater.kt:60-71`：

```kotlin
  public fun <V : View> updateProps(
      manager: ViewManager<V, *>,
      view: V,
      props: ReactStylesDiffMap,
  ) {
    val setter = findManagerSetter(manager.javaClass)
    val iterator = props.backingMap.entryIterator
    while (iterator.hasNext()) {
      val entry = iterator.next()
      setter.setProperty(manager, view, entry.key, entry.value)
    }
  }
```

**只遍历 `props` 中实际存在的 key。**

`ReactStylesDiffMap` 的构造（`uimanager/ReactStylesDiffMap.kt:32-39`）：

```kotlin
public class ReactStylesDiffMap(props: ReadableMap) {
  ...
  @get:JvmName("internal_backingMap") internal val backingMap: ReadableMap = props
```

**它就是 JS 传来的那个 map 的薄包装，没有任何「补全缺失 key」的逻辑。**

### 3.4 由此得出的语义规则

`setProperty` 的实现（`uimanager/ViewManagerPropertyUpdater.kt:153-156`）：

```kotlin
    override fun setProperty(manager: ViewManager<V, *>, view: V, name: String, value: Any?) {
      val setter = propSetters[name]
      setter?.updateViewProp(manager, view, value)
    }
```

**只有 `props` 里存在的 key 才会走到这里**，且 `value` 为 `null` 时
`getValueOrDefault` 返回注解声明的 `defaultXxx`。

| 情况 | setter 是否被调用 | 传入 value | 原生 View 状态 |
| --- | --- | --- | --- |
| JS 设置 `borderRadius: 8` | ✅ | `8f` | 圆角 8 |
| JS 改为 `borderRadius: 0` | ✅ | `0f` | 圆角 0（**合法值，非清除**） |
| JS 设为 `borderRadius: undefined` | ✅ | `null` → `defaultFloat` | **回到声明的默认值**（`NaN` 或 `0f`） |
| JS **删除 style 对象里的这个键** | ❌ **不调用** | — | **圆角仍为 8 —— 旧值残留** |

**「删掉一个 key」不会把它重置为默认；「把它设为 undefined」才会。**

> **这是本文最重要的一条**。它解释了 `Float.NaN` 哨兵存在的根本原因：
> **框架没有「属性被删除」的概念，只有「属性被设为某值」的概念。**
>
> 实践影响：<View> 在条件渲染中移除某个 style 键，
> 原生侧会残留旧样式，且**不会有任何错误或警告**。
> 必须显式写 `undefined` 才能重置。

### 3.5 注解注释与实现相矛盾

`uimanager/annotations/ReactProp.kt:66-71`：

```kotlin
    /**
     * Default value for property of type `float`. This value will be provided to property setter
     * method annotated with [ReactProp] if property with a given name gets removed from the
     * component description in JS
     */
    public val defaultFloat: Float = 0.0f,
```

**注释明说「当属性从 JS 描述中被移除（gets removed）时提供该默认值」。**

但 §3.4 已证明：属性被移除 → key 不在 `props` 里 → setter 不会被调用 → **默认值不会被提供**。

| 来源 | 说法 |
| --- | --- |
| `ReactProp.kt:67-70` 注释 | 属性被移除时会提供默认值 |
| `ViewManagerPropertyUpdater.kt:66-70` 实现 | 只遍历存在的 key，被移除的属性不触发 setter |

**这是一处文档与实现的直接矛盾。** 实际行为取决于 JS 侧序列化时是否把
「已删除的属性」以 `key: undefined` 的形式放进 map：

- 若放（key 存在、值 null）→ 注释正确，行为正常
- 若不放 → 注释错误，属性残留

**这一层取决于 JS/C++ 侧的 props 序列化实现，不在本文的代码范围内**
（属批次 4d 与 B4 样式模块）。

**另一个可确认的默认值**：`defaultFloat` 不写时是 `0.0f`（`ReactProp.kt:71`、
`ReactPropGroup.kt:60`），**不是 `NaN`**。
所以漏写 `defaultFloat` 的边框类属性，重置后是「边框宽 0」而非「无边框」——
视觉上恰好一致，但语义不同（`NaN` 还会被转成 `null` 走 `BackgroundStyleApplicator` 的另一分支）。

### 3.6 Fabric 路径下 props 是全量下发

这条差异很重要。Fabric 的 `SurfaceMountingManager.kt:671-675`：

```kotlin
    } else {
      viewState.currentProps = ReactStylesDiffMap(props)
    }

    val view: View = viewState.view ?: return
    checkNotNull(viewState.viewManager).updateProperties(view, viewState.currentProps)
```

而 C++ 侧构造 Update 变更时（`mounting/ShadowViewMutation.h:72`）：

```cpp
  static ShadowViewMutation UpdateMutation(ShadowView oldChildShadowView, ShadowView newChildShadowView, Tag parentTag);
```

**传的是 `newChildShadowView`（完整的新 ShadowView）**，其 props 是
`ConcreteComponentDescriptor::cloneProps` 产出的**完整 Props 对象**
（见 [07 文档](./07-Fabric组件层与Props体系.md)），而非差异集。

因此：

| 架构 | props 载荷 | 属性删除的语义 |
| --- | --- | --- |
| **Fabric** | 新 Props 的**全量** | 该 key 不在全量里 → setter 不调用 → **同样残留** |
| 旧架构 | 差异集 | 同样残留 |

**两者都有这个问题** —— 这不是架构切换能解决的，而是 ViewManager 机制本身的约束。
不过 Fabric 下 C++ 侧每次都从完整 Props 克隆，
**只要 `rawProps` 正确反映「该属性已被移除」，全量 map 里就不会有这个 key** ——
问题在于 JS 侧传的是 diff 还是全量，取决于 Fabric 的 props 序列化实现。

> **结论要谨慎**：以上是基于 `UpdateMutation` 签名与 `cloneProps` 语义的推断，
> **未追踪到 C++ 侧序列化 props 到 JS/JNI 的具体实现**（属批次 4d 范围）。
> 严格回答「Fabric 下删除属性是否会被正确清除」需要读完 `MountingTransaction` 的序列化路径。

---

## 4. 属性 setter 抛异常 = JS 崩溃

`ViewManagersPropertyCache.kt:63-78`：

```kotlin
    fun updateViewProp(viewManager: ViewManager<*, *>, viewToUpdate: View, value: Any?) {
      try {
        val resolved = getValueOrDefault(value, viewToUpdate.context)
        if (index == null) {
          setter.invoke(viewManager, viewToUpdate, resolved)
        } else {
          setter.invoke(viewManager, viewToUpdate, index, resolved)
        }
      } catch (t: Throwable) {
        FLog.e(ViewManager::class.java, "Error while updating prop $propName", t)
        throw JSApplicationIllegalArgumentException(
            "Error while updating property '$propName' of a view managed by: ${viewManager.name}",
            t,
        )
      }
    }
```

**catch 之后立刻 rethrow**，只是把 `Throwable` 包装成
`JSApplicationIllegalArgumentException` 并附上属性名与 ViewManager 名。

**注意 `catch (t: Throwable)` 捕获范围极广** ——
连 `OutOfMemoryError`、`StackOverflowError` 都会被包装成 JS 异常。

这条路径直通 [04 文档](./04-崩溃日志捕获收集处理上传.md) 描述的崩溃链：
属性 setter 抛错 → `JSApplicationIllegalArgumentException` → JS 侧可见 →
若未捕获则致命。

`updateShadowNodeProp`（`:80-95`）结构完全对称。

> **实践含义**：一个写错的 prop 值（比如给 `backgroundColor` 传了非法字符串）
> 会在**挂载阶段**就抛出带明确属性名的异常 —— 这是排查 prop 问题的首要入口。
> 异常消息格式固定为
> `Error while updating property '<propName>' of a view managed by: <VM名>`，
> 可直接用于日志检索。

---

## 5. 文本层：Span 体系（23 个实现）

`views/text/internal/span/` 下 23 个 Span 类，是 Android 文本渲染的核心。

| 类别 | 实现 |
| --- | --- |
| 基础 | `ReactSpan` / `StatefulSpan` / `ReactTagSpan` |
| 颜色 | `ReactForegroundColorSpan` / `ReactBackgroundColorSpan` / `ShadowStyleSpan` |
| 字形 | `ReactStrikethroughSpan` / `ReactUnderlineSpan` / `CustomLetterSpacingSpan` / `CustomLineHeightSpan` / `CustomStyleSpan` / `ReactAbsoluteSizeSpan` |
| 交互 | `ReactClickableSpan` / `TouchableSpan` / `ReactLinkSpan` |
| 特效 | `TextEffectSpan` / `AnimatedEffectSpan` / `CanvasEffectSpan` / `TextInlineViewPlaceholderSpan` |
| 布局 | `ReactFragmentIndexSpan` / `ReactOpacitySpan` / `ReactTextPaintHolderSpan` |

**这解释了 10 文档 §2 的扁平化在文本上的特殊性**：
一个 `<Text>` 在 C++ 侧可能产生多个 ShadowNode（fragment），
每个 fragment 在 Android 侧对应一个 Span，**通过 `ReactTagSpan` 关联回各自的 react tag**。

`TextEffectRegistry` / `TextEffectSpanFactory` 提供可扩展的特效注册机制。

`MutableSpannableLayout`（`text/MutableSpannableLayout.kt`）负责 span 的增量更新 ——
文本内容变化时只改动受影响的 span 区间，而非整体重建。

`TextLayoutManager.kt` 有 **1898 行**，是 views 下最大的文件。已知技术债：

| 位置 | 内容 |
| --- | --- |
| `:191, :215` | `TODO: Don't read AS_KEY_FRAGMENTS, which may be expensive, and is not present when using...` |
| `:826` | `TODO T31905686: add support for inline Images` |
| `:1481` | `TODO(5578671): Handle text direction (see View#getTextDirectionHeuristic)` |
| `:1672` | StaticLayout 高度只响应 `maxLines` 的限制说明 |

> **`AS_KEY_FRAGMENTS` 的 TODO 出现在同文件两处**，
> 说明读取 fragment 键值是**已知性能热点**。这是 05 文档「长列表/长文本卡顿」的可查线索。

---

## 6. 扩展点：`ReactTextViewManagerCallback`

`views/text/ReactTextViewManagerCallback.kt:13-16`：

```
 * This interface allows clients of [ReactTextViewManager] to customize or prepare [Spannable]
public fun interface ReactTextViewManagerCallback {
```

**`fun interface`（SAM）** —— 只需实现一个方法即可定制文本 Spannable 构建。
这是 App 侧做富文本定制的官方入口。

`ReactTextViewManagerCallback.kt` 与 `ReactTextViewManager` 配合，
在 span 生成前后插入自定义逻辑。

---

## 7. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| VW-1 | **删除 prop 不会重置为默认** —— `updateProps` 只遍历存在的 key | `uimanager/ViewManagerPropertyUpdater.kt:66-70` | 条件渲染移除 style 键时原生侧残留旧样式，无任何提示 |
| VW-2 | **`@ReactProp` 注释与实现矛盾**：注释说属性被移除时提供默认值，实现只遍历存在的 key | `uimanager/annotations/ReactProp.kt:66-71` vs `ViewManagerPropertyUpdater.kt:66-70` | 开发者按注释理解会写出错误代码；实际行为依赖 JS 序列化层 |
| VW-3 | `defaultFloat` 默认值是 `0.0f` 而非 `NaN` | `uimanager/annotations/ReactProp.kt:71`、`ReactPropGroup.kt:60` | 漏写时重置为 0 而非「无」，对边框类属性语义不同 |
| VW-4 | 属性 setter 捕获 `Throwable` 后包装 rethrow | `uimanager/ViewManagersPropertyCache.kt:71-77` | 连 `OutOfMemoryError` 也会被包装成 JS 异常，丢失错误语义 |
| VW-5 | `@ReactPropGroup` 的 `index` 与 `LogicalEdge.values()` 顺序无断言保护 | `views/text/ReactTextViewManager.kt:369-371` | 枚举顺序变更会静默错配边框方向 |
| VW-6 | `AS_KEY_FRAGMENTS` 读取被标注为性能热点（两处 TODO） | `views/text/TextLayoutManager.kt:191, 215` | 长文本/长列表场景的卡顿线索 |
| VW-7 | `TODO(5578671): Handle text direction` 未处理 | 同上 `:1481` | 依赖 `View#getTextDirectionHeuristic` 的自动处理，行为可能不符预期 |
| VW-8 | `TODO T31905686: add support for inline Images` | 同上 `:826` | Text 内嵌图片未支持 |
| VW-9 | `ReactStylesDiffMap` 无「补全缺失 key」逻辑，接口无文档说明该约束 | `uimanager/ReactStylesDiffMap.kt:32-39` | 使用者容易误以为它是完整视图 |

**VW-1 与 VW-2 都需要 JS 侧的 props 序列化实现才能定论**，
本文只给出了 Android 侧可验证的部分，缺口已明确标注。

**VW-9 与 VW-1 是同一问题的两面**：
`ReactStylesDiffMap` 的命名（"Diff"）暗示它是差异集，但**没有任何文档说明「缺失 key 会被静默忽略」**。
这是本模块最值得写进团队规范的一条。

---

## 8. 与其他文档的衔接

- C++ 侧 Props 克隆与全量性 → [07 文档](./07-Fabric组件层与Props体系.md)
- 扁平化与 Trait 决定哪些节点有原生 View → [10 文档](./10-Fabric组件层与视图扁平化.md)
- 属性反射缓存与 `clear()` 时机 → [16 文档 §4](./16-Android-uimanager与旧架构掏空.md)
- 崩溃链路（setter 异常 → JS）→ [04 文档](./04-崩溃日志捕获收集处理上传.md)
- 长文本/长列表卡顿的监控方法 → [05 文档](./05-监控检测原理与流程.md)
- JNI 序列化路径（VW-1 在 Fabric 下的确切行为）→ 批次 4d

---

## 9. 验证方式

```bash
node docs/arch/audit/audit-citations.mjs    # 引用可达性
node docs/arch/audit/verify-quotes.mjs      # 代码块语义
node docs/arch/audit/verify-claims.mjs      # 核心事实断言
```
