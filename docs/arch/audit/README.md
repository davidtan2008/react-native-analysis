# 文档事实审计工具

本目录下的脚本用于**保证 `docs/arch/*.md` 中的每一条源码断言都可复现**。
它们是本仓库文档的「事实校验层」：任何对文档的修改后都应重跑全部五项门禁。

## 0. 一键运行全部门禁

```bash
for f in audit-citations verify-quotes check-links check-headings verify-claims check-index; do
  node "docs/arch/audit/$f.mjs" >/dev/null 2>&1 \
    && echo "✓ $f" || echo "✗ $f"
done
```

**六项校验门禁 + 两项度量工具各管一件事，互不重叠：**

| # | 脚本 | 管什么 | 管不了什么 |
| --- | --- | --- | --- |
| 1 | `audit-citations.mjs` | 引用指向的文件存在、行号在范围内、**表格中声明的行数与实际一致** | 结论对不对 |
| 2 | `verify-quotes.mjs` | 代码块内容确实来自所引位置 | 结论对不对 |
| 3 | `check-links.mjs` | 文档间链接与锚点有效 | — |
| 4 | `check-headings.mjs` | 子节编号与父节一致 | — |
| 5 | `verify-claims.mjs` | **核心事实断言与源码一致（双向）** | 未编码的断言 |
| 6 | `check-index.mjs` | **索引体系**：front-matter 完整合法、`claims` 与问题表双向一致、生成物未漂移、症状词表无死词条 | 索引内容是否「有用」 |
| — | `coverage.mjs` | 覆盖度（度量，不判对错） | — |
| — | `normalize-manifest.mjs` | 重算「已读 / 缺口」并回写（度量，不判对错） | — |

> 第 5 项是唯一能验证「结论本身对不对」的门禁。
> 前四项全绿**不代表文档正确** —— 它们只保证「引用的东西存在且贴的代码没造假」。
> 第 6 项保证**检索体系不与文档脱节** —— front-matter 与索引是「症状排查手册」能成立的前提。

### 0.1 索引生成（不是门禁，但必须与门禁配套运行）

```bash
node docs/arch/audit/build-index.mjs   # 从 front-matter 重新生成 docs/arch/INDEX/*.md
```

`build-index.mjs` 是 `check-index.mjs` 的**前置**：改了任何文档的 front-matter，
必须先重新生成索引，否则第 6 项门禁会以 `INDEX_STALE` 失败。

## 1. `audit-citations.mjs` —— 引用可达性审计

抽取文档中所有 `文件:行号` / `文件:起始行-结束行` 形式的引用，逐条核验：

| 检查项 | 失败码 |
| --- | --- |
| 引用文件是否存在于仓库 | `FILE_NOT_FOUND` |
| **表格首列声明的文件行数是否与实际一致** | `LINE_COUNT_MISMATCH` |
| 同名文件在仓库中是否唯一（避免 `VirtualizedList.js` 这类重名歧义） | `AMBIGUOUS_BASENAME` |
| 行号是否落在文件实际行数范围内 | `LINE_OUT_OF_RANGE` / `END_LINE_OUT_OF_RANGE` |

此外还覆盖两类此前逃过审计的引用：

| 形式 | 例子 | 处理 |
| --- | --- | --- |
| **无行号的纯路径** | `` `ReactCommon/react/renderer/mounting/Differentiator.cpp` `` | 校验路径存在；带 `...` 的归为 `ELIDED` |
| **省略中间目录 + 行号** | `` `ReactAndroid/.../devsupport/DevSupportManagerBase.kt:248-254` `` | 按文件名反查真实路径后**照常校验行号** |

> 第二类尤其重要：省略写法会让行号断言完全逃过机器校验。
> 04 文档有 10 处这种写法，已用 `expand-elided-paths.mjs` 补成完整路径。

```bash
node docs/arch/audit/audit-citations.mjs
node docs/arch/audit/audit-citations.mjs --detail          # 打印每条引用命中的实际源码
node docs/arch/audit/audit-citations.mjs --json out.json   # 输出结构化结果
```

退出码 0 = 全部引用有效。

## 2. `verify-quotes.mjs` —— 代码块语义核验

只检查「行号存在」是不够的 —— 文档可能引用了正确文件但贴了错误的代码。
本脚本提取所有 fenced code block，为每块确定锚点（块前 25 行内的 `文件:行号` 引用，
或块内 `// 路径:行号` 注释），然后对块中每一行做两级核验：

1. **逐字匹配**：归一化空白后，该行是否原样出现在任一锚点文件的引用行 ±60 行窗口内
2. **记号级匹配**（容忍跨行合并、省略大括号、行尾注释）：
   抽出该行的标识符序列，检查是否都能在窗口内找到

结果分类：

| 分类 | 含义 | 是否问题 |
| --- | --- | --- |
| `PARAPHRASE_OK` | 记号级匹配通过（代码真实存在，但经过合并/缩写） | 否 |
| `NOT_IN_SOURCE` | 标识符无法在锚点窗口内找到 | **是，需人工核实** |
| `ANCHOR_UNRESOLVED` | 锚点文件定位不到 | **是** |

```bash
node docs/arch/audit/verify-quotes.mjs
node docs/arch/audit/verify-quotes.mjs --verbose    # 额外列出 PARAPHRASE 项
```

退出码 0 = 无 `NOT_IN_SOURCE` / `ANCHOR_UNRESOLVED`。

脚本会自动跳过**示意图代码块**（ASCII 目录树、箭头流程图、shell 会话记录），
这些不是源码引用，不参与核验。

## 3. `check-links.mjs` —— 文档间链接与锚点

前两个脚本都不管文档之间的交叉引用，而批量新增文档最容易破坏它们。
本脚本验证每个 markdown 相对链接的**目标文件存在**且**锚点在目标中真实存在**
（按 GitHub 规则计算 slug：转小写、去非字母数字、空格转连字符）。

```bash
node docs/arch/audit/check-links.mjs
```

退出码 0 = 无断链。围栏代码块内的内容会被排除，避免把示例路径当链接。

## 4. `check-headings.mjs` —— 章节编号连续性

检查 `###` 子节的第一个数字是否与所属 `##` 父节一致。
01 文档曾出现「`## 5. 功能总览` 下挂 `### 4.x` 子节」，肉眼容易漏，故机械化。

```bash
node docs/arch/audit/check-headings.mjs
```

## 5. `verify-claims.mjs` —— 核心事实断言双向校验

**这是唯一能验证「结论本身对不对」的门禁。**
前四项全绿仍可能整篇结论都是错的 —— 它们只保证「引用的东西存在、贴的代码没造假」。

把文档里最关键、最容易被误传的断言编码为可执行检查，**两个方向**：

| 方向 | 检查什么 | 覆盖的问题 |
| --- | --- | --- |
| `[C*]` 源码侧 | 源码的实际状态是否符合断言所声称的 | 源码演进导致文档腐化 |
| `[D*]` 文档侧 | 该结论是否真的被写进了文档 | 结论被漏写 / 写反 |

当前 116 条，覆盖：

| 断言 | 内容 |
| --- | --- |
| C1-C2 | `OnJsError` 全仓库仅 1 处创建，框架内无实现 → 崩溃上传由宿主注入 |
| C3-C4 | 无 POSIX `signal(SIG*)`、无 `NSSetUncaughtExceptionHandler` → 无原生崩溃捕获 |
| C5-C6 | `FrameRateLogger` 原生实现已删、JS 侧残留 |
| C7 | Android 原生侧**完全没有** `memoryWarning` 派发（不是空实现） |
| C9 | 无白屏检测实现（排除注释里 "blank screen" 这类预防措施字样） |
| C10 | iOS 仍存在 `RCTUIManagerUtils.m` → 不能说「全平台已移除 Shadow 队列」 |
| C11-C13 | `view/platform/ios` 不存在，iOS 复用 `cxx` |
| C14 | `LongLivedObjectCollection` 静态实例表永不清理 |
| C15-C17 | `initialized = true` 早于首个 `require`；`setRuntimeReady` 唯一调用点及其守卫 |
| C18-C19 | Android 旧架构开关返回 false 即抛异常；iOS 侧 `new_arch_enabled` 硬编码 `return true`、仅警告（**平台不对称**） |
| C20-C20c | `MemoryPressureRouter` 不派发 JS 事件、`onLowMemory` 空实现 |
| C21-C23 | `ReactMarkerConstants` **114 个枚举项 / 13 个带 true**（精确值）；`CREATE_REACT_CONTEXT_START` 未标记只有 `_END` 标记（半配对）；`_START` 配 `_STOP` 的非对称命名 |
| C24-C26 | **`UNSTABLE_ENABLE_MINIFY_LEGACY_ARCHITECTURE` 硬编码 `false`**，18 处引用 / 10 文件（精确值），legacy 断言机制从未启用 |
| C27-C29 | `UIViewOperationQueue` 空体 ≥15、`isEmpty()` 恒 true；`NativeViewHierarchyManager` 自述 stubbed out |
| C30-C31 | `BlackHoleEventDispatcher` 用 `FLog.d`；`ReactHostImpl` 未存活时回退黑洞 |
| C32-C35 | **`@ReactProp` 注释声称「属性被移除时给默认值」但实现只遍历存在的 key**；`defaultFloat` 默认 `0.0f`；`Float.NaN` 哨兵 9+ 文件 |
| C36 | 属性 setter 捕获 `Throwable` 后包装成 JS 异常并 rethrow |
| C37-C37d | `onJsError` 是 `noexcept`，但 **`OnJsError` 类型别名本身不带 noexcept**（实现方选择，非接口强制）；源码自述 `aborts the whole process`；`extraData` 两层 `catch(...)` 兜底 + `extraDataMarshallingError` 标记 |
| C40-C42 | Java 侧 `extraData` 可空且注释回指 C++；`MethodInvoker` 每个 JNI 调用后都检查异常；未知类型用 `LOG(FATAL)` |

```bash
node docs/arch/audit/verify-claims.mjs
```

退出码 0 = 全部成立。

**已知局限**（务必读脚本头注释）：

1. 文档侧只检查「结论在整个文档集中是否还存在」，不检查「每篇都写了」
2. 断言是硬编码的；新增重要结论需手工补一条
3. 源码侧 FAIL 时，先判断是「源码变了（改文档）」还是「断言写错了（改断言）」

### 5.1 写断言时的三个必踩坑（本工具自身的实测教训）

| 坑 | 现象 | 正确做法 |
| --- | --- | --- |
| **`grepCount` 的 `exts` 必须带点号** | 传 `['h','cpp']` 恒返回 **0 个文件**（`path.extname` 返回 `.h`） | 写 `['.h','.cpp','.mm','.m']` |
| **全仓检索会被 `docs/` 自身污染** | 用 `roots: ['.']` 检索某个符号，**本目录的文档因为提到了该符号而被计入** | 限定 `roots: ['packages','private','scripts']`；`docs/` 与 `.archify/` 永远排除 |
| **`grepCount` 计的是「含匹配的行数」** | 一个文件里出现 3 次只算 1 | 需要真实出现次数时改用 `content.match(re)?.length` |

**第 2 条已在本轮（62 文档）实际触发**：
检索 `RN_STRICT_API` 时全仓 50 处、检索 `add-cxxstableapi-guard` 时 12 处、
检索 `CMAKE_VERBOSE_MAKEFILE` 时 141 处 —— **其中大部分来自 `docs/arch/` 自身的文本**。
限定 `roots` 后分别回到 **8 / 1 / 137**（真实值）。

**这说明「全仓检索」类断言必须显式排除文档目录，否则断言会随文档增长而失效。**

## 5.1 `check-index.mjs` —— 索引体系门禁

**解决什么问题**：文档一多，读者就无法靠目录找到「我遇到的那个问题对应哪篇文档」。
本门禁保证 **front-matter（每篇文档的检索元数据）→ INDEX/（四个索引文件）** 这条链不脱节。

| # | 校验 | 失败时的错误码 |
| --- | --- | --- |
| 1 | front-matter 必填字段齐全（`id`/`title`/`topic`/`symptoms`/`platforms`/`architecture`/`layer`/`symbols`/`claims`） | `MISSING_FIELD` |
| 2 | 枚举值合法：`topic` 在主题树内、症状在词表内、平台 ∈ {cross,ios,android}、架构 ∈ {cross,fabric,legacy}、层级 ∈ T0–T4 | `BAD_TOPIC` / `BAD_SYMPTOM` / `BAD_PLATFORM` / `BAD_ARCH` / `BAD_LAYER` |
| 3 | 每篇文档至少有一个可检索维度（`symptoms` 或 `symbols` 非空） | `UNRETRIEVABLE` |
| 4 | `claims` 与文档「已发现的问题」表**双向一致** | `CLAIM_NOT_LISTED` / `CLAIM_NOT_IN_TABLE` |
| 5 | 4 个生成文件与**重新生成的结果逐字节一致** | `INDEX_STALE` |
| 6 | 症状词表**无死词条**（每个词至少被一篇文档覆盖） | `DEAD_SYMPTOM` |

### 反向验证（已实测 6 项，退出码均为 1）

| # | 注入的错误 | 实际捕获 |
| --- | --- | --- |
| 1 | 删掉 front-matter 的 `layer` 字段 | `MISSING_FIELD` + `BAD_LAYER` |
| 2 | `topic` 改成主题树里不存在的值 | `BAD_TOPIC` |
| 3 | front-matter 声明了文档问题表里没有的结论 | `CLAIM_NOT_IN_TABLE` |
| 4 | 手改生成文件（制造索引漂移） | `INDEX_STALE` |
| 5 | 症状词表加一个无人覆盖的词 | `DEAD_SYMPTOM` |
| 6 | 新增一篇**没有 front-matter** 的文档 | `NO_FRONTMATTER` + `BUILD_INDEX_FAILED` |

### front-matter 字段说明

| 字段 | 含义 | 取值 |
| --- | --- | --- |
| `id` | 文档序号（与文件名一致） | 1–63 |
| `title` | 标题（与正文首行一致） | 字符串 |
| `topic` | 主题域 + 子主题 | `OV.map` / `RT.js` / `RN.model` / `DG.crash` / `PL.ios` / `FD.api` / `AN.drive` / `TL.build` …（见 `INDEX/_taxonomy.json`） |
| `symptoms` | 覆盖的现象 | 见 `INDEX/_taxonomy.json` 的 `symptoms` 词表 |
| `platforms` | 适用平台 | `cross` / `ios` / `android` |
| `architecture` | 适用架构 | `cross` / `fabric` / `legacy` |
| `layer` | 重要度分层 | `T0`–`T4` |
| `symbols` | 关键类/函数 | 源码标识符 |
| `claims` | 编号结论清单 | 与正文问题表一一对应 |

**新增文档时**：写完正文 → 补 front-matter → 跑 `build-index.mjs` → 跑 `check-index.mjs`。

## 6. `expand-elided-paths.mjs` —— 补全省略路径

把 `` `ReactAndroid/.../x/y.kt` `` 补成完整路径，让其中的行号断言进入机器校验范围。
只替换能唯一定位的项，不确定的保持原样。

```bash
node docs/arch/audit/expand-elided-paths.mjs
```

## 7. `coverage.mjs` —— 覆盖度（目录级）

把 `module-manifest.json` 中每个模块的 `dirs` 展开为文件集合，
与仓库全部非测试代码文件求交集，输出**真实覆盖率**与未读清单：

```bash
node docs/arch/audit/coverage.mjs            # 汇总 + 各模块「声明/已读/缺口」
node docs/arch/audit/coverage.mjs --gaps     # 追加推进队列（按未读缺口降序）
node docs/arch/audit/coverage.mjs --detail   # 追加每模块实际命中文件
```

未声明的文件会写入 `audit/unclaimed.json`，可随时复查是否存在隐藏缺口。

## 8. `dirs.mjs` —— 目录清单

枚举仓库所有非测试代码目录及文件数，是划分模块的事实依据：

```bash
node docs/arch/audit/dirs.mjs --depth 4 --min 10
```

## 9. `READ-PLAN.md` —— 全量通读计划

把 38 个模块按依赖与阅读收益排成 **14 个批次**，每批次走「读 → 写 → 审计 → 回写」闭环。
详见 [`READ-PLAN.md`](./READ-PLAN.md)。

当前进度：**已读 301 / 4176（7.2%）**，批次 1（渲染器核心）进行中。

---

## 覆盖范围的真实边界

### `status: done` 的含义

**`done` = 该目录下全部非测试文件都已读过且已成文**（不是「这个主题写过」）。

`readFiles` 与该模块命中文件数的差值，就是剩余缺口，可由 `coverage.mjs` 直接读出。

### 未被任何模块声明的文件

`audit/unclaimed.json` 记录了未归入任何模块的零散文件（当前 176 个，4.2%），
主要是类型声明、`Package.swift`、单文件小包。已显式落盘而非隐式忽略。

---

## 与「Shadow 线程」教训的关系

2026-09 的一次人工复核发现：文档中「Shadow 线程（Android 专有）」一条**从未经过任何命令验证**，
是凭先验知识写入的，且把「仅 Android 不存在」错误地表述成了「全平台已不存在」
（iOS 实际保留 `RCTUIManagerUtils.m:14-33` 的 `com.facebook.react.ShadowQueue`）。

**教训**：结论必须注明其**适用范围（平台 / 架构 / 编译条件）**，
不能把某一平台/条件下的观察推广为全局结论。新增断言时优先用本目录脚本核验。
## 本次复核（批次 4）发现的问题类型

复核 15-18 四篇文档时，门禁全绿的情况下仍发现 **7 类真实错误**。它们的共同点是
**都不在原有门禁的覆盖范围内**：

| 类型 | 实例 | 为何原门禁漏掉 | 现在如何防住 |
| --- | --- | --- | --- |
| **计数错误** | `UIViewOperationQueue` 写 24 个方法（实 23）；`ReactMarkerConstants` 写 98/11（实 114/13）；`@ReactProp` 写 18（实 15） | 「行号存在」与「代码块语义」都不校验数字 | 新增 `LINE_COUNT_MISMATCH`；C21/C22/C35b 改为**精确值断言** |
| **正则子串污染** | `@ReactProp` 统计把 `@ReactPropGroup` 算进去 | 同上 | C35b 用 `@ReactProp\b(?!Group)` 精确排除 |
| **断言过宽** | C21「90+」、C22「≥10」让错误数字通过 | 断言自己写成了「约等于」 | 全部改为精确值 |
| **工具缺陷** | `grepCount` 用 `t.match(re)` 无 `g` 标志，同文件多次命中只算 1 次 | 工具返回的数就是错的，断言自然「通过」 | 已改为按行计数，与 `grep -c` 语义一致 |
| **行数基准不一** | 表格行数用 `split('\n').length`（多算末尾空行），读者用 `wc -l` | 无任何检查 | `LINE_COUNT_MISMATCH` 以 `wc -l` 语义为准 |
| **门禁未生效** | 新增的行数检查报出问题但**退出码仍是 0** | 只加了报告没加 `exitCode` | 反向验证：注入错误行数必须退出码 1 |
| **结论过度概括** | 写「RN 强制 onJsError noexcept」，实际是 Android 实现方自己加的 | 代码块语义校验不判断「谁的责任」 | C37c/C37d 断言接口别名无 noexcept |

**教训**：
1. **数字类断言必须用精确值**。「约 98 个」既抓不到错误，也提供了错误的安全感。
2. **新增门禁必须反向验证**（注入已知错误，确认能抓到且退出码非 0）。
   本次有一个门禁「报出了问题但退出码为 0」——看起来在工作，实际是坏的。
3. **「实现选择」与「框架强制」必须区分**。同一条结论写错主语，
   会让读者以为这是不可协商的约束。

## 本次复核（批次 1-3）发现的问题类型

复核 09-14 六篇时，门禁全绿的情况下仍发现 **5 处真实错误 + 1 处结论错误**：

| 类型 | 实例 | 为何原门禁漏掉 |
| --- | --- | --- |
| **计数错误** | `formsStackingContext` 写 18 项（实 **22**）；`view/platform` 写「12 个，各 4 个」（实 **15**：android 6 / cxx 4 / tvos 5）；`cxx` 引用写 7 处（实 **21**）；bridging 写 24 个 `.h`（实 **19**）；「20 个同步 require」（实 **13 无条件 / 23 总计**） | 「行号存在」与「代码块语义」都不校验数字 |
| **结论错误** | 「`platform/tvos` 与 `cxx` **逐字节相同**」——实际 tvos 多一个 38 行的 `HostPlatformViewProps.cpp`（真实实现） | 无检查能发现「两个文件是否真的相同」 |
| **统计口径不一致** | 同一份引用数，我用 `grep` 得 21，工具得 35 | `grepCount` **未排除 `__tests__`/`__snapshots__`**（已修） |
| **脚本自身误导** | 我用 `split('||').length` 得 22，却写成 21 | 手算与工具口径不一致，无交叉验证 |

**结论被推翻后，正确的部分要保留**：`tvos` **仍是死代码**（0 引用、行为与 cxx 无差异），
只是「死代码的理由」从「逐字节副本」变成了「无人引用 + 无行为差异」。
**修正错误不等于推翻结论** —— 要分别核实。

## 撰写规范（由审计总结）

要通过全部门禁，遵守：

1. **锚点用完整路径** —— `packages/react-native/.../Foo.cpp:123`，
   **路径基准是 `react-native/` 子模块根**（不是分析仓库根）——
   门禁脚本据此定位源码；人在 `react-native/` 子模块里按同一相对路径即可找到文件。
   不要用裸文件名（仓库中存在同名文件，如 3 个 `Props.h`）
2. **压缩过的代码块要在块内首行标注出处**：

   ```cpp
   // packages/react-native/ReactCommon/react/renderer/scheduler/SurfaceHandler.cpp:37-62
   void SurfaceHandler::start() const noexcept {
     // 跨行合并后的语句...
   }
   ```

3. **不要把多行合并成一行**却不标注 —— 逐字匹配会失败（虽会被记号级兜底，
   但记号级无法验证语句顺序）
4. **不要用 `ReactAndroid/.../` 这种省略写法** —— 会让行号逃过校验，
   且无法机器确认中间目录
5. **结论必须注明适用范围**（平台 / 架构 / 编译条件）——
   参见 C10：不能说「全平台已移除 Shadow 队列」

## 当前状态

```
引用总数:  2813   有效 2813   无效 0      （2549 条带行号 + 264 条纯路径）
代码块:    1028   校验行 6963   可疑 0
文档间链接: 513   断链 0
核心断言:  1501   通过 1501   失败 0
索引体系:  74 篇文档 / 8 个主题域 / 37 个子主题 / 17 类症状 / 441 条结论登记，问题 0
```

