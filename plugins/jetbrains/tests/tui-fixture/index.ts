import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
import { emptyBalance } from "../../src/balance.ts"
import { emptyQuota } from "../../src/quota.ts"
import { JetBrains, type StatusSnapshot } from "../../src/rpc.ts"
import { MODEL_ID } from "../../src/constants.ts"

// Isolated UI fixture: exercise refresh, quota events, and RPC failure offline.
export default Plugin.define({
  id: "jetbrains-tui-fixture",
  effect: (ctx) => Effect.gen(function* () {
    let current: StatusSnapshot = {
      ...emptyBalance(), ...emptyQuota(), modelID: MODEL_ID, quotaState: "ready", quotaUpdatedAt: null,
      dollarCost: "estimated", pricingSource: "junie", pricingVersion: "fixture", pricingError: null, authStage: null, authError: null,
    }
    let refreshes = 0
    let failed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    yield* Effect.addFinalizer(() => Effect.sync(() => { clearTimeout(timer) }))
    const registration = yield* ctx.rpc.register(JetBrains, {
      status: () => Effect.promise(async () => {
        if (failed) throw new Error("Offline fixture failure")
        return current
      }),
      refresh: () => Effect.promise(async () => {
        refreshes++
        await new Promise(resolve => setTimeout(resolve, 250))
        failed = refreshes === 2
        if (failed) throw new Error("Offline fixture failure")
        current = { ...current, ...emptyBalance(true, "Refresh fixture"), connected: true, state: "ready", balance: 12.34567,
          unit: "CREDITS", active: true, license: "AIP", updatedAt: Date.now(), quotaState: "loading" }
        timer = setTimeout(() => {
          current = { ...current, refillAmount: 70, refillPeriodMs: 31 * 86_400_000, quotaState: "ready", quotaUpdatedAt: Date.now() }
          void Effect.runPromise(registration.events.emit("updated", {})).catch(() => {})
        }, 250)
        return current
      }),
    }).pipe(Effect.orDie)
  }),
})
