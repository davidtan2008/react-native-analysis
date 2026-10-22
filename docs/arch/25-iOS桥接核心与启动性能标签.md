---
id: 25
title: "iOS 桥接核心与启动性能标签：legacy 的空壳化"
topic: RT.host
symptoms: [slowstart, bridge]
platforms: [ios]
architecture: [cross]
layer: T3
symbols: ["RCTCxxBridge", "RCTPerformanceLogger"]
sourceRoot: react-native
claims: []
---
# 25 · iOS 桥接核心与启动性能标签：legacy 的空壳化

> **模块**：C1 · `React/Base/` 的桥接核心族（13 文件 / 1387 行）+ 性能标签族（4 文件）
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · iOS 侧
> **前置**：[15 文档](./15-Android启动与宿主API.md) 讲了 `ReactMarkerConstants` 的 114 个枚举；
> [24 文档](./24-iOS事件分发触摸管线与JS加载.md) 记录了同批架构清理残留。
>
> 本文的核心结论：**legacy 架构的类被保留但实现已清空**，
> 且**启动性能标签 22 个里有 12 个零打点**——
> 这直接影响 [13 文档](./13-JS启动装配.md) 所述的启动耗时指标可得性。

---

## 1. 文件构成

| 文件 | 行数 | 状态 |
| --- | --- | --- |
| `React/Base/RCTBridgeModule.h` | 428 | 宏定义 + 协议 |
| `React/Base/RCTBridge.h` | 251 | 桥接接口 |
| `React/Base/RCTBridge+Private.h` | 132 | 私有接口（多数已无实现） |
| `React/Base/RCTModuleData.h` | 123 | **属性全标 deprecated，实现为空壳** |
| `React/Base/RCTModuleData.mm` | 43 | **3 个方法全空** |
| `React/Base/RCTBridgeModuleDecorator.m` | 73 | **legacy→Turbo 迁移桥（唯一活着的）** |
| `React/Base/RCTModuleRegistry.m` | 55 | 只剩 TurboModule 一条路径 |
| `React/Base/RCTCallableJSModules.m` | 35 | 协议占位 |
| `React/Base/RCTBridgeConstants.m` | 18 | 常量 |
| `React/Base/RCTBridgeMethod.h` | 38 | 方法描述 |
| `React/Base/RCTPerformanceLogger.mm` | 约 180 | 性能数据存储 |
| `React/Base/RCTPerformanceLoggerLabels.m` | 60 | 标签名映射 |
| `React/Base/RCTPLTag.h` | 31 | **22 个标签 + 1 哨兵** |
| `ReactCommon/.../RCTPerformanceLoggerUtils.mm` | 75 | **ReactMarker → 性能日志的桥** |

---

## 2. `RCTModuleData`：类还在，实现没了

`React/Base/RCTModuleData.mm` 全文只有三个方法，**全部是空实现**：

```objc
// packages/react-native/React/Base/RCTModuleData.mm:15-41
- (instancetype)initWithModuleClass:(Class)moduleClass
                             bridge:(RCTBridge *)bridge
                     moduleRegistry:(RCTModuleRegistry *)moduleRegistry
            viewRegistry_DEPRECATED:(RCTViewRegistry *)viewRegistry_DEPRECATED
                      bundleManager:(RCTBundleManager *)bundleManager
                  callableJSModules:(RCTCallableJSModules *)callableJSModules
{
  return self;
}

- (instancetype)initWithModuleInstance:(id<RCTBridgeModule>)instance
                                bridge:(RCTBridge *)bridge
                        moduleRegistry:(RCTModuleRegistry *)moduleRegistry
               viewRegistry_DEPRECATED:(RCTViewRegistry *)viewRegistry_DEPRECATED
                         bundleManager:(RCTBundleManager *)bundleManager
                     callableJSModules:(RCTCallableJSModules *)callableJSModules
{
  return self;
}

- (void)gatherConstants
{
}

- (void)invalidate
{
}
```

**六个参数全部未被使用**，`initWithModuleClass:` 直接 `return self`。

### 2.1 头文件声明了完整属性，实现里一个 ivar 都没有

`RCTModuleData.h` 声明了 11 个 `@property`（`moduleClass` / `name` / `methods` /
`methodsByName` / `exportedConstants` / `hasInstance` / `requiresMainQueueSetup` /
`hasConstantsToExport` / `instance` / `methodQueue` / `implementsBatchDidComplete`），
**每一个都带同样的 deprecation 说明**：

```objc
// packages/react-native/React/Base/RCTModuleData.h:78-79
@property (nonatomic, copy, readonly) NSDictionary<NSString *, id> *exportedConstants __deprecated_msg(
    "This API will be removed along with the legacy architecture.");
```

`.mm` 的 `@implementation` 里**没有任何 `@synthesize`、没有任何 ivar 声明**，
只有 `:20-23` 的 `initWithModuleClass:` 直接 `return self`。

> **依赖 Objective-C 的自动属性合成才能编译通过**：
> 因为 `@property` 在有 `@implementation` 的情况下会自动生成 ivar 和 getter/setter，
> getter 返回**零值**（`nil` / `0` / `NO`），setter 什么都不做。
>
> **所以这不是链接错误或崩溃，而是一个完全静默的空壳。**
> 任何调用 `moduleData.methods` 的代码都会拿到 `nil`，
> 而 `nil` 被下发标（见 §4.2）当成「走另一条路」的信号。

### 2.2 两个构造器零调用

```bash
$ grep -rn "initWithModuleClass:\|initWithModuleInstance:" packages/ --include="*.m" --include="*.mm"
packages/react-native/React/Base/RCTModuleData.mm:15:  （定义）
packages/react-native/React/Base/RCTModuleData.mm:25:  （定义）
```

**没有任何调用方。** 结合 §2.1，`RCTModuleData` **根本无法被实例化**。

### 2.3 唯一的 API 入口已无实现

`RCTBridge+Private.h:99` 声明：

```objc
/**
 * Get the module data for a given module name. Used by UIManager to implement
 * the `dispatchViewManagerCommand` method.
 */
- (RCTModuleData *)moduleDataForName:(NSString *)moduleName;
```

但 **`RCTBridge.mm` 里既没有 `moduleDataForName:` 也没有 `batchedBridge`**：

```bash
$ grep -n -A6 "batchedBridge\|moduleDataForName" packages/react-native/React/Base/RCTBridge.mm
（无输出）
```

**唯一引用它的地方**（`RCTLegacyViewManagerInteropCoordinator.mm:122`）用的是
`[_bridge.batchedBridge moduleDataForName:...]`，
而 `batchedBridge` 在 `RCTBridge` 上**不存在** → 该表达式在 bridgeless 下恒为 `nil`。

> **注意**：这不产生崩溃 —— 向 `nil` 发 `batchedBridge` 返回 `nil`，
> 再向 `nil` 发 `moduleDataForName:` 返回 `nil`，`moduleData` 恒为 `nil`。
> 这是**又一条静默降级**。

---

## 3. 死代码被搬到了 interop 层

`RCTLegacyViewManagerInteropCoordinator.mm:194-199` **明说这是复制**：

```objc
// This is copy-pasta from RCTModuleData.
- (void)_lookupModuleMethodsIfNecessary
{
  if (!_bridge && !_moduleMethods) {
    _moduleMethods = [NSMutableArray new];
    _moduleMethodsByName = [NSMutableDictionary new];
```

**即**：`RCTModuleData` 原本负责的「扫描 ViewManager 类的方法列表」逻辑，
在被清空之前**被复制到了 interop 层**，并在 `:197` 用 `!_bridge` 门控
（bridgeless 才走这条路）。

### 3.1 方法查找的双路径

`RCTLegacyViewManagerInteropCoordinator.mm:131-141`：

```objc
  if ([commandName isKindOfClass:[NSNumber class]] || [formatter numberFromString:commandName] != NULL) {
    method = moduleData ? moduleData.methods[[commandName intValue]] : _moduleMethods[[commandName intValue]];
  } else if ([commandName isKindOfClass:[NSString class]]) {
    method = moduleData ? moduleData.methodsByName[commandName] : _moduleMethodsByName[commandName];
    if (method == nil) {
      RCTLogError(@"No command found with name \"%@\"", commandName);
    }
```

| 架构 | `moduleData` | 走哪条 |
| --- | --- | --- |
| **Legacy** | `nil`（`_bridge.batchedBridge` 不存在） | 落到 `_moduleMethods` |
| **Bridgeless** | `nil`（`!_bridge` 时也不建） | 落到 `_moduleMethods` |

> **两条架构路径实际上都走 `_moduleMethods`。**
> 源码用 `moduleData ? ... : ...` 表达的双路径，
> 在当前代码状态下**永远走后者**。
>
> 这与 24 文档 §3（`RCTEventEmitter` 零注册）、
> §6.3（`RCTBridge` 的 reload 空实现）是**同一进程的第三处体现**。

### 3.2 注释还记录了一处类型判断的坑

`RCTLegacyViewManagerInteropCoordinator.mm:125-130`：

```objc
  // We can't use `[NSString intValue]` as "0" is a valid command,
  // but also a falsy value. [NSNumberFormatter numberFromString] returns a
  // `NSNumber *` which is NULL when it's to be NULL
  // and it points to 0 when the string is @"0" (not a falsy value).
  NSNumberFormatter *formatter = [[NSNumberFormatter alloc] init];
```

**注释解释了为什么不用 `[NSString intValue]` 做真假判断** ——
`"0"` 是合法的命令编号但也是 falsy 值。这是 Android `ReactMarker` 侧没有的细节。

---

## 4. `RCTBridgeModuleDecorator`：唯一活着的迁移桥

`React/Base/RCTBridgeModuleDecorator.m:26-71`：

```objc
- (void)attachInteropAPIsToModule:(id<RCTBridgeModule>)bridgeModule
{
  /**
   * Attach the RCTViewRegistry to this TurboModule, which allows this TurboModule
   * To query a React component's UIView, given its reactTag.
   *
   * Usage: In the TurboModule @implementation, include:
   *   `@synthesize viewRegistry_DEPRECATED = _viewRegistry_DEPRECATED`
   */
  if ([bridgeModule respondsToSelector:@selector(setViewRegistry_DEPRECATED:)]) {
    bridgeModule.viewRegistry_DEPRECATED = _viewRegistry_DEPRECATED;
  }
```

四个 API 全部用 **`respondsToSelector:` + `@synthesize`** 的方式接入。

### 4.1 接入率极低

| `@synthesize` 目标 | 使用文件数 |
| --- | --- |
| `moduleRegistry` | 14 |
| `bundleManager` | 6 |
| `callableJSModules` | 5 |
| `viewRegistry_DEPRECATED` | 更少（已标 DEPRECATED） |

**这意味着任何没有写 `@synthesize` 的 TurboModule 拿不到这些对象**，
而 `respondsToSelector:` 检查会**静默跳过**，不报错。

> **这是一个脆弱的隐式契约**：接入方式不是重写 setter 或实现协议，
> 而是「在 `@implementation` 里写一行 `@synthesize`」。
> 漏写 → 该 API 为 `nil` → 调用处崩溃。
> 源码注释（`:32-33` 等四处）都专门提示了这个用法，说明维护者知道它不直观。

### 4.2 两条注入路径

| 调用方 | 位置 |
| --- | --- |
| `RCTTurboModuleManager` | `ReactCommon/.../RCTTurboModuleManager.mm:699` |
| Interop coordinator | `RCTLegacyViewManagerInteropCoordinator.mm:97` |

`RCTTurboModuleManager.mm:695-700`：

```objc
  /**
   * Decorate NativeModules with bridgeless-compatible APIs that call into the bridge.
   */
  if (_bridgeModuleDecorator) {
    [_bridgeModuleDecorator attachInteropAPIsToModule:module];
  }
```

**注意注释措辞**：`bridgeless-compatible APIs that call into the bridge`。
它不是「注入 bridge」，而是**让 TurboModule 拿到 `RCTBridge`-like 的能力对象** ——
名字里的 `bridge` 是历史包袱。

### 4.3 装饰器的生命周期

| 步骤 | 位置 |
| --- | --- |
| 创建 | `RCTInstance.mm:128` |
| 放入 context container | `RCTInstance.mm:374` |
| 从 container 取出 | `LegacyViewManagerInteropComponentDescriptor.mm:132` |

`RCTInstance.mm:374` 把 ObjC 对象包成 `shared_ptr<void>` 塞进 C++ context container：

```objc
contextContainer->insert("RCTBridgeModuleDecorator", facebook::react::wrapManagedObject(_bridgeModuleDecorator));
```

**这是 ObjC → C++ → ObjC 的往返**（`wrapManagedObject` / `find`），
只为了让 interop descriptor 能拿到这个装饰器。

---

## 5. `RCT_EXPORT_MODULE`：三套变体

`React/Base/RCTBridgeModule.h:72-123` 按两个宏分成三套实现。

### 5.1 两个宏都定义时：只剩 `moduleName`

```objc
// packages/react-native/React/Base/RCTBridgeModule.h:74-80
// With both legacy interop layers removed, RCTRegisterModule is compiled out, so
// static module registration is a no-op: only the JS module name is emitted.
#define RCT_EXPORT_MODULE(js_name) \
  +(NSString *)moduleName          \
  {                                \
    return @ #js_name;             \
  }
```

注释说明了设计意图：**`+load` 被完全移除**，
所以「静态模块注册」这个动作不再发生。

### 5.2 默认：保留 `+load` 静态注册

```objc
// packages/react-native/React/Base/RCTBridgeModule.h:84-94
#ifndef RCT_DISABLE_STATIC_MODULE_REGISTRATION
#define RCT_EXPORT_MODULE(js_name)          \
  RCT_EXTERN void RCTRegisterModule(Class); \
  +(NSString *)moduleName                   \
  {                                         \
    return @ #js_name;                      \
  }                                         \
  +(void)load                               \
  {                                         \
    RCTRegisterModule(self);                \
  }
```

### 5.3 `RCT_DISABLE_STATIC_MODULE_REGISTRATION` 的死分支

```objc
// packages/react-native/React/Base/RCTBridgeModule.h:96-105
#else

#define RCT_EXPORT_MODULE(js_name)          \
  RCT_EXTERN void RCTRegisterModule(Class); \
  +(NSString *)moduleName                   \
  {                                         \
    return @ #js_name;                      \
  }

#endif // RCT_DISABLE_STATIC_MODULE_REGISTRATION
```

**两个问题**：

1. **`RCT_DISABLE_STATIC_MODULE_REGISTRATION` 全仓库零定义**（构建脚本、podspec、Package.swift 都没有），
   所以这个分支**永远不会编译**。
2. 即便编译，它仍保留 `RCT_EXTERN void RCTRegisterModule(Class);` 声明
   ——而**调用点已被删掉**，声明成为悬空。

> **修正一处容易得出的错误结论**：悬空声明**不会**产生链接错误。
> 因为 C 语言的链接器只要求「被引用」的符号有定义。
> 这个分支里 `RCTRegisterModule` **只声明、不调用**，所以不会 undefined symbol。
>
> 但它确实暴露了一个**已完成的迁移被半途保留**的痕迹：
> 关闭静态注册的实现里，忘记删掉配套的声明。

### 5.4 `RCTRegisterModule` 的定义受**另一个**宏门控

`RCTBridge.mm:136-165`：

```objc
#if !defined(RCT_REMOVE_LEGACY_MODULE_INTEROP) || !defined(RCT_REMOVE_LEGACY_COMPONENT_INTEROP)
/**
 * Register the given class as a bridge module. All modules must be registered
 * prior to the first bridge initialization.
 * TODO: (T115656171) Refactor RCTRegisterModule out of Bridge.m since it doesn't use the Bridge.
 */
void RCTRegisterModule(Class /*moduleClass*/);
void RCTRegisterModule(Class moduleClass)
{
  if (RCTAreLegacyLogsEnabled() && ![getCoreModuleClasses() containsObject:[moduleClass description]]) {
    addModuleLoadedWithOldArch([moduleClass description]);
  }
```

**四种宏组合下声明与定义始终配对**（24 文档 §7.4 已列表，此处补结论）：

| 组合 | 头文件 | `.mm` | 结果 |
| --- | --- | --- | --- |
| 都不定义 | 声明 + `+load` 调用 | 有定义（`\|\|` 成立） | ✅ |
| 只定义 MODULE | 声明 + `+load` 调用 | 有定义 | ✅ |
| 只定义 COMPONENT | 声明 + `+load` 调用 | 有定义 | ✅ |
| **两个都定义** | 只剩 `moduleName`（`:76-80`） | **无定义** | ✅ 一致 |

**即当前设计是自洽的** —— 这与 §5.3 的悬空声明是两件不同的事。

`RCTModuleClasses` 用 `dispatch_barrier_async` 加、`dispatch_sync` 读
（`RCTBridge.mm:148-163`），是标准的并发读写保护：

```objc
  // Register module
  dispatch_barrier_async(RCTModuleClassesSyncQueue, ^{
    [RCTModuleClasses addObject:moduleClass];
  });
```

---

## 6. 启动性能标签：22 个里 12 个零打点

`React/Base/RCTPLTag.h:8-31` 定义了 **22 个标签 + 1 个哨兵**：

```objc
typedef NS_ENUM(NSInteger, RCTPLTag) {
  RCTPLScriptDownload = 0,
  RCTPLScriptExecution,
  RCTPLRAMBundleLoad,
  RCTPLRAMStartupCodeSize,
  RCTPLRAMStartupNativeRequires,
  RCTPLRAMStartupNativeRequiresCount,
  RCTPLRAMNativeRequires,
  RCTPLRAMNativeRequiresCount,
  RCTPLNativeModuleInit,
  RCTPLNativeModuleMainThread,
  RCTPLNativeModulePrepareConfig,
  RCTPLNativeModuleMainThreadUsesCount,
  RCTPLNativeModuleSetup,
  RCTPLTurboModuleSetup,
  RCTPLJSCWrapperOpenLibrary,
  RCTPLBridgeStartup,
  RCTPLTTI,
  RCTPLBundleSize,
  RCTPLReactInstanceInit,
  RCTPLAppStartup,
  RCTPLInitReactRuntime,
  RCTPLSize // This is used to count the size
};
```

`RCTPLSize` **只作为数组维度**，不参与打点 ——
`RCTPerformanceLoggerLabels.m:46-49` 对它显式断言：

```objc
    case RCTPLSize: // Only used to count enum size
      RCTAssert(NO, @"RCTPLSize should not be used to track performance timestamps.");
      return nil;
```

> **注意**：这个 `RCTAssert(NO, ...)` 在 Release 下**什么也不做**
> ——因为 `RCTCurrentAssertFunction` 恒为 `nil`（[23 文档 §4.5](./23-iOS基础工具层ConvertAssertLogUtils.md)），
> 且 `NS_BLOCK_ASSERTIONS` 让整个宏变成 `do{}while(0)`。
> **一个「不该发生」的错误编码路径，在生产环境完全静默。**

### 6.1 打点覆盖实测

**22 个标签中只有 10 个有实际打点**：

| 标签 | 打点数 | 打点位置 |
| --- | --- | --- |
| `RCTPLAppStartup` | 4 | `RCTPerformanceLoggerUtils.mm:21, 24` + `RCTPerformanceLogger.mm:32, 41` |
| `RCTPLInitReactRuntime` | 4 | `RCTPerformanceLoggerUtils.mm:27, 30` + `RCTPerformanceLogger.mm:33, 42` |
| `RCTPLScriptExecution` | 4 | `RCTPerformanceLoggerUtils.mm:33, 36` + `RCTPerformanceLogger.mm:34, 43` |
| `RCTPLReactInstanceInit` | 4 | `RCTInstance.mm:122, 427` + `RCTPerformanceLoggerUtils.mm:52, 55` |
| `RCTPLRAMNativeRequires` | 2 | `RCTPerformanceLoggerUtils.mm:39, 42` |
| `RCTPLRAMNativeRequiresCount` | 1 | `RCTPerformanceLoggerUtils.mm:43` |
| `RCTPLNativeModuleSetup` | 2 | `RCTPerformanceLoggerUtils.mm:46, 49` |
| `RCTPLScriptDownload` | 2 | `RCTInstance.mm:423, 528` |
| `RCTPLTTI` | 1 | `RCTSurfaceHostingProxyRootView.mm:122` |
| `RCTPLTag`（基类名） | 12 | `RCTPerformanceLogger.mm` 内部 |

**12 个零打点标签**：

| 标签 | 含义 | 为何零打点 |
| --- | --- | --- |
| `RCTPLRAMBundleLoad` | RAM bundle 加载耗时 | RAM bundle 路径已不再打点 |
| `RCTPLRAMStartupCodeSize` | RAM 启动代码量 | 同上 |
| `RCTPLRAMStartupNativeRequires` | RAM 启动期 native require | 同上 |
| `RCTPLRAMStartupNativeRequiresCount` | 同上计数 | 同上 |
| `RCTPLNativeModuleInit` | 模块初始化 | 被 `RCTPLNativeModuleSetup` 取代 |
| `RCTPLNativeModuleMainThread` | 主线程模块初始化 | 同上 |
| `RCTPLNativeModulePrepareConfig` | 配置准备 | 同上 |
| `RCTPLNativeModuleMainThreadUsesCount` | 主线程模块计数 | 同上 |
| `RCTPLTurboModuleSetup` | TurboModule 设置 | 新架构下未接入性能日志 |
| `RCTPLJSCWrapperOpenLibrary` | JS 引擎打开 | JSCWrapper 已被 Hermes 取代 |
| `RCTPLBridgeStartup` | Bridge 启动 | legacy Bridge 已空壳化（§2） |
| `RCTPLBundleSize` | bundle 大小 | 未打点 |

> **这是本文对 [13 文档](./13-JS启动装配.md) / [05 文档](./05-监控检测原理与流程.md)
> 的直接补充**：启动耗时面板上能看到的指标比标签数量少。
>
> **规律很清晰** —— 零打点的 12 个分成三类：
> 1. **被取代的**（4 个 `NativeModule*`）：legacy 模块管理路径已空壳；
> 2. **已消失的技术**（6 个 RAM bundle + `JSCWrapperOpenLibrary`）：对应实现不再走这条路；
> 3. **未接入的**（`TurboModuleSetup` / `BundleSize`）：新架构下没有补上打点。

### 6.2 打点如何接入：劫持 `ReactMarker` 全局函数指针

`ReactCommon/.../RCTPerformanceLoggerUtils.mm:67-75`：

```objc
void registerPerformanceLoggerHooks(RCTPerformanceLogger *performanceLogger)
{
  __weak RCTPerformanceLogger *weakPerformanceLogger = performanceLogger;
  ReactMarker::logTaggedMarkerImpl = [weakPerformanceLogger](
                                         const ReactMarker::ReactMarkerId markerId, const char *tag) {
    (void)tag;
    mapReactMarkerToPerformanceLogger(markerId, weakPerformanceLogger);
  };
}
```

**性能日志不是独立埋点，而是挂接在 `ReactMarker` 的全局函数指针上。**
这带来一个重要推论：

> **标记器不发射 → 标签必然为空。**
> 所以「标签存在」不等于「指标可得」，
> 真正的决定权在 C++ 侧 `ReactMarker::logMarker` 有没有对应调用。

标记器到标签的映射（`:19-64`）有 **17 个 `case`**：
**12 个生效映射**（6 对 start/stop + `NATIVE_REQUIRE_*`），
**5 个被显式忽略**。
其中 5 个被显式忽略：

```objc
    case ReactMarker::CREATE_REACT_CONTEXT_STOP:
    case ReactMarker::JS_BUNDLE_STRING_CONVERT_START:
    case ReactMarker::JS_BUNDLE_STRING_CONVERT_STOP:
    case ReactMarker::REGISTER_JS_SEGMENT_START:
    case ReactMarker::REGISTER_JS_SEGMENT_STOP:
      // These are not used on iOS.
      break;
```

**这 5 个是 Android 侧独有的标记** —— 注释说明了跨平台差异。

### 6.3 平台不对称：Android 有默认处理器，iOS 需要显式注册

| 平台 | 赋值方式 | 位置 |
| --- | --- | --- |
| **Android** | `JReactMarker::logPerfMarker`（JNI 层默认装好） | `ReactAndroid/.../JReactMarker.cpp:23` |
| **iOS** | `registerPerformanceLoggerHooks(...)`（需显式调用） | `ReactCommon/.../RCTPerformanceLoggerUtils.mm:67` |

iOS 侧唯一调用点（`RCTInstance.mm:120-121`）：

```objc
    _performanceLogger = [RCTPerformanceLogger new];
    registerPerformanceLoggerHooks(_performanceLogger);
```

> **含义**：iOS 的性能日志**只在 `RCTInstance` 构造后**才可用。
> 在此之前发射的 `ReactMarker` 全部丢失
> （`logTaggedMarkerImpl` 此时为空指针，`logMarker` 会检查）。
>
> **这解释了 `RCTPLAppStartup` 为什么有效** ——
> `APP_STARTUP_START` 由 `RCTInstance` 自己在 `RCTPerformanceLogger.mm:32` 打，
> 不依赖标记器；而 `ReactInstance.cpp:275` 也有一次 `hasLogger` 检查，
> 说明**两端都会在 logger 就绪前跳过标记**。

---

## 7. `RCTPerformanceLogger` 的数据模型：一个 slot 承担三种语义

`React/Base/RCTPerformanceLogger.mm:20-23`：

```objc
@interface RCTPerformanceLogger () {
  int64_t _data[RCTPLSize][2];
  NSInteger _cookies[RCTPLSize];
}

@end
```

**每个标签只有 2 个 int64 槽位**，被三套 API 用三种不同语义写入：

| API | `_data[tag][0]` | `_data[tag][1]` | 用途 |
| --- | --- | --- | --- |
| `markStart/markStop` | start 时间戳 | stop 时间戳 | **单次时长** |
| `setValue/addValue` | **强制置 0** | 累加数值 | **计数** |
| `appendStart/appendStop` | 临时开始时间 | 累加时长 | **多次时长之和** |

`RCTPerformanceLogger.mm:88-113`：

```objc
- (void)setValue:(int64_t)value forTag:(RCTPLTag)tag
{
  _data[tag][0] = 0;
  _data[tag][1] = value;
}

- (void)addValue:(int64_t)value forTag:(RCTPLTag)tag
{
  _data[tag][0] = 0;
  _data[tag][1] += value;
}

- (void)appendStartForTag:(RCTPLTag)tag
{
  _data[tag][0] = CACurrentMediaTime() * 1000;
}

- (void)appendStopForTag:(RCTPLTag)tag
{
  if (_data[tag][0] != 0) {
    _data[tag][1] += CACurrentMediaTime() * 1000 - _data[tag][0];
    _data[tag][0] = 0;
  } else {
    RCTLogInfo(@"Unbalanced calls start/end for tag %li", (unsigned long)tag);
  }
}
```

**读取只有一种方式**（`:125-128`）：

```objc
- (int64_t)durationForTag:(RCTPLTag)tag
{
  return _data[tag][1] - _data[tag][0];
}
```

> **`durationForTag` 对计数标签也返回 `数值 - 0 = 数值`** ——
> 也就是说它对计数标签**恰好正确**，
> 但这是**巧合**：`_data[tag][0]` 恰好被 `setValue:`/`addValue:` 置 0。
>
> **没有类型标签区分「这个槽位是时长还是计数」**，
> 也没有校验 `tag` 是否被用错了 API。
> 同一个标签若既调 `markStart:` 又调 `addValue:`，计数会把时间戳覆盖，反之亦然。
> 源码不阻止这种混用。

### 7.1 不配对调用会记日志

`markStopForTag:`（`:75-79`）与 `appendStopForTag:`（`:107-112`）
都在 `_data[tag][0] == 0` 或已配对时记一条 `RCTLogInfo`：

```objc
  if (_data[tag][0] != 0 && _data[tag][1] == 0) {
    _data[tag][1] = currentTime;
  } else {
    RCTLogInfo(@"Unbalanced calls start/end for tag %li", (unsigned long)tag);
  }
```

**这条日志在 Release 下依然会输出** ——
因为 `_RCTLogNativeInternal` 的 `log` 判定恒真
（[23 文档 §5.2](./23-iOS基础工具层ConvertAssertLogUtils.md)），
且默认 log function 用 `%{public}s` 写 os_log（不脱敏）。

---

## 8. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| M-1 | **`RCTModuleData` 的 3 个方法全是空实现**，11 个属性靠自动合成返回零值 | `React/Base/RCTModuleData.mm:15-41` | 类存在但**无法实例化**（构造器 0 调用）、无法取值；**完全静默** |
| M-2 | `RCTBridge` 上没有 `moduleDataForName:` / `batchedBridge` 的实现 | `React/Base/RCTBridge+Private.h:99` 声明，`.mm` 无实现 | 唯一引用方拿到 `nil`，靠 `moduleData ? ... : ...` 静默降级 |
| M-3 | **`RCT_EXPORT_MODULE` 的 `RCT_DISABLE_STATIC_MODULE_REGISTRATION` 分支零定义** | `React/Base/RCTBridgeModule.h:96-103` | 死分支；且分支内保留悬空的 `RCT_EXTERN` 声明（不产生链接错误，因为无引用） |
| M-4 | **`attachInteropAPIsToModule` 靠 `@synthesize` 接入，漏写即静默为 nil** | `React/Base/RCTBridgeModuleDecorator.m:26-71` | 使用 `moduleRegistry` 的仅 14 个文件、`callableJSModules` 仅 5 个；其余模块拿不到 |
| M-5 | **22 个性能标签中 12 个零打点** | `React/Base/RCTPLTag.h:8-31` | 启动耗时面板**只有 10 个指标真实可得** |
| M-6 | 性能日志靠**劫持 `ReactMarker::logTaggedMarkerImpl`** 接入 | `RCTPerformanceLoggerUtils.mm:70` | 标记器不发射则标签必空；iOS 需显式注册（Android 是 JNI 默认装好） |
| M-7 | iOS 侧 5 个 `ReactMarker` 显式忽略（Android 独有） | `RCTPerformanceLoggerUtils.mm:57-63` | 跨平台性能指标**不可直接对比** |
| M-8 | **`RCTPLSize` 的 `RCTAssert(NO, ...)` 在 Release 下完全不生效** | `React/Base/RCTPerformanceLoggerLabels.m:46-48` | 错误用法（对哨兵打点）在生产环境**无任何痕迹** |
| M-9 | `_data[tag][0]` 被三套 API 用三种语义写入，无类型标签 | `React/Base/RCTPerformanceLogger.mm:88-113` | 混用会互相覆盖；`durationForTag` 对计数正确**是巧合** |
| M-10 | `RCTModuleData` 的方法扫描逻辑被「copy-pasta」到 interop 层 | `RCTLegacyViewManagerInteropCoordinator.mm:194` | 同一逻辑两份实现，改一处易漏另一处 |

### M-5 的适用范围（必须写清）

「12 个零打点」的口径是：
**在 `packages/react-native` 的 `.m` / `.mm` / `.cpp` 里搜索标签名，排除 `RCTPLTag.h` 与 `RCTPerformanceLoggerLabels.*`。**

**已确认在用的 10 个标签都是真实可得的**，
零打点不代表「指标不存在」，而是**这条特定埋点路径未被接线**。
例如 `RCTPLBundleSize` 为 0，但 05 文档所述的 bundle 大小监控
**可能通过其他方式获得**（如 `RCTSource._length`）—— 那需要另行核实。

---

## 9. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 06 文档 P2-3：「12 个 `RCTPLTag` 已声明但从未使用」 | **确认该清单完全一致**（M-5），并补上「总数 22 / 有打点 10」的精确口径；**顺带修正了 05/06 两篇文档把总数写成 21 的错误** |
| 15 文档：`ReactMarkerConstants` 114 个枚举（Android） | **补上 iOS 侧的映射**：`RCTPerformanceLoggerUtils.mm:19-64` 用 12 个生效 + 5 个显式忽略（M-6、M-7） |
| 13 文档 / 05 文档：启动耗时指标 | **限定可得性**：实际只有 10 个标签有数据（M-5） |
| 19 文档 §5.1：「`RCTPLTag` —— iOS 侧 22 个」 | **确认**该数字正确（05/06 两篇与之不符，已修） |
| 23 文档：四个 handler 安装函数零调用 | **新增受影响点**：`RCTPLSize` 的 `RCTAssert` 因此在 Release 完全无效（M-8） |
| 24 文档：legacy 清理残留 | **新增第三类**：`RCTModuleData` 类存实现空（M-1、M-2） |
