---
id: 35
title: "Fabric 组件层（五）：Image 的回收竞态防护与小型组件族"
topic: RN.widget
symptoms: [jank]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["ImageShadowNode", "ImageSource"]
claims: []
---
# 35 · Fabric 组件层（五）：Image 的回收竞态防护与小型组件族

> **模块**：A2 · `ComponentViews/` 的 18 个小文件（2118 行）
> **基线**：react-native @ `9b131e42` · Fabric
> **前置**：[31 文档](./31-Fabric组件层View与回收池.md) 记录了回收池与
> `RCTViewComponentView` 的重置契约；[33 文档](./33-Fabric组件层TextInput事件计数.md)
> 总结了回收契约的三类处置。
>
> 本文记录 **`RCTImageComponentView` 的「回收竞态」防护**
> （每次订阅创建新 observer 对象、按地址匹配丢弃过期回调）——
> 这是全仓库对「异步回调 vs 组件复用」处理最完整的案例，
> 并顺带覆盖其余 17 个小型组件。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `LegacyViewManagerInterop/RCTLegacyViewManagerInteropComponentView.mm` | 306 | legacy 互操作视图 |
| `Image/RCTImageComponentView.mm` | 250 | **Image 组件（含竞态防护）** |
| `InputAccessory/RCTInputAccessoryComponentView.mm` | 157 | 输入 accessory 容器 |
| `LegacyViewManagerInterop/RCTLegacyViewManagerInteropCoordinatorAdapter.mm` | 153 | 互操作适配器 |
| `Switch/RCTSwitchComponentView.mm` | 148 | 开关 |
| `TextInput/RCTTextInputNativeCommands.h` | 104 | 原生命令声明 |
| `SafeAreaView/RCTSafeAreaViewComponentView.mm` | 100 | 安全区 |
| `ActivityIndicator/RCTActivityIndicatorViewComponentView.mm` | 99 | 活动指示器 |
| `UnimplementedView/RCTUnimplementedViewComponentView.mm` | 86 | 未实现视图（调试用） |
| `UnimplementedComponent/RCTUnimplementedNativeComponentView.mm` | 76 | 未实现组件（调试用） |
| `DebuggingOverlay/RCTDebuggingOverlayComponentView.mm` | 73 | 调试覆盖层 |
| `InputAccessory/RCTInputAccessoryContentView.mm` | 56 | accessory 内容视图 |
| `Root/RCTRootComponentView.mm` | 55 | 根组件 |
| `RCTFabricComponentsPlugins.{h,mm}` | 53 + 45 | **组件注册分派表** |
| 其余头文件与 `Text/RCTAccessibilityElement.{h,mm}` | 约 250 | 声明 |

---

## 2. 【核心】Image 的回收竞态防护

### 2.1 问题：异步回调与组件复用

图片加载是异步的，组件回收后可能立即被复用给另一张图片。
**旧请求的完成回调可能已经排在主队列里**，若不防护就会作用到新图片上。

`RCTImageComponentView.mm:146-152` 的注释完整说明了这一点：

```objc
  if (!_eventEmitter || !_state || observer != _imageResponseObserverProxy.get()) {
    // Notifications are delivered asynchronously and might arrive after the view is already recycled,
    // or after it has been reused for another image.
    // In the future, we should incorporate an `EventEmitter` into a separate object owned by `ImageRequest` or `State`.
    // See for more info: T46311063.
    return;
  }
```

**三重守卫**：`_eventEmitter` 非空、`_state` 非空、**`observer` 就是当前的 proxy**。

第三条是关键 —— 靠**对象地址**判断回调是否属于本次订阅。

### 2.2 每次订阅创建新的 observer 对象

`:114-133`：

```objc
- (void)_setStateAndResubscribeImageResponseObserver:(const ImageShadowNode::ConcreteState::Shared &)state
{
  if (_state) {
    const auto &imageRequest = _state->getData().getImageRequest();
    auto &observerCoordinator = imageRequest.getObserverCoordinator();
    observerCoordinator.removeObserver(_imageResponseObserverProxy);
  }

  _state = state;

  if (_state) {
    // A new observer per subscription: callbacks of a previous request can still be queued on the
    // main queue (e.g. after this view was recycled and reused), and must not be applied here.
    // The callbacks are matched by the proxy's address. The new proxy is allocated before the
    // previous one is released, so two consecutive subscriptions never share an address.
    _imageResponseObserverProxy = std::make_shared<RCTImageResponseObserverProxy>(self);
    auto &observerCoordinator = _state->getData().getImageRequest().getObserverCoordinator();
    observerCoordinator.addObserver(_imageResponseObserverProxy);
  }
}
```

**`:125-128` 的注释解释了「为什么地址一定不同」**：

> The new proxy is allocated **before** the previous one is released, so two consecutive subscriptions **never share an address**.

**即：先分配新的，后释放旧的（`shared_ptr` 的赋值语义保证了这一点），
所以两个连续的 proxy 地址必然不同。**

这是一个精妙但微妙的设计：

| 若这样写 | 后果 |
| --- | --- |
| `removeObserver` → 释放旧 → `addObserver` 新 | **旧 proxy 释放后地址可能被新 proxy 复用** → 旧回调被误认成新订阅的 |
| **当前写法**：先分配新，再释放旧 | 地址不复用，匹配可靠 |

**注释同时给出了未来方案**（`:148-150`）：
把 `EventEmitter` 放进 `ImageRequest` 或 `State` 自己拥有的独立对象，
避免依赖地址匹配。工单号 `T46311063`。

### 2.3 三处守卫点

| 位置 | 守卫 | 动作 |
| --- | --- | --- |
| `:146` | `!_eventEmitter \|\| !_state \|\| observer != proxy` | `onLoad`/`onLoadEnd` 路径 |
| `:194` | `!_eventEmitter \|\| observer != proxy` | `onProgress` 路径 |
| `:203` | `observer != proxy` | 失败路径（还要 `_imageView.image = nil`） |

**三处都是同一模式的重复** —— 说明作者明确知道这是必需的防护。

### 2.4 事件顺序：`onLoadStart` 必须在订阅之前

`:99-108`：

```objc
    // Loading actually starts a little before this, but this is the first time we know
    // the image is loading and can fire an event from this component.
    //
    // This has to be emitted before subscribing below: the observer coordinator
    // replays an already-`Completed` (or `Failed`) response synchronously, so
    // subscribing first can deliver `onLoad`/`onLoadEnd` ahead of `onLoadStart`.
    static_cast<const ImageEventEmitter &>(*_eventEmitter).onLoadStart();
```

**关键机制**：`ImageRequestObserverCoordinator` 对已完成（`Completed`）或失败（`Failed`）
的响应会**同步重放**。

**若先订阅再发 `onLoadStart`**，同步重放会立刻触发 `onLoad`/`onLoadEnd`，
**排在 `onLoadStart` 之前** —— 事件顺序错乱。

**所以必须先发 `onLoadStart`，再订阅。**

> **这是「同步重放」这一 API 语义带来的顺序约束** ——
> 注释把它写清楚了，避免后来者调换顺序。

### 2.5 顺带一条 instrumentation TODO

`:107-108`：

```objc
    // TODO (T58941612): Tracking for visibility should be done directly on this class.
    // For now, we consolidate instrumentation logic in the image loader, so that pre-Fabric gets the same treatment.
```

**可见性追踪本应做在这个类里，但为了兼容 pre-Fabric 而暂时放在 image loader。**

---

## 3. 组件注册分派表

`RCTFabricComponentsPlugins.mm`（45 行）与 30 文档 §2 的 `CoreModulesPlugins.mm`
是**同型但不同层**的注册表。

### 3.1 与 CoreModulesPlugins 的对照

| | `CoreModulesPlugins`（[30 文档 §2](./30-iOS-WebSocket与调试通道.md)） | `RCTFabricComponentsPlugins` |
| --- | --- | --- |
| 注册什么 | **Native Modules** | **Fabric 组件视图** |
| 键 | 模块名（`"DeviceInfo"` 等） | 组件名（`"RCTView"` 等） |
| 值 | `RCT*Cls()` 类工厂 | 视图类 |
| 字符串类型 | `std::string_view`（`sv` 后缀） | 待核 |

**这是 RN 里「类工厂 + 名字分派」模式的第二次应用** ——
[30 文档 Q-3](./30-iOS-WebSocket与调试通道.md) 指出的
「模块名与类名不一致」问题在此同样需要警惕。

### 3.2 `__attribute__((used))` 同样存在

`RCTFabricComponentsPlugins.h` 里的声明也带 `__attribute__((used))`
（与 30 文档 §2.1 观测到的一致）—— 防链接器裁掉工厂函数。

---

## 4. 小型组件的回收契约

### 4.1 `Image`

`:135-140`：

```objc
- (void)prepareForRecycle
{
  [super prepareForRecycle];
  [self _setStateAndResubscribeImageResponseObserver:nullptr];
  _imageView.image = nil;
```

**用 `_setStateAndResubscribeImageResponseObserver:nullptr` 一次性清空 state 与订阅** ——
复用了 §2.2 的逻辑，避免重复写退订代码。

### 4.2 `UnimplementedView` / `UnimplementedComponent`

[31 文档 §3.2](./31-Fabric组件层View与回收池.md) 记录这两个目录**无 `prepareForRecycle`**。

**核实后可接受**：它们是调试占位组件（显示「未实现」提示），
无实例状态可串。

### 4.3 `Switch`：无状态，纯转发

`RCTSwitchComponentView.mm:49` 建控件，`:106-114` 转发事件：

```objc
- (void)onChange:(UISwitch *)sender
{
  ...
      .onChange(SwitchEventEmitter::OnChange{.value = static_cast<bool>(sender.on)});
```

`:136-138` 的命令路径：

```objc
- (void)setValue:(BOOL)value
{
  [_switchView setOn:value animated:YES];
}
```

**无实例状态，因此无 `prepareForRecycle`** —— 属正确设计而非遗漏。

> **这修正了 [31 文档 V-1](./31-Fabric组件层View与回收池.md) 的表述**：
> 「无 `prepareForRecycle`」**不能单独作为缺陷判据** ——
> 需先确认该组件是否有实例状态。
> `Switch` / `ActivityIndicator` / `Unimplemented*` 无状态，
> 而 `DebuggingOverlay`（[31 文档 V-1](./31-Fabric组件层View与回收池.md) 点名的一个）值得单独核实。

---

## 5. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| Z-1 | 回收竞态防护依赖**对象地址不复用**，而这依赖「先分配新、后释放旧」的顺序 | `Image/RCTImageComponentView.mm:125-129` | 当前正确（有注释说明）；**任何重构若调换分配/释放顺序，防护静默失效** |
| Z-2 | 三处 `observer != proxy.get()` 守卫重复，且条件不完全一致（`:194` 无 `_state` 检查） | `Image/RCTImageComponentView.mm:146, 194, 203` | 不一致但都正确；属可维护性问题 |
| Z-3 | **`RCTFabricComponentsPlugins` 与 `CoreModulesPlugins` 是两份独立的注册表**，无统一抽象 | `RCTFabricComponentsPlugins.mm` vs `CoreModulesPlugins.mm` | 新增组件需记得改两处；容易遗漏 |
| Z-4 | 31 文档 V-1 的判据不够严谨：「无 `prepareForRecycle`」不等于缺陷 | [31 文档](./31-Fabric组件层View与回收池.md) | **本文修正**：需先确认组件是否有实例状态 |
| Z-5 | **`RCTDebuggingOverlay` 的高亮数组不重置** —— 复用后会显示上一个组件的高亮 | `DebuggingOverlay/RCTDebuggingOverlayComponentView.mm`（无 `prepareForRecycle`）+ `React/Views/RCTDebuggingOverlay.m:29` | **用户可见的错误显示**；`shouldBeRecycled` 默认 `true` 故确实会入池 |

### Z-1 的正确表述

**不是「地址可能复用」的现有缺陷**，而是「**防护的正确性依赖一个未被语言/工具强制的实现顺序**」。

注释已经写明了这一点（`:127-128`），
但**没有任何断言或注释标记来提醒重构者**「这两句的顺序不能换」。

**加固方向**（概念示意，非源码引用）：

1. 先 `make_shared` 新 proxy 到局部变量；
2. 再把 `oldProxy` 赋给 `_imageResponseObserverProxy`；
3. 最后用 `oldProxy` 显式退订。

这样「顺序依赖」在代码结构上可见，而不是隐含在赋值表达式里。

显式引入 `oldProxy` 局部变量，让顺序依赖在代码结构上可见。

---

## 6. 回收契约判据的修正（对 31 文档的补充）

[31 文档 §3.2](./31-Fabric组件层View与回收池.md) 列出了「0 实现」的目录，
但**未区分「无状态因而无需」与「有状态却遗漏」**。

本文读完全部 18 个小文件后，给出修正后的判据：

### 6.1 三步判据

```
① 该组件是否有实例状态（ivar）？
   ├─ 无 → 不实现 prepareForRecycle 是正确的
   └─ 有 → 继续 ②

② 这些状态是否需要重置？
   ├─ 是 UIKit/系统对象的镜像（如 layer 属性）→ 需要
   └─ 否（如纯计算缓存）→ 可选

③ 是否有 prepareForRecycle？
   ├─ 无 + ②为「需要」→ 缺陷
   └─ 无 + ②为「可选」→ 可接受
```

### 6.2 各组件的判据结果

| 组件 | ① 实例状态 | ③ 有 recycle | 结论 |
| --- | --- | --- | --- |
| `RCTViewComponentView` | 多个 layer + 5 个变量 | ✅ | 正确 |
| `RCTScrollViewComponentView` | 多个（含粘性标志） | ✅（但漏 2 个） | 部分缺陷（32 文档 W-1） |
| `RCTTextInputComponentView` | 协议状态机 3 件 | ✅ | 正确（33 文档 §3.3） |
| `RCTParagraphComponentView` | state + provider | ✅ | 正确（33 文档 §4） |
| `RCTVirtualViewComponentView` | mode/targetRect/parent | ✅ | 正确（34 文档 §3.4） |
| `RCTModalHostViewComponentView` | state/VC/2 布尔 | ✅（漏 1 个） | 部分缺陷（34 文档 Y-3） |
| `RCTImageComponentView` | state + proxy | ✅ | **最佳实践**（本文 §2） |
| `RCTSwitchComponentView` | `_isInitialValueSet` | ✅（重置该字段） | 正确（§4.2） |
| `RCTRootComponentView` | `_contentHasAppeared` | ✅（重置该字段） | 正确（§4.3） |
| **`RCTActivityIndicatorViewComponentView`** | **无**（纯 UIKit 控件映射） | ❌ | **正确**（无状态无需） |
| **`RCTUnimplemented*`** | **无** | ❌ | **正确**（无状态无需） |
| **`RCTDebuggingOverlayComponentView`** | **`_overlay`（其内含 `_highlightedElements` 数组）** | ❌ | **缺陷（见 §6.3）** |

### 6.3 `DebuggingOverlay` 是确证的缺陷

`RCTDebuggingOverlayComponentView.mm:23-25` 持有一个 overlay 实例：

```objc
@implementation RCTDebuggingOverlayComponentView {
  RCTDebuggingOverlay *_overlay;
```

而 overlay 自身在 `React/Views/RCTDebuggingOverlay.m:28-29` 持有累积数组：

```objc
@implementation RCTDebuggingOverlay {
  NSMutableArray<UIView *> *_highlightedElements;
```

`:110-118` 的清理方法证实它会累积：

```objc
- (void)clearElementsHighlights
{
  if (_highlightedElements != nil) {
    for (UIView *v in _highlightedElements) {
      [v removeFromSuperview];
```

**缺陷链**：

| 步骤 | 条件 | 结果 |
| --- | --- | --- |
| ① 组件 A 调 `highlightElements:` | — | `_highlightedElements` 累积若干 `UIView` |
| ② 组件 A 卸载进回收池 | `shouldBeRecycled` 默认 `true`（`RCTComponentViewDescriptor.h:32`，无覆写） | 入池 |
| ③ 组件 B 复用同一实例 | `prepareForRecycle` 未实现（基类空实现） | **overlay 仍持有 A 的高亮 UIView** |
| ④ B 被挂载 | — | **B 显示着 A 的高亮标记** |

**与 ScrollView 的 `_scrollEventThrottle`（32 文档 W-1）不同** ——
那个是「静默继承一个数值」，这个是「**继承了另一个组件的视觉高亮**」，
用户可见。

**修复方向**：在 `prepareForRecycle` 中调 `[_overlay clearElementsHighlights]`。

> **修正后**：「回收池覆盖不全」的严重性需要分档 ——
> - **无状态组件不实现**：正确（`ActivityIndicator` / `Unimplemented*`）
> - **有状态但漏数值字段**：静默继承（`ScrollView` 2 个、`Modal` 1 个）
> - **有状态且漏视觉字段**：**用户可见的错误显示**（`DebuggingOverlay`）

---

## 7. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 31 文档 V-1：回收池覆盖不全（4 个目录无 `prepareForRecycle`） | **修正判据**（§6）：无状态组件不实现是**正确的**；真正遗漏只有 3 个字段 |
| 32 文档：回收契约三类处置 | **补上判据**（§7.1 的三步流程），使「疑似疏忽」可被判定 |
| 33 文档：TextInput 正确重置 | **补上 Image 作为最佳实践**（§2） |
| 30 文档：两份注册表 | **补上 `RCTFabricComponentsPlugins`** 是第二份（§3、Z-3） |
| 05 文档：内存增长 | **补上图片加载的异步回调竞态**（Z-1）—— 与内存无关但与「事件错乱」有关 |