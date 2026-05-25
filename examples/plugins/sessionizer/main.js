// oh-my-warp — Sessionizer plugin.
//
// A tmux-sessionizer-style project switcher. At startup it scans your common dev
// roots (~/repos, ~/src, ~/projects, …) for immediate subdirectories (your
// projects), registers an "open" command for each, and exposes a picker:
//
//   • Command palette (Cmd-P): "Sessionizer: Switch Project"
//   • Leader chord:            ctrl-b f   (f = find project)
//
// Picking a project opens it in a new tab with a terminal rooted there, via the
// warp.ui.openProject(path) API (which dispatches WorkspaceAction::OpenRepository).
//
// Customizing roots: edit ROOT_NAMES below. (Projects are discovered once at
// startup — restart Warp after adding a new repo. See README.md.)
//
// Capabilities (manifest `permissions`): commands, process, ui.

export function activate(warp) {
  const FIND = "/usr/bin/find"; // BSD find on macOS; in the GUI PATH (/usr/bin).
  const MAX_PROJECTS = 300; // guardrail so a huge tree doesn't flood the palette.

  // $HOME, derived from the plugin dir (~/.warp/plugins/sessionizer).
  const home = (warp.plugin.dir || "").split("/.warp/")[0] || "";

  // Common dev roots, relative to $HOME. Only those that exist are scanned.
  const ROOT_NAMES = [
    "repos",
    "src",
    "projects",
    "work",
    "code",
    "dev",
    "Developer",
    "go/src",
  ];
  const roots = home ? ROOT_NAMES.map((r) => `${home}/${r}`) : [];

  // Discover projects = immediate subdirectories (depth 1) of each existing root.
  function discoverProjects() {
    const seen = new Set();
    const projects = [];
    for (const root of roots) {
      let stdout = "";
      try {
        const res = warp.process.exec(FIND, [
          root,
          "-mindepth",
          "1",
          "-maxdepth",
          "1",
          "-type",
          "d",
        ]);
        if (res.code !== 0) continue; // root probably doesn't exist
        stdout = res.stdout || "";
      } catch (_) {
        continue; // find missing / not permitted
      }
      for (const line of stdout.split("\n")) {
        const path = line.trim();
        if (!path || seen.has(path)) continue;
        seen.add(path);
        projects.push({ path, name: path.split("/").pop() || path });
      }
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects.slice(0, MAX_PROJECTS);
  }

  const projects = discoverProjects();

  // Register an open-command per project. showPalette items reference command ids
  // (not inline callbacks), so each project needs its own registered command; the
  // path is captured here at registration time.
  for (const { path, name } of projects) {
    warp.commands.register(
      `sessionizer.open:${path}`,
      `Project: ${name}`,
      () => {
        warp.ui.openProject(path);
      },
    );
  }

  // The picker.
  warp.commands.register(
    "sessionizer.switch",
    "Sessionizer: Switch Project",
    () => {
      if (projects.length === 0) {
        warp.ui.toast(
          `Sessionizer: no projects found under ${roots.join(", ") || "(no roots)"}`,
          "warn",
        );
        return;
      }
      warp.ui.showPalette(
        "Switch to project",
        projects.map((p) => ({
          label: p.name,
          command: `sessionizer.open:${p.path}`,
        })),
      );
    },
  );

  // tmux-sessionizer muscle memory: leader (ctrl-b) then "f" (find project).
  warp.keymap.bind("sessionizer.switch", "ctrl-b f");

  warp.log(
    `Sessionizer ready: ${projects.length} project(s) across ${roots.length} root(s)`,
  );
}
