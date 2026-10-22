---
id: 53
title: "渲染器核心与 Yoga：两组哈希/相等字段集不一致、一个只拒 NaN 与负数的测量消毒、一个无上界的文本布局缓存"
topic: RN.layout
symptoms: [layout, text]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["YGNodeLayoutGetMeasuredDimensions", "LayoutMetrics"]
claims: [SS-1, SS-2, SS-3, SS-4, SS-5, SS-6, SS-7, SS-8, SS-9]
---
# 53 · 渲染器核心与 Yoga：两组哈希/相等字段集不一致、一个只拒 NaN 与负数的测量消毒、一个无上界的文本布局缓存

> **模块**：A1 + E5 ·
> `packages/react-native/ReactCommon/react/renderer/mounting/ShadowView.cpp`、
> `renderer/mounting/ShadowView.h`、
> `renderer/core/LayoutMetrics.h`、
> `ReactCommon/yoga/yoga/node/Node.cpp`、
> `ReactCommon/yoga/yoga/numeric/Comparison.h`、
> `renderer/components/text/ParagraphShadowNode.cpp`
>
> **基线**：react-native @ `9b131e42` · 跨平台 · **Fabric 新架构路径**
>
> **前置**：[09 文档](./09-渲染器核心与差分算法.md) 记录渲染器核心；
> [12 文档](./12-UI一致性与ShadowTree修订版.md) 记录 ShadowTree 修订；
> [42 文档](./42-Android内存压力与View回收池.md) 记录内存压力。
>
> 本文记录三条**可由标准或算术直接判定**的问题：
> ① **`operator==` 与 `std::hash` 的字段集不一致**（两处，性质不同：一处是潜在的、
> 一处是实打实的哈希质量缺陷）；
> ② **Yoga 的测量结果消毒只拒 NaN 与负数，`±inf` 直接放行**；
> ③ **`measuredLayouts_` 是无上界、无淘汰、无清空的向量**。

---

## 1. 两组哈希/相等字段集的完整对照

### 1.1 `ShadowView`：相等比 7 个，哈希用另外 7 个

**相等判定**（逐字）：

```cpp
// packages/react-native/ReactCommon/react/renderer/mounting/ShadowView.cpp:34-51
bool ShadowView::operator==(const ShadowView& rhs) const {
  return std::tie(
             this->surfaceId,
             this->tag,
             this->componentName,
             this->props,
             this->eventEmitter,
             this->layoutMetrics,
             this->state) ==
      std::tie(
             rhs.surfaceId,
             rhs.tag,
             rhs.componentName,
             rhs.props,
             rhs.eventEmitter,
             rhs.layoutMetrics,
             rhs.state);
}
```

**哈希**（逐字）：

```cpp
// packages/react-native/ReactCommon/react/renderer/mounting/ShadowView.h:66-79
struct hash<facebook::react::ShadowView> {
  size_t operator()(const facebook::react::ShadowView &shadowView) const
  {
    return facebook::react::hash_combine(
        0,
        shadowView.surfaceId,
        shadowView.componentHandle,
        shadowView.tag,
        shadowView.props,
        shadowView.eventEmitter,
        shadowView.layoutMetrics,
        shadowView.state);
  }
};
```

**逐字段对照**：

| # | 字段 | `operator==` | `hash<>` | 一致？ |
| --- | --- | --- | --- | --- |
| — | 种子 `0` | — | ✅ | — |
| 1 | `surfaceId` | ✅ | ✅ | ✅ |
| 2 | `tag` | ✅ | ✅ | ✅ |
| 3 | **`componentName`** | ✅ | ❌ | ❌ **只比不哈希** |
| 4 | **`componentHandle`** | ❌ | ✅ | ❌ **只哈希不比** |
| 5 | `props` | ✅ | ✅ | ✅ |
| 6 | `eventEmitter` | ✅ | ✅ | ✅ |
| 7 | `layoutMetrics` | ✅ | ✅ | ✅ |
| 8 | `state` | ✅ | ✅ | ✅ |

**两个字段集恰好差一项，方向相反。**

### 1.2 为什么 `ShadowView` 这处**在实践中不违规**

**C++ 标准要求**：`a == b` 必须蕴含 `hash(a) == hash(b)`。

**本处满足该要求，但依据是「注册表保证 handle 与 name 一一对应」**：

| 类型别名 | 定义 | 位置 |
| --- | --- | --- |
| `ComponentHandle` | `int64_t` | `renderer/core/ReactPrimitives.h:37` |
| `ComponentName` | `const char *` | `renderer/core/ReactPrimitives.h:43` |

**两个字段都从同一个 `ShadowNode` 派生**：

```cpp
// packages/react-native/ReactCommon/react/renderer/mounting/ShadowView.cpp:24-32
ShadowView::ShadowView(const ShadowNode& shadowNode)
    : componentName(shadowNode.getComponentName()),
      componentHandle(shadowNode.getComponentHandle()),
      surfaceId(shadowNode.getSurfaceId()),
      tag(shadowNode.getTag()),
      traits(shadowNode.getTraits()),
      props(shadowNode.getProps()),
      eventEmitter(shadowNode.getEventEmitter()),
      layoutMetrics(layoutMetricsFromShadowNode(shadowNode)),
      state(shadowNode.getState()) {}
```

**注册表侧对一致性做了断言**：

```cpp
// packages/react-native/ReactCommon/react/renderer/componentregistry/ComponentDescriptorRegistry.cpp:41-46
  react_native_assert(
      componentDescriptor->getComponentHandle() ==
      componentDescriptorProvider.handle);
  react_native_assert(
      componentDescriptor->getComponentName() ==
```

**即 `handle ↔ name` 在注册表内是双射**，因此「name 相等」⟺「handle 相等」，
**哈希用 handle 与相等用 name 判别能力等价**。

> **结论（必须精确表述）**：
>
> | 问题 | 判定 |
> | --- | --- |
> | 是否违反 C++ 标准的 `hash`/`==` 一致性要求 | **否** —— 判别能力等价 |
> | 两个字段集为何不同 | **一处用名字、一处用 id，但两者双射** |
> | 是否稳健 | **脆弱但当前正确** —— 依赖「注册表内双射」这一**间接**约束 |
> | 有无断言守护该约束 | **有** —— `ComponentDescriptorRegistry.cpp:41-46` 两处 `react_native_assert` |
>
> **这是 48 文档定义的「结构脆弱」类的又一实例**：
> 代码正确，但正确性来自另一个文件里的一个不变量。

**一处额外的隐患**：`ComponentName` 是 `const char *`，
`std::tie` 对它做的是**指针比较**，不是字符串比较。
**这依赖同名组件名指向同一个字符串字面量**（链接器合并字面量）。
若某平台不复用字面量，相等判定会失效。

### 1.3 `LayoutMetrics`：相等比 10 个，哈希只用 8 个 —— **实打实的缺陷**

**相等判定是默认生成**：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/LayoutMetrics.h:92
  bool operator==(const LayoutMetrics &rhs) const = default;
```

**`= default` 意味着「比较全部 10 个成员」。**

**结构体成员逐个列出**（`LayoutMetrics.h:25-50`）：

| # | 成员 | 默认值 | `operator==` | `hash<>` |
| --- | --- | --- | --- | --- |
| 1 | `frame` | — | ✅ | ✅ |
| 2 | `contentInsets` | `{0}` | ✅ | ✅ |
| 3 | `borderWidth` | `{0}` | ✅ | ✅ |
| 4 | `displayType` | `DisplayType::Flex` | ✅ | ✅ |
| 5 | **`positionType`** | **`PositionType::Relative`** | ✅ | ❌ |
| 6 | `layoutDirection` | `LayoutDirection::Undefined` | ✅ | ✅ |
| 7 | **`wasLeftAndRightSwapped`** | **`false`** | ✅ | ❌ |
| 8 | `pointScaleFactor` | `1.0` | ✅ | ✅ |
| 9 | `fontSizeMultiplier` | `1.0` | ✅ | ✅ |
| 10 | `overflowInset` | — | ✅ | ✅ |

**哈希实现**（逐字）：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/LayoutMetrics.h:117-130
struct hash<facebook::react::LayoutMetrics> {
  size_t operator()(const facebook::react::LayoutMetrics &layoutMetrics) const
  {
    return facebook::react::hash_combine(
        layoutMetrics.frame,
        layoutMetrics.contentInsets,
        layoutMetrics.borderWidth,
        layoutMetrics.displayType,
        layoutMetrics.layoutDirection,
        layoutMetrics.pointScaleFactor,
        layoutMetrics.fontSizeMultiplier,
        layoutMetrics.overflowInset);
  }
};
```

**被哈希漏掉的两个成员都不是平凡量**：

| 成员 | 取值空间 | 为什么它是判别量 |
| --- | --- | --- |
| `positionType` | `Relative` / `Absolute` | **`position: absolute` 与 `relative` 的两个节点布局结果可能完全相同**（例如 auto 尺寸下同位），但它们**不是同一个节点** |
| `wasLeftAndRightSwapped` | `true` / `false` | RTL 下 `doLeftAndRightSwapInRTL` 的结果标记，直接影响后续子节点解释 |

### 1.4 后果分级：这是**哈希质量**缺陷，不是正确性缺陷

| 问题 | 判定 |
| --- | --- |
| 是否违反 `a == b ⟹ hash(a) == hash(b)` | **否** —— 相等判定仍然完整（`= default`） |
| 是否产生哈希碰撞 | **是** —— 仅 `positionType` 或 `wasLeftAndRightSwapped` 不同的两个 `LayoutMetrics` **哈希相同** |
| 若用作 `unordered_map` 键 | **正确性不受影响**，但冲突桶变长，退化为线性查找 |
| 与 §1.2 的 `ShadowView` 相比 | **性质更轻但更实在** —— `ShadowView` 有间接不变量兜底，`LayoutMetrics` **没有任何兜底** |

> **`LayoutMetrics` 存在嵌套关系**：`ShadowView::hash` 调用了 `hash(layoutMetrics)`。
> **即 §1.3 的缺陷会通过嵌套传导到 `ShadowView` 的哈希质量。**

### 1.5 `operator==` 的下游用途

**相等判定驱动 Update 类 mutation 的产出**：
`ShadowView.cpp:34` 的 `operator==` 被差分算法用来决定「这个 View 的属性是否变了」，
**从而决定是否发出 Update**。

**这意味着 §1.1 的 `componentName` 确实参与相等判定** ——
即「组件名变了但其余都没变」会被判为不等并发出 Update。
**该行为本身合理**（组件换了就该重建），但它与哈希的选择不一致。

---

## 2. 【核心】Yoga 测量结果的消毒只拒 NaN 与负数

### 2.1 NaN 的判定方式

```cpp
// packages/react-native/ReactCommon/yoga/yoga/numeric/Comparison.h:18-25
constexpr bool isUndefined(std::floating_point auto value) {
  return value != value;
}

constexpr bool isDefined(std::floating_point auto value) {
  return !isUndefined(value);
}
```

**`value != value` 是 NaN 的经典判定** —— 命名 `isUndefined` 而非 `isNaN`
**沿用了 YGUndefined 的历史语义**（用 NaN 表示「未定义」）。

### 2.2 测量结果的消毒分支

```cpp
// packages/react-native/ReactCommon/yoga/yoga/node/Node.cpp:62-81
  const auto size = measureFunc_(
      this,
      availableWidth,
      unscopedEnum(widthMode),
      availableHeight,
      unscopedEnum(heightMode));

  if (yoga::isUndefined(size.height) || size.height < 0 ||
      yoga::isUndefined(size.width) || size.width < 0) {
    yoga::log(
        this,
        LogLevel::Warn,
        "Measure function returned an invalid dimension to Yoga: [width=%f, height=%f]",
        size.width,
        size.height);
    return {
        .width = maxOrDefined(0.0f, size.width),
        .height = maxOrDefined(0.0f, size.height)};
  }

  return size;
```

**四个判据**：`isUndefined(height)`、`height < 0`、`isUndefined(width)`、`width < 0`。

**`+infinity` 的命运**：

| 判据 | 对 `+inf` 的结果 |
| --- | --- |
| `isUndefined(inf)` = `inf != inf` | **false** |
| `inf < 0` | **false** |

**四个判据全部为 false → `return size` 原样放行。**

### 2.3 即使被消毒，`inf` 也不会被截断

**消毒分支返回 `maxOrDefined(0.0f, size.width)`**，其定义是：

```cpp
// packages/react-native/ReactCommon/yoga/yoga/numeric/Comparison.h:35-42
  if (yoga::isDefined(a) && yoga::isDefined(b)) {
    return std::max(a, b);
  }
  return yoga::isUndefined(a) ? b : a;
```

| 输入 | `std::max(0.0f, x)` | 结果 |
| --- | --- | --- |
| `-5` | `max(0.0f, -5.0f)` | `0.0f` ✅ |
| `NaN` | 走 `isUndefined(a)` 分支 | `b` = `0.0f` ✅ |
| **`+inf`** | `max(0.0f, inf)` | **`inf`** ❌ |

> **即消毒只能把负数与 NaN 变成 0，对 `+inf` 无能为力。**
> **一个返回 `+inf` 的测量函数会让该节点的尺寸变成无穷大并直接进入布局。**

### 2.4 RN 侧的对应检查在 debug 编译下

**Yoga 之外的第二道检查存在于 RN 侧，且被编译条件包住**：

| 侧 | 位置 | 编译条件 | 失败行为 |
| --- | --- | --- | --- |
| Yoga | `yoga/node/Node.cpp:67-80` | **无**（始终生效） | `log(Warn)` + 消毒 |
| RN | `YogaLayoutableShadowNode.cpp` 的边界检查 | **`#ifdef REACT_NATIVE_DEBUG`** | `LOG(ERROR)` |

> **Yoga 侧那道永远生效，但只挡 NaN 与负数**；
> **RN 侧那道能覆盖更多，但只在 debug 编译下存在。**
>
> **即 release 构建下对 `inf` 的防护是空的。**

### 2.5 是否有重试

**没有任何重试路径** —— 消毒后的值直接返回，由上层布局继续。

---

## 3. Yoga 的浮点比较：一个硬编码阈值与一处自认的 epsilon 修正

### 3.1 `inexactEquals` 的硬编码阈值

```cpp
// packages/react-native/ReactCommon/yoga/yoga/numeric/Comparison.h:54-66
// Custom equality functions using a hardcoded epsilon of 0.0001f, or returning
// true if both floats are NaN.
inline bool inexactEquals(float a, float b) {
  if (yoga::isDefined(a) && yoga::isDefined(b)) {
    return std::abs(a - b) < 0.0001f;
  }
  return yoga::isUndefined(a) && yoga::isUndefined(b);
}

inline bool inexactEquals(double a, double b) {
  if (yoga::isDefined(a) && yoga::isDefined(b)) {
    return std::abs(a - b) < 0.0001;
  }
```

**注释自陈两件事**：

| # | 注释内容 | 含义 |
| --- | --- | --- |
| ① | `using a hardcoded epsilon of 0.0001f` | **阈值是写死的**，且是**单一全局值** |
| ② | `or returning true if both floats are NaN` | **两个 NaN 被判为相等** |

**两个重载各用自己的字面量**：`float` 版是 `0.0001f`，`double` 版是 `0.0001` ——
**同一语义、两个独立写死的阈值**（改一处不会同步另一处）。

**② 的后果**：两个未定义尺寸被视为相等，
**即「都是 NaN」在布局里被当作「一样」处理**，避免 NaN 传播成永不相等。

### 3.2 一处带完整根因说明的 epsilon 修正

```cpp
// packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:1107-1114
        // Use a relative epsilon guard instead of exact equality: after the
        // first pass removes all constrained items,
        // totalFlexShrinkScaledFactors may be near-zero rather than exactly 0
        // due to floating-point cancellation.  Dividing by a near-zero value
        // produces a gigantic childSize that overwhelms the min/max clamp.
        const float shrinkFactorMagnitude =
            std::abs(flexLine.layout.totalFlexShrinkScaledFactors);
        if (yoga::isDefined(flexLine.layout.totalFlexShrinkScaledFactors) &&
            shrinkFactorMagnitude < 1e-6f) {
          childSize = childFlexBasis + flexShrinkScaledFactor;
        } else {
```

**这条注释是全 Yoga 树里信息密度最高的一处**，四个要素齐备：

| 要素 | 内容 |
| --- | --- |
| **现象** | 精确比较（`!= 0`）不够用 |
| **成因** | 浮点抵消（floating-point cancellation）使总和成为**近零而非精确零** |
| **后果** | 除以近零值产生**巨大 childSize**，**压过 min/max clamp** |
| **修法与理由** | 改用**相对 epsilon 守卫**，阈值 `1e-6f` |

> **「压过 min/max clamp」是关键** ——
> 即作者知道即便有 clamp，巨大值仍会造成非预期的尺寸，
> 所以必须在除法**之前**挡住。
>
> **注意该阈值 `1e-6f` 与 §3.1 的 `0.0001f` 是两个独立的 epsilon**，
> **量级差 100 倍**（`1e-6` vs `1e-4`），**用途不同**：
> 前者是「除法前的近零守卫」，后者是「结果比较容差」。
> **两者都写死，且互不引用。**

---

## 4. 【核心】`measuredLayouts_`：无上界、无淘汰、无清空

### 4.1 声明

```cpp
// packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.h:140
  mutable std::vector<MeasuredPreparedTextLayout> measuredLayouts_;
```

**三个特征**：

| 特征 | 值 | 后果 |
| --- | --- | --- |
| 容器类型 | **`std::vector`**（不是 map） | **只能线性扫描** |
| **`mutable`** | 是 | `measureContent` 是 `const` 方法却能改它（缓存语义正确） |
| **全仓库引用数** | **4**（1 声明 + 2 读 + 1 写） | **无 `clear()`、无 `resize()`、无 `pop_back()`** |

### 4.2 唯一的写入点

```cpp
// packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp:249-259
      auto measurement = tme.measurePreparedLayout(
          preparedLayout, textLayoutContext, layoutConstraints);

      measuredLayouts_.push_back(
          MeasuredPreparedTextLayout{
              .layoutConstraints = layoutConstraints,
              .measurement = measurement,
              // PreparedTextLayout is not trivially copyable on all platforms
              // NOLINTNEXTLINE(performance-move-const-arg)
              .preparedTextLayout = std::move(preparedLayout)});
      assert_valid_size(measurement.size, layoutConstraints);
      return measurement.size;
```

**每次缓存未命中就 `push_back`** —— **没有「命中数上限」「总字节上限」或 LRU**。

**注意写入被一个 feature flag 包住**：

```cpp
      if (ReactNativeFeatureFlags::enablePreparedTextLayout()) {
```

**`if constexpr` 外层还有一层**：`TextLayoutManagerExtended::supportsPreparedTextLayout()`
是编译期条件（`if constexpr`），`enablePreparedTextLayout()` 是运行期 flag。

### 4.3 每次测量两次线性扫描

| # | 行号 | 函数 | 扫描条件 |
| --- | --- | --- | --- |
| ① | `:196` | 取可复用布局 | `floatEquality(prevLayout.measurement.size.width, expectedSize.width) && …height` |
| ② | `:226` | `measureContent` 内按约束查 | `layout.layoutConstraints == layoutConstraints` |

**两次都是 `for (auto& … : measuredLayouts_)` 全量线性扫描。**

> **即单次测量的成本是 O(缓存条目数 × 2)。**
> **而缓存条目数本身无上界 → 单次成本也无上界。**
>
> **这是一个正反馈**：条目越多 → 扫描越慢 → 测量越多 → 条目更多。

### 4.4 扫描失败的原因有文档说明

```cpp
// packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp:190-194
    // We consider the layout to be reusable, if our content measurement,
    // combined with padding/border (not snapped) exactly corresponds to the
    // measurement of the node, before layout rounding. We may not find a
    // compatible layout, such as if Yoga already knew the dimensions (an
    // exact width/height was given), or if our content measurement was
    // adjusted by a constraint (like min-size).
```

**注释列出两种必然未命中的场景**：

| # | 场景 | 后果 |
| --- | --- | --- |
| ① | Yoga 已从**显式 width/height** 得知尺寸 | 无需调 measure → 缓存不增长但也不被读 |
| ② | 内容测量被 **min-size 等约束调整过** | 每次都未命中 → **持续增长** |

> **场景 ② 是持续增长的触发条件** ——
> 即「内容尺寸与节点尺寸被约束解耦」的场景（如 `minHeight` + 文本高度较小时）
> 会让每一轮布局都新增一条缓存。

### 4.5 `assert_valid_size` 的位置

**注意它在 `push_back` 之后**：

```cpp
      measuredLayouts_.push_back(...);
      assert_valid_size(measurement.size, layoutConstraints);
      return measurement.size;
```

> **即「无效尺寸」的条目已经被存进缓存了**，断言在之后才检查。
> **对照 50 文档 PP-3（先减后查）** —— **同一模式：`assert` 在破坏性操作之后。**

### 4.6 `preparedTextCache_` 是有界的（对照组）

**另一个文本缓存由 feature flag 定容**：

| 缓存 | 容器 | 上界来源 |
| --- | --- | --- |
| `measuredLayouts_` | `vector` | ❌ **无** |
| `preparedTextCache_` | — | ✅ **`ReactNativeFeatureFlags::preparedTextCacheSize()`** |

> **同一模块内两个缓存，一个有界一个无界。**
> **这说明「加个 size 上界」的做法在本模块是被认可的**，
> `measuredLayouts_` 只是没被加上。

---

## 5. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| SS-1 | **`LayoutMetrics::operator==` 是 `= default`（比 10 个成员）而 `hash<>` 只哈希 8 个，漏掉 `positionType` 与 `wasLeftAndRightSwapped`** | `renderer/core/LayoutMetrics.h:92`、`:117-130`、`:36`、`:42` | **仅 `positionType` 或 `wasLeftAndRightSwapped` 不同的两个值哈希相同**；正确性不受影响，**哈希质量退化**；并经 `ShadowView::hash` 嵌套传导 |
| SS-2 | `ShadowView::operator==` 比 `componentName` 而 `hash<>` 哈希 `componentHandle` —— **字段集方向相反地差一项** | `renderer/mounting/ShadowView.cpp:34-51`；`ShadowView.h:66-79` | **当前不违规**（注册表保证 handle↔name 双射，`ComponentDescriptorRegistry.cpp:41-46` 有两处断言）；但正确性来自**另一个文件的不变量**，属结构脆弱 |
| SS-3 | **`operator==` 对 `ComponentName` 做的是 `const char*` 指针比较，不是字符串比较** | `renderer/core/ReactPrimitives.h:43`；`ShadowView.cpp:38`、`:45` | **依赖链接器合并同名字符串字面量**；若不复用则相等判定失效 |
| SS-4 | **【核心】Yoga 测量消毒只拒 NaN 与负数，`±inf` 原样放行**；且消毒函数 `maxOrDefined(0.0f, inf)` 也返回 `inf` | `yoga/node/Node.cpp:67-80`；`yoga/numeric/Comparison.h:35-42`、`:18-20` | **release 构建下对无穷测量结果无防护**，巨大/无穷尺寸直接进入布局 |
| SS-5 | RN 侧对测量结果的边界检查被 `#ifdef REACT_NATIVE_DEBUG` 包住 | `YogaLayoutableShadowNode.cpp` 的边界检查 | **release 下该检查不存在** |
| SS-6 | **【核心】`measuredLayouts_` 无上界、无淘汰、无清空；每次测量两次 O(n) 线性扫描** | `renderer/components/text/ParagraphShadowNode.h:140`；`.cpp:196`、`:226`、`:253` | **单次测量成本随缓存条目数线性增长**；条目数无上界 → 成本无上界（正反馈） |
| SS-7 | `assert_valid_size` 在 `push_back` **之后**才检查 | `renderer/components/text/ParagraphShadowNode.cpp:253-259` | **无效尺寸的条目已进入缓存**（与 50 文档 PP-3 同型） |
| SS-8 | `inexactEquals` 的阈值在 `float`/`double` 两个重载里各写死一次（`0.0001f` / `0.0001`），连注释里也重复了一次，共 3 处字面量 | `yoga/numeric/Comparison.h:54-66` | **改一处不会同步另一处** |
| SS-9 | `CalculateLayout.cpp:1113` 的除法前 epsilon（`1e-6f`）与 `Comparison.h` 的比较容差（`0.0001f`）是两个独立写死的量，相差 100 倍 | `yoga/algorithm/CalculateLayout.cpp:1113`；`numeric/Comparison.h:56` | 两者用途不同（近零守卫 vs 结果容差），**但都在各自位置硬编码，无共享常量** |

### SS-4 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | iOS / Android / Windows / macOS（Yoga 是跨平台 vendored） |
| **架构** | 新旧架构共用（Yoga 是唯一布局引擎） |
| **触发条件** | 应用侧 `measure` 函数（或 RN 内置 measure 函数）返回 `+inf` |
| **Yoga 侧防护** | 始终生效，但**只挡 NaN 与负数** |
| **RN 侧防护** | **仅 debug 编译** |
| **release 下净防护** | **无** |

### SS-6 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **编译期前置** | `TextLayoutManagerExtended::supportsPreparedTextLayout()` 为真（`if constexpr`） |
| **运行期前置** | `ReactNativeFeatureFlags::enablePreparedTextLayout()` 为真 |
| **增长触发条件** | 内容测量与节点尺寸**被 min-size 等约束解耦**（`.cpp:190-194` 注释的第二种场景） |
| **成本** | 单次测量 O(条目数)，**条目数无上界** |
| **与内容规模的关系** | 长文本 + 多约束 → 条目多 → 扫描慢 |

---

## 6. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 09 文档：渲染器核心与差分算法 | **补上值语义的正确性基础**：哈希/相等字段集（§1）与 Yoga 的数值消毒（§2） |
| 46 文档：`dirty()` 的 inline view 断链是「自认的边界」 | **同型**：SS-4 的 `±inf` 放行虽未被注释承认，但 §2.4 指出了 RN 侧检查只在 debug —— **属「防护不完整」** |
| 48 文档：区分「历史承诺 / 自认边界 / 结构脆弱」三类 | **新增 SS-2 为「结构脆弱」的第三例**：正确性来自 `ComponentDescriptorRegistry.cpp` 的一个不变量 |
| 48 文档：`qualifiedMove` 命名与语义相反 | **同类的可读性问题**：SS-8 的注释自称 `hardcoded`，等于承认是技术债 |
| 50 文档 PP-3：`countJsArgs - 2` 先回绕再 `CHECK` | **同型**：SS-7 的 `assert_valid_size` 在 `push_back` 之后 —— **断言晚于破坏性操作** |
| 42 文档：内容增长过快的检测原理 | **新增一处与内容量线性相关的成本**：SS-6 的两次线性扫描 |
| 52 文档 RR-1：字段顺序被隐式依赖 | **同型的脆弱契约**：SS-2 的 `handle ↔ name` 双射是另一处跨文件隐式契约 |
| 53 文档 §3.2：eps `1e-6f` vs `1e-4` 是两个独立量 | **SS-9 固化该结论**：两者用途不同但都硬编码，量级差 100 倍 |