// Tower Siege game server: serves the game page (www/) and runs the online games.
// Usage: node server/server.mjs   (PORT sets the port, default 8080; SERVER_NAME sets the name shown to players)
//
// Every room runs its own copy of sim.js in a separate vm context, so the rooms share nothing. The server is the
// only authority: browsers and the Android app connect over a WebSocket at /ws, send their hero's position and
// their commands, and draw the snapshots the server broadcasts SNAP_RATE times a second.
//
// Protocol (JSON text frames). Client → server:
//   { t: 'list' }                                 room list (answered with 'rooms')
//   { t: 'create', name, hero, pass, v }          open a new room and join it as its creator (pass: optional room password)
//   { t: 'join', room, name, hero, pass, token, v }  join a room (in its lobby, or a game already under way); token: the one this
//                                                 player was given before, to take their seat back (and get their hero back)
//   (v: the page's NET_VERSION; a page whose version differs from the server's is turned away with a message)
//   { t: 'hero', k }   { t: 'set', d, m }         lobby: pick a hero; the creator picks difficulty and map size
//   { t: 'start' }     { t: 'lobby' }             creator: start the game; after game over, bring everyone back to the lobby
//   { t: 'i', x, y, mv, ma, wk }   { t: 'c', c }  in a game: our hero's position, and a command (see applyCommand in sim.js)
//   { t: 'leave' }     { t: 'hb' }                leave the room; keep-alive
// Server → client: 'hello' (server info), 'rooms', 'lobby' (in the lobby: who is here, who leads, the settings, and this player's
// private reconnect token), 'room' (the same during a game), 'init' (a game starts or is joined), 's' (snapshot), 'err'.
//
// Limits against abuse: MAX_CONNS connections in all and MAX_PER_IP from one address (behind the Cloudflare tunnel, the address
// in its CF-Connecting-IP header), MSG_RATE messages a second per connection (a flood gets the connection closed), and an optional
// password per room. Messages are compressed (permessage-deflate), which shrinks the snapshots about 3×.
import http from 'node:http';
import { readFileSync, createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'www');
const PORT = +process.env.PORT || 8080;
const SERVER_NAME = (process.env.SERVER_NAME || os.hostname()).slice(0, 30);
const MAX_ROOMS = 4;
const STEP = 1 / 40;            // simulation step (s), the same as the page's single-player step
const SNAP_RATE = 15;           // snapshots per second while a game runs
const OVER_SNAP_RATE = 1;       // ...and after game over (the scoreboard barely changes)
const LOBBY_RATE = 1;           // lobby updates per second (they also keep the connection alive)
const EMPTY_TTL = 10 * 60;      // seconds an empty game is kept (paused) so its players can come back
const PING_EVERY = 5000;        // ms between WebSocket pings; a client that misses two is dropped
const MAX_MSG = 4000;           // characters: clients only ever send small messages
const MAX_CONNS = 64, MAX_PER_IP = 12;   // open connections: in all, and from one address
const MSG_RATE = 80, MSG_BURST = 160;    // messages per second a connection may send (a page sends about 30), and how many in a burst

const SIM = new vm.Script(readFileSync(path.join(ROOT, 'sim.js'), 'utf8'), { filename: 'sim.js' });
// The page and the server must speak the same protocol: NET_VERSION in sim.js
const NET_VERSION = (() => { const c = vm.createContext({ console, JSON, Math }); SIM.runInContext(c); return vm.runInContext('NET_VERSION', c); })();
const versionMsg = v => typeof v === 'number' && v > NET_VERSION
  ? 'This server runs an older version of Tower Siege than yours. Restart it with the latest code.'
  : 'This server runs a newer version of Tower Siege. Update the game (or the app) to join it.';
// Runs inside each room's context, after sim.js. Values cross into the server as strings and numbers only.
const API = new vm.Script(`
  me = -1; headless = true; online = true;
  globalThis.api = {
    start(s) { newGame(JSON.parse(s)); fxOut = true; },
    step(dt) { update(dt); },
    state() { return gameState; },
    snap() { return JSON.stringify(makeSnap(false)); },
    init(id) { return JSON.stringify(initMsg(id)); },
    cmd(pid, s) { applyCommand(pid, JSON.parse(s)); },
    input(pid, s) { remoteInput(pid, JSON.parse(s)); },
    join(s) { const e = JSON.parse(s); joinPlayer(e, departed[e.id] || null); },
    leave(id) { leavePlayer(id); },
    summary() { return JSON.stringify({ wave, players: players.length }); },
  };`, { filename: 'room-api.js' });

// The same name rules as the page (sim.js): letters, digits and a little punctuation, at most 14 characters
const cleanName = s => String(s || '').replace(/[^\p{L}\p{N} _\-.'!?]/gu, '').slice(0, 14).trim();
const HERO_KEYS = ['ranger', 'knight', 'mage', 'engineer'];
const DIFF_KEYS = ['veryeasy', 'easy', 'normal', 'hard', 'nightmare'];
const MAP_KEYS = ['small', 'medium', 'large'];
const MAX_PLAYERS = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const send = (ws, obj) => sendStr(ws, JSON.stringify(obj));
function sendStr(ws, str) { if (ws.readyState === 1) ws.send(str); }

const rooms = new Map();   // id → Room

class Room {
  constructor(id, creatorName, pass) {
    this.id = id;
    this.pass = pass;             // '' for an open room
    this.name = `${creatorName}'s game`;   // stays the same when the creator leaves
    this.clients = new Set();     // sockets in this room (ws.pid is their player id)
    this.lobby = [];              // { id, name, hero, color } — everyone in the room, in the order they arrived
    this.creator = -1;            // the player who picks the settings and starts the game
    this.set = { difficulty: 'normal', mapSize: 'large' };
    this.playing = false;         // false: in the lobby; true: a game is running (or just ended)
    this.nextId = 1;
    this.seats = new Map();       // player id → { token, name }: the only way back into a seat (and to a hero who left)
    this.acc = 0; this.snapT = 0; this.lobbyT = 0; this.emptyT = 0;
    this.ctx = vm.createContext({ console, JSON, Math });
    SIM.runInContext(this.ctx); API.runInContext(this.ctx);
    this.api = this.ctx.api;
  }
  info() {
    const s = this.playing ? JSON.parse(this.api.summary()) : null;
    return { id: this.id, name: this.name, n: this.lobby.length, max: MAX_PLAYERS, ig: this.playing ? 1 : 0, paused: this.playing && !this.lobby.length ? 1 : 0,
      over: this.playing && this.api.state() === 'over' ? 1 : 0, wave: s ? s.wave : 0, d: this.set.difficulty, m: this.set.mapSize, lock: this.pass ? 1 : 0 };
  }
  add(ws, name, hero, token, pass) {
    // A token from this room: take over the seat (the old socket may not have noticed it is dead yet), or come back to it
    const seat = typeof token === 'string' && token && [...this.seats].find(([, v]) => v.token === token);
    if (seat && this.lobby.some(r => r.id === seat[0])) {
      const id = seat[0];
      for (const old of this.clients) if (old.pid === id) { old.room = null; this.clients.delete(old); try { old.terminate(); } catch (e) {} }
      this.clients.add(ws); ws.room = this; ws.pid = id; this.emptyT = 0;
      if (this.playing) { this.broadcastLobby('room'); sendStr(ws, this.api.init(id)); } else this.broadcastLobby();
      log(`${seat[1].name} reconnected to ${this.id}`);
      return;
    }
    if (!seat && this.pass && pass !== this.pass) { send(ws, { t: 'err', msg: pass ? 'Wrong password for that game.' : 'That game needs a password: type it in the Password field, then join.' }); return; }
    if (this.lobby.length >= MAX_PLAYERS) { send(ws, { t: 'err', msg: `That game is full (${MAX_PLAYERS} players).` }); return; }
    let nm = name;
    for (let i = 2; this.lobby.some(r => r.name === nm); i++) nm = `${name.slice(0, 11)} ${i}`;
    const used = new Set(this.lobby.map(r => r.color));
    let color = 0; while (used.has(color)) color++;
    // Coming back with this room's token: the same seat, so a game under way gives back their hero (see joinPlayer).
    // Anyone else is a newcomer, whatever name they pick.
    const entry = { id: seat ? seat[0] : this.nextId++, name: nm, hero, color };
    this.lobby.push(entry); this.clients.add(ws);
    ws.room = this; ws.pid = entry.id;
    this.seats.set(entry.id, { token: seat ? token : newToken(), name: nm });
    if (this.creator < 0 || !this.lobby.some(r => r.id === this.creator)) this.creator = entry.id;
    this.emptyT = 0;
    if (this.playing) { this.api.join(JSON.stringify(entry)); this.broadcastLobby('room'); sendStr(ws, this.api.init(entry.id)); }
    else this.broadcastLobby();
    log(`${nm} joined ${this.id} (${this.lobby.length} in room)`);
  }
  remove(ws) {
    if (ws.room !== this) return;
    ws.room = null; this.clients.delete(ws);
    const entry = this.lobby.find(r => r.id === ws.pid);
    this.lobby = this.lobby.filter(r => r.id !== ws.pid);
    if (this.playing) this.api.leave(ws.pid);
    if (this.creator === ws.pid) this.creator = this.lobby.length ? this.lobby[0].id : -1;   // the longest-serving player takes over
    log(`${entry ? entry.name : '?'} left ${this.id} (${this.lobby.length} in room)`);
    // An empty lobby (or a finished game) closes at once; an empty game in progress waits, paused, for its players
    if (!this.lobby.length && (!this.playing || this.api.state() === 'over')) this.close();
    else this.broadcastLobby(this.playing ? 'room' : 'lobby');
  }
  close() { rooms.delete(this.id); for (const ws of this.clients) { ws.room = null; send(ws, { t: 'err', msg: 'The game was closed.' }); } log(`room ${this.id} closed`); }
  // t: 'lobby' (everyone goes to the lobby screen) or 'room' (during a game: just who is here and who leads)
  broadcastLobby(t = 'lobby') {
    const base = { t, room: this.id, name: this.name, creator: this.creator, players: this.lobby, set: this.set };
    for (const ws of this.clients) send(ws, { ...base, you: ws.pid, token: (this.seats.get(ws.pid) || {}).token });
  }
  start(pid) {
    if (pid !== this.creator || this.playing) return;
    this.api.start(JSON.stringify({ difficulty: this.set.difficulty, mapSize: this.set.mapSize, roster: this.lobby }));
    this.playing = true; this.acc = 0; this.snapT = 0;
    for (const ws of this.clients) sendStr(ws, this.api.init(ws.pid));
    log(`room ${this.id} started: ${this.lobby.length} players, ${this.set.difficulty}, ${this.set.mapSize} map`);
  }
  backToLobby(pid) {
    if (pid !== this.creator || !this.playing || this.api.state() !== 'over') return;
    this.playing = false;
    for (const id of [...this.seats.keys()]) if (!this.lobby.some(r => r.id === id)) this.seats.delete(id);   // a new game: forget who left the old one
    this.broadcastLobby();
  }
  onMessage(ws, d) {
    switch (d.t) {
      case 'i': if (this.playing) this.api.input(ws.pid, JSON.stringify(d)); break;
      case 'c': if (this.playing && d.c && typeof d.c === 'object') this.api.cmd(ws.pid, JSON.stringify(d.c)); break;
      case 'hero': {
        const r = this.lobby.find(r => r.id === ws.pid);
        if (r && !this.playing && HERO_KEYS.includes(d.k)) { r.hero = d.k; this.broadcastLobby(); }
        break;
      }
      case 'set':
        if (ws.pid !== this.creator || this.playing) break;
        if (DIFF_KEYS.includes(d.d)) this.set.difficulty = d.d;
        if (MAP_KEYS.includes(d.m)) this.set.mapSize = d.m;
        this.broadcastLobby(); break;
      case 'start': this.start(ws.pid); break;
      case 'lobby': this.backToLobby(ws.pid); break;
      case 'leave': this.remove(ws); sendRooms(ws); break;
    }
  }
  tick(dt) {
    if (!this.lobby.length) {   // nobody here: the game stays paused until someone joins, or until it expires
      if ((this.emptyT += dt) > EMPTY_TTL) this.close();
      return;
    }
    if (!this.playing) { if ((this.lobbyT -= dt) <= 0) { this.lobbyT = 1 / LOBBY_RATE; this.broadcastLobby(); } return; }
    const over = this.api.state() === 'over';
    if (!over) {
      this.acc = Math.min(this.acc + dt, 0.25);   // after a stall, catch up at most a quarter of a second
      while (this.acc >= STEP) { this.api.step(STEP); this.acc -= STEP; }
    }
    if ((this.snapT -= dt) <= 0) {
      this.snapT = 1 / (over ? OVER_SNAP_RATE : SNAP_RATE);
      const snap = this.api.snap();   // serialised once for everyone
      for (const ws of this.clients) sendStr(ws, snap);
    }
  }
}

function roomList() { return [...rooms.values()].map(r => r.info()); }
function sendRooms(ws) { send(ws, { t: 'rooms', rooms: roomList(), max: MAX_ROOMS }); }
const newToken = () => randomUUID();   // unguessable: it lets whoever holds it take that player's seat
function newRoomId() { let id; do id = Array.from({ length: 4 }, () => CODE_CHARS[(Math.random() * CODE_CHARS.length) | 0]).join(''); while (rooms.has(id)); return id; }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function onMessage(ws, raw) {
  if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
  let d; try { d = JSON.parse(raw); } catch (e) { return; }
  if (!d || typeof d !== 'object') return;
  if (ws.room) { ws.room.onMessage(ws, d); return; }
  const name = cleanName(d.name) || 'Player', hero = HERO_KEYS.includes(d.hero) ? d.hero : 'ranger';
  const pass = typeof d.pass === 'string' ? d.pass.slice(0, 20) : '';
  if (d.t === 'list') { sendRooms(ws); return; }
  if ((d.t === 'create' || d.t === 'join') && d.v !== NET_VERSION) { send(ws, { t: 'err', msg: versionMsg(d.v), version: 1 }); return; }
  if (d.t === 'create') {
    if (rooms.size >= MAX_ROOMS) { send(ws, { t: 'err', msg: `This server already has ${MAX_ROOMS} games. Join one of them, or wait for one to end.` }); sendRooms(ws); return; }
    const room = new Room(newRoomId(), name, pass);
    rooms.set(room.id, room);
    log(`room ${room.id} opened by ${name}${pass ? ' (password)' : ''}`);
    room.add(ws, name, hero, null, pass);
  } else if (d.t === 'join') {
    const room = rooms.get(String(d.room));
    if (!room) { send(ws, { t: 'err', msg: 'That game has ended.' }); sendRooms(ws); return; }
    room.add(ws, name, hero, d.token, pass);
  }
}

// ----- HTTP: the game page, plus /info for finding servers -----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.css': 'text/css' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/info') {   // lets the game find and describe this server (any origin may ask)
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ game: 'tower-siege', v: NET_VERSION, name: SERVER_NAME, rooms: rooms.size, maxRooms: MAX_ROOMS,
      players: [...rooms.values()].reduce((n, r) => n + r.lobby.length, 0) }));
    return;
  }
  let file = path.normalize(path.join(WEB, decodeURIComponent(url.pathname)));
  if (file !== WEB && !file.startsWith(WEB + path.sep)) { res.writeHead(403); res.end(); return; }
  try { if (statSync(file).isDirectory()) file = path.join(file, 'index.html'); statSync(file); }
  catch (e) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  createReadStream(file).pipe(res);
});

// ----- WebSocket: the games -----
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024,
  perMessageDeflate: { zlibDeflateOptions: { level: 3 }, threshold: 256 } });   // snapshots compress about 3× (level 3: cheap on CPU)
const perIp = new Map();   // address → open connections
// Who is connecting: behind the Cloudflare tunnel every connection comes from cloudflared on this machine, which passes on
// the player's address in CF-Connecting-IP (only trusted when the connection itself is local)
function clientIp(req) {
  const a = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const cf = req.headers['cf-connecting-ip'];
  return (a === '127.0.0.1' || a === '::1') && typeof cf === 'string' ? cf.slice(0, 64) : a;
}
wss.on('connection', (ws, req) => {
  const ip = clientIp(req), n = perIp.get(ip) || 0;
  if (wss.clients.size > MAX_CONNS || n >= MAX_PER_IP) {
    send(ws, { t: 'err', msg: 'The server is busy (too many connections). Try again in a minute.' });
    ws.close(1013, 'busy'); log(`refused a connection from ${ip}: ${n >= MAX_PER_IP ? 'too many from that address' : 'server full'}`);
    return;
  }
  perIp.set(ip, n + 1);
  ws.alive = true; ws.room = null; ws.bucket = MSG_BURST; ws.bucketT = performance.now();
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data, isBinary) => {
    // Token bucket: MSG_RATE a second, MSG_BURST at once. Extra messages are dropped; a flood that keeps going is cut off.
    const now = performance.now();
    ws.bucket = Math.min(MSG_BURST, ws.bucket + (now - ws.bucketT) / 1000 * MSG_RATE); ws.bucketT = now;
    if (--ws.bucket < 0) { if (ws.bucket < -4 * MSG_BURST) { log(`closing a flooding connection from ${ip}`); ws.terminate(); } return; }
    if (!isBinary) try { onMessage(ws, data.toString()); } catch (e) { console.error(e); }
  });
  ws.on('close', () => { if (ws.room) ws.room.remove(ws); const k = (perIp.get(ip) || 1) - 1; if (k > 0) perIp.set(ip, k); else perIp.delete(ip); });
  ws.on('error', () => {});
  send(ws, { t: 'hello', game: 'tower-siege', v: NET_VERSION, name: SERVER_NAME });
  sendRooms(ws);
});
setInterval(() => {
  for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; try { ws.ping(); } catch (e) {} }
}, PING_EVERY);

let last = performance.now();
setInterval(() => {
  const now = performance.now(), dt = Math.min(0.5, (now - last) / 1000); last = now;
  for (const room of [...rooms.values()]) { try { room.tick(dt); } catch (e) { console.error(`room ${room.id}:`, e); room.close(); } }
}, 1000 * STEP);

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`Tower Siege server "${SERVER_NAME}" on port ${PORT}`);
  for (const ip of ips) console.log(`  LAN: http://${ip}:${PORT}`);
});
