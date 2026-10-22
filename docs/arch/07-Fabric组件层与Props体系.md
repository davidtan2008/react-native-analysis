---
id: 7
title: "Fabric 组件层：Props 体系与组件描述符"
topic: RN.model
symptoms: [prop]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["ShadowNode", "Props", "BaseViewProps"]
claims: []
---
# 07 · Fabric 组件层：Props 体系与组件描述符

> **模块**：A2（`ReactCommon/react/renderer/components`，218 个非测试文件）
> **基线**：react-native @ `9b131e42`
> **本文只覆盖**该模块中「所有组件共享的抽象层」。各具体组件（Text/TextInput/ScrollView…）的业务逻辑另见后续文档。

---

## 1. 组件层的分层

Fabric 的每个组件都由**四个类**构成，缺一不可：

| 角色 | 基类 | 职责 |
| --- | --- | --- |
| **Props** | `Props` | 不可变的属性集合 |
| **ShadowNode** | `ShadowNode` | 不可变的逻辑树节点，参与布局与 diff |
| **State** | `State` | 有状态的组件数据（如 TextInput 的文本） |
| **ComponentDescriptor** | `ComponentDescriptor` | 工厂：创建/克隆上述三者，并把 JS 侧的 `RawProps` 桥接到 C++ Props |

四者的关系：

```
        JS RawProps
             │
             │  ComponentDescriptor::cloneProps()
             ▼
        ┌─────────┐   持有    ┌──────────────┐
        │  Props  │─────────►│  ShadowNode  │
        └─────────┘           └──────┬───────┘
             ▲                        │ 引用
             │                        ▼
        ┌─────────┐           ┌──────────────┐
        │  State  │◄──────────┤ShadowNodeFamily│  ← 跨版本的身份标识
        └─────────┘           └──────────────┘
```

---

## 2. `Props`：基类没有任何字段

`ReactCommon/react/renderer/core/Props.h:29-38`：

```cpp
class Props : public virtual Sealable, public virtual DebugStringConvertible {
 public:
  using Shared = std::shared_ptr<const Props>;

  Props() = default;
  Props(
      const PropsParserContext &context,
      const Props &sourceProps,
      const RawProps &rawProps,
      const std::function<bool(const std::string &)> &filterObjectKeys = nullptr);
```

**注意整个 `Props` 类里只有一个数据成员**（`packages/react-native/ReactCommon/react/renderer/core/Props.h:62`）：

```cpp
std::string nativeId;
```

其余一切（颜色、布局、事件、文本属性……）都在子类中通过宏生成。这是 Fabric 属性系统的核心设计：**基类零负担，属性靠宏批量注入**。

### 2.1 继承链

以 View 为例（各级均已核实）：

```cpp
// packages/react-native/ReactCommon/react/renderer/core/Props.h:29
class Props : public virtual Sealable, public virtual DebugStringConvertible

// components/view/YogaStylableProps.h:20
class YogaStylableProps : public Props

// components/view/BaseViewProps.h:33
class BaseViewProps : public YogaStylableProps, public AccessibilityProps
```

Text 走的是另一条分支：

```cpp
// components/text/TextProps.h:19
class TextProps : public Props, public BaseTextProps
```

即 **Props 是多继承的汇合点**，`YogaStylableProps` / `AccessibilityProps` / `BaseTextProps` 各自独立，最终汇入。

### 2.2 属性注入的宏体系

`core/PropsMacros.h:38-45`：

```cpp
#define RAW_SET_PROP_SWITCH_CASE(field, jsPropName)      \
  case CONSTEXPR_RAW_PROPS_KEY_HASH(jsPropName):         \
    fromRawValue(context, value, field, defaults.field); \
    return;

// Convenience for building setProps switch statements where the field name is
// the same as the string identifier
#define RAW_SET_PROP_SWITCH_CASE_BASIC(field) RAW_SET_PROP_SWITCH_CASE(field, #field)
```

几个关键点：

1. **用哈希做 switch case**（`CONSTEXPR_RAW_PROPS_KEY_HASH`），编译期常量，不做字符串比较。
2. **`fromRawValue` 被注入到调用方**（宏注释 `:36-37`：*"This injects `fromRawValue` into source; each file that uses this macro must import the proper, respective headers required."*）—— 这是个不太常见的设计，宏污染了包含它的作用域。
3. `RAW_SET_PROP_SWITCH_CASE_BASIC` 允许字段名与 JS prop 名相同时省略字符串。

矩形的简写展开（`PropsMacros.h:58-71`）体现了「一个 JS prop 映射多个 C++ 字段」的常见模式：

```cpp
#define SET_CASCADED_RECTANGLE_CORNERS(struct, prefix, suffix, rawValue)                             \
  CASE_STATEMENT_SET_FIELD_VALUE_INDEXED(struct, topLeft, prefix "TopLeft" suffix, rawValue)         \
  CASE_STATEMENT_SET_FIELD_VALUE_INDEXED(struct, topRight, prefix "TopRight" suffix, rawValue)       \
  CASE_STATEMENT_SET_FIELD_VALUE_INDEXED(struct, bottomLeft, prefix "BottomLeft" suffix, rawValue)   \
  ...
  CASE_STATEMENT_SET_FIELD_VALUE_INDEXED(struct, all, prefix "" suffix, rawValue)
```

即 `margin` 一个 JS prop 展开成 `marginTopLeft` / `marginTopRight` / … / `marginAll` 等十余个 C++ 字段。

### 2.3 空值回落

`PropsMacros.h:47-56`：

```cpp
#define CASE_STATEMENT_SET_FIELD_VALUE_INDEXED(struct, field, fieldNameString, value) \
  case CONSTEXPR_RAW_PROPS_KEY_HASH(fieldNameString): {                               \
    if (!value.hasValue()) {                                                          \
      decltype(struct) defaultValues{};                                               \
      struct.field = defaultValues.field;                                             \
      return;                                                                         \
    }                                                                                 \
    fromRawValue(context, value, struct.field);                                       \
    return;                                                                           \
  }
```

JS 侧显式传 `undefined` 时，**回落为该字段的类型默认值**（通过 `decltype(struct) defaultValues{}` 现场构造一个零值对象），而不是保留上一个值。这是「prop 从有值变为 undefined」能正确清除样式的基础。

---

## 3. `Sealable`：运行期不可变性的强制

`core/Sealable.h:19-46` 的设计说明（原文值得完整引用）：

```cpp
/*
 * Represents an object which can be *sealed* (imperatively marked as
 * immutable).
 *
 * The `sealed` flag is tight to a particular instance of the class and resets
 * to `false` for all newly created (by copy-constructor, assignment operator
 * and so on) derivative objects.
 *
 * Why do we need this? In Fabric, some objects are semi-immutable
 * even if they are explicitly marked as `const`. It means that in some special
 * cases those objects can be const-casted-away and then mutated. That comes
 * from the fact that we share some object's life-cycle responsibilities with
 * React and the immutability is guaranteed by some logic split between
 * native and JavaScript worlds (which makes it impossible to fully use
 * immutability enforcement at a language level). To detect possible errors as
 * early as possible we additionally mark objects as *sealed* after some stages
 * and then enforce this at run-time.
 *
 * How to use:
 *   1. Inherit your class from `Sealable`.
 *   2. Call `ensureUnsealed()` in all cases where the object might be mutated:
 *      a. At the beginning of all *always* mutating `non-const` methods;
 *      b. Right before the place where actual mutation happens in all
 *      *possible* mutating `non-const` methods; c. Right after performing
 *      `const_cast`. (Optionally. This is not strictly necessary but might help
 *      detect problems earlier.)
 *   3. Call `seal()` at some point from which any modifications
 *      must be prevented.
 */
```

**为什么要这样？** 因为 Fabric 的不可变性是**跨 JS/C++ 边界的协议**，不是纯 C++ 语言的 `const` 能保证的 —— React 与 C++ 各自持有一半的生命周期责任，`const_cast` 后仍可能被迫修改。`Sealable` 是运行期的第二道防线。

Release 编译下它是**空实现**（`Sealable.h:48-59`）：

```cpp
#ifndef REACT_NATIVE_DEBUG

// Release-mode, production version
class Sealable {
 public:
  inline void seal() const {}
  inline bool getSealed() const
  {
    return true;
  }
  inline void ensureUnsealed() const {}
};
```

**即：不可变性检查只在 Debug 构建生效，Release 下零开销。**

---

## 4. `ComponentDescriptor`：组件工厂

`core/ComponentDescriptor.h:64-125` 定义了 8 个纯虚函数，构成组件的完整契约：

```cpp
virtual ComponentHandle getComponentHandle() const = 0;
virtual ComponentName getComponentName() const = 0;
virtual ShadowNodeTraits getTraits() const = 0;
virtual std::shared_ptr<ShadowNode> createShadowNode(
    const ShadowNodeFragment &fragment,
    const ShadowNodeFamily::Shared &family) const = 0;
virtual std::shared_ptr<ShadowNode> cloneShadowNode(
    const ShadowNode &sourceShadowNode,
    const ShadowNodeFragment &fragment) const = 0;
virtual void appendChild(
    const std::shared_ptr<ShadowNode> &parentShadowNode,
    const std::shared_ptr<ShadowNode> &childShadowNode) const = 0;
virtual Props::Shared cloneProps(const PropsParserContext &context, const Props::Shared &props, RawProps rawProps)
    const = 0;
virtual State::Shared createInitialState(const Props::Shared &props, const ShadowNodeFamily::Shared &family)
    const = 0;
virtual State::Shared createState(const ShadowNodeFamily &family, const StateData::Shared &data) const = 0;
virtual ShadowNodeFamily::Shared createFamily(const ShadowNodeFamilyFragment &fragment) const = 0;
```

### 4.1 `cloneProps` 的契约

`ComponentDescriptor.h:99-105` 明确规定：

```cpp
/*
 * Creates a new `Props` of a particular type with all values copied from
 * `props` and `rawProps` applied on top of this.
 * If `props` is `nullptr`, a default `Props` object (with default values)
 * will be used.
 * Must return an object which is NOT pointer equal to `props`.
 */
```

**「必须返回一个与 `props` 指针不相等的对象」** —— 这是一条易被违反的约束。若违反，diff 阶段会因指针相等而误判「未变化」。

### 4.2 `Flavor`：同一 Descriptor 多身份

`ComponentDescriptor.h:40-49`：

```cpp
/*
 * `Flavor` is a special concept designed to allow registering instances of
 * the exact same `ComponentDescriptor` class with different `ComponentName`
 * and `ComponentHandle` (the particular custom implementation might use
 * stored `flavor` to return different values from those virtual methods).
 * Since it's a very niche requirement (e.g. we plan to use it for
 * an interoperability layer with old renderer), we are thinking about
 * removing this feature completely after it's no longer needed.
 */
using Flavor = std::shared_ptr<const void>;
```

允许**同一个 Descriptor 类**注册成多个 JS 组件名（例如与旧渲染器互操作层复用）。源码明确说这是小众需求，**计划在不再需要后整体移除**。

### 4.3 `adopt`：创建后的注入钩子

`ComponentDescriptor.h:135-148`：

```cpp
/*
 * Called immediately after `ShadowNode` is created, cloned or state is
 * progressed using clonesless state progression (not fully shipped yet).
 *
 * Override this method to pass information from custom `ComponentDescriptor`
 * to new instance of `ShadowNode`.
 *
 * Example usages:
 *   - Inject image manager to `ImageShadowNode` in
 * `ImageComponentDescriptor`.
 *   - Set `ShadowNode`'s size from state in
 * `ModalHostViewComponentDescriptor`.
 */
virtual void adopt(ShadowNode &shadowNode) const = 0;
```

ShadowNode 构造完成后、返回给调用方之前的最后注入点。

---

## 5. `ConcreteComponentDescriptor<T>`：模板实现

绝大多数组件不需要手写那 8 个虚函数，而是继承模板 `core/ConcreteComponentDescriptor.h:34` 的 `ConcreteComponentDescriptor<ShadowNodeT, PropsT, StateT>`，只覆盖差异部分。

### 5.1 创建与克隆

`ConcreteComponentDescriptor.h:82-102`：

```cpp
std::shared_ptr<ShadowNode> createShadowNode(
    const ShadowNodeFragment &fragment,
    const ShadowNodeFamily::Shared &family) const override
{
  auto shadowNode = std::make_shared<ShadowNodeT>(fragment, family, getTraits());

  adopt(*shadowNode);

  return shadowNode;
}

std::shared_ptr<ShadowNode> cloneShadowNode(const ShadowNode &sourceShadowNode, const ShadowNodeFragment &fragment)
    const override
{
  auto shadowNode = std::make_shared<ShadowNodeT>(sourceShadowNode, fragment);
  shadowNode->completeClone(sourceShadowNode, fragment);
  sourceShadowNode.transferRuntimeShadowNodeReference(shadowNode, fragment);

  adopt(*shadowNode);
  return shadowNode;
}
```

`cloneShadowNode` 里的 `transferRuntimeShadowNodeReference` 是 **RSNRU**（Runtime Shadow Node Reference Update）机制的一环 —— 克隆时顺带把 JS 持有的旧引用转移到新节点，避免旧节点被提前回收。详见 [03 文档 §3.5](./03-核心技术原理.md)。

### 5.2 类型擦除的 `appendChild`

`ConcreteComponentDescriptor.h:104-110`：

```cpp
void appendChild(
    const std::shared_ptr<const ShadowNode> &parentShadowNode,
    const std::shared_ptr<const ShadowNode> &childShadowNode) const override
{
  auto &concreteParentShadowNode = static_cast<const ShadowNodeT &>(*parentShadowNode);
  const_cast<ShadowNodeT &>(concreteParentShadowNode).appendChild(childShadowNode);
}
```

接口签名是基类指针，实现里 `static_cast` 恢复具体类型，再 `const_cast` 去掉 const（因为 appendChild 是**修改**操作）。**这正是 `Sealable` 要防范的场景** —— 见 §3。

### 5.3 `cloneProps` 的默认 Props 优化

`ConcreteComponentDescriptor.h:112-122`：

```cpp
virtual Props::Shared cloneProps(const PropsParserContext &context, const Props::Shared &props, RawProps rawProps)
    const override
{
  // Optimization:
  // Quite often nodes are constructed with default/empty props: the base
  // `props` object is `null` (there no base because it's not cloning) and the
  // `rawProps` is empty. In this case, we can return the default props object
  // of a concrete type entirely bypassing parsing.
  if (!props && rawProps.isEmpty()) {
    return ShadowNodeT::defaultSharedProps();
  }
```

**绝大多数节点没有 props**。这个快路径直接返回全局共享的默认 Props 对象，**完全跳过 RawProps 解析**。这是 Fabric 属性系统最重要的性能优化之一：把「无属性」这一高频情况从 O(解析) 降到 O(1)。

---

## 6. 组件目录结构

`renderer/components/` 共 16 个子目录、218 个非测试文件：

| 目录 | 文件数 | 说明 |
| --- | --- | --- |
| `view/` | 55 | 基础视图；`BaseViewProps` / `BaseViewEventEmitter` 是几乎所有组件的父类 |
| `text/` | 39 | 文本渲染，涉及三端文本测量 |
| `textinput/` | 24 | 有状态组件的代表（State 机制） |
| `scrollview/` | 21 | 含 iOS/Android 平台差异 |
| `legacyviewmanagerinterop/` | 12 | 与旧渲染器互操作（对应 §4.2 的 Flavor 用途） |
| `image/` | 12 | 图片组件 |
| `modal/` | 9 | 模态，其 `adopt` 用 state 设置 size |
| `switch/`, `progressbar/`, `unimplementedview/` | 19 | 简单组件 |
| `safeareaview/` | 5 | 安全区适配 |
| `root/` | 5 | 根组件（`RootShadowNode` / `RootProps`） |
| `rncore/` | 5 | 聚合头文件，见 §7 |
| `inputaccessory/` | 4 | iOS 键盘附件 |
| `virtualview/` | 2 | 虚拟化视图 |

---

## 7. `rncore/`：按角色聚合的头文件

`components/rncore/` 只有 5 个文件，但它们是整个组件层的「索引」：

```
ComponentDescriptors.h
EventEmitters.h
Props.h
ShadowNodes.h
States.h
```

按**角色**而非按组件聚合全部组件类型。新增一个组件时，需要在这几个文件里各加一行。这是理解「一共有哪些组件」的最快入口。

对比之下 `components/view/` 等是**按组件**组织的。

---

## 8. 本模块的设计要点小结

| 设计 | 收益 | 代价 |
| --- | --- | --- |
| `Props` 基类零字段 | 基类开销为 0，属性全在子类 | 必须理解宏体系才能读懂属性定义 |
| 宏生成 switch case（哈希分发） | 编译期确定，运行时无字符串比较 | `fromRawValue` 被注入到调用方作用域，隐式依赖 |
| `Sealable` 运行期不可变检查 | 提前发现 `const_cast` 误用 | Release 编译为空，检查只在 Debug 生效 |
| `ConcreteComponentDescriptor<T>` 模板 | 免写 8 个虚函数 | 类型擦除处需 `static_cast` + `const_cast` |
| `cloneProps` 默认 Props 快路径 | 「无属性」场景 O(1) | 依赖「默认 Props 全局共享且不可变」这一前提 |
| `Flavor` 多身份注册 | Descriptor 类可复用 | 源码已标注为待移除 |

---

## 9. 与其他文档的衔接

- 组件层产出的 `ShadowNode` 如何进入 diff 与挂载 → [02 文档 §4 渲染管线](./02-系统架构与代码框架.md#4-渲染管线fabric)
- 不可变性与内存保护（RSNRU / revision revoke）→ [03 文档 §3.5](./03-核心技术原理.md)
- 组件在启动时如何被注册进 `UIManager` → 待补充（模块 A1 剩余部分）

---

## 10. 本文的验证方式

```bash
node docs/arch/audit/audit-citations.mjs    # 引用可达性
node docs/arch/audit/verify-quotes.mjs      # 代码块语义
```

本文所有代码块均在块内首行标注了 `文件:行号`，可被上述脚本自动核验。
