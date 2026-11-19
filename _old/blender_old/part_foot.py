import bpy
import os
import math

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MODELS_DIR = os.path.join(PROJECT_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)
OUTPUT_PATH = os.path.join(MODELS_DIR, "foot.obj")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

parts = []

# Foot base (palm of foot), origin at ankle
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -0.12, 0.15))
foot = bpy.context.active_object
foot.scale = (0.2, 0.08, 0.35)
bpy.ops.object.transform_apply(scale=True)
parts.append(foot)

# Clawed toes
for i, x in enumerate([-0.1, 0.0, 0.1]):
    bpy.ops.mesh.primitive_cone_add(radius1=0.03, radius2=0.0, depth=0.2,
                                    location=(x, -0.25, 0.35))
    toe = bpy.context.active_object
    toe.rotation_euler = (math.radians(-70), 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    parts.append(toe)

bpy.ops.object.select_all(action="DESELECT")
for p in parts:
    p.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
foot = bpy.context.active_object
foot.name = "Foot"

bpy.ops.object.shade_smooth()

bpy.ops.object.select_all(action="DESELECT")
foot.select_set(True)
bpy.context.view_layer.objects.active = foot

try:
    bpy.ops.wm.obj_export(filepath=OUTPUT_PATH, export_selected_objects=False)
except AttributeError:
    bpy.ops.export_scene.obj(filepath=OUTPUT_PATH, use_selection=True)

print("Exported:", OUTPUT_PATH)
print("Vertices:", len(foot.data.vertices), "Faces:", len(foot.data.polygons))
