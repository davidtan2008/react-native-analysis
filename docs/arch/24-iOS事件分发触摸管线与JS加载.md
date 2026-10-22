---
id: 24
title: "iOS 事件分发、触摸管线与 JS 加载"
topic: PL.ios
symptoms: [gesture]
platforms: [ios]
architecture: [cross]
layer: T3
symbols: ["RCTTouchHandler", "RCTEventDispatcher"]
claims: []
---
# 24 · iOS 事件分发、触摸管线与 JS 加载

> **模块**：C1 · `React/Base/` 的事件与加载族（22 文件 / 2443 行）+ `CoreModules/RCTEventDispatcher.mm`
> **基线**：react-native @ `9b131e42` · iOS 侧
> **前置**：[03 文档](./03-核心技术原理.md) 讲了 Fabric 侧的事件循环；
> [13 文档](./13-JS启动装配.md) 讲了 JS 装配。
>
> 本文补上 **legacy 架构的事件分发与触摸管线**，
> 并记录三处实质问题：**legacy 事件链在 JS 侧已断开**、
> **`sendEvent:` 不可合并分支读取未初始化的 `eventID`**、
> **`RCTBridge.mm` 里 4 个硬编码/无效的架构开关**。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `React/CoreModules/RCTEventDispatcher.mm` | 257 | 事件队列 + 合并 + 派发 |
| `React/Base/RCTTouchHandler.m` | 377 | 把 `UITouch` 转成 RN touch 事件 |
| `React/Base/RCTTouchEvent.m` | 107 | `touchMove` 的合并实现 |
| `React/Base/RCTComponentEvent.m` | 49 | 普通组件事件 |
| `React/Base/RCTEventDispatcher.m` | 39 | 事件名规范化 + 两个 Bridge 分类 |
| `React/Base/RCTEventDispatcherProtocol.h` | 141 | `RCTEvent` 协议 |
| `React/Base/RCTJavaScriptLoader.mm` | 432 | bundle 同步/异步加载 |
| `React/Base/RCTBundleURLProvider.mm` | 608 | Dev/Prod bundle URL 决策 |
| `React/Base/RCTBundleManager.m` | 168 | bundle URL 读写 |
| `React/Base/RCTBridge.mm` | 348 | 桥接主体 + legacy interop 开关 |
| `React/Base/RCTReloadCommand.m` | 65 | reload 命令分发 |
| 其余 | 约 700 | `RCTDisplayLink` / `RCTFrameUpdate` / `RCTViewRegistry` / `RCTJSThread` / `RCTCallInvoker` / `RCTDevSupportHttpHeaders` |

---

## 2. 事件分发：一条按 ID 合并的队列

### 2.1 事件 ID 是三段位打包

`React/CoreModules/RCTEventDispatcher.mm:20-25`：

```objc
static NSNumber *RCTGetEventID(NSNumber *viewTag, NSString *eventName, uint16_t coalescingKey)
{
  return @(viewTag.intValue | (((uint64_t)eventName.hash & 0xFFFF) << 32) | (((uint64_t)coalescingKey) << 48));
}

static uint16_t RCTUniqueCoalescingKeyGenerator = 0;
```

| 位段 | 内容 | 来源 |
| --- | --- | --- |
| `0-31` | `viewTag` | 视图 tag |
| `32-47` | `eventName.hash & 0xFFFF` | **事件名哈希截断 16 位** |
| `48-63` | `coalescingKey` | `uint16_t` |

> **`eventName.hash` 被截断到 16 位** ——
> 不同事件名哈希碰撞会把两个不同事件合并成同一个。
> 触摸事件只有四种名字，碰撞概率可忽略；宿主注册自定义事件时名字空间才会变大。

`RCTUniqueCoalescingKeyGenerator` 是 **`static` 全局变量**（非实例成员），
所有 `RCTEventDispatcher` 实例共享，是**跨 Surface 全局递增**的。

### 2.2 `sendEvent:` 的合并分支

`RCTEventDispatcher.mm:137-162`：

```objc
- (void)sendEvent:(id<RCTEvent>)event
{
  [self notifyObserversOfEvent:event];

  [_eventQueueLock lock];

  NSNumber *eventID;
  if (event.canCoalesce) {
    eventID = RCTGetEventID(event.viewTag, event.eventName, event.coalescingKey);
    id<RCTEvent> previousEvent = _events[eventID];
    if (previousEvent != nullptr) {
      event = [previousEvent coalesceWithEvent:event];
    } else {
      [_eventQueue addObject:eventID];
    }
  } else {
    id<RCTEvent> previousEvent = _events[eventID];
    eventID = RCTGetEventID(event.viewTag, event.eventName, RCTUniqueCoalescingKeyGenerator++);
    RCTAssert(
        previousEvent == nil,
        @"Got event %@ which cannot be coalesced, but has the same eventID %@ as the previous event %@",
        event,
        eventID,
        previousEvent);
    [_eventQueue addObject:eventID];
  }
```

| | `canCoalesce == YES` | `canCoalesce == NO` |
| --- | --- | --- |
| `coalescingKey` | 来自事件自身 | `RCTUniqueCoalescingKeyGenerator++`（**每次唯一**） |
| 撞 ID 时 | 调 `coalesceWithEvent:` 合并 | `RCTAssert` 报警 |
| 入队时机 | 仅首次（`:150`） | 每次（`:161`） |

`canCoalesce` 全仓库只有两个实现：

| 类 | `canCoalesce` | 位置 |
| --- | --- | --- |
| `RCTTouchEvent` | `[_eventName isEqual:@"touchMove"]` | `React/Base/RCTTouchEvent.m:41-44` |
| `RCTComponentEvent` | 恒 `NO` | `React/Base/RCTComponentEvent.m:41-43` |

### 2.3 锁的释放时机：刻意在派发前解锁

`RCTEventDispatcher.mm:172-189`：

```objc
  // We have to release the lock before dispatching block with events,
  // since dispatchBlock: can be executed synchronously on the same queue.
  // (This is happening when chrome debugging is turned on.)
  [_eventQueueLock unlock];

  if (scheduleEventsDispatch) {
    if (_bridge != nullptr) {
      [_bridge
          dispatchBlock:^{
            [self flushEventsQueue];
          }
                  queue:RCTJSThread];
    } else if (_dispatchToJSThread != nullptr) {
      _dispatchToJSThread(^{
        [self flushEventsQueue];
      });
    }
  }
```

**注释说明了动机**：`dispatchBlock:` 在开启 Chrome 调试时
**可能在同一队列上同步执行**，持锁派发会自死锁。

`flushEventsQueue`（`:222-235`）的注释进一步限定它是 **js thread only**：

```objc
// js thread only (which surprisingly can be the main thread, depends on used JS executor)
- (void)flushEventsQueue
{
  [_eventQueueLock lock];
  NSDictionary *events = _events;
  _events = [NSMutableDictionary new];
  NSMutableArray *eventQueue = _eventQueue;
  _eventQueue = [NSMutableArray new];
  _eventsDispatchScheduled = NO;
  [_eventQueueLock unlock];
```

> **「js thread ... 可以是主线程」** ——
> 取决于 JS executor 的实现。`methodQueue`（`:216-219`）返回 `RCTJSThread`，
> 但若 executor 选择主线程作为 JS 线程，事件派发就发生在主线程。
>
> **这对 [03 文档](./03-核心技术原理.md) 的「UI 原子更新」结论有直接影响**：
> 在某些配置下事件处理本身就是主线程工作。

**`flushEventsQueue` 每次整体替换 `_events` 与 `_eventQueue`**
（不是清空而是换新对象），这让 §2.4 的回绕分析成为可能。

### 2.4 `uint16_t` 回绕：存在但不可观测

`RCTUniqueCoalescingKeyGenerator` 是 `uint16_t`，每 65536 次自增回绕。
若同一 `viewTag` + 同一 `eventName` 在**同一批次内**回绕到相同 `eventID`，
`RCTComponentEvent`（`canCoalesce == NO`）会撞上已存在的 key。

**但这不可观测**，因为碰撞要求「同一批次内跨 65536 次自增」，
而批次长度由一帧内的事件量决定，实际不可能达到。

**结论：回绕存在，因批次换新对象机制而不可观测。**
记录在此是因为 `:25` 的 `static` 变量 + `uint16_t` 类型组合容易被误判为 bug。

### 2.5 派发目标：收敛到 `RCTEventEmitter`

`RCTEventDispatcher.mm:206-214`：

```objc
- (void)dispatchEvent:(id<RCTEvent>)event
{
  NSString *moduleDotMethod = [[event class] moduleDotMethod];
  NSArray<NSString *> *const components = [moduleDotMethod componentsSeparatedByString:@"."];
  NSString *const moduleName = components[0];
  NSString *const methodName = components[1];

  [_callableJSModules invokeModule:moduleName method:methodName withArgs:[event arguments]];
}
```

`moduleDotMethod` 是**类方法**，每个事件类自己声明目标：

| 事件类 | `moduleDotMethod` | 位置 |
| --- | --- | --- |
| `RCTTouchEvent` | `RCTEventEmitter.receiveTouches` | `React/Base/RCTTouchEvent.m:86-89` |
| `RCTComponentEvent` | `RCTEventEmitter.receiveEvent` | `React/Base/RCTComponentEvent.m:45-48` |

---

## 3. 【已断裂】legacy 事件链在 JS 侧没有接收端

原生侧最终调用 `invokeModule:@"RCTEventEmitter" method:@"receiveTouches"`。
JS 侧对应的注册文件是 `Libraries/EventEmitter/RCTEventEmitter.js`，
其末尾提供注册入口：

```js
// packages/react-native/Libraries/EventEmitter/RCTEventEmitter.js:28-34
const RCTEventEmitter = {
  register(eventEmitter: EventEmitterModule) {
    registerCallableModule('RCTEventEmitter', eventEmitter);
  },
};

export default RCTEventEmitter;
```

**但这个文件没有任何 import 方**：

~~~bash
$ grep -rn "EventEmitter/RCTEventEmitter" packages/ --include="*.js" | grep -v "RCTEventEmitter.js:"
（无输出）
~~~

且 `receiveTouches` / `receiveEvent` 在 JS 侧**只出现在类型声明里**：

```js
// packages/react-native/Libraries/EventEmitter/RCTEventEmitter.js:15-27
type EventEmitterModule = {
  receiveEvent: (
    rootNodeID: number,
    topLevelType: string,
    nativeEventParam: unknown,
  ) => void,
  receiveTouches: (
    eventTopLevelType: string,
    touches: Array<unknown>,
    changedIndices: Array<number>,
  ) => void,
  ...
};
```

`registerCallableModule` 的实现（`Libraries/Core/registerCallableModule.js`）
要求**显式调用**才会注册，没有隐式约定：

```js
// packages/react-native/Libraries/Core/registerCallableModule.js:15-33
const registerCallableModule: RegisterCallableModule = (function () {
  if (global.RN$Bridgeless === true) {
    return (name, moduleOrFactory) => {
      if (typeof moduleOrFactory === 'function') {
        global.RN$registerCallableModule(name, moduleOrFactory);
        return;
      }

      global.RN$registerCallableModule(name, () => moduleOrFactory);
    };
  }

  const BatchedBridge = require('../BatchedBridge/BatchedBridge').default;
  return (name, moduleOrFactory) => {
    if (typeof moduleOrFactory === 'function') {
      BatchedBridge.registerLazyCallableModule(name, moduleOrFactory);
      return;
    }

    BatchedBridge.registerCallableModule(name, moduleOrFactory);
  };
})();
```

> **结论（适用范围必须写清）**：
>
> | 架构 | 原生事件是否可达 JS |
> | --- | --- |
> | **Bridgeless** | ❌ 这条 `RCTEventDispatcher.mm` 路径**本就不是主路径**（bridgeless 走 `_dispatchToJSThread` 分支，但事件协议仍指向 `RCTEventEmitter`） |
> | **Legacy（`RCTBridge`）** | ❌ `RCTEventEmitter` 在 JS 侧无人注册 |
>
> **这不是「新引入的 bug」** —— 它与
> 「`RCTIsNewArchEnabled` 硬编码 `YES` 且零调用」
> （[23 文档 §6.1](./23-iOS基础工具层ConvertAssertLogUtils.md)）
> 「legacy 架构已被移除清理」是**同一个进程**：
> 新架构成为唯一路径后，legacy 事件链的 JS 端注册代码被删除，
> 但**原生侧的 `RCTEventDispatcher.mm` 完整保留**。
>
> 这解释了一个潜在困惑：如果有人在 legacy 配置下接入 legacy 架构，
> 事件会一路走到 `invokeModule:@"RCTEventEmitter"` 然后**静默丢弃**。

---

## 4. 触摸管线：`RCTTouchHandler` 平行维护三份状态

### 4.1 三个平行数组

`React/Base/RCTTouchHandler.m:30-43`：

```objc
  /**
   * Arrays managed in parallel tracking native touch object along with the
   * native view that was touched, and the React touch data dictionary.
   * These must be kept track of because `UIKit` destroys the touch targets
   * if touches are canceled, and we have no other way to recover this info.
   */
  NSMutableOrderedSet<UITouch *> *_nativeTouches;
  NSMutableArray<NSMutableDictionary *> *_reactTouches;
  NSMutableArray<UIView *> *_touchViews;
```

**注释说明了为何要自己维护**：
`UIKit` 在触摸被取消时会销毁 touch target，**没有其他办法恢复这些信息**。

三个数组按同一 index 对齐：

| 数组 | 元素 | 用途 |
| --- | --- | --- |
| `_nativeTouches` | `UITouch *` | 计算当前坐标与时间戳 |
| `_reactTouches` | `NSMutableDictionary *` | 跨线程传输的事件载荷 |
| `_touchViews` | `UIView *` | 计算 `locationX/Y` |

### 4.2 触摸 ID 的分配：最多 11 个

`RCTTouchHandler.m:107-119`：

```objc
    // Get new, unique touch identifier for the react touch
    const NSUInteger RCTMaxTouches = 11; // This is the maximum supported by iDevices
    NSInteger touchID = ([_reactTouches.lastObject[@"identifier"] integerValue] + 1) % RCTMaxTouches;
    for (NSDictionary *reactTouch in _reactTouches) {
      NSInteger usedID = [reactTouch[@"identifier"] integerValue];
      if (usedID == touchID) {
        // ID has already been used, try next value
        touchID++;
      } else if (usedID > touchID) {
        // If usedID > touchID, touchID must be unique, so we can stop looking
        break;
      }
    }
```

`RCTMaxTouches = 11`，注释说是 iOS 设备支持的上限。
**但 `touchID++` 没有取模** —— 循环里连撞 11 次会得到 `11+`，越界。

> **实际不可达**：iOS 的最大并发触摸数是 10，
> 而这个循环只在 `_reactTouches` 已有的条目上递增。
> 要溢出需要同时存在 11+ 个活动触摸。
> 记为**理论缺陷，非实际 bug**。

### 4.3 `_coalescingKey` 的自增策略

`RCTTouchHandler.m:211-231`：

```objc
  BOOL canBeCoalesced = [eventName isEqualToString:@"touchMove"];

  // We increment `_coalescingKey` twice here just for sure that
  // this `_coalescingKey` will not be reused by another (preceding or following) event
  // (yes, even if coalescing only happens (and makes sense) on events of the same type).

  if (!canBeCoalesced) {
    _coalescingKey++;
  }

  RCTTouchEvent *event = [[RCTTouchEvent alloc] initWithEventName:eventName
                                                         reactTag:self.view.reactTag
                                                     reactTouches:reactTouches
                                                   changedIndexes:changedIndexes
                                                    coalescingKey:_coalescingKey];

  if (!canBeCoalesced) {
    _coalescingKey++;
  }
```

**非 `touchMove` 事件前后各自增一次**，保证任何两个非合并事件
的 key 都不相同（因为合并只发生在 `touchMove` 之间）。
注释 `:213-215` 明确说了这个意图。

### 4.4 事件载荷：跨线程前深拷贝

`RCTTouchHandler.m:204-209`：

```objc
  // Deep copy the touches because they will be accessed from another thread
  // TODO: would it be safer to do this in the bridge or executor, rather than trusting caller?
  NSMutableArray<NSDictionary *> *reactTouches = [[NSMutableArray alloc] initWithCapacity:_reactTouches.count];
  for (NSDictionary *touch in _reactTouches) {
    [reactTouches addObject:[touch copy]];
  }
```

**每个事件都深拷贝全部触摸点**（不只是变化的那些）——
`changedIndexes` 另传索引数组告知 JS 哪些变了。
TODO 质疑了这个设计的责任归属。

### 4.5 `reset` 会主动发 cancel 事件

`RCTTouchHandler.m:347-358`：

```objc
- (void)reset
{
  if (_nativeTouches.count != 0) {
    [self _updateAndDispatchTouches:_nativeTouches.set eventName:@"touchCancel"];

    [_nativeTouches removeAllObjects];
    [_reactTouches removeAllObjects];
    [_touchViews removeAllObjects];

    _cachedRootView = nil;
  }
}
```

`reset` 是 `UIGestureRecognizer` 的标准回调（识别器被系统重置时调用）。
**它保证未结束的触摸会以 `touchCancel` 收尾**，避免 JS 侧状态悬挂。

### 4.6 手势竞争策略：一律让给外部识别器

`RCTTouchHandler.m:335-345`：

```objc
- (BOOL)canPreventGestureRecognizer:(__unused UIGestureRecognizer *)preventedGestureRecognizer
{
  return NO;
}

- (BOOL)canBePreventedByGestureRecognizer:(UIGestureRecognizer *)preventingGestureRecognizer
{
  // We fail in favour of other external gesture recognizers.
  // iOS will ask `delegate`'s opinion about this gesture recognizer little bit later.
  return ![preventingGestureRecognizer.view isDescendantOfView:self.view];
}
```

| 方法 | 返回 | 含义 |
| --- | --- | --- |
| `canPreventGestureRecognizer:` | 恒 `NO` | RN **永不阻止**其他识别器 |
| `canBePreventedBy:` | 外部识别器不在自己子树内才为 `YES` | 只让**子树内**的识别器阻止自己 |

`:370-375` 的 `shouldRequireFailureOfGestureRecognizer:` 复用同一条件。

`initWithBridge:`（`:59-61`）的注释说明了配套配置：

```objc
    // `cancelsTouchesInView` and `delaysTouches*` are needed in order to be used as a top level
    // event delegated recognizer. Otherwise, lower-level components not built
    // using RCT, will fail to recognize gestures.
    self.cancelsTouchesInView = NO;
    self.delaysTouchesBegan = NO; // This is default value.
    self.delaysTouchesEnded = NO;
```

---

## 5. 事件名规范化：一次性转换，幂等

`React/Base/RCTEventDispatcher.m:12-21`：

```objc
NSString *RCTNormalizeInputEventName(NSString *eventName)
{
  if ([eventName hasPrefix:@"on"]) {
    eventName = [eventName stringByReplacingCharactersInRange:(NSRange){0, 2} withString:@"top"];
  } else if (![eventName hasPrefix:@"top"]) {
    eventName = [[@"top" stringByAppendingString:[eventName substringToIndex:1].uppercaseString]
        stringByAppendingString:[eventName substringFromIndex:1]];
  }
  return eventName;
}
```

三条分支：

| 输入 | 输出 |
| --- | --- |
| `onChange`（有 `on` 前缀） | `topChange` |
| `topChange`（已有 `top` 前缀） | 不变（幂等） |
| `change` | `topChange` |

**`RCTComponentEvent` 与 `RCTTouchEvent` 的调用时机不同**：

| 类 | 调用位置 |
| --- | --- |
| `RCTComponentEvent` | **构造时**（`React/Base/RCTComponentEvent.m:22`） |
| `RCTTouchEvent` | **`arguments` 求值时**（`React/Base/RCTTouchEvent.m:93`） |

两者最终都规范化一次，但 `RCTComponentEvent` 的 `eventName` 存的是**规范化后**的值
（而触摸事件的 `eventName` 存的是原始的 `"touchStart"` 等，
`canCoalesce` 依赖原始值判断 —— 见 `RCTTouchEvent.m:43`）。

> **潜在脆弱点**：`RCTNormalizeInputEventName(@""))` 会走到
> `[@"" substringToIndex:1]` 抛 `NSRangeException`。
> **实际不可达** —— `RCTComponentEvent` 的 `propName` 来自 ViewManager 的
> `propConfig*` 静态返回值（`React/Views/RCTComponentData.mm:275`），
> `RCTTouchEvent` 的名字是四个硬编码字面量。
> 记为**理论缺陷，非实际 bug**。

---

## 6. `RCTReloadCommand`：14 个触发点，1 个监听者

### 6.1 分发机制：通知 + 弱引用表双通道

`React/Base/RCTReloadCommand.m:46-60`：

```objc
void RCTTriggerReloadCommandListeners(NSString *reason)
{
  [listenersLock lock];
  [[NSNotificationCenter defaultCenter] postNotificationName:RCTTriggerReloadCommandNotification
                                                      object:nil
                                                    userInfo:@{
                                                      RCTTriggerReloadCommandReasonKey : RCTNullIfNil(reason),
                                                      RCTTriggerReloadCommandBundleURLKey : RCTNullIfNil(bundleURL)
                                                    }];

  for (id<RCTReloadListener> l in [listeners allObjects]) {
    [l didReceiveReloadCommand];
  }
  [listenersLock unlock];
}
```

**两个通道并存**：

| 通道 | 消费者 | 用途 |
| --- | --- | --- |
| `NSNotificationCenter` | `RCTPackagerConnection.mm:113` | 关闭 packager 连接 |
| 弱引用 listener 表 | `RCTHost`（1 处） | 真正的 reload |

`listeners` 是 `weakObjectsHashTable`（`:29`）—— **不会造成循环引用**，
但 listener 释放后自动移除。

### 6.2 触发点分布

14 个调用点：

| 来源 | 位置 |
| --- | --- |
| DevSettings | `RCTDevSettings.mm:203, 318, 323, 444` |
| **RedBox** | `RCTRedBox.mm:274`、`RCTRedBox2Controller.mm:320`、`RCTRedBoxController.mm:265` |
| **JS 崩溃重载** | `RCTExceptionsManager.mm:77` |
| DevMenu | `RCTDevMenu.mm:297, 311, 411, 501` |
| Profiler | `RCTProfile.m:383` |
| 键盘快捷键 | `RCTReloadCommand.m:38`（Cmd+R） |

> **`RCTExceptionsManager.mm:77` 那条是 20 文档崩溃自动重载的一环** ——
> 与「`maxReloadAttempts` 无赋值点 → 自动 reload 恒不生效」（20 文档结论）配合看：
> **触发端是通的，但计数保护缺失**，所以会无限重载。

### 6.3 唯一监听方是 `RCTHost`（bridgeless）

`RCTRegisterReloadCommandListener` 只有 1 处调用：

```objc
// packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTHost.mm:371-373
    RCTExecuteOnMainQueue(^{
      // Listen to reload commands
      RCTRegisterReloadCommandListener(self);
    });
```

`didReceiveReloadCommand` 全仓库也只有 `RCTHost` 实现
（`RCTHost.mm:471`，另有一处转发在 `:112`）。

**而 `RCTBridge`（legacy）的四个相关方法全是空实现**：

```objc
// packages/react-native/React/Base/RCTBridge.mm:305-320
- (void)reload __attribute__((deprecated("Use RCTReloadCommand instead")))
{
}

- (void)reloadWithReason:(NSString *)reason __attribute__((deprecated("Use RCTReloadCommand instead")))
{
}

- (void)onFastRefresh
{
}

- (void)requestReload __attribute__((deprecated("Use RCTReloadCommand instead")))
{
}
```

> **与 §3 同源**：legacy 侧的 reload 链路同样已断开 ——
> `RCTBridge` 声明了 API 但**不做任何事**，
> 而 `RCTReloadCommand` 的 listener 又只注册给 `RCTHost`。
>
> 这四个方法带 `deprecated` 标注，
> 说明它们是**从「真实实现」退化来的**，迁移方向是 `RCTReloadCommand`。

### 6.4 锁的初始化有竞态

`RCTReloadCommand.m:22-31`：

```objc
void RCTRegisterReloadCommandListener(id<RCTReloadListener> listener)
{
  if (!listenersLock) {
    listenersLock = [NSLock new];
  }
  [listenersLock lock];
  if (!listeners) {
    listeners = [NSHashTable weakObjectsHashTable];
  }
```

**先判空再赋值，然后才加锁** —— 判空本身不在锁内。
两个线程同时首次调用会**各创建一个 `NSLock`**，其中一个立即被丢弃，
而另一个线程可能已经在用另一个锁。

> **实际影响**：注册发生在启动期单线程（`RCTExecuteOnMainQueue` 包着，
> 见 `RCTHost.mm:371`），所以不构成实际竞态。
> 但 `RCTTriggerReloadCommandListeners`（`:48`）**无条件** `[listenersLock lock]`，
> 若它先于任何注册被调用，`listenersLock` 是 `nil`，
> **向 nil 发 `lock` 是 no-op** —— 锁完全失效，且不崩溃。

---

## 7. `RCTBridge.mm`：4 个硬编码/无效的架构开关

这是本文档最值得记录的部分 —— 与既有的
「`UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE` 硬编码 `false`」
「`RCTIsNewArchEnabled` 硬编码 `YES` 且零调用」
构成**同一批清理残留**。

### 7.1 `RCTEnableTurboModule`：参数被明确忽略

`RCTBridge.mm:192-195`：

```objc
void RCTEnableTurboModule(BOOL enabled)
{
  // The new Architecture is enabled by default and we are ignoring changes to the TurboModule system.
}
```

**函数体是空的**（只有一个注释），参数 `enabled` 不用。
注释说明了原因：新架构默认启用，TurboModule 开关已无意义。

**0 处调用**（排除定义处）—— 机制存在但无人用。

### 7.2 三个 interop 开关：一个真开关、一个真开关、一个零调用

`RCTBridge.mm:197-220`：

```objc
#ifndef RCT_REMOVE_LEGACY_MODULE_INTEROP
static BOOL turboModuleInteropEnabled = NO;
BOOL RCTTurboModuleInteropEnabled(void)
{
  return turboModuleInteropEnabled;
}
void RCTEnableTurboModuleInterop(BOOL enabled)
{
  turboModuleInteropEnabled = enabled;
}
#endif // RCT_REMOVE_LEGACY_MODULE_INTEROP

#ifndef RCT_REMOVE_LEGACY_COMPONENT_INTEROP
static BOOL fabricInteropLayerEnabled = YES;
BOOL RCTFabricInteropLayerEnabled()
{
  return fabricInteropLayerEnabled;
}

void RCTEnableFabricInteropLayer(BOOL enabled)
{
  fabricInteropLayerEnabled = enabled;
}
#endif // RCT_REMOVE_LEGACY_COMPONENT_INTEROP
```

| 开关 | 初值 | 可写？ | 调用方 |
| --- | --- | --- | --- |
| `turboModuleInteropEnabled` | **`NO`** | ✅ `RCTEnableTurboModuleInterop` | **1 处**：`Libraries/AppDelegate/RCTRootViewFactory.mm:127` 设为 `YES` |
| `fabricInteropLayerEnabled` | **`YES`** | ✅ `RCTEnableFabricInteropLayer` | **0 处** → 恒 `YES` |
| `RCTEnableTurboModule` | — | ❌ 空实现 | **0 处** |

**`RCTEnableFabricInteropLayer` 无人调用 → `fabricInteropLayerEnabled` 恒为 `YES`**，
即 **Fabric interop 层默认开启且不可关闭**（除非重新编译时定义
`RCT_REMOVE_LEGACY_COMPONENT_INTEROP`）。

### 7.3 `RCT_REMOVE_LEGACY_*` 的默认值是「不定义」

宏只在构建脚本里**条件性**定义：

```ruby
# packages/react-native/scripts/react_native_pods.rb:123-124
  ENV['RCT_REMOVE_LEGACY_MODULE_INTEROP'] = ENV['RCT_REMOVE_LEGACY_MODULE_INTEROP'] == '1' ? '1' : '0'
  ENV['RCT_REMOVE_LEGACY_COMPONENT_INTEROP'] = ENV['RCT_REMOVE_LEGACY_COMPONENT_INTEROP'] == '1' ? '1' : '0'
```

**只有显式设为 `1` 才会 `-D` 传下去**（`scripts/cocoapods/utils.rb:23-24`）。
SwiftPM 侧同理（`Package.swift:971-972`）。

**所以默认构建下两个宏都未定义 → legacy interop 代码全部编译进去。**

### 7.4 `||` 与 `&&` 的语义不一致

不同文件对同一对宏的判断方式**不同**：

| 位置 | 条件 | 语义 |
| --- | --- | --- |
| `RCTBridge.mm:34` | `#if !defined(MODULE) \|\| !defined(COMPONENT)` | 任一未定义就**保留** legacy 代码 |
| `RCTBridge.mm:197` | `#ifndef MODULE` | 同上（等价） |
| `RCTBridge.mm:209` | `#ifndef COMPONENT` | 同上（等价） |
| **`RCTBridgeModule.h:72`** | `#if defined(MODULE) && defined(COMPONENT)` | **两个都定义才**走 |
| `RCTBridgeModule.h:123` | `#endif // defined(...) && defined(...)` | — |

`RCTBridgeModule.h` 用 **`&&`**（两者都开启才走），
`RCTBridge.mm` 用 **`||`**（任一未开启就保留 legacy）。

**两处的目的不同**（前者是「legacy API 是否可用」，
后者是「legacy 注册表是否需要」），所以不必然是 bug。
但**同一个宏对在两处用相反的逻辑**，增加了阅读负担，
且**没有一个统一的「是否 legacy」查询函数**。

---

## 8. `RCTJavaScriptLoader`：同步加载的三道拒绝

`loadBundleAtURL:`（`RCTJavaScriptLoader.mm:78-98`）先试同步，失败再按错误类型决定是否转异步：

```objc
+ (void)loadBundleAtURL:(NSURL *)scriptURL
             onProgress:(RCTSourceLoadProgressBlock)onProgress
             onComplete:(RCTSourceLoadBlock)onComplete
{
  int64_t sourceLength;
  NSError *error;
  NSData *data = [self attemptSynchronousLoadOfBundleAtURL:scriptURL sourceLength:&sourceLength error:&error];
  if (data) {
    onComplete(nil, RCTSourceCreate(scriptURL, data, sourceLength));
    return;
  }

  const BOOL isCannotLoadSyncError = [error.domain isEqualToString:RCTJavaScriptLoaderErrorDomain] &&
      error.code == RCTJavaScriptLoaderErrorCannotBeLoadedSynchronously;

  if (isCannotLoadSyncError) {
    attemptAsynchronousLoadOfBundleAtURL(scriptURL, onProgress, onComplete);
  } else {
    onComplete(error, nil);
  }
}
```

**只有 `CannotBeLoadedSynchronously`（= 1000）会转异步**，
其他错误（文件不存在、权限不足等）**直接失败，不重试**。

### 8.1 `ScriptTag::String` 分支受 `RCT_ENABLE_INSPECTOR` 门控

`RCTJavaScriptLoader.mm:182-198`：

```objc
    case facebook::react::ScriptTag::String: {
#if RCT_ENABLE_INSPECTOR
      NSData *source = [NSData dataWithContentsOfFile:scriptURL.path options:NSDataReadingMappedIfSafe error:error];
      if (sourceLength && source != nil) {
        *sourceLength = source.length;
      }
      return source;
#else
      if (error) {
        *error =
            [NSError errorWithDomain:RCTJavaScriptLoaderErrorDomain
                                code:RCTJavaScriptLoaderErrorCannotBeLoadedSynchronously
                            userInfo:@{NSLocalizedDescriptionKey : @"Cannot load text/javascript files synchronously"}];
      }
      return nil;
#endif
    }
```

`RCT_ENABLE_INSPECTOR` 的定义（`React/Base/RCTDefines.h:69-75`）：

```objc
#ifndef RCT_ENABLE_INSPECTOR
#if (RCT_DEV || RCT_REMOTE_PROFILE)
#define RCT_ENABLE_INSPECTOR 1
#else
#define RCT_ENABLE_INSPECTOR 0
#endif
#endif
```

> **适用范围**：`RCT_DEV=0` 且 `RCT_REMOTE_PROFILE=0` 的构建
> （即纯 Release 且没开远程调试）下，
> **纯文本 JS bundle 无法同步加载**，会返回
> `CannotBeLoadedSynchronously` 从而转入异步加载。
>
> 正常 Release 用 RAM bundle（`ScriptTag::RAMBundle`）不受影响。

### 8.2 错误码撞号

`RCTJavaScriptLoader.h:14-24`：

```objc
NS_ENUM(NSInteger){
   RCTJavaScriptLoaderErrorNoScriptURL = 1,
   RCTJavaScriptLoaderErrorFailedOpeningFile = 2,
   RCTJavaScriptLoaderErrorFailedReadingFile = 3,
   RCTJavaScriptLoaderErrorFailedStatingFile = 3,
   RCTJavaScriptLoaderErrorURLLoadFailed = 3,
   RCTJavaScriptLoaderErrorBCVersion = 4,
   RCTJavaScriptLoaderErrorBCNotSupported = 4,

   RCTJavaScriptLoaderErrorCannotBeLoadedSynchronously = 1000,
};
```

**三处撞号**：

| 值 | 枚举 |
| --- | --- |
| `3` | `FailedReadingFile` / `FailedStatingFile` / `URLLoadFailed` |
| `4` | `BCVersion` / `BCNotSupported` |

**不影响现有逻辑** —— 唯一按 `error.code` 分支的地方
（`RCTJavaScriptLoader.mm:91`）判的是 `1000`，不撞。

> **但按错误码做日志聚合/上报时无法区分这三类失败**。
> `RCTJavaScriptLoaderErrorBCVersion` / `BCNotSupported`（字节码版本相关）
> 在本文件里**没有产生点** —— 是历史遗留。

---

## 9. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| E-1 | **`RCTEventEmitter` 在 JS 侧无注册方** —— `RCTEventEmitter.js` 零 import，`receiveTouches`/`receiveEvent` 只有类型声明 | `Libraries/EventEmitter/RCTEventEmitter.js`（全文件）、`React/CoreModules/RCTEventDispatcher.mm:213` | **legacy 架构的原生事件走到最后一步被静默丢弃**；与 `RCTIsNewArchEnabled` 零调用同源 |
| E-2 | `sendEvent:` 不可合并分支在 `eventID` 声明后**先读取再赋值** | `React/CoreModules/RCTEventDispatcher.mm:153-154` | `:153` 用**上一轮遗留**的 ID 查 `_events`；`:156` 的断言因此校验的不是本事件的 ID |
| E-3 | **`RCTEnableTurboModule` 空实现 + 0 调用** | `React/Base/RCTBridge.mm:192-195` | 参数被忽略；与 `RCTIsNewArchEnabled` 同批清理残留 |
| E-4 | **`RCTEnableFabricInteropLayer` 0 调用** → `fabricInteropLayerEnabled` 恒 `YES` | `React/Base/RCTBridge.mm:209-220` | Fabric interop 层默认开启且**无法运行期关闭** |
| E-5 | `RCTBridge` 的 `reload`/`reloadWithReason:`/`onFastRefresh`/`requestReload` **全为空实现** | `React/Base/RCTBridge.mm:305-320` | legacy 侧 reload API 静默无效；listener 只注册给 `RCTHost` |
| E-6 | `RCT_REMOVE_LEGACY_*` 在 `RCTBridge.mm` 用 `\|\|`、`RCTBridgeModule.h` 用 `&&` | `RCTBridge.mm:34` vs `RCTBridgeModule.h:72` | 同一宏对两套逻辑，无统一查询函数 |
| E-7 | `RCTReloadCommand` 的锁初始化在锁外判空；`RCTTriggerReloadCommandListeners` 可能对 `nil` 锁加锁 | `React/Base/RCTReloadCommand.m:24-27, 48` | 首次并发注册会丢失锁；nil 锁使**锁完全失效且不崩溃** |
| E-8 | 错误码三处撞号（`3` 三个、`4` 两个） | `React/Base/RCTJavaScriptLoader.h:17-21` | 按 code 聚合无法区分失败原因；不影响现有分支逻辑 |
| E-9 | `touchID++` 不取模，理论上可越过 `RCTMaxTouches = 11` | `React/Base/RCTTouchHandler.m:114` | 实际不可达（iOS 上限 10），理论缺陷 |
| E-10 | `RCTNormalizeInputEventName(@""))` 抛 `NSRangeException` | `React/Base/RCTEventDispatcher.m:17` | 实际不可达（名字来自静态 propConfig），理论缺陷 |
| E-11 | 每个事件深拷贝**全部**触摸点（含未变化者） | `React/Base/RCTTouchHandler.m:204-209` | 高频 `touchMove` 下的分配开销；源码 TODO 已质疑该设计归属 |
| E-12 | `RCTUniqueCoalescingKeyGenerator` 是 `static` 全局 + `uint16_t` | `React/CoreModules/RCTEventDispatcher.mm:25, 154` | 每 65536 个非合并事件回绕；因批次换新对象而**不可观测** |
| E-13 | `RCTTextUpdateLagWarningThreshold` 定义后 0 使用 | `React/Base/RCTEventDispatcher.m:10` | 死常量（值 3） |
| E-14 | `ScriptTag::String` 同步加载受 `RCT_ENABLE_INSPECTOR` 门控 | `React/Base/RCTJavaScriptLoader.mm:183` | 纯 Release 构建下文本 bundle 必须走异步 |

### E-2 的详细分析

```objc
// packages/react-native/React/CoreModules/RCTEventDispatcher.mm:143-154
  NSNumber *eventID;                               // :143 声明，未初始化
  if (event.canCoalesce) {
    eventID = RCTGetEventID(...);                   // :145 合并分支：立即赋值
    ...
  } else {
    id<RCTEvent> previousEvent = _events[eventID];  // :153 未合并分支：读取未初始化的值！
    eventID = RCTGetEventID(...);                   // :154 才赋值
```

**`:153` 读到的 `eventID` 是上一次循环遗留的局部变量值**
（ObjC 局部变量在栈上复用，不会被自动清零）。

`:156` 的断言本意是「不可合并事件不该撞 ID」，
但它查的是**错误的那个 ID** —— 结论无效。

**实际影响为零**：因为非合并分支用 `RCTUniqueCoalescingKeyGenerator++`
保证 ID 唯一，断言无论查哪个 ID 都是 `nil`（除非读到一个已失效的旧值恰好命中 `_events`，
此时会**误报**）。属于「断言失效」而非「行为错误」。

---

## 10. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 20 文档：「`maxReloadAttempts` 无赋值点 → 崩溃自动 reload 恒不生效」 | **补上前置条件**：`RCTExceptionsManager.mm:77` 的触发端是通的（§6.2），缺的是计数保护 |
| 22/23 文档：架构清理残留（`RCT_DEV_MENU`、`RCTIsNewArchEnabled`） | **新增 3 处同型**：`RCTEnableTurboModule`、`RCTEnableFabricInteropLayer`、legacy `RCTBridge` 的 4 个空方法（§7、§6.3） |
| 03 文档：事件循环与 UI 原子更新 | **限定条件**：`flushEventsQueue` 的注释说 js thread **可以是主线程**（§2.3） |
| 13 文档：JS 装配 | **补充**：文本 bundle 的同步加载受 `RCT_ENABLE_INSPECTOR` 门控（§8.1） |
