// oh-my-warp — Agent Browser plugin.
//
// Exposes vercel-labs/agent-browser (https://github.com/vercel-labs/agent-browser)
// to the Warp AI agent as in-process tools (warp.ai.registerTool). The agent can
// then drive a real browser: open pages, read the accessibility tree, click, type,
// and screenshot.
//
// agent-browser is a native Rust CLI that speaks the Chrome DevTools Protocol. The
// tools below shell out to it via `warp.process.exec` and pass `--cdp <port>` so it
// attaches to the SAME Chrome the oh-my-warp browser pane is screencasting — the
// agent's actions appear live in the pane you're watching. The pane's Rust side
// publishes its CDP port to `~/.warp/oh-my-warp/browser-active.json`; this plugin
// reads it via `warp.fs.readFile` (capability "fs:read") and prepends `--cdp` to
// every call.
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
// Capabilities (manifest `permissions`): ai, process, ui, commands, fs:read.

export function activate(warp) {
  const INSTALL_HINT =
    "agent-browser CLI not found. Install it with `brew install agent-browser` " +
    "(or `npm i -g agent-browser`, or `cargo install agent-browser`), then run " +
    "`agent-browser install` once to download Chrome.";

  // Resolve agent-browser to an ABSOLUTE path. The app is launched from
  // Finder/launchd with a minimal PATH that usually omits nix / homebrew / cargo
  // bin dirs, so a bare "agent-browser" often fails with ENOENT even when it's on
  // the user's interactive PATH. Probe common install locations, then fall back to
  // a login shell (which sources the user's profile). Resolved once and cached;
  // `null` means not found.
  let RESOLVED_BIN; // undefined = unresolved, null = missing, string = abs path
  function resolveBin() {
    if (RESOLVED_BIN !== undefined) return RESOLVED_BIN;
    const works = (p) => {
      try {
        return warp.process.exec(p, ["--version"]).code === 0;
      } catch (_) {
        return false;
      }
    };
    const home = (warp.plugin.dir || "").split("/.warp/")[0];
    const candidates = [
      "agent-browser", // already on PATH (if the app inherited a full one)
      home && `${home}/.nix-profile/bin/agent-browser`,
      "/run/current-system/sw/bin/agent-browser", // nix-darwin system profile
      "/opt/homebrew/bin/agent-browser",
      "/usr/local/bin/agent-browser",
      home && `${home}/.cargo/bin/agent-browser`,
    ].filter(Boolean);
    for (const p of candidates) {
      if (works(p)) {
        RESOLVED_BIN = p;
        return RESOLVED_BIN;
      }
    }
    // Last resort: ask a login shell to resolve it from the user's profile PATH.
    for (const sh of ["/bin/zsh", "/bin/bash"]) {
      try {
        const { stdout, code } = warp.process.exec(sh, [
          "-lc",
          "command -v agent-browser",
        ]);
        const line = (stdout || "")
          .split("\n")
          .map((s) => s.trim())
          .find((s) => s.startsWith("/") && s.endsWith("/agent-browser"));
        if (code === 0 && line && works(line)) {
          RESOLVED_BIN = line;
          return RESOLVED_BIN;
        }
      } catch (_) {
        /* try the next shell */
      }
    }
    RESOLVED_BIN = null;
    return RESOLVED_BIN;
  }

  function cliAvailable() {
    return resolveBin() != null;
  }

  // === CDP endpoint of the active oh-my-warp browser pane ====================
  // The pane (Rust `BrowserSession`) publishes its Chrome CDP port to this file
  // once Chrome is reachable. agent-browser attaches via `--cdp <port>`, so the
  // agent and the user share the visible pane.
  const ENDPOINT_FILE = (() => {
    const home = (warp.plugin.dir || "").split("/.warp/")[0];
    return home ? `${home}/.warp/oh-my-warp/browser-active.json` : null;
  })();

  function readEndpoint() {
    if (!ENDPOINT_FILE) return null;
    try {
      const ep = JSON.parse(warp.fs.readFile(ENDPOINT_FILE));
      if (typeof ep.port === "number" && ep.port > 0) return ep;
    } catch (_) {
      /* file absent or unparseable -> no pane currently open */
    }
    return null;
  }

  function cdpFlags() {
    const ep = readEndpoint();
    return ep ? ["--cdp", String(ep.port)] : null;
  }

  // Block the (sync) tool callback for `ms` milliseconds via /bin/sleep. rquickjs
  // doesn't dispatch our callbacks asynchronously, and we need to wait for Chrome
  // after `openWebTab` (the pane spawns Chrome on a background thread).
  function sleepMs(ms) {
    try {
      warp.process.exec("/bin/sleep", [String(Math.max(0, ms) / 1000)]);
    } catch (_) {
      /* nothing actionable */
    }
  }

  function waitForEndpoint(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ep = readEndpoint();
      if (ep) return ep;
      sleepMs(200);
    }
    return null;
  }

  // Run an agent-browser subcommand against the active pane's Chrome. Returns the
  // CLI's stdout (usually JSON) on success, or a JSON error envelope the agent can
  // read. Errors if no pane is open — callers should funnel through `browser_open`.
  function ab(args) {
    const bin = resolveBin();
    if (!bin) return JSON.stringify({ ok: false, error: INSTALL_HINT });
    const cdp = cdpFlags();
    if (!cdp) {
      return JSON.stringify({
        ok: false,
        error:
          "no oh-my-warp browser pane is open; call browser_open({url}) first " +
          "(it opens a pane the agent then drives via CDP).",
      });
    }
    let res;
    try {
      res = warp.process.exec(bin, [...cdp, ...args]);
    } catch (e) {
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

  // Registers one AI tool. `build(args)` returns the agent-browser argv (after
  // the `--cdp <port>` flag that `ab` prepends), or null if a required argument
  // is missing.
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

  // --- User-facing commands (Cmd-P) ---------------------------------------
  // Registered before the AI tools so the "Check CLI" command always appears,
  // even if a tool registration ever fails.
  warp.commands.register(
    "agentBrowser.check",
    "Agent Browser: Check CLI",
    () => {
      if (!cliAvailable()) {
        warp.ui.toast("agent-browser CLI not installed", "error");
        return INSTALL_HINT;
      }
      let ver = "(unknown)";
      try {
        ver = warp.process.exec(resolveBin(), ["--version"]).stdout.trim();
      } catch (_) {
        /* ignore */
      }
      const ep = readEndpoint();
      const pane = ep
        ? `pane attached on CDP :${ep.port}`
        : "no pane open — call browser_open(url) or press ctrl-b w";
      return `✅ ${ver} at ${resolveBin()} · ${pane}`;
    },
  );
  warp.commands.register(
    "agentBrowser.docs",
    "Agent Browser: Tools & Usage",
    () => {
      warp.ui.showMarkdown(
        "Agent Browser",
        "# Agent Browser tools\n\n" +
          "The AI agent drives the **oh-my-warp browser pane you see** — every tool " +
          "attaches to the pane's Chrome via `--cdp <port>`, so the agent's actions " +
          "appear live in the pane.\n\n" +
          "- **browser_open** `{url}` — open a pane (or navigate the existing one)\n" +
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

  // --- Navigation ---------------------------------------------------------
  // browser_open is special: if no pane is open yet, it opens one via the bridge
  // (`warp.ui.openWebTab`) and waits for the pane to publish its CDP endpoint. If
  // a pane is already open, it navigates the existing pane via `--cdp open`.
  warp.ai.registerTool({
    name: "browser_open",
    description:
      "Open a URL in the oh-my-warp browser pane (opens a new pane if none is open; " +
      "otherwise navigates the existing pane). Subsequent browser_* calls drive THIS " +
      "pane via CDP, so you and the user share the visible browser.",
    schema: JSON.stringify({
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "URL or host to open, e.g. https://example.com",
        },
      },
      required: ["url"],
    }),
    run: (argsJson) => {
      let args = {};
      try {
        args = JSON.parse(argsJson || "{}");
      } catch (_) {
        /* tolerate empty / malformed args */
      }
      if (!args.url)
        return JSON.stringify({
          ok: false,
          error: "browser_open: missing 'url'",
        });
      const url = String(args.url);
      warp.log(`agent-browser tool browser_open ${JSON.stringify(args)}`);
      if (cdpFlags()) {
        // Pane already open — navigate it via CDP-attached `open`.
        return ab(["open", url, "--json"]);
      }
      // No pane — open one via the bridge and wait for it to publish its endpoint.
      warp.ui.openWebTab(url);
      const ep = waitForEndpoint(8000);
      if (!ep) {
        return JSON.stringify({
          ok: false,
          error:
            "opened a browser pane but it did not publish a CDP endpoint within 8s; " +
            "is the pane opening? (Cmd-P → 'Greet: Open Web Tab' to verify the bridge).",
        });
      }
      return JSON.stringify({
        ok: true,
        port: ep.port,
        message: `Opened pane navigated to ${url}; CDP attached on port ${ep.port}.`,
      });
    },
  });
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
