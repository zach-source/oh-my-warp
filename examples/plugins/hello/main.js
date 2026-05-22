// oh-my-warp — sample plugin.
//
// The plugin host compiles this file as an ES module and calls the exported
// `activate(warp)` once, on startup
// (app/src/plugin/host/native/runner.rs::run).
//
// API used here:
//   • warp.version             — semver of the warp.* API surface
//   • warp.log(message, level)  — level is "info" (default) | "warn" | "error"
//   • warp.commands.register(id, title, callback)
//        Adds a command to the command palette (Cmd-P). The string the callback
//        returns (if any) is shown to the user as a toast.
//   • warp.terminal.onCommandStart(cb)     — cb({ command, cwd })
//   • warp.terminal.onCommandFinished(cb)   — cb({ command, exitCode, cwd, durationMs })
//   • warp.ui.toast(message, kind?)         — kind is "info" (default) | "warn" | "error"
//   • warp.keymap.bind(commandId, keys)     — bind a key sequence to a command
//   • warp.ai.registerTool({name, description, schema, run})  — expose a tool the AI agent can call
//   • warp.fs.readFile/readDir/writeFile    — capability-gated file access (fs:read / fs:write)
//   • warp.process.exec(cmd, args?)         — capability-gated subprocess (process)
//   • warp.network.fetch(url)               — capability-gated HTTP GET (network)
//   • warp.plugin.{id,dir}                  — this plugin's id and directory
//
// Capabilities (manifest `permissions`) and the `ctrl-b j` keybinding are declared in plugin.json.
//
// Log lines are relayed from the host to the app and land in Warp's normal log
// output (~/Library/Logs/warp-oss.log on macOS).

export function activate(warp) {
  warp.log(
    `hello from oh-my-warp! (warp.* API v${warp.version}, plugin ${warp.plugin.id})`,
  );

  // --- Command palette commands (M1) -------------------------------------
  warp.commands.register("greet.hello", "Greet: Say Hello", () => {
    warp.log("greet.hello command invoked");
    return "👋 Hello from the oh-my-warp plugin!";
  });

  warp.commands.register("greet.time", "Greet: Show Time", () => {
    return `Plugin says the time is ${new Date().toLocaleTimeString()}`;
  });

  // --- General toast via warp.ui.toast (M3) ------------------------------
  warp.commands.register(
    "greet.uitoast",
    "Greet: Toast (warp.ui.toast)",
    () => {
      warp.log("greet.uitoast invoked");
      warp.ui.toast("Hello via warp.ui.toast!", "warn");
    },
  );

  // --- Keybinding via warp.keymap.bind (M3) ------------------------------
  warp.commands.register("greet.keybound", "Greet: Keybound Hello", () => {
    warp.log("greet.keybound invoked");
    return "⌨️ ran via keybinding";
  });
  // Press the leader (ctrl-b) then "h" to run greet.keybound.
  warp.keymap.bind("greet.keybound", "ctrl-b h");

  // --- Terminal events (M2) ----------------------------------------------
  warp.terminal.onCommandStart((e) => {
    warp.log(`onCommandStart: ${e.command}`);
  });

  warp.terminal.onCommandFinished((e) => {
    warp.log(
      `onCommandFinished: ${e.command} (exit ${e.exitCode}, ${Math.round(e.durationMs)}ms)`,
    );
    if (e.exitCode !== 0) {
      return `✗ "${e.command}" exited ${e.exitCode}`;
    }
    if (e.durationMs >= 3000) {
      return `⏱ "${e.command}" took ${Math.round(e.durationMs / 1000)}s`;
    }
  });

  // --- AI agent tool via warp.ai.registerTool (M4) -----------------------
  // The agent can call this tool. `schema` is a JSON Schema *string*; `run` receives the model's
  // arguments as a JSON string and returns a string result. Requires the "ai" permission.
  warp.ai.registerTool({
    name: "greet_lookup",
    description:
      "Returns a friendly oh-my-warp greeting for a given name. Use when asked to greet someone.",
    schema: JSON.stringify({
      type: "object",
      properties: {
        name: { type: "string", description: "The name to greet" },
      },
      required: ["name"],
    }),
    run: (argsJson) => {
      const args = JSON.parse(argsJson || "{}");
      warp.log(`greet_lookup tool called for ${args.name}`);
      return `👋 Hello, ${args.name || "stranger"}! (greeting from the oh-my-warp plugin)`;
    },
  });

  // --- High-sensitivity capabilities via warp.process / warp.fs (M4) ------
  // Granted by the "process" and "fs:read" permissions in plugin.json. Without the grant the
  // namespace is absent and these calls would throw — that's the capability boundary.
  warp.commands.register(
    "greet.sysinfo",
    "Greet: System Info (warp.process + warp.fs)",
    () => {
      const { stdout, code } = warp.process.exec("uname", ["-sr"]);
      const files = warp.fs.readDir(warp.plugin.dir);
      warp.log(
        `greet.sysinfo: uname exited ${code}, plugin dir has ${files.length} entries`,
      );
      return `🖥️ ${stdout.trim()} · ${files.length} files in plugin dir`;
    },
  );
}
