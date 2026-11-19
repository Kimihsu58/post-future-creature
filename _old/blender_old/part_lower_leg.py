import bpy
import os

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MODELS_DIR = os.path.join(PROJECT_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)
OUTPUT_PATH = os.path.join(MODELS_DIR, "lower_leg.obj")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

LEG_LEN = 1.1
LEG_R = 0.10

bpy.ops.mesh.primitive_cylinder_add(radius=LEG_R, depth=LEG_LEN, vertices=12,
                                    location=(0, 0, LEG_LEN / 2.0))
lower = bpy.context.active_object
lower.name = "LowerLeg"

bpy.ops.mesh.primitive_uv_sphere_add(radius=LEG_R * 1.15, location=(0, 0, 0))
cap = bpy.context.active_object
bpy.ops.object.select_all(action="DESELECT")
cap.select_set(True)
bpy.context.view_layer.objects.active = cap
bpy.ops.transform.resize(value=(1.0, 0.5, 1.0))

bpy.ops.object.select_all(action="DESELECT")
for obj in [lower, cap]:
    obj.select_set(True)
bpy.context.view_layer.objects.active = lower
bpy.ops.object.join()
lower = bpy.context.active_object
lower.name = "LowerLeg"

bpy.ops.object.shade_smooth()

bpy.ops.object.select_all(action="DESELECT")
lower.select_set(True)
bpy.context.view_layer.objects.active = lower

try:
    bpy.ops.wm.obj_export(filepath=OUTPUT_PATH, export_selected_objects=False)
except AttributeError:
    bpy.ops.export_scene.obj(filepath=OUTPUT_PATH, use_selection=True)

print("Exported:", OUTPUT_PATH)
print("Vertices:", len(lower.data.vertices), "Faces:", len(lower.data.polygons))
