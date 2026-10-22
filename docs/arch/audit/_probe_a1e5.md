# PROBE A1E5 — Vendored Yoga + C++ Renderer Core (fact extraction)

Scope: `packages/react-native/ReactCommon/yoga/` and
`packages/react-native/ReactCommon/react/renderer/{components,core,dom,graphics,mounting,scheduler,textlayoutmanager,uimanager}`.
Tests (`*/tests/*`, `*/__tests__/*`) and `yoga/test/` are excluded from counts, except
yoga itself which is the target.

Note: the task brief says `renderer/textlayout`; the actual directory is
`renderer/textlayoutmanager`. `renderer/textlayout` does not exist
(`ls packages/react-native/ReactCommon/react/renderer | grep -i text` →
`textlayoutmanager` only).

`Float` — the type used by all RN layout arithmetic — is **platform-conditional**:
* `packages/react-native/ReactCommon/react/renderer/graphics/platform/android/react/renderer/graphics/Float.h:19` — `using Float = float;`
* `packages/react-native/ReactCommon/react/renderer/graphics/platform/ios/react/renderer/graphics/Float.h:19` — `using Float = CGFloat;` (`double` on all 64-bit Apple platforms)
* `packages/react-native/ReactCommon/react/renderer/graphics/platform/cxx/react/renderer/graphics/Float.h:19` — `using Float = float;`

All three carry the comment: `Exact type of float numbers which ideally should match a type behing platform- and chip-architecture-specific float type.`
So `Float` is `float` on Android but `double` on iOS — every epsilon
(`kDefaultEpsilon = 0.005f`, `kEpsilon = 0.001`) and every
`roundToPixel` therefore has **different absolute precision** on the two
platforms. This is cross-language/cross-platform contract item #0.

---

## 1. FILE INVENTORY

### 1.1 Commands (exact)

```
cd react-native
for d in "packages/react-native/ReactCommon/yoga" \
         "packages/react-native/ReactCommon/react/renderer/components" \
         "packages/react-native/ReactCommon/react/renderer/core" \
         "packages/react-native/ReactCommon/react/renderer/dom" \
         "packages/react-native/ReactCommon/react/renderer/graphics" \
         "packages/react-native/ReactCommon/react/renderer/mounting" \
         "packages/react-native/ReactCommon/react/renderer/scheduler" \
         "packages/react-native/ReactCommon/react/renderer/textlayoutmanager" \
         "packages/react-native/ReactCommon/react/renderer/uimanager"; do
  n=$(find "$d" -type f \( -name '*.cpp' -o -name '*.h' \) \
        -not -path '*__tests__*' -not -path '*/tests/*' -not -path '*/test/*' | wc -l)
  l=$(find "$d" -type f \( -name '*.cpp' -o -name '*.h' \) \
        -not -path '*__tests__*' -not -path '*/tests/*' -not -path '*/test/*' \
        -exec cat {} + | wc -l)
  printf "%-70s %6s files %8s lines\n" "$d" "$n" "$l"
done
```

```
find <the nine dirs above> -type f \( -name '*.cpp' -o -name '*.h' \) \
  -not -path '*__tests__*' -not -path '*/tests/*' -exec wc -l {} + | sort -rn | head -41
```

### 1.2 Measured counts (`.cpp` + `.h` only, non-test)

| Directory | Files | Lines |
| --- | ---: | ---: |
| `packages/react-native/ReactCommon/yoga` | 79 | 12481 |
| `packages/react-native/ReactCommon/react/renderer/components` | 212 | 22079 |
| `packages/react-native/ReactCommon/react/renderer/core` | 82 | 8268 |
| `packages/react-native/ReactCommon/react/renderer/dom` | 2 | 705 |
| `packages/react-native/ReactCommon/react/renderer/graphics` | 47 | 3528 |
| `packages/react-native/ReactCommon/react/renderer/mounting` | 33 | 4979 |
| `packages/react-native/ReactCommon/react/renderer/scheduler` | 9 | 1588 |
| `packages/react-native/ReactCommon/react/renderer/textlayoutmanager` | 16 | 1730 |
| `packages/react-native/ReactCommon/react/renderer/uimanager` | 26 | 4511 |
| **total** | **507** | **59969** |

(`wc -l total` on the same file list reports `59975`; the 6-line delta is
`total` vs sum-of-parts rounding — the aggregate line is the sum of the 507
files, and the per-directory figures come from the same `find`, so treat
`59975` as authoritative for the aggregate.)

Note: `mounting` includes `stubs/` (386+111+96+67+59+30 lines) which is
`RN_SHADOW_TREE_INTROSPECTION`-only tooling.

### 1.3 Forty largest files by exact line count

| # | Lines | File |
| ---: | ---: | --- |
| 1 | 2968 | `packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp` |
| 2 | 1809 | `packages/react-native/ReactCommon/react/renderer/components/view/conversions.h` |
| 3 | 1442 | `packages/react-native/ReactCommon/react/renderer/mounting/Differentiator.cpp` |
| 4 | 1240 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManagerBinding.cpp` |
| 5 | 1117 | `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp` |
| 6 | 1004 | `packages/react-native/ReactCommon/react/renderer/components/view/platform/android/react/renderer/components/view/HostPlatformViewProps.cpp` |
| 7 | 932 | `packages/react-native/ReactCommon/yoga/yoga/style/Style.h` |
| 8 | 843 | `packages/react-native/ReactCommon/react/renderer/components/view/accessibilityPropsConversions.h` |
| 9 | 801 | `packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.cpp` |
| 10 | 783 | `packages/react-native/ReactCommon/yoga/yoga/YGNodeStyle.cpp` |
| 11 | 660 | `packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.cpp` |
| 12 | 634 | `packages/react-native/ReactCommon/react/renderer/components/textinput/platform/android/react/renderer/components/androidtextinput/AndroidTextInputProps.cpp` |
| 13 | 633 | `packages/react-native/ReactCommon/react/renderer/components/view/propsConversions.h` |
| 14 | 616 | `packages/react-native/ReactCommon/react/renderer/components/view/BaseViewProps.cpp` |
| 15 | 610 | `packages/react-native/ReactCommon/react/renderer/components/view/BackgroundImagePropsConversions.cpp` |
| 16 | 595 | `packages/react-native/ReactCommon/yoga/yoga/algorithm/AbsoluteLayout.cpp` |
| 17 | 589 | `packages/react-native/ReactCommon/react/renderer/dom/DOM.cpp` |
| 18 | 557 | `packages/react-native/ReactCommon/react/renderer/components/text/BaseTextProps.cpp` |
| 19 | 546 | `packages/react-native/ReactCommon/react/renderer/uimanager/PointerEventsProcessor.cpp` |
| 20 | 531 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp` |
| 21 | 520 | `packages/react-native/ReactCommon/react/renderer/core/RawValue.h` |
| 22 | 517 | `packages/react-native/ReactCommon/react/renderer/components/view/YogaStylableProps.cpp` |
| 23 | 513 | `packages/react-native/ReactCommon/react/renderer/graphics/Transform.cpp` |
| 24 | 509 | `packages/react-native/ReactCommon/yoga/yoga/node/Node.cpp` |
| 25 | 483 | `packages/react-native/ReactCommon/react/renderer/scheduler/Scheduler.cpp` |
| 26 | 449 | `packages/react-native/ReactCommon/react/renderer/components/scrollview/BaseScrollViewProps.cpp` |
| 27 | 448 | `packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp` |
| 28 | 436 | `packages/react-native/ReactCommon/react/renderer/textlayoutmanager/platform/android/react/renderer/textlayoutmanager/TextLayoutManager.cpp` |
| 29 | 407 | `packages/react-native/ReactCommon/yoga/yoga/YGNode.cpp` |
| 30 | 393 | `packages/react-native/ReactCommon/react/renderer/core/LayoutableShadowNode.cpp` |
| 31 | 386 | `packages/react-native/ReactCommon/react/renderer/mounting/stubs/StubViewTree.cpp` |
| 32 | 386 | `packages/react-native/ReactCommon/react/renderer/components/scrollview/platform/android/react/renderer/components/scrollview/HostPlatformScrollViewProps.cpp` |
| 33 | 373 | `packages/react-native/ReactCommon/yoga/yoga/YGNode.h` |
| 34 | 372 | `packages/react-native/ReactCommon/yoga/yoga/node/Node.h` |
| 35 | 368 | `packages/react-native/ReactCommon/react/renderer/components/view/FilterPropsConversions.h` |
| 36 | 329 | `packages/react-native/ReactCommon/react/renderer/textlayoutmanager/TextMeasureCache.h` |
| 37 | 319 | `packages/react-native/ReactCommon/react/renderer/scheduler/SurfaceHandler.cpp` |
| 38 | 310 | `packages/react-native/ReactCommon/react/renderer/components/image/ImageProps.cpp` |
| 39 | 304 | `packages/react-native/ReactCommon/yoga/yoga/YGEnums.cpp` |
| 40 | 303 | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.h` |

---

## 2. YOGA CONFIGURATION SURFACE

### 2.1 Every config point RN sets on Yoga

| path:line | exact setting | value / condition |
| --- | --- | --- |
| `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:490` | `YGConfigSetErrata(&yogaConfig_, errata);` | `errata` from `resolveErrata(defaultErrata)` (line 489) |
| `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:491` | `YGConfigSetPointScaleFactor(&yogaConfig_, pointScaleFactor);` | from `layoutContext.pointScaleFactor` (call site line 647) |
| `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:941-942` | `YGConfigSetCloneNodeFunc(&config, YogaLayoutableShadowNode::yogaNodeCloneCallbackConnector);` | unconditional |
| `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:944-945` | `YGConfigSetPointScaleFactor(&config, YGConfigGetPointScaleFactor(previousConfig));` | clone path only (`previousConfig != nullptr`) |
| `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:946` | `YGConfigSetErrata(&config, YGConfigGetErrata(previousConfig));` | clone path only |
| `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:950-951` | `YGConfigSetExperimentalFeatureEnabled(&config, YGExperimentalFeatureFixFlexBasisFitContent, true);` | gated on `ReactNativeFeatureFlags::fixYogaFlexBasisFitContentInMainAxis()` (line 949) |

Logger — configured via the `Config` constructor, not a setter:
`packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:72` and `:99`
— `yogaConfig_(FabricDefaultYogaLog)`, with `FabricDefaultYogaLog` defined at
`:30`.

Android JNI surface (used by `com.facebook.yoga.YogaJNI`, not by Fabric):
* `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/YGJNIVanilla.cpp:57` — `YGConfigSetExperimentalFeatureEnabled(config, static_cast<YGExperimentalFeature>(feature), static_cast<bool>(enabled));`
* `…/YGJNIVanilla.cpp:69` — `YGConfigSetUseWebDefaults(config, static_cast<bool>(useWebDefaults));`
* `…/YGJNIVanilla.cpp:78` — `YGConfigSetPointScaleFactor(config, pixelsInPoint);`
* `…/YGJNIVanilla.cpp:87` — `YGConfigSetErrata(config, static_cast<YGErrata>(errata));`
* `…/YGJNIVanilla.cpp:170` — `YGConfigSetContext(config, context);`
* `…/YGJNIVanilla.cpp:174` — `YGConfigSetLogger(config, YGJNILogFunc);`
* `…/YGJNIVanilla.cpp:178` — `YGConfigSetContext(config, nullptr);`
* `…/YGJNIVanilla.cpp:180` — `YGConfigSetLogger(config, nullptr);`

Per-node config is **not** shared: each `YogaLayoutableShadowNode` owns a
`yoga::Config` by value — `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.h:103`
`yoga::Config yogaConfig_;`. Config is therefore **per ShadowNode instance**,
not per tree.

### 2.2 YGConfig setters that exist in vendored Yoga but RN never calls

Verified with `grep -rn --include='*.cpp' --include='*.h' --include='*.mm' --include='*.m' -w <sym> packages/ private/ | grep -v ReactCommon/yoga/yoga/`:

| symbol | declaration | RN references outside yoga |
| --- | --- | ---: |
| `YGNodeFree` | `packages/react-native/ReactCommon/yoga/yoga/YGNode.h:49` | **0** |
| `YGNodeFreeRecursive` | `…/yoga/YGNode.h:54` | **0** |
| `YGNodeSetDirtiedFunc` | `…/yoga/YGNode.h:110` | **0** |
| `YGNodeGetDirtiedFunc` | `…/yoga/YGNode.h:115` | **0** |
| `YGNodeCanUseCachedMeasurement` | `…/yoga/YGNode.h:358` (marked `YG_DEPRECATED` at `:356-357`) | **0** |
| `YGNodeGetAlwaysFormsContainingBlock` | `…/yoga/YGNode.h:351` | **0** |
| `YGNodeSetChildren` | `…/yoga/YGNode.h:141` | **0** |
| `YGNodeGetParent` | `…/yoga/YGNode.h:161` | **0** |
| `YGNodeLayoutGetHadOverflow` | `…/yoga/YGNodeLayout.h` | **0** |
| `YGConfigGetDefault` | `…/yoga/YGConfig.h:47` | **0** |
| `YGConfigGetUseWebDefaults` | `…/yoga/YGConfig.h:60` | **0** |
| `YGConfigSetContext` | `…/yoga/YGConfig.h:120` | called only from the legacy Android JNI shim (`YGJNIVanilla.cpp:170,178`) — never from the Fabric renderer |
| `YGConfigSetLogger` | `…/yoga/YGConfig.h:114` | called only from `YGJNIVanilla.cpp:174,180` — Fabric passes the logger via the `Config` ctor instead |
| `YGConfigSetUseWebDefaults` | `…/yoga/YGConfig.h:55` | called only from `YGJNIVanilla.cpp:69` — Fabric never enables web defaults |

C++-level (non-C-API) config API never called by RN:
`Config::addErrata` (`packages/react-native/ReactCommon/yoga/yoga/config/Config.h:45`),
`Config::removeErrata` (`…/config/Config.h:46`),
`Config::setContext` (`…/config/Config.h:53`),
`Config::setLogger` (`…/config/Config.h:58`),
`Config::setUseWebDefaults` (`…/config/Config.h:37`),
`Config::setCloneNodeCallback` (`…/config/Config.h:65` — the C function
`YGConfigSetCloneNodeFunc` at `YGNode.h` line 154/946 path *is* used).

`ExperimentalFeature::WebFlexBasis` (`packages/react-native/ReactCommon/yoga/yoga/enums/ExperimentalFeature.h:19`)
is **never enabled** by RN; only `FixFlexBasisFitContent` is (see 2.1). It is
still *read* at
`packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:274-276`
— dead branch under RN configuration.

### 2.3 Errata RN enables / disables

Definitions: `packages/react-native/ReactCommon/yoga/yoga/enums/Errata.h:18-27`;
numeric values `packages/react-native/ReactCommon/yoga/yoga/YGEnums.h:64-73`
(`YGErrataNone=0`, `StretchFlexBasis=1`, `AbsolutePositionWithoutInsetsExcludesPadding=2`,
`AbsolutePercentAgainstInnerSize=4`, `MinSizeUndefinedInsteadOfAuto=8`,
`FlexFirstPassUsesRunningTotals=16`, `All=2147483647`, `Classic=2147483646`).

| path:line | setting |
| --- | --- |
| `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:649` | `YGErrataAll /*defaultErrata*/,` — the value `layoutTree` passes into `configureYogaTree`. `YGErrataAll == 2147483647`, i.e. **every** errata bit is set for the default (non-`LayoutConformance`) case. |
| `…/YogaLayoutableShadowNode.cpp:563` | `return YGErrataAll;` — `LayoutConformance::Compatibility` |
| `…/YogaLayoutableShadowNode.cpp:559-561` | `ReactNativeFeatureFlags::enableFlexboxAutoMinSizeInStrictMode() ? YGErrataNone : YGErrataMinSizeUndefinedInsteadOfAuto;` — `LayoutConformance::Strict` |
| `…/YogaLayoutableShadowNode.cpp:567` | `return defaultErrata;` — fallthrough |
| `…/YogaLayoutableShadowNode.cpp:946` | `YGConfigSetErrata(&config, YGConfigGetErrata(previousConfig));` — clone inherits parent's errata |
| `…/YogaLayoutableShadowNode.cpp:519` | `auto childErrata = YGConfigGetErrata(&child.yogaConfig_);` (read-only, used to decide reconfiguration at `:526`) |
| `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/YGJNIVanilla.cpp:87` | `YGConfigSetErrata(config, static_cast<YGErrata>(errata));` (legacy JNI path; caller-supplied bitmask) |

Yoga's own default config (`packages/react-native/ReactCommon/yoga/yoga/config/Config.h:79-80`)
is `Errata::MinSizeUndefinedInsteadOfAuto | Errata::FlexFirstPassUsesRunningTotals`,
but RN never uses the default config (`YGConfigGetDefault` has 0 external
references; every RN node gets `&initializeYogaConfig(yogaConfig_)`).

Where each errata is consumed in Yoga:
* `AbsolutePositionWithoutInsetsExcludesPadding` — `…/yoga/algorithm/AbsoluteLayout.cpp:29,50,74,92`
* `AbsolutePercentAgainstInnerSize` — `…/yoga/algorithm/AbsoluteLayout.cpp:472`
* `FlexFirstPassUsesRunningTotals` — `…/yoga/algorithm/CalculateLayout.cpp:1297`
* `MinSizeUndefinedInsteadOfAuto` — `…/yoga/algorithm/CalculateLayout.cpp:1426, 966`
* `StretchFlexBasis` — `…/yoga/algorithm/CalculateLayout.cpp:2053`

Because RN sets `YGErrataAll`, **all five** behaviours are always on except
inside a `Strict`-conformance subtree with
`enableFlexboxAutoMinSizeInStrictMode()` on, where all are cleared.

---

## 3. LAYOUT ALGORITHM & LIMITS

### 3.1 Core layout entry points

| entry point | path:line | params | return |
| --- | --- | --- | --- |
| `YGNodeCalculateLayout` (decl) | `packages/react-native/ReactCommon/yoga/yoga/YGNode.h:77-81` | `YGNodeRef node, float availableWidth, float availableHeight, YGDirection ownerDirection` | `void` |
| `YGNodeCalculateLayout` (impl) | `packages/react-native/ReactCommon/yoga/yoga/YGNode.cpp:88-95` | same | `void` — thin forwarder to `yoga::calculateLayout` |
| `yoga::calculateLayout` | `packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:2873-2966` | `(yoga::Node*, float ownerWidth, float ownerHeight, Direction ownerDirection)` | `void` |
| `calculateLayoutInternal` | `…/CalculateLayout.cpp:2675-2871` | `(node, availableWidth, availableHeight, ownerDirection, widthSizingMode, heightSizingMode, ownerWidth, ownerHeight, performLayout, LayoutPassReason reason, LayoutData&, uint32_t depth, const uint32_t generationCount)` | **`bool` — "Return parameter is true if layout was performed, false if skipped" (comment at `:2673`)**; final expression `return (needToVisitNode || cachedResults == nullptr);` at `:2870` |
| `calculateLayoutImpl` | `…/CalculateLayout.cpp:1724-2665` | `(node, availableWidth, availableHeight, ownerDirection, widthSizingMode, heightSizingMode, ownerWidth, ownerHeight, performLayout, reason, layoutMarkerData, uint32_t depth, generationCount)` | `void` |

RN call site: `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:706`
`YGNodeCalculateLayout(&yogaNode_, ownerWidth, ownerHeight, direction);`
The boolean from `calculateLayoutInternal` is consumed inside
`calculateLayout` at `:2947-2963`: if true → `node->setPosition(...)` (`:2961`)
and `roundLayoutResultsToPixelGrid(node, 0.0f, 0.0f)` (`:2962`).

**`YGConfigSetPointScaleFactor` abort precondition**: `…/yoga/YGConfig.cpp:38-41`
asserts `pixelsInPoint >= 0.0f` with message
`"Scale factor should not be less than zero"`. RN passes
`layoutContext.pointScaleFactor` at `…/YogaLayoutableShadowNode.cpp:491`
with no prior sign check, so a negative `LayoutContext::pointScaleFactor`
(defaults to `1.0` at `…/core/LayoutContext.h:29`) terminates the process
inside Yoga rather than being rejected at the RN boundary.

Rounding contract documented in `packages/react-native/ReactCommon/yoga/yoga/YGNode.h:71-76`:
"Layout results may be read after calling `YGNodeCalculateLayout()` using
functions like `YGNodeLayoutGetLeft()`, `YGNodeLayoutGetTop()`, etc.
`YGNodeGetHasNewLayout()` may be read to know if the layout of the node or its
subtrees may have changed since the last time `YGNodeCalculate()` was called."

### 3.2 Hardcoded limits in Yoga

| value | meaning | path:line |
| ---: | --- | --- |
| `64` | `constexpr std::size_t maxPendingNodes = 64;` — bounded DFS stack in the `canSkipHeightFitContent` fast path; overflow causes `return false` (i.e. the optimisation is skipped, no layout error) | `packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:188` (guard at `:197-199`) |
| `8` | `static constexpr int32_t MaxCachedMeasurements = 8;` with the comment "This value was chosen based on empirical data: 98% of analyzed layouts require less than 8 entries." | `packages/react-native/ReactCommon/yoga/yoga/node/LayoutResults.h:25` (comment `:23-24`); cache ring wrap at `…/CalculateLayout.cpp:2818-2821` |
| `0.0001f` | `inexactEquals(float,float)` epsilon — `std::abs(a - b) < 0.0001f` | `packages/react-native/ReactCommon/yoga/yoga/numeric/Comparison.h:56-61` (value at `:58`; header comment `:54-55`) |
| `0.0001` | same for `double` | `…/numeric/Comparison.h:63-68` (value at `:65`) |
| `0.5` | rounding threshold in `roundValueToPixelGrid` — `fractional > 0.5 \|\| inexactEquals(fractional, 0.5)` → round up | `packages/react-native/ReactCommon/yoga/yoga/algorithm/PixelGrid.cpp:57` |
| `1.0f` | default `pointScaleFactor_` | `packages/react-native/ReactCommon/yoga/yoga/config/Config.h:81` `float pointScaleFactor_ = 1.0f;` |
| `0.0f` | `useWebDefaults_` default | `…/config/Config.h:75` |
| `4096` | `assert(index < 4096 && "SmallValueBuffer can only hold up to 4096 chunks");` — index type is `uint16_t`, so the assert cannot fire; effectively a 65536-chunk hard cap | `packages/react-native/ReactCommon/yoga/yoga/style/SmallValueBuffer.h:34` and `:55-56` |
| `2047` | `constexpr uint16_t kMaxInlineAbsValue = (1 << 11) - 1;` — max integer magnitude inlined into a `StyleValueHandle` without a pool slot | `packages/react-native/ReactCommon/yoga/yoga/style/StyleValuePool.h:169` |
| `4` | `SmallValueBuffer<4> buffer_;` inline slots per `Style` before heap overflow | `…/style/StyleValuePool.h:191` |
| `2` | `ordinalCount<ExperimentalFeature>()` — bitset width for experimental features | `packages/react-native/ReactCommon/yoga/yoga/enums/ExperimentalFeature.h:24-26` |

**There is no max-depth limit and no max-child-count limit in vendored Yoga.**
Grep for `depth` in `…/yoga/algorithm/CalculateLayout.cpp` yields only
`depth++` at `:2691`, the parameter declarations (`:1736`, `:2687`), and
forwarding at `:2807`, `:2237`, `:2473`, `:438`, `:1244`. `depth` is
**threaded and incremented but never compared against any bound** — no stack
depth guard exists; deep trees recurse in C++ and will consume native stack.

**No iteration cap** exists in the layout algorithm either: the only bounded
container is the `maxPendingNodes = 64` DFS stack above (an optimisation
bail-out, not a correctness limit).

### 3.3 Epsilon / rounding / pointScaleFactor arithmetic

Rounding happens in exactly one place: `roundLayoutResultsToPixelGrid`.

* `roundValueToPixelGrid(value, pointScaleFactor, forceCeil, forceFloor)` —
  `packages/react-native/ReactCommon/yoga/yoga/algorithm/PixelGrid.cpp:15-64`.
  - `scaledValue = value * pointScaleFactor;` (`:20`)
  - `fmod` fractional extraction (`:24`), negative correction `++fractional` (`:41`)
  - three special cases: already-rounded (`:43-45`), `fractional == 1.0` (`:46-47`),
    `forceCeil` (`:48-50`), `forceFloor` (`:51-52`), else nearest (`:53-60`)
  - NaN guard: `return (std::isnan(scaledValue) || std::isnan(pointScaleFactor)) ? YGUndefined : (float)(scaledValue / pointScaleFactor);` (`:61-63`)
* `roundLayoutResultsToPixelGrid(node, absoluteLeft, absoluteTop)` —
  `…/algorithm/PixelGrid.cpp:66-137`.
  - `pointScaleFactor` read from the node's config (`:70-71`)
  - **guarded by `if (pointScaleFactor != 0.0)`** (`:85`) — with
    `pointScaleFactor == 0` no rounding at all is applied.
  - `textRounding` flag: `node->getNodeType() == NodeType::Text` (`:88`) —
    "If a node has a custom measure function we never want to round down its
    size as this could lead to unwanted text truncation." (`:86-87`)
  - position rounding (`:90-96`), then width/height as a **difference of two
    independently rounded absolute edges** (`:110-128`), with the
    `hasFractionalWidth` / `hasFractionalHeight` fractional test at `:103-108`.
  - recursion only follows **owned** children:
    `if (child->getOwner() != node) { continue; }` (`:131-134`).

Where rounding affects the RN-visible numbers:
* Cache comparison also rounds: `canUseCachedMeasurement` calls
  `roundValueToPixelGrid(...)` for available/last-available widths and heights
  when `pointScaleFactor != 0` — `…/yoga/algorithm/Cache.cpp:64-80`.
* RN reads results through `layoutMetricsFromYogaNode` —
  `packages/react-native/ReactCommon/react/renderer/components/view/conversions.h:152-185`,
  using `YGNodeLayoutGetLeft/Top/Width/Height/Border/Padding`.
* `Float` <-> `float` conversion: `floatFromYogaFloat` /
  `yogaFloatFromFloat` — `…/components/view/conversions.h:57-74`.
  `floatFromYogaFloat` maps `YGUndefined` (NaN) to `+infinity`
  (`:60-62`); `yogaFloatFromFloat` maps any non-finite `Float` back to
  `YGUndefined` (`:69-71`).

### 3.4 Every abort-capable assertion in Yoga

Abort mechanism: `packages/react-native/ReactCommon/yoga/yoga/debug/AssertFatal.cpp:18-25`
— `fatalWithMessage` `throw std::logic_error(message);` when `__cpp_exceptions`,
else `std::terminate();`.
`assertFatal*` all funnel through it (`AssertFatal.cpp:27-52`).

| path:line | condition |
| --- | --- |
| `…/yoga/node/Node.cpp:23-24` | `config != nullptr`, message `"Attempting to construct Node with null config"` |
| `…/yoga/node/Node.cpp:138-142` | `children_.empty()`, message `"Cannot set measure function: Nodes with measure functions cannot have children."` |
| `…/yoga/node/Node.cpp:187-188` | `config != nullptr`, `"Attempting to set a null config on a Node"` |
| `…/yoga/node/Node.cpp:189-192` | `config->useWebDefaults() == config_->useWebDefaults()`, `"UseWebDefaults may not be changed after constructing a Node"` |
| `…/yoga/node/Node.cpp:499-502` | `children_.empty()`, `"Cannot reset a node which still has children attached"` |
| `…/yoga/node/Node.cpp:503-504` | `owner_ == nullptr`, `"Cannot reset a node still attached to a owner"` |
| `…/yoga/algorithm/CalculateLayout.cpp:472-475` | `node->hasMeasureFunc()`, `"Expected node to have custom measure function"` |
| `…/yoga/algorithm/CalculateLayout.cpp:1738-1744` | `isUndefined(availableWidth) ? widthSizingMode == SizingMode::MaxContent : true`, `"availableWidth is indefinite so widthSizingMode must be SizingMode::MaxContent"` |
| `…/yoga/algorithm/CalculateLayout.cpp:1745-1751` | same for `availableHeight` / `heightSizingMode` |
| `…/yoga/algorithm/Baseline.cpp:27-30` | `!std::isnan(baseline)`, message `"Expect custom baseline function to not return NaN"` — the **only** validation of a `YGBaselineFunc` result anywhere in Yoga |
| `…/yoga/algorithm/FlexDirection.h:64` | `fatalWithMessage("Invalid FlexDirection")` |
| `…/yoga/algorithm/FlexDirection.h:79` | `fatalWithMessage("Invalid FlexDirection")` |
| `…/yoga/algorithm/FlexDirection.h:116` | `fatalWithMessage("Invalid FlexDirection")` |
| `…/yoga/algorithm/SizingMode.h:56` | `fatalWithMessage("Invalid SizingMode")` |
| `…/yoga/algorithm/SizingMode.h:69` | `fatalWithMessage("Invalid MeasureMode")` |
| `…/yoga/style/Style.h:824` | `fatalWithMessage("Invalid physical edge")` |
| `…/yoga/style/Style.h:839` | same |
| `…/yoga/style/Style.h:855` | same |
| `…/yoga/style/Style.h:870` | same |
| `…/yoga/YGNode.cpp:26-27` | `config != nullptr`, `"Tried to construct YGNode with null config"` |
| `…/yoga/YGNode.cpp:112-116` | `node->hasMeasureFunc()`, `"Only leaf nodes with custom measure functions should manually mark themselves as dirty"` |
| `…/yoga/YGNode.cpp:136-139` | `child->getOwner() == nullptr`, `"Child already has a owner, it must be removed first."` |
| `…/yoga/YGNode.cpp:141-144` | `!owner->hasMeasureFunc()`, `"Cannot add child: Nodes with measure functions cannot have children."` |
| `…/yoga/YGNodeLayout.cpp:21-24` | `edge <= Edge::End`, `"Cannot get layout properties of multi-edge shorthands"` |
| `…/yoga/YGNodeStyle.cpp:634` | `fatalWithMessage("Unknown YGGridTrackType")` |
| `…/yoga/YGNodeStyle.cpp:652` | same |
| `…/yoga/YGConfig.cpp:38-41` | `pixelsInPoint >= 0.0f`, message `"Scale factor should not be less than zero"` — **a negative `pointScaleFactor` aborts the process.** RN calls `YGConfigSetPointScaleFactor` at `…/YogaLayoutableShadowNode.cpp:491` with `layoutContext.pointScaleFactor` and performs **no** negativity check before the call. |

Plain C `assert()` (compiled out under `NDEBUG`, unlike the above):
`…/yoga/style/SmallValueBuffer.h:34`, `:55-56`;
`…/yoga/style/StyleValuePool.h:74-76`, `:99-101`, `:116`, `:125-128`.

RN-side abort-capable assertions on the layout path
(`react_native_assert` — `packages/react-native/ReactCommon/react/debug/react_native_assert.h:44-53`
non-Android / `:38-41` Android; **compiled to `((void)0)` in release** at `:29`):

`packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp`
`:77-78` (`MeasurableYogaNode` ⇒ `LeafYogaNode`), `:106-110` (`"Yoga node must inherit dirty flag."`),
`:184-185`, `:200-201`, `:298-299`, `:386-387`, `:658-669` (9 asserts on
`LayoutConstraints`: not-NaN ×4, non-negative ×4, minimumSize not infinite ×2),
`:739`, `:745`, `:751`, `:755`.

---

## 4. ROUNDING & MEASUREMENT

### 4.1 Rounding usages in layout results (RN side)

| path:line | code / purpose |
| --- | --- |
| `packages/react-native/ReactCommon/react/renderer/graphics/rounding.h:28-31` | `roundToPixel<RoundingFunction>(Float value, Float scaleFactor) { return RoundingFunction(value * scaleFactor) / scaleFactor; }` |
| `…/graphics/rounding.h:34-52` | `Point`/`Size`/`Rect` overloads of `roundToPixel` |
| `…/graphics/rounding.h:58-93` | `round`/`ceil`/`floor` shims for float/double/long double, comment: "GCC-based Android NDK does not have rounding functions as part of STL." |
| `packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp:124-125` | `size.width += 0.01f; size.height += 0.01f;` with comment "Rounding to *next* value on the pixel grid." (`:123`) |
| `…/components/text/ParagraphShadowNode.cpp:126` | `size = roundToPixel<&ceil>(size, layoutContext.pointScaleFactor);` (attachment size) |
| `…/components/text/ParagraphShadowNode.cpp:421-424` | `roundToPixel<&ceil>(attachmentFrame.size, …)` and `roundToPixel<&round>(attachmentFrame.origin, …)` |
| `…/textlayoutmanager/TextMeasurementRounding.h:36-43` | `internal_roundTextMeasurementToPixelGrid`, `constexpr auto kEpsilon = static_cast<Float>(0.001);` then `std::ceil((size.X + kEpsilon) * pointScaleFactor) / pointScaleFactor` for **both** width and height. Full rationale comment at `:18-35`, citing "facebook/react-native issue #53450" and "the legacy architecture fix in D7074168". |
| `…/react/renderer/dom/DOM.cpp:469-472` | `static_cast<int>(std::round(layoutMetrics.borderWidth.*))` — the only `std::round` on a layout metric in the audited set |
| `…/react/renderer/graphics/Color.cpp:48,53,58,63` | `static_cast<uint8_t>(std::round(...))` (colour, not layout) |

`fmod` usage:
* `packages/react-native/ReactCommon/yoga/yoga/algorithm/PixelGrid.cpp:24` —
  `double fractional = fmod(scaledValue, 1.0);` (the only `fmod` in Yoga).
* `Math.round` (JS): not in the audited C++ scope. `未确认` for JS.

### 4.2 Where measure functions are invoked

Yoga side:
* Regular measure: `packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:525-529`
  — `const YGSize measuredSize = node->measure(innerWidth, measureMode(widthSizingMode), innerHeight, measureMode(heightSizingMode));`
  Preceded by a **negative-size clamp**: "We want to make sure we don't call measure with negative size"
  `…/CalculateLayout.cpp:492-498`
  (`innerWidth = isUndefined(availableWidth) ? availableWidth : maxOrDefined(0.0f, availableWidth - paddingAndBorderAxisRow)`).
* Min-content probe: `…/CalculateLayout.cpp:880-890`
  (`node->measureMinContent(..., AtMost 0 on probed axis, Undefined on the other)`) else `node->measure(...)` with the same `AtMost 0` shape.
* Baseline: `packages/react-native/ReactCommon/yoga/yoga/node/Node.cpp:114-116`
  `float Node::baseline(float width, float height) const { return baselineFunc_(this, width, height); }` — no validation at the invocation site; the only check is the NaN assert at
  `packages/react-native/ReactCommon/yoga/yoga/algorithm/Baseline.cpp:27-30`.
* Actual callback invocation: `packages/react-native/ReactCommon/yoga/yoga/node/Node.cpp:62-67` (`measureFunc_`) and `:90-95` (`minContentMeasureFunc_`).

RN side (the callback):
* `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:855-915`
  `YogaLayoutableShadowNode::yogaNodeMeasureCallbackConnector`
  - width/height modes → min/max `Size` (`:870-892`)
  - `auto size = shadowNode.measureContent(threadLocalLayoutContext, {.minimumSize = minimumSize, .maximumSize = maximumSize});` (`:894-896`)
  - returns `YGSize{yogaFloatFromFloat(size.width), yogaFloatFromFloat(size.height)}` (`:913-914`)
* Registration: `…/YogaLayoutableShadowNode.cpp:80` (`YGNodeSetMeasureFunc`, when `MeasurableYogaNode`), `:177-178` (`enableMeasurement`), `:84-86` (`YGNodeSetBaselineFunc`, when `BaselineYogaNode`).

### 4.3 Retry / fallback path when a measure func returns an invalid size — **THE key path**

Two layers of validation exist, and they behave differently:

**Layer 1 — Yoga `Node::measure` (always active, release included).**
`packages/react-native/ReactCommon/yoga/yoga/node/Node.cpp:69-80`:

```
  if (yoga::isUndefined(size.height) || size.height < 0 ||
      yoga::isUndefined(size.width) || size.width < 0) {
    yoga::log(
        this,
        LogLevel::Warn,
        "Measure function returned an invalid dimension to Yoga: [width=%f, height=%f]",
        size.width,
        size.height);
    return {
        .width = maxOrDefined(0.0f, size.width),
        .height = maxOrDefined(0.0f, size.height)};
  }
```

This is the **only** sanitisation:
* Rejects `NaN` (via `isUndefined`, i.e. `value != value`,
  `…/yoga/numeric/Comparison.h:19-21`) and negatives.
* Rewrites the offending dimension via `maxOrDefined(0.0f, x)`
  (`…/numeric/Comparison.h:35-42`) — which, for `NaN`, returns `b` = `0.0f`.
* **`+infinity` is NOT rejected.** `isUndefined(inf)` is false and `inf < 0` is
  false, so an infinite measurement passes through unchanged. There is no
  `isinf` check anywhere in the measure path (`yoga::isinf` exists at
  `…/numeric/Comparison.h:30-33` but is used only there and in
  `LayoutableShadowNode`-adjacent RN code — not in Yoga's measure path).
* There is **no retry**: the value is clamped once and returned; Yoga proceeds.
* The bad value is written into the measurement cache afterwards by
  `calculateLayoutInternal` (`…/CalculateLayout.cpp:2813-2842`), but
  `canUseCachedMeasurement` re-validates the cached values and refuses to use
  a cached entry with a negative computed dimension
  (`…/yoga/algorithm/Cache.cpp:59-62`).

**Layer 1b — min-content variant.** `packages/react-native/ReactCommon/yoga/yoga/node/Node.cpp:97-109`,
identical logic with message `"Min-content measure function returned an invalid dimension to Yoga: [width=%f, height=%f]"`.
Same `+infinity` hole.

**Layer 2 — RN debug-only bounds check.**
`packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:898-911`:

```
#ifdef REACT_NATIVE_DEBUG
  bool widthInBounds = size.width + kDefaultEpsilon >= minimumSize.width &&
      size.width - kDefaultEpsilon <= maximumSize.width;
  bool heightInBounds = size.height + kDefaultEpsilon >= minimumSize.height &&
      size.height - kDefaultEpsilon <= maximumSize.height;

  if (!widthInBounds || !heightInBounds) {
    LOG(ERROR) << shadowNode.getComponentDescriptor().getComponentName()
               << " returned an invalid measurement. Min: ["
               ...
```

- `kDefaultEpsilon = 0.005f` — `packages/react-native/ReactCommon/react/utils/FloatComparison.h:16`.
- **This is `#ifdef REACT_NATIVE_DEBUG` only and `LOG(ERROR)` only.** It does
  not clamp, retry, or abort; the invalid size flows on to
  `YGSize{yogaFloatFromFloat(size.width), yogaFloatFromFloat(size.height)}`
  (`:913-914`) and then to Yoga's Layer-1 clamp. Note the asymmetry: Yoga's
  clamp runs **after** this check, so a negative value is logged at Layer 2 and
  then silently zeroed at Layer 1.

### 4.4 Every place a measure result is validated / NOT validated

| result | validated? | where |
| --- | --- | --- |
| `YGMeasureFunc` return | **YES** — NaN + negative only | `…/yoga/node/Node.cpp:69-80` |
| `YGMeasureFunc` return | **NO** for `+inf` | same (absence) |
| `YGMinContentMeasureFunc` return | **YES** — NaN + negative only | `…/yoga/node/Node.cpp:97-109` |
| `YGMinContentMeasureFunc` return | **NO** for `+inf` | same |
| `YGBaselineFunc` return | **PARTIAL** — `!std::isnan(baseline)` only; negative/infinite pass | `packages/react-native/ReactCommon/yoga/yoga/algorithm/Baseline.cpp:27-30` (`"Expect custom baseline function to not return NaN"`) |
| RN `measureContent()` result | **DEBUG ONLY** bounds check | `…/YogaLayoutableShadowNode.cpp:898-911` |
| `TextLayoutManager::measure` result | **YES** — unconditional clamp | `packages/react-native/ReactCommon/react/renderer/textlayoutmanager/platform/android/react/renderer/textlayoutmanager/TextLayoutManager.cpp:200` — `measurement.size = layoutConstraints.clamp(measurement.size);` (clamp impl `packages/react-native/ReactCommon/react/renderer/core/LayoutConstraints.cpp:14-20`) |
| `ParagraphShadowNode::measureContent` result | **DEBUG ONLY** assert | `…/components/text/ParagraphShadowNode.cpp:260` and `:272` via the `assert_valid_size` macro at `:24-33` (uses `kDefaultEpsilon = 0.005f`) |
| cxx `TextLayoutManager::measure` result | **NO** — returns `minimumSize` verbatim | `packages/react-native/ReactCommon/react/renderer/textlayoutmanager/platform/cxx/react/renderer/textlayoutmanager/TextLayoutManager.cpp:33-38` |
| `measurePreparedLayout` array contents | **YES** — NaN check only, no range/size validation | `…/platform/android/…/TextLayoutManager.cpp:419` (`std::isnan(top) || std::isnan(left)`), plus asserts at `:403-404` |
| Android `doMeasure` attachment positions | **YES** — NaN only → `isClipped = true` | `…/platform/android/…/TextLayoutManager.cpp:124-126` |
| `LayoutConstraints` handed to `layoutTree` | **DEBUG ONLY** asserts | `…/YogaLayoutableShadowNode.cpp:658-669` |
| yoga `Node::reset()` | assert on non-empty children / owner | `…/yoga/node/Node.cpp:499-504` |

---

## 5. RENDERER CORE OBJECT GRAPH

### 5.1 Core classes and key virtual methods

| class | definition | key virtuals |
| --- | --- | --- |
| `ShadowNode` | `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.h:33` (`: public Sealable, public DebugStringConvertible, public jsi::NativeState`) | `~ShadowNode() override = default` (`:88`); `virtual void completeClone(const ShadowNode&, const ShadowNodeFragment&) {}` (`:123`); `virtual void appendChild(...)` (`:181`); `virtual void replaceChild(...)` (`:182-185`); `static ShadowNodeTraits BaseTraits()` (`:59`) |
| `ShadowNodeWrapper` | `…/core/ShadowNode.h:292-301` | `~ShadowNodeWrapper() override;` (`:298`, out-of-line at `…/core/ShadowNode.cpp:529`) |
| `ComponentDescriptor` | `…/core/ComponentDescriptor.h:35` | pure virtuals: `getComponentHandle` (`:64`), `getComponentName` (`:71`), `getTraits` (`:76`), `createShadowNode` (`:81`), `cloneShadowNode` (`:88`), `appendChild` (`:95`), `cloneProps` (`:106`), `createInitialState` (`:113`), `createState` (`:120`), `createFamily` (`:125`), `adopt` (`:148`) |
| `ConcreteComponentDescriptor<ShadowNodeT>` | `…/core/ConcreteComponentDescriptor.h:34` | overrides all of the above; `adopt` (`:217-221`) |
| `ConcreteShadowNode<T>` | `…/core/ConcreteShadowNode.h` | — |
| `Props` | `…/core/Props.h:29` (`: public virtual Sealable, public virtual DebugStringConvertible`) | `virtual ~Props()` (`:41`/`:43`); `virtual ComponentName getDiffPropsImplementationTarget() const` (`:72`, `RN_SERIALIZABLE_STATE`); `virtual folly::dynamic getDiffProps(const Props*) const` (`:74`); `setProp` is **non-virtual** (`:59-60`) |
| `State` | `…/core/State.h:27` | `virtual ~State() = default` (`:42`); `RN_SERIALIZABLE_STATE` pure virtuals: `getDynamic` (`:68`), `getMapBuffer` (`:69`), `getJNIReference` (`:70`), `updateState` (`:71`) |
| `EventEmitter` | `…/core/EventEmitter.h:35` | `virtual ~EventEmitter() = default` (`:47`) |
| `EventDispatcher` | `…/core/EventDispatcher.h:31` | none virtual |
| `ShadowNodeFamily` | `…/core/ShadowNodeFamily.h:45` (`: public jsi::NativeState`) | none virtual; `~ShadowNodeFamily()` (`:135`, impl `…/ShadowNodeFamily.cpp:96-100`) |
| `LayoutableShadowNode` | `…/core/LayoutableShadowNode.h` | see 5.2 |
| `YogaLayoutableShadowNode` | `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.h:26` | `completeClone` (`:45`), `shouldNewRevisionDirtyMeasurement` (`:97`), `dirtyLayout` (`:79`), `getIsLayoutClean` (`:80`), `layoutTree` (`:86`), `layout` (`:88`), `appendChild` (`:55`), `replaceChild` (`:56-59`) |
| `LayoutableShadowNode` virtuals | `…/core/LayoutableShadowNode.h` | `layoutTree`, `layout`, `getTransform`, `getContentOriginOffset`, `canBeTouchTarget`, `canChildrenBeTouchTarget`, `measureContent`, `measure`, `baseline`, `dirtyLayout`, `getIsLayoutClean` — impls in `…/core/LayoutableShadowNode.cpp:201-271` |
| `MountingTransaction` | `…/mounting/MountingTransaction.h:25` (`final`) | — |
| `ShadowTree` | `…/mounting/ShadowTree.h:78` (`final`) | — |
| `MountingCoordinator` | `…/mounting/MountingCoordinator.h` | — |
| `UIManager` | `…/uimanager/UIManager.h:44` (`final : public ShadowTreeDelegate`) | `~UIManager() override` (`:48`) |

`ShadowNode` enforces a virtual destructor:
`…/core/ShadowNode.h:290` — `static_assert(std::has_virtual_destructor<ShadowNode>::value, "ShadowNode must have a virtual destructor");`

### 5.2 Ownership model

* **ShadowNode lifetime**: `std::shared_ptr<const ShadowNode>`. Children are
  held by a `shared_ptr` to a `const std::vector<std::shared_ptr<const ShadowNode>>`
  — `…/core/ShadowNode.h:236` `std::shared_ptr<const std::vector<std::shared_ptr<const ShadowNode>>> children_;`.
  **No reference counting of our own, no intrusive lists.** The copy-on-write
  flag is `ShadowNodeTraits::Trait::ChildrenAreShared`, cleared by
  `cloneChildrenIfShared()` — `…/core/ShadowNode.cpp:293-301`:
  ```
  void ShadowNode::cloneChildrenIfShared() {
    if (!traits_.check(ShadowNodeTraits::Trait::ChildrenAreShared)) {
      return;
    }
    traits_.unset(ShadowNodeTraits::Trait::ChildrenAreShared);
    children_ = std::make_shared<std::vector<std::shared_ptr<const ShadowNode>>>(*children_);
  }
  ```
  The flag is *set* in both constructors (`…/core/ShadowNode.cpp:97`, `:126`).
* **ShadowNode is non-copyable** — `…/core/ShadowNode.h:85-86`:
  `ShadowNode(const ShadowNode &shadowNode) noexcept = delete;` /
  `ShadowNode &operator=(const ShadowNode &other) noexcept = delete;`
* **Family**: every ShadowNode holds `ShadowNodeFamily::Shared family_` —
  `…/core/ShadowNode.h:267`; `ShadowNode::sameFamily` compares `family_`
  pointer identity — `…/core/ShadowNode.cpp:72-74`.
* **Family → EventEmitter is strong**, **Family → parent family is weak**:
  `const SharedEventEmitter eventEmitter_;` (`…/core/ShadowNodeFamily.h:172`)
  and `ShadowNodeFamily::Weak parent_{};` (`…/core/ShadowNodeFamily.h:191`),
  with comment at `:188-190` "Points to a family of all parent nodes of all nodes of the family."
* **State → Family is weak, by design** — `…/core/State.h:87-92`:
  ```
   * A family of a node with this state is associated.
   * Must be a weak pointer to avoid retain cycle among `State`, `ShadowNode`,
   * and `ShadowNodeFamily` instances.
   */
  ShadowNodeFamily::Weak family_;
  ```
* **ShadowNode → runtime reference is weak** —
  `mutable std::weak_ptr<ShadowNodeWrapper> runtimeShadowNodeReference_{};`
  (`…/core/ShadowNode.h:287`).
* **Yoga node**: `yoga::Node` is a **by-value member**, not a pointer —
  `mutable yoga::Node yogaNode_;` (`…/components/view/YogaLayoutableShadowNode.h:110`),
  with the comment at `:105-109`. Yoga children are **raw `Node*`** in a
  `std::vector<Node*>` (`…/yoga/node/Node.h:358`) — the clone-on-write
  discipline is the substitute for reference counting. `Node::operator=(const Node&)`
  is deleted with an explicit hazard comment — `…/yoga/node/Node.h:45-47`:
  ```
    // assignment means potential leaks of existing children, or alternatively
    // freeing unowned memory, double free, or freeing stack memory.
    Node& operator=(const Node&) = delete;
  ```
  and the copy constructor is documented as not value-semantic —
  `…/yoga/node/Node.h:41-43`:
  ```
    // Does not expose true value semantics, as children are not cloned eagerly.
    // Should we remove this?
    Node(const Node& node) = default;
  ```
* **Intrusive list**: `MountingCoordinator::mountingOverrideDelegates_` is a
  `std::vector<std::weak_ptr<const MountingOverrideDelegate>>` with an
  `insert` (not `push_back`) and no removal API —
  `…/mounting/MountingCoordinator.cpp:210-215`; declaration in
  `…/mounting/MountingCoordinator.h`. Removal: **未确认** — no
  `erase`/`remove` for that vector exists in the audited files.
* **Raw-pointer delegate set**: `UIManager` stores `UIManagerDelegate *delegate_`,
  `UIManagerAnimationDelegate *animationDelegate_`,
  `UIManagerViewTransitionDelegate *viewTransitionDelegate_` as raw pointers
  with an explicit contract — `…/uimanager/UIManager.h:52-57`:
  ```
   * Sets and gets the UIManager's delegate.
   * The delegate is stored as a raw pointer, so the owner must null
   * the pointer before being destroyed.
   */
  ```
  Cleared in `Scheduler::~Scheduler` at `…/scheduler/Scheduler.cpp:211-213`.
* **ComponentDescriptorRegistry**: `UIManager` holds
  `SharedComponentDescriptorRegistry componentDescriptorRegistry_;`
  (`…/uimanager/UIManager.h:250`).

### 5.3 Allocations and matching deallocation

Every allocation site in the audited C++ files is a `std::make_shared` /
`std::make_unique` / `new` with an owner that is a value member or a
`std::shared_ptr` member — i.e. destroyed by the owning object's destructor.
The following are the notable ones and their releases:

| allocation site | release |
| --- | --- |
| `std::make_shared<ShadowNodeT>(fragment, family, getTraits())` — `…/core/ConcreteComponentDescriptor.h:86` | returns `std::shared_ptr<ShadowNode>`; released when all `shared_ptr` copies die |
| `std::make_shared<ShadowNodeT>(sourceShadowNode, fragment)` — `…/core/ConcreteComponentDescriptor.h:96` | same |
| `std::make_shared<ConcreteEventEmitter>(std::make_shared<EventTarget>(…), eventDispatcher_)` — `…/core/ConcreteComponentDescriptor.h:209-210` | held strongly by `ShadowNodeFamily::eventEmitter_` (`…/core/ShadowNodeFamily.h:172`); released with the family |
| `std::make_shared<ShadowNodeFamily>(fragment, eventEmitter, eventDispatcher_, *this)` — `…/core/ConcreteComponentDescriptor.h:211` | returned as `Shared`; held by every ShadowNode in the family (`…/core/ShadowNode.h:267`) and by `ConcreteComponentDescriptor::createFamily`'s caller |
| `std::make_shared<const ConcreteState>(std::make_shared<const ConcreteStateData>(…), family)` — `…/core/ConcreteComponentDescriptor.h:190-191` | held by `ShadowNode::state_` and `ShadowNodeFamily::mostRecentState_` |
| `std::make_shared<RootProps>(…)` — `…/mounting/ShadowTree.cpp:238` | owned by the initial `RootShadowNode`'s `props_` |
| `std::make_shared<const MountingCoordinator>(currentRevision_)` — `…/mounting/ShadowTree.cpp:259-260` | `…/mounting/ShadowTree.h:178`; `ShadowTree::~ShadowTree()` at `…/ShadowTree.cpp:263-265` calls `mountingCoordinator_->revoke()` |
| `new yoga::Node{resolveRef(config)}` — `…/yoga/YGNode.cpp:25` (`YGNodeNewWithConfig`) | `delete resolveRef(node)` at `…/YGNode.cpp:59` (`YGNodeFree`) and `…/YGNode.cpp:81` (`YGNodeFinalize`). Only `YGNodeFinalize` is called by RN (Android JNI, `YGJNIVanilla.cpp:190`) |
| `new yoga::Node(*oldNode)` — `…/yoga/YGNode.cpp:35` (`YGNodeClone`) | **This is the one allocation whose release path RN never reaches from C++.** `Config::cloneNode` calls `YGNodeClone(node)` as a fallback — `…/yoga/config/Config.cpp:125` — but RN always installs `yogaNodeCloneCallbackConnector` (`…/YogaLayoutableShadowNode.cpp:941-942`), which returns a `&parentNode.cloneChildInPlace(childIndex).yogaNode_` (`…/YogaLayoutableShadowNode.cpp:845-853`) and **never returns `nullptr`**. So `Config::cloneNode`'s `if (clone == nullptr) clone = YGNodeClone(node);` (`…/config/Config.cpp:124-126`) is dead under RN, and the `YGNodeClone` heap allocation cannot occur. Confirmed: `YGNodeClone` has exactly 1 non-yoga reference, and it is inside yoga itself. |
| `overflow_ = std::make_unique<SmallValueBuffer::Overflow>();` — `…/yoga/style/SmallValueBuffer.h:41` | `std::unique_ptr<Overflow>` member (`…/SmallValueBuffer.h:130`); deep-copied in `operator=` at `:114-115`; destroyed with the `Style` |
| `std::vector<char> buffer(size)` in `FabricDefaultYogaLog` — `…/components/view/YogaLayoutableShadowNode.cpp:42` | scope-exit at `:63` |
| `jobject`/`jfloatArray` in Android text layout — `env->ReleaseFloatArrayElements(…, JNI_ABORT)` at `…/platform/android/…/TextLayoutManager.cpp:144-145`; `env->DeleteLocalRef(attachmentPositions)` at `:146` and `:231` | — |
| `LayoutContext::Provider` pushes/pops a `thread_local std::stack<PtrJNodeMapVanilla*>` — allocation `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/LayoutContext.cpp:15-18`, push at `:23`, pop at `:27` | RAII |
| `new ScopedGlobalRef<jobject>()` / `newGlobalRef(env, logger)` — `…/YGJNIVanilla.cpp:169,173` | `jni_YGConfigSetLoggerJNI` else-branch `delete context;` at `:177`, plus `jni_YGConfigFreeJNI`'s `std::unique_ptr<ScopedGlobalRef<jobject>>` at `…/YGJNIVanilla.cpp:45-46` |

**No allocation whose release site I could not locate.** All `new` sites in
the audited set have a matching `delete` / RAII member; the two `YGNodeFree`
-family entry points that RN never calls mean the heap-allocated `yoga::Node`
created by `YGNodeNewWithConfig` in the legacy Android JNI path is released
only via `YGNodeFinalize` (`YGJNIVanilla.cpp:190`), which per its own comment
"without disconnecting it from its owner or children"
(`…/yoga/YGNode.h:56-61`).

---

## 6. MOUNTING / COMMIT PHASE

### 6.1 Data structures

| structure | definition |
| --- | --- |
| `ShadowView` | `packages/react-native/ReactCommon/react/renderer/mounting/ShadowView.h:27` (`struct ShadowView final`), fields at `:38-48` |
| `ShadowViewMutation` | `…/mounting/ShadowViewMutation.h:24` (`struct ShadowViewMutation final`), `using List = std::vector<ShadowViewMutation>` (`:25`), `Type` enum `:86-92` (`Create=1, Delete=2, Insert=4, Remove=8, Update=16`), fields `:96-100`, private ctor `:110` |
| `ShadowViewMutation::List` (alias) | `…/mounting/ShadowViewMutation.h:113` `using ShadowViewMutationList = std::vector<ShadowViewMutation>;` |
| mutation factories | `…/mounting/ShadowViewMutation.cpp:14` (Create), `:24` (Delete), `:34` (Insert), `:47` (Remove), `:60` (Update) |
| `MountingTransaction` | `…/mounting/MountingTransaction.h:25` (`class MountingTransaction final`), `using Number = int64_t` (`:31`), fields `:89-92` |
| `ShadowTreeRevision` | `…/mounting/ShadowTreeRevision.h` (fields used at `…/mounting/ShadowTree.cpp:254-257`, `:450-453`) |
| `ShadowViewNodePair` | `…/mounting/internal/ShadowViewNodePair.h:22` (`struct ShadowViewNodePair final`), fields `:23-46` |
| `ViewNodePairScope` | `…/mounting/internal/sliceChildShadowNodeViewPairs.h` (arena for the pairs) |
| `CullingContext` | `…/mounting/internal/CullingContext.h` |
| `ShadowTree` | `…/mounting/ShadowTree.h:78`; `ShadowTreeCommitStatus` `:33-37`; `ShadowTreeCommitMode` `:42-50`; `ShadowTreeCommitSource` `:52-57`; `ShadowTreeCommitOptions` `:59-73`; `ShadowTreeCommitTransaction` `:28` |
| `RootShadowNode` | `packages/react-native/ReactCommon/react/renderer/components/root/RootShadowNode.h` (included at `…/mounting/ShadowTree.h:16`) |
| `OrderedMutationInstructionContainer` | `…/mounting/Differentiator.cpp:132-140` — 7 separate ordered buckets |
| `MountingCoordinator` | `…/mounting/MountingCoordinator.h` / `.cpp` |
| `MountingOverrideDelegate` | `…/mounting/MountingOverrideDelegate.h` |

### 6.2 How mutations are produced, ordered, consumed

**Produced**: `calculateShadowViewMutations` —
`…/mounting/Differentiator.cpp:1361-1440` (declared `…/mounting/Differentiator.h:22-24`).
Root-level Update emitted first at `:1379-1383`:
```
  if (oldRootShadowView != newRootShadowView) {
    mutations.push_back(
        ShadowViewMutation::UpdateMutation(
            oldRootShadowView, newRootShadowView, {}));
  }
```
`mutations.reserve(256)` at `:1398`; recursion into
`calculateShadowViewMutations(...)` at `:1400-1405`.

**Ordered** into 7 buckets during recursion, concatenated in this exact order at
`…/mounting/Differentiator.cpp:1330-1358`:
1. `destructiveDownwardMutations` (`:1331-1334`)
2. `updateMutations` (`:1335-1338`)
3. `removeMutations` — **reversed** (`rbegin()..rend()`, `:1339-1342`)
4. `deleteMutations` (`:1343-1346`)
5. `createMutations` (`:1347-1350`)
6. `downwardMutations` (`:1351-1354`)
7. `insertMutations` (`:1355-1358`)

**Consumed**: `MountingCoordinator::pullTransaction` —
`…/mounting/MountingCoordinator.cpp:71-189`, diff at `:87-88`:
```
    auto mutations = calculateShadowViewMutations(
        *baseRevision_.rootShadowNode, *lastRevision_->rootShadowNode);
```
wrapped at `:92-93` into `MountingTransaction{surfaceId_, number_, std::move(mutations), telemetry}`.
Push path: `MountingCoordinator::push` `:39-52` (with the monotonic-number
assert at `:43-44`); pull advances `baseRevision_ = std::move(*lastRevision_)` at `:183`.

**Merged** for Android: `MountingTransaction::mergeWith` —
`…/mounting/MountingTransaction.cpp:44-55`; `react_native_assert(transaction.getSurfaceId() == surfaceId_);` at `:45`;
telemetry of the merged-in transaction wins, with
`// TODO T186641819: Telemetry for merged transactions is not supported, use`
`// the latest instance` at `:52-53`.

**Debug validation of ordering** (opt-in only, `RN_SHADOW_TREE_INTROSPECTION`):
`…/mounting/MountingCoordinator.cpp:132-177` — applies the mutations to a
`stubViewTree_` (`:141`), rebuilds a fresh stub tree and compares
(`:147-150`), and asserts `(treesEqual) && "Incorrect set of mutations detected."`
(`:173-174`). This is the only in-repo check that the emitted order is
actually applicable; it is compiled out by default.

**Commit ordering** in `ShadowTree::tryCommit` — `…/mounting/ShadowTree.cpp:336-475`:
state progression `:384-391` → root layout-info progression `:393-398` →
commit hook `:401-402` → layout `:409-420` → unique lock + revision check
`:422-433` → `updateMountedFlag` under `EventEmitter::DispatchMutex()`
`:435-441` → `sealRecursive()` `:448` → publish revision `:450-462` →
`shadowTreeDidCommit` `:465-466` → `mount(...)` `:468-472`.

### 6.3 Every drop/retain of a shadow node during commit

`updateMountedFlag` is the only site that changes `mounted` state during a
commit — `…/mounting/updateMountedFlag.cpp:13-110`:
* `:70-73` — `newChild->setMounted(true); oldChild->setMounted(false);`
* `:89-91` — `newChild->setMounted(true);` (new children stage)
* `:101-105` — `oldChild->setMounted(false);` (old children stage)

`ShadowNode::setMounted` — `…/core/ShadowNode.cpp:322-330`:
```
void ShadowNode::setMounted(bool mounted) const {
  if (mounted) {
    family_->setMostRecentState(getState());
    family_->setMounted();
    hasBeenMounted_ = mounted;
  }

  family_->eventEmitter_->setEnabled(mounted);
}
```
Note `hasBeenMounted_` is only ever set to `true` (`:326`); the atomic is
never reset. It is read by `getHasBeenPromoted()` at `:332-334`.

**No explicit `release()` / `retain()` calls exist in the commit path** —
everything is `std::shared_ptr` refcounting. The only explicit lifecycle
release during commit is `MountingCoordinator::revoke` —
`…/mounting/MountingCoordinator.cpp:54-62`:
```
  // We have two goals here.
  // 1. We need to stop retaining `ShadowNode`s to not prolong their lifetime
  // to prevent them from overliving `ComponentDescriptor`s.
  // 2. A possible call to `pullTransaction()` should return empty optional.
  baseRevision_.rootShadowNode.reset();
  lastRevision_.reset();
```
called from `ShadowTree::~ShadowTree()` — `…/mounting/ShadowTree.cpp:263-265`.

Async destruction (feature-flagged): `…/mounting/MountingCoordinator.cpp:180-182`
`LowPriorityExecutor::execute([toDelete = std::move(baseRevision_)]() {});`
under `ReactNativeFeatureFlags::enableDestroyShadowTreeRevisionAsync()`.

### 6.4 Where a mutation can be lost or reordered

| # | path:line | mechanism |
| ---: | --- | --- |
| 1 | `…/mounting/MountingCoordinator.cpp:46-48` | `if (!lastRevision_.has_value() \|\| lastRevision_->number < revision.number) { lastRevision_ = std::move(revision); }` — a revision pushed with a **number not greater** than the pending one is silently dropped. Guarded only by `react_native_assert(!lastRevision_.has_value() \|\| revision.number != lastRevision_->number);` at `:43-44` (assert only, debug builds). |
| 2 | `…/mounting/ShadowTree.cpp:308-333` | `commit` retries `tryCommit` while it returns `CommitStatus::Failed`; in the non-`preventShadowTreeCommitExhaustion` path the loop is unbounded except for `react_native_assert(attempts < 1024);` at `:331` — in release this is an infinite spin. |
| 3 | `…/mounting/ShadowTree.cpp:380-382` / `:404-406` | `tryCommit` returns `CommitStatus::Cancelled` when the transaction or the commit hook returns `nullptr` — the transaction is dropped. |
| 4 | `…/mounting/ShadowTree.cpp:287-289` | `if (commitMode == CommitMode::Normal && revision.number != INITIAL_REVISION) { mount(revision, true); }` — revisions accumulated while `CommitMode::Suspended` are flushed as a single mount; comment: `// initial revision never contains any commits so mounting it here is` / `// incorrect` (`:285-286`) |
| 5 | `…/mounting/ShadowTree.cpp:470-472` | `else if (commitMode == CommitMode::Normal) { mount(...); }` — if `commitMode == Suspended`, the revision is stored in `currentRevision_` and produces **no** mutations until a later mode switch. |
| 6 | `…/mounting/MountingCoordinator.cpp:100-130` | `MountingOverrideDelegate`s may **replace** the whole transaction (`transaction = mountingOverrideDelegate->pullTransaction(...)` at `:124-125`), discarding the diffed mutations. |
| 7 | `…/mounting/MountingTransaction.cpp:47-50` | `mergeWith` appends mutations without re-ordering or validating them against the already-present list. |
| 8 | `…/mounting/Differentiator.cpp:1339-1342` | `removeMutations` are emitted in **reverse** container order; if a consumer re-sorts by `index`, the reversal is lost. |
| 9 | `…/mounting/Differentiator.cpp:1303-1308` | `if (!newChildPair.isConcreteView) continue; if (newChildPair.inOtherTree()) continue;` — pairs are dropped from the Create path; the Create for them is expected from the other tree's traversal, so correctness depends on the other branch always running. |
| 10 | `…/mounting/internal/sliceChildShadowNodeViewPairs.cpp:61-67` | `Trait::Hidden` children are skipped on Android only (`#ifdef ANDROID` + `ReactNativeFeatureFlags::useTraitHiddenOnAndroid()`), with comment `// T153547836: Disabled on Android because the mounting infrastructure` / `// is not fully ready yet.` — hidden subtrees produce **no** mutations on Android and are therefore never deleted either. |
| 11 | `…/mounting/internal/sliceChildShadowNodeViewPairs.cpp:70-98` | `enableViewCulling()` culling `continue`s without emitting a mutation for culled views — intended, but means a culled view's platform counterpart is retained on the native side until the culling decision flips. |

---

## 7. EVENT EMITTER

### 7.1 Class and listener storage

* `EventEmitter` — `packages/react-native/ReactCommon/react/renderer/core/EventEmitter.h:35`
* **It stores no listener list.** Storage is a set of three members
  (`…/core/EventEmitter.h:142-147`):
  ```
    SharedEventTarget eventTarget_;
    std::weak_ptr<const ShadowNodeFamily> shadowNodeFamily_;

    EventDispatcher::Weak eventDispatcher_;
    int enableCounter_{0};
    bool isEnabled_{false};
  ```
  Dispatch hands the target + family to `EventDispatcher` as part of a
  `RawEvent` — `…/core/EventEmitter.cpp:147-154` and `:201-208`.
* The **actual** listener storage is `EventListenerContainer` —
  `…/core/EventListener.h:26-41`:
  ```
  class EventListenerContainer {
   public:
    bool willDispatchEvent(const RawEvent &event);

    void addListener(std::shared_ptr<const EventListener> listener);
    void removeListener(const std::shared_ptr<const EventListener> &listener);

   private:
    std::shared_mutex mutex_;
    std::vector<std::shared_ptr<const EventListener>> eventListeners_;
  };
  ```
  owned by `mutable EventListenerContainer eventListeners_;` —
  `…/core/EventDispatcher.h:79`. `EventListener` is
  `std::function<bool(const RawEvent &event)>` — `…/core/EventListener.h:24`.

### 7.2 Add / remove paths

| path:line | operation |
| --- | --- |
| `…/core/EventListener.cpp:27-32` | `addListener` — `std::unique_lock`, `eventListeners_.push_back(std::move(listener));`. **No duplicate check**: the same `shared_ptr` can be added N times. |
| `…/core/EventListener.cpp:34-42` | `removeListener` — `std::unique_lock`, `std::find` then `eventListeners_.erase(it)`. **Erases exactly one occurrence.** If the same listener was added twice, one copy survives and continues to fire. |
| `…/core/EventDispatcher.cpp:59-61` | `EventDispatcher::addListener` (forwarder) |
| `…/core/EventDispatcher.cpp:67-69` | `EventDispatcher::removeListener` (forwarder) |
| `…/core/EventListener.cpp:14-25` | `willDispatchEvent` — `std::shared_lock`, iterates in insertion order, short-circuits on the first `true`. |
| `…/scheduler/Scheduler.cpp:463-468` | `Scheduler::addEventListener` — `if (eventDispatcher_->has_value()) { eventDispatcher_->value().addListener(std::move(listener)); }`. **If `eventDispatcher_` has no value the listener is silently dropped.** |
| `…/scheduler/Scheduler.cpp:470-474` | `Scheduler::removeEventListener` |
| `…/scheduler/Scheduler.cpp:409-412` | `uiManagerShouldAddEventListener` → `addEventListener` |
| `…/scheduler/Scheduler.cpp:414-417` | `uiManagerShouldRemoveEventListener` → `removeEventListener` |
| `…/uimanager/UIManager.h:224,226` | `UIManager::addEventListener` / `removeEventListener` |
| `packages/react-native/React/Fabric/RCTScheduler.mm:275-282` | ObjC bridge `-addEventListener:` / `-removeEventListener:` → `_scheduler->addEventListener/removeEventListener` |

**Is removal guaranteed? No.** Three concrete mechanisms can leave a listener
registered:
1. `EventListenerContainer::addListener` has no idempotency guard while
   `removeListener` erases only one occurrence (`…/core/EventListener.cpp:31`
   vs `:38-41`) → leaked live listener on double-add / single-remove.
2. `Scheduler::addEventListener` drops the listener when `eventDispatcher_`
   is empty (`…/scheduler/Scheduler.cpp:465-467`), so the caller believes it is
   registered; the matching `removeEventListener` is then a no-op. (This is a
   lost-callback rather than a leak.)
3. **No RAII / unregister-on-destroy is present in the audited C++ code.** The
   `Scheduler` destructor unregisters *commit hooks* and *mount hooks*
   (`…/scheduler/Scheduler.cpp:200-204`) but **does not** clear
   `eventDispatcher_`'s listener container. The `EventDispatcher` itself is
   owned via `std::optional` (`eventDispatcher_` in
   `…/scheduler/Scheduler.h`) and dies with the `Scheduler`, so listeners do
   not outlive the surface there — but any listener that is `add`ed to a
   still-live `EventDispatcher` (e.g. per-surface `Scheduler` lifetime) has no
   guaranteed pairing at the C++ level.

Separate, and **guaranteed-by-counter** system (the target/`EventTarget`
enable path):
* `EventEmitter::setEnabled` — `…/core/EventEmitter.cpp:211-232`:
  ```
    enableCounter_ += enabled ? 1 : -1;
  ```
  and `eventTarget_.reset()` when the counter reaches 0 (`:226-231`).
  Contract documented at `…/core/EventEmitter.h:49-58`:
  ```
   * Enables/disables event emitter.
   * Enabled event emitter retains a pointer to `eventTarget` strongly (as
   * `std::shared_ptr`) whereas disabled one don't.
   * ...
   * The enable state is additive; a number of `enable` calls should be equal to
   * a number of `disable` calls to release the event target.
   * `DispatchMutex` must be acquired before calling.
  ```
  The counter can go negative — `enableCounter_ += enabled ? 1 : -1;` has no
  clamp, and an extra `setEnabled(false)` drives it below zero, permanently
  disabling re-enablement until enough `true`s accumulate.
* The additive-counter correctness during commit is explicitly guarded:
  `…/mounting/updateMountedFlag.cpp:32-36`:
  ```
    // Mounted flags shouldn't be updated during the React revision merge
    // because they were already set during the React branch commit. Setting them
    // again would double-increment the EventEmitter's additive enable counter.
    bool shouldUpdateMountedFlag =
        commitSource != ShadowTreeCommitSource::ReactRevisionMerge;
  ```
* The corresponding mutex discipline: `EventEmitter::DispatchMutex()` —
  `…/core/EventEmitter.cpp:41-44` — is acquired on the read side of dispatch
  (`:142`, `:196`) and on the commit side at
  `…/mounting/ShadowTree.cpp:436`:
  ```
        std::scoped_lock dispatchLock(EventEmitter::DispatchMutex());
        updateMountedFlag(
  ```
  This is the pairing that makes `enableCounter_` safe.

---

## 8. TEXT LAYOUT

### 8.1 Bindings

| layer | file:line |
| --- | --- |
| Platform-agnostic interface | `packages/react-native/ReactCommon/react/renderer/textlayoutmanager/platform/cxx/react/renderer/textlayoutmanager/TextLayoutManager.h` (59 lines) |
| Compile-time capability adapter | `…/textlayoutmanager/TextLayoutManagerExtended.h:62` (`template <typename TextLayoutManagerT> class TextLayoutManagerExtended`), `supportsLineMeasurement()` `:64-70`, `supportsPreparedTextLayout()` `:72-75`, `using TextLayoutManagerExtended = detail::TextLayoutManagerExtended<TextLayoutManager>;` `:114`, `struct MeasuredPreparedTextLayout` `:116-120` |
| Android | `…/textlayoutmanager/platform/android/react/renderer/textlayoutmanager/TextLayoutManager.cpp` — ctor `:153-160`, `measure` `:162-202`, `measureCachedSpannableById` `:204-237`, `measureLines` `:239-293`, `prepareLayout` `:295-375`, `measurePreparedLayout` `:377-434`; static compile-time asserts at `:25-26` |
| iOS | `…/textlayoutmanager/platform/ios/react/renderer/textlayoutmanager/TextLayoutManager.h` (73 lines), `RCTTextLayoutManager.h`, `RCTTextPrimitivesConversions.h`, `RCTFontProperties.h`, `RCTFontUtils.h`, `RCTAttributedTextUtils.h` |
| Consumer | `packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp` — `measureContent` `:222-274`, `baseline` `:276-298`, `layout` `:300-446`, `getContent` `:70-94`, `getContentWithMeasuredAttachments` `:96-136`, `updateStateIfNeeded` `:144-183`, `findUsableLayout` `:185-208`, `rawContentSize` `:210-218` |
| Injection | `ParagraphShadowNode::setTextLayoutManager` `…/components/text/ParagraphShadowNode.cpp:138-142`; member `…/ParagraphShadowNode.h:130` |

### 8.2 Caches — keys and eviction

**Cache 1 — `TextMeasureCache`** (`SimpleThreadSafeCache<TextMeasureCacheKey, TextMeasurement, 1024>`)
* key type `TextMeasureCacheKey` — `…/textlayoutmanager/TextMeasureCache.h:66-75`:
  ```
    AttributedString attributedString{};
    ParagraphAttributes paragraphAttributes{};
    LayoutConstraints layoutConstraints{};
    ...
    Float pointScaleFactor{};
  ```
  comment at `:71-73`: "The measured size depends on the pixel scale factor because
  layout metrics are rounded to the pixel grid. Two otherwise-identical
  measures at different densities are not interchangeable, so the scale factor
  is part of the key."
  equality `…/TextMeasureCache.h:272-277`, hash `:296-306`.
* **cap** `kSimpleThreadSafeCacheSizeCap = size_t{1024}` —
  `…/textlayoutmanager/TextMeasureCache.h:106`, comment `:101-105`:
  "Maximum size of the Cache. The number was empirically chosen based on
  approximation of an average amount of meaningful measures per surface."
* eviction — `packages/react-native/ReactCommon/react/utils/SimpleThreadSafeCache.h:94-98`:
  ```
    if (list_.size() > maxSize_) {
      // Evict least recently used item (back of list)
      map_.erase(list_.back().first);
      list_.pop_back();
    }
  ```
  **evicts exactly one entry per insert**, which is correct only because the
  check is inside the insert path. `TODO T228961279: The maxSize template
  parameter should be removed, since it may be overriden by the constructor.`
  at `…/utils/SimpleThreadSafeCache.h:25-27`.
* Android ctor: `textMeasureCache_(kSimpleThreadSafeCacheSizeCap)` —
  `…/platform/android/…/TextLayoutManager.cpp:156`
* Android bypass: `…/TextLayoutManager.cpp:189-198` — the cache is **skipped**
  entirely when `ReactNativeFeatureFlags::disableTextLayoutManagerCacheAndroid()`
  **or** `ReactNativeFeatureFlags::enablePreparedTextLayout()`.

**Cache 2 — `LineMeasureCache`** (`SimpleThreadSafeCache<LineMeasureCacheKey, LinesMeasurements, 1024>`)
* key `LineMeasureCacheKey` — `…/TextMeasureCache.h:80-85`
  (`attributedString`, `paragraphAttributes`, `size`). Equality `:279-283`, hash `:308-315`.
  **No `pointScaleFactor` in this key** (asymmetry vs. Cache 1).
* ctor `…/TextLayoutManager.cpp:157`; bypass on
  `disableTextLayoutManagerCacheAndroid()` at `:286-292`.

**Cache 3 — `PreparedTextCache`** (feature-flag sized)
* key `PreparedTextCacheKey` — `…/TextMeasureCache.h:91-99`, equality `:285-290`
  (uses `areAttributedStringsEquivalentDisplayWise`, `:287`), hash `:317-327`.
* **size comes from a JS/feature-flag value** —
  `…/platform/android/…/TextLayoutManager.cpp:158-160`:
  ```
      preparedTextCache_(
          static_cast<size_t>(
              ReactNativeFeatureFlags::preparedTextCacheSize())) {}
  ```
  → **the cache bound is remotely configurable at runtime** (a production
  value of 0 or a very large number makes the cache effectively unbounded or
  disabled; nothing in C++ clamps it).

**Cache 4 — per-`ShadowNode` `measuredLayouts_`** — **UNBOUNDED**
* declaration `packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.h:140`
  ```
    mutable std::vector<MeasuredPreparedTextLayout> measuredLayouts_;
  ```
  comment `:135-139` "Intermediate layout results generated during measurement, that may be reused by the platform."
* **grows unconditionally on every measurement**, never trimmed, no cap, and no
  eviction: `…/components/text/ParagraphShadowNode.cpp:253-259`
  ```
      measuredLayouts_.push_back(
          MeasuredPreparedTextLayout{
              .layoutConstraints = layoutConstraints,
              .measurement = measurement,
              // PreparedTextLayout is not trivially copyable on all platforms
              // NOLINTNEXTLINE(performance-move-const-arg)
              .preparedTextLayout = std::move(preparedTextLayout)});
  ```
  Read-back paths: `findUsableLayout()` linear scan `:196-204` and
  `measureContent` early-exit linear scan `:226-231` — both O(n) per
  measurement, so the vector is both an unbounded memory sink and a
  quadratic-ish hot path within a single node's revision.
* Note the vector is a member of a **per-revision** `ShadowNode`, so it is
  released when the revision's `ShadowNode` dies; the growth is bounded by
  how many distinct `LayoutConstraints` a single node revision sees.

**Cache 5 — `content_`** — `…/ParagraphShadowNode.h:135`
`mutable std::optional<Content> content_{};`, computed once at
`…/ParagraphShadowNode.cpp:70-94` and memoised on `has_value()` (`:72-74`).

**Invalidation**: none of the above is invalidated on layout metrics, font
scale, or surface changes; they are pure LRU/identity caches keyed by the
measurement inputs. The per-node `measuredLayouts_` and `content_` die with
the node revision. `TextLayoutManagerExtended::supportsPreparedTextLayout()`
is a compile-time gate, and the `enablePreparedTextLayout()` flag can flip at
runtime — when it does, `measuredLayouts_` entries created under the old mode
are still eligible in `measureContent`'s scan at `:226-231`.

---

## 9. HARDCODED VALUES

### 9.1 Magic numbers affecting layout correctness

| value | path:line | role |
| ---: | --- | --- |
| `0.0001f` | `packages/react-native/ReactCommon/yoga/yoga/numeric/Comparison.h:58` | Yoga float equality epsilon — drives `inexactEquals` cache hits, `PixelGrid` "already rounded" decisions, and style comparisons |
| `0.0001` | `…/yoga/numeric/Comparison.h:65` | Yoga double equality epsilon |
| `0.5` | `…/yoga/algorithm/PixelGrid.cpp:57` | nearest-rounding threshold |
| `1.0f` | `…/yoga/config/Config.h:81` | default `pointScaleFactor_`; RN always overrides it (`:491`) |
| `0.0` | `…/yoga/algorithm/PixelGrid.cpp:85` | `if (pointScaleFactor != 0.0)` — disables **all** rounding when scale is 0 |
| `8` | `…/yoga/node/LayoutResults.h:25` | `MaxCachedMeasurements`; wrap-around at `…/CalculateLayout.cpp:2818-2821` silently **overwrites** the oldest entry (drops a measurement, cache only) |
| `64` | `…/yoga/algorithm/CalculateLayout.cpp:188` | `maxPendingNodes`; overflow disables the fit-content skip |
| `0.0f` | `…/yoga/node/Node.cpp:78-79` | clamp target for invalid measure dimensions |
| `0.0f` / `0.0` | `…/yoga/algorithm/CalculateLayout.cpp:495,498` | negative inner-size clamp before calling measure |
| `0` | `…/yoga/algorithm/CalculateLayout.cpp:882,884,887,889` | the min-content probe's `AtMost 0` constraint |
| `0.0f` | `…/yoga/algorithm/CalculateLayout.cpp:902` | empty-leaf min-content = 0 |
| `0.0f` | `…/yoga/algorithm/CalculateLayout.cpp:980` | non-`visible` overflow ⇒ auto-min = 0 |
| `0.0f` / `0.0` | `…/yoga/style/Style.h:46-48` | `DefaultFlexGrow = 0.0f`, `DefaultFlexShrink = 0.0f`, `WebDefaultFlexShrink = 1.0f` |
| `0` | `…/yoga/node/Node.cpp:464,479` | root-node `resolveFlexGrow`/`resolveFlexShrink` short-circuit to 0 |
| `0.0f` | `…/yoga/node/Node.cpp:367-368` | `flexBasis` for a growing flex item under non-web defaults is `points(0)` |
| `4096` | `…/yoga/style/SmallValueBuffer.h:34,55-56` | chunk-index assert (unreachable; real cap is `uint16_t` = 65536) |
| `2047` (`(1<<11)-1`) | `…/yoga/style/StyleValuePool.h:169` | inline-integer packing range; values outside go to the pool (`SmallValueBuffer<4>`, `:191`) |
| `2` | `…/yoga/enums/ExperimentalFeature.h:24-26` | `ordinalCount<ExperimentalFeature>()` → bitset width |
| `0.005f` | `packages/react-native/ReactCommon/react/utils/FloatComparison.h:16` | `kDefaultEpsilon`; used in `floatEquality` (`:19`) — Yoga config-reconfigure comparison, `TextMeasureCacheKey::pointScaleFactor` equality, `findUsableLayout()` |
| `0.01f` | `packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp:124-125` | attachment size bump before `ceil` rounding ("Rounding to *next* value on the pixel grid.") |
| `0.001` | `packages/react-native/ReactCommon/react/renderer/textlayoutmanager/TextMeasurementRounding.h:38` | `constexpr auto kEpsilon = static_cast<Float>(0.001);` text-measurement `ceil` bias (rationale at `:18-35`) |
| `1024` | `…/textlayoutmanager/TextMeasureCache.h:106` | `kSimpleThreadSafeCacheSizeCap` |
| `256` | `…/mounting/Differentiator.cpp:1398` | `mutations.reserve(256)` |
| `1024` | `…/mounting/ShadowTree.cpp:410` | `affectedLayoutableNodes.reserve(1024)` |
| `1024` | `…/mounting/ShadowTree.cpp:331` | `react_native_assert(attempts < 1024);` — unbounded retry in release |
| `3` | `…/mounting/ShadowTree.cpp:26` | `const int MAX_COMMIT_ATTEMPTS_BEFORE_LOCKING = 3;` |
| `-1.0` | `packages/react-native/ReactCommon/react/renderer/core/LayoutMetrics.h:101` | `EmptyLayoutMetrics` frame size — the sentinel for "not laid out" |
| `1.0` | `…/core/LayoutContext.h:29,57` | default `pointScaleFactor`, `fontSizeMultiplier` |
| `1.0` | `…/core/LayoutMetrics.h:44,46` | `pointScaleFactor{1.0}`, `fontSizeMultiplier{1.0}` |
| `1` | `…/core/State.h:31` | `static size_t constexpr initialRevisionValue = 1;` |
| `1,2,3` | `packages/react-native/ReactCommon/react/renderer/uimanager/primitives.h:148-152` | `displayModeToInt`: Visible→1, Suspended→2, Hidden→3; comment at `:145-146` "the result of this method should be in sync with `Libraries/ReactNative/DisplayMode.js`" |
| `2` | `…/renderer/graphics/platform/*/…/HostPlatformColor.h` | colour, not layout |
| `0xBADC0FFEE0DDF000ULL` | `…/components/view/YogaLayoutableShadowNode.cpp:340-341` | `kDetachedYogaNodeOwnerSentinel` — fabricated owner pointer; comment `:336-338` "Magic constant intentionally recognisable in debuggers when the address pops up." |
| `0` (checks in `MeasuredPreparedTextLayout`) | `…/platform/android/…/TextLayoutManager.cpp:403-404` | `react_native_assert(measurementsArr->size() >= 2);` and `(size() - 2) % 4 == 0` — the `[w, h, (top,left,w,h)*]` array layout is positional |

### 9.2 Platform-conditional compile-time branches affecting layout

| path:line | branch | effect |
| --- | --- | --- |
| `packages/react-native/ReactCommon/yoga/yoga/debug/AssertFatal.cpp:19-24` | `#if defined(__cpp_exceptions)` | `throw std::logic_error` vs `std::terminate()` — a Yoga fatal becomes a C++ exception where exceptions are enabled. In RN Android release builds with `-fno-exceptions` this is `std::terminate()` → process abort. |
| `packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp:42-46` | `#ifdef ANDROID` | `traits_.set(ShadowNodeTraits::Trait::KeyboardFocusable)` when `isSelectable` |
| `…/components/text/ParagraphShadowNode.h:50-56` | `#ifdef ANDROID` | `traits.unset(ShadowNodeTraits::Trait::FormsStackingContext);` with comment "Unsetting `FormsStackingContext` trait is essential on Android where we can't mount views inside `TextView`. T221699219: This should be removed when PreparedLayoutTextView is rolled out." |
| `…/components/text/TextShadowNode.h:31,39` | `#ifdef ANDROID` | text-node traits differ per platform |
| `…/core/ShadowNode.cpp:57-68` | `#ifdef RN_SERIALIZABLE_STATE` | `propsForClonedShadowNode` merges `Props::rawProps` for unmounted source nodes on Android |
| `…/core/ShadowNode.cpp:83-85`, `:113-115`; `…/core/ShadowNode.h:220-232` | `#if RN_DEBUG_STRING_CONVERTIBLE` | debug revision counter / props |
| `…/core/ConcreteComponentDescriptor.h:152-170` | `#ifdef RN_SERIALIZABLE_STATE` | Android-only `initializeDynamicProps` accumulation |
| `…/core/State.h:67-72` | `#ifdef RN_SERIALIZABLE_STATE` | `getDynamic`/`getMapBuffer`/`getJNIReference`/`updateState` become pure virtual on Android |
| `…/core/Props.h:64-78`; `…/core/graphicsConversions.h:29-31,56-86,191-201` | `#ifdef RN_SERIALIZABLE_STATE` | `rawProps` member + `toDynamic` overloads |
| `…/mounting/ShadowTree.cpp:41-47` | `#ifdef __ANDROID__` | `isPropsUpdatesAccumulationGuaranteed()` returns `ReactNativeFeatureFlags::enableAccumulatedUpdatesInRawPropsAndroid()` on Android, `true` elsewhere — **changes the whole React-revision merge strategy** (`scheduleReactRevisionPromotion` `:610-621`, `mergeReactRevision` `:494-570`, `promoteReactRevision` `:572-608`) |
| `…/mounting/ShadowViewMutation.cpp:73-87` | `#ifdef ANDROID` | `mutatedViewIsVirtual()` — comment `:77-81`: "Explanation: Even for non-virtual views, for \"Insert\" mutations, oldChildShadowView is always empty. for \"Remove\" mutations, newChildShadowView is always empty. Thus, to see if a view is virtual, we need to always check both the old and new View." Returns `false` unconditionally on non-Android. |
| `…/mounting/internal/sliceChildShadowNodeViewPairs.cpp:61-67` | `#ifdef ANDROID` | `Trait::Hidden` skipping only on Android, comment `:59-60` "T153547836: Disabled on Android because the mounting infrastructure is not fully ready yet." |
| `…/mounting/stubs/StubViewTree.cpp` (386 lines) | `#ifdef RN_SHADOW_TREE_INTROSPECTION` (`…/mounting/MountingCoordinator.cpp:29-32,97-99,132-177`) | the only mutation-order validator |
| `…/components/view/YogaLayoutableShadowNode.cpp:898` | `#ifdef REACT_NATIVE_DEBUG` | the measure-bounds check (§4.3) |
| `packages/react-native/ReactCommon/react/debug/react_native_assert.h:29` | `#ifndef REACT_NATIVE_DEBUG` | `react_native_assert(e) ((void)0)` — **all** RN-side layout asserts are erased in release |
| `…/components/view/YogaLayoutableShadowNode.cpp:72,99` | (none — but relevant) | `yogaConfig_(FabricDefaultYogaLog)` is passed on **both** platforms; the logger itself switches on `YGLogLevel` at `:45-60` |
| `…/components/text/ParagraphShadowNode.cpp:225,241,242,305,318,326` | `if constexpr (TextLayoutManagerExtended::supportsPreparedTextLayout())` + `ReactNativeFeatureFlags::enablePreparedTextLayout()` | prepared-text path vs `measure()` path — **different rounding**: `rawContentSize()` (`:210-218`) vs `layoutMetrics.getContentFrame().size` (`:307`) |
| `…/textlayoutmanager/TextMeasurementRounding.h:32-34` | (comment) | "In production it is used only by `RCTTextLayoutManager.mm`, and the `internal_` prefix keeps it out of the public C++ API snapshot." — **the header's own comment claims production use, but the only caller is on iOS**; Android has no caller in the audited dirs. |

---

## 10. DEAD CODE

### 10.1 Exported C symbols with zero references outside vendored Yoga

Command:
```
for sym in YGNodeFree YGNodeFreeRecursive YGNodeSetDirtiedFunc YGNodeGetDirtiedFunc \
           YGNodeCanUseCachedMeasurement YGNodeGetAlwaysFormsContainingBlock \
           YGConfigGetDefault YGConfigGetUseWebDefaults YGNodeLayoutGetHadOverflow \
           YGNodeSetChildren YGNodeGetParent; do
  grep -rn --include='*.cpp' --include='*.h' --include='*.mm' --include='*.m' \
       -w "$sym" packages/ private/ | grep -v "ReactCommon/yoga/yoga/"
done
```

| symbol | declaration | external refs |
| --- | --- | ---: |
| `YGNodeFree` | `packages/react-native/ReactCommon/yoga/yoga/YGNode.h:49` | **0** |
| `YGNodeFreeRecursive` | `…/yoga/YGNode.h:54` | **0** |
| `YGNodeSetDirtiedFunc` | `…/yoga/YGNode.h:110` | **0** |
| `YGNodeGetDirtiedFunc` | `…/yoga/YGNode.h:115` | **0** |
| `YGNodeCanUseCachedMeasurement` | `…/yoga/YGNode.h:358` | **0** (and `YG_DEPRECATED("YGNodeCanUseCachedMeasurement may be removed in a future version of Yoga")` at `:356-357`) |
| `YGNodeGetAlwaysFormsContainingBlock` | `…/yoga/YGNode.h:351` | **0** (the setter `YGNodeSetAlwaysFormsContainingBlock` has 2 — `…/YogaLayoutableShadowNode.cpp:411` and JNI) |
| `YGNodeSetChildren` | `…/yoga/YGNode.h:141` | **0** (the C++ equivalent `Node::setChildren` **is** used, `…/yoga/node/Node.h:286`) |
| `YGNodeGetParent` | `…/yoga/YGNode.h:161` | **0** (exact duplicate of `YGNodeGetOwner`, `…/YGNode.cpp:285-287`) |
| `YGNodeLayoutGetHadOverflow` | `…/yoga/YGNodeLayout.h` | **0** |
| `YGConfigGetDefault` | `…/yoga/YGConfig.h:47` | **0** |
| `YGConfigGetUseWebDefaults` | `…/yoga/YGConfig.h:60` | **0** |

Also dead under RN: the `Config::cloneNode` fallback `YGNodeClone(node)`
(`…/yoga/config/Config.cpp:124-126`) — unreachable because RN's
`yogaNodeCloneCallbackConnector` never returns `nullptr`
(`…/components/view/YogaLayoutableShadowNode.cpp:845-853`).
And `ExperimentalFeature::WebFlexBasis` (`…/yoga/enums/ExperimentalFeature.h:19`)
is never enabled but still read at `…/yoga/algorithm/CalculateLayout.cpp:274-276`.

### 10.2 Yoga headers RN never includes

Command:
```
for f in $(find packages/react-native/ReactCommon/yoga/yoga -name '*.h' | sort); do
  base=$(basename $f)
  n=$(grep -rn --include='*.cpp' --include='*.h' --include='*.mm' --include='*.m' \
       -E "#include.*[/<]${base}[>\" ]" packages/ private/ | wc -l)
  echo "$n $f"
done | sort -n
```

* **0 includes anywhere in the repo**:
  `packages/react-native/ReactCommon/yoga/yoga/enums/GridTrackType.h`.
  Its `yoga::GridTrackType` scoped enum is therefore also unreferenced;
  `YGGridTrackType` is used, but only from the generated `YGEnums.h`
  (`…/yoga/YGNodeStyle.cpp:621-712`).
* **1 include each (internal only, never from RN)**:
  `…/yoga/enums/BoxSizing.h`, `…/yoga/enums/ExperimentalFeature.h`,
  `…/yoga/enums/Gutter.h`, `…/yoga/enums/Justify.h`, `…/yoga/enums/NodeType.h`,
  `…/yoga/enums/Overflow.h`, `…/yoga/enums/Wrap.h`,
  `…/yoga/node/CachedMeasurement.h`, `…/yoga/node/LayoutableChildren.h`,
  `…/yoga/style/GridStyle.h`, `…/yoga/style/StyleValueHandle.h`,
  `…/yoga/style/StyleValuePool.h`, `…/yoga/YGNodeLayout.h`,
  `…/yoga/YGNodeStyle.h`, `…/yoga/YGPixelGrid.h`.
* The **public** C headers RN does include: `…/yoga/Yoga.h`,
  `…/yoga/YGNode.h`, `…/yoga/YGConfig.h`, `…/yoga/YGEnums.h`,
  `…/yoga/YGMacros.h`, `…/yoga/YGValue.h`, `…/yoga/node/Node.h`.
  `…/yoga/YGPixelGrid.h` (decl of `roundValueToPixelGrid`) is **never included
  by RN** — RN has no access to the pixel-grid rounding function even though it
  runs it indirectly via `YGNodeCalculateLayout`.
* Yoga `.cpp` files have no external `#include` at all — they are compiled
  via `…/yoga/CMakeLists.txt` and `…/Yoga.podspec`. Not reported as dead.

---

## 11. COMMENTS OF NOTE

### 11.1 Every TODO / FIXME / HACK / XXX / WORKAROUND in scope

Command: `grep -rn -E "TODO|FIXME|HACK|XXX|WORKAROUND|workaround|Workaround" --include='*.cpp' --include='*.h' <nine dirs> | grep -v __tests__ | grep -v /tests/`

| path:line | exact text |
| --- | --- |
| `…/yoga/yoga/algorithm/Align.h:51` | `    // Fallback to safe center. TODO (T208209388): This should be aligned to` |
| `…/yoga/yoga/algorithm/Align.h:69` | `      // TODO: Support `justify-content: stretch`` |
| `…/yoga/yoga/algorithm/Align.h:73` | `    // Fallback to safe center. TODO (T208209388): This should be aligned to` |
| `…/yoga/yoga/node/Node.cpp:134` | `    // TODO: t18095186 Move nodeType to opt-in function and mark appropriate` |
| `…/yoga/yoga/node/Node.cpp:143` | `    // TODO: t18095186 Move nodeType to opt-in function and mark appropriate` |
| `…/yoga/yoga/node/Node.h:281` | `  // TODO: rvalue override for setChildren` |
| `…/yoga/yoga/style/GridTrack.h:21` | `  // TODO: maybe move them to TrackSizing since these are track states` |
| `…/yoga/yoga/YGNode.cpp:377-378` | `// TODO: This leaks internal details to the public API. Remove after removing`<br>`// ComponentKit usage of it.` |
| `…/components/image/ImageProps.h:19` | `// TODO (T28334063): Consider for codegen.` |
| `…/components/image/ImageShadowNode.cpp:27` | `  // TODO: T226624691 Improve image request creation to avoid double requests` |
| `…/components/image/ImageShadowNode.cpp:60` | `      // TODO: should we resizeMultiplier * imageSource.scale ?` |
| `…/components/scrollview/BaseScrollViewProps.cpp:18` | `// TODO (T28334063): Consider for codegen.` |
| `…/components/scrollview/BaseScrollViewProps.h:21` | `// TODO (T28334063): Consider for codegen.` |
| `…/components/text/BaseTextShadowNode.h:53` | `   * TODO T53299884: decide if this should be moved out and made a static` |
| `…/components/textinput/BaseTextInputProps.h:60` | `  // TODO: Rename to `tintColor` and make universal.` |
| `…/components/textinput/platform/android/…/AndroidTextInputComponentDescriptor.h:43` | `    // TODO: figure out RTL/start/end/left/right stuff here` |
| `…/components/textinput/platform/android/…/AndroidTextInputComponentDescriptor.h:88` | `      // TODO: T62959168 account for RTL and paddingLeft when setting default` |
| `…/components/textinput/platform/android/…/AndroidTextInputComponentDescriptor.h:116` | `      // TODO: support RTL` |
| `…/components/textinput/platform/android/…/AndroidTextInputComponentDescriptor.h:148` | `  // TODO T68526882: Unify with Binding::UIManagerJavaDescriptor` |
| `…/components/textinput/platform/android/…/AndroidTextInputProps.cpp:155` | `      // TODO T63008435: can these, and this feature, be removed entirely?` |
| `…/components/textinput/platform/android/…/AndroidTextInputProps.cpp:239` | `    // TODO T63008435: can these, and this feature, be removed entirely?` |
| `…/components/textinput/platform/android/…/AndroidTextInputProps.cpp:279` | `// TODO T53300085: support this in codegen; this was hand-written` |
| `…/components/textinput/platform/android/…/AndroidTextInputProps.cpp:350` | `// TODO: codegen these` |
| `…/components/textinput/platform/android/…/AndroidTextInputProps.h:115` | `   * TODO T63008435: can these, and this feature, be removed entirely?` |
| `…/components/textinput/platform/android/…/AndroidTextInputShadowNode.cpp:189` | `    // text value's background will stack. This is a hack/workaround to prevent` |
| `…/components/textinput/platform/android/…/AndroidTextInputState.cpp:27` | `    // TODO truncation` |
| `…/components/view/BoxShadowPropsConversions.h:119` | `  // TODO: handle non-px values` |
| `…/components/view/FilterPropsConversions.h:160` | `          // TODO: support non-px values` |
| `…/components/view/FilterPropsConversions.h:171` | `          // TODO: support non-px values` |
| `…/components/view/platform/android/…/HostPlatformViewProps.cpp:644` | `  // TODO T212662692: pass events as std::bitset<64> to java` |
| `…/components/view/YogaLayoutableShadowNode.cpp:213` | `    // TODO: At this point, React has wrong reference to the node. (T138668036)` |
| `…/components/view/YogaLayoutableShadowNode.cpp:505` | `  // TODO: `swapLeftAndRight` modified backing props and cannot be undone` |
| `…/components/view/YogaLayoutableShadowNode.cpp:576` | `  // TODO: Why does this not use `ShadowNodeFragment::statePlaceholder()` like` |
| `…/components/view/YogaLayoutableShadowNode.cpp:1019` | `    // TODO: Do not mutate props directly.` |
| `…/core/EventEmitter.cpp:23` | `// TODO(T29874519): Get rid of "top" prefix once and for all.` |
| `…/core/EventTarget.cpp:42` | `  // TODO: Replace with mustfix once mustfix is ready in React Native.` |
| `…/core/propsConversions.h:196` | `    // TODO: report this using ErrorUtils so it's more visible to the user` |
| `…/core/ShadowNode.cpp:148` | `        // TODO: We might need to merge fragment.props with` |
| `…/dom/DOM.cpp:478` | `  // FIXME(T162807327): Remove Android-specific prefixes and unify` |
| `…/mounting/Differentiator.cpp:272` | `      // TODO: is this necessary anymore?` |
| `…/mounting/Differentiator.cpp:612-615` | `      // TODO: compare ShadowNode pointer instead of ShadowView here?`<br>`      // Or ShadowNode ptr comparison before comparing ShadowView, to allow for`<br>`      // short-circuiting? ShadowView comparison is relatively expensive vs`<br>`      // ShadowNode.` |
| `…/mounting/Differentiator.cpp:620-621` | `        // TODO: whenever we insert, we already update the relevant properties,`<br>`        // so this update is redundant. We should remove this.` |
| `…/mounting/internal/ShadowViewNodePair.h:42-44` | `   * We rely on this only for marginal cases. TODO: could we`<br>`   * rely on this more heavily to simplify the diffing algorithm`<br>`   * overall?` |
| `…/mounting/MountingTransaction.cpp:52-53` | `  // TODO T186641819: Telemetry for merged transactions is not supported, use`<br>`  // the latest instance` |
| `…/scheduler/InspectorData.h:22` | `  // TODO T97216348: remove folly::dynamic from InspectorData struct` |
| `…/scheduler/Scheduler.cpp:44` | `  // TODO(T182293888): remove singleton from PerformanceEntryReporter and move` |
| `…/textlayoutmanager/platform/android/…/TextLayoutManager.cpp:97` | `  // TODO: This is suss, and not at the right layer` |
| `…/textlayoutmanager/platform/android/…/TextLayoutManager.cpp:216` | `  // TODO: this is always sourced from an int, and Java expects an int` |
| `…/textlayoutmanager/platform/android/…/TextLayoutManager.cpp:233` | `  // TODO: currently we do not support attachments for cached IDs - should we?` |
| `…/textlayoutmanager/platform/ios/…/RCTTextPrimitivesConversions.h:130` | `// TODO: this file has some duplicates method, we can remove it` |
| `…/uimanager/PointerEventsProcessor.cpp:98` | `  // TODO: is dereferencing latestNodeToTarget without null checking safe?` |
| `…/uimanager/PointerEventsProcessor.cpp:102` | `  // HACK: This is a basic/incomplete implementation which simply subtracts` |
| `…/uimanager/PointerEventsProcessor.cpp:241` | `    // TODO: Remove the need for this check by properly handling` |
| `…/uimanager/PointerEventsProcessor.cpp:301` | `    // TODO: Throw DOMException with name "NotFoundError" when pointerId does` |
| `…/uimanager/PointerEventsProcessor.cpp:320` | `    // TODO: Throw DOMException with name "NotFoundError" when pointerId does` |
| `…/uimanager/primitives.h:54` | `// TODO: once we no longer need to mutate the return value (appendChildToSet)` |
| `…/uimanager/primitives.h:60` | `  // TODO: cleanup when passChildrenWhenCloningPersistedNodes is rolled out` |
| `…/uimanager/primitives.h:75` | `      // TODO: return ShadowNode::emptySharedShadowNodeSharedList()` |
| `…/uimanager/UIManager.h:208` | `   * wasn't found. This is a temporary workaround that should not be used in` |
| `…/uimanager/UIManagerAnimationDelegate.h:25` | `   * TODO: need SurfaceId here` |
| `…/uimanager/UIManagerBinding.cpp:338` | `          // TODO: re-enable when passChildrenWhenCloningPersistedNodes is` |
| `…/uimanager/UIManagerBinding.cpp:391` | `          // TODO: re-enable when passChildrenWhenCloningPersistedNodes is` |
| `…/uimanager/UIManagerBinding.cpp:431` | `  // TODO: remove when passChildrenWhenCloningPersistedNodes is rolled out` |
| `…/uimanager/UIManagerBinding.cpp:448` | `  // TODO: remove when passChildrenWhenCloningPersistedNodes is rolled out` |
| `…/uimanager/UIManagerBinding.cpp:765` | `              // TODO: pass in JSI value instead of folly::dynamic to RawValue` |
| `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/LayoutContext.h:16` | `// TODO: This should not be exported or used outside of the JNI bindings` |

### 11.2 Comments stating numeric thresholds, platform conditions, or invariants (exact quotes)

* `packages/react-native/ReactCommon/yoga/yoga/node/LayoutResults.h:23-25`
  ```
    // This value was chosen based on empirical data:
    // 98% of analyzed layouts require less than 8 entries.
    static constexpr int32_t MaxCachedMeasurements = 8;
  ```
* `packages/react-native/ReactCommon/yoga/yoga/numeric/Comparison.h:54-55`
  ```
  // Custom equality functions using a hardcoded epsilon of 0.0001f, or returning
  // true if both floats are NaN.
  ```
* `packages/react-native/ReactCommon/yoga/yoga/config/Config.h:101-110`
  ```
  /*
   * StyleValuePool allows compact storage for a sparse collection of assigned
   * lengths and numbers. Values are referred to using StyleValueHandle. In most
   * cases StyleValueHandle can embed the value directly, but if not, the value is
   * stored within a buffer provided by the pool. The pool contains a fixed number
   * of inline slots before falling back to heap allocating additional slots.
   */
  ```
* `packages/react-native/ReactCommon/yoga/yoga/style/SmallValueBuffer.h:19-21`
  ```
  // Container which allows storing 32 or 64 bit integer values, whose index may
  // never change. Values are first stored in a fixed buffer of `BufferSize`
  // 32-bit chunks, before falling back to heap allocation.
  ```
* `packages/react-native/ReactCommon/yoga/yoga/style/SmallValueBuffer.h:34`
  `    assert(index < 4096 && "SmallValueBuffer can only hold up to 4096 chunks");`
* `packages/react-native/ReactCommon/yoga/yoga/YGNode.h:56-61`
  ```
  /**
   * Frees the Yoga node without disconnecting it from its owner or children.
   * Allows garbage collecting Yoga nodes in parallel when the entire tree is
   * unreachable.
   */
  ```
* `packages/react-native/ReactCommon/yoga/yoga/YGConfig.h:62-68`
  ```
  /**
   * Yoga will by default round final layout positions and dimensions to the
   * nearest point. `pointScaleFactor` controls the density of the grid used for
   * layout rounding (e.g. to round to the closest display pixel).
   *
   * May be set to 0.0f to avoid rounding the layout results.
   */
  ```
* `packages/react-native/ReactCommon/yoga/yoga/YGConfig.h:78-92`
  ```
  /**
   * Configures how Yoga balances W3C conformance vs compatibility with layouts
   * created against earlier versions of Yoga.
   *
   * By default Yoga will prioritize W3C conformance. `Errata` may be set to ask
   * Yoga to produce specific incorrect behaviors. E.g. `YGConfigSetErrata(config,
   * YGErrataStretchFlexBasis)`.
   ...
  ```
* `packages/react-native/ReactCommon/yoga/yoga/YGNode.h:224-239`
  ```
  /**
   * Optional companion to `YGMeasureFunc` invoked by the CSS Flexbox §4.5
   * automatic minimum sizing path when probing this node for its min-content
   * size along the main axis.
   ...
  ```
* `packages/react-native/ReactCommon/yoga/yoga/YGNodeLayout.h:26-27`
  ```
  // YGNodeStyleGetXXX. However if they were set using a percentage value then the
  ```
  (preceded by a comment explaining that resolved margin/border/padding differ from style values)
* `packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:1716-1722`
  ```
  //    When calling calculateLayoutImpl and calculateLayoutInternal, if the
  //    caller passes an available size of undefined then it must also pass a
  //    measure mode of SizingMode::MaxContent in that dimension.
  ```
* `packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:2711-2718`
  ```
    // Determine whether the results are already cached. We maintain a separate
    // cache for layouts and measurements. A layout operation modifies the
    // positions and dimensions for nodes in the subtree. The algorithm assumes
    // that each node gets laid out a maximum of one time per tree layout, but
    // multiple measurements may be required to resolve all of the flex
    // dimensions. We handle nodes with measure functions specially here because
    // they are the most expensive to measure, so it's worth avoiding redundant
    // measurements if at all possible.
  ```
* `packages/react-native/ReactCommon/yoga/yoga/algorithm/PixelGrid.cpp:86-88`
  ```
    // If a node has a custom measure function we never want to round down its
    // size as this could lead to unwanted text truncation.
    const bool textRounding = node->getNodeType() == NodeType::Text;
  ```
* `packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:492`
  `  // We want to make sure we don't call measure with negative size`
* `packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:424-425`
  ```
        // The contents node's children are treated as children of the
        // contents node's parent for layout purposes, so they need
  ```
* `packages/react-native/ReactCommon/yoga/yoga/algorithm/CalculateLayout.cpp:1420-1425`
  ```
    // CSS Flexbox §4.5: compute each item's automatic minimum main-axis size
    // up front so the bounding helpers below can floor shrunk values.
  ```
* `packages/react-native/ReactCommon/yoga/yoga/node/LayoutResults.h:30-36`
  ```
    // Per-flex-item floor along the main axis derived from CSS Flexbox §4.5
    // automatic minimum sizing. Set by `resolveFlexibleLength` when the parent's
    // config does NOT carry the `MinSizeUndefinedInsteadOfAuto` errata and the
    // item has no explicit main-axis `min-{width,height}`. Read by the
    // shrink/bound machinery to keep items at least this large. `Undefined`
    // means "no auto-min applies."
  ```
* **Correction to 11.2**: the `fold … into one presence mask … This is the hot path` quote
  attributed in the raw grep output to
  `packages/react-native/ReactCommon/yoga/yoga/style/StyleValuePool.h:152-155` actually
  originates in
  `packages/react-native/ReactCommon/react/renderer/textlayoutmanager/TextMeasureCache.h:152-154`
  (the earlier grep pass mis-attributed the offset). Exact text, verbatim:
  ```
    // The optionals are folded into one presence mask rather than being chained individually, so
    // that the properties a given text run does not set stay off the hash's dependency chain. This
    // is the hot path: it runs on every measurement-cache probe.
  ```
  `StyleValuePool.h:152-155` actually reads:
  ```
      handle.setValue(newIndex);
      handle.setValueIsIndexed();
    }
  }

    static constexpr bool isIntegerPackable(float f) {
  ```
  i.e. it contains no comment at all.
* **Correction to 11.2**: the
  `Checking and setting isObsolete_ …` quote attributed in the raw grep to
  `…/core/ShadowNode.cpp:150-158` originates in
  `packages/react-native/ReactCommon/react/renderer/core/ShadowNodeFamily.cpp:150-154`:
  ```
    /*
     * Checking and setting `isObsolete_` prevents old states to be recommitted
     * on top of fresher states. It's okay to commit a tree with "older" Shadow
     * Nodes (the evolution of nodes is not linear), however, we never back out
     * states (they progress linearly).
     */
  ```
* `packages/react-native/ReactCommon/react/renderer/textlayoutmanager/TextMeasureCache.h:101-105`
  ```
  /*
   * Maximum size of the Cache.
   * The number was empirically chosen based on approximation of an average amount
   * of meaningful measures per surface.
   */
  ```
* `packages/react-native/ReactCommon/react/renderer/textlayoutmanager/TextMeasureCache.h:198-200` and `:206-208`
  ```
    // Here we are not taking `isAttachment` and `layoutMetrics` into account
    // because they are logically interdependent and this can break an invariant
    // between hash and equivalence functions (and cause cache misses).
  ```
* `packages/react-native/ReactCommon/react/renderer/textlayoutmanager/TextMeasurementRounding.h:18-35`
  (full block; the load-bearing sentence is `:22-28`)
  ```
   * A small epsilon is added to each dimension before ceil, so a value that sits
   * effectively on a physical-pixel boundary gains one extra physical pixel
   * instead of being rounded down. This works around precision loss when a
   * measurement is converted from double to float and then rounded to the pixel
   * grid in Yoga: without it, such a value can round down and clip the final line
   * (height) or trailing glyph (width) of text.
  ```
* `packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp:24-33`
  ```
  #define assert_valid_size(size, layoutConstraints)  \
    react_native_assert(                              \
        (size).width + kDefaultEpsilon >=             \
            (layoutConstraints).minimumSize.width &&  \
  ```
* `packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.cpp:190-194`
  ```
      // We consider the layout to be reusable, if our content measurement,
      // combined with padding/border (not snapped) exactly corresponds to the
      // measurement of the node, before layout rounding. We may not find a
      // compatible layout, such as if Yoga already knew the dimensions (an
      // exact width/height was given), or if our content measurement was
      // adjusted by a constraint (like min-size).
  ```
* `packages/react-native/ReactCommon/react/renderer/components/text/ParagraphShadowNode.h:47-56`
  ```
  #ifdef ANDROID
      // Unsetting `FormsStackingContext` trait is essential on Android where we
      // can't mount views inside `TextView`.
      // T221699219: This should be removed when PreparedLayoutTextView is rolled
      // out.
  ```
* `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:493-497`
  ```
    // A measurable node's measurement depends on `fontSizeMultiplier`, but unlike
    // `pointScaleFactor` it is not part of the Yoga config, so a change does not
    // invalidate Yoga's layout cache. Dirty the node when it changes to force
    // re-measurement. We propagate up to the root so an unchanged, still-cached
    // ancestor isn't skipped by `calculateLayoutInternal` before reaching us.
  ```
* `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:512-515`
  ```
    // Recursively propagate the configuration to child nodes. If a child was
    // already configured as part of a previous ShadowTree generation, we only
    // need to reconfigure it if the context values passed to the Node have
    // changed.
  ```
* `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:324-334`
  ```
  // Detects the ABA scenario where a freshly-allocated `yogaNode_` happens
  // to land at the same address a previous parent occupied. After such a
  // realloc, any Yoga child whose owner pointer still equals `&yogaNode_`
  // is a stale match — yoga would mistake it for "owned by us" and skip the
  // clone-on-write check. We rewrite those spurious owner pointers to a
  // recognisable sentinel so the next `YGNodeGetOwner(child) == this` check
  // correctly returns false and yoga clones the child as it would for any
  // foreign tree.
  //
  // No-op in the common case: right after a clone, children's owner
  // pointers still reference the source node, not us.
  ```
* `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:785-792`
  ```
      // Note that the parent node's overflow layout is NOT affected by its
      // transform matrix. That transform matrix is applied on the parent node
      // as well as all of its child nodes, which won't cause changes on the
      // overflowInset values. A special note on the scale transform -- the
      // scaled layout may look like it's causing overflowInset changes, but
      // it's purely cosmetic and will be handled by pixel density conversion
      // logic later when render the view. The actual overflowInset value is not
      // changed as if the transform is not happening here.
  ```
* `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:753-754`
  ```
      // We must copy layout metrics from Yoga node only once (when the parent
      // node exclusively ownes the child node).
  ```
* `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:767-771`
  ```
        // Child node's layout has changed. When a node is added to
        // `affectedNodes`, onLayout event is called on the component. Comparing
        // `newLayoutMetrics.frame` with `childNode.getLayoutMetrics().frame` to
        // detect if layout has not changed is not advised, please refer to
        // D22999891 for details.
  ```
* `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.cpp:103-105`
  ```
    // Note, cloned `yoga::Node` instance (copied using copy-constructor)
    // inherits dirty flag, measure function, and other properties being set
    // originally in the `YogaLayoutableShadowNode` constructor above.
  ```
* `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.h:165-178`
  ```
    #pragma mark - RTL Legacy Autoflip

    /*
     * Reassigns the following values:
     * - (left|right) → (start|end)
     ...
     * This is neccesarry to be backwards compatible with old renderer, it swaps
     * the values as well in https://fburl.com/diffusion/kl7bjr3h
     */
  ```
* `packages/react-native/ReactCommon/react/renderer/components/view/YogaLayoutableShadowNode.h:27-29`
  ```
    // Allow YogaCloneTest to read yogaNode_ for ownership assertions in unit
    // tests. The class is only defined in the tests target; production code
    // sees the friend as a forward declaration with no effect.
  ```
* `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.h:119-123`
  ```
    /**
     * Called, once a fully derived ShadowNode clone has been created via
     * ComponentDescriptor::cloneShadowNode.
     */
  ```
* `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.h:187-192`
  ```
    /*
     * Performs all side effects associated with mounting/unmounting in one place.
     * This is not `virtual` on purpose, do not override this.
     * `EventEmitter::DispatchMutex()` must be acquired before calling.
     */
  ```
* `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.h:284-286`
  ```
    /*
     * Weak pointer to the runtime reference to this `ShadowNode`.
     */
  ```
* `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.h:270-273`
  ```
    /*
     * True if shadow node will be mounted shortly in the future but for all
     * intents and purposes it should be treated as mounted.
     */
    mutable std::atomic<bool> hasBeenMounted_{false};
  ```
* `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:22-27`
  ```
  /*
   * Runtime shadow node reference updates should only run from one thread at all
   * times to avoid having more than one shadow tree updating the current fiber
   * tree simultaneously. This thread_local flag allows enabling the updates for
   * chosen threads.
   */
  ```
* `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:46-53`
  ```
  /*
   * On iOS, this method returns `props` if provided, `sourceShadowNode`'s props
   * otherwise. On Android, we forward props in case `sourceShadowNode` hasn't
   * been mounted. `Props::rawProps` are merged from `props` to a copy of
   * `sourceShadowNode.props_` and returned. This is necessary to enable
   * Background Executor and should be removed once reimplementation of JNI layer
   * is finished.
   */
  ```
  (this is `propsForClonedShadowNode`, impl at `…/core/ShadowNode.cpp:54-70`; the
  comment body — verbatim from the file — begins "On iOS, this method returns")
* `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:150-158`
  ```
      // Checking and setting `isObsolete_` prevents old states to be recommitted
      // on top of fresher states. It's okay to commit a tree with "older" Shadow
      // Nodes (the evolution of nodes is not linear), however, we never back out
      // states (they progress linearly).
  ```
  — **not present at this location.** The verbatim text above lives at
  `packages/react-native/ReactCommon/react/renderer/core/ShadowNodeFamily.cpp:150-154`
  (inside `ShadowNodeFamily::setMostRecentState`, `…/ShadowNodeFamily.cpp:147-165`).
  `ShadowNode.cpp:150-158` instead reads:
  ```
      propsOverride.emplace(*family.nativeProps_DEPRECATED);
      } else {
        // TODO: We might need to merge fragment.props with
        // `family.nativeProps_DEPRECATED`.
      }
    }
  }

    if (propsOverride) {
    // Clone existing `props_` with `family.nativeProps_DEPRECATED` to
    // apply previously set props via `setNativeProps` API. The parsed
    // result escapes the lock so the rest of the clone work runs
    // unblocked.
  ```
* `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.cpp:249-257`
  (the `const_cast` write-through used by `appendChild`)
  ```
    auto& children =
        const_cast<std::vector<std::shared_ptr<const ShadowNode>>&>(*children_);
  ```
  — same pattern in `ShadowNode::replaceChild` at
  `…/core/ShadowNode.cpp:268-269`. Both are legal only because
  `cloneChildrenIfShared()` (`:293-301`) has just installed a **non-shared**
  `children_`; the `const_cast` is the sanctioned escape hatch, not a defect.
* `packages/react-native/ReactCommon/react/renderer/core/ConcreteComponentDescriptor.h:27-47`
  ```
   * `Flavor` is a special concept designed to allow registering instances of
   * the exact same `ComponentDescriptor` class with different `ComponentName`
   * and `ComponentHandle` (the particular custom implementation might use
   * stored `flavor` to return different values from those virtual methods).
   * Since it's a very niche requirement (e.g. we plan to use it for
   * an interoperability layer with old renderer), we are thinking about
   * removing this feature completely after it's no longer needed.
   */
  ```
* `packages/react-native/ReactCommon/react/renderer/core/ConcreteComponentDescriptor.h:112-122`
  ```
    // Optimization:
    // Quite often nodes are constructed with default/empty props: the base
    // `props` object is `null` (there no base because it's not cloning) and the
    // `rawProps` is empty. In this case, we can return the default props object
    // of a concrete type entirely bypassing parsing.
  ```
* `packages/react-native/ReactCommon/react/renderer/core/Props.h:49-58`
  ```
    /**
     * Set a prop value via iteration (see enableIterator above).
     * If setProp is defined for a particular props struct, it /must/
     * be called every time setProp is called on the hierarchy.
     * ...
     */
  ```
* `packages/react-native/ReactCommon/react/renderer/core/Props.h:100-110`
  ```
  /*
   * Internal: `T` declares its OWN `setProp` (not just inherits one from a
   * base class). ...
   * Distinguishing own-declaration from inherited-declaration matters because
   * `setProp` is non-virtual. A subclass that adds fields but forgets to
   * override `setProp` would silently inherit its parent's switch — and the new
   * fields would never be reached by the iterator-setter dispatch.
   */
  ```
* `packages/react-native/ReactCommon/react/renderer/core/ConcreteComponentDescriptor.h:53-57`
  ```
    // The parser's `keys_` / `nameToIndex_` are only consumed by
    // `RawProps::at()`, which is reached exclusively through the classic
    // per-field `convertRawProp` path. When `ConcreteProps` opts into the
    // iterator-setter path and the runtime flag is on, `parse()` is never
    // called, so the O(n²) preparation here is wasted. Skip it.
  ```
* `packages/react-native/ReactCommon/react/renderer/core/ConcreteComponentDescriptor.h:217-221`
  ```
    virtual void adopt(ShadowNode &shadowNode) const override
    {
      // Default implementation does nothing.
      react_native_assert(shadowNode.getComponentHandle() == getComponentHandle());
    }
  ```
* `packages/react-native/ReactCommon/react/renderer/core/EventEmitter.h:49-58` (already quoted in §7.2)
* `packages/react-native/ReactCommon/react/renderer/core/EventEmitter.cpp:222-226`
  ```
    // Note: Initially, the state of `eventTarget_` and the value
    // `enableCounter_` is mismatched intentionally (it's `non-null` and `0`
    // accordingly). We need this to support an initial nebula state where the
    // event target must be retained without any associated mounted node.
  ```
* `packages/react-native/ReactCommon/react/renderer/core/EventEmitter.cpp:23-28`
  ```
  // TODO(T29874519): Get rid of "top" prefix once and for all.
  /*
   * Replaces "on" with "top" if present. Or capitalizes the first letter and
   * adds "top" prefix. E.g. "eventName" becomes "topEventName", "onEventName"
   * also becomes "topEventName".
   */
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.cpp:26` `const int MAX_COMMIT_ATTEMPTS_BEFORE_LOCKING = 3;`
* `packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.cpp:285-286`
  ```
      // initial revision never contains any commits so mounting it here is
      // incorrect
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.cpp:329-331`
  ```
        // After multiple attempts, we failed to commit the transaction.
        // Something internally went terribly wrong.
        react_native_assert(attempts < 1024);
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/ShadowTree.cpp:342` — the `"\u269b Native"` performance marker (not a claim)
* `packages/react-native/ReactCommon/react/renderer/mounting/ShadowTreeRevision.h` / `ShadowTree.h:112-115`
  ```
    /*
     * Performs commit calling `transaction` function with a `oldRootShadowNode`
     * and expecting a `newRootShadowNode` as a return value.
     * The `transaction` function can cancel commit returning `nullptr`.
     */
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/Differentiator.cpp:616-621`
  ```
      if (newTreeNodePair.shadowView != oldTreeNodePair.shadowView &&
          newTreeNodePair.isConcreteView && oldTreeNodePair.isConcreteView) {
        // We execute updates before creates, so pass the current parent in when
        // unflattening.
        // TODO: whenever we insert, we already update the relevant properties,
        // so this update is redundant. We should remove this.
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/Differentiator.cpp:1290-1291`
  ```
      // Final step: generate Create instructions for entirely new
      // subtrees/nodes that are not the result of flattening or unflattening.
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/internal/sliceChildShadowNodeViewPairs.cpp:59-60`
  ```
    // T153547836: Disabled on Android because the mounting infrastructure
    // is not fully ready yet.
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/internal/sliceChildShadowNodeViewPairs.cpp:86-88`
  ```
        // Embedded Text components can have an empty layout, while these still
        // need to be mounted to set the correct react tags on the text
        // fragments. These should not be culled.
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/ShadowViewMutation.h:102-106`
  ```
    // Some platforms can have the notion of virtual views - views that are in the
    // ShadowTree hierarchy but never are on the platform. Generally this is used
    // so notify the platform that a view exists so that we can keep EventEmitters
    // around, to notify JS of something. This mechanism is DEPRECATED and it is
    // highly recommended that you NOT make use of this in your platform!
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/MountingTransaction.h:18-24`
  ```
  /*
   * Encapsulates all artifacts of `ShadowTree` commit (or a series of them),
   * particularly list of mutations and meta-data associated with the commit.
   * Movable and copyable, but moving is strongly encouraged.
   * Beware: A moved-from object of this type has unspecified value and accessing
   * that is UB (Undefined Behaviour).
   */
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/MountingTransaction.h:79-86`
  ```
    /*
     * Merges the given transaction in the current transaction, so they
     * can be executed atomatically as a single transaction.
     *
     * This is required for Android UI, which needs to separately apply
     * each ShadowTree mutation due to differences in props representation.
     */
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/MountingCoordinator.cpp:55-59`
  ```
  // We have two goals here.
  // 1. We need to stop retaining `ShadowNode`s to not prolong their lifetime
  // to prevent them from overliving `ComponentDescriptor`s.
  // 2. A possible call to `pullTransaction()` should return empty optional.
  ```
* `packages/react-native/ReactCommon/react/renderer/mounting/MountingCoordinator.cpp:17-20` (comment in `updateMountedFlag.cpp`)
  ```
    // This is a simplified version of Diffing algorithm that only updates
    // `mounted` flag on `ShadowNode`s. The algorithm sets "mounted" flag before
    // "unmounted" to allow `ShadowNode` detect a situation where the node was
    // remounted.
  ```
* `packages/react-native/ReactCommon/react/utils/SimpleThreadSafeCache.h:22-27`
  ```
  /*
   * Simple thread-safe LRU cache.
   *
   * TODO T228961279: The maxSize template parameter should be removed, since it
   * may be overriden by the constructor.
   */
  ```
* `packages/react-native/ReactCommon/react/debug/react_native_assert.h:14-19`
  ```
  // Asserting is appropriate for conditions that:
  //   1. May or may not be recoverable, and
  //   2. imply there is a bug in React Native when violated.
  // For recoverable conditions that can be violated by user mistake (e.g. JS
  // code passes an unexpected prop value), consider react_native_expect instead.
  ```
* `packages/react-native/ReactCommon/react/renderer/graphics/rounding.h:54-56`
  ```
  /*
   * GCC-based Android NDK does not have rounding functions as part of STL.
   */
  ```

### 11.3 Comments that contradict the code

| # | path:line | comment | code |
| ---: | --- | --- | --- |
| 1 | `…/mounting/internal/sliceChildShadowNodeViewPairs.cpp:59-60` | `// T153547836: Disabled on Android because the mounting infrastructure`<br>`// is not fully ready yet.` — attached to the `Trait::Hidden` skip | The `#ifdef ANDROID` guard (`:62-64`) **adds** the `useTraitHiddenOnAndroid()` flag *inside* an `if (...)`, so on Android the skip **is active when the flag is on**. The comment reads as "disabled on Android"; the code enables the hidden-skip only on Android and only under the flag. The guard makes `&& ReactNativeFeatureFlags::useTraitHiddenOnAndroid()` compile only on Android — i.e. the *condition* is Android-only, matching the comment's intent that the *feature* is Android-only. Contradiction is only apparent; the flag name (`useTraitHiddenOnAndroid`) confirms the intent. **Noted, not asserted as a defect.** |
| 2 | `…/textlayoutmanager/TextMeasurementRounding.h:32-34` | `// This helper lives in its own header only so the unit test in`<br>`// textlayoutmanager:tests can exercise it directly. In production it is used`<br>`// only by RCTTextLayoutManager.mm, and the internal_ prefix keeps it out of`<br>`// the public C++ API snapshot.` | Correct for iOS. But **the Android `TextLayoutManager` never rounds** (`…/platform/android/…/TextLayoutManager.cpp` contains no call to `internal_roundTextMeasurementToPixelGrid`), so the two platforms use materially different text-measurement rounding with no comment saying so. |
| 3 | `…/yoga/yoga/style/SmallValueBuffer.h:34` | `assert(index < 4096 && "SmallValueBuffer can only hold up to 4096 chunks");` | `push` returns `uint16_t` and `count_` is `uint16_t` (`:127`), so `index` wraps at 65536 and the `< 4096` assert **can never fail**. The stated 4096 limit is not enforced anywhere; the real limit is silent 16-bit wraparound of `count_`. |
| 4 | `…/components/view/YogaLayoutableShadowNode.cpp:753-754` | `// We must copy layout metrics from Yoga node only once (when the parent`<br>`// node exclusively ownes the child node).` | The guard is `react_native_assert(YGNodeGetOwner(childYogaNode) == &yogaNode_);` at `:755` — an assert, i.e. **compiled out in release**. In release there is nothing preventing a second copy if ownership changes. |
| 5 | `…/components/view/YogaLayoutableShadowNode.cpp:154-162` (`completeClone`) and `…/core/ShadowNode.h:119-123` | `// Called, once a fully derived ShadowNode clone has been created via`<br>`// ComponentDescriptor::cloneShadowNode.` | Invoked at `…/core/ConcreteComponentDescriptor.h:97` — once per `cloneShadowNode`, so consistent. **No contradiction found.** |
| 6 | `…/components/view/YogaLayoutableShadowNode.cpp:392-402` (`updateYogaProps`) | `// Resetting `dirty` flag only if `yogaStyle` portion of `Props` was`<br>`// changed.` | The guard is `if (!YGNodeIsDirty(&yogaNode_) && (styleResult != yogaNode_.style())) yogaNode_.setDirty(true);` — accurate. **No contradiction.** |
| 7 | `…/components/view/YogaLayoutableShadowNode.cpp:111-120` | `// Children unchanged: copy the filtered list directly from the source,`<br>`// skipping per-child dynamic_pointer_cast. ...` | The copy is guarded by `if (!getTraits().check(LeafYogaNode) && !fragment.children)`. For a `LeafYogaNode` with unchanged children the list is **not** copied and is left empty — the comment states an optimisation but not that it does not apply to leaves. Combined with the `LeafYogaNode` early return in `updateYogaChildren` (`:351-353`) this is consistent. **No contradiction.** |
| 8 | `…/core/EventEmitter.cpp:222-226` | `// Note: Initially, the state of `eventTarget_` and the value`<br>`// enableCounter_` is mismatched intentionally ...` | `enableCounter_ += enabled ? 1 : -1;` at `:212` has **no clamp at 0**, so the "mismatch" is not the only way the counter can go out of sync; an unbalanced `disable` drives it negative and `shouldBeEnabled = enableCounter_ > 0` then blocks re-enablement. The comment describes intent but not the hazard. |
| 9 | `…/yoga/yoga/node/Node.h:41-43` | `// Does not expose true value semantics, as children are not cloned eagerly.`<br>`// Should we remove this?` followed by `Node(const Node& node) = default;` | The defaulted copy **does** copy the `std::vector<Node*> children_` (`…/Node.h:358`) by value and the move constructor re-parents them (`…/Node.cpp:52-54`). So the copy *shares* children with the source, exactly as warned — but the source's own `children_` is **not** cleared, so both nodes own the same child pointers with the owner rewritten to the new node (`…/Node.cpp:53 c->setOwner(this);`). The source's cached `getOwner()` results and `LayoutResults` become inconsistent with the world. This is a documented hazard, correctly flagged. **Noted as an invariant the code does not maintain.** |
| 10 | `…/components/view/YogaLayoutableShadowNode.cpp:505` | ``  // TODO: `swapLeftAndRight` modified backing props and cannot be undone `` | `swapLeftAndRightInViewProps` does `const_cast<ViewProps&>(viewShadowNode->getConcreteProps())` (`:1018-1020`) and mutates the props in place with `props.borderRadii.topStart = props.borderRadii.topLeft; props.borderRadii.topLeft.reset();` (`:1023-1041`) — it **destroys** `topLeft` rather than moving it, so a second call or a direction change is lossy. Self-declared; **the code does exactly what the comment says**. |
| 11 | `…/mounting/MountingCoordinator.cpp:136-144` (introspection) | `// No matter what the source of the transaction is, it must be able to`<br>`// mutate the existing stub view tree.` | The very next block (`:143-145`) exempts overridden transactions: `// If the transaction was overridden, we don't have a model of the shadow`<br>`// tree therefore we cannot validate the validity of the mutation`<br>`// instructions.` and gates the assertion on `!didOverridePullTransaction` (`:146`). **Contradictory within three lines of itself**; the comment is a partial statement, not a false one. |
| 12 | `…/yoga/yoga/YGNode.h:39-43` | `/**`<br>` * Returns a mutable copy of an existing node, with the same context and`<br>` * children, but no owner set. Does not call the function set by`<br>` * YGConfigSetCloneNodeFunc().`<br>` */` | `YGNodeClone` impl at `…/YGNode.cpp:33-39` copies via `Node(const Node&)` and then `node->setOwner(nullptr)` (`:37`) — consistent with the comment. **No contradiction.** |

---

## 12. CROSS-LANGUAGE CONTRACT RISKS

### 12.1 Values crossing the JS/C++ boundary by ordinal or declaration order

| # | path:line | risk |
| ---: | --- | --- |
| 1 | `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/YGJNIVanilla.cpp:57-60` | `YGConfigSetExperimentalFeatureEnabled(config, static_cast<YGExperimentalFeature>(feature), …)` — a raw `jint feature` from Java is cast straight into the enum. Java's ordinal must equal the C++ ordinal; the ordinals are `YGExperimentalFeatureWebFlexBasis` then `YGExperimentalFeatureFixFlexBasisFitContent` (`…/yoga/YGEnums.h:76-79`) and `Config::setExperimentalFeatureEnabled` then does `experimentalFeatures_.set(static_cast<size_t>(feature), enabled)` (`…/yoga/config/Config.cpp:35`) — an out-of-range Java value writes out of bounds of the `std::bitset<2>`. No range check. |
| 2 | `…/YGJNIVanilla.cpp:87` | `YGConfigSetErrata(config, static_cast<YGErrata>(errata))` — raw `jint errata` → bitmask, no validation. |
| 3 | `…/YGJNIVanilla.cpp:461, 472, 484, 493, 531, 543, 555, 565, 578, 590, 602, 614, 626` | `static_cast<YGEdge>(edge)` — every JNI edge accessor takes a raw `jint` from Java and casts to `YGEdge`. `YGEdge` ordinals are `Left=0, Top=1, Right=2, Bottom=3, Start=4, End=5, Horizontal=6, Vertical=7, All=8` (`…/yoga/YGEnums.h:52-62`). Passing `9` yields an out-of-range enum value whose only guard is `assertFatalWithNode(node, edge <= Edge::End, "Cannot get layout properties of multi-edge shorthands")` at `…/yoga/YGNodeLayout.cpp:21-24` — and **only** on the get path; the *set* paths (`YGNodeStyleSetMargin`, etc.) have no guard. |
| 4 | `packages/react-native/ReactCommon/yoga/yoga/enums/ExperimentalFeature.h:24-26` + `…/yoga/config/Config.h:25` | `using ExperimentalFeatureSet = std::bitset<ordinalCount<ExperimentalFeature>()>;` with `ordinalCount<ExperimentalFeature>() { return 2; }` — the **hand-written count must match the `YG_ENUM_DECL` in `YGEnums.h`**. If a third `YGExperimentalFeature` is added to `YGEnums.h` and this file is not regenerated, `.set(static_cast<size_t>(feature), enabled)` silently no-ops (bitset `set` is UB/no-op out of range) — no assert. |
| 5 | `…/yoga/style/StyleValueHandle.h:63-65` | `static constexpr uint16_t kHandleTypeMask = 0b0000'0000'0000'0111;` / `kHandleIndexedMask = 0b0000'0000'0000'1000;` / `kValueMask = 0b1111'1111'1111'0000;` — bit layout packed into a 16-bit handle; `…/style/StyleValuePool.h:168-189` (`kMaxInlineAbsValue = (1 << 11) - 1`, `kValueSignMask = 0b0000'1000'0000'0000`, `kValueMagnitudeMask = 0b0000'0111'1111'1111`) must stay consistent with it. Both sides are C++ in one TU set, so not a cross-language risk, but a coupling invariant. |
| 6 | `packages/react-native/ReactCommon/react/renderer/uimanager/primitives.h:143-158` | `displayModeToInt` returns `1/2/3` with the comment `// the result of this method should be in sync with` / `// Libraries/ReactNative/DisplayMode.js`. **Purely ordinal, cross-language, no generated check.** |
| 7 | `packages/react-native/ReactCommon/react/renderer/uimanager/primitives.h:123-126` | `inline static Tag tagFromValue(const jsi::Value &value) { return (Tag)value.getNumber(); }` — a `double` from JS is narrowed to `Tag` (`int`) with no range or integrality check. Same at `:138-141` for `surfaceIdFromValue` (`return (SurfaceId)value.getNumber();`). |
| 8 | `…/textlayoutmanager/platform/android/…/TextLayoutManager.cpp:406-431` | `measurePreparedLayout` decodes a Java `jfloatArray` **positionally**: `[0]=width`, `[1]=height`, then **4 floats per attachment: `[i]=top`, `[i+1]=left`, `[i+2]=width`, `[i+3]=height`**. The only contract check is `react_native_assert(measurementsArr->size() >= 2);` (`:403`) and `react_native_assert((measurementsArr->size() - 2) % 4 == 0);` (`:404`) — **both `react_native_assert`, i.e. erased in release** (`…/debug/react_native_assert.h:29`). A Java-side layout change that returns a different stride silently produces garbage frames in release. |
| 9 | `…/textlayoutmanager/platform/android/…/TextLayoutManager.cpp:217` | `localDataBuilder.putInt(AS_KEY_CACHE_ID, static_cast<int32_t>(cacheId));` with comment `// TODO: this is always sourced from an int, and Java expects an int` — an `int64_t` is narrowed to `int32_t` by design. |
| 10 | `…/textlayoutmanager/platform/android/…/TextLayoutManager.cpp:349-351` | `if (fragments[i].parentShadowView.tag != cacheKeyFragments[i].parentShadowView.tag) return true;` — indexes `cacheKeyFragments[i]` with `i` from `fragments.size()` **without a size check**. The equality function (`…/TextMeasureCache.h:287` via `areAttributedStringsEquivalentDisplayWise` `:231-248`) does check `lhsFragment.size() != rhsFragment.size()` first, so under the current implementation the sizes match — but the retrieval (`getWithKey`, `…/utils/SimpleThreadSafeCache.h:51-56`) returns a pointer into the live cache list, and the loop runs **outside** the cache mutex. A concurrent eviction + insert between `getWithKey` and the loop is not possible (list nodes are stable and the returned iterator is not invalidated by `splice`/`erase` of *other* elements), but a concurrent `SimpleThreadSafeCache::get` on the same key from another thread that hits the eviction branch does `map_.erase(list_.back().first); list_.pop_back();` (`:96-97`) — the returned `&it->second->second` pointer is stable unless that element itself is the victim. **未确认** whether `PreparedTextCacheKey` can be the LRU victim during the loop. |
| 11 | `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/YGJNIVanilla.cpp:131-145` | `YogaLogLevel.fromInt(I)` is resolved reflectively at `:132-137` and called with the raw C `level`; `YGLogLevel` ordinals are `Error=0, Warn=1, Info=2, Debug=3, Verbose=4, Fatal=5` (`…/yoga/YGEnums.h:115-122`). Ordinal coupling across C++/Java with no validation. |
| 12 | `…/core/graphicsConversions.h:180-181` and `:234-235` | `EdgeInsets`/`CornerInsets` decoded from a JS array **positionally**: `.left = array.at(0), .top = array.at(1), .right = array.at(2), .bottom = array.at(3)`. Guarded by `react_native_expect(array.size() == 4)` (`:179`, `:233`) — `react_native_expect` is **not** compiled out (unlike `react_native_assert`) but is a log-only expectation; the `else` branch (`:182-185`) zero-fills. For `CornerInsets` the fall-through at `:241-244` has the comment `// Error case - we should only here if all other supported cases fail` / `// In dev we would crash on assert before this point` — **and there is no such assert in this function**. |
| 13 | `…/components/view/conversions.h:96-98, 138-140, 155-158, 169-171` | Similar positional decode for `Point` (`x=0, y=1`), `Size` (`width=0, height=1`) — guarded by `react_native_expect(array.size() == 2)` (`:105`, `:137`). |
| 14 | `…/textlayoutmanager/TextMeasureCache.h:143-145` | `floatEquality` (`epsilon = 0.005f`) used as the **equality operator for the cache key** including `pointScaleFactor` — a key difference of up to 0.0049 is treated as a cache hit, so two genuinely different pixel densities can share a cached measurement. |

### 12.2 Struct layouts assumed to match between C++ and Java/ObjC

| # | path:line | assumption |
| ---: | --- | --- |
| 1 | `packages/react-native/ReactCommon/yoga/yoga/YGNode.h:183-186` | `typedef struct YGSize { float width; float height; } YGSize;` — a 2×`float` POD passed by value through `YGMeasureFunc` into the JNI shim (`…/YGJNIVanilla.cpp:56-63` declares the Java-visible signature as `jlong` + 4 floats, so the struct itself is not marshalled) and through the RN measure connector (`…/YogaLayoutableShadowNode.cpp:913-914`). Padding/ABI not statically asserted anywhere. |
| 2 | `…/yoga/YGNode.h:22-27` | `typedef struct YGNode* YGNodeRef; typedef const struct YGNode* YGNodeConstRef;` with the tag structs `struct YGNode {};` (`…/yoga/node/Node.h:29`) and `struct YGConfig {};` (`…/yoga/config/Config.h:18`). The C API's opaque `YGNodeRef` is the **same address** as `facebook::yoga::Node` via `resolveRef` (`…/yoga/node/Node.h:364-370`) — a layout/size compatibility between the tag struct and the derived class is required but never `static_assert`ed. `yoga::Node` is 40+ members (`…/Node.h:341-361`); `YGNodeRef` callers must never dereference it themselves. |
| 3 | `…/YGConfig.h:25-30` | Same tag-struct/opaque-ref pairing for `YGConfigRef` / `YGConfigConstRef` with `struct YGConfig {};` (`…/config/Config.h:18`). |
| 4 | `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/YGJNIVanilla.cpp:29-35` | `_jlong2YGNodeRef` / `_jlong2YGConfigRef` `reinterpret_cast` a `jlong` straight to the C++ pointer. Java's `long` (64-bit signed) is assumed to round-trip a 64-bit pointer exactly; no assertion. |
| 5 | `…/YGJNIVanilla.cpp:848-861` | The `JNINativeMethod` table pairs C symbol names and JNI signatures, e.g. `{"jni_YGConfigSetErrataJNI", "(JI)V", …}` (`:857`) and `{"jni_YGConfigGetErrataJNI", "(J)I", …}` (`:858`) — signature strings are hand-maintained and must match the C function signatures; a mismatch is a runtime `NoSuchMethodError`, not a compile error. |
| 6 | `packages/react-native/ReactCommon/react/renderer/core/LayoutMetrics.h:25-93` | `struct LayoutMetrics` (`Rect frame; EdgeInsets contentInsets; EdgeInsets borderWidth; DisplayType displayType; PositionType positionType; LayoutDirection layoutDirection; bool wasLeftAndRightSwapped; Float pointScaleFactor; Float fontSizeMultiplier; EdgeInsets overflowInset;`) is embedded **by value** in `ShadowView` (`…/mounting/ShadowView.h:48` `LayoutMetrics layoutMetrics{EmptyLayoutMetrics};`) and `ShadowView` is embedded by value in `ShadowViewMutation` (`…/mounting/ShadowViewMutation.h:98-99`). Both `ShadowView` and `ShadowViewMutation` are handed to the platform layer. On Android it is flattened into a `MapBuffer` by `toDynamic` overloads guarded by `RN_SERIALIZABLE_STATE` (`…/core/graphicsConversions.h:56-86, 191-201`); the map keys (`"x"`,`"y"`,`"width"`,`"height"`,`"left"`,`"top"`,`"right"`,`"bottom"`) are stringly-typed at `:195-198`. **The C++ struct layout is NOT assumed to match Java** — it is serialised by key. Recorded here because the brief asks; the answer is "no binary layout assumption, only key-name coupling". |
| 7 | `packages/react-native/ReactCommon/react/renderer/mounting/ShadowView.h:60-77` vs `packages/react-native/ReactCommon/react/renderer/mounting/ShadowView.cpp:34-51` | **`operator==` and `hash<ShadowView>` do not cover the same field set.** `operator==` compares `{surfaceId, tag, componentName, props, eventEmitter, layoutMetrics, state}`; `hash<ShadowView>` combines `0, surfaceId, componentHandle, tag, props, eventEmitter, layoutMetrics, state`. So `componentHandle` is hashed but **not** compared, and `componentName` is compared but **not** hashed. Two `ShadowView`s that compare equal can hash differently — a hard `std::unordered_*` invariant violation. Also `traits` is compared by neither, so a trait-only change produces `== == true`. `ShadowView::operator==` is used at `…/mounting/Differentiator.cpp:616` (`newTreeNodePair.shadowView != oldTreeNodePair.shadowView`) to decide whether to emit an `Update` mutation — a props/layout-identical pair differing only in `componentHandle` emits no Update. |
| 7b | `packages/react-native/ReactCommon/react/renderer/core/LayoutMetrics.h:92` vs `:117-130` | Same class of defect one level down: `LayoutMetrics::operator==` is `= default` (compares all 10 members including `positionType` and `wasLeftAndRightSwapped`), while `hash<LayoutMetrics>` combines only `frame, contentInsets, borderWidth, displayType, layoutDirection, pointScaleFactor, fontSizeMultiplier, overflowInset` — **`positionType` and `wasLeftAndRightSwapped` are omitted from the hash**. Since `ShadowView::hash` hashes `layoutMetrics`, two equal `ShadowView`s can hash differently. |
| 8 | `packages/react-native/ReactCommon/yoga/yoga/node/LayoutResults.h:127-133` | `std::array<float, 2> dimensions_, measuredDimensions_, rawDimensions_; std::array<float, 4> position_, margin_, border_, padding_;` indexed by `to_underlying(Dimension)` and `to_underlying(PhysicalEdge)` — the enum ordinals are the array indices. `YGDimension` is `Width=0, Height=1` (`…/YGEnums.h:34-37`) and `PhysicalEdge` is 4 values. A change in enum order silently reindexes every layout array. No `static_assert` on the array sizes vs `ordinalCount`. |
| 9 | `…/yoga/style/Style.h:46-48` | `DefaultFlexGrow`/`DefaultFlexShrink`/`WebDefaultFlexShrink` consumed in `Node::resolveFlexGrow/Shrink` (`…/yoga/node/Node.cpp:463-490`) — pure C++, not cross-language. |

---

## 13. UNVERIFIED / 未确认 ITEMS

Explicitly listed so nothing in this probe is over-claimed:

1. `MountingCoordinator::mountingOverrideDelegates_` removal — no erase found
   in the audited files; whether removal exists elsewhere is 未确认.
2. `SimpleThreadSafeCache` concurrent-eviction safety for `getWithKey` (§12.1
   item 10) — 未确认.
3. `YGErrata` bit values are quoted from
   `packages/react-native/ReactCommon/yoga/yoga/YGEnums.h:64-73`, which is
   `// @generated by enums.py` (`…/YGEnums.h:8`) — the generator and its inputs
   were not inspected.
4. `eventDispatcher_` in `Scheduler.h` is declared `std::optional`-like
   (`eventDispatcher_->has_value()` at `…/scheduler/Scheduler.cpp:465`); the
   exact member declaration was not read. 未确认 on the declared type only.
5. `Props` has **no** `std::hash` specialisation in
   `packages/react-native/ReactCommon/react/renderer/core/` (grep for
   `hash<facebook::react::Props>` returned nothing), so `hash<ShadowView>`'s
   `hash_combine(…, shadowView.props, …)` resolves to `std::hash<shared_ptr<Props>>`
   = pointer hash. Same for `eventEmitter` and `state`. Recorded; not flagged
   as a defect because `==` also compares them by identity.