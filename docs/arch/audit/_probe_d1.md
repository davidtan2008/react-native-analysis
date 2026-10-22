# Probe D1 — Build & Release Toolchain (verified facts)

Repo: `react-native`
Scope: `scripts/`, `packages/react-native/scripts/` (+ `cocoapods/`, `featureflags/`), `packages/react-native-codegen/` top-level only.
Read-only analysis. Every claim carries `path:line`. "未确认" = not verified.

> **Directory-existence correction.** Three of the requested directories do **not exist**:
> - `packages/react-native/scripts/releases/` — **MISSING**. Releases live at `scripts/releases/` and `scripts/releases-ci/`.
> - `packages/react-native/scripts/circleci/` — **MISSING**. There is no `.circleci/` in the repo at all (`ls .circleci` → "NO .circleci"). CI is GitHub Actions under `.github/`.
> - `packages/react-native/scripts/cxx-api/` — **MISSING**. `cxx-api` lives at `scripts/cxx-api/`.
>
> `packages/react-native-codegen/` has **no** top-level `.js`/`.mjs` files. Top-level files are only `.babelrc`, `build.prettierrc`, `package.json`, `README.md` (verified with `find packages/react-native-codegen -maxdepth 1 -type f`). Its only script is `packages/react-native-codegen/scripts/build.js`.

---

## 1. FILE INVENTORY

### 1.1 Counts per directory (exact commands used)

Canonical exclusion set used everywhere below: `__tests__/`, `__fixtures__/`, `__mocks__/`, `*.test.js`, `*-test.js`, `*-itest.js`, `node_modules/`.

```sh
# per-directory non-test file count + line count
for d in scripts packages/react-native/scripts \
         packages/react-native/scripts/cocoapods \
         packages/react-native/scripts/featureflags; do
  n=$(find "$d" -type f ! -path "*/node_modules/*" ! -path "*/__tests__/*" \
        ! -path "*/__fixtures__/*" ! -name "*.test.js" ! -name "*-test.js" \
        ! -name "*-itest.js" ! -path "*__mocks__*" | wc -l | tr -d ' ')
  l=$(find "$d" -type f ! -path "*/node_modules/*" ! -path "*/__tests__/*" \
        ! -path "*/__fixtures__/*" ! -name "*.test.js" ! -name "*-test.js" \
        ! -name "*-itest.js" ! -path "*__mocks__*" -print0 \
        | xargs -0 wc -l 2>/dev/null | tail -1 | awk '{print $1}')
  echo "$d files=$n lines=$l"
done
```

| Directory | non-test files | non-test lines |
|---|---|---|
| `scripts/` | 461 | 153,904 |
| `packages/react-native/scripts/` (recursive, includes the 3 below) | 151 | 37,069 |
| `packages/react-native/scripts/cocoapods/` | 19 | 3,792 |
| `packages/react-native/scripts/featureflags/` | 32 | 3,449 |

`packages/react-native/scripts/` sub-totals (same exclusion set):

| Sub-dir | files | lines |
|---|---|---|
| `packages/react-native/scripts/spm` | 20 | 15,333 |
| `packages/react-native/scripts/ios-prebuild` | 19 | 6,484 |
| `packages/react-native/scripts/featureflags` | 32 | 3,449 |
| `packages/react-native/scripts/codegen` | 29 | 2,793 |
| `packages/react-native/scripts/cocoapods` | 19 | 3,792 |
| `packages/react-native/scripts/hermes` | 3 | 563 |
| `packages/react-native/scripts/xcode` | 5 | 194 |
| `packages/react-native/scripts/react_native_pods_utils` | 2 | 191 |
| `packages/react-native/scripts/swiftpm` | 5 | 1,021 |

`scripts/` sub-totals (excluding `__tests__/` and `*-test.js`; `api-snapshots/` still included):

| Sub-dir | files | lines |
|---|---|---|
| `scripts/cxx-api` | 334 | 139,326 |
| `scripts/js-api` | 53 | 5,311 |
| `scripts/releases` | 33 | 3,850 |
| `scripts/build` | 6 | 780 |
| `scripts/debugger-frontend` | 2 | 694 |
| `scripts/releases-ci` | 4 | 537 |
| `scripts/release-testing` | 5 | 1,023 |
| `scripts/e2e` | 6 | 491 |
| `scripts/shared` | 4 | 343 |
| `scripts/debugger-shell` | 1 | 159 |
| `scripts/monorepo-tests` | 0 | 0 (only `__tests__/check-packages-test.js`) |

Excluding `scripts/cxx-api/api-snapshots/`, `scripts/` is **31,578 lines / 455 files**.

### 1.2 30 largest files

Command:
```sh
find scripts packages/react-native/scripts -type f ! -path "*/node_modules/*" \
  ! -path "*/__tests__/*" ! -path "*/__fixtures__*" ! -path "*/api-snapshots/*" \
  ! -name "*.test.js" ! -name "*-test.js" ! -name "*-itest.js" ! -path "*__mocks__*" \
  -print0 | xargs -0 wc -l 2>/dev/null | sort -rn | head -31
```
Total across the two trees with that filter: **68,538 lines**.

| # | Lines | Path |
|---:|---:|---|
| 1 | 2911 | `scripts/cxx-api/tests/snapshots/.doxygen.config.template` |
| 2 | 2911 | `scripts/cxx-api/manual_test/.doxygen.config.template` |
| 3 | 2786 | `packages/react-native/scripts/spm/generate-spm-xcodeproj.js` |
| 4 | 2042 | `packages/react-native/scripts/spm/generate-spm-autolinking.js` |
| 5 | 1552 | `packages/react-native/scripts/spm/download-spm-artifacts.js` |
| 6 | 1414 | `packages/react-native/scripts/spm/scaffold-package-swift.js` |
| 7 | 1361 | `packages/react-native/scripts/setup-apple-spm.js` |
| 8 | 1145 | `packages/react-native/scripts/featureflags/ReactNativeFeatureFlags.config.js` |
| 9 | 1014 | `scripts/cxx-api/parser/builders.py` |
| 10 | 1008 | `packages/react-native/scripts/spm/flavored-frameworks.js` |
| 11 | 981 | `packages/react-native/scripts/cocoapods/utils.rb` |
| 12 | 843 | `packages/react-native/scripts/spm/read-podspec.js` |
| 13 | 799 | `packages/react-native/scripts/spm/spm-pbxproj.js` |
| 14 | 786 | `packages/react-native/scripts/spm/spm-utils.js` |
| 15 | 754 | `packages/react-native/scripts/ios-prebuild/headers-config.js` |
| 16 | 752 | `packages/react-native/scripts/spm/__docs__/spm-scripts.md` |
| 17 | 733 | `packages/react-native/scripts/ios-prebuild/headers-verify.js` |
| 18 | 687 | `scripts/cxx-api/tests/test_config.py` |
| 19 | 675 | `packages/react-native/scripts/react_native_pods.rb` |
| 20 | 658 | `packages/react-native/scripts/ios-prebuild/headers-inventory.js` |
| 21 | 609 | `scripts/debugger-frontend/sync-and-build.js` |
| 22 | 583 | `scripts/cxx-api/parser/utils/argument_parsing.py` |
| 23 | 582 | `packages/react-native/scripts/cocoapods/rncore.rb` |
| 24 | 567 | `packages/react-native/scripts/codegen/generate-artifacts-executor/utils.js` |
| 25 | 564 | `packages/react-native/scripts/ios-prebuild/headers-spec.js` |
| 26 | 563 | `packages/react-native/scripts/spm/spm-types.js` |
| 27 | 496 | `packages/react-native/scripts/spm/expand-spm-dependencies.js` |
| 28 | 461 | `packages/react-native/scripts/ios-prebuild/reactNativeDependencies.js` |
| 29 | 454 | `scripts/cxx-api/parser/main.py` |
| 30 | 442 | `scripts/cxx-api/tests/test_excluded_symbol_references.js` → actual file `scripts/cxx-api/tests/test_excluded_symbol_references.py` |

**Committed C++ API snapshots (the single largest block in the repo by bytes/lines), all committed per `git ls-files scripts/cxx-api/api-snapshots/`:**

| Lines | Path |
|---:|---|
| 16204 | `scripts/cxx-api/api-snapshots/ReactAppleDebugCxx.api` |
| 16061 | `scripts/cxx-api/api-snapshots/ReactAppleReleaseCxx.api` |
| 15886 | `scripts/cxx-api/api-snapshots/ReactAppleNewarchCxx.api` |
| 14072 | `scripts/cxx-api/api-snapshots/ReactAndroidDebugCxx.api` |
| 13919 | `scripts/cxx-api/api-snapshots/ReactAndroidReleaseCxx.api` |
| 13688 | `scripts/cxx-api/api-snapshots/ReactAndroidNewarchCxx.api` |
| 10930 | `scripts/cxx-api/api-snapshots/ReactCommonDebugCxx.api` |
| 10921 | `scripts/cxx-api/api-snapshots/ReactCommonReleaseCxx.api` |
| 10754 | `scripts/cxx-api/api-snapshots/ReactCommonNewarchCxx.api` |

Command: `find scripts/cxx-api/api-snapshots -type f -print0 | xargs -0 wc -l | sort -rn`

---

## 2. WHAT EACH SCRIPT ACTUALLY DOES

### 2.1 Root `package.json` scripts (`package.json:8-50`) → file → purpose

Grouped by purpose. "PASSES THROUGH" = runs another tool, not a repo script.

#### Build
| Script | `package.json` line | File | What it does |
|---|---|---|---|
| `build` | `:10` | `scripts/build/build.js` | Babel-transpiles `src/`→`dist/` for the 5 packages in `scripts/build/config.js:40-60`, emits `.js.flow`/`.d.ts` via `flow-api-translator`, type-checks emitted `.d.ts` (`build.js:370-419`). `--prepack` spawns `scripts/build/prepack.js` per package (`build.js:125-145`). |
| `build-android` | `:9` | `./gradlew` | Gradle; no repo script. |
| `clean` | `:12` | `scripts/build/clean.js` | `fs.rmSync` of `packages/<name>/dist` for each configured package (`clean.js:42-47`). |
| `start` | `:37` | `packages/rn-tester` | PASSES THROUGH. |

#### Codegen / API snapshots
| Script | line | File | What it does |
|---|---|---|---|
| `build-types` | `:11` | `scripts/js-api/build-types/index.js` | Flow→TS translation of the whole `react-native` graph into `packages/*/types_generated` (`buildGeneratedTypes.js`), then `@microsoft/api-extractor` rollup into `packages/react-native/ReactNativeApi.d.ts` (`buildApiSnapshot.js:94-123`). `--validate` diffs instead of writes (`buildApiSnapshot.js:99-121`). |
| `js-api-diff` | `:32` | `scripts/js-api/diff-api-snapshot/index.js` | Reads two `.d.ts` snapshot files, prints JSON classification (BREAKING / POTENTIALLY_BREAKING / …). |
| `cxx-api-build` | `:13` | `python -m scripts.cxx-api.parser` | Doxygen + Python parser → `scripts/cxx-api/api-snapshots/*.api`. |
| `cxx-api-validate` | `:14` | `python -m scripts.cxx-api.parser --validate` | Same, into a temp dir, then compares against committed `.api` files; `sys.exit(1)` on mismatch (`__main__.py:351-356`). |

#### Feature flags
| Script | line | File | What it does |
|---|---|---|---|
| `featureflags` | `:31` | `packages/react-native/scripts/featureflags/index.js` | Dispatches `--update` / `--verify-unchanged` / `--print` / `--help`. Defaults to `--update` with a printed notice (`index.js:25-27`). |

#### Release
| Script | line | File | What it does |
|---|---|---|---|
| `set-version` | `:38` | `scripts/releases/set-version.js` | Rewrites every workspace `package.json` version + dep pins, then calls `updateReactNativeArtifacts(version)`. |
| `trigger-react-native-release` | `:49` | `scripts/releases-local/trigger-react-native-release.js` | **TARGET DOES NOT EXIST.** `ls scripts/releases-local/` → "No such file or directory". Broken entry point. |

#### Formatting
| Script | line | File | What it does |
|---|---|---|---|
| `format` / `format-check` | `:24` / `:17` | 6 sub-scripts (below) | Sequential `&&` chain over javascript/cpp/kotlin/java/python/swift. |
| `format-javascript` | `:27` | `prettier` | PASSES THROUGH. Glob: `"./**/*.{cjs,cts,flow,js,jsx,md,mjs,mts,ts,tsx,yaml,yml}"`. |
| `format-cpp` | `:25` | `scripts/clang-format.js` | Runs `fb-dotslash` on `scripts/clang-format`, 30 files/batch, skips `@generated` headers. |
| `format-kotlin` | `:28` | `scripts/format-kotlin.js` | `ktfmt.jar` via JDK ≥17, 100 files/batch. |
| `format-java` | `:26` | `scripts/format-java.js` | `google-java-format` `-all-deps.jar` via JDK ≥17, 30 files/batch. |
| `format-python` | `:29` | `scripts/format-python.js` | `python3 -m ruff format`, auto-`pip install --target` Ruff `0.14.0` into `node_modules/.cache`. |
| `format-swift` | `:30` | `scripts/format-swift.js` | `swift-format` ≥6.3 (or `swift format`), 100 files/batch. |
| `lint` | `:34` | `eslint` | PASSES THROUGH. `--max-warnings 0`. |
| `lint-markdown` | `:33` | `markdownlint-cli2 2>&1` | PASSES THROUGH. Note the literal `2>&1` inside the script string. |
| `shellcheck` | `:36` | `.github/workflow-scripts/analyze_scripts.sh` | shellcheck over all `*.sh`; **exits 1 if shellcheck is not installed** (`analyze_scripts.sh:23-26`). |

#### Testing
| Script | line | File | What it does |
|---|---|---|---|
| `test` | `:46` | `jest` | PASSES THROUGH. |
| `test-ci` | `:40` | `jest` | PASSES THROUGH, with `jest-junit`. |
| `test-ios` | `:43` | `scripts/objc-test.sh` | Kills ports 8081/5555, waits for packager (max 60 attempts, `objc-test.sh:37`), runs Xcode test, curls 3 bundle URLs as smoke checks (`objc-test.sh:121,126,127`). |
| `test-android` | `:39` | `./gradlew` | PASSES THROUGH. |
| `fantom` / `fantom-cli` | `:47`/`:48` | `scripts/fantom.sh` / `scripts/fantom-cli.sh` | `fantom.sh` sets `--max-old-space-size=16384` and runs jest with the Fantom config/sequencer (`fantom.sh:25,40-43`). |
| `test-typescript-legacy` | `:44` | `tsc` | PASSES THROUGH. |
| `test-generated-typescript` | `:45` | `tsc` | PASSES THROUGH. |
| `test-release-local` | `:42` | `scripts/release-testing/test-release-local.js` | End-to-end local release rehearsal. |
| `test-release-local-clean` | `:41` | `scripts/release-testing/test-release-local-clean.js` | Kills port 8081 processes. |

#### CI / misc
| Script | line | File | What it does |
|---|---|---|---|
| `preinstall` | `:35` | `scripts/try-set-hermes-compiler-prebuilt.js` | If `hermes-compiler === "0.0.0"`, runs `yarn workspace react-native add hermes-compiler@latest-v1 --exact` (`:20`) — **mutates `package.json` + `yarn.lock`**. |
| `update-lock` | `:50` | `npx yarn-deduplicate` | PASSES THROUGH. |
| `flow` / `flow-check` | `:16`/`:15` | `flow` | PASSES THROUGH. |

### 2.2 `packages/react-native/package.json` scripts (`packages/react-native/package.json:140-143`)

| Script | line | File | What it does |
|---|---|---|---|
| `prepack` | `:141` | `packages/react-native/scripts/prepack.js` | Copies root `README.md` into the package, then `generateFBReactNativeSpecIOS('.')`. |
| `featureflags` | `:142` | `packages/react-native/scripts/featureflags/index.js` | As §2.1. |

### 2.3 Script entry points **not** in any package.json (invoked directly by build systems / CI)

| File | Invoked by | Line of caller |
|---|---|---|
| `packages/react-native/scripts/generate-codegen-artifacts.js` | `scripts/cxx-api/parser/__main__.py` (`node ./scripts/generate-codegen-artifacts.js`) | `scripts/cxx-api/parser/__main__.py:66` |
| " | `packages/react-native/scripts/react_native_pods_utils/script_phases.sh` | `:100` |
| " | `packages/react-native/scripts/cocoapods/codegen_utils.rb` | `:58` |
| " | `packages/react-native/scripts/spm/spm-utils.js` | `:691` |
| " | `private/core-cli-utils/src/private/apple.js` | `:121` |
| " | `packages/react-native/scripts/ios-prebuild/setup.js` | `:52` |
| `packages/react-native/scripts/generate-specs-cli.js` | `script_phases.sh` | `:62` |
| " | `packages/gradle-plugin/.../GenerateCodegenArtifactsTask.kt` | `:74` |
| `packages/react-native/scripts/run-ci-javascript-tests.js` | `.github/actions/test-js/action.yml` | `:19` |
| `scripts/clean-gha-cache.js` | `.github/workflows/cache-reaper.yml` | `:20` |
| `scripts/debugger-shell/build-binary.js` | `.github/workflows/test-all.yml` | `:625` |
| `scripts/releases/prepare-ios-prebuilds.js` | `.github/workflows/prebuild-ios-dependencies.yml` | `:93,159,162` |
| `scripts/releases/use-hermes-prebuilt.js` | `test-all.yml`, `test-ios-spm-*.yml` | `test-all.yml:489`, `test-ios-spm-helloworld.yml:31`, `test-ios-spm-newapp.yml:31`, `test-ios-spm-rntester.yml:31` |
| `scripts/releases/validate-dotslash-artifacts.js` | `.github/workflows/validate-dotslash-artifacts.yml` | `:50` |
| `scripts/releases-ci/cleanup-maven-staging-repositories.js` | `.github/workflows/publish-npm.yml` | `:119,199` |
| `scripts/releases-ci/publish-updated-packages.js` | `.github/workflows/publish-npm.yml` | `:227` |
| `scripts/e2e/init-project-e2e.js` | `test-all.yml`, `test-ios-spm-newapp.yml` | `test-all.yml:494`, `test-ios-spm-newapp.yml:72` |

---

## 3. CODE GENERATION PIPELINE

### 3.1 Full chain

**Common core (both platforms)**

```
generate-codegen-artifacts.js                       packages/react-native/scripts/generate-codegen-artifacts.js:44
  └─ executor.execute(path, targetPlatform, outputPath, source, true, forceOutputPath)          :44-56
       └─ generate-artifacts-executor/index.js execute()      .../generate-artifacts-executor/index.js:63
            ├─ platform validation ('android' | 'ios' | 'all')                                   :74-84
            ├─ readPkgJsonInDirectory(projectRoot)                                               :86
            ├─ buildCodegenIfNeeded()   ← yarn install && yarn build in react-native-codegen      :88-90
            ├─ [per platform]
            │   ├─ computeBaseOutputPath()  (RCT_SCRIPT_OUTPUT_DIR wins)                          :100-105, 216-240
            │   ├─ readReactNativeConfig()   (autolinking.json, else react-native.config.{js,cjs})  :106-109
            │   ├─ findCodegenEnabledLibraries()                                                 :110-116
            │   ├─ findDisabledLibrariesByPlatform()                                             :121-124
            │   ├─ computeOutputPath()                                                              :129-134
            │   ├─ generateSchemaInfos(libraries, platform)                                       :142
            │   ├─ generateNativeCode(reactCodegenOutputPath, ...)                                :143-151
            │   │    └─ generateNativeCode.js generateCode()       .../generateNativeCode.js:38
            │   │         ├─ shouldSkipGenerationForFBReactNativeSpec()   :45, 88-109
            │   │         ├─ mkdtemp + generateSpecsCLIExecutor.generateSpecFromInMemorySchema   :54-68
            │   │         └─ cpSyncRecursiveIfChanged(tmp/out → outputDir)                       :71-75
            │   ├─ [iOS only, source==='app'] 7 provider generators                                :154-182
            │   └─ cleanupEmptyFilesAndFolders(outputPath)                                         :184
            └─ on any throw: codegenLog(err); process.exitCode = 1                               :186-189
```

`generateSpecsCLIExecutor.generateSpecFromInMemorySchema` (`packages/react-native/scripts/codegen/generate-specs-cli-executor.js:71`) dispatches to `@react-native/codegen`'s generators selected by `GENERATORS` (`:17-30`):

| libraryType | android generators | ios generators |
|---|---|---|
| `all` | `componentsAndroid`, `modulesAndroid`, `modulesCxx` | `componentsIOS`, `modulesIOS`, `modulesCxx` |
| `components` | `componentsAndroid` | `componentsIOS` |
| `modules` | `modulesAndroid`, `modulesCxx` | `modulesIOS`, `modulesCxx` |

Per-library tuning: `assumeNonnull: platform === 'ios'` (`:90`), `includeGetDebugPropsImplementation = libraryName.includes('FBReactNativeSpec')` (`:82-83`).
Android-only post-step: all `.h`/`.cpp` are moved into `${outputDirectory}/jni/react/renderer/components/${libraryName}` (`:99-112`).

**iOS entry points**
1. Xcode build phase, discovery mode: `packages/react-native/scripts/react_native_pods_utils/script_phases.sh:97-102` → `generate-codegen-artifacts.js --targetPlatform ios`.
2. CocoaPods: `packages/react-native/scripts/cocoapods/codegen_utils.rb:58`.
3. `packages/react-native/scripts/ios-prebuild/setup.js:52`.
4. SPM: `packages/react-native/scripts/spm/spm-utils.js:691`.

**Android entry point**
- `packages/gradle-plugin/react-native-gradle-plugin/src/main/kotlin/com/facebook/react/tasks/GenerateCodegenArtifactsTask.kt:69-87` shells out to `scripts/generate-specs-cli.js --platform android`. Task name `generateCodegenArtifactsFromSchema` (`ReactPlugin.kt:212`).

**C++ API snapshot codegen (pre-step of the C++ snapshot pipeline)**
`scripts/cxx-api/parser/__main__.py:53-84` `build_codegen()` runs `generate-codegen-artifacts.js` once per unique platform (`:168-178`) into a temp dir, then adds that dir to the Doxygen include path (`:108-109`).

### 3.2 Generated artifact directories and what generates into them

| Output directory | Generator | Line |
|---|---|---|
| `packages/react-native/React/FBReactNativeSpec/` | `CORE_LIBRARIES_WITH_OUTPUT_FOLDER.FBReactNativeSpec.ios`; also `generateFBReactNativeSpecIOS` at prepack | `generate-artifacts-executor/constants.js:35-39`; `generateFBReactNativeSpecIOS.js:38` |
| `packages/react-native/ReactAndroid/build/generated/source/codegen` | `constants.js:40-47` (`FBReactNativeSpec.android`) | `constants.js:40-47` |
| `<base>/android/app/build/generated/source/codegen` | `defaultOutputPathForAndroid` | `generate-artifacts-executor/index.js:261-271` |
| `<base>/build/generated/ios` and `<base>/build/generated/ios/ReactCodegen` | `defaultOutputPathForIOS`; `reactCodegenOutputPath` | `index.js:273-275`, `index.js:136-139` |
| `<base>/build/generated/autolinking/autolinking.json` | **read** by codegen, **written** by `scripts/cocoapods/autolinking.rb` | read: `utils.js:106-109`; writer noted in comment `utils.js:104` |
| `packages/react-native/types_generated/`, `packages/*/types_generated/` | `scripts/js-api/build-types/buildGeneratedTypes.js` | `buildGeneratedTypes.js:142-152` |
| `packages/react-native/ReactNativeApi.d.ts` | `scripts/js-api/build-types/buildApiSnapshot.js` | `buildApiSnapshot.js:94-123` |
| `scripts/cxx-api/api-snapshots/*.api` | `scripts/cxx-api/parser/__main__.py:135-140` | |
| `packages/react-native-codegen/lib/` | `packages/react-native-codegen/scripts/build.js` (`src`→`lib`, plus `*.js.flow`) | `build.js:38-39, 85-96` |
| feature-flag outputs (6 dirs) | `packages/react-native/scripts/featureflags/update.js:21-60` | see §5 |
| `packages/react-native/third-party/`, `*.xcframework` | `packages/react-native/scripts/ios-prebuild/*` | `ios-prebuild/README.md:52-56` |
| `packages/react-native/React/includes/` | `ios-prebuild/headers-compose.js` (gitignored) | `.gitignore:136` |

### 3.3 Committed vs build-time (from `.gitignore`)

**Gitignored (build-time only):**

| Line | Pattern | Meaning |
|---|---|---|
| `.gitignore:139` | `/packages/react-native/React/FBReactNativeSpec/` | iOS core spec — generated at prepack |
| `.gitignore:140` | `/packages/react-native-codegen/lib` | codegen transpile output |
| `.gitignore:141` | `/packages/react-native-codegen/tmp/` | |
| `.gitignore:178` | `/packages/**/types_generated/` | generated TS types |
| `.gitignore:184` | `/packages/react-native/**/api/xml` | Doxygen XML |
| `.gitignore:185` | `/packages/react-native/**/api/codegen` | cxx-api codegen scratch |
| `.gitignore:186` | `/packages/react-native/**/.doxygen.config.*.generated` | generated Doxygen config |
| `.gitignore:187` | `/scripts/cxx-api/codegen` | |
| `.gitignore:26,33,34` | `/build/`, `packages/react-native/build/`, `ReactAndroid/build/` | |
| `.gitignore:143` | `/**/RCTThirdPartyFabricComponentsProvider.*` | codegen provider |
| `.gitignore:125` | `/packages/**/RCTLegacyInteropComponents.mm` | codegen provider |
| `.gitignore:136` | `/packages/react-native/React/includes/` | SPM/prebuild headers |
| `.gitignore:150-152` | `packages/react-native/sdks/{hermes,hermesc}` | downloaded SDKs |
| `.gitignore:155,157` | `/packages/react-native/third-party/`, `*.xcframework` | iOS prebuilds |

**Committed generated output (verified with `git ls-files`):**
- `scripts/cxx-api/api-snapshots/*.api` — 9 files, all tracked.
- `packages/react-native/ReactAndroid/api/ReactAndroid.api` (420,648 bytes) — tracked (`git ls-files --error-unmatch` succeeded).
- All 4 feature-flag output sets — tracked (files exist on disk with `@generated` headers and `@generated SignedSource<<…>>` stamps).
- Version files: `Libraries/Core/ReactNativeVersion.js`, `ReactCommon/react/utils/ReactNativeVersion.h`, `React/Base/RCTVersion.m`, `.../systeminfo/ReactNativeVersion.kt`, `ReactAndroid/gradle.properties:1`.
- `packages/react-native/scripts/codegen/__tests__/__snapshots__/generate-artifacts-executor-test.js.snap` — tracked, and **mutated during release** (see §4.4).

### 3.4 Scripts that validate generated output is in sync

| What it validates | Script | Command | What it compares |
|---|---|---|---|
| Feature flags | `packages/react-native/scripts/featureflags/generateFiles.js:57-86` | `yarn featureflags --verify-unchanged` | Re-generates all 27 files in memory, `fs.readFileSync` each, string-compares; throws listing changed paths (`:79-82`). |
| JS public API | `scripts/js-api/build-types/buildApiSnapshot.js:99-121,132-163` | `yarn build-types --validate` | Regenerated api-extractor rollup vs on-disk `packages/react-native/ReactNativeApi.d.ts`; `jest-diff` unified diff; `process.exitCode = 1` if different. |
| Generated TS types compile | `packages/react-native/package.json` + `package.json:45` | `yarn test-generated-typescript` | `tsc -p packages/react-native/__typetests__/tsconfig.json` type-checks `types_generated`. |
| C++ public API | `scripts/cxx-api/parser/snapshot_diff.py:34-89` | `yarn cxx-api-validate` | Byte-compare of each generated `*.api` vs committed one; unified diff on mismatch; `sys.exit(1)` (`__main__.py:356`). |
| Codegen output snapshot | `packages/react-native/scripts/codegen/__tests__/__snapshots__/generate-artifacts-executor-test.js.snap` | Jest | jest snapshot; the release script rewrites the version strings inside it in place (`scripts/releases/set-rn-artifacts-version.js:127-145`). |

**`scripts/cxx-api` has a documented-but-unimplemented key**: `scripts/cxx-api/README.md:76` documents `private_directories` and promises "a warning is printed to help catch accidental API exposure". `grep -rn "private_directories" scripts/` matches **only** that README line; `scripts/cxx-api/config.yml` has no such key and `scripts/cxx-api/parser/config.py:28-41` has no such dataclass field. Dead documentation.

---

## 4. VERSIONING & RELEASE

### 4.1 Every place a version number is defined or computed

| file:line | Value / expression | Role |
|---|---|---|
| `package.json:4` | `"version": "1000.0.0"` | monorepo root version |
| `packages/react-native/package.json:3` | `"version": "1000.0.0"` | `react-native` package version |
| `packages/react-native/package.json:165` | `"hermes-compiler": "0.0.0"` | sentinel placeholder, resolved by `preinstall` |
| `scripts/releases/set-version.js:84` | `'1000.0.0'` | `--skipReactNativeVersion` pins to this |
| `scripts/releases/utils/npm-utils.js:55` | `` `1000.0.0-${shortCommit}` `` | dry-run version |
| `scripts/releases-ci/publish-npm.js:113` | `projectInfo.version === '1000.0.0'` | dry-run no-op guard |
| `scripts/releases/utils/npm-utils.js:44-46` | `getPackageVersionStrByTag('react-native','next')` then `parseInt(minor,10)+1` | main version derived from npm `next` tag |
| `scripts/releases/utils/npm-utils.js:51` | `currentCommit.slice(0, 9)` | 9-char short SHA |
| `scripts/releases/utils/npm-utils.js:62-67` | `` `${mainVersion}-nightly-${dateIdentifier}-${shortCommit}` `` where `dateIdentifier` = `new Date().toISOString().slice(0,-14).replace(/[-]/g,'')` | nightly version |
| `scripts/releases/utils/npm-utils.js:82` | `process.env.GITHUB_REF_NAME` | release version source |
| `scripts/releases/utils/npm-utils.js:103` | `` `${major}.${minor}-stable` `` | release-branch npm tag |
| `scripts/releases/utils/npm-utils.js:108-113` | `patch === '0' ? 'next' : '--no-tag'` | prerelease npm tag |
| `scripts/releases/utils/version-utils.js:11` | `const VERSION_REGEX = /^v?((\d+)\.(\d+)\.(\d+)(?:-(.+))?)$/;` | version grammar |
| `scripts/releases/utils/version-utils.js:124-157` | `isStableRelease` (major must be `'0'`), `isStablePrerelease` (requires `rc.`/`rc-`/`^(\d{8})-(\d{4})$`), `isNightly` (`0.0.0` or contains `nightly`), `isMain` (`1000.0.0`) | validation predicates |
| `scripts/releases/utils/version-utils.js:159-161` | `branch.endsWith('-stable')` | `isReleaseBranch` |
| `packages/react-native/ReactAndroid/gradle.properties:1` | `VERSION_NAME=1000.0.0` | Android artifact version |
| `packages/react-native/scripts/spm/download-spm-artifacts.js:144` | `const UNPUBLISHED_MAVEN_VERSION = '1000.0.0';` | SPM sentinel |
| `packages/react-native/scripts/spm/download-spm-artifacts.js:349,1183,1187,1202` | `'1000.0.0'` / `'nightly'` | version routing |
| `packages/react-native/scripts/spm/spm-utils.js:371` | `if (v === '1000.0.0')` | version routing |
| `packages/react-native/scripts/try-set-hermes-compiler-prebuilt.js:18` | `hermesCompilerVersion === '0.0.0'` | hermes placeholder test |
| `scripts/releases/use-hermes-prebuilt.js:20` / `use-hermes-nightly.js:20` | `hermesCompilerVersion !== '0.0.0'` | hermes placeholder test |
| `scripts/build/babel/node.config.js:13` | `const TARGET_NODE_VERSION = '18';` | Babel build target (stale vs `engines.node` at `packages/react-native/package.json:24` which requires `^22.13.0 \|\| ^24.3.0 \|\| >= 26.0.0`) |

### 4.2 Version propagation JS → iOS → Android

Writers — `scripts/releases/set-rn-artifacts-version.js:updateReactNativeArtifacts` (`:76-85`):

| Target | Path | Template | Line |
|---|---|---|---|
| Kotlin (Android) | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/systeminfo/ReactNativeVersion.kt` | `templates/ReactNativeVersion.kt-template.js` | `set-rn-artifacts-version.js:93-99` |
| ObjC (Apple) | `packages/react-native/React/Base/RCTVersion.m` | `templates/RCTVersion.m-template.js` | `:100-103` |
| C++ (common) | `packages/react-native/ReactCommon/react/utils/ReactNativeVersion.h` | `templates/ReactNativeVersion.h-template.js` | `:104-110` |
| JS | `packages/react-native/Libraries/Core/ReactNativeVersion.js` | `templates/ReactNativeVersion.js-template.js` | `:111-117` |
| Gradle | `packages/react-native/ReactAndroid/gradle.properties` (`VERSION_NAME=`) | inline regex | `:155-162` |
| Jest snapshot | `packages/react-native/scripts/codegen/__tests__/__snapshots__/generate-artifacts-executor-test.js.snap` | regex `"/\d+\.\d+\.\d+(-rc\.\d+)?/g` | `:121-153` |

Each template emits a `@generated by scripts/releases/set-version.js` marker (`ReactNativeVersion.kt-template.js:21`, `.h-template.js:21`, `.m-template.js:21`, `.js-template.js:23`).

Readers (each file that consumes the version):
- `packages/react-native/Libraries/Core/ReactNativeVersion.js:29-32` (`major/minor/patch/prerelease`), `:35` (`getVersionString`), `:44-48` (deprecated `version` export).
- `packages/react-native/ReactCommon/react/utils/ReactNativeVersion.h:31-46` — `REACT_NATIVE_VERSION_MAJOR/MINOR/PATCH` macros + `constexpr ReactNativeVersionType ReactNativeVersion`. (Grep of the file for `version|minor|major|patch|prerelease` returned only the `@generated` line, confirming the macros are `#define REACT_NATIVE_VERSION_*` and struct fields named `Major/Minor/Patch/Prerelease`.)
- `packages/react-native/React/Base/RCTVersion.m:12-15` — `RCTVersionMajor/Minor/Patch/Prerelease` constants; `RCTGetReactNativeVersion()`.
- `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/modules/systeminfo/ReactNativeVersion.kt:14` — `mapOf("major" to 1000, "minor" to 0, "patch" to 0, "prerelease" to null)`.
- `packages/react-native/ReactAndroid/gradle.properties:1` — `VERSION_NAME=1000.0.0`, consumed by Gradle (未确认: which build.gradle reads it — not in scope).
- `scripts/releases/utils/npm-utils.js:44,82,91` — version derived from npm / `GITHUB_REF_NAME`.
- `scripts/releases/set-rn-artifacts-version.js:160` — writes `VERSION_NAME=`.

Hermes version propagation (separate axis): `scripts/releases/utils/hermes-utils.js:36-38` reads npm tag `hermes-compiler@latest-v1`; `:75-79` writes it into every workspace `package.json` deps; `:85-87` writes `sdks/hermes-engine/version.properties` as `HERMES_VERSION_NAME=<v>`; `:45-59` flips `react.internal.useHermesStable/Nightly` in the **repo-root** `gradle.properties` (path computed as `packages/react-native/../../gradle.properties`, `:28-33`).

### 4.3 Scripts that mutate files in place during release

| Script | Mutations |
|---|---|
| `scripts/shared/monorepoUtils.js:139-172` `updatePackageJson` | Rewrites `package.json` `version` + all matching entries in `dependencies`/`devDependencies`/`peerDependencies`. `:162-165` preserves `'*'` wildcards. |
| `scripts/shared/monorepoUtils.js:177-185` `writePackageJson` | `JSON.stringify(packageJson, null, 2) + '\n'` — **key order follows the parsed object, and `publishConfig` is deleted by `scripts/build/prepack.js:38`** (not by this path). |
| `scripts/releases/set-version.js:103-110` | `Promise.all(packagesToUpdate.map(pkg => updatePackageJson(...)))` + `updateReactNativeArtifacts(version)`. |
| `scripts/releases/set-rn-artifacts-version.js:87-119` | Overwrites 4 version source files from templates. |
| `scripts/releases/set-rn-artifacts-version.js:121-153` | Overwrites the Jest snapshot file `generate-artifacts-executor-test.js.snap` via regex on version strings. |
| `scripts/releases/set-rn-artifacts-version.js:155-162` | Rewrites `VERSION_NAME=` line of `ReactAndroid/gradle.properties`. |
| `scripts/releases/utils/hermes-utils.js:45-59` | Rewrites root `gradle.properties` (stable/nightly Hermes flags). |
| `scripts/releases/utils/hermes-utils.js:75-88` | Rewrites every workspace `package.json` + `sdks/hermes-engine/version.properties`. |
| `scripts/releases/create-release-commit.js:56-77` | `setVersion` + `setStableHermesForReleaseBranch` + `writeReleaseAssetUrlsToDotSlashFiles`, then `git commit -a` and `git tag -a v<version>` via `execSync`. |
| `scripts/build/prepack.js:33-40` | Copies `publishConfig.*` into the root of `package.json`, then `delete contents.publishConfig`. |
| `packages/react-native/scripts/prepack.js:18-19` | `fs.copyFileSync('../../README.md', './README.md')` + FBReactNativeSpec generation. |
| `scripts/releases/write-dotslash-release-asset-urls.js:149` | Rewrites dotslash files with GitHub release-asset URLs. |
| `scripts/try-set-hermes-compiler-prebuilt.js:20` | `yarn workspace react-native add hermes-compiler@latest-v1 --exact` — mutates `packages/react-native/package.json` and `yarn.lock` on every `yarn install`. |

**CHANGELOG / changelog fragments:** No in-scope script writes `CHANGELOG.md` or consumes a changelog-fragment directory. `scripts/releases/*` contains no CHANGELOG reference (verified by grep across `scripts/`). The root `CHANGELOG.md` is compiled at release time per `AGENTS.md:88`. Generation lives outside `scripts/` (`.github/workflow-scripts/generateChangelog.js`, 3,377 bytes, invoked by `.github/workflows/generate-changelog.yml`).

---

## 5. FEATURE FLAGS

### 5.1 Config and generated accessors

**Source of truth:** `packages/react-native/scripts/featureflags/ReactNativeFeatureFlags.config.js` — **1,145 lines**.
Header comment `:16-21`:
```
 * This is the source of truth for React Native feature flags.
 *
 * If you modify this file, you need to update all the generated files
 * running the following script from the repo root:
 *   yarn featureflags --update
```
Entry point: `packages/react-native/scripts/featureflags/index.js:11-46` → `update.js` → `generateFiles.js:19-92`.

Flag counts (measured with `grep -c "defaultValue:"` / `sed -n` slices):
- `common`: **88** definitions (lines 61-998).
- `jsOnly`: **13** definitions (lines 999-end; names listed in §5.4).
- `testDefinitions`: 3 (`commonTestFlag`, `commonTestFlagWithoutNativeImplementation`, `jsOnlyTestFlag`), lines 24-58, all `ossReleaseStage: 'none'`.
- **Total `defaultValue:` occurrences: 104.**

**Generated outputs — 3 languages, 5 output roots, 22 files.** Paths fixed in `packages/react-native/scripts/featureflags/update.js:21-60`.

| Lang | Generator file | Output path |
|---|---|---|
| JavaScript | `generateJavaScriptModules.js:26-27` | `packages/react-native/src/private/featureflags/ReactNativeFeatureFlags.js` |
| JavaScript | `generateJavaScriptModules.js:28-29` | `packages/react-native/src/private/featureflags/specs/NativeReactNativeFeatureFlags.js` |
| C++ (TurboModule spec) | `generateJavaScriptModules.js:30-31` | `packages/react-native/ReactCommon/react/nativemodule/featureflags/NativeReactNativeFeatureFlags.h` |
| C++ | `generateJavaScriptModules.js:32-33` | `.../nativemodule/featureflags/NativeReactNativeFeatureFlags.cpp` |
| C++ | `generateCommonCxxModules.js:29-30` | `packages/react-native/ReactCommon/react/featureflags/ReactNativeFeatureFlags.h` |
| C++ | `generateCommonCxxModules.js:31-32` | `.../featureflags/ReactNativeFeatureFlags.cpp` |
| C++ | `generateCommonCxxModules.js:33-34` | `.../featureflags/ReactNativeFeatureFlagsAccessor.h` |
| C++ | `generateCommonCxxModules.js:35-36` | `.../featureflags/ReactNativeFeatureFlagsAccessor.cpp` |
| C++ | `generateCommonCxxModules.js:37-38` | `.../featureflags/ReactNativeFeatureFlagsDefaults.h` |
| C++ | `generateCommonCxxModules.js:39-45` | `.../featureflags/ReactNativeFeatureFlagsOverridesOSSExperimental.h` |
| C++ | `generateCommonCxxModules.js:46-47` | `.../featureflags/ReactNativeFeatureFlagsOverridesOSSCanary.h` |
| C++ | `generateCommonCxxModules.js:48-49` | `.../featureflags/ReactNativeFeatureFlagsProvider.h` |
| C++ | `generateCommonCxxModules.js:50-51` | `.../featureflags/ReactNativeFeatureFlagsDynamicProvider.h` |
| Kotlin | `generateAndroidModules.js:30-31` | `packages/react-native/ReactAndroid/src/main/java/com/facebook/react/internal/featureflags/ReactNativeFeatureFlags.kt` |
| Kotlin | `generateAndroidModules.js:32-33` | `.../ReactNativeFeatureFlagsCxxAccessor.kt` |
| Kotlin | `generateAndroidModules.js:34-35` | `.../ReactNativeFeatureFlagsLocalAccessor.kt` |
| Kotlin | `generateAndroidModules.js:36-37` | `.../ReactNativeFeatureFlagsCxxInterop.kt` |
| Kotlin | `generateAndroidModules.js:38-39` | `.../ReactNativeFeatureFlagsDefaults.kt` |
| Kotlin | `generateAndroidModules.js:40-46` | `.../ReactNativeFeatureFlagsOverrides_RNOSS_Experimental_Android.kt` |
| Kotlin | `generateAndroidModules.js:47-50` | `.../ReactNativeFeatureFlagsOverrides_RNOSS_Canary_Android.kt` |
| Kotlin | `generateAndroidModules.js:51-52` | `.../ReactNativeFeatureFlagsProvider.kt` |
| JNI C++ | `generateAndroidModules.js:53-54` | `packages/react-native/ReactAndroid/src/main/jni/react/featureflags/JReactNativeFeatureFlagsCxxInterop.h` |
| JNI C++ | `generateAndroidModules.js:55-56` | `.../jni/react/featureflags/JReactNativeFeatureFlagsCxxInterop.cpp` |

All 22 confirmed present on disk. `packages/react-native/scripts/featureflags/utils.js:109-117` stamps every file with `DO_NOT_MODIFY_COMMENT`, which names the config path and the exact regeneration command.

`skipNativeAPI: true` flags are filtered out of native output at `generateFiles.js:35-39`; exactly 1 flag uses it (`commonTestFlagWithoutNativeImplementation`, config `:44`).

**Orphan generated file:** `packages/react-native/ReactAndroid/.../ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android.kt` (365 bytes) exists on disk but **is not produced by any generator** — `generateAndroidModules.js` emits only `experimental` and `canary` variants (`:40-52`). Its header (`:1-7`) has **no `@generated` marker and no `DO_NOT_MODIFY_COMMENT`**, confirming it is hand-maintained. `grep -rn "RNOSS_Stable" packages/react-native/scripts/featureflags/` matches only the template's `:27` early-return, not an emission site.

### 5.2 How a flag's default value is decided

Semantics are stated verbatim in `packages/react-native/scripts/featureflags/types.js:19-23`:
```
 * OSSReleaseStageValue is used to determine the value of a feature flag in different release stages:
 * - none: the value of the feature flag will be `defaultValue` on all releases.
 * - experimental: the value of the feature flag will be `expectedReleaseValue` on experimental releases and `defaultValue` on canary and stable releases.
 * - canary: the value of the feature flag will be `expectedReleaseValue` on experimental and canary releases and `defaultValue` on stable releases.
 * - stable: the value of the feature flag will be `expectedReleaseValue` on all releases.
```
Only the **`experimental`** and **`canary`** stages get generated override classes/headers (`generateAndroidModules.js:40-50`, `generateCommonCxxModules.js:39-47`); there is no generated `stable` override on either platform.

Value/type mapping helpers in `packages/react-native/scripts/featureflags/utils.js`:

| Helper | boolean | number | string | Line |
|---|---|---|---|---|
| `getCxxTypeFromDefaultValue` | `bool` | `double` | `std::string` | `:13-26` |
| `getCxxValueFromDefaultValue` | `.toString()` | `X` → `X.0` | `JSON.stringify` | `:28-44` (comment `:36-38`) |
| `getCxxFollyDynamicAccessorFromDefaultValue` | `getBool` | `getDouble` | `getString` | `:46-59` |
| `getCxxJNITypeFromDefaultValue` | `jboolean` | `jdouble` | `jstring` | `:61-74` |
| `getKotlinTypeFromDefaultValue` | `Boolean` | `Double` | `String` | `:76-89` |
| `getKotlinValueFromDefaultValue` | `.toString()` | `X` → `X.0` | `JSON.stringify` | `:91-107` |

Each has `default: throw new Error(\`Unsupported default value type: ${typeof defaultValue}\`)`.

### 5.3 Every distinct config key

Top-level of a `FeatureFlagDefinitions`: `common`, `jsOnly` (`types.js:13-16`).

Per-flag (`CommonFeatureFlagConfig`, `types.js:28-37`; `JsOnlyFeatureFlagConfig`, `types.js:43-49`):

| Key | Type | Applies to | Line |
|---|---|---|---|
| `defaultValue` | `boolean \| number \| string` | both | `:31`, `:46` |
| `metadata` | `FeatureFlagMetadata<TValue>` | both | `:32`, `:47` |
| `ossReleaseStage` | `'none' \| 'experimental' \| 'canary' \| 'stable'` | both | `:33`, `:48` |
| `skipNativeAPI` | `true` (optional) | `common` only | `:36` |

`metadata` is a discriminated union on `purpose` (`types.js:55-72`):

| Key | `purpose: 'experimentation'` | `purpose: 'operational' \| 'release'` | Line |
|---|---|---|---|
| `purpose` | ✓ | ✓ | `:59`, `:69` |
| `dateAdded` | ✓ (string; comment `:60-63`) | ✗ | `:64` |
| `description` | ✓ | ✓ | `:65`, `:70` |
| `expectedReleaseValue` | ✓ | ✓ | `:66`, `:71` |

Observed distributions (measured with `grep -o | sort | uniq -c`):
- `ossReleaseStage`: `none` 88, `canary` 9, `experimental` 4, `stable` 3.
- `purpose`: `experimentation` 76, `release` 17, `operational` 11.

### 5.4 jsOnly flag names (measured, `sed -n '999,$p' | grep "^    [a-zA-Z]*: {"`)

`animatedDeferStartOfTimingAnimations`, `animatedForceNativeDriver`, `animatedKeepListenersOnDetach`, `animatedShouldSyncValueBeforeStartCallback`, `deferFlatListFocusChangeRenderUpdate`, `enableNativeEventTargetEventDispatching`, `externalElementInspectionEnabled`, `fixVirtualizeListCollapseWindowSize`, `isLayoutAnimationEnabled`, `shouldUseAnimatedObjectForTransform`, `shouldUseRemoveClippedSubviewsAsDefaultOnIOS`, `shouldUseSetNativePropsInFabric` — and one 13th whose entry spans more lines (`sed` offset +13 ⇒ `animatedShouldSyncValueBeforeStartCallback` region; exact 13th name 未确认 without re-reading lines 1040-1050).

---

## 6. FAILURE MODES & EXIT CODES

### 6.1 Explicit `process.exit` / `exitCode` / `sys.exit`

Command used:
```sh
grep -rn -E "process\.exit\(|process\.exitCode" scripts --include="*.js" \
  | grep -v node_modules | grep -v "/__tests__/"
grep -rn -E "process\.exit\(|process\.exitCode" packages/react-native/scripts \
  | grep -v node_modules | grep -v "/__tests__/" | grep -v "__fixtures__"
grep -rn -E "sys\.exit|exit\(" scripts --include="*.py" | grep -v /tests/
```

**`scripts/` (JS):**

| file:line | Code | Condition |
|---|---|---|
| `scripts/format-python.js:106` | `process.exit(format.status)` | `runRuff` after `ruff format [--check] .` — **unreachable when the probe fails** (`return false` at `:98` exits 0) |
| `scripts/format-python.js:202` | `process.exit(format.status)` | final `python3 -m ruff format` |
| `scripts/format-kotlin.js:76` | `process.exit(result.status ?? 1)` | any ktfmt batch non-zero |
| `scripts/format-java.js:103` | `process.exitCode = exitStatus` | aggregated batch status |
| `scripts/clang-format.js:118` | `process.exitCode = exitStatus` | aggregated batch status |
| `scripts/format-swift.js:143` | `process.exitCode = exitStatus` | aggregated batch status |
| `scripts/js-api/diff-api-snapshot/index.js:42` | `process.exitCode = 0` | `--help` |
| `scripts/js-api/diff-api-snapshot/index.js:54` | `process.exitCode = 1` | catch around `diffApiSnapshot` |
| `scripts/js-api/build-types/buildApiSnapshot.js:82` | `process.exitCode = 1` | `!extractorResult.succeeded` |
| `scripts/js-api/build-types/buildApiSnapshot.js:118` | `process.exitCode = 1` | `validateSnapshots` returned changed |
| `scripts/js-api/build-types/index.js:63` | `process.exitCode = 0` | `--help` |
| `scripts/js-api/build-types/buildGeneratedTypes.js:69` | `process.exitCode = 1` | `allErrors.length > 0` |
| `scripts/build/build.js:66` | `process.exitCode = 0` | `--help` |
| `scripts/build/build.js:83` | `process.exitCode = ok ? 0 : 1` | **`ok` is `let ok = true` at `:78` and never reassigned — always 0.** Real failure arrives as a throw from `buildPackage` (`:154`) → caught at `:430-437` → `process.exitCode = 1`. Vestigial variable. |
| `scripts/build/build.js:436` | `process.exitCode = 1` | top-level `.catch` |
| `scripts/build/clean.js:38,49` | `process.exitCode = 0` | `--help`; end of run |
| `scripts/build/prepack.js:29` | `process.exitCode = 1` | cwd is not under `packages/` |
| `scripts/debugger-frontend/sync-and-build.js:64` | `process.exitCode = 0` | success path |
| `scripts/debugger-frontend/sync-and-build.js:73` | `process.exitCode = 1` | failure path |
| `scripts/debugger-shell/build-binary.js:153` | `process.exitCode = 1` | 未确认 (not read) |
| `scripts/run-ci-javascript-tests.js:88` | `process.exitCode = 1` | `e instanceof ExecError` — otherwise rethrown (`:90`) |
| `scripts/release-testing/utils/github-actions-utils.js:154` | `process.exit(1)` | no `Test All` workflow run found |
| `scripts/release-testing/utils/github-actions-utils.js:227` | `process.exit(1)` | no artifact with that name |
| `scripts/release-testing/utils/testing-utils.js:233` | `process.exit(exitCode)` | `set-rn-artifacts-version.js` exited non-zero |
| `scripts/release-testing/test-release-local.js:349` | `process.exit(1)` | 未确认 |
| `scripts/e2e/init-project-e2e.js:83` | `process.exit(0)` | **`process.exit(0)` inside the `spawn` memory-leak TODO block — hard exit 0** |

**Python:**
- `scripts/cxx-api/parser/__main__.py:356` — `sys.exit(1)` when `validate_snapshots(...)` returns falsy.
- `scripts/cxx-api/parser/input_filters/main.py:28` — `sys.exit(1)` (filter failure; propagates as Doxygen nonzero → `run_doxygen` raises `RuntimeError` at `doxygen.py:108`).

**`packages/react-native/scripts/`:** 33 `process.exitCode` sites. Notable: `:188` `generate-artifacts-executor/index.js` (codegen catch → 1); `packages/react-native/scripts/compose-source-maps.js:31` **`process.exitCode = -1`** (no args; Node coerces `-1` to exit status 255); `packages/react-native/scripts/ios-prebuild.js:88`; `packages/react-native/scripts/setup-apple-spm.js:491,730,839,868,891,915,1129,1222,1295,1308,1333-1334` (=1) and `:1048,1176,1208,1278` (=2, Xcode build-phase hard error); `packages/react-native/scripts/spm/generate-spm-autolinking.js:1288` (=1), `:2019` (=2); `packages/react-native/scripts/spm/sync-spm-autolinking.js:161` (=2), `:165` (=1); `packages/react-native/scripts/spm/spm-utils.js:107`; `packages/react-native/scripts/spm/generate-spm-package.js:306`; `packages/react-native/scripts/spm/download-spm-artifacts.js:1523`.

Total `throw new Error` in `packages/react-native/scripts` non-test JS files: **193** (measured `grep -rn "throw new Error" … | wc -l`).

### 6.2 Silent failures — prints an error/warning and still exits 0 (HIGH VALUE)

| # | file:line | Behaviour | Why it matters |
|---|---|---|---|
| 1 | `scripts/build/build.js:78,83` | `let ok = true;` … `process.exitCode = ok ? 0 : 1;` — `ok` is never reassigned | The `ok` branch is dead. Failures still surface via the throw at `:154`, so this is latent, not an active false-pass. |
| 2 | `scripts/format-python.js:79-84,86-92,116-120,137-141,166-169,181-187` | 6 distinct "Skipping Python formatting …" warnings, each followed by `return;` from `main()` — **no `process.exit` / `exitCode`** | `yarn format-check-python` exits **0** with Python unformatted. `package.json:22` chains it into `format-check` with `&&`, so the whole gate passes. |
| 3 | `scripts/format-kotlin.js:47-51` | `warnMissingJava('Kotlin'); return;` | Exits 0 without formatting any Kotlin. |
| 4 | `scripts/format-java.js:65-69` | `warnMissingJava('Java'); return;` | Exits 0 without formatting any Java. |
| 5 | `scripts/format-swift.js:107-110` | `if (swiftFormat == null) { return; }` after the `:98-101` warning | Exits 0 without formatting any Swift. |
| 6 | `scripts/format-utils.js:73-80` `warnMissingJava` | The shared warner itself; every caller of it (3, 4) exits 0 | |
| 7 | `scripts/shared/isGitRepo.js:25-28` | `console.error(...)` then `return false` | Used by `buildApiSnapshot.js:151` to pick the rerun hint string; a git failure silently changes the printed instruction. |
| 8 | `packages/react-native/scripts/codegen/generate-artifacts-executor/utils.js:110-118` | `codegenLog('Could not find generated autolinking output at: …')` then `return null` | Codegen falls back to its own library discovery; no error signalled. |
| 9 | `packages/react-native/scripts/codegen/generate-artifacts-executor/utils.js:139-148` | config `require()` failure logged via `codegenLog` then loop continues | A broken `react-native.config.js` is downgraded to a log line. |
| 10 | `packages/react-native/scripts/codegen/generate-artifacts-executor/utils.js:150-155` | `codegenLog('Could not find any React Native config …'); return {}` | |
| 11 | `scripts/cxx-api/parser/main.py:414-416` | `print(f"Detail file not found at {detail_file}"); continue` | A missing Doxygen compound file is skipped, producing a **partial** snapshot that will differ from the committed baseline — caught only indirectly by `--validate`. |
| 12 | `scripts/cxx-api/parser/main.py:445-446` | `print(f"Unknown compound kind: {kind}")` | Same class of issue. |
| 13 | `scripts/cxx-api/parser/main.py:105-107` | `print(f"Unknown section kind: …")` | Same class of issue. |
| 14 | `scripts/cxx-api/parser/snapshot_diff.py:35-38` | `if not os.path.isdir(committed_dir): print('Skipping comparison (no baseline to compare against)'); return True` | **Validation passes when the baseline directory is absent** (e.g. wrong `--snapshot-dir`). |
| 15 | `scripts/cxx-api/parser/snapshot_diff.py:43-46` | `if not committed_files: … return True` | Same. |
| 16 | `scripts/cxx-api/parser/snapshot_diff.py:64-66` | `if filename not in committed_set: print('OK: … (no committed baseline)'); continue` | **A newly generated snapshot view is never a failure.** Adding a new API view to `config.yml` ships with no baseline and passes CI silently. |
| 17 | `scripts/cxx-api/parser/doxygen.py:105-108` | Doxygen nonzero raises only after `if verbose: print(...)`; in `--validate` mode `verbose = not args.validate` (`__main__.py:290`) → `verbose` is False | The `Doxygen finished with error: …` detail line is suppressed in CI; only the bare `RuntimeError` surfaces. |
| 18 | `scripts/e2e/init-project-e2e.js:83` | `process.exit(0)` | Hard success exit from inside the setup path. |
| 19 | `scripts/clean-gha-cache.js:46-52` | `catch (e) { return \`Failed: '${e.message}', skipping.\` }` | Cache deletions that fail are logged, never retried, never fail the workflow. |
| 20 | `packages/react-native/scripts/generate-specs-cli-executor.js:52-56` | `readAndParseSchema` throws only if `schemaText == null` — `fs.readFileSync` at `:52` already throws on a missing file, so `:54-56` is dead; a parse failure at `:61` throws `Can't parse schema to JSON. ${schemaPath}` **dropping the underlying error** | Loss of diagnostics, not a false pass. |
| 21 | `packages/react-native/scripts/codegen/generate-specs-cli-executor.js:83` | `includeGetDebugPropsImplementation = libraryName.includes('FBReactNativeSpec')` with comment `//only generate getDebugString for React Native Core Components` | Substring match, not equality — a third-party library literally named e.g. `MyFBReactNativeSpecShim` also qualifies. |

### 6.3 Error suppression (`|| true`, `2>/dev/null`, `set +e`, `set -e`)

```sh
grep -rn -E "\|\| true|2>/dev/null|set \+e|set -e|\|\| exit 0|; true$" scripts \
  packages/react-native/scripts | grep -v node_modules | grep -v "/__tests__/"
```

| file:line | Snippet |
|---|---|
| `scripts/process-podspecs.sh:7` | `set -ex` |
| `scripts/fantom.sh:7` | `set -e` |
| `scripts/fantom-cli.sh:7` | `set -e` |
| `scripts/objc-test.sh:22` | `set +e` (inside `cleanup()`, so port kills cannot mask the original exit code — correct usage) |
| `packages/react-native/scripts/ios-configure-glog.sh:7` | `set -e` |
| `packages/react-native/scripts/ios-configure-glog.sh:50` | `XCRUN="$(which xcrun \|\| true)"` |
| `packages/react-native/scripts/ios-configure-glog.sh:56` | `export CXX="$CXX:-$(which g++ \|\| true)"` |
| **`packages/react-native/scripts/ios-configure-glog.sh:69`** | **`./configure --host arm-apple-darwin \|\| true`** — autoconf failure ignored |
| **`packages/react-native/scripts/xcode/asset-catalog.sh:29`** | `… 2>/dev/null \|\| true` (PlistBuddy probe) |
| **`packages/react-native/scripts/xcode/asset-catalog.sh:79`** | `"${actool_args[@]}" 2>&1)" \|\| true` — **actool failure ignored** |
| `packages/react-native/scripts/react_native_pods_utils/script_phases.sh:8` | `set -e` (with `:7 set -o pipefail`) |
| `packages/react-native/scripts/react_native_pods_utils/script_phases.sh:26` | `NODE_BINARY="${NODE_BINARY:-$(command -v node \|\| true)}"` |
| `packages/react-native/scripts/react_native_pods_utils/script_phases.sh:42,44` | `set +e` / `set -e` around `rm -rf "$GENERATED_SRCS_DIR"` |
| `packages/react-native/scripts/react-native-xcode.sh:97` | `2>/dev/null \|\| true` |
| `packages/react-native/scripts/cocoapods/rncore.rb:300` | `` `dwarfdump --uuid "#{dsym_path}" 2>/dev/null` `` — **result used without checking exit status** |
| `packages/react-native/scripts/spm/generate-spm-xcodeproj.js:322,466,648,659,666,819` | emits `set -euo pipefail` / `set +eu` / `set -eu` into generated shell scripts |
| `packages/react-native/scripts/spm/generate-spm-xcodeproj.js:670,679,772,790,791` | `command -v node 2>/dev/null \|\| true`, `… 2>/dev/null \|\| true`, `stat -f %m … 2>/dev/null \|\| stat -c %Y … \|\| echo 0`, `git log … 2>/dev/null \|\| echo 0` |
| `.github/workflow-scripts/exec_swallow_error.sh:8-16` | runs `"$@"` then **only echoes** the status; the script's own exit status is the echoed branch's (`echo` → 0) |

---

## 7. HARDCODED VALUES

### 7.1 Versions / tool pins

| file:line | Value | Note |
|---|---|---|
| `scripts/format-python.js:19` | `RUFF_VERSION = '0.14.0'` | pinned Ruff; cache dir `node_modules/.cache/react-native-format/ruff-0.14.0` (`:20-26`) |
| `scripts/format-kotlin.js:22` | `MINIMUM_JAVA_VERSION = 17` | |
| `scripts/format-java.js:21` | `MINIMUM_JAVA_VERSION = 17` | |
| `scripts/format-swift.js:26-27` | `MINIMUM_SWIFT_FORMAT_MAJOR = 6`, `MINIMUM_SWIFT_FORMAT_MINOR = 3` | message at `:99` says "swift-format 6.3 or newer" |
| `scripts/build/babel/node.config.js:13` | `TARGET_NODE_VERSION = '18'` | |
| `packages/react-native/scripts/spm/scaffold-package-swift.js:113` | `SCAFFOLDER_VERSION = 20` | comment at `:71`: `// Bump when the emitter's output format changes in a way that requires` |
| `.github/workflows/validate-cxx-api-snapshots.yml:26` | `DOXYGEN_VERSION: '1.16.1'` | |
| `.github/workflows/validate-cxx-api-snapshots.yml:52` | `DOXYGEN_URL="https://github.com/doxygen/doxygen/releases/download/Release_${DOXYGEN_VERSION//./_}/doxygen-${DOXYGEN_VERSION}.linux.bin.tar.gz"` | |
| `.github/workflows/validate-cxx-api-snapshots.yml:53,65` | `MAX_RETRIES=3`, `sleep 5` | |
| `.github/workflows/validate-cxx-api-snapshots.yml:73` | `python-version: '3.12'` | |
| `.github/workflows/validate-cxx-api-snapshots.yml:76` | `pip install doxmlparser natsort pyyaml` | unpinned |
| `.github/workflows/format.yml:26` | `xcode-version: 26.6.0` | |
| `.github/workflows/format.yml:42` | `java-version: 17` | |
| `.github/workflows/format.yml:46` | `python-version: '3.12'` | |
| `.github/workflows/test-all.yml:582` | `node-version: ['24', '22.13.0']` | |
| `.github/workflows/test-all.yml:136,222` | `macos-15-large` | |
| `.github/workflows/test-all.yml:610,format.yml:16` | `macos-26` | |
| `.github/workflows/test-all.yml:296,339,410` / `test_android_helloworld` `446` | `8-core-ubuntu`, `4-core-ubuntu` | |
| `.github/workflows/test-all.yml:300,345,427,450` | `image: reactnativecommunity/react-native-android:latest` | **`:latest`, unpinned** |
| `.github/workflows/test-all.yml:49,114,133,153,311,357,536,553,596,614,726` | `actions/checkout@v6` | major tag |
| `.github/workflows/test-all.yml:187-188` | `device-model: iPhone-17-Pro`, `device-os: iOS-26-2` | |
| `.github/workflows/validate-dotslash-artifacts.yml:25` | `cron: '15 2 * * *'` | comment at `:23`: `# Same time as the nightly build: 2:15 AM UTC` |
| `scripts/process-podspecs.sh:31` | `"--swift-version=3.0"` | |

### 7.2 URLs (repo-toolchain relevant)

| file:line | URL |
|---|---|
| `scripts/releases/write-dotslash-release-asset-urls.js:137` | `'https://github.com/facebook/react-native/releases/download/'` |
| `scripts/releases/write-dotslash-release-asset-urls.js:149` | `` `https://github.com/facebook/react-native/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(suggestedFilename)}` `` |
| `scripts/releases/upload-release-assets-for-dotslash.js:279` | `` `https://github.com/facebook/react-native/releases/download/${encodeURIComponent(releaseTag)}/` `` |
| `scripts/releases-ci/cleanup-maven-staging-repositories.js:13` | `'https://ossrh-staging-api.central.sonatype.com/'` |
| `scripts/releases-ci/cleanup-maven-staging-repositories.js:14` | `'https://central.sonatype.com/'` |
| `scripts/releases-ci/publish-updated-packages.js:77` | `'https://registry.npmjs.org/' + pck.name` |
| `scripts/release-testing/utils/github-actions-utils.js:73` | `'https://api.github.com/repos/facebook/react-native/'` |
| `scripts/release-testing/utils/github-actions-utils.js:159` | `` `https://github.com/facebook/react-native/actions/runs/${testAllWorkflows[0].id}\n` `` |
| `scripts/debugger-frontend/sync-and-build.js:29` | `'https://github.com/react/react-native-devtools-frontend'` |
| `scripts/debugger-frontend/sync-and-build.js:155` | `'https://commondatastorage.googleapis.com/chrome-infra-docs/flat/depot_tools/docs/html/depot_tools_tutorial.html#_setting_up'` |
| `scripts/e2e/utils/verdaccio.js:21` | `'http://127.0.0.1:4873'` |
| `scripts/e2e/init-project-e2e.js:268` | `` `git clone https://github.com/react-native-community/template ${templateCloneBaseFolder}` `` |
| `scripts/process-podspecs.sh:25` | `"https://example.com/$SPEC_REPO.git"` (dummy repo) |
| `scripts/process-podspecs.sh:29` | `"$(git remote get-url origin),https://github.com/CocoaPods/Specs.git"` |
| `packages/react-native/scripts/spm/download-spm-artifacts.js:141` | `MAVEN_CENTRAL_REPOSITORY = 'https://repo1.maven.org/maven2'` |
| `packages/react-native/scripts/spm/download-spm-artifacts.js:146` | `'https://central.sonatype.com/repository/maven-snapshots'` |
| `packages/react-native/scripts/spm/download-spm-artifacts.js:308` | `` `https://registry.npmjs.org/${npmPackage}/nightly` `` |
| `packages/react-native/scripts/spm/download-spm-artifacts.js:363` | `'https://registry.npmjs.org/hermes-compiler/latest-v1'` |
| `packages/react-native/scripts/ios-prebuild/utils.js:17` | `MAVEN_CENTRAL_REPOSITORY = 'https://repo1.maven.org/maven2'` |
| `packages/react-native/scripts/ios-prebuild/utils.js:106` | `` `https://central.sonatype.com/repository/maven-snapshots/com/facebook/${subGroup}/${artifactCoordinate}/${version}-SNAPSHOT/maven-metadata.xml` `` |
| `packages/react-native/scripts/ios-prebuild/utils.js:138` | `` `.../${artifactCoordinate}-${fullVersion}-${artifactName}` `` |
| `packages/react-native/scripts/ios-prebuild/hermes.js:119` | `'https://registry.npmjs.org/hermes-compiler/latest-v1'` |
| `packages/react-native/scripts/ios-prebuild/reactNativeDependencies.js:141` | `'https://registry.npmjs.org/react-native/nightly'` |
| `packages/react-native/scripts/hermes/release-hermes-for-branch-cut.js:54,119` | `https://cli.github.com/`, `` `https://github.com/facebook/hermes/actions/workflows/rn-build-hermes.yml?query=branch%3A${HERMES_BRANCH}` `` |

**iOS prebuild 3rd-party tarball pins — `scripts/releases/ios-prebuild/configuration.js`:**

| Line | URL |
|---|---|
| `:33` | `https://github.com/google/glog/archive/refs/tags/v0.3.5.tar.gz` |
| `:68` | `https://github.com/google/double-conversion/archive/refs/tags/v1.1.6.tar.gz` |
| `:85` | `https://github.com/fmtlib/fmt/archive/refs/tags/12.1.0.tar.gz` |
| `:105` | `https://github.com/react-native-community/boost-for-react-native/archive/refs/tags/v1.84.0.tar.gz` |
| `:124` | `https://github.com/fastfloat/fast_float/archive/refs/tags/v8.0.0.tar.gz` |
| `:149` | `https://github.com/facebookincubator/SocketRocket/archive/refs/tags/0.7.1.tar.gz` |
| `:181` | `https://github.com/facebook/folly/archive/refs/tags/v2024.11.18.00.tar.gz` |

CocoaPods mirrors of the same deps — `packages/react-native/scripts/cocoapods/helpers.rb:41` (boost-for-react-native), `:51` (folly), `:68` (fast_float), `:72` (fmt), `:76` (glog), `:80` (double-conversion).

### 7.3 Ports

| file:line | Value | Purpose |
|---|---|---|
| `scripts/objc-test.sh:30,40,121,126,127` | `8081` | Metro packager |
| `scripts/objc-test.sh:32,58` | `5555` | web socket server |
| `scripts/release-testing/utils/testing-utils.js:110` | `process.env.RCT_METRO_PORT ?? '8081'` | |
| `scripts/release-testing/utils/testing-utils.js:135` | `lsof -i :8081 …` | |
| `scripts/release-testing/test-release-local.js:181` | `adb reverse tcp:8081 tcp:8081` | |
| `scripts/release-testing/test-release-local-clean.js:40` | `lsof -i :8081 …` | |
| `scripts/e2e/utils/verdaccio.js:21` | `4873` | Verdaccio |

### 7.4 Timeouts / batch sizes / thresholds

| file:line | Constant | Value |
|---|---|---|
| `scripts/format-kotlin.js:23` | `MAX_FILES_PER_PROCESS` | `100` |
| `scripts/format-java.js:22` | `MAX_FILES_PER_PROCESS` | `30` |
| `scripts/format-swift.js:28` | `MAX_FILES_PER_PROCESS` | `100` |
| `scripts/clang-format.js:23` | `MAX_FILES_PER_PROCESS` | `30` |
| `scripts/format-kotlin.js:24`, `scripts/format-java.js:23`, `scripts/format-swift.js:29`, `scripts/clang-format.js:22` | `MAX_HEADER_BYTES` | `4096` (in all four) |
| `scripts/clean-gha-cache.js:13` | `CACHE_LIMIT` | `10 * 1024 ** 3 * 0.9` (≈9.44 GB) |
| `scripts/clean-gha-cache.js:58` | gh CLI | `--limit 1000` |
| `scripts/clean-gha-cache.js:73` | node-cache floor | `sizeInBytes > 1024 * 1024` |
| `scripts/releases-ci/cleanup-maven-staging-repositories.js:15` | `DEFAULT_PORTAL_POLL_INTERVAL_MS` | `10_000` |
| `scripts/releases-ci/cleanup-maven-staging-repositories.js:16` | `DEFAULT_PORTAL_STATUS_ATTEMPTS` | `60` |
| `packages/react-native/scripts/spm/read-podspec.js:101` | exec timeout | `30000` |
| `packages/react-native/scripts/spm/ios-deployment-target.js:40` | `MAX_XCCONFIG_DEPTH` | `16` |
| `packages/react-native/scripts/featureflags/print.js:22` | `DESC_MAX_LENGTH` | `100` |
| `scripts/e2e/init-project-e2e.js:205` | retry | `retry('npm', execOptions, 3, 500, [...])` |
| `scripts/objc-test.sh:37` | `max_attempts` | `60` |
| `scripts/objc-test.sh:152-153` | `MAX_RETRY` | `3` |
| `scripts/fantom.sh:25` | `NODE_OPTIONS` | `'--max-old-space-size=16384'` |
| `scripts/monorepo-tests` (empty) | — | directory holds only `__tests__/check-packages-test.js` |

### 7.5 Paths / enums (selected)

- `scripts/releases/set-rn-artifacts-version.js:22-25` — `GRADLE_FILE_PATH = <REPO_ROOT>/packages/react-native/ReactAndroid/gradle.properties`.
- `packages/react-native/scripts/codegen/generate-artifacts-executor/constants.js:16-23` — `REACT_NATIVE_REPOSITORY_ROOT` = 5×`..` from `__dirname`; `:25-30` `REACT_NATIVE_PACKAGE_ROOT_FOLDER` = 3×`..`; `:31` `CODEGEN_REPO_PATH` = `<repoRoot>/packages/react-native-codegen`; `:60-65` `TEMPLATES_FOLDER_PATH`.
- `packages/react-native/scripts/codegen/generate-artifacts-executor/index.js:74` — `supportedPlatforms = ['android', 'ios']`; `:261-271` Android default output `android/app/build/generated/source/codegen`; `:273-275` iOS `build/generated/ios`.
- `scripts/shared/monorepoUtils.js:16` — `WORKSPACES_CONFIG = '{packages,private}/*'`; `:88-90` special-cases `@react-native/tester`.
- `scripts/shared/consts.js:16-50` — `REPO_ROOT`, `PACKAGES_DIR`, `PRIVATE_DIR`, `SCRIPTS_DIR`, `REACT_NATIVE_PACKAGE_DIR`, `RN_TESTER_DIR`.
- `packages/react-native/scripts/react_native_pods_utils/script_phases.sh:10-12` — `DERIVED_FILE_DIR/generated/source/codegen`, `/out`, `/schema.json`.
- `scripts/cxx-api/parser/__main__.py:113` — `config_file = f".doxygen.config.{api_view}.generated"`; `doxygen.py:13` default `.doxygen.config.generated`.
- `scripts/cxx-api/parser/__main__.py:246` — default snapshot dir `<repoRoot>/scripts/cxx-api/api-snapshots`.

### 7.6 Cross-file duplication (same value, two or more files)

| Value | Files |
|---|---|
| `'1000.0.0'` (main sentinel) | `scripts/releases/set-version.js:84`, `scripts/releases/utils/npm-utils.js:55`, `scripts/releases-ci/publish-npm.js:113`, `packages/react-native/scripts/spm/download-spm-artifacts.js:144,349,1183,1187,1202`, `packages/react-native/scripts/spm/spm-utils.js:371`, `packages/react-native/ReactAndroid/gradle.properties:1`, `packages/react-native/Libraries/Core/ReactNativeVersion.js:29-31`, `…/ReactNativeVersion.kt:14` |
| `'0.0.0'` (hermes placeholder) | `packages/react-native/package.json:165`, `scripts/try-set-hermes-compiler-prebuilt.js:18`, `scripts/releases/use-hermes-prebuilt.js:20`, `scripts/releases/use-hermes-nightly.js:20` |
| `'0.0.0'` (nightly validity) | `scripts/releases/utils/version-utils.js:146` |
| `'latest-v1'` hermes npm tag | `scripts/releases/utils/hermes-utils.js:37`, `packages/react-native/scripts/ios-prebuild/hermes.js:70,119`, `packages/react-native/scripts/spm/download-spm-artifacts.js:363`, `scripts/try-set-hermes-compiler-prebuilt.js:20` |
| `MAVEN_CENTRAL_REPOSITORY = 'https://repo1.maven.org/maven2'` | `packages/react-native/scripts/spm/download-spm-artifacts.js:141`, `packages/react-native/scripts/ios-prebuild/utils.js:17` |
| Maven snapshots base URL | `packages/react-native/scripts/spm/download-spm-artifacts.js:146`, `packages/react-native/scripts/ios-prebuild/utils.js:106,138` |
| `hermes-compiler` npm registry path | `packages/react-native/scripts/ios-prebuild/hermes.js:119`, `packages/react-native/scripts/spm/download-spm-artifacts.js:363` |
| `ReactNativeVersion` mirror-structure invariant comment | `packages/react-native/scripts/ios-prebuild/utils.js:144` and `packages/react-native/scripts/cocoapods/utils.rb:34` (near-identical text) |
| `8081` port | 6 sites listed in §7.3 |
| `MINIMUM_JAVA_VERSION = 17` | `scripts/format-kotlin.js:22`, `scripts/format-java.js:21` |
| `MAX_HEADER_BYTES = 4096` | `scripts/format-kotlin.js:24`, `scripts/format-java.js:23`, `scripts/format-swift.js:29`, `scripts/clang-format.js:22` |
| `isGenerated()` 4096-byte `@generated` probe | duplicated verbatim in all four format scripts (`format-kotlin.js:34-43`, `format-java.js:31-46`, `format-swift.js:32-47`, `clang-format.js:57-72`) |
| Maven staging/portal URLs | `scripts/releases-ci/cleanup-maven-staging-repositories.js:13-14` |
| `1000.0.0`-vs-nightly routing | `packages/react-native/scripts/spm/download-spm-artifacts.js:349,1183,1187,1202` and `packages/react-native/scripts/spm/spm-utils.js:371` |
| `DO_NOT_MODIFY_COMMENT` naming `yarn featureflags --update` | `packages/react-native/scripts/featureflags/utils.js:109-117` and `ReactNativeFeatureFlags.config.js:20` |
| `swift-format 6.3 or newer` threshold | `scripts/format-swift.js:26-27` and `:99` |
| `Java 17 or newer` threshold | `scripts/format-utils.js:76,78` and `format-kotlin.js:22` / `format-java.js:21` |
| `1000.0.0` in docs | `scripts/releases/set-version.js:53`, `scripts/releases-ci/publish-npm.js:109` |

---

## 8. CI

### 8.1 Configuration present

- **No `.circleci/`** (`ls .circleci` → "NO .circleci").
- `.github/workflows/` — **36 workflow YAML files** (`ls .github/workflows/`).
- `.github/workflow-scripts/` — 22 files (20 scripts + `__tests__/`).
- `.github/actions/` — 19 actions.

### 8.2 Jobs and the repo scripts they run

| Workflow | Job | Runs (file:line of the workflow) |
|---|---|---|
| `test-all.yml` | `set_release_type` | inline bash only (`:25-35`) |
| " | `check_code_changes` | `dorny/paths-filter` (`:51,84`) |
| " | `prebuild_apple_dependencies` → `prebuild-ios-dependencies.yml` | `node scripts/releases/prepare-ios-prebuilds.js` (`prebuild-ios-dependencies.yml:93,159,162`) |
| " | `prebuild_react_native_core` → `prebuild-ios-core.yml` | (未确认 — not read) |
| " | `test_ios_rntester_ruby_3_2_0`, `test_ios_rntester_dynamic_frameworks`, `test_ios_rntester`, `test_ios_helloworld*`, `test_ios_spm_*` | reusable actions |
| " | `test_e2e_ios_templateapp`, `test_e2e_android_*`, `run_fantom_tests*`, `test_maestro_cloud_*` | reusable workflows |
| " | `build_android` → `.github/actions/build-android` | gradle |
| " | `build_npm_package` → `.github/actions/build-npm-package` | `yarn build-types --skip-snapshot` (`build-npm-package/action.yml:63`) |
| " | `test_android_helloworld` | `node ./scripts/releases/use-hermes-prebuilt.js` (`:489`); `node ./scripts/e2e/init-project-e2e.js` (`:494`) |
| " | **`lint`** | `./.github/workflow-scripts/analyze_scripts.sh` (`:561`); `yarn run lint-markdown` (`:564`); **`./.github/workflow-scripts/exec_swallow_error.sh yarn lint --format junit …` (`:567`)**; `yarn flow-check` (`:570`); `yarn test-typescript-legacy` (`:573`) |
| " | `test_js` → `.github/actions/test-js` | `node ./scripts/run-ci-javascript-tests.js --maxWorkers 2` (`.github/actions/test-js/action.yml:19`) |
| " | `build_js_types` | `yarn build-types --skip-snapshot` (`:604`); `yarn test-generated-typescript` (`:607`) |
| " | `build_debugger_shell` | `yarn build --prepack` (`:622`); `node scripts/debugger-shell/build-binary.js` (`:625`) |
| `validate-cxx-api-snapshots.yml` | `validate_cxx_api_snapshots` | Doxygen download (`:51-66`); `pip install doxmlparser natsort pyyaml` (`:76`); **`yarn cxx-api-validate --output-dir /tmp/cxx-api-snapshots` (`:79`)** |
| `format.yml` | `format` | loop `yarn "format-$formatter"` for `javascript cpp kotlin java python swift` (`:57-59`) + `git diff` gate (`:64-69`) |
| `api-changes.yml` | `api_changes` | `.github/actions/diff-js-api-changes` (`:23`) → `node scripts/js-api/diff-api-snapshot` |
| `validate-dotslash-artifacts.yml` | `validate-dotslash-artifacts` | `require('./scripts/releases/validate-dotslash-artifacts.js').validateDotSlashArtifacts()` (`:50-51`) |
| `cache-reaper.yml` | (reaper) | `node scripts/clean-gha-cache.js` (`:20`) |
| `publish-npm.yml` | (publish jobs) | `node ./scripts/releases-ci/cleanup-maven-staging-repositories.js` (`:119,199`); `yarn build` (`:223`); `yarn build-types --skip-snapshot` (`:225`); `node ./scripts/releases-ci/publish-updated-packages.js` (`:227`) |
| `generate-changelog.yml` | — | `.github/workflow-scripts/generateChangelog.js` |
| `test-ios-spm-*.yml` | — | `node ./scripts/releases/use-hermes-prebuilt.js` (`helloworld:31`, `newapp:31`, `rntester:31`) |
| Others (`analyze-pr`, `autorebase`, `bump-podfile-lock`, `check-for-reproducer`, `close-pr`, `create-draft-release`, `create-release`, `e2e-*`, `expo-code-review*`, `fantom-tests`, `format-report`, `maestro-cloud-rntester`, `monitor-new-issues`, `needs-attention`, `on-issue-labeled`, `prebuild-ios-*`, `retry-workflow`, `stale-bot`) | — | 未确认 in detail |

### 8.3 Jobs that would silently pass on error

| # | Where | Mechanism |
|---|---|---|
| 1 | `.github/workflows/test-all.yml:567` | ESLint runs through `exec_swallow_error.sh`, which executes `"$@"` then only **echoes** the status and exits with the `echo`'s 0 (`.github/workflow-scripts/exec_swallow_error.sh:8-16`). **ESLint failures do not fail the `lint` job.** |
| 2 | `.github/workflows/format.yml:54-63` | `set +e` around the formatter loop; status is recovered via `PIPESTATUS[0]` — correct, **but** each `yarn format-<lang>` internally exits 0 when its toolchain is missing (§6.2 #2-#5). Missing toolchains therefore produce a **green** format job. The `git diff` check at `:64-69` is the real gate and does catch unformatted files. |
| 3 | `scripts/format-*.js` (`python:79-187`, `kotlin:47-51`, `java:65-69`, `swift:107-110`) | Each language wrapper `console.warn`s and returns with status 0 when the toolchain is missing. `package.json:17` chains them with `&&`, so `format-check` passes overall. |
| 4 | `scripts/cxx-api/parser/snapshot_diff.py:35-38,43-46,64-66` | Missing baseline dir, empty baseline dir, or a new un-baselined snapshot all return `True` → `__main__.py:356` not reached → exit 0. |
| 5 | `scripts/cxx-api/parser/main.py:414-416` | Missing Doxygen compound files are `print`ed and skipped → a silently truncated snapshot. |
| 6 | `.github/workflows/cache-reaper.yml` → `scripts/clean-gha-cache.js:46-52` | Cache-delete failures return a `Failed: …, skipping.` string; job still exits 0. |
| 7 | `.github/workflows/test-all.yml:141-164` `test_ios_rntester` | `continue-on-error: true` at `:145` — deliberate. Comment at `:158-162` explains the dual-copy regression coverage. |
| 8 | `.github/workflows/test-all.yml:460` `test_android_helloworld` | `continue-on-error: true`. |
| 9 | `.github/workflows/format.yml:51` | `continue-on-error: true` on the `format` step, mitigated by the explicit `exit 1` at `:78`. |
| 10 | `.github/workflows/analyze_scripts.sh:23-26` | **Fails closed** — exits 1 if shellcheck is absent. Included for contrast. |
| 11 | Feature-flag drift is caught only inside `test_js` via `scripts/run-ci-javascript-tests.js:52` (`yarn run featureflags --verify-unchanged`) → `.github/actions/test-js/action.yml:19`. `grep -rn "featureflags" .github/` matches **nothing** else. Since `test_js` needs `lint` (`:577`) and `lint` cannot fail on ESLint (#1), a lint failure does not block the feature-flag check — but a genuine feature-flag drift does fail `test_js`. |

---

## 9. DEAD CODE

### 9.1 Scripts referenced nowhere

Command:
```sh
for f in $(find scripts -maxdepth 1 -type f \( -name "*.js" -o -name "*.sh" \) | sed 's|.*/||'); do
  n=$(grep -rn "$f" --include="*.json" --include="*.yml" --include="*.yaml" --include="*.js" \
       --include="*.rb" --include="*.sh" --include="*.md" --include="*.kts" \
       --include="*.gradle" --include="*.podspec" . 2>/dev/null \
     | grep -v node_modules | grep -v "^\./scripts/$f" | grep -v "^\./$f" | wc -l)
  [ "$n" -eq 0 ] && echo "DEAD: scripts/$f"
done
```

| File | Verdict |
|---|---|
| **`scripts/process-podspecs.sh`** | **DEAD — 0 references.** Not in any package.json, workflow, or other script. Contains real logic (`pod lib lint`, dummy spec repo). |
| **`scripts/validate-ios-test-env.sh`** | **DEAD — 0 references.** |
| `scripts/format-utils.js` | **0 external refs by filename, but it is a library**: imported by `format-python.js:13`, `format-kotlin.js:13`, `format-java.js:13`, `format-swift.js:13-17`. Not dead. |
| `scripts/releases/use-hermes-nightly.js` | **DEAD — 0 references**, and `diff scripts/releases/use-hermes-nightly.js scripts/releases/use-hermes-prebuilt.js` exits **0**: the two files are **byte-identical**. Both call `updateHermesVersionsToPrebuilt()`, which fetches the **`latest-v1` prebuilt** tag (`hermes-utils.js:37`) — so the file named "nightly" does not do anything nightly. |
| `scripts/debugger-frontend/sync-and-build.js` | 0 refs in `package.json`/CI; documented for humans in `packages/debugger-frontend/README.md:28,32,35`. Manual tool, not CI-dead. |
| `scripts/debugger-frontend/commit-backend.js` | 0 external refs; imported by `sync-and-build.js:12`. Library. |
| `scripts/shared/{consts,monorepoUtils,isGitRepo,babelRegister}.js` | 0 refs by bare filename; all are required by relative path (e.g. `scripts/releases/set-version.js:17-21`, `scripts/js-api/build-types/index.js:11`) and by `private/helloworld`, `private/react-native-fantom`. Libraries. |
| `scripts/monorepo-tests/` | Contains **only** `__tests__/check-packages-test.js` — 0 non-test files. The directory's non-test presence is vestigial; the test is picked up by the root jest config. |
| `scripts/cxx-api/manual_test/` | Only reachable via `--test` (`scripts/cxx-api/parser/__main__.py:304`). Manual harness; not in CI. |

### 9.2 Broken entry points

| Location | Problem |
|---|---|
| `package.json:49` | `"trigger-react-native-release": "node ./scripts/releases-local/trigger-react-native-release.js"` — `scripts/releases-local/` **does not exist** (`ls` → "No such file or directory"). `npm-utils.js:97` still comments "Set in \`trigger-react-native-release\`". |

All other root `package.json` script targets were verified present (script at the top of this section).

### 9.3 Exported functions with zero non-test callers

| Export | file:line | Non-test callers |
|---|---|---|
| `isReleaseBranch` | `scripts/releases/utils/version-utils.js:167` | **0** — only `scripts/releases/utils/__tests__/version-utils-test.js:13,31-39` |
| `isStableRelease`, `isStablePrerelease` | `version-utils.js:169,170` | 0 external; used internally at `:100,111` |
| `updateGradleFile` | `scripts/releases/set-rn-artifacts-version.js:166` | internal only (`:84`) |
| `updateSourceFiles` | `set-rn-artifacts-version.js:167` | internal only (`:82`) |
| `getTagsFromCommitMessage` | `scripts/releases-ci/publish-updated-packages.js:153` | internal only (`:94`) |
| `translateFile` | `scripts/js-api/build-types/buildGeneratedTypes.js:196` | internal only (`:239`, watch mode) |
| `isStablePrerelease`/`validateBuildType` | `version-utils.js:164,170` / `:165` | `validateBuildType` used by `set-rn-artifacts-version.js:17,66` |
| `setStableHermesForReleaseBranch` | `hermes-utils.js:97` | `scripts/releases/create-release-commit.js:13,59` |
| `isReactNativeCoreLibrary` | `packages/react-native/scripts/codegen/generate-artifacts-executor/utils.js:556` | `generateRCTModuleProviders.js:15,58`, `generateRCTThirdPartyComponents.js:16,52` |

**Not dead (verified with callers):** `updateHermesCompilerVersionInDependencies` / `updateHermesRuntimeDependenciesVersions` (`hermes-utils.js:99,100`, called at `:92,93`), `writeFileSyncIfChanged` (`utils.js:565`), `parseiOSAnnotations` (`utils.js:561`), `generateCode` (`generateNativeCode.js:113`, called by `generateFBReactNativeSpecIOS.js:38`), `buildFile`/`getBuildPath` (`build.js:422,423`).

### 9.4 Dead documented feature

- `scripts/cxx-api/README.md:76` documents `private_directories`; **not in `config.yml`, not in `config.py:28-41`, not anywhere in `scripts/`**. (See §3.4.)
- `packages/react-native/ReactAndroid/.../ReactNativeFeatureFlagsOverrides_RNOSS_Stable_Android.kt` exists but no generator emits it. (See §5.1.)
- `packages/react-native/scripts/codegen/generate-artifacts-executor/generateProviderCLIExecutor` — `packages/react-native/package.json:105` ships `scripts/generate-provider-cli.js` in `files`, but the only in-repo caller of `utils.getCodegen().generateFromSchemas` with `providerIOS` is that file; `generateRCTModuleProviders` etc. are separate generators. 未确认 whether third parties invoke it.

---

## 10. COMMENTS OF NOTE

### 10.1 Every TODO / FIXME / HACK / XXX / WORKAROUND

Command:
```sh
grep -rn -E "TODO|FIXME|HACK|XXX|WORKAROUND|workaround" scripts \
  --include="*.js" --include="*.rb" --include="*.py" --include="*.sh" --include="*.mjs" \
  | grep -v node_modules | grep -v "__tests__" | grep -v api-snapshots
grep -rn -E "TODO|FIXME|HACK|XXX|WORKAROUND" packages/react-native/scripts \
  --include="*.js" --include="*.rb" --include="*.py" --include="*.sh" \
  | grep -v node_modules | grep -v "/__tests__/" | grep -v "__fixtures__"
```

| file:line | Exact text |
|---|---|
| `scripts/releases/utils/hermes-utils.js:35` | `// TODO: rename 'latest-v1' to 'latest' once V1 is the only Hermes on npm` |
| `scripts/js-api/build-types/transforms/typescript/simplifyTypes/resolveBuiltinType.js:22` | `// TODO: Handle more builtin TS types` |
| `scripts/cxx-api/parser/member/concept_member.py:85` | `        # TODO: handle unqualified references` |
| `scripts/release-testing/test-release-local.js:174` | `  // TODO: we should find a way to make it work like for iOS, via npx react-native run-android` |
| `scripts/release-testing/test-release-local.js:200` | `  // FIXME: make sure that the commands retains colors` |
| `scripts/debugger-frontend/sync-and-build.js:13` | `// $FlowFixMe[untyped-import]: TODO type ansi-styles` |
| `scripts/debugger-frontend/sync-and-build.js:21` | `// $FlowFixMe[untyped-import]: TODO type rimraf` |
| `scripts/debugger-frontend/sync-and-build.js:23` | `// $FlowFixMe[untyped-import]: TODO type signedsource` |
| `scripts/debugger-frontend/sync-and-build.js:25` | `// $FlowFixMe[untyped-import]: TODO type supports-color` |
| `scripts/e2e/init-project-e2e.js:81` | `  // TODO(T179377112): Fix memory leak from \`spawn\` in \`setupVerdaccio\` (above` |
| `scripts/e2e/init-project-e2e.js:201` | `  // TODO(huntie): Review pre-existing retry limit` |
| `packages/react-native/scripts/ios-prebuild/hermes.js:70` | `      // TODO: rename 'latest-v1' to 'latest' once V1 is the only Hermes on npm` |
| `packages/react-native/scripts/ios-prebuild/hermes.js:117` | `  // TODO: rename 'latest-v1' to 'latest' once V1 is the only Hermes on npm` |
| `packages/react-native/scripts/featureflags/templates/js/NativeReactNativeFeatureFlags.cpp-template.js:60` | `  // TODO(T204838867): Implement support for optional methods in C++ TM codegen and remove the method definition altogether.` |

No `HACK`, `XXX`, or `WORKAROUND` tokens exist in either tree.

### 10.2 Comments stating a numeric threshold, API level, or invariant (exact quotes)

| file:line | Exact text |
|---|---|
| `scripts/fantom.sh:19-24` | `# The Fantom Jest process hosts a single shared Metro server. Each test`<br>`# triggers a fresh Metro bundle build whose dependency graph (transformed`<br>`# modules, source maps, inverse-deps, file-watcher subscription) lives in`<br>`# memory until the per-test DELETE evicts it. With the maxWorkers cap in`<br>`# jest.config.js (~16 in-flight bundles at peak), 16 GB gives ~40% heap`<br>`# headroom over the observed steady state of ~6 GB.`<br>→ `export NODE_OPTIONS='--max-old-space-size=16384'` at `:25` |
| `scripts/format-utils.js:76` | `'Please install a JDK of your choice with Java 17 or newer and make sure the \`java\` command is in your PATH, or set JAVA=/path/to/java.'` |
| `scripts/format-utils.js:78` | `` `warning: Skipping ${language} formatting because Java 17 or newer was not found.\n${instructions}` `` |
| `scripts/format-swift.js:99` | `'warning: Skipping Swift formatting because swift-format 6.3 or newer was not found.\n' +` |
| `scripts/format-swift.js:36-38` (comment at `:99-100` instructions) | `'Please install Swift 6.3 or newer and make sure \`swift-format\` or \`swift\` is in your PATH, or set SWIFT_FORMAT=/path/to/swift-format.'` |
| `scripts/format-python.js:81-82` | `'warning: Skipping Python formatting because Python 3 with pip was not found.\n' +` / `'Please install Python 3 with pip and make sure \`python3\` (\`py -3\` on Windows) and pip are available in your PATH.'` |
| `scripts/format-utils.js:34` | ``@param {string} file`` — no; the numeric invariant is `MAX_HEADER_BYTES` at `:34` of `format-java.js`/`:29` of `format-swift.js`/`:24` of `format-kotlin.js`/`:22` of `clang-format.js` (all `4096`) |
| `scripts/clean-gha-cache.js:13-14` | `const CACHE_LIMIT = 10 * 1024 ** 3 * 0.9;` // `// Doing this to capture node-modules- and the pre-existing node-cache-<platform>-yarn-<sha> entries` |
| `scripts/clean-gha-cache.js:72` | `      // I've observed some noisy entries, ignore anything that isn't > 1MB` |
| `scripts/release-testing/utils/testing-utils.js:49` | `// here: https://nodejs.org/api/child_process.html#optionsdetached` |
| `scripts/cxx-api/parser/__main__.py:163-166` | `# Run codegen once per unique platform before parallel snapshot generation.`<br>`# Debug/release variants share the same codegen output, and running`<br>`# multiple codegen processes in parallel causes race conditions`<br>`# (e.g. concurrent yarn install in buildCodegenIfNeeded).` |
| `packages/react-native/scripts/codegen/generate-artifacts-executor/utils.js:50-51` | `  // Assuming we are working in the react-native repo. We might need to build the codegen.`<br>`  // This will become unnecessary once we start using Babel Register for the codegen package.` |
| `packages/react-native/scripts/codegen/generate-artifacts-executor/utils.js:69-73` | `// It removes all the empty files and empty folders`<br>`// it finds, starting from \`filepath\`, recursively.`<br>`//`<br>`// This function is needed since, after aligning the codegen between`<br>`// iOS and Android, we have to create empty folders in advance and`<br>`// we don't know whether they will be populated up until the end of the process.` |
| `packages/react-native/scripts/codegen/generate-artifacts-executor/utils.js:143-144` | `      // In a \`"type": "module"\` package, requiring the \`.js\` config throws;`<br>`      // keep going so a sibling \`.cjs\` config is still picked up.` |
| `packages/react-native/scripts/codegen/generate-artifacts-executor/index.js:95` | `    // NOTE: We cache the external libraries search (which may not run) across platforms to not change previous behaviour` |
| `packages/react-native/scripts/codegen/generate-artifacts-executor/index.js:99` | `      // NOTE: This needs to be computed per-platform since \`platform\` can alter the path via a \`package.json:codegenConfig.outputDir[platform]\` override` |
| `packages/react-native/scripts/codegen/generate-artifacts-executor/index.js:155` | `        // These components are only required by apps, not by libraries and are Apple specific.` |
| `packages/react-native/scripts/codegen/generate-artifacts-executor/index.js:249` | `    // Don't create nested directories for libraries to make importing generated headers easier.` |
| `packages/react-native/scripts/codegen/generate-specs-cli-executor.js:100-103` | `    // Move all components C++ files to a structured jni folder for now.`<br>`    // Note: this should've been done by RNCodegen's generators, but:`<br>`    // * the generators don't support platform option yet`<br>`    // * this subdir structure is Android-only, not applicable to iOS` |
| `packages/react-native/scripts/ios-prebuild/utils.js:144` | `  // The mirror's structure must be the same of the Maven repo the react-native core team publishes on Maven Central.` |
| `packages/react-native/scripts/cocoapods/utils.rb:34` | `        ## The mirror's structure must be the same of the Maven repo the react-native core team publishes on Maven Central.` |
| `packages/react-native/scripts/ios-prebuild/xcframework.js:136` | `  // development. CI release composition requires it and fails closed.` |
| `packages/react-native/scripts/setup-apple-spm.js:1010-1021` | The full fail-closed rationale, quoted in §6.1; key line `:1017-1018`: `// set process.exitCode = 2 (a hard Xcode build-phase error, matching the` / `// RemoteVersionError path) and return null so the caller stops.` |
| `packages/react-native/scripts/setup-apple-spm.js:1148` | `      // process.exitCode = 2. Stop rather than emit an empty Autolinked package.` |
| `packages/react-native/scripts/spm/scaffold-package-swift.js:71` | `// Bump when the emitter's output format changes in a way that requires` (guards `SCAFFOLDER_VERSION = 20` at `:113`) |
| `packages/react-native/scripts/spm/ios-deployment-target.js:40` | `const MAX_XCCONFIG_DEPTH = 16;` |
| `packages/react-native/scripts/spm/download-spm-artifacts.js:1200` | `  // automatically instead of sticking on a stale "1000.0.0" cache forever.` |
| `packages/react-native/scripts/spm/download-spm-artifacts.js:1509` | `  // The Hermes public headers must be staged for headers-compose to fold` |
| `packages/react-native/scripts/ios-prebuild/headers-compose.js:59` | `// requires (i.e. every \`require('./*.js')\` above) — the guard test in` |
| `packages/react-native/scripts/ios-prebuild/headers-inventory.js:33` | `// headers-spec.js requires only fs/path, so this cannot cycle.` |
| `packages/react-native/scripts/spm/generate-spm-xcodeproj.js:819` | `  # under \`set -e\` — the whole point is to branch on the code below (2 = fail` |
| `packages/react-native/scripts/xcode/asset-catalog.sh:61` | `  # "ios", which includes Mac Catalyst), so the deployment target must be an iOS` |
| `packages/react-native/scripts/react_native_pods.rb:85` | `# - :production [DEPRECATED] whether the dependencies must be installed to target a Debug or a Release build.` |
| `packages/react-native/scripts/cocoapods/local_podspec_patch.rb:7` | `# This is necessary because local podspec dependencies must be otherwise manually updated.` |
| `packages/react-native/scripts/cocoapods/new_architecture.rb:148` | `        # add_rncore_dependency must be called after setting pod_target_xcconfig` |
| `scripts/js-api/build-types/buildApiSnapshot.js:222-224` | `/**`<br>` * Rewrite imports to local packages in the temp directory. We do this to`<br>` * avoid cyclic references, which API Extractor cannot process.`<br>` */` |
| `scripts/build/build.js:236-248` | The `.js`/`.flow.js` entry-point convention diagram (see §2.1) |
| `scripts/releases/utils/version-utils.js:23-35` | The version-format examples block (`- stable: 0.68.1`, `- nightly: X.Y.Z-20221116-0bc4547fc`, `- dryrun: 1000.0.0`) |
| `scripts/releases/utils/version-utils.js:96-98` | `/**`<br>` * Releases are in the form of 0.Y.Z[-RC.0]`<br>` */` |
| `scripts/releases/set-rn-artifacts-version.js:41-44` | `/**`<br>` * @deprecated This script entry point is deprecated. Please use \`set-version\`<br>` * instead.`<br>` */` |
| `scripts/releases/utils/hermes-utils.js:40-44` | `/**`<br>` * Updates gradle.properties to use stable Hermes instead of nightly.`<br>` * This is needed because main uses nightly Hermes, but release branches`<br>` * should use stable Hermes from Maven Central.`<br>` */` |
| `packages/react-native/scripts/replace-rncore-version.js:20-22` | `// Not a valid configuration, so finding it means the swap did not finish.`<br>`const REPLACEMENT_IN_PROGRESS = 'in-progress';` |
| `packages/react-native/scripts/replace-rncore-version.js:50-52` | `  // With no marker the on-disk flavor is Debug: the podspec installs the debug`<br>`  // tarball (see resolve_podspec_source in scripts/cocoapods/rncore.rb).` |
| `packages/react-native/scripts/replace-rncore-version.js:72-76` | `  // Extract to a temporary directory on a regular filesystem first, then move`<br>`  // into the final location. This avoids issues with partial tar extraction on`<br>`  // certain filesystems (e.g. EdenFS) where extracting directly can silently`<br>`  // produce incomplete results.` |
| `packages/react-native/scripts/replace-rncore-version.js:105-113` | The `#57803` reference explaining why `Headers/module.modulemap` is left alone |
| `packages/react-native/package.json:98-105` (via `files`) | N/A |
| `scripts/cxx-api/parser/main.py:117-119` | `    # Skip anonymous namespaces (internal linkage, not public API).`<br>`    # Doxygen encodes them with an '@' prefix in the compound name.` |
| `scripts/cxx-api/parser/main.py:151-153` | `    # Handle Objective-C interface types by checking the compound id`<br>`    # Doxygen reports ObjC interfaces as kind="class" but with id starting with "interface"` |
| `scripts/cxx-api/parser/utils/argument_parsing.py:47` | `# they must be separated to allow unambiguous type qualification later.` |
| `scripts/cxx-api/parser/builders.py:365` | `        # Handle pointer-to-member-function types where the name must be` |
| `scripts/e2e/utils/try-n-times.js:13` | ` * each retry.` |
| `scripts/process-podspecs.sh:12-13` | `# Specify \`SPEC_REPO\` as an env variable if you want to push to a specific spec repo.`<br>`# Defaults to \`react-test\`, which is meant to be a dummy repo used to test that the specs fully lint.` |
| `.github/workflows/validate-dotslash-artifacts.yml:23` | `  # Same time as the nightly build: 2:15 AM UTC` |

**Android API levels:** `grep -rn -E "\b(minSdkVersion|compileSdkVersion|targetSdkVersion|buildToolsVersion|ndkVersion|ndk_version|min_sdk|compile_sdk|target_sdk)\b" scripts packages/react-native/scripts` returned **0 matches**. No SDK/API-level constant lives in these directories.

### 10.3 Comments that contradict the code

| # | file:line | Comment | Contradiction |
|---|---|---|---|
| 1 | `scripts/releases/set-rn-artifacts-version.js:56-57` | ``  Updates relevant native files in the react-native package to materialize `` / ``  the given release version. This does not update package.json. `` | `updateReactNativeArtifacts` (`:76-85`) calls `updateTestFiles`, which **rewrites a committed Jest snapshot** in `packages/react-native/scripts/codegen/__tests__/__snapshots__/generate-artifacts-executor-test.js.snap` (`:127-145`). "Does not update package.json" is true but the help text omits the snapshot mutation. |
| 2 | `scripts/releases-ci/publish-updated-packages.js:33` | ``  Usage: node ./scripts/releases/publish-updated-packages.js `` | The file lives at `scripts/releases-ci/publish-updated-packages.js`; the printed path is wrong. |
| 3 | `scripts/cxx-api/README.md:11-18` table lists **6** snapshots (`ReactCommon/Debug|Release`, `ReactAndroid/Debug|Release`, `ReactApple/Debug|Release`) | "The pipeline produces one `.api` snapshot file per configured **API view × variant** combination" | The directory actually holds **9** committed `.api` files — `Newarch` variants exist for all three views and are unlisted in the README table. |
| 4 | `scripts/cxx-api/README.md:76` | documents `private_directories` + "a warning is printed" | No such key in `config.yml`, no such field in `config.py:28-41`, no such code path. |
| 5 | `scripts/cxx-api/README.md:58-63` "When to use it … files located in: `xplat/js/react-native-github/…`" | — | Those are **fbsource** paths, not paths in this repo (`packages/react-native/ReactCommon/` etc. per `config.yml:26,52-53,86-89`). |
| 6 | `AGENTS.md:56` (referenced by `package.json` docs) vs `scripts/build/babel/node.config.js:13` | Babel target `TARGET_NODE_VERSION = '18'` | `packages/react-native/package.json:24` declares `"engines": {"node": "^22.13.0 \|\| ^24.3.0 \|\| >= 26.0.0"}`; CI tests Node `24` and `22.13.0` (`test-all.yml:582`). The Babel target is 4+ majors behind the declared minimum. |
| 7 | `scripts/cxx-api/parser/snapshot_diff.py:37,45` | `print("Skipping comparison (no baseline to compare against)")` then `return True` | The string says "Skipping" but returning `True` makes the caller **report success** (`__main__.py:358` prints "All snapshot validations passed"). |
| 8 | `packages/react-native/scripts/codegen/generate-specs-cli-executor.js:36-41` | ``  createOutputDirectoryIfNeeded `` reassigns a `const` via `$FlowFixMe[reassign-const]` and defaults to `path.resolve(__dirname, '..', 'Libraries', libraryName)` | The default writes generated specs into the package's **`Libraries/`** tree, which is a shipped, non-generated directory (`packages/react-native/package.json:77`). In practice every in-repo caller passes an explicit `outputDir`, so this branch is only reachable from external callers. |
| 9 | `packages/react-native/scripts/spm/generate-spm-autolinking.js:1948` | `// AutolinkedAggregate is glue; needs at least one source file (Swift, so we` | Invariant asserted in a comment only; 未确认 whether enforced in code. |
| 10 | `packages/react-native/scripts/prepack.js:17-19` | `console.info('[Prepack] Copying README.md'); fs.copyFileSync('../../README.md', './README.md');` | Hard-codes a relative path `'../../README.md'`, so `main()` **only works when cwd is `packages/react-native`**. `yarn build --prepack` (`test-all.yml:622`) spawns the *other* prepack (`scripts/build/prepack.js`), not this one, so `packages/react-native`'s own `prepack` npm lifecycle hook is the only caller. |

---

### Measurement provenance

- Counts: `find … | wc -l`, `find … -print0 | xargs -0 wc -l | tail -1`, `grep -c`, `grep -o … | sort | uniq -c`, `wc -l` — all run from `react-native`.
- 30-largest table: `find … -print0 | xargs -0 wc -l | sort -rn | head -31` (excludes `api-snapshots/`, listed separately).
- Reference counts: `grep -rn <basename> --include=… . | grep -v node_modules`.
- Existence checks: `ls`, `test -d`, `git ls-files --error-unmatch`.
- No file in the repo was modified. The only file created is `docs/arch/audit/_probe_d1.md`.