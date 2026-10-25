import type { Credential } from "@opencode/plugin"
import { jwtExpiration } from "./jwt.ts"
import { readQuotaAuth } from "./quota-auth.ts"

// OpenCode invokes managed OAuth refresh five minutes before `expires`.
export const REFRESH_WINDOW = 5 * 60_000
export const MIN_QUOTA_REFRESH_INTERVAL = 60_000
export const QUOTA_RETRY_INTERVAL = 5 * 60_000

export function inferenceExpiry(credential: Credential.OAuth): number {
  const value = credential.metadata?.jetbrainsInferenceExpires
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : credential.expires
}

export function canRenewQuotaOnly(credential: Credential.OAuth, now: number): boolean {
  const idToken = readQuotaAuth(credential)?.idToken
  const idExpiry = typeof idToken === "string" ? jwtExpiration(idToken) : null
  const window = credential.metadata?.jetbrainsIDTokenRefreshAfter === idExpiry ? 0 : REFRESH_WINDOW
  return inferenceExpiry(credential) > now + REFRESH_WINDOW && idExpiry !== null && idExpiry > now + window
}

// `expires` schedules the next managed callback. Metadata keeps the actual
// inference expiry. A short-lived quota token must not cause a tight refresh
// loop just because its entire lifetime is below OpenCode's early-refresh window.
export function scheduleCredential(credential: Credential.OAuth, now: number): Credential.OAuth {
  const actualExpiry = inferenceExpiry(credential)
  let expires = actualExpiry
  const quota = readQuotaAuth(credential)
  if (typeof quota?.idToken === "string") {
    const idExpiry = jwtExpiration(quota.idToken)
    const retainedID = idExpiry !== null && credential.metadata?.jetbrainsIDTokenRefreshAfter === idExpiry
    if (quota.error) {
      expires = Math.min(expires, now + REFRESH_WINDOW + QUOTA_RETRY_INTERVAL)
    } else {
      const candidates = [
        idExpiry,
        typeof quota.managementToken === "string" && quota.managementToken ? quota.expires : null,
        typeof quota.workspace?.token === "string" && quota.workspace.token ? quota.workspace.expires : null,
      ]
      for (const expiry of candidates) {
        if (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry <= now) continue
        // Audience tokens are capped by the ID token. Delay early renewal for
        // that shared bound after a full refresh has already omitted its replacement.
        const scheduled = retainedID && expiry === idExpiry ? expiry + REFRESH_WINDOW : expiry
        expires = Math.min(expires, Math.max(scheduled, now + REFRESH_WINDOW + MIN_QUOTA_REFRESH_INTERVAL))
      }
    }
  }
  return { ...credential, expires, metadata: { ...credential.metadata, jetbrainsInferenceExpires: actualExpiry } }
}
