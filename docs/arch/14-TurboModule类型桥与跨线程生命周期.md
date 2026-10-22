---
id: 14
title: "TurboModule 类型桥：react/bridging 模板体系与跨线程生命周期"
topic: FD.turbo
symptoms: [bridge]
platforms: [cross]
architecture: [cross]
layer: T2
symbols: ["TurboModule", "MethodMetadata", "JsiTurboModule"]
claims: [BRG-1, BRG-2, BRG-3, BRG-4, BRG-5, BRG-6, BRG-7]
---
# 14 · TurboModule 类型桥：react/bridging 模板体系与跨线程生命周期

> **模块**：B1（`ReactCommon/react/nativemodule` + `react/bridging` + `specs_DEPRECATED` + `react-native-codegen/src`，共 233 个非测试文件）
> **本文范围**：`react/bridging` 的 19 个 `.h` + 1 个 `.cpp`，以及 `nativemodule/core/ReactCommon` 的绑定注入点。
> B1 其余部分（`codegen/src` 的 89 个 parser/generator、`specs_DEPRECATED` 的 49 个 JS spec）**未读**。
> **基线**：react-native @ `9b131e42`
> **前置**：[11 文档](./11-运行时与错误桥.md) 讲了 `ReactInstance` 的运行时初始化。
> 本文讲 TurboModule 最核心也最容易出错的一层：**C++ 类型 ⇄ JSI 值的编译期转换，
> 以及回调跨线程时 JS 对象如何不被提前释放**。

---

## 1. `react/bridging` 是什么

**19 个头文件 + 1 个 `.cpp`** 构成一套**纯模板的零运行时类型转换层**。目录：

| 文件 | 提供 |
| --- | --- |
| `Base.h` | `fromJs` / `toJs` / `Bridging<T>` 主模板与 SFINAE 探测 |
| `Bridging.h` | `Bridging<T>` 特化的统一声明入口 |
| `Convert.h` | `jsi::Value` → 基础类型的转换 |
| `Value.h` `Object.h` `Array.h` `ArrayBuffer.h` | JSI 容器 |
| `Function.h` `CallbackWrapper.h` | 回调与函数 |
| `Promise.h` | 异步 Promise 桥接 |
| `Error.h` | 错误桥接 |
| `Class.h` | 原生类的 JS 侧包装 |
| `EventEmitter.h` | 事件发射 |
| `LongLivedObject.h` + `LongLivedObject.cpp` | **跨线程保活基础设施** |
| `Bool.h` `Number.h` `AString.h` `HighResTimeStamp.h` `Dynamic.h` | 具体类型特化 |

**19 个文件里 18 个是 `.h`，唯一的 `.cpp` 是 `LongLivedObject.cpp`。**
这意味着除 `LongLivedObject` 的集合实现外，这套类型系统**全部在编译期展开，不产生独立代码体积**。

---

## 2. 主模板：三层重载与 SFINAE

`Base.h:61-106` 是转换的核心：

```cpp
template <typename T>
using bridging_t = typename detail::bridging_wrapper<T>::type;

template <typename ReturnT, typename JSArgT>
  requires is_jsi_v<JSArgT>
auto fromJs(jsi::Runtime &rt, JSArgT &&value, const std::shared_ptr<CallInvoker> & /*unused*/)
    -> decltype(static_cast<ReturnT>(std::move(convert(rt, std::forward<JSArgT>(value)))))
{
  return static_cast<ReturnT>(std::move(convert(rt, std::forward<JSArgT>(value))));
}

template <typename ReturnT, typename JSArgT>
auto fromJs(jsi::Runtime &rt, JSArgT &&value, const std::shared_ptr<CallInvoker> & /*unused*/)
    -> decltype(Bridging<remove_cvref_t<ReturnT>>::fromJs(rt, convert(rt, std::forward<JSArgT>(value))))
{
  return Bridging<remove_cvref_t<ReturnT>>::fromJs(rt, convert(rt, std::forward<JSArgT>(value)));
}

template <typename ReturnT, typename JSArgT>
auto fromJs(jsi::Runtime &rt, JSArgT &&value, const std::shared_ptr<CallInvoker> &jsInvoker)
    -> decltype(Bridging<remove_cvref_t<ReturnT>>::fromJs(rt, convert(rt, std::forward<JSArgT>(value)), jsInvoker))
{
  return Bridging<remove_cvref_t<ReturnT>>::fromJs(rt, convert(rt, std::forward<JSArgT>(value)), jsInvoker);
}
```

`toJs` 是完全对称的三层结构（`:87-106`）。

### 2.1 为什么是三层

| 层 | 条件 | 用途 |
| --- | --- | --- |
| 1 | `is_jsi_v<JSArgT>` | JS 类型 → C++：**直接 `convert` + `static_cast`**，不进用户模板 |
| 2 | 无 `CallInvoker` | 自定义类型：**调 `Bridging<T>::fromJs`**，不传 invoker |
| 3 | 有 `CallInvoker` | 需要跨线程能力：**把 `CallInvoker` 传进 `Bridging`** |

**第 2/3 层的区别只在签名**（`CallInvoker` 参数）。
这让 `Bridging<T>` 可以选择是否感知线程 —— 大多数类型不需要，只有回调类需要。

### 2.2 Lambda → `std::function` 的类型擦除

`Base.h:35-57`：

```cpp
template <typename F>
struct function_wrapper;

template <typename ClassT, typename ReturnT, typename... ArgsT>
struct function_wrapper<ReturnT (ClassT::*)(ArgsT...)> {
  using type = std::function<ReturnT(ArgsT...)>;
};

template <typename ClassT, typename ReturnT, typename... ArgsT>
struct function_wrapper<ReturnT (ClassT::*)(ArgsT...) const> {
  using type = std::function<ReturnT(ArgsT...)>;
};

template <typename T>
struct bridging_wrapper {
  using type = remove_cvref_t<T>;
};

// Convert lambda types to move-only function types since we can't specialize
// Bridging templates for arbitrary lambdas.
template <typename T>
struct bridging_wrapper<T, std::void_t<decltype(&remove_cvref_t<T>::operator())>>
    : function_wrapper<decltype(&remove_cvref_t<T>::operator())> {};
```

**通过探测 `operator()` 的地址来判断「T 是不是可调用对象」**，
若是则把成员函数指针转成 `std::function`。

`Base.h:53-54` 的注释说明了原因：

> Convert lambda types to move-only function types since we can't specialize Bridging templates for arbitrary lambdas.

**任意 lambda 都是匿名类型，无法为它写 `Bridging<>` 特化。**
所以必须在类型层面先归一化成 `std::function`，才能复用同一个 `Bridging<std::function<...>>`。

注意 `function_wrapper` 的注释说是 "move-only"，但 `std::function` 实际是可拷贝的 ——
**注释与实现不一致**，是一处文档缺陷。

### 2.3 编译期能力探测

`Base.h:108-138` 定义了四个常量，用于在编译期判断某个转换是否存在：

```cpp
template <typename, typename = jsi::Value, typename = void>
inline constexpr bool supportsFromJs = false;

template <typename T, typename Arg>
inline constexpr bool supportsFromJs<
    T,
    Arg,
    std::void_t<decltype(fromJs<T>(std::declval<jsi::Runtime &>(), std::declval<Arg>(), nullptr))>> = true;
```

`supportsToJs`（`:123-138`）多一个条件 —— 除了转换要存在，**结果还必须可转为目标类型**：

```cpp
template <typename JSReturnT, typename ReturnT>
inline constexpr bool supportsToJs<
    JSReturnT,
    ReturnT,
    std::void_t<decltype(toJs(std::declval<jsi::Runtime &>(), std::declval<JSReturnT>(), nullptr))>> =
    std::is_convertible_v<decltype(toJs(std::declval<jsi::Runtime &>(), std::declval<JSReturnT>(), nullptr)), ReturnT>;
```

**这套探测让 TurboModule 的接口描述能按能力筛选** ——
codegen 生成的接口会声明「我支持这些类型」，实现侧编译期校验，不匹配则编译失败而非运行时崩溃。

---

## 3. `AsyncPromise`：跨线程 Promise 的完整生命周期

`Promise.h:21-102` 是这套体系里最复杂的一个类。它要解决的问题：
**原生方法在后台线程执行完，如何安全地回到 JS 线程 resolve 一个 Promise？**

### 3.1 构造：创建 JS Promise 并抓住 resolve/reject

`Promise.h:26-47`：

```cpp
  AsyncPromise(jsi::Runtime &rt, const std::shared_ptr<CallInvoker> &jsInvoker)
      : state_(std::make_shared<SharedState>())
  {
    auto constructor = rt.global().getPropertyAsFunction(rt, "Promise");

    auto promise = constructor.callAsConstructor(
        rt,
        bridging::toJs(
            rt,
            // Safe to capture this since this is called synchronously.
            [this](AsyncCallback<T...> resolve, const AsyncCallback<Error> &reject) {
              state_->resolve = std::move(resolve);
              state_->reject = std::move(reject);
            },
            jsInvoker));

    auto promiseHolder = std::make_shared<PromiseHolder>(rt, promise.asObject(rt));
    LongLivedObjectCollection::get(rt).add(promiseHolder);

    // The shared state can retain the promise holder weakly now.
    state_->promiseHolder = promiseHolder;
  }
```

流程：

1. 拿 JS 全局的 `Promise` 构造函数
2. **用 executor（同步调用）抓住 `resolve` / `reject` 两个回调**并存入 `SharedState`
3. 把 `jsi::Object` 类型的 promise 包进 `PromiseHolder`（一个 `LongLivedObject`）
4. `LongLivedObjectCollection` 持有它 —— **这就是保活机制**
5. `SharedState` 只存 **weak_ptr**

第 5 步是关键：**双向弱引用**。

```
LongLivedObjectCollection ──强──▶ PromiseHolder ──▶ jsi::Object (promise)
                                        ▲
SharedState ──weak──▶ PromiseHolder     │
     ▲                                  │
     └──强── resolve / reject 回调 ──────┘（回调内部经 CallInvoker 回到 JS 线程）
```

### 3.2 resolve / reject：只生效一次

`Promise.h:49-69`：

```cpp
  void resolve(T... value)
  {
    std::lock_guard<std::mutex> lock(state_->mutex);

    if (state_->resolve) {
      state_->resolve->call(std::forward<T>(value)...);
      state_->resolve.reset();
      state_->reject.reset();
    }
  }

  void reject(Error error)
  {
    std::lock_guard<std::mutex> lock(state_->mutex);

    if (state_->reject) {
      state_->reject->call(std::move(error));
      state_->reject.reset();
      state_->resolve.reset();
    }
  }
```

**两个函数都先 `lock_guard` 再检查 `optional` 是否存在，成功后立刻 `reset()` 掉两个。**

| 保证 | 实现方式 |
| --- | --- |
| 多次 `resolve` 只有第一次生效 | 第一次后 `state_->resolve` 为 `nullopt` |
| `resolve` 后再 `reject` 无效 | 同上 |
| 线程安全 | `std::mutex` 保护整个检查-调用序列 |

> **注意 mutex 保护了 `call()` 本身** —— 即 JS 回调是在持锁状态下被调用的。
> 若 JS 回调里反过来再 `resolve` 同一个 promise，会**自死锁**（`std::mutex` 不可重入）。
> 现实中第二次 `resolve` 会因 `state_->resolve` 已是 `nullopt` 而被跳过，所以不会触发 ——
> **但这是巧合式的安全，不是设计出来的**。

### 3.3 释放：`SharedState` 析构时归还

`Promise.h:87-99`：

```cpp
  struct SharedState {
    ~SharedState()
    {
      if (auto holder = promiseHolder.lock()) {
        holder->allowRelease();
      }
    }

    std::mutex mutex;
    std::weak_ptr<PromiseHolder> promiseHolder;
    std::optional<AsyncCallback<T...>> resolve;
    std::optional<AsyncCallback<Error>> reject;
  };
```

**最后一个持有 `SharedState` 的对象析构时，才把 `PromiseHolder` 从全局集合移除。**

这是引用计数的自然结果：`SharedState` 析构 ⟺ 没有任何地方还会 resolve/reject ⟺
`PromiseHolder` 不再需要保活。**无需显式生命周期管理。**

### 3.4 失效路径

`Promise.h:71-78`：

```cpp
  jsi::Object get(jsi::Runtime &rt) const
  {
    if (auto holder = state_->promiseHolder.lock()) {
      return jsi::Value(rt, holder->promise).asObject(rt);
    } else {
      throw jsi::JSError(rt, "Failed to get invalidated promise");
    }
  }
```

**保活对象已被释放后再取 promise 会抛 JSError。**
正常流程不会发生（因为取 promise 一定在构造之后、释放之前），但接口是公开的。

---

## 4. `LongLivedObject`：保活机制本体

### 4.1 契约

`LongLivedObject.h:19-31`：

```cpp
/**
 * A simple wrapper class that can be registered to a collection that keep it
 * alive for extended period of time. This object can be removed from the
 * collection when needed.
 *
 * The subclass of this class must be created using std::make_shared<T>().
 * After creation, add it to the `LongLivedObjectCollection`. When done with the
 * object, call `allowRelease()` to reclaim its memory.
 *
 * When using LongLivedObject to keep JS values alive, ensure you only hold weak
 * references to the object outside the JS thread to avoid accessing deallocated
 * values when the JS VM is shutdown.
 */
```

四条硬性要求：

| # | 要求 | 违反后果 |
| --- | --- | --- |
| 1 | **必须用 `std::make_shared<T>()` 创建** | 栈对象 / `unique_ptr` 的地址不满足集合的 `shared_ptr` 假设 |
| 2 | 创建后立刻 `add()` | 可能已被回收 |
| 3 | 用完调用 `allowRelease()` | 永久泄漏 |
| 4 | **在 JS 线程外只持弱引用** | VM 关闭后访问已释放的值 → **use-after-free** |

第 4 条是内存安全的关键。`AsyncPromise` 的 `SharedState` 正是**只存 weak_ptr** 才符合要求。

### 4.2 集合的实现

`LongLivedObject.h:42-61`：

```cpp
/**
 * A singleton, thread-safe, write-only collection for the `LongLivedObject`s.
 */
class LongLivedObjectCollection {
 public:
  static LongLivedObjectCollection &get(jsi::Runtime &runtime);

  LongLivedObjectCollection() = default;
  LongLivedObjectCollection(const LongLivedObjectCollection &) = delete;
  void operator=(const LongLivedObjectCollection &) = delete;

  void add(std::shared_ptr<LongLivedObject> o);
  void remove(const LongLivedObject *o);
  void clear();
  size_t size() const;

 private:
  std::unordered_set<std::shared_ptr<LongLivedObject>> collection_;
  mutable std::mutex collectionMutex_;
};
```

**"write-only" 是文档层面的不准确** —— `size()` 存在，且测试在用
（`bridging/tests/BridgingTest.h:49` 断言 `size() == 0`）。
更准确的说法应是「不提供遍历/查找」。

---

## 5. 已确认的缺陷：实例表永不清理

`LongLivedObject.cpp:15-30`：

```cpp
LongLivedObjectCollection& LongLivedObjectCollection::get(
    jsi::Runtime& runtime) {
  static std::unordered_map<void*, std::shared_ptr<LongLivedObjectCollection>>
      instances;
  static std::mutex instancesMutex;

  std::scoped_lock lock(instancesMutex);
  void* key = static_cast<void*>(&runtime);
  auto entry = instances.find(key);
  if (entry == instances.end()) {
    entry =
        instances.emplace(key, std::make_shared<LongLivedObjectCollection>())
            .first;
  }
  return *(entry->second);
}
```

**`instances` 是函数内 `static`，进程生命周期内永不销毁，且全文件没有任何 `erase` 调用。**

对 `LongLivedObject.cpp` 全文检索 `erase` 只有一处命中，位置 `:41`，
作用于 `collection_`（集合内容）。**`instances` 表（:17-18）没有任何删除路径。**

`TurboModuleBinding` 析构时会清空集合内容（`nativemodule/core/ReactCommon/TurboModuleBinding.cpp:163-168`）：

```cpp
TurboModuleBinding::~TurboModuleBinding() {
  LongLivedObjectCollection::get(runtime_).clear();
  if (longLivedObjectCollection_) {
    longLivedObjectCollection_->clear();
  }
}
```

**但 `instances` 表项本身没有删除。**

### 5.1 两个后果

| 后果 | 严重度 | 说明 |
| --- | --- | --- |
| **每创建一个 `jsi::Runtime` 就永久泄漏一个表项**（`void*` + 空集合，约 50 字节） | 低 | 集合内容已 `clear()`，泄漏的是空壳 |
| **地址复用导致继承旧集合** | **高（条件性）** | 若新 runtime 恰好分配到旧 runtime 的地址，会拿到**旧集合**；若旧集合未被 `clear()`，其中 `LongLivedObject` 持有的 `jsi::Object` 指向**已销毁的 runtime** → **use-after-free** |

第二个后果是否发生取决于：
1. 新 runtime 是否落在相同地址（堆分配复用，很常见）
2. 旧集合是否被清空（`TurboModuleBinding::~TurboModuleBinding` 会清，但只在 Bridgeless 路径）

**测试里其实已经意识到了这一点**（`bridging/tests/BridgingTest.cpp:323-324`）：

```cpp
  // LongLivedObjectCollection goes away before callback is executed
  LongLivedObjectCollection::get(rt).clear();
```

注释说 "goes away"，但实际只是内容清空、**表项还在**。

`BridgingTest.h:41, 49` 甚至有专门的泄漏断言：

```cpp
    LongLivedObjectCollection::get(rt).clear();
    ...
    EXPECT_EQ(0, LongLivedObjectCollection::get(rt).size());
```

**只断言 `size() == 0`，不检查表项是否被移除** —— 测试覆盖不到这个问题。

### 5.2 触发条件

需要**多次创建/销毁 `jsi::Runtime`**。在 RN 中的场景：

| 场景 | 是否会重建 runtime |
| --- | --- |
| Android Activity 重建（旋转屏幕、进程配置变更） | ✅ |
| 开发者菜单「Reload」 | 部分实现 ✅ |
| iOS 多次 `RCTRootView` 但同一 runtime | ❌ |
| Fantom / 测试 harness 反复起停 | ✅ |

---

## 6. TurboModule 侧的清理时机

`nativemodule/core/ReactCommon/TurboModuleBinding.cpp:151-161` 展示了 `longLivedObjectCollection_`
如何被注入 `BridgelessNativeModuleProxy`：

```cpp
  defineReadOnlyGlobal(
      runtime,
      "nativeModuleProxy",
      jsi::Object::createFromHostObject(
          runtime,
          std::make_shared<BridgelessNativeModuleProxy>(
              runtime,
              std::move(moduleProvider),
              std::move(legacyModuleProvider),
              longLivedObjectCollection)));
```

**`BridgelessNativeModuleProxy` 持有一个 `shared_ptr<LongLivedObjectCollection>`**
（`TurboModuleBinding.h:67`），即 §5 中的「旧集合」。

注意这是**强引用**：
- 若 `longLivedObjectCollection` 参数传了非空值，代理会一直持有它
- `TurboModuleBinding` 析构（`:163-168`）清的是**两个**集合：`get(runtime_)` 和 `longLivedObjectCollection_`

**如果两者是同一个对象（`get(runtime)` 的结果），`clear()` 会被调用两次** ——
第二次是空操作，无害但多余。

---

## 7. 本模块的设计要点

| 设计 | 收益 | 代价 / 风险 |
| --- | --- | --- |
| 纯模板类型转换（19 `.h` + 1 `.cpp`） | 零运行时开销、编译期保证 | 模板报错信息难读；改一处牵动全局 |
| `fromJs`/`toJs` 三层重载 | 自动选择是否传 `CallInvoker` | 重载决议复杂，新人难理解 |
| `bridging_wrapper` 探测 `operator()` | lambda 无需特化 | 依赖「可调用即函数」的假设 |
| `supportsFromJs`/`supportsToJs` | 接口能力可编译期校验 | 需在每个特化处同步维护 |
| `AsyncPromise` 双向弱引用 | 无需显式生命周期管理 | 理解成本高；`call()` 持锁是巧合式安全 |
| `LongLivedObject` 全局集合 | 跨线程保活 JS 对象简单可靠 | **实例表泄漏 + 地址复用风险** |
| `TurboModuleBinding` 析构统一 `clear()` | 清理集中 | 只清内容不清表项；旧架构路径可能不经过 |
| `Function.h:180` 弱引用 | 注释明确说明由集合管生命周期 | — |

---

## 8. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| BRG-1 | `LongLivedObjectCollection` 实例表永不清理 | `bridging/LongLivedObject.cpp:15-30` | 每 runtime 泄漏一个表项；地址复用时可能继承未清空的旧集合 → **use-after-free** |
| BRG-2 | 测试的泄漏断言只查 `size()`，不查表项 | `bridging/tests/BridgingTest.h:41, 49` | BRG-1 无法被现有测试发现 |
| BRG-3 | `AsyncPromise::resolve/reject` 在持锁状态下调用 JS 回调 | `bridging/Promise.h:51, 62` | 回调内重入同一 promise 会自死锁（当前靠「已 reset」侥幸避免） |
| BRG-4 | 注释说 lambda 转成 "move-only function" | `bridging/Base.h:53-54` | `std::function` 实际可拷贝；文档与实现不符 |
| BRG-5 | `LongLivedObjectCollection` 文档称 "write-only" 但提供 `size()` | `bridging/LongLivedObject.h:43` | 描述不准确 |
| BRG-6 | `TurboModuleBinding` 析构可能对同一集合 `clear()` 两次 | `nativemodule/core/ReactCommon/TurboModuleBinding.cpp:163-168` | 无害但多余；说明参数来源不清晰 |
| BRG-7 | `AsyncPromise::get` 在保活对象已释放时抛 JSError | `bridging/Promise.h:71-78` | 公开接口的边界未文档化 |

BRG-1 与 05 文档讨论的内存泄漏主题直接相关：
**它是「框架自身泄漏」而非「业务代码泄漏」**，且在长生命周期进程中会累积。

---

## 9. 与其他文档的衔接

- 运行时初始化与 `bindingsInstallFunc` → [11 文档 §2.2](./11-运行时与错误桥.md)
- 内存泄漏检测的另一种机制（ShadowNodeFamily）→ [09 文档 §6.2](./09-渲染器核心与差分算法.md)
- 跨线程调用与 CallInvoker → manifest 模块 **E9**（JS 引擎抽象与 C++ 胶水）
- codegen 如何生成这些接口 → 本文未覆盖，属 B1 剩余部分

---

## 10. 验证方式

```bash
node docs/arch/audit/audit-citations.mjs    # 引用可达性
node docs/arch/audit/verify-quotes.mjs      # 代码块语义
```
