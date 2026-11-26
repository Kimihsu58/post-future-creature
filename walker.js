// =============================================================================
// 地行獸（GroundWalker）—— 逆世界紅土上爬行的六腳甲獸
//   · 只在逆世界（env === "up"）活動；深海時 sketch.js 不更新、也不傳給 render
//   · 借用 Leviathan 的小工具：finalizePart（法線 + 收檔）、
//     computeNormalsFrom（每幀重算法線）、drawParts / drawEdges（共用著色管線）、
//     floorZ（地面起伏）、obstacles（枯樹/礁岩避開清單）
//   · 步態 =「交替三角步態」（hexapod 標準步態）：
//     六隻腳分成兩組三隻 —— 一組跨步騰空時，另一組三角形踩地支撐身體
//   · 身體座標：+Y = 頭方向、+X = 右側；移動只繞 Z 旋轉（yaw）
//   · 朝向慣例跟利維坦一致：forward = (-sin h, cos h)
// =============================================================================

class GroundWalker {
  constructor(levi) {
    this.levi = levi;                  // 借用利維坦的小工具（地板/障礙/繪製/法線）
    this.build();                      // 建甲殼/頭/尾刺/六腳/雙觸鬚
    this.resetPose();                  // 出生點 + 初始步態狀態
  }

  wrapPi(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

  // 局部座標 → 世界座標（繞 Z 旋轉 heading + 平移；cos/sin 每幀快取）
  toWorld(lx, ly, lz) {
    return [
      this.x + lx * this.cos - ly * this.sin,
      this.y + lx * this.sin + ly * this.cos,
      this.z + lz,
    ];
  }

  // ===========================================================================
  // 幾何建構
  // ===========================================================================

  // 側面輪廓 → 旋轉體（甲殼/頭/尾刺都用它）
  //   profile = [[y, r, z], ...]：沿 +Y 的一圈圈「高度, 半徑, 偏移」
  //   圈面 = XZ 平面；三角繞法與 leviathan.js 的 tube() 完全一致 → 陰影行為相同
  lathe(part, profile, sides, capFront, capBack) {
    const rings = [];
    for (let i = 0; i < profile.length; i++) {
      const [y, r, z] = profile[i];
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        part.base.push(-Math.cos(a) * r, y, z + Math.sin(a) * r);
      }
      rings.push(Array.from({ length: sides }, (_, k) =>
        (part.base.length / 3) - sides + k));
    }
    for (let i = 0; i < rings.length - 1; i++) {
      const A = rings[i], B = rings[i + 1];
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides;
        part.faces.push(A[k], A[k2], B[k2], A[k], B[k2], B[k]);
      }
    }
    // 端點補扇形蓋（不然甲殼前後是空心洞）
    const cap = (ring, y, z, flip) => {
      const c = part.base.length / 3;
      part.base.push(0, y, z);
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides;
        if (flip) part.faces.push(c, ring[k2], ring[k]);
        else part.faces.push(c, ring[k], ring[k2]);
      }
    };
    if (capFront) cap(rings[rings.length - 1],
      profile[profile.length - 1][0], profile[profile.length - 1][2], false);
    if (capBack) cap(rings[0], profile[0][0], profile[0][2], true);
  }

  // 把一條管子寫進 arr（世界座標；數學 = leviathan.js tube() 的環框算法）
  //   legs/觸鬚每幀重算路徑 → 直接覆寫 pos，拓撲（面）固定不變
  writeTube(arr, pts, r0, r1, sides) {
    let vi = 0;
    const rings = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const pPrev = pts[Math.max(0, i - 1)], pNext = pts[Math.min(pts.length - 1, i + 1)];
      let tx = pNext[0] - pPrev[0], ty = pNext[1] - pPrev[1], tz = pNext[2] - pPrev[2];
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      let ux = -ty, uy = tx, uz = 0;                       // 與切線垂直的基底
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-4) { ux = 1; uy = 0; uz = 0; ul = 1; }
      ux /= ul; uy /= ul; uz /= ul;
      const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
      const r = r0 + (r1 - r0) * (i / (pts.length - 1));
      const ring = [];
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        const c = Math.cos(a) * r, s = Math.sin(a) * r;
        arr[vi++] = p[0] + ux * c + vx * s;
        arr[vi++] = p[1] + uy * c + vy * s;
        arr[vi++] = p[2] + uz * c + vz * s;
        ring.push(vi / 3 - 1);
      }
      rings.push(ring);
    }
    return rings;   // 面在 build() 開一次就好（拓撲固定）
  }

  // 六腿配置：side +1 右 / -1 左；off = 步態相位（0 / 0.5 兩組三角形）
  static LEG_DEFS = [
    { side: +1, y:  0.76, lead:  0.34, off: 0.0 },   // 右前（A 組）
    { side: +1, y:  0.02, lead:  0.00, off: 0.5 },   // 右中（B 組）
    { side: +1, y: -0.72, lead: -0.34, off: 0.0 },   // 右後（A 組）
    { side: -1, y:  0.76, lead:  0.34, off: 0.5 },   // 左前（B 組）
    { side: -1, y:  0.02, lead:  0.00, off: 0.0 },   // 左中（A 組）
    { side: -1, y: -0.72, lead: -0.34, off: 0.5 },   // 左後（B 組）
  ];

  build() {
    const L = this.levi;
    this.solid = [];
    this.hard = [];          // 硬殼三件（姿態只做剛體旋轉+平移）

    // ① 甲殼：中間鼓、前後收尖的 9 環旋轉體
    const shell = { id: "wShell", base: [], faces: [], mat: 6, color: [104, 50, 54] };
    const rr = [0.18, 0.34, 0.47, 0.55, 0.58, 0.55, 0.47, 0.36, 0.24];
    this.lathe(shell, rr.map((r, i) =>
      [-1.15 + (i / (rr.length - 1)) * 2.4, r, 0.10]), 10, true, true);
    L.finalizePart(shell);
    this.solid.push(shell); this.hard.push(shell);

    // ② 頭：前端一坨 + 尾刺：後端上翹的細尖
    const head = { id: "wHead", base: [], faces: [], mat: 6, color: [96, 46, 50] };
    this.lathe(head, [[1.02, 0.30, 0.08], [1.28, 0.26, 0.14], [1.52, 0.15, 0.22]],
      10, true, false);
    L.finalizePart(head);
    this.solid.push(head); this.hard.push(head);

    const tail = { id: "wTail", base: [], faces: [], mat: 6, color: [86, 40, 45] };
    this.lathe(tail, [[-1.05, 0.15, 0.10], [-1.35, 0.09, 0.24], [-1.58, 0.02, 0.40]],
      8, true, false);
    L.finalizePart(tail);
    this.solid.push(tail); this.hard.push(tail);

    // ③ 六條腿：5 環 × 5 邊的管子；面開一次（拓撲固定），pos 每幀重寫
    this.legs = GroundWalker.LEG_DEFS.map((def, i) => {
      const part = { id: "wLeg" + i, base: [], faces: [], mat: 6, color: [72, 35, 39] };
      const tmp = new Array(5 * 5 * 3).fill(0);
      this.writeTube(tmp, [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]],
        0.13, 0.045, 5);
      part.base = tmp;
      const rings = [];
      for (let r = 0; r < 5; r++)
        rings.push(Array.from({ length: 5 }, (_, k) => r * 5 + k));
      for (let r = 0; r < 4; r++) {
        const A = rings[r], B = rings[r + 1];
        for (let k = 0; k < 5; k++) {
          const k2 = (k + 1) % 5;
          part.faces.push(A[k], A[k2], B[k2], A[k], B[k2], B[k]);
        }
      }
      L.finalizePart(part);
      this.solid.push(part);
      return {
        part, side: def.side, off: def.off, swinging: false,
        hip: [def.side * 0.42, def.y, -0.06],                 // 髖（身體局部）
        home: [def.side * 1.12, def.y + def.lead, -0.56],     // 腳掌 HOME（局部）
        f: [0, 0, 0], s0: [0, 0, 0], s1: [0, 0, 0],           // 腳掌世界座標
      };
    });

    // ④ 雙觸鬚：4 環小管子；每幀跟著頭 + 尖端隨風擺
    this.ants = [1, -1].map((s, i) => {
      const part = { id: "wAnt" + i, base: [], faces: [], mat: 6, color: [78, 37, 41] };
      const tmp = new Array(4 * 4 * 3).fill(0);
      this.writeTube(tmp, [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], 0.045, 0.012, 4);
      part.base = tmp;
      const rings = [];
      for (let r = 0; r < 4; r++)
        rings.push(Array.from({ length: 4 }, (_, k) => r * 4 + k));
      for (let r = 0; r < 3; r++) {
        const A = rings[r], B = rings[r + 1];
        for (let k = 0; k < 4; k++) {
          const k2 = (k + 1) % 4;
          part.faces.push(A[k], A[k2], B[k2], A[k], B[k2], B[k]);
        }
      }
      L.finalizePart(part);      // 收進 levi.parts → HUD 統計自動包含地行獸
      this.solid.push(part);
      return {
        part, ph: i * 1.7,
        local: [[s * 0.10, 1.42, 0.30], [s * 0.16, 1.58, 0.52],
                [s * 0.22, 1.72, 0.68], [s * 0.28, 1.84, 0.76]],
      };
    });

    // ⑤ 線框：把所有面的唯一邊收成 [part, a, b] 扁平三元組（跟利維坦同格式）
    this.edges = [];
    const seen = new Set();
    for (const part of this.solid) {
      const f = part.faces;
      for (let i = 0; i < f.length; i += 3) {
        for (let k = 0; k < 3; k++) {
          const a = f[i + k], b = f[i + (k + 1) % 3];
          const key = part.id + ":" + (a < b ? a + "-" + b : b + "-" + a);
          if (seen.has(key)) continue;
          seen.add(key);
          this.edges.push(part, a, b);
        }
      }
    }
  }

  // ===========================================================================
  // 出生狀態：紅土上隨機一點，先走 6 秒再停下來聞一聞
  // ===========================================================================
  resetPose() {
    // 出生/重生點：場地邊緣附近、避開枯樹/礁岩、也遠離掠食者（給反應時間）
    //   多隻同伴時也互相保持 5 單位以上距離（不會生在疊在一起）
    let sx = 7, sy = -5;
    for (let tries = 0; tries < 30; tries++) {
      const a = Math.random() * 6.28, r = 12 + Math.random() * 9;
      sx = Math.cos(a) * r; sy = Math.sin(a) * r;
      const noObstacle = !this.levi.obstacles.some(o =>
        Math.hypot(sx - o.x, sy - o.y) < o.r + 3);
      const P = this.levi.pose;
      const others = this.levi.walkers || [];      // 同伴清單（sketch.js 掛上）
      const sepOK = others.every(o => o !== this && !o.eaten &&
        Math.hypot(sx - o.x, sy - o.y) > 5);
      if (noObstacle && sepOK && Math.hypot(sx - P.x, sy - P.y) > 11) break;
    }
    this.x = sx; this.y = sy;
    this.heading = Math.random() * 6.28;
    this.eaten = false; this.respawnT = 0;
    this.swallow = null; this.scaleK = 1;          // 吞食狀態全部清掉
    this.speed = 0; this.step = 0; this.wt = 3;
    this.paused = false; this.pauseT = 6;
    this.baseDir = 2.0;
    this.cos = Math.cos(this.heading); this.sin = Math.sin(this.heading);
    this.z = this.levi.floorZ(this.x, this.y) + 0.56;
    // 六腳先踩到 HOME（避免第一幀懸空）
    for (const leg of this.legs) {
      const h = this.toWorld(leg.home[0], leg.home[1], leg.home[2]);
      leg.f = [h[0], h[1], this.levi.floorZ(h[0], h[1]) + 0.02];
    }
    this.update(1e-4, 0);   // 用極小 dt 跑一次 → 硬殼/觸鬚/眼睛座標就位
  }

  // 被捕食：不瞬間消失 ——
  //   人形完成體（蛻皮完、背長滿觸手）：改用「背後觸手」處理，2.4 秒三段
  //   （纏住掙扎 → 勒緊提起 → 拖向嘴吞下）；其他階段照舊直接吸向巨口 ~0.85 秒
  eatenBy(pred) {
    if (this.swallow || this.eaten) return;
    if (pred && (pred._sw || 0) > 0.9) {
      this.swallow = { t: 0, dur: 2.4, pred, tent: true,
                       base: [this.x, this.y, this.z] };
      this.speed = 0;
      pred.tentHunt = { w: this, t: 0, rt: 0 };   // 觸手追逐狀態（leviathan ⑤h 每幀讀）
      huntMsg("🐙 觸手暴射——整隻纏住了！");
      // 觸手模式 2.4 秒：咬擊嘶吼＋整段「扭塑膠」擠壓聲（掙扎→勒緊→吞）
      if (window.SFX) { SFX.bite(); SFX.twist({ dur: 2.4, when: 0.15 }); }
      return;
    }
    this.swallow = { t: 0, dur: 0.85, pred };
    this.speed = 0;
    huntMsg("🔴 咬住了！地行獸被整隻拖向巨口…");
    // 一般模式 0.85 秒：咬擊嘶吼＋被拖進嘴時的扭擠噼啪聲
    if (window.SFX) { SFX.bite(); SFX.twist({ dur: 0.85, when: 0.1 }); }
  }

  // 吞食動畫：身體中心往「嘴巴」插值 + 全身等比縮小 + 輕微翻滾；
  //   頂點每幀繞「舊中心」做 旋轉→縮放→平移（寫好的世界座標直接搬移）
  updateSwallow(dt) {
    const s = this.swallow;
    if (!s.hold) s.t += dt;                        // ?swallow=hold 會釘在半路（截圖用）
    const k = Math.min(1, s.t / s.dur);
    const P = s.pred.pose;
    // 嘴巴世界座標 = 身體前方（forward = (-sin h, cos h)）
    // 人形化：嘴巴長在「人頭正面」→ 前移量縮短、高度上移貼到臉
    const hH = (this.levi.human && this.levi.human.hHd) || 0;
    const mf = 2.2 - 1.6 * hH;
    const mx = P.x - Math.sin(P.heading) * mf;
    const my = P.y + Math.cos(P.heading) * mf;
    const mz = P.z - 0.15 + 2.2 * hH;
    const prevC = [this.x, this.y, this.z];
    const prevS = this.scaleK;
    // 觸手模式（人形完成體）：0~1.1s 被纏在原地掙扎（小幅抖動＋被勒縮＋微微提起），
    // 1.1s 之後才被「拖向嘴」縮小吞下。一般模式：直接拖向嘴。
    const tent = !!s.tent, HOLD = 1.1;
    let newC, newS;
    if (tent && s.t < HOLD) {
      const kk = s.t / HOLD, b = s.base;
      newC = [b[0] + Math.sin(s.t * 37) * 0.05,          // 掙扎抖動
              b[1] + Math.cos(s.t * 41) * 0.05,
              b[2] + Math.sin(s.t * 23) * 0.06 + kk * 0.3];   // 被微微提起離地
      newS = 1 - 0.22 * kk;                              // 被纏緊勒住略縮（→78%）
    } else {
      const e2 = tent ? (s.t - HOLD) / (s.dur - HOLD) : k;
      const e = Math.max(0, Math.min(1, e2)) ** 2;       // 加速吸入（越靠近嘴越快）
      const s0 = tent ? 0.78 : 1;                        // 觸手模式從「被勒的 78%」接著縮
      newC = [prevC[0] + (mx - prevC[0]) * e,
              prevC[1] + (my - prevC[1]) * e,
              prevC[2] + (mz - prevC[2]) * e];
      newS = Math.max(0.05, s0 - (s0 - 0.05) * e);       // 縮到 5% 才算吞完
    }
    const ratio = newS / prevS;
    this.x = newC[0]; this.y = newC[1]; this.z = newC[2];
    this.scaleK = newS;
    // 全身頂點：繞舊中心轉一點（吸進去時翻滾）→ 等比縮小 → 搬到新中心
    const spin = dt * 3.0;
    const cs = Math.cos(spin), sn = Math.sin(spin);
    const move = (arr) => {
      for (let i = 0; i < arr.length; i += 3) {
        const rx = arr[i] - prevC[0], ry = arr[i + 1] - prevC[1],
              rz = arr[i + 2] - prevC[2];
        arr[i]     = this.x + (rx * cs - ry * sn) * ratio;
        arr[i + 1] = this.y + (rx * sn + ry * cs) * ratio;
        arr[i + 2] = this.z + rz * ratio;
      }
    };
    for (const part of this.solid) {
      move(part.pos);
      this.levi.computeNormalsFrom(part, part.pos);   // 有旋轉 → 法線要重算
    }
    if (this.eyeL) move(this.eyeL);
    if (this.eyeR) move(this.eyeR);
    if (k >= 1) {
      // 吞完了：嘴邊爆餘燼 → 進入 5 秒重生倒數 → 利維坦累積進食數（人形化）
      const mx2 = this.x, my2 = this.y, mz2 = this.z;
      this.swallow = null;
      this.eaten = true;
      this.respawnT = 5;
      this.scaleK = 1;
      this.levi.spawnBurst(mx2, my2, mz2);
      this.levi.meals = (this.levi.meals || 0) + 1;
      // 進食後立刻講「解鎖了哪一段演化」
      const nm = (typeof stageName === "function")
        ? stageName(this.levi.meals) : "";
      huntMsg(`⚡ 整隻吞下！（第 ${this.levi.meals} 隻）→ 進化：${nm} —— 5 秒後重生`);
      // 吞完爆響；每次人形化 +1 再疊「身體重組＝扭塑膠＋嘶吼」
      if (window.SFX) {
        SFX.swallow();
        if (this.levi.meals >= 1) SFX.evolve();
      }
    }
  }

  // ===========================================================================
  // 每幀更新：漫遊方向 → 走/停 → 位移 → 步態跨步 → 重寫腿/觸鬚/硬殼頂點
  // ===========================================================================
  update(dt, t) {
    if (dt <= 0) return;   // 暫停時完全不動（渲染沿用上一幀姿態）
    // 被捕食了：消失倒數，時間到就在遠處重生
    if (this.eaten) {
      this.respawnT -= dt;
      if (this.respawnT <= 0) { this.eaten = false; this.resetPose(); }
      return;
    }
    // 被咬住了：改跑吞食動畫（整隻縮小吸進嘴裡），不再走路
    if (this.swallow) { this.updateSwallow(dt); return; }
    this.wt += dt;

    // ① 想去的方向 = 緩慢漂移的基底 + 兩道正弦（跟利維坦 roam 同一套，參數收小）
    this.baseDir += Math.sin(this.wt * 0.11) * dt * 0.25;
    let want = this.baseDir + Math.sin(this.wt * 0.23) * 0.9
             + Math.sin(this.wt * 0.51 + 1) * 0.4;

    // 被鎖定捕食時：轉頭狂奔（方向 = 離開利維坦），暫停行為全部取消
    //   多隻同伴：被追的那隻狂奔（2.15）；離掠食者近的同伴也跟著散開（1.7）
    const H = this.levi.hunt;
    const L = this.levi.pose;
    const dL = Math.hypot(L.x - this.x, L.y - this.y);
    const hunted = !!(H && H.active && H.walker === this);
    const scatter = !!(H && H.active) && !hunted && dL < 10;
    const flee = hunted || scatter;
    if (flee) {
      want = Math.atan2(-(L.x - this.x), (L.y - this.y));
      this.paused = false;
    }

    // ② 走走停停：停下來「聞一聞」再繼續（逃跑時不休息）
    if (!flee) {
      this.pauseT -= dt;
      if (this.pauseT <= 0) {
        this.paused = !this.paused;
        this.pauseT = this.paused ? 1.2 + Math.random() * 2.5 : 4 + Math.random() * 7;
      }
    }
    const goal = this.paused ? 0
               : (hunted ? 2.15 : scatter ? 1.7 : 1.35);  // 目標速度（被追的飆最快）
    this.speed += Math.max(-2.2 * dt, Math.min(2.2 * dt, goal - this.speed));

    // ③ 出界拉回 + 枯樹/礁岩避開（obstacles 由利維坦共用）
    const R = Math.hypot(this.x, this.y);
    if (R > 22) {
      const toC = Math.atan2(this.x / R, -this.y / R);       // 朝中心的 heading
      want += this.wrapPi(toC - want) * Math.min(1, (R - 22) / 6);
    }
    for (const o of this.levi.obstacles) {
      const dx = this.x - o.x, dy = this.y - o.y;
      const d = Math.hypot(dx, dy), clear = o.r + 1.8;
      if (d < clear && d > 1e-4) {
        const away = Math.atan2(-dx / d, dy / d);            // 離開障礙的 heading
        want += this.wrapPi(away - want) * Math.min(1, (clear - d) / 1.8) * 0.95;
      }
    }
    // ③b 同伴保持距離：太靠近就側身讓開（三隻地行獸不會疊在一起）
    for (const o of (this.levi.walkers || [])) {
      if (o === this || o.eaten || o.swallow) continue;
      const dx = this.x - o.x, dy = this.y - o.y;
      const d = Math.hypot(dx, dy), clear = 2.2;
      if (d < clear && d > 1e-4) {
        const away = Math.atan2(-dx / d, dy / d);
        want += this.wrapPi(away - want) * Math.min(1, (clear - d) / 2.2) * 0.9;
      }
    }

    // ④ 限制轉速地轉過去
    const dth = this.wrapPi(want - this.heading);
    const maxTurn = (hunted ? 2.0 : flee ? 1.5 : 1.1) * dt;   // 逃跑急轉彎
    this.heading += Math.max(-maxTurn, Math.min(maxTurn, dth));

    // ⑤ 前進（forward = (-sin h, cos h)，跟利維坦同一慣例）
    this.x -= Math.sin(this.heading) * this.speed * dt;
    this.y += Math.cos(this.heading) * this.speed * dt;
    // ⑤b 硬推開（穿石修正）：③ 的轉向迴避只是「想繞開」——轉不開時照樣會蹭進石頭 →
    //     位置直接推回圓柱外（地行獸貼地走，不需要垂直閘門）
    for (const o of this.levi.obstacles) {
      const dx = this.x - o.x, dy = this.y - o.y;
      const d = Math.hypot(dx, dy);
      const minD = o.r + 0.7;                          // 地行獸身體半徑 ~0.7
      if (d < minD) {
        if (d < 1e-5) this.x += minD;
        else { const t = minD / d; this.x = o.x + dx * t; this.y = o.y + dy * t; }
      }
    }

    // ⑥ 身體高度：貼著起伏地面 + 步態顛動（每步兩顛）+ 呼吸微起伏
    this.cos = Math.cos(this.heading); this.sin = Math.sin(this.heading);
    this.z = this.levi.floorZ(this.x, this.y) + 0.56
           + Math.sin(this.step * 6.283) * 0.025 + Math.sin(t * 1.3) * 0.012;

    // ⑦ 交替三角步態：步相隨速度前進；跨步時起弧插值、踩地時釘住不動
    this.step += dt * this.speed * 0.85;
    for (const leg of this.legs) {
      const phi = (this.step + leg.off) % 1;
      const swing = this.speed > 0.05 && phi < 0.5;
      const hip = this.toWorld(leg.hip[0], leg.hip[1], leg.hip[2]);
      // 落腳點 = HOME 轉世界 + 沿前進方向前瞻一點（走得越快跨越遠）
      const home = this.toWorld(leg.home[0], leg.home[1], leg.home[2]);
      const lead = this.speed * 0.30;
      home[0] -= this.sin * lead;
      home[1] += this.cos * lead;
      home[2] = this.levi.floorZ(home[0], home[1]) + 0.02;

      if (swing && !leg.swinging) {                          // 開始跨步
        leg.swinging = true;
        leg.s0 = [leg.f[0], leg.f[1], leg.f[2]];
        leg.s1 = home;
      } else if (!swing && leg.swinging) {                   // 落地：就地踩下（不瞬移）
        leg.swinging = false;
        leg.f[2] = this.levi.floorZ(leg.f[0], leg.f[1]) + 0.02;
      } else if (swing && leg.swinging) {                    // 跨步中
        const k = phi / 0.5;
        leg.f[0] = leg.s0[0] + (leg.s1[0] - leg.s0[0]) * k;
        leg.f[1] = leg.s0[1] + (leg.s1[1] - leg.s0[1]) * k;
        leg.f[2] = leg.s0[2] + (leg.s1[2] - leg.s0[2]) * k
                 + Math.sin(k * Math.PI) * (flee ? 0.36 : 0.26);   // 起弧抬腳（逃跑跨大步）
      }
      // 安全閘：身體扭太開、腳被拉快直了 → 強制跨一步回 HOME
      if (!leg.swinging &&
          Math.hypot(leg.f[0] - hip[0], leg.f[1] - hip[1]) > 0.95) {
        leg.swinging = true;
        leg.s0 = [leg.f[0], leg.f[1], leg.f[2]];
        leg.s1 = home;
      }

      // 重寫腿管子：髖 → 拱起的膝 → 腳（蜘蛛式折腿）
      const knee = [
        (hip[0] + leg.f[0]) / 2 + this.cos * leg.side * 0.12,
        (hip[1] + leg.f[1]) / 2 + this.sin * leg.side * 0.12,
        (hip[2] + leg.f[2]) / 2 + 0.30,
      ];
      this.writeTube(leg.part.pos, [
        hip,
        [(hip[0] + knee[0]) / 2, (hip[1] + knee[1]) / 2, (hip[2] + knee[2]) / 2 + 0.04],
        knee,
        [(knee[0] + leg.f[0]) / 2, (knee[1] + leg.f[1]) / 2, (knee[2] + leg.f[2]) / 2 - 0.02],
        leg.f,
      ], 0.13, 0.045, 5);
      this.levi.computeNormalsFrom(leg.part, leg.part.pos);
    }

    // ⑧ 觸鬚：跟著頭轉，尖端隨風微擺（聞空氣的感覺）
    for (const a of this.ants) {
      const pts = [];
      for (let i = 0; i < a.local.length; i++) {
        const L = a.local[i], wgt = i / (a.local.length - 1);
        const pt = this.toWorld(L[0], L[1], L[2]);
        pt[0] += Math.cos(t * 1.6 + a.ph) * 0.09 * wgt * wgt;
        pt[1] += Math.sin(t * 1.3 + a.ph) * 0.07 * wgt * wgt;
        pt[2] += Math.sin(t * 1.9 + a.ph * 2) * 0.05 * wgt * wgt;
        pts.push(pt);
      }
      this.writeTube(a.part.pos, pts, 0.045, 0.012, 4);
      this.levi.computeNormalsFrom(a.part, a.part.pos);
    }

    // ⑨ 硬殼/頭/尾刺：局部 → 世界（剛體旋轉 + 平移；wpos 別名 pos → 直接寫）
    for (const part of this.hard) {
      const { base, pos } = part;
      for (let i = 0; i < base.length; i += 3) {
        const lx = base[i], ly = base[i + 1], lz = base[i + 2];
        pos[i]     = this.x + lx * this.cos - ly * this.sin;
        pos[i + 1] = this.y + lx * this.sin + ly * this.cos;
        pos[i + 2] = this.z + lz;
      }
      this.levi.computeNormalsFrom(part, pos);
    }

    // ⑩ 雙眼世界座標（render 裡畫成朝向鏡頭的琥珀色微光）
    this.eyeL = this.toWorld(-0.20, 1.50, 0.30);
    this.eyeR = this.toWorld(0.20, 1.50, 0.30);
  }

  // ===========================================================================
  // 繪製：由 leviathan.js 的 render() 在正確的階段呼叫
  //   着色模式 → shader 還綁著（同套光照/霧）；線框模式 → 延續同組筆觸
  // ===========================================================================
  drawSolid(p) { this.levi.drawParts(p, this.solid); }
  drawWire(p) { this.levi.drawEdges(p, this.edges); }

  // 琥珀色雙眼：柔邊光點（中心亮→邊緣透明，跟海洋雪同招）——
  //   舊版是硬邊小方塊，遠看像浮在頭邊的「黃色便利貼」
  drawEyes(p, t) {
    if (!this.eyeL) return;                      // 還沒跑過 update（保險閘）
    const pulse = 0.6 + 0.4 * Math.sin(t * 2.2);
    const a = 235 * (0.75 + 0.25 * pulse);       // 中心 alpha（脈動呼吸）
    p.noStroke();
    const cam = this.levi.camEye;
    for (const E of [this.eyeL, this.eyeR]) {
      let dx = cam[0] - E[0], dy = cam[1] - E[1], dz = cam[2] - E[2];
      const dl = Math.hypot(dx, dy, dz) || 1; dx /= dl; dy /= dl; dz /= dl;
      let rx = dy, ry = -dx, rz = 0;                         // dir × 世界up(0,0,1)
      const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl;
      const ux = ry * dz, uy = -rx * dz,                     // right × dir
                uz = rx * dy - ry * dx;
      const s = 0.13 * (this.scaleK || 1);       // 光暈半徑（比舊方塊大一圈，但邊緣透明）
      p.beginShape(p.TRIANGLE_FAN);
      p.fill(255, 200 + 55 * pulse, 90, a);                 // 中心：亮核
      p.vertex(E[0], E[1], E[2]);
      const N = 10;
      for (let i = 0; i <= N; i++) {
        const ang = (i / N) * Math.PI * 2;
        const cs = Math.cos(ang) * s, sn = Math.sin(ang) * s;
        p.fill(255, 140 + 70 * pulse, 45, 0);               // 邊緣：透明 → 柔暈
        p.vertex(E[0] + rx * cs + ux * sn,
                 E[1] + ry * cs + uy * sn,
                 E[2] + rz * cs + uz * sn);
      }
      p.endShape();
    }
  }
}
