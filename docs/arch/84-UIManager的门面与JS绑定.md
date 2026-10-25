---
id: 84
title: "UIManager：JS 门面、指针事件状态机与树外批量更新"
topic: RN.diff
symptoms: [jank, crash]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["UIManager", "UIManagerBinding", "PointerEventsProcessor", "PointerHoverTracker", "AppRegistryBinding", "LayoutEventEmitter", "UIManagerCommitHook", "UIManagerMountHook", "UIManagerDelegate", "UIManagerViewTransitionDelegate", "UIManagerAnimationDelegate", "UIManagerAnimationBackend", "LazyShadowTreeRevisionConsistencyManager", "ShadowTreeRevisionProvider", "ShadowNodeListWrapper", "InstanceHandle", "EventTarget", "ShadowTreeRegistry", "ShadowTreeCommitOptions", "SurfaceRegistryBinding"]
sourceRoot: react-native
claims: [UIM-1, UIM-2, UIM-3, UIM-4, UIM-5, UIM-6, UIM-7, UIM-8, UIM-9, UIM-10, UIM-11, UIM-12, UIM-13, UIM-14, UIM-15, UIM-16, UIM-17, UIM-18, UIM-19, UIM-20, UIM-21, UIM-22, UIM-23, UIM-24, UIM-25, UIM-26, UIM-27, UIM-28, UIM-29, UIM-30, UIM-31, UIM-32, UIM-33, UIM-34, UIM-35, UIM-36, UIM-37, UIM-38, UIM-39]
---
# 84 · UIManager：JS 门面、指针事件状态机与树外批量更新

> **模块**：A1 · `packages/react-native/ReactCommon/react/renderer/uimanager/`
> （26 个代码文件 / **4,511** 行，含 `consistency/` 2 个；不计 `tests/` 4 个 / 1,193 行与 2 个 `CMakeLists.txt`）
>
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根）
>
> **前置**：[12 文档](./12-UI一致性与ShadowTree修订版.md) 已讲透 `consistency/` 的锁定与惰性快照；
> [64 文档](./64-渲染器基础设施的注册表与DOM层.md) 讲了 `dom::` 几何 API；[83 文档](./83-挂载层的事务管线与三重自检.md)
> 讲 `ShadowTree::commit` 与 `ShadowTreeRegistry` 的锁。本文是 `uimanager/` 全块的逐文件通读，
> 只写这些文档没有的增量结论。
>
> 本文记录 **39** 条结论，其中六条最值得先看：
> ① **【核心】`UIManager::completeSurface` 的 `ShadowTree::CommitStatus result;` 没有初值** —— surface 不存在时
> `visit` 不执行，随后拿未初始化枚举与 `Succeeded` 比较是 UB（UIM-7）；
> ② **【核心】`updateShadowTree` 的 commit 事务忽略传入的旧根参数，直接返回 BFS 之前预构建的克隆** ——
> 中途发生的并发提交会被静默覆盖（UIM-21）；
> ③ **【核心】`setNativeProps_DEPRECATED` 与 `cloneNode` 的 nativeProps 优先级相反**，且前者在 commit 重试时
> 复用旧的祖先快照、对 `getShadowNodeInSubtree(...)` 的返回值不做判空（UIM-4）；
> ④ **【核心】`dispatchEventToJS` 在 instanceHandle 为空时注释说事件会被丢弃，代码却继续调用 JS handler**，
> 且 `currentEventPriority_` 既无初值也没有异常安全的复位（UIM-26）；
> ⑤ **【核心】`findNodeAtPoint` 手持 `std::mutex`（非递归）跨 `getInstanceHandle` 调用，异常即永久锁死**（UIM-27）；
> ⑥ **【核心】pointer capture 的 `topLostPointerCapture` / `topGotPointerCapture` 监听器门禁恒为真** ——
> `shouldEmitPointerEvent` 根本不识别这两个 type（UIM-31）。

---

## 1. 文件构成（26 文件 / 4,511 行）

| 组 | 文件（行数） | 角色 |
| --- | --- | --- |
| 门面 | `UIManager.cpp`（801）、`UIManager.h`（273） | surface 生命周期、节点工厂、hook 注册、查询转发 |
| JS 绑定 | `UIManagerBinding.cpp`（1240）、`UIManagerBinding.h`（91） | `nativeFabricUIManager` 的 35 个成员 |
| 指针事件 | `PointerEventsProcessor.cpp`（546）、`.h`（102）、`PointerHoverTracker.cpp`（149）、`.h`（68） | capture/retarget/enter-leave 状态机 |
| 树外更新 | `UIManagerUpdateShadowTree.cpp`（229） | 按 tag 批量改 props 的 BFS + 自底向上克隆 |
| 回调接口 | `UIManagerDelegate.h`（105）、`UIManagerCommitHook.h`（75）、`UIManagerMountHook.h`（41）、`UIManagerAnimationDelegate.h`（51）、`UIManagerAnimationBackend.h`（41）、`UIManagerNativeAnimatedDelegate.h`（26）、`UIManagerViewTransitionDelegate.h`（84）、`LayoutAnimationStatusDelegate.h`（32） | 8 个纯接口/半纯接口 |
| 入口胶水 | `AppRegistryBinding.cpp`（88）、`.h`（52）、`SurfaceRegistryBinding.h`（12） | `RN$AppRegistry` / `RN$stopSurface` |
| 布局事件 | `LayoutEventEmitter.cpp`（38）、`.h`（33） | `onLayout` 的 commit hook 实现 |
| 一致性 | `consistency/LazyShadowTreeRevisionConsistencyManager.cpp`（86）、`.h`（50）、`consistency/ShadowTreeRevisionProvider.h`（29） | 已被 12 文档覆盖，本文只取增量 |
| 桥接原语 | `primitives.h`（169） | NativeState 包装、参数转换 |
| 构建 | `CMakeLists.txt`（41）、`consistency/CMakeLists.txt`（23） | 两个 OBJECT 库 |

合计 **4,511** 行代码（`wc -l` 对这 26 个文件求和；不含 4 个测试文件 1,193 行与 CMake）。

---

## 2. 所有权：三个裸指针、一个 weak_ptr、一个仅在 Debug 存在的 LeakChecker

`UIManager` 的成员把「谁必须比谁活得久」写死成了注释与裸指针
（`packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.h:250-270`）：

```cpp
  SharedComponentDescriptorRegistry componentDescriptorRegistry_;
  UIManagerDelegate *delegate_{};
  UIManagerAnimationDelegate *animationDelegate_{nullptr};
  std::weak_ptr<UIManagerNativeAnimatedDelegate> nativeAnimatedDelegate_;
  UIManagerViewTransitionDelegate *viewTransitionDelegate_{nullptr};

  const RuntimeExecutor runtimeExecutor_{};
  ShadowTreeRegistry shadowTreeRegistry_{};
  std::shared_ptr<const ContextContainer> contextContainer_;
  ...
  std::unique_ptr<LeakChecker> leakChecker_;
  std::unique_ptr<LazyShadowTreeRevisionConsistencyManager> lazyShadowTreeRevisionConsistencyManager_;
  std::shared_ptr<UIManagerAnimationBackend> animationBackend_;
```

- **`delegate_` / `animationDelegate_` / `viewTransitionDelegate_` 是裸指针**，头文件明确要求 owner
  「must null the pointer before being destroyed」（`UIManager.h:52-56`、`:60-65`、`:80-84`）；
  析构函数本身**不检查也不清空**，只打一行 `LOG(WARNING)`（`UIManager.cpp:60-63`）。
- **`nativeAnimatedDelegate_` 是唯一的 weak_ptr**，每次 tick 都 `lock()` 后使用
  （`UIManager.cpp:749-761`）。
- **`leakChecker_` 只在 `REACT_NATIVE_DEBUG` 下构造**，release 返回空 `unique_ptr`
  （`UIManager.cpp:31-38`）；后续所有 `if (leakChecker_)` 分支在 release 都是死代码。
- **两个「一致性」getter 返回同一个对象的不同基类指针**：
  `getShadowTreeRevisionConsistencyManager()` 与 `getShadowTreeRevisionProvider()` 都
  `return lazyShadowTreeRevisionConsistencyManager_.get();`（`UIManager.cpp:358-365`）。
  这个对象由构造函数注入 `shadowTreeRegistry_` 的引用（`UIManager.cpp:49-58`），
  因此 `UIManager` 被移动/销毁时它必须同步失效——两者都是值成员，析构顺序由声明顺序的逆序保证。

**`Layer` 视角**：这三个裸指针都是「上层 owner（`Scheduler` / `RCTFabricSurface`）保证生命周期」的模式；
`UIManagerBinding` 通过 `friend class UIManagerBinding`（`UIManager.h:232`）直接访问 `runtimeExecutor_`
等私有成员，绑定层与门面层耦合得很紧（见 §9 的 view transition）。
---

## 3. 节点工厂：fallback 命名、双重合并与相反优先级

### 3.1 `createNode`：fallback 组件靠「注入 name prop」保命

`UIManager::createNode` 先按组件名取 descriptor，同时取 fallback descriptor；两者用
**component handle 相等**判断是否命中（`packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:73-95`）。
命中 fallback 时，它会再 `cloneProps` 一次，把 `name` 塞进 props：

```cpp
  if (fallbackDescriptor != nullptr &&
      fallbackDescriptor->getComponentHandle() ==
          componentDescriptor.getComponentHandle()) {
    props = componentDescriptor.cloneProps(
        propsParserContext,
        props,
        RawProps(folly::dynamic::object("name", name)));
  }
```

随后创建 family / initial state / shadow node，并依次通知 delegate 与 LeakChecker
（`UIManager.cpp:105-110`）。注意 `getFallbackComponentDescriptor()` 可能是 `nullptr`
（`UIManager.cpp:74-75`），整段判断以它非空为前提。

### 3.2 `cloneNode`：nativeProps 先吸收 rawProps，再反过来覆盖 rawProps

`cloneNode` 在 `rawProps` 非空时做两次 `mergeDynamicProps`（`UIManager.cpp:129-173`）：

1. **更新 `nativeProps_DEPRECATED`**：以旧 nativeProps 为 source、`rawProps` 为 patch，
   `NullValueStrategy::Ignore` —— 新 key 不会进入 nativeProps；
2. **计算最终 props**：以 `rawProps` 为 source、**新的 nativeProps 为 patch**，
   `NullValueStrategy::Override` —— nativeProps 的每个 key 覆盖 rawProps。

即 **`setNativeProps` 设过的 key 最终一定赢过 React 这次传的 props**（注释在 `:159-161` 明说
「new props handled by nativeProps now takes precedence」）。整个合并过程持有
`family.nativePropsMutex`（`:133`）。但克隆时传入 `runtimeShadowNodeReference = false`（`:180`），
与 `UIManagerBinding` 里 `valueFromShadowNode(..., true)` 的默认路径不同——JS 侧不会得到新的 runtime 引用。

### 3.3 `setNativeProps_DEPRECATED`：与 `cloneNode` 相反的优先级 + 两处可空解引用

同一个 nativeProps，在 `setNativeProps_DEPRECATED` 里走的是另一套合并
（`UIManager.cpp:462-512`）：

```cpp
      family.nativeProps_DEPRECATED =
          std::make_unique<folly::dynamic>(mergeDynamicProps(
              *family.nativeProps_DEPRECATED,
              (folly::dynamic)rawProps,
              NullValueStrategy::Override));
```

这里是 **rawProps 覆盖旧 nativeProps**，与 §3.2 最终结果（nativeProps 覆盖 rawProps）**方向相反**。
两条路径不会同时出现在一次克隆里，但如果调用方交替使用两套 API，同名 key 的最终归属取决于
「最后一次是 clone 还是 setNativeProps」，而不是某个统一的优先级规则。

更实际的风险在 commit 重试：

- `ancestorShadowNode` 在进入 `shadowTree.commit` **之前**取一次（`UIManager.cpp:488-489`），
  而 lambda 的注释明说「The lambda passed to `commit` may be executed multiple times」，
  并要求每次都创建新的 `RawProps`（`:486-487`）——**RawProps 新了，祖先快照却没新**；
- lambda 内 `getShadowNodeInSubtree(*shadowNode, ancestorShadowNode)->getProps()`
  （`:499-503`）对返回值**不判空**。只要 JS 传入的 shadow node 不在这个旧祖先树里
  （surface 已重建、节点已删除、或祖先快照落后），这里就是空指针解引用。

> **跨文档**：`getShadowNodeInSubtree` 本身在找不到祖先时返回 `nullptr`（`UIManager.cpp:338-352`），
> 所以这不是「理论可能」——函数签名已明确允许空返回。
---

## 4. Surface 生命周期：start 的三段、stop 的五段、complete 的未初始化结果

### 4.1 `startSurface`：先注册树，再在 registry 的共享锁内通知 delegate，最后回 JS 线程

`UIManager::startSurface` 的顺序是固定的（`UIManager.cpp:239-264`）：

1. `shadowTreeRegistry_.add(std::move(shadowTree))`（`:247`）；
2. `shadowTreeRegistry_.visit(surfaceId, ...)` 内调用 `delegate->uiManagerDidStartSurface(shadowTree)`（`:249-254`）；
3. `runtimeExecutor_(...)` 里调 `AppRegistryBinding::startSurface(...)`（`:256-263`）。

第 2 步的 delegate 回调**发生在 `ShadowTreeRegistry` 的 `shared_lock` 内**
（`packages/react-native/ReactCommon/react/renderer/mounting/ShadowTreeRegistry.cpp:39-42`）。
如果 delegate 在回调里同步 start/stop 另一个 surface（需要 `unique_lock`），会与这把共享锁互斥；
但同一线程递归获取 `std::shared_mutex` 的共享锁是未定义行为（标准不保证可重入）。
这一点在本文档的 §5 会与所有 commit 路径一起讨论。

第 3 步是**异步**的：`startSurface` 返回时 JS 侧 `runApplication` 可能还没执行；
`startEmptySurface` 则只注册树、不碰 JS（`UIManager.cpp:266-270`）。

### 4.2 `stopSurface`：先停动画，再摘树，最后清后端——最后一步不在 surface 存在性判断内

```cpp
  stopSurfaceForAnimationDelegate(surfaceId);

  auto shadowTree = getShadowTreeRegistry().remove(surfaceId);
  if (shadowTree) {
    runtimeExecutor_([=](jsi::Runtime& runtime) {
      AppRegistryBinding::stopSurface(runtime, surfaceId);
    });
    if (leakChecker_) {
      leakChecker_->stopSurface(surfaceId);
    }
  }

  if (ReactNativeFeatureFlags::useSharedAnimatedBackend()) {
    runtimeExecutor_(
        [surfaceId, animationBackendWeak = ...](jsi::Runtime& /*runtime*/) {
          if (auto animationBackend = animationBackendWeak.lock()) {
            animationBackend->clearRegistryOnSurfaceStop(surfaceId);
          }
        });
  }
```

（`UIManager.cpp:288-323`）

关键点：

- **`stopSurfaceForAnimationDelegate` 在摘树之前**，即使 surface 从未注册也会调用 animation delegate；
- `getShadowTreeRegistry().remove(surfaceId)` 需要 registry 的 `unique_lock`，会等待所有并发 commit 结束
  （`ShadowTreeRegistry.cpp:25-27`，与 83 文档 MOU-29 的 `remove` 细节一致）；
- **`clearRegistryOnSurfaceStop` 位于 `if (shadowTree)` 块之外**——surface 不存在时也会向 JS 线程排一个
  「清理动画后端」任务；`animationBackend_` 用 weak_ptr 捕获，UIManager 先死也不会 UAF；
- 返回值 `ShadowTree::Unique` 把树的**所有权交给调用方**，`stopSurface` 本身不析构树。

### 4.3 `completeSurface`：`result` 没有初值

`UIManager::completeSurface` 的第一行局部变量是：

```cpp
  ShadowTree::CommitStatus result;

  shadowTreeRegistry_.visit(surfaceId, [&](const ShadowTree& shadowTree) {
    result = shadowTree.commit(...);
  });

  if (result == ShadowTree::CommitStatus::Succeeded) {
```

（`UIManager.cpp:202-217`）

`ShadowTreeCommitStatus` 的第一个枚举值是 `Succeeded`（`packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.h:33-36`），
但 C++ 的局部枚举**不会自动零初始化**。当 `surfaceId` 不存在时，`visit` 的回调不执行，
`result` 保持未初始化；随后与 `Succeeded` 比较属于读取不确定值（UB）。
在常见实现上它可能恰好等于 0，于是代码会继续调用
`lazyShadowTreeRevisionConsistencyManager_->updateCurrentRevision(surfaceId)`（`:217-220`）
和 `animationBackend_->clearRegistry(surfaceId)`（`:222-225`）——对一个不存在的 surface 做两件无意义的事。
**这不是「只在理论里」**：`completeRoot` 是 JS 可调用的入口，传入已 stop 的 surface id 即可触发。

另外，`completeRoot` 绑定层传入的选项是写死的三元组
（`packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:488-493`）：

```cpp
          uiManager->completeSurface(
              surfaceId,
              shadowNodeList,
              {.enableStateReconciliation = true,
               .mountSynchronously = false,
               .source = ShadowTree::CommitSource::React});
```

即 **React 提交总是启用 state reconciliation、且从不同步挂载**（`mountSynchronously=false` 与
`ShadowTreeCommitOptions` 的默认值 `true` 相反，见 `ShadowTree.h:59-73`）。这与 83 文档 MOU-15 的
`commitEmptyTree`（默认 true）形成两条明确分叉。

---

## 5. 所有 UIManager 提交都发生在 registry 的共享锁内

四条提交路径的调用形态完全一致：

| 路径 | 锁 | 提交 |
| --- | --- | --- |
| `completeSurface` | `shadowTreeRegistry_.visit`（shared） | `shadowTree.commit(...)`（`UIManager.cpp:204-215`） |
| `updateState` | 同上（`UIManager.cpp:419-450`） | `shadowTree.commit(...)` |
| `setNativeProps_DEPRECATED` | 同上（`UIManager.cpp:484-511`） | `shadowTree.commit(...)` |
| `updateShadowTree` | `getShadowTreeRegistry().enumerate`（shared） | `shadowTree.commit(...)`（`UIManagerUpdateShadowTree.cpp:97-226`） |

`ShadowTreeRegistry::visit` / `enumerate` 都在整个回调期间持有 `std::shared_lock`，
而 `add` / `remove` 需要 `std::unique_lock`（`ShadowTreeRegistry.cpp:39-57`）。
因此：**一次 commit 期间的 layout、state 处理、commit hook、delegate 回调，全部阻塞任何 surface 的
start/stop**。反过来，`stopSurface` 在等 commit 结束；如果 commit 里的 delegate 又同步 start 一个 surface，
就会在同一线程上尝试升级/递归获取 registry 锁。83 文档只描述了 `visit` 的锁形态，
没有点出「所有写路径都在锁内做完整提交」这个组合后果。

> **数字**：`UIManager.cpp` 里 `shadowTree.commit(` 恰好出现 **3** 次（completeSurface / updateState /
> setNativeProps），`UIManagerUpdateShadowTree.cpp` 里 **1** 次；四处都在 registry 锁内。
---

## 6. 两套 hook：注册回调在独占锁内、执行回调在共享锁内

### 6.1 注册/注销：回调发生在锁内，且顺序不对称

```cpp
void UIManager::registerCommitHook(UIManagerCommitHook& commitHook) {
  std::unique_lock lock(commitHookMutex_);
  react_native_assert(
      std::find(commitHooks_.begin(), commitHooks_.end(), &commitHook) ==
      commitHooks_.end());
  commitHook.commitHookWasRegistered(*this);
  commitHooks_.push_back(&commitHook);
}

void UIManager::unregisterCommitHook(UIManagerCommitHook& commitHook) {
  std::unique_lock lock(commitHookMutex_);
  auto iterator = std::find(...);
  react_native_assert(iterator != commitHooks_.end());
  commitHooks_.erase(iterator);
  commitHook.commitHookWasUnregistered(*this);
}
```

（`packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:605-621`）

- **register 先回调、后入表**：`commitHookWasRegistered` 执行时，hook 还不在 `commitHooks_` 里；
- **unregister 先出表、后回调**：`commitHookWasUnregistered` 执行时，hook 已不在表里；
- 两者都持有 **`std::unique_lock`（非递归 `shared_mutex`）**。如果注册回调同步调用
  `registerCommitHook` / `unregisterCommitHook`（或任何遍历 commit hook 的 UIManager 方法），
  同一线程会二次加锁 → 未定义行为/死锁。接口注释只写了「Called right after the commit hook is
  registered or unregistered」（`UIManagerCommitHook.h:26-30`），没有禁止重入。

Mount hook 的注册更简单：只在 `mountHookMutex_` 下断言不存在并 `push_back`，**没有注册回调**
（`UIManager.cpp:623-636`）。

### 6.2 `shadowTreeWillCommit`：按注册顺序串行传递，后一个 hook 拿到前一个的结果

```cpp
  std::shared_lock lock(commitHookMutex_);

  auto resultRootShadowNode = newRootShadowNode;
  for (auto* commitHook : commitHooks_) {
    resultRootShadowNode = commitHook->shadowTreeWillCommit(
        shadowTree, oldRootShadowNode, resultRootShadowNode, commitOptions);
  }

  return resultRootShadowNode;
```

（`UIManager.cpp:640-656`）

- 锁是 `shared_lock`：多个 commit 可以并发进入（如果 `ShadowTree` 允许多个 surface 并发提交），
  但注册/注销会被阻塞；
- 这是**责任链**：每个 hook 都可以替换整棵树；任意一个返回 `nullptr`，`ShadowTree::commit` 会把它当成
  `Cancelled` 并中止（`ShadowTree.cpp:400-402`）；
- `shadowTreeDidCommit` 同样在 `shared_lock` 下遍历（`UIManager.cpp:676-689`），但它**不接收返回值**，
  不能改变提交结果。

### 6.3 接口的默认体：新重载转发旧重载，mount hook 的 unmount 是空操作

`UIManagerCommitHook` 有三层兼容设计（`packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerCommitHook.h:24-72`）：

- 只有 `commitHookWasRegistered` / `commitHookWasUnregistered` 是纯虚（`= 0`，计数 = **2**）；
- 带 `commitOptions` 的 `shadowTreeWillCommit` **默认转发给不带 options 的旧重载**
  （`:41-44`），旧重载默认原样返回新树（`:53-58`）——注释写明「No longer a pure method」；
- `shadowTreeDidCommit` 默认空体（`:65-70`）。

`UIManagerMountHook` 则只有 `shadowTreeDidMount` 是纯虚；`shadowTreeDidUnmount` 有默认空体，
注释是「Default no-op implementation for backwards compatibility」
（`packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerMountHook.h:29-36`）。

> 组合效果：一个只实现旧版 `shadowTreeWillCommit` 的第三方 hook，在 UIManager 走新重载时仍能被调用；
> 但一个**同时**覆盖新旧重载的 hook 必须自己决定是否转发，否则旧重载永远不会被 UIManager 调用。

### 6.4 `reportMount`：用的是「已挂载」的 base revision，不是最新 React revision

```cpp
  auto rootShadowNode = RootShadowNode::Shared{};
  shadowTreeRegistry_.visit(surfaceId, [&](const ShadowTree& shadowTree) {
    rootShadowNode =
        shadowTree.getMountingCoordinator()->getBaseRevision().rootShadowNode;
  });

  {
    std::shared_lock lock(mountHookMutex_);
    for (auto* mountHook : mountHooks_) {
      if (rootShadowNode) {
        mountHook->shadowTreeDidMount(rootShadowNode, time);
      } else {
        mountHook->shadowTreeDidUnmount(surfaceId, time);
      }
    }
  }
```

（`UIManager.cpp:691-713`）

- **`getBaseRevision()` 是挂载层已经消费过的 revision**（83 文档 MOU-16/17 讲过 `baseRevision_` 的推进），
  不是 `getCurrentRevision()`，也不是 `getCurrentReactRevision()`。因此 mount hook 看到的是
  「屏幕上实际长成的那棵树」，而不是 JS 刚提交的树；
- `time` 在 visit **之前**取（`:694`），包含 registry 查找耗时；
- surface 存在但 base revision 为空（还没挂载过）时，也会走 `didUnmount` 分支；
- 与 `ShadowTreeDelegate::shadowTreeDidCommit`（每次 commit 都触发）不同，`reportMount` 的时机由
  平台挂载器显式调用决定。
---

## 7. 三条查询路径：只搜第一个孩子、同 family 短路、EmptyLayoutMetrics 兜底

### 7.1 `findShadowNodeByTag_DEPRECATED`：每个 surface 只从 `children.front()` 开始

```cpp
  shadowTreeRegistry_.enumerate([&](const ShadowTree& shadowTree, bool& stop) {
    auto rootShadowNodeHolder = shadowTree.getCurrentRevision().rootShadowNode;
    const auto* rootShadowNode = rootShadowNodeHolder.get();

    if (rootShadowNode != nullptr) {
      const auto& children = rootShadowNode->getChildren();
      if (!children.empty()) {
        const auto& child = children.front();
        shadowNode = findShadowNodeByTagRecursively(child, tag);
        if (shadowNode) {
          stop = true;
        }
      }
    }
  });
```

（`packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:555-576`）

- 递归函数本身遍历**所有**孩子（`:537-553`），但入口只喂了 `children.front()`；
- 根节点的**其余直接孩子被完全跳过**。普通 React 树的根通常只有一个孩子，所以历史上够用；
  但 view transition 的伪元素节点是**追加到根节点的额外孩子**（`UIManagerViewTransitionDelegate.h:65-69`
  的注释明确说「Pseudo-element nodes are appended as additional children of the root node」），
  这些节点按 tag 是查不到的；
- 找到后 `stop=true` 提前结束跨 surface 枚举；找不到返回 `nullptr`。

### 7.2 `getShadowNodeInSubtree`：同 family 直接返回最新根，否则沿祖先链取孩子

```cpp
  if (ShadowNode::sameFamily(*ancestorShadowNode, shadowNode)) {
    return ancestorShadowNode;
  }

  auto ancestors = shadowNode.getFamily().getAncestors(*ancestorShadowNode);

  if (ancestors.empty()) {
    return nullptr;
  }

  auto pair = ancestors.rbegin();
  return pair->first.get().getChildren().at(pair->second);
```

（`UIManager.cpp:335-356`）

- **同 family 短路**：如果传入的节点与祖先根是同一 family（同一组件、同一 tag），直接返回传入的根，
  而不是在树里找「最新克隆」——调用方拿到的是**参数本身**；
- `ancestors.rbegin()` 是**离目标最近的祖先**，用它的第 `second` 个孩子作为目标；
- 用 `.at()` 而不是 `[]`，越界会抛 `std::out_of_range`（不是静默 UB）；
- 祖先链为空（目标不在该树里）返回 `nullptr`——`setNativeProps` 没有检查这个空值（§3.3）。

### 7.3 `getRelativeLayoutMetrics`：祖先为空的两种含义

（`UIManager.cpp:374-408`）

1. `ancestorShadowNode == nullptr` → 取该 surface **当前 revision** 的根（`:384-390`）；
2. 传了祖先 → 先 `getNewestCloneOfShadowNode(*ancestorShadowNode)` 换成最新克隆（`:391-397`）；
   如果这个克隆返回空，`owningAncestorShadowNode` 为空，`ancestorShadowNode` 被置空，
   后面的 `dynamic_cast<const LayoutableShadowNode*>(nullptr)` 得到 `nullptr`，最终返回
   **`EmptyLayoutMetrics`**（`:399-404`），而不是报错；
3. 祖先不是 `LayoutableShadowNode` 同样返回 `EmptyLayoutMetrics`。

`UIManagerBinding` 的 JS 入口把 policy 写死为 `includeTransform=false`
（`UIManagerBinding.cpp:533-539`）——布局查询不包含 transform；而 pointer retarget 用的是 `true`
（`PointerEventsProcessor.cpp:106-109`）。同一个 API，两个调用方，两种口径。

---

## 8. `updateState`、动画 tick 与 ViewTransition 的「全默认」接口

### 8.1 `updateState`：任何一次 state 回调返回空，整次提交取消

`UIManager::updateState` 在 commit 事务里对 family 的所有实例调 `cloneTree`（`UIManager.cpp:410-451`）：

- 回调返回空指针 → `isValid = false`，并且仍然 `return oldShadowNode.clone({})` 占位（`:430-434`）；
- 事务最后 `return isValid ? static_pointer_cast<RootShadowNode>(rootNode) : nullptr;`（`:445-447`）；
- `ShadowTree::commit` 收到空根会返回 `Cancelled`（`ShadowTree.h`/`ShadowTree.cpp` 的既有语义），
  所以**一次提交里只要有一个实例拒绝更新，整棵树都不会提交**；
- 这是「全有或全无」语义，不是跳过单个节点。

### 8.2 `animationTick`：两套动画后端互斥

```cpp
  if (animationDelegate_ != nullptr &&
      animationDelegate_->shouldAnimateFrame()) {
    shadowTreeRegistry_.enumerate([](const ShadowTree& shadowTree, bool&) {
      shadowTree.notifyDelegatesOfUpdates();
    });
  }

  if (!ReactNativeFeatureFlags::useSharedAnimatedBackend()) {
    if (auto nativeAnimatedDelegate = nativeAnimatedDelegate_.lock()) {
      nativeAnimatedDelegate->runAnimationFrame();
    }
  }
```

（`UIManager.cpp:749-762`）

- **老路径**（`useSharedAnimatedBackend()==false`）：`animationDelegate_` 驱动 layout animation 的
  `notifyDelegatesOfUpdates`，`nativeAnimatedDelegate_` 单独跑 `runAnimationFrame`；
- **新路径**（flag 为 true）：`nativeAnimatedDelegate_` **完全不被调用**，动画帧由共享
  `animationBackend_` 负责（`onAnimationFrame`，见 `UIManagerAnimationBackend.h:31`）；
- 注意：`animationBackend_` 的 tick 并不在 `UIManager::animationTick` 里——`UIManager` 只暴露
  `unstable_setAnimationBackend` / `unstable_getAnimationBackend`（`UIManager.cpp:739-747`），
  驱动方在平台层。

### 8.3 `setViewTransitionDelegate`：只在 flag 打开时保存指针；接口 12 个方法全部有默认体

```cpp
void UIManager::setViewTransitionDelegate(
    UIManagerViewTransitionDelegate* delegate) {
  if (ReactNativeFeatureFlags::viewTransitionEnabled()) {
    viewTransitionDelegate_ = delegate;
  }
}
```

（`UIManager.cpp:732-737`）

- flag 关闭时**直接丢弃** delegate，`getViewTransitionDelegate()` 永远是 `nullptr`；
- flag 曾经打开、保存了指针，之后再关闭 flag，**指针不会被清空**——关闭 flag 不会撤销已注册的 delegate；
- `UIManagerViewTransitionDelegate` 的 **12 个虚方法全部有默认实现，零个 `= 0`**
  （`UIManagerViewTransitionDelegate.h:19-82`）：`applyViewTransitionName`、`createViewTransitionInstance`、
  `cancelViewTransitionName`、`restoreViewTransitionName`、`startViewTransition`、
  `startViewTransitionReadyFinished`、`startViewTransitionEnd`、`getViewTransitionInstance`、
  `findPseudoElementShadowNodeByTag`、`suspendOnActiveViewTransition`、`waitForTransitionAnimation`、
  `transitionAnimationFinished`。平台可以只覆盖自己关心的几个，未覆盖的调用静默成功（空体）或返回
  `nullopt` / `nullptr`。
---

## 9. `UIManagerBinding`：一个全局对象、35 个成员、一个事件槽位

### 9.1 安装：只认 `nativeFabricUIManager`，且顺带打开线程级 runtime 引用

（`packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:26-47`）

```cpp
  auto uiManagerModuleName = "nativeFabricUIManager";
  auto uiManagerValue =
      runtime.global().getProperty(runtime, uiManagerModuleName);
  if (uiManagerValue.isUndefined()) {
    auto uiManagerBinding = std::make_shared<UIManagerBinding>(uiManager);
    auto object = jsi::Object::createFromHostObject(runtime, uiManagerBinding);
    runtime.global().setProperty(
        runtime, uiManagerModuleName, std::move(object));

    ShadowNode::setUseRuntimeShadowNodeReferenceUpdateOnThread(true);
  }
```

- **只在全局值为 `undefined` 时安装**；已存在（哪怕是别的东西）就原样保留，不覆盖、不校验类型；
- 安装时在**当前线程**设置 `ShadowNode::setUseRuntimeShadowNodeReferenceUpdateOnThread(true)`。该值是
  `thread_local`，默认 `false`（`packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:28`），
  由 `ShadowNode.cpp:367` 决定 clone 时是否更新 JS 侧 runtime 引用。换言之：**只有「安装 binding 的那个
  JS 线程」拥有写 runtime 引用的资格**；换线程调用 clone 会静默跳过更新；
- `getBinding(runtime)` 在全局为 `undefined` 时返回 `nullptr`（`:49-61`）；类型不对时
  `asObject` / `getHostObject` 直接抛 JSI 异常，没有 fallback。

### 9.2 成员清单：35 个方法名，未知成员返回 `undefined`

`UIManagerBinding::get` 用一长串 `if (methodName == "...")` 分发。按源码逐字统计，**恰好 35 个不同的
方法名**（`UIManagerBinding.cpp:230-1229`）：

| 组 | 成员 |
| --- | --- |
| 建树/克隆 | `createNode`、`cloneNodeWithNewChildren`、`cloneNodeWithNewProps`、`cloneNodeWithNewChildrenAndProps`、`appendChild`、`createChildSet`、`appendChildToSet` |
| 提交/事件 | `completeRoot`、`registerEventHandler`、`findNodeAtPoint`、`setIsJSResponder`、`setNativeProps`、`dispatchCommand`、`sendAccessibilityEvent` |
| 布局 | `getRelativeLayoutMetrics`、`measureLayout`、`measure`、`measureInWindow`、`measureInstance`、`getBoundingClientRect`、`compareDocumentPosition`、`findShadowNodeByTag_DEPRECATED` |
| 动画 | `configureNextLayoutAnimation` |
| 事件优先级 | `unstable_getCurrentEventPriority`、`unstable_DefaultEventPriority`、`unstable_DiscreteEventPriority`、`unstable_ContinuousEventPriority`、`unstable_IdleEventPriority` |
| View Transition | `applyViewTransitionName`、`createViewTransitionInstance`、`cancelViewTransitionName`、`restoreViewTransitionName`、`suspendOnActiveViewTransition`、`startViewTransitionReadyFinished`、`startViewTransition` |

其中 4 个 `unstable_*EventPriority` 是**常量**（直接 `jsi::Value(number)`），其余 31 个是函数。
**未知成员统一落到函数末尾的 `return jsi::Value::undefined();`**（`:1229`）——不抛
`PropertyNotFoundException`，JS 侧 `uiManager.foo` 静默得到 `undefined`，拼错 API 名不会报错。

### 9.3 `eventHandler_` 只有一个槽位，且没有注销

```cpp
  eventHandler_ =
      std::make_unique<jsi::Function>(std::move(eventHandler));
```

（`UIManagerBinding.cpp:499-518`；成员声明在 `UIManagerBinding.h:87`）

- `registerEventHandler` 每调一次就**覆盖**上一个 handler；没有 `unregister`，也没有「多个监听器」的数组；
- 事件派发处只在 `if (eventHandler_)` 时调用（`:165`），**注册之前的事件静默丢弃**；
- `invalidate()` 不清空 `eventHandler_`（§11.4），所以「失效的 binding」仍握着最后一个 JS 函数对象；
- 这个函数是唯一的事件出口，所有 Fabric 事件（包括 pointer）最终都经它进入 JS。

### 9.4 参数校验只查下界，两个克隆方法把校验注释掉了

```cpp
  if (actual < expected) {
    throw jsi::JSError(
        runtime,
        methodName + " requires " + ... + " arguments, but only " + ... +
            " were passed");
  }
```

（`UIManagerBinding.cpp:179-190`）

- **只查 `actual < expected`**：多传的参数一律忽略，没有类型检查、没有 `expected` 上界；
- `cloneNodeWithNewChildren` 与 `cloneNodeWithNewChildrenAndProps` 的校验被
  `// TODO: re-enable when passChildrenWhenCloningPersistedNodes is rolled out` 注释掉
  （`:338-340`、`:391-393`）。于是 `cloneNodeWithNewChildren()` 可以零参调用，
  随后 `arguments[0]` 越界读取——这是 rollout 期间的已知缺口，不是笔误；
- 其余方法即使校验通过，也会在 `arguments[i].getNumber()` / `getObject()` 处把类型错误抛成 JSI 异常。

> 顺带一处死代码：`completeRoot` 里 `auto runtimeSchedulerBinding =
> RuntimeSchedulerBinding::getBinding(runtime);`（`:483-484`）取了却从未使用——提交已不再经过
> RuntimeScheduler。它在 `-Wunused-variable` 下本应告警，但该文件没有开这条警告。
---

## 10. 事件派发：pointer 分流、注释与实现不符的「drop」、未初始化的优先级

### 10.1 `dispatchEvent`：pointer 事件先还原 shadow node，再进状态机

非 pointer 事件直接走 `dispatchEventToJS`；pointer 事件则先从 **JS `EventTarget` 对象**
反查 shadow node（`UIManagerBinding.cpp:71-115`）：

```cpp
  if (eventPayload.getType() == EventPayloadType::PointerEvent) {
    ...
    auto targetNode = PointerEventsProcessor::getShadowNodeFromEventTarget(
        runtime, eventTarget);
    if (targetNode != nullptr) {
      pointerEventsProcessor_.interceptPointerEvent(...);
    }
  } else {
    dispatchEventToJS(...);
  }
```

两条硬约束：

- 反查链是 `instanceHandle.stateNode.node`（`PointerEventsProcessor.cpp:15-41`）——JS 侧对象形状变了
  （如 `stateNode` 改名）就返回空；
- **`targetNode == nullptr` 时事件被静默丢弃**，不会退回 `dispatchEventToJS`。即 pointer 事件没有
  「无 target 也要通知 JS」的兜底路径。非 pointer 事件反而允许 `eventTarget == nullptr`
  （`dispatchEventToJS` 里 instanceHandle 取 null）。

### 10.2 `dispatchEventToJS`：注释说「will be dropped」，代码继续调用 handler

```cpp
  if (instanceHandle.isNull()) {
    // Do not log all missing instanceHandles to avoid log spam
    LOG_EVERY_N(INFO, 10) << "instanceHandle is null, event of type " << type
                          << " will be dropped";
  }
  ...
  currentEventPriority_ = priority;
  if (eventHandler_) {
    eventHandler_->call(
        runtime,
        std::move(instanceHandle),   // ← 这里传的是 null
        jsi::String::createFromUtf8(runtime, type),
        std::move(payload));
  }
  currentEventPriority_ = ReactEventPriority::Default;
```

（`UIManagerBinding.cpp:149-172`）

- 日志后**没有 `return`**：事件并没有被 C++ 丢掉，而是带着 `null` 的 instanceHandle 进入 JS
  `eventHandler`。真正丢弃它的是 JS 侧 handler 对 target 的空值判断（不在本文范围）；
- 每 10 次才打一条 `INFO`，且文案是「will be dropped」——与实际行为不一致；
- `currentEventPriority_` 是**单个成员变量**，不是栈式保存：
  1. 嵌套派发时，内层结束后把它复位成 `Default`，外层恢复不了自己的优先级；
  2. `eventHandler_->call` 抛异常时，复位语句被跳过，优先级**永久停在事件值**；
  3. 成员声明 `mutable ReactEventPriority currentEventPriority_;`（`UIManagerBinding.h:88`）**没有初值**。
     首次事件之前调用 `unstable_getCurrentEventPriority`（`:773-785`）读取的是不确定值；
     `ReactEventPriority` 是普通 `enum class`（`packages/react-native/ReactCommon/react/renderer/core/ReactEventPriority.h:18`），
     不保证零初始化。

### 10.3 `findNodeAtPoint`：手写 `lock()` / `unlock()`，中间调用 JS 可重入代码

```cpp
          auto& eventTarget = targetNode->getEventEmitter()->eventTarget_;

          EventEmitter::DispatchMutex().lock();
          eventTarget->retain(runtime);
          auto instanceHandle = eventTarget->getInstanceHandle(runtime);
          eventTarget->release(runtime);
          EventEmitter::DispatchMutex().unlock();

          onSuccessFunction.call(runtime, std::move(instanceHandle));
```

（`UIManagerBinding.cpp:310-322`）

- `EventEmitter::DispatchMutex()` 返回 **`std::mutex&`**（`packages/react-native/ReactCommon/react/renderer/core/EventEmitter.h:41`），
  不是递归锁；
- 没有 RAII（`std::lock_guard` / `unique_lock`）：`retain` / `getInstanceHandle` / `release` 任意一步
  抛异常，`unlock()` 永远不执行 → 该 runtime 的所有事件派发永久卡死；
- `getInstanceHandle(runtime)` 会调用 JS（`instanceHandle` 是 JSI 值），意味着**持锁进入 JS**；
  如果 JS 在 getter 里同步触发另一个需要 `DispatchMutex` 的路径，同一线程二次加锁 `std::mutex` 是 UB；
- 直接读 `targetNode->getEventEmitter()->eventTarget_`——`eventTarget_` 是 `EventEmitter` 的**公有字段**，
  绕过了封装；
- 成功回调在 `unlock()` **之后**调用，这一点是对的；失败（`!targetNode`）时回 `null`（`:306-309`）。

### 10.4 `invalidate()`：只摘 delegate，不摘 handler / pointer 状态

```cpp
void UIManagerBinding::invalidate() const {
  uiManager_->setDelegate(nullptr);
}
```

（`UIManagerBinding.cpp:175-177`）

方法名暗示「整个 binding 失效」，实际只做了两件事中的一件：把 `UIManager` 的 delegate 置空。
它**没有**：

- 重置 `eventHandler_`（仍持有 JS 函数、仍可被调用）；
- 清空 `pointerEventsProcessor_` 的 `activePointers_` / capture / hover 注册表；
- 释放 `uiManager_`（`UIManagerBinding` 仍强持有 `UIManager`，后者无法先析构）。

头文件注释说「Calling any public method of the object after calling this method is undefined behavior」
（`UIManagerBinding.h:43-47`），但代码层面没有任何防护——这是一份「调用方自律」的契约。

### 10.5 六个几何查询：全部走 consistency provider + `dom::*`，空 revision 各自返回零值

`measureLayout`、`measure`、`measureInWindow`、`getBoundingClientRect`、`compareDocumentPosition`、
`measureInstance` 全部先取

（共 **6** 处：`packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:623`、`669`、`709`、`848`、`890`、`930`）

```cpp
uiManager->getShadowTreeRevisionProvider()->getCurrentRevision(surfaceId)
```

再调用 `dom::measureLayout` /
`dom::measure` / `dom::measureInWindow` / `dom::getBoundingClientRect` / `dom::compareDocumentPosition`
（DOM 层见 64 文档）。注意 `getCurrentRevision` 在锁定期间返回的是 **React revision**，不是挂载 revision
（12 文档的增量结论）。

空 revision 时的返回各不相同：

| 方法 | 空 revision 行为 |
| --- | --- |
| `measureLayout` | `onFail()`（`:625-628`） |
| `measure` | 回调 `(0,0,0,0,0,0)`（`:671-674`） |
| `measureInWindow` | 回调 `(0,0,0,0)`（`:711-714`） |
| `getBoundingClientRect` | 返回 `undefined`（`:850-853`） |
| `compareDocumentPosition` | 返回 `0`（`:892-895`） |
| `measureInstance` | 返回零对象（`:932-935`） |

同一类「拿不到树」的状态，六种 API 给出六种形状。这些是既有 JS 契约，不是 bug，但排查时必须知道
「0 / undefined / onFail」分别对应哪个入口。
---

## 11. 指针事件状态机：capture、retarget 与 hover 差分

### 11.1 capture：静默失败、按 tag 匹配、lost/got 的门禁是恒真

```cpp
  if (auto activePointer = getActivePointer(pointerId)) {
    // As per the spec this method should silently fail if the pointer in
    // question does not have any active buttons
    if (activePointer->event.buttons == 0) {
      return;
    }
    pendingPointerCaptureTargetOverrides_[pointerId] = shadowNode;
  } else {
    // TODO: Throw DOMException with name "NotFoundError" ...
  }
```

（`packages/react-native/ReactCommon/react/renderer/uimanager/PointerEventsProcessor.cpp:289-304`）

- **`buttons == 0` 静默失败**：不抛错、不返回值，JS 侧无法知道 capture 没生效；
- **pointer 不在 active 表也静默失败**：TODO 明说要抛 `NotFoundError`，但当前什么也不做；
- `releasePointerCapture` 只和 **`pending` 表**里的 target 比较 tag（`:306-323`），不匹配就 no-op；
  `hasPointerCapture` 也只查 `pending` 表（`:325-334`）——不看 active 表；
- 两个 capture 表都是 `weak_ptr`（`CaptureTargetOverrideRegistry`），读取时做懒惰过期清理
  （`:121-138`）：target 过期 → `erase` → 当作没有 capture；
- `processPendingPointerCapture` 在 capture 变更时发 `topLostPointerCapture` / `topGotPointerCapture`，
  优先级写死 `Discrete`（`:399-417`）。

**门禁恒真**：这两次发送前都调用 `shouldEmitPointerEvent(..., "topLostPointerCapture"/"topGotPointerCapture", ...)`，
但 `shouldEmitPointerEvent` 的 if 链只覆盖 `topPointerDown/Up/Move/Enter/Leave/Over/Out/topClick` 八种，
末行是对未识别 type 的「直接放行」：

```cpp
  // This is more of an optimization method so if we encounter a type which
  // has not been specifically addressed above we should just let it through.
  return true;
```

（`PointerEventsProcessor.cpp:144-204`）

因此 lost/got 的监听器检查**永远返回 true**，capture 事件无论有没有 JS 监听器都会派发。
这不是「漏了一个分支」那么简单：注释把返回 true 定义为「优化兜底」，而 capture 路径把它当成了
「总是发送」的语义。

### 11.2 一次 pointer 事件的固定顺序

`interceptPointerEvent` 的顺序（`PointerEventsProcessor.cpp:206-287`）是本文最重要的状态机事实：

1. `processPendingPointerCapture` —— **先**结算上一轮排队的 capture 变更；
2. 取 `pending` override；若与当前 target 的 tag 不同，`retargetPointerEvent` 换目标；
3. `topClick` **完全绕过后续处理**，直接 `eventDispatcher` 后 `return`（`:231-236`）；
4. `topPointerDown` 注册 active pointer；`topPointerMove` 仅在已注册时更新事件（`:238-246`）；
5. `topPointerLeave` 不走原始派发，而是用 `nullptr` target 跑 hover 逻辑（`:248-256`）——
   **平台 leave 事件本身不会进 JS**，JS 看到的是状态机合成的 enter/leave；
6. 其他事件：先更新 hover（`handleIncomingPointerEventOnNode`），再按 `shouldEmitPointerEvent` 决定
   是否派发原始事件（`:257-262`）；
7. `pointercancel`，或「按下时没有 hover、松开即离开」的 `pointerup`，再跑一次 hover(null)（`:264-274`）；
8. 若 capture 仍生效且事件是 up/cancel：隐式 `releasePointerCapture` + 再结算一次 pending（`:277-282`）；
9. up/cancel 最后注销 active pointer（`:284-286`）。

注意第 3 步的 `topClick` 是**在 retarget 之后**直接派发的：如果 retarget 返回空 target，
`eventDispatcher(*targetNode, ...)` 会解引用空指针（见 §11.3）。
---

### 11.3 `retargetPointerEvent`：TODO 自己都在问「不判空安全吗」

```cpp
static PointerEventTarget retargetPointerEvent(
    const PointerEvent& event,
    const ShadowNode& nodeToTarget,
    const UIManager& uiManager) {
  PointerEvent retargetedEvent(event);

  // TODO: is dereferencing latestNodeToTarget without null checking safe?
  auto latestNodeToTarget = uiManager.getNewestCloneOfShadowNode(nodeToTarget);

  auto layoutMetrics = uiManager.getRelativeLayoutMetrics(
      *latestNodeToTarget, nullptr,
      {/* .includeTransform */ .includeTransform = true});
  ...
  result.target = latestNodeToTarget;
  return result;
}
```

（`PointerEventsProcessor.cpp:92-119`）

`getNewestCloneOfShadowNode` 的空返回不是理论：它在 surface 不在 registry 里、或节点已不在当前
revision 里时直接返回 `nullptr`（`UIManager.cpp:325-340`）。于是：

- `:107` 的 `*latestNodeToTarget` 是**空引用解引用**（UB），发生在 `getRelativeLayoutMetrics` 之前；
- 即便这里侥幸没崩，`result.target` 也是空（`:117`）；
- 调用方 `:400` / `:411` 又直接 `*retargeted.target` 构造 `shouldEmitPointerEvent`；
- `interceptPointerEvent` 把 `retargeted.target` 赋给 `targetNode`（`:228`），随后
  `:234`（topClick）、`:260`（shouldEmit）都会解引用它。

一条完整的崩溃链：pointer capture 的 target 被 JS 释放/移出树 → 下一个 pointer 事件走到 retarget →
`getNewestCloneOfShadowNode` 返回空 → `:107` 崩。**四个解引用点（107/400/411/260）没有一个判空**，
且 TODO 注释就写在这条链的起点。

### 11.4 hover 差分：从根比较 family，假设节点永不「换父」

`PointerHoverTracker` 保存两个 shared_ptr：`target_` 与 `root_`（构造时按 target 的 surface 快照，
`PointerHoverTracker.cpp:16-32`）。旧的 tracker 在下次事件里被 `markAsOld()`，之后所有节点都通过
`getLatestNode` 换成当前 revision 的最新克隆（`:123-131`）。

差分算法（`:64-109`）：

```cpp
  auto myIt = myEventPath.rbegin();
  auto otherIt = otherEventPath.rbegin();
  while (myIt != myEventPath.rend() && otherIt != otherEventPath.rend()) {
    if (!ShadowNode::sameFamily(myIt->get(), otherIt->get())) {
      break;
    }
    ++myIt;
    ++otherIt;
  }
```

- `getEventPathTargets()` 返回 **[target, parent, …, root]**（`:133-147`），所以 `rbegin()` 是
  **从根往目标**走——先消掉公共祖先，剩下的就是离开/进入的子树；
- 比较用 `sameFamily`（组件 + tag），不是指针相等，所以 commit 产生的新 clone 不会被误判为「换节点」；
- 注释明确写了算法的前提：「**nodes in react-native don't get re-parented**」，如果出现多余的
  leave→enter，需要换更稳的 diff（`:78-81`）。reparent（例如把节点移动到另一个父节点下）会让公共前缀
  的假设失效，产生虚假的 leave/enter 对。

事件顺序（`PointerEventsProcessor.cpp:428-544`）：

| 阶段 | 顺序 | 过滤 |
| --- | --- | --- |
| `topPointerOut` | 单个（旧 target） | `hasSameTarget` 为假且旧路径有 out/outCapture 监听 |
| leave | **target → root**（先收集再 `rbegin` 反向发） | 自身 leave 监听，或祖先有 leaveCapture（`hasParentLeaveCaptureListener`） |
| `topPointerOver` | 单个（新 target） | `hasSameTarget` 为假且新路径有 over/overCapture 监听 |
| enter | **root → target**（正序直接发） | 自身 enter 监听，或祖先有 enterCapture（`hasParentEnterCaptureListener`） |

最后，`targetNode != nullptr` 才保存新 tracker，否则 `erase(pointerId)`（`:538-543`）。
所以一次 `pointerleave`（null target）会清掉该 pointer 的全部 hover 状态；下次 move 重新从零建立。

### 11.5 裸指针与无锁：hover 的返回值只有「当下」有效

`getLatestNode` 的实现是：

（`packages/react-native/ReactCommon/react/renderer/uimanager/PointerHoverTracker.cpp:123-131`）

```cpp
  if (isOldTracker_) {
    auto newestTarget = uiManager.getNewestCloneOfShadowNode(node);
    return newestTarget.get();
  }
  return &node;
```

- `newestTarget` 是**局部 shared_ptr**，函数返回时析构；返回的裸指针没有带走所有权。
  它能用的前提是「当前 revision 的树仍持有这个节点」。如果另一线程在此期间 commit 出新树并释放旧树，
  这个指针就可能悬垂；`diffEventPath` 把它存进 `EventPath`（`reference_wrapper<const ShadowNode>`）
  后继续使用，生命周期完全靠调用栈上的「恰好没人替换树」；
- 整个 `PointerEventsProcessor` **没有任何互斥锁**（与该文件 546 行内的 0 次 `lock` 一致）；
  `activePointers_`、两张 capture 表、`previousHoverTrackersPerPointer_` 都假定只在 JS 线程访问；
- 这些表只按 pointerId 增删，**没有容量上限**。平台若漏发 up/cancel（或 pointerId 无限增长），
  `activePointers_` 与 capture 表会一直变大，直到进程结束。
---

## 12. `updateShadowTree`：BFS 找节点、自底向上克隆、以及一个会丢并发提交的旧根

这是 `uimanager/` 里唯一不经过 JS 绑定的写路径：输入是 `Tag → folly::dynamic props` 的 map，
由平台/动画侧直接调用 `UIManager::updateShadowTree`（`UIManagerUpdateShadowTree.cpp:87-227`）。

### 12.1 算法：三层结构

**Step 1 — BFS 找目标并补祖先**（`:97-154`）：

```cpp
    std::deque<std::shared_ptr<const ShadowNode>> deque{rootShadowNode};
    int depth = 0;
    while (!deque.empty()) {
      auto size = deque.size();
      for (auto i = 0; i < size; i++) {
        auto shadowNode = std::move(deque.front());
        deque.pop_front();

        if (auto nodesPropsIt = remainingTagToProps.find(shadowNode->getTag());
            nodesPropsIt != remainingTagToProps.end()) {
          ...
          remainingTagToProps.erase(nodesPropsIt->first);
          addAncestorsToUpdateList(shadowNode, rootShadowNode, shadowNodesToUpdate);
        }
        for (const auto& child : shadowNode->getChildren()) {
          deque.push_back(child);
        }
      }
      depth++;
    }
```

- **逐 surface 全树 BFS**，直到 `remainingTagToProps` 为空才 `stop`（`:99-102`）；
- 每个命中节点记录 `{tag, depth, weak_ptr, changedProps}`；祖先用
  `addAncestorsToUpdateList` 补进同一个列表，并记录 `updatedChildrenIndices`（`:33-77`）；
- `depth` 是**层号**，根为 0；同一个 tag 在列表里只出现一次。

**Step 2 — 按 depth 降序克隆**（`:158-211`）：

```cpp
    std::sort(..., [](const auto& a, const auto& b) { return a.depth > b.depth; });
```

- 先克隆最深的节点，再克隆祖先；克隆祖先时用 `clonedShadowNodes` 里已经克隆好的孩子替换
  `children[updatedChildIndex]`（`:187-199`）；
- props 走 `componentDescriptor->cloneProps`，descriptor 的查找函数名字就叫
  **`findComponentDescriptorByHandle_DO_NOT_USE_THIS_IS_BROKEN`**（`:170-173`）——
  接口自己承认 broken，但这里是唯一调用点；
- 找不到已克隆孩子只 `LOG(ERROR) << "Child ShadowNode has not been cloned"`（`:194`）；
  索引越界只 `LOG(WARNING) << "Child no longer exits"`（`:197`，`exits` 是拼写错误）并跳过，
  **继续克隆**；
- 没克隆根节点则 `LOG(ERROR) << "Root ShadowNode has not been cloned"`（`:224`），不提交。

**Step 3 — 提交**（`:215-225`）：

```cpp
      shadowTree.commit(
          [rootNode =
               it->second](const RootShadowNode&) -> RootShadowNode::Unshared {
            return std::static_pointer_cast<RootShadowNode>(rootNode);
          },
          {});
```

- **返回值没有接收**：commit 的 `Succeeded / Failed / Cancelled` 被完全忽略；
- commit options 是 `{}`，即 `enableStateReconciliation=false`、`mountSynchronously=true`、
  `source=Unknown`（`packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.h:59-73`）。
  它**不是** React 分支，不会走 `enableFabricCommitBranching` 的 React revision 逻辑；
- 提交后**没有** `lazyShadowTreeRevisionConsistencyManager_->updateCurrentRevision(surfaceId)`——
  与 `completeSurface` 的成功路径（§4.3）不对称。

### 12.2 旧根竞态：事务参数被忽略，CAS 只比较 revision 号

`rootShadowNode` 是在 BFS 之前取的（`:104`），整个 BFS + 克隆可能耗时；commit 的事务 lambda
**用一个下划线丢弃了传入的 `const RootShadowNode&`**，直接返回预先构建好的 `rootNode`。

`ShadowTree::commit` 的重试机制会把**最新的** old root 传进事务，但它只检查 revision 号是否变化
（`packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.cpp:427-433`），
**不检查事务返回的树是否由这个 old root 派生**。因此：

1. 线程 A 在 `:104` 捕获 revision N 的根；
2. 线程 B 提交 revision N+1（例如 native animated 的 UI 线程提交）；
3. 线程 A 的 commit 在 `currentRevision_.number == N+1` 上比较——如果它拿到的 old revision 是 N+1，
   CAS 通过（它只要求「当前号 == 进入 commit 时的号」），然后写入一棵**基于 N 克隆的树**，
   revision 号变成 N+2；
4. B 在 N+1 里做的修改从树上消失，且 `updateMountedFlag` 会把 B 新增的节点当作「已卸载」处理。

这不是「理论竞态」：`updateShadowTree` 的调用方正是 native animated / 平台侧，和 React 的 JS 提交
天然可能并发。`{}` 的 `source=Unknown` 又让它走非 React 分支，连 `progressState` 都不会把旧树的状态
合并回来。**结论：`updateShadowTree` 只适合「没有并发 commit」的树；UIManager 没有为它提供串行化保证。**

> 同一文件里还有两个小事实：`delegate_->uiManagerDidUpdateShadowTree(remainingTagToProps)` 在过滤前
> 调用（`:93-95`），delegate 看到的是**完整的**输入 map；而 `remainingTagToProps` 在跨 surface 的
> 枚举中被持续 `erase`，某个 tag 如果不在任何 surface 里，循环结束后既不报错也不记录。
---

## 13. 入口胶水与布局事件：`RN$AppRegistry`、`LayoutEventEmitter`、`primitives.h`

### 13.1 `AppRegistryBinding`：三个全局函数，缺一个就抛 `std::runtime_error`

`AppRegistryBinding` 不持有任何状态，只把 C++ 调用翻译成 JS 全局函数
（`packages/react-native/ReactCommon/react/renderer/uimanager/AppRegistryBinding.cpp`）：

| C++ 方法 | JS 全局 | 参数 |
| --- | --- | --- |
| `startSurface`（`:14-40`） | `RN$AppRegistry.runApplication` | `(moduleName, {rootTag, initialProps, fabric:true}, displayModeInt)` |
| `setSurfaceProps`（`:42-69`） | `RN$AppRegistry.setSurfaceProps` | 同上 |
| `stopSurface`（`:71-86`） | `RN$stopSurface` | `(surfaceId)` |

- **`fabric` 写死 `true`**（`:25`、`:53`）；`displayMode` 转成整数（`displayModeToInt`，见 §13.3）；
- 全局不是对象/函数时**抛 `std::runtime_error`**（`:29-32`、`:56-60`、`:76-80`）。
  `startSurface` / `stopSurface` 的调用点在 `runtimeExecutor_` 排队的任务里，异常会直接在 JS 线程抛出；
- `setSurfaceProps` 的 `TraceSection` 名字写成了 **`"UIManagerBinding::setSurfaceProps"`**（`:48`）——
  实际类名是 `AppRegistryBinding`。用 Perfetto 过滤 `UIManagerBinding` 会多出一条不属于它的 slice；
- `stopSurface` 是唯一没有 `TraceSection` 的方法。

### 13.2 `LayoutEventEmitter`：commit hook 里把 `onLayout` 塞给 C++ EventEmitter

```cpp
void LayoutEventEmitter::shadowTreeDidCommit(
    const ShadowTree& /*shadowTree*/,
    const RootShadowNode::Shared& /*rootShadowNode*/,
    const std::vector<const LayoutableShadowNode*>&
        affectedLayoutableNodes) noexcept {
  ...
  for (const auto* layoutableNode : affectedLayoutableNodes) {
    if (auto viewProps =
            dynamic_cast<const ViewProps*>(layoutableNode->getProps().get())) {
      if (viewProps->onLayout) {
        static_cast<const BaseViewEventEmitter&>(
            *layoutableNode->getEventEmitter())
            .onLayout(layoutableNode->getLayoutMetrics());
      }
    }
  }
}
```

（`packages/react-native/ReactCommon/react/renderer/uimanager/LayoutEventEmitter.cpp:16-36`）

- 它是 `UIManagerCommitHook` 的实现，`shadowTreeDidCommit` 被 UIManager 在 `shared_lock` 下调用；
- 只处理 props **动态类型是 `ViewProps`** 且 `onLayout` 非空的节点；其他 Layoutable（Text、Image 等）
  即使有布局变化也不发 `onLayout`；
- 发事件走 `BaseViewEventEmitter::onLayout(layoutMetrics)`，不直接碰 JS；
- 头文件注释说明这段逻辑**原来在 `ShadowTree` 里**，后来才抽成 hook
  （`LayoutEventEmitter.h:19-20`）。

### 13.3 `primitives.h`：NativeState 包装与四个「宽松转换」

`valueFromShadowNode`（`packages/react-native/ReactCommon/react/renderer/uimanager/primitives.h:37-52`）把节点包进 `ShadowNodeWrapper` 的 NativeState：

```cpp
  auto wrappedShadowNode = std::make_shared<ShadowNodeWrapper>(std::move(shadowNode));
  if (assignRuntimeShadowNodeReference) {
    wrappedShadowNode->shadowNode->setRuntimeShadowNodeReference(wrappedShadowNode);
  }
  jsi::Object obj(runtime);
  obj.setNativeState(runtime, std::move(wrappedShadowNode));
```

第三个参数默认 `false`，而 `UIManagerBinding` 的 create/clone 都传 `true`——JS 侧对象因此持有
「runtime shadow node reference」，在 Fabric commit 时可以被原地更新（`ShadowNode.cpp:360-375`）。

列表转换有两条路径（`:56-83`）：

- 传 **JS 数组**：非空时新建 vector 并逐个 `Bridging<shared_ptr<const ShadowNode>>::fromJs`；
  **空数组则新建一个空 vector**，而不是复用 `ShadowNode::emptySharedShadowNodeSharedList()`
  （`:74-79`，TODO 已注明）。空数组后面还多了一个**孤立分号**（`:78`），语法合法但明显是手滑；
- 传 **NativeState**：直接取 `ShadowNodeListWrapper::shadowNodeList`，与 JS 数组共享同一个 vector。

弱引用方向（`:97-121`）：

- `shadowNodeListFromWeakList` 把 weak list 升为 strong；**任何一个节点过期就返回 `nullptr`**，
  不是跳过该节点；
- `weakShadowNodeListFromValue` 先走 `shadowNodeListFromValue`，再逐项转 weak。因此「JS 数组 → weak」
  这一步允许 `nullptr` 元素（`fromJs` 可能返回空 shared_ptr），不会在这里报错。

四个数值/句柄转换都没有范围检查：

- `tagFromValue` / `surfaceIdFromValue` 直接 `(Tag)value.getNumber()` / `(SurfaceId)value.getNumber()`
  （`:123-126`、`:138-141`）——负数、小数、超过 32 位的值会被静默截断；
- `instanceHandleFromValue` **先 `react_native_assert(!isNull())`，再 `if (isNull()) return nullptr;`**
  （`:128-136`）。release 构建里 assert 被编译掉，只剩返回空；debug 构建里直接 abort。
  这个「assert + 判空」的写法意味着：**同一份非法输入，debug 崩溃、release 静默返回空**；
- `displayModeToInt` 把 `Visible/Suspended/Hidden` 映射为 `1/2/3`，默认分支
  `react_native_assert(0 && ...); return -1;`（`:143-158`）。这是 JS `DisplayMode.js` 的镜像，
  注释要求两边同步。
---

## 14. 构建与接口：两个 OBJECT 库、八张回调接口、一个改名 shim

### 14.1 CMake：glob 收 `*.cpp`，主库与 consistency 分库

`packages/react-native/ReactCommon/react/renderer/uimanager/CMakeLists.txt:11-41`：

```cmake
file(GLOB react_renderer_uimanager_SRC CONFIGURE_DEPENDS *.cpp)
add_library(react_renderer_uimanager OBJECT ${react_renderer_uimanager_SRC})
...
target_link_libraries(react_renderer_uimanager
        ...
        react_renderer_consistency
        react_renderer_uimanager_consistency
        ...
        react_renderer_mounting
        ...
)
target_compile_options(react_renderer_uimanager PRIVATE -Wno-unused-local-typedef)
target_compile_options(react_renderer_uimanager PRIVATE -Wpedantic)
```

- `GLOB *.cpp` **只收本目录**，`tests/` 与 `consistency/` 是子目录，不会进主库；
- `consistency/CMakeLists.txt:11-23` 用同样的 glob 建第二个 OBJECT 库
  `react_renderer_uimanager_consistency`，主库再链接它；
- 依赖里同时有 `react_renderer_consistency`（基类接口）和 `react_renderer_uimanager_consistency`
  （`LazyShadowTreeRevisionConsistencyManager` 实现）；
- `-Wno-unused-local-typedef` 是给 JSI 宏擦屁股的，`-Wpedantic` 则全开——`completeRoot` 里那个
  未使用的 `runtimeSchedulerBinding`（§9.4）属于 `-Wunused-variable`，不在这两条选项的覆盖范围。

### 14.2 八张接口的纯虚数量

| 接口 | 纯虚方法数 | 默认体 |
| --- | --- | --- |
| `UIManagerDelegate` | **15** | 无（全部 `= 0`） |
| `UIManagerCommitHook` | **2**（register/unregister 回调） | `shadowTreeWillCommit` 新旧两版 + `shadowTreeDidCommit` |
| `UIManagerMountHook` | **1**（`shadowTreeDidMount`） | `shadowTreeDidUnmount` |
| `UIManagerAnimationBackend` | **8** | 无 |
| `UIManagerAnimationDelegate` | **4** | 无 |
| `UIManagerNativeAnimatedDelegate` | **1**（`runAnimationFrame`） | 无 |
| `LayoutAnimationStatusDelegate` | **2** | 无 |
| `UIManagerViewTransitionDelegate` | **0** | **12 个方法全部有默认体** |

（锚点分别为各头文件的类定义；计数用 `grep -c '= 0;'` 对单文件统计。）

### 14.3 `SurfaceRegistryBinding.h`：只剩一条 `#warning` 的改名 shim

```cpp
#pragma once

#warning "The SurfaceRegistryBinding.h header has been renamed to AppRegistryBinding.h"

#include <react/renderer/uimanager/AppRegistryBinding.h>
```

（`packages/react-native/ReactCommon/react/renderer/uimanager/SurfaceRegistryBinding.h:10-12`）

- 它**没有自己的类**，只是把旧名字转发到 `AppRegistryBinding.h`；
- 任何 include 都会触发一条编译期 `#warning`（非错误，但会污染构建日志）；
- 全仓对 `SurfaceRegistryBinding.h` 的 include 数为 **0**——这条 warning 目前不会响，
  这个文件是为外部/旧代码留的兼容层，不是内部路径。

---

## 15. 结论表

| 编号 | 结论 | 锚点 | 补充 |
| --- | --- | --- | --- |
| **UIM-1** | `UIManager` 的三个 delegate 是裸指针、nativeAnimatedDelegate 是 weak_ptr，LeakChecker 仅在 `REACT_NATIVE_DEBUG` 构造；析构只打 WARNING，两个一致性 getter 返回同一对象 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.h:250-270`、`UIManager.cpp:31-38`、`:49-63`、`:358-365` | owner 必须手动置空，无运行时检查 |
| **UIM-2** | `createNode` 用 component handle 判断 fallback 命中，命中后注入 `name` prop，再通知 delegate 与 LeakChecker | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:73-110` | fallback 依赖 `name` 才能渲染 |
| **UIM-3** | `cloneNode` 在 `nativePropsMutex` 下做两次 merge：rawProps→nativeProps（Ignore）、nativeProps→rawProps（Override），最终 nativeProps 胜；克隆时 `runtimeShadowNodeReference=false` | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:129-181` | 与 `setNativeProps` 的优先级相反 |
| **UIM-4** | `setNativeProps_DEPRECATED` 用 Override 让 rawProps 覆盖 nativeProps；祖先快照在 commit 外取一次，且 `getShadowNodeInSubtree(...)->getProps()` 不判空 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:466-503` | commit 重试时祖先可能过期 |
| **UIM-5** | `startSurface` 顺序：registry.add → visit 内通知 delegate → runtimeExecutor 调 `RN$AppRegistry.runApplication`；delegate 回调持 registry 共享锁 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:239-264`、`packages/react-native/ReactCommon/react/renderer/mounting/ShadowTreeRegistry.cpp:39-42` | 第 3 步异步 |
| **UIM-6** | `stopSurface` 顺序：停动画 → registry.remove → JS stopSurface → leakChecker；`clearRegistryOnSurfaceStop` 在 `if (shadowTree)` 块之外，surface 不存在也执行 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:288-323` | 返回的 `ShadowTree::Unique` 转移所有权 |
| **UIM-7** | `completeSurface` 的 `ShadowTree::CommitStatus result;` 无初值，surface 不存在时读未初始化枚举是 UB；仅 Succeeded 时更新 consistency + clearRegistry；`completeRoot` 写死 stateReconciliation=true / mountSynchronously=false / source=React | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:202-225`、`UIManagerBinding.cpp:488-493` | 与 commitEmptyTree 的默认值分叉 |
| **UIM-8** | UIManager 的 3 处 commit 与 updateShadowTree 的 1 处 commit 全部在 registry 的 shared_lock 内，完整提交期间阻塞 surface add/remove | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:204-215`、`:419-450`、`:484-511`、`UIManagerUpdateShadowTree.cpp:97-226` | 锁形态见 `ShadowTreeRegistry.cpp:39-57` |
| **UIM-9** | `reportMount` 用 mounting coordinator 的 `baseRevision`（已挂载树），不是 current/React revision；无 base 时对每个 mount hook 发 didUnmount；time 在 visit 前取 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:691-713` | 与 commit 触发的 delegate 不同源 |
| **UIM-10** | commit hook 注册/注销回调都在 `unique_lock` 内；register 先回调后入表、unregister 先出表后回调，回调重入即二次加锁 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:605-621` | mount hook 无注册回调 |
| **UIM-11** | `shadowTreeWillCommit` 在 shared_lock 下按注册顺序串行链式传递结果；`shadowTreeDidCommit` 同锁遍历且不影响提交 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:640-656`、`:676-689` | 任一 hook 返回空即 Cancelled |
| **UIM-12** | CommitHook 仅 2 个纯虚；新 `shadowTreeWillCommit` 默认转发旧重载、旧重载默认返回新树、didCommit 空体；MountHook 仅 didMount 纯虚，didUnmount 默认空体 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerCommitHook.h:24-72`、`UIManagerMountHook.h:29-36` | 兼容旧子类的三层设计 |
| **UIM-13** | `findShadowNodeByTag_DEPRECATED` 每个 surface 只从 `children.front()` 进递归，根的其他直接孩子（如 view transition 伪元素）永远查不到 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:555-576`、`UIManagerViewTransitionDelegate.h:65-69` | 伪元素是根的额外孩子 |
| **UIM-14** | `getShadowNodeInSubtree` 同 family 直接返回参数根；否则 `ancestors.rbegin()` 取最近祖先 + `children.at()`；祖先链空返回 nullptr | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:335-356` | 空返回未被 setNativeProps 检查 |
| **UIM-15** | `getRelativeLayoutMetrics` 祖先为空→当前 revision 根；祖先非空→newest clone，克隆为空或非 Layoutable 都返回 EmptyLayoutMetrics；binding 固定 includeTransform=false | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:374-408`、`UIManagerBinding.cpp:533-539` | pointer retarget 用 true |
| **UIM-16** | `updateState` 任一实例 cloneTree 返回空→isValid=false→事务返回 nullptr→整次提交 Cancelled，全有或全无 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:410-451` | 不是跳过单个节点 |
| **UIM-17** | `animationTick` 在 animationDelegate 的 shouldAnimateFrame 为真时逐树 notifyDelegatesOfUpdates；仅当 `!useSharedAnimatedBackend()` 才调 nativeAnimatedDelegate，两后端互斥 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:749-762` | 共享后端 tick 在平台层 |
| **UIM-18** | `setViewTransitionDelegate` 仅在 flag 开启时保存，关闭 flag 不清空；ViewTransition 接口 12 个虚方法全部有默认体、0 个纯虚 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:732-737`、`UIManagerViewTransitionDelegate.h:19-82` | 平台可只覆盖关心的几个 |
| **UIM-19** | `updateShadowTree` 逐 surface BFS 收集 tag 与祖先（depth=层号），按 depth 降序克隆、用 clonedShadowNodes 替换孩子，最后提交根 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerUpdateShadowTree.cpp:97-226` | 每个节点只克隆一次 |
| **UIM-20** | `updateShadowTree` 用 `findComponentDescriptorByHandle_DO_NOT_USE_THIS_IS_BROKEN` 查 descriptor；日志拼写「Child no longer exits」；commit 状态完全忽略；delegate 在过滤前收到完整 map | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerUpdateShadowTree.cpp:93-95`、`:170-173`、`:194-198`、`:217-225` | 名字自带「broken」警告 |
| **UIM-21** | `updateShadowTree` 的 commit 事务忽略传入旧根、直接返回 BFS 前预构建的克隆；`ShadowTree::commit` 只比较 revision 号不检查派生关系，并发提交会被静默覆盖；options 为 `{}`（source=Unknown/stateReconciliation=false），提交后不更新 consistency manager | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerUpdateShadowTree.cpp:104`、`:217-222`、`packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.cpp:427-433`、`ShadowTree.h:59-73` | 只适合无并发 commit 的树 |
| **UIM-22** | binding 仅在全局 `nativeFabricUIManager` 为 undefined 时安装；安装线程设置 thread_local 的 runtime shadow-node 引用开关；getBinding 无 binding 返回 nullptr，类型错误抛 JSI | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:26-61`、`packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:28-32` | 已有值不覆盖、不校验 |
| **UIM-23** | binding 恰好 35 个方法名（含 4 个 priority 常量），未知成员返回 undefined 不抛错；`eventHandler_` 单槽覆盖式注册、无注销，注册前的事件被 `if (eventHandler_)` 静默丢弃 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:230`、`:499-518`、`:165`、`UIManagerBinding.h:86` | 拼错 API 名静默得到 undefined |
| **UIM-24** | `validateArgumentCount` 只查 `actual < expected`；两个 clone 方法因 `passChildrenWhenCloningPersistedNodes` 校验被注释，零参调用会越界读 `arguments[0]`；无类型检查 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:179-190`、`:338-340`、`:391-393` | 多传参数一律忽略 |
| **UIM-25** | pointer 事件从 `instanceHandle.stateNode.node` 反查 shadow node 后进 `PointerEventsProcessor`；target 为空静默丢弃，非 pointer 事件直接 `dispatchEventToJS` | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:71-115`、`PointerEventsProcessor.cpp:15-41` | pointer 无 JS 兜底路径 |
| **UIM-26** | `dispatchEventToJS` 在 instanceHandle 为空时只 `LOG_EVERY_N` 说 dropped 却没有 return，仍用 null 调 handler；`currentEventPriority_` 无初值、调用抛异常时复位被跳过、嵌套派发无法恢复外层优先级 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:149-172`、`UIManagerBinding.h:88`、`packages/react-native/ReactCommon/react/renderer/core/ReactEventPriority.h:18` | 注释与实现不一致 |
| **UIM-27** | `findNodeAtPoint` 手写 `EventEmitter::DispatchMutex().lock()/unlock()`（`std::mutex` 非递归），跨 retain/getInstanceHandle/release 无 RAII，异常即永久锁死；直接读公有 `eventTarget_` | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:310-322`、`packages/react-native/ReactCommon/react/renderer/core/EventEmitter.h:41` | 持锁进入 JS |
| **UIM-28** | `invalidate()` 只把 UIManager 的 delegate 置空，不清 `eventHandler_`、不清 pointer 状态、不释放 `uiManager_`；头文件把调用后行为定义为 UB | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:175-177`、`UIManagerBinding.h:55-62` | 调用方自律 |
| **UIM-29** | 六个几何查询全部走 consistency provider 的 `getCurrentRevision` + `dom::*`；空 revision 分别返回 onFail / 六零 / 四零 / undefined / 0 / 零对象 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:599-726`、`:827-953` | 六种空值形状 |
| **UIM-30** | `startViewTransition` 手搓 ready/finished 两个 Promise，mutation/onReady 必须同步调用，onComplete 经 `runtimeExecutor_` 回 JS 线程，delegate 裸指针按值捕获 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp:1121-1227` | 异步契约写在注释里 |
| **UIM-31** | capture 在 `buttons==0` 或 pointer 未注册时静默失败；release/has 只查 pending 表、按 tag 匹配；capture 表是 weak_ptr 懒清理；lost/got 用 Discrete，且 `shouldEmitPointerEvent` 不识别这两个 type → 门禁恒真 | `packages/react-native/ReactCommon/react/renderer/uimanager/PointerEventsProcessor.cpp:121-138`、`:144-204`、`:289-334`、`:375-426` | capture 事件总会派发 |
| **UIM-32** | `interceptPointerEvent` 固定顺序：processPending → retarget → topClick 直通 → down/move → leave(null)/其他 hover+shouldEmit → cancel/up 再 hover(null) → 隐式 release+再结算 → 注销 active | `packages/react-native/ReactCommon/react/renderer/uimanager/PointerEventsProcessor.cpp:206-287` | leave 事件由状态机合成 |
| **UIM-33** | `retargetPointerEvent` 无判空（TODO 自问）解引用 `getNewestCloneOfShadowNode` 的返回值；107/400/411/260 四个解引用点都不判空；hover 的 `getLatestNode` 返回局部 shared_ptr 的 `.get()` | `packages/react-native/ReactCommon/react/renderer/uimanager/PointerEventsProcessor.cpp:92-119`、`:397-417`、`PointerHoverTracker.cpp:123-131` | 节点被移出树即崩溃链 |
| **UIM-34** | hover 差分从根用 sameFamily 找分叉，注释假设节点不会 reparent；leave 收集后按 target→root 反向发、enter 按 root→target 正序发，capture 监听沿路径继承；target 为空时 erase 该 pointer 的 tracker | `packages/react-native/ReactCommon/react/renderer/uimanager/PointerHoverTracker.cpp:64-109`、`PointerEventsProcessor.cpp:460-543` | reparent 会产生虚假 leave/enter |
| **UIM-35** | `LayoutEventEmitter` 在 commit hook 里只处理 props 动态类型为 ViewProps 且 `onLayout` 非空的节点，调 `BaseViewEventEmitter::onLayout`；这段逻辑原在 ShadowTree | `packages/react-native/ReactCommon/react/renderer/uimanager/LayoutEventEmitter.cpp:16-36`、`LayoutEventEmitter.h:19-20` | Text/Image 不发 onLayout |
| **UIM-36** | `AppRegistryBinding` 通过 `RN$AppRegistry.runApplication/setSurfaceProps` 与 `RN$stopSurface` 调 JS，fabric 写死 true、displayMode 转整数，全局缺失抛 runtime_error；setSurfaceProps 的 TraceSection 误标为 UIManagerBinding | `packages/react-native/ReactCommon/react/renderer/uimanager/AppRegistryBinding.cpp:14-86` | 异常在 JS 线程抛出 |
| **UIM-37** | `valueFromShadowNode` 用 NativeState 包装并可选设置 runtime reference；列表转换空数组新建空 vector、不复用 `emptySharedShadowNodeSharedList` 且多一个孤立分号；weak→strong 任一过期返回 nullptr | `packages/react-native/ReactCommon/react/renderer/uimanager/primitives.h:37-121` | 空数组语义不一致 |
| **UIM-38** | `instanceHandleFromValue` 先 assert 非空再判空返回 nullptr（debug abort / release 静默）；tag/surfaceId 直接 double 截断；displayMode 映射 1/2/3 + assert + -1 | `packages/react-native/ReactCommon/react/renderer/uimanager/primitives.h:123-158` | 无范围检查 |
| **UIM-39** | uimanager 与 consistency 各自 glob `*.cpp` 建 OBJECT 库，主库链接 consistency/mounting/runtimescheduler 等；编译选项含 `-Wno-unused-local-typedef` 与 `-Wpedantic`；`SurfaceRegistryBinding.h` 只是 `#warning` 别名，全仓 0 处 include | `packages/react-native/ReactCommon/react/renderer/uimanager/CMakeLists.txt:11-41`、`consistency/CMakeLists.txt:11-23`、`SurfaceRegistryBinding.h:10-12` | shim 的 warning 不会响 |

> **与 12 文档的分工**：`consistency/` 的 `lockRevisions` / `unlockRevisions` / 惰性快照语义已在
> [12 文档](./12-UI一致性与ShadowTree修订版.md)（MEM-1…MEM-5）完整覆盖，本文只补了两条增量：
> `UIManager` 的两个一致性 getter 返回同一对象（UIM-1），以及 `completeSurface` 仅在 commit
> `Succeeded` 时调用 `updateCurrentRevision`（UIM-7）。

