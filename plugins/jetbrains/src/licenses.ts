import type { Fetch } from "./auth.ts"
import { JetBrainsError, retryAfter } from "./errors.ts"

const OPTIONS_URL = "https://api.jetbrains.cloud/user-management/api/ai-access-options"

// Internal only: license IDs must not be included in public status or diagnostics.
export type LicenseSelection =
  | { state: "selected"; licenseID: string }
  | { state: "workspace"; organizationID: string; workspaceID: string }
  | { state: "unavailable"; reason: "no-options" | "no-eligible-options" | "multiple-options" }

type Option = { type: "license" | "workspace"; enabled: boolean; licenseID: string | null; organizationID: string | null; workspaceID: string | null; validThrough: string | null }

function invalid(): never {
  throw new JetBrainsError("License discovery returned an invalid response.")
}

function identifier(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) return invalid()
  return value
}

function date(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function option(value: unknown): Option {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  const raw = value as Record<string, unknown>
  const type = typeof raw.type === "string" ? raw.type.toLowerCase() : ""
  if (type !== "license" && type !== "workspace") return invalid()
  // Junie's model defaults an absent aiAccessEnabled to false.
  if (raw.aiAccessEnabled !== undefined && typeof raw.aiAccessEnabled !== "boolean") return invalid()
  const enabled = raw.aiAccessEnabled === true
  const licenseID = identifier(raw.licenseId)
  const organizationID = identifier(raw.orgId)
  const workspaceID = identifier(raw.workspaceId)
  if (type === "license" && enabled && licenseID === null) return invalid()
  if (type === "workspace" && enabled && (organizationID === null || workspaceID === null)) return invalid()
  let validThrough: string | null = null
  if (type === "license" && raw.validThrough != null) {
    if (typeof raw.validThrough !== "string") return invalid()
    validThrough = raw.validThrough.trim() || null
    // Unlike Junie's permissive parser, fail closed if expiry is malformed.
    if (validThrough !== null && !date(validThrough)) return invalid()
  }
  return { type, enabled, licenseID, organizationID, workspaceID, validThrough }
}

export function selectLicense(value: unknown, today: string): LicenseSelection {
  if (!date(today)) throw new JetBrainsError("License discovery requires a valid local date.")
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid()
  const options = (value as Record<string, unknown>).aiAccessOptions
  if (!Array.isArray(options) || options.length > 1000) return invalid()
  const parsed = options.map(option)
  if (!parsed.length) return { state: "unavailable", reason: "no-options" }
  const eligible = parsed.filter(item => item.enabled && (item.validThrough === null || item.validThrough >= today))
  if (!eligible.length) return { state: "unavailable", reason: "no-eligible-options" }
  // Require a single eligible entitlement across licenses and workspaces.
  if (eligible.length !== 1) return { state: "unavailable", reason: "multiple-options" }
  const selected = eligible[0]!
  if (selected.type === "workspace") return { state: "workspace", organizationID: selected.organizationID!, workspaceID: selected.workspaceID! }
  return { state: "selected", licenseID: selected.licenseID! }
}

function localDate(now: number): string {
  const value = new Date(now)
  return `${value.getFullYear().toString().padStart(4, "0")}-${(value.getMonth() + 1).toString().padStart(2, "0")}-${value.getDate().toString().padStart(2, "0")}`
}

export class LicenseDiscovery {
  constructor(private readonly fetcher: Fetch = fetch, private readonly now = Date.now) {}

  async get(managementToken: string, signal?: AbortSignal): Promise<LicenseSelection> {
    if (!managementToken || /\s/.test(managementToken)) throw new JetBrainsError("A management token is required for license discovery.")
    let response: Response
    try {
      response = await this.fetcher(OPTIONS_URL, {
        method: "GET", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
        headers: { Authorization: `Bearer ${managementToken}`, Accept: "application/json" },
      })
    } catch { throw new JetBrainsError("License discovery request failed or timed out.") }
    if (!response.ok) throw new JetBrainsError(`License discovery returned HTTP ${response.status}.`, false,
      response.status === 429 ? retryAfter(response, this.now()) : undefined)
    let value: unknown
    try { value = await response.json() } catch { return invalid() }
    return selectLicense(value, localDate(this.now()))
  }
}
