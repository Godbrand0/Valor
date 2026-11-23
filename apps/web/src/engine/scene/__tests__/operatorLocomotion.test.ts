import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { driveOperatorLocomotion, aimOperatorYawPitch, OPERATOR_CLIP_SPEED } from '../operatorLocomotion';
import type { OperatorApi } from '../OperatorRig';

function fakeRig() {
  const calls = { clip: '' as string, rate: 0, crouch: -1, shuffle: 99 as number, aim: null as THREE.Quaternion | null };
  const rig = {
    setClip: (n: string, r = 1) => { calls.clip = n; calls.rate = r; },
    setCrouch: (c: number) => { calls.crouch = c; },
    setShuffle: (s: number) => { calls.shuffle = s; },
    setAim: (q: THREE.Quaternion | null) => { calls.aim = q ? q.clone() : null; },
  } as unknown as OperatorApi;
  return { rig, calls };
}
const base = { alive: true, speed: 3.4, crouch: 0, ads: false };

describe('driveOperatorLocomotion', () => {
  it('plays the clip that really steps the way the body moves (strafe names are swapped in the model)', () => {
    const { rig, calls } = fakeRig();
    driveOperatorLocomotion(rig, { ...base, fwd: 0, right: 1 }, 'forward');
    expect(calls.clip).toBe('strafeL');
    driveOperatorLocomotion(rig, { ...base, fwd: 0, right: -1 }, 'right');
    expect(calls.clip).toBe('strafeR');
  });

  it('back-pedals with the walk reversed, and paces clips to ground speed', () => {
    const { rig, calls } = fakeRig();
    driveOperatorLocomotion(rig, { ...base, fwd: -1, right: 0 }, 'forward');
    expect(calls.clip).toBe('walk');
    expect(calls.rate).toBeLessThan(0);
    driveOperatorLocomotion(rig, { ...base, fwd: 1, right: 0 }, 'back');
    expect(calls.clip).toBe('run');
    expect(calls.rate).toBeCloseTo(3.4 / OPERATOR_CLIP_SPEED.run, 2);
  });

  it('crouched sidesteps shuffle over the idle stance; standing still idles; dead dies', () => {
    const { rig, calls } = fakeRig();
    driveOperatorLocomotion(rig, { ...base, crouch: 1, fwd: 0, right: -1 }, 'forward');
    expect([calls.clip, calls.shuffle, calls.crouch]).toEqual(['idle', 1, 1]); // toward its left = +1
    driveOperatorLocomotion(rig, { ...base, fwd: 0, right: 0 }, 'forward');
    expect([calls.clip, calls.shuffle]).toEqual(['idle', 0]);
    driveOperatorLocomotion(rig, { ...base, alive: false, crouch: 1, fwd: 1, right: 0 }, 'forward');
    expect([calls.clip, calls.crouch]).toEqual(['death', 0]);
  });
});

describe('aimOperatorYawPitch', () => {
  it('points the rifle (+Z) where a camera-convention yaw looks: yaw 0 = -Z, yaw PI/2 = -X', () => {
    const { rig, calls } = fakeRig();
    const barrel = () => new THREE.Vector3(0, 0, 1).applyQuaternion(calls.aim!);
    aimOperatorYawPitch(rig, 0, 0);
    expect(barrel().z).toBeCloseTo(-1, 5);
    aimOperatorYawPitch(rig, Math.PI / 2, 0);
    expect(barrel().x).toBeCloseTo(-1, 5);
    aimOperatorYawPitch(rig, 0, 0.4);
    expect(barrel().y).toBeCloseTo(Math.sin(0.4), 5);
  });
});
