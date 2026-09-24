"""Asset Forge post stage — Blender headless (4.5 LTS) part.

Invoked by svc-post as:  blender -b --python forge_post.py -- <subcommand> [args]

Subcommands
  process  --in mesh.glb --out out.glb [--fbx out.fbx] [--thumb thumb.png] [--report report.json]
           [--height 0.6] [--yaw-deg 0] [--no-normalize]
           [--material flat-albedo|pbr|vertex] [--bake-size 2048] [--hires painted.glb] [--cage 0.02]
           Joins all meshes into one object named pivot_root, normalizes (meters, Y-up, -Z forward,
           origin at feet, target height), bakes vertex colours to an albedo texture (flat-albedo),
           renders a thumbnail, exports GLB (+ FBX).
  render   --in mesh.glb --out img.png [--size 768] [--azimuth 35] [--elevation 18] [--label text]
           Fixed-camera Cycles CPU render, framed on the bounding box so before/after images match.

Conventions (req §8): glTF is Y-up; Blender is Z-up. The glTF importer maps glTF (x, y, z) -> Blender
(x, -z, y) and the exporter reverses it, so "glTF -Z forward" == "Blender +Y forward". The normalize
step puts the base at z=0 (feet), centres x/y, scales so the z extent == target height, and applies
--yaw-deg about Z so the model's front faces Blender +Y (glTF -Z).
"""
import argparse
import json
import math
import os
import sys
import time

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def log(*a):
    print("[forge_post]", *a, flush=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if not meshes:
        raise SystemExit("no mesh objects in " + path)
    return new, meshes


def join_meshes(meshes, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    # Free it from any parent empties so the transform we apply is the whole story.
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    if obj.parent is not None:
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.name = name
    obj.data.name = name + "_mesh"
    return obj


def world_bbox(obj):
    pts = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def normalize(obj, height, yaw_deg):
    """Origin at feet, centred, uniform scale to `height` metres, yaw about Z. Applied into the mesh data."""
    if yaw_deg:
        # The glTF importer leaves objects in QUATERNION rotation mode, where rotation_euler is ignored.
        obj.rotation_mode = "XYZ"
        obj.rotation_euler = (0.0, 0.0, math.radians(yaw_deg))
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    lo, hi = world_bbox(obj)
    ext = hi - lo
    if ext.z <= 0:
        raise SystemExit("degenerate height")
    s = height / ext.z
    obj.scale = (s, s, s)
    obj.location = (-(lo.x + hi.x) / 2 * s, -(lo.y + hi.y) / 2 * s, -lo.z * s)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.location = (0, 0, 0)
    return s


def color_attr_name(mesh):
    if mesh.color_attributes:
        return mesh.color_attributes[0].name
    return None


def emission_material(name, color_source_node_factory):
    """Material whose surface is a pure Emission of `color_source` — lighting-independent, so bakes and
    renders are flat and deterministic (the flat profile is unlit in-game anyway)."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 1.0
    src = color_source_node_factory(nt)
    nt.links.new(src.outputs[0], emit.inputs["Color"])
    nt.links.new(emit.outputs[0], out.inputs["Surface"])
    return mat


def vertex_color_material(name, attr):
    def factory(nt):
        n = nt.nodes.new("ShaderNodeVertexColor")
        n.layer_name = attr
        return n
    return emission_material(name, factory)


def image_material(name, image):
    def factory(nt):
        n = nt.nodes.new("ShaderNodeTexImage")
        n.image = image
        n.interpolation = "Closest" if False else "Linear"
        return n
    return emission_material(name, factory)


def pbr_vertex_material(name, attr):
    """Export material for the vertex-colour variant: Principled with Base Color <- Color Attribute.
    The glTF exporter writes baseColorFactor white + COLOR_0, which Three.js renders as-is."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = attr
    nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 1.0
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.0
    return mat


def set_material(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)


def smart_uv(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    if not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.003, correct_aspect=True,
                             scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def bake_albedo(obj, size, hires=None, cage=0.02, samples=8):
    """Bake the emission colour of `obj` (or of `hires` onto obj's UVs) into a new image."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.margin = 8
    img = bpy.data.images.new("albedo", size, size, alpha=False)
    img.colorspace_settings.name = "sRGB"

    # Target node: the active image texture node in the low-poly's material receives the bake.
    mat = obj.data.materials[0]
    nt = mat.node_tree
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.nodes.active = tex

    bpy.ops.object.select_all(action="DESELECT")
    if hires is not None:
        hires.select_set(True)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    t0 = time.time()
    if hires is not None:
        # Short rays: long ones reach across cavities (visor rim) and sample the far wall's colour.
        bpy.ops.object.bake(type="EMIT", use_selected_to_active=True, cage_extrusion=cage,
                            max_ray_distance=cage * 2, use_clear=True)
    else:
        bpy.ops.object.bake(type="EMIT", use_clear=True)
    log("bake %dpx took %.1fs (selected_to_active=%s)" % (size, time.time() - t0, hires is not None))
    nt.nodes.remove(tex)
    return img


def frame_camera(obj, azimuth_deg, elevation_deg, margin=1.12):
    """Camera on a sphere around the bbox centre, looking at it, sized to the bbox diagonal."""
    lo, hi = world_bbox(obj)
    centre = (lo + hi) / 2
    radius = (hi - lo).length / 2 * margin
    cam_data = bpy.data.cameras.new("cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = radius * 2
    cam = bpy.data.objects.new("cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    az, el = math.radians(azimuth_deg), math.radians(elevation_deg)
    d = radius * 4
    # Azimuth 0 = camera on Blender -Y looking +Y, i.e. it shows the glTF +Z face. glTF (x,y,z) -> Blender (x,-z,y).
    pos = centre + Vector((d * math.sin(az) * math.cos(el), -d * math.cos(az) * math.cos(el), d * math.sin(el)))
    cam.location = pos
    direction = centre - pos
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam


def render_png(path, size, samples=16):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = False
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = path
    world = bpy.data.worlds.new("w") if not scene.world else scene.world
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (1, 1, 1, 1)
        bg.inputs[1].default_value = 1.0
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    log("render %s in %.1fs" % (os.path.basename(path), time.time() - t0))


def mesh_stats(obj):
    m = obj.data
    m.calc_loop_triangles()
    lo, hi = world_bbox(obj)
    # Report the bbox in glTF axes (Y-up, -Z forward): Blender (x, y, z) -> glTF (x, z, -y).
    gmin = [round(lo.x, 4), round(lo.z, 4), round(-hi.y, 4)]
    gmax = [round(hi.x, 4), round(hi.z, 4), round(-lo.y, 4)]
    return {"tris": len(m.loop_triangles), "verts": len(m.vertices), "faces": len(m.polygons),
            "bbox_min": gmin, "bbox_max": gmax,
            "height_m": round(hi.z - lo.z, 4), "has_uv": bool(m.uv_layers), "color_attr": color_attr_name(m)}


def cmd_process(a):
    reset()
    t_all = time.time()
    _, meshes = import_glb(a.inp)
    obj = join_meshes(meshes, "pivot_root")
    report = {"input": os.path.basename(a.inp), "before": mesh_stats(obj), "ops": []}
    log("imported", report["before"])

    if a.target_tris and report["before"]["tris"] > a.target_tris:
        # Blender's collapse decimator: robust on closed remeshed input, deterministic, keeps vertex colours.
        mod = obj.modifiers.new("decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = a.target_tris / report["before"]["tris"]
        mod.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = obj
        t0 = time.time()
        bpy.ops.object.modifier_apply(modifier=mod.name)
        st = mesh_stats(obj)
        report["ops"].append({"op": "decimate", "tool": "blender-collapse", "ratio": round(mod.ratio, 6),
                              "tris_before": report["before"]["tris"], "tris_after": st["tris"], "seconds": round(time.time() - t0, 1)})
        log("blender decimate -> %d tris in %.1fs" % (st["tris"], time.time() - t0))

    # Normalize after any decimation so the exported height is exact.
    if not a.no_normalize:
        s = normalize(obj, a.height, a.yaw_deg)
        report["ops"].append({"op": "normalize", "scale": round(s, 6), "yaw_deg": a.yaw_deg,
                              "height_m": a.height, "up_axis": "Y", "forward": "-Z", "origin": "feet"})

    attr = color_attr_name(obj.data)
    material = a.material
    if material == "flat-albedo" and attr is None and a.hires is None:
        log("no vertex colours and no --hires; nothing to bake, falling back to material=vertex")
        material = "vertex"

    if material == "flat-albedo":
        smart_uv(obj)
        hires_obj = None
        if a.hires:
            _, hm = import_glb(a.hires)
            hires_obj = join_meshes(hm, "hires_src")
            # The hires mesh is in raw coordinates; give it the same transform as the low-poly got.
            if not a.no_normalize:
                normalize(hires_obj, a.height, a.yaw_deg)
            hattr = color_attr_name(hires_obj.data)
            set_material(hires_obj, vertex_color_material("hires_vc", hattr))
            set_material(obj, vertex_color_material("lowpoly_tmp", attr or hattr))
        else:
            set_material(obj, vertex_color_material("lowpoly_vc", attr))
        img = bake_albedo(obj, a.bake_size, hires=hires_obj, cage=a.cage * a.height)
        # Final material: plain base-colour texture. Emission for the flat look (Three.js MeshBasicMaterial
        # equivalent); the glTF exporter writes it as KHR_materials_emissive_strength + baseColor.
        mat = bpy.data.materials.new("flat_albedo")
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = nt.nodes.get("Principled BSDF")
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = img
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
        bsdf.inputs["Roughness"].default_value = 1.0
        if "Specular IOR Level" in bsdf.inputs:
            bsdf.inputs["Specular IOR Level"].default_value = 0.0
        set_material(obj, mat)
        if hires_obj is not None:
            bpy.data.objects.remove(hires_obj, do_unlink=True)
        # Drop the vertex colour attribute: the texture carries it now.
        if attr and attr in obj.data.color_attributes:
            obj.data.color_attributes.remove(obj.data.color_attributes[attr])
        report["ops"].append({"op": "bake-albedo", "size": a.bake_size, "source": "hires" if a.hires else "vertex-colors"})
    elif material == "vertex":
        set_material(obj, pbr_vertex_material("vertex_colors", attr) if attr else bpy.data.materials.new("plain"))
        report["ops"].append({"op": "keep-vertex-colors"})
    else:  # pbr: keep whatever came in
        report["ops"].append({"op": "keep-materials"})

    # Plain smooth shading (no sharp edges) and point-domain colours so the glTF exporter can share
    # vertices instead of splitting every face corner (which bloats the file and reads as open edges).
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.shade_smooth()
    attr = color_attr_name(obj.data)
    if attr and obj.data.color_attributes[attr].domain != "POINT":
        obj.data.color_attributes.active_color = obj.data.color_attributes[attr]
        bpy.ops.geometry.color_attribute_convert(domain="POINT", data_type="BYTE_COLOR")
        report["ops"].append({"op": "colors-to-point-domain"})

    report["after"] = mesh_stats(obj)

    if a.thumb:
        # Three-quarter view of the FRONT: the model now faces glTF -Z == Blender +Y, and azimuth 0 sits on
        # Blender -Y, so 180 + 35 looks at the face from front-left.
        frame_camera(obj, 215, 18)
        render_png(a.thumb, a.thumb_size)

    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    gltf_kwargs = dict(filepath=a.out, export_format="GLB", use_selection=True, export_yup=True,
                       export_apply=True, export_texcoords=True, export_normals=True,
                       export_image_format="AUTO", export_animations=False, export_skins=False,
                       export_lights=False, export_cameras=False)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    if "export_vertex_color" in props:  # Blender 4.2+: MATERIAL | ACTIVE | NONE
        gltf_kwargs["export_vertex_color"] = "NONE" if material == "flat-albedo" else "ACTIVE"
    if "export_all_vertex_colors" in props:
        gltf_kwargs["export_all_vertex_colors"] = False
    bpy.ops.export_scene.gltf(**gltf_kwargs)
    report["ops"].append({"op": "export-glb", "path": os.path.basename(a.out)})
    if a.fbx:
        bpy.ops.export_scene.fbx(filepath=a.fbx, use_selection=True, apply_unit_scale=True, apply_scale_options="FBX_SCALE_ALL",
                                 axis_forward="-Z", axis_up="Y", path_mode="COPY", embed_textures=True,
                                 mesh_smooth_type="FACE", add_leaf_bones=False, bake_anim=False)
        report["ops"].append({"op": "export-fbx", "path": os.path.basename(a.fbx)})
    report["blender"] = bpy.app.version_string
    report["seconds"] = round(time.time() - t_all, 1)
    if a.report:
        with open(a.report, "w") as f:
            json.dump(report, f, indent=1)
    log("done", json.dumps(report["after"]), "%.1fs" % report["seconds"])


def cmd_render(a):
    reset()
    _, meshes = import_glb(a.inp)
    obj = join_meshes(meshes, "subject")
    attr = color_attr_name(obj.data)
    has_images = any(n.type == "TEX_IMAGE" and n.image for m in obj.data.materials if m and m.use_nodes for n in m.node_tree.nodes)
    if (a.force_vertex_colors or not has_images) and attr:
        # Vertex-coloured mesh (raw / decimated variants): render the colour attribute directly.
        set_material(obj, vertex_color_material("vc", attr))
    elif not obj.data.materials or all(m is None for m in obj.data.materials):
        set_material(obj, bpy.data.materials.new("plain"))
    else:
        # Make imported Principled materials render flat (emission of their base colour input) so
        # textured and vertex-coloured variants are comparable without lighting.
        for m in obj.data.materials:
            if m is None or not m.use_nodes:
                continue
            nt = m.node_tree
            bsdf = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)
            out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
            if bsdf and out:
                emit = nt.nodes.new("ShaderNodeEmission")
                src = bsdf.inputs["Base Color"]
                if src.is_linked:
                    nt.links.new(src.links[0].from_socket, emit.inputs["Color"])
                else:
                    emit.inputs["Color"].default_value = src.default_value
                nt.links.new(emit.outputs[0], out.inputs["Surface"])
    frame_camera(obj, a.azimuth, a.elevation)
    render_png(a.out, a.size)
    st = mesh_stats(obj)
    log("stats", json.dumps(st))
    if a.stats:
        with open(a.stats, "w") as f:
            json.dump(st, f)


def cmd_rigmerge(a):
    """Merge UniRig's rigged FBX with the textured, normalized asset (req §4/§8):
    - armature root named "Armature", bone names as UniRig produced them (listed in the report)
    - the baked material from the unrigged GLB is re-applied (UniRig keeps the UV layout)
    - re-normalized: UniRig rescales to a +-1 box, so feet -> y=0 and height -> target again
    - exported as GLB with skins and as FBX"""
    reset()
    t_all = time.time()
    before = set(bpy.data.objects)
    bpy.ops.import_scene.fbx(filepath=a.rigged, use_anim=False)
    fbx_objs = [o for o in bpy.data.objects if o not in before]
    arms = [o for o in fbx_objs if o.type == "ARMATURE"]
    meshes = [o for o in fbx_objs if o.type == "MESH"]
    if not arms or not meshes:
        raise SystemExit("rigged FBX has no armature or no mesh")
    arm = arms[0]
    arm.name = "Armature"
    arm.data.name = "Armature"
    # One mesh object (join if UniRig split it), keep its armature modifier / vertex groups.
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    mesh = bpy.context.view_layer.objects.active
    mesh.name = "pivot_root"
    mesh.data.name = "pivot_root_mesh"
    if not any(md.type == "ARMATURE" for md in mesh.modifiers):
        md = mesh.modifiers.new("Armature", "ARMATURE")
        md.object = arm
    bones = [b.name for b in arm.data.bones]
    roots = [b.name for b in arm.data.bones if b.parent is None]
    report = {"input": os.path.basename(a.rigged), "bones": len(bones), "bone_names": bones, "roots": roots,
              "before": mesh_stats(mesh), "ops": []}
    log("rigged fbx: %d bones, mesh %s" % (len(bones), report["before"]))

    # Re-apply the baked material from the unrigged asset (same UV layout).
    if a.textured:
        _, tm = import_glb(a.textured)
        src = tm[0]
        if src.data.materials and src.data.materials[0] is not None and mesh.data.uv_layers:
            mat = src.data.materials[0]
            set_material(mesh, mat)
            report["ops"].append({"op": "reapply-material", "from": os.path.basename(a.textured), "material": mat.name})
            log("material re-applied from", os.path.basename(a.textured))
        else:
            report["ops"].append({"op": "reapply-material", "skipped": "no material or no UVs"})
        for o in tm:
            bpy.data.objects.remove(o, do_unlink=True)

    # Normalize the whole rig: transform the armature (mesh follows as its child), then apply.
    if not a.no_normalize:
        if a.yaw_deg:
            arm.rotation_mode = "XYZ"
            arm.rotation_euler = (0.0, 0.0, math.radians(a.yaw_deg))
        bpy.context.view_layer.update()
        lo, hi = world_bbox(mesh)
        ext = hi - lo
        s = a.height / ext.z
        arm.scale = (arm.scale.x * s, arm.scale.y * s, arm.scale.z * s)
        bpy.context.view_layer.update()
        lo, hi = world_bbox(mesh)
        arm.location = (arm.location.x - (lo.x + hi.x) / 2, arm.location.y - (lo.y + hi.y) / 2, arm.location.z - lo.z)
        bpy.context.view_layer.update()
        bpy.ops.object.select_all(action="DESELECT")
        arm.select_set(True)
        mesh.select_set(True)
        bpy.context.view_layer.objects.active = arm
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        report["ops"].append({"op": "normalize", "scale": round(s, 6), "yaw_deg": a.yaw_deg, "height_m": a.height,
                              "up_axis": "Y", "forward": "-Z", "origin": "feet"})
    bpy.ops.object.select_all(action="DESELECT")
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = mesh
    # The FBX round trip leaves custom split normals and per-corner UV noise; both make the glTF exporter
    # split every vertex (3x verts). Clear the normals, quantise UVs, and merge duplicate vertices.
    if hasattr(mesh.data, "has_custom_normals") and mesh.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    for uvl in mesh.data.uv_layers:
        for d in uvl.data:
            d.uv = (round(d.uv.x, 5), round(d.uv.y, 5))
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=1e-6)
    bpy.ops.mesh.mark_sharp(clear=True)          # FBX smoothing groups arrive as sharp edges -> exporter splits
    bpy.ops.object.mode_set(mode="OBJECT")
    for attr_name in ("sharp_face", "sharp_edge"):
        attr = mesh.data.attributes.get(attr_name)
        if attr is not None:
            mesh.data.attributes.remove(attr)
    bpy.ops.object.shade_smooth()
    report["ops"].append({"op": "weld-vertices", "verts": len(mesh.data.vertices)})
    report["after"] = mesh_stats(mesh)

    if a.thumb:
        frame_camera(mesh, 215, 18)
        render_png(a.thumb, a.thumb_size)

    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    mesh.select_set(True)
    gltf_kwargs = dict(filepath=a.out, export_format="GLB", use_selection=True, export_yup=True, export_apply=False,
                       export_texcoords=True, export_normals=True, export_image_format="AUTO",
                       export_animations=False, export_skins=True, export_lights=False, export_cameras=False)
    props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
    if "export_vertex_color" in props:
        gltf_kwargs["export_vertex_color"] = "NONE"
    if "export_def_bones" in props:
        gltf_kwargs["export_def_bones"] = False
    if "export_influence_nb" in props:
        gltf_kwargs["export_influence_nb"] = 4
    bpy.ops.export_scene.gltf(**gltf_kwargs)
    report["ops"].append({"op": "export-glb", "path": os.path.basename(a.out)})
    if a.fbx:
        bpy.ops.export_scene.fbx(filepath=a.fbx, use_selection=True, apply_unit_scale=True, apply_scale_options="FBX_SCALE_ALL",
                                 axis_forward="-Z", axis_up="Y", path_mode="COPY", embed_textures=True,
                                 mesh_smooth_type="FACE", add_leaf_bones=False, bake_anim=False)
        report["ops"].append({"op": "export-fbx", "path": os.path.basename(a.fbx)})
    report["blender"] = bpy.app.version_string
    report["seconds"] = round(time.time() - t_all, 1)
    if a.report:
        with open(a.report, "w") as f:
            json.dump(report, f, indent=1)
    log("rigmerge done: %d bones, %s, %.1fs" % (len(bones), json.dumps(report["after"]), report["seconds"]))


ap = argparse.ArgumentParser(prog="forge_post")
sp = ap.add_subparsers(dest="cmd", required=True)
p = sp.add_parser("process")
p.add_argument("--in", dest="inp", required=True)
p.add_argument("--out", required=True)
p.add_argument("--fbx")
p.add_argument("--thumb")
p.add_argument("--thumb-size", type=int, default=512)
p.add_argument("--report")
p.add_argument("--height", type=float, default=0.6)
p.add_argument("--yaw-deg", type=float, default=0.0)
p.add_argument("--no-normalize", action="store_true")
p.add_argument("--material", choices=["flat-albedo", "pbr", "vertex"], default="flat-albedo")
p.add_argument("--bake-size", type=int, default=2048)
p.add_argument("--hires")
p.add_argument("--cage", type=float, default=0.01, help="cage extrusion as a fraction of height (rays reach 2x this)")
p.add_argument("--target-tris", type=int, default=0, help="collapse-decimate to this many triangles (0 = off)")
p.set_defaults(fn=cmd_process)
r = sp.add_parser("render")
r.add_argument("--in", dest="inp", required=True)
r.add_argument("--out", required=True)
r.add_argument("--size", type=int, default=768)
r.add_argument("--azimuth", type=float, default=35.0)
r.add_argument("--elevation", type=float, default=18.0)
r.add_argument("--stats")
r.add_argument("--force-vertex-colors", action="store_true")
r.set_defaults(fn=cmd_render)
g = sp.add_parser("rigmerge")
g.add_argument("--rigged", required=True, help="UniRig FBX (armature + skinned mesh)")
g.add_argument("--textured", help="unrigged, normalized GLB whose material is re-applied")
g.add_argument("--out", required=True)
g.add_argument("--fbx")
g.add_argument("--thumb")
g.add_argument("--thumb-size", type=int, default=512)
g.add_argument("--report")
g.add_argument("--height", type=float, default=0.6)
g.add_argument("--yaw-deg", type=float, default=0.0)
g.add_argument("--no-normalize", action="store_true")
g.set_defaults(fn=cmd_rigmerge)

args = ap.parse_args(argv)
args.fn(args)
