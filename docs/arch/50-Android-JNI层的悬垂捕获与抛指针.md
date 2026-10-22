---
id: 50
title: "Android JNI 胶水层：一个按引用捕获局部变量导致的 use-after-free，以及一个抛出裸指针的 `throw new`"
topic: PL.jni
symptoms: [crash, bridge]
platforms: [android]
architecture: [cross]
layer: T3
symbols: ["FabricUIManagerBinding", "MethodInvoker"]
sourceRoot: react-native
claims: [PP-1, PP-2, PP-3, PP-4, PP-5, PP-6, PP-7, PP-8, PP-9, PP-10, PP-11, PP-12, PP-13, PP-14, PP-15, PP-16]
---
# 50 · Android JNI 胶水层：一个按引用捕获局部变量导致的 use-after-free，以及一个抛出裸指针的 `throw new`

> **模块**：C3 ·
> `packages/react-native/ReactAndroid/src/main/jni/react/fabric/FabricUIManagerBinding.cpp`、
> `jni/react/turbomodule/ReactCommon/TurboModuleManager.cpp`、
> `jni/react/jni/MethodInvoker.cpp`、
> `jni/react/fabric/EventBeatManager.cpp`
>
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · Android 侧 · **仅 Fabric 新架构路径**
>
> **前置**：[32 文档](./32-Fabric组件层ScrollView粘性状态.md) 记录 Fabric 组件层；
> [42 文档](./42-Android内存压力与View回收池.md) 记录 Android 内存压力；
> [49 文档](./49-构建工具链与静默失败.md) 记录 CI 侧的三条静默失败路径。
>
> 本文记录三条**可精确定位、可推理的缺陷**：
> ① **悬垂引用捕获**（`FabricUIManagerBinding.cpp:619` 捕获局部 `shared_ptr` 的引用，
> 而该 lambda 被存入 `Scheduler` 活得比它久）—— **use-after-free**；
> ② **`throw new std::runtime_error`（`:86`）抛出裸指针，全文件无对应 catch**；
> ③ **`countJsArgs(signature) - 2` 在 `size_t` 上先下溢，CHECK 在其后**（`MethodInvoker.cpp:205`）。

---

## 1. 目录构成

| 目录 | 非测试文件 | 行数 |
| --- | --- | --- |
| `packages/react-native/ReactAndroid/src/main/jni/`（整树） | 178 | 17 567 |
| ├ `jni/react/` | 165 | — |
| ├ `jni/first-party/` | 23 | — |
| └ `jni/third-party/` | 1（`glog/config.h`） | — |

**`jni/` 顶层无文件**，全部内容在三个子目录下。

> **`third-party/` 只有 1 个文件** —— 说明 glog 的绝大部分通过 Gradle 依赖引入，
> 仓库内只留了一个配置头。**这是 vendoring 程度的准确刻度。**

---

## 2. 【核心发现 PP-1】按引用捕获局部变量 → use-after-free

### 2.1 同一函数里的三种捕获策略

```cpp
// packages/react-native/ReactAndroid/src/main/jni/react/fabric/FabricUIManagerBinding.cpp:605-628
  auto runtimeExecutor = runtimeExecutorHolder->cthis()->get();

  auto runtimeScheduler = runtimeSchedulerHolder->cthis()->get().lock();
  if (runtimeScheduler) {
    runtimeExecutor =
        [runtimeScheduler](
            std::function<void(jsi::Runtime & runtime)>&& callback) {
          runtimeScheduler->scheduleWork(std::move(callback));
        };
    contextContainer->insert(
        RuntimeSchedulerKey, std::weak_ptr<RuntimeScheduler>(runtimeScheduler));
  }

  EventBeat::Factory eventBeatFactory =
      [eventBeatManager, &runtimeScheduler, globalJavaUiManager](
          std::shared_ptr<EventBeat::OwnerBox> ownerBox)
      -> std::unique_ptr<EventBeat> {
    return std::make_unique<AndroidEventBeat>(
        std::move(ownerBox),
        eventBeatManager,
        *runtimeScheduler,
        globalJavaUiManager);
  };
```

**三处对同一个 `runtimeScheduler` 的处理，三种不同策略**：

| # | 行号 | 形式 | 持有期 | 是否安全 |
| --- | --- | --- | --- | --- |
| ① | `:609` | **按值捕获** `[runtimeScheduler]` | lambda 随 `runtimeExecutor` 一同存入 toolbox | ✅ **正确** |
| ② | `:614-615` | **`weak_ptr`** 存入 `contextContainer` | 容器与局部变量都短命 | ✅ **正确**（弱引用，且有 `weak_ptr` 语义） |
| ③ | `:619` | **按引用捕获** `[&runtimeScheduler]` | **存入 `Scheduler`，活得比局部变量久** | ❌ **错误** |

**`runtimeScheduler` 是 `:607` 的局部 `std::shared_ptr`**（`.lock()` 的结果）。

### 2.2 逃逸路径

```cpp
// packages/react-native/ReactAndroid/src/main/jni/react/fabric/FabricUIManagerBinding.cpp:640-649
  toolbox.eventBeatFactory = eventBeatFactory;

  toolbox.animationChoreographer = animationChoreographer_;

  animationDriver_ = std::make_shared<LayoutAnimationDriver>(
      runtimeExecutor, contextContainer, this);
  scheduler_ =
      std::make_shared<Scheduler>(toolbox, animationDriver_.get(), this);
}
```

**逃逸链**：

| 步 | 位置 | 动作 |
| --- | --- | --- |
| ① | `:618-619` | lambda 捕获 `&runtimeScheduler`（局部变量引用） |
| ② | `:642` | `toolbox.eventBeatFactory = eventBeatFactory` —— lambda 按值拷入 toolbox |
| ③ | `:648-649` | `scheduler_ = std::make_shared<Scheduler>(toolbox, ...)` —— **toolbox 被 `Scheduler` 持有** |
| ④ | `:650`（`}`） | 函数返回，**局部 `runtimeScheduler` 析构，引用失效** |
| ⑤ | 后续任意时刻 | `eventBeatFactory` 被调用 → **`*runtimeScheduler` 解引用悬垂引用** |

**`:625` 的 `*runtimeScheduler` 就是解引用点。**

### 2.3 为什么 ① 和 ② 对、③ 错

| 形式 | 语义 | 局部变量销毁后 |
| --- | --- | --- |
| 按值捕获 `shared_ptr` | lambda **持有引用计数** | 对象仍存活（计数 ≥1） |
| `weak_ptr` | **不持有**引用计数 | 对象可被销毁，但解引用前需 `lock()` —— **且 `:614` 存的是弱引用，语义正确** |
| **按引用捕获** | **不持有任何所有权** | **引用指向已销毁的栈/帧对象 → UB** |

> **③ 应当与 ① 相同**（按值捕获 `runtimeScheduler`）。
>
> **同一函数内 12 行代码写了两次 `runtimeScheduler`，一次对一次错** ——
> 这不是设计分歧，是**同一意图下的不一致**。

### 2.4 失效条件与后果

| 维度 | 内容 |
| --- | --- |
| **平台** | Android 全部 |
| **架构** | **仅 Fabric 新架构**（`installFabricUIManager`） |
| **触发条件** | `runtimeSchedulerHolder->cthis()->get().lock()` 返回**非空**（`:608` 的 `if`） |
| **失效时机** | `installFabricUIManager` 返回后，**任何一次 `eventBeatFactory` 调用** |
| **后果** | **解引用已销毁的 `shared_ptr` 对象** → 读取已释放内存 → 未定义行为 |
| **可能表现** | 崩溃 / 读到脏数据后调度到错误线程 / 引用计数错乱导致提前释放 |

> **`eventBeatFactory` 的用途是创建 `AndroidEventBeat`** ——
> **EventBeat 是事件节拍（每个 commit 周期心跳）**，
> **即这是高频调用的基础设施**。
>
> **对照 32 文档记录的 Fabric 提交循环**：节拍在每次 UI 提交时被使用，
> **调用频次远高于「安装/卸载」这类生命周期事件**。
>
> **这意味着这不是一个「几乎不会触发」的路径**。

---

## 3. 【核心发现 PP-2】`throw new` 抛指针

```cpp
// packages/react-native/ReactAndroid/src/main/jni/react/turbomodule/ReactCommon/TurboModuleManager.cpp:80-90
    if (jsiReturnKind == "PromiseKind") {
      return PromiseKind;
    }

    throw new std::runtime_error(
        std::string("Failed to convert jsiReturnKind \"") + jsiReturnKind +
        "\" to TurboModuleMethodValueKind");
  }
```

**`throw new std::runtime_error(...)` 抛出的是 `std::runtime_error*`（指针）。**

**全文件无 `catch (std::runtime_error*)`**（实测 `grep -n "runtime_error\*\|catch (std::runtime_error"` 零命中）。

| 项 | 标准做法 | 本处做法 |
| --- | --- | --- |
| 抛出类型 | `throw std::runtime_error(...)`（对象） | **`throw new std::runtime_error(...)`（指针）** |
| catch 形式 | `catch (const std::exception&)` **能捕获** | `catch (const std::exception&)` **捕获不到** |
| 指针泄漏 | — | **必然泄漏** —— 没人 catch 就没有 `delete` |

**两个后果**：

| # | 后果 | 说明 |
| --- | --- | --- |
| ① | **对象泄漏** | 抛出的堆对象无人接管；std 异常不参与引用计数 |
| ② | **catch 语义错位** | 若上层写的是 `catch (const std::exception&)`，**不会捕获指针** → 直接 `std::terminate` |

> **这是把「抛指针」当成「抛对象」写的典型错误** ——
> 在 Java 侧异常是对象引用，跨语言时容易混淆。
>
> **对照 44 文档记录的 RN 崩溃策略**：
> RN 的设计是「**任何 JS 异常都不终止进程**」（`useAlwaysAvailableJSErrorHandling`）。
> **这条 `throw` 若穿透到顶层，会绕过整个软异常体系，直接 `terminate`。**

---

## 4. 【核心发现 PP-3】`size_t` 下溢先于 `CHECK`

**问题出现在成员初始化列表里**：

```cpp
// packages/react-native/ReactAndroid/src/main/jni/react/jni/MethodInvoker.cpp:196-210
MethodInvoker::MethodInvoker(
    alias_ref<JReflectMethod::javaobject> method,
    std::string methodName,
    std::string signature,
    std::string traceName,
    bool isSync)
    : method_(method->getMethodID()),
      methodName_(std::move(methodName)),
      signature_(signature),
      jsArgCount_(countJsArgs(signature) - 2),
      traceName_(std::move(traceName)),
      isSync_(isSync) {
  CHECK(signature_.at(1) == '.') << "Improper module method signature";
  CHECK(isSync_ || signature_.at(0) == 'v')
      << "Non-sync hooks cannot have a non-void return type";
}
```

**问题结构**：

| 步 | 行号 | 操作 | 类型 |
| --- | --- | --- | --- |
| ① | `:205` | `countJsArgs(signature)` | 返回 **`size_t`**（无符号） |
| ② | `:205` | `- 2` | **无符号减法** |
| ③ | `:205` | 若结果本应为负，则**回绕成 `SIZE_MAX` 量级** | — |
| ④ | `:208-209` | `CHECK(signature_.at(1) == '.')` | 在**函数体**里，即**初始化列表之后** |

**无符号减法在 C++ 中不会「变负」，而是回绕。**

> **`CHECK` 在构造函数体（`:208`）里，而危险运算在初始化列表（`:205`）里。**
>
> **即：先做减法，再检查** ——
> 若 `countJsArgs` 返回 0 或 1，`:205` 立刻得到一个天文数字，
> `:208` 才检查签名 —— **检查的是已经损坏的值。**
>
> **注意这不是「防御性检查缺失」，而是「检查位置晚于使用位置」。**

### 4.1 同文件里的 `stray semicolon`

```cpp
// packages/react-native/ReactAndroid/src/main/jni/react/jni/MethodInvoker.cpp:106-115
    case 'X':
      return true;
    default:
      return false;
      ;
  }
}
```

**`:113` 的 `;` 是不可达的空语句** —— 它在 `default:` 分支 `return false;` **之后**，
**永远不会被执行**。

> **`default:` 已经覆盖了所有其他取值**，`:113` 的分号是多余的。
>
> **这类残留的成因通常是重构时删掉了某行但留下了分号** ——
> 与 49 文档 OO-12 记录的「4 个 format 脚本复制粘贴同一段逻辑」同源：
> **代码被移动/复制过，遗留物留在了原位。**

---

## 5. JNI 绑定的组织方式：全部动态注册

| 维度 | 实测值 | 统计口径 |
| --- | --- | --- |
| 非测试 `.cpp/.h/.c` 文件 | **178** | 排除 `*/tests/`、`*/test/`、`*/test_helper/` |
| `JNIEXPORT` 出现次数 | **20** | 含 vendored `jni.h` 3 处 |
| **静态命名的 `Java_com_facebook_react_*` 绑定** | **0** | 全树零命中 |
| `JNI_OnLoad` 出现次数 | **48** | 含 `jni_lib_merge.h` 19 处（模板）+ `jni.h` 1 处；口径为「含匹配的行数」 |
| fbjni `makeNativeMethod(...)` 调用点 | **242** | 分布 37 个文件 |

> **`JNI_OnLoad` 48 次里绝大部分不是定义** ——
> `jni_lib_merge.h` 一个文件就贡献 **19** 处（这是生成 `.so` 合并表的模板）。
> **真正每个 `.so` 一个的 `JNI_OnLoad` 定义分散在 14 个 `OnLoad*.cpp` 里。**
>
> **本节所有数字均由工具实测**（排除 `*/tests/`，含 vendored `jni.h`），
> **不含手算**。

**结论**：**本仓库不存在任何静态 JNI 绑定**。
所有 Java→native 跳转都通过 `RegisterNatives` + `makeNativeMethod` 完成。

| 层 | 注册方式 | 规模 |
| --- | --- | --- |
| Yoga（vendored） | 原始 `JNINativeMethod` 数组 | **122** |
| 其余全部 | fbjni `makeNativeMethod` | **248** |

> **fbji 是 Meta 的 JNI 封装库** —— `makeNativeMethod` 用 RAII 管理
> `jclass`/`jmethodID` 的引用计数，**这是「第二处与第一处的核心差异」**：
> 本仓库的 JNI 层**几乎完全依赖 RAII**，因此手写的 `NewGlobalRef`/`DeleteGlobalRef`
> 极少（见 §6）。

---

## 6. 引用管理：RAII 为主，手写极少

| 操作 | 含 vendored `jni.h` | **扣除 `jni.h` 后的真实调用点** |
| --- | --- | --- |
| `NewGlobalRef` | 5 | **2**（`first-party/yogajni/jni/common.cpp`） |
| `DeleteGlobalRef` | 5 | **2**（`jni/react/jni/ScopedGlobalRef.h`） |
| `NewLocalRef` | 4 | **1**（`first-party/yogajni/jni/YogaJniException.cpp`） |
| `DeleteLocalRef` | 6 | **3**（`ScopedLocalRef.h` 2 + `fabric/FabricMountingManager.cpp` 1） |
| **`NewWeakGlobalRef`** | 3 | **0** |
| `PushLocalFrame` | 0 | **0** |
| `GetStringUTFChars` | 3 | **0** |

**`jni.h` 贡献的 3 处是 NDK 头里的函数声明**，不是调用点 ——
**这是本仓库 JNI 层计数最容易出错的地方**（本文初稿即按原始 grep 计数，
被门禁与实测纠正）。

**37 处 `make_global` 全部由 RAII 持有。**

**一处有意的泄漏被显式注释**：

| 位置 | 内容 |
| --- | --- |
| `packages/react-native/ReactAndroid/src/main/jni/react/jni/NativeCommon.cpp:21` | 有意的泄漏，**注释自陈** |

> **「0 个 `GetStringUTFChars`」值得注意** ——
> 常规 JNI 代码在读 `jstring` 时几乎必然要用它。
> **零使用说明所有字符串路径都走 fbjni 的封装**（内部处理）。

> **`NewGlobalRef` 与 `DeleteGlobalRef` 各 2 次，数量对称** ——
> **不构成泄漏**。（本文初稿按原始 grep 写成 2 / 1，被实测纠正为 2 / 2。）
>
> **这就是 38 文档「注释说有、代码没有」经验的反向应用**：
> **先确认注释，再判定计数** —— 且本次还多一层：
> **先确认计数是否含 vendored 头文件，再判定**。

---

## 7. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| PP-1 | **【核心】`eventBeatFactory` 按引用捕获局部 `shared_ptr` `runtimeScheduler`，而 lambda 被存入 `Scheduler` 活得比它久** | `jni/react/fabric/FabricUIManagerBinding.cpp:607`、`:619`、`:625`、`:642`、`:649` | **use-after-free / 未定义行为**；`:625` 解引用已销毁对象。**同函数 `:609` 按值捕获 `:619` 按引用 —— 同一意图两种写法** |
| PP-2 | **【核心】`throw new std::runtime_error(...)` 抛指针，全文件无对应 catch** | `jni/react/turbomodule/ReactCommon/TurboModuleManager.cpp:86` | **对象必然泄漏**；`catch (const std::exception&)` 捕获不到 → 穿透 RN 的软异常体系直接 `terminate` |
| PP-3 | **【核心】`countJsArgs(signature) - 2` 在 `size_t` 上先回绕，`CHECK` 在其后** | `jni/react/jni/MethodInvoker.cpp:205`、`:208` | 无符号下溢成极大值；**检查的是已损坏的值** |
| PP-4 | `FabricMountingManager` 的注释说「closest non-flattened ancestor」，代码传的是 `shadowView.tag` | `jni/react/fabric/FabricMountingManager.cpp:1210-1214` | **注释与代码不符**（38 文档已记录的同类模式） |
| PP-5 | `JArrayBuffer` 的 `size_t` → `jint` 截断后仍按原 `size` `memcpy` | `jni/react/jni/JArrayBuffer.cpp:93-96` | **缓冲区长度溢出** |
| PP-6 | 无锁保护的全局 `std::unordered_map` 从任意线程写入 | `jni/react/devsupport/JInspectorNetworkReporter.cpp:57` | **数据竞争** |
| PP-7 | `*callbackWrapper` 在回调内被读取，且读取发生在被赋值之前 | `jni/react/tracing/PerformanceTracerCxxInterop.cpp:187`、`:208` | **未初始化读** |
| PP-8 | `getScheduler()->getUIManager()` 在 2 处无判空，而同文件另有 6 处使用了判空模式 | `jni/react/fabric/FabricUIManagerBinding.cpp:286`、`:335` | **空指针解引用** |
| PP-9 | 观察者在持有**非递归 mutex**时被调用 | `jni/react/fabric/EventBeatManager.cpp:30-36` | **死锁**风险（若观察者回调中再次触发管理器） |
| PP-10 | `FindClass` 结果未判空即使用 | `jni/first-party/yogajni/jni/YGJNIVanilla.cpp:131`、`:369`；`jni/first-party/yogajni/jni/YogaJniException.cpp:16` | **空指针解引用** |
| PP-11 | `MethodInvoker.cpp` 中 `return false;` 后有多余分号（空语句） | `jni/react/jni/MethodInvoker.cpp:110-113` | 无害残留 |
| PP-12 | `JniJSModulesUnbundle`（145 行）**零调用方** | — | 死代码 |
| PP-13 | `JReactSoftExceptionLogger` 被编译但**从未被引用** | — | 死代码 |
| PP-14 | `HermesMemoryDumper.h` **从未被 include** | — | 死代码 |
| PP-15 | `mapException` **零调用方** | — | 死代码 |
| PP-16 | `ModuleHolder::getProvider` **无条件返回 `nullptr`** | — | 契约与实现不符 |

### PP-1 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | Android 全部 |
| **架构** | **仅 Fabric**（`installFabricUIManager` 路径；Paper 不经过此文件） |
| **前置条件** | `:608` 的 `if (runtimeScheduler)` 成立 —— 即 `RuntimeScheduler` 存活 |
| **失效时机** | 函数返回后**首次**调用 `eventBeatFactory` |
| **调用频次** | **每次创建 `AndroidEventBeat`**，即 Fabric 提交循环的节拍路径 |
| **是否可观测** | 未观测到对应的崩溃/告警 —— **可能因 UB 而「恰好不崩」** |

> **诚实结论**：PP-1 是**代码层面的确定性缺陷**（引用捕获规则可静态判定），
> 但**其运行时表现取决于内存布局，未在本仓库的测试或日志中观测到实例**。
> **不因此降级为「理论问题」—— 修起来只需把 `&` 去掉。**

---

## 8. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 44 文档：RN 不做崩溃上传，有采集无持久化；JS 异常一律软处理 | **补上唯一的例外**：PP-2 的 `throw new` 若穿透，会绕过整个软异常体系 |
| 32 文档：Fabric 提交循环 | **补上节拍侧**：`AndroidEventBeat` 的创建路径即 PP-1 的触发路径 |
| 42 文档：Android 内存压力与回收池 | **新增第三类内存问题**：**悬垂引用**（既非泄漏也非 OOM，是 UB） |
| 38 文档：注释与代码不符的两类区分 | **新增 PP-4 实例**：`FabricMountingManager` 注释说「closest non-flattened ancestor」而代码传 `shadowView.tag` |
| 40 文档：114 个 marker 中 38 个零引用 | **同型的 C++ 侧死代码清单**：PP-12 至 PP-16（5 项） |
| 45 文档 JJ-1：`return null` 的降级策略 | **对照**：PP-2 是**主动失败**（`throw`），但抛错了类型 → 既没有降级也没有正确失败 |
| 49 文档 OO-3：单向门禁（只拦删除不拦新增） | **同型**：PP-4 是「注释承诺的语义与代码实现不同」，属另一类单向失真 |
| 49 文档：本仓库工具链存在多条静默失败路径 | **本文 PP-1/PP-3 都不会被任何现有门禁捕获** —— C++ 侧没有对应的静态检查 |