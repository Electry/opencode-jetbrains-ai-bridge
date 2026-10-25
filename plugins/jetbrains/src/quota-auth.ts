import type { Credential } from "@opencode/plugin"
import type { Fetch } from "./auth.ts"
import { AudienceClient, AudienceError } from "./audience.ts"
import { jwtExpiration } from "./jwt.ts"
import { JetBrainsError, safeError } from "./errors.ts"
import { LicenseDiscovery } from "./licenses.ts"

export type WorkspaceAuth = { organizationID: string; workspaceID: string; token: string; expires: number }
export type QuotaAuth = {
  idToken?: string
  managementToken?: string
  expires?: number
  workspace?: WorkspaceAuth
  error: string | null
}

export function readQuotaAuth(credential: Credential.OAuth): QuotaAuth | undefined {
  const value = credential.metadata?.jetbrainsQuota
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const auth = value as Record<string, unknown>
  if (auth.error !== null && typeof auth.error !== "string") return undefined
  if (auth.idToken !== undefined && !token(auth.idToken)) return undefined
  if (auth.managementToken !== undefined && !token(auth.managementToken)) return undefined
  if (auth.expires !== undefined && !expiration(auth.expires)) return undefined
  let workspace: WorkspaceAuth | undefined
  if (auth.workspace !== undefined) {
    if (!auth.workspace || typeof auth.workspace !== "object" || Array.isArray(auth.workspace)) return undefined
    const item = auth.workspace as Record<string, unknown>
    if (!identifier(item.organizationID) || !identifier(item.workspaceID) || !token(item.token) || !expiration(item.expires)) return undefined
    workspace = { organizationID: item.organizationID, workspaceID: item.workspaceID, token: item.token, expires: item.expires }
  }
  return { error: auth.error, idToken: auth.idToken as string | undefined,
    managementToken: auth.managementToken as string | undefined, expires: auth.expires as number | undefined, workspace }
}

function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 65_536 && !/\s/.test(value)
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value)
}

function expiration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export type QuotaAuthState =
  | { state: "unprepared" }
  | { state: "failed"; error: string }
  | { state: "expired" }
  | { state: "ready"; idToken: string; managementToken: string; workspace?: WorkspaceAuth }

export function quotaAuthState(credential: Credential.OAuth, now: number): QuotaAuthState {
  const auth = readQuotaAuth(credential)
  if (!auth) return { state: "unprepared" }
  if (auth.error) return { state: "failed", error: auth.error }
  if (!auth.idToken || !auth.managementToken || !auth.expires || auth.expires <= now || (jwtExpiration(auth.idToken) ?? 0) <= now) return { state: "expired" }
  return { state: "ready", idToken: auth.idToken, managementToken: auth.managementToken, workspace: auth.workspace }
}

// All refresh-token-consuming steps run in the managed login/refresh callback.
// OpenCode saves the final refresh token, including rotation on a failed optional
// quota setup.
export async function prepareQuotaAuth(credential: Credential.OAuth, idToken: unknown, fetcher: Fetch, now: () => number, signal?: AbortSignal): Promise<Credential.OAuth> {
  const auth: QuotaAuth = { error: null }
  const expiry = typeof idToken === "string" ? jwtExpiration(idToken) : null
  const audience = new AudienceClient(credential.refresh, fetcher, now, signal)

  try {
    if (typeof idToken !== "string" || expiry === null || expiry <= now()) {
      throw new JetBrainsError("OAuth response did not include a usable ID token for quota authentication.")
    }
    auth.idToken = idToken
    const management = await audience.mint("jcp-user-management", "Quota audience exchange", expiry)
    auth.managementToken = management.token
    auth.expires = management.expires
    const selection = await new LicenseDiscovery(fetcher, now).get(management.token, signal)
    if (selection.state === "workspace") {
      const organization = await audience.mint("org-service", "Organization-service audience exchange", expiry)
      let info = await audience.membership(organization.token)
      const fields = () => ({ org_id: selection.organizationID, workspace_id: selection.workspaceID, orgs_user_info: info })
      let workspace: { token: string; expires: number }
      try { workspace = await audience.mint("ai-access", "Workspace audience exchange", expiry, fields()) }
      catch (error) {
        if (!(error instanceof AudienceError) || !error.invalidOrgsUserInfo) throw error
        info = await audience.membership(organization.token)
        workspace = await audience.mint("ai-access", "Workspace audience exchange", expiry, fields())
      }
      auth.workspace = { organizationID: selection.organizationID, workspaceID: selection.workspaceID, ...workspace }
    }
  } catch (error) {
    auth.error = error instanceof JetBrainsError ? safeError(error) : "Quota authentication setup failed, timed out, or returned invalid JSON."
  }
  return { ...credential, refresh: audience.refresh, metadata: { ...credential.metadata, jetbrainsQuota: auth } }
}
