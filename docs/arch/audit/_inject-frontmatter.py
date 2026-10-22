#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""一次性脚本：为 docs/arch 下每篇文档注入 YAML front-matter（检索元数据）。
front-matter 一旦注入即成为「文档自身的真相源」；
INDEX/_taxonomy.json 只定义主题树与症状词表，check-index.mjs 校验两者一致。
"""
import io, os, re, json, sys

D = 'docs/arch'
TAX = json.load(io.open('docs/arch/INDEX/_taxonomy.json', encoding='utf-8'))

# 手工编制的每篇文档元数据：topic / symptoms / symbols / platforms / architecture / layer
M = {
 1:("OV.map", [], ["ReactNative","Metro"], "cross", "cross", "T0"),
 2:("OV.map", [], ["package.json","packages/"], "cross", "cross", "T0"),
 3:("OV.core", ["slowstart","layout"], ["UIManager","ShadowTree","MountingCoordinator"], "cross", "fabric", "T0"),
 4:("DG.crash", ["crash","debug"], ["JsErrorHandler","OnJsError","extraDataMarshallingError"], "cross", "cross", "T1"),
 5:("DG.watch", ["crash","whitescreen","oom","mempressure","jank"], ["ReactMarker","FrameRateLogger"], "cross", "cross", "T1"),
 6:("OV.issues", ["debug"], [], "cross", "cross", "T0"),
 7:("RN.model", ["prop"], ["ShadowNode","Props","BaseViewProps"], "cross", "fabric", "T1"),
 8:("RN.diff", ["prop"], ["ComponentDescriptor","ShadowNodeFamily"], "cross", "fabric", "T1"),
 9:("RN.diff", ["prop","layout"], ["UIManager","calculateShadowTree","revision"], "cross", "fabric", "T1"),
 10:("RN.view", ["layout"], ["ViewShadowNode","ViewProps"], "cross", "fabric", "T1"),
 11:("RT.bridge", ["bridge","crash"], ["RuntimeExecutor","JsErrorHandler"], "cross", "cross", "T1"),
 12:("DG.mem", ["memleak"], ["LongLivedObjectCollection","ShadowNode"], "cross", "fabric", "T1"),
 13:("RT.js", ["slowstart","debug"], ["setUpReact","setUpGlobals"], "cross", "cross", "T1"),
 14:("FD.turbo", ["bridge"], ["TurboModule","MethodMetadata","JsiTurboModule"], "cross", "cross", "T2"),
 15:("RT.host", ["slowstart","whitescreen"], ["ReactActivity","ReactHost","ReactInstance"], "android", "cross", "T3"),
 16:("PL.android", ["prop"], ["UIManagerModule","NativeViewHierarchyManager"], "android", "legacy", "T3"),
 17:("PL.android", ["prop"], ["ViewManager","BaseViewManager"], "android", "legacy", "T3"),
 18:("PL.jni", ["crash","bridge"], ["JNI_OnLoad","JavaExceptionTranslator"], "android", "cross", "T3"),
 19:("RT.host", ["whitescreen","slowstart"], ["SurfaceHandler","RCTSurfaceHostingProxy"], "ios", "fabric", "T3"),
 20:("PL.ios", ["crash"], ["RCTFatal","RCTSetLogFunction"], "ios", "cross", "T3"),
 21:("PL.ios", ["prop"], ["RCTViewComponentView","RCTComponentViewProtocol"], "ios", "fabric", "T3"),
 22:("PL.ios", ["crash","whitescreen"], ["RCTRedBox","RCTLogBox"], "ios", "cross", "T3"),
 23:("PL.ios", ["bridge"], ["RCTConvert","RCTAssert","RCTLog"], "ios", "cross", "T3"),
 24:("PL.ios", ["gesture"], ["RCTTouchHandler","RCTEventDispatcher"], "ios", "cross", "T3"),
 25:("RT.host", ["slowstart","bridge"], ["RCTCxxBridge","RCTPerformanceLogger"], "ios", "cross", "T3"),
 26:("PL.ios", [], ["RCTImageLoader","RCTKeyChain","RCTNetworking"], "ios", "cross", "T3"),
 27:("DG.perf", ["jank"], ["RCTPerformanceLogger","RCTFrameUpdate"], "ios", "cross", "T3"),
 28:("PL.ios", ["debug"], ["RCTDevMenu","RCTDevLoadingView"], "ios", "cross", "T3"),
 29:("PL.ios", ["a11y"], ["RCTDeviceInfo","RCTAccessibilityManager"], "ios", "cross", "T3"),
 30:("PL.ios", ["debug"], ["RCTInspector","RCTWebSocket"], "ios", "cross", "T3"),
 31:("RN.view", ["mempressure","memleak"], ["ViewShadowNode","MountingCoordinator"], "cross", "fabric", "T1"),
 32:("RN.widget", ["layout"], ["ScrollViewShadowNode","ScrollViewState"], "cross", "fabric", "T1"),
 33:("RN.widget", ["gesture"], ["AndroidTextInputProps","TextInputState"], "cross", "fabric", "T1"),
 34:("RN.widget", ["layout"], ["ModalShadowNode","VirtualView"], "cross", "fabric", "T1"),
 35:("RN.widget", ["jank"], ["ImageShadowNode","ImageSource"], "cross", "fabric", "T1"),
 36:("RN.legacy", ["gesture"], ["RCTComponentData","RCTHitTest"], "ios", "legacy", "T1"),
 37:("RN.legacy", ["layout"], ["RCTShadowView","RCTUIManager"], "ios", "legacy", "T1"),
 38:("PL.ios", ["animation"], ["RCTEventEmitter","RCTLayoutAnimation"], "ios", "cross", "T3"),
 39:("PL.ios", ["bridge"], ["RCTTurboModule","RCTTurboModuleManager"], "ios", "cross", "T2"),
 40:("PL.android", ["debug","jank"], ["ReactMarkerConstants","ReactMarker"], "android", "cross", "T3"),
 41:("DG.route", ["crash"], ["NativeModuleCallExceptionHandler","JSApplicationIllegalArgumentException"], "android", "cross", "T1"),
 42:("DG.mem", ["mempressure","oom","memleak"], ["onTrimMemory","ViewPool","ReactNativeApplicationEntryPoint"], "android", "cross", "T1"),
 43:("DG.route", ["crash"], ["handleException","unhandledrejection"], "cross", "cross", "T1"),
 44:("DG.route", ["whitescreen","slowstart"], ["ReactRootView","setIsFabric"], "android", "cross", "T1"),
 45:("PL.android", ["prop","memleak"], ["ViewManager","ViewManagerPropertyUpdater"], "android", "legacy", "T3"),
 46:("RN.layout", ["prop"], ["ShadowNode","markDirty"], "android", "cross", "T1"),
 47:("PL.android", ["a11y"], ["AccessibilityDelegate","ReactAccessibilityDelegate"], "android", "cross", "T3"),
 48:("PL.android", ["gesture"], ["JSPointerDispatcher","PointerEvents"], "android", "cross", "T3"),
 49:("TL.build", ["build","debug"], ["exec_swallow_error.sh","cxx-api"], "cross", "cross", "T4"),
 50:("PL.jni", ["crash","bridge"], ["FabricUIManagerBinding","MethodInvoker"], "android", "cross", "T3"),
 51:("AN.drive", ["animation"], ["NativeAnimatedNodesManager","NativeAnimatedDriver"], "cross", "cross", "T2"),
 52:("FD.turbo", ["build"], ["CodeGenerator","GenerateModuleJniH"], "cross", "cross", "T2"),
 53:("RN.layout", ["layout","text"], ["YGNodeLayoutGetMeasuredDimensions","LayoutMetrics"], "cross", "fabric", "T1"),
 54:("PL.ios", ["bridge"], ["RCTConvert","RCT_JSON_CONVERTER"], "ios", "cross", "T3"),
 55:("DG.perf", ["jank"], ["ReactMarker","FrameRateLogger"], "cross", "cross", "T1"),
 56:("FD.api", ["debug"], ["__DEV__","invariant"], "cross", "cross", "T2"),
 57:("AN.node", ["animation"], ["AnimatedInterpolation","AnimatedNode"], "cross", "cross", "T2"),
 58:("RN.layout", ["layout"], ["Transform","MatrixMathHelper"], "cross", "fabric", "T2"),
 59:("FD.promise", ["bridge","crash"], ["PromiseImpl","updateErrorFromErrorData"], "cross", "cross", "T2"),
 60:("RN.model", [], ["primitives.h","ViewEvents","BorderStyle"], "cross", "fabric", "T1"),
 61:("RN.widget", ["layout"], ["ScrollViewShadowNode","CullingContext"], "cross", "fabric", "T1"),
 62:("FD.api", ["debug","build"], ["UmbrellaGuard","RN_STRICT_API"], "cross", "cross", "T4"),
 74:("FD.buffer", ["prop","contentgrowth"], ["MapBufferBuilder","MapBuffer","PerformanceObserver","AttributedString"], "cross", "cross", "T2"),
 73:("DG.logbox", ["crash","debug"], ["parseLogBoxLog","LogBoxData","LogBoxSymbolication","LogBoxLog"], "cross", "cross", "T2"),
 72:("RN.debug", ["debug","crash"], ["DebugStringConvertible","RN_DEBUG_STRING_CONVERTIBLE","flags.h"], "cross", "cross", "T2"),
 71:("RT.legacy", ["bridge","debug"], ["JSBigString","JSBigBufferString","RecoverableError","RN_EXPORT"], "cross", "legacy", "T3"),
 70:("RN.text", ["text","layout"], ["TextAttributes","ParagraphAttributes","AttributedString","AttributedStringBox"], "cross", "cross", "T2"),
 69:("RT.legacy", ["bridge","crash","memleak"], ["Instance","NativeToJsBridge","ModuleRegistry","JSCallInvoker","normalizeName"], "cross", "legacy", "T3"),
 68:("TL.release", ["build","debug"], ["set-version","ReactNativeVersion","parseVersion","VERSION_REGEX"], "cross", "cross", "T4"),
 67:("TL.flags", ["debug","build"], ["ReactNativeFeatureFlagsOverridesOSSStable","ReactNativeFeatureFlagsDefaults","SignedSource","verify-unchanged"], "cross", "cross", "T4"),
 66:("DG.perf", ["memleak","contentgrowth","jank"], ["PerformanceEntryReporter","PerformanceEntryKeyedBuffer","CircularBuffer","CdpMetricsReporter","RAMBundleRegistry"], "cross", "cross", "T2"),
 65:("DG.infra", ["crash","debug"], ["react_native_assert","react_native_expect","RedBoxErrorParser","JscSafeUrl","StackTraceParser"], "cross", "cross", "T1"),
 64:("RN.infra", ["crash","jank","debug"], ["ComponentDescriptorRegistry","ComponentDescriptorProviderRegistry","componentNameByReactViewName","Element","ComponentBuilder","MapBuffer","NativeDOM"], "cross", "fabric", "T1"),
 63:("FD.api", ["jank","contentgrowth","slowstart","layout"], ["floatEquality","SimpleThreadSafeCache","ContextContainer","hash_combine"], "cross", "cross", "T4"),
}

SYMSET = set(TAX['symptoms'].keys())
TOPICSET = set()
for d in TAX['domains']:
    for s in d['subs']:
        TOPICSET.add(d['id'] + '.' + s['id'].split('.', 1)[1])

def claims_of(text):
    codes = []
    for line in text.split('\n'):
        m = re.match(r'^\|\s*\*{0,2}([A-Z]{2,4}-\d+[a-z]?)\*{0,2}\s*\|', line)
        if m and m.group(1) not in codes:
            codes.append(m.group(1))
    return codes

def yaml_str(s):
    return '"' + s.replace('\\', '\\\\').replace('"', '\\"') + '"'

changed = 0
for fn in sorted(os.listdir(D)):
    m = re.match(r'^(\d{2})-(.+)\.md$', fn)
    if not m:
        continue
    n = int(m.group(1))
    if n not in M:
        print('MISSING META', n, fn); sys.exit(1)
    topic, syms, symbols, plats, arch, layer = M[n]
    p = os.path.join(D, fn)
    t = io.open(p, encoding='utf-8').read()
    if t.startswith('---\n'):
        end = t.index('\n---\n', 4) + len('\n---\n')
        t = t[end:].lstrip('\n')
        print('RE-INJECT', n)
    for s in syms:
        if s not in SYMSET:
            print('BAD SYMPTOM', n, s); sys.exit(1)
    # 主题校验
    dom = topic.split('.')[0]
    sub = topic.split('.', 1)[1]
    if topic not in {dd['id'] + '.' + ss['id'].split('.', 1)[1] for dd in TAX['domains'] for ss in dd['subs']}:
        print('BAD TOPIC', n, topic); sys.exit(1)
    title = t.split('\n', 1)[0]
    title = title.lstrip('# ').split(' · ', 1)[1] if ' · ' in title else title.lstrip('# ')
    fm = [
        '---',
        'id: %d' % n,
        'title: %s' % yaml_str(title),
        'topic: %s' % topic,
        'symptoms: [%s]' % ', '.join(syms),
        'platforms: [%s]' % plats,
        'architecture: [%s]' % arch,
        'layer: %s' % layer,
        'symbols: [%s]' % ', '.join(yaml_str(x) for x in symbols),
        'claims: [%s]' % ', '.join(claims_of(t)),
        '---',
        '',
    ]
    io.open(p, 'w', encoding='utf-8').write('\n'.join(fm) + t)
    changed += 1
print('已注入 front-matter:', changed, '篇')
