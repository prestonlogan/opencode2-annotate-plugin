// tui.tsx
import { use as _$use } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { For, Show, createEffect, createMemo, createSignal, onMount, onCleanup } from "solid-js";
import { TextAttributes } from "@opentui/core";
import { Plugin, usePlugin } from "@opencode/plugin/tui";

// shared.ts
var PANEL = "local.annotate.panel";
var STORE_KEY = "annotations";
var PROMPT_HEADER = "I have annotated specific parts of your earlier responses. Each annotation quotes the exact span I selected, followed by my question or comment about that span. Source labels identify the response being discussed. Please address each one.";
function buildPrompt(items, extra) {
  const lines = [PROMPT_HEADER, "", ...items.flatMap((a, i) => [
    `[${i + 1}] "${a.span}"`,
    ...a.messageID ? [`    Source: assistant response ${a.responseNumber ?? ""} (message ${a.messageID})`] : [],
    `    \u2192 ${a.comment}`,
    ""
  ])];
  if (extra.trim()) lines.push(extra.trim());
  return lines.join("\n").trimEnd();
}

// tui.tsx
function lastAssistantText(context, sessionID) {
  const messages = context.data.session.message.list(sessionID) ?? [];
  const last = [...messages].reverse().find((m) => m.type === "assistant");
  if (!last) return {
    id: void 0,
    text: ""
  };
  const parts = (last.content ?? []).filter((p) => p.type === "text");
  return {
    id: last.id,
    text: parts.map((p) => p.text).join("\n").trim()
  };
}
function assistantResponses(messages) {
  return messages.filter((message) => message.type === "assistant").map((message) => ({
    id: message.id,
    text: (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n").trim()
  })).filter((message) => message.text.length > 0);
}
function stripMarkdown(md) {
  return md.replace(/```[\w-]*\n?/g, "").replace(/^\s{0,3}#{1,6}\s+/gm, "").replace(/^\s*>\s?/gm, "").replace(/^\s*[-*+]\s+/gm, "\u2022 ").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)(.+?)\1/g, "$2").replace(/(^|[^*\w])(\*|_)(?!\s)(.+?)(?<!\s)\2(?!\w)/g, "$1$3").replace(/~~(.+?)~~/g, "$1").replace(/`([^`]+)`/g, "$1").replace(/[ \t]+$/gm, "").trim();
}
function tokenize(text) {
  const out = [];
  const lines = text.split(/\n/);
  lines.forEach((line, li) => {
    for (const w of line.split(/\s+/).filter(Boolean)) out.push({
      i: out.length,
      text: w,
      br: false
    });
    if (li < lines.length - 1) out.push({
      i: out.length,
      text: "",
      br: true
    });
  });
  return out;
}
function clip(s, n) {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + "\u2026" : s;
}
function useAnnotations(context, sessionID) {
  const [store, updateStore] = context.storage.store(STORE_KEY, {
    initial: {}
  });
  const target = createMemo(() => lastAssistantText(context, sessionID()));
  const items = createMemo(() => {
    const entry = store[sessionID()];
    if (!entry) return [];
    if (entry.messageID && target().id && entry.messageID !== target().id) return [];
    return entry.items ?? [];
  });
  const hasEntry = createMemo(() => store[sessionID()] !== void 0);
  const set = (fn) => updateStore((draft) => {
    draft[sessionID()] = {
      messageID: target().id,
      items: fn(items())
    };
  });
  return {
    target,
    items,
    set,
    hasEntry
  };
}
async function confirmDiscard(context, count) {
  if (count === 0) return true;
  const ok = await context.ui.dialog.confirm({
    title: "Discard annotations?",
    message: `${count} staged annotation${count === 1 ? "" : "s"} will be removed and not sent.`,
    label: {
      confirm: "Discard",
      cancel: "Keep"
    }
  });
  return ok === true;
}
function AnnotatePanel(props) {
  const context = usePlugin();
  const theme = () => context.theme;
  const {
    items: annotations,
    set: setAnnotations,
    hasEntry
  } = useAnnotations(context, () => props.panel.sessionID);
  const [history, setHistory] = createSignal([]);
  const [historyState, setHistoryState] = createSignal("loading");
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  onMount(async () => {
    try {
      const messages = [];
      let cursor;
      const seen = /* @__PURE__ */ new Set();
      do {
        const page = await context.client.message.list({
          sessionID: props.panel.sessionID,
          limit: 200,
          ...cursor ? {
            cursor
          } : {
            order: "asc"
          }
        });
        if (disposed) return;
        messages.push(...page.data);
        cursor = page.cursor.next ?? void 0;
        if (cursor && seen.has(cursor)) throw new Error("History pagination repeated a cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      setHistory(messages);
      setHistoryState("ready");
    } catch (error) {
      if (disposed) return;
      setHistoryState("error");
      context.ui.toast.show({
        title: "Could not load response history",
        message: `${String(error)}. Reopen /annotate to retry.`,
        variant: "error"
      });
    }
  });
  const responses = createMemo(() => {
    const messages = new Map(history().map((message) => [message.id, message]));
    for (const message of context.data.session.message.list(props.panel.sessionID) ?? []) messages.set(message.id, message);
    return assistantResponses([...messages.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  });
  const [selectedID, setSelectedID] = createSignal();
  const responseIndex = createMemo(() => {
    const index = responses().findIndex((response) => response.id === selectedID());
    return index >= 0 ? index : responses().length - 1;
  });
  const target = createMemo(() => responses()[responseIndex()] ?? {
    id: void 0,
    text: ""
  });
  let responseScroll;
  const tokens = createMemo(() => tokenize(stripMarkdown(target().text)));
  const [anchor, setAnchor] = createSignal(null);
  const [focus, setFocus] = createSignal(null);
  const [dragging, setDragging] = createSignal(false);
  const range = createMemo(() => {
    const a = anchor(), f = focus();
    if (a === null || f === null) return null;
    return {
      lo: Math.min(a, f),
      hi: Math.max(a, f)
    };
  });
  const inRange = (i) => {
    const r = range();
    return !!r && i >= r.lo && i <= r.hi;
  };
  const selectedText = createMemo(() => {
    const r = range();
    if (!r) return "";
    return tokens().slice(r.lo, r.hi + 1).filter((t) => !t.br).map((t) => t.text).join(" ");
  });
  const clearSelection = () => {
    setAnchor(null);
    setFocus(null);
    setDragging(false);
  };
  const navigateResponse = (direction) => {
    if (historyState() !== "ready") return;
    const index = Math.max(0, Math.min(responses().length - 1, responseIndex() + direction));
    const response = responses()[index];
    if (!response || response.id === target().id) return;
    clearSelection();
    wordRefs.clear();
    setSelectedID(response.id);
    responseScroll?.scrollTo(0);
  };
  const wordRefs = /* @__PURE__ */ new Map();
  const wordAt = (x, y) => {
    for (const [i, el] of wordRefs) {
      if (!el || el.isDestroyed || !el.visible) continue;
      if (x >= el.x && x < el.x + el.width && y >= el.y && y < el.y + el.height) return i;
    }
    return null;
  };
  const extendTo = (e) => {
    if (!dragging() || !e) return;
    const i = wordAt(e.x, e.y);
    if (i !== null) setFocus(i);
  };
  const onWordDown = (i) => {
    setAnchor(i);
    setFocus(i);
    setDragging(true);
  };
  const onUp = () => setDragging(false);
  const addAnnotation = async () => {
    if (historyState() !== "ready") {
      context.ui.toast.show({
        message: historyState() === "loading" ? "Loading response history; please wait." : "Reopen /annotate to retry loading history.",
        variant: "warning"
      });
      return;
    }
    const span = selectedText();
    const messageID = target().id;
    const responseNumber = responseIndex() + 1;
    if (!span) {
      context.ui.toast.show({
        message: "Drag across words in the response first.",
        variant: "warning"
      });
      return;
    }
    const comment = await context.ui.dialog.prompt({
      title: "Annotate selection",
      description: `\u201C${clip(span, 90)}\u201D`,
      placeholder: "Your question or comment about this span"
    });
    if (!comment?.trim()) return;
    await setAnnotations((list) => [...list, {
      id: crypto.randomUUID(),
      span,
      comment: comment.trim(),
      messageID,
      responseNumber
    }]);
    clearSelection();
  };
  const removeLast = () => void setAnnotations((list) => list.slice(0, -1));
  const done = () => {
    clearSelection();
    props.panel.close();
  };
  const discard = async () => {
    if (!await confirmDiscard(context, annotations().length)) return;
    await setAnnotations(() => []);
    clearSelection();
    props.panel.close();
  };
  let hadEntry = hasEntry();
  createEffect(() => {
    const now = hasEntry();
    if (hadEntry && !now) props.panel.close();
    hadEntry = now;
  });
  context.keymap.layer(() => ({
    commands: [{
      id: "local.annotate.discard",
      title: "Discard annotations and close",
      bind: "escape",
      run: () => void discard()
    }, {
      id: "local.annotate.done",
      title: "Done (keep staged) and close",
      bind: "return",
      run: done
    }, {
      id: "local.annotate.older",
      title: "Previous assistant response",
      bind: "up",
      run: () => navigateResponse(-1)
    }, {
      id: "local.annotate.newer",
      title: "Next assistant response",
      bind: "down",
      run: () => navigateResponse(1)
    }, {
      id: "local.annotate.fullscreen",
      title: "Toggle annotate fullscreen",
      bind: "f",
      run: props.panel.toggleFullscreen
    }, {
      id: "local.annotate.add",
      title: "Annotate selection",
      bind: "a",
      run: () => void addAnnotation()
    }, {
      id: "local.annotate.undo",
      title: "Remove last annotation",
      bind: "u",
      run: removeLast
    }, {
      id: "local.annotate.clear",
      title: "Clear selection",
      bind: "c",
      run: clearSelection
    }]
  }));
  const Hint = (p) => (() => {
    var _el$ = _$createElement("text"), _el$2 = _$createElement("span"), _el$3 = _$createTextNode(` `);
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$setProp(_el$, "selectable", false);
    _$insert(_el$2, () => p.k);
    _$insert(_el$, () => p.label, null);
    _$effect((_p$) => {
      var _v$ = theme().text.subdued, _v$2 = {
        fg: theme().text.default,
        attributes: TextAttributes.BOLD
      };
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$2, "style", _v$2, _p$.t));
      return _p$;
    }, {
      e: void 0,
      t: void 0
    });
    return _el$;
  })();
  return (() => {
    var _el$4 = _$createElement("box"), _el$5 = _$createElement("box"), _el$6 = _$createElement("box"), _el$7 = _$createElement("text"), _el$9 = _$createElement("text"), _el$0 = _$createElement("box"), _el$1 = _$createElement("scrollbox"), _el$11 = _$createElement("box"), _el$18 = _$createElement("text"), _el$19 = _$createTextNode(`Annotations `), _el$21 = _$createElement("span"), _el$22 = _$createTextNode(`(`), _el$23 = _$createTextNode(`)`);
    _$insertNode(_el$4, _el$5);
    _$insertNode(_el$4, _el$1);
    _$insertNode(_el$4, _el$11);
    _$setProp(_el$4, "flexDirection", "column");
    _$setProp(_el$4, "flexGrow", 1);
    _$setProp(_el$4, "minHeight", 0);
    _$setProp(_el$4, "paddingLeft", 2);
    _$setProp(_el$4, "paddingRight", 2);
    _$setProp(_el$4, "paddingTop", 1);
    _$setProp(_el$4, "onMouseUp", onUp);
    _$insertNode(_el$5, _el$6);
    _$insertNode(_el$5, _el$0);
    _$setProp(_el$5, "flexShrink", 0);
    _$setProp(_el$5, "flexDirection", "column");
    _$setProp(_el$5, "paddingBottom", 1);
    _$setProp(_el$5, "border", ["bottom"]);
    _$insertNode(_el$6, _el$7);
    _$insertNode(_el$6, _el$9);
    _$setProp(_el$6, "flexDirection", "row");
    _$setProp(_el$6, "justifyContent", "space-between");
    _$insertNode(_el$7, _$createTextNode(`Annotate`));
    _$setProp(_el$7, "selectable", false);
    _$setProp(_el$9, "selectable", false);
    _$insert(_el$9, (() => {
      var _c$ = _$memo(() => historyState() === "loading");
      return () => _c$() ? "Loading response history..." : _$memo(() => historyState() === "error")() ? "History unavailable - reopen to retry" : `Response ${responseIndex() + 1} of ${responses().length}${responseIndex() === responses().length - 1 && responses().length > 0 ? " (latest)" : ""}`;
    })());
    _$setProp(_el$0, "flexDirection", "row");
    _$setProp(_el$0, "flexWrap", "wrap");
    _$setProp(_el$0, "columnGap", 2);
    _$setProp(_el$0, "paddingTop", 1);
    _$insert(_el$0, _$createComponent(Hint, {
      k: "drag",
      label: "select"
    }), null);
    _$insert(_el$0, _$createComponent(Hint, {
      k: "up",
      label: "older"
    }), null);
    _$insert(_el$0, _$createComponent(Hint, {
      k: "down",
      label: "newer"
    }), null);
    _$insert(_el$0, _$createComponent(Hint, {
      k: "a",
      label: "annotate"
    }), null);
    _$insert(_el$0, _$createComponent(Hint, {
      k: "enter",
      label: "done"
    }), null);
    _$insert(_el$0, _$createComponent(Hint, {
      k: "u",
      label: "undo"
    }), null);
    _$insert(_el$0, _$createComponent(Hint, {
      k: "c",
      label: "clear"
    }), null);
    _$insert(_el$0, _$createComponent(Hint, {
      k: "f",
      label: "fullscreen"
    }), null);
    _$insert(_el$0, _$createComponent(Hint, {
      k: "esc",
      label: "discard"
    }), null);
    _$use((el) => {
      responseScroll = el;
    }, _el$1);
    _$setProp(_el$1, "flexGrow", 1);
    _$setProp(_el$1, "minHeight", 0);
    _$setProp(_el$1, "paddingTop", 1);
    _$setProp(_el$1, "paddingBottom", 1);
    _$insert(_el$1, _$createComponent(Show, {
      get when() {
        return tokens().length;
      },
      get fallback() {
        return (() => {
          var _el$26 = _$createElement("text");
          _$insertNode(_el$26, _$createTextNode(`No assistant response in this session yet.`));
          _$setProp(_el$26, "selectable", false);
          _$effect((_$p) => _$setProp(_el$26, "fg", theme().text.subdued, _$p));
          return _el$26;
        })();
      },
      get children() {
        var _el$10 = _$createElement("box");
        _$setProp(_el$10, "flexDirection", "row");
        _$setProp(_el$10, "flexWrap", "wrap");
        _$insert(_el$10, _$createComponent(For, {
          get each() {
            return tokens();
          },
          children: (t) => _$createComponent(Show, {
            get when() {
              return !t.br;
            },
            get fallback() {
              return (() => {
                var _el$29 = _$createElement("box");
                _$setProp(_el$29, "width", "100%");
                _$setProp(_el$29, "height", 1);
                return _el$29;
              })();
            },
            get children() {
              var _el$28 = _$createElement("text");
              _$use((el) => wordRefs.set(t.i, el), _el$28);
              _$setProp(_el$28, "selectable", false);
              _$setProp(_el$28, "onMouseDown", (e) => {
                e?.preventDefault?.();
                onWordDown(t.i);
              });
              _$setProp(_el$28, "onMouseDrag", extendTo);
              _$setProp(_el$28, "onMouseDragEnd", (e) => {
                extendTo(e);
                onUp();
              });
              _$setProp(_el$28, "onMouseUp", (e) => {
                extendTo(e);
                onUp();
              });
              _$insert(_el$28, () => t.text + " ");
              _$effect((_p$) => {
                var _v$12 = inRange(t.i) ? theme().text.action.primary.focused : theme().text.default, _v$13 = inRange(t.i) ? theme().background.action.primary.focused : void 0;
                _v$12 !== _p$.e && (_p$.e = _$setProp(_el$28, "fg", _v$12, _p$.e));
                _v$13 !== _p$.t && (_p$.t = _$setProp(_el$28, "bg", _v$13, _p$.t));
                return _p$;
              }, {
                e: void 0,
                t: void 0
              });
              return _el$28;
            }
          })
        }));
        return _el$10;
      }
    }));
    _$insertNode(_el$11, _el$18);
    _$setProp(_el$11, "flexShrink", 0);
    _$setProp(_el$11, "flexDirection", "column");
    _$setProp(_el$11, "paddingTop", 1);
    _$setProp(_el$11, "border", ["top"]);
    _$insert(_el$11, _$createComponent(Show, {
      get when() {
        return selectedText();
      },
      get children() {
        var _el$12 = _$createElement("box"), _el$13 = _$createElement("text"), _el$15 = _$createElement("text"), _el$16 = _$createTextNode(`\u201C`), _el$17 = _$createTextNode(`\u201D`);
        _$insertNode(_el$12, _el$13);
        _$insertNode(_el$12, _el$15);
        _$setProp(_el$12, "flexDirection", "row");
        _$setProp(_el$12, "gap", 1);
        _$setProp(_el$12, "paddingBottom", 1);
        _$insertNode(_el$13, _$createTextNode(`Selected`));
        _$setProp(_el$13, "selectable", false);
        _$insertNode(_el$15, _el$16);
        _$insertNode(_el$15, _el$17);
        _$setProp(_el$15, "selectable", false);
        _$insert(_el$15, () => clip(selectedText(), 70), _el$17);
        _$effect((_p$) => {
          var _v$3 = theme().text.feedback.info.default, _v$4 = TextAttributes.BOLD, _v$5 = theme().text.feedback.info.default;
          _v$3 !== _p$.e && (_p$.e = _$setProp(_el$13, "fg", _v$3, _p$.e));
          _v$4 !== _p$.t && (_p$.t = _$setProp(_el$13, "attributes", _v$4, _p$.t));
          _v$5 !== _p$.a && (_p$.a = _$setProp(_el$15, "fg", _v$5, _p$.a));
          return _p$;
        }, {
          e: void 0,
          t: void 0,
          a: void 0
        });
        return _el$12;
      }
    }), _el$18);
    _$insertNode(_el$18, _el$19);
    _$insertNode(_el$18, _el$21);
    _$setProp(_el$18, "selectable", false);
    _$insertNode(_el$21, _el$22);
    _$insertNode(_el$21, _el$23);
    _$insert(_el$21, () => annotations().length, _el$23);
    _$insert(_el$11, _$createComponent(Show, {
      get when() {
        return annotations().length === 0;
      },
      get children() {
        var _el$24 = _$createElement("text");
        _$insertNode(_el$24, _$createTextNode(`Select text and press a to add one.`));
        _$setProp(_el$24, "selectable", false);
        _$effect((_$p) => _$setProp(_el$24, "fg", theme().text.subdued, _$p));
        return _el$24;
      }
    }), null);
    _$insert(_el$11, _$createComponent(For, {
      get each() {
        return annotations();
      },
      children: (a, i) => (() => {
        var _el$30 = _$createElement("box"), _el$31 = _$createElement("text"), _el$32 = _$createElement("span"), _el$33 = _$createTextNode(`.`), _el$34 = _$createTextNode(` `), _el$35 = _$createTextNode(`\u201C`), _el$36 = _$createTextNode(`\u201D`), _el$37 = _$createElement("box"), _el$38 = _$createElement("text"), _el$39 = _$createTextNode(`\u2192 `);
        _$insertNode(_el$30, _el$31);
        _$insertNode(_el$30, _el$37);
        _$setProp(_el$30, "flexDirection", "column");
        _$setProp(_el$30, "paddingTop", 1);
        _$insertNode(_el$31, _el$32);
        _$insertNode(_el$31, _el$34);
        _$insertNode(_el$31, _el$35);
        _$insertNode(_el$31, _el$36);
        _$setProp(_el$31, "selectable", false);
        _$insertNode(_el$32, _el$33);
        _$insert(_el$32, () => i() + 1, _el$33);
        _$insert(_el$31, (() => {
          var _c$2 = _$memo(() => !!a.responseNumber);
          return () => _c$2() ? `[response ${a.responseNumber}] ` : "";
        })(), _el$35);
        _$insert(_el$31, () => clip(a.span, 60), _el$36);
        _$insertNode(_el$37, _el$38);
        _$setProp(_el$37, "paddingLeft", 3);
        _$insertNode(_el$38, _el$39);
        _$setProp(_el$38, "selectable", false);
        _$insert(_el$38, () => a.comment, null);
        _$effect((_p$) => {
          var _v$14 = theme().text.subdued, _v$15 = {
            fg: theme().text.default,
            attributes: TextAttributes.BOLD
          }, _v$16 = theme().text.default;
          _v$14 !== _p$.e && (_p$.e = _$setProp(_el$31, "fg", _v$14, _p$.e));
          _v$15 !== _p$.t && (_p$.t = _$setProp(_el$32, "style", _v$15, _p$.t));
          _v$16 !== _p$.a && (_p$.a = _$setProp(_el$38, "fg", _v$16, _p$.a));
          return _p$;
        }, {
          e: void 0,
          t: void 0,
          a: void 0
        });
        return _el$30;
      })()
    }), null);
    _$effect((_p$) => {
      var _v$6 = theme().border.default, _v$7 = theme().text.default, _v$8 = TextAttributes.BOLD, _v$9 = theme().text.subdued, _v$0 = theme().border.default, _v$1 = theme().text.default, _v$10 = TextAttributes.BOLD, _v$11 = {
        fg: theme().text.subdued,
        attributes: TextAttributes.NONE
      };
      _v$6 !== _p$.e && (_p$.e = _$setProp(_el$5, "borderColor", _v$6, _p$.e));
      _v$7 !== _p$.t && (_p$.t = _$setProp(_el$7, "fg", _v$7, _p$.t));
      _v$8 !== _p$.a && (_p$.a = _$setProp(_el$7, "attributes", _v$8, _p$.a));
      _v$9 !== _p$.o && (_p$.o = _$setProp(_el$9, "fg", _v$9, _p$.o));
      _v$0 !== _p$.i && (_p$.i = _$setProp(_el$11, "borderColor", _v$0, _p$.i));
      _v$1 !== _p$.n && (_p$.n = _$setProp(_el$18, "fg", _v$1, _p$.n));
      _v$10 !== _p$.s && (_p$.s = _$setProp(_el$18, "attributes", _v$10, _p$.s));
      _v$11 !== _p$.h && (_p$.h = _$setProp(_el$21, "style", _v$11, _p$.h));
      return _p$;
    }, {
      e: void 0,
      t: void 0,
      a: void 0,
      o: void 0,
      i: void 0,
      n: void 0,
      s: void 0,
      h: void 0
    });
    return _el$4;
  })();
}
function optionValue(options, key, fallback) {
  const snake = key.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
  const kebab = snake.replace(/_/g, "-");
  const keys = [key, snake, kebab, key.toLowerCase()];
  for (const candidate of keys) {
    if (options?.[candidate] !== void 0) return options[candidate];
  }
  return fallback;
}
function hasPendingQueuedPrompt(context, sessionID) {
  try {
    const pending = context.data.session?.pending?.list?.(sessionID) ?? [];
    return Array.isArray(pending) && pending.some((item) => item?.type === "user" && item?.delivery === "queue");
  } catch {
    return false;
  }
}
function ComposerStrip(props) {
  const context = usePlugin();
  const theme = () => context.theme;
  const {
    items,
    set
  } = useAnnotations(context, () => props.sessionID);
  const [sending, setSending] = createSignal(false);
  const composer = () => {
    const route = context.ui.router.current();
    if (route.type !== "session" || route.sessionID !== props.sessionID) return void 0;
    const editor = context.renderer.currentFocusedRenderable;
    if (!editor || editor.isDestroyed || !Object.prototype.hasOwnProperty.call(editor, "getClipboardText")) return void 0;
    return editor;
  };
  const hasComposerDraft = (editor) => {
    try {
      return !!editor?.plainText?.trim?.();
    } catch {
      return true;
    }
  };
  const autoSendEnabled = () => optionValue(context.options, "sendOnEmptyEnter", true) !== false;
  const sendBinding = () => {
    if (!autoSendEnabled()) return "none";
    const configured = optionValue(context.options, "sendBinding", "enter");
    if (configured === false || configured === "none") return "none";
    return typeof configured === "string" && configured.length > 0 ? configured : "enter";
  };
  const canSendStandalone = () => {
    try {
      if (sending()) return false;
      if (items().length === 0) return false;
      if (hasPendingQueuedPrompt(context, props.sessionID)) return false;
      const editor = composer();
      return !!editor && !hasComposerDraft(editor);
    } catch {
      return false;
    }
  };
  const sendAnnotationsOnly = async () => {
    const staged = items();
    if (staged.length === 0) return false;
    try {
      await context.client.session.prompt({
        sessionID: props.sessionID,
        text: buildPrompt(staged, ""),
        delivery: "steer"
      });
      void set(() => []).catch((error) => {
        context.ui.toast.show({
          message: `Could not clear annotations: ${String(error)}`,
          variant: "error"
        });
      });
      return true;
    } catch (error) {
      context.ui.toast.show({
        message: `Could not send annotations: ${String(error)}`,
        variant: "error"
      });
      return false;
    }
  };
  context.keymap.layer(() => ({
    target: composer,
    priority: 11,
    enabled: canSendStandalone(),
    commands: [{
      id: "local.annotate.send",
      title: "Send staged annotations",
      description: "Send staged comments without requiring a composer message",
      group: "Annotate",
      palette: true,
      bind: sendBinding(),
      run: async (_input, event) => {
        if (!canSendStandalone()) return false;
        event?.preventDefault();
        event?.stopPropagation();
        if (sending()) return true;
        setSending(true);
        try {
          await sendAnnotationsOnly();
          return true;
        } finally {
          setSending(false);
        }
      }
    }]
  }));
  context.keymap.layer(() => ({
    target: composer,
    priority: 10,
    enabled: items().length > 0,
    commands: [{
      id: "local.annotate.clear-draft",
      title: "Clear staged annotations with composer",
      bind: "ctrl+c",
      run: (_input, event) => {
        const editor = composer();
        if (!editor || items().length === 0) return false;
        const hasText = editor.plainText.length > 0;
        void set(() => []).catch((error) => {
          context.ui.toast.show({
            message: `Could not clear annotations: ${String(error)}`,
            variant: "error"
          });
        });
        if (hasText) return false;
        event?.preventDefault();
        event?.stopPropagation();
      }
    }]
  }));
  return _$createComponent(Show, {
    get when() {
      return items().length > 0;
    },
    get children() {
      var _el$40 = _$createElement("box"), _el$41 = _$createElement("box"), _el$42 = _$createElement("text"), _el$43 = _$createTextNode(` annotation`), _el$44 = _$createTextNode(` staged`), _el$45 = _$createElement("span");
      _$insertNode(_el$40, _el$41);
      _$setProp(_el$40, "flexDirection", "column");
      _$setProp(_el$40, "marginBottom", 1);
      _$setProp(_el$40, "paddingLeft", 1);
      _$setProp(_el$40, "paddingRight", 1);
      _$setProp(_el$40, "border", ["left"]);
      _$insertNode(_el$41, _el$42);
      _$setProp(_el$41, "flexDirection", "row");
      _$insertNode(_el$42, _el$43);
      _$insertNode(_el$42, _el$44);
      _$insertNode(_el$42, _el$45);
      _$setProp(_el$42, "selectable", false);
      _$insert(_el$42, () => items().length, _el$43);
      _$insert(_el$42, () => items().length === 1 ? "" : "s", _el$44);
      _$insertNode(_el$45, _$createTextNode(` \u2014 attached to your next message`));
      _$insert(_el$40, _$createComponent(For, {
        get each() {
          return items();
        },
        children: (a, i) => (() => {
          var _el$47 = _$createElement("text"), _el$48 = _$createElement("span"), _el$49 = _$createTextNode(`.`), _el$50 = _$createTextNode(` `), _el$51 = _$createTextNode(`\u201C`), _el$52 = _$createTextNode(`\u201D `), _el$54 = _$createElement("span"), _el$55 = _$createTextNode(`\u2192 `);
          _$insertNode(_el$47, _el$48);
          _$insertNode(_el$47, _el$50);
          _$insertNode(_el$47, _el$51);
          _$insertNode(_el$47, _el$52);
          _$insertNode(_el$47, _el$54);
          _$setProp(_el$47, "selectable", false);
          _$insertNode(_el$48, _el$49);
          _$insert(_el$48, () => i() + 1, _el$49);
          _$insert(_el$47, (() => {
            var _c$3 = _$memo(() => !!a.responseNumber);
            return () => _c$3() ? `[response ${a.responseNumber}] ` : "";
          })(), _el$51);
          _$insert(_el$47, () => clip(a.span, 40), _el$52);
          _$insertNode(_el$54, _el$55);
          _$insert(_el$54, () => clip(a.comment, 50), null);
          _$effect((_p$) => {
            var _v$21 = theme().text.subdued, _v$22 = {
              fg: theme().text.default
            }, _v$23 = {
              fg: theme().text.default
            };
            _v$21 !== _p$.e && (_p$.e = _$setProp(_el$47, "fg", _v$21, _p$.e));
            _v$22 !== _p$.t && (_p$.t = _$setProp(_el$48, "style", _v$22, _p$.t));
            _v$23 !== _p$.a && (_p$.a = _$setProp(_el$54, "style", _v$23, _p$.a));
            return _p$;
          }, {
            e: void 0,
            t: void 0,
            a: void 0
          });
          return _el$47;
        })()
      }), null);
      _$effect((_p$) => {
        var _v$17 = theme().text.feedback.info.default, _v$18 = theme().text.feedback.info.default, _v$19 = TextAttributes.BOLD, _v$20 = {
          fg: theme().text.subdued,
          attributes: TextAttributes.NONE
        };
        _v$17 !== _p$.e && (_p$.e = _$setProp(_el$40, "borderColor", _v$17, _p$.e));
        _v$18 !== _p$.t && (_p$.t = _$setProp(_el$42, "fg", _v$18, _p$.t));
        _v$19 !== _p$.a && (_p$.a = _$setProp(_el$42, "attributes", _v$19, _p$.a));
        _v$20 !== _p$.o && (_p$.o = _$setProp(_el$45, "style", _v$20, _p$.o));
        return _p$;
      }, {
        e: void 0,
        t: void 0,
        a: void 0,
        o: void 0
      });
      return _el$40;
    }
  });
}
var tui_default = Plugin.define({
  id: "local.annotate.tui",
  setup(context) {
    const offPanel = context.ui.slot({
      append: "session.panel",
      render: (panel) => _$createComponent(Show, {
        get when() {
          return panel.name === PANEL;
        },
        get children() {
          return _$createComponent(AnnotatePanel, {
            panel
          });
        }
      })
    });
    const offStrip = context.ui.slot({
      append: "session.composer.top",
      render: (input) => _$createComponent(ComposerStrip, {
        get sessionID() {
          return input.sessionID;
        }
      })
    });
    const offApp = context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [{
            id: "local.annotate.open",
            title: "Annotate responses",
            description: "Browse and annotate assistant responses, starting with the latest",
            group: "Annotate",
            palette: true,
            slash: {
              name: "annotate"
            },
            run: () => {
              const opened = context.ui.panel.open(PANEL);
              if (!opened) context.ui.toast.show({
                message: "Open a session first.",
                variant: "warning"
              });
            }
          }]
        }));
        return null;
      }
    });
    return () => {
      offPanel();
      offStrip();
      offApp();
    };
  }
});
export {
  tui_default as default
};
