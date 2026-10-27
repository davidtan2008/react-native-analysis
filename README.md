# react-native-analysis

> 基于 React Native **源码事实**构建的知识体系与疑难问题定位库。

本仓库把 React Native（`facebook/react-native`）的源码沉淀成一套**可检索、可复现、可验证**的知识库：

- **每条结论都带源码文件路径 + 行号**，不是二手解读，而是可回溯的源码事实。
- **每条断言都可执行校验**：6 道门禁脚本会拿真实源码核对文档，源码演进导致文档腐化时直接失败。
- **源码以 git submodule 引入**，钉死在文档对应的那个 commit 上 —— 文档结论与源码版本永远一致。

一句话用法：**先查索引定位文档，再按文档里的文件:行号去 submodule 里读源码。**

---

## 快速开始

```bash
git clone --recurse-submodules git@github.com:davidtan2008/react-native-analysis.git
cd react-native-analysis
```

已经克隆过、需要补上 submodule 的：

```bash
git submodule update --init --recursive
```

校验环境（应输出 6 个 ✓）：

```bash
for f in audit-citations verify-quotes check-links check-headings verify-claims check-index; do
  node "docs/arch/audit/$f.mjs" >/dev/null 2>&1 && echo "✓ $f" || echo "✗ $f"
done
```

> 门禁脚本会解析 `react-native/` 子模块目录下的源码，因此 **submodule 必须先初始化**，否则源码侧断言全部失败。

---

### 网络不畅时（实测记录）

克隆完整仓库约 **1.1G**（RN 历史约 1.0G，主仓库本体仅 18M）。`github.com:443` 在部分网络下间歇性超时（实测出现过 75s 连接失败），此时：

- **clone 完但漏了 submodule** 不是静默错误：`check-index` 第一步就报 `SUBMODULE_MISSING`，按提示补即可。
- RN submodule 拉取失败时，**换来源重试**（三种方式最终都落到同一个锁定 SHA）：

```bash
# ① 直接重试（每次都是全量，多试几次）
git submodule update --init --recursive

# ② 换成可达的镜像地址
git config submodule.react-native.url <镜像地址>
git submodule update --checkout react-native

# ③ 复用本机已有的 react-native 克隆
git config submodule.react-native.url /本机绝对路径/react-native
git -c protocol.file.allow=always submodule update --checkout react-native
```

> 新版 git 出于安全默认**禁止本机路径作为 submodule 来源**（报 `transport 'file' not allowed`），因此 ③ 必须带 `-c protocol.file.allow=always`。

不要用 `--depth 1 --shallow-submodules`：锁定的是历史提交（`9b131e42d12`，2026-09-29），而上游 main 已前移（实测 2026-10-22 的 HEAD 为 `5b6f18b0`），浅层历史里不含钉住的提交。

---

## 仓库结构

```
react-native-analysis/              ← 本仓库：知识库 + 审计工具链
├── docs/arch/                     ← 知识库主体
│   ├── README.md                  ← 文档总目录（每篇文档一句话摘要）
│   ├── 01-*.md … 86-*.md          ← 86 篇源码解析文档
│   ├── INDEX/                     ← 4 个检索索引（由脚本生成，禁止手改）
│   │   ├── 00-主题地图.md          ← 按主题域 / 子主题浏览
│   │   ├── 01-症状排查手册.md      ← 按现象排查
│   │   ├── 02-结论速查表.md        ← 按结论编号直达
│   │   └── 03-符号与源码入口.md    ← 按符号 / 目录检索
│   ├── audit/                     ← 事实审计工具链（6 门禁 + 2 度量）
│   └── diagrams/                  ← 5 张交互式架构图（HTML，含导出能力）
├── .archify/                      ← 架构图生成工作区（archify skill 的候选与证据）
└── react-native/                  ← git submodule：facebook/react-native
```

### 源码 submodule

| 项 | 值 |
| --- | --- |
| 上游 | `https://github.com/facebook/react-native.git` |
| 钉死的 commit | `9b131e42d12`（`Revert D122079801 (#58727)`，2026-09-29，0.87-dev 主线） |
| 描述 | `v0.54.0-rc.2-29110-g9b131e42d12` |

commit 被**有意钉死**：文档中的行号断言是针对这个 commit 验证的，源码一动，行号就可能漂移。
升级源码是独立动作，见 [更新源码](#更新源码)。

---

## 三条检索路径

不知道从哪下手时，按下面的顺序选：

| 场景 | 入口 |
| --- | --- |
| **我遇到了某个现象**（崩溃 / 白屏 / OOM / 泄漏 / 启动变慢 / 卡顿 / 布局错乱 / 手势 / 动画 / 文本 / 桥接 / 构建 / 调试困难 / 无障碍） | [`docs/arch/INDEX/01-症状排查手册.md`](./docs/arch/INDEX/01-症状排查手册.md) |
| **我想搞懂某个子系统**（Fabric 组件层 / TurboModule / Yoga / 事件分发 / 动画 / 崩溃管线 …） | [`docs/arch/INDEX/00-主题地图.md`](./docs/arch/INDEX/00-主题地图.md) |
| **我记得源码里的某个类或目录** | [`docs/arch/INDEX/03-符号与源码入口.md`](./docs/arch/INDEX/03-符号与源码入口.md) |
| **我记得某条结论编号**（`ZZ-1` / `AAA-1` / `BBB-2` …） | [`docs/arch/INDEX/02-结论速查表.md`](./docs/arch/INDEX/02-结论速查表.md) |

全部 86 篇文档的清单见 [`docs/arch/README.md`](./docs/arch/README.md)。

### 典型排障流程

1. 在**症状排查手册**里找到现象 → 定位相关文档与结论编号
2. 打开对应文档 → 结论里直接给出 `文件路径:行号`
3. 到 `react-native/` 子模块里读那一段源码，确认上下文
4. 需要验证时，跑对应门禁脚本

---

## 事实审计门禁

文档里的每条源码断言都可以被机器复现。**改完文档必须重跑全部门禁。**

```bash
for f in audit-citations verify-quotes check-links check-headings verify-claims check-index; do
  node "docs/arch/audit/$f.mjs" >/dev/null 2>&1 && echo "✓ $f" || echo "✗ $f"
done
```

| # | 脚本 | 管什么 | 管不了什么 |
| --- | --- | --- | --- |
| 1 | `audit-citations.mjs` | 引用文件存在、行号在范围内、表格声明行数与实际一致 | 结论对不对 |
| 2 | `verify-quotes.mjs` | 代码块内容确实来自所引位置 | 结论对不对 |
| 3 | `check-links.mjs` | 文档间链接与锚点有效 | — |
| 4 | `check-headings.mjs` | 子节编号与父节一致 | — |
| 5 | `verify-claims.mjs` | **核心事实断言与源码双向一致** | 未编码的断言 |
| 6 | `check-index.mjs` | front-matter 完整合法、`claims` 与问题表双向一致、生成物未漂移 | 索引是否「有用」 |
| — | `coverage.mjs` | 覆盖度与未读缺口（度量，不判对错） | — |
| — | `normalize-manifest.mjs` | 重算「已读 / 缺口」并回写 manifest | — |

> **前 4 项全绿不代表文档正确** —— 它们只保证「引用的东西存在、贴的代码没造假」。
> 第 5 项是唯一能验证「结论本身对不对」的门禁。

### 当前状态

```
文档:          87 篇（86 篇解析文档 + 目录）
引用:          4079 条（3745 带行号 + 334 纯路径）   全部有效
代码块:        1359 块 / 9334 行已核验             可疑 0
文档间链接:    590 条                               断链 0
核心断言:      1885 条                              全部通过
结论登记:      738 条 / 8 主题域 / 37 子主题 / 17 类症状
源码覆盖:      4176 个代码文件，已读 1149 (27.5%)，未声明 167
```

详细的门禁说明与「已踩过的坑」见 [`docs/arch/audit/README.md`](./docs/arch/audit/README.md)。

### 索引重建

改了任何文档的 front-matter（`topic` / `symptoms` / `symbols` / `claims`）后，
必须先重建索引，否则第 6 项门禁会以 `INDEX_STALE` 失败：

```bash
node docs/arch/audit/build-index.mjs   # 从 front-matter 重新生成 docs/arch/INDEX/*.md
```

---

## 更新源码

submodule 指向新 commit 后，行号断言可能失效 —— 这是**预期行为**：
门禁会精确报出哪些引用漂移了，据此修正文档即可。

```bash
# 1. 取回上游最新提交
git -C react-native fetch origin

# 2. 切到目标 commit（建议先看 diff 的规模）
git -C react-native log --oneline HEAD..origin/main | head -50
git -C react-native checkout origin/main

# 3. 提交新的 submodule 指针
git add react-native
git commit -m "chore: bump react-native submodule to <sha>"

# 4. 跑门禁，按失败项修正文档中的行号
for f in audit-citations verify-quotes check-links check-headings verify-claims check-index; do
  node "docs/arch/audit/$f.mjs" >/dev/null 2>&1 && echo "✓ $f" || echo "✗ $f"
done
```

---

## 架构图

`docs/arch/diagrams/` 下有 5 张可交互架构图（纯 HTML，双击即开，无需服务器）：

| 图 | 内容 |
| --- | --- |
| `01-runtime-layers.html` | React Native 运行时分层与核心组件 |
| `02-fabric-pipeline.html` | Fabric 渲染管线（JS → ShadowTree → 平台视图） |
| `03-event-loop.html` | 事件循环与任务调度 |
| `04-crash-pipeline.html` | 崩溃日志捕获 / 收集 / 上传链路 |
| `05-monitoring.html` | 监控检测原理与流程 |

图由 `.archify/` 工作区里的候选 JSON 生成（archify skill），支持 PNG / SVG / WebP / WebM 导出，
深浅色主题，架构图支持 trace 动效。

---

## 文档约定

新增文档时遵守：

1. **锚点用完整路径** —— `packages/react-native/ReactCommon/.../Foo.cpp:123`，
   不要用裸文件名（仓库里存在同名文件）。
2. **压缩过的代码块要在块内首行标注出处**，否则逐字匹配会失败。
3. **不要用 `ReactAndroid/.../` 这种省略写法** —— 会让行号逃过机器校验。
4. **结论必须注明适用范围**（平台 / 架构 / 编译条件）。
5. **数字类断言用精确值** —— 「约 98 个」既抓不到错误，也提供错误的安全感。
6. 写完正文 → 补 front-matter → 跑 `build-index.mjs` → 跑 `check-index.mjs`。

---

## 相关文档

| 文档 | 说明 |
| --- | --- |
| [`docs/arch/README.md`](./docs/arch/README.md) | 86 篇文档的清单与内容摘要 |
| [`docs/arch/audit/README.md`](./docs/arch/audit/README.md) | 审计工具链详解 + 复核教训 |
| [`docs/arch/audit/READ-PLAN.md`](./docs/arch/audit/READ-PLAN.md) | 38 个模块 / 14 个批次的全量通读计划 |
| [`HANDOVER.md`](./HANDOVER.md) | **交接文档** —— 项目全貌、方法论、剩余工作的优先级与完整计划 |
| [`AGENTS.md`](./AGENTS.md) | 在本仓库中工作（尤其是自动化 agent）的约定 |

---

## License

文档与工具链部分以本仓库的 LICENSE 为准。`react-native/` 子模块遵循
[React Native 自身的 MIT License](https://github.com/facebook/react-native/blob/main/LICENSE)。
