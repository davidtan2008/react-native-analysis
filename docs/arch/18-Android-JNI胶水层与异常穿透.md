---
id: 18
title: "Android JNI 胶水层：异常穿透的两个方向"
topic: PL.jni
symptoms: [crash, bridge]
platforms: [android]
architecture: [cross]
layer: T3
symbols: ["JNI_OnLoad", "JavaExceptionTranslator"]
claims: [JNI-1, JNI-2, JNI-3, JNI-4, JNI-5, JNI-6, JNI-7]
---
# 18 · Android JNI 胶水层：异常穿透的两个方向

> **模块**：C3（`ReactAndroid/src/main/jni`，176 个非测试文件）
> **基线**：react-native @ `9b131e42` · Android 侧
> **前置**：[04 文档](./04-崩溃日志捕获收集处理上传.md) 给了崩溃链路全貌；[11 文档](./11-运行时与错误桥.md) 讲了 C++ 侧 `JsErrorHandler`。
> 本文补上**链路中最容易被误解的一环**：C++ 与 Java 之间的异常如何互相穿透，
> 以及**哪一步会真的 abort 进程**。

---

## 1. jni 目录构成（176 个文件）

| 子目录 | 文件数 | 内容 |
| --- | --- | --- |
| `jni/` | 57 | **JNI 基础设施**（类型桥、方法调用、JS 加载） |
| `fabric/` | 34 | Fabric 挂载的 JNI 实现 |
| `runtime/` | 19 | `ReactInstance` / 异常管理器 / 调度器 |
| `devsupport/` | 13 | DevSupport 的 JNI 实现 |
| `turbomodule/` | 10 | TurboModule JNI |
| `uimanager/` | 6 | UIManager JNI |
| `newarchdefaults/` | 6 | 新架构默认实现 |
| `hermes/` | 5 | Hermes 集成 |
| `reactnativeblob/` `mapbuffer/` | 各 4 | Blob / MapBuffer |
| `tracing/` `featureflags/` | 各 3 | 追踪 / 开关 |
| `reactperflogger/` | 1 | 性能打点 |

**`jni/` 57 个文件是基础设施层**，其余是各子系统的 JNI 实现。

> **`fbjni` 不在本仓库**。它是 Facebook 的 JNI 封装库（外部依赖），
> 提供了 `JavaClass` / `alias_ref` / `local_ref` / `Environment` 等基础设施。
> 本文涉及的 `throwPendingJniExceptionAsCppException` 等函数**来自 fbjni，无法在本仓库内审阅** ——
> 这是一个必须声明的验证边界。

---

## 2. 方向一：Java 异常 → C++ 异常

### 2.1 唯一关口 `throwPendingJniExceptionAsCppException`

`jni/MethodInvoker.cpp` 中每个 JNI 调用后都紧跟一次检查。以 `:283-286` 为例：

```cpp
    case 'v':
      env->CallVoidMethodA(module.get(), method_, args);
      throwPendingJniExceptionAsCppException();
      return std::nullopt;
```

同样的模式出现在所有 `PRIMITIVE_CASE` / `OBJECT_CASE` 宏里（`:245-279`）：

```cpp
#define PRIMITIVE_CASE(METHOD)                                             \
  {                                                                        \
    auto result = env->Call##METHOD##MethodA(module.get(), method_, args); \
    throwPendingJniExceptionAsCppException();                              \
    return folly::dynamic(result);                                         \
  }
```

**JNI 的错误模型是「设置 pending 异常 + 继续执行」**，
不检查就会带着未处理的 Java 异常继续跑 C++，行为未定义。
`throwPendingJniExceptionAsCppException` 负责把 pending 异常取出来转成 C++ 异常。

**这就是 Java→C++ 异常穿透的唯一关口。** 漏掉它 = 未定义行为。

### 2.2 参数转换中的主动抛错

`jni/MethodInvoker.cpp:60-75`：

```cpp
jint extractInteger(const folly::dynamic& value) {
  // The logic here is taken from convertDynamicIfIntegral, but the
  // return type and exception are different.
  if (value.isInt()) {
    // TODO: this truncates 64 bit ints, valid in JS
    return static_cast<jint>(value.getInt());
  }
  double dbl = value.getDouble();
  jint result = static_cast<jint>(dbl);
  if (dbl != result) {
    throw std::invalid_argument(
        "Tried to convert jint argument, but got a non-integral double: " +
        std::to_string(dbl));
  }
  return result;
}
```

**参数个数不匹配也直接抛**（`:225-229`）：

```cpp
  if (params.size() != jsArgCount_) {
    throw std::invalid_argument(
        "expected " + std::to_string(jsArgCount_) + arguments + ", got " + ...);
  }
```

> **`// TODO: this truncates 64 bit ints, valid in JS`** 是已知问题：
> JS 的 64 位整数传给 Android `int` 参数会被静默截断，无任何警告。

`extract()` 的 `default` 分支（`:173-174`）用 `LOG(FATAL)` 而非抛异常：

```cpp
    default:
      LOG(FATAL) << "Unknown param type: " << type;
```

**`LOG(FATAL)` 直接终止进程。** 触发条件是 JNI 签名里有未知字符 ——
正常不会发生，但一旦发生就是**无堆栈的进程终止**。

### 2.3 整个文件被 legacy 宏包裹

`jni/MethodInvoker.cpp:25` 与 `:320`：

```cpp
#ifndef RCT_REMOVE_LEGACY_ARCH
...
#endif
```

**整个 `MethodInvoker` 属于旧架构**，在移除 legacy 时会整体编译掉。
类声明同样标注了弃用（`packages/react-native/ReactAndroid/src/main/jni/react/jni/MethodInvoker.h:34, 39`）：

```cpp
// packages/react-native/ReactAndroid/src/main/jni/react/jni/MethodInvoker.h:34
struct [[deprecated("This API will be removed along with the legacy architecture.")]] JBaseJavaModule
    : public jni::JavaClass<JBaseJavaModule> {
```

---

## 3. 方向二：C++ 异常 → Java（错误上报）

### 3.1 回调注册：与 11 文档的 C1 断言对应

`runtime/jni/JReactInstance.cpp:48-57`：

```cpp
  jReactExceptionManager_ = jni::make_global(jReactExceptionManager);
  auto onJsError =
      [weakJReactExceptionManager = jni::make_weak(jReactExceptionManager)](
          jsi::Runtime& runtime,
          const JsErrorHandler::ProcessedError& error) mutable noexcept {
        if (auto jReactExceptionManager =
                weakJReactExceptionManager.lockLocal()) {
          jReactExceptionManager->reportJsException(runtime, error);
        }
      };
```

三个设计要点：

| 要点 | 说明 |
| --- | --- |
| **弱引用 + `lockLocal()`** | 实例销毁后自动失效，不持有已销毁的 Java 对象 |
| **`mutable noexcept`** | **回调绝不能抛异常** —— 原因见 §3.3 |
| `jReactExceptionManager_` 强引用 | 另存一份 global_ref，供后续主动调用 |

> **`noexcept` 是 Android 实现方自己加的，不是接口强制的。**
> `JsErrorHandler.h:40` 的类型别名是
> `using OnJsError = std::function<void(jsi::Runtime &, const ProcessedError &)>;`
> —— **不带 `noexcept`**。调用方 `JsErrorHandler.cpp:403` 的 `_onJsError(...)` 也不在 noexcept 函数内
> （`handleError` / `handleErrorWithCppPipeline` 均无 noexcept，见 `JsErrorHandler.h:45, 67`）。
>
> **也就是说：Android 侧主动选择了承载「回调抛异常即 abort 进程」的约束**，
> 并为此专门写了两层兜底（§3.3）。其他平台实现者若不加 `noexcept`，
> 则异常会正常向上传播 —— **这是实现选择，不是框架强制**。

这印证了 [11 文档](./11-运行时与错误桥.md) §1 的结论：
**`OnJsError` 由宿主注入，RN 不实现上报。** Android 的实现是 `ReactJsExceptionHandler` 接口。

### 3.2 C++ → Java 的数据编组

`runtime/jni/JReactExceptionManager.cpp:41-99` 把 `ProcessedError` 转成 Java 对象。

栈帧转换（`:31-38`）：

```cpp
  static facebook::jni::local_ref<ProcessedErrorStackFrameImpl> create(
      const JsErrorHandler::ProcessedError::StackFrame& frame) {
    return newInstance(
        frame.file ? jni::make_jstring(*frame.file) : nullptr,
        frame.methodName,
        frame.lineNumber ? jni::JInteger::valueOf(*frame.lineNumber) : nullptr,
        frame.column ? jni::JInteger::valueOf(*frame.column) : nullptr);
  }
```

**`std::optional` 字段用三元表达式转成可空 Java 对象** ——
`frame.file` 无值时传 `nullptr` 而非空字符串，**区分了「无值」与「空值」**。

### 3.3 最重要的一段：noexcept 回调里的两层兜底

`runtime/jni/JReactExceptionManager.cpp:56-86`：

```cpp
    // Marshalling `extraData` out of the runtime can throw (e.g. a
    // jsi::JSIException when the runtime is in a bad state during a fatal
    // error). This runs inside the `noexcept` onJsError callback, so an
    // escaping exception aborts the whole process; contain it and report the
    // error without its extra data instead. `extraData` may end up null (here,
    // or when the JS value is null/undefined); the Java field is nullable.
    jni::local_ref<ReadableNativeMap::jhybridobject> extraData;

    auto reportWithoutExtraData = [&](const char* reason) {
      LOG(ERROR)
          << "JReactExceptionManager: failed to marshal JS error extraData; reporting the error without it: "
          << reason;
      try {
        extraData = ReadableNativeMap::createWithContents(
            folly::dynamic::object("extraDataMarshallingError", reason));
      } catch (...) {
        // The fallback allocation can itself throw; leave extraData null.
        extraData = nullptr;
      }
    };

    try {
      auto extraDataDynamic =
          jsi::dynamicFromValue(runtime, jsi::Value(runtime, error.extraData));
      extraData =
          ReadableNativeMap::createWithContents(std::move(extraDataDynamic));
    } catch (const std::exception& e) {
      reportWithoutExtraData(e.what());
    } catch (...) {
      reportWithoutExtraData("unknown exception");
    }
```

**这是全仓库关于「崩溃处理」最坦诚的一段注释**，它说明了三件事：

1. **`extraData` 序列化会抛异常** —— 源码自己承认
   （`jsi::JSIException` when the runtime is in a bad state during a fatal error）
2. **这些异常发生在 `noexcept` 回调内，逃逸即 `std::terminate` → abort 整个进程**
3. **因此专门写了两层兜底**：主 try/catch 失败 → 降级为「无 extraData」并填入错误原因；
   降级分配本身再失败 → 置 null

> **这解释了 04 文档中「为什么致命错误时可能丢失 extraData」** ——
> 不是设计疏忽，而是**在崩溃场景下不得不做的取舍**：
> 当 JS runtime 已处于坏状态时，读取任何 JS 值都可能失败。
>
> 兜底数据 `{"extraDataMarshallingError": <reason>}` 本身也是**有用的信号**：
> 上报方看到它就知道 extraData 丢失了，且知道原因。

Java 侧字段对应地声明为可空（`interfaces/exceptionmanager/ReactJsExceptionHandler.kt:36-38`）：

```kotlin
    // Nullable: native marshalling may fail or the error may carry none (see
    // JReactExceptionManager.cpp).
    val extraData: ReadableMap?
```

**两侧注释互相引用** —— 这是少见的好实践。

### 3.4 Java 侧接收与二次兜底

`runtime/ReactInstance.kt:292-306`：

```kotlin
    override fun reportJsException(errorMap: ProcessedError) {
      val data = StackTraceHelper.convertProcessedError(errorMap)
      try {
        val exceptionsManager =
            checkNotNull(
                getNativeModule<NativeExceptionsManagerSpec>(NativeExceptionsManagerSpec.NAME),
            )
        exceptionsManager.reportException(data)
      } catch (e: Exception) {
        // Sometimes (e.g: always with the default exception manager) the native module exceptions
        // manager can throw. In those cases, call into the lower-level queue thread exceptions
        // handler.
        queueThreadExceptionHandler.handleException(e)
      }
    }
```

**第三层兜底**：`reportException` 自身可能抛（如默认 ExceptionsManager 就会抛），
catch 后降级到 `queueThreadExceptionHandler`。

注释里的 `e.g: always with the default exception manager` 很关键 ——
**默认实现必然抛异常**（这正是 04 文档所述「fatal → throw JavascriptException」的路径）。

### 3.5 完整链路

```
JS 抛错
  → JsErrorHandler::handleError (C++)
    → handleErrorWithCppPipeline → 构造 ProcessedError
      → _onJsError(runtime, processedError)          [11 文档 §3-4]
        → onJsError lambda (noexcept)                [JReactInstance.cpp:49]
          → JReactExceptionManager::reportJsException  [:103]
            → ProcessedErrorImpl::create              [:47]  ← 兜底点 1：extraData 序列化
              → Java: reportJsException(errorMap)
                → ReactInstance.ReactJsExceptionHandlerImpl.reportJsException  [ReactInstance.kt:292]
                  → ExceptionsManagerModule.reportException  → isFatal ? throw : FLog  [04 文档]
                    ↳ 抛出后被 catch                              ← 兜底点 2
                      → queueThreadExceptionHandler.handleException
```

**三层兜底**：C++ 编组失败 → 无 extraData；Java 模块调用失败 → 降级到队列线程处理器；
默认 ExceptionsManager 抛出的 `JavascriptException` → 由上层处理。

---

## 4. 日志通道：`reactAndroidLoggingHook` 绕过 Java

`jni/JSLogging.cpp:14-20`：

```cpp
void reactAndroidLoggingHook(
    const std::string& message,
    unsigned int logLevel) {
  auto logPriority =
      static_cast<android_LogPriority>(logLevel + ANDROID_LOG_DEBUG);
  __android_log_write(logPriority, "ReactNativeJS", message.c_str());
}
```

**直接调 `__android_log_write` 写 logcat**，
**不经过 `FLog`、不经过 `ReactSoftExceptionLogger`、不经过任何 Java 层**。

两处注册点：

| 位置 | 用途 |
| --- | --- |
| `runtime/jni/JReactInstance.cpp:78` | 传给 `ReactInstance` |
| `packages/react-native/ReactAndroid/src/main/jni/react/hermes/reactexecutor/OnLoad.cpp:44` | `react::bindNativeLogger(runtime, &reactAndroidLoggingHook)` |

### 4.1 与软异常通道的区别

`jni/JReactSoftExceptionLogger.cpp:15-24` 走的是**完全不同的路**：

```cpp
void JReactSoftExceptionLogger::logNoThrowSoftExceptionWithMessage(
    std::string tag,
    std::string message) {
  static const auto logNoThrowSoftExceptionWithMessage =
      javaClassStatic()
          ->getStaticMethod<void(std::string tag, std::string message)>(
              "logNoThrowSoftExceptionWithMessage");

  return logNoThrowSoftExceptionWithMessage(
      javaClassStatic(), std::move(tag), std::move(message));
}
```

| 通道 | 实现 | 到达 | Release 下可见 |
| --- | --- | --- | --- |
| `reactAndroidLoggingHook` | `__android_log_write` | **logcat** | **通常被裁剪** |
| `JReactSoftExceptionLogger` | JNI → Java → `FLog` | logcat + `FLog` 分类 | 视配置 |

> **这是 16 文档 `BlackHoleEventDispatcher` 问题的同一模式**：
> 一条通道走 logcat（生产不可见），一条走 Java 侧的正式上报通道。
> **选错通道 = 错误在生产环境静默消失。**

---

## 5. 其他值得注意的 JNI 文件

| 文件 | 行数级 | 要点 |
| --- | --- | --- |
| `jni/JExecutor.cpp/.h` | 中 | 线程池与 executor 基础设施 |
| `jni/JMessageQueueThread.cpp` | 中 | JS 消息队列线程的 JNI 侧 |
| `jni/JSLoader.cpp` | 中 | bundle 加载 |
| `jni/NativeMap.cpp` / `NativeArray.cpp` | 中 | `folly::dynamic` ⇄ Java Map/Array |
| `jni/JReactMarker.cpp` | 小 | `ReactMarker` 的 native 侧（见 15 文档 §5） |
| `jni/SafeReleaseJniRef.cpp` | 小 | JNI 全局引用的安全释放 |
| `jni/JWeakRefUtils.h` | 小 | 弱引用工具 |

`JReactMarker.cpp` 是 [15 文档](./15-Android启动与宿主API.md) §5.1 中
`nativeLogMarker` 的实现侧 —— `hasMatchingNameMarker=true` 的埋点经它跨过 JNI。

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| JNI-1 | `extraData` 序列化在 `noexcept` 回调内，失败即 abort 进程 | `runtime/jni/JReactExceptionManager.cpp:56-61`（注释自述） | 致命错误时可能丢失 extraData；已用两层兜底缓解，但根因（runtime 处于坏状态）无法消除 |
| JNI-2 | 未知参数/返回类型用 `LOG(FATAL)` 而非抛异常 | `jni/MethodInvoker.cpp:173-174, 312-313` | 触发即进程终止，**无堆栈、无上下文** |
| JNI-3 | JS 64 位整数传给 Android `int` 被静默截断 | `jni/MethodInvoker.cpp:63-66`（TODO 自述） | 大整数参数结果错误，无任何警告 |
| JNI-4 | `reactAndroidLoggingHook` 绕过 Java 直写 logcat | `jni/JSLogging.cpp:14-20` | Release 下 logcat 裁剪 → 该通道日志不可见 |
| JNI-5 | 异常穿透依赖每个 JNI 调用点手动调 `throwPendingJniExceptionAsCppException` | `jni/MethodInvoker.cpp:248, 255, 262, 273, 285` | 新增调用点若遗漏即产生未定义行为；无编译期检查 |
| JNI-6 | `throwPendingJniExceptionAsCppException` 实现在 fbjni（外部依赖） | 不在本仓库 | 该关口的正确性无法在本仓库内审阅 |
| JNI-7 | 默认 ExceptionsManager 在 fatal 时必然抛异常 | `runtime/ReactInstance.kt:301-303`（注释 `e.g: always`） | 依赖上层兜底；若兜底失效即崩溃 |

**JNI-5 是方法论问题**：这个关口靠**人工约定**而非类型系统保证。
本仓库内已用宏（`PRIMITIVE_CASE` / `OBJECT_CASE`）收敛了大部分调用点，
但 `extract()` 与 `JniLocalScope` 之外的路径没有强制检查。

---

## 7. 与其他文档的衔接

- 崩溃链路的 Java 侧（RedBox / ExceptionsManager）→ [04 文档](./04-崩溃日志捕获收集处理上传.md)
- C++ 侧 `JsErrorHandler` 双管线与 `OnJsError` 注入 → [11 文档](./11-运行时与错误桥.md)
- `ReactMarker` 埋点跨 JNI 的接收端 → [15 文档 §5](./15-Android启动与宿主API.md)
- 「调试有提示、生产静默」模式 → [16 文档 §5](./16-Android-uimanager与旧架构掏空.md)
- TurboModule 类型桥（`react/bridging`）→ [14 文档](./14-TurboModule类型桥与跨线程生命周期.md)
- Android 宿主与启动链路 → [15 文档](./15-Android启动与宿主API.md)

---

## 8. 验证方式

```bash
node docs/arch/audit/audit-citations.mjs    # 引用可达性
node docs/arch/audit/verify-quotes.mjs      # 代码块语义
node docs/arch/audit/verify-claims.mjs      # 核心事实断言
```

> **验证边界声明**：本文对 `fbjni` 库（`JavaClass` / `alias_ref` /
> `throwPendingJniExceptionAsCppException` 等）的描述来自**调用点推断**，
> 该库不在本仓库内，其实现未经审阅。
