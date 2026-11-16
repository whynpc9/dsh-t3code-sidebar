# 验证记录

[English](README.md) | 中文

每份记录保留当被测版本、运行环境、通过范围和未覆盖项；历史记录中的“待验证”不代表当前状态。当前发布结论以[发行说明](../release.zh.md)为准。

- [Q02 / Q03：规模与生命周期](q02-q03/README.md)：2026-11-14，Linux Web；5000 会话、50 个活跃轮次、安装升级与 Loader 重复启停。
- [U07：Desktop 键盘与焦点](u07/README.md)：2026-11-14，macOS Desktop；快捷键、当前会话定位、菜单焦点和减少动态效果。
- [A10：访问控制](a10/README.md)：2026-11-13，真实 Gateway 与浏览器；guest 拒绝、撤权和未知字段。
- [原生构图复验](native-ui/README.md)：2026-11-12，Linux Web；原生布局对比、三种分组、搜索、设置和截图。
- [M0 与 alpha 复验](poc/README.md)：2026-11-09 至 11-12；可行性验证、连接与生命周期、早期 Desktop 和 alpha.2 端到端记录。

截图和 JSON 原始数据留在对应目录，不随 npm 包发布。
