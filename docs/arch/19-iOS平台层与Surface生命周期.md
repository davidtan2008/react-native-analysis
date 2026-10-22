---
id: 19
title: "iOS 平台层：Surface 生命周期与性能标记"
topic: RT.host
symptoms: [whitescreen, slowstart]
platforms: [ios]
architecture: [fabric]
layer: T3
symbols: ["SurfaceHandler", "RCTSurfaceHostingProxy"]
claims: [IOS-1, IOS-2, IOS-3, IOS-4, IOS-5, IOS-6, IOS-7, IOS-8, IOS-9, IOS-10]
---
# 19 · iOS 平台层：Surface 生命周期与性能标记

> **模块**：C1 + E10（`React/Base`、`React/Fabric`、`React/CoreModules`、`React/Views`、`React/Modules`、`ReactApple`）
> **基线**：react-native @ `9b131e42` · iOS 侧
> **前置**：[15 文档](./15-Android启动与宿主API.md) 讲了 Android 宿主与 `ReactMarker`；[12 文档](./12-UI一致性与ShadowTree修订版.md) 讲了修订版锁定。
> 本文讲 **iOS 的对应实现**，并逐条标出它与 Android 的**不对称** —— 这些差异是两轮复核中最容易出错的地方。

---

## 1. 目录构成（iOS 平台层 372 + 18 文件）

| 目录 | 文件数 | 内容 |
| --- | --- | --- |
| `React/Base/` | 122 | 基础设施（Surface / 性能标记 / 生命周期） |
| `React/Fabric/` | 115 | Fabric 挂载（`Mounting/ComponentViews` 占 58） |
| `React/CoreModules/` | 72 | 内建原生模块（**从未读过**） |
| `React/Views/` | 45 | 原生 View 实现 |
| `React/Modules/` | 18 | 遗留模块（含 `RCTUIManagerUtils.m`，见 08 文档） |
| `React/Base/Surface/` | 20 | **Surface 生命周期（本��重点）** |
| `React/Fabric/Mounting/` | 73 | 挂载实现 |
| `React/Fabric/Utils/` | 19 | 工具 |

---

## 2. `RCTSurfaceStage`：8 个位，实际只用 2 个

### 2.1 定义

`React/Base/Surface/RCTSurfaceStage.h:15-30`：

```objc
typedef NS_OPTIONS(NSInteger, RCTSurfaceStage) {
  RCTSurfaceStageSurfaceDidInitialize = 1 << 0, // Surface object was created
  RCTSurfaceStageBridgeDidLoad = 1 << 1, // Bridge was loaded
  RCTSurfaceStageModuleDidLoad = 1 << 2, // Module (JavaScript code) was loaded
  RCTSurfaceStageSurfaceDidRun = 1 << 3, // Module (JavaScript code) was run
  RCTSurfaceStageSurfaceDidInitialRendering = 1 << 4, // UIManager created the first shadow views
  RCTSurfaceStageSurfaceDidInitialLayout = 1 << 5, // UIManager completed the first layout pass
  RCTSurfaceStageSurfaceDidInitialMounting = 1 << 6, // UIManager completed the first mounting pass
  RCTSurfaceStageSurfaceDidStop = 1 << 7, // Surface stopped

  // Most of the previously existed stages make no sense in the new architecture;
  // now Surface exposes only two simple stages:
  RCTSurfaceStagePreparing = RCTSurfaceStageSurfaceDidInitialize | RCTSurfaceStageBridgeDidLoad |
      RCTSurfaceStageModuleDidLoad,
  RCTSurfaceStageRunning = RCTSurfaceStagePreparing | RCTSurfaceStageSurfaceDidRun |
      RCTSurfaceStageSurfaceDidInitialRendering | RCTSurfaceStageSurfaceDidInitialLayout |
      RCTSurfaceStageSurfaceDidInitialMounting,
};
```

**注释自己说明「旧的 8 个 stage 在新架构下没有意义，现在只暴露两个」** ——
这是罕见的「注释即现状」的诚实写法。

### 2.2 但 8 个位中 7 个从未被写入

Fabric 路径下 `stage` 的唯一取值来源（`React/Fabric/Surface/RCTFabricSurface.mm:160-164`）：

```objc
- (RCTSurfaceStage)stage
{
  return _surfaceHandler->getStatus() == SurfaceHandler::Status::Running ? RCTSurfaceStageRunning
                                                                         : RCTSurfaceStagePreparing;
}
```

**二选一，不逐位累积。** 检索各位的实际使用：

| 位 | 被读次数 | 被写入次数 |
| --- | --- | --- |
| `SurfaceDidInitialLayout` | 2 | 0 |
| `SurfaceDidStop` | 2 | **0** |
| 其余 6 个 | **0** | 0 |

**`RCTSurfaceStageSurfaceDidStop` 从未被设置**（全仓库 0 处赋值点），
所以判定函数里的 `!(stage & RCTSurfaceStageSurfaceDidStop)` 恒为真。

### 2.3 两个判定函数只看 2 个位

`React/Base/Surface/RCTSurfaceStage.m:10-18`：

```objc
BOOL RCTSurfaceStageIsRunning(RCTSurfaceStage stage)
{
  return (stage & RCTSurfaceStageSurfaceDidInitialLayout) && !(stage & RCTSurfaceStageSurfaceDidStop);
}

BOOL RCTSurfaceStageIsPreparing(RCTSurfaceStage stage)
{
  return !(stage & RCTSurfaceStageSurfaceDidInitialLayout) && !(stage & RCTSurfaceStageSurfaceDidStop);
}
```

**只检查 `InitialLayout` 与 `Stopped` 两个位**，与 8 位定义无关。

> **看起来是巧合，实际是自洽的**。手工验算：
> `Preparing = 1|2|4 = 7`（不含 `InitialLayout` 的 `32`），
> `Running = 7|8|16|32|64 = 127`（含 `32`）。
> 因此 `IsRunning(Running)=true`、`IsPreparing(Preparing)=true`，
> 交叉组合均为 `false` —— **两个函数恰好只认聚合常量**。
>
> 但这是**依赖聚合常量的位定义**才成立，不是显式设计。
> 若有人给 `RCTSurfaceStageRunning` 增删一位，两个函数的语义会静默改变。

---

## 3. `stage` 的唯一实质用途：控制 rootView 挂载

`React/Base/Surface/RCTSurfaceView.mm:74-83`：

```objc
- (void)_updateStage
{
  if (RCTSurfaceStageIsRunning(_stage)) {
    if (_rootView && _rootView.superview != self) {
      [self addSubview:_rootView];
    }
  } else {
    [_rootView removeFromSuperview];
  }
}
```

**这是「准备中不显示 React 内容」的实现点** —— 与 05 文档的白屏主题直接相关。

`RCTSurfaceHostingView.mm:74-85` 则用它决定尺寸来源：

```objc
- (CGSize)intrinsicContentSize
{
  if (RCTSurfaceStageIsPreparing(_stage)) {
    if (_activityIndicatorView) {
      return _activityIndicatorView.intrinsicContentSize;
    }

    return CGSizeZero;
  }

  return _surface.intrinsicSize;
}
```

### 3.1 「准备中」是否有兜底 UI？—— 取决于宿主

`_activityIndicatorView` 只在有 factory 时才创建（`:147-151`）：

```objc
    if (_activityIndicatorViewFactory) {
      _activityIndicatorView = _activityIndicatorViewFactory();
      _activityIndicatorView.frame = self.bounds;
      _activityIndicatorView.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
      [self addSubview:_activityIndicatorView];
```

而 factory 由宿主设置（`RCTSurfaceHostingProxyRootView.mm:104-113`）：

```objc
- (UIView *)loadingView
{
  return super.activityIndicatorViewFactory ? super.activityIndicatorViewFactory() : nil;
}

- (void)setLoadingView:(UIView *)loadingView
{
  super.activityIndicatorViewFactory = ^UIView *(void) {
    return loadingView;
  };
}
```

> **结论：iOS 的「加载中」兜底 UI 完全由 App 决定。**
> 不设 `loadingView` → `_activityIndicatorView` 为 nil → 准备中尺寸为 `CGSizeZero` → **真白屏**。
>
> 这与 `RCTRootView.h:136-140` 的 `loadingView` 属性说明一致
> （「By default this is nil, but you can override it」）。
> **框架不提供默认 spinner** —— 这是 05 文档「无白屏检测」之外的另一个相关事实：
> 不仅**检测**没有，连**预防**都要 App 自己装。

---

## 4. 内存压力：iOS 有**两条**路径，都丢弃了等级

这是本文最重要的一节，也是对 05 / 15 文档的**重要修正**。

### 4.1 路径一：`RCTAppState` → JS 事件（bridge 模式）

`React/CoreModules/RCTAppState.mm:77-80`：

```objc
- (NSArray<NSString *> *)supportedEvents
{
  return @[ @"appStateDidChange", @"memoryWarning" ];
}
```

派发时（`:110-113`）：

```objc
- (void)handleMemoryWarning
{
  [self sendEventWithName:@"memoryWarning" body:nil];
}
```

JS 侧印证（`Libraries/AppState/AppState.js:141-142`）：

```js
        const memoryWarningHandler: () => void = handler;
        return emitter.addListener('memoryWarning', memoryWarningHandler);
```

**handler 类型是 `() => void` —— 明确不接收任何参数。**

### 4.2 路径二：`RCTInstance` → C++ （bridgeless 模式）

`ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm:150-157`：

```objc
    [[NSNotificationCenter defaultCenter] addObserver:self
                                             selector:@selector(_handleMemoryWarning)
                                                 name:UIApplicationDidReceiveMemoryWarningNotification
                                               object:nil];
```

`RCTInstance.mm:642-650`：

```objc
- (void)_handleMemoryWarning
{
  if (_valid) {
    // Memory Pressure Unloading Level 15 represents TRIM_MEMORY_RUNNING_CRITICAL.
    static constexpr int unloadLevel = 15;
    _reactInstance->handleMemoryPressureJs(unloadLevel);
  }
}
```

**硬编码 `15`，注释说明它代表 `TRIM_MEMORY_RUNNING_CRITICAL`。**
即：iOS 侧**永远以「最高级别」上报**，
无论系统实际给的是 `UIApplicationMemoryWarningLevelWarning` 还是 `Critical`。

> **iOS 的内存压力等级被完全丢弃**。全仓库验证：
>
> ```bash
> $ grep -rniE "MemoryWarningLevel|userInfo\[.*MemoryWarning" \
>     packages/react-native/React packages/react-native/ReactCommon packages/react-native/Libraries
> （无输出）
> ```
>
> iOS 系统提供了 `UIApplicationMemoryWarningLevelKey`（normal / warning / critical / low），
> RN 两处处理器**都没有读取 `NSNotification` 参数**。

### 4.3 C++ 侧：共用 Android 枚举，按等级决定是否 GC

**iOS 与 Android 走的是同一个 C++ 入口** `ReactInstance::handleMemoryPressureJs`
（`ReactCommon/react/runtime/ReactInstance.cpp:652`）。

而这个函数的枚举**全是 Android 的 `TRIM_MEMORY_*`**：

```cpp
void ReactInstance::handleMemoryPressureJs(int pressureLevel) {
  // The level is an enum value passed by the Android OS to an onTrimMemory
  // event callback. Defined in ComponentCallbacks2.
  enum AndroidMemoryPressure {
```

第二个 switch 决定行为（`:691-719`）：

| 等级 | 数值 | 行为 |
| --- | --- | --- |
| `TRIM_MEMORY_RUNNING_LOW` | 10 | **忽略**（non-severe） |
| `TRIM_MEMORY_RUNNING_MODERATE` | 5 | **忽略** |
| `TRIM_MEMORY_UI_HIDDEN` | 20 | **忽略** |
| `TRIM_MEMORY_BACKGROUND` | 40 | 触发 `collectGarbage` |
| `TRIM_MEMORY_MODERATE` | 60 | 触发 `collectGarbage` |
| `TRIM_MEMORY_COMPLETE` | 80 | 触发 `collectGarbage` |
| `TRIM_MEMORY_RUNNING_CRITICAL` | **15** | 触发 `collectGarbage` |
| 其他 | — | `LOG(WARNING) unrecognized pressure level` |

GC 调用（`:706-711`）：

```cpp
      LOG(INFO) << "Memory warning (pressure level: " << levelName
                << ") received by JS VM, running a GC";
      runtimeScheduler_->scheduleWork([=](jsi::Runtime& runtime) {
        TraceSection s("ReactInstance::handleMemoryPressure");
        runtime.instrumentation().collectGarbage(levelName);
      });
```

### 4.4 由此得出的跨平台行为差异

| 维度 | iOS | Android |
| --- | --- | --- |
| 回调来源 | `UIApplicationDidReceiveMemoryWarningNotification` | `ComponentCallbacks2.onTrimMemory(level)` |
| **等级来源** | **硬编码 15**（`RCTInstance.mm:645`） | 系统传入真实等级（`MemoryPressureRouter.kt:40`） |
| 是否触发 GC | **每次通知都触发**（15 落在「严重」分支） | **仅严重等级触发**，LOW/MODERATE/UI_HIDDEN 显式忽略 |
| 是否发 JS 事件 | ✅ `RCTAppState` 发 `memoryWarning`（bridge 模式） | ❌ 无（见 15 文档 §6） |

**三条结论：**

1. **iOS 无法分级响应** —— 系统给了 4 档，RN 只当最高档处理。
2. **iOS 每次内存警告都做一次完整 GC** —— Android 侧会忽略较轻的等级，
   iOS 侧不能。这在多次轻微警告的场景下会造成**不必要的 GC 停顿**。
3. **iOS 特有的「双通道」** —— 同一系统通知既进 C++ 触发 GC（`RCTInstance`），
   又发 JS 事件（`RCTAppState`）。**两个处理器各自独立注册**
   （`RCTInstance.mm:155` 与 `RCTAppState.mm:97-100`），
   所以一次内存警告在 bridge 模式下会被处理两次。

> **对 05 文档的修正**：05 文档把 OOM 检测列为「大缺口」，
> 但事实是 **C++ 侧确实有分级 GC 响应**（`handleMemoryPressureJs`），
> 缺的是「JS 可见性」与「iOS 的等级保真」。
> 这是「有实现但不完整」，不是「完全没有」。

### 4.5 `stopObserving` 全量移除观察者

`RCTAppState.mm:103-106`：

```objc
- (void)stopObserving
{
  [[NSNotificationCenter defaultCenter] removeObserver:self];
}
```

**不带 name 参数 = 移除该对象在 defaultCenter 上的全部观察。**
本次只注册了 6 个（`:84-100`），所以当前安全。
但若未来有人用同一 `self` 注册了其他通知，会被一并移除。

---

## 5. 性能标记：iOS 与 Android 的显著不对称

### 5.1 `RCTPLTag` —— iOS 侧 22 个

`React/Base/RCTPLTag.h:8-30`：

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

**22 个枚举**（最后一个 `RCTPLSize` 只是计数哨兵，实际 21 个标记）。

### 5.2 与 Android 的数量对比

| 平台 | 机制 | 数量 | 有 listener? |
| --- | --- | --- | --- |
| **Android** | `ReactMarkerConstants` | **114** 个枚举 / 13 个带 `true` | ✅ `ReactMarker.addListener` |
| **iOS** | `RCTPLTag` + `RCTPerformanceLogger` | **22** 个 | ❌ **无 listener** |

**iOS 的标记数量不到 Android 的 1/5，且没有对外的监听接口。**

`RCTPerformanceLogger.h:11-73` 提供的方法：

```objc
- (void)markStartForTag:(RCTPLTag)tag;
- (void)markStopForTag:(RCTPLTag)tag;
- (void)setValue:(int64_t)value forTag:(RCTPLTag)tag;
- (void)addValue:(int64_t)value forTag:(RCTPLTag)tag;
- (void)appendStartForTag:(RCTPLTag)tag;
- (void)appendStopForTag:(RCTPLTag)tag;
- (NSArray<NSNumber *> *)valuesForTags;
- (int64_t)durationForTag:(RCTPLTag)tag;
- (int64_t)valueForTag:(RCTPLTag)tag;
```

**只能查询（`durationForTag:` / `valuesForTags`），不能订阅。**
App 若要拿到启动耗时，只能在特定时机主动轮询 —— 且
`RCTPerformanceLogger` 实例在 `RCTInstance.mm:203` 销毁时被置 nil。

### 5.3 iOS 仍会收到 C++ 侧的 ReactMarker —— 但只能有一个消费者

`ReactCommon/react/runtime/platform/ios/ReactCommon/RCTPerformanceLoggerUtils.mm:15-63`：

```objc
static void mapReactMarkerToPerformanceLogger(
    const ReactMarker::ReactMarkerId markerId,
    RCTPerformanceLogger *performanceLogger)
{
  switch (markerId) {
    case ReactMarker::APP_STARTUP_START:
      [performanceLogger markStartForTag:RCTPLAppStartup];
      break;
    ...
    case ReactMarker::CREATE_REACT_CONTEXT_STOP:
    case ReactMarker::JS_BUNDLE_STRING_CONVERT_START:
    case ReactMarker::JS_BUNDLE_STRING_CONVERT_STOP:
    case ReactMarker::REGISTER_JS_SEGMENT_START:
    case ReactMarker::REGISTER_JS_SEGMENT_STOP:
      // These are not used on iOS.
      break;
  }
}

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

**注意 `case ... : break;` 里明确列出了 5 个「These are not used on iOS」的标记。**
`switch` 无 `default` 分支 —— 未来 C++ 侧新增标记时会被静默忽略。

**关键的架构差异**：`registerPerformanceLoggerHooks` 赋值给
`ReactMarker::logTaggedMarkerImpl`，而后者是（`ReactCommon/cxxreact/ReactMarker.h:75`）：

```cpp
extern RN_EXPORT AtomicLogTaggedMarker logTaggedMarkerImpl;
```

**单个全局函数指针，不是 listener 列表。**

| 维度 | Android `ReactMarker` | iOS `RCTPerformanceLogger` |
| --- | --- | --- |
| 注册方式 | `addListener()` 可注册多个 | **直接覆盖全局函数指针** |
| 多个消费者 | ✅ | ❌ **后注册者顶掉前者** |
| 移除 | `removeListener()` | 只能再赋一次 |
| 通知顺序 | 按注册顺序 | 无（只有一个） |

> **多 `RCTInstance` 场景下存在隐患**：第二次 `registerPerformanceLoggerHooks`
> 会覆盖第一次的指针，且第一个 logger 的 weak 引用被丢弃
> —— 第一个实例的性能数据从此不再更新。
> 源码无任何警告或断言。

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| IOS-1 | **iOS 硬编码 `unloadLevel = 15`** —— 系统提供的 4 档等级被压缩成「最高档」，导致每次内存警告都触发完整 GC | `ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm:645-646` | 无法分级响应；轻微警告也做全量 GC，造成不必要停顿 |
| IOS-2 | iOS 内存压力**双通道重复处理** —— `RCTInstance` 触发 C++ GC 与 `RCTAppState` 发 JS 事件各自独立注册 | `RCTInstance.mm:155` 与 `RCTAppState.mm:97-100` | 一次通知走两条路径，职责边界不清 |
| IOS-3 | `RCTSurfaceStage` 8 个位中 7 个从未被写入；`SurfaceDidStop` 0 处赋值 | `React/Fabric/Surface/RCTFabricSurface.mm:160-164` | 细粒度阶段信息实际不存在，只有 Running/Preparing 两态 |
| IOS-4 | 两个判定函数只看 2 个位，自洽性依赖聚合常量的位定义 | `React/Base/Surface/RCTSurfaceStage.m:10-18` | 若增删聚合常量的位，判定语义会静默改变 |
| IOS-5 | `logTaggedMarkerImpl` 是单槽位全局指针，无锁 | `ReactCommon/cxxreact/ReactMarker.h:75` | 多实例时后注册者顶掉前者；第三方 SDK 无法并存 |
| IOS-6 | `RCTPerformanceLogger` 无 listener 接口，只能轮询 | `React/Base/RCTPerformanceLogger.h:11-73` | App 难以接入 APM；Android 侧有 `addListener` |
| IOS-7 | `mapReactMarkerToPerformanceLogger` 的 switch 无 `default` | `ReactCommon/react/runtime/platform/ios/ReactCommon/RCTPerformanceLoggerUtils.mm:15-63` | C++ 新增标记时 iOS 侧静默丢弃 |
| IOS-8 | 「准备中」无默认兜底 UI，依赖宿主注入 factory | `React/Base/Surface/SurfaceHostingView/RCTSurfaceHostingView.mm:147-151` | 不设 `loadingView` 即真白屏 |
| IOS-9 | `stopObserving` 用无 name 的 `removeObserver:` 全量移除 | `React/CoreModules/RCTAppState.mm:103-106` | 当前安全，但未来复用同一 self 注册其他通知会被误删 |
| IOS-10 | C++ 侧枚举全为 Android `TRIM_MEMORY_*`，iOS 靠数值 15 巧合命中 | `ReactCommon/react/runtime/ReactInstance.cpp:653-656` | 语义错位：iOS 的「critical」被当作 Android 的 RUNNING_CRITICAL |

**IOS-1 / IOS-10 应回补到 05 文档**（OOM 专题）；
**IOS-8 应回补到 05 文档的白屏章节**（不只没有检测，预防也要 App 自装）。

---

## 7. 与其他文档的衔接

- Android 对照（`ReactMarker` 114 个 + `addListener`）→ [15 文档 §5](./15-Android启动与宿主API.md)
- Android 内存压力只到 C++ 不进 JS → [15 文档 §6](./15-Android启动与宿主API.md)
- UI 一致性与修订版锁定（C++ 侧）→ [12 文档](./12-UI一致性与ShadowTree修订版.md)
- 视图扁平化决定哪些节点有原生视图 → [10 文档](./10-Fabric组件层与视图扁平化.md)
- 崩溃链路的 iOS 侧（`RCTExceptionsManager` / `RCTRedBox`）→ [04 文档](./04-崩溃日志捕获收集处理上传.md)
- 内存压力 OOM 专题（需回补 IOS-1）→ [05 文档](./05-监控检测原理与流程.md)

---

## 8. 本文覆盖边界

| 范围 | 状态 |
| --- | --- |
| `React/Base/Surface/`（20 文件） | ✅ 已读 |
| `RCTPLTag` / `RCTPerformanceLogger` 体系 | ✅ 已读 |
| `RCTAppState` 内存压力路径 | ✅ 已读 |
| `RCTFabricSurface` stage 管理 | ✅ 已读 |
| `Fabric/Mounting/`（73 文件） | ❌ **未读** |
| `CoreModules/`（72 文件） | ❌ **未读**（仅读 `RCTAppState`） |
| `Views/`（45 文件）、`Modules/`（18） | ❌ **未读** |
| `ReactApple/`、`CxxModule` | ❌ **未读** |

C1 模块已读 35 → 本文新增约 14 个文件，**仍有约 320 个未读**。

---

## 9. 验证方式

```bash
node docs/arch/audit/audit-citations.mjs    # 引用可达性
node docs/arch/audit/verify-quotes.mjs      # 代码块语义
node docs/arch/audit/verify-claims.mjs      # 核心事实断言
```
