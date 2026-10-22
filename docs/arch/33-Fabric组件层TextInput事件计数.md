---
id: 33
title: "Fabric 组件层（三）：TextInput 的事件计数协议与 Text 的无障碍修复"
topic: RN.widget
symptoms: [gesture]
platforms: [cross]
architecture: [fabric]
layer: T1
symbols: ["AndroidTextInputProps", "TextInputState"]
sourceRoot: react-native
claims: []
---
# 33 · Fabric 组件层（三）：TextInput 的事件计数协议与 Text 的无障碍修复

> **模块**：A2 · `ComponentViews/TextInput/`（2 文件 / 1223 行）+ `ComponentViews/Text/`（3 文件）
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · Fabric
> **前置**：[32 文档](./32-Fabric组件层ScrollView粘性状态.md) 记录了 ScrollView 的粘性状态
> 与回收契约的偏离。
>
> 本文记录 **`mostRecentEventCount` 跨语言事件去重协议**
> （RN 里少见的「原生侧单调计数器 + JS 侧比对」设计），
> 以及 Text 组件针对具体 issue 的无障碍补丁。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `TextInput/RCTTextInputComponentView.mm` | 919 | TextInput 组件宿主 |
| `TextInput/RCTTextInputUtils.mm` | 304 | 工具函数 |
| `Text/RCTParagraphComponentView.mm` | 474 | 段落文本宿主 |
| `Text/RCTParagraphComponentAccessibilityProvider.mm` | 186 | 无障碍支持 |
| `Text/RCTVirtualizedText.mm` | — | 虚拟化文本 |

---

## 2. `mostRecentEventCount`：跨语言的事件去重协议

### 2.1 字段声明与注释

`RCTTextInputComponentView.mm:46-48` 的声明**没有注释**：

```objc
@implementation RCTTextInputComponentView {
  TextInputShadowNode::ConcreteState::Shared _state;
  UIView<RCTBackedTextInputViewProtocol> *_backedTextInputView;
  NSUInteger _mostRecentEventCount;
```

而 `_comingFromJS`（`:62-71`）**有完整注释**：

```objc
  /*
   * A flag that when set to true, `_mostRecentEventCount` won't be incremented when `[self _updateState]`
   * and delegate methods `textInputDidChange` and `textInputDidChangeSelection` will exit early.
   *
   * Setting `_backedTextInputView.attributedText` triggers delegate methods `textInputDidChange` and
   * `textInputDidChangeSelection` for multiline text input only.
   * In multiline text input this is undesirable as we don't want to be sending events for changes that JS triggered.
   */
  BOOL _comingFromJS;
```

**注释一次性说清了 `_comingFromJS` 的两重作用**：
① 计数器不递增；② 两个 delegate 方法提前返回。

**并给出了背景**：设置 `attributedText` 会触发 delegate（多行时），
而这些变化是 JS 自己触发的，不该再上报。

### 2.2 递增规则

`:746-758` 的 `_updateState`：

```objc
- (void)_updateState
{
  if (!_state) {
    return;
  }
  NSAttributedString *attributedString = _backedTextInputView.attributedText;
  auto data = _state->getData();
  _lastStringStateWasUpdatedWith = attributedString;
  data.attributedStringBox = RCTAttributedStringBoxFromNSAttributedString(attributedString);
  _mostRecentEventCount += _comingFromJS ? 0 : 1;
  data.mostRecentEventCount = _mostRecentEventCount;
  _state->updateState(std::move(data));
}
```

| 来源 | `_comingFromJS` | 计数器 |
| --- | --- | --- |
| **用户输入**（原生发起） | `NO` | **+1** |
| **JS 回写**（`setTextAndSelection:`） | `YES` | **+0** |

### 2.3 消费点：丢弃过期回写

`:590-597`：

```objc
- (void)setTextAndSelection:(NSInteger)eventCount
                       value:(NSString *__nullable)value
                       start:(NSInteger)start
                         end:(NSInteger)end
{
  if (_mostRecentEventCount != eventCount) {
    return;
  }
```

**只有一个 `eventCount` 分支不匹配就直接 `return` —— 整段回写被丢弃。**

### 2.4 为什么需要这个协议

**问题场景**：用户在输入框打字 → 原生侧每次变化都 `_updateState` 并上报
`onChange` → JS 侧 `TextInput` 的 `onChange` 可能做受控处理并回写新值 →
原生侧收到回写。

**若无计数器**：JS 的回写与用户的下一次输入**竞争** ——
若回写晚到，会覆盖用户已经输入的新内容，或光标位置错乱。

**计数器的做法**：每次原生侧事件递增一次，回写必须带上「我基于哪个计数」，
不匹配就丢弃。

### 2.5 跨平台与跨语言

| 层 | 载体 |
| --- | --- |
| 原生 → Shadow 树 | `data.mostRecentEventCount`（`:756`） |
| Shadow 树 → 原生 | `mostRecentEventCount: true`（`Libraries/Components/TextInput/RCTTextInputViewConfig.js:134`） |
| 原生 → JS 事件 | `.eventCount = static_cast<int>(_mostRecentEventCount)`（`:740`） |
| JS 侧类型 | `eventCount: number`（`Libraries/Components/TextInput/TextInput.flow.js:29` 等 5 处） |
| JS 侧状态 | `mostRecentEventCount: number`（`Libraries/Components/TextInput/TextInput.js:161`、`:173`） |

**Android 侧同构**（`Libraries/Components/TextInput/AndroidTextInputNativeComponent.js:618/710`）。

> **这是 RN 里少见的「原生侧维护状态、JS 侧比对」的协议** ——
> 与常规的「JS 是唯一事实来源」模型不同，
> 原生侧持有一个 JS 无法直接修改的单调计数器。

### 2.6 事件载荷

`:732-744` 的 `_textInputMetrics` 携带 8 个字段：

```objc
// packages/react-native/React/Fabric/Mounting/ComponentViews/TextInput/RCTTextInputComponentView.mm:732-744
- (TextInputEventEmitter::Metrics)_textInputMetrics
{
  return {
      .text = RCTStringFromNSString(_backedTextInputView.attributedText.string),
      .selectionRange = [self _selectionRange],
      .contentSize = RCTSizeFromCGSize(_backedTextInputView.contentSize),
      .contentOffset = RCTPointFromCGPoint(_backedTextInputView.contentOffset),
      .contentInset = RCTEdgeInsetsFromUIEdgeInsets(_backedTextInputView.contentInset),
      .eventCount = static_cast<int>(_mostRecentEventCount),
      .layoutMeasurement = RCTSizeFromCGSize(_backedTextInputView.bounds.size),
      .zoomScale = _backedTextInputView.zoomScale,
  };
```

**注意 `static_cast<int>`** —— 计数器是 `NSUInteger`（无符号），
但 `eventCount` 是 `int`（有符号）。

**即理论上前 2³¹ 次事件后会溢出为负数。**
按每秒 60 次输入计算，需要约 **414 天**连续输入同一实例 ——
**实际不可达**，但这是一处类型不匹配。

---

## 3. `_comingFromJS`：三处守卫

`:97` 初始化为 `NO`；`:364/:598` 置 `YES`；`:366/:392/:619` 置 `NO`。

### 3.1 三个使用点

| 位置 | 用途 |
| --- | --- |
| `:498`、`:517` | 事件回调时**跳过上报**（避免 JS 回写引发循环） |
| `:755` | `_updateState` 中决定计数器是否递增 |

`:495-520` 的上下文：

```objc
  if (_comingFromJS) {
    return nil;
  }
```

**即 JS 触发的原生变化不再上报 `onChange`** ——
这是防止无限循环的关键。

### 3.2 `_lastStringStateWasUpdatedWith`：去重优化

`:50` 声明，`:753`/`:817` 写入，`:502`/`:527` 读取。

`:502` 的用途：

```objc
  if (_ignoreNextTextInputCall && [_lastStringStateWasUpdatedWith isEqual:_backedTextInputView.attributedText]) {
```

**即「我们刚刚用这个 attributedString 更新过状态，
若 delegate 又回调同样的内容，则忽略」** —— 避免设置文本时触发两次事件。

`:527` 的另一处：

```objc
  if (props.multiline && ![_lastStringStateWasUpdatedWith isEqual:_backedTextInputView.attributedText]) {
```

配合 `:521` 的注释：

```objc
  // T207198334: Setting a new AttributedString (_comingFromJS) will trigger a selection change before the backing
```

**注释带 Meta 内部工单号 `T207198334`** —— 说明这是针对特定 bug 的修复。

### 3.3 `prepareForRecycle` 的重置（正确）

`:386-393`：

```objc
- (void)prepareForRecycle
{
  [super prepareForRecycle];
  ...
  _comingFromJS = NO;
  _lastStringStateWasUpdatedWith = nil;
```

**与 32 文档的 ScrollView 形成鲜明对比**：
TextInput 把 `_comingFromJS`（协议状态机的一部分）
和 `_lastStringStateWasUpdatedWith`（去重缓存）**都重置了**。

**而 `_mostRecentEventCount` 也重置为 0**（`:391`）——
这是正确的，因为计数是**相对**的，重置后 JS 侧持有的旧 `eventCount`
自然不匹配，首个回写会被丢弃。

---

## 4. Text 组件：针对 issue 的无障碍补丁

`RCTParagraphComponentView.mm:136-152`：

```objc
- (void)updateState:(const State::Shared &)state oldState:(const State::Shared &)oldState
{
  _textView.state = std::static_pointer_cast<const ParagraphShadowNode::ConcreteState>(state);
  [_textView setNeedsDisplay];
  [self setNeedsLayout];

  // If the attributed string has changed, we need to notify the accessibility system that something changed,
  // otherwise it may hold on to stale values (this happens most often when an element is updated async)
  // https://github.com/react/react-native/issues/58145
  if (state && oldState) {
    const auto &newData = std::static_pointer_cast<const ParagraphShadowNode::ConcreteState>(state)->getData();
    const auto &oldData = std::static_pointer_cast<const ParagraphShadowNode::ConcreteState>(oldState)->getData();
    if (!newData.attributedString.isContentEqual(oldData.attributedString)) {
      UIAccessibilityPostNotification(UIAccessibilityLayoutChangedNotification, nil);
    }
  }
}
```

### 4.1 修复的问题

| 项 | 内容 |
| --- | --- |
| **现象** | VoiceOver 持有过期的文本值（读出的内容与屏幕不符） |
| **触发条件** | 元素**异步更新**时 |
| **修复手段** | 内容变化时发 `UIAccessibilityLayoutChangedNotification` |
| **判断依据** | `isContentEqual`（内容相等，不是指针相等） |
| **issue** | `facebook/react-native#58145`（注释里给了链接） |

> **注释把「现象 + 触发条件 + 修复手段 + 判断依据」四件事都写清了** ——
> 这是本文档见过注释质量最高的一处，与
> [32 文档 W-1](./32-Fabric组件层ScrollView粘性状态.md) 的「无注释疑似疏忽」
> 形成对照。

### 4.2 `isContentEqual` 而非 `operator==`

`AttributedString` 的 `isContentEqual` 是**深比较**（逐字符）。
若用指针/浅比较，异步更新后**内容相同但对象不同**时不会触发通知，
而这恰恰是「VoiceOver 读到旧值」的高发场景。

**这是正确的选择，但注释没说** —— 只说了「if the attributed string has changed」。

### 4.3 双空检查

`:145` 的 `if (state && oldState)`：

| 情况 | 行为 |
| --- | --- |
| `state` 或 `oldState` 为 nil | **跳过通知** |
| 两者非 nil 且内容不同 | 发通知 |

**初次挂载时 `oldState` 为 nil，此时不发通知** —— 合理
（新元素首次出现，VoiceOver 还没缓存任何东西）。

### 4.4 `updateLayoutMetrics` 的参数覆盖

`:154-164`：

```objc
- (void)updateLayoutMetrics:(const LayoutMetrics &)layoutMetrics
           oldLayoutMetrics:(const LayoutMetrics &)oldLayoutMetrics
{
  // Using stored `_layoutMetrics` as `oldLayoutMetrics` here to avoid
  // re-applying individual sub-values which weren't changed.
  [super updateLayoutMetrics:layoutMetrics oldLayoutMetrics:_layoutMetrics];
```

**参数 `oldLayoutMetrics` 被忽略，改用 ivar `_layoutMetrics`。**
注释说明了理由：避免重复应用未变化的子值。

**这是一个「接口签名与实际使用不符」的例子** ——
签名要求的参数被主动丢弃。静态分析会警告（未使用参数），
但代码用注释解释后是合理的。

### 4.5 Feature Flag 门控的布局优化

`:180-191`：

```objc
  if (ReactNativeFeatureFlags::enableIOSCompressedTextFrameAdjustment() && _textView.state &&
      drawingFrame.size.height > 0) {
    const auto &stateData = _textView.state->getData();
    auto textLayoutManager = stateData.layoutManager.lock();
    if (textLayoutManager) {
      RCTTextLayoutManager *nativeTextLayoutManager =
          (RCTTextLayoutManager *)unwrapManagedObject(textLayoutManager->getNativeTextLayoutManager());
```

**依赖 C++ 的 `weak_ptr`（`layoutManager.lock()`）拿到文本布局管理器**，
避免在 ObjC 侧重算布局。

**三重守卫**：Feature Flag + state 非空 + 高度大于 0。

---

## 5. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| X-1 | **`eventCount` 是 `int`，而 `_mostRecentEventCount` 是 `NSUInteger`** | `TextInput/RCTTextInputComponentView.mm:740` | 理论溢出为负（需 414 天连续输入），**实际不可达**；类型不匹配 |
| X-2 | `updateLayoutMetrics:` 忽略传入的 `oldLayoutMetrics`，改用 ivar | `Text/RCTParagraphComponentView.mm:157-159` | 有注释解释，属合理；**但接口签名与实现不符**，静态分析会误报 |
| X-3 | `isContentEqual` 的选择（深比较）在注释里未说明理由 | `Text/RCTParagraphComponentView.mm:148` | 无实际问题；仅注释信息量可补 |

### X-1 的性质

**记为「类型不匹配但实际不可达」**，与
[24 文档 E-9/E-10](./24-iOS事件分发触摸管线与JS加载.md)（`touchID` 越界、
`RCTNormalizeInputEventName(@"")`）、[26 文档 I-1](./26-iOS-Base余部网络图像与快捷键.md)
的静态分析类问题同类。

**归入这一类的判别标准**：
**能精确定位到触发条件，且触发条件在实际使用中不可达成。**

---

## 6. 回收契约的三种处置方式（跨组件汇总）

三篇文档读到的 `prepareForRecycle` 处置，可归为三类：

### 6.1 正确重置（TextInput、Paragraph、View）

| 组件 | 重置内容 |
| --- | --- |
| `RCTTextInputComponentView` | `_comingFromJS = NO`、`_lastStringStateWasUpdatedWith = nil`、`_mostRecentEventCount = 0` |
| `RCTParagraphComponentView` | `_textView.state = nullptr`、`_accessibilityProvider = nil` |
| `RCTViewComponentView` | 4 个 layer + 5 个状态变量（[31 文档 §3.3](./31-Fabric组件层View与回收池.md)） |

### 6.2 刻意不重置（有注释）

`RCTScrollViewComponentView._isAccessibilityAPIUsed`
（[32 文档 §3](./32-Fabric组件层ScrollView粘性状态.md)）——
注释明确写「不在 `prepareForRecycle` 恢复」。

### 6.3 疑似疏忽（无注释）

| 字段 | 组件 | 当前是否有实际影响 |
| --- | --- | --- |
| `_scrollEventThrottle` | `RCTScrollViewComponentView` | 无（靠 `oldProps != newProps` 条件兜住） |
| `_lastScrollEventDispatchTime` | 同上 | 无（靠 `CACurrentMediaTime()` 单调性） |

**这三类的区分只能靠注释** ——
代码本身无法表达「为什么这个字段没被重置」。

> **这正是这批文档的价值**：
> [26 文档 I-4](./26-iOS-Base余部网络图像与快捷键.md) 记录了
> 「注释声称有 escape 例外但代码没有」，
> 本文的 §6.2 是反例 —— **注释说有、代码没有，但这是对的**。
>
> **没有文档，读者只能靠猜。**

---

## 7. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 32 文档：回收契约的三类处置 | **补上「正确重置」的两个正面实例**（§6.1），使该分类完整 |
| 32 文档：ScrollView 疑似疏忽 | **对照**：同架构的 TextInput 把协议状态机完整重置（§3.3） |
| 31 文档：视图裁剪与无障碍 | **新增 TextInput 侧**：`_lastStringStateWasUpdatedWith` 的去重（§3.2） |
| 03 文档：事件循环 | **新增跨语言事件去重协议**：`mostRecentEventCount`（§2） |
| 24/26 文档：静态可分析但不可达的问题 | **新增同类**：`eventCount` 的 int/NSUInteger 不匹配（X-1） |