import * as THREE from 'three';
import { classifyMoveDir, type MoveDir } from '../animation/AnimationStateMachine';
import type { OperatorApi } from './OperatorRig';

/**
 * Locomotion for an operator.glb body driven by movement rather than by a sim:
 * your own third-person soldier (ValorScene) and the Face-Off opponent
 * (ArenaScene). Both call this every frame with how the body is moving
 * relative to where it faces.
 */

/** Ground speed (m/s) each operator.glb locomotion clip covers at timeScale 1,
 *  measured from its root motion at the in-game scale. Clips play at the rate
 *  that matches the real speed, so planted feet stay planted. */
export const OPERATOR_CLIP_SPEED = { walk: 1.02, run: 3.17, stepLeft: 2.79, stepRight: 3.31 } as const;

export interface LocomotionInput {
  alive: boolean;
  /** Movement along the body's facing (+ forward) and to its right (+ right),
   *  as fractions of `speed` (a stick/keys amount, or velocity / speed). */
  fwd: number;
  right: number;
  /** Full movement speed in m/s (what fwd/right are fractions of). */
  speed: number;
  /** 0..1 crouch amount. */
  crouch: number;
  ads: boolean;
}

/**
 * Pick and pace the clip, crouch and side-shuffle. Returns the movement
 * direction to pass back next frame (it carries hysteresis).
 */
export function driveOperatorLocomotion(rig: OperatorApi, inp: LocomotionInput, prevDir: MoveDir): MoveDir {
  rig.setCrouch(inp.alive ? inp.crouch : 0);
  const crouched = inp.crouch > 0.5;
  let shuffle: -1 | 0 | 1 = 0;
  let dir = prevDir;
  const moving = Math.abs(inp.fwd) > 0.02 || Math.abs(inp.right) > 0.02;
  if (!inp.alive) rig.setClip('death');
  else if (!moving) rig.setClip('idle'); // rifle shouldered
  else {
    dir = classifyMoveDir(inp.fwd, inp.right, prevDir);
    const ground = inp.speed * Math.hypot(inp.fwd, inp.right);
    const rate = (clipSpeed: number) => Math.max(0.6, Math.min(1.9, ground / clipSpeed));
    // Crouched sidesteps step over the idle stance (see setShuffle): the strafe
    // clips' turned hips point a crouched soldier's knees sideways.
    if (crouched && (dir === 'left' || dir === 'right')) { rig.setClip('idle'); shuffle = dir === 'left' ? 1 : -1; }
    // operator.glb's strafe clips are named backwards: 'strafeR' steps to the
    // body's LEFT and 'strafeL' to its RIGHT (measured from their root motion).
    else if (dir === 'left') rig.setClip('strafeR', rate(OPERATOR_CLIP_SPEED.stepLeft));
    else if (dir === 'right') rig.setClip('strafeL', rate(OPERATOR_CLIP_SPEED.stepRight));
    // No walk-backwards clip: the walk played in reverse reads as a back-pedal.
    else if (dir === 'back') rig.setClip('walk', -rate(OPERATOR_CLIP_SPEED.walk));
    else if (crouched || inp.ads) rig.setClip('walk', rate(OPERATOR_CLIP_SPEED.walk));
    else rig.setClip('run', rate(OPERATOR_CLIP_SPEED.run));
  }
  rig.setShuffle(shuffle);
  return dir;
}

/**
 * Camera-yaw convention shared with arena_server.rs: forward = (-sin, -cos),
 * right = (cos, -sin). `localToWorldXZ` turns a forward/right move into a
 * world X/Z delta; `worldToLocalFwdRight` is its inverse, decomposing a
 * world-space vector (a hit direction, a velocity) back into forward/right.
 * One shared pair instead of each call site re-deriving the same trig, which
 * is what let the client and arena_server.rs drift apart before.
 */
export function localToWorldXZ(yaw: number, forward: number, right: number): [number, number] {
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  return [-sy * forward + cy * right, -cy * forward - sy * right];
}

export function worldToLocalFwdRight(yaw: number, worldX: number, worldZ: number): [number, number] {
  const sy = Math.sin(yaw), cy = Math.cos(yaw);
  return [worldX * -sy + worldZ * -cy, worldX * cy + worldZ * -sy];
}

const AIM_M = new THREE.Matrix4();
const AIM_Q = new THREE.Quaternion();
const AIM_D = new THREE.Vector3();
const ZERO = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** Point the body's rifle along a world direction (+Z of the rifle = barrel). */
export function aimOperatorAlong(rig: OperatorApi, dir: THREE.Vector3): void {
  AIM_M.lookAt(dir, ZERO, UP); // object convention: +Z toward the target
  AIM_Q.setFromRotationMatrix(AIM_M);
  rig.setAim(AIM_Q);
}

/** Point the rifle where a camera-convention yaw/pitch looks (yaw 0 = -Z, +pitch = up). */
export function aimOperatorYawPitch(rig: OperatorApi, yaw: number, pitch: number): void {
  const cp = Math.cos(pitch);
  aimOperatorAlong(rig, AIM_D.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp));
}
