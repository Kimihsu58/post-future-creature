import bpy
import bmesh
import math
import os
import random

random.seed(42)

# ----------------------------------------------------------------------------
# Output path: project root (parent of this blender/ folder)
# ----------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
OUTPUT_PATH = os.path.join(PROJECT_DIR, "creature.obj")

# ----------------------------------------------------------------------------
# 1. Clean the default scene
# ----------------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

for collection in bpy.data.collections:
    pass

# ----------------------------------------------------------------------------
# 2. Body: a simple icosphere (organic-ish blob). We scale it a bit.
# ----------------------------------------------------------------------------
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=4, radius=1.0, location=(0, 0, 0))
body = bpy.context.active_object
body.name = "Body"
body.scale = (1.0, 1.0, 0.8)  # slightly squashed

# Smooth shading for a nicer look when rendered
bpy.ops.object.shade_smooth()

# ----------------------------------------------------------------------------
# 3. Helper: taper curve so tentacles are thick at base and thin at tip
# ----------------------------------------------------------------------------
def make_taper(name):
    curve = bpy.data.curves.new(name, type="CURVE")
    curve.dimensions = "2D"
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(1)
    # x goes 0..1 along the tentacle, y = bevel scale factor
    spline.bezier_points[0].co = (0.0, 1.0, 0.0)
    spline.bezier_points[1].co = (1.0, 0.12, 0.0)
    # smooth handles
    for bp in spline.bezier_points:
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    return obj

# ----------------------------------------------------------------------------
# 4. Tentacles: beveled bezier curves with noise-driven bends
# ----------------------------------------------------------------------------
NUM_TENTACLES = 8
POINTS_PER_TENTACLE = 14

taper_obj = make_taper("Taper")

for t in range(NUM_TENTACLES):
    angle = (2 * math.pi / NUM_TENTACLES) * t
    curve = bpy.data.curves.new(f"Tentacle_{t}", type="CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = 0.12
    curve.bevel_resolution = 6
    curve.taper_object = taper_obj
    curve.use_fill_caps = True

    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(POINTS_PER_TENTACLE - 1)

    for i in range(POINTS_PER_TENTACLE):
        frac = i / (POINTS_PER_TENTACLE - 1)
        # extend outward from body
        r = 1.0 + frac * 2.6
        x = math.cos(angle) * r
        y = math.sin(angle) * r
        # bend / droop with per-vertex noise
        z = math.sin(frac * 4.0 + angle * 2.0) * 0.35 - frac * 0.6
        # small sideways jitter
        x += math.sin(frac * 3.0 + angle) * 0.15
        y += math.cos(frac * 2.5 + angle) * 0.15

        bp = spline.bezier_points[i]
        bp.co = (x, y, z)
        bp.handle_left_type = "AUTO"
        bp.handle_right_type = "AUTO"

    obj = bpy.data.objects.new(f"Tentacle_{t}", curve)
    bpy.context.collection.objects.link(obj)

# ----------------------------------------------------------------------------
# 5. Convert all curves (tentacles) to meshes so OBJ export captures the bevel
# ----------------------------------------------------------------------------
bpy.ops.object.select_all(action="DESELECT")
for obj in list(bpy.data.objects):
    if obj.type == "CURVE" and obj.name.startswith("Tentacle"):
        obj.select_set(True)
bpy.context.view_layer.objects.active = [o for o in bpy.data.objects if o.type == "CURVE" and o.name.startswith("Tentacle")][0]
bpy.ops.object.convert(target="MESH")

# Remove helper taper curve object (geometry already baked into meshes)
if taper_obj.name in bpy.data.objects:
    bpy.data.objects.remove(taper_obj, do_unlink=True)

# Smooth shading on everything
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.shade_smooth()

# ----------------------------------------------------------------------------
# 6. Export as creature.obj
# ----------------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT")

# Blender 4.x/5.x exporter
try:
    bpy.ops.wm.obj_export(filepath=OUTPUT_PATH, export_selected_objects=False)
except AttributeError:
    # Fallback for older versions
    bpy.ops.export_scene.obj(filepath=OUTPUT_PATH, use_selection=False)

print("Exported:", OUTPUT_PATH)
print("Objects in scene:", [o.name for o in bpy.data.objects])
