# Sidebar 时间策略 Spec

版本：Draft 0.1 · 2026-11-08。本文件定义按指定时间窗口自动转移会话状态的功能、参数、保护条件与交付阶段，是时间规则的权威规格。

## 0. 实现状态（C01 回写，2026-11-12，`0.1.0-alpha.2`）

契约以 `src/contracts/schema.ts` 为准（摘要见[实现 Spec §4.0/§5.0](implementation-spec.md#40-契约-v1c01-冻结2026-11-12)）。本文其余部分仍是规则的权威描述；下表记录 v0.1 实际落地的范围与取舍。

| 规则 | 状态 | 实现 |
| --- | --- | --- |
| 不活跃自动 Settled（§3） | 已实现 | 默认 7 天（Host 侧事实已证实，未降级为默认 Off）；1–90 天或关闭；首次安装完整宽限 |
| 作用域 Host 默认 → Workspace → Session（§2） | 已实现 | `TimePolicy.workspaceOverrides`：缺省=继承，`{mode:'off'}`，`{mode:'custom',days}`；Session 菜单“此会话不自动收起 / 跟随项目” |
| 多 membership 与 `policyWorkspaceId`（§2） | 不需要 | Harness 0.2.2-rc.1 中会话 membership 要求 header cwd 等于工作区唯一的规范路径，一个会话至多属于一个工作区；因此不存储 `policyWorkspaceId`。若上游改为允许多 membership，应恢复此字段 |
| 宽限范围（§2） | 已实现 | Host 默认变严（开启/缩短）→ 仅跟随默认的会话（`global.policyEligibleSince`）；某工作区有效窗口变严 → 仅其成员（`workspaceEligibleSince`）；会话因工作区增删而换规则 → 该会话（`sessionEligibleSince`，由每次 sweep 比较 `membership`）；关闭保留选项 → 全部 |
| `effectivePolicyIdentity` / `eligibilityEpoch` | 以规则身份字符串替代 | `effectivePolicy().identity`（如 `host:7`、`workspace:<id>:off`）；身份变化即视为作用域变化 |
| 保留未确认结果/失败（§3） | 已实现 | `keepUnacknowledgedResults`、`keepUnacknowledgedFailures`；异常结果 = completed/aborted 以外的结束原因（error、blocked、max-tokens、interrupted、未知） |
| 保留选项下的历史结果 | 已实现 | 开启任一保留选项时，结果可能早于本进程（安装前、Host 半边未运行期间）的超期候选，先在后台只读重放其存储日志，补齐最新结果后再判定；补齐前或日志不可读时跳过（`result-unknown`），不会假定没有结果，也不以摘要中可能已过时的结果判定；某次事件折叠写入失败后，在重放成功前一直视为未知 |
| 成员关系不可读 | 已实现 | 存在 Workspace 覆盖而注册表读取失败时，生效规则未知，跳过（`scope-unknown`），不回落到 Host 默认 |
| `acknowledgeResult(token)` | 已实现为命令 | `command` 的 `acknowledge-result{turnEndSeq}`，写 `TaskRecord.resultAcknowledgedSeq`（单调，只能确认已折叠的结果）；与浏览器个人已读分离；行菜单“确认此结果”，设置预览“全部确认” |
| `previewPolicy`（§7） | 已实现 | 不写入；可预览未保存草稿（含保存后将启动的宽限）：一分钟内到期数、下一期限、跳过原因、被保留的结果 |
| “应用于已存在的超期会话”的显式追溯 | 未实现 | 预览只展示；变严一律给宽限 |
| 自动 Archived、PR、限额（§5、§6） | 未实现（v0.2/v0.3） | 字段未进入 schema |

## 1. T3 Code 对照与交付范围

已核对固定源码的[完整时间策略证据](research/t3-time-policies.md)，以下不能混为一套“自动归档”。

| 机制 | T3 固定版本事实 | 本插件计划 |
| --- | --- | --- |
| 不活跃自动 Settled | 默认 7 天，1–90 天或关闭 | **v0.1 必须**，默认 7 天预设、可关闭；首次安装已有历史获得完整宽限 |
| 作用域与豁免 | 环境/项目设置、单会话 disabled、Un-settle 保护 | **v0.1 必须**，Host 默认→Workspace 覆盖→Session 豁免 |
| Snooze 时间到期 | 相对/日历时间、精准 deadline、唤醒重置不活跃锚点 | **v0.1 必须**，Host 到期补算与幂等持久转换 |
| Working 结束缓冲 | 约 2 秒，无需操作时避免快速闪跳 | **v0.1** 最多 500 ms UI 合并，紧急信号零延迟；不影响持久状态 |
| PR 合并/关闭 Settled | merge 默认开；close 有全局 worker 门与局部设置差异 | **v0.3**，merge/close 分别显式开关；关闭全规则必须完全停止 |
| Keep threads with a PR | 默认关，只挡不活跃规则 | **v0.3**，依赖可信 PR provider；未知 PR 状态不自动结案 |
| 限额重置 Snooze | 默认关，使用 provider reset UTC | **v0.3 可选能力**，可信 resetAt 才可启用 |
| 限额恢复后自动续跑 | 与 Snooze 独立，默认关 | 记录为后续可选集成；只有宿主已有显式续跑服务才接入，不自行发 prompt |
| 按时自动 Archived | 本次固定范围未发现 | **v0.2 插件增补**，默认关；先候选预览，原子保护门槛通过后才提供自动执行 |
| Settled 后 worktree/终端清理 | 有独立策略/动作 | 不纳入 Sidebar 自动迁移，不因转区而删除/停止任何资源 |

T3 源码对 pinned 的自动候选检查排除置顶，而用户文档仍称置顶不保护；采用源码结论。T3 `settledAt` 可回填到历史活动锚点，本插件分别保存锚点和真正进入 Settled 的时间，避免未来自动归档“刚结案就被归档”。

## 2. 配置契约

以下为新增持久配置，配置动作 owner-only，version/CAS 与任务元数据同一服务管理：

```ts
interface TimePolicy {
  revision: number;
  autoSettleAfterDays: number | null; // 默认 7；整数 1..90；null 关闭
  keepUnacknowledgedResults: boolean; // 默认 false，可开启额外保护
  keepUnacknowledgedFailures: boolean; // 默认 false，可开启额外保护
  keepScheduledSessions: boolean; // v0.1 固定 true
  autoArchiveAfterSettledDays: number | null; // 默认 null；规划整数 1..365
  autoSettleOnPrMerged: boolean; // 默认 false，provider 验证后才显示
  autoSettleOnPrClosed: boolean; // 默认 false，独立开关
  keepOpenPrSessions: boolean; // 默认 true，能力启用时生效
  snoozeUntilLimitReset: boolean; // 默认 false
}
```

设置 UI 展示有效值、继承来源、开关、天数、保护条件和候选数量。Workspace override 用“继承 / 自定义 / 关闭”，不能以 null 同时表示关闭和继承。Session 菜单提供“自动收起：跟随项目 / 禁用”；自动归档另有独立豁免。无可信 PR/限额 provider 时显示能力未提供，不让勾选一个不起作用的设置。

默认自动 Settled 不影响当前运行任务，初装历史采用第 3 节宽限，不立即批量收起。开启自动归档必须在产品设置中明确选择并看到候选预览，开关默认关闭。此处是未来产品行为规格，本次没有改动任何实际会话或自动化。

作用域解析：单一显式 Workspace membership 使用其覆盖，无归属使用 Host 默认；多个 membership 时使用持久 `policyWorkspaceId`，未选择则用 Host 默认并提示来源，不能依赖项目排序决定政策。每会话持久保存 effectivePolicyIdentity、eligibilityEpoch、policyEligibleSince。迁移项目、项目删除、解除会话禁用、有效时限缩短/重启用时只重置受影响会话的宽限；重启、刷新、无关设置和项目排序不重置。旧 timer/preview 绑定该 epoch，作用域变化使其失效。

## 3. 自动 Settled 的时钟、锚点与保护

一天是 `24*60*60*1000` ms，不是跨一个自然日；Host UTC 为比较基准。日历时间只用于 Snooze 输入，记录 UTC deadline 和用于显示的时区。不能用浏览器挂载时刻、读取缓存时间或每个 token 的 updatedAt 代替活动。

新增 `ActivityFacts` 包含 `createdAt`、最近真人输入、最近已接受输入/排队请求、turn start/end 的可信时间和稳定 token；“请求已接受但尚未 turn/start”也会阻止自动收起。有公开 queue 状态则直接使用；缺少时以输入水位和最长两分钟的待接管保护辅助判断，但未知正在排队的状态仍应跳过，不能两分钟后强行当空闲。

```text
activityAnchor = max(createdAt, lastUserInputAt, lastAcceptedInputAt,
                     lastTurnStartedAt, lastTurnEndedAt)
inactivityAnchor = max(activityAnchor, lastSnoozeWakeAt, expiredSnoozeDeadline)
effectiveAnchor = max(inactivityAnchor, policyEligibleSince)
deadline = effectiveAnchor + autoSettleAfterDays * 24h
eligible by time = now > deadline
```

缺失可比较的字段不得任意补 `now` 后宣称可信；将事实状态标记 rebuilding。首次安装/首次纳入此策略的旧会话，明确设置 `policyEligibleSince=规则启用/首次建立可信基线时间`，给完整窗口。缩短规则或从关闭重新启用也建立新宽限，设置预览可另选“应用于已存在的超期会话”，这是显式配置动作。规则变更不自动打开已 Settled 的任务。

候选须同时满足：顶层非空白 Session、未归档、未置顶、当前 normal、无有效 Snooze、未禁用规则、无 reopen hold、运行/子任务/待交互均已知且无活动、无待接管输入、无受保护的后台工作或有效计划任务；启用相应保留设置时，还必须无未确认失败/新结果。Host 能力不完整、格式迁移待处理、cache stale、连接不可用时只跳过并报告，不推测无活动。

与 T3 的按不活跃自动整理接近，首版默认不要求先阅读或确认旧结果；成功、取消、已结束的失败可以在满足全部条件并超时后收起。已结束的 blocked/max-tokens/interrupted 归入异常结果，可通过保留未确认失败选项保护；未知 reason、没有可证明终态且可能仍排队的非空白会话不能自动收起。首装旧的已知终态按完整宽限进入策略，不会因为没有 ack 而永久停留。

开启保留选项后，未确认历史结果继续受保护，用户可在行菜单“确认此结果”或候选预览中显式批量确认；关闭保留选项后按新的策略宽限计算。“确认结果”是独立 owner 共享动作 `acknowledgeResult(token)`；单纯打开聊天只更新本浏览器已读。自动规则的保护以共享确认 token 为准，避免另一窗口读过就意外收起。若是完全没有结果的历史草稿，按产品空白过滤规则处理，不做自动 Settled。

成功写入保存：`reason=idle-timeout`、`policyRevision`、`activityAnchorAt`、`effectiveDeadline`、`settledEnteredAt=实际提交UTC`、`resultToken`、`recordRevision`。人手标记则 reason=manual。UI tooltip 显示“因 N 天无活动于某时自动收起”，提供重新打开与本会话禁用。

手动 reopen 写 `autoSettleHold=until-next-meaningful-activity`；仅新输入或新运行 token 清除此 hold，轮询、读取、改标题、修改排序或策略变更不清。Snooze 到期/手动唤醒会写 wake 时间，自动 Settled 至少从该时间重新计算完整窗口。提前因新请求醒来时也记录对应事件身份，后续处理完成再更新活动锚点。

## 4. Snooze 预设和时间恢复

默认预设扩充为与 T3 近似：1 小时、3 小时、今天 18:00、明天 09:00、下周一 09:00；支持自定义，最多 8 个用户预设。相对时长为 1 分钟至 30 天整数分钟；绝对日期上限默认 90 天。已过去的今天选项隐藏；DST 不存在时刻拒绝输入，重复时刻明确显示偏移供选择。请求最终须由 Host 检查 `until > serverNow`。

到期归属按当前可信状态决定：无待处理且仍执行 → Working；否则 Active；置顶仍 Pinned。浏览器关闭不阻断调度，Host 停止则在下一次启动补算。清除停车与写 wake 时间在一个插件事务内完成。普通成功完成不提前唤醒；新的审批/输入/错误和用户新输入按产品规则处理，不能仅因后台自动 turn/start 把 Snooze 清除。

归档状态优先：已归档期间不执行其停车迁移，恢复后一次重算期限和新活动，同时建立自动规则宽限，避免恢复即再次自动收起。

## 5. 自动归档的增补设计与阻塞条件

规划规则：持续 Settled 满 N 天后进入原生 Archived，N=1..365，默认关闭，预设 30 天。手动和自动 Settled 可纳入，设置分别提供包含开关，默认两者都可选但主规则仍 Off。计时从 `max(settledEnteredAt, archivePolicyEligibleSince)` 开始，不能使用回填的 activityAnchor。重新打开、新活动、置顶、未解决交互使候选失效；恢复归档后加 hold，必须新活动或明确重新加入规则才再评估。

当前 `ctx.workspaceRegistry.archiveSession(id, {stopActivity:false})` 可供用户确认后的原生归档使用；自动执行须改用通过 G-ARCHIVE 验证的原生条件提交接口，并保持 stopActivity=false。原生活动检查拒绝时跳过、记录原因并退避，绝不自动改成 stopActivity true。规则不关闭终端、不停调度、不删目录或聊天文件。

**G-ARCHIVE 门槛：当前公开方法没有“仍未置顶/仍为该版本才归档”的原子条件。** 在插件预检后，另一个原生窗口可以 Pin，原生 archive 随后会清掉 pin。仅再次读一次或插件自己的队列不能消除此竞态。因此 v0.2 先交付归档候选列表和手动原生归档；仅在验证可用公共原子 guard 或上游提供 compare-and-archive 后，才开放自动执行。此门槛未过不应宣称自动 Archived 已完成，也不暗中修改 Harness。

门槛通过后的命令协议：保存 intent（Session incarnation、settled revision、policy revision、expected native state）→ 带条件原生归档 → 读回原生归档集合 → 记录结果。恢复时以原生为权威，不盲重发已取消 intent；用户后来手动恢复不可沿旧 intent 再归档。跨原生存储和插件 domain 是恢复协议，不宣称同一事务。

## 6. PR 与限额依赖阶段

PR provider 需给出 repository identity、PR ID、open/merged/closed、可信 terminalAt、linkedAt 和更新水位。合并/关闭时间必须不早于最近真人输入和创建时间；存在未知 snapshot 或仍 open 的关联 PR 时不根据其他终态 PR 收起。默认保留 open PR，终态触发仍需满足运行/交互/置顶等保护条件。merge/close 分别开关；关闭全部规则就停止 worker 对这些动作的派发，不复制上游 Closed 的作用域差异。

provider reset Snooze 仅消费宿主已提供的可信 `resetAt`，不从报错文本猜时间。未来接入“重置后续跑”必须是独立功能开关与宿主执行服务，明确预览会发起的新工作；不能由单纯移出 Snoozed 隐式启动模型调用。没有能力时保留手动恢复。

## 7. 调度、配置和审计 API

扩展新增 Remote：`getPolicy/setPolicy`（含 expectedRevision）、`previewPolicy`（不写）、`setSessionPolicyOverride`、`acknowledgeResult`、`listTransitions`。返回值包括 effective policy/source、下一次检查时间、被跳过原因。每个状态迁移记录 ID、原因、锚点、deadline、触发时间、策略版本、前后分区，最近 1000 条或 90 天上限；不记录正文。上限清理只针对插件审计，不影响会话。

共用单一 Host 策略调度器：最近 deadline timer + 60 秒兜底 sweep + 启动/系统恢复/配置变更/新活动后的合并事件检查。Snooze 精确到期，auto-settle 容许一个 sweep 周期的延迟。60 秒 sweep 只遍历到期索引和已有摘要，不每分钟冷读全库。Host queue、全部直接子任务及 jobs/schedules 的可验证性属于 G0-C/M3 门槛，可探索公开 workspace/session-activity 与 agent inbox 能力；无 provider 与已知空状态必须分开，能力缺失的会话跳过并显示原因，不能宣称全量规则已生效。单 Host writer；一个会话同时最多一个评估，全局评估并发 2，最终写入进入统一串行队列。读或验证失败指数退避，事件变化可提前重试。

执行前再次比较策略 revision、Session incarnation、record revision 和事实 token，任意变化重算。幂等 key 包含 rule/session/incarnation/anchorToken/policyRevision。策略关闭撤销尚未提交的 intents，已提交动作不静默反向执行。自动 Settled 并发新 turn 到来时，提交处核对当前 token；迟到新事件按状态机重新打开，不能丢新任务。自动归档必须走上节条件命令门槛。

## 8. 时间策略验收

| 编号 | 用例 | 预期 |
| --- | --- | --- |
| T01 | 7 天边界前、恰好边界、边界之后 | 仅严格超过 deadline 后自动 Settled，一次迁移 |
| T02 | 关闭、项目继承/覆盖、Session disabled | 有效值清晰；关闭范围无自动迁移 |
| T03 | pinned/运行/子任务/审批/输入/计划任务/unknown | 每种保护均跳过，理由可见 |
| T04 | Snooze 到期，紧接自动扫描 | 先唤醒，重新给完整 inactivity 窗口 |
| T05 | 手动 reopen 后重复 sweep | hold 生效；新输入后才回普通规则 |
| T06 | Host 离线跨 deadline，重启；浏览器全关 | Host 恢复后补算，无重复；无需浏览器在线 |
| T07 | 初装大量旧记录、缩短/重新启用规则 | 默认给宽限；预览与显式追溯范围一致 |
| T08 | 配置关闭与到期命令并发、新输入迟到 | 旧策略/旧事实命令拒绝，结果收敛 |
| T09 | 自动 Settled 与已确认/未确认结果或失败 | 默认超期可收起；保留选项开启才拦未确认，个人已读不代替共享确认 |
| T10 | 归档 30 天从真实进入 Settled 计时 | 不因锚点回填立即归档；原生活动拒绝永不强停 |
| T11 | autoarchive 预检后另一窗口 Pin、或手工 unarchive | 条件提交保护；门槛未过仅候选预览 |
| T12 | PR时间、未知PR、provider reset缺失、DST、时钟跳变 | 不猜测，保护生效；不隐式续跑 |

T01–T09 为 v0.1 必须；T10–T11 为 v0.2 门槛和交付检查；T12 的日历/时钟部分首版执行，PR/provider 部分在能力阶段执行。
