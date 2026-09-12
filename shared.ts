// Shared between the TUI half (tui.tsx) and the server half (index.ts).

export const PANEL = "local.annotate.panel"
export const TUI_PLUGIN_ID = "local.annotate.tui"
export const STORE_KEY = "annotations"

export type Annotation = { id: string; span: string; comment: string; messageID?: string; responseNumber?: number }
export type StoreEntry = { messageID?: string; items: Annotation[] }
export type StoreShape = Record<string, StoreEntry>

/**
 * Marker prefix so the server-side prompt hook can tell an already-built
 * annotation prompt (sent from the panel / strip) from a plain composer prompt
 * that needs the staged annotations prepended.
 */
export const PROMPT_HEADER =
  "I have annotated specific parts of your earlier responses. Each annotation quotes the exact span I selected, followed by my question or comment about that span. Source labels identify the response being discussed. Please address each one."

/** Build the user-facing prompt that carries every staged annotation. */
export function buildPrompt(items: Annotation[], extra: string) {
  const lines = [PROMPT_HEADER, "", ...items.flatMap((a, i) => [
    `[${i + 1}] "${a.span}"`,
    ...(a.messageID ? [`    Source: assistant response ${a.responseNumber ?? ""} (message ${a.messageID})`] : []),
    `    → ${a.comment}`, "",
  ])]
  if (extra.trim()) lines.push(extra.trim())
  return lines.join("\n").trimEnd()
}

/**
 * Path of the TUI plugin's durable storage file for a given key. The TUI host
 * persists `context.storage.store(key)` at
 * `<state>/<channel>/tui/plugin.<pluginID>.<key>.json`; the server half reads
 * that file so both halves share one source of truth.
 */
export function tuiStorePath(stateDir: string, channel: string, key = STORE_KEY) {
  return `${stateDir}/${channel}/tui/plugin.${TUI_PLUGIN_ID}.${key}.json`
}
