# DeepSeek Harness T3 Sidebar

`dsh-t3code-sidebar` 为 DeepSeek Harness 提供以任务分区为核心的 Sidebar 插件。界面按原生 **Workspaces** 区域的构图复刻（标题、搜索、视图选项、添加工作区，32px 会话行、悬停卡片与悬停操作），并在“分组方式”中新增默认的 **按状态**：T3 Code 风格的 Pinned、Active、Working、Snoozed、Settled 分区；也可按工作区或单列表查看。

当前阶段：**R0 内部 alpha（`0.1.0-alpha.1`）**。M0 四个验证门已在 Linux Web 上通过（[验证记录](docs/validation/poc/README.md)），状态/工作区/单列表分组、Snooze / 已处理、Host 持久化与自动收起调度均已实现并有自动化证据（[原生构图复验](docs/validation/native-ui/README.md)）；尚未达到 v0.1-preview 的完整验收（见[开发计划 · 执行状态](docs/development-plan.md#执行状态2026-11-09)）。目标运行时为 `@deepseek-ai/dsh` `0.2.2-rc.1`。

## 文档

| 文档 | 用途 |
| --- | --- |
| [产品规格](docs/product-spec.md) | 用户场景、分区规则、范围与验收 |
| [原生构图侧栏设计](docs/native-sidebar-design.md) | 界面构图、三种分组、行操作、搜索、设置页（取代产品规格中的界面构图部分） |
| [实现 Spec](docs/implementation-spec.md) | 插件边界、数据模型、状态机、API、持久化、失败恢复 |
| [时间策略 Spec](docs/time-policy-spec.md) | 自动 Settled、Snooze 到期、PR/限额与自动归档计划 |
| [开发计划](docs/development-plan.md) | 技术验证、任务依赖、里程碑、执行状态与发布门槛 |
| [M0 验证记录](docs/validation/poc/README.md) | 实测结论、能力矩阵、截图与端到端结果 |
| [调研结论与证据索引](docs/research/README.md) | 固定上游版本、可行性、来源 |

## 安装（测试 profile）

插件尚未发布到 npm。请只在新建的测试 profile 中安装预构建 tarball：

包管理器统一为 pnpm（`packageManager` 字段固定版本，锁文件为 `pnpm-lock.yaml`）：

```sh
pnpm install --frozen-lockfile
pnpm run verify       # typecheck、测试、构建、pack 检查
pnpm pack             # 生成 dsh-t3code-sidebar-<version>.tgz
dsh plugin --profile <测试 profile> add "$PWD/dsh-t3code-sidebar-<version>.tgz"
dsh --profile <测试 profile>
```

升级：`plugin add` 对**相同版本号**的 tarball 不做任何更新（dsh 0.2.2-rc.1 实测）。升级测试必须提升 `version`，或先 `remove` 再 `add`。

卸载 / 回滚：`dsh plugin --profile <测试 profile> remove dsh-t3code-sidebar`，回滚即重新 `add` 旧版本 tarball。卸载后原生侧栏恢复，会话与聊天记录不受影响；插件自己的任务元数据（`t3_sidebar` 存储域）保留，重新安装后继续生效。

运维开关：以 `DSH_T3_SIDEBAR_HOST=off` 启动时跳过 Host 服务，侧栏退回“浏览器本地预览”（任务状态只存在当前浏览器），设置页显示原因。Host 暂时不可达（断线、5xx）时不会切换到本地预览，而是显示“正在重试”并继续连接 Host。

Linux Web（WSL2）已在 dsh 0.2.2-rc.1 上实测。macOS Desktop 0.2.2-rc.1 已通过隔离 profile 安装和 #2/#3 的 ⌘Q 重启复验，M6 完整验收仍待完成。其他 `engines.dsh` 范围内的版本尚待实测。[验证记录](docs/validation/poc/README.md)

## 功能概览

- **原生构图**：与原生 Workspaces 区域相同的标题行（会话/工作区 · 搜索 · 视图选项 · 添加工作区）、行、悬停卡片、“展开其余 N 个会话”、空状态与窄栏。
- **按状态分组（默认）**：五分区按语义事件排序，空分区不显示；Snoozed/Settled 默认折叠并显示数量；折叠分区仍保留当前会话。
- **按工作区 / 单列表**：置顶在前、其余按最近更新；Snoozed/Settled 会话留在原位并带图标；可添加、重命名、移除工作区，在工作区内新建会话。
- **行操作**：悬停时显示 “…”（原生会话菜单，含归档）、**收起 / 取消收起**（取代原生的归档按钮）、置顶；会话菜单另有“稍后处理（预设/自定义时间）”“此会话不自动收起”。
- **时间策略**：Host 定时器精确唤醒 Snooze（浏览器关闭也有效，Host 停机后补算）；默认 7 天无活动自动收起，可关闭或修改天数，首次安装给予完整宽限。
- **设置页**：在 **插件 → 本插件详情页** 中设置自动收起并查看最近的状态变更；视图选项菜单的“侧栏设置…”直达。
- **搜索与筛选**：与原生一致，标题/工作区即时匹配并同时搜索正文（`sessions.search`，显示截断提示）；隐藏 / 显示 / 仅显示已归档。
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
