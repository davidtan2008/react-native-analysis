---
id: 37
title: "legacy 布局层被整体掏空：UIManager / ShadowView / RCTLayout 与 ShadowQueue 的转用"
topic: RN.legacy
symptoms: [layout]
platforms: [ios]
architecture: [legacy]
layer: T1
symbols: ["RCTShadowView", "RCTUIManager"]
sourceRoot: react-native
claims: [BB-1, BB-2, BB-3, BB-4, BB-5, BB-6, BB-7, BB-8, BB-9, BB-10, BB-11]
---
# 37 · legacy 布局层被整体掏空：UIManager / ShadowView / RCTLayout 与 ShadowQueue 的转用

> **模块**：C1 · `React/Modules/RCTUIManager.mm` + `React/Views/RCTShadowView.*`
> / `RCTShadowView+Layout.*` / `RCTLayout.*` / `RCTUIManagerUtils.*`
> / `RCTUIManagerObserverCoordinator.*` / `React/Base/Surface/RCTSurfaceRootShadowView.*`
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · legacy（Paper）架构
> **前置**：[25 文档](./25-iOS桥接核心与启动性能标签.md) 记录了 `RCTModuleData`
> 被清空为 3 个空方法的无 ivar 空壳、`RCTBridge` 的 4 个 reload 方法空实现；
> [36 文档](./36-legacy-View层ComponentData与hitTest.md) 记录了 legacy 侧
> `RCTComponentData` 这个「真身」与 `RCTView.hitTest`。
>
> 本文记录 **legacy 布局子系统被整体退役的证据链**：
> `RCTUIManager` 的 **21 个方法全部是桩**、
> `RCTShadowView` 的 63 个属性只有 2 个 `@synthesize`、
> 以及 **ShadowQueue 被 NativeAnimation 转用**这一「同一队列、两种用途」的事实。
>
> **本文的核心价值是给出可复用的判据**：如何区分「接口保留但实现退役」
> 与「接口保留且实现缺失（bug）」。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `Modules/RCTUIManager.mm` | 300 | **UIManager（21 方法全桩）** |
| `Modules/RCTUIManagerUtils.m` | 104 | **ShadowQueue + rootViewTag 分配** |
| `Modules/RCTUIManagerObserverCoordinator.mm` | 100 | 布局观察者分发（零观察者） |
| `Views/RCTShadowView.m` | 105 | **ShadowView（18 方法全桩）** |
| `Views/RCTShadowView+Layout.m` | 69 | Yoga 布局读取（零调用方） |
| `Views/RCTLayout.m` | 139 | **Yoga↔CoreGraphics 转换（2 个零调用方）** |
| `Base/Surface/RCTSurfaceRootShadowView.m` | 19 | **唯一子类（2 方法全空）** |
| `Modules/RCTSurfacePresenterStub.m` | 40 | 关联对象存 presenter |
| `Views/RCTWrapperViewController.m` | 82 | 包装 VC |
| `Views/RCTViewUtils.m` / `RCTConvert+CoreLocation.m` | 各 22 | 辅助 |

---

## 2. `RCTUIManager`：21 个方法，全部是桩

### 2.1 逐方法清点（实测）

`React/Modules/RCTUIManager.mm` 的 `@implementation RCTUIManager`
（`:131-214`）共 **21 个方法**：

| 类别 | 数量 | 具体 |
| --- | --- | --- |
| **完全空 `{}`** | **15** | `registerRootViewTag:`、`registerRootView:`、`removeViewFromRegistry:`、`setAvailableSize:forRootView:`、`setLocalData:forView:`、`setSize:forView:`、`setIntrinsicContentSize:forView:`、`setNextLayoutAnimationGroup:`、`addUIBlock:`、`prependUIBlock:`、`synchronouslyUpdateViewOnUIThread:viewName:props:`、`rootViewForReactTag:withCompletion:`、`setNativeID:forView:`、`setNeedsLayout`、`invalidate` |
| **`return nil`** | **5** | `viewForReactTag:`（`:135-137`）、`viewNameForReactTag:`（`:150-153`）、`shadowViewForReactTag:`（`:155-158`）、`viewForNativeID:withRootTag:`（`:196-199`）、`+JSResponder`（`:205-208`） |
| **有真实返回值** | **1** | `+moduleName` → `@"UIManager"`（`:210-213`） |

`:131-141` 的开头三行就是连续的桩：

```objc
@implementation RCTUIManager
- (void)registerRootViewTag:(NSNumber *)rootTag
{
}

- (void)registerRootView:(UIView *)rootView
{
}

- (UIView *)viewForReactTag:(NSNumber *)reactTag
{
  return nil;
}
```

### 2.2 但文件里有两个**有实质逻辑**的部分

**不能把整个文件判为死代码** —— 前 130 行有两个活跃实现：

**① `RCTModuleConstantsForDestructuredComponent`**（C 函数，`:38-129`）：

```objc
NSMutableDictionary<NSString *, id> *RCTModuleConstantsForDestructuredComponent(
    NSMutableDictionary<NSString *, NSString *> *directEvents,
    NSMutableDictionary<NSString *, NSString *> *bubblingEvents,
    Class managerClass,
    NSString *name,
    NSDictionary<NSString *, id> *viewConfig)
```

它组装 `Manager` / `NativeProps` / `baseModuleName` /
`bubblingEventTypes` / `directEventTypes` 五个常量，
供 JS 侧读取组件配置。**这是活的**。

**② `RCTComposedViewRegistry`**（`:216-289`）：一个 `NSDictionary` 外观，
`objectForKey:` 与 `removeObjectForKey:` 都有真实逻辑，
`objectForKey:` 会**先查自己的 `_registry`、再回落到 `[_uiManager viewForReactTag:]`**：

```objc
- (id)objectForKey:(id)key
{
  if (![key isKindOfClass:[NSNumber class]]) {
    return NULL;
  }

  NSNumber *index = (NSNumber *)key;
  UIView *view = _registry[index];
  if (view) {
    return RCTPaperViewOrCurrentView(view);
  }
  view = [_uiManager viewForReactTag:index];
  if (view) {
    return RCTPaperViewOrCurrentView(view);
  }
  return NULL;
}
```

**但这条回落路径调用的正是那个 `return nil` 的桩** ——
所以即使 `_registry` 没命中，结果永远是 `NULL`。

> **判据示范**：同一个文件里，「一个类全是桩」
> 与「另一个类有完整逻辑」并存。
> **「文件级」结论会掩盖「类级」事实。**

### 2.3 为什么保留 21 个桩

| 保留原因 | 证据 |
| --- | --- |
| **模块名解析** | `React/Base/RCTBridge.mm:62` 把 `@"RCTUIManager"` 放进 `coreModuleClasses` 集合；`RCTBridge(RCTUIManager)` 的 `uiManager` 走 `moduleForClass:`（`RCTUIManager.mm:220-223`）。若类不存在，`moduleForClass:` 会崩 |
| **JS API 表面稳定** | JS 侧若 `TurboModuleRegistry.get('UIManager')` 会得到一个「能调用但什么都不做」的对象 |
| **`RCTComposedViewRegistry` 的类型依赖** | 它的 `__weak RCTUIManager *_uiManager` 需要真实类 |

**「能取到但什么都不做」是一个隐蔽的失败模式**：
JS 侧 `UIManager.measure(...)` 不会崩、不会警告，只是**布局不发生**。

---

## 3. `RCTShadowView`：63 个属性，2 个 `@synthesize`

### 3.1 声明与实现的落差

| 项 | 数量 | 位置 |
| --- | --- | --- |
| 头文件的 `@property` | **63** | `Views/RCTShadowView.h` |
| 其中 Yoga 相关（`YGValue` / `yogaNode`） | **36** | 同上 |
| `.m` 里的 `@synthesize` | **2** | `RCTShadowView.m:20-21`（`reactTag`、`rootTag`） |
| `.m` 里的 ivar 块 | **0** | `@implementation RCTShadowView` 后直接是方法 |

```objc
@implementation RCTShadowView
@synthesize reactTag = _reactTag;
@synthesize rootTag = _rootTag;

+ (YGConfigRef)yogaConfig
{
  return YGConfigNew();
}
```

**其余 61 个属性靠 Objective-C 自动合成** —— 编译器生成 ivar + getter/setter，
**不与 Yoga 发生任何交互**。

**即 `self.yogaNode` 返回一个从未被 `YGNodeNew()` 赋值的指针**
（自动合成使它为 `nil`/`0`）。

### 3.2 18 个方法：8 个完全空 + 10 个返回常量

| 类别 | 数量 | 方法（位置：`Views/RCTShadowView.m`） |
| --- | --- | --- |
| **完全空 `{}`** | **8** | `insertReactSubview:atIndex:`（`:46`）、`removeReactSubview:`（`:49`）、`setLocalData:`（`:53`）、`layoutWithMinimumSize:maximumSize:layoutDirection:layoutContext:`（`:58`）、`layoutWithMetrics:layoutContext:`（`:65`）、`layoutSubviewsWithContext:`（`:69`）、`didUpdateReactSubviews`（`:88`）、`didSetProps:`（`:91`） |
| **返回硬编码常量** | **9** | `reactTagAtPoint:`（`:28`→`0`）、`isReactRootView`（`:33`→`NO`）、`reactSubviews`（`:38`→`@[]`）、`reactSuperview`（`:42`→`nil`）、`sizeThatFitsMinimumSize:maximumSize:`（`:73`→`CGSizeZero`）、`canHaveSubviews`（`:78`→`NO`）、`isYogaLeafNode`（`:83`→`NO`）、`measureLayoutRelativeToAncestor:`（`:95`→`CGRectNull`）、`viewIsDescendantOf:`（`:100`→`NO`） |
| **有真实行为** | **1** | `+yogaConfig`（`:23`）→ `YGConfigNew()` |

**没有任何一个方法触碰 `yogaNode`。**

### 3.3 唯一子类也是空的

`Base/Surface/RCTSurfaceRootShadowView.h:13` 是**唯一的子类声明**
（全仓库 `: RCTShadowView` 只有这一处）。其实现 `RCTSurfaceRootShadowView.m`
（19 行）：

```objc
@implementation RCTSurfaceRootShadowView
- (void)setMinimumSize:(CGSize)size maximumSize:(CGSize)maximumSize
{
}

- (void)layoutWithAffectedShadowViews:(NSPointerArray *)affectedShadowViews
{
}

@end
```

**两个方法全空。**

**但它的头文件有 34 行声明**，包括 `intrinsicSize`、`baseDirection`、
`delegate`（带 `__deprecated_msg("This API will be removed along with the legacy architecture.")`）。

> **这个 `__deprecated_msg` 是全仓库对 legacy 架构退役最直白的表态**。
> 与 25 文档记录的「`RCTModuleData` 无 `__attribute__((deprecated))`」
> 形成对照：**有的地方明确标注了，有的地方只是默默清空。**

---

## 4. `RCTLayout` 与 `RCTShadowView+Layout`：整层死代码

### 4.1 三个零调用方的函数

`Views/RCTLayout.h` 声明了 8 个 `RCT_EXTERN` 函数，实测调用方：

| 函数 | 定义位置 | 生产调用方 |
| --- | --- | --- |
| **`RCTLayoutMetricsFromYogaNode`** | `RCTLayout.m:13-49` | **0** |
| `RCTYogaFloatFromCoreGraphicsFloat` | `RCTLayout.m:59-66` | 见 `RCTShadowView+Layout.m` 等 |
| `RCTCoreGraphicsFloatFromYogaFloat` | `RCTLayout.m:68-75` | 多处 |
| `RCTCoreGraphicsFloatFromYogaValue` | `RCTLayout.m:77-91` | — |
| `RCTYogaLayoutDirectionFromUIKitLayoutDirection` | `RCTLayout.m:93-101` | — |
| `RCTUIKitLayoutDirectionFromYogaLayoutDirection` | `RCTLayout.m:103-112` | `RCTLayout.m:46` |
| **`RCTYogaDisplayTypeFromReactDisplayType`** | `RCTLayout.m:114-125` | **0** |
| `RCTReactDisplayTypeFromYogaDisplayType` | `RCTLayout.m:127-139` | `RCTLayout.m:45` |

**注意 `RCTLayoutMetricsFromYogaNode` 是本文件的主函数**
（组装 `RCTLayoutMetrics` 的 5 个字段），它零调用方意味着
**没有任何代码再从 Yoga 节点读出 legacy 布局结果**。

### 4.2 `RCTLayoutContext` 从未被构造

`Views/RCTLayout.h:32-37`：

```objc
struct RCTLayoutContext {
  CGPoint absolutePosition;
  __unsafe_unretained NSPointerArray *_Nonnull affectedShadowViews;
  __unsafe_unretained NSHashTable<NSString *> *_Nonnull other;
};
typedef struct CG_BOXABLE RCTLayoutContext RCTLayoutContext;
```

全仓库对 `RCTLayoutContext` 的引用只有 **8 处**：
`RCTLayout.h` 的定义（2 处）+ `RCTShadowView.h` 三个方法的参数（3 处）
+ `RCTShadowView.m` 对应空实现的参数（3 处）。

**没有任何一处构造这个 struct**（无 `{...}` 初始化、无 `make` 函数）。

**`other` 字段名本身就是一个信号** ——
一个叫 `other` 的 `NSHashTable<NSString *> *` 参数，
在任何使用点都不出现。**这是「曾有用途、现已无人填充」的残留形态。**

### 4.3 `RCTShadowView+Layout.m`：零调用方，且其路径会解空指针

`Views/RCTShadowView+Layout.m` 的 `paddingAsInsets` / `borderAsInsets`
直接读 Yoga 节点：

```objc
- (UIEdgeInsets)paddingAsInsets
{
  YGNodeRef yogaNode = self.yogaNode;
  return (UIEdgeInsets){RCTCoreGraphicsFloatFromYogaFloat(YGNodeLayoutGetPadding(yogaNode, YGEdgeTop)),
                        ...
```

而 `self.yogaNode` 因自动合成**从未被赋值**（§3.1）。

Yoga 侧的 `resolveRef` **不做判空**：

```cpp
// packages/react-native/ReactCommon/yoga/yoga/node/Node.h:364-366
inline Node* resolveRef(const YGNodeRef ref) {
  return static_cast<Node*>(ref);
}
```

**纯 `static_cast`。** 所以 `YGNodeLayoutGetPadding(nullptr, YGEdgeTop)`
会走到 `YGNodeLayout.cpp:20-31`：

```cpp
template <auto LayoutMember>
float getResolvedLayoutProperty(const YGNodeConstRef nodeRef, const Edge edge) {
  const auto node = resolveRef(nodeRef);
  yoga::assertFatalWithNode(
      node,
      edge <= Edge::End,
      "Cannot get layout properties of multi-edge shorthands");
  ...
```

`assertFatalWithNode` 的断言条件是 `edge <= Edge::End`（**与 node 是否为 null 无关**），
条件为真 → 不中止 → 继续 `node->getLayout()` → **空指针解引用崩溃**。

**实测这些方法的调用方为 0**，所以崩溃不会发生。
`RCTLayout.m:34-37` 自己算了一份 `compoundInsets`（不经过 `RCTShadowView`）。

| | `RCTShadowView+Layout.m` | `RCTLayout.m` |
| --- | --- | --- |
| `compoundInsets` 的算法 | border + padding | border + padding（**逐字相同的公式**） |
| 是否活 | ❌ 零调用方 | ✅ 被 `RCTLayoutMetricsFromYogaNode` 用（后者也零调用方） |
| 数据来源 | `self.yogaNode` | 传入的 `YGNodeRef yogaNode` |

> **两处重复实现同一算法、其中一处是死代码** ——
> 这是重构时的典型陷阱：改动活的那份，死的那份会静默腐化。

---

## 5. 【核心发现】rootViewTag 生成器：三个平台各一份，序列相同、计数器独立

### 5.1 三份实现并排

| 平台 | 文件 | 函数 |
| --- | --- | --- |
| iOS（ObjC） | `React/Modules/RCTUIManagerUtils.m:98-103` | `RCTAllocateRootViewTag` |
| Android（Kotlin） | `ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactRootViewTagGenerator.kt:12-23` | `ReactRootViewTagGenerator.getNextRootViewTag()` |
| 跨平台（C++） | `ReactCommon/react/renderer/core/ReactRootViewTagGenerator.cpp:14-20` | `facebook::react::getNextRootViewTag()` |

**iOS（ObjC）**：

```objc
// packages/react-native/React/Modules/RCTUIManagerUtils.m:98-103
NSNumber *RCTAllocateRootViewTag(void)
{
  // Keep in sync with ReactRootViewTagGenerator.h - see that file for an explanation on why the
  // increment here is 10.
  static _Atomic int64_t rootViewTagCounter = 0;
  return @(atomic_fetch_add_explicit(&rootViewTagCounter, 1, memory_order_relaxed) * 10 + 1);
}
```

**Android（Kotlin）**：

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactRootViewTagGenerator.kt:12-23
  // Keep in sync with ReactRootViewTagGenerator.h - see that file for an explanation on why the
  // increment here is 10.
  private const val ROOT_VIEW_TAG_INCREMENT = 10
  private var nextRootViewTag = 1

  @JvmStatic
  @Synchronized
  fun getNextRootViewTag(): Int =
      nextRootViewTag.also { nextRootViewTag += ROOT_VIEW_TAG_INCREMENT }
```

**跨平台（C++）**：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/ReactRootViewTagGenerator.cpp:14-20
constexpr SurfaceId ROOT_VIEW_TAG_INCREMENT = 10;

SurfaceId getNextRootViewTag() noexcept {
  // Numbering of these tags goes from 11, 21, 31, ..., 100501, ...
  static std::atomic<SurfaceId> nextRootViewTag = 1;
  return nextRootViewTag += ROOT_VIEW_TAG_INCREMENT;
}
```

### 5.2 序列核对：三者产出完全相同

| 实现 | 计数器初值 | 运算 | 第 1 个 | 第 2 个 | 第 3 个 |
| --- | --- | --- | --- | --- | --- |
| ObjC `RCTAllocateRootViewTag` | `0` | `(fetch_add(+1)) * 10 + 1` | 0+1=1 → **11** | 2 → **21** | 3 → **31** |
| Kotlin `getNextRootViewTag` | `1` | `+= 10`（先加后取） | 1+10=**11** | 21 | 31 |
| C++ `getNextRootViewTag` | `1` | `+= 10` | **11** | 21 | 31 |

**三条路径产出完全相同的序列 `11, 21, 31, ...`，但各持一个独立计数器。**

> **若同进程内混用两份，tag 会立即撞号。**
> 这是本仓库最值得记录的一处「差一步就出事」的构造。

### 5.3 实际调用状况

| 实现 | 生产调用方 | 测试调用方 | 状态 |
| --- | --- | --- | --- |
| **ObjC** `RCTAllocateRootViewTag` | **0** | 0 | **死代码** |
| **Kotlin** `getNextRootViewTag()` | **3**：`ReactRootView.java:139`、`FabricUIManager.java:391`、`UIManagerModule.kt:233` | — | 活 |
| **C++** `getNextRootViewTag()` | **1**：`RCTFabricSurface.mm:62` | 15（`ReactCommon/react/renderer/animated/tests/` 下 5 个文件） | 活 |

```
$ grep -rn "RCTAllocateRootViewTag" packages/ | grep -v RCTUIManagerUtils
（无输出）
```

**iOS 上今天不撞号 —— 靠的是「ObjC 那个没人调」，而不是靠某种协调机制。**

**跨平台也不撞号** —— iOS 用 C++ 版、Android 用 Kotlin 版，
两个进程本就独立计数器。

> **真正的风险是 iOS 内部**：若有人「修复」那个零调用的 ObjC 函数
> （例如接回 `RCTRootView`），就会与 C++ 版同时被调用，
> 产生 **11, 11, 21, 21, …** 的重复 tag。
>
> **「死代码 + 相同的活实现」是一个比「完全没有代码」更危险的形态。**

### 5.4 【新发现】两份注释逐字相同，且都指错了文件

iOS 与 Android 的注释**逐字一致**：

```
// packages/react-native/React/Modules/RCTUIManagerUtils.m:100
  // Keep in sync with ReactRootViewTagGenerator.h - see that file for an explanation on why the
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactRootViewTagGenerator.kt:13
  // Keep in sync with ReactRootViewTagGenerator.h - see that file for an explanation on why the
```

但 `ReactRootViewTagGenerator.h` 的**全文**是：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/ReactRootViewTagGenerator.h:7-18
#pragma once

#include <react/cxxstableapi/UmbrellaGuard.h>
#include <react/renderer/core/ReactPrimitives.h>

namespace facebook::react {

SurfaceId getNextRootViewTag() noexcept;

} // namespace facebook::react
```

**头文件里没有任何关于「为什么增量是 10」的说明。**
真正的说明在 **`.cpp:17`**：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/ReactRootViewTagGenerator.cpp:17
  // Numbering of these tags goes from 11, 21, 31, ..., 100501, ...
```

> **注释指向的头文件里没有它承诺的内容。**
> 这是 [26 文档 I-4](./26-iOS-Base余部网络图像与快捷键.md)
> 「注释声称有但代码没有」的**变体**：
> 这次不是代码缺功能，而是**注释的指针指错了位置**。
>
> **且因为逐字复制，这个错误在两个平台上同步传播** ——
> 改一处不会改另一处。

### 5.5 并列：原子 vs 同步的三种写法

| 实现 | 并发原语 | 内存序 |
| --- | --- | --- |
| ObjC `RCTAllocateRootViewTag` | `static _Atomic int64_t` + `atomic_fetch_add_explicit` | **`memory_order_relaxed`** |
| Kotlin `getNextRootViewTag()` | `@Synchronized`（对象锁） | 隐含全序 |
| C++ `getNextRootViewTag()` | `static std::atomic<SurfaceId>` + `operator+=` | 默认 `seq_cst` |

**三者都正确**，但风格各异：

- ObjC 选 `relaxed` —— **最贴切**（只需唯一，不需与其他内存操作排序）。
- C++ 用默认 `seq_cst` —— **更强但无害**（无性能敏感路径）。
- Kotlin 用 `@Synchronized` —— JVM 上惯用，但对一个只做整数加的方法偏重。

这是继 [29 文档 §4](./29-iOS平台能力族DeviceInfo与Accessibility.md)
`RCTDeviceInfo.invalidate` 用 `std::atomic` + `exchange(YES)` 做原子幂等之后，
**第二处「原子用对了」的正面对照**；也是
**第一处「同一逻辑三平台三写法」的横向对照**。

### 5.6 对照 27 文档的正面样本

[27 文档](./27-iOS帧驱动与性能监控.md) 记录了 `RCTTiming.mm` ↔ `JSTimers.js`
帧常量**双向同步声明**（两处互相引用、都能验证）。

| | `RCTTiming` ↔ `JSTimers`（27 文档） | rootViewTag × 3（本文） |
| --- | --- | --- |
| 份数 | 2 | **3** |
| 注释是否互相指向 | ✅ 双向 | ❌ **两份都单向指向一个无说明的头文件** |
| 能否机器验证 | ✅ 常量在两处可断言相等 | ✅ 序列可断言，但**三份计数器独立** |
| 平台隔离 | 同为 iOS | iOS / Android / 跨平台 |

> **27 文档是「同步做对了」的样本，本文是「同步没做对」的样本。**
> 二者构成完整对照。

---

## 6. ShadowQueue：名字是 UIManager，用途已是 NativeAnimation

### 6.1 队列本身是活的

`Modules/RCTUIManagerUtils.m:14-31`：

```objc
char *const RCTUIManagerQueueName = "com.facebook.react.ShadowQueue";

dispatch_queue_t RCTGetUIManagerQueue(void)
{
  static dispatch_queue_t shadowQueue;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    if ([NSOperation instancesRespondToSelector:@selector(qualityOfService)]) {
      dispatch_queue_attr_t attr =
          dispatch_queue_attr_make_with_qos_class(DISPATCH_QUEUE_SERIAL, QOS_CLASS_USER_INTERACTIVE, 0);
      shadowQueue = dispatch_queue_create(RCTUIManagerQueueName, attr);
    } else {
      shadowQueue = dispatch_queue_create(RCTUIManagerQueueName, DISPATCH_QUEUE_SERIAL);
      dispatch_set_target_queue(shadowQueue, dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_HIGH, 0));
    }
  });
  return shadowQueue;
}
```

**名称仍是 `ShadowQueue`，QoS 是 `QOS_CLASS_USER_INTERACTIVE`。**

### 6.2 但它的实际调用方

| 调用方 | 位置 | 数量 |
| --- | --- | --- |
| **`RCTNativeAnimatedTurboModule.mm`** | `:253`、`:264`、`:271`（`dispatch_async`）、`:312`、`:327`（`RCTExecuteOnUIManagerQueue`） | **5** |
| `RCTViewManager.m` | `:133-136` 的 `methodQueue` | 1 |
| `RCTProfile.m` | `:473` 仅用队列**名字**做 profiling 标记 | 1 |

**即：ShadowQueue 现在主要服务 NativeAnimated，legacy 布局已不再使用它。**

### 6.3 「伪 UIManager 队列」的信号量乒乓

`RCTUIManagerUtils.m:65-95`：

```objc
void RCTUnsafeExecuteOnUIManagerQueueSync(dispatch_block_t block)
{
  if (RCTIsUIManagerQueue() || RCTIsPseudoUIManagerQueue()) {
    block();
  } else {
    if (RCTIsMainQueue()) {
      dispatch_semaphore_t mainQueueBlockingSemaphore = dispatch_semaphore_create(0);
      dispatch_semaphore_t uiManagerQueueBlockingSemaphore = dispatch_semaphore_create(0);

      // Dispatching block which blocks UI Manager queue.
      dispatch_async(RCTGetUIManagerQueue(), ^{
        // Initiating `block` execution on main queue.
        dispatch_semaphore_signal(mainQueueBlockingSemaphore);
        // Waiting for finishing `block`.
        dispatch_semaphore_wait(uiManagerQueueBlockingSemaphore, DISPATCH_TIME_FOREVER);
      });

      // Waiting for block on UIManager queue.
      dispatch_semaphore_wait(mainQueueBlockingSemaphore, DISPATCH_TIME_FOREVER);
      pseudoUIManagerQueueFlag = YES;
      // `block` execution while UIManager queue is blocked by semaphore.
      block();
      pseudoUIManagerQueueFlag = NO;
      // Signalling UIManager block.
      dispatch_semaphore_signal(uiManagerQueueBlockingSemaphore);
    } else {
      dispatch_sync(RCTGetUIManagerQueue(), ^{
        block();
      });
    }
  }
}
```

**机制**：在主线程调用时，往 ShadowQueue 派一个「占位块」并让它**阻塞在信号量上**，
使 ShadowQueue 在整个 `block` 执行期间**处于被占用状态**；
随后把 `pseudoUIManagerQueueFlag = YES`，让 `RCTIsPseudoUIManagerQueue()`
在主线程上返回 `YES` —— **「假装」自己在 UIManager 队列上**。

**为什么需要这个假象**：
让「必须在 UIManager 队列执行」的旧代码能在新架构下继续工作，
而不必修改调用方。

### 6.4 `pseudoUIManagerQueueFlag` 的线程安全性

`RCTUIManagerUtils.m:16` 声明为普通 `static BOOL`（非原子）：

```objc
static BOOL pseudoUIManagerQueueFlag = NO;
```

读写点：
- 写：`:83`（置 `YES`）、`:87`（置 `NO`）—— **都在 `RCTIsMainQueue()` 为真的分支内**
- 读：`RCTIsPseudoUIManagerQueue()`（`:43-50`），**函数第一行就是 `if (RCTIsMainQueue())`**

**即所有访问都在主线程 → 无数据竞争。**

> **但这是「靠调用点约定」而非「靠类型保证」的安全。**
> 与 [29 文档 §4](./29-iOS平台能力族DeviceInfo与Accessibility.md) 的
> `RCTDeviceInfo.invalidate` 用 `std::atomic` 的做法相反 ——
> **同一个仓库里两种风格并存**。

---

## 7. `RCTUIManagerObserverCoordinator`：零观察者 + 跨回调持锁

### 7.1 结构与锁

`Modules/RCTUIManagerObserverCoordinator.mm:14-26`：

```objc
@implementation RCTUIManagerObserverCoordinator {
  NSHashTable<id<RCTUIManagerObserver>> *_observers;
  std::mutex _mutex;
}

- (instancetype)init
{
  if (self = [super init]) {
    _observers = [[NSHashTable alloc] initWithOptions:NSHashTableWeakMemory capacity:0];
  }

  return self;
}
```

**弱引用哈希表**（观察者释放即自动移除）+ **`std::mutex`**。

### 7.2 五个通知方法，锁都跨越回调

`:42-100` 的五个方法结构完全一致：

```objc
- (void)uiManagerWillPerformLayout:(RCTUIManager *)manager
{
  std::lock_guard<std::mutex> lock(_mutex);

  for (id<RCTUIManagerObserver> observer in _observers) {
    if ([observer respondsToSelector:@selector(uiManagerWillPerformLayout:)]) {
      [observer uiManagerWillPerformLayout:manager];
    }
  }
}
```

| 方法 | 位置 | 返回 | 特殊 |
| --- | --- | --- | --- |
| `uiManagerWillPerformLayout:` | `:42-50` | void | |
| `uiManagerDidPerformLayout:` | `:53-61` | void | |
| `uiManagerWillPerformMounting:` | `:64-72` | void | |
| `uiManager:performMountingWithBlock:` | `:75-87` | `BOOL` | 首个返回 `YES` 的观察者**短路**（`:80-84`） |
| `uiManagerDidPerformMounting:` | `:89-97` | void | |

**另有 `addObserver:`（`:28-32`）与 `removeObserver:`（`:34-38`）也取同一把锁** ——
全文件共 **7 处 `std::lock_guard`**，即任何观察者在回调中调这两个方法都会死锁。

**`std::lock_guard` 的作用域覆盖整个 for 循环** ——
即**持有互斥锁的同时调用任意外部代码**。

### 7.3 零观察者

```
$ grep -rn "RCTUIManagerObserver\b" packages/react-native/React | grep -v Coordinator | grep -v RCTUIManager.h
（无输出）
```

**没有任何类实现 `RCTUIManagerObserver` 协议，也没有人调用 `addObserver:`。**

### 7.4 风险评估（当前不可达）

| 风险 | 触发条件 | 当前状态 |
| --- | --- | --- |
| **重入死锁** | 观察者在回调里调 `addObserver:` / `removeObserver:`（这两个方法也取同一把锁，`std::mutex` 不可重入） | **零观察者，不可达** |
| **`NSHashTable` 枚举中被修改** | 观察者在枚举期间释放另一个观察者 | 同上 |

> **`std::mutex` + 跨回调持锁是常见反模式**，
> 但此处因为零观察者而**不可达**。
>
> **这正是「无法用运行时数据验证的静态风险」** ——
> 只能靠读代码发现，运行期监控永远看不到。

---

## 8. 判据：如何区分「退役」与「缺实现」

本文最可复用的产出。

### 8.1 五步判据

```
① 该类型有子类吗？无可用子类 → 强化「退役」判断
② 该类型的方法是否全部为桩？是 → 强化
③ 该类型的头文件有 __deprecated_msg / __attribute__((deprecated)) 吗？
     有 → 明确退役
     无 → 「默默清空」，需进一步判断
④ 该类型的入口函数（主函数）有调用方吗？
     无 → 整层死
⑤ 依赖它的代码路径是否已被新机制取代？
```

### 8.2 三个案例的判据结果

| 类型 | ① 子类 | ② 全桩 | ③ 显式标注 | ④ 主函数零调用 | ⑤ 被取代 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `RCTUIManager` | 无 | **是（21/21）** | ❌ 无 | `addUIBlock:` 等 0 调用 | ✅ Fabric | **退役** |
| `RCTShadowView` | 1 个（也全空） | **是（18/18）** | ❌ 无 | ✅ | ✅ Fabric | **退役** |
| `RCTSurfaceRootShadowView` | — | **是（2/2）** | ✅ **有** `__deprecated_msg` | ✅ | ✅ Fabric | **退役（明确标注）** |
| `RCTLayoutContext` | — | — | ❌ 无 | ✅ 从未构造 | ✅ | **退役** |
| `RCTUIManagerObserverCoordinator` | — | ❌ 5 个有实现 | ❌ 无 | ✅ 零观察者 | ✅ Fabric 观察者 | **退役** |

### 8.3 与 25 文档的 `RCTModuleData` 对照

| | `RCTModuleData`（[25 文档 §2](./25-iOS桥接核心与启动性能标签.md)） | 本文四个类型 |
| --- | --- | --- |
| 空实现比例 | 3/3 方法空 | `RCTUIManager` 21/21、`RCTShadowView` 18/18、`RCTSurfaceRootShadowView` 2/2 |
| ivar | 0 个 | `RCTShadowView` 0 个（61 个自动合成 ivar） |
| 显式标注 | 无 | 仅 `RCTSurfaceRootShadowView` 有 |
| 文件规模 | 43 行 | 300 / 105 / 19 行 |

> **共同点**：全部**没有** `__attribute__((deprecated))`（除一处），
> 全部**保留完整头文件**。
>
> **这使得「接口存在但无行为」成为默认状态** ——
> 静态分析工具不会报警（声明与定义都在），
> 编译器不会警告（签名匹配），只有运行时才知道「什么都不发生」。

---

## 9. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| BB-1 | **`RCTUIManager` 21 个方法全是桩，但 JS 侧能取到该模块** | `Modules/RCTUIManager.mm:131-214` | `UIManager.*` 调用**静默无效**（不崩不警告）；legacy 布局不发生 |
| BB-2 | **`RCTShadowView` 63 个属性只有 2 个 `@synthesize`**，36 个 Yoga 属性全是无行为的存储 | `Views/RCTShadowView.m:20-21` + `.h` | `self.yogaNode` 恒为未赋值指针 |
| BB-3 | **`RCTShadowView+Layout.m` 的 Yoga 读取路径若被调用会解空指针**（`resolveRef` 无判空） | `Views/RCTShadowView+Layout.m:20,29` + `yoga/node/Node.h:364` | 当前零调用方，**不可达** |
| BB-4 | **`compoundInsets` 算法重复实现两处**（`RCTShadowView+Layout.m` 死 / `RCTLayout.m` 活） | `Views/RCTLayout.m:34-37` | 重构只改活的那份，死的那份静默腐化 |
| BB-5 | **三个平台的 rootViewTag 生成器序列相同、计数器独立** | `RCTUIManagerUtils.m:98`、`ReactRootViewTagGenerator.kt:12`、`ReactRootViewTagGenerator.cpp:16` | iOS 内部靠「ObjC 侧零调用」避免撞号；**无机制保证**。若有人接回 ObjC 版即产生重复 tag |
| BB-6 | **iOS 与 Android 的注释逐字相同，且都指向一个没有该说明的头文件** | `RCTUIManagerUtils.m:100`、`ReactRootViewTagGenerator.kt:13` | 真正的说明在 `ReactRootViewTagGenerator.cpp:17`；**错误逐字复制到两个平台** |
| BB-7 | **`RCTLayoutContext.other` 字段名即「无人填充」的信号** | `Views/RCTLayout.h:36` | 无 |
| BB-8 | **`RCTUIManagerObserverCoordinator` 五个通知方法跨回调持 `std::mutex`** | `Modules/RCTUIManagerObserverCoordinator.mm:42-100` | 重入死锁风险；当前零观察者**不可达** |
| BB-9 | `pseudoUIManagerQueueFlag` 是非原子 `static BOOL`，靠「所有访问都在主线程」的约定保证安全 | `RCTUIManagerUtils.m:16,83,87` | 同仓库内 `RCTAllocateRootViewTag` 用 `_Atomic`（§5.5），风格不一致 |
| BB-10 | `RCTAllocateRootViewTag` 零调用方（Android 的 Kotlin 版有 3 个生产调用方） | `RCTUIManagerUtils.m:98` | 死代码；**「死 + 与活实现相同」比「没有」更危险** |
| BB-11 | `RCTDisplayType` 只声明 3 个值，但反向映射 `RCTReactDisplayTypeFromYogaDisplayType` 处理 5 个 `YGDisplay` | `Views/RCTLayout.h:17-21` + `RCTLayout.m:127-139` | `YGDisplayContents`/`Grid` 都被压成 `Flex`，**丢失信息**（往返不对称） |

### BB-11 的往返不对称

| 方向 | 输入 → 输出 |
| --- | --- |
| React → Yoga（`:114-125`） | `None`→`None`、`Flex`→`Flex`、`Inline`→**断言失败**+`None` |
| Yoga → React（`:127-139`） | `None`→`None`、`Flex`→`Flex`、**`Contents`→`Flex`**、**`Grid`→`Flex`**、其他→`Flex` |

**即 Yoga 的 `contents` / `grid` 在 legacy 侧不可表达** ——
往返一次后语义丢失。

> **但 `RCTLayoutMetricsFromYogaNode` 零调用方，所以这条不对称今天不会生效。**

---

## 10. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- | --- |
| 25 文档：`RCTModuleData` 空壳、`RCTBridge` 空实现 | **扩充到 4 个类型、43 个方法**，并给出「退役 vs 缺实现」的五步判据（§8） |
| 25 文档：interop 层「copy-pasta from RCTModuleData」 | 补上 legacy 布局层的整体状态（§2、§3） |
| 26 文档 I-4：注释声称有但代码没有 | **新增变体**（BB-6）：注释指错文件，且错误逐字复制到 iOS 与 Android 两处 |
| 29 文档：`RCTDeviceInfo.invalidate` 用 `std::atomic` 做原子幂等 | **补上第二处原子正样本**（§5.5）与一处非原子反例（BB-9）；并给出**同一逻辑三平台三写法**的横向对照 |
| 27 文档：`RCTTiming` ↔ `JSTimers.js` 帧常量双向同步声明 | **正反对照**（§5.6）：27 是「同步做对了」，本文 rootViewTag 是「三份独立、同步注释指错文件」 |
| 32/33/35 文档：回收契约的三类处置 | **补充**：本文的四个类型都属「整层退役」这一更大的类 |
| 05 文档：内存/性能监控 | **补上死代码的成本面**：`RCTShadowView` 61 个自动合成 ivar 每实例分配但不承载状态 |
