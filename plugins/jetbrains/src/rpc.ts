import { Rpc } from "@opencode/plugin/rpc"
import type { BalanceSnapshot } from "./balance.ts"

export type StatusSnapshot = BalanceSnapshot & {
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
    updatedAt: { type: ["number", "null"] },
    error: { type: ["string", "null"] },
    dollarCost: { type: "string", enum: ["unavailable", "estimated"] },
    pricingSource: { type: ["string", "null"], enum: ["model-override", "global-override", "junie", null] },
    pricingVersion: { type: ["string", "null"] },
    pricingError: { type: ["string", "null"] },
    authStage: { type: ["string", "null"] },
    authError: { type: ["string", "null"] },
  },
  required: ["modelID", "connected", "account", "state", "active", "balance", "rawBalance", "unit", "license", "updatedAt", "error", "dollarCost", "pricingSource", "pricingVersion", "pricingError", "authStage", "authError"],
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
  events: {},
})

export function readStatus(value: unknown): StatusSnapshot {
  // The server validates the RPC response. Narrow its type for the TUI.
  if (!value || typeof value !== "object" || typeof (value as StatusSnapshot).connected !== "boolean") {
    throw new Error("Invalid JetBrains status response.")
  }
  return value as StatusSnapshot
}
