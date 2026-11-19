# ============================================================================
# 深海圖靈利維坦 — Blender 5.2 程序化建模腳本
# ----------------------------------------------------------------------------
# 用數學在 Blender 裡「長」出一隻深海生物，包含 5 大部件：
#   1. 軀幹 torso    — 變形 UV 球 → 蝠翼流線體（利維坦主體）
#   2. 腹膜 belly    — 網格膜（Voronoi 蠕動交給 p5.js 即時計算）
#   3. 角冠 horns    — 3D DLA（擴散限制聚集）珊瑚晶簇，依年齡分根/中/梢三段
#   4. 羽鬚 antenna  — 3D 突變 L-System 蕨狀感應鬚 ×2（帶隨機「突變」角度）
#   5. 複眼 eyes     — 頭部兩側的小球群（電光青感光體）
#
# 執行方式（終端機）：
#   /Applications/Blender.app/Contents/MacOS/Blender --background --python build_leviathan.py
#
# 輸出：
#   models/leviathan.obj   — OBJ 拓撲檔（Blender 真實建模證據）
#   data/leviathan.js      — p5.js 直接讀取的頂點/三角面資料
# ============================================================================

import bpy
import bmesh
import json
import math
import os
import random
from mathutils import Vector, Quaternion

# 固定亂數種子 → 每次重建都長一模一樣（DLA 的「突變」可重現）
random.seed(42)

# ----------------------------------------------------------------------------
# 路徑：本腳本在 blender/ 資料夾裡，專案根目錄是它的上一層
# ----------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
OBJ_DIR = os.path.join(PROJECT_DIR, "models")
DATA_DIR = os.path.join(PROJECT_DIR, "data")
os.makedirs(OBJ_DIR, exist_ok=True)
os.makedirs(DATA_DIR, exist_ok=True)

TAU = math.pi * 2

# 所有部件收集在這裡：{"name": ..., "verts": [Vector...], "faces": [[i,j,k]...]}
PARTS = {}


# ============================================================================
# 共用小工具
# ============================================================================

def new_part(name):
    """開一個新的部件容器"""
    PARTS[name] = {"verts": [], "faces": []}
    return PARTS[name]


def add_vert(part, co):
    part["verts"].append(co)
    return len(part["verts"]) - 1


def add_quad(part, a, b, c, d):
    part["faces"].append([a, b, c, d])


def add_tri(part, a, b, c):
    part["faces"].append([a, b, c])


def rand_unit():
    """球面上的隨機單位向量（DLA 游離粒子用）"""
    while True:
        v = Vector((random.uniform(-1, 1), random.uniform(-1, 1),
                    random.uniform(-1, 1)))
        if 0.05 < v.length <= 1.0:
            return v.normalized()


def add_tube(part, a, b, r0, r1, cap_tip=True, cap_base=False):
    """在 a→b 之間長一根四稜錐台管（DLA 枝條與羽鬚的骨架）

    a, b   : 兩端點座標
    r0, r1 : 起點/終點半徑（會自然變細）
    回傳 (起點環索引列表, 終點環索引列表)
    """
    axis = b - a
    if axis.length < 1e-6:
        return None
    f = axis.normalized()
    # 造一個垂直於 f 的座標基（任選一個不平行的參考方向）
    ref = Vector((0, 0, 1)) if abs(f.z) < 0.9 else Vector((1, 0, 0))
    u = f.cross(ref).normalized()
    v = f.cross(u).normalized()

    ring0, ring1 = [], []
    for k in range(4):
        ang = TAU * k / 4 + TAU / 8   # 旋轉 45° 讓方管比較像圓管
        offset = u * math.cos(ang) + v * math.sin(ang)
        ring0.append(add_vert(part, a + offset * r0))
        ring1.append(add_vert(part, b + offset * r1))

    # 四個側面
    for k in range(4):
        k2 = (k + 1) % 4
        add_quad(part, ring0[k], ring0[k2], ring1[k2], ring1[k])

    # 端點補三角扇蓋住開口
    if cap_tip:
        tip = add_vert(part, b + f * r1 * 0.5)
        for k in range(4):
            k2 = (k + 1) % 4
            add_tri(part, ring1[k], ring1[k2], tip)
    if cap_base:
        base = add_vert(part, a - f * r0 * 0.5)
        for k in range(4):
            k2 = (k + 1) % 4
            add_tri(part, ring0[k2], ring0[k], base)
    return ring0, ring1


def add_sphere(part, center, radius, nu=6, nv=4):
    """小球（複眼用）：手動 UV 球，含上下極點"""
    def deform(sx, sy, sz):
        return center + Vector((sx, sy, sz)) * radius

    top = add_vert(part, deform(0, 0, 1))
    bot = add_vert(part, deform(0, 0, -1))
    rows = []
    for i in range(1, nv):
        phi = math.pi * i / nv
        row = []
        for j in range(nu):
            th = TAU * j / nu
            row.append(add_vert(part, deform(
                math.sin(phi) * math.cos(th),
                math.sin(phi) * math.sin(th),
                math.cos(phi))))
        rows.append(row)
    # 極點扇形
    for k in range(nu):
        add_tri(part, top, rows[0][k], rows[0][(k + 1) % nu])
        add_tri(part, bot, rows[-1][(k + 1) % nu], rows[-1][k])
    # 中間帶
    for i in range(len(rows) - 1):
        for k in range(nu):
            k2 = (k + 1) % nu
            add_quad(part, rows[i][k], rows[i + 1][k],
                     rows[i + 1][k2], rows[i][k2])


# ============================================================================
# 1. 軀幹：變形 UV 球 → 蝠翼利維坦流線體
#    座標約定：+Y = 頭（波動向 -Y 傳遞）、+Z = 上、X = 左右
# ============================================================================

def build_torso():
    part = new_part("torso")
    NU, NV = 36, 18          # 經度 / 緯度分段

    def deform(sx, sy, sz):
        # --- ① 拉長為身體（Y 軸） ---
        x, y, z = sx, sy * 2.3, sz * 0.62

        # --- ② 中段展開蝠翼（翼梢 lobes）；翼梢同時變薄（不然像一頂帽子） ---
        wing = math.exp(-((sy - 0.05) / 0.60) ** 2)
        x *= (1.0 + 1.45 * wing) * (1.0 - 0.12 * abs(sz))
        z *= (1.0 - 0.45 * wing)

        # --- ③ 尾部收細、向後延伸（細長蛇尾 → 波動更好看） ---
        if sy < -0.30:
            t = min(1.0, (-sy - 0.30) / 0.70)
            x *= 1.0 - 0.92 * t * t
            z *= 1.0 - 0.75 * t
            y -= 1.70 * t * t          # 尾巴再往後拉長

        # --- ④ 腹面壓平 ---
        if z < 0:
            z *= 0.70

        # --- ⑤ 頭部收窄成圓鈍吻部（頭/翼/尾輪廓才分得出來） ---
        if sy > 0.55:
            t = (sy - 0.55) / 0.45
            x *= 1.0 - 0.50 * t * t
            z += 0.05 * t
        return Vector((x, y, z))

    top = add_vert(part, deform(0, 0, 1))
    bot = add_vert(part, deform(0, 0, -1))
    rows = []
    for i in range(1, NV):
        phi = math.pi * i / NV
        row = []
        for j in range(NU):
            th = TAU * j / NU
            row.append(add_vert(part, deform(
                math.sin(phi) * math.cos(th),
                math.sin(phi) * math.sin(th),
                math.cos(phi))))
        rows.append(row)
    for k in range(NU):
        k2 = (k + 1) % NU
        add_tri(part, top, rows[0][k], rows[0][k2])
        add_tri(part, bot, rows[-1][k2], rows[-1][k])
    for i in range(len(rows) - 1):
        for k in range(NU):
            k2 = (k + 1) % NU
            add_quad(part, rows[i][k], rows[i + 1][k],
                     rows[i + 1][k2], rows[i][k2])
    print("軀幹完成：%d 頂點" % len(part["verts"]))


# ============================================================================
# 2. 腹膜：身體下方的網格膜（Voronoi 蠕動在 p5.js 端做，這裡只給拓撲）
# ============================================================================

def build_belly():
    part = new_part("belly")
    NU, NV = 22, 12          # 網格密度（太密浪費、太疏蠕動不順）
    grid = []
    for i in range(NV + 1):
        v = -1.0 + 2.0 * i / NV        # 前後 -1→1
        row = []
        for j in range(NU + 1):
            u = -1.0 + 2.0 * j / NU    # 左右 -1→1
            x = u * 1.45 * (1.0 - 0.22 * v * v)   # 兩端收窄成橢圓
            y = v * 1.80
            # 中央微微下垂的穹頂（cos 峰在正中央）
            z = -0.30 - 0.095 * math.cos(u * math.pi / 2) \
                         * math.cos(v * math.pi / 2)
            row.append(add_vert(part, Vector((x, y, z))))
        grid.append(row)
    for i in range(NV):
        for j in range(NU):
            add_quad(part, grid[i][j], grid[i][j + 1],
                     grid[i + 1][j + 1], grid[i + 1][j])
    print("腹膜完成：%d 頂點" % len(part["verts"]))


# ============================================================================
# 3. 角冠：3D DLA 珊瑚晶簇（依年齡分根/中/梢三段，做曜石紫→珊瑚粉紅漸層）
# ============================================================================

def build_dla_horns():
    root = Vector((0, 1.30, 0.42))     # 角冠生長的根部（頭頂，微埋進皮膚）
    N = 150                            # 目標枝條數
    step = 0.05                        # 游走步長
    stick = 0.12                       # 黏住距離（比步長大 → 才黏得住）
    pts = [root.copy()]
    edges = []                         # (父索引, 子索引)
    fails = 0
    while len(edges) < N and fails < N * 16:
        # 叢集越大、出生殼越外圍：貼著現有最大半徑外 0.3
        shell = max((root - q).length for q in pts) + 0.30
        p = root + rand_unit() * shell
        p.z = max(p.z, root.z)         # 粒子只在上半球出生
        for _ in range(2500):
            p += rand_unit() * step
            p.z += 0.011               # 上升洋流偏置 → 向上長成晶冠
            p.y -= 0.005               # 微微往後倒（像被洋流壓）
            # 找最近的已附著點
            j = min(range(len(pts)), key=lambda k: (pts[k] - p).length_squared)
            if (pts[j] - p).length <= stick:          # 黏住！
                edges.append((j, len(pts)))
                pts.append(p.copy())
                break
            if (p - root).length > shell * 1.5:       # 飛太遠 → 放棄重來
                fails += 1
                break
            if p.z < root.z - 0.08:                   # 沉進身體 → 放棄
                fails += 1
                break

    # 依「離根部距離」當年齡 → 分三段著色
    maxd = max((pts[0] - pts[i]).length for i in range(1, len(pts)))
    segs = {"horn_base": [], "horn_mid": [], "horn_tip": []}
    for (pa, pb) in edges:
        age = (pts[pb] - root).length / maxd         # 0=根部(老) 1=梢(新)
        key = "horn_base" if age < 0.55 else ("horn_mid" if age < 0.78 else "horn_tip")
        segs[key].append((pts[pa], pts[pb], age))

    for key, group in segs.items():
        part = new_part(key)
        for (a, b, age) in group:
            r0 = 0.068 * (1.0 - 0.5 * age)           # 越新越細
            r1 = 0.068 * (1.0 - 0.5 * min(1.0, age + 0.18))
            add_tube(part, a, b, r0, r1, cap_tip=True, cap_base=False)
        print("%s 完成：%d 頂點" % (key, len(part["verts"])))
    print("DLA 晶簇：枝條 %d，游走失敗 %d 次" % (len(edges), fails))


# ============================================================================
# 4. 羽鬚：3D 突變 L-System 蕨狀感應鬚 ×2
#    字串文法：
#      axiom = "A"
#      A → "F[+B]A"     主莖長一段、左側出分枝、繼續長
#      B → "F[-A]B"     對稱的另一半（左右交替）
#    「突變」：每個轉向指令的角度都加一點隨機擾動 → 每根都長得不一樣
# ============================================================================

def lsystem(axiom, rules, gens):
    s = axiom
    for _ in range(gens):
        s = "".join(rules.get(c, c) for c in s)
    return s


def build_antennae():
    part = new_part("antenna")
    axiom = "A"
    rules = {"A": "F[+B]A", "B": "F[-A]B"}
    prog = lsystem(axiom, rules, gens=6)
    print("L-System 蕨類指令長度：%d（F 數 = %d）" % (len(prog), prog.count("F")))

    fronds = [
        (Vector(( 0.38, 1.66, 0.40)), Vector(( 0.10, -0.08, 1.0))),  # 右鬚
        (Vector((-0.38, 1.66, 0.40)), Vector((-0.10, -0.08, 1.0))),  # 左鬚
    ]
    base_ang = math.radians(18.0)

    for (start, heading) in fronds:
        pos = start.copy()
        f = heading.normalized()               # 前進方向
        up = Vector((0, 0, 1))
        lft = f.cross(up).normalized()         # 左方
        up = lft.cross(f).normalized()         # 重新正交化
        stack = []
        seg_len = 0.125
        radius = 0.032
        for c in prog:
            if c == "F":
                new = pos + f * seg_len
                add_tube(part, pos, new, radius, radius * 0.78,
                         cap_tip=True, cap_base=False)
                pos, radius = new, radius * 0.955
            elif c in "+-&^|":
                # 突變角度 = 基準角 + 隨機擾動
                ang = base_ang + random.uniform(-0.22, 0.22)
                if c == "+":
                    axis = up
                elif c == "-":
                    axis = up; ang = -ang
                elif c == "&":
                    axis = lft
                elif c == "^":
                    axis = lft; ang = -ang
                else:                          # | 原地掉頭
                    axis = up; ang = math.pi
                q = Quaternion(axis, ang)
                f = (q @ f).normalized()
                lft = (q @ lft).normalized()
            elif c == "[":
                stack.append((pos.copy(), f.copy(), lft.copy(),
                              up.copy(), seg_len, radius))
                seg_len *= 0.72                # 進入分枝 → 段長縮短（蕨類漸細）
                radius *= 0.80
            elif c == "]":
                pos, f, lft, up, seg_len, radius = stack.pop()
    print("羽鬚完成：%d 頂點" % len(part["verts"]))


# ============================================================================
# 5. 複眼：頭部兩側各一簇小球（電光青感光體）
# ============================================================================

def build_eyes():
    """複眼：貼著軀幹表面找最近頂點，沿近似外法線長出小球群"""
    part = new_part("eyes")
    torso_v = PARTS["torso"]["verts"]        # 用軀幹頂點找「皮膚表面」
    n_eyes = 0
    for side in (1, -1):
        anchor = Vector((0.85 * side, 1.55, 0.20))
        # 距離身體表面最近的點 = 眼群中心
        surf = min(torso_v, key=lambda v: (v - anchor).length_squared)
        # 近似外向法線（身體軸心是 Y 軸，橢圓截面往外推）
        n = Vector((surf.x, 0, surf.z * 2.0)).normalized()
        # 造一個貼著表面的切平面基底
        ref = Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((0, 1, 0))
        t1 = n.cross(ref).normalized()
        t2 = n.cross(t1).normalized()
        # 佈局：中心 1 顆 + 內圈 5 + 外圈 7（六角密排）
        placements = [(0.0, 0.0, 1.0)]
        for k in range(5):
            a = TAU * k / 5
            placements.append((0.11 * math.cos(a), 0.11 * math.sin(a), 0.85))
        for k in range(7):
            a = TAU * k / 7 + 0.4
            placements.append((0.21 * math.cos(a), 0.21 * math.sin(a), 0.68))
        for (d1, d2, s) in placements:
            p = surf + n * 0.04 + t1 * d1 + t2 * d2   # 嵌進皮膚 0.04、凸出一半
            add_sphere(part, p, 0.072 * s, nu=6, nv=4)
            n_eyes += 1
    print("複眼完成：%d 顆，%d 頂點" % (n_eyes, len(part["verts"])))


# ============================================================================
# 輸出：OBJ（拓撲存檔）+ data/leviathan.js（給 p5.js 直接讀取）
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
    # --- 先在 Blender 裡建出真正的 mesh 物件 ---
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    for name, data in PARTS.items():
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([tuple(v) for v in data["verts"]], [], data["faces"])
        mesh.validate()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)

    # --- ① 匯出 OBJ（全部三角形化） ---
    obj_path = os.path.join(OBJ_DIR, "leviathan.obj")
    try:
        bpy.ops.wm.obj_export(filepath=obj_path, export_triangulated_mesh=True)
    except TypeError:
        bpy.ops.wm.obj_export(filepath=obj_path)   # 舊版參數不同就只給路徑
    print("OBJ 已匯出：%s" % obj_path)

    # --- ② 匯出 data/leviathan.js（p5.js 用） ---
    out_parts = []
    total_v = total_f = 0
    for name, data in PARTS.items():
        tris = tri_faces(data["faces"])
        verts_flat = []
        for v in data["verts"]:
            verts_flat += [round(v.x, 4), round(v.y, 4), round(v.z, 4)]
        out_parts.append({
            "id": name,
            "vertices": verts_flat,
            "faces": tris,
        })
        total_v += len(data["verts"])
        total_f += len(tris) // 3

    payload = {
        "stats": {"vertices": total_v, "polygons": total_f},
        "blender": bpy.app.version_string,
        "parts": out_parts,
    }
    js_path = os.path.join(DATA_DIR, "leviathan.js")
    with open(js_path, "w", encoding="utf-8") as fp:
        fp.write("// 由 blender/build_leviathan.py 自動產生，請勿手改\n")
        fp.write("window.LEVIATAN = ")
        json.dump(payload, fp, ensure_ascii=False, separators=(",", ":"))
        fp.write(";\n")
    print("JS 資料已匯出：%s" % js_path)
    print("=== 統計：頂點 %d ｜ 三角面 %d ===" % (total_v, total_f))


# ============================================================================
# 主流程
# ============================================================================
if __name__ == "__main__":
    print("=" * 60)
    print("深海圖靈利維坦 建模開始（Blender %s）" % bpy.app.version_string)
    print("=" * 60)
    build_torso()
    build_belly()
    build_dla_horns()
    build_antennae()
    build_eyes()
    export_all()
    print("全部完成 ✅")
