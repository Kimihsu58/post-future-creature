// ============================================================================
// sketch.js — p5.js 入口：攝影機控制、UI 接線、HUD 即時數值
// ----------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 全域狀態
// ---------------------------------------------------------------------------
const params = {
  speed: 1.9,    // 游動波速（時間倍率）
  spine: 43,     // 脊椎波幅 px
  wing: 35,      // 蝠翼扇拍 px
  belly: 15,     // 腹膜蠕動 px
  tent: 26,      // 觸手水流擺動 px
  bio: 1.0,      // 螢光亮度
  abs: 75,       // 抽象形變（0=原始蝠翼造型 → 100=完全不定形）
};
let shadeMode = "skin";        // skin / wire / glow
let camMode = "orbit";         // orbit / follow / head
let env = "up";                // up = 逆世界（怪奇物語）/ sea = 深海
let flashV = 0, flashNext = 4, flashT = -1;   // 紅色閃電狀態機
let flashFixed = null;         // ?flash=N 強制固定閃電亮度（除錯用）
let camSnap = false;           // true = 下一幀直接跳到目標視角（切換瞬間用）
let paused = false;

// ---- 遠端診斷信標（網址加 ?dbg=1 才啟動；一般使用完全不運作） ----
//   把「頁面錯誤 / F 鍵按下了沒 / 每 5 秒心率」送回伺服器 log，用來抓「無聲失敗」
const DBG = new URLSearchParams(location.search).has("dbg");
function evlog(kind, data) {
  if (!DBG) return;
  try { fetch("/__evlog?kind=" + kind + "&" + data).catch(() => {}); } catch (e) {}
}
if (DBG) {
  window.addEventListener("error", e =>
    evlog("error", "msg=" + encodeURIComponent(String(e.message).slice(0, 120)) +
      "&src=" + encodeURIComponent(String(e.filename || "").split("/").pop().slice(0, 40)) +
      "&ln=" + e.lineno));
}
let simT = 0;                  // 模擬時間（暫停時不累積）
let fbScene = null;            // 場景 framebuffer（後製的來源畫面）
let lastMeals = -1;            // 上一幀的進食數（變了就更新 HUD）

// 階段式演化的六段階梯：每吃一隻解鎖一個新的「身體改造」（walker.js 的吞食提示也會用）
// 階段名 = 「人類演化」敘事（march-of-progress）：弓身 → 低首 → 前肢 → 後肢 → 佝僂直立 → 挺身行走
const STAGES = ["原始", "Ⅰ 弓身撐起", "Ⅱ 低首成形", "Ⅲ 前肢垂落",
                "Ⅳ 後肢萌生", "Ⅴ 佝僂直立", "Ⅵ 挺身行走"];
function stageName(m) {
  return STAGES[Math.min(Math.max(m | 0, 0), 6)];
}
let postShader = null;         // 後製 shader（泛光/色散/銳化…）
let postOn = true;             // ?post=0 關閉後製（A/B 比較）
let flipY = 1.0;               // framebuffer Y 翻轉（實測校正；?flipy=0 可切換）
let fxOn = true;               // ?fx=0 → 後製全關（純取樣，除錯用）

// 攝影機球座標（z 為上）；目標點預設對準生物出生位置 (0, 0, -4)
//（tx/ty 是水平面 x/y，tz 才是「深度」— 別搞混！）
const camDefaults = { yaw: 0.9, pitch: 0.38, dist: 8.4, tx: 0, ty: 0, tz: -3.9 };
const camState = { ...camDefaults };
let dragging = null;           // "rot" | "pan" | null
let lastMouse = { x: 0, y: 0 };
let levi = null;               // Leviathan 模型實例
let walkers = [];               // 地行獸群（逆世界紅土上的六腳甲獸，預設 3 隻）
let lastAbsYaw = camDefaults.yaw;  // 最後一幀的「絕對」yaw（切回自由軌道無縫銜接）
let panUntil = 0;              // 自由環視：手動平移後這段時間內暫停自動追蹤

const CAM_LABELS = { orbit: "自由軌道", follow: "跟隨追蹤", head: "頭部特寫" };

// ---------------------------------------------------------------------------
// 顯示致命錯誤：大紅條（模型載入失敗等，絕不靜默）
// ---------------------------------------------------------------------------
function showFatal(msg) {
  const el = document.getElementById("load-error");
  el.hidden = false;
  el.textContent = "⚠️ " + msg;
}

// ---------------------------------------------------------------------------
// p5 setup
// ---------------------------------------------------------------------------
function setup() {
  // 檢查模型資料（data/leviathan.js 應該在這裡之前就載好了）
  if (!window.LEVIATAN || !LEVIATAN.parts || !LEVIATAN.parts.length) {
    showFatal("模型資料 data/leviathan.js 載入失敗 — 請先執行 blender/build_leviathan.py");
    createCanvas(windowWidth, windowHeight, WEBGL);
    noLoop();
    return;
  }
  // 環境道具資料（石頭/枯樹/藤蔓變體，Blender 產生）
  if (!window.ENV_MESHES || !ENV_MESHES.groups ||
      !ENV_MESHES.groups.rocks || !ENV_MESHES.groups.rocks.length) {
    showFatal("環境資料 data/env.js 載入失敗 — 請先執行 blender/build_env.py");
    createCanvas(windowWidth, windowHeight, WEBGL);
    noLoop();
    return;
  }

  const canvas = createCanvas(windowWidth, windowHeight, WEBGL);
  canvas.parent("sketch-holder");
  // 右鍵拖曳平移：禁止瀏覽器選單
  canvas.elt.addEventListener("contextmenu", e => e.preventDefault());

  levi = new Leviathan(LEVIATAN);
  levi.shader = createShader(LEVI_VERT, LEVI_FRAG);
  // 地行獸群：預設 3 隻（?walkers=N 可改 1~5；互相保持距離出生）
  const wq = new URLSearchParams(location.search);
  const nW = Math.max(1, Math.min(5, parseInt(wq.get("walkers") || "3", 10) || 3));
  walkers = [];
  levi.walkers = walkers;                 // 讓地行獸互相看得到同伴（分散/讓位用）
  for (let i = 0; i < nW; i++) walkers.push(new GroundWalker(levi));

  // ── 畫質升級：場景先畫進 framebuffer，再由後製 shader 統一上質感 ──
  // framebuffer = 離屏畫布（GPU 紋理），後製 pass 會對整張畫面做泛光/色散/銳化…
  // density=2 → 以 2 倍解析度渲染再縮-down（超取樣，邊緣變平滑）；?ss=1 可關（省效能）
  const ssQ = new URLSearchParams(location.search).get("ss");
  fbScene = createFramebuffer({
    textureFiltering: LINEAR,                          // 後製縮放時較平順
    density: ssQ === "1" ? pixelDensity() : 2,         // 2 = 超取樣
  });
  postShader = createShader(POST_VERT, POST_FRAG);
  // ?post=0 可關閉後製（A/B 比較用）；?flipy=0/1 校正 framebuffer 上下方向
  const pq = new URLSearchParams(location.search);
  postOn = pq.get("post") !== "0";
  if (pq.has("flipy")) flipY = pq.get("flipy") === "1" ? 1.0 : 0.0;
  if (pq.get("fx") === "0") fxOn = false;   // 後製效果全關（只留純取樣）

  // HUD：頂點/面數（模型 + 深海環境的即時總計）
  let tv = 0, tf = 0;
  for (const pt of levi.parts) { tv += pt.base.length / 3; tf += pt.faces.length / 3; }
  document.getElementById("stat-verts").textContent = tv.toLocaleString();
  document.getElementById("stat-polys").textContent = tf.toLocaleString();

  // 版本徽章：磁碟版 BUILD_TAG vs 實際載入的 LEVI_BUILD → 不符＝瀏覽器吃到舊快取/Service Worker
  const bv = document.getElementById("stat-build-v");
  if (bv) {
    if (typeof LEVI_BUILD === "string" && LEVI_BUILD === window.BUILD_TAG) {
      bv.textContent = LEVI_BUILD.replace("human", "v") + " ✓";
    } else {
      bv.textContent = (window.BUILD_TAG || "?") + " ⚠腳本過期";
      document.getElementById("stat-build").style.borderColor = "#ff5a5a";
      bv.style.color = "#ff5a5a";
      if (DBG) evlog("stale", "tag=" + window.BUILD_TAG +
        "&levi=" + (typeof LEVI_BUILD !== "undefined" ? LEVI_BUILD : "none"));
      console.warn("[build] 腳本版本不符：index=" + window.BUILD_TAG +
        " leviathan=" + (typeof LEVI_BUILD !== "undefined" ? LEVI_BUILD : "none") +
        " → 請 Cmd+Shift+R 強制重載");
    }
  }

  wireUI();

  // 支援網址參數設定初始狀態（例：?shade=glow&cam=head&speed=2.5&yaw=1.5）
  const q = new URLSearchParams(location.search);
  if (q.get("shade")) setShade(q.get("shade"));
  if (q.get("cam")) setCam(q.get("cam"));
  if (q.get("env")) setEnv(q.get("env"));
  for (const key of ["speed", "spine", "wing", "belly", "tent", "bio", "abs"]) {
    if (q.has(key)) setSlider(key, parseFloat(q.get(key)));
  }
  // ?flash=N 強制固定紅色閃電亮度 0~1（除錯/截圖用）
  if (q.has("flash")) flashFixed = Math.max(0, Math.min(1, parseFloat(q.get("flash")) || 0));
  // ?hunt=1 → 開場立即發動捕食（自動鎖定最近的一隻）；?burst=1 → 原地放一團爆點
  if (q.get("hunt")) levi.startHunt(walkers);
  if (q.get("burst")) levi.spawnBurst(levi.pose.x, levi.pose.y, levi.pose.z);
  // ?meals=N → 預設進食次數（人形化程度除錯/截圖用）
  if (q.has("meals")) levi.meals = Math.max(0, parseInt(q.get("meals"), 10) || 0);
  // ?swallow=1 → 開場就讓「離利維坦最近的一隻」開始被吞；?swallow=hold → 凍結在半路（截圖用）
  if (q.get("swallow")) {
    let w0 = walkers[0], bd = 1e9;
    for (const w of walkers) {
      if (w.eaten) continue;
      const d = Math.hypot(w.x - levi.pose.x, w.y - levi.pose.y);
      if (d < bd) { bd = d; w0 = w; }
    }
    if (w0) {
      w0.eatenBy(levi);
      if (q.get("swallow") === "hold" && w0.swallow) {
        w0.swallow.t = 0.64;              // k≈0.75 → 位移 56%、縮到 ~47%
        w0.swallow.hold = true;           // updateSwallow 釘住不前進
      }
    }
  }
  // ?bolt=x,y → 強制閃電劈在指定位置（除錯/截圖用；不設就是隨機）
  if (q.has("bolt")) {
    const [bx, by] = q.get("bolt").split(",").map(Number);
    if (isFinite(bx) && isFinite(by)) levi.forcedBolt = { x: bx, y: by };
  }
  // 除錯用：?roamsec=N → 先同步跑 N 秒漫遊（固定步長，headless 也能重現路徑）
  if (q.has("roamsec")) {
    const n = parseFloat(q.get("roamsec")) || 0;
    for (let s = 0; s < n; s += 0.05) {
      levi.roam(params, 0.05);
      for (const w of walkers) w.update(0.05, s);   // 地行獸也同步預跑（走路驗證用）
    }
    camSnap = true;   // 相機直接跳到生物目前位置
  }
  if (q.has("yaw")) camState.yaw = parseFloat(q.get("yaw"));
  if (q.has("pitch")) camState.pitch = parseFloat(q.get("pitch"));
  if (q.has("dist")) camState.dist = parseFloat(q.get("dist"));
  frameRate(60);
  console.log(`[setup] walkers=${walkers.length} meals=${levi.meals} env=${env}`);  // 除錯：初始狀態
}

// 以名稱切換着色模式（面板已刪 → 直接改狀態；不合法的值維持原模式）
function setShade(name) {
  if (!["skin", "wire", "glow"].includes(name)) return;
  shadeMode = name;
}

// 以名稱切換環境（深海 ↔ 逆世界；直接改狀態 + 重算要畫的物件/配色）
function setEnv(name) {
  env = name;
  if (levi) levi.setEnv(name);
}

// 以名稱切換攝影機模式（面板已刪 → 直接改狀態 + 同步 HUD 視角文字）
function setCam(name) {
  if (!(name in CAM_LABELS)) return;           // 不合法的值維持原模式
  camMode = name;
  camSnap = true;                              // 切換瞬間先跳到位，再柔和追蹤
  panUntil = 0;                                // 重新開始自動追蹤生物
  camState.yaw = (name === "orbit") ? lastAbsYaw : 0;   // follow/head：yaw 變成相對偏移
  document.getElementById("view-mode-label").textContent = CAM_LABELS[camMode];
}

// 依名稱設定參數（面板已刪 → 直接寫 params；HUD 頻率數字一併同步）
function setSlider(key, val) {
  params[key] = val;
  if (key === "speed") {
    document.getElementById("stat-freq").textContent = val + "x";
  }
}

// ---------------------------------------------------------------------------
// UI 接線：滑桿、單選鈕、按鈕
// ---------------------------------------------------------------------------
function wireUI() {
  // 滑桿與單選鈕都屬於已刪除的右側面板 → 沒有可接的元素；
  // 參數改走網址（?speed= / ?shade= / ?env= / ?cam=）→ setSlider/setShade/…

  // 按鈕（blur 避免空白鍵重複觸發按鈕）
  document.getElementById("btn-pause").addEventListener("click", e => {
    togglePause(); e.target.blur();
  });
  document.getElementById("btn-reset").addEventListener("click", e => {
    resetPose(); e.target.blur();
  });
  document.getElementById("btn-hunt").addEventListener("click", e => {
    tryHunt("btn"); e.target.blur();        // blur：點完按鈕不搶走鍵盤焦點
  });
  // 音效開關：點按鈕或按 M；按鈕文字反映目前狀態（AudioContext 需第一次互動才解鎖）
  const btnSound = document.getElementById("btn-sound");
  const syncSound = () => {
    if (btnSound) btnSound.textContent = (SFX && SFX.muted) ? "🔇 靜音 (M)" : "🔊 音效 (M)";
  };
  if (btnSound) {
    btnSound.addEventListener("click", e => {
      SFX.toggle(); syncSound(); e.target.blur();
    });
    syncSound();
  }
  //（原 ⚙️ 參數面板按鈕 —— 面板已依需求刪除，接線一併移除）
}

function togglePause() {
  paused = !paused;
  document.getElementById("btn-pause").textContent =
    paused ? "▶ 繼續 (空白鍵)" : "⏸ 暫停 (空白鍵)";
}

function resetPose() {
  Object.assign(camState, camDefaults);
  if (levi) levi.resetPose();     // 生物回到出生點
  for (const w of walkers) w.resetPose(); // 地行獸也回出生點（清除被吃狀態）
  lastAbsYaw = camDefaults.yaw;
  panUntil = 0;
  simT = 0;
}

// ---------------------------------------------------------------------------
// 攝影機：球座標環繞目標點，三種模式只差「目標點在哪 / yaw 怎麼算」
//   orbit  自由環視：目標軟跟生物（平移後 6 秒不干擾），yaw 完全由使用者
//   follow 跟隨追蹤：鏡頭追在正後方，yaw = π−heading + 使用者偏移
//   head   頭部特寫：鏡頭在頭的正前方回望，yaw = −heading + 使用者偏移
// ---------------------------------------------------------------------------
function applyCamera(p) {
  const c = camState;
  const P = levi ? levi.pose : { x: 0, y: 0, z: -4, heading: 0 };
  let goal = null;
  let absYaw = c.yaw;                       // 「絕對」球座標 yaw

  if (camMode === "orbit") {
    if (levi && millis() > panUntil) {
      goal = { tx: P.x, ty: P.y, tz: P.z + 0.1 };   // 軟跟著生物
    }
  } else if (camMode === "follow") {
    goal = { tx: P.x, ty: P.y, tz: P.z + 0.4, dist: 9.5 };
    absYaw = Math.PI - P.heading + c.yaw;   // 站在生物正後方 + 使用者偏移
  } else if (camMode === "head") {
    const h = levi ? levi.headWorld(simT) : [0, 1.5, 0.5];
    goal = { tx: h[0], ty: h[1], tz: h[2], dist: 3.4 };
    absYaw = -P.heading + c.yaw;            // 正前方回望臉 + 使用者偏移
  }

  if (goal) {
    if (camSnap) {
      // 切換視角的瞬間：直接跳到位
      c.tx = goal.tx; c.ty = goal.ty; c.tz = goal.tz;
      if (goal.dist) c.dist = goal.dist;    // 距離只在切換時校正（滾輪仍可自由縮放）
      camSnap = false;
    } else {
      const k = camMode === "orbit" ? 0.06 : 0.15;   // 跟隨追得緊一點
      c.tx += (goal.tx - c.tx) * k;
      c.ty += (goal.ty - c.ty) * k;
      c.tz += (goal.tz - c.tz) * k;
    }
  } else {
    camSnap = false;
  }

  const r = c.dist * Math.cos(c.pitch);
  const eye = [
    c.tx + r * Math.sin(absYaw),
    c.ty + r * Math.cos(absYaw),
    c.tz + c.dist * Math.sin(c.pitch),
  ];
  lastAbsYaw = absYaw;
  if (levi) levi.setCamEye(eye[0], eye[1], eye[2], c.tx, c.ty, c.tz);  // 着色器視線 + 線寬換算用
  // 注意：p5 的攝影機有 y-flip，要讓世界 +z 出現在螢幕上方，up 要傳 (0,0,-1)
  p.camera(eye[0], eye[1], eye[2], c.tx, c.ty, c.tz, 0, 0, -1);
}

// ---------------------------------------------------------------------------
// 滑鼠控制：左鍵旋轉 / 右鍵平移 / 滾輪縮放
// ---------------------------------------------------------------------------
function mousePressed() {
  // 只有真正點在畫布上才啟動拖曳（點到參數面板不算）
  const ev = window.event;
  if (!ev || !ev.target || ev.target.tagName !== "CANVAS") { dragging = null; return; }
  lastMouse = { x: mouseX, y: mouseY };
  if (mouseButton === LEFT) dragging = "rot";
  else if (mouseButton === RIGHT) dragging = "pan";
}

function mouseDragged() {
  if (!dragging) return;
  const dx = mouseX - lastMouse.x, dy = mouseY - lastMouse.y;
  lastMouse = { x: mouseX, y: mouseY };
  if (dragging === "rot") {
    camState.yaw -= dx * 0.005;
    camState.pitch = Math.max(-1.45, Math.min(1.45, camState.pitch + dy * 0.005));
  } else if (dragging === "pan") {
    // 平移方向要跟著攝影機的「右」與「上」；6 秒內不自動追蹤生物
    const c = camState;
    const rx = Math.cos(c.yaw), ry = -Math.sin(c.yaw);       // 攝影機右方向（水平）
    const s = c.dist * 0.0016;
    c.tx -= rx * dx * s; c.ty -= ry * dx * s;
    c.tz += dy * s;
    panUntil = millis() + 6000;
  }
}

function mouseReleased() { dragging = null; }

function mouseWheel(event) {
  // 只有滑鼠在畫布上才縮放（在面板上要讓面板正常捲動）
  if (event.target && event.target.tagName !== "CANVAS") return true;
  camState.dist = Math.max(2.2, Math.min(30, camState.dist * (1 + event.delta * 0.0012)));
  return false;                 // 阻止頁面捲動
}

// ---------------------------------------------------------------------------
// 捕食事件的 HUD 提示（leviathan.js / walker.js 會呼叫這個全域函式）
// ---------------------------------------------------------------------------
let huntMsgTimer = null;
function huntMsg(text) {
  console.log("[hunt]", text);          // 主控台留一份事件紀錄（除錯用）
  const el = document.getElementById("hunt-msg");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(huntMsgTimer);
  huntMsgTimer = setTimeout(() => el.classList.remove("show"), 2400);
}

function keyPressed() {
  if (key === " ") { togglePause(); return false; }
  if (key === "r" || key === "R") resetPose();
  if (key === "f" || key === "F") tryHunt("key");   // F 鍵 = 捕食（和 🍖按鈕同一條路徑）
  if (key === "m" || key === "M") {                 // M 鍵 = 音效開關
    if (typeof SFX !== "undefined") {
      SFX.toggle();
      const b = document.getElementById("btn-sound");
      if (b) b.textContent = SFX.muted ? "🔇 靜音 (M)" : "🔊 音效 (M)";
    }
  }
}

// ── 捕食（F 鍵 / 🍖捕食按鈕 共用同一條路徑）──
//   失敗一定要講清楚原因（不再無聲失敗）
function tryHunt(src) {
  evlog("fkey", "src=" + src);              // 診斷：有沒有送到頁面
  if (paused) { huntMsg("先解除暫停才能捕食"); return; }
  const ok = levi && levi.startHunt(walkers);
  if (!ok) {
    let why = "現在不能捕食";
    if (!levi) why = "頁面還沒準備好，再試一次";
    else if (levi.env !== "up") why = "深海沒有獵物 —— 要在逆世界（?env=up）";
    else if (levi.hunt.active) why = "正在追擊中…等牠咬到或放棄";
    else if (levi.hunt.cd > 0) why = `捕食冷卻中（剩 ${Math.ceil(levi.hunt.cd)} 秒）`;
    evlog("fkeyfail", "why=" + encodeURIComponent(why));   // 診斷：失敗原因
    huntMsg("🍖 " + why);
  } else {
    evlog("fkeyok", "src=" + src);          // 診斷：追擊成功發起
  }
}

function windowResized() { resizeCanvas(windowWidth, windowHeight); }

// ---------------------------------------------------------------------------
// 每幀繪製
// ---------------------------------------------------------------------------
let fpsCounter = 0;

function draw() {
  if (!levi) { background(4, 11, 24); return; }
  // 診斷心率：每 5 秒回報「畫面迴圈還活著嗎 + 狩獵狀態」
  if (DBG && frameCount % 300 === 0 && frameCount > 0) {
    evlog("beat", "fc=" + frameCount + "&meals=" + levi.meals +
      "&hunt=" + (levi.hunt.active ? 1 : 0) + "&cd=" + Math.round(levi.hunt.cd) +
      "&paused=" + (paused ? 1 : 0) + "&fps=" + Math.round(frameRate()));
  }
  perspective(PI / 3, width / height, 0.1, 250);   // z-up 相機要大一點的 far（天空穹頂 r150）

  // 暫停：時間不走，但相機還能動（所以不用 noLoop）
  const dt = paused ? 0 : Math.min(deltaTime / 1000, 0.05);
  if (!paused) simT += dt * params.speed;

  // ── 紅色閃電（只在逆世界）：每 5~13 秒一次「雙閃」包絡，紅光掃過整個場景 ──
  if (flashFixed !== null) {
    flashV = flashFixed;                       // ?flash=N 強制固定亮度（除錯用）
  } else if (env !== "up" || paused) {
    flashV = 0;
  } else {
    if (flashT >= 0) {
      flashT -= dt;
      if (flashT < 0) flashNext = 3.5 + Math.random() * 5;   // 結束 → 排下一次（更頻繁 → 戲劇感）
    } else {
      flashNext -= dt;
      if (flashNext <= 0) flashT = 0.55;                   // 觸發：0.55 秒閃電
    }
    const e = flashT >= 0 ? 0.55 - flashT : -1;            // 閃電經過秒數
    if (e < 0) {
      // 雲隙微閃：兩道閃電之間，天空偶爾微微亮一下（雲後遠雷的感覺）
      const f1 = Math.max(0, Math.sin(simT * 0.43));
      const f2 = Math.max(0, Math.sin(simT * 0.91 + 2.1));
      flashV = 0.05 * (Math.pow(f1, 14) + 0.7 * Math.pow(f2, 22));
    } else if (e < 0.07) flashV = 1;        // 第 1 閃
    else if (e < 0.13) flashV = 0.25;     // 暗下
    else if (e < 0.24) flashV = 0.9;      // 第 2 閃
    else flashV = Math.max(0, 1 - (e - 0.24) / 0.31);      // 拖尾衰減
  }
  levi.flash = flashV;

  // 背景 = 霧色（閃電時一起紅移 → 地平線沒有色縫）
  const fog = envFogRGB(env, shadeMode === "glow", flashV);

  // ── 畫質升級 Pass 1：整個 3D 場景畫進 framebuffer（離屏畫布） ──
  //（?post=0 時不走 framebuffer → 直接畫到畫布，方便 A/B 比較）
  const usePost = postOn && fbScene;
  if (usePost) fbScene.begin();
  // 注意：fb.begin() 會換成 framebuffer 自己的預設相機（近裁面超遠 → 近景全被裁掉），
  // 所以 perspective() 必須在 begin() 之後重設一次才會生效
  perspective(PI / 3, width / height, 0.1, 250);
  background(fog[0], fog[1], fog[2]);

  levi.roam(params, dt);        // ① 自主漫遊：世界位置 / 朝向 / 海雪
  applyCamera(window);          // ② 相機（三種模式都追著生物）
  levi.update(params, simT);    // ③ 頂點波浪 + 抽象形變
  if (env === "up") for (const w of walkers) w.update(dt, simT);  // ③b 地行獸步態（深海不出現）
  levi.fbMode = usePost;        // framebuffer 內繞序會反 → shader 的 gl_FrontFacing 判斷要跟著切
  levi.render(window, shadeMode, params, simT,
              env === "up" ? walkers : null);   // ④ 環境 + 生物 + 複眼 + 海雪（逆世界加畫地行獸群）

  // ── Pass 2：後製 — 把 framebuffer 用滿版 quad 掛上 shader 送進螢幕 ──
  if (usePost) {
    fbScene.end();
    clear();                    // 清畫布 + 深度（不然上一幀的深度會擋掉這張 quad）
    shader(postShader);
    postShader.setUniform("uScene", fbScene);     // p5 會自動取 framebuffer 的顏色紋理
    postShader.setUniform("uRes", [width, height]);
    postShader.setUniform("uTime", millis() / 1000);
    // 各效果強度（想調氣氛直接改這裡；0 = 該效果關閉）
    postShader.setUniform("uBloom", 0.95);        // 泛光：亮部暈開（裂縫餘燼/光柱更出彩）
    postShader.setUniform("uCA", 1.0);            // 色散：邊緣 R/B 分離
    postShader.setUniform("uVig", 1.0);           // 暗角：四角壓暗
    postShader.setUniform("uGrain", 0.8);         // 顆粒：膠片雜訊
    postShader.setUniform("uSharp", 0.6);         // 銳化：補償縮放柔化
    postShader.setUniform("uContrast", 0.8);      // 對比：filmic S 曲線（拉強 → 整體更立體）
    postShader.setUniform("uGrade", 1.0);         // 分級：暗部冷青藍、亮部暖（冷暖層次）
    postShader.setUniform("uFlipY", flipY);       // framebuffer Y 軸方向（實測校正）
    if (!fxOn) {   // ?fx=0 → 純取樣（除錯：確認 framebuffer 內容本身對不對）
      postShader.setUniform("uBloom", 0);
      postShader.setUniform("uCA", 0);
      postShader.setUniform("uVig", 0);
      postShader.setUniform("uGrain", 0);
      postShader.setUniform("uSharp", 0);
      postShader.setUniform("uContrast", 0);
      postShader.setUniform("uGrade", 0);
    }
    noStroke();
    // 滿版四邊形：直接給 NDC 座標 -1~1（不依賴相機矩陣 → 一定剛好蓋滿畫面）
    beginShape(TRIANGLES);
    vertex(-1, -1, 0, 0, 0);   // x, y, z, u, v
    vertex(1, -1, 0, 1, 0);
    vertex(1, 1, 0, 1, 1);
    vertex(-1, -1, 0, 0, 0);
    vertex(1, 1, 0, 1, 1);
    vertex(-1, 1, 0, 0, 1);
    endShape();
    resetShader();
  }

  // FPS + 進食/人形化 顯示（FPS 每 20 幀更新；進食數一變就立刻更新）
  if (++fpsCounter % 20 === 0) {
    document.getElementById("stat-fps").textContent = Math.round(frameRate());
  }
  if (levi.meals !== lastMeals) {
    lastMeals = levi.meals;
    document.getElementById("stat-meals").textContent = lastMeals;
    // 顯示「目前演化階段」＋ 完成度%
    document.getElementById("stat-alien").textContent =
      stageName(lastMeals) + " " +
      Math.round(Math.min(lastMeals, 6) / 6 * 100) + "%";
  }
}
