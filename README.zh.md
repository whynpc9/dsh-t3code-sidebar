# dsh-t3code-sidebar

[English](README.md) | 中文

为 DeepSeek Harness 提供 T3 Code 风格的任务侧栏：保留原生 Workspaces 的构图与操作，把会话按任务状态整理，也可按工作区或单列表查看。

> 当前为 **v0.1-preview**。已在 Linux Web + `@deepseek-ai/dsh` `0.2.2-rc.1` 上验证；macOS Desktop 仅部分验证，Windows 尚未验证。详见[支持矩阵与已知限制](docs/release.zh.md)。

## 功能

- **三种分组**：按状态（默认）、按工作区、单列表；支持搜索和归档筛选。
- **五种任务状态**：置顶、待处理、运行中、稍后处理、已处理；空分区自动隐藏。
- **任务整理**：稍后处理、手动收起、结果确认，以及默认 7 天无活动自动收起。
- **灵活策略**：自动收起可关闭或改为 1–90 天，支持工作区覆盖和单会话豁免。
- **原生体验**：会话菜单、工作区管理、中英文、亮暗主题及窄栏跟随 Harness。

## 安装

建议先在测试 profile 中试用：

```sh
dsh plugin --profile <profile> add dsh-t3code-sidebar@preview
dsh --profile <profile>
```

卸载后原生侧栏自动恢复，会话与聊天记录不受影响：

```sh
dsh plugin --profile <profile> remove dsh-t3code-sidebar
```

升级、回滚和本地 tarball 安装见[发行说明](docs/release.zh.md)。

## 使用

- 在侧栏的**视图选项**中切换分组和归档筛选；macOS 可用 `⌘K` 搜索、`⌘O` 添加工作区。
- 在会话的 **… 菜单**中稍后处理、收起、确认结果或设置自动收起豁免；归档仍使用原生菜单。
- 在 **插件 → dsh-t3code-sidebar** 中调整自动收起与工作区策略，并预览效果、查看最近变更。侧栏的**视图选项 → 侧栏设置…**可直达。

“稍后处理”和“已处理”只改变侧栏整理状态，不会停止任务、归档会话或删除内容。状态默认由 Host 持久化；Host 不可用时行为见[已知限制](docs/release.zh.md#5-已知限制release-notes-必须列出)。

## 开发

```sh
pnpm install --frozen-lockfile
pnpm run verify  # 类型检查、测试、构建、npm 包检查
pnpm pack
```

- `src/domain/`：状态、排序、时间和命令纯函数
- `src/contracts/`：共享 schema 与 Remote 契约
- `src/host/`：持久化、事件处理与调度
- `src/client/`：后端适配、视图模型和 React 界面
- `tests/`：单元、组件、集成与端到端测试

## 文档

- [文档索引](docs/README.zh.md)：设计、调研和验证材料入口
- [发行说明与支持矩阵](docs/release.zh.md)
- [CHANGELOG](CHANGELOG.md)

[MIT License](LICENSE)
