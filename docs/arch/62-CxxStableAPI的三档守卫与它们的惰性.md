---
id: 62
title: "CxxStableAPI 的三档守卫：631 处 include、一个全仓未定义的宏、以及本仓库注释质量的第一档样本"
topic: FD.api
symptoms: [debug, build]
platforms: [cross]
architecture: [cross]
layer: T4
symbols: ["UmbrellaGuard", "RN_STRICT_API"]
sourceRoot: react-native
claims: [BBB-1, BBB-2, BBB-3, BBB-4, BBB-8, BBB-9, BBB-10]
---
# 62 · CxxStableAPI 的三档守卫：631 处 include、一个全仓未定义的宏、以及本仓库注释质量的第一档样本

> **模块**：Z1 · `packages/react-native/ReactCommon/react/cxxstableapi/`（6 个非测试文件）
>
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · 双端 C++（预处理器层）· **与架构无关**
>
> **前置**：[49 文档](./49-构建工具链与静默失败.md) 记录构建门禁的方向性问题与外部引用的可验证形态；
> [59 文档](./59-Promise的reject跨平台契约.md) 记录「符号级」锚点失效（对方改名）；
> [61 文档](./61-ScrollView状态与裁剪的平台条件.md) 记录「对方整层被移除」型锚点失效。
>
> 本文记录 `react/cxxstableapi` 这个**纯预处理器模块**的四件事：
> ① **三档 Guard 的分工与共享宏契约**（`#error` / `#warning` / `#error`，可逃逸出口数量递减）；
> ② **【核心】`RN_STRICT_API` 在全仓从未被定义** —— 631 处 `#include` 与 3 个 Guard
> 在本仓库的**所有**构建中恒为惰性；
> ③ **【核心】Guard 逻辑在本仓库内零验证** —— 即使打开 `RN_STRICT_API`，
> RN 自身的构建也定义了 `RN_BUILDING`，因此仍然不触发；
> ④ **【核心·正向】三份 20–30 行注释解释了 `push_macro`/`pop_macro` 的微妙理由**
> —— 这是本仓库见过的最好的注释。

---

## 1. 文件构成（6 个文件，全部读完）

| 文件 | 行数 | 字节 | 职责 |
| --- | --- | --- | --- |
| `packages/react-native/ReactCommon/react/cxxstableapi/UmbrellaGuard.h` | **63** | — | 「public」档：**硬错误** |
| `packages/react-native/ReactCommon/react/cxxstableapi/FrameworksGuard.h` | **35** | — | 「for-frameworks」档：**可抑制警告** |
| `packages/react-native/ReactCommon/react/cxxstableapi/PrivateGuard.h` | **34** | — | 「private」档：**硬错误，无逃逸出口** |
| `packages/react-native/ReactCommon/react/cxxstableapi/StableApiAnchor.cpp` | **18** | — | 空 TU，仅为让 CocoaPods 产出真 framework |
| `packages/react-native/ReactCommon/react/cxxstableapi/CMakeLists.txt` | **19** | — | Android/CMake 侧：`INTERFACE` 库 |
| `packages/react-native/ReactCommon/react/cxxstableapi/React-cxxstableapi.podspec` | **32** | — | iOS/CocoaPods 侧 |

**合计 201 行**，其中**注释与空行占绝大多数**；三份 Guard 的实际预处理指令各只有 1 条 `#if` + 1 条 `#error`/`#warning` + 1 条 `#endif`。

---

## 2. 【核心 BBB-1】三档 Guard：严重度递减、逃逸出口也递减

### 2.1 逐字对照三个 `#if` 条件

```cpp
// packages/react-native/ReactCommon/react/cxxstableapi/UmbrellaGuard.h:60-63
#if defined(RN_STRICT_API) && !defined(RN_UMBRELLA_CONTEXT) && !defined(RN_BUILDING)
#error \
    "Do not include this React Native header directly. Include the module's umbrella header <React/<Module>.h> instead."
#endif
```

```cpp
// packages/react-native/ReactCommon/react/cxxstableapi/FrameworksGuard.h:32-35
#if defined(RN_STRICT_API) && !defined(RN_ALLOW_FRAMEWORKS) && !defined(RN_UMBRELLA_CONTEXT) && !defined(RN_BUILDING)
#warning \
    "This is a 'for frameworks' React Native API, intended for framework authors rather than app code. Include it via the module umbrella <React/<Module>.h>, or define RN_ALLOW_FRAMEWORKS to acknowledge framework-tier usage and silence this warning."
#endif
```

```cpp
// packages/react-native/ReactCommon/react/cxxstableapi/PrivateGuard.h:31-34
#if defined(RN_STRICT_API) && !defined(RN_BUILDING)
#error \
    "This is a private React Native header and is not part of the public API. Do not include it directly; it has no stability guarantee."
#endif
```

### 2.2 四项对比（实测）

| 维度 | `UmbrellaGuard` | `FrameworksGuard` | `PrivateGuard` |
| --- | --- | --- | --- |
| **触发动作** | `#error` | **`#warning`** | `#error` |
| **总行数** | 63 | 35 | 34 |
| **注释行数** | **约 56** | 约 30 | 约 29 |
| **逃逸宏数量** | **2**（`RN_UMBRELLA_CONTEXT`、`RN_BUILDING`） | **3**（+`RN_ALLOW_FRAMEWORKS`） | **1**（`RN_BUILDING`） |
| **是否认 `RN_UMBRELLA_CONTEXT`** | ✅ | ✅ | ❌ **不认** |
| **给消费者的出口** | 改用 umbrella 头 | 改用 umbrella 或定义 `RN_ALLOW_FRAMEWORKS` | **无**（注释明说 `no consumer-facing escape hatch`） |

**三档的设计意图是自洽的**：

| 档位 | 承诺强度 | 违约后果 | 逃逸方式 |
| --- | --- | --- | --- |
| public | 有稳定性保证，承诺 umbrella 入口 | **编译失败**（防止绕过 umbrella 丢失传递依赖） | 改用 umbrella |
| for-frameworks | 面向框架作者，**自愿使用** | **仅警告**（不阻断构建） | 显式声明 `RN_ALLOW_FRAMEWORKS` |
| private | **零保证**，明确告知 | 编译失败 | **无** |

### 2.3 `PrivateGuard` 不认 `RN_UMBRELLA_CONTEXT` 是刻意的

`FrameworksGuard.h:20` 与 `PrivateGuard.h:20` 都写着
`See <react/cxxstableapi/UmbrellaGuard.h> for the full 'RN_*' macro contract.`

**但三档的条件表达式并不共享同一份契约**：

| 宏 | UmbrellaGuard | FrameworksGuard | PrivateGuard |
| --- | --- | --- | --- |
| `RN_STRICT_API` | 必需 | 必需 | 必需 |
| `RN_UMBRELLA_CONTEXT` | 逃逸 | 逃逸 | **不接受** |
| `RN_BUILDING` | 逃逸 | 逃逸 | 逃逸 |
| `RN_ALLOW_FRAMEWORKS` | 不认 | 逃逸 | 不认 |

**即 umbrella 机制对 private 档无效** —— 一个 private 头即使被 umbrella 正确地包住，
也会因不含 `RN_UMBRELLA_CONTEXT` 而 `#error`。

**这是正确的**：private 头的注释明说
`Private headers are implementation details with no stability guarantee` ——
**private 头本就不该有 umbrella**，承认 umbrella 反而会削弱「零保证」的边界。

> **但「共享契约」这个措辞不精确** —— 三档共享的是**主开关与内部标记的存在**，
> 不是**同一份条件**。读者若照着 `UmbrellaGuard.h` 的契约去推断
> `PrivateGuard` 会接受 umbrella，会得到错误结论。
>
> **无注释指出这一差异**，但 `PrivateGuard.h:17-18` 的
> `there is no consumer-facing escape hatch (unlike the for-frameworks guard)`
> 已经隐含地承认了 private 与另两档不同。**属于「说明了不同、没说清不同在哪」。**

### 2.4 三份 Guard 都不用 `#pragma once` —— 逐字说明

| 文件 | 行号 | 原文 |
| --- | --- | --- |
| `UmbrellaGuard.h` | **56-57** | `This header is intentionally NOT '#pragma once'-guarded: it must be re-evaluated on every inclusion so each direct include is checked.` |
| `FrameworksGuard.h` | **28-29** | 同上（逐字相同） |
| `PrivateGuard.h` | **27-28** | 同上（逐字相同） |

**三份都刻意不用 `#pragma once`** —— 若加了，`#error` 只会在**第一次**包含时触发，
**同一翻译单元里后续的直接包含会静默通过**，守卫就漏了。

**且三份文件都没有 `#pragma once`** —— 实测确认（`grep '^#pragma once'` 零命中）。

---

## 3. 【核心 BBB-2】`RN_STRICT_API` 在全仓从未被定义

### 3.1 全仓检索结果（逐字）

**检索范围**：全仓，排除 `node_modules` 与 `.git`，再排除 `react/cxxstableapi/` 自身。

**唯一命中**（逐字）：

| 位置 | 原文 |
| --- | --- |
| `packages/react-native/scripts/cocoapods/utils.rb:114` | `# header into an error for consumers that opt into RN_STRICT_API. React Native's own` |

**即：全仓 `RN_STRICT_API` 只出现 1 次，且是注释里的一个词，没有任何一处 `#define`。**

### 3.2 三处 `#if defined(RN_STRICT_API)` 因此恒为假

| 文件 | 条件行 | 因 `RN_STRICT_API` 未定义 |
| --- | --- | --- |
| `UmbrellaGuard.h` | `:60` | **恒假** → `#error` 永不触发 |
| `FrameworksGuard.h` | `:32` | **恒假** → `#warning` 永不触发 |
| `PrivateGuard.h` | `:31` | **恒假** → `#error` 永不触发 |

**这是设计意图**，`UmbrellaGuard.h:24-29` 明确写了：

```
//   RN_STRICT_API        Consumer opt-in master switch. Every guard in this
//                        directory is INERT unless the consuming build defines
//                        this macro. Shipping the guards therefore changes
//                        nothing for existing consumers — they only activate
//                        when a consumer opts into the strict public API by
//                        defining RN_STRICT_API.
```

**「Shipping the guards therefore changes nothing for existing consumers」**
—— 注释**主动声明了「默认零影响」这一后果**，属第一档注释的「说明取舍」要素。

### 3.3 但 631 处 `#include` 是真实存在的代码

**实测**（正则 `^#include <react/cxxstableapi/X.h>`，排除注释行、排除 `cxxstableapi/` 目录自身）：

| 档位 | 实际 `#include` 的文件数 |
| --- | --- |
| `FrameworksGuard` | **277** |
| `UmbrellaGuard` | **249** |
| `PrivateGuard` | **105** |
| **合计** | **631** |

**零个文件包含两档**（实测 `多档并用的文件: []`）—— 契约被严格遵守。

> **与 60 文档 ZZ-2 的对照**：
> | | 60 文档 ZZ-2 | 本文 BBB-2 |
> | --- | --- | --- |
> | 现象 | 两个枚举成员完全相同 | 631 处 include 指向恒为惰性的守卫 |
> | 是否缺陷 | **否**（语义不同，分开定义正确） | **否**（默认零影响是明确的设计决策） |
> | 共同点 | **重复/冗余的代码被有意保留** | |
>
> **两处都是「明知冗余仍保留」** —— 区别在于 60 文档的冗余无解释，
> **本文的冗余有 5 行注释主动解释**。

---

## 4. 【核心 BBB-3】Guard 逻辑在本仓库内**零验证**

### 4.1 关键条件：`RN_BUILDING` 在 RN 自身的**全部三条**构建路径上都被定义

| 构建系统 | 定义处 | 覆盖范围 |
| --- | --- | --- |
| **iOS / CocoaPods** | `packages/react-native/scripts/cocoapods/utils.rb:130-132` 自动注入 | **77 个 podspec**（实测 `mark_as_react_native_build` 出现文件数） |
| **Android / CMake** | `packages/react-native/ReactAndroid/src/main/jni/CMakeLists.txt:67` | `add_react_common_subdir(...)` 的全部子目录 |
| **Fantom 测试运行器** | `private/react-native-fantom/tester/CMakeLists.txt:43` | 整个 tester 目标 |

**注入逻辑逐字**：

```ruby
# packages/react-native/scripts/cocoapods/utils.rb:120-134
    def self.add_rn_building_definition(spec)
      current_config = spec.to_hash["pod_target_xcconfig"] || {}
      definitions = current_config["GCC_PREPROCESSOR_DEFINITIONS"] || "$(inherited)"

      if definitions.is_a?(Array)
        definitions = definitions.join(" ")
      end

      definitions = "$(inherited)" if definitions.strip.empty?

      return if definitions.include?("RN_BUILDING=1")

      current_config["GCC_PREPROCESSOR_DEFINITIONS"] = "#{definitions.strip()} RN_BUILDING=1".strip()
      spec.pod_target_xcconfig = current_config
    end
```

| 特征 | 说明 |
| --- | --- |
| **幂等** | `return if definitions.include?("RN_BUILDING=1")` |
| **不丢原有定义** | 追加到 `definitions` 尾部，并保留 `$(inherited)` |
| **容忍两种类型** | `if definitions.is_a?(Array) definitions = definitions.join(" ")` |
| **容忍空串** | `definitions = "$(inherited)" if definitions.strip.empty?` |

### 4.2 由此得到的结论：三档守卫在本仓库内**永远不会被执行**

**逻辑链**：

| 步骤 | 事实 |
| --- | --- |
| ① | 三个 `#if` 的第一个条件都是 `defined(RN_STRICT_API)` |
| ② | `RN_STRICT_API` **全仓未定义**（§3.1） |
| ③ | **即使**定义它：RN 自身的每条构建路径都定义了 `RN_BUILDING`（§4.1） |
| ④ | `RN_BUILDING` 是三档的**最后一个**条件（`!defined(RN_BUILDING)`） |
| ⑤ | **结论：RN 自身的构建永远无法触发任何一档守卫** |

**即 631 处 `#include` 从未被守卫逻辑检验过。**

> **这是设计的必然结果**（守卫是给消费者用的），
> **但有一个未被记录的后果**：
>
> | 问题 | 说明 |
> | --- | --- |
> | 守卫的**语义**（该报错时报错、该放行时放行） | **在本仓库零验证** |
> | 631 处 include 的**档位归属**是否正确 | **零验证** —— 若某个 private 档文件被误标为 `UmbrellaGuard`，消费者打开 `RN_STRICT_API` 时才会发现 |
> | umbrella 头的 `push_macro`/`pop_macro` 块是否正确 | **零验证** —— 若块写错，同样只在消费者侧暴露 |
>
> **本轮未找到任何 CI 任务或测试定义 `RN_STRICT_API`**（§3.1 的全仓检索覆盖
> `.js`/`.rb`/`.json`/`.yml`/`.podspec`/`CMakeLists.txt`/`.cmake`/`.gradle`/`.h` 等全部文本类型）。

### 4.3 但 `RN_BUILDING` 的注入位置有 6 行注释解释 —— 第一档

```cmake
# packages/react-native/ReactAndroid/src/main/jni/CMakeLists.txt:61-67
# Marks everything added below as React Native's own build, so the
# react/cxxstableapi guards let internal sources keep including the
# fine-grained headers they fence off from consumers. Deliberately declared
# after the third-party subdirectories so it never reaches them, and this
# project never compiles app or third-party module code (those build against
# the prefab artifacts through ReactNative-application.cmake).
add_compile_definitions(RN_BUILDING)
```

| 注释要素 | 原文要点 |
| --- | --- |
| **做什么** | `Marks everything added below as React Native's own build` |
| **为什么** | `so the react/cxxstableapi guards let internal sources keep including the fine-grained headers` |
| **位置约束** | `Deliberately declared after the third-party subdirectories so it never reaches them` |
| **边界声明** | `this project never compiles app or third-party module code (those build against the prefab artifacts through ReactNative-application.cmake)` |

**「位置约束」与「边界声明」两条尤其重要** —— 它们解释了
**为什么这一行不能上移**（会泄漏给 third-party 子目录）
**以及为什么这样放置是安全的**（本 target 不编译 app 代码）。

**iOS 侧的对应注释同样完整**：

```ruby
# packages/react-native/scripts/cocoapods/utils.rb:113-118
    # The react/cxxstableapi guards turn a direct include of a fine-grained React Native
    # header into an error for consumers that opt into RN_STRICT_API. React Native's own
    # sources are exempt via RN_BUILDING, so every first-party pod defines it. Third-party
    # pods must never get it, or they would silently opt out of the guards.
```

| 要素 | 原文要点 |
| --- | --- |
| 机制 | `turn a direct include of a fine-grained React Native header into an error` |
| 例外 | `React Native's own sources are exempt via RN_BUILDING, so every first-party pod defines it` |
| **禁止项 + 后果** | **`Third-party pods must never get it, or they would silently opt out of the guards.`** |

**而调用侧 `react_native_pods.rb:315-319` 又重复了一次「必须最后调用」的契约**：

```ruby
# Call it last in the spec block: it merges into GCC_PREPROCESSOR_DEFINITIONS as
# pod_target_xcconfig stands at call time, so a later assignment would drop it.
```

| 层 | 职责 |
| --- | --- |
| `react_native_pods.rb:315-326` | **公共包装函数的 YARD 注释**（用途 + 调用时机契约） |
| `cocoapods/utils.rb:113-118` | **实现的注释**（机制 + 为什么 third-party 不能拿） |

**同一契约在两个层次各写一遍** —— 与 57 文档 WW-10（同步判定规则三处各写一遍）同型，
**但此处是有意的分层**（YARD 给调用者、实现注释给维护者），**不是缺陷**。

---

## 5. 【核心 BBB-4】注释引用了不存在的脚本 —— 锚点失效的第三例

### 5.1 逐字引用

```cpp
// packages/react-native/ReactCommon/react/cxxstableapi/UmbrellaGuard.h:49-50
//                        `scripts/add-cxxstableapi-guard.js --tier=public`
//                        emits this block; do not hand-write or "simplify" it.
```

### 5.2 全仓检索：**该脚本不存在**

| 检查 | 结果 |
| --- | --- |
| `ls -la scripts/add-cxxstableapi-guard.js` | `No such file or directory` |
| 全仓检索 `add-cxxstableapi-guard`（排除 `node_modules`/`.git`） | **仅 1 处命中** —— `UmbrellaGuard.h:49`（即上面这行注释本身） |

### 5.3 锚点失效的三种成因（累计）

| 成因 | 实例 | 注释的**动作** | 读者后果 |
| --- | --- | --- | --- |
| **对方改名** | 59 文档 `createErrorFromErrorData` | 引用函数名 | 找不到函数 |
| **对方整层被移除** | 61 文档 `RCTScrollContentShadowView.m` | 引用文件名 | 找不到文件 |
| **对方从未入库 / 内部工具** | **本文 add-cxxstableapi-guard.js（已核实全仓不存在）** | **引用脚本路径 + 命令行参数** | **无法执行「重新生成」** |

**本文这一例最严重** —— 前两例至少还能靠搜索找到线索，
**本例的命令行（`--tier=public`）暗示存在一个可复现的生成流程，但该流程在 OSS 里不可用。**

### 5.4 后果的具体分析

注释说 `emits this block; do not hand-write or "simplify" it`，
**「block」指 `push_macro`/`pop_macro` 那一段**（`:34-40`）。

| 问题 | 说明 |
| --- | --- |
| 631 处 include **已经存在**于仓库中 | 即生成器**曾经运行过**，或由内部工具/人工插入 |
| 生成器**不在仓库里** | 新增头文件时**无法按既定流程**插入守卫块 |
| 注释还禁止手写 | **既不能用工具、又被禁止手写** —— 新增头文件时只剩「跳过」或「违反注释」两条路 |
| `--tier=public` 参数形式 | **暗示还有 `--tier=` 的其他取值** —— 与三档 Guard 的对应关系**未在任何注释中给出** |

> **未验证项**：三档 Guard 与 `--tier=` 取值的对应关系。
> 本轮**未找到**任何说明 `UmbrellaGuard` ↔ `public`、
> `FrameworksGuard` ↔ `frameworks`、`PrivateGuard` ↔ `private` 的映射表。
> **只能从 `UmbrellaGuard.h:9` 的 `*public* module header` 与三份文件的档位命名推断。**

---

## 6. 【核心 BBB-5·正向】`StableApiAnchor.cpp`：一个纯为构建系统而存在的空 TU

### 6.1 全文（22 行，无任何声明）

```cpp
// packages/react-native/ReactCommon/react/cxxstableapi/StableApiAnchor.cpp:8-18
// Anchor translation unit for the `react/cxxstableapi` pod.
//
// The guards in this module are pure preprocessor headers, so the pod would
// otherwise ship no compilable source. CocoaPods emits a PBXAggregateTarget for
// a pod with no compilable sources, and an aggregate target produces no
// `.framework` under `use_frameworks!` — dependents are then unable to resolve
// the guard headers. Giving the pod a single source file forces CocoaPods to
// emit a real framework target instead.
//
// This file intentionally declares nothing: `react/cxxstableapi` has no runtime
// API, only preprocessor guards. Do not add code here.
```

### 6.2 注释给出的完整因果链（5 步）

| 步骤 | 内容 |
| --- | --- |
| ① | guards 是纯预处理器头 |
| ② | 故该 pod **没有可编译源文件** |
| ③ | CocoaPods 对「无可编译源文件的 pod」发 `PBXAggregateTarget` |
| ④ | aggregate target 在 `use_frameworks!` 下**不产出 `.framework`** |
| ⑤ | → 依赖方**无法解析守卫头** → 给一个源文件即强制产出真 framework |

### 6.3 与「构建系统限制」有关的另一处：Android 侧不编译这个文件

**两个构建系统对这个模块的处理完全不同**：

| 构建系统 | 定义 | `StableApiAnchor.cpp` 是否编译 |
| --- | --- | --- |
| **CMake / Android** | `add_library(react_cxxstableapi INTERFACE)` | **否** —— `INTERFACE` 库无源文件 |
| **CocoaPods / iOS** | `s.source_files = podspec_sources("*.{cpp,h}", "*.h")` | **是** —— `*.cpp` 匹配 |

```cmake
# packages/react-native/ReactCommon/react/cxxstableapi/CMakeLists.txt:11-18
# Header-only: the cxxstableapi guards are pure preprocessor headers, so this is
# an INTERFACE library. Headers resolve as <react/cxxstableapi/*.h> via the
# shared ${REACT_COMMON_DIR} include root.
add_library(react_cxxstableapi INTERFACE)

target_include_directories(react_cxxstableapi INTERFACE ${REACT_COMMON_DIR})
target_compile_reactnative_options(react_cxxstableapi INTERFACE)
target_compile_options(react_cxxstableapi INTERFACE -Wpedantic)
```

**两侧的差异是自洽的**：

| | CocoaPods | CMake |
| --- | --- | --- |
| 需要产出一个可被解析的产物 | ✅ 需要 `.framework`（`use_frameworks!`） | ❌ `INTERFACE` 库 + `target_include_directories` 已足够 |
| 故需要空 TU | ✅ | ❌ |
| 注释是否说明 | ✅ `packages/react-native/ReactCommon/react/cxxstableapi/StableApiAnchor.cpp:10-15`（5 步因果） | ✅ `CMakeLists.txt:11-12`（2 句） |

**两侧的注释都与各自构建系统的实际做法一致** —— 这是一处**注释与代码严格对应**的样本。

### 6.4 `-Wpedantic` 通过 INTERFACE 传播到 78 个文件

`target_compile_options(react_cxxstableapi INTERFACE -Wpedantic)` 是
**INTERFACE 编译选项**，凡 `target_link_libraries(... react_cxxstableapi)` 的目标都会继承。

| 实测 | 值 |
| --- | --- |
| 引用 `react_cxxstableapi` 的文件数 | **78** |
| 引用出现次数 | **82** |

**这意味着 78 个 CMake 文件的目标都被要求通过 `-Wpedantic`** ——
**一个纯预处理器模块的编译选项影响面是 78 个文件**。

> **未验证项**：这 78 个目标当前是否真的零 `-Wpedantic` 告警。
> **本轮未执行 CMake 配置与编译**，故不判定。

### 6.5 `set(CMAKE_VERBOSE_MAKEFILE on)` 不是本模块的问题

`CMakeLists.txt:8` 有 `set(CMAKE_VERBOSE_MAKEFILE on)`。

**全仓检索**：`CMAKE_VERBOSE_MAKEFILE` 出现 **137 处**（`CMakeLists.txt` + `*.cmake`，排除 `node_modules`）。

**即这是 RN 的全仓库约定**（几乎每个模块的 `CMakeLists.txt` 都有这一行），
**不是 `cxxstableapi` 的局部选择**。

> **记录此项是为了排除一个误判**：`CMAKE_VERBOSE_MAKEFILE` 是**全局变量**
> （CACHE 变量），在子目录 `CMakeLists.txt` 里 `set()` 会影响**整个构建**。
> 单看 `cxxstableapi` 会觉得「一个模块打开了全局详细输出」，
> **实测 137 处说明这是刻意的全局约定** —— **不是缺陷**。

### 6.6 该约定还被**两处生成模板**写入 —— 新生成的 CMakeLists 也带这一行

| 生成源 | 位置 | 实测 |
| --- | --- | --- |
| **codegen 模板** | `packages/react-native-codegen/src/generators/modules/GenerateModuleJniH.js:74` | **1** 处 |
| **gradle-plugin 任务** | `packages/gradle-plugin/react-native-gradle-plugin/src/main/kotlin/com/facebook/react/tasks/GenerateAutolinkingNewArchitecturesFileTask.kt:206` | **1** 处 |

**两处生成的文本逐字相同**：

```
cmake_minimum_required(VERSION 3.13)
set(CMAKE_VERBOSE_MAKEFILE on)
```

**即「137 处同款」不是「137 个模块各自手写」，而是「手写 + 模板生成」共同构成** ——
**新生成的组件 CMakeLists 会自动继承该约定**，
**这解释了为什么该约定能保持全仓一致**。

> **与 52 文档 RR-3 的对照**：那里是「合并阶段的静默覆盖」；
> **这里是「生成期就统一了格式」** —— **同一目标（格式一致）的两种达成方式**：
> 一靠生成期统一（可保证），一靠人工约定（会漂移）。
>
> **本仓库在 CMake 这一层选了生成期统一，且手写部分也保持一致 —— 这是有效设计。**

---

## 7. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **BBB-1** | **【核心·设计】三档 Guard 的严重度与逃逸出口递减**（`#error` / `#warning` / `#error`；逃逸宏 2 / 3 / 1），**`PrivateGuard` 不认 `RN_UMBRELLA_CONTEXT`** | `UmbrellaGuard.h:60`、`FrameworksGuard.h:32`、`PrivateGuard.h:31` | **设计自洽**：private 头零保证，不该有 umbrella；**但「共享契约」的措辞不精确** —— 读者照 `UmbrellaGuard` 推断 `PrivateGuard` 会得到错误结论 |
| **BBB-2** | **【核心】`RN_STRICT_API` 全仓从未被定义**（唯一命中是 `cocoapods/utils.rb:114` 的一个注释词），故 631 处 `#include`（Frameworks 277 / Umbrella 249 / Private 105，零个文件并用两档）在本仓库所有构建中恒为惰性 | 三份 Guard 的 `#if` 首条件；631 处 `#include` | **是设计意图**（`UmbrellaGuard.h:24-29` 主动声明「changes nothing for existing consumers」）；**代价见 BBB-3** |
| **BBB-3** | **【核心】Guard 逻辑在本仓库内零验证** —— `RN_BUILDING` 在**全部三条**构建路径都被定义（iOS 77 个 podspec 自动注入 / Android `jni/CMakeLists.txt:67` / Fantom `CMakeLists.txt:43`），**即使打开 `RN_STRICT_API` 也不会触发** | `cocoapods/utils.rb:120-134`、`jni/CMakeLists.txt:67`、`fantom/tester/CMakeLists.txt:43` | **631 处 include 的档位归属、umbrella 的 `push_macro`/`pop_macro` 块是否正确，全部未被验证** —— 错误只会在消费者侧暴露 |
| **BBB-4** | **【核心】注释引用 `scripts/add-cxxstableapi-guard.js --tier=public`，但该脚本全仓不存在**（唯一命中是这行注释本身） | `UmbrellaGuard.h:49-50` | **锚点失效第三例**（前两例分别见 59 文档的「符号级」与 61 文档的「文件级」）；**最严重的一例** —— 既无工具、又被禁止手写，新增头文件时只剩「跳过」或「违反注释」两条路；**且 `--tier=` 的三档映射未在任何注释中给出** |
| **BBB-5（正面）** | **【核心·正向】三份 Guard 各有 20–30 行注释，明确说明 `RN_*` 宏契约、umbrella 的 `push_macro`/`pop_macro` 用法及其微妙理由（嵌套 + 作用域终止）、以及「为何刻意不加 `#pragma once`」** | `UmbrellaGuard.h:24-58`、`FrameworksGuard.h:20-29`、`PrivateGuard.h:18-28` | **本仓库注释质量第一档的最佳样本** —— 三要素（做什么 / 为什么 / 边界）齐备，且解释了「容易写错但看不出错」的选择 |
| **BBB-6（正面）** | **`RN_BUILDING` 的注入逻辑有 4 处防御**（幂等 `return if include?`、保留 `$(inherited)`、容忍 Array、容忍空串）；**Android 侧注入位置有 6 行注释解释「为何不能上移」与「为何这样放置安全」** | `cocoapods/utils.rb:120-134`、`jni/CMakeLists.txt:61-67` | 正确性有保障；**注入位置的安全性被显式论证** |
| **BBB-7（正面）** | **`StableApiAnchor.cpp` 用 5 步因果链解释「为何需要这个空 TU」**（无源文件 → aggregate target → `use_frameworks!` 下无 `.framework` → 依赖方无法解析守卫头），并明说 `Do not add code here` | `packages/react-native/ReactCommon/react/cxxstableapi/StableApiAnchor.cpp:8-18` | **构建系统限制的完整记录**；两侧构建系统的差异（CMake 用 `INTERFACE` 不编译 / CocoaPods 编译）与各自注释严格对应 |
| BBB-8 | 「共享 `RN_*` 宏契约」的措辞与实现不符（三档条件表达式不同） | `FrameworksGuard.h:20`、`PrivateGuard.h:20` | 读者可能错误推断 `PrivateGuard` 接受 umbrella；**`PrivateGuard.h:17-18` 已隐含承认差异但未指出差异在哪** |
| BBB-9 | `-Wpedantic` 通过 INTERFACE 传播到 **78 个 CMake 文件**的目标 | `CMakeLists.txt:18` | **未验证**这些目标当前是否零告警（本轮未执行 CMake 配置/编译） |
| BBB-10 | `set(CMAKE_VERBOSE_MAKEFILE on)` 在子目录 `CMakeLists.txt` 里影响全局构建 | `CMakeLists.txt:8` | **非缺陷** —— 全仓 **137 处**同款，是刻意的全局约定；**记录此项以排除误判** |

### BBB-2 / BBB-3 的适用范围声明

| 维度 | BBB-2 | BBB-3 |
| --- | --- | --- |
| **平台** | 双端（纯预处理器层，与平台无关） | 双端 + Fantom |
| **架构** | 与架构无关（不涉及 Fabric/Paper） | 同 |
| **编译条件** | 需要消费方构建定义 `RN_STRICT_API` | RN 自身构建**永远不满足**该条件 |
| **当前是否造成功能问题** | **否**（默认零影响是明确设计） | **否**（守卫不执行） |
| **风险类型** | 无 | **验证缺口** —— 631 处 include 的正确性未被任何构建检验 |
| **触发条件（若打开）** | 消费方定义 `RN_STRICT_API` 且不定义 `RN_BUILDING` / `RN_UMBRELLA_CONTEXT` / `RN_ALLOW_FRAMEWORKS` | — |

---

## 8. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 38 文档：注释质量分档（第一档 = 理由 + 外部参考） | **本文 BBB-5 是更高一档的最佳实例** —— 三份 Guard 的注释解释了「容易写错但看不出错」的选择（`push_macro` 而非裸 `#undef`、`不加 `#pragma once`），这是比「理由 + 外部参考」更进一步：**解释了反直觉实现的必要性** |
| 59 文档 YY-3：注释锚点失效（对方改名） | **新增第三类成因（BBB-4）**：对方从未入库 / 内部工具；**后果最重** —— 引用的是「可执行命令」而非符号 |
| 61 文档 AAA-2：对方整层被移除 | 与 BBB-4 共同构成锚点失效的**两种「文件级」成因**（移除 / 从未入库），**区别于 59 文档的「符号级」成因（改名）** |
| 61 文档 AAA-3：钉死 SHA 的外部引用可验证 | **对照**：BBB-4 引用的「内部生成脚本」既未入库也未钉死版本，**是外部引用的最弱形态** |
| 60 文档 ZZ-2：明知冗余仍保留且无解释 | **对照**：BBB-2 的 631 处冗余 include **有 5 行注释主动解释后果** —— **同一形态、有无解释的对照** |
| 57 文档 WW-10：同步判定规则三处各写一遍 | **对照 BBB-6**：`RN_BUILDING` 的契约在 `react_native_pods.rb`（YARD）与 `cocoapods/utils.rb`（实现）各写一遍 —— **同型但此处是有意的分层，非缺陷** |
| 50 文档 PP-1 / PP-3：JNI 层防御不足 | **对照 BBB-6**：`add_rn_building_definition` 的 4 处防御（幂等 / 保留 inherited / 容忍 Array / 容忍空串）是**防御充足**的正样本 |
| 49 文档（`cxx-api` 快照门禁单向：只拦删除不拦新增） | **并列**：两者都是**门禁的方向性问题**。`cxx-api` 快照**拦住了不该发生的改动**；本文 BBB-3 的守卫**在本仓库内根本不生效** —— **两个方向：门禁太紧 vs 门禁太松** |
