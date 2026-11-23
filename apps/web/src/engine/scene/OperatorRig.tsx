'use client';

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import * as THREE from 'three';
import { FPS_TUNING } from '../fps';
import { useRiflePrototype, cloneRifle } from './rifle';
import { inPlace } from './rootMotion';

/** Melee props baked into the placeholder body. A shooter carries none of these. */
const STRIP = /sword|shield/i;
/**
 * Mixamo grip bone. NOTE: three's GLTFLoader SANITISES node names, so the file's
 * `mixamorig:RightHand` is `mixamorig_RightHand` once loaded. Match by suffix,
 * never by exact name — and `$` keeps us off RightHandIndex1 etc.
 */
const GRIP_BONE = /righthand$/i;
/** Grip offset in hand-bone space. Tuned against the aim-idle pose. */
const GUN_POS = new THREE.Vector3(0, 0, 0.18);
/** Procedural crouch bend at full crouch (radians, bone-local X): thighs swing
 *  forward, shins fold back under them (knees point the way he faces), and the
 *  torso leans in. Measured against the idle pose so the head drops ~0.57 m,
 *  matching the first-person EYE_STAND -> EYE_CROUCH drop. */
const CROUCH_HIP = 1.0;
const CROUCH_KNEE = -1.9;
const CROUCH_LEAN = 0.5;
/** Crouched side-step: steps per second (each a step-out + close), how far the
 *  thighs open (rad), and how much the moving leg lifts (extra knee bend, rad). */
const SHUFFLE_HZ = 2.2;
const SHUFFLE_SPREAD = 0.36;
const SHUFFLE_LIFT = 0.4;

/**
 * A rifle-carrying enemy body (the plan slice 7b).
 *
 * The skeleton and clips come from `operator.glb` (Mixamo X Bot's rifle set
 * grafted onto a skinned body by scripts/build_operator_glb.py). The BODY mesh
 * is a placeholder: swapping it is one asset change, because clip names and the
 * skeleton stay put.
 *
 * Each instance clones the skeleton AND its materials, so one enemy's hit-flash
 * can't tint the whole squad. The rig is auto-scaled to TARGET_H and grounded,
 * which keeps the visible body aligned with FpsSim's maths hitboxes (head at
 * 1.62m, torso to 1.46m) rather than relying on whatever units the source used.
 */

export type ClipName = 'idle' | 'walk' | 'run' | 'strafeL' | 'strafeR' | 'fire' | 'reload' | 'hit' | 'death';

/** Matches FPS_TUNING's hitbox height so what you see is what you shoot. */
// (height comes from the head bone; see below)
const FADE = 0.18;
/** Gap kept between the lowest point of the SKIN and the floor. Covers the error
 *  of sampling every SKIN_STRIDE-th vertex (measured under 1 cm). */
const SKIN_CLEARANCE = 0.008;
/** Ground against every Nth vertex: ~1.4k of the operator's 11.4k, ample for a floor test. */
const SKIN_STRIDE = 8;
/** How long a corpse keeps re-grounding after death (the fall has settled by then). */
const DEATH_SETTLE_S = 3.5;

export interface OperatorApi {
  /** Crossfade to a looping clip. A negative `timeScale` plays it backwards
   *  (the standard back-pedal trick when there is no walk-backwards clip). */
  setClip(name: ClipName, timeScale?: number): void;
  /**
   * Hold the rifle along this WORLD orientation (+Z = barrel) every frame, in the
   * grip hand, instead of the one-off alignment. For the player's own third-person
   * body, whose rifle must follow the real aim. `null` returns to the default.
   * Enemies never call this, so their rifles keep their existing hold.
   */
  setAim(q: THREE.Quaternion | null): void;
  /** Procedural crouch, 0 (standing) .. 1 (full). The model has no crouch clip, so
   *  this bends hips and knees on top of whatever clip is playing and lowers the
   *  body until the feet are back on the floor. */
  setCrouch(amount: number): void;
  /** Crouched side-step, toward the body's left (+1) or right (-1); 0 stops.
   *  The strafe clips crab-walk with the hips turned ~65 degrees, which a crouch
   *  bend turns into knees pointing sideways; so a crouched sidestep plays over
   *  the idle stance instead, with the legs stepping out and closing in. */
  setShuffle(side: -1 | 0 | 1): void;
  /** Fire a one-shot clip over the top (returns to the looping clip after). */
  playOnce(name: ClipName, timeScale?: number): void;
  /** Emissive tint: the aim telegraph (amber) and the hit flash (red). */
  setTint(hex: number, intensity: number): void;
  /** Diagnostics: where did the rifle actually end up? */
  debug(): Record<string, unknown>;
}

export const OperatorRig = forwardRef<OperatorApi, { modelPath: string }>(function OperatorRig({ modelPath }, ref) {
  const { scene, animations } = useGLTF(modelPath);
  const rifleProto = useRiflePrototype();
  const groupRef = useRef<THREE.Group>(null);
  const mixerRef = useRef<THREE.AnimationMixer | null>(null);
  const actions = useRef<Partial<Record<ClipName, THREE.AnimationAction>>>({});
  const current = useRef<ClipName | null>(null);
  const oneShot = useRef<THREE.AnimationAction | null>(null);
  const mats = useRef<THREE.MeshStandardMaterial[]>([]);
  const gunRef = useRef<THREE.Object3D | null>(null);
  const gripRef = useRef<THREE.Object3D | null>(null);
  const aligned = useRef(false);
  const dead = useRef(false);
  const groundBones = useRef<THREE.Object3D[]>([]);

  // Clone skeleton + materials per instance, normalise scale, sit it on the floor.
  const rig = useMemo(() => {
    const clone = SkeletonUtils.clone(scene) as THREE.Group;

    // The placeholder body ships melee props (Paladin sword + shield). Bin them:
    // a shooter carries a rifle, and it goes in the grip hand below.
    for (const o of [...clone.children, ...clone.getObjectsByProperty('isMesh', true)]) {
      if (STRIP.test(o.name)) o.visible = false;
    }

    const skinnedMeshes: THREE.SkinnedMesh[] = [];
    clone.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || STRIP.test(mesh.name)) return;
      mesh.castShadow = true;

      // Frustum culling STAYS ON, with padded bounds.
      //
      // This used to be `frustumCulled = false`, on the reasoning that a skinned
      // mesh's bounds come from the bind pose and understate an animating body. That
      // is true, but switching culling off is the wrong remedy: it means every rig in
      // the mission is submitted every frame even when it is behind the player, and
      // each operator is 46,301 triangles across two primitives. Measured on the
      // touch/minimal tier, nine rigs accounted for 417k of the frame's 440k triangles
      // — 95% of all geometry, on the quality tier that is supposed to be the escape
      // hatch for a struggling phone. No quality setting touched it, which is exactly
      // why LOW felt like it did nothing.
      //
      // The correct remedy for lying bind-pose bounds is to PAD them. The bind sphere
      // already encloses the whole body; 2.5x gives a wide margin for any pose the rig
      // reaches (arms out, ragdoll fall) while still rejecting anyone off-screen, so
      // nothing you could actually see can pop.
      //
      // Guarded by a flag because SkeletonUtils.clone SHARES geometry between clones:
      // without it, 36 endless rigs would each inflate the same sphere and the radius
      // would compound into infinity, culling nothing.
      // The sphere MUST be set on the mesh, not the geometry. three.js r184's
      // Frustum.intersectsObject takes the object's own bounding sphere whenever the
      // property exists, and SkinnedMesh declares one (initialised null):
      //
      //   if ( object.boundingSphere !== undefined ) {
      //     if ( object.boundingSphere === null ) object.computeBoundingSphere();
      //
      // so padding geometry.boundingSphere is simply never read for a skinned mesh.
      // Leaving it null instead makes three call SkinnedMesh.computeBoundingSphere(),
      // which walks EVERY vertex through applyBoneTransform — 31,687 of them per rig —
      // and then caches the result, so the sphere is also a one-shot snapshot of
      // whatever pose the rig happened to be in. That is the original "skinned bounds
      // lie" complaint, just relocated: a later pose can reach outside it and the body
      // vanishes at the screen edge.
      //
      // Setting it explicitly fixes all three: no per-vertex walk, no pose snapshot,
      // and the padding actually applies. Radius comes from the geometry's bind-pose
      // sphere (cheap, no skinning) with generous headroom for any reachable pose.
      mesh.frustumCulled = true;
      const skinned = mesh as unknown as THREE.SkinnedMesh;
      if (skinned.isSkinnedMesh) skinnedMeshes.push(skinned); // cull sphere set after scaling, below
      const src = mesh.material as THREE.Material | THREE.Material[];
      const cloneMat = (m: THREE.Material) => {
        const c = m.clone() as THREE.MeshStandardMaterial;
        if (c.emissive) { c.emissive.setHex(0x000000); c.emissiveIntensity = 0; }
        // Without the amber tell, enemies must read on silhouette + light alone.
        if (c.color) c.color.multiplyScalar(1.7);
        c.roughness = Math.min(1, (c.roughness ?? 0.8) + 0.1);
        mats.current.push(c);
        return c;
      };
      mesh.material = Array.isArray(src) ? src.map(cloneMat) : cloneMat(src);
    });

    // Do NOT measure a skinned mesh with Box3: its bounds come from the bind pose
    // and lie badly (which is why the cull sphere above is padded rather than
    // trusted as-is). Scale from the HEAD BONE,
    // which also lands the model's head exactly on the sim's head hitbox.
    clone.updateMatrixWorld(true);
    let head: THREE.Object3D | null = null;
    clone.traverse((o) => {
      if (!head && (o as THREE.Bone).isBone && /head$/i.test(o.name)) head = o;
    });
    if (head) {
      const headY = new THREE.Vector3().setFromMatrixPosition((head as THREE.Object3D).matrixWorld).y;
      if (headY > 0.05) clone.scale.setScalar(FPS_TUNING.HEAD_Y / headY);
    }
    clone.updateMatrixWorld(true);

    // Cull sphere, set in WORLD terms. It used to be the geometry's bind sphere x2.5,
    // but that sphere is in the mesh's own units, and the mesh sits under Mixamo's
    // centimetre armature scale (~0.0105 here) — so the "padded" sphere was about
    // 3 cm across, at the feet. Anything that put a body's feet off-screen culled
    // the whole body: an enemy right in front of you with their feet below the
    // frame, and your own soldier in third person (camera close behind, looking
    // forward) — which drew as a rifle floating with no one holding it.
    //
    // Now: a sphere centred at hip height with room for the whole standing body,
    // the rifle and a death fall, converted into each mesh's local space so it is
    // right whatever scale the file uses.
    const cullCentre = new THREE.Vector3(0, 0.9, 0);
    const CULL_R = 1.9;
    for (const sk of skinnedMeshes) {
      const c = sk.worldToLocal(clone.localToWorld(cullCentre.clone()));
      const ws = sk.getWorldScale(new THREE.Vector3()).x || 1;
      sk.boundingSphere = new THREE.Sphere(c, CULL_R / ws);
    }

    // A real rifle in the grip hand. The rig inherits the bone's world scale, so
    // undo it or the gun comes out the size of the room.
    let gripFound: THREE.Object3D | null = null;
    clone.traverse((o) => {
      if (!gripFound && (o as THREE.Bone).isBone && GRIP_BONE.test(o.name)) gripFound = o;
    });
    const grip = gripFound as THREE.Object3D | null; // TS can't see closure writes
    if (grip) {
      const gun = cloneRifle(rifleProto);
      // Undo the bone's world scale so the rifle is life-sized. Orientation is
      // aligned on the first ANIMATED frame (see below) — the bind pose is not
      // the pose the character actually stands in.
      const ws = new THREE.Vector3();
      grip.getWorldScale(ws);
      gun.scale.setScalar(ws.x > 1e-6 ? 1 / ws.x : 1);
      gun.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.castShadow = true; });
      gun.userData.valorRifle = true;
      grip.add(gun);
      gunRef.current = gun;
      gripRef.current = grip;
      aligned.current = false;
    }
    // Bones we ground a corpse against: whichever ends up lowest holds the floor.
    groundBones.current = [];
    clone.traverse((o) => {
      if ((o as THREE.Bone).isBone && /(hips|leftfoot|rightfoot|head|leftforearm|rightforearm)$/i.test(o.name)) {
        groundBones.current.push(o);
      }
    });

    clone.updateMatrixWorld(true);
    return clone;
  }, [scene, rifleProto]);

  useEffect(() => {
    const mixer = new THREE.AnimationMixer(rig);
    mixerRef.current = mixer;
    for (const source of animations) {
      const clip = inPlace(source);
      const name = clip.name as ClipName;
      const action = mixer.clipAction(clip);
      actions.current[name] = action;
    }
    const idle = actions.current.idle;
    if (idle) { idle.play(); current.current = 'idle'; }
    return () => { mixer.stopAllAction(); mixerRef.current = null; };
  }, [rig, animations]);

  useImperativeHandle(ref, (): OperatorApi => ({
    setClip(name, timeScale = 1) {
      const next = actions.current[name];
      if (!next) return;
      if (current.current === name) { next.timeScale = timeScale; return; }
      next.timeScale = timeScale;
      const prev = current.current ? actions.current[current.current] : null;
      if (name === 'death') {
        next.reset();
        next.setLoop(THREE.LoopOnce, 1);
        next.clampWhenFinished = true;
        // a flinch blending under a corpse makes it twitch
        if (oneShot.current) { oneShot.current.stop(); oneShot.current = null; }
        dead.current = true;
      } else {
        dead.current = false;
        rig.position.y = 0;
        next.reset().setLoop(THREE.LoopRepeat, Infinity);
      }
      next.enabled = true;
      next.fadeIn(FADE).play();
      if (prev && prev !== next) prev.fadeOut(FADE);
      current.current = name;
    },
    setAim(q) {
      if (q) { aimQ.current.copy(q); aimOn.current = true; } else aimOn.current = false;
    },
    setShuffle(side) {
      shuffleSide.current = side;
    },
    setCrouch(amount) {
      crouch.current = Math.max(0, Math.min(1, amount));
    },
    playOnce(name, timeScale = 1) {
      const a = actions.current[name];
      if (!a) return;
      a.reset();
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = false;
      a.setEffectiveWeight(1);
      a.timeScale = timeScale;
      a.play();
      oneShot.current = a;
    },
    setTint(hex, intensity) {
      for (const m of mats.current) {
        if (!m.emissive) continue;
        m.emissive.setHex(hex);
        m.emissiveIntensity = intensity;
      }
    },
    debug() {
      const gun = gunRef.current, grip = gripRef.current;
      if (!gun || !grip) return { attached: false, gun: !!gun, grip: !!grip };
      const gp = gun.getWorldPosition(new THREE.Vector3());
      const hp = grip.getWorldPosition(new THREE.Vector3());
      const gs = gun.getWorldScale(new THREE.Vector3());
      const box = new THREE.Box3().setFromObject(gun);
      const size = box.getSize(new THREE.Vector3());
      return {
        attached: true, aligned: aligned.current, visible: gun.visible,
        gunWorld: [+gp.x.toFixed(2), +gp.y.toFixed(2), +gp.z.toFixed(2)],
        handWorld: [+hp.x.toFixed(2), +hp.y.toFixed(2), +hp.z.toFixed(2)],
        distHandToGun: +gp.distanceTo(hp).toFixed(3),
        gunWorldScale: +gs.x.toFixed(4),
        gunSizeMetres: [+size.x.toFixed(2), +size.y.toFixed(2), +size.z.toFixed(2)],
        gunBoxMin: [+box.min.x.toFixed(2), +box.min.y.toFixed(2), +box.min.z.toFixed(2)],
        gunBoxMax: [+box.max.x.toFixed(2), +box.max.y.toFixed(2), +box.max.z.toFixed(2)],
        // How far the rifle sticks out horizontally from the body centre (hips), to
        // compare against the sim's collision radius FPS_TUNING.ENEMY.BODY_R.
        rifleReachFromHips: (() => {
          const hips = groundBones.current.find((b) => /hips$/i.test(b.name))
          if (!hips) return null
          const h = hips.getWorldPosition(new THREE.Vector3())
          let m = 0
          for (const x of [box.min.x, box.max.x]) for (const z of [box.min.z, box.max.z]) m = Math.max(m, Math.hypot(x - h.x, z - h.z))
          return +m.toFixed(2)
        })(),
        localScale: +gun.scale.x.toFixed(4),
        meshCount: gun.getObjectsByProperty('isMesh', true).length,
        dead: dead.current,
        clip: current.current,
        rigY: +rig.position.y.toFixed(3),
        headY: (() => {
          const h = groundBones.current.find((b) => /head$/i.test(b.name));
          return h ? +h.getWorldPosition(new THREE.Vector3()).y.toFixed(3) : null;
        })(),
        lowestBoneY: (() => {
          let m = Infinity;
          for (const b of groundBones.current) m = Math.min(m, b.getWorldPosition(new THREE.Vector3()).y);
          return Number.isFinite(m) ? +m.toFixed(3) : null;
        })(),
      };
    },
  }), [rig]);

  const tmpQ = useMemo(() => new THREE.Quaternion(), []);
  const aimQ = useRef(new THREE.Quaternion());
  const aimOn = useRef(false);
  const crouch = useRef(0);
  const shuffleSide = useRef<-1 | 0 | 1>(0);
  const shuffleDir = useRef<-1 | 1>(1);
  const shufflePhase = useRef(0);
  const shuffleAmp = useRef(0);
  // Parts of the RENDERED body for the player-only features (rifle aim, crouch).
  //
  // Found by walking what is actually mounted (groupRef), not taken from the refs
  // the rig memo assigns. That memo has side effects, and React Strict Mode runs a
  // memo twice in development and keeps only one result — so those refs can point
  // at a duplicate clone that is never drawn (it sits at the world origin). The
  // existing enemy rifle alignment goes through those refs and is deliberately
  // left as it is; these new features must hit the body you can see, in dev and
  // in production alike.
  type LiveParts = { root: THREE.Object3D; body: THREE.Object3D | null; grip: THREE.Object3D | null; gun: THREE.Object3D | null;
    upL: THREE.Object3D | null; upR: THREE.Object3D | null; legL: THREE.Object3D | null; legR: THREE.Object3D | null;
    spine: THREE.Object3D | null; skins: THREE.SkinnedMesh[];
    /** Lift that puts the standing soles on the floor (NaN until measured). */
    standLift: number };
  const live = useRef<LiveParts | null>(null);
  const liveParts = (): LiveParts | null => {
    const root = groupRef.current;
    if (!root) return null;
    // Keyed on the mounted clone too: a hot reload swaps the clone inside the same group.
    if (live.current && live.current.root === root && live.current.body === root.children[0]) return live.current;
    const p: LiveParts = { root, body: root.children[0] ?? null, grip: null, gun: null, upL: null, upR: null, legL: null, legR: null, spine: null, skins: [], standLift: NaN };
    root.traverse((o) => {
      if (o.userData.valorRifle && !p.gun) { p.gun = o; p.grip = o.parent; }
      const sk = o as THREE.SkinnedMesh;
      if (sk.isSkinnedMesh && sk.visible) p.skins.push(sk);
      if (!(o as THREE.Bone).isBone) return;
      const n = o.name;
      if (!p.upL && /LeftUpLeg$/i.test(n)) p.upL = o;
      else if (!p.upR && /RightUpLeg$/i.test(n)) p.upR = o;
      else if (!p.legL && /LeftLeg$/i.test(n)) p.legL = o;
      else if (!p.legR && /RightLeg$/i.test(n)) p.legR = o;
      else if (!p.spine && /Spine$/i.test(n)) p.spine = o;
    });
    live.current = p;
    return p;
  };
  const tmpQ2 = useMemo(() => new THREE.Quaternion(), []);
  const tmpV = useMemo(() => new THREE.Vector3(), []);
  const deadFor = useRef(0);
  const shuffleLat = useMemo(() => new THREE.Vector3(), []);
  const swAxis = useMemo(() => new THREE.Vector3(), []);
  const swA = useMemo(() => new THREE.Vector3(), []);
  const swQ = useMemo(() => new THREE.Quaternion(), []);
  /** Swing a thigh toward the body's left (+angle) or right, whatever way the
   *  thigh points: about (thigh direction x body left) in world space, so a bent
   *  crouch thigh opens its knee sideways rather than rolling on itself. */
  const swingSideways = (up: THREE.Object3D, knee: THREE.Object3D, angle: number) => {
    if (!up.parent) return;
    up.getWorldPosition(swA);
    knee.getWorldPosition(swAxis);
    swAxis.sub(swA).normalize().cross(shuffleLat).normalize();
    up.parent.getWorldQuaternion(swQ);
    swAxis.applyQuaternion(swQ.invert());
    swQ.setFromAxisAngle(swAxis, angle);
    up.quaternion.premultiply(swQ);
    up.updateMatrixWorld(true);
  };
  /** World Y of the lowest point of the posed skin (CPU-skinned vertex sample).
   *  Bones sit inside the body, so grounding on them leaves feet, backs and arms
   *  a few centimetres under the floor; this measures the surface itself. */
  const lowestSkinY = (lp: LiveParts): number => {
    lp.root.updateMatrixWorld(true);
    let m = Infinity;
    for (const sk of lp.skins) {
      const n = sk.geometry.attributes.position.count;
      for (let i = 0; i < n; i += SKIN_STRIDE) {
        sk.getVertexPosition(i, tmpV).applyMatrix4(sk.matrixWorld);
        if (tmpV.y < m) m = tmpV.y;
      }
    }
    return m;
  };

  useFrame((_, dt) => {
    // Skip everything for a rig nobody can see. three.js won't DRAW a hidden object,
    // but this frame callback runs regardless, so an off-duty rig would still pay for
    // a full skeleton update every frame. That matters most in endless, which keeps a
    // standing pool of rigs and parks the unused ones, but it also covers despawned
    // survival slots and any corpse culled from view.
    let node: THREE.Object3D | null = groupRef.current;
    while (node) {
      if (!node.visible) return;
      node = node.parent;
    }

    mixerRef.current?.update(Math.min(dt, 1 / 20));

    // Align the rifle ONCE, after the idle clip has actually posed the skeleton.
    // We want the barrel (+Z) to point down the character's forward axis, so:
    //   gun.local = inverse(grip.world) * character.world
    // and the muzzle-ward offset must be expressed in the grip's local space,
    // which is exactly that same rotation applied to (0,0,z).
    // On the body actually drawn (liveParts): the memo's gunRef/gripRef can point
    // at React Strict Mode's discarded duplicate in development, which left the
    // visible rifle unaligned (held sideways) depending on how the page loaded.
    const lp = liveParts();
    const body = lp?.root.children[0] ?? null; // the mounted clone (<primitive object={rig}>)
    const gun = lp?.gun ?? null, grip = lp?.grip ?? null;
    if (!aligned.current && gun && grip && body) {
      body.updateMatrixWorld(true);
      grip.getWorldQuaternion(tmpQ);   // hand, as animated
      body.getWorldQuaternion(tmpQ2);  // character root
      gun.quaternion.copy(tmpQ.invert().multiply(tmpQ2));
      // The grip bone's world scale is ~0.01 (Mixamo centimetres), so a child's
      // local units are NOT metres. Convert the metre offset into bone units --
      // gun.scale.x already holds 1/boneWorldScale.
      gun.position.copy(GUN_POS).applyQuaternion(gun.quaternion).multiplyScalar(gun.scale.x);
      aligned.current = true;
    }

    // Grounding + procedural crouch, on the body actually drawn (see liveParts).
    if (lp && body && !dead.current) {
      deadFor.current = 0;
      // Measure once, on the first animated frame: how far the soles sit below
      // the floor at y=0 (scaling from the head bone leaves them ~3 cm under).
      if (Number.isNaN(lp.standLift)) {
        body.position.y = 0;
        const low = lowestSkinY(lp);
        lp.standLift = Number.isFinite(low) ? Math.max(0, Math.min(0.12, SKIN_CLEARANCE - low)) : 0;
      }
      const c = crouch.current;
      if (c > 0.001 && lp.upL && lp.upR && lp.legL && lp.legR) {
        // Bend on top of the clip's pose (the mixer rewrites the bones every
        // frame, so this is per frame, not cumulative), then drop the body so the
        // lowest point of the skin is back on the floor.
        lp.upL.rotateX(CROUCH_HIP * c); lp.upR.rotateX(CROUCH_HIP * c);
        lp.legL.rotateX(CROUCH_KNEE * c); lp.legR.rotateX(CROUCH_KNEE * c);
        if (lp.spine) lp.spine.rotateX(CROUCH_LEAN * c);
        // Crouched side-step: the lead leg lifts and steps out, the trailing leg
        // lifts and closes in. Eased in and out so stopping doesn't snap the legs.
        const side = shuffleSide.current;
        if (side) shuffleDir.current = side;
        shuffleAmp.current += ((side ? 1 : 0) - shuffleAmp.current) * Math.min(1, dt * 8);
        const amp = shuffleAmp.current * c;
        if (amp > 0.01) {
          if (side) shufflePhase.current = (shufflePhase.current + dt * Math.PI * 2 * SHUFFLE_HZ) % (Math.PI * 2);
          const ph = shufflePhase.current, s = shuffleDir.current;
          const lead = s > 0 ? [lp.upL, lp.legL] as const : [lp.upR, lp.legR] as const;
          const trail = s > 0 ? [lp.upR, lp.legR] as const : [lp.upL, lp.legL] as const;
          const lift = (up: THREE.Object3D, knee: THREE.Object3D, k: number) => {
            const a = SHUFFLE_LIFT * k * amp;
            knee.rotateX(-a); up.rotateX(a * 0.5);
          };
          lift(lead[0], lead[1], Math.max(0, Math.cos(ph)));
          lift(trail[0], trail[1], Math.max(0, -Math.cos(ph)));
          // Open and close: the lead thigh swings out toward the step, the
          // trailing one the other way, then both return.
          const spread = SHUFFLE_SPREAD * amp * Math.sin(ph);
          body.updateMatrixWorld(true);
          body.getWorldQuaternion(tmpQ);
          shuffleLat.set(1, 0, 0).applyQuaternion(tmpQ); // body's left, in world
          swingSideways(lead[0], lead[1], s * spread);
          swingSideways(trail[0], trail[1], -s * spread);
        }
        body.position.y = 0;
        const low = lowestSkinY(lp);
        if (Number.isFinite(low)) body.position.y = SKIN_CLEARANCE - low;
      } else {
        body.position.y = lp.standLift;
      }
    }

    // Player-held rifle: point the barrel along the live aim every frame. AFTER
    // the crouch bend, which moves the hands.
    if (aimOn.current && lp?.gun && lp.grip) {
      lp.grip.updateWorldMatrix(true, false);
      lp.grip.getWorldQuaternion(tmpQ);
      lp.gun.quaternion.copy(tmpQ.invert().multiply(aimQ.current));
      lp.gun.position.copy(GUN_POS).applyQuaternion(lp.gun.quaternion).multiplyScalar(lp.gun.scale.x);
    }

    // A death clip drops the body toward the floor but nothing re-grounds the
    // rig, so it would sink. Lift it until the lowest point of the skin rests on
    // the floor. Only while the fall settles; after that the pose is frozen.
    if (dead.current && lp && body && deadFor.current < DEATH_SETTLE_S) {
      deadFor.current += dt;
      const minY = lowestSkinY(lp);
      if (Number.isFinite(minY)) {
        if (minY < SKIN_CLEARANCE) {
          // sinking: lift it out of the floor immediately
          body.position.y += SKIN_CLEARANCE - minY;
        } else {
          // NEVER press a body down just because its feet came off the ground
          // mid-fall -- that is what made corpses sink. Relax the lift instead.
          body.position.y += (0 - body.position.y) * Math.min(1, dt * 4);
        }
      }
    }

    const os = oneShot.current;
    if (os && !os.isRunning()) oneShot.current = null;
  });

  return <group ref={groupRef}><primitive object={rig} /></group>;
});

useGLTF.preload('/characters/glb/operator.glb');
