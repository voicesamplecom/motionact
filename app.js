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
// rotation. Known limitation: twist around each bone's own axis is only
// approximated, because the frame comes from body-level axes.
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
const skelGroup = new THREE.Group();
scene.add(skelGroup);
let skelLines = null;

async function loadBVHText(text, label) {
  bvh = parseBVH(text);
  bvhFirst = sampleWorld(bvh, 0);
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

// Quaternion of the geometric frame: Y = bone dir, X = orthogonal secondary.
function geoQuat(jointPos, boneDirVec, axes) {
  const y = boneDirVec.clone().normalize();
  const s = Math.abs(y.dot(axes.left)) < 0.8 ? axes.left : axes.forward;
  const x = s.clone().addScaledVector(y, -s.dot(y)).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

// ------------------------------------------------------------------------ VRM
// [SOMA BVH joint, VRM humanoid bone, primary child BVH joint (null = incoming dir)]
const MAP = [
  ['Hips', 'hips', 'Spine1'],
  ['Spine1', 'spine', 'Spine2'],
  ['Spine2', 'chest', 'Chest'],
  ['Chest', 'upperChest', 'Neck1'],
  ['Neck1', 'neck', 'Neck2'],
  ['Head', 'head', null],
  ['LeftShoulder', 'leftShoulder', 'LeftArm'],
  ['LeftArm', 'leftUpperArm', 'LeftForeArm'],
  ['LeftForeArm', 'leftLowerArm', 'LeftHand'],
  ['LeftHand', 'leftHand', null],
  ['RightShoulder', 'rightShoulder', 'RightArm'],
  ['RightArm', 'rightUpperArm', 'RightForeArm'],
  ['RightForeArm', 'rightLowerArm', 'RightHand'],
  ['RightHand', 'rightHand', null],
  ['LeftLeg', 'leftUpperLeg', 'LeftShin'],
  ['LeftShin', 'leftLowerLeg', 'LeftFoot'],
  ['LeftFoot', 'leftFoot', 'LeftToeBase'],
  ['LeftToeBase', 'leftToes', null],
  ['RightLeg', 'rightUpperLeg', 'RightShin'],
  ['RightShin', 'rightLowerLeg', 'RightFoot'],
  ['RightFoot', 'rightFoot', 'RightToeBase'],
  ['RightToeBase', 'rightToes', null],
];
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
  for (const [srcName, boneName, srcChild] of MAP) {
    const node = dstNode[boneName];
    if (!node) continue;
    const childName = childOf(boneName);
    let boneDir;
    if (childName) boneDir = dstPos[childName].clone().sub(dstPos[boneName]);
    else {
      boneDir = null; // incoming direction, resolved below from the parent node
    }
    rig.push({ node, boneName, srcName, srcChild, childName, boneDir });
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
    r.frameQ = geoQuat(posOf(r.boneName), r.boneDir, axes);
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
  for (const r of rig) {
    const jp = V3(world[r.srcName].pos);
    let boneDir;
    if (r.srcChild && world[r.srcChild]) boneDir = V3(world[r.srcChild].pos).sub(jp);
    else boneDir = jp.clone().sub(V3(world[SRC_PARENT[r.srcName]].pos));
    const aSrc = geoQuat(jp, boneDir, srcAxes);
    const targetWorldQ = aSrc.multiply(r.frameQ.clone().invert()).multiply(r.restQ);
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
