---
id: 61
title: "ScrollView 的状态与裁剪：iOS 独有的 RTL 修正、三处生命周期钩子的正确配对、一个钉死 commit 的注释链接"
topic: RN.widget
symptoms: [layout]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["ScrollViewShadowNode", "CullingContext"]
claims: [AAA-1, AAA-2, AAA-4, AAA-5, AAA-6, AAA-10, AAA-11]
---
# 61 · ScrollView 的状态与裁剪：iOS 独有的 RTL 修正、三处生命周期钩子的正确配对、一个钉死 commit 的注释链接

> **模块**：A2 + C2 ·
> `packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewShadowNode.cpp`（80）、
> `renderer/mounting/internal/CullingContext.cpp`、
> `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/MaintainVisibleScrollPositionHelper.kt`（166）、
> `ReactAndroid/.../scroll/ReactScrollView.kt:397-455`
>
> **基线**：react-native @ `9b131e42` · 双端 · **Fabric 新架构**
>
> **前置**：[32 文档](./32-Fabric组件层ScrollView粘性状态.md) 记录 ScrollView 组件层的粘性状态；
> [60 文档](./60-View组件原语层的位号与枚举.md) 记录 View 组件原语层；
> [45 文档](./45-Android-ViewManager属性缓存与回收契约.md) 记录回收契约。
>
> 本文记录三条：
> ① **`updateScrollContentOffsetIfNeeded` 整体在 `#ifndef ANDROID` 内** ——
> RTL 的内容偏移修正在 Android 侧不存在，而**裁剪侧的同类修正在 C++ 层是跨平台的**；
> ② **Android 侧「保持可见内容位置」的三个生命周期钩子全部正确配对**（本文的正向样本）；
> ③ **`CullingContext.cpp` 用钉死 commit 的 GitHub 链接做注释参考** ——
> 这是本仓库最好的外部引用形式，且**已验证该 commit 在本仓库存在**。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewShadowNode.cpp` | 80 | 内容包围盒 + RTL 修正 |
| `packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewState.h` | 62 | 状态结构 + 序列化 |
| `packages/react-native/ReactCommon/react/renderer/mounting/internal/CullingContext.cpp` | — | 裁剪上下文计算（含 RTL 翻转） |
| `packages/react-native/ReactCommon/react/renderer/mounting/internal/CullingContext.cpp` | — | 裁剪上下文计算（含 RTL 翻转） |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/MaintainVisibleScrollPositionHelper.kt` | 166 | 滚动位置保持（Android） |

---

## 2. 【核心 AAA-1】RTL 内容偏移修正只存在于 iOS

### 2.1 整个函数被平台条件包住

```cpp
// packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewShadowNode.cpp:33-48
void ScrollViewShadowNode::updateScrollContentOffsetIfNeeded() {
#ifndef ANDROID
  if (getLayoutMetrics().layoutDirection == LayoutDirection::RightToLeft) {
    // Yoga places `contentView` on the right side of `scrollView` when RTL
    // layout is enforced. To correct for this, in RTL setting, correct the
    // frame's origin. React Native Classic does this as well in
    // `RCTScrollContentShadowView.m`.
    for (auto layoutableNode : getLayoutableChildNodes()) {
      auto layoutMetrics = layoutableNode->getLayoutMetrics();
      if (layoutMetrics.frame.origin.x != 0) {
        layoutMetrics.frame.origin.x = 0;
        layoutableNode->setLayoutMetrics(layoutMetrics);
      }
    }
  }
#endif
}
```

**函数体（含 `if` 与 `for`）全部在 `#ifndef ANDROID` 内** ——
**Android 编译出的 `updateScrollContentOffsetIfNeeded()` 是一个空函数。**

### 2.2 注释给出的三条信息

| # | 注释内容 | 价值 |
| --- | --- | --- |
| ① | `Yoga places 'contentView' on the right side of 'scrollView' when RTL layout is enforced` | **说明现象与成因**（Yoga 在 RTL 下把内容放到右侧） |
| ② | `To correct for this, in RTL setting, correct the frame's origin` | 说明做法 |
| ③ | `React Native Classic does this as well in 'RCTScrollContentShadowView.m'` | **跨版本参照** |

**注释 ③ 引用的文件不存在**（见 §2.5）。

### 2.3 修正的机制

```cpp
      if (layoutMetrics.frame.origin.x != 0) {
        layoutMetrics.frame.origin.x = 0;
        layoutableNode->setLayoutMetrics(layoutMetrics);
      }
```

| 特征 | 说明 |
| --- | --- |
| 只改 `origin.x` | 不改 `origin.y`、不改尺寸 |
| 有 `!= 0` 守卫 | 已是 0 时**跳过 `setLayoutMetrics`**，避免无谓的状态变更 |
| 遍历所有 layoutable 子节点 | 而非只改第一个 |

**`!= 0` 守卫是有意义的**：它避免了「重复设置相同值」触发不必要的
`setLayoutMetrics` → 布局失效 → 重新布局。

### 2.4 Android 侧的对应实现：检索结果为零

| 检索 | 范围 | 命中 |
| --- | --- | --- |
| `RightToLeft` / `LayoutDirection` | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/` | **0** |

**即 Android 的 ScrollView 目录里没有任何布局方向判断。**

### 2.5 注释 ③ 引用的文件不存在

**全仓检索 `RCTScrollContentShadowView`**：

| 位置 | 性质 |
| --- | --- |
| `packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewShadowNode.cpp` | **注释里的引用本身** |

**即除该注释外全仓零命中** —— `RCTScrollContentShadowView.m` 不在本仓库中
（它属于 legacy 的 `React/Views/ScrollView/`，已随 legacy 移除或从未包含）。

> **这是 59 文档 YY-3 的第二个实例**：
> **注释引用的文件在本仓库不存在**，且**原因是它属于已被移除的 legacy 层**。
>
> | | 59 文档 `createErrorFromErrorData` | 本文 `RCTScrollContentShadowView.m` |
> | --- | --- | --- |
> | 失效原因 | **对方改名** | **对方整层被移除** |
> | 读者后果 | 找不到函数 | **找不到文件** |
>
> **两类都让注释失去导航价值，但后者更严重** —— 因为它暗示「这个参照物应该存在」。

### 2.6 但**裁剪侧**的同类修正是跨平台的

**关键对照** —— `CullingContext.cpp` 里的 RTL 处理**没有平台条件**：

```cpp
// packages/react-native/ReactCommon/react/renderer/mounting/internal/CullingContext.cpp:51-61
        if (layoutMetrics.layoutDirection == LayoutDirection::RightToLeft) {
          // In RTL, content offset is flipped horizontally.
          // We need to flip the culling context frame to match.
          // See:
          // https://github.com/facebook/react-native/blob/c2f39cfdd87c32b9a59efe8a788b8a03f02b0ea0/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm#L579
          auto stateData = scrollViewShadowNode->getStateData();
          cullingContext.frame.origin.x =
              stateData.contentBoundingRect.size.width -
              layoutMetrics.frame.size.width - cullingContext.frame.origin.x;
        }
```

**这段在 `adjustCullingContextIfNeeded` 内，无 `#if` 门控** —— **双端都执行。**

### 2.7 两处 RTL 处理解决的是**不同问题**

| | `ScrollViewShadowNode`（iOS only） | `CullingContext`（双端） |
| --- | --- | --- |
| **改什么** | **子节点的 `layoutMetrics.frame.origin.x` → 0** | **裁剪上下文的 `frame.origin.x`** |
| **目的** | 让内容实际贴在左边（视觉） | 让裁剪计算与实际偏移一致（性能/正确性） |
| **平台** | **仅 iOS** | **双端** |
| **后果（Android 无前者）** | 内容在 RTL 下可能仍按 Yoga 的右侧定位 | 裁剪仍正确 |

> **诚实结论（不夸大）**：
>
> | 问题 | 判定 |
> | --- | --- |
> | 平台条件是否真实存在 | **是** —— Android 侧为空函数 |
> | 是否一定导致视觉 bug | **未确认** —— Android 可能在 Fabric mounting 层或 View 层另行处理 |
> | 是否一定有影响 | **裁剪侧跨平台，故裁剪不会错**；**视觉侧需实机验证** |
>
> **本文不主张这是 bug，只记录「同一语义的处理在两个层面平台条件不一致」这一事实。**
> **本轮对 Android 侧 `views/scroll/` 的检索未找到 `LayoutDirection`，但不能排除其他目录（如 `fabric/`）有处理。**

### 2.8 AAA-1 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | **仅 Android 缺失**；iOS 正常 |
| **架构** | Fabric（`ShadowNode` 层） |
| **触发条件** | `layoutDirection == RightToLeft` **且** 子节点的 `frame.origin.x != 0` |
| **可观测性** | RTL 语言下的水平滚动位置；**本轮未实机验证** |
| **裁剪侧** | **双端一致**，不受影响 |

---

## 3. 【核心 AAA-2】裁剪上下文的三个 feature flag 与一个钉死 commit 的链接

### 3.1 裁剪的三重门控

```cpp
// packages/react-native/ReactCommon/react/renderer/mounting/internal/CullingContext.cpp:12-19
bool CullingContext::shouldConsiderCulling() const {
  return frame.size.width > 0 && frame.size.height > 0;
}

CullingContext CullingContext::adjustCullingContextIfNeeded(
    const ShadowViewNodePair& pair) const {
  auto cullingContext = *this;
  if (ReactNativeFeatureFlags::enableViewCulling()) {
```

**门控序列**：

| # | 条件 | 位置 |
| --- | --- | --- |
| ① | `frame.size.width > 0 && frame.size.height > 0` | `:14` |
| ② | **`ReactNativeFeatureFlags::enableViewCulling()`** | `:18` |
| ③ | `overflow() != yoga::Overflow::Visible` | `:22-23` |
| ④ | `!getStateData().disableViewCulling` | `:24` |

**四条门控里三条是条件、一个是 feature flag** ——
即**裁剪功能整体可被 flag 关闭**。

### 3.2 `outsetRatio` 的整数截断

```cpp
// packages/react-native/ReactCommon/react/renderer/mounting/internal/CullingContext.cpp:37-47
        // Enlarge the frame if an outset ratio is defined
        auto outsetRatio = ReactNativeFeatureFlags::viewCullingOutsetRatio();
        if (outsetRatio > 0) {
          auto xOutset = static_cast<float>(
              floor(cullingContext.frame.size.width * outsetRatio));
          auto yOutset = static_cast<float>(
              floor(cullingContext.frame.size.height * outsetRatio));
          cullingContext.frame.origin.x -= xOutset;
          cullingContext.frame.origin.y -= yOutset;
          cullingContext.frame.size.width += 2.0f * xOutset;
          cullingContext.frame.size.height += 2.0f * yOutset;
        }
```

| 特征 | 说明 |
| --- | --- |
| flag 名 | `viewCullingOutsetRatio()`（**运行时可配置**） |
| 取整方式 | **`floor`**（向下取整） |
| 语义 | 裁剪区域向外扩张的比例（**预取缓冲区**） |
| 变换 | 四条对称修改：origin 各减、size 各加 `2 × outset` |

> **`floor` 而非 `round`** —— **向外扩张用向下取整是保守的**
> （宁少扩一点，不多扩），
> **与「裁剪」语义一致：少裁剪只是多画几个节点，多裁剪会丢内容。**
>
> **这是一处有意的、安全的方向选择**（虽无注释说明）。

### 3.3 钉死 commit 的注释链接 —— **已验证该 commit 存在**

**注释内容**：

```
// https://github.com/facebook/react-native/blob/c2f39cfdd87c32b9a59efe8a788b8a03f02b0ea0/packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm#L579
```

**URL 结构**：

| 段 | 值 | 作用 |
| --- | --- | --- |
| `blob/` | `c2f39cfdd87c32b9a59efe8a788b8a03f02b0ea0` | **钉死 40 位完整 SHA** |
| 路径 | `.../React/Fabric/Mounting/ComponentViews/ScrollView/RCTScrollViewComponentView.mm` | 精确到文件 |
| 行锚点 | **`#L579`** | 精确到行 |

**实测验证**：`git cat-file -t c2f39cfdd87c32b9a59efe8a788b8a03f02b0ea0` → **`commit`**

> **即该 commit 在本仓库历史中存在，链接不会失效。**
>
> **这是本仓库见到的最好的外部引用形式**，与 38 文档「第一档注释 = 理由 + 外部参考」完全吻合：
>
> | 要素 | 本例 |
> | --- | --- |
> | 理由 | 前 3 行（`In RTL, content offset is flipped horizontally. / We need to flip the culling context frame to match.`） |
> | 外部参考 | **钉死 SHA + 精确行号** |
> | 可验证性 | ✅ **实测通过** |
>
> **与 §2.5 的 `RCTScrollContentShadowView.m` 对照**：
> **同一语义、同一文件、两种引用质量** ——
> 一处钉死 SHA 且可验证，一处只给文件名且文件不存在。
>
> **这说明团队具备写出高质量引用的能力**（AAA-3 证明），
> **但引用规范未统一**（AAA-5 说明）。

### 3.4 非 ScrollView 节点的通用分支

```cpp
// packages/react-native/ReactCommon/react/renderer/mounting/internal/CullingContext.cpp:62-79
    } else if (pair.shadowView.traits.check(
                   ShadowNodeTraits::Trait::RootNodeKind)) {
      cullingContext = {};
    } else {
      cullingContext.frame.origin -= pair.shadowView.layoutMetrics.frame.origin;

      if (auto layoutableShadowNode =
              dynamic_cast<const LayoutableShadowNode*>(pair.shadowNode)) {
        cullingContext.transform =
            cullingContext.transform * layoutableShadowNode->getTransform();
      }
    }
```

**三分支**：

| 分支 | 条件 | 行为 |
| --- | --- | --- |
| ① 已是 ScrollView | `dynamic_cast<ScrollViewShadowNode*>` 成功 | 按 §3.1 处理 |
| ② 根节点 | `traits.check(Trait::RootNodeKind)` | **清空**（`= {}`） |
| ③ 普通节点 | 其余 | **累加原点偏移 + 累乘 transform** |

**分支 ③ 的 transform 累乘与 58 文档 XX-2 的 `Rect` 变换相呼应** ——
**命中测试用 4 角包围盒，裁剪用累乘矩阵** ——
**同一份 transform 在两处走不同算法**（因为目标形状不同：点/矩形 vs 轴对齐框）。

### 3.5 `contentBoundingRect` 的两个用途

**由 `ScrollViewShadowNode::updateStateIfNeeded` 计算**：

```cpp
// packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewShadowNode.cpp:18-32
void ScrollViewShadowNode::updateStateIfNeeded() {
  ensureUnsealed();

  auto contentBoundingRect = Rect{};
  for (const auto& childNode : getLayoutableChildNodes()) {
    contentBoundingRect.unionInPlace(childNode->getLayoutMetrics().frame);
  }

  auto state = getStateData();

  if (state.contentBoundingRect != contentBoundingRect) {
    state.contentBoundingRect = contentBoundingRect;
    setStateData(std::move(state));
  }
}
```

| 特征 | 说明 |
| --- | --- |
| **必须先 `ensureUnsealed()`** | 修改状态要求节点未封口 |
| 遍历**全部** layoutable 子节点 | O(children) |
| `unionInPlace` 累积 | 求包围盒 |
| **有 `!=` 守卫** | **包围盒不变则不 `setStateData`** —— 避免无谓的更新 |
| `std::move(state)` | 避免拷贝 |

**两个用途**：

| # | 用途 | 位置 |
| --- | --- | --- |
| ① | `getContentSize()` | `packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewState.cpp:21` |
| ② | **RTL 裁剪翻转的基准宽度** | `packages/react-native/ReactCommon/react/renderer/mounting/internal/CullingContext.cpp:59-60` |

### 3.5.1 `ScrollViewState.cpp` 全文只有 24 行，且构造器无平台门控

```cpp
// packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewState.cpp:12-22
ScrollViewState::ScrollViewState(
    Point contentOffset,
    Rect contentBoundingRect,
    int scrollAwayPaddingTop)
    : contentOffset(contentOffset),
      contentBoundingRect(contentBoundingRect),
      scrollAwayPaddingTop(scrollAwayPaddingTop) {}

Size ScrollViewState::getContentSize() const {
  return contentBoundingRect.size;
}
```

| 项 | 实测 | 说明 |
| --- | --- | --- |
| 文件总行数 | **24** | 其中版权头 6 行、`#include` 1 行、`namespace` 2 行 |
| 构造函数 | **1 个**（三参转发） | **无 `#ifdef` 门控** —— 与 §3.6 的反序列化构造器不同，后者整体在 `#ifdef RN_SERIALIZABLE_STATE` 内 |
| 成员函数 | **1 个**（`getContentSize`） | 直接返回 `contentBoundingRect.size`，**不做空矩形特判** |
| `contentBoundingRect` 的空值来源 | `Rect{}` 默认构造 | `updateStateIfNeeded` 里显式初始化为 `Rect{}`，**空矩形是合法初值**（而非哨兵值） |

> **`getContentSize` 对空矩形无特判** —— 若 `updateStateIfNeeded` 尚未跑过
> （子节点为空时 `unionInPlace` 保持 `Rect{}`），
> 返回的是 `Size{0, 0}` 而非「未初始化」标记。
>
> **配合 §3.6 的「反序列化后 `contentBoundingRect` 为 `{}`」** ——
> **即冷启动恢复状态后、布局重算前，`getContentSize()` 返回零值**，
> 且**调用方无法区分「真的没有内容」与「还没算」**。
> 本轮未找到该区分的调用点，故**只记录事实、不判定为缺陷**。

> **`!=` 守卫是本函数的关键设计** ——
> `updateStateIfNeeded` 在每次布局后调用，
> 若无守卫则**每次布局都会产生一次状态变更**，
> 引发「状态变更 → 重布局 → 再调用」的**潜在循环**。
> **守卫把「不变」的情况短路掉，切断了循环。**
>
> **对照 51 文档 QQ-1 的「复位点覆盖不全」**：这里是「更新点有守卫」，是正确的方向。

### 3.6 序列化时被丢弃

```cpp
// packages/react-native/ReactCommon/react/renderer/components/scrollview/ScrollViewState.h:51-53
        contentBoundingRect({}),
        scrollAwayPaddingTop((Float)data["scrollAwayPaddingTop"].getDouble()) {};
```

| 字段 | 反序列化后 |
| --- | --- |
| `contentOffset` | ✅ 从 `data` 读 |
| `contentBoundingRect` | **`{}`（空）** |
| `scrollAwayPaddingTop` | ✅ 从 `data` 读 |

**`contentBoundingRect` 不参与序列化**（从 `{}` 起步），
**因为它是可从子节点重算的派生量** —— `updateStateIfNeeded` 会重新计算。

**且 `getDynamic` 只写 3 个键**（`contentOffsetLeft`、`contentOffsetTop`、`scrollAwayPaddingTop`）——
**与读侧一致，无往返缺失。**

---

## 4. 【核心 AAA-3·正向】Android 滚动位置保持：三处生命周期钩子全部正确

### 4.1 三个钩子

| 钩子 | 位置 | 动作 |
| --- | --- | --- |
| `onAttachedToWindow` | `ReactScrollView.kt:444-450` | **`maintainVisibleContentPositionHelper?.start()`** |
| `onDetachedFromWindow` | `ReactScrollView.kt:452-455` | **`maintainVisibleContentPositionHelper?.stop()`** |
| `setMaintainVisibleContentPosition` | `ReactScrollView.kt:397-409` | 按 config 的 null/non-null 创建或销毁 |

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/ReactScrollView.kt:444-455
  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    if (_removeClippedSubviews) {
      updateClippingRect()
    }
    maintainVisibleContentPositionHelper?.start()
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    maintainVisibleContentPositionHelper?.stop()
  }
```

**`start()` 与 `stop()` 精确配对在窗口挂载/卸载上** —— 这是正确的生命周期边界。

### 4.2 `setMaintainVisibleContentPosition` 的四个分支

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/ReactScrollView.kt:397-409
  internal open fun setMaintainVisibleContentPosition(
      config: MaintainVisibleScrollPositionHelper.Config?,
  ) {
    if (config != null && maintainVisibleContentPositionHelper == null) {
      maintainVisibleContentPositionHelper =
          MaintainVisibleScrollPositionHelper(this, false).also { it.start() }
    } else if (config == null && maintainVisibleContentPositionHelper != null) {
      maintainVisibleContentPositionHelper?.stop()
      maintainVisibleContentPositionHelper = null
    }
    maintainVisibleContentPositionHelper?.let { it.config = config }
  }
```

| 分支 | 条件 | 动作 |
| --- | --- | --- |
| ① 创建 | `config != null && helper == null` | `new` + **立即 `start()`** |
| ② 销毁 | `config == null && helper != null` | **`stop()`** + 置 `null` |
| ③ 都不满足 | 二者都非 null 或 都为 null | 落到最后一行更新 config |

**分支 ③ 的两种情形**：

| 情形 | 最后一行的效果 |
| --- | --- |
| `config != null && helper != null` | **只更新 config**（复用已有 helper） |
| `config == null && helper == null` | `?.let` 不进入，无操作 |

**即「两个维度（是否创建、config 值）正交处理」** —— 这是正确的组合方式。

### 4.3 `start`/`stop` 都幂等

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/MaintainVisibleScrollPositionHelper.kt:73-88
  fun start() {
    if (isListening) {
      return
    }
    isListening = true
    uIManager.addUIManagerEventListener(this)
  }

  /** Stop listening to view hierarchy updates. Should be called before this is destroyed. */
  fun stop() {
    if (!isListening) {
      return
    }
    isListening = false
    uIManager.removeUIManagerEventListener(this)
  }
```

| 函数 | 守卫 | 效果 |
| --- | --- | --- |
| `start()` | `if (isListening) return` | 重复 `start()` 不会重复注册监听 |
| `stop()` | `if (!isListening) return` | 重复 `stop()` 不会重复注销 |

**两侧都有守卫** —— 结合 §4.1 的三处钩子，**即使某条路径重复调用也不会重复注册**。

**`stop()` 的 KDoc 说明了调用契约**：

```
/** Stop listening to view hierarchy updates. Should be called before this is destroyed. */
```

### 4.4 锚点视图用弱引用

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/MaintainVisibleScrollPositionHelper.kt:42
  private var firstVisibleViewRef: WeakReference<View>? = null;
```

| 项 | 说明 |
| --- | --- |
| 类型 | **`WeakReference<View>?`** |
| 理由 | 锚点是列表中的某个子 View，**不应因保持滚动位置而被延长生命周期** |

**这是正确的选择** —— 若用强引用，被锚定的 View 在被回收后会一直存活。

**消费处有 4 层判空**：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/MaintainVisibleScrollPositionHelper.kt:90-95
  private fun updateScrollPositionInternal() {
    val config = config ?: return
    val firstVisibleViewRef = firstVisibleViewRef ?: return
    val prevFirstVisibleFrame = prevFirstVisibleFrame ?: return
    val firstVisibleView = firstVisibleViewRef.get() ?: return
    val scrollView = scrollView ?: return
```

| # | 判空对象 | 失败场景 |
| --- | --- | --- |
| ① | `config` | 未设置 config |
| ② | `firstVisibleViewRef` | 尚未 `computeTargetView()` |
| ③ | `prevFirstVisibleFrame` | 尚未记录基准帧 |
| ④ | `firstVisibleViewRef.get()` | **锚点 View 已被 GC** |
| ⑤ | `scrollView` | ScrollView 已销毁 |

**⑤ 层判空逐个 `?: return`**，**无一处抛异常** —— 与 50 文档 PP-1/PP-3 的「防御不足」形成对照。

### 4.5 三个 UIManager 回调：两个 noop

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/scroll/MaintainVisibleScrollPositionHelper.kt:146-165
  // UIManagerListener
  override fun willDispatchViewUpdates(uiManager: UIManager) {
    runOnUiThread { computeTargetView() }
  }

  override fun willMountItems(uiManager: UIManager) {
    computeTargetView()
  }

  override fun didMountItems(uiManager: UIManager) {
    updateScrollPositionInternal()
  }

  override fun didDispatchMountItems(uiManager: UIManager) {
    // noop
  }

  override fun didScheduleMountItems(uiManager: UIManager) {
    // noop
  }
```

**五个回调的分配**：

| 回调 | 动作 |
| --- | --- |
| `willDispatchViewUpdates` | `runOnUiThread { computeTargetView() }` |
| `willMountItems` | `computeTargetView()` |
| `didMountItems` | `updateScrollPositionInternal()` |
| `didDispatchMountItems` | **`// noop`** |
| `didScheduleMountItems` | **`// noop`** |

**两个 noop 有显式标记** —— **这是正确的「接口要求实现但本类不需要」写法**
（与 40 文档记录的 114 个 marker 中 38 个零引用形成对照：
**这里零引用的是方法体，但有注释说明**）。

> **`willDispatchViewUpdates` 里的 `runOnUiThread`** 与 `willMountItems` 的直接调用构成一对：
>
> | 回调 | 线程 | 理由 |
> | --- | --- | --- |
> | `willDispatchViewUpdates` | **切到 UI 线程** | 该回调可能来自非 UI 线程 |
> | `willMountItems` | **已在 UI 线程**，直接调 | 挂载阶段在 UI 线程 |
>
> **即两个「计算目标视图」的时机用了不同的线程处理方式**，
> **但均无注释说明**（这是本文记录的 AAA-6）。

---

## 5. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **AAA-1** | **【核心】`updateScrollContentOffsetIfNeeded` 整体在 `#ifndef ANDROID` 内 —— Android 编译出空函数**；而**裁剪侧的同类 RTL 修正在 C++ 层是跨平台的** | `ScrollViewShadowNode.cpp:33-48`；`CullingContext.cpp:51-61` | **同一语义的处理在两个层面平台条件不一致**；Android 的 RTL 视觉行为**未实机验证**，**裁剪侧确定不受影响** |
| **AAA-2** | **注释引用的 `RCTScrollContentShadowView.m` 全仓不存在**（除该注释本身） | `ScrollViewShadowNode.cpp:40-41` | **注释暗示参照物应存在**；属 59 文档 YY-3 的「对方整层被移除」变体 |
| **AAA-3（正向）** | **`CullingContext.cpp:54-56` 用钉死 40 位 SHA + `#L579` 行锚点的 GitHub 链接做注释参考**，且**实测该 commit 在本仓库存在** | `CullingContext.cpp:54-56` | **本仓库最好的外部引用形式**；与 38 文档「第一档注释」完全吻合 |
| AAA-4 | `outsetRatio` 的扩张用 `floor`（向下取整）而非 `round` | `CullingContext.cpp:40-42` | **方向是保守且正确的**（少裁剪只是多画，多裁剪会丢内容），**但无注释说明** |
| AAA-5 | 同一语义、同一文件、**两种引用质量并存**（§3.3 钉死 SHA 可验证 vs §2.5 只给文件名且不存在） | `CullingContext.cpp:54` vs `ScrollViewShadowNode.cpp:40` | **说明团队有能力写高质量引用，但规范未统一** |
| AAA-6 | `willDispatchViewUpdates` 用 `runOnUiThread` 而 `willMountItems` 直接调用，两者都是「计算目标视图」但线程处理不同，**均无注释** | `MaintainVisibleScrollPositionHelper.kt:146-153` | 行为正确，但意图不可从代码直接读出 |
| AAA-7（正面） | **`start()`/`stop()` 双向幂等 + 三处生命周期钩子正确配对（`onAttachedToWindow`/`onDetachedFromWindow`/`setMaintainVisibleContentPosition`）** | `ReactScrollView.kt:397-409`、`:444-455`；`MaintainVisibleScrollPositionHelper.kt:73-88` | **本仓库生命周期管理的正样本** |
| AAA-8（正面） | **锚点视图用 `WeakReference`**，消费处 **5 层 `?: return` 判空**，无一处抛异常 | `MaintainVisibleScrollPositionHelper.kt:42`、`:90-95` | 与 50 文档 PP-1/PP-3 的「防御不足」形成对照 |
| AAA-9（正面） | `updateStateIfNeeded` 的 `!=` 守卫切断「状态变更 → 重布局 → 再调用」的潜在循环 | `ScrollViewShadowNode.cpp:28-31` | 与 51 文档 QQ-1 的「复位点覆盖不全」相反：**更新点有守卫** |
| AAA-10 | 两个 UIManager 回调是 `// noop`，**有注释标记** | `MaintainVisibleScrollPositionHelper.kt:159-165` | 正确写法；与 40 文档「38 个零引用 marker」对照：**零引用但有说明** |
| AAA-11 | `contentBoundingRect` 不参与序列化（从 `{}` 起步），因可从子节点重算 | `ScrollViewState.h:51-53` | **设计正确**（派生量不持久化）；`getDynamic` 写的 3 键与读侧一致 |

### AAA-1 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | **Android 缺失该修正**；iOS 正常 |
| **架构** | Fabric |
| **触发条件** | `layoutDirection == RightToLeft` **且** 子节点 `frame.origin.x != 0` |
| **受影响的是** | **水平滚动位置（视觉）** |
| **不受影响** | **裁剪**（`CullingContext` 跨平台处理） |
| **是否确认为 bug** | **未确认** —— Android 可能在其他目录另行处理；本轮对 `views/scroll/` 的检索为 0，但未覆盖 `fabric/` |

---

## 6. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 32 文档：ScrollView 组件层与粘性状态 | **补上状态计算与裁剪两条路径**，并给出平台条件对照 |
| 60 文档 §3.3：`Rectangle*` / `Cascaded*` 两套别名有语义区分 | **本文 AAA-11**：`contentBoundingRect` 不序列化同样是「派生量不持久化」的同类设计决策 |
| 59 文档 YY-3：注释锚点失效（对方改名） | **新增第二类**：**对方整层被移除**（`RCTScrollContentShadowView.m`），读者后果更严重 |
| 38 文档：第一档注释 = 理由 + 外部参考 | **给出最佳实例**（AAA-3，钉死 SHA + 行锚点 + 已验证存在）与同文件内的反例（AAA-5） |
| 51 文档 QQ-1：复位点覆盖不全 | **对照**：AAA-9 是「更新点有守卫」，**方向相反且正确** |
| 50 文档 PP-1 / PP-3：JNI 层防御不足 | **对照**：AAA-8 的 5 层判空 + 弱引用是**防御充足**的正样本 |
| 40 文档：114 个 marker 中 38 个零引用 | **对照**：AAA-10 的两个 `// noop` 回调**有注释标记** —— 零实现但有说明 |
| 58 文档 XX-2：`Rect` 变换用 4 角包围盒 | **同一 transform 在两处走不同算法**：命中测试用包围盒（§3.4 分支③）、裁剪用累乘矩阵 —— 目标形状不同故算法不同 |