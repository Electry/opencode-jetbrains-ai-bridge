import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Integration } from "@opencode/plugin"
import { GrazieQuotaClient, GrazieTokens } from "../src/grazie.ts"
import { WorkspaceQuotaClient } from "../src/workspace-quota.ts"
import { QuotaService } from "../src/quota-service.ts"
import type { Fetch } from "../src/auth.ts"

const now = 1_800_000_000_000
const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: now / 1000 + 3600 })).toString("base64url")}.signature`
const limited = (value: string) => new Response(null, { status: 429, headers: { "Retry-After": value } })

test("both quota clients preserve the longest Retry-After, including HTTP dates", async () => {
  const fetcher: Fetch = async url => {
    if (String(url).includes("provide-access")) return Response.json({ token: jwt })
    return String(url).endsWith("/get") ? limited("300") : limited(new Date(now + 600_000).toUTCString())
  }
  const workspace = await new WorkspaceQuotaClient(fetcher, () => now).get("scoped")
  const tokens = new GrazieTokens(fetcher, () => now)
  const license = await new GrazieQuotaClient(tokens, fetcher, () => now).get({ accountKey: randomUUID(), licenseID: "license", idToken: jwt })
  for (const result of [workspace, license]) {
    expect(result.retryAt).toBe(now + 600_000)
    expect(result.quotaError).toContain("429")
  }
})

test("discovery and Grazie token-exchange rate limits reach the quota service", async () => {
  for (const stage of ["discovery", "exchange"]) {
    const fetcher: Fetch = async url => {
      if (String(url).endsWith("/ai-access-options") && stage !== "discovery") {
        return Response.json({ aiAccessOptions: [{ type: "license", licenseId: "license", aiAccessEnabled: true }] })
      }
      return limited("300")
    }
    const result = await new QuotaService(fetcher, () => now).get({ key: randomUUID(), label: "Test", access: "inference", oauth: {
      type: "oauth", methodID: Integration.MethodID.make("manual"), access: "inference", refresh: "refresh", expires: now + 3600_000,
      metadata: { jetbrainsQuota: { error: null, idToken: jwt, managementToken: "management", expires: now + 3600_000 } },
    } })
    expect(result.retryAt).toBe(now + 300_000)
    expect(result.quotaError).toContain("429")
  }
})
