# Probe B1 — TurboModule + Codegen 全量事实清单

只读分析，未修改任何仓库文件（除本报告）。
仓库：`react-native`（`@react-native/codegen` 版本 `0.87.0-main`，见 `packages/react-native-codegen/package.json:3`）。
所有 `path:line` 均为仓库相对路径。所有引文逐字复制。计数均为实测，命令附后。

---

## 1. FILE INVENTORY

### 1.1 每个目录的非测试文件数与总行数

| 目录 | 命令 | 文件数 | 总行数 |
|---|---|---|---|
| `packages/react-native-codegen/src` | `find packages/react-native-codegen/src -type f -not -path "*/__tests__/*" -not -path "*/__test_fixtures__/*"` / 同一集合 `wc -l` | **90** | **22041** |
| `packages/react-native/Libraries/TurboModule` | `find packages/react-native/Libraries/TurboModule -type f` | **2** | **85** |
| `packages/react-native/src/private/specs_DEPRECATED` | `find packages/react-native/src/private/specs_DEPRECATED -type f` | **50** | **2225** |
| `packages/react-native-codegen/e2e` | `find packages/react-native-codegen/e2e -type f -not -path "*__tests__*" -not -path "*__test_fixtures__*"` | **0** | **0** |

补充实测：

- `find packages/react-native-codegen/src -type f | wc -l` = **170**；测试/夹具文件 `find packages/react-native-codegen/src -type f \( -path "*/__tests__/*" -o -path "*/__test_fixtures__/*" \) | wc -l` = **80**。非测试 90 + 测试 80 = 170 ✔
- `packages/react-native-codegen/e2e` 全部 100 个文件都位于 `__tests__/` 或 `__test_fixtures__/` 下；`find packages/react-native-codegen/e2e -type f -print0 | xargs -0 wc -l | tail -1` = **24706 total**（全部为测试内容）。
- `packages/react-native/src/private/specs_DEPRECATED/modules` = 49 个 `.js`，`wc -l` 合计 **2213**；另有 `__docs__/README.md` 12 行。
- `packages/react-native-codegen/scripts/`（包根，非 `src`）：`build.js` 121 行、`oss/build.sh` 82 行，合计 203 行。

### 1.2 `react-native-codegen/src` 子目录分布

命令：`for d in cli parsers generators; do find $d -type f -not -path "*__tests__*" -not -path "*__test_fixtures__*" | wc -l; … | xargs -0 wc -l | tail -1; done`

| 子目录 | 文件数 | 行数 |
|---|---|---|
| `src/cli` | 8 | 491 |
| `src/parsers` | 32 | 9224 |
| `src/generators` | 46 | 11310 |
| `src`（根级 `*.js`/`*.ts`） | 4 | 1016 |

二级细分（同命令，`-maxdepth 1`）：

| 子目录 | 文件数 | 行数 |
|---|---|---|
| `generators/components` | 21 | 5630 |
| `generators/modules` | 5 | 2314 |
| `generators/modules/GenerateModuleObjCpp` | 5 | 1204 |
| `generators/modules/GenerateModuleObjCpp/header` | 4 | 617 |
| `generators/modules/GenerateModuleObjCpp/source` | 1 | 167 |
| `generators/TypeUtils/Cxx` | 1 | 17 |
| `generators/TypeUtils/Java` | 1 | 27 |
| `generators/TypeUtils/Objective-C` | 1 | 17 |
| `parsers/flow` | 4 | 666 |
| `parsers/flow/components` | 4 | 1088 |
| `parsers/flow/modules` | 1 | 328 |
| `parsers/typescript` | 3 | 919 |
| `parsers/typescript/components` | 5 | 1170 |
| `parsers/typescript/modules` | 1 | 463 |
| `parsers/consistency` | 1 | 95 |
| `cli/combine` | 4 | 355 |
| `cli/generators` | 1 | 73 |
| `cli/parser` | 3 | 63 |

### 1.3 30 个最大的非测试文件（精确行数）

命令：
`find packages/react-native-codegen/src packages/react-native/Libraries/TurboModule packages/react-native/src/private/specs_DEPRECATED packages/react-native-codegen/e2e -type f -not -path "*__tests__*" -not -path "*__test_fixtures__*" -print0 | xargs -0 wc -l | sort -rn | head -31`

| # | 行数 | 文件 |
|---|---|---|
| 1 | 1424 | `packages/react-native-codegen/src/parsers/parsers-commons.js` |
| 2 | 918 | `packages/react-native-codegen/src/generators/components/GeneratePropsH.js` |
| 3 | 815 | `packages/react-native-codegen/src/parsers/parsers-primitives.js` |
| 4 | 772 | `packages/react-native-codegen/src/generators/modules/GenerateModuleH.js` |
| 5 | 681 | `packages/react-native-codegen/src/generators/modules/GenerateModuleJavaSpec.js` |
| 6 | 638 | `packages/react-native-codegen/src/parsers/typescript/parser.js` |
| 7 | 583 | `packages/react-native-codegen/src/parsers/flow/parser.js` |
| 8 | 578 | `packages/react-native-codegen/src/generators/modules/GenerateModuleJniCpp.js` |
| 9 | 555 | `packages/react-native-codegen/src/generators/modules/GenerateModuleObjCpp/serializeMethod.js` |
| 10 | 536 | `packages/react-native-codegen/src/parsers/typescript/components/componentsUtils.js` |
| 11 | 512 | `packages/react-native-codegen/src/parsers/parserMock.js` |
| 12 | 504 | `packages/react-native-codegen/src/parsers/flow/components/componentsUtils.js` |
| 13 | 503 | `packages/react-native-codegen/src/generators/components/GenerateViewConfigJs.js` |
| 14 | 487 | `packages/react-native-codegen/src/parsers/errors.js` |
| 15 | 475 | `packages/react-native-codegen/src/CodegenSchema.js` |
| 16 | 465 | `packages/react-native-codegen/src/generators/components/GenerateEventEmitterCpp.js` |
| 17 | 463 | `packages/react-native-codegen/src/parsers/typescript/modules/index.js` |
| 18 | 463 | `packages/react-native-codegen/src/CodegenSchema.d.ts` |
| 19 | 456 | `packages/react-native-codegen/src/parsers/error-utils.js` |
| 20 | 436 | `packages/react-native-codegen/src/parsers/parser.js` |
| 21 | 428 | `packages/react-native-codegen/src/generators/components/GenerateComponentHObjCpp.js` |
| 22 | 392 | `packages/react-native-codegen/src/generators/components/GenerateEventEmitterH.js` |
| 23 | 385 | `packages/react-native-codegen/src/generators/components/GeneratePropsCpp.js` |
| 24 | 360 | `packages/react-native-codegen/src/generators/components/GeneratePropsJavaDelegate.js` |
| 25 | 351 | `packages/react-native-codegen/src/generators/RNCodegen.js` |
| 26 | 348 | `packages/react-native-codegen/src/generators/components/CppHelpers.js` |
| 27 | 328 | `packages/react-native-codegen/src/parsers/flow/modules/index.js` |
| 28 | 319 | `packages/react-native-codegen/src/generators/components/GeneratePropsJavaPojo/serializePojo.js` |
| 29 | 297 | `packages/react-native-codegen/src/generators/components/GeneratePropsJavaInterface.js` |
| 30 | 295 | `packages/react-native-codegen/src/parsers/typescript/components/events.js` |

（31 行 = `packages/react-native-codegen/src/parsers/flow/components/events.js` 291 行）

### 1.4 `Libraries/TurboModule` 逐文件

- `packages/react-native/Libraries/TurboModule/RCTExport.js` — 38 行。定义 `DEPRECATED_RCTExport<T extends void = void>`（:32）与 `TurboModule`（:36）。
- `packages/react-native/Libraries/TurboModule/TurboModuleRegistry.js` — 47 行。`requireModule`(:19)、`get`(:35)、`getEnforcing`(:39)。

### 1.5 `specs_DEPRECATED/modules` 逐文件行数（前 10 + 合计）

命令：`wc -l packages/react-native/src/private/specs_DEPRECATED/modules/*.js | sort -rn`

```
219 NativeUIManager.js
108 NativePushNotificationManagerIOS.js
102 NativeAnimatedModule.js
 99 NativeAnimatedTurboModule.js
 91 NativeExceptionsManager.js
 84 NativeStatusBarManagerIOS.js
 80 NativePermissionsAndroid.js
 71 NativeAccessibilityManager.js
 65 NativeBlobModule.js
 57 NativeActionSheetManager.js
2213 total
```

全部 49 个 spec 均 `extends TurboModule`（`grep -c "extends TurboModule" … | grep -v ":0" | wc -l` = 49），均 `TurboModuleRegistry`（=49）；**无** `codegenNativeComponent`、**无** `codegenNativeCommands`、**无** `EventEmitter<`、**无** `Cxx` 后缀；**2** 个使用 `RootTag`（`NativeImageLoaderIOS.js`、`NativeUIManager.js`）。

---

## 2. THE SPEC → CODEGEN CHAIN

### 2.1 完整文件流（iOS）

```
Native*.js (spec, e.g. packages/react-native/src/private/specs_DEPRECATED/modules/NativeUIManager.js)
  └─ packages/react-native/scripts/generate-codegen-artifacts.js:13  → execute()
      └─ packages/react-native/scripts/codegen/generate-artifacts-executor/index.js:63 execute()
          ├─ :100 computeBaseOutputPath()          → baseOutputPath
          ├─ :106 readReactNativeConfig()          → react-native.config.js / .cjs
          ├─ :110 findCodegenEnabledLibraries()    → packages/.../utils.js:161
          ├─ :142 generateSchemaInfos(libraries, platform)  → .../generateSchemaInfos.js:19
          │    └─ :46 CodegenUtils.getCombineJSToSchema().combineSchemasInFileList(...)
          │         └─ packages/react-native/scripts/codegen/codegen-utils.js:38
          │             └─ packages/react-native-codegen/src/cli/combine/combine-js-to-schema.js:79
          │                 ├─ :85 expandDirectoriesIntoFiles()  (:59, globSync '**/*{,.fb}.{js,ts,tsx}')
          │                 ├─ :76 filterJSFile()  → combine-utils.js:24
          │                 └─ :24 combineSchemas()  (:90) — regex 门 + 选 parser
          │                     ├─ FlowParser       → src/parsers/flow/parser.js:67  (:130 parseString)
          │                     │   └─ src/parsers/parsers-commons.js:637 buildSchema()
          │                     │       ├─ :666 parser.getAst()  → src/parsers/flow/parseFlowAndThrowErrors.js:17
          │                     │       ├─ :667 getConfigType() → src/parsers/utils.js:137
          │                     │       └─ :572 buildSchemaFromConfigType() → :763 buildModuleSchema()
          │                     │           └─ :698 parseModuleName()  → src/parsers/error-utils.js:* 校验
          │                     └─ TypeScriptParser  → src/parsers/typescript/parser.js (:132 parseString)
          │                         └─ 同一 buildSchema/buildModuleSchema（src/parsers/typescript/modules/index.js）
          ├─ :143 generateNativeCode()  → .../generateNativeCode.js:20
          │    └─ :38 generateCode()
          │        ├─ :54 mkdtempSync(out)  ← 临时目录
          │        ├─ :60 generateSpecsCLIExecutor.generateSpecFromInMemorySchema()
          │        │    └─ packages/react-native/scripts/codegen/generate-specs-cli-executor.js:71
          │        │        ├─ :80 validateLibraryType()   (:65)
          │        │        ├─ :84 utils.getCodegen().generate()  → codegen-utils.js:23
          │        │        │    └─ packages/react-native-codegen/src/generators/RNCodegen.js:244 generate()
          │        │        │        ├─ :257 schemaValidator.validate()  → src/SchemaValidator.js:56
          │        │        │        ├─ :289-306 遍历 generators → LIBRARY_GENERATORS (:125)
          │        │        │        └─ :307 checkOrWriteFiles() (:231) → writeMapToFiles() (:196)
          │        │        └─ 各 generator（见 2.3）
          │        └─ :75 cpSyncRecursiveIfChanged(tmpOutputDir, outputDir)
          ├─ :156 generateRCTThirdPartyComponents()  → .../generateRCTThirdPartyComponents.js:33
          ├─ :157 generateRCTModuleProviders()       → .../generateRCTModuleProviders.js:32
          ├─ :163 generateCustomURLHandlers()        → .../generateCustomURLHandlers.js
          ├─ :164 generateUnstableModulesRequiringMainQueueSetupProvider()
          ├─ :168 generateAppDependencyProvider()    → .../generateAppDependencyProvider.js:32
          ├─ :171 generateReactCodegenPodspec()      → .../generateReactCodegenPodspec.js
          └─ :177 generatePackageSwift()             → .../generatePackageSwift.js
```

### 2.2 完整文件流（Android 库侧，走 Gradle）

```
packages/gradle-plugin/react-native-gradle-plugin/src/main/kotlin/com/facebook/react/tasks/GenerateCodegenArtifactsTask.kt:69 setupCommandLine()
  → node react-native/scripts/generate-specs-cli.js --platform android --schemaPath … --outputDir … --libraryName … --javaPackageName …
      → packages/react-native/scripts/generate-specs-cli.js:52 executor.execute(...)
          → packages/react-native/scripts/codegen/generate-specs-cli-executor.js:115 generateSpec() → :71 generateSpecFromInMemorySchema()
              → 与 2.1 同一条链（同一 generateSpecFromInMemorySchema）
              → :99-112 Android 专属：把 .h/.cpp 移到 `${outputDirectory}/jni/react/renderer/components/${libraryName}`
```

### 2.3 iOS CocoaPods 脚本期（“无 codegen discovery”分支）

`packages/react-native/scripts/react_native_pods_utils/script_phases.sh`
- :80 `"$NODE_BINARY" "$CODEGEN_CLI_PATH/lib/cli/combine/combine-js-to-schema-cli.js" "$GENERATED_SCHEMA_FILE" $JS_SRCS` → `src/cli/combine/combine-js-to-schema-cli.js`
- :62 `runSpecCodegen` → `scripts/generate-specs-cli.js`
- :86-93 `generateCodegenArtifactsFromSchema`：`all` → 先 `modules` 再 `components`；`components`/`modules` → 一次。
- :128-132 分流：`withCodegenDiscovery` → :113（走 `generateArtifacts`，即 2.1 的全量路径）；否则 → :119 `noCodegenDiscovery`。

Android 的 schema 由 Gradle 插件自己产出（`GenerateCodegenArtifactsTask.kt:44 generatedSchemaFile`），不经 `combine-js-to-schema-cli.js`。

### 2.4 解析器文件与各自支持的语法

| 解析器文件 | 语言 | 关键判定点 |
|---|---|---|
| `packages/react-native-codegen/src/parsers/flow/parser.js:67` `class FlowParser` | Flow（`flow-parser` 0.331.0） | `isModuleInterface` :255-262（`InterfaceDeclaration` + `extends[0].id.name === 'TurboModule'`）；`checkIfInvalidModule` :103-110（type 参数必须是 `Spec`）；`getAst` :149 → `parseFlowAndThrowErrors.js:23`（`babel:false`, `flow:'all'`, `reactRuntimeTarget:'19'`） |
| `packages/react-native-codegen/src/parsers/typescript/parser.js` `class TypeScriptParser` | TypeScript（`@babel/parser` `plugins:['typescript']`，:152-155） | `isModuleInterface` :281-288（`TSInterfaceDeclaration` + `extends[0].expression.name === 'TurboModule'`）；`checkIfInvalidModule` :101-108 |
| `packages/react-native-codegen/src/parsers/parser.js:83` `interface Parser` | 抽象接口（52 个方法/属性） | 语言差异全部收敛到此处；`flow/parser.js` 与 `typescript/parser.js` 各实现一次 |
| `packages/react-native-codegen/src/parsers/parserMock.js` | **Mock**，仅测试用 | 见 §8 |

语言选择在 `packages/react-native-codegen/src/cli/combine/combine-js-to-schema.js:37-40`：
```js
        const isTypeScript =
          path.extname(filename) === '.ts' || path.extname(filename) === '.tsx';

        const parser = isTypeScript ? typescriptParser : flowParser;
```
同样的判据在 `src/cli/parser/parser.js:22-25` 与 `src/cli/parser/parser-cli.js`（无调用者，见 §8）。

解析器子模块：
- Flow：`src/parsers/flow/modules/index.js:327 flowTranslateTypeAnnotation`；`src/parsers/flow/components/{index,commands,componentsUtils,events}.js`
- TS：`src/parsers/typescript/modules/index.js`（463 行）；`src/parsers/typescript/components/{index,commands,componentsUtils,events,extends}.js`；`src/parsers/typescript/parseTopLevelType.js`（`WithDefault<>`、`Readonly<>`）
- 共用：`src/parsers/parsers-commons.js`（1424 行）、`src/parsers/parsers-primitives.js`（815 行）、`src/parsers/errors.js`（487 行）、`src/parsers/error-utils.js`（456 行）、`src/parsers/utils.js`（221 行）、`src/parsers/parsers-utils.js`（19 行）
- Schema 类型：`src/CodegenSchema.js`（475 行）/ `src/CodegenSchema.d.ts`（463 行）

### 2.5 每个 generator 与其精确输出文件

模块（TurboModule）相关：

| generator 文件 | 输出文件名 | 定义位置 |
|---|---|---|
| `src/generators/modules/GenerateModuleH.js` | `${libraryName}JSI.h` | :767 `const fileName = \`${libraryName}JSI.h\`;` |
| `src/generators/modules/GenerateModuleObjCpp/index.js` | `${libraryName}.h` **和** `${libraryName}-generated.mm` | :228 `const headerFileName = \`${libraryName}.h\`;`；:236 `const sourceFileName = \`${libraryName}-generated.mm\`;`；:242-245 返回 Map |
| `src/generators/modules/GenerateModuleJniH.js` | `jni/${libraryName}.h` **和** `jni/CMakeLists.txt` | :124 `const fileName = \`${libraryName}.h\`;`；:132-135 `[ \`jni/${fileName}\`, 'jni/CMakeLists.txt' ]` |
| `src/generators/modules/GenerateModuleJniCpp.js` | `jni/${libraryName}-generated.cpp` | :569 `const fileName = \`${libraryName}-generated.cpp\`;`；:576 `jni/${fileName}` |
| `src/generators/modules/GenerateModuleJavaSpec.js` | `java/${packageName with /}/${hasteModuleName}Spec.java` | :569-571（包名默认 `'com.facebook.fbreact.specs'`）；:580 `const className = \`${hasteModuleName}Spec\`;`；:661-662 |

组件（Fabric）相关：

| generator 文件 | 输出文件名 | 定义位置 |
|---|---|---|
| `components/GenerateComponentDescriptorCpp.js` | `ComponentDescriptors.cpp` | :66 |
| `components/GenerateComponentDescriptorH.js` | `ComponentDescriptors.h` | :68 |
| `components/GenerateComponentHObjCpp.js` | `RCTComponentViewHelpers.h` | :386 |
| `components/GenerateEventEmitterCpp.js` | `EventEmitters.cpp` | :456 |
| `components/GenerateEventEmitterH.js` | `EventEmitters.h` | :384 |
| `components/GeneratePropsCpp.js` | `Props.cpp` | :314 |
| `components/GeneratePropsH.js` | `Props.h` | :853 |
| `components/GenerateStateCpp.js` | `States.cpp` | :55 |
| `components/GenerateStateH.js` | `States.h` | :62 |
| `components/GenerateShadowNodeCpp.js` | `ShadowNodes.cpp` | :59 |
| `components/GenerateShadowNodeH.js` | `ShadowNodes.h` | :79 |
| `components/GenerateTests.js` | `Tests.cpp` | :178 |
| `components/GeneratePropsJavaInterface.js` | `java/com/facebook/react/viewmanagers/${RCT-stripped}ManagerInterface.java` | :21 `getInterfaceJavaClassName`；:244-245 固定包名；:291 |
| `components/GeneratePropsJavaDelegate.js` | `java/com/facebook/react/viewmanagers/${RCT-stripped}ManagerDelegate.java` | :25 `getDelegateJavaClassName`；:308-309 固定包名；:354 |
| `components/GeneratePropsJavaPojo/index.js` | 同 `viewmanagers` 包（Pojo 类） | 复用 `serializePojo.js`（319 行） |
| `components/GenerateThirdPartyFabricComponentsProviderObjCpp.js` | `RCTThirdPartyFabricComponentsProvider.mm` | :71 |
| `components/GenerateThirdPartyFabricComponentsProviderH.js` | `RCTThirdPartyFabricComponentsProvider.h` | :74 |
| `components/GenerateViewConfigJs.js` | `${libraryName}NativeViewConfig.js` | :412 |

**TypeScript / Flow 类型输出**：codegen **不生成** `.d.ts` 或 Flow 类型文件。`yarn build-types` 的 TS 类型来自 `packages/react-native` 自身（见 `AGENTS.md`），与 `@react-native/codegen` 无关。未确认 codegen 是否在别处产出类型文件（在本次覆盖的目录内未发现）。

分组注册表：`src/generators/RNCodegen.js:125-181`（`LIBRARY_GENERATORS`）、`:183-188`（`SCHEMAS_GENERATORS`）、`:41-66`（`ALL_GENERATORS`）。

平台 → generator 列表：`packages/react-native/scripts/codegen/generate-specs-cli-executor.js:17-30`
```js
const GENERATORS /*: {[string]: {[string]: ReadonlyArray<string>}} */ = {
  all: {
    android: ['componentsAndroid', 'modulesAndroid', 'modulesCxx'],
    ios: ['componentsIOS', 'modulesIOS', 'modulesCxx'],
  },
  components: {
    android: ['componentsAndroid'],
    ios: ['componentsIOS'],
  },
  modules: {
    android: ['modulesAndroid', 'modulesCxx'],
    ios: ['modulesIOS', 'modulesCxx'],
  },
};
```

### 2.6 “找不到 spec”时的默认行为

| 层 | 行为 | path:line |
|---|---|---|
| 文件名筛选 | 文件名不匹配 `/^(Native.+|.+NativeComponent)/` 直接跳过；`NativeUIManager.js` 被硬排除；含 `__tests` 被排除；`.d.ts` 被排除 | `src/cli/combine/combine-utils.js:33,34,35,37` |
| 平台后缀 | `filenameComponents.length === 2` 视为平台无关；否则 `filenameComponents[1]` 必须是当前 platform | `src/cli/combine/combine-utils.js:46-63` |
| 内容筛选（模块） | 正则 `/export\s+default\s+\(?codegenNativeComponent</` 或 `/extends TurboModule/` 才解析 | `src/cli/combine/combine-js-to-schema.js:34-35` |
| 内容筛选（buildSchema） | `!contents.includes('codegenNativeComponent') && !contents.includes('TurboModule')` → 早退 `{modules: {}}` | `src/parsers/parsers-commons.js:658-664` |
| configType | 无 module 无 component → `'none'` → `return {modules: {}};` | `src/parsers/utils.js:162-164`；`src/parsers/parsers-commons.js:632-633` |
| 合并后为空 | **只打印 `console.error`，不抛错，仍返回空 schema** | `src/cli/combine/combine-js-to-schema.js:91-95` |
| 没有 codegen-enabled 库 | 只打印日志 `'No codegen-enabled libraries found.'`，`process.exitCode` 不变 | `packages/react-native/scripts/codegen/generate-artifacts-executor/index.js:117-119` |
| 库无 `codegenConfig` | 只打印日志并返回 `[]` | `.../utils.js:197-203` |
| iOS 脚本期 libraryType 非法 | `script_phases.sh:86-93` 的 if/elif **无 else**：不生成、不报错 | `packages/react-native/scripts/react_native_pods_utils/script_phases.sh:86-93` |
| `outputDirectory` 为空时的兜底 | 回退到 `path.resolve(__dirname, '..', 'Libraries', libraryName)` | `packages/react-native/scripts/codegen/generate-specs-cli-executor.js:36-39` |

---

## 3. GENERATED CODE SHAPE

仓库内**没有**签入的生成产物（`find . -path "*/node_modules" -prune -o -name "FBReactNativeSpec.h" -print` = 空；`find . -type d -name "__generated__" -not -path "*/node_modules/*"` 只命中 `private/react-native-codegen-typescript-test/__generated__`）。因此以下全部引自**已签入的 Jest snapshot**（`packages/react-native-codegen/src/generators/modules/__tests__/__snapshots__/*.snap`），snapshot 是 `react-native-codegen` 生成的真实字节。

### 3.1 iOS TurboModule 协议头（生成物逐字）

模板：`packages/react-native-codegen/src/generators/modules/GenerateModuleObjCpp/index.js:36-59`
```js
}) => `${structDeclarations}
@protocol ${hasteModuleName}Spec <RCTBridgeModule, RCTTurboModule>

${protocolMethods}

@end

@interface ${hasteModuleName}SpecBase : NSObject {
@protected
facebook::react::EventEmitterCallback _eventEmitterCallback;
}
- (void)setEventEmitterCallback:(EventEmitterCallbackWrapper *)eventEmitterCallbackWrapper;

${eventEmitters}
@end

namespace facebook::react {
  /**
   * ObjC++ class for module '${hasteModuleName}'
   */
  class JSI_EXPORT ${hasteModuleName}SpecJSI : public ObjCTurboModule {
  public:
    ${hasteModuleName}SpecJSI(const ObjCTurboModule::InitParams &params);
  };
} // namespace facebook::react`;
```

签入快照（`GenerateModuleHObjCpp-test.js.snap:1161-1182`，fixture `simple_native_modules`，注意 snapshot 里 `\\"` 是转义，实际输出为 `"`）：
```
- (void)voidFunc;
- (NSNumber *)getBool:(BOOL)arg;
- (NSNumber *)getNumber:(double)arg;
- (NSString *)getString:(NSString *)arg;
- (NSArray<NSDictionary *> *)getArray:(NSArray *)arg;
- (NSDictionary *)getObject:(NSDictionary *)arg;
- (NSNumber *)getRootTag:(double)arg;
- (NSDictionary *)getValue:(double)x
                         y:(NSString *)y
                         z:(NSDictionary *)z;
- (NSNumber *)getEnumReturn;
- (void)getValueWithCallback:(RCTResponseSenderBlock)callback;
- (void)getValueWithPromise:(BOOL)error
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject;
- (void)getValueWithOptionalArg:(NSDictionary *)parameter
                        resolve:(RCTPromiseResolveBlock)resolve
                         reject:(RCTPromiseRejectBlock)reject;
- (NSString *)getEnums:(double)enumInt
            enumString:(NSString *)enumString;
- (facebook::react::ModuleConstants<JS::NativeSampleTurboModule::Constants>)constantsToExport;
- (facebook::react::ModuleConstants<JS::NativeSampleTurboModule::Constants>)getConstants;
```

结构体 + `RCTCxxConvert` 类别（`GenerateModuleHObjCpp-test.js.snap:214-231`）：
```
namespace JS {
  namespace NativeSampleTurboModule {
    struct SpecDifficultAE {
      bool D() const;
      double E() const;
      NSString *F() const;
      double id_() const;

      SpecDifficultAE(NSDictionary *const v) : _v(v) {}
    private:
      NSDictionary *_v;
    };
  }
}

@interface RCTCxxConvert (NativeSampleTurboModule_SpecDifficultAE)
+ (RCTManagedPointer *)JS_NativeSampleTurboModule_SpecDifficultAE:(id)json;
@end
```

### 3.2 Android 抽象类（生成物逐字）

模板：`packages/react-native-codegen/src/generators/modules/GenerateModuleJavaSpec.js:61-79`
```js
  return `
/**
 * This code was generated by [react-native-codegen](https://www.npmjs.com/package/react-native-codegen).
 *
 * Do not edit this file as changes may cause incorrect behavior and will be lost
 * once the code is regenerated.
 *
 * ${'@'}generated by codegen project: GenerateModuleJavaSpec.js
 *
 * ${'@'}nolint
 */

package ${packageName};

${imports}

public abstract class ${className} extends ReactContextBaseJavaModule implements TurboModule {
  public static final String NAME = "${jsName}";

  public ${className}(ReactApplicationContext reactContext) {
    super(reactContext);
  }

  @Override
  public @Nonnull String getName() {
    return NAME;
  }

${eventEmitters}${eventEmitters.length > 0 ? '\n\n' : ''}${methods}
}
`;
```

快照（`GenerateModuleJavaSpec-test.js.snap:69-92`，fixture `array_buffer_native_module`）：
```
public abstract class NativeSampleTurboModuleSpec extends ReactContextBaseJavaModule implements TurboModule {
  public static final String NAME = \\"SampleTurboModule\\";

  public NativeSampleTurboModuleSpec(ReactApplicationContext reactContext) {
    super(reactContext);
  }

  @Override
  public @Nonnull String getName() {
    return NAME;
  }

  @ReactMethod(isBlockingSynchronousMethod = true)
  @DoNotStrip
  public abstract ArrayBuffer getArrayBuffer();

  @ReactMethod
  @DoNotStrip
  public abstract void voidArrayBuffer(ArrayBuffer arg);

  @ReactMethod
  @DoNotStrip
  public abstract void voidNullableArrayBuffer(@Nullable ArrayBuffer arg);
}
```

`getConstants` 在 Java 侧被替换为 **两个成员**（`GenerateModuleJavaSpec.js:530-552`），快照 `GenerateModuleJavaSpec-test.js.snap:525-530`：
```
  protected abstract Map<String, Object> getTypedExportedConstants();

  @Override
  @DoNotStrip
  public final @Nullable Map<String, Object> getConstants() {
    Map<String, Object> constants = getTypedExportedConstants();
    if (ReactBuildConfig.DEBUG || ReactBuildConfig.IS_INTERNAL_BUILD) {
```

### 3.3 CxxModule JSI glue（生成物逐字）

模板：`packages/react-native-codegen/src/generators/modules/GenerateModuleH.js:177-196`
```js
  return `${enums}${structs}
template <typename T>
class JSI_EXPORT ${hasteModuleName}CxxSpec : public TurboModule {
public:
  static constexpr std::string_view kModuleName = "${moduleName}";

protected:
  ${hasteModuleName}CxxSpec(std::shared_ptr<CallInvoker> jsInvoker) : TurboModule(std::string{${hasteModuleName}CxxSpec::kModuleName}, jsInvoker) {
${methods
  .map(({methodName, paramCount}) => {
    return `    methodMap_["${methodName}"] = MethodMetadata {.argCount = ${paramCount}, .invoker = __${methodName}};`;
  })
  .join(
    '\n',
  )}${moduleEventEmitters.length > 0 ? '\n' : ''}${moduleEventEmitters.map(e => e.registerEventEmitter).join('\n')}
  }
  ${moduleEventEmitters.map(e => e.emitFunction).join('\n')}
private:
${moduleFunctions.join('\n\n')}
};`;
```

快照（`GenerateModuleH-test.js.snap:60-95`）：
```
template <typename T>
class JSI_EXPORT NativeSampleTurboModuleCxxSpec : public TurboModule {
public:
  static constexpr std::string_view kModuleName = \\"SampleTurboModule\\";

protected:
  NativeSampleTurboModuleCxxSpec(std::shared_ptr<CallInvoker> jsInvoker) : TurboModule(std::string{NativeSampleTurboModuleCxxSpec::kModuleName}, jsInvoker) {
    methodMap_[\\"getArrayBuffer\\"] = MethodMetadata {.argCount = 0, .invoker = __getArrayBuffer};
    methodMap_[\\"voidArrayBuffer\\"] = MethodMetadata {.argCount = 1, .invoker = __voidArrayBuffer};
    methodMap_[\\"voidNullableArrayBuffer\\"] = MethodMetadata {.argCount = 1, .invoker = __voidNullableArrayBuffer};
  }
  
private:
  static jsi::Value __getArrayBuffer(jsi::Runtime &rt, TurboModule &turboModule, const jsi::Value* /*args*/, size_t /*count*/) {
    static_assert(
      bridging::getParameterCount(&T::getArrayBuffer) == 1,
      \\"Expected getArrayBuffer(...) to have 1 parameters\\");
    return bridging::callFromJs<jsi::ArrayBuffer>(rt, &T::getArrayBuffer,  static_cast<NativeSampleTurboModuleCxxSpec*>(&turboModule)->jsInvoker_, static_cast<T*>(&turboModule));
  }
```

### 3.4 Android JSI glue（生成物逐字）

模板：`GenerateModuleJniH.js:19-30`（类声明）与 `:56-57`（provider 声明）：
```
/**
 * JNI C++ class for module '${hasteModuleName}'
 */
class JSI_EXPORT ${hasteModuleName}SpecJSI : public JavaTurboModule {
public:
  ${hasteModuleName}SpecJSI(const JavaTurboModule::InitParams &params);
};
```
```
JSI_EXPORT
std::shared_ptr<TurboModule> ${libraryName}_ModuleProvider(const std::string &moduleName, const JavaTurboModule::InitParams &params);
```
快照（`GenerateModuleJniCpp-test.js.snap:132-135`, `:167-174`）：
```
static facebook::jsi::Value __hostFunction_NativeSampleTurboModuleSpecJSI_difficult(facebook::jsi::Runtime& rt, TurboModule &turboModule, const facebook::jsi::Value* args, size_t count) {
  static jmethodID cachedMethodId = nullptr;
  return static_cast<JavaTurboModule &>(turboModule).invokeJavaMethod(rt, ObjectKind, \\"difficult\\", \\"(Lcom/facebook/react/bridge/ReadableMap;)Lcom/facebook/react/bridge/WritableMap;\\", args, count, cachedMethodId);
}
```
```
  NativeSampleTurboModuleSpecJSI::NativeSampleTurboModuleSpecJSI(const JavaTurboModule::InitParams &params)
    : JavaTurboModule(params) {
  methodMap_[\\"difficult\\"] = MethodMetadata {1, __hostFunction_NativeSampleTurboModuleSpecJSI_difficult};
  methodMap_[\\"optionals\\"] = MethodMetadata {1, __hostFunction_NativeSampleTurboModuleSpecJSI_optionals};
  methodMap_[\\"optionalMethod\\"] = MethodMetadata {3, __hostFunction_NativeSampleTurboModuleSpecJSI_optionalMethod};
```

### 3.5 模块方法列表如何编码

**代码生成期 switch / if 链 + 字符串键 map**，不是编译期表。逐条：

| 目标 | 编码方式 | path:line |
|---|---|---|
| Cxx | `methodMap_["<name>"] = MethodMetadata {.argCount = N, .invoker = __<name>};` — 构造体内逐行 | `GenerateModuleH.js:185-188` |
| iOS ObjC++ | `.mm` 构造函数内 `methodMap_["<name>"] = MethodMetadata {N, __hostFunction_<Haste>SpecJSI_<name>};`，并为 struct 参数追加 `setMethodArgConversionSelector(@"<name>", <index>, @"JS_<Haste>_<Struct>:");` | `GenerateModuleObjCpp/source/serializeModule.js:131-147`（:142 与 :145） |
| iOS ObjC | 头文件里 `@protocol` 逐方法声明（编译期可见） | `GenerateModuleObjCpp/index.js:36-40`，方法由 `serializeMethod.js:33-41 ProtocolMethodTemplate` 产出 |
| Android Java | 抽象类里的 `@ReactMethod` 方法（编译期可见） | `GenerateModuleJavaSpec.js:108-136 MethodTemplate` |
| Android JNI | 构造函数 `methodMap_["<name>"] = MethodMetadata {N, __hostFunction_...};` | `GenerateModuleJniCpp.js:77-80` |
| 模块名 → 类 | **代码生成期 if 链**：`if (moduleName == "<moduleName>") { return std::make_shared<<Haste>SpecJSI>(params); }`，落空 `return nullptr;` | `GenerateModuleJniCpp.js:99-106 ModuleLookupTemplate`、`:138-141` |
| JS 侧模块名查找 | `TurboModuleRegistry.get/getEnforcing(name)` → `global.__turboModuleProxy(name)`，字符串键 | `packages/react-native/Libraries/TurboModule/TurboModuleRegistry.js:19-33` |
| EventEmitter | `eventEmitterMap_["<name>"] = std::make_shared<AsyncEventEmitter<...>>();`（iOS `<id>`、`GenerateModuleObjCpp/source/serializeModule.js:81`；Android `<folly::dynamic>`、`GenerateModuleJniCpp.js:86`；Cxx `jsi::Value` 或空、`GenerateModuleH.js:664-668`） | 同上 |
| 方法排序 | `spec.methods.sort()` / `spec.eventEmitters.sort()`（**默认字符串排序**，会丢失源码声明顺序）；`getSortedObject` 对 aliasMap/enumMap 排序 | `parsers-commons.js:913-914`、`:910-911`；`parsers/utils.js:202-211` |
| 模块顺序 | iOS `Object.keys(nativeModules).sort()`；Android JNI 模块查找按 `moduleName` 比较排序 | `GenerateModuleObjCpp/index.js:157`；`GenerateModuleJniCpp.js:554-563` |

---

## 4. CODEGEN CONFIG RESOLUTION

配置读取全部位于 `packages/react-native/scripts/codegen/`（**不在** `packages/react-native-codegen/src/` 内，但属于同一条链，故一并记录）。

### 4.1 全部被读取的键

| 键 | 读取位置 | 行为 |
|---|---|---|
| `codegenConfig`（对象本身） | `generate-artifacts-executor/utils.js:197`、`:205`、`:312`；`index.js:199-200`；`generateRCTModuleProviders.js:49` | 缺失 → 返回 `[]`；非对象 → `throw new Error('The "codegenConfig" field must be an Object.')`（`utils.js:205-207`） |
| `codegenConfig.libraries`（数组，**已废弃**） | `utils.js:316`、`:373` | 非空 → 打 deprecation 日志（`utils.js:331-367`，对 `react-native` 本身豁免 `:332-334`），逐项 `{name, config, libraryPath}` |
| `codegenConfig.name` | `utils.js:320`（单对象形式取 `configFile.name`，即 **package.json 的 name**，不是 `codegenConfig.name`）；`generateSchemaInfos.js:35`、`:38`；`generateNativeCode.js:53`；`generateRCTModuleProviders.js:58`；`generateRCTThirdPartyComponents.js:52`；`generate-specs-cli-executor.js:38` | 见 4.2 |
| `codegenConfig.type` | `generateNativeCode.js:66` → `generate-specs-cli-executor.js:80 validateLibraryType`（:65-69） | 必须是 `all` / `components` / `modules`，否则 `throw new Error(\`Invalid library type. ${libraryType}\`)` |
| `codegenConfig.jsSrcsDir` | `generateSchemaInfos.js:33`；`generateReactCodegenPodspec.js:47` | `path.join(libraryPath, config.jsSrcsDir)`（**未校验 undefined**） |
| `codegenConfig.includesGeneratedCode` | `utils.js:24`；`index.js:286`；`generateNativeCode.js:59` → `useLocalIncludePaths` | `true` 时不生成原生码（除 app 自身）、且 `headerPrefix = ''`（`RNCodegen.js:260-263`） |
| `codegenConfig.outputDir`（string 或 `{ios,android}`） | `index.js:203-213 readOutputDirFromPkgJson`、`:230-232` | 缺失 → 回退 `projectRoot`（`index.js:234`） |
| `codegenConfig.ios.modules` | `utils.js:423-435 parseiOSAnnotations` | `className` / `conformsToProtocols` / `unstableRequiresMainQueueSetup` |
| `codegenConfig.ios.components` | `utils.js:438-444` | `className` |
| `codegenConfig.ios.modulesProvider`（旧） | `generateRCTModuleProviders.js:72-81` | `{moduleName: className}` |
| `codegenConfig.ios.componentProvider`（旧） | `generateRCTThirdPartyComponents.js:66-67`、`:84-95` | `{componentName: className}` |
| `codegenConfig.ios.modulesConformingToProtocol`（旧） | `generateCustomURLHandlers.js:44` | 只识别 `RCTImageURLLoader`、`RCTImageDataDecoder`、`RCTURLRequestHandler`（`:50`/`:55`/`:60`） |
| `codegenConfig.ios.unstableModulesRequiringMainQueueSetup`（旧） | `generateUnstableModulesRequiringMainQueueSetup.js:40-48` | 字符串数组 |
| `codegenConfig.android.javaPackageName` | **JS 侧不读**；由 Kotlin 读：`packages/gradle-plugin/react-native-gradle-plugin/src/main/kotlin/com/facebook/react/tasks/GenerateCodegenArtifactsTask.kt:65` | JS 侧 `generateNativeCode.js:65` 硬编码 `'com.facebook.fbreact.specs'` |

### 4.2 “library name” 的来源

三处不同来源，容易不一致：

1. **单一对象形式**：`name: configFile.name` —— 即该库的 **npm package.json 的 `name`**。`utils.js:318-324`
   ```js
     return [
       {
         name: configFile.name,
         config,
         libraryPath: dependencyPath,
       },
     ];
   ```
2. **数组形式**：`name: config.name` —— 即 `codegenConfig.libraries[i].name`。`utils.js:373-379`
3. **`parseiOSAnnotations` / provider 生成**：`getLibraryName(library)` 重新读该库 package.json 的 `name`。`utils.js:472-476`；`generateRCTModuleProviders.js:68-70`；`generateRCTThirdPartyComponents.js:78-80`

随后 `libraryName` 决定文件名与符号名：
- `generateNativeCode.js:53-54`：`const libraryName = schemaInfo.library.config.name;`，`mkdtempSync(path.join(os.tmpdir(), libraryName))`
- 输出文件名：`GenerateModuleH.js:767`、`GenerateModuleObjCpp/index.js:228`/`:236`、`GenerateModuleJniH.js:124`、`GenerateModuleJniCpp.js:569`、`GenerateViewConfigJs.js:412`
- C++ 符号：`GenerateModuleJniH.js:127` / `GenerateModuleJniCpp.js:572` → `libraryName.replace(/-/g, '_')`
- CMake target：`GenerateModuleJniH.js:130-131`
  ```js
     // Use rncore as target name for backwards compat
     const targetName =
       libraryName === 'FBReactNativeSpec' ? 'rncore' : libraryName;
  ```
- `getDebugProps` 开关：`generate-specs-cli-executor.js:82-83` `libraryName.includes('FBReactNativeSpec')`；`generate-all.js:50` 同判据

### 4.3 硬编码模块名 / 类名派生（可能碰撞）

| 派生 | 规则 | path:line | 碰撞风险 |
|---|---|---|---|
| Java Spec 类名 | `${hasteModuleName}Spec`，`hasteModuleName = path.basename(filename).split('.')[0]` | `GenerateModuleJavaSpec.js:580`；`parsers/utils.js:28-32` | `NativeFoo.js` 与 `NativeFoo.ts` 同名 |
| ObjC 协议/类 | `${hasteModuleName}Spec` / `${hasteModuleName}SpecBase` / `${hasteModuleName}SpecJSI` | `GenerateModuleObjCpp/index.js:36,42,55` | 同上 |
| Cxx 类 | `${hasteModuleName}CxxSpec` | `GenerateModuleH.js:179` | 同上 |
| JNI 类 / host function | `${hasteModuleName}SpecJSI` / `__hostFunction_${hasteModuleName}SpecJSI_${propertyName}` | `GenerateModuleJniH.js:25`；`GenerateModuleJniCpp.js:56` | 同上 |
| C++ struct 名（alias） | `${hasteModuleName}${alias}` —— **alias 名未经 `toSafeCppString` 处理** | `GenerateModuleH.js:347` `const structName = \`${hasteModuleName}${alias}\`;` | 与 C++ enum 名 `${hasteModuleName}${PascalCase(enumName)}`（`GenerateModuleH.js:514` `getEnumName(hasteModuleName, origEnumName)`，定义于 `generators/Utils.js:52-55`）**同命名空间**；同名 alias + enum → 同名 C++ 类型 |
| iOS struct 名 | `JS::${hasteModuleName}::${structName}` | `GenerateModuleObjCpp/Utils.js:22-27` | 同 namespace 内重名即重定义 |
| struct 名（无 alias 时） | `Spec${capitalize(methodName)}${capitalize(param.name)}` | `GenerateModuleObjCpp/serializeMethod.js:180-187` | `fooBar(x)` 与 `foo(barX)` → 同名 |
| 常量 struct 名 | 字面量 `'Constants'` | `GenerateModuleObjCpp/serializeMethod.js:519` | 与 spec 中名为 `Constants` 的 alias 冲突（`StructCollector.js:192-196` 会抛错，但仅在 context 不同时） |
| 组件 Java 类 | `${componentName.replace(/^RCT/, '')}ManagerInterface` / `ManagerDelegate` | `components/JavaHelpers.js:20-26` | `RCTFoo` 与 `Foo` → 同类名 |
| 组件 Java 包名 | 硬编码 `'com.facebook.react.viewmanagers'`，**完全忽略 `codegenConfig.android.javaPackageName`** | `GeneratePropsJavaInterface.js:244-245`；`GeneratePropsJavaDelegate.js:308-309`（各带注释 `// TODO: This doesn't support custom package name yet.` 在 :243 / :307） | 多库同时生成组件会写入同一包 |
| **方法名本身未做任何清洗** | 直接拼进 C++/Java/ObjC 标识符 | `GenerateModuleH.js:187`/`:622`；`GenerateModuleJniCpp.js:56,79`；`GenerateModuleObjCpp/source/serializeModule.js:127,142,145`；`GenerateModuleJavaSpec.js:133,655` | 含 `-` 的方法名产出非法 C++/Java/ObjC（对比：enum 成员与 prop 名走了 `toSafeCppString`，`generators/Utils.js:48-50`） |
| 头文件 include guard | `${headerFileName.replace(/\.h$/, '')}_H` | `GenerateModuleObjCpp/index.js:72,93-94` | libraryName 含 `-` 时 guard 名非法 |
| iOS 头文件路径 | `path.join(outputDirectory, intermediate, libraryName)` | `RNCodegen.js:264-266` | — |

---

## 5. ERROR HANDLING & FAILURE MODES

### 5.1 全部 throw / process.exit（codegen `src/`，非测试）

实测命令：`grep -rn "throw new Error(\|throw new TypeError(\|process\.exit(" --include="*.js" ./parsers ./generators ./cli ./SchemaValidator.js ./CodegenSchema.js | grep -v "__tests__\|__test_fixtures__" | grep -v "parsers/parserMock.js"` —— 共 **231** 处（含 `throw new Error`/`TypeError`/`process.exit`）。

分布（每文件计数，命令 `… | awk -F: '{print $1}' | sort | uniq -c | sort -rn`）：

```
18 ./parsers/flow/components/componentsUtils.js
15 ./generators/modules/GenerateModuleJavaSpec.js
14 ./parsers/typescript/components/componentsUtils.js
12 ./parsers/parsers-commons.js
12 ./generators/modules/GenerateModuleObjCpp/serializeMethod.js
12 ./generators/modules/GenerateModuleJniCpp.js
 9 ./parsers/error-utils.js
 9 ./generators/components/CppHelpers.js
 8 ./generators/modules/GenerateModuleH.js
 8 ./generators/components/GenerateComponentHObjCpp.js
 7 ./parsers/flow/components/commands.js
 7 ./generators/components/GenerateViewConfigJs.js
 7 ./generators/components/GeneratePropsH.js
 6 ./parsers/typescript/parseTopLevelType.js
 6 ./parsers/typescript/components/commands.js
 6 ./generators/components/GeneratePropsJavaInterface.js
 6 ./generators/components/GeneratePropsJavaDelegate.js
 6 ./generators/components/GenerateEventEmitterH.js
 6 ./generators/components/GenerateEventEmitterCpp.js
 5 ./parsers/typescript/parser.js
 5 ./parsers/flow/parser.js
 5 ./generators/modules/GenerateModuleObjCpp/StructCollector.js
 4 ./generators/components/GeneratePropsJavaPojo/serializePojo.js
 4 ./generators/components/GeneratePropsCpp.js
 3 ./parsers/parserMock.js
 3 ./parsers/flow/components/events.js
 3 ./generators/modules/GenerateModuleObjCpp/serializeEventEmitter.js
 3 ./generators/modules/GenerateModuleObjCpp/header/serializeStructUtils.js
 3 ./generators/modules/GenerateModuleObjCpp/header/serializeRegularStruct.js
 3 ./generators/modules/GenerateModuleObjCpp/header/serializeConstantsStruct.js
 3 ./cli/generators/generate-all.js
 2 ./parsers/typescript/components/events.js
 2 ./generators/modules/Utils.js
 2 ./generators/components/JavaHelpers.js
 2 ./cli/combine/combine-schemas-cli.js
 1 ./SchemaValidator.js
 1 ./parsers/utils.js
 1 ./generators/Utils.js
 1 ./generators/RNCodegen.js
 1 ./generators/components/ComponentsGeneratorUtils.js
```

TurboModule 路径上的关键 throw（完整逐条）：

| path:line | 条件 | 消息 |
|---|---|---|
| `generators/RNCodegen.js:346` | `generateViewConfig` 取到的不是 string | `` `Failed to generate view config for ${libraryName}` `` |
| `generators/Utils.js:103` | 联合类型成员都是支持类型但不同质 | `Non-homogenous union member types`（`HeterogeneousUnionError`，`Utils.js:69-73`） |
| `generators/Utils.js:105` | 联合类型有未知成员 | `` `Unsupported union member types: ${invalidTypes.join(', ')}"` `` |
| `generators/modules/Utils.js:33` | `invariant(alias != null, …)` | `` `Unable to resolve type alias '${aliasName}'.` `` |
| `generators/modules/Utils.js:111` | `Promise<ArrayBuffer>` | `Unsupported return type for method "${methodName}": Promise<ArrayBuffer> is not supported for Android (Java/Kotlin) or iOS (ObjC) TurboModules. Use a C++ (Cxx) TurboModule, return the ArrayBuffer from a synchronous method, or resolve the Promise with a different type. ArrayBuffer is still supported as a method argument and as a synchronous return value on all platforms.` |
| `generators/modules/Utils.js:131` | EventEmitter payload 是 ArrayBuffer | `Unsupported eventType for ${eventEmitterName}. Found: ${typeAnnotation.type}. ArrayBuffer is not supported as an EventEmitter payload on any platform. Pass the ArrayBuffer through a method instead.` |
| `generators/modules/GenerateModuleH.js:92` | 未知 prop 类型 | `` `Unknown prop type for "${arg.name}, found: ${realTypeAnnotation.name}"` ``（注意 `${arg.name},` 少一个右花括号——原样缺陷） |
| `generators/modules/GenerateModuleH.js:111` | 未知 enum 类型 | `` `Unknown enum type for "${arg.name}, found: ${realTypeAnnotation.type}"` `` |
| `generators/modules/GenerateModuleH.js:144`, `:301` | 非同质 union | `Unsupported union member type` |
| `generators/modules/GenerateModuleH.js:154` | 未知类型 | `` `Unknown prop type for "${arg.name}, found: ${realTypeAnnotation.type}"` `` |
| `generators/modules/GenerateModuleH.js:255`/`:284`/`:317` | `translatePrimitiveJSTypeToCpp` 默认分支 | `createErrorMessage(...)` |
| `generators/modules/GenerateModuleObjCpp/serializeMethod.js:264`/`:296`/`:304` | 参数类型不支持 | `` `Unsupported type for param "${paramName}" in ${methodName}. Found: …` `` |
| `generators/modules/GenerateModuleObjCpp/serializeMethod.js:344`/`:377`/`:404`/`:455`/`:478` | 返回类型不支持 | `` `Unsupported return type for ${methodName}. Found: …` `` |
| `generators/modules/GenerateModuleObjCpp/serializeMethod.js:396`/`:472` | union 不支持 | `Unsupported union member type` / `Unsupported union member types` |
| `generators/modules/GenerateModuleObjCpp/serializeMethod.js:492` | `getConstants` 有参数 | `` `${hasteModuleName}.getConstants() may only accept 0 arguments.` `` |
| `generators/modules/GenerateModuleObjCpp/serializeMethod.js:505` | `getConstants` 返回非对象 | `` `${hasteModuleName}.getConstants() may only return an object literal: {...} or a type alias of such. Got '…'.` `` |
| `generators/modules/GenerateModuleObjCpp/StructCollector.js:134` | struct 里有 Mixed | `Mixed types are unsupported in structs` |
| `generators/modules/GenerateModuleObjCpp/StructCollector.js:136` | struct 里有 ArrayBuffer | `ArrayBuffer is unsupported in TurboModule struct types.` |
| `generators/modules/GenerateModuleObjCpp/StructCollector.js:163` | 非同质 union | `Unsupported union member types` |
| `generators/modules/GenerateModuleObjCpp/StructCollector.js:193` | 同一 alias 跨 context 使用 | `` `Tried to use alias '${aliasName}' in a getConstants() return type and inside a regular struct.` `` |
| `generators/modules/GenerateModuleObjCpp/StructCollector.js:243` | 未知 struct context | `` `Detected an invalid struct context: ${structContext}` `` |
| `generators/modules/GenerateModuleJniCpp.js:166` | 未知 Reserved 类型名 | `` `Invalid ReservedFunctionValueTypeName name, got ${realTypeAnnotation.name}` `` |
| `generators/modules/GenerateModuleJniCpp.js:403` | 未知返回类型 | `` `Unknown prop type for method return type, found: ${realTypeAnnotation.type}"` `` |
| `generators/modules/GenerateModuleJavaSpec.js:188`/`:193` | EventEmitter payload 类型不支持 | `` `Unsupported eventType for ${eventEmitter.name}. Found: …` `` |
| `generators/modules/GenerateModuleJavaSpec.js:167`/`:269`/`:370`/`:454` | union 不支持 | `Unsupported union member type` |
| `generators/modules/GenerateModuleJavaSpec.js:226,253,289,323,354,386,412,439,470` | 未知 param/return 类型 | `createErrorMessage(...)` |
| `parsers/parsers-commons.js:597` | 解析 module 时无 filename | `Filepath expected while parasing a module`（`parasing` 拼写错误，原样） |
| `parsers/parsers-commons.js:984` | 命令 options 解析失败 | `Failed to parse command options, please check that they are defined correctly` |
| `parsers/parsers-commons.js:1009` | codegen options 解析失败 | `Failed to parse codegen options, please check that they are defined correctly` |
| `parsers/parsers-commons.js:1018` | 同时给 `paperComponentName` 与 `paperComponentNameDeprecated` | `Failed to parse codegen options, cannot use both paperComponentName and paperComponentNameDeprecated` |
| `parsers/parsers-commons.js:1046` | `codegenNativeCommands` 参数数 ≠ 1 | `codegenNativeCommands must be passed options including the supported commands` |
| `parsers/parsers-commons.js:1055` | `codegenNativeCommands<…>` 非 type alias | `codegenNativeCommands doesn't support inline definitions. Specify a file local type alias` |
| `parsers/parsers-commons.js:1099` | 无法处理 prop spread | `` `Unable to handle prop spread: ${name}` `` |
| `parsers/parsers-commons.js:1202` | 命令类型定义找不到 | `` `Failed to find type definition for "${commandTypeName}", please check that you have a valid codegen file` `` |
| `parsers/parsers-commons.js:1212` | 缺 `supportedCommands` | `codegenNativeCommands must be given an options object with supportedCommands array` |
| `parsers/parsers-commons.js:1223` | `supportedCommands` 与接口不符 | `` `codegenNativeCommands expected the same supportedCommands specified in the ${commandTypeName} interface: …` `` |
| `parsers/parsers-commons.js:1287` (`TypeError`) | 泛型指向非 type alias/enum | `parser.genericTypeAnnotationErrorMessage(...)`（Flow 措辞见 `flow/parser.js:556-558`） |
| `parsers/parsers-commons.js:1323` | prop 重名 | `` `A prop was already defined with the name ${propName}` `` |
| `parsers/utils.js:153` | 一个文件里同时有 TurboModule interface 与 `codegenNativeComponent` | `Found type extending "TurboModule" and exported "codegenNativeComponent" declaration in one file. Split them into separated files.` |
| `parsers/error-utils.js:358` | `Partial` 未标注类型参数 | `Partials only support annotating a type parameter.` |
| `parsers/error-utils.js:364` | `Partial` 类型参数 ≠ 1 | `Partials only support annotating exactly one parameter.` |
| `parsers/error-utils.js:372` | 一个文件多个 `codegenNativeCommands` | `codegenNativeCommands may only be called once in a file` |
| `parsers/error-utils.js:378` | 找不到组件配置 | `Could not find component config for native component` |
| `parsers/error-utils.js:384` | 一个文件多个组件 | `Only one component is supported per file` |
| `parsers/error-utils.js:393` | event 无名 | `typeAnnotation of event doesn't have a name` |
| `parsers/error-utils.js:402` | bubblingType 空 | `` `Unable to determine event bubbling type for "${eventName}"` `` |
| `parsers/error-utils.js:415` | event 参数为空 | `` `Unable to determine event arguments for "${eventName}"` `` |
| `parsers/error-utils.js:423` | 命令类型参数不是 interface | `` `The type argument for codegenNativeCommands must be an interface, received ${typeAlias.type}` `` |
| `parsers/flow/parser.js:187` | 未知 enum body | `` `Unknown enum type annotation type. Got: ${typeAnnotation.type}. Expected: EnumStringBody or EnumNumberBody.` `` |
| `parsers/flow/parser.js:201` | Flow enum 无成员 | `Enums should have at least one member and member values can not be mixed- they all must be either blank, number, or string values.` |
| `parsers/flow/parser.js:222` | Flow enum 成员混合 | `Enums can not be mixed- they all must be either blank, number, or string values.` |
| `parsers/flow/parser.js:489` | 无法处理 spread | `` `Unable to handle prop spread: ${name}` `` |
| `parsers/flow/parser.js:538` | 类型定义找不到 | `` `Failed to find type definition for "${typeName}", please check that you have a valid codegen flow file` `` |
| `parsers/typescript/parser.js:211` | TS enum 值类型非法 | `Enum values must be either blank, number, or string values.` |
| `parsers/typescript/parser.js:223` | TS enum 无成员 | `Enums should have at least one member.` |
| `parsers/typescript/parser.js:242` | TS enum 成员混合 | `Enum values can not be mixed. They all must be either blank, number, or string values.` |
| `parsers/typescript/parser.js:579`/`:597` | TS parser 其他错误 | 见文件 |
| `parsers/typescript/parseTopLevelType.js:94` | `WithDefault` 默认值非法 | `The default value in WithDefault must be string, number, boolean or null .` |
| `parsers/typescript/parseTopLevelType.js:135` | `WithDefault` 又被 union optional | `WithDefault<> is optional and does not need to be marked as optional. Please remove the union of undefined and/or null` |
| `parsers/typescript/parseTopLevelType.js:140` | `WithDefault` 参数数 ≠ 2 | `WithDefault requires two parameters: type and default value.` |
| `parsers/typescript/parseTopLevelType.js:145` | 多个 `WithDefault` | `Multiple WithDefault is not allowed nested or in a union type.` |
| `parsers/typescript/parseTopLevelType.js:184` | union 只有 null/undefined | `Union type could not be just null or undefined.` |
| `parsers/typescript/parseTopLevelType.js:231` | 交叉类型里出现 `WithDefault` | `WithDefault<> is now allowed in intersection types.` |
| `SchemaValidator.js:60` | schema 校验失败 | `Errors found validating schema:\n` + 错误列表 |
| `cli/combine/combine-schemas-cli.js:42` | 非法 platform | `` `Invalid platform ${platform}` `` |
| `cli/combine/combine-schemas-cli.js:46` | `--schema-query` 不以 `@` 开头 | `The argument provided to --schema-query must be a filename that starts with '@'.` |
| `cli/generators/generate-all.js:22` | 参数 < 3 | `Expected to receive path to schema, library name, output directory and module spec name. Received …` |
| `cli/generators/generate-all.js:38` | schema 不存在 | `` `Can't find schema at ${schemaPath}` ``（`readFileSync` 已在 :35 先抛 ENOENT，:37 死代码） |
| `cli/generators/generate-all.js:47` | schema JSON 解析失败 | `` `Can't parse schema to JSON. ${schemaPath}` `` |

**`process.exit` 在 `packages/react-native-codegen/src/` 内为 0 处**（实测 grep）。唯一设置退出码的是 `packages/react-native/scripts/codegen/generate-artifacts-executor/index.js:186-189`：
```js
  } catch (err) {
    codegenLog(err);
    process.exitCode = 1;
  }
```
注意该 `catch` 包住整个 `execute()`，任何错误都被降级为 `exitCode = 1` 并继续执行到 `:191 codegenLog('Done.', true)`。

### 5.2 静默产出为空（无错误、无输出）—— 高价值清单

1. **无 spec 被识别**：`combine-js-to-schema.js:91-95` 只 `console.error`，仍返回 `{modules:{}}`；下游所有 generator 正常跑完并写出 0 个文件。
   ```js
     if (Object.keys(combined.modules).length === 0) {
       console.error(
         'No modules to process in combine-js-to-schema-cli. If this is unexpected, please check if you set up your NativeComponent correctly. See combine-js-to-schema.js for how codegen finds modules.',
       );
     }
   ```
2. **`buildSchema` 早退**：`parsers-commons.js:658-664`，条件仅为 `contents.includes('TurboModule')`。一个用别名或 re-export 写法的 spec 会命中不到（未确认是否有实际 spec 命中）。
3. **`buildSchemaFromConfigType` default 分支**：`parsers-commons.js:632-633` `default: return {modules: {}};`
4. **数组元素类型解析失败 → 静默降级为 `Array<Any>`**：`parsers-primitives.js:543-550`
   ```js
     } catch (ex) {
       return wrapNullable(nullable, {
         type: 'ArrayTypeAnnotation',
         elementType: {
           type: 'AnyTypeAnnotation',
         },
       });
     }
   ```
   且元素翻译传入的是 `nullGuard`（`parsers-primitives.js:525`，定义于 `parsers-utils.js:13-15`，**直接 `return fn()`，不捕获**），注释说明这是有意为之（`parsers-primitives.js:505-509`、`:517-524` 的 TODO）。
5. **`Promise<T>` 元素解析失败 → 静默降级为 `Promise<Void>`**：`parsers-primitives.js:375-382`（`} catch { return wrapNullable(nullable, {type:'PromiseTypeAnnotation', elementType:{type:'VoidTypeAnnotation'}}) }`）
6. **`getConstants()` 返回空对象 → ObjC/Java/JNI 三处都不产出任何东西**：`GenerateModuleObjCpp/serializeMethod.js:511-516`
   ```js
     if (
       returnTypeAnnotation.type === 'ObjectTypeAnnotation' &&
       returnTypeAnnotation.properties.length === 0
     ) {
       return [];
     }
   ```
   快照实证：`GenerateModuleJavaSpec-test.js.snap:97` → `exports[\`GenerateModuleJavaSpec can generate fixture array_buffer_promise_native_module 1\`] = \`Map {}\`;`；`GenerateModuleHObjCpp-test.js.snap:172-174` 里 `@protocol` 与 `@end` 之间空白。
7. **`getConstants()` 无属性 → Java 不生成校验体**：`GenerateModuleJavaSpec.js:499-502`
   ```js
         if (requiredProps.length === 0 && optionalProps.length === 0) {
           // Nothing to validate during runtime.
           return '';
         }
   ```
8. **组件 `.mm` 爬取失败 → 组件不进 provider**：`generateRCTThirdPartyComponents.js:212`（正则 `/Class<RCTComponentViewProtocol> (.*)Cls\(/` 不匹配 → `return null`，:239）；类名找不到只 `console.warn`（:234-237）。
9. **iOS `supportedApplePlatforms` 平台门实际失效**：`GenerateThirdPartyFabricComponentsProviderObjCpp.js:75` 读 `supportedApplePlatforms?.[libraryName]`，但唯一调用方 `packages/react-native/scripts/generate-provider-cli.js:79-87` 只传 `{schemas, outputDirectory}`，**不传 `supportedApplePlatforms`** → `generateSupportedApplePlatformsMacro` 走 `if (!supportedPlatformsMap) return fileTemplate;`（`ComponentsProviderUtils.js:25-27`）。`generateFromSchemas` 亦接受该参数（`RNCodegen.js:310`）但被丢弃。
10. **`writeMapToFiles` 写盘失败只 log**：单个文件失败 → `console.error` 并 `success = false`，**返回 false 但调用方忽略**（`RNCodegen.js:206-213`；`generate-specs-cli-executor.js:84` 未检查返回值；`generateNativeCode.js:60` 亦未检查）。
11. **`checkFilesForChanges`（`test: true`）无 existsSync**：文件不存在 → `fs.readFileSync` 抛 ENOENT（`RNCodegen.js:220`）。
12. **iOS 脚本期 libraryType 未知 → 静默不生成**：`script_phases.sh:86-93`。
13. **`findLibrariesFromReactNativeConfig` 读 package.json 失败 → 静默跳过该依赖**：`utils.js:235-239` `catch { return []; }`。
14. **`getLibraryName` / `readGeneratedAutolinkingOutput` 缺文件 → 返回 null / `{}`**：`utils.js:472-476`（无保护）、`:110-118`。
15. **`nullthrows(componentModules.get(componentName))`**：`SchemaValidator.js:39`——理论上可抛，但前面 :35-37 保证了存在。
16. **`parserMock.js` 的 `MockedParser`** 被打进产物 `lib`，其中方法默认返回 `null`/空（见 §8）。

### 5.3 输入校验及无效输入处理

| 校验 | 位置 |
|---|---|
| Schema 结构校验（**仅重复组件名**） | `SchemaValidator.js:17-62`；`RNCodegen.js:257`、`:314`、`:338` 三处调用 |
| `codegenConfig` 必须是对象 | `utils.js:205-207` |
| `codegenConfig.type` 合法 | `generate-specs-cli-executor.js:65-69` |
| `platform` 合法（app 级） | `index.js:74-84`（`['android','ios','all']`） |
| `platform` 合法（CLI） | `combine-schemas-cli.js:41-43`；`generate-provider-cli.js:75-77` |
| 恰好一个 `extends TurboModule` interface | `error-utils.js:53-66`（0 个）、`:262-275`（>1 个）、`errors.js:47-77` 消息 |
| interface 必须叫 `Spec` | `error-utils.js:39-51`；`errors.js:37-45` |
| 恰好一次 `TurboModuleRegistry.get/getEnforcing` | `error-utils.js:82-90`（0 次）、`:68-80`（>1 次）；判定 `parsers/utils.js:168-200` |
| registry 调用必须带类型参数、且为 `<Spec>` | `error-utils.js:145-160`、`:108-127`；`flow/parser.js:103-110`；`typescript/parser.js:101-108` |
| registry 调用恰好 1 个实参、且为字符串字面量 | `error-utils.js:92-106`；`error-utils.js:316-345` |
| module interface 只允许函数 / 非空 `EventEmitter` | `parsers-commons.js:825-878`；`error-utils.js:129-…`、`:162-…`、`:200-…` |
| enum 成员合法性 | `flow/parser.js:194-253`；`typescript/parser.js:184-247`；`parsers-primitives.js:301-315` |
| `Promise<ArrayBuffer>` / `ArrayBuffer` 作为 EventEmitter payload | `generators/modules/Utils.js:95-137`（生成期，两平台共用） |
| `getConstants` 形状 | `GenerateModuleObjCpp/serializeMethod.js:484-528`；`GenerateModuleJavaSpec.js:478-556` |
| prop 重名 | `parsers-commons.js:1316-1325 verifyPropNotAlreadyDefined` |

**没有任何 schema 级 JSON-Schema 校验**：`src/CodegenSchema.d.ts` 只是 TS 类型声明；`SchemaValidator.js` 只手写了组件重复一项。

### 5.4 重复检测逻辑

| 检测 | 位置 | 覆盖范围 |
|---|---|---|
| 同名组件出现在多个 module（**同一 schema 内**） | `SchemaValidator.js:23-51`；消息 `Duplicate components found with name ${componentName}. Found in modules ${…}`（:46-48） | 仅 **组件**，不覆盖 TurboModule 名 |
| 同名 component/module 出现在多个**库** | `packages/react-native/scripts/codegen/generate-artifacts-executor/utils.js:408-470 parseiOSAnnotations`；冲突判定 `:448-467`，`throw new Error('Some components or modules are declared in more than one libraries: \n' + …)` | 仅 iOS；且**只检查 `codegenConfig.ios.modules` / `.components`**（`:423-426` 无 `ios` 则 `continue`） |
| 跨 schema 文件的同名 spec | `packages/react-native-codegen/src/cli/combine/combine-schemas-cli.js:67-73` | `assert.deepEqual(module, modules[specName], \`App contained two specs with the same file name '${specName}'…\`)`——**内容相同则放行，内容不同才 AssertionError** |
| **主路径无重复检测** | `packages/react-native-codegen/src/cli/combine/combine-js-to-schema.js:44-46` | `merged.modules = {...merged.modules, ...schema.modules};` —— 同一 `hasteModuleName` 后者**直接覆盖**前者，无任何警告 |
| 一个文件多个 `codegenNativeCommands` | `error-utils.js:368-374` | 有 |
| 一个文件多个 `codegenNativeComponent` | `error-utils.js:382-386` | 有 |
| 一个文件多个 TurboModule interface | `error-utils.js:262-275` | 有 |
| 一个文件多个 `TurboModuleRegistry.get*` | `error-utils.js:68-80` | 有 |
| prop 重名 | `parsers-commons.js:1316-1325` | 有 |

---

## 6. SPEC VALIDATION

### 6.1 类型检查：Flow 还是 TS？

- **Flow**：`packages/react-native-codegen/src/parsers/flow/parser.js:149-151` → `parseFlowAndThrowErrors`（`src/parsers/flow/parseFlowAndThrowErrors.js:23-30`）：
  ```js
      ast = flowParser.parse(code, {
        // Produce an ESTree-compliant AST
        babel: false,
        // Parse Flow without a pragma
        flow: 'all',
        reactRuntimeTarget: '19',
        ...(options.filename != null ? {sourceFilename: options.filename} : {}),
      });
  ```
  `flow-parser` 版本 pin 在 `packages/react-native-codegen/package.json:34`：`"flow-parser": "0.331.0"`。**只做语法解析 + AST 形状校验，不做类型检查**。
- **TypeScript**：`src/parsers/typescript/parser.js:151-156`
  ```js
    getAst(contents: string, filename?: ?string): $FlowFixMe {
      return babelParser.parse(contents, {
        sourceType: 'module',
        plugins: ['typescript'],
      }).program;
    }
  ```
  `@babel/parser` 版本 `^7.29.9`（`package.json:33`）。同样只解析，不做类型检查。
- **仓库级类型检查**：`yarn flow-check`（`AGENTS.md`）。codegen 自身是 `@flow strict` / `@flow strict-local`（见各文件头）。
- 结论：**codegen 不对 spec 做类型检查**，只做语法解析 + 结构断言（§5.3）。

### 6.2 spec 方法签名的“运行时”校验

没有运行时校验（spec 是静态类型）。codegen 内部的等价物（生成期断言）：

- `GenerateModuleH.js:623-625` 的 `static_assert(bridging::getParameterCount(&T::${prop.name}) == ${paramTypes.length}, ...)` —— **编译期**断言用户 C++ 实现的参数个数；`paramTypes` 已被 `:605 paramTypes.unshift('jsi::Runtime &rt')` 加了 1。
- `GenerateModuleJavaSpec.js:530-552`：`getConstants()` 在 `ReactBuildConfig.DEBUG || ReactBuildConfig.IS_INTERNAL_BUILD` 下校验必填/可选常量名集合（:537-549）。
- 无其它签名一致性校验。

### 6.3 保留 / 禁止名称

**codegen 中不存在 ObjC 生命周期方法（`init`/`new`/`dealloc`/`description`/…）或 Java 关键字的冲突检查** —— 实测 `grep -rn "'new'\|'init'\|'copy'\|'description'\|'debugDescription'\|'class'\|'self'\|'dealloc'\|…"` 在 `packages/react-native-codegen/src` 与 `packages/react-native/scripts/codegen` 的非测试文件中 **0 命中**；`grep -rn "RESERVED_NAMES\|reservedNames\|forbiddenNames\|DISALLOWED"` 全 `packages/` 仅命中 `packages/react-native/scripts/spm/generate-spm-autolinking.js:113`（SwiftPM，与 codegen 无关）。

唯一一处“保留名转义”：
- `packages/react-native-codegen/src/generators/modules/GenerateModuleObjCpp/Utils.js:15-20`
  ```js
  function getSafePropertyName(property: StructProperty): string {
    if (property.name === 'id') {
      return `${property.name}_`;
    }
    return property.name;
  }
  ```
  只处理 `id` 一个名字。快照实证 `GenerateModuleHObjCpp-test.js.snap:220` `double id_() const;` 与 :367 `id const p = _v[@\"id\"];`。

Java 侧的「类名清洗」只是去 `RCT` 前缀，不是关键字处理：`components/JavaHelpers.js:20-26`
```js
  function getInterfaceJavaClassName(componentName: string): string {
    return `${componentName.replace(/^RCT/, '')}ManagerInterface`;
  }

  function getDelegateJavaClassName(componentName: string): string {
    return `${componentName.replace(/^RCT/, '')}ManagerDelegate`;
  }
```

C++ 标识符清洗 `toSafeCppString`（`generators/Utils.js:40-50`）**只处理 `-`**：
```js
  function toSafeIdentifier(input: string, shouldCapitalize: boolean): string {
    const parts = input.split('-');
    if (!shouldCapitalize) {
      return parts.join('');
    }
    return parts.map(toPascalCase).join('');
  }

  function toSafeCppString(input: string): string {
    return toSafeIdentifier(input, true);
  }
```
且**未应用于 TurboModule 方法名**（见 §4.3 末行）。

---

## 7. HARDCODED VALUES

### 7.1 映射到 ObjC / Java / C++ 关键字或保留名的硬编码字符串

| 值 | 语义 | path:line |
|---|---|---|
| `'id'` | ObjC `id` 类型 → 加 `_` 后缀 | `generators/modules/GenerateModuleObjCpp/Utils.js:16` |
| `'id_'` | 反向映射（snapshot :220/:367） | 由上一行产生 |
| `'getConstants'` | 特殊方法名，iOS/Java/JNI 三处硬编码分支 | `GenerateModuleObjCpp/serializeMethod.js:77`；`GenerateModuleObjCpp/index.js:184`、`:187`；`GenerateModuleJavaSpec.js:593`；`GenerateModuleJniCpp.js:437`、`:459`、`:524` |
| `'constantsToExport'` | 由 `getConstants` 派生的第二个 ObjC 协议方法名 | `GenerateModuleObjCpp/serializeMethod.js:533` `return ['constantsToExport', 'getConstants'].map<MethodSerializationOutput>(`；过滤见 `index.js:222` `({selector}) => selector !== '@selector(constantsToExport)'` |
| `'Constants'` | 常量 struct 名 | `GenerateModuleObjCpp/serializeMethod.js:519` |
| `'Spec'` | interface 必须的名字 | `flow/parser.js:108`；`typescript/parser.js:106`；`error-utils.js:44` |
| `'TurboModule'` | interface 必须 extends 的名字 | `flow/parser.js:260`；`typescript/parser.js:286`；`parsers-primitives.js:601`、`:609`；`parsers-commons.js:661` |
| `'TurboModuleRegistry'` / `'get'` / `'getEnforcing'` | 唯一被识别的 registry 调用形状 | `parsers/utils.js:182`、`:189-190` |
| `'codegenNativeComponent'` | 组件入口 | `parsers-commons.js:660`；`parsers-primitives.js:591`；`combine-js-to-schema.js:34` |
| `'codegenNativeCommands'` | 命令入口 | `parsers-commons.js:1041`；`combine-utils.js:33` |
| `'RootTag'` | 唯一支持的 Reserved 类型名 | `parsers-primitives.js:102`；`GenerateModuleH.js:88`、`:251`；`serializeMethod.js:260`、`:340`；`GenerateModuleJavaSpec.js:222`、`:319`；`GenerateModuleJniCpp.js:162` |
| `'EventEmitter'` | EventEmitter 属性的类型名 | `parsers-commons.js:843`（TS）、`:845`（Flow） |
| `'ViewProps'` | 唯一支持的 spread | `flow/parser.js:483`；`typescript/components/extends.js`（同构） |
| `'WithDefault'` / `'Readonly'` | TS 特殊类型 | `typescript/parseTopLevelType.js:126`、`:133`、`:223`、`:230` |
| `'Spec'` 之外的保留字 `Stringish/Int32/Double/Float/UnsafeObject/Object/$Partial/Partial/UnsafeMixed/unknown/ArrayBuffer` | 通用类型名映射表 | `parsers-primitives.js:664-682` `typeMap` |
| `'StringLiteralUnionTypeAnnotation'` | union 简写 | `CodegenSchema.js:419`、`:406` |
| `'RCTBridgeModule'` / `'RCTTurboModule'` | ObjC 协议 superclass | `GenerateModuleObjCpp/index.js:36` |
| `'RCTResponseSenderBlock'` / `'RCTPromiseResolveBlock'` / `'RCTPromiseRejectBlock'` | ObjC block 类型 | `serializeMethod.js:214`、`:120-121` |
| `'RCTArrayBuffer'` / `'RCTTypeSafety/RCTTypedModuleConstants.h'` / `'React/RCTCxxConvert.h'` / `'React/RCTManagedPointer.h'` / `'ReactCommon/RCTTurboModule.h'` | 生成头文件的固定 import | `GenerateModuleObjCpp/index.js:96-106` |
| `'JS::'` / `'facebook::react::'` / `'RCTCxxConvert'` | ObjC↔C++ 桥接前缀 | `GenerateModuleObjCpp/Utils.js:26`；`GenerateModuleObjCpp/source/serializeModule.js:53`、`:109-113` |
| `'<RCTBridgeModule, RCTTurboModule>'` | 协议继承列表 | `GenerateModuleObjCpp/index.js:36` |
| Java 类名 / 注解 | `ReactContextBaseJavaModule`、`TurboModule`、`ReactMethod`、`DoNotStrip`、`@Nonnull`/`@Nullable`、`com.facebook.react.turbomodule.core.interfaces.TurboModule` | `GenerateModuleJavaSpec.js:584-590`、`:640-642`、`:73` |
| Java 包名 | `'com.facebook.fbreact.specs'`（模块默认）、`'com.facebook.react.viewmanagers'`（组件，**硬编码**） | `GenerateModuleJavaSpec.js:570`；`GeneratePropsJavaInterface.js:244`；`GeneratePropsJavaDelegate.js:308` |
| Java 方法名 | `getName`、`getConstants`、`getTypedExportedConstants`、`configureEventEmitterCallback`、`mEventEmitterCallback` | `GenerateModuleJavaSpec.js:73-75`、`:530`、`:534`、`:97` |
| JNI 描述符 | `Lcom/facebook/react/bridge/ReadableMap;`、`Lcom/facebook/react/bridge/WritableMap;`、`Lcom/facebook/react/bridge/WritableArray;`、`Lcom/facebook/react/bridge/Callback;`、`Lcom/facebook/react/bridge/Promise;`、`Lcom/facebook/react/bridge/ArrayBuffer;`、`Ljava/util/Map;`、`Ljava/lang/Double;` | `GenerateModuleJniCpp.js:380-406`、`:394-400`、`:438` |
| C++ 类名 | `${hasteModuleName}CxxSpec`、`${hasteModuleName}SpecJSI`、`JSI_EXPORT`、`TurboModule`、`JavaTurboModule`、`ObjCTurboModule`、`methodMap_`、`eventEmitterMap_`、`MethodMetadata`、`AsyncEventEmitter` | `GenerateModuleH.js:179`、`:184`、`:187`；`GenerateModuleJniH.js:25`；`GenerateModuleObjCpp/index.js:55` |
| `TurboModuleMethodValueKind` 名字 | `VoidKind/BooleanKind/NumberKind/StringKind/ObjectKind/ArrayKind/PromiseKind/ArrayBufferKind`（C++ 枚举里还有 `FunctionKind`，codegen 从不生成） | `GenerateModuleH.js` 不生成；`GenerateModuleObjCpp/serializeMethod.js:48-56 ReturnJSType`；`GenerateModuleJniCpp.js:35-43 JSReturnType` |
| Apple 平台宏 | `TARGET_OS_IOS` / `TARGET_OS_OSX` / `TARGET_OS_TV` / `TARGET_OS_VISION` | `components/ComponentsProviderUtils.js:11-16` |
| Apple 平台列表 | `['ios','macos','tvos','visionos']` | `generateSchemaInfos.js:53`；`'macos' → 'osx'`（:113-118） |
| `'FBReactNativeSpec'` | 核心库名，5 处特判 | `constants.js:34`；`generateNativeCode.js:94`；`generate-specs-cli-executor.js:83`；`generate-all.js:50`；`GenerateModuleJniH.js:131` |
| `'com.facebook.fbreact.specs'` | Java 包名兜底 | `generateNativeCode.js:65`；`generate-specs-cli-executor.js:38`（CLI default）；`GenerateModuleJavaSpec.js:570` |
| `'react-native-codegen'` | 产物注释里的项目名 | 所有生成模板头部（例：`GenerateModuleH.js:205`） |
| `'P{index}'` / `'P${i}'` | C++ struct 模板参数名 | `GenerateModuleH.js:354`、`:357`、`:375` |
| `'__'` 方法名前缀 | C++/ObjC host function | `GenerateModuleH.js:187`、`:622`；`GenerateModuleObjCpp/source/serializeModule.js:127`；`GenerateModuleJniCpp.js:56`、`:79` |
| `'js/'` 前缀 | 组件 Java 输出目录 | `generate-specs-cli-executor.js:105` `${outputDirectory}/jni/react/renderer/components/${libraryName}` |
| `'react/renderer/components'` | headerPrefix 默认值 | `RNCodegen.js:259` |

### 7.2 注释里陈述的数值 / 阈值 / 不变量（逐字）

| 注释原文 | path:line |
|---|---|
| `* Single source of truth for the 6 reserved primitive types used in` | `generators/ReservedPrimitiveTypes.js:14` |
| `* Previously these mappings were scattered across CppHelpers.js,` | `generators/ReservedPrimitiveTypes.js:18` |
| `        // ImageRequestPrimitive is not used in Java component props` | `generators/ReservedPrimitiveTypes.js:83` |
| `  const includeGetDebugPropsImplementation =` / `    libraryName.includes('FBReactNativeSpec'); //only generate getDebugString for React Native Core Components` | `generate-specs-cli-executor.js:82-83` |
| ` * We create an umbrella header (and corresponding implementation) here since` / ` * Cxx compilation in BUCK has a limitation: source-code producing genrule()s` / ` * must have a single output. More files => more genrule()s => slower builds.` | `GenerateModuleObjCpp/index.js:83-85`、`:133-135` |
| `    // Note: this should've been done by RNCodegen's generators, but:` / `    // * the generators don't support platform option yet` / `    // * this subdir structure is Android-only, not applicable to iOS` | `generate-specs-cli-executor.js:100-103` |
| `// Platform-native (Java/Kotlin and ObjC) TurboModules copy ArrayBuffer` … `// On Android it cannot work: the resolve path serializes through` / `// folly::dynamic, which cannot carry raw bytes.` | `generators/modules/Utils.js:81-87` |
| `// ArrayBuffer is not emittable on any platform: Android emitters always carry a` | `generators/modules/Utils.js:121`；`parsers/error-utils.js:200` |
| `    // TODO: Make StringEnumTypeAnnotation type-safe?` 等 12 处 | `generators/components/GeneratePropsJavaPojo/serializePojo.js:63,67,81,87,93,99,159,179,184,189,194` |
| `          // Void emitters take no argument, so the caller never asks for a type.` | `GenerateModuleJavaSpec.js:187` |
| `  // mEventEmitterCallback is set from JNI by configureEventEmitterCallback(),` … `  // and the field is never reset to null.` | `GenerateModuleJavaSpec.js:87-91` |
| `      // Array in params always codegen NSArray *` / `       * TODO(T73933406): Support codegen for Arrays of structs and primitives` | `GenerateModuleObjCpp/serializeMethod.js:218-220` |
| `      // TODO(T247151345): Implement proper heterogeneous union support. This is unsafe.` | `GenerateModuleObjCpp/serializeMethod.js:273`；`header/serializeStructUtils.js:47`；`StructCollector.js:166` |
| `  // According to Podspec Syntax Reference, when \`platform\` or \`deployment_target\` is not specified, it defaults to all platforms.` | `components/ComponentsProviderUtils.js:29-30` |
| `  // Use rncore as target name for backwards compat` | `GenerateModuleJniH.js:129` |
| `  // We need to link different libraries based on whether we are building rncore or not, that's necessary` / `  // because we want to break a circular dependency between react_codegen_rncore and reactnative` | `GenerateModuleJniH.js:90-91` |
| `  // Take the first podspec found` | `generateSchemaInfos.js:70` |
| `      /**\n       * Podspec can have platforms defined in two ways:\n       * 1. \`spec.platforms = { :ios => "11.0", :tvos => "11.0" }\`\n       * 2. \`s.ios.deployment_target = "11.0"\`\n       *    \`s.tvos.deployment_target = "11.0"\`\n       */` | `generateSchemaInfos.js:73-78` |
| `  // If library's 'codegenConfig' sets 'includesGeneratedCode' to 'true',` / `  // then we assume that native code is shipped with the library,` | `generate-artifacts-executor/index.js:281-282` |
| `  // NOTE: This needs to be computed per-platform since \`platform\` can alter the path via a \`package.json:codegenConfig.outputDir[platform]\` override` | `index.js:99` |
| `// Removing .fb if it exists`（`// Remove \`.fb\` if it exists (see \`react-native.cconf\`).`） | `src/cli/combine/combine-utils.js:29-30` |
| `// we don't cache misses, to allow for methodMap_ to dynamically be` / `  // extended` | `ReactCommon/.../TurboModule.h:62-63` |
| `   * // DO NOT OVERRIDE - it will become final in a future release.` | `TurboModule.h:53` |
| ` * @deprecated Use TurboModuleProviderFunctionTypeWithRuntime instead.` / ` * Remove after React Native 0.84 is released.` | `TurboModule.h:150-151` |

### 7.3 注释与代码矛盾（已核实）

1. **`parsers/typescript/parseTopLevelType.js:231`**：抛错消息写 `WithDefault<> is now allowed in intersection types.`，但代码是 `throw new Error(...)` —— **行为是“不允许”**，文案说“允许”。
2. **`generators/modules/GenerateModuleH.js:624-625`**：`static_assert(bridging::getParameterCount(&T::${prop.name}) == ${paramTypes.length}, "Expected ${prop.name}(...) to have ${paramTypes.length} parameters")`，而 `:605` 已 `paramTypes.unshift('jsi::Runtime &rt')`。快照 `GenerateModuleH-test.js.snap:74-76` 对 0 参数方法输出 `"Expected getArrayBuffer(...) to have 1 parameters"` —— 数字含 runtime，且英文 “1 parameters” 与用户声明的 0 个参数不符。
3. **`packages/react-native/scripts/codegen/generate-specs-cli-executor.js:83`** 注释 `//only generate getDebugString for React Native Core Components`，判据是 `libraryName.includes('FBReactNativeSpec')` —— 任意名字含该子串的库都会开启（不只是 React Native core）。
4. **`generators/components/GeneratePropsJavaInterface.js:243` / `GeneratePropsJavaDelegate.js:307`**：`// TODO: This doesn't support custom package name yet.`，而 `packages/react-native-popup-menu-android/package.json:53` 已声明 `"javaPackageName": "com.facebook.react.viewmanagers"` —— 该声明对组件生成无效（JS 侧硬编码包名）。
5. **`generators/ReservedPrimitiveTypes.js:14`** 称 “Single source of truth”，但 Java 侧的导入映射仍在 `components/JavaHelpers.js:64-75` 单独维护了一份 `'ColorPrimitive'|'EdgeInsetsPrimitive'|'ImageSourcePrimitive'|'PointPrimitive'|'DimensionPrimitive'` 列表（缺 `ImageRequestPrimitive`），并单独 `throw new Error('Invalid knownTypeName')`（`JavaHelpers.js:56`）。
6. **`src/cli/generators/generate-all.js:35-39`**：`:37 if (schemaText == null)` 是死代码——`fs.readFileSync` 在 `:35` 抛错而非返回 null。同样的死代码出现在 `packages/react-native/scripts/codegen/generate-specs-cli-executor.js:52-56` 与 `packages/react-native/scripts/generate-provider-cli.js:47-51`。
7. **`src/parsers/utils.js:180`** 的格式化 `if (!( ... ))` 破坏 prettier 风格（相邻代码均遵循该风格）。
8. **`generators/modules/GenerateModuleH.js:93` 与 `:112`、`:155`**：`${arg.name}, found:` 少一个 `}`（应为 `${arg.name}`），是模板字符串笔误。同类笔误见 `generators/components/GeneratePropsJavaDelegate.js:196`、`:212` 与 `GeneratePropsJavaInterface.js:162`、`:178` 的 `Receieved invalid type`（`Receieved` 拼写错误，6 处）。

### 7.4 TODO / FIXME / HACK / XXX / WORKAROUND 全量

命令：`grep -rn "TODO\|FIXME\|HACK\|XXX\|WORKAROUND" --include="*.js" packages/react-native-codegen/src | grep -v "__tests__\|__test_fixtures__"`

```
parsers/parsers-commons.js:85    // $FlowFixMe[unclear-type] TODO(T108222691): Use flow-types for @babel/parser
parsers/parsers-commons.js:139     * TODO(T108222691): Use flow-types for @babel/parser
parsers/parsers-commons.js:331   // TODO(T108222691): Use flow-types for @babel/parser
parsers/parsers-commons.js:332   // TODO(T71778680): This is a FunctionTypeAnnotation. Type this.
parsers/parsers-commons.js:430   // TODO(T108222691): [TS] Use flow-types for @babel/parser
parsers/parsers-commons.js:431   // TODO(T71778680): [Flow] This is an ObjectTypeProperty containing either:
parsers/parsers-commons.js:492   // TODO(T108222691): [TS] Use flow-types for @babel/parser
parsers/parsers-commons.js:493   // TODO(T71778680): [Flow] This is an ObjectTypeProperty containing either:
parsers/parsers-commons.js:615          * TODO(T77968131): We have two options:
parsers/parsers-commons.js:766   * TODO(T71778680): Flow-type this node.
parsers/parsers-commons.js:1154  * TODO(T108222691): Use flow-types for @babel/parser */
parsers/typescript/components/events.js:240  // $FlowFixMe[unclear-type] TODO(T108222691): Use flow-types for @babel/parser
parsers/typescript/components/index.js:24    // $FlowFixMe[unclear-type] TODO(T108222691): Use flow-types for @babel/parser
parsers/typescript/components/index.js:27    // $FlowFixMe[signature-verification-failure] TODO(T108222691): Use flow-types for @babel/parser
parsers/typescript/components/extends.js:26  // $FlowFixMe[unclear-type] TODO(T108222691): Use flow-types for @babel/parser
parsers/typescript/components/commands.js:133  // TODO: T172453752 support more complex type annotation for array element
parsers/typescript/modules/index.js:56   * TODO(T108222691): Use flow-types for @babel/parser
parsers/typescript/modules/index.js:186  * TODO(T108222691): Use flow-types for @babel/parser
parsers/typescript/parser.js:301   // TODO(T108222691): Use flow-types for @babel/parser
parsers/typescript/parser.js:436     // TODO(T108222691): Use flow-types for @babel/parser
parsers/parsers-primitives.js:506     * TODO(T72031674): Migrate all our NativeModule specs to not use
parsers/parsers-primitives.js:518         * TODO(T72031674): Ensure that all ParsingErrors that are thrown
parsers/utils.js:108    // TODO(T108222691): Use flow-types for @babel/parser
parsers/utils.js:138    // TODO(T71778680): Flow-type this node.
parsers/utils.js:167    // TODO(T71778680): Flow-type ASTNodes.
parsers/error-utils.js:302     // TODO: Added as a work-around for now until TupleTypeAnnotation are fully supported in both flow and TS
parsers/flow/components/commands.js:164   // TODO: T172453752 support more complex type annotation for array element
parsers/flow/modules/index.js:54   * TODO(T71778680): Flow-type this node.
parsers/flow/parser.js:275   // TODO(T71778680): Flow type AST Nodes
generators/components/GeneratePropsJavaDelegate.js:307     // TODO: This doesn't support custom package name yet.
generators/components/GeneratePropsJavaPojo/serializePojo.js:63    // TODO: Make StringEnumTypeAnnotation type-safe?
generators/components/GeneratePropsJavaPojo/serializePojo.js:67    // TODO: Make Int32EnumTypeAnnotation type-safe?
generators/components/GeneratePropsJavaPojo/serializePojo.js:81        // TODO: Make ImageSourcePrimitive type-safe
generators/components/GeneratePropsJavaPojo/serializePojo.js:87        // TODO: Make ImageRequestPrimitive type-safe
generators/components/GeneratePropsJavaPojo/serializePojo.js:93        // TODO: Make PointPrimitive type-safe
generators/components/GeneratePropsJavaPojo/serializePojo.js:99        // TODO: Make EdgeInsetsPrimitive type-safe
generators/components/GeneratePropsJavaPojo/serializePojo.js:159          // TODO: Make StringEnums type-safe in Pojos
generators/components/GeneratePropsJavaPojo/serializePojo.js:179              // TODO: Make ImageSourcePrimitive type-safe
generators/components/GeneratePropsJavaPojo/serializePojo.js:184              // TODO: Make ImageRequestPrimitive type-safe
generators/components/GeneratePropsJavaPojo/serializePojo.js:189              // TODO: Make EdgeInsetsPrimitive type-safe
generators/components/GeneratePropsJavaPojo/serializePojo.js:194              // TODO: Make EdgeInsetsPrimitive type-safe
generators/components/GeneratePropsJavaInterface.js:243     // TODO: This doesn't support custom package name yet.
generators/RNCodegen.js:139   // TODO: Refactor this to consolidate various C++ output variation instead of forking per platform.
generators/modules/GenerateModuleJavaSpec.js:213    // FIXME: support class alias for args
generators/modules/GenerateModuleJavaSpec.js:310    // FIXME: support class alias for args
generators/modules/GenerateModuleObjCpp/StructCollector.js:166           // TODO(T247151345): Implement proper heterogeneous union support.
generators/modules/GenerateModuleObjCpp/serializeMethod.js:113     // TODO(T76719514): Disallow nullable PromiseTypeAnnotations
generators/modules/GenerateModuleObjCpp/serializeMethod.js:220        * TODO(T73933406): Support codegen for Arrays of structs and primitives
generators/modules/GenerateModuleObjCpp/serializeMethod.js:251        * TODO(T73943261): Support nullable object literals and aliases?
generators/modules/GenerateModuleObjCpp/serializeMethod.js:273       // TODO(T247151345): Implement proper heterogeneous union support. This is unsafe.
generators/modules/GenerateModuleObjCpp/serializeMethod.js:349       // TODO: Can NSString * returns not be _Nullable?
generators/modules/GenerateModuleObjCpp/serializeMethod.js:353       // TODO: Can NSString * returns not be _Nullable?
generators/modules/GenerateModuleObjCpp/serializeMethod.js:391           // TODO: Can NSString * returns not be _Nullable?
generators/modules/GenerateModuleObjCpp/header/serializeStructUtils.js:47      // TODO(T247151345): Implement proper heterogeneous union support. This is unsafe.
CodegenSchema.js:288   // TODO: It's clearer to define `restrictedToPlatforms` instead, but
CodegenSchema.js:327    * TODO(T72031674): Migrate all our NativeModule specs to not use
```

`HACK` / `XXX` 在 `packages/react-native-codegen/src` 非测试文件中 **0 命中**。

---

## 8. DEAD CODE

### 8.1 生产代码中零调用者的导出（仓库全局搜索，排除测试）

| 符号 / 文件 | 行数 | 唯一引用位置 | 判定 |
|---|---|---|---|
| `packages/react-native-codegen/src/parsers/parserMock.js`（`MockedParser`） | 512 | `src/parsers/__tests__/parsers-commons-test.js:16`、`src/parsers/__tests__/parsers-primitives-test.js:17` | **死代码但被打包进 `lib`**（`package.json:28-30 files:["lib"]`）；含 3 处 `throw new Error` 会进入发布产物 |
| `packages/react-native-codegen/src/parsers/consistency/compareSnaps.js`（`compareSnaps`, `compareTsArraySnaps`） | 95 | `src/parsers/consistency/__tests__/checkComponentSnaps-test.js:19,30`、`checkModuleSnaps-test.js:19,35` | **死代码**，且直接调用 jest 全局 `describe/it/expect`（:26,:27,:38,:49,:58,:78），若被生产路径 require 会立即崩 |
| `packages/react-native-codegen/src/parsers/schema/index.js`（`parse`） | 30 | 无（`require('../schema.js')` 显式指向同名文件 `schema.js`；`flow/parser.js:50`、`typescript/parser.js:51`） | **死代码** |
| `RNCodegen.allGenerators` / `ALL_GENERATORS` | `RNCodegen.js:242`（表 `:41-66`，24 项） | 仅 `src/generators/RNCodegen.d.ts:94` 的类型声明 | **死代码**：生产链只走 `LIBRARY_GENERATORS`（:125）与 `SCHEMAS_GENERATORS`（:183） |
| `src/cli/parser/parser.js` + `parser-cli.js` + `parser.sh` | 31 + 17 + (sh) | `parser-cli.js:13` require `./parser.js`；**全仓库无任何调用者**（`grep -rn "cli/parser"` 只命中自身） | **死代码**（3 个文件） |
| `src/cli/generators/generate-all.js` | 73 | **全仓库零引用**（`grep -rn "generate-all"` 无命中）；`package.json` 无 `bin` 字段 | **死代码**。它是唯一会启用 `descriptors/events/props/states/tests/shadow-nodes` 这些分组的地方 |
| `src/cli/combine/combine-schemas-cli.js` | 116 | 仅 `script_phases.sh:80` 在 `noCodegenDiscovery` 分支下以 `lib/cli/combine/combine-js-to-schema-cli.js` 的**路径字符串**引用；实际运行的 `combine-js-to-schema-cli.js`（同目录，44 行）另行 require `./combine-js-to-schema`（:15） | `combine-schemas-cli.js` 在 OSS 路径**不被调用**；`generate-provider-cli.js` 由 `packages/react-native/package.json:104` 的 `bin` 暴露（见 `ReactAppDependencyProvider.podspec.template`） |
| `parsers-utils.js` 的 `nullGuard` | 19 行整个文件 | 仅 `parsers-primitives.js:63` require、`:525` 一处使用 | 名副其实的 no-op（`parsers-utils.js:13-15` `return fn();`）；保留为“可切换的错误捕获策略” |
| `parsers/utils.js` `getSortedObject` | `:202-211` | `parsers-commons.js:910-911` | 活 |
| `parsers/parser.js` `Parser.parseModuleFixture` | `:168` | `flow/parser.js:143`、`typescript/parser.js:145` 实现；仅被 `module-parser-snapshot-test.js:35,50` 与 `typescript-module-parser-snapshot-test.js:35,50` 调用 | **仅测试使用**（进产物但生产无调用） |
| `getModules` | `generators/modules/Utils.js:38-52` | 全部 5 个模块 generator | 活 |
| `GenerateViewConfigJs` | 503 行 | `RNCodegen.js:32` require、`:340` 在 `generateViewConfig()` 里用；调用方 `packages/babel-plugin-codegen/index.js:60` | 活（非主 codegen 路径） |
| `RNCodegen.generateFromSchemas` | `:309-333` | 仅 `packages/react-native/scripts/generate-provider-cli.js:79` | 活但**参数 `supportedApplePlatforms` 从不传**（见 §5.2-9） |

### 8.2 已注册但从不被调用的 generator / 分组

`LIBRARY_GENERATORS`（`RNCodegen.js:125-181`）有 11 个 key。生产可达性：

| key | 生产可达？ | 说明 |
|---|---|---|
| `componentsAndroid` | ✔ | `generate-specs-cli-executor.js:19,23,27` |
| `componentsIOS` | ✔ | 同上 `:20,24,28` |
| `modulesAndroid` | ✔ | 同上 |
| `modulesCxx` | ✔ | 同上 |
| `modulesIOS` | ✔ | 同上 |
| `descriptors` | ✖ | 仅 `cli/generators/generate-all.js:62`（该文件无调用者） |
| `events` | ✖ | 同上 `:63` |
| `props` | ✖ | 同上 `:64` |
| `states` | ✖ | 同上 `:65` |
| `tests` | ✖ | 同上 `:66` → `GenerateTests.js`（223 行）**在生产中永不执行** |
| `shadow-nodes` | ✖ | 同上 `:67` |

`SCHEMAS_GENERATORS.providerIOS`（`RNCodegen.js:183-188`）可达（`generate-provider-cli.js:39`）。`generate-provider-cli.js:38 android: []` → Android 上该 generator 列表为空，**不产出任何文件也不报错**。

`GeneratePropsJavaPojo/*`（`index.js` + `PojoCollector.js` + `serializePojo.js`，319 行中占大头）**未出现在 `ALL_GENERATORS` / `LIBRARY_GENERATORS` / `SCHEMAS_GENERATORS` 任何一处** —— 实测 `grep -n "GeneratePropsJavaPojo" src/generators/RNCodegen.js` 无命中。它有独立快照测试（`GeneratePropsJavaPojo-test.js.snap`，3186 行）但**无生产注册点**。

`src/generators/modules/GenerateModuleObjCpp/serializeEventEmitter.js` 之外，`components/ComponentsGeneratorUtils.js`、`components/CppHelpers.js`、`components/JavaHelpers.js`、`components/JavaHelpers.js` 等辅助模块均活跃。

---

## 9. COMMENTS OF NOTE

已在本报告 §7.2 集中列出所有含数值/阈值/API 级/不变量的注释。此处补充**其他值得注意的注释**（逐字）：

| 注释 | path:line |
|---|---|
| ` * NOTE: This is React Native specific export type.` / ` * DEPRECATED_RCTExport is an interface type that allows native code generation` / ` * for React Native native modules. It exists as a hint to the codegen tool that` / ` * any interface that extends it needs to be codegen'ed.` … ` * NOTE: This export is deprecated. Please use TurboModule.` | `packages/react-native/Libraries/TurboModule/RCTExport.js:14,16-18,28` |
| `const turboModuleProxy = global.__turboModuleProxy;` | `TurboModuleRegistry.js:17` |
| ` * for React Native native modules. … The type param T is a placeholder for future codegen hinting, like versioning` / ` * information, native base classes, etc. For now, simply use \`void\` type as` / ` * there's nothing to give hint about.` | `RCTExport.js:24-26` |
| ` * This directory was created to move all the existing native module and native` / ` * component specs from the legacy \`Libraries\` directory. …` / `Do **not** create new specs in this directory.` | `packages/react-native/src/private/specs_DEPRECATED/__docs__/README.md:3-8` |
| `          * Nullability of type aliases is transitive.` … 25 行长注释，解释 `typeAliasResolution` 为何把可空性提升到使用点 | `parsers-primitives.js:243-276` |
| `    /**\n     * All aliases RHS are required.\n     */` | `parsers-primitives.js:243-245` |
| `      // this should drop everything after the file name. For Example it will drop:` / `      // .android.js, .android.ts, .android.tsx, .ios.js, .ios.ts, .ios.tsx, .js, .ts, .tsx` | `parsers/utils.js:29-30` |
| `  // Some module names use platform suffix to indicate platform-exclusive modules.` / `  // Eventually this should be made explicit in the Flow type itself.` | `parsers-commons.js:799-801` |
| `    // specfiles must follow the pattern: <​filename>[.<platform>].(js|ts|tsx)` | `combine-utils.js:60`（注意 `pattern` 前有一个零宽字符） |
| `  // It removes all the empty files and empty folders` … `// This function is needed since, after aligning the codegen between` / `// iOS and Android, we have to create empty folders in advance and` / `// we don't know whether they will be populated up until the end of the process.` | `generate-artifacts-executor/utils.js:67-74` |
| `  // This will become unnecessary once we start using Babel Register for the codegen package.` | `utils.js:51` |
| `      // The callback outlives this module, so it captures a copy of the map` / `        // instead of referencing eventEmitterMap_. Every emitter is registered` / `        // directly above, so the copy is complete; an emitter registered after` / `        // construction would not be reachable from the callback.` | `GenerateModuleObjCpp/source/serializeModule.js:86-89` |
| `  // Because we want to break a circular dependency …` | `GenerateModuleJniH.js:90-91` |
| `        // Filter(src, dest)` 之类 `cpSyncRecursiveIfChanged` 注释 | `utils.js:530` |

---

## 10. CROSS-LANGUAGE CONTRACT RISKS

### 10.1 通过**枚举序数**传递的值

**`TurboModuleMethodValueKind`** — C++ 枚举定义于 `packages/react-native/ReactCommon/react/nativemodule/core/ReactCommon/TurboModule.h:27-37`：
```cpp
enum TurboModuleMethodValueKind {
  VoidKind,
  BooleanKind,
  NumberKind,
  StringKind,
  ObjectKind,
  ArrayKind,
  FunctionKind,
  PromiseKind,
  ArrayBufferKind,
};
```
JS codegen 只输出**名字字符串**：
- iOS：`GenerateModuleObjCpp/serializeMethod.js:48-56`（`ReturnJSType` 类型，8 个名字）→ `GenerateModuleObjCpp/source/serializeModule.js:128` `invokeObjCMethod(rt, ${returnJSType}, …)`
- Android：`GenerateModuleJniCpp.js:35-43`（`JSReturnType`，同样 8 个）→ `GenerateModuleJniCpp.js:58` `invokeJavaMethod(rt, ${jsReturnType}, …)`

C++ 侧按 `switch (returnType)` 分派：`ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/RCTTurboModule.mm:916-917` `switch (returnType) { case PromiseKind: {`。**没有任何编译期检查保证 JS 侧名字集合与 C++ 枚举一致**；C++ 新增/重命名枚举值只会导致编译错误（较好），但若 C++ 侧 `switch` 缺一个 `case` 就会静默走 `default`。

`FunctionKind` 在 C++ 枚举里存在（`TurboModule.h:34`）但 **JS codegen 的两个 `*Kind` 联合类型里都没有**（`serializeMethod.js:48-56`、`GenerateModuleJniCpp.js:35-43`）——即“函数返回”在 native 侧不可达。

**同步性判定（跨语言重复实现，无共享源）**：
- JS/Android 生成：`GenerateModuleJavaSpec.js:618-620`
  ```js
        const isSyncMethod =
          methodTypeAnnotation.returnTypeAnnotation.type !==
            'VoidTypeAnnotation' && !returningPromise;
  ```
  → `@ReactMethod(isBlockingSynchronousMethod = true)`
- iOS 运行时：`RCTTurboModule.mm:867-873` `isMethodSync` → `return returnType != VoidKind && returnType != PromiseKind;`
- Android 运行时：`JavaTurboModule.cpp:602` `bool isMethodSync = isSyncMethod(valueKind);`

两边规则内容一致但**各写一份**，无共同定义。若任一侧规则改动，将出现“JS 侧认为同步、native 侧认为异步”的静默不一致。

### 10.2 通过**字符串键**传递的值

| 键 | 生产端 | 消费端 | 风险 |
|---|---|---|---|
| `methodMap_["<methodName>"]` | `GenerateModuleH.js:187`；`GenerateModuleJniCpp.js:79`；`GenerateModuleObjCpp/source/serializeModule.js:142` | `TurboModule.h:122` `methodMap_.find(propNameUtf8)`（JS 属性名） | JS 侧属性名必须与 spec 方法名逐字一致（大小写敏感）。**无编译期检查** |
| `eventEmitterMap_["<emitterName>"]` | `GenerateModuleH.js:664-668`；`GenerateModuleJniCpp.js:86`；`GenerateModuleObjCpp/source/serializeModule.js:81` | `TurboModule.h:132-133` | 同上 |
| `"<methodName>"` 传给 `invokeObjCMethod`/`invokeJavaMethod` | `serializeModule.js:128`；`GenerateModuleJniCpp.js:58` | `RCTTurboModule.mm:891-893`；`JavaTurboModule.cpp` | 用于 `NSInvocation` selector 查找 / JNI methodID 查找 |
| JNI 签名串 `"(<args>)<ret>"` | `GenerateModuleJniCpp.js:409-445 translateMethodTypeToJniSignature` | JNI `GetMethodID` | **必须与 Java 侧方法签名逐字一致**，Java 侧是生成的（`GenerateModuleJavaSpec.js:132-135`），但 Java 的 `ReadableMap`↔`WritableMap` 映射（`:228-231`/`:285`）与 JNI 描述符（`GenerateModuleJniCpp.js:394-396`）由**两处独立的 switch** 维护，无交叉校验 |
| ObjC `@selector(...)` | `GenerateModuleObjCpp/serializeMethod.js:155-159`、`:170` | `RCTTurboModule.mm` selector 查表 | selector 由**参数名**拼出（`:156 map(({paramName}) => paramName)`），改参数名即改 selector |
| `"JS_<Haste>_<Struct>:"` | `GenerateModuleObjCpp/source/serializeModule.js:145` `setMethodArgConversionSelector` | `RCTCxxConvert` 类别方法（由 `serializeModule.js:109-113` 生成） | 名字必须在同一生成批次内自洽；跨批次（旧 .h + 新 .mm）会运行期找不到 |
| `kModuleName` / `TurboModule(name)` | `GenerateModuleH.js:181,184` | `TurboModule` 基类 | 与 JS 的 `TurboModuleRegistry.get(name)` 用的字符串必须一致（来自 spec 的 `TurboModuleRegistry.getEnforcing('X')`），`GenerateModuleH.js:181` 用 `moduleName`（字面量），`TurboModuleRegistry.js:19-21` 用调用实参 |
| `${libraryName}_ModuleProvider` | 声明 `GenerateModuleJniH.js:56-57`（`libraryName.replace(/-/g,'_')`，:127）；定义 `GenerateModuleJniCpp.js:138`（:572 同样 replace） | JNI 侧按名查找（`packages/react-native/ReactAndroid/build.gradle.kts:111` 引用 `generated/source/codegen/jni/`） | C++ 符号按名约定，非编译期链接（除非显式调用） |
| `kJavaDescriptor = "Lcom/facebook/react/turbomodule/core/interfaces/TurboModule;"` | C++ `JavaTurboModule.h:23` | 生成的 Java `implements TurboModule` + import `GenerateModuleJavaSpec.js:587` `com.facebook.react.turbomodule.core.interfaces.TurboModule` | **C++ 硬编码 FQCN ↔ Java 生成 import**，字符串比对，运行期 `ClassCastException` 风险 |
| `Class<RCTComponentViewProtocol> <Name>Cls(void)` | 组件 View `.mm` 手写 | `generateRCTThirdPartyComponents.js:210` 正则爬取；`GenerateThirdPartyFabricComponentsProviderObjCpp.js:64` 生成 `{"<Name>", <Name>Cls}` | **正则 + 生成名双向约定**，无编译期检查 |
| `"<componentName>": NSClassFromString(@"<className>")` | `generateRCTThirdPartyComponents.js:142` | `RCTThirdPartyComponentsProviderMM.template:…` | className 来自 `codegenConfig.ios.components[*].className` 或正则爬取；错则运行期 nil |
| `"<moduleName>": @"<providerClass>"` | `generateRCTModuleProviders.js:106` | `RCTModuleProvidersMM.template:23`，`NSClassFromString`（:30） | 同上；运行期 `RCTLogError`（template :32）后 `continue`——**静默丢失一个模块 provider** |
| `unstableRequiresMainQueueSetup` 模块名 | `generateUnstableModulesRequiringMainQueueSetup.js:61-63` | `RCTUnstableModulesRequiringMainQueueSetupProviderMM.template` | 字符串列表 |
| Apple 平台支持 | `generateSchemaInfos.js:79-95`（**对 podspec 做 `line.includes('platform')` 子串匹配**）→ `ComponentsProviderUtils.js:11-16,39-47` → `#if !TARGET_OS_IOS` | ObjC 编译 | 见 10.4 |

### 10.3 通过**声明顺序**传递的值

1. **`MethodMetadata` 聚合初始化（字段顺序）**：`TurboModule.h:84-87`
   ```cpp
     struct MethodMetadata {
       size_t argCount;
       jsi::Value (*invoker)(jsi::Runtime &rt, TurboModule &turboModule, const jsi::Value *args, size_t count);
     };
   ```
   - C++ spec 用**具名**初始化：`MethodMetadata {.argCount = N, .invoker = __m}`（`GenerateModuleH.js:187`）——安全。
   - ObjC / Android 用**位置**初始化：`MethodMetadata {N, __hostFunction_...}`（`GenerateModuleObjCpp/source/serializeModule.js:142`；`GenerateModuleJniCpp.js:79`）——**若字段顺序变化，编译仍通过但语义反转**（`argCount` 会被当函数指针）。这是最脆弱的一处。

2. **`argCount` 与实际 selector / Java 参数个数不一致（Promise 方法）**：
   - 快照 `GenerateModuleMm-test.js.snap:696` 的 selector 是 `@selector(getValueWithPromise:resolve:reject:)`（3 段），`:744` 的 `MethodMetadata {1, …}`（argCount = 1，只有 spec 参数数）。
   - 快照 `GenerateModuleJavaSpec-test.js.snap` 与 `GenerateModuleJniCpp.js:634-638` 会给 Java 追加 `Promise promise`（Java 方法共 N+1 参数），而 `argCount` 仍为 N。
   - 运行时 `TurboModule.h:124-131` 只把 `argCount` 用作 `jsi::Function::createFromHostFunction` 的 `length` 参数（JS 函数 `.length`），真实 `count` 另行传入 → **`.length` 在三平台可能不一致，且无断言**。

3. **C++ `static_assert` 参数计数包含 runtime**：`GenerateModuleH.js:605` `paramTypes.unshift('jsi::Runtime &rt')` 与 `:623-625` 的 `getParameterCount(&T::m) == ${paramTypes.length}`。用户实现的 `T::m` 是否含 runtime 由 `bridging::callFromJs` 的约定决定（`GenerateModuleH.js:626` 把 `&T::m` 作为 callable 传入）——未确认 `bridging::getParameterCount` 是否把 runtime 计入，存在 off-by-one 风险（快照显示含，见 §7.3-2）。

4. **spec 方法/事件列表排序**：`parsers-commons.js:913-914` 对 `eventEmitters` 与 `methods` 做 **`.sort()`**（默认字典序），`GenerateModuleObjCpp/index.js:183-188` 又**额外把 `getConstants` 移到最后**：
   ```js
       spec.methods
         .filter(property => property.name !== 'getConstants')
         .forEach(serializeProperty);
       spec.methods
         .filter(property => property.name === 'getConstants')
         .forEach(serializeProperty);
   ```
   iOS `.mm` 的 `methodMap_` 初始化顺序 = 排序后顺序（+ getConstants 末尾），Android `.cpp` 用 `methods` 顺序（`GenerateModuleJniCpp.js:500-508`），Cxx 用 `methods` 顺序（`GenerateModuleH.js:754-762`）。三处**顺序不同但语义无关**（都是 map 赋值），然而**任何依赖顺序的输出**（如 §10.3-2 的 `.length`，或将来改成数组/序号表）都会立刻分裂。

5. **模块（hasteModuleName）顺序**：iOS `GenerateModuleObjCpp/index.js:157` `.sort()`；Android JNI class 声明 `GenerateModuleJniH.js:112-121` `.sort()`，而 `ModuleProvider` 的 if 链 `GenerateModuleJniCpp.js:554-563` 按 **`moduleName`**（不是 haste 名）排序。两套排序键不同。

6. **`combine-js-to-schema` 的 `{...merge}` 覆盖顺序**：`combine-js-to-schema.js:28-51` 的 `files.reduce` 按 `expandDirectoriesIntoFiles` 返回的顺序（`tinyglobby` 结果）合并，后出现的**覆盖**先出现的同名 haste 名。这是“按声明顺序决定谁赢”的隐式契约。

7. **EventEmitter 注册顺序 → 回调捕获**：`GenerateModuleObjCpp/source/serializeModule.js:86-97` 的注释明确说明 `setEventEmitterCallback([eventEmitterMap = eventEmitterMap_])` 依赖“**每个 emitter 都在构造体内、且在此之前注册完毕**”。若将来有任何 emitter 在构造后注册，注释所述即失效：
   ```js
           // The callback outlives this module, so it captures a copy of the map
           // instead of referencing eventEmitterMap_. Every emitter is registered
           // directly above, so the copy is complete; an emitter registered after
           // construction would not be reachable from the callback.
   ```

### 10.4 无编译期检查的两语言名称/顺序约定（汇总）

| # | 约定 | 生产方 | 消费方 | 检查手段 |
|---|---|---|---|---|
| 1 | TurboModule 方法名 | spec | `methodMap_` 键 / ObjC selector / JNI methodName | 无 |
| 2 | EventEmitter 名 | spec | `eventEmitterMap_` 键 + `invoke("<name>", …)`（`GenerateModuleJavaSpec.js:99`） | 无 |
| 3 | `TurboModuleMethodValueKind` 名字集合 | JS 字符串 | C++ 枚举 + `switch` | 仅间接（编译期找不到符号才报错） |
| 4 | 同步性判定规则 | `GenerateModuleJavaSpec.js:618-620` | `RCTTurboModule.mm:867-873` / `JavaTurboModule.cpp:602` | 无（两处独立实现） |
| 5 | JNI 描述符 ↔ Java 方法签名 | `GenerateModuleJniCpp.js:409-445` | `GenerateModuleJavaSpec.js:199-296` + `108-136` | 无 |
| 6 | `MethodMetadata` 字段顺序 | `TurboModule.h:84-87` | 位置初始化 `serializeModule.js:142`、`GenerateModuleJniCpp.js:79` | **仅位置初始化 → 顺序变了也不报错** |
| 7 | `JS_<Haste>_<Struct>:` 转换函数名 | `serializeModule.js:145` | `serializeModule.js:109-113` 生成的 `RCTCxxConvert` 类别 | 同一批次内自洽；跨批次无检查 |
| 8 | `Class<RCTComponentViewProtocol> XCls(void)` | 组件 `.mm`（手写） | `generateRCTThirdPartyComponents.js:210` 正则 + `GenerateThirdPartyFabricComponentsProviderObjCpp.js:64` | 正则，无检查 |
| 9 | `componentProvider` / `modulesProvider` 的 `className` | `codegenConfig.ios.*` | `RCTThirdPartyComponentsProviderMM.template` / `RCTModuleProvidersMM.template:30` `NSClassFromString` | 无（运行期 `RCTLogError` + `continue`，**静默降级**） |
| 10 | Java 类全限定名 | `JavaTurboModule.h:23` `kJavaDescriptor` | `GenerateModuleJavaSpec.js:587` import | 无 |
| 11 | `${libraryName}_ModuleProvider` 符号名 | `GenerateModuleJniH.js:127` / `GenerateModuleJniCpp.js:572`（`replace(/-/g,'_')`） | JNI 侧按名查找 | 无 |
| 12 | Apple 平台可用性 | `generateSchemaInfos.js:79-84`：`podspec.split('\n').filter(line => line.includes('platform') || line.includes('deployment_target')).join('')` | `ComponentsProviderUtils.js:39-47` → `#if !TARGET_OS_*` | 无；且该字段在 OSS provider 路径根本不传（§5.2-9） |
| 13 | `Proto` 名 + struct 名 | `GenerateModuleH.js:347` `${hasteModuleName}${alias}`（未清洗）vs `:514` `getEnumName` = `${hasteModuleName}${PascalCase(enum)}` | 同文件同一 C++ 命名空间 | 无 |
| 14 | `hasteModuleName` ↔ `moduleName` | `parsers/utils.js:28-32`（文件名）vs `parsers-commons.js:742`（`TurboModuleRegistry` 实参） | `TurboModuleRegistry.js:19-21` 查找 key | 无 |
| 15 | 组件 Java 包名 `com.facebook.react.viewmanagers` | `GeneratePropsJavaInterface.js:244`、`GeneratePropsJavaDelegate.js:308` | Android 运行时反射 | 无（`codegenConfig.android.javaPackageName` 对组件无效） |
| 16 | `ReactCommon/TurboModule.h` / `ReactCommon/RCTTurboModule.h` / `ReactCommon/JavaTurboModule.h` include 路径 | 生成模板 `GenerateModuleObjCpp/index.js:104`、`GenerateModuleH.js:215`、`GenerateModuleJniH.js:48-49` | CMake/Podspec header search path | 构建期（编译错误），非静默 |

---

## 附：本次覆盖范围的边界

- 已**完整**遍历：`packages/react-native-codegen/src/`（90 个非测试文件）、`packages/react-native/Libraries/TurboModule/`（2 个）、`packages/react-native/src/private/specs_DEPRECATED/`（50 个）、`packages/react-native-codegen/e2e/`（非测试文件 0 个）。
- 为回答 §2/§4/§10 而额外读取（**超出指定目录，但同属该链**）：`packages/react-native/scripts/codegen/**`（28 个非测试文件，2793 行）、`packages/react-native/scripts/generate-codegen-artifacts.js`、`generate-specs-cli.js`、`generate-provider-cli.js`、`scripts/react_native_pods_utils/script_phases.sh`、`packages/gradle-plugin/.../GenerateCodegenArtifactsTask.kt`、`packages/react-native/ReactCommon/react/nativemodule/core/**`（`TurboModule.h`、`JavaTurboModule.h/.cpp`、`RCTTurboModule.h/.mm`）、`packages/react-native/ReactAndroid/src/main/java/com/facebook/react/bridge/BaseJavaModule.java`、`packages/babel-plugin-codegen/index.js`、各 `package.json` 的 `codegenConfig`。
- 未覆盖：`packages/react-native-codegen/src/**/__tests__`（按要求排除）、`packages/react-native/ReactAndroid` 的 Java/Kotlin 手写实现、`ReactCommon` 其余模块、Gradle 插件其余任务。**这些区域中的结论均为「未确认」。**
