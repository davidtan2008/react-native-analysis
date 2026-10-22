---
id: 12
title: "UI 一致性：ShadowTree 修订版的锁定与惰性快照"
topic: DG.mem
symptoms: [memleak]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["LongLivedObjectCollection", "ShadowNode"]
claims: [MEM-1, MEM-2, MEM-3, MEM-4, MEM-5]
---
# 12 · UI 一致性：ShadowTree 修订版的锁定与惰性快照

> **模块**：A7（`renderer/consistency` + `renderer/uimanager/consistency`）
> **基线**：react-native @ `9b131e42`
> **前置**：[09 文档](./09-渲染器核心与差分算法.md) 讲了 ShadowNode 不可变与 commit。
> 本文解决一个具体问题：**JS 线程在一次任务里多次读 shadow tree，会不会读到一半更新的树？**

---

## 1. 要解决的问题

React 的 shadow tree 会被 commit 替换成新版本。如果 JS 侧逻辑在一次执行中：

```
读 root 树 → 判断条件 → 再读 root 树 → 做决策
```

而两次读之间恰好发生了一次 commit，**两次读到的可能是不同的树** —— 这就是 torn read（撕裂读）。

典型场景：JS 读取布局信息来计算动画起点，同时原生侧正在提交一帧新布局。
计算基于的输入在计算过程中变了，结果就是「跳一下」的视觉瑕疵，且**极难复现**。

---

## 2. 两层接口

### 2.1 纯虚接口

`ReactCommon/react/renderer/consistency/ShadowTreeRevisionConsistencyManager.h:14-24`：

```cpp
/**
 * This interface is used for UI consistency, indicating the timeframe where
 * users should see the same revision of the shadow tree.
 */
class ShadowTreeRevisionConsistencyManager {
 public:
  virtual ~ShadowTreeRevisionConsistencyManager() = default;

  virtual void lockRevisions() = 0;
  virtual void unlockRevisions() = 0;
};
```

只有两个方法，语义就是「一段时间内锁定修订版」。

### 2.2 RAII 封装

`ReactCommon/react/renderer/consistency/ScopedShadowTreeRevisionLock.h:16-25`：

```cpp
/**
 * This is a RAII class that locks the shadow tree revisions during its
 * lifetime.
 *
 * @example
 *   {
 *     ScopedShadowTreeRevisionLock lock(consistencyManager);
 *     runJavaScriptTask(); // During this execution, the lock will be active.
 *   }
 */
```

实现（`:28-49`）：

```cpp
  explicit ScopedShadowTreeRevisionLock(ShadowTreeRevisionConsistencyManager *consistencyManager) noexcept
      : consistencyManager_(consistencyManager)
  {
    if (consistencyManager_ != nullptr) {
      consistencyManager_->lockRevisions();
    }
  }

  // Non-movable
  ScopedShadowTreeRevisionLock(const ScopedShadowTreeRevisionLock &) = delete;
  ScopedShadowTreeRevisionLock(ScopedShadowTreeRevisionLock &&) = delete;

  // Non-copyable
  ScopedShadowTreeRevisionLock &operator=(const ScopedShadowTreeRevisionLock &) = delete;
  ScopedShadowTreeRevisionLock &operator=(ScopedShadowTreeRevisionLock &&) = delete;

  ~ScopedShadowTreeRevisionLock() noexcept
  {
    if (consistencyManager_ != nullptr) {
      consistencyManager_->unlockRevisions();
    }
  }
```

**析构函数 `noexcept` 且判空** —— 即使构造时传入 `nullptr` 也能安全使用。
这很重要，因为 `RuntimeScheduler` 的 `shadowTreeRevisionConsistencyManager_`
是 `std::atomic<... *>{nullptr}`（`runtimescheduler/RuntimeScheduler_Modern.h:228`），
**默认就是空指针**。

> **非 movable 的设计**：如果允许移动，`lock()`/`unlock()` 的配对会因移动而错乱。
> 用 `= delete` 从类型层面杜绝。

---

## 3. 唯一的实现：`LazyShadowTreeRevisionConsistencyManager`

`uimanager/consistency/LazyShadowTreeRevisionConsistencyManager.h:21-28`：

```cpp
/**
 * This class implements UI consistency for the JavaScript thread.
 * This implementation forces JavaScript to see a stable revision of the shadow
 * tree for a given surface ID, only updating it when React commits a new tree
 * or between JS tasks.
 */
class LazyShadowTreeRevisionConsistencyManager : public ShadowTreeRevisionConsistencyManager,
                                                 public ShadowTreeRevisionProvider {
```

**它同时实现两个接口**：一个是"加锁者"（`ShadowTreeRevisionConsistencyManager`），
一个是"提供者"（`ShadowTreeRevisionProvider`，供查询当前快照）。

成员只有 4 个（`:43-47`）：

```cpp
 private:
  std::mutex capturedRootShadowNodesForConsistencyMutex_;
  std::unordered_map<SurfaceId, RootShadowNode::Shared> capturedRootShadowNodesForConsistency_;
  ShadowTreeRegistry &shadowTreeRegistry_;
  uint_fast32_t lockCount{0};
```

### 3.1 「Lazy」体现在哪

`lockRevisions()` 只做一件事（`LazyShadowTreeRevisionConsistencyManager.cpp:63-69`）：

```cpp
void LazyShadowTreeRevisionConsistencyManager::lockRevisions() {
  std::unique_lock lock(capturedRootShadowNodesForConsistencyMutex_);

  // We actually capture the state lazily the first time we access it, so we
  // don't need to do anything here.
  lockCount++;
}
```

**加锁时不做任何快照，只加计数。** 真正的快照推迟到第一次查询。

`getCurrentRevision()`（`:45-59`）：

```cpp
std::shared_ptr<const RootShadowNode>
LazyShadowTreeRevisionConsistencyManager::getCurrentRevision(
    SurfaceId surfaceId) {
  {
    std::unique_lock lock(capturedRootShadowNodesForConsistencyMutex_);
    if (lockCount > 0) {
      auto it = capturedRootShadowNodesForConsistency_.find(surfaceId);
      if (it != capturedRootShadowNodesForConsistency_.end()) {
        return it->second;
      }
    }
  }

  return updateCurrentRevision(surfaceId);
}
```

**未锁定（`lockCount == 0`）时直接返回最新版本**，不做快照。
锁定状态下第一次查询才捕获，之后所有查询命中缓存。

`updateCurrentRevision()`（`:18-41`）：

```cpp
std::shared_ptr<const RootShadowNode>
LazyShadowTreeRevisionConsistencyManager::updateCurrentRevision(
    SurfaceId surfaceId) {
  // This method is only going to be called from JS, so we don't need to protect
  // the access to the shadow tree registry as well.
  // If this was multi-threaded, we would need to protect it to avoid capturing
  // root shadow nodes concurrently.
  RootShadowNode::Shared rootShadowNode;
  shadowTreeRegistry_.visit(surfaceId, [&](const ShadowTree& shadowTree) {
    auto reactRevision = shadowTree.getCurrentReactRevision();
    rootShadowNode =
        reactRevision.value_or(shadowTree.getCurrentRevision()).rootShadowNode;
  });

  std::unique_lock lock(capturedRootShadowNodesForConsistencyMutex_);

  // We don't need to store the revision if we haven't locked.
  // We can resolve lazily when requested.
  if (lockCount > 0) {
    capturedRootShadowNodesForConsistency_[surfaceId] = rootShadowNode;
  }

  return rootShadowNode;
}
```

**惰性的收益**：如果一次 JS 任务压根没读 shadow tree（大量任务如此），
就不产生任何快照开销 —— 一次 `unordered_map` 插入 + 一次 `shared_ptr` 拷贝。

`:21-24` 的注释坦承了线程安全的前提：

```cpp
  // This method is only going to be called from JS, so we don't need to protect
  // the access to the shadow tree registry as well.
  // If this was multi-threaded, we would need to protect it to avoid capturing
  // root shadow nodes concurrently.
```

**「This method is only going to be called from JS」是口头约定，不是断言保证。**
注释自己说了 "If this was multi-threaded, we would need to protect it" ——
即当前实现**依赖调用方纪律**。

### 3.2 `reactRevision.value_or(...)`：优先 React 分支

`:27-29` 揭示了一个重要优先级：

```cpp
    auto reactRevision = shadowTree.getCurrentReactRevision();
    rootShadowNode =
        reactRevision.value_or(shadowTree.getCurrentRevision()).rootShadowNode;
```

**有 React 分支时优先用它，否则回退到通用当前版本。**

`ShadowTree` 内部维护两个修订版指针（`mounting/ShadowTree.h:174`）：

```cpp
  mutable std::optional<ShadowTreeRevision> currentReactRevision_; // Protected by `revisionMutex_`.
```

`ShadowTree.cpp:368-369` 解释何时用 React 分支：

```cpp
    if (isReactBranch && currentReactRevision_.has_value()) {
      oldRevision = currentReactRevision_.value();
```

**这是为了让 JS 读到「React 逻辑认为的那个版本」，而非「最新的已提交版本」。**
当两条路径（React commit / 原生侧 imperative 更新）的节奏不同时，JS 看到的必须是 React 那条。

`:562-568` 显示 React 分支何时被清除：

```cpp
    // If the current react revision is the same as the one that was just
    // merged, clear it.
    if (lastMergeSucceeded && currentReactRevision_.has_value() &&
        currentReactRevision_.value().rootShadowNode ==
            lastMergedRootShadowNode) {
      currentReactRevision_.reset();
    }
```

**只有当 React 分支的 root 恰好就是刚被 merge 掉的那棵时才清除** ——
否则保留，避免 JS 侧读到已被回滚的树。

---

## 4. 锁在哪里被持有

`ScopedShadowTreeRevisionLock` 的消费点只有 4 处，**全在 `RuntimeScheduler` 内**：

| 位置 | 上下文 |
| --- | --- |
| `runtimescheduler/RuntimeScheduler_Legacy.cpp:41` | 任务执行 |
| `runtimescheduler/RuntimeScheduler_Legacy.cpp:147` | （Legacy 第二处） |
| `runtimescheduler/RuntimeScheduler_Legacy.cpp:285` | （Legacy 第三处） |
| `runtimescheduler/RuntimeScheduler_Modern.cpp:323` | 任务执行 |

**换句话说：JS 线程每执行一个任务，全程持锁。**
这与 [03 文档的事件循环](./03-核心技术原理.md) 对齐 ——
「JS 任务之间允许看到新版本，任务之内不允许」正是
`LazyShadowTreeRevisionConsistencyManager.h:22-25` 所说的
"only updating it when React commits a new tree **or between JS tasks**"。

### 4.1 快照在 commit 后立即刷新

`uimanager/UIManager.cpp:217-220`：

```cpp
  if (result == ShadowTree::CommitStatus::Succeeded) {
    // It's safe to update the visible revision of the shadow tree immediately
    // after we commit a specific one.
    lazyShadowTreeRevisionConsistencyManager_->updateCurrentRevision(surfaceId);
```

**commit 成功后立刻调用 `updateCurrentRevision`** —— 这是
`updateCurrentRevision` 在生产代码中**唯一**的调用点。

注意锁内的分支（`:36` `if (lockCount > 0)`）：若此刻正持有锁，
这次 commit 的新版本会**覆盖缓存**，导致当前任务内的后续读取看到新版本。
若未持锁，只更新但不写缓存。

> **这实际上收窄了「一致性窗口」**：commit 若发生在一次 JS 任务内部，
> 惰性快照会被就地替换成新版本。真正的一致性保证来自
> **JS 任务不会在中途被 commit 打断**（单线程），而不是快照的不可变性。

`:222-225` 顺带做了一件事：

```cpp
    if (ReactNativeFeatureFlags::useSharedAnimatedBackend() &&
        animationBackend_) {
      animationBackend_->clearRegistry(surfaceId);
    }
```

**每次 commit 都清空动画注册表**（受 `useSharedAnimatedBackend` 控制）。
这解释了「为什么某些动画在状态更新后会重新开始」——
因为它们被 commit 主动从注册表移除了。

---

## 5. 内存影响

`capturedRootShadowNodesForConsistency_` 持有 `RootShadowNode::Shared`。
清空发生在 `unlockRevisions()`（`:81-83`）：

```cpp
  if (lockCount == 0) {
    capturedRootShadowNodesForConsistency_.clear();
  }
```

**只有计数归零才清空。** 由于锁是 RAII 且任务串行执行，正常情况下每个任务结束即清空。

但 `unlockRevisions()` 的错误处理值得注意（`:71-84`）：

```cpp
void LazyShadowTreeRevisionConsistencyManager::unlockRevisions() {
  std::unique_lock lock(capturedRootShadowNodesForConsistencyMutex_);

  if (lockCount == 0) {
    LOG(WARNING)
        << "LazyShadowTreeRevisionConsistencyManager::unlockRevisions() called without a previous lock";
  } else {
    lockCount--;
  }

  if (lockCount == 0) {
    capturedRootShadowNodesForConsistency_.clear();
  }
}
```

**计数失衡时不崩溃，只打 WARNING。** 由于 `ScopedShadowTreeRevisionLock` 是 RAII 且禁 movable，
正常的加解锁必然配对（构造 → `lockRevisions`，析构 → `unlockRevisions`）。

**风险在于 `lockRevisions()` / `unlockRevisions()` 本身是 public 成员**
（`LazyShadowTreeRevisionConsistencyManager.h:40-41`），可绕过 RAII 直接调用 ——
`LazyShadowTreeRevisionConsistencyManagerTest.cpp` 正是这样用的
（如 `:74` `consistencyManager_.lockRevisions();`）。
生产代码若这样调用而漏掉一次 `unlock`，`lockCount` 会永久大于 0 →
快照永不释放 → **每 surface 泄漏一棵 root 树**，且只有一条 WARNING 日志提示。

由于 `lockCount` 是 `uint_fast32_t`（无符号），理论上溢出会绕回 0，但那是 2³² 次不配对。

---

## 6. 平台侧：无人实现纯虚接口

这是本模块最需要澄清的一点。

**`ShadowTreeRevisionConsistencyManager` 在 Android 与 iOS 上都没有实现。**
检索结果：

```bash
# Android（Java/Kotlin）
$ grep -rn "lockRevisions\|ShadowTreeRevision" packages/react-native/ReactAndroid/src/main
（无输出）

# iOS（Objective-C++）
$ grep -rn "lockRevisions\|ShadowTreeRevision" packages/react-native/React/ packages/react-native/ReactApple/
（无输出）
```

**唯一的生产实现是 `LazyShadowTreeRevisionConsistencyManager`**（C++ 跨平台）。
全仓库 `lockRevisions` 的实现者只有它一个（其余命中全在 `__tests__`）。

> 结论：**「UI 一致性」是 C++ 层的跨平台能力，不依赖任何平台 API。**
> Android / iOS 的表现完全一致。这也意味着没有「某平台才有这个保护」的情况。

---

## 7. 与运行时调度的接线

`scheduler/Scheduler.cpp:80-81`：

```cpp
  runtimeScheduler_->setShadowTreeRevisionConsistencyManager(
      uiManager->getShadowTreeRevisionConsistencyManager());
```

`UIManager` 既是锁的消费者（commit 后刷新）又是锁的提供者。

`RuntimeScheduler` 侧用原子指针持有（`RuntimeScheduler_Modern.h:228`）：

```cpp
  std::atomic<ShadowTreeRevisionConsistencyManager *> shadowTreeRevisionConsistencyManager_{nullptr};
```

**默认 `nullptr` + 原子读**，所以即使 `Scheduler` 还没执行完初始化，
`RuntimeScheduler` 也可以安全地跳过加锁（`ScopedShadowTreeRevisionLock` 的构造里判空）。

`RuntimeScheduler_Modern.h:147-148` 与 `RuntimeScheduler_Legacy.cpp:203-204`
说明 Modern / Legacy **两套实现都支持**这个能力，不是仅新架构可用。

---

## 8. 本模块的设计要点

| 设计 | 收益 | 代价 / 风险 |
| --- | --- | --- |
| 惰性快照（lazy capture） | 不读的 Surface 零开销 | 复杂度高，需同时维护计数与缓存 |
| 纯虚接口 + RAII 封装 | 平台可替换，生命周期安全 | 只有一个实现，抽象略显过度 |
| RAII 类禁 movable | 防止 lock/unlock 错配 | 限制了某些用法 |
| 计数归零才清空 | 支持嵌套锁 | 计数失衡会导致快照永久泄漏 |
| 线程安全靠调用方约定 | 少一次无竞争的加锁 | 注释自认是隐患 |
| `reactRevision` 优先 | JS 看到 React 逻辑的版本 | 两个修订版指针的同步逻辑复杂 |
| commit 后立即刷新 | 新状态尽快可见 | 收窄了惰性快照的保护窗口 |
| Modern / Legacy 双实现 | 两套架构行为一致 | 两处代码需同步维护 |

---

## 9. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| MEM-1 | `lockRevisions()`/`unlockRevisions()` 是 public 且无配对约束，失衡时只 WARNING | `uimanager/consistency/LazyShadowTreeRevisionConsistencyManager.cpp:71-84` | 绕过 RAII 直接调用时，`lockCount` 永久 > 0 → 每 Surface 持有一棵 root 树不释放 |
| MEM-2 | `updateCurrentRevision` 的线程安全靠注释约定 | 同上 `:21-24` | 非 JS 线程调用会数据竞争；无断言保护 |
| MEM-3 | 抽象只有一个实现且无平台实现 | `consistency/ShadowTreeRevisionConsistencyManager.h:18` | `ShadowTreeRevisionConsistencyManager` 的可替换性从未被验证 |
| MEM-4 | 每次 commit 都 `clearRegistry` 动画 | `uimanager/UIManager.cpp:222-225` | 状态更新后动画可能被重置（受 `useSharedAnimatedBackend` 门控） |
| MEM-5 | `updateCurrentRevision` 会覆盖锁内的惰性快照 | `uimanager/UIManager.cpp:220` | 一致性窗口比注释描述的更窄 |

---

## 10. 与其他文档的衔接

- ShadowTree commit 与修订版 → [09 文档 §1-2](./09-渲染器核心与差分算法.md)
- JS 任务调度与事件循环 → [03 文档](./03-核心技术原理.md)
- 内存泄漏检测（另一套机制）→ [05 文档 §5](./05-监控检测原理与流程.md)
- 视图扁平化（commit 后结构可能变化）→ [10 文档 §2](./10-Fabric组件层与视图扁平化.md)

---

## 11. 验证方式

```bash
node docs/arch/audit/audit-citations.mjs    # 引用可达性
node docs/arch/audit/verify-quotes.mjs      # 代码块语义
```
