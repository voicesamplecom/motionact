// VRM + VRMA viewer. Files are read locally in the browser only.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

const view = document.getElementById('view');
const statusEl = document.getElementById('status');
const playBtn = document.getElementById('playBtn');
const seekEl = document.getElementById('seek');
const timeLabel = document.getElementById('timeLabel');
const speedEl = document.getElementById('speed');
const zeroOriginEl = document.getElementById('zeroOrigin');
const rotYEl = document.getElementById('rotY');
const setStatus = (s) => { statusEl.textContent = s; };

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
view.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14161a);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
camera.position.set(1.6, 1.4, 3.4);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.95, 0);
controls.enableDamping = true;
scene.add(new THREE.DirectionalLight(0xffffff, 2.4));
scene.add(new THREE.AmbientLight(0xffffff, 0.65));
scene.add(new THREE.GridHelper(30, 30, 0x446, 0x2a2f38));
const modelGroup = new THREE.Group();
scene.add(modelGroup);

let vrm = null;
let pendingAnimation = null; // parsed VRMAnimation waiting for a VRM
let mixer = null;
let action = null;
let duration = 0;
let playing = false;
let hipsOrigin = null; // hips world pos (group offset zeroed) at t=0

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(view);
resize();

async function loadVRM(url, name) {
  setStatus(`VRM 読み込み中: ${name}`);
  const loader = new GLTFLoader();
  loader.register((p) => new VRMLoaderPlugin(p));
  const gltf = await loader.loadAsync(url);
  const newVrm = gltf.userData.vrm;
  if (!newVrm) throw new Error('VRMとして読み込めませんでした');
  if (vrm) { modelGroup.remove(vrm.scene); VRMUtils.deepDispose(vrm.scene); }
  vrm = newVrm;
  if (vrm.meta && vrm.meta.metaVersion === '0') VRMUtils.rotateVRM0(vrm);
  modelGroup.add(vrm.scene);
  hipsOrigin = null;
  setStatus(`VRM 読み込み完了: ${name}`);
  if (pendingAnimation) applyAnimation(pendingAnimation);
}

async function loadVRMA(url, name) {
  setStatus(`VRMA 読み込み中: ${name}`);
  const loader = new GLTFLoader();
  loader.register((p) => new VRMAnimationLoaderPlugin(p));
  const gltf = await loader.loadAsync(url);
  const anims = gltf.userData.vrmAnimations;
  if (!anims || !anims.length) throw new Error('VRMAアニメーションが含まれていません');
  pendingAnimation = anims[0];
  if (vrm) applyAnimation(pendingAnimation);
  else setStatus('VRMA 読み込み完了。VRMを読み込むと再生できます');
}

function applyAnimation(anim) {
  const clip = createVRMAnimationClip(anim, vrm);
  if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(vrm.scene); }
  mixer = new THREE.AnimationMixer(vrm.scene);
  action = mixer.clipAction(clip);
  action.play();
  // capture the origin (hips at t=0) deterministically, before playback
  mixer.setTime(0);
  vrm.update(0);
  hipsOrigin = hipsWorldPos();
  duration = clip.duration;
  seekEl.max = duration.toFixed(2);
  seekEl.value = 0;
  playing = true;
  playBtn.textContent = '⏸ 一時停止';
  setStatus(`再生中: ${clip.name || 'VRMA'}（${duration.toFixed(2)} 秒）`);
}

function hipsWorldPos() {
  // world position of the hips with the group offset removed, so the
  // "zero origin" shift is exact rather than one frame behind.
  const node = vrm.humanoid.getNormalizedBoneNode('hips');
  if (!node) return null;
  const saved = modelGroup.position.clone();
  modelGroup.position.set(0, 0, 0);
  vrm.scene.updateMatrixWorld(true);
  const p = node.getWorldPosition(new THREE.Vector3());
  modelGroup.position.copy(saved);
  return p;
}

const clock = new THREE.Clock();
function tick() {
  requestAnimationFrame(tick);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (vrm) {
    if (mixer && action) {
      if (playing) mixer.update(dt * parseFloat(speedEl.value));
      const t = duration > 0 ? action.time % duration : 0;
      if (document.activeElement !== seekEl) seekEl.value = t;
      timeLabel.textContent = `${t.toFixed(2)} / ${duration.toFixed(2)} s`;
    }
    vrm.update(dt);
    if (zeroOriginEl.checked && mixer) {
      const p = hipsWorldPos();
      if (p) {
        if (!hipsOrigin) hipsOrigin = p.clone();
        modelGroup.position.set(-(p.x - hipsOrigin.x), 0, -(p.z - hipsOrigin.z));
      }
    } else {
      modelGroup.position.set(0, 0, 0);
      hipsOrigin = null;
    }
    modelGroup.rotation.y = THREE.MathUtils.degToRad(parseFloat(rotYEl.value));
  }
  controls.update();
  renderer.render(scene, camera);
}
tick();

playBtn.addEventListener('click', () => {
  if (!action) return;
  playing = !playing;
  playBtn.textContent = playing ? '⏸ 一時停止' : '▶ 再生';
});
seekEl.addEventListener('input', () => {
  if (!mixer || !action) return;
  mixer.setTime(parseFloat(seekEl.value));
});

function fileURL(input) {
  const f = input.files && input.files[0];
  return f ? { url: URL.createObjectURL(f), name: f.name } : null;
}
document.getElementById('vrmFile').addEventListener('change', async (e) => {
  const f = fileURL(e.target); if (!f) return;
  try { await loadVRM(f.url, f.name); } catch (err) { setStatus(`VRM読み込み失敗: ${err.message}`); }
});
document.getElementById('vrmaFile').addEventListener('change', async (e) => {
  const f = fileURL(e.target); if (!f) return;
  try { await loadVRMA(f.url, f.name); } catch (err) { setStatus(`VRMA読み込み失敗: ${err.message}`); }
});

const dropEl = document.getElementById('drop');
addEventListener('dragover', (e) => { e.preventDefault(); dropEl.style.display = 'grid'; });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) dropEl.style.display = 'none'; });
addEventListener('drop', async (e) => {
  e.preventDefault(); dropEl.style.display = 'none';
  for (const f of e.dataTransfer.files) {
    const url = URL.createObjectURL(f);
    try {
      if (/\.vrm$/i.test(f.name)) await loadVRM(url, f.name);
      else if (/\.vrma$/i.test(f.name)) await loadVRMA(url, f.name);
    } catch (err) { setStatus(`読み込み失敗 (${f.name}): ${err.message}`); }
  }
});

// ?vrm=<url>&vrma=<url> for local testing / direct links
const q = new URLSearchParams(location.search);
(async () => {
  try {
    if (q.get('vrma')) await loadVRMA(q.get('vrma'), q.get('vrma'));
    if (q.get('vrm')) await loadVRM(q.get('vrm'), q.get('vrm'));
    if (q.get('t') && mixer) { mixer.setTime(parseFloat(q.get('t'))); playing = false; playBtn.textContent = '▶ 再生'; }
  } catch (err) { setStatus(`読み込み失敗: ${err.message}`); }
})();

// hooks for headless verification
window.__viewer = {
  get ready() { return !!action; },
  get duration() { return duration; },
  setTime(t) { if (mixer) { mixer.setTime(t); } },
  groupPos() { return modelGroup.position.toArray(); },
  rawHips() { const p = hipsWorldPos(); return p ? p.toArray() : null; },
  bones() {
    if (!vrm) return null;
    const out = {};
    vrm.scene.updateMatrixWorld(true);
    for (const b of ['hips','leftUpperArm','leftLowerArm','leftHand','rightUpperArm','rightLowerArm','rightHand','leftUpperLeg','leftLowerLeg','leftFoot','leftToes','rightUpperLeg','rightLowerLeg','rightFoot','rightToes']) {
      const n = vrm.humanoid.getNormalizedBoneNode(b);
      if (!n) { out[b] = null; continue; }
      const p = n.getWorldPosition(new THREE.Vector3());
      out[b] = [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
    }
    return out;
  },
};
