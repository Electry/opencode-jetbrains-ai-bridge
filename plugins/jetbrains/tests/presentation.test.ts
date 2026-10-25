import { expect, test } from "bun:test"
import { emptyBalance as emptyCoreBalance } from "../src/balance.ts"
import { emptyQuota } from "../src/quota.ts"
import { balanceText, sidebarBalanceText, refillDate, refillRate, relativeTime, statusText, statusContent } from "../src/presentation.ts"
import { readQuota } from "../src/quota.ts"

function emptyBalance(...args: Parameters<typeof emptyCoreBalance>) {
  return { ...emptyCoreBalance(...args), ...emptyQuota(), quotaState: "ready" as const, quotaUpdatedAt: null }
}

test("remaining balances always have five decimals without changing their precision", () => {
  for (const [balance, text] of [[64.4, "64.40000"], [64.123456789, "64.12346"], [0, "0.00000"]] as const) {
    const status = { ...emptyBalance(true), balance, unit: "CREDITS" }
    expect(balanceText(status)).toBe(`${text} credits`)
    expect(status.balance).toBe(balance)
  }
  expect(balanceText(emptyBalance())).toBe("unavailable")
})

test("refill rate formats the API amount and duration", () => {
  const status = { ...emptyBalance(true), refillAmount: 70, refillPeriodMs: 30 * 86_400_000 }
  expect(refillRate(status)).toBe("70.0 credits / 30 days")
  expect(refillRate({ ...status, refillAmount: 0, refillPeriodMs: 86_400_000 })).toBe("0.0 credits / 1 day")
  expect(refillRate({ ...status, refillPeriodMs: 3_600_000 })).toBe("70.0 credits / 1 hour")
  expect(refillRate({ ...status, refillPeriodMs: null })).toBeNull()
  expect(refillRate({ ...status, refillAmount: null })).toBeNull()
})

test("sidebar dates include year and separated local 24-hour time, and update times are relative", () => {
  const date = new Date(2026, 10, 12, 12).getTime()
  expect(refillDate(date)).toBe("Nov 12, 2026 · 12:00")
  expect(refillDate(new Date(2026, 10, 12, 0, 59).getTime())).toBe("Nov 12, 2026 · 00:59")
  for (const [age, text] of [[0, "just now"], [120_000, "2 min ago"], [7_200_000, "2 hr ago"], [86_400_000, "1 day ago"], [172_800_000, "2 days ago"]] as const) {
    expect(relativeTime(date, date + age)).toBe(text)
  }
  expect(relativeTime(date, date - 1000)).toBe("just now")
})

test("sidebar combines remaining balance and allowance with a fallback when metadata is absent", () => {
  const status = { ...emptyBalance(true), balance: 12.12345, unit: "CREDITS", subscriptionMaximum: 70, refillAmount: 20 }
  expect(sidebarBalanceText(status)).toBe("12.12345 / 70.0 credits")
  expect(sidebarBalanceText({ ...status, subscriptionMaximum: null })).toBe("12.12345 / 20.0 credits")
  expect(sidebarBalanceText({ ...status, subscriptionMaximum: null, refillAmount: null })).toBe("12.12345 credits")
  expect(sidebarBalanceText({ ...status, unit: "USD" })).toBe("12.12345 USD")
  expect(sidebarBalanceText(emptyBalance())).toBe("unavailable")
})

test("quota parser rejects malformed metadata and reads available balances", () => {
  expect(readQuota(null, null)).toEqual(readQuota({}, {}))
  const quota = readQuota({ current: {
    tariffQuota: { current: "9999999", available: "1234567.89", maximum: "7000000" },
    topUpQuota: { available: "NaN", maximum: -1 }, until: Infinity,
  } }, { current: { next: 9e18, tariff: { amount: { amount: "private" }, period: { millis: -1 } } } })
  expect(quota.subscriptionBalance).toBe(12.3456789)
  expect(quota.subscriptionMaximum).toBe(70)
  expect(quota.topUpBalance).toBeNull()
  expect(quota.topUpMaximum).toBeNull()
  expect(quota.nextRefill).toBeNull()
  expect(quota.validUntil).toBeNull()
  expect(quota.refillAmount).toBeNull()
  expect(quota.refillPeriodMs).toBeNull()
})

test("command includes plan details and precise timestamps, but omits missing metadata", () => {
  const status = { ...emptyBalance(true, "Test"), balance: 64.4, unit: "CREDITS", license: "AIP", active: true,
    modelID: "test", dollarCost: "unavailable" as const, pricingSource: null, pricingVersion: null, pricingError: null, authStage: null, authError: null }
  expect(statusText(status)).toContain("  Remaining: 64.40000 credits")
  const content = statusContent(status)
  expect(content.map(part => part.text).join("")).toBe(statusText(status))
  expect(content.filter(part => part.bold).map(part => part.text)).toEqual(["Credits", "Status"])
  expect(statusContent({ ...status, balance: null }).filter(part => part.bold).map(part => part.text)).toEqual(["Credits", "Status"])
  expect(statusContent({ ...status, connected: false }).some(part => part.bold)).toBe(false)
  expect(statusText(status)).not.toContain("Refill:")
  const report = statusText({ ...status, refillAmount: 70, refillPeriodMs: 2_592_000_000, nextRefill: new Date(2026, 10, 12, 13, 45, 7).getTime(),
    subscriptionBalance: 64.4, subscriptionMaximum: 70, topUpBalance: 5, topUpMaximum: 10 })
  expect(report).toMatch(/Refill:\s+70\.0 credits \/ 30 days/)
  expect(report).toMatch(/Top-ups:\s+5\.00000 \/ 10\.0 credits left/)
  expect(report).toContain("Resets:")
  expect(report).toContain("2026")
  expect(report).toContain(" · 13:45:07")
  expect(report).toStartWith("Account: Test\nLicense: AIP\nActive:  yes\n\nCredits\n")
  expect(report).not.toContain("Model:")
  expect(statusText({ ...status, active: false })).toStartWith("Account: Test\nLicense: AIP\nActive:  no\n")
  expect(statusText({ ...status, active: null })).toStartWith("Account: Test\nLicense: AIP\nActive:  unknown\n")
  expect(report).toContain("\n\nStatus\n")
  expect(statusText({ ...status, quotaError: "Refill metadata request returned HTTP 404." })).toContain("Plan details: Refill metadata request returned HTTP 404.")
})

test("modal groups issues and omits redundant details", () => {
  const status = { ...emptyBalance(true, "Test"), state: "ready" as const, balance: 12.12345, unit: "CREDITS", active: true,
    subscriptionBalance: 12.12345, subscriptionMaximum: 70, modelID: "test", dollarCost: "estimated" as const,
    pricingSource: "junie" as const, pricingVersion: "3813.10", pricingError: null, authStage: "code exchange completed", authError: null }
  const report = statusText(status)
  expect(report).toContain("Remaining: 12.12345 credits")
  expect(report).toContain("Cost estimation uses Junie 3813.10 rates")
  expect(report).not.toContain("Authentication:")
  expect(report).not.toContain("Issues")
  const failed = statusText({ ...status, state: "stale", authError: "login failed", quotaError: "quota failed", pricingError: "pricing failed", error: "balance failed" })
  expect(failed).toContain("\n\nIssues\n  Authentication: login failed\n  Plan details: quota failed\n  Pricing: pricing failed\n  Balance: balance failed")
  expect(failed).toContain("  Balance: stale")
})
