const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

const defaults = {
  reconnectDelay: 5000,
  maxReconnectDelay: 60000,
  owners: [],
  commandPrefix: '',
  autoArmor: true,
  autoTotem: true,
  autoEat: true,
  autoElytra: true,
  autoKit: true,
  eatBelowFood: 14,
  eatGappleBelowHealth: 10,
  weaponPriority: ['mace', 'spear', 'sword', 'axe'],
  huntRadius: 32,
  guardRadius: 12,
  killGiveUpMs: 20000,
  logChat: true,
  hostileMobs: ['zombie', 'creeper', 'spider', 'skeleton']
};
const cfg = { ...defaults, ...require('./config.json') };

const VERSION = '2.1';
// Compare names ignoring case and leading symbols (Bedrock/Geyser names start with "." or "*")
const normName = (n) => String(n || '').replace(/^[^A-Za-z0-9_]+/, '').toLowerCase();
const owners = cfg.owners.map(normName);
const hostileSet = new Set(cfg.hostileMobs);
const isOwner = (name) => !!name && owners.includes(normName(name));

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Turns a raw chat line into [username, message] for different server chat formats
function parseChatLine(msg) {
  const clean = msg.replace(/§./g, '').trim();
  let m = clean.match(/^(?:\[[^\]]*\]\s*|\([^)]*\)\s*)*<([^>]+)>\s*(.+)$/);
  if (m) return [m[1], m[2]];
  // Owner-aware: "Name: cmd", "Name » cmd", "[Rank] Name > cmd", "Name cmd"...
  for (const o of cfg.owners) {
    const re = new RegExp(
      '^(?:\\[[^\\]]*\\]\\s*|\\([^)]*\\)\\s*)*<?[^\\w\\s<]{0,2}' + escapeRe(normName(o)) +
      '(?=[\\s>:»›➤→⇒|\\-\\]])[>\\]]?\\s*(?:[:»›>➤→⇒|\\-]+\\s*)?(\\S.*)$', 'i');
    m = clean.match(re);
    if (m) return [o, m[1]];
  }
  return null;
}

const STEP_INTERVAL = 1500;
const JUMP_DURATION = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Approximate attack cooldowns (ms) per weapon type
const COOLDOWN = { mace: 1700, spear: 1100, sword: 650, axe: 1100, fist: 500 };
const WEAPON_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'copper', 'wooden'];
const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'copper', 'leather', 'turtle'];
const ARMOR_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8 };
const BAD_FOOD = new Set([
  'pufferfish', 'spider_eye', 'rotten_flesh', 'poisonous_potato',
  'chorus_fruit', 'chicken', 'suspicious_stew', 'golden_apple', 'enchanted_golden_apple'
]);

const HELP_LINES = [
  '== Bot commands (owner only) ==',
  'help - this list | status - HP/food/mode | inv - show inventory | stop - stand still | afk - back to AFK moving',
  'pvp - hunt hostile mobs (zombie, creeper, spider, skeleton...) | guard - guard this spot | kill <player or mob> - attack it',
  'follow [name] - follow you | come - walk to you | goto <x> <y> <z> - walk to coords',
  'weapon <mace|spear|sword|axe|auto> - choose weapon | armor - wear best armor | totem - totem to offhand | eat - eat now',
  'elytra - wear elytra | fly - take off with elytra | kit - give myself a PvP kit (needs creative) | say <text> | rejoin'
];

let bot = null;
let reconnectTimer = null;
let currentDelay = cfg.reconnectDelay;
let shuttingDown = false;

function createBot() {
  console.log(`🔌 Connecting to ${cfg.serverHost}:${cfg.serverPort} as ${cfg.botUsername}...`);

  const instance = mineflayer.createBot({
    host: cfg.serverHost,
    port: cfg.serverPort,
    username: cfg.botUsername,
    auth: 'offline',
    version: false,
    viewDistance: cfg.botChunk
  });
  bot = instance;
  instance.loadPlugin(pathfinder);

  // ---------- per-session state ----------
  let ended = false;
  let started = false;
  const timers = [];
  const every = (ms, fn) => timers.push(setInterval(() => { try { fn(); } catch (e) { console.error('tick error:', e.message); } }, ms));

  let mode = 'afk';            // afk | idle | pvp | guard | kill | follow | goto
  let killSpec = null;         // { type: 'player'|'mob', name }
  let followName = null;
  let guardPos = null;
  let goalKey = null;
  let killLostSince = 0;
  let wantedWeapon = 'auto';
  let lastAttack = 0;
  let killCount = 0;
  let eating = false;
  let weaponBusy = false;
  let armorBusy = false;
  let elytraWorn = false;      // true => don't swap elytra out for a chestplate
  let elytraRestore = false;   // true => put chestplate back after landing
  let deploying = false;
  let kitGiven = false;
  let kitBusy = false;
  let justDied = false;
  let movementPhase = 0;
  let movementTimer = null;
  let jumpTimer = null;
  let lastCmdKey = '';
  let lastCmdTime = 0;

  // ---------- chat output (rate-limited so servers don't kick for spam) ----------
  const chatQueue = [];
  function say(text) {
    for (const line of String(text).split('\n')) {
      for (let i = 0; i < line.length; i += 240) chatQueue.push(line.slice(i, i + 240));
    }
  }
  every(700, () => {
    const msg = chatQueue.shift();
    if (msg && !ended) instance.chat(msg);
  });

  // ---------- inventory lock (one inventory action at a time) ----------
  let invLock = Promise.resolve();
  function withInv(fn) {
    const p = invLock.then(fn);
    invLock = p.catch(() => {});
    return p;
  }

  // ---------- helpers ----------
  const gameMode = () => instance.game && instance.game.gameMode;
  const inSurvivalLike = () => ['survival', 'adventure'].includes(gameMode());

  function clearControls() {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) instance.setControlState(c, false);
  }
  function clearGoal() {
    goalKey = null;
    instance.pathfinder.setGoal(null);
  }
  function setGoalOnce(key, make, dynamic = false) {
    if (goalKey === key) return;
    goalKey = key;
    instance.pathfinder.setGoal(make(), dynamic);
  }
  function setMode(m) {
    mode = m;
    killSpec = null;
    clearGoal();
    clearControls();
    if (m === 'afk') instance.setControlState('sneak', true);
  }
  function findPlayer(name) {
    return Object.values(instance.players).find((p) => p.username.toLowerCase() === name.toLowerCase());
  }
  function isProtected(name) {
    return isOwner(name) || name.toLowerCase() === instance.username.toLowerCase();
  }

  // ---------- weapons ----------
  function weaponType(item) {
    if (!item) return null;
    const n = item.name;
    if (n === 'mace') return 'mace';
    if (n.endsWith('_spear')) return 'spear';
    if (n.endsWith('_sword')) return 'sword';
    if (n.endsWith('_axe')) return 'axe';
    return null;
  }
  const weaponScore = (name) => {
    const i = WEAPON_TIERS.findIndex((t) => name.startsWith(t));
    return i === -1 ? 50 : i;
  };
  function findWeapon() {
    const order = wantedWeapon === 'auto' ? cfg.weaponPriority : [wantedWeapon];
    for (const type of order) {
      const items = instance.inventory.items()
        .filter((i) => weaponType(i) === type)
        .sort((a, b) => weaponScore(a.name) - weaponScore(b.name));
      if (items.length) return items[0];
    }
    return null;
  }
  function ensureWeapon() {
    if (weaponBusy || eating) return;
    const w = findWeapon();
    if (!w) return;
    if (instance.heldItem && instance.heldItem.name === w.name) return;
    weaponBusy = true;
    withInv(() => instance.equip(w, 'hand'))
      .catch(() => {})
      .finally(() => { weaponBusy = false; });
  }
  const cooldown = () => COOLDOWN[weaponType(instance.heldItem)] || COOLDOWN.fist;

  // ---------- combat ----------
  function fight(ent) {
    const dist = instance.entity.position.distanceTo(ent.position);
    setGoalOnce(`t${ent.id}`, () => new goals.GoalFollow(ent, 2), true);
    instance.setControlState('sprint', dist > 3);
    if (dist <= 4) instance.lookAt(ent.position.offset(0, (ent.height || 1.6) * 0.85, 0), true);
    ensureWeapon();
    if (dist <= 3.0 && !eating && Date.now() - lastAttack >= cooldown()) {
      instance.attack(ent);
      lastAttack = Date.now();
    }
  }
  function findHostile(origin, radius) {
    let best = null;
    let bestDist = Infinity;
    for (const e of Object.values(instance.entities)) {
      if (e === instance.entity || !hostileSet.has(e.name) || e.isValid === false) continue;
      const d = origin.distanceTo(e.position);
      if (d < radius && d < bestDist) { best = e; bestDist = d; }
    }
    return best;
  }
  function findMobByName(name, radius = 64) {
    let best = null;
    let bestDist = Infinity;
    for (const e of Object.values(instance.entities)) {
      if (e === instance.entity || e.name !== name || e.isValid === false) continue;
      const d = instance.entity.position.distanceTo(e.position);
      if (d < radius && d < bestDist) { best = e; bestDist = d; }
    }
    return best;
  }

  function modeTick() {
    if (!instance.entity || ended) return;
    switch (mode) {
      case 'pvp': {
        const t = findHostile(instance.entity.position, cfg.huntRadius);
        if (t) fight(t);
        else { clearGoal(); instance.setControlState('sprint', false); }
        break;
      }
      case 'guard': {
        const t = findHostile(guardPos, cfg.guardRadius);
        if (t) fight(t);
        else if (instance.entity.position.distanceTo(guardPos) > 2) {
          instance.setControlState('sprint', false);
          setGoalOnce('home', () => new goals.GoalNear(guardPos.x, guardPos.y, guardPos.z, 1));
        } else clearGoal();
        break;
      }
      case 'kill': {
        const ent = killSpec.type === 'player'
          ? (instance.players[killSpec.name] && instance.players[killSpec.name].entity)
          : findMobByName(killSpec.name);
        if (ent) { killLostSince = Date.now(); fight(ent); }
        else if (Date.now() - killLostSince > cfg.killGiveUpMs) {
          say(`I lost ${killSpec.name} (too far / not loaded). Giving up.`);
          setMode('afk');
        } else clearGoal();
        break;
      }
      case 'follow': {
        const p = instance.players[followName];
        if (p && p.entity) setGoalOnce(`f${p.entity.id}`, () => new goals.GoalFollow(p.entity, 2), true);
        break;
      }
      default:
        break;
    }
  }

  instance.on('entityDead', (e) => {
    if (e === instance.entity) return;
    if (mode === 'pvp' || mode === 'guard') {
      if (hostileSet.has(e.name)) killCount++;
    } else if (mode === 'kill' && killSpec) {
      const hit = killSpec.type === 'player' ? e.username === killSpec.name : e.name === killSpec.name;
      if (hit) {
        say(`Killed ${killSpec.name}! GG`);
        setMode('afk');
      }
    }
  });

  // ---------- armor ----------
  function pieceDest(name) {
    if (name.endsWith('_helmet')) return 'head';
    if (name.endsWith('_chestplate')) return 'torso';
    if (name.endsWith('_leggings')) return 'legs';
    if (name.endsWith('_boots')) return 'feet';
    return null;
  }
  const armorScore = (name) => {
    const i = ARMOR_TIERS.findIndex((t) => name.startsWith(t));
    return i === -1 ? 50 : i;
  };
  async function autoArmor() {
    if (!cfg.autoArmor || armorBusy || !instance.entity) return;
    armorBusy = true;
    try {
      for (const dest of ['head', 'torso', 'legs', 'feet']) {
        if (dest === 'torso' && elytraWorn) continue;
        const worn = instance.inventory.slots[ARMOR_SLOTS[dest]];
        const wornScore = worn && pieceDest(worn.name) === dest ? armorScore(worn.name) : 99;
        const best = instance.inventory.items()
          .filter((i) => pieceDest(i.name) === dest)
          .sort((a, b) => armorScore(a.name) - armorScore(b.name))[0];
        if (best && armorScore(best.name) < wornScore) await withInv(() => instance.equip(best, dest));
      }
    } catch (e) { /* ignore, retry next cycle */ }
    armorBusy = false;
  }

  // ---------- totem ----------
  async function autoTotem() {
    if (!cfg.autoTotem || !instance.entity) return;
    try {
      const slot = instance.getEquipmentDestSlot('off-hand');
      const off = instance.inventory.slots[slot];
      if (off && off.name === 'totem_of_undying') return;
      const totem = instance.inventory.items().find((i) => i.name === 'totem_of_undying');
      if (totem) await withInv(() => instance.equip(totem, 'off-hand'));
    } catch (e) { /* ignore */ }
  }

  // ---------- eating ----------
  function bestFood() {
    const foods = instance.registry.foodsByName;
    return instance.inventory.items()
      .filter((i) => foods[i.name] && !BAD_FOOD.has(i.name))
      .sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints)[0];
  }
  function gapple() {
    const items = instance.inventory.items();
    return items.find((i) => i.name === 'golden_apple') || items.find((i) => i.name === 'enchanted_golden_apple');
  }
  async function eatNow(force = false) {
    if (eating || !instance.entity || !inSurvivalLike()) return false;
    let item = null;
    if (instance.health <= cfg.eatGappleBelowHealth) item = gapple();
    if (!item && (force || instance.food <= cfg.eatBelowFood) && instance.food < 20) item = bestFood();
    if (!item) return false;
    eating = true;
    try {
      await withInv(() => instance.equip(item, 'hand'));
      await instance.consume();
      return true;
    } catch (e) {
      await sleep(3000);
      return false;
    } finally {
      eating = false;
    }
  }

  // ---------- elytra ----------
  const findElytra = () => instance.inventory.items().find((i) => i.name === 'elytra');
  async function wearElytra() {
    const torso = instance.inventory.slots[ARMOR_SLOTS.torso];
    if (torso && torso.name === 'elytra') { elytraWorn = true; return true; }
    const el = findElytra();
    if (!el) return false;
    await withInv(() => instance.equip(el, 'torso'));
    elytraWorn = true;
    return true;
  }
  async function flyNow() {
    if (!(await wearElytra())) { say("I don't have an elytra."); return; }
    elytraRestore = true;
    instance.setControlState('jump', true);
    await sleep(150);
    instance.setControlState('jump', false);
    await sleep(450);
    await instance.elytraFly();
    const rocket = instance.inventory.items().find((i) => i.name === 'firework_rocket');
    if (rocket) {
      await withInv(() => instance.equip(rocket, 'hand'));
      instance.activateItem();
    }
    instance.look(instance.entity.yaw, 0.4);
  }
  // Auto-deploy elytra when falling fast, put chestplate back after landing
  instance.on('physicsTick', () => {
    const e = instance.entity;
    if (!cfg.autoElytra || !e || deploying) return;
    if (elytraRestore && e.onGround && !e.elytraFlying) {
      elytraRestore = false;
      elytraWorn = false;
      autoArmor();
      return;
    }
    if (inSurvivalLike() && !e.onGround && !e.elytraFlying && !e.isInWater && e.velocity.y < -1.0 &&
        (findElytra() || (instance.inventory.slots[ARMOR_SLOTS.torso] || {}).name === 'elytra')) {
      deploying = true;
      wearElytra()
        .then(() => { elytraRestore = true; return instance.elytraFly(); })
        .catch(() => {})
        .finally(() => { deploying = false; });
    }
  });

  // ---------- creative kit ----------
  async function giveKit(auto = false) {
    if (kitBusy || (auto && kitGiven)) return;
    if (gameMode() !== 'creative') {
      say("I need creative mode for the kit. Give me creative, then type: kit");
      return;
    }
    kitBusy = true;
    const Item = require('prismarine-item')(instance.registry);
    const skipped = [];
    const put = async (slot, names, count = 1) => {
      const list = Array.isArray(names) ? names : [names];
      const name = list.find((n) => instance.registry.itemsByName[n]);
      if (!name) { skipped.push(list[0]); return; }
      try {
        await instance.creative.setInventorySlot(slot, new Item(instance.registry.itemsByName[name].id, count));
      } catch (e) {
        console.error(`kit: slot ${slot} (${name}) failed: ${e.message}`);
      }
      await sleep(60);
    };
    try {
      say('Getting my PvP kit...');
      // worn armor
      await put(5, 'netherite_helmet');
      await put(6, 'netherite_chestplate');
      await put(7, 'netherite_leggings');
      await put(8, 'netherite_boots');
      // hotbar
      await put(36, 'mace');
      await put(37, ['netherite_spear', 'diamond_spear', 'iron_spear']);
      await put(38, 'netherite_sword');
      await put(39, 'netherite_axe');
      await put(40, 'enchanted_golden_apple', 64);
      await put(41, 'cooked_beef', 64);
      await put(42, 'firework_rocket', 64);
      await put(43, 'wind_charge', 64);
      // inventory: 9 totems, elytra, spare armor
      for (let s = 9; s <= 17; s++) await put(s, 'totem_of_undying');
      await put(18, 'elytra');
      await put(19, 'netherite_helmet');
      await put(20, 'netherite_chestplate');
      await put(21, 'netherite_leggings');
      await put(22, 'netherite_boots');
      await sleep(800);
      await autoArmor();
      await autoTotem();
      kitGiven = true;
      say('Kit ready! You can switch me to survival now.' + (skipped.length ? ` (Not in this MC version: ${skipped.join(', ')})` : ''));
    } finally {
      kitBusy = false;
    }
  }
  function maybeAutoKit() {
    if (!started) return;
    if (gameMode() !== 'creative') { kitGiven = false; return; } // switch to creative again => new kit
    if (cfg.autoKit && !kitGiven && !kitBusy) giveKit(true).catch((e) => console.error('kit error:', e.message));
  }

  // ---------- AFK movement (original behaviour) ----------
  function movementCycle() {
    if (ended) return;
    movementTimer = setTimeout(movementCycle, STEP_INTERVAL);
    if (mode !== 'afk' || !instance.entity) return;

    switch (movementPhase) {
      case 0:
        instance.setControlState('forward', true);
        instance.setControlState('back', false);
        instance.setControlState('jump', false);
        break;
      case 1:
        instance.setControlState('forward', false);
        instance.setControlState('back', true);
        instance.setControlState('jump', false);
        break;
      case 2:
        instance.setControlState('forward', false);
        instance.setControlState('back', false);
        instance.setControlState('jump', true);
        jumpTimer = setTimeout(() => { if (!ended && mode === 'afk') instance.setControlState('jump', false); }, JUMP_DURATION);
        break;
      case 3:
        instance.setControlState('forward', false);
        instance.setControlState('back', false);
        instance.setControlState('jump', false);
        break;
    }
    movementPhase = (movementPhase + 1) % 4;
  }

  // ---------- commands ----------
  const run = (p) => p.catch((e) => say(`Error: ${e.message}`));
  const commands = {
    help() { say(HELP_LINES.join('\n')); },
    status() {
      const w = instance.heldItem ? instance.heldItem.name : 'nothing';
      say(`HP ${Math.round(instance.health)}/20 | Food ${instance.food}/20 | Mode: ${mode} | Holding: ${w} | Weapon pref: ${wantedWeapon} | Gamemode: ${gameMode()} | Kills: ${killCount}`);
    },
    inv() {
      const counts = {};
      for (const i of instance.inventory.items()) counts[i.name] = (counts[i.name] || 0) + i.count;
      const parts = Object.entries(counts).map(([n, c]) => `${n} x${c}`);
      say(parts.length ? `Inventory: ${parts.join(', ')}` : 'Inventory is empty.');
    },
    stop() { setMode('idle'); say('Stopped. Standing still. (type afk to resume AFK moving)'); },
    afk() { setMode('afk'); say('Back to AFK mode.'); },
    pvp() { setMode('pvp'); say('PvP mode ON: hunting hostile mobs. Type stop to end.'); },
    guard() {
      setMode('guard');
      guardPos = instance.entity.position.clone();
      say(`Guarding this spot (radius ${cfg.guardRadius}).`);
    },
    kill(args) {
      const name = args[0];
      if (!name) return say('Usage: kill <playername or mob>');
      if (isProtected(name)) return say("I won't attack that one.");
      const pl = findPlayer(name);
      if (pl) {
        setMode('kill');
        killSpec = { type: 'player', name: pl.username };
        say(`Attacking player ${pl.username}!`);
      } else if (name.toLowerCase() !== 'player' && instance.registry.entitiesByName[name.toLowerCase()]) {
        setMode('kill');
        killSpec = { type: 'mob', name: name.toLowerCase() };
        say(`Attacking nearest ${name.toLowerCase()}!`);
      } else {
        return say(`${name} is not online and not a mob I know.`);
      }
      killLostSince = Date.now();
    },
    follow(args, user) {
      const name = args[0] || user;
      const pl = findPlayer(name);
      if (!pl) return say(`${name} is not online.`);
      setMode('follow');
      followName = pl.username;
      say(`Following ${pl.username}.`);
    },
    come(args, user) {
      const pl = instance.players[user];
      if (!pl || !pl.entity) return say("I can't see you. Come closer or use goto x y z.");
      const p = pl.entity.position;
      commands.goto([p.x, p.y, p.z].map((n) => Math.floor(n)));
    },
    goto(args) {
      const [x, y, z] = args.map(Number);
      if ([x, y, z].some((n) => Number.isNaN(n))) return say('Usage: goto <x> <y> <z>');
      setMode('goto');
      say(`Going to ${x} ${y} ${z}...`);
      instance.pathfinder.goto(new goals.GoalNear(x, y, z, 1))
        .then(() => { if (mode === 'goto') { say('Arrived.'); setMode('afk'); } })
        .catch((e) => { if (mode === 'goto') { say(`Can't get there: ${e.message}`); setMode('afk'); } });
    },
    weapon(args) {
      const w = (args[0] || '').toLowerCase();
      if (!['mace', 'spear', 'sword', 'axe', 'auto'].includes(w)) return say('Usage: weapon <mace|spear|sword|axe|auto>');
      wantedWeapon = w;
      weaponBusy = false;
      const found = findWeapon();
      say(found ? `Weapon: ${w} (${found.name})` : `Weapon set to ${w}, but I don't have one in my inventory.`);
      ensureWeapon();
    },
    armor() {
      elytraWorn = false;
      elytraRestore = false;
      run(autoArmor());
      say('Equipping best armor.');
    },
    totem() {
      run(autoTotem());
      const has = instance.inventory.items().some((i) => i.name === 'totem_of_undying');
      say(has ? 'Totem to offhand.' : 'I have no totem.');
    },
    eat() { run(eatNow(true).then((ok) => say(ok ? 'Ate something.' : "Nothing to eat or I'm full."))); },
    elytra() { run(wearElytra().then((ok) => say(ok ? 'Elytra on. (type armor to swap back)' : "I don't have an elytra."))); },
    fly() { run(flyNow()); },
    kit() { run(giveKit()); },
    say(args) {
      const text = args.join(' ');
      if (!text) return say('Usage: say <text>');
      if (text.startsWith('/')) return say("I won't run slash commands from chat.");
      say(text);
    },
    rejoin() { say('Rejoining...'); setTimeout(() => instance.quit('rejoin'), 1500); }
  };
  const aliases = { commands: 'help', cmds: 'help', hunt: 'pvp', attack: 'kill', gear: 'armor', chest: 'armor', unfollow: 'stop' };

  function handleChat(username, message) {
    if (!username || username === instance.username || !isOwner(username)) return;
    const key = `${normName(username)}|${message.trim()}`;
    if (key === lastCmdKey && Date.now() - lastCmdTime < 1000) return; // de-dupe chat + fallback parser
    let text = message.trim();
    if (cfg.commandPrefix && text.startsWith(cfg.commandPrefix)) text = text.slice(cfg.commandPrefix.length).trim();
    else if (text.startsWith('!')) text = text.slice(1).trim();
    const [word, ...args] = text.split(/\s+/);
    let cmd = (word || '').toLowerCase();
    cmd = aliases[cmd] || cmd;
    if (!Object.prototype.hasOwnProperty.call(commands, cmd)) return; // normal chat, ignore
    lastCmdKey = key;
    lastCmdTime = Date.now();
    console.log(`💬 ${username}: ${message}`);
    try { commands[cmd](args, username); } catch (e) { say(`Error: ${e.message}`); }
  }
  instance.on('chat', handleChat);
  instance.on('whisper', handleChat);
  // Works for any chat format (also logs raw chat so you can see what the server sends)
  instance.on('messagestr', (msg) => {
    if (cfg.logChat) console.log('📨', msg);
    const parsed = parseChatLine(msg);
    if (parsed) handleChat(parsed[0], parsed[1]);
  });

  // ---------- lifecycle ----------
  instance.on('spawn', () => {
    currentDelay = cfg.reconnectDelay; // connected: reset backoff

    if (!started) {
      started = true;
      const movements = new Movements(instance);
      movements.canDig = false;          // never break the world
      movements.scafoldingBlocks = [];   // never place blocks
      instance.pathfinder.setMovements(movements);

      setTimeout(() => {
        if (ended) return;
        if (mode === 'afk') instance.setControlState('sneak', true);
        console.log(`✅ ${cfg.botUsername} is Ready!`);
      }, 3000);
      movementTimer = setTimeout(movementCycle, STEP_INTERVAL);

      every(150, modeTick);
      every(500, autoTotem);
      every(2000, autoArmor);
      every(1000, () => { if (cfg.autoEat) eatNow(false).catch(() => {}); });
      every(2000, maybeAutoKit);
      say(`PvP bot v${VERSION} online! Owner: ${cfg.owners.join(', ')}. Type help`);
      console.log(`🤖 PvP bot v${VERSION} running. Owners: ${cfg.owners.join(', ')}`);
    }

    if (justDied) {
      justDied = false;
      guardPos = null;
      setMode('afk');
    }
  });

  instance.on('death', () => {
    justDied = true;
    say('I died... respawning.');
    console.log('💀 Bot died.');
  });

  instance.on('playerCollect', (collector) => {
    if (collector === instance.entity) setTimeout(() => { autoArmor(); autoTotem(); }, 400);
  });

  instance.on('kicked', (reason) => {
    console.log('👢 Kicked from server:', typeof reason === 'string' ? reason : JSON.stringify(reason));
  });

  instance.on('error', (err) => {
    console.error('⚠️ Error:', err.message || err);
  });

  instance.on('end', (reason) => {
    ended = true;
    timers.forEach(clearInterval);
    clearTimeout(movementTimer);
    clearTimeout(jumpTimer);
    console.log(`⛔️ Bot Disconnected!${reason ? ` (${reason})` : ''}`);
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (shuttingDown || reconnectTimer) return; // avoid double-scheduling
  const delay = currentDelay;
  console.log(`🔁 Reconnecting in ${(delay / 1000).toFixed(1)}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, delay);
  currentDelay = Math.min(currentDelay * 2, cfg.maxReconnectDelay);
}

process.on('SIGINT', () => {
  shuttingDown = true;
  clearTimeout(reconnectTimer);
  console.log('\n👋 Shutting down...');
  if (bot) bot.quit();
  setTimeout(() => process.exit(0), 500);
});

createBot();
