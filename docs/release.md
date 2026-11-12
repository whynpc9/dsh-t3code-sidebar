# 发行说明、支持矩阵与发布门禁（R01）

更新：2026-11-12，对应 `0.1.0-alpha.2`。本文是 [开发计划](development-plan.md) 第 7、11 节发布分层的落地清单：哪些已有证据，哪些仍缺；未列为“通过”的项不得对外宣称。版本历史见 [CHANGELOG](../CHANGELOG.md)。

## 1. 支持矩阵

`engines.dsh` 声明 `>=0.2.2-rc.1 <0.3.0`（维护者决定暂不收窄），但只有下表中的组合有实测证据。

| 运行时 | 平台 | 插件版本 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh` 0.2.2-rc.1 | Linux Web（WSL2，headless Chromium 1243） | 0.1.0-alpha.2 | **已验证**：安装、主场景、Host 重启、审批态、快捷键、Workspace 策略与结果确认、规模测量 | [验证记录 · 2026-11-12](validation/poc/README.md#2026-11-12-linux-web-复验alpha2) |
| `@deepseek-ai/dsh` 0.2.2-rc.1 | macOS Desktop 26.6.2（arm64，Electron 44.7） | 0.1.0-alpha.0 / alpha.1 构建 | **部分验证**（#2/#3 ⌘Q 重启主线、卸载/重装/升级/回退、竞争插件）；alpha.2 的 ⌘K/⌘O 修复**未在 Desktop 复验** | [验证记录 · macOS Desktop](validation/poc/README.md#2026-11-11-macos-desktop-复验issue-4) |
| 0.2.2-rc.1 以外的版本 | 任意 | — | 未验证 | — |
| Windows Desktop / Windows Web | — | — | 未验证 | — |

## 2. 发布分层与当前位置

| 层 | 出口条件 | 状态 |
| --- | --- | --- |
| R0 内部 alpha | 测试 profile 可安装；任务视图、原生动作、手动 Snooze/Settled | 已达成 |
| v0.1-preview（Linux Web） | Linux Web 上 F01–F11、A01–A12、T01–T09、T12 时间部分全部有证据 | **接近**：剩余见第 4 节 |
| v0.1（Web + Desktop） | preview 基础上 macOS Desktop 安装、卸载与 GUI 验收 | 未达成：Desktop 复验（M6）未完成 |

## 3. 安装、升级、回滚

见 [README · 安装](../README.md#安装测试-profile)。要点：

- 只在新建的测试 profile 中安装预构建 tarball（`pnpm pack` 产物）。
- `plugin add` 对**相同版本号**的 tarball 是空操作；升级测试必须提升 `version`，或先 `remove` 再 `add`。
- 回滚：`dsh plugin --profile <p> remove dsh-t3code-sidebar`，再 `add` 上一已验证 tarball。插件元数据（`t3_sidebar` 存储域）在卸载后保留；alpha.2 新增字段（`keepUnacknowledgedResults`、`workspaceOverrides`、`resultAcknowledgedSeq` 及 global 的宽限/成员记录）在旧版本读取时被 zod 默认丢弃，回退后旧版本按旧规则运行，不会损坏数据；重新升级后 Workspace 覆盖与结果确认需要重新设置。
- 运维开关 `DSH_T3_SIDEBAR_HOST=off`：跳过 Host 服务，侧栏退回浏览器本地预览并在设置页说明原因。

## 4. 发布门禁核对（v0.1-preview，Linux Web）

| 门禁 | 状态 | 说明 |
| --- | --- | --- |
| F01–F11 功能 | 有证据 | 端到端 `scenario.mjs` 20/20、`features.mjs` 14/14；单元/组件 225 项 |
| A02 等待审批 / A03 新审批唤醒 | **通过（Linux Web）** | 本机无 bubblewrap，bash 不升级沙箱；以测试专用 `approval-gate` 夹具经真实审批流程触发 |
| A07 搜索竞态 / A08 键盘 | 自动化 | `tests/client/sidebar.spec.tsx`（真实 DOM）+ e2e N09 |
| A10 权限撤回 / guest | **缺** | 单机 owner 场景之外的 guest 连接未测试；Host 侧无独立鉴权逻辑（依赖 Gateway owner 鉴权） |
| A12 规模 | 有测量 | 见验证记录的规模测量；预算偏差列在该节 |
| 读屏 | **缺** | 角色/aria 标签已有，未用读屏实测 |
| T01–T09 | 单元/服务测试 | 自动 Settled 的真实跨天迁移仍只由 fake clock 覆盖（最小窗口 1 天） |
| 20 次启停无增长 | 自动化（真实 Cordis context） | Web 上的真实 Loader 20 次启停未执行 |
| 许可 | MIT LICENSE 随包发行 | 依赖均为宿主共享，构建产物不含第三方代码副本（pack 检查） |
| npm 包名可用性 | 未确认 | 正式发布前确认 `dsh-t3code-sidebar` 在 registry 上可用 |

## 5. 已知限制（release notes 必须列出）

- 原生行装饰子槽、手动拖拽排序、工作区树分组不可用（见 [原生构图设计 §9](native-sidebar-design.md)）。
- ⌘K / ⌘O 依赖原生 `sidebar.workspaces` 注册注入的请求 store（公开 `ctx.slots.entries`）；若宿主改变该注入形状，快捷键退回无效果而不报错。Linux Web 默认未绑定这两个命令（宿主默认值不含 `web:linux`）。
- 自动 Settled 的保护以 Host 可见事实为准：turn 之外仍待回答的定时提问经精确投影读取；读取失败时跳过并显示“状态未知”。
- 浏览器本地预览模式下没有自动 Settled，Snooze 只在浏览器打开时返回。
- 审计（transitions）为尽力而为，主记录提交后审计写失败会留下缺口；诊断以记录 `receipts` 与 revision 为准。
- 自动 Archived、PR/限额相关规则不在 v0.1（v0.2/v0.3）。
