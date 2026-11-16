# 文档索引

使用者只需阅读[项目 README](../README.md)和[发行说明](release.md)；其余目录保留设计依据与验证证据。

## 当前信息

- [项目 README](../README.md)：功能、安装、使用和开发入口。
- [发行说明与支持矩阵](release.md)：已验证平台、升级回滚、发布门禁和已知限制。
- [CHANGELOG](../CHANGELOG.md)：版本历史。
- [设计文档](design/README.md)：产品行为、界面、实现契约和时间策略。
- [验证记录](validation/README.md)：各轮实测环境、结果、截图和原始数据。

## 参考与历史

- [上游调研](research/README.md)：固定版本源码调研，记录设计时的上游事实，不代表当前实现状态。
- [开发计划](archive/development-plan.md)：早期任务拆解与里程碑，已完成内容仅作历史记录；后续计划不在这里持续维护。

## 插件页短详情

- [中文](DETAIL.zh.md) / [English](DETAIL.md)：由 `locale/*.json` 的 `meta.detail` 指向，显示在 Plugins 详情页的配置控件之前。
- 这两份文件刻意保持简短，不承担安装手册或完整功能说明；修改后运行 `pnpm run pack:check`，确认它们随包发布且内部 `docs/` 不会被打包。
