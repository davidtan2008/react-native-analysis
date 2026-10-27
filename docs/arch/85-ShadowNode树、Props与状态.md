---
id: 85
title: "渲染器核心（上）：ShadowNode 树、Props 解析与状态机"
topic: RN.model
symptoms: [crash, prop, memleak]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["ShadowNode", "ShadowNodeFamily", "ShadowNodeFragment", "ShadowNodeTraits", "ComponentDescriptor", "ConcreteComponentDescriptor", "ConcreteShadowNode", "ConcreteState", "Props", "RawProps", "RawPropsParser", "RawPropsKeyMap", "RawValue", "DynamicPropsUtilities", "State", "StateData", "StateUpdate", "Sealable", "InstanceHandle", "ReactPrimitives", "getNextRootViewTag"]
sourceRoot: react-native
claims: [CORE-1, CORE-2, CORE-3, CORE-4, CORE-5, CORE-6, CORE-7, CORE-8, CORE-9, CORE-10, CORE-11, CORE-12, CORE-13, CORE-14, CORE-15, CORE-16, CORE-17, CORE-18, CORE-19, CORE-20, CORE-21, CORE-22, CORE-23, CORE-24, CORE-25, CORE-26, CORE-27, CORE-28, CORE-29, CORE-30, CORE-31, CORE-32, CORE-33, CORE-34, CORE-35, CORE-36]
---
# 85 · 渲染器核心（上）：ShadowNode 树、Props 解析与状态机

> **模块**：A1 · `packages/react-native/ReactCommon/react/renderer/core/`
> 本文覆盖该目录的 **45 个**非测试代码文件 / **5,003** 行。
> 同目录的 **37 个**布局/事件文件 / **3,265** 行见 [`86-布局几何与事件管线.md`](./86-布局几何与事件管线.md)；
> `tests/` 下 15 个文件 / 3,844 行不计入本文，也不计入 manifest 的 `readFiles`。
>
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根）
>
> **与既有文档的分工**：07 讲组件层的「Props/Descriptor/State 四件套」概念，09 讲 ShadowNode
> 不可变模型与差分，84 讲 UIManager 如何调用这些设施。本文不再重复概念，而是按文件**整块通读**
> 后记录 07/09/84 没有展开的**生命周期、锁、解析器状态机与具体缺陷**。

---

## 1. 文件构成（45 文件 / 5,003 行）

| 类别 | 文件数 | 行数 | 主要内容 |
| --- | ---: | ---: | --- |
| 树与 family | 8 | 1,440 | `ShadowNode` 的构造/克隆/COW、`ShadowNodeFamily` 的祖先链与 State、Fragment、Traits |
| 组件描述符 | 5 | 749 | `ComponentDescriptor` 抽象、`ConcreteComponentDescriptor`、`ConcreteShadowNode`、`ConcreteState` |
| Props 与解析器 | 17 | 2,076 | `Props`、`RawProps`、`RawValue`、`RawPropsParser`、`RawPropsKeyMap`、动态 props 工具、转换器 |
| State | 6 | 260 | `State` 的 revision/obsolete、`StateData`、`StateUpdate`、`StatePipe` |
| 其它 | 9 | 478 | `Sealable`、`InstanceHandle`、原语、根视图 tag、C++ stable API umbrella |

这里先给出一张总表；后续各节按这张表的顺序展开。**行号是本文写作时实测的
`wc -l` 值**，不是估算。

---

## 2. 不可变树的三个层次

### 2.1 Node、Family、Fragment 各管什么

Fabric 的节点不是「一个可变对象 + 一把锁」，而是三个对象分工：

| 对象 | 生命周期 | 持有什么 | 谁负责改 |
| --- | --- | --- | --- |
| `ShadowNode` | 每次提交产生新副本 | `props_`、`children_`、`state_`、`traits_`、`family_` | 只能通过 clone/构造生成，节点本身 `const` |
| `ShadowNodeFamily` | 跨多次提交稳定 | tag、surfaceId、descriptor 引用、eventEmitter、mostRecentState、parent weak | UIManager 创建一次；State 提交时更新 mostRecentState |
| `ShadowNodeFragment` | 调用期间的参数包 | 三个 `const&`（props/children/state）+ 一个 bool | 不拥有、不复制、不延长生命周期 |

`ShadowNode` 明确禁止拷贝（`ShadowNode(const ShadowNode&) = delete`），但允许通过
`clone()`/拷贝构造函数生成新节点。`ShadowNodeWrapper` 是 JS 侧 `NativeState`，内部持有
`shared_ptr<const ShadowNode>`，因此 JS 拿到的是**某一版的快照**，不是可变句柄。

**CORE-1**：`emptySharedShadowNodeSharedList()` 返回函数内 `static` 的空 vector，所有没有孩子的节点
共享同一个 vector 对象；构造/克隆只复制 `shared_ptr`，不复制元素。节点不可拷贝，但可以 clone。
`ShadowNodeWrapper` 的析构函数在 cpp 中显式定义为 key function，目的是让跨动态库的 RTTI 正常工作。

```cpp
// packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:39-44
std::shared_ptr<const std::vector<std::shared_ptr<const ShadowNode>>>
ShadowNode::emptySharedShadowNodeSharedList() {
  static const auto emptySharedShadowNodeSharedList =
      std::make_shared<std::vector<std::shared_ptr<const ShadowNode>>>();
  return emptySharedShadowNodeSharedList;
}
```

### 2.2 构造函数：所有节点都先被标记为「孩子共享」

两个构造函数（首次创建、从源节点克隆）都在末尾无条件执行
`traits_.set(ShadowNodeTraits::Trait::ChildrenAreShared)`。这不是「检测到共享才设置」，
而是**保守地假设共享**：即使 `fragment.children` 是一个刚刚 `make_shared` 出来的独享 vector，
第一次 `appendChild` 仍然会先走 `cloneChildrenIfShared()` 复制一遍。

`cloneChildrenIfShared()` 只在 trait 存在时复制，复制后立即 `unset`；因此每个节点最多为
「第一次修改孩子」付一次 vector 拷贝。这个设计的代价是首次修改必拷贝，收益是克隆路径完全不拷贝。

首次构造还会做三件事：

1. 断言 `props_` 与 `children_` 非空；
2. 把每个孩子的 `family_->setParent(family_)` 指向自己；
3. 调用 `family_->setMostRecentState(state_)`，把首节点的 state 提交到 family。

克隆构造**不做第 3 步**（除非 fragment 显式带 state）；它只继承源节点的 `state_`，不会把
继承来的 state 再提交一次。这是 State 版本能保持线性的关键：只有真正的新 state 才推进 family。

**CORE-2**：首次构造会把 fragment 的 state 提交为 family 的 mostRecentState；克隆构造不会。
两个构造函数都会无条件设置 `ChildrenAreShared`，并在 fragment 提供 children 时重新挂 parent。

### 2.3 COW 的边界：Node 不可变，但 children vector 可被原地改

`appendChild`/`replaceChild` 都是 `const` 节点上的「受控突变」：先 `ensureUnsealed()`，
再 `cloneChildrenIfShared()`，然后 `const_cast` 掉 `children_` 的 const 并原地改 vector。
这在 Debug 下由 `Sealable` 的 sealed 标志保护，在 Release 下 `ensureUnsealed()` 是空操作
（见 CORE-34），所以「不可变」在 Release 里主要靠调用约定，而不是运行时检查。

`appendChild` 的顺序是：先改 vector，再 `setParent`，最后 `propagateUncullableTraitsFromChildren()`。
`replaceChild` 的顺序不同，也因此留下了一个明确的早退缺陷（下一节）。

---

## 3. clone：nativeProps 的两种命运与一次 const_cast

### 3.1 `propsForClonedShadowNode`：只在 Android 的可序列化状态路径合并

克隆时 props 的来源由 `propsForClonedShadowNode(source, props)` 决定。它的完整逻辑是：

- 仅在 `RN_SERIALIZABLE_STATE` 编译宏下进入合并分支；
- 源节点**从未挂载**（`hasBeenMounted_ == false`）；
- 源节点的 `props->rawProps` 非空；
- 调用方确实提供了新 `props`（非空）。

四个条件同时满足时，它把新 `props` `const_cast` 成可写引用，再把
`source.rawProps` 与 `props->rawProps` 合并，策略是 `NullValueStrategy::Override`——
**新 props 的值覆盖旧值**。否则直接返回 `props`（若为空则退回 `source.getProps()`）。

这里有两个容易忽略的事实：

1. `const_cast` 后改的是**调用方传进来的那个 Props 对象**，不是副本。若这个 `Props::Shared`
   同时被别的节点持有，`rawProps` 会被一起改掉。代码没有 clone，也没有检查 `use_count()`。
2. 合并只发生在「源节点未挂载」时。一旦挂载过，旧 rawProps 不再合并，克隆只保留新 props。
   这与 Android Background Executor 的 Props 1.5 兼容逻辑有关，不是通用语义。

**CORE-3**：`propsForClonedShadowNode` 是 `RN_SERIALIZABLE_STATE` 下的 Android 兼容分支；
条件为「未挂载 + 源 rawProps 非空 + 新 props 非空」，合并方向是 source→new、Override（新值胜）；
实现用 `const_cast` 原地改传入的 Props，可能污染共享对象。

### 3.2 `clone()`：nativeProps 只在 fragment.props 是占位符时生效

`ShadowNode::clone(fragment)` 先从 family 取出 `componentDescriptor`，再在
`family.nativePropsMutex` 下检查 `nativeProps_DEPRECATED`：

- 若存在且 `fragment.props == propsPlaceholder()`：把 nativeProps 复制到
  `std::optional<RawProps> propsOverride`，锁外调用 `cloneProps` 解析；
- 若存在但 `fragment.props` 是显式 props：什么都不做，只留一句
  `// TODO: We might need to merge fragment.props with nativeProps_DEPRECATED.`；
- 解析结果在锁外完成，避免把 Props 解析放进 family 锁。

因此「显式传了新 props 的 clone」会**静默丢掉**之前 `setNativeProps` 的值；只有不传 props 的
clone 才会把 nativeProps 叠加到旧 props 上。这个优先级与 UIManager 的 `cloneNode` 正好相反：
`cloneNode` 先 rawProps→nativeProps（Ignore），再 nativeProps→rawProps（Override），最终
nativeProps 胜（见 doc 84 的 UIM-3）。两条路径都叫「clone」，但合并方向不同。

**CORE-4**：`clone()` 只在 `fragment.props` 等于占位符时解析 `nativeProps_DEPRECATED`；
显式传 props 时 nativeProps 被忽略（TODO 未实现）。nativeProps 的解析在 family 锁外执行。

### 3.3 `replaceChild`：成功分支跳过了 uncullable trait 传播

`replaceChild` 先 `ensureUnsealed`、`cloneChildrenIfShared`，然后**在查找旧孩子之前**就执行
`newChild->family_->setParent(family_)`。接下来有两条成功路径：

- `suggestedIndex` 命中：`children[suggestedIndex] = newChild; return;`
- 线性扫描命中：`children[index] = newChild; return;`

两条都在 `return` 之前没有调用 `propagateUncullableTraitsFromChildren()`。只有「旧孩子没找到」
这条失败路径才会走到 `react_native_assert(false)`，再调用传播函数。

结果是：替换孩子后，父节点的 `Unstable_uncullableTrace` 可能残留旧值（旧孩子不可裁剪、新孩子
可裁剪时不会清除），也可能漏设新值（新孩子不可裁剪时不会设置）。而失败路径反而会传播一次，
但此时 `newChild` 已经被 `setParent` 指向父节点——它并没有真的成为孩子，family 的 parent 链
却已经改了。这是「成功不传播、失败改 parent」的双重不对称。

**CORE-5**：`replaceChild` 的两个成功分支都在 trait 传播之前 `return`；只有「孩子未找到」的
失败路径执行传播。且 `newChild->family_->setParent(family_)` 在查找前执行，失败时也会留下
错误的 parent 链。

### 3.4 `cloneTree`：copy 一份 children 再逐层 clone

`cloneTree(family, callback)` 先 `family.getAncestors(*this)`。空表示两者不在同一棵树，直接返回
`nullptr`。然后取 ancestors 的最后一对（被测节点的父节点 + 下标），对旧孩子调用 `callback`，
再沿 ancestors 反向逐层 clone。

每一层都用 `auto children = parentNode.getChildren();` **复制整个 vector**（不是引用），
替换目标下标，再把新 vector 放进 fragment 的 `.children`。这样每层都产生一个新 vector，
但未修改的兄弟节点仍是同一个 `shared_ptr`，符合结构共享。

两个只在 Debug 生效的检查：

- `callback` 返回 `nullptr` 时 `react_native_assert`；Release 下继续把空指针放进 `childNode`，
  下一轮 `sameFamily(*children.at(...), *childNode)` 会解引用空指针。
- 每层断言 `sameFamily(*children.at(childIndex), *childNode)`；Release 下不检查。

**CORE-9**：`cloneTree` 对每层 children 做一次 vector 拷贝（元素共享），沿 ancestors 反向 clone；
callback 返回空指针、family 不匹配都只有 Debug 断言，Release 下会继续解引用。

### 3.5 `cloneMultiple`：根本身不在计数表里

`cloneMultiple` 先建立 `unordered_map<Tag, int> childrenCount`。对每个待更新 family：

1. 若 map 已有该 tag，跳过；
2. 以 `family->parent_.lock()` 为起点向上走，每遇到一个祖先就在 map 中加 1；若遇到已在 map
   中的祖先，加 1 后 break；
3. 若最终 `ancestor == family_`（即走到了本次 clone 的根），把根的计数再加 1。

最后检查 `childrenCount.contains(getTag())`；不包含就返回 `nullptr`。

**关键缺口**：如果 `familiesToUpdate` 里包含根本身，循环从 `family->parent_` 开始，根不会在
第 2 步被计数；循环结束后 `ancestor` 是根的 parent（通常为空），不等于 `family_`，所以第 3 步
也不会加根。`childrenCount` 不含根 tag，函数直接返回 `nullptr`。也就是说
**`cloneMultiple` 不能替换根节点自己**，只能替换根的后代。

递归函数 `cloneMultipleRecursive` 用 `childrenCount.at(shadowNode.getTag())` 取当前节点的待替换
孩子数；只有 count>0 且孩子 tag 在 map 中才复制 children vector 并递归。回调对路径上的每个
节点都会调用一次（即使 count 为 0），count 为 0 时 `newChildren` 为空，fragment 的 children
为空，clone 会保留源 children。

**CORE-10**：`cloneMultiple` 的计数从待更新 family 的 parent 开始；若 family 就是根，根 tag 不会
进入 `childrenCount`，函数返回 `nullptr`。因此它只能替换根的后代，不能替换根本身。

---

## 4. Family：身份、祖先链与 State 的线性推进

### 4.1 Family 缓存 handle/name，但保留 descriptor 的裸引用

`ShadowNodeFamily` 构造时从 descriptor 取 `componentHandle_`、`componentName_`、`surfaceId_`
并缓存；头文件注释明确说缓存的原因是 **descriptor 可能已经先被释放**。但 family 同时持有
`const ComponentDescriptor& componentDescriptor_`——如果 descriptor 真被释放，这个引用就是悬空的。
实际生命周期由 ComponentDescriptorRegistry 保证：descriptor 比所有 family 活得久。缓存只保证
取 handle/name 时不访问 descriptor，不保证 descriptor 本身可以提前销毁。

`setParent` 先断言「现有 parent 为空或等于新 parent」，然后 `if (hasParent_) return;`，
最后写 `parent_`（weak）并置位。注释说「不是严格线程安全，但实际只 mutate 一次，模型保证第一次
调用不并发」。`parent_` 是 weak，避免 child family 反向 retain 父 family。

family 析构时，只有 `!hasBeenMounted_` 且注册了回调才调用
`onUnmountedFamilyDestroyedCallback_`。也就是说「预分配但从未上屏」的 family 才有这个回调；
挂载过的 family 销毁时不再通知。

**CORE-11**：Family 缓存 descriptor 的 handle/name（防止取名字时 descriptor 已释放），但仍持有
descriptor 的裸引用；`setParent` 用断言 + `hasParent_` 早退，parent 是 weak；析构回调只对
「从未挂载」的 family 触发。

### 4.2 `getAncestors`：注释说 O(ln n)，实现是 O(depth × siblings)

头文件注释写「理论复杂度 O(ln n)，请谨慎使用」，并且说「可以从任意线程调用」。实现分两段：

1. 从 `this` 沿 `parent_.lock()` 向上，直到遇到 `ancestorShadowNode.family_`，得到 family 链；
   中途遇到空或走到别的根，返回空。
2. 从 `ancestorShadowNode` 开始，对 family 链反向逐层在 `parentNode->children_` 里**线性扫描**
   找到对应 child，记录 `(parent, childIndex)`。

因此实际复杂度是 `O(depth × 平均孩子数)`，不是 O(ln n)。第二步直接读 `children_`，没有加锁，
也没有持有 child 的 `shared_ptr`；如果在别的线程同时替换孩子，返回的 `(parent, index)` 可能指向
已经变化的 vector。注释的「可以从任意线程调用」只在树不再变更时成立。

**CORE-12**：`getAncestors` 先沿 weak parent 链收集 family，再逐层线性扫描 `children_` 找下标；
实际复杂度 O(depth × siblings)，且读取 children 无锁，不是注释宣称的 O(ln n)/任意线程安全。

### 4.3 `setMostRecentState`：obsolete 是单向门，null 也能提交

family 的 state 更新全部走 `std::shared_mutex mutex_`，但 `getMostRecentState` 和
`setMostRecentState` 都用 `std::unique_lock`——读也独占，所有 state 查询被串行化。代码里没有
任何 `shared_lock` 使用点。

`setMostRecentState(state)` 的规则：

- `state` 非空且 `state->isObsolete_` 为真：忽略（不允许把已淘汰的旧 state 重新装回去）；
- `state` 与当前 `mostRecentState_` 相同：忽略；
- 否则，若已有旧 state，把旧 state 的 `isObsolete_` 置真；
- 最后 `mostRecentState_ = state`，**允许 state 为空**。

因此 `setMostRecentState(nullptr)` 会清空 family 的 state，并把旧 state 标记为 obsolete。
`getMostRecentStateIfObsolete(state)` 只在传入 state 已 obsolete 时返回当前 mostRecentState；
后者也可能是空。`State::getMostRecentState()` 通过 weak family 取，family 已销毁时返回空。

**CORE-13**：family state 用 `shared_mutex` 的 `unique_lock` 读写（读也独占）；obsolete state
不能被重新提交；`setMostRecentState(nullptr)` 合法且会把旧 state 标 obsolete；
`getMostRecentStateIfObsolete` 的返回值可能为空。

### 4.4 `dispatchRawState`：dispatcher 过期就静默丢更新

`dispatchRawState` 只做一件事：`eventDispatcher_.lock()`；失败直接 `return`，成功才调用
`dispatchStateUpdate(std::move(stateUpdate), updateMode)`，没有任何日志或错误回调。
state 更新在 surface 已经停止、dispatcher 已销毁时会被安静丢弃，调用方无法从返回值区分
「已入队」和「已丢弃」。

**CORE-14**：`ShadowNodeFamily::dispatchRawState` 在 weak dispatcher 过期时静默返回；
State 更新没有成功/失败反馈。

---

## 5. Fragment、Traits 与运行时引用

### 5.1 Fragment 的四个字段：三个引用、一个 bool

`ShadowNodeFragment` 的字段是：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/ShadowNodeFragment.h:27-31
const Props::Shared &props = propsPlaceholder();
const std::shared_ptr<const std::vector<std::shared_ptr<const ShadowNode>>> &children = childrenPlaceholder();
const State::Shared &state = statePlaceholder();
const bool runtimeShadowNodeReference = true;
```

前三个是 `const&`，Fragment 不拥有、不复制、不延长生命周期；调用方必须保证被引用对象在
Fragment 使用期间存活。三个 placeholder 都是函数内 `static` 空对象，并用 Clang 的
`[[clang::no_destroy]]` 阻止进程退出时析构（其他编译器上宏为空）。

`runtimeShadowNodeReference` 默认 true；它只影响 `transferRuntimeShadowNodeReference` 的两参
重载是否执行（见 5.3），不影响节点本身。

**CORE-15**：Fragment 的三个字段是 `const&` 占位符，不持有所有权；placeholder 是
`[[clang::no_destroy]]` 的函数内 static；`runtimeShadowNodeReference` 默认 true。

### 5.2 Traits：15 个具名位 + 一个「全部命中」的 check

`ShadowNodeTraits` 的 `Trait` 是 `int32_t` 位掩码，前 23 位保留给 Core。当前定义了 15 个具名
trait（`ViewKind` 到 `DirtyYogaNode`，位 0–14）和 `None = 0`。`check(traits)` 的语义是
**所有传入位都命中**才返回 true，不是「任意一位命中」：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/ShadowNodeTraits.h:111-113
inline bool check(Trait traits) const {
  return ShadowNodeTraits::Trait(traits_ & traits) == traits;
}
```

`set/unset` 直接做位运算，没有原子性；节点 clone 时 `traits_` 按值复制。`ChildrenAreShared`
由构造函数强制设置，`Unstable_uncullableTrace` 由父节点传播，`DirtyYogaNode` 已标记 deprecated。

**CORE-16**：Traits 是 32 位掩码，当前 15 个具名位（位 0–14），前 23 位保留；`check` 要求
全部位命中；`set/unset` 非原子，clone 时按值复制。

### 5.3 运行时引用：thread_local 开关与两次 transfer

`ShadowNode` 持有 `mutable std::weak_ptr<ShadowNodeWrapper> runtimeShadowNodeReference_`。
`transferRuntimeShadowNodeReference(destination)`（单参）无条件把 weak 指针赋给目标，并在
`updateRuntimeShadowNodeReferencesOnCommit` 和 `...Thread` 两个 feature flag 都为 false 时，
立即 `updateRuntimeShadowNodeReference(destination)`——也就是 lock 旧 wrapper 并把里面的
`shadowNode` 改成新节点。

两参重载多了一个条件：只有

- `updateRuntimeShadowNodeReferencesOnCommit()` 为真，或
- `updateRuntimeShadowNodeReferencesOnCommitThread()` 为真，或
- 当前线程的 `thread_local useRuntimeShadowNodeReferenceUpdateOnThread` 为真，

并且 `fragment.runtimeShadowNodeReference` 为 true，才调用单参版本。否则目标节点的 weak 指针
保持为空，JS wrapper 仍然指向旧节点；后续提交不会把 wrapper 重定向到新 clone。

**CORE-8**：运行时引用转移有「全局 commit flag / 当前线程 flag / fragment bool」三层门禁；
不满足时 clone 不继承 wrapper，JS 侧仍指向旧节点。单参 transfer 总是执行，并在两个全局 flag
都为 false 时立即更新 wrapper 内容。

### 5.4 `setMounted(false)` 不清除 `hasBeenMounted_`

`setMounted(bool mounted)` 的实现是：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:322-330
void ShadowNode::setMounted(bool mounted) const {
  if (mounted) {
    family_->setMostRecentState(getState());
    family_->setMounted();
    hasBeenMounted_ = mounted;
  }
  family_->eventEmitter_->setEnabled(mounted);
}
```

只有 `mounted == true` 分支会写 `hasBeenMounted_`；`false` 分支只关掉 eventEmitter。
因此一个节点一旦挂载过，`getHasBeenPromoted()` 永远返回 true，卸载不会把它复位。
这也意味着 `propsForClonedShadowNode` 里的「源节点未挂载」判断在卸载后仍然是 false，
旧 rawProps 不会因为卸载而重新参与合并。

另外，`setMounted` 直接调用 `family_->eventEmitter_->setEnabled(mounted)`，而
`EventEmitter::setEnabled` 的注释要求调用方持有 `EventEmitter::DispatchMutex()`；这里没有加锁。
调用方（mounting/UIManager）是否在更高层持锁，不在本文件的保证范围内。

**CORE-7**：`setMounted(false)` 只调用 `eventEmitter_->setEnabled(false)`，不清 `hasBeenMounted_`、
不更新 state；`hasBeenMounted_` 是「曾经挂载过」而不是「当前挂载」。该函数直接调
`setEnabled`，本文件内没有获取 `DispatchMutex`。

---

### 5.5 uncullable trait 的传播只有一个入口、两种结果

`appendChild` 与 `replaceChild` 的失败路径最后都调用
`propagateUncullableTraitsFromChildren()`。这个函数逻辑很直白：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:303-319
void ShadowNode::propagateUncullableTraitsFromChildren() {
  if (ReactNativeFeatureFlags::enableViewCulling()) {
    if (traits_.check(ShadowNodeTraits::Trait::Unstable_uncullableView)) {
      return;
    }
    for (const auto& child : *children_) {
      if (child->getTraits().check(ShadowNodeTraits::Trait::Unstable_uncullableView) ||
          child->getTraits().check(ShadowNodeTraits::Trait::Unstable_uncullableTrace)) {
        traits_.set(ShadowNodeTraits::Trait::Unstable_uncullableTrace);
        return;
      }
    }
    traits_.unset(ShadowNodeTraits::Trait::Unstable_uncullableTrace);
  }
}
```

四个要点：

1. 整个函数体在 `enableViewCulling()` 的 feature flag 门里，flag 关闭时什么都不做；
2. 传播的目标只有父节点自己的 `Unstable_uncullableTrace`，不是 `Unstable_uncullableView`
   ——也就是说「不可裁剪」标记只沿父链扩散一层，用来告诉裁剪算法「这个父节点有不可裁剪的
   子节点，不要裁剪它」，父节点本身仍然可以被裁剪；
3. 孩子有 `uncullableView` **或** `uncullableTrace` 都会命中；
4. 没有命中就把 `uncullableTrace` 清掉——这是一个**双向**传播，孩子变化后标记会撤销。
   这正好解释 CORE-5 的缺陷有多严重：成功 replace 只会留下旧标记，不会按新孩子重新计算。

**CORE-6**：uncullable 传播只有一个入口 `propagateUncullableTraitsFromChildren`，整个函数体
在 `enableViewCulling()` flag 门内；孩子带 `uncullableView` 或 `uncullableTrace` 都会把父节点
标记为 `uncullableTrace`，没有则清除（双向传播）。

---

## 6. ComponentDescriptor：抽象契约与两个模板实现

### 6.1 十个公开纯虚 + 一个受保护纯虚

`ComponentDescriptor` 把「组件类型」抽象成 10 个公开纯虚函数：

1. `getComponentHandle()`
2. `getComponentName()`
3. `getTraits()`
4. `createShadowNode(fragment, family)`
5. `cloneShadowNode(source, fragment)`
6. `appendChild(parent, child)`
7. `cloneProps(context, props, rawProps)`
8. `createInitialState(props, family)`
9. `createState(family, data)`
10. `createFamily(fragment)`

再加一个受保护的纯虚 `adopt(ShadowNode&)`，所以任何具体 descriptor 必须实现 11 个函数。
`adopt` 在 `createShadowNode` 和 `cloneShadowNode` 之后调用，用来把 manager/context 注入节点
（例如 Image 的 manager、Modal 的 size state）。

`ComponentDescriptorParameters` 只有三项：weak eventDispatcher、contextContainer、flavor。
`Flavor` 是 `shared_ptr<const void>`，注释说这是为旧渲染器互操作预留的、计划移除的能力。

**CORE-17**：`ComponentDescriptor` 有 10 个公开纯虚 + 1 个受保护纯虚 `adopt`；`adopt` 在
create/clone 之后调用；`Flavor` 是类型擦除的 `shared_ptr<const void>`，为旧渲染器互操作预留。

### 6.2 构造时是否 `prepare` 解析器，取决于编译期 concept 和运行时 flag

`ConcreteComponentDescriptor` 构造函数的核心是一个 `if constexpr`：

- 若 `ConcreteProps` 满足 `HasIteratorSetterCtor`，并且
  `ReactNativeFeatureFlags::enableCppPropsIteratorSetter()` 为 **false**，调用
  `rawPropsParser_.prepare<ConcreteProps>()`；
- 若满足 concept 但 flag 为 true，跳过 prepare；
- 若不满足 concept，无条件 prepare。

跳过的理由写在注释里：iterator-setter 路径只走 `RawProps::forEachItem` + `setProp`，不会调用
`RawProps::at()`，因此 `keys_`/`nameToIndex_` 完全用不到。反过来，一旦 flag 在运行时从 true
切回 false，同一个 descriptor 的 parser 没有 prepare，classic 路径会调用 `parse` + `at`，
此时 `keys_` 为空，`at` 的 do-while 会越界（见 CORE-30）。这个 flag 必须在 descriptor 构造前
定好，不能中途切换。

**CORE-18**：只有「Props 支持 iterator setter 且 flag 为 false」或「Props 不支持 iterator
setter」时构造期才 prepare 解析器；flag 为 true 时跳过。运行中把 flag 切回 false 会让未 prepare
的 parser 进入 `at` 的越界路径。

### 6.3 `cloneProps` 的两条路径与一个默认 props 快路径

`cloneProps` 先做空输入优化：`!props && rawProps.isEmpty()` 直接返回
`ShadowNodeT::defaultSharedProps()`——每个 Props 类型的函数内 static 默认对象。

然后（若类型满足 `RawPropsFilterable`）调用 `filterRawProps(rawProps)`，再按两条路径构造：

- **iterator setter**（concept 满足且 flag 开）：`shadowNodeProps = Props(props)` 拷贝基类，
  然后 `rawProps.forEachItem` 对每个字段调用 `setProp(context, hash, name, value)`。
- **classic**（其它情况）：`rawProps.parse(rawPropsParser_)`，再调用
  `PropsT(context, rawProps, props)` 逐字段 `convertRawProp`。

在 `RN_SERIALIZABLE_STATE` 下还有一段 Props 1.5/2.0 的兼容逻辑：如果
`enableExclusivePropsUpdateAndroid()` 和 `enableAccumulatedUpdatesInRawPropsAndroid()` 都开，
并且 `enablePropsUpdateReconciliationAndroid()` 也开，且 `Props::getDiffPropsImplementationTarget()`
与组件名相同，就跳过 `initializeDynamicProps`；否则把 rawProps 合并进 `props->rawProps`。

**CORE-19**：`cloneProps` 的空 props+空 rawProps 快路径返回进程级默认 Props；iterator setter
路径 copy 基类后逐项 `setProp`，classic 路径 parse 后逐字段转换；两条路径的 `rawProps` 消费方式
不同（前者不 parse，后者必须 parse）。

### 6.4 `createState` 的空指针与 `createFamily` 的空 instanceHandle

`createInitialState` 对 `StateData` 类型直接返回 `nullptr`（该组件无 state）；否则用
`ConcreteShadowNode::initialStateData(props, family, *this)` 构造初始 State。

`createState` 对 `StateData` 返回 `nullptr`；否则：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/ConcreteComponentDescriptor.h:201-205
react_native_assert(data && "Provided `data` is nullptr.");
return std::make_shared<const ConcreteState>(
    std::static_pointer_cast<const ConcreteStateData>(data),
    *family.getMostRecentState());
```

`react_native_assert` 在 Release 下是空操作；`family.getMostRecentState()` 可能返回空
（family 还没有提交过 state，或刚被 `setMostRecentState(nullptr)` 清空），此时
`*family.getMostRecentState()` 直接解引用空 shared_ptr，是未定义行为。

`createFamily` 则无条件用 `fragment.instanceHandle` 构造 `EventTarget`：
`std::make_shared<EventTarget>(fragment.instanceHandle, fragment.surfaceId)`。
`InstanceHandle::Shared` 允许为空，EventTarget 构造函数也不判空；后续 `retain()`/`getTag()`
会解引用它（见 doc 86 的 EVT-3）。

**CORE-20**：`createState` 对非默认 StateData 直接解引用 `*family.getMostRecentState()`，该指针
可能为空；`createFamily` 允许把空 `fragment.instanceHandle` 传给 EventTarget，构造阶段不报错，
后续 retain/getTag 才崩。

---

## 7. State 体系：ConcreteShadowNode / ConcreteState / State

### 7.1 ConcreteShadowNode：两个「断言后继续」的访问器

`ConcreteShadowNode` 提供两个直接访问 state 的方法：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/ConcreteShadowNode.h:163-167
const ConcreteStateData &getStateData() const {
  react_native_assert(state_ && "State must not be `nullptr`.");
  return static_cast<const ConcreteState *>(state_.get())->getData();
}
```

`react_native_assert` 在 Release 下是空操作（`ShadowNode.cpp:231-243` 的 `sealRecursive` 之外，
这是本文件第二处「断言后继续」）。`getStateData()` 在 `state_` 为空时直接 `->getData()`，
是确定性的未定义行为。`setStateData()` 也要 `Sealable::ensureUnsealed()` 之后再写
`state_ = std::make_shared<const ConcreteState>(..., *state_)`，此时 `*state_` 还是旧值——
它靠旧值拿到 `family_` 和 `revision_`，这些不会为空（首次构造时节点至少带上
`fragment.state`，即使是空也是通过 `ShadowNodeFragment::statePlaceholder()` 返回的 null
`State::Shared`，注意这是**指向空 State 对象的 shared_ptr**，不是空 shared_ptr）。

换句话说，`getStateData()` 崩溃的前提是「整个 State 是空的 Shared」，而这个场景在
ConcreteComponentDescriptor 的描述符工厂（CORE-20）里确实会出现：组件没有 state，
`family.getMostRecentState()` 返回空的 `State::Shared`，`createState` 再把它解引用。

**CORE-21**：`ConcreteShadowNode::getStateData()` 对 `state_` 只做 Debug 断言后继续；
`setStateData` 则依赖旧 `*state_` 非空（拿 `family_`/`revision_`）。两者都没有运行时保护。

### 7.2 ConcreteState::updateState：回调可能被调用多次

`ConcreteState::updateState(function)` 把「旧数据 → 新数据」的回调封装进 `StateUpdate`，然后
`family->dispatchRawState(std::move(stateUpdate), updateMode)`。family 不存在时直接 return
（静默丢掉，和 CORE-14 相同）。注释明确说：

> In case of a conflict, the `callback` might be called several times until it succeeded.
> To cancel the state update operation, the callback needs to return `nullptr`.

也就是说回调有**重试语义**：UIManager 在提交冲突时可能用旧 state 重新调用 callback；回调返回
`std::nullptr_t`（空 SharedData）表示放弃这次更新。`updateState(Data&&)` 重载则把值捕获进
lambda，回调参数被忽略，等价于「无冲突地写死新值」。

**CORE-22**：`ConcreteState::updateState(function)` 的回调可能被调用多次（冲突重试），
返回空 SharedData 取消；family weak 失效时静默 return。`updateState(Data&&)` 重载直接捕获值，
不走冲突重试。

### 7.3 State：revision 从 1 开始单调递增，`isObsolete_` 是非常量可变位

`State` 的三个不变式：

- revision 初始为 `initialRevisionValue = 1`，每次从旧状态构造新状态时 `revision_ + 1`；
- `isObsolete_` 是 `mutable bool`，既不是 atomic 也不是 static，由 family 的 mutex 保护
  （注释写「Protected by mutex inside StateCoordinator」，实际保护者是 family `mutex_`）；
- family weak 失效后 `getMostRecentState()`/`getMostRecentStateIfObsolete()` 都返回空。

**CORE-23**：`State::revision_` 从 `initialRevisionValue = 1` 开始、每次 +1；
`isObsolete_` 是 `mutable bool`（注释声称由 StateCoordinator mutex 保护，实现里由
family 的 mutex_ 保护）；family 销毁后两个 getter 都返回空。

---

## 8. Props 基类与两个宏

### 8.1 Props 基类只有四个数据成员和一条虚接口

`Props` 的定义非常薄：

- 虚基：`public virtual Sealable, public virtual DebugStringConvertible`（都用了 `virtual`
  继承，因为组件的 Props 经常**多路径**继承 `Props` 虚基类，避免 Sealable 标志双份）；
- 数据：只有 `std::string nativeId`（所有组件共享）和两个 `#ifdef RN_SERIALIZABLE_STATE`
  下的成员：`folly::dynamic rawProps` 与两个虚函数 `getDiffProps/updateState`；
- 主构造函数签名 `Props(const PropsParserContext&, const Props &sourceProps,
  const RawProps&, filter)` 是所有组件 3 参构造的模板；默认 `filterObjectKeys` 为空。

**CORE-24**：`Props` 基类用 **virtual 继承** Sealable 与 DebugStringConvertible；
数据成员只有 `nativeId`（+ SERIALIZABLE 状态下 `rawProps`），没有 `ViewProps` 的字段；
`getDiffProps/ getDiffPropsImplementationTarget` 的默认实现返回空 dynamic / 空字符串，
组件必须自行覆盖才有「Props 2.0」行为。

### 8.2 PropsMacros：constexpr fnv1a 哈希 + 一处 try/catch

`CONSTEXPR_RAW_PROPS_KEY_HASH(s)` 展开成一个立即调用的 constexpr lambda，里面用
`facebook::react::fnv1a(s)` 做编译期字符串哈希（`RawPropsPropNameHash = uint32_t`），
并用 `CLANG_PRAGMA` 压制 `-Wshadow`。

`REBUILD_FIELD_SWITCH_CASE(defaults, rawValue, property, field, fieldName)` 是唯一带
`try { } catch (const std::exception&)` 的宏：它把 `fromRawValue` 的异常记 log，并把字段
reset 回默认值，避免一个字段炸掉整次 props 更新。

其它两个宏 `RAW_SET_PROP_SWITCH_CASE` 和 `CASE_STATEMENT_SET_FIELD_VALUE_INDEXED`
**没有** try/catch，异常会沿 Props 构造一路向上传到 `cloneProps` → `UIManager` →
JS 侧的 `errorHandler`。也就是说「一个字段解析失败会不会影响其它字段、会不会中断提交」
取决于这个字段用的是哪个宏。`rawValue.hasValue()` 为假时 `CASE_STATEMENT_...` 会把字段
reset 回 `decltype(struct) defaultValues{}` 的值；`RAW_SET_PROP_...` 没有这个分支（它假设
调用方在外层过滤 null）。

**CORE-25**：`PropsMacros.h` 里只有 `REBUILD_FIELD_SWITCH_CASE` 带 try/catch；
`RAW_SET_PROP_SWITCH_CASE` 与 `CASE_STATEMENT_SET_FIELD_VALUE_INDEXED` 不捕获异常；
后者额外提供「null → 默认值」分支，前者没有。哈希是编译期 fnv1a（uint32）。

---

## 9. RawValue：惰性 variant 与「只查一个元素」的 hasType

### 9.1 it is move-only，但拷贝构造是 **深拷贝** 而且是私有的

```cpp
// packages/react-native/ReactCommon/react/renderer/core/RawValue.h:86-114
private:
  friend class RawProps;
  friend class RawPropsParser;
  friend class UIManagerBinding;
  RawValue(const RawValue &other)             // ← private
  {
    if (std::holds_alternative<folly::dynamic>(other.value_)) {
      auto &dynamic = std::get<folly::dynamic>(other.value_);
      value_ = dynamic;
    } else {
      const auto &[runtime, value] = std::get<JsiValuePair>(other.value_);
      value_ = std::make_pair(runtime, jsi::Value(*runtime, value));
    }
  }
  RawValue &operator=(const RawValue &other)  // ← private
  { /* 同样深拷贝 */ }
```

也就是说 RawValue 的拷贝**不是**浅拷贝：JSI 路径走 `jsi::Value(*runtime, value)`——
在目标 runtime 里重新物化一次。拷贝构造是非公开接口，只有三个 friend
（RawProps / RawPropsParser / UIManagerBinding）能用。同时它有公开的
`RawValue(RawValue&&) noexcept` 移动构造（62 行）和移動赋值，所以在常规代码里 RawValue
表现为 move-only。

**CORE-26**：RawValue 的拷贝构造与拷贝赋值**是非公开的深拷贝**（JSI 路径会
`jsi::Value(*runtime, value)` 重新物化），只有 RawProps/RawPropsParser/UIManagerBinding 三个
friend 能用；公开接口只有移动构造/赋值，对外表现为 move-only。

### 9.2 `hasType<vector/map>` 只看第一个元素，空容器对任意 T 返回 true

这一条最值得记，因为它直接影响 `fromRawValue<vector<T>>` 的行为：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/RawValue.h:255-268
template <typename T>
static bool checkValueType(const folly::dynamic &dynamic, std::vector<T> *) noexcept {
  if (!dynamic.isArray()) return false;
  for (const auto &item : dynamic) {
    // Note: We test only one element.
    return checkValueType(item, (T *)nullptr);
  }
  return true;   // ← 空数组也返回 true，且**对任意 T**
}
```

三个事实：

- 循环第一次迭代就 return，**只有第一个元素**参与类型判断；`[1, "two"]` 的
  `hasType<std::vector<std::string>>()` 是 true。
- 空数组没有元素，直接落到 `return true`，**空数组对任何 T 都是 valid**（包括
  `hasType<std::vector<double>>()` 对 `[]` 返回 true，然后 `fromRawValue` 走空 vector 分支）。
- map 同样（294-306 行）。
- 两个不对称：JSI 路径 `hasType<JsiValuePair>`（250-253 行）恒 true；folly::dynamic 路径
  `hasType<JsiValuePair>`（245-248 行）恒 false。

后两个由 `packages/react-native/ReactCommon/react/renderer/core/propsConversions.h:123-141` 兜底：`fromRawValue<std::vector<T>>` 先用
`hasType<std::vector<RawValue>>()` 判断是不是数组；传入的 `T` 类型本身由
`fromRawValue(context, item, itemResult)` 逐元素转换，即使 `hasType<vector<string>>` 已经
误判，cast 阶段还会正确抛出/转换。

**CORE-27**：`hasType<std::vector<T>>` / `hasType<std::map<K,T>>` **只检查第一个元素**，
空容器对任意 T 都返回 true；`[1,2]` 的 `hasType<vector<string>>` 也为 true。
`hasType<JsiValuePair>` folio 动态路径恒 false、JSI 路径恒 true（不对称）。

---

## 10. RawProps 与解析器：三态模式、状态机与两个 release 陷阱

### 10.1 RawProps 是三态 variant，parse 只能做一次（Debug 才有断言）

`RawProps` 内部是 `enum class Mode { Empty, JSI, Dynamic }`（44 行）+ 一份
`jsi::Runtime*` / `jsi::Value` / `folly::dynamic`：

- J构造时 `value.isNull()` → `Mode::Empty`，否则 JSI；dynamic 构造同理只区分 null/非 null，
  **undefined / 非 object 的 JSI value 也会走 `Mode::JSI`**，等到 `asObject()` 时才抛异常；
- `RawProps::parse(parser)` 先 `react_native_assert(parser_ == nullptr && "A parser was
  already assigned.")` 再 `parser.preparse(*this)`——这个保护**只在 Debug 构造下生效**，
  Release 下同一个 RawProps 可以被 parse 两次（后果见 CORE-30）；
- 拷贝构造每个分支都**深拷贝**：JSI 走 `jsi::Value(*runtime_, other.value_)`，Dynamic 走
  `dynamic_` 拷贝；但 `keyIndexToValueIndex_`/`valueIndexCursor_` 等 preparse 后果**不被拷贝**。

**CORE-28**：`RawProps` 是 Empty/JSI/Dynamic 三态；jsi 构造只把 null 归入 Empty，
undefined/非 object 仍走 JSI（等 asObject 才报错）；`parse()` 的重复 parse 断言只在 Debug
生效；拷贝构造深拷贝 jsi/dynamic 但不拷贝 preparse 状态。

### 10.2 `forEachItem`：不依赖 parse、不验证 Object、string_view 只活到回调结束

```cpp
// packages/react-native/ReactCommon/react/renderer/core/RawProps.h:113-139
template <typename Fn>
void forEachItem(Fn fn) const {
  switch (mode_) {
    case Mode::Empty: return;
    case Mode::JSI: {
      auto object = value_.asObject(*runtime_);          // ← 没有 hasType 检查
      auto names  = object.getPropertyNames(*runtime_);
      ... 
      auto nameUtf8   = name.utf8(*runtime_);
      fn(std::string_view{nameUtf8}, RawValue{*runtime_, std::move(propValue)});
      return;
    }
    case Mode::Dynamic:
      for (const auto &pair : dynamic_.items()) {
        fn(std::string_view{pair.first.getString()}, RawValue{pair.second});
      }
      return;
  }
}
```

注释说「铁律：view 的生命周期 = 调用期间」。两个注意点：

1. `Mode::JSI` 直接 `value_.asObject()`，**没有先 `isType<Object>()`**；传入非 object 值时
   jsi 会抛 TypeError。构造函数没有把它挡住（CORE-28），所以这个异常也在这里才发生；
2. `string_view{nameUtf8}` 的底层是 `name.utf8()` 的 `std::string` 局部对象，
   **生命周期只在 callback 内**。CORE-19（iterator setter 路径）用它传
   `setProp(context, hash, name, value)`，没问题；但任何想把 name 存下缓存的用法都会悬空。

**CORE-29**：`RawProps::forEachItem` 不需要先 parse；JSI 路径直接 `value_.asObject()`，
没有对象判断；`Mode::Dynamic` 走 `dynamic_.items()`；回调拿到的 `std::string_view` 底层
只在回调体内有效，不能存指针。

### 10.3 RawPropsParser：禁用于「ready 前的 n² 去重」和「release 后的 index 游标」

```cpp
// packages/react-native/ReactCommon/react/renderer/core/RawPropsParser.cpp:20-89 (节选)
if (!ready_) [[unlikely]] {
  // Check against the same key being inserted more than once.
  // ... The complexity ... for size 100 this is 4950 lookups ...
  size_t size = keys_.size();
  for (size_t i = 0; i < size; i++) {
    if (keys_[i] == key) return nullptr;      // ← 在上牌（prepare）阶段做 O(n²) 去重
  }
  keys_.push_back(key);                        // ← 这件事在 Release 也照做
  react_native_assert(size < std::numeric_limits<RawPropsValueIndex>::max());  // ← Debug only
  nameToIndex_.insert(key, static_cast<RawPropsValueIndex>(size));
  return nullptr;
}
// ready_ 分支：cursor 增量 + 环形 while
do {
  rawProps.keyIndexCursor_++;
  if (static_cast<size_t>(rawProps.keyIndexCursor_) >= keys_.size()) [[unlikely]] {
    #ifdef REACT_NATIVE_DEBUG
    if (resetLoop) { LOG(ERROR) << "..."; return nullptr; }
    resetLoop = true;
    #endif
    rawProps.keyIndexCursor_ = 0;
  }
} while (key != keys_[rawProps.keyIndexCursor_]);
auto valueIndex = rawProps.keyIndexToValueIndex_[rawProps.keyIndexCursor_];
return valueIndex == kRawPropsValueIndexEmpty ? nullptr : &rawProps.values_[valueIndex];
```

这里有一整组「Debug-only 保护 + Release 直接崩」的组合拳：

- onboarding 阶段的 O(n²) 同名 key 去重是**运行时 size 上限断言**（骨 Debug only）。
  在 Release 下 `keys_` 可以被无限 push（既不截断也不报错）。这里 push 的是 `std::string_view`，
  底层通常是 `convertRawProp` 传进来的字符串字面量（如 `"nativeID"`），生命周期足够；
  但一切「非字面量」的 key（比如用前缀/后缀临时 `std::string` 拼出来的）一旦在 prepare 阶段
  传入 `at`，就会在 `keys_` 里留下悬空 view。
- ready 后 `do { keyIndexCursor_++ ... } while` 的关键差别是 **while 条件读
  `keys_[rawProps.keyIndexCursor_]`**。若 `rawProps` 的 keyCount 为 0（空 props/RawProps 空），
  第一次 `cursor_++` 后是 0，`0 >= keys_.size()` 为真，进入 reset 分支，把 cursor 重置为 0，
  再往下 `keys_[0]` 越界 —— 这是一个**纯越界读**；
- Release 下没有 `resetLoop`，也没有无限循环保护（`REACT_NATIVE_DEBUG` 才编入）。
  如果 Props 类型在构造里跳过了某些字段的 `::at`（条件分支），之后又访问一个从未上牌的字段，
  cursor 在 `keys_` 里永远找不到目标 key，do-while 死循环。

**CORE-30**：`RawPropsParser::at` 在 ready 前做 O(n²) 同名 key 去重（`keys_` push_back +
`nameToIndex_.insert`）；ready 后的 `do-while`**先自增 cursor 再读 `keys_[cursor]`**，
`keyCount` 为 0 时会直接读 `keys_[0]` 越界（纯 Release 崩溃）；Release 没有 `resetLoop`
死循环保护（`#ifdef REACT_NATIVE_DEBUG` 才有）。

### 10.4 `preparse` 不清空 `values_`，同一 RawProps 只能 parse 一次

`preparse` 的关键两行：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/RawPropsParser.cpp:96-140 (节选)
const size_t keyCount = keys_.size();
rawProps.keyIndexToValueIndex_.resize(keyCount, kRawPropsValueIndexEmpty);
...
if (keyCount == 0) return;
...
for (size_t i = 0; i < count; i++) {
  ...
  rawProps.keyIndexToValueIndex_[keyIndex] = valueIndex;   // ← 相对偏移
  auto value = object.getProperty(runtime, nameValue);
  rawProps.values_.emplace_back(runtime, std::move(value)); // ← 只是 push_back，**预先不 clear**
  valueIndex++;
}
```

`values_` 只做 `emplace_back`，不做任何 `clear()`。因此：

- 首次 parse 正常工作；
- 若同一个 RawProps 对象被第二次 parse（Release 下这是可能的，CORE-28 说 Debug 断言才有效），
  `values_` 会不断 append，而 `keyIndexToValueIndex_` 的下标从 **0 相对递增**，
  结果是这些下标指向了**上一轮 parse 留下的旧值**，不是本轮的。

**CORE-31**：`RawPropsParser::preparse` 只做 `values_.emplace_back`
（无 clear 防御），`keyIndexToValueIndex_` 按每轮 parse 从 0 相对生成。在 Release 下
（parse 断言不生效）对同一个 RawProps 做**两次** parse 会把下标指到第一轮 parse 的旧值上。
**同一 RawProps 只能安全 parse 一次。**

### 10.5 RawPropsKeyMap：名字截断到 63 字符、索引是 uint16

```cpp
// packages/react-native/ReactCommon/react/renderer/core/RawPropsKeyMap.cpp:34-46, 79-105 (节选)
void RawPropsKeyMap::insert(std::string_view key, RawPropsValueIndex value) noexcept {
  ...
  auto length = std::min(key.size(), static_cast<size_t>(kPropNameLengthHardCap - 1)); // ← 63
  std::copy_n(key.data(), length, item.name);
  item.length = static_cast<RawPropsPropNameLength>(length);  // ← uint16
  items_.push_back(item);
  react_native_assert(items_.size() < std::numeric_limits<RawPropsPropNameLength>::max()); // Debug only
}
RawPropsValueIndex RawPropsKeyMap::at(std::string_view name) noexcept {
  ...
  if (length == 0 || length >= kPropNameLengthHardCap) [[unlikely]] {
    return kRawPropsValueIndexEmpty;      // ← 全 0 或 ≥64 字符的名字永远查不到
  }
  // 桶区间 + 二分查找 ... memcmp(item.name, name.data(), length)
}
```

`kPropNameLengthHardCap = 64` 是编译期常量；`insert` 截断到 63 字符，`at` 则直接把
`length >= 64` 的请求判死（返回 `kRawPropsValueIndexEmpty`）。这两个行为**同时存在**意味着：

- ≥64 字符的 prop 名可能被插入（被截断到 63），但**永远查不到**（`at` 直接判死）；
- `std::string_view::size()` 可以更大，`static_cast<RawPropsPropNameLength>` 是 uint16
  截断，不出异常。
- 索引类型 `RawPropsValueIndex = uint16_t`，`nameToIndex_` 的 ID 重排时
  `Item{value, length, name[64]}`（total ≈ 67 字节/条）。

> 这两条语义**同时成立**的结果是：长度 ≥64 的 prop 名可以被插入（截断到 63 存下），
> 但在 `at` 里永远查不到（直接判死）。一旦某个样式属性名超过 63 字符，它就会在 Release 下
> 静默走默认值，且**没有任何日志**。这不是侦察出来的假想 —— 是 insert 与 at 行为不对称的
> 直接后果。

**CORE-32**：`RawPropsKeyMap` 的名字硬限是 63 字符：`insert` 截断，`at` 则对 `length >= 64`
（包括空名）直接返回 `kRawPropsValueIndexEmpty`；索引类型 `RawPropsValueIndex = uint16_t`；
Items 的 size 上限断言只 Debug 生效。

### 10.6 propsConversions：三条转换路径

```cpp
// packages/react-native/ReactCommon/react/renderer/core/propsConversions.h:171-200
template <typename T, typename U = T>
T convertRawProp(
    const PropsParserContext &context,
    const RawProps &rawProps,
    const char *name,
    const T &sourceValue,
    const U &defaultValue) {
  const auto *rawValue = rawProps.at(name);
  if (rawValue == nullptr) [[likely]] {
    return sourceValue;
  }
  // Special case: `null` always means "the prop was removed, use default value".
  if (!rawValue->hasValue()) [[unlikely]] {
    return defaultValue;
  }
  try {
    T result;
    fromRawValue(context, *rawValue, result);
    return result;
  } catch (const std::exception &e) {
    LOG(ERROR) << "Error while converting prop '" << name << "': " << e.what();
    return defaultValue;
  }
}
```

三个注意点：

1. `rawValue == nullptr`（即 JS 里**没有**这个 prop）→ 返回 `sourceValue`
   （当前 Props 对象的值），跟「prop 是 null」返回 `defaultValue` 是**两种语义**：
   没传 = 沿用旧值，传了 null = 回到默认值；
2. `catch (const std::exception &)` **不是** catch(...)，`std::bad_alloc` 等非 exception
   异常会继续向外抛；
3. `fromRawValue<T>(context, rawValue, T &result)` 本体只有一行 `result = (T)rawValue;`，
   它调用「const RawValue &」的 `explicit operator T()`；`castValue` 抛出的异常是
   上层 convertRawProp catch（`std::exception`）处理的输入源

`fromRawValue<std::optional<T>>` 特别值得记：**它无条件地**把 `T` 当作「即刻可用」处理。

**CORE-33**：`convertRawProp(name, sourceValue, defaultValue)` 的语义是「没传 = sourceValue
（沿用）」「传了 null = defaultValue」「转换失败 = defaultValue（catch-std::exception）」，
三个分支互不混淆；`fromRawValue<T>` 本体是 `result = (T)rawValue`（无 try/catch 包裹）；
`std::optional<T>` 会 wrap 任意的 value（不需要 hasValue 检查）。

### 10.7 DynamicPropsUtilities：merge/diff 的 null 语义

```cpp
// packages/react-native/ReactCommon/react/renderer/core/DynamicPropsUtilities.cpp:12-62
folly::dynamic mergeDynamicProps(const folly::dynamic& source, const folly::dynamic& patch, NullValueStrategy s) {
  auto result = source;
  if (!result.isObject()) result = folly::dynamic::object();
  if (!patch.isObject()) return result;
  for (const auto& pair : patch.items()) {
    if (s == NullValueStrategy::Ignore && source.find(pair.first) == source.items().end()) continue;
    result[pair.first] = pair.second;   // ← Override；`null` 也写入（用于「未变」指示）
  }
  return result;
}
folly::dynamic diffDynamicProps(const folly::dynamic& oldProps, const folly::dynamic& newProps) {
  ...
  for (const auto& oldPair : oldProps.items()) {
    if (newIterator == newProps.items().end()) result[oldPair.first] = nullptr;  // ← 删除 → null
    else if (oldPair.second != newIterator->second) result[oldPair.first] = newIterator->second;
  }
  ...
}
```

注意「`null` 保留在 merge 结果里」的注释 —— 这是 legacy mounting 需要「delete 该子树」的
一个信号，不是单纯的「没有值」。

**CORE-34**：`mergeDynamicProps(source, patch, s)` 若 source 非 object 就给一个空 object 继续跑，
patch 非 object 就直接返回 source 的拷贝；`Ignore` 策略Key 不存在跳过，`Override` 把 null
也写入（注释说明是 legacy delete 信号）。`diffDynamicProps` 用结构性 `!=`，键在 old 有 new 没有
→ 结果写 `null`。

---

## 11. Sealable：Release 下 seal() 是空操作、getSealed() 恒 true

```cpp
// packages/react-native/ReactCommon/react/renderer/core/Sealable.h:48-59
#ifndef REACT_NATIVE_DEBUG
class Sealable {
 public:
  inline void seal() const {}
  inline bool getSealed() const { return true; }
  inline void ensureUnsealed() const {}
};
#else
// Debug: backed by std::atomic<bool>, moves reset sealed_, ensureUnsealed asserts
#endif
```

Release 下 `getSealed()` 恒真、`ensureUnsealed()` 放行、`seal()` 空操作。Debug 下它用
`std::atomic<bool>` 实装 `sealed_`，规则是「被移动走的对象也确保未封口」（move ctor
`others.ensureUnsealed()`；复制/移动 assign 均也要 `ensureUnsealed()`）。它在
`ShadowNode::sealRecursive()`（ShadowNode.cpp:231-243）里被用作**短路条件**：`getSealed()`
为 true 时直接 return，不再递归进 children —— 所以在 Release 下 **整个递归其实空转一次就返回**，
seal 是一个非常薄的记忆引导点（避免无限次重入完成之前反复解引用 props/children）。

换句话说：Release 下 `ensureUnsealed()` 是空操作，`appendChild`/`replaceChild`/
`setStateData` 里的 const_cast **没有运行时保护**；任何「已 seal 又被突变」的问题在 Release
下不会被发现，在 Debug 下会在 `ensureUnsealed` 的断言处立刻崩掉。

**CORE-35**：`Sealable` 的 release 实装是**空操作类**（`seal(){}` / `getSealed(){return true;}`
/ `ensureUnsealed(){}`）。`ShadowNode::sealRecursive` 在 release 下第一次 `getSealed()` 即
短路返回，不会真正递归；Debug 实装是 `std::atomic<bool>::sealed_` + ensureUnsealed 断言 +
「move 后目标已 unsealed」的拷贝/移动语义。

---

## 12. 外围 9 文件：InstanceHandle、根 tag、原语、umbrella

### 12.1 InstanceHandle

```cpp
// packages/react-native/ReactCommon/react/renderer/core/InstanceHandle.cpp:12-26
InstanceHandle::InstanceHandle(jsi::Runtime& runtime, const jsi::Value& instanceHandle, Tag tag)
    : weakInstanceHandle_(jsi::WeakObject(runtime, instanceHandle.asObject(runtime))), tag_(tag) {}
jsi::Value InstanceHandle::getInstanceHandle(jsi::Runtime& runtime) const {
  return weakInstanceHandle_.lock(runtime);
}
```

`asObject(runtime)` 如果传的是 null/undefined/非 object，**直接抛 `jsi::JSError`**，没有
类型防御。`weakInstanceHandle_.lock()` 过期后返回 null，调用方拿到的就是一个 JS null，
调用方（EventTarget 和 ShadowNodeFamily::getInstanceHandle）需要自行检查
（EventTarget 不检查——见 doc 86）。

### 12.2 ReactPrimitives / getNextRootViewTag

```cpp
// packages/react-native/ReactCommon/react/renderer/core/ReactRootViewTagGenerator.cpp:14-20
constexpr SurfaceId ROOT_VIEW_TAG_INCREMENT = 10;
SurfaceId getNextRootViewTag() noexcept {
  static std::atomic<SurfaceId> nextRootViewTag = 1;
  return nextRootViewTag += ROOT_VIEW_TAG_INCREMENT;
}
```

「原子 += N」返回**新值**（fetch_add 语义）;初值 1，所以首次调用返回 11，步长 10：
11, 21, 31, …。`ReactPrimitives.h` 的类型别名一览：`Tag = SurfaceId = int32_t`、
`kNoTag = -1`、`ComponentHandle = int64_t`、`ComponentName = const char *`。
另有一个 `enum class DisplayMode { Visible = 0, Suspended = 1, Hidden = 2 }`。

### 12.3 umbrella 头

`React/RendererCore.h` 是给 iOS/`__cxx_stable_api` 用的 umbrella：49 条 `#include`，覆盖
core 全部公开头（`React/RawValue.h` 包含 RawValue + RawPropsPrimitives 两条）。
`ConcreteShadowNode.h` 等头都是 `#include <react/cxxstableapi/UmbrellaGuard.h>` 包裹，
内部再用 `#push_macro` / `#pop_macro` 处理 stable 层导出时的命名冲突；core 的全部公开头
（`ShadowNode.h` 等）都在这个 umbrella 里，没有单独的 iOS 导出头。

**CORE-36**：外围文件有三个「本目录最小的实装点」：InstanceHandle 构造即
`instanceHandle.asObject(runtime)`（null/undefined 直接抛 jsi::JSError）；
`getNextRootViewTag()` 是 atomic += 10 从 1 起步（首次 11）；`ReactPrimitives` 里
`ComponentName = const char *` 是裸指针别名（不保证所有权）；
`React/RendererCore.h` 是 49 条头文件的 umbrella。

---

## 13. 结论表

| 编号 | 结论 | 锚点 | 补充 |
| --- | --- | --- | --- |
| **CORE-1** | `emptySharedShadowNodeSharedList()` 返回函数内 `static` 空 vector，无孩子的节点共享同一对象；节点不可拷贝但可 clone；`ShadowNodeWrapper` 析构在 cpp 定义为 key function 以保 RTTI | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:39-44`、`:526-529` | clone 只复制 shared_ptr |
| **CORE-2** | 首次构造把 fragment 的 state 提交为 family 的 mostRecentState，克隆构造不做；两个构造函数都无条件设置 `ChildrenAreShared`，fragment 带 children 时重新挂 parent | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:78-107`、`:109-136` | State 版本线性的关键 |
| **CORE-3** | `propsForClonedShadowNode` 仅 `RN_SERIALIZABLE_STATE` + 未挂载 + 源/新 rawProps 均非空时 merge（Override 新值胜），用 `const_cast` 原地改 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:54-70` | 可能污染共享 Props 对象 |
| **CORE-4** | `clone()` 只在 `fragment.props` 是占位符时解析 `nativeProps_DEPRECATED`；显式传 props 时忽略（TODO 未实现）；解析在 family 锁外执行 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:136-169` | 与 doc 84 UIM-3 的 `cloneNode` 优先级相反 |
| **CORE-5** | `replaceChild` 两个成功分支都在 trait 传播之前 `return`；新孩子的 `setParent` 在查找前执行，失败路径也会留下错误 parent | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:259-291` | 成功留旧标记/漏新标记的双重不对称 |
| **CORE-6** | uncullable 传播唯一入口整个函数体在 `enableViewCulling()` flag 门内；孩子带 view/trace 任一都把父标记为 `uncullableTrace`，没有则清除 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:303-319` | 双向传播（可撤销） |
| **CORE-7** | `setMounted(false)` 只关 eventEmitter，不清 `hasBeenMounted_`、不更新 state；`hasBeenMounted_` 语义是「曾经挂载过」 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:322-333` | 首次挂载后 `getHasBeenPromoted()` 恒 true |
| **CORE-8** | 运行时引用转移有「全局 commit flag / thread_local flag / fragment bool」三层门禁；不满足时 clone 不继承 wrapper；单参 transfer 总执行 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:28`、`:349-380` | wrapper 就是 JS 侧引用 |
| **CORE-9** | `cloneTree` 对每层 children 做一次 vector 拷贝（元素共享）逐层 clone；callback 空返回/family 不匹配只有 Debug 断言 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:381-418` | Release 下继续解引用 |
| **CORE-10** | `cloneMultiple` 计数从待更新 family 的 parent 开始；family 是根时根 tag 不进表，函数返回 `nullptr` | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:450-488` | 只能替换根的后代 |
| **CORE-11** | Family 缓存 handle/name（防 descriptor 释放时取名）但保留 descriptor 裸引用；parent 是 weak；析构回调只对从未挂载的 family 触发 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNodeFamily.cpp:22-60` | 生命周期外强引用缺失 |
| **CORE-12** | `getAncestors` 沿 weak parent 链收集后逐层线性扫描 `children_`，实际 O(depth×siblings)、读 children 无锁；注释宣称 O(ln n)/线程安全 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNodeFamily.cpp:102-140` | 复杂度与安全假设不符 |
| **CORE-13** | family state 读写都用 `unique_lock`（读也独占）；obsolete 单向门；`setMostRecentState(nullptr)` 合法并使旧 state 变 obsolete | `packages/react-native/ReactCommon/react/renderer/core/ShadowNodeFamily.cpp:142-174` | 注意与共享锁直觉相反 |
| **CORE-14** | `dispatchRawState` 在 weak dispatcher 过期时静默 `return`，更新无提示地丢失 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNodeFamily.cpp:176-185` | 与 ConcreteState::updateState 的静默 return 同构 |
| **CORE-15** | Fragment 三个字段是 `const&` 占位符不持有所有权；placeholder 是 `[[clang::no_destroy]]` 的函数内 static；`runtimeShadowNodeReference` 默认 true | `packages/react-native/ReactCommon/react/renderer/core/ShadowNodeFragment.h:27-31`、`ShadowNodeFragment.cpp:18-33` | Fragment 不延长生命周期 |
| **CORE-16** | Traits 是 32 位掩码，15 个具名位（位 0–14）、前 23 位保留；`check` 要求全部位命中；`set/unset` 非原子，clone 按值复制 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNodeTraits.h:24-40`、`:111-113` | 前缀 `Unstable_` 不是弃用标记 |
| **CORE-17** | `ComponentDescriptor` 有 10 个公开纯虚 + 受保护纯虚 `adopt`（共 11 处 `= 0`）；`adopt` 在 create/clone 之后调用；`Flavor` 是类型擦除的 `shared_ptr<const void>` | `packages/react-native/ReactCommon/react/renderer/core/ComponentDescriptor.h:64-148` | 为旧渲染器互操作预留 |
| **CORE-18** | 只在「Props 支持 iterator setter 且 flag 为 false」或「不支持 setter」时构造期 prepare 解析器；flag 中途切回 false 会让未 prepare 的 parser 进入 `at` | `packages/react-native/ReactCommon/react/renderer/core/ConcreteComponentDescriptor.h:48-65` | 运行时热切换有崩溃风险 |
| **CORE-19** | `cloneProps` 空 props+空 rawProps 快路径返回进程级默认 Props；iterator setter 路径 copy 后逐项 `setProp`；classic 路径 parse 后逐字段转换 | `packages/react-native/ReactCommon/react/renderer/core/ConcreteComponentDescriptor.h:112-180` | 两条路径的 rawProps 消费方式不同 |
| **CORE-20** | `createState` 对非默认 StateData 直接解引用 `*family.getMostRecentState()`（可为空）；`createFamily` 允许空 `fragment.instanceHandle` 传给 EventTarget | `packages/react-native/ReactCommon/react/renderer/core/ConcreteComponentDescriptor.h:201-205`、`:207-214` | 后续 retain/getTag 才崩 |
| **CORE-21** | `getStateData()` 对空 `state_` 只做 Debug 断言后继续解引用；`setStateData` 依赖旧 `*state_` 提供 family/revision | `packages/react-native/ReactCommon/react/renderer/core/ConcreteShadowNode.h:163-177` | Release 下是确定性 UB |
| **CORE-22** | `updateState(function)` 的回调可被多次调用（冲突重试）、返回空 SharedData 取消；weak family 失效静默 return；`updateState(Data&&)` 不走重试 | `packages/react-native/ReactCommon/react/renderer/core/ConcreteState.h:78-113` | 与 CORE-14 静默丢失同构 |
| **CORE-23** | `State::revision_` 从 `initialRevisionValue = 1` 起每次 +1；`isObsolete_` 是 `mutable bool`（非 atomic，由 family mutex 保护） | `packages/react-native/ReactCommon/react/renderer/core/State.h:31`、`:106`、`State.cpp:22-27` | family 销毁后 getter 返回空 |
| **CORE-24** | `Props` 基类用 virtual 继承 Sealable 与 DebugStringConvertible；数据只有 `nativeId`（+SERIALIZABLE 下 `rawProps`）；`getDiffProps` 默认返回空 dynamic | `packages/react-native/ReactCommon/react/renderer/core/Props.h:29-77` | 组件覆盖后才有 Props 2.0 行为 |
| **CORE-25** | 只有 `REBUILD_FIELD_SWITCH_CASE` 带 try/catch（失败回默认值）；`RAW_SET_PROP_SWITCH_CASE`/`CASE_STATEMENT_...` 无 catch；哈希是编译期 fnv1a（uint32） | `packages/react-native/ReactCommon/react/renderer/core/PropsMacros.h:25-33`、`:88-101` | 字段选错宏决定异常可达 JS |
| **CORE-26** | RawValue 拷贝构造/赋值是非公开深拷贝（JSI 路径在目标 runtime 重新物化），仅 3 个 friend 可用；公开接口 move-only | `packages/react-native/ReactCommon/react/renderer/core/RawValue.h:86-114` | 拷贝成本高且受限 |
| **CORE-27** | `hasType<vector/map>` 只检查第一个元素，空容器对任意 T 返回 true；`JsiValuePair` 的 dynamic 路径恒 false、JSI 路径恒 true（不对称） | `packages/react-native/ReactCommon/react/renderer/core/RawValue.h:255-329`、`:245-253` | cast 阶段逐元素兜底 |
| **CORE-28** | `RawProps` 是 Empty/JSI/Dynamic 三态；null 归 Empty、undefined/非 object 仍走 JSI（asObject才报错）；重复 parse 断言仅 Debug；拷贝深拷贝 jsi/dynamic 但不拷贝 preparse 状态 | `packages/react-native/ReactCommon/react/renderer/core/RawProps.h:44-49`、`RawProps.cpp:56` | 二次 parse 见 CORE-31 |
| **CORE-29** | `forEachItem` 免 parse（Empty 直接返回）；JSI 路径直接 `asObject` 无对象判断；`std::string_view` 只活到回调体 | `packages/react-native/ReactCommon/react/renderer/core/RawProps.h:113-139` | name 不能被缓存 |
| **CORE-30** | `at()` ready 前 O(n²) 同名去重；ready 后 do-while 先自增再读 `keys_[cursor]`，keyCount=0 时越界读 `keys_[0]`；Release 无 resetLoop 死循环保护 | `packages/react-native/ReactCommon/react/renderer/core/RawPropsParser.cpp:20-89` | Release 成对风险 |
| **CORE-31** | `preparse` 只 `emplace_back` 不清 `values_`；`keyIndexToValueIndex_` 每轮从 0 相对生成；Release 下对同一 RawProps 二次 parse，下标指向旧值 | `packages/react-native/ReactCommon/react/renderer/core/RawPropsParser.cpp:96-140` | 同一 RawProps 只能安全 parse 一次 |
| **CORE-32** | 名字硬限 63 字符：`insert` 截断；`at` 对 ≥64/空名直接判死；索引类型 uint16；条目数上限断言仅 Debug | `packages/react-native/ReactCommon/react/renderer/core/RawPropsKeyMap.cpp:34-46`、`:79-105` | 超长名 prop 静默走默认值且无日志 |
| **CORE-33** | `convertRawProp` 三分支：没传=sourceValue（沿用）、传了 null=defaultValue、转换失败=defaultValue（catch `std::exception`）；`fromRawValue<T>` 本体一行 `(T)rawValue` | `packages/react-native/ReactCommon/react/renderer/core/propsConversions.h:171-200` | `std::optional` 无条件包装、不查 hasValue |
| **CORE-34** | `mergeDynamicProps` 对非 object 容错（source 给空对象、patch 直接返回 source 拷贝）；Ignore 按键存在跳过、Override 把 null 也写入；diff 中删除→结果写 null | `packages/react-native/ReactCommon/react/renderer/core/DynamicPropsUtilities.cpp:12-62` | null 是 legacy 删除信号 |
| **CORE-35** | Sealable 的 release 实装是空操作类（`seal(){}`/`getSealed(){return true;}`/`ensureUnsealed(){}`）；`sealRecursive` 首次 `getSealed()` 即短路；Debug 实装是 `std::atomic<bool>` | `packages/react-native/ReactCommon/react/renderer/core/Sealable.h:48-59`、`ShadowNode.cpp:231-243` | 已 seal 再突变仅 Debug 崩 |
| **CORE-36** | 三个最小实装点：`InstanceHandle` 构造即 `asObject`（null/undefined 抛 JSError）；根 tag 是 atomic += 10 从 1 起步首值 11；`ComponentName` 是裸 `const char*`；`React/RendererCore.h` 为 49 条 include 的 umbrella | `packages/react-native/ReactCommon/react/renderer/core/InstanceHandle.cpp:12-26`、`ReactRootViewTagGenerator.cpp:14-20`、`ReactPrimitives.h:19-49`、`React/RendererCore.h` | 目录外围最小约定 |
