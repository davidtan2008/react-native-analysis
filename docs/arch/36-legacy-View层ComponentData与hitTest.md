---
id: 36
title: "legacy 架构的 View 层：ComponentData 的 prop 装配与 RCTView 的 hitTest"
topic: RN.legacy
symptoms: [gesture]
platforms: [ios]
architecture: [legacy]
layer: T1
symbols: ["RCTComponentData", "RCTHitTest"]
sourceRoot: react-native
claims: [AA-1, AA-2, AA-3, AA-4]
---
# 36 · legacy 架构的 View 层：ComponentData 的 prop 装配与 RCTView 的 hitTest

> **模块**：C1 · `React/Views/` 的核心族（15 文件 / 4682 行）
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · legacy 架构（Paper）
> **前置**：[25 文档](./25-iOS桥接核心与启动性能标签.md) 记录了 `React/Base/RCTModuleData`
> 被清空为无 ivar 的空壳；[31 文档](./31-Fabric组件层View与回收池.md) 记录了 Fabric 侧的 View。
>
> 本文说明 **legacy 侧那个「真身」`React/Views/RCTComponentData.mm`** ——
> 它是 25 文档里空壳的**对照与来源**：interop 层那句
> `// This is copy-pasta from RCTComponentData.`（[25 文档 §3](./25-iOS桥接核心与启动性能标签.md)）
> 指的就是本文 §2 的逻辑。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `Views/RCTView.m` | 1038 | **View 组件（legacy 侧）** |
| `Views/RCTViewManager.m` | 748 | View 管理器基类 |
| `Views/RCTBorderDrawing.m` | 594 | 边框绘制 |
| `Views/RCTComponentData.mm` | 563 | **prop → setter 的装配器** |
| `Views/RCTFont.mm` | 533 | 字体解析 |
| `Views/UIView+React.m` | 492 | View 分类方法 |
| `Views/RCTConvert+Transform.m` | 154 | Transform 转换 |
| `Views/RCTLayout.m` | 139 | 布局辅助 |
| `Views/RCTDebuggingOverlay.m` | 121 | 调试覆盖层实现 |
| `Views/RCTShadowView.m` | 105 | Shadow 侧 View |
| `Views/RCTShadowView+Layout.m` | 69 | Shadow 布局 |
| `Views/RCTWrapperViewController.m` | 82 | 包装 VC |
| 其余 | 约 210 | `RCTViewUtils.m` / `RCTConvert+CoreLocation.m` 等 |

---

## 2. `RCTComponentData`：prop 装配器

### 2.1 它的地位：与 25 文档的空壳形成对照

| | `React/Base/RCTModuleData.mm`（[25 文档 §2](./25-iOS桥接核心与启动性能标签.md)） | `React/Views/RCTComponentData.mm` |
| --- | --- | --- |
| 用途 | Native Module 的元数据 | **View 的 prop → setter** |
| 行数 | 43（3 个空方法） | 563（完整实现） |
| 状态 | **空壳**，零 ivar | **真身** |

**interop 层的注释**（`RCTLegacyViewManagerInteropCoordinator.mm:194`）
说的 `// This is copy-pasta from RCTModuleData.` 里的「RCTModuleData」，
其逻辑来源就是本文这个 `RCTComponentData` 的 `_lookupModuleMethodsIfNecessary` 同型实现。

### 2.2 三种 prop 处理路径

`createPropBlock:`（`:221-345`）分三条路：

```
① ViewManager 无 propConfig*_ 方法          → 返回空 block（无操作）
② keyPath == "__custom__"                  → createEventSetter 或自定义 setter
③ 其他                                     → RCT_CASE 宏或 NSInvocation
```

**①（`:228-235`）**：

```objc
// packages/react-native/React/Views/RCTComponentData.mm:228-232
  if ([_managerClass respondsToSelector:selector]) {
    NSArray<NSString *> *typeAndKeyPath = ((NSArray<NSString *> * (*)(id, SEL)) objc_msgSend)(_managerClass, selector);
    type = selectorForType(typeAndKeyPath[0]);
    keyPath = typeAndKeyPath.count > 1 ? typeAndKeyPath[1] : nil;
  } else {
    return ^(__unused id view, __unused id json) {
    };
  }
```

**通过 `objc_msgSend` 调 ViewManager 的 `propConfig*` 类方法**
（`objc_msgSend` 直接调用绕过 ARC 类型检查，见 23 文档 §3.4 的同类讨论）。

### 2.3 事件 prop 走独立路径

`:271-276`：

```objc
    if (type == NSSelectorFromString(@"RCTBubblingEventBlock:") ||
        type == NSSelectorFromString(@"RCTDirectEventBlock:") ||
        type == NSSelectorFromString(@"RCTCapturingEventBlock:")) {
      // Special case for event handlers
      setterBlock = createEventSetter(
          name, setter, self.eventInterceptor, [self isBridgeMode] ? _bridge.eventDispatcher : _eventDispatcher);
```

**三种事件 block 类型**：`Bubbling` / `Direct` / `Capturing`。
且按 `isBridgeMode` 二选一 dispatcher —— 承接
[24 文档 §3](./24-iOS事件分发触摸管线与JS加载.md)（legacy 事件链已断开）。

`createEventSetter`（`:121-152`）内含**弱引用与存在性检查**：

```objc
      eventHandler = ^(NSDictionary *event) {
        // The component no longer exists, we shouldn't send the event
        id<RCTComponent> strongTarget = weakTarget;
        if (strongTarget == nullptr) {
          return;
        }
```

**注释说明了原因**：组件可能已被卸载，不能再发事件。

### 2.4 `RCT_CASE` 宏：17 个标量类型 + 1 个兜底

`:286-332` 用宏把标量类型的 setter 展开：

```objc
#define RCT_CASE(_value, _type)                                       \
  case _value: {                                                      \
    __block BOOL setDefaultValue = NO;                                \
    __block _type defaultValue;                                       \
    _type (*convert)(id, SEL, id) = (__typeof__(convert))objc_msgSend;  \
    _type (*get)(id, SEL) = (__typeof__(get))objc_msgSend;              \
    void (*set)(id, SEL, _type) = (__typeof__(set))objc_msgSend;        \
    setterBlock = ^(id target, id json) {                             \
      if (json) {                                                     \
        if (!setDefaultValue && target) {                             \
          if ([target respondsToSelector:getter]) {                   \
            defaultValue = get(target, getter);                       \
          }                                                           \
          setDefaultValue = YES;                                      \
        }                                                             \
        set(target, setter, convert([RCTConvert class], type, json)); \
      } else if (setDefaultValue) {                                   \
        set(target, setter, defaultValue);                            \
      }                                                               \
    };                                                                \
    break;                                                            \
  }
```

**17 个展开的类型**（`:309-325`）：`SEL`、`char*`、`char`、`unsigned char`、
`short`、`unsigned short`、`int`、`unsigned int`、`long`、`unsigned long`、
`long long`、`unsigned long long`、`float`、`double`、`BOOL`、`void*`、`id`。

**兜底**（`:327-331`）：

```objc
        case _C_STRUCT_B:
        default: {
          setterBlock = createNSInvocationSetter(typeSignature, type, getter, setter);
          break;
        }
```

**即：结构体类型走 `NSInvocation` 慢路径**（§2.5）。

**defaultValue 的捕获时机**（`:295-300`）：**只在第一次非 null 值到来时读一次 getter**，
之后缓存。**`json == nil` 时不读**（`:302-303`）。

### 2.5 `NSInvocation` 慢路径：注释质量极高

`createNSInvocationSetter`（`:153-219`）有**三段关键注释**。

**① 为什么第一次是 null 就 no-op**（`:170-174`）：

```objc
        if (json == nullptr) {
          // We only set the defaultValue when we first pass a non-null
          // value, so if the first value sent for a prop is null, it's
          // a no-op (we'd be resetting it to its default when its
          // value is already the default).
          return;
        }
```

**② 为什么用 `NSMutableData` 而非 `malloc`**（`:176-177`）：

```objc
      // Use NSMutableData to store defaultValue instead of malloc, so
      // it will be freed automatically when setterBlock is released.
      defaultValue = [[NSMutableData alloc] initWithLength:typeSignature.methodReturnLength];
```

**③ malloc 失败的处理 + CWE 引用**（`:194-199`）：

```objc
      if (value == nullptr) {
        // CWE - 391 : Unchecked error condition
        // https://www.cvedetails.com/cwe-details/391/Unchecked-Error-Condition.html
        // https://eli.thegreenplace.net/2009/10/30/handling-out-of-memory-conditions-in-c
        abort();
      }
```

**④ 双重所有权标记**（`:211-217`）：

```objc
    if (freeValueOnCompletion) {
      // Only free the value if we `malloc`d it locally, otherwise it
      // points to `defaultValue.mutableBytes`, which is managed by ARC.
      free(value);
    }
```

**即 `value` 有两个来源**：`:190` 的 `defaultValue.mutableBytes`（ARC 管）
与 `:193` 的 `malloc`（手动管），靠 `freeValueOnCompletion` 区分。

> **这四段注释是全仓库注释质量的上限** ——
> 每段都回答了「为什么这么写」并给出外部参考链接。
> 与 [26 文档 I-4](./26-iOS-Base余部网络图像与快捷键.md)（注释说有代码没有）形成极端对照。

---

## 3. `RCTView.hitTest:`：绕过 UIKit 的严格包含策略

### 3.1 四种 `pointerEvents`

`RCTView.m:215-227`：

```objc
  switch (_pointerEvents) {
    case RCTPointerEventsNone:
      return nil;
    case RCTPointerEventsUnspecified:
      return hitSubview ?: hitView;
    case RCTPointerEventsBoxOnly:
      return hitView;
    case RCTPointerEventsBoxNone:
      return hitSubview;
    default:
      RCTLogInfo(@"Invalid pointer-events specified %lld on %@", (long long)_pointerEvents, self);
      return hitSubview ?: hitView;
  }
```

**四种语义**：

| 值 | 返回 |
| --- | --- |
| `None` | `nil`（自己不接收，子视图也不测） |
| `Unspecified` | 子视图优先，没有则自己 |
| `BoxOnly` | **只有自己**（不看子视图） |
| `BoxNone` | **只有子视图**（自己不接收） |

**`default` 分支记日志并按 `Unspecified` 处理** —— 与
[23 文档 §5.3](./23-iOS基础工具层ConvertAssertLogUtils.md) 的
`_RCTLogNativeInternal` 日志路径一致（Release 下仍输出）。

### 3.2 绕过 UIKit 包含策略的理由

`:189-203` 的注释是本文最有价值的部分之一：

```objc
  // `hitSubview` is the topmost subview which was hit. The hit point can
  // be outside the bounds of `view` (e.g., if -clipsToBounds is NO).
  UIView *hitSubview = nil;
  BOOL isPointInside = [self pointInside:point withEvent:event];
  BOOL needsHitSubview = !(_pointerEvents == RCTPointerEventsNone || _pointerEvents == RCTPointerEventsBoxOnly);
  if (needsHitSubview && (![self clipsToBounds] || isPointInside)) {
    // Take z-index into account when calculating the touch target.
    NSArray<UIView *> *sortedSubviews = [self reactZIndexSortedSubviews];

    // The default behaviour of UIKit is that if a view does not contain a point,
    // then no subviews will be returned from hit testing, even if they contain
    // the hit point. By doing hit testing directly on the subviews, we bypass
    // the strict containment policy (i.e., UIKit guarantees that every ancestor
    // of the hit view will return YES from -pointInside:withEvent:). See:
    //  - https://developer.apple.com/library/ios/qa/qa2013/qa1812.html
```

**并给出了 Apple 官方 QA 链接**（qa1812）。

**RN 需要的语义**：视图可以超出父视图边界接收触摸
（`clipsToBounds == NO` 时），而 UIKit 的默认实现不允许。

**实现方式**：不调 `[self hitTest:]` 找子视图，而是
**逐个调 `[subview hitTest:convertedPoint withEvent:event]`**（`:204-210`），
从 z-index 最高的开始反向遍历。

### 3.3 `reactZIndexSortedSubviews` 的短路优化

`UIView+React.m:150-170`：

```objc
- (NSArray<UIView *> *)reactZIndexSortedSubviews
{
  // Check if sorting is required - in most cases it won't be.
  BOOL sortingRequired = NO;
  for (UIView *subview in self.subviews) {
    if (subview.reactZIndex != 0) {
      sortingRequired = YES;
      break;
    }
  }
  return sortingRequired ? [self.reactSubviews sortedArrayUsingComparator:^NSComparisonResult(UIView *a, UIView *b) {
```

**两层短路**：

| 层 | 条件 | 收益 |
| --- | --- | --- |
| ① 扫描 `subviews` 判 `reactZIndex != 0` | 全为 0 | **直接返回 `self.subviews`，零分配** |
| ② 有非 0 时才排序 | — | 排序 |

**注释明说「in most cases it won't be」** ——
即绝大多数 View 没有 z-index，不必排序。

**`:163-166` 还处理了排序稳定性**：

```objc
    } else {
      // Ensure sorting is stable by treating equal zIndex as ascending so
      // that original order is preserved.
      return NSOrderedAscending;
    }
```

**注意这里有语义问题**：`NSOrderedAscending` 表示「a < b」，
但当 `a.reactZIndex == b.reactZIndex` 时返回 ascending，
这确实是「视为相等、保持原序」的写法 ——
但 `sortedArrayUsingComparator:` 期望返回 `NSOrderedSame` 表示相等。
**返回 `Ascending` 而非 `Same` 会导致比较器不自洽**（不满足传递性的严格弱序要求）。

> **实际影响有限**（`NSMutableArray` 的排序在比较器不自洽时行为未定义但通常不崩），
> 但正确写法应是 `NSOrderedSame`。
>
> **注释本身也承认了意图是「保持稳定」** ——
> 说明作者知道要稳定，但选了 `Ascending` 而非 `Same`。

### 3.4 `pointInside:` 的 inset 扩展

`:230-237`：

```objc
- (BOOL)pointInside:(CGPoint)point withEvent:(UIEvent *)event
{
  if (UIEdgeInsetsEqualToEdgeInsets(self.hitTestEdgeInsets, UIEdgeInsetsZero)) {
    return [super pointInside:point withEvent:event];
  }
  CGRect hitFrame = UIEdgeInsetsInsetRect(self.bounds, self.hitTestEdgeInsets);
  return CGRectContainsPoint(hitFrame, point);
}
```

**零 inset 时直接走 `super`**（快路径，无额外计算）。
`_hitTestEdgeInsets` 在 `:146` 初始化为 `UIEdgeInsetsZero`。

---

## 4. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| AA-1 | **排序比较器返回 `NSOrderedAscending` 而非 `NSOrderedSame`** | `Views/UIView+React.m:165` | 比较器不自洽（不满足严格弱序）；实际通常不崩但行为未定义 |
| AA-2 | `hitTest:` 每次调用都遍历全部子视图（无早退优化） | `Views/RCTView.m:204-210` | 深嵌套 + 高频触摸时的 CPU 开销；`zIndex` 排序虽有短路但遍历本身是 O(n) |
| AA-3 | `createPropBlock:` 的 `[key substringToIndex:1]` 对空 `key` 会抛异常 | `Views/RCTComponentData.mm:267` | **理论缺陷**：`key` 来自 `keyPath.lastObject` 或 `name`，均为 ViewManager 的 prop 名，不为空 |
| AA-4 | legacy 事件链已断开但 `createEventSetter` 仍在装配 dispatcher | `Views/RCTComponentData.mm:275-276` | 承接 24 文档 §3；装配本身无误，只是目标端已空 |

### AA-3 的核实

`:255-259`：

```objc
    NSString *key = name;
    NSArray<NSString *> *parts = [keyPath componentsSeparatedByString:@"."];
    if (parts != nullptr) {
      key = parts.lastObject;
```

**`componentsSeparatedByString:` 永不返回 nil**（空串时返回含一个空串的数组），
所以 `if (parts != nullptr)` **恒为真**，`key` 必被赋为 `parts.lastObject`。

若 `keyPath == @""`，则 `parts = [@""]`，`key = @""`，
`[@"" substringToIndex:1]` 抛 `NSRangeException`。

**但 `keyPath` 来自 ViewManager 的 `propConfig*` 返回值**，不会是空串。

**且 `:256` 的 `!= nullptr` 判断本身是多余的** ——
`componentsSeparatedByString:` 的返回类型是 `NSArray *`（非 nullable），
编译器不会警告，但这个判断暗示作者认为它可能为 nil。

---

## 5. 「注释质量」的三个档次

本轮读到的注释，按「是否回答了为什么」分三档：

### 5.1 第一档：给出理由 + 外部参考（本章最佳）

| 位置 | 内容 |
| --- | --- |
| `RCTView.m:198-203` | 解释绕过 UIKit 包含策略的理由 + **Apple QA 链接** |
| `RCTComponentData.mm:194-199` | malloc 失败的处置 + **CWE 编号 + 两篇参考文章** |
| `RCTComponentData.mm:176-177` | 解释为何用 `NSMutableData` 而非 `malloc` |
| `RCTComponentData.mm:170-174` | 解释「首次为 null 则 no-op」的语义 |

### 5.2 第二档：陈述现象但不给理由

| 位置 | 内容 |
| --- | --- |
| `UIView+React.m:152` | 「in most cases it won't be」—— 给了理由但无数据支撑 |
| `UIView+React.m:163-166` | 说明要稳定排序，但**没说清为什么用 Ascending 而非 Same** |

### 5.3 反例：注释与代码不符

见 [24 文档 I-4](./24-iOS事件分发触摸管线与JS加载.md)（`RCTKeyCommands` 的 escape 例外）
与 [26 文档 I-1](./26-iOS-Base余部网络图像与快捷键.md)（运算符优先级）。

> **为什么这个分类有意义**：
> 读者遇到可疑代码时，**第一档注释能直接解答**，
> **第二档需要自己推断**，
> **第三档会误导**。
>
> 这也是本批文档坚持记录「注释说了什么」而非「代码做了什么」的原因 ——
> **注释是意图的载体，代码是实现的载体，两者不一致时两者都要记录。**

---

## 6. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 25 文档：`RCTModuleData` 是空壳 | **补上对照**：真身在 `React/Views/RCTComponentData.mm`（§2） |
| 25 文档：interop 层「copy-pasta from RCTModuleData」 | **指出其来源**是本文 §2 的 prop 装配逻辑 |
| 24 文档：legacy 事件链断开 | **补上装配端**：`createEventSetter` 仍在装配 dispatcher（AA-4） |
| 23 文档：`objc_msgSend` 绕过 ARC | **新增实例**：`RCT_CASE` 宏与 `propConfig` 调用（§2.4） |
| 23 文档 §5.3：日志在 Release 下仍输出 | **新增实例**：`pointerEvents` 非法值的 `RCTLogInfo`（§3.1） |
| 26 文档 I-1：注释与代码不符 | **补上注释质量的三个档次**（§5），指出本章多为第一档 |