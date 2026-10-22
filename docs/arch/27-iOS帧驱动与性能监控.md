---
id: 27
title: "iOS 帧驱动与性能监控：RCTTiming / RCTPerfMonitor / RCTFPSGraph"
topic: DG.perf
symptoms: [jank]
platforms: [ios]
architecture: [cross]
layer: T3
symbols: ["RCTPerformanceLogger", "RCTFrameUpdate"]
claims: []
---
# 27 · iOS 帧驱动与性能监控：RCTTiming / RCTPerfMonitor / RCTFPSGraph

> **模块**：C1 · `CoreModules/` 的帧监控族（3 文件 / 1057 行）+ `Base/RCTDisplayLink.m` / `RCTFrameUpdate`
> **基线**：react-native @ `9b131e42` · iOS 侧
> **前置**：[03 文档](./03-核心技术原理.md) 讲了 Fabric 的帧循环；
> [05 文档](./05-监控检测原理与流程.md) §7 讲了卡顿/掉帧；
> [25 文档](./25-iOS桥接核心与启动性能标签.md) 讲了 `RCTPLTag` 的打点覆盖。
>
> 本文补上 **legacy 架构的帧驱动全链路**（`CADisplayLink` → `RCTTiming` → JS 定时器），
> 并记录 `RCTPerfMonitor` 里的 **4 个实质问题**：
> 两个空调用、一处进程级 stderr 劫持、一处指标数组错位。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `CoreModules/RCTPerfMonitor.mm` | 561 | Dev 性能浮层（FPS 图 / 内存 / 视图数 / 指标表） |
| `CoreModules/RCTTiming.mm` | 368 | 帧驱动 + JS 定时器调度 |
| `CoreModules/RCTFPSGraph.mm` | 128 | FPS 曲线绘制 |
| `Base/RCTDisplayLink.m` | 107 | `CADisplayLink` 封装 + 暂停协商 |
| `Base/RCTFrameUpdate.h` / `.m` | 52 / 27 | 帧信息载体 + observer 协议 |

---

## 2. 整族都是 `#if RCT_DEV` 或 Dev-only

### 2.1 `RCTFPSGraph` 整个文件被包裹

`CoreModules/RCTFPSGraph.mm` 的 `:10` 是 `#if RCT_DEV`，
`:128` 是 `#endif` —— **中间 118 行全部只在 Debug 编译**。

`CoreModules/RCTPerfMonitor.mm` 同样：`:12` 是 `#if RCT_DEV`，`:552` 是 `#endif`。

但两者的**注册入口用了另一种写法**（`RCTPerfMonitor.mm:554-561`）：

```objc
Class RCTPerfMonitorCls(void)
{
#if RCT_DEV
  return RCTPerfMonitor.class;
#else
  return nil;
#endif
}
```

**类工厂函数永远存在，Release 下返回 `nil`。**
这与 [22 文档](./22-iOS崩溃UI层RedBox与LogBox.md) 记录的
「`moduleName` 返回 `nil` → 静默不注册」是同一种隐藏手法，
但**更彻底** —— 连类型都不存在，注册方拿到 `nil` 后走
`NSClassFromString` 式的匹配，直接跳过。

> **结论**：**Release 下没有任何帧率/内存/视图数的运行时采集**。
> 这与 [05 文档](./05-监控检测原理与流程.md) 的
> 「卡顿/掉帧检测 ⚠️ 仅 Dev」完全一致，本文补上了源码级机制：
> 不是「开关关掉了」，而是**整段代码不参与编译**。

### 2.2 但 `RCTTiming` 不在此列

`RCTTiming.mm` **没有** `#if RCT_DEV` 包裹 —— 它是生产代码。
这是合理的：JS 定时器（`setTimeout` / `setInterval` / `requestAnimationFrame`）
在生产环境必须工作。

---

## 3. 帧驱动全链路

```
CADisplayLink (JS 线程 run loop)
  └─ RCTDisplayLink._jsThreadUpdate:              [Base/RCTDisplayLink.m:80]
       ├─ RCTFrameUpdate *frameUpdate = [[RCTFrameUpdate alloc] initWithDisplayLink:displayLink]
       ├─ if (!_frameUpdateObserver.paused)
       │    [_frameUpdateObserver didUpdateFrame:frameUpdate]        [:90]
       └─ [self updateJSDisplayLinkState]                            [:92]
            └─ _jsDisplayLink.paused = (_frameUpdateObserver == nil || .paused)   [:104]
  └─ RCTTiming.didUpdateFrame:                    [CoreModules/RCTTiming.mm:227]
       ├─ 遍历 _timers，挑出应触发的                       [:233-239]
       ├─ 按 target 排序后交给 delegate                     [:244-247]
       ├─ repeats 的 reschedule / 一次性的移除              [:250-259]
       ├─ if (_sendIdleEvents) → callIdleCallbacks:        [:261-268]
       └─ 决定是否 _paused = YES 或 scheduleSleepTimer:     [:277-292]
```

### 3.1 暂停协商：一个双向握手

这是本文最值得记录的设计 —— **`RCTDisplayLink` 与 observer 用两个方向协商暂停**。

**方向一：DisplayLink 问 observer**（`RCTDisplayLink.m:88-91`）：

```objc
  // This always runs on the JS thread run loop, which is the queue the frame
  // update observer expects its callbacks on, so dispatch inline.
  RCTFrameUpdate *frameUpdate = [[RCTFrameUpdate alloc] initWithDisplayLink:displayLink];
  if (!_frameUpdateObserver.paused) {
    [_frameUpdateObserver didUpdateFrame:frameUpdate];
  }
```

**方向二：observer 要求 DisplayLink 更新状态**（`RCTDisplayLink.m:34-53`）：

```objc
    __weak typeof(self) weakSelf = self;
    observer.pauseCallback = ^{
      typeof(self) strongSelf = weakSelf;
      if (!strongSelf) {
        return;
      }

      CFRunLoopRef cfRunLoop = [strongSelf->_runLoop getCFRunLoop];
      if (!cfRunLoop) {
        return;
      }

      if ([NSRunLoop currentRunLoop] == strongSelf->_runLoop) {
        [weakSelf updateJSDisplayLinkState];
      } else {
        CFRunLoopPerformBlock(cfRunLoop, kCFRunLoopDefaultMode, ^{
          @autoreleasepool {
            [weakSelf updateJSDisplayLinkState];
          }
        });
        CFRunLoopWakeUp(cfRunLoop);
      }
    };
```

**`pauseCallback` 是在别的线程被调用的可能性很高**（`RCTTiming.mm:285/:290`
从任意线程设置 `_paused`），所以块里做了**跨 run loop 转发**：
若不在同一 run loop，用 `CFRunLoopPerformBlock` + `CFRunLoopWakeUp` 切过去。

而 `RCTDisplayLink.m:92` 的注释解释了为什么可以这么干：

> `// This always runs on the JS thread run loop, which is the queue the frame update observer expects its callbacks on, so dispatch inline.`

**即「不需要额外 dispatch，因为已经在对的 run loop 上」** —— 避免了不必要的跨线程跳转。

### 3.2 `RCTTiming` 的暂停判定：三档

`RCTTiming.mm:277-292`：

```objc
  if (_inBackground) {
    if (timerCount != 0u) {
      [self scheduleSleepTimer:nextScheduledTarget];
    }
  } else if (!_sendIdleEvents && timersToCall.count == 0) {
    // No need to call the pauseCallback as RCTDisplayLink will ask us about our paused
    // status immediately after completing this call
    if (timerCount == 0) {
      _paused = YES;
    }
    // If the next timer is more than 1 second out, pause and schedule an NSTimer;
    else if ([nextScheduledTarget timeIntervalSinceNow] > kMinimumSleepInterval) {
      [self scheduleSleepTimer:nextScheduledTarget];
      _paused = YES;
    }
  }
```

| 状态 | 动作 |
| --- | --- |
| 后台 + 有定时器 | `scheduleSleepTimer:`（用 `NSTimer` 兜底，绕过 DisplayLink） |
| 前台 + 无本帧触发 + **无任何定时器** | `_paused = YES`（DisplayLink 停止） |
| 前台 + 无本帧触发 + 最近定时器 **> 1 秒后** | `_sleepTimer` + `_paused = YES` |
| 前台 + 无本帧触发 + 最近定时器 **≤ 1 秒后** | **保持唤醒**（下一帧就会触发） |

`kMinimumSleepInterval = 1`（`:15`）就是这 1 秒阈值。

> **设计意图很清晰**：无定时器时彻底停 DisplayLink（省电）；
> 有近期待定时器时保持唤醒（避免错过一帧导致定时器延迟）；
> 远期定时器用 `NSTimer` 兜底（DisplayLink 可以停）。

### 3.3 空闲回调的帧预算判断

`RCTTiming.mm:261-268`：

```objc
  if (_sendIdleEvents) {
    NSTimeInterval frameElapsed = (CACurrentMediaTime() - update.timestamp);
    if (kFrameDuration - frameElapsed >= kIdleCallbackFrameDeadline) {
      NSTimeInterval currentTimestamp = [[NSDate date] timeIntervalSince1970];
      NSNumber *absoluteFrameStartMS = @((currentTimestamp - frameElapsed) * 1000);
      [_timingDelegate callIdleCallbacks:absoluteFrameStartMS];
    }
  }
```

**只有当本帧剩余时间 ≥ 1ms 时才发空闲回调** —— 避免在帧末尾再插入工作导致掉帧。

两个常量（`:19, :21`）：

```objc
static const NSTimeInterval kFrameDuration = 1.0 / 60.0;
static const NSTimeInterval kIdleCallbackFrameDeadline = 0.001;
```

### 3.4 跨语言常量双向声明同步（良好实践）

`RCTTiming.mm:17-18` 的注释：

```objc
// These timing contants should be kept in sync with the ones in `JSTimers.js`.
```

而 `Libraries/Core/Timers/JSTimers.js:34-37` 反向声明：

```js
// These timing constants should be kept in sync with the ones in native ios and
// android `RCTTiming` module.
const FRAME_DURATION = 1000 / 60;
const IDLE_CALLBACK_FRAME_DEADLINE = 1;
```

**两侧互相声明、互相引用，且单位各自匹配**（ObjC 用秒、JS 用毫秒），
逻辑值一致（16.67ms / 1ms）。**这是全仓库少见的双向同步声明**，
值得作为正面样本记录 —— 与 [26 文档 I-1](./26-iOS-Base余部网络图像与快捷键.md)
的运算符优先级 bug 形成对照：同样的两处常量，一处有同步约定，一处算错。

---

## 4. `RCTPerfMonitor`：四个实质问题

### 4.1 【空调用】`RCTJSCSetOption` 恒返回 `NO`

`RCTPerfMonitor.mm:44-47`：

```objc
static BOOL RCTJSCSetOption(const char *option)
{
  return NO;
}
```

**函数体只有一句 `return NO`，参数 `option` 未使用。**

但它在 `:298` 和 `:331` 被真实调用：

```objc
  [self redirectLogs];

  RCTJSCSetOption("logGC=1");
```

```objc
  RCTJSCSetOption("logGC=0");
```

**即「打开 JSC GC 日志」和「关闭 JSC GC 日志」两次调用都是空操作。**

> **为什么它是空的**：JSC（JavaScriptCore）已被 Hermes 取代，
> `logGC` 是 JSC 的调试开关。当前代码库默认 Hermes，
> 所以这个函数被留成了永不生效的桩。
>
> **后果**：§4.2 的 `redirectLogs` 仍然完整实现了 stderr 劫持与正则解析 ——
> **但它捕获的对象（GC 日志）永远不会产生**。
> 即整个 GC 监控子系统是**完整实现 + 无效输入源**。

### 4.2 【进程级副作用】`redirectLogs` 劫持全局 stderr

`RCTPerfMonitor.mm:342-378`：

```objc
- (void)redirectLogs
{
  _stderr = dup(STDERR_FILENO);

  if (pipe(_pipe) != 0) {
    return;
  }

  dup2(_pipe[1], STDERR_FILENO);
  close(_pipe[1]);
```

**`dup2(_pipe[1], STDERR_FILENO)` 把进程级文件描述符 2 整体重定向到管道。**

| 事实 | 影响 |
| --- | --- |
| `STDERR_FILENO` 是**进程全局** | 影响进程内**所有**写 stderr 的代码，不限于 RN |
| `redirectLogs` 在 `show`（`:296`）里调 | 打开 Dev 菜单的性能浮层即触发 |
| `stopLogs`（`:380-384`）里 `dup2(_stderr, ...)` 还原 | 关闭浮层时恢复 |

**这是一次「以调试工具之名修改全局状态」的做法**：
如果 App 内其他组件（自研 SDK、第三方库）在浮层开启期间写 stderr，
那些输出会被 PerfMonitor 的 `parse:` 消费掉（`parse:` 不写回原 fd 之外的地方，
但 `write(self->_stderr, ...)` 会把内容**复制**回原始 fd，见 `:371`）。

> **好消息**：`:369-376` 的 `dispatch_data_apply` 里
> **先 `write(self->_stderr, buffer, size)` 把内容原样转写回备份 fd**，
> 再 `parse:` 提取。所以**其他代码的 stderr 输出不会丢失，只是多了一次拷贝**。
>
> **真正的风险点**：`pipe()` 失败时 `:346` 直接 `return`，
> 但 `:344` 的 `dup` **已经执行** → **泄漏一个文件描述符**，
> 且此时 `_io` 为 `nil`，而 `stopLogs:383` 的
> `dispatch_io_close(_io, 0)` **不检查 nil**。

### 4.3 【指标错位】哨兵标签产生一行 `: 0ms`

`RCTPerfMonitor.mm:543-550`：

```objc
NSArray<NSString *> *LabelsForRCTPerformanceLoggerTags()
{
  NSMutableArray<NSString *> *labels = [NSMutableArray new];
  for (int i = 0; i < RCTPLSize; i++) {
    [labels addObject:RCTPLLabelForTag((RCTPLTag)i)];
  }
  return labels;
}
```

**循环条件是 `i < RCTPLSize`，因此包含哨兵 `RCTPLSize` 本身**（索引 22）。
而 `RCTPLLabelForTag` 对哨兵的处理是
（`RCTPerformanceLoggerLabels.m:46-49`）：

```objc
    case RCTPLSize: // Only used to count enum size
      RCTAssert(NO, @"RCTPLSize should not be used to track performance timestamps.");
      return nil;
```

**返回 `nil`** —— 于是 `labels` 的最后一项是 `nil`。

消费端 `RCTPerfMonitor.mm:486-496`：

```objc
  for (NSString *label in LabelsForRCTPerformanceLoggerTags()) {
    long long value = values[i + 1].longLongValue - values[i].longLongValue;
    NSString *unit = @"ms";
    if ([label hasSuffix:@"Size"]) {
      unit = @"b";
    } else if ([label hasSuffix:@"Count"]) {
      unit = @"";
    }
    [data addObject:[NSString stringWithFormat:@"%@: %lld%@", label, value, unit]];
    i += 2;
  }
```

**结果**：

| 项 | 表现 |
| --- | --- |
| `labels.count` | 23（含哨兵） |
| `values.count` | 46（`valuesForTags` 同样遍历 `i < RCTPLSize`，`RCTPerformanceLogger.mm:118`） |
| 最后一次循环 `i` | 44 → 访问 `values[44]`/`values[45]`，**在界内** ✅ |
| `labels[22]` | `nil` → `[nil hasSuffix:]` 返回 `NO` → `unit = @"ms"` |
| 格式化输出 | **`": 0ms"`**（`nil` 格式化为空串） |

**即指标表最后会多出一行只有 `": 0ms"` 的条目，标签名为空。**

> **不会崩溃** —— `values` 长度足够，且向 `nil` 发消息返回 `NO`/`0`。
> 这是**显示层缺陷**而非功能缺陷。
>
> 顺带印证 [25 文档 M-8](./25-iOS桥接核心与启动性能标签.md)：
> 那个 `RCTAssert(NO, ...)` 在 Debug 下会触发系统 `NSAssertionHandler`，
> 在 Release 下（`RCT_DEV=0`）**整段代码不编译**，两种情况都不产生可见提示。

### 4.4 【已验证非缺陷】`_bridge.uiManager` 在 bridgeless 下是通的

`RCTPerfMonitor.mm:418`：

```objc
  NSDictionary<NSNumber *, UIView *> *views = [_bridge.uiManager valueForKey:@"viewRegistry"];
```

**`RCTBridge` 类上并没有 `uiManager` 属性** —— 它只声明在
`RCTBridgeProxy` 上（`Base/RCTBridgeProxy.mm:358-361`）：

```objc
- (RCTUIManager *)uiManager
{
  return (RCTUIManager *)_uiManagerProxy;
}
```

**但这不构成缺陷**，因为 `RCTPerfMonitor` 的 `bridge` 在 bridgeless 下
正是 `RCTBridgeProxy`（`_bridge` 由 `RCTBridgeModuleDecorator` 的兄弟机制注入，
或直接由 `RCTInstance` 设置）。

`RCTUIManagerProxy` 持有真实的 `RCTViewRegistry`
（`RCTBridgeProxy.mm:402-405`）：

```objc
@implementation RCTUIManagerProxy {
  RCTViewRegistry *_viewRegistry;
  NSMutableDictionary<NSNumber *, UIView *> *_legacyViewRegistry;
}
```

**所以 `valueForKey:@"viewRegistry"` 能取到真实字典，路径是通的。**

> **这一条值得记录，因为它初看像 [24 文档](./24-iOS事件分发触摸管线与JS加载.md)
> §3 那种「调用了不存在的方法」的断链**。
> 区别在于：`RCTBridgeProxy` 确实实现了它，
> 而 `RCTBridge` 的 `moduleDataForName:` / `batchedBridge`
> 在**任何类上都没有实现**。
>
> **教训**：看到「某个类上没声明的方法」不能直接判为断链 ——
> 必须同时检查**运行时对象实际是什么类型**。

### 4.5 视图计数：`view.window != nil` 的双重判空

`RCTPerfMonitor.mm:420-425`：

```objc
  NSUInteger visibleViewCount = 0;
  for (UIView *view in views.allValues) {
    if ((view.window != nullptr) || (view.superview.window != nullptr)) {
      visibleViewCount++;
    }
  }
```

**`(view.window != nil) || (view.superview.window != nil)`** ——
前一个条件成立时后一个根本不会求值。

`view.superview` 可能为 `nil`（游离视图），但由于 `||` 短路，
**只有在 `view.window == nil` 时才会访问 `view.superview.window`** ——
而 `view.window == nil` 恰恰意味着视图在层级内但未上屏，此时 `superview` 必然非 nil。

**逻辑上是安全的**，但写法脆弱：若哪天 `viewRegistry` 里混入无 superview 的游离视图，
`view.superview.window` 就是对 `nil` 发消息（返回 nil，不崩）。

### 4.6 自刷新链

`RCTPerfMonitor.mm:438-444`：

```objc
  __weak __typeof__(self) weakSelf = self;
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
    __strong __typeof__(weakSelf) strongSelf = weakSelf;
    if ((strongSelf != nullptr) && (strongSelf->_container.superview != nullptr)) {
      [strongSelf updateStats];
    }
  });
```

**每秒递归一次**，终止条件是 `_container.superview == nil`（即 `hide` 已执行）。
用 `weak/strong` 避免循环引用 —— 这是必要写法，否则每秒累积一个 block。

---

## 5. `RCTFPSGraph`：一次真实的垂直缩放

`RCTFPSGraph.mm:38-53` 的初始化：

```objc
    _frameCount = -1;
    _prevTime = -1;
    _maxFPS = 0;
    _minFPS = 60;
    _length = (NSUInteger)floor(frame.size.width);
    _height = (NSUInteger)floor(frame.size.height);
    _scale = 60.0 / (CGFloat)_height;
    _frames = (CGFloat *)calloc(sizeof(CGFloat), _length);
```

**用 `-1` 作为「未初始化」哨兵**（`_frameCount` 是 `NSUInteger`，
`-1` 赋值后实际是 `NSUIntegerMax`）。

`onTick:`（`:85-125`）的缩放逻辑：

```objc
    CGFloat previousScale = _scale;
    CGFloat targetFps = MAX(_maxFPS, 60.0);
    _scale = targetFps / (CGFloat)_height;
    for (NSUInteger i = 0; i < _length - 1; i++) {
      // Move each Frame back one position and adjust to new scale (if there is a new scale)
      _frames[i] = _frames[i + 1] * previousScale / _scale;
    }
    _frames[_length - 1] = (double)_FPS / _scale;
```

**每次有新最大值就重算 y 轴比例，并把历史数据全部按新比例换算。**

| 设计点 | 含义 |
| --- | --- |
| `MAX(_maxFPS, 60.0)` | y 轴上限**至少 60**，保证正常帧率下曲线不会顶到顶部 |
| `previousScale / _scale` | 历史点换算到新比例，保持视觉连续 |
| `_frames[_length]` 是 `calloc` 分配的**堆内存** | `dealloc` 里 `free(_frames)`（`:57-60`）—— 这是全文件唯一的堆分配 |

> **`_minFPS` 被更新（`:93`）但从未被读取** —— 又一个「维护了但没用」的字段。
> 核实这一点。

### 5.1 `_minFPS` 是死字段

`RCTFPSGraph.mm` 全文对 `_minFPS` 只有两处：**初始化为 60**（`:44`）与
**`MIN(_minFPS, _FPS)` 更新**（`:93`）。**没有任何读取或显示。**

同理 `_scale` 被读取用于换算，`_height` 被读取 —— 这两个是活的。

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| P-1 | **`RCTJSCSetOption` 恒 `return NO` 但被真实调用两次**（`logGC=1`/`logGC=0`） | `CoreModules/RCTPerfMonitor.mm:44-47`（调用点 `:298`、`:331`） | **GC 日志开关从未生效** → 整个 GC 监控子系统是「完整实现 + 无效输入源」 |
| P-2 | **`redirectLogs` 用 `dup2` 劫持进程级 `STDERR_FILENO`** | `CoreModules/RCTPerfMonitor.mm:350` | 影响进程内**所有** stderr 输出（当前因 `:371` 转写备份而不丢失，但多一次拷贝）；语义上属「调试工具修改全局状态」 |
| P-3 | **`pipe()` 失败时 `:346` 直接 return，但 `:344` 的 `dup` 已执行** | `CoreModules/RCTPerfMonitor.mm:344-348` | 泄漏一个 fd；且 `_io` 为 `nil` 时 `stopLogs:383` 的 `dispatch_io_close(nil, 0)` 无 nil 检查 |
| P-4 | **哨兵 `RCTPLSize` 被 `LabelsForRCTPerformanceLoggerTags` 遍历进去**，产生一行 `: 0ms` | `CoreModules/RCTPerfMonitor.mm:546-548` + `RCTPerformanceLoggerLabels.m:46-49` | 指标表多一行空标签；**不崩溃**（`values` 长度够、nil 消息安全） |
| P-5 | 零打点的 12 个标签在指标表里显示 `0ms`（两槽皆 0 时差值为 0） | `CoreModules/RCTPerfMonitor.mm:487` | 与 [06 文档 P2-3](./06-问题清单与优化建议.md) 一致；不配对时会显示巨大负数 |
| P-6 | `_minFPS` 被更新但**从未读取** | `CoreModules/RCTFPSGraph.mm:44, 93` | 死字段 |
| P-7 | `_bridge.uiManager` 在 `RCTBridge` 上无声明 | `CoreModules/RCTPerfMonitor.mm:418` | **已验证非缺陷** —— bridgeless 下对象是 `RCTBridgeProxy`，该类有实现（§4.4） |

### P-5 的机制补充

[25 文档 M-9](./25-iOS桥接核心与启动性能标签.md) 指出
`RCTPerformanceLogger` 的 `_data[tag][0]` 被三套 API 用三种语义写入。
`RCTPerfMonitor.mm:487` 是这套模型的**消费端**：

```objc
    long long value = values[i + 1].longLongValue - values[i].longLongValue;
```

**它内联复刻了 `durationForTag:`（`RCTPerformanceLogger.mm:125-128`）的算法。**

| 标签状态 | `_data[0]` | `_data[1]` | `value` | 显示 |
| --- | --- | --- | --- | --- |
| 零打点 | 0 | 0 | `0 - 0 = 0` | `0ms` |
| 正常配对 | start 时间 | stop 时间 | 时长 | 正常 |
| **只 start 未 stop** | 时间戳 | 0 | `0 - 时间戳` | **巨大负数** |
| `addValue:` 计数 | 0 | 数值 | `数值 - 0` | 正常（巧合） |

第三行正是 06 文档 P2-3 说的 `-<large>ms` ——
它发生在 `markStopForTag:` 因不配对而提前 return 时
（`RCTPerformanceLogger.mm:75-79` 只在配对时写 `_data[1]`）。

---

## 7. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 05 文档：「卡顿/掉帧检测 ⚠️ 仅 Dev」 | **补上源码机制**：整族被 `#if RCT_DEV` 裁剪，且类工厂 Release 返回 `nil`（§2.1） |
| 05 文档：`RCTFPSGraph` 受 `#if RCT_DEV` | **确认并补上 `RCTPerfMonitor` 同样如此**，以及 `RCTPerfMonitorCls` 的 nil 返回 |
| 03 文档：事件循环与帧更新 | **补上 legacy 对应物**：`RCTDisplayLink` ↔ `RCTTiming` 的双向暂停握手（§3.1） |
| 06 文档 P2-3：12 个 tag 恒为 `0ms` 或 `-<large>ms` | **补上机制解释**：消费端 `RCTPerfMonitor.mm:487` 内联复刻 `durationForTag:`（P-5） |
| 25 文档 M-8：`RCTPLSize` 的断言在 Release 无效 | **补上显示后果**：哨兵产生一行 `: 0ms`（P-4） |
| 26 文档 I-1：运算符优先级 bug | **正面对照**：`RCTTiming` ↔ `JSTimers.js` 的双向同步声明是同类跨语言常量的正确做法（§3.4） |