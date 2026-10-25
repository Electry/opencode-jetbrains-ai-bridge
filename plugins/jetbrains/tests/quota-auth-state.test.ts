import { expect, test } from "bun:test"
import { Integration, type Credential } from "@opencode/plugin"
import { quotaAuthState, readQuotaAuth } from "../src/quota-auth.ts"

const now = 1_800_000_000_000
const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ exp: now / 1000 + 3600 })).toString("base64url")}.signature`
const ready = { error: null, idToken: jwt, managementToken: "management", expires: now + 3600_000 }
function credential(value?: unknown): Credential.OAuth {
  return { type: "oauth", methodID: Integration.MethodID.make("manual"), access: "access", refresh: "refresh", expires: now + 3600_000,
    metadata: value === undefined ? {} : { jetbrainsQuota: value } }
}

test("existing persisted credentials decode into explicit authentication states", () => {
  expect(quotaAuthState(credential(), now)).toEqual({ state: "unprepared" })
  expect(quotaAuthState(credential({ error: "Setup failed." }), now)).toEqual({ state: "failed", error: "Setup failed." })
  expect(quotaAuthState(credential({ ...ready, expires: now - 1 }), now)).toEqual({ state: "expired" })
  expect(quotaAuthState(credential(ready), now)).toMatchObject({ state: "ready", idToken: jwt, managementToken: "management" })
  expect(quotaAuthState(credential(ready), now + 3600_000)).toEqual({ state: "expired" })
})

test("malformed optional metadata is rejected at the decoding boundary", () => {
  for (const patch of [
    { idToken: [] }, { managementToken: "contains whitespace" }, { expires: NaN },
    { workspace: [] }, { workspace: { organizationID: "org", workspaceID: "workspace", token: "token", expires: "never" } },
    { workspace: { organizationID: "org\n", workspaceID: "workspace", token: "token", expires: now + 1000 } },
  ]) expect(readQuotaAuth(credential({ ...ready, ...patch }))).toBeUndefined()
})

test("quota credentials accept both legacy transcripts and metadata without them", () => {
  const legacy = { ...ready, diagnostic: "ready" }
  expect(readQuotaAuth(credential(ready))).toEqual(readQuotaAuth(credential(legacy)))
  expect(readQuotaAuth(credential(legacy))).not.toHaveProperty("diagnostic")
})
