# React Native Analysis

基于 React Native **源码事实**的知识库与问题定位工具链。

## Repo structure

| Path | Contents |
| --- | --- |
| `docs/arch/*.md` | 74 篇源码解析文档（编号 01–74），每篇带 front-matter |
| `docs/arch/INDEX/` | 4 个检索索引 —— **由 `audit/build-index.mjs` 生成，禁止手改** |
| `docs/arch/audit/` | 事实审计工具链：6 道门禁 + 2 个度量脚本 |
| `docs/arch/diagrams/` | 交互式架构图（HTML）及其生成凭据 |
| `.archify/` | 架构图生成工作区（archify skill 的候选 JSON 与浏览器证据） |
| `react-native/` | **git submodule** —— `facebook/react-native`，钉死在 `9b131e42d12` |
| `HANDOVER.md` | **交接文档** —— 项目全貌、方法论、剩余工作的完整计划 |

`react-native/` 是 submodule，**不要直接改它**。文档里的行号断言是针对该 commit 验证的。

## Common commands

```bash
# 全部门禁（改完文档必须跑）
for f in audit-citations verify-quotes check-links check-headings verify-claims check-index; do
  node "docs/arch/audit/$f.mjs" >/dev/null 2>&1 && echo "✓ $f" || echo "✗ $f"
done

# 重建索引（改了 front-matter 后）
node docs/arch/audit/build-index.mjs

# 覆盖度与未读缺口
node docs/arch/audit/coverage.mjs --gaps
```

门禁脚本里的路径约定（`docs/arch/audit/*.mjs`）：

- `REPO` = **RN 源码根** = `react-native/` 子模块目录
- `DOCS` = **文档根** = `docs/arch/`
- `build-index.mjs` / `check-index.mjs` 基于 `__dirname` 推导仓库根，**cwd 无关**，从任何目录运行结果相同
- 文档 front-matter 的 `sourceRoot: react-native` 声明该篇的**路径基准 = submodule 根**，由 `check-index.mjs` 校验

## Working rules

1. **结论必须可回溯** —— 每个断言标注 `文件路径:行号`；源码里不存在的能力要明确写「不存在」，
   不要按常见认知推测（RN 的崩溃上传、白屏检测、卡顿监控尤其容易写错）。
2. **数字用精确值** —— 「约 98 个」既抓不到错误，也提供错误的安全感。
3. **注明适用范围** —— 平台（iOS/Android）/ 架构（Fabric/legacy）/ 编译条件（`__DEV__`、`#if RCT_DEBUG`）。
   一次复核曾因把「仅 Android 不存在」写成「全平台已不存在」而出错。
4. **锚点用完整路径** —— 不要用裸文件名（仓库里存在同名文件），不要用 `ReactAndroid/.../` 省略写法
   （会让行号逃过机器校验）。
5. **压缩过的代码块要在块内首行标注出处**。
6. **新增文档** → 写正文 → 补 front-matter → `build-index.mjs` → `check-index.mjs`。
7. **新增重要结论要补断言** —— 在 `audit/verify-claims.mjs` 里加一条可执行检查。
   断言分两个方向：`[C*]` 查源码侧、`[D*]` 查文档侧。
8. **检索元数据是索引的唯一真相源** —— front-matter 的 `topic` / `symptoms` / `symbols` / `claims`
   决定文档能否被检索到。

## Gotchas

- **submodule 没初始化时**，源码侧断言会全部失败（`REPO` 指向的目录不存在）。先 `git submodule update --init --recursive`。
- **`grepCount` 的 `exts` 必须带点号** —— `['h','cpp']` 恒返回 0 个文件，要写 `['.h','.cpp']`。
- **全仓检索要限定 `roots`** —— `roots: ['packages','private','scripts']`；
  现在 `docs/` 已不在源码树内，但新增断言仍应显式限定根目录。
- **`grepCount` 计的是「含匹配的行数」** —— 一个文件里出现 3 次只算 1；需要真实出现次数用 `content.match(re)?.length`。
- **`check-index.mjs` 会在 `.archify/` 下建临时目录** —— 它是 `build-index.mjs` 的执行痕迹，不要提交。
- **架构图用 archify skill 生成** —— 候选 JSON 放 `.archify/<type>-<slug>-<timestamp>/`，
  交付的 HTML 复制到 `docs/arch/diagrams/`；`finalize` 非零退出即失败，不可声称成功。

## Where to look

| 我想知道 | 去哪 |
| --- | --- |
| 按现象排查 | `docs/arch/INDEX/01-症状排查手册.md` |
| 按主题浏览子系统 | `docs/arch/INDEX/00-主题地图.md` |
| 按结论编号直达 | `docs/arch/INDEX/02-结论速查表.md` |
| 按符号 / 目录检索 | `docs/arch/INDEX/03-符号与源码入口.md` |
| 全部文档清单 | `docs/arch/README.md` |
| 门禁详解与历史踩坑 | `docs/arch/audit/README.md` |
| 后续通读计划 | `docs/arch/audit/READ-PLAN.md` |
