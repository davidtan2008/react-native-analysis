---
id: 54
title: "iOS 参数转换层：release 构建下三层防护全部消失，类型错误从「可捕获的日志」变成远处的崩溃"
topic: PL.ios
symptoms: [bridge]
platforms: [ios]
architecture: [cross]
layer: T3
symbols: ["RCTConvert", "RCT_JSON_CONVERTER"]
claims: [TT-1, TT-2, TT-3, TT-4, TT-5, TT-6]
---
# 54 · iOS 参数转换层：release 构建下三层防护全部消失，类型错误从「可捕获的日志」变成远处的崩溃

> **模块**：C1 ·
> `packages/react-native/React/Base/RCTConvert.h`（286）、
> `React/Base/RCTConvert.mm`（1387）、
> `React/Base/RCTModuleMethod.mm`（618）、
> `React/Base/RCTDefines.h`（169）
>
> **基线**：react-native @ `9b131e42` · iOS 侧 · **legacy 架构（Paper / Bridge）路径**
>
> **前置**：[38 文档](./38-Modules余部EventEmitter与LayoutAnimation.md) 记录
> `RCT_CUSTOM_CONVERTER` 的 Debug/Release 语义，并明确指出
> **「不是普遍规则」** —— 本文即是对那条限定语的**量化与扩展**：
> 三处相关宏（`RCT_JSON_CONVERTER` / `RCT_CUSTOM_CONVERTER` / `RCT_NUMBER_CONVERTER`）
> 构成**同一个方向的完整链条**，且比 38 文档记录的那一处影响面大得多。
> [20 文档](./20-iOS-CoreModules与崩溃终止机制.md) 记录 iOS 崩溃终止机制。
>
> 本文的核心是一个可由宏展开逐字推出的结论：
> **debug 构建下参数转换有 3 层防护，release 构建下 1 层都没有。**

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/React/Base/RCTConvert.h` | 286 | 转换器声明 + **3 个宏定义** |
| `packages/react-native/React/Base/RCTConvert.mm` | 1387 | 转换器实现 + `RCT_JSON_CONVERTER` 定义 |
| `packages/react-native/React/Base/RCTModuleMethod.mm` | 618 | 调用点：参数装配与 invoke |
| `packages/react-native/React/Base/RCTDefines.h` | 169 | `RCT_DEBUG` 的定义 |

---

## 2. 开关：`RCT_DEBUG` 的语义是「发布构建排除错误检查」

```c
// packages/react-native/React/Base/RCTDefines.h:25-35
/**
 * The RCT_DEBUG macro can be used to exclude error checking and logging code
 * from release builds to improve performance and reduce binary size.
 */
#ifndef RCT_DEBUG
#ifdef DEBUG
#define RCT_DEBUG 1
#else
#define RCT_DEBUG 0
#endif
#endif
```

**注释把意图写得非常明确**：

| 项 | 内容 |
| --- | --- |
| **用途** | `exclude error checking and logging code` |
| **目的** | `to improve performance and reduce binary size` |
| **取值** | 有 `DEBUG` 宏 → `1`；否则 → `0` |

> **即 `RCT_DEBUG` 是「发布构建」判定，而非「是否检查」判定。**
> **下面三处宏都按它二分，且三处的 Release 分支都比 Debug 分支少检查。**

---

## 3. 【核心 TT-1】`RCT_JSON_CONVERTER`：release 下类型检查完全消失

### 3.1 宏的完整定义

```objc
// packages/react-native/React/Base/RCTConvert.mm:38-55
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

**Debug 分支 3 条语句；Release 分支 1 条：`return json;`。**

### 3.2 它生成的是四个最基础的类型转换

```objc
// packages/react-native/React/Base/RCTConvert.mm:57-60
RCT_JSON_CONVERTER(NSArray)
RCT_JSON_CONVERTER(NSDictionary)
RCT_JSON_CONVERTER(NSString)
RCT_JSON_CONVERTER(NSNumber)
```

| 生成的方法 | Debug 行为 | **Release 行为** |
| --- | --- | --- |
| `+[RCTConvert NSArray:]` | 类型不符则 **记日志 + 返回 `nil`** | **原样返回 `json`** |
| `+[RCTConvert NSDictionary:]` | 同上 | **原样返回 `json`** |
| `+[RCTConvert NSString:]` | 同上 | **原样返回 `json`** |
| `+[RCTConvert NSNumber:]` | 同上 | **原样返回 `json`** |

### 3.3 后果：返回类型与实际类型不符，崩溃被推迟到调用点

**Release 构建下，以下调用都不再有任何类型保证**：

```
[RCTConvert NSArray:@{@"a": @1}]        // 返回 NSDictionary，但声明是 NSArray *
[RCTConvert NSDictionary:@[@1, @2]]     // 返回 NSArray，但声明是 NSDictionary *
[RCTConvert NSString:@{@"a": @1}]       // 返回 NSDictionary，但声明是 NSString *
[RCTConvert NSNumber:@[@1]]             // 返回 NSArray，但声明是 NSNumber *
```

**Objective-C 不检查 `id` → 具体类型的转换**，因此**此处不会立即崩溃**。

| 阶段 | Debug | **Release** |
| --- | --- | --- |
| 转换处 | 记 `RCTLogConvertError`，**返回 nil** | **静默通过** |
| 调用处（`[array count]` 之类） | 向 `nil` 发消息 → **返回 0，安全** | 向 `NSDictionary` 发 `count` → **崩溃** |
| **崩溃位置** | 不崩溃 | **远离转换点的调用处** |

> **这是本次发现中最重要的一点**：
> **Debug 下类型错误在转换点被捕获并留有日志；Release 下它变成一次远处的、
> 难以定位的崩溃（栈顶是业务代码，不是参数边界）。**
>
> **对照 41 文档记录的 RN 崩溃策略**：
> RN 的崩溃日志会采集但不上传（44 文档 §「不做崩溃上传」），
> **所以 release 的这次崩溃既本地不可诊断、也无远程上报** ——
> **即 TT-1 的代价是「静默的、不可诊断的崩溃」。**

### 3.4 `RCT_DEBUG` 的三分支对照

| 判据 | Debug | Release |
| --- | --- | --- |
| `isKindOfClass:` | ✅ 检查 | ❌ **无** |
| `RCTLogConvertError` | ✅ 记日志 | ❌ **无** |
| 失败时返回 | `nil` | — |

**「失败时返回」这一列 Release 填不出内容** —— 因为 Release 分支里**没有失败这个概念**。

---

## 4. 【核心 TT-2】`RCT_CUSTOM_CONVERTER`：`@try` 只在 debug

### 4.1 宏定义

```objc
// packages/react-native/React/Base/RCTConvert.h:207-221
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

### 4.2 catch 块做的事：「置 nil 后重试一次」

| 行 | 动作 | 意图 |
| --- | --- | --- |
| `RCTLogConvertError(json, @ #type)` | 记日志 | 告诉开发者是哪个类型 |
| `json = nil` | **把入参改成 nil** | 让 `code` 在 nil 上求值 |
| `return code` | **再求值一次** | 得到「降级结果」而非崩溃 |

**这是真正的「恢复」而非「吞掉」** —— 转换失败时返回一个安全的默认值。

### 4.3 Release 下这套恢复完全不存在

**Debug 的降级示例**（以 `RCT_CUSTOM_CONVERTER(CGFloat, CGFloat, [self double:json])` 为例，
`RCTConvert.mm:610`）：

| 输入 | Debug | **Release** |
| --- | --- | --- |
| `@1`（正常） | `1.0` | `1.0` |
| `@[@1]`（类型错） | `@try` 捕获 → 记日志 → `json=nil` → `[self double:nil]` → **`0.0`** | `[self double:@[@1]]` → 内部 `[json doubleValue]` → **`NSArray` 无 `doubleValue` → 崩溃** |

> **即：类型错误在 Debug 下退化为 0，在 Release 下崩溃。**
>
> **38 文档已记录该宏的 Debug/Release 语义，并明确写「不是普遍规则」。
> 本文确认：在这三个宏的组合里，它是同一方向的一环，而非反例。**

### 4.4 使用量

**`RCTConvert.mm` 中 `RCT_CUSTOM_CONVERTER` 的直接使用点**（含被 `RCT_CONVERTER` 间接使用的）：

| 宏 | 直接使用次数 | 说明 |
| --- | --- | --- |
| `RCT_CUSTOM_CONVERTER` | **2** | `:62`（NSSet）、`:63`（NSData） |
| `RCT_NUMBER_CONVERTER` / `RCT_ENUM_CONVERTER` | **37** | 全部数值与枚举转换 |
| `RCT_CONVERTER` | **2** | `:21`（id）、`:23`（BOOL） |

**即 39 处转换器里 37 处走「release 无验证」路径。**

---

## 5. 【核心 TT-3】`RCT_NUMBER_CONVERTER`：release 直接跳过数值归一

### 5.1 宏定义

```objc
// packages/react-native/React/Base/RCTConvert.h:229
#define RCT_NUMBER_CONVERTER(type, getter) \
  RCT_CUSTOM_CONVERTER(type, type, [RCT_DEBUG ? [self NSNumber:json] : json getter])
```

### 5.2 三元表达式的两个分支

| 构建 | 展开为 | 行为 |
| --- | --- | --- |
| **Debug** | `[self NSNumber:json]` → 再 `[json doubleValue]` | **先归一为 `NSNumber`，再取值** |
| **Release** | `json doubleValue` | **直接向原对象要数值** |

### 5.3 Release 下哪些类型会崩

**`doubleValue` 的实际可用性**：

| `json` 实际类型 | 有 `doubleValue`？ | Release 结果 |
| --- | --- | --- |
| `NSNumber` | ✅ | 正常 |
| `NSString` | ✅（`NSString` 实现了它） | 正常（宽松） |
| **`NSArray`** | ❌ | **unrecognized selector 崩溃** |
| **`NSDictionary`** | ❌ | **崩溃** |
| **`NSNull`** | ❌ | **崩溃** |
| `nil` | ✅（返回 0） | 0 |

> **`NSNull` 值得单独指出**：
> JS 的 `null` 经 JSON 解析后是 `NSNull`。
> **即「从 JS 传 null 给一个期望 number 的原生参数」在 Release 下直接崩溃**，
> 而在 Debug 下会被 `[self NSNumber:nil]` 归一为 `nil` 再取值 → `0.0`。
>
> **这是最容易从 JS 侧触发的路径**，因为传 `null` 是极常见的写法。

### 5.4 七个数值转换器全部受影响

```objc
// packages/react-native/React/Base/RCTConvert.mm:21-32
RCT_CONVERTER(id, id, self)

RCT_CONVERTER(BOOL, BOOL, boolValue)
RCT_NUMBER_CONVERTER(double, doubleValue)
RCT_NUMBER_CONVERTER(float, floatValue)
RCT_NUMBER_CONVERTER(int, intValue)

RCT_NUMBER_CONVERTER(int64_t, longLongValue);
RCT_NUMBER_CONVERTER(uint64_t, unsignedLongLongValue);

RCT_NUMBER_CONVERTER(NSInteger, integerValue)
RCT_NUMBER_CONVERTER(NSUInteger, unsignedIntegerValue)
```

| # | 转换器 | getter | Release 下的直接调用 |
| --- | --- | --- | --- |
| 1 | `double` | `doubleValue` | `json doubleValue` |
| 2 | `float` | `floatValue` | `json floatValue` |
| 3 | `int` | `intValue` | `json intValue` |
| 4 | `int64_t` | `longLongValue` | `json longLongValue` |
| 5 | `uint64_t` | `unsignedLongLongValue` | `json unsignedLongLongValue` |
| 6 | `NSInteger` | `integerValue` | `json integerValue` |
| 7 | `NSUInteger` | `unsignedIntegerValue` | `json unsignedIntegerValue` |

**`RCT_CONVERTER(BOOL, BOOL, boolValue)`（`:23`）走的是 `RCT_CUSTOM_CONVERTER`
而**不是** `RCT_NUMBER_CONVERTER`**，因此它**没有**那个三元表达式 ——
**即 BOOL 转换在 Release 下仍有 `@try` 之外的裸调用，但少了归一那一步。**

---

## 6. 【核心 TT-4】调用点的参数个数检查同样在 debug 之内

### 6.1 检查的完整形态

```objc
// packages/react-native/React/Base/RCTModuleMethod.mm:522-556
- (id)invokeWithBridge:(RCTBridge *)bridge module:(id)module arguments:(NSArray *)arguments
{
  if (_argumentBlocks == nil) {
    [self processMethodSignature];
  }

#if RCT_DEBUG
  // Sanity check
  RCTAssert([module class] == _moduleClass, @"Attempted to invoke method \
            %@ on a module of class %@", [self methodName], [module class]);

  // Safety check
  if (arguments.count != _argumentBlocks.count) {
    NSInteger actualCount = arguments.count;
    NSInteger expectedCount = _argumentBlocks.count;

    // Subtract the implicit Promise resolver and rejecter functions for implementations of async functions
    if (self.functionType == RCTFunctionTypePromise) {
      actualCount -= 2;
      expectedCount -= 2;
    }

    RCTLogError(
        @"%@.%s was called with %lld arguments but expects %lld arguments. "
        @"If you haven\'t changed this method yourself, this usually means that "
        @"your versions of the native code and JavaScript code are out of sync. "
        @"Updating both should make this error go away.",
        RCTBridgeModuleNameForClass(_moduleClass),
        self.JSMethodName,
        (long long)actualCount,
        (long long)expectedCount);
    return nil;
  }
#endif

  // Set arguments
  NSUInteger index = 0;
  for (id json in arguments) {
    RCTArgumentBlock block = _argumentBlocks[index];
```

### 6.2 `#if RCT_DEBUG` 的精确范围

| 行 | 内容 |
| --- | --- |
| `:528` | `#if RCT_DEBUG` |
| `:529-533` | **Sanity check**（模块类是否匹配） |
| `:534-554` | **Safety check**（参数个数是否匹配 + 记 `RCTLogError`） |
| `:555` | `#endif` |

**release 下 `:556` 直接开始「Set arguments」。**

### 6.3 后果：`arguments` 与 `_argumentBlocks` 长度不一致时越界

**循环以 `arguments` 为基准，但以 `index` 索引 `_argumentBlocks`**：

| 情形 | Debug | **Release** |
| --- | --- | --- |
| `arguments.count > _argumentBlocks.count` | 记 `RCTLogError` + `return nil` | **`_argumentBlocks[index]` 越界 → 崩溃** |
| `arguments.count < _argumentBlocks.count` | 同上 | 不越界（多余 block 不执行） |

### 6.4 最常见的触发原因，检查消息自己写明了

`RCTLogError` 的消息：

```
@"%@.%s was called with %lld arguments but expects %lld arguments. "
@"If you haven\'t changed this method yourself, this usually means that "
@"your versions of the native code and JavaScript code are out of sync. "
@"Updating both should make this error go away."
```

> **即作者知道最常见的原因是「原生与 JS 代码版本不同步」**
> —— **而版本不同步恰恰是热更新/灰度发布时的常态。**
>
> **在 Release 下，这条消息永远不会出现，取而代之的是一次崩溃。**

### 6.5 一个值得单独肯定的设计

```objc
  [_retainedObjects removeAllObjects];

  if (_methodInfo->isSync) {
    void *returnValue;
    [_invocation getReturnValue:&returnValue];
    return (__bridge id)returnValue;
  }
  return nil;
```

**顺序是对的**：先 `removeAllObjects`（释放参数保活对象），再取返回值。
`__bridge` 不转移所有权，ARC 会在使用返回值时自行 retain ——
**即返回值不会被 `_retainedObjects` 的清理误伤。**

**这是本函数中唯一一处顺序敏感且顺序正确的地方**，与 45 文档 §2.6
（`setClickable` MUST AFTER `setOnClickListener`）属同类自觉。

---

## 7. 三层防护在两个构建下的总账

| 层 | 机制 | Debug | **Release** |
| --- | --- | --- | --- |
| **TT-1** | `RCT_JSON_CONVERTER` 的 `isKindOfClass:` | ✅ | ❌ |
| **TT-1** | `RCTLogConvertError` | ✅ | ❌ |
| **TT-2** | `RCT_CUSTOM_CONVERTER` 的 `@try/@catch` | ✅ | ❌ |
| **TT-3** | `RCT_NUMBER_CONVERTER` 的 `[self NSNumber:json]` 归一 | ✅ | ❌ |
| **TT-4** | `RCTModuleMethod` 的参数个数检查 | ✅ | ❌ |
| **TT-4** | `RCTModuleMethod` 的模块类 `RCTAssert` | ✅ | ❌ |

**Debug：5 层。Release：0 层。**

### 7.1 这个方向是合理的还是缺陷

**必须区分两件事**：

| 问题 | 判定 |
| --- | --- |
| 「用 `RCT_DEBUG` 排除检查以减小体积/提升性能」这个**决定** | ✅ **合理**（注释已声明，且 ObjC 元数据与 `@try` 都开销不小） |
| 「排除之后**不留任何兜底**」这个**结果** | ⚠️ **有代价**：类型错误从「可捕获 + 有日志」变成「远处崩溃 + 无诊断」 |

**若要保留体积收益又降低代价**，可选方案（源码未采用）：

| 方案 | 代价 |
| --- | --- |
| `NSAssert` 式的廉价断言替代 `@try` | 仍需符号 |
| 在 release 下用 `RCTLogError` 但不 `return nil` | 仍需类型检查 |
| 崩溃时把转换点写进 `NSException` 的 `userInfo` | 几乎零成本 |

**本文不主张改变该决定，只要求把代价记录清楚。**

---

## 8. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **TT-1** | **【核心】`RCT_JSON_CONVERTER` 的 release 分支是 `return json;` —— 4 个基础类型转换器在 release 下零类型检查** | `React/Base/RCTConvert.mm:49-54`、`:57-60` | **Release 下返回类型与声明不符不报错，崩溃推迟到业务调用点；崩溃处无诊断信息** |
| **TT-2** | **【核心】`RCT_CUSTOM_CONVERTER` 的 `@try/@catch` 只在 debug；catch 块的「置 nil 后重试」在 release 不存在** | `React/Base/RCTConvert.h:207-221` | **类型错误在 debug 退化为默认值，在 release 崩溃** |
| **TT-3** | **【核心】`RCT_NUMBER_CONVERTER` 的 `[RCT_DEBUG ? [self NSNumber:json] : json getter]` 在 release 跳过归一** | `React/Base/RCTConvert.h:229`；`RCTConvert.mm:21-32`（7 个转换器） | **JS 传 `null`（→ `NSNull`）、数组、对象给数值参数 → release 下 unrecognized selector 崩溃** |
| **TT-4** | **【核心】`RCTModuleMethod` 的参数个数检查与模块类断言都在 `#if RCT_DEBUG` 内** | `React/Base/RCTModuleMethod.mm:528-555` | **Release 下参数个数不匹配时 `_argumentBlocks[index]` 越界崩溃；检查消息自陈的常见原因（原生与 JS 版本不同步）正是最易触发场景** |
| TT-5 | `RCT_CONVERTER(BOOL, BOOL, boolValue)` 走 `RCT_CUSTOM_CONVERTER` 但**不是** `RCT_NUMBER_CONVERTER`，缺归一步骤 | `React/Base/RCTConvert.mm:23` | BOOL 转换在 release 下无 `[self NSNumber:]` 归一 |
| TT-6 | `RCT_DEBUG` 的注释明确其目的是「排除错误检查以提升性能、减小体积」，但**未说明排除后的行为差异** | `React/Base/RCTDefines.h:25-35` | 代价未被文档化 |

### TT-1 ~ TT-4 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | **iOS / macOS（ObjC 运行时）** |
| **架构** | **仅 legacy 架构（Bridge / Paper）** —— 新架构走 JSI + TurboModule，不经 `RCTConvert` |
| **构建** | **`RCT_DEBUG == 0`**，即**没有定义 `DEBUG` 宏的构建**（Release / TestFlight / 生产） |
| **触发条件** | JS 侧传入与原生声明不符的参数类型，或参数个数不符 |
| **后果类型** | **崩溃**（非静默失败、非数据错误） |
| **可诊断性** | **低** —— 崩溃栈顶在业务调用点，不在参数边界；且 RN 不做崩溃上传（41 文档） |

**关键限定**：**这些路径在 Fabric 新架构下不存在。**
新架构的 TurboModule 参数转换由 codegen 生成（52 文档），
其类型契约在编译期确定 —— 即**同一类问题在新架构下是编译错误而非运行时崩溃**。

---

## 9. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 38 文档：`RCT_CUSTOM_CONVERTER` 的 Debug/Release 语义反转，并注明「**不是普遍规则**」 | **确认并量化**：三个宏构成同方向的完整链条（§7 总账），且 38 文档记录的那一处只是其中一环 |
| 41 / 44 文档：RN 不做崩溃上传，有采集无持久化 | **叠加后果**：TT-1~TT-4 在 release 造成的崩溃**既不可本地诊断、无远程上报** |
| 45 文档 §2.6：`setClickable` MUST AFTER `setOnClickListener`（顺序自觉） | **对照**：同文件另一处顺序敏感代码（`_retainedObjects` 与 `getReturnValue`）**顺序正确** |
| 46 文档：三类问题形态（历史承诺 / 自认边界 / 结构脆弱） | **新增第四类**：**「有意的取舍」** —— TT-1~TT-4 方向合理、代价未文档化（§7.1） |
| 49 文档 OO-2：缺工具链时静默通过（有意的门禁放宽） | **同型**：`RCT_DEBUG` 是有意的质量门禁放宽，且同样**未在别处说明后果** |
| 52 文档 RR-2：`javaPackageName` 声明了但生成器不消费 | **同型**：配置项/检查项存在但在 release 路径下不生效 |
| 52 文档 RR-1：跨语言契约靠声明顺序 | **对照**：TT-1~TT-4 的契约靠 `#if` 预处理，二者都是编译期决定运行期安全性的机制 |