# app-hub

A root launcher for any number of independent sub-apps. Each sub-app lives
under `apps/<folder>/` and declares itself with a `defaults.json`. The root
Express server discovers those, spawns each app as its own process on its own
port, health-checks it, and reverse-proxies it under a path on a single home
page — so you get one URL and one `npm start` for everything.

## Why spawn + proxy instead of mounting in-process

Sub-apps run as separate processes rather than being `require()`d into the
root server. That means:

- A sub-app can be any stack — Node/Express, a static site, a different
  language entirely — as long as it listens on `process.env.PORT` and serves
  a health-checkable route.
- Sub-apps don't share a dependency tree or Node version with the root or
  each other.
- Each `apps/<folder>` can be its own git repo (via submodule, or just a
  symlink into another checkout on disk) without entangling histories.

The tradeoff: more than one process/port to manage, and cross-app calls go
over HTTP rather than in-process function calls.

## Adding a sub-app

1. Create `apps/<your-app>/`.
2. Add a `defaults.json` there:

   ```json
   {
     "name": "Human-readable name",
     "slug": "your-app",
     "description": "One line, shown on the home page",
     "icon": "🔧",
     "start": "npm start",
     "port": 4002,
     "healthPath": "/",
     "mountPath": "/apps/your-app"
   }
   ```

   | field         | required | notes                                                              |
   | ------------- | -------- | ------------------------------------------------------------------- |
   | `name`        | yes      | shown on the home page                                              |
   | `slug`        | yes      | used to build the default `mountPath`                               |
   | `start`       | yes      | shell command run with `cwd` set to the app's folder                |
   | `port`        | yes      | app-hub sets `PORT=<port>` in the child's env before spawning       |
   | `description` | no       | shown on the home page                                              |
   | `icon`        | no       | emoji shown on the home page                                        |
   | `healthPath`  | no       | polled after spawn until it returns < 500 (defaults to `/`)         |
   | `mountPath`   | no       | defaults to `/apps/<slug>`                                          |

3. Make sure the app reads `process.env.PORT` to decide what to listen on
   (see `apps/example-app` for a minimal Express example).
4. `npm install` at the repo root — the `postinstall` script installs each
   sub-app's own dependencies too.

Sub-apps don't need to know they're being proxied: app-hub strips the
`mountPath` prefix before forwarding, so routes inside the app are written
as if it were running standalone at `/`.

## Running

```sh
npm install
npm start
```

Then open http://localhost:3000. Each app is also reachable directly on its
own `port` for local debugging.

## Layout

```
app-hub/
  server.js              root Express server: discovery, spawn, proxy, health
  lib/
    apps.js              scans apps/*/defaults.json
    process-manager.js   spawns children, polls health, tracks status
  public/index.html       home page (polls /api/apps for live status)
  scripts/install-apps.js installs each sub-app's dependencies on postinstall
  apps/
    example-app/          reference implementation
```
