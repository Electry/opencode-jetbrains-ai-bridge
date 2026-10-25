import type { Credential } from "@opencode/plugin"

export type Account = { key: string; label: string; access: string; oauth?: Credential.OAuth }
export type AccountResolver = () => Promise<Account | undefined>
