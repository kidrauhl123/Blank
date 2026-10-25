# 实时语音

AI 助手的电话按钮开启连续双向语音。浏览器通过 AudioWorklet 采集单声道 24 kHz PCM16，Web Audio 播放模型返回的音频；支持静音、打断、字幕与挂断。Fluid Orb 来自 `swamimalode07/rare-ui/fluid-orb`，颜色和流速对应真实通话状态，尊重系统减少动态效果设置。

## 服务链路

浏览器 → 同源 `/api/voice/live` WebSocket → 私有 voice worker → Grok2API `/v1/realtime` → Console 语音模型。

私有配置：`VOICE_API_KEY`、`VOICE_BRIDGE_TOKEN`、`VOICE_UPSTREAM_URL`、`VOICE_MODEL`、`VOICE_NAME`。该实例模型为 `Console/grok-voice-latest`；密钥只授权 Console 实时语音模型。应用只持桥接凭据，浏览器不会收到上游密钥。部署模板通过密钥是否配置决定入口是否显示。

共享 Caddy 需要将 `/api/voice/live` 转到 `bankpilot-voice:3011`，允许 `microphone=(self)`。路由示例见 `deploy/Caddyfile.bankpilot`。Docker voice 服务加入应用内部网络及现有 edge 网络。

## 数据与办理

连接校验同源和银行会话，每 25 秒复核登录用户。`read_bank_facts` 按当前客户查询账户、近期流水、当月账单、理财目录与持仓。只传递所需字段和掩码卡号。

`prepare_banking_task` 仅显示办理入口。用户点击后回到既有页面助手准备业务，资金、卡片等最终授权仍经过原有页面确认流程。语音不会直接执行写操作。

音频和语音字幕不存入数据库，字幕仅保留在当前页面会话中。通话最长十分钟，每客户至多两路，全服务至多八路；每次最多三十次工具调用。关闭、切换账户或离开助手会释放麦克风和连接。上游错误直接提示重拨。

协议参考：[xAI Voice Agent API](https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech)。旧 `/voice-trace` 是独立交互原型，不是正式通话入口。
