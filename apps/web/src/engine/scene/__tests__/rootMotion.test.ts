import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { inPlace } from '../rootMotion';

/** A run cycle shaped like operator.glb's: Z-up hips space, travelling along Y. */
function runClip(): THREE.AnimationClip {
  const times = [0, 0.4, 0.8];
  const values = [
    -0.3, 1.9, -74.5,
    -0.2, 117, -76.0,
    -0.2, 233.8, -77.8,
  ];
  return new THREE.AnimationClip('run', 0.8, [
    new THREE.VectorKeyframeTrack('mixamorigHips.position', times, values),
    new THREE.VectorKeyframeTrack('mixamorigSpine.position', times, [0, 10, 0, 0, 10, 0, 0, 10, 0]),
  ]);
}

describe('inPlace (root motion stripping)', () => {
  it('removes the travel but keeps the hip height bob', () => {
    const out = inPlace(runClip());
    const v = out.tracks[0].values;
    // Horizontal (x, y here) pinned to the first frame: no travel.
    expect([v[3], v[4], v[6], v[7]]).toEqual([v[0], v[1], v[0], v[1]]);
    // Height (z) untouched: the bob survives.
    expect(Array.from([v[2], v[5], v[8]]).map((x) => +x.toFixed(1))).toEqual([-74.5, -76, -77.8]);
  });

  it('finds the height axis from the first frame, even when travel averages larger', () => {
    // Over the whole run clip the Y travel averages ~118, more than the ~76 height;
    // an average-based guess would pin the height and keep the travel.
    const v = inPlace(runClip()).tracks[0].values;
    expect(v[7]).toBeCloseTo(1.9);
  });

  it('leaves the cached source clip and non-hips tracks alone', () => {
    const src = runClip();
    inPlace(src);
    expect(src.tracks[0].values[7]).toBeCloseTo(233.8);
    const out = inPlace(src);
    expect(Array.from(out.tracks[1].values)).toEqual([0, 10, 0, 0, 10, 0, 0, 10, 0]);
  });

  it('handles a Y-up armature too', () => {
    const clip = new THREE.AnimationClip('walk', 1, [
      new THREE.VectorKeyframeTrack('Hips.position', [0, 1], [0.1, 95, 0.2, 0.1, 97, 140]),
    ]);
    const v = inPlace(clip).tracks[0].values;
    expect(Array.from(v)).toEqual([0.1, 95, 0.2, 0.1, 97, 0.2].map((x) => Math.fround(x)));
  });
});
