---
id: 39
title: "TurboModule 的 iOS 平台层：四步解析、模块创建的双重检查锁与异常转换"
topic: PL.ios
symptoms: [bridge]
platforms: [ios]
architecture: [cross]
layer: T2
symbols: ["RCTTurboModule", "RCTTurboModuleManager"]
sourceRoot: react-native
claims: [DD-1, DD-2, DD-3, DD-4, DD-5, DD-6, DD-7, DD-8]
---
# 39 · TurboModule 的 iOS 平台层：四步解析、模块创建的双重检查锁与异常转换

> **模块**：B1 · `ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/`
> （`RCTTurboModule.mm` 1012、`RCTTurboModuleManager.mm` 1009、
> `RCTInteropTurboModule.mm` 701 + 3 头文件 344）
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · 新架构（Fabric + TurboModule）
> **前置**：[23 文档](./23-iOS基础工具层ConvertAssertLogUtils.md) 记录了
> `RCT_CUSTOM_CONVERTER` 的 **Debug/Release 语义反转**（Release 无 `@try`）；
> [37 文档](./37-legacy布局层被掏空与ShadowQueue转用.md) 记录了 legacy 侧的退役；
> [38 文档](./38-Modules余部EventEmitter与LayoutAnimation.md) 记录了
> 「隐蔽契约」的四种形态。
>
> 本文记录 **TurboModule 在 iOS 上的四步解析顺序**、
> **模块创建的双重检查锁及其被文档化的无限等待风险**、
> **无条件 `@try`（与 23 文档的 `RCT_CUSTOM_CONVERTER` 恰成对照）**，
> 以及 **`RCT_REMOVE_LEGACY_MODULE_INTEROP` 这个宿主可控开关**。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm` | 1012 | ObjC 方法 → JSI 的桥 |
| `ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm` | 1009 | **模块解析与创建** |
| `ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTInteropTurboModule.mm` | 701 | legacy 模块的 TurboModule 适配 |
| `ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.h` | 215 | `ObjCTurboModule` 声明 |
| `ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTInteropTurboModule.h` | 95 | `ObjCInteropTurboModule` 声明 |
| `ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.h` | 78 | 管理器接口 |
| `ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleWithJSIBindings.h` | 25 | JSI binding 协议 |

---

## 2. 四步解析顺序

`RCTTurboModuleManager.mm:272-358` 的 `provideTurboModule:runtime:` 结构清晰，
每一步都有 `/** */` 注释标注：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:272-278
- (std::shared_ptr<TurboModule>)provideTurboModule:(const char *)moduleName runtime:(jsi::Runtime *)runtime
{
  auto turboModuleLookup = _turboModuleCache.find(moduleName);
  if (turboModuleLookup != _turboModuleCache.end()) {
    TurboModulePerfLogger::moduleJSRequireBeginningCacheHit(moduleName);
    TurboModulePerfLogger::moduleJSRequireBeginningEnd(moduleName);
    return turboModuleLookup->second;
  }
```

| 步骤 | 位置 | 来源 | 注释标注 |
| --- | --- | --- | --- |
| **缓存** | `:273-279` | `_turboModuleCache` | — |
| **① 纯 C++ 模块** | `:287-301` | `[_delegate getTurboModule:jsInvoker:]` | `Step 1: Look for pure C++ modules. **Pure C++ modules get priority.**` |
| **② 静态 C++ 导出表** | `:303-309` | `globalExportedCxxTurboModuleMap()` | （无注释） |
| **③ 平台模块存在性** | `:316-327` | `[_moduleProviderForName:]` | `Step 2: Look for platform-specific modules.` |
| **④ ObjC TurboModule** | `:336-352` | `getTurboModule:` | `Step 3: Return an exact sub-class of ObjC TurboModule` |

**优先级明确**：C++ 优先于 ObjC。这与 [30 文档 §2.4](./30-iOS-WebSocket与调试通道.md) 的
`DefaultTurboModules.cpp`（C++ 侧先查 `DevToolsRuntimeSettingsModule` 再委托）一致。

### 2.1 步骤 ① 的注释解释了一个性能取舍

`:287-289`：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:287-289
  /**
   * Step 1: Look for pure C++ modules.
   * Pure C++ modules get priority.
   */
```

而 `:309-314` 的注释解释了**为何用 `respondsToSelector:` 而不是 `conformsToProtocol:`**：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:309-314
  /**
   * Step 3: Return an exact sub-class of ObjC TurboModule
   *
   * Use respondsToSelector: below to infer conformance to @protocol(RCTTurboModule). Using conformsToProtocol: is
   * expensive.
   */
```

**这是本轮读到的注释质量第一档**（给了结论 + 给了理由），
与 [36 文档 §5.1](./36-legacy-View层ComponentData与hitTest.md) 的
Apple QA 链接、`CWE-391` 引用同级。

### 2.2 步骤 ② 无注释，但类型是全局静态表

`:303-309`：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:303-309
  auto &cxxTurboModuleMapProvider = globalExportedCxxTurboModuleMap();
  auto it = cxxTurboModuleMapProvider.find(moduleName);
  if (it != cxxTurboModuleMapProvider.end()) {
    auto turboModule = it->second(_jsInvoker);
    _turboModuleCache.insert({moduleName, turboModule});
    return turboModule;
  }
```

**这是唯一没有注释的步骤** —— 而它恰好是「新增 C++ 模块最直接的挂载点」。
对比步骤 ①③④ 都有注释，**② 的缺失是可改进点**。

### 2.3 【发现】失败结果也会被缓存

`:335-345`：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:335-345
    auto turboModule = [(id<RCTTurboModule>)module getTurboModule:params];
    if (turboModule == nullptr) {
      RCTLogError(@"TurboModule \"%@\"'s getTurboModule: method returned nil.", [module class]);
    }
    _turboModuleCache.insert({moduleName, turboModule});
```

**`turboModule == nullptr` 时：记一条错误日志 → 仍然 `insert` → 返回 nullptr。**

缓存容器（`:201`）：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:201
  std::unordered_map<std::string, std::shared_ptr<TurboModule>> _turboModuleCache;
```

**`shared_ptr` 允许存 nullptr**，所以 `{moduleName, nullptr}` 是合法条目。

| 后果 | 说明 |
| --- | --- |
| 第二次 `require` 同一模块 | 命中缓存（`:273-279`）→ **直接返回 nullptr，不重复记日志** |
| 日志次数 | 每个模块名**恰好一条** `RCTLogError` |
| 是否缓存失败 | ✅ 是（避免反复尝试、反复记日志） |
| 是否可恢复 | ❌ 否 —— 缓存无失效机制（除非 `invalidate`） |

> **这大概率是有意的**（避免一个坏模块刷屏日志），
> **但没有任何注释说明**。
> 对照 36 文档 §5 的「注释质量三档」，这属于**零档**。

**排查影响**：若某个模块的 `getTurboModule:` 返回 nil，
**只有第一次 require 才有日志**。
若用户报告「模块不工作但没有报错」，**需要主动加日志或查缓存**才能定位。

### 2.4 `methodQueue == RCTJSThread` 决定同步性

`:317` 与 `:325`：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:317-331
  std::shared_ptr<NativeMethodCallInvoker> nativeMethodCallInvoker = nullptr;
  dispatch_queue_t methodQueue = (dispatch_queue_t)objc_getAssociatedObject(module, &kAssociatedMethodQueueKey);
  if (methodQueue) {
    /**
     * Step 2c: Create and native CallInvoker from the TurboModule's method queue.
     */
    nativeMethodCallInvoker = std::make_shared<ModuleNativeMethodCallInvoker>(methodQueue);
  }
```

配合 `:314` 的 `.isSyncModule = methodQueue == RCTJSThread`：

| `methodQueue` | `isSyncModule` | 调用方式 |
| --- | --- | --- |
| `RCTJSThread` | **YES** | `invokeSync`（阻塞等结果） |
| 其他队列 | NO | `invokeAsync` |

**即：模块声明 `methodQueue = RCTJSThread` 就意味着「方法是同步的」。**

**承接 [37 文档](./37-legacy布局层被掏空与ShadowQueue转用.md)**：
`RCTViewManager.m:133-136` 的 `methodQueue` 返回 `RCTGetUIManagerQueue()`，
**不是 `RCTJSThread`** → 所以 ViewManager 的方法都是异步的。

---

## 3. 模块创建：双重检查锁 + 被文档化的无限等待

### 3.1 完整结构

`:499-573` 的 `_provideObjCModule:moduleProvider:` 分两段：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:499-573
```

**第一段（快速路径）**：`:507` 取 `moduleHolder->mutex()`，
`:549-553` 写入并 `endCreatingModule()`，`:554` `notify_all()`。

**第二段（慢路径）**：`:559-572`

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:559-572
  std::unique_lock<std::mutex> guard(moduleHolder->mutex());

  while (moduleHolder->isCreatingModule()) {
    /**
     * TODO(T65905574):
     * If the thread responsible for creating and initializing the NativeModule stalls, we'll wait here indefinitely.
     * This is the behaviour in legacy NativeModules. Changing this now could lead to more crashes/problems in
     * TurboModules than in NativeModules, which'll make it more difficult to test the TurboModules infra. Therefore,
     * we should consider making it post TurboModule 100% rollout.
     */
    moduleHolder->cv().wait(guard);
  }

  return moduleHolder->getModule();
```

### 3.2 注释坦承了一个真实风险

**`TODO(T65905574)` 的内容**：

| 要点 | 原文 |
| --- | --- |
| **风险** | 若创建/初始化 NativeModule 的线程卡住，这里会**无限等待** |
| **为何保留** | 这是 legacy NativeModules 的既有行为 |
| **为何现在不能改** | 现在改会导致 TurboModules 比 NativeModules 出现更多崩溃/问题，**使 TurboModule 基础设施更难测试** |
| **何时改** | TurboModule 100% 推广之后 |

> **这是全仓库少见的「注释坦承已知缺陷并给出决策依据」的写法**：
> 不是「已知问题」，而是「**已知问题 + 为何现在不改 + 何时改**」三要素齐全。
>
> 与 [37 文档 BB-8](./37-legacy布局层被掏空与ShadowQueue转用.md)（跨回调持 `std::mutex` 的
> 重入死锁风险、**零观察者故不可达、无注释**）形成鲜明对照：
>
> | | 37 文档 BB-8 | 本文 §3.2 |
> | --- | --- | --- |
> | 风险 | 重入死锁 | 无限等待 |
> | 可达性 | 不可达（零观察者） | **可达**（任何模块初始化卡住） |
> | 注释 | ❌ 无 | ✅ **有，含工单号 + 决策依据 + 时间点** |
>
> **这说明 RN 的注释水平不是均匀的** ——
> 同一个仓库里，TurboModule 层（较新）写得比 legacy 层（较旧）好。

### 3.3 `_shouldCreateObjCModule:` 的启发式

`:806-839`：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:820-839
  /**
   * If a module overrides `constantsToExport` and doesn't implement `requiresMainQueueSetup`, then we must assume
   * that it must be called on the main thread, because it may need to access UIKit.
   */
  BOOL hasConstantsToExport = [moduleClass instancesRespondToSelector:@selector(constantsToExport)];

  static IMP objectInitMethod;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    objectInitMethod = [NSObject instanceMethodForSelector:@selector(init)];
  });

  /**
   * If a module overrides `init` then we must assume that it expects to be initialized on the main thread, because it
   * may need to access UIKit.
   */
  const BOOL hasCustomInit = [moduleClass instanceMethodForSelector:@selector(init)] != objectInitMethod;

  return hasConstantsToExport || hasCustomInit;
```

**两条规则，各配一段解释「为什么」的注释**：

| 规则 | 判据 | 理由 |
| --- | --- | --- |
| ① | 实现了 `constantsToExport` | 可能访问 UIKit |
| ② | 覆写了 `init` | 可能访问 UIKit |

**`objectInitMethod` 用 `dispatch_once` 缓存** —— 因为
`[NSObject instanceMethodForSelector:]` 每次调用都要查元类。

> **`instanceMethodForSelector:` 返回 `IMP` 而非 `Method`** ——
> 所以比较的是**函数指针**是否相同，等价于「是否覆写了 `init`」。

---

## 4. `performMethodInvocation`：无条件的 `@try`

### 4.1 与 23 文档的 `RCT_CUSTOM_CONVERTER` 恰成对照

**23 文档的发现**（`React/Base/RCTConvert.h:207-220`）：

```objc
// packages/react-native/React/Base/RCTConvert.h:207-220
#define RCT_CUSTOM_CONVERTER(type, name, code) \
  +(type)name : (id)json RCT_DYNAMIC           \
  {                                            \
    if (!RCT_DEBUG) {                          \
      return code;                             \
    } else {                                   \
      @try {                                   \
        return code;                           \
      } @catch (__unused NSException * e) {    \
        RCTLogConvertError(json, @ #type);     \
        json = nil;                            \
        return code;                           \
      }                                        \
    }                                          \
  }
```

**Release 下 `if (!RCT_DEBUG)` 分支没有 `@try`** → 类型不匹配直接崩。

**本文的 `performMethodInvocation`**（`RCTTurboModule.mm:476-528`）：

```objc
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm:499-513
    @try {
      [inv invokeWithTarget:strongModule];
    } @catch (NSException *exception) {
      if (isSync) {
        // We can only convert NSException to JSError in sync method calls.
        // See https://github.com/reactwg/react-native-new-architecture/discussions/276#discussioncomment-12567155
        throw convertNSExceptionToJSError(runtime, exception, std::string{moduleName}, methodNameStr);
      } else {
        @throw addModuleIdentityToException(exception, std::string{moduleName}, methodNameStr);
      }
    } @finally {
      [retainedObjectsForInvocation removeAllObjects];
    }
```

**`@try/@catch/@finally` 无条件编译**（该文件无 `#if` 包裹这两处）。

### 4.2 同步与异步的异常处理策略不同

| 调用类型 | 异常处理 | 理由（注释原文） |
| --- | --- | --- |
| **同步** `isSync == YES` | 转换成 **JSError** 抛给 JS | `We can only convert NSException to JSError in sync method calls.`（附 reactwg 讨论链接） |
| **异步** `isSync == NO` | `@throw` **重新抛出**，但先 `addModuleIdentityToException` | （无注释） |

**同步能被 JS 捕获、异步不能** —— 因为异步调用时 JS 侧的
`invoke()` 已经返回，没有对应的调用栈可以关联错误。

**`:570` 的注释再次确认**：

> JSError, same as the async branch in performMethodInvocation.

**同步/异步的不对称有注释说明理由（同步侧有链接），
异步侧只有一句「同异步分支」。**

### 4.3 弱引用 + 强局部变量

`:481` 与 `:486-489`：

```objc
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm:481-489
  __weak id<RCTBridgeModule> weakModule = instance_;
  const char *moduleName = name_.c_str();
  std::string methodNameStr{methodName};
  __block int32_t asyncCallCounter = 0;

  void (^block)() = ^{
    id<RCTBridgeModule> strongModule = weakModule;
    if (strongModule == nullptr) {
      return;
    }
```

**与 38 文档 §2.4 的 `RCTEventEmitter` 完全同型**：
弱引用捕获 → block 内转强 → 判空 → 空则直接返回。

**若模块已被释放，事件/回调静默丢弃**（无日志）。

### 4.4 `@finally` 清理 retained objects

`:512-514`：

```objc
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm:512-514
    } @finally {
      [retainedObjectsForInvocation removeAllObjects];
    }
```

**用 `@finally` 而不是在 `@catch` 之后** —— 保证**正常路径与异常路径都清理**。

`retainedObjectsForInvocation` 用于在异步调用期间保持参数对象存活
（ObjC 的 `NSInvocation` 参数可能是 autoreleased 对象）。

### 4.5 性能打点覆盖同步与异步两侧

`:495-501` 与 `:516-521`：

```objc
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm:495-501
    if (isSync) {
      TurboModulePerfLogger::syncMethodCallExecutionStart(moduleName, methodName);
    } else {
      TurboModulePerfLogger::asyncMethodCallExecutionStart(moduleName, methodName, asyncCallCounter);
    }
```

**同步与异步各有 Start/End 一对**，异步还带一个 `asyncCallCounter`（`:485` 初始 0，
`:528` 处 `getUniqueId()` 赋值）。

> **这与 [25 文档](./25-iOS桥接核心与启动性能标签.md) 的 `RCTPLTag` 打点体系不同** ——
> `TurboModulePerfLogger` 是**独立的一套**，服务于
> [03 文档](./03-核心技术原理.md) 的事件循环性能追踪。

---

## 5. Promise 的四态重复解决防护

### 5.1 resolve 侧

`:386-421`：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm:386-421
                if (!resolve || !reject) {
                  alreadyResolved = resolveWasCalled;
                  alreadyRejected = !resolveWasCalled;
                } else {
                  resolveWasCalled = YES;
                  localResolve = std::move(resolve);
                  resolve = std::nullopt;
                  reject = std::nullopt;
                }
              }

              if (alreadyResolved) {
                RCTLogError(
                    @"%s.%s(): Tried to resolve a promise more than once.", moduleName.c_str(), methodName.c_str());
                return;
              } else if (alreadyRejected) {
                RCTLogError(
                    @"%s.%s(): Tried to resolve a promise after it's already been rejected.",
                    moduleName.c_str(),
                    methodName.c_str());
                return;
              }
```

### 5.2 reject 侧

`:425-455` 的结构完全对称，且错误文案**精确区分**：

| # | 场景 | 错误文案 |
| --- | --- | --- |
| 1 | resolve 两次 | `Tried to resolve a promise more than once.` |
| 2 | reject 后又 resolve | `Tried to resolve a promise after it's already been rejected.` |
| 3 | resolve 后又 reject | `Tried to reject a promise after it's already been resolved. Message: %s` |
| 4 | reject 两次 | `Tried to reject a promise more than once. Message: %s` |

**四条文案各不相同，且都带 `moduleName.methodName()` 前缀。**

### 5.3 状态机用两个 `std::optional` + 一个 `BOOL`

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `resolve` / `reject` | `std::optional<AsyncCallback<>>` | 取出后置 `std::nullopt` 表示「已消费」 |
| `resolveWasCalled` | `BOOL` | 区分「是 resolve 还是 reject 消费了它」 |

**判定逻辑**：`if (!resolve || !reject)` 表示「已被消费过」，
此时用 `resolveWasCalled` 区分是哪一方消费的。

**访问在 `std::lock_guard<std::mutex>` 内**（`:390-395`、`:429-434`）。

> **这是一个正确的手写状态机**，四种非法组合都被识别。
> 注释解释了状态转移，锁保证了并发安全。
> **与 24 文档 §2 的 `sendEvent:` 缺陷形成对照** ——
> 那里的「不可合并分支先读未初始化的 `eventID`」是状态机写错。

---

## 6. `RCT_REMOVE_LEGACY_MODULE_INTEROP`：宿主可控，默认关闭

### 6.1 编译门控点

`RCTInteropTurboModule.mm:10`：

```objc
#ifndef RCT_REMOVE_LEGACY_MODULE_INTEROP
```

`RCTTurboModuleManager.mm:357`：

```objc
#ifndef RCT_REMOVE_LEGACY_MODULE_INTEROP
- (std::shared_ptr<TurboModule>)provideLegacyModule:(const char *)moduleName
```

**即：定义该宏 = 整个 legacy 模块互操作路径被编译掉。**

### 6.2 定义方式：环境变量，默认 `'0'`

`scripts/react_native_pods.rb:123`：

~~~ruby
ENV['RCT_REMOVE_LEGACY_MODULE_INTEROP'] = ENV['RCT_REMOVE_LEGACY_MODULE_INTEROP'] == '1' ? '1' : '0'
~~~

**显式把任何非 `'1'` 的值归一为 `'0'`** —— 即**默认保留 legacy 互操作**。

`scripts/cocoapods/utils.rb:23` 与 `Package.swift:971`：

~~~swift
(REMOVE_LEGACY_MODULE_INTEROP ? [.define("RCT_REMOVE_LEGACY_MODULE_INTEROP", to: "1")] : [])
~~~

| 构建系统 | 传递方式 |
| --- | --- |
| CocoaPods | `GCC_PREPROCESSOR_DEFINITIONS` 含 `-DRCT_REMOVE_LEGACY_MODULE_INTEROP=1`（仅当 ENV 为 `'1'`） |
| SwiftPM | `CXXSetting.define(..., to: "1")`（仅当 ENV 为 `"1"`） |

### 6.3 与另两个 DEBUGGER/DEV 宏的三方对照

| 宏 | 默认 | 谁能开 | 出处 |
| --- | --- | --- | --- |
| `REACT_NATIVE_DEBUGGER_ENABLED` | **开**（`:debug`） | 构建脚本自动 | [30 文档 §4.3](./30-iOS-WebSocket与调试通道.md) |
| `REACT_REMOVE_LEGACY_MODULE_INTEROP`… 即 `RCT_REMOVE_LEGACY_MODULE_INTEROP` | **关**（`'0'`） | **宿主手动设 ENV=1** | 本文 |
| `REACT_NATIVE_DEBUGGER_MODE_PROD` | 关 | 宿主手动 | [28 文档](./28-iOS-Dev工具链与四层门控.md) |

> **两个「移除能力」的宏（interop 与 debugger-mode-prod）都是宿主手动开启，
> 默认关闭；两个「加能力」的宏（debugger-enabled）是构建脚本自动开启。**
>
> **这个分野是有意义的**：移除 legacy 互操作是破坏性变更，必须显式选择；
> 而 Debug 调试器是纯开发便利，默认开启无害。

---

## 7. `RCTInteropTurboModule`：运行时反射 `__rct_export__`

### 7.1 `getMethodInfos`：沿类继承链找导出方法

`:51-76`：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTInteropTurboModule.mm:51-76
std::vector<const RCTMethodInfo *> getMethodInfos(Class moduleClass)
{
  std::vector<const RCTMethodInfo *> methodInfos;

  Class cls = moduleClass;
  while ((cls != nullptr) && cls != [NSObject class] && cls != [NSProxy class]) {
    unsigned int methodCount;
    Method *methods = class_copyMethodList(object_getClass(cls), &methodCount);

    for (unsigned int i = 0; i < methodCount; i++) {
      Method method = methods[i];
      SEL selector = method_getName(method);
      if ([NSStringFromSelector(selector) hasPrefix:@"__rct_export__"]) {
        IMP imp = method_getImplementation(method);
        const RCTMethodInfo *methodInfo = ((const RCTMethodInfo *(*)(id, SEL))imp)(moduleClass, selector);
        methodInfos.push_back(methodInfo);
      }
    }

    free(methods);
    cls = class_getSuperclass(cls);
  }

  return methodInfos;
}
```

**要点**：

| 要点 | 说明 |
| --- | --- |
| 沿类继承链上溯 | `class_getSuperclass`，**在 `NSObject` / `NSProxy` 处停止** |
| 用前缀匹配而非协议 | `hasPrefix:@"__rct_export__"` —— `RCT_EXPORT_METHOD` 宏生成的合成方法名 |
| **实际调用该方法** | `((const RCTMethodInfo *(*)(id, SEL))imp)(moduleClass, selector)` —— 把 IMP 当函数指针调用以取元信息 |
| 正确释放 | `free(methods)` |

> **`object_getClass(cls)` 取的是「元类」** ——
> 即**类方法**列表。`RCT_EXPORT_METHOD` 宏生成的正是类方法。
>
> 这与 36 文档 §2.2 的 `propConfig*` 是同一套机制（也是类方法、也是 `objc_msgSend` 调用）。

### 7.2 `getJSMethodName`：去掉冒号并断言

`:78-100`：

```cpp
// packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTInteropTurboModule.mm:78-100
NSString *getJSMethodName(const RCTMethodInfo *methodInfo)
{
  std::string jsName = methodInfo->jsName;
  if (!jsName.empty()) {
    return @(jsName.c_str());
  }

  NSString *methodName = @(methodInfo->objcName);
  NSRange colonRange = [methodName rangeOfString:@":"];
  if (colonRange.location != NSNotFound) {
    methodName = [methodName substringToIndex:colonRange.location];
  }
  methodName = [methodName stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  RCTAssert(
      methodName.length,
      @"%s is not a valid JS function name, please"
       " supply an alternative using RCT_REMAP_METHOD()",
      methodInfo->objcName);

  return methodName;
}
```

**三步**：

| 步骤 | 作用 |
| --- | --- |
| ① `jsName` 非空 | 直接用（来自 `RCT_REMAP_METHOD`） |
| ② 截断第一个 `:` | `setValue:` → `setValue` |
| ③ 去首尾空白 | 处理宏展开产生的空格换行 |
| 断言 | 结果为空则提示用 `RCT_REMAP_METHOD()` |

**断言文案指明了出路**（`RCT_REMAP_METHOD()`）——
与 38 文档 §2.3 的断言文案属同一类高质量写法。

> **注意 `substringToIndex:` 的安全性**：`colonRange.location != NSNotFound` 保证有冒号，
> 且 `location` 必然 ≥ 0 → 不会越界。
> **与 36 文档 AA-3（`[key substringToIndex:1]` 对空串会抛）不同 —— 这里有前置判断。**

### 7.3 整个文件被宏包裹

`:10` 的 `#ifndef RCT_REMOVE_LEGACY_MODULE_INTEROP` 包住**整个 701 行文件**。

**即：宿主设 `RCT_REMOVE_LEGACY_MODULE_INTEROP=1` 后，
这 701 行代码完全不参与编译。**

---

## 8. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| DD-1 | **模块创建失败的结果（nullptr）也会被缓存**，后续 require 静默返回 nullptr 且不再记日志 | `nativemodule/core/platform/ios/ReactCommon/RCTTurboModuleManager.mm:335-345` | 「无报错但模块不工作」的根因之一；**无注释说明是有意** |
| DD-2 | 四步解析中**只有步骤 ②（静态 C++ 导出表）无注释** | `RCTTurboModuleManager.mm:303-309` | 恰恰是新增 C++ 模块最常挂载的地方 |
| DD-3 | 模块初始化线程卡死时，其他线程**在条件变量上无限等待** | `RCTTurboModuleManager.mm:561-568` | **有注释 + 工单号 `T65905574` + 决策依据**；属已知取舍 |
| DD-4 | 异步分支的异常处理（`@throw`）**无注释解释为何不能转 JSError** | `RCTTurboModule.mm:510-512` | 同步侧有 reactwg 链接，异步侧只有一句「同异步分支」 |
| DD-5 | `weakModule` 为 nil 时**静默 return，无任何日志** | `RCTTurboModule.mm:486-489` | 与 38 文档 §2.4 `RCTEventEmitter` 同型 |
| DD-6 | `getMethodInfos` 沿类链反射**每个类都 `class_copyMethodList`（含 malloc）** | `RCTInteropTurboModule.mm:58-71` | 每个模块**只做一次**（结果进缓存），可接受 |
| DD-7 | `RCT_REMOVE_LEGACY_MODULE_INTEROP` 默认为 `'0'`，**移除 legacy 互操作需宿主显式设 ENV** | `scripts/react_native_pods.rb:123` | 破坏性变更默认关闭是正确选择；但文档中不易发现 |
| DD-8 | `performMethodInvocation` 的 `@try/@finally` **无编译门控**（Release 也编译） | `RCTTurboModule.mm:501-514` | **与 23 文档的 `RCT_CUSTOM_CONVERTER` 相反**；此处是对的（见 §9） |

### DD-8 是「正确的例外」

| | `RCT_CUSTOM_CONVERTER`（23 文档） | `performMethodInvocation`（本文） |
| --- | --- | --- |
| 门控 | `if (!RCT_DEBUG) { return code; }` | **无** |
| Release 行为 | 类型不匹配 → **崩溃** | 捕获异常 → 转 JSError 或重新抛出 |
| 是否合理 | ❌ | ✅ |

**判据**：模块方法抛 `NSException` 是**用户代码的运行时错误**，
不是类型系统问题；Release 下崩溃对用户毫无价值。
而 `RCT_CUSTOM_CONVERTER` 处理的是**开发期的 prop 类型错误**，
Release 下崩溃虽粗暴但「让错误早点暴露」也是一种策略。

> **同一个仓库对「Release 下要不要 `@try`」有两套做法**，
> 且各自有道理。**23 文档把它记为缺陷，本文补充它不是普遍规则。**

---

## 9. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 23 文档：`RCT_CUSTOM_CONVERTER` 的 Debug/Release 语义反转 | **补充**：这不是普遍规则 —— `performMethodInvocation` 的 `@try` 无条件编译且更合理（§9、DD-8） |
| 24 文档：`sendEvent:` 的状态机缺陷（先读未初始化 `eventID`） | **正面对照**：Promise 的四态防护是写对的（§5） |
| 25 文档：`RCTPLTag` 打点体系（22 个中 12 个零打点） | **补上另一套打点**：`TurboModulePerfLogger`（§4.5） |
| 28 文档：`REACT_NATIVE_DEBUGGER_MODE_PROD` 宿主手动 | **三方对照**：加能力自动开 / 移除能力手动开（§6.3） |
| 30 文档：`DefaultTurboModules` 的 C++ 优先注册 | **补上 iOS 侧的四步解析顺序**（§2），C++ 优先级一致 |
| 36 文档 §2.2：`propConfig` 用 `objc_msgSend` 调类方法 | **补上同型**：`getMethodInfos` 直接调用 IMP 取元信息（§7.1） |
| 36 文档 §5：注释质量三档 | **新增零档**（DD-1 无注释）与第一档实例（`:287`、`:309`、`T65905574`） |
| 37 文档 BB-8：跨回调持 `std::mutex` 且无注释 | **对照**：TurboModule 层的同类锁有完整注释（§3.2）→ **注释水平按模块新旧分层** |
| 38 文档 §8：隐蔽契约四种形态 | **新增第五种**：被文档化的无限等待（DD-3）—— **有注释故不算隐蔽**，但属同一类设计权衡 |
| 38 文档 §2.3：弱引用 + 强局部变量 | **新增同型实例**：`weakModule`（DD-5） |
| 05 文档：性能监控 | **补上 `TurboModulePerfLogger` 的同步/异步双打点**（§4.5） |
