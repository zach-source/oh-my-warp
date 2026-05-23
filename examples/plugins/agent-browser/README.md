# Agent Browser plugin (oh-my-warp)

Exposes [`vercel-labs/agent-browser`](https://github.com/vercel-labs/agent-browser)
to the Warp AI agent as in-process tools (`warp.ai.registerTool`), so the agent can
drive a real web browser — navigate, read the accessibility tree, click, type, and
screenshot.

`agent-browser` is a native Rust CLI that speaks the Chrome DevTools Protocol. This
plugin shells out to it via `warp.process.exec` and returns its `--json` output to the
agent. The browser is agent-browser's own headless session, independent of oh-my-warp's
visible browser pane (open one with `ctrl-b w`, or `warp.ui.openWebTab(url)` from a plugin).

## Install the CLI (once)

```sh
brew install agent-browser        # or: npm i -g agent-browser
                                  # or: cargo install agent-browser
agent-browser install             # downloads Chrome for Testing on first run
```

Run **Agent Browser: Check CLI** from the command palette (`Cmd-P`) to confirm it's ready.

## Tools the agent gets

| Tool | Args | Purpose |
|------|------|---------|
| `browser_open` | `{url}` | Open a page (call first) |
| `browser_snapshot` | `{interactiveOnly?}` | Accessibility tree with refs (`@e1`, `@e2`, …) |
| `browser_click` | `{target}` | Click a ref or CSS selector |
| `browser_type` | `{target, text}` | Type into an element (appends) |
| `browser_fill` | `{target, text}` | Clear + fill an input |
| `browser_press` | `{key}` | Press a key (Enter, Tab, …) |
| `browser_get_text` | `{target?}` | Element/page text |
| `browser_get_url` / `browser_get_title` | — | Current URL / title |
| `browser_back` / `browser_forward` / `browser_reload` | — | Navigation |
| `browser_wait_for` | `{text?, ms?}` | Wait for text or a delay |
| `browser_screenshot` | `{path?}` | Save a PNG, returns the path |

The agent's intended loop: `browser_open` → `browser_snapshot` (to discover refs) →
`browser_click`/`browser_type` on a ref → observe with `browser_snapshot`/`browser_get_text`.

## Install the plugin

Copy this directory into your Warp plugins directory (the same place the `hello`
sample is loaded from) and restart Warp. See `examples/plugins/README.md`.
