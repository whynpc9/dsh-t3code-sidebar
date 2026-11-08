# DeepSeek Harness T3 Sidebar 开发计划

版本：2026-11-08。任务分区为默认和首要交付；同一 v0.1 包含项目视图切换及可配置的时间窗口自动 Settled。本文是待执行计划，未完成项不能作为已验证能力宣传。

## 1. 输入、交付物和工作方式

输入为[产品规格](product-spec.md)、[实现 Spec](implementation-spec.md)、[时间策略 Spec](time-policy-spec.md)及[固定上游调研](research/README.md)。第一阶段不是画完整 UI，而是交付能独立安装、调用公开 API、撤销覆盖的最小包，验证架构成立。

v0.1 交付预构建 npm tarball、源代码、锁文件、双语安装/恢复说明、支持版本矩阵、测试报告、GUI 证据及 CHANGELOG。Registry/GitHub 正式发布是实现后的单独发布动作；本次任务只交付规划文档，不发布或初始化远程仓库。

开发前建立 Git 仓库和包骨架，分支按里程碑；各 PR 附关联 F/A/T 编号、实际变化、验证和兼容边界。每阶段合并须可安装、可停用，不能只保持 monorepo 内 link 可用。

## 2. 阶段与估算

按一名熟悉 TypeScript/React 的开发者、独立 review/QA 可并行估算；不含宿主缺失 API 的上游等待时间。P0 后重估。

| 阶段 | 任务 | 依赖 | 工作日估算 | 阶段出口 |
| --- | --- | --- | --- | --- |
| M0 | 外部插件可行性与兼容基线 | 无 | 3–5 | G0-A/B/C/D 全过，明确安装运行版本 |
| M1 | domain / state / storage /协议骨架 | M0 | 3–5 | 分区与并发状态契约通过，Host 重启读回 |
| M2 | 默认任务视图与原生动作 | M1 | 5–7 | 五分区、搜索、导航、Snooze/手动 Settled 可安装演示 |
| M3 | 时间策略与自动 Settled | M1，可与 M2 后半并行 | 4–6 | 7天配置、继承/禁用/恢复补算、T01–T09 通过 |
| M4 | 项目视图和完整交互 | M2/M3 | 3–5 | 双视图同状态、项目管理、键盘/主题/窄屏 |
| M5 | 稳定性、性能、平台验收与预览发行 | M4 | 5–7 | v0.1 完成定义全部有证据 |

合计 23–35 个开发工作日，约 5–7 周；外部 Remote/构建或冷状态能力出现缺口时另加修复时间，不能用固定日期代替技术门槛。第二名开发者可以承担 M2/M4 界面与测试；领域模型/协议需先由一个 owner 定稿，减少相互改契约。

## 3. M0 的四个强制验证门

| 门槛 | 要做的具体实验 | 通过证据 | 不通过时的处理 |
| --- | --- | --- | --- |
| G0-A 槽位与打包 | 单独目录构建 `.tgz`；官方 CLI 装进新 profile；覆盖 sidebar.workspaces；保留 ui-workspace；停用/卸载 | 仅一个赢家；菜单/设置/新会话正常；原生恢复；产物无第二 React | 修自身构建/适配；不要复制内部组件或改宿主安装文件 |
| G0-B 自有 Remote | Host service+生成 codecs/descriptors+client mount；owner 请求与 guest 拒绝；断线重连 | 已发行 runtime 无需重编译就能使用新 namespace；两窗口看到同状态 | 若无外部挂载能力，记录最小上游接口需求并修订架构；不以 localStorage 模拟“Host 持久化已完成” |
| G0-C 事实与冷恢复 | 未打开会话、冷缓存缺项、权限问答、输入队列、子任务、jobs/schedules、fork、正常/失败/取消/修复；小投影；公开 projections 读取 | 能证明控制/摘要支持矩阵、稳定 token、读成本；自有 Remote 可承载窄投影 | 不支持的信号标 unknown；影响首版自动/Snooze 正确性时阻塞该发布，不凭 UI 字符猜测 |
| G0-D 生命周期与平台 | Web 独立 profile、Desktop 测试环境、目录 chooser/远程浏览/缺失能力、快捷键冲突、HMR 重入 | 原生服务保留且动作实际有效；停用无泄漏；Desktop 独立记录 | 可先发行明确标注的 Web preview；不能据共享 Web 源码宣称 Desktop 已通过 |

新增 autoarchive 门槛 G-ARCHIVE 在 v0.2：证明“仍未 pin、仍属于同一 Settled revision、无活动”能在原生归档提交处原子验证。当前接口没有这个完整条件，先做候选提示，详见时间 Spec。

M0 证据保存 `docs/validation/poc/`：runtime/version.json、pack-contents、脱敏配置、接口能力矩阵、测试输出与截图。开发环境独立 DSH_HOME，不读取用户历史或凭据作为测试数据。

## 4. 可分派实现任务

| ID | 具体工作及交付 | 前置 | 验收 |
| --- | --- | --- | --- |
| B01 | TS 项目、lint/typecheck/test/build/pack 脚本；包 exports/peers | G0-A | 干净目录从 tgz 安装，运行面模块实例正确 |
| B02 | 公共 Host/Client adapters 与能力探测；固定版本快照 | G0-B/C | 缺能力行为可见，禁止私有 import |
| D01 | Placement/status/sort/reconcile 纯函数；reason/token 模型 | B02 | 所有互斥/优先组合、当前轮与历史结果测试 |
| D02 | Storage domain、schema version、command queue、CAS、receipt | D01 | 断电式失败、重复命令、过期receipt、ABA 保护 |
| D03 | Host 小投影、冷基线读取、截点/代次比较 | B02 | 不 retain 全列表；fork/迟到 cold read 不误唤醒 |
| D04 | typed Remote baseline/delta、鉴权、连接代次 | D02/D03 | 两窗口一致、断档重建、guest 拒绝、撤权移除 |
| U01 | 单 slot、双视图容器、normalized store、主题/locale | B01/D04 | 服务/注册清理完整，默认任务视图 |
| U02 | 五分区、行状态、折叠/分页/当前项定位 | U01/D01 | A01/A02/A08；无重复行、无 token 排序抖动 |
| U03 | 原生会话菜单、创建/重命名/pin/archive/restore | U02 | A09；归档拒绝/确认准确、无隐式强停 |
| U04 | Snooze/立即返回/Settle/reopen、自有 dialogs | U02/D02 | A03–A06；运行中 Snooze 与 Settled 准入区分 |
| U05 | 搜索+项目筛选+未分组+范围外当前项 | U02 | A07/A08，hasMore、取消和迟到结果测试 |
| P01 | Host/Workspace policy 与 Session override 配置 | D02 | 值校验、继承、关闭语义、policy revision |
| P02 | 单 timer+兜底 sweep+事件队列，Snooze 到期补算 | D03/P01 | T04/T06/T08，时钟跳变/停机恢复 |
| P03 | inactivity锚点、7天默认、宽限、reopen hold、保护条件 | P02 | T01–T09，实际 settledEnteredAt 与活动锚点分离 |
| P04 | 设置面板、策略预览、迁移原因、结果确认与审计 | P01/P03/U01 | 用户可看下一期限和跳过原因；关闭后无新动作 |
| U06 | 完整项目视图、Workspace dialogs、目录选择器 | U03/U05 | 不复用私有 browser；两视图状态一致 |
| U07 | keyboard/读屏/窄屏/reduced-motion | U02/U06 | 全操作可不用鼠标，焦点/列表语义正确 |
| Q01 | fixture Host、contract/component/e2e、时间 fake clock | 自 M1 持续 | A/T追溯表自动生成或维护，无实际等7天 |
| Q02 | 5000会话、50运行压力、渲染计数/内存/冷读预算 | U07/P03 | Spec性能预算与限制有证据 |
| Q03 | 安装/升级/回退/卸载/冲突故障测试 | 全部 | 旧数据保护、原生可恢复，20次启停无增长 |
| R01 | 版本矩阵、安装文档、license/notice、发行说明 | Q01–Q03 | 使用者能从空环境复现，支持范围真实 |

## 5. 自动状态迁移的后续功能

| ID | 版本 | 实现内容 | 依赖与出口 |
| --- | --- | --- | --- |
| P05 | v0.2 | Settled N天归档候选、原因、跳过/豁免、恢复 hold | 不要求原子归档能力，可独立交付预览 |
| P06 | v0.2 条件项 | 可配置自动 Archived（默认 Off） | G-ARCHIVE 通过；条件提交+intent恢复+不强停，T10/T11 |
| P07 | v0.3 | PR merge/close 各自触发 Settled、Keep PR | 可信身份/时间/多PR状态；全部关闭真停，T12 |
| P08 | v0.3 | provider reset Snooze 与可选续跑集成 | resetAt公开能力；续跑必须独立宿主服务和开关 |
| U08 | v0.2 | DnD、手动排序、批量操作、Undo | 完全通过菜单等价流程后再加；并发/排序确认不丢行 |
| U09 | v0.3 | Git/PR装饰与第三方row适配 | 不能跨原slot渲染授权，不引入worktree清理 |

P06 若仍缺原子能力，release notes 只宣称“自动归档候选”，并列明条件执行未完成。P07/P08 无数据能力时隐藏不可用执行选项，不能凭推测的PR/限额信息驱动迁移。

## 6. 验证矩阵和执行责任

| 层 | 样本/环境 | 必验内容 |
| --- | --- | --- |
| 领域层 | 确定性合成状态和 fake clocks | 分区、旧/新事件、边界时间、Hold、规则继承、保护条件 |
| Host层 | 隔离存储、受控失败、同Host多Client | CAS、收据、迁移、掉线回执、baseline缺口、权限 |
| 集成层 | 实际安装包、固定Harness版本 | 装配、Remote生成、真实投影、原生动作读回 |
| GUI层 | Web Chromium、macOS Desktop；中/英、亮/暗、窄/宽 | A01/A02/A08/A11/A12、策略设置及T04/T07，实际截图与步骤 |
| 规模层 | 100项目/5000会话/50活跃 | 首屏、搜索、渲染更新、20次启停、无全历史retain |
| 发行层 | 空profile安装、旧plugin schema升级、卸载 | tarball完整性、版本拒绝、回退和配置隔离 |

GUI 验证遵守本项目指示：开始验证时解析当前主机最新正式 Terra，显式完整 model ID、High、fork_turns=none，并告知实际模型；同一 UI 同时只给一位验证代理。当前规划阶段没有启动 GUI 验证，不能把静态源码审查写成操作通过。

测试可使用 fixture provider，不需要真实付费 LLM 调用即可验证大多数状态；少量真实运行验证需配置测试环境时单列。测试中的权限、日志和时间策略不能复用生产会话作为可变样本。

## 7. 风险与收敛措施

| 风险 | 概率/影响判断 | 处理与触发条件 |
| --- | --- | --- |
| 预览版 API 漂移 | 高/高 | pinned baseline，adapter隔离，升级先跑G0与contract tests |
| 外部client构建preset未发布 | 已确认/高 | 自己维护最小wrapper，不把仓库内preset当npm依赖 |
| 外部Remote或新投影codec缺口 | 未验证/高 | G0-B/C先证，独立Remote携带事实，不改内置API |
| 冷会话缺缓存或回折代价高 | 已确认可能/高 | unknown明确、有界预算、按需补齐，不无界后台扫描 |
| 隐藏原组件导致快捷键/弹窗失效 | 已确认边界/中高 | 自有流程，公共服务复用；G0-D真实点击 |
| 原生Pin与插件停车不同存储 | 已确认/中 | Pin仅遮蔽，避免跨库清状态；autoarchive原子门槛 |
| 规则误收起待处理任务 | 中/高 | 保护状态、token去重、可配置关闭/hold、原因和恢复 |
| 初装旧历史大批自动迁移 | 中/中高 | 默认完整宽限；仅显式追溯设置才处理旧超期项 |
| 两个替换插件争槽 | 中/中 | 冲突诊断和可配priority，不抢改他方注册 |
| 估时受平台/上游缺口影响 | 中高/中 | M0后重估，分清Web preview和完整v0.1 |

## 8. 发布验收与回滚

v0.1 需要 F01–F11、A01–A12、T01–T09 及 T12 的通用时间部分通过；v0.2/v0.3 的 T10/T11/能力型T12按版本追踪。每个用例记录 fixture版本、运行时版本、结果与证据，失败项不能以文档审查代替。

发布前检查：无源码私有路径依赖；Host与Client产物齐全；peer/engines范围经过安装；储存升级可逆；停用不删数据；读取未知schema不覆写；许可/来源声明；没有未授权消息发送/模型任务/资源清理。

回滚优先停用插件恢复原生Sidebar，再切回上一已验证tarball；保留插件metadata备份，禁止删除聊天目录来修复。版本升级只迁移自己的domain。任何正式发布、启用用户真实profile或处理历史会话，都应以当时明确的用户任务范围执行；本规划不提前执行这些动作。
