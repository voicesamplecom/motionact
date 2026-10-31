"""Generate the bundled sample BVH (tools -> motion/sample_wave.bvh).

This sample is 100% original data, authored for this project:
a hand-built skeleton (typical humanoid proportions, Y-up) and a
procedural "step in place and wave" loop made of sine curves.
It is NOT derived from any motion-capture dataset, so it can be
redistributed freely with this repository.

Joint names follow the SOMA naming so the player's retarget map works.
Channel order is Zrotation Yrotation Xrotation (R = Rz @ Ry @ Rx),
positions are centimeters, rotations are degrees.
"""
import math
from pathlib import Path

# name, parent, offset(cm)
JOINTS = [
    ("Hips", None, (0, 98, 0)),
    ("Spine1", "Hips", (0, 11, 0)),
    ("Spine2", "Spine1", (0, 11, 0)),
    ("Chest", "Spine2", (0, 12, 0)),
    ("Neck1", "Chest", (0, 14, 0)),
    ("Neck2", "Neck1", (0, 7, 0)),
    ("Head", "Neck2", (0, 7, 0)),
    ("Jaw", "Head", (0, -3, 3)),
    ("LeftEye", "Head", (3.5, 2, 8)),
    ("RightEye", "Head", (-3.5, 2, 8)),
    ("LeftShoulder", "Chest", (5, 10, 0)),
    ("LeftArm", "LeftShoulder", (13, 0, 0)),
    ("LeftForeArm", "LeftArm", (26, 0, 0)),
    ("LeftHand", "LeftForeArm", (24, 0, 0)),
    ("LeftHandThumbEnd", "LeftHand", (6, -2, 4)),
    ("LeftHandMiddleEnd", "LeftHand", (9, 0, 1)),
    ("RightShoulder", "Chest", (-5, 10, 0)),
    ("RightArm", "RightShoulder", (-13, 0, 0)),
    ("RightForeArm", "RightArm", (-26, 0, 0)),
    ("RightHand", "RightForeArm", (-24, 0, 0)),
    ("RightHandThumbEnd", "RightHand", (-6, -2, 4)),
    ("RightHandMiddleEnd", "RightHand", (-9, 0, 1)),
    ("LeftLeg", "Hips", (10, -4, 0)),
    ("LeftShin", "LeftLeg", (0, -42, 0)),
    ("LeftFoot", "LeftShin", (0, -42, 0)),
    ("LeftToeBase", "LeftFoot", (0, -7, 12)),
    ("RightLeg", "Hips", (-10, -4, 0)),
    ("RightShin", "RightLeg", (0, -42, 0)),
    ("RightFoot", "RightShin", (0, -42, 0)),
    ("RightToeBase", "RightFoot", (0, -7, 12)),
]
FRAMES = 90  # 3 s at 30 Hz


def pose(f):
    """Return {joint: (z, y, x) degrees} and the Hips position (cm)."""
    t = 2 * math.pi * f / FRAMES
    s, c = math.sin(t), math.cos(t)
    r = {name: [0.0, 0.0, 0.0] for name, _, _ in JOINTS}
    # stepping legs (x = forward/back swing, knee bends backward = +x)
    r["LeftLeg"][2] = -22 * s
    r["RightLeg"][2] = 22 * s
    r["LeftShin"][2] = 10 + 9 * math.sin(t + 2.1)
    r["RightShin"][2] = 10 + 9 * math.sin(t + 2.1 + math.pi)
    r["LeftFoot"][2] = 6 * s
    r["RightFoot"][2] = -6 * s
    # torso sway / twist
    r["Spine1"] = [1.5 * s, 3 * s, 0]
    r["Chest"] = [1.5 * s, 4 * s, 0]
    r["Head"] = [0, 7 * s, 4 * math.sin(2 * t)]
    # left arm hangs and swings
    r["LeftArm"] = [-75 + 6 * s, 0, -8 * s]
    r["LeftForeArm"] = [-8, 0, 0]
    # right arm raised, waving (forearm oscillates fast)
    wave = math.sin(4 * t)
    r["RightArm"] = [-110 + 7 * wave, 0, 0]
    r["RightForeArm"] = [-18 + 14 * wave, 0, 0]
    hips_pos = (2.0 * s, 97.2 + 1.4 * abs(math.sin(t)), 0.0)
    r["Hips"] = [2.5 * s, 5 * s, 0]
    return r, hips_pos


def main():
    children = {name: [] for name, _, _ in JOINTS}
    root = None
    for name, parent, _ in JOINTS:
        if parent is None:
            root = name
        else:
            children[parent].append(name)
    by_name = {name: (parent, off) for name, parent, off in JOINTS}
    lines = ["HIERARCHY"]

    def emit(name, depth, is_root):
        ind = " " * depth
        _, off = by_name[name]
        lines.append(f"{ind}{'ROOT' if is_root else 'JOINT'} {name}")
        lines.append(f"{ind}{{")
        lines.append(f"{ind} OFFSET {off[0]:.3f} {off[1]:.3f} {off[2]:.3f}")
        if is_root:
            lines.append(f"{ind} CHANNELS 6 Xposition Yposition Zposition Zrotation Yrotation Xrotation")
        else:
            lines.append(f"{ind} CHANNELS 3 Zrotation Yrotation Xrotation")
        for ch in children[name]:
            emit(ch, depth + 1, False)
        lines.append(f"{ind}}}")

    emit(root, 0, True)
    lines.append("MOTION")
    lines.append(f"Frames: {FRAMES}")
    lines.append("Frame Time: 0.033333")
    order = [name for name, _, _ in JOINTS]
    for f in range(FRAMES):
        rot, hips_pos = pose(f)
        vals = []
        for name in order:
            if name == root:
                vals += [f"{v:.4f}" for v in hips_pos]
            vals += [f"{v:.4f}" for v in rot[name]]
        lines.append(" ".join(vals))
    out = Path(__file__).resolve().parent.parent / "motion" / "sample_wave.bvh"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {out} ({FRAMES} frames)")


if __name__ == "__main__":
    main()
