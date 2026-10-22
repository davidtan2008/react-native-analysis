---
id: 22
title: "iOS 崩溃 UI 层：RedBox / LogBox 的双层门控"
topic: PL.ios
symptoms: [crash, whitescreen]
platforms: [ios]
architecture: [cross]
layer: T3
symbols: ["RCTRedBox", "RCTLogBox"]
sourceRoot: react-native
claims: [RB-1, RB-2, RB-3, RB-4, RB-5, RB-6]
---
# 22 · iOS 崩溃 UI 层：RedBox / LogBox 的双层门控

> **模块**：C1 · `React/CoreModules` 的 `RCTRedBox*`（4 文件 / 1006 行）+ `RCTLogBox*`（2 文件 / 190 行）
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · iOS 侧
> **前置**：[20 文档](./20-iOS-CoreModules与崩溃终止机制.md) 讲了 `RCTExceptionsManager` 如何分派到 RedBox。
> 本文讲 **RedBox / LogBox 在 Release 下为什么「消失」** —— 结论是**两层独立且都靠编译期宏的门控**。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `RCTRedBox.mm` | 379 | RedBox 模块本体 |
| `RCTRedBoxController.mm` | 447 | RedBox UI 控制器 |
| `RCTRedBoxHMRClient.mm` | 125 | RedBox 内的 HMR 客户端 |
| `RCTRedBox2AnsiParser.mm` | 55 | 终端 ANSI 颜色解析 |
| `RCTLogBox.mm` | 128 | LogBox 模块本体 |
| `RCTLogBoxView.mm` | 62 | LogBox 视图 |

另有 `RCTRedBox2Controller.mm` / `RCTRedBox2ErrorParser.mm` / `RCTRedBox+Internal.h` 等。

---

## 2. 第一层：`#if RCT_DEV_MENU` 编译期门控

`CoreModules/RCTRedBox.mm` 从 `:26` 开始巨型条件编译：

```objc
#if RCT_DEV_MENU

@interface RCTRedBox () <
    RCTInvalidating,
    RCTRedBoxControllerActionDelegate,
    RCTRedBoxExtraDataActionDelegate,
    NativeRedBoxSpec>
@end

@implementation RCTRedBox {
  id<RCTRedBoxControlling> _controller;
  NSMutableArray<id<RCTErrorCustomizer>> *_errorCustomizers;
```

`#else` 支（`:298` 起）只剩最小骨架：

```objc
#else // Disabled

@interface RCTRedBox () <NativeRedBoxSpec>
@end

@implementation RCTRedBox

+ (NSString *)moduleName
{
  return nil;
}
```

**`moduleName` 返回 `nil` 是关键** —— 见 §3。

`RCTRedBox+Internal.h` 同样门控（`:12`）：

```objc
#if RCT_DEV_MENU

@class RCTJSStackFrame;

@protocol RCTRedBoxControllerActionDelegate <NSObject>
```

**头文件里的协议声明本身也被门控** —— Release 下连 `RCTRedBoxControlling` 协议都不存在。

### 2.1 LogBox 同一模式

`RCTLogBox.mm:18` 起 `#if RCT_DEV_MENU`，`:94` `#else // Disabled`：

```objc
- (void)show
{
  // noop
}

- (void)hide
{
  // noop
}
```

**两者的 else 支规模对比**：

| 模块 | else 支方法数 |
| --- | --- |
| `RCTRedBox` | 17（`showErrorMessage` 的各种重载 + `dismiss` + `setExtraData` + `addCustomButton` 等） |
| `RCTLogBox` | **2**（`show` / `hide`） |

LogBox 只有 2 个不是「实现残缺」—— 见 §4。

---

## 3. `moduleName` 返回 `nil` 的实际效果

Release 下 `RCTRedBox` 的 `getTurboModule:` **仍返回真实的 JSI 对象**：

```objc
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeRedBoxSpecJSI>(params);
}
```

**即「类存在 + JSI 存在」，但「模块名匹配不上」。**

模块发现逻辑（`ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:763-773`）：

```objc
  NSString *objcModuleName = [NSString stringWithUTF8String:moduleName];
  NSArray<Class> *modules = RCTGetModuleClasses();
  for (Class current in modules) {
    // A class without +moduleName has no custom JS name, so it can never match here.
    if (![current respondsToSelector:@selector(moduleName)]) {
      continue;
    }
    NSString *currentModuleName = [current moduleName];
    if ([objcModuleName isEqualToString:currentModuleName]) {
      return current;
    }
  }
```

**ObjC 语义保证 `[nil isEqualToString:@"RedBox"]` 返回 `NO`**
（向 `nil` 发消息返回 0/NO），因此 Release 下按名字查找**永远匹配不到 `RCTRedBox`**。

> **这是一条隐式契约**：源码**没有** `if (moduleName == nil) return nil;` 这样的显式检查，
> 完全依赖「向 nil 发消息返回 NO」这一 ObjC 基础语义。
>
> 而且那里的注释 `A class without +moduleName has no custom JS name`
> **只覆盖了「无该方法」的情况，没覆盖「有方法但返回 nil」的情况** ——
> 而 `RCTRedBox` 恰恰是后者。

---

## 4. LogBox 的空实现是完整的，不是残缺

`src/private/specs_DEPRECATED/modules/NativeLogBox.js` 的 spec：

```js
export interface Spec extends TurboModule {
  readonly show: () => void;
  readonly hide: () => void;
}
```

**spec 本身只暴露 2 个方法**，与 Release 空实现**完全对应**。

> **这一点值得澄清**：`RCTLogBox.mm` 的 else 支只实现 2 个方法，
> 乍看像「实现不全」，但因 spec 就只暴露 2 个方法，**是完整实现**。
> 相比之下 `RCTRedBox` 的 spec 方法多得多，else 支需要逐个补齐 17 个空方法。

---

## 5. 第二层：`RCTRedBoxSetEnabled` 运行期开关

除编译期门控外，还有一层**运行期**开关（`React/Base/RCTRedBoxSetEnabled.m:10-24`）：

```objc
#if RCT_DEV
static BOOL redBoxEnabled = YES;
#else
static BOOL redBoxEnabled = NO;
#endif

void RCTRedBoxSetEnabled(BOOL enabled)
{
  redBoxEnabled = enabled;
}

BOOL RCTRedBoxGetEnabled(void)
{
  return redBoxEnabled;
}
```

**默认值由 `RCT_DEV` 决定**：Dev 为 `YES`，Release 为 `NO`。

20 文档的 `RCTExceptionsManager.mm:44, 62` 用它门控 RedBox 展示：

```objc
// packages/react-native/React/CoreModules/RCTExceptionsManager.mm:44-46
  if (RCTRedBoxGetEnabled()) {
    RCTRedBox *redbox = [_moduleRegistry moduleForName:@"RedBox"];
    [redbox showErrorMessage:message withStack:stack errorCookie:(int)exceptionId];
  }
```

### 5.1 `RCT_DEV_MENU` 可独立于 `RCT_DEV` 关闭

`React/Base/RCTDefines.h:90-96`：

```objc
/**
 * RCT_DEV_MENU can be used to toggle the dev menu separately from RCT_DEV.
 * By default though, it will inherit from RCT_DEV.
 */
#ifndef RCT_DEV_MENU
#define RCT_DEV_MENU RCT_DEV
#endif
```

**这产生第三种构建组合** —— Debug 但关闭 DevMenu（`RCT_DEV=1, RCT_DEV_MENU=0`）。
在那种构建下：

| 门控 | 值 | 结果 |
| --- | --- | --- |
| `RCT_DEV_MENU`（编译期） | `0` | **RedBox 类是空壳**、`moduleName` 返回 nil |
| `RCT_DEV`（运行期 `redBoxEnabled`） | `YES` | `RCTRedBoxGetEnabled()` 返回 **`YES`** |
| 调用点 `if (RCTRedBoxGetEnabled())` | 进入 | **`[_moduleRegistry moduleForName:@"RedBox"]` 返回 nil** |

**这是两层门控第一次出现「运行期说可以、编译期说不可以」的错配。**
`RCTExceptionsManager.mm:44-46` 的调用会拿到 `nil` RedBox，
`[redbox showErrorMessage:...]` 变成**向 nil 发消息** —— 不崩溃，但**错误被静默丢弃**。

> **这是本文最值得关注的一条**：它说明这两层门控**不是冗余，而是覆盖了不同的维度**，
> 且存在一个交叉点会出现「静默丢弃」。
> 常规的 Dev / Release 两种构建下不会出现（因为两者同源），
> 只有刻意用 `RCT_DEV_MENU=0` + `RCT_DEV=1` 才会触发。

### 5.2 常规构建下的门控矩阵

| 构建 | `RCT_DEV` | `RCT_DEV_MENU` | `RCTRedBoxGetEnabled()` | RedBox 类 | 调用点 |
| --- | --- | --- | --- | --- | --- |
| **Debug** | 1 | 1 | `YES` | 完整实现 | ✅ 正常 |
| **Debug 无 DevMenu** | 1 | 0 | `YES` | 空壳（`moduleName=nil`） | ⚠️ **静默丢弃** |
| **Release** | 0 | 0 | `NO` | 空壳 | ❌ 不进入 |

**Release 下两层门控确实冗余**（`RCTRedBoxGetEnabled()` 已为 `NO`）；
但 §5.1 那种组合下二者**不等价**。

---

## 6. LogBox 与 RedBox 是联动的

`RCTLogBox.mm` 的 **Dev 支** `show()`（`:43-`）实现里有一次二次门控（`:44`）：

```objc
// packages/react-native/React/CoreModules/RCTLogBox.mm:43-47
- (void)show
{
  if (RCTRedBoxGetEnabled()) {
    __weak RCTLogBox *weakSelf = self;
    dispatch_async(dispatch_get_main_queue(), ^{
```

**即 LogBox 的显示依赖 `RCTRedBoxGetEnabled()`**（`hide` 在 `:68` 同样检查）。

而 Release 的 `#else` 支（`:105-112`）才是真正的空实现：

```objc
- (void)show
{
  // noop
}

- (void)hide
{
  // noop
}
```

**两个分支有同名方法但语义完全不同** —— 读代码时若用 `indexOf('show')` 之类的检索，
很容易命中 Dev 支的实现并误以为 else 支不完整（我自己在写断言时就踩了这个坑）。

> **联动的含义**：调用 `RCTRedBoxSetEnabled(NO)` 会**同时**关掉 RedBox 与 LogBox。
> 这是一个「一控二」的设计，源码无注释说明。

---

## 7. LogBox 在 JS 侧还有第三层

LogBox 的 JS 安装（`Libraries/LogBox/LogBox.js:98`）：

```js
      // Trigger lazy initialization of module.
      require('../NativeModules/specs/NativeLogBox');
```

而 `LogBox.install()` 本身只在 `__DEV__` 分支被调用
（见 [13 文档 §3.1](./13-JS启动装配.md) 的 `packages/react-native/src/private/setup/setUpDefaultReactNativeEnvironment.js:40`）：

```js
    require('../../../Libraries/LogBox/LogBox').default.install();
```

**三层门控叠加**：

| 层 | 位置 | 作用 |
| --- | --- | --- |
| JS | `packages/react-native/src/private/setup/setUpDefaultReactNativeEnvironment.js:40` | Release 下根本不调 `install()` |
| 编译期 | `RCTLogBox.mm:18` | Release 下只有空实现 |
| spec | `NativeLogBox.js` | 只有 `show` / `hide` |

**结论：Release 下 LogBox 完全不存在，JS 侧也不会去调它。**
这也意味着 `Libraries/LogBox/*` 的全部 JS 代码在生产包中都是死代码
（但仍会被打包，因为 Metro 不做这种分析）。

---

## 8. 与 Android 的对照

| 能力 | iOS | Android |
| --- | --- | --- |
| 编译期门控 | `#if RCT_DEV_MENU` | 无（Kotlin 无条件编译） |
| 运行期开关 | `RCTRedBoxSetEnabled` | 无对应 |
| Release 下模块注册 | `moduleName` 返回 nil → 匹配不到 | 类始终注册（见 16 文档 §2.2） |
| Release 下 UI | 无 | `ReleaseDevSupportManager` 是空壳但**类存在**（见 16 文档 §2.5） |

**iOS 用「编译期裁剪 + nil 名字」双重隐藏，Android 用「空实现类」单层隐藏。**
前者省二进制体积，后者代码路径更统一。

---

## 9. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| RB-1 | 模块发现依赖「向 nil 发消息返回 NO」，无显式 nil 检查 | `RCTTurboModuleManager.mm:769-771` | 隐式契约；该行注释只覆盖「无方法」未覆盖「返回 nil」 |
| RB-2 | **`RCT_DEV=1` + `RCT_DEV_MENU=0` 时两层门控错配** —— 运行期认为 RedBox 可用，编译期类却是空壳 | `RCTDefines.h:94-96` + `RCTRedBoxSetEnabled.m:11` | `moduleForName:@"RedBox"` 返回 nil，**错误被静默丢弃**（向 nil 发消息不崩） |
| RB-3 | `RCTRedBox+Internal.h` 整体被 `#if RCT_DEV_MENU` 包裹 | `RCTRedBox+Internal.h:12-` | 外部代码 include 该头文件在关闭 DevMenu 的构建下会编译失败 |
| RB-4 | Release 下 `Libraries/LogBox/*` 全部 JS 是死代码但仍进 bundle | `Libraries/LogBox/LogBox.js` + Metro 无死代码消除 | 生产包体积浪费（虽不大） |
| RB-5 | `RCTRedBoxSetEnabled` 无任何调用方（与 20 文档的 `maxReloadAttempts` 同类） | `React/Base/RCTRedBoxSetEnabled.m:16` | 机制存在但只能靠默认值，App 无法运行时开关 RedBox |
| RB-6 | LogBox 的 Dev 支与 else 支有**同名但语义不同**的 `show`/`hide` | `CoreModules/RCTLogBox.mm:105`（Dev）/ `:105-112`（else） | 文本检索易命中错误分支，误判 else 支「实现不全」 |

**RB-2 与 RB-5 同属「机制存在但不可控」**，但 RB-2 更隐蔽 ——
它不报错、不崩溃，只是**错误信息静默消失**。