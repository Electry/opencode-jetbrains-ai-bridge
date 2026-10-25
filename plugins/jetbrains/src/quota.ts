// Internal transport metadata is stripped before constructing public status.
export type QuotaResponse = QuotaSnapshot & { retryAt?: number }

export type QuotaSnapshot = {
  quotaError: string | null
  nextRefill: number | null
  refillAmount: number | null
  refillPeriodMs: number | null
  subscriptionBalance: number | null
  subscriptionMaximum: number | null
  topUpBalance: number | null
  topUpMaximum: number | null
  validUntil: number | null
}

export function emptyQuota(): QuotaSnapshot {
  return { quotaError: null, nextRefill: null, refillAmount: null, refillPeriodMs: null, subscriptionBalance: null, subscriptionMaximum: null, topUpBalance: null, topUpMaximum: null, validUntil: null }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function amount(value: unknown): number | null {
  const raw = typeof value === "object" ? record(value).amount : value
  if (typeof raw !== "number" && (typeof raw !== "string" || !/^\d+(\.\d+)?$/.test(raw))) return null
  const number = Number(raw)
  return Number.isFinite(number) && number >= 0 ? number / 100_000 : null
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
}

function period(value: unknown): number | null {
  if (typeof value === "object" && record(value).periodMillis !== undefined) value = record(value).periodMillis
  else if (typeof value === "object" && record(value).period !== undefined) value = record(value).period
  const raw = typeof value === "object" ? record(value).millis : value
  return positive(typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw)
}

function timestamp(value: unknown): number | null {
  const number = positive(value)
  return number !== null && number <= 8_640_000_000_000_000 ? number : null
}

export function readQuota(quota: unknown, refill: unknown): QuotaSnapshot {
  const current = record(record(quota).current)
  const tariff = record(current.tariffQuota)
  const topUp = record(current.topUpQuota)
  const schedule = record(record(refill).current)
  const rate = record(schedule.tariff)
  return {
    quotaError: null,
    nextRefill: timestamp(schedule.next),
    refillAmount: amount(rate.amount),
    refillPeriodMs: period(rate),
    subscriptionBalance: amount(tariff.available),
    subscriptionMaximum: amount(tariff.maximum),
    topUpBalance: amount(topUp.available),
    topUpMaximum: amount(topUp.maximum),
    validUntil: timestamp(current.until),
  }
}
