import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { createServer } from "node:http"
import type { Credential } from "@opencode/plugin"
import { Integration } from "@opencode/plugin"
import { CLIENT_ID, LOGIN_TIMEOUT, LOGIN_URL, MANUAL_REDIRECT, SCOPES, TOKEN_URL } from "./constants.ts"
import { JetBrainsError } from "./errors.ts"

export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function createProof() {
  const verifier = randomBytes(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url"), state: randomUUID() }
}

export function loginURL(challenge: string, state: string, redirect: string): string {
  const url = new URL(LOGIN_URL)
  url.search = new URLSearchParams({
    client_id: CLIENT_ID, scope: SCOPES, state, code_challenge: challenge, redirect_uri: redirect,
  }).toString()
  return url.toString()
}

export function equalState(actual: string | null, expected: string): boolean {
  if (!actual) return false
  const a = Buffer.from(actual)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Share refreshes across plugin instances to avoid rotating the same token twice.
type RefreshEntry = { until: number; promise: Promise<Credential.OAuth> }
const refreshKey = Symbol.for("opencode.jetbrains.refresh.v1")
const shared = globalThis as typeof globalThis & { [refreshKey]?: Map<string, RefreshEntry> }
const refreshes = shared[refreshKey] ??= new Map<string, RefreshEntry>()

export class TokenClient {
  constructor(private readonly fetcher: Fetch = fetch, private readonly now = Date.now) {}

  private async exchange(fields: Record<string, string>, methodID: string, old?: Credential.OAuth, signal?: AbortSignal): Promise<Credential.OAuth> {
    let response: Response
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams({ client_id: CLIENT_ID, ...fields }),
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      })
    } catch {
      throw new JetBrainsError("JetBrains token request failed or was cancelled.")
    }
    if (!response.ok) {
      const needsLogin = response.status === 400 || response.status === 401
      let oauthError = ""
      try {
        const body = await response.json() as Record<string, unknown>
        if (["invalid_grant", "invalid_request", "unauthorized_client", "unsupported_grant_type", "invalid_scope", "invalid_client", "access_denied"].includes(String(body?.error))) {
          oauthError = `, ${body.error}`
        }
      } catch { /* Some errors have an empty or non-JSON body. */ }
      throw new JetBrainsError(
        `JetBrains token service returned HTTP ${response.status}${oauthError}.${needsLogin ? " Start a new login and sign in again." : ""}`,
        needsLogin,
      )
    }
    let data: Record<string, unknown>
    try { data = await response.json() as Record<string, unknown> } catch {
      throw new JetBrainsError("JetBrains returned an invalid token response.")
    }
    const refresh = typeof data?.refresh_token === "string" && data.refresh_token ? data.refresh_token : old?.refresh
    const seconds = data?.expires_in
    if (data?.token_type !== undefined && (typeof data.token_type !== "string" || data.token_type.toLowerCase() !== "bearer")) {
      throw new JetBrainsError("JetBrains returned an unsupported token type.")
    }
    const invalid = [
      ...(typeof data?.access_token !== "string" || !data.access_token ? ["access_token"] : []),
      ...(!refresh ? ["refresh_token"] : []),
      ...(typeof seconds !== "number" || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 31_536_000 ? ["expires_in"] : []),
    ]
    if (invalid.length) {
      throw new JetBrainsError(`JetBrains token response is missing required fields or has invalid values: ${invalid.join(", ")}.`)
    }
    return {
      type: "oauth", methodID: Integration.MethodID.make(methodID),
      access: data.access_token as string, refresh: refresh!, expires: this.now() + (seconds as number) * 1000,
    }
  }

  code(code: string, verifier: string, redirect: string, methodID: string, signal?: AbortSignal) {
    if (!code || code.length > 4096 || /\s/.test(code)) throw new JetBrainsError("Enter the authorization code only.")
    return this.exchange({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirect }, methodID, undefined, signal)
  }

  refresh(credential: Credential.OAuth): Promise<Credential.OAuth> {
    const key = createHash("sha256").update(credential.refresh).digest("hex")
    const now = this.now()
    for (const [id, entry] of refreshes) if (entry.until < now) refreshes.delete(id)
    const existing = refreshes.get(key)
    if (existing) return existing.promise
    const promise = this.exchange({ grant_type: "refresh_token", refresh_token: credential.refresh }, credential.methodID, credential)
    const entry = { until: Infinity, promise }
    refreshes.set(key, entry)
    void promise.then(() => { entry.until = this.now() + 5 * 60_000 }, () => { refreshes.delete(key) })
    return promise
  }
}

export function manualLogin(tokens: TokenClient, timeout = LOGIN_TIMEOUT) {
  const proof = createProof()
  const controller = new AbortController()
  const expiresAt = Date.now() + timeout
  let used = false
  return {
    url: loginURL(proof.challenge, proof.state, MANUAL_REDIRECT), expiresAt,
    cancel: () => controller.abort(),
    complete: (input: string) => {
      if (used || Date.now() >= expiresAt || controller.signal.aborted) throw new JetBrainsError("Login attempt expired. Start a new login.")
      let code = input.trim()
      // Callback URLs include state. Plain codes are checked through PKCE.
      if (code.startsWith("https://")) {
        let url: URL
        try { url = new URL(code) } catch { throw new JetBrainsError("Invalid callback URL.") }
        if (url.origin + url.pathname !== MANUAL_REDIRECT || !equalState(url.searchParams.get("state"), proof.state)) {
          throw new JetBrainsError("The callback does not match this login attempt.")
        }
        code = url.searchParams.get("code") ?? ""
      } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(code) && code.length <= 16_384) {
        // JetBrains' manual-login page can wrap the code in base64-encoded JSON.
        // Plain OAuth codes also fit this alphabet, so keep them if decoding fails.
        try {
          const decoded: unknown = JSON.parse(Buffer.from(code, "base64").toString("utf8"))
          if (decoded && typeof decoded === "object" && "code" in decoded && typeof decoded.code === "string") {
            code = decoded.code
          }
        } catch { /* Plain authorization code. */ }
      }
      used = true
      return tokens.code(code, proof.verifier, MANUAL_REDIRECT, "manual", controller.signal)
    },
  }
}

export async function browserLogin(tokens: TokenClient, timeout = LOGIN_TIMEOUT) {
  const proof = createProof()
  const controller = new AbortController()
  let resolve!: (credential: Credential.OAuth) => void
  let reject!: (error: unknown) => void
  const result = new Promise<Credential.OAuth>((yes, no) => { resolve = yes; reject = no })
  void result.catch(() => {}) // Login can be cancelled before OpenCode awaits this.
  let claimed = false
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let redirect = ""
  const server = createServer(async (request, response) => {
    const reply = (status: number, message: string) => {
      response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
      response.end(message)
    }
    let url: URL
    try { url = new URL(request.url ?? "/", redirect) } catch { return reply(400, "Invalid callback URL.") }
    if (request.method !== "GET" || url.pathname !== "/") return reply(404, "Not found.")
    if (!equalState(url.searchParams.get("state"), proof.state)) return reply(400, "Login state did not match.")
    if (claimed || settled) return reply(409, "Login attempt already handled.")
    if (url.searchParams.has("error")) {
      reply(400, "JetBrains login was cancelled or rejected.")
      finish(new JetBrainsError("JetBrains login was cancelled or rejected."))
      return
    }
    const code = url.searchParams.get("code")
    if (!code) return reply(400, "Missing authorization code.")
    claimed = true
    try {
      const credential = await tokens.code(code, proof.verifier, redirect, "browser", controller.signal)
      reply(200, "JetBrains login complete. You can return to OpenCode.")
      finish(undefined, credential)
    } catch (error) {
      reply(400, "Login failed. Start a new login in OpenCode.")
      finish(error instanceof JetBrainsError ? error : new JetBrainsError("JetBrains login failed. Start a new login."))
    }
  })
  function finish(error?: unknown, credential?: Credential.OAuth) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    controller.abort()
    server.close()
    if (error) reject(error)
    else resolve(credential!)
  }
  await new Promise<void>((yes, no) => {
    server.once("error", () => no(new JetBrainsError("Could not start the local login listener.")))
    server.listen(0, "127.0.0.1", () => yes())
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new JetBrainsError("Could not start the local login listener.")
  redirect = `http://localhost:${address.port}`
  timer = setTimeout(() => finish(new JetBrainsError("JetBrains login timed out.")), timeout)
  timer.unref()
  return {
    url: loginURL(proof.challenge, proof.state, redirect), result,
    expiresAt: Date.now() + timeout,
    cancel: () => finish(new JetBrainsError("JetBrains login cancelled.")),
  }
}
