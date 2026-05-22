# Warp Plugin Interface (oh-my-warp)

This is the design for an **easy, safe, third-party plugin system for Warp** — the kind where someone drops a folder in `~/.warp/plugins/` and gets new commands, keybindings, hooks, and light UI, in JavaScript, without forking or recompiling.

The central decision: **we do not invent a plugin system. We finish the one upstream already built.** Warp ships a dormant JavaScript plugin host (`app/src/plugin/`) — a crash-isolated subprocess that loads `~/.warp/plugins/*/main.js` into per-plugin [QuickJS](https://bellard.org/quickjs/) contexts and exposes a `warp.*` API. Today it's compiled out of the default build and the API has exactly **one** method. This spec grows it into a real interface.

> Grounded in the current tree (file:line cited inline). Sections marked **[today]** describe what already exists; **[proposed]** is the design. Like [BACKEND_INTERFACE.md](BACKEND_INTERFACE.md), track the cited files — they're the source of truth.

---

## 1. Why this approach

Warp already has **three** extension tiers. Two are production-ready. The third is the foundation we build on.

| Tier | Mechanism | Language | Loading | Status |
|---|---|---|---|---|
| **1. Config** | themes · workflows · launch_configs · `keybindings.yaml` | YAML/JSON | files under `~/.config/warp/…`, read at runtime | ✅ live |
| **2. MCP** (`crates/mcp`, rmcp 1.6) | AI tools / resources / prompts | *any* | `.mcp.json` → stdio/SSE child + JSON-RPC | ✅ live |
| **3. JS plugin host** (`app/src/plugin/`) | in-app behavior | JavaScript (QuickJS) | `~/.warp/plugins/*/main.js` (+ optional `plugin.json`) → subprocess | ✅ **enabled** (M0–M3 + M4 manifest/capabilities/AI tools: `warp.log`, `warp.commands`, `warp.terminal`, `warp.ui`, `warp.keymap`, `warp.ai`, `warp.plugin`) |
| 2.5 gRPC agent bridge (oh-my-warp) | custom agent backends | any | `agent_backends.toml` ([BACKEND_INTERFACE.md](BACKEND_INTERFACE.md)) | overlay |

**What you can do today:** add config, and add AI tools via MCP. **What you cannot do:** add a command, react to a command finishing, or draw anything. That is the entire gap, and tier 3 is purpose-built to close it.

**Why JS and not WASM/native/Lua:**

| Option | Authoring friction | Isolation | Ecosystem | Fit |
|---|---|---|---|---|
| **JS/TS (QuickJS)** | lowest | ✅ subprocess + per-plugin context | huge | **upstream already chose it** |
| WASM | high (per-language toolchain) | ✅✅ | growing | `host/wasm/` stub exists; natural *future* runtime |
| native dylib (`libloading`) | medium | ❌ UB/crash takes down app | n/a | wrong for untrusted code |
| Lua/Rhai | low | ✅ | small | a second engine for no gain |
| MCP (any lang) | low | ✅ subprocess | standard | already the answer for **AI tools** |

Net: **JS/TS for behavior plugins, MCP for AI tools, YAML for static contributions.** Authors write TypeScript and ship JavaScript. WASM stays an option because the host already abstracts the runtime (`host/native/` vs `host/wasm/`).

---

## 2. What exists today **[today]**

### 2.1 Process & loading model

The host is a **second instance of the warp binary** launched with `--plugin-host` (`app/src/lib.rs:640`, CLI variant `WorkerCommand::PluginHost` in `crates/warp_cli/src/lib.rs`). The parent passes a socket address via `WARP_PLUGIN_HOST_ADDRESS`. Entry point: `run()` at `app/src/plugin/host/native/mod.rs:33`.

- **Discovery:** scans `~/.warp/plugins/`, keeping directories that contain `main.js` (`app/src/plugin/host/native/plugin_ref.rs`, `mod.rs:97-126`).
- **Loading:** reads `main.js` source and compiles it in QuickJS — **no `dlopen`, no `unsafe`, no recompile** (`plugin_ref.rs:49`).
- **Isolation:** one QuickJS context **per plugin, on its own thread** (`runners.rs`, `runner.rs`). A plugin crash kills one thread; the UI process is untouched (`PluginHost::drop` kills the child, `app/src/plugin/app/mod.rs:117`).

### 2.2 Plugin entry point

Each plugin exports `activate(warp)` (`app/src/plugin/host/native/runner.rs:68`):

```js
// ~/.warp/plugins/my-plugin/main.js  — today
function activate(warp) {
  console.log("hello");                       // console.log/err → host logger
  warp.completions.registerCommandSignature(/* … */); // the ONLY API today
}
```

The `warp` object is built in **one function** — this is the seam we extend (`app/src/plugin/host/native/js_api/mod.rs:17`):

```rust
pub fn warp(plugin: PluginHandle, ctx: Ctx<'_>) -> rquickjs::Result<Object<'_>> {
    let api = Object::new(ctx)?;
    #[cfg(feature = "completions_v2")]
    api.set("completions", completions(plugin, ctx)?)?;   // ← the only namespace
    Ok(api)
}
```

### 2.3 The IPC bridge (both directions, already generic)

App ↔ host talk over a Unix domain socket (`interprocess` crate, `crates/ipc/src/native.rs`) with **bincode** length-prefixed framing (`crates/ipc/src/protocol.rs`). The contract is a typed-service RPC whose trait docs explicitly invite adding more services (`crates/ipc/src/service.rs:18-38`):

```rust
pub trait Service: Send + Sync + 'static { type Request: Message; type Response: Message; }
pub trait ServiceImpl { type Service: Service; async fn handle_request(&self, req: …) -> …; }
pub trait ServiceCaller<S: Service> { async fn call(&self, req: S::Request) -> Result<S::Response, …>; }
```

Existing services (the templates for everything below):

| Service | Direction | Purpose | File |
|---|---|---|---|
| `PluginHostBootstrapService` | host → app | handshake (host's server addr) | `service/plugin_host_bootstrap.rs` |
| `LogService` | host → app | relay logs | `service/logging.rs` |
| `CallJsFunctionService` | **app → host** | invoke a registered JS fn by id | `service/call_js_function.rs` |
| `RegisterCommandSignatureService` | **host → app** | plugin registers data | `service/completions.rs` |

### 2.4 The JS↔Rust value bridge

`crates/warp_js` wraps QuickJS (`rquickjs`) and provides a **type-safe callback bridge**: a JS function registered from a plugin becomes a `TypedJsFunctionRef<I, O>` with a `JsFunctionId` (UUID); values cross as `SerializedJsValue` (bincode) (`crates/warp_js/src/js_function/`). The app calls back into plugin JS via `CallJsFunctionService`.

**This is the load-bearing fact for the whole design:** plugin→app *registration* (template: completions) and app→plugin *callbacks* (template: `CallJsFunction` + `JsFunctionRegistry`) both already work. Commands and event hooks are the same two patterns with new payloads.

### 2.5 Status in the build

The default build ships `classic_completions` / `force_classic_completions`, **not** `plugin_host` (`app/Cargo.toml`, `default = […]`). So the host never spawns today. `completions_v2 = ["plugin_host", "warp_completer/v2", "command-signatures-v2"]` is the only thing that pulls it in. **First implementation step is simply enabling the host.**

---

## 3. Goals & principles

1. **Mergeable above all.** Every code change is an additive patch (the [golden rule](CLAUDE.md)); the API is assembled in one extensible function and the IPC layer is "add another service." `git diff $(git merge-base oh-my-warp master) oh-my-warp -- app/ crates/` must stay empty outside the patch series.
2. **Easy for authors.** Write TypeScript, ship `main.js` + a `plugin.json`. Trivial plugins need *zero* imperative code (declarative `contributes`).
3. **Safe by construction.** Subprocess + per-plugin context (already true) + a **capability/permission model** (new). Untrusted code gets nothing it didn't declare.
4. **Versioned.** Plugins pin an API version (`engines.warp`); the `warp.*` surface evolves additively so plugins survive `./omw sync`.
5. **Don't duplicate tiers 1 & 2.** AI tools → MCP. Static stuff → config (optionally *shipped by* a plugin via `contributes`).

---

## 4. Plugin package format **[proposed]**

A plugin is a directory under `~/.warp/plugins/<id>/`:

```
my-plugin/
  plugin.json     # manifest (new; bare main.js still accepted for back-compat)
  main.js         # compiled entry (exports activate / deactivate)
  README.md
```

### 4.1 Manifest (`plugin.json`)

VS Code-style, intentionally familiar:

```jsonc
{
  "id": "com.example.greet",        // reverse-DNS, unique; dir name must match
  "name": "Greeter",
  "version": "1.2.0",               // semver of the plugin
  "engines": { "warp": "^1.0" },    // REQUIRED — warp.* API version it targets
  "main": "main.js",
  "description": "Says hi and warns on failed commands.",
  "author": "you@example.com",

  "permissions": ["ui", "terminal:events"],   // capability grants (see §7)

  "activationEvents": ["onStartup"],          // when to load (see §8)

  "contributes": {                             // declarative — no code needed (see §6)
    "commands":   [{ "id": "greet.hello", "title": "Greet: Say Hello" }],
    "keybindings":[{ "command": "greet.hello", "key": "ctrl-b g" }],
    "themes":     [{ "name": "Greet Dark", "path": "themes/greet-dark.yaml" }],
    "workflows":  ["workflows/deploy.yaml"]
  }
}
```

- **`engines.warp`** is mandatory and enforced (§9). A plugin with no satisfiable range is skipped with a logged reason and shown as incompatible in Settings.
- **`contributes`** is parsed **without executing plugin code**, so the app can list a plugin's commands/themes/keybindings even before (or without) activation.
- A directory with only `main.js` and no `plugin.json` is still loaded (back-compat with §2.1), assumed `engines.warp = "*"`, no permissions, `activationEvents:["onStartup"]`.

---

## 5. The `warp.*` API surface **[proposed]**

TypeScript declarations (we ship `@warp/plugin-api` `.d.ts` for authors). Each namespace maps to a real seam; the **Phase** column ties to the roadmap (§10).

```typescript
declare global {
  function activate(warp: Warp): void | Promise<void>;
  function deactivate?(): void | Promise<void>;
}

interface Warp {
  readonly version: string;          // warp.* API version (semver)
  readonly plugin: { id: string; dir: string };

  commands: CommandsAPI;   // register palette commands (the core gap)
  keymap:   KeymapAPI;     // default keybindings / leader chords
  terminal: TerminalAPI;   // command/block lifecycle events
  ui:       UiAPI;         // toasts, status/tab pills, palette, markdown panel
  workflows:WorkflowsAPI;  // register workflows programmatically
  config:   ConfigAPI;     // read settings + plugin-scoped storage
  ai:       AiAPI;         // register agent tools (bridges to MCP/agent layer)
  fs:       FsAPI;         // capability-gated file access
  process:  ProcessAPI;    // capability-gated subprocess
  log:      (msg: string, level?: "info"|"warn"|"error") => void;
}

interface CommandsAPI {
  // name must match a contributed command id; cb runs in the plugin
  register(id: string, cb: (ctx: CommandContext) => void | Promise<void>): Disposable;
  execute(id: string, args?: unknown): Promise<void>;   // invoke any command
}
interface CommandContext { cwd: string; activePaneId?: string; selection?: string; }

interface KeymapAPI {
  // default binding; user keybindings.yaml always wins
  bind(commandId: string, keys: string): Disposable;    // "ctrl-b g", multi-key ok
}

interface TerminalAPI {
  onCommandStart(cb: (e: CommandEvent) => void): Disposable;
  onCommandFinished(cb: (e: CommandFinishedEvent) => void): Disposable;
  onBlockCreated(cb: (e: BlockEvent) => void): Disposable;
}
interface CommandFinishedEvent { command: string; exitCode: number; cwd: string; durationMs: number; }

interface UiAPI {
  toast(message: string, opts?: { kind?: "info"|"warn"|"error"; ms?: number }): void;
  setStatusItem(id: string, text: string | null): void; // tab/status-bar pill
  showPalette(items: PaletteItem[]): Promise<PaletteItem | undefined>;
  showMarkdown(title: string, markdown: string): Disposable; // simple panel
}

interface AiAPI {
  // register a tool the agent can call (in-process equivalent of an MCP tool)
  registerTool(tool: {
    name: string; description: string; schema: object;
    run: (args: unknown) => unknown | Promise<unknown>;
  }): Disposable;
}

interface ConfigAPI {
  get<T>(key: string): T | undefined;        // read Warp settings (allowlisted)
  storage: { get<T>(k: string): Promise<T|undefined>; set(k: string, v: unknown): Promise<void> };
}
type Disposable = { dispose(): void };
```

| Namespace | Backing seam (file:line) | Mechanism | Phase |
|---|---|---|---|
| `commands` | **gap:** `CustomAction` is a compile-time enum (`app/src/util/bindings.rs:32`); needs a runtime registry surfaced in the palette (`app/src/command_palette.rs`) | new `RegisterCommandService` (template: completions) + `CallJsFunction` to invoke | **1** |
| `ui.toast` / `setStatusItem` | tab-bar pill precedent from our leader work (`app/src/workspace/view.rs`) | new `UiService` (host→app) | **1** |
| `keymap.bind` | editable bindings in `crates/warpui_core/src/keymap.rs`; loader `app/src/keyboard.rs` | reuse editable-binding registration; user `keybindings.yaml` overrides | **2** |
| `terminal.*` | shell DCS hooks already parsed (`app/src/terminal/model/ansi/handler.rs`, `dcs_hooks.rs`) | app→plugin callbacks via `CallJsFunctionService` + `JsFunctionRegistry` | **2** |
| `workflows` / `config` | `app/src/workflows/workflow.rs`, user-config loaders | declarative `contributes` first; imperative later | **2** |
| `ai.registerTool` | MCP/agent context (`app/src/ai/agent/api/convert_to.rs:877`) + our gRPC bridge | inject plugin tools into `MCPContext` | **3** |
| `ui.showMarkdown` / `showPalette` | new lightweight surfaces (plugin is out-of-process → **no arbitrary widgets**) | message-driven panels | **3** |
| `fs` / `process` | host capabilities | permission-gated host calls | **3** |

**UI constraint (important):** the plugin runs in a *separate process* with no GPUI handle. So `warp.ui` is deliberately **message-driven and narrow** — toasts, pills, palette entries, and a markdown/webview panel — not "render any widget." Rich UI, if ever needed, is a later, separate effort (a declarative view protocol or a webview).

---

## 6. Declarative `contributes` vs imperative API **[proposed]**

Two ways to extend, mirroring VS Code:

- **Declarative** (`contributes` in the manifest): commands, keybindings, themes, workflows. Parsed without running code; the app shows them immediately and can lazy-activate the plugin only when one is invoked. Themes/workflows route straight into the existing tier-1 loaders.
- **Imperative** (`activate(warp)`): behavior — command handlers, event hooks, tools, UI.

A command typically appears in **both**: declared in `contributes.commands` (so it's listed/bindable) and backed by `warp.commands.register(id, cb)` (so it does something). Declaring without registering = a command that lazy-activates the plugin on first use.

---

## 7. Capability / permission model **[proposed]**

Today every plugin has the same (tiny) API. As the surface grows, gate the powerful parts. Manifest `permissions` are grants; the host only exposes a namespace's sensitive methods if granted, and the app prompts the user on install/first-use for sensitive ones.

| Permission | Unlocks | Sensitivity |
|---|---|---|
| `ui` | `warp.ui.*` | low |
| `commands` | register/execute commands | low |
| `terminal:events` | `warp.terminal.*` (sees command lines + output metadata) | **medium — content exposure** |
| `workflows` / `config` | register workflows / read settings | low/medium |
| `ai` | register agent tools | **medium — tool output reaches the model** |
| `fs:read` / `fs:write` | `warp.fs.*` (path-scoped where possible) | **high** |
| `process` | `warp.process.*` (spawn) | **high** |
| `network` | outbound fetch from the plugin | **high** |

Defaults: no `fs`, `process`, or `network`. Ungranted calls throw in JS and are logged. Permissions are shown in Settings → Plugins.

> **AI tools & prompt injection:** a plugin tool's output flows into the agent/model. Treat it as untrusted input to the model and surface tool provenance, consistent with how Warp already handles MCP tool results.

---

## 8. Lifecycle & activation **[proposed]**

- **Activation events** (manifest): `onStartup`, `onCommand:<id>` (lazy — load when the command is first invoked), `onLanguage:<id>`, `onTerminalEvent`. Lazy activation keeps idle plugins from costing anything.
- **`activate(warp)`** — register everything; may be async.
- **`deactivate()`** — optional cleanup; all `Disposable`s are auto-disposed on unload.
- **Reload:** changing files (or toggling in Settings) re-spawns the plugin's runner; the host already supports per-plugin threads, so hot-reload is re-read + re-activate. (Today: load-once at startup, `mod.rs:71`.)

---

## 9. API versioning & the upstream-merge story **[proposed]**

This is what keeps third-party plugins alive across `./omw sync`.

- The `warp.*` surface carries a **semver** exposed as `warp.version` and checked against each plugin's `engines.warp`. Incompatible plugins are skipped (logged + shown), never silently half-broken.
- **Additive-only within a major:** new namespaces/methods bump *minor*; removals/renames bump *major*. Because the API is one builder function (`js_api/mod.rs`) and one set of IPC services, additive growth is low-conflict against upstream.
- The version constant and a `CHANGELOG` for the API live in the overlay; bumping it is part of any patch that touches the surface.

---

## 10. Implementation plan **[proposed]**

Phased; each phase is independently shippable. **Code → patches** (edits to upstream files / new files a patch owns); **docs & examples → overlay** (committed straight to `oh-my-warp`, like this file). Mapping per the [golden rule](CLAUDE.md).

### Phase 0 — turn the host on  *(tiny, proves the pipe)* — ✅ **DONE** (patches 0014–0016)
- **Patch:** `omw_plugins` feature (= `plugin_host`) on by default. `app/Cargo.toml`.
- **Patch:** `warp()` (`js_api/mod.rs`) always exposes `warp.version` + `warp.log(message, level?)`.
- **Patch (bugfix):** `PLUGIN_HOST_FLAG` `--plugin_host` → `--plugin-host` (matches the clap `long_flag`; the underscore made the spawned host exit on arg-parse).
- **Overlay:** `examples/plugins/hello/`.
- **Verified:** `~/.warp/plugins/hello/main.js` logs through `LogService` on startup.

### Phase 1 (M1) — commands + toasts  *(the core gap → first real value)* — ✅ **DONE** (patches 0017–0018)
- **Patch:** runtime **command registry** (`app/src/plugin/commands.rs`, id → `JsFunctionId`) + `RegisterCommandService`; `warp.commands.register(id, title, cb)`.
- **Patch:** `PluginCommandDataSource` surfaces commands in the palette as synthetic `plugin:<id>` `CommandBinding`s (reusing `MatchedBinding`/`AcceptBinding` — no new `CommandPaletteItemAction` variant); the accept handler invokes the callback via `CallJsFunctionService` and shows the callback's returned string as an ephemeral toast (`ToastStack`).
- **Overlay:** example plugin registers `greet.hello` / `greet.time`.
- **Verified:** palette command → JS callback runs → toast.
- *Deferred to later phases:* `warp.commands.execute`, manifest parsing/`contributes` (→ M3), and the general anytime-callable `warp.ui.toast` (→ M3).

### Phase 2 (M2) — terminal events  *(make plugins react)* — ✅ **DONE** (patch 0019)
- **Patch:** `warp.terminal.onCommandStart / onCommandFinished` — plugins register JS callbacks via `RegisterEventHandlerService` into a per-event registry (`app/src/plugin/events.rs`); the terminal view fires them from the `AfterBlockStarted`/`AfterBlockCompleted` handlers (`terminal/view.rs`) with a `{command, exitCode, cwd, durationMs}` payload via `CallJsFunctionService`. A callback that returns a string shows it as a toast (lenient `OptionalToast`, shown at the ctx-rich fire site — no host→app hop).
- **Overlay:** example plugin logs every command and toasts on failed / slow commands.
- **Verified:** running a command in the terminal fires `onCommandFinished`; a failing command shows a toast.

### Phase 3 (M3) — general toast + keybindings  *(finish the imperative surface)* — ✅ **DONE** (patch 0020)
- **Patch:** general **`warp.ui.toast(message, kind?)`** and **`warp.keymap.bind(commandId, keys)`** — both need a foreground `AppContext`, so the IPC handler enqueues a `PluginAppRequest` onto a channel (`app/src/plugin/app_requests.rs`) that the `PluginHost` model drains via `spawn_stream_local` on the foreground executor, where it shows a toast (`ToastStack`) or registers an editable binding. Keybindings dispatch a new `WorkspaceAction::RunPluginCommand(id)`, handled by the `Workspace`, which runs the command via the shared `commands::run_plugin_command`.
- **Overlay:** example plugin adds a `warp.ui.toast` command and binds `greet.keybound` to the `ctrl-b h` leader chord.
- **Verified:** running the toast command shows a toast; pressing `ctrl-b h` runs the bound command.

### Phase 4 (M4) — manifest, declarative contributes, AI tools, richer UI, capabilities — 🚧 **in progress**
- ✅ **Patch 0023:** `plugin.json` manifest parsing + `engines.warp` enforcement (incompatible plugins skipped with a logged reason) + capability/permission model gating `commands`/`terminal:events`/`ui`/`keymap` (`host/native/manifest.rs`, gated in `js_api/mod.rs`) + `warp.plugin.{id,dir}` context + declarative `contributes.keybindings`. A bare `main.js` (no manifest) stays fully back-compatible (legacy = all namespaces, any API version).
- ✅ **Patch 0024:** `warp.ai.registerTool({name, description, schema, run})` — a plugin granted the `ai` permission exposes a tool the agent can call. Tools are injected into the model's MCP context as a synthetic server (`ai/agent/api.rs`) and dispatched **in-process** back to the plugin's `run` callback (`ai/blocklist/action_model/execute/call_mcp_tool.rs`) via `CallJsFunctionService`. Registry: `plugin/ai_tools.rs`; relay: `RegisterToolService`. JSON-string I/O (`run(argsJson) -> string`).
- ✅ **Patch 0025:** Settings → Plugins list — a read-only panel under Settings → Features listing installed plugins (name · id · version, declared permissions, `engines.warp`, description) by scanning `~/.warp/plugins` (`plugin/installed.rs`, rendered in `settings_view/features_page.rs`).
- ⏳ **Remaining:** declarative `contributes.commands` (palette listing + lazy activation) and `themes`/`workflows` (route into tier-1 loaders); `warp.ui.showMarkdown`/`showPalette`; high-sensitivity capabilities `fs`/`process`/`network` with first-use consent.

---

## 11. Worked example **[proposed]**

```
~/.warp/plugins/greet/
  plugin.json
  main.js
```

```jsonc
// plugin.json
{
  "id": "com.example.greet", "name": "Greeter", "version": "1.0.0",
  "engines": { "warp": "^1.0" }, "main": "main.js",
  "permissions": ["ui", "commands", "terminal:events"],
  "activationEvents": ["onStartup"],
  "contributes": {
    "commands":   [{ "id": "greet.hello", "title": "Greet: Say Hello" }],
    "keybindings":[{ "command": "greet.hello", "key": "ctrl-b g" }]
  }
}
```

```js
// main.js  (authored in TS, shipped as JS)
function activate(warp) {
  warp.commands.register("greet.hello", (ctx) => {
    warp.ui.toast(`Hi from ${ctx.cwd}`);
  });
  warp.terminal.onCommandFinished((e) => {
    if (e.exitCode !== 0) warp.ui.toast(`✗ ${e.command} (${e.exitCode})`, { kind: "error" });
  });
}
```

Result: a palette command **Greet: Say Hello**, bound to the `ctrl-b g` leader chord (our leader feature), plus a failure toast — all from a folder, no recompile.

---

## 12. Open questions

1. **Feature gating:** dedicated `omw_plugins` feature vs reusing `plugin_host` (which is entangled with `completions_v2`)? Leaning dedicated.
2. **Command registry placement:** new runtime registry alongside `CustomAction`, or a general "dynamic actions" layer the keymap also reads? Affects how cleanly `keybindings.yaml` binds plugin commands.
3. **TS types delivery:** ship `@warp/plugin-api` `.d.ts` in `examples/` vs a separate published package.
4. **Marketplace/distribution:** out of scope here (folder-drop + git for now); revisit after Phase 2.
5. **WASM host:** keep `host/wasm/` parity as we grow the API, or let it lag until there's demand for non-JS plugins?
