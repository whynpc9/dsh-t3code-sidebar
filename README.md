# DeepSeek Harness T3 Sidebar

`dsh-t3code-sidebar` 为 DeepSeek Harness 提供以任务分区为核心的 Sidebar 插件。默认采用 T3 Code 风格的 Pinned、Active、Working、Snoozed、Settled 分区，同时提供可切换的项目分组视图。

当前阶段：**R0 内部 alpha（`0.1.0-alpha.0`）**。M0 四个验证门已在 Linux Web 上通过（[验证记录](docs/validation/poc/README.md)），任务视图、项目视图、Snooze / 已处理、Host 持久化与自动收起调度均已实现并有自动化证据；尚未达到 v0.1-preview 的完整验收（见[开发计划 · 执行状态](docs/development-plan.md#执行状态2026-11-09)）。目标运行时为 `@deepseek-ai/dsh` `0.2.2-rc.1`。

## 文档

| 文档 | 用途 |
| --- | --- |
| [产品规格](docs/product-spec.md) | 用户场景、双视图交互、分区规则、范围与验收 |
| [实现 Spec](docs/implementation-spec.md) | 插件边界、数据模型、状态机、API、持久化、失败恢复 |
| [时间策略 Spec](docs/time-policy-spec.md) | 自动 Settled、Snooze 到期、PR/限额与自动归档计划 |
| [开发计划](docs/development-plan.md) | 技术验证、任务依赖、里程碑、执行状态与发布门槛 |
| [M0 验证记录](docs/validation/poc/README.md) | 实测结论、能力矩阵、截图与端到端结果 |
| [调研结论与证据索引](docs/research/README.md) | 固定上游版本、可行性、来源 |

## 安装（测试 profile）

插件尚未发布到 npm。请只在新建的测试 profile 中安装预构建 tarball：

```sh
npm install
npm run verify        # typecheck、测试、构建、pack 检查
npm pack              # 生成 dsh-t3code-sidebar-<version>.tgz
dsh plugin --profile <测试 profile> add "$PWD/dsh-t3code-sidebar-<version>.tgz"
dsh --profile <测试 profile>
```

卸载：`dsh plugin --profile <测试 profile> remove dsh-t3code-sidebar`。卸载后原生侧栏恢复，会话与聊天记录不受影响；插件自己的任务元数据（`t3_sidebar` 存储域）保留，重新安装后继续生效。

运维开关：以 `DSH_T3_SIDEBAR_HOST=off` 启动时跳过 Host 服务，侧栏退回“浏览器本地预览”（任务状态只存在当前浏览器）。

## 功能概览

- **任务视图（默认）**：五分区，按语义事件排序；运行、等待审批/回答、失败、新结果分别标注；折叠分区仍保留当前会话；当前会话被筛选排除时可一键定位。
- **项目视图**：按 Workspace 分组，组内置顶 → 需处理 → 运行 → 其他，Snoozed/Settled 收在子分组；可添加、重命名、移除项目，在项目内新建会话。
- **会话菜单**：在 Harness 原生会话菜单中加入“稍后处理（预设/自定义时间）”“标为已处理 / 重新打开”“此会话不自动收起”。
- **时间策略**：Host 定时器精确唤醒 Snooze（浏览器关闭也有效，Host 停机后补算）；默认 7 天无活动自动收起，可关闭或修改天数，首次安装给予完整宽限，最近变更可在设置面板查看。
- **搜索与筛选**：项目筛选、标题/项目即时过滤、可选正文搜索（调用原生 `sessions.search`，显示截断提示）。
- **中英文、亮暗主题**跟随 Harness。

## 开发

```text
src/domain/     纯函数：分区、排序、Snooze 时间、自动收起、命令转换
src/contracts/  zod schema 与 Typert Remote spec（Client codec 与 Host 校验共用）
src/host/       Host 服务：存储域、事件折叠、命令队列、调度器、follow 流
src/client/     浏览器半部：后端选择（Host / 本地）、视图模型、React 组件、文案
tests/          domain / host / client 单元测试；e2e 脚本与脚本化模型桩
scripts/        构建（Loader lazy-CJS 封装与签名守卫）、pack 检查
```

端到端测试的完整步骤见 [M0 验证记录 · 复现](docs/validation/poc/README.md#复现)。
