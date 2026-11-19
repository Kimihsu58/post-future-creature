# ============================================================================
# 逆世界環境 — Blender 5.2 程序化建模腳本（石頭 / 枯樹 / 地面藤蔓）
# ----------------------------------------------------------------------------
# 用數學在 Blender 裡「長」出環境道具（取代舊版 JS 即時疊出來的低模）：
#   1. rocks    ×5 變體 — 細分 icosphere + 多倍頻柏林雜訊位移 + 崩缺削邊
#   2. trees    ×4 變體 — 根張樹幹（波瓣橫截面）+ 下垂枯枝 + 垂掛藤蔓
#   3. treesFar ×2 變體 — 遠景剪影樹（更少面數，霧裡只看輪廓）
#   4. vines    ×3 變體 — 蜿蜒地面藤蔓（疙瘩半徑起伏）
#
# 每個變體都建在「原點、單位尺寸」→ JS 端只做實例化（平移/縮放/旋轉），
# 位置、障礙半徑、陰影、風擺全部還是由 leviathan.js 決定（遊戲邏輯不動）。
#
# 執行方式（終端機，專案根目錄）：
#   blender --background --python blender/build_env.py
#
# 輸出：
#   models/env.obj   — OBJ 拓撲檔（Blender 真實建模證據）
#   data/env.js      — p5.js 直接讀取的變體頂點/三角面資料（window.ENV_MESHES）
# ============================================================================

import bpy
import json
import math
import os
import random
from mathutils import Vector, noise

# 固定亂數種子 → 每次重建都長一模一樣
random.seed(1977)

TAU = math.pi * 2

# ----------------------------------------------------------------------------
# 路徑：本腳本在 blender/ 資料夾裡，專案根目錄是它的上一層
# ----------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
OBJ_DIR = os.path.join(PROJECT_DIR, "models")
DATA_DIR = os.path.join(PROJECT_DIR, "data")
os.makedirs(OBJ_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

# 所有變體收集在這裡：{"rocks": [{"vertices": [Vector...], "faces": [(i,j,k,l)...]}]}
MESHES = {"rocks": [], "trees": [], "treesFar": [], "vines": []}


# ============================================================================
# 共用小工具
# ============================================================================

def icosphere(subdiv, radius=1.0):
    """手寫細分 icosphere（純幾何、不依賴 bpy.ops → 不會被 API 版本弄掛）

    subdiv 3 → 642 頂點 / 1280 三角面（比 UV 球均勻，位移後石形更自然）
    """
    t = (1.0 + 5.0 ** 0.5) / 2.0
    verts = [Vector(v).normalized() * radius for v in [
        (-1, t, 0), (1, t, 0), (-1, -t, 0), (1, -t, 0),
        (0, -1, t), (0, 1, t), (0, -1, -t), (0, 1, -t),
        (t, 0, -1), (t, 0, 1), (-t, 0, -1), (-t, 0, 1)]]
    faces = [(0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11),
             (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
             (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9),
             (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1)]
    for _ in range(subdiv):
        cache, nf = {}, []

        def midpoint(a, b):
            key = (a, b) if a < b else (b, a)
            if key not in cache:
                m = ((verts[a] + verts[b]) * 0.5).normalized() * radius
                verts.append(m)
                cache[key] = len(verts) - 1
            return cache[key]

        for (a, b, c) in faces:
            ab, bc, ca = midpoint(a, b), midpoint(b, c), midpoint(c, a)
            nf += [(a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)]
        faces = nf
    return verts, faces


def ring_tube(verts, faces, pts, radii, sides,
              lobe_n=0, lobe_amps=None, lobe_ph=0.0,
              cap_tip=True, cap_base=False):
    """沿路徑擠出圓管（平行傳輸框架 → 管子不會中途擰轉）

    pts / radii : 每一環的中心點與半徑
    sides       : 每環邊數（樹幹 8、樹枝 6、藤蔓 6…）
    lobe_n      : 橫截面波瓣數（0=圓管；6=樹根本張的稜）
    lobe_amps   : 每環的波瓣強度（None=不用波瓣）
    回傳各環的頂點索引列表
    """
    n = len(pts)
    # 每環的切線
    tans = []
    for i in range(n):
        a = pts[max(0, i - 1)]
        b = pts[min(n - 1, i + 1)]
        t = b - a
        tans.append(t.normalized() if t.length > 1e-6 else Vector((0, 0, 1)))
    # 初始副法線（挑一個不平行切線的參考方向）
    t0 = tans[0]
    ref = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    nrm = t0.cross(ref).normalized()
    rings = []
    for i in range(n):
        t = tans[i]
        nrm = nrm - t * nrm.dot(t)              # 每步重新正交化 ≈ 平行傳輸
        if nrm.length < 1e-5:
            ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
            nrm = t.cross(ref)
        nrm.normalize()
        binm = t.cross(nrm).normalized()
        amp = 0.0 if lobe_amps is None else lobe_amps[i]
        ring = []
        for k in range(sides):
            a = TAU * k / sides
            rr = radii[i]
            if lobe_n and amp:
                rr *= 1.0 + amp * math.cos(lobe_n * a + lobe_ph)
            offv = nrm * (math.cos(a) * rr) + binm * (math.sin(a) * rr)
            verts.append(pts[i] + offv)
            ring.append(len(verts) - 1)
        rings.append(ring)
    # 環與環之間的四邊形側面（匯出時切成三角形）
    for i in range(n - 1):
        A, B = rings[i], rings[i + 1]
        for k in range(sides):
            k2 = (k + 1) % sides
            faces.append((A[k], A[k2], B[k2], B[k]))
    # 端點補三角扇（樹梢/藤蔓尖要蓋住開口）
    if cap_tip:
        tip = pts[-1] + tans[-1] * (radii[-1] * 0.7)
        verts.append(tip)
        ti = len(verts) - 1
        R = rings[-1]
        for k in range(sides):
            k2 = (k + 1) % sides
            faces.append((R[k], R[k2], ti))
    if cap_base:
        base = pts[0] - tans[0] * (radii[0] * 0.7)
        verts.append(base)
        bi = len(verts) - 1
        R = rings[0]
        for k in range(sides):
            k2 = (k + 1) % sides
            faces.append((R[k2], R[k], bi))
    return rings


# ============================================================================
# 1. 石頭變體 ×5：icosphere 細分 3 → 多倍頻雜訊位移 → 壓扁收底 → 崩缺削邊
#    （單位半徑 ≈1、原點居中；JS 端乘 s / s*squash 擺進世界）
# ============================================================================

def build_rock(idx):
    verts, faces = icosphere(3, 1.0)
    off = Vector((idx * 13.7 + 3.1, idx * 7.3 + 9.4, idx * 5.1 + 1.7))

    # ① 多倍頻柏林位移：低頻=大塊面、中頻=碎裂、高頻=石皮顆粒
    for i, v in enumerate(verts):
        p = v * 1.8 + off
        d = (0.55 * noise.noise(p)
             + 0.30 * noise.noise(p * 2.3 + Vector((5.2, 1.3, 9.4)))
             + 0.15 * noise.noise(p * 4.7 + Vector((2.7, 8.1, 4.6))))
        verts[i] = v * (1.0 + 0.46 * d)

    # ② z 軸壓扁 + 底部收圓（埋進地裡那側要圓鈍，不能有尖角穿出地面）
    for i, v in enumerate(verts):
        z = v.z * 0.74
        if z < -0.08:
            t = min(1.0, (-0.08 - z) / 0.8)
            k = 1.0 - 0.5 * t * t
            verts[i] = Vector((v.x * k, v.y * k, z))
        else:
            verts[i] = Vector((v.x, v.y, z))

    # ③ 崩缺削邊：幾張隨機平面把外突的頂點「削」回去 → 平面崩缺（風化感）
    for _ in range(3):
        n = Vector((random.uniform(-1, 1), random.uniform(-1, 1),
                    random.uniform(-1, 1)))
        if n.length < 0.15:
            continue
        n.normalize()
        cut = random.uniform(0.86, 1.06)
        for i, v in enumerate(verts):
            dp = v.dot(n)
            if dp > cut:
                verts[i] = v - n * (dp - cut)

    MESHES["rocks"].append({"vertices": verts, "faces": faces})
    print("石頭變體 %d：%d 頂點" % (idx, len(verts)))


# ============================================================================
# 2. 枯樹變體（單位高 1、基座 z≈0）：根張樹幹 + 下垂枯枝 + 垂掛藤蔓
#    JS 端乘樹高 h、放到 gz-1.2 → 樹梢正好在 gz-1.2+h（風擺權重 0→1）
# ============================================================================

def build_tree(idx, far=False):
    verts, faces = [], []
    rnd = random.Random(4000 + idx + (100 if far else 0))
    N = 7 if far else 11                       # 樹幹環數（遠景少一點面）

    # ---- 樹幹路徑：微彎 + 側向飄（單位高）----
    lean_a = rnd.uniform(0, TAU)
    lean = rnd.uniform(0.05, 0.13) + (0.05 if far else 0)
    trunk_r = 0.062 if far else 0.055
    pts, radii, lobe_amps = [], [], []
    for i in range(N + 1):
        f = i / N
        x = math.cos(lean_a) * lean * f * f + math.sin(f * 5.3 + idx) * 0.016
        y = math.sin(lean_a) * lean * f * f + math.cos(f * 4.1 + idx) * 0.014
        z = -0.10 + 1.10 * f                    # 底部埋 0.10、樹梢 1.0
        pts.append(Vector((x, y, z)))
        r = trunk_r * (1.0 - 0.60 * f)
        if f < 0.18:                            # 根張：基部外擴（板根）
            r *= 1.0 + 2.4 * ((0.18 - f) / 0.18) ** 1.4
        radii.append(r)
        # 根張的 6 棱波瓣只長在最下面幾環，往上快速淡出
        lobe_amps.append(0.40 * max(0.0, (0.16 - f) / 0.16))
    ring_tube(verts, faces, pts, radii, 8 if not far else 5,
              lobe_n=6, lobe_amps=lobe_amps, lobe_ph=idx * 0.9,
              cap_tip=True, cap_base=True)

    # ---- 樹枝：向外上岔、末端下垂（枯枝尖勾）----
    nb = 5 if not far else 3
    hangs = []                                  # 掛點（垂掛藤蔓從這裡垂下）
    for _ in range(nb):
        bf = rnd.uniform(0.40, 0.90)
        i0 = min(N - 1, int(bf * N))
        start = pts[i0]
        r0 = radii[i0] * 0.50                   # 枝根 = 該處樹幹半徑的一半
        a = rnd.uniform(0, TAU)
        dx, dy = math.cos(a), math.sin(a)
        dz = rnd.uniform(0.55, 0.95)
        bl = rnd.uniform(0.17, 0.34) + (0.08 if far else 0)
        BN = 4 if not far else 3
        bpts, brads = [], []
        px, py, pz = start.x, start.y, start.z
        for i in range(BN + 1):
            bpts.append(Vector((px, py, pz)))
            brads.append(max(0.004, r0 * (1.0 - 0.78 * i / BN)))
            dl = math.hypot(dx, dy, dz) or 1.0
            px += dx / dl * bl / BN
            py += dy / dl * bl / BN
            pz += dz / dl * bl / BN
            dz -= 0.26                          # 越末端越下垂
            dx += rnd.uniform(-0.28, 0.28)
            dy += rnd.uniform(-0.28, 0.28)
        ring_tube(verts, faces, bpts, brads, 6 if not far else 4,
                  cap_tip=True, cap_base=False)
        hangs.append(bpts[max(1, BN // 2)])     # 枝中段 = 掛藤點

    # ---- 垂掛藤蔓（逆世界標誌）：從樹枝垂下、微彎扭、垂到地面附近 ----
    nv = rnd.randint(3, 6) if not far else 2
    for _ in range(nv):
        if not hangs:
            break
        start = hangs[rnd.randrange(len(hangs))]
        vl = rnd.uniform(0.30, 0.75)            # 長度（占樹高比例）
        vl = min(vl, max(0.12, start.z - 0.06))  # 不垂穿地裡
        VN = 6 if not far else 4
        vpts, vrads = [], []
        vx = start.x + rnd.uniform(-0.05, 0.05)
        vy = start.y + rnd.uniform(-0.05, 0.05)
        vz = start.z
        r0 = rnd.uniform(0.010, 0.017)
        for i in range(VN + 1):
            vpts.append(Vector((vx, vy, vz)))
            vrads.append(max(0.003, r0 * (1.0 - 0.72 * i / VN)))
            vz -= vl / VN                       # 一路往下垂
            vx += rnd.uniform(-0.045, 0.045)    # 微彎扭（不是直尺）
            vy += rnd.uniform(-0.045, 0.045)
        ring_tube(verts, faces, vpts, vrads, 4 if not far else 3,
                  cap_tip=True, cap_base=False)

    key = "treesFar" if far else "trees"
    MESHES[key].append({"vertices": verts, "faces": faces})
    print("%s 變體 %d：%d 頂點" % (key, idx, len(verts)))


# ============================================================================
# 3. 地面藤蔓變體 ×3（世界尺度）：蜿蜒路徑 + 疙瘩半徑起伏
#    中心線在局部 z=0 → JS 端逐頂點貼地（floorZ + 0.30）
# ============================================================================

def build_vine(idx):
    verts, faces = [], []
    rnd = random.Random(700 + idx)
    pts, radii = [], []
    x = y = 0.0
    a = rnd.uniform(-0.8, 0.8)                  # 大致朝 +x 出發
    for i in range(24):
        pts.append(Vector((x, y, 0.0)))
        f = i / 23.0
        r = 0.42 + (0.14 - 0.42) * f            # 根部粗、梢部細
        r *= 1.0 + 0.40 * math.sin(i * 1.9 + idx * 2.1)   # 疙瘩起伏
        radii.append(max(0.05, r))
        a += rnd.uniform(-0.45, 0.45)           # 漸進轉向 → 蜿蜒
        x += math.cos(a) * 1.35
        y += math.sin(a) * 1.35
        if math.hypot(x, y) > 24:               # 快出界就往回拐
            a += math.pi * 0.5
    ring_tube(verts, faces, pts, radii, 6, cap_tip=True, cap_base=False)
    MESHES["vines"].append({"vertices": verts, "faces": faces})
    print("藤蔓變體 %d：%d 頂點" % (idx, len(verts)))


# ============================================================================
# 輸出：OBJ（拓撲存檔）+ data/env.js（給 p5.js 直接讀取）
# ============================================================================

def tri_faces(flat_faces):
    """把四邊形面切成三角形（p5.js 只吃三角形）"""
    tris = []
    for f in flat_faces:
        if len(f) == 4:
            tris += [f[0], f[1], f[2], f[0], f[2], f[3]]
        else:
            tris += list(f)
    return tris


def export_all():
    # --- 先在 Blender 裡建出真正的 mesh 物件（OBJ 匯出證據） ---
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    groups = {}
    total_v = total_f = 0
    for gname, items in MESHES.items():
        out = []
        for vi, m in enumerate(items):
            name = "%s_%d" % (gname, vi)
            mesh = bpy.data.meshes.new(name)
            mesh.from_pydata([tuple(v) for v in m["vertices"]], [],
                             [list(f) for f in m["faces"]])
            mesh.validate()
            obj = bpy.data.objects.new(name, mesh)
            bpy.context.collection.objects.link(obj)
            # p5.js 資料（三角形化 + 頂點攤平）
            tris = tri_faces(m["faces"])
            flat = []
            for v in m["vertices"]:
                flat += [round(v.x, 4), round(v.y, 4), round(v.z, 4)]
            out.append({"vertices": flat, "faces": tris})
            total_v += len(m["vertices"])
            total_f += len(tris) // 3
        groups[gname] = out

    # --- ① 匯出 OBJ（全部三角形化） ---
    obj_path = os.path.join(OBJ_DIR, "env.obj")
    try:
        bpy.ops.wm.obj_export(filepath=obj_path, export_triangulated_mesh=True)
    except TypeError:
        bpy.ops.wm.obj_export(filepath=obj_path)   # 舊版參數不同就只給路徑
    print("OBJ 已匯出：%s" % obj_path)

    # --- ② 匯出 data/env.js（p5.js 用） ---
    payload = {
        "stats": {"vertices": total_v, "polygons": total_f},
        "blender": bpy.app.version_string,
        "groups": groups,
    }
    js_path = os.path.join(DATA_DIR, "env.js")
    with open(js_path, "w", encoding="utf-8") as fp:
        fp.write("// 由 blender/build_env.py 自動產生，請勿手改\n")
        fp.write("window.ENV_MESHES = ")
        json.dump(payload, fp, ensure_ascii=False, separators=(",", ":"))
        fp.write(";\n")
    print("JS 資料已匯出：%s" % js_path)
    print("=== 統計：變體頂點 %d ｜ 三角面 %d ===" % (total_v, total_f))


# ============================================================================
# 主流程
# ============================================================================

if __name__ == "__main__":
    print("=" * 60)
    print("逆世界環境建模開始（Blender %s）" % bpy.app.version_string)
    print("=" * 60)
    for i in range(5):
        build_rock(i)
    for i in range(4):
        build_tree(i, far=False)
    for i in range(2):
        build_tree(i, far=True)
    for i in range(3):
        build_vine(i)
    export_all()
    print("全部完成 ✅")
