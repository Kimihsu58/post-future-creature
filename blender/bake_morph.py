# ============================================================================
# bake_morph.py — 把七階段身體傾印烘成「形變目標（morph targets）」匯進 up.glb
# ----------------------------------------------------------------------------
# 輸入：godot/import_src/morph/full6.json（完整場景，basis=stage6+世界+walkers）
#        godot/import_src/morph/stage_0..5.json（身體七階段，只當 shape key）
# 輸出：godot/assets/up.glb（世界/walker 靜態；身體部件帶 6 個 shape key）
#
# morph 設計（basis = stage6 → 預設全 0 權重 = 現況人形不變）：
#   顯示 stage t（0~6）：k=floor(t), f=t-k → w[k]=1-f, w[k+1]=f（k+1≤5）
#   t=6 → 全 0 = basis；t=0 → w[0]=1。相鄰兩 key 交叉淡入＝精確線性內插。
#
# 執行：
#   ~/.local/bin/blender --background --python bake_morph.py -- morph_dir 輸出.glb
# ============================================================================

import bpy
import bmesh
import json
import os
import sys

# 各材質 PBR 預設（同 export_godot.py —— Godot 端之後換自訂 shader）
MAT_PBR = {
    0: (0.80, 0.00),   # 環境預設
    1: (0.90, 0.00),   # 岩石
    2: (0.95, 0.00),   # 樹皮
    3: (1.00, 0.00),   # 泥土
    4: (0.70, 0.00),   # 藤蔓
    5: (0.35, 0.00),   # 皮膚
    6: (0.45, 0.10),   # 甲殼
}

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
if len(argv) != 2:
    print("用法: blender --background --python bake_morph.py -- morph_dir 輸出.glb")
    sys.exit(1)
MORPH_DIR, DST = os.path.abspath(argv[0]), os.path.abspath(argv[1])
N_WALK = 12

with open(os.path.join(MORPH_DIR, "full6.json")) as f:
    full6 = json.load(f)
stages = []                       # stage_0..5（evo shape key 來源）
for n in range(6):
    with open(os.path.join(MORPH_DIR, f"stage_{n}.json")) as f:
        stages.append({p["name"]: p for p in json.load(f)["parts"]})
walks = []                        # walk_0..11（走路 shape key 來源，basis=stage6）
for n in range(N_WALK):
    with open(os.path.join(MORPH_DIR, f"walk_{n}.json")) as f:
        walks.append({p["name"]: p for p in json.load(f)["parts"]})
body_names = set(stages[0].keys())
print(f"full6: {len(full6['parts'])} parts; body parts with morph: {len(body_names)} (6 evo + {N_WALK} walk keys)")

# 清空預設場景（headless 乾淨起點）
bpy.ops.wm.read_factory_settings(use_empty=True)

made_mats = {}
n_morph = 0
for p in full6["parts"]:
    wpos, faces = p["wpos"], p["faces"]
    verts = [tuple(wpos[i:i + 3]) for i in range(0, len(wpos), 3)]
    tris = [tuple(faces[i:i + 3]) for i in range(0, len(faces), 3)]
    if not verts or not tris:
        continue

    # ---- 拓樸雙保險：有 morph 的部件，evo 六階段＋走路 12 相位 faces/頂點數必須全同 ----
    if p["name"] in body_names:
        for si, sd in enumerate(stages):
            sp = sd[p["name"]]
            if sp["faces"] != faces:
                print(f"FAIL {p['name']}: stage_{si} faces mismatch"); sys.exit(1)
            if len(sp["wpos"]) != len(wpos):
                print(f"FAIL {p['name']}: stage_{si} vert count mismatch"); sys.exit(1)
            if any(v is None or v != v for v in sp["wpos"]):
                print(f"FAIL {p['name']}: stage_{si} has NaN/null"); sys.exit(1)
        for wi, wd in enumerate(walks):
            sp = wd[p["name"]]
            if sp["faces"] != faces:
                print(f"FAIL {p['name']}: walk_{wi} faces mismatch"); sys.exit(1)
            if len(sp["wpos"]) != len(wpos):
                print(f"FAIL {p['name']}: walk_{wi} vert count mismatch"); sys.exit(1)
            if any(v is None or v != v for v in sp["wpos"]):
                print(f"FAIL {p['name']}: walk_{wi} has NaN/null"); sys.exit(1)

    mesh = bpy.data.meshes.new(p["name"])
    mesh.from_pydata(verts, [], tris)
    mesh.validate()

    # 重算法線（傾印只有座標/索引）—— 只作用在 basis；shape key 只存頂點位置
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()

    # ---- shape keys：Basis = stage6（full6 本體），key_i = stage_i 絕對位置 ----
    #   Blender 存絕對座標，glTF 匯出時自動轉成相對 basis 的 delta
    #   （API：shape key 掛在 Object 上 → 必須先建 obj 才能加）

    obj = bpy.data.objects.new(p["name"], mesh)
    bpy.context.scene.collection.objects.link(obj)

    if p["name"] in body_names:
        # basis 對齊驗證：bmesh 重算法線可能動到頂點序 → 全數比對 mesh 頂點 vs JSON
        for i, v in enumerate(verts):
            co = mesh.vertices[i].co
            if abs(co[0] - v[0]) > 1e-4 or abs(co[1] - v[1]) > 1e-4 or abs(co[2] - v[2]) > 1e-4:
                print(f"FAIL {p['name']}: basis vert {i} misaligned {tuple(co)} != {v}")
                sys.exit(1)
        obj.shape_key_add(name="Basis", from_mix=False)
        for si in range(6):
            key = obj.shape_key_add(name=f"stage{si}", from_mix=False)
            kw = stages[si][p["name"]]["wpos"]
            data = key.data
            for i in range(len(verts)):
                j = i * 3
                data[i].co = (kw[j], kw[j + 1], kw[j + 2])
        # 走路 12 相位（同 basis=stage6 的 delta；權重交叉淡入時 basis 項會消掉 → 精確內插）
        for wi in range(N_WALK):
            key = obj.shape_key_add(name=f"walk{wi}", from_mix=False)
            kw = walks[wi][p["name"]]["wpos"]
            data = key.data
            for i in range(len(verts)):
                j = i * 3
                data[i].co = (kw[j], kw[j + 1], kw[j + 2])
        n_morph += 1

    # 材質：名稱 = mat編號_色號 → 同 mat 不同色各自獨立（同 export_godot.py）
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
# export_morph 預設 True：shape keys → glTF morph targets（POSITION deltas）
bpy.ops.export_scene.gltf(filepath=DST, export_format="GLB", export_apply=True,
                          export_morph=True)

# ---- 匯出後驗證：GLB 裡真的有 morph targets（靜默失敗防線） ----
import struct
with open(DST, "rb") as f:
    magic, ver, _ = struct.unpack("<4sII", f.read(12))
    assert magic == b"glTF", "not a GLB file"
    clen, ctype = struct.unpack("<II", f.read(8))
    assert ctype == 0x4E4F534A, "no JSON chunk"
    gltf = json.loads(f.read(clen))
n_morph_glb = sum(1 for m in gltf.get("meshes", [])
                  for pr in m.get("primitives", []) if pr.get("targets"))
n_targets = sum(len(pr.get("targets", [])) for m in gltf.get("meshes", []) for pr in m.get("primitives", []))
exp_targets = (6 + N_WALK)          # 6 evo + 12 walk
print(f"GLB verify: {n_morph_glb} meshes with targets, {n_targets} total morph targets (expect {exp_targets}/mesh)")
if n_morph_glb != n_morph or n_targets != n_morph * exp_targets:
    print(f"FAIL: expected {n_morph} meshes / {n_morph * exp_targets} targets"); sys.exit(1)

print(f"EXPORTED {len(full6['parts'])} parts ({n_morph} with morph) → {DST} ({os.path.getsize(DST)//1024} KB)")
