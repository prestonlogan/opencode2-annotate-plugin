![Annotate assistant responses in OpenCode — word selection, annotation panel, and staged comments](assets/opencode2-annotate-plugin-banner.png)

# Annotate assistant responses in OpenCode

Select words in earlier assistant responses, attach a comment to each span, and send the annotations with your next OpenCode message.

## Install

Requires OpenCode V2 beta with `session.panel`, `session.composer.top`, session storage, and `session.hook("prompt")` support.

```sh
opencode2 plugin add github:prestonlogan/opencode2-annotate-plugin
```

Install the pinned release with `#v0.2.0` instead:

```sh
opencode2 plugin add github:prestonlogan/opencode2-annotate-plugin#v0.2.0
```

If your executable is named `opencode`, replace `opencode2` in these commands. Restart OpenCode after installing, then run `/annotate` in a session.

### Compatibility

The `v0.2.0` feature set was exercised with OpenCode `v2.0.2`, including `/annotate`, annotated composer prompts, and annotations-only submission. The `v0.1.0` package was tested through clean GitHub installation on `v0.0.0-beta-19507`; other beta builds may vary.

### Keep one installation active

The package manager adds the plugin to the global OpenCode configuration. If `~/.config/opencode/plugins/annotate` already contains a manual clone, move it outside the plugins folder and remove its entry from `~/.config/opencode/opencode.json`.

For a default-branch installation:

```sh
opencode2 plugin check
opencode2 plugin update github:prestonlogan/opencode2-annotate-plugin
```

Restart after updating. To remove the package:

```sh
opencode2 plugin remove github:prestonlogan/opencode2-annotate-plugin
```

## Use

Open a session with at least one assistant response, then run `/annotate` or choose **Annotate** in the command palette (`Ctrl+P`). The panel loads history and opens the latest response.

1. Drag across words. Selection snaps to whole words and can cross lines without invoking the host’s copy selection.
2. Press `a`, add a comment, and submit the dialog.
3. Use `Up` or `Down` to move through assistant responses. Repeat across any number of responses.
4. Press `Enter`. The panel closes and a summary strip above the composer shows what is staged.
5. Type any follow-up and press `Enter`, or press `Enter` with an empty composer to send the annotations by themselves.

The panel’s `Enter` keeps the annotations staged. When the composer contains text, OpenCode submits that draft and the plugin attaches the annotations. When the composer is empty, the plugin sends the annotations as the message.

Use `Esc` to discard; a confirmation appears when annotations are staged. If none are staged, the panel closes immediately.

The panel shows `No assistant response in this session yet.` until usable assistant text is available. Reopen `/annotate` if history loading fails.

![OpenCode terminal with a highlighted response span in the Annotate panel and a comment dialog asking “Who was the last to commit?”](assets/opencode2-annotate-plugin-comment-dialog.png)

*Select a span and press `a` to attach a comment. Staged annotations remain visible above the composer.*

### Panel keys

| Key | Action |
| --- | --- |
| drag | Select words |
| `Up` | Older response |
| `Down` | Newer response |
| `a` | Annotate selection |
| `Enter` | Keep staged and close |
| `u` | Remove latest annotation |
| `c` | Clear selection |
| `f` | Toggle fullscreen |
| `Esc` | Discard and close |

### Composer keys

| Key | Action |
| --- | --- |
| `Enter` | Send staged annotations when the composer is empty |
| `Ctrl+C` | Clear staged annotations; also clears a non-empty draft through OpenCode’s normal action |

The empty-composer `Enter` action is also available as **Send staged annotations** (`local.annotate.send`) in the command palette. It requires staged annotations and an empty visible composer. If a prompt is waiting in the queue, `Enter` keeps promoting that prompt and leaves the annotations staged.

### Keymap options

OpenCode’s global keybinding table does not accept custom plugin command IDs yet. The plugin therefore exposes the automatic submission binding through its own options:

```json
{
  "plugins": [
    {
      "package": "github:prestonlogan/opencode2-annotate-plugin",
      "options": {
        "sendOnEmptyEnter": true,
        "sendBinding": "enter"
      }
    }
  ]
}
```

Set `sendOnEmptyEnter` to `false` to disable the automatic key while retaining the palette command. Set `sendBinding` to another key sequence, such as `"ctrl+enter"`, or `"none"` to leave the command palette-only. The same options work for a local package entry; replace `package` with the plugin path.

## Prompt format

```text
I have annotated specific parts of your earlier responses. Each annotation quotes the exact span I selected, followed by my question or comment about that span. Source labels identify the response being discussed. Please address each one.

[1] "the exact selected span"
    Source: assistant response 2 (message msg_example_2)
    → your comment

[2] "another exact selected span"
    Source: assistant response 5 (message msg_example_5)
    → your comment

Text typed in the composer
```

The parser flattens common Markdown patterns before display and selection, including emphasis, inline code, links, images, headings, block quotes, and code fences. Visible link and image labels remain; list markers become `•`. Because selection operates on display text, a quoted span may differ from the original Markdown source syntax.

## Annotation lifecycle

- Annotations are staged per OpenCode session and survive panel closure and TUI restart.
- A newer assistant response makes the staged set stale. The summary disappears and the annotations are not attached.
- The next eligible user prompt receives the complete staged set once. Prompts already beginning with the annotation header are not rewritten.
- The panel fetches the complete assistant history independently of the transcript cache, then merges live cached messages for display.

### Technical details

The TUI plugin registers `local.annotate.tui`; the server registers `local.annotate`. Staged annotations are written under the key `annotations` to:

```text
$XDG_STATE_HOME/opencode/<channel>/tui/plugin.local.annotate.tui.annotations.json
```

When `XDG_STATE_HOME` is unset, the default is `~/.local/state/opencode/<channel>/tui/plugin.local.annotate.tui.annotations.json`. The server reads that file directly, so the TUI and server must share its filesystem.

## Local development

Clone the repository where your OpenCode configuration can reach it:

```sh
git clone https://github.com/prestonlogan/opencode2-annotate-plugin.git \
  ~/.config/opencode/plugins/annotate
```

Add `"./plugins/annotate"` to the `plugins` array in `~/.config/opencode/opencode.json`, preserving existing entries.

The compiled `dist/tui.js` is checked in. After editing `tui.tsx`, rebuild and restart OpenCode:

```sh
npm ci
npm run compile:tui
```

## Source layout

- `index.ts` — server plugin and prompt hook.
- `tui.tsx` — panel, selection, annotations, keymaps, and composer strip.
- `shared.ts` — annotation types, prompt format, and storage paths.
- `build.mjs` — Solid/OpenTUI TUI compilation.
- `dist/tui.js` — checked-in bundle used by installed packages.
