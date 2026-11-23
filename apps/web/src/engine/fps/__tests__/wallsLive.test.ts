import { describe, it, expect } from 'vitest';
import { FpsSim, FPS_TUNING, type CoverBox, type FpsInput, type Vec3 } from '../FpsSim';
import { CAMPAIGN } from '../campaign';
import { buildChain, entryCap, ROOM_W } from '../endless';

/**
 * Walls stay solid in a LIVE fight, not just in isolated slideMove calls.
 *
 * walls.test.ts proves the collision primitive; this drives the whole sim the
 * way the game does — every room awake, every enemy chasing a moving player,
 * frame times up to the 1/20s cap a struggling phone hits — and checks every
 * enemy on every frame: never standing inside geometry, and never having
 * crossed a wall between one frame and the next.
 */

const R = FPS_TUNING.ENEMY.BODY_R;

function insideAny(x: number, z: number, boxes: readonly CoverBox[], r: number): CoverBox | null {
  for (const c of boxes) {
    if (Math.abs(x - c.x) < c.w / 2 + r - 1e-4 && Math.abs(z - c.z) < c.d / 2 + r - 1e-4) return c;
  }
  return null;
}

/** Does the straight segment a→b pass through the (un-inflated) box? */
function segmentCrosses(ax: number, az: number, bx: number, bz: number, c: CoverBox): boolean {
  const lo = [c.x - c.w / 2, c.z - c.d / 2], hi = [c.x + c.w / 2, c.z + c.d / 2];
  const o = [ax, az], d = [bx - ax, bz - az];
  let t0 = 0, t1 = 1;
  for (let i = 0; i < 2; i++) {
    if (Math.abs(d[i]) < 1e-12) { if (o[i] <= lo[i] || o[i] >= hi[i]) return false; continue; }
    let a = (lo[i] - o[i]) / d[i], b = (hi[i] - o[i]) / d[i];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    if (t0 > t1) return false;
  }
  return t1 - t0 > 1e-6;
}

function mulberry(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Drive a sim for `frames` frames with every enemy chasing a wandering player;
 *  returns wall violations and how far enemies moved in total. */
function runFight(sim: FpsSim, boxes: readonly CoverBox[], start: [number, number], seed: number, frames = 3000) {
  const rng = mulberry(seed);
  const violations: string[] = [];
  let travelled = 0;
  let px = start[0], pz = start[1];
  const prev = new Map(sim.getEnemies().map((e) => [e.id, [e.x, e.z] as [number, number]]));
  for (let f = 0; f < frames && violations.length < 5; f++) {
    // Wander the player around the map so enemies path at walls from every side.
    if (f % 200 === 0) {
      const alive = sim.getEnemies().filter((e) => e.alive);
      const t = alive[Math.floor(rng() * alive.length)];
      if (t) { px = t.x + (rng() - 0.5) * 12; pz = t.z + (rng() - 0.5) * 12; }
    }
    const dt = rng() < 0.3 ? 1 / 20 : 1 / 60; // 1/20 = the sim's own frame cap (slow phone)
    const origin: Vec3 = [px, 1.6, pz];
    const input: FpsInput = { firing: false, wantReload: false, origin, dir: [0, 0, -1], adsFactor: 0, moving: false, crouched: false };
    sim.step(dt, input);
    sim.playerHp = 100; sim.playerAlive = true; // keep the fight running the whole time
    for (const e of sim.getEnemies()) {
      const [ox, oz] = prev.get(e.id) ?? [e.x, e.z];
      prev.set(e.id, [e.x, e.z]);
      if (!e.alive) continue;
      travelled += Math.hypot(e.x - ox, e.z - oz);
      const inside = insideAny(e.x, e.z, boxes, R);
      if (inside) violations.push(`frame ${f} enemy ${e.id} inside box @(${inside.x},${inside.z}) at (${e.x.toFixed(2)}, ${e.z.toFixed(2)})`);
      for (const c of boxes) {
        if (segmentCrosses(ox, oz, e.x, e.z, c)) {
          violations.push(`frame ${f} enemy ${e.id} crossed box @(${c.x},${c.z} ${c.w}x${c.d}) from (${ox.toFixed(2)},${oz.toFixed(2)}) to (${e.x.toFixed(2)},${e.z.toFixed(2)})`);
          break;
        }
      }
    }
  }
  return { violations, travelled };
}

describe('enemies never pass through walls in a live fight', () => {
  for (const m of CAMPAIGN) {
    it(`campaign ${m.id}: every enemy, every frame`, () => {
      const boxes = [...m.walls, ...m.cover];
      const sim = new FpsSim({ gunId: 'sidearm', enemies: m.enemies, cover: boxes, rng: mulberry(3), respawnEnabled: false });
      sim.setAllActive(true);
      const { violations, travelled } = runFight(sim, boxes, m.start, 7);
      expect(violations, violations.join('\n')).toEqual([]);
      expect(travelled, 'enemies must actually move, or this proves nothing').toBeGreaterThan(5);
    });
  }

  for (const seed of [1, 42, 9001]) {
    it(`endless chain (seed ${seed}): every enemy, every frame`, () => {
      const rooms = buildChain(0, 6, 0, seed);
      const boxes: CoverBox[] = [...entryCap(0)];
      for (const r of rooms) boxes.push(...r.walls, ...r.cover);
      const sim = new FpsSim({ gunId: 'sidearm', enemies: [], cover: [], rng: mulberry(seed), respawnEnabled: false });
      sim.appendCover(boxes);
      for (const r of rooms) sim.appendEnemies(r.enemies, true);
      const half = ROOM_W / 2 - 0.3;
      sim.setBounds(-half, half, rooms[rooms.length - 1].zFar, rooms[0].zNear);
      const { violations, travelled } = runFight(sim, boxes, [0, rooms[0].zNear - 2], seed);
      expect(violations, violations.join('\n')).toEqual([]);
      expect(travelled, 'enemies must actually move, or this proves nothing').toBeGreaterThan(5);
    });
  }
});
