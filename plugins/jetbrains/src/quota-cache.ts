import { createHash } from "node:crypto"
import type { Account } from "./account.ts"
import { JetBrainsError, safeError } from "./errors.ts"
import { emptyQuota, type QuotaSnapshot } from "./quota.ts"
import type { QuotaResult } from "./quota-service.ts"

export type QuotaView = QuotaSnapshot & {
  quotaState: "loading" | "ready" | "stale" | "error"
  quotaUpdatedAt: number | null
}
type Entry = { view: QuotaView; identity?: string; nextFetch: number; pending?: Promise<void> }
type Source = { get(account: Account): Promise<QuotaResult> }
const symbol = Symbol.for("opencode.jetbrains.quota-cache.v1")
const shared = globalThis as typeof globalThis & { [symbol]?: Map<string, Entry> }
const entries = shared[symbol] ??= new Map<string, Entry>()

// Key by credentials so renewed grants bypass cached authentication failures.
function key(account: Account): string {
  return createHash("sha256").update(JSON.stringify([account.key, account.access, account.oauth?.metadata?.jetbrainsQuota])).digest("hex")
}

export class QuotaCache {
  private readonly entries = entries
  private readonly observed = new WeakSet<Promise<void>>()

  constructor(private readonly source: Source, private readonly changed: () => void = () => {}, private readonly now = Date.now, private readonly interval = 60_000) {}

  get(account: Account, force = false): QuotaView {
    const id = key(account)
    let entry = this.entries.get(id)
    if (!entry) {
      if (this.entries.size >= 128) {
        const idle = [...this.entries].find(([, value]) => !value.pending)
        if (idle) this.entries.delete(idle[0])
        else return { ...emptyQuota(), quotaState: "error", quotaUpdatedAt: null, quotaError: "Plan details service is busy. Try again later." }
      }
      entry = { view: { ...emptyQuota(), quotaState: "loading", quotaUpdatedAt: null }, nextFetch: 0 }
      this.entries.set(id, entry)
    }
    const waitUntil = force && entry.view.quotaState === "ready"
      ? Math.min(entry.nextFetch, (entry.view.quotaUpdatedAt ?? 0) + 5000) : entry.nextFetch
    if (!entry.pending && this.now() >= waitUntil) {
      const current = entry
      current.pending = this.load(account, current).finally(() => {
        current.pending = undefined
      })
    }
    if (entry.pending && !this.observed.has(entry.pending)) {
      this.observed.add(entry.pending)
      // Notify each observing location once, even when another instance started
      // the shared request. A disposed subscriber cannot fail the fetch.
      void entry.pending.then(() => this.changed()).catch(() => {})
    }
    return { ...entry.view, quotaState: entry.view.quotaState === "ready" && this.now() >= entry.nextFetch ? "stale" : entry.view.quotaState }
  }

  private async load(account: Account, entry: Entry): Promise<void> {
    try {
      const { identity, retryAt, ...next } = await this.source.get(account)
      if (next.quotaError) {
        // Retain stale metadata when the entitlement is unchanged.
        const retain = identity !== undefined && identity === entry.identity && entry.view.quotaUpdatedAt !== null
        const fields = { ...next }
        for (const field of Object.keys(fields) as (keyof QuotaSnapshot)[]) {
          if (field !== "quotaError" && fields[field] === null && retain) fields[field] = entry.view[field]
        }
        const partial = Object.entries(next).some(([field, value]) => field !== "quotaError" && value !== null)
        entry.view = { ...fields, quotaState: retain || partial ? "stale" : "error",
          quotaUpdatedAt: retain ? entry.view.quotaUpdatedAt : partial ? this.now() : null }
      } else {
        entry.view = { ...next, quotaState: "ready", quotaUpdatedAt: this.now() }
      }
      entry.identity = identity
      entry.nextFetch = Math.max(this.now() + this.interval, retryAt ?? 0)
    } catch (error) {
      entry.view = { ...entry.view, quotaError: error instanceof JetBrainsError ? safeError(error) : "Plan details request failed. Try again later.",
        quotaState: entry.view.quotaUpdatedAt === null ? "error" : "stale" }
      const delay = error instanceof JetBrainsError ? error.retryAfter ?? 0 : 0
      entry.nextFetch = this.now() + Math.max(this.interval, delay)
    }
  }
}
