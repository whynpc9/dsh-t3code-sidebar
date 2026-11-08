# DeepSeek Harness T3 Sidebar

为 DeepSeek Harness 提供以任务分区为核心的 Sidebar 插件。默认采用 T3 Code 风格的 Pinned、Active、Working、Snoozed、Settled 分区，同时提供可切换的项目与会话分组视图。

当前阶段：调研与实现规格，尚未实现或验证可安装插件。文档基线日期为 2026-11-08。

## 开发入口

| 文档 | 用途 |
| --- | --- |
| [产品规格](docs/product-spec.md) | 用户场景、双视图交互、分区规则、范围与验收 |
| [实现 Spec](docs/implementation-spec.md) | 插件边界、数据模型、状态机、API、持久化、失败恢复 |
| [时间策略 Spec](docs/time-policy-spec.md) | 自动 Settled、Snooze 到期、PR/限额与自动归档计划 |
| [开发计划](docs/development-plan.md) | 技术验证、任务依赖、里程碑、测试与发布门槛 |
| [调研结论与证据索引](docs/research/README.md) | 固定上游版本、可行性、来源与尚需验证的问题 |

## 已确定方向

- **任务视图优先**：默认任务分区；项目视图是同一数据集的另一种展示，不建立第二套会话系统。
- **作为 Harness 插件交付**：通过官方 `sidebar.workspaces` 槽位覆盖会话浏览区域，保留 Harness 外壳、聊天区、工作区导航与权限机制。
- **任务状态独立持久化**：复用原生会话、置顶和归档；插件存储 Snooze、Settled、排序与任务事件游标，不修改聊天记录文件。
- **按时间自动整理**：首版包含可配置的不活跃自动 Settled、Snooze 唤醒和保护规则；自动 Archived 作为默认关闭的后续增补，受原生原子保护能力门槛约束。
- **先证明扩展边界**：外部包构建、槽位覆盖、运行状态汇总和停用回退必须先通过 P0 验证，才能进入完整 UI 实现。

名称为工作名称；npm 包名、发布范围和版本兼容区间在安装验证后确定。尚未安装依赖或启动用户的 Harness 实例。
