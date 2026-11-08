# Sidebar 调研结论与证据索引

调研日期：2026-11-08（Asia/Shanghai）。项目初始为空目录，没有 Git、代码或可运行插件。公开搜索用于找到官方来源，结论以固定 Git checkout 的源码与文档交叉核对为准。

## 结论

独立 Sidebar 插件有明确的官方扩展入口，推荐覆盖 `sidebar.workspaces` 并保留原生 `ui-workspace` 服务。两种视图在同一个插件组件中切换；默认采用 T3 风格任务五分区。持久 Snooze/Settled/自动时间策略需要插件 Host 服务和自有存储，不能只调整 UI。

外部 Client bundle、typed Remote 装配、新投影通过已发行版本 codec、冷会话事实和 Desktop 生命周期仍需要安装型验证。源码已给出可行路径，本次没有执行这些 PoC。

T3 已实现不活跃自动 Settled、PR 终态规则和 Snooze 时间迁移。本次固定范围未找到定时自动 Archived；将其作为插件增补规划，并保留原子归档条件门槛。

## 来源基线

| 上游 | 固定提交 | 内容与限制 |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | [`fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`](https://github.com/deepseek-ai/deepseek-harness/commit/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159) | package版本0.2.2-rc.1，官方开发者预览；不代表已确认用户安装版本 |
| [T3 Code](https://github.com/pingdotgg/t3code) | [`a9e709f15f825cacac1b6d665fa1920c328d68b7`](https://github.com/pingdotgg/t3code/commit/a9e709f15f825cacac1b6d665fa1920c328d68b7) | Git checkout比connector的main缓存新；以该固定提交为准 |

没有使用私人聊天、数据库或账号凭据。没有运行模型请求、宿主应用或 GUI 验收。临时上游 checkout 在 `/tmp/dsh-sidebar-research/`，不是本项目运行依赖；永久来源链接均固定 SHA。

## 分项证据

| 文件 | 关键证据 |
| --- | --- |
| [Harness插件边界](harness-plugin-boundary.md) | slot优先级、子slot所有权、公共导航、client构建、Web/Desktop安装 |
| [Harness状态契约](harness-state-contract.md) | 实时与持久状态、projection缺项、storage、Remote、权限、重连 |
| [T3 Sidebar源码](t3-code-source-review.md) | 五分区、Boring/Legacy差别、行状态、排序、搜索、当前项、license |
| [T3时间策略](t3-time-policies.md) | 默认7天、1–90天、起算锚点、保护、sweep、PR、Snooze、Archived搜索边界 |

Exa 按 Harness 与 T3 两条搜索线索定位来源，成功搜索返回 11 条候选，schema验证失败的调用未产生结果；检索条数不等于独立证据数量。另通过 Context7 的官方 Harness 索引定位扩展/API 文档，再用源码确认。最终依据是上表两份固定源码及所链接的官方说明，未把搜索片段当实现事实。

## 主要事实与设计差异

| 项目 | 已观察事实 | 本项目选择 |
| --- | --- | --- |
| 默认结构 | T3 pinned/active/working/snoozed/settled | 同五分区；无独立Attention区 |
| 项目视图 | 当前T3 Boring仅Active按项目分组，旧Legacy已移除 | 完整Workspace分组作为替代视图 |
| Pin/停车 | T3有效Snooze可覆盖pin；Pin动作能清停车 | 原生Pin优先显示，保留停车，unpin再计算，避免跨存储双写 |
| 自动Settled | T3默认7天；固定源码排除pinned，文档有漂移 | 首版7天预设、完整保护、初装历史宽限、可关闭和覆盖 |
| 归档 | 没找到T3定时Archived | 增补功能，默认Off；原子条件未证前仅候选 |
| 完成未读 | Harness有Client内存提示，没有统一持久完成事件游标 | 小投影+自有Remote补充；已读和Settled独立 |
| 拖拽/Git | T3拥有完整runtime/source-control配套 | v0.2/v0.3分阶段接入，不复制副作用 |

开源许可方面，两份上游根 LICENSE 均为 MIT；未来若引入实质代码须保留版权与许可声明，第三方资产和品牌另行检查。当前只创建研究与规格，没有复制上游应用源码。
