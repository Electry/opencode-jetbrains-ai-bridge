import type { AccountResolver } from "./account.ts"
import { BalanceService, emptyBalance } from "./balance.ts"
import type { Fetch } from "./auth.ts"
import { safeError } from "./errors.ts"
import { QuotaCache } from "./quota-cache.ts"
import { QuotaService } from "./quota-service.ts"
import { emptyQuota } from "./quota.ts"

export class StatusService {
  private readonly quota: QuotaCache
  private readonly balance: BalanceService

  constructor(private readonly account: AccountResolver, private readonly changed: () => void, fetcher: Fetch = fetch, now = Date.now) {
    this.quota = new QuotaCache(new QuotaService(fetcher, now), changed, now)
    this.balance = new BalanceService(account, fetcher, now)
  }

  async get(force = false) {
    try {
      const account = await this.account()
      if (!account) return { ...emptyBalance(), ...emptyQuota(), quotaState: "error" as const, quotaUpdatedAt: null }
      this.quota.get(account, force)
      const balance = await this.balance.getFor(account, force)
      return { ...balance, ...this.quota.get(account) }
    } catch (error) {
      return { ...emptyBalance(true), ...emptyQuota(), error: safeError(error), quotaState: "error" as const, quotaUpdatedAt: null }
    }
  }

  async refreshBalance(): Promise<void> {
    const account = await this.account()
    if (!account) return
    await this.balance.getFor(account, true)
    this.changed()
  }

}
