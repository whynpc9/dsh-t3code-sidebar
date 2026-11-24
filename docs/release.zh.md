# 发行说明、支持矩阵与发布门禁（R01）

[English](release.md) | 中文

更新：2026-11-18，对应 `0.1.0` 稳定版（npm `latest` 标签）。此前的 `0.1.0-preview.0` 仍可通过 `preview` 标签安装。“稳定版”表示发行通道，平台支持范围仍以以下证据为准。本文是[开发计划](archive/development-plan.md)第 7、11 节发布分层的落地清单：未列为“通过”的项不得对外宣称。版本历史见 [CHANGELOG](../CHANGELOG.md)。

## 1. 支持矩阵

`engines.dsh` 声明 `>=0.2.2-rc.1 <0.3.0`（维护者决定暂不收窄），但只有下表中的组合有实测证据。

| 运行时 | 平台 | 已测插件构建 | 状态 | 证据 |
| --- | --- | --- | --- | --- |
| `@deepseek-ai/dsh` 0.2.2-rc.1 | Linux Web（WSL2，headless Chromium 1243） | 0.1.0-alpha.2 → 0.1.0-preview.0 | **已验证列出的场景**：安装、主场景、Host 重启、审批态、快捷键、Workspace 策略与结果确认、规模与生命周期（[Q02/Q03](validation/q02-q03/README.md)）、权限撤回（[A10](validation/a10/README.md)） | [验证记录 · 2026-11-12](validation/poc/README.md#2026-11-12-linux-web-复验alpha2) |
| `@deepseek-ai/dsh` 0.2.2-rc.1 | macOS Desktop 26.6.2（arm64，Electron 44.7） | 0.1.0-alpha.0 / alpha.1 构建 | **部分验证**（#2/#3 ⌘Q 重启主线、卸载/重装/升级/回退、竞争插件）；alpha.2 的 ⌘K/⌘O 修复**未在此 Desktop 环境复验** | [验证记录 · macOS Desktop](validation/poc/README.md#2026-11-11-macos-desktop-复验issue-4) |
| `@deepseek-ai/dsh` 0.2.2-rc.3 | macOS Desktop 27.0.1（arm64） | `95ee68a` 的 `0.1.0-preview.0` 源码构建包 | **部分验证**：基本加载、普通低峰稍后处理不创建自动化任务、定时投递与提前返回取消 | [2026-11-17 验证记录](validation/desktop-v010-2026-11-17.md) |
| `@deepseek-ai/dsh` 0.2.2-rc.3 | macOS Desktop 27.0.1（arm64） | `0.1.0` 候选包 | **部分验证**：加载、卸载与重装、⌘K/⌘O、低峰停放、定时消息的创建、取消与改期后投递。首轮出现一次退出卡住。 | [候选包复验](validation/desktop-v010-2026-11-17.md#2026-11-18--010-候选包复验) |
| 其他版本 | 任意 | — | 未验证 | — |
| Windows Desktop / Windows Web | — | — | 未验证 | — |

另外，[PR #12](https://github.com/whynpc9/dsh-t3code-sidebar/pull/12)记录了使用模型桩和 Host 时钟偏移的 Harness `0.2.2-rc.1` Web 实机端到端验证：定时能力检测、对话框创建、边界投递并完成一轮、提前返回与人工消息取消，以及 Host 停机后的迟延投递。该记录与上述 Desktop 环境不同。

`0.1.0` 候选包采用 PR #12 审核过的低峰功能。正式发布后仍需从 npm 安装并验证发布产物。

## 2. 发布分层与当前位置

`0.1.0` 通过 npm `latest` 发布，正式支持上表所列的 Linux Web 环境。完整 macOS Desktop 验收（M6）延至发布后，继续验证原定低峰边界投递并调查首轮候选包测试中的退出卡住。

| 层 | 出口条件 | 状态 |
| --- | --- | --- |
| R0 内部 alpha | 测试 profile 可安装；任务视图、原生动作、手动 Snooze/Settled | 已达成 |
| v0.1-preview（Linux Web） | Linux Web 上 F01–F11、A01–A12、T01–T09、T12 时间部分全部有证据 | **已发布 `0.1.0-preview.0`**：各项均有证据，未覆盖部分见第 4、5 节 |
| macOS Desktop 完整支持（M6） | macOS Desktop 安装、卸载与 GUI 验收 | **部分验证**，其余场景延至 `0.1.0` 发布后。 |

## 3. 安装、升级、回滚

用户操作见 [README · 安装](../README.zh.md#安装)和 [README · 低峰时段稍后处理与继续](../README.zh.md#低峰时段稍后处理与继续)。要点：

- 用 `dsh plugin --profile <p> add dsh-t3code-sidebar@0.1.0` 明确安装此稳定版；如需跟随当前稳定版而不是固定此版本，使用 `@latest`。`@preview` 仍跟随独立的预览通道。
- 只在新建的测试 profile 中安装预构建 tarball（`pnpm pack` 产物）。
- `plugin add` 对**相同版本号**的 tarball 是空操作；升级测试必须提升 `version`，或先 `remove` 再 `add`。
- 回滚前先取消待执行的低峰自动继续，再运行 `dsh plugin --profile <p> remove dsh-t3code-sidebar`，然后 `add` 上一已验证版本或 tarball。插件元数据（`t3_sidebar` 存储域）在卸载后保留；alpha.2 新增字段（`keepUnacknowledgedResults`、`workspaceOverrides`、`resultAcknowledgedSeq` 及 global 的宽限/成员记录）在旧版本读取时被 zod 默认丢弃，回退后旧版本按旧规则运行，不会损坏数据；重新升级后 Workspace 覆盖与结果确认需要重新设置。
- 运维开关 `DSH_T3_SIDEBAR_HOST=off`：跳过 Host 服务，使用浏览器本地降级模式，并在设置页说明原因。Host 服务缺失或不兼容也会进入此模式；临时断连则继续重试 Host，不会把 Host 状态转移到浏览器存储。
- npm **preview 发行通道**与**浏览器本地降级模式**无关。降级模式的任务状态保存在当前浏览器并同步到同一浏览器的标签页，仅在标签页打开时处理稍后处理，不支持自动收起或定时继续。

## 4. 发布门禁核对（现有 v0.1 证据）

| 门禁 | 状态 | 说明 |
| --- | --- | --- |
| F01–F11 功能 | 有证据 | 端到端 `scenario.mjs` 20/20、`features.mjs` 14/14；preview 门禁时有 230 项单元/组件测试 |
| A02 等待审批 / A03 新审批唤醒 | **通过（Linux Web）** | 本机无 bubblewrap，bash 不升级沙箱；以测试专用 `approval-gate` 夹具经真实审批流程触发 |
| A07 搜索竞态 / A08 键盘 | 自动化 | `tests/client/sidebar.spec.tsx`（真实 DOM）+ e2e N09 |
| A10 权限撤回 / guest | **通过（Web，隔离 Gateway 夹具）** | guest 默认原生侧栏；撤权后关闭任务视图、拒绝读写和后续流帧；未知写入被拒；任务 API 关闭时 owner 仍可使用本地降级模式。见[验证记录](validation/a10/README.md) |
| A12 规模 | **Linux Web 通过已测负载** | 100 个工作区 / 5000 条会话 / 50 个并发轮次。首屏、本地更新、搜索、切换、单列表长滚动行数均在预算内。见 [Q02 实测](validation/q02-q03/README.md)。 |
| 读屏 / 当前项定位 | **U07 部分通过** | Desktop 的当前项定位、窄窗口和键盘焦点路径已复验。VoiceOver 按本轮范围跳过。见 [U07 验收记录](validation/u07/README.md) |
| T01–T09 | 单元/服务测试 | 自动 Settled 的真实跨天迁移仍只由 fake clock 覆盖（最小窗口 1 天） |
| Q03 生命周期与重复启停 | **Linux Web 功能通过** | 安装、升级、回退、卸载、重装、同槽竞争、Host 服务缺失和 20 次真实 Loader 启停已验证。100 次复验中，停用后的任务 DOM 和 follow 流归零，浏览器堆仍有增长，主要来自 V8 编译。断网和跨长时间段场景按本轮范围跳过。见 [Q03 实测](validation/q02-q03/README.md#q03--安装冲突与启停)。 |
| Desktop 低峰场景 | **部分通过** | 在 2026-11-17 隔离 Desktop 环境中，普通低峰稍后处理未创建定时任务；自动继续投递 `Continue.` 并完成第二轮；提前返回后活动任务消失。候选包复验确认了 GUI 安装与卸载、两项快捷键，以及修改定时任务时间后的投递。原定低峰边界投递及 Desktop M6 的其余场景仍待验证。见 [Desktop 记录](validation/desktop-v010-2026-11-17.md)。 |
| 许可 | MIT LICENSE 随包发行 | 依赖均为宿主共享，构建产物不含第三方代码副本（pack 检查）。随包的中国法定节假日日期来自 [holiday-cn](https://github.com/NateScarlet/holiday-cn)（MIT，© 2019 NateScarlet） |
| npm 包名可用性 | **已确认** | 2026-11-16 `npm view dsh-t3code-sidebar` 返回 404，名称未被占用 |
| 发布流程 | **已配置；稳定版验证待完成** | 标签工作流核对 `v<package version>` 与 `main`，运行验证、打包一次，再通过 npm OIDC/trusted publishing 发布该 tarball。`0.1.0` 这样的稳定版本选择 **`latest`**；`-preview` 版本选择 `preview`（其他预发布通道为 `alpha`/`next`）。 |
| 低峰时段数据 | 维护项 | 发布前对照 [DeepSeek 价格页面](https://api-docs.deepseek.com/quick_start/pricing)复核 `src/domain/offpeak.ts` 中的 `DEEPSEEK_SCHEDULE` 并更新 `verifiedOn`；新一年的中国节假日安排公布后运行 `pnpm run holidays:update <年份>` |
| 从 registry 安装 | **0.1.0 发布后待验证** | 发布后在新测试 profile 执行 `dsh plugin --profile <p> add dsh-t3code-sidebar@0.1.0`，确认 Host 与 Client 两半均加载；用 `npm view dsh-t3code-sidebar dist-tags` 核对 `latest` 指向 `0.1.0`。 |

## 5. 已知限制

- 只在 Linux Web + dsh 0.2.2-rc.1 上正式支持；macOS Desktop 为部分验证（M6 未完成），Windows 未验证。
- 自动 Settled 的真实跨天迁移只由 fake clock 覆盖；读屏（VoiceOver）播报未验收。
- 原生行装饰子槽、手动拖拽排序、工作区树分组不可用（见[原生构图设计 §9](design/native-sidebar-design.md)）。
- ⌘K / ⌘O 依赖原生 `sidebar.workspaces` 注册注入的请求 store（公开 `ctx.slots.entries`）；若宿主改变该注入形状，快捷键退回无效果而不报错。Linux Web 默认未绑定这两个命令（宿主默认值不含 `web:linux` 绑定）。
- 自动 Settled 的保护以 Host 可见事实为准：turn 之外仍待回答的定时提问经精确投影读取；读取失败时跳过并显示“状态未知”。
- 浏览器本地降级模式没有自动 Settled 或“低峰时段继续…”。记录只保存在当前浏览器；仅在浏览器标签页打开时处理稍后处理到期和活动唤醒。这与 npm `preview` 标签无关。
- 审计（transitions）为尽力而为，主记录提交后审计写失败会留下缺口；诊断以记录 `receipts` 与 revision 为准。
- 自动 Archived、PR/限额相关规则不在 v0.1（v0.2/v0.3）。
- “低峰时段继续…”依赖 Harness 定时任务服务，只在 Host 运行时投递。Host 停机期间错过时间的消息会在 Host 重新启动后投递，可能落在之后的高峰时段；插件不会重新安排或改期。
- 自动继续的取消为尽力而为：Host 最多在后台尝试删除三次。重试期间 Host 停机可能留下过期的定时消息；如投递时间重要，请在“自动化任务”中复查。创建和删除时，Harness 还会在会话上下文中加入一条不触发运行的“定时任务变更”通知。
- **消息历史搜索**（可选，默认关闭）在 Host 内存中保存索引；由于不写入磁盘，每次 Host 启动（或空闲 30 分钟）后都要重建。重建速度受 Harness 自身冷读日志的开销限制：Linux Web 上 5,000 个会话约 70 秒，期间按从新到旧逐步显示结果。文本内存上限约 180 MB（约 25 万条数百字的消息），超出后按创建时间最早的会话让位给较新的会话（单个会话超出上限时只保留其最新消息），侧栏会说明。已在 Linux Web + dsh 0.2.2-rc.1 和脚本化模型桩下验证，包括 5,000 个会话的 profile（`tests/e2e/history-search.mjs`）；尚未在 Desktop 或真实模型输出上验证。超过 4 MiB 的文本块只搜索前 4 MiB。匹配为单条消息内的字面子串：不支持查询语法、模糊或拼音匹配，繁简折叠按单字进行（不做词组或地区用词转换）。点击结果打开会话；Harness 没有向插件开放滚动到某条消息的接口（轮次导航是其聊天视图的内部实现）。日志中间被改写的内容（Harness 自身不会这样做）在下次完整重读前（最多 10 分钟）仍可能被搜到；末尾被改写或截断会立即发现。
