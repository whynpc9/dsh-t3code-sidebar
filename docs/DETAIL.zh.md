保留原生侧栏操作，按状态、工作区或单列表整理会话。

在下方调整侧栏显示、低峰时段稍后处理、自动收起与工作区策略；也可从侧栏的“视图选项 → 侧栏设置…”返回本页。“低峰时段稍后处理”默认开启，设置按浏览器保存。

DeepSeek 高峰时段内，“稍后处理 → 至低峰时段”会把未在运行工作的会话隐藏到半价的低峰时段开始；不会发送任何 prompt、创建自动化任务或暂停 agent。对使用 Host 后端和 Harness 定时任务服务的已知空闲会话，“低峰时段继续…”还会创建一次性 **Off-peak resume** 任务（显示在“自动化任务”中），届时发送你编辑的消息（默认为“继续。”）。投递前可通过“立即返回并取消自动继续”或“标为已处理”取消；Harness 投递时 Host 必须运行。

下方设置会显示你所在时区的高峰时间，并链接到 [DeepSeek 价格说明](https://api-docs.deepseek.com/quick_start/pricing)。中国法定节假日数据来自 [holiday-cn](https://github.com/NateScarlet/holiday-cn)（MIT），覆盖 2026–2027 年，可用 `pnpm run holidays:update <年份>` 更新；其他年份按普通工作日处理。
