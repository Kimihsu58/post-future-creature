import bpy
import bmesh
import os
import math

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
MODELS_DIR = os.path.join(PROJECT_DIR, "models")
os.makedirs(MODELS_DIR, exist_ok=True)
OUTPUT_PATH = os.path.join(MODELS_DIR, "petal.obj")

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete(use_global=False)

mesh = bpy.data.meshes.new("Petal")
petal_obj = bpy.data.objects.new("Petal", mesh)
bpy.context.collection.objects.link(petal_obj)
bpy.context.view_layer.objects.active = petal_obj
petal_obj.select_set(True)

bm = bmesh.new()

# Petal extends along +Z (forward/up). Base at origin.
L = 1.0
BASE_W = 0.5
TIP_W = 0.05
ROWS = 13
COLS = 7

verts_grid = []
for j in range(ROWS):
    t = j / (ROWS - 1)
    z = t * L
    w = (BASE_W * (1 - t) + TIP_W * t)
    row = []
    for i in range(COLS):
        x = -w / 2.0 + (w / (COLS - 1)) * i
        v = bm.verts.new((x, 0.0, z))
        row.append(v)
    verts_grid.append(row)

for j in range(ROWS - 1):
    for i in range(COLS - 1):
        v1 = verts_grid[j][i]
        v2 = verts_grid[j][i + 1]
        v3 = verts_grid[j + 1][i + 1]
        v4 = verts_grid[j + 1][i]
        bm.faces.new((v1, v2, v3, v4))

def add_box(bm, cx, cy, cz, sx, sy, sz):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    idx = []
    corners = [
        (-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
        (-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1),
    ]
    for sxn, syn, szn in corners:
        idx.append(bm.verts.new((cx + sxn * hx, cy + syn * hy, cz + szn * hz)))
    bm.faces.new((idx[0], idx[1], idx[2], idx[3]))
    bm.faces.new((idx[4], idx[5], idx[6], idx[7]))
    bm.faces.new((idx[0], idx[1], idx[5], idx[4]))
    bm.faces.new((idx[2], idx[3], idx[7], idx[6]))
    bm.faces.new((idx[0], idx[3], idx[7], idx[4]))
    bm.faces.new((idx[1], idx[2], idx[6], idx[5]))

for i in range(7):
    x = -0.22 + 0.44 * (i / 6)
    add_box(bm, x, 0.02, 0.08, 0.02, 0.04, 0.05)

bm.to_mesh(mesh)
bm.free()
bpy.ops.object.shade_smooth()

bpy.ops.object.select_all(action="DESELECT")
petal_obj.select_set(True)
bpy.context.view_layer.objects.active = petal_obj

try:
    bpy.ops.wm.obj_export(filepath=OUTPUT_PATH, export_selected_objects=False)
except AttributeError:
    bpy.ops.export_scene.obj(filepath=OUTPUT_PATH, use_selection=True)

print("Exported:", OUTPUT_PATH)
print("Vertices:", len(mesh.vertices), "Faces:", len(mesh.polygons))
