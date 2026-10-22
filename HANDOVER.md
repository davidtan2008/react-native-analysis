# 交接文档 · React Native 源码解析知识库

> **读者**：接手本项目的开发者
> **基线**：`react-native @ 9b131e42`（git submodule `react-native/`，指向 `facebook/react-native`）
> **本文档落盘时间**：79 篇文档 / 992 文件已读（23.8%）

---

## 0. 一分钟摘要

| 项 | 值 |
| --- | --- |
| **项目目标** | 把 React Native 源码沉淀成**可检索、可复现、可验证**的知识库；每条结论带 `文件:行号`，每条断言可机器校验 |
| **已产出** | **79 篇**解析文档（45,506 行）+ **4 个**检索索引 + **5 张**交互式架构图 |
| **覆盖** | 4176 个非测试代码文件，已读 **992（23.8%）**，未读 **3017** |
| **结论** | **539 条**编号结论，分属 **8 主题域 / 37 子主题 / 17 类症状** |
| **校验** | **6 道门禁**（全绿）+ 2 个度量脚本；**1636 条**核心断言 |
| **引用** | 3291 条（2990 带行号 + 301 纯路径），全部有效 |
| **下一步** | 按 §5 的批次计划推进 P0 剩余的 92 个文件 |

---

## 1. 仓库结构与路径约定

```
react-native-analysis/              ← 本仓库（public，main 分支）
├── README.md                       ← 项目入口：布局、检索路径、门禁说明
├── AGENTS.md                       ← 在本仓库工作的约定（含路径约定与踩坑清单）
├── HANDOVER.md                     ← 本文
├── .gitmodules                     ← react-native → facebook/react-native
├── docs/arch/                      ← 知识库主体
│   ├── 01..79-*.md                 ← 79 篇源码解析文档
│   ├── INDEX/                      ← 4 个检索索引（脚本生成，禁止手改）
│   ├── audit/                      ← 6 道门禁 + 2 个度量脚本 + 模块清单
│   └── diagrams/                   ← 5 张交互式架构图
├── .archify/                       ← 架构图生成工作区
└── react-native/                   ← git submodule @ 9b131e42d12
```

### 1.1 路径约定（**最重要的一条**）

| 场景 | 路径基准 |
| --- | --- |
| **文档里写的源码路径** | 相对 **`react-native/` 子模块根** —— 例如 `packages/react-native/ReactCommon/react/renderer/core/ShadowNode.h:42` |
| **门禁脚本定位源码** | `REPO = <分析仓库根>/react-native` |
| **人在本地找源码** | `cd react-native && <上面那个相对路径>` |
| **文档之间的链接** | 相对 **`docs/arch/`** —— 例如 `./64-xxx.md` |

**每篇文档的 front-matter 都有 `sourceRoot: react-native` 字段声明这一点**，
并由 `check-index.mjs` 校验（改错会被门禁抓到）。

> **为什么不让文档直接写 `react-native/packages/...`**：
> 门禁的 `SEARCH_ROOTS` 是相对 RN 源码根枚举的（`packages` / `private` / `scripts` / `.github`），
> 文档路径保持 RN 根相对即可让 2549 条带行号引用**一条不改**就能继续工作；
> 路径基准的差异由 front-matter + 门禁 + 文档头三处显式声明。

### 1.2 submodule 升级是独立动作

commit 被**有意钉死**在 `9b131e42d12`：**文档里的行号断言是针对这个 commit 验证的**。
升级流程见 §7.3 —— 门禁会**精确报出哪些行号失效**，这是设计好的反馈回路。

---

## 2. 已完成的工作

### 2.1 主题覆盖（8 域 / 37 子主题）

| 域 | 内容 | 文档 |
| --- | --- | --- |
| `OV` | 架构总览与阅读地图 | 01, 02, 03, 06 |
| `RT` | 运行时与启动装配（JS 侧 / 错误桥 / legacy 桥 / 宿主集成） | 11, 13, 19, 25, 69, 71 |
| `RN` | 渲染器与布局（组件模型 / 注册表 / 视图 / 组件族 / 布局数值 / 调试字符串 / 性能观察） | 07–10, 31–37, 46, 53, 58, 60, 61, 70, 72, 74 |
| `DG` | 错误·崩溃·诊断上报（崩溃 / 监控 / 底层 / 路由 / 内存 / 性能 / LogBox） | 04, 05, 20, 22, 40–45, 55, 65, 66, 73 |
| `PL` | 平台层实现 | 15–18, 21, 23, 24, 26–30, 36–39, 47, 48, 50, 54, 59, 67 |
| `FD` | 公共基础层（TurboModule/codegen / Promise / 稳定 API / 二进制格式） | 14, 23, 52, 56, 62, 63, 64, 68, 74 |
| `AN` | 动画与交互 | 51, 57 |
| `TL` | 构建·测试·工具链 | 28, 49, 67, 68 |

### 2.2 重点主题（用户明确要求覆盖）

| 主题 | 文档 |
| --- | --- |
| **崩溃采集/处理/上报** | 04（总览）、41（Android）、20/22（iOS）、50（JNI）、65（底层解析器） |
| **OOM / 内存压力 / 内存泄漏** | 05（总览）、42（Android 回收池）、12（引用计数）、66（无界缓冲）、74（观察者缓存） |
| **白屏检测** | 05、44（Android 的 `CONTENT_APPEARED` 与 DevLoadingView「不可达」） |
| **启动速度** | 13、25、55、68（版本流水线）、71（bundle 加载） |
| **内容增长过快** | 66（`markBuffer_` 无界）、66（监控盲区）、74（双份存储） |
| **卡顿 / 掉帧** | 55（配对契约）、27（iOS 帧驱动） |
| **构建与门禁** | 49、67（未接 CI 的快照门禁）、68（版本流水线） |

### 2.3 值得一读的高价值发现（摘要）

| 文档 | 发现 | 类型 |
| --- | --- | --- |
| 64 | `NativeDOM.getTextContent` 是**无深度限制的递归**，JS 可直达 → **实测栈溢出阈值 1MB 栈 ≈ 13,750 层** | 崩溃向量 |
| 71 | Android 的 bundle 主加载路径把每个 bundle 声明为「**纯 ASCII**」，而 bundle 必然含非 ASCII 字节 | 契约违背 |
| 67 | `RN_EXPORT` 宏**有 10 个定义点**，只有 1 个处理 MSVC → Windows 上展开取决于 include 顺序 | 平台不对称 |
| 63 | `floatEquality(+inf, +inf)` 返回 **false**（实测） | 数值契约 |
| 65 | `RedBoxErrorParser` 的 `std::stoi` 越界**抛未捕获异常**，而 JS 侧 `parseInt` 静默出错 | 双实现漂移 |
| 66 | `getDroppedEntriesCount(MARK\|MEASURE)` **恒为 0** → 监控给出「一切正常」的假象 | 监控盲区 |
| 74 | 写方向的 `header_.count` 是 `uint16_t` **会回绕**，与读方向不校验构成同一问题两端 | 溢出 |
| 70 | `floatEquality` 的 NaN 特判是 NaN 哨兵设计的**必要配套**（跨文档闭环） | 跨文档印证 |

---

## 3. 方法论（**这是本项目最重要的资产**）

### 3.1 四步闭环（每个模块、每个批次都必须走完）

```
① 读（Read）  →  ② 写（Write）  →  ③ 审计（Audit）  →  ④ 回写（Update）
```

**① 读**
- 按**目录聚簇**读，不逐文件散读
- 优先读**入口 / 注册 / 生命周期**类，再读实现细节
- 每条关键结论记录 `文件:行号`
- **数字必须来自工具实测**，禁止手算

**② 写**
- 写入 `docs/arch/<NN>-<主题>.md`
- **必须写 front-matter**（`id`/`title`/`topic`/`symptoms`/`platforms`/`architecture`/`layer`/`symbols`/`claims`/`sourceRoot`）
- **必须写「适用范围声明」**（平台 / 架构 / 编译条件 / 触发条件 / 是否 dev-only / 是否已实机验证）
- 引用用**完整路径**（`packages/react-native/.../Foo.cpp:123`，路径基准 = submodule 根）
- 压缩过的代码块**必须在块内首行标注出处**

**③ 审计** —— 6 道门禁，退出码必须全为 0
**④ 回写** —— manifest（`status`/`readFiles`/`docs`/`note`）、README 数字、**重建索引**、更新本文的进度表

### 3.2 四类结论框架（**写之前先分类**）

| 类别 | 判据 | 例子 |
| --- | --- | --- |
| **历史承诺** | 注释描述的能力**实际不存在** | 69 文档：`ModuleRegistry` 头注释的「not implemented」列表描述了 6 个已删除的接口 |
| **自认边界** | 注释**主动承认**的已知失效 | 71 文档：`JSBigString` 注释说「move-only」而实现不可移动 |
| **结构脆弱** | 代码当前正确，但**改一行即引入 bug** | 65 文档：裸 `if` 宏的悬挂 else（当前 457 处引用零危险形态） |
| **有意的取舍** | 方向合理，**代价未文档化** | 62 文档：三档 Guard 默认全惰性（`RN_STRICT_API` 全仓未定义） |

> **这四类的分界线是「问题出在代码还是出在认知」**：
> 前两类改代码/改注释，后两类要么加防御、要么补文档。
> **混为一谈会导致「把设计当缺陷」**（如 66 文档 FFF-1 的无界缓冲其实有自愈机制）。

### 3.3 数字纪律（**本项目最容易翻车的地方**）

| 规则 | 反面教材（本项目真实发生） |
| --- | --- |
| **所有数字用工具实测** | 一次按 `grep -c` 推断「104 个 flag 全带 `dateAdded`」→ 实测只有 **76/104** |
| **`grepCount` 的 `exts` 必须带点号** | 传 `['h']` → 恒返回 **0 个文件**（`path.extname` 返回 `.h`） |
| **`grepCount` 计的是「含匹配的行数」** | 要真实出现次数得用 `content.match(re)?.length` |
| **全仓检索要排除 `docs/` 自身** | 检索 `RN_STRICT_API` 得 50 处，实为 **8 处**（其余是文档自己） |
| **表格里路径后紧跟裸数字会被当成「声明行数」** | 写成 `X.ext:123` 之外的形式（如 `X.ext` 的 `:123`） |
| **裸文件名触发 `AMBIGUOUS_BASENAME`** | 一律写全路径（仓库里 `Props.h` 有 3 个同名） |
| **代码块里的 shell 命令会触发 `NOT_IN_SOURCE`** | 门禁会拿最近的引用去核对 → 改用表格或加显式出处 |
| **JS 字符串里的 `\d` / `\\(` 转义** | 连续踩了 4 次；正则字面量比字符串可靠 |

### 3.4 检索纪律（**血的教训**）

> **「零命中」在下结论前，必须用另一条等价的检索方式复核。**

本项目真实发生的一次：

```bash
# 在子目录下执行，检索根却用了仓库根的绝对形式 → 静默返回空
cd .../Libraries/LogBox/Data
grep -rn "deleteStack" --include="*.js" packages/react-native/Libraries/
→ 无输出（路径不存在）        ← 假阴性！

# 在分析仓库根重跑（完全相同的检索根）
grep -rn "deleteStack" --include="*.js" packages/react-native/Libraries/
→ 4 处命中                    ← 真相
```

**这个假阴性沿推理链放大成了三条错误结论**（「缓存无法失效」→「失败被永久缓存」→「重试无效」），
**其中两条后来被写进了 73 文档**。教训已写入 73 文档 §5 与 `audit/README.md`。

> 同一条纪律也适用于**探查子代理的报告**：它们的 grep 常未排除 vendored 头文件
> （`jni.h`）与测试目录，也常给错路径 —— **所有数字与路径必须重新实测**。
> **本项目 4 次以上因未复核而写出错误结论。**

### 3.5 断言纪律

- **每篇文档至少 1 条 `[C*]` 源码侧断言 + 1 条 `[D*]` 文档侧断言**
- 断言**双向**：`[C*]` 查「源码是否符合文档所说」，`[D*]` 查「结论是否真被写进文档」
- **断言写法**：一律用 `includes()` 字符串匹配，**不用含反引号 / `/*` / 模板串的正则**
- 源码一变 → 断言自动 FAIL → **这是防文档腐化的唯一机制**

### 3.6 公平性纪律（**避免夸大**）

每条结论必须区分三档：

| 表述 | 含义 |
| --- | --- |
| **可验证的事实** | 本轮实测确认（如「`floatEquality(+inf,+inf)` 返回 false」） |
| **可验证的推论** | 由事实推出但未实测（如「Android 的崩溃阈值 ≈ 1.4 万层」） |
| **无法验证** | 依赖仓库外的代码（如 `jsi::Buffer` 契约、Hermes 行为）→ **必须显式声明边界** |

**范例**（71 文档 KKK-1）：把「`isAscii()` 恒返回 true」与「bundle 必然含非 ASCII」列为可验证事实，
把「`jsi::Buffer::isAscii()` 的契约」与「Hermes 的后果」列为**无法验证**，
**并明确写「本文不断言后果」**。

### 3.7 自我纠错纪律

**发现结论错了，改结论，不要绕过门禁。** 73 文档里我推翻了自己的一条推理链（§5）；
64 文档里因为实测纠正了「VirtualText 少一跳」的判断（那一条其实**不是** bug）。

---

## 4. 门禁体系

| # | 脚本 | 管什么 | 管不了什么 |
| --- | --- | --- | --- |
| 1 | `audit-citations.mjs` | 引用文件存在、行号在范围内、**表格声明行数与实际一致** | 结论对不对 |
| 2 | `verify-quotes.mjs` | 代码块内容确实来自所引位置 | 结论对不对 |
| 3 | `check-links.mjs` | 文档间链接与锚点有效 | — |
| 4 | `check-headings.mjs` | 子节编号与父节一致 | — |
| 5 | `verify-claims.mjs` | **核心事实断言与源码双向一致** | 未编码的断言 |
| 6 | `check-index.mjs` | front-matter 完整合法（含 `sourceRoot`）、`claims` 与问题表双向一致、生成物未漂移、症状词表无死词条 | 索引是否「有用」 |
| — | `coverage.mjs` | 覆盖度与未读缺口（度量） | — |
| — | `normalize-manifest.mjs` | 重算「已读 / 缺口」并回写 manifest | — |

**运行**（**必须从分析仓库根执行**；脚本已改为基于 `__dirname` 推导，cwd 无关）：

```bash
cd react-native-analysis
for f in audit-citations verify-quotes check-links check-headings verify-claims check-index; do
  node "docs/arch/audit/$f.mjs" >/dev/null 2>&1 && echo "✓ $f" || echo "✗ $f"
done
```

**改完文档 front-matter 后必须重建索引**，否则第 6 项会以 `INDEX_STALE` 失败：

```bash
node docs/arch/audit/build-index.mjs
```

### 4.1 新增门禁的强制要求

> **每新增一项门禁，必须先注入已知错误，确认它能抓到且退出码非 0。**

已有反证记录（`check-index.mjs` 6 项、`audit-citations.mjs` 2 项等），范例见 `audit/README.md`。

---

## 5. 剩余工作：完整计划

### 5.1 当前真实状态

```
计入范围的代码文件:              4176
manifest 声明覆盖:              4009  (96.0%)
已读并被文档引用:                992  (23.8%)
模块缺口:                       3017
未被任何模块声明:                167  (4.0%)  → audit/unclaimed.json
```

**恒等式校验**：`992 已读 + 3017 模块缺口 + 167 未声明 = 4176` ✅

### 5.2 模块现状（37 个模块）

| 模块 | 层级 | 已读/总数 | 缺口 | 文档 | 名称 |
| --- | --- | --- | --- | --- | --- |
| C2 | T3 | 120/466 | **346** | 16 | Android 平台实现 |
| D1 | T4 | 42/294 | **252** | 4 | 构建与发布工具链 |
| B1 | T2 | 41/233 | **192** | 4 | TurboModule 与代码生成 |
| A2 | T1 | 47/218 | **171** | 9 | Fabric 组件层 |
| C3 | T3 | 23/180 | **157** | 2 | Android JNI 胶水层 |
| B2 | T2 | 29/184 | **155** | 2 | 动画系统 |
| C1 | T3 | 218/372 | **154** | 19 | iOS 平台实现 |
| Z1 | T4 | 94/188 | **94** | 8 | 杂项包与零星文件 |
| A1 | T1 | 39/167 | **128** | 5 | 渲染器核心 |
| E7 | T3 | 11/143 | **132** | 1 | Android 根级 API |
| E5 | T2 | 4/118 | **114** | 1 | Yoga 布局引擎（vendored） |
| B4 | T2 | 8/110 | **102** | 2 | 图形与样式 |
| B9 | T2 | 36/128 | **92** | 2 | DevTools / CDP / Inspector |
| D2 | T4 | 1/98 | **97** | **0** | 测试基础设施（Fantom） |
| E8 | T3 | 15/103 | **88** | 2 | 零散 JS 库 |
| C5 | T3 | 5/92 | **87** | 2 | 通用视图组件 |
| E6 | T3 | 0/82 | **82** | **0** | ReactCxxPlatform |
| C6 | T3 | 10/83 | **73** | 1 | AppDelegate / 宿主集成 |
| D3 | T4 | 0/61 | **61** | 1 | CLI / 社区插件 |
| E11 | T4 | 0/52 | **52** | **0** | codegen e2e 夹具 |
| B7 | T2 | 12/57 | **45** | 2 | Web API 兼容层 |
| B6 | T2 | 0/44 | **44** | **0** | 网络层与 Blob |
| A3 | T1 | 22/64 | **42** | 3 | 运行时与 JS 引擎接口 |
| B3 | T2 | 2/44 | **42** | **0** | 文本布局与测量 |
| A5 | T1 | 32/73 | **41** | 3 | JS 启动装配 |
| A7 | T1 | 20/61 | **41** | 4 | 内存管理 |
| E4 | T2 | 0/38 | **38** | **0** | JS 私有层 |
| E9 | T3 | 0/32 | **32** | **0** | JS 引擎抽象与 C++ 胶水 |
| B5 | T2 | 8/27 | **19** | 2 | 图片管线 |
| E10 | T3 | 0/18 | **18** | **0** | iOS 剩余 |
| B10 | T2 | 6/16 | **10** | 1 | 事件系统 |
| B8 | T2 | 12/21 | **9** | 2 | 虚拟化列表 |
| E2 | T4 | 0/9 | **9** | **0** | C++ 通用工具库 |
| A6 | T1 | 46/52 | **6** | 7 | 事件循环与性能计时 |
| E1 | T2 | 35/36 | **1** | 4 | Renderer 基础设施 |
| A4 | T1 | 45/45 | **0** ✅ | 5 | 错误处理 |
| E3 | T1 | 0/0 | **0** | **0** | Feature Flags（C++ 侧）—— **manifest 声明异常，待核实** |

**零文档的模块（10 个）**：D2、E6、E11、B6、B3、E4、E9、E10、E2、E3 —— **优先补齐**。

### 5.3 批次计划（11 个批次，剩余 3017 文件）

**优先级来源**：使用者给定的清单（iOS → 启动装配 → 运行时 → 错误处理 → 内存管理 → CxxPlatform →
渲染器核心 → Fabric 组件层 → TurboModule → 其它 → 构建工具链 → Android → DevTools → JNI）。

**两条调整原则**：
- **P1 前置必须提前**：实现依赖某抽象的模块，该抽象必须先读完
- **P2 高价值前置可提前**：不是硬前置但唯一钥匙的模块允许提前

| 批次 | 主题（按使用者优先级编号） | 模块 | 缺口 | 前置 |
| --- | --- | --- | --- | --- |
| **P0** | 当前批次收尾（基础设施） | E1 / A4 / A6 / Z1 | **92** | 无 |
| **P1** | ① iOS 平台实现（含前置 ⑦ 渲染器核心） | A1 / C1 / E10 | **300** | A1 → C1 |
| **P2** | ⑧ Fabric 组件层（P1/P3 的共同前置） | A2 / C5 | **258** | A1 |
| **P3** | ⑫ Android 平台层 + ⑭ JNI 胶水层 | C2 / C3 / E7 | **635** | A2 + A3 |
| **P4** | ② 启动装配 + ③ 运行时 + ⑤ 内存管理 | A5 / A3 / A7 | **124** | A5 → A3 |
| **P5** | ⑨ TurboModule 与代码生成（三端产物的共同来源） | B1 / E11 | **244** | A3 |
| **P6** | ⑥ CxxPlatform + Yoga + 图形样式 + 文本布局 | E6 / E5 / B4 / B3 | **340** | A1 |
| **P7** | 动画系统 | B2 | **155** | A5 + A3 |
| **P8** | ⑬ DevTools 与调试 + ⑩ 其它子系统 | B9 / B7 / E8 | **225** | A3 |
| **P9** | ⑪ 构建与发布工具链 + 测试基础设施 + CLI | D1 / D2 / D3 | **410** | D1 |
| **P10** | 收尾：网络 / 虚拟化列表 / 事件系统 / JS 私有层 / 引擎胶水 / 工具库 / Flags / 图片 / 宿主集成 | B6 / B8 / B10 / E4 / E9 / E2 / E3 / B5 / C6 | **234** | — |
| **合计** | **11 个批次** | **37 个模块** | **3017** | — |

> **已应用的两处 P1 调整**（相对使用者原顺序）：
> ① **A1 渲染器核心提前到 P1**（原 ⑦）—— 它是 A2 / C1 / C2 / E5 / E6 / E7 的共同前置；
> ② **A2 Fabric 组件层提前到 P2**（原 ⑧）—— 它是 C1 / C2 的直接前置。
> **B1 TurboModule 保持在 P5**（原 ⑨），但排在平台层之前 —— 它的 codegen 产物是 iOS / Android / JNI 三端的共同输入。
>
> **P0 内部剩余**（按缺口）：
| 模块 | 剩余 | 备注 |
| --- | --- | --- |
| **Z1** | **94** | 杂项包（工具链周边 / 模板 / 测试库）—— P0 的主要工作量（已产出 75–78 四篇文档；余下为 `react-native-test-library` / `polyfills` / `compatibility-check` / `__typetests__` / `new-app-screen` / `flow` 等） |
| **A6** | 6 | 事件循环与性能计时 |
| **E1** | 1 | Renderer 基础设施 |
| **A4** | 0 | ✅ 已清零 |
| **D1** | 252 | **移到 P9**（构建与发布工具链）—— 缺口最大的单点，但按使用者优先级在 ⑪ |

### 5.3.1 下一步具体做什么（P0 收尾的五个动作）

| 顺序 | 做什么 | 规模 | 备注 |
| --- | --- | --- | --- |
| 1 | ~~**Z1 的 `packages/debugger-shell/`**（12）~~ | 一整块 | ✅ **已完成 —— 产出 75 文档**：入口分叉的两套判据 / 两处静默失败 / 与 `DevToolLauncher` 契约的三处背离 |
| 2 | ~~**Z1 的 `private/core-cli-utils/` + `packages/react-native/React/CxxBridge/`**（13）~~ | 一整块 | ✅ **已完成 —— 产出 76 文档**：四个实测缺陷 / `require.resolve` 的 `{cwd}` 选项 / 未声明依赖 / legacy 桥的 `isAscii` 平台对照 |
| 3 | ~~**Z1 的 `packages/react-native/ReactCommon/react/test_utils/`**（10）~~ | 一整块 | ✅ **已完成 —— 产出 77 文档**：静默失效的随机化 / 被 `reset` 撤销的 swizzle / 只在内部构建里编译的边界 |
| 4 | ~~**Z1 的测试库 / eslint 插件 / babel preset**（约 60）~~ | 批量 | ✅ **ESLint 三件套 + Babel 四件套已完成 —— 产出 78 文档**；余下 `test-library` / `polyfills` / `compatibility-check` / `__typetests__` / `new-app-screen` / `flow` 约 38 个 —— **下一个动作** |
| 5 | **A6 剩 7 + E1 剩 1** | 零头 | 收尾 |

> **做完 P0（159 文件）就进入 P1**（iOS 平台实现 300 文件）——
> **使用者优先级最高、且已有 19 篇文档铺垫**，是产出密度最高的一段。

### 5.4 零文档模块的补齐顺序（**建议**）

| 优先 | 模块 | 理由 |
| --- | --- | --- |
| 1 | **E6 ReactCxxPlatform**（82） | C++ 平台抽象，用户优先级第 6，且完全空白 |
| 2 | **D2 测试基础设施**（97） | **门禁本身** —— 理解它才能改进本项目的门禁 |
| 3 | **B3 文本布局与测量**（42） | 64 文档的 `+inf` 击穿链路的下游 |
| 4 | **E4 JS 私有层**（38） | devsupport / devmenu —— 与白屏、调试菜单直接相关 |
| 5 | **E11 codegen e2e 夹具**（52） | codegen 正确性的验证基线 |
| 6 | **B6 网络层与 Blob**（44） | 网络异常路径 |
| 7 | **E9 / E10 / E2 / E3**（32+18+9+0） | 收尾 |

---

## 6. 日常操作速查

### 6.1 写一篇新文档

```bash
cd react-native-analysis

# 1. 选下一个编号（当前最大 74）
# 2. 读源码：cd react-native/ && <相对路径>
# 3. 写文档：docs/arch/75-<主题>.md
#    · 先写 front-matter（照抄任意一篇的字段集）
#    · 「基线」行照抄：> **基线**：react-native @ `9b131e42`（submodule `react-native/`，本文路径基准 = 该 submodule 根）
# 4. 补断言：把新结论写进 docs/arch/audit/verify-claims.mjs
#    · [C*] 源码侧：查源码是否符合文档所说
#    · [D*] 文档侧：查结论是否真被写进文档
# 5. 重建索引：node docs/arch/audit/build-index.mjs
# 6. 跑门禁：六条全绿才算完
# 7. 回写：docs/arch/audit/module-manifest.json（status/readFiles/docs/note）+ docs/arch/README.md 的数字
```

### 6.2 断言的写法（照抄这个模式）

```javascript
// 在 verify-claims.mjs 的 { ... } 块里追加
add('C999', '【结论编号】一句话说明这条断言要保证什么',
  '期望值（给人看的）',
  '实际值（工具算出来的）',
  /* ok 条件：用 includes() 做字符串匹配 */);
```

**注意**：
- `ok` 条件里**只用 `includes()`**，不用正则
- 路径用**完整相对路径**（`packages/react-native/...`）
- 读文件用 `read('packages/react-native/...')`（`REPO` 已指向 submodule）
- 文档侧用 `addDocClaim('D999', '说明', /正则/, {min: 1})` —— `min` 计的是**文档份数**

### 6.3 常见失败与原因

| 门禁失败信息 | 原因 | 修法 |
| --- | --- | --- |
| `PATH_NOT_FOUND` | 引用路径写错 / 漏了 `packages/` 前缀 | 写完整路径（基准 = submodule 根） |
| `AMBIGUOUS_BASENAME` | 用了裸文件名 | 写全路径 |
| `LINE_OUT_OF_RANGE` | 行号超出文件 | 重新核对行号 |
| `MISMATCH`（表格行数） | 表格里声明的行数与实际不符 | 改数字或去掉数字列 |
| `NOT_IN_SOURCE` | 代码块内容与所引位置不符 | 逐字复制；压缩过就加「原文跨多行」标注 |
| `INDEX_STALE` | 改了 front-matter 但没重建索引 | 跑 `build-index.mjs` |
| `CLAIM_NOT_IN_TABLE` / `CLAIM_NOT_LISTED` | front-matter 的 `claims` 与文档问题表不一致 | 两者同步 |
| `BAD_SOURCE_ROOT` | `sourceRoot` 不是 `react-native` | 改回 `react-native` |
| 断言大面积失败 | **submodule 没初始化** | `git submodule update --init --recursive` |

### 6.4 `verify-claims.mjs` 里的两个易错点

- **`DOC_TEXT` 直接读 `DOCS`**（不走 `REPO`）—— 因为文档在分析仓库里、源码在 submodule 里
- **`REPO` 指向 `react-native/`** —— 所有 `read('packages/...')` 都相对它

---

## 7. 维护流程

### 7.1 日常

- 改完任何文档 → 跑六道门禁 → 全绿才提交
- 改完 front-matter → **先** `build-index.mjs` **再**跑门禁
- 数字（已读/缺口/断言数/引用数）**必须由脚本回写**，不要手改 README

### 7.2 状态回写

```bash
node docs/arch/audit/normalize-manifest.mjs   # 重算已读/缺口并回写 manifest
node docs/arch/audit/coverage.mjs            # 看覆盖度
```

**`status: done` 的严格含义**：该目录下**全部非测试文件**都已读过且已成文。
**不是「这个主题写过」** —— 上一轮曾出现「8 个 done 看起来很全，实则只读了 14.4%」的错觉。

### 7.3 升级 submodule（**独立动作**）

```bash
cd react-native
git fetch origin && git checkout <新的 commit>
cd ..
git add react-native && git commit -m "chore: bump RN to <sha>"

# 然后逐个跑门禁，把失效的行号修掉
for f in audit-citations verify-quotes check-links check-headings verify-claims check-index; do
  node "docs/arch/audit/$f.mjs" 2>&1 | tail -20
done
```

**门禁会精确报出哪些引用失效** —— 这是设计好的反馈回路，不是麻烦。
**建议每次只升一个小跨度**，否则失效行号会淹没。

---

## 8. 已知问题与待办

| # | 事项 | 状态 |
| --- | --- | --- |
| 1 | **E3 的 manifest 声明异常** —— `fileCount: 0`、0 篇文档，疑似指向不存在的路径 | **待核实**（P10 第一件事） |
| 2 | **167 个未声明文件** —— `audit/unclaimed.json` | 待确认「无需覆盖」还是「manifest 漏声明」（已归入 B9 的 `packages/debugger-frontend` 除外） |
| 3 | **manifest 里已不存在的目录（11 条）** —— `ReactAppDependencyProvider`、`react-native-gradle-plugin`、`react-native-assets`、`renderer/trace`、`src/private/console`、`Libraries/YellowBox`，及 E7 的 `performance`/`root`/`trace`/`appearance` | **已清理**：`inspection` 改指 `devsupport/inspector`，其余 10 条删除 |
| 4 | **5 个架构图的 provenance 里含本地绝对路径** | `docs/arch/diagrams/*.finalize.json` —— 是 archify 工具的执行记录，不影响正确性 |
| 5 | **5 张架构图与文档的联动** | 目前独立于索引体系，可考虑按主题域挂载到 `00-主题地图` |

---

## 9. 相关文件

| 文件 | 内容 |
| --- | --- |
| `README.md` | 项目入口：布局、检索路径、门禁、当前状态 |
| `AGENTS.md` | 在本仓库工作的约定（路径约定、踩坑清单） |
| `docs/arch/README.md` | 79 篇文档清单 + 每篇一句话摘要 + 覆盖度 |
| `docs/arch/INDEX/00-主题地图.md` | 按主题域 / 子主题浏览（**生成**） |
| `docs/arch/INDEX/01-症状排查手册.md` | 按现象排查（**生成**） |
| `docs/arch/INDEX/02-结论速查表.md` | 按结论编号直达（**生成**） |
| `docs/arch/INDEX/03-符号与源码入口.md` | 按符号 / 目录检索（**生成**） |
| `docs/arch/audit/README.md` | 门禁说明 + 撰写规范 + **踩坑清单** |
| `docs/arch/audit/READ-PLAN.md` | 批次计划与逐模块缺口对账表 |
| `docs/arch/audit/module-manifest.json` | 37 个模块的目录声明、已读数、产出文档 |
