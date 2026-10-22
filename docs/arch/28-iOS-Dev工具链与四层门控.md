---
id: 28
title: "iOS Dev 工具链：DevMenu / DevSettings / DevLoadingView 的四层门控"
topic: PL.ios
symptoms: [debug]
platforms: [ios]
architecture: [cross]
layer: T3
symbols: ["RCTDevMenu", "RCTDevLoadingView"]
sourceRoot: react-native
claims: []
---
# 28 · iOS Dev 工具链：DevMenu / DevSettings / DevLoadingView 的四层门控

> **模块**：C1 · `CoreModules/` 的 Dev 系列（5 文件 / 1836 行）
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · iOS 侧
> **前置**：[05 文档](./05-监控检测原理与流程.md) 讲了启动与白屏；
> [22 文档](./22-iOS崩溃UI层RedBox与LogBox.md) 讲了 `#if RCT_DEV_MENU` 的首次出现；
> [27 文档](./27-iOS帧驱动与性能监控.md) 讲了 `RCTPerfMonitorCls` 的 `return nil`。
>
> 本文记录 **Dev 工具链的四层编译期门控**（含两种全新模式），
> 一条**生产包远程调试通道**，一处**每次摇动都做的全树字符串渲染**，
> 以及**第五个零调用 setter**。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `CoreModules/RCTDevSettings.mm` | 662 | Dev 设置的集中地（profiling / Fast Refresh / shake / inspector） |
| `CoreModules/RCTDevMenu.mm` | 649 | 摇动唤起的 ActionSheet 菜单 |
| `CoreModules/RCTDevLoadingView.mm` | 416 | 启动期的原生加载横幅 |
| `CoreModules/RCTDevToolsRuntimeSettingsModule.mm` | 57 | DevTools 运行时设置 |
| `CoreModules/RCTDevMenuConfigurationDecorator.mm` | 52 | DevMenu 配置装饰器 |

---

## 2. 四层编译期门控

`RCTDevMenu.mm:21` 是 `#if RCT_DEV_MENU`，`RCTDevSettings.mm:66` 是
`#if RCT_DEV_MENU || RCT_REMOTE_PROFILE`，`RCTDevLoadingView.mm:29` 是 `#if RCT_DEV_MENU`。

**22 文档只覆盖了 `RCT_DEV_MENU` 一层**。本文补齐另外三种模式。

### 2.1 第一层：`RCT_DEV_MENU`（已有）

`RCTDefines.h:94-96` 定义，默认继承 `RCT_DEV`，可独立覆盖。
[22 文档 §5.1](./22-iOS崩溃UI层RedBox与LogBox.md) 已详述其错配场景。

### 2.2 第二层：`__has_include` 探测头文件（本轮新增）

`RCTDevSettings.mm:39-45`：

```objc
#ifndef RCT_DEV_SETTINGS_ENABLE_PACKAGER_CONNECTION
#if RCT_DEV && (__has_include("RCTPackagerConnection.h") || __has_include(<React/RCTPackagerConnection.h>))
#define RCT_DEV_SETTINGS_ENABLE_PACKAGER_CONNECTION 1
#else
#define RCT_DEV_SETTINGS_ENABLE_PACKAGER_CONNECTION 0
#endif
#endif
```

**这是一种「按头文件是否存在自动开功能」的模式**：

| 条件 | 结果 |
| --- | --- |
| `RCT_DEV=1` **且** 能找到 `RCTPackagerConnection.h` | Packager 连接功能编译进去 |
| 否则 | 整个功能被 `#if ... #endif` 裁掉 |

`:47-49` 据此条件导入：

```objc
#if RCT_DEV_SETTINGS_ENABLE_PACKAGER_CONNECTION
#import <React/RCTPackagerClient.h>
#endif
```

> **这是一层「模块是否被集成进 Pod」的门控**：
> 如果宿主没有 link `RCTPackagerConnection`，这层功能自动消失。
>
> **价值**：避免了「头文件缺失导致编译失败」，用条件编译优雅降级。
> **代价**：**功能是否存在于构建中，取决于宿主 link 了什么**——
> 这是比 `RCT_DEV_MENU` 更隐蔽的一层，排查时更难发现。

### 2.3 第三层：`RCT_ENABLE_INSPECTOR`

`RCTDefines.h:69-75`：

```objc
#ifndef RCT_ENABLE_INSPECTOR
#if (RCT_DEV || RCT_REMOTE_PROFILE)
#define RCT_ENABLE_INSPECTOR 1
#else
#define RCT_ENABLE_INSPECTOR 0
#endif
#endif
```

**注意它是 `RCT_DEV`（不是 `RCT_DEV_MENU`）**，
即**即使关闭 DevMenu，只要 `RCT_DEV=1`，inspector 仍然开启**。
[27 文档 §2.1](./27-iOS帧驱动与性能监控.md) 已指出 `RCTPerfMonitor` 依赖它。

`RCTDevMenu.mm:22-24` 据此条件导入：

```objc
#if RCT_ENABLE_INSPECTOR
#import <React/RCTInspectorDevServerHelper.h>
#endif
```

而 `_menuItemsToPresent` 里「Open DevTools」菜单项
（`RCTDevMenu.mm:315-336`）也在同一条件下才加入。

### 2.4 第四层：`TARGET_OS_SIMULATOR || TARGET_OS_MACCATALYST`

**本轮首次出现的平台维度门控。** `RCTDevMenu.mm:158-189`：

```objc
- (void)registerHotkeys
{
#if TARGET_OS_SIMULATOR || TARGET_OS_MACCATALYST
  RCTKeyCommands *commands = [RCTKeyCommands sharedInstance];
  __weak __typeof__(self) weakSelf = self;

  // Toggle debug menu
  [commands registerKeyCommandWithInput:@"d"
                          modifierFlags:UIKeyModifierCommand
                                 action:^(__unused UIKeyCommand *command) {
                                   [weakSelf toggle];
                                 }];

  // Toggle element inspector
  [commands registerKeyCommandWithInput:@"i"
                          modifierFlags:UIKeyModifierCommand
                                 action:^(__unused UIKeyCommand *command) {
                                   [(RCTDevSettings *)[weakSelf.moduleRegistry moduleForName:"DevSettings"]
                                       toggleElementInspector];
                                 }];
#endif
}
```

| 方法 | 模拟器/Mac Catalyst | 真机 |
| --- | --- | --- |
| `registerHotkeys` | 注册 `Cmd+D` / `Cmd+I` | **完全不执行** |
| `unregisterHotkeys` | 注销 | 不执行 |
| `isHotkeysRegistered` | 真实检查 | 返回 `NO` |
| `isReloadCommandRegistered` | 真实检查 | 返回 `NO` |

**即：`Cmd+D` / `Cmd+I` 这两个快捷键在真机 iOS 上根本不存在。**

> **这是正确的设计**（真机没键盘），但**没有任何注释说明**
> ——与 [26 文档 I-4](./26-iOS-Base余部网络图像与快捷键.md)
> 「注释声称有 escape 例外但代码没有」是反向情况：
> **这里代码正确但缺注释**。

---

## 3. 生产包的远程调试通道

### 3.1 `RCT_REMOTE_PROFILE` 的定义链

`RCTDefines.h:54-61`：

```objc
#ifndef RCT_REMOTE_PROFILE
#ifdef REACT_NATIVE_DEBUGGER_MODE_PROD
#define RCT_REMOTE_PROFILE REACT_NATIVE_DEBUGGER_MODE_PROD
#else
#define RCT_REMOTE_PROFILE RCT_DEV
#endif
#endif
```

**即 `RCT_REMOTE_PROFILE` 可以独立于 `RCT_DEV` 为真** ——
这在 [22 文档 §5.1](./22-iOS崩溃UI层RedBox与LogBox.md)
讨论 `RCT_DEV_MENU` 可独立覆盖时**没有展开**，
因为 `RCT_REMOTE_PROFILE` 的存在使得「`RCT_DEV=0` 但 Dev 能力开启」成为可能。

### 3.2 `REACT_NATIVE_DEBUGGER_MODE_PROD` 由宿主手动开启

~~~bash
$ grep -rn "REACT_NATIVE_DEBUGGER_MODE_PROD" packages/ scripts/ | grep -v "React/Base/RCTDefines.h"
packages/react-native/ReactCommon/jsinspector-modern/InspectorFlags.cpp:75:#if defined(REACT_NATIVE_DEBUGGER_MODE_PROD)
~~~

**构建脚本里零定义** —— 只能由宿主在 Podfile / xcconfig 里自行传。

`InspectorFlags.cpp:74-78` 的消费方式：

```cpp
      .isProfilingBuild =
#if defined(REACT_NATIVE_DEBUGGER_MODE_PROD)
          true,
#else
          false,
#endif
```

**它把 inspector 标记为「profiling build」**，
而 [23 文档 §5.2](./23-iOS基础工具层ConvertAssertLogUtils.md) 的
`#if RCT_ENABLE_INSPECTOR`（= `RCT_DEV || RCT_REMOTE_PROFILE`）
会随之在 Release 包里**打开 inspector 通道**。

### 3.3 三路分支的优先级不对称

`RCTDevSettings.mm:631-640`：

```objc
- (RCTDevSettings *)devSettings
{
#if RCT_REMOTE_PROFILE
  return [self moduleForClass:[RCTDevSettings class]];
#elif RCT_DEV_MENU
  return devSettingsMenuEnabled ? [self moduleForClass:[RCTDevSettings class]] : nil;
#else
  return nil;
#endif
}
```

（`RCTBridgeProxy` 的同名方法在 `:646-655` 完全相同）

| 分支优先级 | 条件 | 行为 |
| --- | --- | --- |
| **1** | `RCT_REMOTE_PROFILE` | **无条件返回 DevSettings**，忽略 `devSettingsMenuEnabled` |
| 2 | `RCT_DEV_MENU` | 受 `devSettingsMenuEnabled` 开关控制 |
| 3 | 都不满足 | 返回 `nil` |

**关键不对称**：`RCT_DEV_SETTINGS_ENABLE_PACKAGER_CONNECTION`
（§2.2）用的是 `RCT_DEV`，而这里用的是 `RCT_DEV_MENU`。
两个宏本来就可以独立取值（[22 文档 §5.1](./22-iOS崩溃UI层RedBox与LogBox.md)），
于是出现组合：`RCT_DEV=1, RCT_DEV_MENU=0` 时
**packager 连接编译进去了，但 `devSettings` 返回 nil**。

---

## 4. 第五个零调用 setter

[23 文档 §4.5](./23-iOS基础工具层ConvertAssertLogUtils.md) 记录了
四个 handler 安装函数全仓库零调用。本轮发现第五个同类。

`RCTDevSettings.mm:55-64`：

```objc
#if RCT_DEV
static BOOL devSettingsMenuEnabled = YES;
#else
static BOOL devSettingsMenuEnabled = NO;
#endif

void RCTDevSettingsSetEnabled(BOOL enabled)
{
  devSettingsMenuEnabled = enabled;
}
```

~~~bash
$ grep -rn "RCTDevSettingsSetEnabled" packages/ --include="*.m" --include="*.mm" --include="*.h"
packages/react-native/React/CoreModules/RCTDevSettings.mm:61:void RCTDevSettingsSetEnabled(BOOL enabled)
packages/react-native/React/CoreModules/RCTDevSettings.h:160:RCT_EXTERN void RCTDevSettingsSetEnabled(BOOL enabled);
~~~

**只有定义与声明，零调用。**

| `RCT_DEV` | 默认值 | 实际可达的取值 |
| --- | --- | --- |
| 1 | `YES` | 只能是 `YES`（除非宿主调 `RCTDevSettingsSetEnabled`） |
| 0 | `NO` | 只能是 `NO` |

**且如 §3.3 所示，`RCT_REMOTE_PROFILE` 分支根本不看这个变量。**

> **与 23 文档四例的共同特征**：
> 这类 setter 都是「公开头文件里声明、给宿主用的 API」，
> **RN 自己从不调用**。
> 机制存在但默认行为由编译期宏决定，
> 宿主若不主动调用就**只能拿到默认值**。
>
> **累计清单**（截至本文）：

| # | 函数 | 位置 |
| --- | --- | --- |
| 1 | `RCTSetAssertFunction` | `React/Base/RCTAssert.m:36` |
| 2 | `RCTAddAssertFunction` | `React/Base/RCTAssert.m:46` |
| 3 | `RCTSetFatalHandler` | `React/Base/RCTAssert.m:155` |
| 4 | `RCTSetFatalExceptionHandler` | `React/Base/RCTAssert.m:225` |
| 5 | **`RCTRedBoxSetEnabled`** | `React/Base/RCTRedBoxSetEnabled.m:16`（22 文档） |
| 6 | **`RCTDevSettingsSetEnabled`** | `CoreModules/RCTDevSettings.mm:61`（本文） |

---

## 5. 【性能】`showOnShake` 每次摇动都做全树字符串渲染

`RCTDevMenu.mm:234-249`：

```objc
- (void)showOnShake
{
  if ([((RCTDevSettings *)[_moduleRegistry moduleForName:@"DevSettings"]) isShakeToShowDevMenuEnabled]) {
    NSMutableArray<UIWindow *> *windows = [NSMutableArray new];
    for (UIWindowScene *scene in RCTSharedApplication().connectedScenes) {
      [windows addObjectsFromArray:scene.windows];
    }
    for (UIWindow *window in windows) {
      NSString *recursiveDescription = [window valueForKey:@"recursiveDescription"];
      if ([recursiveDescription containsString:@"RCTView"]) {
        [self show];
        return;
      }
    }
  }
}
```

### 5.1 代价分析

| 步骤 | 代价 |
| --- | --- |
| `[window valueForKey:@"recursiveDescription"]` | **UIKit 私有 API，递归遍历整棵视图树并生成完整文本描述** |
| `[recursiveDescription containsString:@"RCTView"]` | 对可能几十 KB 的字符串做子串搜索 |
| 每个 window 一次 | 多 scene 时重复 |

**触发点**是 `UIWindow` category 里的 motion 事件（`:53-62`），
也就是**每次设备摇动都会执行**（若 `shakeToShow` 开启）。

> **意图**：判断「当前屏幕上是否有 RN 视图」——
> 若只有原生界面（如登录页）则不弹 Dev 菜单。
>
> **这是一个合理意图，但用了极重的手段**。
> 更轻的做法是遍历 `window.rootViewController` 的 view 层级查 `reactTag`
> （[26 文档](./26-iOS-Base余部网络图像与快捷键.md) 里
> `RCTTouchHandler:96` 就是用 `targetView.reactTag` 做的）。

### 5.2 该 category 的 swizzle

`RCTDevMenu.mm:53-62`：

```objc
@implementation UIWindow (RCTDevMenu)

- (void)RCT_motionEnded:(__unused UIEventSubtype)motion withEvent:(UIEvent *)event
{
  [[NSNotificationCenter defaultCenter] postNotificationName:RCTShowDevMenuNotification object:nil];
}
```

`:129-135` 的注册处给了理由：

```objc
+ (void)initialize
{
  // We're swizzling here because it's poor form to override methods in a category,
  // however UIWindow doesn't actually implement motionEnded:withEvent:, so there's
  // no need to call the original implementation.
  RCTSwapInstanceMethods([UIWindow class], @selector(motionEnded:withEvent:), @selector(RCT_motionEnded:withEvent:));
}
```

**注释解释了为何不需要调原实现** —— 这比 [26 文档 I-5](./26-iOS-Base余部网络图像与快捷键.md)
的混淆 selector 诚实得多。

但 `:129` 在 `@implementation RCTDevMenu`（`:113`）里，
而 category 在 `:53` —— 即 **`+initialize` 挂在 `RCTDevMenu` 类上，
swizzle 的却是 `UIWindow`**。

> **顺序风险**：`+initialize` 在首次向 `RCTDevMenu` 发消息时触发，
> 而不是类加载时。所以**摇动事件早于 DevMenu 模块初始化的话，swizzle 尚未生效**。
> 不过 `:145-148` 的通知注册也在 `init` 里，两者时机一致。

---

## 6. `RCTDevLoadingView`：`#if !RCT_DEV` 的反向门控

`RCTDevLoadingView.mm:335-349`：

```objc
- (void)showWithURL:(NSURL *)URL
{
  if (URL.fileURL) {
    // If dev mode is not enabled, we don't want to show this kind of notification.
#if !RCT_DEV
    return;
#endif
    [self showOfflineMessage];
  } else {
    [self showInitialMessageDelayed:^{
      NSString *message = [NSString stringWithFormat:@"Loading from %@\u2026", RCT_PACKAGER_NAME];
      [self showProgressMessage:message];
    }];
  }
}
```

### 6.1 两种 URL 的不同待遇

| URL 类型 | `RCT_DEV=1` | `RCT_DEV=0`（但 `RCT_DEV_MENU=1`） |
| --- | --- | --- |
| **本地文件**（`URL.fileURL`） | 显示「离线」提示 | **直接 return，什么都不显示** |
| **远程**（Metro dev server） | 显示「Loading from Metro…」 | 显示加载进度 |

**即 `RCT_DEV=0` + `RCT_DEV_MENU=1` 的组合下，
本地 bundle 加载期间既无原生提示也无 JS 提示** —— 又一个门控错配场景
（与 [22 文档 §5.1](./22-iOS崩溃UI层RedBox与LogBox.md) 的
`RCT_DEV=1` + `RCT_DEV_MENU=0` 恰好相反，但成因同源）。

### 6.2 与 05 文档结论的印证

[05 文档](./05-监控检测原理与流程.md) 记有一条白屏成因：

> **`loadingView` 无默认值** —— 未注入时 `_activityIndicatorView` 为 nil，
> `intrinsicContentSize` 返回 `CGSizeZero` → **真白屏**。框架不提供默认 spinner。

**本文补上了另一半**：`RCTDevLoadingView` 这个**原生**兜底横幅
本身也受门控，且在 §6.1 的组合下会完全不出现。

注入方在 `RCTInstance.mm:492-496`（受 `RCT_DEV_MENU && __has_include(...)` 约束）——
**这已经是 `__has_include` 门控的第二次出现**（第一次是 §2.2）。

---

## 7. `RCTDevSettings` 的 else 支：Release 下的空实现

`RCTDevSettings.mm:555-575`：

```objc
#else // #if RCT_DEV_MENU || RCT_REMOTE_PROFILE

@interface RCTDevSettings () <NativeDevSettingsSpec>
@end

@implementation RCTDevSettings

- (instancetype)initWithDataSource:(id<RCTDevSettingsDataSource>)dataSource
{
  return [super init];
}
- (void)initialize
{
}
- (BOOL)isHotLoadingAvailable
{
  return NO;
}
+ (BOOL)requiresMainQueueSetup
{
  return NO;
```

**与 [22 文档 §2](./22-iOS崩溃UI层RedBox与LogBox.md) 的 `RCTRedBox` else 支完全同型**：
接口签名齐全、方法体全空、`isHotLoadingAvailable` 硬编码 `NO`。

差异在于**门控宏不同**：
`RCTRedBox` 是 `#if RCT_DEV_MENU`，`RCTDevSettings` 是
`#if RCT_DEV_MENU || RCT_REMOTE_PROFILE` —— **后者多了一个开启通道**（§3）。

---

## 8. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| D-1 | **`showOnShake` 每次摇动都对整棵视图树做 `recursiveDescription` 渲染** | `CoreModules/RCTDevMenu.mm:242` | 私有 API + 大字符串生成 + 子串搜索；深层视图树时明显卡顿 |
| D-2 | **`RCTDevSettingsSetEnabled` 零调用**（第五个同类 setter） | `CoreModules/RCTDevSettings.mm:61` | `devSettingsMenuEnabled` 只能取编译期默认值；且 `RCT_REMOTE_PROFILE` 分支根本不读它 |
| D-3 | **`REACT_NATIVE_DEBUGGER_MODE_PROD` 可让 Release 包开启 inspector**，构建脚本零定义 | `React/Base/RCTDefines.h:55`、`InspectorFlags.cpp:75` | 生产调试通道，需宿主手动开启；**是能力也��风险** |
| D-4 | `RCT_DEV_SETTINGS_ENABLE_PACKAGER_CONNECTION` 用 `RCT_DEV`，而 `devSettings` 用 `RCT_DEV_MENU` | `RCTDevSettings.mm:40` vs `:635` | `RCT_DEV=1, RCT_DEV_MENU=0` 时功能编译进去但入口返回 nil |
| D-5 | **`RCT_DEV=0` + `RCT_DEV_MENU=1` 时本地 bundle 加载无任何提示** | `RCTDevLoadingView.mm:339-341` | 与 22 文档 §5.1 的错配方向相反、成因同源；白屏期无兜底 |
| D-6 | 快捷键只在模拟器/Mac Catalyst 注册，**无注释说明** | `RCTDevMenu.mm:160, 183, 193, 205, 215` | 真机上 `Cmd+D`/`Cmd+I` 不存在且无文档；与 26 文档 I-4（注释有、代码无）反向 |
| D-7 | `RCTDevSettings` 的 else 支方法全空、`isHotLoadingAvailable` 硬编码 `NO` | `RCTDevSettings.mm:555-575` | 与 22 文档同型；但门控多一个 `RCT_REMOTE_PROFILE` 通道 |
| D-8 | `+initialize` 挂在 `RCTDevMenu` 上但 swizzle 的是 `UIWindow` | `RCTDevMenu.mm:53, 129` | swizzle 时机依赖 DevMenu 模块初始化，非类加载 |
| D-9 | `__has_include` 门控使功能存在性取决于宿主 link 了什么 | `RCTDevSettings.mm:39-45`、`RCTInstance.mm:492` | 排查「功能消失」时极难定位；本轮已见两处 |

### D-3 的双面性（必须写清）

**能力**：线上包可连 DevTools 定位问题，不必复现到 Debug 包。

**风险**：

| 风险 | 依据 |
| --- | --- |
| inspector 通道在生产包开启 | `RCTDefines.h:70` 的 `RCT_ENABLE_INSPECTOR = (RCT_DEV \|\| RCT_REMOTE_PROFILE)` |
| CDP 调试连接可连上 | `InspectorFlags.cpp:74-78` 把 `isProfilingBuild` 置 `true` |
| DevSettings 模块可用 | `RCTDevSettings.mm:633-634` 的 `#if RCT_REMOTE_PROFILE` 分支无条件返回 |

**且 `RCT_REMOTE_PROFILE` 优先于 `RCT_DEV_MENU`（§3.3）** ——
一旦开启，`devSettingsMenuEnabled` 这个运行期开关**失效**。

---

## 9. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 22 文档：`#if RCT_DEV_MENU` 门控与错配 | **新增三种门控模式**：`__has_include` 探测、`TARGET_OS_SIMULATOR`、`RCT_REMOTE_PROFILE`（§2） |
| 22 文档：门控矩阵只有 2 行 | **扩充为多维**：`RCT_DEV` × `RCT_DEV_MENU` × `RCT_REMOTE_PROFILE` × `RCT_ENABLE_INSPECTOR` 相互独立（§3.3） |
| 23 文档：四个零调用 setter | **新增第五个**：`RCTDevSettingsSetEnabled`（§4），并给出累计清单 |
| 25 文档 / 26 文档：注释与代码不符 | **反向对照**：这里代码正确但缺注释（D-6） |
| 05 文档：`loadingView` 无默认值 → 真白屏 | **补上另一半**：`RCTDevLoadingView` 原生横幅本身也受门控（D-5） |
| 24 文档 / 25 文档：类存在实现空 | **新增同型实例**：`RCTDevSettings` else 支（D-7） |
| 26 文档 I-5：混淆私有 selector 规避扫描 | **正面对照**：`RCTDevMenu` 的 swizzle 明确解释了为何无需调原实现（§5.2） |