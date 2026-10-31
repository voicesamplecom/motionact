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
  buildSkeletonLines();
  const seek = document.getElementById('seek');
  seek.max = bvh.frameCount - 1;
  seek.value = 0;
  playhead = 0;
  status(`BVH読み込み完了: ${label}（${bvh.joints.length}関節 / ${bvh.frameCount}フレーム @ ${(1 / bvh.frameTime).toFixed(0)}fps）`);
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
// bend mode: 'next' = plane of (own bone, next bone) for shoulder/hip and
// upper arm/leg; 'in' = plane of (incoming bone, own bone) for the hinge
// joints themselves (forearm, shin, foot); null = body-axis frame.
const MAP = [
  ['Hips', 'hips', 'Spine1', null, null, 0],
  ['Spine1', 'spine', 'Spine2', null, null, 0],
  ['Spine2', 'chest', 'Chest', null, null, 0],
  ['Chest', 'upperChest', 'Neck1', null, null, 0],
  ['Neck1', 'neck', 'Neck2', null, null, 0],
  ['Head', 'head', null, null, null, 0],
  ['LeftShoulder', 'leftShoulder', 'LeftArm', 'LeftForeArm', 'next', 1],
  ['LeftArm', 'leftUpperArm', 'LeftForeArm', 'LeftHand', 'next', 1],
  ['LeftForeArm', 'leftLowerArm', 'LeftHand', null, 'in', 1],
  ['LeftHand', 'leftHand', null, null, null, 0],
  ['RightShoulder', 'rightShoulder', 'RightArm', 'RightForeArm', 'next', 1],
  ['RightArm', 'rightUpperArm', 'RightForeArm', 'RightHand', 'next', 1],
  ['RightForeArm', 'rightLowerArm', 'RightHand', null, 'in', 1],
  ['RightHand', 'rightHand', null, null, null, 0],
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
// Leaf bones whose orientation follows the parent bone (hand follows the
// forearm, toes follow the foot): their world target is the parent's
// world target times the rest-pose relative rotation. A BVH gives no
// twist for these joints beyond the wrist/ankle position, and a frame
// built from body axes gave VRoid-style models a stiff, flat palm.
const FOLLOW_PARENT = {
  leftHand: 'leftLowerArm', rightHand: 'rightLowerArm',
  leftToes: 'leftFoot', rightToes: 'rightFoot',
};
// Bones whose world rotation is damped towards rest (0..1). The BVH
// shoulder is a virtual joint: its geometric frame swings with the arm,
// but a real clavicle barely rotates. Transferring it 1:1 makes shoulder
// pads and wide sleeves ride up, so shoulders are damped.
const DAMP = { leftShoulder: 0.4, rightShoulder: 0.4 };
// humanoid hinge bone -> its parent humanoid bone (incoming direction)
const DST_PARENT_BONE = {
  leftLowerArm: 'leftUpperArm', rightLowerArm: 'rightUpperArm',
  leftLowerLeg: 'leftUpperLeg', rightLowerLeg: 'rightUpperLeg',
  leftFoot: 'leftLowerLeg', rightFoot: 'rightLowerLeg',
};
// humanoid bone -> [bend mode, virtual-bend sign] (mirrors MAP)
const DST_BEND = {
  leftShoulder: ['next', 1], leftUpperArm: ['next', 1], leftLowerArm: ['in', 1],
  rightShoulder: ['next', 1], rightUpperArm: ['next', 1], rightLowerArm: ['in', 1],
  leftUpperLeg: ['next', -1], leftLowerLeg: ['in', -1], leftFoot: ['in', 1],
  rightUpperLeg: ['next', -1], rightLowerLeg: ['in', -1], rightFoot: ['in', 1],
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
    let frameN = null;
    if (r.bendMode === 'next' && r.nextDir) {
      frameN = bendNormal(r.boneDir, r.nextDir, r.boneDir, axes, r.virtSign);
    } else if (r.bendMode === 'in' && r.incomingDir) {
      frameN = bendNormal(r.incomingDir, r.boneDir, r.boneDir, axes, r.virtSign);
    }
    r.frameQ = geoQuat(posOf(r.boneName), r.boneDir, axes, frameN);
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
    if (parentTarget) {
      const parentRest = rig.find((x) => x.boneName === r.followParent).restQ;
      const rel = parentRest.clone().invert().multiply(r.restQ);
      targetWorldQ = parentTarget.clone().multiply(rel);
    } else {
      const jp = V3(world[r.srcName].pos);
      let boneDir;
      if (r.srcChild && world[r.srcChild]) boneDir = V3(world[r.srcChild].pos).sub(jp);
      else boneDir = jp.clone().sub(V3(world[SRC_PARENT[r.srcName]].pos));
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
      const aSrc = geoQuat(jp, boneDir, srcAxes, planeN);
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
