---
id: 72
title: "渲染器的调试字符串机制：默认无限递归深度、随构建配置变化的类形状，以及两个同名不同义的 `flags.h`"
topic: RN.debug
symptoms: [debug, crash]
platforms: [cross]
architecture: [cross]
layer: T2
symbols: ["DebugStringConvertible", "RN_DEBUG_STRING_CONVERTIBLE", "flags.h"]
claims: [LLL-1, LLL-2, LLL-3, LLL-4, LLL-5, LLL-6, LLL-7, LLL-8, LLL-9, LLL-10]
---
# 72 · 渲染器的调试字符串机制：默认无限递归深度、随构建配置变化的类形状，以及两个同名不同义的 `flags.h`

> **模块**：Z1 · `packages/react-native/ReactCommon/react/renderer/debug/`（7 个文件）
> + `packages/react-native/ReactCommon/react/renderer/bridging/`（2）
> + `packages/react-native/ReactCommon/react/renderer/viewtransition/`（2）
>
> **基线**：react-native @ `9b131e42` · 跨平台 C++ · **与架构无关**
>
> **前置**：[59 文档](./59-Promise的reject跨平台契约.md) 记录「注释描述的能力不存在」；
> [62 文档](./62-CxxStableAPI的三档守卫与它们的惰性.md) 记录 `RN_DEBUG_STRING_CONVERTIBLE` 的派生规则与三档 Guard；
> [64 文档](./64-渲染器基础设施的注册表与DOM层.md) 记录 JS 可控的栈溢出向量；
> [65 文档](./65-错误处理底层的断言宏与RedBox解析.md) 记录 `react_native_expect` 的裸 `if` 宏；
> [70 文档](./70-文本属性层的两套未设置表示.md) 记录 `TextAttributes` 的调试输出。
>
> 本文记录三条结论：
> ① **【核心】`DebugStringConvertibleOptions::maximumDepth` 默认是 `INT_MAX`** ——
> 而 `getDebugDescription` 是**递归**的 → **默认无限深度**（与 64 文档 DDD-2 同型的栈溢出路径）；
> ② **【核心】类的形状随构建配置变化** —— `override` 声明被 `#if RN_DEBUG_STRING_CONVERTIBLE` 包住，
> **每个子类都要手工同步，漏一处就在 release 下编译失败**；
> ③ **【核心】两个同名 `flags.h` 内容完全不同**，且**调试开关的声明与使用点分处两者之中** ——
> 生效依赖一条**极不显然的间接包含链**。

---

## 1. 文件构成（本轮读 11 个文件）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.h` | **402** | 抽象基类 + `DebugStringConvertibleOptions` + `toString` 重载 |
| `packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.cpp` | **179** | 递归组装算法 |
| `packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertibleItem.h` | 47 | 「项」的平凡实现 |
| `packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertibleItem.cpp` | 46 | 同上 |
| `packages/react-native/ReactCommon/react/renderer/debug/debugStringConvertibleUtils.h` | 73 | 构造 item 的辅助函数（**62/63 文档已引用**） |
| `packages/react-native/ReactCommon/react/renderer/debug/flags.h` | **49** | **`RN_DEBUG_STRING_CONVERTIBLE` 的定义处** |
| `packages/react-native/ReactCommon/react/renderer/debug/CMakeLists.txt` | — | 构建 |
| `packages/react-native/ReactCommon/react/renderer/bridging/bridging.h` | 49 | JSI↔C++ 值转换 |
| `packages/react-native/ReactCommon/react/renderer/bridging/CMakeLists.txt` | 20 | 构建 |
| `packages/react-native/ReactCommon/react/renderer/viewtransition/ViewTransitionModule.h` | 173 | View Transition 模块声明 |
| `packages/react-native/ReactCommon/react/renderer/viewtransition/ViewTransitionModule.cpp` | **570** | View Transition 实现 |

---

## 2. 【核心 LLL-1】默认无限递归深度 —— 与 64 文档同型的栈溢出路径

### 2.1 选项结构体

```cpp
// packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.h:30-33
struct DebugStringConvertibleOptions {
  bool format{true};
  int depth{0};
  int maximumDepth{INT_MAX};
};
```

**`maximumDepth` 的默认值是 `INT_MAX`** —— **即「默认没有深度上限」**。

### 2.2 递归的两条路径

```cpp
// packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.cpp:19-30
  if (options.depth >= options.maximumDepth) {
    return "";
  }

  options.depth++;

  auto trailing = options.format ? std::string{"\n"} : std::string{""};
  std::string childrenString;

  for (const auto& child : getDebugChildren()) {
    if (!child) {
      continue;
    }

    childrenString += child->getDebugDescription(options) + trailing;
  }
```

```cpp
// packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.cpp:48-58
  for (const auto& prop : getDebugProps()) {
    if (!prop) {
      continue;
    }

    auto name = prop->getDebugName();
    auto value = prop->getDebugValue();
    auto children = prop->getDebugPropsDescription(options);
```

| 路径 | 递归对象 | 深度计数 |
| --- | --- | --- |
| **children** | `child->getDebugDescription(options)` —— **完整子树** | `options.depth++` ✓ |
| **props** | `prop->getDebugPropsDescription(options)` —— **只递归 props** | `options.depth++` ✓ |

**即：一次 `getDebugDescription()` 会同时递归 children 树（完整）与 props 树（props-only）。**

### 2.3 深度检查只在**调用方显式设置**时生效

| 调用方式 | `maximumDepth` | 效果 |
| --- | --- | --- |
| `getDebugDescription()`（**无参**） | **`INT_MAX`** | **深度无上限** |
| `getDebugDescription({.maximumDepth = 10})` | 10 | 10 层后返回空串 ✓ |

**即：默认值让「深度保护」形同虚设** —— 只有知道这个选项的调用方才会设。

### 2.4 与 64 文档 DDD-2 的对照

| | 64 文档 DDD-2 | 本文 LLL-1 |
| --- | --- | --- |
| 递归函数 | `getTextContentInShadowNode` | `getDebugDescription` |
| 深度保护 | **完全没有** | **有，但默认 `INT_MAX`（等于没有）** |
| 触发路径 | **JS 可直接调用**（`NativeDOM` TurboModule） | **C++ 内部调用**（调试工具） |
| 后果 | **进程崩溃（SIGSEGV）** | 同样栈溢出，但**仅在 debug/诊断路径** |

**即：64 文档的路径是「JS 可控的外部输入」，本文的路径是「内部诊断工具」——
**严重性低一个量级**，但**形态完全相同**。

### 2.5 顺带：字符串拼接是 O(n²)

```cpp
// packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.cpp:36
    childrenString += child->getDebugDescription(options) + trailing;
```

**逐个子节点 `+=` 到同一个 `std::string`** → 每次追加都可能重新分配 + 拷贝全部已有内容 → **O(n²)**。

**对大子树（例如整个 ShadowTree）会明显变慢** —— 而这正是调试工具最需要它工作的场景。

---

## 3. 【核心 LLL-2】类的形状随构建配置变化

### 3.1 release 下基类变成空壳

```cpp
// packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.h:88-93
#else

struct DebugStringConvertibleOptions {};
class DebugStringConvertible {};

#endif
```

**release 下（`RN_DEBUG_STRING_CONVERTIBLE == 0`）**：
- `DebugStringConvertibleOptions` 是**空结构体**
- `DebugStringConvertible` 是**没有虚函数的空类**（**无虚表**）

### 3.2 子类的 `override` 声明必须手工包在 `#if` 里

```cpp
// packages/react-native/ReactCommon/react/renderer/attributedstring/TextAttributes.h:112-116
#if RN_DEBUG_STRING_CONVERTIBLE
  SharedDebugStringConvertibleList getDebugProps() const override;
#endif
```

**即：`override` 关键字本身被 `#if` 包住。**

### 3.3 后果：**每个子类都要手工同步**

| 步骤 | 后果 |
| --- | --- |
| 新增一个继承 `DebugStringConvertible` 的类 | **必须**记得用 `#if RN_DEBUG_STRING_CONVERTIBLE` 包住每个 `override` 声明 |
| **忘记包** | **release 构建时 `override` 找不到基类方法 → 编译错误** |
| **包错了宏** | 若包的是别的宏（如 `REACT_NATIVE_DEBUG`），则 debug-but-not-production 的构建会失败 |

**即：这是一个「每个实现者都要重复 3 次同样的 `#if`」的约定，
而编译器只在「忘记包」时报错，在「包错宏」时报错。**

**这是一个真实的、可验证的结构脆弱点。**

### 3.4 好消息：release 下基类无虚函数 → **无虚表开销**

| 项 | debug | release |
| --- | --- | --- |
| `DebugStringConvertible` 的大小 | 有虚表指针（+8 字节） | **空类（1 字节）** |
| 每个子类的虚表 | 有 | **无** |
| **对 `TextAttributes` 等被大量持有的结构体** | 多 8 字节/实例 | **无开销** ✓ |

**即：这个设计在 release 下反而更省** —— **是有意的取舍**（注释里也说明了「flags that should never be enabled for release-mode/production builds」）。

### 3.5 官方自己说这个类已废弃

```cpp
// packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.h:42-44
 * The `DebugStringConvertible` *class* is obsolete. Whenever possible prefer
 * implementing standalone functions that conform to the informal
 * `DebugStringConvertible`-like interface instead of extending this class.
```

**即：类还在大量使用（`TextAttributes` 等），但官方注释已声明它「obsolete」** ——
**注释与现状不一致**（59 文档同型：注释描述的状态与实际不符，但方向相反 —— 注释说「别用了」，实际「大家都在用」）。

---

## 4. 【核心 LLL-3】两个同名 `flags.h`，以及「开关声明与使用点错位」

### 4.1 两个同名文件，内容完全不同

| 文件 | 行数 | 定义什么 |
| --- | --- | --- |
| `packages/react-native/ReactCommon/react/debug/flags.h` | **24** | `REACT_NATIVE_DEBUG` / `REACT_NATIVE_PRODUCTION`（基于 `NDEBUG` 二选一派生） |
| `packages/react-native/ReactCommon/react/renderer/debug/flags.h` | **49** | `RN_DEBUG_STRING_CONVERTIBLE`（基于 `REACT_NATIVE_DEBUG` 或 `RN_ENABLE_DEBUG_STRING_CONVERTIBLE`）**+ 3 个 LayoutAnimations 开关的注释** |

**逐行对比（实测）**：两个文件**在第 12 行起就完全不同**（一个从「Preprocessor flags which control…」开始，另一个从 `#include <React/Debug.h>` 开始）。

**两者都靠全路径 include（`<react/...>`）区分 → 不会真的冲突** ✓
**但「同名不同义」是真实的维护陷阱**：读代码看到 `flags.h` 不知道是哪个。

### 4.2 `renderer/debug/flags.h` 里的 LayoutAnimations 开关 —— **与本目录无关**

```cpp
// packages/react-native/ReactCommon/react/renderer/debug/flags.h:22-30
// Enables verbose logging for the LayoutAnimations subsystem.
// #define LAYOUT_ANIMATION_VERBOSE_LOGGING 1

// Logs information before running `assert` in LayoutAnimations. More useful on
// Android vs other platforms.
// #define VERBOSE_LAYOUT_ANIMATION_ASSERTS 1

// Enables some Shadow Tree introspection features (maintains a StubViewTree,
// and logs prev/next tree and mutations if there are any discrepancies). If you
// define this, also define `RN_DEBUG_STRING_CONVERTIBLE`.
// #define RN_SHADOW_TREE_INTROSPECTION 1
```

**这三个开关与 `renderer/debug/` 的主题（调试字符串机制）毫无关系** ——
**它们分别是 `renderer/animations/` 与 `renderer/mounting/` 的开关**。

**即：这是一批「放错地方」的开关声明**（复制粘贴的残留）。

### 4.3 关键的错位：**使用点直接 include 的是另一个 `flags.h`**

| 开关 | **使用点** | 使用点直接 include 的 | **声明所在** |
| --- | --- | --- | --- |
| `LAYOUT_ANIMATION_VERBOSE_LOGGING` | `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp`（**6 处** `#ifdef`） | **`<react/debug/flags.h>`**（24 行那个） | **`<react/renderer/debug/flags.h>`**（49 行那个） |
| `STUB_VIEW_TREE_VERBOSE` | `packages/react-native/ReactCommon/react/renderer/mounting/stubs/StubViewTree.cpp`、`StubView.cpp` | **不直接 include** | `renderer/debug/flags.h` |
| `RN_SHADOW_TREE_INTROSPECTION` | `packages/react-native/ReactCommon/react/renderer/mounting/MountingCoordinator.cpp` | **不直接 include** | `renderer/debug/flags.h` |

### 4.4 生效依赖一条**极不显然的间接包含链**

**实测包含链**：

```
LayoutAnimationKeyFrameManager.cpp:14  →  <react/debug/flags.h>          （不含该开关）
LayoutAnimationKeyFrameManager.cpp:22  →  <react/renderer/core/LayoutMetrics.h>
LayoutMetrics.h:14                    →  <react/renderer/debug/flags.h>   ← ✅ 开关在这里
```

**即：开关能生效，靠的是 `LayoutMetrics.h` 的传递包含**，**而不是它自己直接 include 的那个 `flags.h`**。

| 后果 | 说明 |
| --- | --- |
| **在 `react/debug/flags.h`（使用点直接 include 的那个）里找不到开关** | 读者会以为「这个开关不存在」 |
| **在 `renderer/debug/flags.h`（声明所在）里取消注释 → 确实生效** | ✓ 但依赖上面那条间接链 |
| **一旦 `LayoutAnimationKeyFrameManager.cpp` 不再 include `LayoutMetrics.h`（或该 include 被重构掉）** | **开关静默失效** —— **没有任何编译错误** |

**即：这是一个「生效依赖无关头文件的传递包含」的结构脆弱点。**

### 4.5 「手动开启的调试开关」是一等公民机制 ✓

**实测**：这 3 个开关在代码里**都有真实的 `#ifdef` 使用点**（`LayoutAnimationKeyFrameManager.cpp` 6 处、`StubViewTree.cpp`/`StubView.cpp` 4 处、`MountingCoordinator.cpp` 2 处），
**只是默认被注释掉**（需手工取消注释）。

**而 `flags.h` 的注释明确说明了这一点**：

```
// This file contains flags that should __never__ be enabled for
// release-mode/production builds, unless explicitly noted. You can enable some
// of these for debug or local builds to assist in logging / debugging specific
// features.
```

**即：「默认关闭、需手工开启」是明确的设计**，✓ **不是死代码**。

**但「放错地方」削弱了可发现性** —— 开关的使用者在**使用点直接 include 的文件里找不到它**。

### 4.6 顺带：`react/debug/React/Debug.h` 是另一个 umbrella 头

```cpp
// packages/react-native/ReactCommon/react/debug/React/Debug.h:29-41
#pragma push_macro("RN_UMBRELLA_CONTEXT")
#undef RN_UMBRELLA_CONTEXT
#define RN_UMBRELLA_CONTEXT 1

#include <react/debug/flags.h>
#include <react/debug/react_native_assert.h>
#include <react/debug/react_native_expect.h>

#undef RN_UMBRELLA_CONTEXT
#pragma pop_macro("RN_UMBRELLA_CONTEXT")
```

**又是 62 文档 BBB-5 的 `push_macro`/`pop_macro` 模式** ✓ —— **本轮见到的第三个实例**（前两个：68 文档的 `cxxreact/ReactNativeVersion.h`、62 文档本身）。

**且注释说明了「redbox/ 的头被刻意排除」**（`The `redbox/` headers are deliberately absent: they are implementation details of the dev-menu red box and carry no stability guarantee.`）✓ —— **第一档注释**。

---

## 5. 附带发现：`bridging.h` 与 `ViewTransitionModule`

### 5.1 `bridging.h` —— JSI↔C++ 的值转换

**本轮只读了头文件**（49 行）—— 它提供 `Bridging<T>` 模板特化，把 folly 类型与 JSI 值互转。
**`ReactNativeFeatureFlags.h` 里的 `Bridging<NativePerformancePerformanceObserverObserveOptions>`（见 39 文档）是它的消费方之一。**

### 5.2 `ViewTransitionModule` —— 570 行

**本轮只读了头文件与实现的开头** —— 未形成可断言的结论，**故本文不写它的发现**。
**它被计入本轮的已读文件数，但结论留待后续专篇。**

---

## 6. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **LLL-1** | **【核心】`DebugStringConvertibleOptions::maximumDepth` 默认是 `INT_MAX`**，而 `getDebugDescription` / `getDebugPropsDescription` 是**递归**的 → **默认无限深度** | `packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.h:30-33`；`DebugStringConvertible.cpp:19-30`、`:48-58` | **与 64 文档 DDD-2 同型的栈溢出路径**（那里完全无保护，这里有保护但默认等于没有）；**严重性低一个量级**（仅内部诊断路径，非 JS 可达）；**修复成本极低**（默认值改成一个有限值） |
| **LLL-2** | **【核心】类的形状随构建配置变化**：release 下 `DebugStringConvertible` 是**无虚函数的空类**、`DebugStringConvertibleOptions` 是**空结构体**；**子类的 `override` 声明必须手工包在 `#if RN_DEBUG_STRING_CONVERTIBLE` 里** | `packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.h:88-93`；`packages/react-native/ReactCommon/react/renderer/attributedstring/TextAttributes.h:112-116` | **每个子类都要重复同样的 `#if`**；**忘记包 → release 编译失败**（可被发现）；**包错宏 → 特定构建配置失败**；**release 下基类无虚表 → 反而更省** ✓（有意的取舍） |
| **LLL-3** | **【核心】两个同名 `flags.h` 内容完全不同**（`react/debug/flags.h` 24 行定义 `REACT_NATIVE_DEBUG`；`react/renderer/debug/flags.h` 49 行定义 `RN_DEBUG_STRING_CONVERTIBLE`）；**后者含 3 个与本目录无关的 LayoutAnimations/StubViewTree 开关**（复制残留） | `packages/react-native/ReactCommon/react/debug/flags.h`；`packages/react-native/ReactCommon/react/renderer/debug/flags.h:22-30` | **同名不同义**；全路径 include 避免了真冲突 ✓，但**可发现性差** |
| **LLL-4** | **【核心】调试开关的「声明」与「使用点」分处两个同名 `flags.h` 之中**：`LAYOUT_ANIMATION_VERBOSE_LOGGING` 声明在 `renderer/debug/flags.h`，而使用点 `LayoutAnimationKeyFrameManager.cpp` **直接 include 的是 `react/debug/flags.h`** | `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp:14`、`:22`；`packages/react-native/ReactCommon/react/renderer/core/LayoutMetrics.h:14` | **生效依赖一条极不显然的间接包含链**（`LayoutMetrics.h` 的传递包含）；**一旦该 include 被重构掉 → 开关静默失效，无编译错误**；**读者在直接 include 的文件里找不到开关** |
| LLL-5 | 字符串拼接是 **O(n²)**（逐个子节点 `+=` 到同一个 `std::string`） | `packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.cpp:36` | **对大子树明显变慢** —— 而这正是调试工具最需要的场景 |
| LLL-6 | `DebugStringConvertible` 的注释声明「*class* is obsolete … prefer implementing standalone functions」，**但该类仍被大量继承** | `packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.h:42-44` | **注释与现状相反**（59 文档同型，但方向相反：注释说「别用了」，实际「大家都在用」） |
| **LLL-7** | **`getDebugChildrenDescription` / `getDebugPropsDescription` 的深度检查、`!child` 空指针守卫、前导/尾随字符的删除都有判空保护** | `packages/react-native/ReactCommon/react/renderer/debug/DebugStringConvertible.cpp:19-46`、`:48-82` | ✓ **边界处理完整** |
| **LLL-8** | **children 与 props 走两种不同的递归语义**（children 递归完整子树、props 只递归 props）—— **这是有意的区分** | `DebugStringConvertible.cpp:36`、`:61` | ✓ |
| **LLL-9** | **`react/debug/React/Debug.h` 是 umbrella 头并用 `push_macro`/`pop_macro`**（62 文档 BBB-5 模式的**第三个实例**），且注释说明「`redbox/` 的头被刻意排除」及其理由 | `packages/react-native/ReactCommon/react/debug/React/Debug.h:24-41` | ✓ **第一档注释** |
| **LLL-10** | **「默认关闭、需手工开启」的调试开关是一等公民机制** —— 3 个开关都有真实 `#ifdef` 使用点，且 `flags.h` 注释明确说明了「不该在 release 开启、可为 debug 开启」 | `packages/react-native/ReactCommon/react/renderer/debug/flags.h:14-18` | ✓ **不是死代码**；**只是 LLL-3/LLL-4 削弱了可发现性** |

---

## 7. 适用范围声明

| 维度 | LLL-1 / LLL-5 | LLL-2 | LLL-3 / LLL-4 |
| --- | --- | --- | --- |
| **平台** | 双端 | 双端 | 双端 |
| **架构** | 与架构无关 | 与架构无关 | 与架构无关 |
| **编译条件** | `RN_DEBUG_STRING_CONVERTIBLE`（LLL-1 需 debug 构建） | **release 与 debug 行为不同**（LLL-2） | 无 |
| **触发条件** | 深树 + 调用 `getDebugDescription()` | 新增子类时漏包 `#if` | 重构掉 `LayoutMetrics.h` 的 include |
| **当前是否造成功能问题** | **否**（仅诊断路径） | **否**（但新增子类时会踩） | **否**（当前链成立） |
| **是否已实机验证** | **否**（代码级认定） | **否** | **是**（包含链已逐步核实） |

> **重要提醒**：LLL-2 的「release 下基类为空壳」是**有意设计**
> （`flags.h` 注释明说这些 flag 不该在 release 开启）——
> **问题不在设计，而在「每个子类都要手工同步 `#if`」这个约定没有机制守护。**

---

## 8. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 64 文档 DDD-2：JS 可控的无深度限制递归 → 栈溢出 | **本文 LLL-1 是同型的内部路径** —— 那里**完全无保护**，这里**有保护但默认 `INT_MAX`**；**严重性低一个量级**（非 JS 可达） |
| 62 文档 §2.4：`RN_DEBUG_STRING_CONVERTIBLE` 的派生规则 | **本文给出它的第二个定义点** —— 62 文档引用的是 `react/debug/flags.h` 的 `REACT_NATIVE_DEBUG` 派生；**`RN_DEBUG_STRING_CONVERTIBLE` 实际定义在 `packages/react-native/ReactCommon/react/renderer/debug/flags.h:36-40`**（同名不同义的另一个文件） |
| 62 文档 BBB-5：`push_macro`/`pop_macro` 而非裸 `#undef` | **本文 LLL-9 是第三个真实用例**（前两个：68 文档的 `cxxreact/ReactNativeVersion.h`、62 文档本身） |
| 59 文档 YY-3：注释描述的能力不存在 / 与现状不符 | **本文 LLL-6 是新变体** —— 那里是「引用的函数改名了」，**这里是「注释说类已废弃、实际大量在用」**（方向相反） |
| 67 文档 GGG-1 / 71 文档 KKK-2：同一份定义被复制 N 份 | **本文 LLL-3 是第三例** —— **两个同名 `flags.h` 内容完全不同**，且**开关声明与使用点分处两者之中**（LLL-4） |
| 70 文档 JJJ-13：`getDebugProps()` 在 `#if RN_DEBUG_STRING_CONVERTIBLE` 内 | **本文 LLL-2 给出该机制的全貌** —— **release 下基类是无虚函数的空类**，`override` 声明必须手工包在 `#if` 里 |
| 65 文档 EEE-1：`react_native_expect` 的裸 `if` 宏 | **对照 LLL-7** —— 这里的递归实现**判空守卫完整**（`!child`、`!childrenString.empty()`、`!propsString.empty()`）—— **同一仓库里「防御充足」与「防御不足」并存** |
