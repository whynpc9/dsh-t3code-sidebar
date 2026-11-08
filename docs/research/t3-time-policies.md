# T3 Code 定时状态策略

固定基线为官方仓库 main 提交 `a9e709f15f825cacac1b6d665fa1920c328d68b7`。以下是 Web/桌面及共享 Host 的源码结论，未启动应用或执行测试。按时间自动进入 **Settled** 有完整实现。按时间自动进入 **Archived** 在本次范围内没有找到实现。

## 自动进入 Settled

| 策略 | 参数与默认 | 起算与判断 |
| --- | --- | --- |
| 不活跃后结案 | `sidebarAutoSettleAfterDays` 默认 7，范围 1–90，`null` 关闭。契约是范围内的 Number，Web 输入另要求整数。关后重开恢复默认 7。 | Host UTC 时间；一天固定 24 小时。活动起点取最近 user-role 消息、最近 run 请求、开始、完成的最大时间，无活动用创建时间。静默 shell run 和 idle-compaction 消息从候选投影的活动源排除。再与手动唤醒记录及已到期的 Snooze deadline 取最大值。条件为严格早于 `now - days × 24h`，自动结案写入该活动/唤醒锚点作为 `settledAt`，不是实际执行时刻。 |
| PR 合并 | `sidebarAutoSettleOnMerge` 默认 true，独立开关。 | PR 的可信 `mergedAt` 不早于会话创建和最近真人用户发信的较晚值；缺失或无效时间不通过。符合时写活动锚点。后台消息和代办完成不刷新此真人锚点。 |
| PR 关闭 | 固定提交无单独关闭开关。关闭事件的判定不依赖 merge 开关。 | 用可信 `closedAt` 与同一真人锚点比较。全局和所有项目都没有开启 inactivity/merge 时，整个 worker 扫描提前退出，因此关闭事件也不处理。若任一作用域开启，判定函数仍允许 Closed，即使当前项目的 merge 与 inactivity 均 Off。 |
| 保留有 PR 的会话 | `sidebarAutoSettleKeepPullRequests` 默认 false。 | 跳过 inactivity；匹配的终态 PR 仍可结案。有未同步的显式 PR snapshot 时先不结案。存在有效 Open 链接时不从另一条终态 PR 结案。关闭/合并后才挂上的链接不作为等待的终态结果。 |
| 单会话覆盖 | 默认无覆盖。菜单 Auto-settle behavior → Disabled 写入 `autoSettleDisabledAt`，Enabled 清除。手动 Un-settle 写 `active` override。 | Disabled 或任意非空 override 排除自动候选。下一轮允许的 run 请求会清除 active/settled override，重新进入通常规则；设置变更本身不重开已结案会话。 |

Settings → Threads → Auto-settle 提供环境级共享设置，服务器按项目覆写解析。文档说明多环境可选择单个或 All environments，混合值和不支持共享设置的环境有独立行为。

[设置默认和边界](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/contracts/src/settings.ts#L88-L97) · [默认天数](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/contracts/src/settings.ts#L1330-L1340) · [PR 默认](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/contracts/src/settings.ts#L1360-L1365) · [整数输入](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/settings/SettingsPanels.tsx#L708-L745) · [设置面板](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/settings/SettingsPanels.tsx#L1661-L1758) · [官方多环境说明](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/docs/user/thread-sidebar.md#L183-L209) · [活动投影](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/ProjectionStore.ts#L6572-L6639) · [决策与全局门](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/ThreadSettlementService.ts#L80-L270)

**保护和文档漂移。** SQL 与应用候选均排除置顶、归档、现有 override、单线程停用。SQL 另排除删除、正在准备/启动/运行/等待、pending runtime request 及未被后续发信消解的等待链接卡。应用还排除访客消息、活动 run、阻塞完成的后台工作、有效 Snooze。用户消息还未被 run 接管时用两分钟保护窗，绝对时间差限制时钟偏斜；明确失败和过期的待接管消息不永久卡住候选。文档称置顶不阻止自动结案，固定提交的 SQL 和服务端判定均明确排除 pinned，应采用实现结论。手动 Settle 会移除 pin，与自动候选不同。

[固定提交用户文档](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/docs/user/thread-sidebar.md#L74-L80) · [SQL 保护](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/ProjectionStore.ts#L6608-L6639) · [应用保护和两分钟窗口](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/ThreadSettlementService.ts#L99-L193) · [手动写入和恢复](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/Orchestrator.ts#L3699-L3756) · [运行请求清 override](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/Orchestrator.ts#L5743-L5789)

**调度与收敛。** Host 启动先执行全量 sweep，完成后按 1 分钟间隔再次执行。设置变化提交全量 sweep，PR merge 触发另一路扫描。单会话收到 PR 链接变化/同步、run 终态、子任务/后台工作结束或 provider session 停止等事件时单独扫。同一会话只并行一个检查，运行期间的事件合并为再扫一次，槽位上限 8。重新读设置后构造 `thread.auto-settle`；执行时重查当前 override 和候选快照之后的写入。所有客户端断开不停止 Host worker；Host 停机时无扫描，重启从持久投影按当前 UTC 补算。没有为客户端重连另外派发自动结案的逻辑。网络、PR 查询或候选读取失败记日志，后续扫描重试；普通系统睡眠/断网的实际时延未实测。

[扫描、设置和派发](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/ThreadSettlementService.ts#L318-L373) · [PR 查找](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/ThreadSettlementService.ts#L421-L549) · [每线程合并队列](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/ThreadSettlementService.ts#L555-L597) · [启动/周期/事件](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/ThreadSettlementService.ts#L637-L721) · [提交前重查](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/Orchestrator.ts#L13386-L13415)

**结案副作用。** 手动与自动均走 Settle 命令。结案事件关闭符合规则的空闲终端和设有 stopOnSettle 的动作；仅存在独立 worktree 才触发 runOnSettle，异步检查后会重查仍处于 Settled，按会话和 settledAt 做进程内去重。文档另有空闲手动结案处理异步问题、保留终端输出的行为。它们是 T3 主机功能，不能由插件状态变化隐式触发。

[结案清理](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/ThreadSettlementService.ts#L599-L640) · [终端、脚本文档](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/docs/user/thread-sidebar.md#L162-L181)

## Snooze 到期与其他时间窗

- **普通 Snooze**。Host 存 `snoozedAt` 与 UTC `snoozedUntil`，验证晚于服务端当前时间，拒绝 pending 审批和普通用户待启动 run。默认预设为 60 分钟、180 分钟、今天 18:00、明天 09:00、下一个星期一 09:00，最多 8 项。相对预设为整数 1 分钟至 30 天，选择时重新起算。固定时刻从客户端本地日历算出，下一个星期几严格在今天之后，已过去的今日时刻隐藏。自定义接受本地日期/时间或相对分钟/小时/天，一天 24 小时，拒绝非法日期、DST 跳过时刻和过去时刻。 [预设契约](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/contracts/src/settings.ts#L99-L135) · [客户端时间计算](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/client-runtime/src/state/threadSettled.ts#L230-L386) · [服务端准入](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/Orchestrator.ts#L3616-L3666)
- **到期展示与提前醒来**。客户端分区按当前钟与 deadline 派生，Web 针对最近截止精确刷新，恢复后合并处理已经错过的多次 deadline。Host 在扫结案资格时独立评估有效性，普通定时到期可在 UI 显示 Woke 而无即时持久 Unsnooze 写入。手动 Wake 写 `lastSnoozeWakeAt`，过期 deadline 自身也进入下一轮 inactivity 锚点，使会话拥有完整的 inactivity 天数。新审批、较新的普通问答、子任务/访客待办或新失败可提前展示；用户发信可清掉 Snooze，自动通知/委托完成不清。早期由待办或失败派生的唤醒不应一律推断为已经写入 `lastSnoozeWakeAt`。 [有效 Snooze 与 Woke](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/client-runtime/src/state/threadSettled.ts#L82-L193) · [Web 到期计时](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.logic.ts#L129-L154) · [服务端到期与 inactivity 锚点](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/ThreadSettlementService.ts#L163-L250) · [手动唤醒写入](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/Orchestrator.ts#L3730-L3748)
- **限额时间窗**。上游还有独立的 Snooze until limits reset 和 Resume after usage limits，默认均关。前者以 provider 给出的可信 reset UTC 时刻停车；后者是真正的 agent 续跑，由 Host scheduler 管理，有独立动作和恢复保护。无 reset 不提供自动策略。这是 Snooze 的一种自动来源，续跑属于执行能力，应与侧栏定时放置分开。 [设置默认](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/contracts/src/settings.ts#L1333-L1340) · [用户行为](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/docs/user/thread-sidebar.md#L245-L268) · [服务端准入](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/Orchestrator.ts#L3595-L3615)

## 自动归档的证据边界

在该提交搜索了 `apps/server/src`、`apps/web/src`、`apps/mobile/src`、`packages/contracts/src` 和 `docs` 中的 auto archive、archive + after/inactive/days，以及 `thread.archive`、`thread.archived`、`archivedAt` 的命令、事件和状态写入路径。未发现按不活跃天数或 Settled 保留天数转入原生 Archived 的 settings、timer 或 worker。已定位的计时 sweep 派发 `thread.auto-settle`，该命令只转换为 `thread.settle`。独立的 `thread.archive` 设置 `archivedAt`，同时清标题生成和 guest share，停 PR watch。存储设置中出现的 inactive/settled retention 作用于 **worktree**，线程历史仍保留。结论限定于本次固定提交与这些路径。

[结案命令](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/Orchestrator.ts#L13386-L13415) · [归档写入](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/Orchestrator.ts#L3686-L3698) · [工作树 retention](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/docs/user/project-settings.md#L209-L238)

## 纳入 Harness 插件计划的建议

1. 首版在 Host 实现可配置 inactivity 自动 Settled，保留 7 天的建议值和 1–90 整数天范围，支持 Off、Workspace 覆盖和单会话禁用。锁定可读的活动来源后再决定默认是否启用，冷历史与未知事实不触发迁移。分开存起算锚点、实际变更时刻、触发原因及策略 revision，执行前重查 pin、归档、权限、pending、可信活动与当前策略。
2. 把 PR merge、close、Keep with PR 列为功能，等待宿主提供可信 PR 身份、终态与时间。推荐关闭和合并独立开关，用户关闭全部规则即完全停用。不要以分支名或提交文本猜测 PR 状态。
3. 保留 Host 定时 Snooze 的恢复与补算，使用持久 deadline 和幂等 receipt。唤醒后至少从确定的 wake 重新起算 inactivity。将 provider reset Snooze 列为依赖能力的可选项，独立于自动续跑。
4. 将按 Settled 保留期自动 Archived 标为 **插件增补**，默认 Off，仅当宿主支持可信归档、恢复、提交前重查和授权时开放。建议只允许已结案且持续无活动的会话进入，展示变更原因并提供恢复与本轮跳过策略。把自动归档和 worktree/终端/聊天清理分开。
