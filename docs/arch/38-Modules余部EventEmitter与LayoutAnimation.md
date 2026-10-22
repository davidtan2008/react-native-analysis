---
id: 38
title: "Modules 余部：RCTEventEmitter 的活跃度、LayoutAnimation 的整链失效与 RTL 开关"
topic: PL.ios
symptoms: [animation]
platforms: [ios]
architecture: [cross]
layer: T3
symbols: ["RCTEventEmitter", "RCTLayoutAnimation"]
claims: [CC-1, CC-2, CC-3, CC-4, CC-5, CC-6, CC-7, CC-8, CC-9, CC-10]
---
# 38 · Modules 余部：RCTEventEmitter 的活跃度、LayoutAnimation 的整链失效与 RTL 开关

> **模块**：C1 · `React/Modules/` 余部 6 文件（`RCTEventEmitter.m` 162、
> `RCTLayoutAnimation.m` 162、`RCTLayoutAnimationGroup.m` 79、
> `RCTI18nUtil.m` 107、`RCTRedBoxExtraDataViewController.m` 270、
> `RCTSurfacePresenterStub.m` 36）
> **基线**：react-native @ `9b131e42` · iOS 侧
> **前置**：[24 文档](./24-iOS事件分发触摸管线与JS加载.md) 记录了
> `RCTEventEmitter.js` 在 JS 侧零 import；
> [37 文档](./37-legacy布局层被掏空与ShadowQueue转用.md) 记录了
> `RCTUIManager` 21 个方法全是桩、`RCTLayoutAnimation` 相关入口已断。
>
> 本文**修正 24 文档的观察范围**（ObjC 侧 `RCTEventEmitter` 有 **10 个活子类**），
> 给出 **`initWithDisabledObservation` 这个隐蔽的承重标志**，
> 并给出 **`LayoutAnimation` 在 iOS 上整链失效**的完整证据链。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `Modules/RCTRedBoxExtraDataViewController.m` | 270 | RedBox 附加数据面板 |
| `Modules/RCTEventEmitter.m` | 162 | **事件发射器基类（10 个活子类）** |
| `Modules/RCTLayoutAnimation.m` | 162 | **LayoutAnimation（整链失效）** |
| `Modules/RCTI18nUtil.m` | 107 | RTL 开关 |
| `Modules/RCTLayoutAnimationGroup.m` | 79 | 三段动画分组 |
| `Modules/RCTSurfacePresenterStub.m` | 36 | 关联对象存 presenter |

---

## 2. `RCTEventEmitter`：ObjC 侧是活的

### 2.1 【修正 24 文档】10 个子类，JS 侧零 import ≠ 整链死

[24 文档](./24-iOS事件分发触摸管线与JS加载.md) 的结论是
「`RCTEventEmitter.js` 全仓库零 import → legacy 事件链在 JS 侧已断开」。

**这个结论本身正确，但只覆盖 JS 侧。** ObjC 侧的实现完整，且有 **10 个子类**：

| 子类 | 位置 |
| --- | --- |
| `RCTNativeAnimatedTurboModule` | `Libraries/NativeAnimation/RCTNativeAnimatedTurboModule.h:16` |
| `RCTNetworking` | `Libraries/Network/RCTNetworking.h:29` |
| `RCTLinkingManager` | `Libraries/LinkingIOS/RCTLinkingManager.h:12` |
| `RCTPushNotificationManager` | `Libraries/PushNotificationIOS/RCTPushNotificationManager.h:12` |
| `RCTAppearance` | `React/CoreModules/RCTAppearance.h:20` |
| `RCTDevSettings` | `React/CoreModules/RCTDevSettings.h:53` |
| `RCTKeyboardObserver` | `React/CoreModules/RCTKeyboardObserver.h:10` |
| `RCTStatusBarManager` | `React/CoreModules/RCTStatusBarManager.h:22` |
| `RCTWebSocketModule` | `React/CoreModules/RCTWebSocketModule.h:27` |
| `RCTAppState` | `React/CoreModules/RCTAppState.h:10` |

**10 个全是活跃的核心模块**（网络、键盘、状态栏、外观、推送、链接…）。

> **修正后的准确表述**：
> **「`RCTEventEmitter.js` 这个 JS 封装类已无使用方」**，
> **不等于「`RCTEventEmitter` 这个 ObjC 基类已废弃」**。
> 后者有 10 个子类在用，是事件发射的**实际通道**。
>
> **教训**：24 文档从「某个同名 JS 文件零 import」推出「事件链断开」，
> 结论对，但**推理链缺一环**（未检查 ObjC 侧是否有子类）。
> 「看到缺失就判为断链」（24）与「看到缺失先确认另一侧」
> （[29 文档](./29-iOS平台能力族DeviceInfo与Accessibility.md) 的 `uiManager`）
> 是同一个教训的两面。

### 2.2 事件实际落到 `RCTDeviceEventEmitter.emit`

`:80-83`：

```objc
// packages/react-native/React/Modules/RCTEventEmitter.m:80-83
  [callableJSModules invokeModule:@"RCTDeviceEventEmitter"
                           method:@"emit"
                         withArgs:body ? @[ eventName, body ] : @[ eventName ]];
```

**所有 `RCTEventEmitter` 子类的事件都被转成 `DeviceEventEmitter.emit(eventName, body)`。**

即 JS 侧统一用 `DeviceEventEmitter.addListener(eventName, ...)` 接收，
**不需要每个模块有对应的 JS 封装类** ——
这解释了为什么 `RCTEventEmitter.js` 可以零 import 而事件链仍然通。

### 2.3 `_callableJSModulesWasInitialized`：为弱引用 nil 兜底的额外标志

`:14-21` 的 ivar 与注释：

```objc
// packages/react-native/React/Modules/RCTEventEmitter.m:14-21
@implementation RCTEventEmitter {
  NSInteger _listenerCount;
  BOOL _observationDisabled;
  // Set to YES when -setCallableJSModules: is called with a non-nil value.
  // _callableJSModules is weak and can return to nil after wiring (e.g. on
  // host teardown) while this instance lives on, so the current value of
  // _callableJSModules can't tell us whether we were ever set up correctly.
  // This flag can.
  BOOL _callableJSModulesWasInitialized;
```

**注释解释了一个真实的 bug 场景**：
`_callableJSModules` 是 `weak`，宿主拆除后会变 `nil`，
但实例可能还活着 —— 此时**「当前值是 nil」无法区分「从未设置过」与「曾设置过但已失效」**。
用一个只增不减的 `BOOL` 区分这两种情况。

`:84-90` 的写入：

```objc
// packages/react-native/React/Modules/RCTEventEmitter.m:84-90
- (void)setCallableJSModules:(RCTCallableJSModules *)callableJSModules
{
  _callableJSModules = callableJSModules;
  if (callableJSModules != nil) {
    _callableJSModulesWasInitialized = YES;
  }
}
```

`:44-52` 的断言用它，**且文案直接给出最可能的原因**：

```objc
// packages/react-native/React/Modules/RCTEventEmitter.m:44-52
  RCTAssert(
      _callableJSModulesWasInitialized,
      @"Error when sending event: %@ (listenerCount: %lld) with body: %@. "
       "RCTCallableJSModules is not set. This is probably because you've "
       "explicitly synthesized the RCTCallableJSModules in %@, even though it's inherited "
       "from RCTEventEmitter.",
```

「误加 `@synthesize` 覆盖继承属性」是一个非常具体的排障提示 ——
与 [29 文档](./29-iOS平台能力族DeviceInfo与Accessibility.md) 的
「断言文案即排障指引」属同一类高质量写法。

### 2.4 四道发送前守卫

`:44-78` 的 `sendEventWithName:body:` 依次检查：

| 顺序 | 检查 | 失败行为 | Release 下是否生效 |
| --- | --- | --- | --- |
| ① | `RCTAssert(_callableJSModulesWasInitialized, ...)` | 断言 | ❌ 编译掉（23 文档 §4.1） |
| ② | `RCT_DEBUG && ![[self supportedEvents] containsObject:eventName]` | `RCTLogError` | ❌ `RCT_DEBUG` 短路 |
| ③ | `callableJSModules == nil` | `RCTLogWarn` + **return** | ✅ |
| ④ | `!(_observationDisabled \|\| _listenerCount > 0)` | `RCTLogWarn` + **return** | ✅ |

**③④ 在 Release 下仍生效**（`RCTLogWarn` 走 `_RCTLogNativeInternal`）。

`:71-73` 的注释说明了弱引用的一次性读取理由：

```objc
// packages/react-native/React/Modules/RCTEventEmitter.m:71-73
  // _callableJSModules is weak, so read it exactly once into a strong local.
  RCTCallableJSModules *callableJSModules = _callableJSModules;
```

**即「先取强引用再判空」** —— 避免「判空通过后、使用前被置 nil」的竞态。

### 2.5 【核心】`_observationDisabled` 是承重标志，不是「关闭开关」

`:31-36` 定义了专用初始化器：

```objc
// packages/react-native/React/Modules/RCTEventEmitter.m:31-36
- (instancetype)initWithDisabledObservation
{
  self = [super init];
  _observationDisabled = YES;
  return self;
}
```

**唯一调用方**是 `Libraries/Network/RCTNetworking.mm:177-180`：

```objc
// packages/react-native/Libraries/Network/RCTNetworking.mm:177-180
- (instancetype)init
{
  return [super initWithDisabledObservation];
}
```

#### 为什么 Networking 必须用它

**关键事实：JS 侧的 `RCTNetworking.addListener` 不是原生方法。**

`Libraries/Network/RCTNetworking.ios.js:21-28`：

```js
  addListener<K extends keyof RCTNetworkingEventDefinitions>(
    eventType: K,
    listener: (...RCTNetworkingEventDefinitions[K]) => unknown,
    context?: unknown,
  ): EventSubscription {
    // $FlowFixMe[incompatible-type]
    return RCTDeviceEventEmitter.addListener(eventType, listener, context);
  },
```

**它直接转发给 `RCTDeviceEventEmitter.addListener`，完全不碰原生 `addListener` 方法。**
Android 版同理（`RCTNetworking.android.js:52-58`，转发给 `emitter.addListener`）。

#### 推导：去掉这个标志会发生什么

| 步骤 | 后果 |
| --- | --- |
| ① JS 只调 `RCTDeviceEventEmitter.addListener` | 原生 `RCTEventEmitter.addListener:` **永不被调用** |
| ② 原生 `_listenerCount` 恒为 0 | — |
| ③ `:75` 的 `shouldEmitEvent = (_observationDisabled \|\| _listenerCount > 0)` | 若无标志 → `false \|\| false` = **false** |
| ④ `:76-79` | `RCTLogWarn(@"Sending ... with no listeners registered.")` + **return** |
| ⑤ 结果 | **Networking 的全部 6 个事件被丢弃**（`didReceiveNetworkResponse` / `didSendNetworkData` / `didReceiveNetworkData` / `didReceiveNetworkIncrementalData` / `didReceiveNetworkDataProgress` / `didCompleteNetworkResponse`） |

> **即：`_observationDisabled` 的名字有误导性。**
> 它**不是**「禁用事件发送」，而是「**不把 listener 计数当作发送门槛**」。
> 去掉它 = 关掉 Networking 的整个事件系统。
>
> **这类标志最难排查**，因为：
> - 代码里没有任何注释说明它是承重的；
> - 它的名字读起来像「关掉某个功能」；
> - 唯一使用点在**另一个文件**（`RCTNetworking.mm`），
>   且从那个文件看不出为什么需要它。
>
> **这正是「零调用 setter 清单」（29/30 文档 §6.1）之外的另一类隐蔽契约**：
> **不是没人调用，而是「不用它就坏」**。

### 2.6 监听者计数与 `removeListeners:` 的窄化转换

`:108-132`：

```objc
// packages/react-native/React/Modules/RCTEventEmitter.m:124-132
RCT_EXPORT_METHOD(removeListeners : (double)count)
{
  if (_observationDisabled) {
    return;
  }

  int currentCount = (int)count;
  if (RCT_DEBUG && currentCount > _listenerCount) {
    RCTLogError(@"Attempted to remove more %@ listeners than added", [self class]);
  }
  _listenerCount = MAX(_listenerCount - currentCount, 0);
  if (_listenerCount == 0) {
    [self stopObserving];
  }
}
```

**类型链：JS `number` → ObjC `double` → `int`**。

| 观察 | 说明 |
| --- | --- |
| `(int)count` 是**窄化转换** | JS 传 `2^31` 以上的值 → 实现未定义（实践上取低 32 位） |
| 越界检查**被 `RCT_DEBUG` 门控** | Release 下 `removeListeners(999)` 把计数压到 0（`MAX(...,0)` 兜底），**无任何警告** |
| `MAX(..., 0)` | 防止 `_listenerCount` 变负 |
| `NSInteger`（64 位）vs `int`（32 位）比较 | 整型提升后比较，无问题 |

**注意与 23 文档 §4.1 的差别**：`RCTAssert` 在 Release 下被**编译掉**；
而这里 `RCTLogError` 只是被 `RCT_DEBUG &&` **短路** —— 代码还在，只是不执行。
**两种「Release 静默」机制不同，排查时不可混为一谈。**

### 2.7 `+moduleName` 返回 `@""`

`:26-29`：

```objc
// packages/react-native/React/Modules/RCTEventEmitter.m:26-29
+ (NSString *)moduleName
{
  return @"";
}
```

| 用途 | 是否受影响 |
| --- | --- |
| `RCTEventEmitter` 自身注册为模块 | ❌ 不注册 —— 不在 `CoreModulesPlugins.h` 的 23 个 `Cls` 里，也不在 `coreModuleClasses` 集合里（`React/Base/RCTBridge.mm:50-90`） |
| 子类继承此方法 | ⚠️ 子类若忘记覆写会以空名注册 |
| `RCTBridgeModuleNameForClass` 反射 | 依赖 `RCT_EXPORT_MODULE` 宏，与 `+moduleName` 无关 |

**空串而非 `nil`** —— `nil` 会让反射路径崩溃，`@""` 是「永不匹配任何查询」的安全值。

### 2.8 `_log:` 是文档化的测试缝

`:153-160`：

```objc
// packages/react-native/React/Modules/RCTEventEmitter.m:153-160
#pragma mark - Test utilities

// For testing purposes only.
// This is supposed to be overridden by a subclass in the Tests
// to verified that the error message is actually emitted.
// This is the less intrusive way found to mock the RCTLogError function in unit tests.
- (void)_log:(NSString *)message
{
  RCTLogError(@"%@", message);
}
```

**唯一使用点**是 `:37-42`（`supportedEvents` 未实现时）：

```objc
// packages/react-native/React/Modules/RCTEventEmitter.m:37-42
- (NSArray<NSString *> *)supportedEvents
{
  NSString *message =
      [NSString stringWithFormat:@"%@ must implement the supportedEvents method", NSStringFromClass(self.class)];
  [self _log:message];
  return nil;
}
```

**这是「为测试而做的设计」**，注释明说「less intrusive way to mock RCTLogError」。

> 与 [36 文档 §5](./36-legacy-View层ComponentData与hitTest.md) 的
> 「注释质量三档」并列，属**第一档**（给了理由 + 说了取舍）。
>
> **本仓库的测试缝大多隐式**（直接检查返回值），
> 这里显式开口并注释，属少数派做法。

---

## 3. 【核心】`LayoutAnimation` 在 iOS 上整链失效

### 3.1 失效链的四环

```
① RCTUIManager.setNextLayoutAnimationGroup:  → 空实现（37 文档 §2.1）
                                            └─ 零调用方
② RCTLayoutAnimationGroup                   → 零实例化（只被类型引用）
③ RCTLayoutAnimation.initializeStatics        → 零调用方
                                            └─ → 键盘曲线观察者从不注册
④ RCTUIManager.configureNextLayoutAnimation  → 方法根本不存在
                                            └─ JS 的 legacy 分支静默跳过
```

### 3.2 环节 ③：`initializeStatics` 零调用 → 键盘动画曲线恒为 0

`React/Modules/RCTLayoutAnimation.m:44-66`：

```objc
// packages/react-native/React/Modules/RCTLayoutAnimation.m:44-57
#else
// Use a custom initialization function rather than implementing `+initialize` so that we can control
// when the initialization code runs. `+initialize` runs immediately before the first message is sent
// to the class which may be too late for us. By this time, we may have missed some
// `UIKeyboardWillChangeFrameNotification`s.
+ (void)initializeStatics
{
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(keyboardWillChangeFrame:)
                                                 name:UIKeyboardWillChangeFrameNotification
                                               object:nil];
  });
}
```

**注释解释了「为什么用 `+initializeStatics` 而不是 `+initialize`」**
（`+initialize` 可能在错过的通知之后才跑）—— 这是高质量注释。

**但 `initializeStatics` 全仓库零调用方。**

**后果链**：

| 步骤 | 结果 |
| --- | --- |
| ① `initializeStatics` 从未被调 | `UIKeyboardWillChangeFrameNotification` **观察者从未注册** |
| ② `keyboardWillChangeFrame:` 从未执行 | `static UIViewAnimationCurve _currentKeyboardAnimationCurve`（`:14`）**恒为 0** |
| ③ `RCTAnimationTypeKeyboard` 走 `:29-31` | `return (UIViewAnimationOptions)(0 << 16)` = **`UIViewAnimationOptionCurveLinear`** |

```objc
// packages/react-native/React/Modules/RCTLayoutAnimation.m:29-31
    case RCTAnimationTypeKeyboard:
      // http://stackoverflow.com/questions/18870447/how-to-use-the-default-ios7-uianimation-curve
      return (UIViewAnimationOptions)(_currentKeyboardAnimationCurve << 16);
```

> **即：`RCTAnimationTypeKeyboard` 名义上「跟随键盘动画曲线」，
> 实际恒等于线性曲线。**
> 由于整条 LayoutAnimation 链已断（§3.1），这个失效当前不可观察。

### 3.3 环节 ③ 的第三例 `#if TARGET_OS_TV`

`:37-43`：

```objc
// packages/react-native/React/Modules/RCTLayoutAnimation.m:37-43
#if TARGET_OS_TV

// No-op on tvOS
+ (void)initializeStatics
{
}

#else
```

**这是本仓库 `#if TARGET_OS_TV` no-op 模式的第三例**：

| # | 位置 | 形式 |
| --- | --- | --- |
| 1 | `React/Base/RCTConvert.h:82-89`（[24 文档 §2.1](./24-iOS事件分发触摸管线与JS加载.md)） | `#if !TARGET_OS_TV` 包裹功能 |
| 2 | `ComponentViews/View/RCTViewComponentView.mm:43`、`:139`（[31 文档 §5.3](./31-Fabric组件层View与回收池.md)） | `#if !TARGET_OS_TV` 包裹功能 |
| **3** | **`React/Modules/RCTLayoutAnimation.m:37-43`（本文）** | **整个方法在 tvOS 上是 no-op** |

**三处形态不同**：前两处是「tvOS 上不编译」，这一处是「tvOS 上编译但什么都不做」。

> **前者更安全**（tvOS 上调用会编译失败 → 立刻发现），
> **后者更隐蔽**（tvOS 上调用成功但无效果）。

### 3.4 环节 ④：JS 的 legacy 分支调了一个不存在的方法

`Libraries/LayoutAnimation/LayoutAnimation.js:91-118`：

```js
// packages/react-native/Libraries/LayoutAnimation/LayoutAnimation.js:91-118
  // In Fabric, LayoutAnimations are unconditionally enabled for Android, and
  // conditionally enabled on iOS (pending fully shipping; this is a temporary state).
  const FabricUIManager = getFabricUIManager();
  if (FabricUIManager?.configureNextLayoutAnimation) {
    FabricUIManager.configureNextLayoutAnimation(
      config,
      onAnimationComplete,
      onAnimationDidFail ??
        function () {} /* this will only be called if configuration parsing fails */,
    );
    return;
  }

  // This will only run if Fabric is *not* installed.
  // If you have Fabric + non-Fabric running in the same VM, non-Fabric LayoutAnimations
  // will not work.
  if (UIManager?.configureNextLayoutAnimation) {
    UIManager.configureNextLayoutAnimation(
      config,
      /* $FlowFixMe[constant-condition] Error discovered during Constant
       * Condition roll out. See https://fburl.com/workplace/1v97vimq. */
      onAnimationComplete ?? function () {},
      onAnimationDidFail ??
        function () {} /* this should never be called in Non-Fabric */,
    );
  }
```

**`configureNextLayoutAnimation` 的全部实现点**：

| 平台 | 实现位置 |
| --- | --- |
| **Fabric C++（跨平台）** | `ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:750`、`UIManager.cpp:526` |
| **Android（legacy UIManagerModule）** | `ReactAndroid/src/main/java/com/facebook/react/uimanager/UIManagerModule.kt:459` |
| **iOS（`RCTUIManager`）** | ❌ **不存在** |

**即：JS 的第二个分支在 iOS 上永远走不通。**

| 条件 | 结果 |
| --- | --- |
| `FabricUIManager?.configureNextLayoutAnimation` 为真（Fabric） | 走 Fabric C++ 路径 ✅ |
| Fabric 路径不存在（无 Fabric） | 落到 `UIManager?.configureNextLayoutAnimation` —— **ObjC `RCTUIManager` 无此方法 → `undefined` → 整个 if 块跳过** |
| 结果 | **iOS 上 legacy LayoutAnimation 静默无操作**（不崩、不警告） |

**这与 [37 文档 BB-1](./37-legacy布局层被掏空与ShadowQueue转用.md) 是同一类问题的 JS 侧镜像**：
`UIManager` 能被取到、能被调用，但方法不存在 → 静默跳过。

### 3.5 正面样本：跨语言的 10ms 阈值契约成立

`RCTLayoutAnimation.m:95-106`：

```objc
// packages/react-native/React/Modules/RCTLayoutAnimation.m:95-106
    _duration = [RCTConvert NSTimeInterval:config[@"duration"]] ?: duration;
    if (_duration > 0.0 && _duration < 0.01) {
      RCTLogError(@"RCTLayoutAnimationGroup expects timings to be in ms, not seconds.");
      _duration = _duration * 1000.0;
    }

    _delay = [RCTConvert NSTimeInterval:config[@"delay"]];
    if (_delay > 0.0 && _delay < 0.01) {
      RCTLogError(@"RCTLayoutAnimationGroup expects timings to be in ms, not seconds.");
      _delay = _delay * 1000.0;
    }
```

**原生阈值 `0.01` 秒 = 10 毫秒。**

`Libraries/Components/Keyboard/KeyboardAvoidingView.js:178-188`：

```js
// packages/react-native/Libraries/Components/Keyboard/KeyboardAvoidingView.js:178-188
      LayoutAnimation.configureNext({
        // We have to pass the duration equal to minimal accepted duration defined here: RCTLayoutAnimation.m
        duration: duration > 10 ? duration : 10,
        update: {
          duration: duration > 10 ? duration : 10,
          type: LayoutAnimation.Types[easing] || 'keyboard',
        },
      });
```

**JS 侧钳到 `10`（毫秒）** → 原生 `RCTConvert NSTimeInterval` 把 ms 转 s
（`10 ms → 0.01 s`）→ `_duration < 0.01` **不成立** → **不触发 `RCTLogError`**。

**注释里的双向指针成立**：
JS 注释指向 `RCTLayoutAnimation.m`，那里的 `0.01` 正好是 JS 的 `10`（换算后）。

> **这是与 §3.5 相反的正面样本**：注释指向的文件里**确实有**所说的常量。
> 与 37 文档 §5.4（注释指向的 `.h` 里没有说明）构成对照。

**但注意**：这段契约保护的是**一条已经失效的代码路径**（§3.4）。
**契约正确性与路径可达性是两件事。**

---

## 4. `RCTI18nUtil`：三个 `NSUserDefaults` 键与单例副作用

### 4.1 单例创建时有写副作用

`:14-24`：

```objc
// packages/react-native/React/Modules/RCTI18nUtil.m:14-24
+ (instancetype)sharedInstance
{
  static RCTI18nUtil *sharedInstance;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    sharedInstance = [self new];
    [sharedInstance swapLeftAndRightInRTL:true];
  });

  return sharedInstance;
}
```

**`dispatch_once` 里调用了 `swapLeftAndRightInRTL:YES`**，
而该方法（`:84-87`）会**写 `NSUserDefaults`**：

```objc
// packages/react-native/React/Modules/RCTI18nUtil.m:84-87
- (void)swapLeftAndRightInRTL:(BOOL)value
{
  [[NSUserDefaults standardUserDefaults] setBool:value forKey:@"RCTI18nUtil_makeRTLFlipLeftAndRightStyles"];
  [[NSUserDefaults standardUserDefaults] synchronize];
}
```

> **「取单例」这个读操作有持久化副作用。**
> `doLeftAndRightSwapInRTL` 的默认值因此**不是** `NO` 而是 `YES`
> —— 只要有人碰过 `sharedInstance`，就永久翻转。
>
> 这与「默认为 NO」的直觉相反，且**无注释说明**。

### 4.2 三个键与语义

| 键 | 类型 | getter | setter | 默认 |
| --- | --- | --- | --- | --- |
| `RCTI18nUtil_allowRTL` | `NSNumber *`（对象判空） | `:52-58` | `:60-62` | **`YES`**（键不存在时返回 `YES`） |
| `RCTI18nUtil_forceRTL` | `BOOL` | `:71-74` | `:76-79` | `NO` |
| `RCTI18nUtil_makeRTLFlipLeftAndRightStyles` | `BOOL` | `:81-83` | `:84-87` | **`YES`**（因 §4.1 的单例副作用） |

`:52-58` 的 getter 用**对象判空**而非 `boolForKey:`：

```objc
// packages/react-native/React/Modules/RCTI18nUtil.m:52-58
- (BOOL)isRTLAllowed
{
  NSNumber *value = [[NSUserDefaults standardUserDefaults] objectForKey:@"RCTI18nUtil_allowRTL"];
  if (value == nil) {
    return YES;
  }
  return [value boolValue];
}
```

**这是刻意的** —— `boolForKey:` 无法区分「未设置」与「设置为 NO」，
而这里需要「未设置 = 允许 RTL」的三态语义。

**另两个键的 setter 用 `setBool:forKey:`**（写入时总是 `NSNumber`），
所以 getter 用 `boolForKey:` 是安全的。**三个键的读写 API 不统一，但是各自正确的。**

### 4.3 三处 `synchronize`（已废弃 API）

`:61`、`:78`、`:86` 各有一次 `[[NSUserDefaults standardUserDefaults] synchronize]`。

`synchronize` 自 iOS 12 起**官方标注为不必要**
（系统会自动持久化），Apple 文档明确建议移除。

**三处都在 setter 里**，即每次调用都会触发一次同步写盘。

> **性能影响**：RTL 相关的三个 setter 只在开发/调试时被调用
> （`forceRTL:` / `allowRTL:` 是给开发者切语言的工具），
> **生产路径不经过**。故实际影响为零。
>
> **归类**：与 [33 文档 X-1](./33-Fabric组件层TextInput事件计数.md)（`eventCount` 的 int/NSUInteger）
> 同类 —— **能精确定位到触发条件，且触发条件在生产中不可达成**。

### 4.4 两种 RTL 判定方法的语义差异

`:32-42` 的组合判定：

```objc
// packages/react-native/React/Modules/RCTI18nUtil.m:32-42
- (BOOL)isRTL
{
  if ([self isRTLForced]) {
    return YES;
  }
  if ([self isRTLAllowed] && [self isApplicationPreferredLanguageRTL]) {
    return YES;
  }
  return NO;
}
```

两个判定方法的实现不同：

| 方法 | 实现 | 依据 |
| --- | --- | --- |
| `isDevicePreferredLanguageRTL`（`:90-95`） | `[NSLocale characterDirectionForLanguage:preferredLanguages[0]]` | **设备的首选语言** |
| `isApplicationPreferredLanguageRTL`（`:100-103`） | `[NSParagraphStyle defaultWritingDirectionForLanguage:nil]` | **Xcode「Localization」配置 ∩ 系统语言** |

`:97-99` 的注释说明了后者的意图：

```objc
// packages/react-native/React/Modules/RCTI18nUtil.m:97-100
// Intersect Xcode "Localization" languages with the system languages and checks if the result is using RTL
// For RTL support, app must add an RTL lang to .pbxproj's knownRegions = ( ... )
// and user must have chosen an RTL language
- (BOOL)isApplicationPreferredLanguageRTL
```

**即：即使系统首选语言是 RTL，若 App 的 `.pbxproj` 没把该语言加进 `knownRegions`，
`defaultWritingDirectionForLanguage:nil` 仍返回 LTR。**

> **注意 `isDevicePreferredLanguageRTL` 在 `isRTL` 里未被使用** ——
> 它是 `RCTI18nUtil.h` 的公开 API，供其他代码直接查询。
> **两个近似的方法名 + 一个未被内部使用**，是排查时的陷阱。

---

## 5. `RCTRedBoxExtraDataViewController`：无节流的累积式面板

### 5.1 `addExtraData:` 每次都 `dispatch_async` + `reloadData`

`:225-246`：

```objc
// packages/react-native/React/Modules/RCTRedBoxExtraDataViewController.m:225-246
- (void)addExtraData:(NSDictionary *)data forIdentifier:(NSString *)identifier
{
  dispatch_async(dispatch_get_main_queue(), ^{
    NSMutableArray *newData = [NSMutableArray new];
    for (id key in data) {
      [newData addObject:@[
        [NSString stringWithFormat:@"%@", key],
        [NSString stringWithFormat:@"%@", [data objectForKey:key]]
      ]];
    }

    NSInteger idx = [self->_extraDataTitle indexOfObject:identifier];
    if (idx == NSNotFound) {
      [self->_extraDataTitle addObject:identifier];
      [self->_extraData addObject:newData];
    } else {
      [self->_extraData replaceObjectAtIndex:idx withObject:newData];
    }

    [self->_tableView reloadData];
  });
}
```

**特性**：

| 特性 | 说明 |
| --- | --- |
| **无节流** | 每次调用都 `reloadData`（整个 table view 重载） |
| **按 identifier 去重** | `indexOfObject:` 找到则替换，否则追加 —— 天然的合并语义 |
| **`indexOfObject:` 是线性查找** | `_extraDataTitle` 通常只有个位数条目，可接受 |
| **主队列异步** | 线程安全 |

**调用链**：`RCTRedBox.mm:226-228` 的 `setExtraData:forIdentifier:` →
`[_extraDataViewController addExtraData:extraData forIdentifier:identifier]`。
而 `setExtraData:` 是 TurboModule 方法（`src/private/specs_DEPRECATED/modules/NativeRedBox.js:17`），
**JS 可反复调用**。

> **风险量化**：`reloadData` 是 O(行数) 且触发 `cellForRowAtIndexPath:` 逐行构造。
> 若某处循环调 `setExtraData` 数百次（如为每个崩溃点附加一份数据），
> 会有明显卡顿。**但当前无证据表明存在这样的调用方**
> —— 归入「机制存在、实际调用未知」类。

### 5.2 `_extraData` 无上限

`_extraData` / `_extraDataTitle` 是无上限的 `NSMutableArray`，
只有 `dismiss`（`:248-251`）会清空（`[_actionDelegate reload]` → 重建 VC）。

**RedBox 面板本身是 dev-only**（`RCTRedBox` 受 `#if RCT_DEV_MENU` 门控，
见 [22 文档](./22-iOS崩溃UI层RedBox与LogBox.md)），所以生产环境不累积。

### 5.3 `keyCommands`：Escape 与 ⌘R

`:260-270`：

```objc
// packages/react-native/React/Modules/RCTRedBoxExtraDataViewController.m:260-270
- (NSArray<UIKeyCommand *> *)keyCommands
{
  return @[
    // Dismiss
    [UIKeyCommand keyCommandWithInput:UIKeyInputEscape modifierFlags:0 action:@selector(dismiss)],
    // Reload
    [UIKeyCommand keyCommandWithInput:@"r" modifierFlags:UIKeyModifierCommand action:@selector(reload)]
  ];
}
```

`reload` → `[_actionDelegate reload]`（`:253-256`）→ 触发 JS reload。

> **与 [26 文档 I-4](./26-iOS-Base余部网络图像与快捷键.md) 对照**：
> `RCTKeyCommands` 的注释声称有 escape 例外但代码没有；
> **这里 `UIKeyInputEscape` 确实存在** —— 属「注释与代码一致」的正面实例。

---

## 6. `RCTSurfacePresenterStub`：关联对象版的两套实现

`Modules/RCTSurfacePresenterStub.m`（36 行）给 **两个类**加了同一组 property：

```objc
// packages/react-native/React/Modules/RCTSurfacePresenterStub.m:9-32
#import "RCTSurfacePresenterStub.h"

@implementation RCTBridge (RCTSurfacePresenterStub)

- (id<RCTSurfacePresenterStub>)surfacePresenter
{
  return objc_getAssociatedObject(self, @selector(surfacePresenter));
}

- (void)setSurfacePresenter:(id<RCTSurfacePresenterStub>)surfacePresenter
{
  objc_setAssociatedObject(self, @selector(surfacePresenter), surfacePresenter, OBJC_ASSOCIATION_RETAIN);
}

@end

@implementation RCTBridgeProxy (RCTSurfacePresenterStub)

- (id<RCTSurfacePresenterStub>)surfacePresenter
{
  return objc_getAssociatedObject(self, @selector(surfacePresenter));
}

- (void)setSurfacePresenter:(id<RCTSurfacePresenterStub>)surfacePresenter
{
  objc_setAssociatedObject(self, @selector(surfacePresenter), surfacePresenter, OBJC_ASSOCIATION_RETAIN);
}

@end
```

**两个类的实现逐字相同**（只有 `self` 的类型不同）。

> **这是 30 文档 §3.3（`objc_setAssociatedObject` 扩展第三方类）的对照**：
> 那里是给**第三方类**（`SRWebSocket`）加属性，代价是消息转发变慢；
> 这里给**自己的类**加 category 属性，**没有性能代价**
> （category 方法是直接实现，非转发）。
>
> **关联对象的真正代价在于**：
> ① 无法用 `@property` 的类型检查；
> ② `OBJC_ASSOCIATION_RETAIN` 造成**循环引用风险**（若 presenter 持有 bridge）。

---

## 7. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| CC-1 | **`_observationDisabled` 是承重标志但名字与无注释误导** —— 去掉它会让 Networking 全部 6 个事件被丢弃 | `Modules/RCTEventEmitter.m:31-36` + `:75` + `Libraries/Network/RCTNetworking.mm:177` | **最隐蔽的一处契约**；唯一使用点在另一文件且看不出原因 |
| CC-2 | **`initializeStatics` 零调用 → `RCTAnimationTypeKeyboard` 恒等于线性曲线** | `Modules/RCTLayoutAnimation.m:48-57` + `:29-31` | 名义行为与实际不符；当前因整链失效不可观察 |
| CC-3 | **iOS 的 `RCTUIManager` 没有 `configureNextLayoutAnimation`**，JS 的 legacy 分支永久静默跳过 | `Modules/RCTUIManager.mm`（缺）+ `Libraries/LayoutAnimation/LayoutAnimation.js:108` | 与 37 文档 BB-1 同类：模块能取到但方法不存在 |
| CC-4 | `removeListeners:` 的越界检查被 `RCT_DEBUG` 门控，Release 下完全静默 | `Modules/RCTEventEmitter.m:127-129` | 计数被 `MAX(...,0)` 兜住，不崩；无诊断 |
| CC-5 | `removeListeners:` 有 `double → int` 窄化转换 | `Modules/RCTEventEmitter.m:126` | JS 传 >2³¹ 时未定义；实践中不可达 |
| CC-6 | **`RCTI18nUtil.sharedInstance` 有写 `NSUserDefaults` 的副作用**，导致 `doLeftAndRightSwapInRTL` 默认 `YES` | `Modules/RCTI18nUtil.m:20` + `:84-87` | 与「默认为 NO」的直觉相反；无注释 |
| CC-7 | 三处 `NSUserDefaults synchronize`（已废弃 API） | `Modules/RCTI18nUtil.m:61, 78, 86` | 只在 dev 路径触发，**生产影响为零** |
| CC-8 | `isDevicePreferredLanguageRTL` 与 `isApplicationPreferredLanguageRTL` 语义相近，前者未被 `isRTL` 使用 | `Modules/RCTI18nUtil.m:90-103` | 排查 RTL 问题时易选错方法 |
| CC-9 | `addExtraData:` 无节流，每次都 `reloadData` | `Modules/RCTRedBoxExtraDataViewController.m:225-246` | 大量调用时卡顿；当前无证据表明存在此类调用 |
| CC-10 | `#if TARGET_OS_TV` 的 no-op 方法（编译通过但无效果） | `Modules/RCTLayoutAnimation.m:37-43` | 与前两例「tvOS 不编译」形态不同，更隐蔽 |

### CC-1 的排查指引

**症状**：iOS 上 XHR 的 `onreadystatechange` / `onprogress` 永不触发，
但 `XMLHttpRequest.send()` 本身成功。

**排查步骤**：

```
① 确认 Libraries/Network/RCTNetworking.ios.js:21-27 的 addListener
   是否转发给 RCTDeviceEventEmitter（当前是）
     → 若改为调原生 addListener，_listenerCount 会 > 0，
       此时 _observationDisabled 变成冗余（但无害）
② 检查 Libraries/Network/RCTNetworking.mm:177-180 是否还调
   initWithDisabledObservation
     → 若删掉，_listenerCount 恒 0 → 事件全被 :76-79 丢弃
③ 看日志有无 "Sending `xxx` with no listeners registered."
   （RCTLogWarn，Release 下也输出）
```

---

## 8. 「隐蔽契约」的三种形态

本文读到的「不能动」的代码，按隐蔽程度排序：

| 形态 | 例子 | 隐蔽原因 |
| --- | --- | --- |
| **① 承重标志** | `_observationDisabled`（CC-1） | 名字像「功能开关」；使用点在另一文件；无注释 |
| **② 死代码里的活逻辑** | `initializeStatics`（CC-2） | 逻辑本身正确，但没人调用 → 静默失效 |
| **③ 注释承诺的常量** | `KeyboardAvoidingView.js:181` → `RCTLayoutAnimation.m:96`（§3.5） | 契约正确但路径已断，**双重失效** |

**与既有清单的对照**：

| 清单 | 形态 | 出处 |
| --- | --- | --- |
| 零调用 setter（7 个） | 接口在、无人调 | 29/30 文档 §6.1 |
| 零引用工厂函数（2 个） | 声明在、无定义 | 30 文档 §6.2 |
| **承重标志** | **标志在、去掉就坏** | **本文 CC-1** |
| 死代码整层（5 个类型） | 声明在、实现空 | 37 文档 §8 |

> **四种形态的排查难度递增**：
> 零调用最容易被 grep 发现；承重标志**只能靠读懂数据流**发现。
>
> **这解释了为什么本文这类文档必须逐行读代码** ——
> `grep` 能告诉你「`initializeStatics` 零调用」，
> 但**只有读 `:75` 的 `shouldEmitEvent` 表达式才能知道那意味着什么**。

---

## 9. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 24 文档：`RCTEventEmitter.js` 零 import → legacy 事件链断开 | **修正范围**：JS 侧正确；ObjC 侧有 **10 个活子类**，是实际通道（§2.1） |
| 37 文档：`RCTUIManager` 21 方法全桩 | **补上 JS 侧镜像**：`UIManager.configureNextLayoutAnimation` 也不存在（CC-3） |
| 37 文档：区分「退役」与「缺实现」的五步判据 | **新增第四种形态**「承重标志」（§8） |
| 37 文档 §5.4：注释指向的 `.h` 里没有说明 | **正面样本对照**：§3.5 的 JS 注释指向的文件里**确实有**那个常量 |
| 24 文档 §2.1 / 31 文档 §5.3：`#if !TARGET_OS_TV` | **第三例**且形态不同：no-op 方法而非不编译（CC-10） |
| 30 文档 §3.3：`objc_setAssociatedObject` 扩展第三方类 | **对照**：本文给自有类加 category，无性能代价（§6） |
| 26 文档 I-4：`RCTKeyCommands` 的 escape 例外不存在 | **正面实例**：`RCTRedBoxExtraDataViewController` 的 `UIKeyInputEscape` 存在（§5.3） |
| 23 文档 §4.1：`RCTAssert` 在 Release 被编译掉 | **新增第三种「Release 静默」**：`RCT_DEBUG &&` 短路（CC-4） |
| 33 文档 X-1：类型不匹配但不可达 | **新增同类**：三处 `synchronize`（CC-7） |
| 05 文档：RedBox 崩溃展示 | **补上面板的数据累积机制**（§5） |
