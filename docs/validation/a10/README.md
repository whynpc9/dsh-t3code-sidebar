# A10 验证记录 · 2026-11-13

基线为 `6fa3c80`，测试包为该提交上的 A10 修复，版本仍为 `0.1.0-alpha.2`。使用 npm 发布的 Harness `0.2.2-rc.1`、macOS arm64、Node 24.19.0、独立 `DSH_HOME`、loopback Web profile 和合成会话。

同一候选包的真实 Gateway API 用例也在 Linux arm64 容器（Node 24.22.3）中全部通过，包括 Host-off。浏览器复验在 macOS 运行。

候选包 SHA256 为 `ee5e1acd48696faa9aa0288194ed6137946489db8cb523dbb9328509c11efcc0`。浏览器实测 profile 中的 Host 与 Client 构建分别为 `e247b7a6c6cdbfc999e8082b0d1e05bf269347ef6cb300c426ddfb8a1fdb3657` 和 `de031c6eaef8a72d67bcc52d2f39feaf435fe7e03de546e9628c817d2e4578a5`，与候选包一致。

[测试夹具](../../../tests/fixtures/access-gate/index.js) 通过 Harness 的 `connection.createPeer` 建立 `share-viewer` Peer，将请求和流交给同一套 Connection、Typert Gateway 和 RemoteAccess。夹具只提供身份、临时授权与撤权，测试中的任务访问判断和流执行由实际 Host 完成。浏览器验证使用官方 LiveShare viewer carrier。范围覆盖发布版 Harness 的授权边界，外部 LiveShare Relay 部署及 OAuth 登录未在本次运行中接入。

| 用例 | 结果 |
| --- | --- |
| 默认 guest | 原生 `session/list` 仅返回授权会话。Gateway 对任务快照、跟随、命令、策略写入、策略预览和审计全部返回 `remote-access/denied`。修复前客户端在收到拒绝后仍挂载本地任务侧栏。 |
| 撤权与旧连接 | 对夹具临时授予任务权限，实际打开任务流，再撤权。授权流更新，后续任务／策略写入被拒，存储版本未变。owner 写入后，旧 guest 流以 `t3Sidebar/access-denied` 结束，无新任务帧。Peer 释放后，旧 guest 请求和重新打开流均被拒。 |
| 未知字段与状态 | 额外命令字段、动作字段、策略字段和未知动作均被拒，读回确认任务及策略版本未变化。单元测试确认未知的轮次结束原因仍显示为需检查。 |
| 任务 API 不可用 | 设置 `DSH_T3_SIDEBAR_HOST=off` 后，owner 任务 API 返回 404，原生会话 API 正常，浏览器启动本地预览。没有任务权限的浏览器保留原生 Workspaces。 |

浏览器由 `gpt-6.1-terra`（High）在 Chromium 隔离上下文中复验。初始 guest 保持原生 Workspaces，未请求任务 API。临时授权后打开 Settled 分区及合成会话的任务菜单。菜单打开时撤权，任务侧栏和菜单都撤下，原生 Workspaces 留在页面。该过程未发出任务写入请求。对照截图见[授权时的任务菜单](screenshots/granted-menu.png)和[撤权后的原生侧栏](screenshots/revoked.png)。

浏览器验证的一次启动由 Harness 自动在默认浏览器打开隔离测试页，该标签未确认关闭。测试用的 Host、模型桩和 Playwright 浏览器上下文均已停止。

`pnpm run verify` 通过，包含 16 个测试文件、237 项测试、类型检查、构建和打包检查。夹具及端到端脚本不随产品包发行。

## 复现

从仓库根目录运行。测试 profile 需要支持 Node 24 的 Harness 0.2.2-rc.1。

```sh
test_root=$(mktemp -d)
export DSH_HOME="$test_root/home"
export DSH_T3_A10_FIXTURE=1 DSH_TELEMETRY_MODE=DISABLED
mkdir -p "$test_root/workspace"
pnpm run verify
pnpm pack --pack-destination "$test_root"
npm pack --pack-destination "$test_root" ./tests/fixtures/access-gate

dsh a10 --from-default-profile web --help
dsh plugin --profile a10 add "$test_root/dsh-t3code-sidebar-0.1.0-alpha.2.tgz"
dsh plugin --profile a10 add "$test_root/dsh-t3code-access-gate-fixture-0.0.1.tgz"
dsh a10 --no-open --host 127.0.0.1 --port 0 > "$test_root/host.log" 2>&1 &
test_host_pid=$!
# 等待日志出现 dsh web: 行。日志包含测试启动凭据。
node tests/e2e/access-gate.mjs "$test_root/host.log" "$test_root/workspace"
kill "$test_host_pid"
```

Host-off 用例以 `DSH_T3_SIDEBAR_HOST=off` 重启隔离 Host，再给同一脚本追加 `host-off` 参数。完整 API 用例会释放夹具 Peer，重复运行前需要重启 Host。

浏览器用例需要另外启动独立 Host。先启动 `node tests/fixtures/mock-llm.mjs 47900`，再用 `DSH_T3_A10_INTERACTIONS=answer DEEPSEEK_BASE_URL=http://127.0.0.1:47900 DEEPSEEK_API_KEY=sk-fixture` 启动测试 Host。浏览器夹具需要宿主的事件流，并用本地模型桩创建非空会话。运行 `HARNESS_NODE_MODULES=<Harness安装目录的node_modules> CHROME_PATH=<Chromium可执行文件> node tests/e2e/access-ui.mjs "$test_root/host.log" "$test_root/workspace"`。
