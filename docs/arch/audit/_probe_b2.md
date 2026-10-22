# Probe B2 — 动画系统（Animation System）事实核查报告

Repo: `react-native`
基线 commit: `9b131e42d12`
性质: **只读分析**，未修改任何源码。每条事实结论都带 `path:line`。不确定处写「未确认」。

---

## 0. 目录存在性更正（先于一切）

任务要求的 5 个目录中，**1 个不存在**：

| 请求的目录 | 实际状态 |
|---|---|
| `packages/react-native/Libraries/Animated/` | 存在 |
| `packages/react-native/ReactCommon/react/renderer/animations/` | 存在 |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/` | 存在 |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/animation/` | **不存在**（`ls` → "No such file or directory"）。`ReactAndroid/src/main/java/com/facebook/react/views/` 下唯一的 animation 相关文件是 `views/text/internal/span/AnimatedEffectSpan.kt`（无头文件 span，无驱动） |
| `packages/react-native/React/Fabric/` | 存在（animation 相关文件见 §1.4） |

由于 `views/animation/` 是 iOS/Java 侧历史上常见的 LayoutAnimation 目录（Android 侧从未有该目录），本报告把「Native Animated 的 Java/Kotlin 实现」定位在 `ReactAndroid/.../react/animated/`，把「Native Animated 的 Objective-C++ 实现」补充纳入 `packages/react-native/Libraries/NativeAnimation/`（47 文件 / 3058 行），因为「枚举每个 native driver 子类」「CADisplayLink 使用点」「native 驱动 vs JS 驱动中断语义对比」这三项要求无法只看 Kotlin 侧完成。

同时补充纳入两个与 JS/平台代码直接耦合、但**不在**请求列表中的目录（后文标注为「附加」）：

- `packages/react-native/src/private/animated/`（4 文件 / 1268 行）—— `NativeAnimatedHelper.js` 是 JS↔native 的唯一桥，JS 侧所有生命周期行为都在这里。
- `packages/react-native/ReactCommon/react/renderer/animated/` + `animationbackend/`（共享 C++ backend，5663+ 行）—— 由 `cxxNativeAnimatedEnabled` / `useSharedAnimatedBackend` 门控，属**第三套** native 动画后端。只在与问题 2/6/7 相关处引用，不逐文件覆盖。

---

## 1. FILE INVENTORY

### 1.1 每目录非测试文件数 + 总行数（实测命令）

排除集统一为：`*__tests__/*`、`*/tests/*`（C++ GoogleTest）、`node_modules/`。

```sh
# A
find packages/react-native/Libraries/Animated -type f \( -name '*.js' -o -name '*.flow' \) \
  -not -path '*/__tests__/*' | wc -l
find packages/react-native/Libraries/Animated -type f \( -name '*.js' -o -name '*.flow' \) \
  -not -path '*/__tests__/*' -print0 | xargs -0 cat | wc -l

# B
find packages/react-native/src/private/animated -type f -name '*.js' \
  -not -path '*/__tests__/*' | wc -l
find packages/react-native/src/private/animated -type f -name '*.js' \
  -not -path '*/__tests__/*' -print0 | xargs -0 cat | wc -l

# C
find packages/react-native/ReactCommon/react/renderer/animations -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.txt' \) \
  -not -path '*/tests/*' | wc -l
find packages/react-native/ReactCommon/react/renderer/animations -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.txt' \) \
  -not -path '*/tests/*' -print0 | xargs -0 cat | wc -l

# D
find packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated -type f -name '*.kt' | wc -l
find packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated -type f -name '*.kt' \
  -print0 | xargs -0 cat | wc -l

# F（附加）
find packages/react-native/Libraries/NativeAnimation -type f \( -name '*.m' -o -name '*.mm' -o -name '*.h' \) | wc -l
find packages/react-native/Libraries/NativeAnimation -type f \( -name '*.m' -o -name '*.mm' -o -name '*.h' \) \
  -print0 | xargs -0 cat | wc -l
```

| # | 目录 | 非测试文件 | 非测试行数 |
|---|---|---|---|
| A | `packages/react-native/Libraries/Animated/` | **48** | **7,227** |
| B | `packages/react-native/src/private/animated/`（附加） | **4** | **1,268** |
| C | `packages/react-native/ReactCommon/react/renderer/animations/` | **10** | **2,530**（含 `CMakeLists.txt` 34 行） |
| D | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/` | **24** | **3,584** |
| E | `.../react/views/animation/` | **不存在** | — |
| F | `packages/react-native/Libraries/NativeAnimation/`（附加） | **47** | **3,058** |

A–D 合计：**86 文件 / 14,609 行**（不含 F）。

### 1.2 C++ renderer/animations 子目录

`packages/react-native/ReactCommon/react/renderer/animations/` 只有 `tests/`（2 个测试文件，已排除）与 9 个源文件 + `CMakeLists.txt`。

### 1.3 最大的 30 个文件（精确行数）

命令：

```sh
find packages/react-native/Libraries/Animated \
     packages/react-native/ReactCommon/react/renderer/animations \
     packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated \
     packages/react-native/src/private/animated \
     packages/react-native/Libraries/NativeAnimation \
  -type f \( -name '*.js' -o -name '*.flow' -o -name '*.cpp' -o -name '*.h' -o -name '*.kt' \
            -o -name '*.m' -o -name '*.mm' \) \
  -not -path '*/__tests__/*' -not -path '*/tests/*' -print0 | xargs -0 wc -l | sort -rn
```

| # | 行数 | 文件 |
|---|---|---|
| 1 | 1645 | `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp` |
| 2 | 1040 | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/NativeAnimatedModule.kt` |
| 3 | 782 | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/NativeAnimatedNodesManager.kt` |
| 4 | 770 | `packages/react-native/Libraries/Animated/AnimatedImplementation.js` |
| 5 | 571 | `packages/react-native/Libraries/Animated/nodes/AnimatedInterpolation.js` |
| 6 | 504 | `packages/react-native/Libraries/NativeAnimation/RCTNativeAnimatedNodesManager.mm` |
| 7 | 500 | `packages/react-native/src/private/animated/NativeAnimatedHelper.js` |
| 8 | 393 | `packages/react-native/Libraries/Animated/nodes/AnimatedProps.js` |
| 9 | 384 | `packages/react-native/Libraries/NativeAnimation/RCTNativeAnimatedTurboModule.mm` |
| 10 | 376 | `packages/react-native/Libraries/Animated/animations/SpringAnimation.js` |
| 11 | 362 | `packages/react-native/src/private/animated/createAnimatedPropsMemoHook.js` |
| 12 | 349 | `packages/react-native/Libraries/Animated/nodes/AnimatedColor.js` |
| 13 | 339 | `packages/react-native/src/private/animated/createAnimatedPropsHook.js` |
| 14 | 328 | `packages/react-native/Libraries/Animated/nodes/AnimatedValue.js` |
| 15 | 292 | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/InterpolationAnimatedNode.kt` |
| 16 | 279 | `packages/react-native/Libraries/Animated/AnimatedEvent.js` |
| 17 | 262 | `packages/react-native/Libraries/Animated/nodes/AnimatedStyle.js` |
| 18 | 261 | `packages/react-native/Libraries/Animated/nodes/AnimatedNode.js` |
| 19 | 251 | `packages/react-native/Libraries/Animated/Easing.js` |
| 20 | 245 | `packages/react-native/Libraries/Animated/nodes/AnimatedValueXY.js` |
| 21 | 208 | `packages/react-native/Libraries/Animated/nodes/AnimatedTransform.js` |
| 22 | 207 | `packages/react-native/Libraries/Animated/animations/Animation.js` |
| 23 | 205 | `packages/react-native/ReactCommon/react/renderer/animations/conversions.h` |
| 24 | 200 | `packages/react-native/Libraries/NativeAnimation/Drivers/RCTSpringAnimation.mm` |
| 25 | 197 | `packages/react-native/Libraries/Animated/AnimatedMock.js` |
| 26 | 193 | `packages/react-native/Libraries/Animated/AnimatedExports.js.flow` |
| 27 | 187 | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/SpringAnimation.kt` |
| 28 | 187 | `packages/react-native/Libraries/Animated/animations/TimingAnimation.js` |
| 29 | 182 | `packages/react-native/Libraries/Animated/nodes/AnimatedObject.js` |
| 30 | 176 | `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.h` |

（第 31 名：`packages/react-native/Libraries/NativeAnimation/Nodes/RCTInterpolationAnimatedNode.mm` = 167 行）

### 1.4 React/Fabric 中 animation 相关文件（实测 `grep -rl -i animat packages/react-native/React/Fabric/`）

| 文件 | 总行数 | animation 相关行 |
|---|---|---|
| `packages/react-native/React/Fabric/RCTScheduler.mm` | 290 | 13, 141–185, 189–192, 200–213, 216, 222–225, 232–239, 256–273 |
| `packages/react-native/React/Fabric/RCTScheduler.h` | 82 | 66, 68, 70, 72 |
| `packages/react-native/React/Fabric/RCTSurfacePresenter.mm` | 505 | 216–218 |
| `packages/react-native/React/Fabric/RCTSurfacePresenter.h` | 87 | 71 |
| `packages/react-native/React/Fabric/Surface/RCTFabricSurface.mm` | 312 | 111 |
| `packages/react-native/React/Fabric/AppleEventBeat.h` / `.mm` | 75 / 123 | 仅注释提及 Core Animation（31–37 / 17, 44），无动画逻辑 |
| `packages/react-native/React/Fabric/Mounting/RCTMountingManager.mm` | 350 | 285–331（`synchronouslyUpdateViewOnUIThread:` 中的 transform/opacity 直写 layer） |
| `packages/react-native/React/Fabric/Mounting/UIView+ComponentViewProtocol.h/.mm` | 53 / 176 | 46–47 / 154–161 |
| `packages/react-native/React/Fabric/Mounting/RCTComponentViewProtocol.h` | 136 | 131–132 |
| `packages/react-native/React/Fabric/Utils/PlatformRunLoopObserver.h/.mm` | 49 / 92 | LayoutAnimation 的 run-loop 观察者实现 |

---

## 2. ANIMATION DRIVERS

### 2.1 全量 driver / node 类型清单（JS Animated）

基类 `Animation`：`packages/react-native/Libraries/Animated/animations/Animation.js:43`

| 类型 | 声明位置 | 父类 |
|---|---|---|
| `Animation`（基类） | `packages/react-native/Libraries/Animated/animations/Animation.js:43` | — |
| `TimingAnimation` | `packages/react-native/Libraries/Animated/animations/TimingAnimation.js:63` | `Animation` |
| `SpringAnimation` | `packages/react-native/Libraries/Animated/animations/SpringAnimation.js:88` | `Animation` |
| `DecayAnimation` | `packages/react-native/Libraries/Animated/animations/DecayAnimation.js:38` | `Animation` |

JS node 基类 `AnimatedNode`：`packages/react-native/Libraries/Animated/nodes/AnimatedNode.js:33`

| 类型 | 声明位置 | 父类 | `__isNativeValueNode` |
|---|---|---|---|
| `AnimatedNode`（基类） | `.../nodes/AnimatedNode.js:33` | — | `false`（`:94`） |
| `AnimatedWithChildren` | `.../nodes/AnimatedWithChildren.js:21` | `AnimatedNode` | 未设置 → `false` |
| `AnimatedValue` | `.../nodes/AnimatedValue.js:88` | `AnimatedWithChildren` | `true`（`:89`） |
| `AnimatedValueXY` | `.../nodes/AnimatedValueXY.js:34` | `AnimatedWithChildren` | 未设置 → `false` |
| `AnimatedColor` | `.../nodes/AnimatedColor.js:136` | `AnimatedWithChildren` | 未设置 → `false` |
| `AnimatedAddition` | `.../nodes/AnimatedAddition.js:22` | `AnimatedWithChildren` | 未设置 → `false` |
| `AnimatedSubtraction` | `.../nodes/AnimatedSubtraction.js:22` | `AnimatedWithChildren` | 未设置 → `false` |
| `AnimatedMultiplication` | `.../nodes/AnimatedMultiplication.js:22` | `AnimatedWithChildren` | 未设置 → `false` |
| `AnimatedDivision` | `.../nodes/AnimatedDivision.js:22` | `AnimatedWithChildren` | `true`（`:23`） |
| `AnimatedModulo` | `.../nodes/AnimatedModulo.js:21` | `AnimatedWithChildren` | `true`（`:22`） |
| `AnimatedDiffClamp` | `.../nodes/AnimatedDiffClamp.js:21` | `AnimatedWithChildren` | `true`（`:22`） |
| `AnimatedInterpolation` | `.../nodes/AnimatedInterpolation.js:449` | `AnimatedWithChildren` | `true`（`:452`） |
| `AnimatedStyle` | `.../nodes/AnimatedStyle.js:84` | `AnimatedWithChildren` | 未设置 → `false` |
| `AnimatedTransform` | `.../nodes/AnimatedTransform.js:47` | `AnimatedWithChildren` | 未设置 → `false` |
| `AnimatedObject` | `.../nodes/AnimatedObject.js:93` | `AnimatedWithChildren` | 未设置 → `false` |
| `AnimatedProps` | `.../nodes/AnimatedProps.js:98` | `AnimatedNode`（**直接**） | 未设置 → `false` |
| `AnimatedTracking` | `.../nodes/AnimatedTracking.js:28` | `AnimatedNode`（**直接**） | 未设置 → `false` |

> 注意：`AnimatedProps` 与 `AnimatedTracking` 直接继承 `AnimatedNode`（不是 `AnimatedWithChildren`），因此没有 `_children`，其 `__detach()` 自行遍历子节点（`AnimatedProps.js:225-238`）。

### 2.2 全量 driver / node 类型清单（Native Animated · Android）

基类 `AnimationDriver`：`packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/AnimationDriver.kt:18`

| 类型 | 声明位置 | 父类 |
|---|---|---|
| `AnimationDriver`（基类） | `.../animated/AnimationDriver.kt:18` | — |
| `FrameBasedAnimationDriver` | `.../animated/FrameBasedAnimationDriver.kt:21` | `AnimationDriver` |
| `SpringAnimation` | `.../animated/SpringAnimation.kt:18` | `AnimationDriver` |
| `DecayAnimation` | `.../animated/DecayAnimation.kt:18` | `AnimationDriver` |
| `EventAnimationDriver` | `.../animated/EventAnimationDriver.kt:19` | **不继承** `AnimationDriver`，实现 `RCTModernEventEmitter`（事件驱动，非帧驱动） |

节点基类 `AnimatedNode`：`.../animated/AnimatedNode.kt:13`；`ValueAnimatedNode`：`.../animated/ValueAnimatedNode.kt:16`

| 类型 | 声明位置 | 父类 |
|---|---|---|
| `AnimatedNode`（基类） | `.../animated/AnimatedNode.kt:13` | — |
| `ValueAnimatedNode` | `.../animated/ValueAnimatedNode.kt:16` | `AnimatedNode` |
| `InterpolationAnimatedNode` | `.../animated/InterpolationAnimatedNode.kt:23` | `ValueAnimatedNode` |
| `DiffClampAnimatedNode` | `.../animated/DiffClampAnimatedNode.kt:15` | `ValueAnimatedNode` |
| `ModulusAnimatedNode` | `.../animated/ModulusAnimatedNode.kt:13` | `ValueAnimatedNode` |
| `DivisionAnimatedNode` | `.../animated/DivisionAnimatedNode.kt:17` | `ValueAnimatedNode` |
| `AdditionAnimatedNode` | `.../animated/AdditionAnimatedNode.kt:17` | `ValueAnimatedNode` |
| `SubtractionAnimatedNode` | `.../animated/SubtractionAnimatedNode.kt:17` | `ValueAnimatedNode` |
| `MultiplicationAnimatedNode` | `.../animated/MultiplicationAnimatedNode.kt:17` | `ValueAnimatedNode` |
| `StyleAnimatedNode` | `.../animated/StyleAnimatedNode.kt:16` | `AnimatedNode` |
| `PropsAnimatedNode` | `.../animated/PropsAnimatedNode.kt:21` | `AnimatedNode` |
| `ColorAnimatedNode` | `.../animated/ColorAnimatedNode.kt:18` | `AnimatedNode`（+ `AnimatedNodeWithUpdateableConfig`） |
| `ObjectAnimatedNode` | `.../animated/ObjectAnimatedNode.kt:20` | `AnimatedNode` |
| `TransformAnimatedNode` | `.../animated/TransformAnimatedNode.kt:18` | `AnimatedNode` |
| `TrackingAnimatedNode` | `.../animated/TrackingAnimatedNode.kt:13` | `AnimatedNode` |

节点工厂：`.../animated/NativeAnimatedNodesManager.kt:98-114`（13 种 `type` 字符串 → 类）。
driver 工厂：`.../animated/NativeAnimatedNodesManager.kt:237-246`（`"frames"` / `"spring"` / `"decay"`，其余抛异常）。

### 2.3 全量 driver（Native Animated · iOS，附加目录）

协议 `RCTAnimationDriver`：`packages/react-native/Libraries/NativeAnimation/Drivers/RCTAnimationDriver.h:19`

| 类型 | 声明位置 | 协议 |
|---|---|---|
| `RCTFrameAnimation` | `.../NativeAnimation/Drivers/RCTFrameAnimation.h:10`（`.mm`） | `RCTAnimationDriver` |
| `RCTSpringAnimation` | `.../NativeAnimation/Drivers/RCTSpringAnimation.h:10`（`.mm`） | `RCTAnimationDriver` |
| `RCTDecayAnimation` | `.../NativeAnimation/Drivers/RCTDecayAnimation.h:10`（`.mm`） | `RCTAnimationDriver` |
| `RCTEventAnimation` | `.../NativeAnimation/Drivers/RCTEventAnimation.h:12`（`.mm`） | **不实现** driver 协议，事件驱动 |

iOS 节点 14 个（`.../NativeAnimation/Nodes/RCT*AnimatedNode.{h,mm}`），工厂见 `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:84-101`。

### 2.4 什么驱动一帧（requestAnimationFrame / Choreographer / CADisplayLink）

**JS 驱动 —— 每 driver 一个 RAF 循环（不是一个全局 scheduler）**

| 位置 | 代码 |
|---|---|
| `packages/react-native/Libraries/Animated/animations/SpringAnimation.js:364` | `this._animationFrame = requestAnimationFrame(this.onUpdate.bind(this));` |
| `packages/react-native/Libraries/Animated/animations/TimingAnimation.js:142` | `this._animationFrame = requestAnimationFrame(() => this.onUpdate());` |
| `packages/react-native/Libraries/Animated/animations/TimingAnimation.js:174` | `this._animationFrame = requestAnimationFrame(this.onUpdate.bind(this));` |
| `packages/react-native/Libraries/Animated/animations/DecayAnimation.js:91` | `this._animationFrame = requestAnimationFrame(() => this.onUpdate());` |
| `packages/react-native/Libraries/Animated/animations/DecayAnimation.js:113` | `this._animationFrame = requestAnimationFrame(this.onUpdate.bind(this));` |

`requestAnimationFrame` 本体来自 `packages/react-native/Libraries/Core/setUpTimers.js:76`（`defineLazyTimer('requestAnimationFrame')`）→ `packages/react-native/Libraries/Core/Timers/JSTimers.js:267-268`。

**Android legacy native —— 单例 scheduler（全局一个 Choreographer 回调）**

| 位置 | 代码 |
|---|---|
| `.../animated/NativeAnimatedModule.kt:343-358` | 唯一的 `animatedFrameCallback`（`GuardedFrameCallback`），内部调 `nodesManager.runUpdates(frameTimeNanos)`（`:350`） |
| `.../animated/NativeAnimatedModule.kt:370-373` | `reactChoreographer.postFrameCallback(ReactChoreographer.CallbackType.NATIVE_ANIMATED_MODULE, animatedFrameCallback)` |
| `.../animated/NativeAnimatedModule.kt:353` | 帧末 `enqueueFrameCallback()` 自我重排 |
| `.../animated/NativeAnimatedNodesManager.kt:575-582` | `runUpdates` 内遍历 `activeAnimations` 调 `animation.runAnimationStep(frameTimeNanos)` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/core/ReactChoreographer.kt:32` | `NATIVE_ANIMATED_MODULE(2)` —— 独立回调槽位，排在 `DISPATCH_UI(1)` 之后 |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/uimanager/GuardedFrameCallback.kt:40-46` | 帧回调里的 `RuntimeException` 会被吞掉并交给 `JSExceptionHandler` |

**iOS legacy native —— 单例 scheduler（manager 上一个 CADisplayLink）**

| 位置 | 代码 |
|---|---|
| `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:55` | `CADisplayLink *_displayLink;` |
| `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:436-437` | `_displayLink = [CADisplayLink displayLinkWithTarget:self selector:@selector(stepAnimations:)];` + `addToRunLoop:NSRunLoopCommonModes` |
| `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:456-473` | `stepAnimations:` 遍历 `_activeAnimations` 调 `stepAnimationWithTime:` |
| `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:448-454` | `stopAnimationLoop` → `[_displayLink invalidate]` |

**iOS Fabric LayoutAnimation —— 两个独立 tick 源**

| 位置 | 机制 |
|---|---|
| `packages/react-native/React/Fabric/RCTScheduler.mm:205-208` | `MainRunLoopObserver(RunLoopObserver::Activity::BeforeWaiting, _layoutAnimationDelegateProxy)` → `activityDidChange` → `[scheduler animationTick]`（`RCTScheduler.mm:130-135`） |
| `packages/react-native/React/Fabric/RCTScheduler.mm:222-225` | `animationTick` → `_scheduler->animationTick()` → `packages/react-native/ReactCommon/react/renderer/scheduler/Scheduler.cpp:290-295` → `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:749` |

**iOS 共享 C++ backend（第三个 CADisplayLink，`useSharedAnimatedBackend` 门控）**

| 位置 | 代码 |
|---|---|
| `packages/react-native/React/Fabric/RCTScheduler.mm:155-185` | `class RCTAnimationChoreographer : public AnimationChoreographer` |
| `packages/react-native/React/Fabric/RCTScheduler.mm:175-177` | `[CADisplayLink displayLinkWithTarget:_displayLinkTarget selector:@selector(displayLinkTick:)]` |
| `packages/react-native/React/Fabric/RCTScheduler.mm:147-152` | `displayLinkTick:` → `_choreographer->onAnimationFrame(targetTimestamp)` |
| `packages/react-native/React/Fabric/RCTScheduler.mm:211-213` | `if (ReactNativeFeatureFlags::useSharedAnimatedBackend()) { toolbox.animationChoreographer = std::make_shared<RCTAnimationChoreographer>(); }` |
| `packages/react-native/ReactCommon/react/renderer/animationbackend/AnimationChoreographer.h:35-40` | `onAnimationFrame` → `animationBackend_->onAnimationFrame(timestamp)`（weak_ptr） |
| Android 对应实现 | `packages/react-native/ReactAndroid/src/main/jni/react/fabric/AndroidAnimationChoreographer.h:15-36`（只有 `active_` 原子布尔，实际 tick 由 Fabric 主动调 `onAnimationFrameIfActive`） |

### 2.5 单 scheduler 还是每 driver 一个？—— 结论

- **JS 驱动：每 driver 一个 RAF 循环**。证据：每个 `Animation` 子类各自持有 `_animationFrame` 字段（`SpringAnimation.js:107`、`TimingAnimation.js:71`、`DecayAnimation.js:45`），各自 `requestAnimationFrame`（见 §2.4 表），各自在 `stop()` 里 `cancelAnimationFrame`（`SpringAnimation.js:372`、`TimingAnimation.js:183`、`DecayAnimation.js:120`）。仓库内**不存在** Animated 的集中式 RAF 调度器（`grep -rn "requestAnimationFrame" packages/react-native/Libraries/Animated` 只有上述 5 处）。
- **Android legacy native：全局单例**。证据：`.../animated/NativeAnimatedModule.kt:343` 只有一个 `animatedFrameCallback` 对象；`:349-351` 调 `nodesManager.runUpdates(...)`；`.../animated/NativeAnimatedNodesManager.kt:575-582` 遍历所有 `activeAnimations`。所有 driver 无权自行请求帧。
- **iOS legacy native：全局单例**。证据：`.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:435` 的守卫 `if ((_displayLink == nullptr) && _activeAnimations.count > 0)` 保证同时最多一个 `CADisplayLink`。
- **iOS Fabric LayoutAnimation：由 mounting coordinator / run-loop 拉取，不是 per-driver**。`LayoutAnimationDriver::animationMutationsForFrame` 是 `const`（`.../animations/LayoutAnimationDriver.cpp:17-20`），遍历 `inflightAnimations_` 统一产出 mutations。

---

## 3. LIFECYCLE & CANCELLATION

### 3.1 JS 基类节点上的全部 start/stop/reset/loop 入口

`AnimatedNode` 基类本身**没有** start/stop/reset；只有 attach/detach/value API：

| 方法 | 位置 |
|---|---|
| `__attach()`（no-op 基实现） | `packages/react-native/Libraries/Animated/nodes/AnimatedNode.js:52` |
| `__detach()`（基实现，含 drop） | `packages/react-native/Libraries/Animated/nodes/AnimatedNode.js:53-66` |
| `addListener()` | `.../nodes/AnimatedNode.js:118-125` |
| `removeListener()` | `.../nodes/AnimatedNode.js:133-138` |
| `removeAllListeners()` | `.../nodes/AnimatedNode.js:145-150` |
| `hasListeners()` | `.../nodes/AnimatedNode.js:152-154` |
| `__ensureUpdateSubscriptionExists()` | `.../nodes/AnimatedNode.js:161-188` |
| `__makeNative()` | `.../nodes/AnimatedNode.js:97-108` |
| `__getNativeTag()`（懒创建 native 节点） | `.../nodes/AnimatedNode.js:203-228` |

`AnimatedWithChildren` 的图结构入口：

| 方法 | 位置 |
|---|---|
| `__makeNative()` | `.../nodes/AnimatedWithChildren.js:24-39` |
| `__addChild()` | `.../nodes/AnimatedWithChildren.js:41-51` |
| `__removeChild()` | `.../nodes/AnimatedWithChildren.js:53-66` |
| `__callListeners()`（级联到子节点） | `.../nodes/AnimatedWithChildren.js:72-84` |

**引用计数式 attach/detach**（首次 `__addChild` 才 attach，最后一个 child 移除才 detach）：

- `.../nodes/AnimatedWithChildren.js:42-44`：`if (this._children.length === 0) { this.__attach(); }`
- `.../nodes/AnimatedWithChildren.js:63-65`：`if (this._children.length === 0) { this.__detach(); }`

### 3.2 start / stop / reset / loop 全量入口

**JS Animation 层**

| 入口 | 位置 |
|---|---|
| `Animation.start()` | `packages/react-native/Libraries/Animated/animations/Animation.js:66-84` |
| `Animation.stop()` | `.../animations/Animation.js:86-100` |
| `Animation.__startAnimationIfNative()` | `.../animations/Animation.js:126-187` |
| `Animation.__notifyAnimationEnd()` | `.../animations/Animation.js:193-199` |
| `SpringAnimation.start()` / `stop()` | `.../animations/SpringAnimation.js:202-241` / `367-375` |
| `TimingAnimation.start()` / `stop()` | `.../animations/TimingAnimation.js:113-151` / `178-186` |
| `DecayAnimation.start()` / `stop()` | `.../animations/DecayAnimation.js:74-93` / `117-123` |
| `AnimatedValue.animate()` | `.../nodes/AnimatedValue.js:261-283` |
| `AnimatedValue.stopAnimation()` | `.../nodes/AnimatedValue.js:209-220` |
| `AnimatedValue.resetAnimation()` | `.../nodes/AnimatedValue.js:227-236` |
| `AnimatedValue.stopTracking()` / `track()` | `.../nodes/AnimatedValue.js:288-291` / `296-301` |
| Composite：`start/stop/reset/_startNativeLoop`（spring） | `.../AnimatedImplementation.js:211-226` |
| Composite：timing | `.../AnimatedImplementation.js:271-286` |
| Composite：decay | `.../AnimatedImplementation.js:319-334` |
| Composite：sequence | `.../AnimatedImplementation.js:352-397` |
| Composite：parallel | `.../AnimatedImplementation.js:420-468` |
| Composite：loop | `.../AnimatedImplementation.js:513-553` |
| `AnimatedTracking.update()`（每帧重新 `animate`） | `.../nodes/AnimatedTracking.js:85-93` |

**Android Native Animated**

| 入口 | 位置 |
|---|---|
| `startAnimatingNode()` | `.../animated/NativeAnimatedNodesManager.kt:211-251` |
| `stopAnimation(animationId)` | `.../animated/NativeAnimatedNodesManager.kt:297-338` |
| `stopAnimationsForNode()`（private） | `.../animated/NativeAnimatedNodesManager.kt:254-294` |
| `AnimationDriver.runAnimationStep()`（抽象） | `.../animated/AnimationDriver.kt:28` |
| `AnimationDriver.resetConfig()`（抽象，带默认抛异常实现） | `.../animated/AnimationDriver.kt:36-38` |
| `SpringAnimation.runAnimationStep()` | `.../animated/SpringAnimation.kt:82-108` |
| `FrameBasedAnimationDriver.runAnimationStep()` | `.../animated/FrameBasedAnimationDriver.kt:55-98` |
| `DecayAnimation.runAnimationStep()` | `.../animated/DecayAnimation.kt:42-72` |
| `clearFrameCallback()` / `enqueueFrameCallback()` | `.../animated/NativeAnimatedModule.kt:360-366` / `368-376` |

**iOS Native Animated**

| 入口 | 位置 |
|---|---|
| `startAnimatingNode:nodeTag:config:endCallback:` | `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:261-305` |
| `stopAnimation:` | `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:307-316` |
| `stopAnimationsForNode:` | `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:318-330` |
| `startAnimationLoopIfNeeded` / `stopAnimationLoopIfNeeded` / `stopAnimationLoop` | `.../RCTNativeAnimatedNodesManager.mm:433-454` |
| driver `stopAnimation`（三者） | `.../Drivers/RCTFrameAnimation.mm:77-83`、`.../Drivers/RCTSpringAnimation.mm:97-103`、`.../Drivers/RCTDecayAnimation.mm:71-77` |

**C++ LayoutAnimation**

| 入口 | 位置 |
|---|---|
| `uiManagerDidConfigureNextLayoutAnimation()`（配置下一次） | `.../animations/LayoutAnimationKeyFrameManager.cpp:101-140` |
| `pullTransaction()`（驱动/入队） | `.../animations/LayoutAnimationKeyFrameManager.cpp:164-1048` |
| `animationMutationsForFrame()`（逐帧） | `.../animations/LayoutAnimationDriver.cpp:17-113` |
| `stopSurface()` | `.../animations/LayoutAnimationKeyFrameManager.cpp:152-155` |
| `deleteAnimationsForStoppedSurfaces()` | `.../animations/LayoutAnimationKeyFrameManager.cpp:1580-1614` |
| `getAndEraseConflictingAnimations()`（中断） | `.../animations/LayoutAnimationKeyFrameManager.cpp:1483-1578` |

### 3.3 动画如何停止 —— 全部路径枚举

| # | 路径 | 触发点 | 是否真正停 |
|---|---|---|---|
| P1 | `Animation.stop()`（JS 层，基类） | `.../animations/Animation.js:86-100` | 若 `_nativeID != null` 则 `API.stopAnimation(nativeID)`（`:94`），并 `this.__active = false`（`:99`） |
| P2 | `TimingAnimation.stop()` | `.../animations/TimingAnimation.js:178-186` | `clearTimeout(_timeout)` + `global.cancelAnimationFrame(_animationFrame)` + `__notifyAnimationEnd({finished:false})` |
| P3 | `SpringAnimation.stop()` | `.../animations/SpringAnimation.js:367-375` | 同上 |
| P4 | `DecayAnimation.stop()` | `.../animations/DecayAnimation.js:117-123` | 同上 |
| P5 | `AnimatedValue.stopAnimation()` | `.../nodes/AnimatedValue.js:209-220` | `stopTracking()` + `_animation.stop()` + `_animation = null` |
| P6 | `AnimatedValue.resetAnimation()` | `.../nodes/AnimatedValue.js:227-236` | `stopAnimation()` 后把 `_value` 复位为 `_startingValue`（`:229`） |
| P7 | `AnimatedValue.setValue()` | `.../nodes/AnimatedValue.js:142-156` | `this._animation.stop(); this._animation = null;`（`:144-145`） |
| P8 | `AnimatedValue.__detach()`（unmount / 失去最后一个 child） | `.../nodes/AnimatedValue.js:114-122` → `this.stopAnimation()`（`:120`） |
| P9 | **unmount（组件级）** | `packages/react-native/src/private/animated/createAnimatedPropsHook.js:296-311`：`useInsertionEffect` cleanup → `queueMicrotask(() => node.__detach())`（`:302-309`） | 间接走 P8。**注意 `__detach()` 在微任务里执行，不是同步** |
| P10 | **view detach / 换宿主实例** | `.../nodes/AnimatedProps.js:225-238`：`__detach()` 先 `#disconnectAnimatedView(this._target)`（`:227`）→ `API.disconnectAnimatedNodeFromView`（`:345`），再遍历子节点 `__removeChild`（`:231-235`），最后 `super.__detach()`（`:237`） | 只断 view↔node，不主动停驱动；子 `AnimatedValue` 因引用计数归零而 `__detach` → P8 |
| P11 | **prop 变化导致 AnimatedProps 重建** | `packages/react-native/src/private/animated/createAnimatedPropsMemoHook.js:78-84`：`prev != null && areCompositeKeysEqual(...)` 为 false 时 `create()` 出新 `AnimatedProps`；旧 node 的 `__attach` effect cleanup（`createAnimatedPropsHook.js:300`）→ P9 | 同 P9 |
| P12 | **JS bridge teardown** | 无显式路径。`NativeAnimatedHelper` 无 teardown 钩子；`globalEventEmitterGetValueListener` / `globalEventEmitterAnimationFinishedListener`（`.../NativeAnimatedHelper.js:365`、`:379`）在模块级只注册一次，**从不 `remove()`** | 见 §4.6 |
| P13 | **新架构 teardown（Android）** | `.../animated/NativeAnimatedModule.kt:310-312` `onHostPause()` → `clearFrameCallback()`；`:314-317` `onHostDestroy()` → `clearFrameCallback()`；`:834-839` `invalidate()` 只移除 scrollEnded/lifecycle listener | **只停帧回调，不停 driver、不清 `animatedNodes`/`activeAnimations`/`eventDrivers`** |
| P14 | **新架构 teardown（iOS）** | `.../NativeAnimation/RCTNativeAnimatedTurboModule.mm:60-66` `invalidate` → `[_nodesManager stopAnimationLoop]`（`:63`），未 `stopAnimationsForNode`、未清 `_animationNodes`/`_activeAnimations`/`_eventDrivers` | 只停 CADisplayLink |
| P15 | **Fabric surface stop（LayoutAnimation）** | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp:292` → `:721-725` `stopSurfaceForAnimationDelegate` → `.../LayoutAnimationKeyFrameManager.cpp:152-155` `stopSurface()` 插入 `surfaceIdsToStop_`；下一次 `pullTransaction` 在 `:1603-1612` erase | 会 erase，但**不调用 `successCallback` 也不调用 `failureCallback`** |
| P16 | **prop 变化打断 native 驱动（Android）** | `.../animated/NativeAnimatedNodesManager.kt:171` `stopAnimationsForNode(node)`（由 `setAnimatedNodeValue` 触发）；`:129`（由 `updateAnimatedNodeConfig` 触发）；`:538`（由事件驱动 `handleEvent` 触发） | 是 |
| P17 | **同 animationId 重复启动** | `.../animated/NativeAnimatedNodesManager.kt:228-234`：`existingDriver.resetConfig(animationConfig)` 并 return（不新建 driver） | 是「重启」而非「停止」 |

### 3.4 视图/桥已销毁但动画仍在跑的路径（高价值）

**(a) Android：`dropAnimatedNode` 不停驱动，driver 继续持有已 drop 的节点**

- 分配/注册：`.../animated/NativeAnimatedNodesManager.kt:250` `activeAnimations.put(animationId, animation)`，同时 `:249` `animation.animatedValue = node`（Kotlin 强引用）。
- drop 站点：`.../animated/NativeAnimatedNodesManager.kt:136-139`
  ```kotlin
  public fun dropAnimatedNode(tag: Int) {
    animatedNodes.remove(tag)
    updatedNodes.remove(tag)
  }
  ```
  —— **没有** `stopAnimationsForNode(node)`，**没有**从 `activeAnimations` 移除，**没有** `node.setValueListener(null)`。
- 后果链（均有 path:line）：
  1. `.../NativeAnimatedNodesManager.kt:88` `hasActiveAnimations()` 仍为 true（`activeAnimations.size() > 0`）。
  2. `.../NativeAnimatedModule.kt:349-353` 每帧继续 `runUpdates` → `enqueueFrameCallback()` 自我重排 → **即使 JS 侧组件已卸载，Choreographer 仍被永久 re-arm**（若该动画是 `iterations: -1` 的 loop，则永不结束）。
  3. `.../NativeAnimatedNodesManager.kt:578` `animation.animatedValue?.let { runUpdateNodeList.add(it) }` 把已 drop 的节点重新塞回遍历队列 → `:704` `nextNode?.update()` → `:719-722` `ValueAnimatedNode.onValueUpdate()`（`:41` `valueListener?.onValueUpdate(...)`）。该 listener 仍在，因为 drop 未调用 `setValueListener(null)`（对比 `:153-161` 的 `stopListeningToAnimatedNodeValue` 才会置空）。
  4. 子图仍可被遍历：`.../animated/AnimatedNode.kt:24` 的 `children` 是 `MutableList<AnimatedNode>` 强引用，且 `dropAnimatedNode` 不调用 `removeChild`。
- 对照：iOS 侧同样问题，`.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:180-187` 的 `dropAnimatedNode:` 也不 `stopAnimationsForNode:`；driver 的 `_valueNode` 是 `strong`（`.../Nodes/RCTValueAnimatedNode.h:26` 的 `value`；driver 侧 `.../Drivers/RCTSpringAnimation.mm:21` `@property (nonatomic, strong) RCTValueAnimatedNode *valueNode;`），只在该 driver 的 `stopAnimation` 里被置 nil（`:102`）。若 driver 因未 stop 而留在 `_activeAnimations`，节点被 driver 强引用 → 同样不释放。

**(b) iOS：`CADisplayLink` → target 强引用环**

- 分配：`.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:436` `[CADisplayLink displayLinkWithTarget:self selector:@selector(stepAnimations:)]`。`CADisplayLink` 对 target 持强引用（Apple 文档行为；代码侧未做防护），manager 又以 ivar 持 `_displayLink`（`:55`）→ 形成自环。
- 唯一打破点：`.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:448-454` `stopAnimationLoop` → `[_displayLink invalidate]`。
- 唯一调用方：`.../NativeAnimation/RCTNativeAnimatedTurboModule.mm:63`，在 `invalidate` 内。
- **缺失的释放站点**：仓库中**没有** `RCTNativeAnimatedNodesManager` 的 `-dealloc`（`grep -n "dealloc" .../RCTNativeAnimatedNodesManager.mm` 无结果）。若 `invalidate` 未被调用，`_eventDrivers` / `_animationNodes` / `_activeAnimations` / `CADisplayLink` 全部不可释放，且 CADisplayLink 仍在每帧回调。

**(c) C++ LayoutAnimation：`surfaceIdsToStop_` 只在有 inflight 动画时才清空（无界增长）**

- 写入：`.../animations/LayoutAnimationKeyFrameManager.cpp:153-154`
  ```cpp
  std::scoped_lock lock(surfaceIdsToStopMutex_);
  surfaceIdsToStop_.insert(surfaceId);
  ```
- 唯一清空点：`.../animations/LayoutAnimationKeyFrameManager.cpp:1585-1591`
  ```cpp
  bool inflightAnimationsExistInitially = !inflightAnimations_.empty();
  // Execute stopSurface on any ongoing animations
  if (inflightAnimationsExistInitially) {
    std::unordered_set<SurfaceId> surfaceIdsToStop{};
    {
      std::scoped_lock lock(surfaceIdsToStopMutex_);
      surfaceIdsToStop = surfaceIdsToStop_;
      surfaceIdsToStop_.clear();
    }
  ```
  `surfaceIdsToStop_.clear()`（`:1590`）**在 `if` 内部**。若 `stopSurface(S)` 调用时 `inflightAnimations_` 为空，`S` 永久滞留在 `surfaceIdsToStop_` 中，直到将来某次「有动画在飞」的 `pullTransaction` 才被清掉。这既是**无界集合**，也意味着：后续任何在该 surface 上新入队的动画都会在下一次 `pullTransaction` 的开头（`:173` `deleteAnimationsForStoppedSurfaces()`，早于 `:803` `inflightAnimations_.push_back`）被误删——但由于清除先于入队，实际不会误删新动画；滞留项只会持续占用内存。集合声明：`.../animations/LayoutAnimationKeyFrameManager.h:136` `mutable std::unordered_set<SurfaceId> surfaceIdsToStop_{}`。

**(d) C++ LayoutAnimation：`jsi::Function` 可能在非 JS 线程析构**

- 分配：`.../animations/LayoutAnimationKeyFrameManager.cpp:110-117`，把 JS 传入的 `jsi::Function` 包进 `std::make_shared<jsi::Function>`（`.../animations/LayoutAnimationCallbackWrapper.h:20`），存进 `LayoutAnimation::successCallback` / `failureCallback`（`.../animations/primitives.h:93-94`）。该方法注释明确 `This is guaranteed to be called only on the JS thread.`（`.../LayoutAnimationKeyFrameManager.cpp:98-99`）。
- `failureCallback` 唯一的调用点是解析失败分支（`.../LayoutAnimationKeyFrameManager.cpp:138`）。**成功路径只调用 `successCallback`**（`.../animations/LayoutAnimationDriver.cpp:86`）。`call()` 内部会 `callback_.reset()`（`.../LayoutAnimationCallbackWrapper.h:29`）在 JS 线程释放自己那一份。
- 但 `inflightAnimations_` 的 erase 发生在 mounting 线程：`.../animations/LayoutAnimationDriver.cpp:100` `it = inflightAnimations_.erase(it);`（成功路径，`successCallback` 已被 reset 为 nullptr，安全），以及 `.../animations/LayoutAnimationKeyFrameManager.cpp:1608` `it = inflightAnimations_.erase(it);`（stopSurface 路径，**两个 callback 都未调用**）→ `failureCallback` 的 `shared_ptr<jsi::Function>` 引用计数在该处归零，`jsi::Function` 析构发生在 mounting 线程。
- 同理 `getAndEraseConflictingAnimations` 里 `inflightAnimation.keyFrames.erase(it)`（`.../LayoutAnimationKeyFrameManager.cpp:1564`）只删 keyframe，不删 animation，故 `LayoutAnimation` 本体仍在 `inflightAnimations_` 中，最终由 `:100`/`:1608` 释放。
- 是否构成实际崩溃取决于 `jsi::Function`/`jsi::Object` 析构实现 —— **未确认**（`packages/react-native/ReactCommon/jsi/jsi/jsi.h:1592` 起的 `Function` 声明中未就地给出 dtor 实现，仓库内未找到 `Function::~Function`）。
- 附注：`LayoutAnimationCallbackWrapper::call` 会 `callback_.reset()`（`.../LayoutAnimationCallbackWrapper.h:29`），因此**同一 wrapper 被调用两次时第二次是 no-op**。

---

## 4. LEAK HAZARDS

### 4.1 JS 侧：native 节点分配 & 释放

| 分配站点 | 释放站点 | 配对情况 |
|---|---|---|
| `.../nodes/AnimatedNode.js:215-225`：`nativeTag = NativeAnimatedHelper.generateNewNodeTag(); this.__nativeTag = nativeTag; ... NativeAnimatedHelper.API.createAnimatedNode(nativeTag, config);` | `.../nodes/AnimatedNode.js:63`：`NativeAnimatedHelper.API.dropAnimatedNode(nativeTag); this.__nativeTag = undefined;`（在 `__detach()` 内） | ✅ 配对。释放只在 `__detach()` 里。 |
| `.../animations/Animation.js:139-140`：`this._nativeID = NativeAnimatedHelper.generateNewAnimationId(); NativeAnimatedHelper.API.startAnimatingNode(this._nativeID, ...)` | `.../animations/Animation.js:94`：`NativeAnimatedHelper.API.stopAnimation(nativeID)`（在 `stop()` 内） | ✅ 配对，但 `stop()` 内 `this._nativeID` 从不清空（`:87-98`），重复 `stop()` 会重复发 `stopAnimation` |
| `.../nodes/AnimatedTracking.js:111`：`animationId: NativeAnimatedHelper.generateNewAnimationId()`（写进 tracking 节点 native config） | 无显式释放。native 侧 `.../animated/TrackingAnimatedNode.kt:34` 每次 `update()` 都以同一 `animationId` 调 `startAnimatingNode` → 命中 `.../NativeAnimatedNodesManager.kt:228-234` 的 `resetConfig` 分支（复用 driver），因此 driver 直到自然结束才从 `activeAnimations` 移除（`:615`） | ⚠️ 缺失显式释放。见 §4.3 (a) |
| `.../nodes/AnimatedNode.js:166-187`：`startListeningToAnimatedNodeValue(nativeTag)` + `nativeEventEmitter.addListener('onAnimatedValueUpdate', ...)` | `.../nodes/AnimatedNode.js:177-187` 的 `__updateSubscription.remove()` 闭包内 `subscription.remove()` + `stopListeningToAnimatedNodeValue(nativeTag)` | ✅ 配对；`removeListener`/`removeAllListeners`/`__detach` 三处都会触发（`:136`、`:148`、`:62`） |
| `.../AnimatedEvent.js:200-205`（`AnimatedEvent.__attach`）→ `attachNativeEventImpl` 的 `.../AnimatedEvent.js:78-82` `addAnimatedEventToView` | `.../AnimatedEvent.js:209-216`（`__detach`）→ `.../AnimatedEvent.js:87-98` `detach()` → `removeAnimatedEventFromView` | ✅ 配对。调用方在 `.../createAnimatedPropsHook.js:222-224` 的 ref cleanup |
| `.../createAnimatedPropsHook.js:85-90` `nativeEventEmitter.addListener('onUserDrivenAnimationEnded', ...)` | `.../createAnimatedPropsHook.js:93-95`（effect cleanup）`drivenAnimationEndedListener?.remove()` | ⚠️ effect 无依赖数组（`:74` `useEffect(() => {...})`），每次 commit 都 cleanup + 重新注册 —— 功能正确但每帧可能有一次订阅抖动 |
| `.../createAnimatedPropsHook.js:203-206` `setTimeout(..., 48)` | 同一函数 `:200-202` `clearTimeout(timerRef.current)` | ⚠️ 若组件在 48ms 内 unmount，`timerRef` 上的 timer 不会被清（refEffect cleanup `:219-229` 未 `clearTimeout`）→ 卸载后仍会触发一次 `scheduleUpdate()` |

### 4.2 Android：`NativeAnimatedNodesManager` 三张按 tag/animationId 键的表

| 集合 | 声明 | 键 | 写入点 | 移除点 |
|---|---|---|---|---|
| `animatedNodes` | `.../animated/NativeAnimatedNodesManager.kt:51` `SparseArray<AnimatedNode>` | node tag | `:116` `animatedNodes.put(tag, node)` | `:137` `animatedNodes.remove(tag)`（`dropAnimatedNode`） |
| `activeAnimations` | `:52` `SparseArray<AnimationDriver>` | animationId | `:250` `activeAnimations.put(animationId, animation)` | `:286`（`stopAnimationsForNode`）、`:327`（`stopAnimation`）、`:615`（`runUpdates` 中 finished） |
| `updatedNodes` | `:53` `SparseArray<AnimatedNode>` | node tag | `:117`、`:131`、`:173`、`:185`、`:353`、`:368`、`:399` | `:138` `remove`、`:573` `updatedNodes.clear()` |
| `eventDrivers` | `:57` `MutableList<EventAnimationDriver> = ArrayList()` | **无键（线性表）** | `:487` `eventDrivers.add(eventDriver)` | `:503-509` `removeAnimatedEventFromView` 里按三元组查找后 `eventDrivers.remove(driver)` |

**全仓库无 `animatedNodes.clear()` / `activeAnimations.clear()` / `eventDrivers.clear()` / `nodesManagerRef.set(null)`**（实测：`grep -rn "animatedNodes.clear\|nodesManagerRef.set(null)\|activeAnimations.clear\|eventDrivers.clear" packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/` → 无输出）。

因此**清空时机**：

- `animatedNodes` / `activeAnimations` / `eventDrivers` 的清空**完全依赖 JS 逐个调用 `dropAnimatedNode` / `stopAnimation` / `removeAnimatedEventFromView`**。若 JS runtime 被销毁（reload / crash）而 native 模块仍存活，这三张表不会被清（`.../animated/NativeAnimatedModule.kt:834-839` `invalidate()` 不碰它们）。是否会有实际残留取决于模块实例是否随 `ReactContext` 一起销毁 —— **未确认**（`NativeAnimatedNodesManager` 由 `AtomicReference` 持有，`.../animated/NativeAnimatedModule.kt:198`）。

- `eventDrivers` 无键这一点使 `removeAnimatedEventFromView` 的查找是 O(n)（`:503-508` `eventDrivers.find { ... }`），且 `addAnimatedEventToView` 会为 `topScroll` **额外**插入一条 `topScrollEnded` driver（`:489-492`）—— 移除路径 `:511-514` 也递归移除，逻辑闭合。

- `hasActiveAnimations()`（`:88`）= `activeAnimations.size() > 0 || updatedNodes.size() > 0` —— 这是 Android 是否继续 re-arm 帧回调的**唯一**判据。

### 4.3 无界 / 未清理集合（高价值）

**(a) `eventListenerGetValueCallbacks`（JS，单调 tag 键，永不整体清理）**

- 声明：`packages/react-native/src/private/animated/NativeAnimatedHelper.js:62-64`
  ```js
  const eventListenerGetValueCallbacks: {
    [number]: (value: number) => void,
  } = {};
  ```
- 写入：`:273` `eventListenerGetValueCallbacks[tag] = saveValueCallback;`（仅 `isSingleOpBatching` 分支，Android 专属，`:56-59`）
- 唯一删除：`:376` `delete eventListenerGetValueCallbacks[tag];`，且**必须先有回调到达**（`:372-374` `if (!callback) { return; }`）
- tag 单调递增：`:46` `let __nativeAnimatedNodeTagCount = 1;` + `:399-401` `function generateNewNodeTag() { return __nativeAnimatedNodeTagCount++; }`（**从不重置**）
- **缺失的释放站点**：若 native 侧 `getValue` 在执行 `.../animated/NativeAnimatedNodesManager.kt:418-424` 时抛 `JSApplicationIllegalArgumentException`（`"getValue: Animated node with tag [$tag] does not exist or is not a 'value' node"`），`.../NativeAnimatedNodesManager.kt:442` 的 `emitDeviceEvent("onNativeAnimatedModuleGetValue", params)` 永不发生 → JS 侧条目永久驻留，键为只增 tag ⇒ **单调无界增长**。
- 该 `getValue` 的调用点是 `.../nodes/AnimatedValue.js:116`（`__detach()` 内）。注意 `__detach()` 里先 `getValue`（`:116`）后 `super.__detach()`→`dropAnimatedNode`（`:121`），两者进同一批（`.../NativeAnimatedHelper.js:148-158` 的 `queue` 保序，或 `:132` 的 `singleOpQueue` 保序），正常情况下顺序正确。风险在于**跨批**的 node 已被 drop 后再 `getValue`（未确认是否有这种时序）。

**(b) `eventListenerAnimationFinishedCallbacks`（JS，animationId 键）**

- 声明：`:65-67` `const eventListenerAnimationFinishedCallbacks: {[number]: EndCallback} = {};`
- 写入：`:318` `eventListenerAnimationFinishedCallbacks[animationId] = endCallback;`
- 唯一删除：`:392` `delete eventListenerAnimationFinishedCallbacks[animationId];`（在 `onNativeAnimatedModuleAnimationFinished` 监听里）
- Android 侧发射点：`:292`（`stopAnimationsForNode`）、`:332`（`stopAnimation`）、`:619`（`runUpdates` finished）
- **缺口**：`.../animated/NativeAnimatedNodesManager.kt:334-337` 注释明确说明 `stopAnimation` 找不到动画时不报错也不发事件
  ```
  // Do not throw an error in the case animation could not be found. We only keep "active"
  // animations in the registry and there is a chance that Animated.js will enqueue a
  // stopAnimation call after the animation has ended or the call will reach native thread only
  // when the animation is already over.
  ```
  此时 JS 条目已在动画自然结束时删除，故常规路径闭合。**未确认**是否存在 native 侧移除 driver 却不发事件的分支（三个移除点都发事件，看起来闭合）。

**(c) `globalEventEmitterGetValueListener` / `globalEventEmitterAnimationFinishedListener`**

- 声明：`.../NativeAnimatedHelper.js:68-69`
- 注册：`:365-378`、`:379-396`（`ensureGlobalEventEmitterListeners`，只注册一次）
- **移除：不存在**（全仓库无对应 `.remove()`）。生命周期 = JS runtime 生命周期。

**(d) `waitingForQueuedOperations` / `queue` / `singleOpQueue`**

- 声明：`.../NativeAnimatedHelper.js:51` `const waitingForQueuedOperations = new Set<string>();`、`:53` `const queue: Array<() => void> = [];`、`:54` `const singleOpQueue: Array<unknown> = [];`
- 入队：`:307` `waitingForQueuedOperations.add(id); queueOperations = true;`（`setWaitingForIdentifier`）
- 出队：`:346` `waitingForQueuedOperations.delete(id);`（`unsetWaitingForIdentifier`），`:348-351` size 归零时才 `queueOperations = false; API.disableQueue();`
- **`_executeAsAnimatedBatch` 缺 try/finally（高价值）**：`.../nodes/AnimatedValue.js:74-78`
  ```js
  function _executeAsAnimatedBatch(id: string, operation: () => void) {
    NativeAnimatedAPI.setWaitingForIdentifier(id);
    operation();
    NativeAnimatedAPI.unsetWaitingForIdentifier(id);
  }
  ```
  若 `operation()` 抛异常，`unsetWaitingForIdentifier` 不会执行 → `waitingForQueuedOperations` 永久残留该 id，`queueOperations` 永久为 `true`（`.../NativeAnimatedHelper.js:308`）⇒ 之后所有 native animated 操作都被塞进 `queue`（`:148-150`）。调用点：`.../nodes/AnimatedValue.js:152-154`（`setValue`）、`:196-198`（`extractOffset`）。
- 同一缺陷的第二处：`.../nodes/AnimatedColor.js:184` `setWaitingForIdentifier(nativeTag.toString())` … `:219` `unsetWaitingForIdentifier(...)`，中间有 `:214-218` 的 `updateAnimatedNodeConfig` 会抛 —— 同样无 try/finally。
- 对照：`.../animations/Animation.js:90-97` 与 `:133-186` 的 `try/finally` 是正确的（`:95`、`:182-186`）。

**(e) iOS `_eventDrivers`：字符串拼接键（无分隔符），可碰撞**

- 声明：`.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:53` `NSMutableDictionary<NSString *, NSMutableArray<RCTEventAnimation *> *> *_eventDrivers;`
- 键构造：`:356`、`:379`、`:401`、`:478` 均为 `[NSString stringWithFormat:@"%@%@" viewTag eventName]`（`viewTag` 与事件名直接拼接、无分隔符）
- 移除：`:380-392` `removeAnimatedEventFromView:`；**从不整体清空**（`invalidate` 只 `stopAnimationLoop`，`.../RCTNativeAnimatedTurboModule.mm:60-66`）
- 碰撞示例（推断，未实测）：`viewTag=1,event="23Scroll"` 与 `viewTag=12,event="3Scroll"` 生成同一键。RN 的 view tag 单调递增、事件名固定集合，实际碰撞概率低但键构造本身无隔离。

**(f) `animatedNodes` / `_animationNodes`：无「surface/view 销毁」维度的清理**

- Android `.../NativeAnimatedNodesManager.kt:51`；iOS `.../RCTNativeAnimatedNodesManager.mm:50` `NSMutableDictionary<NSNumber *, RCTAnimatedNode *> *_animationNodes;`
- 唯一移除：Android `:137`、iOS `:185`（均只在 `dropAnimatedNode`）
- 无 view detach / surface stop 触发的批量清理。`PropsAnimatedNode.disconnectFromView`（`.../animated/PropsAnimatedNode.kt:56-65`）只置 `connectedViewTag = -1`，不释放节点。

### 4.4 iOS：原生对象分配后交给 JS / 存在注册表里

| 分配 | 持有者 | 释放路径 |
|---|---|---|
| `_animationNodes[tag] = node`（`.../RCTNativeAnimatedNodesManager.mm:113`） | manager（strong dict） | `:185` `removeObjectForKey:` |
| `[_activeAnimations addObject:animationDriver]`（`:302`） | manager（strong set） | `:312`、`:328`、`:468`；或 `invalidate` 时**不释放** |
| driver 持有 `_valueNode`（strong，`.../RCTSpringAnimation.mm:21`） | driver | `.../RCTSpringAnimation.mm:102` `stopAnimation` 内 `_valueNode = nil;` |
| driver 持有 `_callback`（RCTResponseSenderBlock，`.../RCTSpringAnimation.mm:41`） | driver | **从不置 nil**；`stopAnimation`（`:97-103`）调用后不清理。若 driver 被重复 `stopAnimation`，回调会被**二次调用**（`_valueNode` 已 nil → `_valueNode.value` 为 0）。是否可达取决于 `_activeAnimations` 的移除是否与 `stopAnimation` 一一对应（`:312`、`:328`、`:468` 都是「先 stop 后 remove」，看似闭合；**未确认**是否有路径二次 stop） |
| `_displayLink`（`:436`） | manager（strong），且 CADisplayLink 强引用 target=manager | `:451` `[_displayLink invalidate]` |
| `_eventDrivers[key]`（`:362`） | manager（strong dict of strong arrays of `RCTEventAnimation`） | `:382`/`:387` |
| `RCTEventAnimation.valueNode` | **weak**（`.../Drivers/RCTEventAnimation.h:14` `@property (nonatomic, readonly, weak) RCTValueAnimatedNode *valueNode;`） | 随 node 释放自动置 nil |
| `RCTValueAnimatedNode.valueObserver` | **weak**（`.../Nodes/RCTValueAnimatedNode.h:28`） | 随 observer 释放自动置 nil |

### 4.5 C++ LayoutAnimation：原语持有 JS 回调

| 分配 | 持有者 | 释放 |
|---|---|---|
| `std::make_shared<jsi::Function>`（`.../LayoutAnimationCallbackWrapper.h:20`） | `LayoutAnimation::successCallback` / `failureCallback`（`.../primitives.h:93-94`）→ `LayoutAnimation` → `inflightAnimations_`（`.../LayoutAnimationKeyFrameManager.h:97`） | `call()` 内 `callback_.reset()`（`.../LayoutAnimationCallbackWrapper.h:29`）——**只对被调用的那一个生效**；`failureCallback` 正常路径永不调用 |
| `currentAnimation_`（`.../LayoutAnimationKeyFrameManager.h:88`）持有下一次待播动画 | keyframe manager | 仅在下一次 `uiManagerDidConfigureNextLayoutAnimation`（`:1052` 直接赋值覆盖）或 `pullTransaction` 的 `:243-246` move 时释放 |

### 4.6 Android：native 对象 handed to JS

| 对象 | 站点 |
|---|---|
| `Callback`（`com.facebook.react.bridge.Callback`，可持有 JSI function） | 传入点 `.../animated/NativeAnimatedModule.kt:599` 参数 `endCallback: Callback`（JSI 路径）或 `:967` 显式传 `null`（单指令批处理路径）。存储于 `.../animated/AnimationDriver.kt:21` `endCallback: Callback?`。移除：driver 结束时随 driver 释放（`.../NativeAnimatedNodesManager.kt:615` `activeAnimations.removeAt(i)`），字段本身未显式置 null |
| `AnimatedNodeValueListener` lambda（捕获 `tag`） | `.../animated/NativeAnimatedModule.kt:464-473`（非批处理）与 `:931-943`（批处理）创建，存于 `.../animated/ValueAnimatedNode.kt:19` `valueListener`。移除：**只有** `.../animated/NativeAnimatedNodesManager.kt:160` `node.setValueListener(null)`（由 `stopListeningToAnimatedNodeValue` 触发）。`dropAnimatedNode`（`:136-139`）**不调用**，见 §3.4(a) |

### 4.7 无 removal path 的 listener / callback

| 站点 | 说明 |
|---|---|
| `.../NativeAnimatedNodesManager.kt:81` `uiManager.eventDispatcher.addListener(this)` | 全仓库**没有**对应的 `removeListener(this)`（实测 `grep -rn "removeListener" .../react/animated/` 只命中 `:837` 的 `scrollEndedListeners.removeListener(this)`）。`NativeAnimatedNodesManager` 被 EventDispatcher 强引用到 UIManager 销毁为止 |
| `.../NativeAnimatedNodesManager.kt:63` `initializedForFabric` + `:406` `uiManager.addUIManagerEventListener(this)` | 同样无 `removeUIManagerEventListener` |
| `.../src/private/animated/NativeAnimatedHelper.js:365`、`:379` 两个 `RCTDeviceEventEmitter.addListener` | 无 removal（见 §4.3(c)） |

---

## 5. VALUE TYPES & CONVERSION

### 5.1 JS number → 平台值

**JS → iOS（`double` → `CGFloat`，`CGFloat` 在 64 位是 `double`）**

| 站点 | 转换 |
|---|---|
| `.../NativeAnimation/Nodes/RCTValueAnimatedNode.mm:23-24` | `_offset = [self.config[@"offset"] floatValue]; _value = [self.config[@"value"] floatValue];` —— **`floatValue` = 32 位 float** |
| `.../RCTNativeAnimatedNodesManager.mm:201` | `valueNode.value = value.floatValue;`（`setAnimatedNodeValue`，**float 截断**） |
| `.../RCTNativeAnimatedNodesManager.mm:214` | `[valueNode setOffset:offset.floatValue];`（**float 截断**） |
| `.../RCTNativeAnimatedNodesManager.mm:251` | `saveCallback(@[ @(valueNode.value) ]);` |
| `.../Drivers/RCTFrameAnimation.mm:56-61` | `toValue.floatValue`、`iterations.integerValue`（**整数截断**） |
| `.../Drivers/RCTSpringAnimation.mm:70-83` | `[RCTConvert CGFloat:config[@"stiffness"]]` 等；`iterations.integerValue` |
| `.../Drivers/RCTDecayAnimation.mm:55-58` | `[RCTConvert CGFloat:config[@"deceleration"]]`、`iterations.integerValue` |
| `.../NativeAnimation/Nodes/RCTModuloAnimatedNode.mm:18-19` | `const float m = modulus.floatValue; self.value = fmodf(fmodf(parent.value, m) + m, m);` —— **全程 float32 运算** |
| `.../Nodes/RCTDiffClampAnimatedNode.mm:23-24` | `_min = [config[@"min"] floatValue]; _max = [config[@"max"] floatValue];` |

**JS → Android（`double` → `Double`，全程 64 位，无截断；但 tag 全程 `toInt()`）**

| 站点 | 转换 |
|---|---|
| `.../animated/NativeAnimatedModule.kt:423` | `val tag = tagDouble.toInt()`（`createAnimatedNode`） |
| `:441`、`:459`、`:488`、`:506`、`:524`、`:542`、`:560`、`:579`、`:625`、`:666`、`:688`、`:690`、`:715`、`:739`、`:762`、`:792`、`:824` | 所有 `*Double` tag 参数统一 `xxxDouble.toInt()` —— **整数截断（tag 设计如此）** |
| `:601-602` | `val animationId = animationIdDouble.toInt(); val animatedNodeTag = animatedNodeTagDouble.toInt();` |
| `:865`、`:911`、`:916` 等批处理解析 | `opsAndArgs.getInt(i++)` 取 tag；`:975`/`:981` 用 `opsAndArgs.getDouble(i++)` 取值 |
| `.../animated/NativeAnimatedNodesManager.kt:164`、`:177` | `setAnimatedNodeValue(tag: Int, value: Double)`、`setAnimatedNodeOffset(tag: Int, offset: Double)` |
| `.../animated/ValueAnimatedNode.kt:17-18` | `nodeValue: Double = config?.getDouble("value") ?: Double.NaN`；`offset: Double = config?.getDouble("offset") ?: 0.0` |

**JS → C++ LayoutAnimation（`double` → `Float` = `float`）**

| 站点 | 转换 |
|---|---|
| `.../animations/primitives.h:38-42` | `double duration`、`double delay`、`Float springDamping`、`Float initialVelocity` —— **混用 double 与 float** |
| `.../animations/conversions.h:114` | `Float springDamping = 0.5;`（默认） |
| `.../animations/conversions.h:140` | `springDamping = (Float)springDampingIt->second.asDouble();` —— **double→float 降精度** |
| `.../animations/conversions.h:150` | `initialVelocity = (Float)initialVelocityIt->second.asDouble();` —— **double→float 降精度** |
| `.../animations/conversions.h:120`、`:130`、`:177` | `duration`/`delay` 保持 `double`（无降精度） |
| `.../animations/utils.cpp:22-23` | `auto delay = (uint64_t)mutationConfig.delay; uint64_t endTime = startTime + delay + (uint64_t)mutationConfig.duration;` —— **double→uint64 截断；负 delay 会产生未定义/巨大值** |
| `packages/react-native/ReactCommon/react/renderer/graphics/platform/cxx/react/renderer/graphics/Float.h:20` | `using Float = float;`（注释：`Exact type of float numbers which ideally should match a type behing platform- and chip-architecture-specific float type.`） |
| `.../animations/LayoutAnimationKeyFrameManager.cpp:75-78` | `interpolateFloats(Float coefficient, Float oldValue, Float newValue)` —— 全 float32 |
| `.../animations/LayoutAnimationKeyFrameManager.cpp:1080-1083` | `createInterpolatedShadowView(Float progress, ...)` |
| `.../components/view/ViewPropsInterpolation.h:26-40` | `interpolateViewProps(Float animationProgress, ...)` —— `opacity` 与 `transform` 都在 float32 上插值 |

### 5.2 精度损失 / 整数截断 / NaN / Infinity

| 类型 | 站点 | 说明 |
|---|---|---|
| **float32 降精度** | `.../Nodes/RCTValueAnimatedNode.mm:23-24`、`:201`、`:214`；`.../Drivers/RCTModuloAnimatedNode.mm:18-19` | iOS 侧通过 `floatValue` 把 JS double 截成 32 位 |
| **float32 vs double 混算（spring）** | `.../Drivers/RCTSpringAnimation.mm:130-149` 用 `sqrtf/sinf/cosf/expf`（float）；Android `.../animated/SpringAnimation.kt:135-137` 用 `kotlin.math.sqrt/sin/cos/exp`（Double）；JS `.../animations/SpringAnimation.js:291-323` 用 `Math.*`（double） | 三端 spring 数学精度不一致 |
| **double→float 降精度（C++）** | `.../animations/conversions.h:140`、`:150` | `springDamping`、`initialVelocity` |
| **double→uint64 截断** | `.../animations/utils.cpp:22-23` | `delay`/`duration` |
| **整数截断** | `.../animated/NativeAnimatedModule.kt` 全部 `*Double.toInt()` tag 参数；`.../Drivers/RCTFrameAnimation.mm:58/64-66`、`:70/82-83`、`.../RCTSpringAnimation.mm:70/82-83`、`.../RCTDecayAnimation.mm:55/58`（`iterations.integerValue`） | tag / iterations |
| **整数截断（插值）** | `.../animated/InterpolationAnimatedNode.kt:273-274`：`val intVal = v.toInt(); m.appendReplacement(sb, if (intVal.toDouble() != v) v.toString() else intVal.toString())` | 仅用于字符串化 |
| **整数取整（颜色）** | `.../nodes/AnimatedInterpolation.js:294-297`：`Math.round` r/g/b，alpha 用 `Math.round(x*1000)/1000` |
| **颜色分量取整** | `.../NativeAnimation/RCTAnimationUtils.mm:113-114`：`((uint32_t)round(alpha*255)&0xFF)<<24 | ...` | 丢精度 |
| **alpha 除法** | `.../animated/ColorAnimatedNode.kt:90` `aNode?.nodeValue = Color.alpha(color) / 255.0` | double |
| **NaN 传播（Android）** | `.../animated/ValueAnimatedNode.kt:17` `nodeValue: Double = config?.getDouble("value") ?: Double.NaN`；`:22` `if ((offset + nodeValue).isNaN()) { this.update(); }` | 惰性求值机制 |
| **NaN/Infinity 防护** | `.../nodes/AnimatedDivision.js:57-58`：`// Passing infinity/NaN to Fabric will cause a native crash` + `return 0;` | JS 侧主动返回 0 |
| **Infinity 显式支持** | `.../nodes/AnimatedInterpolation.js:159-177`：input/output range 支持 `-Infinity` / `Infinity`（三处分支） | |
| **Infinity 禁止** | `.../nodes/AnimatedInterpolation.js:343-352` `checkInfiniteRange`：`invariant(arr.length !== 2 \|\| arr[0] !== -Infinity \|\| arr[1] !== Infinity, name + ' cannot be ]-infinity;+infinity[ ' + arr)` | 与上面**矛盾**：`:159-177` 显式支持无穷，`:344` 又禁止长度为 2 的 `]-inf, +inf[` —— 注释见 §10.3 |
| **无 NaN 防护** | `.../animated/SpringAnimation.kt:137`、`.../animations/SpringAnimation.js:293`、`.../Drivers/RCTSpringAnimation.mm:132` 计算 `sqrt(1 - zeta*zeta)`；若 `zeta > 1` → sqrt(负数)。虽在 `zeta < 1` 分支才使用，但**计算本身无条件执行** | 见 §8.3 |

### 5.3 Clamp 边界

| 位置 | 界 | 说明 |
|---|---|---|
| `.../animated/DiffClampAnimatedNode.kt:46` | `nodeValue = min(max(nodeValue + diff, minValue), maxValue)` | `[min, max]`，来自 config（无默认值，缺失则抛） |
| `.../nodes/AnimatedDiffClamp.js:59` | `this._value = Math.min(Math.max(this._value + diff, this._min), this._max);` | 同上 |
| `.../Nodes/RCTDiffClampAnimatedNode.mm:45` | `self.value = MIN(MAX(self.value + diff, _min), _max);` | 同上 |
| `.../nodes/AnimatedModulo.js:39-41` | `((a % m) + m) % m` | `[0, m)`，但 **`m === 0` 未校验** |
| `.../animated/ModulusAnimatedNode.kt:25` | `nodeValue = (animatedNodeValue % modulus + modulus) % modulus` | 同上，未校验 `modulus != 0` |
| `.../Nodes/RCTModuloAnimatedNode.mm:19` | `fmodf(fmodf(parent.value, m) + m, m)` | 同上，未校验 |
| `.../nodes/AnimatedDivision.js:51-59` | 除零 → 返回 `0` | 硬编码 |
| `.../animated/DivisionAnimatedNode.kt:40-43` | 除零 → **抛** `JSApplicationCausedNativeException` | 与 JS 侧行为不同（JS 返回 0 不抛） |
| `.../Nodes/RCTDivisionAnimatedNode.mm:23-26` | 除零 → `RCTLogError` 并 `return`（值保持上一帧） | 第三种行为 |
| `.../animations/SpringAnimation.js:337-344` | overshoot clamp：`isOvershooting = position > toValue`（当 `_startPosition < _toValue`）或 `< toValue` | 仅当 `overshootClamping && _stiffness !== 0` |
| `.../animated/SpringAnimation.kt:55-59` | `isOvershooting` 同上 | 仅 `springStiffness > 0` |
| `.../Drivers/RCTSpringAnimation.mm:158-165` | 同上 | 仅 `_overshootClamping && _stiffness != 0` |
| `.../nodes/AnimatedInterpolation.js:127-145` | `extrapolateLeft/Right` ∈ `identity`/`clamp`/`extend`；默认 `extend`（`:57`、`:64`） | |
| `.../animated/InterpolationAnimatedNode.kt:181-202` | 同上；`EXTRAPOLATE_TYPE_*` 常量 `:116-118` | 非 `identity/clamp/extend` → 抛 `JSApplicationIllegalArgumentException`（`:187`、`:198`） |
| `.../NativeAnimation/RCTAnimationUtils.mm:41-63` | 同上；非法类型 → `RCTLogError` 不抛 | 行为又不同 |
| `.../animations/utils.cpp:25-30` | `if (now >= endTime) return {1,1}; if (now < startTime + delay) return {0,0};` | progress clamp 到 `[0,1]` |
| `.../animated/ColorAnimatedNode.kt:41` `normalize(r, g, b, a)` | `com.facebook.react.views.view.ColorUtil.normalize` | 见该函数（未展开，**未确认**具体 clamp 规则） |

---

## 6. INTERRUPTION & RESTART SEMANTICS

### 6.1 新动画作用在正在动画的 prop 上

**JS 驱动（`AnimatedValue.animate`）—— 先 stop 旧动画，再把旧动画作为 `previousAnimation` 传给新动画**

`packages/react-native/Libraries/Animated/nodes/AnimatedValue.js:261-283`：
```js
  animate(animation: Animation, callback: ?EndCallback): void {
    const previousAnimation = this._animation;
    this._animation && this._animation.stop();
    this._animation = animation;
    animation.start(
      this._value,
      ...
      previousAnimation,
      this,
    );
  }
```
- 停止：`.../AnimatedValue.js:263`
- 交接内部状态：`.../AnimatedValue.js:280`
- 只有 **SpringAnimation** 使用 `previousAnimation`：`.../animations/SpringAnimation.js:218-225`
  ```js
    if (previousAnimation instanceof SpringAnimation) {
      const internalState = previousAnimation.getInternalState();
      this._lastPosition = internalState.lastPosition;
      this._lastVelocity = internalState.lastVelocity;
      // Set the initial velocity to the last velocity
      this._initialVelocity = this._lastVelocity;
      this._lastTime = internalState.lastTime;
    }
  ```
- `TimingAnimation.start`（`.../animations/TimingAnimation.js:113-151`）与 `DecayAnimation.start`（`.../animations/DecayAnimation.js:74-93`）签名里收了 `previousAnimation` 但**从未使用**。

**native 驱动**

- Android：JS 侧 `.../animations/Animation.js:86-100` 的 `stop()` 会发 `API.stopAnimation(nativeID)` → `.../animated/NativeAnimatedNodesManager.kt:297-338` → `stopAnimationsForNode(node)`（`:254-294`）把该 node 上所有 driver 移除并回调 `finished:false`。
- iOS：同上路径 → `.../RCTNativeAnimatedNodesManager.mm:307-316` `stopAnimation:`。
- 另有「同 id 重启」：`.../animated/NativeAnimatedNodesManager.kt:228-234`
  ```kotlin
    val existingDriver = activeAnimations[animationId]
    if (existingDriver != null) {
      // animation with the given ID is already running, we need to update its configuration instead
      // of spawning a new one
      existingDriver.resetConfig(animationConfig)
      return
    }
  ```
  iOS 对应：`.../RCTNativeAnimatedNodesManager.mm:267-273` `[driver resetAnimationConfig:config];`

**C++ LayoutAnimation 中断**

- 冲突检测 + 移除：`.../animations/LayoutAnimationKeyFrameManager.cpp:1483-1578`（`getAndEraseConflictingAnimations`）
- 冲突判定：`:1523-1526`
  ```cpp
        bool conflicting = animatedKeyFrame.tag == baselineTag ||
            (mutationIsCreateOrDelete &&
             animatedKeyFrame.parentTag == baselineTag &&
             animatedKeyFrame.parentTag != 0);
  ```
- 失效标记 + 从在飞动画中摘除：`:1532` `animatedKeyFrame.invalidated = true;` / `:1564` `it = inflightAnimation.keyFrames.erase(it);`
- 合成最终 mutation：`:786-790`、`:926-931`

### 6.2 Native 中断 vs JS 中断 —— 行为差异（path:line 证明）

| 维度 | JS 驱动 | Native 驱动（Android） | 差异 |
|---|---|---|---|
| 停止旧动画的**时机** | 同步（`.../AnimatedValue.js:263`） | 异步：先入批（`.../animated/NativeAnimatedModule.kt:630-639`），在 UI 线程执行（`:301`） | native 路径上**同一 JS tick 内的后续读取会看到旧值** |
| 旧动画终值上报 | `.../animations/TimingAnimation.js:185` 等直接 `__notifyAnimationEnd({finished:false})`，同步 | `.../animated/NativeAnimatedNodesManager.kt:267-272` 组装 `{finished:false, value, offset}` 交回 JS | 语义相同，时机不同 |
| `stopAnimation` 找不到目标 | JS 一定会发 `stopAnimation` | `.../animated/NativeAnimatedNodesManager.kt:334-337` **不发事件、不报错** | native 侧存在「停止请求丢失」的窗口 |
| **timing 重启的帧表刷新** | 每次 `start` 重建 `frames` 数组（`.../animations/TimingAnimation.js:95-101`） | `.../animated/FrameBasedAnimationDriver.kt:36-41`：**只有帧数变化时才重建数组内容** | ❗ **不一致**。见下 |
| iOS 同项 | — | `.../Drivers/RCTFrameAnimation.mm:62` `_frames = [frames copy];`（每次都刷新） | iOS 与 Android 不一致 |

`packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/FrameBasedAnimationDriver.kt:34-41`：
```kotlin
  override fun resetConfig(config: ReadableMap) {
    val framesConfig = config.getArray("frames")
    if (framesConfig != null) {
      val numberOfFrames = framesConfig.size()
      if (frames.size != numberOfFrames) {
        frames = DoubleArray(numberOfFrames) { i -> framesConfig.getDouble(i) }
      }
    }
```
帧数由 `.../animations/TimingAnimation.js:95-101` 的 `Math.round(this._duration / frameDuration)` 决定，因此「相同 duration、不同 easing」会命中 `frames.size == numberOfFrames` 而**沿用上一次的缓动采样值**。iOS 侧 `.../Drivers/RCTFrameAnimation.mm:54-67` 无此条件。

### 6.3 描述中断语义的注释（逐字引用）

1. `packages/react-native/Libraries/Animated/nodes/AnimatedValue.js:81-84`
   > Standard value for driving animations.  One `Animated.Value` can drive
   > multiple properties in a synchronized fashion, but can only be driven by one
   > mechanism at a time.  Using a new mechanism (e.g. starting a new animation,
   > or calling `setValue`) will stop any previous ones.

2. `packages/react-native/Libraries/Animated/animations/Animation.js:40-42`
   > Important note: start() and stop() will only be called at most once.
   > Once an animation has been stopped or finished its course, it will
   > not be reused.

3. `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/AnimationDriver.kt:30-35`
   > This method will get called when some of the configuration gets updated while the animation is
   > running. In that case animation should restart keeping its internal state to provide a smooth
   > transition. E.g. in case of a spring animation we want to keep the current value and speed and
   > start animating with the new properties (different destination or spring settings)

4. `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/NativeAnimatedNodesManager.kt:229-232`
   > animation with the given ID is already running, we need to update its configuration instead
   > of spawning a new one

5. `packages/react-native/ReactCommon/react/renderer/animations/primitives.h:77-79`
   > // If an animation interrupts an existing one, the starting state may actually
   > // be halfway through the intended transition.
   > double initialProgress;

6. `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp:222-234`
   > // What to do if we detect a conflict? Get current value and make
   > // that the baseline of the next animation. Scale the remaining time
   > // in the animation
   > // Types of conflicts and how we handle them:
   > // Update -> update: remove the previous update, make it the baseline of the
   > // next update (with current progress) Update -> remove: same, with final
   > // mutation being a remove Insert -> update: treat as update->update Insert
   > // -> remove: same, as update->remove Remove -> update/insert: not possible

7. `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp:752-754`
   > // The animation will continue from the current position - we
   > // restart viewStart to make sure there are no sudden jumps

8. `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.h:119-122`
   > /**
   >  * Queue (and potentially synthesize) final mutations for a finished keyframe.
   >  * Keyframe animation may have timed-out, or be canceled due to a conflict.
   >  */

9. `packages/react-native/Libraries/Animated/AnimatedImplementation.js:147-149`
   > // We use `stopTogether: false` here because otherwise tracking will break
   > // because the second animation will get stopped before it can update.

10. `packages/react-native/Libraries/LayoutAnimation/LayoutAnimation.js:53-56`
    > onAnimationDidEnd is guaranteed to be called when the animation completes.
    > onAnimationDidFail is *never* called in the classic, pre-Fabric renderer,
    > and never has been. In the new renderer (Fabric) it is called only if configuration
    > parsing fails.

11. `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/NativeAnimatedNodesManager.kt:334-337`（见 §4.3(b)，讲的是「停止请求可能晚于动画结束」）

---

## 7. HARD-CODED TIMING CONSTANTS

### 7.1 JS

| 值 | 含义 | 位置 |
|---|---|---|
| `500` | `timing` 默认 duration (ms) | `packages/react-native/Libraries/Animated/animations/TimingAnimation.js:81` `this._duration = config.duration ?? 500;` |
| `1000.0 / 60.0` | 帧时长，**硬编码 60fps** | `.../animations/TimingAnimation.js:95` `const frameDuration = 1000.0 / 60.0;` |
| `0` | `timing`/`spring` 默认 delay | `.../animations/TimingAnimation.js:82`、`.../animations/SpringAnimation.js:119` |
| `1` | 默认 `iterations` | `.../animations/Animation.js:60` `this.__iterations = config.iterations ?? 1;` |
| `0.001` | spring `restDisplacementThreshold` 默认 | `.../animations/SpringAnimation.js:114` |
| `0.001` | spring `restSpeedThreshold` 默认 | `.../animations/SpringAnimation.js:115` |
| `0` | spring 默认 `velocity` | `.../animations/SpringAnimation.js:116-117` |
| `100` / `10` / `1` | stiffness / damping / mass 默认（stiffness/damping/mass 分支） | `.../animations/SpringAnimation.js:134-136` |
| `8` / `12` | bounciness / speed 默认 | `.../animations/SpringAnimation.js:149-150` |
| `40` / `7` | tension / friction 默认 | `.../animations/SpringAnimation.js:159-160` |
| `64` | **`MAX_STEPS`**（ms） | `.../animations/SpringAnimation.js:277-281` |
| `0.998` | `decay` 默认 deceleration | `.../animations/DecayAnimation.js:51` |
| `0.1` | decay 结束阈值 | `.../animations/DecayAnimation.js:105` `if (Math.abs(this._lastValue - value) < 0.1) {` |
| `1000` | ms→s | `.../animations/SpringAnimation.js:283` `const deltaTime = (now - this._lastTime) / 1000;` |
| `256` | `DENSE_SAMPLES` | `.../nodes/AnimatedInterpolation.js:403` |
| `0.25` | `TARGET_ERROR` | `.../nodes/AnimatedInterpolation.js:406` |
| `1e-4` / `1e-2` | `MIN_TOLERANCE` / `MAX_TOLERANCE` | `.../nodes/AnimatedInterpolation.js:408-409` |
| `255` | 非数值输出的 span 基准 | `.../nodes/AnimatedInterpolation.js:439` `epsilon = TARGET_ERROR / 255;` |
| `1000` | alpha 取整精度 | `.../nodes/AnimatedInterpolation.js:297` `const a = Math.round(interpolations[3](input) * 1000) / 1000;` |
| `2` | `inputRange` 最小长度 | `.../nodes/AnimatedInterpolation.js:331`、`:342` |
| `48` | setNativeProps 去抖 (ms) | `packages/react-native/src/private/animated/createAnimatedPropsHook.js:206` |
| `3.62` / `194` / `3` / `25` | Origami 值转换系数 | `.../SpringConfig.js:20`、`:24` |
| `0.0007`/`0.031`/`0.64`/`1.28` 等 | `b3Friction1/2/3` 多项式系数 | `.../SpringConfig.js:57-72` |
| `1.7` / `20` / `0.8` / `0.5` / `200` / `0.01` | `fromBouncinessAndSpeed` 归一化常数 | `.../SpringConfig.js:84-92` |
| `18` / `44` | `b3Nobounce` 分段阈值 | `.../SpringConfig.js:75-81` |
| `4` / `0.001` / `0.0000001` / `10` / `11` | bezier Newton/细分参数 | `.../bezier.js:20-26`（注释：`// These values are established by empiricism with tests (tradeoff: performance VS precision)`） |
| `2.25`/`2.75`/`7.5625`/`0.75`/`0.9375`/`0.984375` | `Easing.bounce` 常数 | `.../Easing.js:197-206` |
| `0.42, 0, 1, 1` | `Easing.ease` 的 bezier 控制点 | `.../Easing.js:98` |

### 7.2 Android

| 值 | 含义 | 位置 |
|---|---|---|
| `1000.0 / 60.0`（`FRAME_TIME_MILLIS`） | **硬编码 60FPS**，注释直接写 `// 60FPS` | `.../animated/FrameBasedAnimationDriver.kt:100-102` |
| `100` | 日志限流 `logCount < 100` | `.../animated/FrameBasedAnimationDriver.kt:73` |
| `0.064` | `MAX_DELTA_TIME_SEC`，注释 `(4 frames at 60 FPS)` | `.../animated/SpringAnimation.kt:184-185` |
| `1000000` / `1000.0` | ns→ms、ms→s | `.../animated/SpringAnimation.kt:84`、`:96`；`.../animated/FrameBasedAnimationDriver.kt:64`；`.../animated/DecayAnimation.kt:44` |
| `16` | **硬编码一帧 16ms**（decay 首帧回退） | `.../animated/DecayAnimation.kt:47` `startFrameTimeMillis = frameTimeMillis - 16` |
| `0.1` | decay 结束阈值 | `.../animated/DecayAnimation.kt:59` `if (abs(lastValue - value) < 0.1) {` |
| `1` | 默认 `iterations` | `.../animated/FrameBasedAnimationDriver.kt:49`、`.../animated/SpringAnimation.kt:75`、`.../animated/DecayAnimation.kt:37` |
| `0.0` | 默认 `toValue` | `.../animated/FrameBasedAnimationDriver.kt:42-45` |
| `2` | batch 追赶阈值 | `.../animated/NativeAnimatedModule.kt:294` `if ((currentFrameNumber - currentBatchNumber) > 2) {` |
| `255.0` | alpha 归一化 | `.../animated/ColorAnimatedNode.kt:90` |
| `-1` | `iterations == -1` 表示无限循环 | `.../animated/FrameBasedAnimationDriver.kt:84`、`.../animated/SpringAnimation.kt:100`、`.../animated/DecayAnimation.kt:60` |
| `Double.NaN` | 默认 `nodeValue` | `.../animated/ValueAnimatedNode.kt:17` |

### 7.3 iOS（附加目录）

| 值 | 含义 | 位置 |
|---|---|---|
| `1.0 / 60.0` | `RCTSingleFrameInterval`，**硬编码 60fps** | `.../NativeAnimation/Drivers/RCTAnimationDriver.h:13` `static CGFloat RCTSingleFrameInterval = (CGFloat)(1.0 / 60.0);` |
| `0.064` | `MAX_DELTA_TIME` | `.../NativeAnimation/Drivers/RCTSpringAnimation.mm:27` `const NSTimeInterval MAX_DELTA_TIME = 0.064;` |
| `1.0` / `10.0` | 模拟器 drag coefficient 特判 | `.../NativeAnimation/RCTAnimationUtils.mm:122-134` |
| `0.1` | decay 结束阈值 | `.../Drivers/RCTDecayAnimation.mm:105` `if (fabs(_lastValue - value) < 0.1) {` |
| `1` / `-1` | 默认 `iterations` / 无限循环 | `.../Drivers/RCTFrameAnimation.mm:58`、`:105`；`.../Drivers/RCTSpringAnimation.mm:70`、`:181`；`.../Drivers/RCTDecayAnimation.mm:55`、`:106` |
| `1000.0` | decay 公式的 ms→s | `.../Drivers/RCTDecayAnimation.mm:101` |
| `255` | 颜色打包 | `.../RCTAnimationUtils.mm:113-114` |

### 7.4 C++ LayoutAnimation

| 值 | 含义 | 位置 |
|---|---|---|
| `2.0` | EaseIn / EaseOut 幂次（注释：`This has been the default for Classic RN forever.`） | `.../animations/utils.cpp:41`、`:46` |
| `2` / `0.5` | EaseInEaseOut：`(x+1)*M_PI)/2 + 0.5` | `.../animations/utils.cpp:52` |
| `-10` / `2` / `4` | Spring 曲线常数 | `.../animations/utils.cpp:62-63` |
| `M_PI` | 三角函数 | `.../animations/utils.cpp:52`、`:63` |
| `0.5` | `parseAnimationConfig` 默认 `springDamping` | `.../animations/conversions.h:114` |
| `0` | 默认 `duration`/`delay`/`springDamping`/`initialVelocity` | `.../animations/primitives.h:38-42`、`:47-51`；`.../conversions.h:67-73` |
| `1` / `2` / `4` / `8` / `16` / `32` | `AnimationType` 位标志（`None/Spring/Linear/EaseInEaseOut/EaseIn/EaseOut/Keyboard`），注释 `// This corresponds exactly with JS.` | `.../animations/primitives.h:22-30` |
| `0` / `1` / `2` / `4` | `AnimationProperty`（`NotApplicable/Opacity/ScaleX/ScaleY/ScaleXY`） | `.../animations/primitives.h:32` |
| `1` / `2` / `4` | `AnimationConfigurationType`（`Create/Update/Delete`） | `.../animations/primitives.h:53` |

### 7.5 帧率 / 时间步假设

- **JS timing**：帧表按 60fps 采样（`.../animations/TimingAnimation.js:95`），但运行时用真实时钟插值（`:167-171` `this._easing((now - this._startTime) / this._duration)`）—— 采样表与实际帧率解耦，实际平滑。
- **Android FrameBasedAnimationDriver**：`.../animated/FrameBasedAnimationDriver.kt:65` `Math.round(timeFromStartMillis / FRAME_TIME_MILLIS)`，即**按 60fps 索引查表**，在 90/120Hz 上会跳表（每 2/3 个真实帧才前进一格）。
- **iOS RCTFrameAnimation**：`:121-136` 用 `RCTInterpolateValue` 在相邻两帧之间做线性重映射，注释 `// Do a linear remap of the two frames to safeguard against variable framerates`（`:121`）—— iOS 做了变帧率补救，Android 没有。
- **JS spring**：显式限制单帧最大推进量，注释见 §10.1（`MAX_STEPS = 64`，实际是 **64ms ≈ 4 帧**，与注释一致）。
- **Android spring**：`:184-185` `// maximum amount of time to simulate per physics iteration in seconds (4 frames at 60 FPS)` + `MAX_DELTA_TIME_SEC = 0.064`。
- **iOS spring**：`:117-118` `// Handle frame drops, and only advance dt by a max of MAX_DELTA_TIME` + `MIN(MAX_DELTA_TIME, currentTime - _animationCurrentTime)`。

---

## 8. ERROR / EDGE CASES

### 8.1 throw / 硬失败

| 位置 | 形式 | 文本 |
|---|---|---|
| `.../nodes/AnimatedValue.js:101` | `throw new Error` | `'AnimatedValue: Attempting to set value to undefined'` |
| `.../nodes/AnimatedValue.js:305` | `throw new Error` | `'AnimatedValue: Attempting to set value to undefined'` |
| `.../nodes/AnimatedNode.js:232-234` | `throw new Error` | `'This JS animated node type cannot be used as native animated node'` |
| `.../nodes/AnimatedNode.js:99-102` | `invariant` | `'This node cannot be made a "native" animated node'` |
| `.../nodes/AnimatedNode.js:210-213` | `invariant` | `'Attempt to get native tag from node not marked as "native"'` |
| `.../nodes/AnimatedProps.js:279`、`:304`、`:340` | `invariant` | `'Expected node to be marked as "native"'` |
| `.../nodes/AnimatedProps.js:285` | `throw new Error` | `'Unable to locate attached view in the native tree'`（仅非 test 环境；test 环境降级为 `viewTag = -1`，`:282-284`） |
| `.../animations/Animation.js:74-80` | `throw new Error` | `'Attempting to run JS driven animation on animated node that has been moved to "native" earlier by starting an animation with `useNativeDriver: true`'` |
| `.../animations/Animation.js:108` | `throw new Error` | `'This animation type cannot be offloaded to native'` |
| `.../animations/Animation.js:180-182` | `catch (e) { throw e; }` | 空转 catch + rethrow（无实际作用） |
| `.../animations/SpringAnimation.js:127-133`、`:140-147` | `invariant` | `'You can define one of bounciness/speed, tension/friction, or stiffness/damping/mass, but not more than one'` |
| `.../animations/SpringAnimation.js:167` | `invariant` | `'Stiffness value must be greater than 0'` |
| `.../animations/SpringAnimation.js:168` | `invariant` | `'Damping value must be greater than 0'` |
| `.../animations/SpringAnimation.js:169` | `invariant` | `'Mass value must be greater than 0'` |
| `.../AnimatedImplementation.js:394-396` | `throw new Error` | `'Loops run using the native driver cannot contain Animated.sequence animations'` |
| `.../AnimatedImplementation.js:465-467` | `throw new Error` | `'Loops run using the native driver cannot contain Animated.parallel animations'` |
| `.../AnimatedImplementation.js:550-552` | `throw new Error` | `'Loops run using the native driver cannot contain Animated.loop animations'` |
| `.../nodes/AnimatedValueXY.js:65-69` | `invariant` | `'AnimatedValueXY must be initialized with an object of numbers or AnimatedValues.'` |
| `.../nodes/AnimatedInterpolation.js:72-75` | `invariant` | `'Cannot interpolate an input which is not a number'` |
| `.../nodes/AnimatedInterpolation.js:499-502` | `invariant` | `'Cannot interpolate an input which is not a number.'` |
| `.../nodes/AnimatedInterpolation.js:237`、`:242`、`:247`、`:253`、`:320`、`:331`、`:335`、`:342`、`:343` | `invariant` | 插值区间校验（见 §5.3） |
| `.../AnimatedEvent.js:67-70` | `invariant` | `'Native driven events only support animated values contained inside `nativeEvent`.'` |
| `.../AnimatedEvent.js:107`、`:117`、`:124`、`:134`、`:138`、`:147` | `invariant` | 事件映射校验 |
| `.../AnimatedEvent.js:195-198`、`:210-213` | `invariant` | `'Only native driven events need to be attached.'` / `'...detached.'` |
| `.../src/private/animated/NativeAnimatedHelper.js:203` | `invariant` | `'Native animated module is not available'`（`disableQueue`） |
| `.../NativeAnimatedHelper.js:224-227`、`:245-248`、`:408` | `invariant` | `'Native animated module is not available'`（`flushQueue` / `assertNativeAnimatedModule`） |

**Android 硬失败（全部 `JSApplicationIllegalArgumentException` / `JSApplicationCausedNativeException`）**

`.../animated/NativeAnimatedNodesManager.kt`：`:93`（`createAnimatedNode` 重复 tag）、`:113`（未知 node type）、`:124`、`:145`、`:156`、`:167`、`:180`、`:192`、`:203`、`:219`、`:223`、`:242`、`:344`、`:349`、`:359`、`:364`、`:375`、`:380`、`:406`、`:410`、`:421`、`:453`、`:469`、`:473`；
`.../animated/FrameBasedAnimationDriver.kt:56`、`:72`（`check(!ReactBuildConfig.DEBUG) { message }`）；
`.../animated/SpringAnimation.kt:83`、`.../animated/DecayAnimation.kt:43`（`requireNotNull(animatedValue)`）；
`.../animated/AnimationDriver.kt:37`（`resetConfig` 默认 `throw JSApplicationCausedNativeException("Animation config for AnimationDriver cannot be reset")`）；
`.../animated/PropsAnimatedNode.kt:48`、`:58`、`:100`（`IllegalArgumentException`）；
`.../animated/StyleAnimatedNode.kt:37`（`requireNotNull(node) { "Mapped style node does not exist" }`）、`:54`（`IllegalArgumentException`）；
`.../animated/TransformAnimatedNode.kt:30`（`checkNotNull`）、`:56`、`:60`（`IllegalArgumentException`）；
`.../animated/ObjectAnimatedNode.kt:33`、`:54`、`:96`；
`.../animated/DivisionAnimatedNode.kt:41`、`:48`；`.../animated/AdditionAnimatedNode.kt:44`；`.../animated/SubtractionAnimatedNode.kt:44`；`.../animated/MultiplicationAnimatedNode.kt:41`；`.../animated/ModulusAnimatedNode.kt:27`；`.../animated/DiffClampAnimatedNode.kt:28`；
`.../animated/EventAnimationDriver.kt:35`（`requireNotNull(params)`）、`:51`、`:63`（`UnexpectedNativeTypeException`）；
`.../animated/InterpolationAnimatedNode.kt:64`、`:65`、`:70`、`:187`、`:198`。

**iOS 硬失败**：`RCTLogError` / `RCTAssertParam` / `RCT_NOT_IMPLEMENTED`：
`.../RCTNativeAnimatedNodesManager.mm:107`、`:119-120`、`:125-126`、`:134-135`、`:140-141`、`:175`、`:195`、`:209`、`:222`、`:234`、`:246`、`:298`、`:342`、`:347`；
`.../Drivers/RCTFrameAnimation.mm:69`、`.../Drivers/RCTSpringAnimation.mm:89`、`.../Drivers/RCTDecayAnimation.mm:63`（`RCT_NOT_IMPLEMENTED(-(instancetype)init)`）；
`.../NativeAnimation/RCTAnimationUtils.mm:49`、`:61`。

**C++ 硬失败**：`react_native_assert` 密集分布在
`.../animations/LayoutAnimationKeyFrameManager.cpp:299`、`:381-382`、`:386`、`:395-396`、`:408-409`、`:413`、`:442`、`:447`、`:449-452`、`:470`、`:492`、`:555-556`、`:576`、`:593`、`:618`、`:673`、`:690-692`、`:1084-1085`、`:1089`、`:1104`、`:1106-1107`、`:1124`、`:1228-1231`、`:1239-1240`、`:1252-1253`、`:1268-1269`、`:1378`。

### 8.2 「假定不会发生」的 null / undefined

| 位置 | 假定 |
|---|---|
| `.../src/private/animated/createAnimatedPropsHook.js:220-221` | `if (!hasOwn(next, key)) { continue; }` —— composite key 结构一致性由 `useAnimatedPropsMemo` 的不变式保证，注释见 `.../createAnimatedPropsMemoHook.js:131-132`、`.../nodes/AnimatedObject.js:131-132`：`// NOTE: We can depend on `this._value` and `staticObject` sharing a structure because of `useAnimatedPropsMemo`.` |
| `.../nodes/AnimatedProps.js:323-329` | `shadowNode` 为 null 时才 fallback 到 `findShadowNodeByTag_DEPRECATED`（`?...` 可选链），两者皆 null 则静默 return（`:330-332`） |
| `.../nodes/AnimatedInterpolation.js:109-110` | `return outputRange[Math.floor(interpolateResult)];` —— 索引可能 `undefined`（`interpolateResult` 可为负/超界） |
| `.../animated/ColorAnimatedNode.kt:33-40` | `getNodeById(...) as ValueAnimatedNode?` 后 `?: 0.0` 兜底（不抛，静默 0） |
| `.../animated/ColorAnimatedNode.kt:83-90` | `rNode?.nodeValue = ...` —— 节点不存在则**静默跳过**颜色通道写入 |
| `.../animated/EventAnimationDriver.kt:38-39` | `var currMap: ReadableMap? = params; var currArray: ReadableArray? = null;`，`:55` `currArray?.getType(index)`、`:57` `currArray.getMap(index)` —— **同一分支内 `currArray` 从 null 变为非 null 后立即解引用**，依赖路径类型正确性；`:71-72` `currArray?.getDouble(lastIndex) ?: 0.0` 兜底 |
| `.../animated/InterpolationAnimatedNode.kt:44-48` | `output?.getType(0)` —— `output` 为 null 时短路到 `:57` 分支 |
| `.../NativeAnimation/RCTAnimationUtils.h:18-40` | `RCTInterpolateColorInRange(..., NSArray<UIColor *> *outputRange)` —— `outputRange[rangeIndex]` 无长度校验（由 JS 侧 `checkInfiniteRange` 保证） |
| `.../Nodes/RCTDiffClampAnimatedNode.mm:50-53` | `if (self.parentNodes == nil) { RCTLogWarn(...); return 0; }` —— 显式兜底 |
| `.../Nodes/RCTDivisionAnimatedNode.mm:20-22` | `parent1`/`parent2` 用 `isKindOfClass:` 守卫后静默跳过 |
| `.../animated/NativeAnimatedNodesManager.kt:387-396` | `uiManager == null` 时只 `logSoftException` 并 `return`（不断言） |
| `.../animated/NativeAnimatedModule.kt:230`、`:471`、`:938` | `reactApplicationContextIfActiveOrWarn?.emitDeviceEvent(...)` —— 全部可选链，context 失效即静默丢弃事件（**对应 §4.3(a) 的 map 泄漏**） |

### 8.3 除零 / 负数开方

| 风险 | 位置 | 现状 |
|---|---|---|
| spring `sqrt(1 - zeta*zeta)` | `.../animations/SpringAnimation.js:293`、`.../animated/SpringAnimation.kt:137`、`.../Drivers/RCTSpringAnimation.mm:132` | 三处**无条件计算**；`zeta >= 1` 时 `Math.sqrt`/`sqrt`/`sqrtf` 返回 `NaN`。结果只在 `zeta < 1` 分支被使用（JS `:299`、Android `:142`、iOS `:137`），因此不污染输出，但会短暂产生 `NaN` 中间值 |
| spring `omega1` 作除数 | `.../animations/SpringAnimation.js:305`、`:313`；`.../animated/SpringAnimation.kt:148`、`:155`；`.../Drivers/RCTSpringAnimation.mm:140`、`:144` | `/(omega1*…)`；仅 `zeta<1` 时可达，此时 `omega1 > 0`（`k>0` 由 invariant 保证：JS `:167`、Android 无显式检查但依赖 config） |
| spring `2*sqrt(k*m)` / `sqrt(k/m)` | JS `:291-292`、Android `:135-136`、iOS `:130-131` | `k>0,m>0` 由 JS invariant 保证；**native 侧无校验**，若 config 直接给 `stiffness<=0` 或 `mass<=0`：`k*m<0` → JS `Math.sqrt`=NaN / Kotlin `sqrt(负)=NaN` / C `sqrtf(负)=NaN`；`k/m` 为负同理 |
| `2*sqrt(k*m)` 在 stiffness=0 | `.../animated/SpringAnimation.kt:52`（`springStiffness == 0.0` 被显式容忍，见 `:52`） | 此时 `omega0 = 0`，`omega1 = 0`，`zeta` = `c/(2*0)` = `+Inf`；走 `zeta >= 1` 分支（`:158`）不除 `omega1`。**但 `Math.exp(-omega0*t)` = 1，位置直接跳到 `endValue`** |
| decay `1 - deceleration` | `.../animations/DecayAnimation.js:100`、`.../animated/DecayAnimation.kt:57`、`.../Drivers/RCTDecayAnimation.mm:100` | `velocity / (1 - deceleration)`。**`deceleration === 1` 时除零** → `Infinity`（JS：`Infinity` 或 `NaN` 若 `velocity===0`；Android 同；iOS 同）。三端**均无校验**。默认 0.998（JS `:51`） |
| modulo `m` | `.../animated/ModulusAnimatedNode.kt:25`、`.../nodes/AnimatedModulo.js:40`、`.../Nodes/RCTModuloAnimatedNode.mm:19` | `modulus === 0` → `NaN`（`fmodf(x,0)` 未定义）。三端**均无校验** |
| divide by zero | `.../animated/DivisionAnimatedNode.kt:40-43`（抛）、`.../nodes/AnimatedDivision.js:51-59`（返回 0）、`.../Nodes/RCTDivisionAnimatedNode.mm:23-26`（记日志后 return） | 三种不同处理，见 §5.3 |
| 插值 `inputMax - inputMin` | `.../nodes/AnimatedInterpolation.js:164`、`:210`；`.../animated/InterpolationAnimatedNode.kt:210`、`:246` | 两端都有 `inputMin === inputMax` 的短路（JS `:151-156`、Android `:206-209`、`:241-245`），**不构成除零** |
| 颜色插值 `inputMax - inputMin` | `.../animated/InterpolationAnimatedNode.kt:246`、`:247` | 同上，`:241` 有短路 |
| C++ LayoutAnimation spring | `.../animations/utils.cpp:63` `(linearTimeProgression - damping / 4) * M_PI * 2 / damping` | **`damping == 0` 时除零** → `sin(±Inf)` = `NaN` → `1 + pow(2, -10t)*NaN` = `NaN`。默认 `0.5`（`.../conversions.h:114`），但 config 可显式给 0（`.../conversions.h:137-145`），**无下限校验** |
| C++ LayoutAnimation duration=0 | `.../animations/utils.cpp:32-33` `linearTimeProgression = 1 - (double)(endTime - delay - now) / (double)(endTime - animation.startTime);` | **`duration == 0` 且 `delay == 0` 时分母为 0 → 除零**。但 `:25-27` 有 `if (now >= endTime) return {1,1};` 提前返回，通常到不了 —— 仅当 `now == startTime` 时刻命中（`:28` `now < startTime + delay` 在 delay=0 时不成立），**边界帧存在除零窗口** |

---

## 9. DEAD CODE

### 9.1 导出但零外部调用者的动画 API

搜索命令（全仓库，排除 `__tests__`/`tests`/`*-itest.js`）：

```sh
grep -rn "<sym>" packages private scripts --include="*.js" --include="*.flow" --include="*.kt" \
  --include="*.java" --include="*.cpp" --include="*.h" --include="*.m" --include="*.mm" \
  | grep -v "__tests__\|/tests/\|*-itest.js"
```

| API | 定义位置 | 仓库内命中数 | 判定 |
|---|---|---|---|
| `setAnimationTimeProvider` | `packages/react-native/Libraries/Animated/AnimationTimingUtils.js:35` | 2（都在同文件：`:24` 注释、`:35` 定义本身） | **零外部调用者（死代码）** |
| `hasListeners()` | `packages/react-native/Libraries/Animated/nodes/AnimatedNode.js:152` | 1（仅定义） | **零外部调用者（死代码）** |
| `isSupportedColorStyleProp` | `packages/react-native/Libraries/Animated/NativeAnimatedAllowlist.js:155` | 1（仅定义） | **零外部调用者（死代码）** |
| `unstable_createAnimatedComponentWithAllowlist` | `packages/react-native/Libraries/Animated/createAnimatedComponent.js:107` | 2（同文件：`:104` 被 `createAnimatedComponent` 调用、`:107` 定义） | 仅被同文件内部调用；**未从任何 barrel 导出**（`AnimatedExports.js` 只导出 `createAnimatedComponent`，见 `.../AnimatedExports.js:69` 的 `...Animated`） |
| `getCurrentAnimationTime` | `packages/react-native/Libraries/Animated/AnimationTimingUtils.js:27` | 4（3 处动画类 + 定义） | ✅ 活跃 |
| `flushValue` | `packages/react-native/Libraries/Animated/nodes/AnimatedValue.js:55` | 4（`AnimatedColor.js:22`/`:221`、`AnimatedValue.js:310`） | ✅ 活跃 |
| `AnimatedMock` | `packages/react-native/Libraries/Animated/AnimatedMock.js` | 3（`.../AnimatedExports.js:22`、`:25`；`.../AnimatedImplementation.js:628` 注释） | ✅ 活跃（`Platform.isDisableAnimations` 分支） |
| `shouldUseTurboAnimatedModule` | `packages/react-native/Libraries/Animated/shouldUseTurboAnimatedModule.js:14` | 6（2 处 `src/private/specs_DEPRECATED/modules/*` 消费） | ✅ 活跃（仅桥模式） |
| `attachNativeEvent` / `forkEvent` / `unforkEvent` | `.../AnimatedImplementation.js:762-764` | 8 / 7 / 7 | ✅ 活跃 |
| `useAnimatedProps` | `packages/react-native/Libraries/Animated/useAnimatedProps.js:18` | 7（含测试外引用） | ⚠️ 该文件整体标注 `@deprecated`（`:15-17`），见 §9.2 |
| `createCompositeKeyForProps` / `areCompositeKeysEqual` | `packages/react-native/src/private/animated/createAnimatedPropsMemoHook.js:109` / `:235` | 各 2 | 仅同文件内部使用；`createAnimatedPropsMemoHook` 本身只被 `createAnimatedPropsHook.js:21`/`:52` 消费 —— 拆分出私有目录但仍是非公开 API |

### 9.2 仍存在的 deprecated API

| API / 文件 | 位置 | 证据 |
|---|---|---|
| `useAnimatedProps` | `packages/react-native/Libraries/Animated/useAnimatedProps.js:15-18` | `/**\n * @deprecated\n */` + `export default createAnimatedPropsHook(null) as AnimatedPropsHook;` |
| `Animated.AnimatedInterpolation`（类型） | `packages/react-native/Libraries/Animated/AnimatedExports.js.flow:31-32` | `/** @deprecated Use Animated.Interpolation instead */` |
| `Animated.AnimatedColor`（类型） | `packages/react-native/Libraries/Animated/AnimatedExports.js.flow:33-34` | `/** @deprecated Use Animated.Color instead */` |
| `Libraries/Animated/NativeAnimatedModule.js` / `NativeAnimatedTurboModule.js` | `.../NativeAnimatedModule.js:11-13`、`.../NativeAnimatedTurboModule.js:11-12` | 两者都只是 re-export `src/private/specs_DEPRECATED/modules/*`（目录名即 `specs_DEPRECATED`） |
| `RCTFrameAnimation.resetAnimationConfig` 等 iOS driver 的 `init` | `.../Drivers/RCTFrameAnimation.mm:69` 等 | `RCT_NOT_IMPLEMENTED(-(instancetype)init)` |
| `EventAnimationDriver.receiveEvent` | `.../animated/EventAnimationDriver.kt:25-26` | `@Deprecated("Use the overload with eventTimestamp parameter instead.")` |
| `RCTNativeAnimatedNodesManager.updateAnimatedNodeConfig` | `.../RCTNativeAnimatedNodesManager.mm:254-257` | 空实现 + `// TODO (T111179606): Support platform colors for color animations` |
| `NativeAnimatedModule.addListener` / `removeListeners` | `.../animated/NativeAnimatedModule.kt:815-821` | 空实现 + 注释 `// iOS only` |
| `NativeAnimatedModule.willMountItems` / `didMountItems` | `.../animated/NativeAnimatedModule.kt:269-275` | 空实现 + `// noop` |
| `NativeAnimatedModule.willDispatchViewUpdates` | `.../animated/NativeAnimatedModule.kt:306-308` | `// No-op: Fabric is the only supported UIManager` |
| `PropsAnimatedNode.restoreDefaultValues` | `.../animated/PropsAnimatedNode.kt:67-70` | 空实现，注释：`// In Fabric, we don't restore default values since the FabricUIManager doesn't have access to the ShadowNode layer. This method was only relevant for the legacy Paper renderer.` |
| `NativeAnimatedModuleSpec` 的 `queueAndExecuteBatchedOperations`（iOS） | `.../NativeAnimation/RCTNativeAnimatedTurboModule.mm:244-247` | 空实现 + `// TODO: implement in the future ...` |
| `LayoutAnimationCallbackWrapper::call` 的二次调用 | `.../animations/LayoutAnimationCallbackWrapper.h:25-31` | `if (callback_) { callback_->call(runtime); callback_.reset(); }` —— 幂等但无调用方校验 |
| Android `queueAndExecuteBatchedOperations` 中两个 iOS-only opcode | `.../animated/NativeAnimatedModule.kt:1025-1026` | `OP_CODE_ADD_LISTENER, OP_CODE_REMOVE_LISTENERS -> i++`（只跳指针，不执行） |

---

## 10. COMMENTS OF NOTE

### 10.1 TODO / FIXME / HACK / XXX / WORKAROUND 全量清单（排除测试）

| 文件:行 | 原文（逐字） |
|---|---|
| `packages/react-native/Libraries/Animated/animations/Animation.js:73` | `// TODO: T274006331 - Remove js-only animation once shared backend is fully rolled out` |
| `packages/react-native/Libraries/Animated/animations/TimingAnimation.js:133` | `// TODO: T274006331 - Remove js-only animation once shared backend is fully rolled out` |
| `packages/react-native/Libraries/Animated/animations/SpringAnimation.js:229` | `// TODO: T274006331 - Remove js-only animation once shared backend is fully rolled out` |
| `packages/react-native/Libraries/Animated/animations/DecayAnimation.js:89` | `// TODO: T274006331 - Remove js-only animation once shared backend is fully rolled out` |
| `packages/react-native/src/private/animated/createAnimatedPropsHook.js:151` | `// TODO: T274006331 - Remove js-only animation once shared backend is fully rolled out` |
| `packages/react-native/src/private/animated/NativeAnimatedHelper.js:42` | `// TODO T69437152 @petetheheat - Delete this fork when Fabric ships to 100%.` |
| `packages/react-native/src/private/animated/NativeAnimatedHelper.js:82` | `// TODO: T275950736 - remove this path` |
| `packages/react-native/src/private/animated/NativeAnimatedHelper.js:383` | `// TODO: remove Array.isArray once native changes have propagated` |
| `packages/react-native/src/private/animated/NativeAnimatedHelper.js:490` | `// T88715063: NativeEventEmitter only used this parameter on iOS. Now it uses it on all platforms, so this code was modified automatically to preserve its behavior` |
| `packages/react-native/src/private/animated/createAnimatedPropsHook.js:100-112` | `// TODO: This "effect" does three things:` … `//   1) Call `setNativeView`.` … `// Ideally, each of these would be separate "effects" …` |
| `packages/react-native/src/private/animated/createAnimatedPropsHook.js:305` | `// TODO: Stop restoring default values (unless `reset` is called).` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/AnimatedNode.kt:20-21` | `// TODO: T196787278 Reduce the visibility of these fields to package once we have` / `// converted the whole module to Kotlin` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/NativeAnimatedModule.kt:165` | `// TODO(T112522554): Clean up the queue access` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/NativeAnimatedModule.kt:200` | `private var batchingControlledByJS = false // TODO T71377544: delete` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/NativeAnimatedModule.kt:202` | `@Volatile private var currentFrameNumber: Long = 0 // TODO T71377544: delete` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/NativeAnimatedModule.kt:282` | `// TODO T71377544: delete this when the JS method is confirmed safe` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/NativeAnimatedNodesManager.kt:763-764` | `// TODO T71377544: investigate these SoftExceptions and see if we can remove entirely` / `// or fix the root cause` |
| `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.h:56` | `// TODO: add SurfaceId to this API as well` |
| `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp:258-259` | `// TODO: to prevent this step we could tag Remove/Insert mutations as` / `// being moves on the Differ level, since we know that there?` |
| `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp:1166-1167` | `// TODO: modularize this segment, it is repeated 2x in KeyFrameManager` / `// as well.` |
| `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp:1271` | `// TODO: turn all of this into a lambda and share code?` |
| `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp:1538` | `// TODO: don't animate virtual views in the first place?` |
| `packages/react-native/Libraries/NativeAnimation/RCTNativeAnimatedNodesManager.mm:256` | `// TODO (T111179606): Support platform colors for color animations` |
| `packages/react-native/Libraries/NativeAnimation/Nodes/RCTPropsAnimatedNode.mm:20` | `NSMutableDictionary<NSString *, NSObject *> *_propsDictionary; // TODO: use RawProps or folly::dynamic directly` |
| `packages/react-native/Libraries/NativeAnimation/Nodes/RCTColorAnimatedNode.mm:26` | `// TODO (T111179606): Support platform colors for color animations` |
| `packages/react-native/Libraries/NativeAnimation/RCTNativeAnimatedTurboModule.mm:246` | `// TODO: implement in the future if we want the same optimization here as on Android` |

**WORKAROUND / race-condition 字样**

| 文件:行 | 原文 |
|---|---|
| `.../animated/NativeAnimatedNodesManager.kt:717` | `FLog.e(TAG, "Native animation workaround, frame lost as result of race condition", e)` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedDivision.js:57` | `// Passing infinity/NaN to Fabric will cause a native crash` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedStyle.js:64-66` | `// WARNING: This is a potentially expensive check that we should only` / `// do in development. Without this check in development, it might be` / `// difficult to identify which styles need to be allowlisted.` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedProps.js:80-82` | `// WARNING: This is a potentially expensive check that we should only` / `// do in development. Without this check in development, it might be` / `// difficult to identify which props need to be allowlisted.` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedDivision.js:52` | `// Prevent spamming the console/LogBox` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedValue.js:57-58` | `// Passing infinity/NaN to Fabric will cause a native crash`（实为 `AnimatedDivision.js`） |

### 10.2 声明数值阈值 / 平台条件 / 不变式的注释（逐字）

| 文件:行 | 原文 |
|---|---|
| `packages/react-native/Libraries/Animated/animations/SpringAnimation.js:273-276` | `// If for some reason we lost a lot of frames (e.g. process large payload or` / `// stopped in the debugger), we only advance by 4 frames worth of` / `// computation and will continue on the next frame. It's better to have it` / `// running at faster speed than jumping to the end.` |
| `.../animations/SpringAnimation.js:290-292` | `// calculate the oscillation from x0 = 1 to x = 0` 前的公式注释（`:252-271` 大段：`x'' + (2ζ⍵_0)x' + ⍵^2x = 0` … `This algorithm happens to match the algorithm used by CASpringAnimation, a QuartzCore (iOS) API that creates spring animations.`） |
| `.../animated/SpringAnimation.js:307-308` | `// This looks crazy -- it's actually just the derivative of the` / `// oscillation function` |
| `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/SpringAnimation.kt:184-185` | `// maximum amount of time to simulate per physics iteration in seconds (4 frames at 60 FPS)` / `private const val MAX_DELTA_TIME_SEC = 0.064` |
| `.../animated/FrameBasedAnimationDriver.kt:100-102` | `companion object {` / `// 60FPS` / `private const val FRAME_TIME_MILLIS = 1000.0 / 60.0` |
| `.../animated/FrameBasedAnimationDriver.kt:66-77` | `"Calculated frame index should never be lower than 0. Called with frameTimeNanos "` + … + `check(!ReactBuildConfig.DEBUG) { message }` |
| `.../animated/DecayAnimation.kt:46-47` | `// since this is the first animation step, consider the start to be on the previous frame` / `startFrameTimeMillis = frameTimeMillis - 16` |
| `.../animated/NativeAnimatedNodesManager.kt:45-46` | `// IMPORTANT: This class should be accessed only from the UI Thread` |
| `.../animated/NativeAnimatedNodesManager.kt:550-561` | `Animation loop performs two BFSes over the graph of animated nodes. We use incremented` / `mAnimatedGraphBFSColor to mark nodes as visited in each of the BFSes which saves additional` / `loops for clearing "visited" states.` |
| `.../animated/NativeAnimatedNodesManager.kt:648-653` | `animatedGraphBFSColor++; /* use new color */` / `if (animatedGraphBFSColor == AnimatedNode.INITIAL_BFS_COLOR) {` / `// value "0" is used as an initial color for a new node, using it in BFS may cause some nodes` / `// to be skipped.` |
| `.../animated/NativeAnimatedNodesManager.kt:709-718` | `// An exception is thrown if the view hasn't been created yet. This can happen because` / `// views are created in batches. If this particular view didn't make it into a batch yet,` / `// the view won't exist and an exception will be thrown when attempting to start an` / `// animation on it.` / `//` / `// Eat the exception rather than crashing. The impact is that we may drop one or more` / `// frames of the animation.` |
| `.../animated/NativeAnimatedNodesManager.kt:739-741` | `// In Fabric there can be race conditions between the JS thread setting up or tearing down` / `// animated nodes, and Fabric executing them on the UI thread, leading to temporary inconsistent` / `// states.` |
| `.../animated/NativeAnimatedNodesManager.kt:754-757` | `// In Fabric, it seems that animations enter an inconsistent state fairly often.` / `// We detect if the inconsistency is due to a cycle (a fatal error for which we must crash)` / `// or disconnected regions, indicating a partially-set-up animation graph, which is not` / `// fatal and can stay a warning.` |
| `.../animated/NativeAnimatedModule.kt:283-298` | `// The problem we're trying to solve here: we could be in the middle of queueing` / `// a batch of related animation operations when Fabric flushes a batch of MountItems.` / `// It's visually bad if we execute half of the animation ops and then wait another frame` / `// (or more) to execute the rest.` … `// This number is arbitrary, but we want it low` / `// enough that the user shouldn't be able to see this delay in most cases.` |
| `.../animated/NativeAnimatedModule.kt:315-316` | `// Is it possible for onHostDestroy to be called without a corresponding onHostPause?` |
| `.../animated/PropsAnimatedNode.kt:31-32` | `// resolveView throws an [IllegalViewOperationException] when the view doesn't exist` / `// (this can happen if the surface is being deallocated).` |
| `.../animated/PropsAnimatedNode.kt:78-80` | `// The mapped node can be dropped mid-teardown (e.g. component unmounts during` / `// navigation) while this prop update is still in flight. Skip it instead of` / `// throwing, mirroring the connectedViewTag == -1 guard.` |
| `.../animated/InterpolationAnimatedNode.kt:21` | `Currently only a linear interpolation is supported on an input range of an arbitrary size.` |
| `.../animated/InterpolationAnimatedNode.kt:75-76` | `// If the graph is in the middle of being created, just skip this unattached node.` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedNode.js:59-61` | `// The subscription must not outlive the native tag it observes. Any` / `// listeners kept around are re-subscribed by `__makeNative` if this node` / `// is attached again.` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedNode.js:84-93` | `Whether the native node backing this one holds a number, and therefore supports `startListeningToAnimatedNodeValue`. That native module method only accepts tags of "value" nodes (`ValueAnimatedNode` on Android and in C++, `RCTValueAnimatedNode` on iOS); passing any other tag throws on Android and is a no-op elsewhere.` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedNode.js:96-98` | `// Subclasses are expected to set `__isNative` to true before this.` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedNode.js:208-209` | `// `__isNative` is initialized as false and only ever set to true. So we` / `// only need to check it once here when initializing `__nativeTag`.` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedWithChildren.js:47` | `// Only accept "native" animated nodes as children` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedWithChildren.js:82-84` | `// If the graph is in the middle of being created...`（见 `AnimatedTracking.js:69-73`） |
| `packages/react-native/Libraries/Animated/nodes/AnimatedTracking.js:69-73` | `// when the tracking starts we need to convert this node to a "native node"` / `// so that the parent node will be made "native" too. This is necessary as` / `// if we don't do this `update` method will get called. At that point it` / `// may be too late as it would mean the JS driver has already started` / `// updating node values` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedTransform.js:48-49` | `// NOTE: For potentially historical reasons, some operations only operate on` / `// the first level of AnimatedNode instances. This optimizes that bevavior.`（注意拼写 `bevavior`） |
| `packages/react-native/Libraries/Animated/nodes/AnimatedTransform.js:60-62` | `// NOTE: This check should not be necessary, but the types are not` / `// enforced as of this writing. This check should be hoisted to` / `// instantiation sites.` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedColor.js:292-293` | `// rgba requires that the r,g,b are integers.... so we want to round them, but we *dont* want to` / `// round the opacity (4th column).` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedInterpolation.js:396-398` | `The tolerance targets a` / `sub-pixel error using the interpolation's numeric output span when known.` |
| `packages/react-native/Libraries/Animated/nodes/AnimatedInterpolation.js:547-551` | `// An interpolation `easing` is a JS-only function. Rather than drop it (the` / `// native driver would run the segment linearly), sample + simplify it into a` / `// set of `[position, value]` stops the native node applies per segment. Works` / `// for every output type since easing acts on the normalized ratio, not the` / `// output values.` |
| `packages/react-native/src/private/animated/createAnimatedPropsHook.js:74-78` | `// Animated queue flush is handled deterministically in setImmediate for the following feature flags:` / `// cxxNativeAnimatedEnabled` / `if (!NativeAnimatedHelper.shouldSignalBatch) {` / `// If multiple components call `flushQueue`, the first one will flush the` / `// queue and subsequent ones will do nothing.` |
| `.../createAnimatedPropsHook.js:196-199` | `// The goal is to call `scheduleUpdate` as little as possible to maintain` / `// performance but frequently enough to keep state in sync.` / `// Debounce is set to 48ms, which is 3 * the duration of a frame.` / `// 3 frames was the highest value where flickering state was not observed.` |
| `.../createAnimatedPropsHook.js:279-292` | `Manages the lifecycle of the supplied `AnimatedProps` by invoking `__attach`` / `and `__detach`. However, `__detach` occurs in a microtask for these reasons:` … `1. Optimizes detaching and attaching `AnimatedNode` instances that rely on` / `reference counting to cleanup state, by causing detach to be scheduled` / `after any subsequent attach.` |
| `.../createAnimatedPropsHook.js:303` | `// NOTE: Do not restore default values on unmount, see D18197735.` |
| `.../createAnimatedPropsHook.js:326-333` | `This crazy hack is essentially special casing those lists and` / `ScrollView itself to use forceUpdate in Fabric.` |
| `.../createAnimatedPropsMemoHook.js:100-102` | `but all other objects and arrays are included (not searched). We do not` / `search objects and arrays without an allowlist in case they are very large` / `data structures. We safely traverse `style` becuase it is bounded.`（拼写 `becuase`） |
| `packages/react-native/src/private/animated/NativeAnimatedHelper.js:74-78` | `// Schedules `API.flushQueue` after the current batch, replacing any pending` / `// flush. On device `setImmediate` is a microtask; under jest's fake timers it's` / `// a fake-timer entry that only `runAllTimers` drains — not `await` or` / `// `advanceTimersByTime` — so the deferred flush wouldn't run before a test's` / `// assertions. Flush synchronously in tests instead.` |
| `.../NativeAnimatedHelper.js:129-131` | `// `singleOpQueue` is a flat array of operation IDs and arguments, which` / `// is possible because # arguments is fixed for each operation. For more` / `// details, see `NativeAnimatedModule.queueAndExecuteBatchedOperations`.` |
| `.../NativeAnimatedHelper.js:236-240` | `// Single op batching doesn't use callback functions, instead we` / `// use RCTDeviceEventEmitter. This reduces overhead of sending lots of` / `// JSI functions across to native code; but also, TM infrastructure currently` / `// does not support packing a function into native arrays.` |
| `.../NativeAnimatedHelper.js:413-417` | `// Whether the native driver should be forced on for every animation, overriding` / `// the config (including an explicit `useNativeDriver: false`). This is only safe` / `// when the shared animated backend is enabled — that backend is what makes every` / `// prop drivable natively. Forcing native without it would break animations of` / `// props the legacy native driver doesn't support.` |
| `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.h:91-96` | `All mutations of inflightAnimations_ are thread-safe as long as` / `we keep the contract of: only mutate it within the context of` / ``pullTransaction`. If that contract is held, this is implicitly protected` / `by the MountingCoordinator's mutex.` |
| `.../LayoutAnimationKeyFrameManager.h:77-81` | `// LayoutAnimationStatusDelegate - this is for the platform to get` / `// signal when animations start and complete. Setting and resetting this` / `// delegate is protected by a mutex; ALL method calls into this delegate are` / `// also protected by the mutex! The only way to set this without a mutex is` / `// via a constructor.` |
| `.../animations/LayoutAnimationKeyFrameManager.cpp:97-100` | `/**` / `* Globally configure next LayoutAnimation.` / `* This is guaranteed to be called only on the JS thread.` / `*/` |
| `.../animations/LayoutAnimationKeyFrameManager.cpp:38-39` | `// The contract with the "keyframes generation" phase is that any animated` / `// node will have a valid configuration.` |
| `.../animations/LayoutAnimationKeyFrameManager.cpp:388-390` | `// Those asserts don't run in prod. If there's some edge-case` / `// that we haven't caught yet, we'd crash in debug; make sure we` / `// don't mutate the prevView in prod.` |
| `.../animations/LayoutAnimationKeyFrameManager.cpp:676-679` | `// We're guaranteed that a tag only has one animation associated` / `// with it, so we can break here. If we support multiple` / `// animations and animation curves over the same tag in the` / `// future, this will need to be modified to support that.` |
| `.../animations/LayoutAnimationKeyFrameManager.cpp:705-712` | `// At this point, we have the following information and knowledge graph:` / `// [ImmediateMutations] -> assumes [FinalConflicting], [FrameDelayed],` / `// [Delayed] already executed [FrameDelayed] -> assumes` / … |
| `.../animations/LayoutAnimationKeyFrameManager.cpp:978-983` | `// We never commit a different root or modify anything -` / `// we just send additional mutations to the mounting layer until the` / `// animations are finished and the mounting layer (view) represents exactly` / `// what is in the most recent shadow tree` |
| `.../animations/LayoutAnimationDriver.cpp:77-78` | `// Record boundary: animation-frame Updates above this point carry` / `// parentTag from before any structural changes and must execute first.` |
| `.../animations/utils.h:101-102` | `// Deterministic fallback: when no type-specific rule applies, order by` / `// mutation properties to satisfy strict weak ordering.` |
| `.../animations/utils.cpp:38-40` | `// This is an accelerator-style interpolator.` / `// In the future, this parameter (2.0) could be adjusted. This has been the` / `// default for Classic RN forever.` |
| `.../animations/utils.cpp:54-57` | `// Using mSpringDamping in this equation is not really the exact` / `// mathematical springDamping, but a good approximation We need to replace` / `// this equation with the right Factor that accounts for damping and` / `// friction` |
| `.../animations/conversions.h:38-39` | `double duration = 0; // these are perhaps better represented as uint64_t, but they` / `// come from JS as doubles` |
| `.../animations/primitives.h:21`、`:34`、`:45` | `// This corresponds exactly with JS.`（三处） |
| `.../animations/primitives.h:16-19`（`Float.h:16-19` 同文） | `Exact type of float numbers which ideally should match a type behing` / `platform- and chip-architecture-specific float type.`（拼写 `behing`） |
| `.../NativeAnimation/Drivers/RCTFrameAnimation.mm:121-128` | `// Do a linear remap of the two frames to safeguard against variable framerates` … `// Interpolate between the individual frames to ensure the animations are` / `// smooth and of the proper duration regardless of the framerate.` |
| `.../NativeAnimation/Drivers/RCTSpringAnimation.mm:117-118` | `// Handle frame drops, and only advance dt by a max of MAX_DELTA_TIME` |
| `.../NativeAnimation/Drivers/RCTSpringAnimation.mm:141-142` | `// This looks crazy -- it's actually just the derivative of the` / `// oscillation function` |
| `.../NativeAnimation/Drivers/RCTSpringAnimation.mm:174` | `// Ensure that we end up with a round value` |
| `.../NativeAnimation/RCTAnimationUtils.h:42-45` | `/**` / ` * Coefficient to slow down animations, respects the ios` / ` * simulator `Slow Animations (⌘T)` option.` / ` */` |
| `.../NativeAnimation/RCTAnimationUtils.mm:29-31` | `// UIAnimationDragCoefficient is 10.0 in tests for some reason, but` / `// we need it to be 1.0. Fixes T34233294` |
| `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:33-36` | `// We do some normalizing of the event names in RCTEventDispatcher#RCTNormalizeInputEventName.` / `// To make things simpler just get rid of the parts we change in the event names we use here.` / `// This is a lot easier than trying to denormalize because there would be multiple possible` / `// denormalized forms for a single input.` |
| `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:366-369` | `// Handle onScrollEnded special events.` / `// These are triggered when the user stops dragging or when the` / `// scroll view stops decelerating after the user swiped` / `// The goal is to use this event to force a resync of the Shadow Tree` / `// with the Native tree` |
| `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:365-366`、`:167-170` | `// Restoring default values needs to happen before UIManager operations so it is` / `// possible the node hasn't been created yet if it is being connected and` / `// disconnected in the same batch. In that case we don't need to restore` / `// default values since it will never actually update the view.` |
| `.../NativeAnimation/RCTNativeAnimatedNodesManager.h:1`（`RCTAnimatedNode.h:17`） | `@property (nonatomic, weak) RCTNativeAnimatedNodesManager *manager;`（弱引用设计） |
| `.../NativeAnimation/Drivers/RCTEventAnimation.mm:26` | `// Supported events args are in the following order, viewTag, eventName, eventData.` |
| `packages/react-native/React/Fabric/RCTScheduler.mm:121-123` | `/**` / ` * Called when the LayoutAnimation engine completes all pending animations.` / ` */` |
| `packages/react-native/React/Fabric/Mounting/RCTMountingManager.mm:295` | `RCTLogWarn(@"Attempted to update view with tag %ld, but it no longer exists", (long)reactTag);`（**静默丢弃一次动画帧更新**，无重试） |
| `packages/react-native/React/Fabric/AppleEventBeat.h:26-38` | `/*` / ` * Event beat associated with JavaScript runtime.` / … / ` * The induce is scheduled on the layer of the requesting view's window — the root` / ` * of the tree Core Animation is laying out when the request is made from` / ` * layout.` / ` */` |
| `packages/react-native/ReactCommon/react/renderer/animationbackend/AnimationChoreographer.h:17-20` | `/*` / ` * This class serves as an interface for native animation frame scheduling that can be used as abstraction in` / ` * ReactCxxPlatform.` / ` */` |
| `packages/react-native/ReactAndroid/src/main/jni/react/fabric/AndroidAnimationChoreographer.h`（整体） | `class AndroidAnimationChoreographer` 只有 `active_` 原子开关（`:35`），`resume()`/`pause()`（`:17-25`）不启动任何线程；真实 tick 由 Fabric 侧调 `onAnimationFrameIfActive`（`:27-32`） |

### 10.3 与代码相矛盾 / 误导的注释

| # | 位置 | 注释原文 | 与代码的矛盾 |
|---|---|---|---|
| C1 | `packages/react-native/Libraries/Animated/animations/Animation.js:40-42` | `Important note: start() and stop() will only be called at most once.` / `Once an animation has been stopped or finished its course, it will` / `not be reused.` | 与 `Animated.loop` 冲突：`.../AnimatedImplementation.js:523-524` `resetBeforeIteration && animation.reset(); animation.start(restart, iterations === -1);` 对同一 `CompositeAnimation` 反复 `start()`；`_startNativeLoop`（`:223-226`、`:283-286`、`:331-334`）亦然。对 `Animation` **实例**而言（timing/spring 每次 `start` 都 `new` 一个，见 `:206`/`:265`/`:314`）该不变式成立，但对 `CompositeAnimation` 不成立 —— 注释用词（`start()`）两义。 |
| C2 | `packages/react-native/Libraries/Animated/animations/SpringAnimation.js:273-276` | `we only advance by 4 frames worth of computation` | `MAX_STEPS = 64`（`:277`）是 **64 毫秒**，不是「4 帧的步数」。注释描述的是*时间*（4 帧 ≈ 64ms），常量名 `MAX_STEPS`（steps=帧）与实际单位（ms）不符，易误读。Android 侧同义常量注释反而正确：`.../animated/SpringAnimation.kt:184` `(4 frames at 60 FPS)` + `MAX_DELTA_TIME_SEC = 0.064`。 |
| C3 | `packages/react-native/Libraries/Animated/nodes/AnimatedInterpolation.js:159-177` vs `:343-352` | `:344` `invariant(arr.length !== 2 \|\| arr[0] !== -Infinity \|\| arr[1] !== Infinity, name + ' cannot be ]-infinity;+infinity[ ' + arr)` | `interpolate()`（`:159-177`）**显式实现** `-Infinity` / `+Infinity` 分支；`checkInfiniteRange` 又**禁止**长度为 2 的 `]-inf, +inf[`。两者不冲突（后者是更窄的特例），但注释 `name + ' cannot be ]-infinity;+infinity['` 的表述读起来像「禁止任何无穷」，与 `:159` 的支持分支矛盾。 |
| C4 | `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp:225-229` | `Update -> update: remove the previous update, make it the baseline of the` / `next update (with current progress)` | `.../primitives.h:79` 的 `double initialProgress;` 是**唯一**记录 current progress 的字段，但代码里只被写成 `0`（`:511`、`:550`、`:637`、`:674`），**从未被读取**。注释承诺的「with current progress」未实现 —— 实际是靠 `viewPrev`（`:64` 每帧更新）隐式携带。 |
| C5 | `.../LayoutAnimationKeyFrameManager.cpp:222-223` | `// What to do if we detect a conflict? Get current value and make` / `// that the baseline of the next animation. Scale the remaining time` / `// in the animation` | 「Scale the remaining time」未实现：`:674` `keyFrame.initialProgress = 0;`、`:752-754` 仅「restart viewStart」，时间轴由 `animation.startTime = now`（`:252`）整体重置。 |
| C6 | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/PropsAnimatedNode.kt:78-80` | `// The mapped node can be dropped mid-teardown (e.g. component unmounts during` / `// navigation) while this prop update is still in flight. Skip it instead of` / `// throwing, mirroring the connectedViewTag == -1 guard.` | 该防护只在 `PropsAnimatedNode.updateView()`（`:76-83`）生效。**同类路径未加防护**：`.../animated/StyleAnimatedNode.kt:37` `requireNotNull(node) { "Mapped style node does not exist" }`、`:54` `IllegalArgumentException`；`.../animated/TransformAnimatedNode.kt:56`、`:60` `IllegalArgumentException`；`.../animated/ObjectAnimatedNode.kt:54`、`:96` `requireNotNull(node) { "Mapped value node does not exist" }`。这些抛出的是 `IllegalArgumentException`，而 `.../NativeAnimatedNodesManager.kt:709` 的 catch 只捕获 `JSApplicationCausedNativeException` ⇒ **不会被 `:709-718` 的「Eat the exception rather than crashing」保护**。 |
| C7 | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/animated/InterpolationAnimatedNode.kt:21` | `Currently only a linear interpolation is supported on an input range of an arbitrary size.` | JS 侧已把 `easing` 采样成 `easingStops`（`.../nodes/AnimatedInterpolation.js:547-556`、`:567`），而 C++ backend 已消费（`packages/react-native/ReactCommon/react/renderer/animated/nodes/InterpolationAnimatedNode.cpp:61-65`）。**Android 的 `InterpolationAnimatedNode` 全文件无 `easingStops` 处理**（`grep -rn easingStops` 仅命中 JS 与 C++），故该注释对 Android 仍成立，但与 JS 侧已支持 easing 的事实形成跨端能力差 —— 注释未标注适用范围。 |
| C8 | `packages/react-native/src/private/animated/createAnimatedPropsHook.js:303` | `// NOTE: Do not restore default values on unmount, see D18197735.` | 紧接的 `:304-307` 是 `if (isMounted.current) { node.__restoreDefaultValues(); }`，`:305` 又有 `// TODO: Stop restoring default values (unless `reset` is called).`。注释「do not restore on unmount」与紧邻的 TODO「Stop restoring default values」语义相反（一个说别恢复，一个说迟早要停掉恢复）。 |
| C9 | `packages/react-native/Libraries/Animated/nodes/AnimatedTransform.js:48-49` | `// NOTE: For potentially historical reasons, some operations only operate on` / `// the first level of AnimatedNode instances. This optimizes that bevavior.` | 注释内容与代码一致（`flatAnimatedNodes`（`:31-45`）确实只遍历每个 transform 条目的第一层，`:37` `if (value instanceof AnimatedNode) { nodes.push(value); }`），**但有拼写错误 `bevavior`**。该注释本身「ambiguous」（"some operations" 未指明是哪些操作），且 `AnimatedTransform.__getValueWithStaticTransforms`（`:97-109`）依赖 `mapTransforms` 对两层结构的同构假设（`:106-108` 注释 `We can depend on this._transforms and staticTransforms sharing a structure because of useAnimatedPropsMemo.`）—— 该假设由 `.../src/private/animated/createAnimatedPropsMemoHook.js` 的 composite-key 深比较保证（`:331-349`），但仅在**有 allowlist** 时深比较（`:282-300`，`allowlist == null` 时只做引用相等 `:285-288`） |
| C10 | `packages/react-native/ReactCommon/react/renderer/animations/LayoutAnimationKeyFrameManager.cpp:1584` | `// Execute stopSurface on any ongoing animations` | 该清理**整体**在 `if (inflightAnimationsExistInitially)` 内（`:1585`）；若无 inflight 动画，`surfaceIdsToStop_` 不被清空（`:1590`）。见 §3.4(c)。 |

---

## 11. 附：本次核查中最值得优先处理的 8 个发现（按价值排序）

1. **Android `dropAnimatedNode` 不停驱动** — `.../animated/NativeAnimatedNodesManager.kt:136-139`。后果：Choreographer 永久 re-arm（`.../animated/NativeAnimatedModule.kt:349-353`）+ 已 drop 节点继续发 `onAnimatedValueUpdate`（`:578` → `:719-722` → `:41`）。iOS 同构：`.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:180-187`。
2. **`_executeAsAnimatedBatch` 缺 try/finally** — `.../nodes/AnimatedValue.js:74-78`，抛异常即让 `queueOperations` 永久为 true（`.../NativeAnimatedHelper.js:308`）。同型第二处：`.../nodes/AnimatedColor.js:184`~`:219`。
3. **`eventListenerGetValueCallbacks` 单调无界** — `.../NativeAnimatedHelper.js:62-64`（写 `:273`，删 `:376`），native 抛异常时永不删（`.../animated/NativeAnimatedNodesManager.kt:418-424`），键为只增 tag（`:46`、`:399-401`）。
4. **`FrameBasedAnimationDriver.resetConfig` 帧数相同就不刷新帧值** — `.../animated/FrameBasedAnimationDriver.kt:36-41`，导致 Android 上「同 duration 不同 easing」的重启沿用旧缓动；iOS `.../Drivers/RCTFrameAnimation.mm:62` 每次都刷新。
5. **`PropsAnimatedNode` 的 null 防护在 `StyleAnimatedNode`/`TransformAnimatedNode`/`ObjectAnimatedNode` 缺失** — `.../animated/StyleAnimatedNode.kt:37`、`:54`；`.../animated/TransformAnimatedNode.kt:56`、`:60`；`.../animated/ObjectAnimatedNode.kt:54`、`:96` 抛 `IllegalArgumentException`，不在 `.../NativeAnimatedNodesManager.kt:709` 的 catch 范围内（对照 `.../animated/PropsAnimatedNode.kt:78-83` 的注释所声称的「mirroring」）。
6. **`surfaceIdsToStop_` 只在有 inflight 动画时清空** — `.../animations/LayoutAnimationKeyFrameManager.cpp:1585`/`:1590`，无界集合。
7. **iOS `CADisplayLink`↔`RCTNativeAnimatedNodesManager` 自环，无 `dealloc`** — `.../NativeAnimation/RCTNativeAnimatedNodesManager.mm:55`、`:436`；唯一打破点 `.../RCTNativeAnimatedTurboModule.mm:63`。
8. **`calculateAnimationProgress` 的 `damping` 除零 + `duration==0` 的分母** — `.../animations/utils.cpp:63`、`:32-33`；默认值 `0.5`（`.../conversions.h:114`）安全，但 config 可显式给 0（`.../conversions.h:137-145`）且无下限校验。

---

*（报告结束。所有数值均来自上文列出的实测命令；所有引用均逐字复制自源文件。）*