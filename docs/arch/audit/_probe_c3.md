# Probe C3 — Android JNI glue layer audit

Scope: `packages/react-native/ReactAndroid/src/main/jni/` and `packages/react-native/ReactAndroid/src/main/jni/react/` (all subdirs).
All paths below are repo-relative. Base dir for "path:N" shorthand is the repository root.

---

## 1. FILE INVENTORY

### 1.1 Counts

Command used (run from repo root):

```
find packages/react-native/ReactAndroid/src/main/jni/ -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.c' \) | wc -l
find packages/react-native/ReactAndroid/src/main/jni/ -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.c' \) | xargs wc -l | tail -1
```

| Metric | Value |
| --- | --- |
| Files in whole `jni/` tree (.cpp/.h/.c) | **189** |
| Lines in whole `jni/` tree | **18888** |
| Files under `jni/react/` | **165** |
| Lines under `jni/react/` | **14573** |
| Files under `jni/first-party/` | **23** |
| Lines under `jni/first-party/` | **4133** |
| Files under `jni/third-party/` | **1** (`third-party/glog/config.h`, 182 lines) |
| Test-path files (`*/test/*`, `*/tests/*`, `*/test_helper/*`) | **11** files / **1321** lines |
| **Non-test files (excluding `*/test/*`, `*/tests/*`, `*/test_helper/*`)** | **178** |
| **Non-test lines (same exclusion)** | **17567** |
| Non-test lines excluding the 2 vendored `first-party/jni-hack/*.h` shim headers | **16210** (178 files minus `jni.h` files) |

There are **zero** source files at the top level of `jni/` (`find . -maxdepth 1 -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.c' \)` returns nothing). All 189 files live in `first-party/`, `third-party/` and `react/`.

### 1.2 The 30 largest files by `wc -l`

Command: `find . -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.c' \) | xargs wc -l | sort -rn | head -35` (from `packages/react-native/ReactAndroid/src/main/jni/`).

| # | Lines | Path |
| --- | --- | --- |
| 1 | 1343 | `packages/react-native/ReactAndroid/src/main/jni/first-party/jni-hack/real/jni.h` |
| 2 | 1326 | `packages/react-native/ReactAndroid/src/main/jni/react/featureflags/JReactNativeFeatureFlagsCxxInterop.cpp` |
| 3 | 1280 | `packages/react-native/ReactAndroid/src/main/jni/react/fabric/FabricMountingManager.cpp` |
| 4 | 1178 | `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/YGJNIVanilla.cpp` |
| 5 | 957 | `packages/react-native/ReactAndroid/src/main/jni/react/fabric/FabricUIManagerBinding.cpp` |
| 6 | 353 | `packages/react-native/ReactAndroid/src/main/jni/react/turbomodule/ReactCommon/TurboModuleManager.cpp` |
| 7 | 337 | `packages/react-native/ReactAndroid/src/main/jni/react/runtime/jni/JReactHostInspectorTarget.cpp` |
| 8 | 331 | `packages/react-native/ReactAndroid/src/main/jni/react/runtime/jni/JReactHostInspectorTarget.h` |
| 9 | 320 | `packages/react-native/ReactAndroid/src/main/jni/react/jni/MethodInvoker.cpp` |
| 10 | 314 | `packages/react-native/ReactAndroid/src/main/jni/react/featureflags/JReactNativeFeatureFlagsCxxInterop.h` |
| 11 | 282 | `packages/react-native/ReactAndroid/src/main/jni/react/devsupport/JInspectorNetworkReporter.cpp` |
| 12 | 279 | `packages/react-native/ReactAndroid/src/main/jni/react/fabric/FocusOrderingHelper.cpp` |
| 13 | 247 | `packages/react-native/ReactAndroid/src/main/jni/react/runtime/jni/JReactInstance.cpp` |
| 14 | 241 | `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/tests/corefunctionsTest.cpp` *(test)* |
| 15 | 241 | `packages/react-native/ReactAndroid/src/main/jni/react/tracing/PerformanceTracerCxxInterop.cpp` |
| 16 | 182 | `packages/react-native/ReactAndroid/src/main/jni/third-party/glog/config.h` |
| 17 | 175 | `packages/react-native/ReactAndroid/src/main/jni/react/fabric/FabricUIManagerBinding.h` |
| 18 | 164 | `packages/react-native/ReactAndroid/src/main/jni/react/jni/test/JArrayBufferTest.cpp` *(test)* |
| 19 | 158 | `packages/react-native/ReactAndroid/src/main/jni/react/jni/JReactMarker.cpp` |
| 20 | 158 | `packages/react-native/ReactAndroid/src/main/jni/react/jni/JavaModuleWrapper.cpp` |
| 21 | 158 | `packages/react-native/ReactAndroid/src/main/jni/first-party/jni-lib-merge/jni_lib_merge.c` |
| 22 | 151 | `packages/react-native/ReactAndroid/src/main/jni/react/reactnativeblob/test/BlobCollectorTest.cpp` *(test)* |
| 23 | 151 | `packages/react-native/ReactAndroid/src/main/jni/react/fabric/test/FabricMountingManagerTest.cpp` *(test)* |
| 24 | 141 | `packages/react-native/ReactAndroid/src/main/jni/react/fabric/test/MountItemTest.cpp` *(test)* |
| 25 | 141 | `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/ScopedLocalRef.h` |
| 26 | 140 | `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/ScopedGlobalRef.h` |
| 27 | 139 | `packages/react-native/ReactAndroid/src/main/jni/first-party/fbgloginit/glog_init.cpp` |
| 28 | 133 | `packages/react-native/ReactAndroid/src/main/jni/react/jni/ReadableNativeMap.cpp` |
| 29 | 129 | `packages/react-native/ReactAndroid/src/main/jni/react/jni/JArrayBuffer.cpp` |
| 30 | 121 | `packages/react-native/ReactAndroid/src/main/jni/react/hermes/reactexecutor/OnLoad.cpp` |

### 1.3 Per-file line counts (all 178 non-test files, sorted desc)

`wc -l` output, from `packages/react-native/ReactAndroid/src/main/jni/`:

```
16210 total
   1326 ./react/featureflags/JReactNativeFeatureFlagsCxxInterop.cpp
   1280 ./react/fabric/FabricMountingManager.cpp
   1178 ./first-party/yogajni/jni/YGJNIVanilla.cpp
    957 ./react/fabric/FabricUIManagerBinding.cpp
    353 ./react/turbomodule/ReactCommon/TurboModuleManager.cpp
    337 ./react/runtime/jni/JReactHostInspectorTarget.cpp
    331 ./react/runtime/jni/JReactHostInspectorTarget.h
    320 ./react/jni/MethodInvoker.cpp
    314 ./react/featureflags/JReactNativeFeatureFlagsCxxInterop.h
    282 ./react/devsupport/JInspectorNetworkReporter.cpp
    279 ./react/fabric/FocusOrderingHelper.cpp
    247 ./react/runtime/jni/JReactInstance.cpp
    241 ./react/tracing/PerformanceTracerCxxInterop.cpp
    182 ./third-party/glog/config.h
    175 ./react/fabric/FabricUIManagerBinding.h
    158 ./react/jni/JReactMarker.cpp
    158 ./react/jni/JavaModuleWrapper.cpp
    158 ./first-party/jni-lib-merge/jni_lib_merge.c
    141 ./first-party/yogajni/jni/ScopedLocalRef.h
    140 ./first-party/yogajni/jni/ScopedGlobalRef.h
    139 ./first-party/fbgloginit/glog_init.cpp
    133 ./react/jni/ReadableNativeMap.cpp
    129 ./react/jni/JArrayBuffer.cpp
    121 ./react/hermes/reactexecutor/OnLoad.cpp
    116 ./react/fabric/FabricMountingManager.h
    114 ./react/runtime/jni/JReactExceptionManager.cpp
    109 ./first-party/yogajni/jni/common.cpp
    107 ./react/jni/WritableNativeMap.cpp
    106 ./react/fabric/MountItem.cpp
    105 ./first-party/jni-lib-merge/jni_lib_merge.h
    103 ./react/jni/JniJSModulesUnbundle.cpp
     99 ./react/jni/JMessageQueueThread.cpp
     98 ./react/devsupport/JInspectorNetworkReporter.h
     97 ./react/runtime/jni/JReactInstance.h
     96 ./react/jni/WritableNativeArray.cpp
     93 ./react/jni/JSLoader.cpp
     92 ./react/newarchdefaults/DefaultTurboModuleManagerDelegate.cpp
     92 ./react/jni/SafeReleaseJniRef.h
     92 ./react/fabric/SurfaceHandlerBinding.cpp
     92 ./react/fabric/EventEmitterWrapper.cpp
     92 ./react/fabric/CoreComponentsRegistry.cpp
     91 ./first-party/yogajni/jni/corefunctions.cpp
     89 ./react/jni/JArrayBuffer.h
     88 ./react/jni/JavaModuleWrapper.h
     84 ./react/reactnativeblob/BlobCollector.cpp
     84 ./react/fabric/StateWrapperImpl.cpp
     78 ./react/mapbuffer/react/common/mapbuffer/JWritableMapBuffer.cpp
     77 ./first-party/yogajni/jni/YGJNI.h
     76 ./react/jni/InspectorNetworkRequestListener.cpp
     75 ./react/turbomodule/ReactCommon/TurboModuleManager.h
     75 ./react/devsupport/JCxxInspectorPackagerConnectionDelegateImpl.cpp
     73 ./first-party/yogajni/jni/common.h
     72 ./react/uimanager/UIConstantsProviderBinding.h
     72 ./react/devsupport/JCxxInspectorPackagerConnectionWebSocketDelegate.cpp
     72 ./react/devsupport/JCxxInspectorPackagerConnectionWebSocket.cpp
     71 ./react/jni/MethodInvoker.h
     69 ./react/newarchdefaults/DefaultComponentsRegistry.cpp
     68 ./react/fabric/MountItem.h
     66 ./react/uimanager/UIConstantsProviderBinding.cpp
     63 ./react/tracing/PerformanceTracerCxxInterop.h
     63 ./react/jni/NativeCommon.cpp
     62 ./react/jni/TransformHelper.cpp
     62 ./react/devsupport/JCxxInspectorPackagerConnection.h
     61 ./react/jni/JByteBufferMutableBuffer.h
     61 ./react/devsupport/JCxxInspectorPackagerConnectionDelegateImpl.h
     59 ./react/uimanager/ComponentNameResolverBinding.cpp
     57 ./react/devsupport/JCxxInspectorPackagerConnection.cpp
     56 ./react/jni/ReadableNativeArray.cpp
     56 ./react/jni/JDynamicNative.h
     56 ./react/devsupport/JInspectorFlags.cpp
     55 ./react/fabric/SurfaceHandlerBinding.h
     55 ./react/fabric/EventBeatManager.h
     54 ./react/jni/NativeArray.h
     54 ./react/devsupport/JCxxInspectorPackagerConnectionWebSocket.h
     52 ./react/newarchdefaults/DefaultTurboModuleManagerDelegate.h
     52 ./react/jni/ReadableNativeMap.h
     52 ./first-party/yogajni/jni/YGJTypesVanilla.h
     50 ./react/jni/JCallback.h
     50 ./first-party/yogajni/jni/corefunctions.h
     49 ./react/jni/JDynamicNative.cpp
     49 ./first-party/yogajni/jni/YogaJniException.cpp
     48 ./react/jni/ModuleRegistryBuilder.cpp
     48 ./react/jni/JMessageQueueThread.h
     48 ./react/fabric/AndroidEventBeat.h
     47 ./react/jni/NativeMap.h
     47 ./react/fabric/AndroidEventBeat.cpp
     46 ./react/jni/WritableNativeMap.h
     46 ./react/jni/NativeArray.cpp
     45 ./react/fabric/EventBeatManager.cpp
     45 ./react/devsupport/JCxxInspectorPackagerConnectionWebSocketDelegate.h
     44 ./react/jni/WritableNativeArray.h
     44 ./react/hermes/instrumentation/HermesSamplingProfiler.cpp
     42 ./react/runtime/hermes/jni/JHermesInstance.h
     42 ./react/jni/JniJSModulesUnbundle.h
     41 ./react/jni/OnLoad.cpp
     40 ./react/runtime/jni/JJSTimerExecutor.cpp
     40 ./react/fabric/StateWrapperImpl.h
     40 ./react/fabric/FocusOrderingHelper.h
     39 ./react/reactnativeblob/BlobCollector.h
     39 ./react/jni/NativeCommon.h
     39 ./react/jni/ModuleRegistryBuilder.h
     38 ./react/runtime/jni/JJSTimerExecutor.h
     38 ./react/jni/ReadableNativeArray.h
     38 ./react/jni/InspectorNetworkRequestListener.h
     38 ./react/fabric/AndroidAnimationChoreographer.h
     37 ./react/runtime/jni/JavaTimerRegistry.h
     37 ./react/mapbuffer/react/common/mapbuffer/JReadableMapBuffer.cpp
     37 ./react/jni/NativeMap.cpp
     36 ./react/jni/JavaScriptExecutorHolder.h
     35 ./react/jni/OnLoad-common.cpp
     35 ./react/fabric/AndroidEventBeat.h   (duplicate of line 48 above; see note)
     35 ./first-party/yogajni/jni/YogaJniException.h
     34 ./react/turbomodule/ReactCommon/BindingsInstallerHolder.h
     34 ./react/newarchdefaults/DefaultComponentsRegistry.h
     34 ./react/mapbuffer/react/common/mapbuffer/JReadableMapBuffer.h
     34 ./first-party/yogajni/jni/LayoutContext.cpp
     33 ./react/turbomodule/ReactCommon/TurboModuleManagerDelegate.h
     33 ./react/hermes/instrumentation/HermesSamplingProfiler.h
     33 ./react/fabric/EventEmitterWrapper.h
     32 ./react/turbomodule/ReactCommon/OnLoad.cpp
     32 ./react/runtime/hermes/jni/JHermesInstance.cpp
     32 ./react/devsupport/JInspectorFlags.h
     31 ./react/turbomodule/ReactCommon/NativeMethodCallInvokerHolder.h
     31 ./react/turbomodule/ReactCommon/CallInvokerHolder.h
     31 ./react/turbomodule/ReactCommon/BindingsInstallerHolder.cpp
     31 ./react/jni/JReactMarker.h
     30 ./react/runtime/jni/JJavaTimerManager.cpp
     30 ./react/runtime/jni/JavaTimerRegistry.cpp
     30 ./react/runtime/cxxreactpackage/ReactCommon/CxxReactPackage.h
     30 ./react/jni/SafeReleaseJniRef.cpp
     30 ./react/jni/JSLoader.h
     30 ./react/fabric/ComponentFactory.h
     29 ./first-party/yogajni/jni/LayoutContext.h
     28 ./react/runtime/jni/JBindingsInstaller.h
     28 ./react/fabric/ComponentFactory.cpp
     27 ./react/uimanager/ComponentNameResolverBinding.h
     27 ./react/jni/JRuntimeScheduler.h
     27 ./react/jni/JRuntimeExecutor.h
     26 ./react/reactperflogger/reactperflogger/JNativeModulePerfLogger.h
     26 ./react/fabric/OnLoad.cpp
     25 ./react/runtime/jni/JJavaTimerManager.h
     25 ./react/devsupport/OnLoad.cpp
     24 ./react/runtime/jni/JJSRuntimeFactory.h
     24 ./react/jni/JReactSoftExceptionLogger.cpp
     23 ./react/runtime/jni/JReactExceptionManager.h
     23 ./react/jni/JWeakRefUtils.h
     23 ./react/fabric/JFabricUIManager.h
     23 ./first-party/yogajni/jni/macros.h
     22 ./react/runtime/jni/OnLoad.cpp
     22 ./react/mapbuffer/react/common/mapbuffer/JWritableMapBuffer.h
     22 ./react/jni/JSLogging.cpp
     22 ./react/jni/JRuntimeScheduler.cpp
     22 ./react/jni/JReactSoftExceptionLogger.h
     21 ./react/jni/TransformHelper.h
     21 ./react/jni/JRuntimeExecutor.cpp
     21 ./react/jni/JExecutor.h
     20 ./react/newarchdefaults/rncore.h
     20 ./react/fabric/JFabricUIManager.cpp
     19 ./react/uimanager/StateWrapper.h
     18 ./react/uimanager/OnLoad.cpp
     18 ./react/newarchdefaults/OnLoad.cpp
     18 ./react/jni/JExecutor.cpp
     18 ./react/jni/CxxModuleWrapperBase.h
     18 ./react/fabric/CoreComponentsRegistry.h
     18 ./first-party/yogajni/jni/yogajni.cpp
     16 ./react/turbomodule/ReactCommon/NativeMethodCallInvokerHolder.cpp
     16 ./react/tracing/OnLoad.cpp
     16 ./react/jni/JSLogging.h
     16 ./react/featureflags/OnLoad.cpp
     16 ./first-party/fbgloginit/fb/glog_init.h
     15 ./react/turbomodule/ReactCommon/CallInvokerHolder.cpp
     15 ./react/runtime/hermes/jni/OnLoad.cpp
     15 ./react/reactnativeblob/OnLoad.cpp
     14 ./react/hermes/instrumentation/OnLoad.cpp
     12 ./react/fabric/Binding.h
     12 ./first-party/yogajni/jni/YGJNIVanilla.h
```

Note on the two `35 ./react/fabric/AndroidEventBeat.h` entries in my manual transcription: the raw `wc -l` output has it once. The duplicate above is a transcription artifact, not a file. `AndroidEventBeat.h` is 35 lines.

Additional non-test files NOT in the `.cpp/.h/.c` wc list but present in the tree (not counted in the numbers above): none relevant — all CMake/gradle build files.

---

## 2. JNI ENTRY POINTS

### 2.1 Every `JNIEXPORT` occurrence (exact, with line numbers)

Command: `grep -rn 'JNIEXPORT' --include='*.cpp' --include='*.h' --include='*.c' .` from `packages/react-native/ReactAndroid/src/main/jni/`.

| Count | Path:line | Symbol / context |
| --- | --- | --- |
| 1 | `packages/react-native/ReactAndroid/src/main/jni/first-party/jni-lib-merge/jni_lib_merge.h:47` | `JNIEXPORT jint JNICALL JNI_OnLoad_Weak(JavaVM *vm, void *reserved);` (declaration) |
| 2 | `packages/react-native/ReactAndroid/src/main/jni/first-party/jni-hack/real/jni.h:1310` | `#define JNIEXPORT __attribute__((visibility("default")))` (vendored NDK header) |
| 3 | `packages/react-native/ReactAndroid/src/main/jni/first-party/jni-hack/real/jni.h:1317` | `JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved);` (vendored NDK header) |
| 4 | `packages/react-native/ReactAndroid/src/main/jni/first-party/jni-hack/real/jni.h:1318` | `JNIEXPORT void JNI_OnUnload(JavaVM *vm, void *reserved);` (vendored NDK header) |
| 5 | `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/corefunctions.cpp:44` | `// TODO why we need JNIEXPORT for getCurrentEnv ?` |
| 6 | `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/corefunctions.cpp:45` | `JNIEXPORT JNIEnv* getCurrentEnv() {` — **`getCurrentEnv`, an ordinary C++ helper, exported with the JNIEXPORT macro.** This is the only non-`JNI_OnLoad` JNIEXPORT. |
| 7 | `packages/react-native/ReactAndroid/src/main/jni/react/tracing/OnLoad.cpp:12` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` |
| 8 | `packages/react-native/ReactAndroid/src/main/jni/react/runtime/hermes/jni/OnLoad.cpp:12` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` |
| 9 | `packages/react-native/ReactAndroid/src/main/jni/react/runtime/jni/OnLoad.cpp:15` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` |
| 10 | `packages/react-native/ReactAndroid/src/main/jni/react/newarchdefaults/OnLoad.cpp:13` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` |
| 11 | `packages/react-native/ReactAndroid/src/main/jni/react/turbomodule/ReactCommon/OnLoad.cpp:22` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` |
| 12 | `packages/react-native/ReactAndroid/src/main/jni/react/devsupport/OnLoad.cpp:15` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` |
| 13 | `packages/react-native/ReactAndroid/src/main/jni/react/fabric/test_helper/OnLoad.cpp:12` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` *(test_helper)* |
| 14 | `packages/react-native/ReactAndroid/src/main/jni/react/fabric/OnLoad.cpp:17` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` |
| 15 | `packages/react-native/ReactAndroid/src/main/jni/react/hermes/reactexecutor/OnLoad.cpp:114` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* reserved) {` |
| 16 | `packages/react-native/ReactAndroid/src/main/jni/react/hermes/instrumentation/OnLoad.cpp:10` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` |
| 17 | `packages/react-native/ReactAndroid/src/main/jni/react/featureflags/OnLoad.cpp:12` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` |
| 18 | `packages/react-native/ReactAndroid/src/main/jni/react/jni/OnLoad-common.cpp:20` | `extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void* reserved) {` |
| 19 | `packages/react-native/ReactAndroid/src/main/jni/react/jni/OnLoad.cpp:26` | `extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void* reserved) {` |
| 20 | `packages/react-native/ReactAndroid/src/main/jni/react/reactnativeblob/OnLoad.cpp:12` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` |
| 21 | `packages/react-native/ReactAndroid/src/main/jni/react/uimanager/OnLoad.cpp:13` | `JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` |

**Counts (measured):**
- Total `JNIEXPORT` text occurrences in the whole `jni/` tree: **21** (`grep -rn 'JNIEXPORT' ... | wc -l`).
- Of those, **3** are inside the vendored NDK header `first-party/jni-hack/real/jni.h`, **1** is a comment, **1** is the non-`JNI_OnLoad` helper `getCurrentEnv`, **1** is the `JNI_OnLoad_Weak` declaration in `jni_lib_merge.h`, leaving **15** actual `JNI_OnLoad` function definitions.
- Non-test, non-`jni-hack` `JNIEXPORT` occurrences: **14** (`grep -rn 'JNIEXPORT' ... | grep -v jni-hack | grep -v /test | wc -l`) — i.e. 13 `JNI_OnLoad` definitions + the `getCurrentEnv` helper.
- **There are ZERO statically-named Java↔native bindings.** No function in this tree is named `Java_com_facebook_react_*`. Every Java-facing method is registered dynamically (see 2.3).

### 2.2 JNI naming convention and exceptions

Convention: the only JNI-visible exported symbol is the standard `JNI_OnLoad(JavaVM*, void*)`, produced 15 times, once per generated `.so` module. Each delegates to `facebook::jni::initialize(vm, []{ ... })` (or `facebook::xplat::initialize` when `WITH_XPLATINIT` is set, see `react/jni/OnLoad.cpp:20-31`).

Exceptions to the convention, all verified:
1. `getCurrentEnv()` at `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/corefunctions.cpp:45` carries `JNIEXPORT` although it is not a JNI entry point. The file itself flags this at `corefunctions.cpp:44`: `// TODO why we need JNIEXPORT for getCurrentEnv ?`
2. `JNI_OnLoad_Weak` at `packages/react-native/ReactAndroid/src/main/jni/first-party/jni-lib-merge/jni_lib_merge.c:73` (`jint JNI_OnLoad_Weak(JavaVM* vm, void* reserved)`) — the merged-library dispatcher, not a per-library entry point. Declared at `jni_lib_merge.h:47`.
3. `first-party/yogajni/jni/yogajni.cpp:13` defines `jni JNI_OnLoad(JavaVM* vm, void* /*unused*/) {` **without** `JNIEXPORT` — the only `JNI_OnLoad` definition in the tree lacking the macro.
4. `react/jni/OnLoad.cpp:26` and `react/jni/OnLoad-common.cpp:20` add `extern "C"`; the other 13 do not.

### 2.3 Dynamic registration — `RegisterNatives` tables

There are **two** mechanisms in this tree.

**(a) The vendored Yoga path: raw `JNINativeMethod[]` table.**

- Table definition: `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/YGJNIVanilla.cpp:845` — `static JNINativeMethod methods[] = {` … closes at `YGJNIVanilla.cpp:1170`.
- **Entry count: 122** (`grep -c '^    {"jni_' first-party/yogajni/jni/YGJNIVanilla.cpp`).
- Registered against class `"com/facebook/yoga/YogaNative"` at `YGJNIVanilla.cpp:1172-1178`:
  ```cpp
  void YGJNIVanilla::registerNatives(JNIEnv* env) {
    facebook::yoga::vanillajni::registerNatives(
        env,
        "com/facebook/yoga/YogaNative",
        methods,
        sizeof(methods) / sizeof(JNINativeMethod));
  }
  ```
- Called from `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/yogajni.cpp:16`.
- The registration helper is `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/common.cpp:12-25`, which calls `env->RegisterNatives(clazz, methods, ...)` at `common.cpp:22`.

Sample verbatim entries (`YGJNIVanilla.cpp:846-848`):
```cpp
    {"jni_YGConfigNewJNI", "()J", (void*)jni_YGConfigNewJNI},
    {"jni_YGConfigFreeJNI", "(J)V", (void*)jni_YGConfigFreeJNI},
    {"jni_YGConfigSetExperimentalFeatureEnabledJNI",
```

**(b) The fbjni path: `makeNativeMethod(...)` inside `registerHybrid`/`javaClassLocal()->registerNatives`/`javaClassStatic()->registerNatives`.**

Command: `grep -rn 'makeNativeMethod(' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v first-party/jni-hack | wc -l` → **248** `makeNativeMethod` call sites (excluding the 122 raw Yoga entries).

Full list of tables and their `makeNativeMethod` Java names:

| File:line of table | Registration form | Java names |
| --- | --- | --- |
| `react/jni/OnLoad-common.cpp:22-31` (10 `registerNatives()` calls) | `registerHybrid` | see per-class rows |
| `react/jni/JArrayBuffer.cpp:31` | `registerHybrid` | `initHybrid`, `isBytesValid` |
| `react/jni/JCallback.h:31` | `registerHybrid` | `nativeInvoke` |
| `react/jni/JDynamicNative.h:32` | `javaClassStatic()->registerNatives` | `isNullNative`, `getTypeNative`, `asDouble`, `asBoolean`, `asString`, `asArray`, `asMap` |
| `react/jni/JReactMarker.cpp:152` | `javaClassLocal()->registerNatives` | `nativeLogMarker` |
| `react/jni/InspectorNetworkRequestListener.cpp:23` | `registerHybrid` | `onHeaders`, `onData`, `onError`, `onCompletion` |
| `react/jni/NativeArray.cpp:30` | `registerHybrid` | `toString` |
| `react/jni/NativeMap.cpp:21` | `registerHybrid` | `toString` |
| `react/jni/ReadableNativeArray.cpp:48` | `registerHybrid` | `importArray`, `importTypeArray`, `nativeEquals` |
| `react/jni/ReadableNativeMap.cpp:125` | `registerHybrid` | `importKeys`, `importValues`, `importTypes` |
| `react/jni/TransformHelper.cpp:56` | `javaClassLocal()->registerNatives` | `nativeProcessTransform` |
| `react/jni/WritableNativeArray.cpp:82` | `registerHybrid` | `initHybrid`, `pushNull`, `pushBoolean`, `pushDouble`, `pushInt`, `pushLong`, `pushString`, `pushNativeArray`, `pushNativeMap` |
| `react/jni/WritableNativeMap.cpp:92` | `registerHybrid` | `putNull`, `putBoolean`, `putDouble`, `putInt`, `putLong`, `putString`, `putNativeArray`, `putNativeMap`, `mergeNativeMap`, `initHybrid` |
| `react/devsupport/JCxxInspectorPackagerConnection.cpp:46` | `registerHybrid` | `initHybrid`, `connect`, `closeQuietly`, `sendEventToAllConnections` |
| `react/devsupport/JCxxInspectorPackagerConnectionWebSocketDelegate.cpp:56` | `registerHybrid` | `didFailWithError`, `didReceiveMessage`, `didClose`, `didOpen` |
| `react/devsupport/JInspectorFlags.cpp:36` | `javaClassLocal()->registerNatives` — **called 4 times, once per flag** (lines 37, 42, 45, 49) | `getScreenshotCaptureEnabled`, `getFuseboxEnabled`, `getIsProfilingBuild`, `getFrameRecordingEnabled` |
| `react/devsupport/JInspectorNetworkReporter.cpp:235` | `javaClassLocal()->registerNatives` | 15 names: `isDebuggingEnabled`, `reportRequestStart`, `reportResponseStart`, `reportConnectionTiming`, `reportDataReceivedImpl`, `reportResponseEnd`, `reportRequestFailed`, `maybeStoreResponseBodyImpl`, `maybeStoreResponseBodyIncrementalImpl`, `reportWebSocketCreated`, `reportWebSocketWillSendHandshakeRequest`, `reportWebSocketHandshakeResponseReceived`, `reportWebSocketMessageSentImpl`, `reportWebSocketMessageReceivedImpl`, `reportWebSocketClosed` |
| `react/fabric/ComponentFactory.cpp:22` | `registerHybrid` | `initHybrid` |
| `react/fabric/EventBeatManager.cpp:38` | `registerHybrid` | `initHybrid`, `tick` |
| `react/fabric/EventEmitterWrapper.cpp:81` | `registerHybrid` | `dispatchEvent`, `dispatchUniqueEvent`, `dispatchEventSynchronously` |
| `react/fabric/FabricUIManagerBinding.cpp:910` | `registerHybrid` | `initHybrid`, `installFabricUIManager`, `startSurface`, `startSurfaceWithConstraints`, `stopSurface`, `setConstraints`, `setPixelDensity`, `driveCxxAnimations`, `driveAnimationBackend`, `drainPreallocateViewsQueue`, `reportMount`, `pullAndExecuteTransaction`, `uninstallFabricUIManager`, `startSurfaceWithSurfaceHandler`, `stopSurfaceWithSurfaceHandler`, `findNextFocusableElement`, `getRelativeAncestorList`, `mergeReactRevision` (19) |
| `react/fabric/StateWrapperImpl.cpp:70` | `registerHybrid` | `initHybrid`, `getStateDataImpl`, `updateStateImpl`, `getStateMapBufferDataImpl`, `getStateDataReferenceImpl` |
| `react/fabric/SurfaceHandlerBinding.cpp:78` | `registerHybrid` | `initHybrid`, `_getSurfaceId`, `_isRunning`, `_getModuleName`, `setLayoutConstraintsNative`, `setProps`, `setDisplayMode` |
| `react/fabric/test_helper/FabricMountingManagerTestHelper.cpp:67` | `registerHybrid` *(test_helper)* | `initHybrid`, `startSurface`, `stopSurface`, `preallocateView`, `destroyUnmountedView`, `isTagAllocated` |
| `react/featureflags/JReactNativeFeatureFlagsCxxInterop.cpp:1048` | `javaClassLocal()->registerNatives` | `override`, `dangerouslyReset`, `dangerouslyForceOverride`, then one method per feature flag alphabetically (`commonTestFlag` … `virtualViewPrerenderRatio`) |
| `react/hermes/instrumentation/HermesSamplingProfiler.cpp:34` | `javaClassLocal()->registerNatives` | `enable`, `disable`, `dumpSampledTraceToFile` |
| `react/hermes/reactexecutor/OnLoad.cpp:99` | `registerHybrid` | `initHybrid`, `initHybridDefaultConfig` |
| `react/newarchdefaults/DefaultComponentsRegistry.cpp:62` | `javaClassLocal()->registerNatives` | `register` (bound to `setRegistryRunction`) |
| `react/newarchdefaults/DefaultTurboModuleManagerDelegate.cpp:48` | `registerHybrid` | `initHybrid` |
| `react/reactnativeblob/BlobCollector.cpp:44` | `javaClassLocal()->registerNatives` | `getBindingsInstaller` |
| `react/runtime/hermes/jni/JHermesInstance.cpp:20` | `registerHybrid` | `initHybrid` |
| `react/runtime/jni/JJSTimerExecutor.cpp:33` | `registerHybrid` | `callTimers`, `initHybrid` |
| `react/runtime/jni/JReactHostInspectorTarget.cpp:195` | `registerHybrid` | `initHybrid`, `sendDebuggerResumeCommand`, `startBackgroundTrace`, `stopAndMaybeEmitBackgroundTrace`, `stopTracing`, `getTracingState`, `registerTracingStateListener`, `unregisterTracingStateListener`, `recordFrameTimings` |
| `react/runtime/jni/JReactInstance.cpp:215` | `registerHybrid` | `initHybrid`, `loadJSBundleFromAssets`, `loadJSBundleFromFile`, `getJSCallInvokerHolder`, `getNativeMethodCallInvokerHolder`, `callFunctionOnModule`, `getUnbufferedRuntimeExecutor`, `getBufferedRuntimeExecutor`, `getRuntimeScheduler`, `registerSegmentNative`, `handleMemoryPressureJs`, `getJavaScriptContext`, `unregisterFromInspector` |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:119` | `registerHybrid` | `initHybrid`, `dispatchJSBindingInstall` |
| `react/tracing/PerformanceTracerCxxInterop.cpp:225` | `javaClassLocal()->registerNatives` | `reportMark`, `reportMeasure`, `reportTimeStamp`, `isTracing`, `subscribeToTracingStateChanges`, `unsubscribeFromTracingStateChanges` |
| `react/uimanager/ComponentNameResolverBinding.cpp:21` | `javaClassStatic()->registerNatives` | `install` |
| `react/uimanager/UIConstantsProviderBinding.cpp:18` | `javaClassStatic()->registerNatives` | `install` |

**(c) One registration outside any class: `react/turbomodule/ReactCommon/OnLoad.cpp:28-30`**
```cpp
    facebook::jni::registerNatives(
        "com/facebook/react/internal/turbomodule/core/TurboModulePerfLogger",
        {makeNativeMethod("jniEnableCppLogging", jniEnableCppLogging)});
```

---

## 3. ERROR / EXCEPTION HANDLING

### 3.1 Places a Java exception is thrown from C++ (raw JNI `env->Throw*`)

Only **2** raw `Throw` call sites exist in the entire tree (both in the vendored Yoga glue):

| Path:line | Code | Class | Message |
| --- | --- | --- | --- |
| `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/YGJNIVanilla.cpp:365` | `env->Throw(throwable.get());` | rethrows the original Java throwable captured in `YogaJniException` | n/a |
| `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/YGJNIVanilla.cpp:373` | `env->Throw(static_cast<jthrowable>(throwable));` | `java/lang/IllegalStateException` (created at `YGJNIVanilla.cpp:369`) | `ex.what()` (the `std::logic_error` message) |

`env->ThrowNew` count: **0** (`grep -rn 'ThrowNew' ... | grep -v jni-hack` returns nothing).
`jni_throw` count: **0**.

### 3.2 Places a Java exception is raised via fbjni / helper indirection

| Path:line | Exception class | Message |
| --- | --- | --- |
| `react/jni/NativeCommon.cpp:15-16` defines `const char* gUnexpectedNativeTypeExceptionClass = "com/facebook/react/bridge/UnexpectedNativeTypeException";` | — | — |
| `react/jni/NativeArray.cpp:18-21` `throwNewJavaException(exceptions::gUnexpectedNativeTypeExceptionClass, "expected Array, got a %s", array_.typeName());` | `com/facebook/react/bridge/UnexpectedNativeTypeException` | `expected Array, got a %s` |
| `react/jni/NativeCommon.cpp:58-59` `throwNewJavaException(exceptions::gUnexpectedNativeTypeExceptionClass, "Unknown type");` | same | `Unknown type` |
| `react/jni/NativeCommon.h:33` `jni::throwNewJavaException("com/facebook/react/bridge/ObjectAlreadyConsumedException", msg);` | `com/facebook/react/bridge/ObjectAlreadyConsumedException` | `Array already consumed` (`NativeArray.cpp:43`) / `Map already consumed` (`NativeMap.cpp:34`) |
| `react/jni/ReadableNativeMap.cpp:20-21` `throwNewJavaException(exceptions::gUnexpectedNativeTypeExceptionClass, err.what());` | `...UnexpectedNativeTypeException` | `folly::TypeError` text |
| `react/jni/ReadableNativeMap.cpp:27-29` | `java/lang/IllegalStateException` | `importKeys must be called before importing values or types` |
| `react/jni/ReadableNativeMap.cpp:116-119` | `...UnexpectedNativeTypeException` | `expected Map, got a %s` |
| `react/jni/ReadableNativeArray.cpp:20-21` | `...UnexpectedNativeTypeException` | `folly::TypeError` text |
| `react/jni/JMessageQueueThread.cpp:41-42` `throwNewJavaException("com/facebook/react/common/JavascriptException", message.c_str());` | `com/facebook/react/common/JavascriptException` | `ex.getMessage() + ", stack:\n" + ex.getStack()` |
| `react/runtime/jni/JReactHostInspectorTarget.h:52` `jni::throwNewJavaException("java/lang/IllegalStateException", "Unexpected new TracingState.");` | `java/lang/IllegalStateException` | `Unexpected new TracingState.` |
| `react/runtime/jni/JReactHostInspectorTarget.cpp:83-85` `jni::throwNewJavaException("java/lang/IllegalStateException", "Inspector method called while the Fusebox backend is not enabled.");` | `java/lang/IllegalStateException` | `Inspector method called while the Fusebox backend is not enabled.` |
| `react/jni/JArrayBuffer.cpp:60` `throw std::runtime_error(kRevokedBorrowMessage);` (**C++**, not Java) | — | `com.facebook.react.bridge.ArrayBuffer: the bytes of a non-owning ArrayBuffer were accessed after the method that received it returned. Copy them with ArrayBuffer.arrayBufferWithCopiedBytes() to use them later.` (defined `JArrayBuffer.cpp:24-27`) |
| `react/jni/JArrayBuffer.cpp:110-111` `throw jsi::JSError(runtime, "com.facebook.react.bridge.ArrayBuffer has no native peer.");` | — | `com.facebook.react.bridge.ArrayBuffer has no native peer.` |
| `react/jni/JArrayBuffer.cpp:114` `throw jsi::JSError(runtime, kRevokedBorrowMessage);` | — | same as line 60 |
| `react/jni/JSLoader.cpp:80-90` `throw std::runtime_error(...)` (**C++**) | — | long "Unable to load script…\n  adb reverse tcp:8081 tcp:8081" message |
| `react/jni/JniJSModulesUnbundle.cpp:94` `throw ModuleNotFound(moduleId);` (**C++**) | — | — |
| `react/jni/WritableNativeArray.cpp:22` `throw std::runtime_error("WritableNativeArray value must be an array.");` (**C++**) | — | — |
| `react/jni/WritableNativeMap.cpp:19` `throw std::runtime_error("WritableNativeMap value must be an object.");` (**C++**) | — | — |
| `react/first-party/fbgloginit/glog_init.cpp:135` `throw std::runtime_error{"Failed to initialize glog"};` (**C++**) | — | `Failed to initialize glog` |
| `react/jni/MethodInvoker.cpp:70-72` `throw std::invalid_argument("Tried to convert jint argument, but got a non-integral double: " + ...)` (**C++**) | — | — |
| `react/jni/MethodInvoker.cpp:226-228` `throw std::invalid_argument("expected " + ... )` (**C++**) | — | — |
| `react/jni/JavaModuleWrapper.cpp:53-55,60-62,138-140` `throw std::invalid_argument("methodId " + ... )` (**C++**) | — | — |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:86-88` **`throw new std::runtime_error(...)`** (**C++, throws a POINTER — see §8.1**) | — | `Failed to convert jsiReturnKind "..." to TurboModuleMethodValueKind` |
| `react/runtime/jni/JReactHostInspectorTarget.cpp:270` `throw std::logic_error("Unexpected new Tracing Mode");` (**C++**) | — | `Unexpected new Tracing Mode` |

### 3.3 Process-aborting constructs

| Path:line | Construct | Effect |
| --- | --- | --- |
| `first-party/yogajni/jni/macros.h:23` | `#define VANILLAJNI_DIE() std::abort()` | `abort()` |
| `first-party/yogajni/jni/corefunctions.cpp:56-63` | `void logErrorMessageAndDie(const char* message)` → logs `"Aborting due to error detected in native code: %s"` then `VANILLAJNI_DIE()` | **aborts the process** |
| `first-party/yogajni/jni/corefunctions.cpp:62` | `VANILLAJNI_DIE();` | abort |
| `first-party/yogajni/jni/corefunctions.cpp:19-21` | `logErrorMessageAndDie("You cannot pass a NULL JavaVM to ensureInitialized");` | abort |
| `first-party/yogajni/jni/corefunctions.cpp:31-33` | `logErrorMessageAndDie("Need to pass a valid JNIEnv pointer to vanillajni initialization routine");` | abort |
| `first-party/yogajni/jni/corefunctions.cpp:37-38` | `logErrorMessageAndDie("Error retrieving JNIEnv during initialization of vanillajni");` | abort |
| `first-party/yogajni/jni/corefunctions.cpp:49-51` | `logErrorMessageAndDie("There was an error retrieving the current JNIEnv. Make sure the current thread is attached");` | abort |
| `first-party/yogajni/jni/corefunctions.cpp:72` | `logErrorMessageAndDie("Unable to get pending JNI exception.");` | abort |
| `first-party/yogajni/jni/common.cpp:93,103` | `logErrorMessageAndDie("Could not obtain global reference from object");` | abort |
| `first-party/jni-lib-merge/jni_lib_merge.c:61-62` | `assert(!"Failed to strdup soname."); abort();` | **abort** |
| `first-party/jni-lib-merge/jni_lib_merge.c:119-122` | `assert(natives != NULL); if (natives == NULL) { abort(); }` | **abort** |
| `react/hermes/reactexecutor/OnLoad.cpp:25` | `__android_log_assert(nullptr, "Hermes", "%s", reason.c_str());` | **aborts the process** (in the Hermes fatal handler) |
| `react/mapbuffer/react/common/mapbuffer/JReadableMapBuffer.cpp:33-34` | `react_native_assert((serializedData_.size() != 0) && "Error no content in map");` | assert (fatal in debug) |
| `react/fabric/FabricMountingManager.cpp:998-999` | `react_native_assert(static_cast<int>(buffer.ints.size()) == batchMountItemIntsSize);` | assert (fatal in debug) |
| `react/jni/JniJSModulesUnbundle.cpp:80` | `react_native_assert(m_assetManager != nullptr);` | assert (fatal in debug) |
| `react/jni/MethodInvoker.cpp:95` | `CHECK(it != end);` (glog) | **fatal/abort** |
| `react/jni/MethodInvoker.cpp:121` | `CHECK(it != end);` | **fatal/abort** |
| `react/jni/MethodInvoker.cpp:174` | `LOG(FATAL) << "Unknown param type: " << type;` | **fatal/abort** |
| `react/jni/MethodInvoker.cpp:313` | `LOG(FATAL) << "Unknown return type: " << returnType;` | **fatal/abort** |
| `react/jni/JavaModuleWrapper.cpp:144-145` | `CHECK(method.has_value() && method->isSyncHook()) << "Trying to invoke a asynchronous method as synchronous hook";` | **fatal/abort** |

### 3.4 Comments mentioning exception safety / leak / crash

| Path:line | Exact text |
| --- | --- |
| `react/jni/JByteBufferMutableBuffer.h:20-23` | `// IMPORTANT: jsi::MutableBuffer finalizers run on the Hermes GC background`<br>`// thread, which is not attached to JNI. Destroying a jni::global_ref on an`<br>`// unattached thread calls abort(). jni::ThreadScope in the destructor attaches`<br>`// the GC thread temporarily, making the global_ref teardown safe.` |
| `react/jni/SafeReleaseJniRef.cpp:13-22` | `// Attaching and detaching the thread to the JNI environment may take`<br>`// hundreds of microseconds, and we attach to a very limited number of`<br>`// threads (in practice, just the Hermes GC), so we only perform`<br>`// registration once, detaching before the thread is destroyed.`<br>`//`<br>`// > In Android 2.0 (Eclair) and higher you can use pthread_key_create() to`<br>`// > define a destructor function that will be called before the thread`<br>`// > exits, and call DetachCurrentThread() from there.` |
| `react/fabric/FabricMountingManager.cpp:41-43` | `// Manually reset `javaUIManager_` since FabricMountingManager may be retained`<br>`// from a GC thread (destroyUnmountedShadowNode)` |
| `react/fabric/FabricMountingManager.cpp:1069-1071` | `// ThreadScope::WithClassLoader is necessary because`<br>`// destroyUnmountedShadowNode is being called from a destructor thread` |
| `react/runtime/jni/JReactExceptionManager.cpp:56-61` | `// Marshalling `extraData` out of the runtime can throw (e.g. a`<br>`// jsi::JSIException when the runtime is in a bad state during a fatal`<br>`// error). This runs inside the `noexcept` onJsError callback, so an`<br>`// escaping exception aborts the whole process; contain it and report the`<br>`// error without its extra data instead. `extraData` may end up null (here,`<br>`// or when the JS value is null/undefined); the Java field is nullable.` |
| `first-party/yogajni/jni/ScopedGlobalRef.h:30-32` | `// lifespan of each global reference that is created in JNI so that leaks are prevented.` |
| `first-party/yogajni/jni/ScopedLocalRef.h:31-34` | `// reference around between different native method calls.` / `... so that leaks are prevented.` |
| `first-party/yogajni/jni/YogaJniException.h:14-16` | `* This class wraps a Java exception (jthrowable) into a C++ exception; A global`<br>`* reference to Java exception (jthrowable) is made so that the exception object`<br>`* does not gets cleared before jni call completion` |
| `first-party/jni-lib-merge/jni_lib_merge.h:68` | `/* Note: relying on SoLoader's synchronization for thread-safety. */` |
| `react/fabric/EventEmitterWrapper.cpp:36-38` | `// It is marginal, but possible for this to be constructed without a valid`<br>`// EventEmitter. In those cases, make sure we noop/blackhole events instead of`<br>`// crashing.` (repeated at lines 52-54 and 70-72) |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:182-192` | `// an exception, fbjni's JMethod::operator() needs to check for pending` … `// C++ destroys temporaries at the end of the full-expression, which happens` … `// AFTER the JNI call returns but BEFORE the exception check. The destructor` … `// calls JNI functions (GetObjectRefType) while there's a pending exception,` … `// which violates JNI rules and causes ART's CheckJNI to abort the process.` |

### 3.5 C++ exceptions crossing the JNI boundary

All `try`/`catch` sites in the tree (excluding vendored headers) — `grep -rn 'try {\|catch (\|catch(' ... | grep -v jni-hack`:

| Path:line | Handler | Boundary handling |
| --- | --- | --- |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:345` / `:362` | `} catch (const YogaJniException& jniException) {` → `env->Throw(throwable.get())` at `:365` | **Converted to a Java exception.** |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:367` | `} catch (const std::logic_error& ex) {` → builds `IllegalStateException`, `env->Throw(...)` at `:373` | **Converted.** |
| `first-party/yogajni/jni/corefunctions.cpp:75` | `throw YogaJniException(throwable);` (inside `assertNoPendingJniException`) | C++ exception raised from a JNI helper |
| `first-party/yogajni/jni/corefunctions.cpp:88` | `throw YogaJniException();` (inside `assertNoPendingJniExceptionIf`) | C++ exception raised |
| `first-party/yogajni/jni/YogaJniException.cpp:36-40` | `try { throwable_.reset(); } catch (...) { std::terminate(); }` in `~YogaJniException` | **`std::terminate()` on failure** |
| `react/jni/JMessageQueueThread.cpp:36-43` | `try { localRunnable(); } catch (const jsi::JSError& ex) { ... throwNewJavaException(...) }` | **Converted to Java.** Only `jsi::JSError` is caught; any other C++ exception escapes. |
| `react/jni/ReadableNativeMap.cpp:17-22` | `try { std::rethrow_exception(ex); } catch (const folly::TypeError& err) { throwNewJavaException(...) }` | Converts only `folly::TypeError`; any other exception type escapes `mapException`. |
| `react/jni/ReadableNativeArray.cpp:17-22` | same shape | same |
| `react/tracing/PerformanceTracerCxxInterop.cpp:194-204` | `try { jni::ThreadScope::WithClassLoader([&]{...}); } catch (const std::exception&) { }` | **Exception fully swallowed — empty catch body.** |
| `react/runtime/jni/JReactExceptionManager.cpp:68-74` | `try { extraData = ...; } catch (...) { extraData = nullptr; }` | swallowed |
| `react/runtime/jni/JReactExceptionManager.cpp:77-86` | `try { ... } catch (const std::exception& e) { reportWithoutExtraData(e.what()); } catch (...) { reportWithoutExtraData("unknown exception"); }` | fully contained |
| `first-party/fbgloginit/glog_init.cpp:119-131` | `try { InitGoogleLogging... } catch (std::exception& ex) {...} catch (...) {...}` | contained; re-throws as `std::runtime_error` at `:135` |

**No `RNJni` / `JniException` / `PendingException` helper symbols exist in this tree** — `grep -rn 'RNJni\|JniException\|PendingException'` returns nothing in the jni tree. The exception bridge is provided entirely by fbjni (`jni::throwNewJavaException`, `jni::throwPendingJniExceptionAsCppException`) and by `facebook::yoga::vanillajni::YogaJniException`.

`jni::throwPendingJniExceptionAsCppException()` is called at:
- `react/jni/MethodInvoker.cpp:248,255,262,273,285` (5 sites in the JNI-call macros)
- `react/jni/MethodInvoker.h:29` (inside `JReflectMethod::getMethodID()`)

---

## 4. REFERENCES / OWNERSHIP HAZARDS

### 4.1 Raw JNI ref API counts (excluding `first-party/jni-hack/real/jni.h`)

Command used per-symbol: `grep -rn '<sym>' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v first-party/jni-hack | wc -l`

| Symbol | Count (whole tree) | Count (non-test) |
| --- | --- | --- |
| `NewGlobalRef` | 4 | **2** |
| `DeleteGlobalRef` | 4 | **1** |
| `NewLocalRef` | 1 | **1** |
| `DeleteLocalRef` | 3 | **2** |
| `NewWeakGlobalRef` | **0** | **0** |
| `PushLocalFrame` | **0** | 0 |
| `PopLocalFrame` | **0** | 0 |
| `EnsureLocalCapacity` | **0** | 0 |
| `GetStringUTFChars` | **0** | 0 |
| `ReleaseStringUTFChars` | **0** | 0 |
| `GetStringChars` / `ReleaseStringChars` | 0 / 0 | 0 / 0 |
| `GetStringCritical` / `ReleaseStringCritical` | 0 / 0 | 0 / 0 |
| `GetPrimitiveArrayCritical` / `ReleasePrimitiveArrayCritical` | 0 / 0 | 0 / 0 |

All occurrences:

| Path:line | Text |
| --- | --- |
| `first-party/yogajni/jni/common.cpp:90` | `jobject result = env->NewGlobalRef(obj);` — in `newGlobalRef(JNIEnv*, jobject)` |
| `first-party/yogajni/jni/common.cpp:100` | `auto result = static_cast<jthrowable>(env->NewGlobalRef(obj));` — in `newGlobalRef(JNIEnv*, jthrowable)` |
| `first-party/yogajni/jni/ScopedGlobalRef.h:97` | `vanillajni::getCurrentEnv()->DeleteGlobalRef(mGlobalRef);` — inside `ScopedGlobalRef<T>::reset()` |
| `first-party/yogajni/jni/ScopedLocalRef.h:97` | `mEnv->DeleteLocalRef(mLocalRef);` — inside `ScopedLocalRef<T>::reset()` |
| `first-party/yogajni/jni/YogaJniException.cpp:46` | `static_cast<jthrowable>(getCurrentEnv()->NewLocalRef(throwable_.get()))` — in `YogaJniException::getThrowable()` |
| `react/fabric/FabricMountingManager.cpp:1034` | `env->DeleteLocalRef(ints);` — deletes the `jintArray` created at `:1000` |
| `first-party/yogajni/jni/tests/corefunctionsTest.cpp:69,73,101,102` | fake JNI function-table entries (test) |

### 4.2 NewGlobalRef without a matching DeleteGlobalRef

Both `NewGlobalRef` sites in non-test code are in `packages/react-native/ReactAndroid/src/main/jni/first-party/yogajni/jni/common.cpp`, functions `newGlobalRef(JNIEnv*, jobject)` (`:89-97`) and `newGlobalRef(JNIEnv*, jthrowable)` (`:99-107`). Neither calls `DeleteGlobalRef` itself; both return `make_global_ref(result)` → `ScopedGlobalRef<T>`, whose destructor (`ScopedGlobalRef.h:86-88` → `:94-101`) calls `DeleteGlobalRef`. **The pairing is complete via RAII, not within the same function body.**

Verified RAII pairing gaps / notes:
- `ScopedGlobalRef<T>::reset(T ptr)` at `ScopedGlobalRef.h:94-101` only deletes when `ptr != mGlobalRef`. `ScopedGlobalRef<T>::operator=` (`:81-84`) calls `reset(s.release())`, so self-assignment (`a = std::move(a)`) is handled correctly.
- **`ScopedGlobalRef` is not copy-constructible** (`ScopedGlobalRef.h:128-129`), yet `YogaJniException` — which owns one — **does declare a copy constructor** at `YogaJniException.cpp:31-33`:
  ```cpp
  YogaJniException::YogaJniException(const YogaJniException& rhs) {
    throwable_ = newGlobalRef(getCurrentEnv(), rhs.throwable_.get());
  }
  ```
  Each copy creates a fresh global ref, so no double-free; but if `rhs.throwable_` is null, `newGlobalRef` calls `env->NewGlobalRef(nullptr)` and then `logErrorMessageAndDie` → `abort()` (`common.cpp:102-104`).
- `ScopedLocalRef<T>::operator=(ScopedLocalRef&&)` at `ScopedLocalRef.h:80-84` calls `reset(s.release())` **before** `mEnv = s.mEnv`, so the *old* `mLocalRef` is deleted via the *old* `mEnv`. Correct order.

### 4.3 `jni::make_global` (fbjni global refs) — 37 occurrences

`grep -rn 'make_global' --include='*.cpp' --include='*.h' .` → 37 hits (2 in test files).

Non-test sites:

| Path:line | Owner |
| --- | --- |
| `react/tracing/PerformanceTracerCxxInterop.cpp:183` | stored in `TracingCallbackRegistry::callbacks_`; erased at `:46` |
| `react/runtime/jni/JReactInstance.cpp:44` | into `JavaTimerRegistry::javaTimerManager_` |
| `react/runtime/jni/JReactInstance.cpp:48` | `jReactExceptionManager_` (member) |
| `react/runtime/jni/JReactInstance.cpp:59` | `jBindingsInstaller_` (member) |
| `react/runtime/jni/JReactInstance.cpp:94,99,104,106,108` | 5 members |
| `react/runtime/jni/JReactHostInspectorTarget.cpp:24` | `jobj_` |
| `react/runtime/jni/JReactHostInspectorTarget.cpp:25` | `javaReactHostImpl_` |
| `react/runtime/jni/JReactHostInspectorTarget.cpp:29` | `SafeReleaseJniRef` inside the inspector executor lambda |
| `react/runtime/jni/JReactHostInspectorTarget.cpp:228` | `globalRef` captured by the tracing-state listener lambda |
| `react/newarchdefaults/DefaultTurboModuleManagerDelegate.cpp:26` | pushed into `cxxReactPackages_` |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:105` | `delegate_` |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:348` | captured by the `runtimeExecutor` lambda |
| `react/devsupport/JCxxInspectorPackagerConnectionDelegateImpl.cpp:32` | passed to Java `connectWebSocket` |
| `react/devsupport/JCxxInspectorPackagerConnectionDelegateImpl.cpp:60` | `jDelegate_` |
| `react/devsupport/JCxxInspectorPackagerConnectionWebSocket.cpp:65` | `jWebSocket_` |
| `react/fabric/FabricUIManagerBinding.cpp:598` | `globalJavaUiManager`, copied into 3 places |
| `react/featureflags/JReactNativeFeatureFlagsCxxInterop.cpp:40` | `javaProvider_` |
| `react/jni/JavaModuleWrapper.h:67` | `wrapper_` |
| `react/jni/JMessageQueueThread.cpp:51` | `m_jobj` |
| `react/jni/InspectorNetworkRequestListener.cpp:37,52,59` | `SafeReleaseJniRef` wrappers (3) |
| `react/jni/ModuleRegistryBuilder.cpp:27` | captured by a lambda that is **never invoked** (see §6) |
| `react/jni/NativeCommon.cpp:25` | **`.release()`d — intentionally leaked** (see §8.4) |
| `react/jni/JByteBufferMutableBuffer.h:27` | `byteBuffer_`, manually `.reset()` in dtor `:34` |
| `react/reactnativeblob/BlobCollector.cpp:55` | `blobModuleRef`, copied into every `BlobCollector` |
| `react/uimanager/UIConstantsProviderBinding.cpp:34,36,38` | 3 refs captured in lambdas |
| `react/uimanager/ComponentNameResolverBinding.cpp:32` | captured in lambda |

`jni::make_weak` — 4 occurrences: `react/runtime/jni/JReactInstance.cpp:50`, `react/turbomodule/ReactCommon/TurboModuleManager.cpp:131` and `:239`, `react/fabric/FabricUIManagerBinding.cpp:215`.

### 4.4 `.release()` calls that abandon a `local_ref` (15 sites)

`grep -rn '\.release()' --include='*.cpp' --include='*.h' .` → 15 results, all non-test.

| Path:line | Code |
| --- | --- |
| `react/fabric/FabricMountingManager.cpp:1172` | `ReadableNativeArray::newObjectCxxArgs(args).release()));` inside `jni::adopt_local(reinterpret_cast<...>)` — ownership transferred, correct |
| `react/fabric/FabricMountingManager.cpp:1245` | `ReadableNativeMap::newObjectCxxArgs(props).release());` inside `reinterpret_cast` — **cast to `ReadableMap::javaobject`, then passed raw to a JNI method; the returned local ref is never deleted and the `local_ref` wrapper is gone** (see §8.3) |
| `react/jni/MethodInvoker.cpp:124,140,146,153,159,162,165,168,171` | `value.l = ....release();` — 9 sites; deliberate: raw `jvalue` for `CallXxxMethodA`. Local refs are reclaimed by the enclosing `JniLocalScope` at `MethodInvoker.cpp:233`. |
| `react/jni/JDynamicNative.cpp:39,46` | inside `jni::adopt_local(...)` — correct |
| `react/jni/NativeCommon.cpp:25` | `return make_global(cls->getStaticFieldValue(field)).release();` — **deliberate leak, documented by the comment at `:21`: `// Returns a leaked global_ref.`** |

### 4.5 `GetStringUTFChars` / `ReleaseStringUTFChars`

**Zero occurrences in this tree.** All string marshalling goes through fbjni (`toStdString()`, `make_jstring`, `wrap_alias`). Nothing to pair.

### 4.6 Thread attach/detach

Command: `grep -rn 'AttachCurrentThread\|DetachCurrentThread\|GetEnv(\|ThreadScope\|ThreadDetachScope' ... | grep -v first-party/jni-hack | wc -l` → **18** hits.

| Path:line | Construct |
| --- | --- |
| `first-party/yogajni/jni/corefunctions.cpp:36` | `if (vm->GetEnv(reinterpret_cast<void**>(env), JNI_VERSION_1_6) != JNI_OK) {` — in `ensureInitialized` |
| `first-party/yogajni/jni/corefunctions.cpp:47` | `jint ret = globalVm->GetEnv((void**)&env, JNI_VERSION_1_6);` — in `getCurrentEnv` |
| `first-party/jni-lib-merge/jni_lib_merge.c:79` | `if ((*vm)->GetEnv(vm, (void**)&env, JNI_VERSION_1_2) != JNI_OK) {` |
| `first-party/jni-lib-merge/jni_lib_merge.c:101` | `if ((*vm)->GetEnv(vm, (void**)&env, JNI_VERSION_1_2) != JNI_OK) {` |
| `react/jni/JMessageQueueThread.cpp:57` | `jni::ThreadScope guard;` in `runOnQueue` |
| `react/jni/JByteBufferMutableBuffer.h:33` | `jni::ThreadScope threadScope;` in `~JByteBufferMutableBuffer` |
| `react/jni/SafeReleaseJniRef.cpp:23-27` | `static thread_local std::optional<jni::ThreadScope> threadScope;` + `if (jni::detail::currentOrNull() == nullptr) { threadScope.emplace(); }` |
| `react/tracing/PerformanceTracerCxxInterop.cpp:195` | `jni::ThreadScope::WithClassLoader([&] { ... });` |
| `react/fabric/FabricMountingManager.cpp:43` | `jni::ThreadScope::WithClassLoader([&]() { javaUIManager_.reset(); });` |
| `react/fabric/FabricMountingManager.cpp:1071` | `jni::ThreadScope::WithClassLoader([&]() { ... destroyUnmountedView ... });` |
| `react/reactnativeblob/BlobCollector.cpp:27` | `jni::ThreadScope::WithClassLoader([&] { ... });` in `~BlobCollector` |

`AttachCurrentThread` / `DetachCurrentThread` / `AttachCurrentThreadAsDaemon` direct calls: **0**. `DetachCurrentThread` appears only in the comment at `react/jni/SafeReleaseJniRef.cpp:20`.

`react/fabric/test/FabricMountingManagerTest.cpp:39` and `react/reactnativeblob/test/BlobCollectorTest.cpp:111,136` also use `ThreadScope::WithClassLoader` (test files).

---

## 5. NULL / CRASH PATHS

### 5.1 `FindClass` / `GetMethodID` / `GetFieldID` and null-checking

`grep -rn 'FindClass\|GetMethodID\|GetFieldID\|GetStaticMethodID\|GetStaticFieldID\|findClassStatic\|findClassLocal' ... | grep -v first-party/jni-hack` → 21 hits (18 non-test).

| Path:line | Call | Null-checked? |
| --- | --- | --- |
| `first-party/jni-lib-merge/jni_lib_merge.c:106` | `jclass invoke_class = (*env)->FindClass(env, invoke_class_name);` | **YES** — `if (invoke_class == NULL) { return JNI_ERR; }` at `:107-109` |
| `first-party/yogajni/jni/common.cpp:17` | `jclass clazz = env->FindClass(className);` | **YES** — `assertNoPendingJniExceptionIf(env, clazz == nullptr);` at `:19` (throws `YogaJniException`) |
| `first-party/yogajni/jni/common.cpp:33` | `env->GetStaticMethodID(clazz, methodName, methodDescriptor)` | **YES** — `:34` |
| `first-party/yogajni/jni/common.cpp:43` | `env->GetMethodID(clazz, methodName, methodDescriptor)` | **YES** — `:44` |
| `first-party/yogajni/jni/common.cpp:53` | `env->GetFieldID(clazz, fieldName, fieldSignature)` | **YES** — `:54` |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:131` | `jclass cl = env->FindClass("com/facebook/yoga/YogaLogLevel");` | **NO** — `cl` is used at `:134` and `:137` unchecked |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:369` | `jclass cl = env->FindClass("java/lang/IllegalStateException");` | **NO** — used at `:371` and `:372` unchecked |
| `first-party/yogajni/jni/YogaJniException.cpp:16` | `jclass cl = getCurrentEnv()->FindClass("java/lang/RuntimeException");` | **NO** — `cl` passed to `getMethodId` at `:18` and `NewObject` at `:19` unchecked. **This runs inside the constructor of an exception type, so a failure here is unrecoverable.** |
| `react/runtime/jni/JReactHostInspectorTarget.h:38` | `auto tracingStateClass = jni::findClassLocal("com/facebook/react/devsupport/inspector/TracingState");` | fbjni `findClassLocal` throws `NoSuchClassError` on failure — internal null check (未确认 exact fbjni behaviour; fbjni is not vendored in this repo) |
| `react/fabric/AndroidEventBeat.cpp:41` | `jni::findClassStatic("com/facebook/react/fabric/FabricUIManager")` | fbjni (same as above) |
| `react/featureflags/JReactNativeFeatureFlagsCxxInterop.cpp:26` | `facebook::jni::findClassStatic(...)` | fbjni |
| `react/reactnativeblob/BlobCollector.cpp:28,37` | `jni::findClassStatic(kBlobModuleJavaDescriptor)` | fbjni |
| `react/uimanager/ComponentNameResolverBinding.cpp:40` | `jni::findClassStatic(ComponentNameResolverJavaDescriptor)` | fbjni |

**Direct `env->GetMethodID` / `GetStaticMethodID` / `GetFieldID` results used without a null check: 3 sites**, all listed above (`YGJNIVanilla.cpp:131`, `:369`, `YogaJniException.cpp:16`).

### 5.2 JNI call results used without a null check

| Path:line | Expression | Note |
| --- | --- | --- |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:151` | `env->NewStringUTF(buffer.data())` passed straight into `callVoidMethod` | Result never checked and never deleted — **local-ref leak on every Yoga log call** |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:325-327` | `env->NewFloatArray(arrSize)` → `env->SetFloatArrayRegion(arrFinal.get(), 0, arrSize, arr.data());` | `NewFloatArray` result is `make_local_ref`'d (deletion handled), but a null return would be passed to `SetFloatArrayRegion` |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:372` | `env->NewObject(cl, methodId, env->NewStringUTF(ex.what()))` | result then `env->Throw(static_cast<jthrowable>(throwable))` — if `NewObject` returned null this throws a null throwable |
| `first-party/yogajni/jni/YGJTypesVanilla.h:30-33` | `jsize nativePointersSize = env->GetArrayLength(javaNativePointers);` then `env->GetLongArrayRegion(...)` | Return values of `GetArrayLength`/`GetLongArrayRegion` unchecked |
| `first-party/yogajni/jni/YGJTypesVanilla.h:49` | `env->GetObjectArrayElement(javaNodes_, idx->second)` | result passed to `make_local_ref` unchecked |
| `react/fabric/FabricMountingManager.cpp:1000-1002` | `jintArray ints = env->NewIntArray(...); env->SetIntArrayRegion(ints, 0, ..., buffer.ints.data());` | `ints` unchecked before use at `:1002` and `:1014`; deleted at `:1034` |
| `react/fabric/FabricUIManagerBinding.cpp:361-364` | `jintArray result = env->NewIntArray(...); env->SetIntArrayRegion(result, 0, ...);` | `result` unchecked |
| `react/fabric/FabricUIManagerBinding.cpp:286` and `:335` | `std::shared_ptr<UIManager> uimanager = getScheduler()->getUIManager();` | **`getScheduler()` result is dereferenced with no null check at either site**, even though the function explicitly returns a possibly-null `shared_ptr` (see `FabricUIManagerBinding.cpp:43-48` and the many `if (!scheduler) { LOG(ERROR) ...; return; }` guards elsewhere, e.g. `:232-236`, `:390-395`, `:456-460`, `:511-516`, `:538-543`, `:782-785`). `Scheduler::getUIManager()` itself returns a `shared_ptr<UIManager>` that is also dereferenced unchecked at `:338`, `:340`, `:351` (that one *is* checked at `:342`). |
| `react/fabric/FabricUIManagerBinding.cpp:787` | `scheduler->getUIManager()->getShadowTreeRegistry().visit(...)` | `getUIManager()` result dereferenced inline, unchecked |
| `react/fabric/FabricUIManagerBinding.cpp:787` | — | `getShadowTreeRegistry()` (`packages/react-native/ReactCommon/react/renderer/uimanager/UIManager.h:213`) returns `const ShadowTreeRegistry&`; a null `UIManager` would crash |
| `react/mapbuffer/react/common/mapbuffer/JWritableMapBuffer.cpp:20-23` | `auto keyArray = getKeys(self()); auto values = getValues(self()); auto keys = keyArray->pin();` | `keyArray`/`values` unchecked; `values` also unused if `keys.size()==0` |
| `react/jni/JniJSModulesUnbundle.cpp:73` | `AAsset_read(asset.get(), &fileHeader, sizeof(fileHeader));` | return value (bytes read) unchecked; a short read leaves `fileHeader == 0` |
| `react/jni/JSLoader.cpp:47-48` | `auto env = Environment::current(); return AAssetManager_fromJava(env, assetManager.get());` | `assetManager` not null-checked |
| `react/jni/JSLoader.cpp:121-123` | `int result = vsnprintf(nullptr, 0, format, argsCopy); std::vector<char> buffer(1 + static_cast<size_t>(result));` | if `vsnprintf` returns a negative value, `1 + static_cast<size_t>(result)` wraps to a huge value → huge allocation (see §8.6) |
| `react/devsupport/JCxxInspectorPackagerConnectionWebSocket.cpp:35` | `return method(buffer);` | `JByteBuffer::wrapBytes` result passed to a method unchecked |

---

## 6. DEAD / UNREFERENCED

Method: for each candidate symbol, `grep -rl '<sym>' packages/ private/` filtered to exclude the jni tree (`grep -v '/jni/'`) — i.e. counting references from anywhere else in the repository.

### 6.1 Symbols with zero references outside the JNI tree

| Symbol | Verified references (all inside the jni tree) |
| --- | --- |
| `JReactSoftExceptionLogger` (`react/jni/JReactSoftExceptionLogger.{h,cpp}`) | 4 hits total, all self-referential: `react/jni/CMakeLists.txt:58`, `.cpp:8`, `.cpp:14`, `.h:15`. **Compiled but never included by any other file; zero external users.** |
| `JReactSoftExceptionLogger::logNoThrowSoftExceptionWithMessage` | 1 hit outside the jni tree (grep count 1); the definition is at `react/jni/JReactSoftExceptionLogger.cpp:14` — 未确认 which external file; only one hit exists repo-wide outside the tree and it is the same name in a different language context. **Not registered via `registerNatives` either — `react/jni/OnLoad-common.cpp` does not call it.** |
| `HermesMemoryDumper` (`react/hermes/instrumentation/HermesMemoryDumper.h`) | 2 hits: the C++ header (`HermesMemoryDumper.h:17`) and an unrelated Kotlin interface `packages/react-native/ReactAndroid/src/main/java/com/facebook/hermes/instrumentation/HermesMemoryDumper.kt:10`. **No C++ file includes this header; all 4 methods (`shouldSaveSnapshot`, `getInternalStorage`, `getId`, `setMetaData`) are unreferenced.** |
| `JniJSModulesUnbundle` (`react/jni/JniJSModulesUnbundle.{h,cpp}`, 103+42 lines) | Zero references anywhere except its own 2 files and `react/jni/CMakeLists.txt:64`. **Dead code — the legacy unbundle path is unreachable from C++.** |
| `jsModulesDir` (`react/jni/JniJSModulesUnbundle.cpp:31`) | 2 hits, both inside `JniJSModulesUnbundle.cpp` (`:31`, `:35`, `:66`) |
| `buildNativeModuleList` (`react/jni/ModuleRegistryBuilder.cpp:30`) | Only defined + declared + a C++ test (`react/jni/test/ModuleRegistryBuilderTest.cpp`). **Zero non-test callers in the repo.** |
| `ModuleHolder::getProvider` (`react/jni/ModuleRegistryBuilder.cpp:25-28`) | The lambda body is literally `return nullptr;` and the function has no callers outside `ModuleRegistryBuilder.{h,cpp}` |
| `JExecutor` (`react/jni/JExecutor.{h,cpp}`) | `react/jni/JExecutor.h` is included by `react/jni/InspectorNetworkRequestListener.h:14`; the only call is `react/runtime/jni/JReactHostInspectorTarget.cpp:32` (`javaExecutor->execute(jrunnable)`) via `JReactHostInspectorTarget.h:23`. **Live.** |
| `CxxModuleWrapperBase.h` / `JNativeModule` (`react/jni/CxxModuleWrapperBase.h:14`) | Included by `react/jni/ModuleRegistryBuilder.h:14` and `react/turbomodule/ReactCommon/TurboModuleManager.cpp:23`. The struct `JNativeModule` itself has **no other references** in the tree. |
| `JNativeModulePerfLogger` (`react/reactperflogger/reactperflogger/JNativeModulePerfLogger.h`) | Used only at `react/turbomodule/ReactCommon/OnLoad.cpp:10,17`. Live. |
| `CoreComponentsRegistry::sharedProviderRegistry` / `addCoreComponents` | Defined at `react/fabric/CoreComponentsRegistry.cpp:32` / `:38`; called from `react/newarchdefaults/DefaultComponentsRegistry.cpp:38,51`. Live. |
| `getPlatformComponentName` (`react/fabric/FabricMountingManager.cpp:285`) | 2 callers in the same file (`:418`, `:1142`). Live but file-local. |
| `ensureThreadDurationJNIEnvAttached` (`react/jni/SafeReleaseJniRef.cpp:12`) | Declared `react/jni/SafeReleaseJniRef.h:19`, called `react/jni/SafeReleaseJniRef.h:48`. Live. |
| `makeJWeakReference` (`react/jni/JWeakRefUtils.h:18`) | Called once: `react/runtime/jni/JReactHostInspectorTarget.cpp:25`. Live. |
| `newGlobalRef` (Yoga) | 4 call sites in `YogaJniException.cpp` (`:21,:25,:32`) and `YGJNIVanilla.cpp:173`. Live. |
| `JavaScriptExecutorHolder` (`react/jni/JavaScriptExecutorHolder.h`) | Used only as a base class of `HermesExecutorHolder` at `react/hermes/reactexecutor/OnLoad.cpp:50`. Live (but `[[deprecated]]`, and the whole file is inside `#ifndef RCT_REMOVE_LEGACY_ARCH`). |
| `callStaticObjectMethod` (`first-party/yogajni/jni/common.h:63`) | Called once: `first-party/yogajni/jni/YGJNIVanilla.cpp:136`. Live. |

### 6.2 Confirmed dead: `ModuleHolder::getProvider` returns `nullptr` unconditionally

`packages/react-native/ReactAndroid/src/main/jni/react/jni/ModuleRegistryBuilder.cpp:25-28`:
```cpp
xplat::module::CxxModule::Provider ModuleHolder::getProvider(
    const std::string& moduleName) const {
  return [self = jni::make_global(self()), moduleName] { return nullptr; };
}
```
The lambda ignores `self` and `moduleName` and unconditionally returns `nullptr`. The `make_global(self())` creates a global ref captured by a lambda that may outlive the object. **Zero callers of `getProvider` in the repo** (`grep -rl getProvider` outside the jni tree returns 3 files, none of which call this overload — 未确认 which; only the definition exists in-tree).

### 6.3 Commented-out code blocks

`grep -rn -E '^\s*(//|/\*)\s*(if|for|while|return|auto |std::|[A-Za-z_]+ [a-zA-Z_]+\s*[=;(])'` over the tree (excluding `jni-hack`) returns 16 hits. Reviewing each: **all 16 are prose comments, not commented-out code.** Notably:
- `react/turbomodule/ReactCommon/TurboModuleManager.cpp:185` and `:276` are inside the long explanatory NOTE; they read `// std::string, fbjni creates a temporary local_ref<JString> for the argument.` — prose.
- `react/fabric/FabricMountingManager.cpp:986` — `// for space efficiency.` — prose.

**No commented-out code blocks were found in non-test files of this tree.**

---

## 7. COMMENTS OF NOTE

### 7.1 TODO / FIXME / HACK / XXX / WORKAROUND / NOTE

Command: `grep -rniE '(TODO|FIXME|HACK|XXX|WORKAROUND|NOTE:|BUG:)' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v first-party/jni-hack/real/jni.h` → 24 hits. All non-test hits listed below verbatim.

| Path:line | Exact text |
| --- | --- |
| `first-party/jni-lib-merge/jni_lib_merge.h:68` | `/* Note: relying on SoLoader's synchronization for thread-safety. */` |
| `first-party/yogajni/jni/LayoutContext.h:15` | `// TODO: This should not be exported or used outside of the JNI bindings` |
| `first-party/yogajni/jni/corefunctions.cpp:44` | `// TODO why we need JNIEXPORT for getCurrentEnv ?` |
| `react/mapbuffer/react/common/mapbuffer/JReadableMapBuffer.cpp:13` | `  // TODO T83483191: Reevaluate what's the best approach here (allocateDirect vs` (continues `:14`: `  // DirectByteBuffer).`) |
| `react/runtime/jni/JReactInstance.cpp:36` | `  // TODO(janzer): Lazily create runtime` |
| `react/runtime/jni/JReactInstance.cpp:74` | `  // TODO T194671568 Consider moving runtime init to the JS thread.` |
| `react/runtime/jni/JReactInstance.cpp:160` | ` * TODO T44251068 Replace with runtimeExecutor` |
| `react/turbomodule/ReactCommon/TurboModuleManager.h:45` | `   * TODO(T48018690):` (with body `:46-48`: `All modules are currently long-lived.` / `We need to come up with a mechanism to allow modules to specify whether` / `they want to be long-lived or short-lived.`) |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:180` | `  // TODO(T248203434): Remove this workaround once fixed in fbjni` |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:181` | `  // NOTE: We use jstring instead of std::string for the method signature to` (full block `:180-192`) |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:271` | `  // TODO(T248203434): Remove this workaround once fixed in fbjni` (duplicate of `:180`) |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:272` | `  // NOTE: We use jstring instead of std::string for the method signature to` (duplicate block `:271-283`) |
| `react/turbomodule/ReactCommon/OnLoad.cpp:24` | `    // TODO: dvacca ramanpreet unify this with the way` (`:25`: `// "ComponentDescriptorFactory" is defined in Fabric`) |
| `react/fabric/FabricMountingManager.cpp:284` | `// TODO: this method will be removed when binding for components are code-gen` |
| `react/fabric/FabricMountingManager.cpp:987` | `  // FIXME: this optimization is incorrect when multiple transactions are` (`:988`: `  // merged together`) |
| `react/fabric/FabricUIManagerBinding.cpp:637` | `  // TODO: (T132338609) runtimeExecutor should execute lambdas after` (`:638`: `// main bundle eval, and bindingsInstallExecutor should execute before.`) |
| `react/jni/JReactMarker.cpp:108` | `  // TODO: refactor this to a bidirectional map along with` (`:109`: `// logPerfMarkerWithInstanceKey`) |
| `react/jni/MethodInvoker.cpp:46` | `// HACK: Exposes constructor` |
| `react/jni/MethodInvoker.cpp:64` | `    // TODO: this truncates 64 bit ints, valid in JS` |
| `react/jni/JavaModuleWrapper.cpp:136` | `  // TODO: evaluate whether calling through invoke is potentially faster` |
| `third-party/glog/config.h:178` | `/* TODO(vjn/dreiss): revisit these when use the android-21 (or newer) NDK platform. */` |

Test-file hits (out of scope but recorded): `react/fabric/test/FabricMountingManagerTest.cpp` has no TODO/FIXME hits; `react/jni/test/*` and `react/reactnativeblob/test/*` likewise (the grep matched none).

Also `react/newarchdefaults/rncore.h:10-14` contains a deprecation `#warning`:
```
#warning \
    "[DEPRECATION] `rncore.h` is deprecated and will be removed in the future. \
```

### 7.2 Comments stating a numeric constant, threshold, timeout, or API-level condition

| Path:line | Exact text |
| --- | --- |
| `react/devsupport/JInspectorNetworkReporter.cpp:38` | `  const size_t maxBodySize = 1024 * 1024; // 1MB` |
| `react/devsupport/JInspectorNetworkReporter.cpp:44-46` | `  if (bytesToRead < bodyLength) {`<br>`    requestBody += "\n... [truncated, showing " + std::to_string(bytesToRead) +`<br>`        " of " + std::to_string(bodyLength) + " bytes]";` |
| `react/runtime/jni/JReactInstance.cpp:139` | `  const int kAssetsLength = 9; // strlen("assets://");` — followed by `auto sourceURL = assetURL.substr(kAssetsLength);` at `:140` |
| `react/fabric/FocusOrderingHelper.cpp:54-56` | `// 13 is a magic number that comes from Android's implementation. We opt to use`<br>`// this to get the same focus ordering as Android. See:`<br>`// https://cs.android.com/android/platform/superproject/main/+/main:frameworks/base/core/java/android/view/FocusFinder.java;l=547` |
| `react/fabric/FocusOrderingHelper.cpp:60-61` | `  return 13.0 * majorAxisDistance * majorAxisDistance +`<br>`      minorAxisDistance * minorAxisDistance;` |
| `react/fabric/FabricUIManagerBinding.cpp:70` | `  auto frameTimeMs = static_cast<double>(frameTimeNanos) / 1000000.0;` |
| `react/hermes/reactexecutor/OnLoad.cpp:33-34` | `  if (heapSizeMB > 0) {`<br>`    gcConfigBuilder.withMaxHeapSize(heapSizeMB << 20);` |
| `react/hermes/reactexecutor/OnLoad.cpp:39` | `      .withEnableSampleProfiling(true)` |
| `first-party/yogajni/jni/YGJNI.h:10-18` | index constants: `const short int LAYOUT_EDGE_SET_FLAG_INDEX = 0;` … `const short int LAYOUT_BORDER_START_INDEX = 14;` |
| `first-party/yogajni/jni/YGJNI.h:22` | `const int HAS_NEW_LAYOUT = 16;` |
| `first-party/yogajni/jni/YGJNI.h:66` | `  static constexpr jint NAN_BYTES = 0x7fc00000;` |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:280` | `  std::array<float, 18> arr; // NOLINT(cppcoreguidelines-pro-type-member-init)` — **uninitialised 18-float buffer** |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:278-279` | `  const int arrSize = 6 + (marginFieldSet ? 4 : 0) + (paddingFieldSet ? 4 : 0) +`<br>`      (borderFieldSet ? 4 : 0);` |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:660-662` | `    static_assert(`<br>`        sizeof(measureResult) == 8,`<br>`        "Expected measureResult to be 8 bytes, or two 32 bit ints");` |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:317-318` | `    // Don't change this field name without changing the name of the field in`<br>`    // Database.java` (repeated at `:630-631` for `mLayoutDirection`) |
| `first-party/jni-lib-merge/jni_lib_merge.h:82` | `    if (!(ret == JNI_VERSION_1_2 || ret == JNI_VERSION_1_4 || ret == JNI_VERSION_1_6)) {` |
| `first-party/jni-lib-merge/jni_lib_merge.h:77` | `      /* Exception already thrown. */` |
| `first-party/jni-lib-merge/jni_lib_merge.h:90-91` | `    /* This path will be taken if we're not merged. */` / `/* Just call the original JNI_OnLoad. */` |
| `first-party/jni-lib-merge/jni_lib_merge.c:74` | `#ifdef INVOKE_ALL_JNI_ONLOAD` (compile-time API switch) |
| `first-party/jni-lib-merge/jni_lib_merge.c:33-34` | `// We also want` / `// the linker to retain it (since the section will be traversed at runtime).` |
| `first-party/jni-lib-merge/jni_lib_merge.c:36-39` | `#if __has_attribute(__retain__)` / `__attribute__((__retain__))` / `#endif` / `__attribute__((__section__("pre_merge_jni_libraries")))` |
| `first-party/jni-lib-merge/jni_lib_merge.h:33-37` | `#if __has_attribute(__retain__)` / `#define ATTRIBUTE_RETAIN __attribute__((__retain__))` / `#else` / `#define ATTRIBUTE_RETAIN` / `#endif` |
| `first-party/jni-lib-merge/jni_lib_merge.h:13` | `#ifdef JNI_MERGE_PRINT_ONLOAD` |
| `first-party/jni-lib-merge/jni_lib_merge.h:14` | `#ifdef __ANDROID__` |
| `first-party/yogajni/jni/macros.h:12,16` | `#ifdef __ANDROID__` (×2) |
| `first-party/fbgloginit/glog_init.cpp:16,93,97,122` | `#ifdef __ANDROID__` (×4) |
| `first-party/fbgloginit/glog_init.cpp:88` | `  for (auto i = 0; i < google::NUM_SEVERITIES; ++i) {` |
| `react/devsupport/JInspectorNetworkReporter.cpp:14` | `#ifdef REACT_NATIVE_DEBUGGER_ENABLED` (also `:54`, `:59`, `:127`, `:151`, `:168`) |
| `react/fabric/FabricMountingManager.cpp:75` | `#ifdef REACT_NATIVE_DEBUG` (also `:329`, `:347`) |
| `react/jni/OnLoad.cpp:16-18` | `#ifndef WITH_GLOGINIT` / `#define WITH_GLOGINIT 1` / `#endif` |
| `react/jni/OnLoad.cpp:20` | `#ifdef WITH_XPLATINIT` (also `:27`, `:29`) |
| `react/jni/OnLoad.cpp:32` | `#if WITH_GLOGINIT` |
| `react/jni/JavaModuleWrapper.cpp:19` | `#ifdef WITH_FBSYSTRACE` (also `:119`, `:123`) |
| `react/jni/MethodInvoker.cpp:25` | `#ifndef RCT_REMOVE_LEGACY_ARCH` (also `:320`) |
| `react/jni/JavaScriptExecutorHolder.h:13` | `#ifndef RCT_REMOVE_LEGACY_ARCH` (also `:36`) |
| `react/jni/JavaModuleWrapper.h:16` | `#ifndef RCT_REMOVE_LEGACY_ARCH` (also `:88`) |
| `react/jni/ModuleRegistryBuilder.h:17` | `#ifndef RCT_REMOVE_LEGACY_ARCH` (also `:39`) |
| `react/jni/ModuleRegistryBuilder.cpp:16` | `#ifndef RCT_REMOVE_LEGACY_ARCH` (also `:48`) |
| `react/jni/JniJSModulesUnbundle.cpp:20` | `#ifndef RCT_REMOVE_LEGACY_ARCH` (also `:103`) |
| `react/jni/JniJSModulesUnbundle.h:15` | `#ifndef RCT_REMOVE_LEGACY_ARCH` (also `:42`) |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:27` | `#ifndef RCT_REMOVE_LEGACY_MODULE_INTEROP` (also `:97`, `:227`, `:324`, `:329`, `:336`) |
| `react/turbomodule/ReactCommon/TurboModuleManager.h:51` | `#ifndef RCT_REMOVE_LEGACY_MODULE_INTEROP` (also `:53`, `:69`, `:72`) |
| `react/jni/JSLoader.cpp:59-60` | `        AASSET_MODE_STREAMING); // Optimized for sequential read: see`<br>`                                // AssetManager.java for docs` |
| `react/jni/JSLoader.cpp:63-66` | `      if (script->size() >= sizeof(BundleHeader)) {`<br>`        // When using bytecode, it's safe for the underlying buffer to not be \0`<br>`        // terminated. In all other scenarios, we will force a copy of the`<br>`        // script to ensure we have a terminator.` |
| `react/jni/JByteBufferMutableBuffer.h:48-50` | `    // GetDirectBufferAddress may report null for a zero-capacity direct buffer,`<br>`    // which getDirectBytes turns into an exception. An empty buffer has no bytes`<br>`    // to address, so report that directly instead.` |
| `react/runtime/jni/JReactInstance.cpp:90-93` | `  // Set up the JS and native modules call invokers (for TurboModules)`<br>`  // Shares the instance's BufferedRuntimeExecutor so async calls from native`<br>`  // are ordered against callFunctionOnModule and cannot run before the bundle`<br>`  // has evaluated. invokeSync still goes straight to the scheduler.` |

### 7.3 Comments that contradict the surrounding code

1. **`react/jni/JArrayBuffer.h:64-67` / `react/jni/JArrayBuffer.cpp:48-50`** — header says `bool isOwningBytes() const noexcept` returns `owningBytes_`, and the class comment says "When `owningBytes_` is true, the module may retain the buffer…". However `JArrayBuffer::create` (`JArrayBuffer.cpp:65-73`) calls `newObjectJavaArgs(byteBuffer, owningBytes)` — the Java constructor runs **before** `setNativePointer`, which is exactly the hazard documented at `JArrayBuffer.cpp:107-108`:
   ```
     // create() runs the Kotlin constructor before setNativePointer, so a Java
     // ArrayBuffer without a C++ peer is reachable if either step throws.
   ```
   The comment is consistent with the code; **no contradiction here.**

2. **`react/fabric/FabricMountingManager.cpp:1210-1214`** — the comment describes a value that the code does not compute:
   ```cpp
        // The closest non-flattened ancestor of the same value if the node is
        // not flattened. For now, we don't support the case when the node can
        // be flattened because the only component that uses this feature -
        // ScrollView - cannot be flattened.
        shadowView.tag,
   ```
   The argument passed is `shadowView.tag` (the node's **own** tag), not "the closest non-flattened ancestor". No ancestor computation exists anywhere in `FabricMountingManager.cpp`. **Comment contradicts code.**

3. **`react/jni/JSLoader.cpp:74-76`** vs. `:63-71` — the code claims to force a copy "In all other scenarios" but the copy uses `script->size()`, i.e. `AAsset_getLength(asset_)` (`JSLoader.cpp:37-39`), and `c_str()` is `AAsset_getBuffer(asset_)` (`JSLoader.cpp:32-34`). Whether `AAsset_getBuffer` NUL-terminates is an AAsset guarantee, **未确认**.

4. **`react/fabric/FabricMountingManager.cpp:98` comment** vs. `MountItem.h:61` — `Type type = {Create};` is a member initializer inside a `struct` whose constructors are all aggregate-initialised with an explicit `.type`, so the default is effectively unreachable. Not a contradiction, a dead default.

5. **`react/jni/JSLogging.cpp:17-18`** — `static_cast<android_LogPriority>(logLevel + ANDROID_LOG_DEBUG)`. `ANDROID_LOG_DEBUG` is `3`; `logLevel` is an unsigned int. If a caller passes `logLevel >= 7`, the sum exceeds the `android_LogPriority` enum range. **未确认** whether any caller does.

---

## 8. SUSPICIOUS / BUG-LIKE PATTERNS

### 8.1 `throw new std::runtime_error(...)` — throws a POINTER, not an object

`packages/react-native/ReactAndroid/src/main/jni/react/turbomodule/ReactCommon/TurboModuleManager.cpp:86-88`:
```cpp
    throw new std::runtime_error(
        std::string("Failed to convert jsiReturnKind \"") + jsiReturnKind +
        "\" to TurboModuleMethodValueKind");
```
The `new` is not in a `std::unique_ptr`/raw-pointer catch idiom — the exception object is heap-allocated and **leaked** unless a `catch (std::runtime_error*)` exists. Verified: there is no `catch (std::runtime_error*)` anywhere in the tree (`grep -rn 'catch (' ... | grep -v jni-hack` lists all catch clauses in §3.5; none match a pointer type). Furthermore, `std::exception_ptr`/`throw` semantics make `throw <pointer>` non-matching against `catch (const std::exception&)`, so this escapes `fbjni`'s JNI boundary translation. The function is `JMethodDescriptor::getJSIReturnKind()` (`TurboModuleManager.cpp:57-89`), reached from `getLegacyModule` (`:311`).

### 8.2 Unreachable statement after `return` in a switch

`packages/react-native/ReactAndroid/src/main/jni/react/jni/MethodInvoker.cpp:110-113`:
```cpp
    default:
      return false;
      ;
  }
```
Line 112 is a stray empty statement after `return false;`. Dead code.

### 8.3 Raw `reinterpret_cast` of a released `local_ref` (leak + type punning)

`packages/react-native/ReactAndroid/src/main/jni/react/fabric/FabricMountingManager.cpp:1242-1246`:
```cpp
  auto propsMap = reinterpret_cast<ReadableMap::javaobject>(
      ReadableNativeMap::newObjectCxxArgs(props).release());
  synchronouslyUpdateViewOnUIThreadJNI(javaUIManager_, viewTag, propsMap);
```
`ReadableNativeMap::newObjectCxxArgs(...)` returns a `local_ref`; `.release()` gives up ownership; the raw pointer is stored in a `auto` (deduced `ReadableMap::javaobject*`) and passed to the JNI call. The local ref is never deleted, and there is no `jni::adopt_local` wrapper (contrast with `:1170-1172` in the same file, which correctly wraps with `jni::adopt_local`). The local ref is reclaimed only when the enclosing native method's JNI local frame is popped by the JVM — which is safe here, but the pattern is inconsistent with the neighbouring code.

Compare `FabricMountingManager.cpp:1170-1173` (correct):
```cpp
  auto argsArray = jni::adopt_local(
      reinterpret_cast<ReadableArray::javaobject>(
          ReadableNativeArray::newObjectCxxArgs(args).release()));
```

### 8.4 Deliberate global-ref leak

`packages/react-native/ReactAndroid/src/main/jni/react/jni/NativeCommon.cpp:21-26`:
```cpp
// Returns a leaked global_ref.
alias_ref<ReadableType> getTypeField(const char* fieldName) {
  static auto cls = ReadableType::javaClassStatic();
  auto field = cls->getStaticField<ReadableType::javaobject>(fieldName);
  return make_global(cls->getStaticFieldValue(field)).release();
}
```
`.release()` on the `global_ref` abandons it. The caller's `alias_ref` is a non-owning view, so the global ref lives forever. The comment documents the intent; it is called from 6 sites in `ReadableType::getType` (`NativeCommon.cpp:33,37,42,46,50,54`).

### 8.5 Operator-precedence / always-false / dead-branch hazards

| Path:line | Pattern |
| --- | --- |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:276` | `fieldFlags |= HAS_NEW_LAYOUT;` where `fieldFlags` is `const int fieldFlags = edgesSet.get();` — writing to a `const` local. This is a **compile error** unless the compiler accepts `|=` on const (it does not); 未确认 whether this file is currently compiled in the OSS build. Note: `fieldFlags` is declared `const int` at `:275` and mutated at `:276`. |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:271-276` | `bool marginFieldSet = edgesSet.has(...)`, … then `int fieldFlags = edgesSet.get();` — `get()` is called on the same `edgesSet` object after three `has()` calls; no precedence issue but three redundant reads. |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:297-298,306-308` | `auto paddingStartIndex = static_cast<size_t>(LAYOUT_PADDING_START_INDEX - (marginFieldSet ? 0 : 4));` — `LAYOUT_PADDING_START_INDEX` is `const short int` (see `YGJNI.h:17`); the subtraction happens in `int`, then casts. Values stay in range. |
| `react/jni/MethodInvoker.cpp:205` | `jsArgCount_(countJsArgs(signature) - 2)` — `countJsArgs` returns `std::size_t`; if a malformed empty signature were passed, `- 2` **underflows to `SIZE_MAX`**. Guarded only by the `CHECK(signature_.at(1) == '.')` at `:208`, which runs **after** the member initializer at `:205` — i.e. the underflow would happen before the check. `:208` also calls `.at(1)` which throws `std::out_of_range` for a 1-char signature. |
| `react/jni/MethodInvoker.cpp:232-236` | `auto argCount = signature_.size() - 2;` then `std::vector<jvalue> argsStorage(argCount + 1); // ensure we have at least 1 element` — the comment describes an intent that the arithmetic does not implement (it is `+1` unconditional, not a `max(1, …)`); and the `size() - 2` underflow hazard is the same as `:205`. |
| `react/jni/MethodInvoker.cpp:108-109` | `case 'Z': case 'I': case 'F': case 'S': case 'A': case 'M': case 'X': return true;` — note the uppercase `Z` here maps to "nullable Boolean" while lowercase `z` at `:135` is the primitive; consistent. |
| `react/jni/JSLogging.cpp:17-18` | `static_cast<android_LogPriority>(logLevel + ANDROID_LOG_DEBUG)` — see §7.3 item 5. |
| `react/runtime/jni/JReactInstance.cpp:200` | `instance_->registerSegment((uint32_t)segmentId, segmentPath);` — **C-style cast of a signed `int` to `uint32_t`; negative IDs silently become huge.** The function is `noexcept` (`:199`), so any exception terminates. |
| `react/runtime/jni/JReactInstance.cpp:208` | `return (jlong)(intptr_t)instance_->getJavaScriptContext();` — C-style casts. |
| `react/runtime/jni/JJavaTimerManager.cpp:21` | `method(self(), timerID, (long)duration, static_cast<unsigned char>(repeat));` — `(long)` on Android LP64 is 64-bit, matching `jlong`; the third param is declared `jlong`. Consistent. |
| `react/fabric/FabricMountingManager.cpp:1151` | `static_cast<unsigned char>(isLayoutableShadowNode)` passed where the method signature at `:1121` declares `jboolean` (which *is* `unsigned char`) — correct but redundant. |
| `react/fabric/FabricMountingManager.cpp:1132-1133` | `bool preventPassingStateWrapperForText = strcmp(shadowView.componentName, "Paragraph") == 0;` — `shadowView.componentName` is `ComponentName` (`packages/react-native/ReactCommon/react/renderer/mounting/ShadowView.h:41`, `ComponentName componentName{};`), so this compiles only via an implicit conversion; 未确认 the conversion's exact type. Same `strcmp` at `:325-326`. |
| `react/fabric/FabricMountingManager.cpp:402-406` | `int x = round(scale(...))` etc. — `float` → `int` narrowing with `round()`, no overflow guard. |
| `react/fabric/FabricMountingManager.cpp:542-545` | `int insetLeft = floor(scale(contentInsets.left, pointScaleFactor));` — same narrowing. |
| `react/fabric/FabricMountingManager.cpp:296-313` | `scale()` (`FabricMountingManager.cpp:299-315`) calls `std::feclearexcept(FE_ALL_EXCEPT)` then `std::fetestexcept(FE_OVERFLOW)` / `FE_UNDERFLOW` and only **logs** — the inf/0 result is still returned and truncated into an `int`. |
| `react/fabric/FabricUIManagerBinding.cpp:111-112` | `template <typename T> static jni::local_ref<T> findLocal(T t);` — 未确认 fbjni's null contract for a returned `jclass`. |
| `react/fabric/FabricUIManagerBinding.cpp:560` and `:413` | `constraints.layoutDirection = (isRTL != 0u) ? ... : ...;` — `jboolean` compared against `0u` (unsigned); works. |
| `react/fabric/FabricUIManagerBinding.cpp:408,556` | `context.swapLeftAndRightInRTL = doLeftAndRightSwapInRTL != 0;` — `jboolean` compared to signed `0`; works. |
| `react/runtime/jni/JReactHostInspectorTarget.cpp:153` | `int quality = request.quality.value_or(-1);` — the sentinel `-1` is passed to `captureScreenshot(format, quality)` (`JReactHostInspectorTarget.h:157`) which forwards it as `jint`. 未确认 the Java-side meaning of `-1`. |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:207-208` | `if (moduleInstance->isInstanceOf(JTurboModuleWithJSIBindings::javaClassStatic())) {` — checked, good. |
| `first-party/yogajni/jni/YGJTypesVanilla.h:46` | `return ScopedLocalRef<jobject>(env);` inside `ref()` when the node isn't in the map — returns an **empty** `ScopedLocalRef` (null). Callers at `YGJNIVanilla.cpp:264` (`if (!obj) { return; }`), `:650` (`if (auto obj = ...)`), `:694`, `:766` all test it. Correct. |

### 8.6 Off-by-one / buffer-size hazards

| Path:line | Issue |
| --- | --- |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:121-123` | `int result = vsnprintf(nullptr, 0, format, argsCopy); std::vector<char> buffer(1 + static_cast<size_t>(result)); vsnprintf(buffer.data(), buffer.size(), format, args);` — (a) if `vsnprintf` returns `< 0` (encoding error), `static_cast<size_t>(result)` wraps and `1 + that` is a near-`SIZE_MAX` allocation; (b) the size is `result + 1`, which is exactly enough for the NUL but the returned `result` from `YGJNILogFunc` (`:155`) is the length **excluding** NUL. Verified consistent otherwise. |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:278-280` | `const int arrSize = 6 + (margin?4:0) + (padding?4:0) + (border?4:0);` → max **18**, and `std::array<float, 18> arr;` is exactly 18. `SetFloatArrayRegion(arrFinal.get(), 0, arrSize, arr.data())` at `:326`. **Bounds match**, but `arr` is **uninitialised** (`// NOLINT(cppcoreguidelines-pro-type-member-init)` at `:280`) and the padding/border start offsets (`:297-298`, `:306-308`) are computed to skip un-set regions — verified consistent with `arrSize`. |
| `react/fabric/FabricMountingManager.cpp:998-1002` | `react_native_assert(static_cast<int>(buffer.ints.size()) == batchMountItemIntsSize);` then `env->SetIntArrayRegion(ints, 0, static_cast<jsize>(buffer.ints.size()), buffer.ints.data());`. The `jintArray` is allocated with exactly `buffer.ints.size()` (`:1000`). Consistent. |
| `react/fabric/FabricMountingManager.cpp:382-393` | `InstructionBuffer::writeObjectsArray<N>` writes at `objectsPosition + i` **without bounds-checking** against `objects->size()`; `writeObject` likewise. `objectsPosition` is advanced by `N` (`objectsPosition += N;` at `:392`). **No overflow check anywhere in `InstructionBuffer`.** |
| `react/fabric/FabricMountingManager.cpp:400-407` | `writeMountItemPreamble`: `if (numItems == 1) { buffer.writeInt(mountItemType); } else { ... static_cast<int>(numItems) }` — **`numItems == 0` takes the `else` branch**, writing a `Multiple` preamble with count 0. All call sites guard with `if (!xxxMountItems.empty())` (`:963`, `:972`, `:989`, etc.), so unreachable — but the function itself is unguarded. |
| `react/mapbuffer/react/common/mapbuffer/JWritableMapBuffer.cpp:27-30` | `auto size = keys.size(); for (int i = 0; i < size; i++) { ... values->getElement(i); }` — `size` is signed `int` from `keys.size()` (an unsigned `jsize`). Signed/unsigned comparison; **`values` array length is never compared against `keys.size()`**. |
| `react/mapbuffer/react/common/mapbuffer/JWritableMapBuffer.cpp:64-71` | `std::vector<int32_t>(pinned.get(), pinned.get() + pinned.size())` — correct range construction. |
| `react/jni/MethodInvoker.cpp:233-243` | `JniLocalScope scope(env, static_cast<int>(argCount)); std::vector<jvalue> argsStorage(argCount + 1); jvalue* args = argsStorage.data(); std::transform(signature_.begin() + 2, signature_.end(), args, ...)` — the transform writes `signature_.size() - 2 == argCount` elements into a buffer of `argCount + 1`. Consistent. |
| `react/jni/MethodInvoker.cpp:94-97` | `extractPromise`: `auto resolve = extractCallback(instance, *it++); CHECK(it != end); auto reject = extractCallback(instance, *it++);` — the `it++` on line 94 happens **before** the `CHECK(it != end)` on line 95, so a 1-element promise leaves the iterator at `end` and `CHECK` fires. Correct ordering, but the `CHECK` is a fatal abort, not a Java exception. |
| `react/fabric/FabricUIManagerBinding.cpp:349-351` | `if (ancestorList.empty() \|\| ancestorList.size() < 2) { return nullptr; }` — `empty()` is implied by `size() < 2`; the first clause is redundant. |

### 8.7 Missing `delete` / double-delete possibilities

| Path:line | Analysis |
| --- | --- |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:41-48` | `jni_YGConfigFreeJNI`: `auto context = std::unique_ptr<ScopedGlobalRef<jobject>>{static_cast<ScopedGlobalRef<jobject>*>(YGConfigGetContext(config))}; YGConfigFree(config);` — **the `unique_ptr` deletes the `ScopedGlobalRef`, but `YGConfigFree` runs first** and does not know about the context. If `YGConfigFree` also reads/destroys the context, that is a double-free. Verified: `YGConfigFree` lives in `packages/react-native/ReactCommon/yoga/yoga/Yoga.cpp`; **未确认** whether it touches the context. |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:158-182` | `jni_YGConfigSetLoggerJNI`: when `logger == nullptr`, `delete context; YGConfigSetContext(config, nullptr);` (`:177-178`). If `jni_YGConfigFreeJNI` runs concurrently on the same config, both paths can touch `context` with no lock. |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:45-46, 164-165` | `static_cast` / `reinterpret_cast` of a `void*` returned by `YGConfigGetContext` back to `ScopedGlobalRef<jobject>*`. Type-punning through `void*`; no runtime type check. |
| `react/turbomodule/ReactCommon/TurboModuleManager.cpp:86` | `throw new std::runtime_error(...)` — the heap object is **never freed** (see §8.1). This is the clearest missing-`delete` in the tree. |
| `react/jni/ModuleRegistryBuilder.cpp:27` | `return [self = jni::make_global(self()), moduleName] { return nullptr; };` — creates a global ref inside a lambda whose body never uses `self`. If the lambda is copied/destroyed the ref is managed; if the lambda is never invoked the ref is still released at destruction. **Not a leak, but dead work.** |
| `first-party/yogajni/jni/YogaJniException.cpp:31-33` | Copy constructor calls `newGlobalRef` on `rhs.throwable_.get()`; if that is null this **aborts** via `logErrorMessageAndDie` (`common.cpp:102-104`). |
| `first-party/yogajni/jni/YogaJniException.cpp:35-41` | `~YogaJniException() { try { throwable_.reset(); } catch (...) { std::terminate(); } }` — `ScopedGlobalRef::reset` is `noexcept`-in-practice but calls `getCurrentEnv()` which can call `logErrorMessageAndDie` → `abort()` (`corefunctions.cpp:49-52`) if the thread is unattached. The `try/catch` cannot intercept an `abort()`. |
| `react/fabric/FabricMountingManager.cpp:1050-1077` | `destroyUnmountedShadowNode` takes `allocatedViewsLock` (`:1062`) then **releases it** before the `jni::ThreadScope::WithClassLoader` block (`:1071`). No lock-ordering issue observed. |
| `react/fabric/FabricUIManagerBinding.cpp:618-627` | `EventBeat::Factory eventBeatFactory = [eventBeatManager, &runtimeScheduler, globalJavaUiManager](...)` — **captures `runtimeScheduler` BY REFERENCE** (`:619`). `runtimeScheduler` is a **local** `std::shared_ptr` declared at `:607` inside `installFabricUIManager`. The factory is stored in `toolbox.eventBeatFactory` (`:642`) and copied into the `Scheduler` (`:648-649`), which **outlives the function**. When the factory is later invoked, `*runtimeScheduler` at `:625` dereferences a **dangling reference to a destroyed local `shared_ptr`**. **This is a use-after-free / dangling-capture bug.** |

### 8.8 Exception thrown without unwinding the C++ stack correctly

| Path:line | Issue |
| --- | --- |
| `react/runtime/jni/JReactExceptionManager.cpp:52` | `static local_ref<ProcessedErrorStackFrameImpl> create(...)` is called from `ProcessedErrorImpl::create` (`:53`) **before** the `try` block that starts at `:77`. If `JArrayList::create()` (`:51`) or `stack->add(...)` (`:53`) or `newInstance(...)` inside `ProcessedErrorStackFrameImpl::create` (`:33-37`) throws, it escapes `reportJsException` — and `reportJsException` is invoked from the `noexcept` lambda at `react/runtime/jni/JReactInstance.cpp:52` (`mutable noexcept`). The comment at `JReactExceptionManager.cpp:56-61` acknowledges this hazard for `extraData` only, and only guards `:77-86`. **The `:50-54` portion is unguarded.** |
| `react/runtime/jni/JReactInstance.cpp:52` | `[weakJReactExceptionManager = jni::make_weak(jReactExceptionManager)](...) mutable noexcept { ... }` — declared `noexcept`, so any C++ exception escaping it calls `std::terminate()`. |
| `react/tracing/PerformanceTracerCxxInterop.cpp:203-204` | `} catch (const std::exception&) {` — **empty body**. The exception is silently swallowed and no diagnostic is produced. |
| `react/jni/ReadableNativeMap.cpp:16-23` / `ReadableNativeArray.cpp:16-23` | `mapException(std::exception_ptr ex)` catches only `folly::TypeError`. If the rethrown exception is any other type, it **escapes** `mapException` entirely (it is `static` and has no other handler). **No caller of `mapException` exists in this tree** — `grep -rn 'mapException'` returns only the definitions and the `friend HybridBase` declarations; **dead code**. |
| `react/jni/JMessageQueueThread.cpp:36-43` | Only `jsi::JSError` is converted. Any other exception from `localRunnable()` propagates out of the JNI-backed `JNativeRunnable` trampoline on the Java thread. |
| `first-party/yogajni/jni/corefunctions.cpp:88` | `throw YogaJniException();` inside `assertNoPendingJniExceptionIf`. `YogaJniException()`'s ctor (`YogaJniException.cpp:15-22`) calls `FindClass`/`NewObject` — **if the VM is in a bad state, this ctor can itself abort** via `logErrorMessageAndDie` (`common.cpp:93/103`). Throwing an exception whose construction can `abort()` is not exception-safe. |
| `first-party/yogajni/jni/corefunctions.cpp:65-76` | `assertNoPendingJniException` calls `env->ExceptionClear()` (`:74`) **before** constructing `YogaJniException(throwable)` (`:75`) — correct ordering. |
| `first-party/yogajni/jni/YGJNIVanilla.cpp:362-374` | Catch handlers are the **last** statements of the function, so the stack is fully unwound. However `catch (const std::logic_error& ex)` at `:367` calls `env->ExceptionClear()` (`:368`) then `FindClass` (`:369`) — correct. Note there is **no** `catch (...)` fallback: any exception type other than `YogaJniException` or `std::logic_error` (e.g. `std::bad_alloc`, `std::runtime_error` from `std::string` ops) escapes `jni_YGNodeCalculateLayoutJNI` into the JVM. |

### 8.9 Other notable patterns

| Path:line | Observation |
| --- | --- |
| `react/fabric/FabricMountingManager.cpp:40-44` | `~FabricMountingManager()` calls `jni::ThreadScope::WithClassLoader([&]() { javaUIManager_.reset(); });` — captures by reference; safe here because the lambda runs synchronously. |
| `react/fabric/FabricMountingManager.cpp:1085-1089` | `static thread_local bool onMainThread = isOnMainThread();` in `maybePreallocateShadowNode` — the value is cached per-thread **forever**; if the calling thread later becomes the main thread, the cached value is stale. |
| `react/fabric/FabricUIManagerBinding.cpp:794` | `using namespace std::literals::string_view_literals;` declared **inside a function body** (`schedulerDidRequestPreliminaryViewAllocation`, `:792-822`) — style. |
| `react/fabric/FabricUIManagerBinding.cpp:730-765` | The three-branch `if/else if/else` on feature flags reads `scheduler_` at `:720` **without holding `installMutex_`** — `scheduler_` is written under the lock at `:648` and reset at `:661`. **Data race / TOCTOU.** |
| `react/fabric/FabricUIManagerBinding.cpp:861-863, 874-876, 883-885, 889-891` | `mountingManager_` read directly **without** `installMutex_`, while `uninstallFabricUIManager()` sets `mountingManager_ = nullptr` under `std::unique_lock lock(installMutex_)` at `:659-663`. **Data race.** |
| `react/fabric/FabricUIManagerBinding.cpp:794` | `using namespace std::literals::string_view_literals;` (see above) |
| `react/fabric/EventBeatManager.cpp:30-36` | `tick()` holds `mutex_` (`:31`) **while invoking** every observer's `tick()` (`:33-35`). `AndroidEventBeat::tick()` calls `induce()` (`AndroidEventBeat.cpp:32`), which runs arbitrary JS-driven work. **Observer code executes under the manager's lock**, and `addObserver`/`removeObserver` (`:18-28`) take the same non-recursive `std::mutex` — a re-entrant `addObserver` from an observer would deadlock. |
| `react/fabric/AndroidEventBeat.cpp:24, 28` | `eventBeatManager->addObserver(*this)` in the ctor and `eventBeatManager_->removeObserver(*this)` in the dtor — **`eventBeatManager_` is a raw pointer** (`AndroidEventBeat.h:31`) with no lifetime guarantee. |
| `react/tracing/PerformanceTracerCxxInterop.cpp:187, 190-192, 208` | `auto callbackWrapper = std::make_shared<uint32_t>(0);` then the lambda captures it by value and dereferences `*callbackWrapper` — but `*callbackWrapper = subscriptionId;` is only assigned at `:208`, **after** `tracer.subscribeToTracingStateChanges(...)` returns at `:189-206`. If the tracer invokes the callback synchronously during subscription, it reads `0`. **Race / ordering bug.** |
| `react/tracing/PerformanceTracerCxxInterop.cpp:187` | `std::make_shared<uint32_t>` is a non-atomic heap cell shared across threads with no synchronization. |
| `react/devsupport/JInspectorNetworkReporter.cpp:57` | `static std::unordered_map<std::string, std::string> responseBuffers;` — a **file-scope mutable global map** with no mutex, mutated at `:176` (`responseBuffers[requestIdStr]`) and `:133` (`responseBuffers.erase(it)`) from arbitrary threads. **Unbounded growth and data race.** |
| `react/jni/JniJSModulesUnbundle.cpp:23` | `const magic_number_t MAGIC_FILE_HEADER = 0xFB0BD1E5;` at **namespace scope, non-`static`** (`using magic_number_t = uint32_t;` at `:22` also non-static) — **external linkage / ODR risk**. |
| `react/jni/JniJSModulesUnbundle.cpp:24` | `const char* MAGIC_FILE_NAME = "UNBUNDLE";` — non-static `const char*` at namespace scope; internal linkage in C++ but still a mutable-target pointer. |
| `react/jni/JniJSModulesUnbundle.cpp:32` | `std::string dir = dirname(entryFile.c_str());` — `dirname` (POSIX, `<libgen.h>` at `:12`) **modifies its argument in place**. `entryFile.c_str()` returns a pointer to the internal buffer of a `const std::string&`; on libstdc++ pre-C++17 this buffer is guaranteed NUL-terminated but the callee may write through it. **UB-adjacent: passing a pointer into a `const std::string`'s buffer to a function that mutates it.** 未确认 whether `dirname` actually writes for this input shape. |
| `react/first-party/fbgloginit/glog_init.cpp:135` | `throw std::runtime_error{"Failed to initialize glog"};` — thrown from `initialize()`, which is called at `react/jni/OnLoad.cpp:33` inside the fbjni `initialize` lambda during `JNI_OnLoad`. A throw here propagates out of `JNI_OnLoad`, which the JVM does not expect. |
| `react/jni/OnLoad.cpp:34` | `FLAGS_minloglevel = 0;` — unconditional verbose logging when `WITH_GLOGINIT`. |
| `first-party/jni-lib-merge/jni_lib_merge.c:115` | `size_t num_merged_libraries = stop - start;` where `start`/`stop` are `struct pre_merge_jni_library*` from `__start_`/`__stop_pre_merge_jni_libraries`. If the section is empty the subtraction is 0; `calloc(0, …)` at `:118` may return NULL → `assert`/`abort` at `:119-122`. |
| `first-party/jni-lib-merge/jni_lib_merge.c:89` | `if (pmjl->onload_func(env, NULL /* unused */) < 0)` — `onload_func` is called **without a null check** (it is a function pointer stored in a linker-generated section). |
| `first-party/jni-lib-merge/jni_lib_merge.c:144` | `(*env)->RegisterNatives(env, invoke_class, natives, num_actual_methods);` — `num_actual_methods` is `ptrdiff_t` (`:141`: `cur_native - natives`) passed as `jint`. Narrowing on large merges. |
| `first-party/jni-lib-merge/jni_lib_merge.c:151` | `if (ret < 0) { // Exception already thrown. return JNI_ERR; }` — the `natives` array and its `name` strings are freed at `:146-149` **before** the return value is checked. Correct. |
| `react/fabric/FabricMountingManager.cpp:986-995` | The `FIXME` at `:987` flags a known incorrectness in the delete-batching optimization. |
| `react/jni/JArrayBuffer.cpp:93-97` | `jni::JByteBuffer::allocateDirect(static_cast<jint>(size))` — **`size_t` → `jint` truncation**; a buffer larger than `INT_MAX` bytes would allocate a truncated region, then `std::memcpy(byteBuffer->getDirectBytes(), bytes, size)` at `:96` would write `size` bytes into it → **heap buffer overflow**. 未确认 whether any caller can pass such a size. |
| `react/jni/JArrayBuffer.cpp:77` | `jni::JByteBuffer::wrapBytes(buffer->data(), buffer->size())` — for a zero-size buffer `data()` returns `nullptr` (`JByteBufferMutableBuffer.h:51-53`); `wrapBytes(nullptr, 0)` 未确认 behaviour. |

---

## Appendix: commands used for every numeric claim

```
# Section 1
find packages/react-native/ReactAndroid/src/main/jni/ -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.c' \) | wc -l
find packages/react-native/ReactAndroid/src/main/jni/ -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.c' \) | xargs wc -l | tail -1
find packages/react-native/ReactAndroid/src/main/jni/ -type d | sort
cd packages/react-native/ReactAndroid/src/main/jni/ && find . -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.c' \) -not -path '*/test/*' -not -path '*/tests/*' -not -path '*/test_helper/*' | wc -l
cd packages/react-native/ReactAndroid/src/main/jni/ && find . -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.c' \) -not -path '*/test/*' -not -path '*/tests/*' -not -path '*/test_helper/*' | xargs wc -l | tail -1
cd packages/react-native/ReactAndroid/src/main/jni/ && find . -type f \( -name '*.cpp' -o -name '*.h' -o -name '*.c' \) | xargs wc -l | sort -rn | head -35

# Section 2
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rn 'JNIEXPORT' --include='*.cpp' --include='*.h' --include='*.c' . | wc -l
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rc 'JNIEXPORT' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v ':0$'
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rn 'JNIEXPORT' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v jni-hack | grep -v /test | wc -l
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rn 'makeNativeMethod(' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v first-party/jni-hack | wc -l
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -c '^    {"jni_' first-party/yogajni/jni/YGJNIVanilla.cpp
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rn 'JNINativeMethod' --include='*.cpp' --include='*.h' --include='*.c' .
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rn 'registerNatives' --include='*.cpp' --include='*.h' --include='*.c' .

# Section 3
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rn 'ThrowNew\|jni_throw\|Throw(\|__android_log_assert\|FatalError\|abort()\|std::terminate\|assert(' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v 'first-party/jni-hack/real/jni.h'
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rn 'try {\|catch (\|catch(\|catch (\.\.\.)\|noexcept' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v 'first-party/jni-hack/real/jni.h'
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rn 'RNJni\|JniException\|PendingException' --include='*.cpp' --include='*.h' --include='*.c' .

# Section 4
cd packages/react-native/ReactAndroid/src/main/jni/ && for p in NewGlobalRef DeleteGlobalRef NewLocalRef DeleteLocalRef NewWeakGlobalRef PushLocalFrame PopLocalFrame EnsureLocalCapacity GetStringUTFChars ReleaseStringUTFChars GetStringChars ReleaseStringChars GetStringCritical ReleaseStringCritical GetPrimitiveArrayCritical ReleasePrimitiveArrayCritical; do grep -rn "$p" --include='*.cpp' --include='*.h' --include='*.c' . | grep -v 'first-party/jni-hack' | wc -l; done
cd packages/react-native/ReactAndroid/src/main/jni/react && grep -rn 'AttachCurrentThread\|DetachCurrentThread\|GetEnv(\|ThreadScope\|ThreadDetachScope\|makeScopeClassLoader' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v 'first-party/jni-hack'
cd packages/react-native/ReactAndroid/src/main/jni/react && grep -rn 'make_global' --include='*.cpp' --include='*.h' .
cd packages/react-native/ReactAndroid/src/main/jni/react && grep -rn '\.release()' --include='*.cpp' --include='*.h' .

# Section 5
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rn 'FindClass\|GetMethodID\|GetFieldID\|GetStaticMethodID\|GetStaticFieldID\|findClassStatic\|findClassLocal' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v 'first-party/jni-hack'

# Section 6
grep -rl '<sym>' packages/ private/ --include='*.h' --include='*.cpp' --include='*.c' --include='*.java' --include='*.kt' | grep -v '/jni/' | wc -l
grep -rn '<sym>' packages/ private/   # for the specific symbols listed

# Section 7
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rniE '(TODO|FIXME|HACK|XXX|WORKAROUND|NOTE:|BUG:)' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v 'first-party/jni-hack/real/jni.h'
cd packages/react-native/ReactAndroid/src/main/jni/ && grep -rn -E '^\s*(//|/\*)\s*(if|for|while|return|auto |std::|[A-Za-z_]+ [a-zA-Z_]+\s*[=;(])' --include='*.cpp' --include='*.h' --include='*.c' . | grep -v 'first-party/jni-hack'
```