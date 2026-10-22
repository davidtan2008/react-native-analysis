---
id: 63
title: "ReactCommon 工具层：一次实测出的 `+inf` 恒不相等、一条被 `unordered_map` 证伪的哈希契约，以及一个 ASan 抓到的 use-after-free"
topic: FD.api
symptoms: [jank, contentgrowth, slowstart, layout]
platforms: [cross]
architecture: [cross]
layer: T4
symbols: ["floatEquality", "SimpleThreadSafeCache", "ContextContainer", "hash_combine"]
claims: [CCC-1, CCC-2, CCC-3, CCC-4, CCC-5, CCC-6, CCC-7, CCC-8, CCC-9, CCC-10, CCC-11, CCC-12, CCC-15]
---
# 63 · ReactCommon 工具层：一次实测出的 `+inf` 恒不相等、一条被 `unordered_map` 证伪的哈希契约，以及一个 ASan 抓到的 use-after-free

> **模块**：Z1 · `packages/react-native/ReactCommon/react/utils/`（本轮读 6 个文件）
>
> **基线**：react-native @ `9b131e42` · 跨平台 C++（`ReactCommon`）· **与架构无关**
>
> **前置**：[53 文档](./53-渲染器核心与Yoga的数值边界.md) 记录 Yoga 测量消毒放行 `±inf`；
> [61 文档](./61-ScrollView状态与裁剪的平台条件.md) 记录裁剪与状态计算；
> [62 文档](./62-CxxStableAPI的三档守卫与它们的惰性.md) 记录 `react/cxxstableapi` 的守卫与惰性。
>
> 本文记录 `react/utils` 里四条**经过实测**（编译 + 运行 / ASan）的结论：
> ① **`floatEquality(+inf, +inf)` 返回 `false`** —— 实测输出，非推断；
> ② **哈希与相等性双向违反容器契约** —— 用真实 `std::unordered_map` 证伪；
> ③ **`ContextContainer::update(self)` 是 use-after-free** —— ASan 抓到；
> ④ **`SimpleThreadSafeCache` 的三个 API 契约问题**（其中 1 个与自身注释矛盾）；
> ⑤ **iOS 渐变在垂直线段时算出错误交点** —— 全仓唯一显式防 `inf` 的调用点，
> **却在自己的 `Line::intersection` 里漏了同一道防御**。

---

## 1. 本轮读的文件（6 个，全部读完）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/ReactCommon/react/utils/FloatComparison.h` | **24** | `floatEquality` 唯一实现 |
| `packages/react-native/ReactCommon/react/utils/hash_combine.h` | **73** | 哈希组合（含 optional 掩码版） |
| `packages/react-native/ReactCommon/react/utils/SimpleThreadSafeCache.h` | **108** | 线程安全 LRU 哈希缓存 |
| `packages/react-native/ReactCommon/react/utils/ContextContainer.h` | **113** | 依赖注入容器 |
| `packages/react-native/ReactCommon/react/utils/OnScopeExit.h` | **38** | RAII 作用域退出 |
| `packages/react-native/ReactCommon/react/utils/Telemetry.h` | **94** | 单调时钟与时间点转换 |

**另有 4 个文件作为证据被引用**（未全读，只取所需片段）：
`packages/react-native/ReactCommon/react/renderer/textlayoutmanager/TextMeasureCache.h`、
`packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp`、
`packages/react-native/ReactCommon/react/renderer/attributedstring/TextAttributes.cpp`、
`packages/react-native/ReactCommon/react/renderer/attributedstring/ParagraphAttributes.cpp`。

---

## 2. 【核心 CCC-1】`floatEquality(+inf, +inf)` 返回 `false` —— 实测

### 2.1 实现全文（24 行文件里的 6 行）

```cpp
// packages/react-native/ReactCommon/react/utils/FloatComparison.h:16-21
constexpr float kDefaultEpsilon = 0.005f;

template <typename T>
inline bool floatEquality(T a, T b, T epsilon = static_cast<T>(kDefaultEpsilon))
{
  return (std::isnan(a) && std::isnan(b)) || (!std::isnan(a) && !std::isnan(b) && std::abs(a - b) < epsilon);
}
```

### 2.2 逐项推导 `+inf` 的命运

| 判据 | 对 `a = b = +inf` 的结果 |
| --- | --- |
| `std::isnan(a) && std::isnan(b)` | **false**（`inf` 不是 NaN） |
| `!std::isnan(a) && !std::isnan(b)` | **true** |
| `std::abs(a - b)` | `std::abs(inf - inf)` = `std::abs(NaN)` = **NaN** |
| `NaN < epsilon` | **false**（任何值与 NaN 比较都是 false） |

**结论：`floatEquality(+inf, +inf) == false`** —— **两个完全相同的无穷大被认为不相等。**

### 2.3 实测输出（编译 + 运行，源码逐字复制自 `FloatComparison.h`）

| 输入 | 结果 |
| --- | --- |
| `floatEquality(+inf, +inf)` | **`false`** |
| `floatEquality(-inf, -inf)` | **`false`** |
| `floatEquality(+inf, -inf)` | `false` |
| `floatEquality(NaN, NaN)` | **`true`** |
| `floatEquality(1.0f, 1.0f)` | `true` |
| `floatEquality(0.0f, 0.005f, 0.005f)` | **`false`**（差值恰为 epsilon，严格 `<` 不含） |
| `floatEquality(5, 5)`（`T = int`） | **`false`**（`static_cast<int>(0.005f)` = 0 → 恒假） |
| `floatEquality(5.0, 5.0)`（`T = double`） | `true`（epsilon = 0.005） |

### 2.4 三条设计取舍并存 —— **其中 ① 是有意且有测试的**

| # | 取舍 | 是否有注释 | 是否有测试 |
| --- | --- | --- | --- |
| ① | **NaN == NaN 视为相等** | `FloatComparison.h` 内**无** | **有**（见 §2.4.1） |
| ② | **`±inf` 与自身不相等**（**缺陷**，非取舍） | — | **无**（见 §2.4.2） |
| ③ | **严格 `<` 不含差值恰为 epsilon 的情形** | **无** | **有**（见 §2.4.1） |

> **① 是有意的、② 是缺陷** —— 两者混在同一个表达式里，
> **读代码时无法区分**。若把 NaN 特判单独抽成一个具名函数，
> ② 的性质就会立刻暴露。

### 2.4.1 ① 与 ③ 是**有意设计且有测试覆盖** —— 实测依据

**全仓唯一提到 `floatEquality` 的测试文件**：
`packages/react-native/ReactCommon/react/renderer/attributedstring/tests/ParagraphAttributesTest.cpp`
（实测：全仓 `*Test*.cpp` 中仅此一个文件出现 `floatEquality`）。

**四个测试逐字记录了意图**：

```cpp
// packages/react-native/ReactCommon/react/renderer/attributedstring/tests/ParagraphAttributesTest.cpp:13-16
// The two Float fields default to NaN, and NaN != NaN under IEEE-754.
// operator== must special-case NaN via floatEquality so two freshly
// default-constructed ParagraphAttributes compare equal.
```

```cpp
// packages/react-native/ReactCommon/react/renderer/attributedstring/tests/ParagraphAttributesTest.cpp:24-27
// operator== compares Float fields with an epsilon tolerance (0.005) rather
// than an exact ==. Differences below the epsilon must still compare equal;
// differences well above the epsilon must compare unequal.
```

```cpp
// packages/react-native/ReactCommon/react/renderer/attributedstring/tests/ParagraphAttributesTest.cpp:44-47
// floatEquality returns true only when *both* operands are NaN or when
// *neither* is. A NaN-vs-finite mismatch in either float field must
// therefore make the instances unequal, even though both operands are
// "invalid" font sizes.
```

| 意图 | 对应测试 |
| --- | --- |
| **NaN == NaN** | `testOperatorEqualsDefaultConstructedInstancesAreEqual`（`:17-25`） |
| **epsilon 容差（< 0.005 相等，> epsilon 不等）** | `testOperatorEqualsFloatFieldsUseEpsilonComparison`（`:29-42`） |
| **NaN vs 有限值 → 不等** | `testOperatorEqualsNaNVsFiniteFloatComparesUnequal`（`:50-58`） |

> **所以 ① 与 ③ 都是刻意设计，不是缺陷。**
> **本节把它们记为「有意的取舍」而非问题。**

### 2.4.2 但 **`±inf` 零测试覆盖**

**实测**：上述测试文件覆盖了 **NaN-NaN、NaN-有限、epsilon 上下界**三种情形，
**没有任何一个测试涉及 `±inf`**。

| 情形 | 有无测试 |
| --- | --- |
| NaN vs NaN | ✅ |
| NaN vs 有限 | ✅ |
| 差值 < epsilon | ✅ |
| 差值 > epsilon | ✅ |
| **差值 == epsilon** | ❌（实测 `floatEquality(0.0f, 0.005f, 0.005f)` = `false`，但无测试记录该边界） |
| **`+inf` vs `+inf`** | ❌ **零覆盖** |
| **`-inf` vs `-inf`** | ❌ **零覆盖** |
| **`+inf` vs `-inf`** | ❌ **零覆盖** |

**即 §2.3 的 `+inf` 恒不相等这一行为，从未被任何断言固定** ——
**既没被认定为「正确」，也没被认定为「缺陷」**。

**且 `react/utils/tests/` 下有 5 个测试文件**（`Base64Tests.cpp`、`fnv1aTests.cpp`、
`hash_combineTests.cpp`、`SimpleThreadSafeCacheTest.cpp`、`UuidTest.cpp`），
**其中没有 `FloatComparison` 的测试** —— **`floatEquality` 本身没有单元测试**。

### 2.5 模板对 `T = int` 无效

`kDefaultEpsilon` 是 `constexpr float`（**不是模板参数**），
`static_cast<T>(kDefaultEpsilon)` 在 `T = int` 时把 `0.005f` **截断为 0**，
于是 `std::abs(a - b) < 0` **恒为 false** —— **`floatEquality(5, 5)` 也是 `false`**。

**模板没有用 `concept` 或 `static_assert` 限制 `T` 必须是浮点类型**，
调用方写错类型得到的是一个**静默恒假**的函数。

### 2.6 `T = double` 时 epsilon 是 float 的精确值

`static_cast<double>(0.005f)` = **0.004999999888241291**（float 的精确值被拓宽），
**不是** double 字面量 `0.005`（= 0.005000000000000000104…）。

**即 `T = double` 的容差与 `T = float` 的容差在数值上并不相同**（差 ~1.1e-16）。
**影响极小，但说明 `kDefaultEpsilon` 的类型选择（`float`）决定了所有实例的容差精度。**

---

## 3. 【核心 CCC-2】哈希与相等性双向违反 `unordered_map` 契约 —— 用真实容器证伪

### 3.1 契约是什么

`std::unordered_map` 要求：**若 `a == b`，则 `hash(a) == hash(b)`**。

### 3.2 RN 的文本测量缓存恰好两边用了不同的判据

**相等侧（epsilon 判据）**：

```cpp
// packages/react-native/ReactCommon/react/renderer/textlayoutmanager/TextMeasureCache.h:143-145
      floatEquality(lhs.fontSize, rhs.fontSize) && floatEquality(lhs.fontSizeMultiplier, rhs.fontSizeMultiplier) &&
      floatEquality(lhs.letterSpacing, rhs.letterSpacing) && floatEquality(lhs.lineHeight, rhs.lineHeight) &&
      floatEquality(lhs.maxFontSizeMultiplier, rhs.maxFontSizeMultiplier);
```

**哈希侧（逐位判据）**：

```cpp
// packages/react-native/ReactCommon/react/renderer/textlayoutmanager/TextMeasureCache.h:148-162
inline size_t textAttributesHashLayoutWise(const TextAttributes &textAttributes)
{
  ...
  facebook::react::hash_combine(
      seed,
      textAttributes.fontFamily,
      textAttributes.fontSize,
      textAttributes.fontSizeMultiplier,
      textAttributes.maxFontSizeMultiplier,
      textAttributes.letterSpacing,
      textAttributes.lineHeight);
```

`hash_combine` 的实现：

```cpp
// packages/react-native/ReactCommon/react/utils/hash_combine.h:22-27
template <Hashable T, Hashable... Rest>
void hash_combine(std::size_t &seed, const T &v, const Rest &...rest)
{
  seed ^= std::hash<T>{}(v) + 0x9e3779b9 + (seed << 6) + (seed >> 2);
  (hash_combine(seed, rest), ...);
}
```

**`std::hash<float>` 哈希的是原始位模式**（libc++ / libstdc++ 均如此）→ **逐位精确**。

### 3.3 容器确实是哈希表，不是线性扫描

```cpp
// packages/react-native/ReactCommon/react/utils/SimpleThreadSafeCache.h:100-106
  size_t maxSize_;
  mutable std::mutex mutex_;
  mutable std::list<EntryT> list_;
  mutable std::unordered_map<KeyT, iterator> map_;
```

`map_.find(key)` 先按 `hash<KeyT>` 选桶，再按 `operator==` 比对 —— **两个判据必须一致**。

### 3.4 实测：两个方向的违反（用真实 RN 头文件 + 真实 `std::unordered_map`）

| # | 场景 | `operator==` | `hash` | `unordered_map::find` | 说明 |
| --- | --- | --- | --- | --- | --- |
| ① | `fontSize = 16.0f` vs `16.0004f`（差 0.0004 < 0.005） | **`true`** | **不同**（240982999006 vs 240982983056） | **落空** | **`==` 为真却查不到 —— 契约违反（方向 A）** |
| ② | `fontSize = +inf` vs `+inf` | **`false`** | **相同** | **落空** | **哈希一致却不相等 —— 契约违反（方向 B）** |

**两个方向都被实测确认。**

### 3.4.1 **公平说明：容差本身是有意且有测试的**

§2.4.1 已证明：`operator==` 使用 epsilon 容差是**刻意设计**，且
`ParagraphAttributesTest.cpp:29-42` 明确断言「差值 0.001 → 相等、差值 1.0 → 不等」。

**即「容差」不是 bug。** 缺陷在于**容差只被应用在相等侧，没有被应用在哈希侧** ——
**这是「实现了一半的意图」，比「意图错误」更隐蔽**。

### 3.4.2 **容器级契约零测试覆盖**

**实测**：`packages/react-native/ReactCommon/react/utils/tests/SimpleThreadSafeCacheTest.cpp`
的 2 个测试项只覆盖「基本插入/获取」与「淘汰」，
**没有任何一个测试断言「两个 `==` 的 key 能在同一个缓存里互相命中」**。

| 应有的契约测试 | 现状 |
| --- | --- |
| `a == b` ⟹ `find(b)` 命中 | **无** |
| `hash(a) == hash(b)` ⟹ `a == b` | **无** |
| `±inf` 作为 key 的行为 | **无** |

**即「`a == b` ⟹ `hash(a) == hash(b)`」这条 `unordered_map` 的基本契约，
在本仓库的整个文本缓存链路上没有任何一处断言。**

### 3.5 方向 A 的直接后果：**容差对缓存完全无效**

**逻辑**：

| 步骤 | 事实 |
| --- | --- |
| ① | 缓存是 `unordered_map` → **先按哈希选桶** |
| ② | 两个「容差内相等但位模式不同」的 key → **哈希不同 → 不同桶** |
| ③ | `map_.find(key)` **只在自己的桶里找** → **永远找不到另一个桶里的等价条目** |
| ④ | **结论：`floatEquality` 的 0.005 容差，对缓存命中率贡献为零** |

> **即容差只在「位模式相同」时生效 —— 而那时精确比较本来就相等。**
>
> **换言之：`areTextAttributesEquivalentLayoutWise` 里的 `floatEquality` 在缓存语境下是**「无效代码」**。
>
> | 它想解决的问题 | 实际效果 |
> | --- | --- |
> | 「不同来源算出的 fontSize 只差最后几位，应视为同一个」 | **完全没实现** —— 这些值落在不同桶，永远 miss |
> | **真实效果** | **每次都插入新条目 → 缓存被污染 → 淘汰更频繁 → 命中率进一步下降** |

**这正是用户关注的「启动速度变慢 / 内容增长过快」的一类机理**：
**缓存条目数被无谓地放大**，且**放大到 1024 上限后开始淘汰**（`kSimpleThreadSafeCacheSizeCap = 1024`）。

### 3.6 方向 B 的后果更严重：`+inf` 让缓存**永久**失效

**§2 已证**：`floatEquality(inf, inf) == false`。
**53 文档已证**：Yoga 的测量消毒**放行 `±inf`**（`isUndefined(inf)` 为 false、`inf < 0` 为 false）。

**两个已证事实相加 → 一个 `+inf` 就能击穿缓存。**

**`floatEquality` 的全部消费点（实测：13 个文件 / 41 行 / 44 次出现）**：

| # | 文件 | 出现次数 | `floatEquality` 用在哪 | `+inf` 时的后果 |
| --- | --- | --- | --- | --- |
| ① | `packages/react-native/ReactCommon/react/renderer/textlayoutmanager/TextMeasureCache.h` | **5 行 / 7 次** | 文本测量缓存的 key 相等性（`:143-145`）+ `pointScaleFactor`（`:276`、`:289`） | **测量缓存永久不命中** → 每次重新测量文本 |
| ② | `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp` | 2 行 / 2 次 | `:500` `!floatEquality(fontSizeMultiplier, ...)` → `markDirtyAndPropagate()`；`:523` 「子节点未变化则跳过」 | **每次都标脏** → **Yoga 布局缓存永久失效**；**`continue` 永不触发** → 每次布局都重配置整棵子树 |
| ③ | `packages/react-native/ReactCommon/react/renderer/attributedstring/TextAttributes.cpp` | **7 次** | `TextAttributes::operator==`（`:177-183`） | **文本 props 永远判定为「已变更」** |
| ④ | `packages/react-native/ReactCommon/react/renderer/components/text/BaseTextProps.cpp` | **7 次** | 文本 props 的相等判定（`:379`、`:384`、`:423`） | 同上 |
| ⑤ | `packages/react-native/ReactCommon/react/renderer/attributedstring/ParagraphAttributes.cpp` | 2 次 | `ParagraphAttributes::operator==`（`:36-37`） | 同上 |
| ⑥ | `packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp` | 2 次 | `:197-200` `findUsableLayout()` 在 `measuredLayouts_` 中查找可复用的测量结果 | **测量结果永不命中** → 重复布局文本 |
| ⑦ | `packages/react-native/ReactCommon/react/renderer/components/text/platform/android/react/renderer/components/text/HostPlatformParagraphProps.cpp` | 2 次 | `:119-128` 计算需要下发给平台的 props 差异 | **每次都下发这两个 prop** → 每次跨桥传输（**仅 Android**） |
| ⑧ | `packages/react-native/ReactCommon/react/renderer/components/textinput/platform/android/react/renderer/components/androidtextinput/AndroidTextInputProps.cpp` | 1 次 | `:392` Android 文本输入 props 的相等判定 | 同上（**仅 Android**） |
| ⑨ | `packages/react-native/ReactCommon/react/renderer/graphics/Transform.cpp` | 2 次 | `:334`、`:339` `floatEquality(transform.at(i,i), -1.0f)` 检测翻转 | **不受 inf 影响** —— 与常量 `-1` 比较而非自比较（见 §3.6.1） |
| ⑩ | **`packages/react-native/React/Fabric/Utils/RCTGradientUtils.mm`** | **8 次（最多）** | 渐变几何运算（`:49`、`:61`、`:112`、`:126`、`:188`、`:194`、`:199`、`:346`） | **⚠️ 会产生错误几何结果 —— 见 §3.9** |
| ⑪ | **`packages/react-native/React/Fabric/Mounting/ComponentViews/ScrollView/RCTEnhancedScrollView.mm`** | 1 次 | `:315` 判断滚动内容是否超出容器宽度 | **不受影响** —— 与容器宽度比较 |
| ⑫ | `packages/react-native/ReactCommon/react/renderer/debug/debugStringConvertibleUtils.h` | 1 次 | 调试输出中「值与默认值相同则省略该字段」 | **恒不省略** —— 仅影响调试输出可读性，**无害** |
| ⑬ | `packages/react-native/ReactCommon/react/utils/FloatComparison.h` | 1 次 | **定义处** | — |

### 3.6.1 为什么 ⑨ 与 ⑪ 不受 `inf` 影响

**区别在于比较的对象**：

| 用法 | 形式 | `inf` 时 |
| --- | --- | --- |
| **自比较**（①②③④⑤⑥⑦⑧） | `floatEquality(x, x)` | **`false`** —— 两个相同的 `inf` 被判为不等 |
| **与常量比较**（⑨⑪） | `floatEquality(x, -1.0f)` | **`false`** —— **这正是期望结果**（`inf` 确实不等于 `-1`） |

**即 `floatEquality` 的缺陷只在「自比较」时暴露** —— 而**自比较正是缓存与相等判定的标准用法**。

### 3.7 ③ 与 ④ 的原文（布局缓存的失效点）

```cpp
// packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:493-503
  // A measurable node's measurement depends on `fontSizeMultiplier`, but unlike
  // `pointScaleFactor` it is not part of the Yoga config, so a change does not
  // invalidate Yoga's layout cache. Dirty the node when it changes to force
  // re-measurement. We propagate up to the root so an unchanged, still-cached
  // ancestor isn't skipped by `calculateLayoutInternal` before reaching us.
  if (ReactNativeFeatureFlags::enableFontScaleChangesUpdatingLayout() &&
      getTraits().check(ShadowNodeTraits::Trait::MeasurableYogaNode) &&
      !floatEquality(
          getLayoutMetrics().fontSizeMultiplier, fontSizeMultiplier)) {
    yogaNode_.markDirtyAndPropagate();
  }
```

```cpp
// packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:519-527
    if (child.yogaTreeHasBeenConfigured_ &&
        childLayoutMetrics.pointScaleFactor == pointScaleFactor &&
        floatEquality(
            childLayoutMetrics.fontSizeMultiplier, fontSizeMultiplier) &&
        childLayoutMetrics.wasLeftAndRightSwapped == swapLeftAndRight &&
        childErrata == child.resolveErrata(errata)) {
      continue;
    }
```

> **注释（`:493-497`）写的是「Dirty the node when it changes」** ——
> **但实现是 `!floatEquality(...)`，即「当它【不】相等时标脏」。**
> **在 `+inf` 下 `floatEquality` 恒为 false → `!false` = true → 每次都标脏**，
> **与「when it changes」的意图完全相反。**
>
> **这是 §2 的缺陷在布局层的具体放大。**

### 3.9 【核心 CCC-15】iOS 渐变：`+inf` 斜率让「平行线求交」返回**错误几何**而非 `nullopt`

#### 3.9.1 唯一一处显式处理 `inf` 的调用点 —— 但处理得**不完整**

```cpp
// packages/react-native/React/Fabric/Utils/RCTGradientUtils.mm:46-64
  CGFloat getSlope() const
  {
    CGFloat dx = p2.x - p1.x;
    if (floatEquality(dx, 0.0)) {
      return std::numeric_limits<CGFloat>::infinity();
    }
    return (p2.y - p1.y) / dx;
  }

  CGFloat getPerpendicularSlope() const
  {
    CGFloat slope = getSlope();
    if (std::isinf(slope)) {
      return 0.0;
    }
    if (floatEquality(slope, 0.0)) {
      return -std::numeric_limits<CGFloat>::infinity();
    }
    return -1 / slope;
  }
```

**这是全仓 41 个调用点中**唯一**一处显式写了 `std::isinf` 的地方**。

> **这本身就是 CCC-1 的最强佐证**：
> **若 `floatEquality` 自己正确处理 `inf`，`getSlope` 根本不需要「主动返回 `inf`」，
> `getPerpendicularSlope` 也不需要「先 `isinf` 再判断」这两道防御。**
> **即：inf 的处理成本被推给了每一个调用方，而 41 处里只有 1 处认领了这份成本。**

#### 3.9.2 但同一文件的 `Line::intersection` **没有**这道防御

```cpp
// packages/react-native/React/Fabric/Utils/RCTGradientUtils.mm:108-117
  std::optional<CGPoint> intersection(const Line &other) const
  {
    CGFloat n = other.m;
    CGFloat c = other.b;
    if (floatEquality(m, n)) {
      return std::nullopt;
    }
    CGFloat x = (c - b) / (m - n);
    return point(x);
  }
```

**判据 `floatEquality(m, n)` 的意图是「斜率相同 → 平行 → 无交点」** ——
**当两条线都是垂直线时，`m == n == +inf`，而 `floatEquality(inf, inf)` 返回 `false`**（§2.3 实测）
→ **不返回 `nullopt`** → 继续计算 `x = (c - b) / (inf - inf)` = **`NaN`**。

#### 3.9.3 实测：两个场景都算出了**错误结果**

| 场景 | 条件 | `floatEquality(m, n)` | 返回 | 是否可被调用方察觉 |
| --- | --- | --- | --- | --- |
| **A** | `efLine` 斜率有限（2.0）、平行线斜率 `+inf`（**垂直渐变段**） | `false` | 交点 = **(0, 1)** —— `x = (c-b)/(2.0 - inf)` = `(c-b)/(-inf)` = `-0.0` | **❌ 完全察觉不到** —— 是**有限的错误坐标** |
| **B** | 两条线斜率都是 `+inf` | `false` | 交点 = **(nan, nan)** | ⚠️ 数值可疑，但 `has_value()` 仍为 true |
| **对照** | 两条线斜率都是 `2.0`（普通平行线） | **`true`** | **`nullopt`** ✅ | — |

**场景 A 是最危险的** —— **结果是有限值，调用方完全无法察觉几何已经错了。**

#### 3.9.4 生产路径：调用方的守卫拦不住

```cpp
// packages/react-native/React/Fabric/Utils/RCTGradientUtils.mm:367-379
  Line aParallelLine(cd.getSlope(), a);
  Line bParallelLine(cd.getSlope(), b);

  std::optional<CGPoint> g_opt = efLine.intersection(aParallelLine);
  std::optional<CGPoint> h_opt = efLine.intersection(bParallelLine);

  if (g_opt && h_opt) {
    LineSegment gh(*g_opt, *h_opt);
    LineSegment result = gh.divided({bounds.width, bounds.height});
    return {result.p1, result.p2};
  }

  return {startPoint, endPoint};
```

**`if (g_opt && h_opt)` 检查的是 `has_value()`** ——
**而 §3.9.3 的场景 A 返回的是「有值的 optional，装着一个错误坐标」** → **守卫放行**。

**触发条件**：渐变的某一段是**垂直的**（`dx == 0` → `getSlope()` 返回 `+inf`）。

**后果**：返回的渐变线段端点坐标错误（场景 A）或为 NaN（场景 B）→ **渐变渲染异常**。

#### 3.9.5 CCC-15 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | **仅 iOS**（`React/Fabric/Utils/RCTGradientUtils.mm`；Android 侧无对应实现） |
| **架构** | Fabric（文件位于 `React/Fabric/`） |
| **触发条件** | 渐变几何中出现**垂直线段**（`p2.x - p1.x == 0`）→ 斜率为 `+inf` |
| **后果** | 场景 A：**有限但错误的交点坐标**（调用方无法察觉）；场景 B：**NaN 交点** |
| **是否实机验证** | **未实机验证** —— 本轮以**逐字复刻的等价代码编译运行**证明了 `intersection` 的行为，**未跑 RN 的渐变渲染** |
| **修复方向** | ① 让 `floatEquality` 正确处理 `inf`（自比较时 `inf == inf` 应为 true）；② 或在 `intersection` 里改用 `m == n`（原生比较，`inf == inf` 为 true） |

> **② 是更小的改动**：`m == n` 对 `inf` 天然正确。
> **但要注意 `m == n` 是精确比较** —— 原本的容差是为了处理「斜率几乎相同」，
> **改成精确比较会改变行为**，故**不能简单替换**。
> **正确修法是给 `floatEquality` 增加 `isinf` 分支**：
> `return (isnan(a) && isnan(b)) || (isinf(a) && isinf(b) && ((a > 0) == (b > 0))) || (...)`。

### 3.8 CCC-2 的适用范围声明

| 维度 | 条件 |
| --- | --- |
| **平台** | 双端（`ReactCommon` 共享 C++） |
| **架构** | Fabric 与 legacy 均受影响（`floatEquality` 在 `ReactCommon` 共享层） |
| **触发条件** | ① 任何「容差内但位模式不同」的浮点属性值；② 任何 `±inf` 的浮点属性值 |
| **受影响缓存** | 文本测量缓存、文本行测量缓存、准备文本缓存、Yoga 布局缓存 |
| **是否需要 `enableFontScaleChangesUpdatingLayout` flag** | **③ 需要**（flag 关闭则 ③ 不生效；① ② ④–⑧ 不受影响） |
| **是否已确认造成可观测的性能问题** | **未实机验证** —— 本轮只做了逻辑与容器层面的证明，**未做端到端压测** |

---

## 4. 【核心 CCC-3】`ContextContainer::update(self)` —— ASan 抓到的 use-after-free

### 4.1 实现全文

```cpp
// packages/react-native/ReactCommon/react/utils/ContextContainer.h:59-73
  /*
   * Updates the container with values from a given container.
   * Values with keys that already exist in the container will be replaced with
   * values from the given container.
   */
  void update(const ContextContainer &contextContainer) const
  {
    std::unique_lock lock(mutex_);

    for (const auto &pair : contextContainer.instances_) {
      instances_.erase(pair.first);
      instances_.insert(pair);
    }
  }
```

### 4.2 两个独立的问题

| # | 问题 | 触发条件 |
| --- | --- | --- |
| ① | **自更新时迭代器失效** —— `instances_.erase(pair.first)` **使正在遍历的 `instances_` 的迭代器失效** | `update(*this)` |
| ② | **跨容器读未加锁** —— 遍历 `contextContainer.instances_` 时**只锁了 `this->mutex_`**，**没有锁对方的锁** | 任意两个不同容器并发写 |

### 4.3 实测：ASan 抓到 heap-use-after-free

**用与源码逻辑等价的最小复现**（3 个 key），AddressSanitizer 输出：

| 项 | 值 |
| --- | --- |
| 错误类型 | **`AddressSanitizer: heap-use-after-free`** |
| 读操作 | `std::string::__is_long` （即读已释放的 key 字符串） |
| 调用栈关键帧 | `std::unordered_map::insert` → `std::__try_key_extraction` → `ContextContainer::update(ContextContainer const&) const` |
| 崩溃行 | 复现程序的 `instances_.insert(pair);`（对应 `packages/react-native/ReactCommon/react/utils/ContextContainer.h:70`） |

**即：`update(*this)` 在第一次 `erase` 之后就使用了已释放的内存。**

### 4.4 现状：`update()` **无生产调用方**

**实测**：全仓检索 `ContextContainer` 的消费方（`packages/react-native/`，排除 `tests/`）有 **12+ 个文件**，
但 **`update(` 的调用点为 0**。

| 项 | 判定 |
| --- | --- |
| 是否当前可触发 | **否** —— 无调用方 |
| 风险类型 | **潜伏缺陷**（public API，导出到稳定 API 头） |
| 修复成本 | **极低** —— 加一个 `if (this == &contextContainer) return;` 即可消除 ① |

> **与 62 文档 BBB-4 的对照**：BBB-4 的问题是**注释指向不存在的工具**；
> **本文的 ① 是注释描述了一个未实现的契约** ——
> `update` 的文档说「Values with keys that already exist **will be replaced**」，
> 但实现是 `erase` + `insert`，**在自更新场景下这个契约直接崩溃**。
>
> **两者都是「注释/文档承诺 > 代码实现」。**

### 4.5 `at<T>()` / `find<T>()` 的类型转换无任何校验

```cpp
// packages/react-native/ReactCommon/react/utils/ContextContainer.h:74-107
  template <typename T>
  T at(const std::string &key) const
  {
    std::shared_lock lock(mutex_);

    react_native_assert(
        instances_.find(key) != instances_.end() && "ContextContainer doesn't have an instance for given key.");
    return *static_cast<T *>(instances_.at(key).get());
  }
```

**存储侧是 `std::shared_ptr<void>`**（`:111`），取出时用 **`static_cast<T *>` 从 `void*` 强转**。

| 项 | 说明 |
| --- | --- |
| **类型安全** | **完全依赖调用方的约定** —— 注释明说「Convention is to use the plain base class name for the key」（`:33-37`），即**约定比类型系统更强** |
| **实际风险** | 请求错误的 `T` → `static_cast` 到错误类型 → **未定义行为**（读取错误布局的对象） |
| **debug 保护** | `react_native_assert` **只检查 key 是否存在，不检查类型** |
| **release 保护** | 无 —— `.at(key)` 在 key 不存在时抛 `std::out_of_range`（与文档「Throws an exception」一致 ✓） |

---

## 5. 【核心 CCC-4】`SimpleThreadSafeCache` 的三个 API 契约问题

### 5.1 问题一：无 generator 的 `get(key)` **返回「有值的 optional」而非「空 optional」**

```cpp
// packages/react-native/ReactCommon/react/utils/SimpleThreadSafeCache.h:59-75
  /*
   * Returns a value from the map with a given key.
   * If the value wasn't found in the cache, returns empty optional.
   * Can be called from any thread.
   */
  std::optional<ValueT> get(const KeyT &key) const
  {
    std::lock_guard<std::mutex> lock(mutex_);

    if (auto it = map_.find(key); it != map_.end()) {
      // Move accessed item to front of list
      list_.splice(list_.begin(), list_, it->second);
      return it->second->second;
    }

    return ValueT{};
  }
```

**返回值类型是 `std::optional<ValueT>`，而 `return ValueT{};` 会被隐式转换成「**含一个默认构造值**的 optional」**。

| 调用方写法 | 头文件注释声称 | **实际（有测试背书）** |
| --- | --- | --- |
| `if (auto v = cache.get(key)) { ... }` | miss 时 `v` 为空 | **miss 时 `v` 有值**（`ValueT{}`） |
| `cache.get(key).has_value()` | miss → `false` | **miss → `true`** |

> **重要修正：这不是「实现与注释矛盾」，而是「注释与实现矛盾，而测试站在实现一边」。**
>
> **测试逐字固定了实际行为**：
>
> ```cpp
> // packages/react-native/ReactCommon/react/utils/tests/SimpleThreadSafeCacheTest.cpp:13-17
> TEST(EvictingCacheMapTest, BasicInsertAndGet) {
>   SimpleThreadSafeCache<int, std::string, 3> cache;
>   EXPECT_EQ(cache.get(1), ""); // Default constructed value is returned
>   EXPECT_EQ(cache.get(2), ""); // Default constructed value is returned
>   EXPECT_EQ(cache.get(3), ""); // Default constructed value is returned
> ```
>
> **注释 `// Default constructed value is returned` 明确说明「miss 返回默认构造值」是预期行为**，
> 且 `EXPECT_EQ(cache.get(1), "")` 在 optional 为空时**会失败**（空 optional 不等于 `""`）
> —— **测试反过来锁死了「miss 必须返回有值的 optional」**。
>
> | 项 | 判定 |
> | --- | --- |
> | **实现的行为** | **有意且有测试固定** |
> | **头文件的注释「returns empty optional」** | **❌ 陈旧且错误** —— **这才是缺陷** |
> | **无生产调用方使用该重载** | 实测确认（生产代码只用带 generator 的形式） |
>
> **即 CCC-4① 的准确表述是：「头文件注释与已被测试固定的行为矛盾」**，
> **而不是「实现有 bug」**。
>
> **这类缺陷同样有害** —— 任何按注释写代码的调用方都会写出 `if (auto v = get(k))` 而永远得到 true 分支。
> **但修复位置是注释，不是实现。**

### 5.2 问题二：`getWithKey` 返回**裸指针**，且在**锁外**使用

```cpp
// packages/react-native/ReactCommon/react/utils/SimpleThreadSafeCache.h:44-57
  /*
   * Returns pointers to both the key and value from the map with a given key.
   * If the value wasn't found in the cache, constructs the value using given
   * generator function, stores it inside a cache and returns it.
   * Can be called from any thread.
   */
  std::pair<const KeyT *, const ValueT *> getWithKey(const KeyT &key, CacheGeneratorFunction<ValueT> auto generator)
      const
  {
    auto it = getMapIterator(key, std::move(generator));
    return std::make_pair(&it->first, &it->second->second);
  }
```

| 问题 | 说明 |
| --- | --- |
| **指针指向哪里** | `&it->first` 与 `&it->second->second` 指向 **`std::list` 节点内部**（`EntryT = std::pair<KeyT, ValueT>`） |
| **锁何时释放** | `getMapIterator` 内的 `std::lock_guard` 在**函数返回时析构** → **指针被交给调用方时已无锁保护** |
| **并发风险** | 另一个线程的 `get` 触发**淘汰**（`list_.pop_back()`）→ **节点被销毁 → 调用方手里的指针悬垂** |
| **文档是否警告** | **没有** —— 注释只说「Returns pointers to both the key and value」，**没有任何生命周期说明** |

**文档甚至写着「Can be called from any thread」** —— **这恰恰是最容易出事的用法**。

### 5.3 问题三：`generator()` 在**持有互斥锁期间**执行

```cpp
// packages/react-native/ReactCommon/react/utils/SimpleThreadSafeCache.h:79-99
  auto getMapIterator(const KeyT &key, CacheGeneratorFunction<ValueT> auto generator) const
  {
    std::lock_guard<std::mutex> lock(mutex_);

    if (auto it = map_.find(key); it != map_.end()) {
      // Move accessed item to front of list
      list_.splice(list_.begin(), list_, it->second);
      return it;
    }

    auto value = generator();
    // Add new value to front of list and map
    list_.emplace_front(key, value);
    auto [it, _] = map_.insert_or_assign(key, list_.begin());
    if (list_.size() > maxSize_) {
      // Evict least recently used item (back of list)
      map_.erase(list_.back().first);
      list_.pop_back();
    }
    return it;
  }
```

**`generator()` 是文本测量**（生产调用方传的是测量函数）——
**在持锁状态下执行**，意味着：

| 后果 | 说明 |
| --- | --- |
| **串行化** | 所有线程的缓存访问被**同一次测量**阻塞 |
| **锁持有时间不可控** | 测量耗时随文本复杂度变化 → **锁竞争随内容增长** |
| **这是「内容增长过快 → 帧率下降」的一条机理** | 文本越多越复杂 → 单次测量越慢 → 锁被持有越久 → 其他线程的布局/测量全部排队 |

**缓存本该「用并行换空间」，这里却把最贵的部分放进了临界区。**

### 5.4 问题四（次要）：模板参数与成员类型不匹配

| 项 | 值 |
| --- | --- |
| 模板参数 | `template <typename KeyT, typename ValueT, int maxSize>` |
| 成员 | `size_t maxSize_;` |
| 构造 | `SimpleThreadSafeCache() : maxSize_(maxSize) {}`（用模板参数） / `SimpleThreadSafeCache(unsigned long size) : maxSize_{size} {}`（覆盖） |
| 实际用法 | `SimpleThreadSafeCache<TextMeasureCacheKey, TextMeasurement, kSimpleThreadSafeCacheSizeCap>`，其中 **`kSimpleThreadSafeCacheSizeCap = size_t{1024}`** |

**即 `size_t` 值被用作 `int` 模板实参**（隐式窄化，1024 可表示故合法）。
源码里已有 TODO 承认这个问题：

```
 * TODO T228961279: The maxSize template parameter should be removed, since it
 * may be overriden by the constructor.
```

> **这是本仓库少见的「带 issue 编号的 TODO」** —— **可追溯性极好**：
> 与 60 文档 ZZ-1 的「空洞无说明」形成鲜明对照（**有编号 = 有跟踪**）。

---

## 6. 【核心 CCC-5】`OnScopeExit`：注释与代码错位、`const Lambda&&`、析构函数里调用用户 lambda

### 6.1 全文（38 行）

```cpp
// packages/react-native/ReactCommon/react/utils/OnScopeExit.h:16-36
template <typename Lambda>
class OnScopeExit {
 public:
  explicit OnScopeExit(const Lambda &&lambda) noexcept : lambda_(std::move(lambda)) {}

  // Non-movable
  OnScopeExit(const OnScopeExit &) = delete;
  OnScopeExit(OnScopeExit &&) = delete;

  // Non-copyable
  OnScopeExit &operator=(const OnScopeExit &) = delete;
  OnScopeExit &operator=(OnScopeExit &&) = delete;

  ~OnScopeExit() noexcept
  {
    lambda_();
  }

 private:
  Lambda lambda_;
};
```

### 6.2 两条注释**写反了**

| 代码 | 实际语义 | 上方注释写的 |
| --- | --- | --- |
| `OnScopeExit(const OnScopeExit &) = delete;` | **拷贝构造**被删 | `// Non-movable` ❌ |
| `OnScopeExit(OnScopeExit &&) = delete;` | **移动构造**被删 | `// Non-copyable` ❌ |

**两处注释恰好互换。**

> **影响**：读者若按注释理解，会以为「拷贝被禁、移动可用」，
> **而实际恰好相反**（拷贝与移动**都被禁**）。
>
> **所幸本类的语义就是「不可移动也不可拷贝」**（RAII 守卫），
> **所以实际行为正确，只是注释误导**。

### 6.3 `const Lambda &&` 不能移动

`explicit OnScopeExit(const Lambda &&lambda)` —— **对右值常量的引用**。

| 项 | 说明 |
| --- | --- |
| 常规写法 | `Lambda &&lambda` |
| 本处写法 | `const Lambda &&lambda` |
| **后果** | `std::move(lambda)` **无法移动**（源是 const）→ **lambda 被拷贝** |
| **实际影响** | ① 只捕获可拷贝成员时无影响；② **只捕获 move-only 成员（如 `unique_ptr`）的 lambda 无法传入** → 编译错误 |

### 6.4 析构函数里调用用户 lambda，且是 `noexcept`

```cpp
  ~OnScopeExit() noexcept
  {
    lambda_();
  }
```

| 项 | 说明 |
| --- | --- |
| **无 `try/catch`** | lambda 抛异常 → **在 `noexcept` 析构里逃逸 → `std::terminate()`** |
| **无取消机制** | lambda **一定会被调用**，没有 `cancel()` / `dismiss()` |
| **无「已执行」标记** | 析构只跑一次，无重复执行风险 ✓ |

**这是 `OnScopeExit` 与 `gsl::finally` / `absl::Cleanup` 的主要差异点。**

**现状**：实测 `OnScopeExit` 的消费方 —— `packages/react-native/ReactCommon/react/utils/` 之外**无生产使用点**
（该头文件是 `react/utils` 导出的公共工具）。

---

## 7. 次要发现：`Telemetry.h` 的两处命名错误

```cpp
// packages/react-native/ReactCommon/react/utils/Telemetry.h:73-84
template <
    typename DestinationTimePointT,
    typename SourceTimePointT,
    typename DestnationClockT = typename DestinationTimePointT::clock,
    typename SourceClockT = typename SourceTimePointT::clock>
DestinationTimePointT clockCast(SourceTimePointT timePoint)
{
  auto sourseClockNow = SourceClockT::now();
  auto destinationClockNow = DestnationClockT::now();
```

| 位置 | 错误 | 应为 |
| --- | --- | --- |
| `:76` | `DestnationClockT` | `DestinationClockT` |
| `:80` | `sourseClockNow` | `sourceClockNow` |

**两处都是拼写错误，不影响功能**（模板参数名与局部变量名可以任意取）。

**但 `:75` 的 `DestinationTimePointT` 是拼写正确的** ——
**同一文件里同一个词的两种拼法并存**，说明是复制粘贴时未统一。

**另两处值得记录的细节**：

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `kTelemetryUndefinedTimePoint` | `:35` | `static const` 于命名空间作用域的头文件 → **每个 TU 一份副本**（C++ 的 `const` 有内部链接）→ 轻微的体积浪费，但**无 ODR 问题** |
| `telemetryTimePointToSteadyClockSeconds` | `:66-67` | `static_cast<double>(nanoseconds)` —— `nanoseconds` 是 `int64_t`，**超过 2^53（约 104 天）后 double 精度丢失**（亚微秒级误差） |

---

## 8. 正向样本：`hash_combine_optionals` 的注释是本仓库第一档

```cpp
// packages/react-native/ReactCommon/react/utils/hash_combine.h:36-56
/*
 * Combines a run of optional fields into `seed` as a single presence bitmask followed by the
 * engaged values only.
 *
 * Each `hash_combine` step mixes into the previous seed, so it forms a dependency chain the CPU
 * cannot overlap and an unset field still costs a full link. The optionals are hashed into an
 * independent seed and merged into the preceding seed once, allowing both chains to overlap.
 * Folding presence into one word keeps unused fields off the optional chain: a further optional
 * costs a bit in the mask rather than a link.
 *
 * The mask is what keeps this collision-free. Skipping disengaged fields on its own would make the
 * same value in two different slots hash identically.
 *
 * Both packs are expanded from the same parameter pack, so the mask's bit order cannot drift out
 * of sync with the order the values are combined.
 */
```

| 注释要素 | 覆盖情况 |
| --- | --- |
| **做什么** | ✅ 第一句 |
| **为什么（性能）** | ✅ 「dependency chain the CPU cannot overlap」「allowing both chains to overlap」 |
| **正确性论证** | ✅ 「The mask is what keeps this collision-free」—— **并给出反例**（跳过未设置字段会导致不同 slot 的同值哈希相同） |
| **不变式** | ✅ 「the mask's bit order cannot drift out of sync」—— **说明为什么用同一个参数包展开** |
| **可验证的约束** | ✅ `requires(sizeof...(Ts) <= 32)` |

> **这段注释解释了「为什么不能用更简单的写法」以及「为什么这样写不会漂移」** ——
> **这是 62 文档 BBB-5 之外的另一个第一档实例**。
>
> **对照本文 §2.4 的 `floatEquality`：同样是「有意的非显然选择」，但那里一个字都没有。**

---

## 9. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **CCC-1** | **【核心】`floatEquality(+inf, +inf)` 返回 `false`**（实测）；**`NaN == NaN` 与 epsilon 容差均是有意设计且有测试固定**（`ParagraphAttributesTest.cpp:17-58`，4 个测试）；**但 `±inf` 与「差值恰为 epsilon」两个边界零测试覆盖**，且 `react/utils/tests/` 下**无 `FloatComparison` 的单元测试**；`T = int` 时 epsilon 被截断为 0 → **函数恒假**（无 `static_assert` 拦截） | `packages/react-native/ReactCommon/react/utils/FloatComparison.h:16-21` | **与 53 文档「Yoga 消毒放行 `±inf`」相加 → 一个 `+inf` 就能击穿文本测量缓存与 Yoga 布局缓存**；`T = int` 的静默恒假无任何 `static_assert` 拦截 |
| **CCC-2** | **【核心】哈希与相等性双向违反 `unordered_map` 契约**（实测 `find` 落空）：容差相等但位模式不同 → **不同桶 → 查不到**；`+inf` 哈希相同但 `==` 为 false → **同样查不到** | `TextMeasureCache.h:143-145`（相等）vs `:148-162`（哈希）+ `hash_combine.h:22-27` | **容差对缓存命中率的贡献为零**，反而**每次插入新条目污染缓存**；`+inf` 使测量缓存与布局缓存**永久失效**（8 个消费点见 §3.6） |
| **CCC-3** | **【核心】`ContextContainer::update(self)` 是 use-after-free**（ASan 实测 `heap-use-after-free`）；`erase` 使正在遍历的 `instances_` 迭代器失效 | `packages/react-native/ReactCommon/react/utils/ContextContainer.h:64-73` | **潜伏**（实测 `update(` 无生产调用方）；修复成本极低（加一个自判断即可） |
| **CCC-4** | **【核心】`SimpleThreadSafeCache` 三个 API 契约问题**：① 无 generator 的 `get(key)` **miss 时返回「有值的 optional」**，与头文件注释「returns empty optional」矛盾 —— **实现行为被 `SimpleThreadSafeCacheTest.cpp:15-17` 的 `// Default constructed value is returned` 明确固定，故缺陷在注释而非实现**；② `getWithKey` 返回**指向 list 节点内部的裸指针**且**锁已释放**，淘汰即悬垂，注释却写「Can be called from any thread」；③ **`generator()` 在持锁期间执行**（文本测量在临界区内 → 锁竞争随内容增长） | `packages/react-native/ReactCommon/react/utils/SimpleThreadSafeCache.h:44-57`、`:59-75`、`:79-99` | ① **潜伏**（无生产调用方）；② **悬垂指针风险**，无生命周期说明；③ **性能机理**：内容越多越复杂 → 测量越慢 → 临界区越长 → 并发全部排队 |
| **CCC-5** | **【核心】`OnScopeExit` 的两条注释写反**（`// Non-movable` 标在拷贝构造上、`// Non-copyable` 标在移动构造上）；`const Lambda &&` 使 lambda 只能拷贝；`noexcept` 析构里直接调用户 lambda **无 `try/catch`** | `packages/react-native/ReactCommon/react/utils/OnScopeExit.h:19-32` | 实际语义（拷贝与移动都禁）**正确**，但注释误导；move-only lambda 无法使用；抛异常的 lambda → `std::terminate()` |
| CCC-6 | `ContextContainer` 的 `static_cast<T *>` 从 `void*` 取值**无任何类型校验**，类型安全完全依赖「key 用基类名」的约定 | `ContextContainer.h:86`、`:104`、`:111` | 请求错误的 `T` → 未定义行为；`react_native_assert` **只查 key 不查类型** |
| CCC-7 | `ContextContainer::update` **读另一个容器时不加对方的锁** | `ContextContainer.h:66-72` | 并发写另一个容器时数据竞争 |
| CCC-8 | `floatEquality` 的模板对 `T = int` 无效（epsilon 截断为 0），**无 `concept`/`static_assert` 拦截** | `FloatComparison.h:19` | 静默恒假 |
| CCC-9 | `kDefaultEpsilon` 是 `float`，`T = double` 时容差为 float 的拓宽值 `0.004999999888241291` | `FloatComparison.h:16` | 差 ~1.1e-16，影响可忽略 |
| CCC-10 | `Telemetry.h` 两处拼写错误（`DestnationClockT`、`sourseClockNow`），且同文件 `:75` 处拼写正确 | `Telemetry.h:76`、`:80` | 无功能影响；**同一文件同一词两种拼法并存** |
| CCC-11 | `kTelemetryUndefinedTimePoint` 是头文件里的 `static const` → 每个 TU 一份副本 | `Telemetry.h:35` | 轻微体积浪费，无 ODR 问题 |
| CCC-12 | `telemetryTimePointToSteadyClockSeconds` 用 `static_cast<double>` 转换 `int64_t` 纳秒 | `Telemetry.h:66-67` | 超过 2^53 ns（约 104 天）后精度丢失（亚微秒级） |
| **CCC-15** | **【核心】iOS 渐变的 `Line::intersection` 用 `floatEquality(m, n)` 判平行，但 `+inf` 斜率（垂直线段）时该判据失效** → 不返回 `nullopt`，而是算出**有限但错误的交点**（场景 A：`(0, 1)`）或 **NaN 交点**（场景 B）；**调用方的 `if (g_opt && h_opt)` 守卫拦不住**。**同一文件的 `getPerpendicularSlope` 恰恰写了 `std::isinf` 防御** —— **全仓 41 个调用点中唯一一处** | `packages/react-native/React/Fabric/Utils/RCTGradientUtils.mm:112`、`:115`、`:367-377` | **仅 iOS / Fabric**；触发条件为渐变几何中出现**垂直线段**；**后果是渐变渲染几何错误**；**未实机验证**（以逐字复刻的等价代码编译运行证明 `intersection` 行为） |
| **CCC-13（正向）** | **`hash_combine_optionals` 的 20 行注释**：做了什么 + 为什么（CPU 依赖链）+ 正确性论证（掩码防碰撞，**并给出反例**）+ 不变式（同一参数包展开故位序不漂移）+ 可验证约束（`sizeof...(Ts) <= 32`） | `hash_combine.h:36-56` | **注释质量第一档**；与 CCC-1（同样是非显然选择却零注释）形成对照 |
| **CCC-14（正面）** | **`SimpleThreadSafeCache` 的 TODO 带 issue 编号**（`TODO T228961279`），说明「模板参数 maxSize 应被移除」的已知问题 | `SimpleThreadSafeCache.h:25-27` | **可追溯性好**；与 60 文档 ZZ-1 的「位号空洞无说明」形成对照（**有编号 = 有跟踪**） |

---

## 10. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 53 文档 §2：Yoga 测量消毒只拒 NaN 与负数，`±inf` 直接放行 | **本文 CCC-1 + CCC-2 是它的下游放大器** —— 两个**独立证实**的事实相加 → **`+inf` 击穿测量缓存与布局缓存**（本文 §3.6 列出 8 个消费点） |
| 53 文档 §1：两组哈希/相等字段集不一致 | **本文 CCC-2 是同一主题的另一形态** —— 53 文档是**字段集**不一致，本文是**判据（容差 vs 逐位）**不一致；**两者都会让哈希表失去意义** |
| 49 文档：`cxx-api` 快照门禁单向（只拦删除不拦新增） | **对照 CCC-3** —— `update()` 是 public API 却**无生产调用方**，即**「导出了但没人用」的 API 是缺陷的高发区** |
| 62 文档 BBB-4：注释指向不存在的工具 | **对照 CCC-3** —— `update` 的注释承诺了「会被替换」的契约，**实现却在自更新时崩溃** —— **两者都是「文档承诺 > 代码实现」** |
| 61 文档 AAA-9：`!=` 守卫切断「状态变更 → 重布局 → 再调用」循环 | **对照 CCC-2 的 ④** —— `floatEquality` 恒假使**跳过分支永不触发** → **同一个「本该跳过的更新被反复执行」形态，但方向相反**（61 是守卫太严， 本文是判据恒假） |
| 61 文档 AAA-7/AAA-8：Android 滚动位置保持的幂等与多层判空（防御充足的正样本） | **对照 CCC-4** —— `SimpleThreadSafeCache` 的 API 注释与实现**矛盾**（①），是**同一模块内「防御」与「契约」两种质量标准的落差** |
| 60 文档 ZZ-1：`ViewEvents::Offset` 的位号空洞无任何说明 | **对照 CCC-13 / CCC-14** —— 「可追溯性」的两个极端：**有 issue 编号的 TODO** vs **无说明的空洞**；**后者应比照前者补上跟踪编号** |
| 57 文档 WW-10：同步判定规则三处各写一遍 | **对照 CCC-4①** —— 同一模块内 `get`/`getWithKey`/`getMapIterator` 三处的**「miss 时行为」定义各不相同**（①返回有值 optional、②返回新值、③返回迭代器）—— **同一语义的三个出口未统一** |
| **本文 §2.4.1 / §3.4.1（新增证据）** | **测试作为「意图的第一手证据」** —— `ParagraphAttributesTest.cpp` 的 4 个注释逐字写明了 NaN 与 epsilon 的意图；**本轮据此把 CCC-1 的「NaN 相等」与「epsilon 容差」从「缺陷」改判为「有意设计」，只保留 `±inf` 为缺陷** |
| **本文 §5.1（新增证据）** | **测试可以固定「实现」并让「注释」变成错误的一方** —— `SimpleThreadSafeCacheTest.cpp:15` 的 `// Default constructed value is returned` 使 CCC-4① 的责任方从实现转移到头文件注释 |
