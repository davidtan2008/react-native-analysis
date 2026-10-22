---
id: 76
title: "CLI 工具层：四个实测缺陷（丢失的 gradle 开关、删错目录的清理、缺 callback 的 `fs.rm`、写不出 source map 的 `-o`），以及 legacy 桥大字符串的 iOS 对照"
topic: TL.build
symptoms: [build, debug]
platforms: [cross, ios]
architecture: [cross, legacy]
layer: T4
symbols: ["assertDependencies", "isOnPath", "getNodePackagePath", "deleteDirectoryContents", "composeSourceMaps", "NSDataBigString", "RCTMessageThread", "RCTCxxBridgeDelegate"]
sourceRoot: react-native
claims: [CLI-1, CLI-2, CLI-3, CLI-4, CLI-5, CLI-6, CLI-7, CLI-8, CLI-9, CLI-10, CLI-11, CLI-12, CLI-13, CLI-14, CLI-15, CLI-16]
---
# 76 · CLI 工具层：四个实测缺陷，以及 legacy 桥大字符串的 iOS 对照

> **模块**：Z1 · `private/core-cli-utils/`（8 个文件）+ `packages/react-native/React/CxxBridge/`（5 个文件）
> + 证据文件（跨模块引用，见 §1.2）
>
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根）
> · **宿主侧工具**（macOS / Windows / Linux；CxxBridge 部分 **iOS 专属**） · **与架构无关**（CxxBridge 部分属 legacy 桥）
>
> **前置**：[49 文档](./49-构建工具链与静默失败.md) 记录构建链路的静默失败形态；
> [69 文档](./69-legacy桥的C++侧与静默丢弃.md) 记录 legacy 桥 C++ 侧的并发与静默丢弃；
> [71 文档](./71-大字符串与可见性宏.md) 记录 `JSBigString` 的两个 `isAscii()` 实现**恒返回 `true`**；
> [67 文档](./67-特性开关的四级继承链与未接CI的快照门禁.md) 记录「同一份定义被复制 N 份」的失效形态。
>
> 本文记录 **16** 条结论：
> ① **【核心】`assemble` 构造了 `-PhermesEnabled` / `-PnewArchEnabled` 却没传出去** —— 同一文件里的 `build` 传对了，是一处**复制粘贴缺陷**；
> ② **【核心】缓存清理删的是「目标目录的父目录」** —— `os.tmpdir()` 的父目录在 Linux 上是 **`/`**（实测）；
> ③ **【核心】`fs.rm` 不带 callback** → 返回 `undefined` 且**异步抛未捕获异常**（实测），正确 API 是 `fs.promises.rm`；
> ④ **【核心】`-o ${outputSourceMap}` 被拼成单个 argv** → 合成后的 source map **永不写出**（实测复刻解析）；
> ⑤ `getNodePackagePath` 用了 **`require.resolve` 不支持的 `{cwd}` 选项** —— 本仓其它 4 处都用 `{paths}`；且它有**两份逐字副本**；
> ⑥ **`execa` 在全仓任何 `package.json` 里都未声明**，靠传递依赖提升；
> ⑦ `version.js` 的注释指向一个**不存在的入口**（`versions.js` vs `version.js`）；
> ⑧ 它发布的 `NODE_JS: '>= 18'` 比**它自己的 `engines`** 更宽松；
> ⑨ **iOS 侧的 `NSDataBigString::isAscii()` 恒返回 `false`** —— 补上 71 文档 KKK-1 缺失的平台维度。

---

## 1. 文件构成

### 1.1 本轮读的 13 个文件（Z1 范围）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `private/core-cli-utils/src/index.js` | **22** | 入口（聚合 4 组 tasks + version） |
| `private/core-cli-utils/src/public/version.js` | **55** | **发布的**工具链版本要求表 |
| `private/core-cli-utils/src/private/types.js` | **18** | `Task` 类型定义 |
| `private/core-cli-utils/src/private/utils.js` | **82** | `task` 工厂、PATH 探测、依赖断言 |
| `private/core-cli-utils/src/private/app.js` | **248** | Metro 打包 + Hermes 字节码 + source map |
| `private/core-cli-utils/src/private/apple.js` | **240** | iOS bootstrap / build / install |
| `private/core-cli-utils/src/private/android.js` | **130** | Android assemble / build / install |
| `private/core-cli-utils/src/private/clean.js` | **228** | 各类缓存清理 |
| `packages/react-native/React/CxxBridge/NSDataBigString.h` | **41** | iOS 侧 `JSBigString` 实现（声明） |
| `packages/react-native/React/CxxBridge/NSDataBigString.mm` | **19** | 同上（实现） |
| `packages/react-native/React/CxxBridge/RCTMessageThread.h` | **39** | legacy 桥的 run loop 线程（声明） |
| `packages/react-native/React/CxxBridge/RCTMessageThread.mm` | **113** | 同上（实现） |
| `packages/react-native/React/CxxBridge/RCTCxxBridgeDelegate.h` | **32** | JS 执行器工厂的注入点 |

**合计 1267 行。** 另有 `src/electron/BuildInfo.js.tpl` 一类的非代码文件不计入范围。

### 1.2 证据文件（跨模块引用）

| 文件 | 归属模块 | 引用方式 | 用途 |
| --- | --- | --- | --- |
| `packages/react-native/scripts/compose-source-maps.js` | **D1** | 局部通读（:17-33、:62-63） | `-o` 参数的解析约定 |
| `packages/rn-tester/scripts/utils.js` | **排除**（`baseline.excluded`） | 局部通读（:76-104） | `Task.order` 的唯一消费方 |
| `packages/react-native/ReactCommon/cxxreact/JSBigString.h` | **Z1**（`ReactCommon/react/cxxstableapi` 之外的邻近目录） | 完整通读（59 行） | `c_str()` / `size()` 的基类契约 |
| `packages/react-native/React/Base/RCTJavaScriptLoader.h` | **C1**（iOS 平台层） | 局部通读（:40-98） | `RCTSource.data` 的属性与来源 |
| `packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm` | **C1** | 局部通读（:554-572） | `NSDataBigString` 的唯一构造点 |
| `packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTJSThreadManager.mm` | **C1** | 局部通读（:25-48） | `RCTMessageThread` 的唯一构造点 |

---

## 2. 【核心 CLI-1】`assemble` 构造了 `-PhermesEnabled` 却没传出去

### 2.1 两处 gradle 调用的逐字对照

```js
// private/core-cli-utils/src/private/android.js:76-89
    run: task(FIRST, 'Assemble Android App', () => {
      const args = [];
      if (config.hermes != null) {
        args.push(`-PhermesEnabled=${boolToStr(config.hermes)}`);
      }
      if (config.newArchitecture != null) {
        args.push(`-PnewArchEnabled=${boolToStr(config.newArchitecture)}`);
      }
      args.push(...gradleArgs);
      return gradle(`${config.name}:assemble${config.mode}`, gradleArgs, {
        cwd: config.cwd,
        env: {ANDROID_HOME: androidSdkPath(config.sdk)},
      });
    }),
```

**`args` 被完整构造出来，然后 `gradle()` 收到的是 `gradleArgs`。** —— `args` 是个**从未被使用**的局部变量。

### 2.2 同一文件里的 `build` 是对的

```js
// private/core-cli-utils/src/private/android.js:92-104
    run: task(FIRST, 'Assembles and tests Android App', () => {
      const args = [];
      if (config.hermes != null) {
        args.push(`-PhermesEnabled=${boolToStr(config.hermes)}`);
      }
      if (config.newArchitecture != null) {
        args.push(`-PnewArchEnabled=${boolToStr(config.newArchitecture)}`);
      }
      args.push(...gradleArgs);
      return gradle(`${config.name}:bundle${config.mode}`, args, {
        cwd: config.cwd,
        env: {ANDROID_HOME: androidSdkPath(config.sdk)},
      });
    }),
```

**唯一的差别就是最后一个参数：`gradleArgs` vs `args`。** 其余 8 行逐字相同。

### 2.3 后果

| task | gradle 任务名 | 传出的参数 | `-PhermesEnabled` / `-PnewArchEnabled` |
| --- | --- | --- | --- |
| `assemble` | `${name}:assemble${mode}` | **`gradleArgs`** | **丢失** |
| `build` | `${name}:bundle${mode}` | `args` | 保留 ✓ |
| `install` | `${name}:install${mode}` | `gradleArgs` | 本就没有（无 `args` 构造） |

**即：`assemble` 无法通过参数切换 Hermes / 新架构** —— 只能靠 `android/gradle.properties` 里的默认值。

**判定：缺陷（复制粘贴漏改）。这是本文四个核心缺陷中最直接的一个** —— 它不崩、不报错，**只是静默地不生效**。

### 2.4 附带的一处不对称：`install` 与 `assemble` 同形

`install` 传的也是 `gradleArgs`（`:114-121`），但它**没有构造 `args`**，所以是自洽的 —— 只有 `assemble` 是「构造了却不用」。

---

## 3. 【核心 CLI-2】缓存清理删的是「目标目录的**父目录**」

### 3.1 实现

```js
// private/core-cli-utils/src/private/clean.js:42-55
function deleteDirectoryContents(
  directory /*: string */,
  filePattern /*: RegExp */
) /*: () => Promise<void> */ {
  return async function deleteDirectoryContentsAction() {
    const base = path.dirname(directory);
    const files = readdirSync(base).filter((filename /*: string */) =>
      filePattern.test(filename),
    );
    for (const filename of files) {
      rmrf(path.join(base, filename));
    }
  };
}
```

**函数名与注释都说「清理 `directory` 的内容」，实现却取 `path.dirname(directory)` 作为扫描基准。**

### 3.2 唯一的调用方把 `os.tmpdir()` 传了进去

```js
// private/core-cli-utils/src/private/clean.js:71-75
function deleteTmpDirectoryContents(
  filepattern /*: RegExp */
) /*: () => Promise<void> */ {
  return deleteDirectoryContents(os.tmpdir(), filepattern);
}
```

### 3.3 实测：Linux 上父目录是 `/`

```text
os.tmpdir()        = /tmp
path.dirname(tmp)  = /
```

**即：`deleteTmpDirectoryContents(/^metro-.+/)` 扫描的是文件系统根目录 `/`，而不是 `/tmp`。**

macOS 上 `os.tmpdir()` 是 `/var/folders/<xx>/<yy>/T` → 父目录是 `/var/folders/<xx>/<yy>` → **同样不是临时目录本身**。

### 3.4 三个清理任务的实际目标

```js
// private/core-cli-utils/src/private/clean.js:142-158
  metro: () => ({
    metro: task(
      FIRST,
      '🧹 Clean Metro cache',
      deleteTmpDirectoryContents(/^metro-.+/),
    ),
    haste: task(
      FIRST,
      '🧹 Clean Haste cache',
      deleteTmpDirectoryContents(/^haste-map-.+/),
    ),
    react_native: task(
      FIRST,
      '🧹 Clean React Native cache',
      deleteTmpDirectoryContents(/^react-.+/),
    ),
  }),
```

| task | 模式 | 实际扫描目录（Linux） | Metro 真实缓存所在 |
| --- | --- | --- | --- |
| `metro` | `/^metro-.+/` | **`/`** | `/tmp/metro-*` |
| `haste` | `/^haste-map-.+/` | **`/`** | `/tmp/haste-map-*` |
| `react_native` | `/^react-.+/` | **`/`** | `/tmp/react-*` |

**双重后果**：

1. **清理无效** —— 真正的缓存在 `/tmp` 里，**删不掉**；
2. **误删风险** —— 反而会去删**根目录**下碰巧匹配 `metro-*` / `haste-map-*` / `react-*` 的条目。

**判定：缺陷（对参数语义的理解与函数名/注释相反）。** 正确写法应是直接用 `directory` 而非 `path.dirname(directory)`。

---

## 4. 【核心 CLI-3】`fs.rm` 不带 callback → 异步抛未捕获异常

### 4.1 实现

```js
// private/core-cli-utils/src/private/clean.js:31-36
const rmrf = (pathname /*: string */) => {
  if (!existsSync(pathname)) {
    return;
  }
  rm(pathname, {force: true, maxRetries: 3, recursive: true});
};
```

`rm` 来自 `const {existsSync, readdirSync, rm} = require('node:fs');`（`:24`）—— 是 **`fs.rm`**，不是 `fs.promises.rm`。

**调用既没有 `await`，也没有 `callback`。**

### 4.2 实测（Node v24.22.1）

```text
fs.rm(path) 无 opts 无 cb → 返回 undefined
    ↳ 异步未捕获异常: TypeError callback is not a function

fs.rm(path, cb) → cb err = [Error: ENOENT: ...]      ← 带 callback 时正常
fs.promises.rm(...) → 是 Promise: true                  ← 正确的异步 API
```

**`fs.rm(path, options)` 在不传 callback 时返回 `undefined`（**不是 Promise**），并在异步完成回调里抛 `TypeError: callback is not a function`。**

### 4.3 后果

`rmrf` 只在路径**存在**时才调 `fs.rm`（`:32-34` 的 `existsSync` 提前返回）—— 所以：

| 场景 | 结果 |
| --- | --- |
| 路径不存在 | 提前返回，**无异常** ✓ |
| **路径存在** | **异步抛未捕获 `TypeError` → 进程终止** ✗ |

**即：清理越「成功」，越会崩溃。** 且异常是**异步**抛出的 —— 调用方的 `await` **捕获不到**，也没有任何 `try/catch` 能拦住。

**判定：缺陷（用错了 API 形态）。正确写法是 `fs.promises.rm`（可 `await`）或 `fs.rm(path, opts, cb)`。**

### 4.4 与 §3 的叠加

CLI-2 让清理**指向了错误的目录**；CLI-3 让清理**在指向正确目录时崩溃**。两者叠加后，`clean.metro` 这三个 task 实际上**既不会删掉目标缓存，又会在命中任何条目时终止进程**。

---

## 5. 【核心 CLI-4】`-o` 被拼成单个 argv → source map 永不写出

### 5.1 调用侧

```js
// private/core-cli-utils/src/private/app.js:223-236
    const metroSourceMap = output.replace(/(\.js)?$/, '.map');
    const hermesSourceMap = options.outputBundle + '.map';
    const compose = execa(
      'node',
      [
        composeSourceMaps,
        metroSourceMap,
        hermesSourceMap,
        `-o ${options.outputSourceMap}`,
      ],
      {
        cwd: options.cwd,
      },
    );
```

**`-o` 与输出路径被拼成**一个** argv 元素** `"-o /path/to.map"`。

### 5.2 被调用侧的解析约定

```js
// packages/react-native/scripts/compose-source-maps.js:17-26
const argv = process.argv.slice(2);
let outputPath;
for (let i = 0; i < argv.length;) {
  if (argv[i] === '-o') {
    outputPath = argv[i + 1];
    argv.splice(i, 2);
  }
```

**它比对的是 `argv[i] === '-o'`（严格等于单独的 `-o`）**，并从 `argv[i + 1]` 取值。

### 5.3 实测：复刻该解析逻辑

```text
app.js 的写法 → {"rest":["/tmp/a.map","/tmp/b.map","-o /tmp/out.map"]}      ← outputPath 为 undefined
脚本期望的写法 → {"outputPath":"/tmp/out.map","rest":["/tmp/a.map","/tmp/b.map"]}
```

**`outputPath` 始终是 `undefined`** → 而写出文件的分支是：

```js
// packages/react-native/scripts/compose-source-maps.js:62-63
  if (outputPath != null) {
    fs.writeFileSync(outputPath, composedMapJSON, 'utf8');
```

**→ 合成的 source map 从不落盘。**

### 5.4 后果与后续

`bundle.compose` 是 Hermes + Metro 两份 source map 的合成步骤（`private/core-cli-utils/src/private/app.js:217`）。它失败后：

- `compose.finally(...)` 仍然会删掉两份中间 source map（`:237-240`）→ **中间产物被清理，用户却拿不到合成结果**；
- 而 `-output-source-map` 已经让 hermesc 生成了 Hermes 侧的 `.map`（`:209-211`）→ **Hermes 的 map 存在、Metro 的 map 被删、合成结果不存在**。

**判定：缺陷（参数形态与被调用方的约定不符）。** 修法是把 `'-o'` 与 `options.outputSourceMap` 拆成两个数组元素。

---

## 6. 【核心 CLI-5】`require.resolve` 不支持 `{cwd}` 选项

### 6.1 两处逐字相同的实现

```js
// private/core-cli-utils/src/private/app.js:86-89
function getNodePackagePath(packageName /*: string */) /*: string */ {
  // $FlowFixMe[prop-missing] type definition is incomplete
  return require.resolve(packageName, {cwd: [process.cwd(), ...module.paths]});
}
```

```js
// private/core-cli-utils/src/private/apple.js:81-84
function getNodePackagePath(packageName /*: string */) /*: string */ {
  // $FlowFixMe[prop-missing] type definition is incomplete
  return require.resolve(packageName, {cwd: [process.cwd(), ...module.paths]});
}
```

**两份逐字相同**（含同一句 `$FlowFixMe` 注释）。

### 6.2 `require.resolve` 的选项名是 `paths`，不是 `cwd`

Node 文档：`require.resolve(request[, options])`，其中 `options.paths` 是「用于解析模块位置的路径列表；存在时**取代默认解析路径**」。

**`cwd` 不是 `require.resolve` 的选项** —— 它会被**静默忽略**，解析退回**调用方模块自身**的查找路径。

### 6.3 受控实验（`foo` 只在「别处」可解析）

```text
无 options（从本模块向上找：应失败） → 抛错 MODULE_NOT_FOUND
{cwd:[elsewhere]}（本代码用的写法）      → 抛错 MODULE_NOT_FOUND   ← 选项被忽略
{paths:[elsewhere]}（正确写法）          → /tmp/.../node_modules/foo/index.js
```

**`{cwd: [...]}` 与「不传 options」的行为完全一致** —— 证明它被忽略。

### 6.4 本仓其它 4 处都用 `{paths}`

| 位置 | 写法 |
| --- | --- |
| `packages/react-native/react-native.config.js:41` | `require.resolve(spec, {paths: [startDir]})` |
| `packages/react-native/scripts/spm/__tests__/remove-spm-injection-test.js:189` | `require.resolve('hermes-compiler/package.json', {paths: [rnRoot]})` |
| `packages/react-native/scripts/spm/__tests__/download-spm-artifacts-test.js:102` | 注释中明确写 `require.resolve({paths: [rnRoot]})` |
| `packages/jest-preset/jest/__tests__/preset-react-native-dep-test.js:100` | `require.resolve('react-native', {paths: [isoDir]})` |

**全仓只有这两份副本用 `{cwd}`。** 这正是 67 文档 GGG-1 记录的形态 —— **同一份定义被复制 N 份、只有 1 份被更新过**（这里是**两份都没被更新过**）。

### 6.5 实际影响

**「从 `process.cwd()` 解析」的意图没有实现。** 实际解析基准是 **`core-cli-utils` 自己的模块位置**，逐级向上找 `node_modules`：

| 场景 | 实际解析到的 `react-native` | 是否符合意图 |
| --- | --- | --- |
| monorepo 内 | 仓库根 `node_modules/react-native` | 恰好一致 ✓ |
| 普通 app（`core-cli-utils` 与 `react-native` 同级） | app 的 `node_modules/react-native` | 恰好一致 ✓ |
| **workspace / 多版本并存** | **由 `core-cli-utils` 的物理位置决定** | **可能不是 app 用的那个** ✗ |

**判定：结构脆弱（选项名写错；当前两种常见布局下恰好能工作）。** 那句 `$FlowFixMe[prop-missing] type definition is incomplete` 把「类型定义不完整」当成了原因，**但真实原因是选项名写错** —— Flow 类型确实没有 `cwd`，可正确的 `paths` 它也没有。

---

## 7. 【核心 CLI-6】`execa` 是未声明依赖，且 `getNodePackagePath` 有两份副本

### 7.1 声明面

```json
// private/core-cli-utils/package.json
  "dependencies": {
    "metro-babel-register": "^0.87.0"
  },
```

**只声明了一个依赖。** 而 5 个源文件里 `require('execa')`、1 个文件里 `require('debug')`。

### 7.2 全仓检索：`execa` 在任何 `package.json` 里都未声明

```text
$ grep -rn '"execa"' --include="package.json" . | grep -v node_modules
（无输出）
```

**`execa` 只出现在 `yarn.lock` 里**，作为传递依赖：

```text
"@react-native-community/cli@20.2.0":        execa "^5.0.0"
"@react-native-community/cli-clean@20.2.0":   execa "^5.0.0"
"@react-native-community/cli-doctor@20.2.0":   execa "^5.0.0"
"@react-native-community/cli-tools@20.2.0":    execa "^5.0.0"
jest-changed-files@^29.7.0:                    execa "^5.0.0"
```

**即：`core-cli-utils` 的 `require('execa')` 完全依赖 yarn 的提升（hoisting）** —— 一旦上游 `@react-native-community/cli` 换掉或移除 `execa`，本包会在运行时 `MODULE_NOT_FOUND`。

`debug` 稍好：它在**仓库根**的 `devDependencies` 里（`^4.4.0`），同样靠提升。

### 7.3 消费方是真实存在的

```json
// packages/rn-tester/package.json:66
    "@react-native/core-cli-utils": "*",
// private/helloworld/package.json:24
    "@react-native/core-cli-utils": "*",
```

`packages/rn-tester/cli.flow.js:12` 与 `private/helloworld/cli.flow.js:21` 都 import 了它。

### 7.4 判定

**这是「phantom dependency」** —— 与 62 文档 CxxStableAPI 的「三档 Guard 默认全惰性」不同，这里是**依赖声明缺失**，属于**结构脆弱**。

> 注：`core-cli-utils` 的 `package.json` 标了 `"private": true` —— 它**不会单独发布**，只在 monorepo 内被引用；这降低了风险面，但没有消除「靠提升」这一事实。

---

## 8. 【核心 CLI-7】`isOnPath` 的 `exitCode === 0` 是死判定

### 8.1 实现

```js
// private/core-cli-utils/src/private/utils.js:44-62
function isOnPath(
  dep /*: string */,
  description /*: string */,
) /*: PathCheckResult */ {
  const cmd = isWindows ? ['where', [dep]] : ['command', ['-v', dep]];
  try {
    return {
      dep,
      description,
      found: execa.sync(...cmd).exitCode === 0,
    };
  } catch {
    return {
      dep,
      description,
      found: false,
    };
  }
}
```

### 8.2 实测（execa 5.1.1）

```text
execa.sync('sh', ['-c', 'exit 3'])
  → 抛异常 → err.exitCode = 3
     （message: "Command failed with exit code 3: sh -c exit 3"）
```

**`execa.sync` 在非零退出时**抛异常**（默认 `reject: true`），不会把结果对象返回给调用方。**

### 8.3 后果：`=== 0` 只在成功路径上被求值

| 命令状态 | `execa.sync` 行为 | `found` 的实际来源 |
| --- | --- | --- |
| 存在（退出码 0） | 返回结果对象 | `exitCode === 0` → `true` |
| **不存在（退出码 ≠ 0）** | **抛异常** → `catch` | **`catch` 分支 → `false`** |

**`.exitCode === 0` 这个比较从未产生过 `false`。** 「找不到」这个判定**完全由异常驱动**。

实测复刻 `isOnPath`：

```text
存在的命令 (node):            {"found":true}
不存在的命令:                  {"found":false}
```

**→ 行为正确，但判定机制与代码字面不符。**

**判定：历史承诺（代码看起来在检查退出码，实际只依赖异常）。** 这不是 bug，但**它让「非零但存在」的命令（如 `where` 在某些 shell 下返回 1）无法被区分** —— 一旦上游 `execa` 改默认值（`reject: false`），语义会从「异常驱动」静默变成「退出码驱动」，而 `.exitCode === 0` 这时才开始真正起作用。

### 8.4 `assertDependencies` 的错误信息是好的

```js
// private/core-cli-utils/src/private/utils.js:64-72
function assertDependencies(
  ...deps /*: ReadonlyArray<ReturnType<typeof isOnPath>> */
) {
  for (const {found, dep, description} of deps) {
    if (!found) {
      throw new Error(`"${dep}" not found, ${description}`);
    }
  }
}
```

**✓ 正面**：错误信息带上了**是哪个依赖**和**它是干什么的**（`description` 由调用方给，如 `'CocoaPods'`、`'Gradle wrapper'`）。

---

## 9. 【核心 CLI-8】`version.js` 的注释指向一个不存在的入口

### 9.1 注释怎么说

```js
// private/core-cli-utils/src/public/version.js:17-27
// The version of @react-native/core-cli-utils matches a particular version
// of react-native.  For example:
//
// > npm info @react-native/core-cli-util@latest --json | jq '.version'
// > "0.75.0"
//
// Means that:
// > require('@react-native/core-cli-utils/versions.js').apple.XCODE
// > ">= 12.x"
//
// For react-native@0.75.0 you have to have a version of XCode >= 12
```

### 9.2 `exports` 实际上只放行了 `./version.js`（单数）

```json
// private/core-cli-utils/package.json
  "exports": {
    ".": "./src/index.js",
    "./package.json": "./package.json",
    "./version.js": "./src/public/version.js"
  },
```

### 9.3 实测

```text
exports 键: ., ./package.json, ./version.js
注释声称的入口: @react-native/core-cli-utils/versions.js  → ✗ 不在 exports 里
实际存在的入口: @react-native/core-cli-utils/version.js   → ✓ 存在
```

**按注释写 `require('@react-native/core-cli-utils/versions.js')` 会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。**

### 9.4 注释里还有第二处不一致

```js
// private/core-cli-utils/src/public/version.js:20
// > npm info @react-native/core-cli-util@latest --json | jq '.version'
```

**包名写成了 `@react-native/core-cli-util`（单数）**，而实际包名是 `@react-native/core-cli-utils`。

**判定：历史承诺（注释描述的入口不存在）。** 这正是 71 文档 KKK-3 记录的形态 —— **注释描述的能力不存在**。

---

## 10. 【核心 CLI-9】发布的 `NODE_JS: '>= 18'` 比它自己的 `engines` 更宽松

### 10.1 它发布的表

```js
// private/core-cli-utils/src/public/version.js:39-46
const common = {
  BUN: '>= 1.0.0',
  JAVA: '>= 17 <= 20',
  NODE_JS: '>= 18',
  NPM: '>= 4.x',
  RUBY: '>= 2.6.10',
  YARN: '>= 1.10.x',
};
```

### 10.2 它自己的 `engines`

```json
// private/core-cli-utils/package.json
  "engines": {
    "node": "^22.13.0 || ^24.3.0 || >= 26.0.0"
  },
```

### 10.3 实测对照

```text
core-cli-utils 的 engines      : ^22.13.0 || ^24.3.0 || >= 26.0.0
version.js 发布的 NODE_JS 要求: >= 18
react-native 包的 engines      : ^22.13.0 || ^24.3.0 || >= 26.0.0
```

**这份「供使用者检查自己环境」的表，声明的 node 要求比包自己的 `engines` 低了一个大版本。** 用 `>= 18` 判断「环境是否满足」会**放行一个本包根本跑不起来的环境**。

**判定：历史承诺（对外发布的约束与自身约束不一致）。** 表里的其它条目（`JAVA: '>= 17 <= 20'` 等）无法在本仓库核实，**本文不断言它们是否准确**。

---

## 11. 【核心 CLI-10】`checkPodfileInSyncWithManifest` 抛出的错误被自己的 `catch` 捕获

```js
// private/core-cli-utils/src/private/apple.js:58-73
function checkPodfileInSyncWithManifest(
  lockfilePath /*: string */,
  manifestLockfilePath /*: string */,
) {
  try {
    const expected = fs.readFileSync(lockfilePath, 'utf8');
    const found = fs.readFileSync(manifestLockfilePath, 'utf8');
    if (expected !== found) {
      throw new Error(
        'Please run: yarn bootstrap ios, Podfile.lock and Pods/Manifest.lock are out of sync',
      );
    }
  } catch (e /*: unknown */) {
    throw new Error('Please run: yarn run bootstrap ios: ' + String(e));
  }
}
```

### 11.1 两条命令提示不一致

| 位置 | 提示的命令 |
| --- | --- |
| 内层 `throw`（`:67`） | `yarn bootstrap ios` |
| 外层 `catch` 重新包装（`:71`） | `yarn run bootstrap ios` |

**内层那个 `throw` 就在 `try` 块里 → 被自己的 `catch` 捕获 → 被重新包装。**

### 11.2 最终错误信息

```text
Please run: yarn run bootstrap ios: Error: Please run: yarn bootstrap ios, Podfile.lock and Pods/Manifest.lock are out of sync
```

**信息没有丢**（内层文案通过 `String(e)` 保留了），但**首尾两条命令提示互相矛盾**，且整条消息被套了两层 `Please run:`。

### 11.3 `catch` 同时兜住了「文件不存在」

`fs.readFileSync` 抛出的 ENOENT 也走同一条 `catch` → 用户看到的是同一句「请跑 bootstrap」，但**真实原因（文件缺失 vs 内容不同）无法区分**。

**判定：结构脆弱（`try` 块内自抛自捕）。** 正确做法是把「比较」放进 `try` 外的独立分支，或给内层错误加标记。

---

## 12. CLI-11 Metro 的两个恒定开关

```js
// private/core-cli-utils/src/private/app.js:91-94
function metro(...args /*: ReadonlyArray<string> */) /*: ExecaPromise */ {
  log(`🚇 metro ${args.join(' ')} `);
  return execa('npx', ['--offline', 'metro', ...args]);
}
```

### 12.1 `--offline` 恒定

**`npx --offline`** —— npm 的 `--offline` 表示「**只从本地缓存取包，绝不访问网络**」。

**→ Metro 永远无法通过 `npx` 自动下载缺失的依赖。** 若本地没有 `metro` 可执行文件，`npx --offline` 会直接失败。

### 12.2 `--reset-cache` 恒定

```js
// private/core-cli-utils/src/private/app.js:141-159
    javascript: task(SECOND, 'Metro generating an .jsbundle', () => {
      const args = [
        '--platform',
        options.platform,
        '--dev',
        options.dev ? 'true' : 'false',
        '--reset-cache',
        '--out',
        output,
      ];
```

**`--reset-cache` 被无条件写进数组**（不像 `--minify` / `--source-map` 那样有条件分支）→ **每次 `metro build` 都重置 Metro 的转换缓存**。

### 12.3 判定

| 项 | 判定 |
| --- | --- |
| `--offline` | **有意的取舍**（离线构建）—— 但**注释与文档均未说明**，使用者遇到「npx 装不上 metro」时无从判断 |
| `--reset-cache` | **有意的取舍**（发布构建取全新产物）—— 但**开发模式（`dev: true`）同样带它**，而 dev 模式下 `metro build` 通常用于出调试包 |

**本文不断言二者构成功能缺陷**，只记录「**恒定且无注释说明**」这一事实。

---

## 13. 【核心 CLI-12】iOS 侧 `isAscii()` 恒返回 `false` —— 补上 71 文档缺失的平台维度

### 13.1 本仓的四个 `isAscii()` 实现

71 文档 KKK-1 记录了 **C++ 侧的两个**：

| 实现 | 位置 | `isAscii()` |
| --- | --- | --- |
| `JSBigBufferString` | `packages/react-native/ReactCommon/cxxreact/JSBigString.cpp` | **恒 `true`**（乐观） |
| `JSBigFileString` | 同上 | **恒 `true`**（乐观） |
| `JSBigStdString` | 同上 | 由构造参数决定，**默认 `false`**（保守） |
| **`NSDataBigString`** | **`packages/react-native/React/CxxBridge/NSDataBigString.h`** | **恒 `false`**（保守）← **本文新增** |

```cpp
// packages/react-native/React/CxxBridge/NSDataBigString.h:19-23
  // The ASCII optimization is not enabled on iOS
  bool isAscii() const override
  {
    return false;
  }
```

### 13.2 为什么这补的是「平台维度」

71 文档 §2.1 的表格只列了 C++ 侧三个实现，因此当时的结论是「**两个 `isAscii()` 恒返回 `true`**」，并据此指出 Android 的 bundle 主加载路径会「声明整个 bundle 是纯 ASCII」。

**加入 iOS 实现后，完整的图景是**：

| 平台 | 加载路径走的实现 | `isAscii()` |
| --- | --- | --- |
| **Android** | `JSBigBufferString`（C++ 侧） | **恒 `true`** —— 乐观，**可能撒谎** |
| **iOS** | `NSDataBigString`（ObjC 侧） | **恒 `false`** —— 保守，**不会撒谎但放弃了优化** |

**同一份 JS bundle，两端的 ASCII 判定完全相反，且两侧都是「恒定值」而非实测值。**

### 13.3 判定

**iOS 侧的实现是安全的**（保守方向），**问题不在它这里** —— 它把问题**暴露**出来了：**C++ 侧恒 `true` 的实现没有 iOS 这样的对照物**。

**这是 71 文档 KKK-1 的重要补全**：原文的「两个实现恒 true」读起来像是个别实现的疏忽；加上 iOS 的恒 `false` 后，更准确的表述是 —— **`isAscii()` 在四个实现里全部是「写死的常量」，没有一个真正检查内容**，而两端恰好取了**相反**的方向。

---

## 14. 【核心 CLI-13】`NSDataBigString::size()` 违反基类「不含 NUL」的契约

### 14.1 基类契约

```cpp
// packages/react-native/ReactCommon/cxxreact/JSBigString.h:46-52
  virtual bool isAscii() const = 0;

  // This needs to be a \0 terminated string
  virtual const char *c_str() const = 0;

  // Length of the c_str without the NULL byte.
  size_t size() const override = 0;
```

**基类明写两条**：

1. `c_str()` **必须是 `\0` 结尾的字符串**；
2. `size()` 是「**不含 NULL 字节**的长度**」。

### 14.2 iOS 侧的实现

```cpp
// packages/react-native/React/CxxBridge/NSDataBigString.h:14-33
class NSDataBigString : public JSBigString {
 public:
  // The NSData passed in must be be null-terminated.
  NSDataBigString(NSData *data);

  // The ASCII optimization is not enabled on iOS
  bool isAscii() const override
  {
    return false;
  }

  const char *c_str() const override
  {
    return (const char *)[m_data bytes];
  }

  size_t size() const override
  {
    return m_length;
  }
```

```cpp
// packages/react-native/React/CxxBridge/NSDataBigString.mm:12-16
NSDataBigString::NSDataBigString(NSData *data)
{
  m_data = data;
  m_length = [m_data length];
}
```

**`m_length` 是 `NSData` 的长度** —— 若该 NSData 以 `\0` 结尾（这正是头注释要求的前提），则 **`m_length` 包含那个 NUL**，而基类要求 `size()` **不含** NUL。

**→ `size()` 比基类契约多 1。**

### 14.3 前置条件由谁保证

**头注释把 null 结尾写成了调用方的前置条件**：

```cpp
// packages/react-native/React/CxxBridge/NSDataBigString.h:16
  // The NSData passed in must be be null-terminated.
```

而唯一的构造点是：

```cpp
// packages/react-native/ReactCommon/react/runtime/platform/ios/ReactCommon/RCTInstance.mm:561
  auto script = std::make_unique<NSDataBigString>(source.data);
```

`source.data` 的声明是：

```objc
// packages/react-native/React/Base/RCTJavaScriptLoader.h:50
@property (strong, nonatomic, readonly) NSData *data;
```

**`NSData` 本身不保证 `\0` 结尾** —— 它的契约只有「字节数」。而同一个头文件里还写着 `self.data` 在某些 bundle 格式下「指向 bundle 头部」（`:53-57`）。

### 14.4 生命周期（这一处是安全的）

`RCTSource.data` 是 `strong` 属性，`source` 是 `_loadScriptFromSource:` 的参数，`script`（`NSDataBigString`）也在同一作用域内 → **`NSDataBigString` 生命周期内 NSData 不会被释放** ✓。

但 `NSDataBigString` 自身**不持有 NSData 的所有权**（`m_data` 是裸指针，无 retain）—— 安全性完全依赖「构造方持有」这个外部事实。

### 14.5 可验证的下游影响（一处）

```cpp
// packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp:396
  if (script->size() == 0) {
```

**空脚本判定** —— 由于 `size()` 多算了结尾 NUL，**一个「长度 0 但带 NUL」的 NSData 会让 `size()` 返回 1**，从而绕过这个空检查。

**更下游的「把 `size()` 字节当作 JS 源码」的消费方在 Hermes（仓库外）与 jsinspector-modern 中 —— 本文不断言其后果**（§3.6 公平性纪律）。

**判定：结构脆弱（`size()` 偏离基类契约；null 结尾的前置条件由调用方口头保证，无校验）。**

---

## 15. 【核心 CLI-14】`RCTMessageThread::runSync` 的无界等待与其自认的前置条件

### 15.1 实现

```cpp
// packages/react-native/React/CxxBridge/RCTMessageThread.mm:50-64
// This is analogous to dispatch_sync
void RCTMessageThread::runSync(std::function<void()> func)
{
  if (m_cfRunLoop == CFRunLoopGetCurrent()) {
    func();
    return;
  }

  dispatch_semaphore_t sema = dispatch_semaphore_create(0);
  runAsync([func = std::make_shared<std::function<void()>>(std::move(func)), &sema] {
    (*func)();
    dispatch_semaphore_signal(sema);
  });
  dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER);
}
```

**`dispatch_semaphore_wait(sema, DISPATCH_TIME_FOREVER)` —— 无超时、无上限。**

### 15.2 类注释自认的前置条件

```cpp
// packages/react-native/React/CxxBridge/RCTMessageThread.mm:16-21
// A note about the implementation: This class is not used
// generically.  It's a thin wrapper around a run loop which
// implements a C++ interface, for use by the C++ xplat bridge code.
// This means it can make certain non-generic assumptions.  In
// particular, the sync functions are only used for bridge setup and
// teardown, and quitSynchronous is guaranteed to be called.
```

**「the sync functions are only used for bridge setup and teardown, and quitSynchronous is guaranteed to be called」** —— 这是一条**运行时不被检查**的前置条件。

### 15.3 这个前置条件唯一被检查的地方是析构函数

```cpp
// packages/react-native/React/CxxBridge/RCTMessageThread.mm:31-35
RCTMessageThread::~RCTMessageThread()
{
  RCTAssert(m_shutdown, @"RCTMessageThread: quitSynchronous() not called before destructor");
  CFRelease(m_cfRunLoop);
}
```

**✓ 这是本仓少见的「把契约做成可执行断言」** —— 但它是**析构期**的检查，只在**已经泄漏之后**才报，且此时 `runSync` 可能早已**永久阻塞**。

### 15.4 阻塞场景

`runSync` 的语义是「把函数投递到 **另一个线程** 的 run loop 上并等它执行完」。若那个 run loop **不再被驱动**（线程退出、run loop 已 stop、或 `CFRunLoopPerformBlock` 的 block 永远不被执行）：

- `dispatch_semaphore_wait(..., DISPATCH_TIME_FOREVER)` → **永久挂起**；
- 没有任何超时、没有 `m_shutdown` 检查（`runSync` 本身不检查 `m_shutdown`，只有 `runOnQueue`/`runOnQueueSync` 检查）。

**`quitSynchronous()` 本身就走 `runSync`**：

```cpp
// packages/react-native/React/CxxBridge/RCTMessageThread.mm:98-103
void RCTMessageThread::quitSynchronous()
{
  m_shutdown = true;
  runSync([] {});
  CFRunLoopStop(m_cfRunLoop);
}
```

**→ 关闭流程本身依赖一个无界等待。**

### 15.5 与 69 文档的对照

69 文档 III-1 记录了 legacy 桥 C++ 侧「**该加锁没加**」与「**加了锁但持锁过长**」两种并发形态。**本文这条是第三种形态**：**没有锁，也没有超时** —— 靠注释保证「不会走到这里」。

**判定：自认边界（注释明确写出了前置条件与它成立的理由）** —— 但前置条件**没有任何运行期保护**。

---

## 16. CLI-15 `RCTCxxBridgeDelegate` 的默认执行器

```objc
// packages/react-native/React/CxxBridge/RCTCxxBridgeDelegate.h:21-31
@protocol RCTCxxBridgeDelegate <RCTBridgeDelegate>

/**
 * In the RCTCxxBridge, if this method is implemented, return an
 * ExecutorFactory instance which can be used to create the executor.
 * If not implemented, or returns an empty pointer, JSIExecutorFactory
 * will be used with a JSCRuntime.
 */
- (std::unique_ptr<facebook::react::JSExecutorFactory>)jsExecutorFactoryForBridge:(RCTBridge *)bridge;

@end
```

### 16.1 契约的三条

| 条件 | 结果 |
| --- | --- |
| 实现了且返回非空工厂 | 用该工厂 |
| **未实现** | **JSIExecutorFactory + JSCRuntime** |
| 实现了但**返回空指针** | **JSIExecutorFactory + JSCRuntime** |

**→ 默认路径是 JSI + JSCRuntime**（不是 JSC）。

### 16.2 一个纯 ObjC 的实现方需要做什么

这个协议的方法签名里带 `std::unique_ptr<facebook::react::JSExecutorFactory>` —— **要实现它就必须能构造 C++ 工厂**。

文件头注释解释了它为何是独立文件：

```objc
// packages/react-native/React/CxxBridge/RCTCxxBridgeDelegate.h:18-19
// This is a separate class so non-C++ implementations don't need to
// take a C++ dependency.
```

**即：纯 ObjC 的宿主可以完全忽略这个协议**（不实现即可），但**一旦要自定义执行器，就必须引入 C++**。

**判定：正面 —— 契约的三条分支都写清楚了，且默认值被显式声明。**

---

## 17. CLI-16 `Task.order` 确实被消费（且依赖 sort 的稳定性）

`Task` 类型定义：

```js
// private/core-cli-utils/src/private/types.js:11-17
/*::
export type Task<R = unknown> = {
  order: number,
  label: string,
  action: () => R,
};
*/
```

### 17.1 唯一的消费方

```js
// packages/rn-tester/scripts/utils.js:85-102
  let ordered: MixedTasks[] = [];
  for (const [label, task] of Object.entries(tasks)) {
    if (label in exclude) {
      continue;
    }
    ordered.push(task);
  }
  ordered = ordered.sort((a, b) => a.order - b.order);

  const spec: TaskSpec<void>[] = ordered.map(task => ({
    title: task.label,
    task: () => {
      const action = task.action();
      if (action != null) {
        return observe(action);
      }
    },
  }));
```

**`order` 被真正用于排序** —— 这也纠正了一个容易得出的错误推断：**`order` 不是装饰字段**。

### 17.2 但排序的正确性依赖 **稳定排序**

`app.js` 的 `bundleApp` 里，三个任务的 `order` 与**对象键的插入顺序不一致**：

| 任务 | `order` | 在返回对象中的插入位置 |
| --- | --- | --- |
| `javascript` | `SECOND`（2） | **第 1 个**（对象字面量里先创建） |
| `sourcemap` | `FIRST`（1） | 第 2 个（后赋值） |
| `validateHermesc` | `FIRST`（1） | 第 3 个（后赋值） |
| `convert` | `THIRD`（3） | 第 4 个 |
| `compose` | `FOURTH`（4） | 第 5 个 |

**只有当 `Array.prototype.sort` 稳定时，`order` 相同的两个任务（`sourcemap` / `validateHermesc`）的相对次序才由键序决定、且 `javascript` 会被正确排到它们之后。**

ES2019 起 `sort` 规范要求稳定 → **当前行为正确**。

### 17.3 判定

**正面**：`order` 被真实消费，且在 ES2019+ 的稳定排序语义下行为正确。

**但**：`apple.js` 的 `build` 里 `validate` 与 `hasPodsInstalled` **都是 `FIRST`** → 它们的相对次序**完全依赖键序**；而 `app.js` 里 `validate`（1）与 `sourcemap`（1）、`validateHermesc`（1）**三者同为 1**。

**→ 「order 只表达相对档位、档内靠键序」这一约定在代码里没有任何注释说明** —— 属于**契约未文档化**，而非缺陷。

---

## 18. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **CLI-1** | **【核心】`assemble` 构造了 `-PhermesEnabled` / `-PnewArchEnabled` 却把 `gradleArgs` 传给了 `gradle()`** —— `args` 是从未被使用的局部变量；同文件的 `build` 传的是 `args` | `private/core-cli-utils/src/private/android.js:77-88`（对比 `:93-104`） | **不崩不报错，只是静默不生效** —— `assemble` 无法按参数切换 Hermes / 新架构；**同一文件内 8 行逐字相同、只差最后一个参数** → 复制粘贴缺陷 |
| **CLI-2** | **【核心】缓存清理扫的是 `path.dirname(directory)`** —— 函数名与注释都说清理「该目录的内容」，实现却用其**父目录** | `private/core-cli-utils/src/private/clean.js:47`；`:71-75`、`:142-158` | **实测 `os.tmpdir()='/tmp'` → `dirname` 为 `/`** → Metro / Haste / React Native 三个缓存清理**扫的是文件系统根目录**；真缓存在 `/tmp` 里**删不掉**，反而可能**误删根目录下的同名条目** |
| **CLI-3** | **【核心】`fs.rm` 不带 callback** → 返回 `undefined`（不是 Promise）并**异步抛未捕获 `TypeError: callback is not a function`** | `private/core-cli-utils/src/private/clean.js:35`（`rm` 取自 `:24`） | **实测确认**；路径存在时才触发（`:32-34` 的 `existsSync` 提前返回）→ **清理越成功越崩溃**，且异常**异步**抛出、调用方的 `await` 捕获不到；正确 API 是 `fs.promises.rm` |
| **CLI-4** | **【核心】`-o ${options.outputSourceMap}` 被拼成单个 argv 元素** | `private/core-cli-utils/src/private/app.js:231`（被调用方 `packages/react-native/scripts/compose-source-maps.js:17-26`） | **实测复刻解析：`outputPath` 始终 `undefined`** → 合成后的 source map **从不写出**；而 `finally` 仍会删掉两份中间 map（`:237-240`）→ **Hermes 的 map 还在、Metro 的被删、合成结果不存在** |
| **CLI-5** | **【核心】`require.resolve` 用了 `{cwd: [...]}`** —— Node 只认 `paths`，`cwd` 被**静默忽略** | `private/core-cli-utils/src/private/app.js:88`；`private/core-cli-utils/src/private/apple.js:83` | **受控实验：`{cwd:[别处]}` 与不传 options 行为完全一致（MODULE_NOT_FOUND），`{paths:[别处]}` 才成功**；**「从 `process.cwd()` 解析」的意图未实现**，实际基准是模块自身位置 → workspace 多版本场景下可能解析到错误的 `react-native`；那句 `$FlowFixMe[prop-missing]` 把「选项名写错」误标为「类型定义不完整」 |
| **CLI-6** | **`execa` / `debug` 是未声明依赖** —— `core-cli-utils` 只声明了 `metro-babel-register`；`execa` 在**全仓任何 `package.json` 里都未声明**，只作为 `@react-native-community/cli*@20.2.0` 与 `jest-changed-files` 的**传递依赖**存在 | `private/core-cli-utils/package.json`；`private/core-cli-utils/src/private/utils.js:15`、`src/private/app.js:17-18`、`src/private/android.js:17`、`src/private/apple.js:17`、`private/core-cli-utils/src/private/clean.js:23` | 靠 yarn 提升才能 `require` 到；上游一旦移除即 `MODULE_NOT_FOUND`；消费方 `packages/rn-tester` 与 `private/helloworld` 均以 `"*"` 依赖它 |
| **CLI-7** | **【核心】`isOnPath` 的 `exitCode === 0` 是死判定** | `private/core-cli-utils/src/private/utils.js:53` | **execa 5.1.1 实测：非零退出抛异常（`err.exitCode=3`）** → 该比较**从未产生过 `false`**，「找不到」完全由 `catch` 决定；行为正确但**机制与字面不符**；若上游改 `reject` 默认值，语义会静默切换 |
| **CLI-8** | **`version.js` 的注释指向不存在的入口** —— 注释写 `require('@react-native/core-cli-utils/versions.js')`，`exports` 里只有 `./version.js`（单数）；注释里的包名还写成 `@react-native/core-cli-util`（单数） | `private/core-cli-utils/src/public/version.js:20`、`:24` | 按注释写会抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`；**注释描述的入口不存在**（与 71 文档 KKK-3 同型） |
| **CLI-9** | **发布的 `NODE_JS: '>= 18'` 比它自己的 `engines`（`^22.13.0 \|\| ^24.3.0 \|\| >= 26.0.0`）更宽松** | `private/core-cli-utils/src/public/version.js:42`；`private/core-cli-utils/package.json` | 这张表是**给使用者自查环境用的** → 用它判断会**放行一个本包根本跑不起来的环境**；表内其它条目无法在本仓库核实，本文不断言 |
| **CLI-10** | **`checkPodfileInSyncWithManifest` 在 `try` 块内自抛自捕** → 内层的专用错误被 `catch` 二次包装 | `private/core-cli-utils/src/private/apple.js:58-73` | 最终消息里**两条命令提示互相矛盾**（`yarn bootstrap ios` vs `yarn run bootstrap ios`），且整句套了两层 `Please run:`；`catch` 同时兜住 ENOENT → **「文件缺失」与「内容不同」无法区分** |
| **CLI-11** | Metro 的两个开关恒定且无注释：`npx --offline`（Metro 永不联网取包）、`metro build --reset-cache`（每次打包重置转换缓存，dev 模式同样带） | `private/core-cli-utils/src/private/app.js:93`、`:147` | **有意的取舍**，但未文档化；`--offline` 会让「npx 装不上 metro」直接失败；本文不断言二者构成功能缺陷 |
| **CLI-12** | **【核心】iOS 侧 `NSDataBigString::isAscii()` 恒返回 `false`**（注释：「The ASCII optimization is not enabled on iOS」） | `packages/react-native/React/CxxBridge/NSDataBigString.h:19-23` | **补上 71 文档 KKK-1 缺失的平台维度**：Android 走恒 `true` 的 C++ 实现（可能撒谎），iOS 走恒 `false` 的 ObjC 实现（保守）→ **四个实现全部是写死的常量，没有一个真正检查内容**，且两端取了**相反**方向 |
| **CLI-13** | **`NSDataBigString::size()` 违反基类契约** —— 基类要求「Length of the c_str **without the NULL byte**」，而实现返回 `NSData` 的长度（含结尾 NUL） | `packages/react-native/React/CxxBridge/NSDataBigString.h:30-33`、`.mm:15`；契约见 `packages/react-native/ReactCommon/cxxreact/JSBigString.h:48-52` | **多 1**；null 结尾的前置条件只写在头注释里、由调用方口头保证（`NSData` 本身不保证）；可验证的下游影响：`packages/react-native/ReactCommon/react/runtime/ReactInstance.cpp:396` 的空脚本检查会被绕过；**更下游后果依赖 Hermes（仓库外），本文不断言** |
| **CLI-14** | **【核心】`RCTMessageThread::runSync` 用 `DISPATCH_TIME_FOREVER` 无界等待**，而其成立的前置条件（sync 只用于 setup/teardown、`quitSynchronous` 必被调用）**只在析构函数里用 `RCTAssert` 检查** | `packages/react-native/React/CxxBridge/RCTMessageThread.mm:63`、`:16-21`、`:31-35`、`:98-103` | run loop 不再被驱动时**永久挂起**；`runSync` 自身**不检查 `m_shutdown`**；**关闭流程本身依赖这个无界等待** → 与 69 文档 III-1 的「没锁 / 持锁过长」并列，是**第三种形态：既无锁也无超时** |
| **CLI-15** | `RCTCxxBridgeDelegate` 的默认执行器是 **JSIExecutorFactory + JSCRuntime**（未实现、或返回空指针都是这个结果） | `packages/react-native/React/CxxBridge/RCTCxxBridgeDelegate.h:23-29` | ✓ **正面** —— 三条分支都写清楚、默认值被显式声明 |
| **CLI-16** | `Task.order` **确实被消费**（`packages/rn-tester/scripts/utils.js:92` 按 `order` 排序） | `private/core-cli-utils/src/private/types.js:13` | ✓ **正面** —— 但正确性**依赖 ES2019+ 的稳定排序**；`app.js` 里三个任务同为 `order: 1`、`apple.js` 里两个任务同为 `FIRST` → **「order 只表达档位、档内靠键序」这一约定无任何注释说明**（契约未文档化） |

---

## 19. 适用范围声明

| 维度 | CLI-1 / CLI-4 / CLI-11 | CLI-2 / CLI-3 | CLI-5 / CLI-6 / CLI-7 | CLI-8 / CLI-9 / CLI-10 | CLI-12 / CLI-13 | CLI-14 / CLI-15 | CLI-16 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **平台** | 宿主侧（Android 构建需 `assemble`；iOS 需 `compose`） | 跨平台（`os.tmpdir()` 路径随平台不同） | 跨平台 | 跨平台 | **iOS 专属** | **iOS 专属** | 跨平台 |
| **架构** | 与架构无关 | 与架构无关 | 与架构无关 | 与架构无关 | **legacy** | **legacy** | 与架构无关 |
| **触发条件** | ① `assemble` 带 hermes/newArch 参数；② Hermes + source map 打包；③ 任意 metro 调用 | ① 清理 Metro/Haste/RN 缓存；② 清理命中任何存在的路径 | ① 任何 PATH 探测；② 任何 `require('execa')` | ① 按注释使用 `versions.js`；② 用 `version.js` 判断环境；③ Podfile 与 Manifest 不同步 | ① iOS 加载 JS bundle；② `size()` 被当作「不含 NUL」的长度使用 | ① legacy 桥 setup/teardown；② run loop 不再被驱动 | ① 任何按 `order` 编排任务的消费方 |
| **当前是否造成功能问题** | **是**（CLI-1 静默不生效；CLI-4 产物缺失） | **是**（CLI-2 清理无效 + 误删风险；CLI-3 进程终止） | **否**（CLI-7 行为正确；CLI-6 当前靠提升可用） | **是**（CLI-8 入口不存在；CLI-9 放行不兼容环境） | **否**（CLI-12 是保守方向；CLI-13 的下游后果依赖仓库外） | **否**（自认边界，前置条件当前成立） | **否** |
| **是否已实机验证** | **是** —— CLI-4 的解析逻辑已复刻实测 | **是** —— `dirname('/tmp')='/'` 与 `fs.rm` 的三种形态均实测 | **是** —— `{cwd}` vs `{paths}` 受控实验；execa 5.1.1 非零退出抛异常实测 | **是** —— `exports` 键与 `engines` 均实测对照 | **是** —— 基类契约与实现的差 1 已核对 | **否**（代码级认定，需 iOS 实机触发 run loop 停摆） | **是** —— 消费方代码已核对 |

---

## 20. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 71 文档 KKK-1：两个 `isAscii()` 恒返回 `true`，Android bundle 主加载路径走其一 | **本文 CLI-12 补上 iOS 侧** —— `NSDataBigString::isAscii()` **恒 `false`** → 完整图景是「**四个实现全是写死的常量，两端方向相反**」，而非「个别实现疏忽」 |
| 71 文档 KKK-3：`JSBigString` 注释说「move-only」而实现 delete 了移动构造 | **本文 CLI-8 同型** —— `version.js` 的注释给出**不存在的入口**（`versions.js` vs `version.js`），且包名还少个 `s` |
| 69 文档 III-1：legacy 桥 C++ 侧的两种并发形态（没锁 / 持锁过长） | **本文 CLI-14 是第三种** —— **既没有锁，也没有超时**（`DISPATCH_TIME_FOREVER`），只靠注释保证前置条件；且**关闭流程自身依赖它** |
| 49 文档 OO-1：`exec_swallow_error.sh` 恒返回 0，ESLint 报错不会让 CI 失败 | **本文 CLI-1 / CLI-4 同型但更隐蔽** —— 那里是**退出码恒 0**，这里是**参数根本没传出去**与**产物根本没写出来**；两者都不会让调用方察觉 |
| 49 文档 OO-2：4 个 format 包装器缺工具链时 `console.warn` + `return`，退出码 0 | **本文 CLI-7 同构** —— `isOnPath` 看起来在检查退出码，实际只依赖异常；**「检查逻辑存在但不起作用」的形态可以出现在多个地方** |
| 67 文档 GGG-1：同一份定义被复制 N 份、只有 1 份被更新过 | **本文 CLI-5 是加强版** —— `getNodePackagePath` 有**两份逐字副本**，且**两份都没被更新过**；判据是「本仓其它 4 处 `require.resolve` 全用 `{paths}`」 |
| 62 文档：三档 Guard 默认全惰性（`RN_STRICT_API` 全仓未定义） | **对照 CLI-6** —— 那里是「开关恒不生效」，这里是「**依赖没声明**」；两者都不是「写错了」，而是「**声明与实际不符**」 |
| 68 文档 HHH-1：「无 prerelease」在四种语言里有三种表示 | **对照 CLI-9** —— 那里是同一语义在四种语言里表示不一；这里是**同一约束在两个文件里取值不一**（`engines` vs 发布的 `NODE_JS`），且**对外发布的那份更宽松** |
| §8 待办 #2：未声明文件清单 | **本文新增两个实例** —— `private/core-cli-utils` 声明的 `execa` / `debug` 是**未声明依赖**（不是未声明目录，但同源问题：声明与实际不符） |
