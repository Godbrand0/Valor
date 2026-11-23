/**
 * Third-person (over-the-shoulder) camera for the FPS.
 *
 * The player's EYE stays exactly where first person puts it: every gameplay
 * system (movement, the sim's shot origin, co-op position reports, lean, crouch)
 * keeps using the eye. Only the RENDER camera moves — back along the view
 * direction and out over the right shoulder — so switching views can never change
 * where you are, what you can be hit by, or what you can hit.
 *
 * Two problems that come with a camera behind the head, solved here as pure
 * functions so they can be tested without a renderer:
 *
 *  1. The camera must never sit inside a wall. `placeCamera` sweeps from the eye
 *     to the desired spot and pulls the camera in short of the first surface.
 *
 *  2. Shooting must stay honest. The crosshair is in the middle of the CAMERA's
 *     view, but bullets must come from the EYE — otherwise you could shoot from a
 *     spot your soldier cannot see from (over a wall your camera is peeking past).
 *     `aimPoint` finds what is under the crosshair; the shot then flies from the
 *     eye toward that point, so whatever is really between your soldier and the
 *     target takes the round instead.
 */

import { aabbOfCover, bodyZones, rayAABB, raySphere, rayGround, FPS_TUNING, type CoverBox, type Vec3 } from '../fps/FpsSim';

export type CameraView = 'first' | 'third';

/** Distance behind the eye: hip-fire, and aiming down sights (pulled in tight). */
export const TPP_DIST_HIP = 2.6;
export const TPP_DIST_ADS = 1.25;
/** Out over the right shoulder, so the body doesn't cover the crosshair. */
export const TPP_SHOULDER_HIP = 0.6;
export const TPP_SHOULDER_ADS = 0.45;
/** A little above the eye, looking slightly down over the shoulder. */
export const TPP_RAISE = 0.25;
/** Clearance kept between the camera and any surface. */
export const TPP_CAM_RADIUS = 0.2;
/** Never closer than this (inside the head reads as a glitch). */
export const TPP_MIN_DIST = 0.45;
/** How far the aim ray looks for something under the crosshair. */
export const AIM_MAX = 80;

const VIEW_KEY = 'valor_camera_view';

export function loadCameraView(): CameraView {
  if (typeof window === 'undefined') return 'first';
  try { return window.localStorage.getItem(VIEW_KEY) === 'third' ? 'third' : 'first'; } catch { return 'first'; }
}

export function saveCameraView(v: CameraView): void {
  try { window.localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
}

/** Nearest hit distance along a normalised ray against the boxes, each padded by
 *  `pad` on every side (so a sphere of that radius stops clear of the surface in
 *  every direction, corners included), or Infinity. */
function nearestBox(o: Vec3, d: Vec3, boxes: readonly CoverBox[], pad = 0): number {
  let t = Infinity;
  for (const c of boxes) {
    const [min, max] = aabbOfCover(c);
    const h = rayAABB(o, d, [[min[0] - pad, min[1] - pad, min[2] - pad], [max[0] + pad, max[1] + pad, max[2] + pad]]);
    if (h !== null && h < t) t = h;
  }
  return t;
}

/**
 * Where to put the camera: behind the eye along -fwd, out along `right`, up a
 * touch — pulled in short of the first wall on the way. `ads` (0..1) blends to the
 * tighter aiming framing. Returns the position and how far back it ended up.
 */
export function placeCamera(
  eye: Vec3, fwd: Vec3, right: Vec3, ads: number, boxes: readonly CoverBox[],
): { pos: Vec3; dist: number } {
  const back = TPP_DIST_HIP + (TPP_DIST_ADS - TPP_DIST_HIP) * ads;
  const side = TPP_SHOULDER_HIP + (TPP_SHOULDER_ADS - TPP_SHOULDER_HIP) * ads;
  const want: Vec3 = [
    eye[0] - fwd[0] * back + right[0] * side,
    eye[1] - fwd[1] * back + TPP_RAISE,
    eye[2] - fwd[2] * back + right[2] * side,
  ];
  // Keep the camera above the floor.
  want[1] = Math.max(want[1], TPP_CAM_RADIUS + 0.05);
  const dx = want[0] - eye[0], dy = want[1] - eye[1], dz = want[2] - eye[2];
  const len = Math.hypot(dx, dy, dz) || 1;
  const dir: Vec3 = [dx / len, dy / len, dz / len];
  const hit = nearestBox(eye, dir, boxes, TPP_CAM_RADIUS);
  const dist = Math.max(Math.min(TPP_MIN_DIST, len), Math.min(len, hit));
  return { pos: [eye[0] + dir[0] * dist, eye[1] + dir[1] * dist, eye[2] + dir[2] * dist], dist };
}

export interface AimTarget { x: number; z: number; alive: boolean }

/**
 * The world point under the crosshair: the first wall, floor or enemy the
 * CAMERA's centre ray meets in front of the player. Hits between the camera and
 * the eye are ignored — that is behind the soldier, and the camera merely looks
 * past it.
 */
export function aimPoint(
  camPos: Vec3, fwd: Vec3, eye: Vec3, boxes: readonly CoverBox[], enemies: readonly AimTarget[],
): Vec3 {
  // Start the search level with the eye along the ray, not at the camera.
  const t0 = Math.max(0, (eye[0] - camPos[0]) * fwd[0] + (eye[1] - camPos[1]) * fwd[1] + (eye[2] - camPos[2]) * fwd[2]);
  let best = AIM_MAX;
  const consider = (t: number | null) => { if (t !== null && t > t0 && t < best) best = t; };
  for (const c of boxes) consider(rayAABB(camPos, fwd, aabbOfCover(c)));
  consider(rayGround(camPos, fwd));
  for (const e of enemies) {
    if (!e.alive) continue;
    for (const z of bodyZones(e)) consider(rayAABB(camPos, fwd, [z.min, z.max]));
    consider(raySphere(camPos, fwd, [e.x, FPS_TUNING.HEAD_Y, e.z], FPS_TUNING.HEAD_RADIUS));
  }
  return [camPos[0] + fwd[0] * best, camPos[1] + fwd[1] * best, camPos[2] + fwd[2] * best];
}

/**
 * The direction a shot leaves the EYE so it lands where the crosshair is.
 * Falls back to the plain view direction when the target is too close to give a
 * stable direction (point-blank against a wall).
 */
export function aimDirFromEye(eye: Vec3, target: Vec3, fwd: Vec3): Vec3 {
  const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
  const len = Math.hypot(dx, dy, dz);
  if (len < 0.5) return fwd;
  const d: Vec3 = [dx / len, dy / len, dz / len];
  // Never fire backwards out of the eye (target behind the soldier's own facing).
  if (d[0] * fwd[0] + d[1] * fwd[1] + d[2] * fwd[2] < 0.2) return fwd;
  return d;
}
