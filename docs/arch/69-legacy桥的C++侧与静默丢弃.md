---
id: 69
title: "legacy 桥的 C++ 侧：四处理性的「工作被静默丢弃」、一个无上限的调用缓冲，以及两套互不知情的组件名归一化"
topic: RT.legacy
symptoms: [bridge, crash, memleak]
platforms: [cross]
architecture: [legacy]
layer: T3
symbols: ["Instance", "NativeToJsBridge", "ModuleRegistry", "JSCallInvoker", "normalizeName"]
claims: [III-1, III-2, III-3, III-4, III-5, III-6, III-7, III-8, III-9, III-10, III-11, III-12, III-13]
---
# 69 · legacy 桥的 C++ 侧：四处理性的「工作被静默丢弃」、一个无上限的调用缓冲，以及两套互不知情的组件名归一化

> **模块**：A6 · `packages/react-native/ReactCommon/cxxreact/`（本轮读 6 个文件）
>
> **基线**：react-native @ `9b131e42` · 跨平台 C++ · **legacy 架构**（`#ifndef RCT_REMOVE_LEGACY_ARCH`）
>
> **前置**：[14 文档](./14-TurboModule类型桥与跨线程生命周期.md) 记录 TurboModule 类型桥与跨线程生命周期；
> [39 文档](./39-TurboModule的iOS平台层.md) 记录 TurboModule 的 iOS 侧；
> [49 文档](./49-构建工具链与静默失败.md) 记录构建工具链里的静默失败；
> [59 文档](./59-Promise的reject跨平台契约.md) 记录注释锚点失效；
> [67 文档](./67-特性开关的四级继承链与未接CI的快照门禁.md) 记录 `componentNameByReactViewName`；
> [64 文档](./64-渲染器基础设施的注册表与DOM层.md) 记录并发原语用错。
>
> 本文记录 legacy 桥 C++ 侧的三条结论：
> ① **【核心】桥销毁/失效路径上有 4 处「工作被静默丢弃」** —— 全部 `return`，**无任何日志或通知**；
> ② **【核心】`JSCallInvoker::m_workBuffer` 是无上限的 `std::list`** —— 桥建立前的调用无限积压；
> ③ **【核心】`ModuleRegistry::normalizeName` 与 `componentNameByReactViewName` 是两套互不知情的组件名归一化** —— 规则集不同（一边剥 `RK`、一边有 10 条映射表）。

---

## 1. 文件构成（本轮读 6 个文件）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/ReactCommon/cxxreact/Instance.h` | ~175 | `Instance` / `JSCallInvoker` / `InstanceCallback` 声明 |
| `packages/react-native/ReactCommon/cxxreact/Instance.cpp` | ~350 | 桥的初始化、加载、内存压力、CallInvoker 实现 |
| `packages/react-native/ReactCommon/cxxreact/ModuleRegistry.h` | ~95 | NativeModule 注册表声明 |
| `packages/react-native/ReactCommon/cxxreact/ModuleRegistry.cpp` | ~245 | 注册表实现（含名字归一化与 config 组装） |
| `packages/react-native/ReactCommon/cxxreact/NativeToJsBridge.h` | ~130 | C++↔JS 桥声明 |
| `packages/react-native/ReactCommon/cxxreact/NativeToJsBridge.cpp` | ~330 | 桥实现（执行队列、销毁、内存压力） |

**整个目录被 `#ifndef RCT_REMOVE_LEGACY_ARCH` 包裹** —— legacy 架构关闭时全部编译掉。

---

## 2. 【核心 III-1】四处理性的「工作被静默丢弃」

### 2.1 第 ①② 处：`runOnExecutorQueue` 的双重 `m_destroyed` 检查

```cpp
// packages/react-native/ReactCommon/cxxreact/NativeToJsBridge.cpp:292-312
void NativeToJsBridge::runOnExecutorQueue(
    std::function<void(JSExecutor*)>&& task) noexcept {
  if (*m_destroyed) {
    return;
  }

  std::shared_ptr<bool> isDestroyed = m_destroyed;
  m_executorMessageQueueThread->runOnQueue(
      [this, isDestroyed, task = std::move(task)] {
        if (*isDestroyed) {
          return;
        }

        // The executor is guaranteed to be valid for the duration of the task
        // because:
        // 1. the executor is only destroyed after it is unregistered
        // 2. the executor is unregistered on this queue
        // 3. we just confirmed that the executor hasn't been unregistered above
        task(m_executor.get());
      });
}
```

| 位置 | 语义 | 可观测性 |
| --- | --- | --- |
| **入队前** `if (*m_destroyed) return;` | 桥已销毁 → 任务**从未入队** | **无日志** |
| **执行时** `if (*isDestroyed) return;` | 任务已入队但桥在等待期间被销毁 → 任务**被丢弃** | **无日志** |

**两处检查本身是正确且必要的**（注释解释了 executor 的生命周期保证），
**但「丢弃」对调用方是完全不可见的**。

**`destroy()` 的注释明确了这是有意设计**：

```cpp
// packages/react-native/ReactCommon/cxxreact/NativeToJsBridge.cpp:280-290
void NativeToJsBridge::destroy() {
  // All calls made through runOnExecutorQueue have an early exit if
  // m_destroyed is true. Setting this before the runOnQueueSync will cause
  // pending work to be cancelled and we won't have to wait for it.
  *m_destroyed = true;
  m_executorMessageQueueThread->runOnQueueSync([this] {
    m_executor->destroy();
    m_executorMessageQueueThread->quitSynchronous();
    m_executor = nullptr;
  });
}
```

**即：「取消 pending 工作、不必等待」是有意的取舍**（避免析构阻塞）。
**但「取消」这个事实没有任何渠道传给调用方。**

### 2.2 第 ③ 处：`JSCallInvoker::scheduleAsync` 的 `weak_ptr` 过期

```cpp
// packages/react-native/ReactCommon/cxxreact/Instance.cpp:334-344
void Instance::JSCallInvoker::scheduleAsync(CallFunc&& work) noexcept {
  if (auto strongNativeToJsBridge = m_nativeToJsBridge.lock()) {
    strongNativeToJsBridge->runOnExecutorQueue(
        [work = std::move(work)](JSExecutor* executor) {
          auto* runtime = (jsi::Runtime*)executor->getJavaScriptContext();
          work(*runtime);
          executor->flush();
        });
  }
}
```

**`if (auto strong = weak.lock())` 没有 `else` 分支** —— **weak_ptr 过期时，`work` 连同它的捕获一起被销毁，工作从未执行**。

**注意 `invokeAsync` 的契约**：

```cpp
// packages/react-native/ReactCommon/cxxreact/Instance.h:163
    void invokeAsync(CallFunc &&work) noexcept override;
```

**`CallInvoker::invokeAsync` 的语义是「提交一个异步任务」** —— **调用方无法区分「已提交」「被缓冲」「被丢弃」三种状态**。

### 2.3 第 ④ 处：`getRuntimeExecutor` 的 `weak_ptr` 过期

```cpp
// packages/react-native/ReactCommon/cxxreact/Instance.cpp:256-282
RuntimeExecutor Instance::getRuntimeExecutor() {
  // HACK: RuntimeExecutor is not compatible with non-JSIExecutor, we return
  // a null callback, which the caller should handle.
  if (getJavaScriptContext() == nullptr) {
    return nullptr;
  }

  std::weak_ptr<NativeToJsBridge> weakNativeToJsBridge = nativeToJsBridge_;
  return [weakNativeToJsBridge](
             std::function<void(jsi::Runtime & runtime)>&& callback) {
    if (auto strongNativeToJsBridge = weakNativeToJsBridge.lock()) {
      strongNativeToJsBridge->runOnExecutorQueue(...);
    }
  };
}
```

**同样无 `else`** —— 桥销毁后，`RuntimeExecutor` 被调用时**回调静默不执行**。

### 2.4 四处的统一形态

| # | 位置 | 触发条件 | 结果 | 可观测性 |
| --- | --- | --- | --- | --- |
| ① | `NativeToJsBridge.cpp:294` | 桥已销毁 | 任务未入队 | **无** |
| ② | `NativeToJsBridge.cpp:302` | 入队后桥被销毁 | 任务被丢弃 | **无** |
| ③ | `Instance.cpp:335` | `weak_ptr` 过期 | 工作从未执行 | **无** |
| ④ | `Instance.cpp:269` | `weak_ptr` 过期 | 回调不被调用 | **无** |

**四处全是 `if (...) { ... }` 无 `else` 的早退** —— **形态完全一致**。

### 2.5 与 49 文档「静默失败」的对照

| | 49 文档记录的形态 | 本文 III-1 |
| --- | --- | --- |
| 静默的对象 | 脚本的 stderr 被吞 | **用户提交的工作被吞** |
| 后果 | 脚本失败但 CI 绿 | **调用方以为工作已排队，实际从未执行** |
| 是否有刻意设计 | 是（`exec_swallow_error.sh` 明确命名） | **是**（`destroy()` 的注释明确说「pending work be cancelled」） |
| **是否有补偿机制** | ❌ | **❌** |

**即：这不是疏忽，是「取消优先于完成」的有意取舍** —— **但取舍的代价（调用方不知情）没有被记录在任何地方**。

### 2.6 一个正面对照：`m_destroyed` 用 `shared_ptr<bool>` 包装

```cpp
// packages/react-native/ReactCommon/cxxreact/NativeToJsBridge.h:116
  std::shared_ptr<bool> m_destroyed;
```

**为什么不用 `bool` 或 `atomic<bool>`**：`runOnExecutorQueue` 的 lambda 里要用它，
而 lambda 可能比 `this` 活得久（`this` 析构后 `*m_destroyed` 会是 UB）。
**用 `shared_ptr<bool>` 让标志的生命周期独立于桥** ✓ —— **这是一个正确且不易察觉的设计**。

**但 `shared_ptr<bool>` 的读写不是原子的** —— 依赖「先 `*m_destroyed = true`、再 `runOnQueueSync` 同步销毁」的**顺序保证**，
而不是内存序保证。**这是一个「靠时序而非靠原子性」的同步**（实践中正确，因为写入发生在同一线程且后续有同步点）。

---

## 3. 【核心 III-2】`m_workBuffer` 是无上限的 `std::list`

### 3.1 声明

```cpp
// packages/react-native/ReactCommon/cxxreact/Instance.h:152-165
  class JSCallInvoker : public CallInvoker {
   private:
    std::weak_ptr<NativeToJsBridge> m_nativeToJsBridge;
    std::mutex m_mutex;
    bool m_shouldBuffer = true;
    std::list<CallFunc> m_workBuffer;

    void scheduleAsync(CallFunc &&work) noexcept;

   public:
    void setNativeToJsBridgeAndFlushCalls(std::weak_ptr<NativeToJsBridge> nativeToJsBridge);
    void invokeAsync(CallFunc &&work) noexcept override;
    void invokeSync(CallFunc &&work) override;
  };
```

**`std::list<CallFunc> m_workBuffer;` —— 无容量上限、无计数器、无告警。**

### 3.2 缓冲的触发条件与理由（注释完整）

```cpp
// packages/react-native/ReactCommon/cxxreact/Instance.cpp:309-332
void Instance::JSCallInvoker::invokeAsync(CallFunc&& work) noexcept {
  std::scoped_lock guard(m_mutex);

  /**
   * Why is is necessary to queue up async work?
   *
   * 1. TurboModuleManager must be created synchronously after the Instance,
   *    before we load the source code. This is when the NativeModule system
   *    is initialized. RCTDevLoadingView shows bundle download progress.
   * 2. TurboModuleManager requires a JS CallInvoker.
   * 3. The JS CallInvoker requires the NativeToJsBridge, which is created on
   *    the JS thread in Instance::initializeBridge.
   *
   * Therefore, although we don't call invokeAsync before the JS bundle is
   * executed, this buffering is implemented anyways to ensure that work
   * isn't discarded.
   */
  if (m_shouldBuffer) {
    m_workBuffer.push_back(std::move(work));
    return;
  }

  scheduleAsync(std::move(work));
}
```

| 事实 | 判定 |
| --- | --- |
| **注释明确说「we don't call invokeAsync before the JS bundle is executed」** | **即缓冲期理论上极短** |
| **但注释又说「this buffering is implemented anyways to ensure that work isn't discarded」** | **即它承认可能有意外调用** |
| **缓冲队列无上限** | **若意外调用很多次 → 内存无界增长** |
| **注释里还有一处拼写错误** | `Why is is necessary` —— 原文如此 |

**与 66 文档 FFF-1 的对照**：
| | 66 文档 `PerformanceEntryKeyedBuffer` | 本文 `m_workBuffer` |
| --- | --- | --- |
| 无上限 | ✅ | ✅ |
| 有清理出口 | ✅ `clearMarks()` | ❌ **只在桥建立时一次性 flush** |
| 有丢弃可见性 | ❌ | ❌ |
| **触发条件** | 生产代码调 `performance.mark()` | **「意外地在桥建立前调用」**（注释说理论上不会发生） |

**即：本条的严重性低于 66 文档** —— **因为触发前提是「注释说不会发生的情况」**。
**但正因如此，「无上限」更像是疏漏而非取舍**（取舍会写明取舍）。

### 3.3 flush 的实现

```cpp
// packages/react-native/ReactCommon/cxxreact/Instance.cpp:291-302
void Instance::JSCallInvoker::setNativeToJsBridgeAndFlushCalls(
    std::weak_ptr<NativeToJsBridge> nativeToJsBridge) {
  std::scoped_lock guard(m_mutex);

  m_shouldBuffer = false;
  m_nativeToJsBridge = nativeToJsBridge;
  while (!m_workBuffer.empty()) {
    scheduleAsync(std::move(m_workBuffer.front()));
    m_workBuffer.pop_front();
  }
```

**持锁期间逐个 `scheduleAsync`** —— 即**持锁期间可能执行 N 次 `runOnExecutorQueue`**（入队，不阻塞）。
**锁持有时间随缓冲长度线性增长**。

### 3.4 顺带：`invokeSync` 直接抛异常

```cpp
// packages/react-native/ReactCommon/cxxreact/Instance.cpp:303-307
void Instance::JSCallInvoker::invokeSync(CallFunc&& /*work*/) {
  // TODO: Replace JS Callinvoker with RuntimeExecutor.
  throw std::runtime_error(
      "Synchronous native -> JS calls are currently not supported.");
}
```

**即：legacy 桥的 JS CallInvoker 完全不支持同步 native→JS 调用**（直接抛 `std::runtime_error`）。

**对照 14 文档**：TurboModule 的 `getConstants` 是**同步**的 —— **两条桥路的同步语义不同**，
**且 legacy 侧是「抛异常」而非「降级」**。

---

## 4. 【核心 III-3】两套互不知情的组件名归一化

### 4.1 第一套：`ModuleRegistry::normalizeName`

```cpp
// packages/react-native/ReactCommon/cxxreact/ModuleRegistry.cpp:22-36
std::string normalizeName(std::string name) {
  // TODO mhorowitz #10487027: This is super ugly.  We should just
  // change iOS to emit normalized names, drop the "RK..." from
  // names hardcoded in Android, and then delete this and the
  // similar hacks in js.
  if (name.compare(0, 3, "RCT") == 0) {
    return name.substr(3);
  } else if (name.compare(0, 2, "RK") == 0) {
    return name.substr(2);
  }
  return name;
}
```

**规则：剥 `RCT` 前缀 / 剥 `RK` 前缀。**

### 4.2 第二套：`componentNameByReactViewName`

```cpp
// packages/react-native/ReactCommon/react/renderer/componentregistry/componentNameByReactViewName.cpp:15-24
std::string componentNameByReactViewName(std::string viewName) {
  // We need this function only for the transition period;
  // eventually, all names will be unified.

  // TODO T97384889: unify component names between JS - Android - iOS - C++
  std::string rctPrefix("RCT");
  if (std::mismatch(rctPrefix.begin(), rctPrefix.end(), viewName.begin())
          .first == rctPrefix.end()) {
    // If `viewName` has "RCT" prefix, remove it.
    viewName.erase(0, rctPrefix.length());
  }
```

**规则：剥 `RCT` 前缀 + 10 条显式映射**（`Text`→`Paragraph`、`ImageView`→`Image`、…）。

### 4.3 两套规则的差异

| 输入 | `normalizeName`（legacy 桥） | `componentNameByReactViewName`（Fabric 注册表） | 是否一致 |
| --- | --- | --- | --- |
| `RCTText` | `Text` | `Paragraph` | ❌ **不同** |
| `Text` | `Text` | `Paragraph` | ❌ **不同** |
| `RKText` | `Text` | `Text`（无 `RK` 规则） | ❌ **不同** |
| `ImageView` | `ImageView` | `Image` | ❌ **不同** |
| `RCTImageView` | `ImageView` | `Image` | ❌ **不同** |

**即：同一个名字在两条路径上会被归一化成两个不同的结果。**

### 4.4 两套规则的注释**互相知道对方**

| 位置 | 注释原文 |
| --- | --- |
| `ModuleRegistry.cpp:23-26` | `TODO mhorowitz #10487027: This is super ugly. We should just change iOS to emit normalized names, drop the "RK..." from names hardcoded in Android, and then delete this and the similar hacks in js.` |
| `componentNameByReactViewName.cpp:16-19` | `We need this function only for the transition period; eventually, all names will be unified.` / `TODO T97384889: unify component names between JS - Android - iOS - C++` |

**「the similar hacks in js」与「unify component names between JS - Android - iOS - C++」都指向同一个未完成的重构**。

**即：团队知道这是同一个问题的两个副本，但两份实现没有共用一份规则表** —— **这正是 67 文档 GGG-1（`OSSStable.h` 手写 vs 生成）的同型问题**：**「需要统一的地方有多份手写副本，且没有机制让它们保持一致」**。

### 4.5 两条 TODO 的编号风格不同

| TODO | 风格 | 出处 |
| --- | --- | --- |
| `TODO mhorowitz #10487027` | **作者名 + 内部任务号**（Meta 内部 issue） | `ModuleRegistry.cpp:23` |
| `TODO T97384889` | **纯任务号** | `componentNameByReactViewName.cpp:19` |

**即：仓库里存在两套 TODO 编号体系** —— Meta 内部风格（`#数字`）与 RN 开源风格（`T数字`）**并存**。
**前者对 OSS 贡献者不可追踪**（`our.intern.facebook.com` 的链接在头注释里也出现过）。

---

## 5. 附带发现：`ModuleRegistry` 的「变长数组 + 位置协议」

### 5.1 `getConfig` 组装的 config 数组

```cpp
// packages/react-native/ReactCommon/cxxreact/ModuleRegistry.cpp:170-215
  // string name, object constants, array methodNames (methodId is index),
  // [array promiseMethodIds], [array syncMethodIds]
  folly::dynamic config = folly::dynamic::array(name);
  ...
    config.push_back(module->getConstants());
  ...
    if (!methodNames.empty()) {
      config.push_back(std::move(methodNames));
      if (!promiseMethodIds.empty() || !syncMethodIds.empty()) {
        config.push_back(std::move(promiseMethodIds));
        if (!syncMethodIds.empty()) {
          config.push_back(std::move(syncMethodIds));
        }
      }
    }
```

**数组长度有 2 / 3 / 4 / 5 四种可能**，且**每种位置含义不同**：

| 长度 | 布局 |
| --- | --- |
| 2 | `[name, constants]` |
| 3 | `[name, constants, methodNames]` |
| 4 | `[name, constants, methodNames, promiseMethodIds]`（无 sync） |
| 5 | `[name, constants, methodNames, promiseMethodIds, syncMethodIds]` |

**JS 侧必须按位置解析** —— **位置协议 + 变长数组 = 典型的脆弱契约**。

### 5.2 `methodId` 是方法在数组中的下标

```cpp
// packages/react-native/ReactCommon/cxxreact/ModuleRegistry.cpp:194-201
    for (auto& descriptor : methods) {
      // TODO: #10487027 compare tags instead of doing string comparison?
      methodNames.push_back(std::move(descriptor.name));
      if (descriptor.type == "promise") {
        promiseMethodIds.push_back(methodNames.size() - 1);
      } else if (descriptor.type == "sync") {
        syncMethodIds.push_back(methodNames.size() - 1);
      }
    }
```

| 事实 | 判定 |
| --- | --- |
| **methodId = `getMethods()` 返回数组里的下标** | **即「序号即契约」** |
| **`getMethods()` 的顺序若变化 → methodId 错位** | **真实风险** —— `getMethods()` 由各 NativeModule 自己实现 |
| **注释里的 `TODO: #10487027 compare tags instead of doing string comparison?`** | **又一个「作者名 + 内部任务号」风格的 TODO** |

**与 52 文档 RR-3（位置聚合初始化依赖字段顺序）的对照**：
**那里是「C++ 结构体字段顺序」，这里是「跨语言数组位置 + 方法序号」** —— **同一形态的跨语言版本**。

### 5.3 头注释里的「not implemented」列表 —— **描述了不存在的 API**

```cpp
// packages/react-native/ReactCommon/cxxreact/ModuleRegistry.h:32-38
  // not implemented:
  // onBatchComplete: see
  // https://our.intern.facebook.com/intern/tasks/?t=5279396 getModule: only
  // used by views getAllModules: only used for cleanup; use RAII instead
  // notifyCatalystInstanceInitialized: this is really only used by view-related
  // code notifyCatalystInstanceDestroy: use RAII instead
```

**六个接口名（`onBatchComplete` / `getModule` / `getAllModules` / `notifyCatalystInstanceInitialized` / `notifyCatalystInstanceDestroy`）在本类里都不存在** —— **注释在描述已删除的 API**。

**与 59 文档 YY-3（注释锚点失效）的对照**：
| | 59 文档 | 本文 |
| --- | --- | --- |
| 失效形式 | 函数改名 | **接口已删除** |
| 后果 | 找不到函数 | **读者以为这些方法存在** |
| **链接** | 内部路径 | **`our.intern.facebook.com`** —— **OSS 贡献者完全不可达** |

**且注释的换行被压掉了**（`getModule: only` 与 `used by views` 在同一行）—— **原始的多行列表在编辑中被压成了一段难读的文本**。

### 5.4 四处逐字重复的边界检查

```cpp
// packages/react-native/ReactCommon/cxxreact/ModuleRegistry.cpp:218-228（getModuleName）
  if (moduleId >= modules_.size()) {
    throw std::runtime_error(
        "moduleId " + std::to_string(moduleId) + " out of range [0.." +
        std::to_string(modules_.size()) + ")");
  }
```

**同样的 4 行在 `getModuleName` / `getModuleSyncMethodName` / `callNativeMethod` / `callSerializableNativeHook` 各出现一次**（实测 **4 处**）—— **典型的复制粘贴**。

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **III-1** | **【核心】桥销毁/失效路径上有 4 处「工作被静默丢弃」**，全部是 `if (...) { ... }` 无 `else` 的早退，**无任何日志或通知**：① `runOnExecutorQueue` 入队前 `*m_destroyed`；② 执行时 `*isDestroyed`；③ `JSCallInvoker::scheduleAsync` 的 `weak_ptr` 过期；④ `getRuntimeExecutor` 的 `weak_ptr` 过期 | `packages/react-native/ReactCommon/cxxreact/NativeToJsBridge.cpp:294`、`:302`；`packages/react-native/ReactCommon/cxxreact/Instance.cpp:335`、`:269` | **调用方无法区分「已提交」「被缓冲」「被丢弃」**；**「取消 pending 工作」是有意取舍**（`destroy()` 注释明说），**但取舍的代价没有任何记录**；与 49 文档的「静默失败」同型 |
| **III-2** | **【核心】`JSCallInvoker::m_workBuffer` 是无上限的 `std::list<CallFunc>`** —— 桥建立前的调用无限积压，无计数器、无告警 | `packages/react-native/ReactCommon/cxxreact/Instance.h:157`；`Instance.cpp:328` | **注释说「we don't call invokeAsync before the JS bundle is executed」**（理论上极短），**但同时又说「implemented anyways to ensure that work isn't discarded」**（承认可能有意外调用）→ **无上限更像是疏漏而非取舍**（取舍会写明）；**严重性低于 66 文档 FFF-1**（后者是常规路径） |
| **III-3** | **【核心】`ModuleRegistry::normalizeName` 与 `componentNameByReactViewName` 是两套互不知情的组件名归一化**：一边剥 `RCT`+`RK`、一边剥 `RCT`+10 条映射表 → **同一个名字在两条路径上归一化成不同结果**（`RCTText` → `Text` vs `Paragraph`） | `packages/react-native/ReactCommon/cxxreact/ModuleRegistry.cpp:22-36`；`packages/react-native/ReactCommon/react/renderer/componentregistry/componentNameByReactViewName.cpp:15-24` | **两处注释互相知道对方是「the similar hacks」/「unify component names」，但没有共用一份规则表** —— **与 67 文档 GGG-1 同型**（需要统一的地方有多份手写副本，无机制保持一致） |
| **III-4** | **`getConfig` 组装的是「变长数组 + 位置协议」**（长度 2/3/4/5，每种位置含义不同），**`methodId` 是方法在 `getMethods()` 数组里的下标** → 顺序变化即 methodId 错位 | `packages/react-native/ReactCommon/cxxreact/ModuleRegistry.cpp:170-215` | **与 52 文档 RR-3 同型的跨语言版本**（那里是结构体字段顺序，这里是数组位置 + 方法序号）；**注释已标 `TODO: #10487027 compare tags instead of doing string comparison?`** |
| **III-5** | **头注释的「not implemented」列表描述了 6 个本类里不存在的接口**（`onBatchComplete` / `getModule` / `getAllModules` / `notifyCatalystInstanceInitialized` / `notifyCatalystInstanceDestroy`），且引用了 **`our.intern.facebook.com`** 的内部任务链接 | `packages/react-native/ReactCommon/cxxreact/ModuleRegistry.h:32-38` | **读者以为这些方法存在**；**内部链接对 OSS 贡献者完全不可达**；**与 59 文档 YY-3 同型**（那里是改名，这里是删除）；**注释的换行被压成一段难读文本** |
| III-6 | **四处逐字重复的 `moduleId` 边界检查**（4 行 × 4 处） | `packages/react-native/ReactCommon/cxxreact/ModuleRegistry.cpp:218`、`:231`、`:241`、`:253` | 典型复制粘贴；**修改时容易漏改一处** |
| III-7 | `invokeSync` 直接抛 `std::runtime_error("Synchronous native -> JS calls are currently not supported.")` | `packages/react-native/ReactCommon/cxxreact/Instance.cpp:303-307` | **legacy 桥不支持同步 native→JS**；**与 14 文档 TurboModule `getConstants` 的同步语义不同** —— 两条桥路语义不一致 |
| III-8 | 仓库里存在**两套 TODO 编号体系**并存：`TODO mhorowitz #10487027`（作者名 + 内部任务号）与 `TODO T97384889`（纯任务号） | `ModuleRegistry.cpp:23`、`ModuleRegistry.cpp:198`、`componentNameByReactViewName.cpp:19` | **前者的内部链接对 OSS 贡献者不可追踪** |
| III-9 | `flush` 在**持锁期间**逐个 `scheduleAsync` | `packages/react-native/ReactCommon/cxxreact/Instance.cpp:295-301` | 锁持有时间随缓冲长度线性增长 |
| **III-10** | **`m_destroyed` 用 `std::shared_ptr<bool>` 包装** —— 让标志的生命周期独立于桥，使 lambda 捕获安全（`this` 析构后访问 `*m_destroyed` 会是 UB） | `packages/react-native/ReactCommon/cxxreact/NativeToJsBridge.h:116`；`NativeToJsBridge.cpp:298` | **正确且不易察觉的设计** |
| **III-11** | **`runOnExecutorQueue` 的双重 `m_destroyed` 检查 + 注释解释了 executor 生命周期的三条保证** | `packages/react-native/ReactCommon/cxxreact/NativeToJsBridge.cpp:292-312` | **检查本身是必要且正确的** —— 问题只在「丢弃不可观测」（III-1） |
| **III-12** | **`invokeAsync` 的缓冲理由被完整记录**（3 条编号理由：TurboModuleManager 必须同步创建 / 它需要 JS CallInvoker / CallInvoker 需要在 JS 线程创建的 NativeToJsBridge） | `packages/react-native/ReactCommon/cxxreact/Instance.cpp:313-327` | **「为什么需要这个机制」写得比「机制本身有无上限」更详细** —— 典型的「意图清晰、边界缺失」 |
| **III-13** | **`Instance.h` 的 `getJSCallInvoker` / `getDecoratedNativeMethodCallInvoker` 用大段注释解释了「为什么桥要装饰 CallInvoker」**（含 Android 单 NativeModule 线程 vs iOS 每模块一个 MethodQueue 的差异） | `packages/react-native/ReactCommon/cxxreact/Instance.h:80-125` | **第一档注释** |

---

## 7. 适用范围声明

| 维度 | III-1 / III-2 | III-3 | III-4 / III-5 |
| --- | --- | --- | --- |
| **平台** | 双端（`ReactCommon` 共享层） | 双端 | 双端 |
| **架构** | **仅 legacy 架构** —— 整个目录在 `#ifndef RCT_REMOVE_LEGACY_ARCH` 内 | legacy 桥 + Fabric 注册表（**两套并存**） | 仅 legacy 架构 |
| **触发条件** | 桥销毁 / `weak_ptr` 过期 / 桥建立前调用 | 组件名同时经过两条路径 | legacy NativeModule 调用 |
| **当前是否造成功能问题** | **III-1 是**（调用方不知情）；**III-2 否**（注释说不会发生） | **未知** —— 取决于两条路径是否会在同一进程里对同一模块生效 | **否**（历史遗留） |
| **是否已实机验证** | **否**（代码级认定） | **否** | 否 |
| **legacy 关闭后** | **代码全部编译掉** ✓ | **Fabric 侧那半仍在** | **代码全部编译掉** ✓ |

> **重要提醒**：本文所有结论都位于 **legacy 架构**路径 ——
> **`RCT_REMOVE_LEGACY_ARCH` 定义时整个 `cxxreact/` 目录不参与编译**。
> **III-3 是唯一的例外** —— 它的另一半（`componentNameByReactViewName`）在 Fabric 侧仍然生效。

---

## 8. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 49 文档：构建工具链里的静默失败 | **本文 III-1 是「静默失败」在运行时桥上的形态** —— 49 吞的是脚本 stderr，**本文吞的是用户提交的工作**；**两者都是「有意取消 + 零可观测性」** |
| 14 文档：TurboModule 类型桥与跨线程生命周期 | **对照 III-7** —— 14 文档的 TurboModule 侧有同步语义（`getConstants`），**legacy 桥的 `invokeSync` 直接抛异常**；**两条桥路的跨线程契约不同** |
| 59 文档 YY-3：注释锚点失效（对方改名） | **本文 III-5 是「对方整段删除」的新变体** —— 6 个接口都不存在了，**且引用了 OSS 不可达的内部链接** |
| 67 文档 GGG-1：`OSSStable.h` 手写 vs 生成 | **对照 III-3** —— 都是「需要统一的地方有多份手写副本，且没有机制让它们保持一致」；**III-3 的两处注释互相知道对方** |
| 52 文档 RR-3：位置聚合初始化依赖字段顺序 | **对照 III-4** —— 那里是「C++ 结构体字段顺序」，**这里是「跨语言数组位置 + 方法序号」**，**同一形态的跨语言版本** |
| 66 文档 FFF-1：无上限的 keyed 缓冲 | **对照 III-2** —— 形态相同（无上限 list/map），**但触发条件差一个量级**（66 是常规路径，本文是「注释说不会发生」的路径）→ **本文更像是疏漏而非取舍** |
| 64 文档 DDD-1：写路径没有独占锁 | **对照 III-9** —— 那里是「该加锁没加」，**这里是「加了锁但持锁时间随数据量线性增长」** |
