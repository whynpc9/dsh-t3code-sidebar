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

- 单元与服务测试：`npm test`，38 项通过（领域纯函数、Host 服务 CAS/幂等/follow/持久化、视图模型）。
- 端到端：[`e2e/results-main.json`](e2e/results-main.json)、[`e2e/results-restart.json`](e2e/results-restart.json)，12 项全部 PASS。
- Host 定时器：Snooze 到期由 Host 定时器唤醒（无需浏览器），`lastSnoozeWakeAt` 等于 deadline，审计记录 `snooze-expired`；Host 停机期间跨过 deadline，重启后补算唤醒（T06）。

## 尚未验证（不得宣称通过）

| 项 | 原因 / 计划 |
| --- | --- |
| 审批态的端到端（A02 中“等待审批”一步、A03 新审批唤醒） | 桩模型的 bash 调用在 Workspace Write 模式下无需审批；需切换权限预设后补测 |
| 自动 Settled 的真实跨天迁移 | 最小窗口 1 天；规则与边界由单元测试覆盖（T01–T05、T07、T09），集成层只验证了策略与调度器运行 |
| A07 搜索竞态、A08 键盘/焦点、A10 权限撤回/guest、A12 规模与读屏 | M4/M5 |
| Workspace 级策略覆盖、多 membership 的 `policyWorkspaceId` | P01 剩余部分 |
| macOS Desktop | M6（Q2） |
| Host 侧严格 codec | Host 走 SRC 分派（无生成器严格描述符），以同一 zod schema 在服务内自行校验；若上游开放外部包的 `./typert` 生成路径再切换 |

## 复现

```sh
npm install && npm run verify            # typecheck + test + build + pack check
npm pack                                 # dsh-t3code-sidebar-<version>.tgz
export DSH_HOME=$(mktemp -d)             # 隔离环境，切勿指向真实 profile
npx -p @deepseek-ai/dsh@0.2.2-rc.1 dsh sbtest --from-default-profile web --help
npx -p @deepseek-ai/dsh@0.2.2-rc.1 dsh plugin --profile sbtest add "$PWD/dsh-t3code-sidebar-<version>.tgz"
node tests/fixtures/mock-llm.mjs 47900 &
DEEPSEEK_BASE_URL=http://127.0.0.1:47900 DEEPSEEK_API_KEY=sk-fixture \
  npx -p @deepseek-ai/dsh@0.2.2-rc.1 dsh --profile sbtest --no-open --port 47821 --host 127.0.0.1
node tests/e2e/scenario.mjs "<打印出的带 token URL>" <一个空目录> docs/validation/poc/e2e main
```
