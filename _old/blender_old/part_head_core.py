import bpy
import os
import math

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MODELS_DIR = os.path.join(PROJECT_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)
OUTPUT_PATH = os.path.join(MODELS_DIR, "head_core.obj")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

parts = []

# Central glowing core (slightly flattened sphere)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.45, segments=16, ring_count=8, location=(0, 0, 0))
core = bpy.context.active_object
core.scale = (1.0, 0.85, 1.0)
bpy.ops.object.transform_apply(scale=True)
parts.append(core)

# Outer ring where petals attach
bpy.ops.mesh.primitive_torus_add(major_radius=0.5, minor_radius=0.05, location=(0, 0, 0))
ring = bpy.context.active_object
parts.append(ring)

# Inner pin ring (chip "teeth") as small spikes
for i in range(24):
    a = (2 * math.pi / 24) * i
    bpy.ops.mesh.primitive_cone_add(radius1=0.02, radius2=0.0, depth=0.1,
                                    location=(math.cos(a) * 0.32, 0, math.sin(a) * 0.32))
    pin = bpy.context.active_object
    pin.rotation_euler = (math.radians(-90), 0, a)
    bpy.ops.object.transform_apply(rotation=True)
    parts.append(pin)

bpy.ops.object.select_all(action="DESELECT")
for p in parts:
    p.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
core = bpy.context.active_object
core.name = "HeadCore"

bpy.ops.object.shade_smooth()

bpy.ops.object.select_all(action="DESELECT")
core.select_set(True)
bpy.context.view_layer.objects.active = core

try:
    bpy.ops.wm.obj_export(filepath=OUTPUT_PATH, export_selected_objects=False)
except AttributeError:
    bpy.ops.export_scene.obj(filepath=OUTPUT_PATH, use_selection=True)

print("Exported:", OUTPUT_PATH)
print("Vertices:", len(core.data.vertices), "Faces:", len(core.data.polygons))
