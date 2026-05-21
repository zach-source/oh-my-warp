// oh-my-warp — sample plugin.
//
// The plugin host compiles this file as an ES module and calls the exported
// `activate(warp)` once, on startup
// (app/src/plugin/host/native/runner.rs::run).
//
// API used here:
//   • warp.version            — semver of the warp.* API surface
//   • warp.log(message, level) — level is "info" (default) | "warn" | "error"
//   • warp.commands.register(id, title, callback)
//        Adds a command to the command palette. When the user runs it, `callback`
//        executes here in the plugin host; the string it returns (if any) is
//        shown to the user as a toast.
//
// Log lines are relayed from the host process to the app and land in Warp's
// normal log output (~/Library/Logs/warp-oss.log on macOS).

export function activate(warp) {
  warp.log(`hello from oh-my-warp! (warp.* API v${warp.version})`);
  warp.log("plugins can also log at warn / error level", "warn");

  // Open the command palette (⌘P) and search "Greet" to run this.
  warp.commands.register("greet.hello", "Greet: Say Hello", () => {
    warp.log("greet.hello command invoked");
    return "👋 Hello from the oh-my-warp plugin!";
  });

  warp.commands.register("greet.time", "Greet: Show Time", () => {
    return `Plugin says the time is ${new Date().toLocaleTimeString()}`;
  });
}
