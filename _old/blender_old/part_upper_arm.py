import bpy
import os
import math

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MODELS_DIR = os.path.join(PROJECT_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)
OUTPUT_PATH = os.path.join(MODELS_DIR, "upper_arm.obj")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

ARM_LEN = 1.2
ARM_R = 0.12

# Cylinder with its base at origin (pivot = shoulder)
bpy.ops.mesh.primitive_cylinder_add(radius=ARM_R, depth=ARM_LEN, vertices=12,
                                    location=(0, 0, ARM_LEN / 2.0))
upper = bpy.context.active_object
upper.name = "UpperArm"

# Small "joint cap" at the shoulder (sphere flattened)
bpy.ops.mesh.primitive_uv_sphere_add(radius=ARM_R * 1.2, location=(0, 0, 0))
cap = bpy.context.active_object
cap.name = "JointCap"
bpy.ops.object.select_all(action="DESELECT")
cap.select_set(True)
bpy.context.view_layer.objects.active = cap
bpy.ops.transform.resize(value=(1.0, 0.6, 1.0))

# Join into one part
bpy.ops.object.select_all(action="DESELECT")
for obj in [upper, cap]:
    obj.select_set(True)
bpy.context.view_layer.objects.active = upper
bpy.ops.object.join()
upper = bpy.context.active_object
upper.name = "UpperArm"

bpy.ops.object.shade_smooth()

bpy.ops.object.select_all(action="DESELECT")
upper.select_set(True)
bpy.context.view_layer.objects.active = upper

try:
    bpy.ops.wm.obj_export(filepath=OUTPUT_PATH, export_selected_objects=False)
except AttributeError:
    bpy.ops.export_scene.obj(filepath=OUTPUT_PATH, use_selection=True)

print("Exported:", OUTPUT_PATH)
print("Vertices:", len(upper.data.vertices), "Faces:", len(upper.data.polygons))
