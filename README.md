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

打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。开发模式可使用 `npm run dev`，前端地址为 `http://127.0.0.1:5173`。

## 3. Mac 启动 Remote Client

将整个项目复制或 Git clone 到 Mac，然后在项目根目录创建 `.env`：

```dotenv
JIANMU_HTTP_URL=http://WINDOWS_LAN_IP:3179
JIANMU_HUB_URL=ws://WINDOWS_LAN_IP:3179
JIANMU_AUTH_TOKEN=replace-with-the-same-secret
REMOTE_CLIENT_ID=remote-oc-macbook
REMOTE_CLIENT_LABEL=My MacBook
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
