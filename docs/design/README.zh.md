# 设计文档

[English](README.md) | 中文

这些文档记录设计决策与验收口径。**当前支持范围以[发行说明](../release.zh.md)为准，实际数据契约以 `src/contracts/` 为准。**

- [产品规格](product-spec.md)：任务语义、五种状态、搜索、操作和验收场景；界面构图部分已由下一份文档取代。
- [原生构图侧栏设计](native-sidebar-design.md)：三种分组、会话行、搜索、设置入口和已知界面差异。
- [实现 Spec](implementation-spec.md)：Host/Client 架构、存储、同步、权限与生命周期；§4.0 和 §5.0 的 v1 契约优先于早期设计稿。
- [时间策略 Spec](time-policy-spec.md)：Snooze、自动收起、宽限、保护与审计规则；§0 记录 v0.1 已落地范围，后续章节中的 PR、限额和自动归档属于规划。

早期任务依赖和执行过程见[开发计划](../archive/development-plan.md)，上游事实来源见[调研索引](../research/README.md)。
