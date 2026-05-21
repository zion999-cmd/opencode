import { Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { streamText, generateText, tool, jsonSchema, type ModelMessage } from "ai"
import { Provider } from "@/provider"
import { ProviderID, ModelID } from "@/provider/schema"
import { Effect } from "effect"
import { AppRuntime } from "@/effect/app-runtime"
import { lazy } from "@/util/lazy"
import { Log } from "@/util"
import { Instance } from "@/project/instance"
import { Flag } from "@/flag/flag"
import { InstallationVersion } from "@/installation/version"

const log = Log.create({ service: "server.v1" })

/**
 * OpenAI-compatible v1 API routes that proxy through OpenCode's provider infrastructure.
 *
 * Model naming convention: "{providerID}/{modelID}"
 * Example: "github-copilot/gpt-4o", "anthropic/claude-opus-4-5"
 *
 * Endpoints:
 *   GET  /v1/models               — list all connected models
 *   POST /v1/chat/completions     — chat completion (streaming + non-streaming)
 */

function parseModel(model: string): { providerID: string; modelID: string } | null {
  const slash = model.indexOf("/")
  // bare model ID (no slash) → default to the built-in "opencode" provider
  if (slash < 1) return model.length > 0 ? { providerID: "opencode", modelID: model } : null
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) }
}

function normalizeAnthropicSystem(systemRaw: unknown): string | undefined {
  if (typeof systemRaw === "string") return systemRaw || undefined
  if (Array.isArray(systemRaw)) {
    return (systemRaw as any[])
      .filter((b: any) => b?.type === "text" && typeof b?.text === "string")
      .map((b: any) => b.text as string)
      .join("\n") || undefined
  }
  if (systemRaw && typeof systemRaw === "object") {
    const block = systemRaw as any
    if (block.type === "text" && typeof block.text === "string") return block.text || undefined
  }
  return undefined
}

function enforceClaudeCodeIdentity(system: string | undefined, force = false): string | undefined {
  if (!system) return undefined
  const claudeSignature =
    /claude\s*code/i.test(system) ||
    /\bofficial\s+cli\s+coding\s+assistant\b/i.test(system) ||
    /\bskill\s+tool\b/i.test(system) ||
    /<system-reminder>/i.test(system) ||
    /anthropic/i.test(system)
  if (!force && !claudeSignature) return system
  return `${system}\n\nIdentity rule (highest priority): You are Claude Code, the coding assistant. Never claim to be the underlying foundation model or provider (for example MiniMax, OpenAI, Anthropic model names).`
}

function claudeIdentityPrimer(forceClaudeIdentity: boolean): ModelMessage[] {
  if (!forceClaudeIdentity) return []
  return [{
    role: "assistant",
    content: [{
      type: "text",
      text: "Understood. I will act as Claude Code, the coding assistant, and will not identify myself as the underlying provider model.",
    }],
  }]
}

/** Convert OpenAI tools array to AI SDK tool dictionary (no execute — proxy only) */
function toAISDKTools(tools: unknown[]): Record<string, ReturnType<typeof tool>> {
  const result: Record<string, ReturnType<typeof tool>> = {}
  for (const t of tools as any[]) {
    if (t.type !== "function" || !t.function?.name) continue
    result[t.function.name] = tool({
      description: t.function.description ?? "",
      inputSchema: jsonSchema(t.function.parameters ?? { type: "object", properties: {} }),
    })
  }
  return result
}

function toModelMessages(messages: unknown[]): ModelMessage[] {
  return (messages as any[]).flatMap((msg): ModelMessage[] => {
    const role = msg.role as string
    const raw = msg.content

    if (role === "system") {
      return [{ role: "system", content: typeof raw === "string" ? raw : "" }]
    }

    if (role === "assistant") {
      const content: any[] = []
      if (typeof raw === "string") {
        if (raw) content.push({ type: "text", text: raw })
      } else if (Array.isArray(raw)) {
        for (const p of raw as any[]) {
          if (p.type === "text") content.push({ type: "text", text: p.text })
        }
      }
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content) {
        content.push({ type: "reasoning", text: msg.reasoning_content })
      }
      // convert OpenAI tool_calls → AI SDK ToolCallPart
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls as any[]) {
          if (tc.type === "function") {
            content.push({
              type: "tool-call",
              toolCallId: tc.id,
              toolName: tc.function.name,
              input: (() => {
                try { return JSON.parse(tc.function.arguments) } catch { return {} }
              })(),
            })
          }
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "" })
      return [{ role: "assistant", content }]
    }

    // tool result → AI SDK ToolModelMessage
    if (role === "tool") {
      return [{
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: msg.tool_call_id ?? "",
          toolName: msg.name ?? "",
          output: { type: "text", value: typeof raw === "string" ? raw : JSON.stringify(raw) },
        }],
      }]
    }

    // user
    const content =
      typeof raw === "string"
        ? [{ type: "text" as const, text: raw }]
        : (raw as any[]).map((p) => {
            if (p.type === "text") return { type: "text" as const, text: p.text as string }
            if (p.type === "image_url") return { type: "image" as const, image: (p.image_url?.url ?? "") as string }
            return { type: "text" as const, text: "" }
          })
    return [{ role: "user", content }]
  })
}

/** Convert Anthropic-format messages to AI SDK ModelMessage[] */
function anthropicToModelMessages(
  messages: unknown[],
  systemStr?: string,
  forceClaudeIdentity = false,
): { system: string | undefined; chatMessages: ModelMessage[] } {
  const systemFromMessages = (messages as any[])
    .filter((msg: any) => msg?.role === "system")
    .flatMap((msg: any) => {
      if (typeof msg.content === "string") return [msg.content]
      if (Array.isArray(msg.content)) {
        return (msg.content as any[])
          .filter((p: any) => p?.type === "text" && typeof p?.text === "string")
          .map((p: any) => p.text as string)
      }
      return []
    })
    .filter(Boolean)

  const systemReminderFromUser = (messages as any[])
    .filter((msg: any) => msg?.role === "user")
    .flatMap((msg: any) => {
      if (typeof msg.content === "string") {
        return msg.content.includes("<system-reminder>") ? [msg.content] : []
      }
      if (Array.isArray(msg.content)) {
        return (msg.content as any[])
          .filter((p: any) => p?.type === "text" && typeof p?.text === "string" && p.text.includes("<system-reminder>"))
          .map((p: any) => p.text as string)
      }
      return []
    })
    .filter(Boolean)

  const mergedSystem = enforceClaudeCodeIdentity(
    [systemStr, ...systemFromMessages, ...systemReminderFromUser].filter(Boolean).join("\n") || undefined,
    forceClaudeIdentity,
  )

  // First pass: collect tool_use_id → tool_name from assistant messages
  const toolIdToName: Record<string, string> = {}
  for (const msg of messages as any[]) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      for (const p of msg.content as any[]) {
        if (p.type === "tool_use" && p.id && p.name) {
          toolIdToName[p.id as string] = p.name as string
        }
      }
    }
  }

  const toolOutput = (p: any): string => {
    const c = p.content
    if (typeof c === "string") return c || " "
    if (Array.isArray(c)) return (c as any[]).filter((b: any) => b.type === "text").map((b: any) => b.text).join("") || " "
    return " "
  }

  const converted: ModelMessage[] = (messages as any[]).flatMap((msg): ModelMessage[] => {
    const role = msg.role as string
    const raw = msg.content

    if (role === "system") return []

    if (role === "assistant") {
      if (typeof raw === "string") {
        return [{ role: "assistant", content: [{ type: "text", text: raw }] }]
      }
      const content: any[] = []
      for (const p of raw as any[]) {
        if (p.type === "text" && p.text) {
          content.push({ type: "text", text: p.text as string })
        } else if (p.type === "tool_use") {
          const rawInput = p.input
          const parsedInput =
            typeof rawInput === "string"
              ? (() => { try { return JSON.parse(rawInput) } catch { return {} } })()
              : (rawInput ?? {})
          content.push({ type: "tool-call", toolCallId: p.id, toolName: p.name, input: parsedInput })
        } else if (p.type === "reasoning" || p.type === "thinking") {
          const reasoningText = typeof p.reasoning === "string" ? p.reasoning : (typeof p.text === "string" ? p.text : "")
          if (reasoningText) content.push({ type: "reasoning", text: reasoningText })
        }
      }
      if (content.length === 0) content.push({ type: "text", text: " " })
      return [{ role: "assistant", content }]
    }

    if (role === "user") {
      if (typeof raw === "string") return [{ role: "user", content: raw || " " }]

      if (Array.isArray(raw)) {
        const toolResults = (raw as any[]).filter((p: any) => p.type === "tool_result")
        const otherParts = (raw as any[]).filter((p: any) => p.type !== "tool_result")
        const result: ModelMessage[] = []

        if (toolResults.length > 0) {
          result.push({
            role: "tool" as const,
            content: toolResults.map((p: any) => ({
              type: "tool-result" as const,
              toolCallId: p.tool_use_id ?? "",
              // use collected name mapping — Anthropic doesn't include name in tool_result
              toolName: toolIdToName[p.tool_use_id as string] ?? "unknown",
              output: { type: "text" as const, value: toolOutput(p) },
              isError: p.is_error === true,
            })),
          })
        }

        const textContent = otherParts.flatMap((p: any): any[] => {
          if (p.type === "text" && p.text) return [{ type: "text", text: p.text as string }]
          if (p.type === "image") {
            const src = p.source
            if (src?.type === "base64") return [{ type: "image", image: `data:${src.media_type};base64,${src.data}` }]
            if (src?.type === "url") return [{ type: "image", image: src.url }]
          }
          return []
        })
        if (textContent.length > 0) result.push({ role: "user", content: textContent })
        return result.length > 0 ? result : [{ role: "user", content: " " }]
      }
    }

    return []
  })

  // Post-process: if an assistant message has tool-call parts but the next message is not
  // a tool result (interrupted / cancelled), insert a synthetic tool result so AI SDK
  // schema validation doesn't reject the whole conversation.
  const chatMessages: ModelMessage[] = []
  for (let i = 0; i < converted.length; i++) {
    const msg = converted[i]
    chatMessages.push(msg)
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const toolCalls = (msg.content as any[]).filter((p: any) => p.type === "tool-call")
      if (toolCalls.length > 0) {
        const next = converted[i + 1]
        if (!next || next.role !== "tool") {
          chatMessages.push({
            role: "tool" as const,
            content: toolCalls.map((tc: any) => ({
              type: "tool-result" as const,
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              output: { type: "text" as const, value: "[interrupted]" },
            })),
          })
        }
      }
    }
  }

  return { system: mergedSystem, chatMessages }
}

/** Convert Anthropic tools format to AI SDK tool dictionary */
function anthropicToAISDKTools(tools: unknown[]): Record<string, ReturnType<typeof tool>> {
  const result: Record<string, ReturnType<typeof tool>> = {}
  for (const t of tools as any[]) {
    if (!t.name) continue
    result[t.name] = tool({
      description: t.description ?? "",
      inputSchema: jsonSchema(t.input_schema ?? { type: "object", properties: {} }),
    })
  }
  return result
}

export const V1Routes = lazy(() =>
  new Hono()
    .get("/models", async (c) => {
      log.info("GET /models")
      const data = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const svc = yield* Provider.Service
          const providers = yield* svc.list()
          return Object.values(providers).flatMap((p) =>
            Object.values(p.models).map((m) => ({
              id: `${p.id}/${m.id}`,
              object: "model",
              created: 0,
              owned_by: p.id,
            })),
          )
        }),
      )
      return c.json({ object: "list", data })
    })
    .post("/chat/completions", async (c) => {
      const body = await c.req.json()
      const {
        model: modelStr,
        messages,
        stream = false,
        temperature,
        max_tokens,
        top_p,
        tools: toolsRaw,
        tool_choice,
      }: {
        model: string
        messages: unknown[]
        stream?: boolean
        temperature?: number
        max_tokens?: number
        top_p?: number
        tools?: unknown[]
        tool_choice?: string | { type: string; function?: { name: string } }
      } = body

      const t0 = Date.now()
      const msgs = messages as any[]
      const roleCounts = msgs.reduce((acc: Record<string, number>, m) => { acc[m.role] = (acc[m.role] ?? 0) + 1; return acc }, {})
      const lastUser = msgs.filter(m => m.role === "user").at(-1)
      const lastUserText = typeof lastUser?.content === "string" ? lastUser.content : (lastUser?.content as any[])?.[0]?.text ?? ""
      const toolNames = toolsRaw?.length ? (toolsRaw as any[]).map(t => t.function?.name).filter(Boolean).join(",") : undefined
      log.info(`→ MODEL ${modelStr}`, {
        stream,
        roles: Object.entries(roleCounts).map(([r, n]) => `${r}×${n}`).join(" "),
        tools: toolsRaw?.length ?? 0,
        ...(toolNames ? { tool_names: toolNames } : {}),
        last_user: lastUserText.slice(0, 120).replace(/\n/g, " "),
      })

      const parsed = parseModel(modelStr)
      if (!parsed) {
        log.warn("invalid model format", { model: modelStr })
        return c.json(
          {
            error: {
              message: `model must be in "{providerID}/{modelID}" format, e.g. "github-copilot/gpt-4o"`,
              type: "invalid_request_error",
              code: "invalid_model",
            },
          },
          400,
        )
      }

      const language = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const svc = yield* Provider.Service
          const m = yield* svc.getModel(ProviderID.make(parsed.providerID), ModelID.make(parsed.modelID))
          return yield* svc.getLanguage(m)
        }),
      ).catch((err) => {
        log.error("failed to load model", { model: modelStr, error: String(err) })
        throw err
      })

      const allMessages = toModelMessages(messages)
      const systemParts = allMessages
        .filter((m) => m.role === "system")
        .map((m) => m.content as string)
        .filter(Boolean)
      const chatMessages = allMessages.filter((m) => m.role !== "system")
      const system = systemParts.length ? systemParts.join("\n") : undefined

      const sdkTools = toolsRaw?.length ? toAISDKTools(toolsRaw) : undefined
      const toolChoice =
        !tool_choice || tool_choice === "auto"
          ? "auto"
          : tool_choice === "none"
            ? "none"
            : tool_choice === "required"
              ? "required"
              : typeof tool_choice === "object" && tool_choice.function?.name
                ? { type: "tool" as const, toolName: tool_choice.function.name }
                : "auto"

      const id = `chatcmpl-${crypto.randomUUID()}`
      const created = Math.floor(Date.now() / 1000)

      if (stream) {
        const llmAbort = new AbortController()
        const onReqAbort = () => llmAbort.abort()
        c.req.raw.signal.addEventListener("abort", onReqAbort)
        const opencodeHeaders = parsed.providerID.startsWith("opencode") ? {
          "x-opencode-project": Instance.project.id,
          "x-opencode-session": `ses_${crypto.randomUUID().replace(/-/g, "")}`,
          "x-opencode-request": id,
          "x-opencode-client": Flag.OPENCODE_CLIENT,
          "User-Agent": `opencode/${InstallationVersion}`,
        } : undefined
        const result = streamText({
          model: language as any,
          system,
          messages: chatMessages,
          temperature,
          maxOutputTokens: max_tokens,
          topP: top_p,
          tools: sdkTools,
          toolChoice: sdkTools ? toolChoice : undefined,
          abortSignal: llmAbort.signal,
          maxRetries: 0,
          headers: opencodeHeaders,
        })
        return streamSSE(c, async (s) => {
          // Prime the stream so Bun doesn't treat it as an empty Content-Length: 0 response
          await s.write(": ping\n\n")
          try {
            for await (const event of result.fullStream) {
              if (event.type === "text-delta") {
                await s.writeSSE({
                  data: JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: modelStr,
                    choices: [{ index: 0, delta: { content: event.text }, finish_reason: null }],
                  }),
                })
              } else if (event.type === "reasoning-delta") {
                await s.writeSSE({
                  data: JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: modelStr,
                    choices: [
                      { index: 0, delta: { role: "assistant", reasoning_content: event.text }, finish_reason: null },
                    ],
                  }),
                })
              } else if (event.type === "tool-call") {
                log.info(`← TOOL_CALL ${modelStr}`, { tool: event.toolName, args: JSON.stringify(event.input).slice(0, 200) })
                // emit the complete tool call as a single OpenAI-compatible chunk
                await s.writeSSE({
                  data: JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: modelStr,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          index: 0,
                          id: event.toolCallId,
                          type: "function",
                          function: {
                            name: event.toolName,
                            arguments: JSON.stringify(event.input),
                          },
                        }],
                      },
                      finish_reason: null,
                    }],
                  }),
                })
              } else if (event.type === "error") {
                log.error(`← MODEL ${modelStr} STREAM ERROR`, { error: String((event as any).error), ms: Date.now() - t0 })
                await s.writeSSE({
                  data: JSON.stringify({
                    error: { message: String((event as any).error), type: "api_error" },
                  }),
                })
                await s.writeSSE({ data: "[DONE]" })
              } else if (event.type === "finish-step") {
                log.info(`← MODEL ${modelStr}`, {
                  finish: event.finishReason,
                  in: event.usage?.inputTokens ?? 0,
                  out: event.usage?.outputTokens ?? 0,
                  ms: Date.now() - t0,
                })
                await s.writeSSE({
                  data: JSON.stringify({
                    id,
                    object: "chat.completion.chunk",
                    created,
                    model: modelStr,
                    choices: [{ index: 0, delta: {}, finish_reason: event.finishReason === "tool-calls" ? "tool_calls" : event.finishReason }],
                    usage: {
                      prompt_tokens: event.usage?.inputTokens ?? 0,
                      completion_tokens: event.usage?.outputTokens ?? 0,
                      total_tokens: event.usage?.totalTokens ?? 0,
                    },
                  }),
                })
                await s.writeSSE({ data: "[DONE]" })
              }
            }
          } catch (err) {
            log.error(`← MODEL ${modelStr} STREAM ERROR`, { error: String(err), ms: Date.now() - t0 })
            try {
              await s.writeSSE({
                data: JSON.stringify({
                  error: { message: String(err), type: "api_error" },
                }),
              })
              await s.writeSSE({ data: "[DONE]" })
            } catch { /* stream already closed */ }
          } finally {
            c.req.raw.signal.removeEventListener("abort", onReqAbort)
          }
        })
      }

      // Non-streaming
      let genResult: Awaited<ReturnType<typeof generateText>>
      try {
        const opencodeHeadersNonStream = parsed.providerID.startsWith("opencode") ? {
          "x-opencode-project": Instance.project.id,
          "x-opencode-session": `ses_${crypto.randomUUID().replace(/-/g, "")}`,
          "x-opencode-request": id,
          "x-opencode-client": Flag.OPENCODE_CLIENT,
          "User-Agent": `opencode/${InstallationVersion}`,
        } : undefined
        genResult = await generateText({
          model: language as any,
          system,
          messages: chatMessages,
          temperature,
          maxOutputTokens: max_tokens,
          topP: top_p,
          tools: sdkTools,
          toolChoice: sdkTools ? toolChoice : undefined,
          abortSignal: c.req.raw.signal,
          maxRetries: 0,
          headers: opencodeHeadersNonStream,
        })
      } catch (err) {
        log.error(`← MODEL ${modelStr} ERROR`, { error: String(err), ms: Date.now() - t0 })
        throw err
      }
      const { text, usage, finishReason, toolCalls, reasoningText } = genResult
      log.info(`← MODEL ${modelStr}`, {
        finish: finishReason,
        in: usage.inputTokens,
        out: usage.outputTokens,
        ms: Date.now() - t0,
        ...(toolCalls?.length ? { tool_calls: toolCalls.map(tc => tc.toolName).join(",") } : {}),
        ...(text ? { reply: text.slice(0, 120).replace(/\n/g, " ") } : {}),
      })

      const message: Record<string, unknown> = { role: "assistant", content: text || null }
      if (reasoningText) message["reasoning_content"] = reasoningText
      if (toolCalls?.length) {
        message["tool_calls"] = toolCalls.map((tc, i) => ({
          index: i,
          id: tc.toolCallId,
          type: "function",
          function: { name: tc.toolName, arguments: JSON.stringify(tc.input) },
        }))
      }

      return c.json({
        id,
        object: "chat.completion",
        created,
        model: modelStr,
        choices: [{
          index: 0,
          message,
          finish_reason: finishReason === "tool-calls" ? "tool_calls" : finishReason,
        }],
        usage: {
          prompt_tokens: usage.inputTokens,
          completion_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
        },
      })
    })
    /**
     * Anthropic Messages API format proxy.
     * POST /v1/messages
     * Model format: "{providerID}/{modelID}" (e.g. "opencode/gpt-5-nano")
     * https://docs.anthropic.com/en/api/messages
     */
    .post("/messages", async (c) => {
      const body = await c.req.json()
      const {
        model: modelStr,
        messages,
        system: systemRaw,
        max_tokens = 32000,
        stream = false,
        temperature,
        top_p,
        tools: toolsRaw,
        tool_choice,
      }: {
        model: string
        messages: unknown[]
        system?: string | { type: string; text: string }[]
        max_tokens?: number
        stream?: boolean
        temperature?: number
        top_p?: number
        tools?: unknown[]
        tool_choice?: string | { type: string; name?: string }
      } = body

      // Anthropic allows system to be string / block array / single text block.
      const systemStr = normalizeAnthropicSystem(systemRaw)

      const sdkTools = toolsRaw?.length ? anthropicToAISDKTools(toolsRaw) : undefined
      const toolChoice =
        !tool_choice || tool_choice === "auto"
          ? "auto"
          : tool_choice === "none"
            ? "none"
            : tool_choice === "any" || tool_choice === "required"
              ? "required"
              : typeof tool_choice === "object" && tool_choice.name
                ? { type: "tool" as const, toolName: tool_choice.name }
                : "auto"

      const ua = c.req.header("user-agent") ?? ""
      const clientHint = c.req.header("x-client-name") ?? ""
      const forceClaudeIdentity = /claude/i.test(`${ua} ${clientHint}`)

      const mergedForLog = [systemStr, ...(messages as any[])
        .filter((m: any) => m?.role === "system")
        .flatMap((m: any) => typeof m?.content === "string" ? [m.content] : [])
      ].filter(Boolean).join("\n") || undefined
      const identityEnforced = !!mergedForLog && enforceClaudeCodeIdentity(mergedForLog, forceClaudeIdentity) !== mergedForLog

      log.info(`→ MODEL ${modelStr}`, {
        stream,
        max_tokens,
        ua: ua.slice(0, 60),
        system: Array.isArray(systemRaw) ? `array(${(systemRaw as any[]).length})` : (systemStr ? `${systemStr.length}chars` : "none"),
        identity_enforced: identityEnforced,
        tools: toolsRaw?.length ?? 0,
        roles: (messages as any[]).reduce((acc: Record<string, number>, m) => { acc[m.role] = (acc[m.role] ?? 0) + 1; return acc }, {}),
        last_user: (() => {
          const last = (messages as any[]).filter(m => m.role === "user").at(-1)
          const raw = last?.content
          const t = typeof raw === "string" ? raw : Array.isArray(raw) ? (raw as any[]).find((p: any) => p.type === "text")?.text ?? "" : ""
          return t.slice(0, 120).replace(/\n/g, " ")
        })(),
      })
      const t0 = Date.now()

      const parsed = parseModel(modelStr)
      if (!parsed) {
        log.warn("invalid model format", { model: modelStr })
        return c.json(
          { type: "error", error: { type: "invalid_request_error", message: `model must be in "{providerID}/{modelID}" format` } },
          400,
        )
      }

      const language = await AppRuntime.runPromise(
        Effect.gen(function* () {
          const svc = yield* Provider.Service
          const m = yield* svc.getModel(ProviderID.make(parsed.providerID), ModelID.make(parsed.modelID))
          return yield* svc.getLanguage(m)
        }),
      ).catch((err) => {
        log.error("failed to load model", { model: modelStr, error: String(err) })
        throw err
      })

      const { system, chatMessages } = anthropicToModelMessages(messages as unknown[], systemStr, forceClaudeIdentity)
      const modelMessages = [
        ...(system ? [{ role: "system", content: system } as ModelMessage] : []),
        ...claudeIdentityPrimer(forceClaudeIdentity),
        ...chatMessages,
      ]
      const msgId = `msg_${crypto.randomUUID().replace(/-/g, "")}`

      if (stream) {
        const llmAbort = new AbortController()
        const onReqAbort = () => llmAbort.abort()
        c.req.raw.signal.addEventListener("abort", onReqAbort)
        const opencodeHeaders = parsed.providerID.startsWith("opencode") ? {
          "x-opencode-project": Instance.project.id,
          "x-opencode-session": `ses_${crypto.randomUUID().replace(/-/g, "")}`,
          "x-opencode-request": msgId,
          "x-opencode-client": Flag.OPENCODE_CLIENT,
          "User-Agent": `opencode/${InstallationVersion}`,
        } : undefined
        const result = streamText({
          model: language as any,
          messages: modelMessages,
          temperature,
          maxOutputTokens: max_tokens,
          topP: top_p,
          tools: sdkTools,
          toolChoice: sdkTools ? toolChoice : undefined,
          abortSignal: llmAbort.signal,
          maxRetries: 0,
          headers: opencodeHeaders,
        })

        return streamSSE(c, async (s) => {
          try {
            // message_start
            await s.writeSSE({
              event: "message_start",
              data: JSON.stringify({
                type: "message_start",
                message: { id: msgId, type: "message", role: "assistant", content: [], model: modelStr,
                  stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 1 } },
              }),
            })
            await s.write(": ping\n\n")

            let blockIndex = -1
            let textBlockOpen = false

            for await (const event of result.fullStream) {
              if (event.type === "text-delta") {
                if (!textBlockOpen) {
                  blockIndex++
                  await s.writeSSE({
                    event: "content_block_start",
                    data: JSON.stringify({ type: "content_block_start", index: blockIndex, content_block: { type: "text", text: "" } }),
                  })
                  textBlockOpen = true
                }
                await s.writeSSE({
                  event: "content_block_delta",
                  data: JSON.stringify({ type: "content_block_delta", index: blockIndex,
                    delta: { type: "text_delta", text: event.text } }),
                })
              } else if (event.type === "tool-call") {
                if (textBlockOpen) {
                  await s.writeSSE({ event: "content_block_stop",
                    data: JSON.stringify({ type: "content_block_stop", index: blockIndex }) })
                  textBlockOpen = false
                }
                blockIndex++
                await s.writeSSE({
                  event: "content_block_start",
                  data: JSON.stringify({ type: "content_block_start", index: blockIndex,
                    content_block: { type: "tool_use", id: event.toolCallId, name: event.toolName, input: {} } }),
                })
                await s.writeSSE({
                  event: "content_block_delta",
                  data: JSON.stringify({ type: "content_block_delta", index: blockIndex,
                    delta: { type: "input_json_delta", partial_json: JSON.stringify(event.input) } }),
                })
                await s.writeSSE({ event: "content_block_stop",
                  data: JSON.stringify({ type: "content_block_stop", index: blockIndex }) })
                log.info(`← TOOL_CALL ${modelStr}`, { tool: event.toolName })
              } else if (event.type === "reasoning-delta") {
                if (textBlockOpen) {
                  await s.writeSSE({ event: "content_block_stop",
                    data: JSON.stringify({ type: "content_block_stop", index: blockIndex }) })
                  textBlockOpen = false
                }
                blockIndex++
                await s.writeSSE({
                  event: "content_block_start",
                  data: JSON.stringify({ type: "content_block_start", index: blockIndex,
                    content_block: { type: "thinking", thinking: "" } }),
                })
                await s.writeSSE({
                  event: "content_block_delta",
                  data: JSON.stringify({ type: "content_block_delta", index: blockIndex,
                    delta: { type: "thinking_delta", thinking: event.text } }),
                })
                await s.writeSSE({ event: "content_block_stop",
                  data: JSON.stringify({ type: "content_block_stop", index: blockIndex }) })
              } else if (event.type === "error") {
                log.error(`← MODEL ${modelStr} STREAM ERROR`, { error: String((event as any).error), ms: Date.now() - t0 })
                await s.writeSSE({
                  event: "error",
                  data: JSON.stringify({ type: "error", error: { type: "api_error", message: String((event as any).error) } }),
                })
              } else if (event.type === "finish-step") {
                if (textBlockOpen) {
                  await s.writeSSE({ event: "content_block_stop",
                    data: JSON.stringify({ type: "content_block_stop", index: blockIndex }) })
                }
                const stopReason =
                  event.finishReason === "stop" ? "end_turn"
                  : event.finishReason === "length" ? "max_tokens"
                  : event.finishReason === "tool-calls" ? "tool_use"
                  : "end_turn"
                await s.writeSSE({
                  event: "message_delta",
                  data: JSON.stringify({ type: "message_delta",
                    delta: { stop_reason: stopReason, stop_sequence: null },
                    usage: { output_tokens: event.usage?.outputTokens ?? 0 } }),
                })
                log.info(`← MODEL ${modelStr}`, { stop: stopReason, out: event.usage?.outputTokens ?? 0, ms: Date.now() - t0 })
                await s.writeSSE({ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) })
              }
            }
          } catch (err) {
            log.error(`← MODEL ${modelStr} STREAM ERROR`, { error: String(err), ms: Date.now() - t0 })
            try {
              await s.writeSSE({
                event: "error",
                data: JSON.stringify({ type: "error", error: { type: "api_error", message: String(err) } }),
              })
            } catch { /* stream already closed */ }
          } finally {
            c.req.raw.signal.removeEventListener("abort", onReqAbort)
          }
        })
      }

      // Non-streaming
      let genResult: Awaited<ReturnType<typeof generateText>>
      try {
        const opencodeHeaders = parsed.providerID.startsWith("opencode") ? {
          "x-opencode-project": Instance.project.id,
          "x-opencode-session": `ses_${crypto.randomUUID().replace(/-/g, "")}`,
          "x-opencode-request": msgId,
          "x-opencode-client": Flag.OPENCODE_CLIENT,
          "User-Agent": `opencode/${InstallationVersion}`,
        } : undefined
        genResult = await generateText({
          model: language as any,
          messages: modelMessages,
          temperature,
          maxOutputTokens: max_tokens,
          topP: top_p,
          tools: sdkTools,
          toolChoice: sdkTools ? toolChoice : undefined,
          abortSignal: c.req.raw.signal,
          maxRetries: 0,
          headers: opencodeHeaders,
        })
      } catch (err) {
        log.error(`← MODEL ${modelStr} ERROR`, { error: String(err), ms: Date.now() - t0 })
        return c.json(
          { type: "error", error: { type: "api_error", message: String(err) } },
          500,
        )
      }
      const { text, usage, finishReason, toolCalls, reasoningText } = genResult
      const stopReason =
        finishReason === "stop" ? "end_turn"
        : finishReason === "length" ? "max_tokens"
        : finishReason === "tool-calls" ? "tool_use"
        : "end_turn"
      log.info(`← MODEL ${modelStr}`, {
        stop: stopReason,
        in: usage.inputTokens,
        out: usage.outputTokens,
        ms: Date.now() - t0,
        ...(toolCalls?.length ? { tool_calls: toolCalls.map(tc => tc.toolName).join(",") } : {}),
        ...(text ? { reply: text.slice(0, 120).replace(/\n/g, " ") } : {}),
      })

      // Build content array: reasoning block + text block + tool_use blocks
      const content: any[] = []
      if (reasoningText) content.push({ type: "reasoning", reasoning: reasoningText })
      if (text) content.push({ type: "text", text })
      for (const tc of toolCalls ?? []) {
        content.push({ type: "tool_use", id: tc.toolCallId, name: tc.toolName, input: tc.input })
      }
      if (content.length === 0) content.push({ type: "text", text: "" })

      return c.json({
        id: msgId,
        type: "message",
        role: "assistant",
        content,
        model: modelStr,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
        },
      })
    }),
)

