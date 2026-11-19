# ============================================================================
# main.gd — 深海圖靈利維坦 Godot 版主場景（畫質驗證版）
# ----------------------------------------------------------------------------
# 啟動：godot --path godot -- [--env=up|sea] [--capture]
#   --env     選環境（預設 up；sea=深海）
#   --capture 跑 15 幀後截圖存到 res://shots/ 並結束（自動驗收用）
#
# 這版目標 = 「畫質證明」：Blender 匯出的原模型幾何 + 遊戲引擎級渲染
#   · SDFGI 全域光 / SSAO 環境光遮蔽 / 體積霧（深海光柱）/ ACES 色調映射 / Bloom
#   · 程序化天空（風暴雲 + 閃電片光）
# ============================================================================
extends Node3D

# 相機目標點（身體質心）與地面高度 — 由 import_src/layout.json 產生（p5 z-up → Godot y-up 已轉換）
const LAYOUT := {
	"up": {"target": [-29.13, -9.24, -6.1], "ground": -13.07, "dist": 9.0, "yaw": 0.7, "pitch": 0.35},
	"sea": {"target": [-22.62, -6.24, -9.26], "ground": -12.89, "dist": 11.0, "yaw": 1.9, "pitch": 0.30},
}
const N_WALK := 12             # 走路形變目標數（walk0..11，Blender 匯出後在 index 6..17）
const WALK_PERIOD := 11.0 / 12.0   # 一圈步態秒數 = 2π/rateWall，gSpeed 強制 2.4 → 2.2/2.4

var env_name := "up"
var do_capture := false
var evo_forced := ""            # --evo=N：強制變形進度（截圖驗證用）
var do_evolve := false          # --evolve：播進化動畫 0→6
var do_motion := false          # --motion：同構圖間隔連拍（驗證走路真的在動）
var morph_meshes: Array[MeshInstance3D] = []
var evolve_player: AnimationPlayer
var walk_player: AnimationPlayer
var evo_progress := 6.0:        # 進化進度 0=原始蝠翼 … 6=完整人形（預設 6 ＝現況不變）
	set(v):
		evo_progress = clampf(v, 0.0, 6.0)
		_apply_morph()
var walk_t := 0.0:              # 走路相位 0..1（walk 動畫驅動；1≡0 環形無接縫）
	set(v):
		walk_t = v
		_apply_morph()
var sky_mat: ShaderMaterial
var key_light: DirectionalLight3D
var flash := 0.0
var flash_next := 4.0
var flash_t := -1.0
var base_energy := 2.2
var cam_ref: Camera3D

func _ready() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--env="):
			env_name = a.trim_prefix("--env=")
		elif a == "--capture":
			do_capture = true
		elif a.begins_with("--evo="):
			evo_forced = a.trim_prefix("--evo=")
		elif a == "--evolve":
			do_evolve = true
		elif a == "--motion":
			do_motion = true
	print("[levi] env=", env_name, " adapter=", RenderingServer.get_video_adapter_name())

	if OS.get_cmdline_user_args().has("--probe"):
		_probe_shaders()
		get_tree().quit()
		return

	_load_world()
	_setup_environment()
	_setup_lights()
	_setup_camera()

	# 進化狀態：--evo=N 強制進度；--evolve 播進化動畫（都不給 → 維持 6＝現況人形）
	if evo_forced != "":
		evo_progress = evo_forced.to_float()
		print("[levi] evo forced = ", evo_progress)
	elif do_evolve and evolve_player:
		evolve_player.play("evolve")
		print("[levi] evolve animation playing")

	print("[levi] 操作：走路循環自動播放中；按 E 重播進化（0 蝠翼→6 人形），按 R 回現況")

	if do_capture:
		_capture_loop()

# ---------------------------------------------------------------------------
# 場景：匯入的 GLB（126/96 個部件）+ 材質升級
# ---------------------------------------------------------------------------
func _load_world() -> void:
	var path := "res://assets/%s.glb" % env_name
	var packed := load(path) as PackedScene
	if packed == null:
		push_error("無法載入 " + path)
		get_tree().quit(1)
		return
	var world := packed.instantiate()
	add_child(world)
	_upgrade_materials(world)
	_setup_morph(world)

# ---------------------------------------------------------------------------
# 進化 morph：GLB 裡 16 個身體部件各帶 6 個形變目標（stage0..5，basis=stage6）
#   evo_progress t（0~6）→ 權重：k=floor(t), f=t-k → w[k]=1-f, w[k+1]=f
#   t=6 → 全 0 ＝ basis ＝完整人形（預設現況）；相鄰兩 key 交叉淡入＝精確線性內插
# ---------------------------------------------------------------------------
func _setup_morph(root: Node) -> void:
	for node in root.find_children("*", "MeshInstance3D", true, false):
		var mi := node as MeshInstance3D
		if mi and mi.get_blend_shape_count() > 0:
			morph_meshes.append(mi)
	print("[levi] morph meshes=", morph_meshes.size(),
		" shapes=", morph_meshes[0].get_blend_shape_count() if morph_meshes.size() > 0 else 0)
	# 驗證形變目標名（Blender 匯出 stage0..5＋walk0..11；匯入器就算排序，字母序＝數值序仍對齊）
	if morph_meshes.size() > 0:
		var aligned := true
		for i in 6:
			if morph_meshes[0].find_blend_shape_by_name("stage%d" % i) != i:
				aligned = false
		print("[levi] morph names stage0..5 index-aligned=", aligned)
		var walk_aligned := true
		for i in N_WALK:
			if morph_meshes[0].find_blend_shape_by_name("walk%d" % i) != 6 + i:
				walk_aligned = false
		print("[levi] morph names walk0..11 index-aligned(6..17)=", walk_aligned)
	# 進化動畫：AnimationPlayer 值軌道打在根節點 evo_progress（0→6，每階段 1 秒）
	var anim := Animation.new()
	anim.length = 6.0
	var tid := anim.add_track(Animation.TYPE_VALUE)
	anim.track_set_path(tid, NodePath(":evo_progress"))
	anim.track_insert_key(tid, 0.0, 0.0)
	for i in range(1, 7):
		anim.track_insert_key(tid, float(i), float(i))
	var lib := AnimationLibrary.new()
	lib.add_animation(&"evolve", anim)
	evolve_player = AnimationPlayer.new()
	evolve_player.add_animation_library(&"", lib)
	add_child(evolve_player)
	# 走路動畫：walk_t 0→1 循環（長度＝一整圈步態；walk_t 1≡0 → 環接縫零跳動）
	if morph_meshes.size() > 0:
		var wanim := Animation.new()
		wanim.length = WALK_PERIOD
		wanim.loop_mode = Animation.LOOP_LINEAR
		var wtid := wanim.add_track(Animation.TYPE_VALUE)
		wanim.track_set_path(wtid, NodePath(":walk_t"))
		wanim.track_insert_key(wtid, 0.0, 0.0)
		wanim.track_insert_key(wtid, WALK_PERIOD, 1.0)
		var wlib := AnimationLibrary.new()
		wlib.add_animation(&"walk", wanim)
		walk_player = AnimationPlayer.new()
		walk_player.add_animation_library(&"", wlib)
		add_child(walk_player)
		walk_player.play("walk")     # ★ 一開就在走（角色自動動，不依賴按鍵）

func _apply_morph() -> void:
	if morph_meshes.is_empty():
		return
	# ---- evo 權重（6）：k=floor(t), f=t-k → w[k]=1-f, w[k+1]=f；t=6 全 0=basis ----
	var t := clampf(evo_progress, 0.0, 6.0)
	var k := int(floor(t))
	var f := t - float(k)
	var we := [0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
	if k <= 5:
		we[k] = 1.0 - f
	if k + 1 <= 5:
		we[k + 1] = f
	# ---- walk 權重（12，環形交叉淡入）×門控 ----
	#   門控：只在人形末段全開（evo≥6）；進化中（evo<5.9）淡出 → 蝠翼不會帶人形步態
	#   環形：k=walk_t*N → w[k]=1-f, w[(k+1)%N]=f；walk_t 1≡0 → 循環接縫零跳動
	var gate := clampf((t - 5.9) * 10.0, 0.0, 1.0)
	var ww := []
	ww.resize(N_WALK)
	ww.fill(0.0)
	if gate > 0.0:
		var p := walk_t * float(N_WALK)
		var kf := int(floor(p))
		var kk := kf % N_WALK
		var ff := p - float(kf)
		ww[kk] = (1.0 - ff) * gate
		ww[(kk + 1) % N_WALK] = ff * gate
	# ---- 套用：index 0..5 = evo，6..17 = walk ----
	#   防呆：GLB 若只匯出 stage0..5（無 walk0..11）→ 跳過 walk，避免 index 越界刷 ERROR
	for mi in morph_meshes:
		for i in 6:
			mi.set_blend_shape_value(i, we[i])
		if mi.get_blend_shape_count() >= 6 + N_WALK:
			for i in N_WALK:
				mi.set_blend_shape_value(6 + i, ww[i])

# 互動控制（用 _input 而非 _unhandled_input → 保證收到，不吃消費鏈；截圖模式不影響）：
#   E = 重播進化動畫（0 蝠翼 → 6 人形）  R = 立即回到 6 現況
func _input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo:
		var is_e: bool = event.keycode == KEY_E or event.physical_keycode == KEY_E
		var is_r: bool = event.keycode == KEY_R or event.physical_keycode == KEY_R
		if is_e and evolve_player:
			evolve_player.play("evolve")
			print("[levi] E → 進化動畫重播（0 蝠翼 → 6 人形）")
		elif is_r:
			if evolve_player:
				evolve_player.stop()
			evo_progress = 6.0
			print("[levi] R → 回到 evo=6 現況")

func _mat_name(src: Material) -> String:
	# 匯入材質名可能是 resource_name 或子資源路徑（m5_200_180_170）
	var n := src.resource_name
	if n == "" and src.resource_path.contains("::"):
		n = src.resource_path.get_slice("::", 1)
	return n

func _upgrade_materials(root: Node) -> void:
	# 把 Blender 匯出的「顏色+粗糙度」材質換成遊戲級 PBR 參數（保留原色）
	for node in root.find_children("*", "MeshInstance3D", true, false):
		var mi := node as MeshInstance3D
		for s in mi.get_surface_override_material_count():
			var src := mi.get_active_material(s)
			if src == null:
				continue
			var rn := _mat_name(src)                 # 形如 m5_200_180_170
			var head := rn.split("_")[0]             # m5
			if not head.begins_with("m") or not head.substr(1).is_valid_int():
				continue
			var mid := int(head.substr(1))
			mi.set_surface_override_material(s, _quality_mat(src, mid, mi.name))

func _quality_mat(src: Material, mid: int, node_name: String) -> Material:
	# 用程序化紋理 shader 取代純色材質（紋理數學移植自網頁版 LEVI_FRAG）
	var sh := ShaderMaterial.new()
	sh.shader = load("res://shaders/levi_tex.gdshader")
	var tint := Vector3(1, 1, 1)
	if src is BaseMaterial3D:
		var c := (src as BaseMaterial3D).albedo_color
		tint = Vector3(c.r, c.g, c.b)
	sh.set_shader_parameter("mat_id", mid)
	sh.set_shader_parameter("tint", tint)
	# 各材質：凹凸強度 / 粗糙度 / 金屬（bAmp × 網頁版 uBump 係數：環境1.0、皮膚0.55、甲殼0.8）
	var bump := 0.09
	var rough := 0.85
	var metal := 0.0
	match mid:
		1: bump = 0.32; rough = 0.9           # 岩（uBump=1.0）
		2: bump = 0.40; rough = 0.95          # 樹皮（溝紋最立體）
		3: bump = 0.26; rough = 1.0           # 泥土
		4: bump = 0.24; rough = 0.7           # 藤蔓
		5: bump = 0.14; rough = 0.32          # 皮膚（0.26 × uBump0.55，不要太重搶輪廓）
		6: bump = 0.34; rough = 0.42; metal = 0.12  # 甲殼（0.42 × uBump0.8）
	sh.set_shader_parameter("bump_amp", bump)
	sh.set_shader_parameter("rough", rough)
	sh.set_shader_parameter("metal", metal)
	# 地面群組：大尺度色斑（seabed/litter）；逆世界再加乾裂餘燼
	if node_name == "seabed" or node_name == "litter":
		sh.set_shader_parameter("mottle", 1.0)
		if env_name == "up":
			sh.set_shader_parameter("crack_ember", 1.0)
	# 身體皮膚：螢光輪廓邊（接續網頁版 uRim）
	if mid == 5:
		sh.set_shader_parameter("rim_str", 0.25)
	if node_name == "eyes":
		sh.set_shader_parameter("emissive", Vector3(0.45, 0.95, 1.0))
		sh.set_shader_parameter("emissive_energy", 2.5)
		sh.set_shader_parameter("rough", 0.2)
	return sh

# ---------------------------------------------------------------------------
# 環境：天空 shader / 環境光 / ACES / Bloom / SSAO / SDFGI / 霧 / 體積霧
# ---------------------------------------------------------------------------
func _setup_environment() -> void:
	var we := WorldEnvironment.new()
	var env := Environment.new()
	we.environment = env
	add_child(we)

	# ---- 程序化天空 ----
	sky_mat = ShaderMaterial.new()
	sky_mat.shader = load("res://shaders/sky.gdshader")
	var sky := Sky.new()
	sky.sky_material = sky_mat
	env.sky = sky
	env.background_mode = Environment.BG_SKY
	env.ambient_light_source = Environment.AMBIENT_SOURCE_SKY

	if env_name == "up":
		# 逆世界：暗紅風暴天空 + 雲量62% + 閃電
		sky_mat.set_shader_parameter("horizon_color", Vector3(0.30, 0.09, 0.07))
		sky_mat.set_shader_parameter("zenith_color", Vector3(0.015, 0.010, 0.030))
		sky_mat.set_shader_parameter("ground_color", Vector3(0.05, 0.02, 0.02))
		sky_mat.set_shader_parameter("cloud_color", Vector3(0.085, 0.030, 0.030))
		sky_mat.set_shader_parameter("cloud_amount", 0.62)
		sky_mat.set_shader_parameter("cloud_scale", 1.1)
		sky_mat.set_shader_parameter("wind_speed", 0.012)
		sky_mat.set_shader_parameter("flash_color", Vector3(1.0, 0.45, 0.35))
		env.ambient_light_energy = 0.42
		env.tonemap_exposure = 1.10
		env.fog_enabled = true
		env.fog_light_color = Color(0.32, 0.11, 0.10)
		env.fog_density = 0.016
		env.fog_sky_affect = 0.0          # 霧不吞天空（否則穹頂被霧色洗成一片死紅）
		env.volumetric_fog_enabled = true
		env.volumetric_fog_density = 0.012
		env.volumetric_fog_albedo = Color(0.50, 0.33, 0.30)
		env.volumetric_fog_anisotropy = 0.4
		env.volumetric_fog_length = 140.0
	else:
		# 深海：幽藍漸層、無雲、重霧 + 體積霧光柱（深海光柱的遊戲引擎版）
		sky_mat.set_shader_parameter("horizon_color", Vector3(0.035, 0.14, 0.28))
		sky_mat.set_shader_parameter("zenith_color", Vector3(0.005, 0.020, 0.055))
		sky_mat.set_shader_parameter("ground_color", Vector3(0.010, 0.045, 0.085))
		sky_mat.set_shader_parameter("cloud_amount", 0.0)
		sky_mat.set_shader_parameter("flash_color", Vector3(0.6, 0.8, 1.0))
		env.ambient_light_energy = 0.75
		env.tonemap_exposure = 1.25
		env.fog_enabled = true
		env.fog_light_color = Color(0.045, 0.15, 0.28)
		env.fog_density = 0.028
		env.fog_sky_affect = 0.0          # 霧不吞天空
		env.volumetric_fog_enabled = true
		env.volumetric_fog_density = 0.035
		env.volumetric_fog_albedo = Color(0.50, 0.68, 0.85)
		env.volumetric_fog_anisotropy = 0.75     # 前向散射 → 光柱明顯
		env.volumetric_fog_length = 160.0

	# ---- 色調映射 / 後製 ----
	env.tonemap_mode = Environment.TONE_MAPPER_ACES
	env.glow_enabled = true                 # Bloom（複眼/裂縫/閃電會暈開）
	env.glow_intensity = 0.55
	env.glow_strength = 1.0
	env.glow_hdr_threshold = 0.85
	env.glow_hdr_scale = 2.0
	env.glow_blend_mode = Environment.GLOW_BLEND_MODE_SCREEN
	env.ssao_enabled = true                 # 環境光遮蔽（石縫/腋下更立體）
	env.ssao_radius = 2.5
	env.ssao_intensity = 2.6
	env.ssao_power = 1.4
	env.sdfgi_enabled = true                # 全域光（即時 GI）
	env.sdfgi_use_occlusion = true
	env.sdfgi_bounce_feedback = 0.5
	env.adjustment_enabled = true           # 輕微對比/飽和拉皮
	env.adjustment_contrast = 1.05
	env.adjustment_saturation = 1.08

# ---------------------------------------------------------------------------
# 燈光：主光（投影）+ 補光；深海主光打進體積霧 → 光柱
# ---------------------------------------------------------------------------
func _setup_lights() -> void:
	key_light = DirectionalLight3D.new()
	if env_name == "up":
		# 網頁版 ENV_PALETTE：up 頂光 = (1.0, 0.45, 0.36) 鮭魚紅風暴光（不是白光！）
		key_light.light_color = Color(1.0, 0.45, 0.36)
		key_light.light_energy = 1.6
		key_light.rotation_degrees = Vector3(-52, 35, 0)   # 高度角、帶方位 → 長影
		key_light.light_volumetric_fog_energy = 1.0
	else:
		key_light.light_color = Color(0.78, 0.90, 1.0)
		key_light.light_energy = 3.0
		key_light.rotation_degrees = Vector3(-20, 25, 0)   # 接近直射 → 體積霧打出光柱
		key_light.light_volumetric_fog_energy = 1.6
	key_light.shadow_enabled = true
	base_energy = key_light.light_energy
	add_child(key_light)

	var fill := DirectionalLight3D.new()
	if env_name == "up":
		fill.light_color = Color(1.0, 0.35, 0.28)          # 風暴紅補光
		fill.light_energy = 0.5
		fill.rotation_degrees = Vector3(-12, -140, 0)
	else:
		fill.light_color = Color(0.30, 0.55, 0.90)
		fill.light_energy = 0.45
		fill.rotation_degrees = Vector3(-8, -150, 0)
	add_child(fill)

# ---------------------------------------------------------------------------
# 鏡頭：軌道 + 自動緩轉（可拖曳/縮放）
# ---------------------------------------------------------------------------
func _setup_camera() -> void:
	var lay: Dictionary = LAYOUT.get(env_name, LAYOUT["up"])
	var cam: Camera3D = load("res://scripts/orbit_cam.gd").new()
	cam.target = Vector3(lay["target"][0], lay["target"][1], lay["target"][2])
	cam.dist = lay["dist"]
	cam.yaw = lay["yaw"]
	cam.pitch = lay["pitch"]
	if do_capture:
		cam.auto_enabled = false   # 截圖模式：暖機期間鏡頭不可自己漂
	add_child(cam)
	cam_ref = cam

# ---------------------------------------------------------------------------
# 閃電（只在逆世界）：雙閃包絡 → 天空 flash uniform + 主光瞬間增亮
# ---------------------------------------------------------------------------
func _process(dt: float) -> void:
	if env_name != "up" or sky_mat == null:
		return
	if flash_t >= 0.0:
		flash_t -= dt
		if flash_t < 0.0:
			flash_next = 3.5 + randf() * 5.0
	else:
		flash_next -= dt
		if flash_next <= 0.0:
			flash_t = 0.55
	var v := 0.0
	if flash_t >= 0.0:
		var e := 0.55 - flash_t
		if e < 0.07: v = 1.0
		elif e < 0.13: v = 0.25
		elif e < 0.24: v = 0.9
		else: v = max(0.0, 1.0 - (e - 0.24) / 0.31)
	flash = v
	sky_mat.set_shader_parameter("flash", v)
	if key_light:
		key_light.light_energy = base_energy + v * 1.6      # 閃電片光

# ---------------------------------------------------------------------------
# --probe 除錯神諭：一次編譯8個 shader 變體，用 uniform 數判定誰編譯失敗
# ---------------------------------------------------------------------------
func _probe_shaders() -> void:
	# 每個變體都帶 probe uniform：編譯成功 → get_shader_uniform_list 會列出它
	var body := "\nvoid sky() { COLOR = vec3(probe, 0.0, 0.0); }\n"
	var variants := {}
	variants["v0_control"] = "shader_type sky;\nuniform float probe = 1.0;" + body
	variants["v1_header_comment"] = "# header comment line\nshader_type sky;\nuniform float probe = 1.0;" + body
	variants["v2_render_mode"] = "shader_type sky;\nrender_mode disable_fog;\nuniform float probe = 1.0;" + body
	variants["v3_inline_hash"] = "shader_type sky;\nrender_mode disable_fog;   # inline comment\nuniform float probe = 1.0;" + body
	variants["v4_slash_comment"] = "shader_type sky;\nuniform float probe = 1.0; // slash inline\nvoid sky() { // line comment\n\tCOLOR = vec3(probe, 0.0, 0.0); // trailing\n}\n"
	variants["v5_hints"] = "shader_type sky;\nuniform vec3 c : source_color = vec3(0.3, 0.09, 0.07);\nuniform float probe : hint_range(0.0, 1.0) = 1.0;\nvoid sky() { COLOR = vec3(probe) * c; }\n"
	variants["v6_functions"] = "shader_type sky;\nuniform float probe = 1.0;\nfloat h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }\nvoid sky() { COLOR = vec3(probe) * h(vec2(1.0, 2.0)); }\n"
	var ff := FileAccess.open("res://shaders/sky.gdshader", FileAccess.READ)
	if ff:
		variants["v7_real_file"] = ff.get_as_text()
	for k in variants:
		var sh := Shader.new()
		sh.code = str(variants[k])
		var ul: Array = sh.get_shader_uniform_list()
		var em := "?"
		if sh.has_method("get_error_message"):
			em = str(sh.call("get_error_message"))
		print("[probe] ", k, " uniforms=", ul.size(), " err=", em)

func _capture_loop() -> void:
	# 暖機90幀（~1.5s）：等金屬著色器管線首次編譯完成，避免搶跑截到黑天空
	for i in 90:
		await get_tree().process_frame
	# 三個方位各拍一張（繞一圈找沒有樹擋的構圖）；evo 後綴避免覆蓋已驗收截圖
	var suffix := ""
	if evo_forced != "":
		suffix = "_e" + evo_forced
	elif do_evolve:
		suffix = "_eanim"
	var angles := [0.0, 2.1, 4.2]
	for idx in angles.size():
		if cam_ref:
			cam_ref.yaw = float(LAYOUT[env_name]["yaw"]) + angles[idx]
		for i in 6:
			await get_tree().process_frame
		await RenderingServer.frame_post_draw
		var img := get_viewport().get_texture().get_image()
		var px := img.get_pixel(100, 50)
		print("[levi] a%d sky_px=(%.3f, %.3f, %.3f) evo=%.2f" % [idx, px.r, px.g, px.b, evo_progress])
		var out := "res://shots/%s%s_a%d.png" % [env_name, suffix, idx]
		print("[levi] capture err=", img.save_png(out), " → ", ProjectSettings.globalize_path(out))
	get_tree().quit()
