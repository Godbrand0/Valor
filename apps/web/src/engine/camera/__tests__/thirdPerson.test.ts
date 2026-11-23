import { describe, it, expect } from 'vitest';
import { placeCamera, aimPoint, aimDirFromEye, TPP_DIST_HIP, TPP_CAM_RADIUS, TPP_MIN_DIST } from '../thirdPerson';
import type { CoverBox, Vec3 } from '../../fps/FpsSim';

// Looking down -Z (three's default forward), right is +X.
const EYE: Vec3 = [0, 1.6, 0];
const FWD: Vec3 = [0, 0, -1];
const RIGHT: Vec3 = [1, 0, 0];

describe('placeCamera', () => {
  it('sits behind and over the right shoulder in the open', () => {
    const { pos, dist } = placeCamera(EYE, FWD, RIGHT, 0, []);
    expect(pos[2]).toBeGreaterThan(2);       // behind (+Z)
    expect(pos[0]).toBeGreaterThan(0.4);     // right shoulder
    expect(pos[1]).toBeGreaterThan(EYE[1]);  // a touch above
    expect(dist).toBeGreaterThan(TPP_DIST_HIP);
  });

  it('aiming down sights pulls the camera in tight', () => {
    const hip = placeCamera(EYE, FWD, RIGHT, 0, []).dist;
    const ads = placeCamera(EYE, FWD, RIGHT, 1, []).dist;
    expect(ads).toBeLessThan(hip * 0.6);
  });

  it('never ends up inside or behind a wall at your back', () => {
    // A 0.6 m wall 1 m behind the player.
    const wall: CoverBox = { x: 0, z: 1.3, w: 10, d: 0.6, h: 4 };
    const { pos } = placeCamera(EYE, FWD, RIGHT, 0, [wall]);
    expect(pos[2]).toBeLessThanOrEqual(1.0 - TPP_CAM_RADIUS + 1e-6); // full clearance from the wall face
  });

  it('keeps a minimum distance even when boxed in', () => {
    const wall: CoverBox = { x: 0, z: 0.4, w: 10, d: 0.2, h: 4 };
    const { dist } = placeCamera(EYE, FWD, RIGHT, 0, [wall]);
    expect(dist).toBeGreaterThanOrEqual(TPP_MIN_DIST - 1e-6);
  });
});

describe('aimPoint / aimDirFromEye', () => {
  const cam = placeCamera(EYE, FWD, RIGHT, 0, []).pos;

  it('finds an enemy under the crosshair, and the shot from the eye goes at it', () => {
    // Enemy 10 m ahead, slightly right; the player puts the crosshair on its chest.
    const ex = 0.8, ez = -10;
    const chest: Vec3 = [ex, 1.2, ez];
    const len = Math.hypot(chest[0] - cam[0], chest[1] - cam[1], chest[2] - cam[2]);
    const camFwd: Vec3 = [(chest[0] - cam[0]) / len, (chest[1] - cam[1]) / len, (chest[2] - cam[2]) / len];
    const p = aimPoint(cam, camFwd, EYE, [], [{ x: ex, z: ez, alive: true }]);
    expect(Math.abs(p[2] - ez)).toBeLessThan(0.5); // hit the enemy, not the far distance
    const d = aimDirFromEye(EYE, p, camFwd);
    // Follow the eye ray to the enemy's depth: it lands on the enemy's body.
    const k = (ez - EYE[2]) / d[2];
    expect(Math.abs(EYE[0] + d[0] * k - ex)).toBeLessThan(0.3);
    expect(EYE[1] + d[1] * k).toBeGreaterThan(0.9);
    expect(EYE[1] + d[1] * k).toBeLessThan(1.6);
  });

  it('ignores things between the camera and the eye (behind the soldier)', () => {
    const behind: CoverBox = { x: cam[0], z: 1.0, w: 0.4, d: 0.4, h: 3 };
    const p = aimPoint(cam, FWD, EYE, [behind], []);
    expect(p[2]).toBeLessThan(EYE[2]); // the point is in front of the player, not the box at their back
  });

  it('never fires backwards or sideways from point-blank targets', () => {
    expect(aimDirFromEye(EYE, [0, 1.6, 0.1], FWD)).toEqual(FWD);
    expect(aimDirFromEye(EYE, [5, 1.6, 0.5], FWD)).toEqual(FWD);
  });
});
