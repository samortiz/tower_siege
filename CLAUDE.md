# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tower Siege: a canvas tower-defense game with heroes and up to 8-player online co-op. It ships as a web page and as an Android app (Capacitor wraps the same page), and online games run on a Node game server. The game is two files: `sim.js` (the simulation: data tables, game state and rules, with no DOM access) and `index.html` (HTML, CSS, rendering, input, menus and the online client). The server is `server/server.mjs`. There is no bundler, framework, linter or test suite.

## Commands

- `npm run serve`: builds `www/`, starts the game server (`server/server.mjs`) on port 8080 (`PORT` overrides this), and opens a Cloudflare quick tunnel. A new public `https://*.trycloudflare.com` URL is printed each run. If a Tower Siege server is already listening on the port, the script reuses it (restart it to load code changes); if something else holds the port, the script stops. This is the default way to run the game.
- `npm run server`: builds `www/` and runs the game server without a tunnel (LAN only). `SERVER_NAME` sets the name players see (default: the host name).
- `npm run service -- install|restart|url|status|logs|uninstall` (`scripts/service.sh`): runs the game server and its tunnel as systemd user services (`tower-siege.service`, `tower-siege-tunnel.service`), so they start at boot and survive logout. `PORT` and `SERVER_NAME` are fixed at install time. `restart` reloads code changes and keeps the tunnel, so the public URL stays the same; `url` prints it. On this machine the service is installed on port 8080.
- `npm run build:web`: copies `index.html` and `sim.js` into `www/`. `www/` is generated and gitignored, so never edit files there.
- `npm run sync`: runs build:web, then `npx cap sync android`.
- `npm run apk`: runs sync, then builds the debug APK with `./gradlew assembleDebug` (output: `android/app/build/outputs/apk/debug/app-debug.apk`).
- `npm run install-apk`: runs apk, then `adb install -r`.

### Playing from outside the local network

Run `npm run serve`. It needs `cloudflared` on `PATH` or at `~/.local/bin/cloudflared`; no Cloudflare account is required. After it starts, the script prints two addresses:

- `LAN: http://<ip>:8080` works only for devices on the same network.
- `Public URL: https://<random>.trycloudflare.com` works from anywhere. Share this one with remote players.

Things to know:

- The public URL changes on every run. A fixed address needs a named Cloudflare tunnel on a domain you own.
- The URL works only while the script is running. Ctrl+C stops the tunnel, and also stops the web server if the script started it.
- The script rebuilds `www/` on start. After editing `index.html`, run `npm run build:web` and reload the page. After editing `sim.js` or the server, restart the script: each room runs the copy of `sim.js` loaded when the server started.
- The tunnel carries both the page and the game's WebSocket, so you don't need to forward any ports. Each player opens the public URL (or types it into the co-op screen), then creates or joins a game.
- Run it in the background when starting it from Claude Code, then report the printed public URL.

The Android build needs JDK 21 and the Android SDK. `android/gradle.properties` pins `org.gradle.java.home` to a system JDK path. Set `JAVA_HOME` and `ANDROID_HOME` before you run the apk scripts.

To check a change, run the game in a browser. Look at both desktop (mouse/keyboard) and touch layouts, and at both single-player and online co-op if the change touches game state.

## Architecture (`sim.js` + `index.html`)

Both scripts are split into sections with `// ---------- Name ----------` banners. Grep for `^// ----------` to get a table of contents. The code is plain global functions and state, with `"use strict"` and no modules. `sim.js` loads first (a plain `<script src>`), so both scripts share one global scope and the page can read and assign the simulation's variables.

- **What goes where.** Anything that changes game state belongs in `sim.js`, which must not touch `window`, `document`, the canvas, `localStorage` or `settings`, so that it also runs headless in Node. The page connects through hooks that `sim.js` declares and `index.html` assigns: `onTerrain` (redraw the terrain canvas), `onMapSize` (lay out the minimap) and `onLocalHero(p, dt)` (move the hero from the keyboard or joystick). Flags: `online` (networked game), `fxOut` (queue effects into `netFx` / `netTer` for remote players) and `headless` (skip purely visual particles and texts). A game starts with `newGame({ difficulty, mapSize, roster })`.

- **Data tables at the top.** These define buildings, heroes and enemies: `DEFS` and `ORDER` (buildings), `HEROES`, `HERO_TYPES` and `HERO_UPS` (heroes and their upgrades), `ETYPES` (enemies), `DIFFS` and `MAP_SIZES`. Balance constants sit next to the code that uses them, each with a comment giving its units. When you change balance numbers, also update the in-game help/tooltip text that quotes them.
- **The hero and player you are acting for.** Many functions act on the "current" hero through the globals `player`, `hero`, `heroUp` and `heroType`. `bindP(p)` points these at player `p`, and `bindLocal()` points them back at this device's player (`me`). Per-player code (commands, hero updates) has to call `bindP` first.
- **Commands.** Every action that changes the game goes through `cmd(c)` and then `applyCommand(pid, c)`, a switch on `c.t` (place, sell, up, work, hero, arrow, rally, ready, give, ping…). In an online game the page does not apply a command itself. It sends the command to the server, which validates it, so `applyCommand` must type-check every field it uses (the `has`, `num` and `tile` helpers do this). New actions must go through this path, or they will not work in co-op.
- **Simulation.** `step` runs `update(dt)` in fixed steps of at most 1/40 s, scaled by the speed setting (`SPEEDS`, `speedPaused`). Enemies path along a flow field: Dijkstra run outward from the core, with one field per movement mode in `MODES` (ground, climb, swim, dig). Buildings carry a path cost (`WALL_PATH_COST`), so enemies can choose to chew through them. Placing or removing a building, or editing terrain, must bump `gridVer` and recompute the flow fields.
- **Rendering.** `draw()` draws everything procedurally with canvas 2D calls: per-type sprite functions such as `drawWall`, `drawEnemy` and `drawHeroSprite`. The game uses no image assets.
- **Game server** (`server/server.mjs`). One Node process serves `www/` over HTTP, answers `GET /info` (JSON identifying a Tower Siege server, with CORS open, for finding servers) and runs the games over a WebSocket at `/ws` (the `ws` package). It holds up to `MAX_ROOMS` (4) rooms of up to 8 players. The page and server must agree on `NET_VERSION` (in `sim.js`): bump it whenever the protocol or the snapshot format changes, so an older app is told to update instead of misreading snapshots. Each room runs its own copy of `sim.js` in a separate `vm` context (with `me = -1`, `headless`, `online` and `fxOut` set) and talks to it only through the small `api` object defined in `API`, passing strings. The protocol is listed at the top of the file. The player who creates a room is its leader (`creator`): they pick difficulty and map size in the lobby, start the game, and after game over bring everyone back to the lobby. If they leave, the longest-serving player takes over. Players can drop in to a running game (`joinPlayer`: a newcomer gets `joinPurse()`, the starting 50 gold plus the team's average upgrade spend) and drop out (`leavePlayer`: their wallet goes to the treasury; coming back under the same name restores their upgrades and takes the wallet back). Each player gets a private reconnect token (`seats`), and the page keeps it per room in `settings.seats`. The token is the only way back into a seat: if the connection drops, the page retries for `REJOIN_TIME` (30 s) and takes the seat back, even if the server hasn't noticed the old socket is dead; rejoining later from the same device restores the hero (`departed` is keyed by player id, so a matching name alone gets nothing). A room can have a password, set by its creator. Limits: `MAX_CONNS` connections, `MAX_PER_IP` per address (through the tunnel, the `CF-Connecting-IP` header), and `MSG_RATE` messages a second per connection. Messages use permessage-deflate. A room whose last player leaves closes, unless a game is in progress: then it pauses and closes after `EMPTY_TTL` (10 minutes). Online games have no pause or speed control.
- **Online client** (section "Online co-op" in `index.html`). The co-op screen takes a server address (an IP:port, a host name or a URL; `wsUrl` turns it into a `ws://` or `wss://` URL) and remembers the last five in `settings.servers`. A page loaded from a game server finds it through `/info` and connects by itself. In the app (or on a page opened from a LAN IP), `scanLan` asks every address on the local /24 for `/info` on port 8080 and on the ports of servers joined before; the app learns its own address from the native `Lan` plugin. The server broadcasts snapshots `SNAP_RATE` times a second (`makeSnap` in `sim.js`); `applySnap` applies them. Effects travel as short tagged arrays (`netFx`: `'b'` burst, `'a'` announce, `'t'` text, `'x'` blast, `'p'` ping), and terrain edits travel in `netTer`. Clients send only their hero's position and their commands. When you add state that clients need to see, add it to `makeSnap` and to `applySnap`, and check `net.role` (`null` for single-player or browsing a server, `'client'` in a room). While the tab is hidden, a Worker ticker keeps online games stepping.
- **Platforms.** `touchUI` switches to touch controls: the HTML pads and `#btnGrid`, an optional joystick, pinch zoom, and a portrait/landscape layout set in `fit()`. Settings are saved in `localStorage` under the key `towerSiegeSettings`.

## Android shell

`android/app/src/main/java/com/towersiege/game/MainActivity.java` adds things the web page can't do alone: keeping the screen on, immersive full screen that draws into the display cutout, and handling the Back button. Back calls `window.towerSiegeBack()`, which is defined in `index.html` and behaves like Esc. When it returns false (on the main menu), the app goes to the background instead of closing. If you rename or change that function, update both sides. Run `npm run sync` after editing `index.html` so the app picks up the change.

`LanPlugin.java` is a local Capacitor plugin (registered in `MainActivity`) that returns the device's Wi-Fi IPv4 address for the LAN scan (`Capacitor.Plugins.Lan.localAddress()`). The app's page runs at `https://localhost`, so reaching LAN servers over plain `http://` and `ws://` needs both `android.allowMixedContent` in `capacitor.config.json` and `android:usesCleartextTraffic="true"` in the manifest.

To test inside the app, debug builds expose the WebView to Chrome's DevTools protocol: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`, then `curl localhost:9333/json` for the page's WebSocket URL. The device must be awake and unlocked: on the lock screen Android pauses the WebView's timers, and in Doze it cuts the app off from the network.
