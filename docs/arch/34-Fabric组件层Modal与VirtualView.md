---
id: 34
title: "Fabric 组件层（四）：Modal 与 VirtualView 的可见性管理"
topic: RN.widget
symptoms: [layout]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["ModalShadowNode", "VirtualView"]
sourceRoot: react-native
claims: []
---
# 34 · Fabric 组件层（四）：Modal 与 VirtualView 的可见性管理

> **模块**：A2 · `ComponentViews/Modal/`（2 文件）、`ComponentViews/VirtualView/`（3 文件）
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · Fabric
> **前置**：[32 文档](./32-Fabric组件层ScrollView粘性状态.md) 记录了 ScrollView 的
> `_isAccessibilityAPIUsed` 粘性状态；[33 文档](./33-Fabric组件层TextInput事件计数.md)
> 总结了回收契约的三类处置。
>
> 本文记录 **VirtualView 的三态可见性与全局无障碍粘性**，
> 以及 **Modal 的 present/dismiss 时序**，
> 并发现一处**与 ScrollView 作用域不同的同类设计**。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `Modal/RCTModalHostViewComponentView.mm` | 363 | Modal 组件宿主 |
| `Modal/RCTFabricModalHostViewController.mm` | 86 | 承载 Modal 的 VC |
| `VirtualView/RCTVirtualViewComponentView.mm` | 296 | 虚拟化视图 |
| `VirtualView/RCTVirtualViewMode.h` | 12 | 可见性三态枚举 |
| `VirtualView/RCTVirtualViewRenderState.h` | 12 | 渲染状态三态枚举 |

---

## 2. VirtualView：三态可见性

### 2.1 两个三态枚举

`RCTVirtualViewMode.h:9-13`：

```objc
// Enum for virtual view modes
using RCTVirtualViewMode = NS_ENUM(NSInteger){
    RCTVirtualViewModeVisible = 0,
    RCTVirtualViewModePrerender = 1,
    RCTVirtualViewModeHidden = 2,
};
```

`RCTVirtualViewRenderState.h:9-13`：

```objc
using RCTVirtualViewRenderState = NS_ENUM(NSInteger){
    RCTVirtualViewRenderStateUnknown = 0,
    RCTVirtualViewRenderStateRendered = 1,
    RCTVirtualViewRenderStateNone = 2,
};
```

| 维度 | 取值 | 含义 |
| --- | --- | --- |
| **Mode**（JS 侧请求） | `Visible` / `Prerender` / `Hidden` | 该视图应该处于什么状态 |
| **RenderState**（实际） | `Unknown` / `Rendered` / `None` | JS 侧是否已完成渲染 |

**两者分离的意义**：`Prerender` 请求发出后，JS 渲染需要时间，
在完成前 `RenderState` 仍是 `Unknown` —— 避免「已请求但未就绪」被误判。

### 2.2 mode 变化的派发策略

`RCTVirtualViewComponentView.mm:189-210`：

```objc
  const std::optional<RCTVirtualViewMode> oldMode = _mode;
  _mode = newMode;

  switch (newMode) {
    case RCTVirtualViewModeVisible:
      // If the previous mode was hidden, emit a mode change even if `renderState` is rendered,
      // because the hidden mode change is still pending and will eventually be committed. Only
      // skip emitting a mode change if the previous mode was prerender and the result of that
      // event has already been committed.
      if (!oldMode.has_value() || oldMode == RCTVirtualViewModeHidden ||
          _renderState != RCTVirtualViewRenderStateRendered) {
        [self _dispatchSyncModeChange:event];
      }
      break;
    case RCTVirtualViewModePrerender:
      if (!oldMode.has_value() || oldMode != RCTVirtualViewModeVisible) {
        [self _dispatchAsyncModeChange:event];
      }
      break;
    case RCTVirtualViewModeHidden:
      [self _dispatchAsyncModeChange:event];
      break;
  }
```

**同步/异步派发的区分**：

| 目标 mode | 派发方式 | 条件 |
| --- | --- | --- |
| `Visible` | **同步** `_dispatchSyncModeChange` | 三者之一：无旧值 / 旧值是 Hidden / 未渲染完 |
| `Prerender` | **异步** `_dispatchAsyncModeChange` | 无旧值 / 旧值不是 Visible |
| `Hidden` | **异步** `_dispatchAsyncModeChange` | 无条件 |

**注释解释了 `Visible` 那条复杂条件的每一条分支**：

> If the previous mode was hidden, emit a mode change even if `renderState` is rendered, because **the hidden mode change is still pending and will eventually be committed**. Only skip emitting a mode change if the previous mode was prerender and the result of that event has already been committed.

**即：`Hidden → Visible` 必须发，即使已渲染** ——
因为此前的 `Hidden` 指令还在队列里没提交，不补一条 `Visible` 就会被吞掉。

---

## 3. 无障碍粘性：VirtualView 用的是**全局 static**

### 3.1 与 ScrollView 的关键差异

| | ScrollView（[32 文档 §3](./32-Fabric组件层ScrollView粘性状态.md)） | VirtualView |
| --- | --- | --- |
| 字段 | `BOOL _isAccessibilityAPIUsed`（**实例变量**） | `static BOOL sIsAccessibilityUsed`（**文件级全局**） |
| 声明处注释 | ✅ 有（说明为何不重置） | ❌ 无 |
| 作用域 | 该组件 view 实例的存活期 | **整个进程** |

`RCTVirtualViewComponentView.mm:94`：

```objc
static BOOL sIsAccessibilityUsed = NO;
```

### 3.2 触发点：同样覆写两个 API

`:96-110`：

```objc
- (NSInteger)accessibilityElementCount
{
  // From empirical testing, method `accessibilityElementCount` is called lazily only
  // when accessibility is used.
  [self _unhideIfNeeded];
  return [super accessibilityElementCount];
}

- (NSArray<id<UIFocusItem>> *)focusItemsInRect:(CGRect)rect
{
  // From empirical testing, method `focusItemsInRect:` is called lazily only
  // when keyboard navigation is used.
  [self _unhideIfNeeded];
  return [super focusItemsInRect:rect];
}
```

**注释与 ScrollView 侧的逐字一致** —— 同一套设计被应用到两个组件。

### 3.3 `_unhideIfNeeded` 的两级动作

`:214-223`：

```objc
- (void)_unhideIfNeeded
{
  if (!sIsAccessibilityUsed) {
    // accessibility is detected for the first time. Make views visible.
    sIsAccessibilityUsed = YES;
  }

  if (self.hidden) {
    self.hidden = NO;
  }
}
```

| 动作 | 条件 | 作用域 |
| --- | --- | --- |
| 置全局标志 | 首次 | **进程级，永不复位** |
| 解除当前视图的 hidden | 该视图当前 hidden | 当前视图 |

**注意：全局标志只被写、从不被读来做分支判断** ——
真正的行为（`self.hidden = NO`）是逐视图的。

> **所以 `static` 在这里的作用是「记录曾发生过无障碍访问」，
> 而非「所有 VirtualView 都永久可见」。**
>
> 这与 ScrollView 的 `static`-vs-实例 差异相比，
> **实际行为几乎一样**（都是「一旦发生就记录，但只影响自己」）。

### 3.4 `prepareForRecycle` 正确重置了 `hidden`

`:119-128`：

```objc
- (void)prepareForRecycle
{
  [super prepareForRecycle];

  [[_parentVirtualViewContainer virtualViewContainerState] remove:self];
  self.hidden = NO;
  _didLayout = NO;
  _mode.reset();
  _targetRect.reset();
  _parentVirtualViewContainer = nil;
}
```

**`self.hidden = NO` 被显式重置** —— 保证被无障碍「解除隐藏」过的视图
入池后不会带着 `hidden = YES` 污染下一个使用者。

**同时 `remove:self` 把自身从容器状态里摘除**，
避免容器持有已回收的视图。

---

## 4. `updateLayoutMetrics` 再次丢弃参数

`RCTVirtualViewComponentView.mm:130-138`：

```objc
// Handles case when sibling changes size.
// TODO(T202601695): This doesn't yet handle the case of elements in the ScrollView outside a VirtualColumn changing
// size.
- (void)updateLayoutMetrics:(const LayoutMetrics &)layoutMetrics
           oldLayoutMetrics:(const LayoutMetrics &)oldLayoutMetrics
{
  [super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:_layoutMetrics];
  _didLayout = YES;
  [self updateState];
}
```

**与 `RCTParagraphComponentView`（[33 文档 §4.4](./33-Fabric组件层TextInput事件计数.md)）完全同型** ——
`oldLayoutMetrics` 参数被丢弃，改用 ivar。

**但 VirtualView 这里的注释没说为什么**，
而 Paragraph 那边说了「avoid re-applying individual sub-values which weren't changed」。

### 4.1 带工单号的已知限制

`TODO(T202601695)` 明确记录了一个未覆盖的场景：

> This doesn't yet handle the case of elements in the ScrollView **outside a VirtualColumn** changing size.

**即：ScrollView 里不在任何 VirtualColumn 内、但兄弟元素尺寸变化的元素不会被处理。**

**注释带 Meta 内部工单号** —— 与
[33 文档 §3.2](./33-Fabric组件层TextInput事件计数.md) 的 `T207198334`、
[29 文档 §2.4](./29-iOS平台能力族DeviceInfo与Accessibility.md) 的 `T175901725` 同属一类。

---

## 5. 向上遍历查找容器

`RCTVirtualViewComponentView.mm:225-235`：

```objc
- (id<RCTVirtualViewContainerProtocol>)_getParentVirtualViewContainer
{
  UIView *view = self.superview;
  while (view != nil) {
    if ([view respondsToSelector:@selector(virtualViewContainerState)]) {
      return (id<RCTVirtualViewContainerProtocol>)view;
    }
    view = view.superview;
  }
  return nil;
}
```

**逐级 `superview` 向上找，用 `respondsToSelector:` 判定。**

`RCTScrollViewComponentView.mm:130-136` 是同型实现：

```objc
+ (RCTScrollViewComponentView *_Nullable)findScrollViewComponentViewForView:(UIView *)view
{
  do {
    view = view.superview;
  } while (view != nil && ![view isKindOfClass:[RCTScrollViewComponentView class]]);
  return (RCTScrollViewComponentView *)view;
}
```

**两处差异**：

| | VirtualView | ScrollView |
| --- | --- | --- |
| 判定方式 | `respondsToSelector:` | `isKindOfClass:` |
| 起点 | `self.superview` | 先 `view = view.superview` 再判 |
| 返回 nil 时 | 返回 `nil` | 返回 `nil`（cast 后） |

**`respondsToSelector:` 版本更宽松**（支持任何实现了该方法的类），
`isKindOfClass:` 版本更严格（只认这一个类）。

---

## 6. Modal：present/dismiss 时序

### 6.1 「只有需要时才 present」

`RCTModalHostViewComponentView.mm:170-187`：

```objc
- (void)ensurePresentedOnlyIfNeeded
{
  BOOL shouldBePresented = !_isPresented && _shouldPresent && self.window;
  if (shouldBePresented) {
    [self saveAccessibilityFocusedView];
    self.viewController.presentationController.delegate = self;
    self.viewController.modalInPresentation = _modalInPresentation;

    _isPresented = YES;
    [self presentViewController:self.viewController
                       animated:_shouldAnimatePresentation
                     completion:^{
                       auto eventEmitter = [self modalEventEmitter];
                       if (eventEmitter) {
                         eventEmitter->onShow(ModalHostViewEventEmitter::OnShow{});
                       }
                     }];
  }
```

**三重与条件**：`!_isPresented`（未在展示）**且** `_shouldPresent`（props 要求）
**且** `self.window`（已上屏）。

**`self.window` 这一条是关键**：视图还没挂到 window 上时不 present，
否则 `presentViewController:` 会失败。

**`_isPresented` 在调用 present 之前就置 `YES`**（`:178`）——
防止 `updateProps` 连续触发时重复 present。

### 6.2 hide 条件同样对称

`:189-194`：

```objc
  BOOL shouldBeHidden = _isPresented && (!_shouldPresent || !self.superview);
  if (shouldBeHidden) {
    _isPresented = NO;
    // To animate dismissal of view controller, snapshot of
    // view hierarchy needs to be added to the UIViewController.
    UIView *snapshot = [self.viewController.view snapshotViewAfterScreenUpdates:NO];
```

**注意 hide 的条件用 `!self.superview` 而非 `!self.window`** ——
present 用 window、dismiss 用 superview，两者判断不同。

注释说明了 snapshot 的用途（动画 dismiss 需要视图层级）。

### 6.3 dismiss 的双路径

`:157-168`：

```objc
- (void)dismissViewController:(UIViewController *)modalViewController
                     animated:(BOOL)animated
                   completion:(void (^)(void))completion
{
  if (modalViewController.presentedViewController) {
    // Dismissing a controller that is itself presenting only dismisses its child, so dismiss both.
    UIViewController *presentingViewController = modalViewController.presentingViewController ?: modalViewController;
    [presentingViewController dismissViewControllerAnimated:animated completion:completion];
  } else {
    [modalViewController dismissViewControllerAnimated:animated completion:completion];
  }
}
```

**注释解释了一个 UIKit 的语义陷阱**：

> Dismissing a controller that is itself presenting only dismisses its child, so dismiss both.

**即：若 A 正在 present B，对 A 调 `dismissViewController` 只会 dismiss B，
不会 dismiss A 本身。** 所以必须找到 `presentingViewController`（真正的呈现者）来 dismiss。

### 6.4 `prepareForRecycle` 重置完整

`:276-283`：

```objc
- (void)prepareForRecycle
{
  [super prepareForRecycle];
  _state.reset();
  _viewController = nil;
  _isPresented = NO;
  _shouldPresent = NO;
}
```

**`_viewController = nil` 是关键** ——
与 `viewController` 懒加载（`:139-147`）配合，保证复用时创建新的 VC。

**四个重置项全部到位**，无遗漏。

### 6.5 `allowSwipeDismissal` 的取反映射

`:300-303`：

```objc
  if (oldViewProps.allowSwipeDismissal != newProps.allowSwipeDismissal) {
    _modalInPresentation = !newProps.allowSwipeDismissal;
    self.viewController.modalInPresentation = _modalInPresentation;
  }
```

**JS 的 `allowSwipeDismissal` 与 UIKit 的 `modalInPresentation` 语义相反**，
所以有一次取反。

**但只在 prop 变化时更新**（`:300` 的条件）——
与 32 文档的 `_scrollEventThrottle` 同型设计。
由于 `_viewController = nil` 已重置，复用时会创建新 VC 并读 `_modalInPresentation`，
**而 `_modalInPresentation` 本身没有在 `prepareForRecycle` 里重置** ——
这是一处继承路径，实际依赖「复用后 `updateProps` 总会传新 props」。

---

## 7. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| Y-1 | **`sIsAccessibilityUsed` 是 static 全局且无注释、无重置** | `VirtualView/RCTVirtualViewComponentView.mm:94` | 进程级粘性；与 ScrollView 的实例变量不同。**但因只写不读，实际行为差异很小** |
| Y-2 | `updateLayoutMetrics` 丢弃 `oldLayoutMetrics` **且无注释说明** | `VirtualView/RCTVirtualViewComponentView.mm:137` | 同 Paragraph 的做法，但那里有注释、这里没有 → 读者无法判断是刻意还是疏忽 |
| Y-3 | `_modalInPresentation` 未在 `prepareForRecycle` 重置 | `Modal/RCTModalHostViewComponentView.mm:276-283` | 依赖「复用后 `updateProps` 总会传新 props」；若某路径不经 `updateProps`，会沿用旧值 |
| Y-4 | present 用 `self.window` 判断、dismiss 用 `!self.superview` | `RCTModalHostViewComponentView.mm:172` vs `:189` | 判断维度不对称；**无注释说明为何不同** |
| Y-5 | `_getParentVirtualViewContainer` 每次调用都向上遍历到根 | `VirtualView/RCTVirtualViewComponentView.mm:225-235` | 深嵌套视图树下的 O(depth)；无缓存 |

### Y-1 与 32 文档的对照

| | ScrollView | VirtualView |
| --- | --- | --- |
| 变量 | `_isAccessibilityAPIUsed`（实例） | `sIsAccessibilityUsed`（**static**） |
| 注释说明「不重置」 | ✅ 有 | ❌ 无 |
| `prepareForRecycle` 重置 | ❌（刻意） | —（static 无法重置实例） |
| 触发 API | `accessibilityElementCount` / `focusItemsInRect:` | 同 |
| 注释措辞 | 逐字说明「Accessibility Inspector 不发通知」 | **仅「called lazily only when accessibility is used」** |

**VirtualView 侧缺少 ScrollView 那段「为什么不用通知」的解释** ——
同一个设计，一处有完整理由，一处只有现象描述。

---

## 8. 无障碍「解除隐藏」是跨组件的通用模式

三个组件都用同一套「覆写 API 检测」：

| 组件 | 覆写的 API | 检测到的动作 |
| --- | --- | --- |
| `RCTScrollViewComponentView` | `accessibilityElementCount`、`focusItemsInRect:` | 禁用视图裁剪（`_disableViewCullingIfNecessary`） |
| `RCTVirtualViewComponentView` | 同上 | 解除隐藏（`_unhideIfNeeded`） |
| `RCTViewComponentView` | — | 交互性判定（[31 文档 §5](./31-Fabric组件层View与回收池.md)，非覆写方式） |

**前两者共用同一段注释**：

> From empirical testing, method `accessibilityElementCount` is called lazily only when accessibility is used.

**即「这些 API 只在被真正使用时才被调用」是实测结论，不是文档保证。**

> **风险**：
> 若 UIKit 改变调用时机（如在某些场景预调用），
> 视图会过早解除隐藏/禁用裁剪，
> **造成性能退化但不崩溃**。
>
> **注释里的「From empirical testing」坦诚了这一点** ——
> 作者知道这是依赖实现细节的假设。

---

## 9. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 32 文档：`_isAccessibilityAPIUsed` 是实例变量 | **对比**：VirtualView 用 `static`（Y-1），实际行为差异小但注释质量差一档 |
| 32 文档：「Accessibility Inspector 不发通知」的完整理由 | **指出 VirtualView 侧缺失**（§7），同设计两处注释详略不同 |
| 33 文档：`updateLayoutMetrics` 丢弃参数 | **新增第二处实例**（Y-2），且该处无注释 |
| 33 文档：回收契约三类处置 | **补上 Modal 与 VirtualView 两个正面实例**（§3.4、§6.4） |
| 31 文档：视图裁剪 | **补上 VirtualView 的隐藏/预渲染三态**（§2） |