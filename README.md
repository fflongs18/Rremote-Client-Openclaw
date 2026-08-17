# OpenClaw Remote Control

在 Windows 本机运行 Web/BFF 和 Jianmu Hub，在 Mac 运行 Remote Client，通过 Mac 本机的 OpenClaw Gateway 执行任务并实时回传结果。

## 架构

```text
Browser -> Web/BFF -> xihe-jianmu-ipc Hub -> Mac Remote Client -> OpenClaw Gateway
             SSE          HTTP + WebSocket          openclaw-node
```

本项目不复制或修改 Jianmu Hub。`D:\project\xihe-jianmu-ipc` 继续作为独立上游项目运行；Remote Client 使用 npm 包 `openclaw-node@0.14.0`。

## 前置条件

- Windows 与 Mac 位于同一可信局域网。
- 两端安装 Node.js 22 或更新版本。
- Mac 已安装并能启动 OpenClaw Gateway，默认地址为 `ws://127.0.0.1:18789`。
- Windows 已有 `D:\project\xihe-jianmu-ipc`。

## 1. Windows 启动 Jianmu Hub

在 PowerShell 中设置一个足够长的共享 Token：

```powershell
Set-Location D:\project\xihe-jianmu-ipc
$env:IPC_HUB_BIND = '0.0.0.0'
$env:IPC_PORT = '3179'
$env:IPC_AUTH_TOKEN = 'replace-with-a-long-random-secret'
npm install
npm start
```

验证：

```powershell
Invoke-RestMethod http://127.0.0.1:3179/health
```

只在 Windows 防火墙中向可信局域网开放 TCP 3179。不要把此端口直接暴露到公网。

## 2. Windows 启动 Web/BFF

在本项目根目录：

```powershell
npm install
Copy-Item .env.example .env
```

编辑 `.env`，确保 `JIANMU_AUTH_TOKEN` 与 Hub 相同，然后运行：

```powershell
npm run build
npm run start:bff
```

打开 `http://127.0.0.1:<BFF_PORT>`（端口见根目录 `.env` 的 `BFF_PORT`，默认示例为 `8788`）。开发模式可使用 `npm run dev`，前端地址为 `http://127.0.0.1:5173`，`/api` 会按同一 `.env` 代理到 BFF。

## 3. Mac 启动 Remote Client

将整个项目复制或 Git clone 到 Mac，然后在项目根目录创建 `.env`：

```dotenv
JIANMU_HTTP_URL=http://WINDOWS_LAN_IP:3179
JIANMU_HUB_URL=ws://WINDOWS_LAN_IP:3179
JIANMU_AUTH_TOKEN=replace-with-the-same-secret
REMOTE_CLIENT_ID=remote-oc-macbook
REMOTE_CLIENT_LABEL=My MacBook
AGENT_RUNTIME=openclaw
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=
WEB_CONTROL_ID=web-control
```

启动 Gateway 和 Client：

```bash
openclaw gateway start
npm install
npm run build
npm run start:client
```

首次使用 `openclaw-node` 可能触发 OpenClaw 设备配对。按 Gateway 的配对提示批准设备后，Client 会将设备身份保存在 `~/.openclaw/device-identity.json`。

## 协议注意事项

- Remote Client ID 必须以 `remote-oc-` 开头，且不能以 `openclaw` 开头。
- Jianmu `POST /task` 投递的 WS 消息只包含任务摘要。Client 收到 `taskId` 后调用 `GET /tasks/:id` 获取完整 payload，包括 `agentId` 和 `sessionKey`。
- `openclaw-node` 的 `done` 只是一次 assistant turn 结束，不表示整个任务结束；最终完成以 `agent_end` 或流结束为准。
- Jianmu 自带 `lib/openclaw-adapter.mjs` 只调用 Hub 本机 `/hooks/wake`，不参与本项目的远程执行链路。

## 检查命令

```bash
npm test
npm run typecheck
npm run build
```

## 远端主动推送（第一版）

远端电脑可以不依赖主控先发任务，直接把定时状态、报告摘要或产物通知推送到主控页面。推送命令在远端项目目录执行：

```bash
npm run push -- "Mac mini 构建完成，测试全部通过"
```

可选环境变量：

```dotenv
PUSH_TITLE=构建结果
PUSH_LEVEL=success
PUSH_SESSION_KEY=rc_mac-mini_项目分析_20260813_1124_a7f2
```

`PUSH_SESSION_KEY` 设置后，消息会自动追加到主控对应会话；不设置则进入主控右上角的“远端推送”通知面板。命令可以由 macOS `launchd`、Windows 任务计划或 cron 定时调用。当前第一版支持文本通知，文件产物仍建议先上传到可访问的文件服务，再推送下载地址。

## Runtime 插件

Remote Client 通过 `AgentRuntime` 接口加载执行引擎。当前内置 `OpenClawAdapter`，任务未指定 `runtime` 时使用 `AGENT_RUNTIME`（默认 `openclaw`）。Client 注册到 Jianmu 时会上报所有 Runtime 及其 capabilities，页面在新对话发送前可选择执行插件，发送后锁定该 Runtime。

Client 同时上报每个 Runtime 的 `ready` 状态。页面只允许向已就绪的 Runtime 发送消息；旧版 Client 未上报状态时保持兼容。BFF 默认等待远端 15 秒确认接收，任务接收后 120 秒没有任何进度则标记失败并尝试取消，分别可通过 `TASK_ACCEPT_TIMEOUT_MS` 和 `TASK_IDLE_TIMEOUT_MS` 调整。Client 的健康状态默认每 15 秒刷新并尝试恢复连接，可通过 `RUNTIME_HEALTH_INTERVAL_MS` 调整；单次连接等待默认 5 秒，可通过 `RUNTIME_CONNECT_TIMEOUT_MS` 调整。

新增 Hermes 等 Runtime 时：

1. 在 `packages/apps/client/src/adapters/` 实现 `AgentRuntime`。
2. 在 `packages/apps/client/src/index.ts` 的 `RuntimeRegistry` 注册实例。
3. 将 Hermes 原生流事件转换为 `RuntimeEvent`，不要让 Hermes SDK 类型进入 Client 主循环、BFF 或协议包。
4. 为连接、流式文本、完成、失败和取消添加 Adapter 测试。

通用接口位于 `packages/apps/client/src/runtime/types.ts`，注册表位于 `packages/apps/client/src/runtime/registry.ts`。
