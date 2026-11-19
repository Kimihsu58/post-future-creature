import bpy
import os
import math

# ----------------------------------------------------------------------------
# Output path: <project_root>/models/torso.obj
# ----------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MODELS_DIR = os.path.join(PROJECT_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)
OUTPUT_PATH = os.path.join(MODELS_DIR, "torso.obj")

# ----------------------------------------------------------------------------
# 1. Clean scene
# ----------------------------------------------------------------------------
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

created = []

# ----------------------------------------------------------------------------
# 2. Main torso cylinder (thin humanoid body)
# ----------------------------------------------------------------------------
bpy.ops.mesh.primitive_cylinder_add(radius=0.35, depth=1.4, vertices=16, location=(0, 0, 0))
torso = bpy.context.active_object
torso.name = "Torso"
created.append(torso)

# ----------------------------------------------------------------------------
# 3. Cable "muscles": several thin cylinders around the torso surface
# ----------------------------------------------------------------------------
cable_count = 6
cable_radius = 0.38
for i in range(cable_count):
    a = (2 * math.pi / cable_count) * i
    x = math.cos(a) * cable_radius
    z = math.sin(a) * cable_radius
    bpy.ops.mesh.primitive_cylinder_add(radius=0.03, depth=1.35, vertices=8, location=(x, 0, z))
    cable = bpy.context.active_object
    cable.name = f"Cable_{i}"
    created.append(cable)

# ----------------------------------------------------------------------------
# 4. Join all parts into one object
# ----------------------------------------------------------------------------
bpy.ops.object.select_all(action="DESELECT")
for obj in created:
    obj.select_set(True)
bpy.context.view_layer.objects.active = created[0]
bpy.ops.object.join()
torso = bpy.context.active_object
torso.name = "Torso"

bpy.ops.object.shade_smooth()

# ----------------------------------------------------------------------------
# 5. Export as .obj (origin at center)
# ----------------------------------------------------------------------------
bpy.ops.object.select_all(action="DESELECT")
torso.select_set(True)
bpy.context.view_layer.objects.active = torso

try:
    bpy.ops.wm.obj_export(filepath=OUTPUT_PATH, export_selected_objects=False)
except AttributeError:
    bpy.ops.export_scene.obj(filepath=OUTPUT_PATH, use_selection=True)

print("Exported:", OUTPUT_PATH)
print("Vertices:", len(torso.data.vertices), "Faces:", len(torso.data.polygons))
