---
id: 10
title: "Fabric 组件层：视图扁平化与平台 Trait"
topic: RN.view
symptoms: [layout]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["ViewShadowNode", "ViewProps"]
sourceRoot: react-native
claims: []
---
# 10 · Fabric 组件层：视图扁平化与平台 Trait

> **模块**：A2（`ReactCommon/react/renderer/components`，218 个非测试文件）
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根）
> **前置**：[07 文档](./07-Fabric组件层与Props体系.md) 讲了 Props/Descriptor 契约，[09 文档](./09-渲染器核心与差分算法.md) 讲了 ShadowNode 与差分。
> 本文回答：**ShadowNode 树如何变成原生 View 树**，以及**为什么 iOS 与 Android 的扁平化规则不同**。

---

## 1. 目录构成（A2 全部子目录实测）

| 子目录 | 非测试文件数 | 组件 |
| --- | --- | --- |
| `view/` | 45 | View（基础，含 platform 子目录） |
| `text/` | 33 | Text / Paragraph / TextInput 共享的文本基础设施 |
| `scrollview/` | 15 | ScrollView |
| `image/` | 13 | Image |
| `legacyviewmanagerinterop/` | 10 | 新旧架构互操作层 |
| `modal/` | 9 | Modal |
| `textinput/` | 8 | TextInput |
| `unimplementedview/` | 6 | UnimplementedNativeView（回退兜底） |
| `root/` | 6 | RootShadowNode（每个 Surface 的根） |
| `safeareaview/` | 5 | SafeAreaView |
| `rncore/` | 5 | RCTView / RCTText 等 JS 名到组件名的映射 |
| `inputaccessory/` | 4 | InputAccessoryView |

`view/` 一个目录就占 45 个文件，其中 **15 个是 platform 变体**：
android 6 个 / cxx 4 个 / tvos 5 个（三者并不相同，见 §3.3）。

---

## 2. 视图扁平化：ShadowNode 树 ≠ View 树

### 2.1 三个 Trait 决定一切

`core/ShadowNodeTraits.h:54-69` 给出定义：

```cpp
    // Indicates that the `ShadowNode` must form a stacking context.
    // A Stacking Context forms a level of a `ShadowView` hierarchy (in contrast
    // with a level of a `ShadowNode` hierarchy).
    // See W3C standard for more details: https://www.w3.org/TR/CSS2/zindex.html
    FormsStackingContext = 1 << 5,

    // Indicates that the node must form a `ShadowView`.
    FormsView = 1 << 6,

    // Internal to `ShadowNode`; do not use it outside.
    // Indicates that `children` list is shared between nodes and need
    // to be cloned before the first mutation.
    ChildrenAreShared = 1 << 7,

    // Indicates that direct children of the node should not be collapsed
    ChildrenFormStackingContext = 1 << 8,
```

| Trait | 语义 |
| --- | --- |
| `FormsView` | **我必须变成一个原生 View** |
| `FormsStackingContext` | **我的子树不能被提升上来**，必须在下一层 View 层级 |
| `ChildrenFormStackingContext` | 我的直接子节点**都不能被扁平化** |

三者是**位标志**（`1 << n`），存在 `ShadowNodeTraits` 的一个整型里，克隆时按位传递。

> `FormsStackingContext` 的注释直接引用了 W3C CSS2 规范 ——
> **Fabric 的扁平化规则是 CSS 规范在 C++ 侧的落地**，不是 RN 自创的启发式。

### 2.2 决策代码

`view/ViewShadowNode.cpp:32-88` 是全部规则的所在。核心是一个 **22 项**的布尔或：

```cpp
  bool formsStackingContext = !viewProps.collapsable ||
      viewProps.pointerEvents == PointerEventsMode::BoxOnly ||
      viewProps.pointerEvents == PointerEventsMode::None ||
      !viewProps.nativeId.empty() || viewProps.accessible ||
      viewProps.opacity != 1.0 || viewProps.transform != Transform{} ||
      (viewProps.zIndex.has_value() &&
       viewProps.yogaStyle.positionType() != yoga::PositionType::Static) ||
      viewProps.yogaStyle.display() == yoga::Display::None ||
      viewProps.getClipsContentToBounds() || viewProps.events.bits.any() ||
      isColorMeaningful(viewProps.shadowColor) ||
      viewProps.accessibilityElementsHidden ||
      viewProps.accessibilityViewIsModal ||
      viewProps.importantForAccessibility != ImportantForAccessibility::Auto ||
      viewProps.removeClippedSubviews || viewProps.cursor != Cursor::Auto ||
      !viewProps.filter.empty() ||
      viewProps.mixBlendMode != BlendMode::Normal ||
      viewProps.isolation == Isolation::Isolate ||
      HostPlatformViewTraitsInitializer::formsStackingContext(viewProps) ||
      !viewProps.accessibilityOrder.empty();
```

`formsView` 是它的超集再加工（`:64-69`）：

```cpp
  bool formsView = formsStackingContext ||
      isColorMeaningful(viewProps.backgroundColor) || hasBorder() ||
      !viewProps.testId.empty() || !viewProps.boxShadow.empty() ||
      !viewProps.backgroundImage.empty() ||
      HostPlatformViewTraitsInitializer::formsView(viewProps) ||
      viewProps.outlineWidth > 0;
```

**`formsView ⊇ formsStackingContext`** —— 凡是要建立层叠上下文的，必然也要有 View（否则无处叠加）。

`isColorMeaningful` 与 `hasBorder` 是两个辅助判断：`:35-42` 的 `hasBorder` 会遍历 yoga 的 4 条边；颜色则要排除透明。

**关键点：`initialize()` 在两个构造函数里都被调用**（`:22`、`:29`）—— 首次创建和克隆时都重算，
所以 props 变化会正确地改变扁平化结果，进而触发**挂载层的结构变化**（不只是属性变化）。

### 2.3 扁平化在挂载期执行

`mounting/internal/sliceChildShadowNodeViewPairs.cpp:112-124` 是消费侧：

```cpp
    // This might not be a FormsView, or a FormsStackingContext. We let the
    // differ handle removal of flattened views from the Mounting layer and
    // shuffling their children around.
    bool childrenFormStackingContexts = shadowNode.getTraits().check(
        ShadowNodeTraits::Trait::ChildrenFormStackingContext);
    bool isConcreteView = (childShadowNode.getTraits().check(
                               ShadowNodeTraits::Trait::FormsView) ||
                           childrenFormStackingContexts) &&
        !childShadowNode.getTraits().check(
            ShadowNodeTraits::Trait::ForceFlattenView);
    bool areChildrenFlattened =
        (!childShadowNode.getTraits().check(
             ShadowNodeTraits::Trait::FormsStackingContext) &&
         !childrenFormStackingContexts) ||
        childShadowNode.getTraits().check(
            ShadowNodeTraits::Trait::ForceFlattenView);
```

两个布尔量的语义：

| 变量 | 含义 | 作用 |
| --- | --- | --- |
| `isConcreteView` | 这个节点自己**会**产生一个 View | 决定是否 `push_back` 为独立层级 |
| `areChildrenFlattened` | 这个节点的子节点**会**被提到它上面 | 决定子节点的坐标是否需要补偿 |

`areChildrenFlattened` 为真时，`:126-129` 记录 `storedOrigin = origin`，
供后续把被"拉平"的子节点坐标从父坐标系转到根坐标系。

**这正是 `formsView` 那个巨大布尔表达式的价值所在**：
一个没有任何视觉效果的 `<View>` 在扁平化后**完全消失**，不占用原生 View 层级。
`<View style={{backgroundColor:'red'}}>` 则会真正创建一个原生 View。

### 2.4 裁剪（culling）也在同一函数

`:85-96` 处理不可裁剪节点：

```cpp
        // Embedded Text components can have an empty layout, while these still
        // need to be mounted to set the correct react tags on the text
        // fragments. These should not be culled.
        auto hasLayout = overflowInsetFrame.size.width > 0 ||
            overflowInsetFrame.size.height > 0;

        auto doesIntersect =
            Rect::intersect(cullingContext.frame, overflowInsetFrame) != Rect{};
        if (hasLayout && !doesIntersect) {
          continue; // Culling.
        }
```

**零尺寸节点不被裁剪** —— 因为 Text 的嵌入 fragment 布局为空，但需要挂载以设置 react tag。
这条豁免避免了「文本不显示」类 bug。

---

## 3. 平台差异：`HostPlatformViewTraitsInitializer`

### 3.1 为什么没有 `view/platform/ios`

`view/platform/` 下只有三个子目录：**`android` / `cxx` / `tvos`**。没有 `ios`。

原因在 CocoaPods 的 header search path 配置（`scripts/cocoapods/utils.rb:416-420`）：

```ruby
                    .concat(ReactNativePodsUtils.create_header_search_path_for_frameworks("PODS_CONFIGURATION_BUILD_DIR", "React-Fabric", "React_Fabric", [
                        "react/renderer/components/view/platform/cxx",
                        "react/renderer/components/scrollview/platform/cxx",
                        "react/renderer/components/scrollview/platform/ios",
                    ], false))
```

**iOS 解析 `view/HostPlatformViewTraitsInitializer.h` 时命中的是 `platform/cxx`。**
注意对比：同一行里 `scrollview` 同时列了 `cxx` 和 `ios` 两个路径，而 `view` **只有 `cxx`**。

CMakeLists 同样如此（`ReactCommon/react/renderer/components/view/CMakeLists.txt:14, 24`）：

```cmake
        platform/cxx/react/renderer/components/view/*.cpp
...
        ${CMAKE_CURRENT_SOURCE_DIR}/platform/cxx/)
```

> **这是一个极易误判的事实**：`cxx` 目录名会让人以为是「C++ 平台专用」，
> 实际上它是 **iOS / macOS / tvOS 共用的默认实现**。
> 只有 `scrollview` 因为 iOS 需要不同的滚动行为才单独拆了 `platform/ios`。

### 3.2 三套实现的差异

**Android**（`packages/react-native/ReactCommon/react/renderer/components/view/platform/android/react/renderer/components/view/HostPlatformViewTraitsInitializer.h:17-32`）：

```cpp
inline bool formsStackingContext(const ViewProps &viewProps)
{
  return viewProps.elevation != 0;
}

inline bool formsView(const ViewProps &viewProps)
{
  return viewProps.nativeBackground.has_value() || viewProps.nativeForeground.has_value() || viewProps.focusable ||
      viewProps.hasTVPreferredFocus || viewProps.needsOffscreenAlphaCompositing ||
      viewProps.renderToHardwareTextureAndroid || viewProps.screenReaderFocusable;
}

inline bool isKeyboardFocusable(const ViewProps &viewProps)
{
  return (viewProps.focusable || viewProps.hasTVPreferredFocus);
}
```

**cxx（iOS/macOS/tvOS 实际使用）**（`packages/react-native/ReactCommon/react/renderer/components/view/platform/cxx/react/renderer/components/view/HostPlatformViewTraitsInitializer.h:17-30`）：

```cpp
inline bool formsStackingContext(const ViewProps & /*props*/)
{
  return false;
}

inline bool formsView(const ViewProps & /*props*/)
{
  return false;
}

inline bool isKeyboardFocusable(const ViewProps & /*props*/)
{
  return false;
}
```

**cxx 版三个函数全部返回 `false`，参数都注掉了名字（`/*props*/`）。**

| 平台 | `formsStackingContext` | `formsView` | `isKeyboardFocusable` |
| --- | --- | --- | --- |
| Android | `elevation != 0` | 7 个原生属性任一存在 | `focusable \|\| hasTVPreferredFocus` |
| **iOS / macOS / tvOS（走 cxx）** | **恒 `false`** | **恒 `false`** | **恒 `false`** |

**这意味着 iOS 上的 View 扁平化决策 100% 由 `ViewShadowNode.cpp` 的公共逻辑决定，
平台钩子不贡献任何条件。** Android 额外会因 `elevation`、`nativeBackground`、`focusable` 等创建 View。

`elevation` 是 Android 独有的属性（阴影会创建绘制层），`nativeBackground` 对应旧架构的
`RCTView` 背景绘制路径 —— 这些在 iOS 上不存在对应概念。

### 3.3 `platform/tvos` 是一份未被引用的重复目录

`view/platform/` 下有 `android` / `cxx` / `tvos` 三个子目录，但**没有任何构建脚本引用 `tvos`**：

```bash
# 全仓库检索 "components/view/platform/tvos"（排除测试与快照）
$ grep -rn "components/view/platform/tvos" packages/ scripts/ private/ | grep -v __tests__ | grep -v __snapshots__
（无输出）
```

而 `cxx` 被 **21 处**引用，分布如下（`grep` 排除测试与快照）：

| 类别 | 文件 | 处数 |
| --- | --- | --- |
| **podspec**（直接声明 header 路径） | `ReactCommon/React-Fabric.podspec`、`React-FabricComponents.podspec`、`React-FabricImage.podspec`、`React/React-RCTFabric.podspec`、`React/React-RCTFBReactNativeSpec.podspec`、`Libraries/AppDelegate/React-RCTAppDelegate.podspec` | 9 |
| **构建脚本** | `scripts/cocoapods/utils.rb`（2）、`scripts/cocoapods/new_architecture.rb`、`scripts/codegen/templates/ReactCodegen.podspec.template`、`scripts/ios-prebuild/setup.js`、`scripts/ios-prebuild/headers-config.js`、`scripts/swiftpm/headers-mappings.js` | 7 |
| **工程文件** | `Package.swift`、`packages/rn-tester/RNTesterPods.xcodeproj/project.pbxproj`（2）、`private/helloworld/ios/HelloWorld.xcodeproj/project.pbxproj`（2） | 5 |

> **这组数字说明的不是「某个可选变体」，而是 `cxx` 才是 iOS/macOS/tvOS 的主实现路径。**
> 6 个 podspec + 3 个构建脚本 + 3 个工程文件都指向它。
> 相比之下 `tvos` 是 0 引用。

逐文件比对结果：

| 文件 | cxx | tvos | 是否相同 |
| --- | --- | --- | --- |
| `HostPlatformTouch.h` | ✓ | ✓ | 相同 |
| `HostPlatformViewEventEmitter.h` | ✓ | ✓ | 相同 |
| `HostPlatformViewProps.h` | ✓ | ✓ | 相同 |
| `HostPlatformViewTraitsInitializer.h` | ✓ | ✓ | 相同 |
| **`HostPlatformViewProps.cpp`** | **✗ 不存在** | ✓ 38 行 | **tvos 独有** |
| `NativeDrawable.h` | ✗ | ✗ | 仅 android 有 |

**4 个同名头文件确实逐字节相同，但 `platform/tvos` 并非 `platform/cxx` 的完整副本** ——
它多一个 `HostPlatformViewProps.cpp`（38 行，解析 `focusable` 属性）。

而 cxx 之所以不需要这个 `.cpp`，是因为它的 `HostPlatformViewProps.h` 是**纯类型别名**：

```cpp
// packages/react-native/ReactCommon/react/renderer/components/view/platform/cxx/react/renderer/components/view/HostPlatformViewProps.h:14-16
namespace facebook::react {
using HostPlatformViewProps = BaseViewProps;
}
```

（`packages/react-native/ReactCommon/react/renderer/components/view/platform/cxx/react/renderer/components/view/HostPlatformViewProps.h:14-16`）

即 **cxx 平台上 `HostPlatformViewProps` 就是 `BaseViewProps`，没有平台专属属性，自然也不需要独立构造实现。**

### 3.3.1 `platform/tvos` 仍是死代码

| 判据 | 结果 |
| --- | --- |
| 全仓库引用（排除测试/快照） | **0 处** |
| podspec 声明的搜索路径 | 6 个 podspec 只声明了 `cxx` |
| 行为差异 | 无（tvos 的 `HostPlatformViewTraitsInitializer` 三个函数与 cxx 完全相同，恒返回 `false`） |

**结论不变：tvOS 实际编译时命中的是 `platform/cxx`，`platform/tvos` 目录不参与构建。**

但「死代码」的**理由**与我最初写的不同 —— 不是「与 cxx 逐字节相同」，
而是「**无人引用，且其行为与 cxx 无差异**」。
保留它可能是为 tvOS 将来需要独立实现预留位置
（注意 tvos 已经比 cxx 多做了 `focusable` 的解析，只是不被使用）。

### 3.3 `isKeyboardFocusable` 的双重来源

`view/ConcreteViewShadowNode.h:115`：

```cpp
    bool isKeyboardFocusable = HostPlatformViewTraitsInitializer::isKeyboardFocusable(props) || props.accessible;
```

**注意末尾的 `|| props.accessible`。** 即使平台钩子返回 `false`，
`accessible={true}` 仍会让节点可获键盘焦点 —— 所以 iOS 上这个钩子返回 false **不等于键盘焦点功能失效**。

这正是「读平台钩子不能只看返回值，要看调用点如何组合」的典型例子。

---

## 4. Trait 的完整清单与生产者

`ShadowNodeTraits.h` 中与视图层级相关的位：

| 位 | 名称 | 谁设置 | 作用 |
| --- | --- | --- | --- |
| `1<<2` | `Hidden` | 各组件 | 整个子树不产生 View |
| `1<<5` | `FormsStackingContext` | `ViewShadowNode::initialize()` | 子树不得上提 |
| `1<<6` | `FormsView` | `ViewShadowNode::initialize()` | 必须产生 View |
| `1<<8` | `ChildrenFormStackingContext` | `ViewShadowNode::initialize()`（`!collapsableChildren`） | 直接子节点不得扁平化 |
| `1<<10` | `ForceFlattenView` | 具体组件 | 强制不产生 View（`mounting/internal/sliceChildShadowNodeViewPairs.cpp:118, 124` 两次短路） |
| `1<<12` | `Unstable_uncullableView` | 有副作用的组件 | 不参与裁剪 |

`ForceFlattenView` 在 `sliceChildShadowNodeViewPairs.cpp` 里出现**两次**（`:118` 和 `:124`），
两次都作为**否定条件** —— 它是"例外中的例外"，优先级最高。

### 4.1 非 View 组件如何设置 Trait

**Text 永远产生 View**（`text/TextShadowNode.h:32`）：

```cpp
    traits.set(ShadowNodeTraits::Trait::FormsView);
```

**Paragraph 在 Android 上必须取消层叠上下文**（`text/ParagraphShadowNode.h:51-55`）：

```cpp
    // Unsetting `FormsStackingContext` trait is essential on Android where we
    ...
    traits.unset(ShadowNodeTraits::Trait::FormsStackingContext);
```

注释里 "essential on Android" 是**平台限定**的表述 —— 与 §3.2 的 Android/Cxx 差异同源。

**LayoutConformance** 在 `ConcreteViewShadowNode.h:74-75` 直接全开：

```cpp
    traits.set(ShadowNodeTraits::Trait::FormsStackingContext);
    traits.set(ShadowNodeTraits::Trait::FormsView);
```

> **规律**：只有 `View`（及从它派生的 `LayoutConformance`）才做「条件性」扁平化计算。
> 其他组件（Text 等）直接硬编码 Trait，因为它们必然需要原生表示。
> 条件性逻辑集中在 `ViewShadowNode::initialize()` 一处。

---

## 5. `RootShadowNode`：每个 Surface 的根

`root/` 只有 5 个源文件，但它是每个 Surface 的入口。`root/RootProps.cpp` 与
`root/RootShadowNode.cpp` 分别定义根节点的 Props 与节点类型。

`ShadowNodeTraits.h:40` 有一个专门的位：

```cpp
    RootNodeKind = 1 << 1,
```

根节点带上 `RootNodeKind`，供 `ShadowTree` 识别与断言用。

---

## 6. `legacyviewmanagerinterop/`：新旧架构的接缝

10 个文件，作用是让**旧架构的 ViewManager 能渲染 Fabric 里的未注册组件**。

`ComponentDescriptorRegistry.cpp` 的三段回退（见 [08 文档 §4.1](./08-组件注册表与惰性注册.md)）中，
`useFabricInterop()` 开启时走的正是这里的
`UnstableLegacyViewManagerAutomaticComponentDescriptor`。

**这是 08 文档 E1-4「Release 下未注册组件静默变空视图」的对照路径** ——
开了 interop 就走旧 ViewManager，没开就变空视图。

---

## 7. `unimplementedview/`：兜底组件

6 个文件，对应 `UnimplementedNativeViewComponentDescriptor`。
源码注释说明了 Debug / Release 的差异：

```cpp
    // UnimplementedNativeViewComponentDescriptor displays a View in debug
    // mode to alert the developer that the component is not properly
    // configured, and an empty view in release mode.
```

| 构建类型 | 渲染结果 | 可见性 |
| --- | --- | --- |
| Debug | 一个提醒用的 View | 开发者能看见 |
| Release | 空视图 | **完全静默** |

---

## 8. 本模块的设计要点

| 设计 | 收益 | 代价 / 风险 |
| --- | --- | --- |
| ShadowNode 树与 View 树分离 | 无视觉效果的 View 零原生开销 | 坐标系转换（`storedOrigin`）易错 |
| Trait 用位标志传递 | 克隆时按位复制，零成本 | 位含义分散在多处，缺集中校验 |
| 扁平化条件集中在 `ViewShadowNode::initialize()` | 单一决策点 | 该函数是 22 项布尔或，改动影响面大 |
| 平台钩子返回常量 `false` | cxx 侧零维护 | iOS 无法自定义扁平化策略，只能改公共逻辑 |
| 零尺寸节点豁免裁剪 | 避免嵌入 Text 丢失 react tag | 零尺寸但有副作用的节点会漏挂载 |
| `ForceFlattenView` 双重否定短路 | 例外优先级明确 | 两处硬编码，易漏改 |
| Trait 随 props 重算 | props 变化能改变挂载结构 | 一次 prop 变更可能引发结构性重挂载 |

---

## 9. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| A2-1 | `view/platform/ios` 目录不存在，iOS 复用 `cxx` | `scripts/cocoapods/utils.rb:416-420` | 极易误判平台行为；iOS 无法单独定制 View trait |
| A2-2 | `platform/tvos` 无任何构建脚本引用，且行为与 `cxx` 无差异 | `view/platform/tvos/`（5 文件，比 cxx 多一个 `.cpp`） | 死代码；tvOS 实际走 `cxx`，改 `tvos` 不生效 |
| A2-3 | cxx 版 `isKeyboardFocusable` 恒 `false` | `packages/react-native/ReactCommon/react/renderer/components/view/platform/cxx/react/renderer/components/view/HostPlatformViewTraitsInitializer.h:27-30` | 仅因 `ConcreteViewShadowNode.h:115` 的 `\|\| props.accessible` 兜底才可用 |
| A2-4 | 扁平化条件是 22 项布尔或，无注释分组 | `view/ViewShadowNode.cpp:44-62` | 无法快速判断某属性为何触发；改动易漏测 |
| A2-5 | `formsView` / `formsStackingContext` 无 `react_native_assert` 保证包含关系 | `view/ViewShadowNode.cpp:64-81` | 若未来把 `formsStackingContext` 的条件移出 `formsView`，会出现有层叠上下文却无 View 的非法状态 |
| A2-6 | UnimplementedView 在 Release 下完全静默 | `ComponentDescriptorRegistry.cpp:100-108` | 白屏根因之一（与 E1-4 同源） |
| A2-7 | Trait 位含义无集中定义文档 | `core/ShadowNodeTraits.h:40-89` | 跨组件推理困难；新增位易与现有位冲突 |

> **A2-1 的排查记录**：曾怀疑 `scripts/cocoapods/__tests__/utils-test.rb:1155`
> 引用的 `view/platform/ios` 是失效路径。经查该行是 `add_dependency` 通用函数测试中
> 使用的**任意示例字符串**，非生产代码引用，**不构成缺陷**。
> **真实引用共 21 处**（构成见 §3.3 表格），
> **全部指向 `cxx`，无一处指向 `ios`**。

---

## 10. 与其他文档的衔接

- Props 如何被解析与克隆 → [07 文档](./07-Fabric组件层与Props体系.md)
- Descriptor 的发现与回退 → [08 文档](./08-组件注册表与惰性注册.md)
- 扁平化后的树如何 diff → [09 文档 §5](./09-渲染器核心与差分算法.md)
- 未注册组件导致的白屏 → [05 文档 §3](./05-监控检测原理与流程.md)
- Android 侧 View 的落地实现 → 批次 4 的 Android 平台层文档

---

## 11. 验证方式

```bash
node docs/arch/audit/audit-citations.mjs    # 引用可达性
node docs/arch/audit/verify-quotes.mjs      # 代码块语义
```
