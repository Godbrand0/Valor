import * as THREE from 'three';

/**
 * Strip ROOT MOTION from a clip: pin the hips' horizontal position, keep its height.
 *
 * The Mixamo clips in operator.glb travel. Per loop the hips move about 2.3 m
 * forward in `run`, 2.2 m / 1.5 m sideways in the strafes, 1.4 m in `walk`, and the
 * `death` fall slides 1.4 m. The game already moves each body itself (the scene
 * places the rig at the sim position every frame), so that baked travel was added ON
 * TOP: the drawn soldier ran up to ~2 m ahead of where the sim had it, along a path
 * nothing collided — straight through walls the sim had correctly stopped it at —
 * then snapped back when the loop restarted. Hit detection used the sim position, so
 * the body you saw was not even where your rounds would land.
 *
 * The vertical axis is taken from the data (the component holding the hip HEIGHT
 * on the first frame, by far the largest there) rather than assumed, because this armature's hips
 * space is Z-up while most Mixamo exports are Y-up. Every frame's two horizontal
 * components are set to the first frame's, so the stride, the bob and the fall all
 * survive and only the travel is removed. Works on a clone: the GLTF's clips are
 * cached and shared.
 */
export function inPlace(source: THREE.AnimationClip): THREE.AnimationClip {
  const clip = source.clone();
  for (const track of clip.tracks) {
    if (!/hips\.position$/i.test(track.name)) continue;
    // clip.clone() can hand the clone the SAME typed array (three's convertArray
    // returns its input when the type already matches), so copy before writing.
    track.values = track.values.slice();
    const v = track.values;
    const n = v.length / 3;
    if (n < 2) continue;
    // Read the axis off the FIRST frame, before any travel: there the hip height
    // (~75–95 cm) dwarfs the other two (~0). An average over the clip is wrong for
    // exactly the clips this is for — `run` travels 234 cm, so its travel axis
    // averages more than the height does.
    const f0 = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])];
    const up = f0.indexOf(Math.max(...f0));
    for (let a = 0; a < 3; a++) {
      if (a === up) continue;
      const first = v[a];
      for (let i = 1; i < n; i++) v[i * 3 + a] = first;
    }
  }
  return clip;
}
