import { createOpencodeClient } from "@opencode-ai/sdk/v2"

const SESSION_ID_RE = /^ses_[a-zA-Z0-9]+$/

export async function validateSession(input: {
  url: string
  sessionID?: string
  directory?: string
  fetch?: typeof fetch
  headers?: RequestInit["headers"]
}) {
  if (!input.sessionID) return

  if (!SESSION_ID_RE.test(input.sessionID)) {
    throw new Error(`Invalid session ID: ${input.sessionID}`)
  }

  await createOpencodeClient({
    baseUrl: input.url,
    directory: input.directory,
    fetch: input.fetch,
    headers: input.headers,
  }).session.get({ sessionID: input.sessionID }, { throwOnError: true })
}
