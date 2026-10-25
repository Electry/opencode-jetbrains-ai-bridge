import { createHash } from "node:crypto"
import { ANTHROPIC_HEADERS, GATEWAY, HEADERS, PROVIDER_ID } from "./constants.ts"
import { catalogModel } from "./catalog.ts"
import type { Account } from "./account.ts"
import { JetBrainsError } from "./errors.ts"

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

export function requestKeys(account: string, session: string, model: string, kind: string, createdAt: number) {
  const identity = JSON.stringify([account, session])
  const stamp = new Date(createdAt).toISOString().replace(/\D/g, "").slice(2, 14)
  return {
    execution: `session-${stamp.slice(0, 6)}-${stamp.slice(6)}-${hash(identity).slice(0, 4)}`,
    cache: `junie-${hash(JSON.stringify([PROVIDER_ID, account, session, model, kind])).slice(0, 48)}`,
  }
}

export async function prepareRequest(
  request: Request, account: Account, session: string, model: string, kind: string, createdAt: number,
): Promise<Request> {
  const url = new URL(request.url)
  const entry = catalogModel(model)
  const anthropic = entry?.protocol === "anthropic"
  if (url.origin !== GATEWAY || url.pathname !== (anthropic ? "/v1/messages" : "/v1/responses") ||
      (url.search && !(anthropic && url.search === "?beta=true"))) {
    throw new JetBrainsError("Refusing to send JetBrains credentials to an unexpected endpoint.")
  }
  if (!entry) throw new JetBrainsError("Unknown JetBrains model ID.")
  if (request.method !== "POST") throw new JetBrainsError("Unexpected JetBrains inference method.")
  let body: Record<string, unknown>
  try {
    body = await request.clone().json() as Record<string, unknown>
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error()
  } catch {
    throw new JetBrainsError("Invalid JetBrains inference request body.")
  }
  if (body.model !== model) throw new JetBrainsError("JetBrains request model does not match the selected model.")
  if (entry.protocol === "anthropic" && entry.disableParallelTools && Array.isArray(body.tools) && body.tools.length > 0) {
    const choice = body.tool_choice as Record<string, unknown> | undefined
    // Haiku uses tools serially. Keep the requested choice, including "none".
    // Anthropic requires tools to be present when setting tool_choice.
    if (choice?.type !== "none") body.tool_choice = { ...(choice ?? { type: "auto" }), disable_parallel_tool_use: true }
  }
  const keys = requestKeys(account.key, session, model, kind, createdAt)
  const headers = new Headers(request.headers)
  // Drop credentials and headers left over from another provider.
  headers.delete("x-api-key")
  if (anthropic) headers.delete("Openai-Version")
  else { headers.delete("anthropic-version"); headers.delete("anthropic-beta") }
  const betas = anthropic ? [...new Set([
    ...ANTHROPIC_HEADERS["anthropic-beta"].split(","),
    ...(headers.get("anthropic-beta") ?? "").split(",").map(value => value.trim()).filter(Boolean),
  ])].join(",") : undefined
  for (const [key, value] of Object.entries(anthropic ? ANTHROPIC_HEADERS : HEADERS)) headers.set(key, value)
  if (betas) headers.set("anthropic-beta", betas)
  headers.set("Authorization", `Bearer ${account.access}`)
  headers.set("X-Client-Execution-Id", keys.execution)
  headers.delete("Content-Length")
  const init = {
    headers,
    body: JSON.stringify(anthropic ? body : { ...body, store: false, prompt_cache_key: keys.cache, prompt_cache_retention: "24h" }),
    redirect: "error" as const,
  }
  // Junie uses beta headers with a queryless URL. Carry over the abort signal
  // when rebuilding the Anthropic request.
  return anthropic
    ? new Request(`${GATEWAY}/v1/messages`, { ...init, method: request.method, signal: request.signal })
    : new Request(request, init)
}
