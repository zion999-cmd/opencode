# oc2api — OpenCode 免费模型代理 API

将 OpenCode 内置的免费模型以标准 OpenAI / Anthropic API 格式对外暴露，
任何支持这两套格式的客户端（如 OpenClaw、Cursor、Cherry Studio 等）均可直接接入。

---

## 服务管理（推荐）

使用项目自带的管理脚本 [`oc2api.sh`](../oc2api.sh)：

```bash
cd packages/opencode

./oc2api.sh start    # 后台启动服务，等待就绪后返回
./oc2api.sh stop     # 优雅停止（超时后 SIGKILL）
./oc2api.sh restart  # 重启
./oc2api.sh status   # 查看运行状态及可用模型列表
```

**自定义端口 / 监听地址**（通过环境变量）：

```bash
OC2API_PORT=8080 OC2API_HOST=0.0.0.0 ./oc2api.sh start
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `OC2API_PORT` | `31498` | 监听端口 |
| `OC2API_HOST` | `127.0.0.1` | 监听地址 |

脚本运行时产生两个文件（均在 `packages/opencode/` 下，已加入 `.gitignore` 忽略）：

| 文件 | 用途 |
|---|---|
| `.oc2api.pid` | 存储进程 PID，用于 stop/status |
| `.oc2api.log` | 服务器标准输出 / 错误输出 |

**status 输出示例：**

```
oc2api is running (PID 12345, port 31498)
Endpoint : http://127.0.0.1:31498/v1
Log file : .../packages/opencode/.oc2api.log

Available models:
  - opencode/gpt-5-nano
  - opencode/minimax-m2.5-free
  - opencode/big-pickle
  - opencode/nemotron-3-super-free
```

---

## 手动启动（备用）

```bash
cd packages/opencode
bun run --conditions=browser ./src/index.ts serve --port 31498
```

服务监听 `http://127.0.0.1:31498`。

> **注意**：每次请求必须携带 HTTP Header `x-opencode-directory`，值为当前项目目录的绝对路径。  
> 该目录用于初始化 OpenCode 实例上下文。

---

## 模型命名规则

所有模型 ID 使用 `{providerID}/{modelID}` 格式，例如：

| 模型 ID | 说明 |
|---|---|
| `opencode/gpt-5-nano` | OpenCode 内置免费模型 |
| `opencode/minimax-m2.5-free` | OpenCode 内置免费模型 |
| `opencode/big-pickle` | OpenCode 内置免费模型 |
| `opencode/nemotron-3-super-free` | OpenCode 内置免费模型 |
| `github-copilot/gpt-4o` | 需要完成 GitHub Copilot OAuth 认证 |

---

## 端点

### `GET /v1/models` — 列出可用模型

返回所有已连接 Provider 下的模型列表。

**请求示例**

```bash
curl http://127.0.0.1:31498/v1/models \
  -H "x-opencode-directory: /path/to/project"
```

**响应**

```json
{
  "object": "list",
  "data": [
    { "id": "opencode/gpt-5-nano", "object": "model", "created": 0, "owned_by": "opencode" },
    { "id": "opencode/minimax-m2.5-free", "object": "model", "created": 0, "owned_by": "opencode" }
  ]
}
```

---

### `POST /v1/chat/completions` — OpenAI 格式对话

兼容 OpenAI Chat Completions API，支持：
- 多轮对话（完整 `messages` 数组）
- System prompt（`role: "system"` 消息，可有多条，自动合并）
- 流式 / 非流式
- Reasoning/Thinking token 透传（`reasoning_content` 字段）

**请求体**

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | `{providerID}/{modelID}` 格式 |
| `messages` | array | 对话消息数组，支持 `system` / `user` / `assistant` |
| `stream` | boolean | 是否流式返回，默认 `false` |
| `temperature` | number | 可选 |
| `max_tokens` | number | 可选，建议 >= 1024 |
| `top_p` | number | 可选 |

**非流式请求示例**

```bash
curl http://127.0.0.1:31498/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-opencode-directory: /path/to/project" \
  -d '{
    "model": "opencode/gpt-5-nano",
    "messages": [
      {"role": "system", "content": "你是一个编程助手，回答要简洁。"},
      {"role": "user", "content": "我叫小明"},
      {"role": "assistant", "content": "你好小明！"},
      {"role": "user", "content": "我叫什么名字？"}
    ]
  }'
```

**非流式响应**

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1776796290,
  "model": "opencode/gpt-5-nano",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "小明" },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 30, "completion_tokens": 5, "total_tokens": 35 }
}
```

**流式请求示例**

```bash
curl http://127.0.0.1:31498/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-opencode-directory: /path/to/project" \
  -d '{
    "model": "opencode/gpt-5-nano",
    "messages": [{"role": "user", "content": "写一个冒泡排序"}],
    "stream": true
  }'
```

**流式响应格式**（SSE）

```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"好"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"的"},"finish_reason":null}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":80,"total_tokens":90}}

data: [DONE]
```

---

### `POST /v1/messages` — Anthropic 格式对话

兼容 Anthropic Messages API，支持：
- 多轮对话
- 顶层 `system` 字段
- Base64 图片 / URL 图片（`image` 类型 content block）
- 流式 / 非流式

**请求体**

| 字段 | 类型 | 说明 |
|---|---|---|
| `model` | string | `{providerID}/{modelID}` 格式 |
| `messages` | array | 对话消息数组，`role` 只能是 `user` / `assistant` |
| `system` | string \| array | 可选，System prompt；支持纯字符串或 Anthropic content block 数组 |
| `max_tokens` | number | 可选，默认 32000；Claude Code 等客户端会自行传值 |
| `stream` | boolean | 是否流式返回，默认 `false` |
| `temperature` | number | 可选 |
| `top_p` | number | 可选 |

**非流式请求示例**

```bash
curl http://127.0.0.1:31498/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-opencode-directory: /path/to/project" \
  -d '{
    "model": "opencode/gpt-5-nano",
    "system": "你是一个编程助手，回答要简洁。",
    "messages": [
      {"role": "user", "content": "写一个冒泡排序"}
    ],
    "max_tokens": 2048
  }'
```

**非流式响应**

```json
{
  "id": "msg_xxx",
  "type": "message",
  "role": "assistant",
  "content": [{ "type": "text", "text": "..." }],
  "model": "opencode/gpt-5-nano",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": { "input_tokens": 20, "output_tokens": 150 }
}
```

**流式响应格式**（Anthropic SSE 命名事件）

```
event: message_start
data: {"type":"message_start","message":{"id":"msg_xxx","role":"assistant",...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type":"ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"好"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"的"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":150}}

event: message_stop
data: {"type":"message_stop"}
```

---

### Tool Calling

`/v1/messages` 和 `/v1/chat/completions` 均支持工具调用。

**`/v1/messages` 工具定义格式（Anthropic 格式）**

```json
{
  "tools": [
    {
      "name": "read_file",
      "description": "读取文件内容",
      "input_schema": {
        "type": "object",
        "properties": {
          "path": { "type": "string" }
        },
        "required": ["path"]
      }
    }
  ]
}
```

**`/v1/chat/completions` 工具定义格式（OpenAI 格式）**

```json
{
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "read_file",
        "description": "读取文件内容",
        "parameters": {
          "type": "object",
          "properties": {
            "path": { "type": "string" }
          }
        }
      }
    }
  ]
}
```

代理会自动将 Anthropic `input_schema` 与 OpenAI `parameters` 格式互转，再传给底层 AI SDK。

**中断工具调用补偿**：如果上下文历史中 assistant 发出了 `tool_use` 块，但后续没有对应 `tool_result`（例如请求被中断），代理会自动插入一条合成的 `[interrupted]` 结果，避免模型收到不合法的历史序列。

---

## Claude Code 兼容性

oc2api 对 Claude Code 客户端做了专项适配，支持直接将 Claude Code 接入 OpenCode 免费模型。

### 配置方法

在 Claude Code 的模型配置中填写：

```
baseURL: http://127.0.0.1:31498
```

> **注意**：填 `http://127.0.0.1:31498`，不是 `http://127.0.0.1:31498/v1/messages`。Claude Code 会自动在末尾拼接 `/v1/messages`。

### 适配细节

| 特性 | 说明 |
|---|---|
| **UA 检测** | 请求 User-Agent 含 `claude`（如 `claude-cli/2.x`）时自动开启 Claude Code 专属适配 |
| **System Array** | Claude Code 的 `system` 字段是 content block 数组（`type: text`），代理自动拼接为字符串 |
| **Identity Guard** | 自动在 system 末尾追加身份规则，防止模型角色漂移（声称自己不是 Claude Code）|
| **Assistant Primer** | 在消息首部注入 `assistant` 角色的开场白，引导模型以正确身份回应 |
| **System Reminder 提升** | user 消息中 `<system-reminder>` 标签的内容会提升到 system 上下文，避免被当作普通对话 |
| **max_tokens 兜底** | 默认 32000，Claude Code 自身也会传 `max_tokens`，以客户端传值为准 |

### 验证方式

查看日志中的 `identity_enforced=true`，说明 Claude Code 专属适配已生效：

```bash
grep "identity_enforced" ~/.local/share/opencode/log/dev.log | tail -5
```

---

## stop_reason 映射

| AI SDK finishReason | OpenAI finish_reason | Anthropic stop_reason |
|---|---|---|
| `stop` | `stop` | `end_turn` |
| `length` | `length` | `max_tokens` |
| `tool-calls` | `tool_calls` | `tool_use` |

---

## OpenAI API 兼容性修正（2026-04）

### finish_reason 工具调用兼容

AI SDK 内部返回 `finishReason: "tool-calls"`，但 OpenAI 官方规范要求 `finish_reason: "tool_calls"`（下划线）。

已在 `/v1/chat/completions` 路由流式和非流式响应中做自动转换：

- `finish_reason: "tool-calls"` → `finish_reason: "tool_calls"`
- 其他 finish_reason 保持原样

这样可兼容 OpenClaw、Cursor 等严格校验 OpenAI 协议的客户端。

### 工具调用标准

- OpenAI 官方标准：`tool_calls`（下划线）
- AI SDK 内部：`tool-calls`（连字符，仅内部使用）
- 代理层已全部自动转换，无需客户端关心

---

## 已知限制

1. **不走 OpenCode Plugin hook**：直接调用底层 AI SDK，不经过 `chat.params` / `chat.headers` 等 Plugin 钩子。
2. **`opencode/gpt-5-nano` token 计数特殊**：该模型内部 token 计数偏大，`max_tokens` 设置过小（< ~200）会导致输出为空、`stop_reason: max_tokens`，建议 >= 8096。
3. **Provider 认证**：仅 `opencode/` 前缀的内置免费模型无需认证即可使用。其他 Provider（如 `github-copilot`、`anthropic`、`openai`）需要先在 OpenCode 完成 OAuth / API Key 配置。
4. **多 system 消息**：OpenAI 格式允许多条 `role: "system"` 消息，代理会用 `\n` 拼接后统一传给模型。
5. **Claude Code 身份漂移**：底层免费模型不是真正的 Claude，Identity Guard 只是引导，模型仍可能偏离。换用 `github-copilot/claude-*` 模型可彻底解决。

---

## 相关文件

- 路由实现：[`packages/opencode/src/server/routes/instance/v1.ts`](../src/server/routes/instance/v1.ts)
- 路由注册：[`packages/opencode/src/server/routes/instance/index.ts`](../src/server/routes/instance/index.ts)
