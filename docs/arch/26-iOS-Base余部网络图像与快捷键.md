---
id: 26
title: "iOS Base 余部：网络流解析、图像源与快捷键的三个缺陷"
topic: PL.ios
symptoms: []
platforms: [ios]
architecture: [cross]
layer: T3
symbols: ["RCTImageLoader", "RCTKeyChain", "RCTNetworking"]
claims: []
---
# 26 · iOS Base 余部：网络流解析、图像源与快捷键的三个缺陷

> **模块**：C1 · `React/Base/` 余部（25 文件 / 1700 行）
> **基线**：react-native @ `9b131e42` · iOS 侧
> **前置**：[23 文档](./23-iOS基础工具层ConvertAssertLogUtils.md) 讲了 Convert/Assert/Log/Utils；
> [24 文档](./24-iOS事件分发触摸管线与JS加载.md) 记录了 JS 加载与 reload。
>
> 本文记录三个**可定位到具体行的实质缺陷**：
> 一处**运算符优先级 bug 导致图片 scale 反转**、
> 一处**内存单调增长**、一处**注释与代码不符的快捷键失效**，
> 以及一条为规避 App Store 扫描而**混淆私有 selector** 的合规风险。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `React/Base/RCTMultipartStreamReader.m` | 167 | **multipart 响应流解析（有内存缺陷）** |
| `React/Base/RCTMultipartDataTask.m` | 145 | **multipart 下载任务（双路径）** |
| `React/Base/RCTKeyCommands.m` | 275 | **键盘快捷键（私有 API + 注释不符）** |
| `React/Base/RCTJSStackFrame.m` | 150 | JS 栈帧解析 |
| `React/Base/RCTParserUtils.m` | 137 | DOM 解析辅助 |
| `React/Base/RCTArrayBuffer.mm` | 127 | ArrayBuffer 桥接 |
| `React/Base/RCTImageSource.m` | 89 | **图像源（有优先级 bug）** |
| `React/Base/RCTMockDef.h` | 58 | 测试打桩宏 |
| `React/Base/RCTURLRequestHandler.h` | 52 | 网络请求协议 |
| `React/Base/RCTURLRequestDelegate.h` | 40 | 网络委托协议 |
| `React/Base/RCTImageSource.h` / `RCTArrayBuffer.h` / `RCTManagedPointer.h` / `RCTMultipartDataTask.h` / `RCTMultipartStreamReader.h` / `RCTErrorInfo.h` / `RCTJSStackFrame.h` / `RCTParserUtils.h` / `RCTKeyCommands.h` / `RCTUtilsUIOverride.h` | 约 380 | 头文件 |
| `RCTInitializing.h` / `RCTInvalidating.h` / `RCTErrorCustomizer.h` / `RCTErrorInfo.m` / `RCTUtilsUIOverride.m` / `RCTManagedPointer.mm` | 约 130 | 小实现 |

---

## 2. 【实质 bug】`RCTImageSource` 的运算符优先级反转

`React/Base/RCTImageSource.m:73`：

```objc
    scale = [self CGFloat:json[@"scale"]] ?: [self BOOL:json[@"deprecated"]] ? 0.0 : 1.0;
```

**这一行的解析结果与作者本意相反。**

ObjC/C 系里 `?:` **优先级高于** `? :`，
且 `?:` **右结合**。所以表达式实际解析为：

```
([self CGFloat:json[@"scale"]] ?: [self BOOL:json[@"deprecated"]]) ? 0.0 : 1.0
```

而不是作者显然想要的：

```
[self CGFloat:json[@"scale"]] ?: ([self BOOL:json[@"deprecated"]] ? 0.0 : 1.0)
```

### 2.1 实际行为

记 `A = [self CGFloat:json[@"scale"]]`、`B = [self BOOL:json[@"deprecated"]]`：

| `json[@"scale"]` | `A` | `A ?: B` | 三元结果 | **期望** |
| --- | --- | --- | --- | --- |
| **缺失（nil）** | `0.0` | `B`（0 或 1） | `0.0` 或 `1.0` | 合理 |
| **`2`**（Retina） | `2.0` | `2.0` | **`0.0`** ❌ | `2.0` |
| **`3`** | `3.0` | `3.0` | **`0.0`** ❌ | `3.0` |
| **`0`** | `0.0` | `B` | 视 B | `0.0` |
| **`1`** | `1.0` | `1.0` | **`0.0`** ❌ | `1.0` |

**即：任何非零 scale 都被清成 `0.0`。**

而 `_scale` 直接进入 `RCTImageSource` 的属性（`RCTImageSource.m:24`），
并被 `isEqual:`（`:41`）与 `description`（`:47-51`）使用，
最终影响图片按 `@2x` / `@3x` 资源集的选取 ——
**传 `scale: 2` 的图片会按 1x 尺寸渲染，视觉上模糊一倍**。

### 2.2 适用范围与自愈

| 条件 | 是否受影响 |
| --- | --- |
| JS 侧显式传 `scale` | ✅ 受影响（**且这正是 `resolveAssetSource` 的常见输出**） |
| 只传 `uri` / `url`（不传 scale） | ❌ 不受影响（`A=nil` 走 else 分支） |
| Fabric 架构 | 可能不受影响（`RCTImageSource` 主要服务 legacy `RCTConvert`） |

**这解释了为什么长期没被发现**：只有「显式传 scale」的路径才踩到，
而多数测试用例会走「只传 uri」的分支。

### 2.3 无测试覆盖

~~~bash
$ grep -rn "RCTImageSource\b" packages/react-native/React/Tests/
（无输出）
~~~

`React/Tests/` 下**没有任何 `RCTImageSource` 用例** ——
这条转换路径（含 4 个分支的组合）完全未被测试触及。

### 2.4 与 `RCTImageSource.m:41` 的 `isEqual:` 联动

```objc
- (BOOL)isEqual:(RCTImageSource *)object
{
  if (![object isKindOfClass:[RCTImageSource class]]) {
    return NO;
  }
  return [_request isEqual:object.request] && _scale == object.scale &&
      (CGSizeEqualToSize(_size, object.size) || CGSizeEqualToSize(object.size, CGSizeZero));
}
```

`size` 有一个 `CGSizeZero` 的兜底（`object.size` 为零时视为相等），
**但 `scale` 没有兜底** —— `_scale == object.scale` 是严格比较。

由于 §2.1 让几乎所有来源的 `_scale` 都变成 `0.0`，
**这个严格比较反而「碰巧」变得宽容**：只要 URL 相同就相等。
若修好优先级 bug，这里会立刻变成新的不匹配来源。

---

## 3. 【内存增长】`RCTMultipartStreamReader` 的 `content` 只增不减

`React/Base/RCTMultipartStreamReader.m:94` 创建累积缓冲区：

```objc
  NSMutableData *content = [[NSMutableData alloc] initWithCapacity:1];
```

**全文件对 `content` 的写操作只有一处**（`:139`）：

```objc
      bytesSeen = content.length;
      NSInteger bytesRead = [_stream read:buffer maxLength:bufferLen];
      if (bytesRead <= 0 || _stream.streamError) {
        return NO;
      }
      [content appendBytes:buffer length:bytesRead];
```

**没有任何清理点** —— 无 `removeRange:` / `setLength:` / `replaceBytesInRange:`。

### 3.1 后果

`content.length` 单调递增，等于**已读取的总字节数**。
即使每个 chunk 在 `:149` 被 `subdataWithRange:` 拷出并回调，
**原缓冲区不释放**。

| 场景 | 驻留内存 |
| --- | --- |
| 单部分、小响应 | 约等于响应体大小（可接受） |
| 多部分、多个 chunk | 约等于**整个响应体**（而非单个 chunk） |
| **JS bundle 下载** | **整个 bundle 常驻** |

> **这就是 [05 文档](./05-监控检测原理与流程.md) 「内容增长过快」的一个源码级成因**：
> 流式解析器本应做到常量内存，实测是**线性内存**。
>
> **注意范围**：这条路径服务于 **Dev 模式的 bundle 下载**
> （`RCTJavaScriptLoader.mm:255` 的 `RCTMultipartDataTask`，
> 用于 Metro 的多部分进度响应），**生产包不走这里**。
> 所以它是**开发期内存问题，不是线上 OOM 主因**。

### 3.2 消费者还有第二条同样全量累积的路径

`React/Base/RCTMultipartDataTask.m:109-114`：

```objc
- (void)URLSession:(__unused NSURLSession *)session
          dataTask:(__unused NSURLSessionDataTask *)dataTask
    didReceiveData:(NSData *)data
{
  [_data appendData:data];
}
```

**`_data` 同样只 append，且 `_data` 在 `:30` 声明、在 `:105` 整体交给回调。**

于是 `RCTMultipartDataTask` 有**两条互斥路径**（取决于
`URLSession` 是否升级为 stream task）：

| 路径 | 触发 | 累积点 | 内存特性 |
| --- | --- | --- | --- |
| **非流式** | `didReceiveData:`（`:113`） | `RCTMultipartDataTask._data` | 整个响应体 |
| **流式** | `didBecomeInputStream:`（`:123`） | `RCTMultipartStreamReader.content` | 整个响应体 |

`:123-138` 的流式分支：

```objc
- (void)URLSession:(__unused NSURLSession *)session
               streamTask:(NSURLSessionStreamTask *)streamTask
    didBecomeInputStream:(NSInputStream *)inputStream
            outputStream:(__unused NSOutputStream *)outputStream
{
  RCTMultipartStreamReader *reader = [[RCTMultipartStreamReader alloc] initWithInputStream:inputStream
                                                                                   boundary:_boundary];
```

**用了流式 API 却没有省下内存** —— 换了个累积容器而已。

### 3.3 进度节流的对比（做对了的部分）

同一文件的 `emitProgress:`（`:74-82`）做了正确的节流：

```objc
  // Throttle progress events so we don't send more that around 60 per second.
  CFTimeInterval currentTime = CACurrentMediaTime();

  NSInteger headersContentLength = headers[@"Content-Length"] != nil ? [headers[@"Content-Length"] integerValue] : 0;
  if (callback && (currentTime - _lastDownloadProgress > 0.016 || final)) {
    _lastDownloadProgress = currentTime;
    callback(headers, @(headersContentLength), @(contentLength));
  }
```

`0.016` 秒 ≈ 60Hz —— **说明作者清楚「高频回调有代价」**，
却没意识到缓冲区本身才是更大的代价。

---

## 4. `RCTKeyCommands`：注释声称的 escape 例外不存在

`React/Base/RCTKeyCommands.m:130-142`：

```objc
  if (isKeyDown && modifiedInput.length > 0) {
    UIResponder *firstResponder = nil;
    for (UIWindow *window in [self allWindows]) {
      firstResponder = [window valueForKey:@"firstResponder"];
      if (firstResponder) {
        break;
      }
    }

    // Ignore key commands (except escape) when there's an active responder
    if (!firstResponder) {
      [self RCT_handleKeyCommand:modifiedInput flags:modifierFlags];
    }
  }
```

**注释写「除 escape 外」，但代码里没有任何 escape 分支。**

~~~bash
$ grep -n -i "escape" packages/react-native/React/Base/RCTKeyCommands.m
140:    // Ignore key commands (except escape) when there's an active responder
~~~

**唯一一处出现就是这行注释本身。**

**实际行为**：只要有 first responder（输入框获得焦点即算），
**所有快捷键一律失效**，包括开发者最常用的 `Cmd+R` 重载。

> **这是「注释描述了一个未实现的行为」**，
> 与 [23 文档 §7](./23-iOS基础工具层ConvertAssertLogUtils.md)
> 记录的「注释声称 `dispatch_once` 但代码没有」同类。
>
> **影响场景**：模拟器连了键盘、且焦点在 `TextInput` 时，
> `Cmd+R` / `Cmd+D`（Dev Menu）等全部无响应。
> 这类问题的典型表现是「有时好有时坏」，极难定位。

### 4.1 `matchesInput:` 的 flag 语义

`RCTKeyCommands.m:69-75`：

```objc
- (BOOL)matchesInput:(NSString *)input flags:(UIKeyModifierFlags)flags
{
  // We consider the key command a match if the modifier flags match
  // exactly or is there are no modifier flags. This means that for
  // `cmd + r`, we will match both `cmd + r` and `r` but not `opt + r`.
  return [_key isEqual:input] && (_flags == flags || flags == 0);
}
```

**第三个条件是 `flags == 0`（事件侧无修饰键），不是 `command.flags == 0`**：

| 注册 | 事件 | 匹配？ |
| --- | --- | --- |
| `Cmd+R` | `Cmd+R` | ✅ `_flags == flags` |
| `Cmd+R` | `R`（无修饰） | ✅ `flags == 0` |
| `Cmd+R` | `Opt+R` | ❌ |
| `R`（无修饰） | `R` | ✅ `0 == 0` |

**即「注册了带修饰键的命令，也能被裸按键触发」。**
注释描述的正是这个行为，是准确的。

### 4.2 并发保护：先收集再执行

`RCTKeyCommands.m:171-191`：

```objc
- (void)RCT_handleKeyCommand:(NSString *)input flags:(UIKeyModifierFlags)modifierFlags
{
  // In Bridgeless mode we might incur in some concurrency issues
  // where the React Native instance is invalidated while iterating on
  // the list of available commands.
  // That will cleanup the set while iterating, which is a not allowed mutation.
  // To work around that, we store the commands that we need to execute in a separate
  // array, local to this function call, so we don't incur in concurrency issues
  NSMutableArray<RCTKeyCommand *> *commandsToExecute = [NSMutableArray new];
  for (RCTKeyCommand *command in [RCTKeyCommands sharedInstance].commands) {
    if ([command matchesInput:input flags:modifierFlags]) {
      if (command.block) {
        [commandsToExecute addObject:command];
      }
    }
  }

  for (RCTKeyCommand *command in commandsToExecute) {
    command.block(nil);
  }
}
```

**这是正确做法**：先快照再执行，避免 `block` 触发 `unregisterKeyCommand`
导致 `NSMutableSet` 迭代中变更。注释也把原因说清楚了。

---

## 5. 【合规风险】混淆私有 selector 以规避 App Store 扫描

`RCTKeyCommands.m:147-158`：

```objc
- (NSArray<UIWindow *> *)allWindows
{
  BOOL includeInternalWindows = YES;
  BOOL onlyVisibleWindows = NO;

  // Obfuscating selector allWindowsIncludingInternalWindows:onlyVisibleWindows:
  NSArray<NSString *> *allWindowsComponents =
      @[ @"al", @"lWindo", @"wsIncl", @"udingInt", @"ernalWin", @"dows:o", @"nlyVisi", @"bleWin", @"dows:" ];
  SEL allWindowsSelector = NSSelectorFromString([allWindowsComponents componentsJoinedByString:@""]);
```

**把私有 selector 拆成 9 段数组再拼回去**，注释直言目的是「混淆」。

这是**明确规避 App Store 静态分析**的行为 ——
私有 API 调用本应被拒，但拆分后字符串匹配扫不到。

### 5.1 本文件用到的全部私有 API

| 位置 | 私有 API | 用途 |
| --- | --- | --- |
| `:99` | `-handleKeyUIEvent:`（`UIApplication`） | **swizzle 目标** |
| `:119` | `-_modifiedInput`（`UIEvent`） | 取按键字符 |
| `:123` | `-_modifierFlags`（`UIEvent`） | 取修饰键 |
| `:127` | `-_isKeyDown`（`UIEvent`） | 区分按下/抬起 |
| `:134` | `firstResponder`（`UIWindow`，KVC） | 探测焦点 |
| `:152-155` | `+allWindowsIncludingInternalWindows:onlyVisibleWindows:`（`UIWindow`） | 枚举窗口 |

**6 个私有 API，其中 5 个未混淆**（只有最后一个做了字符串拆分）。

> **必须写清适用范围**：
> 这不是「RN 有问题」，而是「**RN 明确知道自己违规并选择规避**」。
> 这类代码导致：
> - App Store 审核风险（静态扫描可能漏，但人工审查会发现）；
> - **iOS 版本升级后行为可能静默改变** ——
>   `:119/:123/:127` 都有 `respondsToSelector:` 保护（安全），
>   但 `:152-155` 的 `methodSignatureForSelector:` **没有检查 nil**，
>   私有 API 若被移除，`methodSignature` 返回 `nil`，
>   `[NSInvocation invocationWithMethodSignature:nil]` 会抛异常。

### 5.2 swizzle 的随机后缀

`RCTKeyCommands.m:100-101`：

```objc
  SEL swizzledKeyEventSelector = NSSelectorFromString(
      [NSString stringWithFormat:@"_rct_swizzle_%x_%@", arc4random(), NSStringFromSelector(originalKeyEventSelector)]);
```

用 `arc4random()` 构造**唯一的方法名**，避免与已有 swizzle 冲突。
这是 `RCTUtils.mm:491` 的 `RCTSwapInstanceMethodWithBlock` 的标准用法。

---

## 6. `RCTCxxConvert` 断链：`JS::` 参数转换必然失败

上一轮已确认 `RCTCxxConvert.m` 是**完全的空实现**（`@implementation` 内零方法）。
本文补上它的**三个调用方**，证明这是活路径而非死代码。

### 6.1 三处调用

| 位置 | 上下文 |
| --- | --- |
| `ReactCommon/.../RCTTurboModule.mm:805` | TurboModule 参数转换 |
| `ReactCommon/.../RCTInteropTurboModule.mm:591` | Interop 层参数转换 |
| `React/Base/RCTModuleMethod.mm:383` | Legacy 模块方法参数转换 |

### 6.2 转换后的所有权处理

`RCTTurboModule.mm:804-809`：

```objc
      RCTManagedPointer *(*convert)(id, SEL, id) = (__typeof__(convert))objc_msgSend;
      RCTManagedPointer *box = convert([RCTCxxConvert class], methodArgConversionSelector, objCArg);

      void *pointer = box.voidPointer;
      [inv setArgument:&pointer atIndex:i + 2];
      [retainedObjectsForInvocation addObject:box];
```

**`[retainedObjectsForInvocation addObject:box]` 是所有权处理的关键** ——
`RCTManagedPointer` 持有 `shared_ptr<void>`，
把它 retain 在调用期间，`box.voidPointer` 拿到的裸指针就保持有效。

三处调用都有这一行（`RCTModuleMethod.mm:387` 是 `[retainedObjects addObject:box]`）。

### 6.3 selector 的注册来源决定可达性

`RCTTurboModule.mm:965-969`：

```objc
BOOL ObjCTurboModule::hasMethodArgConversionSelector(NSString *methodName, size_t argIndex)
{
  return (methodArgConversionSelectors_ != nullptr) && (methodArgConversionSelectors_[methodName] != nullptr) &&
      ![methodArgConversionSelectors_[methodName][argIndex] isEqual:(id)kCFNull];
}
```

**注册点只有一处**（`RCTInteropTurboModule.mm:223-231`）：

```objc
    for (NSUInteger i = 0; i < numArgs; i += 1) {
      NSString *typeName = method.argumentTypes[i];

      if ([typeName hasPrefix:@"JS::"]) {
        NSString *rctCxxConvertSelector =
            [[typeName stringByReplacingOccurrencesOfString:@"::" withString:@"_"] stringByAppendingString:@":"];
        setMethodArgConversionSelector(method.methodName, i, rctCxxConvertSelector);
      }
    }
```

**只有走 `RCTInteropTurboModule`（即非 codegen 的旧式 ObjC 模块）**
且方法签名含 `JS::` 前缀参数时，才会注册 selector 并触发 `objc_msgSend` 到不存在的实现。

### 6.4 与 codegen 路径的区分（关键）

**`JS::` 参数在 RN 自带模块里大量存在**，例如：

~~~text
React/CoreModules/RCTExceptionsManager.mm:105:- (void)reportException:(JS::NativeExceptionsManager::ExceptionData &)data
React/CoreModules/RCTAlertManager.mm:68:- (void)alertWithArgs:(JS::NativeAlertManager::Args &)args callback:(RCTResponseSenderBlock)callback
React/CoreModules/RCTActionSheetManager.mm:78:- (void)showActionSheetWithOptions:(JS::NativeActionSheetManager::SpecShowActionSheetWithOptionsOptions &)options
~~~

**但这些不会触发 `RCTCxxConvert`** —— 它们的 `JS::` 只出现在 `.mm` 的实现签名里，
`RCTMethodInfo` 由 codegen 生成而非 `RCT_EXPORT_METHOD`，
因此不走 `methodArgConversionSelectors_` 那条路。

`RCTTurboModule.mm:756-762` 显示 codegen 走的是完全不同的机制：

```objc
  BOOL enableModuleArgumentNSNullConversionIOS = ReactNativeFeatureFlags::enableModuleArgumentNSNullConversionIOS();
      convertJSIValueToObjCObject(runtime, arg, jsInvoker_, enableModuleArgumentNSNullConversionIOS, mustCopyBytes);
```

**`convertJSIValueToObjCObject`（`:242` 定义）是 codegen 的转换函数**，
与 `RCTCxxConvert` 无关。

> **结论（适用范围必须写清）**：
>
> | 模块类型 | `JS::` 参数转换路径 | 是否受 `RCTCxxConvert` 空壳影响 |
> | --- | --- | --- |
> | **codegen 模块**（RN 全部 CoreModules） | `convertJSIValueToObjCObject` | ❌ 不受影响 |
> | **`RCTInteropTurboModule` 的 ObjC 模块** | `RCTCxxConvert` | ✅ **必然抛 `NSInvalidArgumentException`** |
> | **`RCT_EXPORT_METHOD` 声明 `JS::` 参数** | `RCTCxxConvert`（`RCTModuleMethod.mm:383`） | ✅ **必然抛异常** |
>
> **也就是说：任何第三方库若用 `RCT_EXPORT_METHOD` 声明 `JS::` 前缀参数，
> 会在运行时崩在 `objc_msgSend` 上**（未实现的 selector）。
>
> 这是 [24 文档 §3](./24-iOS事件分发触摸管线与JS加载.md)（`RCTEventEmitter` 零注册）
> 与 [25 文档 §2](./25-iOS桥接核心与启动性能标签.md)（`RCTModuleData` 空壳）
> 之外的**第三类「接口保留、实现退役」**。

### 6.5 `RCTManagedPointer` 本身是完整的

`React/Base/RCTManagedPointer.mm` 实现无误：

```objc
// packages/react-native/React/Base/RCTManagedPointer.mm:10-12
@implementation RCTManagedPointer {
  std::shared_ptr<void> _pointer;
}
```

`RCTManagedPointer.h` 还在 `namespace facebook::react` 里提供了模板辅助：

```cpp
// packages/react-native/React/Base/RCTManagedPointer.h:22-28
template <typename T, typename P>
RCTManagedPointer *managedPointer(P initializer)
{
  auto ptr = std::shared_ptr<void>(new T(initializer));
  return [[RCTManagedPointer alloc] initWithPointer:std::move(ptr)];
}
```

**但 `managedPointer<>` 模板零使用**（全仓库只在此定义）。
**问题不在 `RCTManagedPointer`，而在唯一会产出它的 `RCTCxxConvert` 是空的。**

---

## 7. `RCTMockDef.h`：测试桩宏受 `RCT_DEV` 门控

`React/Base/RCTMockDef.h:47-58`：

```objc
#ifdef RCT_DEV
#define RCT_MOCK_DEF(context, api) __typeof(__typeof(api) *) mockptr_##context##_##api = &api;
#define RCT_MOCK_REF(context, api) extern __typeof(__typeof(api) *) mockptr_##context##_##api;
#define RCT_MOCK_SET(context, api, mockapi) (mockptr_##context##_##api = &mockapi)
#define RCT_MOCK_RESET(context, api) (mockptr_##context##_##api = &api)
#define RCT_MOCK_USE(context, api) (*mockptr_##context##_##api)
#else
#define RCT_MOCK_DEF(context, api)
...
#define RCT_MOCK_USE(context, api) api
#endif
```

**关键设计**：`RCT_MOCK_USE` 在 Release 下**退化为直接调用原函数**
（`#define RCT_MOCK_USE(context, api) api`），
所以生产包里多出的只是一层**恒等宏展开**，编译后零残留。

### 7.1 三处生产代码在用它

`RCT_MOCK_DEF` / `RCT_MOCK_USE` 并非闲置设施，
**三个生产类用它把一个函数/方法变成可打桩的间接调用**：

| 类 | 被打桩目标 | 位置 |
| --- | --- | --- |
| `RCTHost` | `_RCTLogNativeInternal` | `ReactCommon/.../RCTHost.mm:32-33` |
| `RCTBlobManager` | `dispatch_async` | `Libraries/Blob/RCTBlobManager.mm:24-25` |
| `RCTView` | `RCTContentInsets` | `React/Views/RCTView.m:22-23` |

三处都是「`RCT_MOCK_DEF` + `#define 目标名 RCT_MOCK_USE(...)`」成对出现，例如：

```objc
// packages/react-native/React/Views/RCTView.m:22-23
RCT_MOCK_DEF(RCTView, RCTContentInsets);
#define RCTContentInsets RCT_MOCK_USE(RCTView, RCTContentInsets)
```

**这些 `#define` 没有被 `#ifdef RCT_DEV` 包裹**，
但因为 Release 下 `RCT_MOCK_USE` 退化为恒等，两种构建的最终代码相同。

> **`RCTBlobManager` 那处值得单独注意**：
> 它把 **libc 的 `dispatch_async`** 宏替换成了间接调用 ——
> 即整个 `RCTBlobManager.mm` 里的 `dispatch_async` 调用都经过一个函数指针。
> Debug 下这层间接层真实存在（换来可 mock），
> Release 下消失。**这是一个刻意的「开发期可测 / 生产期零成本」权衡。**

### 7.2 `RCT_MOCK_SET` 空语句的隐患（理论）

`RCT_DEV=0` 时 `RCT_MOCK_SET(context, api, mockapi)` 展开为**空语句**。
若它出现在单语句 `if` 分支里，`else` 会**意外绑定**：

```objc
if (cond)
  RCT_MOCK_SET(X, Y, Z);   // Release 下消失
else
  doSomething();            // 语义被破坏
```

**实际未触发** —— 三处 `RCT_MOCK_SET` 全在测试文件里
（`packages/react-native/ReactCommon/react/runtime/iostests/RCTHostTests.mm:85`、
`packages/rn-tester/RNTesterUnitTests/RCTBlobManagerTests.m:83`），而测试跑在 Debug 下。

---

## 8. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| I-1 | **运算符优先级 bug：`scale` 的三元表达式解析成 `(A ?: B) ? 0.0 : 1.0`，任何非零 scale 都被清成 0.0** | `React/Base/RCTImageSource.m:73` | **显式传 `scale: 2` 的图片按 1x 渲染 → 视觉模糊一倍**；`React/Tests/` 零覆盖 |
| I-2 | **`content` 只 append 从不清理**，内存等于整个响应体 | `React/Base/RCTMultipartStreamReader.m:94, 139` | 流式解析器实际是线性内存；**开发期下载整个 bundle 常驻** |
| I-3 | 非流式路径同样全量累积到 `_data` | `React/Base/RCTMultipartDataTask.m:113` | 两条路径都不省内存，流式 API 白用 |
| I-4 | **注释声称「除 escape 外」，代码无任何 escape 例外** | `React/Base/RCTKeyCommands.m:140` | 输入框有焦点时**所有**快捷键失效（含 `Cmd+R`）；表现为间歇性故障 |
| I-5 | **私有 selector 被拆成 9 段混淆以规避 App Store 扫描** | `React/Base/RCTKeyCommands.m:152-155` | 明确合规风险；`methodSignature` 返回 nil 时会抛异常（无检查） |
| I-6 | `RCTKeyCommands` 用 6 个私有 API，其中 5 个未混淆 | `React/Base/RCTKeyCommands.m:99, 119, 123, 127, 134, 155` | iOS 版本升级可能静默失效（`:119-127` 有 `respondsToSelector:` 保护，`:152` 没有） |
| I-7 | **`RCTCxxConvert` 空壳但有 3 个活调用方**，`JS::` 参数转换必然 `objc_msgSend` 到不存在的 selector | `React/Base/RCTCxxConvert.m:10-12`、三个调用方 | 第三方库用 `RCT_EXPORT_METHOD` 声明 `JS::` 参数会**运行时崩溃**；**codegen 模块不受影响** |
| I-8 | `managedPointer<>` 模板零使用 | `React/Base/RCTManagedPointer.h:23-29` | 唯一会产出 `RCTManagedPointer` 的转换器是空的 |
| I-9 | `RCT_MOCK_SET` 在 Release 下是空语句 | `React/Base/RCTMockDef.h:55` | 若用于单语句 `if` 分支，`else` 绑定会改变；**实际未触发**（3 处使用全在测试文件，测试跑 Debug） |
| I-10 | `RCTImageSource.isEqual:` 对 `scale` 严格比较、无 `CGSizeZero` 那样的兜底 | `React/Base/RCTImageSource.m:41` | 修好 I-1 后可能成为新的不匹配来源 |

### I-1 的修复建议

只需加一对括号：

```objc
// 现状（错误）
scale = [self CGFloat:json[@"scale"]] ?: [self BOOL:json[@"deprecated"]] ? 0.0 : 1.0;

// 修正
scale = [self CGFloat:json[@"scale"]] ?: ([self BOOL:json[@"deprecated"]] ? 0.0 : 1.0);
```

**修完必须同步检查 I-10** —— `scale` 从「几乎恒为 0」变为「真实值」后，
`isEqual:` 的严格比较开始真正生效。

---

## 9. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 05 文档：内存增长 / OOM 检测 | **补上源码级成因**：`RCTMultipartStreamReader.content` 线性增长（I-2、I-3），**但限于开发期下载路径，不是线上 OOM 主因** |
| 05 文档：内容增长过快 | **同源**（I-2） |
| 23 文档：注释与实现矛盾（`dispatch_once`） | **新增第二例**：`RCTKeyCommands` 的 escape 例外（I-4） |
| 24 文档：legacy 清理残留（事件链断开） | **新增第三类**：`RCTCxxConvert` 接口保留实现退役（I-7） |
| 25 文档：`RCTModuleData` 空壳 | **同类模式**：`RCTCxxConvert` 同样是空 `@implementation` 但被真实调用 |