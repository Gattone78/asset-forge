#!/usr/bin/env python3
"""Phase 1 mesh assertion for the TRELLIS.2 / UniRig gates. Needs trimesh (present in the comfyui image).

Usage: python check_mesh.py <file.glb> [--min-tris 1000]
Reports: primitive modes (points vs triangles), triangle count, watertight, Euler number, bounds,
and skin / joint / weight presence for the rigging gate.
"""
import argparse
import json
import struct
import sys

ap = argparse.ArgumentParser()
ap.add_argument("glb")
ap.add_argument("--min-tris", type=int, default=1000)
a = ap.parse_args()

# 1. Raw glTF header inspection, independent of trimesh: primitive modes, skins, nodes.
with open(a.glb, "rb") as f:
    magic, ver, length = struct.unpack("<4sII", f.read(12))
    assert magic == b"glTF", "not a GLB"
    clen, ctype = struct.unpack("<II", f.read(8))
    gltf = json.loads(f.read(clen))
MODE = {0: "POINTS", 1: "LINES", 2: "LINE_LOOP", 3: "LINE_STRIP", 4: "TRIANGLES", 5: "TRIANGLE_STRIP", 6: "TRIANGLE_FAN"}
modes = {}
has_weights = False
for m in gltf.get("meshes", []):
    for p in m.get("primitives", []):
        mode = MODE.get(p.get("mode", 4), p.get("mode"))
        modes[mode] = modes.get(mode, 0) + 1
        if "WEIGHTS_0" in p.get("attributes", {}) and "JOINTS_0" in p.get("attributes", {}):
            has_weights = True
skins = gltf.get("skins", [])
joints = sum(len(s.get("joints", [])) for s in skins)
print("primitives by mode:", modes)
print("meshes=%d nodes=%d skins=%d joints=%d animations=%d skin_weights_on_mesh=%s" % (
    len(gltf.get("meshes", [])), len(gltf.get("nodes", [])), len(skins), joints,
    len(gltf.get("animations", [])), has_weights))

# 2. trimesh geometry checks.
import trimesh  # noqa: E402

scene = trimesh.load(a.glb, force="scene")
geoms = list(scene.geometry.values())
tri_meshes = [g for g in geoms if isinstance(g, trimesh.Trimesh)]
others = [type(g).__name__ for g in geoms if not isinstance(g, trimesh.Trimesh)]
print("trimesh geometries: %d (Trimesh=%d, other=%s)" % (len(geoms), len(tri_meshes), others))
if not tri_meshes:
    print("FAIL: no triangle mesh (point cloud / voxel samples?)")
    sys.exit(1)
mesh = trimesh.util.concatenate(tri_meshes) if len(tri_meshes) > 1 else tri_meshes[0]
tris, verts = len(mesh.faces), len(mesh.vertices)
print("triangles=%d vertices=%d watertight=%s euler=%s is_volume=%s" % (
    tris, verts, mesh.is_watertight, mesh.euler_number, mesh.is_volume))
print("bounds min=%s max=%s extents=%s" % (
    mesh.bounds[0].round(3).tolist(), mesh.bounds[1].round(3).tolist(), mesh.extents.round(3).tolist()))
if tris < a.min_tris:
    print("FAIL: %d triangles < %d" % (tris, a.min_tris))
    sys.exit(1)

# "Closed surface": watertight, or nearly so (a handful of boundary edges from UV seams / decimation is tolerable).
if mesh.is_watertight:
    boundary = 0
else:
    groups = trimesh.grouping.group_rows(mesh.edges_sorted, require_count=1)
    boundary = len(groups)
pct = 100.0 * boundary / max(1, len(mesh.edges))
print("boundary edges=%d (%.2f%% of edges)" % (boundary, pct))
closed = mesh.is_watertight or pct < 1.0
print(("PASS" if closed else "FAIL: surface not closed") + " tris=%d watertight=%s" % (tris, mesh.is_watertight))
sys.exit(0 if closed else 1)
