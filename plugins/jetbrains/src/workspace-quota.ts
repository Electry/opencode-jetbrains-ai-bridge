import type { Fetch } from "./auth.ts"
import { metadataError } from "./metadata-error.ts"
import { readQuota, type QuotaResponse } from "./quota.ts"
import { retryAfter } from "./errors.ts"

export class WorkspaceQuotaClient {
  constructor(private readonly fetcher: Fetch = fetch, private readonly now = Date.now) {}

  async get(token: string): Promise<QuotaResponse> {
    const [quota, refill] = await Promise.all([this.metadata(token, "get"), this.metadata(token, "refill")])
    return { ...readQuota(quota.value, refill.value), quotaError: [quota.error, refill.error].filter(Boolean).join(" ") || null,
      retryAt: Math.max(quota.retryAt ?? 0, refill.retryAt ?? 0) || undefined }
  }

  private async metadata(token: string, path: "get" | "refill"): Promise<{ value?: unknown; error: string | null; retryAt?: number }> {
    const name = path === "refill" ? "Workspace refill metadata" : "Workspace quota metadata"
    try {
      const response = await this.fetcher(`https://api.jetbrains.ai/quota/api/quota/${path}`, {
        method: "GET", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      })
      if (!response.ok) return { error: `${name} returned HTTP ${response.status}${await metadataError(response)}.${response.status === 401 ? " Workspace authentication will be renewed during the next OAuth refresh." : ""}`,
        retryAt: response.status === 429 ? this.now() + retryAfter(response, this.now()) : undefined }
      try {
        const value = await response.json() as Record<string, unknown>
        if (!value || typeof value !== "object" || !value.current || typeof value.current !== "object" || Array.isArray(value.current)) {
          return { error: `${name} returned no current metadata.` }
        }
        return { value, error: null }
      }
      catch { return { error: `${name} returned an invalid response.` } }
    } catch { return { error: `${name} request failed or timed out.` } }
  }
}
