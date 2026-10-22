---
id: 46
title: "Android legacy ShadowNode 的脏标记、布局去重，与一条走到底就断掉的数据通路"
topic: RN.layout
symptoms: [prop]
platforms: [android]
architecture: [cross]
layer: T1
symbols: ["ShadowNode", "markDirty"]
claims: [KK-1, KK-2, KK-3, KK-4, KK-5, KK-6, KK-7]
---
# 46 · Android legacy ShadowNode 的脏标记、布局去重，与一条走到底就断掉的数据通路

> **模块**：C2 ·
> `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java`（1090，122 个 `public`/`protected` 方法）、
> `ReactShadowNode.kt`（486，接口）、
> `views/textinput/ReactTextInputLocalData.kt`（33）、
> `uimanager/UIManagerModule.kt:274`
>
> **基线**：react-native @ `9b131e42` · Android 侧 · **legacy 架构（Paper）路径**
>
> **前置**：[37 文档](./37-legacy布局层被掏空与ShadowQueue转用.md) 结论
> 「legacy 布局层被掏空」；[45 文档](./45-Android-ViewManager属性缓存与回收契约.md) 记录
> `ReactShadowNode` 的 `@Deprecated` + `@Suppress("DEPRECATION")` 双重标注。
>
> 本文在 37 文档的结论上**再落实两条独立证据**：
> ① **8 个 legacy API 成员是空壳**（恒返回常量 / 空方法体 / 零调用方），
> 全部由同一原因造成：`// ... due to NativeKind removal`；
> ② **一条完整走通四层、最终被丢弃的数据通路**
> —— `ReactEditText` 构造 7 字段的 `ReactTextInputLocalData` 送出去，
> 落进 `= Unit` 的空实现，**读回方法 `apply()` 零调用方**。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java` | 1090 | legacy ShadowNode 唯一实现 |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNode.kt` | 486 | 对应接口（Kotlin） |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactTextInputLocalData.kt` | 33 | EditText 状态快照 |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactEditText.kt` | — | 唯一构造方（`:985`、`:989-1005`） |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/UIManagerModule.kt` | 645 | `:274` 空实现 |

---

## 2. 类的自我标注：三重弃用信号

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:60-78
@ReactPropertyHolder
@LegacyArchitecture(logLevel = LegacyArchitectureLogLevel.ERROR)
@Deprecated(
    since = "This class is part of Legacy Architecture and will be removed in a future release")
public class ReactShadowNodeImpl implements ReactShadowNode<ReactShadowNodeImpl> {

  private static final YogaConfig sYogaConfig;

  static {
    sYogaConfig = YogaConfigFactory.create();
    sYogaConfig.setPointScaleFactor(0f);
    sYogaConfig.setErrata(YogaErrata.ALL);
  }

  static {
    LegacyArchitectureLogger.assertLegacyArchitecture(
        "ReactShadowNodeImpl", LegacyArchitectureLogLevel.ERROR);
  }
```

**三个标注各司其职，构成本仓库最完整的弃用声明**：

| 标注 | 作用面 |
| --- | --- |
| `@Deprecated(since = "…part of Legacy Architecture…")` | **编译器 + IDE**：全 1090 行打弃用标记 |
| `@LegacyArchitecture(logLevel = ERROR)` | **运行时注解**：静态分析可查 |
| 静态块 `assertLegacyArchitecture(…, ERROR)` | **运行时**：新架构下实例化即打 ERROR 日志 |

**且 `@Deprecated` 的 `since` 字段写的是一句解释而非版本号** —— 
这是本仓库唯一一处 `since` 不填版本而填原因的写法。

**对照 37 文档 §3 的 iOS 侧**：iOS 的 `RCTShadowView` 是**静默保留**（无 deprecated 标注）。
**Android 侧三层齐备，iOS 侧零层** —— 同一件事，两种处理。

**`@LegacyArchitecture(logLevel = ERROR)` 在 Android 主代码共 17 个文件使用**
（`grep -rln` 实测），是全仓最广的架构边界标注。

### 2.1 Yoga 配置的两个决定

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:69-73
  static {
    sYogaConfig = YogaConfigFactory.create();
    sYogaConfig.setPointScaleFactor(0f);
    sYogaConfig.setErrata(YogaErrata.ALL);
  }
```

| 设置 | 值 | 含义 |
| --- | --- | --- |
| `setPointScaleFactor(0f)` | **0** | **禁用 Yoga 的像素定点缩放** —— RN 自己按 dp 传值，不让 Yoga 再乘 |
| `setErrata(YogaErrata.ALL)` | 全部 errata | 开启 Yoga 全部历史兼容行为 |

> **`setPointScaleFactor(0f)` 与 Fabric 侧不同**：45 文档记录 Android 侧
> `PixelUtil.kt` 提供 dp→px 转换；若此处再让 Yoga 缩放就会**双重缩放**。
> **置 0 是刻意的职责切分** —— RN 负责单位，Yoga 只负责布局。

---

## 3. 三个脏标记源与它们的关系

### 3.1 `hasUpdates()` 是三源或

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:165-168
  @Override
  public final boolean hasUpdates() {
    return mNodeUpdated || hasNewLayout() || isDirty();
  }
```

**三个源**：

| 源 | 状态 | 置位者 | 语义 |
| --- | --- | --- | --- |
| `mNodeUpdated` | 布尔字段，**初值 `true`**（`:86`） | `markUpdated()`（`:179-190`） | 属性变更 |
| `hasNewLayout()` | Yoga 侧状态 | Yoga 布局计算 | 布局变更 |
| `isDirty()` | Yoga 侧状态 | `dirty()`（`:196-212`） | 需要重算布局 |

**`mNodeUpdated` 初值为 `true`** —— 即**每个新建节点一出生就是「已更新」**，
首次布局必然走一遍全量路径。

### 3.2 `markUpdated()` 沿父链上溯

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:178-190
  @Override
  public void markUpdated() {
    if (mNodeUpdated) {
      return;
    }
    mNodeUpdated = true;
    ReactShadowNodeImpl parent = getParent();
    if (parent != null) {
      parent.markUpdated();
    }
  }
```

**三重防护**：

| # | 机制 | 作用 |
| --- | --- | --- |
| ① | `if (mNodeUpdated) return;` | **幂等**：重复调用立即返回 |
| ② | 沿 `getParent()` **递归**上溯 | 祖先全部置位 |
| ③ | `getParent() != null` 判空 | 根节点停止 |

> **① 是性能关键**：N 个兄弟节点同时更新时，
> 第一个把父链全部置位，后续 N−1 个在第一行就返回 —— **O(N) 而非 O(N·depth)**。
>
> **但注意**：① 只查**自身**的 `mNodeUpdated`。
> 若某个中间节点被 `markUpdateSeen()` 复位过（`:170-176`），
> 子树再次更新会**重新走完整条父链**。

### 3.3 `markUpdateSeen()` 的连带复位

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:169-176
  @Override
  public final void markUpdateSeen() {
    mNodeUpdated = false;
    if (hasNewLayout()) {
      markLayoutSeen();
    }
  }
```

**复位 `mNodeUpdated` 的同时，若有新布局则一并复位布局标记** —— 
**一次调用清两个标记**，这是「消费即清」语义。

### 3.4 `dirty()` 的三分支与一段自认失效的注释

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:195-212
  @Override
  public void dirty() {
    if (!isVirtual()) {
      mYogaNode.dirty();
    } else if (getParent() != null) {
      // Virtual nodes aren't involved in layout but they need to have the dirty signal
      // propagated to their ancestors.
      //
      // TODO: There are some edge cases that currently aren't supported. For example, if the size
      //   of your inline image/view changes, its size on-screen is not be updated. Similarly,
      //   if the size of a view inside of an inline view changes, its size on-screen is not
      //   updated. The problem may be that dirty propagation stops at inline views because the
      //   parent of each inline view is null. A possible fix would be to implement an `onDirty`
      //   handler in Yoga that will propagate the dirty signal to the ancestors of the inline view.
      //
      getParent().dirty();
    }
  }
```

**三条分支**：

| 条件 | 行为 |
| --- | --- |
| `!isVirtual()` | `mYogaNode.dirty()` —— 正常路径 |
| `isVirtual()` 且有父 | `getParent().dirty()` —— 向上转发（虚拟节点不参与布局但要传递信号） |
| `isVirtual()` 且无父 | **什么都不做** |

**第三分支即 TODO 描述的失效场景**：inline view 的 parent 为 `null`，
信号在此**断链**，其屏幕尺寸不更新。

> **这是源码自认的第一个已知功能缺陷**，且注释给出了**根因**（parent 为 null）
> 与**候选修法**（Yoga `onDirty` handler）。
>
> **注释里还有一处笔误**：`"is not be updated"`（`is` + `not be`）—— 
> 原文如此，非本文转录错误。
>
> **与 38 文档 §3.2 的经验一致**：注释说有、代码没有，
> 但**注释承认的边界就是真实的边界** —— 这里的 TODO 是**有效的**，
> 因为它描述的正是当前代码的分支缺失。

### 3.5 `isDirty()` 对虚拟节点恒为 false

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:214-217
  @Override
  public final boolean isDirty() {
    return mYogaNode != null && mYogaNode.isDirty();
  }
```

**`mYogaNode != null` 这个前置守卫是必需的** —— 因为构造函数（见 §4）
对虚拟节点把 `mYogaNode` 置为 `null`。**若无此守卫，虚拟节点会 NPE。**

---

## 4. 构造函数的 `this-escape` 与 7 处同型标注

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:104-115
  @SuppressWarnings("this-escape")
  public ReactShadowNodeImpl() {
    mDefaultPadding = new Spacing(0f);
    if (!isVirtual()) {
      mYogaNode = YogaNodeFactory.create(sYogaConfig);
      mYogaNode.setData(this);
      Arrays.fill(mPadding, YogaConstants.UNDEFINED);
    } else {
      mYogaNode = null;
    }
  }
```

**`this-escape` 的成因清晰**：

| 调用 | 问题 |
| --- | --- |
| `isVirtual()` | **虚方法调用** —— 若子类 override 它，此时子类字段尚未初始化 |
| `mYogaNode.setData(this)` | **把 `this` 交给 Yoga 节点** —— 此时 `this` 尚未完成构造 |

**两条分支的差异**：

| `isVirtual()` | `mYogaNode` | `mPadding` |
| --- | --- | --- |
| `false` | `YogaNodeFactory.create(sYogaConfig)` 并 `setData(this)` | `Arrays.fill(…, UNDEFINED)` |
| `true` | **`null`** | **不初始化**（保持默认 `0f`） |

> **`Arrays.fill` 只在非虚拟分支执行** —— 虚拟节点的 `mPadding` 保持数组默认值 `0f`，
> 而非 `YogaConstants.UNDEFINED`。这是两分支的**第二个状态差异**。

### 4.1 全仓库 7 处 `this-escape`

| 文件 | 行号 | 该文件内次数 | 类 |
| --- | --- | --- | --- |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java` | `:105` | 1 | `ReactShadowNodeImpl` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactRootView.java` | `:120` / `:126` / `:132` | **3** | `ReactRootView` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/ReactActivity.java` | `:41` | 1 | `ReactActivity` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/fabric/FabricUIManager.java` | `:246` | 1 | `FabricUIManager` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/ReactTextView.java` | `:84` | 1 | `ReactTextView` |

**7 处分布跨 5 个文件，其中 `ReactRootView` 占 3 处。**

> **这是 Java 21 lint（`this-escape`）的产物**，说明团队**开着新 lint 且在逐个修**
> —— 每个被标注的地方都是真实存在的构造期逃逸。
> **标注本身是作者的诚实声明**（对照 33 文档：`@Suppress` 的行内注释记录原因的做法）。

---

## 5. 布局去重：屏幕矩形快照的 4 字段比较

### 5.1 两处几乎重复的矩形计算

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:345-367
  public boolean dispatchUpdatesWillChangeLayout(float absoluteX, float absoluteY) {
    if (!hasNewLayout()) {
      return false;
    }

    float layoutX = getLayoutX();
    float layoutY = getLayoutY();
    int newAbsoluteLeft = Math.round(absoluteX + layoutX);
    int newAbsoluteTop = Math.round(absoluteY + layoutY);
    int newAbsoluteRight = Math.round(absoluteX + layoutX + getLayoutWidth());
    int newAbsoluteBottom = Math.round(absoluteY + layoutY + getLayoutHeight());

    int newScreenX = Math.round(layoutX);
    int newScreenY = Math.round(layoutY);
    int newScreenWidth = newAbsoluteRight - newAbsoluteLeft;
    int newScreenHeight = newAbsoluteBottom - newAbsoluteTop;

    return newScreenX != mScreenX
        || newScreenY != mScreenY
        || newScreenWidth != mScreenWidth
        || newScreenHeight != mScreenHeight;
  }
```

**与 `dispatchUpdates`（`:370-397`）逐字对照**：

| 项 | `dispatchUpdatesWillChangeLayout` | `dispatchUpdates` |
| --- | --- | --- |
| `if (!hasNewLayout()) return` | ✅ 提前返回 `false` | ✅ 包住整个计算块 |
| 8 行矩形计算 | ✅ **完全相同** | ✅ **完全相同** |
| 4 字段比较 | ✅ `return` 比较结果 | ✅ 比较后**写回 4 个字段** |
| 写回快照 | ❌ **不写** | ✅ `mScreenX/Y/Width/Height = …` |

> **两函数共享同一段 8 行计算，但没有任何抽取** —— 
> 一处用于「问会不会变」，一处用于「变了就记下来」。
> **若布局语义变化（例如加入 scale/transform），必须同时改两处，否则去重失效。**

### 5.2 去重基准是「取整后的屏幕矩形」

| 字段 | 定义 | 注意 |
| --- | --- | --- |
| `newScreenX` / `newScreenY` | **`Math.round(layoutX/Y)`** —— **不含 `absoluteX/Y`** | 是**相对父节点**的值 |
| `newScreenWidth` / `newScreenHeight` | `newAbsoluteRight - newAbsoluteLeft` | 差值消掉了 `absoluteX/Y` |

**即 4 字段全部与祖先位置无关**，只有 `layoutX/Y` 与宽高参与。

> **去重因此是「相对位移去重」而非「绝对位置去重」**：
> 整个子树一起平移 10px，每个节点的 `layoutX/Y` 不变 → **全部判为「无变化」**，
> **不会向下发通知**。
>
> **这是正确的**：位置变化由父节点的移动承担。
> 但也意味着**若客户端依赖「每个 View 收到绝对位置变更通知」，本机制不提供**。

**快照字段声明在 `:93-96`**（4 个 `int`，零初始化）。

---

## 6. 【核心发现 A】8 个空壳成员：同一原因造成的 legacy 空洞

37 文档的结论「legacy 布局层被掏空」在此得到**可枚举的实例清单**。

### 6.1 空壳成员总表

| # | 成员 | 位置 | 形态 | 外部调用方 |
| --- | --- | --- | --- | --- |
| ① | `getTotalNativeNodeContributionToParent()` | `:574-577` | **`return 0;`** | 4 处**内部**调用 |
| ② | `updateNativeChildrenCountInParent(int delta)` | `:312-314` | **空方法体**，`delta` 未用 | 3 处**内部**调用 |
| ③ | `mTotalNativeChildren` | `:91` | 字段，**恒 0** | — |
| ④ | `getTotalNativeChildren()` | `:552-554` | 返回恒 0 字段 | **0**（仅接口声明） |
| ⑤ | `setIsLayoutOnly(boolean)` | `:539-544` | 3 条 `Assertions` + 赋值 | **0** |
| ⑥ | `isLayoutOnly()` | `:546-549` | 返回恒 `false` 字段 | **0** |
| ⑦ | `hoistNativeChildren()` | `:156-158` | **`return false;`** | **0** |
| ⑧ | `isVirtualAnchor()` | `:134-136` | **`return false;`** | 1 处内部（`:1083`） |

**三个 `// … due to NativeKind removal` 注释**：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:312-314
  private void updateNativeChildrenCountInParent(int delta) {
    // Commented out due to NativeKind removal
  }
```

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:489-491
  public final void addNativeChildAt(ReactShadowNodeImpl child, int nativeIndex) {
    // Assertions removed due to NativeKind removal

    if (mNativeChildren == null) {
```

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:574-577
  private int getTotalNativeNodeContributionToParent() {
    // Logic removed due to NativeKind removal
    return 0;
  }
```

**三处注释 + `:490` 的「Assertions removed」共 4 处，成因完全一致。**

### 6.2 恒 0 计数链的完整推导

**`getTotalNativeChildren()` 的全 Android 主代码唯一出现处是接口声明**：

| 出现位置 | 性质 |
| --- | --- |
| `uimanager/ReactShadowNode.kt:235` | **接口声明**（Kotlin `public fun getTotalNativeChildren(): Int`） |
| `uimanager/ReactShadowNodeImpl.java:553` | 实现 |

**除实现类外零调用方。**

**4 个内部调用点全部拿到常量 0**：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:243-248
    markUpdated();

    int increase = child.getTotalNativeNodeContributionToParent();
    mTotalNativeChildren += increase;

    updateNativeChildrenCountInParent(increase);
```

| 调用点 | 上下文 | 结果 |
| --- | --- | --- |
| `:244` | `addChildAt` | `increase = 0` |
| `:264` | `removeChildAt` | `decrease = 0` |
| `:302` | `removeAndDisposeAllChildren` | `decrease += 0` |
| `:632` | `getNativeOffsetForChild` | `index += 0` |

**推导链**：

```
getTotalNativeNodeContributionToParent()  ──恒 0──▶  4 个调用点全部得 0
        │
        ├─▶ mTotalNativeChildren += 0 / -= 0     → 字段恒 0
        │        └─▶ getTotalNativeChildren()     → 恒返回 0，且零调用方
        │
        └─▶ updateNativeChildrenCountInParent(0)  → 空方法体，连 delta 值都不参与
```

> **结论：`getTotalNativeChildren()` 是一条恒返回 0、且无人调用的公开 API。**
> `getNativeOffsetForChild`（`:623-641`，8 行，含循环）**因此退化为恒返回 `index` 的恒等函数** ——
> 它的 KDoc（`:595-600`）仍完整描述「统计 layout-only 节点子树中位于给定 child 左侧的原生节点数」，
> **而该统计能力已被 NativeKind removal 抽空**。

### 6.3 `isVirtualAnchor()` 恒 false 使 `:1084` 成为死分支

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:1081-1089
  @Override
  @SuppressWarnings("unchecked")
  public @Nullable Iterable<ReactShadowNode<?>> calculateLayoutOnChildren() {
    if (isVirtualAnchor()) {
      // All of the descendants are virtual so none of them are involved in layout.
      return null;
    }
    // Just return the children. Flexbox calculations have already been run on them.
    return (Iterable) mChildren;
  }
```

**`isVirtualAnchor()` 全仓库 4 处出现**：

| 位置 | 性质 |
| --- | --- |
| `uimanager/ReactShadowNode.kt:65` | 接口声明 |
| `uimanager/ReactShadowNodeImpl.java:134` | 实现（`return false`） |
| `uimanager/ReactShadowNodeImpl.java:1083` | **唯一调用**（此处） |
| `views/text/TextAttributeProps.kt:211` | **`// if (!isVirtualAnchor()) {` —— 已注释** |

> **无任何子类 override `isVirtualAnchor()`** ——
> 因此 `:1084` 的 `return null` 分支**在本仓库中不可达**。
> **`TextAttributeProps.kt:211` 的注释掉的调用是这条 API 曾经的用途**，现已废弃。

**`isVirtualAnchor()` 的 KDoc（`:128-133`）仍在描述完整语义**
（"may have children Text nodes but this whole hierarchy will be mapped to a single android EditText"），
**指向 `ReactTextInputShadowNode` —— 而该能力已随 `setLocalData` 空实现一起失效**（见 §7）。

---

## 7. 【核心发现 B】一条走通四层、最终被丢弃的数据通路

### 7.1 完整调用链（逐层实测）

```
ReactEditText.kt:985  setIntrinsicContentSize()
  └─ :989  private fun setIntrinsicContentSize()      ← // TODO T58784068: delete this method
       └─ :1000  val localData = ReactTextInputLocalData(this)     ← 构造 7 字段快照
            └─ :1003  uiManager?.setViewLocalData(id, localData)
                 └─ UIManagerModule.kt:274  public open fun setViewLocalData(tag, data): Unit = Unit
                                                          ↑ 空实现，无调用方进一步处理
```

**下游两处也都是空的**：

| 层 | 位置 | 形态 |
| --- | --- | --- |
| UIManager 层 | `uimanager/UIManagerModule.kt:274` | **`= Unit`** —— 空 |
| ShadowNode 层 | `uimanager/ReactShadowNodeImpl.java:594` | **`{}`** —— 空 |
| 读回 | **无 getter** | `getLocalData` 全仓库 **0 处** |
| 应用 | `ReactTextInputLocalData.apply(editText)` `:22-31` | **零调用方** |

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:584-594
  /*
   * In some cases we need a way to specify some environmental data to shadow node
   * to improve layout (or do something similar), so {@code localData} serves these needs.
   * For example, any stateful embedded native views may benefit from this.
   * Have in mind that this data is not supposed to interfere with the state of
   * the shadow node.
   * Please respect one-directional data flow of React.
   * Use  {@link ReactUIManagerModule#setViewLocalData} to set this property
   * (to provide local/environmental data for a shadow node) from the main thread.
   */
  public void setLocalData(Object data) {}
```

**9 行注释 + 空方法体。** 注释描述的用途（"improve layout"、"stateful embedded native views"）
**全部未实现**。

### 7.2 触发条件（三重门控，缺一不可）

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactEditText.kt:989-1005
  // TODO T58784068: delete this method
  private fun setIntrinsicContentSize() {
    // This serves as a check for whether we're running under Paper or Fabric.
    // By the time this is called, in Fabric we will have a state
    // wrapper 100% of the time.
    // Since the LocalData object is constructed by getting values from the underlying EditText
    // view, we don't need to construct one or apply it at all - it provides no use in Fabric.
    val reactContext = UIManagerHelper.getReactContext(this)

    if (!ReactBuildConfig.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE) {
      @Suppress("DEPRECATION")
      if (stateWrapper == null && !reactContext.isBridgeless) {
        val localData = ReactTextInputLocalData(this)
        val uiManager =
            reactContext.getNativeModule(com.facebook.react.uimanager.UIManagerModule::class.java)
        uiManager?.setViewLocalData(id, localData)
      }
    }
  }
```

| # | 条件 | 排除的场景 |
| --- | --- | --- |
| ① | `!ReactBuildConfig.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE` | **编译期**：开启 legacy 最小化构建时不走 |
| ② | `stateWrapper == null` | **运行时**：Fabric 下必有 state wrapper |
| ③ | `!reactContext.isBridgeless` | **运行时**：bridgeless 模式不走 |

**三重门控的净效果**：这条通路**只在 legacy Paper + 非 bridgeless + 无 state wrapper 时**才执行 ——
**即新架构下完全不执行**。

**注释把这三重门控的意图逐条解释**（"serves as a check for whether we're running under Paper or Fabric"）。

### 7.3 快照携带 7 项状态，`apply()` 有 8 条赋值

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactTextInputLocalData.kt:14-32
/** Local state bearer for EditText instance. */
public class ReactTextInputLocalData(editText: EditText) {
  private val text = SpannableStringBuilder(editText.text)
  private val textSize = editText.textSize
  private val minLines = editText.minLines
  private val maxLines = editText.maxLines
  private val inputType = editText.inputType
  private val breakStrategy = editText.breakStrategy
  private val placeholder: CharSequence? = editText.hint

  public fun apply(editText: EditText) {
    editText.text = text
    editText.setTextSize(TypedValue.COMPLEX_UNIT_PX, textSize)
    editText.minLines = minLines
    editText.maxLines = maxLines
    editText.inputType = inputType
    editText.hint = placeholder
    editText.breakStrategy = breakStrategy
  }
}
```

**快照 7 项 / `apply()` 7 条赋值**（1:1 对应）：

| # | 字段 | 类型 | 代价 |
| --- | --- | --- | --- |
| ① | `text` | **`SpannableStringBuilder(editText.text)`** | **深拷贝整个文本（含 span）** |
| ② | `textSize` | `Float` | — |
| ③ | `minLines` | `Int` | — |
| ④ | `maxLines` | `Int` | — |
| ⑤ | `inputType` | `Int` | — |
| ⑥ | `breakStrategy` | `Int` | — |
| ⑦ | `placeholder` | `CharSequence?` | — |

> **① 是性能要点**：每次调用都 `SpannableStringBuilder(editText.text)` ——
> **对全文做一次 span 深拷贝**。长文本时开销随文本长度线性增长。
>
> **而这份拷贝随即被 `= Unit` 丢弃** ——
> **即「拷贝全文 → 立刻扔掉」在每次 TextInput 挂载时发生一次**。
>
> **与 42 文档「内容增长过快」的关联**：长文本 TextInput 的挂载耗时
> 包含一次与文本长度成正比的**无效拷贝**。

### 7.4 三处 TODO/弃用标记

| 标记 | 位置 | 内容 |
| --- | --- | --- |
| ① | `ReactEditText.kt:989` | `// TODO T58784068: delete this method` |
| ② | `ReactEditText.kt:996-997` | `"Since the LocalData object is constructed by getting values from the underlying EditText view, we don't need to construct one or apply it at all - it provides no use in Fabric."` |
| ③ | `ReactShadowNodeImpl.java:591` | `Use {@link ReactUIManagerModule#setViewLocalData} to set this property` —— **指向的是空实现** |

> **三处标记都指向「该删」**，且工单号 `T58784068` 与 33 文档记录的
> `T207198334` 同型（**带工单号的 TODO**，见 33 文档工单号统计）。
>
> **② 的表述值得注意**：注释说「Fabric 下不需要构造或应用」，
> **但代码仍在 legacy 下构造并送进空实现** ——
> **即注释描述的是「理想状态」，代码执行的是「实际无效行为」。**

---

## 8. 三个「零调用」标志位方法（`isLayoutOnly` 等）

### 8.1 `setIsLayoutOnly` 带三条前置断言

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:538-549
  @Override
  public final void setIsLayoutOnly(boolean isLayoutOnly) {
    Assertions.assertCondition(getParent() == null, "Must remove from no opt parent first");
    Assertions.assertCondition(mNativeParent == null, "Must remove from native parent first");
    Assertions.assertCondition(getNativeChildCount() == 0, "Must remove all native children first");
    mIsLayoutOnly = isLayoutOnly;
  }

  @Override
  public final boolean isLayoutOnly() {
    return mIsLayoutOnly;
  }
```

**三条断言全部是**「**必须先解除关系**」的前置条件 —— 
即 `setIsLayoutOnly(true)` 只允许在节点**已从父链和原生子链摘除**后调用。

| 断言 | 检查 | 消息 |
| --- | --- | --- |
| ① | `getParent() == null` | `Must remove from no opt parent first` |
| ② | `mNativeParent == null` | `Must remove from native parent first` |
| ③ | `getNativeChildCount() == 0` | `Must remove all native children first` |

> **断言 ① 的消息有语法问题**：`"Must remove from no opt parent first"` ——
> `remove from no opt parent` 不成句。**疑为 `Must remove from parent first` 的笔误**
> 或遗留自 `NativeKind` 时代的 `no opt`（no-op？）措辞。
>
> **原文如此，未作改写。**

### 8.2 但它零调用

| 符号 | 全 Android 主代码出现次数 | 分布 |
| --- | --- | --- |
| `setIsLayoutOnly` | **2** | 接口声明（`ReactShadowNode.kt:229`）+ 定义（`:539`） |
| `isLayoutOnly` | 8 | 其中 6 处是**同名但无关**的符号 |

**无关的 6 处**（逐一排除）：

| 位置 | 实际是什么 |
| --- | --- |
| `fabric/mounting/SurfaceMountingManager.kt:1248` | `val isLayoutOnly = viewManager == null` —— **局部变量**，语义完全不同 |
| `fabric/mounting/SurfaceMountingManager.kt:1249` | 上一行的字符串插值 |
| `uimanager/ViewProps.kt:273` | `isLayoutOnly(map, prop)` —— **`ViewProps` 的 prop 读取工具**，与本字段无关 |
| `uimanager/ReactShadowNodeImpl.java:90` | 字段声明 |
| `uimanager/ReactShadowNodeImpl.java:543` | 赋值 |
| `uimanager/ReactShadowNodeImpl.java:548` | 返回 |

> **净结论：`setIsLayoutOnly` / `isLayoutOnly()` / `mIsLayoutOnly` 三者构成一个
> 恒 `false`、零外部写入的闭环。**
> 与 §6 的 ①–⑧ 同批 —— **layout-only 优化在 legacy Android 侧已完全移除**，
> 残留的是字段、getter、setter（含三条断言）与两个接口声明，**共 6 个成员**。

---

## 9. `isYogaLeafNode()` 是唯一「真」的能力开关

与上面 8 个空壳对照，**`isYogaLeafNode()` 是这个类里少数仍在工作的抽象方法**：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:137-148
  /**
   * Nodes that return {@code true} will not manage (and and remove) child Yoga nodes. For example
   * {@link ReactTextInputShadowNode} or {@link ReactTextShadowNode} have child nodes, which do not
   * want Yoga to lay out, so in the eyes of Yoga it is a leaf node. Override this method in
   * subclass to enforce this requirement.
   */
  @Override
  public boolean isYogaLeafNode() {
    return isMeasureDefined();
  }
```

**基类实现即「有 measure 函数则视为 Yoga 叶子」** —— **这是真逻辑，不是常量。**

**4 处调用点都在 `addChildAt` / `removeChildAt` / `removeAndDisposeAllChildren`**：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ReactShadowNodeImpl.java:227-239
    // If a CSS node has measure defined, the layout algorithm will not visit its children. Even
    // more, it asserts that you don't add children to nodes with measure functions.
    if (mYogaNode != null && !isYogaLeafNode()) {
      YogaNode childYogaNode = child.mYogaNode;
      if (childYogaNode == null) {
        throw new RuntimeException(
            "Cannot add a child that doesn't have a YogaNode to a parent without a measure "
                + "function! (Trying to add a '"
                + child.toString()
                + "' to a '"
                + toString()
                + "')");
      }
      mYogaNode.addChildAt(childYogaNode, i);
    }
```

**这段代码有三重防护**：

| # | 机制 | 作用 |
| --- | --- | --- |
| ① | `mYogaNode != null` | 父节点不是虚拟节点 |
| ② | `!isYogaLeafNode()` | 父节点**不**自行测量（否则不该有子节点） |
| ③ | `childYogaNode == null` → **`RuntimeException`** | 子节点没有 YogaNode → 立即失败 |

**注释说明了 ③ 的依据**：「it asserts that you don't add children to nodes with measure functions」。

> **这是本类中少数「主动失败优于静默降级」的设计** ——
> 与 `prepareToRecycleView` 的 `SDK_INT < P → return null`（45 文档 JJ-1，
> **降级**）形成对照：**同一套代码里两种策略并存**。
>
> **异常消息里嵌入 `child.toString()` 与 `toString()`**（`:580-582` 的
> `"[" + mViewClassName + " " + getReactTag() + "]"`）——
> **排障时能直接看出是哪两个节点冲突**，这是好的诊断设计。

---

## 10. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| KK-1 | **8 个 legacy API 成员是空壳**（恒 0 / 恒 false / 空方法体 / 零调用），含 `getTotalNativeChildren()`（公开 API 且零调用）、`isLayoutOnly` 三件套、`hoistNativeChildren()`、`isVirtualAnchor()` | `ReactShadowNodeImpl.java:134-158/:312-314/:539-554/:574-577`；`ReactShadowNode.kt:65/:81/:229/:232/:235` | **37 文档「legacy 被掏空」的实例清单**；全部因 `NativeKind removal`，共 4 处注释 |
| KK-2 | **`setLocalData` 是 9 行注释 + 空方法体**，其唯一调用链终点 `UIManagerModule.setViewLocalData` 也是 `= Unit`；`ReactTextInputLocalData.apply()` 零调用方，无 getter | `ReactShadowNodeImpl.java:584-594`；`UIManagerModule.kt:274`；`ReactTextInputLocalData.kt:22-31` | **TextInput 挂载时每次深拷贝全文（`SpannableStringBuilder`）随即丢弃**；3 处 TODO 标记 |
| KK-3 | `getNativeOffsetForChild` 的 8 行循环因 `getTotalNativeNodeContributionToParent()` 恒 0 而**退化为恒等函数**，KDoc 仍描述已失效的统计能力 | `ReactShadowNodeImpl.java:595-641` | API 语义与实现不符 |
| KK-4 | `dispatchUpdates` 与 `dispatchUpdatesWillChangeLayout` **共享 8 行重复的矩形计算**，无抽取 | `ReactShadowNodeImpl.java:346-397` | 布局语义变化须同改两处，否则去重失效 |
| KK-5 | 虚拟节点分支下 `mPadding` 不被 `Arrays.fill` 初始化，保持 `0f` 而非 `YogaConstants.UNDEFINED` | `ReactShadowNodeImpl.java:107-114` | 与非虚拟节点状态不一致 |
| KK-6 | `setIsLayoutOnly` 断言消息 `"Must remove from no opt parent first"` 语法不通，疑为 `NativeKind` 时代遗留 | `ReactShadowNodeImpl.java:540` | 排障时消息可读性差 |
| KK-7 | `dirty()` 的 inline view 场景信号断链（源码 TODO 自认，注释含笔误 `"is not be updated"`） | `ReactShadowNodeImpl.java:195-212` | inline 图片/视图尺寸变化不反映到屏幕 |

### KK-1 的适用范围声明

**这 8 个成员为空的适用范围**：

| 维度 | 条件 |
| --- | --- |
| **架构** | **仅 legacy Paper** —— 新架构走 Fabric，不实例化 `ReactShadowNodeImpl` |
| **编译条件** | 无论 `UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE` 取值，**均为空** |
| **移除原因** | `NativeKind` 概念移除（`NativeKind` 在主代码**零残留**，仅 3 条注释提及） |

**`NativeKind` 残留实测**：

| 位置 | 内容 |
| --- | --- |
| `uimanager/ReactShadowNodeImpl.java:313` | `// Commented out due to NativeKind removal` |
| `uimanager/ReactShadowNodeImpl.java:490` | `// Assertions removed due to NativeKind removal` |
| `uimanager/ReactShadowNodeImpl.java:575` | `// Logic removed due to NativeKind removal` |

**即 `NativeKind` 这个类型已从主代码完全消失，只剩 3 条注释纪念它。**

### KK-2 的适用范围声明

**这条无效通路的执行条件（三重门控全满足）**：

| # | 条件 | 类型 |
| --- | --- | --- |
| ① | `!ReactBuildConfig.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE` | **编译期常量** |
| ② | `stateWrapper == null` | **运行时** |
| ③ | `!reactContext.isBridgeless` | **运行时** |
| ④ | `uiManager != null`（`UIManagerModule` 已注册） | **运行时** |
| ⑤ | 触发点 `ReactEditText.kt:985` 的 `setIntrinsicContentSize()` 被调用 | **运行时** |

**在新架构（Fabric 或 bridgeless）下，`ReactTextInputLocalData` 完全不被构造。**

---

## 11. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 37 文档：legacy 布局层被掏空 | **给出可枚举的实例清单**（KK-1，8 个成员 + 4 条注释），并新增 §7 这条走通四层的废弃通路 |
| 45 文档：`ReactShadowNode` 有 `@Deprecated` + `@Suppress("DEPRECATION")` 双重标注 | **补上第三层**：`@LegacyArchitecture(ERROR)` + 静态块 `assertLegacyArchitecture`（§2），且 `@Deprecated(since=)` 填的是原因而非版本号 |
| 45 文档 JJ-1：`prepareToRecycleView` 在 `SDK_INT < P` 时**降级**为 `return null` | **对照**：同一类的 `addChildAt` 遇到 YogaNode 缺失**抛异常**（§9）—— 同一套代码两种失败策略并存 |
| 33 文档：带工单号的 TODO（`T207198334`） | **新增同型实例**：`// TODO T58784068: delete this method`（KK-2） |
| 33 文档：`@Suppress` 的行内注释记录原因 | **新增 7 处 `this-escape` 标注**（§4.1），跨 5 文件，`ReactRootView` 占 3 处 |
| 38 文档 §3.2：注释说有、代码没有，**但注释承认的边界就是真实边界** | **两例**：① `dirty()` 的 TODO 是有效的已知缺陷（§3.4）；② `setLocalData` 的 9 行注释是**已失效的历史承诺**（§7.1）—— **须区分「自认边界」与「历史承诺」** |
| 42 文档：内容增长过快的检测原理 | **新增一处与文本长度成正比的无谓开销**：`SpannableStringBuilder(editText.text)` 拷贝后立即丢弃（§7.3） |
| 40 文档：114 个 marker 中 38 个零引用 | **新增第三类死代码形态**：**公开 API 但零调用方**（`getTotalNativeChildren`），且其实现恒返回 0（§6.2） |