import type { BalanceSnapshot } from "./balance.ts"
import type { StatusSnapshot } from "./rpc.ts"
import type { QuotaSnapshot } from "./quota.ts"

export function balanceText(status: BalanceSnapshot): string {
  return status.balance === null ? "unavailable" : `${status.balance.toFixed(5)} ${status.unit === "CREDITS" ? "credits" : status.unit ?? "credits"}`
}

export function sidebarBalanceText(status: BalanceSnapshot & Partial<QuotaSnapshot>): string {
  const maximum = status.subscriptionMaximum ?? status.refillAmount
  return status.balance !== null && status.unit === "CREDITS" && maximum != null
    ? `${status.balance.toFixed(5)} / ${maximum.toFixed(1)} credits`
    : balanceText(status)
}

export function refillRate(status: QuotaSnapshot): string | null {
  if (status.refillAmount == null || status.refillPeriodMs == null) return null
  const ms = status.refillPeriodMs
  const [size, unit] = ms >= 86_400_000 ? [86_400_000, "day"] : ms >= 3_600_000 ? [3_600_000, "hour"] : ms >= 60_000 ? [60_000, "min"] : [1000, "sec"]
  const count = Number((ms / size).toFixed(3))
  return `${status.refillAmount.toFixed(1)} credits / ${count} ${unit}${count === 1 || unit === "min" || unit === "sec" ? "" : "s"}`
}

export function refillDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`
}

function fullDate(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })} · ${date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" })}`
}

export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000))
  if (seconds < 60) return "just now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} hr ago`
  const days = Math.floor(seconds / 86_400)
  return `${days} day${days === 1 ? "" : "s"} ago`
}

function alignFields(lines: string[]): string[] {
  const width = Math.max(...lines.map(line => line.indexOf(":")))
  return lines.map(line => {
    const colon = line.indexOf(":")
    return `${line.slice(0, colon + 1).padEnd(width + 2)}${line.slice(colon + 1).trimStart()}`
  })
}

function accountFields(status: StatusSnapshot): string[] {
  return alignFields([
    `Account: ${status.account ?? "JetBrains"}`,
    `License: ${status.license ?? "unknown"}`,
    `Active: ${status.active === true ? "yes" : status.active === false ? "no" : "unknown"}`,
  ])
}

function costEstimation(status: StatusSnapshot): string {
  if (status.dollarCost !== "estimated") return "Cost estimation is unavailable"
  const source = status.pricingSource === "junie" ? `Junie ${status.pricingVersion ?? "unknown"} rates`
    : status.pricingSource === "model-override" ? "model override" : "configured rates"
  return `Cost estimation uses ${source}`
}

function statusFields(status: StatusSnapshot): string[] {
  return [
    ...alignFields([
      `Updated: ${status.updatedAt === null ? "never" : fullDate(status.updatedAt)}`,
      ...(status.state === "ready" ? [] : [`Balance: ${status.state}`]),
      ...(status.quotaState && status.quotaState !== "ready" ? [`Plan details: ${status.quotaState}`] : []),
      ...(status.quotaState === "stale" && status.quotaUpdatedAt !== null ? [`Plan updated: ${fullDate(status.quotaUpdatedAt)}`] : []),
    ]),
    costEstimation(status),
  ]
}

export function statusText(status: StatusSnapshot): string {
  const auth = [
    status.authStage ? `Authentication: ${status.authStage}` : "",
    status.authError ? `Authentication error: ${status.authError}` : "",
  ].filter(Boolean)
  if (!status.connected) return ["Not connected. Use /connect and select JetBrains AI.", ...auth].join("\n")
  const rate = refillRate(status)
  const issues = [
    status.authError ? `Authentication: ${status.authError}` : "",
    status.quotaError ? `Plan details: ${status.quotaError}` : "",
    status.pricingError ? `Pricing: ${status.pricingError}` : "",
    status.error ? `Balance: ${status.error}` : "",
  ].filter(Boolean)
  const credits = [
    `Remaining: ${balanceText(status)}`,
    status.subscriptionBalance != null && status.subscriptionMaximum != null &&
      ((status.topUpMaximum ?? 0) > 0 || status.subscriptionBalance.toFixed(5) !== status.balance?.toFixed(5))
      ? `Subscription: ${status.subscriptionBalance.toFixed(5)} / ${status.subscriptionMaximum.toFixed(1)} credits left` : "",
    status.topUpBalance != null && status.topUpMaximum != null && status.topUpMaximum > 0
      ? `Top-ups: ${status.topUpBalance.toFixed(5)} / ${status.topUpMaximum.toFixed(1)} credits left` : "",
    rate ? `Refill: ${rate}` : "",
    status.nextRefill != null ? `Resets: ${fullDate(status.nextRefill)}` : "",
    status.validUntil != null ? `Valid until: ${fullDate(status.validUntil)}` : "",
  ].filter(Boolean)
  return [
    ...accountFields(status),
    "",
    "Credits",
    ...alignFields(credits).map(line => `  ${line}`),
    "",
    "Status",
    ...statusFields(status).map(line => `  ${line}`),
    ...(issues.length ? ["", "Issues", ...issues.map(line => `  ${line}`)] : []),
  ].join("\n")
}
