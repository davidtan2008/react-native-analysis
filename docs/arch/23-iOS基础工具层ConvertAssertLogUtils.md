---
id: 23
title: "iOS 基础工具层：Convert / Assert / Log / Utils / Constants"
topic: PL.ios
symptoms: [bridge]
platforms: [ios]
architecture: [cross]
layer: T3
symbols: ["RCTConvert", "RCTAssert", "RCTLog"]
claims: []
---
# 23 · iOS 基础工具层：Convert / Assert / Log / Utils / Constants

> **模块**：C1 · `React/Base/` 的工具层（16 文件 / 4563 行）
> **基线**：react-native @ `9b131e42` · iOS 侧
> **前置**：[22 文档](./22-iOS崩溃UI层RedBox与LogBox.md) 讲了 RedBox/LogBox 的门控；
> [20 文档](./20-iOS-CoreModules与崩溃终止机制.md) 讲了 `RCTFatal` 的调用链。
>
> 本文补上这两者**共同依赖的底层**：类型转换、断言、日志、工具函数。
> 这一层里藏着 **6 个可独立覆盖的编译期宏**，
> 且它们的门控方向**并不一致** —— 有的 Dev 有保护 Release 没有，有的正好相反。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `React/Base/RCTConvert.mm` | 1387 | JSON → 原生类型的转换器 |
| `React/Base/RCTConvert.h` | 286 | 转换器宏定义 + 全部方法签名 |
| `React/Base/RCTUtils.mm` | 1419 | 工具函数（主队列、JSON、窗口、gzip） |
| `React/Base/RCTUtils.h` | 210 | 工具函数声明 |
| `React/Base/RCTLog.mm` | 337 | 日志管线 |
| `React/Base/RCTLog.h` | 155 | 日志宏 + 级别枚举 |
| `React/Base/RCTAssert.m` | 233 | 断言与 fatal |
| `React/Base/RCTAssert.h` | 181 | 断言宏 |
| `React/Base/RCTConstants.m` | 41 | 通知名与开关 |
| `React/Base/RCTConstants.h` | 53 | 同上 |
| `React/Base/RCTDefines.h` | 169 | **全部编译期开关的定义处** |
| `React/Base/RCTVersion.m` | 31 | RN 版本号 |
| `React/Base/RCTCxxConvert.m` | 12 | **空实现** |
| `React/Base/RCTCxxConvert.h` | 18 | 声明（无方法） |
| `React/Base/RCTNullability.h` | 14 | 三态可空枚举 |
| `React/Base/RCTVersion.h` | 17 | 版本常量 |

---

## 2. 六个编译期开关，全部可独立覆盖

`React/Base/RCTDefines.h` 里每个开关都是 `#ifndef` 包裹的**独立**定义，
**没有一处把它们绑定在一起**（除 `RCT_DEV_MENU` 默认继承 `RCT_DEV`，见 [22 文档 §5.1](./22-iOS崩溃UI层RedBox与LogBox.md)）：

```objc
// packages/react-native/React/Base/RCTDefines.h:29-35
#ifndef RCT_DEBUG
#ifdef DEBUG
#define RCT_DEBUG 1
#else
#define RCT_DEBUG 0
#endif
#endif
```

```objc
// packages/react-native/React/Base/RCTDefines.h:136-138
/**
 * By default, only raise an NSAssertion in debug mode
 * (custom assert functions will still be called).
 */
#ifndef RCT_NSASSERT
#define RCT_NSASSERT RCT_DEBUG
#endif
```

汇总：

| 开关 | 定义处 | 默认值 | 控制什么 |
| --- | --- | --- | --- |
| `DEBUG` | Xcode 构建设置 | — | `RCT_DEBUG` / `RCT_DEV` / `RCT_NSASSERT` 的公共来源 |
| `RCT_DEBUG` | `RCTDefines.h:29` | `DEBUG ? 1 : 0` | 类型检查、`NSAssertion`、日志转发 JS |
| `RCT_DEV` | `RCTDefines.h:41` | `DEBUG ? 1 : 0` | RedBox/LogBox、DevMenu |
| `RCT_DEV_MENU` | `RCTDefines.h:94` | `RCT_DEV` | RedBox/LogBox 编译期裁剪 |
| `RCT_NSASSERT` | `RCTDefines.h:136` | `RCT_DEBUG` | `RCTAssert` 是否抛 `NSAssertion` |
| `NS_BLOCK_ASSERTIONS` | Xcode 构建设置 | Release 下为 1 | `RCTAssert` 是否整体编译掉 |

**六个开关 = 六个独立旋钮。** 22 文档只覆盖了 `RCT_DEV_MENU` 一个；
本文会说明其余五个如何影响**同一段代码的相反方向**。

---

## 3. RCTConvert：Debug 与 Release 的语义**反转**

`RCTConvert.h:207-221` 的 `RCT_CUSTOM_CONVERTER` 是所有转换器的底座：

```objc
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

**两个分支的差别不是性能，而是失败语义**：

| `RCT_DEBUG` | 行为 | 类型不匹配时 |
| --- | --- | --- |
| `1`（Dev） | `@try` + `@catch` | 记一条 `RCTLogConvertError`，`json = nil` 后重试，**降级返回默认值** |
| `0`（Release） | 直接 `return code` | **异常逃逸 → 未捕获 ObjC 异常 → 崩溃** |

> **这是本层最反直觉的一点，且方向与直觉相反**：
> Debug 有容错，Release 没有。
> 通常的工程直觉是「Release 少检查」，但这里是「Release 少一层兜底」。

### 3.1 `RCT_JSON_CONVERTER` 同方向

`RCTConvert.mm:38-55`：

```objc
#if RCT_DEBUG
#define RCT_JSON_CONVERTER(type)             \
  +(type *)type : (id)json                   \
  {                                          \
    if ([json isKindOfClass:[type class]]) { \
      return json;                           \
    } else if (json) {                       \
      RCTLogConvertError(json, @ #type);     \
    }                                        \
    return nil;                              \
  }
#else
#define RCT_JSON_CONVERTER(type) \
  +(type *)type : (id)json       \
  {                              \
    return json;                 \
  }
#endif
```

**Release 下 `NSArray` / `NSDictionary` / `NSString` / `NSNumber` 的转换器完全不做类型检查**，
只是把 `id` 原样强转返回。返回类型声明为 `NSArray *`，
但实际可能是任意对象 —— 编译器不会报错（`id` 到 `NSArray *` 隐式转换合法），
**崩溃点被推迟到调用方第一次向它发消息时**，栈回溯会指向错误的位置。

### 3.2 `RCT_NUMBER_CONVERTER` 的三元表达式

`RCTConvert.h:228-229`：

```objc
#define RCT_NUMBER_CONVERTER(type, getter) \
  RCT_CUSTOM_CONVERTER(type, type, [RCT_DEBUG ? [self NSNumber:json] : json getter])
```

展开后 `RCT_DEBUG` 出现**两次**：

| `RCT_DEBUG` | 表达式 | 传入 `"abc"` 时 |
| --- | --- | --- |
| `1` | `[[self NSNumber:@"abc"] intValue]` | `NSNumber` 转 `int` 得 **0** |
| `0` | `[@"abc" intValue]` | `NSString` **没有** `intValue` → **`unrecognized selector` 崩溃** |

**且 Release 分支外层没有 `@try`**（`RCT_CUSTOM_CONVERTER` 的 `!RCT_DEBUG` 支），
所以这是**必崩**而非「可能崩」。

> 前提是 JS 侧真的传了字符串给 `int` 类型的 prop。
> 在 Fabric 下 props 由 codegen 校验；在 legacy 架构下 `RCTConvert` 是唯一的防线，
> 而这道防线**只在 Debug 存在**。

### 3.3 枚举转换：Release 下仍有校验

`RCTConvert.mm:259-284` 的 `RCTConvertEnumValue` 是**手写函数而非宏**，
校验逻辑在两个分支下都保留，只有「记不记日志」受 `RCT_DEBUG` 影响：

```objc
NSNumber *RCTConvertEnumValue(const char *typeName, NSDictionary *mapping, NSNumber *defaultValue, id json)
{
  if (!json) {
    return defaultValue;
  }
  if ([json isKindOfClass:[NSNumber class]]) {
    NSArray *allValues = mapping.allValues;
    if ([allValues containsObject:json] || [json isEqual:defaultValue]) {
      return json;
    }
    RCTLogInfo(@"Invalid %s '%@'. should be one of: %@", typeName, json, allValues);
    return defaultValue;
  }
```

**枚举是安全的，数值和 JSON 容器不是。** 这个区分很重要 ——
排查 Release 崩溃时不该把枚举算进去。

### 3.4 数组转换：绕过 ARC 的 `objc_msgSend` + copy-on-write

`RCTConvert.mm:1082-1105`：

```objc
NSArray *RCTConvertArrayValue(SEL type, id json)
{
  __block BOOL copy = NO;
  __block NSArray *values = json = [RCTConvert NSArray:json];
  [json enumerateObjectsUsingBlock:^(id jsonValue, NSUInteger idx, __unused BOOL *stop) {
    id value = ((id (*)(Class, SEL, id))objc_msgSend)([RCTConvert class], type, jsonValue);
    if (copy) {
      if (value) {
        [(NSMutableArray *)values addObject:value];
      }
    } else if (value != jsonValue) {
      // Converted value is different, so we'll need to copy the array
      values = [[NSMutableArray alloc] initWithCapacity:values.count];
      for (NSUInteger i = 0; i < idx; i++) {
        [(NSMutableArray *)values addObject:json[i]];
      }
```

两个设计点：

1. **`objc_msgSend` 直接调用**（`:1087`）—— 快，但**编译器无法校验 `SEL` 与返回类型是否匹配**。
   `SEL` 来自 `RCT_ARRAY_CONVERTER(type)` 宏的 `@selector(type:)`，正确性靠宏使用者的自觉。
2. **copy-on-write** —— 只有当某个元素转换后**指针变了**才复制整个数组。
   对 `NSURLArray` 这类会产生新对象的类型，**必然触发一次全量复制**；
   对 `NSNumberArray` 这类返回原值的类型，全程零拷贝。

### 3.5 `RCT_ENUM_CONVERTER` 用 `dispatch_once` 建映射表

`RCTConvert.h:245-254`：

```objc
#define RCT_ENUM_CONVERTER(type, values, default, getter)                                   \
  +(type)type : (id)json RCT_DYNAMIC                                                        \
  {                                                                                         \
    static NSDictionary *mapping;                                                           \
    static dispatch_once_t onceToken;                                                       \
    dispatch_once(&onceToken, ^{                                                            \
      mapping = values;                                                                     \
    });                                                                                     \
    return _RCT_CAST(type, [RCTConvertEnumValue(#type, mapping, @(default), json) getter]); \
  }
```

映射表**只在首次调用时构造**，之后复用。字面量字典的构造被推迟到运行期，
但因为是常量字面量，编译器仍会生成静态数据 —— 这里省的是 `[NSDictionary dictionaryWithObjectsAndKeys:]`
的运行时组装开销。

---

## 4. RCTAssert：三层结构 + 一个恒空的 handler

### 4.1 `RCTAssert` 在 Release 下整体消失

`RCTAssert.h:22-39`：

```objc
// packages/react-native/React/Base/RCTAssert.h:22-34
#ifndef NS_BLOCK_ASSERTIONS
#define RCTAssert(condition, ...)                                                                    \
  do {                                                                                               \
    if ((condition) == 0) {                                                                          \
      _RCTAssertFormat(#condition, __FILE__, __LINE__, __func__, __VA_ARGS__);                       \
      if (RCT_NSASSERT) {                                                                            \
        [[NSAssertionHandler currentHandler] handleFailureInFunction:(NSString *_Nonnull)@(__func__) \
                                                                file:(NSString *_Nonnull)@(__FILE__) \
                                                          lineNumber:__LINE__                        \
                                                         description:__VA_ARGS__];                   \
      }                                                                                              \
    }                                                                                                \
  } while (false)
#else
#define RCTAssert(condition, ...) \
  do {                            \
  } while (false)
#endif
```

`condition` 是**参数**，所以 Release 下（`NS_BLOCK_ASSERTIONS=1`）
**条件表达式本身都不会被求值** —— 调用点的副作用也一并消失。

### 4.2 三层的职责分离

| 层 | 受什么控制 | Release 下 |
| --- | --- | --- |
| `_RCTAssertFormat(...)` 调用 | `NS_BLOCK_ASSERTIONS` | **不调用**（整个宏变 `do{}while(0)`） |
| `assertFunction(...)` 调用 | 永远在宏体内 | — |
| `NSAssertionHandler` 抛异常 | `RCT_NSASSERT`（默认 = `RCT_DEBUG`） | — |

`_RCTAssertFormat`（`RCTAssert.m:103-120`）无论 `RCT_DEBUG` 如何都会调用 `assertFunction`：

```objc
void _RCTAssertFormat(
    const char *condition,
    const char *fileName,
    int lineNumber,
    const char *function,
    NSString *format,
    ...)
{
  RCTAssertFunction assertFunction = RCTGetLocalAssertFunction();
  if (assertFunction) {
    va_list args;
    va_start(args, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:args];
    va_end(args);

    assertFunction(@(condition), @(fileName), @(lineNumber), @(function), message);
  }
}
```

**但这层在 Release 下也进不去**（见 4.1）。
头文件注释说「custom assert functions will still be called」——
**这句话只在 `RCT_DEBUG=1` 且 `NS_BLOCK_ASSERTIONS=0` 时成立**，
而那正是默认 Debug 配置，所以注释没错，但适用范围没写出来。

### 4.3 线程局部栈：assert 函数可以按线程覆盖

`RCTAssert.m:64-73`：

```objc
/**
 * returns the topmost stacked assert function for the current thread, which
 * may not be the same as the current value of RCTCurrentAssertFunction.
 */
static RCTAssertFunction RCTGetLocalAssertFunction(void)
{
  NSMutableDictionary *threadDictionary = [NSThread currentThread].threadDictionary;
  NSArray<RCTAssertFunction> *functionStack = threadDictionary[RCTAssertFunctionStack];
  RCTAssertFunction assertFunction = functionStack.lastObject;
  if (assertFunction) {
    return assertFunction;
  }
  return RCTCurrentAssertFunction;
}
```

栈存在 `NSThread.threadDictionary` 里 —— **每线程独立**，
`RCTPerformBlockWithAssertFunction`（`:75-86`）压栈/弹栈配对。

> **与 14 文档 BRG-1 同类问题**：`RCTAssert.m:83-85` 的
> `[functionStack addObject:]` / `block()` / `[functionStack removeLastObject]`
> **没有 `@try/@finally`**。若 `block` 抛异常，栈项**永久泄漏**在该线程上，
> 后续所有断言都会用这个失效的 handler。

RCTLog 有**完全相同**的实现（`RCTLog.mm:158-169`），同样的问题。

### 4.4 `RCTFatal`：Debug 自抛自接，Release 才真崩

`RCTAssert.m:122-153`（20 文档 CM-3 已记录，本文补充 handler 的可达性）：

```objc
void RCTFatal(NSError *error)
{
  _RCTLogNativeInternal(RCTLogLevelFatal, NULL, 0, @"%@", error.localizedDescription);

  RCTFatalHandler fatalHandler = RCTGetFatalHandler();
  if (fatalHandler) {
    fatalHandler(error);
  } else {
#if DEBUG
    @try {
#endif
      NSString *name = [NSString stringWithFormat:@"%@: %@", RCTFatalExceptionName, error.localizedDescription];
```

`RCTFatalException`（`:206-223`）是同一个模式。

**Debug 下的净效果**：`@throw` 之后紧跟一个**空的** `@catch (NSException *) { }`，
异常被就地吞掉，`RCTFatal` **正常返回**，调用方继续执行。
唯一的痕迹是 `:124` 那条 `RCTLogLevelFatal` 日志。

### 4.5 四个 handler 安装函数：全仓库 0 调用

~~~bash
$ for s in RCTSetFatalHandler RCTSetFatalExceptionHandler RCTSetAssertFunction RCTAddAssertFunction; do
    echo "$s: $(grep -rn "$s" packages/ --include='*.m' --include='*.mm' --include='*.h' \
      | grep -v 'React/Base/RCTAssert\.' | wc -l | tr -d ' ') 处外部引用"
  done
RCTSetFatalHandler: 0 处外部引用
RCTSetFatalExceptionHandler: 0 处外部引用
RCTSetAssertFunction: 0 处外部引用
RCTAddAssertFunction: 0 处外部引用
~~~
~~~

**因此在 RN 自身不做任何设置的前提下：**

| 变量 | 实际值 | 后果 |
| --- | --- | --- |
| `RCTCurrentFatalHandler` | 恒 `nil` | `RCTFatal` 的 `:127` 分支**不可达** |
| `RCTCurrentFatalExceptionHandler` | 恒 `nil` | `RCTFatalException` 的 `:211` 分支**不可达** |
| `RCTCurrentAssertFunction` | 恒 `nil` | `RCTAssert` **完全静默**（Debug 下也不报任何东西） |
| `NSAssertionHandler` | 系统默认 | Debug 下 `RCT_NSASSERT` 仍会抛，但只对 `RCTAssert` 生效 |

> **这修正了 20 文档 §「RCTFatal 终止机制」的一处前提**：
> 20 文档与 04 文档都写了「`RCTFatalHandler`（若有）执行」，
> 但**这个「若有」在 RN 仓库内永远不成立**。
> 只有宿主 App 主动调用 `RCTSetFatalHandler` 才会走到。
>
> 这不是 bug —— `RCTAssert.h:48-52` 明确写了这四个函数是给宿主用的：
> "You can customize the fatal behaviour by setting a custom fatal handler"。
> 但**「默认行为」这个前提值得写明**，否则读者会以为 RN 内部有兜底。

**`RCTCurrentAssertFunction` 恒 nil 的后果尤其值得注意**：
`RCTAssertMainQueue()` / `RCTAssertNotMainQueue()` / `RCTAssertParam()`
这些宏在 Debug 下**只会触发系统 `NSAssertionHandler`**，
不会有任何 RN 特有的输出。

---

## 5. RCTLog：一条恒真的短路 + 一条不脱敏的输出

### 5.1 阈值默认为 0，等于不设阈

`RCTLog.mm:24-36`：

```objc
const char *RCTLogLevels[] = {
    "trace",
    "info",
    "warn",
    "error",
    "fatal",
};

/* os log will discard debug and info messages if they are not needed */
static const RCTLogLevel RCTDefaultLogThreshold = (RCTLogLevel)(RCTLogLevelInfo - 1);
```

`RCTLogLevelInfo = 1`，所以阈值 = `0 = RCTLogLevelTrace`。
配合 `RCTLog.h:43-49` 的枚举（`Trace=0 ... Fatal=4`），
**任何级别的日志都满足 `level >= RCTGetLogThreshold()`**，阈值等于没设。

注释里说的「os log 会丢弃 debug 和 info」是 **os_log 子系统的行为**，
不是 RN 的过滤 —— RN 照样把消息交给它。

### 5.2 `log` 判定恒为真

`RCTLog.mm:252-256`：

```objc
void _RCTLogNativeInternal(RCTLogLevel level, const char *fileName, int lineNumber, NSString *format, ...)
{
  RCTLogFunction logFunction = RCTGetLocalLogFunction();
  BOOL log = RCT_DEBUG || (logFunction != nil);
  if (log && level >= RCTGetLogThreshold()) {
```

`RCTGetLocalLogFunction()`（`:147-156`）在无线程局部栈时**返回 `RCTGetLogFunction()`**，
而后者（`:121-127`）是：

```objc
RCTLogFunction RCTGetLogFunction()
{
  if (!RCTCurrentLogFunction) {
    RCTCurrentLogFunction = RCTDefaultLogFunction;
  }
  return RCTCurrentLogFunction;
}
```

**`RCTCurrentLogFunction` 永远非 `nil`**（就算被 `RCTSetLogFunction(nil)` 清空，
下一次 `RCTGetLogFunction()` 也会立刻补回默认值）。

> **所以 `logFunction != nil` 恒为 `YES`，`BOOL log` 恒为 `YES`，`RCT_DEBUG ||` 那一半是死代码。**
>
> 这一点必须精确表述，因为容易推错：**Release 下 `RCTLogInfo` 照样写 os_log，并未被丢弃。**
> 若当初按「`RCT_DEBUG=0` → 日志全丢」去理解，就会漏掉这条路径。

### 5.3 默认 log function 用 `%{public}s` —— **不做脱敏**

`RCTLog.mm:107-114`：

```objc
RCTLogFunction RCTDefaultLogFunction =
    ^(RCTLogLevel level,
      RCTLogSource source,
      __unused NSString *fileName,
      __unused NSNumber *lineNumber,
      NSString *message) {
      os_log_with_type(RCTLogForLogSource(source), RCTLogTypeForLogLevel(level), "%{public}s", message.UTF8String);
    };
```

**`%{public}` 让 os_log 不把内容标记为私有**。
在统一日志（Unified Logging）里：

| 标记 | 表现 |
| --- | --- |
| `%{public}@` / `%{public}s` | 内容**明文可见**，`log stream` / Console.app / MDM 日志采集都能读到 |
| `%{private}@` / `%{private}s` | 系统存全文但对外显示 `<private>`，需 entitlement 才能看原文 |

**RN 选了 `public`。** 意味着**任何 JS 侧 `console.log` 的内容、以及所有
`RCTLogError` 的消息，都以明文进入 iOS 统一日志**。

日志被分成两个 os_log 通道（`RCTLog.mm:85-105`）：

| source | os_log 名称 |
| --- | --- |
| `RCTLogSourceNative` | `com.facebook.react.log:native` |
| `RCTLogSourceJavaScript` | `com.facebook.react.log:javascript` |

> **适用范围**：这是**默认** log function。宿主可通过 `RCTSetLogFunction`
> 替换为写 Crashlytics / 自建上报的实现（`RCTLog.mm:116-119`），
> 也可用 `RCTAddLogFunction`（`:129-141`）**叠加**而不替换。
> 若是后者，默认的 os_log 输出**依然存在**，脱敏责任仍在 App 侧。

### 5.4 error 级日志会触发 `[NSThread callStackSymbols]`

`RCTLog.mm:269-273`：

```objc
    // Log to red box if one is configured.
    if (RCTSharedApplication() && RCTRedBoxGetEnabled() && level >= RCTLOG_REDBOX_LEVEL) {
      NSArray<NSString *> *stackSymbols = [NSThread callStackSymbols];
      NSMutableArray<NSDictionary *> *stack = [NSMutableArray arrayWithCapacity:(stackSymbols.count - 1)];
```

`RCTLog.h:25-27` 定义了阈值：

```objc
#ifndef RCTLOG_REDBOX_LEVEL
#define RCTLOG_REDBOX_LEVEL RCTLogLevelError
#endif
```

**默认阈值 = `RCTLogLevelError`（3）。** 三重条件里：

| 条件 | Debug | Release |
| --- | --- | --- |
| `RCTSharedApplication()` | 真（除非 App Extension） | 同 |
| `RCTRedBoxGetEnabled()` | **真**（`RCTRedBoxSetEnabled.m:11`） | **假**（`:13`） |
| `level >= Error` | — | — |

**所以 Release 下这段昂贵的栈回溯被 `RCTRedBoxGetEnabled()` 完全短路** ——
一次都不执行。这是 [22 文档 §5](./22-iOS崩溃UI层RedBox与LogBox.md) 那条运行期门控
在日志层的直接收益。

Debug 下每次 `RCTLogError` 都要付：

1. `[NSThread callStackSymbols]` —— 回溯并符号化**整条原生调用栈**；
2. 对每一帧跑一次正则（`nativeStackFrameRegex()`，`:236-250`）；
3. 对匹配到的 C++ 符号跑 `abi::__cxa_demangle`（`:286-290`，每次都要 `malloc`/`free`）；
4. `dispatch_async` 到主队列 + `moduleForName:lazilyLoadIfNecessary:YES`（`:300-304`）。

第 4 步的注释说明了动机：

```objc
// packages/react-native/React/Base/RCTLog.mm:300-304
      dispatch_async(dispatch_get_main_queue(), ^{
        // red box is thread safe, but by deferring to main queue we avoid a startup
        // race condition that causes the module to be accessed before it has loaded
        RCTModuleRegistry *moduleRegistry = RCTLogBridgeModuleRegistry ?: RCTLogBridgelessModuleRegistry;
        id redbox = [moduleRegistry moduleForName:"RedBox" lazilyLoadIfNecessary:YES];
```

> **注意 `??:` 的降级顺序**（`:303`）：先 Bridge 的 registry，再 Bridgeless 的。
> 两个 registry 是 `static __weak`（`:38-42`），由
> `RCTLogSetBridgeModuleRegistry` / `RCTLogSetBridgelessModuleRegistry` 设置。
> 若两者都还没被设置（日志发生在 `RCTReactNativeFactory` 完成装配之前），
> `moduleRegistry` 是 `nil`，`[nil moduleForName:...]` 返回 nil，**静默跳过**。

### 5.5 Debug 下额外转发一条到 JS

`RCTLog.mm:317-324`：

```objc
#if RCT_DEBUG
    if (!RCTRunningInTestEnvironment()) {
      // Log to JS executor
      NSString *levelString = level ? @(RCTLogLevels[level]) : @"info";
      RCTCallableJSModules *callableModule = RCTLogBridgeCallableJSModules ?: RCTLogBridgelessCallableJSModules;
      [callableModule invokeModule:@"RCTLog" method:@"logIfNoNativeHook" withArgs:@[ levelString, message ]];
    }
#endif
```

`RCTRunningInTestEnvironment`（`RCTUtils.mm:586-596`）会排除测试环境，
避免日志打到 JS 侧再被测试框架捕获。

### 5.6 两个格式化函数的级别名不一致

| 位置 | `RCTLogLevelWarning` 的输出 |
| --- | --- |
| `RCTLog.mm:24-30` 的 `RCTLogLevels[]` | `"warn"` |
| `RCTLog.mm:218-224` 的 `RCTFormatLogLevel()` | `"warning"` |

同一级别在**默认 os_log 输出**和 **`RCTFormatLogLevel` API** 里叫两个名字。
22 文档 §7 提到的 `RCTFormatLogLevel` 面向的是宿主（如 Metro 状态页），
两边若都消费日志文本会做不一致的字符串匹配。

---

## 6. RCTUtils：两个恒定/死掉的全局状态

### 6.1 `RCTIsNewArchEnabled` 硬编码 `YES` **且零调用**

```objc
// packages/react-native/React/Base/RCTUtils.mm:47-50
BOOL RCTIsNewArchEnabled(void)
{
  return YES;
}
```

~~~bash
$ grep -rn "RCTIsNewArchEnabled" packages/ --include="*.m" --include="*.mm" --include="*.h"
packages/react-native/React/Base/RCTUtils.h:18:RCT_EXTERN BOOL RCTIsNewArchEnabled(void);
packages/react-native/React/Base/RCTUtils.mm:47:BOOL RCTIsNewArchEnabled(void)
~~~

**只有声明和定义，没有任何调用。**

> 这与既有的「`UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE` 硬编码 `false`、
> 但仍有 18 处引用」是**不同性质**的问题：
> 那一个是「开关锁死但代码还在跑」，这一个连代码都不跑了。
>
> 从「legacy 架构开关」退化为无条件 `YES` 再退化为删除调用点，
> 只留下函数签名 —— 说明新架构已成为唯一路径，
> 而**函数本身是清理过程中的残留**。

### 6.2 `RCTAreLegacyLogsEnabled` 是真正的 `#if RCT_DEBUG` 门控

`RCTUtils.mm:52-61`：

```objc
BOOL RCTAreLegacyLogsEnabled(void)
{
#if RCT_DEBUG
  static BOOL legacyLogEnabled =
      ((NSNumber *)[[NSBundle mainBundle] objectForInfoDictionaryKey:@"RCTLegacyWarningsEnabled"]).boolValue;
  return legacyLogEnabled;
#else
  return NO;
#endif
}
```

**需要 `RCT_DEBUG=1` 且 App 的 `Info.plist` 里 `RCTLegacyWarningsEnabled = true`。**
两个条件缺一不可。三个使用点：

| 使用点 | 位置 |
| --- | --- |
| `RCTBridge.mm:145` | 过滤 legacy 模块类的日志 |
| `RCTInteropTurboModule.mm:341` | 同上 |
| `RCTInstance.mm:538` | 同上 |

**Release 下恒为 `NO`**，即 legacy 日志通道**编译期仍然存在，运行时全部关闭**。

### 6.3 `RCTKeyWindow`：注释记录了一次真实的白屏回归

`RCTUtils.mm:611-678`。函数先按 `UIScene` 找，找不到再走 legacy 兜底：

```objc
  // Fallback for apps still on the legacy UIApplicationDelegate lifecycle (no
  // SceneDelegate / no UIApplicationSceneManifest, or scene migration disabled).
  // Their key window is created and owned by the app delegate and is not attached
  // to a foreground UIWindowScene, so the scene-based lookup above finds nothing.
  // This diff moved several call sites from `delegate.window` to RCTKeyWindow(),
  // so without this fallback RCTKeyWindow() returns nil for those apps and RN's
  // window/screen/dimension resolution (RCTViewportSize, RCTDeviceInfo,
  // RCTPresentedViewController, …) breaks — the RN UI never renders.
```

> **这段注释是源码里对「白屏」最直接的说明**：
> 把若干调用点从 `delegate.window` 改成 `RCTKeyWindow()`，
> 对仍用 legacy 生命周期的 App，若没有这个兜底分支，**`RCTKeyWindow()` 返回 nil**，
> 依赖它的视口尺寸/设备信息/presenting VC 全部失效，**RN UI 根本不渲染**。
>
> 兜底被 `RCTIsSceneDelegateApp()`（`:680-696`，读 `Info.plist` 的
> `UIApplicationSceneManifest.UISceneConfigurations`）严格门控在 legacy 路径，
> 注释说明了原因：scene App 走这条会拿到**错误的 window 而非正确的 nil**。

**三级返回路径**：

| 顺序 | 条件 | 返回 |
| --- | --- | --- |
| 1 | 正在 `UIWindowScene` 前台活跃 | `windowScene.keyWindow`（iOS 15+） |
| 2 | 同上但不活跃 / 旧系统 | 遍历 `windowScene.windows` 找 `isKeyWindow` |
| 3 | `!RCTIsSceneDelegateApp()` | `RCTSharedApplication().delegate.window` |
| 4 | 都不满足 | **`nil`** |

**第 4 条（scene App 但没有活跃 window）是唯一返回 nil 的路径。**

`RCTRunningInAppExtension()`（`:598-601`）在 App Extension 里让前两步直接返回 nil ——
Extension 里不该有 `UIApplication`。

---

## 7. 色彩空间：注释与实现**矛盾**

`RCTConvert.mm:905-918`：

```objc
// The iOS side is kept in synch with the C++ side by using the
// RCTAppDelegate which, at startup, sets the default color space.
// The usage of dispatch_once and of once_flag ensoure that those are
// set only once when the app starts and that they can't change while
// the app is running.
static RCTColorSpace _defaultColorSpace = RCTColorSpaceSRGB;
RCTColorSpace RCTGetDefaultColorSpace(void)
{
  return _defaultColorSpace;
}
void RCTSetDefaultColorSpace(RCTColorSpace colorSpace)
{
  _defaultColorSpace = colorSpace;
}
```

**注释里声称的两样东西，样样都不存在**：

1. **`dispatch_once`** —— 本文件里一处都没有（对比同文件 `RCTEnumConverter` 的宏、
   `RCTLog.mm:89-93` 的 `os_log_t` 缓存，都有 `dispatch_once`）。
2. **`once_flag`** —— 那是 C++ 侧的说法。C++ 侧的实现是：

```cpp
// packages/react-native/ReactCommon/react/renderer/graphics/ColorComponents.cpp:9-21
#include <mutex>

namespace facebook::react {

static ColorSpace defaultColorSpace = ColorSpace::sRGB;

ColorSpace getDefaultColorSpace() {
  return defaultColorSpace;
}

void setDefaultColorSpace(ColorSpace newColorSpace) {
  defaultColorSpace = newColorSpace;
}
```

**C++ 侧也没有 `once_flag`** —— `defaultColorSpace` 是裸 `static ColorSpace`，
**不是 `std::atomic`**。而 `:9` 的 `#include <mutex>` **在整个文件里没有任何使用**
（没有 `std::mutex`、没有 `std::lock_guard`）—— 是同步代码被移除后残留的头文件。

### 7.1 注释还把同步点说错了

注释说「由 RCTAppDelegate 在启动时设置」，实际调用方是：

```objc
// packages/react-native/React/Fabric/Utils/RCTColorSpaceUtils.mm:14-21
+ (void)applyDefaultColorSpace:(RCTColorSpace)colorSpace
{
  facebook::react::ColorSpace cxxColorSpace =
      colorSpace == RCTColorSpaceSRGB ? facebook::react::ColorSpace::sRGB : facebook::react::ColorSpace::DisplayP3;

  RCTSetDefaultColorSpace(colorSpace);
  facebook::react::setDefaultColorSpace(cxxColorSpace);
}
```

唯一调用点是 `Libraries/AppDelegate/RCTReactNativeFactory.mm:87`
（`RCTAppDelegate` 只是 RCTAppDelegate 时代的旧称）。

### 7.2 数据竞争的实际风险

`ColorComponents.h:24` 把 `getDefaultColorSpace()` 用作**默认成员初始化器**：

```cpp
ColorSpace colorSpace{getDefaultColorSpace()};
```

即**每一个 `Color` 构造时都会读这个全局变量** —— 包括 Shadow 线程和渲染线程。
写入方 `applyDefaultColorSpace:` 在主线程启动阶段。

- **实际风险低**：写入远早于任何 `Color` 构造。
- **但不是零**：`RCTReactNativeFactory.mm:87` 之后若还有别的 `Color` 构造路径
  与写入并发，就是 UB。裸 `static` 非原子，编译器可缓存多次读。

> **结论**：注释描述的保护**并不存在**，
> 当前的正确性依赖**「先写后读」的时序巧合**，而非任何同步原语。
> 补上 `std::atomic` 或一次性的 `dispatch_once` 都能让实现与注释一致。

---

## 8. RCTConstants：平台名硬编码 + 一个恒关的开关

### 8.1 `RCTPlatformName` 恒为 `"ios"`

`RCTConstants.m:10`：

```objc
NSString *const RCTPlatformName = @"ios";
```

**tvOS 上也上报 `"ios"`。** 这与既有的
「`view/platform/tvos` 全仓库 0 引用、是死代码」是同一个根源：
tvOS 支持在这份代码里已经不完整。用到 `RCTPlatformName` 的地方：

| 位置 | 用途 |
| --- | --- |
| `RCTDevSettings.mm:484` | 上报给 DevSettings |
| `RCTPackagerConnection.mm:86` | Packager `role` query item |
| `RCTInspectorUtils.mm:37` | `CommonHostMetadata.platform` |
| `RCTBundleURLProvider.mm:469` | bundle URL 的 `platform` 参数 |

**后两处会直接影响开发者看到的调试信息**（DevTools 显示的平台名、Metro 连接的 role）。

### 8.2 W3C 指针事件开关恒为关闭

`RCTConstants.m:31-41`：

```objc
static BOOL RCTDispatchW3CPointerEvents = NO;

BOOL RCTGetDispatchW3CPointerEvents(void)
{
  return RCTDispatchW3CPointerEvents;
}

void RCTSetDispatchW3CPointerEvents(BOOL value)
{
  RCTDispatchW3CPointerEvents = value;
}
```

~~~bash
$ grep -rn "RCTSetDispatchW3CPointerEvents\|RCTGetDispatchW3CPointerEvents" \
    packages/ --include="*.m" --include="*.mm" --include="*.h"
packages/react-native/React/Fabric/RCTSurfaceTouchHandler.mm:162:    if (RCTGetDispatchW3CPointerEvents()) {
packages/react-native/React/Base/RCTConstants.h:52:RCT_EXTERN BOOL RCTGetDispatchW3CPointerEvents(void);
packages/react-native/React/Base/RCTConstants.h:53:RCT_EXTERN void RCTSetDispatchW3CPointerEvents(BOOL value);
packages/react-native/React/Base/RCTConstants.m:33:BOOL RCTGetDispatchW3CPointerEvents(void)
packages/react-native/React/Base/RCTConstants.m:38:void RCTSetDispatchW3CPointerEvents(BOOL value)
~~~

**`RCTSetDispatchW3CPointerEvents` 全仓库 0 调用**（只有定义，无调用）。
唯一的读取点 `RCTSurfaceTouchHandler.mm:162` 因此**恒为 `NO`**。

`RCTConstants.h:28-30` 的注释写的是 "W3C Pointer Events"，
暗示这是一个可启用的能力 —— 实际上它是一个**永远关闭的分支**，
连同 `RCTSurfaceTouchHandler.mm:162` 之后的整段代码一起成为死代码。

---

## 9. RCTVersion：开发占位符 1000.0.0

`RCTVersion.m:16-30`：

```objc
NSDictionary* RCTGetReactNativeVersion(void)
{
  static NSDictionary* __rnVersion;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^(void){
    __rnVersion = @{
                  RCTVersionMajor: @(1000),
                  RCTVersionMinor: @(0),
                  RCTVersionPatch: @(0),
                  RCTVersionPrerelease: [NSNull null],
                  };
  });
  return __rnVersion;
}
```

**`@(1000)` 是占位符**，真实版本由发布脚本改写。
证据在发布脚本的测试快照里（`scripts/releases/__tests__/__snapshots__/set-rn-artifacts-version-test.js.snap`）
—— 文件头多了 `<< GENERATED >>` 标记，值被替换成实际版本号。

**消费方**（两个，都会显示给开发者）：

| 位置 | 用途 |
| --- | --- |
| `RCTPlatform.mm:61` | `Platform.constants.reactNativeVersion`（**JS 侧可读**） |
| `RCTInspectorUtils.mm:31` | `CommonHostMetadata.reactNativeVersion`（**DevTools 显示**） |

> **适用范围精确表述**：从 git checkout 构建、且**未运行发布脚本**时，
> `Platform.constants.reactNativeVersion.major === 1000`。
> 这是**开发态的预期行为**，不是 bug。
> 但若某个 QA/CI 环境把这份值带进线上包，DevTools 会显示 `1000.0.0`。

---

## 10. RCTCxxConvert：完全的空实现

```objc
// packages/react-native/React/Base/RCTCxxConvert.m:8-13
#import "RCTCxxConvert.h"

@implementation RCTCxxConvert

@end
```

头文件（`RCTCxxConvert.h:11-17`）也只声明了一个空 `@interface`：

```objc
/**
 * This class provides a collection of conversion functions for mapping
 * JSON objects to cxx types. Extensible via categories.
 * Convert methods are expected to return cxx objects wrapped in RCTManagedPointer.
 */

@interface RCTCxxConvert : NSObject

@end
```

**注释描述的能力（把 JSON 转成 `RCTManagedPointer` 包装的 C++ 对象）
一行都没有实现。** 这是一个「接口先落地、实现后补」的占位，
且**没有任何 category 为它添加方法**（否则 `.m` 不会这么空）。

---

## 11. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| U-1 | **`RCT_CUSTOM_CONVERTER` 的 Debug/Release 语义反转** —— Debug 有 `@try/@catch` 降级，Release 直接抛 | `React/Base/RCTConvert.h:210` | **Release 下类型不匹配 = 未捕获 ObjC 异常 = 崩溃** |
| U-2 | `RCT_JSON_CONVERTER` 在 Release 下不做任何类型检查 | `React/Base/RCTConvert.mm:50-54` | 错误从「记日志降级」推迟为「调用方处崩溃」，栈失真 |
| U-3 | `RCT_NUMBER_CONVERTER` 的 Release 分支跳过 `NSNumber` 转换且无 `@try` | `React/Base/RCTConvert.h:229` | 传字符串给数值 prop → `unrecognized selector` **必崩** |
| U-4 | 四个 handler 安装函数全仓库 0 调用 | `React/Base/RCTAssert.m:36, 46, 155, 225` | `RCTAssert` 默认**完全静默**；`RCTFatal` 的自定义分支不可达（**修正 20/04 文档的前提**） |
| U-5 | `RCTPerformBlockWith{Assert,Log}Function` 缺 `@finally` | `React/Base/RCTAssert.m:83-85`、`React/Base/RCTLog.mm:166-168` | block 抛异常 → 线程局部栈**永久泄漏**失效 handler（同 14 文档 BRG-1） |
| U-6 | 默认 log function 用 `%{public}s` 写 os_log | `React/Base/RCTLog.mm:113` | **所有 JS 日志与 native 错误明文进入统一日志**，无脱敏 |
| U-7 | `BOOL log = RCT_DEBUG \|\| (logFunction != nil)` 恒为真 | `React/Base/RCTLog.mm:255` | 死代码；且**易被误读为「Release 日志全丢」**（实际不丢） |
| U-8 | **注释声称的 `dispatch_once`/`once_flag` 在 ObjC 与 C++ 两侧都不存在** | `React/Base/RCTConvert.mm:907-909` | 色彩空间全局变量是**裸的非原子**；正确性依赖时序巧合 |
| U-9 | `ColorComponents.cpp` 的 `#include <mutex>` 无任何使用 | `ReactCommon/react/renderer/graphics/ColorComponents.cpp:9` | 同步代码移除后的残留，进一步佐证 U-8 |
| U-10 | `RCTIsNewArchEnabled` 硬编码 `YES` **且零调用** | `React/Base/RCTUtils.mm:47-50` | 新架构判定已彻底移除，函数是清理残留 |
| U-11 | `RCTSetDispatchW3CPointerEvents` 零调用 → 读取点恒 `NO` | `React/Base/RCTConstants.m:38`、`React/Fabric/RCTSurfaceTouchHandler.mm:162` | W3C 指针事件整条路径是死代码 |
| U-12 | `RCTPlatformName` 硬编码 `"ios"` | `React/Base/RCTConstants.m:10` | tvOS 上 DevTools / Metro 都自称 ios |
| U-13 | `RCTFormatLogLevel` 用 `"warning"`，`RCTLogLevels[]` 用 `"warn"` | `React/Base/RCTLog.mm:222` vs `:27` | 同级别两个名字，消费方字符串匹配会不一致 |
| U-14 | `RCTGetReactNativeVersion()` 硬编码 `1000.0.0` | `React/Base/RCTVersion.m:21` | 未经发布脚本构建时，JS 与 DevTools 都看到 1000.0.0 |
| U-15 | `RCTCxxConvert` 头注释描述的能力零实现 | `React/Base/RCTCxxConvert.m:10-12` | 空壳类，无 category 扩展 |
| U-16 | Debug 下每次 `RCTLogError` 都做完整符号化 + `__cxa_demangle` | `React/Base/RCTLog.mm:271-290` | 开发期日志开销大；Release 下被 `RCTRedBoxGetEnabled()` 短路 |

### U-1/U-2/U-3 的适用范围（必须写清楚）

这三个问题**只在同时满足以下条件时才会成为线上崩溃源**：

| 条件 | 说明 |
| --- | --- |
| `RCT_DEBUG = 0` | Release 构建（或显式定义） |
| JS 传入了类型不符的 prop | 例如给 `int` 类型的原生 prop 传字符串 |
| 走的是 **legacy 架构**的 `RCTConvert` 路径 | Fabric 下 props 由 codegen 在 JS 侧校验 |

**Fabric 架构下这些转换器仍被 ViewManager 的 `RCT_CUSTOM_VIEW_PROPERTY` 使用**，
所以「Fabric 安全」**不成立** —— 只是 prop 值来自 codegen 校验过的 props，来源更规整。

---

## 12. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 04/20 文档：「`RCTFatal` 的 `@throw` 仅 DEBUG 下被包裹」 | **确认**（§4.4），并补充「handler 分支不可达」（U-4） |
| 22 文档：`RCTRedBoxGetEnabled()` 在 Release 下为 `NO` | **新增用途**：它同时短路了日志层的符号化开销（§5.4） |
| 14 文档 BRG-1：线程局部栈缺 `@finally` | **同型扩散**：Log 侧 `RCTLog.mm:166-168` 有一模一样的实现（U-5） |
| 既有：`UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE` 硬编码 | **不同型**：`RCTIsNewArchEnabled` 更彻底，连调用点都没了（U-10） |
| 既有：`view/platform/tvos` 是死代码 | **同源**：`RCTPlatformName` 也恒为 `"ios"`（U-12） |
| 05 文档：白屏成因 | **补上源码级证据**：`RCTKeyWindow` 注释记录的白屏回归（§6.3） |
