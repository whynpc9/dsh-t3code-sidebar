# U07 桌面验收 · 2026-11-14

被测 `main` 提交为 `8a5b3241a3af79d2ca07c4004a7604874cc9760e`，插件版本 `0.1.0-alpha.2`。Desktop 为 DeepSeek Harness `0.2.2-rc.2` 官方签名副本，macOS 26.6.2。配套 CLI 安装的 tarball SHA256 为 `ee5e1acd48696faa9aa0288194ed6137946489db8cb523dbb9328509c11efcc0`，安装后的两个入口与该提交重建结果一致。使用独立 `DSH_HOME`、Electron 用户数据、合成工作区和本地模型桩。实际 GUI 由 `gpt-6.1-terra`（High）通过 Computer Use 操作，焦点从实际桌面无障碍状态读取。

| 场景 | 结果 |
| --- | --- |
| ⌘K / ⌘O | 分别聚焦 `Search session names` 和添加工作区对话框的 `Folder path on the host`。Tab 从搜索框到 `Clear search`，Shift+Tab 返回。 |
| 键盘列表导航 | Tab 到视图选项、添加工作区和 Active 组。方向键、Home、End 在行间移动，左右键折叠和展开。Enter 打开另一测试会话并把焦点交到输入框。 |
| 会话菜单 | 从行按 Tab 到会话操作，Return 打开菜单，向下到 Snooze，向右进入子菜单。两次 Escape 分别回到 Snooze 和原会话操作按钮。 |
| A08 筛选当前项 | 排除当前项的搜索显示无结果，未出现「定位当前会话」操作。Escape 清除搜索并恢复当前选中行，焦点停留在搜索框。当前项定位入口缺失。会话重排序时的焦点和菜单行为尚待验证。 |
| 折叠栏 | 折叠到窄栏后按 ⌘K，侧栏重新展开，搜索框获得焦点。 |
| 减少动态效果 | 在隔离 Desktop 的 DevTools Rendering 模拟 `prefers-reduced-motion: reduce`，在 725 × 820 CSS 像素视口下按 ⌘K 展开侧栏并聚焦搜索，输入后得到两条结果。模拟设置已恢复为 No emulation。覆盖了交互可用性，实际动画变化和窄窗口的完整布局尚待验证。 |
| VoiceOver | 在系统设置确认原状态为关闭，临时开启并尝试观察侧栏的播报字幕。无障碍状态显示了列表、当前项和控件名称，未取得可核对的字幕或语音记录。系统开关已恢复并确认关闭。读屏播报待验收。 |

同一提交的 `pnpm run verify` 通过，含类型检查、237 项测试、构建和打包检查。

## 补上定位后的复验

复验使用同版本的签名 Desktop 和独立 profile。最终候选包 SHA256 为 `444fb045502fb013f827c7f0df7a35a20d28c056cef42a1094f7bbc811091552`，安装后的 Client SHA256 为 `0a7586ac7c02d89db16bcba8d04fab72e3d9a7552cb50b99b8b6eb1bb87fda97`。仍由 `gpt-6.1-terra`（High）通过 Computer Use 验证。按用户要求，本轮跳过 VoiceOver。

| 场景 | 结果 |
| --- | --- |
| 搜索排除当前会话 | ⌘K 输入不匹配的词，Tab 到「Locate current session」后按 Return。搜索清空，原会话行同时为选中和聚焦，聊天内容不变。最终候选包复验通过。 |
| 归档筛选、工作区折叠 | 首个定位构建验证了「仅归档」排除当前会话及其工作区折叠的路径。定位后显示并聚焦当前行。定位相关代码与最终候选包一致。 |
| 自定义 Snooze | 首轮在菜单打开「Custom time…」后按 Escape，焦点落到页面根节点。修复后重复操作，焦点回到同一会话的 Session actions 按钮。 |
| 活动改变列表顺序 | Beta 会话菜单打开时，通过隔离 Host 给 Alpha 发送本地模拟请求。Alpha 从 Active 进入 Working，Beta 成为 Active 第一行。菜单留在打开位置，焦点留在 Pin session，当前聊天仍是 Beta。Escape 后焦点回到 Beta 的会话操作按钮。 |
| 窄窗口 | 首个定位构建实际缩窄到约 727 CSS 像素。⌘K 展开抽屉，Locate 和菜单在检查的布局中可见，无明显裁切，定位后会话行获得焦点。 |
| 减少动态效果 | 最终候选包中，DevTools 计算样式显示正常模式的侧栏淡入启用，搜索过渡为 0.18 秒。模拟 `reduce` 后，两处的动画名为 `none`，过渡时长为 0 秒。已恢复 No emulation。 |

`pnpm run verify` 通过 241 项测试、类型检查、构建及打包检查。回归测试覆盖搜索与归档筛选定位、折叠工作区、分页阈值之后的当前行，以及关闭自定义 Snooze 后的焦点。

本轮未抽验深色主题、中文界面、200% 缩放及完整的窄屏布局矩阵。减少动态效果的证据来自实际计算样式，未录制动画时序。
