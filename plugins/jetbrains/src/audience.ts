import type { Fetch } from "./auth.ts"
import { CLIENT_ID, TOKEN_URL } from "./constants.ts"
import { JetBrainsError } from "./errors.ts"
import { jwtExpiration } from "./jwt.ts"

export class AudienceError extends JetBrainsError {
  constructor(message: string, readonly invalidOrgsUserInfo = false) { super(message) }
}

// One instance per managed renewal. Always uses the latest rotated grant,
// including rotations returned before a later response-validation failure.
export class AudienceClient {
  constructor(public refresh: string, private readonly fetcher: Fetch, private readonly now: () => number,
    private readonly signal?: AbortSignal) {}

  private deadline(): AbortSignal {
    const timeout = AbortSignal.timeout(8000)
    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout
  }

  async mint(audience: string, label: string, sourceExpiry: number, fields: Record<string, string> = {}): Promise<{ token: string; expires: number }> {
    const response = await this.fetcher(TOKEN_URL, {
      method: "POST", redirect: "error", signal: this.deadline(),
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: CLIENT_ID, grant_type: "switch_audience", refresh_token: this.refresh, audience, ...fields }),
    })
    if (!response.ok) {
      let invalidOrgsUserInfo = false
      try {
        const value = await response.json() as Record<string, unknown>
        const error = value?.error
        invalidOrgsUserInfo = error === "invalid_orgs_user_info" || !!(error && typeof error === "object" && (error as Record<string, unknown>).code === "invalid_orgs_user_info")
      } catch { /* Never expose arbitrary server response text. */ }
      throw new AudienceError(`${label} returned HTTP ${response.status}${invalidOrgsUserInfo ? " (invalid_orgs_user_info)" : ""}.`, invalidOrgsUserInfo)
    }
    const value = await response.json() as Record<string, unknown>
    const rotated = typeof value?.refresh_token === "string" && value.refresh_token.length > 0
    if (rotated) this.refresh = value.refresh_token as string
    const token = typeof value?.access_token === "string" && value.access_token.length <= 65_536 && !/\s/.test(value.access_token) ? value.access_token : undefined
    const bearer = value?.token_type === undefined || typeof value.token_type === "string" && value.token_type.toLowerCase() === "bearer"
    const seconds = value?.expires_in
    const expires = typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 31_536_000
      ? this.now() + seconds * 1000 : token ? jwtExpiration(token) : null
    if (!token || !bearer || expires === null || expires <= this.now()) throw new JetBrainsError(`${label} returned an invalid management token.`)
    return { token, expires: Math.min(expires, sourceExpiry) }
  }

  async membership(token: string): Promise<string> {
    const response = await this.fetcher("https://api.jetbrains.cloud/org/orgsuserinfo", {
      method: "GET", redirect: "error", signal: this.deadline(),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })
    if (!response.ok) throw new JetBrainsError(`Organization membership lookup returned HTTP ${response.status}.`)
    const body = await response.text()
    const jwt = body.length <= 65_536 ? /[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/.exec(body)?.[0] : undefined
    if (!jwt) throw new JetBrainsError("Organization membership lookup returned an invalid response.")
    return jwt
  }
}
