// Minimal BVH player (no three.js dependency, testable in Node).
// Dialect follows the MotionBricks / official BVH semantics:
//   - position channels REPLACE the joint offset (they are absolute local positions)
//   - positions are centimeters in the file, meters in the output
//   - rotations are degrees, composed in the listed channel order (R = R1 * R2 * ...)
// Output poses are world-space: { name: { pos: [x,y,z] (m), quat: [x,y,z,w] } }

export function parseBVH(text) {
  const lines = text.split(/\r?\n/);
  const joints = []; // {name, parent, offset:[3] (m), channels:[..]}
  const stack = [];
  let inEndSite = false;
  let i = 0;
  for (; i < lines.length; i++) {
    const t = lines[i].split(/\s+/).filter(Boolean);
    if (!t.length) continue;
    if (t[0] === 'MOTION') { i++; break; }
    if (t[0] === 'ROOT' || t[0] === 'JOINT') {
      const name = t[1].split(':').pop();
      joints.push({
        name,
        parent: stack.length ? stack[stack.length - 1] : -1,
        offset: [0, 0, 0],
        channels: [],
      });
      stack.push(joints.length - 1);
    } else if (t[0] === 'End' && t[1] === 'Site') {
      inEndSite = true;
    } else if (t[0] === 'OFFSET' && !inEndSite) {
      joints[stack[stack.length - 1]].offset =
        t.slice(1, 4).map(Number).map(v => v * 0.01);
    } else if (t[0] === 'CHANNELS') {
      joints[stack[stack.length - 1]].channels = t.slice(2);
    } else if (t[0] === '}') {
      if (inEndSite) inEndSite = false; else stack.pop();
    }
  }
  let frameCount = 0, frameTime = 1 / 30;
  for (; i < lines.length; i++) {
    const t = lines[i].split(/\s+/).filter(Boolean);
    if (!t.length) continue;
    if (t[0] === 'Frames:') frameCount = Number(t[1]);
    else if (t[0] === 'Frame' && t[1] === 'Time:') { frameTime = Number(t[2]); i++; break; }
  }
  const totalChannels = joints.reduce((s, j) => s + j.channels.length, 0);
  const data = new Float64Array(lines.slice(i).join(' ').split(/\s+/).filter(Boolean).map(Number));
  if (data.length !== frameCount * totalChannels) {
    throw new Error(`BVH data size mismatch: got ${data.length}, expected ${frameCount * totalChannels}`);
  }
  // channel column offset per joint
  let col = 0;
  for (const j of joints) { j.col = col; col += j.channels.length; }
  return { joints, frameCount, frameTime, data, totalChannels };
}

const qMul = (a, b) => [ // a * b (apply b first)
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qAxis = (axis, deg) => {
  const h = deg * Math.PI / 360, s = Math.sin(h), q = [0, 0, 0, Math.cos(h)];
  q[axis] = s; return q;
};
const qRotate = (q, v) => {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
};
const qSlerp = (a, b, t) => {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (dot < 0) { dot = -dot; bb = b.map(v => -v); }
  if (dot > 0.9995) {
    const r = a.map((v, k) => v + t * (bb[k] - v));
    const n = Math.hypot(...r); return r.map(v => v / n);
  }
  const th = Math.acos(Math.min(1, dot)), s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((v, k) => wa * v + wb * bb[k]);
};

function frameLocals(bvh, frame) {
  const { joints, data, totalChannels } = bvh;
  const base = frame * totalChannels;
  return joints.map(j => {
    const pos = [...j.offset];
    let quat = [0, 0, 0, 1];
    j.channels.forEach((ch, k) => {
      const v = data[base + j.col + k];
      const axis = 'xyz'.indexOf(ch[0].toLowerCase());
      if (ch.toLowerCase().endsWith('position')) pos[axis] = v * 0.01;
      else quat = qMul(quat, qAxis(axis, v));
    });
    return { pos, quat };
  });
}

// Sample world poses at a (fractional) frame position.
export function sampleWorld(bvh, framePos) {
  const f0 = Math.max(0, Math.min(bvh.frameCount - 1, Math.floor(framePos)));
  const f1 = Math.min(bvh.frameCount - 1, f0 + 1);
  const t = Math.max(0, Math.min(1, framePos - f0));
  const a = frameLocals(bvh, f0), b = frameLocals(bvh, f1);
  const world = new Array(bvh.joints.length);
  const out = {};
  bvh.joints.forEach((j, idx) => {
    const pos = a[idx].pos.map((v, k) => v + t * (b[idx].pos[k] - v));
    const quat = qSlerp(a[idx].quat, b[idx].quat, t);
    if (j.parent < 0) {
      world[idx] = { pos, quat };
    } else {
      const p = world[j.parent];
      const rp = qRotate(p.quat, pos);
      world[idx] = {
        pos: [p.pos[0] + rp[0], p.pos[1] + rp[1], p.pos[2] + rp[2]],
        quat: qMul(p.quat, quat),
      };
    }
    out[j.name] = world[idx];
  });
  return out;
}

// The bind (zero-rotation) world poses, used as the retarget rest pose.
export function restWorld(bvh) {
  const world = new Array(bvh.joints.length);
  const out = {};
  bvh.joints.forEach((j, idx) => {
    if (j.parent < 0) {
      world[idx] = { pos: [...j.offset], quat: [0, 0, 0, 1] };
    } else {
      const p = world[j.parent];
      const rp = qRotate(p.quat, j.offset);
      world[idx] = {
        pos: [p.pos[0] + rp[0], p.pos[1] + rp[1], p.pos[2] + rp[2]],
        quat: [...p.quat],
      };
    }
    out[j.name] = world[idx];
  });
  return out;
}
