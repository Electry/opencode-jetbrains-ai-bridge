import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import { MODEL_ID, PROVIDER_ID } from "./constants.ts"
import { JetBrains, readStatus, type StatusSnapshot } from "./rpc.ts"
import { sidebarBalanceText, refillDate, relativeTime, statusText } from "./presentation.ts"
import { StatusRequests } from "./status-requests.ts"
export { statusText } from "./presentation.ts"

export default Plugin.define({
  id: "local.jetbrains.tui",
  setup(context) {
    const rpc = context.client.rpc(JetBrains)
    const [snapshot, setSnapshot] = createSignal<StatusSnapshot>()
    const [now, setNow] = createSignal(Date.now())
    let disposed = false
    let generation = 0
    let pendingModelID: string | undefined
    const requests = new StatusRequests<StatusSnapshot>()
    const selectedModelID = () => {
      const model = context.ui.model.current()
      return model?.providerID === PROVIDER_ID ? model.modelID : MODEL_ID
    }
    const load = (force = false): Promise<StatusSnapshot | undefined> => {
      const modelID = selectedModelID()
      if (pendingModelID !== modelID) {
        generation++
        requests.clear()
        pendingModelID = modelID
        setSnapshot(undefined)
      }
      const current = generation
      return requests.run(force, async () => {
        try {
          const result = readStatus(await (force ? rpc.refresh({ modelID }, { location: context.location }) : rpc.status({ modelID }, { location: context.location })))
          if (disposed || current !== generation) return undefined
          setSnapshot(result)
          return result
        } catch {
          if (!disposed && current === generation) setSnapshot(undefined)
          return undefined
        }
      })
    }
    const stopAccountChanges = context.data.on("credential.switched", (event) => {
      if (event.data.integrationID !== PROVIDER_ID) return
      generation++
      requests.clear()
      setSnapshot(undefined)
      void load()
    })
    const stopUpdates = rpc.events.on("updated", (event) => {
      if (context.location && event.location.directory !== context.location.directory) return
      // Let an in-flight status read finish before requesting its new metadata.
      void (requests.pending ?? Promise.resolve()).then(() => {
        if (!disposed) return load()
      }).catch(() => {})
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
          <text fg={ctx.theme.text.base}>JetBrains AI{snapshot()?.license ? ` · ${snapshot()!.license}` : ""}</text>
          <text fg={ctx.theme.text.muted}>
            {snapshot()?.connected === false ? "Not connected" : snapshot()?.balance == null ? "Credits unavailable" : `${sidebarBalanceText(snapshot()!)} left`}
          </text>
          <Show when={snapshot()?.nextRefill != null}>
            <text fg={ctx.theme.text.muted}>Resets {refillDate(snapshot()!.nextRefill!)}</text>
          </Show>
          <Show when={snapshot()?.state === "stale" || snapshot()?.state === "error"}>
            <text fg={ctx.theme.text.muted}>Balance {snapshot()?.state}; /jetbrains for details</text>
          </Show>
          <Show when={snapshot()?.quotaState === "stale"}>
            <text fg={ctx.theme.text.muted}>Plan details stale; /jetbrains for details</text>
          </Show>
          <Show when={snapshot()?.updatedAt != null}>
            <text fg={ctx.theme.text.muted}>Updated {relativeTime(snapshot()!.updatedAt!, now())}</text>
          </Show>
        </box>
      </Show>
    }
    context.ui.slot({ append: "sidebar.content", render: () => <CreditStatus /> })
    const timer = setInterval(() => {
      setNow(Date.now())
      if (context.ui.model.current()?.providerID === PROVIDER_ID) void load()
    }, 30_000)
    return () => { disposed = true; requests.clear(); clearInterval(timer); stopAccountChanges(); stopUpdates() }
  },
})
