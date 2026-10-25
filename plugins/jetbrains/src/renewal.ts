import { createHash } from "node:crypto"
import type { Credential } from "@opencode/plugin"
import type { Fetch } from "./auth.ts"
import { canRenewQuotaOnly, inferenceExpiry, REFRESH_WINDOW, scheduleCredential } from "./credential-expiry.ts"
import { prepareQuotaAuth, readQuotaAuth } from "./quota-auth.ts"

type Entry = { until: number; promise: Promise<Credential.OAuth> }
const symbol = Symbol.for("opencode.jetbrains.refresh.v5")
const shared = globalThis as typeof globalThis & { [symbol]?: Map<string, Entry> }
const entries = shared[symbol] ??= new Map<string, Entry>()

// Coordinates credential renewal through OpenCode's managed callbacks.
export class CredentialRenewal {
  constructor(private readonly fetcher: Fetch = fetch, private readonly now = Date.now) {}

  async prepare(credential: Credential.OAuth, idToken: unknown, signal?: AbortSignal): Promise<Credential.OAuth> {
    const next = await prepareQuotaAuth(credential, idToken, this.fetcher, this.now, signal)
    return scheduleCredential(next, this.now())
  }

  refresh(credential: Credential.OAuth, fullRefresh: () => Promise<Credential.OAuth>): Promise<Credential.OAuth> {
    // Include the schedule: nonrotating refresh tokens must not hide a later renewal.
    const key = createHash("sha256").update(JSON.stringify([credential.refresh, credential.access, credential.expires])).digest("hex")
    for (const [id, entry] of entries) if (entry.until <= this.now()) entries.delete(id)
    const existing = entries.get(key)
    if (existing) return existing.promise
    const auth = readQuotaAuth(credential)
    const promise = canRenewQuotaOnly(credential, this.now()) && auth?.idToken
      ? this.prepare({ ...credential, expires: inferenceExpiry(credential) }, auth.idToken)
      : fullRefresh()
    const entry = { until: Infinity, promise }
    entries.set(key, entry)
    void promise.then(next => {
      entry.until = Math.min(this.now() + REFRESH_WINDOW, next.expires - REFRESH_WINDOW)
    }, () => { entries.delete(key) })
    return promise
  }
}
