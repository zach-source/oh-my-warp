# Embedded Browser Pane (oh-my-warp)

Design for embedding [`vercel-labs/agent-browser`](https://github.com/vercel-labs/agent-browser) as a **new pane/tab type** in Warp — a browser viewport that lives *inside* the split layout next to terminal panes, so the AI agent and the human see and act on the same browser.

> **TL;DR.** Yes, it's possible — but **not the way cmux does it.** cmux is an AppKit app and drops a native `WKWebView` into a pane. Warp is **GPUI** (everything is GPU-drawn to a Metal surface; panes are drawn `Element`s, not `NSView`s), so a native web view can't be a pane. The Warp-native path is to render **agent-browser's WebSocket viewport stream** as decoded frames in a `PaneContent` and forward input over CDP. Warp's pane layer is *already heterogeneous* (Settings/Code/Notebook panes exist), so a new `BrowserPane` is a first-class extension, not a hack. The hard part is the frame-stream element, not the pane plumbing.

> Grounded in the current tree (file:line cited inline). Sections marked **[today]** describe what exists; **[proposed]** is the design; **[external]** describes agent-browser/cmux.

---

## 1. What `agent-browser` is **[external]**

A **Rust CLI + CDP daemon** that drives a real browser for AI agents — *not* an embeddable widget:

- **Client–daemon, pure Rust, direct CDP.** The CLI parses commands; a persistent daemon talks Chrome DevTools Protocol (no Node.js for the core). Chrome via CDP, Safari via WebDriver.
- **Viewport streaming over WebSocket** — "stream the browser viewport via WebSocket for live preview or *pair browsing*." Port via `AGENT_BROWSER_STREAM_PORT`.
- **CDP attach** — `--cdp <port|ws-url>` to drive an existing browser; integrates with Browserless/Browserbase/Kernel/etc.
- **Next.js dashboard** on `:4848` — live viewport + command feed (a web app, separate from the core).
- **Batch commands** over stdin; `agent-browser open <url>`, `click`, `type`, snapshot the a11y tree, eval JS.

The two embeddable surfaces are therefore: **(a) the WebSocket viewport stream** (decoded frames) and **(b) the Next.js dashboard** (a web page). The browser itself is a real Chromium driven over CDP.

## 2. How cmux does it **[external]**

cmux (`manaflow-ai/cmux`) is a **Swift / AppKit** macOS terminal (libghostty for the terminal grid). Its browser pane is a **native `WKWebView`** (WebKit) placed directly in the pane layout, with a scriptable API (snapshot a11y tree, click, fill, eval JS). Agents drive the GUI via a CLI → **Unix-domain-socket** IPC; each pane gets a `CMUX_SOCKET_PATH`. The split system ("Bonsplit") arranges tabs/panes/splits.

**Why that works for cmux:** it's an AppKit app, so a `WKWebView` is just another `NSView` sibling of libghostty's view in the same view hierarchy — native compositing, real DevTools, native input, for free.

## 3. Why Warp is different — the crux **[today]**

Warp is built on **GPUI** (Zed's retained-mode, GPU-rendered UI framework). The window hosts a **Metal surface**; every pane, tab, and widget is a GPUI `Element` painted on the GPU — there is **no per-pane `NSView` hierarchy** to slot a `WKWebView` into.

- `crates/warpui/src/platform/mac/window.rs` uses `NSView` only for **window management** (window chrome, the Metal layer) — never for embedding content views.
- `crates/warpui_core/src/platform/mod.rs` exposes only platform **modals and file pickers** — no native content-view embedding, no `WKWebView`, no `CALayer`/Metal compositing of foreign views.

So **cmux's "WKWebView as a pane" is not portable to Warp.** Compositing a real `WKWebView` into the GPU framebuffer (offscreen render → `IOSurface`/Metal texture → draw in GPUI, plus reverse-routing input) is possible in theory but is heavy, undocumented platform work — see §7 option D. It is **not** the recommended path.

## 4. What Warp already has that helps **[today]**

The pane layer is **not** terminal-specific — heterogeneous panes are the norm:

- **Generic split tree.** `enum PaneNode { Branch(PaneBranch), Leaf(PaneId) }` (`app/src/pane_group/tree.rs:109`); a `PaneBranch` holds a `SplitDirection` + `(PaneFlex, PaneNode)` children. Panes are stored as `HashMap<PaneId, Box<dyn AnyPaneContent>>` (`app/src/pane_group/mod.rs:852`).
- **Polymorphic pane content.** `trait PaneContent` (`app/src/pane_group/pane/mod.rs:570`) is the abstraction every pane implements; a pane wraps a backing `View` via `PaneView<V>` (`app/src/pane_group/pane/view/mod.rs`). Existing **non-terminal** panes: `SettingsPane` (`settings_pane.rs`), `CodePane` (`code_pane.rs`), `NotebookPane` (`notebook_pane.rs`), plus Welcome/GetStarted/AIDocument/Workflow panes — all peers of terminal panes in the same splits.
- **Pane kinds for persistence.** String constants in `crates/persistence/src/model.rs:530` (`TERMINAL_PANE_KIND`, `CODE_PANE_KIND`, `SETTINGS_PANE_KIND`, …) — add a `"browser"` kind.
- **Image / animated rendering.** `struct Image` (`crates/warpui_core/src/elements/image.rs:38`) supports animated images and repaint-on-frame, but is asset-based (paths/URLs) — a live RGBA frame stream needs a thin custom element (see §6).
- **Automatic input routing.** A pane's backing `View` receives keystrokes via the responder chain (`crates/warpui_core/src/core/app.rs` `dispatch_keystroke`) and mouse via element handlers (`on_mouse_down`, `hoverable.rs`, `selectable_area.rs`). No special wiring needed for a custom pane to get focus + events.

**Consequence:** adding a `BrowserPane` requires **no layout changes** — it slots into splits exactly like `SettingsPane`. The only genuinely new piece is *rendering a live frame stream* + *forwarding input to the browser*.

## 5. Proposed architecture **[proposed]**

A **`BrowserPane`** that renders agent-browser's WebSocket viewport stream and forwards input over CDP. The browser is real Chromium driven by agent-browser; the pane is the human-visible "pair-browsing" view of what the agent does.

```
┌─ Warp (GPUI) ─────────────────────────────┐        ┌─ agent-browser ─────────────┐
│  Tab → split tree → BrowserPane            │        │  Rust daemon (CDP)          │
│    BrowserView (GPUI View, PaneContent)    │        │   ├─ controls real Chromium │
│      ├─ FrameStream element  ◀──frames──── │◀══ WS ═│   └─ Page.startScreencast   │
│      │    (decode JPEG → GPU texture)      │        │                             │
│      ├─ toolbar (url / back / fwd / reload)│──cmds─▶│  CDP / CLI command channel  │
│      └─ input capture (mouse/keys) ────────│──CDP──▶│   Input.dispatchMouseEvent  │
└────────────────────────────────────────────┘        └─────────────────────────────┘
        ▲ also driven by the AI agent (warp.ai tool / MCP) ──────────┘
```

**Data flow:**
1. **Lifecycle.** Warp spawns the agent-browser daemon (or attaches with `--cdp`) when the first browser pane opens; reuses it for subsequent panes; one CDP target (tab) per pane. Mirror `PluginHost`'s child-process management (`app/src/plugin/app/mod.rs`).
2. **Frames.** `BrowserView` connects to the viewport WebSocket (or drives CDP `Page.startScreencast` directly), decodes each JPEG frame off the UI thread, uploads it to a GPU texture, and renders it via a **`FrameStream` element** that requests a repaint per frame (~30–60 fps).
3. **Input.** The pane captures mouse (`on_mouse_down`/move/scroll) and keys (responder chain), maps pane-local → viewport coordinates (accounting for device-pixel ratio), and sends CDP `Input.dispatchMouseEvent`/`dispatchKeyEvent` (or agent-browser `click x y` / `type` commands) to the daemon.
4. **Toolbar.** A small GPUI control row (URL field, back/forward/reload) issuing agent-browser commands — reuse the button/dropdown patterns from `settings_view`.
5. **AI integration (ties into M4).** The same daemon is driven by the Warp agent or a plugin via **`warp.ai.registerTool`** (PLUGIN_SPEC.md M4) / MCP — `navigate`, `click`, `snapshot a11y` — so the agent's actions appear live in the pane. This is the "browser inside the session, not adjacent to it" property cmux highlights.

**Files a patch series would add/touch (all additive → patch-compatible):**

| Piece | Location |
|---|---|
| `BrowserPane` (`PaneContent`) + `BrowserView` | new `app/src/pane_group/pane/browser_pane.rs` |
| `FrameStream` element (RGBA texture, per-frame repaint) | new in `crates/warpui_core/src/elements/` (or app-side) |
| agent-browser client (spawn/attach, WS frames, CDP/command channel) | new `app/src/browser/` (or a crate) |
| `BROWSER_PANE_KIND` + restore (last URL) | `crates/persistence/src/model.rs` |
| "Open browser pane" action + palette/keybinding | `app/src/workspace/…` (mirror split/new-tab actions) |

## 6. Streaming & input details / risks **[proposed]**

- **Frame pipeline.** CDP screencast emits base64 **JPEG** frames (`Page.screencastFrame`). Decode on a worker thread → RGBA → upload to a GPU texture each frame → repaint. The new `FrameStream` element is the only low-level addition; everything else reuses `Image`-style plumbing (`image.rs:38`). Throttle to the daughter stream's fps; ack frames (CDP `screencastFrameAck`) to apply backpressure.
- **Input fidelity.** Mouse coordinate scaling (DPR), button/modifier mapping, scroll, and IME/keyboard composition all route through CDP `Input.*`. Good enough for navigation and "pair browsing"; not pixel-perfect-native (no real focus ring, no native context menus).
- **Latency.** WS + decode + texture upload + repaint is tens of milliseconds — fine for monitoring and light interaction; not for video/games. Acceptable for an agent-browsing surface.
- **No DevTools / native chrome.** It's a stream of a remote browser, not a local web view. If full native interactivity is required, that's option D (heavy).
- **Resource use.** A real Chromium per session; screencast CPU for JPEG decode. Spawn lazily, tear down with the last pane.

## 7. Alternatives considered **[proposed]**

| Option | What | Verdict |
|---|---|---|
| **A. WebSocket frame `BrowserPane`** (§5) | Stream agent-browser's viewport into a GPUI pane; input via CDP | **Recommended.** True "browser-in-a-pane" within GPUI's constraints; reuses the heterogeneous pane layer; only new low-level piece is the frame element. |
| **B. External dashboard** | Open agent-browser's Next.js dashboard (`:4848`) in the user's real browser | Trivial; zero embedding. Weakest integration (not a pane). Good Phase-0 proof. |
| **C. Native window** | Spawn a separate AppKit window hosting a real `WKWebView`/the dashboard | Real browser, real DevTools; but a floating window, not in the split layout. Needs a small AppKit helper (GPUI can't host the web view in-pane). |
| **D. Composite WKWebView into GPUI** | Offscreen-render `WKWebView` → `IOSurface`/Metal texture → draw in GPUI; reverse-route input | The "real" cmux-parity result, but heavy, fragile, undocumented platform work. **Not recommended** unless A's fidelity proves insufficient. |

## 8. Phased plan **[proposed]**

- **Phase 0 — prove the pipe.** Spawn/attach the agent-browser daemon from Warp; add a command to open the `:4848` dashboard externally (option B). Confirms process management + the agent can drive the browser. *(Tiny.)*
- **Phase 1 — view-only pane.** `BrowserPane` + `FrameStream` element rendering the WS/screencast frames. Browser visible in a split, no input yet. *(The core new work.)*
- **Phase 2 — interactive.** Forward mouse + keyboard to CDP `Input.*`; coordinate/DPR mapping. *(Makes it usable.)*
- **Phase 3 — polish + agent.** Toolbar (URL/back/forward), persistence (`BROWSER_PANE_KIND`, last URL), and AI driving via `warp.ai.registerTool`/MCP so the agent's browsing shows live in the pane.

## 9. Open questions **[proposed]**

1. **Stream protocol.** Use agent-browser's WebSocket viewport stream as-is, or drive CDP `Page.startScreencast` ourselves (more control over fps/quality/acks)? Needs reading agent-browser's stream format.
2. **Bundling.** Ship/spawn the agent-browser binary, or require a user-installed one? (Affects packaging + the Chromium download.)
3. **One daemon or per-pane?** Shared daemon with a CDP target per pane vs. isolated daemons.
4. **Fallback trigger.** If A's input latency/fidelity is poor, do we invest in option D, or settle for C (native window)?
5. **Agent control surface.** Expose browser control as an `warp.ai` plugin tool (M4) vs. a built-in agent capability vs. MCP server?

---

### Bottom line

It's feasible and a natural fit for Warp's already-heterogeneous pane layer — but the implementation diverges from cmux precisely because Warp is GPUI, not AppKit. cmux gets a native `WKWebView` pane for free; Warp instead renders agent-browser's **viewport stream** as frames and forwards input over CDP. That keeps the browser *inside the session* (the property that makes the agent + human share one view) without inventing native-view compositing.
