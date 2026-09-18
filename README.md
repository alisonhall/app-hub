# app-hub

A root launcher for any number of independent sub-apps. Each sub-app lives
under `apps/<folder>/` and declares itself with an `app-hub.config.json` (or,
if it has a `package.json` with a `start` script, no config file at all —
see [Adding a sub-app](#adding-a-sub-app)). The root Express server discovers
those, spawns each app as its own process on its own port, health-checks it,
and reverse-proxies it under a path on a single home page — so you get one
URL and one `npm start` for everything.

## Why spawn + proxy instead of mounting in-process

Sub-apps run as separate processes rather than being `require()`d into the
root server. That means:

- A sub-app can be any stack — Node/Express, a static site, a different
  language entirely — as long as it listens on `process.env.PORT` and serves
  a health-checkable route.
- Sub-apps don't share a dependency tree or Node version with the root or
  each other — a sub-app can pin its own Node version with a `.nvmrc` file
  in its folder (see below).
- Each `apps/<folder>` can be its own git repo (via submodule, or just a
  symlink into another checkout on disk) without entangling histories.

The tradeoff: more than one process/port to manage, and cross-app calls go
over HTTP rather than in-process function calls.

## Adding a sub-app

1. Create `apps/<your-app>/` (or, for an app that lives outside this repo,
   add its path to `apps.config.json` — see below).
2. Optionally add an `app-hub.config.json` there:

   ```json
   {
     "name": "Human-readable name",
     "slug": "your-app",
     "description": "One line, shown on the home page",
     "icon": "🔧",
     "start": "npm start",
     "healthPath": "/",
     "mountPath": "/apps/your-app",
     "requiredCommands": ["gh", "jq"],
     "actions": [
       { "label": "Run", "path": "/run", "method": "POST" }
     ]
   }
   ```

   `app-hub.config.json` itself is optional if the app has a `package.json`:
   any field it doesn't set falls back to `package.json` — `name` and
   `description` from their same-named fields, and `start` becomes
   `npm start` if `package.json` has a `scripts.start`. `slug` still falls
   back to the folder name. This is read-only discovery — nothing in
   `package.json` gets executed until the app is actually started, and an
   app only becomes reachable/startable once `start` resolves from one of
   the two files. If `app-hub.config.json` exists but leaves `start` unset
   *and* there's no `package.json` fallback, that's treated as a config
   mistake and app-hub fails to start with a clear error, rather than
   silently skipping the app.

   | field              | required | notes                                                                                     |
   | ------------------ | -------- | ------------------------------------------------------------------------------------------ |
   | `name`             | no       | shown on the home page; falls back to `package.json`'s `name`, then the folder name        |
   | `slug`             | no       | used to build the default `mountPath`; falls back to the folder name                       |
   | `start`            | no*      | shell command run with `cwd` set to the app's folder; falls back to `npm start` if `package.json` has a `scripts.start` (*required one way or the other for the app to be usable) |
   | `description`      | no       | shown on the home page; falls back to `package.json`'s `description`                       |
   | `icon`             | no       | emoji shown on the home page                                                               |
   | `port`             | no       | app-hub sets `PORT=<port>` in the child's env before spawning; if omitted, app-hub picks a free port for you at startup (check the home page or `/api/apps` to find it). Only declare one explicitly if you want a stable port for local debugging — and note two apps can't declare the same one, that fails fast at startup |
   | `healthPath`       | no       | polled after spawn until it returns < 500 (defaults to `/`)                                |
   | `mountPath`        | no       | defaults to `/apps/<slug>`                                                                 |
   | `requiredCommands` | no       | CLI binaries the app shells out to (e.g. `gh`, `jq`); checked before spawn, surfaced as an `error` status if any are missing from `PATH` |
   | `actions`          | no       | extra buttons shown on the home page once the app is `running`. Each is `{ "label", "path", "method" }` — app-hub wires the button to `POST <mountPath><path>`; the app itself implements what that route does |

3. Make sure the app reads `process.env.PORT` to decide what to listen on
   (see `apps/example-app` for a minimal Express example).
4. `npm install` at the repo root — the `postinstall` script installs each
   sub-app's own dependencies too.

`start` is run through the platform's native shell — `cmd.exe` on Windows,
a POSIX shell elsewhere — deliberately, not a POSIX shell like `bash` on
Windows too. That was tried and reverted: Git for Windows' `bash` re-execs
itself into the target process (its emulation of POSIX `exec()`), which
orphans the real process from the PID app-hub tracks, breaking `stopApp`'s
ability to kill it — the app would keep running, holding its port, after
being "stopped." Reliable start/stop matters more than shell-syntax
convenience.

Practically, this means POSIX syntax like `MYVAR=$PORT node index.js` in
`start` works on Mac/Linux but **not** on Windows (it's `cmd.exe` there,
which doesn't understand it). Avoid shell syntax in `start` entirely and
read `process.env.PORT` (or other env vars) directly in your app's code
instead — that works identically on every platform, no shell involved, and
it's already how app-hub passes `PORT` in regardless.

### Pinning a sub-app's Node version

Drop a `.nvmrc` (or `.node-version`) in the sub-app's folder (e.g.
`apps/your-app/.nvmrc`) with the version it needs:

```
20.11.1
```

If both files are present, `.nvmrc` wins. app-hub reads whichever is there
and runs that app's `start` command through
[fnm](https://github.com/Schniz/fnm) (`fnm exec --using=<version> -- <start>`)
instead of whatever Node started app-hub itself.

`fnm` isn't an npm package app-hub can just `require()` or list under
`dependencies` — see [Dependency checks](#dependency-checks) below for how
it (and everything else app-hub depends on) gets installed and verified.

The pinned Node version itself is installed automatically on first start
(`fnm install <version>`) if it isn't already.

Apps without a `.nvmrc`/`.node-version` are unaffected and just run under
the Node that started app-hub, as before.

Sub-apps don't need to know they're being proxied: app-hub strips the
`mountPath` prefix before forwarding, so routes inside the app are written
as if it were running standalone at `/`.

## Running

```sh
npm install
npm start
```

Then open http://localhost:3000. Each app is also reachable directly on its
own `port` for local debugging — check the home page, or `GET /api/apps`, to
see which port an app landed on (it's stable across an app-hub run, but can
change between runs unless the app declares an explicit `port`).

## Dependency checks

app-hub itself needs a few things beyond its own npm packages: each
sub-app's own npm dependencies, CLI tools sub-apps shell out to
(`requiredCommands`), and `fnm` if any sub-app pins a Node version. None of
that happens by magic — here's exactly when each check runs, and what (if
anything) you need to do about it.

| when                         | what runs                                | what it does                                                                                          | if something's wrong                                                        |
| ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `npm install` (`postinstall`) | `scripts/install-apps.js`                | runs `npm install` inside every `apps/<folder>` that has a `package.json`                              | fails loudly like any `npm install` failure — fix and re-run `npm install`  |
| `npm install` (`postinstall`) | `scripts/check-deps.js`                  | if any app needs `fnm`, installs it via `winget`/`brew`, or prints manual install steps if it can't    | follow the printed instructions, then re-run `npm install` (or `npm run check-deps`) |
| `npm start` (`prestart`)      | `scripts/check-deps.js` again            | re-checks `fnm` and every app's `requiredCommands`, in case `npm install` was skipped or is stale       | same as above — it just prints warnings, it doesn't block `npm start` from continuing |
| app-hub tries to start a sub-app | `process-manager.js`'s pre-spawn check | checks that app's `requiredCommands` (incl. `fnm` if it has a `.nvmrc`/`.node-version`) are on `PATH`   | that app's status becomes `error` with the missing command(s) named, pointing at `npm run check-deps` — other apps are unaffected |

You can also run `npm run check-deps` by hand at any time to re-check
everything without touching npm dependencies.

**What's never automatic:** if the root's own `npm install` was never run,
`npm start` will still fail (`Cannot find module 'express'`) — `prestart`
only checks the things above, it doesn't install npm packages. Likewise, a
CLI tool named in `requiredCommands` that has no known installer (anything
other than `fnm`, e.g. `gh`, `jq`) is only ever flagged, never installed —
you have to install those yourself.

## Layout

```
app-hub/
  server.js              root Express server: discovery, spawn, proxy, health
  lib/
    apps.js              scans apps/*/app-hub.config.json (falls back to package.json)
    process-manager.js   spawns children, polls health, tracks status
    ports.js             finds free ports for apps that don't declare one
    deps.js              shared CLI-availability check (isCommandAvailable)
  public/index.html       home page (polls /api/apps for live status)
  scripts/
    install-apps.js      installs each sub-app's dependencies on postinstall
    check-deps.js        ensures fnm is installed if needed, flags other
                          missing requiredCommands (also `npm run check-deps`)
  apps/
    example-app/          reference implementation
```
