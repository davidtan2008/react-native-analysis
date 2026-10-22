---
id: 21
title: "iOS Fabric 组件层：ComponentView 与 removeClippedSubviews"
topic: PL.ios
symptoms: [prop]
platforms: [ios]
architecture: [fabric]
layer: T3
symbols: ["RCTViewComponentView", "RCTComponentViewProtocol"]
sourceRoot: react-native
claims: [CV-1, CV-2, CV-3, CV-4, CV-5, CV-6, CV-7]
---
# 21 · iOS Fabric 组件层：ComponentView 与 removeClippedSubviews

> **模块**：C1 · `React/Fabric/Mounting/ComponentViews`（16 个子目录 + 2 个根级文件，共 58 个源文件）
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · iOS 侧
> **前置**：[10 文档](./10-Fabric组件层与视图扁平化.md) 讲了 C++ 侧的扁平化 Trait；
> [17 文档](./17-Android-View层与属性机制.md) 讲了 Android 侧的属性反射。
> 本文讲 **iOS 侧组件如何落地**，并对照三方找出平台差异。

---

## 1. 目录构成（与 C++ `components/`、Android `views/` 三方对应）

| 子目录 | 文件 | C++ 对应 | Android 对应 |
| --- | --- | --- | --- |
| `ScrollView/` | 11 | `components/scrollview` | `views/scroll` |
| `Text/` | 6 | `components/text` | `views/text` |
| `TextInput/` | 5 | `components/textinput` | `views/textinput` |
| `VirtualView/` | 4 | （C++ 无） | `views/virtual` |
| `Modal/` | 4 | `components/modal` | `views/modal` |
| `LegacyViewManagerInterop/` | 4 | `components/legacyviewmanagerinterop` | — |
| `InputAccessory/` | 4 | `components/inputaccessory` | — |
| `View/` | **2**（但 1946 行） | `components/view` | `views/view` |
| `UnimplementedView/` `UnimplementedComponent/` | 各 2 | `components/unimplementedview` | `views/unimplementedview` |
| `Switch/` `SafeAreaView/` `Root/` `Image/` `DebuggingOverlay/` `ActivityIndicator/` | 各 2 | 同名 | 同名 |

> **`View/` 只有 2 个文件却是 1946 行** —— iOS 侧的通用 View 承载了最多属性。
> 另有 `RCTFabricComponentsPlugins.mm`（codegen 产物）负责注册。

**三方规模对照**：

| 层 | 文件数 |
| --- | --- |
| C++ `renderer/components/` | 218 |
| Android `views/` | 137 |
| **iOS `ComponentViews/`** | **58** |

iOS 侧文件数少于前两者 —— 因为大部分组件只需一个 `RCTXxxComponentView.mm`（16 个子目录中
有 8 个各只有 2 个文件：`View` / `Switch` / `Root` / `Image` 等）。

---

## 2. `removeClippedSubviews`：不只是裁剪，而是改变子视图存放方式

这是本文最值得注意的机制。

### 2.1 挂载路径的分叉

`View/RCTViewComponentView.mm:223-238`：

```objc
- (void)mountChildComponentView:(UIView<RCTComponentViewProtocol> *)childComponentView index:(NSInteger)index
{
  RCTAssert(
      childComponentView.superview == nil,
      @"Attempt to mount already mounted component view. (parent: %@, child: %@, index: %@, existing parent: %@)",
      self,
      childComponentView,
      @(index),
      @([childComponentView.superview tag]));

  if (_removeClippedSubviews) {
    [_reactSubviews insertObject:childComponentView atIndex:index];
  } else {
    [self.currentContainerView insertSubview:childComponentView atIndex:index];
  }
}
```

**两种截然不同的存放方式**：

| `_removeClippedSubviews` | 子视图存放位置 | 屏幕外子视图 |
| --- | --- | --- |
| `NO`（默认） | 真实 `subviews` | **仍在视图层级中** |
| `YES` | `NSMutableArray _reactSubviews` | 可被移除（下次滚动再挂回） |

`unmountChildComponentView`（`:240-273`）同样分叉，但**只有非裁剪分支才做校验**：

```objc
  if (_removeClippedSubviews) {
    [_reactSubviews removeObjectAtIndex:index];
  } else {
    RCTAssert(
        childComponentView.superview != nil,
        @"Attempt to unmount a view which is not mounted. ...");
```

裁剪分支下**不做 index 一致性校验**（因为数组顺序可能与渲染顺序不同）。

### 2.2 开关切换时的重建

`:275-297`：

```objc
- (void)_updateRemoveClippedSubviewsState
{
  if (_removeClippedSubviews) {
    // Toggled ON: populate _reactSubviews from the current view hierarchy.
    // Actual clipping will happen on the next scroll event.
    RCTAssert(
        _reactSubviews.count == 0,
        @"_reactSubviews should be empty when toggling removeClippedSubviews on. (view: %@, count: %@)",
        self,
        @(_reactSubviews.count));
    if (self.currentContainerView.subviews.count > 0) {
      _reactSubviews = [NSMutableArray arrayWithArray:self.currentContainerView.subviews];
    }
  } else {
    // Toggled OFF: re-mount all children in the correct order, then clear the tracking array.
    // addSubview: on an already-present child moves it to the front, so iterating in order
    // produces the correct subview ordering.
    for (UIView *view in _reactSubviews) {
      [self.currentContainerView addSubview:view];
    }
    [_reactSubviews removeAllObjects];
  }
}
```

**注释记录了两个关键设计点**：

1. 打开时**只是把现有 subviews 搬进数组**，不做实际裁剪 ——「Actual clipping will happen on the next scroll event」
2. 关闭时靠 `addSubview:` 对已存在子视图的「移到最前」语义来恢复顺序

> **顺序恢复是一个隐式依赖**：`addSubview:` 对已在层级中的视图会移到末尾，
> 因此按数组顺序遍历一遍即可得到正确排序。这依赖 UIKit 的实现细节，
> 源码用注释显式记录了，但**没有断言验证最终顺序**。

### 2.3 受 `enableViewCulling` FeatureFlag 门控

`:360-366`：

```objc
  // Disable `removeClippedSubviews` when Fabric View Culling is enabled.
  if (!ReactNativeFeatureFlags::enableViewCulling()) {
    if (oldViewProps.removeClippedSubviews != newViewProps.removeClippedSubviews) {
      _removeClippedSubviews = newViewProps.removeClippedSubviews;
      [self _updateRemoveClippedSubviewsState];
    }
  }
```

`enableViewCulling` 的配置（`scripts/featureflags/ReactNativeFeatureFlags.config.js:571-582`）：

```js
    enableViewCulling: {
      defaultValue: false,
      metadata: {
        dateAdded: '2025-01-27',
        description:
          'Enables View Culling: as soon as a view goes off screen, it can be reused anywhere in the UI and pieced together with other items to create new UI elements.',
        expectedReleaseValue: true,
        purpose: 'experimentation',
      },
      ossReleaseStage: 'none',
    },
```

**默认 `false`（实验中，预期将来 `true`）**，故当前 `removeClippedSubviews` 生效。

**语义反转值得注意**：flag **关闭**时这个 JS 属性生效；flag **打开**后
裁剪改由 C++ 侧统一管理，**JS 的 `removeClippedSubviews` 被完全忽略**。
这是「同一属性在两个时期语义不同」的过渡设计。

### 2.4 与 Android 的对照

Android 侧有对应的接口（`uimanager/ReactClippingViewGroup.kt:14-30`）：

```kotlin
/**
 * Interface that should be implemented by [View] subclasses that support `removeClippedSubviews`
 * ...
 * [removeClippedSubviews] is set to `true` on a view.
 */
public interface ReactClippingViewGroup {
```

**两平台都实现了 `removeClippedSubviews`**，但 iOS 独有 `_reactSubviews` 数组
这个「脱离视图层级」的中间态 —— Android 是直接在 ViewGroup 的 children 数组上操作。

---

## 3. `DO_NOT_USE_THIS_IS_BROKEN` 家族：命名警告的失效

### 3.1 四个标识符

全仓库检索，**5 个**带该后缀的标识符（4 个方法/属性 + 1 个 ivar）：

| 标识符 | 出现次数 | 文件数 | 位置 |
| --- | --- | --- | --- |
| `findComponentDescriptorByHandle_DO_NOT_USE_THIS_IS_BROKEN` | 11 | 9 | C++ `ComponentDescriptorRegistry.h`（见 [08 文档 E1-3](./08-组件注册表与惰性注册.md)） |
| `propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN` | 15 | 5 | iOS 组件层 |
| `setPropKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN` | 4 | 4 | 同上（含协议声明） |
| `componentViewName_DO_NOT_USE_THIS_IS_BROKEN` | 4 | 4 | 同上 |
| `_propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN` | 4 | 1 | `RCTViewComponentView.mm` 的 ivar |

**命名风格一致，来源不同**：一个是 C++ 注册表的坏接口，三个是 ObjC 协议方法，
最后一个是 ObjC 实例变量。

### 3.2 协议里的注释直接写「This is broken」

`Fabric/Mounting/RCTComponentViewProtocol.h:129-132`：

```objc
/*
 * This is broken. Do not use.
 */
- (void)setPropKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN:(nullable NSSet<NSString *> *)props;
- (nullable NSSet<NSString *> *)propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN;
```

**注释说「不要用」，而 `RCTMountingManager.mm` 自己在用。**

这与 08 文档 E1-3 记录的 C++ 侧情况完全同构：
**命名后缀是唯一防线，而框架内部自己就绕过了这道防线。**

> 命名警告的价值在于「让新代码不依赖它」。
> 一旦框架自己成为主要调用方，这个警告就退化为**纯装饰**。

### 3.3 动画与 props 的交接协议

`Fabric/Mounting/RCTMountingManager.mm:299-313` 展示了实际用法：

```objc
  NSSet<NSString *> *propKeys = componentView.propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN ?: [NSSet new];

  if (!ReactNativeFeatureFlags::useSharedAnimatedBackend()) {
    NSArray<NSString *> *propsKeysToBeUpdated = extractKeysFromFollyDynamic(props);
    propKeys = [propKeys setByAddingObjectsFromArray:propsKeysToBeUpdated];
  }

  SurfaceId surfaceId = RCTSurfaceIdForView(componentView);
  Props::Shared oldProps = [componentView props];
  Props::Shared newProps = componentDescriptor.cloneProps(
      PropsParserContext{surfaceId, *_contextContainer}, oldProps, RawProps(std::move(props)));

  componentView.propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN = nil;
  [componentView updateProps:newProps oldProps:oldProps];
  componentView.propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN = propKeys;
```

**四步握手**：

| 步 | 动作 | 目的 |
| --- | --- | --- |
| 1 | 读出当前「被动画接管」的 propKeys | 保存现场 |
| 2 | 合并本次 raw props 的 key（旧后端才做） | 追踪新接管的属性 |
| 3 | **置 nil** → `updateProps:` → **恢复** | 让 `updateProps` 期间不做动画让位 |

消费侧在 `RCTViewComponentView.mm` 中有多处（`:355`、`:423`、`:751`、`:754`）：

```objc
  // `opacity`
  if (oldViewProps.opacity != newViewProps.opacity &&
      ![_propKeysManagedByAnimated_DO_NOT_USE_THIS_IS_BROKEN containsObject:@"opacity"]) {
    self.layer.opacity = (float)newViewProps.opacity;
```

**被动画接管的属性，props 更新时不写原生层** —— 避免与动画的逐帧写入打架。

> **「置 nil → 更新 → 恢复」是一种 thread-confined 的临时状态传递**，
> 靠调用顺序而非任何同步原语保证。若将来 `updateProps` 变成异步，这个协议会失效。
> 目前 `RCTMountingManager` 有 `RCTAssertMainQueue()`（`:289`）保证在主线程。

`useSharedAnimatedBackend` 开启时**不做步骤 2 的合并**（`:301-304`）——
说明新旧动画后端对「哪些 prop 被接管」的判定方式不同。

---

## 4. 挂载的一致性断言密度

`RCTViewComponentView.mm:240-273` 的 `unmountChildComponentView` 有 **4 层断言**：

```objc
    RCTAssert(
        childComponentView.superview != nil,
        @"Attempt to unmount a view which is not mounted. (parent: %@, child: %@, index: %@)",
        ...);
    RCTAssert(
        childComponentView.superview == self.currentContainerView,
        @"Attempt to unmount a view which is mounted inside a different view. ...");
#ifndef NS_BLOCK_ASSERTIONS
    NSArray<UIView *> *containerSubviews = self.currentContainerView.subviews;
    BOOL isIndexInBounds = index >= 0 && (NSUInteger)index < containerSubviews.count;
    RCTAssert(
        isIndexInBounds && [containerSubviews objectAtIndex:index] == childComponentView,
        @"Attempt to unmount a view which has a different index. ...");
#endif
```

**注意 `#ifndef NS_BLOCK_ASSERTIONS`** —— Release 下会跳过最严格的 index 校验，
只保留前两个 `RCTAssert`（而 `RCTAssert` 本身在 Release 下是 no-op，见 20 文档 CM-3 同类问题）。

> **iOS 侧的挂载一致性保护几乎全在 Debug 生效。**
> Release 下若 index 传错，`objectAtIndex:` 会抛 `NSRangeException`（原生崩溃），
> 而不是走 RN 的错误上报。

---

## 5. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| CV-1 | `DO_NOT_USE_THIS_IS_BROKEN` 协议注释写「Do not use」，而 `RCTMountingManager` 自己在用 | `RCTComponentViewProtocol.h:129-132` vs `RCTMountingManager.mm:299-313` | 命名警告退化为装饰，外部开发者无法判断能否依赖 |
| CV-2 | 动画/props 交接靠「置 nil → update → 恢复」的调用顺序，无同步原语 | `RCTMountingManager.mm:311-313` | 若 `updateProps` 转为异步则协议失效；当前仅靠 `RCTAssertMainQueue()` 保证 |
| CV-3 | 关闭 `removeClippedSubviews` 时靠 `addSubview:` 的「移到最前」语义恢复顺序，无断言验证 | `RCTViewComponentView.mm:289-296` | 依赖 UIKit 实现细节；UIKit 行为变化会静默错序 |
| CV-4 | `removeClippedSubviews` 分支下 `unmount` 不做 index 一致性校验 | `RCTViewComponentView.mm:242-244` | 裁剪模式下列表与渲染顺序可能不一致，无诊断 |
| CV-5 | 最严格的 index 校验被 `#ifndef NS_BLOCK_ASSERTIONS` 排除，Release 下无此保护 | `RCTViewComponentView.mm:258-269` | Release 下 index 错误变成原生 `NSRangeException` |
| CV-6 | `enableViewCulling` 开启后 JS 的 `removeClippedSubviews` 被**完全忽略** | `RCTViewComponentView.mm:361-366` | 同一属性在 flag 两种状态下语义不同，属过渡设计但无文档说明 |
| CV-7 | `enableViewCulling` 仍是 `ossReleaseStage: 'none'` 实验特性 | `scripts/featureflags/ReactNativeFeatureFlags.config.js:571-582` | 一旦默认开启，依赖 `removeClippedSubviews` 的 App 行为突变 |

---

## 6. 与其他文档的衔接

- C++ 侧扁平化 Trait（决定哪些节点有原生视图）→ [10 文档 §2](./10-Fabric组件层与视图扁平化.md)
- Android 侧属性反射与 props 差异语义 → [17 文档 §2-3](./17-Android-View层与属性机制.md)
- `DO_NOT_USE_THIS_IS_BROKEN` 的 C++ 侧对应物 → [08 文档 E1-3](./08-组件注册表与惰性注册.md)
- legacy 收敛开关与 FeatureFlag 门控模式 → [16 文档 §3](./16-Android-uimanager与旧架构掏空.md)
- iOS Surface 生命周期与 stage → [19 文档](./19-iOS平台层与Surface生命周期.md)

---

## 7. 本文覆盖边界

| 范围 | 状态 |
| --- | --- |
| `View/RCTViewComponentView.mm` | ✅ 已读（1946 行中的约 400 行核心方法） |
| `RCTMountingManager.mm` | ✅ 已读（`:288-317`） |
| `RCTComponentViewProtocol.h` | ✅ 已读（`:120-135`） |
| 其余 15 个组件子目录（53 文件） | ❌ **未读** |
| `RCTFabricComponentsPlugins.h/.mm` | ❌ 未读 |

**ComponentViews 58 个文件中，本文实读 3 个，缺口 55。**

---

## 8. 验证方式

```bash
node docs/arch/audit/audit-citations.mjs    # 引用可达性
node docs/arch/audit/verify-quotes.mjs      # 代码块语义
node docs/arch/audit/verify-claims.mjs      # 核心事实断言
```
