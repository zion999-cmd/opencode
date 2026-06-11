# OpenCode

OpenCode is an extensible AI coding assistant platform.

## OC2API — OpenAI-compatible Gateway

The gateway exposes free AI models through an OpenAI-compatible API.

### Quick Start

```bash
./oc2api.sh start   # Start the gateway
./oc2api.sh status  # Check status & available models
./oc2api.sh test    # Test all models
```

### Usage

```
oc2api {start|stop|restart|status|test}

  start    启动代理服务（默认端口 31498）
  stop     停止代理服务
  restart  重启代理服务
  status   查看运行状态及可用模型
  test     测试所有可用模型
```

### Endpoint

```
http://127.0.0.1:31498/v1
```

### API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/v1/models` | List available models |
| `POST` | `/v1/chat/completions` | Chat completion (streaming + non-streaming) |
| `POST` | `/v1/messages` | Anthropic Messages API format |

Model format: `{provider}/{modelID}` (e.g. `opencode/deepseek-v4-flash-free`)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OC2API_PORT` | `31498` | Gateway listen port |
| `OC2API_HOST` | `127.0.0.1` | Gateway listen host |

### Integrating with OpenClaw

Add to `~/.openclaw/openclaw.json` under `models.providers`:

```json
{
  "opencode": {
    "baseUrl": "http://127.0.0.1:31498/v1",
    "api": "openai-completions",
    "models": [
      { "id": "deepseek-v4-flash-free", "name": "DeepSeek V4 Flash (Free)" }
    ]
  }
}
```

> **Note**: If openclaw reports `LLM request failed: network connection error`,
> check that openclaw's LaunchAgent (`~/Library/LaunchAgents/ai.openclaw.gateway.plist`)
> does not have proxy environment variables. Local requests to 127.0.0.1 should
> bypass any proxy.

### Development

```bash
bun install
bun dev
```
