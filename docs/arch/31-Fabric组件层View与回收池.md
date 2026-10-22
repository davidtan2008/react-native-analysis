---
id: 31
title: "Fabric 组件层（一）：View 组件与回收池机制"
topic: RN.view
symptoms: [mempressure, memleak]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["ViewShadowNode", "MountingCoordinator"]
sourceRoot: react-native
claims: []
---
# 31 · Fabric 组件层（一）：View 组件与回收池机制

> **模块**：A2 · `React/Fabric/Mounting/ComponentViews/`（58 文件 / 8142 行）的 View 族与回收基础设施
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · Fabric
> **前置**：[21 文档](./21-iOS-Fabric组件层与ComponentView.md) 讲了 `removeClippedSubviews`
> 与 `DO_NOT_USE_THIS_IS_BROKEN` 家族；
> [05 文档](./05-监控检测原理与流程.md) 记录了 iOS 侧 6 个内存警告观察者。
>
> 本文记录 **`RCTViewComponentView`（1946 行）的回收与重置契约**，
> 并补上 **回收池的双重容量控制**（1024 上限 + 内存警告清空）——
> 这是 iOS 侧**唯一**对内存压力有真实响应的 UI 机制。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `ComponentViews/View/RCTViewComponentView.mm` | 1946 | **View 组件宿主类**（所有组件的基类） |
| `ComponentViews/Root/RCTRootComponentView.mm` | — | 根组件 |
| `Mounting/RCTComponentViewRegistry.mm` | — | **回收池** |
| `Mounting/RCTComponentViewDescriptor.h` | — | 组件描述符 |
| `Mounting/UIView+ComponentViewProtocol.mm` | — | 基类默认实现 |
| `Mounting/RCTComponentViewProtocol.h` | — | 组件协议 |
| `LegacyViewManagerInterop/RCTLegacyViewManagerInteropComponentView.mm` | 306 | legacy 互操作 |

---

## 2. 回收池：双重容量控制

### 2.1 入池条件

`RCTComponentViewRegistry.mm:104-118`：

```objc
- (void)_enqueueComponentViewWithComponentHandle:(ComponentHandle)componentHandle
                         componentViewDescriptor:(RCTComponentViewDescriptor)componentViewDescriptor
{
  RCTAssertMainQueue();
  auto &recycledViews = _recyclePool[componentHandle];

  if (recycledViews.size() > RCTComponentViewRegistryRecyclePoolMaxSize || !componentViewDescriptor.shouldBeRecycled) {
    [componentViewDescriptor.view invalidate];
    return;
  }

  RCTAssert(
      componentViewDescriptor.view.superview == nil, @"RCTComponentViewRegistry: Attempt to recycle a mounted view.");
  [componentViewDescriptor.view prepareForRecycle];

  recycledViews.push_back(componentViewDescriptor);
}
```

**两个提前退出的条件**：

| 条件 | 动作 |
| --- | --- |
| `recycledViews.size() > 1024` | **`invalidate`（真销毁）**，不入池 |
| `!shouldBeRecycled` | `invalidate`，不入池 |

`:22` 定义上限：

```objc
const NSInteger RCTComponentViewRegistryRecyclePoolMaxSize = 1024;
```

### 2.2 `shouldBeRecycled` 默认 true，但有例外

`RCTComponentViewDescriptor.h:28-33`：

```objc
   */
  const bool observesMountingTransactionWillMount{false};
  const bool observesMountingTransactionDidMount{false};
  const bool shouldBeRecycled{true};
};
```

**默认参与回收**，但设了 `observesMountingTransaction*` 的组件会退出
（因为它们持有跨事务状态，无法安全重置）。

### 2.3 内存警告清空池

`RCTComponentViewRegistry.mm:34-37` 注册通知，`:122-125` 处理：

```objc
- (void)handleApplicationDidReceiveMemoryWarningNotification
{
  _recyclePool.clear();
}
```

> **这是 iOS 侧对内存压力唯一的 UI 层响应。**
> [05 文档](./05-监控检测原理与流程.md) 的 6 个观察者表里已列出本条，
> 本文补上它的**规模量级**（最多 1024 个 component view）与
> **与 GC 触发的差异**：

| 响应 | 动作 | 释放什么 |
| --- | --- | --- |
| **回收池清空**（本条） | `_recyclePool.clear()` | 闲置的 `UIView` 对象 |
| Hermes GC（`RCTInstance.mm`） | `collectGarbage()` | JS 堆对象 |

**两者互补而不重叠** —— 一个管原生视图，一个管 JS 对象。

---

## 3. `prepareForRecycle`：组件的重置契约

### 3.1 基类是空实现

`UIView+ComponentViewProtocol.mm:127-129`：

```objc
- (void)prepareForRecycle
{
  // Default implementation does nothing.
}
```

**所以不重写就是「什么都不清」** —— 这是本文发现的关键前提。

### 3.2 覆盖情况（实测）

| 目录 | 有/总数 | 目录 | 有/总数 |
| --- | --- | --- | --- |
| `ActivityIndicator` | **0/1** | `Text` | 1/3 |
| `DebuggingOverlay` | **0/1** | `TextInput` | 1/2 |
| `UnimplementedComponent` | **0/1** | `InputAccessory` | 1/2 |
| `UnimplementedView` | **0/1** | `LegacyViewManagerInterop` | 1/2 |
| `Image` | 1/1 | `Modal` | 1/2 |
| `Root` | 1/1 | `ScrollView` | 2/4 |
| `SafeAreaView` | 1/1 | `Switch` | 1/1 |
| `VirtualView` | 1/1 | `View` | 1/1 |

**4 个目录完全没有实现**：`ActivityIndicator`、`DebuggingOverlay`、
`UnimplementedComponent`、`UnimplementedView`。

> **这不是必然的 bug** ——
> 若组件本身无实例状态（如 `ActivityIndicatorView` 只有 `animating`/`color`），
> 不重置也不会串数据。
>
> **但这是「必须逐组件核对」的模式**：
> 没有基类兜底、没有 lint 检查、也没有运行时断言，
> 一个新组件忘记重置就是静默的状态串扰。
>
> `Unimplemented*` 的 0/1 可以接受（它们没有状态可串），
> `DebuggingOverlay` 值得注意（它是调试覆盖层，若复用到别的 surface 可能显示错误内容）。

### 3.3 `RCTViewComponentView` 的完整重置清单

`RCTViewComponentView.mm:745-784`：

```objc
- (void)prepareForRecycle
{
  [super prepareForRecycle];

  // If view was managed by animated, its props need to align with UIView's properties.
  const auto &props = static_cast<const ViewProps &>(*_props);
  if ([_propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN containsObject:@"transform"]) {
    self.layer.transform = RCTCATransform3DFromTransformMatrix(props.transform);
  }
  if ([_propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN containsObject:@"opacity"]) {
    self.layer.opacity = (float)props.opacity;
  }

  // Clean up box shadow layers to prevent cross-component contamination
  if (_boxShadowLayers != nullptr) {
    for (CALayer *boxShadowLayer in _boxShadowLayers) {
      [boxShadowLayer removeFromSuperlayer];
    }
    [_boxShadowLayers removeAllObjects];
    _boxShadowLayers = nil;
  }

  // Clean up other visual layers
  [_backgroundColorLayer removeFromSuperlayer];
  _backgroundColorLayer = nil;
  [_borderLayer removeFromSuperlayer];
  _borderLayer = nil;
  [_outlineLayer removeFromSuperlayer];
  _outlineLayer = nil;
  [_filterLayer removeFromSuperlayer];
  _filterLayer = nil;
  [self clearExistingBackgroundImageLayers];

  _propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN = nil;
  _eventEmitter.reset();
  _isJSResponder = NO;
  _removeClippedSubviews = NO;
  _reactSubviews = [NSMutableArray new];
  _layoutMetrics = EmptyLayoutMetrics;
}
```

**清理分三类**：

| 类别 | 内容 | 行号 |
| --- | --- | --- |
| **动画对齐** | `transform` / `opacity` 交还给 UIKit | `:751-756` |
| **CALayer 清理** | box shadow（逐个）+ 4 个单例 layer + 背景图 | `:758-776` |
| **状态重置** | 5 个实例变量 | `:778-783` |

**注释说明了动画对齐的必要性**：

> If view was managed by animated, its props need to align with UIView's properties.

**即：若 `transform`/`opacity` 之前由 Animated 直接改 `layer`，
回收时必须用 props 的值「校准」回 UIKit 的设置**，
否则下一个复用者会拿到被动画污染的 transform。

### 3.4 box shadow 的清理方式与其他 layer 不同

| layer | 清理方式 |
| --- | --- |
| `_boxShadowLayers` | **数组**（每个阴影一个 `CALayer`），需逐个 `removeFromSuperlayer` |
| 其余 4 个 | 单个 ivar，`removeFromSuperlayer` + 置 nil |

**box shadow 是唯一「一个组件多 layer」的**，
`:758` 的注释点明了意图：

> Clean up box shadow layers to prevent **cross-component contamination**

**"cross-component contamination"（跨组件污染）** ——
这个措辞说明作者清楚不清理的后果。

---

## 4. `_props` 的生命周期与两处不一致的检查

### 4.1 初始化保证非 nil

`RCTViewComponentView.mm:134-146`：

```objc
- (instancetype)initWithFrame:(CGRect)frame
{
  if (self = [super initWithFrame:frame]) {
    _props = ViewShadowNode::defaultSharedProps();
    _reactSubviews = [NSMutableArray new];
#if !TARGET_OS_TV
    self.multipleTouchEnabled = YES;
#endif
    _useCustomContainerView = NO;
    _removeClippedSubviews = NO;
  }
  return self;
}
```

**`_props` 在构造函数即被赋为 `defaultSharedProps()`，永不为 nil。**

所以 `prepareForRecycle:750` 的 `static_cast<const ViewProps &>(*_props)` 是安全的。

### 4.2 但 `updateProps` 里有一处更严格的检查

`:337-346`：

```objc
#ifndef NS_BLOCK_ASSERTIONS
  auto propsRawPtr = _props.get();
  RCTAssert(
      propsRawPtr &&
          ([self class] == [RCTViewComponentView class] ||
           typeid(*propsRawPtr).hash_code() != typeid(const ViewProps).hash_code()),
      @"`RCTViewComponentView` subclasses (and `%@` particularly) must setup `_props`"
       " instance variable with a default value in the constructor.",
      NSStringFromClass([self class]));
#endif
```

**这是一个双重条件的断言**：

| 条件 | 含义 |
| --- | --- |
| `propsRawPtr` | `_props` 非 nil |
| `[self class] == [RCTViewComponentView class]` **或** 类型 hash 不同 | 是基类本身，或不是 `ViewProps` |

**即「基类自己可以，`ViewProps` 的子类必须自己初始化 `_props`」**。

断言文案明确：

> `RCTViewComponentView` subclasses ... must setup `_props` instance variable with a default value in the constructor.

### 4.3 承接 23 文档的「双重门控」模式

`:337` 的 `#ifndef NS_BLOCK_ASSERTIONS` 意味着
**Release 下整个断言被编译掉**。

结合 [23 文档 §4.1](./23-iOS基础工具层ConvertAssertLogUtils.md)
（`RCTAssert` 在 `NS_BLOCK_ASSERTIONS` 下变为 `do{}while(0)`）：

| 构建 | 此断言 |
| --- | --- |
| Debug | 生效，能抓到子类忘记初始化 `_props` |
| **Release** | **完全不检查** |

> **但实际风险为零** —— 因为 `:134-146` 的 `initWithFrame:` 已经保证了。
> 断言防的是「子类重写 `init` 且忘记调 super」这种路径。
>
> **与 27 文档的 `RCTPLSize` 断言对比**：
> 那条断言在两种构建下都无效（Debug 下因 `RCTCurrentAssertFunction` 为 nil 而静默，
> Release 下因 `RCT_DEV=0` 不编译）；
> **本条断言在 Debug 下是有效的**（走系统 `NSAssertionHandler`）。

---

## 5. 无障碍：role 覆盖 trait 的设计

`RCTViewComponentView.mm:43-105` 是一段带完整解释的无障碍判定。

### 5.1 为什么 trait 不够

`:50-54` 的注释：

> The trait mask alone is not sufficient, because it is a lossy projection of the role: `checkbox`, `radio`, `combobox`, `menuitem`, `spinbutton`, `tab` and friends deliberately carry **no interactive trait**, since VoiceOver conveys them through `accessibilityValue` instead. The role is therefore consulted as well, otherwise those controls stay unreachable by keyboard.

**关键洞察**：`UIAccessibilityTraits` 是 role 的**有损投影** ——
某些 role（如 `checkbox`、`radio`）**故意不带交互 trait**，
因为 VoiceOver 通过 `accessibilityValue` 播报它们。

**后果**：只查 trait 会漏掉这些控件，**键盘用户无法聚焦**。

`:43-49` 的开头也说明了问题的严重性：

> Views that surface their interactivity through a grouping accessibility element (rather than the underlying control) are otherwise skipped by the focus engine, **leaving keyboard-only users unable to reach them**.

### 5.2 三级判定

`RCTViewComponentView.mm:55-105` 的 `RCTViewIsInteractiveAccessibilityElement`：

```
① !view.isAccessibilityElement          → NO
② traits 与 5 个交互 trait 有交集        → YES
③ props.role != None → 查 13 个 Role 枚举集合
④ 否则 → 查 15 个 accessibilityRole 字符串集合
```

**第③级（`:69-85`）**：13 个 `Role` 枚举

`Button`、`Checkbox`、`Combobox`、`Link`、`Menuitem`、`Option`、`Radio`、
`Searchbox`、`Slider`、`Spinbutton`、`Switch`、`Tab`、`Treeitem`

**第④级（`:87-105`）**：**15 个** legacy 字符串（实测）。
相比第③级的 13 个 `Role` 枚举，多出 `adjustable`、`dropdownlist`、
`imagebutton`、`keyboardkey`、`search`、`togglebutton` 这 6 个
—— 它们是 UIAccessibilityTraits 层面的名称，**没有对应的 `Role` 枚举**。

`:67-68` 的注释说明了优先级：

> `role` wins over the legacy `accessibilityRole` when both are set, matching how the traits themselves are resolved.

**即新 `role` 优先于旧 `accessibilityRole`** —— 与 trait 的解析方式一致。

### 5.3 平台门控

`:43` 的 `#if !TARGET_OS_TV` 与 `:139` 的同类门控：

```objc
#if !TARGET_OS_TV
    self.multipleTouchEnabled = YES;
#endif
```

**tvOS 上这些无障碍增强代码不编译** —— 与
[24 文档 §2.1](./24-iOS事件分发触摸管线与JS加载.md) 的
`RCTConvert.h:82-89`（`#if !TARGET_OS_TV`）同源，
说明 tvOS 支持在这份代码里系统性缺失。

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| V-1 | **回收池覆盖不全**：`ActivityIndicator`/`DebuggingOverlay`/`UnimplementedComponent`/`UnimplementedView` 无 `prepareForRecycle`，基类空实现无兜底 | `ComponentViews/*/`、`UIView+ComponentViewProtocol.mm:127` | 若组件持有实例状态则**静默串扰**；无 lint、无断言防护 |
| V-2 | `updateProps` 的 `_props` 类型断言在 **Release 下完全不检查** | `View/RCTViewComponentView.mm:337` | 「子类忘记初始化 `_props`」在生产环境无提示（实际由 `:137` 保证，风险为零） |
| V-3 | `prepareForRecycle:750` 直接 `static_cast<...>(*_props)` 无 null 检查 | `View/RCTViewComponentView.mm:750` | 实际安全（构造函数已赋值），但与 `:339` 的严格断言不一致，读代码时易误判 |
| V-4 | 回收池上限 1024 是**按 ComponentHandle 分别计数** | `RCTComponentViewRegistry.mm:110` | 多组件类型场景下总池大小可达 `1024 × 类型数`，内存上界不明确 |
| V-5 | 无障碍 role 判定用 13 元素的 `unordered_set` + 13 元素 `string_view` set | `View/RCTViewComponentView.mm:70, 87` | 每次调用做哈希查找；`:67` 注释说只在 `role != None` 时才查第③级，但第④级无条件查 |

### V-4 的量化

`_recyclePool` 的类型（`RCTComponentViewRegistry.mm`）：

```cpp
// packages/react-native/React/Fabric/Mounting/RCTComponentViewRegistry.mm:26
  std::unordered_map<ComponentHandle, std::vector<RCTComponentViewDescriptor>> _recyclePool;
```

**即 C++ 的 `unordered_map` + `vector`，不是 ObjC 容器。**
每个 `ComponentHandle` 一个独立 vector，各上限 1024。

RN 常见的 ComponentHandle 数量（View / Text / Image / ScrollView / TextInput /
Switch / Modal / SafeAreaView / ActivityIndicator / ImageBackground / VirtualView…）
在 10-20 量级。

**即理论最坏情况：1024 × 15 ≈ 15360 个闲置 `UIView`。**

> **但这是极端情况** —— 每个 `UIView` 本身约几百字节，
> 15360 × 0.5KB ≈ **7.5 MB**。
>
> **且内存警告会清空整个池**（§2.3），
> 所以「大量闲置视图 + 内存压力」这个组合不会持续存在。
>
> **结论：V-4 是设计上界不精确，而非实际内存风险。**

---

## 7. 回收池机制全链路

```
组件卸载
  │
  ├─ RCTComponentViewRegistry.dequeueComponentViewWithComponentHandle:
  │     ├─ 池非空 → pop_back() 复用（view 保留所有实例状态！）
  │     └─ 池为空 → 走 mount 流程创建新 view
  │
  └─ RCTComponentViewRegistry._enqueueComponentViewWithComponentHandle:
        ├─ size > 1024 或 !shouldBeRecycled
        │     └─ [view invalidate]（真销毁）
        └─ 否则
              ├─ RCTAssert(view.superview == nil)   ← 防回收已挂载的 view
              ├─ [view prepareForRecycle]            ← 组件自重置
              └─ recycledViews.push_back(descriptor)

内存警告
  └─ handleApplicationDidReceiveMemoryWarningNotification
        └─ _recyclePool.clear()   ← 全部销毁（§2.3）
```

### 7.1 `prepareForRecycle` 的调用时机

**注意它在入池之前调用**（`RCTComponentViewRegistry.mm:116`），
即**组件在入池那一刻就要完成重置**，
而不是等到复用时才重置。

**这意味着即使某个 view 永远不被复用，它的重置也已经执行了** ——
是为「万一被复用」做准备，不是「为即将销毁」。

### 7.2 `superview == nil` 断言防的是什么

`:113-115` 的断言：

```objc
  RCTAssert(
      componentViewDescriptor.view.superview == nil, @"RCTComponentViewRegistry: Attempt to recycle a mounted view.");
```

**防止把仍在视图树中的 view 回收进池。**
若发生，后续复用会导致同一个 view 同时出现在两处。

这与 [25 文档 §2.3](./25-iOS桥接核心与启动性能标签.md) 的
`superview == nil` 断言属同一防御思路。

---

## 8. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 21 文档：`DO_NOT_USE_THIS_IS_BROKEN` 家族 | **补上它在回收路径的作用**：`prepareForRecycle` 用它决定哪些 prop 要「校准回 UIKit」（§3.3） |
| 05 文档：iOS 6 个内存警告观察者含 `RCTComponentViewRegistry` | **量化**：池上限 1024/类型 + 整池清空；并区分它与 GC 的作用对象（§2.3） |
| 23 文档 §4.1：`RCTAssert` 在 Release 被编译掉 | **新增受影响点**：`updateProps` 的 `_props` 类型断言（V-2） |
| 24 文档 §2.1：`#if !TARGET_OS_TV` 的 tvOS 缺失 | **新增同型**：`RCTViewIsInteractiveAccessibilityElement` 与 `multipleTouchEnabled`（§5.3） |
| 05 文档：内存增长 / OOM | **补上原生视图侧的释放机制**：回收池 + `invalidate`（§7） |