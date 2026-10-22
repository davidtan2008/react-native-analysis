---
id: 75
title: "DevTools 外壳：入口分叉的两套判据、两处静默失败，以及与 `DevToolLauncher` 契约的三处背离"
topic: TL.test
symptoms: [debug]
platforms: [cross]
architecture: [cross]
layer: T4
symbols: ["unstable_spawnDebuggerShellWithArgs", "unstable_prepareDebuggerShell", "prepareDebuggerShellFromDotSlashFile", "SettingsStore", "handleLaunchArgs", "invokeCommand"]
sourceRoot: react-native
claims: [DSH-1, DSH-2, DSH-3, DSH-4, DSH-5, DSH-6, DSH-7, DSH-8, DSH-9, DSH-10, DSH-11, DSH-12, DSH-13, DSH-14, DSH-15, DSH-16, DSH-17, DSH-18, DSH-19, DSH-20]
---
# 75 · DevTools 外壳：入口分叉的两套判据、两处静默失败，以及与 `DevToolLauncher` 契约的三处背离

> **模块**：Z1 · `packages/debugger-shell/`（本轮读 **12** 个文件）
> + 证据文件（跨模块，**局部/完整引用**，见 §1.2）
>
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根） · **宿主侧进程**（macOS / Windows / Linux） · **与架构无关**
>
> **前置**：[28 文档](./28-iOS-Dev工具链与四层门控.md) 记录 iOS 侧 Dev 工具链的四层门控；
> [30 文档](./30-iOS-WebSocket与调试通道.md) 记录调试通道的建立；
> [49 文档](./49-构建工具链与静默失败.md) 记录构建链路的静默失败形态；
> [67 文档](./67-特性开关的四级继承链与未接CI的快照门禁.md) 记录 `enableStandaloneFuseboxShell` 这类开关的链式继承。
>
> 本文记录 **20** 条结论：
> ① **【核心】入口分叉有两套判据且可能给出不同答案** —— `package.json` 的 `exports` 条件**按声明顺序**匹配，`node` 写在 `electron` 之前；而 `packages/debugger-shell/src/index.js` 的运行时分支按 `process.versions.electron` 判断 → **同一调用方可能拿到 node 变体而非 electron 变体**；
> ② **【核心】`detached` 模式下 Promise 在 `spawn` 事件即 resolve** → 后续 `close` 里的 `reject()` **失效** → **非零退出码无法经 Promise 上报**；
> ③ **【核心】`syncThenExit` 模式下 `silent` 为真时跳过 `process.exit(1)`** → 落到 `process.exit(null)` → **实测退出码 0** → **信号终止被报告为成功**；
> ④ **【核心】实现与 `DevToolLauncher` 接口的三条 SHOULD 全部背离**，且源码 TODO **自认**其中两点；
> ⑤ 错误分类**完全依赖 fb-dotslash 的 stderr 英文子串**，无退出码或结构化输出参与；
> ⑥ `SettingsStore` 的 `get()` 默认值语义是「值为 `undefined` 才回退」，配置里显式 `null` 会让调用方抛 `TypeError`；
> ⑦ **附带发现**：启动失败日志里的 `?? 'Unknown error'` 兜底**不可达** —— `+` 的优先级更高，左边恒为字符串（**实测**）。

---

## 1. 文件构成

### 1.1 本轮读的 12 个文件（Z1 范围）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/debugger-shell/src/index.js` | **26** | 入口分叉（运行时判断 Electron） |
| `packages/debugger-shell/src/node/index.js` | **19** | node 变体入口（注册 babel + 再导出） |
| `packages/debugger-shell/src/node/index.flow.js` | **207** | **node 变体主体**：拉起 shell / 预取二进制 |
| `packages/debugger-shell/src/node/private/LaunchUtils.js` | **98** | dotslash 拉取与错误分类 |
| `packages/debugger-shell/src/electron/index.js` | **19** | electron 变体入口 |
| `packages/debugger-shell/src/electron/index.flow.js` | **51** | **electron 变体主体**：单实例锁 / 版本输出 |
| `packages/debugger-shell/src/electron/MainInstanceEntryPoint.js` | **164** | 窗口创建与复用、参数处理 |
| `packages/debugger-shell/src/electron/SettingsStore.js` | **128** | 配置持久化（`electron-store` 兼容层） |
| `packages/debugger-shell/src/electron/AppMenu.js` | **129** | 应用菜单（经 `executeJavaScript` 调前端） |
| `packages/debugger-shell/src/electron/preload.js` | **45** | 预加载脚本（`contextBridge` 桥接） |
| `packages/debugger-shell/src/electron/utils.js` | **18** | macOS 版本判断 |
| `packages/debugger-shell/src/electron/BuildInfo.js` | **13** | 构建版本号（源码态占位） |

**合计 917 行。** 另有 `src/electron/BuildInfo.js.tpl`（**非 `.js` 扩展名，不计入覆盖范围**）与 `bin/react-native-devtools`（dotslash 文件，非代码）。

### 1.2 证据文件（跨模块引用）

| 文件 | 归属模块 | 引用方式 | 用途 |
| --- | --- | --- | --- |
| `scripts/debugger-shell/build-binary.js` | **D1** | 完整通读（159 行） | `BuildInfo` 的生成链路 |
| `packages/dev-middleware/src/types/DevToolLauncher.js` | **B9** | 完整通读（67 行） | **窗口复用的 SHOULD 契约原文** |
| `packages/dev-middleware/src/utils/DefaultToolLauncher.js` | **B9** | 完整通读（85 行） | 默认 launcher 的调用方式 |
| `packages/dev-middleware/src/utils/getDevToolsFrontendUrl.js` | **B9** | 完整通读（88 行） | `frontendUrl` 的构造 |
| `packages/dev-middleware/src/middleware/openDebuggerMiddleware.js` | **B9** | 完整通读（262 行） | 错误码与 `windowKey` 的产生方 |
| `packages/dev-middleware/src/createDevMiddleware.js` | **B9** | 完整通读（208 行） | 错误码的消费方 |
| `packages/debugger-frontend/index.js` | **无人声明**（属 §8 待办） | 完整通读（41 行） | 前端目录解析 |
| `packages/debugger-frontend/dist/third-party/front_end/ui/legacy/legacy.js` | **排除**（`baseline.excluded`） | 仅取存在性 | 菜单注入代码的相对路径基准 |

---

## 2. 【核心 DSH-1】入口分叉：两套判据，`exports` 的顺序使 node 变体胜出

### 2.1 两处入口定义并存

`package.json` 同时声明了 `main` 与 `exports`：

```json
// packages/debugger-shell/package.json:12-19
  "main": "./src/index.js",
  "exports": {
    ".": {
      "node": "./src/node/index.js",
      "electron": "./src/electron/index.js"
    },
    "./package.json": "./package.json"
  },
```

**`exports` 存在时，Node 忽略 `main`。** 而 `packages/debugger-shell/src/index.js` 自己是第三套入口：

```js
// packages/debugger-shell/src/index.js:18-26
// Because Electron doesn't support package.json `exports`, we need to
// switch at runtime.
if ('electron' in process.versions) {
  // $FlowFixMe[invalid-export]
  module.exports = require('./electron');
} else {
  // $FlowFixMe[invalid-export]
  module.exports = require('./node');
}
```

### 2.2 条件导出按**声明顺序**匹配（实测）

Node 的条件导出不是「按条件优先级」，而是**按 `exports` 对象中键的声明顺序**取第一个命中的条件。实测（Node v24.22.1）：

```text
# {node, electron} 顺序
require("pkg")                        -> NODE_VARIANT
require("pkg") --conditions=electron   -> NODE_VARIANT
# {electron, node} 顺序（反序对照）
require("pkg") --conditions=electron   -> ELECTRON_VARIANT
```

**本包把 `node` 写在 `electron` 之前** —— 因此即使解析器同时满足两个条件，**命中的也是 `node`**。

### 2.3 两套判据可以给出不同答案

| | 判据 | 命中结果 |
| --- | --- | --- |
| `exports["."]` | **解析器的条件集** ∩ **声明顺序** | `node` 在前 → **node 变体** |
| `src/index.js:20` | `'electron' in process.versions` | Electron 进程 → **electron 变体** |

**「可验证的事实」**：（a）条件导出按声明顺序匹配（已实测，含反序对照）；（b）本包 `exports` 中 `node` 在 `electron` 之前；（c）`packages/debugger-shell/src/index.js` 的判据是 `process.versions.electron`；（d）**全 RN 仓库只有 `packages/debugger-shell` 一个包在 `exports` 里使用 `electron` 条件**（实测遍历 `packages/*/package.json`）。

**「可验证的推论」**：Electron 主进程的 Node 风格 `require()` 同时满足 `node` 与 `electron` 两个条件 → 按声明顺序命中 `node` → **拿到 node 变体**（`packages/debugger-shell/src/node/index.js`），而 `packages/debugger-shell/src/index.js` 的运行时判断会选 electron 变体。**两者对「同一个 Electron 调用方」的答案不同。**

**「无法验证」**：本环境无 Electron，**本文不断言** Electron 解析器的实际条件集。

### 2.4 已发布包同样如此

`publishConfig` 里的 `exports` 是**同样的顺序**：

```json
// packages/debugger-shell/package.json:20-28
  "publishConfig": {
    "main": "./dist/index.js",
    "exports": {
      ".": {
        "node": "./dist/node/index.js",
        "electron": "./dist/electron/index.js"
      },
      "./package.json": "./package.json"
    }
  },
```

而 `scripts/build/prepack.js`（D1）在打包时把 `publishConfig` 的字段**逐个覆盖**到根 `package.json`：

```js
// scripts/build/prepack.js:30-34
  if (contents.publishConfig != null) {
    for (const key of Object.keys(contents.publishConfig)) {
      contents[key] = contents.publishConfig[key];
    }
  }
```

→ **发布产物的 `exports` 顺序与源码树完全一致**，问题一并带出。

### 2.5 两个变体的行为差异是实质性的

| | node 变体 | electron 变体 |
| --- | --- | --- |
| 入口 | `packages/debugger-shell/src/node/index.js` | `packages/debugger-shell/src/electron/index.js` |
| 做什么 | **再拉起一个 shell 子进程**（`spawn`） | **自己就是 shell**（`app.whenReady` + 建窗） |
| 暴露的 API | `unstable_spawnDebuggerShellWithArgs` / `unstable_prepareDebuggerShell` | 无（`module.exports = require('./index.flow')`） |

**拿错变体不是「风格差异」** —— node 变体会**再启动一个进程**，electron 变体才是窗口本体。

---

## 3. 【核心 DSH-2】`detached` 模式：Promise 提前 resolve，后续 `reject()` 失效

### 3.1 代码

```js
// packages/debugger-shell/src/node/index.flow.js:63-88
    if (mode === 'detached') {
      child.on('spawn', () => {
        debug('Debugger spawned in detached mode');
        resolve();
      });
      child.on('close', (code: number, signal: string) => {
        debug('Debugger closed with code %s and signal %s', code, signal);
        if (code !== 0) {
          if (!silent) {
            console.error(
              'Debugger exited with non-zero code (code: %s, signal: %s)',
              code,
              signal,
            );
          }
          reject(
            new Error(
              `Failed to open debugger shell: exited with code ${code}`,
            ),
          );
        }
      });
```

### 3.2 失效链条

| 步骤 | 事实 |
| --- | --- |
| 1 | `child.on('spawn')` 触发 → **`resolve()`** → Promise **已落定（fulfilled）** |
| 2 | 子进程随后**非零退出** → `close` 触发 → 走到 `reject(...)` |
| 3 | **Promise 一旦 fulfilled，后续的 `reject` 是空操作** —— `await` 的调用方**永远看不到这个错误** |

**后果**：调用方拿到的 `await unstable_spawnDebuggerShellWithArgs(...)` **永远成功**。`Failed to open debugger shell: exited with code N` 这个错误**只会以 `console.error` 形式出现在 stderr**（且 `silent` 为真时连这行都没有）。

### 3.3 `detached` 才是默认模式

```js
// packages/debugger-shell/src/node/index.flow.js:28-30
  {
    mode = 'detached',
    flavor = process.env.RNDT_DEV === '1' ? 'dev' : 'prebuilt',
```

**`mode` 默认值是 `'detached'`** —— 也就是说**默认路径上这条静默失败是常态**。

而唯一的调用方（`DefaultToolLauncher.launchDebuggerShell`）正是走默认参数：

```js
// packages/dev-middleware/src/utils/DefaultToolLauncher.js:59-62
    return await unstable_spawnDebuggerShellWithArgs([
      '--frontendUrl=' + url,
      '--windowKey=' + windowKey,
    ]);
```

**判定：结构脆弱（当前正确，但改一行即引入 bug）** —— 修法是把 `resolve()` 推迟到 `close`，或在 `close` 里改用 `child.emit` 之类不影响已落定 Promise 的通道。

---

## 4. 【核心 DSH-3】`syncThenExit` 模式：`silent` 让信号终止变成退出码 0

### 4.1 代码

```js
// packages/debugger-shell/src/node/index.flow.js:98-110
    } else if (mode === 'syncThenExit') {
      child.on('close', function (code, signal) {
        debug('Debugger exited with code %s and signal %s', code, signal);
        if (code == null && !silent) {
          console.error(
            'Debugger exited with code %s and signal %s',
            code,
            signal,
          );
          process.exit(1);
        }
        process.exit(code);
      });
```

### 4.2 `silent` 改变了退出码语义

`silent` 的定义是「不打印噪声」，但它**同时守卫着唯一的失败分支**：

| `silent` | `code == null`（被信号终止）时的行为 | 实际退出码 |
| --- | --- | --- |
| `false` | `process.exit(1)` | **1** ✓ |
| **`true`** | **跳过 `process.exit(1)`，落到 `process.exit(code)`，而 `code` 是 `null`** | **0** ✗ |

**实测**（Node v24.22.1）：

```text
$ node -e "process.exit(null)"   ; echo $?   ->  0
$ node -e "process.exit(undefined)"; echo $? ->  0
```

**`process.exit(null)` 的退出码是 0** —— 因此**被信号杀死的子进程，在 `silent` 模式下会让父进程以 0 退出**。

### 4.3 `silent` 的取值让这条路径默认不成立

```js
// packages/debugger-shell/src/node/index.flow.js:32
    silent = process.env.NODE_ENV === 'test',
```

`silent` 只在 `NODE_ENV === 'test'` 时为真。**因此 `silent: true` + `syncThenExit` 只出现在测试环境**（或调用方显式传 `silent: true`）。

**判定：结构脆弱（当前生产路径不触发，测试路径上会把失败伪装成成功）** —— **一个以「断言退出码」为目的的测试辅助模式，在失败时恰好返回成功退出码**。

---

## 5. 【核心 DSH-4】`ELECTRON_RUN_AS_NODE` 被显式剥离（正面）

```js
// packages/debugger-shell/src/node/index.flow.js:50-56
    const {
      // If this package is used in an Electron app (e.g. inside a VS Code extension),
      // ELECTRON_RUN_AS_NODE=1 can leak from the parent process.
      // Since this is never the right way to launch the Fusebox shell, we guard against it here.
      ELECTRON_RUN_AS_NODE: _,
      ...env
    } = process.env;
```

**这是一个有注释论证的防御措施**：父进程（如同处 Electron 的 VS Code 扩展）若带着 `ELECTRON_RUN_AS_NODE=1` 起子进程，Electron 会**以纯 Node 模式启动**而不是起窗口 —— 正是「不该走 Fusebox shell」的状态。此处把它从传给子进程的 `env` 中剔除。

**判定：正面** —— **第一档注释**（说明了「谁会泄漏」「为什么必须剥离」「为什么不是别的方式」）。

---

## 6. 【核心 DSH-5】错误分类完全依赖 fb-dotslash 的 stderr 英文子串

### 6.1 分类实现

```js
// packages/debugger-shell/src/node/private/LaunchUtils.js:55-88
  if (
    stderr.includes('dotslash error') &&
    stderr.includes('no providers succeeded')
  ) {
    if (stderr.includes('failed to verify artifact')) {
      return {
        code: 'possible_corruption',
        humanReadableMessage:
          'Failed to verify the latest version of React Native DevTools. ' +
          'Using a fallback version instead. ',
        verboseInfo: stderr,
      };
    }
    return {
      code: 'likely_offline',
      humanReadableMessage:
        'Failed to download the latest version of React Native DevTools. ' +
        'Using a fallback version instead. ' +
        'Connect to the internet or check your network settings.',
      verboseInfo: stderr,
    };
  }
  if (
    stderr.includes('dotslash error') &&
    stderr.includes('platform not supported')
  ) {
    return {
      code: 'platform_not_supported',
      humanReadableMessage:
        'The latest version of React Native DevTools is not supported on this platform. ' +
        'Using a fallback version instead.',
      verboseInfo: stderr,
    };
  }
```

**判定依据一览**：

| code | 判定条件（全部为 stderr 子串） |
| --- | --- |
| `success` | **退出码 `=== 0`**（`:52`）—— 唯一一个用退出码的分支 |
| `possible_corruption` | `dotslash error` + `no providers succeeded` + `failed to verify artifact` |
| `likely_offline` | `dotslash error` + `no providers succeeded` |
| `platform_not_supported` | `dotslash error` + `platform not supported` |
| `unexpected_error` | 兜底（`:89-95`） |

**除 `success` 外，分类完全不参考退出码，也不解析结构化输出** —— 四个**英文短语**就是全部依据。

### 6.2 上游改文案 = 静默降级

fb-dotslash 的措辞一旦变化（哪怕只是大小写或标点），所有失败分支都会落进兜底的 `unexpected_error`。

**后果不是「崩溃」而是「信息丢失」**：用户从「连不上网，检查网络设置」变成「未知错误」——**可操作性下降**。

**判定：结构脆弱（依赖仓库外工具的英文文案）**。

### 6.3 与 `likely_offline` 的包含关系

`possible_corruption` 的判定**嵌套在** `likely_offline` 的判定之内 —— 即 `possible_corruption` ⟹ `likely_offline` 的两个条件也成立。**顺序不可交换**（先查 `failed to verify artifact`）。

### 6.4 `code == 0` 才是唯一可靠的分支

```js
// packages/debugger-shell/src/node/private/LaunchUtils.js:52-54
  if (code === 0) {
    return {code: 'success'};
  }
```

**注意**：`spawnAndGetStderr` 的 `close` 回调把 `code` 原样传出（`:35-40`），**被信号终止时 `code` 是 `null`** → `code === 0` 为假 → 落进字符串匹配 → 兜底 `unexpected_error`。**这一路径是正确处理的**（信号终止不该算成功）。

---

## 7. 【核心 DSH-6】同一个 `unexpected_error` 有两种文案

`unexpected_error` 有**两个产出点**：

| 产出点 | 返回内容 | 有 `humanReadableMessage`？ |
| --- | --- | --- |
| `packages/debugger-shell/src/node/private/LaunchUtils.js:89-95`（字符串匹配兜底） | `{code, humanReadableMessage, verboseInfo}` | **有** |
| `packages/debugger-shell/src/node/index.flow.js:175-180`（`catch`） | `{code, verboseInfo}` | **无** |

```js
// packages/debugger-shell/src/node/index.flow.js:175-180
  } catch (e) {
    return {
      code: 'unexpected_error',
      verboseInfo: e.message,
    };
  }
```

**消费方对缺失的 `humanReadableMessage` 有兜底**，所以不会崩，但**文案不同**：

```js
// packages/dev-middleware/src/createDevMiddleware.js:179-189
            case 'unexpected_error': {
              let message =
                event.result.humanReadableMessage ??
                'An unknown error occurred while installing React Native DevTools.';
              if (event.result.verboseInfo != null) {
                message += ` Details:\n\n${event.result.verboseInfo}`;
              } else {
                message += '.';
              }
              logger?.error(message);
              break;
            }
```

**即**：走 `catch` 路径时，用户看到的是通用文案 + 原始异常作为 "Details:"；走兜底路径时，用户看到的是有针对性的「安装 DevTools 时发生未知错误」。

**判定：不对称（同一个 code 对应两种质量的用户提示）** —— 不是缺陷，但**提示词与故障类型的对应关系被削弱**。

---

## 8. DSH-7 `not_implemented` 在本包内无任何产出路径

类型联合声明了 6 个 code：

```js
// packages/debugger-shell/src/node/index.flow.js:127-137
export type DebuggerShellPreparationResult = Readonly<{
  code:
    | 'success'
    | 'not_implemented'
    | 'likely_offline'
    | 'platform_not_supported'
    | 'possible_corruption'
    | 'unexpected_error',
  humanReadableMessage?: string,
  verboseInfo?: string,
}>;
```

**逐条核对本包的全部返回路径**：

| 函数 | 产出集合 |
| --- | --- |
| `prepareDebuggerShellFromDotSlashFile`（`LaunchUtils.js`） | `success` / `possible_corruption` / `likely_offline` / `platform_not_supported` / `unexpected_error` |
| `unstable_prepareDebuggerShell`（`packages/debugger-shell/src/node/index.flow.js:150-181`） | 透传上述集合 + `success`（dev  flavor / 成功）+ `unexpected_error`（catch） |

**`not_implemented` 不在任何一条返回路径上** —— 本包**永远不产出**它。

**但这不构成「死枚举」**：`not_implemented` 由**调用方**产出 —— 即「launcher 没有实现 `prepareDebuggerShell`」：

```js
// packages/dev-middleware/src/middleware/openDebuggerMiddleware.js:53-56
  if (experiments.enableStandaloneFuseboxShell) {
    shellPreparationPromise =
      toolLauncher?.prepareDebuggerShell?.() ??
      Promise.resolve({code: 'not_implemented'});
```

**判定：结构清晰（联合类型由「生产者 + 消费者」共同定义，本包只是其中一个生产者）** —— 但**本包内部的 `not_implemented` 分支确实是不可达代码**。

---

## 9. 【核心 DSH-8】错误分类在消费端有真实分级（正面）

分类**不是装饰性的** —— 消费端按 code 分了**日志级别**：

```js
// packages/dev-middleware/src/createDevMiddleware.js:191-198
            case 'possible_corruption':
            case 'platform_not_supported':
            case 'likely_offline':
              logger?.warn(
                event.result.humanReadableMessage ??
                  `An error of type ${event.result.code} occurred while installing React Native DevTools.`,
              );
              break;
```

| code | 消费端行为 |
| --- | --- |
| `success` / `not_implemented` | 静默（`break`） |
| `unexpected_error` | **`logger.error`**（红） |
| `possible_corruption` / `platform_not_supported` / `likely_offline` | **`logger.warn`**（黄） |

**而 `shouldUseStandaloneFuseboxShell` 的决策把四种失败**统一**降级为「回落到浏览器窗口」：

```js
// packages/dev-middleware/src/middleware/openDebuggerMiddleware.js:180-185
                case 'platform_not_supported':
                case 'possible_corruption':
                case 'likely_offline':
                case 'unexpected_error':
                  shouldUseStandaloneFuseboxShell = false;
                  break;
```

**两者不矛盾**：**行为上统一降级（都回落到浏览器），提示上分级（error / warn + 不同文案）** —— 这是一个**设计得当**的组合。

**判定：正面**。

### 9.1 附带发现：兜底分支不可达 —— `??` 与 `+` 的优先级

```js
// packages/dev-middleware/src/middleware/openDebuggerMiddleware.js:244-247
      } catch (e) {
        logger?.error(
          'Error launching DevTools: ' + e.message ?? 'Unknown error',
        );
```

**`+` 的优先级高于 `??`**，因此表达式实际是 `('Error launching DevTools: ' + e.message) ?? 'Unknown error'` —— 左边**恒为字符串**（永远不是 `null` / `undefined`）→ **右边的 `'Unknown error'` 永远不会生效**。

**实测**（Node v24.22.1）：

```text
e = {message: undefined}
'Error launching DevTools: ' + e.message ?? 'Unknown error'  ->  Error launching DevTools: undefined
```

**即**：`e.message` 为 `undefined` 时，日志里出现的是 `Error launching DevTools: undefined`，**而不是**作者想要的 `Unknown error`。要给 `??` 生效必须给 `+` 加括号。

**判定：结构脆弱（运算符优先级使兜底分支不可达）**。

---

## 10. 【核心 DSH-9】实现与 `DevToolLauncher` 契约的三条 SHOULD 全部背离

### 10.1 契约原文

```js
// packages/dev-middleware/src/types/DevToolLauncher.js:33-48
  /**
   * Attempt to open a debugger frontend URL in a standalone shell window
   * designed specifically for React Native DevTools. The provided windowKey
   * should be used to identify an existing window that can be reused instead
   * of opening a new one.
   *
   * Implementations SHOULD treat an existing session with the same windowKey
   * (as long as it's still connected and healthy) as equaivalent to a new
   * session with the new URL, even if the launch URLs for the two sessions are
   * not identical. Implementations SHOULD NOT unnecessarily close and reopen
   * the connection when reusing a session. Implementations SHOULD process any
   * changed/new parameters in the URL and update the session accordingly (e.g.
   * to preserve telemetry data that may have changed).
   */
```

**三条 SHOULD**：

| # | 契约要求 | 实现 |
| --- | --- | --- |
| S1 | 相同 `windowKey` 的现有会话**应当等同于**新 URL 的新会话，**即使两个会话的启动 URL 不相同** | ❌ **未实现**（见 DSH-10） |
| S2 | 复用会话时**不应不必要地**关闭并重连 | ❌ **违反**（无条件 `loadURL` 重载，见 DSH-11） |
| S3 | 复用会话时**应当处理 URL 中变化/新增的参数**并相应更新会话（如保留变化的遥测数据） | ❌ **未实现**（源码 TODO 自认，见 DSH-12） |

### 10.2 窗口复用由 `windowKey` 决定

```js
// packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:43-50
  // Find an existing window for this app and launch configuration.
  let frontendWindow = BrowserWindow.getAllWindows().find(window => {
    const metadata = windowMetadata.get(window);
    if (!metadata) {
      return false;
    }
    return metadata.windowKey === windowKey;
  });
```

`windowKey` 由调用方计算：

```js
// packages/dev-middleware/src/middleware/openDebuggerMiddleware.js:191-199
              const windowKey = createHash('sha256')
                .update(
                  [
                    serverBaseUrl,
                    target.webSocketDebuggerUrl,
                    target.appId,
                  ].join('-'),
                )
                .digest('hex');
```

→ **`windowKey` 是 `(serverBaseUrl, wsUrl, appId)` 的 sha256** —— 即「**同一个 app 的同一个 dev server**」。**同一个 app 再次打开 DevTools → `windowKey` 相同 → 复用窗口**。

---

## 11. 【核心 DSH-10】`second-instance` 忽略第二实例的 argv，改用第一实例的

### 11.1 单例锁把**第一实例**的 argv 存了下来

```js
// packages/debugger-shell/src/electron/index.flow.js:43-45
const gotTheLock = app.requestSingleInstanceLock({
  argv: process.argv.slice(app.isPackaged ? 1 : 2),
});
```

### 11.2 第二实例的处理器用了 `additionalData.argv`

```js
// packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:141-146
  app.on(
    'second-instance',
    (event, electronArgv, workingDirectory, additionalData) => {
      handleLaunchArgs(additionalData.argv);
    },
  );
```

**`electronArgv`（第二实例自己的命令行）被解构出来却从未使用**；实际使用的是 `additionalData.argv` —— 那是**第一实例**在申请单例锁时存进去的 argv。

### 11.3 后果

| | 内容 |
| --- | --- |
| `additionalData.argv` | **第一实例**的 `--frontendUrl` / `--windowKey` |
| `electronArgv`（未使用） | **第二实例**的 `--frontendUrl` / `--windowKey` |
| 实际加载的 URL | **第一实例的** `frontendUrl`（`packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:92`） |

**正常 RN 流程下二者相同** —— 因为 `frontendUrl` 与 `windowKey` 都由同一个 dev server + 同一个 app 决定（`packages/dev-middleware/src/utils/getDevToolsFrontendUrl.js:34-36` 与 `packages/dev-middleware/src/middleware/openDebuggerMiddleware.js:191-199`）。**因此这是「边界未文档化」而非「日常必然出错」。**

**但差异确实存在**：若以**不同的 `frontendUrl`**（例如指向另一个 dev server）再次启动，则新 URL 被**丢弃**，窗口仍加载第一实例的 URL —— **直接违反契约 S1**（「even if the launch URLs for the two sessions are not identical」）。

**判定：结构脆弱（当前正常路径无差异，边界路径违反契约）**。

---

## 12. 【核心 DSH-11】复用窗口时无条件 `loadURL` 重载

```js
// packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:89-92
  // TODO: If the window contains a live, working frontend instance with a valid connection to the backend,
  // we should avoid this reload and instead send the frontend a message to handle the launch arguments
  // dynamically (e.g. update the launch ID for telemetry purposes, handle deeplinking to a specific CDT panel, etc).
  frontendWindow.loadURL(frontendUrl);
```

**`loadURL` 在「新建窗口」与「复用窗口」两条路径上都被无条件调用** —— 复用的窗口也会**整页重载**。

**后果**：CDP 连接被拆掉重建 → **违反契约 S2**（「SHOULD NOT unnecessarily close and reopen the connection when reusing a session」）。

**判定：自认边界（源码 TODO 明确承认，并写清了正确做法）** —— **这是本项目 §3.2 四类中的「自认边界」典型形态**：注释主动承认了已知失效。

---

## 13. DSH-12 `frontendUrl` 无必填校验

`util.parseArgs` 声明了两个选项，但**没有 `required`，也没有手工判空**：

```js
// packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:28-41
function handleLaunchArgs(argv: string[]) {
  const {
    values: {frontendUrl, windowKey},
  } = util.parseArgs({
    options: {
      frontendUrl: {
        type: 'string',
      },
      windowKey: {
        type: 'string',
      },
    },
    args: argv,
  });
```

**实测**：缺省时 `values.frontendUrl` 是 `undefined`（不抛错）。

```text
parseArgs({options:{frontendUrl:{type:'string'}}, args:[]})  ->  OK  {}
```

→ 随后 `frontendWindow.loadURL(frontendUrl)` 传入 `undefined`。

**判定：结构脆弱（缺参时无友好报错，直接把 `undefined` 交给 Electron）**。

---

## 14. 【核心 DSH-13】两处 `util.parseArgs` 的严格性设置不一致

| 位置 | `strict` | 效果 |
| --- | --- | --- |
| `src/electron/index.flow.js:30-36` | **显式 `false`** | 容忍未知选项与位置参数 |
| `src/electron/MainInstanceEntryPoint.js:31-41` | **默认（`true`）** | **不容忍** |

```js
// packages/debugger-shell/src/electron/index.flow.js:28-36
const {
  values: {version = false},
} = util.parseArgs({
  options: {
    version: {type: 'boolean'},
  },
  args: process.argv.slice(app.isPackaged ? 1 : 2),
  strict: false,
});
```

**strict 模式下的实测行为**（Node v24.22.1）：

| 入参 | 结果 |
| --- | --- |
| `['--frontendUrl=http://x','--windowKey=k']` | **OK** |
| `['--frontendUrl=http://x']`（缺 `--windowKey`） | **OK**（`values.windowKey === undefined`） |
| `['--frontendUrl=http://x','--no-sandbox']` | **抛 `ERR_PARSE_ARGS_UNKNOWN_OPTION`** |
| `['src/electron']`（位置参数） | **抛 `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`** |

**影响面必须限定**：`handleLaunchArgs` 的入参是**进程命令行**，但**正常调用方只传两个参数** ——

```js
// packages/dev-middleware/src/utils/DefaultToolLauncher.js:59-62
    return await unstable_spawnDebuggerShellWithArgs([
      '--frontendUrl=' + url,
      '--windowKey=' + windowKey,
    ]);
```

→ **正常 RN 流程下 strict 解析成立**。风险仅出现在**手工启动 shell 二进制**或**第三方调用方附加开关**时（此时整个 `handleLaunchArgs` 抛异常 → **窗口永远不出现**，且异常发生在 `app.whenReady()` 的回调里 → **无用户可见提示**）。

**判定：结构脆弱（两处解析同一类命令行，严格性设置相反；边界未文档化）**。

---

## 15. 【核心 DSH-14】`SettingsStore.get()` 的默认值语义是「值为 `undefined` 才回退」

### 15.1 实现

```js
// packages/debugger-shell/src/electron/SettingsStore.js:51-54
  get(key: string, defaultValue?: any): any {
    const store = this.store;
    return store[key] !== undefined ? store[key] : defaultValue;
  }
```

**判定条件是 `store[key] !== undefined`** —— 即**键存在但值为 `null` 时，返回 `null` 而不是 `defaultValue`**。

### 15.2 调用方直接把返回值当对象用

```js
// packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:106-110
function getSavedWindowPosition(
  windowKey: string,
): ?{width: number, height: number, x?: number, y?: number} {
  return appSettings.get('windowArrangements', {})[windowKey];
}
```

**若配置文件里出现 `"windowArrangements": null`** → `get` 返回 `null` → **`null[windowKey]` 抛 `TypeError`**。

同样的模式还有两处：

```js
// packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:112-119
function saveWindowPosition(
  windowKey: string,
  position: {x: number, y: number, width: number, height: number},
) {
  const windowArrangements = appSettings.get('windowArrangements', {});
  windowArrangements[windowKey] = position;
  appSettings.set('windowArrangements', windowArrangements);
}
```

→ `null[windowKey] = position` 同样抛 `TypeError`。

### 15.3 触发条件

配置文件是 `app.getPath('userData')/config.json`（`packages/debugger-shell/src/electron/SettingsStore.js:45-48`），**用户可手改**。`windowArrangements` 的值由本包写入（`saveWindowPosition`），**正常路径下永远是对象** —— 因此**这是一条「配置被外部破坏」才会走到的路径**。

**判定：结构脆弱（理论可达、实际不可达、无防御）**。

---

## 16. DSH-15 每次读写都是「全量读盘 + 全量写盘」，且挂在 resize 事件上

### 16.1 存储层没有增量写

```js
// packages/debugger-shell/src/electron/SettingsStore.js:94-113
  get store(): {[string]: unknown} {
    try {
      const data = fs.readFileSync(this.path, 'utf8');
      const deserializedData = this._deserialize(data);
      return {
        ...(deserializedData as any as {[string]: unknown}),
      };
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this._ensureDirectory();
        return {};
      }
      throw error;
    }
  }

  set store(value: unknown): void {
    this._ensureDirectory();
    this._write(value);
  }
```

**`get` 每次都 `readFileSync` + `JSON.parse` 整个文件；`set` 每次都 `writeFileSync` 整个文件。**

### 16.2 写盘挂在三个高频事件上

```js
// packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:121-135
function setupWindowResizeListeners(
  browserWindow: typeof BrowserWindow,
  windowKey: string
) {
  const savePosition = () => {
    if (!browserWindow.isDestroyed()) {
      const [x, y] = browserWindow.getPosition();
      const [width, height] = browserWindow.getSize();
      saveWindowPosition(windowKey, {x, y, width, height});
    }
  };
  browserWindow.on('moved', savePosition);
  browserWindow.on('resized', savePosition);
  browserWindow.on('closed', savePosition);
}
```

**`resized` 在拖拽窗口时连续触发** → **每个事件一次同步的全文件读 + 全文件写**（`get` 读、`set` 写）。

**判定：有意的取舍（配置量极小 —— 只有一个 `windowArrangements` 键；代价是拖拽窗口时的同步 IO）** —— **本文不断言这构成可感知的问题**。

### 16.3 附带的文件模式细节

```js
// packages/debugger-shell/src/electron/SettingsStore.js:123-127
  _write(value: unknown): void {
    const data = this._serialize(value);

    fs.writeFileSync(this.path, data, {mode: 0o666});
  }
```

**`mode` 只在文件被创建时生效**；后续覆写沿用既有权限位。

---

## 17. DSH-16 `defaults` / `reset` / `clear` 的「恢复默认值」能力在本包内从未被使用

### 17.1 默认值表恒为空

```js
// packages/debugger-shell/src/electron/SettingsStore.js:33-49
  #defaultValues: Object = {};
  path: string;

  constructor(options: Options = {}) {
    options = {
      name: 'config',
      ...options,
    };
    this.#defaultValues = {
      ...this.#defaultValues,
      ...options.defaults,
    };
```

**本包唯一的实例化点不传 `defaults`**：

```js
// packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:20
const appSettings = new SettingsStore();
```

→ **`#defaultValues` 恒为 `{}`** → `reset()` 的守卫 `if (this.#defaultValues[key] != null)` **永不成立** → `reset()` 是空操作 → `clear()` 实际只是写一个 `{}`。

### 17.2 `set()` 里有一个类型上不可达的分支

```js
// packages/debugger-shell/src/electron/SettingsStore.js:56-67
  set(key: string, value: any): void {
    const {store} = this;
    if (typeof key === 'object') {
      const object = key;
      for (const [k, v] of Object.entries(object)) {
        store[k] = v;
      }
    } else {
      store[key] = value;
    }
    this.store = store;
  }
```

**签名声明 `key: string`** → `typeof key === 'object'` **在类型层面恒为假**。该分支是 `electron-store` 的 `set(object)` API 形状的残留（类注释声明「modelled after `electron-store`」，`packages/debugger-shell/src/electron/SettingsStore.js:22-31`）。

**判定：历史承诺（携带了上游 API 的形状，但本包自身的类型已经排除了它）**。

---

## 18. DSH-17 菜单命令经 `executeJavaScript` 调前端内部 API（跨包运行时耦合）

### 18.1 注入的代码

```js
// packages/debugger-shell/src/electron/AppMenu.js:119-129
function invokeCommand(commandId: string): void {
  const win = BrowserWindow.getFocusedWindow();
  win?.webContents.executeJavaScript(
    `(async () => {
      const UI = await import('./ui/legacy/legacy.js');
      return UI.ActionRegistry.ActionRegistry.instance()
        .getAction(${JSON.stringify(commandId)})?.execute();
    })()`,
    true,
  );
}
```

**两处跨包耦合**：

| 耦合点 | 内容 |
| --- | --- |
| **模块路径** | `'./ui/legacy/legacy.js'` —— **相对于页面 URL** 解析 |
| **API 形状** | `UI.ActionRegistry.ActionRegistry.instance().getAction(id)?.execute()` —— 前端内部类路径 |

### 18.2 命令 ID 全部在前端产物中确认存在（正面）

本轮在 `packages/debugger-frontend/dist/third-party/front_end/`（Chromium DevTools 前端副本）中检索（**按「含匹配的行数」计**，与 `grepCount` 语义一致）：

| 命令 ID | 命中行数 |
| --- | --- |
| `inspector-main.reload` | **10** |
| `quick-open.show` | **8** |
| `quick-open.show-command-menu` | **7** |
| `settings.shortcuts` | **6** |

**四个命令 ID 全部存在** —— 契约在当前版本**成立**。

### 18.3 相对路径的基准成立

`frontendUrl` 由 `packages/dev-middleware/src/utils/getDevToolsFrontendUrl.js:34-36` 构造：

```js
// packages/dev-middleware/src/utils/getDevToolsFrontendUrl.js:34-36
  const appUrl =
    (options?.relative === true ? '' : devServerUrl.origin) +
    '/debugger-frontend/rn_fusebox.html';
```

页面是 `<origin>/debugger-frontend/rn_fusebox.html` → 相对导入 `'./ui/legacy/legacy.js'` 解析到 `<origin>/debugger-frontend/ui/legacy/legacy.js`。

**实测该文件存在**：`packages/debugger-frontend/dist/third-party/front_end/ui/legacy/legacy.js`（**392551 字节**）。

### 18.4 但失败被静默吞掉

`getAction(...)?.execute()` —— **`getAction` 返回 `undefined` 时，`?.` 直接短路**，不抛错、不报警。

而模块路径是**相对导入**：若前端目录结构变化（`ui/legacy/legacy.js` 改名或移动），`await import(...)` 会 **reject** → `executeJavaScript` 返回一个 rejected Promise → **无人 `catch`** → **菜单项点了没反应，且没有任何提示**。

**判定：有意的取舍（跨包耦合不可避免，但失败路径既不校验也不上报）** —— **命令 ID 与路径当前都对**（§18.2、§18.3 实测），**风险在于没有任何机制在它们失效时告知使用者**。

---

## 19. DSH-18 `preload.js` 的前端契约「只检查不阻断」

```js
// packages/debugger-shell/src/electron/preload.js:14-37
contextBridge.executeInMainWorld({
  func: ipcDevTools => {
    let didDecorateInspectorFrontendHostInstance = false;
    // reactNativeDecorateInspectorFrontendHostInstance was introduced in
    // https://github.com/facebook/react-native-devtools-frontend/pull/168
    // $FlowFixMe[prop-missing]
    globalThis.reactNativeDecorateInspectorFrontendHostInstance = (
      InspectorFrontendHostInstance: $FlowFixMe,
    ) => {
      didDecorateInspectorFrontendHostInstance = true;
      InspectorFrontendHostInstance.bringToFront = () => {
        ipcDevTools.bringToFront();
      };
    };

    document.addEventListener('DOMContentLoaded', () => {
      if (!didDecorateInspectorFrontendHostInstance) {
        console.error(
          'reactNativeDecorateInspectorFrontendHostInstance was not called at startup. ' +
            'This version of the DevTools frontend may not be compatible with @react-native/debugger-shell.',
        );
      }
    });
  },
```

### 19.1 契约方向是**单向且有时序要求**的

**外壳**提供一个全局钩子 `globalThis.reactNativeDecorateInspectorFrontendHostInstance`；**前端**必须在启动时调用它，才能拿到 `bringToFront` 方法。

**若前端从未调用**：

| | 结果 |
| --- | --- |
| `bringToFront` | **永远不会被安装** → 前端调用 `InspectorFrontendHostInstance.bringToFront()` 会 **TypeError** |
| 外壳的检查 | **只在 `DOMContentLoaded` 时打一行 `console.error`**（`:31-34`） |
| 窗口 | **照常打开**，前端可能处于半残状态 |

### 19.2 检查与阻断的落差

`console.error` 写在**渲染进程的控制台**里 —— 而用户看到的是 Electron 应用窗口，**不会主动打开 DevTools 控制台**（且打包后 `toggleDevTools` 菜单项被移除，`packages/debugger-shell/src/electron/AppMenu.js:70-73`）。

**判定：自认边界（注释明确写了「may not be compatible」，但处理方式只是记录到用户看不到的地方）**。

---

## 20. 【核心 DSH-19】OSS 构建下版本号变成 `0.87.0-main-null`

### 20.1 源码态的 `BuildInfo` 是占位

```js
// packages/debugger-shell/src/electron/BuildInfo.js:11-13
export default {
  revision: 'dev',
};
```

### 20.2 真正的值由构建脚本生成

```js
// scripts/debugger-shell/build-binary.js:131-148
async function writeBuildInfo() {
  const template = await fs.promises.readFile(
    path.join(PACKAGE_ROOT, 'src/electron/BuildInfo.js.tpl'),
    'utf8',
  );
  const buildInfo = signedsource.signFile(
    util.format(
      template,
      signedsource.getSigningToken(),
      // revision
      JSON.stringify(additionalConfig.appVersionHash),
    ),
  );
  await fs.promises.writeFile(
    path.join(PACKAGE_ROOT, 'dist/electron/BuildInfo.js'),
    buildInfo,
  );
}
```

**模板把 `revision` 填成 `%s`**（`src/electron/BuildInfo.js.tpl`）。

### 20.3 `appVersionHash` 在 OSS 下是 `null`

```js
// scripts/debugger-shell/build-binary.js:19-28
let additionalConfig /*: Readonly<{
  appVersionHash: ?string,
}> */ = {
  appVersionHash: null,
};

if (isMetaInternal) {
  // $FlowFixMe[cannot-resolve-module] - not resolvable in OSS
  ({additionalConfig} = require('./metainternal/build-binary-setup'));
}
```

`isMetaInternal` 的判定是 `require.resolve('./metainternal/build-binary-setup')`（`:13-17`）—— **实测 `scripts/debugger-shell/` 在 OSS 仓库里只有 `build-binary.js` 一个文件，`metainternal/` 不存在** → `require.resolve` 抛错 → `isMetaInternal = false` → **`additionalConfig.appVersionHash` 保持 `null`**。

→ `JSON.stringify(null)` = `"null"` → 模板渲染出 `revision: null`。

### 20.4 后果

```js
// packages/debugger-shell/src/electron/index.flow.js:20-21
app.setName(pkg.productName ?? pkg.name);
app.setVersion(pkg.version + '-' + buildInfo.revision);
```

**`pkg.version + '-' + null`** → JS 字符串拼接把 `null` 转成 `"null"` → 版本串为 **`0.87.0-main-null`**（`pkg.version` 取自 `packages/debugger-shell/package.json:4`）。

**判定：结构脆弱（OSS 构建的版本号带 `-null` 后缀；不影响功能，但会出现在「关于」面板与遥测里）**。

### 20.5 一个刻意做对的地方

模板导出的是 **ESM 互操作形状**：

```js
// packages/debugger-shell/src/electron/BuildInfo.js.tpl:11-17
module.exports = {
  default: {
    revision: %s,
  },
  __esModule: true,
};
```

而源码版是 `export default {revision: 'dev'}`。**两者都能被同一句 `import buildInfo from './BuildInfo'` 正确取到** —— 这是**刻意**的：打包产物是纯 CJS 文件，而消费方用的是 ESM 默认导入，靠 `__esModule: true` 让 Babel 的互操作逻辑解开 `.default`。

---

## 21. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **DSH-1** | **【核心】入口分叉的两套判据可能给出不同答案**：`exports` 的条件**按声明顺序**匹配，`node` 写在 `electron` 之前 → 按包名解析时命中 node 变体；而 `packages/debugger-shell/src/index.js` 的运行时判断会选 electron 变体 | `packages/debugger-shell/package.json:12-19`、`:20-28`；`packages/debugger-shell/src/index.js:18-26` | **拿错变体不是风格差异** —— node 变体会**再拉起一个进程**，electron 变体才是窗口本体；**已发布包的 `exports` 顺序相同**（`scripts/build/prepack.js:30-34` 逐字段覆盖） |
| **DSH-2** | **【核心】`detached` 模式下 Promise 在 `spawn` 事件即 resolve** → 后续 `close` 里的 `reject()` **失效** | `packages/debugger-shell/src/node/index.flow.js:63-88` | **非零退出码无法经 Promise 上报** → `await` 的调用方**永远看到成功**；`mode` 默认值就是 `'detached'`（`:29`），**默认路径上是常态** |
| **DSH-3** | **【核心】`syncThenExit` 模式下 `silent` 为真时跳过 `process.exit(1)`** → 落到 `process.exit(null)` → **实测退出码 0** | `packages/debugger-shell/src/node/index.flow.js:98-110` | **被信号终止的子进程被报告为成功**；`silent` 只在 `NODE_ENV === 'test'` 为真（`:32`）→ **测试路径上把失败伪装成成功** |
| **DSH-4** | `ELECTRON_RUN_AS_NODE` 被显式从子进程 `env` 中剥离 | `packages/debugger-shell/src/node/index.flow.js:50-56` | ✓ **有注释论证的防御措施**（第一档注释） |
| **DSH-5** | **【核心】错误分类完全依赖 fb-dotslash 的 stderr 英文子串**（4 个固定短语），除 `success` 外不参考退出码、不解析结构化输出 | `packages/debugger-shell/src/node/private/LaunchUtils.js:55-95` | **上游改文案即静默降级为 `unexpected_error`** —— 不是崩溃，而是**可操作性信息丢失**（「连不上网」变成「未知错误」） |
| **DSH-6** | 同一个 `unexpected_error` 有**两种文案**：`catch` 分支不带 `humanReadableMessage` | `packages/debugger-shell/src/node/index.flow.js:175-180` vs `packages/debugger-shell/src/node/private/LaunchUtils.js:89-95` | 消费方有 `??` 兜底（`packages/dev-middleware/src/createDevMiddleware.js:181-182`）→ 不崩，但**同一 code 对应两种质量的用户提示** |
| **DSH-7** | `not_implemented` 在本包内**无任何产出路径**（类型联合声明了它） | `packages/debugger-shell/src/node/index.flow.js:127-137` | 本包内的该分支不可达；**但联合类型本身合理** —— 它由调用方产出（`packages/dev-middleware/src/middleware/openDebuggerMiddleware.js:55-56`） |
| **DSH-8** | 错误分类在消费端有**真实分级**：`unexpected_error` → `logger.error`；其余三种 → `logger.warn` + 各自的文案 | `packages/dev-middleware/src/createDevMiddleware.js:179-198`；`packages/dev-middleware/src/middleware/openDebuggerMiddleware.js:180-185` | ✓ **行为统一降级、提示分级** —— 设计得当 |
| **DSH-9** | **【核心】实现与 `DevToolLauncher` 契约的三条 SHOULD 全部背离** | `packages/dev-middleware/src/types/DevToolLauncher.js:38-44` vs `packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:89-96`、`:141-146` | S1（URL 不同也当同一会话）❌ / S2（不必要地重连）❌ / S3（处理 URL 变化）❌ —— **源码 TODO 自认其中两点** |
| **DSH-10** | **【核心】`second-instance` 处理器忽略 `electronArgv`（第二实例的 argv）**，改用 `additionalData.argv`（第一实例在申请单例锁时存的） | `packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:141-146`；`packages/debugger-shell/src/electron/index.flow.js:43-45` | **以不同 `frontendUrl` 再次启动时，新 URL 被丢弃**，窗口仍加载第一实例的 URL → **违反契约 S1**；正常 RN 流程下二者相同（同一 dev server + 同一 app） |
| **DSH-11** | **【核心】复用窗口时无条件 `loadURL` 重载** → CDP 连接被拆掉重建 | `packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:89-92` | **违反契约 S2**；**源码 TODO 自认**并写清了正确做法 → **「自认边界」典型形态** |
| **DSH-12** | `frontendUrl` **无必填校验** → 缺参时 `loadURL(undefined)` | `packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:28-41`、`:92` | 缺参时无友好报错，直接把 `undefined` 交给 Electron |
| **DSH-13** | **【核心】两处 `util.parseArgs` 的严格性设置不一致**：一处显式 `strict: false`，另一处用默认（`strict`） | `packages/debugger-shell/src/electron/index.flow.js:30-36` vs `packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:31-41` | strict 下遇未知选项 → `ERR_PARSE_ARGS_UNKNOWN_OPTION`、遇位置参数 → `ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL`（**均实测**）；**正常调用方只传 2 个参数故不触发**（`packages/dev-middleware/src/utils/DefaultToolLauncher.js:59-62`）；手工启动时异常发生在 `app.whenReady()` 回调里 → **无用户可见提示** |
| **DSH-14** | **【核心】`SettingsStore.get()` 的默认值语义是「值为 `undefined` 才回退」** → 配置里显式 `null` 时返回 `null` | `packages/debugger-shell/src/electron/SettingsStore.js:51-54`；`packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:109`、`:116` | `null[windowKey]` 抛 `TypeError`；**正常路径不可达**（本包写入的永远是对象），**配置被外部手改时可达** |
| **DSH-15** | 每次 `get`/`set` 都是**全量读盘 + 全量写盘**，且写盘挂在 `moved`/`resized`/`closed` 三个事件上 | `packages/debugger-shell/src/electron/SettingsStore.js:94-113`；`packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:121-135` | 拖拽窗口时逐事件同步 IO；**配置量极小（只有一个键）** → **有意的取舍**，本文不断言构成可感知问题 |
| **DSH-16** | `defaults`/`reset`/`clear` 的「恢复默认值」能力**在本包内从未被使用**；`set()` 里 `typeof key === 'object'` 分支被 Flow 类型 `key: string` 排除 | `packages/debugger-shell/src/electron/SettingsStore.js:33`、`:41-44`、`:58-62`、`:73-79`；`packages/debugger-shell/src/electron/MainInstanceEntryPoint.js:20` | `#defaultValues` 恒为 `{}` → `reset()` 空操作；死分支是 `electron-store` API 形状的残留 → **「历史承诺」形态** |
| **DSH-17** | 菜单命令经 `executeJavaScript` 动态 `import('./ui/legacy/legacy.js')` 调前端内部 API —— **跨包运行时耦合**；失败被 `?.` 与无人 catch 吞掉 | `packages/debugger-shell/src/electron/AppMenu.js:119-129` | ✓ **4 个命令 ID 在前端产物中均确认存在**（命中行数 10 / 8 / 7 / 6）；✓ **相对路径基准成立**（`ui/legacy/legacy.js` 实测存在，392551 字节）；**但失效时无任何提示** |
| **DSH-18** | `preload.js` 的 `reactNativeDecorateInspectorFrontendHostInstance` 契约**只检查不阻断** | `packages/debugger-shell/src/electron/preload.js:14-37` | 前端未调用时 `bringToFront` **永远不会被安装**；外壳只在渲染进程控制台打一行 `console.error`（用户看不到，打包后 `toggleDevTools` 菜单项还被移除） → **「自认边界」形态** |
| **DSH-19** | **【核心】OSS 构建下 `BuildInfo.revision` 为 `null`** → 版本串变成 `0.87.0-main-null` | `scripts/debugger-shell/build-binary.js:19-28`、`:131-148`；`packages/debugger-shell/src/electron/index.flow.js:21` | `additionalConfig.appVersionHash` 仅由 Meta 内部的 `metainternal/build-binary-setup` 覆盖（**OSS 无此目录，实测**）→ `JSON.stringify(null)` → `revision: null` → 字符串拼接出 `-null` 后缀；不影响功能，但会出现在「关于」与遥测里 |
| **DSH-20** | **启动失败日志的兜底分支不可达** —— `'...' + e.message ?? 'Unknown error'` 里 `+` 优先级更高，左边恒为字符串 → `??` 右侧永不生效 | `packages/dev-middleware/src/middleware/openDebuggerMiddleware.js:244-247` | `e.message` 为 `undefined` 时日志是 `Error launching DevTools: undefined` 而非 `Unknown error`；**运算符优先级问题，需给 `+` 加括号**；仅影响日志文案 |

---

## 22. 适用范围声明

| 维度 | DSH-1 / DSH-12 / DSH-13 | DSH-2 / DSH-3 | DSH-4 | DSH-5 / DSH-6 / DSH-7 / DSH-8 | DSH-9 / DSH-10 / DSH-11 | DSH-14 / DSH-15 / DSH-16 | DSH-17 / DSH-18 | DSH-19 | DSH-20 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **平台** | 宿主侧（macOS / Windows / Linux） | 同左 | 同左 | 同左 | 同左 | 同左 | 同左 | 同左 | 同左 |
| **架构** | 与架构无关（不涉及 Fabric / legacy） | 同左 | 同左 | 同左 | 同左 | 同左 | 同左 | 同左 | 同左 |
| **触发条件** | ① 按包名在 Electron 中 `require`；② 手工启动 shell 二进制 | ① `mode='detached'`（**默认**）；② `mode='syncThenExit'` 且 `silent` 为真 | 父进程带 `ELECTRON_RUN_AS_NODE=1` | fb-dotslash 拉取失败 | 同一 `windowKey` 再次启动 | 配置文件被手改为 `null`；拖拽窗口 | 前端目录结构变化；前端版本不兼容 | OSS 自行构建 | 启动 DevTools 抛出的异常没有 `message` 字段 |
| **当前是否造成功能问题** | **是**（DSH-1 可能拿到错变体）；DSH-12/13 **否**（正常调用方不触发） | **是**（DSH-2 默认路径上非零退出不可见；DSH-3 仅测试环境） | **否**（防御生效） | **否**（降级为提示信息变模糊） | **是**（URL 不同时新 URL 被丢弃；重载打断存活会话） | **否**（DSH-14 理论可达；DSH-15 代价小） | **否**（当前版本全部对得上） | **否**（仅版本串带 `-null`） | **否**（仅日志文案） |
| **是否已实机验证** | **部分** —— `exports` 顺序语义、strict 报错码、`process.exit(null)` 均**实测**；**Electron 解析器行为未验证** | **是** —— `process.exit(null)` 退出码实测为 0 | 否（代码级认定） | **部分** —— 分类依据已逐条核对；**未实测 fb-dotslash 的真实 stderr** | 否（代码级认定 + 契约原文对照） | 否（代码级认定） | **是** —— 4 个命令 ID 与 `ui/legacy/legacy.js` 均在产物中**检索确认** | **是** —— `metainternal/` 不存在已实测 | **是** —— 运算符优先级已实测 |

---

## 23. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 30 文档：`openDebuggerMiddleware` 建立的调试通道 | **本文补上通道的「消费端」** —— 通道连上之后，**窗口怎么开、参数怎么传、错误怎么分级**，此前无文档覆盖；本文 DSH-9/10/11 指出**外壳侧与契约的三处背离** |
| 49 文档：构建链路的静默失败 | **本文 DSH-2 / DSH-3 是同一形态的另一个实例** —— 那里是构建脚本，这里是**进程启动**；共同点：**失败被降级成「成功」而非报错** |
| 67 文档：特性开关的四级继承链 | **本文 DSH-10 的 `enableStandaloneFuseboxShell`** 是这条链上的一环 —— 开关决定走「独立 shell」还是「浏览器窗口」，**两条路的错误处理完全不同**（前者有 6 态错误码，后者没有） |
| 28 文档：iOS Dev 工具链的四层门控 | **对照** —— 那是**宿主侧**的四层门控，本文是**桌面端外壳**的入口分叉；两者共同点是**同一能力的多入口选择**，但 iOS 侧有门控、本文的两套判据**没有优先级约定**（DSH-1） |
| 66 文档 FFF-2：`getDroppedEntriesCount` 的监控盲区 | **对照 DSH-5** —— 那里是「计数器恒为 0」造成盲区，这里是「错误分类依赖外部文案」造成**盲区**：分类失败时仍会报错，但**报的是「未知错误」** |
| 73 文档：双实现漂移 | **对照 DSH-6** —— 那里是 `RedBoxErrorParser` 的 C++ / JS 两套实现漂移；这里是**同一个 code 的两条产出路径**给出两种文案，形态类似但成因不同（这里是**异常路径漏填字段**，不是两套实现） |
| §8 待办 #2：未声明文件清单 | **本文新增一个实例** —— `packages/debugger-frontend/`（含 `index.js`）**不属于任何模块**；其 `dist/` 已被 `baseline.excluded` 排除，故只需为 `index.js` 找归属（建议归 **B9**） |
