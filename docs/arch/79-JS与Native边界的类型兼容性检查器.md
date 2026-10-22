---
id: 79
title: "JS/Native 边界的类型兼容性检查器：`changedParams` 死码、`indexers` 与数组元素对象的失明，以及四处「采集了但没人消费」的中间数据"
topic: TL.build
symptoms: [build, crash]
platforms: [cross]
architecture: [cross]
layer: T4
symbols: ["compareSchemas", "compareTypes", "compareTypeAnnotation", "assessComparisonResult", "buildSchemaDiff", "summarizeDiffSet", "formatDiffSet", "checksForTypesFlowingToNative", "checksForTypesFlowingFromNative", "convertPropToBasicTypes", "hasUpdatesTypes", "changedParams"]
sourceRoot: react-native
claims: [CMP-1, CMP-2, CMP-3, CMP-4, CMP-5, CMP-6, CMP-7, CMP-8, CMP-9, CMP-10, CMP-11, CMP-12, CMP-13, CMP-14, CMP-15, CMP-16, CMP-17, CMP-18, CMP-19, CMP-20, CMP-21]
---
# 79 · JS/Native 边界的类型兼容性检查器：`changedParams` 死码、`indexers` 与数组元素对象的失明，以及四处「采集了但没人消费」的中间数据

> **模块**：Z1 · `packages/react-native-compatibility-check/`（9 个源文件 / **4447** 行）
>
> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根）
> · **跨平台构建期工具**（纯 JS，不进入运行时，与 Fabric/legacy 均无关）
>
> **前置**：[76 文档](./76-CLI工具层的四个缺陷与legacy桥的契约偏差.md) 记录「注释承诺的行为不存在」；
> [77 文档](./77-测试工具层的静默失效与内部构建边界.md) 记录「测试工具自己的静默失效」；
> [78 文档](./78-构建期的静态检查与转译层.md) 记录「两份独立维护的清单各自与第三个真相源脱节」。
>
> 本文记录 **21** 条结论：
> ① **【核心】参数个数变化是唯一被无条件判死的变更**，而为此准备的错误码 `changedParams` **一次都没被用过**；
> ② **【核心】对象索引器 `indexers` 完全未参与比较** —— `{[a: string]: ?number}` 与 `{[a: string]: ?string}` 判为 `matching`；
> ③ **【核心】属性级 `?T` 变化被折叠成「可选性」** —— 实际是 nullable 变化，却报 `optionalProps`（"Property made optional"）；
> ④ **【核心】`madeStrict` 里采集的嵌套变更没有任何消费者** —— `madeOptional` 有递归、`madeStrict` 没有；
> ⑤ `Array<ObjA>` 与 `Array<ObjB>`、`Object` 与 `UnsafeObject` 都判为 `matching`，两处各有测试**自认**；
> ⑥ 删除模块/组件被当成 `ok`，代码里留着 `TODO`；
> ⑦ 三处「写了但到不了」：一段 `$FlowFixMe` 注释断言不可能进入的分支其实是常见路径、一个 `!= null` 恒真、一次 `concat[` 少一对括号；
> ⑧ `Int32Enum` prop 被降级成 `Any` —— 选项集合变化对整个工具不可见。

---

## 1. 文件构成

### 1.1 本轮读的 9 个文件（Z1 范围）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `packages/react-native-compatibility-check/src/TypeDiffing.js` | **1639** | 第一阶段：纯类型结构比较（`compareTypeAnnotation` 及其 20 余个子比较器） |
| `packages/react-native-compatibility-check/src/VersionDiffing.js` | **1515** | 第二阶段：按数据流方向判定安全性；构建 schema diff 与 summary |
| `packages/react-native-compatibility-check/src/ErrorFormatting.js` | **359** | 第三阶段：把深嵌套错误对象渲染成字符串 |
| `packages/react-native-compatibility-check/src/SortTypeAnnotations.js` | **293** | 联合类型/对象属性的规范化排序（让 `'a' \| 'b'` 等于 `'b' \| 'a'`） |
| `packages/react-native-compatibility-check/src/ComparisonResult.js` | **271** | 比较结果的类型定义（含 nullable 四象限注释） |
| `packages/react-native-compatibility-check/src/DiffResults.js` | **203** | diff 结果的类型定义、`ErrorCode` 全集、`DiffSummary` 三态 |
| `packages/react-native-compatibility-check/src/convertPropToBasicTypes.js` | **103** | 把 Component prop 类型降级成标准类型注解，便于与 Module 共用比较器 |
| `packages/react-native-compatibility-check/src/index.js` | **53** | 公开 API：`compareSchemas()` → `CompatCheckResult` |
| `packages/react-native-compatibility-check/src/index.flow.js` | **11** | 仅一行 re-export |
| **合计** | **4447** | |

### 1.2 证据文件（跨模块引用，不计入本轮已读）

| 文件 | 用途 |
| --- | --- |
| `packages/react-native-compatibility-check/AGENTS.md` | 官方的三阶段说明与「兼容规则表」，用作**文档与实现一致性**的对照物（CMP-17） |
| `packages/react-native-compatibility-check/src/__tests__/TypeDiffing-test.js` | 用例名本身构成证据（CMP-6 / CMP-7） |
| `packages/react-native-compatibility-check/src/__tests__/__fixtures__/native-module-type-diffing-types/NativeTypeDiffingTypes.js.flow` | `MapWithKey` / `MapWithKey2` / `UnsafeObjectType` 的声明（CMP-2 / CMP-7） |

### 1.3 三阶段管线（与代码一致的版本）

```
Schema(new) ─┐
             ├─► compareTypes ──► buildSchemaDiff ──► summarizeDiffSet ──► formatDiffSet
Schema(old) ─┘   (TypeDiffing)     (VersionDiffing)    (VersionDiffing)     (ErrorFormatting)
```

`packages/react-native-compatibility-check/src/TypeDiffing.js:68-94` 是第一阶段的总入口，
`packages/react-native-compatibility-check/src/VersionDiffing.js:1356-1515` 是第二阶段的全部输出面，
`packages/react-native-compatibility-check/src/index.js:31-45` 是三个公开方法的全部实现。

---

## 2. 【核心 CMP-1】参数个数变化：唯一被无条件判死的变更，而 `changedParams` 是死错误码

### 2.1 `ErrorCode` 有 14 个值，`changedParams` 只有声明

`packages/react-native-compatibility-check/src/DiffResults.js:17-31`：

```js
// packages/react-native-compatibility-check/src/DiffResults.js:17-31
export type ErrorCode =
  | 'addedProps'
  | 'removedProps'
  | 'changedParams'
  | 'incompatibleTypes'
  | 'requiredProps'
  | 'optionalProps'
  | 'nonNullableOfNull'
  | 'nullableOfNonNull'
  | 'removedMemberCases'
  | 'addedMemberCases'
  | 'removedIntersectCases'
  | 'addedIntersectCases'
  | 'removedModule'
  | 'removedComponent';
```

**实测（`grep -o "'changedParams'"`）：**

| 范围 | 出现次数 |
| --- | --- |
| `packages/react-native-compatibility-check/src/*.js` | **1**（就是上面这行声明） |
| `packages/react-native-compatibility-check/src/__tests__/` | **0** |
| `packages/react-native-compatibility-check/` 全目录 | **1** |

即：**没有任何生产者、没有任何消费者、没有任何测试引用**。

### 2.2 参数个数变化的真实路径是「硬错」

`packages/react-native-compatibility-check/src/TypeDiffing.js:1195-1199` 把参数列表当成**定长定序**数组比较：

```js
// packages/react-native-compatibility-check/src/TypeDiffing.js:1195-1199
  const argumentResults = compareArrayOfTypes(
    true, // fixedOrder
    true, // fixedLength
    newerType.params.map(_ => _.typeAnnotation),
    olderType.params.map(_ => _.typeAnnotation),
  );
```

`fixedLength: true` 时，长度不等立即返回 `length-mismatch`（`packages/react-native-compatibility-check/src/TypeDiffing.js:1269-1271`），
随后在 `packages/react-native-compatibility-check/src/TypeDiffing.js:1201-1209` 被包成 `error`：

```js
// packages/react-native-compatibility-check/src/TypeDiffing.js:1201-1209
  switch (argumentResults.status) {
    case 'length-mismatch':
      return makeError(
        typeAnnotationComparisonError(
          'Function types have differing length of arguments',
          newerType,
          olderType,
        ),
      );
```

`error` 状态在第二阶段被映射为 `incompatibleTypes`（`packages/react-native-compatibility-check/src/VersionDiffing.js:892-897`），**与方向无关**。

### 2.3 判定

- **`changedParams` 是死错误码**：`DiffResults.js:20` 声明之后，全包再无一次读写。
- **参数个数变化必然报错**，且是 `incompatibleTypes` 而不是 `changedParams`。
- 这条判定是**保守且偏严**的：给方法末尾**追加一个参数**（对 `toNative` 通常安全，原生侧会忽略多余实参）
  与**删除一个参数**（原生侧收到 `undefined`）被判成同一个错误码、同一句文案。

测试侧确认了这是**有意为之**：`packages/react-native-compatibility-check/src/__tests__/TypeDiffing-test.js` 里同时有
`it('errors on additional argument')` 与 `it('errors on argument removed')` 两个用例。

**判定：缺陷（死错误码）+ 有意的保守设计。** 死码本身无害，但它说明曾计划区分「参数个数变化」与「参数类型不兼容」，
后来退化成一条笼统的 `incompatibleTypes` —— 报错文案 `Function types have differing length of arguments`
是唯一的区分信号，而 `errorCode` 字段分不出来。

---

## 3. 【核心 CMP-2】`indexers` 完全未参与比较

### 3.1 对象比较只取 `properties`

`packages/react-native-compatibility-check/src/TypeDiffing.js:232-237`：

```js
// packages/react-native-compatibility-check/src/TypeDiffing.js:232-237
    case 'ObjectTypeAnnotation':
      invariant(olderAnnotation.type === 'ObjectTypeAnnotation', EQUALITY_MSG);
      return compareObjectTypes(
        newerAnnotation.properties,
        olderAnnotation.properties,
      );
```

`ObjectTypeAnnotation` 在 codegen schema 里除 `properties` 外还可能有 `indexers`、`callProperties`、`internalSlots`，
这里**只把 `properties` 传下去**，其余字段全部丢弃。

### 3.2 后果：索引器值类型变化 → `matching`

`{[a: string]: ?number}` 与 `{[a: string]: ?string}`：

- 两者的 `properties` 都是 `[]`；
- `compareObjectTypes` 在 `packages/react-native-compatibility-check/src/TypeDiffing.js:553-562` 走「old 为空」的分支，
  返回 `properties` + `addedProperties: []`；
- 回到 `packages/react-native-compatibility-check/src/TypeDiffing.js:565-567`，`isPropertyLogEmpty(result)` 为真 → **`{status: 'matching'}`**。

**实测：`indexers` 这个词在整个 `packages/react-native-compatibility-check/src/` 下出现 0 次**（含测试）。

### 3.3 fixture 里有现成的样本，但没有任何测试引用

`packages/react-native-compatibility-check/src/__tests__/__fixtures__/native-module-type-diffing-types/NativeTypeDiffingTypes.js.flow:140-141`：

`packages/react-native-compatibility-check/src/__tests__/__fixtures__/native-module-type-diffing-types/NativeTypeDiffingTypes.js.flow:140-141`
两行分别是 `type MapWithKey = {[a: string]: ?number};` 与 `type MapWithKey2 = {[a: string]: ?string};`。

`MapWithKey` / `MapWithKey2` 在 `packages/react-native-compatibility-check/src/__tests__/` 下**零引用**。
即：**为这条路径准备好的夹具从未被接上测试**，正好对应「实现缺失、测试也没写」的状态。

**判定：缺陷（覆盖缺口）。** 索引器是 `defaultProps` 之外少数能承载 `Record<string, T>` 语义的 schema 形态；
它的值类型变化对 `toNative` 与 `fromNative` 都可能是破坏性的，而工具对此完全沉默。

---

## 4. 【核心 CMP-3】属性级 `?T` 变化被折叠成「可选性」变化

### 4.1 nullable 比较本来有四象限

`packages/react-native-compatibility-check/src/ComparisonResult.js:124-137`：

```js
// packages/react-native-compatibility-check/src/ComparisonResult.js:124-137
export type NullableComparisonResult = {
  /* Four possible cases of change:
     void goes to T?   :: typeRefined !optionsReduced
     T?   goes to void :: typeRefined optionsReduced
     T    goes to T?   :: !typeRefined !optionsReduced
     T?   goes to T    :: !typeRefined optionsReduced
  */
  typeRefined: boolean,
  optionsReduced: boolean,
  // interiorLog not available if either type is void
  interiorLog: ?ComparisonResult,
  newType: ?CompleteTypeAnnotation,
  oldType: ?CompleteTypeAnnotation,
  ...
};
```

### 4.2 但在 `comparePropertyArrays` 里被改成 optionality

`packages/react-native-compatibility-check/src/TypeDiffing.js:471-477`：

```js
// packages/react-native-compatibility-check/src/TypeDiffing.js:471-477
      case 'nullableChange':
        return checkOptionalityChanges(
          newerName,
          !comparedTypes.nullableLog.optionsReduced,
          comparedTypes.nullableLog.optionsReduced,
          result,
        );
```

对照 `packages/react-native-compatibility-check/src/TypeDiffing.js:406-425` 的 `checkOptionalityChanges` 语义：
第三个/第二个实参分别是「新可选性」「旧可选性」，两者不等就写进 `madeOptional` 或 `madeStrict`。

于是 `{prop: string}` → `{prop: ?string}`（`optionsReduced === false`）被翻译成
**「新可选性 = true，旧可选性 = false」→ `madeOptional`**，
`nullableLog` 被**原地丢弃**（这里没有传 `furtherChange`）。

### 4.3 后果：错误码与文案错，但判定方向仍对

`toNative` 的检查链（`packages/react-native-compatibility-check/src/VersionDiffing.js:752-758`）里有
`checkForUnSafeMadeOptionalProperties`，它在 `packages/react-native-compatibility-check/src/VersionDiffing.js:392-413`
产出 `errorCode: 'optionalProps'` 与文案：

```js
// packages/react-native-compatibility-check/src/VersionDiffing.js:382-383
export const tooOptionalPropertiesMessage =
  'Property made optional, but native requires it';
```

四个象限逐一核对（**判定正确，标签错误**）：

| 变化 | 折叠后的状态 | `toNative` | `fromNative` | 实际语义 |
| --- | --- | --- | --- | --- |
| `T` → `?T` | `madeOptional` | ❌ `optionalProps` ✓ | 不报 ✓ | 「值域新增 null」——对 `toNative` 不安全，对 `fromNative` 安全 |
| `T?` → `T` | `madeStrict` | 不报 ✓ | ❌ `requiredProps` ✓ | 「值域去掉 null」——对 `fromNative` 不安全 |
| `void` → `T?` | `madeOptional` | ❌ `optionalProps` ✓ | 不报 ✓ | 同上 |
| `T?` → `void` | `madeStrict` | 不报 ✓ | ❌ `requiredProps` ✓ | 同上 |

所以：**安全性判定是对的，但 `nullableOfNonNull` / `nonNullableOfNull` 这两个专用错误码在属性级永远不会出现**，
用户看到的是「Property made optional」——而属性在 schema 里**并没有变成 `optional: true`**。

### 4.4 为什么测试没抓到

`packages/react-native-compatibility-check/src/__tests__/TypeDiffing-test.js:1293-1360` 的 `describe('compareTypes on nullables')`
全部通过 `nativeTypeDiffingTypesMethodParamLookup(...)` 取**方法参数**，走的是
`compareTypeAnnotation` 的直接递归（`packages/react-native-compatibility-check/src/TypeDiffing.js:224-230`），
那条路径**不经过** `comparePropertyArrays`，所以 `nullableChange` 能原样返回。

**属性级 nullable 变化在 `packages/react-native-compatibility-check/src/__tests__/` 下零覆盖。**

---

## 5. 【核心 CMP-4】`madeStrict.furtherChange` 是死数据

### 5.1 数据确实被采集了

`packages/react-native-compatibility-check/src/TypeDiffing.js:394-404`：

```js
// packages/react-native-compatibility-check/src/TypeDiffing.js:394-404
function updateMadeStrict(
  name: string,
  result: PropertiesComparisonResult,
  furtherChange?: ComparisonResult,
) {
  if (result.madeStrict) {
    result.madeStrict.push({property: name, furtherChange});
  } else {
    result.madeStrict = [{property: name, furtherChange}];
  }
}
```

`madeOptional` 对应的 `updateMadeOptional` 结构相同，也带 `furtherChange`。

### 5.2 但第二阶段只消费一半

`packages/react-native-compatibility-check/src/VersionDiffing.js:140-167` 是 `nestedPropertiesCheck` 里唯一处理
`furtherChange` 的地方，条件是 `result.propertyLog.madeOptional`：

```js
// packages/react-native-compatibility-check/src/VersionDiffing.js:140-167
      if (result.propertyLog.madeOptional) {
        const furtherNestedProps = result.propertyLog.madeOptional.filter(
          (property): property is {...} =>
            property.furtherChange != null &&
            (property.furtherChange.status === 'properties' ||
              property.furtherChange.status === 'functionChange' ||
              property.furtherChange.status === 'positionalTypeChange' ||
              property.furtherChange.status === 'nullableChange'),
        );
        const furtherErrors = furtherNestedProps.flatMap(property =>
          nestedPropertiesCheck(
            typeName,
            property.furtherChange,
            check,
            inverseCheck,
            property.furtherChange.errorLog ?? null,
          ),
        );
        finalResult = finalResult.concat(furtherErrors);
      }
```

**`grep -n "madeStrict" packages/react-native-compatibility-check/src/VersionDiffing.js` 只命中四处，全在
`checkForUnSafeMadeStrictProperties` 里（`:361`、`:362`、`:366`）—— 没有任何一处读 `furtherChange`。**

### 5.3 后果

属性 `optional: A` → `required: B`（`B` 相对 `A` 还有嵌套变化）时：

1. `madeStrict` 记录 `{property, furtherChange: <B vs A 的嵌套差异>}`；
2. `checkForUnSafeMadeStrictProperties` 只报「属性变必填」（`fromNative` 才报）；
3. **`furtherChange` 里的嵌套差异永远不被检查**。

因此对 **`toNative`** 而言，这种变化**一个错误都不报**：`madeStrict` 不在 `toNative` 的检查链里
（`packages/react-native-compatibility-check/src/VersionDiffing.js:752-758`），而嵌套差异又无人递归。

`packages/react-native-compatibility-check/src/__tests__/TypeDiffing-test.js:653` 有
`it('reports objects with properties made strict, and nested changes')` —— 它证明**第一阶段采集到了**；
`packages/react-native-compatibility-check/src/__tests__/VersionDiffing-test.js` 里没有对应用例。

**判定：缺陷（死数据 → 漏报）。** 与 CMP-3 同源：`PropertiesComparisonResult` 的两个字段被区别对待，
一个接了消费者、一个没接。

---

## 6. CMP-5 联合类型成员内部的变化被静默丢弃

`packages/react-native-compatibility-check/src/TypeDiffing.js:764-780`：

```js
// packages/react-native-compatibility-check/src/TypeDiffing.js:764-780
      case 'properties':
        restComparison.missingMembers = restComparison.missingMembers || [];
        restComparison.missingMembers.push(olderHead);
        restComparison.addedMembers = restComparison.addedMembers || [];
        restComparison.addedMembers.push(newerHead);
        return restComparison;
      //TODO: Handle the nullable changes within Union
      case 'nullableChange':
      case 'functionChange':
      case 'positionalTypeChange':
      case 'members':
        break;
      default:
        // Flow exhaustiveness check
        headComparison as empty;
        throw new Error('Unsupported status ' + headComparison.status);
```

两类处理都值得记录：

1. **结构化差异被记成「同时新增 + 删除」**（`:764-769`）：联合成员 `{|a: string|}` → `{|a: string, b: string|}`
   本应是 `properties` 变化（可按方向判安全性），却被拆成 `missingMembers` + `addedMembers`。
   对 `toNative` 而言「新增成员不安全」→ 仍然报错；对 `fromNative` 而言「删除成员不安全」→ **也报错**。
   **方向丢失**：原本单向安全的变更被压成双向都报。
2. **`nullableChange` / `functionChange` / `positionalTypeChange` / `members` 直接 `break`**（`:770-775`）：
   既不记错误、也不记变更。`//TODO: Handle the nullable changes within Union` 是代码自认。

**可验证的最小例子**：联合成员 `string` → `?string`，联合类型因此从
`'a' | 'b' | string` 变成 `'a' | 'b' | ?string`；两个数组排序后成员位置对应，`compareTypeAnnotation` 返回
`nullableChange`，然后被 `break` 吞掉 → **整体判为 `matching`**。

**判定：缺陷（漏报，且方向信息在联合内部丢失）。**

---

## 7. CMP-6 / CMP-7 两处「双向失明」，测试名自认

### 7.1 `Array<ObjA>` 与 `Array<ObjB>` 判为 `matching`

`packages/react-native-compatibility-check/src/__tests__/TypeDiffing-test.js` 的用例名本身就是结论：

```js
// packages/react-native-compatibility-check/src/__tests__/TypeDiffing-test.js
    it('does not error (but it should) on arrays of two different objects', () => {
      // This doesn't fail because we don't store object alias info in the schema
      // These are just arrays of mixed. Someday someone should fix this. NativeModules support this.
      // More info in https://github.com/facebook/react-native/pull/48476
```

根因在 schema 层：`Array<ObjA>` 与 `Array<ObjB>` 在 codegen 输出里都退化成 `Array<mixed>`，
**别名信息没有被保留**，所以比较器拿到的两个元素类型都是 `MixedTypeAnnotation`，
在 `packages/react-native-compatibility-check/src/TypeDiffing.js:176-187` 命中 `case 'MixedTypeAnnotation'` → `matching`。

> 注：该用例的注释把 PR 号写成 `48476`；摘要里提到的 `#48434` 是另一处。本文以源码注释为准。

### 7.2 `Object` 与 `UnsafeObject` 判为 `matching`

`packages/react-native-compatibility-check/src/__tests__/__fixtures__/native-module-type-diffing-types/NativeTypeDiffingTypes.js.flow:112-113`：

`packages/react-native-compatibility-check/src/__tests__/__fixtures__/native-module-type-diffing-types/NativeTypeDiffingTypes.js.flow:112-113`
两行分别是 `type GenericObjectType = Object;` 与 `type UnsafeObjectType = CodegenTypes.UnsafeObject;`。

两者在 schema 里都是 `GenericObjectTypeAnnotation`，比较器（`packages/react-native-compatibility-check/src/TypeDiffing.js:1025-1053`）
只比较 `dictionaryValueType`，两者都为 `null` → 立即 `matching`（`:1029-1034`）。
对应用例 `it('matches objects with unsafe objects')`。

`UnsafeObject` 的语义是「原生侧不做校验的对象」，把它与普通 `Object` 视为同一类型意味着
**把一个方法参数从 `Object` 改成 `UnsafeObject`（或反向）完全不产生告警**。

**判定：两处都是已知的能力边界**（前者 schema 层丢信息、后者 codegen 类型未区分），
但**测试名把它们固定下来了** —— 前者明确写「but it should」，后者写成「matches」，语气上把缺陷当契约。

---

## 8. CMP-8 删除模块/组件被当成 `ok`

`packages/react-native-compatibility-check/src/VersionDiffing.js:1437-1443`：

```js
// packages/react-native-compatibility-check/src/VersionDiffing.js:1437-1443
function summarizeSchemaDiff(diff: SchemaDiff): DiffSummary {
  switch (diff.status) {
    case 'new':
      return {status: 'patchable', incompatibilityReport: {}};
    case 'deprecated':
      // TODO add check that a component can be removed
      return {status: 'ok', incompatibilityReport: {}};
```

- **新增** 一个模块/组件 → `patchable`（不是 `ok`），语义是「旧版本没有它、需要打补丁」；
- **删除** 一个模块/组件 → `ok`，且带一句 `TODO`。

`deprecated` 由 `packages/react-native-compatibility-check/src/VersionDiffing.js:1411-1417` 两侧名字不一致时产生：

```js
// packages/react-native-compatibility-check/src/VersionDiffing.js:1411-1417
    if (!olderSchemaEntry) {
      diff.add({
        name: hasteModuleName,
        framework: framework,
        status: 'new',
      });
      return;
    }
```

反向（`olderSchemaEntry` 存在但 `newerSchema` 里没有）在 `:1406-1416` 处理，标成 `deprecated`。

**后果**：JS 侧删掉一个仍然被**旧 JS bundle** 调用的 NativeModule，兼容性检查给 `ok`。这正是这套工具
声称要防的 OTA 场景（`packages/react-native-compatibility-check/package.json` 的 `keywords` 里有 `crashes` 与 `native`）。

**判定：已知缺口（代码 TODO 自认）。** 之所以缺，很可能因为「删除」的破坏性取决于**旧 bundle 是否还在用**——
这在单次 schema 对比里不可判定；但工具既然把「新增」定成 `patchable`，对「删除」至少应给出同级警告，
而不是 `ok`。

---

## 9. CMP-9 / CMP-10 / CMP-16 格式化层的三处失真

### 9.1 一段 `$FlowFixMe` 注释与事实相反（CMP-9）

`packages/react-native-compatibility-check/src/ErrorFormatting.js:325-330`：

```js
// packages/react-native-compatibility-check/src/ErrorFormatting.js:325-330
export function formatDiffSet(summary: DiffSummary): FormattedDiffSummary {
  const summaryStatus = summary.status;
  if (summaryStatus === 'ok' || summaryStatus === 'patchable') {
    // $FlowFixMe[incompatible-type] I don't think we can ever get in this branch
    return summary;
  }
```

`formatDiffSet` 的**唯一**调用点是 `packages/react-native-compatibility-check/src/index.js:39-41`：

```js
// packages/react-native-compatibility-check/src/index.js:39-41
  getErrors(): FormattedDiffSummary {
    return formatDiffSet(this.getSummary());
  }
```

`getSummary()` 在**没有任何变更**时返回 `status: 'ok'`，在**新增了模块**时返回 `'patchable'` ——
两者都是**最常见**的结果。所以注释里的「I don't think we can ever get in this branch」是错的。

运行时无害（`DiffSummary` 与 `FormattedDiffSummary` 在 `ok`/`patchable` 时形状相同：`incompatibilityReport` 都是 `{}`），
但这条注释会误导后续维护者以为该分支是死代码。

### 9.2 一个恒真的 `!= null`（CMP-10）

`packages/react-native-compatibility-check/src/ErrorFormatting.js:316-322`：

```js
// packages/react-native-compatibility-check/src/ErrorFormatting.js:316-322
  if (specError.changeInformation?.incompatibleChanges != null) {
    return Array.from(specError.changeInformation.incompatibleChanges).map(
      errorStore => formatErrorStore(errorStore),
    );
  }
  // changeInformation does not contain incompatible changes
  return [];
```

`incompatibleChanges` 的类型是 `Set<ErrorStore>`（`packages/react-native-compatibility-check/src/DiffResults.js:72`），
**永远不是 `null`/`undefined`**；唯一构造点是 `packages/react-native-compatibility-check/src/VersionDiffing.js:1159-1164`，
四个字段都直接来自 `new Set()`。

因此 `:321-322` 的 `return []` **不可达**。当前无害（等价于 `Array.from(emptySet)`），
但注释「changeInformation does not contain incompatible changes」描述的是一种不存在的状态。

### 9.3 两套降级策略 + 一处缺右花括号（CMP-16）

同一个文件里，两个格式化器对「未知类型」的处理不同：

| 函数 | `default` 行为 | 位置 |
| --- | --- | --- |
| `formatErrorMessage` | `return ''`（**空字符串**） | `packages/react-native-compatibility-check/src/ErrorFormatting.js:93-95` |
| `formatTypeAnnotation` | `JSON.stringify(annotation)`（**原始 JSON**） | `packages/react-native-compatibility-check/src/ErrorFormatting.js:285-287` |

`formatErrorMessage` 返回空串意味着：**一个未知的错误类型会安静消失**（上层 `typeName + ': ' + ''`），
而 `formatTypeAnnotation` 至少留下可读的原始数据。

另外 `packages/react-native-compatibility-check/src/ErrorFormatting.js:279-284` 的字典对象格式化**少一个右花括号**：

```js
// packages/react-native-compatibility-check/src/ErrorFormatting.js:279-284
    case 'GenericObjectTypeAnnotation':
      if (annotation.dictionaryValueType) {
        return `{[string]: ${formatTypeAnnotation(annotation.dictionaryValueType)}`;
      }

      return 'Object';
```

输出形如 `{[string]: number`（缺 `}`）。仅影响错误文案，不进任何判定。

---

## 10. CMP-11 模块级类型注册表：无 `try/finally`，且提前返回会保留上一轮的注册表

`packages/react-native-compatibility-check/src/TypeDiffing.js:76-93`：

```js
// packages/react-native-compatibility-check/src/TypeDiffing.js:76-93
  if (!olderType) {
    // No matching olderType for newerType, skip the Comparison.
    return {status: 'skipped'};
  }

  _newerTypesReg = newerTypesReg;
  _olderTypesReg = olderTypesReg;
  _newerEnumMap = newerEnumMap;
  _olderEnumMap = olderEnumMap;

  const res = compareTypeAnnotation(newerType, olderType);

  _newerTypesReg = undefined;
  _olderTypesReg = undefined;
  _newerEnumMap = undefined;
  _olderEnumMap = undefined;

  return res;
```

模块级变量声明在 `packages/react-native-compatibility-check/src/TypeDiffing.js:62-66`，注释理由是「逻辑是串行的，用全局变量可接受」。

两个可验证的问题：

1. **没有 `try/finally`**。`compareTypeAnnotation` 在遇到未知类型时会
   `throw new Error(\`Unsupported type annotation: ...\`)`（`packages/react-native-compatibility-check/src/TypeDiffing.js:273-276`），
   此时四个变量**保持在本次调用的值**，不会被清空。
2. **提前返回保留上一轮的注册表**。`:76-79` 在赋值之前就 `return`，于是
   「上一次调用抛错 → 下一次调用因为 `olderType == null` 提前返回」这个序列之后，
   四个变量仍然是**上一次（抛错的那次）模块的**别名表。

由于 `compareTypes` 每次都会重新赋值，正常路径不受影响；但 `compareTypeAnnotation` 是 **export** 的
（`packages/react-native-compatibility-check/src/TypeDiffing.js:124`），任何直接调用它的代码都会读到**残留状态**。
具体表现：若被比较的类型是 `TypeAliasTypeAnnotation` 而注册表是 `undefined`，
`lookupType` 返回 `null` → 走到 `:153-157` 的 `invariant` → **抛错**而不是降级比较。

**判定：缺陷（隐藏状态 + 缺少清理）。** 正确写法是 `try { ... } finally { 清空 }`，
或者把注册表作为参数一路传下去（注释里承认那样「样板代码太多」）。

---

## 11. CMP-12 / CMP-13 两处「遗留笔误」

### 11.1 `hasUpdatesTypes` 是死导出，且与 `hasCodegenUpdatesTypes` 逐字相同

`packages/react-native-compatibility-check/src/VersionDiffing.js:1338-1354`：

```js
// packages/react-native-compatibility-check/src/VersionDiffing.js:1338-1354
export function hasUpdatesTypes(diff: DiffSet): boolean {
  return (
    diff.newTypes.size > 0 ||
    diff.deprecatedTypes.size > 0 ||
    diff.objectTypeChanges.size > 0 ||
    diff.incompatibleChanges.size > 0
  );
}

export function hasCodegenUpdatesTypes(diff: DiffSet): boolean {
  return (
    diff.newTypes.size > 0 ||
    diff.deprecatedTypes.size > 0 ||
    diff.objectTypeChanges.size > 0 ||
    diff.incompatibleChanges.size > 0
  );
}
```

**实测调用点**：`hasCodegenUpdatesTypes` 被调用 2 次（`:1165`、`:1311`）；**`hasUpdatesTypes` 被调用 0 次**。

两个名字暗示了不同的语义（「类型有更新」vs「codegen 需要重新生成」），实现却是同一个判据。
其中 `objectTypeChanges.size > 0` 尤其可疑 —— 属性变化被算作「codegen 需要更新」，
但该集合只用于 `getDebugInfo()` 输出（`packages/react-native-compatibility-check/src/index.js:43-45`），
**没有任何代码据此生成补丁**。

### 11.2 `nestedChanges.concat[` 少一对括号

`packages/react-native-compatibility-check/src/TypeDiffing.js:1431-1435`：

```js
// packages/react-native-compatibility-check/src/TypeDiffing.js:1431-1435
        // I'm not sure how I should fix this FlowFixMe. It returns `undefined`
        // and has existed since the day it was written. Fixing it might break things.
        // $FlowFixMe[method-unbinding] added when improving typing for this parameters
        nestedChanges.concat[[oldTypePosn, newTypePosn, currentResult]],
```

`nestedChanges.concat[...]` 是**对函数对象做属性访问**（键是被字符串化的数组），不是调用 `concat`。
结果恒为 `undefined`，被当作下一个递归调用的 `nestedChanges` 参数传下去。

它为什么没炸（**已核实的不可达性**）：

- `compareArrayTypesOutOfOrder` 只有一个调用点：`packages/react-native-compatibility-check/src/TypeDiffing.js:1320-1328`，
  由 `compareArrayOfTypes(fixedOrder=false, ...)` 传入；
- `fixedOrder=false` 只有一处：`packages/react-native-compatibility-check/src/TypeDiffing.js:1104-1109`，
  即 `compareStringLiteralUnionTypes`；
- 字符串字面量联合的成员只可能是 `StringLiteralTypeAnnotation`，`compareTypeAnnotation` 对其只会返回
  `matching` 或 `error`（`packages/react-native-compatibility-check/src/TypeDiffing.js:1055-1068`、`:1070-1083`），
  **永远进不到** `properties`/`functionChange`/`positionalTypeChange`/`nullableChange` 这个 `case` 组。

所以这是一处**被不可达路径保护着的语法错误**：一旦将来有别的类型走乱序比较，`nestedChanges` 会变成 `undefined`，
下游 `packages/react-native-compatibility-check/src/VersionDiffing.js:963-967` 的 `changes.flatMap(...)` 立即抛 `TypeError`。

---

## 12. CMP-14 未知类型：比较器抛错，排序器返回 -1

同一份 `CompleteTypeAnnotation` 联合类型被两个模块各自 switch 一遍，失败方式不同：

| 分发器 | `default` | 位置 |
| --- | --- | --- |
| `compareTypeAnnotation` | `throw new Error(...)` | `packages/react-native-compatibility-check/src/TypeDiffing.js:273-276` |
| `compareTypeAnnotationForSorting` | `return -1` | `packages/react-native-compatibility-check/src/SortTypeAnnotations.js:162-165` |
| `typeAnnotationArbitraryOrder` | `return -1` | `packages/react-native-compatibility-check/src/SortTypeAnnotations.js:289-292` |

`compareTypeAnnotationForSorting` 的 `default` 只会在 `typeA.type === typeB.type` 之后到达（`:29-45` 先按类型分派），
即**两侧都是同一个未知类型**。此时 `compare(A,B)` 与 `compare(B,A)` **都返回 -1**，
违反 `Array.prototype.sort` 的比较器约定（符号必须相反）。

现行代码里这个分支不可达：排序器覆盖 25 个 `case`，只比比较器多一个 `TypeAliasTypeAnnotation`
（`:156-159`，按 `typeA.name.localeCompare(...)` 排序，正确），而别名在比较器里已被提前解析。
但**新增一种 codegen 类型时**，两个分发器会给出两种行为：比较阶段直接崩，排序阶段悄悄把元素排到最前。

**判定：一致性缺陷（未知类型的失败方式不统一）。** 比较器「fail loud」是对的；
排序器的 `-1` 应该改成 `throw`。

---

## 13. CMP-15 数组元素索引：一处 1-based，一处 0-based

`packages/react-native-compatibility-check/src/SortTypeAnnotations.js:15-22`：

```js
// packages/react-native-compatibility-check/src/SortTypeAnnotations.js:15-22
export function sortTypeAnnotations(
  annotations: ReadonlyArray<CompleteTypeAnnotation>,
): Array<[number, CompleteTypeAnnotation]> {
  const sortableArray = annotations.map(
    (a, i): [number, CompleteTypeAnnotation] => [i, a],
  );
  return sortableArray.sort(compareTypeAnnotationForSorting);
}
```

位置是 `i`，**0-based**。乱序路径把这个位置原样放进 `addedElements` / `removedElements`
（`packages/react-native-compatibility-check/src/TypeDiffing.js:1519`、`:1510`）。

定长定序路径（方法参数）却用了 1-based：

```js
// packages/react-native-compatibility-check/src/TypeDiffing.js:1301-1311
    if (newerTypes.length < olderTypes.length) {
      const elements = olderTypes.slice(minLength, olderTypes.length);
      for (let i = 0; i < elements.length; i++) {
        removedElements.push([i + minLength + 1, elements[i]]);
      }
    }
    if (newerTypes.length > olderTypes.length) {
      const elements = newerTypes.slice(minLength, newerTypes.length);
      for (let i = 0; i < elements.length; i++) {
        addedElements.push([i + minLength + 1, elements[i]]);
      }
    }
```

而同一分支里的 `nestedChanges` 用的是 0-based 的 `i`（`packages/react-native-compatibility-check/src/TypeDiffing.js:1293`）。

这些索引最终出现在给人看的文案里：`packages/react-native-compatibility-check/src/ErrorFormatting.js:54-63` 打印
`'-- position ' + index`。**同一条错误消息里，参数下标可能是 0-based 也可能是 1-based**，取决于命中哪条路径。

**判定：缺陷（下标基准不一致，仅影响文案）。**

---

## 14. CMP-17 `AGENTS.md` 的兼容规则表与代码不一致

`packages/react-native-compatibility-check/AGENTS.md` 的「Data Flowing TO Native」表里写着：

| Change | Safe?（文档） | 代码实际 |
| --- | --- | --- |
| Add optional property | ✅ | 无检查 → 放行 ✓ |
| **Add required property** | **❌** | **无任何检查 → 放行** ✗ |
| Remove property | ✅ | 仅「删掉必填属性」报错（更精确） |
| Make property optional | ❌ | `checkForUnSafeMadeOptionalProperties` ✓ |
| Add union member | ❌ | `checkForUnsafeAddedMemberItems` ✓ |
| Remove union member | ✅ | 无检查 ✓ |
| Add enum member | ❌ | `checkForUnsafeAddedMemberItems` ✓ |
| Remove enum member | ✅ | 无检查 ✓ |

`toNative` 的检查链只有 5 项（`packages/react-native-compatibility-check/src/VersionDiffing.js:748-758`）：

```js
// packages/react-native-compatibility-check/src/VersionDiffing.js:748-758
// Deleting optional properties is safe and
// Making required properties optional is unsafe.
// Adding to unions and enums is unsafe, as is removing from intersections
// Changing nullable is similar to changing a union
const checksForTypesFlowingToNative: checkerType = chainPropertiesChecks([
  checkForUnsafeRemovedProperties,
  checkForUnSafeMadeOptionalProperties,
  checkForUnsafeAddedMemberItems,
  checkForUnsafeRemovedIntersectionItems,
  checkForUnsafeNullableToNativeChange,
]);
```

**没有 `checkForUnsafeAddedProperties`** —— 那个函数只出现在 `fromNative` 链里（`:763-769`）。

所以：**向 native 发送的对象「新增必填属性」不会被报错**。从实现角度看这大概率是**对的**
（原生侧多收到一个不认识的字段通常被忽略），错的是文档表格里的 ❌。
但两者必须有一致结论，而目前的组合会让人以为有检查、实际没有。

**判定：文档与实现不一致（实现合理、文档夸大了检查范围）。**

---

## 15. CMP-18 属性集被整体替换时退化成硬错

`packages/react-native-compatibility-check/src/TypeDiffing.js:578-593`：

```js
// packages/react-native-compatibility-check/src/TypeDiffing.js:578-593
  if (
    (result.addedProperties &&
      result.addedProperties.length > 0 &&
      result.addedProperties.length === newerPropertyTypes.length) ||
    (result.missingProperties &&
      result.missingProperties.length > 0 &&
      result.missingProperties.length === newerPropertyTypes.length)
  ) {
    return makeError(
      propertyComparisonError(
        'Object types do not match.',
```

判据是「**新对象的全部属性都是新增的**」或「**旧对象的全部属性都是缺失的**」—— 也就是两边的属性名**完全不相交**。

后果是判定不连续：

| 变化 | 结果 | 判定依据 |
| --- | --- | --- |
| `{a: string}` → `{a: string, b: string}` | `properties` + `addedProperties` | 走方向判定 → `toNative` **不报**（见 CMP-17） |
| `{x: string}` → `{y: string}` | **硬 `error`** | 方向无关 → 两个方向都报 |
| `{}` → `{b: string}` | `properties` + `addedProperties` | 走 `:553-562` 的空旧集分支 → `toNative` **不报** |

因此「把一个属性改名」和「加一个新属性」在 `toNative` 下得到相反的结论：前者必然报错（保守），后者完全不报。

**判定：保守设计的副作用，非缺陷。** 记在这里是因为它与 CMP-17 叠加后，`toNative` 的实际严格度分布很不均匀：
**属性改名很严、属性新增很松、索引器完全不管。**

---

## 16. CMP-19 正面：方向拆解正确，五处穷尽性守卫

### 16.1 方法/命令的方向拆解是对的

NativeModule 整体按 `fromNative` 评估（`packages/react-native-compatibility-check/src/VersionDiffing.js:1150-1157`）：

```js
// packages/react-native-compatibility-check/src/VersionDiffing.js:1150-1157
  localAssessComparison(
    nativeModuleName,
    newType,
    oldType,
    difference,
    // Since we are explicitly checking the native module, we know it is starting as fromNative
    'fromNative',
  );
```

这看起来别扭（「模块方法明明是 JS 调原生」），但 `compareFunctionTypesInContext`
（`packages/react-native-compatibility-check/src/VersionDiffing.js:703-746`）做了正确的拆分：

```js
// packages/react-native-compatibility-check/src/VersionDiffing.js:711-732
  if (functionLog.returnType) {
    result = result.concat(
      nestedPropertiesCheck(
        typeName,
        functionLog.returnType,
        check,
        inversecheck,
      ),
    );
  }
  if (
    functionLog.parameterTypes &&
    functionLog.parameterTypes.nestedChanges.length > 0
  ) {
    const parameterErrors = functionLog.parameterTypes.nestedChanges.flatMap(
      ([_oldPropertyNum, newPropertyNum, nestedResult]) => {
        const errors = nestedPropertiesCheck(
          typeName,
          nestedResult,
          inversecheck,
          check,
        );
```

**返回值用 `check`（= `fromNative`），参数用 `inversecheck`（= `toNative`）。**
于是 `fromNative` 这个外层方向被「反转」成参数侧的 `toNative`，语义正确。
组件 props 按 `toNative` 评估（`packages/react-native-compatibility-check/src/VersionDiffing.js:1297-1303`），
组件命令按 `fromNative` 评估（`:1242-1249`）—— 与各自的真实流向一致。

### 16.2 五处穷尽性守卫（fail loud）

| 位置 | 守卫 |
| --- | --- |
| `packages/react-native-compatibility-check/src/TypeDiffing.js:273-276` | 未知类型注解 → `throw` |
| `packages/react-native-compatibility-check/src/TypeDiffing.js:1488-1489` | 未知比较状态 → `throw` |
| `packages/react-native-compatibility-check/src/TypeDiffing.js:1635-1637` | 未知 `ReservedTypeAnnotation` 名 → `throw` |
| `packages/react-native-compatibility-check/src/VersionDiffing.js:1082-1084` | `assessComparisonResult` 的未知状态 → `throw` |
| `packages/react-native-compatibility-check/src/convertPropToBasicTypes.js:97-99` | 未知 prop 类型 → `throw` |

`packages/react-native-compatibility-check/src/VersionDiffing.js:1082-1084`：

```js
// packages/react-native-compatibility-check/src/VersionDiffing.js:1082-1084
      default:
        difference.status as empty;
        throw new Error('Unsupported status: ' + difference.status);
```

这五处加上 `ComparisonResult.js` 的封闭联合类型，构成一个**相当可靠的「新增类型时必然崩」**保护网
（`type as empty` 是 Flow 的穷尽性断言写法）。与 CMP-14 的排序器 `-1` 形成对照。

### 16.3 一处冗余但无害的实现

每个 `properties` 变化都会把 `nestedPropertiesCheck` **算两遍**，再按方向取一半
（`packages/react-native-compatibility-check/src/VersionDiffing.js:852-863`）。
`oldDirection` 为 `toNative` 时 `unsafeForFromNative` 被丢弃，反之亦然。
纯计算冗余，无副作用。

---

## 17. CMP-20 `combineSummaries` 的初值重复首元素，但三种状态均幂等

`packages/react-native-compatibility-check/src/VersionDiffing.js:1508-1514`：

```js
// packages/react-native-compatibility-check/src/VersionDiffing.js:1508-1514
export function summarizeDiffSet(diffs: Set<SchemaDiff>): DiffSummary {
  if (diffs.size === 0) {
    return {status: 'ok', incompatibilityReport: {}};
  }
  const summary: Array<DiffSummary> = [];
  diffs.forEach(schemaDiff => summary.push(summarizeSchemaDiff(schemaDiff)));
  return summary.reduce(combineSummaries, summary[0]);
}
```

`reduce(fn, initialValue)` 会从索引 0 开始迭代，所以**初值 `summary[0]` 会与自身合并一次**。
逐个状态验证（对照 `packages/react-native-compatibility-check/src/VersionDiffing.js:1479-1506` 的实际分支）：

| `setSummary.status`（= `finalSummary.status`） | 命中的分支 | 结果 |
| --- | --- | --- |
| `'ok'` | `case 'ok': return finalSummary`（`:1484-1485`） | 原样返回，幂等 |
| `'patchable'` | `case 'patchable'`；`finalSummary.status === 'ok'` 为假 → `else` 返回 `finalSummary`（`:1486-1491`） | 原样返回，幂等 |
| `'incompatible'` | 外层 `default` → 内层 `default`（`:1497-1503`）：把同一对象的每个键写回自己 | 同键同值，幂等 |

**判定：冗余但正确。** 记下来是为了区分「看起来像 off-by-one 的 reduce」与真正的缺陷 —— 这里不是缺陷。
顺带一提，`diffs.size === 0` 时在 `:1509-1511` 提前返回，因此 `summary[0]` 不会取到 `undefined`。

---

## 18. 与 codegen 的契约面：三处降级

`convertPropToBasicTypes` 是「Component props → 标准类型注解」的唯一适配层，
它的降级决定了哪些 prop 变化**根本进不了比较器**：

| prop schema 类型 | 转成 | 影响 |
| --- | --- | --- |
| `StringEnumTypeAnnotation` | `UnionTypeAnnotation`（字符串字面量联合） | ✓ 可比较 |
| `Int32EnumTypeAnnotation` | `AnyTypeAnnotation` | **选项集合变化不可见**（CMP 记在 §18.1） |
| `WithDefault` | 由 codegen 剥离，此处不出现 | ✓ 与 AGENTS.md gotcha #5 一致 |

### 18.1 `Int32Enum` → `Any` 的可见后果

`packages/react-native-compatibility-check/src/convertPropToBasicTypes.js:62-68`：

```js
// packages/react-native-compatibility-check/src/convertPropToBasicTypes.js:62-68
    case 'Int32EnumTypeAnnotation':
      // Compat check doesn't yet have support for
      // NumberLiteralUnionTypeAnnotation
      resultingType = {
        type: 'AnyTypeAnnotation',
      };
      break;
```

`Int32Enum` 只由 **Component** 解析器产生（`packages/react-native-codegen/src/parsers/flow/components/componentsUtils.js:374`、
`packages/react-native-codegen/src/parsers/typescript/components/componentsUtils.js:65`），
所以不会让 NativeModule 比较器撞上 `throw`（那是一条我核实过、**不成立**的猜测）。

但代价是：一个 prop 从 `Int32Enum([1,2])` 改成 `Int32Enum([1,2,3])`，
两次都被转成 `AnyTypeAnnotation` → `matching` → **选项变化完全不可见**。

AGENTS.md 把它列为 gotcha #6（「Currently converted to `AnyTypeAnnotation`」），是**已知且记录在案的能力边界**；
本文补上的是**后果**：这是 `toNative` 方向（组件 props）上唯一一个「整个类型维度被抹平」的地方。

---

## 19. 数据流：谁被采集、谁被消费

把三阶段的中间产物做一次「生产者 → 消费者」清点：

| 中间数据 | 生产者 | 消费者 | 结论 |
| --- | --- | --- | --- |
| `nullableLog` | `TypeDiffing.js:875-878` | `VersionDiffing.js:1025-1064`；**属性级被 `:471-477` 丢弃** | **属性级死数据**（CMP-3） |
| `madeOptional.furtherChange` | `TypeDiffing.js:371-384` | `VersionDiffing.js:140-167` | ✓ 已消费 |
| `madeStrict.furtherChange` | `TypeDiffing.js:394-404` | **无** | **死数据**（CMP-4） |
| `objectTypeChanges` | `VersionDiffing.js:885-890` | `getDebugInfo()`（`index.js:43-45`）+ `hasCodegenUpdatesTypes` | 只输出、不产生补丁；且 `hasUpdatesTypes` 整体无人调用（CMP-12） |
| `newTypes` / `deprecatedTypes` | `VersionDiffing.js:800-805`、`:1117-1148` | `hasCodegenUpdatesTypes` 判非空 | 只用于「有没有变化」的布尔判断，内容不外泄到 summary |
| `addedElements` / `removedElements` | `TypeDiffing.js:1299-1317`、`:1373-1397` | 交叉检查 `:546-609`；**参数路径未消费** | 参数个数变化不走这里（CMP-1） |
| `changedParams` | **无** | **无** | **完全死码**（CMP-1） |
| `hasUpdatesTypes` | `VersionDiffing.js:1338-1345` | **无** | **死导出**（CMP-12） |

`packages/react-native-compatibility-check/src/DiffResults.js:115-126` 对 `patchable` 的定义是：

```js
// packages/react-native-compatibility-check/src/DiffResults.js:115-123
export type DiffSummary = {
  /** status records how the diff compares against older versions
   * ok: there are no changes that impact older versions
   * patchable: there are additions (or modifications) that are not suported
   *            in older versions but is safe with an auto-generated patch
   * incompatible: there are modifications that are not safe for use with older
   *            versions and are not fixable with an auto-generated patchable
   */
  status: 'ok' | 'patchable' | 'incompatible',
```

**本包内没有任何生成补丁的代码**（`grep -ri "patch" packages/react-native-compatibility-check/src/` 只命中这段注释与
`patchable` 的枚举值）。`patchable` 目前只是「有新增、没有不兼容」的同义词。

---

## 20. 可验证边界：这套工具能保证什么

把 9 个文件读完后的整体判断：

**能保证（有代码路径 + 有测试）：**

- 原生暴露给 JS 的**返回值/常量**结构变化，按 `fromNative` 规则判定；
- JS 传给原生的**方法参数**结构变化，按 `toNative` 规则判定（参数个数变化一律报错）；
- 组件 props 的**非 `Int32Enum`** 结构变化，按 `toNative` 规则判定；
- 联合/枚举的成员增删在**顶层**（不在别的联合成员内部）能被方向正确判定；
- 未知类型注解、未知比较状态会让工具**崩溃而不是静默放行**（§16.2）。

**不能保证（本文逐条定位）：**

- 对象**索引器**的值类型变化（CMP-2）；
- **属性级** nullable 变化的错误分类（CMP-3，判定对、标签错）；
- `madeStrict` 属性下的**嵌套**变化对 `toNative` 的漏报（CMP-4）；
- **联合成员内部**的 nullable / 函数签名 / 位置变化（CMP-5）；
- `Array<ObjA>` vs `Array<ObjB>`（CMP-6）；
- `Object` vs `UnsafeObject`（CMP-7）；
- **删除**模块/组件（CMP-8）；
- `Int32Enum` 的选项集合变化（§18.1）；
- 任何「JS 侧无变化、原生侧变化」的兼容性 —— 工具比较的是**两份 JS schema**，
  原生实现是否与 schema 一致不在其视野内。

---

## 21. 已发现的问题

| 编号 | 问题 | 位置 | 影响 |
| --- | --- | --- | --- |
| **CMP-1** | **【核心】`changedParams` 是死错误码** —— 全包仅 `DiffResults.js:20` 一次声明；参数个数变化实际走 `length-mismatch` → `error` → `incompatibleTypes` | `packages/react-native-compatibility-check/src/DiffResults.js:17-31`；`packages/react-native-compatibility-check/src/TypeDiffing.js:1195-1209`；`packages/react-native-compatibility-check/src/VersionDiffing.js:892-897` | 错误码无法区分「参数个数变了」与「参数类型不兼容」；追加/删除参数被同一句话覆盖；判定本身**偏严但正确** |
| **CMP-2** | **【核心】`indexers` 完全未参与比较** | `packages/react-native-compatibility-check/src/TypeDiffing.js:232-237`；`packages/react-native-compatibility-check/src/TypeDiffing.js:553-567` | `{[a: string]: ?number}` → `{[a: string]: ?string}` 判为 `matching`；`indexers` 在全包出现 **0** 次；夹具 `NativeTypeDiffingTypes.js.flow:140-141` 的 `MapWithKey`/`MapWithKey2` **零测试引用** |
| **CMP-3** | **【核心】属性级 nullable 变化被折叠成可选性变化** | `packages/react-native-compatibility-check/src/TypeDiffing.js:471-477`、`:406-425`；`packages/react-native-compatibility-check/src/VersionDiffing.js:382-383`、`:394-413` | 报 `optionalProps`（"Property made optional"）而不是 `nullableOfNonNull`；四个象限的**方向判定全部正确**，错的只是错误码与文案；属性级 nullable 在测试里**零覆盖**（现有用例全走方法参数） |
| **CMP-4** | **【核心】`madeStrict.furtherChange` 是死数据** | 采集 `packages/react-native-compatibility-check/src/TypeDiffing.js:394-404`；只消费 `madeOptional`：`packages/react-native-compatibility-check/src/VersionDiffing.js:140-167` | `optional: A` → `required: B` 时嵌套差异**永不检查**；对 `toNative` 该情形**一个错误都不报**（`madeStrict` 不在 toNative 链里）；`TypeDiffing-test.js:653` 证明第一阶段采集到了，VersionDiffing 侧无用例 |
| **CMP-5** | **【核心】联合成员内部的变化被静默丢弃** | `packages/react-native-compatibility-check/src/TypeDiffing.js:764-780` | `nullableChange` / `functionChange` / `positionalTypeChange` / `members` 直接 `break`（代码 `//TODO` 自认）；`properties` 变化被记成「同时新增+删除」→ **方向信息丢失**，单向安全的变更被双向报错 |
| **CMP-6** | `Array<ObjA>` vs `Array<ObjB>` 判为 `matching` | `packages/react-native-compatibility-check/src/__tests__/TypeDiffing-test.js` 用例 `does not error (but it should) on arrays of two different objects`；机制见 `packages/react-native-compatibility-check/src/TypeDiffing.js:176-187` | schema 层不存对象别名信息 → 两者都是 `Array<mixed>`；**测试名自认「but it should」**，注释给出 PR 链接 |
| **CMP-7** | `Object` vs `CodegenTypes.UnsafeObject` 判为 `matching` | `packages/react-native-compatibility-check/src/TypeDiffing.js:1025-1053`；夹具 `native-module-type-diffing-types/NativeTypeDiffingTypes.js.flow:112-113`；用例 `matches objects with unsafe objects` | 两者都是 `GenericObjectTypeAnnotation` 且 `dictionaryValueType` 均为 `null` → `:1029-1034` 立即 `matching`；参数在 `Object` 与 `UnsafeObject` 之间切换**无告警** |
| **CMP-8** | 删除模块/组件被判为 `ok` | `packages/react-native-compatibility-check/src/VersionDiffing.js:1437-1443` | 代码自带 `// TODO add check that a component can be removed`；「新增」是 `patchable`、「删除」是 `ok`，二者不对称；正是 OTA 场景下最危险的方向 |
| **CMP-9** | `formatDiffSet` 的 `$FlowFixMe` 注释与事实相反 | `packages/react-native-compatibility-check/src/ErrorFormatting.js:325-330`；唯一调用点 `packages/react-native-compatibility-check/src/index.js:39-41` | 注释称「I don't think we can ever get in this branch」，但 `'ok'`（无变更）与 `'patchable'`（新增模块）都是常见路径；运行时无害，注释误导维护者 |
| **CMP-10** | `formatNativeSpecErrorStore` 的 fallback 不可达 | `packages/react-native-compatibility-check/src/ErrorFormatting.js:316-322`；类型见 `packages/react-native-compatibility-check/src/DiffResults.js:68-73` | `incompatibleChanges` 恒为 `Set`，`!= null` 恒真 → `:321-322` 的 `return []` 是死代码；注释描述了一个不存在的状态 |
| **CMP-11** | `compareTypes` 无 `try/finally`，提前返回保留上一轮注册表 | `packages/react-native-compatibility-check/src/TypeDiffing.js:62-66`、`:76-93` | 比较器抛错后四个模块级变量不清空；`:76-79` 提前返回更会保留**上一次模块**的别名表；`compareTypeAnnotation` 是 export，直接调用会读到残留状态并在别名场景 `invariant` 抛错 |
| **CMP-12** | `hasUpdatesTypes` 是死导出，且与 `hasCodegenUpdatesTypes` 逐字相同 | `packages/react-native-compatibility-check/src/VersionDiffing.js:1338-1354`；调用点仅 `:1165`、`:1311`（均为后者） | 两个名字暗示不同语义、实现完全相同；`hasUpdatesTypes` **0 次调用**；`objectTypeChanges` 被算作「codegen 需更新」，但**本包不生成任何补丁** |
| **CMP-13** | `nestedChanges.concat[[...]]` 少一对括号 | `packages/react-native-compatibility-check/src/TypeDiffing.js:1431-1435` | 实际是属性访问 → 恒为 `undefined`；注释自认「It returns `undefined` and has existed since the day it was written」；**当前不可达**（乱序路径只被字符串字面量联合使用），一旦可达下游 `flatMap` 立即 `TypeError` |
| **CMP-14** | 未知类型在比较器里 `throw`、在排序器里 `return -1` | `packages/react-native-compatibility-check/src/TypeDiffing.js:273-276`；`packages/react-native-compatibility-check/src/SortTypeAnnotations.js:162-165`、`:289-292` | 排序器的 `default` 会对 `(A,B)` 与 `(B,A)` **都返回 -1**，违反比较器约定；今日不可达（排序器多覆盖 `TypeAliasTypeAnnotation` 且别名已被提前解析），新增 codegen 类型时行为分叉 |
| **CMP-15** | 元素索引一处 1-based、一处 0-based | 0-based：`packages/react-native-compatibility-check/src/SortTypeAnnotations.js:15-22`、`packages/react-native-compatibility-check/src/TypeDiffing.js:1510`、`:1519`；1-based：`packages/react-native-compatibility-check/src/TypeDiffing.js:1301-1311`；展示：`packages/react-native-compatibility-check/src/ErrorFormatting.js:54-63` | 同一条错误文案里参数下标基准取决于命中路径；仅影响可读性 |
| **CMP-16** | 格式化层两套降级策略 + 字典对象少右花括号 | `packages/react-native-compatibility-check/src/ErrorFormatting.js:93-95`（返回 `''`）、`:285-287`（`JSON.stringify`）、`:279-284`（缺 `}`） | 未知错误类型会**安静消失**（`typeName + ': '`）；字典对象渲染成 `{[string]: number` |
| **CMP-17** | `AGENTS.md` 规则表声称 `toNative` 新增必填属性不安全，代码无此检查 | `packages/react-native-compatibility-check/AGENTS.md`（规则表）；`packages/react-native-compatibility-check/src/VersionDiffing.js:748-758` | `checkForUnsafeAddedProperties` 只出现在 `fromNative` 链（`:763-769`）；**实现大概率是对的**（多余字段被忽略），但文档夸大了检查范围 |
| **CMP-18** | 对象属性集**完全不相交**时退化成方向无关的硬错 | `packages/react-native-compatibility-check/src/TypeDiffing.js:578-593` | 「属性改名」两向都报、「新增属性」`toNative` 不报、「给空对象加属性」也不报 → `toNative` 的严格度分布不均匀；**保守设计，非缺陷** |
| **CMP-19** | ✓ **正面**：方向拆解正确 + 五处穷尽性 `throw` | `packages/react-native-compatibility-check/src/VersionDiffing.js:703-746`、`:1150-1157`、`:1297`、`:1242-1249`、`:1082-1084`；`packages/react-native-compatibility-check/src/TypeDiffing.js:273-276`、`:1488-1489`、`:1635-1637`；`packages/react-native-compatibility-check/src/convertPropToBasicTypes.js:97-99` | 返回值用 `fromNative`、参数用 `toNative`；`type as empty` + `throw` 构成「新增类型必然崩」的保护网；代价是每个 `properties` 变化被算两遍（`:852-863`，纯冗余） |
| **CMP-20** | `combineSummaries` 的初值重复首元素，但三种状态均幂等 | `packages/react-native-compatibility-check/src/VersionDiffing.js:1508-1514` | 看似 off-by-one，实测 `ok`/`patchable`/`incompatible` 三态**均不产生差异**；**不是缺陷** |
| **CMP-21** | `Int32Enum` 被降级成 `AnyTypeAnnotation` → 选项集合变化不可见 | `packages/react-native-compatibility-check/src/convertPropToBasicTypes.js:62-68`；产生点 `packages/react-native-codegen/src/parsers/flow/components/componentsUtils.js:374`、`packages/react-native-codegen/src/parsers/typescript/components/componentsUtils.js:65` | AGENTS.md gotcha #6 已记录；本文补后果：这是组件 props 上**唯一整个类型维度被抹平**的地方；同时确认它**只**由 Component 解析器产生，不会让 NativeModule 比较器撞上 `throw` |

---

## 22. 适用范围声明

| 维度 | CMP-1 / CMP-2 / CMP-3 / CMP-4 / CMP-5 | CMP-6 / CMP-7 / CMP-21 | CMP-8 | CMP-9 / CMP-10 / CMP-16 | CMP-11 / CMP-12 / CMP-13 / CMP-14 / CMP-15 | CMP-17 / CMP-18 | CMP-19 / CMP-20 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **平台** | 跨平台（纯 JS 工具） | 跨平台 | 跨平台 | 跨平台 | 跨平台 | 跨平台 | 跨平台 |
| **架构** | 与架构无关（比较的是 codegen schema） | 与架构无关 | 与架构无关 | 与架构无关 | 与架构无关 | 与架构无关 | 与架构无关 |
| **触发条件** | ① 方法参数个数变化；② 对象带索引器；③ 属性 nullable 变化；④ 属性 `optional→required` 且嵌套变化；⑤ 联合成员内部变化 | ① `Array<对象别名>`；② 参数在 `Object`/`UnsafeObject` 间切换；③ `Int32Enum` prop 选项变化 | 从 JS 侧删除一个仍被旧 bundle 使用的模块/组件 | ① 无变更或仅新增模块时调 `getErrors()`；② 任何 `changeInformation` 非空的不兼容项；③ 错误里含字典对象 | ① 比较器抛错后继续使用；② 统计「是否有更新」；③ 联合成员近似匹配；④ 新增 codegen 类型；⑤ 看参数下标文案 | ① 向 native 发送的对象新增必填属性；② 给空对象加属性 / 属性改名 | — |
| **当前是否造成功能问题** | **是**（CMP-2 / CMP-4 / CMP-5 是漏报，会让不兼容变更通过检查） | **是**（漏报，但均为已知边界） | **是**（删除被误判为安全） | **否**（仅注释/文案/死分支） | **否**（注释误导、死码、文案基准、潜在崩溃） | **否**（文档偏差；CMP-18 是保守设计） | **否**（正面样本 / 冗余实现） |
| **是否已实机验证** | **是** —— 逐行追踪 + `grep` 计数（`changedParams` 1/0、`indexers` 0）；**未运行** Jest（环境无 yarn 依赖） | **是** —— 用例名与夹具逐条核对；**未运行** Jest | **是** —— `summarizeSchemaDiff` 与 `buildSchemaDiff` 的三种 status 逐一对照 | **是** —— 类型定义与唯一构造点核对 | **是** —— 行号与调用点核对；CMP-13 的不可达性由调用图确认 | **是** —— 检查链成员逐项对照 | **是** —— 四象限与三状态逐一推演 |

---

## 23. 与既有文档的衔接

| 既有结论 | 本文的关系 |
| --- | --- |
| 76 文档 CLI-3 / 77 文档 TST-1：「注释承诺的行为不存在」 | **本文 CMP-9 是第四例，且更严重** —— 不是「承诺的功能没实现」，而是**注释断言一个常见分支不可达**；CMP-13 同型（注释承认返回 `undefined` 却不修） |
| 78 文档 LNT-14：`lazy-imports.js` 与 `index.js` 脱节（36 缺失 / 10 死条目） | **本文 CMP-12 是同一形态的小样本** —— 两个函数体逐字相同、名字不同、其中一个零调用；LNT-14 是清单脱节，CMP-12 是**实现重复** |
| 77 文档 TST-7：测试工具里的无深度限制递归 | **本文 CMP-11 是「模块级可变状态」的对照** —— `TypeDiffing.js` 用四个全局变量代替参数传递（`:62-66` 注释自认是权衡），代价是没有 `try/finally`；与 TST-7 的「递归没有上界」同属「为了方便省掉了结构约束」 |
| 73 文档 MMM-3：同一任务三份实现、三种策略 | **本文 CMP-14 / CMP-16 各是一例** —— 两个 switch 分发同一联合类型、两种失败方式；两个格式化器同一处境、两种降级策略 |
| 67 文档 GGG-1：`@generated SignedSource` 全仓零校验 | **对照 CMP-12** —— 那里是「约定存在但无门禁」，这里是「**函数存在但无调用**」；共同点是「机制在，接线没接上」 |
| 62 文档：三档 Guard 默认全惰性 | **对照 CMP-3 / CMP-4 / CMP-5** —— 那是「开关恒不生效」，这里是「**数据已采集、消费者缺失**」；CMP-3 更微妙：判定生效了，但**标签用的是另一个维度** |
| 49 文档 OO-1：ESLint 报错不会让 CI 失败 | **本文补一个前提** —— 即使把 compat check 接进 CI，CMP-2/4/5/6/7 这几类变更也**不会产生任何错误**；工具本身的漏报面比「CI 是否消费输出」更靠前 |
| 01 / 03 / 13 文档：JS 启动装配链路 | **无直接关系** —— 本文是构建期工具，不进入运行时；列此仅说明 `packages/react-native-compatibility-check` 与 `Libraries/` 运行时无依赖 |
