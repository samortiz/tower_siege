# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Tower Siege: a canvas tower-defense game with heroes and up to 8-player online co-op. It ships as a web page and as an Android app (Capacitor wraps the same page). The whole game (HTML, CSS, JS) is one file: `index.html`. There is no bundler, framework, linter or test suite.

## Commands

- `npm run serve`: builds `www/`, serves it on port 8080 (`PORT` overrides this) with `python3 -m http.server`, and opens a Cloudflare quick tunnel. A new public `https://*.trycloudflare.com` URL is printed each run. If something is already listening on the port, the script reuses it. This is the default way to run the game.
- `npm run build:web`: copies `index.html` and a local `peerjs.min.js` into `www/`. `www/` is generated and gitignored, so never edit files there.
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
- The script rebuilds `www/` on start. After editing `index.html`, restart it (or run `npm run build:web`) and reload the page.
- The tunnel only serves the page. Co-op connects players peer-to-peer through the public PeerJS server, using PeerJS's default STUN/TURN servers, so you don't need to forward any ports. Each player opens the public URL, and one of them hosts a room.
- Run it in the background when starting it from Claude Code, then report the printed public URL.

The Android build needs JDK 21 and the Android SDK. `android/gradle.properties` pins `org.gradle.java.home` to a system JDK path. Set `JAVA_HOME` and `ANDROID_HOME` before you run the apk scripts.

To check a change, run the game in a browser. Look at both desktop (mouse/keyboard) and touch layouts, and at both single-player and co-op if the change touches game state.

## Architecture (`index.html`)

The script is split into sections with `// ---------- Name ----------` banners. Grep for `^// ----------` to get a table of contents. The code is plain global functions and state, with `"use strict"` and no modules.

- **Data tables at the top.** These define buildings, heroes and enemies: `DEFS` and `ORDER` (buildings), `HEROES`, `HERO_TYPES` and `HERO_UPS` (heroes and their upgrades), `ETYPES` (enemies), `DIFFS` and `MAP_SIZES`. Balance constants sit next to the code that uses them, each with a comment giving its units. When you change balance numbers, also update the in-game help/tooltip text that quotes them.
- **The hero and player you are acting for.** Many functions act on the "current" hero through the globals `player`, `hero`, `heroUp` and `heroType`. `bindP(p)` points these at player `p`, and `bindLocal()` points them back at this device's player (`me`). Per-player code (commands, hero updates) has to call `bindP` first.
- **Commands.** Every action that changes the game goes through `cmd(c)` and then `applyCommand(pid, c)`, a switch on `c.t` (place, sell, up, work, hero, arrow, rally, ready, give, ping…). A client does not apply a command itself. It sends the command to the host, which validates it, so `applyCommand` must type-check every field it uses (the `has`, `num` and `tile` helpers do this). New actions must go through this path, or they will not work in co-op.
- **Simulation.** `step` runs `update(dt)` in fixed steps of at most 1/40 s, scaled by the speed setting (`SPEEDS`, `speedPaused`). Enemies path along a flow field: Dijkstra run outward from the core, with one field per movement mode in `MODES` (ground, climb, swim, dig). Buildings carry a path cost (`WALL_PATH_COST`), so enemies can choose to chew through them. Placing or removing a building, or editing terrain, must bump `gridVer` and recompute the flow fields.
- **Rendering.** `draw()` draws everything procedurally with canvas 2D calls: per-type sprite functions such as `drawWall`, `drawEnemy` and `drawHeroSprite`. The game uses no image assets.
- **Online co-op** (section "Online co-op"). The game uses PeerJS/WebRTC with the public PeerJS server, and the host is authoritative. The host runs the whole game and broadcasts snapshots `SNAP_RATE` times a second. `applySnap` applies them on clients. Effects travel as short tagged arrays (`netFx`: `'b'` burst, `'a'` announce, `'t'` text, `'x'` blast, `'p'` ping), and terrain edits travel in `netTer`. Clients send only their hero's position and their commands. Room IDs are `tower-siege-coop-<code>`. Lobby discovery works because each host also claims one of `LIST_SLOTS` well-known `tower-siege-list-N` IDs, and the browser probes each one. Messages are raw JSON strings, split into `~id|i|n|` frames once they pass `FRAME` characters. When you add state that clients need to see, add it to the snapshot and to `applySnap`, and check `net.role` (`null` for single-player, otherwise `'host'` or `'client'`). While the tab is hidden, a Worker ticker keeps online games stepping.
- **PeerJS loading.** In the Android app (`IS_APP`), the bundled `peerjs.min.js` loads first and the jsdelivr CDN is the fallback. On the web it is the other way round. The pinned version (1.5.4) appears in both `package.json` and `PEER_URL`, so keep them in sync.
- **Platforms.** `touchUI` switches to touch controls: the HTML pads and `#btnGrid`, an optional joystick, pinch zoom, and a portrait/landscape layout set in `fit()`. Settings are saved in `localStorage` under the key `towerSiegeSettings`.

## Android shell

`android/app/src/main/java/com/towersiege/game/MainActivity.java` adds things the web page can't do alone: keeping the screen on, immersive full screen that draws into the display cutout, and handling the Back button. Back calls `window.towerSiegeBack()`, which is defined in `index.html` and behaves like Esc. When it returns false (on the main menu), the app goes to the background instead of closing, so a hosted room survives. If you rename or change that function, update both sides. Run `npm run sync` after editing `index.html` so the app picks up the change.
