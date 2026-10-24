import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import { MODEL_ID, PROVIDER_ID } from "./constants.ts"
import { JetBrains, readStatus, type StatusSnapshot } from "./rpc.ts"

export function statusText(status: StatusSnapshot): string {
  const auth = [
    status.authStage ? `Authentication: ${status.authStage}` : "",
    status.authError ? `Authentication error: ${status.authError}` : "",
  ].filter(Boolean)
  if (!status.connected) return ["Not connected. Use /connect and select JetBrains AI.", ...auth].join("\n")
  return [
    `Account: ${status.account ?? "JetBrains"}`,
    ...auth,
    `Model: ${status.modelID}`,
    `Credits remaining: ${status.balance === null ? "unavailable" : `${status.balance} ${status.unit === "CREDITS" ? "credits" : status.unit ?? ""}`}`,
    `License: ${status.license ?? "unknown"}`,
    `Active: ${status.active === null ? "unknown" : status.active ? "yes" : "no"}`,
    `Updated: ${status.updatedAt === null ? "never" : new Date(status.updatedAt).toLocaleString()} (${status.state})`,
    status.dollarCost === "estimated"
      ? `Estimated prompt cost uses ${status.pricingSource === "junie" ? `Junie ${status.pricingVersion} rates` : "configured token prices"}.`
      : "Prompt cost unavailable.",
    status.pricingError ?? "",
    status.error ? `Status: ${status.error}` : "",
  ].filter(Boolean).join("\n")
}

export default Plugin.define({
  id: "local.jetbrains.tui",
  setup(context) {
    const rpc = context.client.rpc(JetBrains)
    const [snapshot, setSnapshot] = createSignal<StatusSnapshot>()
    let disposed = false
    let generation = 0
    let pendingModelID: string | undefined
    let pending: Promise<StatusSnapshot | undefined> | undefined
    const selectedModelID = () => {
      const model = context.ui.model.current()
      return model?.providerID === PROVIDER_ID ? model.modelID : MODEL_ID
    }
    const load = (force = false): Promise<StatusSnapshot | undefined> => {
      const modelID = selectedModelID()
      if (pendingModelID !== modelID) {
        generation++
        pending = undefined
        pendingModelID = modelID
        setSnapshot(undefined)
      }
      if (pending) return pending
      const current = generation
      const task = (async () => {
        try {
          const result = readStatus(await (force ? rpc.refresh({ modelID }, { location: context.location }) : rpc.status({ modelID }, { location: context.location })))
          if (disposed || current !== generation) return undefined
          setSnapshot(result)
          return result
        } catch {
          if (!disposed && current === generation) setSnapshot(undefined)
          return undefined
        }
      })().finally(() => { if (pending === task) pending = undefined })
      pending = task
      return task
    }
    const stopAccountChanges = context.data.on("credential.switched", (event) => {
      if (event.data.integrationID !== PROVIDER_ID) return
      generation++
      pending = undefined
      setSnapshot(undefined)
      void load()
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "jetbrains.status", title: "JetBrains: account and credits", group: "JetBrains", palette: true,
          slash: { name: "jetbrains" },
          run: async () => {
            const status = await load()
            await context.ui.dialog.alert({ title: "JetBrains AI", message: status ? statusText(status) : "JetBrains server plugin is unavailable at this location." })
          },
        },
        {
          id: "jetbrains.refresh", title: "JetBrains: refresh credits", group: "JetBrains", palette: true,
          slash: { name: "jetbrains-refresh" },
          run: async () => {
            const status = await load(true)
            context.ui.toast.show({
              title: "JetBrains AI", message: status ? statusText(status) : "JetBrains server plugin is unavailable.",
              variant: status?.state === "ready" ? "success" : "warning", duration: 5000,
            })
          },
        },
      ],
    }))

    function CreditStatus() {
      const ctx = usePlugin()
      const selected = () => ctx.ui.model.current()?.providerID === PROVIDER_ID
      createEffect(() => { if (selected()) void load() })
      return <Show when={selected()}>
        <box flexDirection="column" marginTop={1}>
          <text fg={ctx.theme.text.base}>JetBrains AI</text>
          <text fg={ctx.theme.text.muted}>
            {snapshot()?.connected === false ? "Not connected" : snapshot()?.balance == null ? "Credits unavailable" : `${snapshot()!.balance} ${snapshot()!.unit === "CREDITS" ? "credits" : snapshot()!.unit ?? "credits"} remaining`}
          </text>
          <Show when={snapshot()?.state === "stale" || snapshot()?.state === "error"}>
            <text fg={ctx.theme.text.muted}>Balance {snapshot()?.state}; /jetbrains for details</text>
          </Show>
          <Show when={snapshot()?.updatedAt != null}>
            <text fg={ctx.theme.text.muted}>Updated {new Date(snapshot()!.updatedAt!).toLocaleTimeString()}</text>
          </Show>
        </box>
      </Show>
    }
    context.ui.slot({ append: "sidebar.content", render: () => <CreditStatus /> })
    const timer = setInterval(() => {
      if (context.ui.model.current()?.providerID === PROVIDER_ID) void load()
    }, 30_000)
    return () => { disposed = true; clearInterval(timer); stopAccountChanges() }
  },
})
