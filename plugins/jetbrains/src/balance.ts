import { GATEWAY, HEADERS } from "./constants.ts"
import type { Fetch } from "./auth.ts"
import { JetBrainsError, retryAfter, safeError } from "./errors.ts"
import type { Account, AccountResolver } from "./account.ts"

export type BalanceSnapshot = {
  connected: boolean
  account: string | null
  state: "disconnected" | "ready" | "stale" | "error"
  active: boolean | null
  balance: number | null
  rawBalance: number | null
  unit: string | null
  license: string | null
  updatedAt: number | null
  error: string | null
}

export function emptyBalance(connected = false, account: string | null = null): BalanceSnapshot {
  return { connected, account, state: connected ? "error" : "disconnected", active: null, balance: null, rawBalance: null, unit: null, license: null, updatedAt: null, error: null }
}

type Entry = { snapshot: BalanceSnapshot; nextFetch: number; pending?: Promise<BalanceSnapshot> }
const symbol = Symbol.for("opencode.jetbrains.balance.v6")
const shared = globalThis as typeof globalThis & { [symbol]?: Map<string, Entry> }
const entries = shared[symbol] ??= new Map<string, Entry>()

export class BalanceService {
  constructor(
    private readonly account: AccountResolver,
    private readonly fetcher: Fetch = fetch,
    private readonly now = Date.now,
    private readonly interval = 60_000,
  ) {}

  async get(force = false): Promise<BalanceSnapshot> {
    let account: Account | undefined
    try { account = await this.account() } catch (error) {
      return { ...emptyBalance(true), error: safeError(error) }
    }
    if (!account) return emptyBalance()
    return this.getFor(account, force)
  }

  async getFor(account: Account, force = false): Promise<BalanceSnapshot> {
    let entry = entries.get(account.key)
    if (!entry) {
      entry = { snapshot: emptyBalance(true, account.label), nextFetch: 0 }
      entries.set(account.key, entry)
      if (entries.size > 128) {
        for (const [key, value] of entries) {
          if (key !== account.key && !value.pending) { entries.delete(key); break }
        }
      }
    }
    if (entry.pending) return entry.pending
    const now = this.now()
    // Manual refresh shortens the cache TTL to five seconds. Error backoff still applies.
    const waitUntil = force && entry.snapshot.state === "ready"
      ? Math.min(entry.nextFetch, (entry.snapshot.updatedAt ?? 0) + 5000)
      : entry.nextFetch
    if (now < waitUntil) return this.view(entry, account.label)
    const pending = this.load(account, entry)
    entry.pending = pending
    try { return await pending } finally { entry.pending = undefined }
  }

  private view(entry: Entry, label: string): BalanceSnapshot {
    return {
      ...entry.snapshot, account: label,
      state: entry.snapshot.state === "ready" && this.now() - (entry.snapshot.updatedAt ?? 0) >= this.interval ? "stale" : entry.snapshot.state,
    }
  }

  private async load(account: Account, entry: Entry): Promise<BalanceSnapshot> {
    try {
      const response = await this.fetcher(`${GATEWAY}/auth/test`, {
        headers: { ...HEADERS, Accept: "application/json", Authorization: `Bearer ${account.access}` },
        redirect: "error", signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) {
        throw new JetBrainsError(
          response.status === 401 ? "JetBrains credentials were rejected. Reconnect the account." : `Credit service returned HTTP ${response.status}.`,
          response.status === 401,
          response.status === 429 ? retryAfter(response, this.now()) : undefined,
        )
      }
      const value = await response.json() as Record<string, unknown>
      if (typeof value?.active !== "boolean" || typeof value.balanceLeft !== "number" || !Number.isFinite(value.balanceLeft) ||
          typeof value.balanceUnit !== "string" || !/^[A-Za-z_]{1,32}$/.test(value.balanceUnit)) {
        throw new JetBrainsError("Credit service returned an invalid response.")
      }
      const license = typeof value.licenseType === "string" && /^[A-Za-z0-9_. -]{0,64}$/.test(value.licenseType) ? value.licenseType : null
      entry.snapshot = {
        connected: true, account: account.label, state: "ready", active: value.active,
        balance: value.balanceUnit === "CREDITS" ? value.balanceLeft / 100_000 : value.balanceLeft,
        rawBalance: value.balanceLeft, unit: value.balanceUnit, license,
        updatedAt: this.now(), error: null,
      }
      entry.nextFetch = this.now() + this.interval
    } catch (error) {
      entry.snapshot = { ...entry.snapshot, state: entry.snapshot.updatedAt === null ? "error" : "stale", error: safeError(error) }
      entry.nextFetch = this.now() + (error instanceof JetBrainsError && error.retryAfter ? error.retryAfter : this.interval)
    }
    return this.view(entry, account.label)
  }
}
