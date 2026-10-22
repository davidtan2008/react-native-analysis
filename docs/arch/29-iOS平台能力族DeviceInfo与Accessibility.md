---
id: 29
title: "iOS 平台能力族：DeviceInfo / Accessibility / Appearance 的生命周期严谨性"
topic: PL.ios
symptoms: [a11y]
platforms: [ios]
architecture: [cross]
layer: T3
symbols: ["RCTDeviceInfo", "RCTAccessibilityManager"]
claims: []
---
# 29 · iOS 平台能力族：DeviceInfo / Accessibility / Appearance 的生命周期严谨性

> **模块**：C1 · `CoreModules/` 的平台能力族（13 文件 / 2364 行）
> **基线**：react-native @ `9b131e42` · iOS 侧
> **前置**：[23 文档 §6.3](./23-iOS基础工具层ConvertAssertLogUtils.md) 记录了
> `RCTKeyWindow()` 返回 nil 会导致「RN UI 根本不渲染」；
> [28 文档](./28-iOS-Dev工具链与四层门控.md) 记录了 Dev 工具链的四层门控。
>
> 本文记录平台能力层的**生命周期严谨性差异**：
> `RCTDeviceInfo` 的 KVO 幂等清理（正面）、
> `RCTAccessibilityManager` 的 9 处无清理观察者、
> 以及**一处 `RCTKeyWindow()` 为 nil 导致的静默功能失效**（负面）。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `CoreModules/RCTAccessibilityManager.mm` | 457 | 字体缩放 / 辅助功能状态 |
| `CoreModules/RCTDeviceInfo.mm` | 343 | 设备信息、窗口尺寸、方向 |
| `CoreModules/RCTActionSheetManager.mm` | 342 | ActionSheet |
| `CoreModules/RCTAlertManager.mm` | 210 | Alert |
| `CoreModules/RCTStatusBarManager.mm` | 199 | 状态栏 |
| `CoreModules/RCTAppearance.mm` | 165 | 深浅色模式 |
| `CoreModules/RCTAppState.mm` | 154 | 前后台状态 |
| `CoreModules/RCTKeyboardObserver.mm` | 148 | 键盘事件 |
| `CoreModules/RCTPlatform.mm` | 107 | 平台常量 |
| `CoreModules/RCTI18nManager.mm` | 67 | 国际化 |
| `CoreModules/RCTAlertController.mm` | 63 | Alert 的独立窗口容器 |
| `CoreModules/RCTClipboard.mm` | 57 | 剪贴板 |
| `CoreModules/RCTSourceCode.mm` | 52 | 源码映射 |

---

## 2. `RCTDeviceInfo`：KVO 的幂等清理（正面样本）

### 2.1 观察者注册

`RCTDeviceInfo.mm:46-53`：

```objc
- (instancetype)init
{
  if (self = [super init]) {
    _applicationWindow = RCTKeyWindow();
    [_applicationWindow addObserver:self forKeyPath:kFrameKeyPath options:NSKeyValueObservingOptionNew context:nil];
  }
  return self;
}
```

`:40` 定义了 keyPath：

```objc
static NSString *const kFrameKeyPath = @"frame";
```

**注意 `:36` 的 ivar 是 `__weak UIWindow *`** —— 窗口销毁后自动置 nil。

### 2.2 `invalidate` 的幂等保护

`RCTDeviceInfo.mm:145-151`：

```objc
- (void)invalidate
{
  if (_invalidated.exchange(YES)) {
    return;
  }
  [self _cleanupObservers];
}
```

**`_invalidated` 是 `std::atomic<BOOL>`（`:33`），
用 `exchange(YES)` 做原子 test-and-set** —— 若已失效直接返回。

这是全仓库**最严谨的失效模式**：

| 特征 | 说明 |
| --- | --- |
| 原子性 | `std::atomic<BOOL>` + `exchange`（compare-and-swap 语义） |
| 幂等 | 第二次调用直接 return |
| 显式清理 | 调 `_cleanupObservers` |

### 2.3 清理覆盖 5 类注册

`RCTDeviceInfo.mm:153-169`：

```objc
- (void)_cleanupObservers
{
  [[NSNotificationCenter defaultCenter] removeObserver:self
                                                  name:RCTAccessibilityManagerDidUpdateMultiplierNotification
                                                object:[_moduleRegistry moduleForName:"AccessibilityManager"]];

  [[NSNotificationCenter defaultCenter] removeObserver:self name:UIApplicationDidBecomeActiveNotification object:nil];
```

以及 `:165` 的 KVO 清理：

```objc
  [_applicationWindow removeObserver:self forKeyPath:kFrameKeyPath];
```

**逐条对照注册处**（`init` 1 处 KVO + `initialize` 6 处通知 = 7 处），
`_cleanupObservers` 覆盖了全部 6 处清理调用（KVO 1 + 通知 5，其中
`UIApplicationDidBecomeActiveNotification` 注册 2 次但清理 1 次即可全覆盖）。
**这是正确写法的样板。**

### 2.4 一个已知的技术债注释

`RCTDeviceInfo.mm:119-127`：

```objc
  // TODO T175901725 - Registering the RCTDeviceInfo module to the notification is a short-term fix to unblock 0.73
  // The actual behavior should be that the module is properly registered in the TurboModule/Bridge infrastructure
  // and the infrastructure imperatively invoke the `invalidate` method, rather than listening to a notification.
  // This is a temporary workaround until we can investigate the issue better as there might be other modules in a
  // similar situation.
  [[NSNotificationCenter defaultCenter] addObserver:self
                                           selector:@selector(invalidate)
                                               name:RCTBridgeWillInvalidateModulesNotification
                                             object:nil];
```

**用「监听失效通知」代替「基础设施主动调 `invalidate`」** ——
注释把原因、正确做法、当前状态都写清楚了，并明确说这是**临时方案**。

> **这是文档注释的正面样本**：
> 对比 [26 文档 I-4](./26-iOS-Base余部网络图像与快捷键.md)
> 「注释声称 escape 例外但代码没有」——
> 这里的注释与代码**完全一致**，且标注了 TODO 编号。

---

## 3. 【实质缺陷】KVO 注册在 `RCTKeyWindow()` 为 nil 时静默失败

这是本文最重要的发现，直接承接 [23 文档 §6.3](./23-iOS基础工具层ConvertAssertLogUtils.md) 的
「`RCTKeyWindow()` 返回 nil」问题。

### 3.1 问题链

```objc
// packages/react-native/React/CoreModules/RCTDeviceInfo.mm:48-50
  if (self = [super init]) {
    _applicationWindow = RCTKeyWindow();
    [_applicationWindow addObserver:self forKeyPath:kFrameKeyPath options:NSKeyValueObservingOptionNew context:nil];
```

| 步骤 | 条件 | 结果 |
| --- | --- | --- |
| ① `_applicationWindow = RCTKeyWindow()` | 启动早期 keyWindow 尚未创建 | **得到 `nil`** |
| ② `[_applicationWindow addObserver:...]` | 向 `nil` 发消息 | **no-op，不报错** |
| ③ 之后 window 被创建 | `_applicationWindow` 是 `__weak` | **仍是 `nil`，永不重试** |

**即：KVO 永久失效。**

### 3.2 失效后的具体后果

KVO 的作用是监听 `window.frame` 变化（`:63-72`）：

```objc
- (void)observeValueForKeyPath:(NSString *)keyPath
                      ofObject:(id)object
                        change:(NSDictionary *)change
                       context:(void *)context
{
  if ([keyPath isEqualToString:kFrameKeyPath]) {
    [self interfaceFrameDidChange];
    [[NSNotificationCenter defaultCenter] postNotificationName:RCTWindowFrameDidChangeNotification object:self];
  }
}
```

KVO 失效后，`interfaceFrameDidChange` 少一个触发源。

### 3.3 但影响有限：还有 3 个通知兜底

`RCTDeviceInfo.mm:93-117` 在 `initialize` 里注册了 3 个通知，
**都指向同一个 `interfaceFrameDidChange`**：

| 通知 | 位置 | 指向选择器 |
| --- | --- | --- |
| `UIApplicationDidBecomeActiveNotification` | `:95` | `interfaceOrientationDidChange` |
| `UIApplicationDidBecomeActiveNotification` | `:105` | `interfaceFrameDidChange` |
| `RCTUserInterfaceStyleDidChangeNotification` | `:100` | `interfaceFrameDidChange` |
| `UIDeviceOrientationDidChangeNotification` | `:115` | `interfaceFrameDidChange` |

**`:95` 与 `:105` 是同一通知名的两次注册**，分别指向不同选择器 ——
`interfaceFrameDidChange` 因此拿到**两个**触发源。
清理时只需一次 `removeObserver:name:object:nil` 即可全部移除。

**所以 frame 变化仍能通过「App 重新活跃」和「设备方向变化」两条路被捕获。**

> **准确的结论表述**：
> KVO 失效**不导致 Dimensions 永不更新**，但会导致一个具体缺口：
>
> **「窗口尺寸变了，但 App 一直处于前台、且设备物理方向没变」** ——
> 典型场景是 **iPad 分屏拖拽调整大小**（Split View 拖动分隔条）。
> 此时既没有 `DidBecomeActive`（一直在前台），也没有 `UIDeviceOrientationDidChange`（设备没转），
> **只有 KVO 能捕获，而 KVO 已经失效**。

### 3.4 另一条路径也不可靠

`:264` 与 `:296` 是另外两处 `didUpdateDimensions` 发送点，
前者来自 `didReceiveNewContentSizeMultiplier`（辅助功能变化），
后者来自 `interfaceOrientationDidChange`（旋转）。

**都不覆盖分屏拖拽。**

---

## 4. `RCTAccessibilityManager`：9 处观察者零清理

### 4.1 注册集中在 `init`

`RCTAccessibilityManager.mm:48-109` 在 `init` 里连续注册 9 个通知：

```objc
- (instancetype)init
{
  if (self = [super init]) {
    _multiplier = 1.0;

    // TODO: can this be moved out of the startup path?
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(didReceiveNewContentSizeCategory:)
                                                 name:UIContentSizeCategoryDidChangeNotification
                                               object:nil];
```

| 序号 | 通知 | 选择器 | 行号 |
| --- | --- | --- | --- |
| 1 | `UIContentSizeCategoryDidChangeNotification` | `didReceiveNewContentSizeCategory:` | `:54` |
| 2 | `UIAccessibilityAnnouncementDidFinishNotification` | `accessibilityAnnouncementDidFinish:` | `:59` |
| 3 | `UIAccessibilityBoldTextStatusDidChangeNotification` | `boldTextStatusDidChange:` | `:64` |
| 4 | `UIAccessibilityGrayscaleStatusDidChangeNotification` | `grayscaleStatusDidChange:` | `:69` |
| 5 | `UIAccessibilityInvertColorsStatusDidChangeNotification` | `invertColorsStatusDidChange:` | `:74` |
| 6 | `UIAccessibilityReduceMotionStatusDidChangeNotification` | `reduceMotionStatusDidChange:` | `:79` |
| 7 | `UIAccessibilityDarkerSystemColorsStatusDidChangeNotification` | `darkerSystemColorsDidChange:` | `:84` |
| 8 | `UIAccessibilityReduceTransparencyStatusDidChangeNotification` | `reduceTransparencyStatusDidChange:` | `:89` |
| 9 | `VoiceOverStatusDidChangeNotification` | `voiceVoiceOverStatusDidChange:` | `:94` |

### 4.2 零清理

```bash
$ grep -c "removeObserver" packages/react-native/React/CoreModules/RCTAccessibilityManager.mm
0
```

**既无 `removeObserver`、也无 `invalidate`、也无 `dealloc`。**

### 4.3 与 RCTDeviceInfo 的对比（同族内反差）

| 模块 | `addObserver` | `removeObserver` | `invalidate` | `atomic` 幂等 |
| --- | --- | --- | --- | --- |
| `RCTDeviceInfo` | 6（1 KVO + 5 通知） | **5，全部覆盖** | ✅ | ✅ `std::atomic` |
| `RCTAccessibilityManager` | **9** | **0** | ❌ 无 | — |

**同一个目录下的两个模块，生命周期管理质量差异巨大。**

### 4.4 为什么不构成实际泄漏

`NSNotificationCenter` 从 **iOS 9** 起采用**零指针弱引用**：
观察者释放时其注册条目自动失效。

**所以只要 `RCTAccessibilityManager` 实例被释放，9 个注册条目即消失。**

> **必须写清的适用范围**：
> 这**不是** [05 文档](./05-监控检测原理与流程.md) 记录的
> 「`RCTFabricSurface` 观察者未移除」那类问题 ——
> 后者是**通知中心持有观察者的强引用导致实例无法释放**，属真泄漏；
> 本例因为模块实例本身会被释放（无循环引用），所以注册条目随之消失。
>
> **但它确实有一个隐性成本**：
> 若宿主为某种原因持有 `RCTAccessibilityManager`（如注册成 DevSettings 的依赖），
> 9 个注册条目会一直存在，每个通知到达都要走一次分发。
>
> **`RCTAccessibilityManager` 自己有 `_moduleRegistry` 弱引用**（`:33` 的 `@synthesize`）
> 指向的属性声明是 `weak`（[25 文档 §4](./25-iOS桥接核心与启动性能标签.md) 引用的
> `RCTBridgeModule.h:137`），**不构成循环引用**。

### 4.5 一处理论缺陷

`RCTAccessibilityManager.mm:243-251`：

```objc
- (CGFloat)multiplierForContentSizeCategory:(NSString *)category
{
  NSNumber *m = self.multipliers[category];
  if (m.doubleValue <= 0.0) {
    RCTLogError(@"Can't determine multiplier for category %@. Using 1.0.", category);
    m = @1.0;
  }
  return m.doubleValue;
}
```

**`self.multipliers[category]` 对不存在的 key 返回 `nil`，
而 `nil.doubleValue` 返回 `0.0`** —— 会误报一条 `RCTLogError`。

**实际不可达**：唯一调用方是 `:238`，传入的是 `_contentSizeCategory`，
它来自系统 `UIContentSizeCategoryDidChangeNotification` 的 `userInfo`，
必然在默认表（`:264-277` 的 12 项）内。

记为**理论缺陷，非实际 bug** —— 与
[24 文档 E-9/E-10](./24-iOS事件分发触摸管线与JS加载.md)（`touchID` 越界、
`RCTNormalizeInputEventName(@"")`）同类。

---

## 5. `RCTAlertController`：对 nil 做了显式降级（正面样本）

`RCTAlertController.mm:18-36` 的懒加载：

```objc
- (UIWindow *)alertWindow
{
  if (_alertWindow == nil) {
    UIWindowScene *scene = RCTKeyWindow().windowScene;
    if (scene != nil) {
      _alertWindow = [[UIWindow alloc] initWithWindowScene:scene];
      _alertWindow.frame = scene.coordinateSpace.bounds;
    } else {
      _alertWindow = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
    }
```

**这是 [23 文档 §6.3](./23-iOS基础工具层ConvertAssertLogUtils.md) 问题的正确应对**：

| `RCTKeyWindow().windowScene` | 处理 |
| --- | --- |
| 非 nil | 用 `initWithWindowScene:`（正确绑定 scene） |
| **nil** | **降级到 `initWithFrame:` + `UIScreen.mainScreen.bounds`** |

**没有因为 `RCTKeyWindow()` 返回 nil 就崩溃或创建出无效窗口。**

> **对比 `RCTDeviceInfo.mm:49`**：同一个 `RCTKeyWindow()` 调用，
> 一个做了 nil 检查（`RCTAlertController`），
> 一个没做（`RCTDeviceInfo`），
> **结果分别是「降级可用」与「永久失效」**。
>
> 这说明 `RCTKeyWindow()` 返回 nil 不是理论风险，
> 而是**同一次代码库里两种不同处理风格的并存**。

### 5.1 `hide` 完整拆除窗口

`RCTAlertController.mm:56-63`：

```objc
- (void)hide
{
  [_alertWindow setHidden:YES];

  _alertWindow.windowScene = nil;

  _alertWindow = nil;
}
```

**`windowScene = nil` 这一步是关键** ——
它把窗口从 scene 解绑，避免残留的窗口引用阻止 scene 释放。写法完整。

### 5.2 `show` 继承样式

`:39-46`：

```objc
- (void)show:(BOOL)animated completion:(void (^)(void))completion
{
  UIUserInterfaceStyle style = self.overrideUserInterfaceStyle;
  if (style == UIUserInterfaceStyleUnspecified) {
    UIUserInterfaceStyle overriddenStyle = RCTKeyWindow().overrideUserInterfaceStyle;
    style = (overriddenStyle != 0) ? overriddenStyle : UIUserInterfaceStyleUnspecified;
  }

  self.overrideUserInterfaceStyle = style;
```

**三级回退**：自身设定 → keyWindow 的设定 → `Unspecified`。
这里 `RCTKeyWindow()` 可能返回 nil，但 `.overrideUserInterfaceStyle` 对 nil 返回 0，
且 `(overriddenStyle != 0)` 判定使其**安全降级为 `Unspecified`**。

---

## 6. `RCTAppearance`：观察者清理完整

`RCTAppearance.mm:133-145`：

```objc
- (void)appearanceChanged:(NSNotification *)notification
{
  NSDictionary *userInfo = [notification userInfo];
  UITraitCollection *traitCollection = nil;
  if (userInfo) {
    traitCollection = userInfo[RCTUserInterfaceStyleDidChangeNotificationTraitCollectionKey];
  }
  NSString *newColorScheme = RCTColorSchemePreference(traitCollection);
  if (![_currentColorScheme isEqualToString:newColorScheme]) {
    _currentColorScheme = newColorScheme;
    [self sendEventWithName:@"appearanceChanged" body:@{@"colorScheme" : newColorScheme }];
  }
}
```

**做了去重**（`:141`）—— 只在真正变化时发事件。

`:154-156` 的 `invalidate` 调了 `[super invalidate]`：

```objc
- (void)invalidate
{
  [super invalidate];
```

而 `RCTAppearance` 继承 `RCTEventEmitter`（[26 文档 §4](./26-iOS-Base余部网络图像与快捷键.md) 提到过这个基类），
`super invalidate` 会移除 `supportedEvents`（`:149-152`）声明的事件监听。

**又一个正面样本** —— 与 `RCTAccessibilityManager` 形成对照。

### 6.1 `setColorScheme:` 遍历所有 scene

`RCTAppearance.mm:112-126`：

```objc
- (void)setColorScheme:(NSString *)style
{
  UIUserInterfaceStyle userInterfaceStyle = [RCTConvert UIUserInterfaceStyle:style];
  NSMutableArray<UIWindow *> *windows = [NSMutableArray new];
  for (UIWindowScene *scene in RCTSharedApplication().connectedScenes) {
    if (![scene respondsToSelector:@selector(windows)]) {
      continue;
    }
    [windows addObjectsFromArray:scene.windows];
  }

  for (UIWindow *window in windows) {
    window.overrideUserInterfaceStyle = userInterfaceStyle;
  }
}
```

**`:117-119` 有 `respondsToSelector:` 保护** —— 与 [26 文档](./26-iOS-Base余部网络图像与快捷键.md)
的私有 API 混淆不同，这里是**正常的防御性检查**（`UIScene` 的 `windows` 是 iOS 13+ API）。

---

## 7. Dimensions 更新的两道门控

`RCTDeviceInfo` 有两处发 `didUpdateDimensions`，**都被 `RCTIsAppActive()` 门控**。

`RCTUtils.mm:1416-1419`：

```objc
BOOL RCTIsAppActive(void)
{
  return [RCTSharedApplication() applicationState] == UIApplicationStateActive;
}
```

`:315-331`：

```objc
// packages/react-native/React/CoreModules/RCTDeviceInfo.mm:315-321
- (void)_interfaceFrameDidChange
{
  [self invalidateCachedConstants];
  NSDictionary *nextInterfaceDimensions = _constants[@"Dimensions"];

  // update and publish the even only when the app is in active state
  if (!([nextInterfaceDimensions isEqual:_currentInterfaceDimensions]) && RCTIsAppActive()) {
```

**注释说明了意图**（`:320`），且 `:326-328` 的注释进一步解释
为什么 `_currentInterfaceDimensions` 的赋值也在 if 内：

```objc
// packages/react-native/React/CoreModules/RCTDeviceInfo.mm:298-300
    // We only want to track the current _currentInterfaceOrientation and _isFullscreen only
    // when it happens and only when it is published.
    _currentInterfaceOrientation = nextOrientation;
```

**这是有意设计而非缺陷**：
后台不发事件（省电、避免无效布局），
且不更新「当前状态」以保证 App 回到前台时会重新发一次。

### 7.1 缓存失效的 4 个触发点

`invalidateCachedConstants` 的调用点（实测 4 处）：

| 位置 | 触发场景 |
| --- | --- |
| `:129` | `initialize` 末尾（首次计算） |
| `:256` | `didReceiveNewContentSizeMultiplier` |
| `:272` | `interfaceOrientationDidChange` |
| `:317` | `_interfaceFrameDidChange` |

**缓存刷新覆盖完整**，无遗漏。

---

## 8. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| N-1 | **KVO 注册在 `RCTKeyWindow()` 返回 nil 时静默失败且永不重试**（`__weak` ivar 不会重新赋值） | `CoreModules/RCTDeviceInfo.mm:49-50` | **iPad 分屏拖拽调整大小**时 Dimensions 不更新（既无 `DidBecomeActive` 也无方向变化，仅 KVO 能捕获） |
| N-2 | **`RCTAccessibilityManager` 注册 9 个观察者、零 `removeObserver`、无 `invalidate`/`dealloc`** | `CoreModules/RCTAccessibilityManager.mm:48-109` | **不构成实际泄漏**（iOS 9+ 零指针弱引用自动清理），但与同族 `RCTDeviceInfo` 的严谨清理形成反差 |
| N-3 | `multiplierForContentSizeCategory:` 用 `m.doubleValue <= 0.0` 判空，key 不存在时误报 `RCTLogError` | `CoreModules/RCTAccessibilityManager.mm:246` | 理论缺陷（唯一调用方传入系统通知的值，必在表内） |
| N-4 | `UIApplicationDidBecomeActiveNotification` 被注册两次（指向**不同**选择器） | `CoreModules/RCTDeviceInfo.mm:95` 与 `:105` | 无害（清理时一次 `removeObserver:name:object:nil` 全覆盖），但使「一个通知→一个处理函数」的直觉不成立 |
| N-5 | `RCTDeviceInfo` 靠监听 `RCTBridgeWillInvalidateModulesNotification` 调 `invalidate` | `CoreModules/RCTDeviceInfo.mm:124-127` | 已标注 TODO（T175901725）为临时方案；**注释与代码一致，非缺陷** |

### N-1 的修复方向

最小改动是在 `initialize` 里重新获取 window 并补注册：

```objc
// 概念示意
if (_applicationWindow == nil) {
  _applicationWindow = RCTKeyWindow();
  [_applicationWindow addObserver:self forKeyPath:kFrameKeyPath options:NSKeyValueObservingOptionNew context:nil];
}
```

或改用 `RCTWindowFrameDidChangeNotification`（`:70` 自己发的那个）的对称设计 ——
由窗口变化方主动发通知，而不是 KVO 监听私有 keyPath `frame`。

> **注意 `frame` 这个 keyPath 本身也是脆弱的**：
> 它是 `UIWindow` 的私有 KVC 路径，不同 iOS 版本不保证存在。
> 更稳的做法是用 `UIWindowDidBecomeVisibleNotification` 或
> 干脆依赖已有的 3 个系统通知（但那样就丢了分屏检测能力）。

---

## 9. 生命周期严谨性对照表

本轮读到的模块，按清理质量排序（**这是本文最有复用价值的部分**）：

| 模块 | 注册 | 清理 | 幂等保护 | 评价 |
| --- | --- | --- | --- | --- |
| `RCTDeviceInfo` | 1 KVO + 6 通知（7 处注册） | ✅ 6 处清理全覆盖 | ✅ `std::atomic` + `exchange` | **最佳** |
| `RCTAppearance` | 通知 | ✅ `[super invalidate]` | — | 良好 |
| `RCTAlertController` | — | ✅ `windowScene = nil` + 置 nil | — | 良好 |
| `RCTAccessibilityManager` | **9 通知** | ❌ 零 | — | **最差**（但无实际泄漏） |
| `RCTTiming` | 5 通知 | ✅ `invalidate` → `stopTimers` | — | 良好（[27 文档](./27-iOS帧驱动与性能监控.md)） |

**共同的缺失**：**除 `RCTDeviceInfo` 外，没有一个模块用原子操作做失效幂等**。
这在「基础设施可能多次调 `invalidate`」的场景下是隐患
（`RCTDeviceInfo.mm:119-122` 的注释恰好提到了这个基础设施问题）。

---

## 10. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 23 文档 §6.3：`RCTKeyWindow()` 可能返回 nil | **补上具体后果**：N-1 的分屏检测失效；并给出同库内两种处理风格的对照（§3、§5） |
| 05 文档：`RCTFabricSurface` 观察者未移除 | **辨析**：N-2 性质不同（零指针弱引用可自动清理，非真泄漏） |
| 14 文档 BRG-1：线程局部栈缺 `@finally` | **正面对照**：`RCTDeviceInfo` 的原子幂等清理是正确样板（§2.2） |
| 26 文档 I-4：注释声称 escape 例外但代码没有 | **正面对照**：`RCTDeviceInfo:119-127` 的 TODO 注释与代码完全一致（§2.4） |
| 27 文档：`RCTTiming` 的 `invalidate` → `stopTimers` | **补入 §9 对照表** |
| 23 文档 §4.5：零调用 setter 累计清单 | 28 文档新增第 5 个（`RCTDevSettingsSetEnabled`），本文无新增 |