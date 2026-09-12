import { For, Show, createEffect, createMemo, createSignal, onMount, onCleanup } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { PANEL, STORE_KEY, type Annotation, type StoreShape } from "./shared.ts"

// Shape of the `session.panel` slot input (from the host's PanelInput).
type PanelInput = {
  name: string
  sessionID: string
  width: number
  presentation: "panel" | "fullscreen"
  focused: boolean
  focus: () => void
  close: () => void
  toggleFullscreen: () => void
}

type Ctx = ReturnType<typeof usePlugin>

// ───────────────────────── text helpers ─────────────────────────

/**
 * Resolve the most recent assistant message text for a session, mirroring the
 * built-in `messages.copy` ("Copy last assistant message") logic: findLast
 * assistant, join its text parts.
 */
function lastAssistantText(context: Ctx, sessionID: string) {
  const messages = context.data.session.message.list(sessionID) ?? []
  const last = [...messages].reverse().find((m: any) => m.type === "assistant") as any
  if (!last) return { id: undefined as string | undefined, text: "" }
  const parts = (last.content ?? []).filter((p: any) => p.type === "text")
  return { id: last.id as string, text: parts.map((p: any) => p.text).join("\n").trim() }
}

/** Chronological, text-bearing assistant messages available in this session. */
function assistantResponses(messages: any[]) {
  return messages
    .filter((message: any) => message.type === "assistant")
    .map((message: any) => ({
      id: message.id as string,
      text: (message.content ?? []).filter((part: any) => part.type === "text")
        .map((part: any) => part.text).join("\n").trim(),
    }))
    .filter((message: { text: string }) => message.text.length > 0)
}

/**
 * Strip inline Markdown so the panel reads like rendered prose and quoted spans
 * don't leak `**`/backticks into the prompt (the Codex #35426 problem).
 * Block structure (headings, list markers, fences) is flattened to plain lines.
 */
function stripMarkdown(md: string): string {
  return md
    .replace(/```[\w-]*\n?/g, "") // fences
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s*>\s?/gm, "") // blockquotes
    .replace(/^\s*[-*+]\s+/gm, "• ") // bullets
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label
    .replace(/(\*\*|__)(.+?)\1/g, "$2") // bold
    .replace(/(^|[^*\w])(\*|_)(?!\s)(.+?)(?<!\s)\2(?!\w)/g, "$1$3") // italic
    .replace(/~~(.+?)~~/g, "$1") // strike
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/[ \t]+$/gm, "")
    .trim()
}

/**
 * Tokenize into words, keeping paragraph breaks as explicit tokens so layout
 * mirrors the original text. Each word is a separate renderable so we can do
 * our own drag selection without touching the host's native (copy-to-clipboard)
 * selection.
 */
type Token = { i: number; text: string; br: boolean }
function tokenize(text: string): Token[] {
  const out: Token[] = []
  const lines = text.split(/\n/)
  lines.forEach((line, li) => {
    for (const w of line.split(/\s+/).filter(Boolean)) out.push({ i: out.length, text: w, br: false })
    if (li < lines.length - 1) out.push({ i: out.length, text: "", br: true })
  })
  return out
}

function clip(s: string, n: number) {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "…" : s
}

// ───────────────────────── shared store ─────────────────────────

/**
 * Staged annotations persist per session and are keyed to the target message
 * ID at staging time (not the browsed response), so they survive closing the panel and are dropped automatically once a
 * newer assistant reply exists. `storage.store` is shared across all mounts of
 * this plugin (panel + composer strip), so both stay in sync.
 */
function useAnnotations(context: Ctx, sessionID: () => string) {
  const [store, updateStore] = context.storage.store(STORE_KEY, { initial: {} as StoreShape })
  const target = createMemo(() => lastAssistantText(context, sessionID()))
  const items = createMemo<Annotation[]>(() => {
    const entry = (store as StoreShape)[sessionID()]
    if (!entry) return []
    if (entry.messageID && target().id && entry.messageID !== target().id) return []
    return entry.items ?? []
  })
  // True while a store entry exists for this session (even if empty). The
  // server prompt hook *deletes* the entry when it attaches annotations to a
  // sent prompt, whereas local edits leave an (possibly empty) entry behind —
  // so "entry disappeared" is the reliable "consumed by send" signal.
  const hasEntry = createMemo(() => (store as StoreShape)[sessionID()] !== undefined)
  const set = (fn: (list: Annotation[]) => Annotation[]) =>
    updateStore((draft: StoreShape) => {
      draft[sessionID()] = { messageID: target().id, items: fn(items()) }
    })
  return { target, items, set, hasEntry }
}

/**
 * Ask before throwing away staged annotations. Resolves true when there is
 * nothing to lose or the user confirmed.
 */
async function confirmDiscard(context: Ctx, count: number): Promise<boolean> {
  if (count === 0) return true
  const ok = await context.ui.dialog.confirm({
    title: "Discard annotations?",
    message: `${count} staged annotation${count === 1 ? "" : "s"} will be removed and not sent.`,
    label: { confirm: "Discard", cancel: "Keep" },
  })
  return ok === true
}

// ───────────────────────── panel ─────────────────────────

function AnnotatePanel(props: { panel: PanelInput }) {
  const context = usePlugin()
  const theme = () => context.theme
  const { items: annotations, set: setAnnotations, hasEntry } = useAnnotations(context, () => props.panel.sessionID)
  const [history, setHistory] = createSignal<any[]>([])
  const [historyState, setHistoryState] = createSignal<"loading" | "ready" | "error">("loading")
  let disposed = false
  onCleanup(() => { disposed = true })
  onMount(async () => {
    try {
      const messages: any[] = []
      let cursor: string | undefined
      const seen = new Set<string>()
      do {
        const page = await context.client.message.list({
          sessionID: props.panel.sessionID,
          limit: 200,
          ...(cursor ? { cursor } : { order: "asc" as const }),
        })
        if (disposed) return
        messages.push(...page.data)
        cursor = page.cursor.next ?? undefined
        if (cursor && seen.has(cursor)) throw new Error("History pagination repeated a cursor")
        if (cursor) seen.add(cursor)
      } while (cursor)
      setHistory(messages)
      setHistoryState("ready")
    } catch (error) {
      if (disposed) return
      setHistoryState("error")
      context.ui.toast.show({ title: "Could not load response history", message: `${String(error)}. Reopen /annotate to retry.`, variant: "error" })
    }
  })
  const responses = createMemo(() => {
    // The independent history provides older messages; the live cache wins
    // for current/streaming messages. OpenCode message IDs sort chronologically.
    const messages = new Map(history().map((message: any) => [message.id, message]))
    for (const message of context.data.session.message.list(props.panel.sessionID) ?? []) messages.set(message.id, message)
    return assistantResponses([...messages.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  })
  const [selectedID, setSelectedID] = createSignal<string>()
  const responseIndex = createMemo(() => {
    const index = responses().findIndex((response: { id: string }) => response.id === selectedID())
    return index >= 0 ? index : responses().length - 1
  })
  const target = createMemo(() => responses()[responseIndex()] ?? { id: undefined, text: "" })
  let responseScroll: any
  const tokens = createMemo(() => tokenize(stripMarkdown(target().text)))

  // Word-index based selection: anchor (mouse down) → focus (drag).
  const [anchor, setAnchor] = createSignal<number | null>(null)
  const [focus, setFocus] = createSignal<number | null>(null)
  const [dragging, setDragging] = createSignal(false)

  const range = createMemo(() => {
    const a = anchor(), f = focus()
    if (a === null || f === null) return null
    return { lo: Math.min(a, f), hi: Math.max(a, f) }
  })
  const inRange = (i: number) => {
    const r = range()
    return !!r && i >= r.lo && i <= r.hi
  }
  const selectedText = createMemo(() => {
    const r = range()
    if (!r) return ""
    return tokens()
      .slice(r.lo, r.hi + 1)
      .filter((t) => !t.br)
      .map((t) => t.text)
      .join(" ")
  })
  const clearSelection = () => {
    setAnchor(null)
    setFocus(null)
    setDragging(false)
  }

  const navigateResponse = (direction: -1 | 1) => {
    if (historyState() !== "ready") return
    const index = Math.max(0, Math.min(responses().length - 1, responseIndex() + direction))
    const response = responses()[index]
    if (!response || response.id === target().id) return
    clearSelection()
    wordRefs.clear()
    setSelectedID(response.id)
    responseScroll?.scrollTo(0)
  }

  // OpenTUI routes drag events to the renderable where the press began, so
  // `onMouseOver` on *other* words never fires mid-drag. Instead we hit-test the
  // drag event's screen coordinates against each word's box.
  const wordRefs = new Map<number, any>()
  const wordAt = (x: number, y: number): number | null => {
    for (const [i, el] of wordRefs) {
      if (!el || el.isDestroyed || !el.visible) continue
      if (x >= el.x && x < el.x + el.width && y >= el.y && y < el.y + el.height) return i
    }
    return null
  }
  const extendTo = (e: any) => {
    if (!dragging() || !e) return
    const i = wordAt(e.x, e.y)
    if (i !== null) setFocus(i)
  }
  const onWordDown = (i: number) => {
    setAnchor(i)
    setFocus(i)
    setDragging(true)
  }
  const onUp = () => setDragging(false)

  const addAnnotation = async () => {
    if (historyState() !== "ready") {
      context.ui.toast.show({ message: historyState() === "loading" ? "Loading response history; please wait." : "Reopen /annotate to retry loading history.", variant: "warning" })
      return
    }
    const span = selectedText()
    const messageID = target().id
    const responseNumber = responseIndex() + 1
    if (!span) {
      context.ui.toast.show({ message: "Drag across words in the response first.", variant: "warning" })
      return
    }
    const comment = await context.ui.dialog.prompt({
      title: "Annotate selection",
      description: `“${clip(span, 90)}”`,
      placeholder: "Your question or comment about this span",
    })
    if (!comment?.trim()) return
    await setAnnotations((list) => [...list, { id: crypto.randomUUID(), span, comment: comment.trim(), messageID, responseNumber }])
    clearSelection()
  }

  const removeLast = () => void setAnnotations((list) => list.slice(0, -1))

  // Enter = done: keep everything staged (the composer strip shows it) and
  // close. The annotations ride along with whatever is sent next.
  const done = () => {
    clearSelection()
    props.panel.close()
  }

  // Esc = discard: confirm first if there is anything staged.
  const discard = async () => {
    if (!(await confirmDiscard(context, annotations().length))) return
    await setAnnotations(() => [])
    clearSelection()
    props.panel.close()
  }

  // Auto-close once staged annotations are consumed by a send. The server
  // prompt hook deletes this session's store entry when it attaches them, so
  // watch for the entry vanishing (local edits, incl. removing the last item,
  // keep an entry and therefore do not close the panel).
  let hadEntry = hasEntry()
  createEffect(() => {
    const now = hasEntry()
    if (hadEntry && !now) props.panel.close()
    hadEntry = now
  })

  context.keymap.layer(() => ({
    commands: [
      { id: "local.annotate.discard", title: "Discard annotations and close", bind: "escape", run: () => void discard() },
      { id: "local.annotate.done", title: "Done (keep staged) and close", bind: "return", run: done },
      { id: "local.annotate.older", title: "Previous assistant response", bind: "up", run: () => navigateResponse(-1) },
      { id: "local.annotate.newer", title: "Next assistant response", bind: "down", run: () => navigateResponse(1) },
      { id: "local.annotate.fullscreen", title: "Toggle annotate fullscreen", bind: "f", run: props.panel.toggleFullscreen },
      { id: "local.annotate.add", title: "Annotate selection", bind: "a", run: () => void addAnnotation() },
      { id: "local.annotate.undo", title: "Remove last annotation", bind: "u", run: removeLast },
      { id: "local.annotate.clear", title: "Clear selection", bind: "c", run: clearSelection },
    ],
  }))

  const Hint = (p: { k: string; label: string }) => (
    <text selectable={false} fg={theme().text.subdued}>
      <span style={{ fg: theme().text.default, attributes: TextAttributes.BOLD }}>{p.k}</span> {p.label}
    </text>
  )

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={2} paddingRight={2} paddingTop={1} onMouseUp={onUp}>
      {/* Header */}
      <box flexShrink={0} flexDirection="column" paddingBottom={1} border={["bottom"]} borderColor={theme().border.default}>
        <box flexDirection="row" justifyContent="space-between">
          <text selectable={false} fg={theme().text.default} attributes={TextAttributes.BOLD}>
            Annotate
          </text>
          <text selectable={false} fg={theme().text.subdued}>
            {historyState() === "loading" ? "Loading response history..." : historyState() === "error" ? "History unavailable - reopen to retry" : `Response ${responseIndex() + 1} of ${responses().length}${responseIndex() === responses().length - 1 && responses().length > 0 ? " (latest)" : ""}`}
          </text>
        </box>
        <box flexDirection="row" flexWrap="wrap" columnGap={2} paddingTop={1}>
          <Hint k="drag" label="select" />
          <Hint k="up" label="older" />
          <Hint k="down" label="newer" />
          <Hint k="a" label="annotate" />
          <Hint k="enter" label="done" />
          <Hint k="u" label="undo" />
          <Hint k="c" label="clear" />
          <Hint k="f" label="fullscreen" />
          <Hint k="esc" label="discard" />
        </box>
      </box>

      {/* Response text */}
      <scrollbox ref={(el: any) => { responseScroll = el }} flexGrow={1} minHeight={0} paddingTop={1} paddingBottom={1}>
        <Show
          when={tokens().length}
          fallback={<text selectable={false} fg={theme().text.subdued}>No assistant response in this session yet.</text>}
        >
          <box flexDirection="row" flexWrap="wrap">
            <For each={tokens()}>
              {(t) => (
                <Show when={!t.br} fallback={<box width="100%" height={1} />}>
                  <text
                    ref={(el: any) => wordRefs.set(t.i, el)}
                    selectable={false}
                    fg={inRange(t.i) ? theme().text.action.primary.focused : theme().text.default}
                    bg={inRange(t.i) ? theme().background.action.primary.focused : undefined}
                    onMouseDown={(e: any) => {
                      e?.preventDefault?.()
                      onWordDown(t.i)
                    }}
                    onMouseDrag={extendTo}
                    onMouseDragEnd={(e: any) => {
                      extendTo(e)
                      onUp()
                    }}
                    onMouseUp={(e: any) => {
                      extendTo(e)
                      onUp()
                    }}
                  >
                    {t.text + " "}
                  </text>
                </Show>
              )}
            </For>
          </box>
        </Show>
      </scrollbox>

      {/* Footer: current selection + staged annotations */}
      <box flexShrink={0} flexDirection="column" paddingTop={1} border={["top"]} borderColor={theme().border.default}>
        <Show when={selectedText()}>
          <box flexDirection="row" gap={1} paddingBottom={1}>
            <text selectable={false} fg={theme().text.feedback.info.default} attributes={TextAttributes.BOLD}>
              Selected
            </text>
            <text selectable={false} fg={theme().text.feedback.info.default}>
              “{clip(selectedText(), 70)}”
            </text>
          </box>
        </Show>
        <text selectable={false} fg={theme().text.default} attributes={TextAttributes.BOLD}>
          Annotations{" "}
          <span style={{ fg: theme().text.subdued, attributes: TextAttributes.NONE }}>({annotations().length})</span>
        </text>
        <Show when={annotations().length === 0}>
          <text selectable={false} fg={theme().text.subdued}>Select text and press a to add one.</text>
        </Show>
        <For each={annotations()}>
          {(a, i) => (
            <box flexDirection="column" paddingTop={1}>
              <text selectable={false} fg={theme().text.subdued}>
                <span style={{ fg: theme().text.default, attributes: TextAttributes.BOLD }}>{i() + 1}.</span>{" "}
                {a.responseNumber ? `[response ${a.responseNumber}] ` : ""}
                “{clip(a.span, 60)}”
              </text>
              <box paddingLeft={3}>
                <text selectable={false} fg={theme().text.default}>→ {a.comment}</text>
              </box>
            </box>
          )}
        </For>
      </box>
    </box>
  )
}

// ───────────────────────── composer strip ─────────────────────────

/**
 * Rendered above the composer whenever annotations are staged (Codex-style),
 * so you can see what will be attached to your next message even with the
 * panel closed.
 */
function ComposerStrip(props: { sessionID: string }) {
  const context = usePlugin()
  const theme = () => context.theme
  const { items, set } = useAnnotations(context, () => props.sessionID)

  // The host installs its own getClipboardText on the main prompt textarea
  // to expand pasted text. Dialog/form editors do not have this own property.
  // Use that capability to target the composer rather than all text inputs.
  const composer = () => {
    const route = context.ui.router.current()
    if (route.type !== "session" || route.sessionID !== props.sessionID) return undefined
    const editor = context.renderer.currentFocusedRenderable as any
    if (!editor || editor.isDestroyed || !Object.prototype.hasOwnProperty.call(editor, "getClipboardText")) return undefined
    return editor
  }

  context.keymap.layer(() => ({
    target: composer,
    priority: 10,
    enabled: items().length > 0,
    commands: [{
      id: "local.annotate.clear-draft",
      title: "Clear staged annotations with composer",
      bind: "ctrl+c",
      run: (_input: unknown, event: any) => {
        const editor = composer()
        if (!editor || items().length === 0) return false
        const hasText = editor.plainText.length > 0
        void set(() => []).catch((error: unknown) => {
          context.ui.toast.show({ message: `Could not clear annotations: ${String(error)}`, variant: "error" })
        })
        // Keep this synchronous: false continues dispatch to the native
        // prompt.clear handler, preserving prompt history and attachments.
        if (hasText) return false
        // Annotations alone are still a draft; do not fall through to exit.
        event?.preventDefault()
        event?.stopPropagation()
      },
    }],
  }))

  return (
    <Show when={items().length > 0}>
      <box
        flexDirection="column"
        marginBottom={1}
        paddingLeft={1}
        paddingRight={1}
        border={["left"]}
        borderColor={theme().text.feedback.info.default}
      >
        <box flexDirection="row">
          <text selectable={false} fg={theme().text.feedback.info.default} attributes={TextAttributes.BOLD}>
            {items().length} annotation{items().length === 1 ? "" : "s"} staged
            <span style={{ fg: theme().text.subdued, attributes: TextAttributes.NONE }}> — attached to your next message</span>
          </text>
        </box>
        <For each={items()}>
          {(a, i) => (
            <text selectable={false} fg={theme().text.subdued}>
              <span style={{ fg: theme().text.default }}>{i() + 1}.</span> {a.responseNumber ? `[response ${a.responseNumber}] ` : ""}“{clip(a.span, 40)}”{" "}
              <span style={{ fg: theme().text.default }}>→ {clip(a.comment, 50)}</span>
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

// ───────────────────────── plugin ─────────────────────────

export default Plugin.define({
  id: "local.annotate.tui",
  setup(context) {
    const offPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <AnnotatePanel panel={panel} />
        </Show>
      ),
    })

    const offStrip = context.ui.slot({
      append: "session.composer.top",
      render: (input: { sessionID: string }) => <ComposerStrip sessionID={input.sessionID} />,
    })

    // keymap.layer must run inside a Solid component scope, so mount it via the
    // `app` slot (same pattern as the goal plugin).
    const offApp = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "local.annotate.open",
              title: "Annotate responses",
              description: "Browse and annotate assistant responses, starting with the latest",
              group: "Annotate",
              palette: true,
              slash: { name: "annotate" },
              run: () => {
                const opened = context.ui.panel.open(PANEL)
                if (!opened) context.ui.toast.show({ message: "Open a session first.", variant: "warning" })
              },
            },
          ],
        }))
        return null
      },
    })

    return () => {
      offPanel()
      offStrip()
      offApp()
    }
  },
})
