# orbit_cam.gd — 滑鼠軌道鏡頭（左鍵拖曳旋轉、滾輪縮放、無操作時緩慢環繞）
extends Camera3D

var target := Vector3.ZERO      # 注視點（身體質心，由 main.gd 設定）
var yaw := 0.7                  # 水平方位角
var pitch := 0.35               # 俯角（正=由上往下看）
var dist := 9.0                 # 與目標距離
var dragging := false
var auto_speed := 0.05          # 自動環繞速度（rad/s，拖曳時暫停）
var auto_enabled := true        # 截圖驗收時關掉（否則暖機期間構圖會漂移）

func _ready() -> void:
	fov = 60.0                    # 與網頁版視角一致
	near = 0.1
	far = 400.0
	make_current()
	_apply()

func _process(dt: float) -> void:
	if not dragging and auto_enabled:
		yaw += auto_speed * dt
	_apply()

func _apply() -> void:
	var r := dist * cos(pitch)
	position = target + Vector3(r * sin(yaw), dist * sin(pitch), r * cos(yaw))
	look_at(target, Vector3.UP)

func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventMouseButton:
		if e.button_index == MOUSE_BUTTON_LEFT:
			dragging = e.pressed
		elif e.pressed and e.button_index == MOUSE_BUTTON_WHEEL_UP:
			dist = max(3.0, dist * 0.9)
		elif e.pressed and e.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			dist = min(80.0, dist * 1.1)
	elif e is InputEventMouseMotion and dragging:
		yaw -= e.relative.x * 0.006
		pitch = clamp(pitch + e.relative.y * 0.006, -0.2, 1.45)
