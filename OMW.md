# oh-my-warp (omw)

A curated, **additive** layer of patches and customizations on top of the
open-source [Warp](https://github.com/warpdotdev/warp) source tree — think
*oh-my-zsh, but for Warp*. This repo is a fork of `warpdotdev/warp` that stays
permanently mergeable with upstream: you get new Warp releases with a single
`./omw sync`, and your changes ride on top as patches.

> This file documents the overlay. Everything else in the repo is upstream Warp,
> kept pristine. Upstream's own docs live in `README.md`.

## How it works

- **`master`** = pristine upstream Warp **+** this overlay (`omw`, `patches/`,
  `OMW.md`). We never edit upstream files in place here, so pulling a new Warp
  release merges with no conflicts.
- **`patches/`** = your changes to *upstream* files, stored as `git format-patch`
  files and ordered by `patches/series`. They are applied **on demand** onto a
  throwaway branch **`omw/applied`** — that branch is what you build, run, and edit.
- **Purely new files** (things Warp doesn't ship) don't need a patch — commit
  them straight to `master`; they can't collide with upstream.

```
master  ──●──●────────────●  (upstream + overlay; upstream files untouched)
           \              │  ./omw apply  (git am every patch)
            ●──●──●  omw/applied  (build / run / edit here)
                  │  ./omw save  (git format-patch → patches/)
                  ▼
            patches/0001-*.patch, 0002-*.patch, … + series
```

## The `omw` CLI

| Command | What it does |
|---|---|
| `./omw status` | Base revision, upstream drift, patch count, current branch |
| `./omw list`   | Patches in apply order |
| `./omw apply`  | Rebuild `omw/applied` = `master` + every patch; switch to it |
| `./omw save`   | Capture `omw/applied` commits back into `patches/` + `series` |
| `./omw sync`   | Fetch upstream, merge into `master`, re-apply patches onto it |
| `./omw help`   | Full help |

Tip: `ln -s "$PWD/omw" ~/.local/bin/omw` (or add the repo to `PATH`) to run it
from anywhere.

## Making a patch

```sh
./omw apply                       # land on omw/applied with all patches applied
#   ...edit upstream files...
git commit -am "short subject"    # one commit == one patch; subject → filename
./omw save                        # writes patches/NNNN-short-subject.patch, back on master
git push                          # publish the overlay to your fork (origin)
```

To change an existing patch: `./omw apply`, edit, commit (or amend the relevant
commit on `omw/applied`), then `./omw save`.

## Pulling upstream

```sh
./omw sync     # git fetch upstream && merge into master && ./omw apply
```

Because the overlay is additive, the merge into `master` is clean. If a patch no
longer applies after upstream moved, `omw apply` stops on that patch with a
standard `git am` conflict — resolve it, `git am --continue`, then `./omw save`
to refresh the stored patch.

## Remotes

- `origin`   → your fork (`zach-source/warp`) — push here.
- `upstream` → `warpdotdev/warp` — fetch only (push is disabled).

## Licensing

Upstream Warp is dual-licensed **AGPL-3.0 / MIT** (see `LICENSE-AGPL`,
`LICENSE-MIT`). This fork is a derivative work: if you distribute a modified Warp
binary built from these patches under the AGPL, you must make the corresponding
source available. Publishing this fork (patches + source) satisfies that. The
`omw` tooling in this overlay is yours to license as you like.
