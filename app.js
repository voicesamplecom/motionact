// SOMA BVH -> VRM player.
//
// Why a custom BVH player (bvh.js) instead of three.js BVHLoader:
// BVHLoader adds the joint offset to position channels, which double-counts
// the Hips height for MotionBricks-style BVH files.
//
// Retargeting method (geometric frames):
// For each joint we build a world-space frame from *geometry* each frame:
//   Y = bone direction (towards the primary child),
//   X = body-left (or body-forward when nearly parallel) made orthogonal.
// The same construction on the VRM normalized rig at rest gives A_dst.
//   targetWorldQuat = A_src(t) * inverse(A_dst) * restWorldQuat
// This transfers the absolute pose (e.g. arms hanging down while walking),
// unlike bind-pose delta methods: the MotionBricks bind pose is a straight
// stick along +X, so deltas from bind contain a spurious lying->standing
// rotation. For hinge chains (arms / legs) the frame's twist comes from the
// actual bend plane of the two bones, so elbows and knees bend the right
// way; other joints still derive twist from body-level axes (approximate).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from '@pixiv/three-vrm';
import { parseBVH, sampleWorld } from './bvh.js';

const status = (msg) => { document.getElementById('status').textContent = msg; };

// ---------------------------------------------------------------- scene setup
const view = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
camera.position.set(1.8, 1.4, 2.6);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.9, 0);

scene.add(new THREE.HemisphereLight(0xffffff, 0x334, 1.1));
const dir = new THREE.DirectionalLight(0xffffff, 1.6);
dir.position.set(2, 4, 2);
scene.add(dir);
scene.add(new THREE.GridHelper(10, 20, 0x445566, 0x2a2f38));

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

// ---------------------------------------------------------------- BVH motion
let bvh = null, bvhFirst = null;
let parentNameOf = {};
let fingerOf = {}; // hand joint name -> { thumb, middle } direct-child names
const skelGroup = new THREE.Group();
scene.add(skelGroup);
let skelLines = null;

async function loadBVHText(text, label) {
  bvh = parseBVH(text);
  bvhFirst = sampleWorld(bvh, 0);
  parentNameOf = {};
  bvh.joints.forEach((j) => {
    parentNameOf[j.name] = j.parent >= 0 ? bvh.joints[j.parent].name : null;
  });
  fingerOf = {};
  bvh.joints.forEach((j, i) => {
    if (!/Hand$/.test(j.name)) return;
    const entry = {};
    bvh.joints.forEach((c) => {
      if (c.parent !== i) return;
      if (/Thumb/.test(c.name) && !entry.thumb) entry.thumb = c.name;
      if (/Middle/.test(c.name) && !entry.middle) entry.middle = c.name;
    });
    if (entry.thumb && entry.middle) fingerOf[j.name] = entry;
  });
  buildSkeletonLines();
  computeLegCorr();
  const seek = document.getElementById('seek');
  seek.max = bvh.frameCount - 1;
  seek.value = 0;
  playhead = 0;
  status(`BVH読み込み完了: ${label}（${bvh.joints.length}関節 / ${bvh.frameCount}フレーム @ ${(1 / bvh.frameTime).toFixed(0)}fps）`);
}

// Leg frame-convention correction (same fix as the BVH->VRMA converter
// v4): geometric frames lose the legs' twist — SOMA BVH joint frames use
// their own anatomical convention (bone direction = local +X, front = a
// fixed other local axis, mirrored between left and right), so frames
// built from joint positions roll the thigh/shin ~90 degrees (positions
// stay right, the flesh faces sideways). For leg bones, take the world
// orientation from the BVH's own quaternions, corrected by a constant
// per-bone basis change. The front axis is identified from the data:
// the BVH-local axis whose world image best tracks the knee-front /
// foot-dorsum direction derived from joint positions.
let legCorr = {}; // VRM bone name -> THREE.Quaternion
const LEG_ROWS = [ // [srcName, boneName, childSrc, kind]
  ['LeftLeg', 'leftUpperLeg', 'LeftShin', 'front'],
  ['LeftShin', 'leftLowerLeg', 'LeftFoot', 'front'],
  ['LeftFoot', 'leftFoot', 'LeftToeBase', 'up'],
  ['RightLeg', 'rightUpperLeg', 'RightShin', 'front'],
  ['RightShin', 'rightLowerLeg', 'RightFoot', 'front'],
  ['RightFoot', 'rightFoot', 'RightToeBase', 'up'],
];
function computeLegCorr() {
  legCorr = {};
  try {
    if (!bvhFirst['LeftLeg'] || !bvhFirst['RightLeg']) return;
    const sideWorld = (w) => V3(w['LeftLeg'].pos).sub(V3(w['RightLeg'].pos)).normalize();
    const canonC1 = (boneName) => boneName.includes('Foot')
      ? new THREE.Vector3(0, -0.07, 0.12).normalize()
      : new THREE.Vector3(0, -1, 0);
    for (const [srcName, boneName, childSrc, kind] of LEG_ROWS) {
      if (!bvhFirst[srcName] || !bvhFirst[childSrc]) continue;
      const side = srcName.startsWith('Left') ? 'Left' : 'Right';
      const toeName = `${side}ToeBase`, footName = `${side}Foot`;
      const refSum = new THREE.Vector3();
      const imgSum = { py: new THREE.Vector3(), ny: new THREE.Vector3(), pz: new THREE.Vector3(), nz: new THREE.Vector3() };
      for (let f = 0; f < bvh.frameCount; f++) {
        const w = sampleWorld(bvh, f);
        const jp = V3(w[srcName].pos);
        const boneDir = V3(w[childSrc].pos).sub(jp).normalize();
        let ref;
        if (kind === 'front') {
          ref = new THREE.Vector3().crossVectors(boneDir, sideWorld(w)).normalize();
        } else {
          if (!w[toeName] || !w[footName]) continue;
          const toeDir = V3(w[toeName].pos).sub(V3(w[footName].pos)).normalize();
          ref = new THREE.Vector3().crossVectors(toeDir, sideWorld(w)).normalize();
        }
        refSum.add(ref);
        const q = w[srcName].quat;
        const tq = new THREE.Quaternion(q[0], q[1], q[2], q[3]);
        imgSum.py.add(new THREE.Vector3(0, 1, 0).applyQuaternion(tq));
        imgSum.ny.add(new THREE.Vector3(0, -1, 0).applyQuaternion(tq));
        imgSum.pz.add(new THREE.Vector3(0, 0, 1).applyQuaternion(tq));
        imgSum.nz.add(new THREE.Vector3(0, 0, -1).applyQuaternion(tq));
      }
      if (refSum.lengthSq() < 1e-6) continue;
      refSum.normalize();
      let best = null;
      for (const [key, vec] of Object.entries(imgSum)) {
        if (vec.lengthSq() < 1e-6) continue;
        const d = vec.normalize().dot(refSum);
        if (!best || d > best.d) best = { key, d };
      }
      if (!best || best.d < 0.5) continue;
      const frontLocal = { py: new THREE.Vector3(0, 1, 0), ny: new THREE.Vector3(0, -1, 0),
                           pz: new THREE.Vector3(0, 0, 1), nz: new THREE.Vector3(0, 0, -1) }[best.key];
      const childJoint = bvh.joints.find((j) => j.name === childSrc);
      const c1b = new THREE.Vector3(...childJoint.offset).normalize();
      const c3b = new THREE.Vector3().crossVectors(c1b, frontLocal);
      const qBvh = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(c1b, frontLocal, c3b));
      const c1v = canonC1(boneName);
      let c2v;
      if (kind === 'front') c2v = new THREE.Vector3(0, 0, 1);
      else { const up = new THREE.Vector3(0, 1, 0); c2v = up.clone().addScaledVector(c1v, -up.dot(c1v)).normalize(); }
      const c3v = new THREE.Vector3().crossVectors(c1v, c2v);
      const qVrm = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(c1v, c2v, c3v));
      legCorr[boneName] = qBvh.multiply(qVrm.invert());
    }
    if (legCorr.leftFoot) legCorr.leftToes = legCorr.leftFoot;
    if (legCorr.rightFoot) legCorr.rightToes = legCorr.rightFoot;
  } catch (err) {
    legCorr = {}; // never let the correction break BVH loading
  }
}

function buildSkeletonLines() {
  if (skelLines) { skelGroup.remove(skelLines); skelLines.geometry.dispose(); }
  const pairs = [];
  bvh.joints.forEach((j, i) => { if (j.parent >= 0) pairs.push([j.parent, i]); });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs.length * 6), 3));
  skelLines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x7fd4ff }));
  skelLines.userData.pairs = pairs;
  skelLines.visible = document.getElementById('showSkel').checked;
  skelGroup.add(skelLines);
}

function updateSkeletonLines(world) {
  if (!skelLines || !skelLines.visible) return;
  const attr = skelLines.geometry.getAttribute('position');
  skelLines.userData.pairs.forEach(([p, c], k) => {
    const a = world[bvh.joints[p].name].pos, b = world[bvh.joints[c].name].pos;
    attr.setXYZ(k * 2, a[0], a[1], a[2]);
    attr.setXYZ(k * 2 + 1, b[0], b[1], b[2]);
  });
  attr.needsUpdate = true;
}

// ------------------------------------------------------------- geometric frame
const V3 = (a) => new THREE.Vector3(a[0], a[1], a[2]);

function bodyAxes(getPos) {
  const left0 = getPos('leftLegAnchor').sub(getPos('rightLegAnchor')).normalize();
  const up = getPos('chestAnchor').sub(getPos('hipsAnchor')).normalize();
  const forward = new THREE.Vector3().crossVectors(left0, up).normalize();
  const left = new THREE.Vector3().crossVectors(up, forward).normalize();
  return { left, forward };
}

// Quaternion of the geometric frame: Y = bone dir, Z = frame normal.
//
// For limb joints the normal comes from the chain's bend plane (see
// bendNormal): it is the hinge axis of the elbow / knee / ankle, so the
// transferred twist follows which way the hinge actually faces. Deriving
// twist from body axes instead made raised arms twist the wrong way
// (the secondary axis flips when a bone passes the switch threshold).
// Other joints (spine, head, hands) keep the body-axis construction.
function geoQuat(jointPos, boneDirVec, axes, planeN = null) {
  const y = boneDirVec.clone().normalize();
  if (planeN) {
    const z = planeN.clone().addScaledVector(y, -planeN.dot(y));
    if (z.lengthSq() > 1e-6) {
      z.normalize();
      const x = new THREE.Vector3().crossVectors(y, z);
      const zz = new THREE.Vector3().crossVectors(x, y);
      const m = new THREE.Matrix4().makeBasis(x, y, zz);
      return new THREE.Quaternion().setFromRotationMatrix(m);
    }
  }
  const s = Math.abs(y.dot(axes.left)) < 0.8 ? axes.left : axes.forward;
  const x = s.clone().addScaledVector(y, -s.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

// Plane normal (hinge axis) from two bone directions. When the chain is
// nearly straight the plane is undefined, so fall back to a virtual bend:
// the direction the next bone would point if the hinge bent anatomically
// (forearm bends towards body-forward, shin towards body-backward),
// passed as virtSign * axes.forward. Source and target use the same rule,
// so the frames stay consistent even at a straight rest pose (T-pose).
function bendNormal(d1, d2, ownDir, axes, virtSign) {
  const n = new THREE.Vector3().crossVectors(
    d1.clone().normalize(), d2.clone().normalize());
  if (n.length() > 0.05) return n;
  if (virtSign) {
    const virt = axes.forward.clone().multiplyScalar(virtSign);
    const nv = new THREE.Vector3().crossVectors(ownDir.clone().normalize(), virt);
    if (nv.length() > 0.05) return nv;
  }
  return null;
}

// ------------------------------------------------------------------------ VRM
// [SOMA BVH joint, VRM humanoid bone, primary child BVH joint (null =
// incoming dir), grandchild BVH joint, bend mode, virtual-bend sign]
// bend mode: 'next' = plane of (own bone, next bone) for hip and upper
// arm/leg; 'in' = plane of (incoming bone, own bone) for the hinge joints
// themselves (forearm, shin, foot); 'incoming' = frame from the incoming
// direction only (shoulders: the BVH shoulder does not rotate with the
// arm, so its frame must not be built from the arm direction);
// 'finger' = hand frame from finger geometry; null = body-axis frame.
const MAP = [
  ['Hips', 'hips', 'Spine1', null, null, 0],
  ['Spine1', 'spine', 'Spine2', null, null, 0],
  ['Spine2', 'chest', 'Chest', null, null, 0],
  ['Chest', 'upperChest', 'Neck1', null, null, 0],
  ['Neck1', 'neck', 'Neck2', null, null, 0],
  ['Head', 'head', null, null, null, 0],
  ['LeftShoulder', 'leftShoulder', 'LeftArm', 'LeftForeArm', 'incoming', 0],
  ['LeftArm', 'leftUpperArm', 'LeftForeArm', 'LeftHand', 'next', 1],
  ['LeftForeArm', 'leftLowerArm', 'LeftHand', null, 'in', 1],
  ['LeftHand', 'leftHand', null, null, 'finger', 0],
  ['RightShoulder', 'rightShoulder', 'RightArm', 'RightForeArm', 'incoming', 0],
  ['RightArm', 'rightUpperArm', 'RightForeArm', 'RightHand', 'next', 1],
  ['RightForeArm', 'rightLowerArm', 'RightHand', null, 'in', 1],
  ['RightHand', 'rightHand', null, null, 'finger', 0],
  ['LeftLeg', 'leftUpperLeg', 'LeftShin', 'LeftFoot', 'next', -1],
  ['LeftShin', 'leftLowerLeg', 'LeftFoot', 'LeftToeBase', 'in', -1],
  ['LeftFoot', 'leftFoot', 'LeftToeBase', null, 'in', 1],
  ['LeftToeBase', 'leftToes', null, null, null, 0],
  ['RightLeg', 'rightUpperLeg', 'RightShin', 'RightFoot', 'next', -1],
  ['RightShin', 'rightLowerLeg', 'RightFoot', 'RightToeBase', 'in', -1],
  ['RightFoot', 'rightFoot', 'RightToeBase', null, 'in', 1],
  ['RightToeBase', 'rightToes', null, null, null, 0],
];
// humanoid bone -> grandchild humanoid bone (bend plane), when defined
const DST_NEXT = {
  leftShoulder: 'leftLowerArm', leftUpperArm: 'leftHand',
  rightShoulder: 'rightLowerArm', rightUpperArm: 'rightHand',
  leftUpperLeg: 'leftFoot', leftLowerLeg: 'leftToes',
  rightUpperLeg: 'rightFoot', rightLowerLeg: 'rightToes',
};
// Leaf bones whose orientation follows the parent bone (toes follow the
// foot; hands use this only as a fallback): their world target is the
// parent's world target times the rest-pose relative rotation.
const FOLLOW_PARENT = {
  leftHand: 'leftLowerArm', rightHand: 'rightLowerArm',
  leftToes: 'leftFoot', rightToes: 'rightFoot',
};
// Bones whose world rotation is damped towards rest (0..1). (Shoulders
// used to be damped here; they now use 'incoming' frames instead - see
// MAP - because the BVH shoulder joint itself does not rotate with the
// arm at all, so any arm-derived rotation is an artifact.)
const DAMP = {};
// Finger bones used to build a true hand frame (thumb side + middle
// finger direction define the palm plane), per hand bone.
const FINGER_NODES = {
  leftHand: ['leftThumbMetacarpal', 'leftMiddleProximal'],
  rightHand: ['rightThumbMetacarpal', 'rightMiddleProximal'],
};

// Frame of a hand from three points: wrist, middle-finger base, thumb
// base. Y = finger direction, Z = palm-plane normal. Same construction
// on BVH geometry and on the VRM rig, so palm orientation transfers.
function handFrameQuat(wrist, middle, thumb) {
  const y = middle.clone().sub(wrist).normalize();
  const t = thumb.clone().sub(wrist).normalize();
  const z = new THREE.Vector3().crossVectors(y, t).normalize();
  const x = new THREE.Vector3().crossVectors(y, z);
  const zz = new THREE.Vector3().crossVectors(x, y);
  const m = new THREE.Matrix4().makeBasis(x, y, zz);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}
// humanoid hinge bone -> its parent humanoid bone (incoming direction)
const DST_PARENT_BONE = {
  leftLowerArm: 'leftUpperArm', rightLowerArm: 'rightUpperArm',
  leftLowerLeg: 'leftUpperLeg', rightLowerLeg: 'rightUpperLeg',
  leftFoot: 'leftLowerLeg', rightFoot: 'rightLowerLeg',
  leftShoulder: 'upperChest', rightShoulder: 'upperChest',
};
// humanoid bone -> its primary child humanoid bone (null = incoming dir)
const DST_CHILD = {
  hips: 'spine', spine: 'chest', chest: 'upperChest', upperChest: 'neck',
  neck: 'head', head: null,
  leftShoulder: 'leftUpperArm', leftUpperArm: 'leftLowerArm',
  leftLowerArm: 'leftHand', leftHand: null,
  rightShoulder: 'rightUpperArm', rightUpperArm: 'rightLowerArm',
  rightLowerArm: 'rightHand', rightHand: null,
  leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', leftFoot: 'leftToes',
  leftToes: null,
  rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot',
  rightFoot: 'rightToes', rightToes: null,
};
// BVH parent name for joints that use the incoming direction
const SRC_PARENT = {
  Head: 'Neck2', LeftHand: 'LeftForeArm', RightHand: 'RightForeArm',
  LeftToeBase: 'LeftFoot', RightToeBase: 'RightFoot',
};

let vrm = null, vrmGroup = null, rig = [];

async function loadVRM(url, label) {
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const gltf = await loader.loadAsync(url);
  const loaded = gltf.userData.vrm;
  if (!loaded) throw new Error('VRMとして読み込めませんでした');
  if (vrmGroup) { scene.remove(vrmGroup); }
  vrm = loaded;
  vrmGroup = new THREE.Group();
  vrmGroup.add(vrm.scene);
  vrmGroup.rotation.y = THREE.MathUtils.degToRad(Number(document.getElementById('rotY').value));
  scene.add(vrmGroup);

  vrm.humanoid.resetNormalizedPose();
  vrm.scene.updateMatrixWorld(true);

  // world positions of all normalized humanoid nodes (rest)
  const dstPos = {}, dstNode = {};
  for (const boneName of Object.keys(DST_CHILD)) {
    const node = vrm.humanoid.getNormalizedBoneNode(boneName);
    if (!node) continue;
    dstNode[boneName] = node;
    dstPos[boneName] = node.getWorldPosition(new THREE.Vector3());
  }
  for (const pair of Object.values(FINGER_NODES)) {
    for (const fn of pair) {
      const n = vrm.humanoid.getNormalizedBoneNode(fn);
      if (n) dstPos[fn] = n.getWorldPosition(new THREE.Vector3());
    }
  }
  if (!dstNode.hips) throw new Error('VRMにhipsボーンがありません');
  // if upperChest is missing, chest's child falls back to neck
  const childOf = (b) => {
    let c = DST_CHILD[b];
    if (c && !dstNode[c]) c = DST_CHILD[c];
    return c && dstNode[c] ? c : null;
  };
  const axes = bodyAxes((k) => ({
    leftLegAnchor: dstPos.leftUpperLeg, rightLegAnchor: dstPos.rightUpperLeg,
    chestAnchor: dstPos.chest || dstPos.spine, hipsAnchor: dstPos.hips,
  }[k].clone()));

  rig = [];
  for (const [srcName, boneName, srcChild, srcNext, bendMode, virtSign] of MAP) {
    const node = dstNode[boneName];
    if (!node) continue;
    const childName = childOf(boneName);
    let boneDir;
    if (childName) boneDir = dstPos[childName].clone().sub(dstPos[boneName]);
    else {
      boneDir = null; // incoming direction, resolved below from the parent node
    }
    const nextName = DST_NEXT[boneName];
    let nextDir = null;
    if (nextName && childName && dstNode[nextName]) {
      nextDir = dstPos[nextName].clone().sub(dstPos[childName]);
    }
    const pName = DST_PARENT_BONE[boneName];
    let incomingDir = null;
    if (pName && dstNode[pName]) {
      incomingDir = dstPos[boneName].clone().sub(dstPos[pName]);
    }
    rig.push({
      node, boneName, srcName, srcChild, srcNext, bendMode, virtSign,
      childName, boneDir, nextDir, incomingDir,
      followParent: FOLLOW_PARENT[boneName] || null,
      damp: DAMP[boneName] ?? 1,
    });
  }
  // resolve incoming directions and rest frames
  const posOf = (boneName) => dstPos[boneName];
  for (const r of rig) {
    if (!r.boneDir) {
      // parent humanoid bone = previous MAP bone whose node is an ancestor
      let p = r.node.parent, parentPos = null;
      while (p) {
        const hit = rig.find((x) => x.node === p);
        if (hit) { parentPos = posOf(hit.boneName); break; }
        p = p.parent;
      }
      r.boneDir = posOf(r.boneName).clone().sub(parentPos || new THREE.Vector3());
    }
    r.restQ = r.node.getWorldQuaternion(new THREE.Quaternion());
    const fing = FINGER_NODES[r.boneName];
    if (r.bendMode === 'incoming' && r.incomingDir) {
      // Shoulder: frame from the incoming direction (chest -> shoulder),
      // NOT from the arm direction. In the BVH data the shoulder joint
      // does not rotate when the arm raises (both shoulders keep the
      // same world orientation); a frame built from the arm direction
      // invents that rotation and flings pads/sleeves around.
      r.frameQ = geoQuat(posOf(r.boneName), r.incomingDir, axes, null);
    } else if (r.bendMode === 'finger' && fing && dstPos[fing[0]] && dstPos[fing[1]]) {
      r.frameQ = handFrameQuat(posOf(r.boneName), dstPos[fing[1]], dstPos[fing[0]]);
      r.fingerFrame = true;
    } else {
      let frameN = null;
      if (r.bendMode === 'next' && r.nextDir) {
        frameN = bendNormal(r.boneDir, r.nextDir, r.boneDir, axes, r.virtSign);
      } else if (r.bendMode === 'in' && r.incomingDir) {
        frameN = bendNormal(r.incomingDir, r.boneDir, r.boneDir, axes, r.virtSign);
      }
      r.frameQ = geoQuat(posOf(r.boneName), r.boneDir, axes, frameN);
    }
  }
  rig.hipsNode = dstNode.hips;
  rig.hipsRestPos = dstNode.hips.position.clone();
  status(`VRM読み込み完了: ${label}（対応ボーン ${rig.length} 本）`);
}

function applyPose(world) {
  updateSkeletonLines(world);
  if (!vrm || !rig.length) return;
  const srcAxes = bodyAxes((k) => ({
    leftLegAnchor: V3(world['LeftLeg'].pos), rightLegAnchor: V3(world['RightLeg'].pos),
    chestAnchor: V3(world['Chest'].pos), hipsAnchor: V3(world['Hips'].pos),
  }[k]));
  const nodeWorld = new Map();
  const worldByBone = new Map();
  for (const r of rig) {
    let targetWorldQ;
    const parentTarget = r.followParent ? worldByBone.get(r.followParent) : null;
    const srcFing = fingerOf[r.srcName];
    if (legCorr[r.boneName] && world[r.srcName]) {
      // legs: BVH's own world quaternion + basis correction (see computeLegCorr)
      const q = world[r.srcName].quat;
      targetWorldQ = new THREE.Quaternion(q[0], q[1], q[2], q[3]).multiply(legCorr[r.boneName]).multiply(r.restQ);
    } else if (r.fingerFrame && srcFing && world[srcFing.thumb] && world[srcFing.middle]) {
      const jp0 = V3(world[r.srcName].pos);
      const aSrc = handFrameQuat(jp0, V3(world[srcFing.middle].pos), V3(world[srcFing.thumb].pos));
      targetWorldQ = aSrc.multiply(r.frameQ.clone().invert()).multiply(r.restQ);
    } else if (parentTarget) {
      const parentRest = rig.find((x) => x.boneName === r.followParent).restQ;
      const rel = parentRest.clone().invert().multiply(r.restQ);
      targetWorldQ = parentTarget.clone().multiply(rel);
    } else {
      const jp = V3(world[r.srcName].pos);
      let boneDir;
      if (r.srcChild && world[r.srcChild]) boneDir = V3(world[r.srcChild].pos).sub(jp);
      else boneDir = jp.clone().sub(V3(world[SRC_PARENT[r.srcName]].pos));
      let frameDir = boneDir;
      if (r.bendMode === 'incoming') {
        const pn = parentNameOf[r.srcName];
        if (pn && world[pn]) frameDir = jp.clone().sub(V3(world[pn].pos));
      }
      let planeN = null;
      if (r.bendMode === 'next' && r.srcNext && r.srcChild && world[r.srcNext] && world[r.srcChild]) {
        const nd = V3(world[r.srcNext].pos).sub(V3(world[r.srcChild].pos));
        planeN = bendNormal(boneDir, nd, boneDir, srcAxes, r.virtSign);
      } else if (r.bendMode === 'in') {
        const pn = parentNameOf[r.srcName];
        if (pn && world[pn]) {
          const incoming = jp.clone().sub(V3(world[pn].pos));
          planeN = bendNormal(incoming, boneDir, boneDir, srcAxes, r.virtSign);
        }
      }
      const aSrc = geoQuat(jp, frameDir, srcAxes, planeN);
      targetWorldQ = aSrc.multiply(r.frameQ.clone().invert()).multiply(r.restQ);
    }
    if (r.damp < 1) targetWorldQ = r.restQ.clone().slerp(targetWorldQ, r.damp);
    let parent = r.node.parent, parentQ = null;
    while (parent) {
      if (nodeWorld.has(parent)) { parentQ = nodeWorld.get(parent); break; }
      parent = parent.parent;
    }
    const local = parentQ
      ? parentQ.clone().invert().multiply(targetWorldQ)
      : targetWorldQ.clone();
    r.node.quaternion.copy(local);
    nodeWorld.set(r.node, targetWorldQ);
    worldByBone.set(r.boneName, targetWorldQ);
  }
  // hips translation: XZ/Y travel relative to the first frame (meters).
  // "zero origin" off keeps the first frame's ground (XZ) position as-is.
  const first = V3(bvhFirst['Hips'].pos);
  const pos = rig.hipsRestPos.clone().add(V3(world['Hips'].pos)).sub(first);
  if (!document.getElementById('zeroOrigin').checked) {
    pos.x += first.x;
    pos.z += first.z;
  }
  rig.hipsNode.position.copy(pos);
  vrm.update(0);
}

// ------------------------------------------------------------------- playback
let playing = true, playhead = 0, lastTime = performance.now();
const seekEl = document.getElementById('seek');
const clockTick = () => {
  requestAnimationFrame(clockTick);
  const now = performance.now();
  const dt = (now - lastTime) / 1000;
  lastTime = now;
  if (bvh) {
    if (playing && document.activeElement !== seekEl) {
      const speed = Number(document.getElementById('speed').value);
      playhead += dt * speed / bvh.frameTime;
      if (playhead >= bvh.frameCount) playhead %= bvh.frameCount;
      seekEl.value = playhead;
    } else {
      playhead = Number(seekEl.value);
    }
    applyPose(sampleWorld(bvh, playhead));
    document.getElementById('timeLabel').textContent =
      `${(playhead * bvh.frameTime).toFixed(2)} / ${((bvh.frameCount - 1) * bvh.frameTime).toFixed(2)} s`;
  }
  controls.update();
  renderer.render(scene, camera);
};

document.getElementById('playBtn').addEventListener('click', (e) => {
  playing = !playing;
  e.target.textContent = playing ? '⏸ 一時停止' : '▶ 再生';
});
document.getElementById('showSkel').addEventListener('change', (e) => {
  if (skelLines) skelLines.visible = e.target.checked;
});
document.getElementById('rotY').addEventListener('change', (e) => {
  if (vrmGroup) vrmGroup.rotation.y = THREE.MathUtils.degToRad(Number(e.target.value));
});
document.getElementById('vrmFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) { try { await loadVRM(URL.createObjectURL(f), f.name); } catch (err) { status(`VRM読み込み失敗: ${err.message}`); } }
});
document.getElementById('bvhFile').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (f) {
    try { await loadBVHText(await f.text(), f.name); }
    catch (err) { status(`BVH読み込み失敗: ${err.message}`); }
  }
});
addEventListener('dragover', (e) => { e.preventDefault(); document.getElementById('drop').style.display = 'grid'; });
addEventListener('dragleave', () => { document.getElementById('drop').style.display = 'none'; });
addEventListener('drop', async (e) => {
  e.preventDefault();
  document.getElementById('drop').style.display = 'none';
  for (const f of e.dataTransfer.files) {
    try {
      if (f.name.toLowerCase().endsWith('.vrm')) await loadVRM(URL.createObjectURL(f), f.name);
      else if (f.name.toLowerCase().endsWith('.bvh')) { await loadBVHText(await f.text(), f.name); }
    } catch (err) { status(`読み込み失敗 (${f.name}): ${err.message}`); }
  }
});

// hooks for headless verification
window.__player = {
  get vrm() { return vrm; },
  get ready() { return !!vrm && rig.length > 0; },
  get legCorrBones() { return Object.keys(legCorr); },
  pause() { playing = false; },
  async loadBVHUrl(url) { const t = await (await fetch(url)).text(); await loadBVHText(t, url); },
  seekFrame(f) { playhead = f; applyPose(sampleWorld(bvh, f)); },
};

// ----------------------------------------------------------------------- boot
(async () => {
  resize();
  clockTick();
  try {
    const text = await (await fetch('./motion/sample_wave.bvh')).text();
    await loadBVHText(text, 'sample_wave.bvh（自作サンプル）');
    status('BVHは読み込み済み。VRMファイルを選ぶとモデルが動き出します（ドラッグ&ドロップでもOK）。');
  } catch (err) {
    status(`初期BVHの読み込みに失敗: ${err.message}。BVHファイルを選んでください。`);
  }
  const vrmParam = new URLSearchParams(location.search).get('vrm');
  if (vrmParam) {
    try { await loadVRM(vrmParam, vrmParam); } catch (err) { status(`VRM読み込み失敗: ${err.message}`); }
  }
})();
