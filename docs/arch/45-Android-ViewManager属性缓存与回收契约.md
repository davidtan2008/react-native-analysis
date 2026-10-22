---
id: 45
title: "Android 侧 ViewManager 的属性反射缓存与回收契约：94 行基类重置、API 28 门槛与两处 `@Suppress(\"DEPRECATION\")`"
topic: PL.android
symptoms: [prop, memleak]
platforms: [android]
architecture: [legacy]
layer: T3
symbols: ["ViewManager", "ViewManagerPropertyUpdater"]
sourceRoot: react-native
claims: [JJ-1, JJ-2, JJ-3, JJ-3b, JJ-4, JJ-5]
---
# 45 · Android 侧 ViewManager 的属性反射缓存与回收契约：94 行基类重置、API 28 门槛与两处 `@Suppress("DEPRECATION")`

> **模块**：C2 ·
> `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/BaseViewManager.java`（1085，
> `prepareToRecycleView` 在 `:76-168`）
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagersPropertyCache.kt`（552）
> · `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagerPropertyUpdater.kt`
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · Android 侧
> **前置**：[42 文档](./42-Android内存压力与View回收池.md) 记录 6 个 opt-in ViewManager
> 与 `ReactViewGroup.recycleView()` 的 18 字段集中重置；
> [36 文档](./36-legacy-View层ComponentData与hitTest.md) 记录 iOS 侧
> `RCTComponentData` 的 prop 装配器；[39 文档](./39-TurboModule的iOS平台层.md) 记录
> `RCTComponentData` 同型的「注释解释取舍」写法。
>
> 本文记录 **`BaseViewManager.prepareToRecycleView` 这个 94 行的基类重置**
> （含 20 处 `setTag` 清空、3 处 API 版本门控、3 个 AOSP 源码链接），
> 并给出 **回收能力的一个硬性平台前提：`SDK_INT < P` 时 `return null`（不可回收）**。

---

## 1. 文件构成

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/BaseViewManager.java` | 1085 | **基类 + 94 行回收重置** |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagersPropertyCache.kt` | 552 | **反射得到的 prop setter 缓存** |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagerPropertyUpdater.kt` | — | 缓存的持有者与 `clear()` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java` | 503 | 回收池容器（42 文档 §4） |

---

## 2. 【核心】`BaseViewManager.prepareToRecycleView`：94 行基类重置

### 2.1 规模实测

```bash
# 提取该函数体并统计
python3 - <<'PY'
import io,re
t=io.open('.../BaseViewManager.java',encoding='utf-8').read()
i=t.index('protected @Nullable T prepareToRecycleView')
j=t.index('\n  @Override\n  protected void addEventEmitters', i)
body=t[i:j]
print('函数体行数:', body.count('\n'))
print('setTag 调用数:', len(re.findall(r'view\.setTag\(', body)))
print('SDK_INT 版本门控数:', len(re.findall(r'Build\.VERSION\.SDK_INT', body)))
print('AOSP 源码链接数:', len(re.findall(r'android\.googlesource\.com', body)))
PY
```

| 指标 | 值 |
| --- | --- |
| 函数体行数 | **94** |
| `view.setTag(...)` 调用 | **20**（其中 19 处带 `R.id.*` 资源 ID） |
| `Build.VERSION.SDK_INT` 版本门控 | **3** |
| AOSP 源码链接 | **3** |

**这是全仓库最长的单个「回收重置」函数** ——
对照 [42 文档 §5.3](./42-Android内存压力与View回收池.md) 的
`ReactViewGroup.initView()`（18 字段，28 行），**这里是 94 行的显式清单**。

**两种风格并存**：

| 组件 | 风格 | 规模 |
| --- | --- | --- |
| `ReactViewGroup` | **集中式**（`initView()` 18 字段） | 28 行 |
| `BaseViewManager` | **清单式**（逐项显式重置） | **94 行** |

**两者各有道理**：View 的字段是 RN 自己的（可集中），
而 View 的**系统属性**（`setFocusable`/`setElevation`/`setNextFocusDownId`…）
必须逐项调 setter（无批量 API）。

### 2.2 三段结构

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/BaseViewManager.java:76-91
  protected @Nullable T prepareToRecycleView(@NonNull ThemedReactContext reactContext, T view) {
    // Reset tags
    view.setTag(null);
    view.setTag(R.id.pointer_events, null);
    view.setTag(R.id.important_for_interaction, null);
    view.setTag(R.id.react_test_id, null);
    view.setTag(R.id.view_tag_native_id, null);
    view.setTag(R.id.labelled_by, null);
    view.setTag(R.id.accessibility_label, null);
    view.setTag(R.id.accessibility_hint, null);
    view.setTag(R.id.accessibility_role, null);
    view.setTag(R.id.accessibility_state, null);
    view.setTag(R.id.accessibility_actions, null);
    view.setTag(R.id.accessibility_value, null);
    view.setTag(R.id.accessibility_state_expanded, null);
    view.setTag(R.id.view_clipped, null);
```

| 段 | 行号 | 内容 |
| --- | --- | --- |
| ① Tags | `:77-91` | **14 个 tag 清空**（1 个无 ID + 13 个 `R.id.*`） |
| ② Transform | `:93-131` | 变换、pivot、阴影、focus ID |
| ③ 交互与外观 | `:132-167` | listener、clickable、alpha、padding、foreground |

**① 段的 14 个 tag 里，8 个是无障碍相关**
（`labelled_by`、`accessibility_label`、`accessibility_hint`、`accessibility_role`、
`accessibility_state`、`accessibility_actions`、`accessibility_value`、
`accessibility_state_expanded`）。

> **这是可访问性泄漏的防护** ——
> 若不重置，复用后的 View 会带上**上一个组件的读屏标签**。
> **这是 Android 侧回收契约里最关键的一组字段**，
> 严重性与 35 文档 Z-5（iOS `DebuggingOverlay` 高亮数组不重置）同类，
> 但**这里做对了**。

### 2.3 【核心发现】`SDK_INT < P` 直接 `return null` —— 回收有平台前提

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/BaseViewManager.java:103-109
    // RenderNode params not covered by setTransformProperty above
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      view.resetPivot();
    } else {
      // no way of resetting pivot, or knowing whether it is set
      return null;
    }
```

**`Build.VERSION_CODES.P` = API 28（Android 9）**。

**即：Android 8.1（API 27）及以下，`prepareToRecycleView` 在 `:107` 返回 `null`。**

**而 `ViewManager` 的入池路径（42 文档 §4.2）对 `null` 的处理是**：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java:269-273
    if (recyclableViews != null) {
      T recyclableView = prepareToRecycleView(themedReactContext, view);
      if (recyclableView != null) {
        recyclableViews.push(recyclableView);
      }
    }
```

**`null` → 不入池 → 该 View 走正常销毁路径。**

> **结论（必须限定适用范围）**：
>
> | 平台版本 | `prepareToRecycleView` 返回 | 回收池 |
> | --- | --- | --- |
> | **API 28+（Android 9+）** | `view` | **正常工作** |
> | **API 27 及以下（Android 8.1-）** | **`null`** | **完全禁用** |
>
> **注释说明了原因**：
> `// no way of resetting pivot, or knowing whether it is set`
>
> **即 API < 28 没有 `resetPivot()`，作者选择「宁可不回收」而非「带着脏 pivot 复用」。**
>
> **这是正确的取舍**（错误复用会导致布局错位），
> **但它意味着 View 回收这一性能优化在 Android 9 以下完全不存在。**

### 2.4 三处版本门控逐个核实

| # | 行号 | 门控 | API | 行为 |
| --- | --- | --- | --- | --- |
| ① | `:103-109` | `>= P` | **28** | `resetPivot()`；**否则 `return null`** |
| ② | `:113-116` | `>= Q` | **29** | `setAnimationMatrix(null)`（注释：*failsafe - should already be set to null when animation finishes*） |
| ③ | `:125-128` | `>= P` | **28** | `setOutlineAmbientShadowColor(Color.BLACK)` + `setOutlineSpotShadowColor(Color.BLACK)` |

**② 的注释自述是「failsafe」** —— 即正常路径下动画结束时已置 null，
这里只是兜底。

**③ 的两个 `Color.BLACK`** —— 与 `View` 的默认阴影色一致。

### 2.5 三处 AOSP 源码链接（第一档注释）

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/BaseViewManager.java:139-143
    // Focus IDs
    // Also see in AOSP source:
    // https://android.googlesource.com/platform/frameworks/base/+/a175a5b/core/java/android/view/View.java#4493
    view.setNextFocusDownId(View.NO_ID);
    view.setNextFocusForwardId(View.NO_ID);
    view.setNextFocusRightId(View.NO_ID);
    view.setNextFocusUpId(View.NO_ID);

    // This is possibly subject to change and overridable per-platform, but these
    // are the default view flags in View.java:
    // https://android.googlesource.com/platform/frameworks/base/+/a175a5b/core/java/android/view/View.java#2712
    // `mViewFlags = SOUND_EFFECTS_ENABLED | HAPTIC_FEEDBACK_ENABLED | LAYOUT_DIRECTION_INHERIT`
```

**链接指向具体 commit（`a175a5b`）与行号（`#4493`、`#2712`）** ——
这不是「参考文档」，而是**「我为什么这么写」的证据**。

**第三处 AOSP 链接在 `:159-161`**（`setAlpha(1)` 的默认值依据）。

### 2.6 两条约束顺序的 NOTE

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/BaseViewManager.java:152-155
    // NOTE: setClickable MUST be called AFTER setOnClickListener because
    // the latter has the side effect of setting isClickable=true on some views!
    view.setOnClickListener(null);
    view.setClickable(false);
```

**注释用全大写 `MUST` 强调顺序** ——
因为 `setOnClickListener(null)` 在某些 View 上会副作用地把 `isClickable` 设为 `true`。

> **这是「顺序依赖」的显式警告**，与 42 文档 §5.4 的
> Kotlin 字段声明顺序陷阱同类：
> **两处都是「顺序错了会静默出错」，两处都用注释强调了顺序。**

---

## 3. 属性反射缓存：`ViewManagersPropertyCache`

### 3.1 两个缓存与一个 `@Suppress("DEPRECATION")`

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagersPropertyCache.kt:27-38
@Suppress("DEPRECATION") // ReactShadowNode is @Deprecated but still required by this cache.
internal object ViewManagersPropertyCache {

  private val CLASS_PROPS_CACHE: MutableMap<Class<*>, Map<String, PropSetter>> = HashMap()
  private val EMPTY_PROPS_MAP: MutableMap<String, PropSetter> = HashMap()

  @JvmStatic
  fun clear() {
    CLASS_PROPS_CACHE.clear()
    EMPTY_PROPS_MAP.clear()
  }
```

**`@Suppress` 的注释是本文最值得记录的一句**：

> `// ReactShadowNode is @Deprecated but still required by this cache.`

**即：`ReactShadowNode` 已被标记 `@Deprecated`，
但这个缓存仍在为它收集 prop setter。**

> **这与 [37 文档](./37-legacy布局层被掏空与ShadowQueue转用.md) 的结论一致**：
> **legacy 的 `ReactShadowNode` 在 Android 侧也是「已弃用但仍在用」。**
> 但 Android 侧**至少用 `@Suppress` + 注释显式承认了**，
> 而 iOS 侧 `RCTShadowView` 是**静默保留**（37 文档 §3）。

### 3.2 类注释说明了职责边界

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagersPropertyCache.kt:25-27
/**
 * This class is responsible for holding view manager property setters and is used in a process of
 * updating views with the new properties set in JS.
 */
```

**「holding view manager property setters」** —— 只管 ViewManager 的 prop，
不管 module。

### 3.3 `PropSetter` 的两个构造器

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagersPropertyCache.kt:40-58
  internal abstract class PropSetter {

    val propName: String
    val propType: String
    protected val setter: Method
    protected val index: Int? // non-null only for group setters

    protected constructor(prop: ReactProp, defaultType: String, setter: Method) {
      propName = prop.name
      propType = if (ReactProp.USE_DEFAULT_TYPE == prop.customType) defaultType else prop.customType
      this.setter = setter
      this.index = null
    }

    protected constructor(prop: ReactPropGroup, defaultType: String, setter: Method, index: Int) {
      propName = prop.names[index]
      propType =
          if (ReactPropGroup.USE_DEFAULT_TYPE == prop.customType) defaultType else prop.customType
      this.setter = setter
      this.index = index
    }
```

**两个构造器的唯一差别**：

| | `ReactProp` | `ReactPropGroup` |
| --- | --- | --- |
| `propName` | `prop.name`（单个） | **`prop.names[index]`（按索引取）** |
| `index` | `null` | `index`（构造参数） |

**`propType` 的解析逻辑两者相同**：`USE_DEFAULT_TYPE` 时用 `defaultType`，
否则用 `prop.customType`。

> **这与 36 文档记录的 iOS `RCTComponentData` 的 `propConfig*_` 机制是同一思路**
> （从 ViewManager 上反射 prop 元信息），但：
>
> | | iOS `RCTComponentData` | Android `ViewManagersPropertyCache` |
> | --- | --- | --- |
> | 元信息来源 | ViewManager 的 `propConfig*_` **类方法** | `@ReactProp` **注解** |
> | 缓存 | ❌ 无（每次 `createPropBlock` 现算） | ✅ `CLASS_PROPS_CACHE` |
> | 失效 | — | ✅ `clear()` |
>
> **Android 侧有缓存、iOS 侧没有** ——
> iOS 侧每次新建 View 都重新反射一遍 prop 配置。

### 3.4 缓存的持有者与 `clear()` 的调用方

```kotlin
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManagerPropertyUpdater.kt:33-43
  private const val TAG = "ViewManagerPropertyUpdater"

  private val VIEW_MANAGER_SETTER_MAP: MutableMap<Class<*>, ViewManagerSetter<*, *>> = HashMap()
  private val SHADOW_NODE_SETTER_MAP: MutableMap<Class<*>, ShadowNodeSetter<*>> = HashMap()

  @JvmStatic
  public fun clear() {
    ViewManagersPropertyCache.clear()
    VIEW_MANAGER_SETTER_MAP.clear()
    SHADOW_NODE_SETTER_MAP.clear()
  }
```

**三层缓存，一个 `clear()` 入口**：

```
ViewManagerPropertyUpdater.clear()          ← :38-43
  ├─ ViewManagersPropertyCache.clear()       ← :38-39
  │    ├─ CLASS_PROPS_CACHE.clear()          ← :37
  │    └─ EMPTY_PROPS_MAP.clear()            ← :38
  ├─ VIEW_MANAGER_SETTER_MAP.clear()         ← :40
  └─ SHADOW_NODE_SETTER_MAP.clear()          ← :41
```

**`clear()` 恰好有 2 个生产调用方，且都在 `invalidate()` 里**：

| # | 调用方 | 架构 | 所在方法 | 上下文 |
| --- | --- | --- | --- | --- |
| ① | `fabric/FabricUIManager.java:499` | **Fabric** | `invalidate()`（`:466`） | 摘掉生命周期监听 → `onHostPause()` → `mBinding.unregister()` → **`clear()`** |
| ② | `uimanager/UIManagerModule.kt:154` | **legacy（Paper）** | `invalidate()`（`:148`） | 注销 2 个 `ComponentCallbacks` → **`clear()`** |

**即缓存失效绑在「UIManager 实例销毁」上，而不是绑在 reload 上** ——
两侧的 `invalidate()` 语义一致（模块级失效 = 实例 teardown）。

> **两条路径对称**：Fabric 侧与 Paper 侧各有且仅有一个 `clear()` 调用点，
> 都在 `invalidate()` 末尾。**这是有意的一致设计，不是巧合。**

### 3.5 缓存的唯一生产读取点：`getNativeProps`

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java:408-416
  public Map<String, String> getNativeProps() {
    if (ReactBuildConfig.UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE
        && ReactNativeNewArchitectureFeatureFlags.enableBridgelessArchitecture()) {
      // TODO: review if we need to check fabricInterop here
      return ViewManagerPropertyUpdater.getNativeProps(getClass(), null);
    } else {
      return ViewManagerPropertyUpdater.getNativeProps(getClass(), getShadowNodeClass());
    }
  }
```

**唯一的分支差异是第二个参数 `shadowNodeClass`**：

| 编译/运行条件 | 传入的 `shadowNodeClass` |
| --- | --- |
| `UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE` **且** bridgeless | **`null`** |
| 其他全部组合 | `getShadowNodeClass()` |

**即：只有「最小化 legacy 架构的实验开关 + bridgeless」这一种组合会跳过 ShadowNode 的 prop 收集。**
注释 `// TODO: review if we need to check fabricInterop here` 说明**这个条件本身作者也不确定是否完备**。

> **这解释了 §3.1 的 `@Suppress("DEPRECATION")` 为什么必要** ——
> `getShadowNodeClass()` 是默认路径，而它返回的正是已 `@Deprecated` 的 `ReactShadowNode` 类型。

---

## 4. 回收契约的两端对照（Android）

### 4.1 三层结构

| 层 | 位置 | 内容 |
| --- | --- | --- |
| **① 基类** | `BaseViewManager.prepareToRecycleView:76-168` | **94 行**：14 tag + transform + 交互外观 |
| **② 中间层** | `ReactViewManager` / `ReactTextViewManager` 等 6 个 | `super.` + 各自的 `recycleView()`（42 文档 §5.2） |
| **③ 具体 View** | `ReactViewGroup.recycleView:206-242` | 18 字段 `initView()` + 6 类动作 |

**入池侧的前置摘除**（42 文档 §4 未记录的部分）：

```java
// packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/ViewManager.java:211-221
    @Nullable Stack<T> recyclableViews = getRecyclableViewStack(reactContext.getSurfaceId(), true);
    if (recyclableViews != null && !recyclableViews.empty()) {
      T recyclableView = recyclableViews.pop();

      // When view recycling isn't enabled for all components, a recyclable view could still be
      // attached to a non-recyclable view. This guarantees that recycled view have been removed
      // from their parent.
      if (ReactNativeFeatureFlags.enableViewRecycling() && recyclableView.getParent() != null) {
        ((ViewGroup) recyclableView.getParent()).removeView(recyclableView);
      }
```

> **即「复用时若发现 View 还挂在父节点上，强制摘除」** ——
> 注释说明了成因：**回收不是全局开启的**，
> 可回收的 View 可能被挂在一个**不可回收**的父节点下（那个父节点不会走 `prepareToRecycleView`）。
> **这是「部分开启」这一设计选择的必要补丁**，注释把因果写清了（第一档注释）。

**调用顺序**：

```
ViewManager 卸载 → prepareToRecycleView
  ├─ ① ReactViewManager.prepareToRecycleView
  │    ├─ view.removeClippedSubviews = false     ← 42 文档 §5.2
  │    └─ super.prepareToRecycleView              ← ① 基类 94 行
  │         └─ return view（API 28+） 或 null（API 27-）
  └─ ② preparedView?.recycleView()                ← ③ 具体 View
       └─ initView()（18 字段）+ 6 类动作
  ↓
recyclableViews.push(recyclableView)               ← 非 null 才入池
```

### 4.2 三层的重置范围对比

| 重置类型 | ① 基类 | ③ `ReactViewGroup` |
| --- | --- | --- |
| `R.id.*` tags | ✅ **14 个**（含 8 个无障碍） | ❌ |
| transform / pivot / shadow | ✅ | ❌（`_removeClippedSubviews` 等是 RN 自己的） |
| focus ID / clickable / focusable | ✅ | ❌ |
| alpha / padding / foreground | ✅ | ❌ |
| RN 自有字段 | ❌ | ✅ **18 个** |
| layout 监听器 | ✅ `removeOnLayoutChangeListener(this)` | ✅ `childrenLayoutChangeListener?.shutdown()` |
| 子视图 | ❌ | ✅ `removeAllViews()` |
| 父视图摘除 | ❌ | ✅ `parent.removeView(this)` + `invalidateAncestors` |

**「系统属性」与「RN 自有状态」的分工是清晰的** ——
① 管前者，③ 管后者。

> **这个分工是本仓库回收契约里最清晰的一处**。
> 对照 35 文档的 iOS 侧：`RCTViewComponentView.prepareForRecycle`
> 把两者混在一起（4 个 layer + 5 个状态变量），
> 职责边界不如 Android 明确。

---

## 5. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| JJ-1 | **`SDK_INT < P`（API 27 及以下）时 `prepareToRecycleView` 返回 `null`，回收池完全不工作** | `uimanager/BaseViewManager.java:105-109` | **View 回收优化在 Android 9 以下不存在**；注释说明了原因（无法重置 pivot），取舍正确但**未在文档中说明适用范围** |
| JJ-2 | `ReactShadowNode` 已 `@Deprecated` 但缓存仍依赖它，靠 `@Suppress("DEPRECATION")` + 注释承认 | `uimanager/ViewManagersPropertyCache.kt:31` | **legacy 路径仍在关键路径上**；Android 侧处理方式比 iOS 侧规范（37 文档 §3） |
| JJ-3 | ~~`clear()` 的生产调用方未找到~~ **修正**：确有 2 个调用方（`FabricUIManager.java:499`、`UIManagerModule.kt:154`），但**都在 `invalidate()` 里，即绑在 UIManager teardown 而非 reload** | `uimanager/ViewManagerPropertyUpdater.kt:38-43`；`fabric/FabricUIManager.java:466-500`；`uimanager/UIManagerModule.kt:148-155` | **两侧对称，非遗漏**；但「热重载期间缓存不失效」是有意设计（避免重复反射），依赖 `invalidate()` 一定被调用 |
| JJ-3b | `getNativeProps` 的分支条件里有 `// TODO: review if we need to check fabricInterop here` —— **作者自己标注该条件不完备** | `uimanager/ViewManager.java:409-415` | 该 TODO 若长期不解决，bridgeless + minify 组合下可能漏收 Fabric 侧 prop |
| JJ-4 | Android 有 prop 反射缓存、iOS 没有（每次现算） | Android `ViewManagersPropertyCache` vs iOS `RCTComponentData`（36 文档） | 性能不对称；iOS 侧每次新建 View 多一次反射 |
| JJ-5 | 三处 AOSP 链接指向具体 commit `a175a5b`，**AOSP 后续变更不会自动同步** | `uimanager/BaseViewManager.java:141, 147, 160` | 若 AOSP 改了 `mViewFlags` 默认值，RN 的重置会过时（注释已声明 *possibly subject to change*） |

### JJ-1 的适用范围声明（本文最重要的限定）

**这一条必须精确表述，避免「View 回收池在 Android 上有 1024 上限」那类误解**：

| 维度 | 适用条件 |
| --- | --- |
| **平台** | Android **API 28+**（Android 9+） |
| **Feature Flag** | `enableViewRecycling()` 为真 |
| **组件** | 仅 6 个 opt-in 的 ViewManager（42 文档 §5.1） |
| **架构** | legacy 与 Fabric 共用（`ViewManager` 不区分） |
| **入口** | 宿主需在 ViewManager 构造函数调 `setupViewRecycling()` |

**五条同时满足才生效。任一不满足则回收池为空，View 走正常创建/销毁。**

---

## 6. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 42 文档：6 个 opt-in ViewManager 与 `ReactViewGroup.recycleView()` 18 字段 | **补上基类层**（94 行系统属性重置），并给出**三层结构与分工表**（§4） |
| 42 文档：回收池无 size 上限 | **补上平台前提**：`API < 28` 时整个回收机制不存在（JJ-1） |
| 37 文档：iOS `RCTShadowView` 静默保留（无 deprecated 标注） | **对照**：Android 的 `ReactShadowNode` 有 `@Deprecated` **且** `@Suppress` + 注释承认（JJ-2） |
| 36 文档：iOS `RCTComponentData` 每次现算 prop 配置 | **对照**：Android 有 `CLASS_PROPS_CACHE`（JJ-4） |
| 36 文档 §5.1：注释质量第一档（理由 + 外部参考） | **新增 Android 侧第一档实例**：3 处 AOSP commit 级链接（§2.5） |
| 33 文档：`T207198334` 等工单号 | **对照**：`@Suppress("DEPRECATION")` 的行内注释是 Android 侧处理弃用的方式 |
| 35 文档 Z-5：iOS 高亮数组不重置 | **对照**：Android 的 14 个 tag（含 8 个无障碍）**做对了**（§2.2） |
| 42 文档 §5.4：Kotlin 字段声明顺序陷阱 | **新增同型**：Java 侧 `setClickable` MUST AFTER `setOnClickListener`（§2.6） |
| 40 文档：114 个 marker 中 38 个零引用 | **新增第三类「机制存在但调用方未确认」**：`ViewManagerPropertyUpdater.clear()`（JJ-3） |