import { Rpc } from "@opencode/plugin/rpc"
import type { BalanceSnapshot } from "./balance.ts"
import type { QuotaView } from "./quota-cache.ts"

export type StatusSnapshot = BalanceSnapshot & QuotaView & {
  modelID: string
  dollarCost: "unavailable" | "estimated"
  pricingSource: "model-override" | "global-override" | "junie" | null
  pricingVersion: string | null
  pricingError: string | null
  authStage: string | null
  authError: string | null
}

const status = {
  type: "object",
  properties: {
    modelID: { type: "string" },
    connected: { type: "boolean" },
    account: { type: ["string", "null"] },
    state: { type: "string", enum: ["disconnected", "ready", "stale", "error"] },
    active: { type: ["boolean", "null"] },
    balance: { type: ["number", "null"] },
    rawBalance: { type: ["number", "null"] },
    unit: { type: ["string", "null"] },
    license: { type: ["string", "null"] },
    quotaError: { type: ["string", "null"] },
    quotaState: { type: "string", enum: ["loading", "ready", "stale", "error"] },
    quotaUpdatedAt: { type: ["number", "null"] },
    nextRefill: { type: ["number", "null"] },
    refillAmount: { type: ["number", "null"] },
    refillPeriodMs: { type: ["number", "null"] },
    subscriptionBalance: { type: ["number", "null"] },
    subscriptionMaximum: { type: ["number", "null"] },
    topUpBalance: { type: ["number", "null"] },
    topUpMaximum: { type: ["number", "null"] },
    validUntil: { type: ["number", "null"] },
    updatedAt: { type: ["number", "null"] },
    error: { type: ["string", "null"] },
    dollarCost: { type: "string", enum: ["unavailable", "estimated"] },
    pricingSource: { type: ["string", "null"], enum: ["model-override", "global-override", "junie", null] },
    pricingVersion: { type: ["string", "null"] },
    pricingError: { type: ["string", "null"] },
    authStage: { type: ["string", "null"] },
    authError: { type: ["string", "null"] },
  },
  required: ["modelID", "connected", "account", "state", "active", "balance", "rawBalance", "unit", "license", "updatedAt", "error", "dollarCost", "pricingSource", "pricingVersion", "pricingError", "authStage", "authError", "quotaError", "quotaState", "quotaUpdatedAt", "nextRefill", "refillAmount", "refillPeriodMs", "subscriptionBalance", "subscriptionMaximum", "topUpBalance", "topUpMaximum", "validUntil"],
  additionalProperties: false,
} as const

const input = {
  type: "object", properties: { modelID: { type: "string" } }, additionalProperties: false,
} as const

export const JetBrains = Rpc.define({
  id: "jetbrains",
  methods: {
    status: { input, output: status },
    refresh: { input, output: status },
  },
  events: {
    updated: { schema: { type: "object", additionalProperties: false } },
  },
})

export function readStatus(value: unknown): StatusSnapshot {
  // The server validates the RPC response. Narrow its type for the TUI.
  if (!value || typeof value !== "object" || typeof (value as StatusSnapshot).connected !== "boolean") {
    throw new Error("Invalid JetBrains status response.")
  }
  return value as StatusSnapshot
}
