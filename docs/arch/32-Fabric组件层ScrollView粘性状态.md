---
id: 32
title: "Fabric 组件层（二）：ScrollView 的粘性状态与节流缺陷"
topic: RN.widget
symptoms: [layout]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["ScrollViewShadowNode", "ScrollViewState"]
claims: []
---
# 32 · Fabric 组件层（二）：ScrollView 的粘性状态与节流缺陷

> **模块**：A2 · `ComponentViews/ScrollView/`（4 文件 / 1942 行）+ `RCTEnhancedScrollView.mm`（319 行）
> **基线**：react-native @ `9b131e42` · Fabric
> **前置**：[31 文档](./31-Fabric组件层View与回收池.md) 记录了回收池机制与
> `RCTViewComponentView.prepareForRecycle` 的重置契约；
> [21 文档](./21-iOS-Fabric组件层与ComponentView.md) 记录了 `removeClippedSubviews`。
>
> 本文记录 **ScrollView 的「粘性状态」设计**（一个**故意**不重置、
> 一个**应该重置却没重置**），并给出后者的具体后果。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `ScrollView/RCTScrollViewComponentView.mm` | 1165 | **ScrollView 组件宿主** |
| `ScrollView/RCTEnhancedScrollView.mm` | 319 | **UIScrollView 子类** |
| `ScrollView/RCTPullToRefreshViewComponentView.mm` | 283 | 下拉刷新容器 |
| `ScrollView/RCTVirtualViewContainerState.mm` | 175 | 虚拟列表可见区状态 |

---

## 2. 回收时的重置清单

`RCTScrollViewComponentView.mm:684-713`：

```objc
- (void)prepareForRecycle
{
  [super prepareForRecycle];
  // Must invalidate state before setting contentOffset on ScrollView.
  // Otherwise the state will be propagated to shadow tree.
  _state.reset();

  const auto &props = static_cast<const ScrollViewProps &>(*_props);
  _scrollView.contentOffset = RCTCGPointFromPoint(props.contentOffset);
  // Reset zoom scale to default
  _scrollView.zoomScale = 1.0;
  // Invalidate cached content size so that updateState: recalculates the
  // container frame after zoomScale reset (which may have mutated it in RTL).
  _contentSize = CGSizeZero;
  _scrollView.contentInset = RCTUIEdgeInsetsFromEdgeInsets(props.contentInset);
  // We set the default behavior to "never" so that iOS
  // doesn't do weird things to UIScrollView insets automatically
  // and keeps it as an opt-in behavior.
  _scrollView.contentInsetAdjustmentBehavior = UIScrollViewContentInsetAdjustmentNever;
  _shouldUpdateContentInsetAdjustmentBehavior = YES;
  _automaticallyAdjustKeyboardInsets = NO;
  _isUserTriggeredScrolling = NO;
```

`:706-712` 的 frame 抖动有明确注释：

```objc
  CGRect oldFrame = self.frame;
  self.frame = CGRectZero;
  self.frame = oldFrame;
  _contentView = nil;
  _prevFirstVisibleFrame = CGRectZero;
  _firstVisibleView = nil;
  _firstVisibleViewTag = 0;
  _virtualViewContainerState = nil;
}
```

**注释解释了「先归零再还原」的用意** —— 强制 `layoutSubviews` 走一遍，
使 `updateState:` 能按新的 zoomScale 重算容器 frame（尤其 RTL 场景）。

### 2.1 `_state.reset()` 必须最先执行

`:687-689` 的注释点明了顺序约束：

> Must invalidate state before setting contentOffset on ScrollView. Otherwise the state will be **propagated to shadow tree**.

**即：若不先清 state，接下来设置 `contentOffset` 会把「回收时的偏移」上报到 Shadow 树**，
造成一次无意义的状态同步。

---

## 3. 【故意不重置】`_isAccessibilityAPIUsed`：粘性状态的设计

### 3.1 字段声明处的注释

`RCTScrollViewComponentView.mm:118-121`：

```objc
  // A flag indicating that accessibility API is used.
  // It is not restored to the default value in prepareForRecycle.
  // Once an accessibility API is used, view culling will be disabled for the entire session.
  BOOL _isAccessibilityAPIUsed;
```

**注释直接写明「不在 `prepareForRecycle` 中恢复」**，
且说明了后果：「整个 session 内视图裁剪都会被禁用」。

### 3.2 检测机制：用 API 调用而非通知

`:620-629`：

```objc
/**
 * When use of accessibility APIs is detected, view culling is disabled to make accessibility work correctly.
 */
- (void)_disableViewCullingIfNecessary
{
  if (!_isAccessibilityAPIUsed) {
    _isAccessibilityAPIUsed = YES;
    [self _updateStateWithContentOffset];
  }
}
```

`:631-649` 的注释解释了**为什么不用通知**：

> From empirical testing, method `accessibilityElementCount` is called lazily only when accessibility is used.
>
> **Why we don't use `UIAccessibilitySwitchControlStatusDidChangeNotification` and `UIAccessibilityVoiceOverStatusDidChangeNotification`?** The notifications are not called when using **Accessibility Inspector**. We anticipate developers will want to debug accessibility with Accessibility Inspector and don't want to break that developer workflow with view culling. Therefore, we are using **API use detection** to disable view culling instead of the notifications.

**这是一个权衡的完整记录**：

| 方案 | 问题 |
| --- | --- |
| 监听 VoiceOver/SwitchControl 通知 | **Accessibility Inspector 不发通知** → 开发者调试无障碍时被裁剪打断 |
| 覆写 API 方法检测使用 | 覆盖所有场景（VoiceOver、SwitchControl、Inspector、键盘导航） |

两个覆写点（`:640`、`:648`）：

```objc
- (NSInteger)accessibilityElementCount
{
  // From empirical testing, method `accessibilityElementCount` is called lazily only
  // when accessibility is used.
  ...
  [self _disableViewCullingIfNecessary];
  return [super accessibilityElementCount];
}

- (NSArray<id<UIFocusItem>> *)focusItemsInRect:(CGRect)rect
{
  // From empirical testing, method `focusItemsInRect:` is called lazily only
  // when keyboard navigation is used.
  [self _disableViewCullingIfNecessary];
  return [super focusItemsInRect:rect];
}
```

**`focusItemsInRect:` 对应键盘导航** —— 与
[31 文档 §5](./31-Fabric组件层View与回收池.md) 的无障碍判定同一主题。

### 3.3 粘性的作用域

**注意 `_isAccessibilityAPIUsed` 是实例变量，不是 static。**

| 读法 | 实际作用域 |
| --- | --- |
| 注释说「entire session」 | **仅当前 component view 实例的生命周期** |
| `prepareForRecycle` 不重置 | 该实例被回收后复用，仍保持 `YES` |

**因为 ScrollView 组件 view 本身也进回收池**（§2），
所以「整个 session」实际指的是「该 ScrollView 实例的整个存活期（含复用）」，
**不是全 App 的所有 ScrollView**。

> **这一点必须精确表述** ——
> 「整个 session」若读成「App 运行期间所有 ScrollView」是**错的**。
> 另一个 ScrollView 组件实例的 `_isAccessibilityAPIUsed` 仍是 `NO`。

### 3.4 `_updateStateWithContentOffset` 的短路优化

`:660-671`：

```objc
      [contentOffset, isAccessibilityAPIUsed](
          const ScrollViewShadowNode::ConcreteState::Data &oldData) -> ScrollViewShadowNode::ConcreteState::SharedData {
        if (oldData.contentOffset == contentOffset && oldData.disableViewCulling == isAccessibilityAPIUsed) {
          // avoid doing a state update if content offset and use of accessibility didn't change.
          return nullptr;
        }
```

**返回 `nullptr` 表示「无变化，不做状态更新」** ——
避免每次 `_disableViewCullingIfNecessary` 都触发一次 Shadow 树同步。

`:673-674` 的赋值：

```objc
        newData.disableViewCulling =
            UIAccessibilityIsVoiceOverRunning() || UIAccessibilityIsSwitchControlRunning() || isAccessibilityAPIUsed;
```

**三重或**：`isAccessibilityAPIUsed` 使前两项变成冗余
（一旦用它，就无条件禁用裁剪）——
但保留它们是为了「尚未调用任何覆写 API 时的即时响应」。

---

## 4. 【缺陷】`_scrollEventThrottle` 未在回收时重置

### 4.1 字段与初值

`:98-99` 声明两个字段：

```objc
  NSTimeInterval _lastScrollEventDispatchTime;
  NSTimeInterval _scrollEventThrottle;
```

`:161` 在 `init` 里设初值：

```objc
    _scrollEventThrottle = 0;
```

**全文件 `_scrollEventThrottle = 0` 出现 2 处**：此处（初值）
与 `:384`（`updateProps` 的映射分支之一）。

**注意：`init` 只设了 `_scrollEventThrottle`，`_lastScrollEventDispatchTime` 未初始化**
（ObjC 的 `NSTimeInterval` 即 `double`，alloc 时为 0）。

### 4.2 唯一的写入点在 `updateProps`，且有条件

`:375-388`：

```objc
  if (oldScrollViewProps.scrollEventThrottle != newScrollViewProps.scrollEventThrottle) {
    // Zero means "send value only once per significant logical event".
    // Prop value is in milliseconds.
    // iOS implementation uses `NSTimeInterval` (in seconds).
    CGFloat throttleInSeconds = newScrollViewProps.scrollEventThrottle / 1000.0;
    CGFloat msPerFrame = 1.0 / 60.0;
    if (throttleInSeconds < 0) {
      _scrollEventThrottle = INFINITY;
    } else if (throttleInSeconds <= msPerFrame) {
      _scrollEventThrottle = 0;
    } else {
      _scrollEventThrottle = throttleInSeconds;
    }
  }
```

**三重映射**（负数 → ∞、≤16.7ms → 0、其余 → 实际值），
注释说明了「0 表示每个显著逻辑事件只发一次」。

### 4.3 消费点在 `scrollViewDidScroll`

`:751-759`：

```objc
  NSTimeInterval now = CACurrentMediaTime();
  if ((_lastScrollEventDispatchTime == 0) || (now - _lastScrollEventDispatchTime > _scrollEventThrottle)) {
    _lastScrollEventDispatchTime = now;
    if (_eventEmitter) {
      static_cast<const ScrollViewEventEmitter &>(*_eventEmitter).onScroll(scrollMetrics);
    }

    RCTSendScrollEventForNativeAnimations_DEPRECATED(scrollView, self.tag, kOnScrollEvent);
  }
```

### 4.4 缺陷链

| 步骤 | 条件 | 结果 |
| --- | --- | --- |
| ① 组件 A 被复用，props 设 `scrollEventThrottle = 100` | `updateProps` 触发 | `_scrollEventThrottle = 0.1` |
| ② 组件 A 被回收 | `prepareForRecycle` | **`_scrollEventThrottle` 未重置，仍是 0.1** |
| ③ 同一实例被组件 B 复用，props 设 `scrollEventThrottle = 0` | `oldProps.scrollEventThrottle`(100) ≠ `newProps`(0) → **条件成立** | 更新为 `0` ✅ |
| ④ 组件 B 被回收，props 是 0 | | `_scrollEventThrottle = 0` |
| ⑤ 组件 C 复用，props 仍是 0 | `0 == 0` → **条件不成立** | **`_scrollEventThrottle` 保持上次的值** ❌ |

**即：若前一个使用者把 throttle 设为非 0，而下一个使用者的 prop 恰好与「再上一个」相同，
条件不成立，节流值被继承。**

**具体失效场景**：

1. 列表项 A 是 `scrollEventThrottle=100` 的 ScrollView → 入池；
2. 列表项 B 是 `scrollEventThrottle=100` → 复用，`0.1`；
3. B 入池；
4. 列表项 C 是**默认** `scrollEventThrottle=0` 的 ScrollView → 复用；
   `updateProps` 的 `oldProps` 来自池中残留的 props（仍是 100），
   `100 != 0` → **条件成立** → 更新为 0 ✅

**再换一种**：

1. 列表项 A 是**默认**（0）→ `_scrollEventThrottle` 保持 `init` 时的 0；
2. 列表项 B 是 100 → 更新为 0.1；
3. 列表项 C 是**默认**（0）→ `oldProps`(100) != `newProps`(0) → 更新为 0 ✅

**只有当连续三个以上、且中间出现过相同 prop 值时才失效**：
A=100、B=100、C=100、D=0：
- A: init 0 → props 变化 → 0.1
- B: props 100→100 **不变** → 保持 0.1（正确，因为 prop 就是 100）
- C: 同上 → 0.1（正确）
- D: props 100→0 **变** → 0 ✅

**重新审视：条件 `oldProps != newProps` 实际上总能正确更新**，
因为 `oldProps` 来自池中残留的上一个组件的 props。

> **修正后的结论**：
> **这不是「继承错误值」的缺陷，而是「依赖 `oldProps` 正确性」的脆弱设计。**
>
> **真正的风险点在于**：若某条路径能在 `updateProps` 之外修改
> `_scrollEventThrottle`（或绕过 `updateProps` 直接改 props），
> 条件不成立就会用旧值。当前代码里 `_scrollEventThrottle` 的**唯一写入点**
> 就是 `:386`（以及 `:382`/`:384`），所以**当前是正确的**。
>
> **但 `prepareForRecycle` 不重置它仍是不符合契约的** ——
> 按 [31 文档 §3.3](./31-Fabric组件层View与回收池.md) 建立的
> 「`prepareForRecycle` 重置一切实例状态」约定，这里是遗漏。

### 4.5 `_lastScrollEventDispatchTime` 也未重置

`:98` 声明，`:917` 有唯一的重置入口：

```objc
- (void)_forceDispatchNextScrollEvent
{
  _lastScrollEventDispatchTime = 0;
}
```

**`prepareForRecycle` 未调用它。**

**影响比 throttle 小**：因为 `:752` 的条件是
`(_lastScrollEventDispatchTime == 0) || (now - _lastScrollEventDispatchTime > _scrollEventThrottle)`，
而 `now` 来自 `CACurrentMediaTime()`（单调递增的绝对时间）。

**即：复用后的第一次 `scrollViewDidScroll` 里，
`now - _lastScrollEventDispatchTime` 是一个巨大的值 → 必然通过条件 → 事件正常发出。**

**所以 `_lastScrollEventDispatchTime` 不重置是无害的**（时间单调性保证了它）。

---

## 5. `RCTEnhancedScrollView`：delegate 拆分的实现

`:146` 把它转成自己的子类：

```objc
    ((RCTEnhancedScrollView *)_scrollView).overridingDelegate = self;
```

`:156` 把它注册进 splitter：

```objc
    [self.scrollViewDelegateSplitter addDelegate:self];
```

**即：`RCTEnhancedScrollView` 需要同时服务 RN 的 delegate 与
「使用者自己设的 delegate」**（如 DevTools 的滚动联动），
所以用 splitter 分发而非直接赋值。

`dealloc` 有对应清理（`:168-170`）：

```objc
- (void)dealloc
{
  // Removing all delegates from the splitter nils the actual delegate which prevents a crash on UIScrollView
```

**注释说明了崩溃的具体原因** —— `UIScrollView.delegate` 是弱引用，
若 splitter 持有它而 splitter 已被释放，UIScrollView 内部访问悬空 delegate 会崩。

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| W-1 | **`_scrollEventThrottle` 未在 `prepareForRecycle` 中重置** | `ScrollView/RCTScrollViewComponentView.mm:161`（唯一初值）、`:375-388`（唯一写入） | 当前因「`oldProps != newProps` 条件总能正确更新」而无实际错误，但**违反回收契约**，未来任何绕过 `updateProps` 的赋值都会引入串扰 |
| W-2 | `_lastScrollEventDispatchTime` 同样未重置 | 同上（`:917` 有独立重置入口但回收时不调） | **实际无害** —— `CACurrentMediaTime()` 单调递增，首次 `scrollViewDidScroll` 必然通过节流条件 |
| W-3 | 「entire session」措辞易被误读为全 App 范围 | `RCTScrollViewComponentView.mm:120` | 实际是**该组件 view 实例的存活期**（含复用），非所有 ScrollView |
| W-4 | `disableViewCulling` 的计算里 `UIAccessibilityIsVoiceOverRunning()` 等在 `_isAccessibilityAPIUsed` 为真时冗余 | `RCTScrollViewComponentView.mm:673-674` | 无害（三重或）；保留是为「尚未调用覆写 API」时的即时响应 |

### W-1 的修复建议

```objc
// 在 prepareForRecycle 中补充
_scrollEventThrottle = 0;
_lastScrollEventDispatchTime = 0;
```

与 `_isAccessibilityAPIUsed` 的处理**形成明确对照**：
一个**故意**不重置（有注释说明）、一个**应该**重置（无注释）。

**这种「同文件内一个故意一个疏忽」的对比，正是
[26 文档 I-4](./26-iOS-Base余部网络图像与快捷键.md)（注释声称有但代码没有）
需要靠文档留存的原因 —— 读者无法从「没注释」判断是「疏忽」还是「刻意」。

---

## 7. 「粘性状态」模式汇总

本轮读到三处「不在 `prepareForRecycle` 重置」的字段，性质各不相同：

| 字段 | 是否重置 | 是否有注释 | 性质 |
| --- | --- | --- | --- |
| `RCTViewComponentView._propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN` | ✅ 重置（`:778`） | — | 正常 |
| `RCTScrollViewComponentView._isAccessibilityAPIUsed` | ❌ **不重置** | ✅ **有注释说明理由** | **刻意** |
| `RCTScrollViewComponentView._scrollEventThrottle` | ❌ 不重置 | ❌ **无注释** | **疑似疏忽** |
| `RCTScrollViewComponentView._lastScrollEventDispatchTime` | ❌ 不重置 | ❌ 无注释 | **无害**（单调时间保证，§4.5） |

**判别方法**：

| 线索 | 结论 |
| --- | --- |
| 有注释说明「故意不重置」 | 刻意设计，尊重 |
| 无注释且影响状态正确性 | 疑似疏忽，应修 |

---

## 8. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 31 文档：`prepareForRecycle` 的重置契约与覆盖不全 | **补上「该重置但没重置」的第三类**（W-1），并给出与「故意不重置」的辨别方法（§7） |
| 21 文档：`removeClippedSubviews` 与视图裁剪 | **补上裁剪被关闭的触发机制**（无障碍 API 检测，§3.2） |
| 03 文档：事件循环 | **补上滚动事件的节流实现**（§4.3） |
| 23 文档 / 31 文档：注释与代码一致性 | **新增对照**：同文件内一个「注释说故意」、一个「无注释疑似疏忽」（W-1、W-3） |