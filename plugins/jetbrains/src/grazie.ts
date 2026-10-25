import { createHash } from "node:crypto"
import type { Fetch } from "./auth.ts"
import { JetBrainsError, retryAfter, safeError } from "./errors.ts"
import { metadataError } from "./metadata-error.ts"
import { emptyQuota, readQuota, type QuotaResponse } from "./quota.ts"
import { jwtExpiration } from "./jwt.ts"

const GRAZIE = "https://api.jetbrains.ai"
export type GrazieIdentity = { accountKey: string; licenseID: string; idToken: string }
type Token = { value: string; expires: number }
type Entry = { accountKey: string; token?: Token; pending?: Promise<string> }

function identityKey(identity: GrazieIdentity): string {
  return createHash("sha256").update(JSON.stringify([identity.accountKey, identity.licenseID, identity.idToken])).digest("hex")
}

// Caches Grazie tokens in memory, bounded by the source ID token's expiry.
export class GrazieTokens {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly fetcher: Fetch = fetch, private readonly now = Date.now) {}

  async get(identity: GrazieIdentity): Promise<string> {
    if (!identity.accountKey || !identity.licenseID.trim() || identity.licenseID.length > 512 || /[\x00-\x1f\x7f]/.test(identity.licenseID)) {
      throw new JetBrainsError("Grazie authentication requires an account and a valid license selection.")
    }
    const sourceExpiry = jwtExpiration(identity.idToken)
    if (sourceExpiry === null || sourceExpiry <= this.now()) throw new JetBrainsError("A valid, unexpired OAuth ID token is required for Grazie authentication.")
    const key = identityKey(identity)
    let entry = this.entries.get(key)
    if (entry?.pending) return entry.pending
    if (entry?.token && entry.token.expires - 60_000 > this.now()) return entry.token.value
    if (!entry) {
      for (const [id, value] of this.entries) {
        if (!value.pending && (!value.token || value.token.expires <= this.now())) this.entries.delete(id)
      }
      if (this.entries.size >= 128) {
        const idle = [...this.entries].find(([, value]) => !value.pending)
        if (!idle) throw new JetBrainsError("Grazie authentication is busy. Try again later.")
        this.entries.delete(idle[0])
      }
      entry = { accountKey: identity.accountKey }
      this.entries.set(key, entry)
    }
    const current = entry
    const pending = this.exchange(identity, sourceExpiry).then(token => {
      if (this.entries.get(key) !== current) throw new JetBrainsError("Grazie account state changed. Retry the request.")
      current.token = token
      return token.value
    })
    current.pending = pending
    try { return await pending }
    finally {
      current.pending = undefined
      if (!current.token && this.entries.get(key) === current) this.entries.delete(key)
    }
  }

  invalidate(identity: GrazieIdentity, rejectedToken: string): void {
    const entry = this.entries.get(identityKey(identity))
    if (entry?.token?.value === rejectedToken) entry.token = undefined
  }

  clearAccount(accountKey: string): void {
    for (const [id, entry] of this.entries) if (entry.accountKey === accountKey) this.entries.delete(id)
  }

  private async exchange(identity: GrazieIdentity, sourceExpiry: number): Promise<Token> {
    let response: Response
    try {
      response = await this.fetcher(`${GRAZIE}/auth/jetbrains-jwt/provide-access/license/v2`, {
        method: "POST", body: JSON.stringify({ licenseId: identity.licenseID }),
        headers: { Authorization: `Bearer ${identity.idToken}`, Accept: "application/json", "Content-Type": "application/json" },
        redirect: "error", signal: AbortSignal.timeout(8000),
      })
    } catch { throw new JetBrainsError("Grazie token exchange failed or timed out.") }
    if (!response.ok) throw new JetBrainsError(`Grazie token exchange returned HTTP ${response.status}${await metadataError(response)}.`, false,
      response.status === 429 ? retryAfter(response, this.now()) : undefined)
    let value: unknown
    try { value = await response.json() } catch { throw new JetBrainsError("Grazie token exchange returned an invalid response.") }
    const token = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).token : undefined
    const expires = typeof token === "string" ? jwtExpiration(token) : null
    if (typeof token !== "string" || expires === null) throw new JetBrainsError("Grazie token exchange returned an invalid token.")
    if (expires <= this.now() || sourceExpiry <= this.now()) throw new JetBrainsError("Grazie token exchange returned an expired token.")
    return { value: token, expires: Math.min(expires, sourceExpiry) }
  }
}

export class GrazieQuotaClient {
  constructor(private readonly tokens: GrazieTokens, private readonly fetcher: Fetch = fetch, private readonly now = Date.now) {}

  async get(identity: GrazieIdentity): Promise<QuotaResponse> {
    try {
      const token = await this.tokens.get(identity)
      const [quota, refill] = await Promise.all([
        this.metadata(identity, token, "/user/v5/quota/get"),
        this.metadata(identity, token, "/user/v5/quota/metadata/refill"),
      ])
      return { ...readQuota(quota.value, refill.value), quotaError: [quota.error, refill.error].filter(Boolean).join(" ") || null,
        retryAt: Math.max(quota.retryAt ?? 0, refill.retryAt ?? 0) || undefined }
    } catch (error) {
      return { ...emptyQuota(), quotaError: safeError(error), ...(error instanceof JetBrainsError && error.retryAfter
        ? { retryAt: this.now() + error.retryAfter } : {}) }
    }
  }

  private async metadata(identity: GrazieIdentity, token: string, path: string): Promise<{ value?: unknown; error: string | null; retryAt?: number }> {
    const name = path.endsWith("/refill") ? "Refill metadata" : "Quota metadata"
    try {
      const request = (value: string) => this.fetcher(`${GRAZIE}${path}`, {
        method: "POST", body: "{}", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { "Grazie-Authenticate-JWT": value, Accept: "application/json", "Content-Type": "application/json" },
      })
      let response = await request(token)
      if (response.status === 401) {
        await response.body?.cancel().catch(() => {})
        this.tokens.invalidate(identity, token)
        response = await request(await this.tokens.get(identity))
      }
      if (!response.ok) return { error: `${name} request returned HTTP ${response.status}${await metadataError(response)}.`,
        retryAt: response.status === 429 ? this.now() + retryAfter(response, this.now()) : undefined }
      try { return { value: await response.json(), error: null } }
      catch { return { error: `${name} request returned an invalid response.` } }
    } catch (error) {
      return { error: error instanceof JetBrainsError ? error.message : `${name} request failed or timed out.`,
        ...(error instanceof JetBrainsError && error.retryAfter ? { retryAt: this.now() + error.retryAfter } : {}) }
    }
  }
}
