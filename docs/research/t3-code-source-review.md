# T3 Code 侧栏源码研究

基线为官方仓库 main 的 Git 浅克隆 HEAD `a9e709f15f825cacac1b6d665fa1920c328d68b7`，提交时间 2026-11-07 14:20:13 -08:00。下列事实来自该提交的 Web/桌面源码与官方说明。GitHub connector 的 main 响应指向较早快照，本文以实际 Git checkout 为准。未启动应用，未验证像素表现、运行时竞态或历史版本。 [固定提交](https://github.com/pingdotgg/t3code/commit/a9e709f15f825cacac1b6d665fa1920c328d68b7)

## 两种在用视图

| 视图 | 固定提交中的行为 |
| --- | --- |
| 任务分区，默认 | Pinned → Active → Working → Snoozed → Settled。后三个货架默认折叠。Working 默认开启，独立设备可关。没有独立 Attention 分区，需操作的会话通过行标记及 Working 返回 Active 提示。 |
| Boring，按项目 | 仅 Active 按项目折叠。Pinned、Snoozed、Settled 保持分区，Working 关闭，线程拖拽关闭。折叠项目显示数量和最高优先级的状态点。项目可直接新建线程。Pinned 项目靠前，归档项目靠后且有 Active 才出现；常规空项目仅在已置顶或被选为筛选项时出现。文件夹复用旧 UI 折叠状态。 |
| 已移除的 Legacy | 旧 `legacySidebarEnabled` 进入 Boring 路径。切换 Boring 清除旧开关。旧设置还控制新建线程默认当前项目，这是兼容分支。当前源码没有第三种可选择的经典视图。 |

[当前分区与按项目分组](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.tsx#L439-L530) · [项目空组规则](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.tsx#L1330-L1347) · [官方两种模式](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/docs/user/thread-sidebar.md#L134-L161) · [旧设置迁移](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/contracts/src/settings.ts#L515-L533) · [开关实现](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/settings/LabsSettingsPanel.tsx#L42-L54)

## 任务状态与优先级

- **放置**。过滤归档、隐藏谱系及已放在父会话之下的委托线程，并按项目范围过滤。可见线程先应用尚未收敛的乐观拖放投影，否则按有效 Snoozed → Settled override → Pinned → Inbox 判断。Inbox 再按 Working 开关和运行状态分为 Working / Active。源码在对应环境配置尚未加载时暂不应用 Snoozed/Settled 判定。 [过滤](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.logic.ts#L566-L615) · [放置优先级](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.logic.ts#L174-L187) · [分区实现](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.tsx#L612-L710)
- **行状态**。分类依次判断审批、用户输入、访客请求、阻塞等待、准备/执行、运行时 idle、失败或限额，最终 ready。主行标记在 ready 时先 Woke 再 Done。Done 来自 `latestRun.completedAt > lastVisitedAt` 的未读判定，不依赖行当前的闲置时长。运行时 `idle` 在该模型可以是 Waiting。Settled 是另一层显式放置状态。文件夹圆点优先级为需注意（输入、审批、访客、限额）→ 失败 → 未读完成 → 工作 → 无。 [状态与文件夹点](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.logic.ts#L816-L919) · [行标记](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/sidebar/SidebarThreadRow.tsx#L708-L783) · [访问水位](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.logic.ts#L688-L716)
- **Working**。活跃运行、明确等待及一些 provider 的 idle 状态可落入 Working。审批、用户输入、子代理请求，以及完成运行后的可执行计划排除 Working。约 2 秒退出缓冲防止连续运行之间闪跳，出现 actionable 信号/失败、手动移动或进其他分区时跳过缓冲。需区分原始 working predicate 和 actionable 缓冲条件，访客数只直接出现在后者。Active 按创建、unsettle、最近运行请求/完成及客户端观测返回时间的最大值降序；Working 和 Boring 的 Active 按最近用户发信降序。 [工作与排序](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/client-runtime/src/state/threadInbox.ts#L6-L89) · [缓冲](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/client-runtime/src/state/threadInbox.ts#L109-L239)
- **Snooze**。可按相对时长或本地日历时间设置，预设按唤醒时间排序并按分钟去重。到期、手动 Wake 或新的紧急信号回到可见区。现有普通异步问题可以稍后再答，更新的问题唤醒，缺失问题时间则保留可见。审批、子代理和访客待办、新失败触发提前展示，用户发新消息也会提前结束。完成或后台自动继续不会单独唤醒。失败采用失败 run 的完成时间，不能把 metadata 写入误认成新失败。精确唤醒 timer 避免分钟节拍造成延迟。 [唤醒判定](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/client-runtime/src/state/threadSettled.ts#L82-L193) · [预设与时间校验](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/client-runtime/src/state/threadSettled.ts#L230-L385) · [用户说明](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/docs/user/thread-sidebar.md#L322-L338)
- **Settle / Pin**。Settle 写入 settled override，并清除 pin、两类排序中的 active 位置、snooze；Un-settle 写 active override 及恢复时间，保护直到新活动重新进入自动规则。Pin 可从 Settled/Snoozed 提升，清除对应停车状态；Snooze 写入时保留 pin 元数据，但有效 Snoozed 优先，单行只渲染一次。固定提交的自动 Settle 候选明确排除 Pinned，与用户文档中“置顶不阻止自动结案”的说明冲突。手动 Settle 仍会移除 pin。自动规则独立服务运行，默认七天与 PR 事件，包含活动、待办、PR、醒来后宽限等条件。部分 Settle 关联终端和项目脚本，不能把 T3 的副作用当成通用语义。 [服务端变更](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/Orchestrator.ts#L3699-L3799) · [自动规则](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/server/src/orchestration-v2/ThreadSettlementService.ts#L125-L251) · [终端和脚本说明](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/docs/user/thread-sidebar.md#L162-L209)

## 交互、数据与宿主边界

| 主题 | 上游事实 |
| --- | --- |
| 排序与拖放 | Pinned、可手排时的 Active 使用独立的服务端可排序 key，稀疏键空间插入并在需要时重排；未安排的新 Active 在手排条目之上。Active 手排在 Working 开启时暂停，关闭后原序恢复。Snoozed 按唤醒时间，Settled 按 settlement 时间。拖入 Pinned/Active 可改变放置和位置，Settled 标题接受 Settle，Snoozed 仅可拖出，因为拖入缺少唤醒时间。拖动显示 Pin、Unpin、Settle、Un-settle、Wake，拖放权限和排序显示分离。 |
| 状态收敛 | 拖放显示乐观位置与顺序，持续到服务端 canonical 分区、变更后的 key 和清 snooze 等条件都收敛。部分动作提供五秒 Undo，包括 Unpin、Settle、Snooze、Archive，保留之前的 pin 位置。 |
| 轻量检索 | Web/桌面有 Cmd/Ctrl+K，也有内联线程搜索和项目筛选。元数据搜索支持标题、分支、PR、项目，正文由服务端查询再合并，已显示的命中在慢环境返回时保持位置。内联搜索去重、元数据优先，正文专有命中带定位。Palette 的历史挑选加权与内联结果有意不同。 |
| 当前项 | 关闭 Working/Snoozed/Settled 时仍保留路由项；Settled 超出当前页也可补入当前项。路由切换或异步 row mount 时滚动到最近位置，新路由在当前项目筛选遮挡时可扩大 scope；重挂载或搜索期间避免误改范围。 |
| 持久化与隔离 | 环境 ID + 线程 ID 作为复合身份。服务端投影包含 archive/settle/snooze/pin、排序键及 visit 等字段；旧服务端可回退本地 visit。客户端本地保存视图和货架/项目折叠偏好；Working grace/return observer 是短时客户端状态。 |
| 归档与删除 | Archive 进归档入口，可恢复，运行状态/权限会影响可用性。Delete 有确认和结果处理。工作树删除是独立操作，需要源码管理权限；先核实该 worktree 未被其他线程使用，读取失败保留。删除线程后才尝试清理工作树，按失败分别处理。普通新建与新 worktree/既有 worktree 是不同入口；草稿和选项目可区分环境。 |
| 性能与无障碍 | 以 shell 列表为主体，行级可见/选中状态租约控制昂贵 detail 和实时状态订阅。Settled 首次展示 10，追加每次 25 并可向服务端分页。滚动和键盘导航有显式处理，行有 `aria-current`、状态文本及可操作标签，搜索使用 listbox/option。移动动画尊重 reduced motion。未确认全列表虚拟化或读屏实测。 |

- [顺序 key 算法](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/client-runtime/src/state/threadSort.ts#L172-L335) · [拖放目标](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.logic.ts#L229-L294) · [乐观收敛](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.tsx#L731-L801) · [操作、Undo 与移动](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/docs/user/thread-sidebar.md#L61-L150)
- [检索实现](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.tsx#L1349-L1403) · [元数据和正文合并](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.logic.ts#L1004-L1039) · [Palette 文档](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/docs/user/thread-sidebar.md#L222-L244)
- [当前项 reveal](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/sidebar/routeReveal.ts#L5-L72) · [折叠与分页](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.tsx#L439-L522) · [shell 元数据](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/packages/client-runtime/src/state/models.ts#L163-L203) · [项目展开状态](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/uiStateStore.ts#L215-L244)
- [归档操作](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/hooks/useThreadActions.ts#L358-L432) · [删除与工作树](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/hooks/useThreadActions.ts#L435-L615) · [新建入口](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/docs/user/thread-sidebar.md#L6-L59)
- [行订阅](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.logic.ts#L64-L97) · [行可访问性](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/sidebar/SidebarThreadRow.tsx#L1207-L1263) · [动画](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/apps/web/src/components/Sidebar.motion.ts#L15-L34)

## Harness 可采纳的设计（提议）

1. 任务分区作为默认导航，同一会话数据可切换到项目分组视图。保留当前项、范围和各自折叠状态。若将 Attention 设计为独立分区，明确这是插件自己的增强，并为已置顶、有效 Snooze、失败和当前项定义唯一放置与覆盖规则。
2. 将执行状态、待用户操作、已读水位、停车、历史归档和放置分别建模。只在有可信 run 生命周期时计算 Done，只有可信待办或失败边沿能提前唤醒。缺失宿主事实时显示 Unknown 或只展示显式本地状态，继续提供手动醒来和解除 Settle。
3. 将插件本地的放置和宿主的工作区、会话、运行状态分开存储。排序、权限、事件与导航能力由宿主接口验证后决定。第一版可从元数据检索、键盘等价操作和软隐藏开始，正文跨工作区索引、PR 自动结案、自动终端或工作树清理应单独验证能力与副作用。
4. 可借鉴信息结构、优先级和交互模式。上游根许可证为 MIT，若复制实质代码须保留版权与许可声明。第三方资源和产品标识应独立检查。本文未复制上游实现。 [MIT 许可](https://github.com/pingdotgg/t3code/blob/a9e709f15f825cacac1b6d665fa1920c328d68b7/LICENSE#L1-L21)
