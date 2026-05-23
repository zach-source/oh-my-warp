// oh-my-warp — Agent Browser plugin.
//
// Exposes vercel-labs/agent-browser (https://github.com/vercel-labs/agent-browser)
// to the Warp AI agent as in-process tools (warp.ai.registerTool). The agent can
// then drive a real browser: open pages, read the accessibility tree, click, type,
// and screenshot.
//
// agent-browser is a native Rust CLI that speaks the Chrome DevTools Protocol. The
// tools below shell out to it via `warp.process.exec` (capability "process") and
// return its `--json` output to the agent. The browser is agent-browser's own
// (headless) session — independent of oh-my-warp's visible browser pane.
//
// Install the CLI once (the plugin can't do this for you):
//     brew install agent-browser     # or: npm i -g agent-browser
//                                     # or: cargo install agent-browser
//     agent-browser install          # downloads Chrome for Testing on first run
//
// Recommended agent workflow:
//   1. browser_open({ url })            open a page
//   2. browser_snapshot({})             read interactive elements + their refs (@e1, @e2, …)
//   3. browser_click / browser_type     act on a ref from the snapshot
//   4. browser_get_text / snapshot      observe the result
//
// Capabilities (manifest `permissions`): ai, process, ui, commands.

export function activate(warp) {
  // A stable session name so multi-step tool calls share one browser (cookies,
  // history, the current tab). Each named session has its own agent-browser daemon.
  const SESSION = "omw-agent";
  const BIN = "agent-browser";

  const INSTALL_HINT =
    "agent-browser CLI not found. Install it with `brew install agent-browser` " +
    "(or `npm i -g agent-browser`, or `cargo install agent-browser`), then run " +
    "`agent-browser install` once to download Chrome.";

  // Run an agent-browser subcommand. Returns its stdout (usually JSON) on success,
  // or a JSON error envelope the agent can read. Never throws.
  function ab(args) {
    let res;
    try {
      res = warp.process.exec(BIN, ["--session", SESSION, ...args]);
    } catch (e) {
      // exec throws when the binary is missing (ENOENT) or can't be spawned.
      return JSON.stringify({
        ok: false,
        error: INSTALL_HINT,
        detail: String(e),
      });
    }
    const { stdout, stderr, code } = res;
    if (code !== 0) {
      return JSON.stringify({
        ok: false,
        code,
        error: (stderr || stdout || "agent-browser failed").trim(),
      });
    }
    const out = (stdout || "").trim();
    return out || JSON.stringify({ ok: true });
  }

  function cliAvailable() {
    try {
      return warp.process.exec(BIN, ["--version"]).code === 0;
    } catch (_) {
      return false;
    }
  }

  // Registers one AI tool. `build(args)` returns the agent-browser argv (after
  // `--session`), or null if a required argument is missing.
  function tool(name, description, properties, required, build) {
    warp.ai.registerTool({
      name,
      description,
      schema: JSON.stringify({
        type: "object",
        properties,
        required: required || [],
      }),
      run: (argsJson) => {
        let args = {};
        try {
          args = JSON.parse(argsJson || "{}");
        } catch (_) {
          /* tolerate empty / malformed args */
        }
        const argv = build(args);
        if (argv == null) {
          return JSON.stringify({
            ok: false,
            error: `${name}: missing required argument(s)`,
          });
        }
        warp.log(`agent-browser tool ${name} ${JSON.stringify(args)}`);
        return ab(argv);
      },
    });
  }

  // --- Navigation ---------------------------------------------------------
  tool(
    "browser_open",
    "Open a URL in the agent's web browser (starts a headless session if needed). " +
      "Call this first, then browser_snapshot to see the page. Accepts a full URL or a bare host.",
    {
      url: {
        type: "string",
        description: "URL or host to open, e.g. https://example.com",
      },
    },
    ["url"],
    (a) => (a.url ? ["open", String(a.url), "--json"] : null),
  );
  tool("browser_back", "Go back to the previous page.", {}, [], () => [
    "back",
    "--json",
  ]);
  tool("browser_forward", "Go forward to the next page.", {}, [], () => [
    "forward",
    "--json",
  ]);
  tool("browser_reload", "Reload the current page.", {}, [], () => [
    "reload",
    "--json",
  ]);

  // --- Observe ------------------------------------------------------------
  tool(
    "browser_snapshot",
    "Get the current page's accessibility tree with stable element refs (e.g. @e1, @e2). " +
      "Use those refs with browser_click / browser_type. Defaults to interactive elements only.",
    {
      interactiveOnly: {
        type: "boolean",
        description:
          "Only clickable/typable elements (default true). false = full tree.",
      },
    },
    [],
    (a) =>
      a.interactiveOnly === false
        ? ["snapshot", "--json"]
        : ["snapshot", "-i", "--json"],
  );
  tool(
    "browser_get_text",
    "Get the visible text of an element (by ref or CSS selector), or of the whole page if omitted.",
    {
      target: {
        type: "string",
        description: "Element ref (@e3) or CSS selector; omit for the page",
      },
    },
    [],
    (a) =>
      a.target
        ? ["get", "text", String(a.target), "--json"]
        : ["get", "text", "--json"],
  );
  tool("browser_get_url", "Get the current page URL.", {}, [], () => [
    "get",
    "url",
    "--json",
  ]);
  tool("browser_get_title", "Get the current page title.", {}, [], () => [
    "get",
    "title",
    "--json",
  ]);

  // --- Interact -----------------------------------------------------------
  tool(
    "browser_click",
    "Click an element by its snapshot ref (e.g. @e2) or a CSS selector.",
    {
      target: {
        type: "string",
        description: "Element ref (@e2) or CSS selector",
      },
    },
    ["target"],
    (a) => (a.target ? ["click", String(a.target), "--json"] : null),
  );
  tool(
    "browser_type",
    "Type text into an element (appends to existing value). Target is a ref or CSS selector.",
    {
      target: {
        type: "string",
        description: "Element ref (@e3) or CSS selector",
      },
      text: { type: "string", description: "Text to type" },
    },
    ["target", "text"],
    (a) =>
      a.target && a.text != null
        ? ["type", String(a.target), String(a.text), "--json"]
        : null,
  );
  tool(
    "browser_fill",
    "Clear an input and fill it with text. Target is a ref or CSS selector.",
    {
      target: {
        type: "string",
        description: "Element ref (@e3) or CSS selector",
      },
      text: { type: "string", description: "Text to fill" },
    },
    ["target", "text"],
    (a) =>
      a.target && a.text != null
        ? ["fill", String(a.target), String(a.text), "--json"]
        : null,
  );
  tool(
    "browser_press",
    "Press a keyboard key, e.g. Enter, Tab, Escape, ArrowDown.",
    { key: { type: "string", description: "Key name, e.g. Enter" } },
    ["key"],
    (a) => (a.key ? ["press", String(a.key), "--json"] : null),
  );

  // --- Wait & capture -----------------------------------------------------
  tool(
    "browser_wait_for",
    "Wait for text to appear on the page, or for a fixed number of milliseconds.",
    {
      text: { type: "string", description: "Text to wait for" },
      ms: { type: "number", description: "Milliseconds to wait" },
    },
    [],
    (a) => {
      if (a.text) return ["wait", "for", "text", String(a.text), "--json"];
      if (a.ms != null) return ["wait", "for", "time", String(a.ms), "--json"];
      return null;
    },
  );
  tool(
    "browser_screenshot",
    "Save a PNG screenshot of the current page and return its path (the agent can't view images, " +
      "but you/the user can open the file).",
    { path: { type: "string", description: "Output .png path (optional)" } },
    [],
    (a) =>
      a.path
        ? ["screenshot", String(a.path), "--json"]
        : ["screenshot", "--json"],
  );

  // --- User-facing commands (Cmd-P) ---------------------------------------
  warp.commands.register(
    "agentBrowser.check",
    "Agent Browser: Check CLI",
    () => {
      if (!cliAvailable()) {
        warp.ui.toast("agent-browser CLI not installed", "error");
        return INSTALL_HINT;
      }
      const ver = (() => {
        try {
          return warp.process.exec(BIN, ["--version"]).stdout.trim();
        } catch (_) {
          return "(unknown)";
        }
      })();
      return `✅ agent-browser ready: ${ver}`;
    },
  );

  warp.commands.register(
    "agentBrowser.docs",
    "Agent Browser: Tools & Usage",
    () => {
      warp.ui.showMarkdown(
        "Agent Browser",
        "# Agent Browser tools\n\n" +
          "The AI agent can drive a real browser via these tools:\n\n" +
          "- **browser_open** `{url}` — open a page\n" +
          "- **browser_snapshot** `{interactiveOnly?}` — accessibility tree with refs (@e1…)\n" +
          "- **browser_click / browser_type / browser_fill** `{target,…}` — act on a ref\n" +
          "- **browser_press** `{key}`, **browser_back/forward/reload**\n" +
          "- **browser_get_text / get_url / get_title**\n" +
          "- **browser_wait_for** `{text?,ms?}`, **browser_screenshot** `{path?}`\n\n" +
          "Backed by [`agent-browser`](https://github.com/vercel-labs/agent-browser) " +
          "(a Rust CDP CLI). Install: `brew install agent-browser` then `agent-browser install`.",
      );
    },
  );

  // Startup: log readiness and nudge if the CLI is missing (tools still register;
  // they return an install hint if invoked without the CLI).
  if (cliAvailable()) {
    warp.log(`Agent Browser plugin ready (warp.* API v${warp.version})`);
  } else {
    warp.log(
      "Agent Browser plugin: agent-browser CLI not found; tools will report install steps",
    );
    warp.ui.toast(
      "Agent Browser: install the agent-browser CLI to enable browser tools",
      "warn",
    );
  }
}
