# ============================================================================
# export_godot.py — 把網頁版傾印的幾何 JSON 轉成 Godot 用的 .glb
# ----------------------------------------------------------------------------
# 輸入：godot/import_src/{up,sea}.json（dump_geom.py 從執行中的頁面傾印）
#   每個部件 = {name, wpos[世界座標], faces, color[r,g,b], mat[0~6], world}
# 輸出：godot/assets/{up,sea}.glb（Blender 產 glTF 二進制 → Godot 直接匯入）
#
# 執行：
#   ~/.local/bin/blender --background --python export_godot.py -- 輸入.json 輸出.glb
# ============================================================================

import bpy
import bmesh
import json
import os
import sys

# 各材質的 PBR 預設（Godot 端之後會再換成自訂 shader，這裡給合理起點）
MAT_PBR = {
    0: (0.80, 0.00),   # 環境預設：粗糙、非金屬
    1: (0.90, 0.00),   # 岩石
    2: (0.95, 0.00),   # 樹皮
    3: (1.00, 0.00),   # 泥土
    4: (0.70, 0.00),   # 藤蔓
    5: (0.35, 0.00),   # 皮膚（濕潤 → 低粗糙）
    6: (0.45, 0.10),   # 甲殼（微金屬感光澤）
}

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) != 2:
    print("用法: blender --background --python export_godot.py -- in.json out.glb")
    sys.exit(1)
SRC, DST = os.path.abspath(argv[0]), os.path.abspath(argv[1])

with open(SRC) as f:
    data = json.load(f)

# 清空預設場景（headless 乾淨起點）
bpy.ops.wm.read_factory_settings(use_empty=True)

made_mats = {}
for p in data["parts"]:
    wpos, faces = p["wpos"], p["faces"]
    verts = [tuple(wpos[i:i + 3]) for i in range(0, len(wpos), 3)]
    tris = [tuple(faces[i:i + 3]) for i in range(0, len(faces), 3)]
    if not verts or not tris:
        continue

    mesh = bpy.data.meshes.new(p["name"])
    mesh.from_pydata(verts, [], tris)
    mesh.validate()

    # 重算法線（朝外一致）——傾印資料只有座標/索引
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    obj = bpy.data.objects.new(p["name"], mesh)
    bpy.context.scene.collection.objects.link(obj)

    # 材質：顏色 + 粗糙度依 mat 類型（名稱 = mat編號_色號 → 同 mat 不同色各自獨立）
    r, g, b = [int(c) for c in p["color"]]
    mkey = f"m{p['mat']}_{r}_{g}_{b}"
    if mkey not in made_mats:
        m = bpy.data.materials.new(mkey)
        m.use_nodes = True
        bsdf = m.node_tree.nodes["Principled BSDF"]
        bsdf.inputs["Base Color"].default_value = (r / 255.0, g / 255.0, b / 255.0, 1.0)
        rough, metal = MAT_PBR.get(p["mat"], (0.8, 0.0))
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        made_mats[mkey] = m
    obj.data.materials.append(made_mats[mkey])

os.makedirs(os.path.dirname(DST), exist_ok=True)
bpy.ops.export_scene.gltf(filepath=DST, export_format="GLB", export_apply=True)
print(f"EXPORTED {len(data['parts'])} parts → {DST} ({os.path.getsize(DST)//1024} KB)")
