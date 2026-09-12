import { readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { define } from "@opencode-ai/plugin/v2/promise"
import { PROMPT_HEADER, STORE_KEY, TUI_PLUGIN_ID, buildPrompt, type StoreShape } from "./shared.ts"

/**
 * Server half of the annotate plugin.
 *
 * The TUI half stages annotations in its durable plugin storage. Staged means
 * "attached to my next message", so this hook intercepts every user prompt
 * for a session and prepends the staged annotations — regardless of whether
 * the prompt was submitted from the annotate panel, the composer strip, or a
 * plain Enter in the composer. Prompts that already carry the annotation
 * header (built by the TUI) are left untouched.
 */
export default define({
  id: "local.annotate",
  tui: true,
  async setup(context: any) {
    const stateDir = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
    const channel: string = context.app?.channel ?? "beta"
    const storePath = join(stateDir, "opencode", channel, "tui", `plugin.${TUI_PLUGIN_ID}.${STORE_KEY}.json`)

    const readStore = async (): Promise<StoreShape> => {
      try {
        return JSON.parse(await readFile(storePath, "utf8")) as StoreShape
      } catch {
        return {}
      }
    }

    // The outer entry ID marks the latest reply at staging time, independent
    // of the source IDs on annotations from older browsed responses.
    const lastAssistantID = async (sessionID: string): Promise<string | undefined> => {
      try {
        const messages: any[] = await context.session.context({ sessionID })
        return [...messages].reverse().find((m) => m.type === "assistant")?.id
      } catch {
        return undefined
      }
    }

    await context.session.hook("prompt", async (event: any) => {
      const text: string = event.prompt?.text ?? ""
      if (text.startsWith(PROMPT_HEADER)) return

      const store = await readStore()
      const entry = store[event.sessionID]
      if (!entry?.items?.length) return

      const current = await lastAssistantID(event.sessionID)
      if (entry.messageID && current && entry.messageID !== current) return

      event.prompt.text = buildPrompt(entry.items, text)
      event.metadata = { ...(event.metadata ?? {}), annotate: { count: entry.items.length, messageID: entry.messageID } }

      // Consume: the TUI store watcher picks this up and the composer strip
      // disappears. Best-effort; the panel's own send path also clears.
      delete store[event.sessionID]
      await writeFile(storePath, JSON.stringify(store), "utf8").catch(() => {})
    })
  },
})
