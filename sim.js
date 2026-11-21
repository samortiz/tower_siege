// Tower Siege simulation: data tables, game state and the rules that advance it.
// Loaded by the page (index.html) before its own script, and by the game server (server/), which runs one copy
// per room in its own context. Nothing in here may touch the DOM, the canvas or the keyboard: the page and the
// server plug into the hooks below instead.
"use strict";
// ---------- Constants ----------
const T = 32;
let COLS = 61, ROWS = 45, WW = COLS * T, WH = ROWS * T;     // world size (tiles / pixels) — set by applyMapSize
let CX = Math.floor(COLS / 2), CY = Math.floor(ROWS / 2);    // core center tile (core is 3x3)

// ---------- Hooks ----------
// onTerrain: the terrain changed (the page redraws its terrain canvas). onMapSize: the map size changed (the page lays out
// its minimap). onLocalHero(p, dt): moves the hero this device controls (the page reads the keyboard / joystick).
let onTerrain = () => {}, onMapSize = () => {}, onLocalHero = null;
// online: this game is networked (always show the co-op HUD and wallets). fxOut: queue effects and terrain edits for
// remote players (see netFx / netTer). headless: no one watches this copy, so skip purely visual particles and texts.
let online = false, fxOut = false, headless = false;
let netFx = [], netTer = [], sentGv = -1;   // sentGv: gridVer of the last full building list sent (see makeSnap)

// ---------- Settings ----------
const DIFFS = {
  veryeasy:  { label: 'Very Easy', hp: 0.5,  dmg: 0.55, gold: 300, core: 900, desc: 'For learning the ropes: much weaker enemies, 300 gold, 900 core HP' },
  easy:   { label: 'Easy',   hp: 0.7,  dmg: 0.75, gold: 220, core: 700, desc: 'Weaker enemies, 220 starting gold, 700 core HP' },
  normal: { label: 'Normal', hp: 1,    dmg: 1,    gold: 150, core: 500, desc: 'The intended challenge: 150 gold, 500 core HP' },
  hard:   { label: 'Hard',   hp: 1.35, dmg: 1.25, gold: 110, core: 400, desc: 'Tougher, harder-hitting enemies, 110 gold, 400 core HP' },
  nightmare: { label: 'Nightmare', hp: 1.8, dmg: 1.5, gold: 90,  core: 300, desc: 'Brutal: very tough, very hard-hitting enemies, 90 gold, 300 core HP' },
};
const MAP_SIZES = {
  small:  { label: 'Small',  cols: 31, rows: 23, desc: '31 × 23 tiles — fits on one screen, fast waves' },
  medium: { label: 'Medium', cols: 45, rows: 33, desc: '45 × 33 tiles' },
  large:  { label: 'Large',  cols: 61, rows: 45, desc: '61 × 45 tiles — lots of room, long marches' },
};

let diff = DIFFS.normal, diffKey = 'normal', mapKey = 'large'; // difficulty and map locked in when a game starts
// Player names: letters, digits and a little punctuation, at most 14 characters
function filterName(s) { return String(s || '').replace(/[^\p{L}\p{N} _\-.'!?]/gu, '').slice(0, 14); }
function cleanName(s) { return filterName(s).trim(); }

function applyMapSize(key) {
  if (!MAP_SIZES[key]) key = 'large';
  const m = MAP_SIZES[key]; mapKey = key;
  COLS = m.cols; ROWS = m.rows; WW = COLS * T; WH = ROWS * T;
  CX = Math.floor(COLS / 2); CY = Math.floor(ROWS / 2);
  coreRect.x = (CX - 1) * T; coreRect.y = (CY - 1) * T;
  pathCache.clear();
  onMapSize();
}
const BUILD_RANGE = 5.5 * T;
const WALL_PATH_COST = 14;            // how much enemies "dislike" chewing through a building

const DEFS = {
  wall:   { name: 'Wall',        key: '1', cost: 10,  hp: 260, color: '#8d939c', desc: 'Blocks enemies' },
  arrow:  { name: 'Arrow Tower', key: '2', cost: 50,  hp: 150, color: '#d4a62a', range: 5,   interval: 0.55, dmg: 12, desc: 'Fast, hits air' },
  cannon: { name: 'Cannon',      key: '3', cost: 110, hp: 220, color: '#c0483f', range: 4.5, interval: 1.7,  dmg: 42, splash: 1.3, desc: 'Splash, ground only' },
  frost:  { name: 'Frost Tower', key: '4', cost: 80,  hp: 150, color: '#4fb3d9', range: 3,   interval: 1.0,  dmg: 4,  desc: 'Slows enemies' },
  mine:   { name: 'Gold Mine',   key: '5', cost: 120, hp: 120, color: '#e8c24a', interval: 4, income: 6, desc: '+gold over time' },
  bridge:   { name: 'Bridge',     key: 'B', cost: 20,  hp: 1,   color: '#8a5e32', desc: 'Build over water' },
  medic:    { name: 'Medic Tent', key: 'M', cost: 120, hp: 180, color: '#f2f2f2', interval: 10, unitHp: 50, maxUnits: 1, heal: 30, desc: 'Medics repair & heal' },
  barracks: { name: 'Barracks',  key: '6', cost: 150, hp: 300, color: '#4caf7a', interval: 7, dmg: 9, unitHp: 70, maxUnits: 3, maxLevel: 5, desc: 'Trains soldiers' },
};
const BUILD_TIME = 1;   // seconds for a newly placed building to finish construction (bridges are instant)
const ORDER = ['wall', 'arrow', 'cannon', 'frost', 'mine', 'barracks', 'medic', 'bridge'];

// Hero weapon upgrades (bought with gold, keys 6-9 or the buttons on the right of the bar)
const HERO_UPS = {
  dmg:   { name: 'Damage',    key: '7', base: 40,  max: 5, color: '#ff7a5a' },
  rate:  { name: 'Fire Rate', key: '8', base: 45,  max: 5, color: '#ffd84a' },
  range: { name: 'Range',     key: '9', base: 30,  max: 5, color: '#7fd6ff' },
  multi: { name: 'Multishot', key: '0', base: 120, max: 3, color: '#c58bff' },
  // Knight only (in place of Range and Multishot)
  armor: { name: 'Armor',     key: '9', base: 35,  max: 5, color: '#b8c4d4' },
  taunt: { name: 'Taunt',     key: '0', base: 100, max: 3, color: '#ff6a5a' },
  // Engineer only (in place of Range and Multishot)
  power: { name: 'Aura Power', key: '9', base: 50,  max: 5, color: '#ffb347' },
  aura:  { name: 'Aura Size', key: '0', base: 80,  max: 4, color: '#e0912c' },
  // Ranger only (in place of Fire Rate and Range): level 1 unlocks frost arrows, level 2 fire arrows, level 3 explosive arrows
  ammo:  { name: 'Arrows',    key: '9', base: 90,  max: 3, color: '#6fd3ff' },
};
// Ranger arrow types (heroUp.arrow is the one he is shooting; he owns types 0..heroUp.ammo). Z switches between owned types.
// An enemy is either chilled or burning, never both: each one replaces the other, and wading into water puts out both.
const ARROWS = [
  { name: 'Regular', short: 'Std',  color: '#fff6a0', dmg: 1 },
  { name: 'Frost',   short: 'Ice',  color: '#8fe0ff', dmg: 0.6 },   // weaker, but slows the target
  { name: 'Fire',    short: 'Fire', color: '#ff8a30', dmg: 0.8 },   // weaker hit, then the target keeps burning
  { name: 'Explosive', short: 'Boom', color: '#ffb347', dmg: 0.7, splash: 1 },   // bursts on impact, hurting everything within 1 tile (flyers too)
];
// Frost arrow slow (s). Fire arrows stack burns up to BURN_MAX; each stack burns for BURN_DPS × the arrow's full damage per second,
// plus BURN_BIG of the enemy's max HP per second (so fire is the arrow for bosses and other tough enemies). Each hit restarts the BURN_T countdown for every stack.
// Bosses (the Boss and the Siege Golem) take BURN_BOSS times the arrow-damage part of the burn: a maxed Ranger with fire arrows does about 1000 damage/s to a wave-10 boss.
const ICE_T = 2.5, BURN_T = 3, BURN_DPS = 0.25, BURN_MAX = 5, BURN_BIG = 0.004, BURN_BOSS = 9;
const isBoss = e => e.type === 'boss' || !!e.siege;
const chill = (e, t) => { e.slowT = Math.max(e.slowT, t); e.burnT = 0; e.burnN = 0; };
const ignite = (e, dps, src) => {
  e.burnN = Math.min(BURN_MAX, (e.burnT > 0 ? e.burnN || 0 : 0) + 1);
  e.slowT = 0; e.burnT = BURN_T; e.burnDps = Math.max(e.burnT > 0 && e.burnN > 1 ? e.burnDps || 0 : 0, dps); e.burnSrc = src;
};
const burnRate = e => (e.burnN || 1) * (e.burnDps * (isBoss(e) ? BURN_BOSS : 1) + e.maxHp * BURN_BIG);   // burn damage per second
const HERO_ORDER = ['dmg', 'rate', 'range', 'multi'];
const heroOrder = () => (hero && hero.ups) || HERO_ORDER;   // the four upgrade slots of the bound hero
const ARMOR_PER = 0.1;   // Knight's Armor: 10% less damage taken per level
const tauntR = h => (TAUNT_R + ((h.heroUp && h.heroUp.taunt) || 0)) * T;   // Knight's Taunt: +1 tile of pull per level

// Total gold paid for a set of hero upgrade levels (each level costs base × 1.7^level)
const upgradeSpend = up => Object.keys(HERO_UPS).reduce((s, k) => { for (let i = 0; i < (up[k] || 0); i++) s += Math.round(HERO_UPS[k].base * Math.pow(1.7, i)); return s; }, 0);
const heroCost = k => Math.round(HERO_UPS[k].base * Math.pow(1.7, heroUp[k]));
// Hero types, picked on the hero select screen. dmg/interval/range are the base weapon; upgrades scale them.
const HEROES = {
  ranger: { name: 'Ranger', color: '#3a8ef0', hp: 100, speed: 170, dmg: 10, interval: 0.26, range: 5.5, targets: 1, work: 1, kind: 'bolt',
            ups: ['dmg', 'multi', 'ammo'],
            tagline: 'Hand crossbow', perk: 'Fastest on foot, with a quick, long-range crossbow. A good all-rounder. Upgrades Damage, Multishot and Arrows: frost arrows slow, fire arrows set enemies burning, explosive arrows blast crowds — switch with Z.' },
  knight: { name: 'Knight', color: '#c0483f', hp: 190, speed: 145, dmg: 18, interval: 0.55, range: 2.2, targets: Infinity, work: 4, kind: 'melee', dmgUp: 2.9, ups: ['dmg', 'rate', 'armor', 'taunt'],
            dagger: { dmg: 9, interval: 0.9, range: 3.5 },
            tagline: 'Sword and throwing daggers', perk: 'Very tough. Taunts nearby enemies into fighting him instead of your buildings. The sword hits every enemy in reach and knocks them back; daggers (shortest range of any hero) pick off enemies a little further out. Chops four times as fast. Upgrades Armor and Taunt instead of Range and Multishot.' },
  mage:   { name: 'Mage', color: '#9a5ae0', hp: 80, speed: 155, dmg: 16, interval: 0.7, range: 6.5, targets: 1, work: 1, kind: 'fire', splash: 1.1,
            tagline: 'Fire staff', perk: 'Longest reach. Fireballs explode and burn every enemy nearby — great against crowds. Fragile.' },
  engineer: { name: 'Engineer', color: '#e0912c', hp: 120, speed: 150, dmg: 7, interval: 0.32, range: 4.5, targets: 1, work: 1, kind: 'rivet', ups: ['dmg', 'rate', 'power', 'aura'],
            tagline: 'Rivet gun and toolbox', perk: 'Weak gun, but nearby buildings work 40% faster, build 3× faster and are repaired 3× faster. Heals nearby soldiers and teammates like a medic. Gets 90% back when selling buildings. Towers and soldiers in his aura share their kill gold with him, and Gold Mines in it pay him 50% extra. Upgrades Aura Power and Aura Size instead of Range and Multishot.' },
};
const HERO_TYPES = ['ranger', 'knight', 'mage', 'engineer'];
const OVERDRIVE_R = 4, OVERDRIVE = 1.4, BUILD_BOOST = 3, ENG_REPAIR = 3;   // Engineer: aura radius (tiles), building work speed and construction speed inside it, repair multiplier
const AURA_PER = 0.5;   // Engineer's Aura upgrade: +½ tile of radius per level
const auraR = h => (OVERDRIVE_R + AURA_PER * ((h.heroUp && h.heroUp.aura) || 0)) * T;
// The nearest living Engineer whose aura covers this point (his id), or null. Towers and soldiers inside his aura pay him a cut of their kill gold (see engCut).
function towerEngineer(px, py) {
  let best = null, bd = Infinity;
  for (const h of players) if (h.alive && h.heroType === 'engineer') { const dd = d2(h.x, h.y, px, py); if (dd < auraR(h) ** 2 && dd < bd) { bd = dd; best = h.id; } }
  return best;
}
const ENG_TOWER_CUT = 0.6;
const ENG_MINE_BONUS = 0.5;   // a Gold Mine inside his aura pays him an extra 50% of its output, on top of the normal split
// Aura Power also raises, per level: construction speed +0.4× (3× → 5×), repair speed +0.4× (3× → 5×), tower and soldier gold cut +5% (60% → 85%)
const BUILD_PER = 0.4, REPAIR_PER = 0.4, CUT_PER = 0.05;
const engPower = h => (h && h.heroUp && h.heroUp.power) || 0;
const engRepair = h => ENG_REPAIR + REPAIR_PER * engPower(h);
const engCut = h => ENG_TOWER_CUT + CUT_PER * engPower(h);
// Engineer also patches up friendly units like a medic: the most hurt soldier, medic or other hero in reach, one at a time
const ENG_HEAL = 15, HEAL_PER = 0.2, ENG_HEAL_R = 2.5 * 32;   // HP/s, +20% per Aura Power level, reach (px)
const engHeal = h => ENG_HEAL * (1 + HEAL_PER * engPower(h));
const POWER_PER = 0.1;   // Engineer's Aura Power upgrade: +10% building work speed per level (1.4× → 1.9×)
// How much faster a building at this point works: the strongest covering Engineer's overdrive, or 1 with none nearby
// The highest Aura Power level among living Engineers covering this point, or -1 when none is in range
function auraPowerAt(px, py) {
  let m = -1;
  for (const h of players) if (h.alive && h.heroType === 'engineer' && d2(h.x, h.y, px, py) < auraR(h) ** 2) m = Math.max(m, engPower(h));
  return m;
}
// true when a living Engineer stands within aura range of the point
const engineerNear = (px, py) => players.some(h => h.alive && h.heroType === 'engineer' && d2(h.x, h.y, px, py) < auraR(h) ** 2);
const TAUNT_R = 3;        // tiles: ground enemies this close to a Knight drop everything to fight him
const BIG_R = 13;         // enemies this large (brute, splitter, bosses) ignore a Ranger or Mage they can't already hit
const KNOCK = 0.8 * 32, KNOCK_T = 0.15;   // Knight's sword: knockback distance (px, for enemies up to 12 px radius; bigger ones fly less) and how long the shove takes
let heroType = 'ranger', hero = HEROES.ranger;
// Each Damage upgrade adds 40% of base damage (the Knight's sword: much more, so a fully upgraded Knight edges out a fully upgraded Mage on crowds)
const heroDmg = () => hero.dmg * (1 + wave * 0.03) * (1 + (hero.dmgUp || 0.4) * heroUp.dmg);
const heroInterval = () => hero.interval * Math.pow(0.85, heroUp.rate);
const KNIGHT_TURN = 6;    // rad/s: how fast the Knight can turn to face a new foe (his sword only covers the half-circle in front of him)
const inFront = (p, e) => (e.x - p.x) * Math.cos(p.aim) + (e.y - p.y) * Math.sin(p.aim) >= 0;   // within the 180° arc the hero faces
const swingTime = rateLvl => 0.25 * Math.pow(0.85, rateLvl || 0);   // the Knight's sword swings faster with each Fire Rate upgrade
const heroRange = () => hero.range * (1 + 0.145 * heroUp.range) * T;
const daggerRange = () => hero.dagger ? hero.dagger.range * (1 + 0.145 * heroUp.range) * T : 0;
function buyHero(k) {   // for the bound player (see bindP)
  const u = HERO_UPS[k], to = player.id;
  if (!heroOrder().includes(k)) return;
  if (heroUp[k] >= u.max) { floatText(player.x, player.y - 24, u.name + ' maxed', '#aaa', 13, 1, to); return; }
  const c = heroCost(k);
  if (!spendHero(player, c)) { floatText(player.x, player.y - 24, coop() ? `Need ${c} gold in your wallet` : `Need ${c} gold`, '#f77', 13, 1, to); return; }
  heroUp[k]++;
  burst(player.x, player.y, u.color, 16, 120);
  if (k === 'ammo') { heroUp.arrow = heroUp.ammo; floatText(player.x, player.y - 24, `${ARROWS[heroUp.arrow].name} arrows!  (Z to switch)`, ARROWS[heroUp.arrow].color, 14); }
  else floatText(player.x, player.y - 24, `${u.name} ${heroUp[k]}/${u.max}`, u.color, 14);
}
function switchArrow(to) {   // for the bound player: pick an owned arrow type (or the next one round)
  if (!heroOrder().includes('ammo') || !heroUp.ammo) return;
  heroUp.arrow = Number.isInteger(to) && to >= 0 && to <= heroUp.ammo ? to : ((heroUp.arrow || 0) + 1) % (heroUp.ammo + 1);
  const a = ARROWS[heroUp.arrow];
  floatText(player.x, player.y - 24, `${a.name} arrows`, a.color, 13, 0.9);
}

const ETYPES = {
  grunt:  { hp: 40,  speed: 52,  dmg: 8,  rate: 1.0, gold: 4,  r: 9,  color: '#62c24c' },
  runner: { hp: 22,  speed: 105, dmg: 5,  rate: 0.6, gold: 3,  r: 7,  color: '#e9e15a' },
  brute:  { hp: 170, speed: 34,  dmg: 32, rate: 1.4, gold: 12, r: 13, color: '#9b59b6' },
  flyer:  { hp: 30,  speed: 68,  dmg: 10, rate: 1.0, gold: 6,  r: 8,  color: '#ff7ab8', fly: true },
  boss:   { hp: 1300,speed: 28,  dmg: 70, rate: 1.5, gold: 120, r: 20, color: '#e04040' },
  splitter:  { hp: 90, speed: 40,  dmg: 12, rate: 1.0, gold: 8, r: 14, color: '#ff9a3c', split: 7 },
  // Siege Golem: a boss that stops to lob artillery at your buildings from long range
  siege:     { hp: 1300, speed: 24, dmg: 40, rate: 1.5, gold: 150, r: 22, color: '#5d6478', siege: true, range: 5, fireRate: 2.6, shellDmg: 55 },
  splitling: { hp: 12, speed: 95,  dmg: 3,  rate: 0.5, gold: 1, r: 5,  color: '#ffb866' },
  // Mother Splitter: bursts into three full Splitters (each of which bursts again)
  bigsplitter: { hp: 380, speed: 30, dmg: 22, rate: 1.2, gold: 20, r: 19, color: '#e8742a', split: 3, splitInto: 'splitter' },
  // Climber: scales mountains (slowly) instead of walking around them
  climber:   { hp: 55, speed: 60, dmg: 9, rate: 0.9, gold: 6, r: 9, color: '#a8865a', climb: true },
  // Swimmer: sluggish on land, fast in rivers, and takes half damage while submerged
  swimmer:   { hp: 70, speed: 38, dmg: 10, rate: 1.0, gold: 6, r: 10, color: '#3fb6a8', swim: true },
  // Burrower: tunnels under walls and towers instead of chewing through them; only splash damage reaches it underground
  digger:    { hp: 65, speed: 46, dmg: 11, rate: 1.0, gold: 7, r: 10, color: '#8a6a52', dig: true },
};

// ---------- State ----------
let announces = [], soldiers = [], newEnemies = [], heroUp, lossReason = '', grid, dist, core, player, enemies, projectiles, particles, texts, treasury = 0, wave, phase, phaseT,
    spawnQueue, spawnT, waveTheme = 'mixed', nextTheme = 'mixed', gameState, kills, flowDirty;
let speedPaused = false;   // frozen (single player: the top-bar pause; the page sets it)

// ---------- Co-op: players, wallets and the shared treasury ----------
// `players` holds every hero in the game; `me` is the id of the one this browser controls.
// Most hero code works on the global `player` / `hero` / `heroUp`, which bindP() points at one player at a time.
const MAX_PLAYERS = 8;
const START_WALLET = 50;   // gold in each wallet when a co-op game starts
const P_COLORS = ['#4aaaff', '#ffb43a', '#7ee05a', '#ee6ae8', '#ff5a5a', '#3fe0d0', '#f5f07a', '#b48cff'];
const REVIVE_TIME = 2, REVIVE_REACH = 1.6 * T;
let players = [], me = 0, departed = {},   // departed: player id → what leavePlayer kept of a hero who left (see joinPlayer)
    pings = [], evenRot = 0, uid = 0, gridVer = 0;
const has = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const pById = id => players.find(p => p.id === id);
const localP = () => pById(me) || players[0];
const coop = () => players.length > 1 || online;   // show the co-op HUD (wallets, team list, names)
function bindP(p) { player = p; hero = p.hero; heroUp = p.heroUp; heroType = p.heroType; }
function bindLocal() { const p = localP(); if (p) bindP(p); }
const funds = p => p.wallet + treasury;
// Spend from the player's own wallet first; the treasury covers the rest
function spend(p, c) {
  if (funds(p) < c) return false;
  const w = Math.min(p.wallet, c); p.wallet -= w; treasury -= c - w;
  return true;
}
// Hero upgrades are personal: in co-op they come out of your own wallet only, never the treasury
const heroFunds = p => coop() ? p.wallet : funds(p);
function spendHero(p, c) {
  if (!coop()) return spend(p, c);
  if (p.wallet < c) return false;
  p.wallet -= c; return true;
}
function earn(p, n) { p.wallet += n; p.stats.gold += n; }
// Split n gold evenly across every player; leftover coins rotate so nobody is always favoured
function splitEven(n) {
  const out = [], k = players.length; if (!k) return out;
  const base = Math.floor(n / k); let rem = n - base * k;
  for (let i = 0; i < k; i++) { out.push([players[(i + evenRot) % k], base + (rem > 0 ? 1 : 0)]); rem--; }
  evenRot = (evenRot + 1) % k;
  return out;
}
// Where a hero appears: just below the core, unless a building, tree or rock is in the way. Then the nearest open
// tile, searching outward from the core over walkable tiles only, so the hero never lands inside a building or
// in a pocket walled off from the core.
function heroSpawn(p) {
  const x0 = CX * T + T / 2 + ((p.id % MAX_PLAYERS) - (MAX_PLAYERS - 1) / 2) * 14, y0 = (CY + 2.6) * T, r = p.r || 10;
  if (!grid || !grid.length || !terrain || !bodyBlocked(x0, y0, r)) return [x0, y0];
  const open = (x, y) => inB(x, y) && !grid[y][x] && !isCore(x, y) && !blockT(x, y);
  const seen = new Set(), key = (x, y) => y * COLS + x;
  let layer = [];
  for (let y = CY - 1; y <= CY + 1; y++) for (let x = CX - 1; x <= CX + 1; x++) { layer.push([x, y]); seen.add(key(x, y)); }
  while (layer.length) {
    const next = [];
    for (const [x, y] of layer) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (seen.has(key(nx, ny)) || !open(nx, ny)) continue;
      seen.add(key(nx, ny)); next.push([nx, ny]);
    }
    // the free tile in this ring closest to the usual spot
    let best = null, bd = Infinity;
    for (const [x, y] of next) {
      const cx = x * T + T / 2, cy = y * T + T / 2, dd = d2(cx, cy, x0, y0);
      if (dd < bd && !bodyBlocked(cx, cy, r)) { bd = dd; best = [cx, cy]; }
    }
    if (best) return best;
    layer = next;
  }
  // Core completely walled in: fall back to any open tile on the map, nearest first
  let best = [x0, y0], bd = Infinity;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const cx = x * T + T / 2, cy = y * T + T / 2, dd = d2(cx, cy, x0, y0);
    if (dd < bd && open(x, y) && !bodyBlocked(cx, cy, r)) { bd = dd; best = [cx, cy]; }
  }
  return best;
}
function makePlayer(id, name, type, colorI = id) {
  const h = HEROES[type] || HEROES.ranger;
  const p = { id, name, colorI, color: P_COLORS[colorI % P_COLORS.length], heroType: HEROES[type] ? type : 'ranger', hero: h, isHero: true,
    heroUp: { dmg: 0, rate: 0, range: 0, multi: 0, armor: 0, taunt: 0, aura: 0, power: 0, ammo: 0, arrow: 0 }, wallet: 0, ready: false, remote: false,
    x: 0, y: 0, r: 10, hp: h.hp, maxHp: h.hp, alive: true, respawnT: 0, reviveT: 0,
    cd: 0, lastHit: 99, aim: 0, speed: h.speed, work: null,
    stats: { kills: 0, dmg: 0, gold: 0, built: 0, revives: 0 } };
  [p.x, p.y] = heroSpawn(p);
  return p;
}
function gameOver(reason) { if (gameState === 'over') return; gameState = 'over'; lossReason = reason; }

// ---------- Terrain ----------
// 0 grass · 1 river (slows ground units, can't build) · 2 mountain (impassable) · 3 tree (impassable, chop for gold)
const GRASS = 0, WATER = 1, ROCK = 2, TREE = 3, BRIDGE = 4;
const WATER_SLOW = 0.12; // ground units barely crawl through rivers (about 1/8 speed)
const SWIM_FAST = 2.4, CLIMB_SLOW = 0.6, SUBMERGED = 0.5;   // Swimmer speed in water, Climber speed on rock, damage a submerged Swimmer takes
const CHOP_GOLD = 4;
const CHOP_TIME = 2, BRIDGE_TIME = 3.5;   // seconds the hero must work to fell a tree / tear down a bridge tile
let blasts = [];   // blasts: fireball explosion rings { x, y, r, life } · each hero's chop/demolish job is player.work { kind, tx, ty, t, need }
let terrain, tileSeed, terrainCanvas, bridgeDir, terrainSeed = 1;
const terr = (x, y) => inB(x, y) ? terrain[y][x] : ROCK;
const blockT = (x, y) => { const t = terr(x, y); return t === ROCK || t === TREE; };
// Enemy movement modes: 'ground' walks around mountains, 'climb' goes over them, 'swim' prefers rivers. Each has its own flow field.
const MODES = ['ground', 'climb', 'swim', 'dig'];
const modeOf = e => e.climb ? 'climb' : e.swim ? 'swim' : e.dig ? 'dig' : 'ground';
const DIG_COST = 1.8, DIG_SLOW = 0.7;   // Burrower: path cost of tunnelling under a building, and its speed while underground
// Is a Burrower close enough to a building that it has gone underground?
function underBuilding(e) {
  const cx = tileOf(e.x), cy = tileOf(e.y);
  for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++)
    if (inB(x, y) && grid[y][x] && rectDist(e.x, e.y, x * T, y * T, T, T) < e.r * 0.9) return true;
  return false;
}
const untouchable = e => e.dead || e.burrow;   // can't be targeted directly (splash still reaches it)
const mBlock = (m, x, y) => { const t = terr(x, y); return t === TREE || (t === ROCK && m !== 'climb'); };
const waterAt = (px, py) => terr(tileOf(px), tileOf(py)) === WATER;
function genTerrain() {
  const coreDist = (x, y) => Math.hypot(x - CX, y - CY);
  const area = COLS * ROWS / (61 * 45), sc = n => Math.max(1, Math.round(n * area));
  for (let attempt = 0; attempt < 40; attempt++) {
    terrain = Array.from({ length: ROWS }, () => Array(COLS).fill(GRASS));
    tileSeed = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, Math.random));
    terrainSeed = (Math.random() * 1e9) | 0;
    bridgeDir = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
    const bridges = [];
    const set = (x, y, t, clear) => { if (inB(x, y) && coreDist(x, y) > clear) terrain[y][x] = t; };
    // Rivers: wavy bands crossing the map, kept away from the core
    const orient = Math.random() < 0.5 ? ['h', 'v', 'h', 'v'] : ['v', 'h', 'v', 'h'];
    const nRivers = (area < 0.4 ? 1 : 2) + (Math.random() < 0.5 ? 1 : 0) + (area > 1.5 && Math.random() < 0.6 ? 1 : 0);
    for (let r = 0; r < nRivers; r++) {
      const h = orient[r] === 'h', sign = Math.random() < 0.5 ? -1 : 1;
      const base = (h ? CY : CX) + sign * rand(6, (h ? CY : CX) - 3);
      const amp = rand(1, 2.5), freq = rand(0.15, 0.35), ph = rand(0, 6.28), width = Math.random() < 0.5 ? 2 : 1;
      const len = h ? COLS : ROWS;
      for (let i = 0; i < len; i++) {
        const c = Math.round(base + amp * Math.sin(i * freq + ph));
        for (let w = 0; w < width; w++) h ? set(i, c + w, WATER, 4.5) : set(c + w, i, WATER, 4.5);
        bridges.push({ h, i, c, width, len });
      }
    }
    // Bridges: a few crossings spread along each river (span = the river's width at that spot)
    const picks = new Set();
    for (const r of [...new Set(bridges.map(b => b.h + ':' + b.len))]) {
      const span = bridges.filter(b => b.h + ':' + b.len === r);
      const n = Math.max(2, Math.round(span[0].len / 12));
      for (let k = 0; k < n; k++) {
        const i = Math.round(span[0].len * (k + 1) / (n + 1) + rand(-2, 2));
        const b = span.find(b => b.i === i); if (b) picks.add(b);
      }
    }
    for (const b of picks)
      for (let w = -1; w <= b.width; w++) {
        const x = b.h ? b.i : b.c + w, y = b.h ? b.c + w : b.i;
        if (inB(x, y) && terrain[y][x] === WATER) { terrain[y][x] = BRIDGE; bridgeDir[y][x] = b.h ? 'v' : 'h'; }
      }
    // Mountain ranges: random walks
    const nM = sc(9 + ((Math.random() * 5) | 0)) + 1;
    for (let m = 0; m < nM; m++) {
      let x = (Math.random() * COLS) | 0, y = (Math.random() * ROWS) | 0;
      if (coreDist(x, y) < 7) { m--; continue; }
      const steps = 8 + ((Math.random() * 16) | 0), [dx0, dy0] = DIRS[(Math.random() * 8) | 0];
      for (let k = 0; k < steps; k++) {
        if (terr(x, y) === GRASS) set(x, y, ROCK, 5.5);
        if (Math.random() < 0.35 && terr(x + 1, y) === GRASS) set(x + 1, y, ROCK, 5.5);
        if (Math.random() < 0.6) { x += dx0; y += dy0; } else { const [dx, dy] = DIRS[(Math.random() * 8) | 0]; x += dx; y += dy; }
      }
    }
    // Forests: clumps plus a few lone trees
    const nF = sc(16 + ((Math.random() * 8) | 0)) + 2;
    for (let f = 0; f < nF; f++) {
      const fx = rand(0, COLS), fy = rand(0, ROWS), fr = rand(1.3, 3.4);
      for (let y = Math.floor(fy - fr); y <= fy + fr; y++) for (let x = Math.floor(fx - fr); x <= fx + fr; x++)
        if (inB(x, y) && terrain[y][x] === GRASS && Math.hypot(x - fx, y - fy) < fr && Math.random() < 0.7) set(x, y, TREE, 4.2);
    }
    for (let i = 0, n = sc(70); i < n; i++) { const x = (Math.random() * COLS) | 0, y = (Math.random() * ROWS) | 0; if (terrain[y][x] === GRASS) set(x, y, TREE, 4.2); }
    // Starting bridges: run each one across any water in its way and keep both landings clear of trees and mountains
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (terrain[y][x] !== BRIDGE) continue;
      const dir = bridgeDir[y][x], [dx, dy] = dir === 'v' ? [0, 1] : [1, 0];
      for (const s of [-1, 1]) {
        let ex = x + dx * s, ey = y + dy * s;
        while (inB(ex, ey) && (terrain[ey][ex] === WATER || terrain[ey][ex] === BRIDGE)) {
          if (terrain[ey][ex] === WATER) { terrain[ey][ex] = BRIDGE; bridgeDir[ey][ex] = dir; }
          ex += dx * s; ey += dy * s;
        }
        if (inB(ex, ey) && terrain[ey][ex] !== GRASS) terrain[ey][ex] = GRASS;
      }
    }
    // Validate: most of the border must be able to reach the core, so enemies come from all sides
    const seen = new Uint8Array(COLS * ROWS), q = [CY * COLS + CX]; seen[q[0]] = 1;
    for (let h = 0; h < q.length; h++) {
      const i = q[h], ux = i % COLS, uy = (i / COLS) | 0;
      for (const [dx, dy] of DIRS.slice(0, 4)) { const vx = ux + dx, vy = uy + dy, j = vy * COLS + vx;
        if (inB(vx, vy) && !seen[j] && !blockT(vx, vy)) { seen[j] = 1; q.push(j); } }
    }
    let border = 0, ok = 0, sides = [0, 0, 0, 0];
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (x && y && x < COLS - 1 && y < ROWS - 1) continue;
      border++;
      if (seen[y * COLS + x]) { ok++; if (y === 0) sides[0]++; if (y === ROWS - 1) sides[1]++; if (x === 0) sides[2]++; if (x === COLS - 1) sides[3]++; }
    }
    // Wall off unreachable pockets so nothing can get trapped in them
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (!seen[y * COLS + x] && !blockT(x, y)) terrain[y][x] = ROCK;
    if (ok / border > 0.65 && sides.every(n => n >= Math.min(12, Math.round(ROWS / 4)))) break;
  }
  onTerrain();
}

// roster: [{ id, name, hero, color }], one entry per hero; difficulty: a key of DIFFS
function reset(roster, difficulty) {
  grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  genTerrain();
  diffKey = has(DIFFS, difficulty) ? difficulty : 'normal'; diff = DIFFS[diffKey];
  core = { hp: diff.core, maxHp: diff.core };
  players = roster.map(r => makePlayer(r.id, r.name, r.hero, r.color));
  for (const p of players) { p.remote = p.id !== me; if (players.length > 1) p.wallet = START_WALLET; }
  departed = {}; pings = []; evenRot = 0;
  bindLocal();
  announces = []; enemies = []; newEnemies = []; soldiers = []; projectiles = []; particles = []; texts = []; blasts = [];
  treasury = diff.gold; wave = 0; phase = 'build'; phaseT = 25; spawnQueue = []; spawnT = 0; waveTheme = nextTheme = 'mixed';
  speedPaused = false; kills = 0; flowDirty = true; lossReason = ''; gridVer++; sentGv = -1; netFx = []; netTer = [];
}
// Start a fresh game: { difficulty, mapSize, roster } (see reset)
function newGame(o) {
  applyMapSize(o.mapSize); reset(o.roster, o.difficulty); computeFlow();
  gameState = 'play';
}

// ---------- Helpers ----------
const isCore = (x, y) => Math.abs(x - CX) <= 1 && Math.abs(y - CY) <= 1;
const inB = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS;
const tileOf = v => Math.floor(v / T);
const d2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
const coreRect = { x: (CX - 1) * T, y: (CY - 1) * T, w: 3 * T, h: 3 * T };
function rectDist(px, py, rx, ry, rw, rh) {
  const cx = Math.max(rx, Math.min(px, rx + rw)), cy = Math.max(ry, Math.min(py, ry + rh));
  return Math.hypot(px - cx, py - cy);
}
const rand = (a, b) => a + Math.random() * (b - a);

// ---------- Flow field (Dijkstra from the core outward) ----------
const DIRS = [[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,1.414],[1,-1,1.414],[-1,1,1.414],[-1,-1,1.414]];
function diagOk(x, y, dx, dy, m = 'ground') {
  if (!dx || !dy) return true;
  return (m === 'dig' || (!grid[y][x + dx] && !grid[y + dy][x])) && !mBlock(m, x + dx, y) && !mBlock(m, x, y + dy);
}
function enterCost(x, y, m = 'ground') {   // ground enemies strongly prefer bridges; Swimmers prefer rivers; Climbers slow down on rock
  if (grid[y][x]) return m === 'dig' ? DIG_COST : WALL_PATH_COST;
  const t = terrain[y][x];
  if (t === WATER) return m === 'swim' ? 1 : 9;
  if (t === ROCK) return 1.7;
  return m === 'swim' ? 2 : 1;
}
let dists = {};
function computeFlow() {
  for (const m of MODES) dists[m] = flowFor(m);
  dist = dists.ground;
  flowDirty = false;
  pathCache.clear();
}
function flowFor(m) {
  const dist = new Float64Array(COLS * ROWS).fill(Infinity);
  const heap = [];
  const push = (d, i) => { heap.push([d, i]); let k = heap.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; } };
  const pop = () => { const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let k = 0;
      for (;;) { const l = 2 * k + 1, r = l + 1; let m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; } }
    return top; };
  for (let y = CY - 1; y <= CY + 1; y++) for (let x = CX - 1; x <= CX + 1; x++) { dist[y * COLS + x] = 0; push(0, y * COLS + x); }
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    const ux = i % COLS, uy = (i / COLS) | 0;
    const c = isCore(ux, uy) ? 0 : enterCost(ux, uy, m);
    for (const [dx, dy, s] of DIRS) {
      const vx = ux + dx, vy = uy + dy;
      if (!inB(vx, vy) || isCore(vx, vy) || mBlock(m, vx, vy)) continue;
      if (!diagOk(vx, vy, -dx, -dy, m)) continue;
      const nd = d + s * Math.max(c, 1);
      const j = vy * COLS + vx;
      if (nd < dist[j]) { dist[j] = nd; push(nd, j); }
    }
  }
  return dist;
}
function nextStep(tx, ty, m = 'ground') {
  let best = null, bd = Infinity;
  const dist = dists[m] || dists.ground;
  for (const [dx, dy, s] of DIRS) {
    const nx = tx + dx, ny = ty + dy;
    if (!inB(nx, ny) || !diagOk(tx, ty, dx, dy, m)) continue;
    const c = dist[ny * COLS + nx] + s * (isCore(nx, ny) ? 1 : enterCost(nx, ny, m));
    if (c < bd) { bd = c; best = [nx, ny]; }
  }
  return best;
}

// ---------- Waves ----------
// Wave themes: a themed wave trades about 60% of its regular troops (by gold value, so the total threat stays similar)
// for its own enemy types. `from`: first wave the theme can appear. 'mixed' is the classic everything-at-once wave.
const WAVE_THEMES = {
  mixed:    { name: 'Mixed wave',     color: '#ffffff', from: 1, types: [] },
  grunt:    { name: 'Grunt horde',    color: '#62c24c', from: 3, types: ['grunt'] },
  runner:   { name: 'Runner rush',    color: '#e9e15a', from: 3, types: ['runner'] },
  fish:     { name: 'Fish wave',      color: '#3fb6a8', from: 4, types: ['swimmer'], water: true },
  sky:      { name: 'Sky raid',       color: '#ff7ab8', from: 4, types: ['flyer'] },
  splitter: { name: 'Splitter swarm', color: '#ff9a3c', from: 4, types: ['splitter', 'splitter', 'bigsplitter'] },
  brute:    { name: 'Brute squad',    color: '#9b59b6', from: 5, types: ['brute'] },
  climber:  { name: 'Mountain climbers', color: '#a8865a', from: 6, types: ['climber'] },
  digger:   { name: 'Burrower wave',  color: '#8a6a52', from: 7, types: ['digger'] },
  chaos:    { name: 'Chaos wave',     color: '#ff6060', from: 8, types: ['runner', 'brute', 'flyer', 'swimmer', 'climber', 'digger', 'splitter'] },
};
const THEME_SHARE = 0.6;
const hasWater = () => terrain.some(row => row.includes(1));
// Waves 1–2 are always mixed; after that about 1 in 3 waves is mixed, and the same theme never comes twice in a row
function pickTheme(n, prev) {
  if (n < 3 || Math.random() < 0.33) return 'mixed';
  const opts = Object.keys(WAVE_THEMES).filter(k => k !== 'mixed' && k !== prev && WAVE_THEMES[k].from <= n && (!WAVE_THEMES[k].water || hasWater()));
  return opts.length ? opts[(Math.random() * opts.length) | 0] : 'mixed';
}
function applyTheme(q, key, n) {
  const th = WAVE_THEMES[key];
  if (!th || !th.types.length) return q;
  const types = th.types.filter(t => t !== 'bigsplitter' || n >= 7);
  const keep = [], swap = [];
  for (const t of q) (t === 'boss' || t === 'siege' || Math.random() >= THEME_SHARE ? keep : swap).push(t);
  let budget = swap.reduce((s, t) => s + ETYPES[t].gold, 0);
  for (let i = 0; budget > 0; i++) { const t = types[i % types.length]; keep.push(t); budget -= ETYPES[t].gold; }
  return keep;
}
function startWave() {
  wave++; phase = 'wave';
  waveTheme = nextTheme || 'mixed'; nextTheme = pickTheme(wave + 1, waveTheme);
  const n = wave;
  let q = [];
  for (let i = 0; i < 5 + n * 2; i++) q.push('grunt');
  if (n >= 2) for (let i = 0; i < n; i++) q.push('runner');
  if (n >= 3) for (let i = 0; i < Math.floor(n / 2); i++) q.push('flyer');
  if (n >= 4) for (let i = 0; i < Math.floor(n / 2); i++) q.push('brute');
  if (n >= 3) for (let i = 0; i < Math.floor((n - 1) / 2); i++) q.push('splitter');
  if (n >= 4) for (let i = 0; i < Math.floor(n / 2); i++) q.push('swimmer');
  if (n >= 5) for (let i = 0; i < Math.floor((n - 1) / 2); i++) q.push('climber');
  if (n >= 6) for (let i = 0; i < Math.floor((n - 3) / 2); i++) q.push('digger');
  if (n >= 7) for (let i = 0; i < Math.floor((n - 4) / 3); i++) q.push('bigsplitter');
  if (n % 5 === 0) for (let i = 0; i < n / 5; i++) q.push('boss');
  if (n >= 6 && (n - 6) % 5 === 0) for (let i = 0; i < 1 + Math.floor((n - 6) / 10); i++) q.push('siege');
  q = applyTheme(q, waveTheme, n);
  // More heroes, more monsters: +50% of the regular troops per extra player (bosses stay as they are, but get tougher)
  const np = players.length;
  if (np > 1) {
    const regular = q.filter(t => t !== 'boss' && t !== 'siege'), extra = Math.round(regular.length * 0.5 * (np - 1));
    for (let i = 0; i < extra; i++) q.push(regular[(Math.random() * regular.length) | 0]);
  }
  for (let i = q.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [q[i], q[j]] = [q[j], q[i]]; }
  spawnQueue = q; spawnT = 0;
  for (const p of players) p.ready = false;
  announce(`WAVE ${wave}`, '#fff', 28, 2);
  if (waveTheme !== 'mixed') announce(WAVE_THEMES[waveTheme].name.toUpperCase() + '!', WAVE_THEMES[waveTheme].color, 22, 2.5);
}
const coopHp = () => 1 + 0.35 * Math.max(0, players.length - 1);
function spawnEnemy(type) {
  const def = ETYPES[type];
  let tx, ty;
  for (let tries = 0; tries < 200; tries++) {
    const side = (Math.random() * 4) | 0;
    if (side === 0) { tx = (Math.random() * COLS) | 0; ty = 0; }
    else if (side === 1) { tx = (Math.random() * COLS) | 0; ty = ROWS - 1; }
    else if (side === 2) { tx = 0; ty = (Math.random() * ROWS) | 0; }
    else { tx = COLS - 1; ty = (Math.random() * ROWS) | 0; }
    const m = modeOf(def);
    if (def.fly || (!mBlock(m, tx, ty) && isFinite(dists[m][ty * COLS + tx]))) break;
  }
  const mult = 1 + 0.2 * (wave - 1) + 0.01 * wave * wave;
  enemies.push(makeEnemy(type, tx * T + T / 2, ty * T + T / 2, mult));
  if (def.siege) announce('A SIEGE GOLEM APPROACHES!', '#ff9a6a', 24, 3);
}
function makeEnemy(type, x, y, mult) {
  const def = ETYPES[type];
  const hp = def.hp * mult * diff.hp * coopHp();
  return { id: ++uid, type, ...def, x, y, mult, hp, maxHp: hp,
           dmg: def.dmg * diff.dmg, shellDmg: (def.shellDmg || 0) * diff.dmg,
           atk: 0, slowT: 0, dead: false, face: 0, wob: Math.random() * 6, shootT: 1.5, aim: 0, recoil: 0 };
}

// ---------- Effects ----------
// The host also queues each effect so clients can replay it (see netFx)
function burst(x, y, color, n = 10, sp = 120) {
  if (fxOut) netFx.push(['b', Math.round(x), Math.round(y), color, n, sp]);
  if (headless) return;
  for (let i = 0; i < n; i++) { const a = Math.random() * 6.28, v = rand(sp * 0.3, sp);
    particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.3, 0.7), max: 0.7, color, s: rand(2, 4) }); }
}
function announce(s, color, size, life) {
  if (fxOut) netFx.push(['a', s, color, size, life]);
  if (!headless) announces.push({ s, color, size, life, max: life });
}
// `to`: only that player sees the text (e.g. their share of a kill); null = everyone
function floatText(x, y, s, color, size = 13, life = 1, to = null) {
  if (fxOut) netFx.push(['t', Math.round(x), Math.round(y), s, color, size, life, to]);
  if (!headless && (to === null || to === me)) texts.push({ x, y, s, color, size, life, max: life });
}
function addBlast(x, y, r) {
  if (fxOut) netFx.push(['x', Math.round(x), Math.round(y), r]);
  if (!headless) blasts.push({ x, y, r, life: 0.45 });
}
// Pings: a marker every player sees in the world and on the minimap
const PING_KINDS = { help: ['Help here!', '#ffd84a'], danger: ['Danger!', '#ff6a5a'] };
function addPing(x, y, kind, pid) {
  const p = pById(pid); if (!p || !has(PING_KINDS, kind)) return;
  if (fxOut) netFx.push(['p', Math.round(x), Math.round(y), kind, p.name, p.color]);
  pings.push({ x, y, kind, name: p.name, color: p.color, t: 4 });
}
// Particles, texts, explosion rings and pings fade the same way on host and clients
function tickFx(dt) {
  for (const b of blasts) b.life -= dt;
  blasts = blasts.filter(b => b.life > 0);
  for (const p of particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; p.life -= dt; }
  particles = particles.filter(p => p.life > 0);
  for (const t of texts) { t.y -= 25 * dt; t.life -= dt; }
  texts = texts.filter(t => t.life > 0);
  for (const p of pings) p.t -= dt;
  pings = pings.filter(p => p.t > 0);
}

// ---------- Combat ----------
// Boss abilities: a telegraphed Ground Slam, summoning minions as it gets hurt, and an enrage below half health.
// The Siege Golem also enrages: it fires faster and lobs three-shell volleys.
const SLAM_R = 2.2 * 32, SLAM_WIND = 1.2;   // a longer wind-up gives more time to get clear
function slamWanted(e) {
  const r = SLAM_R * 0.8;
  if (players.some(h => h.alive && Math.hypot(h.x - e.x, h.y - e.y) < r)) return true;
  if (soldiers.some(u => Math.hypot(u.x - e.x, u.y - e.y) < r)) return true;
  return allBuildings().some(b => rectDist(e.x, e.y, b.tx * T, b.ty * T, T, T) < e.r + 6) ||
         rectDist(e.x, e.y, coreRect.x, coreRect.y, coreRect.w, coreRect.h) < e.r + 6;
}
function bossSlam(e) {
  addBlast(e.x, e.y, SLAM_R); burst(e.x, e.y, '#ff5030', 36, 260); burst(e.x, e.y, '#6a4a30', 18, 160);
  const dmg = e.dmg * (e.rage ? 1.1 : 1);
  for (const h of players) if (h.alive && Math.hypot(h.x - e.x, h.y - e.y) < SLAM_R + h.r) damagePlayer(h, dmg * 0.5);
  for (const u of soldiers) if (Math.hypot(u.x - e.x, u.y - e.y) < SLAM_R + u.r) hurtSoldier(u, dmg);
  for (const b of allBuildings()) if (rectDist(e.x, e.y, b.tx * T, b.ty * T, T, T) < SLAM_R) damageBuilding(b, dmg * 1.25);
  if (rectDist(e.x, e.y, coreRect.x, coreRect.y, coreRect.w, coreRect.h) < SLAM_R) damageCore(dmg * 0.6);
}
function bossSummon(e) {
  const pack = ['grunt', 'grunt', 'runner'];
  pack.forEach((t, i) => {
    const a = (i / pack.length) * 6.28 + Math.random() * 0.6, d = e.r + 10;
    const c = makeEnemy(t, e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, e.mult);
    c.face = a; newEnemies.push(c);
  });
  burst(e.x, e.y, '#b02020', 30, 180);
  floatText(e.x, e.y - 30, 'TO ME, MINIONS!', '#ff8070', 14, 1.2);
}
function tickBoss(e, dt) {
  if (!e.rage && e.hp < e.maxHp * 0.35) {
    e.rage = 1; e.speed *= 1.25; e.rate *= 0.8;
    announce('THE BOSS IS ENRAGED!', '#ff5040', 24, 2.5); burst(e.x, e.y, '#ff3020', 40, 240);
  }
  e.sumN = e.sumN || 0;
  while (e.sumN < 2 && e.hp < e.maxHp * (e.sumN ? 0.3 : 0.6)) { e.sumN++; bossSummon(e); }
  e.slamCd = (e.slamCd === undefined ? 3 : e.slamCd) - dt;
  if (e.wind > 0) { e.wind -= dt; if (e.wind <= 0) { e.wind = 0; bossSlam(e); } return true; }   // rooted while winding up
  if (e.slamCd <= 0 && slamWanted(e)) { e.wind = SLAM_WIND; e.slamCd = e.rage ? 6 : 9; return true; }
  return false;
}
// Siege Golem target: towers first, walls only if nothing better, the core when it's in range
function siegeTarget(e) {
  const range = e.range * T;
  let best = null, bs = Infinity;
  for (const b of allBuildings()) {
    const d = rectDist(e.x, e.y, b.tx * T, b.ty * T, T, T);
    if (d > range) continue;
    const sc = d + (b.type === 'wall' ? 4 * T : 0);
    if (sc < bs) { bs = sc; best = [b.tx * T + T / 2, b.ty * T + T / 2]; }
  }
  if (best) return best;
  if (rectDist(e.x, e.y, coreRect.x, coreRect.y, coreRect.w, coreRect.h) < range)
    return [Math.max(coreRect.x + 8, Math.min(e.x, coreRect.x + coreRect.w - 8)), Math.max(coreRect.y + 8, Math.min(e.y, coreRect.y + coreRect.h - 8))];
  return null;
}
function siegeImpact(p) {
  burst(p.tx, p.ty, '#ff7a3a', 26, 200); burst(p.tx, p.ty, '#444', 10, 120);
  for (const b of allBuildings()) {
    const d = rectDist(p.tx, p.ty, b.tx * T, b.ty * T, T, T);
    if (d < p.splash) damageBuilding(b, p.dmg * (d === 0 ? 1 : 0.4));
  }
  const cd = rectDist(p.tx, p.ty, coreRect.x, coreRect.y, coreRect.w, coreRect.h);
  if (cd < p.splash) damageCore(p.dmg * (cd === 0 ? 1 : 0.4));
  for (const u of soldiers) if (Math.hypot(u.x - p.tx, u.y - p.ty) < p.splash + u.r) hurtSoldier(u, p.dmg * 0.5);
  for (const h of players) if (h.alive && Math.hypot(h.x - p.tx, h.y - p.ty) < p.splash + h.r) damagePlayer(h, p.dmg * 0.4);
}
// src: the id of the hero who dealt the damage, or null for towers, soldiers and everything else (that share goes to the treasury)
// eng: for tower damage, the Engineer standing next to that tower; he is credited a share of it (engCut) (key 'g<id>': gold only, no kill or damage stats)
function hurt(e, dmg, src = null, eng = null) {
  if (e.dead) return;
  if (e.swim && waterAt(e.x, e.y)) dmg *= SUBMERGED;
  const credit = Math.min(dmg, Math.max(0, e.hp)), key = src === null ? 't' : String(src);   // overkill earns nothing
  if (!e.dmgBy) e.dmgBy = {};
  if (src === null && eng !== null) {
    const g = 'g' + eng, cut = credit * engCut(pById(eng));
    e.dmgBy[g] = (e.dmgBy[g] || 0) + cut; e.dmgBy.t = (e.dmgBy.t || 0) + credit - cut;
  } else e.dmgBy[key] = (e.dmgBy[key] || 0) + credit;
  if (src !== null) { const h = pById(src); if (h) h.stats.dmg += credit; }
  e.hp -= dmg; e.hitT = 0.09;
  if (e.hp <= 0) {
    e.dead = true; kills++;
    payBounty(e);
    burst(e.x, e.y, e.color, e.type === 'boss' || e.type === 'bigsplitter' ? 40 : 12);
    if (e.split) {
      // Burst into a swarm of small enemies, scattered around the corpse
      for (let i = 0; i < e.split; i++) {
        const a = (i / e.split) * 6.28 + Math.random() * 0.5, d = rand(4, e.r + 6);
        const c = makeEnemy(e.splitInto || 'splitling', e.x + Math.cos(a) * d, e.y + Math.sin(a) * d, e.mult);
        c.face = a; c.slowT = e.slowT;
        newEnemies.push(c);
      }
      burst(e.x, e.y, '#ffd0a0', 24, 200);
      floatText(e.x, e.y - 22, 'SPLIT!', '#ffb866', 13, 0.9);
    }
  }
}
// A kill's gold is split by how much damage each source dealt (largest-remainder rounding keeps the total exact).
// Heroes' shares go to their wallets; the towers-and-soldiers share goes to the treasury.
function payBounty(e) {
  const by = e.dmgBy || { t: 1 }, ks = Object.keys(by), tot = ks.reduce((s, k) => s + by[k], 0) || 1;
  const shares = ks.map(k => { const exact = e.gold * by[k] / tot; return { k, exact, n: Math.floor(exact) }; });
  let rem = e.gold - shares.reduce((s, x) => s + x.n, 0);
  shares.slice().sort((a, b) => (b.exact - b.n) - (a.exact - a.n)).forEach(s => { if (rem > 0) { s.n++; rem--; } });
  let top = null, topD = 0, toTreasury = 0;
  for (const s of shares) {
    const eng = s.k[0] === 'g', h = s.k === 't' ? null : pById(+(eng ? s.k.slice(1) : s.k));
    if (h && !eng && by[s.k] > topD) { topD = by[s.k]; top = h; }
    if (!s.n) continue;
    if (h) { earn(h, s.n); floatText(e.x, e.y - 10, '+' + s.n, '#ffd84a', 12, 0.8, h.id); }
    else toTreasury += s.n;                       // towers, soldiers, or a hero who has since left
  }
  if (toTreasury) { treasury += toTreasury; floatText(e.x, e.y - (coop() ? 22 : 10), '+' + toTreasury, coop() ? '#d9c690' : '#ffd84a', coop() ? 11 : 12, 0.8); }
  if (top) top.stats.kills++;
}
function nearestEnemy(x, y, range, airOk = true, groundOk = true) {
  let best = null, bd = range * range;
  for (const e of enemies) {
    if (untouchable(e) || (e.fly && !airOk) || (!e.fly && !groundOk)) continue;
    const dd = d2(x, y, e.x, e.y);
    if (dd < bd) { bd = dd; best = e; }
  }
  return best;
}
function damageBuilding(b, dmg) {
  b.hp -= dmg; b.flash = 0.1;
  if (b.hp <= 0 && grid[b.ty][b.tx] === b) {
    grid[b.ty][b.tx] = null; flowDirty = true; gridVer++;
    burst(b.tx * T + T / 2, b.ty * T + T / 2, DEFS[b.type].color, 18, 160);
  }
}
function damageCore(dmg) {
  core.hp -= dmg; core.flash = 0.15;
  if (core.hp <= 0) { core.hp = 0; burst(CX * T + T / 2, CY * T + T / 2, '#6cf', 80, 300); gameOver('THE CORE HAS FALLEN'); }
}
// A hero at 0 HP is downed: a teammate can revive them, or they respawn at the core after a while.
// The run ends only when every hero is down at once (in single player, that's as soon as you fall).
function damagePlayer(p, dmg) {
  if (!p.alive) return;
  if (p.heroType === 'knight') dmg *= 1 - ARMOR_PER * (p.heroUp.armor || 0);
  p.hp -= dmg; p.lastHit = 0; p.flash = 0.12;
  if (p.hp <= 0) {
    p.hp = 0; p.alive = false; p.work = null; p.reviveT = 0; p.respawnT = 8 + wave; p.moving = false;
    burst(p.x, p.y, p.color, 40, 220);
    if (players.every(q => !q.alive)) gameOver(players.length > 1 ? 'ALL HEROES HAVE FALLEN' : 'YOU HAVE FALLEN');
    else announce(`${p.name} is down! Stand next to them to revive`, '#ffb0a0', 18, 2.5);
  }
}
function revive(q, helper) {
  Object.assign(q, { alive: true, hp: Math.ceil(q.maxHp * 0.5), reviveT: 0, lastHit: 99 });
  helper.stats.revives++;
  burst(q.x, q.y, '#9f9', 24, 140);
  floatText(q.x, q.y - 26, `Revived by ${helper.name}`, '#9f9', 13, 1.4);
}
function updateRevives(dt) {
  for (const q of players) {
    if (q.alive) continue;
    const helper = players.find(p => p.alive && Math.hypot(p.x - q.x, p.y - q.y) < REVIVE_REACH);
    if (helper) { q.reviveT += dt; if (q.reviveT >= REVIVE_TIME) revive(q, helper); }
    else q.reviveT = Math.max(0, q.reviveT - dt * 2);
  }
}

// Is a circle of the player's size at (x, y) overlapping a building or the core?
function playerBlocked(x, y) { return bodyBlocked(x, y, player.r); }
function bodyBlocked(x, y, rad) {
  const r = rad - 0.01;
  for (let ty = tileOf(y - r); ty <= tileOf(y + r); ty++)
    for (let tx = tileOf(x - r); tx <= tileOf(x + r); tx++)
      if ((!inB(tx, ty) || grid[ty][tx] || isCore(tx, ty) || blockT(tx, ty)) && rectDist(x, y, tx * T, ty * T, T, T) < r) return true;
  return false;
}

// ---------- Soldiers (mobile allied units from barracks) ----------
function trainMedic(b) {
  for (const [dx, dy] of [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]) {
    const x = (b.tx + dx) * T + T / 2, y = (b.ty + dy) * T + T / 2;
    if (!inB(b.tx + dx, b.ty + dy) || bodyBlocked(x, y, 7)) continue;
    const hp = DEFS.medic.unitHp * (1 + 0.4 * (b.level - 1));
    soldiers.push({ id: ++uid, owner: b.owner, soldier: true, medic: true, home: b, x, y, hx: b.rally ? b.rally[0] : b.tx * T + T / 2, hy: b.rally ? b.rally[1] : b.ty * T + T / 2, r: 7, hp, maxHp: hp, heal: stat(b, 'heal'),
                    speed: 95, face: 1.57, flash: 0, wob: Math.random() * 6, idle: b.rally ? rallySpot(b.rally, 7) : [x, y], fix: null, think: 0 });
    burst(x, y, '#fff', 8, 70);
    return true;
  }
  return false;
}
// Where a replacement unit heads: its squad's rally point, nudged a little so it doesn't stand on top of its squad
function rallySpot(g, r) {
  for (let i = 0; i < 6; i++) { const a = Math.random() * 6.28, d = rand(4, 18), x = g[0] + Math.cos(a) * d, y = g[1] + Math.sin(a) * d;
    if (!bodyBlocked(x, y, r)) return [x, y]; }
  return [g[0], g[1]];
}
function trainSoldier(b) {
  const spots = [[0,1],[1,0],[-1,0],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]];
  for (const [dx, dy] of spots) {
    const x = (b.tx + dx) * T + T / 2, y = (b.ty + dy) * T + T / 2;
    if (!inB(b.tx + dx, b.ty + dy) || bodyBlocked(x, y, 8)) continue;
    const hp = DEFS.barracks.unitHp * (1 + 0.4 * (b.level - 1));
    const g = b.rally || [b.tx * T + T / 2, b.ty * T + T / 2];
    soldiers.push({ id: ++uid, owner: b.owner, soldier: true, home: b, hx: g[0], hy: g[1], marching: !!b.rally, x, y, r: 8, hp, maxHp: hp,
                    dmg: stat(b, 'dmg'), speed: 90, atk: 0, face: 1.57, flash: 0, wob: Math.random() * 6, idle: b.rally ? rallySpot(b.rally, 8) : [x, y] });
    burst(x, y, '#9fe8bf', 8, 70);
    return true;
  }
  return false;
}
function hurtSoldier(u, dmg) {
  u.hp -= dmg; u.flash = 0.1;
  if (u.hp <= 0 && !u.dead) { u.dead = true; burst(u.x, u.y, '#4caf7a', 14, 140); }
}
function moveBody(o, tx, ty, step) {
  const dx = tx - o.x, dy = ty - o.y, l = Math.hypot(dx, dy);
  if (l < 0.5) return;
  if (waterAt(o.x, o.y)) step *= WATER_SLOW;
  const m = Math.min(step, l), nx = o.x + dx / l * m, ny = o.y + dy / l * m;
  if (!bodyBlocked(nx, o.y, o.r)) o.x = nx;
  if (!bodyBlocked(o.x, ny, o.r)) o.y = ny;
  o.face = Math.atan2(dy, dx);
}
// Soldier pathfinding: BFS distance field toward a goal tile, cached until buildings change
const pathCache = new Map();
const walkable = (x, y) => inB(x, y) && !grid[y][x] && !isCore(x, y) && !blockT(x, y);
function soldierField(gx, gy) {
  const key = gy * COLS + gx;
  if (pathCache.has(key)) return pathCache.get(key);
  if (pathCache.size > 400) pathCache.clear(); // keep memory bounded on the big map
  const f = new Float64Array(COLS * ROWS).fill(Infinity), q = [key];
  f[key] = 0;
  for (let h = 0; h < q.length; h++) {
    const i = q[h], ux = i % COLS, uy = (i / COLS) | 0;
    for (const [dx, dy, c] of DIRS) {
      const vx = ux + dx, vy = uy + dy, j = vy * COLS + vx;
      if (!walkable(vx, vy) || !diagOk(ux, uy, dx, dy) || f[j] <= f[i] + c) continue;
      f[j] = f[i] + c; q.push(j);
    }
  }
  pathCache.set(key, f);
  return f;
}
function soldierStep(u, gx, gy, step) {
  const gtx = tileOf(gx), gty = tileOf(gy), tx = tileOf(u.x), ty = tileOf(u.y);
  if ((Math.abs(gtx - tx) <= 1 && Math.abs(gty - ty) <= 1) || !inB(gtx, gty)) return moveBody(u, gx, gy, step);
  const f = soldierField(gtx, gty);
  let best = null, bd = f[ty * COLS + tx];
  for (const [dx, dy, c] of DIRS) {
    const nx = tx + dx, ny = ty + dy;
    if (!walkable(nx, ny) || !diagOk(tx, ty, dx, dy)) continue;
    if (f[ny * COLS + nx] + c * 0.001 < bd) { bd = f[ny * COLS + nx]; best = [nx, ny]; }
  }
  if (best) moveBody(u, best[0] * T + T / 2, best[1] * T + T / 2, step);
  else moveBody(u, gx, gy, step); // no route: push straight toward it
}
// Send soldiers (all of the player's own, or one barracks' squad) to guard a point. pid: the player giving the order.
// In co-op you can only sell buildings you built (or ones whose builder has left the game); any player can move a squad.
const commandable = (b, pid) => b.owner === pid || b.owner == null || !pById(b.owner);
function orderSoldiers(x, y, barracks, pid = me) {
  // A specific building (barracks or medic tent) moves its own units; F / minimap orders move soldiers only
  const list = barracks ? soldiers.filter(u => u.home === barracks) : soldiers.filter(u => !u.medic && (u.owner === pid || u.owner == null || !pById(u.owner)));
  // Remember the spot on every barracks whose squad moved, so replacements trained after a death march there too
  const homes = new Set(barracks ? [barracks] : allBuildings().filter(b => b.type === 'barracks' && commandable(b, pid)));
  for (const u of list) if (u.home && grid[u.home.ty][u.home.tx] === u.home) homes.add(u.home);
  for (const b of homes) b.rally = [x, y];
  gridVer++;
  list.forEach((u, i) => {
    const a = i * 2.4, rr = i ? 10 + 4 * Math.sqrt(i) : 0;      // spread the squad out a bit
    u.hx = x; u.hy = y; u.idle = [x + Math.cos(a) * rr, y + Math.sin(a) * rr]; u.marching = true;
  });
  const what = barracks && barracks.type === 'medic' ? 'medic' : 'soldier';
  floatText(x, y - 18, list.length ? `${list.length} ${what}${list.length > 1 ? 's' : ''} moving` : (what === 'medic' ? 'Work area set' : 'Rally point set'), '#9fe8bf', 12, 1, pid);
}
function allBuildings() { const out = []; for (const row of grid) for (const b of row) if (b) out.push(b); return out; }

// ---------- Medics: wander to whatever is hurt and fix it ----------
// A repair target is a building, the core, or a unit (soldier / hero).
const HEAL_REACH = 1.8 * T; // medics heal with a short-range beam
// Best spot to stand when fixing something occupying rect (rx, ry, rw, rh): a walkable tile within
// beam reach, preferring the one the medic can walk to fastest.
function fixSpot(u, rx, ry, rw, rh) {
  const field = soldierField(tileOf(u.x), tileOf(u.y)); // BFS from the medic = walking distance to every tile
  let best = null, bd = Infinity, fallback = null, fd = Infinity;
  for (let y = tileOf(ry) - 2; y <= tileOf(ry + rh - 1) + 2; y++)
    for (let x = tileOf(rx) - 2; x <= tileOf(rx + rw - 1) + 2; x++) {
      if (!walkable(x, y)) continue;
      const px = x * T + T / 2, py = y * T + T / 2;
      if (rectDist(px, py, rx, ry, rw, rh) > 1.55 * T) continue;
      const wd = field[y * COLS + x], ed = d2(u.x, u.y, px, py);
      if (wd < bd) { bd = wd; best = [px, py]; }
      if (ed < fd) { fd = ed; fallback = [px, py]; }
    }
  return best || fallback;
}
// A repair target is a building, the core, or a unit (soldier / hero).
function fixInfo(t) {
  if (t === core || t.tx !== undefined) {
    const r = t === core ? coreRect : { x: t.tx * T, y: t.ty * T, w: T, h: T };
    return { frac: t.hp / t.maxHp, ok: t === core ? core.hp > 0 : grid[t.ty][t.tx] === t,
      reach: (u) => rectDist(u.x, u.y, r.x, r.y, r.w, r.h) < HEAL_REACH,
      goal: (u) => fixSpot(u, r.x, r.y, r.w, r.h),
      center: [r.x + r.w / 2, r.y + r.h / 2] };
  }
  return { frac: t.hp / t.maxHp, ok: t.isHero ? t.alive : !t.dead,
    reach: (u) => Math.hypot(u.x - t.x, u.y - t.y) < t.r + HEAL_REACH * 0.8, goal: () => [t.x, t.y], center: [t.x, t.y] };
}
function healAmount(t, amt) {
  if (t === core) core.hp = Math.min(core.maxHp, core.hp + amt * 0.4);
  else t.hp = Math.min(t.maxHp, t.hp + amt);
}
const MEDIC_AREA = 7 * T; // medics only work within this distance of their tent
// Is a repair target inside this medic's work area around its tent?
function inMedicArea(u, t) {
  if (t === core) return rectDist(u.hx, u.hy, coreRect.x, coreRect.y, coreRect.w, coreRect.h) <= MEDIC_AREA;
  if (t.tx !== undefined) return rectDist(u.hx, u.hy, t.tx * T, t.ty * T, T, T) <= MEDIC_AREA;
  return Math.hypot(t.x - u.hx, t.y - u.hy) <= MEDIC_AREA;
}
function updateMedic(u, dt) {
  u.think -= dt;
  if (u.fix && (!fixInfo(u.fix).ok || fixInfo(u.fix).frac >= 1 || !inMedicArea(u, u.fix))) u.fix = null;
  if (u.think <= 0) {
    u.think = 0.5;
    // Score candidates: closer and more damaged is better; avoid what another medic is already fixing
    const cands = [core, ...allBuildings(), ...soldiers.filter(o => o !== u && !o.dead)];
    for (const h of players) if (h.alive) cands.push(h);
    let best = null, bs = Infinity;
    for (const t of cands) {
      const info = fixInfo(t);
      if (!info.ok || info.frac >= 0.98 || !inMedicArea(u, t)) continue;
      const g = info.goal(u);
      if (!g) continue; // nowhere to stand in reach of it
      const [gx, gy] = g;
      let sc = Math.hypot(gx - u.x, gy - u.y) / T + info.frac * 18;
      if (t === core || t.isHero) sc -= 4;
      if (soldiers.some(o => o.medic && o !== u && o.fix === t)) sc += 10;
      if (t === u.fix) sc -= 2; // stick with the current job
      if (sc < bs) { bs = sc; best = t; }
    }
    u.fix = best;
  }
  u.beam = null;
  if (u.fix) {
    const info = fixInfo(u.fix);
    if (info.reach(u)) {
      healAmount(u.fix, u.heal * dt);
      u.beam = u.fix === core
        ? [Math.max(coreRect.x, Math.min(u.x, coreRect.x + coreRect.w)), Math.max(coreRect.y, Math.min(u.y, coreRect.y + coreRect.h))]
        : info.center;
      u.face = Math.atan2(u.beam[1] - u.y, u.beam[0] - u.x);
      if (!headless && Math.random() < dt * 8) particles.push({ x: u.beam[0] + rand(-8, 8), y: u.beam[1] + rand(-8, 8), vx: 0, vy: -35, life: 0.5, max: 0.5, color: '#7f7', s: 3 });
    } else { const g = info.goal(u); if (g) soldierStep(u, g[0], g[1], u.speed * dt); else u.fix = null; }
  } else {
    // Nothing to fix: potter about near the tent
    if (!u.idle || Math.random() < dt * 0.25) {
      const ix = u.hx + rand(-1.6, 1.6) * T, iy = u.hy + rand(-1.6, 1.6) * T;
      if (!bodyBlocked(ix, iy, u.r)) u.idle = [ix, iy];
    }
    const far = Math.hypot(u.x - u.hx, u.y - u.hy) > 2.5 * T; // hurry to a newly ordered work spot
    if (u.idle) soldierStep(u, u.idle[0], u.idle[1], u.speed * (far ? 1 : 0.4) * dt);
  }
  u.hp = Math.min(u.maxHp, u.hp + 2 * dt);
}

function updateSoldiers(dt) {
  const LEASH = 6 * T;
  for (const u of soldiers) {
    if (u.dead) continue;
    u.atk -= dt; u.flash = Math.max(0, u.flash - dt); u.wob += dt * 8;
    if (u.home && grid[u.home.ty][u.home.tx] !== u.home) u.home = null; // barracks destroyed: keep guarding the spot
    if (u.medic) { updateMedic(u, dt); continue; }
    // Pick the nearest ground enemy that is close to us and not too far from home
    // While marching to an ordered spot, only fight what's right in the way
    if (u.marching && d2(u.x, u.y, u.hx, u.hy) < (T * 1.2) ** 2) u.marching = false;
    let tgt = null, bd = Infinity;
    for (const e of enemies) {
      if (untouchable(e) || e.fly) continue;
      if (u.marching ? d2(e.x, e.y, u.x, u.y) > (u.r + e.r + 6) ** 2 : d2(e.x, e.y, u.hx, u.hy) > LEASH * LEASH) continue;
      const dd = d2(e.x, e.y, u.x, u.y);
      if (dd < bd) { bd = dd; tgt = e; }
    }
    if (tgt) {
      const reach = u.r + tgt.r + 3;
      if (Math.sqrt(bd) <= reach) {
        u.face = Math.atan2(tgt.y - u.y, tgt.x - u.x);
        if (u.atk <= 0) { u.atk = 0.7; u.lunge = 0.12; hurt(tgt, u.dmg, null, towerEngineer(u.x, u.y)); burst(tgt.x, tgt.y, '#fff', 3, 50); }
      } else soldierStep(u, tgt.x, tgt.y, u.speed * dt);
    } else {
      // Wander back to a guard spot near home and heal slowly
      if (!u.marching && Math.random() < dt * 0.3) {
        const ix = u.hx + rand(-1.2, 1.2) * T, iy = u.hy + rand(-1.2, 1.2) * T;
        if (!bodyBlocked(ix, iy, u.r)) u.idle = [ix, iy];
      }
      soldierStep(u, u.idle[0], u.idle[1], u.speed * (u.marching ? 1 : 0.5) * dt);
      u.hp = Math.min(u.maxHp, u.hp + 5 * dt);
    }
    if (u.lunge) u.lunge = Math.max(0, u.lunge - dt);
  }
  // Bodies don't overlap: soldiers vs enemies, soldiers vs each other, soldiers vs hero
  const bodies = enemies.filter(e => !e.fly && !untouchable(e));
  for (const u of soldiers) {
    if (u.dead) continue;
    for (const o of bodies.concat(soldiers, players.filter(h => h.alive))) {
      if (o === u || o.dead) continue;
      const dx = u.x - o.x, dy = u.y - o.y, rr = u.r + o.r, dd = dx * dx + dy * dy;
      if (dd >= rr * rr || dd < 0.01) continue;
      const l = Math.sqrt(dd), push = rr - l, ux = dx / l, uy = dy / l;
      const share = o.isHero ? 1 : 0.5; // heroes shove soldiers aside
      const nx = u.x + ux * push * share, ny = u.y + uy * push * share;
      if (!bodyBlocked(nx, u.y, u.r)) u.x = nx;
      if (!bodyBlocked(u.x, ny, u.r)) u.y = ny;
      if (!o.isHero && !o.soldier) { o.x -= ux * push * 0.5; o.y -= uy * push * 0.5; }
    }
  }
  soldiers = soldiers.filter(u => !u.dead);
}

// ---------- Building ----------
const stat = (b, k) => {
  const v = DEFS[b.type][k];
  if (k === 'dmg' || k === 'income' || k === 'heal') return v * (1 + 0.6 * (b.level - 1));
  if (k === 'range') return v + 0.5 * (b.level - 1);
  if (k === 'interval' && b.type !== 'mine') return v * (1 - 0.1 * (b.level - 1));
  return v;
};
const maxLevel = b => DEFS[b.type].maxLevel || 3;   // most buildings stop at level 3; Barracks go to 5
const upgradeCost = b => Math.round(DEFS[b.type].cost * 0.8 * b.level);
// All terrain edits go through here so the host can forward them to clients
function setTerrain(x, y, v, dir = null) {
  terrain[y][x] = v; bridgeDir[y][x] = dir;
  if (fxOut) netTer.push([x, y, v, dir]);
}
// Which way a new bridge on (tx, ty) would run: across the river ('v' = north–south, 'h' = east–west)
function bridgeDirFor(tx, ty) {
  const wetT = (x, y) => terr(x, y) === WATER || terr(x, y) === BRIDGE;
  return (wetT(tx - 1, ty) || wetT(tx + 1, ty)) && !(wetT(tx, ty - 1) || wetT(tx, ty + 1)) ? 'v'
       : (wetT(tx, ty - 1) || wetT(tx, ty + 1)) && !(wetT(tx - 1, ty) || wetT(tx + 1, ty)) ? 'h'
       : (bridgeDir[ty][tx - 1] || bridgeDir[ty][tx + 1] || bridgeDir[ty - 1]?.[tx] || bridgeDir[ty + 1]?.[tx] || 'v');
}
// A bridge always spans the whole river, bank to bank. bridgeSpan walks the axis both ways from (tx, ty) and returns the
// water tiles to cover, or null if either end would not land directly on open ground (trees, mountains, map edge).
const MAX_BRIDGE = 6;
function bridgeSpan(tx, ty, dir) {
  const [dx, dy] = dir === 'v' ? [0, 1] : [1, 0], tiles = [[tx, ty]];
  for (const s of [-1, 1]) {
    let x = tx + dx * s, y = ty + dy * s;
    while (inB(x, y) && (terrain[y][x] === WATER || terrain[y][x] === BRIDGE)) {
      if (terrain[y][x] === WATER) tiles.push([x, y]);
      if (tiles.length > MAX_BRIDGE) return null;
      x += dx * s; y += dy * s;
    }
    if (!inB(x, y) || terrain[y][x] !== GRASS) return null;
  }
  return tiles;
}
// The crossing a bridge placed on (tx, ty) would build: the shorter valid span, preferring the usual direction on a tie
function bridgePlan(tx, ty) {
  if (!inB(tx, ty) || terrain[ty][tx] !== WATER) return null;
  const pref = bridgeDirFor(tx, ty);
  let best = null;
  for (const dir of [pref, pref === 'v' ? 'h' : 'v']) {
    const tiles = bridgeSpan(tx, ty, dir);
    if (tiles && (!best || tiles.length < best.tiles.length)) best = { dir, tiles, cost: tiles.length * DEFS.bridge.cost };
  }
  return best;
}
// true when no tree or mountain tile sits on the straight line from the hero to the tile (the tile itself excluded)
function clearLine(tx, ty) {
  const ex = tx * T + T / 2, ey = ty * T + T / 2, n = Math.ceil(Math.hypot(ex - player.x, ey - player.y) / (T / 4));
  for (let i = 0; i <= n; i++) {
    const cx = tileOf(player.x + (ex - player.x) * i / n), cy = tileOf(player.y + (ey - player.y) * i / n);
    if ((cx !== tx || cy !== ty) && inB(cx, cy) && (terrain[cy][cx] === TREE || terrain[cy][cx] === ROCK)) return false;
  }
  return true;
}
function canPlace(tx, ty, type) {
  if (!inB(tx, ty) || tx === 0 || ty === 0 || tx === COLS - 1 || ty === ROWS - 1) return false;
  if (isCore(tx, ty) || grid[ty][tx] || !player.alive) return false;
  if (terrain[ty][tx] !== (type === 'bridge' ? WATER : GRASS)) return false;
  for (const h of players) if (h.alive && rectDist(h.x, h.y, tx * T, ty * T, T, T) < h.r) return false;   // never build on top of a hero
  if (funds(player) < DEFS[type].cost) return false;
  if (d2(player.x, player.y, tx * T + T / 2, ty * T + T / 2) > BUILD_RANGE ** 2) return false;
  if (!clearLine(tx, ty)) return false;
  if (type === 'bridge') { const plan = bridgePlan(tx, ty); if (!plan || funds(player) < plan.cost) return false; }
  for (const e of enemies) if (!e.fly && !e.dead && tileOf(e.x) === tx && tileOf(e.y) === ty) return false;
  for (const u of soldiers) if (rectDist(u.x, u.y, tx * T, ty * T, T, T) < u.r) return false;
  return true;
}
function place(tx, ty, type) {
  if (!canPlace(tx, ty, type)) return false;
  const def = DEFS[type];
  if (type === 'bridge') {
    // Bridges become part of the terrain and always span the river bank to bank
    const plan = bridgePlan(tx, ty);
    spend(player, plan.cost); player.stats.built++;
    for (const [x, y] of plan.tiles) { setTerrain(x, y, BRIDGE, plan.dir); burst(x * T + T / 2, y * T + T / 2, '#c08a50', 8, 70); }
    if (plan.tiles.length > 1) floatText(tx * T + T / 2, ty * T, `-${plan.cost}`, '#ffd84a', 13, 1, player.id);
    onTerrain(); flowDirty = true;
    return true;
  }
  spend(player, def.cost); player.stats.built++;
  grid[ty][tx] = { type, tx, ty, hp: def.hp, maxHp: def.hp, level: 1, cd: 0.3, flash: 0, spent: def.cost, build: BUILD_TIME, owner: player.id };
  flowDirty = true; gridVer++;
  burst(tx * T + T / 2, ty * T + T / 2, '#fff', 6, 60);
  return true;
}
function treeInReach(tx, ty) {
  return inB(tx, ty) && terrain[ty][tx] === TREE && player.alive &&
         d2(player.x, player.y, tx * T + T / 2, ty * T + T / 2) <= BUILD_RANGE ** 2;
}
function chopTree(tx, ty) {
  if (!treeInReach(tx, ty)) return false;
  setTerrain(tx, ty, GRASS); earn(player, CHOP_GOLD); flowDirty = true; onTerrain();
  burst(tx * T + T / 2, ty * T + T / 2, '#3d8c44', 14, 110); burst(tx * T + T / 2, ty * T + T / 2, '#5a3d22', 6, 80);
  floatText(tx * T + T / 2, ty * T, '+' + CHOP_GOLD, '#ffd84a', 13, 1, player.id);
  return true;
}
function bridgeInReach(tx, ty) {
  return inB(tx, ty) && terrain[ty][tx] === BRIDGE && player.alive &&
         d2(player.x, player.y, tx * T + T / 2, ty * T + T / 2) <= BUILD_RANGE ** 2;
}
function destroyBridge(tx, ty) { // turn a bridge tile back into river (no refund)
  if (!bridgeInReach(tx, ty)) return false;
  setTerrain(tx, ty, WATER); flowDirty = true; onTerrain();
  burst(tx * T + T / 2, ty * T + T / 2, '#8f6236', 12, 110); burst(tx * T + T / 2, ty * T + T / 2, '#9fd3ff', 8, 90);
  return true;
}
// Right-click / X on a tree or bridge starts a timed job; the hero keeps working while it stays in reach
function startWork(tx, ty) {
  const kind = treeInReach(tx, ty) ? 'tree' : bridgeInReach(tx, ty) ? 'bridge' : null;
  if (!kind) return false;
  const w = player.work;
  if (!w || w.tx !== tx || w.ty !== ty) player.work = { kind, tx, ty, t: 0, need: kind === 'tree' ? CHOP_TIME : BRIDGE_TIME };
  return true;
}
// Knight's sword shoves the enemy straight away from the hero; heavy enemies move less
function knockBack(e, p) {
  const dx = e.x - p.x, dy = e.y - p.y, l = Math.hypot(dx, dy) || 1, dist = KNOCK * Math.min(1, 12 / e.r);
  e.kbx = dx / l * dist / KNOCK_T; e.kby = dy / l * dist / KNOCK_T; e.kbT = KNOCK_T;
}
function updateWork(dt, busy) {
  const work = player.work;
  if (!work) return;
  const { kind, tx, ty } = work, cx = tx * T + T / 2, cy = ty * T + T / 2;
  if (!(kind === 'tree' ? treeInReach(tx, ty) : bridgeInReach(tx, ty))) { player.work = null; return; }
  if (!busy) player.aim = Math.atan2(cy - player.y, cx - player.x);
  const before = work.t; work.t += dt * hero.work;
  if (Math.floor(work.t / 0.35) !== Math.floor(before / 0.35))       // chips fly off with each blow
    burst(cx, cy, kind === 'tree' ? '#7a5530' : '#8f6236', 4, 60);
  if (work.t >= work.need) { player.work = null; kind === 'tree' ? chopTree(tx, ty) : destroyBridge(tx, ty); }
}

const ENG_REFUND = 0.9;   // the Engineer salvages 90% of what a building cost (everyone else 50%), scaled by its health
// For the bound player (the seller): cancelling a build refunds it all
function sellValue(b) { return b.build > 0 ? b.spent : Math.floor(b.spent * (heroType === 'engineer' ? ENG_REFUND : 0.5) * (b.hp / b.maxHp)); }
// Anyone can sell any building; the refund goes to the seller's wallet
function sell(b) {
  const refund = sellValue(b);
  player.wallet += refund; grid[b.ty][b.tx] = null; flowDirty = true; gridVer++;
  floatText(b.tx * T + T / 2, b.ty * T, '+' + refund, '#ffd84a', 13, 1, player.id);
}
function upgrade(b) {   // anyone can pay to upgrade anyone's building
  if (b.level >= maxLevel(b) || b.build > 0) return;
  const c = upgradeCost(b);
  if (!spend(player, c)) { floatText(b.tx * T + T / 2, b.ty * T, 'Need ' + c, '#f77', 13, 1, player.id); return; }
  b.spent += c; b.level++; gridVer++;
  b.maxHp = Math.round(DEFS[b.type].hp * (1 + 0.4 * (b.level - 1))); b.hp = b.maxHp;
  burst(b.tx * T + T / 2, b.ty * T + T / 2, '#ffd84a', 14, 100);
  floatText(b.tx * T + T / 2, b.ty * T, 'Level ' + b.level, '#ffd84a');
}

function applyCommand(pid, c) {
  const p = pById(pid);
  if (!p || !c || typeof c !== 'object' || gameState === 'over') return;
  const tile = (x, y) => Number.isInteger(x) && Number.isInteger(y) && inB(x, y) ? { tx: x, ty: y, b: grid[y][x] } : null;
  const at = tile(c.x, c.y), num = v => typeof v === 'number' && Number.isFinite(v);
  bindP(p);
  switch (c.t) {
    case 'place': if (at && has(DEFS, c.k)) place(at.tx, at.ty, c.k); break;
    case 'sell': if (at && at.b) sell(at.b); break;
    case 'up': if (at && at.b) upgrade(at.b); break;
    case 'work': if (at && p.alive) startWork(at.tx, at.ty); break;
    case 'hero': if (has(HERO_UPS, c.k)) buyHero(c.k); break;
    case 'arrow': switchArrow(c.k); break;
    case 'rally': {
      if (!num(c.px) || !num(c.py)) break;
      const rb = tile(c.bx, c.by);
      if (c.bx === undefined) orderSoldiers(c.px, c.py, null, pid);
      else if (rb && rb.b && (rb.b.type === 'barracks' || rb.b.type === 'medic')) orderSoldiers(c.px, c.py, rb.b, pid);
      break;
    }
    case 'ready': toggleReady(p); break;
    case 'give': giveGold(p, c.to); break;
    case 'ping': if (num(c.px) && num(c.py)) addPing(c.px, c.py, c.k, pid); break;
  }
  bindLocal();
}
// SPACE: ready up for the next wave. When every hero is ready it starts early and the unused seconds go to the treasury.
function toggleReady(p) {
  if (phase !== 'build') return;
  p.ready = !p.ready;
  if (players.length > 1) floatText(p.x, p.y - 26, p.ready ? 'Ready!' : 'Not ready', p.ready ? '#9f9' : '#f99', 12, 1);
  checkReady();
}
// Once every hero is ready, the next wave starts early and the unused seconds go to the treasury
function checkReady() {
  if (phase !== 'build' || !players.length || !players.every(q => q.ready)) return;
  const bonus = Math.ceil(phaseT); treasury += bonus;
  if (players.length > 1) announce(`Everyone is ready! +${bonus} gold to the treasury`, '#9f9', 18, 2);
  startWave();
}
const GIFT = 25;
// G gives 25 gold from your wallet to the nearest teammate within 3 tiles; clicking a name in the team list gives to them
function giveGold(p, to) {
  let q = typeof to === 'number' ? pById(to) : null;
  if (to === undefined) {
    let bd = (3 * T) ** 2;
    for (const o of players) if (o !== p && d2(o.x, o.y, p.x, p.y) < bd) { bd = d2(o.x, o.y, p.x, p.y); q = o; }
    if (!q) { floatText(p.x, p.y - 26, players.length > 1 ? 'Stand next to a teammate to give gold' : 'No one to give gold to', '#f99', 12, 1.2, p.id); return; }
  }
  if (!q || q === p) return;
  const amt = Math.min(GIFT, p.wallet);
  if (amt <= 0) { floatText(p.x, p.y - 26, 'Your wallet is empty', '#f99', 12, 1, p.id); return; }
  p.wallet -= amt; q.wallet += amt;
  floatText(p.x, p.y - 26, `-${amt} to ${q.name}`, '#ffd84a', 12, 1.2, p.id);
  floatText(q.x, q.y - 26, `+${amt} from ${p.name}`, '#ffd84a', 12, 1.4, q.id);
}

// Host-side update for one hero; p is also bound as `player` / `hero` / `heroUp`
function updateHero(p, dt) {
  if (!p.alive) {
    p.respawnT -= dt;
    if (p.respawnT <= 0) {
      const [sx, sy] = heroSpawn(p);
      Object.assign(p, { alive: true, hp: p.maxHp, x: sx, y: sy, lastHit: 99, reviveT: 0 });
      burst(p.x, p.y, p.color, 15);
      p.respawned = (p.respawned || 0) + 1;   // tells that hero's browser to jump to the core
    }
    return;
  }
  if (!p.remote && onLocalHero) onLocalHero(p, dt);
  else p.rangeA = Math.max(0, Math.min(1, (p.rangeA || 0) + (p.moving ? 5 : -2.5) * dt));
  p.fireT = Math.max(0, (p.fireT || 0) - dt);
  p.lastHit += dt;
  if (p.lastHit > 3) p.hp = Math.min(p.maxHp, p.hp + 10 * dt);
  // Auto-shoot
  p.cd -= dt; p.dcd = (p.dcd || 0) - dt; p.throwT = Math.max(0, (p.throwT || 0) - dt);
  const hr = heroRange() ** 2, byDist = (a, b) => d2(p.x, p.y, a.x, a.y) - d2(p.x, p.y, b.x, b.y);
  const targets = enemies.filter(e => !untouchable(e) && d2(p.x, p.y, e.x, e.y) < hr).sort(byDist)
    .slice(0, hero.targets + heroUp.multi);
  // Ranger: with fewer enemies in range than arrows, the spare arrows go into the same targets (a full volley into a lone boss)
  if (hero.kind === 'bolt' && targets.length) for (let i = targets.length, n = hero.targets + heroUp.multi; i < n; i++) targets.push(targets[i % targets.length]);
  // Knight's throwing daggers: aimed at enemies beyond sword reach but inside dagger range
  const dr = daggerRange() ** 2;
  const dTargets = hero.dagger ? enemies.filter(e => !untouchable(e) && d2(p.x, p.y, e.x, e.y) < dr && d2(p.x, p.y, e.x, e.y) >= hr)
    .sort(byDist).slice(0, 1 + heroUp.multi) : [];
  if (dTargets.length && p.dcd <= 0) {
    p.dcd = hero.dagger.interval * Math.pow(0.85, heroUp.rate); p.throwT = 0.2;
    for (const tgt of dTargets) projectiles.push({ kind: 'dagger', x: p.x, y: p.y, target: tgt, speed: 480, src: p.id,
      dmg: hero.dagger.dmg * (1 + wave * 0.03) * (1 + 0.4 * heroUp.dmg), spin: Math.random() * 6 });
  }
  const facing = targets[0] || dTargets[0];
  if (facing && hero.kind === 'melee') {   // the Knight has to turn his whole body round, so foes behind him get a moment's freedom
    const d = Math.atan2(Math.sin(Math.atan2(facing.y - p.y, facing.x - p.x) - p.aim), Math.cos(Math.atan2(facing.y - p.y, facing.x - p.x) - p.aim));
    p.aim += Math.sign(d) * Math.min(Math.abs(d), KNIGHT_TURN * dt);
  } else if (facing) p.aim = Math.atan2(facing.y - p.y, facing.x - p.x);
  else if (p.moving) { // no enemy to shoot: turn smoothly to face the way we're walking
    const d = Math.atan2(Math.sin(p.moveAng - p.aim), Math.cos(p.moveAng - p.aim));
    p.aim += Math.sign(d) * Math.min(Math.abs(d), 14 * dt);
  }
  updateWork(dt, !!facing || p.moving);
  const swung = hero.kind === 'melee' ? targets.filter(e => inFront(p, e)) : targets;   // the sword only sweeps the arc in front
  if (swung.length && p.cd <= 0) {
    p.cd = heroInterval(); p.fireT = hero.kind === 'melee' ? swingTime(heroUp.rate) : hero.kind === 'fire' ? 0.3 : hero.kind === 'rivet' ? 0.1 : 0.14;
    for (const tgt of swung) {
      const ox = hero.kind === 'bolt' && swung.length > 1 ? rand(-6, 6) : 0, oy = ox ? rand(-6, 6) : 0;   // a volley fans out a little
      if (hero.kind === 'melee') { hurt(tgt, heroDmg(), p.id); knockBack(tgt, p); burst(tgt.x, tgt.y, '#fff', 5, 90); }
      else if (hero.kind === 'fire') projectiles.push({ kind: 'fireball', x: p.x, y: p.y, target: tgt, speed: 420, dmg: heroDmg(), splash: hero.splash * T, src: p.id });
      else if (hero.kind === 'bolt' && heroUp.arrow) {   // Ranger's frost / fire arrows
        const a = heroUp.arrow;
        if (ARROWS[a].splash) projectiles.push({ kind: 'boombolt', x: p.x + ox, y: p.y + oy, target: tgt, speed: 600, dmg: heroDmg() * ARROWS[a].dmg, splash: ARROWS[a].splash * T, src: p.id });
        else projectiles.push({ kind: a === 1 ? 'icebolt' : 'firebolt', x: p.x + ox, y: p.y + oy, target: tgt, speed: 650, dmg: heroDmg() * ARROWS[a].dmg, full: heroDmg(), fx: a, src: p.id });
      }
      else projectiles.push({ kind: hero.kind === 'rivet' ? 'rivet' : 'bullet', x: p.x + ox, y: p.y + oy, target: tgt, speed: hero.kind === 'rivet' ? 720 : 650, dmg: heroDmg(), src: p.id });
    }
  }
  // Repair nearby buildings & core
  for (let y = tileOf(p.y) - 2; y <= tileOf(p.y) + 2; y++)
    for (let x = tileOf(p.x) - 2; x <= tileOf(p.x) + 2; x++) {
      const b = inB(x, y) && grid[y][x];
      if (b && b.hp < b.maxHp && d2(p.x, p.y, x * T + T / 2, y * T + T / 2) < (2.5 * T) ** 2) {
        b.hp = Math.min(b.maxHp, b.hp + 25 * (heroType === 'engineer' ? engRepair(player) : 1) * dt);
        if (!headless && Math.random() < dt * 6) particles.push({ x: x * T + rand(4, 28), y: y * T + rand(4, 28), vx: 0, vy: -30, life: 0.5, max: 0.5, color: '#7f7', s: 2 });
      }
    }
  if (core.hp < core.maxHp && rectDist(p.x, p.y, coreRect.x, coreRect.y, coreRect.w, coreRect.h) < T * 1.5)
    core.hp = Math.min(core.maxHp, core.hp + 4 * (heroType === 'engineer' ? engRepair(player) : 1) * dt);
  p.beam = null;
  if (heroType === 'engineer') {
    let best = null, bf = 0.98;
    for (const t of [...soldiers, ...players]) {
      if (t === p || (t.isHero ? !t.alive : t.dead) || Math.hypot(t.x - p.x, t.y - p.y) > ENG_HEAL_R + (t.r || 0)) continue;
      const f = t.hp / t.maxHp;
      if (f < bf) { bf = f; best = t; }
    }
    if (best) {
      healAmount(best, engHeal(p) * dt);
      p.beam = [best.x, best.y];
      if (!headless && Math.random() < dt * 8) particles.push({ x: best.x + rand(-8, 8), y: best.y + rand(-8, 8), vx: 0, vy: -35, life: 0.5, max: 0.5, color: '#7f7', s: 3 });
    }
  }
}

// ---------- Update ----------
function update(dt) {
  if (flowDirty) computeFlow();

  // Phase / waves
  if (phase === 'build') {
    phaseT -= dt;
    if (phaseT <= 0) startWave();
  } else {
    spawnT -= dt;
    if (spawnQueue.length && spawnT <= 0) {
      const burstN = Math.min(spawnQueue.length, 1 + Math.floor(wave / 4));
      for (let i = 0; i < burstN; i++) spawnEnemy(spawnQueue.pop());
      spawnT = Math.max(0.35, 1.3 - wave * 0.05);
    }
    if (!spawnQueue.length && !enemies.length) {
      const bonus = 20 + wave * 6;
      treasury += bonus; phase = 'build'; phaseT = 15;
      announce(`Wave ${wave} cleared! +${bonus} gold${coop() ? ' to the treasury' : ''}`, '#9f9', 22, 2.5);
    }
  }

  // Heroes
  for (const p of players) { bindP(p); updateHero(p, dt); }
  updateRevives(dt);
  bindLocal();

  // Enemies
  for (const e of enemies) {
    if (e.dead) continue;
    e.atk -= dt; e.slowT -= dt; e.wob += dt * 8; e.hitT = Math.max(0, (e.hitT || 0) - dt);
    e.ox = e.x; e.oy = e.y;
    if (e.kbT > 0) {   // being shoved by the Knight's sword: slide away, stopping at mountains, trees, buildings and the core
      const st = Math.min(dt, e.kbT); e.kbT -= dt;
      const nx = e.x + e.kbx * st, ny = e.y + e.kby * st, ntx = tileOf(nx), nty = tileOf(ny);
      const ok = e.fly ? inB(ntx, nty) : (ntx === tileOf(e.x) && nty === tileOf(e.y)) || walkable(ntx, nty) ||
                 (e.climb && inB(ntx, nty) && !grid[nty][ntx] && !isCore(ntx, nty) && !mBlock('climb', ntx, nty));
      if (ok) { e.x = nx; e.y = ny; } else e.kbT = 0;
    }
    if (e.dig) {   // Burrower: dives underground next to buildings and pops back up in the open (or to attack, see below)
      const was = !!e.burrow; e.burrow = !e.up && underBuilding(e);
      if (e.burrow !== was) burst(e.x, e.y, '#7a5a3a', e.burrow ? 12 : 16, e.burrow ? 90 : 130);
      if (e.burrow) { e.dirtT = (e.dirtT || 0) - dt; if (e.dirtT <= 0) { e.dirtT = 0.3; burst(e.x, e.y, '#6b4e33', 2, 40); } }
    }
    const tt = e.fly ? GRASS : terr(tileOf(e.x), tileOf(e.y));
    if (tt === WATER && (e.slowT > 0 || e.burnT > 0)) {   // wading or swimming washes off frost and puts out fire
      if (e.burnT > 0) burst(e.x, e.y, '#d8e4ea', 8, 70);
      e.slowT = 0; e.burnT = 0; e.burnN = 0;
    }
    if (e.burnT > 0) {
      const st = Math.min(dt, e.burnT), flash = e.hitT; e.burnT -= dt;
      hurt(e, burnRate(e) * st, e.burnSrc ?? null); e.hitT = flash;   // burning doesn't make the enemy flash every frame
      if (e.dead) continue;
    }
    const sp = e.speed * (e.slowT > 0 ? 0.45 : 1) * (e.burrow ? DIG_SLOW : 1) * (tt === WATER ? (e.swim ? SWIM_FAST : WATER_SLOW) : tt === ROCK ? CLIMB_SLOW : 1) * dt;
    let tx = null, ty = null, attack = null;
    // Who ground enemies get distracted by: a Knight within taunt range pulls every one of them in;
    // otherwise the nearest hero or soldier within 2.5 tiles. Large enemies only bother with a
    // Ranger or Mage they can already hit, so a ranged hero can kite them without dragging them around.
    let foe = null, pd = Infinity, taunted = false;
    if (!e.fly && !e.burrow) {
      for (const h of players) if (h.alive && h.heroType === 'knight') {
        const d = Math.hypot(h.x - e.x, h.y - e.y); if (d < tauntR(h) && d < pd) { pd = d; foe = h; taunted = true; } }
      if (!foe) {
        const big = e.r >= BIG_R;
        for (const h of players) if (h.alive) { const d = Math.hypot(h.x - e.x, h.y - e.y);
          if (d < pd && (!big || d < e.r + h.r + 6)) { pd = d; foe = h; } }
        for (const u of soldiers) { const d = Math.hypot(u.x - e.x, u.y - e.y); if (d < pd) { pd = d; foe = u; } }
      }
    }

    if (e.fly) {
      if (rectDist(e.x, e.y, coreRect.x, coreRect.y, coreRect.w, coreRect.h) < e.r + 2) attack = 'core';
      else { tx = CX * T + T / 2; ty = CY * T + T / 2; }
    } else if (taunted || pd < 2.5 * T) {
      if (pd < e.r + foe.r + 3) attack = foe; else { tx = foe.x; ty = foe.y; }
    } else {
      const cx = tileOf(e.x), cy = tileOf(e.y);
      const here = inB(cx, cy) && grid[cy][cx];
      if (rectDist(e.x, e.y, coreRect.x, coreRect.y, coreRect.w, coreRect.h) < e.r + 2) attack = 'core';
      else if (here && !e.dig) attack = here;
      else {
        const n = nextStep(cx, cy, modeOf(e));
        if (n) {
          const b = !e.dig && grid[n[1]][n[0]];
          if (b && rectDist(e.x, e.y, n[0] * T, n[1] * T, T, T) < e.r + 2) attack = b;
          else { tx = n[0] * T + T / 2; ty = n[1] * T + T / 2; }
        }
      }
    }
    if (e.type === 'boss' && tickBoss(e, dt)) { tx = null; attack = null; }
    if (e.siege && !e.rage && e.hp < e.maxHp * 0.35) {
      e.rage = 1; e.fireRate *= 0.85; announce('THE SIEGE GOLEM OVERHEATS!', '#ff9a6a', 22, 2.5); burst(e.x, e.y, '#ff7a2a', 40, 240);
    }
    if (e.siege) {
      // Plant and bombard the best building in range; only melee if the hero walks right up to it
      e.shootT -= dt; e.recoil = Math.max(0, e.recoil - dt);
      const st = siegeTarget(e);
      if (st) {
        tx = null; if (!(attack && attack.isHero)) attack = null;
        e.aim = Math.atan2(st[1] - e.y, st[0] - e.x);
        if (e.shootT <= 0) {
          e.shootT = e.fireRate; e.recoil = 0.25;
          const mx = e.x + Math.cos(e.aim) * (e.r + 10), my = e.y + Math.sin(e.aim) * (e.r + 10);
          const shot = (sx, sy) => projectiles.push({ kind: 'eshell', x: mx, y: my, sx: mx, sy: my, tx: sx, ty: sy, speed: 210,
                             dmg: e.shellDmg * (1 + 0.1 * (wave - 1)), splash: 0.9 * T, total: Math.hypot(sx - mx, sy - my) });
          shot(st[0], st[1]);
          if (e.rage) {   // overheated: two more shells either side of the target
            const px = -Math.sin(e.aim) * T * 1.2, py = Math.cos(e.aim) * T * 1.2;
            shot(st[0] + px, st[1] + py); shot(st[0] - px, st[1] - py);
          }
          burst(mx, my, '#ffb070', 10, 120);
        }
      } else e.aim = e.face;
    }
    if (tx !== null) {
      const dx = tx - e.x, dy = ty - e.y, l = Math.hypot(dx, dy) || 1;
      e.x += dx / l * Math.min(sp, l); e.y += dy / l * Math.min(sp, l);
      e.face = Math.atan2(dy, dx);
    }
    // A Burrower has to surface to attack (so it can be hit back), and needs a moment to climb out before its first blow.
    // It stays up while it keeps attacking, and goes back under once it moves on.
    if (e.dig) {
      if (attack && !e.up) { e.up = true; e.burrow = false; e.atk = Math.max(e.atk, 0.6); burst(e.x, e.y, '#7a5a3a', 16, 130); }
      else if (!attack && tx !== null) e.up = false;
    }
    if (attack && e.atk <= 0) {
      e.atk = e.rate;
      if (attack === 'core') damageCore(e.dmg);
      else if (attack.isHero) damagePlayer(attack, e.dmg);
      else if (attack.soldier) hurtSoldier(attack, e.dmg);
      else damageBuilding(attack, e.dmg);
      e.lunge = 0.12;
    }
    if (e.lunge) e.lunge = Math.max(0, e.lunge - dt);
  }
  // Separation
  for (let i = 0; i < enemies.length; i++) for (let j = i + 1; j < enemies.length; j++) {
    const a = enemies[i], b = enemies[j];
    if (a.fly !== b.fly || !!a.burrow !== !!b.burrow) continue;
    const dx = b.x - a.x, dy = b.y - a.y, dd = dx * dx + dy * dy, rr = (a.r + b.r) * 0.9;
    if (dd < rr * rr && dd > 0.01) {
      const l = Math.sqrt(dd), push = (rr - l) / 2;
      a.x -= dx / l * push; a.y -= dy / l * push; b.x += dx / l * push; b.y += dy / l * push;
    }
  }

  // Heroes and ground enemies can't overlap: push the enemy, or the hero if the enemy is pinned
  for (const h of players) if (h.alive) for (const e of enemies) {
    if (e.fly || untouchable(e)) continue;
    const dx = e.x - h.x, dy = e.y - h.y, rr = e.r + h.r, dd = dx * dx + dy * dy;
    if (dd >= rr * rr || dd < 0.01) continue;
    const l = Math.sqrt(dd), push = rr - l, ux = dx / l, uy = dy / l;
    e.x += ux * push * 0.7; e.y += uy * push * 0.7;
    const px = h.x - ux * push * 0.3, py = h.y - uy * push * 0.3;
    if (!bodyBlocked(px, h.y, h.r)) h.x = px;
    if (!bodyBlocked(h.x, py, h.r)) h.y = py;
  }

  updateSoldiers(dt);
  // Shoving can't push ground enemies into mountains or trees
  for (const e of enemies) { if (e.fly || e.ox === undefined) continue; const m = modeOf(e);
    if (mBlock(m, tileOf(e.x), tileOf(e.y)) && !mBlock(m, tileOf(e.ox), tileOf(e.oy))) { e.x = e.ox; e.y = e.oy; } }

  // Buildings
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const b = grid[y][x]; if (!b) continue;
    b.flash = Math.max(0, b.flash - dt); b.fireT = Math.max(0, (b.fireT || 0) - dt);
    const pw = auraPowerAt(x * T + T / 2, y * T + T / 2), boost = pw >= 0;   // an Engineer's aura speeds up construction and work
    const od = boost ? OVERDRIVE + POWER_PER * pw : 1;
    if (b.build > 0) { // under construction: blocks the path but doesn't work yet
      b.build -= dt * (boost ? BUILD_BOOST + BUILD_PER * pw : 1);
      if (b.build <= 0) { b.build = 0; burst(x * T + T / 2, y * T + T / 2, '#ffd84a', 10, 80); }
      continue;
    }
    b.cd -= dt * od;
    const px = x * T + T / 2, py = y * T + T / 2;
    if (b.cd > 0 || b.type === 'wall') continue;
    if (b.type === 'medic') {
      const mine = soldiers.filter(u => u.home === b).length;
      if (mine < DEFS.medic.maxUnits + (b.level - 1) && trainMedic(b)) b.cd = stat(b, 'interval');
      else b.cd = 0.5;
      continue;
    }
    if (b.type === 'barracks') {
      const mine = soldiers.filter(u => u.home === b).length;
      if (mine < DEFS.barracks.maxUnits + (b.level - 1) && trainSoldier(b)) b.cd = stat(b, 'interval');
      else b.cd = 0.5;
      continue;
    }
    if (b.type === 'mine') {
      // Mines pay every player's wallet the same share
      const inc = Math.round(stat(b, 'income')); b.cd = stat(b, 'interval'); b.fireT = 0.6;
      for (const [h, n] of splitEven(inc)) if (n) { earn(h, n); floatText(px, py - 12, '+' + n, '#ffd84a', 11, 0.8, h.id); }
      const me2 = pById(towerEngineer(px, py)), bonus = Math.round(inc * ENG_MINE_BONUS);   // Engineer's bonus for a mine in his aura
      if (me2 && bonus) { earn(me2, bonus); floatText(px, py - 24, '+' + bonus, '#ffb347', 11, 0.8, me2.id); }
      continue;
    }
    const range = stat(b, 'range') * T;
    const eng = towerEngineer(px, py);
    if (b.type === 'frost') {
      let hit = false;
      for (const e of enemies) if (!e.dead && d2(px, py, e.x, e.y) < range * range) { if (e.fly || !waterAt(e.x, e.y)) chill(e, 1.6); hurt(e, stat(b, 'dmg'), null, eng); hit = true; }
      if (hit) { b.cd = stat(b, 'interval'); b.pulse = 0.4; b.pulseN = (b.pulseN || 0) + 1; }
      continue;
    }
    const tgt = nearestEnemy(px, py, range, b.type === 'arrow', true);
    if (!tgt) continue;
    b.cd = stat(b, 'interval'); b.aim = Math.atan2(tgt.y - py, tgt.x - px); b.fireT = 0.25;
    if (b.type === 'arrow') projectiles.push({ kind: 'arrow', x: px, y: py, target: tgt, speed: 520, dmg: stat(b, 'dmg'), eng });
    else projectiles.push({ kind: 'shell', x: px, y: py, tx: tgt.x, ty: tgt.y, speed: 320, dmg: stat(b, 'dmg'), splash: DEFS.cannon.splash * T, eng });
  }

  // Projectiles
  for (const p of projectiles) {
    if (p.kind === 'eshell') {
      const dx = p.tx - p.x, dy = p.ty - p.y, l = Math.hypot(dx, dy);
      if (l < p.speed * dt) { p.done = true; siegeImpact(p); }
      else { p.x += dx / l * p.speed * dt; p.y += dy / l * p.speed * dt; }
    } else if (p.kind === 'shell') {
      const dx = p.tx - p.x, dy = p.ty - p.y, l = Math.hypot(dx, dy);
      if (l < p.speed * dt) {
        p.done = true; burst(p.tx, p.ty, '#f93', 16, 140);
        for (const e of enemies) if (!e.fly && d2(p.tx, p.ty, e.x, e.y) < p.splash ** 2) hurt(e, p.dmg, null, p.eng ?? null);
      } else { p.x += dx / l * p.speed * dt; p.y += dy / l * p.speed * dt; }
    } else {
      if (p.target.dead) { p.done = true; continue; }
      if (p.target.burrow && !p.splash) { p.done = true; burst(p.x, p.y, '#7a5a3a', 3, 40); continue; }   // thunks into the dirt
      const dx = p.target.x - p.x, dy = p.target.y - p.y, l = Math.hypot(dx, dy);
      p.ang = Math.atan2(dy, dx);
      if (l < p.speed * dt + p.target.r) {
        p.done = true;
        if (p.splash) { // fireball: burns everything in the blast, flying or not
          for (const e of enemies) if (!e.dead && d2(p.target.x, p.target.y, e.x, e.y) < p.splash ** 2) hurt(e, p.dmg, p.src ?? null);
          burst(p.target.x, p.target.y, '#ff8a30', 16, 150); burst(p.target.x, p.target.y, '#ffe27a', 8, 90);
          addBlast(p.target.x, p.target.y, p.splash);
        } else if (p.fx) {   // frost arrow chills, fire arrow sets alight (each replaces the other); water puts both out at once
          const e = p.target, wet = !e.fly && waterAt(e.x, e.y);
          if (!wet) { if (p.fx === 1) chill(e, ICE_T); else ignite(e, p.full * BURN_DPS, p.src ?? null); }
          hurt(e, p.dmg, p.src ?? null);
          burst(p.x, p.y, ARROWS[p.fx].color, p.fx === 2 ? 6 : 5, 70);
        } else { hurt(p.target, p.dmg, p.src ?? null, p.eng ?? null); burst(p.x, p.y, '#fff', 3, 60); }
      }
      else { p.x += dx / l * p.speed * dt; p.y += dy / l * p.speed * dt; }
    }
  }
  projectiles = projectiles.filter(p => !p.done);
  enemies = enemies.filter(e => !e.dead).concat(newEnemies); newEnemies = [];
  tickFx(dt);
  if (core.flash) core.flash = Math.max(0, core.flash - dt);
  for (const h of players) if (h.flash) h.flash = Math.max(0, h.flash - dt);
}

const ETK = Object.keys(ETYPES), DFK = Object.keys(DEFS), PRK = ['bullet', 'arrow', 'shell', 'eshell', 'dagger', 'fireball', 'rivet', 'icebolt', 'firebolt', 'boombolt'];
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;

// A client moves its own hero; the host accepts any position that is close by and not inside a wall
function remoteInput(pid, d) {
  const p = pById(pid);
  if (!p || !p.alive || gameState !== 'play' || speedPaused) return;
  const x = +d.x, y = +d.y;
  if (Number.isFinite(x) && Number.isFinite(y) && Math.hypot(x - p.x, y - p.y) < 6 * T &&
      x >= p.r && y >= p.r && x <= WW - p.r && y <= WH - p.r && !bodyBlocked(x, y, p.r)) { p.x = x; p.y = y; }
  p.moving = !!d.mv;
  if (Number.isFinite(+d.ma)) p.moveAng = +d.ma;
  if (Number.isFinite(+d.wk)) p.walk = +d.wk;
}

// A newcomer's purse: the starting 50 gold, plus what the average hero on the team has spent on upgrades,
// so someone who drops in late can catch up on hero power
const joinPurse = () => START_WALLET + (players.length ? Math.round(players.reduce((s, q) => s + upgradeSpend(q.heroUp), 0) / players.length) : 0);
// A hero joining a game already under way, or coming back to it. entry: { id, name, hero, color };
// old: what leavePlayer kept of a returning player (departed[id]), or null
function joinPlayer(entry, old) {
  const p = makePlayer(entry.id, entry.name, entry.hero, entry.color); p.remote = true;
  if (old) {
    p.stats = old.stats; delete departed[entry.id];
    if (old.heroType === p.heroType) p.heroUp = old.heroUp;
    else p.wallet = upgradeSpend(old.heroUp);   // switched hero: the old upgrades don't carry over, so their gold comes back
    const back = Math.min(old.wallet || 0, Math.max(0, treasury));   // the wallet they left in the treasury, as far as it still holds it
    treasury -= back; p.wallet += back;
  }
  else p.wallet = joinPurse();
  players.push(p);
  announce(old ? `${p.name} is back!` : `${p.name} joined the game with ${p.wallet} gold`, '#9fe8bf', 18, 2.5);
  return p;
}
// A hero leaving: their wallet goes to the treasury and their buildings stay. The server lets them back into the same seat
// (same id) only with their reconnect token, which restores them.
function leavePlayer(id) {
  const p = pById(id);
  if (!p) return;
  treasury += p.wallet;
  departed[p.id] = { id: p.id, heroType: p.heroType, heroUp: p.heroUp, stats: p.stats, wallet: p.wallet };
  players = players.filter(q => q !== p);
  announce(`${p.name} left${p.wallet ? ` — their ${p.wallet} gold went to the treasury` : ''}`, '#ffb0a0', 16, 3);
  if (gameState === 'play' && players.length && players.every(q => !q.alive)) gameOver('ALL HEROES HAVE FALLEN');
  else if (gameState === 'play') checkReady();   // everyone still here may already be waiting for the next wave
}
// The version of the online protocol: what the server and the page send each other (makeSnap / applySnap, initMsg,
// the messages in server/server.mjs). Bump it whenever that changes, so an app built from older code is told to update
// instead of misreading the snapshots.
const NET_VERSION = 1;
function initMsg(id) {
  return { t: 'init', you: id, set: { difficulty: diffKey, mapSize: mapKey },
    ter: terrain, bd: bridgeDir, ts: tileSeed.map(row => row.map(v => Math.round(v * 1000) / 1000)), seed: terrainSeed, snap: makeSnap(true) };
}
// full = everything (for a newly joined client). Otherwise only what clients don't have yet: new enemies' type and
// max HP, the full building list only when buildings changed, walls only when their HP changed.
function makeSnap(full) {
  const s = { t: 's', tr: treasury, w: wave, ph: phase === 'build' ? 0 : 1, pt: r1(phaseT), q: spawnQueue.length, k: kills, wt: waveTheme, nt: nextTheme,
    co: [Math.ceil(core.hp), core.maxHp, r2(core.flash || 0)], sp: speedPaused ? 1 : 0, spd: 1,
    hm: gameState === 'play' || gameState === 'over' ? 0 : 1, go: gameState === 'over' ? lossReason : 0 };
  s.P = players.map(p => [p.id, r1(p.x), r1(p.y), Math.ceil(p.hp), p.maxHp, p.alive ? 1 : 0, r2(p.aim || 0), p.moving ? 1 : 0, r1(p.walk || 0),
    r2(p.moveAng || 0), r2(p.fireT || 0), r2(p.throwT || 0), r2(p.flash || 0), p.wallet, p.ready ? 1 : 0, r1(p.respawnT), r2(p.reviveT),
    [p.heroUp.dmg, p.heroUp.rate, p.heroUp.range, p.heroUp.multi, p.heroUp.armor || 0, p.heroUp.taunt || 0, p.heroUp.aura || 0, p.heroUp.power || 0, p.heroUp.ammo || 0, p.heroUp.arrow || 0],
    p.work ? [p.work.tx, p.work.ty, r2(p.work.t), p.work.need, p.work.kind === 'tree' ? 0 : 1] : 0,
    p.name, p.heroType, p.colorI, [p.stats.kills, Math.round(p.stats.dmg), p.stats.gold, p.stats.built, p.stats.revives], p.respawned || 0, p.beam ? [Math.round(p.beam[0]), Math.round(p.beam[1])] : 0]);
  s.E = enemies.map(e => {
    const a = [e.id, Math.round(e.x), Math.round(e.y), Math.ceil(e.hp), r1(e.face), (e.slowT > 0 ? 1 : 0) | (e.hitT > 0 ? 2 : 0) | (e.lunge ? 4 : 0) | (e.burrow ? 8 : 0) | (e.burnT > 0 ? 16 : 0) | (e.burnT > 0 ? Math.min(7, e.burnN || 1) << 5 : 0),
      full || !e.sent ? [ETK.indexOf(e.type), Math.round(e.maxHp)] : 0];
    if (e.siege) a.push(r2(e.aim || 0), r2(e.recoil || 0), r2(e.shootT || 0), e.rage ? 1 : 0);
    else if (e.type === 'boss') a.push(r2(e.wind || 0), e.rage ? 1 : 0);
    if (!full) e.sent = true;
    return a;
  });
  s.S = soldiers.map(u => {
    const a = [u.id, Math.round(u.x), Math.round(u.y), Math.ceil(u.hp), r1(u.face), (u.medic ? 1 : 0) | (u.flash > 0 ? 2 : 0) | (u.lunge ? 4 : 0),
      u.beam ? [Math.round(u.beam[0]), Math.round(u.beam[1])] : 0,
      full || !u.sent ? [Math.round(u.maxHp), u.home ? u.home.tx : -1, u.home ? u.home.ty : -1] : 0];
    if (!full) u.sent = true;
    return a;
  });
  s.R = projectiles.map(p => {
    const tx = p.target ? p.target.x : p.tx, ty = p.target ? p.target.y : p.ty;
    return [PRK.indexOf(p.kind), Math.round(p.x), Math.round(p.y), r2(p.ang || 0), Math.round(tx), Math.round(ty), p.speed, p.splash || 0, Math.round(p.total || 0), r1(p.spin || 0)];
  });
  const blds = allBuildings();
  if (full || gridVer !== sentGv) {
    s.B = blds.map(b => [b.tx, b.ty, DFK.indexOf(b.type), Math.ceil(b.hp), b.maxHp, b.level, r1(b.build), b.owner ?? -1,
      b.rally ? [Math.round(b.rally[0]), Math.round(b.rally[1])] : 0, b.spent, r2(b.flash || 0), r2(b.aim || 0), r2(b.fireT || 0), r2(b.cd || 0), b.pulseN || 0]);
    if (!full) { sentGv = gridVer; for (const b of blds) b.sentHp = Math.ceil(b.hp); }
  } else {
    s.D = [];
    for (const b of blds) {
      const hp = Math.ceil(b.hp);
      if (b.type === 'wall' && hp === b.sentHp && !b.flash) continue;
      b.sentHp = hp;
      s.D.push([b.tx, b.ty, hp, r2(b.flash || 0), r2(b.aim || 0), r2(b.fireT || 0), r1(b.build), r2(b.cd || 0), b.pulseN || 0]);
    }
  }
  if (!full) { s.fx = netFx; s.te = netTer; netFx = []; netTer = []; }
  return s;
}
