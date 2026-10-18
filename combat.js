'use strict';
/**
 * PvP combat engine.
 *
 * Tactics (all based on current Java Edition mechanics):
 *  - Sword / axe : jump-crits (hit while falling, sprint released), strafing, spacing,
 *                  axe swap to break shields.
 *  - Mace        : "smash" = hit while falling >= 1.5 blocks (not gliding).
 *                  Wind-charge jump -> dive onto target. Elytra dive: glide, take the elytra
 *                  off right before contact, smash.
 *  - Spear       : jab (reach 2-4.5, forced cooldown) + charge (hold use, damage scales with
 *                  relative speed). Elytra + rockets gives huge charge damage.
 */
const { Vec3 } = require('vec3');

const MELEE_CD = { sword: 650, axe: 1000, mace: 1700, fist: 500 };
const JAB_CD = { wooden: 650, golden: 950, stone: 750, copper: 850, iron: 950, diamond: 1050, netherite: 1150 };
const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'copper', 'wooden'];

// Survives reconnects: if the server ever kicks us right after a spear "stab" packet, stop sending it.
let stabDisabled = false;
let lastStabAt = 0;

function createCombat(bot, ctx) {
  const cfg = Object.assign({
    airstrike: true,
    windSmash: true,
    airstrikeMinDist: 14,
    climbHeight: 22,
    maxClimbRockets: 3,
    minHealthForStunts: 10,
    stuntCooldownMs: 2500,
    spearJab: 'both',       // 'stab' | 'attack' | 'both'
    spearStabStatus: 7
  }, ctx.cfg);

  const opts = { air: !!cfg.airstrike, wind: !!cfg.windSmash };
  let weaponPref = 'auto';

  // ---------- state ----------
  let target = null;
  let gen = 0;                 // bumped on disengage => aborts async routines
  let busy = null;             // 'wind' | 'air' | null
  let manual = false;          // manual movement vs pathfinder
  let lastAttack = 0;
  let lastJab = 0;
  let readySince = 0;
  let wasReady = false;
  let strafe = 1;
  let nextStrafeFlip = 0;
  let suppressSprint = false;
  let charging = false;
  let chargeStart = 0;
  let chargeEnd = 0;
  let weaponLockUntil = 0;
  let lockedType = null;
  let stuntCooldownUntil = 0;
  let peakY = 0;
  let tPos = null;
  let tVel = new Vec3(0, 0, 0); // target velocity, blocks/tick (smoothed)
  let seq = 1000;
  let hits = 0;

  const now = () => Date.now();
  const log = (...a) => console.log('⚔️ ', ...a);

  // ---------- inventory helpers ----------
  const items = () => bot.inventory.items();
  const tierScore = (name) => {
    const i = TIERS.findIndex((t) => name.startsWith(t));
    return i === -1 ? 50 : i;
  };
  function weaponType(item) {
    if (!item) return null;
    const n = item.name;
    if (n === 'mace') return 'mace';
    if (n.endsWith('_spear')) return 'spear';
    if (n.endsWith('_sword')) return 'sword';
    if (n.endsWith('_axe')) return 'axe';
    return null;
  }
  const findWeapon = (type) => items().filter((i) => weaponType(i) === type).sort((a, b) => tierScore(a.name) - tierScore(b.name))[0] || null;
  const findByName = (name) => items().find((i) => i.name === name) || null;
  const countOf = (name) => items().filter((i) => i.name === name).reduce((a, i) => a + i.count, 0);
  const has = (type) => !!findWeapon(type);

  /** Select an item: instant for hotbar items, inventory click otherwise. */
  async function hold(item) {
    if (!item) return false;
    if (bot.heldItem && bot.heldItem.name === item.name) return true;
    if (item.slot >= 36 && item.slot <= 44) {
      bot.setQuickBarSlot(item.slot - 36);
      return true;
    }
    try {
      await ctx.withInv(() => bot.equip(item, 'hand'));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- movement helpers ----------
  const lastCtl = {};
  function drive(c = {}) {
    for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) {
      const v = !!c[k];
      if (lastCtl[k] !== v || bot.getControlState(k) !== v) {
        bot.setControlState(k, v);
        lastCtl[k] = v;
      }
    }
  }
  const valid = (e) => !!e && e.isValid !== false && !!bot.entities[e.id];

  function trackFall() {
    const e = bot.entity;
    if (e.onGround || e.isInWater || e.isInLava || e.elytraFlying) peakY = e.position.y;
    else peakY = Math.max(peakY, e.position.y);
  }
  const fallen = () => Math.max(0, peakY - bot.entity.position.y);

  function trackTarget() {
    const p = target.position;
    if (tPos) tVel = tVel.scaled(0.6).plus(p.minus(tPos).scaled(0.4));
    tPos = p.clone();
  }

  /** Distance from our eyes to the nearest point of the target's hitbox. */
  function reachTo(ent) {
    const e = bot.entity;
    const eye = e.position.offset(0, 1.62, 0);
    const w = (ent.width || 0.6) / 2;
    const h = ent.height || 1.8;
    const cx = Math.max(ent.position.x - w, Math.min(eye.x, ent.position.x + w));
    const cy = Math.max(ent.position.y, Math.min(eye.y, ent.position.y + h));
    const cz = Math.max(ent.position.z - w, Math.min(eye.z, ent.position.z + w));
    return eye.distanceTo(new Vec3(cx, cy, cz));
  }
  function aimPoint(ent, leadTicks = 0) {
    const h = ent.height || 1.8;
    let p = ent.position.offset(0, h * 0.6, 0);
    if (leadTicks > 0) p = p.plus(tVel.scaled(leadTicks));
    return p;
  }
  function face(ent) {
    bot.lookAt(aimPoint(ent), true);
  }
  function isBlocking(ent) {
    try {
      const flags = ent.metadata && ent.metadata[8];
      if (typeof flags !== 'number' || (flags & 1) === 0) return false;
      const eq = ent.equipment || [];
      return [eq[0], eq[1], ent.heldItem].some((i) => i && i.name === 'shield');
    } catch (e) {
      return false;
    }
  }
  const solidAt = (v) => {
    const b = bot.blockAt(v);
    return !!b && b.boundingBox !== 'empty';
  };
  const skyOpen = (h = 14) => {
    const p = bot.entity.position.floored();
    for (let y = 2; y <= h; y++) if (solidAt(p.offset(0, y, 0))) return false;
    return true;
  };
  const groundWithin = (d) => {
    const p = bot.entity.position.floored();
    for (let y = 1; y <= d; y++) if (solidAt(p.offset(0, -y, 0))) return true;
    return false;
  };

  async function ticks(n, fn, token) {
    for (let i = 0; i < n; i++) {
      if (token !== gen || !valid(target)) return false;
      if (fn) fn();
      await bot.waitForTicks(1);
    }
    return true;
  }
  async function waitUntil(cond, maxTicks, token) {
    for (let i = 0; i < maxTicks; i++) {
      if (token !== gen) return false;
      if (cond()) return true;
      await bot.waitForTicks(1);
    }
    return false;
  }

  // ---------- attacks ----------
  function hit(ent) {
    bot.attack(ent);
    lastAttack = now();
    hits++;
  }
  function jab(ent) {
    const reach = reachTo(ent);
    let stabbed = false;
    if (cfg.spearJab !== 'attack' && !stabDisabled && bot.registry.version['>=']('1.21.11')) {
      try {
        bot._client.write('block_dig', { status: cfg.spearStabStatus, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: ++seq });
        lastStabAt = now();
        stabbed = true;
      } catch (e) { /* ignore */ }
    }
    if (cfg.spearJab === 'attack' || !stabbed || (cfg.spearJab === 'both' && reach <= 3.0)) {
      if (reach <= 4.5) bot.attack(ent);
    } else {
      bot.swingArm('right');
    }
    lastJab = now();
    lastAttack = now();
    hits++;
  }
  function startCharge() {
    if (charging) return;
    bot.activateItem();
    charging = true;
    chargeStart = now();
  }
  function stopCharge() {
    if (!charging) return;
    try { bot.deactivateItem(); } catch (e) { /* ignore */ }
    charging = false;
    chargeEnd = now();
  }

  // ---------- weapon choice ----------
  function chooseMeleeType(dist) {
    if (weaponPref !== 'auto') {
      if (has(weaponPref)) return weaponPref;
      return ['sword', 'axe', 'spear', 'mace'].find(has) || null;
    }
    if (isBlocking(target) && has('axe')) return 'axe';
    const e = bot.entity;
    const smashReady = !e.onGround && e.velocity.y < -0.1 && fallen() >= 1.8 && !e.elytraFlying;
    if (smashReady && has('mace')) return 'mace';
    if (now() < weaponLockUntil && lockedType && has(lockedType)) return lockedType;
    let t = ['sword', 'axe', 'spear', 'mace'].find(has) || null;
    if (t) { lockedType = t; weaponLockUntil = now() + 700; }
    return t;
  }

  // ---------- melee (sword / axe / mace / fist) ----------
  function meleeTick(type, dist) {
    const e = bot.entity;
    const t = now();
    const reach = reachTo(target);
    const cd = MELEE_CD[type || 'fist'];
    const ready = t - lastAttack >= cd;
    if (ready && !wasReady) readySince = t;
    wasReady = ready;

    // spacing
    let fwd = false;
    let back = false;
    if (reach > 2.7) fwd = true;
    else if (reach < 1.3) back = true;

    // strafing
    if (t > nextStrafeFlip) {
      strafe = Math.random() < 0.5 ? 1 : -1;
      nextStrafeFlip = t + 450 + Math.random() * 700;
    }
    const near = reach < 4.2;
    let jump = false;

    if (ready && reach <= 3.0) {
      const falling = !e.onGround && e.velocity.y < -0.03 && !e.isInWater && !e.isInLava;
      const smash = type === 'mace' && fallen() >= 1.5 && !e.onGround && !e.elytraFlying;
      if (smash) {
        hit(target);
      } else if (falling) {
        // crit: must NOT be sprinting. Release sprint one tick earlier, then hit.
        if (bot.getControlState('sprint')) suppressSprint = true;
        else { hit(target); suppressSprint = false; }
      } else if (e.onGround) {
        if (t - readySince < 280) jump = true;          // jump now, hit on the way down
        else hit(target);                                // can't crit (low ceiling etc.)
      } else if (t - readySince > 400) {
        hit(target);
      }
    } else {
      suppressSprint = false;
    }

    drive({
      forward: fwd,
      back,
      left: near && strafe === 1,
      right: near && strafe === -1,
      jump,
      sprint: fwd && !suppressSprint
    });
  }

  // ---------- spear (ground) ----------
  function spearTick(item, dist) {
    const t = now();
    const reach = reachTo(target);
    const tier = TIERS.find((x) => item.name.startsWith(x)) || 'iron';
    const jabCd = JAB_CD[tier] || 1000;
    const fwd = reach > 3.6;
    const back = reach < 2.0;

    if (t > nextStrafeFlip) {
      strafe = Math.random() < 0.5 ? 1 : -1;
      nextStrafeFlip = t + 600 + Math.random() * 600;
    }

    // jab: reach 2 - 4.5, forced cooldown
    if (reach >= 2.0 && reach <= 4.4 && t - lastJab >= jabCd) {
      stopCharge();
      jab(target);
    }
    // charge: hold use while closing in (damage = multiplier x relative speed)
    if (!charging && t - lastJab > 250 && t - chargeEnd > 700 && reach > 2.4) startCharge();
    if (charging && t - chargeStart > 3800) stopCharge();

    drive({ forward: fwd, back, left: !fwd && reach < 4.2 && strafe === 1, right: !fwd && reach < 4.2 && strafe === -1, sprint: fwd });
  }

  // ---------- wind-charge mace smash ----------
  async function windSmash() {
    const token = gen;
    busy = 'wind';
    const e = bot.entity;
    try {
      const wind = findByName('wind_charge');
      const mace = findWeapon('mace');
      if (!wind || !mace) return;
      log('wind-charge jump starting');
      ctx.pathStop();
      await hold(wind);

      // sprint-jump toward the target
      drive({ forward: true, sprint: true, jump: true });
      face(target);
      let waited = 0;
      while (token === gen && valid(target) && waited < 14) {
        face(target);
        await bot.waitForTicks(1);
        waited++;
        if (!e.onGround) drive({ forward: true, sprint: true, jump: false });
        if (!e.onGround && e.velocity.y <= 0.12 && waited > 2) break; // near the apex
      }
      if (token !== gen) return;

      // throw the charge at our feet at the top of the jump
      bot.look(e.yaw, -Math.PI / 2, true);
      await bot.waitForTicks(1);
      bot.activateItem();
      await bot.waitForTicks(1);

      // swap to mace and steer onto the target while falling
      await hold(mace);
      const t0 = now();
      while (token === gen && valid(target) && now() - t0 < 3500) {
        face(target);
        drive({ forward: true, sprint: true });
        const reach = reachTo(target);
        if (e.velocity.y < -0.05 && reach <= 3.0 && fallen() >= 1.5) {
          hit(target);
          log('wind smash hit, fell', fallen().toFixed(1), 'blocks');
          break;
        }
        if (e.onGround && now() - t0 > 400) break;
        await bot.waitForTicks(1);
      }
    } catch (err) {
      log('windSmash error:', err.message);
    } finally {
      busy = null;
      drive({});
      stuntCooldownUntil = now() + cfg.stuntCooldownMs;
    }
  }

  // ---------- elytra airstrike ----------
  const rocket = () => findByName('firework_rocket');

  async function boost(token, backTo) {
    const r = rocket();
    if (!r) return false;
    await hold(r);
    if (token !== gen) return false;
    bot.activateItem();
    if (backTo) await hold(backTo);
    return true;
  }

  function airWeapon() {
    for (const w of cfg.weaponPriority || ['mace', 'spear']) {
      if ((w === 'mace' || w === 'spear') && has(w)) {
        if (weaponPref === 'auto' || weaponPref === w) return w;
      }
    }
    return null;
  }

  async function airstrike(kind) {
    const token = gen;
    busy = 'air';
    const e = bot.entity;
    const alive = () => token === gen && valid(target);
    try {
      ctx.pathStop();
      log(`airstrike (${kind}) starting, target ${Math.round(e.position.distanceTo(target.position))} blocks away`);
      if (!(await ctx.elytra.wear())) { log('airstrike aborted: no elytra'); return; }
      ctx.elytra.setRestore(true);
      if (!rocket()) { log('airstrike aborted: no firework rockets'); return; }

      // take off
      if (!e.elytraFlying) {
        if (e.onGround) {
          bot.setControlState('jump', true);
          await bot.waitForTicks(2);
          bot.setControlState('jump', false);
        }
        if (!(await waitUntil(() => !e.onGround && e.velocity.y < -0.05, 30, token))) { log('airstrike aborted: could not leave the ground'); return; }
        await bot.elytraFly();
        // the server confirms gliding a few ticks later (entity metadata)
        if (!(await waitUntil(() => e.elytraFlying, 20, token))) {
          log('airstrike aborted: server did not start gliding (elytra broken or not worn?)');
          return;
        }
      }

      // climb with rockets, heading toward the target
      let used = 0;
      const wantY = () => target.position.y + cfg.climbHeight;
      while (alive() && used < cfg.maxClimbRockets && e.position.y < wantY() && e.elytraFlying) {
        if (!(await boost(token))) break;
        used++;
        await ticks(24, () => {
          const dx = target.position.x - e.position.x;
          const dz = target.position.z - e.position.z;
          bot.look(Math.atan2(-dx, -dz), 0.85, true);
        }, token);
      }
      if (!alive() || !e.elytraFlying) { log('airstrike aborted: not gliding after climb'); return; }
      log(`climbed to y=${e.position.y.toFixed(0)}, diving`);

      if (kind === 'mace') await strikeMace(token);
      else await strikeSpear(token);
    } catch (err) {
      log('airstrike error:', err.message);
    } finally {
      stopCharge();
      busy = null;
      drive({});
      stuntCooldownUntil = now() + cfg.stuntCooldownMs * 2;
    }
  }

  async function strikeMace(token) {
    const e = bot.entity;
    const mace = findWeapon('mace');
    if (!mace) return;
    await hold(mace);
    let swapped = false;
    for (let i = 0; i < 20 * 14; i++) {
      if (token !== gen || !valid(target)) return;
      const d0 = e.position.distanceTo(target.position);
      const speed = e.velocity.norm() * 20;
      const aim = aimPoint(target, Math.min(15, d0 / Math.max(0.6, e.velocity.norm())));
      bot.lookAt(aim, true);

      // take the elytra off just before contact: gliding blocks the smash, falling doesn't
      if (!swapped && e.elytraFlying && d0 < Math.max(6, speed * 0.22 + 3)) {
        swapped = true;
        ctx.elytra.putChestplate().catch(() => {});
      }
      if ((swapped || !e.elytraFlying) && reachTo(target) <= 3.1) {
        hit(target);
        log('elytra mace smash at', speed.toFixed(0), 'b/s');
        await bot.waitForTicks(2);
        return;
      }
      if (swapped && e.onGround) return;
      // too slow / still far: rocket boost
      if (!swapped && e.elytraFlying && speed < 12 && d0 > 16 && rocket()) await boost(token, mace);
      await bot.waitForTicks(1);
    }
  }

  async function strikeSpear(token) {
    const e = bot.entity;
    const spear = findWeapon('spear');
    if (!spear) return;
    await hold(spear);
    const t0 = now();
    let passes = 0;
    let lastD = Infinity;
    while (token === gen && valid(target) && now() - t0 < 16000 && passes < 4) {
      const d = e.position.distanceTo(target.position);
      const vel = e.velocity.norm();
      const speed = vel * 20;
      let aim = aimPoint(target, Math.min(15, d / Math.max(0.6, vel)));
      // don't fly into the ground after passing through
      if ((d < 3.5 || (groundWithin(2) && e.velocity.y < -0.3)) && e.elytraFlying) aim = aim.offset(0, 6, 0);
      bot.lookAt(aim, true);

      const chargeDist = Math.max(8, speed * 0.55 + 4); // ~0.4-0.6 s activation delay
      if (!charging && e.elytraFlying && d < chargeDist) startCharge();
      if (charging && d > lastD + 0.4 && d > 5) {       // passed through
        stopCharge();
        passes++;
        if (speed < 20 && rocket()) await boost(token, spear);
      }
      if (charging && now() - chargeStart > 3500) stopCharge();
      if (!e.elytraFlying && e.onGround) break;
      lastD = d;
      await bot.waitForTicks(1);
    }
    stopCharge();
  }

  // ---------- main decision ----------
  function canStunt() {
    return bot.health >= cfg.minHealthForStunts && !ctx.isEating() && now() > stuntCooldownUntil;
  }

  function decide() {
    const e = bot.entity;
    const dist = e.position.distanceTo(target.position);
    const hdist = Math.hypot(target.position.x - e.position.x, target.position.z - e.position.z);
    const style = weaponPref;

    if (ctx.isEating()) {
      drive({ back: reachTo(target) < 3, left: strafe === 1, right: strafe === -1 });
      return;
    }

    // 1) elytra airstrike from far away
    if (canStunt() && opts.air && dist > cfg.airstrikeMinDist && !e.isInWater) {
      const w = airWeapon();
      if (w && (findByName('elytra') || ctx.elytra.isWorn()) && rocket() && skyOpen()) {
        airstrike(w);
        return;
      }
    }
    // 2) wind-charge smash at mid range
    if (canStunt() && opts.wind && e.onGround && hdist <= 9 && has('mace') && findByName('wind_charge') &&
        (style === 'auto' || style === 'mace')) {
      windSmash();
      return;
    }

    // 3) movement: pathfind when far, manual fighting when close
    if (manual && dist > 8.5) manual = false;
    else if (!manual && dist < 6) manual = true;
    if (!manual) {
      stopCharge();
      ctx.pathFollow(target);
      const w = chooseMeleeType(dist);
      if (w) hold(findWeapon(w));
      return;
    }
    ctx.pathStop();

    // spear opener in auto mode: charge in from range, then switch to sword up close
    if (style === 'auto' && has('spear') && has('sword') && dist > 5 && dist < 12) {
      hold(findWeapon('spear'));
      face(target);
      startCharge();
      drive({ forward: true, sprint: true });
      return;
    }
    if (charging && !(bot.heldItem && weaponType(bot.heldItem) === 'spear')) stopCharge();

    const type = chooseMeleeType(dist);
    const item = type ? findWeapon(type) : null;
    if (item) hold(item);
    else if (!type) bot.setQuickBarSlot(bot.quickBarSlot);
    face(target);

    if (type === 'spear' && item) {
      spearTick(item, dist);
      return;
    }
    if (charging) stopCharge();
    meleeTick(type, dist);
  }

  bot.on('physicsTick', () => {
    const e = bot.entity;
    if (!e) return;
    try {
      trackFall();
      if (!target) return;
      if (!valid(target)) { target = null; return; }
      trackTarget();
      if (busy) return;
      decide();
    } catch (err) {
      console.error('combat tick error:', err.message);
    }
  });

  // optional debug output (config: "debugCombat": true)
  if (cfg.debugCombat) {
    const dbg = setInterval(() => {
      if (!bot.entity || !target) return;
      const d = bot.entity.position.distanceTo(target.position);
      log(`target=${target.username || target.name} dist=${d.toFixed(1)} hp=${Math.round(bot.health)} held=${bot.heldItem ? bot.heldItem.name : '-'} ` +
        `hits=${hits} busy=${busy || '-'} manual=${manual} charging=${charging} elytra=${!!bot.entity.elytraFlying} ground=${bot.entity.onGround}`);
    }, 1000);
    bot.once('end', () => clearInterval(dbg));
  }

  // ---------- public API ----------
  function engage(ent) {
    if (!ent) return;
    if (!target || target.id !== ent.id) {
      target = ent;
      tPos = null;
      tVel = new Vec3(0, 0, 0);
      manual = false;
      lockedType = null;
    }
  }
  function disengage() {
    gen++;
    target = null;
    busy = null;
    stopCharge();
    drive({});
  }
  function setWeapon(w) {
    weaponPref = w;
    lockedType = null;
    return w === 'auto' ? true : has(w);
  }
  function loadout() {
    const parts = ['mace', 'spear', 'sword', 'axe'].filter(has);
    return `${parts.join('/') || 'no weapons'} | wind x${countOf('wind_charge')} | rockets x${countOf('firework_rocket')} | elytra ${findByName('elytra') || ctx.elytra.isWorn() ? 'yes' : 'no'} | totems x${countOf('totem_of_undying')}`;
  }
  function status() {
    return `Weapon: ${weaponPref} | air strikes: ${opts.air ? 'on' : 'off'} | wind smash: ${opts.wind ? 'on' : 'off'} | ${loadout()}`;
  }
  function noteKick() {
    if (lastStabAt && now() - lastStabAt < 4000 && !stabDisabled) {
      stabDisabled = true;
      console.log('⚠️  Kicked right after a spear stab packet - disabling stab (using normal attack for spear jabs).');
    }
  }

  return {
    engage,
    disengage,
    setWeapon,
    status,
    loadout,
    noteKick,
    setAir: (v) => { opts.air = !!v; },
    setWind: (v) => { opts.wind = !!v; },
    isBusy: () => !!busy,
    hasTarget: () => !!target,
    getWeapon: () => weaponPref,
    options: opts
  };
}

module.exports = createCombat;
