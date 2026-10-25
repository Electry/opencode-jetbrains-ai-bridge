import type { Account } from "./account.ts"
import type { Fetch } from "./auth.ts"
import { GrazieQuotaClient, GrazieTokens } from "./grazie.ts"
import { LicenseDiscovery } from "./licenses.ts"
import { quotaAuthState } from "./quota-auth.ts"
import { emptyQuota, type QuotaSnapshot, type QuotaResponse } from "./quota.ts"
import { JetBrainsError, safeError } from "./errors.ts"
import { WorkspaceQuotaClient } from "./workspace-quota.ts"
import { createHash } from "node:crypto"

export type QuotaResult = QuotaResponse & { identity?: string }

function identity(parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex")
}

export class QuotaService {
  private readonly licenses: LicenseDiscovery
  private readonly tokens: GrazieTokens
  private readonly quota: GrazieQuotaClient
  private readonly workspace: WorkspaceQuotaClient

  constructor(fetcher: Fetch = fetch, private readonly now = Date.now) {
    this.licenses = new LicenseDiscovery(fetcher, now)
    this.tokens = new GrazieTokens(fetcher, now)
    this.quota = new GrazieQuotaClient(this.tokens, fetcher, now)
    this.workspace = new WorkspaceQuotaClient(fetcher, now)
  }

  async get(account: Account): Promise<QuotaResult> {
    const unavailable = (quotaError: string): QuotaSnapshot => ({ ...emptyQuota(), quotaError })
    if (!account.oauth) return unavailable("Plan details require a saved OAuth login.")
    const auth = quotaAuthState(account.oauth, this.now())
    if (auth.state === "unprepared") return unavailable("Plan details will be prepared during the next OAuth refresh. Reconnect with /connect to prepare them now.")
    if (auth.state === "failed") return unavailable(auth.error)
    if (auth.state === "expired") {
      return unavailable("Quota authentication is unavailable or expired. It will be renewed during the next OAuth refresh.")
    }
    try {
      const selection = await this.licenses.get(auth.managementToken)
      if (selection.state === "unavailable") {
        const reasons = {
          "no-options": "No AI licenses were returned for this account.",
          "no-eligible-options": "No enabled, unexpired AI entitlement is available.",
          "multiple-options": "Multiple AI entitlements are available; plan details cannot select one automatically.",
        }
        return unavailable(reasons[selection.reason])
      }
      if (selection.state === "workspace") {
        const workspace = auth.workspace
        if (!workspace || workspace.organizationID !== selection.organizationID || workspace.workspaceID !== selection.workspaceID) {
          return unavailable("Workspace quota authentication will be prepared during the next OAuth refresh. Reconnect with /connect to prepare it now.")
        }
        if (workspace.expires <= this.now()) {
          return unavailable("Workspace quota authentication is expired or invalid. It will be renewed during the next OAuth refresh.")
        }
        return { ...await this.workspace.get(workspace.token), identity: identity([account.key, "workspace", selection.organizationID, selection.workspaceID]) }
      }
      return { ...await this.quota.get({ accountKey: account.key, licenseID: selection.licenseID, idToken: auth.idToken }), identity: identity([account.key, "license", selection.licenseID]) }
    } catch (error) {
      return { ...unavailable(safeError(error)), ...(error instanceof JetBrainsError && error.retryAfter
        ? { retryAt: this.now() + error.retryAfter } : {}) }
    }
  }

}
