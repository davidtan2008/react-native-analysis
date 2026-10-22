---
id: 80
title: "TypeScript 类型测试的失效面：34 条 `$ExpectType` 无人解析、`strict: false` 下的恒真断言，以及 96 个 runtime 导出里 36 个从未进入测试"
topic: TL.test
symptoms: [build, debug]
platforms: [cross]
architecture: [cross]
layer: T4
symbols: ["$ExpectType", "tsconfig.json", "tsconfig.legacy.json", "types_generated", "types_DEPRECATED", "textInputProperties", "TextInputProperties", "ShadowStyleIOS", "requireNativeComponent", "declare var global", "HermesInternal", "Stringish"]
sourceRoot: react-native
claims: [TYP-1, TYP-2, TYP-3, TYP-4, TYP-5, TYP-6, TYP-7, TYP-8, TYP-9, TYP-10, TYP-11, TYP-12, TYP-13, TYP-14, TYP-15]
---
# 80 · TypeScript 类型测试的失效面：34 条 `$ExpectType` 无人解析、`strict: false` 下的恒真断言，以及 96 个 runtime 导出里 36 个从未进入测试

> **模块**：Z1 · `packages/react-native/__typetests__/`（8 个代码文件 / **2928** 行）
> + `packages/react-native/flow/`（3 个 `.js` / **222** 行）
>
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根）
> · **跨平台构建期检查**（TypeScript 编译器 + Flow libdef，均不进入运行时）
>
> **前置**：[49 文档](./49-构建工具链与静默失败.md) 记录 ESLint 报错不会让 CI 失败；
> [67 文档](./67-特性开关的四级继承链与未接CI的快照门禁.md) 记录 `@generated SignedSource` 全仓零校验；
> [78 文档](./78-构建期的静态检查与转译层.md) 记录 ESLint/Babel 两层判定各自与第三个真相源脱节；
> [79 文档](./79-JS与Native边界的类型兼容性检查器.md) 记录 schema 比较器里的死码与漏报。
>
> 本文记录 **15** 条结论：
> ① **【核心】34 条 `$ExpectType` 是纯注释** —— 全仓没有 `tsd` / `dtslint` / `eslint-plugin-expect-type`，`tsc` 不解析它；
> ② **【核心】`strict: false`** —— 只开了 `noImplicitAny` / `noImplicitThis`，`strictNullChecks` 关着，于是「传 `null` 应当报错」这类断言**天生恒真**；
> ③ **【核心】`lib: ["es2020"]` + `types: []`** —— `globals.tsx` 用到的全部全局名只能来自 `packages/react-native/src/types/globals.d.ts` 这一份 726 行的 `declare global`；
> ④ **【核心】覆盖缺口** —— `index.js` 的 **96** 个 runtime getter 导出里，**36** 个（11 个 `unstable_*`/`experimental_*` + 25 个稳定 API）在整个 `__typetests__` 里**一次都没有出现**；
> ⑤ `types_DEPRECATED/` 被 manifest 标为「已被 Flow 生成取代」，但它仍是 **deep import 的唯一类型来源**（`exports["./Libraries/*"].types` 显式为 `null`）；
> ⑥ 5 处 `@ts-ignore` 全压在 import 上；`legacy-properties.tsx` 整个文件被它架空；
> ⑦ `flow/global.js` 的 `[string | symbol]: any` 索引器把整份 `declare var global` 的类型面打穿。

---

## 1. 文件构成

### 1.1 本轮读的 11 个代码文件（Z1 范围）

| 文件 | 行数 | 角色 | 是否有 `@format` |
| --- | --- | --- | --- |
| `packages/react-native/__typetests__/index.tsx` | **2274** | 主测试面：逐个 API 的正例 + 11 处 `@ts-expect-error` | ✓ |
| `packages/react-native/__typetests__/globals.tsx` | **244** | 全局对象（timers / fetch / XHR / WebSocket / FormData） | **✗** |
| `packages/react-native/__typetests__/animated.tsx` | **236** | `Animated` 全 API + `Animated.*` 组件 | ✓ |
| `packages/react-native/__typetests__/stylesheet-create.tsx` | **55** | `StyleSheet.create` 的字段校验（含一处拼写错误应为 error） | ✓ |
| `packages/react-native/__typetests__/fabric-component-sample.ts` | **49** | Fabric 组件 spec 的编译期样本 | ✓ |
| `packages/react-native/__typetests__/stylesheet-flatten.tsx` | **33** | `StyleSheet.flatten` 的返回类型 | ✓ |
| `packages/react-native/__typetests__/turbo-module-sample.ts` | **23** | TurboModule spec 的编译期样本 | ✓ |
| `packages/react-native/__typetests__/legacy-properties.tsx` | **14** | 已废弃属性别名的编译期样本 | ✓ |
| `packages/react-native/flow/global.js` | **94** | `declare var global`（42 个 `readonly` 字段 + 一个索引器） | ✓ |
| `packages/react-native/flow/HermesInternalType.js` | **114** | `$HermesInternalType`（全部成员 `?`） | ✓ |
| `packages/react-native/flow/Stringish.js` | **14** | 一行 `declare type Stringish = string` | ✓ |
| **合计** | **3150** | | |

配置（不计入代码文件，但已通读）：

| 文件 | 行数 |
| --- | --- |
| `packages/react-native/__typetests__/tsconfig.json` | 16 |
| `packages/react-native/__typetests__/tsconfig.legacy.json` | 10 |

### 1.2 证据文件（跨模块引用，不计入本轮已读）

| 文件 | 用途 |
| --- | --- |
| `packages/react-native/src/types/globals.d.ts` | **726 行** `declare global` —— `globals.tsx` 全部全局名的唯一来源（TYP-3） |
| `packages/react-native/index.js` | 96 个 `get X()` runtime 导出的清单（TYP-4） |
| `packages/react-native/package.json` | `exports` 条件映射（TYP-5 / TYP-6） |
| `packages/react-native/types_DEPRECATED/index.d.ts` | 165 行，含 `/// <reference path="../src/types/globals.d.ts" />`（TYP-3 / TYP-6） |
| `.prettierrc.js` | `requirePragma: true`（TYP-10） |
| `.github/workflows/test-all.yml` | 两个 TypeScript job 的分工（TYP-5） |

### 1.3 `flow/` 目录里**不在**本文覆盖口径内的 5 个文件

`packages/react-native/flow/` 实际有 **8** 个文件，但覆盖度只统计 3 个（见 TYP-13）：

| 文件 | 行数 | 为何不计 |
| --- | --- | --- |
| `packages/react-native/flow/dom.js.flow` | 6283 | `path.extname()` = `.flow`，不在 `CODE` 扩展名集合里 |
| `packages/react-native/flow/bom.js.flow` | 815 | 同上 |
| `packages/react-native/flow/cssom.js.flow` | 567 | 同上 |
| `packages/react-native/flow/streams.js.flow` | 140 | 同上 |
| `packages/react-native/flow/prettier.js.flow` | 14 | 同上 |

---

## 2. 【核心 TYP-1】34 条 `$ExpectType` 是纯注释，没有任何工具解析

### 2.1 分布

`$ExpectType` 是 **tsd** / **dtslint** 的指令语法：工具读取注释里写的类型，再与编译器推断出的类型做**字符串相等**比较。它不是 TypeScript 语言的一部分。

| 文件 | 处数 |
| --- | --- |
| `packages/react-native/__typetests__/index.tsx` | **28** |
| `packages/react-native/__typetests__/animated.tsx` | **6** |
| **合计** | **34** |

全仓 `grep -rn 'ExpectType'` 在 `__typetests__/` 之外的命中**只有** `flow-typed/npm/jest.js` 里的 `JestExpectType`（Jest matcher 的类型，与本文无关）。

### 2.2 没有消费者

| 检查项 | 结果 |
| --- | --- |
| `package.json` 里的 `tsd` / `dtslint` 依赖 | **无** |
| `node_modules` 里的 `tsd` / `dtslint` / `eslint-plugin-expect-type` | **无** |
| `packages/eslint-config-react-native/` 里的 `expect-type` 规则 | **无** |
| 任何脚本读取 `$ExpectType` | **无** |

`tsc` 把 `// $ExpectType X` 当成普通行尾注释，**完全不读**。

### 2.3 它们本该断言什么 —— 三个例子

`packages/react-native/__typetests__/index.tsx:1541-1544`：

```tsx
// packages/react-native/__typetests__/index.tsx:1541-1544
// $ExpectType HostComponent<{ nativeProp: string; }>
const NativeBridgedComponent = requireNativeComponent<{nativeProp: string}>(
  'NativeBridgedComponent',
);
```

`packages/react-native/__typetests__/index.tsx:1870-1875`：

```tsx
// packages/react-native/__typetests__/index.tsx:1870-1875
Platform.select({native: 1}); // $ExpectType number | undefined
Platform.select({native: 1, web: 2, default: 0}); // $ExpectType number
Platform.select({android: 1}); // $ExpectType number | undefined
Platform.select({android: 1, ios: 2, default: 0}); // $ExpectType number
Platform.select({android: 1, ios: 2, macos: 3, web: 4, windows: 5}); // $ExpectType number | undefined
Platform.select({android: 1, ios: 2, macos: 3, web: 4, windows: 5, default: 0}); // $ExpectType number
```

`packages/react-native/__typetests__/animated.tsx:193-196`：

```tsx
// packages/react-native/__typetests__/animated.tsx:193-196
          const x = event.nativeEvent.layout.x; // $ExpectType number
          const y = event.nativeEvent.layout.y; // $ExpectType number
          const width = event.nativeEvent.layout.width; // $ExpectType number
          const height = event.nativeEvent.layout.height; // $ExpectType number
```

这三组断言覆盖的是**最容易被改坏的返回类型**（`requireNativeComponent` 的泛型、`Platform.select` 的 `default` 有无、布局事件的字段类型）。它们全部**只在注释里**。

### 2.4 判定

**缺陷（断言形式无效）。** 34 处 `$ExpectType` 的实际约束力是 **0**。要让它们生效，需要：

1. 引入 `tsd` 或 `eslint-plugin-expect-type`；或
2. 改写成可被 `tsc` 检查的形式（`const _x: number = event.nativeEvent.layout.x;`），这也是该文件其它地方已经在用的写法。

对照：`packages/react-native/__typetests__/globals.tsx` 用的是 **`@ts-expect-error`**（27 处里占 14 处），那是 `tsc` 原生支持的指令，**真的会生效**。同一个目录里两种断言写法，一种有效、一种无效，而无效的那种恰好集中在类型契约最关键的 34 个点上。

---

## 3. 【核心 TYP-2】`strict: false`：一半的断言在类型系统里恒真

### 3.1 配置原文

`packages/react-native/__typetests__/tsconfig.json:3-14`：

```json
// packages/react-native/__typetests__/tsconfig.json:3-14
  "compilerOptions": {
    "module": "esnext",
    "lib": ["es2020"],
    "strict": false,
    "noImplicitAny": true,
    "noImplicitThis": true,
    "types": [],
    "jsx": "react",
    "noEmit": true,
    "forceConsistentCasingInFileNames": true,
    "moduleResolution": "bundler"
  },
```

`"strict": false` 把 `strict` 家族**全部**关掉，然后只单独打开了两个。

### 3.2 被关掉的四个开关及后果

| 开关 | 状态 | 后果 |
| --- | --- | --- |
| `strictNullChecks` | **关** | `null` / `undefined` 可赋给**任何**类型 → 「传 `null` 应当报错」的断言**永远通过** |
| `strictFunctionTypes` | **关** | 函数参数按 **bivariant** 检查 → 参数类型不兼容的赋值可能被接受 |
| `strictPropertyInitialization` | **关** | 类字段不要求初始化 → `index.tsx` 里 `nativeComponentRef: ... | null;` 这类未初始化字段不报错 |
| `useUnknownInCatchVariables` | **关** | `catch (e)` 的 `e` 是 `any` |

### 3.3 `strictNullChecks` 关着意味着哪几条断言失效

`packages/react-native/__typetests__/index.tsx` 里成组出现的「`null` 也应该被接受」用例：

```tsx
// packages/react-native/__typetests__/index.tsx:1636-1646
const SwitchColorNullTest = () => (
  <Switch trackColor={{true: 'pink', false: null}} />
);

const SwitchThumbColorTest = () => <Switch thumbColor={'red'} />;

const SwitchOnChangeWithoutParamsTest = () => (
  <Switch onChange={() => console.log('test')} />
);
const SwitchOnChangeUndefinedTest = () => <Switch onChange={undefined} />;
const SwitchOnChangeNullTest = () => <Switch onChange={null} />;
```

在 `strictNullChecks: false` 下，`onChange={null}` 与 `onChange={undefined}` 对**任意** `onChange` 类型都成立 —— 包括 `onChange: (e) => void`（不可空）。所以这两个用例证明不了「`onChange` 接受 `null`」，只能证明「`null` 是 `any` 的一部分」。

同样的形态还有 `trackColor={{true: 'pink', false: null}}`（`:1637`）、`dataDetectorType={null}`（`:2188`）、`destructiveButtonIndex: undefined` / `null`（`:2236`、`:2245`）。

**同理，反向断言也不成立**：文件里**没有**一条「传 `null` 应当报错」的 `@ts-expect-error` —— 因为在这个配置下它必然报「Unused '@ts-expect-error' directive」。

### 3.4 判定

**缺陷（测试强度被配置削弱）。** `strict: false` 是有意的（否则这个文件里大量历史遗留写法会一次性崩掉），但代价必须写清楚：**该目录对 nullability 的覆盖是 0**。文档与 CI 都把它当作「TypeScript 类型已校验」，而实际校验的只是「非 strict 下的结构可赋值性」。

---

## 4. 【核心 TYP-3】`lib: es2020` + `types: []`：`globals.tsx` 测的是同一份 726 行 d.ts 两次

### 4.1 `globals.tsx` 没有任何 import

`packages/react-native/__typetests__/globals.tsx:8-15`：

```tsx
// packages/react-native/__typetests__/globals.tsx:8-15
const noop = () => { };

function testInterval() {
    clearInterval(null);
    clearInterval(undefined);

    let handle = setInterval(noop, 0);
    clearInterval(handle);
```

`setInterval`、`fetch`、`XMLHttpRequest`、`WebSocket`、`FormData`、`console`、`Blob`、`FileReader`、`URLSearchParams`、`WindowOrWorkerGlobalScope` 全部是**裸全局名**。

### 4.2 这些名字不可能来自 `lib`

`tsconfig.json:5` 是 `"lib": ["es2020"]` —— **不含 `DOM`**；`tsconfig.json:9` 是 `"types": []` —— **不自动加载任何 `@types/*`**。所以：

- `fetch` / `WebSocket` / `FormData` / `XMLHttpRequest` / `WindowOrWorkerGlobalScope` 都不可能来自标准库；
- `console` 也不可能（`console` 在 `lib.dom` 里，不在 `es2020` 里）。

### 4.3 唯一来源

`packages/react-native/src/types/globals.d.ts` 共 **726** 行，主体是一个 `declare global { ... }` 块（`:12`），里面声明了 `require`、`console`、`XMLHttpRequest` 等 RN 自有全局。

两个 project 都把它拉进来，路径不同：

| project | 拉入方式 |
| --- | --- |
| `tsconfig.json`（生成产物） | `exports["."].types` → `types_generated/index.d.ts`；`types_generated/` 由 `scripts/js-api/build-types` 从 `src/types/` 生成 |
| `tsconfig.legacy.json` | `types_DEPRECATED/index.d.ts:71` 的三斜线引用 |

`packages/react-native/types_DEPRECATED/index.d.ts:68-71`：

```ts
// packages/react-native/types_DEPRECATED/index.d.ts:68-71
/// <reference path="modules/BatchedBridge.d.ts" />
/// <reference path="modules/Codegen.d.ts" />
/// <reference path="modules/Devtools.d.ts" />
/// <reference path="../src/types/globals.d.ts" />
```

### 4.4 结论

**`globals.tsx` 实际是同一份 `src/types/globals.d.ts` 的两次编译。** 这在设计上是合理的（同一份源码要同时服务两种产物），但有两个后果必须记下来：

1. **它不是「浏览器全局」的测试**。`globals.tsx` 里 `fetch` / `WebSocket` / `FormData` 的签名来自 RN 自己的声明，与 `lib.dom` 无关 —— 名字看起来像 Web 标准，实际是 RN 的 polyfill 契约。
2. **`globals.tsx` 是这份 726 行 d.ts 的唯一测试**。该目录之外没有任何文件以裸全局名的方式使用这些声明。

---

## 5. 【核心 TYP-4】96 个 runtime 导出里 36 个从未进入类型测试

### 5.1 口径

- **分母**：`packages/react-native/index.js` 里的 `get X() { ... }` 访问器 —— **96** 个。这是 RN 公共 API 的**运行时**导出面（纯类型导出不在此列）。
- **分子**：`__typetests__/` 下 8 个代码文件里所有 `import { ... } from 'react-native'` 中出现的名字（`as` 别名两侧都计入）。

### 5.2 实测

| 指标 | 数值 |
| --- | --- |
| `index.js` runtime getter 导出 | **96** |
| 被 `__typetests__` import 到的 | **60** |
| **从未出现** | **36** |
| 其中 `unstable_*` / `experimental_*` | **11** |
| 其中**稳定 API** | **25** |

### 5.3 25 个稳定但零覆盖的导出

`ActivityIndicator`、`AssetRegistry`、`Clipboard`、`DeviceInfo`、`DevMenu`、`Easing`、`EventEmitter`、`NativeAppEventEmitter`、`NativeComponentRegistry`、`Networking`、`PanResponder`、`PixelRatio`、`ReactNativeVersion`、`RootTagContext`、`Settings`、`UTFSequence`、`Vibration`、`VirtualizedSectionList`、`VirtualViewMode`、`AppRegistry`、`registerCallableModule`、`useAnimatedValue`、`useAnimatedValueXY`、`useAnimatedColor`、`usePressability`。

11 个非稳定导出（同样零覆盖）：`experimental_LayoutConformance` 之外的 `unstable_NativeText`、`unstable_NativeView`、`unstable_TextAncestorContext`、`unstable_VirtualView`、`unstable_VirtualArray`、`unstable_createVirtualCollectionView`、`unstable_VirtualColumn`、`unstable_VirtualColumnGenerator`、`unstable_VirtualRow`、`unstable_getScrollParent`、`unstable_DEFAULT_INITIAL_NUM_TO_RENDER`。

### 5.4 为什么这不是「36 个都没测」

`index.tsx` 里的一处 import 只是**必要条件**。真正被约束的还要看是否有：

- 正例（能被赋值 / 能被调用），或
- `@ts-expect-error`（用错必须报错）。

按这个更严的口径，实际有断言行为的导出**远少于 60 个** —— 例如 `ToastAndroid`、`I18nManager`、`DevSettings`、`LayoutAnimation` 只被调用过、没有反向用例；而 `Easing`、`PixelRatio`、`PanResponder`、`Vibration` 连 import 都没有。

**判定：覆盖缺口（可量化）。** 与 [78 文档](./78-构建期的静态检查与转译层.md) LNT-14 的形态相同 —— 那里是 `lazy-imports.js` 与 `index.js` 两个清单不同步；这里是**测试清单与导出清单不同步**，且没有任何机制会提醒。

---

## 6. TYP-5 `types_generated/` 不在树里：两个 project 的分工与前置

### 6.1 `types_generated/` 被忽略且不存在

- `.gitignore:178`：`/packages/**/types_generated/`
- 工作树实测：`packages/react-native/types_generated` **不存在**（只有 `types_DEPRECATED`）
- `packages/react-native/package.json:33`：`"types": "./types_generated/index.d.ts"`

于是：

| 命令 | 能否直接跑 | 原因 |
| --- | --- | --- |
| `yarn test-generated-typescript` | **不能** | 必须先 `yarn build-types`，否则 `react-native` 的类型入口不存在 |
| `yarn test-typescript-legacy` | **能** | `types_DEPRECATED/index.d.ts` 在树里，且自带三斜线引用补齐全局声明 |

### 6.2 CI 的分工与一处不对称

`.github/workflows/test-all.yml`：

| 行 | job | 步骤 |
| --- | --- | --- |
| `:573` | `lint` | `yarn test-typescript-legacy` —— **前面没有 `build-types`** |
| `:604` | `build_js_types` | `yarn build-types --skip-snapshot` |
| `:607` | `build_js_types` | `yarn test-generated-typescript` |

这不是缺陷（两个 job 各自可用），但它说明一件事：**两个 job 检查的是两套不同的类型源**，而它们共享同一批 8 个测试文件。任何一个测试文件通过，只能说明「在它跑的那个 source 下通过」。

### 6.3 一处可验证的后果

`tsconfig.legacy.json:6-8` 只改了一个选项：

```json
// packages/react-native/__typetests__/tsconfig.legacy.json:6-8
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "customConditions": ["react-native-legacy-deep-imports"]
  }
```

`customConditions` 只影响 **`exports` 条件解析**，不影响 `lib` / `types` / `strict`。所以两个 project 的**测试强度完全相同**，差异只在「类型从哪来」。

---

## 7. TYP-6 `types_DEPRECATED/` 的三处接线：它并不是「已弃用」那么简单

### 7.1 manifest 的说法

`docs/arch/audit/module-manifest.json` 的 `baseline.excluded.paths` 把它排除在模块划分之外，理由写作：

> `packages/react-native/types_DEPRECATED` —— 手写旧版 `.d.ts`，已被 Flow 生成取代

### 7.2 但它仍被三处引用

`packages/react-native/package.json:31-43`：

```json
// packages/react-native/package.json:31-43
    ".": {
      "react-native-legacy-deep-imports": "./types_DEPRECATED/index.d.ts",
      "types": "./types_generated/index.d.ts",
      "default": "./index.js"
    },
    "./Libraries/*": {
      "react-native-legacy-deep-imports": "./types_DEPRECATED/Libraries/*.d.ts",
      "types": null,
      "default": "./Libraries/*.js"
    },
```

| 接线点 | 位置 |
| --- | --- |
| `exports["./Libraries/*"]` 的 legacy 条件 | `packages/react-native/package.json:37` |
| 发布清单 `files` 数组 | `packages/react-native/package.json` 的 `files` 内含 `types_DEPRECATED` |
| CI 的独立 job | `.github/workflows/test-all.yml:561-573` |

### 7.3 关键：deep import 的类型**只**存在于 legacy 条件

注意 `./Libraries/*` 的 `"types": null`（`:38`）—— 这是显式声明「在默认条件下**没有**类型」，请求会落到 `"default": "./Libraries/*.js"`，即**无类型的 JS**。

所以：

- 在**生成产物**条件下，`import {X} from 'react-native/Libraries/...'` 是**无类型**的；
- 在**legacy** 条件下，它指向 `types_DEPRECATED/Libraries/*.d.ts`，**有类型**。

**结论：`types_DEPRECATED/` 不是「已被取代」，而是「deep import 的唯一类型来源」。** manifest 里的那句说明把一个**仍在承担唯一职责**的目录描述成了历史包袱。删掉它，`test-typescript-legacy` 会立刻失去意义，`react-native/Libraries/*` 也再没有任何类型覆盖。

**判定：文档与实现不一致（manifest 的描述低估了该目录的作用）。** 这与 [79 文档](./79-JS与Native边界的类型兼容性检查器.md) CMP-17 同型 —— 一处描述与代码事实不符，且方向都是「描述写得比实际更理想」。

---

## 8. TYP-7 5 处 `@ts-ignore` 全压在 import 上

### 8.1 位置

| 行 | 被压住的名字 | 文件内注释 |
| --- | --- | --- |
| `packages/react-native/__typetests__/index.tsx:55` | `ImageResizeMode` | — |
| `packages/react-native/__typetests__/index.tsx:69` | `NativeModule` | `// Not actually exported, not sure why` |
| `packages/react-native/__typetests__/index.tsx:81` | `RegisteredStyle` | — |
| `packages/react-native/__typetests__/index.tsx:104` | `TextInputScrollEvent` | — |
| `packages/react-native/__typetests__/index.tsx:124` | `SectionListData` | — |

`packages/react-native/__typetests__/index.tsx:69-71`：

```tsx
// packages/react-native/__typetests__/index.tsx:69-71
  // @ts-ignore
  NativeModule, // Not actually exported, not sure why
  NativeModules,
```

### 8.2 后果是三重的

1. **import 本身不被检查** —— 这 5 个名字是否真的从 `react-native` 导出，`tsc` 不会告诉你。
2. **后续使用退化为 `any`** —— 一个被 `@ts-ignore` 压住的具名 import，其绑定类型是 `any`，所以 `RegisteredStyle` / `TextInputScrollEvent` / `SectionListData` 在文件里的所有用法**都没有类型**。
3. **它掩盖了「哪个 project 缺这个导出」** —— `ImageResizeMode`、`ShadowStyleIOS`、`TextInputProperties` 在 `types_DEPRECATED/` 里**都存在**（`types_DEPRECATED/index.d.ts:114`、`types_DEPRECATED/Libraries/StyleSheet/StyleSheetTypes.d.ts:200`、`types_DEPRECATED/public/DeprecatedPropertiesAlias.d.ts:79`）。也就是说，legacy project 下这些 import **本来不需要** `@ts-ignore`；它存在大概率是为了让生成产物那一侧也能过。

### 8.3 判定

**缺陷（`@ts-ignore` 被用作跨 project 的粘合剂）。** 更精确的写法是 `@ts-expect-error`（缺导出时必须报错），或者在两个 project 间分开维护 import 清单。当前的写法在「导出真的消失」时**不会有任何反应**。

---

## 9. TYP-8 `legacy-properties.tsx` 的自我架空

整个文件 14 行，去掉版权头剩 5 行：

```tsx
// packages/react-native/__typetests__/legacy-properties.tsx:10-14
import * as React from 'react';
// @ts-ignore
import {TextInputProperties} from 'react-native';

class Test extends React.Component<TextInputProperties> {}
```

### 9.1 这个文件想测什么

`TextInputProperties` 是 `TextInputProps` 的**已废弃别名**（`types_DEPRECATED/public/DeprecatedPropertiesAlias.d.ts:79`：`export type TextInputProperties = TextInputProps;`）。这个文件的唯一目的就是「确认这个别名还能被消费者使用」。

### 9.2 实际测到了什么

| 检查项 | 结果 |
| --- | --- |
| import 是否解析成功 | **不检查**（`@ts-ignore`） |
| `TextInputProperties` 是否为合法类型名 | **不检查**（import 被压住 → 绑定为 `any`，`React.Component<any>` 合法） |
| 该别名是否仍是 `TextInputProps` | **不检查**（class 体为空，没有一处用到具体 prop） |

**如果今天把 `TextInputProperties` 从 `types_DEPRECATED` 里删掉，这个文件仍然会通过。**

**判定：缺陷（测试完全失效）。** 与 [77 文档](./77-测试工具层的静默失效与内部构建边界.md) 的「测试工具自己的静默失效」同型，但更彻底：这里连**被测对象是否存在**都不再检查。

---

## 10. TYP-9 `animated.tsx` 主动跳过的断言

`packages/react-native/__typetests__/animated.tsx:219-228`：

```tsx
// packages/react-native/__typetests__/animated.tsx:219-228
        renderItem={info => {
          /*
           * Original <SectionList> expects:
           * SectionListRenderItemInfo<any>    on TS@3.5,
           * SectionListRenderItemInfo<number> on TS@4.0.
           * Skip until original is adjusted and type can be asserted
           */
          info; // Should expect SectionListRenderItemInfo<number>
          info.section.title; // $ExpectType string
          return <View testID={info.item.toFixed(1)} />;
```

三层递减的效力：

1. `info;` 这一行**什么都不做**（表达式语句，未使用）；
2. 它的注释是 `// Should expect ...` —— **不是** `$ExpectType`，连那套无效的约定语法都没遵守；
3. 紧接的 `info.section.title; // $ExpectType string` 又回到无效语法。

注释给出的理由是「TS 3.5 与 4.0 的推断不同，等上游调整」。当前仓库的 TypeScript 版本远高于 4.0（`package.json` 里 `prettier` 是 `3.9.4`，TS 也是 5.x），**这个理由已经失效，但注释与跳过都留着**。

**判定：缺陷（过期的跳过理由 + 三重无效断言）。**

---

## 11. TYP-10 `globals.tsx` 是全目录唯一不受 Prettier 约束的文件

`.prettierrc.js:14`：

```js
// .prettierrc.js:14
  requirePragma: true,
```

`requirePragma: true` 意味着 Prettier **只格式化文件头带 `@format` 注释的文件**；`format-check-javascript` 同样按这个规则，所以缺 pragma 的文件**既不格式化也不被检查**。

实测 11 个文件里只有 1 个缺 `@format`：

| 文件 | `@format` |
| --- | --- |
| `packages/react-native/__typetests__/index.tsx` | ✓ |
| `packages/react-native/__typetests__/animated.tsx` | ✓ |
| `packages/react-native/__typetests__/stylesheet-create.tsx` | ✓ |
| `packages/react-native/__typetests__/stylesheet-flatten.tsx` | ✓ |
| `packages/react-native/__typetests__/legacy-properties.tsx` | ✓ |
| `packages/react-native/__typetests__/fabric-component-sample.ts` | ✓ |
| `packages/react-native/__typetests__/turbo-module-sample.ts` | ✓ |
| **`packages/react-native/__typetests__/globals.tsx`** | **✗** |
| `packages/react-native/flow/global.js` | ✓ |
| `packages/react-native/flow/HermesInternalType.js` | ✓ |
| `packages/react-native/flow/Stringish.js` | ✓ |

证据在文本本身：`globals.tsx` 全篇是 **4 空格缩进**（同目录其它文件是 2 空格），并且有 `const noop = () => { };`（`:8`）这种 Prettier 一定会改写的写法。

**判定：轻微缺陷（格式化盲区）。** 不影响类型检查，但它是该目录唯一一个游离在格式门禁之外的文件 —— 而「游离在门禁之外的文件」正是本知识库反复记录的那类风险。

---

## 12. TYP-11 `flow/global.js` 的索引器把整份声明打穿

`packages/react-native/flow/global.js:86-88`：

```js
// packages/react-native/flow/global.js:86-88
  // Undeclared properties are implicitly `any`.
  [string | symbol]: any,
};
```

### 12.1 这份声明的意图

文件头注释（`:11-17`）写得很清楚：

> `global` is a object containing all the global variables for React Native.
> NOTE: Consider cross-platform as well as JS environments compatibility when defining the types here.
> Consider both presence (`?`) as well as writeability (`+`) when defining types.

然后逐一列出 42 个 `readonly` 字段（`window`、`self`、`process`、`performance`、13 个 XHR/fetch 家族、`alert`、`navigator`、11 个 timer、`console`、`HermesInternal`、`__DEV__`、`RN$Bridgeless`、2 个 DOMRect）。

### 12.2 索引器的实际效果

`[string | symbol]: any` 使得**任何**未声明名字的读取都得到 `any`：`global.anythingAtAll`、`global.settimeout`（`setTimeout` 的拼写错误）、`global.window.document` 三者全部通过类型检查。

`readonly` 只约束**已声明**的 42 个名字；对**未声明**的名字，这个索引器直接给出 `any`。也就是说这份声明的实际保护面是：

- ✓ 拼对了名字 → 拿到精确类型；
- ✗ 拼错了名字 → 拿到 `any`，**没有任何提示**；
- ✗ 名字被删除 → 访问仍然成功，类型是 `any`。

第 2、3 条正是「类型声明应该防住」的两类错误。

### 12.3 判定

**已知权衡，但代价被低估。** 注释自认「Undeclared properties are implicitly `any`」，说明作者清楚。可在 RN 里 `global.X` 的读取恰恰是「跨 JS 引擎 / 跨平台能力探测」的主要写法（`global.HermesInternal`、`global.RN$Bridgeless`、`global.__DEV__`），拼写错误的概率不低。

对比 `flow/HermesInternalType.js` 的做法：`$HermesInternalType` 是**精确对象**（`{...}` 结尾没有 `...`，也没有索引器），所以 `HermesInternal.getNumGCCount` 这种拼写错误会被 Flow 抓住。两份文件在同一个目录里，一份精确、一份渗透。

---

## 13. TYP-12 `__DEV__` 的注释与事实

`packages/react-native/flow/global.js:90-94`：

```js
// packages/react-native/flow/global.js:90-94
// Declared as a bare global so unqualified `__DEV__` references type-check as
// `boolean`. The suppression is a no-op in this checkout but avoids a duplicate
// declaration where `__DEV__` is also declared by another Flow libdef.
// $FlowFixMe[libdef-override]
declare var __DEV__: boolean;
```

注释说「避免与**另一个 Flow libdef**里的 `__DEV__` 重复声明」。实测全仓 `__DEV__` 的声明只有两处：

| 位置 | 类型 | Flow 是否读取 |
| --- | --- | --- |
| `packages/react-native/flow/global.js:94` | Flow `declare var` | ✓ |
| `packages/react-native/src/types/globals.d.ts:56` | TypeScript `declare global { const __DEV__: boolean }` | **✗**（Flow 不读 `.d.ts`） |

`flow-typed/` 下没有任何 `__DEV__` 声明（`[libs]` 只包含 `flow-typed/` 与 `packages/react-native/flow/` 两个目录）。

所以注释里的「另一个 Flow libdef」在**当前 commit 下不存在**；事实上的重复是「Flow 声明」与「TypeScript 声明」之间的重复，而这两者本来就不会冲突（分属两个类型系统）。

**判定：注释与事实不符（措辞层面）。** 注释自己已经写了「The suppression is a no-op in this checkout」，所以作者知道它无效；问题在于后半句给出的**原因**指错了对象。这与 [79 文档](./79-JS与Native边界的类型兼容性检查器.md) CMP-9 的 `$FlowFixMe` 注释同型 —— **抑制注释旁边的那句解释比抑制本身更容易误导人**。

> 未运行 `flow check`，因此不对「未使用的 `$FlowFixMe` 是否会让 Flow 报错」下结论。

---

## 14. TYP-13 `flow/*.js.flow` 不在覆盖度口径内

覆盖度脚本的文件判定是 `path.extname(p) ∈ {.js,.mjs,.ts,.tsx,.kt,.java,.mm,.m,.h,.cpp,.cc,.swift,.py}`（`docs/arch/audit/normalize-manifest.mjs` 的 `CODE` 集合）。

对 `packages/react-native/flow/dom.js.flow` 来说，`path.extname()` 返回 **`.flow`**，不在集合里 → 整个文件不被计入。

| 目录实际内容 | 文件数 | 行数 |
| --- | --- | --- |
| 计入（`.js`） | 3 | 222 |
| **不计入（`.js.flow`）** | **5** | **7819** |
| 合计 | 8 | 8041 |

`dom.js.flow` 单个文件 6283 行，是全目录的主体。它是从 TypeScript 的 `lib.dom` 移植来的 DOM libdef（`bom` / `cssom` / `dom` / `streams` 四件套）。

**判定：口径事实，非缺陷。** 把移植来的 libdef 排除在「已读源码」之外是合理的。记下来是因为它影响两个数字：

1. `packages/react-native/flow/` 在覆盖度里只算 **3** 个文件，不是 8 个；
2. 任何「flow 目录已读完」的说法必须明确指的是那 3 个 `.js`。

---

## 15. TYP-14 两个 codegen 样本只验证正例

`packages/react-native/__typetests__/fabric-component-sample.ts` 和 `turbo-module-sample.ts` 的定位与其它文件不同：它们不是断言文件，而是**编译期样本** —— 只要 `codegenNativeComponent` / `codegenNativeCommands` / `TurboModuleRegistry` 的类型签名变了，这两个文件就编译失败。

`packages/react-native/__typetests__/fabric-component-sample.ts:22-34`：

```ts
// packages/react-native/__typetests__/fabric-component-sample.ts:22-34
interface NativeProps extends ViewProps {
  string?: string | undefined;
  number?: number | undefined;
  boolean?: boolean | undefined;
  default?:
    CodegenTypes.WithDefault<'option1' | 'option2', 'option1'> | undefined;
  double?: CodegenTypes.Double | undefined;
  float?: CodegenTypes.Float | undefined;
  int32?: CodegenTypes.Int32 | undefined;
  unsafeObject?: CodegenTypes.UnsafeObject | undefined;
  onBubblingEventHandler?: CodegenTypes.BubblingEventHandler<Event> | undefined;
  onDirectEventHandler?: CodegenTypes.DirectEventHandler<Event> | undefined;
}
```

它覆盖了 `CodegenTypes` 的 **9** 个成员（`Double`/`Float`/`Int32`/`UnsafeObject`/`WithDefault`/`BubblingEventHandler`/`DirectEventHandler` + `ViewProps`/`HostComponent`），是本目录里对 Codegen 类型面最完整的一处。

**但两个文件里 `@ts-expect-error` 数量是 0**：

| 文件 | `@ts-expect-error` | 正例 |
| --- | --- | --- |
| `packages/react-native/__typetests__/fabric-component-sample.ts` | 0 | ✓ |
| `packages/react-native/__typetests__/turbo-module-sample.ts` | 0 | ✓ |

所以它们能保证「这样写能编译」，不能保证「写错了会报错」—— 例如把 `CodegenTypes.Int32` 换成 `number` 不会被发现（如果两者可赋值），把 `WithDefault` 的默认值写成不在联合里的值也不会被检查（该文件没有这类用例）。

**判定：定位清晰，覆盖偏正例。** 记下来是为了区分「编译样本」与「断言文件」—— 在统计覆盖时不应该把这两个文件计入「有断言的 API 数」。

---

## 16. TYP-15 两处「为了通过而压制」

### 16.1 `@ts-ignore` 盖住整条 import

`packages/react-native/__typetests__/stylesheet-create.tsx:10-12`：

```tsx
// packages/react-native/__typetests__/stylesheet-create.tsx:10-12
import * as React from 'react';
// @ts-ignore
import {View, StyleSheet, type ShadowStyleIOS} from 'react-native';
```

`@ts-ignore` 作用于**整条 import 语句**，不只是 `ShadowStyleIOS`。于是同一个语句里的 `View` 和 `StyleSheet` 也不再被检查 —— 尽管它们在 `index.js` 里都是有 getter 的正式导出。

同一个文件里真正有效的断言只有一处，而且写对了：

```tsx
// packages/react-native/__typetests__/stylesheet-create.tsx:36-43
const styles2 = StyleSheet.create({
  container: {
    position: 'absolute',
    // Should error due to misspelled parameter name
    // @ts-expect-error
    magrinRight: 1,
  },
});
```

`magrinRight` 是 `marginRight` 的拼写错误，`@ts-expect-error` 会真正生效 —— 这是本目录「反向断言」写得最正确的一处。

### 16.2 `as ViewStyle` 绕开 `flatten` 的返回类型

`packages/react-native/__typetests__/stylesheet-flatten.tsx:17-20`：

```tsx
// packages/react-native/__typetests__/stylesheet-flatten.tsx:17-20
export function App(props: Props) {
  const backgroundColor = (
    StyleSheet.flatten([styles.container, props.style]) as ViewStyle
  ).backgroundColor;

  return (
```

这个文件名为 `stylesheet-flatten`，目的应是校验 `StyleSheet.flatten` 的**返回类型**；而 `as ViewStyle` 把返回值断言成已知类型，于是 `flatten` 到底返回什么**不再被检查**。

`index.tsx:356` 是同类写法的第二处：

```tsx
// packages/react-native/__typetests__/index.tsx:356
const text = StyleSheet.compose(page.text, lists.listItem) as TextStyle;
```

紧邻的 `:348-352` 有正确的写法（`const container = StyleSheet.compose(...)` 不加断言，直接交给 `<View style={container} />` 检查），`compose` 与 `flatten` 却各有一处用 `as` 绕过。

**判定：缺陷（用断言代替测试）。** `as` 一旦出现，测试的对象就从「库的类型」变成了「我写的断言」。

---

## 17. 正面：27 处 `@ts-expect-error` 真正约束了什么

与 34 处无效的 `$ExpectType` 相对，`@ts-expect-error` 是 `tsc` 原生指令，**未命中错误时它自己会报错**（`Unused '@ts-expect-error' directive`）。所以这 27 处是**双向有效**的。

| 文件 | 处数 | 覆盖内容 |
| --- | --- | --- |
| `packages/react-native/__typetests__/globals.tsx` | **14** | timers 的参数类型（`setInterval` / `setTimeout` / `setImmediate` 各 3 处）、`requestAnimationFrame` 的回调参数与返回类型（3 处）、`requestIdleCallback` 的 options 与 `cancelIdleCallback` 参数（2 处） |
| `packages/react-native/__typetests__/index.tsx` | **11** | `ColorValue` 不可结构化构造（2 处）、不透明类型不可改（1 处）、`transform` 单键约束等 |
| `packages/react-native/__typetests__/animated.tsx` | **1** | `transform` 必须只含一个键值对 |
| `packages/react-native/__typetests__/stylesheet-create.tsx` | **1** | `StyleSheet.create` 的拼写错误字段 |
| **合计** | **27** | |

`globals.tsx` 的写法最完整 —— 正例与反例成对出现：

```tsx
// packages/react-native/__typetests__/globals.tsx:23-28
    handle = setInterval((arg1: number, arg2: string) => {
        console.log('arg1', arg1);
        console.log('arg2', arg2);
    // @ts-expect-error
    }, 0, 'wrong-type', '200');
    clearInterval(handle);
```

同一文件 `:36-40` 还有「少传一个参数」的反例。**这是全目录里类型断言质量最高的一段**，也说明作者知道正确的写法是什么 —— 34 处 `$ExpectType` 的存在因此更像是**工具没接上**，而不是不会写。

`ColorValue` 的不透明性也有成对用例（`index.tsx:1890-1919`）：

```tsx
// packages/react-native/__typetests__/index.tsx:1891-1899
const OpaqueTest1 = () => (
  <View
    // @ts-expect-error
    style={{
      backgroundColor: {
        resource_paths: ['?attr/colorControlNormal'],
      },
    }}
  />
);
```

---

## 18. 谁是真源：Flow → `types_generated` → `__typetests__`

三层关系：

```
packages/react-native/index.js（Flow 标注，真源）
        │  yarn build-types
        ▼
packages/react-native/types_generated/（gitignore，构建产物）
        │  exports["."].types
        ▼
packages/react-native/__typetests__/*.tsx（消费者）
```

外加一条平行的遗留通路：

```
packages/react-native/types_DEPRECATED/（手写，94 个 .d.ts）
        │  exports["."]["react-native-legacy-deep-imports"] + 三斜线引用
        ▼
同一个 __typetests__/*.tsx（legacy project）
```

两个后果：

1. **失败归因不可区分**。`__typetests__` 里一处类型不符，可能是 Flow 源写错、可能是 `build-types` 翻译错、也可能是测试写错。测试本身不提供区分手段。
2. **legacy 通路测的是「另一套类型」**。`types_DEPRECATED/` 有 94 个 `.d.ts`（含 6283 行级别的 `dom` 系列不在其中，那是 `flow/`），它与生成产物**不共享实现**。同一个测试文件在两套类型上都通过，并不推出「生成产物正确」。

---

## 19. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **TYP-1** | **【核心】34 条 `$ExpectType` 是纯注释，零工具解析** | `packages/react-native/__typetests__/index.tsx`（28 处）、`packages/react-native/__typetests__/animated.tsx`（6 处） | 全仓无 `tsd` / `dtslint` / `eslint-plugin-expect-type`；`tsc` 把 `// $ExpectType` 当普通注释；被断言的对象恰好是 `requireNativeComponent` 泛型、`Platform.select` 的 `default` 分支、`layout` 字段类型这些最容易改坏的契约 |
| **TYP-2** | **【核心】`strict: false` → nullability 断言恒真** | `packages/react-native/__typetests__/tsconfig.json:6` | 只开 `noImplicitAny` / `noImplicitThis`，`strictNullChecks` / `strictFunctionTypes` / `strictPropertyInitialization` / `useUnknownInCatchVariables` 全关；`onChange={null}`、`trackColor={{false: null}}`、`dataDetectorType={null}`、`destructiveButtonIndex: undefined` 等用例对任意类型都成立 |
| **TYP-3** | **【核心】`globals.tsx` 的全部全局名只有一个来源** | `packages/react-native/__typetests__/tsconfig.json:5`、`:9`；`packages/react-native/src/types/globals.d.ts`（726 行） | `lib: ["es2020"]` 不含 DOM、`types: []` 不加载 `@types` → `fetch`/`WebSocket`/`FormData`/`console` 只能来自 RN 自己的 `declare global`；两个 project 用同一份文件（legacy 侧靠 `types_DEPRECATED/index.d.ts:71` 的三斜线引用）→ 同一份 d.ts 被编译两次 |
| **TYP-4** | **【核心】96 个 runtime 导出里 36 个从未进入类型测试** | 分母 `packages/react-native/index.js`；分子 `packages/react-native/__typetests__/` 8 个文件 | 60 个被 import、**36 个零出现**（11 个 `unstable_*`/`experimental_*` + 25 个稳定 API）；稳定项目中含 `AppRegistry`、`PanResponder`、`PixelRatio`、`Easing`、`Vibration`、`Clipboard`、`EventEmitter`、`VirtualizedSectionList` 等 |
| **TYP-5** | `types_generated/` 被 gitignore 且不在树里，`test-generated-typescript` 必须先构建 | `.gitignore:178`；`packages/react-native/package.json:33`；`.github/workflows/test-all.yml:604-607` | 直接跑 `tsc -p __typetests__/tsconfig.json` 会解析不到 `react-native` 的类型入口；CI 的 `build_js_types` job 先 `build-types` 再测，而 `lint` job 里的 `test-typescript-legacy`（`:573`）不构建 —— 两个 job 检查两套类型源 |
| **TYP-6** | `types_DEPRECATED/` 被 manifest 描述为「已被 Flow 生成取代」，实际是 deep import 的唯一类型源 | `docs/arch/audit/module-manifest.json` 的 `baseline.excluded.paths`；`packages/react-native/package.json:37-38` | `exports["./Libraries/*"]["types"]` 显式为 **`null`**，只有 `react-native-legacy-deep-imports` 条件指向 `types_DEPRECATED/Libraries/*.d.ts` → 默认条件下 deep import **无类型**；该目录同时仍在 `files` 发布清单与 CI 独立 job 里 |
| **TYP-7** | 5 处 `@ts-ignore` 全压在 import 上，被压住的名字退化为 `any` | `packages/react-native/__typetests__/index.tsx:55`、`:69`、`:81`、`:104`、`:124` | `NativeModule` 处自带注释「Not actually exported, not sure why」；`RegisteredStyle` / `TextInputScrollEvent` / `SectionListData` 的后续用法全部无类型；且 `ImageResizeMode` 等在 `types_DEPRECATED` 里**存在**，说明该抑制是为跨 project 兜底，`@ts-expect-error` 更合适 |
| **TYP-8** | `legacy-properties.tsx` 被 `@ts-ignore` 完全架空 | `packages/react-native/__typetests__/legacy-properties.tsx:10-14` | 全文 5 行有效代码：import 被压住、class 体为空 → 删掉 `TextInputProperties` 别名这个文件仍然通过；该文件的唯一目的正是校验这个别名 |
| **TYP-9** | `animated.tsx` 主动跳过 `SectionListRenderItemInfo` 断言，理由已过期 | `packages/react-native/__typetests__/animated.tsx:220-227` | `info; // Should expect ...` 既不是有效语法也不是 `$ExpectType`；注释理由是「TS 3.5 / 4.0 推断不同」，当前 TS 已是 5.x，理由失效但跳过仍在 |
| **TYP-10** | `globals.tsx` 是 11 个文件里唯一缺 `@format` 的 | `packages/react-native/__typetests__/globals.tsx`（无 `@format`）；`.prettierrc.js:14` | `requirePragma: true` → Prettier 与 `format-check-javascript` 都跳过它；文本证据是该文件全篇 4 空格缩进（同目录其它文件 2 空格）与 `const noop = () => { };` |
| **TYP-11** | `flow/global.js` 的索引器打穿整份 `declare var global` | `packages/react-native/flow/global.js:86-88` | `[string | symbol]: any` 让未声明名字读出 `any`：拼错 `global.settimeout` 不报错、删掉一个声明也不报错；42 个 `readonly` 字段只对正确拼写的名字生效；对照同目录 `packages/react-native/flow/HermesInternalType.js:25-114` 的精确对象类型 |
| **TYP-12** | `__DEV__` 的抑制注释把「另一个来源」指错了类型系统 | `packages/react-native/flow/global.js:90-94` | 注释称避免与「another Flow libdef」重复，但全仓 Flow 侧只有这一处声明；实际另一处是 `packages/react-native/src/types/globals.d.ts:56` 的 TypeScript `declare global`，Flow 根本不读；注释自己已承认「a no-op in this checkout」 |
| **TYP-13** | `flow/*.js.flow`（5 个 / 7819 行）不在覆盖度口径内 | `docs/arch/audit/normalize-manifest.mjs` 的 `CODE` 集合；`packages/react-native/flow/` | `path.extname('dom.js.flow')` = `.flow` → 计入 0；该目录实际 8 个文件 8041 行，覆盖度只算 3 个 / 222 行；`dom.js.flow` 单文件 6283 行 |
| **TYP-14** | 两个 codegen 样本只有正例，`@ts-expect-error` 数为 0 | `packages/react-native/__typetests__/fabric-component-sample.ts`、`packages/react-native/__typetests__/turbo-module-sample.ts` | 能保证「这样写能编译」，不能保证「写错会报错」；统计「有断言的 API 数」时不应把它们计入 |
| **TYP-15** | 两处用压制/断言代替测试 | `packages/react-native/__typetests__/stylesheet-create.tsx:11`（`@ts-ignore` 盖住整条 import，连 `View`/`StyleSheet` 一起免疫）、`packages/react-native/__typetests__/stylesheet-flatten.tsx:19`（`as ViewStyle`）、`packages/react-native/__typetests__/index.tsx:356`（`as TextStyle`） | `stylesheet-flatten.tsx` 的唯一目的就是校验 `flatten` 的返回类型，而 `as ViewStyle` 把返回值断言掉了 |

---

## 20. 适用范围声明

| 维度 | TYP-1 / TYP-2 / TYP-5 / TYP-6 | TYP-3 / TYP-13 | TYP-4 | TYP-7 / TYP-8 / TYP-9 / TYP-15 | TYP-10 | TYP-11 / TYP-12 | TYP-14 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **平台** | 跨平台（纯 tsc 检查，不区分 iOS/Android） | 跨平台 | 跨平台 | 跨平台 | 跨平台 | 跨平台 | 跨平台 |
| **架构** | 与 Fabric/legacy 无关 | 与架构无关 | 与架构无关 | 与架构无关 | 与架构无关 | 与架构无关 | **与架构相关**：`fabric-component-sample.ts` 只覆盖 Fabric 组件 spec，legacy 的 `requireNativeComponent` 只在 `index.tsx:1542` 出现一次 |
| **触发条件** | 任何 `yarn test-generated-typescript` / `test-typescript-legacy` | 任何跑 `tsc -p __typetests__` 的场景 | 新增/修改公共 API 后没有同步补测试 | 对应文件被修改或被测导出被删除 | 任何 `yarn format-check-javascript` | 任何 `flow check` | 任何 `flow check` |
| **当前是否造成功能问题** | **否**（测试强度问题，不改变运行时） | **否** | **否**（漏测，不产生错误结论） | **否**（漏测） | **否** | **否**（类型检查被削弱） | **否** |
| **是否已实机验证** | **否 —— 未运行 `tsc`**（submodule 无 `node_modules`）。结论均来自配置文件与 `grep` 计数 | **是** —— `lib`/`types`/`COMPILER_OPTIONS` 逐行核对；`.js.flow` 的 `extname` 行为由 `node -e` 实测 | **是** —— `index.js` 的 96 个 getter 与 8 个测试文件的 import 全量比对（脚本计算，非抽样） | **是** —— 逐行核对 | **是** —— `@format` 逐个 `grep`；缩进差异肉眼可验 | **是** —— 全仓 `grep` 计数 | **是** —— 逐个文件 `grep -c` |

**口径提醒**：本文统计的「96 个 runtime 导出」只含 `packages/react-native/index.js` 的 `get X()` 访问器。JSX 组件、常量对象内部成员、以及 49 个纯类型导出不在分母内。

---

## 21. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| [78 文档](./78-构建期的静态检查与转译层.md) LNT-14：`lazy-imports.js` 与 `index.js` 脱节（36 缺失 / 10 死条目） | **本文 TYP-4 是同一形态的镜像** —— 那里是「运行时清单 vs 导出清单」，这里是「测试清单 vs 导出清单」；两处的数字都靠人工维护，都没有门禁 |
| [79 文档](./79-JS与Native边界的类型兼容性检查器.md) CMP-9：`$FlowFixMe` 注释断言一个常见分支不可达 | **本文 TYP-12 是同型第二例** —— 抑制本身也许无害，但旁边那句解释指错了对象；两处都是「注释比代码更容易骗人」 |
| [79 文档](./79-JS与Native边界的类型兼容性检查器.md) CMP-17：`AGENTS.md` 规则表声称的检查在代码里不存在 | **本文 TYP-6 同型** —— manifest 把 `types_DEPRECATED` 描述成已被取代，实际它是 deep import 的唯一类型源 |
| [77 文档](./77-测试工具层的静默失效与内部构建边界.md)：测试工具自己的静默失效 | **本文 TYP-8 是最彻底的一例** —— 不是「测试工具失效」，而是「被测对象是否存在都不再检查」；TYP-9 的过期跳过理由同属「测试自己把自己的约束关掉」 |
| [67 文档](./67-特性开关的四级继承链与未接CI的快照门禁.md) GGG-1：`@generated SignedSource` 全仓零校验 | **本文 TYP-1 是同一形态** —— 约定存在（`$ExpectType` 的语法）、人也照着写了 34 处，但**没有任何工具读它** |
| [49 文档](./49-构建工具链与静默失败.md) OO-1：ESLint 报错不会让 CI 失败 | **本文补一个更前置的问题** —— 即便 ESLint/CI 全绿，`__typetests__` 里 34 条核心契约也从未被求值 |
