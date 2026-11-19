import bpy
import os
import math

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MODELS_DIR = os.path.join(PROJECT_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)
OUTPUT_PATH = os.path.join(MODELS_DIR, "claw.obj")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

parts = []

# Palm base
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.06, 0))
palm = bpy.context.active_object
palm.scale = (0.22, 0.08, 0.18)
bpy.ops.object.transform_apply(scale=True)
parts.append(palm)

# Broken claw spikes (a few fingers, different lengths)
spikes = [
    (0.09, 0.22, 0.06, 0.03, 0.25, 0.03),
    (0.00, 0.20, -0.05, 0.03, 0.22, 0.03),
    (-0.09, 0.18, 0.05, 0.03, 0.20, 0.03),
    (0.05, 0.16, -0.02, 0.02, 0.15, 0.02),  # broken short one
]
for (x, y, z, sx, sy, sz) in spikes:
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, y, z))
    sp = bpy.context.active_object
    sp.scale = (sx, sy, sz)
    bpy.ops.object.transform_apply(scale=True)
    # slight tilt for "broken" look
    sp.rotation_euler = (math.radians(8), 0, math.radians(12))
    bpy.ops.object.transform_apply(rotation=True)
    parts.append(sp)

# Join into one claw part
bpy.ops.object.select_all(action="DESELECT")
for p in parts:
    p.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
claw = bpy.context.active_object
claw.name = "Claw"

bpy.ops.object.shade_smooth()

bpy.ops.object.select_all(action="DESELECT")
claw.select_set(True)
bpy.context.view_layer.objects.active = claw

try:
    bpy.ops.wm.obj_export(filepath=OUTPUT_PATH, export_selected_objects=False)
except AttributeError:
    bpy.ops.export_scene.obj(filepath=OUTPUT_PATH, use_selection=True)

print("Exported:", OUTPUT_PATH)
print("Vertices:", len(claw.data.vertices), "Faces:", len(claw.data.polygons))
