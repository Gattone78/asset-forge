"""Convert a rigged FBX to GLB with Blender's bpy, keeping the armature and skin weights.

Runs with the bpy that lives in the UniRig comfy-env isolated environment (inside the comfyui container):
    /opt/ComfyUI/ce/envs/unirig-nodes/.pixi/envs/default/bin/python scripts/fbx_to_glb.py in.fbx out.glb
Prints the armature bone count and which meshes carry vertex groups (skin weights).
"""
import sys

import bpy

src, dst = sys.argv[1], sys.argv[2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=src)

arms = [o for o in bpy.data.objects if o.type == "ARMATURE"]
meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for a in arms:
    print("armature %s: %d bones, root(s)=%s" % (a.name, len(a.data.bones), [b.name for b in a.data.bones if b.parent is None]))
for m in meshes:
    mods = [md.type for md in m.modifiers]
    print("mesh %s: %d verts, %d vertex groups, modifiers=%s" % (m.name, len(m.data.vertices), len(m.vertex_groups), mods))

bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_skins=True, export_animations=False,
                          export_yup=True, export_apply=False)
print("wrote", dst)
