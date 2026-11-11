# M0 验证记录与决策

记录日期：2026-11-09。环境见 [runtime/version.json](runtime/version.json)：`@deepseek-ai/dsh@0.2.2-rc.1`（npm 发行版，与调研固定提交同版本）、Linux（WSL2）、Node 24、headless Chromium。全部在隔离的 `DSH_HOME` 和新建 `sbtest` profile 中执行，没有读取用户真实 profile、历史或凭据。模型请求由本仓库的脚本化 Anthropic Messages 兼容桩（[`tests/fixtures/mock-llm.mjs`](../../../tests/fixtures/mock-llm.mjs)）应答，没有调用真实付费模型。

## 结论：Go

| 门槛 | 结论 | 证据 |
| --- | --- | --- |
| G0-A 槽位与打包 | **通过** | 自建 esbuild 封装产出 Loader lazy-CJS `lib/client.js`；`npm pack` 的 tarball 经官方 `dsh plugin --profile sbtest add` 安装；以 priority `-10` 接管 `sidebar.workspaces`，原生浏览区不再渲染（`A11.single-winner`），外壳品牌/新会话/插件/设置保持原样；产物不含私有 React 副本（构建守卫 + pack 检查）。 |
| G0-B 自有 Remote | **通过** | 外部包在已发行 runtime 上**无需重编译**即可工作：Client 用公开 `ctx.remote.$mount()` 挂载手写的 Typert contribution（与生成器同形，含严格 zod codec），再经嵌套 `ctx.inject(['remote.t3Sidebar'])` 取得命名空间；Host 侧 `TypertRemoteService` + `@Remote` 由 Gateway 的 SRC marker 路径分派。两个窗口的 baseline 与 delta 一致（`A06.*`），Host 重启后数据保留（`A04.*`）。 |
| G0-C 事实与冷恢复 | **部分通过，足以 Go** | 见下方能力矩阵。关键发现：Host 可通过 `workspace/session-activity` waterfall 得到 turn（含等待审批/回答）、subagent、job、schedule 四类活动；`session/event` 提供已提交的 `user/message`、`turn/start`、`turn/end`（含 reason）。因此无需自定义 SessionProjection 也能维护活动摘要。 |
| G0-D 生命周期（Linux Web） | **通过（Web）** | 卸载后原生侧栏与全部会话恢复（截图 `uninstalled-native-restored.png`）；重新安装后 Snoozed/Settled 元数据保留；渲染异常时 slot 渲染器自动回退到原生赢家（开发中实际触发并观察到）。Desktop 按 Q2 延至 M6。HMR 重入与 20 次启停尚未自动化。 |

降级路径也已实测：设置 `DSH_T3_SIDEBAR_HOST=off`（模拟 Host 命名空间不可用）时，Client 自动改用浏览器本地后端，设置面板明确说明“浏览器本地预览”，Snooze 在刷新后仍保留（截图 `browser-only-fallback.png`）。

## 2026-11-11 复验：连接代次、生命周期与发布包（issue #4）

环境同上（`@deepseek-ai/dsh@0.2.2-rc.1`、Linux WSL2、Node 24.19、headless Chromium 1243），新建隔离 `DSH_HOME` 与 `sbtest` profile，模型仍为脚本化桩。被测代码为 issue #4 修复分支；构建可复现，安装到 profile 的产物与仓库构建逐字节一致：`lib/client.js` SHA256 `be3d7d1dd1ab200568badc78762f817b12269767b2e951943395463523cc4ec3`，`lib/index.js` SHA256 `d09696421e8e977dfd1d1bfddbe99fa4399a58fdaa9be71bafccdde3379de609`（tarball 内含 README，文档改动会改变 tarball 本身的哈希，因此记录产物哈希）。

| 步骤 | 结果 |
| --- | --- |
| `npm pack` → `dsh plugin --profile sbtest add <tgz>`（真实 Loader） | 安装成功 |
| 主场景 `scenario.mjs main`（两次：修复中途构建与最终构建） | 11/11 PASS（`F08`、`A02`×2、`F03`×2、`F04`、`F05`、`A06`×2、`F01`、`A11`）；页面错误仅为与 11-09 基线相同的 5 条资源 404 |
| Host 重启 `scenario.mjs restart` | PASS `A04.host-restart-keeps-parking` |
| `DSH_T3_SIDEBAR_HOST=off` 回退 `local-backend.mjs` | 首次运行 **FAIL**：真实 runtime 对缺失命名空间返回 `gateway/internal` + “transport failure … HTTP 404”，被新分类当作暂时故障而无限重试。已修正为按 HTTP 状态分类（404 → `missing`）并加入单元测试；最终构建 PASS：回退本地后端、刷新后 Snooze 保留，设置面板显示“原因：Host 任务服务未运行” |
| 同版本 tarball 再次 `plugin add` | **不更新**：版本号相同时安装为空操作（profile 内仍是旧产物，经哈希确认）。升级测试必须提升版本号，或先 `remove` 再 `add` |
| `remove` → `add`（重新安装） | `storages/t3_sidebar.json` 在卸载后保留；重新安装、关闭 Host 半边运行一次、再恢复 Host 后，第一次主场景停放的 Snoozed/Settled 仍在（`A04` PASS） |

自动化（`pnpm run verify`，137 项，含 PR #5 审阅后补充）新增：

- `tests/client/host-backend.spec.ts`：受控 AsyncIterable / deferred 的代次隔离——reset 后旧流 delta、存活连接上的 seq 断档、epoch 变化、旧 generation 命令回复晚于新 baseline、两个策略回复逆序、同 revision 不同策略、dispose 后 RPC/流/计时器；回复丢失后的原 commandId 重发、策略 CAS 重发恢复，以及“回复在新 generation 的 baseline 之后才丢失”的恢复。每例断言最终快照与 ready/stale。
- `tests/client/lifecycle.spec.ts`：真实 Cordis context 上 Client `apply` 启用→停用各 20 次（成功、协议不兼容、mount 超时、停用后迟到失败），以及暂时故障重试、停用后连接才完成、命名空间服务替换、两个实例互不影响；断言 Remote 挂载、slot、菜单、locale、store 订阅、follow 流全部归零。`connectHostBackend` 每条失败路径释放挂载与 inject 作用域。修复了一个实际缺陷：`ctx.inject()` 返回不可调用的 cordis `Fiber`，旧代码以函数调用它，导致探测失败或停用时抛错并跳过 Remote 卸载。
- `tests/host/client-integration.spec.ts`：两个真实 `HostBackend` 对真实 Host 服务——并发同会话命令（一胜一 `CONFLICT`、双窗口收敛）、提交后回复丢失（`UNCONFIRMED` → 原 commandId 重放，单收据单审计）、仅簿记/审计失败（报告成功、审计缺口）、主写失败（无变化）、follow delta 丢失（断档重订阅收敛）、提交后 Host 重启（持久收据重放）、策略回复丢失、策略写入仍在 Host 存储排队时取得的新 baseline（不误报“未保存”）。

## 2026-11-11 macOS Desktop 复验（issue #4）

被测代码为 `a913367e17e808821238db2f716c7830672489c5`，与复验开始时的 `origin/main` 一致。宿主为 macOS 26.6.2（25G83，arm64）和 DeepSeek Harness Desktop 0.2.2-rc.1（Electron 44.7.0）。桌面验证由 `gpt-6.1-terra`（High）执行。使用独立 `DSH_HOME`、`desktop` profile 和 Electron `--user-data-dir`。宿主已有日常实例，因此 GUI 使用签名校验通过的官方应用副本，通过独立的 SingletonLock 和专用工作区标记识别测试实例。

`pnpm 11.20.0` 在 Node 24.19.0 上通过 frozen install、137 项测试、类型检查、构建和打包检查。用 Desktop 配套 CLI 的 `plugin --profile desktop add` 安装同一预构建 tgz。安装后检查 Host 与 Client 构建文件的 SHA256，均与 tgz 内文件一致。

| 安装证据 | SHA256 |
| --- | --- |
| `dsh-t3code-sidebar-0.1.0-alpha.0.tgz` | `662e1d97b0922db9f99e6009b2f8ac63a952068b9ba8fcdce2024dceaf81168b` |
| `lib/index.js` | `d09696421e8e977dfd1d1bfddbe99fa4399a58fdaa9be71bafccdde3379de609` |
| `lib/client.js` | `a39720ff5f312b13f1c26e772b470eb536c75101c5b17659788040a6270075e1` |

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| #2/#3 启动扫描后新建并停放 | **通过（Desktop）** | 旧会话已登记，随后通过 Desktop 新建两条会话。脚本化模型完成一条、使另一条失败。成功会话 Snooze 1 小时，失败会话依次标为已处理、重新打开、再标为已处理。退出前 Desktop 显示 Snoozed 1、Settled 1，存储仅登记了旧会话的 revision。 |
| 十分钟 header 刷新前 ⌘Q、重启 | **通过（Desktop）** | 约 15:28（UTC+8）通过 ⌘Q 退出测试进程。用原隔离 profile 重启后，Desktop 仍显示 Snoozed 1、Settled 1。存储登记的 revision 从 1 条变为 3 条，两条停放记录保留。审计仍为 `manual:snooze`、`manual:settle`、`manual:reopen`、`manual:settle` 四条。 |
| 离线文件元数据变化 | **通过（Desktop）** | 退出后对 Snoozed 会话的测试日志执行 `chmod`。mtime 和 SHA256（`21ec6efa019c9609645d3438721e6bfe747f79800e97fbe3f3579d0f74fb0581`）不变，ctime 从 `1794381964` 变为 `1794382242`。重启后仍为 Snoozed，无新增唤醒审计。 |
| 仅标题变更 | **通过（Desktop）** | 插件卸载期间通过原生会话菜单重命名 Settled 会话。该段日志包含 `session/title` 和宿主的 `session/end-seed`，没有新增用户输入或轮次事件。重装并重启后仍为 Settled，无新增唤醒审计。 |
| 在线真实活动唤醒 | **通过（Desktop）** | 在 Settled 会话提交新消息，Desktop 显示 Active。持久化新增一次 `settled → normal`，原因为 `activity:turn/start`。 |
| 离线活动回放及审计去重 | **通过（Desktop）** | 再次停放后卸载插件，在原生 Desktop 提交测试消息并持久化轮次。重装并启动后会话恢复为 Active，15:36:31.934（UTC+8）新增一条 `settled → normal`，原因为 `missed-activity`。再次 ⌘Q 重启后仍为 Active，该审计仍只有一条。 |
| 停机期间 Snooze 到期 | **通过（Desktop）** | 通过自定义 Snooze 界面将一条会话停放至 15:43（UTC+8）。15:42:10 前 ⌘Q 退出，15:43:06 后启动。Desktop 显示 Active 1、Snoozed 1。15:43:25.203 审计记录一条 `snoozed → normal`（`snooze-expired`）。 |
| 卸载、原生侧栏恢复、重装 | **通过（Desktop）** | 退出后用配套 CLI `plugin remove`，重启实际显示原生 Workspaces 侧栏。仍可打开会话并重命名。重新安装原 tgz 后，`t3_sidebar` 数据和两条停放状态保留。 |
| 版本递增升级和回退 | **通过（Desktop）** | 在克隆的独立 profile 中，通过配套 CLI 依次 `add` 旧版 alpha.0、当前代码的测试版 alpha.1、旧版 alpha.0。每次启动 Desktop 均显示 Active 2、Snoozed 1，停放和审计保留。回退后的 Host 和 Client 文件与旧包一致。 |
| Desktop 插件页停用、启用 | **通过（Desktop）** | 当前代码的测试版 alpha.1 在插件页停用后立即恢复原生侧栏，重新启用后立即恢复 T3，原 Snoozed 会话保留。 |
| 原生目录选择器 | **通过（Desktop）** | 在项目视图调用目录选择器，选中隔离目录并创建项目，Desktop 显示新项目。 |
| 当前会话定位 | **通过（Desktop）** | 打开会话后输入不匹配的搜索词，界面提示当前会话在筛选范围外。点击 Locate 清除搜索，目标行重新显示并获得焦点。 |
| 同一 slot 的竞争插件 | **通过（Desktop）** | 另装一个占用 `sidebar.workspaces` 的测试插件（priority `-20`，T3 为 `-10`），只显示测试插件。停用竞争插件后恢复 T3 并保留 Snoozed，继续停用 T3 后恢复原生 Workspaces 侧栏。 |
| 原生会话搜索和添加工作区快捷键 | **失败（Desktop）** | T3 启用时，⌘K 未聚焦会话搜索，⌘O 未打开目录选择器。对照使用同一应用、profile、会话输入焦点和已安装包，停用 T3 后两项均恢复。 |
| 规模载入、搜索和活跃轮次 | **通过场景检查（Desktop）** | 独立数据目录预置 100 个工作区，每个 50 条 v4 JSONL Zstandard 合成日志。宿主新增 1 条会话。存储登记 100 个工作区、5001 条会话，界面显示 Active 5001。通过 GUI 重命名一条会话并按新标题搜索，准确命中 1 条。并发提交 50 条慢速测试消息后，脚本化模型收到 50 次请求，界面显示 Working 50、Active 4951。 |

升级旧包来自 `23902a3`（alpha.0，SHA256 `1e357aaa612e6056907b23a526029d805b00b06ce0397bfaba430b4d125f7f76`）。升级包采用 `a913367` 的同一 Host 与 Client 构建，仅为测试将 manifest 版本改为 alpha.1（SHA256 `eb22581673cce4cd0c8df21387af24d1bcb24f9856bc4a6165d78d9e716bd704`）。

竞争插件 `dsh-t3code-slot-validation-fixture@0.0.1`（SHA256 `251aa52128434dbd2d09a5698e6670044eee754bda8a10ad57f516144ef88231`）通过真实 Loader 安装，Client 只注册优先级为 `-20` 的 `sidebar.workspaces` 占位元素。

规模测试通过辅助 Host 插件 `dsh-t3code-scale-load-fixture@0.0.2`（SHA256 `39a3c8e81e8ea053e043f6f74478c862183b05f9183e6decf99e200778549790`）调用 `sessionController.prompt`。16:01:01.701（UTC+8）记录尝试 50、接收 50、拒绝 0。模型桩以 `MOCK_SLOW_MS=180000` 保持轮次活跃。合成日志里的初始标题没有呈现在宿主目录，搜索验证使用 Desktop 实际写入并显示的新标题。

Desktop 的界面截图保存在 Terra 子任务的 CUA 操作记录中。停放、轮次和审计通过隔离 profile 的会话日志和 `storages/t3_sidebar.json` 复核。

重放期间交错的 live 事件、重新停放、pending 读取失败和慢重放与到期竞争已有 Host 层的受控测试，Desktop 上仍待注入和复验。此次实测运行时为 0.2.2-rc.1。

### 快捷键回归最小复现

1. 在 macOS Desktop 0.2.2-rc.1 的隔离 profile 安装并启用 `a913367` 构建。确认 T3 侧栏显示，焦点放在新会话输入框。
2. 按 ⌘K 和 ⌘O。预期分别聚焦会话搜索、打开目录选择器。实际焦点仍在会话输入框，也未出现目录选择器。
3. 在插件页停用 T3 并返回同一输入框。按 ⌘K 聚焦原生会话搜索。恢复输入框焦点，再按 ⌘O 打开 macOS 原生目录选择器。

宿主的 `session.search` 和 `workspace.add` 发布供原生 WorkspaceBrowser 消费的请求，T3 获胜时该浏览组件未挂载。项目视图内的目录按钮仍可调用 `pickDirectory`。 [Harness 快捷键注册](https://github.com/deepseek-ai/deepseek-harness/blob/fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159/packages/client/ui-workspace/src/client/shortcuts.ts#L65-L89)

### 复现环境

从被测提交打包后，先用独立目录启动一次 Desktop 初始化 `desktop` profile，正常退出，再通过同一应用的配套 CLI 安装。测试期间使用同一组目录和本地模型桩。若宿主同时运行日常实例，使用官方应用的签名副本，并在每次发送快捷键前核对测试工作区标记。

```sh
test_root=$(mktemp -d)
desktop_app='/Applications/DeepSeek Harness.app' # 或签名校验通过的副本
desktop_cli="$desktop_app/Contents/Resources/runtime/cli/bin/dsh"
desktop_bin="$desktop_app/Contents/MacOS/DeepSeek Harness"
node tests/fixtures/mock-llm.mjs 47900 &

# 首次启动后退出测试实例，再安装并重复此启动命令。
DSH_HOME="$test_root/home" DEEPSEEK_BASE_URL=http://127.0.0.1:47900 \
  DEEPSEEK_API_KEY=sk-fixture "$desktop_bin" --user-data-dir="$test_root/userdata"
DSH_HOME="$test_root/home" "$desktop_cli" plugin --profile desktop add "<绝对路径到 tgz>"
```

## 能力矩阵（G0-C）

| 信号 | Client 实时 | Host 实时 | Host 冷启动 | 本插件用法 |
| --- | --- | --- | --- | --- |
| 本轮运行 | `uiSession.sessionStatus.running` / `sessions.list` | `workspace/session-activity` 的 `turn` | 无活 Agent 即不在运行 | Client 实时值为准；Host 值用于命令准入和自动收起 |
| 子任务 / 后台 job | — | `subagent`、`job` 活动族 | job 持久 | Working 判定与准入 |
| 计划任务 | — | `schedule` 活动族 | 持久 | 阻止自动收起，不算 Working |
| 待审批 / 待回答 | `uiSession` 单一赢家 + `userQuestions` 投影 | 只能经 `turn` 活动间接得知（等待发生在 turn 内） | 投影值可能来自缓存 | Client 随命令上报为下界；Host 以“无活动”推定无待交互 |
| 用户输入 / turn 起止 | — | `session/event` 已提交事件 | 插件停用期间的事件不可见 | Host 折叠进 `t3_sidebar` 存储；锚点保守取较晚值 |
| 原生 Pin / Archive | `workspaces.list` | `workspaceRegistry` | 持久 | 原生为权威；Pin 集合按“最近置顶在前”有序 |

注意事项：`turn/end` 事件发出时 Agent 仍在收尾，立即查询活动会得到陈旧的 `turn`；实现中以 journal 的 turn 结束时间修正缓存并在 0.4 s / 2.5 s 后重采样。

## 自动化结果

- 单元与服务测试：`npm test`，38 项通过（领域纯函数、Host 服务 CAS/幂等/follow/持久化、视图模型）。2026-11-11 增至 137 项，见上节。
- 端到端：[`e2e/results-main.json`](e2e/results-main.json)、[`e2e/results-restart.json`](e2e/results-restart.json)，12 项全部 PASS。
- Host 定时器：Snooze 到期由 Host 定时器唤醒（无需浏览器），`lastSnoozeWakeAt` 等于 deadline，审计记录 `snooze-expired`；Host 停机期间跨过 deadline，重启后补算唤醒（T06）。

## 尚未验证（不得宣称通过）

| 项 | 原因 / 计划 |
| --- | --- |
| 审批态的端到端（A02 中“等待审批”一步、A03 新审批唤醒） | 桩模型的 bash 调用在 Workspace Write 模式下无需审批；需切换权限预设后补测 |
| 自动 Settled 的真实跨天迁移 | 最小窗口 1 天；规则与边界由单元测试覆盖（T01–T05、T07、T09），集成层只验证了策略与调度器运行 |
| A07 搜索竞态、A08 键盘/焦点、A10 权限撤回/guest、A12 规模与读屏 | M4/M5 |
| Workspace 级策略覆盖、多 membership 的 `policyWorkspaceId` | P01 剩余部分 |
| macOS Desktop | M6（Q2）部分完成。#2/#3 的停放后 ⌘Q 重启已通过，其他桌面验收状态见上方 macOS Desktop 复验 |
| 剩余发布门禁 | 规模下的首屏时间、更新和搜索延迟、DOM 行数、内存及 20 次 Desktop 启停。真实断网下的 `connection/reset` 已有受控测试，仍待实机复验。 |
| Host 侧严格 codec | Host 走 SRC 分派（无生成器严格描述符），以同一 zod schema 在服务内自行校验；若上游开放外部包的 `./typert` 生成路径再切换 |

## 复现

```sh
pnpm install --frozen-lockfile && pnpm run verify   # typecheck + test + build + pack check
pnpm pack                                # dsh-t3code-sidebar-<version>.tgz（重复测试请先提升版本号，见上节）
export DSH_HOME=$(mktemp -d)             # 隔离环境，切勿指向真实 profile
npx -p @deepseek-ai/dsh@0.2.2-rc.1 dsh sbtest --from-default-profile web --help
npx -p @deepseek-ai/dsh@0.2.2-rc.1 dsh plugin --profile sbtest add "$PWD/dsh-t3code-sidebar-<version>.tgz"
node tests/fixtures/mock-llm.mjs 47900 &
DEEPSEEK_BASE_URL=http://127.0.0.1:47900 DEEPSEEK_API_KEY=sk-fixture \
  npx -p @deepseek-ai/dsh@0.2.2-rc.1 dsh --profile sbtest --no-open --port 47821 --host 127.0.0.1
node tests/e2e/scenario.mjs "<打印出的带 token URL>" <一个空目录> docs/validation/poc/e2e main
```
