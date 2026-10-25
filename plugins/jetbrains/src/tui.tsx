import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { MODEL_ID, PROVIDER_ID } from "./constants.ts"
import { JetBrains, readStatus, type StatusSnapshot } from "./rpc.ts"
import { sidebarBalanceText, refillDate, relativeTime, statusContent } from "./presentation.ts"
import { StatusRequests } from "./status-requests.ts"
export { statusText } from "./presentation.ts"

export default Plugin.define({
  id: "local.jetbrains.tui",
  setup(context) {
    const rpc = context.client.rpc(JetBrains)
    const [snapshot, setSnapshot] = createSignal<StatusSnapshot>()
    const [unavailable, setUnavailable] = createSignal(false)
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
        setUnavailable(false)
      }
      const current = generation
      return requests.run(force, async () => {
        try {
          const result = readStatus(await (force ? rpc.refresh({ modelID }, { location: context.location }) : rpc.status({ modelID }, { location: context.location })))
          if (disposed || current !== generation) return undefined
          setUnavailable(false)
          setSnapshot(result)
          return result
        } catch {
          if (!disposed && current === generation) {
            setUnavailable(true)
            setSnapshot(undefined)
          }
          return undefined
        }
      })
    }
    const stopAccountChanges = context.data.on("credential.switched", (event) => {
      if (event.data.integrationID !== PROVIDER_ID) return
      generation++
      requests.clear()
      setSnapshot(undefined)
      setUnavailable(false)
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
          run: () => {
            context.ui.dialog.set({ size: "large", centered: false })
            context.ui.dialog.show(() => <AccountStatus />)
          },
        },
      ],
    }))

    function AccountStatus() {
      const ctx = usePlugin()
      const dimensions = useTerminalDimensions()
      const [refreshing, setRefreshing] = createSignal(false)
      let closed = false
      onCleanup(() => { closed = true })
      createEffect(() => { void load() })
      const refresh = async () => {
        if (closed || disposed || refreshing()) return
        setRefreshing(true)
        try { await load(true) }
        finally { if (!closed) setRefreshing(false) }
      }
      ctx.keymap.layer(() => ({
        mode: "modal",
        commands: [{ bind: "ctrl+r", title: "Refresh JetBrains account", enabled: () => !refreshing(), run: refresh }],
      }))
      return <box flexDirection="column" paddingLeft={3} paddingRight={3} paddingBottom={1} gap={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={ctx.theme.text.base}><b>JetBrains AI</b></text>
          <text fg={ctx.theme.text.muted} onMouseUp={(event) => { if (event.button === 0) ctx.ui.dialog.clear() }}>esc</text>
        </box>
        <scrollbox
          maxHeight={Math.max(1, Math.floor(dimensions().height * 0.75) - 8)}
          flexGrow={0}
          contentOptions={{ minHeight: 0 }}
        >
          <text fg={ctx.theme.text.muted}>
            <For each={snapshot() ? statusContent(snapshot()!) : [{ text: unavailable() ? "JetBrains server plugin is unavailable at this location." : "Loading account details…", bold: false }]}>
              {(part) => part.bold ? <span style={{ fg: ctx.theme.text.base }}><b>{part.text}</b></span> : <span>{part.text}</span>}
            </For>
          </text>
        </scrollbox>
        <box flexDirection="row" justifyContent="flex-end">
          <text onMouseUp={(event) => { if (event.button === 0) void refresh() }}>
            <span style={{ fg: refreshing() ? ctx.theme.text.muted : ctx.theme.text.base }}>{refreshing() ? "refreshing…" : "refresh"}</span>
            <span style={{ fg: ctx.theme.text.muted }}>{refreshing() ? "" : " ctrl+r"}</span>
          </text>
        </box>
      </box>
    }

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
          <Show when={(snapshot()?.state === "stale" || snapshot()?.state === "error") && snapshot()?.error}>
            <text fg={ctx.theme.text.muted}>Balance {snapshot()?.state}; /jetbrains for details</text>
          </Show>
          <Show when={snapshot()?.quotaState === "stale" && snapshot()?.quotaError}>
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
