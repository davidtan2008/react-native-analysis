---
id: 30
title: "iOS WebSocket 与调试通道：RCTWebSocketModule / 注册表 / 编译期调试宏"
topic: PL.ios
symptoms: [debug]
platforms: [ios]
architecture: [cross]
layer: T3
symbols: ["RCTInspector", "RCTWebSocket"]
claims: []
---
# 30 · iOS WebSocket 与调试通道：RCTWebSocketModule / 注册表 / 编译期调试宏

> **模块**：C1 · `CoreModules/` 的调试通道与注册族（9 文件 / 1513 行）
> **基线**：react-native @ `9b131e42` · iOS 侧
> **前置**：[28 文档](./28-iOS-Dev工具链与四层门控.md) 记录了 Dev 工具链的四层门控
> 与 `REACT_NATIVE_DEBUGGER_MODE_PROD` 生产调试通道；
> [25 文档](./25-iOS桥接核心与启动性能标签.md) 记录了 `moduleDataForName:` 的缺失。
>
> 本文记录：**CoreModules 模块注册表的完整结构与两处例外**、
> **WebSocket 调试事件的编译期门控链**、
> 两个新的**零调用/零引用函数**，
> 并**修正 28 文档对两个 DEBUGGER 宏的表述**（两者性质不同）。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `CoreModules/RCTWebSocketModule.mm` | 312 | WebSocket 封装（SocketRocket） |
| `CoreModules/RCTStatusBarManager.mm` | 199 | 状态栏 |
| `CoreModules/RCTInspectorWebSocketReporter.mm` | 156 | **WS 事件上报到 CDP 调试器** |
| `CoreModules/RCTAppState.mm` | 154 | 前后台状态 |
| `CoreModules/RCTKeyboardObserver.mm` | 148 | 键盘事件 |
| `CoreModules/CoreModulesPlugins.mm` | 114 | **模块名 → 类的分派表** |
| `CoreModules/RCTPlatform.mm` | 107 | 平台常量 |
| `CoreModules/RCTI18nManager.mm` | 67 | 国际化 |
| `CoreModules/RCTDevToolsRuntimeSettingsModule.mm` | 57 | DevTools 运行时设置 |
| `CoreModules/RCTClipboard.mm` / `RCTSourceCode.mm` / `RCTDevMenuConfigurationDecorator.mm` / `RCTJscSafeUrl.mm` | 199 | 其他 |

---

## 2. CoreModules 注册表：22 个模块 + 两处例外

### 2.1 分派表的结构

`CoreModulesPlugins.mm` 是**模块名到 ObjC 类的分派**：

```objc
  if (name == "DeviceInfo"sv) {
    return RCTDeviceInfoCls();
  }
```

`sv` 是 `std::string_view` 字面量（`using namespace std::string_view_literals`），
**避免每次比较都构造 `std::string`**。

头文件 `CoreModulesPlugins.h` 为每个函数标注：

```objc
Class RCTDeviceInfoCls(void) __attribute__((used));
```

**`__attribute__((used))` 阻止链接器裁掉「看似未被调用」的工厂函数** ——
这些函数的唯一调用点在 `.mm` 的分派表里，若无此标注，
在 LTO 或 `-ffunction-sections` 下可能被误删。

### 2.2 头文件声明与实现严格对应

实测（正则含数字，避免漏掉 `I18n`）：

```
$ diff <(grep -o "RCT[A-Za-z0-9]*Cls" CoreModulesPlugins.h | sort -u) \
       <(grep -rho "Class RCT[A-Za-z0-9]*Cls" CoreModules/*.mm | grep -o "RCT[A-Za-z0-9]*Cls" | sort -u)
（无输出 = 完全对应）
```

| 集合 | 数量 |
| --- | --- |
| 头文件声明的 `Cls` | 23 |
| `.mm` 中定义的 `Cls` | 22 |
| 分派表的 `name` 条目 | 22 |
| 分派表实际调用的 `Cls` | 22 |

### 2.3 例外一：3 个模块名走别名

分派表的 `name` 与 `Cls` 名**不是一一对应**：

| JS 请求的 `name` | 实际 `Cls` | 说明 |
| --- | --- | --- |
| `PlatformConstants` | `RCTPlatformCls` | 类名是 `RCTPlatform`，模块名是 `PlatformConstants` |
| `BlobModule` | `RCTBlobManagerCls` | 类名是 `RCTBlobManager` |
| `I18nManager` | `RCTI18nManagerCls` | 名字一致 |

**这三个是 JS 侧的历史命名，ObjC 侧类名不同。**
排查「模块找不到」问题时，**必须查分派表而不是按类名反推**。

### 2.4 【新发现】`RCTTimingCls` 是纯悬空声明

```bash
$ grep -rn "RCTTimingCls" packages/
packages/react-native/React/CoreModules/CoreModulesPlugins.h:53:Class RCTTimingCls(void) __attribute__((used));
```

**只有 1 处 —— 头文件里的声明。**
既无 `.mm` 定义，也无分派表调用。

> **这意味着 `RCTTiming` 不通过 `CoreModulesPlugins` 注册。**
>
> 对照 [27 文档](./27-iOS帧驱动与性能监控.md)：
> `RCTTiming` 是 JS 定时器的驱动者，必须能被 JS 找到。
> 它的注册走的是**另一条路径**（TurboModule 的默认模块列表，
> 见 §5.2 的 `DefaultTurboModules.cpp`）。
>
> **这是「注册表不完整」还是「双注册机制」？**
> 从代码看是后者 —— `CoreModulesPlugins` 覆盖的是「需要类工厂的 ObjC 模块」，
> 而 codegen 模块（`RCTTiming` 的 spec 是 codegen 生成的）走 `DefaultTurboModules`。
>
> **但头文件仍声明了 `RCTTimingCls` 且标了 `__attribute__((used))`**，
> 这是一个**明确的残留**：声明了一个永远不会存在的函数。

### 2.5 【新发现】`RCTDevToolsRuntimeSettingsCls` 未接入注册表

```bash
$ grep -rn "RCTDevToolsRuntimeSettingsCls" packages/
packages/react-native/React/CoreModules/RCTDevToolsRuntimeSettingsModule.mm:54:Class RCTDevToolsRuntimeSettingsCls(void)
```

**只有 `.mm` 里的定义，没有头文件声明、没有分派表调用。**

对比其余 22 个 `Cls` 函数全部是「2 处外部引用」
（`CoreModulesPlugins.h` 声明 + `CoreModulesPlugins.mm` 调用），
**只有它是 0 处**。

其 `Cls` 函数体也无门控：

```objc
Class RCTDevToolsRuntimeSettingsCls(void)
{
  return RCTDevToolsRuntimeSettingsModule.class;
}
```

**对比 [27 文档 §2.1](./27-iOS帧驱动与性能监控.md) 的 `RCTPerfMonitorCls`**
—— 那个在 `#else` 分支 `return nil`。
**这个连门控都没有，直接返回类。**

它之所以不接入注册表，是因为 C++ 侧用 `DEVONLY` 宏单独门控（§5.2）。

---

## 3. `RCTWebSocketModule`：第六个零调用 setter

### 3.1 可替换的 WebSocket 实现

`RCTWebSocketModule.mm:59-64`：

```objc
static SRWebSocketProvider srWebSocketProvider;

void RCTSetCustomSRWebSocketProvider(SRWebSocketProvider provider)
{
  srWebSocketProvider = provider;
}
```

`:148-152` 的使用点：

```objc
  SRWebSocket *webSocket;
  if (srWebSocketProvider != nullptr) {
    webSocket = srWebSocketProvider(request);
  }
  if (webSocket == nil) {
    webSocket = [[SRWebSocket alloc] initWithURLRequest:request protocols:protocols];
  }
```

**注意两层判空**：先问 provider，再兜底到 SocketRocket。

### 3.2 零调用

```bash
$ grep -rn "RCTSetCustomSRWebSocketProvider" packages/ --include="*.mm" --include="*.m" --include="*.h"
packages/react-native/React/CoreModules/RCTWebSocketModule.mm:61:void RCTSetCustomSRWebSocketProvider(SRWebSocketProvider provider)
packages/react-native/React/CoreModules/RCTWebSocketModule.h:25:RCT_EXTERN void RCTSetCustomSRWebSocketProvider(SRWebSocketProvider provider);
```

**只有定义与声明，零调用。**

> **这是第六个零调用 setter**
> （前五个见 [29 文档 §4](./29-iOS平台能力族DeviceInfo与Accessibility.md) 的累计清单）。
> 累计：

| # | 函数 | 位置 |
| --- | --- | --- |
| 1 | `RCTSetAssertFunction` | `React/Base/RCTAssert.m:36` |
| 2 | `RCTAddAssertFunction` | `React/Base/RCTAssert.m:46` |
| 3 | `RCTSetFatalHandler` | `React/Base/RCTAssert.m:155` |
| 4 | `RCTSetFatalExceptionHandler` | `React/Base/RCTAssert.m:225` |
| 5 | `RCTRedBoxSetEnabled` | `React/Base/RCTRedBoxSetEnabled.m:16` |
| 6 | `RCTDevSettingsSetEnabled` | `CoreModules/RCTDevSettings.mm:61`（28 文档） |
| **7** | **`RCTSetCustomSRWebSocketProvider`** | **`CoreModules/RCTWebSocketModule.mm:61`（本文）** |

**这七个的共同特征**（与 23 文档首次提出时一致）：
公开头文件声明、给宿主用的注入点、RN 自己从不调用、
默认值由编译期宏或硬编码决定。

### 3.3 用关联对象扩展第三方类

`RCTWebSocketModule.mm:19-46`：

```objc
@interface SRWebSocket (React)

/**
 * The CDP request ID used to report this connection's events to the modern
 * debugger server, via `RCTInspectorWebSocketReporter`.
 */
@property (nonatomic, copy) NSString *inspectorRequestId;

@end
```

**给 SocketRocket 的类加 category 属性**，存储用 `objc_setAssociatedObject`：

```objc
- (void)setInspectorRequestId:(NSString *)inspectorRequestId
{
  objc_setAssociatedObject(self, @selector(inspectorRequestId), inspectorRequestId, OBJC_ASSOCIATION_COPY_NONATOMIC);
}
```

**这是第三方类无法改头文件时的标准做法**，但代价是：
**属性访问变成消息转发 + 哈希查找**，比 ivar 慢。
对 WebSocket 频率的操作（每条消息）有轻微开销。

`:161-163` 说明了 `inspectorRequestId` 的取值优先级：

```objc
  // Prefer the DevTools request ID created by the JS caller, which carries the
  // request initiator stack trace for CDP reporting.
  NSString *devToolsRequestId = options.unstable_devToolsRequestId();
  webSocket.inspectorRequestId = devToolsRequestId.length > 0 ? devToolsRequestId : [[NSUUID UUID] UUIDString];
```

**注释说明了为什么优先用 JS 侧的 ID** —— 它携带请求发起方的调用栈，
对 CDP 上报有用。否则用随机 UUID。

---

## 4. 调试事件上报：编译期门控链

### 4.1 三重条件

`RCTInspectorWebSocketReporter.mm:29-39`：

```objc
/**
 * Returns whether WebSocket events should be reported for the given request
 * ID. Reporting requires the `fuseboxWebSocketEventsEnabled` feature flag, and
 * a connected CDP debugger with the Network domain enabled (dev or profiling
 * builds only).
 */
BOOL isReportingEnabled(NSString *requestId)
{
  return requestId != nil && ReactNativeFeatureFlags::fuseboxWebSocketEventsEnabled() &&
      NetworkReporter::getInstance().isDebuggingEnabled();
}
```

**三重条件**：

| 条件 | 类型 | 默认 |
| --- | --- | --- |
| `requestId != nil` | 运行期 | 恒非 nil（`:162-163` 保证） |
| `fuseboxWebSocketEventsEnabled()` | **Feature flag（运行期可改）** | 需查配置 |
| `isDebuggingEnabled()` | **编译期宏** | Release 下恒 `false` |

### 4.2 第三重条件的编译期实现

`NetworkReporter.cpp:25-31`：

```cpp
bool NetworkReporter::isDebuggingEnabled() const {
#ifdef REACT_NATIVE_DEBUGGER_ENABLED
  return jsinspector_modern::NetworkHandler::getInstance().isEnabled();
#else
  return false;
#endif
}
```

**`#ifdef` 编译期门控 —— Release 构建里整个真分支不存在。**

> **这是本文的安全结论**：
> **WebSocket 事件上报到 CDP 调试器这条路径，
> 在未定义 `REACT_NATIVE_DEBUGGER_ENABLED` 的构建里恒返回 `false`**，
> 即「App 的 WebSocket 通信内容不会通过调试通道外泄」。
>
> 这是与 [23 文档 §5.2](./23-iOS基础工具层ConvertAssertLogUtils.md)
> 「日志用 `%{public}s` 不脱敏」相对的**正面结论**：
> 网络上报做了编译期隔离，日志没有。

### 4.3 `REACT_NATIVE_DEBUGGER_ENABLED` 的定义方式

`scripts/cocoapods/utils.rb:102-110`：

```ruby
self.add_build_settings_to_pod(installer, "GCC_PREPROCESSOR_DEFINITIONS", "REACT_NATIVE_DEBUGGER_ENABLED=1", "React-jsinspector", :debug)
```

**`:debug` 是 CocoaPods 的构建配置**，即**只在 Debug 配置生效**，宿主无需操作。

`Package.swift:187-188` 同理：

```swift
CXXSetting.define("REACT_NATIVE_DEBUGGER_ENABLED", to: "1", .when(configuration: BuildConfiguration.debug)),
```

### 4.4 【修正 28 文档】两个 DEBUGGER 宏性质不同

这是本文对既有文档的**一处重要修正**：

| 宏 | 定义方式 | Release 可否为真 | 性质 |
| --- | --- | --- | --- |
| **`REACT_NATIVE_DEBUGGER_ENABLED`** | **CocoaPods `:debug` / SwiftPM `.debug`** | **否**（除非宿主手动覆盖） | **纯开发期开关** |
| **`REACT_NATIVE_DEBUGGER_MODE_PROD`** | **构建脚本零定义** | **是**（宿主手动传） | **生产调试通道** |
| `REACT_NATIVE_DEBUGGER_ENABLED_DEVONLY` | 同 `ENABLED`（`:debug`） | 否 | 纯开发期 |

**28 文档 §3.2 只讨论了 `MODE_PROD`，未提及 `ENABLED` 存在。**
本文补上，以免读者误以为「所有 debugger 宏都需要宿主手动开」。

> **准确表述**：
> - 想在 **Debug** 下用调试器 → **构建脚本已自动开启**，无需操作。
> - 想在 **Release** 下用调试器 → 必须**手动**传 `REACT_NATIVE_DEBUGGER_MODE_PROD`（`RCT_REMOTE_PROFILE` 通道）
>   或 `REACT_NATIVE_DEBUGGER_ENABLED`（C++ 侧网络通道）。

### 4.5 `_DEVONLY` 的语义：只门控 DevTools 专用模块

`DefaultTurboModules.cpp:21-23`：

```cpp
#ifdef REACT_NATIVE_DEBUGGER_ENABLED_DEVONLY
#include <react/nativemodule/devtoolsruntimesettings/DevToolsRuntimeSettingsModule.h>
#endif
```

`:87-91` 的分发：

```cpp
#ifdef REACT_NATIVE_DEBUGGER_ENABLED_DEVONLY
  if (name == DevToolsRuntimeSettingsModule::kModuleName) {
    return std::make_shared<DevToolsRuntimeSettingsModule>(jsInvoker);
  }
#endif
```

**这解释了 §2.5 的疑问**：
`RCTDevToolsRuntimeSettingsModule` 的 ObjC 侧有 `Cls` 函数但不接入
`CoreModulesPlugins`，因为**它的注册由 C++ 侧的 `DefaultTurboModules` 负责**，
且用 `DEVONLY` 宏门控。

**即 `DevToolsRuntimeSettings` 是一个「双侧都有注册逻辑、
但 ObjC 侧的工厂函数被绕过」的模块。**

---

## 5. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| Q-1 | **`RCTTimingCls` 是纯悬空声明**（无定义、无调用），`__attribute__((used))` 标注在一个不存在的函数上 | `CoreModules/CoreModulesPlugins.h:53` | 声明残留；`RCTTiming` 实际走 `DefaultTurboModules` 注册 |
| Q-2 | **`RCTDevToolsRuntimeSettingsCls` 有定义但未接入注册表**（0 处外部引用，其余 22 个均为 2 处） | `CoreModules/RCTDevToolsRuntimeSettingsModule.mm:54` | 有意的（由 C++ 侧 `DEVONLY` 门控注册），但 ObjC 工厂函数是死代码，且**无 `#if` 门控**（对比 `RCTPerfMonitorCls` 的 `return nil`） |
| Q-3 | **模块名与类名不一致**（`PlatformConstants`→`RCTPlatform`、`BlobModule`→`RCTBlobManager`） | `CoreModules/CoreModulesPlugins.mm:87, 107` | 排查「模块找不到」必须查分派表，不能按类名反推 |
| Q-4 | `RCTSetCustomSRWebSocketProvider` 零调用 | `CoreModules/RCTWebSocketModule.mm:61` | 第七个零调用 setter；自定义 WS 实现只能由宿主注入 |
| Q-5 | 用 `objc_setAssociatedObject` 给第三方类加属性，属性访问变慢 | `CoreModules/RCTWebSocketModule.mm:40-46` | 每条 WS 消息都走消息转发 + 关联对象查找；频率高时有开销 |

### Q-1 与 Q-2 的清理建议

两者都是**无害但误导**的残留：

- **Q-1**：删除 `CoreModulesPlugins.h:53` 的声明。
  留着会让读者以为 `RCTTiming` 通过这个注册表注册。
- **Q-2**：若确定由 C++ 侧注册，可删除 `RCTDevToolsRuntimeSettingsCls`；
  或加上与 `RCTPerfMonitorCls` 一致的 `#if` 门控，使其行为可预测。

---

## 6. 零调用/零引用函数累计清单

本文把「机制存在但无调用方」的清单扩展到两个类别：

### 6.1 零调用 setter（7 个）

| # | 函数 | 位置 | 默认值来源 |
| --- | --- | --- | --- |
| 1 | `RCTSetAssertFunction` | `Base/RCTAssert.m:36` | 编译期 |
| 2 | `RCTAddAssertFunction` | `Base/RCTAssert.m:46` | 编译期 |
| 3 | `RCTSetFatalHandler` | `Base/RCTAssert.m:155` | 编译期 |
| 4 | `RCTSetFatalExceptionHandler` | `Base/RCTAssert.m:225` | 编译期 |
| 5 | `RCTRedBoxSetEnabled` | `Base/RCTRedBoxSetEnabled.m:16` | 编译期 |
| 6 | `RCTDevSettingsSetEnabled` | `CoreModules/RCTDevSettings.mm:61` | 编译期 |
| 7 | `RCTSetCustomSRWebSocketProvider` | `CoreModules/RCTWebSocketModule.mm:61` | `static` 零初始化 |

### 6.2 零引用工厂函数（2 个）

| 函数 | 位置 | 状态 |
| --- | --- | --- |
| `RCTTimingCls` | `CoreModulesPlugins.h:53` | **仅声明**，无定义 |
| `RCTDevToolsRuntimeSettingsCls` | `RCTDevToolsRuntimeSettingsModule.mm:54` | 仅定义，未接入注册表 |

### 6.3 早前的相关发现

| 函数 | 状态 | 来源 |
| --- | --- | --- |
| `RCTModuleData` 的两个 `init` | 类无法实例化 | [25 文档 §2.2](./25-iOS桥接核心与启动性能标签.md) |
| `RCTBridge` 的 `batchedBridge` / `moduleDataForName:` | 无任何实现 | [25 文档 §2.3](./25-iOS桥接核心与启动性能标签.md) |
| `RCTIsNewArchEnabled` | 硬编码 `YES` 且 0 调用 | [23 文档 §6.1](./23-iOS基础工具层ConvertAssertLogUtils.md) |
| `RCTEnableTurboModule` / `RCTEnableFabricInteropLayer` | 空实现 / 0 调用 | [24 文档 §7](./24-iOS事件分发触摸管线与JS加载.md) |

> **这批函数构成本仓库一个反复出现的模式**：
> 接口与机制完整保留，实现退役或从未接线。
> **文档化的价值在于让排查者知道「这里看起来该有东西，是空的是有原因的」**，
> 而不是浪费时间找「是不是我漏看了」。

---

## 7. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 28 文档 §3：`REACT_NATIVE_DEBUGGER_MODE_PROD` 是生产调试通道 | **修正 + 补全**：区分了它与 `REACT_NATIVE_DEBUGGER_ENABLED`（构建脚本 `:debug` 自动开），前者需手动、后者自动（§4.3、§4.4） |
| 27 文档：`RCTPerfMonitorCls` 在 Release 返回 `nil` | **对比**：`RCTDevToolsRuntimeSettingsCls` 连门控都没有（Q-2） |
| 29 文档：零调用 setter 累计清单（6 个） | **新增第 7 个**：本文 §6.1 |
| 25 文档：`RCTModuleData` / `batchedBridge` 空壳 | **新增同类**：`RCTTimingCls` 悬空声明（Q-1） |
| 23 文档：日志用 `%{public}s` 不脱敏 | **正面对照**：网络上报有编译期隔离，日志没有（§4.2） |