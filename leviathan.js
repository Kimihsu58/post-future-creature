// ============================================================================
// leviathan.js — 深海圖靈利維坦：模型容器 + 游動動畫 + 着色
// ----------------------------------------------------------------------------
// 模型資料來自 Blender（data/leviathan.js，window.LEVIATAN，原始 7 部件）：
//   torso（軀幹） belly（腹膜） eyes（複眼） —— 採用
//   horn_base/mid/tip（角冠） antenna（羽鬚） —— 已依需求刪除，載入時丟棄
// 另在 JS 端程序化建立觸手 ×16（buildTentacles）與環境物件（海床/礁岩/枯樹/…）。
// 每幀：把「基礎頂點」按物理規則位移 → 「動畫頂點」，再丟給 WEBGL 畫。
// ============================================================================

const LEVI_BUILD = "human53";   // 腳本版本（與 index.html 的 BUILD_TAG 比對 → HUD 徽章防舊快取）

// ---------------------------------------------------------------------------
// GLSL 着色器：有機深海皮層 / 純生物發光 都靠它
//   - 漫射光（固定方向的深海頂光）
//   - 菲涅爾邊緣光（生物螢光的青色輪廓）
//   - 假次表面散射（背光處透出的暖洋紅）
// ---------------------------------------------------------------------------
const LEVI_VERT = `
attribute vec3 aPosition;
attribute vec3 aNormal;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;
varying vec3 vN;      // 世界空間法線（模型不整體旋轉 → 直接用 aNormal）
varying vec3 vP;      // 世界空間位置
void main() {
  vP = aPosition;
  vN = aNormal;
  gl_Position = uProjectionMatrix * uModelViewMatrix * vec4(aPosition, 1.0);
}`;

const LEVI_FRAG = `
precision highp float;
varying vec3 vN;
varying vec3 vP;
uniform vec4 uMaterialColor;   // p5 自動把 fill() 的顏色塞進來
uniform float uBio;            // 生物螢光亮度 0~2
uniform float uMode;           // 0 = 有機皮層 / 1 = 純發光
uniform float uRim;            // 螢光邊強度（環境物件調低，避免海床整片發亮）
uniform vec3 uCamEye;          // 攝影機世界座標（算視線用）
uniform vec3 uFogColor;        // 環境底色（遠處霧化的目標色，= background）
uniform vec3 uAmb;             // 環境光（深海=灰 / 逆世界=暗紫紅）
uniform vec3 uTopColor;        // 頂光顏色（深海=白 / 逆世界=風暴暗紅）
uniform float uFlash;          // 怪奇物語式紅色閃電片光 0~1
uniform float uBump;           // 微觀凹凸強度（表面「材質顆粒」感，0=塑膠般光滑）
uniform float uSpec;           // 高光強度（濕潤表皮的反光斑）
uniform float uShine;          // 高光銳度（大=小而亮的濕點、小=大而柔的光澤）
uniform float uAO;             // 假環境光遮蔽強度（朝下的面變深 → 貼地感）
uniform float uFFlip;          // framebuffer 內渲染時投影會上下翻轉（繞序跟著反）→ gl_FrontFacing 判斷要對調
uniform float uAlien;          // 人形化程度 0~1（每吞一隻地行獸累積）→ 蒼白人膚 + 黑紅血管皺褶（威可那）
uniform float uMottle;         // 環境地表大尺度色斑 0/1（只給海床/紅土開 → 斑駁更寫實）
uniform float uFogStart;       // 距離霧起始距離（環境近起 → 景深；生物晚起 → 主體清楚）
uniform float uFogDens;        // 距離霧密度（越大越快融進地平霾）
uniform float uCrack;          // 逆世界乾裂地縫的餘燼微光 0/1（只開地面群組）
uniform float uT;              // 時間（裂縫餘燼呼吸用）
uniform float uMat;            // 材質：0=無 1=岩 2=樹皮 3=泥土 4=藤蔓 5=皮膚 6=甲殼 → 各自的紋理
uniform vec3 uTexOrg;          // 物件空間原點（紋理「黏」在物件上，移動時不游泳；0=靜態環境）
uniform float uTexYaw;         // 物件朝向繞 Z 弧度（0 → 物件空間＝世界空間）

// ---- 程序化材質用的 3D 值噪聲（不需要貼圖，純數學）----
float h31(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vn(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);                 // 平滑插值
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x),
                 mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x),
                 mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
}

// ---- 多倍頻 fbm / ridged：單倍頻噪声太糊，真材質要有粗有細 ----
float fbm3(vec3 p) {                              // 3 倍頻（粗+中+細）
  float s = 0.500 * vn(p);
  s += 0.250 * vn(p * 2.03 + 11.3);
  s += 0.125 * vn(p * 4.11 + 23.7);
  return s * 1.143;                               // 權重和 0.875 → 歸一到 ~0..1
}
float fbm4(vec3 p) {                              // 4 倍頻（岩塊面用，細節再多一層）
  float s = 0.500 * vn(p);
  s += 0.250 * vn(p * 2.03 + 11.3);
  s += 0.125 * vn(p * 4.11 + 23.7);
  s += 0.0625 * vn(p * 8.29 + 41.1);
  return s * 1.0667;                              // 權重和 0.9375
}
float ridge3(vec3 p) {                            // 山脊線：峰在 n=0.5 → 連成「線狀裂縫網」
  float s = 0.55 * (1.0 - abs(2.0 * vn(p) - 1.0));
  s += 0.30 * (1.0 - abs(2.0 * vn(p * 2.13 + 7.7) - 1.0));
  s += 0.15 * (1.0 - abs(2.0 * vn(p * 4.41 + 19.1) - 1.0));
  return s;
}

// 各材質的「微觀地形」高度場（給法線擾動 → 光打上去有真的凹凸起伏）
float matH(vec3 p) {
  if (uMat > 5.5) {                                                    // 甲殼：板節帶起伏 + 幾丁質顆粒
    return fbm3(p * 6.0) * 0.55 + (0.5 + 0.5 * sin(p.y * 9.0)) * 0.45;
  }
  if (uMat > 4.5) return fbm3(p * 7.5) * 0.55 + vn(p * 19.0) * 0.45;   // 皮膚：細皺 + 毛孔顆粒
  if (uMat > 3.5) return fbm3(p * 3.6);                                // 藤蔓：皺皮斑塊
  if (uMat > 2.5) return fbm3(p * 3.0) * 0.65 + vn(p * 12.0) * 0.35;   // 泥土：團粒 + 細砂
  if (uMat > 1.5) {                                                    // 樹皮：縱向溝紋（xy 高頻、z 低頻 → 條紋沿樹幹直走）
    vec3 q = vec3(p.x * 5.2, p.y * 5.2, p.z * 1.15);
    return vn(q) * 0.72 + vn(q * 2.6 + 5.0) * 0.28;
  }
  if (uMat > 0.5) return fbm4(p * 1.55) * 0.68 + ridge3(p * 4.6) * 0.32;  // 岩：塊面 + 碎裂
  return vn(p * 2.1);                                                  // 預設：跟舊版一模一樣（身體皮膚不變）
}

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamEye - vP);         // 指向攝影機
  float dist = length(uCamEye - vP);        // 距離（霧 / 裂縫淡出共用）
  // ---- 物件空間紋理座標 tp：把世界座標轉回「物件自己的方向」→ 紋理黏在表面 ----
  //（uTexOrg/uTexYaw = 0 時 tp ≡ vP → 靜態環境行為完全不變）
  vec3 dv = vP - uTexOrg;
  float cty = cos(uTexYaw), sty = sin(uTexYaw);
  vec3 tp = vec3(dv.x * cty + dv.y * sty, -dv.x * sty + dv.y * cty, dv.z);
  // p5 用 CW 當正面（跟標準 GL 相反）→ 反過來判斷
  //（畫進 framebuffer 時 p5 的 framebuffer 相機會把投影上下翻轉 → 繞序反了 → 判斷要對調）
  if (gl_FrontFacing == (uFFlip < 0.5)) N = -N;
  vec3 Ltop = normalize(vec3(0.2, 0.32, 0.92));   // 世界空間「深海頂光」
  vec3 Lcam = normalize(V + vec3(0.0, 0.0, 0.45)); // 攝影機方向補光（探照燈）

  // ---- 微觀凹凸：材質高度場的梯度擾動法線 → 表面有顆粒/溝紋/皺褶，不再像光滑塑膠 ----
  //     離太遠會閃爍 → 依距離淡出
  float bumpFade = clamp(1.0 - length(uCamEye - vP) * 0.024, 0.0, 1.0);
  if (uMode < 0.5 && uBump > 0.0 && bumpFade > 0.01) {
    vec3 T = normalize(cross(N, abs(N.z) < 0.99 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0)));
    vec3 B = cross(N, T);
    float e = 0.09;
    float h0 = matH(tp);
    float hT = matH(tp + T * e);
    float hB = matH(tp + B * e);
    // 各材質凹凸強度（樹皮溝紋最立體、岩塊碎裂次之；預設 0.16 = 舊版身體皮膚）
    float bAmp = 0.16;
    if (uMat > 0.5 && uMat < 1.5) bAmp = 0.40;        // 岩：碎裂更深（0.32→0.40 近看更有浮雕感）
    else if (uMat > 1.5 && uMat < 2.5) bAmp = 0.40;   // 樹皮：溝紋立體
    else if (uMat > 2.5 && uMat < 3.5) bAmp = 0.32;   // 泥土：團粒起伏（0.26→0.32）
    else if (uMat > 3.5 && uMat < 4.5) bAmp = 0.30;   // 藤蔓：皺皮（0.24→0.30）
    else if (uMat > 4.5 && uMat < 5.5) bAmp = 0.26;   // 皮膚：毛孔細皺
    else if (uMat > 5.5) bAmp = 0.42;                 // 甲殼：板節立體
    N = normalize(N - (T * (hT - h0) + B * (hB - h0)) / e * uBump * bAmp * bumpFade);
  }

  float diff = max(dot(N, Ltop), 0.0);                    // 頂光漫射
  float fill = max(dot(N, Lcam), 0.0);                    // 補光漫射
  float fres = pow(1.0 - abs(dot(N, V)), 3.0);            // 菲涅爾邊緣
  float sss  = pow(max(dot(-N, Ltop), 0.0), 2.0);         // 背光透光(次表面)

  vec3 rim  = vec3(0.15, 0.95, 1.0);   // 電光青
  vec3 warm = vec3(1.0, 0.30, 0.52);   // 次表面暖洋紅
  vec3 base = uMaterialColor.rgb;
  // 顏色微變化：大尺度噪聲讓平面色不再死板（樹皮/沙地/皮層各自的斑駁）
  if (uMode < 0.5) base *= 0.90 + 0.20 * vn(tp * 0.55 + 13.7);
  // 環境地表斑駁（uMottle）：更大尺度的明暗 + 色相漂移 → 沙丘/紅土有大片色塊變化
  if (uMode < 0.5 && uMottle > 0.5) {
    float m1 = vn(tp * 0.09 + 71.0);          // 超大尺度（~10 單位色塊）
    float m2 = vn(tp * 0.33 + 37.0);          // 中尺度（~3 單位斑點）
    float m3 = vn(tp * 1.45 + 17.0);          // 細尺度（~0.7 單位顆粒）→ 近看有微紋理
    base *= 0.50 + 0.92 * m1;                 // 明暗差再拉大 → 近景地面大塊色斑看得見
    base = mix(base, base * vec3(1.24, 0.94, 0.76), m2 * 0.60 * (1.0 - uAlien * 0.75));   // 斑處偏暖（沙/鏽）；人形期淡出 → 均勻蒼白膚
    base *= 0.92 + 0.16 * m3;                 // 顆粒級微調 → 近看「細緻」不平
  }
  // ---- 材質紋理（uMat）：模擬現實材質的顏色紋理（岩理/樹皮溝紋/土壤團粒/藤蔓斑）----
  if (uMode < 0.5 && uMat > 0.5) {
    float close = clamp(1.0 - dist * 0.026, 0.0, 1.0);   // 高頻細節中距離就可見（遠了才淡出防閃）
    // ★超高頻（毛孔/晶點級）用更快的淡出：遠景看是「噪點」，近看才該開
    float closeH = clamp(1.0 - dist * 0.055, 0.0, 1.0);
    if (uMat < 1.5) {
      // ===== 岩石：大尺度色塊 + 中頻角狀稜面 + 裂縫網 + 礦物晶點（花崗/玄武岩感）=====
      float broad = fbm3(tp * 0.75 + 5.0);
      float macro = clamp(1.0 - dist * 0.16, 0.0, 1.0);  // ★只有貼到 6 單位內才算「極近」
      float bw = 0.82 - 0.45 * macro;                    // ★極近時壓低大尺度雲狀 → 雲狀佔滿畫面就是「軟糊」元凶
      float mid = ridge3(tp * 1.7 + 9.0);                // ★中頻山脊線＝角狀稜面（只有 fbm 會像雲一樣軟）
      float crack = smoothstep(0.64, 0.94, ridge3(tp * 2.6 + 17.0));   // 閾值放寬 → 裂縫網更清楚
      base *= (0.96 - bw * 0.5) + bw * broad;            // 明暗色塊（平均亮度恆 0.96，遠近一致）
      base *= 0.80 + 0.32 * mid;                         // ★角狀明暗層 → 近看是「岩石稜面」不是軟雲
      base = mix(base, base * vec3(1.12, 1.03, 0.88), smoothstep(0.55, 0.82, broad)); // 亮塊偏暖（石英/鏽斑）
      base *= 1.0 - 0.74 * crack;                        // 裂縫沉暗（有深度感）
      float speck = vn(tp * 26.0 + 61.0);                // 高頻礦物斑
      base += vec3(0.15, 0.145, 0.13) * step(0.968, speck) * closeH;  // 雲母/石英閃點（高頻 → 快速淡出）
      base *= 1.0 - 0.35 * step(speck, 0.030) * closeH;   // 黑色礦物斑點
      float grit = vn(tp * 44.0 + 23.0);                 // ★超細顆粒（近看砂紙感）
      base *= 0.86 + 0.30 * grit * closeH;               // ★幅度加大（0.14→0.30）→ 極近看得到砂粒
      float rough = fbm3(tp * 7.5 + 3.0);                // ★中高頻碎石面（0.08–0.3u 碎屑 → 極近看是「碎石脆面」不是軟雲）
      base *= 0.85 + 0.30 * rough;
    } else if (uMat < 2.5) {
      // ===== 樹皮：縱向溝紋（深溝暗、稜線風化偏灰白）+ 枯木深裂 =====
      vec3 q = vec3(tp.x * 4.6, tp.y * 4.6, tp.z * 1.05);
      float grooves = vn(q);                             // 頻率沿 z 拉長 → 直向紋
      float fine = vn(q * 3.1 + 9.0);
      float crackT = smoothstep(0.76, 0.98, ridge3(vec3(tp.x * 3.0, tp.y * 3.0, tp.z * 0.8) + 31.0));
      base *= 0.50 + 0.86 * grooves;                     // 溝紋明暗對比（拉大 → 遠一點也讀得到）
      base *= 0.84 + 0.30 * fine;                        // 細紋理
      base *= 1.0 - 0.55 * crackT;                       // 深裂（枯木開裂）
      base = mix(base, base * vec3(1.16, 1.07, 0.90), smoothstep(0.62, 0.88, grooves) * 0.55); // 稜線風化
    } else if (uMat < 3.5) {
      // ===== 泥土：團粒 + 細砂 + 嵌入的小礫石 =====
      float clump = fbm3(tp * 2.2 + 13.0);
      float sand = vn(tp * 17.0 + 3.0);
      float grit = vn(tp * 9.0 + 77.0);
      base *= 0.66 + 0.64 * clump;                       // 大小團粒（對比加大）
      base *= 0.88 + 0.26 * sand * close;                // 細砂粒（近看）
      base = mix(base, base * 1.40 + vec3(0.02), step(0.905, grit) * close * 0.8);  // 礫石微亮
    } else if (uMat < 4.5) {
      // ===== 藤蔓皮：深色斑塊（腐斑/苔斑）+ 細孔 =====
      float blotch = fbm3(tp * 2.8 + 27.0);
      float pores = vn(tp * 14.0 + 5.0);
      float fiber = vn(vec3(tp.x * 11.0, tp.y * 2.6, tp.z * 11.0) + 63.0);  // ★沿管走向纖維紋
      base *= 0.58 + 0.72 * blotch;                      // 斑塊對比拉大（0.66+0.58 → 軟陶感消除）
      base = mix(base, base * vec3(0.70, 0.60, 0.60), smoothstep(0.62, 0.9, blotch) * 0.7);
      base *= 0.90 + 0.20 * pores * close;
      base *= 0.92 + 0.16 * fiber * close;               // ★纖維細紋（藤蔓像肌束/繩不是軟陶）
    } else if (uMat < 5.5) {
      // ===== 生物皮膚：毛孔顆粒 + 細皺層 + 血色不均（近看像真皮膚而不是塑膠）=====
      float pore = vn(tp * 24.0 + 7.0);                 // 毛孔（高頻，近看才開）
      float micro = fbm3(tp * 9.0 + 61.0);              // 細皺（第二層皺褶）
      float tone = fbm3(tp * 1.7 + 88.0);               // 膚色斑塊（血色深淺不均）
      base *= 0.84 + 0.28 * micro;
      base *= 0.95 + 0.10 * pore * closeH;              // 毛孔高頻 → 快速淡出（遠看不再像噪點）
      base = mix(base, base * vec3(1.10, 0.90, 0.88), smoothstep(0.55, 0.82, tone) * 0.68);  // 斑處偏血紅
      base = mix(base, base * vec3(0.86, 0.92, 0.97), smoothstep(0.55, 0.82, 1.0 - tone) * 0.40); // 淺斑處偏青冷
    } else {
      // ===== 甲殼（地行獸）：橫向板節帶 + 幾丁質顆粒 + 縱向刮痕 =====
      float plate = 0.5 + 0.5 * sin(tp.y * 9.0);        // 板節（物件空間 Y＝身體長軸 → 一節一節）
      float seam = smoothstep(0.84, 1.0, plate);        // 板節接縫（暗線）
      float chitin = fbm3(tp * 6.5 + 43.0);             // 幾丁質顆粒
      float scratch = ridge3(vec3(tp.x * 9.0, tp.y * 1.3, tp.z * 9.0) + 66.0);  // 沿身體拉長的刮痕
      base *= 0.72 + 0.48 * chitin;
      base *= 0.90 + 0.14 * plate;                       // ★板節整體明暗（每節微差 → 立體分節讀得出來）
      base *= 1.0 - 0.64 * seam;                        // 接縫沉暗（立體分節）
      base *= 1.0 - 0.32 * smoothstep(0.80, 0.97, scratch) * close;  // 戰鬥刮痕（近看）
      base = mix(base, base * vec3(1.28, 1.14, 1.06), smoothstep(0.55, 0.88, chitin) * 0.45);  // 硬殼亮斑
    }
  }
  // 人形化皮膚（uAlien）：威可那式 —— 蒼白人膚 + 黑紅血管網 + 高頻皺褶
  float veinGlow = 0.0;                      // 血管發光量（稍後疊進最終顏色）
  if (uAlien > 0.001) {
    vec3 pallid = vec3(0.71, 0.66, 0.63);    // 蒼白灰粉人膚（偏灰 → 像屍皮而不是生肉）
    float wrinkle = vn(tp * 5.5 + 23.0);     // 高頻皺褶（人皮鬆皺感）
    float vein = smoothstep(0.58, 0.86, vn(tp * 2.8 + 51.0));  // 血管網（清楚一點）
    float pore2 = vn(tp * 24.0 + 15.0);      // 毛孔（蒼白皮也要有皮膚顆粒）
    float blot2 = fbm3(tp * 1.9 + 95.0);     // 血色斑（屍斑式深淺不均）
    base = mix(base, pallid * (0.70 + 0.44 * wrinkle), uAlien * 0.92);  // 蒼白膚 + 皺褶明暗
    base *= 1.0 - 0.10 * pore2 * uAlien;     // 毛孔壓暗顆粒
    base = mix(base, base * vec3(1.05, 0.88, 0.87), smoothstep(0.58, 0.85, blot2) * 0.5 * uAlien);  // 紅斑沉澱
    base = mix(base, vec3(0.22, 0.03, 0.05), vein * uAlien * 0.90);     // 黑紅血管沉進皮膚
    rim = mix(rim, vec3(0.95, 0.82, 0.76), uAlien * 0.70);     // 邊光轉蒼白骨感
    warm = mix(warm, vec3(0.55, 0.10, 0.12), uAlien * 0.70);   // 透光轉暗紅血色
    veinGlow = vein * uAlien * (0.35 + 0.45 * uBio);           // 血管微微暗紅發光
  }

  vec3 col;
  if (uMode > 0.5) {
    // 純生物發光：身體壓暗，只剩螢光輪廓 + 微弱透光
    col = base * 0.10
        + rim * fres * (0.9 + 1.4 * uBio) * uRim
        + warm * sss * 0.10 * uBio;
  } else {
    // 有機皮層：環境光 + 頂光（顏色依環境：深海=白、逆世界=風暴暗紅）
    //（螢光邊係數調柔：薄翼面在斜角會出現大片掠射區，太強會整片洗白）
    col = base * (uAmb + uTopColor * (0.82 * diff) + vec3(0.50) * fill)
        + warm * sss * 0.12
        + rim * fres * (0.32 + 0.55 * uBio) * uRim;

    // ---- 假 AO：朝下的面偏暗（腋下/貼地處自然變深 →「落地感」）----
    col *= mix(1.0, 0.55 + 0.45 * (0.5 + 0.5 * N.z), uAO);
    // ---- Blinn-Phong 高光：頂光 + 補光各一盞 → 濕潤有機表皮的反光 ----
    vec3 H1 = normalize(Ltop + V);
    vec3 H2 = normalize(Lcam + V);
    float sp = pow(max(dot(N, H1), 0.0), uShine) * 0.8
             + pow(max(dot(N, H2), 0.0), uShine * 0.6) * 0.5;
    col += uTopColor * sp * uSpec;
  }

  // ---- 乾裂地縫的餘燼微光（只開逆世界地面 uCrack=1）：細縫透紅熱、緩慢呼吸 ----
  if (uCrack > 0.5 && uMode < 0.5) {
    float cr = 1.0 - abs(vn(vP * 1.55 + 91.0) * 2.0 - 1.0);   // ridged noise → 細密裂縫網（頻率調高）
    cr = smoothstep(0.93, 0.998, cr);                         // 髮絲級細縫（更細緻）
    cr *= smoothstep(0.42, 0.62, vn(vP * 0.48 + 55.0));       // 斷續：只在部分區塊亮
    float breathe = 0.70 + 0.30 * sin(uT * 1.2 + vP.x * 0.21 + vP.y * 0.17);  // 餘燼呼吸
    float nearFade = clamp(1.0 - dist * 0.030, 0.0, 1.0);     // 只在近中景透光（遠了細線會閃）
    col += vec3(1.0, 0.34, 0.09) * cr * breathe * nearFade * 0.34;
  }

  // ---- 人形化血管：黑紅細紋微微發光（疊在着色結果上）----
  col += vec3(0.55, 0.07, 0.10) * veinGlow * 0.50;

  // ---- 怪奇物語式紅色片光：閃電瞬間替所有表面加一層紅光（掠射面最亮）----
  col += vec3(1.0, 0.28, 0.20) * uFlash * (0.10 + 0.90 * fres);

  // ---- 距離霧：起點/密度每群組各一組（環境早起濃 → 景深；生物晚起 → 主體清楚）----
  float fog = clamp(1.0 - exp(-max(dist - uFogStart, 0.0) * uFogDens), 0.0, 0.94);
  col = mix(col, uFogColor, fog);

  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------
// 環境配色：background() 與霧色共用同一份資料（閃電時兩者要一起紅移）
//   bg / glowBg：一般皮層與純發光模式的背景底色（0~255）
//   amb / top：着色器的環境光與頂光顏色（0~1）
//   ash：飄落粒子（海洋雪 / 灰燼）的基色
// ---------------------------------------------------------------------------
const ENV_PALETTE = {
  sea: { bg: [4, 11, 24], glowBg: [2, 4, 9], haze: [8, 18, 34],
         amb: [0.16, 0.16, 0.16], top: [1.0, 1.0, 1.0], ash: [150, 205, 230] },
  up:  { bg: [9, 4, 8],  glowBg: [4, 2, 4],  haze: [26, 10, 11],
         amb: [0.10, 0.07, 0.08], top: [1.0, 0.45, 0.36], ash: [155, 143, 136] },
};

// 某環境目前的背景/霧色（0~255）；閃電 flash(0~1) 會把它瞬間紅移
function envFogRGB(envName, glow, flash) {
  const pal = ENV_PALETTE[envName] || ENV_PALETTE.sea;
  const c = glow ? pal.glowBg : pal.bg;
  if (flash <= 0) return c.slice();
  const k = flash * 0.55;
  return [c[0] + (95 - c[0]) * k, c[1] + (16 - c[1]) * k, c[2] + (18 - c[2]) * k];
}

// 霧的目標色「地平霾」：比 bg 稍亮、帶環境色 → 遠景融進大氣而不是純黑（景深關鍵）
function envHazeRGB(envName, glow, flash) {
  const pal = ENV_PALETTE[envName] || ENV_PALETTE.sea;
  const c = glow ? pal.haze.map(v => v * 0.45) : pal.haze;
  if (flash <= 0) return c.slice();
  const k = flash * 0.55;
  return [c[0] + (95 - c[0]) * k, c[1] + (16 - c[1]) * k, c[2] + (18 - c[2]) * k];
}

// 霧色/背景/頂光已全部收進上面的 ENV_PALETTE + envFogRGB（兩種環境共用）

// 關掉自訂 shader、回到 p5 預設（p5 的函式叫 resetShader，不是 noShader）
function shaderOff(p) {
  if (typeof p.resetShader === "function") p.resetShader();
  else if (typeof p5 !== "undefined" && p5.instance) p5.instance.resetShader();
}

// 部位配色（RGB 0~255）
const PART_COLORS = {
  torso:     [56, 82, 138],    // 深海靛藍
  belly:     [78, 68, 112],    // 淡紫灰膜
  //（horn_base/mid/tip 角冠與 antenna 羽鬚 —— 已依需求刪除，不再建構）
  eyes:      [80, 240, 255],   // 電光青
};


class Leviathan {
  constructor(data) {
    // ---- 把 JSON 資料拆成每個部件的 typed array ----
    //（角冠 horn_* 與羽鬚 antenna = 頭頂的怪東西，已依需求刪除 → 載入時直接丟棄）
    this.parts = [];
    for (const p of data.parts) {
      if (p.id.startsWith("horn") || p.id === "antenna") continue;
      const base = new Float32Array(p.vertices);           // 原始座標
      const pos = new Float32Array(base);                  // 每幀改寫的動畫座標
      const faces = new Uint32Array(p.faces);
      const part = {
        id: p.id,
        world: false,        // 模型部件跟著生物姿態動
        base, pos, faces,
        normals: new Float32Array(base.length),
        // 世界座標版（每幀渲染前由姿態矩陣換算；着色器的光/霧都吃世界座標）
        wpos: new Float32Array(base.length),
        wnorm: new Float32Array(base.length),
        color: PART_COLORS[p.id] || [160, 160, 160],
      };
      this.computeNormals(part);
      this.parts.push(part);
      this[p.id] = part;                                   // this.torso / this.belly ...
    }

    // ---- 程序化觸手：取代角冠/羽鬚（16 條；拓撲先建、位置每幀重算） ----
    this.buildTentacles();
    this.buildBackTents();       // 人形完成體的「背觸手」（⑤h 每幀驅動）

    // ---- 腹膜 Voronoi 細胞中心（u,v 平面 + 每顆自己的相位） ----
    this.bellyCells = [];
    let seed = 7;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 10; i++) {
      this.bellyCells.push({
        u: (rnd() * 2 - 1) * 0.85,
        v: (rnd() * 2 - 1) * 0.85,
        ph: rnd() * 6.28,
      });
    }

    // ---- 深海 / 逆世界環境（世界座標，不隨生物動） ----
    this.obstacles = [];      // 迴避用：礁岩 / 枯樹 / 巨影的腳
    this.trees = [];
    this.shadows = [];        // 接地陰影的投射物清單（樹/巖/巨影 → 暗斑）
    this.bolt = null;         // 目前這道閃電的折線頂點（每次打閃重建）
    this.prevFlash = 0;       // 上一幀的閃電亮度（偵測「亮起瞬間」）
    this.buildEyeGroups();    // 複眼球體分組（抽象模式下各自脫離漂浮）
    this.buildSeabed();
    this.buildRocks();
    this.buildTrees();
    this.buildVines();
    for (const pt of this.parts) if (pt.id.startsWith("vine"))   // 藤蔓：整條微微蠕動
      pt.sway = { gz: 0, h: 0, ph: Math.random() * 6.28, amp: 0.05 };
    this.buildLitter();   // 紅土碎屑斑塊
    this.buildPebbles();  // 地表碎石/貝殼殘骸（兩種環境共用 → 地面不再空蕩）
    this.buildBones();    // 獵物骨骸堆（吃剩的殘渣 → 生存痕跡）
    this.buildPods();     // 地面孢子囊光點（逆世界蒼白青綠微光，緩慢呼吸）
    this.buildColossus();
    this.buildRidge();    // 遠景山脊剪影（地平線不再是一條平線）
    this.buildSnow();
    this.buildShards();       // ← 這是身體部件（跟著姿態），但一樣在這裡建
    this.buildAlienSpines();  // ← 異形背棘（每吞一隻長一批； meals=0 時縮著不畫）
    this.buildAlienFace();    // ← 異形人臉：眉脊/鼻梁 + 眼窩/嘴縫（威可那人形化）
    this.buildAlienHands();   // ← 異形人手：前臂 + 手掌 + 五指（越吃越像人）
    this.buildHumanHead();    // ← 人形部件：頸 + 蛋形頭（Ⅱ 隻解鎖）
    this.buildGills();        // ← 頸部鰓裂 ×3/側（深海生物細節；跟著頭部一起長）
    this.buildHumanLimbs();   // ← 人形部件：雙腿 大腿/小腿/腳掌（Ⅳ 隻解鎖）
    this.buildHumanTorso();   // ← 全新人形躯幹（Ⅵ 隻「蛻皮」接班：乾淨拓撲、不帶蝠翼頂點）
    this.buildHairTents();    // ← 觸鬚頭髮：頭頂一圈圈觸手當「髮」（光頭蛋 → 觸手髮雕塑）

    // ---- 進食累積：每吞一隻地行獸 +1 → 人形化程度（威可那式，0~6 封頂） ----
    this.meals = 0;
    // 階段式人形化各部件的生長量（每幀由 humanStage() 更新；render 也會讀）
    this.human = { M: 0, hT: 0, hHd: 0, hAr: 0, hLg: 0, hEy: 0, hFa: 0, hPost: 0, walkK: 0 };
    this.walkPhase = 0;       // 步行週期相位（Ⅵ 隻開始走路時累加）
    this.gSpeed = 1.3;        // 平滑過的地面速度（步頻跟它連動 → 腳掌不打滑）

    // ---- 分組：身體（跟姿態） vs 環境（世界固定） ----
    this.worldParts = this.parts.filter(pt => pt.world);
    this.bodySolid = this.parts.filter(pt => !pt.world && pt.id !== "eyes");
    this.bodySolidNoShards = this.bodySolid.filter(pt => pt.id !== "shards");
    // 眼窩/嘴縫/鰓裂/角質爪必須維持近黑 → 從「會被 uAlien 染成蒼白」的皮膚群組排除（之後單獨畫）
    this.bodySolidSkin = this.bodySolid.filter(pt => pt.id !== "faceHoles" && pt.id !== "gills" && pt.id !== "claws");
    this.bodySolidNoShardsSkin = this.bodySolidNoShards.filter(pt => pt.id !== "faceHoles" && pt.id !== "gills" && pt.id !== "claws");

    // ---- 線框模式用的邊（身體 / 環境各一份，去重後的唯一邊） ----
    const [edgesBody, edgesWorld] = this.buildEdges();
    this.edgesBody = edgesBody;
    this.edgesWorld = edgesWorld;

    // ---- 漫遊狀態（世界位置 + 朝向） ----
    this.resetPose();
    this.env = "up";          // 預設環境：逆世界（怪奇物語）
    this.flash = 0;           // 閃電亮度（sketch.js 每幀寫入）
    this.setEnv("up");        // 依環境挑要畫的物件/線框 + 配色

    this.shader = null;   // 由 sketch.js 建好後掛上來
    this.fbMode = false;  // true = 正畫進 framebuffer（繞序會反 → shader 內 gl_FrontFacing 判斷要對調）
    this.camEye = [10, 8, 6];   // 攝影機世界座標（每幀由 applyCamera 更新）
    this.camTarget = [0, 0, -3.9];   // 相機看著的點（海雪公告牌用）
    this.camDist = 9.5;        // 攝影機到目標的距離（線寬換算用）
  }

  // 攝影機每幀更新：eye = 眼睛座標、tgt = 看向的點
  setCamEye(x, y, z, tx, ty, tz) {
    this.camEye = [x, y, z];
    this.camTarget = [tx, ty, tz];
    // p5 WEBGL 的線寬是「世界單位」→ 要依相機距離換算才能維持穩定像素寬
    this.camDist = Math.hypot(x - tx, y - ty, z - tz);
  }

  // -------------------------------------------------------------------------
  // 由三角面算平滑法線（每個頂點 = 相鄰面法線的平均）
  //   computeNormals(part) → 讀 base（建模時）
  //   computeNormalsFrom(part, src) → 讀指定座標列（抽象形變後讀 pos）
  // -------------------------------------------------------------------------
  computeNormals(part) {
    this.computeNormalsFrom(part, part.base);
  }

  computeNormalsFrom(part, src) {
    const { faces, normals } = part;
    normals.fill(0);
    for (let i = 0; i < faces.length; i += 3) {
      const a = faces[i] * 3, b = faces[i + 1] * 3, c = faces[i + 2] * 3;
      const abx = src[b] - src[a], aby = src[b + 1] - src[a + 1], abz = src[b + 2] - src[a + 2];
      const acx = src[c] - src[a], acy = src[c + 1] - src[a + 1], acz = src[c + 2] - src[a + 2];
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      for (const v of [a, b, c]) {        // 法線累加到三個頂點
        normals[v] += nx; normals[v + 1] += ny; normals[v + 2] += nz;
      }
    }
    for (let i = 0; i < normals.length; i += 3) {
      const l = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
      normals[i] /= l; normals[i + 1] /= l; normals[i + 2] /= l;
    }
  }

  // -------------------------------------------------------------------------
  // 線框模式的唯一邊（三角形三邊去重）→ 回傳 [身體邊, 環境邊]
  // 鍵值含 part.id：避免不同部件的相同索引互相撞掉
  // -------------------------------------------------------------------------
  buildEdges() {
    const seen = new Set();
    const body = [], world = [];
    for (const part of this.parts) {
      const out = part.world ? world : body;
      const f = part.faces;
      for (let i = 0; i < f.length; i += 3) {
        const tri = [f[i], f[i + 1], f[i + 2]];
        for (let k = 0; k < 3; k++) {
          let a = tri[k], b = tri[(k + 1) % 3];
          if (a > b) { const t = a; a = b; b = t; }
          const key = part.id + "_" + a + "_" + b;
          if (!seen.has(key)) { seen.add(key); out.push(part, a, b); }
        }
      }
    }
    return [body, world];   // 扁平三元組：part, idxA, idxB
  }

  // ==========================================================================
  // 每幀動畫：依物理規則位移頂點
  //   params = {speed, spine, wing, belly, ant, bio}（px 單位 ÷100 → 模型單位）
  // ==========================================================================
  // ==========================================================================
  // 階段式「人形化」生長量：第 u 隻解鎖 → 解鎖當下就有 first 的量 → 第 6 隻長滿
  //   Ⅰ軀幹 / Ⅱ頭 / Ⅲ手臂 / Ⅳ腿 / Ⅴ腿長滿站立 / Ⅵ開始用腳走路
  // ==========================================================================
  humanStage() {
    const M = Math.min(this.meals || 0, 6);
    const grow = (u, first) => M < u ? 0
      : Math.min(1, first + (1 - first) * (M - u) / (6 - u));
    return {
      M,
      hT:  grow(1, 0.45),     // Ⅰ 隻：蝠翼身站起來收成人形軀幹
      hHd: grow(2, 0.55),     // Ⅱ 隻：頸 + 蛋形頭 + 臉/眼球移到頭上
      hAr: grow(3, 0.50),     // Ⅲ 隻：手臂（肩 → 肘 → 腕 → 五指）
      hLg: grow(4, 0.50),     // Ⅳ 隻：雙腿（大腿 + 小腿 + 腳掌）
      hEy: M < 2 ? 0 : Math.min(1, 0.6 + 0.4 * (M - 2) / 4),  // 臉上半（眉脊/眼窩）Ⅱ 隻
      hFa: M < 3 ? 0 : Math.min(1, 0.5 + 0.5 * (M - 3) / 3),  // 臉下半（鼻/嘴/唇）Ⅲ 隻
      // ★「演化前傾」弧線（人類演化 march-of-progress）：Ⅰ 隻整身深彎 55°（猿人佝僂、
      //   頭放低在前下方）→ 每吃一隻逐漸挺直（2:44° 3:33° 4:22° 5:11°）→ 第 6 隻 0° 完全直立行走
      hPost: M < 1 ? 0 : Math.min(1, (6 - M) / 5),   // 1=最佝僂 0=挺直
      walkK: M >= 6 ? 1 : 0,  // Ⅵ 隻：開始用腳走路（步行週期 + 貼地 IK）
    };
  }

  update(params, t) {
    const spine = params.spine / 100, wing = params.wing / 100;
    const belAmp = params.belly / 100, tentAmp = params.tent / 100;
    const absA = (params.abs == null ? 75 : params.abs) / 100;   // 抽象形變強度 0~1

    // ---- 階段式人形化：先算各部件「目標」生長量（下面①~⑦ 都會用） ----
    // 牆上時間差先算（下面的「平滑長出來」要用）：上限 0.1 → 背景分頁回來也不會大跳
    const dtw = Math.min(0.1, Math.max(0, t - (this._lastT == null ? t : this._lastT)));
    this._lastT = t;
    // ★ 漸進變形：humanStage() 是「目標」（純 meals 函數、會瞬跳），現值每幀指數趨近它 →
    //   每吃一隻，部件用約 3 秒「長出來」而不是一幀啪上去（頭不再忽然多一顆）。
    //   rate=0.6 配合 simT 快進 1.9x → 牆上 τ≈0.9 秒（rate 小 = 慢、大 = 快）
    const tg = this.humanStage();
    const ea = 1 - Math.exp(-dtw * 0.6);          // τ_sim≈1.7 秒 → 牆上約 0.9 秒、~3 秒長完 95%
    for (const key of ["hT", "hHd", "hAr", "hLg", "hEy", "hFa", "hPost", "walkK"])
      this.human[key] += (tg[key] - this.human[key]) * ea;
    this.human.M = tg.M;
    const hT = this.human.hT;                    // 軀幹人形化程度 0~1（已平滑）
    // ★「有效抽象度」：抽象扭轉/呼吸/漂移隨人形化淡出（(1−hT)）→
    //   變形中途身體不再持續亂扭、碎片/眼球雲各漂各的（hT=1 → 0，人形完全穩定）
    const absEff = absA * (1 - hT);
    // ---- 「蛻皮」交叉淡變：第 6 隻（hT 滿）時蝠翼殘體縮沒、新人形躯幹 (~1秒) 長出 ----
    //   目標是階梯（只在第 6 隻觸發），每幀平滑趨近 → 有一段蛻皮過程而不是瞬跳
    const swT = hT >= 0.999 ? 1 : 0;
    // ★ 觸發瞬間先跳到 0.15（殘體立刻收薄 15% → 立刻躲在新軀幹輪廓裡面），再平滑爬到 1；
    //   配合 ⑤g 新軀幹「全尺寸直接呈現」→ 蛻皮全程外輪廓不縮小 = 沒有塌陷
    this._sw = (this._sw == null ? swT
      : Math.max(this._sw + (swT - this._sw) * 0.03, swT * 0.15));
    // 步行週期：速率跟「地面速度」連動 → 腳掌踩點不打滑
    if (this.human.walkK > 0) {
      // ⚠ 時鐘陷阱：walkPhase 用 simT 累加，但 simT = dt × speed（speed=1.9 → simT 跑得比
      //   牆上時間快 1.9 倍）。原式直接乘 gSpeed(牆上速度) → 步頻變 1.9 倍快（4.5 步/秒，
      //   狂踩），所以先把「牆上頻率」算好、再 ÷speed 換算成 simT 頻率。
      const ps = Math.max(0.01, (params && params.speed) || 1);
      const rateWall = Math.max(1.6, Math.min(9, this.gSpeed * Math.PI / 1.1));  // 牆上設計頻率
      this._wRate = rateWall / ps;                     // → simT 頻率（⑤e 算步長會用）
      this.walkPhase += dtw * this._wRate;
    }

    // ---------- ① 軀幹：脊椎波動（沿 Y 軸向後傳遞） + 蝠翼扇拍 ----------
    {
      const { base, pos } = this.torso;
      for (let i = 0; i < base.length; i += 3) {
        const x = base[i], y = base[i + 1], z = base[i + 2];
        // 越靠近尾巴，波幅越大（頭部相對穩定）
        const g = 0.30 + 0.70 * Math.min(1, Math.max(0, (0.8 - y) / 2.6));
        const wave = Math.sin(y * 1.15 - t * 2.0);
        let nx = x + Math.sin(y * 1.15 - t * 2.0 + 0.9) * spine * 0.22 * g;  // 側向 S 形
        let nz = z + wave * spine * g;                                        // 垂直波
        // 蝠翼扇拍：|x| 大的翼梢拍得最明顯
        const wt = Math.pow(Math.min(1, Math.max(0, (Math.abs(x) - 0.9) / 1.7)), 1.2);
        nz += Math.sin(t * 2.6) * wing * wt;
        // ===== Ⅰ 隻人形化：蝠翼身「站起來」→ 直立人形軀幹（臉朝 +Y、脊椎朝 +Z） =====
        if (hT > 0) {
          const y01 = Math.min(1, Math.max(0, (y + 4.0) / 6.3));   // 躯幹 y 實測 −4.0~2.3
          // ---- 人的軀幹輪廓（y01: 0=骨盆底 → 1=頸根；smoothstep 分段拼出人形曲線）----
          const ss = (a, b, v) => { const k = Math.min(1, Math.max(0, (v - a) / (b - a))); return k * k * (3 - 2 * k); };
          // 半寬：骨盆圓收 → 髖 → 腰細 → 胸 → 肩台（全身上最寬）→ 斜方肌下滑 → 頸
          const W = 0.34 + 0.18 * ss(0.02, 0.24, y01)      // 骨盆→髖
                          - 0.11 * ss(0.30, 0.46, y01)      // 髖→腰收細
                          + 0.15 * ss(0.50, 0.70, y01)      // 腰→胸脹
                          + 0.10 * ss(0.56, 0.74, y01)      // 胸→肩加寬（肩台）
                          - 0.50 * ss(0.84, 1.00, y01);     // 肩→頸（斜方肌）；頸端 0.16 跟頭部頸環 0.18 銜接
          // 半厚：骨盆 → 腰 → 胸 → 頸（頸端留厚一點，跟頭部頸環 0.18 銜接不露縫）
          const D = 0.20 + 0.07 * ss(0.02, 0.24, y01)
                         - 0.06 * ss(0.30, 0.46, y01)
                         + 0.10 * ss(0.50, 0.72, y01)
                         - 0.18 * ss(0.80, 0.98, y01);
          // ---- 橢圓橫截面：每個高度的截面 =「完美橢圓」（輪廓 W×D）→ 表面平滑規則 ----
          //   角度取自原本蝠翼截面（保留頂點分布）；原始凹凸「不保留」→ 消除疙瘩/棱線
          if (this._hm == null) {                    // 惰性量一次模型極值（只算一次）
            let xm = 0, zm = 0;
            for (let j = 0; j < base.length; j += 3) {
              const ax = Math.abs(base[j]), az = Math.abs(base[j + 2]);
              if (ax > xm) xm = ax;
              if (az > zm) zm = az;
            }
            this._hm = [xm || 2.44, zm || 0.15];
          }
          const xn = x / this._hm[0], zn = z / this._hm[1];
          const th = Math.atan2(zn, xn);              // 截面角度（保留原本頂點疏密）
          let tx = Math.cos(th) * W;                  // 左右寬
          let ty = Math.sin(th) * D;                  // 前後厚
          // 尾巴區（y01<0.06，蝠翼細尾）：收進體內 → 不在骨盆表面形成
          // 密集頂點斑塊（胯下的「菱形」就是尾巴環被吸附到表面造成的）
          if (y01 < 0.06) {
            const rf2 = 0.25 + 0.75 * (y01 / 0.06);
            tx *= rf2; ty *= rf2;
          }
          const tz = -0.9 + y01 * 2.6;                // 骨盆(−0.9) → 頸根(+1.7)（不動：頸/肩/臉錨點都靠它）
          // ★ 水平收束用加速曲線 hTh（寬/厚比「高度」收得快）：翼梢先貼身 →
          //   變形中途體側不再殘留一塊翼板；頭/臉錨點也提早回到身體上方（比例更像人）
          const hTh = 1 - (1 - hT) * (1 - hT);
          nx += (tx - nx) * hTh;
          nz += (tz - nz) * hT;                      // 高度照標準曲線長 → 有「逐漸長高」的生長感
          let px = nx, pz = nz, py = y + (ty - y) * hTh;
          if (this._sw > 0.001) {
            // ★ 蛻皮改「水平朝中軸收薄」（x/y→0、高度 z 不動）→ 殘體縮進新軀幹「裡面」消失，
            //   頸根高度不跳、頭臉錨點不動。舊版是整體朝原點縮放＋新軀幹同時從原點長大 →
            //   中途兩具都只有 ~60% 大小＝整隻「塌陷再長回」（違和感來源）
            const rk = 1 - this._sw;
            px *= rk; py *= rk;
          }
          pos[i] = px; pos[i + 1] = py; pos[i + 2] = pz;
          continue;
        }
        pos[i] = nx; pos[i + 1] = y; pos[i + 2] = nz;
      }
      // ★每幀無條件重算法線：軀幹的脊椎波＋扇拍位移每幀都在動，
      //   舊版只有 hT>0（人形化）才重算 → 幼體/原始蝠翼造型的法線凍結在建模姿態，
      //   光照不跟表面走 ＝ 魚鰭「面片感」的元凶（absEff>0 時②b 會再算一次，無妨）
      this.computeNormalsFrom(this.torso, pos);
    }

    // ---------- ② 腹膜：Voronoi 細胞呼吸蠕動 ----------
    {
      const { base, pos } = this.belly;
      for (let i = 0; i < base.length; i += 3) {
        const x = base[i], y = base[i + 1], z = base[i + 2];
        // u,v 是腹膜的正規化座標（對應建模時的 -1~1 網格）
        const u = x / (1.45 * Math.max(0.2, 1 - 0.22 * (y / 1.80) ** 2));
        const v = y / 1.80;
        // Voronoi 位移 = 所有細胞影響取最大值（最近細胞勝出 → 細胞膜效果）
        let m = 0;
        for (const c of this.bellyCells) {
          const du = (u - c.u) * 2.1, dv = v - c.v;
          const d2 = du * du + dv * dv;
          const infl = Math.exp(-d2 / 0.09);
          const pulse = 0.55 + 0.45 * Math.sin(t * 1.7 + c.ph + d2 * 3.0);
          if (infl * pulse > m) m = infl * pulse;
        }
        pos[i] = x; pos[i + 1] = y; pos[i + 2] = z - m * belAmp;   // 向外(下)鼓出
      }
      // 人形化：腹膜是蝠翼腹面的膜 → 加速「收進身體中軸」後退場：
      //   ①收向中軸 (0,0,z)（不收向固定質心——身體變形後質心已在新身體外面 → 膜片收完浮在體外）
      //   ②★退場加速 belK（hT×1.7）：Ⅲ 隻前（hT≈0.6）就收光 → 變形中途不會在身體下方
      //     拖著一片「暗色大膜＋光點網」（黑板感的來源）；hT=0 幼體仍是完整腹膜
      if (hT > 0) {
        const belK = Math.max(0, 1 - hT * 1.7);   // 殘存比例：1＝幼體全大 → hT≈0.59 收光
        for (let i = 0; i < pos.length; i += 3) {
          pos[i]     *= belK;   // ★乘殘存比例收向中軸 (0,0)
          pos[i + 1] *= belK;   //   舊版寫成 += (0−pos)×belK ＝只收掉「belK 這麼多」→
        }                       //   實際保留 clamp(hT×1.7)：hT 越大腹膜越大（完全反向），
                                //   m2(hT.56) 保留 95%、hT≥0.59 永遠 100% ＝變形中途的長刀翼膜
                                //   乘法才對：hT 0→1 時 1→0 線性收光（x/y 收、z 不動）
      }
      // ★腹膜每幀 Voronoi 呼吸都在動 → 無條件重算法線（absEff>0 時 ②b 會再算一次）
      this.computeNormalsFrom(this.belly, pos);
    }

    // ---------- ②b 抽象形變：沿軸扭轉 + 非均勻比例呼吸 + 徑向流場位移 ----------
    // 目的：把「可辨認的蝠翼動物」扭成不確定是什麼的不定形東西（滑桿 0 = 原始）
    // ★位置說明：原在③ 觸手之後 → 搬到這（② 之後）→ 觸手/背棘的「根部黏表面」位移
    //   才吃得到扭轉後的座標（舊順序下根部跟表面差一段扭轉量 → 變形期部件懸空違和）
    // 人形化收束：扭轉/呼吸幅度吃 absEff（(1−hT) 淡出）→ 變形期軀幹穩定，
    // 錨在身上的頭/臉/手臂不會被甩得「各自漂浮」；hT=1 時完全靜止（走路動畫仍活著）
    if (absEff > 0) {
      const tw = 1.5 * absEff * Math.sin(t * 0.37);                // 扭轉量（隨時間變）
      const kx = 1 + 0.30 * absEff * Math.sin(t * 0.43);            // 三軸比例各自呼吸
      const kz = 1 + 0.30 * absEff * Math.sin(t * 0.51 + 2.0);
      const ky = 1 + 0.18 * absEff * Math.sin(t * 0.29 + 1.0);
      for (const id of ["torso", "belly"]) {
        const part = this[id];
        if (!part) continue;
        const pos = part.pos;
        for (let i = 0; i < pos.length; i += 3) {
          const x = pos[i], y0 = pos[i + 1], z = pos[i + 2];
          // (a) 繞身體 Y 軸扭轉（離頭越遠扭越多 → 蝠翼被扭成抽象帶狀）
          const a = tw * y0, ca = Math.cos(a), sa = Math.sin(a);
          let x2 = x * ca - z * sa, z2 = x * sa + z * ca;
          // (b) 非均勻比例呼吸（身體一直在「不像動物」的比例之間變形）
          const y = y0 * ky;
          x2 *= kx; z2 *= kz;
          // (c) 徑向流場：只留「低頻、平滑」的大瓣起伏 → 軀幹線條整齊
          //     （把高頻皺褶拿掉：sin(rr*3) 半徑波波長 < 頂點間距 → 表面結塊的元凶）
          //     沿身頻率 2.1→1.1（不到半波）、角向 3→2 瓣、幅度 0.45→0.35：
          //     相鄰頂點幾乎位移相同 → 三角面保持平整 → 陰影平滑
          const rr = Math.hypot(x2, z2);
          const ang = Math.atan2(z2, x2);
          const n = Math.sin(y * 1.1 + t * 1.3) * Math.cos(ang * 2 + t * 0.9);
          const disp = 0.35 * absEff * n;
          const sx = rr > 1e-4 ? x2 / rr : 0, sz = rr > 1e-4 ? z2 / rr : 0;
          pos[i]     = x2 + sx * disp;
          pos[i + 1] = y + 0.22 * absEff * Math.sin(x2 * 0.9 - t * 1.1);
          pos[i + 2] = z2 + sz * disp;
        }
        // 表面被大幅變形 → 每幀重算法線，光照才會貼著新表面
        this.computeNormalsFrom(part, pos);
      }
    }

    // ---------- ③ 觸手：每幀重算 16 條路徑（行進波晃動 + 重力下垂 + 不穿地） ----------
    if (this.tentacles) {
      // Ⅱ 階段（第 2 隻解鎖）：觸手逐步收短收斂（讓之後的「人手」搶戲）
      const m = Math.min(this.meals || 0, 6);
      const t2 = m <= 1 ? 0 : (m - 1) / 5;             // m1=0 / m2=0.2 / m6=1
      const amp = tentAmp * 1.6 * (1 - 0.30 * t2);     //「觸手水流擺動」滑桿 → 世界單位晃幅
      // 人形化：人沒有觸手 → 軀幹站起來後整批「完全」收進身體裡
      // ★ 收乾淨係數加快（×1.5）：Ⅲ 隻（hT≈0.67）觸手就完全退場 →
      //  變形中途頭上不再插著一圈細長觸手冠；之後頭部識別交給「臉」接手
      const hK = Math.max(0, 1 - hT * 1.5);
      const lenK = (1 - 0.40 * t2) * hK;
      const { pos } = this.tentacles;
      const F = this.poseFrame(t);          // 局部→世界（海床夾制用；與渲染同一個 t）
      const tp = this.torso.pos, tb = this.torso.base;   // 軀幹「變形後 / 建模期」頂點
      for (const d of this.tentacleDefs) {
        // ★ 根部黏表面：建模期根部是蝠翼座標 → 身體一形變，原位置就懸在空氣裡（違和漂浮）。
        //   做法＝取離根最近的「軀幹頂點」，把它當幀的總位移量（形變＋波＋扭轉呼吸）加到根上
        //   → 根永遠貼著變形後的表面走（惰性找一次頂點索引 d.rootVi，之後每幀只做加法）
        if (d.rootVi == null) {
          let best = 0, bd = 1e18;
          for (let vi = 0; vi < tb.length; vi += 3) {
            const ex = tb[vi] - d.root[0], ey = tb[vi + 1] - d.root[1], ez = tb[vi + 2] - d.root[2];
            const dd = ex * ex + ey * ey + ez * ez;
            if (dd < bd) { bd = dd; best = vi / 3; }
          }
          d.rootVi = best;
        }
        const ri = d.rootVi * 3;
        const rx = d.root[0] + (tp[ri]     - tb[ri]);     // 變形後的根部座標
        const ry = d.root[1] + (tp[ri + 1] - tb[ri + 1]);
        const rz = d.root[2] + (tp[ri + 2] - tb[ri + 2]);
        // 垂直於觸手軸的一組基底（side / up），整條共用
        const dx = d.dir;
        let ux = -dx[1], uy = dx[0], uz = 0;
        let ul = Math.hypot(ux, uy, uz);
        if (ul < 1e-4) { ux = 1; uy = 0; uz = 0; ul = 1; }
        ux /= ul; uy /= ul; uz /= ul;
        const vx = dx[1] * uz - dx[2] * uy,
              vy = dx[2] * ux - dx[0] * uz,
              vz = dx[0] * uy - dx[1] * ux;
        // --- 1) 路徑中心：根部固定，梢部隨行進波大幅甩動 ---
        const P = d.path;                   // Float32Array(3*(segs+1))，建模時配好
        for (let i = 0; i <= d.segs; i++) {
          const f = i / d.segs, bend = f * f;   // 平方 → 根不動、梢最大
          const w1 = Math.sin(t * d.w + d.ph + f * 3.2) * amp * bend;
          const w2 = Math.cos(t * d.w * 0.7 + d.ph * 1.3 + f * 2.6) * amp * 0.7 * bend;
          // 所有「離開根部的位移」（長度＋水波晃動＋下垂）都乘 hK → 最終人形時整條貼回根部＝隱形
          const x = rx + (dx[0] * d.len * lenK * f + ux * w1 + vx * w2) * hK;
          const y = ry + (dx[1] * d.len * lenK * f + uy * w1 + vy * w2) * hK;
          const z = rz + (dx[2] * d.len * lenK * f + uz * w1 + vz * w2 - d.droop * bend) * hK;
          // 海床夾制：世界座標低於海床 +0.25 就抬回（避免垂鬚插進沙裡）
          const wx = F.T[0] + F.R[0] * x + F.R[1] * y + F.R[2] * z;
          const wy = F.T[1] + F.R[3] * x + F.R[4] * y + F.R[5] * z;
          const wz = F.T[2] + F.R[6] * x + F.R[7] * y + F.R[8] * z;
          const floor = this.floorZ(wx, wy) + 0.25;
          P[i * 3]     = x;
          P[i * 3 + 1] = y;
          P[i * 3 + 2] = (wz < floor && F.R[8] > 0.3) ? z + (floor - wz) / F.R[8] : z;
        }
        // --- 2) 沿路徑重建管子頂點：中心 + (框u·cosθ + 框v·sinθ)·半徑 ---
        const n = d.sides;
        for (let i = 0; i <= d.segs; i++) {
          const a3 = Math.max(0, i - 1) * 3, b3 = Math.min(d.segs, i + 1) * 3;
          let tx = P[b3] - P[a3], ty = P[b3 + 1] - P[a3 + 1], tz = P[b3 + 2] - P[a3 + 2];
          const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
          let ax = -ty, ay = tx, az = 0;           // 切線 × 世界z（退化時備案）
          let al = Math.hypot(ax, ay, az);
          if (al < 1e-4) { ax = 1; ay = 0; az = 0; al = 1; }
          ax /= al; ay /= al; az /= al;
          const bx = ty * az - tz * ay, by = tz * ax - tx * az, bz = tx * ay - ty * ax;
          const f = i / d.segs;
          const r = (d.r0 + (d.r1 - d.r0) * f) * hK;   // 根粗梢細；hK=0 → 半徑歸零（隱形）
          const cx = P[i * 3], cy = P[i * 3 + 1], cz = P[i * 3 + 2];
          for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2;
            const c = Math.cos(a) * r, s = Math.sin(a) * r;
            const vi = (d.start + i * n + k) * 3;
            pos[vi]     = cx + ax * c + bx * s;
            pos[vi + 1] = cy + ay * c + by * s;
            pos[vi + 2] = cz + az * c + bz * s;
          }
        }
      }
      this.computeNormalsFrom(this.tentacles, pos);   // 變形後重算法線
    }

    // ---------- ⑤b 異形背棘：根部貼著「變形後的背脊」，依進食數往外長 ----------
    if (this.spines && this.spineDefs && this.spineDefs.length) {
      // Ⅲ 階段（第 3 隻解鎖）：背棘 →「短而圓鈍的脊椎骨節」，之後每隻越長越完整
      const m = Math.min(this.meals || 0, 6);
      const g = Math.min(1, Math.max(0, (m - 2) / 4));
      const { pos } = this.spines;
      const tp = this.torso.pos;                        // 變形後的軀幹頂點
      const tn = this.torso.normals;
      for (const d of this.spineDefs) {
        const v3 = d.v * 3;
        const rx = tp[v3], ry = tp[v3 + 1], rz = tp[v3 + 2];
        // 人形化：背棘 →「短而圓鈍的脊椎骨節」；最終人形（hT=1）整批消失（人沒有背鰭）
        const sK = 1 - hT;                    // 收乾淨係數：最終型 → 0（完全不畫）
        const len = d.len * (0.10 + 0.55 * g) * sK;
        const out = (0.15 + 0.30 * g) * sK;
        const nx = tn[v3], ny = tn[v3 + 1], nz = tn[v3 + 2];
        const pts = [];
        for (let i = 0; i < d.RINGS; i++) {
          const f = i / (d.RINGS - 1);
          pts.push([
            rx + (nx * out + Math.sin(d.ph) * 0.18) * len * f,
            ry - 0.32 * len * f + ny * out * 0.4 * len * f,
            rz + len * f + nz * out * 0.35 * len * f,
          ]);
        }
        const sw = sK;                                  // 寬度也縮到 0 → 最終型完全不畫出
        const r0 = d.r0 * (0.35 + 1.00 * g) * sw;       // 越吃越粗（骨節感）
        this.writeTubeAt(pos, d.start, pts, r0, 0.03 * (0.4 + 0.6 * g) * sw, d.SIDES);
      }
      this.computeNormalsFrom(this.spines, pos);
    }

    // ---------- ⑤c 人形手臂：貼著「變形後的肩點」重寫肩→肘→腕→五指 ----------
    if (this.hands && this.handDefs && this.handDefs.length) {
      const k = this.human.hAr;                       // Ⅲ 隻解鎖：手臂 0.5 起步長滿
      const tp = this.torso.pos;
      const { pos } = this.hands;
      for (const d of this.handDefs) {
        // 擺臂：左右手「交替」，且與同側腳相反（legDefs[0]=右腿：φ=0 右腳在前 → 右手往後）
        //（舊版全域共用一個 swing → 雙手同步前後＝殭屍同步擺，就是「手部動作奇怪」的來源）
        const swing = this.human.walkK > 0
          ? Math.cos(this.walkPhase) * (d.side > 0 ? -1 : 1) * 0.34
          : Math.sin(t * 0.9 + (d.side > 0 ? 0 : Math.PI)) * 0.10;   // 站立時左右微微不同步晃
        const v3 = d.v * 3;
        // 肩點：身體頂點 → 人形肩（上胸兩側 ±0.62＝貼著新肩台邊緣），跟著軀幹人形化插值
        //（不然肩膀會縮在身體中線，雙手整個擠到肚子上）
        const ht = this.human.hT;
        const S = [ tp[v3] + (d.side * 0.62 - tp[v3]) * ht,
                    tp[v3 + 1] + (0.0 - tp[v3 + 1]) * ht,
                    tp[v3 + 2] + (1.00 - tp[v3 + 2]) * ht ];
        const { main: specs, claws: clawSpecs } = this.handPaths(d, S, k, swing);
        for (let i = 0; i < specs.length; i++) {
          const sp = specs[i];
          this.writeTubeAt(pos, d.starts[i], sp.pts, sp.r0, sp.r1, sp.sides, sp.flat);
        }
        // 指甲跟著手指同步重寫（同一組座標 → 爪永遠黏在指尖上）
        if (this.claws) {
          const cp = this.claws.pos;
          for (let i = 0; i < clawSpecs.length; i++) {
            const sp = clawSpecs[i];
            this.writeTubeAt(cp, d.cstarts[i], sp.pts, sp.r0, sp.r1, sp.sides, sp.flat);
          }
        }
      }
      this.computeNormalsFrom(this.hands, pos);
      if (this.claws) this.computeNormalsFrom(this.claws, this.claws.pos);
    }

    // ---------- ⑤d 人臉：眉脊/鼻梁/眼窩/嘴縫；Ⅱ 隻跟著「人頭」浮現 ----------
    if (this.faceRidge && this.faceHoles && this.faceDef) {
      // Ⅱ 隻：眉脊 + 深色眼窩；Ⅲ 隻：鼻梁 + 嘴縫（目標值在 humanStage()，這裡吃「已平滑」的現值 → 跟頭一起慢慢浮現）
      const kU = this.human.hEy;
      const kL = this.human.hFa;
      const f = this.faceDef;
      const tp = this.torso.pos, tn = this.torso.normals;
      const v3 = f.hv * 3;
      let Hx = tp[v3], Hy = tp[v3 + 1], Hz = tp[v3 + 2];
      let Nx = tn[v3], Ny = tn[v3 + 1], Nz = tn[v3 + 2];
      const nl = Math.hypot(Nx, Ny, Nz) || 1; Nx /= nl; Ny /= nl; Nz /= nl;
      // Ⅱ 隻：臉從「吻端」搬去「人頭正面」
      // 頸根 = 軀幹「吻端」頂點變形後的位置 → 頭/臉/眼球都長在這（不會浮空）
      const nb = f.hv * 3;
      const Bx = tp[nb], By = tp[nb + 1], Bz = tp[nb + 2];
      const swN = this._sw || 0;                // 蝻皮中：頸根逐漸改錨定「新人形躯幹」頸口
      this.neckB = [Bx + (0 - Bx) * swN,
                    By + (0.02 - By) * swN,
                    Bz + (1.7 - Bz) * swN];     //（頭/臉/眼球錨點跟著平滑搬過去）
      // ★ 人類頸口常數（建造期「新人形軀幹」的頸口中心）：
      //   頭/臉/髮一律以它當縮放基準——中途頸根 B 還沒長到 1.7 時，
      //   頭脖子（建造底 z=1.25）仍會「往下插進」B 下方，不會懸空浮頭
      this.neckRim = [0, 0.02, 1.7];
      const hF = this.human.hHd;
      if (hF > 0) {
        // 臉面 = 頭「中心」的正前方。頭中心 = 頸根 B + (建造中心 − 頸口)×hF（跟 ⑤f 同一條曲線）：
        //   舊版把 hF 套了兩次（cz 已含 hF、再 += (cz−Hz)*hF）→ 中途臉錨點飛出頭球外（眼球漂浮）
        const cy = By + (0.05 - 0.02) * hF + 0.46 * hF;   // 頭前表面高度（中心 + 半徑 0.46×hF）
        const cz = Bz + (2.24 - 1.7) * hF;                // 頭中心高度
        Hx = Bx;                                          // H 起點就是同一個吻端頂點
        Hy = cy;
        Hz = cz;
        Nx += (0 - Nx) * hF;   Ny += (1 - Ny) * hF;   Nz += (0 - Nz) * hF;
      }
      this.faceAnchor = [Hx, Hy, Hz];   // ⑥ 眼球入窩：跟臉共用同一個錨點
      const fS = 0.885 * hF;            // 臉部五官整體縮放：×hF → 頭還小的時候五官跟著小（漸進變形才不成比例）；hF=1 時 = 原值 0.885
      // 臉部座標軸：N = 朝前、right = z × N（左右）、up = N × right（上下）
      let rx = -Ny, ry = Nx, rz = 0;
      const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl;
      const ux = Ny * rz - Nz * ry, uy = Nz * rx - Nx * rz, uz = Nx * ry - Ny * rx;
      const P = (u, v, n) => [
        Hx + (rx * u + ux * v + Nx * n) * fS,
        Hy + (ry * u + uy * v + Ny * n) * fS,
        Hz + (rz * u + uz * v + Nz * n) * fS ];
      // 眉脊（6 環）+ 鼻梁（3 環）：眉脊吃 kU、鼻梁吃 kL
      const brow = [];
      for (let i = 0; i < 6; i++) {
        // 眉脊整根「縮成零半徑」藏起來：錨點在頭表面、額頭又往後傾 →
        // 管子只要有任何 n 凸出就會浮成「紅頭帶＋垂鉤」。要復原立體眉：
        // 半徑改 0.030/0.024，且每點 n 要改成「貼頭球面的後退量」(0.46 − √(0.46²−u²−v²))
        brow.push(P(0, 0.205 * kU, -0.09 * kU));
      }
      this.writeTubeAt(this.faceRidge.pos, f.browStart, brow, 0, 0, 5);
      // 鼻子縮短收小（下端 −0.055、鼻頭半徑 0.05）→ 鼻頭與嘴之間留出皮膚間隔（人中）
      const nose = [P(0, 0.10 * kL, 0.03 * kL), P(0, 0.02 * kL, 0.07 * kL), P(0, -0.055 * kL, 0.09 * kL)];
      this.writeTubeAt(this.faceRidge.pos, f.noseStart, nose, 0.035 * kL, 0.05 * kL, 5);
      this.computeNormalsFrom(this.faceRidge, this.faceRidge.pos);
      // 眼窩（中心 + 8 圈 ×2）—— Ⅳ 階段
      const hp = this.faceHoles.pos;
      for (let si = 0; si < 2; si++) {
        const su = si === 0 ? -0.145 : 0.145;
        let vi = f.sockStart[si] * 3;
        const c = P(su * kU, 0.06 * kU, 0.045 * kU);
        hp[vi++] = c[0]; hp[vi++] = c[1]; hp[vi++] = c[2];
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * 6.28318;
          // 眼窩改杏仁形（寬 0.105 × 高 0.055 ≈ 2:1）→ 不再是圓黑豆
          const q = P((su + Math.cos(a) * 0.105) * kU,
                      (0.06 + Math.sin(a) * 0.055) * kU, 0.012 * kU);
          hp[vi++] = q[0]; hp[vi++] = q[1]; hp[vi++] = q[2];
        }
      }
      // 嘴縫（8 段 × 上下兩排）—— Ⅴ 階段
      let vi = f.mouthStart * 3;
      for (let i = 0; i < 8; i++) {
        const uu = i / 7 - 0.5, q = uu * 2;
        const zm = (-0.195 + 0.020 * q * q) * kL;   // 比鼻頭低一截；嘴角微微上揚（不再苦臉）
        const nn = (0.035 - 0.030 * q * q) * kL;    // 中央貼臉、兩端收進臉頰
        const top = P(uu * 0.30 * kL, zm + 0.015 * kL, nn);
        const bot = P(uu * 0.30 * kL, zm - 0.015 * kL, nn);
        hp[vi++] = top[0]; hp[vi++] = top[1]; hp[vi++] = top[2];
        hp[vi++] = bot[0]; hp[vi++] = bot[1]; hp[vi++] = bot[2];
      }
      // 唇形：跟嘴縫同一組曲線、微微外凸 → 跟嘴一起長出來（kL=0 → 收攏不畫）
      const lipW = (dv) => { const arr = [];
        for (let i = 0; i < 8; i++) { const uu = i / 7 - 0.5, q = uu * 2;
          arr.push(P(uu * 0.300 * kL,
                     (-0.195 + 0.020 * q * q) * kL + dv * kL,
                     (0.040 - 0.026 * q * q) * kL)); }
        return arr; };
      this.writeTubeAt(this.faceRidge.pos, f.lipStart, lipW( 0.020), 0.011 * kL, 0.011 * kL, 5);
      this.writeTubeAt(this.faceRidge.pos, f.lipStart + 40, lipW(-0.022), 0.013 * kL, 0.013 * kL, 5);
      // 瞳孔：近黑小圓盤貼在眼球正前方（深度/半徑跟著「上一幀量到的眼球半徑」走 → 自動貼合）
      // ★ 退場時也要「寫」到臉錨點（零面積＝隱形）：舊版 eyeBallR 小時直接跳過不寫 →
      //   頂點凍在上次寫入的位置（幼體雲端座標）→ 十幾片近黑圓盤懸在體外＝演化期的「黑板」
      for (let si = 0; si < 2; si++) {
        const su = si === 0 ? -0.145 : 0.145;
        let pvi = f.pupilStart[si] * 3;
        // ★ fS=0（hHd=0，第 0~1 隻頭還沒長）時下面兩式會除零 → NaN 頂點
        //   （靜默失敗：JSON 倾印變 null、渲染端三角形隨 GPU 消失）→ 收攏在臉錨點＝零面積隱形
        if (this.eyeBallR > 0.001 && fS > 1e-6) {
          const nv = (0.025 + this.eyeBallR + 0.005) / fS;  // 世界深度 → 臉部座標
          const pr = (this.eyeBallR * 0.62) / fS;            // 瞳孔約為眼球直徑 62%
          const c = P(su, 0.06, nv);
          hp[pvi++] = c[0]; hp[pvi++] = c[1]; hp[pvi++] = c[2];
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * 6.28318;
            const q = P(su + Math.cos(a) * pr, 0.06 + Math.sin(a) * pr, nv);
            hp[pvi++] = q[0]; hp[pvi++] = q[1]; hp[pvi++] = q[2];
          }
        } else {
          const c = P(su, 0.06, 0);                          // 收攏在臉錨點上（7 個頂點重疊＝零面積）
          for (let i = 0; i < 7; i++) { hp[pvi++] = c[0]; hp[pvi++] = c[1]; hp[pvi++] = c[2]; }
        }
      }
      this.computeNormalsFrom(this.faceHoles, hp);
    }

    // ---------- ⑤i 觸鬚頭髮：每幀重算「上揚→垂落」弧線 + 搖曳（跟著頭部 hHd 一起長） ----------
    if (this.hairTents && this.hairDefs && this.hairDefs.length) {
      const hHd = this.human.hHd || 0;                  // 頭部生長 0~1（Ⅱ 隻解鎖）
      // ★ 觸鬚髮改由「挺直過程」驅動（hPost：Ⅰ 隻 1.0 → 第 6 隻 0）：
      //  前 4 隻（hPost>0.5）幾乎無髮 → 演化中途頭上乾淨、不插觸鬚冠；
      //  挺得越直髮越長 → 第 6 隻完全直立＝觸手髮雕塑（保留原本的最終造型）
      const hp2 = this.human.hPost || 0;
      const hk = Math.min(1, hHd * 1.25) * Math.max(0, 1 - hp2 / 0.5);
      const fdH = this.faceDef;
      const tpH = this.torso.pos, v3H = fdH.hv * 3;     // 頸根錨點（跟 ⑤d 臉同一個）
      const nbxH = tpH[v3H], nbyH = tpH[v3H + 1], nbzH = tpH[v3H + 2];
      // 頭中心（跟 ⑤d 同一條插值曲線：hHd=1 → 建造座標 (0, 0.05, 2.24)）
      const hcx = nbxH;
      const hcy = nbyH + (0.05 - nbyH) * hHd;
      const hcz = nbzH + (2.24 - nbzH) * hHd;
      // 臉部座標軸（跟 ⑤d 同一套插值，不用 headAxes()——
      //   幼體軀幹退場後 hv 法線會歸零，必須用 hHd 插值到 +Y 才有定義）
      const tnH = this.torso.normals;
      let fxH = tnH[v3H], fyH = tnH[v3H + 1], fzH = tnH[v3H + 2];
      fxH += (0 - fxH) * hHd;  fyH += (1 - fyH) * hHd;  fzH += (0 - fzH) * hHd;   // hHd=1 → 朝前 +Y
      const flH = Math.hypot(fxH, fyH, fzH) || 1; fxH /= flH; fyH /= flH; fzH /= flH;
      let uxH = -fxH * fzH, uyH = -fyH * fzH, uzH = 1 - fzH * fzH;   // up = 世界Z 投影到 ⊥f
      const ulH = Math.hypot(uxH, uyH, uzH) || 1; uxH /= ulH; uyH /= ulH; uzH /= ulH;
      const rxH = fyH * uzH - fzH * uyH;    // r = f × u（右）
      const ryH = fzH * uxH - fxH * uzH;
      const rzH = fxH * uyH - fyH * uxH;
      const hpH = this.hairTents.pos;
      for (const d of this.hairDefs) {
        const P2 = d.path;
        // 根部方向：頭皮上的單位向量（theta = 離頂角、phi = 繞頭角）
        const ctH = Math.cos(d.theta), stH = Math.sin(d.theta);
        const cpH = Math.cos(d.phi), spH = Math.sin(d.phi);
        const dx = (fxH * cpH + rxH * spH) * stH;       // 水平分量（離頭方向）
        const dy = (fyH * cpH + ryH * spH) * stH;
        const dz = (fzH * cpH + rzH * spH) * stH;
        // 根部 = 頭中心 + 單位方向 × 0.42（0.42 < 頭半徑 0.46 → 根部半埋進頭皮）
        // 單位方向 = 水平分量(sinθ) + 上分量(cosθ)——漏掉 cosθ 會讓髮根掉進頭骨裡！
        const rX = hcx + (dx + uxH * ctH) * 0.42;
        const rY = hcy + (dy + uyH * ctH) * 0.42;
        const rZ = hcz + (dz + uzH * ctH) * 0.42;
        // 側向搖擺軸 = 上 × 頭皮法線（讓髮往兩側甩，不會前後戳）
        let wx = uyH * dz - uzH * dy, wy = uzH * dx - uxH * dz, wz = uxH * dy - uyH * dx;
        const wlH = Math.hypot(wx, wy, wz) || 1; wx /= wlH; wy /= wlH; wz /= wlH;
        // 1) 沿「上揚 → 垂落」圓弧積分出路徑（梢部加慢擺）
        for (let i = 0; i <= d.segs; i++) {
          const fH = i / d.segs;
          const a = d.a0 + (d.a1 - d.a0) * fH
                  + Math.sin(t * 1.6 + d.ph + fH * 2.4) * 0.09 * fH;
          const ds = d.len * hk / d.segs;
          const ox = dx * Math.cos(a) + uxH * Math.sin(a);
          const oy = dy * Math.cos(a) + uyH * Math.sin(a);
          const oz = dz * Math.cos(a) + uzH * Math.sin(a);
          if (i === 0) { P2[0] = rX; P2[1] = rY; P2[2] = rZ; }
          else {
            P2[i * 3]     = P2[(i - 1) * 3]     + ox * ds;
            P2[i * 3 + 1] = P2[(i - 1) * 3 + 1] + oy * ds;
            P2[i * 3 + 2] = P2[(i - 1) * 3 + 2] + oz * ds;
          }
          const sw = Math.sin(t * 1.1 + d.ph2 + fH * 3.2) * 0.05 * fH * fH * hk;
          P2[i * 3]     += wx * sw;
          P2[i * 3 + 1] += wy * sw;
          P2[i * 3 + 2] += wz * sw;
        }
        // 2) 沿路徑重建管子頂點（同 ⑤h 的切線框算法；半徑 × hk → 頭沒長好前縮著）
        const n2 = d.sides;
        for (let i = 0; i <= d.segs; i++) {
          const a3 = Math.max(0, i - 1) * 3, b3 = Math.min(d.segs, i + 1) * 3;
          let tx = P2[b3] - P2[a3], ty = P2[b3 + 1] - P2[a3 + 1], tz = P2[b3 + 2] - P2[a3 + 2];
          const tlH = Math.hypot(tx, ty, tz) || 1; tx /= tlH; ty /= tlH; tz /= tlH;
          let axv = -ty, ayv = tx, azv = 0;              // 切線 × 世界z（退化時備案）
          let alv = Math.hypot(axv, ayv, azv);
          if (alv < 1e-4) { axv = 1; ayv = 0; azv = 0; alv = 1; }
          axv /= alv; ayv /= alv; azv /= alv;
          const bxh = ty * azv - tz * ayv, byh = tz * axv - tx * azv, bzh = tx * ayv - ty * axv;
          const ffH = i / d.segs;
          const rrH = (d.r0 + (0.010 - d.r0) * ffH) * hk;  // 根粗梢細；hk=0 → 半徑 0 隱形
          const cxh = P2[i * 3], cyh = P2[i * 3 + 1], czh = P2[i * 3 + 2];
          for (let k = 0; k < n2; k++) {
            const ang = (k / n2) * 6.28318;
            const c2 = Math.cos(ang) * rrH, s2 = Math.sin(ang) * rrH;
            const vi = (d.start + i * n2 + k) * 3;
            hpH[vi]     = cxh + axv * c2 + bxh * s2;
            hpH[vi + 1] = cyh + ayv * c2 + byh * s2;
            hpH[vi + 2] = czh + azv * c2 + bzh * s2;
          }
        }
      }
      this.computeNormalsFrom(this.hairTents, hpH);
    }

    // ---------- ⑤e 人形雙腿：步行週期 + 兩段 IK 貼地（Ⅳ 隻解鎖、Ⅵ 隻開始走） ----------
    if (this.legs && this.legDefs && this.legDefs.length) {
      const k = this.human.hLg;                       // 腿生長 0~1
      const { pos } = this.legs;
      const F = this.poseFrame(t);                    // 與渲染同一個 t（腳要貼地）
      const P = this.pose;
      const L = 2.2 * k;                              // 腿總長：0 → 滿長（k=0 完全退化）
      const L1 = L / 2, L2 = L / 2;
      const HIPZ = -0.7, HIPX = 0.21;                 // 髖關節（0.21 → 大腿頂環整個埋進骨盆、不露開口）
      const fx = -Math.sin(P.heading), fy = Math.cos(P.heading);   // 世界前方
      const rx = Math.cos(P.heading), ry = Math.sin(P.heading);    // 世界右方
      // 半步長：跟速度/步頻自動配速 → 站立期腳底「相對地面零滑動」
      //  數學（全部以牆上時間計）：2·stride = gSpeed × 站立期秒數 = gSpeed × (1.2π / 牆上頻率)
      //  站著不動 gSpeed=0 → stride=0 → 雙腳定地不動（不會原地踏步）
      const ps2 = Math.max(0.01, (params && params.speed) || 1);
      const rateWall = Math.max(0.01, (this._wRate || 0) * ps2);   // simT 頻率 × speed = 牆上頻率
      const stride = Math.min(0.85, Math.max(0, this.gSpeed * 1.2 * Math.PI / (2 * rateWall)));
      const rr = (0.62 + 0.38 * k) * k;               // 腿的粗細跟著長（k=0 → 半徑 0）
      const TOE_SP = [-0.30, 0, 0.30];                // 腳趾扇開角（跟 buildHumanLimbs 一致）
      for (let li = 0; li < this.legDefs.length; li++) {
        const d = this.legDefs[li];
        const off = li === 0 ? 0 : Math.PI;           // 兩腳相位差半步
        const H = [HIPX * d.side, 0, HIPZ];
        let knee, ank;                                // IK 解出來的膝/踝（局部）
        if (k <= 0.001) {
          knee = H; ank = H;                          // 還沒長腿 → 全收進髖點（退化不畫）
        } else {
        // ① 期望「世界」腳底位置：走路跨步貼地 / 站立時踩在髖正下方
        let fFwd = 0, fLift = 0;
        if (this.human.walkK > 0) {
          let ph = (this.walkPhase + off) % 6.28318;
          if (ph < 0) ph += 6.28318;
          const ST = Math.PI * 1.2;                    // 站立期 60%（擺動期 40% → 真人步態比例）
          if (ph < ST) {                               // 站立期：貼地直線後退
            fFwd = stride * (1 - 2 * (ph / ST));
          } else {                                     // 擺動期：抬腳弧線前跨（較短較快）
            const s = (ph - ST) / (6.28318 - ST);
            fFwd = stride * (-1 + 2 * s * s * (3 - 2 * s));
            fLift = 0.55 * stride * Math.sin(Math.PI * s);
          }
        }
        const gx = P.x + fx * fFwd + rx * HIPX * d.side * 1.04;
        const gy = P.y + fy * fFwd + ry * HIPX * d.side * 1.04;
        const footW = [gx, gy, this.floorZ(gx, gy) + 0.06 + fLift];
        // ② 反算回局部（旋轉的逆矩陣 = 轉置）→ 給 worldize 轉回世界時正好落地
        const rx2 = footW[0] - F.T[0], ry2 = footW[1] - F.T[1], rz2 = footW[2] - F.T[2];
        const fl = [F.R[0] * rx2 + F.R[3] * ry2 + F.R[6] * rz2,
                    F.R[1] * rx2 + F.R[4] * ry2 + F.R[7] * rz2,
                    F.R[2] * rx2 + F.R[5] * ry2 + F.R[8] * rz2];
        // ③ 兩段 IK（在側面 YZ 平面解；膝朝前 +Y 彎 → 人腳的彎向）
        let ky = fl[1] - H[1], kz = fl[2] - H[2];
        let dst = Math.hypot(ky, kz);
        const maxD = L1 + L2 - 0.03;
        if (dst > maxD) { ky *= maxD / dst; kz *= maxD / dst; dst = maxD; }
        else if (dst < 1e-4) { kz = -1e-4; dst = 1e-4; }
        const ang = Math.atan2(ky, kz);
        const ca = Math.max(-1, Math.min(1, (L1 * L1 + dst * dst - L2 * L2) / (2 * L1 * dst)));
        const ka = ang - Math.acos(ca);                // 膝在髖→腳方向的「前方」側
        knee = [H[0], H[1] + Math.sin(ka) * L1, H[2] + Math.cos(ka) * L1];
        ank = [H[0], H[1] + ky, H[2] + kz];
        }
        const mid1 = [(H[0] + knee[0]) / 2, (H[1] + knee[1]) / 2, (H[2] + knee[2]) / 2];
        const mid2 = [(knee[0] + ank[0]) / 2, (knee[1] + ank[1]) / 2, (knee[2] + ank[2]) / 2];
        const toe = [ank[0], ank[1] + 0.30 * k, ank[2] - 0.02 * k];
        // 大腿頂端 0.17：寫成「無蓋開口管」，若頂環大過骨盆表面會從胯下看進管內（暗洞＝菱形）
        // 髖 x=0.21 時骨盆表面半厚 0.19 > 7邊形角點 0.182 → 完全埋住
        this.writeTubeAt(pos, d.starts[0], [H, mid1, knee], 0.17 * rr, 0.16 * rr, 7);
        // 膝蓋重疊：小腿第一環往大腿裡埋一截 → 走路彎膝時不會露出接縫黑洞
        const kOver = [knee[0] + (knee[0] - mid2[0]) * 0.35,
                       knee[1] + (knee[1] - mid2[1]) * 0.35,
                       knee[2] + (knee[2] - mid2[2]) * 0.35];
        // 注意：管的「環數」必須跟建拓撲時一致（writeTubeAt 只寫頂點、面是預建的）
        //   加環會超出區間蓋掉別的管 → 小腿曾因此斷在半路
        this.writeTubeAt(pos, d.starts[1], [knee, mid2, ank], 0.16 * rr, 0.10 * rr, 7);
        this.writeTubeAt(pos, d.starts[2], [ank, toe], 0.13 * rr, 0.07 * rr, 6);
        // 腳趾×3＋角質爪：座標公式跟 buildHumanLimbs 建拓撲時一致（環數也必須一致）
        for (let ti = 0; ti < 3; ti++) {
          const s = TOE_SP[ti];
          let tx = Math.sin(s) * 0.9, ty = 0.92 - Math.abs(s) * 0.1, tz = -0.14;
          const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
          const t1 = [toe[0] + tx * 0.11 * k, toe[1] + ty * 0.11 * k, toe[2] + tz * 0.11 * k];
          const t2 = [toe[0] + tx * 0.20 * k, toe[1] + ty * 0.20 * k, toe[2] + tz * 0.20 * k];
          this.writeTubeAt(pos, d.tstarts[ti], [toe, t1, t2], 0.052 * rr, 0.024 * rr, 5);
          if (this.claws) {
            const c1 = [t2[0] + tx * 0.04 * k, t2[1] + ty * 0.04 * k, t2[2] + tz * 0.04 * k];
            const c2 = [t2[0] + tx * 0.075 * k, t2[1] + ty * 0.075 * k, t2[2] + tz * 0.075 * k - 0.012 * k];
            this.writeTubeAt(this.claws.pos, d.cstarts[ti], [t2, c1, c2], 0.021 * rr, 0.002 * rr, 5);
          }
        }
      }
      this.computeNormalsFrom(this.legs, pos);
      if (this.claws) this.computeNormalsFrom(this.claws, this.claws.pos);
    }

    // ---------- ⑤f 人形頭部：頸 + 蛋形頭從「頸根」長出來（Ⅱ 隻解鎖） ----------
    if (this.head) {
      const k = this.human.hHd;
      const hp = this.head.pos, hb = this.head.base;
      const B = this.neckB || [0, 0.03, 1.25];      // 生長基點 = 變形後的頸根
      const R = this.neckRim || [0, 0.02, 1.7];     // 縮放基準 = 人類頸口常數（不是頸根 B）
      // ★ hp = B + (hb − 頸口)×k —— 以頸口為基準縮放：
      //   建造期頭的脖子往下伸到 z=1.25（埋進身體 0.45）；k 中段時頸根 B 才長到 z~0.94，
      //   用 B 當基準會把脖子底「拉到 B 上方 (1.7−Bz)×k」→ hT<0.74 的階段整顆頭懸空浮著。
      //   改以頸口(0,0.02,1.7)為基準後：脖子底 = B + (1.25−1.7)×k 永遠往下插進軀幹 0.45×k，
      //   k=0 收在頸根、k=1 且 B=頸口時 hp=hb（終型與舊版完全一致）。
      for (let i = 0; i < hp.length; i += 3) {
        hp[i]     = B[0] + (hb[i]     - R[0]) * k;
        hp[i + 1] = B[1] + (hb[i + 1] - R[1]) * k;
        hp[i + 2] = B[2] + (hb[i + 2] - R[2]) * k;
      }
      this.computeNormalsFrom(this.head, hp);
      // 頸部鰓裂：跟頭部同一條縮放曲線（k=0 → 全收在頸根 = 看不見）
      if (this.gills) {
        const gp = this.gills.pos, gb = this.gills.base;
        for (let i = 0; i < gp.length; i += 3) {
          gp[i]     = B[0] + (gb[i]     - R[0]) * k;
          gp[i + 1] = B[1] + (gb[i + 1] - R[1]) * k;
          gp[i + 2] = B[2] + (gb[i + 2] - R[2]) * k;
        }
        this.computeNormalsFrom(this.gills, gp);
      }
    }

    // ---------- ⑤g 第 6 隻「新人形躯幹」：乾淨拓撲從原點長出、接班蝠翼殘體 ----------
    if (this.humanTorso) {
      const swv = this._sw || 0;
      const tp2 = this.humanTorso.pos, hb2 = this.humanTorso.base;
      // ★ 全尺寸只在「蛻皮進行中/完成」（hT≥0.999）時成立：輪廓跟變形後蝠翼幾乎一致 →
      //   讀作「同一具身體長出解剖細節」。若 meals 倒帶（hT<0.999、_sw 還在衰減），
      //   改回跟 swv 縮放淡出 → 不會跟半變形蝠翼「兩具身體疊一起」（曾出現一塊黑板殘影）
      const show = (this.human && this.human.hT >= 0.999) ? 1 : swv;
      if (show < 0.002) {
        for (let i = 0; i < tp2.length; i++) tp2[i] = 0;             // 未蛻皮/已倒帶 → 收在原點（退場不畫）
      } else {
        for (let i = 0; i < hb2.length; i++) tp2[i] = hb2[i] * show;
      }
    }

    // ---------- ⑤h 人形背觸手：平時伏貼垂墜背上；捕食時暴射→纏住→跟著拖回 ----------
    if (this.backTents && this.backTentDefs && this.backTentDefs.length) {
      const swK = Math.max(0, Math.min(1, this._sw || 0));   // 蛻皮進度 → 觸手顯形/隱形
      const F5 = this.poseFrame(t), R5 = F5.R, T5 = F5.T;   // 世界↔本體局部轉換
      const cl = (v) => Math.max(0, Math.min(1, v));
      const ssm = (v) => { v = cl(v); return v * v * (3 - 2 * v); };
      // --- 狩獵狀態：th.t 累進（shoot 0.28s 竄出 → 之後持續纏繞）；獵物消失 → 收尾回縮 ---
      let th = this.tentHunt;
      if (th) {
        if (th.w && th.w.swallow) th.t += dtw;
        else { th.rt = (th.rt || 0) + dtw; if (th.rt > 0.5) this.tentHunt = null; }
      }
      th = this.tentHunt;
      const shoot = th ? ssm(cl(th.t / 0.28)) : 0;         // 竄出進度（突然、快）
      const retract = th && th.rt ? 1 - ssm(th.rt / 0.5) : 1;
      const eT = shoot * retract;                          // 0=伏貼背上 1=伸向獵物
      const wrapT = th ? Math.max(0, th.t - 0.28) : 0;     // 纏繞計時（打圈用）
      // --- 獵物中心（世界 → 本體局部：R 轉置 + 平移） ---
      let tgt = null;
      if (th && th.w && eT > 0) {
        const w = th.w;
        const dx = w.x - T5[0], dy = w.y - T5[1], dz = (w.z + 0.35) - T5[2];
        tgt = [R5[0] * dx + R5[3] * dy + R5[6] * dz,
               R5[1] * dx + R5[4] * dy + R5[7] * dz,
               R5[2] * dx + R5[5] * dy + R5[8] * dz];
      }
      const cmr = (K, s, c, u) => {           // Catmull-Rom：穿過途經點的平滑曲線
        const p0 = K[s * 3 + c], p1 = K[(s + 1) * 3 + c],
              p2 = K[(s + 2) * 3 + c], p3 = K[(s + 3) * 3 + c];
        const u2 = u * u, u3 = u2 * u;
        return 0.5 * (2 * p1 + (-p0 + p2) * u +
                      (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 +
                      (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
      };
      const { pos } = this.backTents;
      for (const d of this.backTentDefs) {
        const P = d.path, sd = d.side, L = d.len, r0p = d.root[0], r1p = d.root[1], r2p = d.root[2];
        // --- 獵物模式的 7 個途經點：背根 → 穿出背表面 → 繞過體側 → 獵物（不穿身體） ---
        let K = null;
        if (tgt) {
          // 纏繞：尖端繞獵物打圈（半徑收緊）→ 視覺上「把牠包起來」
          const a = wrapT * 8 + d.ph;
          const rad = 0.52 - 0.32 * cl(wrapT / 0.6);
          const tx2 = tgt[0] + (wrapT > 0 ? Math.cos(a) * rad : 0);
          const ty2 = tgt[1] + (wrapT > 0 ? Math.sin(a) * rad * 0.55 : 0);
          const tz2 = tgt[2] + (wrapT > 0 ? Math.sin(a * 0.7 + 1.3) * rad * 0.5 : 0);
          K = [r0p, r1p, r2p,                            // 0,1 起點（背脊、埋在體內）×2
               r0p, r1p, r2p,
               r0p + sd * 0.32, -0.50, r2p - L * 0.30,    // 2 先穿出背表面（胸厚 0.34 → y 必須 < -0.34）
               sd * 0.80, -0.05,                          // 3 繞過體側（|x|=0.80 > 肩寬 0.66 才不穿胸）
               r2p + (tz2 - r2p) * 0.55,
               tx2, ty2, tz2,                             // 4,5,6 獵物端 ×3
               tx2, ty2, tz2, tx2, ty2, tz2];
        }
        // --- 1) 路徑中心：二次貝茲 idle（垂墜）↔ aim（伸向獵物＋纏繞軌道） ---
        for (let i = 0; i <= d.segs; i++) {
          const f = i / d.segs;
          // idle：快速穿出背表面（胸部厚達 0.34）→ 沿背垂到腰下；梢部略外張
          const sway = Math.sin(t * 1.3 + d.ph) * 0.02 * f;
          const em = ssm(cl(f / 0.38));                  // 0→1：前 38% 就離開背
          let x = r0p + sd * 0.20 * f * f + sway;
          let y = r1p - 0.36 * em - 0.06 * f;            // 穿出背 → 垂墜在背後
          let z = r2p - L * f - 0.14 * f * f;
          if (K) {
            // 沿「背 → 繞側 → 獵物」的平滑路線取樣（0.25 一段共 4 段）
            const s4 = Math.min(3, Math.floor(f * 4));
            const u4 = Math.min(1, f * 4 - s4);
            const bx = cmr(K, s4, 0, u4), by = cmr(K, s4, 1, u4), bz = cmr(K, s4, 2, u4);
            x += (bx - x) * eT; y += (by - y) * eT; z += (bz - z) * eT;
          }
          P[i * 3] = x; P[i * 3 + 1] = y; P[i * 3 + 2] = z;
        }
        // --- 2) 沿路徑重建管子頂點（同③觸手的切線框算法） ---
        const n = d.sides;
        for (let i = 0; i <= d.segs; i++) {
          const a3 = Math.max(0, i - 1) * 3, b3 = Math.min(d.segs, i + 1) * 3;
          let tx = P[b3] - P[a3], ty = P[b3 + 1] - P[a3 + 1], tz = P[b3 + 2] - P[a3 + 2];
          const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
          let ax = -ty, ay = tx, az = 0;                 // 切線 × 世界z（退化時備案）
          let al = Math.hypot(ax, ay, az);
          if (al < 1e-4) { ax = 1; ay = 0; az = 0; al = 1; }
          ax /= al; ay /= al; az /= al;
          const bx2 = ty * az - tz * ay, by2 = tz * ax - tx * az, bz2 = tx * ay - ty * ax;
          const f = i / d.segs;
          const r = (d.r0 + (d.r1 - d.r0) * f) * swK;    // 根粗梢細；swK=0（未人形）→ 半徑0隱形
          const cx = P[i * 3], cy = P[i * 3 + 1], cz = P[i * 3 + 2];
          for (let k = 0; k < n; k++) {
            const a = (k / n) * Math.PI * 2;
            const c = Math.cos(a) * r, s2 = Math.sin(a) * r;
            const vi = (d.start + i * n + k) * 3;
            pos[vi]     = cx + ax * c + bx2 * s2;
            pos[vi + 1] = cy + ay * c + by2 * s2;
            pos[vi + 2] = cz + az * c + bz2 * s2;
          }
        }
      }
      this.computeNormalsFrom(this.backTents, pos);       // 變形後重算法線
    }

    // ---------- ⑥ 複眼：抽象模式下脫離頭部、各自鬆散漂浮 ----------
    if (this.eyes) {
      const { base, pos } = this.eyes;
      pos.set(base);
      const amp = absEff * 0.6;                 // 人形化淡出 → 眼球雲收束、不再在體外亂飄
      if (amp > 0.001 && this.eyeGroups) {
        for (const g of this.eyeGroups) {
          // 每顆眼有自己的漂浮頻率/相位 → 雲團式散開（抽象=複眼不再鑲在頭上）
          const ox = Math.sin(t * g.w0 + g.ph) * amp;
          const oy = Math.sin(t * g.w1 + g.ph * 1.7) * amp * 0.8;
          const oz = Math.cos(t * g.w2 + g.ph * 0.6) * amp;
          for (const vi of g.verts) {
            pos[vi * 3]     = base[vi * 3] + ox;
            pos[vi * 3 + 1] = base[vi * 3 + 1] + oy;
            pos[vi * 3 + 2] = base[vi * 3 + 2] + oz;
          }
        }
      }
      // Ⅱ 隻人形化：眼球群收攏到「人頭眼窩」上（蒼白死眼鑲進黑色眼窩）
      const hE = Math.min(1, this.human.hHd * 1.6);   // 眼球移動比頭快 → 第 3 隻就完全入位
      const fa = this.faceAnchor;                     // 臉錨點（⑤d 算的「頭正面中心」）
      // ★ 眼距/眼球大小 ×hHd：頭還小的時候眼睛跟著小、距離跟著窄 → 漸進變形時不成比例大眼
      const eO = Math.min(1, this.human.hHd);         // 眼距縮放（滿頭 = 1）
      const eS = 0.58 * eO;                           // 眼球直徑縮放（0.58 = 滿頭時的原值）
      if (hE > 0 && fa && this.eyeGroups) {
        for (const g of this.eyeGroups) {
          const side = g.cx >= 0 ? 1 : -1;
          // 眼窩中心 = 臉錨點 + 左右 ±0.128、前 0.025（往後收 → 不暴眼）、上 0.053
          const tx = fa[0] + side * 0.128 * eO;
          const ty = fa[1] + 0.025 * eO;
          const tz = fa[2] + 0.053 * eO;
          for (const vi of g.verts) {
            const i3 = vi * 3;
            // 眼球放大（0.30 → 0.58）：蒼白眼球幾乎填滿杏仁眼窩（探針：球半徑≈0.041）
            pos[i3]     += (tx + (base[i3] - g.cx) * eS - pos[i3]) * hE;
            pos[i3 + 1] += (ty + (base[i3 + 1] - g.cy) * eS - pos[i3 + 1]) * hE;
            pos[i3 + 2] += (tz + (base[i3 + 2] - g.cz) * eS - pos[i3 + 2]) * hE;
          }
        }
        this.computeNormalsFrom(this.eyes, pos);
        // 量「眼球實際半徑」（各組頂點對「該組目前質心」的最大距離）→ 下一幀 ⑤d 畫瞳孔用
        // ★ 舊版量的是「頂點 → 眼窩目標點」的距離：眼睛還沒入窩（hE<1）時量到的是
        //   剩餘位移距離（可達 0.4+，不是眼球半徑！）→ 瞳孔被畫成 0.4×0.62 的大黑盤
        //   ＝演化中途浮在吻端的「黑板」。改量「對自己組的質心」→ 量到的永遠是眼球本身
        //   的半徑（入窩中、雲端漂移中都成立）→ 瞳孔尺寸全程合理。
        let br = 0;
        for (const g of this.eyeGroups) {
          const n = g.verts.length;
          let cx = 0, cy = 0, cz = 0;
          for (const vi of g.verts) { const i3 = vi * 3; cx += pos[i3]; cy += pos[i3 + 1]; cz += pos[i3 + 2]; }
          cx /= n; cy /= n; cz /= n;                 // 該組目前質心（隨入窩/漂移一起動）
          for (const vi of g.verts) {
            const i3 = vi * 3;
            const d = Math.hypot(pos[i3] - cx, pos[i3 + 1] - cy, pos[i3 + 2] - cz);
            if (d > br) br = d;
          }
        }
        this.eyeBallR = br;
      }
    }

    // ---------- ⑦ 抽象碎片：繞身體鬆散漂移 + 自轉（抽象度 < 5% 收起來不畫） ----------
    if (this.shards && this.shardDefs) {
      const { base, pos } = this.shards;
      // 抽象度 < 5% 或人形化收束（absEff=(1−hT) 淡出）→ 整批碎片「收到原點」不畫
      //（舊版是整個 if 跳過、不改寫 pos → 碎片永遠凍在建造時的位置 →
      //  胯下那顆暗紅菱形＝凍結的八面體碎片，改軀幹/髖都除不掉就是這個原因）
      if (!(absEff > 0.05)) {
        for (let i = 0; i < pos.length; i++) pos[i] = 0;
      } else {
        // Ⅲ 階段（第 3 隻解鎖）：鰓片碎片縮小 → 輪廓更接近人
        const m = Math.min(this.meals || 0, 6);
        // 人形化：抽象碎片是「異形感/漂浮異物」來源 → 尺寸 sk 與中心距離 cc 同步收：
        //   舊版只縮尺寸、中心照漂（離體 1.3 單位照繞）→ 變形期一顆顆浮在空中；
        //   中心 ×cc 向原點收 → 殼片一路「被吸回體內」而不是飄在旁邊
        const sk = (1 - 0.35 * (m <= 2 ? 0 : (m - 2) / 4)) * (1 - hT);
        const cc = 1 - hT;                      // ★ 中心距離收攏（1=原軌道 → 0=體內原點）
        for (const s of this.shardDefs) {
          const cx = (s.ox + Math.sin(t * s.w + s.ph) * 1.3) * cc;
          const cy = (s.oy + Math.sin(t * s.w * 0.8 + s.ph * 1.4) * 0.9) * cc;
          const cz = (s.oz + Math.cos(t * s.w * 1.1 + s.ph) * 1.0) * cc;
          const a = t * s.spin + s.ph;
          const ca = Math.cos(a), sa = Math.sin(a);
          for (let k = 0; k < 6; k++) {           // 每片 6 個頂點（八面體）
            const v = (s.start + k) * 3;
            const bx = base[v] * sk, by = base[v + 1] * sk, bz = base[v + 2] * sk;
            pos[v]     = bx * ca - by * sa + cx;
            pos[v + 1] = bx * sa + by * ca + cy;
            pos[v + 2] = bz + cz;
          }
        }
      }
      // ★碎片每幀自轉 → 每幀重算法線（舊版凍結在建造姿態 → 自轉時光照不跟著轉，
      //   讀起來像一片片「死的方形貼紙」；收到原點時退化成零面積，算不算是無害）
      this.computeNormalsFrom(this.shards, pos);
    }

    // ---------- ⑧ 逆世界巨影：離地越高擺得越明顯（只在逆世界更新） ----------
    if (this.colossus && this.env === "up") {
      const { base, pos } = this.colossus;
      for (let i = 0; i < base.length; i += 3) {
        const h = Math.max(0, base[i + 2] - this.colossusBaseZ);
        pos[i]     = base[i]     + Math.sin(t * 0.13 + h * 0.16) * h * 0.055;
        pos[i + 1] = base[i + 1] + Math.cos(t * 0.11 + h * 0.13) * h * 0.045;
        pos[i + 2] = base[i + 2];
      }
      this.computeNormalsFrom(this.colossus, pos);
    }

    // ---------- ⑨ 森林風擺：樹離地越高擺越大；閃電瞬間陣風加劇 ----------
    if (this.env === "up") {
      const gust = 1 + (this.flash || 0) * 1.6;   // 閃電陣風
      for (const part of this.parts) {
        const sw = part.sway;
        if (!sw) continue;
        const { base, pos } = part;
        const amp = sw.amp * gust;
        for (let i = 0; i < base.length; i += 3) {
          // 權重 = 離地高度^1.6（樹梢擺最大、根部不動；藤蔓 h=0 → 整條微動）
          const wgt = sw.h > 0
            ? Math.pow(Math.max(0, (base[i + 2] - sw.gz) / sw.h), 1.6) : 1;
          pos[i]     = base[i]     + Math.sin(t * 0.55 + sw.ph + base[i + 2] * 0.25) * amp * wgt;
          pos[i + 1] = base[i + 1] + Math.cos(t * 0.47 + sw.ph * 1.3 + base[i + 2] * 0.20) * amp * 0.7 * wgt;
        }
      }
    }
  }

  // ==========================================================================
  // 深海環境：海床 / 礁岩 / 海洋雪（世界座標，不隨生物姿態變動）
  // ==========================================================================

  // 陣列 → typed array + 算平滑法線 + 收進 this.parts（環境與模型共用）
  finalizePart(part) {
    part.base = new Float32Array(part.base);
    part.pos = new Float32Array(part.base);
    part.faces = new Uint32Array(part.faces);
    part.normals = new Float32Array(part.base.length);
    this.computeNormals(part);
    // 環境部件不動 → 世界座標版直接指向同一份資料（省記憶體也省運算）
    part.wpos = part.pos;
    part.wnorm = part.normals;
    this.parts.push(part);
  }

  // 海床高度（礁岩「貼地」用同一條公式）
  floorZ(x, y) {
    return -12
      + 1.3 * Math.sin(x * 0.09 + 1.4) * Math.cos(y * 0.075)
      + 0.5 * Math.sin((x * 0.6 + y * 0.8) * 0.11 + 3);
  }

  // 海床：27×27 格、覆蓋 110×110 世界單位的起伏沙丘
  buildSeabed() {
    const N = 27, S = 110;
    const part = { id: "seabed", world: true, base: [], faces: [], pos: null, normals: null,
                   mat: 3,                        // 材質＝泥土（團粒/細砂/礫石紋理）
                   color: [34, 46, 74],
                   colorSea: [34, 46, 74],     // 深海：藍灰沙
                   colorUp: [46, 30, 26] };    // 逆世界：乾裂暗紅土
    const gi = (i, j) => i * (N + 1) + j;
    for (let i = 0; i <= N; i++) {
      for (let j = 0; j <= N; j++) {
        const x = (j / N - 0.5) * S, y = (i / N - 0.5) * S;
        part.base.push(x, y, this.floorZ(x, y));
      }
    }
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const a = gi(i, j), b = gi(i, j + 1), c = gi(i + 1, j + 1), d = gi(i + 1, j);
        part.faces.push(a, b, c, a, c, d);
      }
    }
    this.finalizePart(part);
  }

  // 礁岩：8 顆不規則巨礫（變形球 + 三個正弦隆起），散布在半徑 9~41 的環帶
  // ==========================================================================
  // 巨礫：Blender 變體（data/env.js）+ 每顆自己的縮放/壓扁/旋轉
  //   變體是「單位半徑」的雕刻岩石（多倍頻柏林位移 + 崩缺削邊），
  //   這裡只做實例化；位置、配色、碰撞量測邏輯與舊版一致
  // ==========================================================================
  buildRocks() {
    const meshes = ((window.ENV_MESHES || {}).groups || {}).rocks;
    if (!meshes || !meshes.length) {
      throw new Error("環境資料 data/env.js 缺少 rocks — 請先執行 blender/build_env.py");
    }
    let seed = 99;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 8; k++) {
      const ang = rnd() * Math.PI * 2;
      const rad = 9 + rnd() * 32;
      const cx = Math.cos(ang) * rad, cy = Math.sin(ang) * rad;
      const s = 1.6 + rnd() * 3.2;
      // 舊版四個「相位」rnd：ph1 改當每顆的旋轉角、ph2~4 保留抽樣 →
      //   亂數序列不變 → 8 顆石頭的位置/配色跟舊版完全一致
      const ph1 = rnd() * 6.28; rnd(); rnd(); rnd();
      const squash = 0.62 + rnd() * 0.26;          // 每顆壓扁度不同（有扁有圓）
      const cs = [26 + Math.floor(rnd() * 10), 34 + Math.floor(rnd() * 10),
                  56 + Math.floor(rnd() * 12)];               // 深海：藍灰岩
      const cu = [46 + Math.floor(rnd() * 14), 41 + Math.floor(rnd() * 10),
                  39 + Math.floor(rnd() * 10)];    // 逆世界：冷灰岩（跟紅土拉開、冷暖對比）
      const part = { id: "rock" + k, world: true, base: [], faces: [], pos: null,
                     normals: null, mat: 1, color: cs.slice(),
                     colorSea: cs, colorUp: cu };
      this.shadows.push({ x: cx, y: cy, r: s * 1.5, a: 105 }); // 接地陰影（比物體大一圈）
      const gz = this.floorZ(cx, cy);
      // 實例化：xy 乘 s、z 乘 s*squash、底部半埋 +s*0.15
      this.addInstanced(part, meshes[k % meshes.length],
                        { x: cx, y: cy, z: gz + s * 0.15, s, sz: s * squash,
                          yaw: ph1 });
      // 穿石修正：碰撞半徑 = 頂點「實測」最遠水平距離（不是寫死估的）
      let maxR = 0, topZ = -1e9;
      const b = part.base;
      for (let i = 0; i < b.length; i += 3) {
        const rr = Math.hypot(b[i] - cx, b[i + 1] - cy);
        if (rr > maxR) maxR = rr;
        if (b[i + 2] > topZ) topZ = b[i + 2];      // 石頂高度 → 飛得比它高就不用繞
      }
      this.obstacles.push({ x: cx, y: cy, r: maxR + 0.15, zTop: topZ });
      this.finalizePart(part);
    }
  }

  // 海洋雪：300 顆懸浮微粒（不是網格，render 裡畫成朝向鏡頭的小方塊）
  buildSnow() {
    let seed = 555;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    this.snow = [];
    for (let i = 0; i < 360; i++) {            // 360 顆（更細密的懸浮塵）
      this.snow.push({
        x: (rnd() - 0.5) * 52,
        y: (rnd() - 0.5) * 52,
        z: -1.0 - rnd() * 9.5,
        sp: 0.10 + rnd() * 0.22,   // 下沉速度
        ph: rnd() * 6.28,          // 橫向漂移相位
        vs: 0.55 + rnd() * 1.15,   // 每顆大小不同（軟光點尺寸）
      });
    }
    // 餘燼 / 氣泡：往「上升」的微粒（逆世界=紅熱餘燼、深海=青白氣泡），畫法同海雪
    this.motes = [];
    for (let i = 0; i < 80; i++) {
      this.motes.push({
        x: (rnd() - 0.5) * 52,
        y: (rnd() - 0.5) * 52,
        z: -10.4 + rnd() * 9.0,
        sp: 0.25 + rnd() * 0.35,   // 上升速度
        ph: rnd() * 6.28,
        vs: 0.7 + rnd() * 1.4,     // 每顆大小不同（餘燼光點更大更亮）
      });
    }
  }

  // 海雪永遠圍在生物四周：沉到底回水面重生、水平方向圍著生物捲動
  updateSnow(dt, cx, cy) {
    if (dt <= 0) return;
    // 逆世界＝怪奇物語的「灰燼飄落」：掉得更慢、橫向漂移更大（深海維持海洋雪快速下沉）
    const ashK = this.env === "up" ? 0.45 : 1;      // 下沉速度倍率
    const ashD = this.env === "up" ? 2.4 : 1;       // 橫向漂移倍率
    for (const s of this.snow) {
      s.z -= s.sp * ashK * dt;
      s.x += Math.sin(this.wt * 0.35 + s.ph) * 0.18 * ashD * dt;
      if (s.z < -10.6) s.z = -1.0;
      while (s.x < cx - 26) s.x += 52;
      while (s.x > cx + 26) s.x -= 52;
      while (s.y < cy - 26) s.y += 52;
      while (s.y > cy + 26) s.y -= 52;
    }
    // 餘燼/氣泡：反向 —— 往上升、到頂重生，一樣圍著生物捲動
    for (const s of this.motes) {
      s.z += s.sp * dt;
      s.x += Math.sin(this.wt * 0.5 + s.ph * 2) * 0.22 * dt;
      if (s.z > -1.2) s.z = -10.4;
      while (s.x < cx - 26) s.x += 52;
      while (s.x > cx + 26) s.x -= 52;
      while (s.y < cy - 26) s.y += 52;
      while (s.y > cy + 26) s.y -= 52;
    }
  }

  // ==========================================================================
  // 管子擠出：枯樹 / 樹枝 / 藤蔓 / 遠處巨影 都用它
  //   part = 要寫入的部件（base 先是普通陣列，之後再 finalize）
  //   pts  = 路徑點 [[x,y,z], ...]；r0→r1 半徑；sides 環邊數；bump 半徑起伏
  // ==========================================================================
  // flat：可選陣列（每環一個值）＝把該環的 y 向厚度乘上該係數
  //   用途：手掌是「扁的」（厚度/寬度≈0.3），圓管做出來是香腸 → 用 y 向壓扁做出掌形
  tube(part, pts, r0, r1, sides, bump, flat) {
    const rings = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const pPrev = pts[Math.max(0, i - 1)], pNext = pts[Math.min(pts.length - 1, i + 1)];
      let tx = pNext[0] - pPrev[0], ty = pNext[1] - pPrev[1], tz = pNext[2] - pPrev[2];
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      // 造一組與切線垂直的基底（t × z，退化時備案）
      let ux = -ty, uy = tx, uz = 0;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-4) { ux = 1; uy = 0; uz = 0; ul = 1; }
      ux /= ul; uy /= ul; uz /= ul;
      const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
      const f = pts.length > 1 ? i / (pts.length - 1) : 0;
      const r = (r0 + (r1 - r0) * f) * (1 + bump * Math.sin(i * 2.3 + 1.1));
      const fl = flat ? flat[i] : 1;                    // 該環的 y 向壓扁係數
      const ring = [];
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        const c = Math.cos(a) * r, s = Math.sin(a) * r;
        part.base.push(p[0] + ux * c + vx * s, p[1] + (uy * c + vy * s) * fl, p[2] + uz * c + vz * s);
        ring.push(part.base.length / 3 - 1);
      }
      rings.push(ring);
    }
    // 環與環之間接面（每個四邊形拆兩個三角形）
    for (let i = 0; i < rings.length - 1; i++) {
      const A = rings[i], B = rings[i + 1];
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides;
        part.faces.push(A[k], A[k2], B[k2], A[k], B[k2], B[k]);
      }
    }
  }

  // ==========================================================================
  // Blender 變體實例化：把 data/env.js 的變體網格套上「平移/縮放/旋轉」寫進 part
  //   變體都在原點、單位尺寸（石頭半徑≈1、樹高≈1）→ 這裡乘上世界尺寸
  //   m = { x,y,z 平移, s xy 縮放, sz z 縮放(預設=s), yaw 繞 z 旋轉(弧度) }
  // ==========================================================================
  addInstanced(part, mesh, m) {
    const v = mesh.vertices;                     // 交錯 [x,y,z, x,y,z, ...]
    const off = part.base.length / 3;            // 面索引要加上「已有的頂點數」
    const yaw = m.yaw || 0;
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    const s = m.s, sz = (m.sz === undefined) ? m.s : m.sz;
    for (let i = 0; i < v.length; i += 3) {
      let x = v[i] * s, y = v[i + 1] * s, z = v[i + 2] * sz;
      if (yaw) { const rx = x * cyw - y * syw; y = x * syw + y * cyw; x = rx; }
      part.base.push(m.x + x, m.y + y, m.z + z);
    }
    const f = mesh.faces;
    for (let i = 0; i < f.length; i++) part.faces.push(off + f[i]);
  }

  // 身體部件版的收尾（跟 finalizePart 差在 wpos/wnorm 必須是獨立陣列 —
  // 每幀 worldize 會邊讀 pos 還寫 wpos，同個陣列會互踩）
  finalizeBodyPart(part) {
    part.base = new Float32Array(part.base);
    part.pos = new Float32Array(part.base);
    part.faces = new Uint32Array(part.faces);
    part.normals = new Float32Array(part.base.length);
    part.wpos = new Float32Array(part.base.length);
    part.wnorm = new Float32Array(part.base.length);
    this.computeNormals(part);
    this.parts.push(part);
  }

  // ==========================================================================
  // 複眼球體分組：用面的相連性找出「每一顆眼」的頂點集合（抽象模式下各自漂浮）
  // ==========================================================================
  buildEyeGroups() {
    const eyes = this.eyes;
    const n = eyes.base.length / 3;
    const adj = Array.from({ length: n }, () => []);
    const f = eyes.faces;
    for (let i = 0; i < f.length; i += 3) {
      adj[f[i]].push(f[i + 1], f[i + 2]);
      adj[f[i + 1]].push(f[i], f[i + 2]);
      adj[f[i + 2]].push(f[i], f[i + 1]);
    }
    const seen = new Uint8Array(n);
    const groups = [];
    for (let s = 0; s < n; s++) {
      if (seen[s]) continue;
      const verts = [];
      const stack = [s];
      seen[s] = 1;
      while (stack.length) {
        const v = stack.pop();
        verts.push(v);
        for (const w of adj[v]) if (!seen[w]) { seen[w] = 1; stack.push(w); }
      }
      // 每顆眼的中心點（人形化 Ⅱ 隻：眼球群要收攏進「人頭眼窩」用）
      let cx = 0, cy = 0, cz = 0;
      for (const v of verts) {
        cx += eyes.base[v * 3]; cy += eyes.base[v * 3 + 1]; cz += eyes.base[v * 3 + 2];
      }
      cx /= verts.length; cy /= verts.length; cz /= verts.length;
      groups.push({
        verts, cx, cy, cz,
        w0: 0.9 + (groups.length % 5) * 0.17,   // 毎顆眼各自的漂浮頻率/相位
        w1: 0.7 + (groups.length % 4) * 0.23,
        w2: 1.1 + (groups.length % 3) * 0.19,
        ph: (groups.length * 2.399) % 6.28,
      });
    }
    this.eyeGroups = groups;
  }

  // ==========================================================================
  // 逆世界：枯樹（彎曲樹幹 + 下垂枯枝）
  // ==========================================================================
  buildTrees() {
    const M = ((window.ENV_MESHES || {}).groups || {});
    if (!M.trees || !M.trees.length || !M.treesFar || !M.treesFar.length) {
      throw new Error("環境資料 data/env.js 缺少 trees — 請先執行 blender/build_env.py");
    }
    let seed = 777;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 9; k++) {
      const ang = rnd() * Math.PI * 2;
      const rad = 14 + rnd() * 30;
      const cx = Math.cos(ang) * rad, cy = Math.sin(ang) * rad;
      const gz = this.floorZ(cx, cy);
      const part = { id: "tree" + k, world: true, env: "up", base: [], faces: [],
                     pos: null, normals: null, wpos: null, wnorm: null,
                     mat: 2,                        // 樹皮紋理（縱向溝紋）
                     color: [24, 16, 15] };
      // Blender 變體是「單位高 1、基座 z≈0」的雕刻枯樹（根張+下垂枯枝+垂掛藤蔓）
      // → 乘樹高 h、放到 gz-1.2 → 樹梢正好 gz-1.2+h（風擺權重 0→1 對齊）
      const h = 7 + rnd() * 4.5;                 // 高 7~11.5
      this.addInstanced(part, M.trees[k % M.trees.length],
                        { x: cx, y: cy, z: gz - 1.2, s: h, sz: h,
                          yaw: rnd() * Math.PI * 2 });
      this.finalizePart(part);
      part.sway = { gz: gz - 1.2, h, ph: rnd() * 6.28, amp: 0.26 + rnd() * 0.16 };
      this.trees.push({ x: cx, y: cy, r: 2.2 });
      this.obstacles.push({ x: cx, y: cy, r: 2.2, zTop: gz + h + 2 });  // +2 = 樹枝高度餘裕
      this.shadows.push({ x: cx, y: cy, r: 3.2, a: 95 });   // 樹根陰影
    }

    // ---- 遠景枯樹剪影：圍在活動範圍外（r 48~78），更高大、近黑 → 霧吃成剪影 ----
    for (let k = 0; k < 14; k++) {
      const ang = rnd() * Math.PI * 2;
      const rad = 48 + rnd() * 30;
      const cx = Math.cos(ang) * rad, cy = Math.sin(ang) * rad;
      const gz = this.floorZ(cx, cy);
      const part = { id: "farTree" + k, world: true, env: "up", base: [], faces: [],
                     pos: null, normals: null, wpos: null, wnorm: null,
                     mat: 2,                        // 樹皮紋理（遠景也吃，剪影更有層次）
                     color: [14, 9, 10] };
      const h = 12 + rnd() * 9;                      // 比近樹更高大
      this.addInstanced(part, M.treesFar[k % M.treesFar.length],
                        { x: cx, y: cy, z: gz - 2, s: h, sz: h,
                          yaw: rnd() * Math.PI * 2 });
      this.finalizePart(part);
      part.sway = { gz: gz - 2, h, ph: rnd() * 6.28, amp: 0.45 + rnd() * 0.3 };
      // 遠景樹不做障礙物（生物游不到那裡）
    }
  }

  // ==========================================================================
  // 逆世界：地面碎屑／乾裂深色斑塊（40 片貼著地表的深色多邊形 → 紅土有細節）
  // ==========================================================================
  buildLitter() {
    let seed = 1212;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const part = { id: "litter", world: true, env: "up", base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   mat: 3,                        // 土壤碎屑 → 泥土紋理
                   color: [20, 11, 10] };
    for (let k = 0; k < 40; k++) {
      const ang = rnd() * 6.28, rad = 3 + rnd() * 46;
      const cx = Math.cos(ang) * rad, cy = Math.sin(ang) * rad;
      const r = 0.8 + rnd() * 2.6, n = 5 + Math.floor(rnd() * 3);
      const rot = rnd() * 6.28;
      const vi = part.base.length / 3;
      part.base.push(cx, cy, this.floorZ(cx, cy) + 0.06);   // 中心點
      for (let i = 0; i < n; i++) {
        const a = rot + (i / n) * 6.28;
        const rr = r * (0.6 + rnd() * 0.7);                 // 邊緣不規則
        const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr;
        part.base.push(x, y, this.floorZ(x, y) + 0.06);
      }
      for (let i = 0; i < n; i++) {
        part.faces.push(vi, vi + 1 + i, vi + 1 + ((i + 1) % n));
      }
    }
    this.finalizePart(part);
  }

  // ==========================================================================
  // 逆世界：地面藤蔓（沿海床蜿蜒爬行、疙瘩起伏）
  // ==========================================================================
  buildVines() {
    const meshes = ((window.ENV_MESHES || {}).groups || {}).vines;
    if (!meshes || !meshes.length) {
      throw new Error("環境資料 data/env.js 缺少 vines — 請先執行 blender/build_env.py");
    }
    let seed = 313;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 5; k++) {
      const part = { id: "vine" + k, world: true, env: "up", base: [], faces: [],
                     pos: null, normals: null, wpos: null, wnorm: null,
                     mat: 4,                        // 藤蔓皮紋理（斑塊+細孔）
                     color: [58, 26, 26] };
      const a = rnd() * Math.PI * 2;
      const x0 = Math.cos(a) * (10 + rnd() * 8), y0 = Math.sin(a) * (10 + rnd() * 8);
      const yaw = rnd() * Math.PI * 2;
      const mesh = meshes[k % meshes.length];
      // Blender 變體：蜿蜒+疙瘩的藤蔓管、中心線在局部 z=0
      // → 逐頂點旋轉/平移後「貼地」（每個頂點各自量 floorZ → 跟著地形起伏）
      const v = mesh.vertices;
      const cyw = Math.cos(yaw), syw = Math.sin(yaw);
      for (let i = 0; i < v.length; i += 3) {
        const x = x0 + v[i] * cyw - v[i + 1] * syw;
        const y = y0 + v[i] * syw + v[i + 1] * cyw;
        part.base.push(x, y, this.floorZ(x, y) + 0.30 + v[i + 2]);
      }
      const f = mesh.faces;
      for (let i = 0; i < f.length; i++) part.faces.push(f[i]);
      this.finalizePart(part);
    }
  }

  // ==========================================================================
  // 逆世界：地面孢子囊光點（怪奇物語「逆世界」的蒼白青綠微光）
  //   不是網格 —— drawParticles 裡畫成朝向鏡頭的軟光點（加法疊光、慢呼吸脈動）
  // ==========================================================================
  buildPods() {
    let seed = 909;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    this.pods = [];
    for (let c = 0; c < 6; c++) {                    // 6 群、每群 4~7 顆（成簇才像群落）
      const ang = rnd() * Math.PI * 2;
      const rad = 7 + rnd() * 22;                    // 活動範圍內（半徑 7~29）
      const ccx = Math.cos(ang) * rad, ccy = Math.sin(ang) * rad;
      const n = 4 + Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const x = ccx + (rnd() - 0.5) * 4.5;
        const y = ccy + (rnd() - 0.5) * 4.5;
        this.pods.push({
          x, y,
          z: this.floorZ(x, y) + 0.18,               // 貼著起伏地面（跟著地形高低）
          vs: 0.6 + rnd() * 1.0,                     // 每顆大小不同
          ph: rnd() * 6.28,                          // 呼吸相位錯開（不會整群同步閃）
        });
      }
    }
  }

  // ==========================================================================
  // 逆世界：遠處的巨大黑影（歪扭高塔 + 撐地粗腳，緩慢擺動、大半隱在霧裡）
  // ==========================================================================
  buildColossus() {
    const gx = 28, gy = 22;                       // 半徑 ~35.6（霧裡只露剪影、又不會太遠）
    const gz = this.floorZ(gx, gy);
    const part = { id: "colossus", world: true, env: "up", base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [12, 7, 10] };
    // 主塔：地面向上 ~29 的 S 形巨柱，半徑劇烈起伏 → 歪扭剪影
    const pts = [];
    let x = gx, y = gy, z = gz - 2;
    for (let i = 0; i <= 9; i++) {
      pts.push([x, y, z]);
      z += 3.2;
      x += Math.sin(i * 0.9 + 1.3) * 1.4 + 0.4;
      y += Math.cos(i * 0.7 + 0.4) * 1.2;
    }
    this.tube(part, pts, 5.2, 0.7, 8, 0.45);
    // 4 隻撐地的粗腳
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.5;
      const bp = [
        [gx + Math.cos(a) * 1.5, gy + Math.sin(a) * 1.5, gz + 3],
        [gx + Math.cos(a) * 4.5, gy + Math.sin(a) * 4.5, gz + 1],
        [gx + Math.cos(a) * 8.5, gy + Math.sin(a) * 8.5, gz - 1.5],
      ];
      this.tube(part, bp, 1.6, 0.5, 6, 0.30);
    }
    // 2 條高處垂落的觸鬚
    for (let k = 0; k < 2; k++) {
      const a = k * Math.PI + 0.8;
      const tp = [
        [pts[6][0], pts[6][1], pts[6][2]],
        [pts[6][0] + Math.cos(a) * 3, pts[6][1] + Math.sin(a) * 3, pts[6][2] - 3],
        [pts[6][0] + Math.cos(a) * 5, pts[6][1] + Math.sin(a) * 5, pts[6][2] - 8],
      ];
      this.tube(part, tp, 0.9, 0.15, 5, 0.4);
    }
    this.finalizePart(part);
    this.colossus = part;
    this.colossusBaseZ = gz;
    this.obstacles.push({ x: gx, y: gy, r: 9, zTop: gz + 40 });   // 腿腳的迴避範圍（巨塔永遠高過生物）
    this.shadows.push({ x: gx, y: gy, r: 10.5, a: 85 });   // 巨影腳下大片暗斑
    // 巨影背後的紅色風暴光暈：同一條射線更遠處 → 黑塔永遠襯在紅光前（剪影才讀得出來）
    this.stormGlow = { x: gx * 1.5, y: gy * 1.5, z: gz + 17, r: 15 };
  }

  // ==========================================================================
  // 遠景山脊：地平線外一圈高低起伏的黑色丘陵剪影（深海=海底山脊 / 逆世界=焦黑山群）
  //   半徑 95~125 → 大半沉在霧裡，只剩頂緣輪廓 → 地平線有「遠近」層次
  // ==========================================================================
  buildRidge() {
    let seed = 4242;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const NSEG = 96;                        // 一圈 96 段（剪影要夠密才順）
    const part = { id: "ridge", world: true, base: [], faces: [], pos: null, normals: null,
                   mat: 1,                        // ★岩石紋理（fbm4+ridge3）→ 山有岩理層次而不是死黑剪影
                   fogStart: 55, fogDens: 0.020,  // ★自己的淡霧（環境的 0.05 在 95 單位外會吃掉 94%）
                   color: [10, 6, 9],
                   colorSea: [30, 44, 70],  // 深海：藍灰海底山脊（提亮 → 不再死黑）
                   colorUp: [34, 18, 15] };  // 逆世界：焦黑帶紅的山群
    // 每個角度一「根」山：先用三個不同頻率的正弦疊出山峰高低，再加抖動
    const hAt = a =>
      4 + 10 * Math.max(0, Math.sin(a * 2.7 + 1.1))
        + 6 * Math.max(0, Math.sin(a * 6.1 + 4.0))
        + 3 * Math.sin(a * 13.7) + rnd() * 2.2;
    const gi = (i, ring) => i * 2 + ring;   // 頂點編號：每段 [底, 頂]
    for (let i = 0; i < NSEG; i++) {
      const a = (i / NSEG) * Math.PI * 2;
      const r = 95 + Math.sin(a * 3.3) * 12 + rnd() * 8;   // 半徑也起伏 → 不是正圓牆
      const h = hAt(a);
      const gz = this.floorZ(Math.cos(a) * r, Math.sin(a) * r);
      part.base.push(Math.cos(a) * r, Math.sin(a) * r, gz - 6);        // 底（埋進地平线下）
      part.base.push(Math.cos(a) * r, Math.sin(a) * r, gz - 6 + h);    // 頂（山脊線）
    }
    for (let i = 0; i < NSEG; i++) {
      const j = (i + 1) % NSEG;
      part.faces.push(gi(i, 0), gi(j, 0), gi(j, 1),
                      gi(i, 0), gi(j, 1), gi(i, 1));
    }
    this.finalizePart(part);
  }

  // ==========================================================================
  // 觸手 ×16：取代已刪除的角冠/羽鬚 —— 頭頂環 6 + 面下腕足 6 + 腹部垂鬚 4
  //   拓撲用共用的 tube() 一次建好；「位置」每幀在 update() ③ 從路徑重算
  // ==========================================================================
  buildTentacles() {
    const part = { id: "tentacles", world: false, base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [140, 96, 156] };   // 紫灰，跟腹膜同色系
    this.tentacleDefs = [];
    let seed = 2026;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const SEGS = 8, SIDES = 6;

    // 一條觸手 = 掛點 + 方向 + 長度 + 粗細 + 晃動頻率 + 下垂量
    const add = (root, dir, len, r0, r1, w, droop) => {
      const dl = Math.hypot(dir[0], dir[1], dir[2]);
      const d = { root, dir: [dir[0] / dl, dir[1] / dl, dir[2] / dl], len, r0, r1,
                  w, droop, ph: rnd() * 6.28,
                  start: part.base.length / 3, segs: SEGS, sides: SIDES };
      // rest 路徑（只用來建管狀拓撲；真實位置每幀由 update 重算）
      const pts = [];
      for (let i = 0; i <= SEGS; i++) {
        const f = i / SEGS;
        pts.push([d.root[0] + d.dir[0] * len * f,
                  d.root[1] + d.dir[1] * len * f,
                  d.root[2] + d.dir[2] * len * f - droop * f * f]);
      }
      this.tube(part, pts, r0, r1, SIDES, 0);
      d.path = new Float32Array(3 * (SEGS + 1));   // 每幀的路徑中心（平陣列不產生垃圾）
      this.tentacleDefs.push(d);
    };

    // ① 頭頂環 6 條：原本長角冠/羽鬚的位置 → 現在是一叢往前上方散開的觸手
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      add([Math.cos(a) * 0.28, 1.44 + rnd() * 0.16, 0.26 + rnd() * 0.10],
          [Math.cos(a) * 0.5, 0.9, 0.42 + rnd() * 0.25],
          1.8 + rnd() * 1.0, 0.15 + rnd() * 0.05, 0.03,
          1.0 + rnd() * 0.7, 0.10);
    }
    // ② 面下（口器側）6 條：往前下張開，像烏賊的腕足
    for (let k = 0; k < 6; k++) {
      const a = ((k + 0.5) / 6) * Math.PI * 2;
      add([Math.cos(a) * 0.34, 1.02 + rnd() * 0.28, -0.20 - rnd() * 0.10],
          [Math.cos(a) * 0.55, 0.8, -0.5],
          2.2 + rnd() * 0.9, 0.16 + rnd() * 0.05, 0.03,
          0.8 + rnd() * 0.6, 0.40);
    }
    // ③ 腹部垂鬚 4 條：往後下拖曳，游動時在身體下方飄（有海床夾制不插沙）
    for (let k = 0; k < 4; k++) {
      const s = k % 2 === 0 ? 1 : -1;
      add([s * (0.45 + rnd() * 0.45), 0.45 - rnd() * 0.9, -0.34],
          [s * 0.28, -0.4, -0.85],
          2.3 + rnd() * 0.8, 0.18, 0.035,
          0.6 + rnd() * 0.5, 0.25);
    }
    this.finalizeBodyPart(part);
    this.tentacles = part;
  }

  // ==========================================================================
  // 人形背觸手（人形完成體專屬）：背上長滿一排觸手 ——
  //   平時伏貼垂墜在背上；捕食時 walker.eatenBy 設 this.tentHunt →
  //   ⑤h 每幀重算路徑：暴射而出 → 纏住獵物打圈 → 跟著拖回嘴邊
  // ==========================================================================
  buildBackTents() {
    const part = { id: "backTents", world: false, base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [178, 132, 148] };     // 淡紫膚色：跟身體同色系但偏紫、暗背景下也看得清
    this.backTentDefs = [];
    let seed = 517;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const SEGS = 8, SIDES = 6;
    // 背脊 5 列 × 左右 2 支 = 10 條；根部 y=-0.08 埋進軀幹裡（背表面約 y=-0.24）
    for (let row = 0; row < 5; row++) {
      for (const s of [1, -1]) {
        const z = 1.38 - row * 0.275 + rnd() * 0.06;      // 從肩到腰
        const len = 0.52 + row * 0.09 + rnd() * 0.10;     // 越往下越長（垂墜感）
        const r0 = 0.090 + rnd() * 0.012;              // 根部加粗 → 一眼看出「背長滿觸手」
        const d = {
          root: [s * (0.10 + rnd() * 0.03), -0.08, z],
          len, r0, r1: 0.012, side: s, ph: rnd() * 6.28,
          start: part.base.length / 3, segs: SEGS, sides: SIDES,
        };
        // rest 路徑：往後下垂（只用來建管狀拓撲；真實位置每幀由⑤h 重算）
        const pts = [];
        for (let i = 0; i <= SEGS; i++) {
          const f = i / SEGS;
          pts.push([d.root[0] + s * 0.12 * f,
                    d.root[1] - 0.10 * f,
                    d.root[2] - d.len * f - 0.14 * f * f]);
        }
        this.tube(part, pts, r0, d.r1, SIDES, 0);
        d.path = new Float32Array(3 * (SEGS + 1));       // 每幀的路徑中心（平陣列不產生垃圾）
        this.backTentDefs.push(d);
      }
    }
    this.finalizeBodyPart(part);
    this.backTents = part;
  }

  // ==========================================================================
  // 觸鬚頭髮：頭皮一圈圈長出的觸手「頭髮」——
  //   頭頂冠（噴泉散開）、後腦長瀑、臉側長鎖、額前短劉海（左右分線）
  //   錨點每幀從「頸根 → 頭中心」插值（跟⑤d 臉同一組）→ 跟著頭部縮放/姿態
  //   拓撲照 backTents：tube() 建管狀、path Float32Array 每幀由 ⑤f 重寫
  // ==========================================================================
  buildHairTents() {
    const part = { id: "hairTents", world: false, base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [150, 106, 126] };    // 暗紫灰（uAlien 蒼白化 → 蒼紫「髮色」）
    this.hairDefs = [];
    let seed = 5321;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const SEGS = 8, SIDES = 5;
    // 一圈布丁：theta = 離頭頂的角度；phi = 繞頭角度（0 = 臉正前方、±π = 後腦）
    const ring = (theta, phiFrom, phiTo, count, len, a1) => {
      for (let i = 0; i < count; i++) {
        const k = count === 1 ? 0.5 : i / (count - 1);
        const d = {
          theta: theta + (rnd() - 0.5) * 0.14,
          phi: phiFrom + (phiTo - phiFrom) * k + (rnd() - 0.5) * 0.18,
          len: len * (0.85 + rnd() * 0.30),        // 長短不一 → 自然
          a0: 0.90 + rnd() * 0.30,                 // 離頭皮的起始角（上揚）
          a1,                                      // 末端角（負 = 垂下；越負越垂直）
          r0: 0.050 + rnd() * 0.014,               // 根部粗
          ph: rnd() * 6.28, ph2: rnd() * 6.28,     // 各自的擺動相位
          start: part.base.length / 3, segs: SEGS, sides: SIDES,
        };
        // rest 路徑：只用來建管狀拓撲（真實位置每幀由 ⑤f 重算）
        const ct = Math.cos(d.theta), st = Math.sin(d.theta);
        const cp = Math.cos(d.phi), sp = Math.sin(d.phi);
        const pts = [];
        for (let s = 0; s <= SEGS; s++) {
          const f = s / SEGS;
          pts.push([(cp * st) * 0.42, (sp * st) * 0.42,
                    ct * 0.42 - d.len * f * f]);
        }
        this.tube(part, pts, d.r0, 0.010, SIDES, 0);
        d.path = new Float32Array(3 * (SEGS + 1));   // 每幀的路徑中心（平陣列不產生垃圾）
        this.hairDefs.push(d);
      }
    };
    ring(0.32, -Math.PI, Math.PI, 6, 0.95, -1.05);  // 頭頂冠：一圈向四周噴泉垂落
    ring(0.95, 2.35, 3.95, 6, 1.50, -1.45);         // 後腦：長瀑披到背後
    ring(1.00, 1.05, 1.75, 3, 1.15, -1.40);         // 臉側長鎖（左）
    ring(1.00, -1.75, -1.05, 3, 1.15, -1.40);       // 臉側長鎖（右）
    ring(0.60, 0.32, 1.05, 3, 0.30, -1.50);         // 劉海左（分線在臉中央 → 不蓋眼）
    ring(0.60, -1.05, -0.32, 3, 0.30, -1.50);       // 劉海右
    this.finalizeBodyPart(part);
    this.hairTents = part;
  }

  // ==========================================================================
  // 抽象碎片：7 顆繞著生物鬆散自轉的八面體（抽象度 > 5% 才畫）
  // ==========================================================================
  buildShards() {
    let seed = 4242;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const part = { id: "shards", world: false, base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [96, 118, 176] };
    this.shardDefs = [];
    for (let k = 0; k < 7; k++) {
      const size = 0.14 + rnd() * 0.24;
      const start = part.base.length / 3;
      part.base.push(
        size, 0, 0,   -size, 0, 0,   0, size * 1.7, 0,
        0, -size * 1.7, 0,   0, 0, size,   0, 0, -size
      );
      const F = [0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4,
                 0, 5, 2, 2, 5, 1, 1, 5, 3, 3, 5, 0];
      for (const idx of F) part.faces.push(start + idx);
      this.shardDefs.push({
        start, w: 0.5 + rnd() * 0.7, ph: rnd() * 6.28,
        ox: (rnd() - 0.5) * 3.4, oy: (rnd() - 0.5) * 3.2, oz: (rnd() - 0.5) * 2.6 + 0.6,
        spin: (rnd() - 0.5) * 1.8,
      });
    }
    this.finalizeBodyPart(part);
    this.shards = part;
  }

  // ==========================================================================
  // 動態管子寫入：從 part.pos 的 start（頂點編號）開始覆寫一節節環
  //   數學與 tube()/觸手重建完全一致 → 面（拓撲）建一次、位置每幀重算
  // ==========================================================================
  // flat：跟 tube() 同一套壓扁規則（建拓撲與每幀重寫必須完全一致，否則手掌會跳動）
  writeTubeAt(arr, start, pts, r0, r1, sides, flat) {
    let vi = start * 3;
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
      const f = pts.length > 1 ? i / (pts.length - 1) : 0;
      const r = r0 + (r1 - r0) * f;
      const fl = flat ? flat[i] : 1;                    // 跟 tube() 同一套壓扁
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        const c = Math.cos(a) * r, s = Math.sin(a) * r;
        arr[vi++] = p[0] + ux * c + vx * s;
        arr[vi++] = p[1] + (uy * c + vy * s) * fl;
        arr[vi++] = p[2] + uz * c + vz * s;
      }
    }
  }

  // ==========================================================================
  // 異形背棘：沿背脊 7 根骨刺，根部錨定「變形後的軀幹頂點」→ 棘刺貼背長
  //   生長量 = 進食數（meals 0→6）：0 隻 = 小凸起，越吃越長越彎（像異形）
  // ==========================================================================
  buildAlienSpines() {
    const part = { id: "spines", world: false, base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [150, 44, 52] };   // 暗紅骨節（uAlien 會把它染成蒼白骨色）
    const SIDES = 5, RINGS = 4;
    this.spineDefs = [];
    let seed = 808;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    // 背脊目標高度（頭後 → 尾前）；錨點 = 軀幹上最接近、且在「背上」的頂點
    const ys = [1.15, 0.78, 0.40, 0.02, -0.38, -0.80, -1.22];
    const tb = this.torso.base;
    for (let k = 0; k < ys.length; k++) {
      let best = -1, bd = 1e9;
      for (let i = 0; i < tb.length; i += 3) {     // 背上 = |x| 小、z 朝上
        if (Math.abs(tb[i]) > 0.32 || tb[i + 2] < 0.15) continue;
        const d = Math.abs(tb[i + 1] - ys[k]);
        if (d < bd) { bd = d; best = i / 3; }
      }
      if (best < 0) continue;
      const root = [tb[best * 3], tb[best * 3 + 1], tb[best * 3 + 2]];
      const len = 1.0 + rnd() * 0.7;             // 靜止長度（生長係數另外乘）
      const r0 = 0.16 + rnd() * 0.09;
      const start = part.base.length / 3;
      // 拓撲：rest 路徑（每幀由 update() 依變形後的背脊重寫）
      const pts = [];
      for (let i = 0; i < RINGS; i++) {
        const f = i / (RINGS - 1);
        pts.push([root[0], root[1] - 0.32 * len * f, root[2] + len * f]);
      }
      this.tube(part, pts, r0, 0.012, SIDES, 0);
      this.spineDefs.push({ v: best, start, len, r0, SIDES, RINGS,
                            ph: rnd() * 6.28 });
    }
    this.finalizeBodyPart(part);
    this.spines = part;
  }

  // ==========================================================================
  // 頭部座標軸（人臉/人手共用）：fwd = 吻端朝向（吃吻端法線）、up = 上下、right = 左右
  //   每幀從「變形後的軀幹」重算 → 五官與手臂永遠貼著身體
  // ==========================================================================
  headAxes() {
    const i3 = this.faceDef.hv * 3;
    const tn = this.torso.normals;
    let fx = tn[i3], fy = tn[i3 + 1], fz = tn[i3 + 2];
    const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
    // up = 世界 z(0,0,1) 投影到「垂直於 fwd」的平面（身體沒有側滾時 ≈ +Z）
    let ux = -fx * fz, uy = -fy * fz, uz = 1 - fz * fz;
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    // right = fwd × up
    const rx = fy * uz - fz * uy, ry = fz * ux - fx * uz, rz = fx * uy - fy * ux;
    return { f: [fx, fy, fz], u: [ux, uy, uz], r: [rx, ry, rz] };
  }

  // ==========================================================================
  // 異形人臉（威可那人形化）：
  //   faceRidge = 眉脊 + 鼻梁（皮膚色 → 吃 uAlien 蒼白化，跟着身體一起着色）
  //   faceHoles = 深色眼窩×2 + 嘴縫（近黑 → 之後用預設着色器單獨畫，永遠是黑洞）
  //   錨點 = 軀幹「吻端」頂點（+Y 最前端）；尺寸隨進食數 k 從吻端長出來
  // ==========================================================================
  buildAlienFace() {
    const tb = this.torso.base;
    // 找吻端中心：|x| 很小、y 最大的軀幹頂點
    let hv = -1, by = -1e9;
    for (let i = 0; i < tb.length; i += 3) {
      if (Math.abs(tb[i]) > 0.30) continue;
      if (tb[i + 1] > by) { by = tb[i + 1]; hv = i / 3; }
    }
    if (hv < 0) return;
    this.faceDef = { hv };                    // headAxes() 會讀這個
    const H = [tb[hv * 3], tb[hv * 3 + 1], tb[hv * 3 + 2]];
    const ax = this.headAxes();
    // P(u, v, n) = 吻端 + 左右*u + 上下*v + 朝前*n（建模時用全尺寸）
    const P = (u, v, n) => [
      H[0] + ax.r[0] * u + ax.u[0] * v + ax.f[0] * n,
      H[1] + ax.r[1] * u + ax.u[1] * v + ax.f[1] * n,
      H[2] + ax.r[2] * u + ax.u[2] * v + ax.f[2] * n,
    ];

    // ---- 眉脊（6 環管）+ 鼻梁（3 環管）：皮膚色、拓撲先建、每幀重寫位置 ----
    const ridge = { id: "faceRidge", world: false, base: [], faces: [],
                    pos: null, normals: null, wpos: null, wnorm: null,
                    color: [178, 156, 148] };        // 蒼白膚色（uAlien 再加深）
    const browStart = 0;
    const browPts = [];
    for (let i = 0; i < 6; i++) {
      const uu = i / 5 - 0.5, q = uu * 2;
      browPts.push(P(uu * 0.60, 0.20 + 0.05 * (1 - q * q), 0.06 - 0.03 * q * q));
    }
    this.tube(ridge, browPts, 0.055, 0.045, 5, 0);        // 眉脊：橫跨額頭、中央略高
    const noseStart = ridge.base.length / 3;
    this.tube(ridge, [P(0, 0.10, 0.03), P(0, 0.01, 0.07), P(0, -0.08, 0.10)],
              0.035, 0.06, 5, 0);                          // 鼻樑：下端 = 鼻頭
    // ---- 唇形：上下兩條細管貼著嘴縫（有嘴唇 → 不再是「一條黑膠帶」貼在臉上）----
    //（半徑小、只微微外凸 0.005 → 是「唇」不是插在臉上的兩根管子）
    const lipStart = ridge.base.length / 3;
    const lipPts = (dv) => { const arr = [];
      for (let i = 0; i < 8; i++) { const uu = i / 7 - 0.5, q = uu * 2;
        arr.push(P(uu * 0.300, -0.195 + 0.020 * q * q + dv, 0.040 - 0.026 * q * q)); }
      return arr; };
    this.tube(ridge, lipPts( 0.020), 0.011, 0.011, 5, 0);   // 上唇（薄）
    this.tube(ridge, lipPts(-0.022), 0.013, 0.013, 5, 0);   // 下唇（略厚）
    this.finalizeBodyPart(ridge);
    this.faceRidge = ridge;

    // ---- 眼窩（橢圓凸面盤：中心 + 8 圈，左右各一）+ 嘴縫（8 段帶狀）----
    const holes = { id: "faceHoles", world: false, base: [], faces: [],
                    pos: null, normals: null, wpos: null, wnorm: null,
                    color: [12, 7, 8] };                  // 近黑（不吃 uAlien，保持黑洞）
    const sockStart = [];
    for (const su of [-0.15, 0.15]) {
      sockStart.push(holes.base.length / 3);
      const c = P(su, 0.06, 0.045);                       // 中心微凸（深色眼球感）
      holes.base.push(c[0], c[1], c[2]);
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 6.28318;
        const q = P(su + Math.cos(a) * 0.105, 0.06 + Math.sin(a) * 0.055, 0.012);
        holes.base.push(q[0], q[1], q[2]);
      }
      const s = sockStart[sockStart.length - 1];
      for (let i = 0; i < 8; i++)
        holes.faces.push(s, s + 1 + i, s + 1 + ((i + 1) % 8));
    }
    const mouthStart = holes.base.length / 3;
    for (let i = 0; i < 8; i++) {
      const uu = i / 7 - 0.5, q = uu * 2;
      const zm = -0.195 + 0.020 * q * q;                  // 略低於鼻頭、嘴角微微上揚（跟動畫一致）
      const nn = 0.035 - 0.030 * q * q;                   // 中央貼臉、兩端收進臉頰
      const top = P(uu * 0.30, zm + 0.015, nn);
      const bot = P(uu * 0.30, zm - 0.015, nn);
      holes.base.push(top[0], top[1], top[2], bot[0], bot[1], bot[2]);
    }
    for (let i = 0; i < 7; i++) {                         // 帶狀四邊形 → 三角形
      const a = mouthStart + i * 2, b = a + 2;
      holes.faces.push(a, a + 1, b + 1, a, b + 1, b);
    }
    // 瞳孔 ×2（中心 + 6 圈近黑小圓盤）：位置每幀由 ⑤d 重算、貼到眼球正前方
    const pupilStart = [];
    for (const su of [-0.145, 0.145]) {
      pupilStart.push(holes.base.length / 3);
      const c = P(su, 0.06, 0.09);                       // 占位座標（動畫每幀覆寫）
      holes.base.push(c[0], c[1], c[2]);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * 6.28318;
        const q = P(su + Math.cos(a) * 0.03, 0.06 + Math.sin(a) * 0.03, 0.09);
        holes.base.push(q[0], q[1], q[2]);
      }
      const s = pupilStart[pupilStart.length - 1];
      for (let i = 0; i < 6; i++)
        holes.faces.push(s, s + 1 + i, s + 1 + ((i + 1) % 6));
    }
    this.finalizeBodyPart(holes);
    this.faceHoles = holes;
    Object.assign(this.faceDef, { browStart, noseStart, lipStart, sockStart, mouthStart, pupilStart });
  }

  // ==========================================================================
  // 異形人手（威可那人形化）：左右各一隻 —— 前臂 + 手掌 + 四指 + 拇指
  //   錨點 = 軀幹「肩點」（身體前段側緣）；整隻手隨進食數 k 長出來
  // ==========================================================================
  buildAlienHands() {
    if (!this.faceDef) return;                  // 人臉沒建成 → 沒有座標軸可用（保險閘）
    const part = { id: "hands", world: false, base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [166, 144, 138] };        // 蒼白膚色（uAlien 染成人膚）
    // 爪部件（手指甲＋腳爪共用）：深色角質 → 不吃 uAlien 蒼白化、跟眼窩同一個繪製 pass
    this.claws = { id: "claws", world: false, base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [42, 30, 32] };           // 暗褐角質
    const tb = this.torso.base;
    this.handDefs = [];
    for (const side of [1, -1]) {
      // 肩點：y 在身體前段、z 在側面高度、找 |x| ≈ 0.85 的頂點（太外側 = 翼尖）
      let best = -1, bd = 1e9;
      for (let i = 0; i < tb.length; i += 3) {
        const x = tb[i], y = tb[i + 1], z = tb[i + 2];
        if (y < 0.5 || y > 1.4 || z < -0.28 || z > 0.05) continue;
        if ((x > 0 ? 1 : -1) !== side) continue;
        const d = Math.abs(Math.abs(x) - 0.85);
        if (d < bd) { bd = d; best = i / 3; }
      }
      if (best < 0) continue;
      const def = { side, v: best, starts: [], cstarts: [] };
      const S = [tb[best * 3], tb[best * 3 + 1], tb[best * 3 + 2]];
      // 拓撲：與 handPaths() 完全同順序建管子（建模時 k=1 全尺寸）
      const { main, claws } = this.handPaths(def, S, 1, 0);
      for (const spec of main) {
        def.starts.push(part.base.length / 3);
        this.tube(part, spec.pts, spec.r0, spec.r1, spec.sides, 0, spec.flat);
      }
      // 指甲：建進獨立 claws 部件（環數必須跟 handPaths 回傳的爪 spec 完全一致）
      for (const spec of claws) {
        def.cstarts.push(this.claws.base.length / 3);
        this.tube(this.claws, spec.pts, spec.r0, spec.r1, spec.sides, 0, spec.flat);
      }
      this.handDefs.push(def);
    }
    if (!this.handDefs.length) return;
    this.finalizeBodyPart(part);
    this.hands = part;
  }

  // 算一隻手的全部管子路徑：constructor 建拓撲（k=1）、update 每幀重寫（k=進食數）
  // 人形姿勢：肩 → 肘 → 腕自然下垂，走路時前後擺（swing 正 = 往前）
  // ★2026-11-01 參照「人類手部解剖」重做：
  //   · 手掌扁平（厚度/寬度≈0.3，用 flat 陣列壓 y 向），腕端圓接前臂、指節端收扁
  //   · 四指不等長：中指 1.0×掌長最長、食指 0.90、無名 0.95、小指 0.76 最短
  //   · 每指三節指骨（近節44%、中節31%、遠節25%）＋放鬆時朝手掌側彎（12°/22°/8°）
  //   · 指根弧線：中指指節最遠端、小指指節最靠近手腕（長在掌內）
  //   · 拇指＝掌骨＋兩節指骨，從手腕橈側（魚際）斜出，與食指約30°（不再分太開）
  //   · 左右手共用 lat=[side,0,0] 鏡像 → 食指永遠緊鄰拇指（舊版左手手指順序是反的）
  handPaths(d, S, k, swing) {
    const side = d.side;
    const nrm = a => { const l = Math.hypot(a[0], a[1], a[2]) || 1;
                       return [a[0] / l, a[1] / l, a[2] / l]; };
    const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
    const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
    // 整隻手往肩點縮放（k=0 → 全部收在肩點裡 = 完全看不見）
    const sc = p => [S[0] + (p[0] - S[0]) * k,
                     S[1] + (p[1] - S[1]) * k,
                     S[2] + (p[2] - S[2]) * k];
    // ---- 本機座標軸（手掌朝 +y 前方＝解剖學標準姿勢：拇指在外側）----
    const distal = nrm([0.10 * side, swing * 0.3, -1]);  // 手指延伸方向（往下、走動時微朝前）
    const lat = [side, 0, 0];                             // 拇指側＝外側（遠離身體中線）
    const palmN = [0, 1, 0];                              // 手掌法線（手掌面朝前方）
    const Larm = 1.30;                                    // 肩→腕
    const Lp = 0.30;                                      // 掌長（腕→指節）；掌寬≈0.27＝0.9×掌長
    // 手肘微往後 → 前臂自然朝前彎（放鬆時的攜帶角，不是僵直木棍）
    const elbow = [S[0] + 0.06 * side, S[1] + swing * 0.55 - 0.05, S[2] - Larm * 0.5];
    const wrist = [S[0] + 0.10 * side, S[1] + swing * 1.15, S[2] - Larm];
    // 肩接縫修復：手臂第一環改從「體內」長出來（S0 往內 0.20、往上 0.22 → 整環埋進軀幹），
    // 管子從身體內部鑽出表面 → 肩膀是圓弧接合，看不到平口開環（舊版「沒連結好」的來源）
    const S0 = [S[0] - 0.20 * side, S[1], S[2] + 0.22];
    const knuckleC = add(wrist, mul(distal, Lp));         // 指節線中心（掌長末端）
    const specs = [
      // 前臂：肩端粗→腕端細；y 向壓扁（前臂橫截面是橢圓，寬>厚）
      { key: "fore", pts: [S0, S, elbow, wrist].map(sc),
        r0: 0.21 * k, r1: 0.095 * k, sides: 8,
        flat: [1, 1, 0.90, 0.70] },
      // 手掌前半：腕端圓（半徑略大於前臂末端 → 前臂開口藏得進來）→ 掌中最厚 → 指節線扁
      { key: "palmA",
        pts: [ wrist,
               add(wrist, mul(distal, Lp * 0.55)),
               knuckleC ].map(sc),
        r0: 0.108 * k, r1: 0.135 * k, sides: 8,
        flat: [0.72, 0.52, 0.36] },
      // 手掌後半（指節→收口）：半徑往內收，把掌端開口藏進指根叢裡（開口朝下、被四指遮住）
      { key: "palmB",
        pts: [ knuckleC,
               add(knuckleC, mul(distal, 0.02)) ].map(sc),
        r0: 0.135 * k, r1: 0.105 * k, sides: 8,
        flat: [0.36, 0.30] },
    ];
    // ---- 四指（食→中→無名→小，由拇指側排到小指側）----
    //  x：指根橫向（lat 正＝拇指側）；len：指長×掌長；sp：外展角（正＝朝拇指側張開）
    //  kz：指根遠近（負＝較靠近手腕；小指指節藏在掌內最不突出）
    const DIGITS = [
      { key: "index",  x:  0.088, len: 0.90, sp:  0.13, kz: -0.010, r0: 0.030 },
      { key: "middle", x:  0.030, len: 1.00, sp:  0.03, kz:  0.000, r0: 0.031 },
      { key: "ring",   x: -0.028, len: 0.95, sp: -0.05, kz: -0.006, r0: 0.029 },
      { key: "little", x: -0.085, len: 0.76, sp: -0.14, kz: -0.040, r0: 0.026 },
    ];
    const fingerRaw = [];                          // 未縮放原座標（給指甲算切線用，避免 sc 兩次）
    for (const dg of DIGITS) {
      const L = Lp * dg.len;
      const b0 = add(add(knuckleC, mul(lat, dg.x)), mul(distal, dg.kz));
      // 指向：沿掌向＋外展角（食指朝拇指側微張、小指朝外側張開）
      let dir = nrm(add(mul(distal, Math.cos(dg.sp)), mul(lat, Math.sin(dg.sp))));
      // 三節指骨：近節44%、中節31%、遠節25%；逐節往手掌側彎（放鬆的手）
      const seg = [0.44, 0.31, 0.25];
      const curl = [0.21, 0.38, 0.14];              // 各關節彎曲角≈12°/22°/8°（總42°）
      const pts = [b0];
      let p = b0;
      for (let j = 0; j < 3; j++) {
        dir = nrm(add(mul(dir, Math.cos(curl[j])), mul(palmN, Math.sin(curl[j]))));
        p = add(p, mul(dir, L * seg[j]));
        pts.push(p);
      }
      fingerRaw.push(pts);
      specs.push({ key: dg.key, pts: pts.map(sc),
                   r0: dg.r0 * k, r1: 0.015 * k, sides: 6 });
    }
    // ---- 拇指：掌骨（魚際）＋兩節指骨，從手腕橈側斜出、與食指約 30° ----
    const tLen = [0.135, 0.098, 0.088];             // 掌骨/近節/遠節（總長0.321≈掌長）
    const cmc = add(add(add(wrist, mul(distal, 0.045)), mul(lat, 0.078)), [0, 0.008, 0]);
    // 掌骨方向：往下＋朝外側＋微微朝前（拇指相對手掌外展約30°）
    let tdir = nrm(add(add(mul(distal, 0.85), mul(lat, 0.42)),
                       mul(palmN, 0.30 + swing * 0.15)));
    // 掌骨分兩段走（第二段微朝手掌側）→ 魚際有自然弧度
    const mcp1 = add(cmc, mul(tdir, tLen[0] * 0.55));
    tdir = nrm(add(tdir, mul(palmN, 0.12)));
    const mcp = add(mcp1, mul(tdir, tLen[0] * 0.45));
    //（跟四指一樣過 sc()：不然 k<1 手還沒長滿時，拇指會整根留在原尺寸）
    specs.push({ key: "thumbM", pts: [cmc, mcp1, mcp].map(sc),
                 r0: 0.048 * k, r1: 0.040 * k, sides: 7 });
    // 指骨兩節：近節沿掌骨方向（切線一致 → 與掌骨環完全密合）、遠節朝手掌彎＝輕微對掌
    let tdir2 = tdir;
    const ip = add(mcp, mul(tdir2, tLen[1]));
    tdir2 = nrm(add(mul(tdir2, Math.cos(0.16)), mul(palmN, Math.sin(0.16))));
    const thumbPts = [mcp, ip, add(ip, mul(tdir2, tLen[2]))];
    specs.push({ key: "thumb", pts: thumbPts.map(sc),
                 r0: 0.040 * k, r1: 0.015 * k, sides: 7 });
    // ---- 指甲：每根指尖續接一小段深色角質爪（同曲線延伸、爪尖微微下鉤）----
    const claws = [];
    const addClaw = (last3, sides) => {
      const T = last3[2], Pm = last3[1];                  // 指尖環、前一環（切線用）
      const cd = nrm([T[0] - Pm[0], T[1] - Pm[1], T[2] - Pm[2]]);
      const c1 = add(T, mul(cd, 0.035));
      const c2 = add(add(T, mul(cd, 0.065)), [0, -0.010, -0.012]);   // 爪尖下鉤
      // r0 = 指尖半徑、sides 與該指相同 → 爪環跟指尖環完全密合（開口不外露）
      claws.push({ pts: [T, c1, c2].map(sc), r0: 0.015 * k, r1: 0.002 * k, sides });
    };
    for (let i = 0; i < 4; i++) {
      const f2 = fingerRaw[i];                          // 未縮放原座標（specs 裡已是 sc 過的）
      addClaw([f2[1], f2[2], f2[3]], 6);
    }
    addClaw(thumbPts, 7);                               // 拇指：也是未縮放的原始 pts
    return { main: specs, claws };
  }

  // ==========================================================================
  // 人形頭部（Ⅱ 隻解鎖）：頸（3 環）+ 蛋形頭（7 環）
  //   拓撲先建；⑤f 每幀從「頸根」依 hHd 縮放 → 第 2 隻長出頭
  // ==========================================================================
  buildHumanHead() {
    const part = { id: "head", world: false, base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [172, 150, 143] };        // 蒼白膚色（吃 uAlien 蒼白化）
    // 頸：從軀幹頸根（z≈1.25）往上接頭（半徑 0.16~0.18，跟軀幹頸端 0.16×0.13 銜接不露縫）
    this.ringStack(part,
      [[0, 0.05, 1.25], [0, 0.03, 1.55], [0, 0.02, 1.85]],
      [0.16, 0.18, 0.18], 8);
    // 蛋形頭：7 環、半徑 = 0.46*sqrt(1−u²)（u = −1..1，微微前凸）
    const cs = [], rs = [];
    for (let i = 0; i < 7; i++) {
      const u = (i / 6) * 2 - 1;
      cs.push([0, 0.02 + 0.03 * (1 - u * u), 2.24 + u * 0.42]);
      rs.push(0.46 * Math.sqrt(Math.max(0.02, 1 - u * u)));
    }
    this.ringStack(part, cs, rs, 9);
    this.finalizeBodyPart(part);
    this.head = part;
  }

  // ==========================================================================
  // 全新人形躯幹（第 6 隻「蛻皮」）：乾淨橢圓環堆疊拓撲，不帶任何蝠翼頂點
  //   輪廓曲線 = ① 人形變形同一組 W/D；髖段加厚 0.04 藏住大腿頂環；
  //   底部多兩環收口 → 胯下圓潤閉合（舊變形的「尾巴頂點斑塊」問題根除）
  // ==========================================================================
  buildHumanTorso() {
    const part = { id: "humanTorso", world: false, base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [172, 150, 143] };         // 蒼白膚（跟頭同色、吃 uAlien）
    const ss = (a, b, v) => { const k = Math.min(1, Math.max(0, (v - a) / (b - a))); return k * k * (3 - 2 * k); };
    // 半寬：骨盆 → 髖 → 腰 → 胸 → 肩台 → 斜方肌 → 頸（跟①同一組曲線）
    const Wof = y01 => 0.34 + 0.18 * ss(0.02, 0.24, y01)
                          - 0.11 * ss(0.30, 0.46, y01)
                          + 0.15 * ss(0.50, 0.70, y01)
                          + 0.10 * ss(0.56, 0.74, y01)
                          - 0.50 * ss(0.84, 1.00, y01);
    // 半厚：同①；髖段 +0.04 加厚 → 大腿頂環（半徑0.19@x±0.27）完全埋進骨盆、不再刺出
    const Dof = y01 => 0.20 + 0.07 * ss(0.02, 0.24, y01)
                          - 0.06 * ss(0.30, 0.46, y01)
                          + 0.10 * ss(0.50, 0.72, y01)
                          - 0.18 * ss(0.80, 0.98, y01)
                          + 0.04 * ss(0.02, 0.15, y01);
    // 環清單：16 節主體（z −0.9 → 1.7）＋ 2 環底部收口
    const R = [];
    for (let i = 0; i < 16; i++) {
      const y01 = i / 15;
      R.push([-0.9 + y01 * 2.6, Wof(y01), Dof(y01)]);
    }
    R.push([-0.96, Wof(0) * 0.62, Dof(0) * 0.62]);   // 收口環 1
    R.push([-1.00, Wof(0) * 0.18, Dof(0) * 0.18]);   // 收口環 2（近尖 → 胯底圓潤閉合）
    const SIDES = 14, rings = [];
    // ---- 精緻化：解剖細節位移（鎖骨/胸肌/腹肌溝/肚臍/背脊溝）----
    // 沿表面外法線（近似 xy 方向）微量推出/凹入 → 光影下看得到骨點與肌肉起伏，
    // 不再是光滑的「洗衣板」；⑤g 是等比縮放 → 位移烘在 base 裡會自動跟著縮放
    const g1 = (x, s) => Math.exp(-(x / s) * (x / s));        // 高斯鐘形（中心 0、寬 s）
    const win = (z, a2, b2) => ss(a2 - 0.04, a2 + 0.04, z) * ss(b2 + 0.04, b2 - 0.04, z);
    const detail = (ca, sa, z) => {
      const fr = Math.max(0, sa), bk = Math.max(0, -sa), ax = Math.abs(ca);
      let dOut = 0;
      if (fr > 0) {
        // 鎖骨：胸骨柄(z≈1.17)往兩側微微下斜的橫「S」隆起
        dOut += 0.030 * g1(z - (1.17 - 0.14 * ax), 0.05) * fr
                    * ss(0.06, 0.16, ax) * ss(0.98, 0.80, ax);
        // 胸肌：左右各一塊（中心 ax≈0.42）；中間胸骨一條淺溝分開兩塊
        dOut += 0.026 * g1(z - 0.92, 0.11) * g1(ax - 0.42, 0.24) * fr
              - 0.014 * g1(ca, 0.12) * g1(z - 0.92, 0.14) * fr;
        // 腹肌：三條橫溝（z≈0.42/0.22/0.02）＋中央白線＋肚臍凹
        dOut -= 0.014 * (g1(z - 0.42, 0.030) + g1(z - 0.22, 0.030) + g1(z - 0.02, 0.030))
                    * fr * ss(0.55, 0.35, ax) * win(z, -0.06, 0.50);
        dOut -= 0.010 * g1(ca, 0.07) * fr * win(z, -0.08, 0.55);   // 白線（腹中縱溝）
        dOut -= 0.028 * g1(z + 0.12, 0.05) * g1(ca, 0.14) * fr;    // 肚臍凹
      }
      // 背脊溝：沿脊椎一條淺槽（背影更像人）
      dOut -= 0.018 * g1(ca, 0.11) * bk * win(z, -0.55, 1.05);
      return dOut;
    };
    for (let ri = 0; ri < R.length; ri++) {
      const z = R[ri][0], W = R[ri][1], D = R[ri][2];
      const ring = [];
      for (let k = 0; k < SIDES; k++) {
        const a = (k / SIDES) * 6.28318;
        const ca = Math.cos(a), sa = Math.sin(a);
        const dOut = ri < 16 ? detail(ca, sa, z) : 0;   // 只給主體 16 環加細節（收口環保持乾淨）
        part.base.push(ca * (W + dOut), sa * (D + dOut), z);
        ring.push(part.base.length / 3 - 1);
      }
      rings.push(ring);
    }
    // 側面：相鄰兩環之間一整圈四邊形（繞向跟 ringStack 一致 → 法線朝外）
    for (let i = 0; i < rings.length - 1; i++) {
      const A = rings[i], B = rings[i + 1];
      for (let k = 0; k < SIDES; k++) {
        const k2 = (k + 1) % SIDES;
        part.faces.push(A[k], A[k2], B[k2], A[k], B[k2], B[k]);
      }
    }
    // 頸口三角扇封口（法線朝上；外面被頸管蓋住，只防止看到體內）
    // 注意：主體環是 rings[0..15]（16..17 是底部收口環）→ 頸口要接 rings[15]
    const top = rings[15];
    part.base.push(0, 0, 1.7); const tc = part.base.length / 3 - 1;
    for (let k = 0; k < SIDES; k++) part.faces.push(top[k], top[(k + 1) % SIDES], tc);
    // 胯底三角扇封口（法線朝下）
    const bot = rings[rings.length - 1];
    part.base.push(0, 0, -1.01); const bc = part.base.length / 3 - 1;
    for (let k = 0; k < SIDES; k++) part.faces.push(bot[(k + 1) % SIDES], bot[k], bc);
    this.finalizeBodyPart(part);
    this.humanTorso = part;
  }

  // ==========================================================================
  // 頸部鰓裂：每側 3 道斜裂（深海生物的呼吸痕跡 → 細節感）
  //   建在「頭部建造空間」（頸管 z 1.25~1.85、半徑 0.16~0.18）→ ⑤f 每幀用跟
  //   頭同一條「頸根縮放」曲線重寫 → 跟著頭一起長出來（hHd=0 全收在頸根＝隱形）
  //   近黑角質色 → 不吃 uAlien 蒼白化（跟眼窩/嘴縫同一個繪製 pass）
  // ==========================================================================
  buildGills() {
    const part = { id: "gills", world: false, base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [18, 11, 12] };          // 近黑（裂縫＝陰影色）
    // ★ 位置鐵則：z 必須 > 1.65 —— 軀幹「斜方肌」在 z1.28~1.65 是 0.2~0.64 寬的實體，
    //   低於此高度的頸側裂縫會被埋進軀幹 mesh（實測 z1.33/1.46/1.59 全部隱形）；
    //   頭球底在 z≈1.80（該 xy 偏移處）→ 自由頸段只有 1.65~1.78，每側塞 2 道剛好
    for (const s of [1, -1]) {
      for (let i = 0; i < 2; i++) {
        const z = 1.665 + i * 0.075;               // 由下而上 1.665 / 1.740
        const rN = (0.165 + (z - 1.40) * 0.03) * 1.05;  // 頸半徑 ×1.05 → 半嵌表面、微微外凸
        // 從「正側」往臉前方轉 26° → 鬢側無髮遮擋、正面 3/4 角也看得到
        const th = 0.45;
        const cx = Math.cos(th) * rN * s, cy = 0.04 + Math.sin(th) * rN;
        // 裂縫 = 細的兩點管（上端朝前、下端朝後 → 斜裂像魚鰓）
        this.tube(part, [[cx, cy + 0.028, z + 0.022], [cx, cy - 0.028, z - 0.022]],
                  0.015, 0.013, 5, 0);
      }
    }
    this.finalizeBodyPart(part);
    this.gills = part;
  }

  // 垂直堆環（環平面 = XY、軸 = +Z）：建「頸/蛋形頭」這類直立管狀部件的拓撲
  ringStack(part, centers, radii, sides) {
    const rings = [];
    for (let i = 0; i < centers.length; i++) {
      const c = centers[i], r = radii[i];
      const ring = [];
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * 6.28318;
        part.base.push(c[0] + Math.cos(a) * r, c[1] + Math.sin(a) * r, c[2]);
        ring.push(part.base.length / 3 - 1);
      }
      rings.push(ring);
    }
    for (let i = 0; i < rings.length - 1; i++) {
      const A = rings[i], B = rings[i + 1];
      for (let k = 0; k < sides; k++) {
        const k2 = (k + 1) % sides;
        part.faces.push(A[k], A[k2], B[k2], A[k], B[k2], B[k]);
      }
    }
  }

  // ==========================================================================
  // 人形雙腿（Ⅳ 隻解鎖）：每側 大腿(3 環) + 小腿(3 環) + 腳掌(2 環)
  //   拓撲先建；⑤e 每幀用「步行週期 + 兩段 IK」重寫位置 → 腳掌貼地走路
  // ==========================================================================
  buildHumanLimbs() {
    const part = { id: "legs", world: false, base: [], faces: [],
                   pos: null, normals: null, wpos: null, wnorm: null,
                   color: [166, 144, 138] };        // 蒼白膚色
    this.legDefs = [];
    for (const side of [1, -1]) {
      const def = { side, starts: [] };
      const H = [0.32 * side, 0, -0.7];
      const knee = [H[0], H[1] + 0.25, H[2] - 1.1];
      const ank = [H[0], H[1], H[2] - 2.2];
      const toe = [ank[0], ank[1] + 0.42, ank[2] - 0.02];
      const specs = [
        { pts: [H, [(H[0] + knee[0]) / 2, (H[1] + knee[1]) / 2, (H[2] + knee[2]) / 2],
                knee], r0: 0.30, r1: 0.19, sides: 7 },
        { pts: [knee, [(knee[0] + ank[0]) / 2, (knee[1] + ank[1]) / 2, (knee[2] + ank[2]) / 2],
                ank], r0: 0.18, r1: 0.10, sides: 7 },
        { pts: [ank, toe], r0: 0.13, r1: 0.07, sides: 6 },
      ];
      for (const sp of specs) {
        def.starts.push(part.base.length / 3);
        this.tube(part, sp.pts, sp.r0, sp.r1, sp.sides, 0);
      }
      // ---- 腳趾×3（扇形）＋深色角質爪（爪建進獨立 claws 部件）----
      //（座標公式必須跟 ⑤e 每幀重寫時用的一模一樣，環數也要一致）
      def.tstarts = []; def.cstarts = [];
      for (const s of [-0.30, 0, 0.30]) {
        const td = [Math.sin(s) * 0.9, 0.92 - Math.abs(s) * 0.1, -0.14];
        const tl = Math.hypot(td[0], td[1], td[2]) || 1;
        td[0] /= tl; td[1] /= tl; td[2] /= tl;
        const t1 = [toe[0] + td[0] * 0.11, toe[1] + td[1] * 0.11, toe[2] + td[2] * 0.11];
        const t2 = [toe[0] + td[0] * 0.20, toe[1] + td[1] * 0.20, toe[2] + td[2] * 0.20];
        def.tstarts.push(part.base.length / 3);
        this.tube(part, [toe, t1, t2], 0.052, 0.024, 5, 0);
        if (this.claws) {
          const c1 = [t2[0] + td[0] * 0.04, t2[1] + td[1] * 0.04, t2[2] + td[2] * 0.04];
          const c2 = [t2[0] + td[0] * 0.075, t2[1] + td[1] * 0.075, t2[2] + td[2] * 0.075 - 0.012];
          def.cstarts.push(this.claws.base.length / 3);
          this.tube(this.claws, [t2, c1, c2], 0.021, 0.002, 5, 0);
        }
      }
      this.legDefs.push(def);
    }
    this.finalizeBodyPart(part);
    this.legs = part;
    if (this.claws) { this.finalizeBodyPart(this.claws); }   // 爪：手指甲＋腳爪一起定案
  }

  // ==========================================================================
  // 地表碎石 / 貝殼殘片：兩種環境共用（各 36 顆小變形球散布在地面）
  //   → 海床與紅土都不再「空一大片」，近景地面有細節可看
  // ==========================================================================
  buildPebbles() {
    let seed = 3131;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 36; k++) {
      const ang = rnd() * Math.PI * 2, rad = 4 + rnd() * 40;
      const cx = Math.cos(ang) * rad, cy = Math.sin(ang) * rad;
      const s = 0.28 + rnd() * 0.55;
      const gz = this.floorZ(cx, cy);
      const ph1 = rnd() * 6.28, ph2 = rnd() * 6.28, ph3 = rnd() * 6.28;
      const part = { id: "peb" + k, world: true, base: [], faces: [],
                     pos: null, normals: null,
                     mat: 1,                        // 小礫石 → 岩石紋理
                     color: null,
                     colorSea: [58 + rnd() * 30 | 0, 64 + rnd() * 26 | 0,
                                76 + rnd() * 26 | 0],           // 貝殼灰白
                     colorUp: [80 + rnd() * 20 | 0, 72 + rnd() * 14 | 0,
                               64 + rnd() * 14 | 0] };          // 逆世界：灰褐石（紅土上跳得出來）
      part.color = part.colorUp.slice();
      const NU = 8, NV = 5;
      for (let i = 0; i <= NV; i++) {
        const phi = (i / NV) * Math.PI;
        for (let j = 0; j <= NU; j++) {
          const th = (j / NU) * Math.PI * 2;
          // 兩頻變形 + 頂點微抖 → 磨損碎石，不再是低模寶石面
          const r = 1 + 0.34 * Math.sin(th * 3 + ph1) * Math.sin(phi * 2 + ph2)
                       + 0.15 * Math.sin(th * 7 + phi * 5 + ph3)
                       + 0.05 * (rnd() - 0.5);
          part.base.push(cx + Math.cos(th) * Math.sin(phi) * r * s,
                         cy + Math.sin(th) * Math.sin(phi) * r * s,
                         gz + Math.cos(phi) * r * s * 0.62 + s * 0.18);
        }
      }
      for (let i = 0; i < NV; i++) {
        for (let j = 0; j < NU; j++) {
          const a = i * (NU + 1) + j, b = a + 1, c = a + NU + 2, d = a + NU + 1;
          part.faces.push(a, b, c, a, c, d);
        }
      }
      this.finalizePart(part);
      if (s > 0.6) this.shadows.push({ x: cx, y: cy, r: s * 1.5, a: 75 });
    }
  }

  // ==========================================================================
  // 獵物骨骸：3 處吃剩的殘骸（肋骨拱 + 脊椎條）→ 生存痕跡、環境更寫實
  // ==========================================================================
  buildBones() {
    let seed = 6262;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const part = { id: "bones", world: true, base: [], faces: [],
                   pos: null, normals: null,
                   color: null,
                   colorSea: [150, 148, 136],     // 深海：鯨落骨（蒼白）
                   colorUp: [176, 164, 142] };    // 逆世界：曬白殘骨
    part.color = part.colorUp.slice();
    for (let k = 0; k < 3; k++) {
      const ang = rnd() * Math.PI * 2, rad = 9 + rnd() * 26;
      const cx = Math.cos(ang) * rad, cy = Math.sin(ang) * rad;
      const dirA = rnd() * Math.PI * 2;           // 骨堆走向
      const dx = Math.cos(dirA), dy = Math.sin(dirA);
      // 脊椎條：貼地一長條
      const sp = [];
      for (let i = 0; i <= 6; i++) {
        const x = cx + dx * (i - 3) * 0.9, y = cy + dy * (i - 3) * 0.9;
        sp.push([x, y, this.floorZ(x, y) + 0.16]);
      }
      this.tube(part, sp, 0.17, 0.13, 5, 0.45);
      // 肋骨：5 支半圓拱（一端插地、拱起、另一端插地）
      for (let b = 0; b < 5; b++) {
        const off = (b - 2) * 0.62;
        const rr = 1.0 + rnd() * 0.7;
        const pts = [];
        for (let i = 0; i <= 6; i++) {
          const a = (i / 6) * Math.PI;            // 0 → π 半圓
          const x = cx + dx * off + (-dy) * Math.cos(a) * rr;
          const y = cy + dy * off + (dx) * Math.cos(a) * rr;
          pts.push([x, y, this.floorZ(x, y) + Math.sin(a) * rr * 0.95]);
        }
        this.tube(part, pts, 0.10, 0.07, 5, 0);
      }
    }
    this.finalizePart(part);
  }

  // ==========================================================================
  // 環境切換：深海 ↔ 逆世界（配色 + 只畫此環境的物件/線框）
  // ==========================================================================
  setEnv(name) {
    this.env = name === "sea" ? "sea" : "up";
    const up = this.env === "up";
    // 可見的環境物件：深海排除 env:"up" 的枯樹/藤蔓/巨影
    this.worldVis = up ? this.worldParts : this.worldParts.filter(pt => !pt.env);
    // 配色（海床/礁岩依環境換色）
    for (const pt of this.worldParts) {
      if (pt.colorSea) pt.color = up && pt.colorUp ? pt.colorUp : pt.colorSea;
    }
    // 線框可見集（扁平三元組）
    this.edgesWorldVis = [];
    const e = this.edgesWorld;
    for (let i = 0; i < e.length; i += 3) {
      if (!up && e[i].env === "up") continue;
      this.edgesWorldVis.push(e[i], e[i + 1], e[i + 2]);
    }
  }

  // ==========================================================================
  // 捕食（F 鍵 / ?hunt=1）：鎖定「最近的活地行獸」追擊；roam() 內的②c 接管導航
  //   walkers = 地行獸陣列（也可傳單隻，內部統一成陣列）
  // ==========================================================================
  startHunt(walkers) {
    const list = Array.isArray(walkers) ? walkers : (walkers ? [walkers] : []);
    if (this.env !== "up" || !list.length) return false;          // 深海/沒有獵物
    if (this.hunt.active || this.hunt.cd > 0) return false;       // 進行中/冷卻中
    // 挑「沒被吃掉、也沒正在被吞」且離得最近的一隻
    let best = null, bd = 1e9;
    for (const w of list) {
      if (w.eaten || w.swallow) continue;
      const d = Math.hypot(w.x - this.pose.x, w.y - this.pose.y);
      if (d < bd) { bd = d; best = w; }
    }
    if (!best) return false;
    this.hunt.active = true;
    this.hunt.t = 0;
    this.hunt.walker = best;
    huntMsg("🔴 捕食開始 —— 追擊地行獸！");
    if (window.SFX) SFX.roar({ dur: 1.0, f0: 170, f1: 60, amp: 0.5 });   // 發現獵物的嘶吼
    return true;
  }

  // 捕食爆點：一圈餘燼往外濺（billboard 微粒；dt 在 roam() 裡推進）
  spawnBurst(x, y, z) {
    this.burst = [];
    for (let i = 0; i < 24; i++) {
      const a = Math.random() * 6.283, sp = 1.6 + Math.random() * 3.2;
      this.burst.push({
        x, y, z,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        vz: 0.6 + Math.random() * 1.6, life: 1,
      });
    }
  }

  updateBurst(dt) {
    if (!this.burst || !this.burst.length) return;
    for (const b of this.burst) {
      b.x += b.vx * dt; b.y += b.vy * dt;
      b.z += b.vz * dt; b.vz -= 3.5 * dt;                // 拋物線落下
      b.vx *= (1 - dt * 0.8); b.vy *= (1 - dt * 0.8);    // 空氣阻力
      b.life -= dt * 0.75;
    }
    this.burst = this.burst.filter(b => b.life > 0);
  }

  drawBurst(p) {
    const eye = this.camEye;
    p.noStroke();
    p.beginShape(p.TRIANGLES);
    for (const b of this.burst) {
      p.fill(255, 120 + 100 * (1 - b.life), 40, 230 * b.life);   // 橙紅→暗紅
      let fx = eye[0] - b.x, fy = eye[1] - b.y, fz = eye[2] - b.z;
      const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
      let rx = fy, ry = -fx;                        // dir × 世界up → 水平右向量
      const rl = Math.hypot(rx, ry) || 1; rx /= rl; ry /= rl;
      const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx;
      const s = 0.02 * fl * b.life + 0.05;
      const ax = b.x + rx * s + ux * s, ay = b.y + ry * s + uy * s, az = b.z + uz * s;
      const bx = b.x - rx * s + ux * s, by = b.y - ry * s + uy * s, bz = b.z + uz * s;
      const cx = b.x - rx * s - ux * s, cy = b.y - ry * s - uy * s, cz = b.z - uz * s;
      const dx = b.x + rx * s - ux * s, dy = b.y + ry * s - uy * s, dz = b.z - uz * s;
      p.vertex(ax, ay, az); p.vertex(bx, by, bz); p.vertex(cx, cy, cz);
      p.vertex(ax, ay, az); p.vertex(cx, cy, cz); p.vertex(dx, dy, dz);
    }
    p.endShape();
  }

  // ==========================================================================
  // 自主漫遊：緩慢巡游的方向 + 邊界轉回 + 深度起伏
  // ==========================================================================
  resetPose() {
    this.pose = { x: 0, y: 0, z: -4, heading: 0.6, bank: 0, nose: 0 };
    this.baseDir = 0.6;    // 漫遊基底方向（heading 空間）
    this.wt = 7;           // 漫遊相位
    this.hunt = { active: false, t: 0, cd: 0, walker: null };   // 捕食狀態
  }

  // 把角度差收進 ±π（轉向時走最短路徑）
  wrapPi(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

  roam(params, dt) {
    if (dt <= 0) return;   // 暫停時完全不動
    this.wt += dt;
    const w = this.wt, P = this.pose;

    // ① 想去的方向 = 緩慢漂移的基底方向 + 兩道正弦擺動（看起來像隨機巡游）
    this.baseDir += Math.sin(w * 0.13) * dt * 0.12;
    let want = this.baseDir + Math.sin(w * 0.19) * 1.1 + Math.sin(w * 0.47 + 2.0) * 0.5;

    // ② 半徑 20 起被「拉回中心」的權重越來越大（範圍比之前大 → 走得更自由）
    const R = Math.hypot(P.x, P.y);
    if (R > 1 && !this.hunt.active) {
      const toC = Math.atan2(P.x / R, -P.y / R);        // 朝向中心的 heading
      const k = Math.min(1, Math.max(0, (R - 20) / 7)); // 20→0、27→1
      want += this.wrapPi(toC - want) * k;
    }

    // ②b 障礙迴避：太靠近礁岩/枯樹/巨影的腳就朝外側繞開（避免穿模）
    //   身體參數（②b 軟轉向與 ④b 硬推開共用）：
    //     bDrop = pose 到身體最低點的距離（站著 = 腳踩地；游著 = 身體半徑）
    //     bR    = 身體水平半徑（人形軀幹細 → 0.95；原始蝠形寬 → 1.6）
    //   垂直閘門：身體最低點低於障礙頂才迴避 → 站著永遠繞開、飛得比石頭高就直接越過去
    const bDrop = (this.human && this.human.hLg > 0)
      ? (0.7 + 0.55 + 1.65 * this.human.hLg) : 1.6;
    const bR = (this.human && this.human.hT > 0.5) ? 0.95 : 1.6;
    const zTopOf = o => (o.zTop !== undefined ? o.zTop : 1e9);   // 沒記高度的障礙 → 永遠算會撞
    for (const o of this.obstacles) {
      const dx = P.x - o.x, dy = P.y - o.y;
      const d = Math.hypot(dx, dy);
      const clear = o.r + 3.5;
      if (d < clear && d > 1e-4 && P.z - bDrop < zTopOf(o)) {
        const away = Math.atan2(-dx / d, dy / d);       // 離開障礙的 heading
        const k = Math.min(1, (clear - d) / 3.5) * 0.95;
        want += this.wrapPi(away - want) * k;
      }
    }

    // ②c 捕食模式：強制轉向獵物、壓低俯衝；12 秒追不到就放棄，抓到交給 walker 處理
    if (this.hunt.active) {
      const W = this.hunt.walker;
      const dx = W.x - P.x, dy = W.y - P.y;
      const d = Math.hypot(dx, dy) || 1;
      want = Math.atan2(-dx / d, dy / d);        // 朝獵物的 heading（同款 forward 慣例）
      this.hunt.t += dt;
      this.hunt.d = d;                           // 距離給③④做「近距離收斂」用
      // 除錯：每秒記一行追擊狀態（t=追了幾秒、d=水平距離、z=高度）
      if (Math.floor(this.hunt.t) !== this.hunt.log) {
        this.hunt.log = Math.floor(this.hunt.t);
        console.log(`[hunt] t=${this.hunt.t.toFixed(1)} d=${d.toFixed(1)} z=${P.z.toFixed(1)} preyZ=${W.z.toFixed(1)}`);
      }
      // 抓到判定：水平咬到半徑 + 俯衝到位（人形站著時嘴比較高 → 用相對高度放寬）
      //   追擊期獵物會狂奔（2.15），半徑太小 + 時限太短會幾乎永遠追不到 → 看起來「F 不會吃」
      const grab = 4.5 + 1.8;                    // 咬到半徑（追擊期放大 → 一定追得上）
      if (d < grab && P.z < W.z + 4.2) {
        this.hunt.active = false;
        this.hunt.cd = 10;                       // 捕食後休息 10 秒
        W.eatenBy(this);
      } else if (this.hunt.t > 20) {
        this.hunt.active = false;
        this.hunt.cd = 4;
        huntMsg("地行獸逃走了…");
      }
    } else if (this.hunt.cd > 0) this.hunt.cd -= dt;

    // ③ 限制轉速地轉過去；入彎時身體側傾
    const dth = this.wrapPi(want - P.heading);
    // 追擊時轉更快；近距離（<8）再加倍 → 不會被急轉的獵物甩開繞圈
    const hd = this.hunt.active ? (this.hunt.d || 99) : 99;
    const maxTurn = (this.hunt.active ? (hd < 8 ? 3.6 : 2.2) : 0.7) * dt;
    P.heading += Math.max(-maxTurn, Math.min(maxTurn, dth));
    const bankGoal = Math.max(-0.4, Math.min(0.4, dth * 4))
      * (1 - 0.8 * (this.human ? this.human.hT : 0));   // 人形化：站直後不側傾
    P.bank += (bankGoal - P.bank) * Math.min(1, dt * 3);

    // ④ 前進（游速跟「游動波速」滑桿連動）
    // 追擊加速；貼近獵物時減速配速（不然大迴轉會一直掃圈咬不到）
    const vHunt = this.hunt.active
      ? 2.6 * Math.max(0.5, Math.min(1, hd / 6)) : 1;
    const v = 1.3 * params.speed * vHunt;
    P.x += -Math.sin(P.heading) * v * dt;
    P.y += Math.cos(P.heading) * v * dt;
    if (R > 34) { P.x *= 34 / R; P.y *= 34 / R; }       // 保險硬邊界
    // ④b 硬推開（穿石修正）：②b 只是「想繞開」——轉速有上限（非狩獵 0.7/s）、
    //    狩獵時轉向更被 ②c 強制蓋掉 → 身體照樣會蹭進石頭 →
    //    這裡把位置直接推回圓柱外，「任何情況都不穿模」的最終保險
    for (const o of this.obstacles) {
      if (P.z - bDrop >= zTopOf(o)) continue;            // 最低點高於障礙頂 → 從上方飛過
      const dx = P.x - o.x, dy = P.y - o.y;
      const d = Math.hypot(dx, dy);
      const minD = o.r + bR;
      if (d < minD) {
        if (d < 1e-5) P.x += minD;                       // 正中重合（幾乎不可能）→ 直接推出
        else { const t = minD / d; P.x = o.x + dx * t; P.y = o.y + dy * t; }
      }
    }
    // 平滑過的地面速度 → 步行週期速率用（腳掌踩點才不會打滑）
    this.gSpeed += (v - this.gSpeed) * Math.min(1, dt * 3);

    // ⑤ 深度：正弦巡游 + 硬邊界（-9.2 ~ -1.6，離海床至少 0.6）
    const prevZ = P.z;
    let zt = -5.2 + 3.0 * Math.sin(w * 0.11 + 1.0);
    if (this.hunt.active) zt = this.hunt.walker.z + 0.8;   // 俯衝壓低追獵物
    const hg = this.human;
    if (!this.hunt.active && hg && hg.hLg > 0) {
      // Ⅳ 隻起：腿長出來的同時「降到地面」→ 站高 = 地板 + 腿長 + 髖高補償
      const LEG = 0.55 + 1.65 * hg.hLg;
      const ztStand = this.floorZ(P.x, P.y) + 0.7 + LEG;
      zt += (ztStand - zt) * hg.hLg;
    }
    P.z += (zt - P.z) * Math.min(1, dt * 0.5);
    P.z = Math.max(-9.2 - 3 * (hg ? hg.hLg : 0), Math.min(-1.6, P.z));

    // ⑥ 俯仰 = 垂直速度對前進速度的仰角（上浮抬頭、下潛低頭）
    // 人形化：身體站直 → 俯仰大幅收斂（人不會像飛行一樣點頭）
    const upright = hg ? 1 - 0.85 * hg.hT : 1;
    const vz = (P.z - prevZ) / Math.max(dt, 1e-4);
    const noseGoal = Math.max(-0.3, Math.min(0.3, Math.atan2(vz, Math.max(v, 1e-3)))) * upright;
    P.nose += (noseGoal - P.nose) * Math.min(1, dt * 1.5);

    this.updateSnow(dt, P.x, P.y);
    this.updateBurst(dt);     // 捕食爆點粒子（沒有的話直接跳過）
  }

  // ==========================================================================
  // 姿態：把「旋轉 + 平移」算成 3×3 矩陣 R + 平移 T（JS 端做，不用 GL push）
  //   好處：頂點/法線都變成真正的世界座標 → 光照、距離霧在生物游走時依然正確
  //   旋轉順序 = Rz(heading) · Ry(bank) · Rx(nose)（跟原本 p5 的呼叫順序一致）
  // ==========================================================================
  poseFrame(t) {
    const P = this.pose;
    const bank = P.bank + Math.sin(t * 0.5) * 0.02;   // 微翻身併入側傾角
    const cx = Math.cos(P.nose), sx = Math.sin(P.nose);
    const cy = Math.cos(bank), sy = Math.sin(bank);
    const cz = Math.cos(P.heading), sz = Math.sin(P.heading);
    const R = [
      cz * cy,          -sz * cx + cz * sy * sx,   sz * sx + cz * sy * cx,
      sz * cy,           cz * cx + sz * sy * sx,  -cz * sx + sz * sy * cx,
      -sy,               cy * sx,                  cy * cx,
    ];
    // 呼吸微動 + 走路起伏：跨步(φ=0/π 兩腳分開)時低、過腿(φ=π/2)單腿撐直時高
    //（2×步頻、−cos(2φ)：φ=0→−A 低、φ=π/2→+A 高 ✓；只有Ⅵ 隻走路時才加）
    const bob = (this.human && this.human.walkK > 0)
      ? -Math.cos(this.walkPhase * 2) * 0.07 : 0;
    // ★「演化前傾」：在全身姿態矩陣上再乘一個局部 X 旋轉（臉朝 +Y、直立朝 +Z →
    //   負角 = 整身向前下方倒 → 猿人佝僂、頭放低）；hPost 在 humanStage 定義並已平滑。
    //   折在這裡是「唯一咽喉」：渲染、頭部相機、腳貼地 IK、海床夾制全部自動一致。
    const hch = -(this.human ? (this.human.hPost || 0) : 0) * 0.96;  // 最大 0.96 rad ≈ 55°
    const chx = Math.cos(hch), shx = Math.sin(hch);
    const R2 = [
      R[0],            R[1] * chx + R[2] * shx,  -R[1] * shx + R[2] * chx,
      R[3],            R[4] * chx + R[5] * shx,  -R[4] * shx + R[5] * chx,
      R[6],            R[7] * chx + R[8] * shx,  -R[7] * shx + R[8] * chx,
    ];
    const T = [P.x, P.y, P.z + Math.sin(t * 0.75) * 0.05 + bob];
    return { R: R2, T };
  }

  // 部件頂點/法線：局部 → 世界（pos/normals → wpos/wnorm，每幀渲染前跑一次）
  worldize(part, F) {
    const { pos, normals, wpos, wnorm } = part;
    const R = F.R, T = F.T;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      wpos[i]     = R[0] * x + R[1] * y + R[2] * z + T[0];
      wpos[i + 1] = R[3] * x + R[4] * y + R[5] * z + T[1];
      wpos[i + 2] = R[6] * x + R[7] * y + R[8] * z + T[2];
      const nx = normals[i], ny = normals[i + 1], nz = normals[i + 2];
      wnorm[i]     = R[0] * nx + R[1] * ny + R[2] * nz;   // 旋轉不變長度 → 不用正規化
      wnorm[i + 1] = R[3] * nx + R[4] * ny + R[5] * nz;
      wnorm[i + 2] = R[6] * nx + R[7] * ny + R[8] * nz;
    }
  }

  // 頭部的世界座標（特寫相機的看點）：人形化後看點搬去「人頭」位置
  headWorld(t) {
    const F = this.poseFrame(t || 0);
    const hH = this.human ? this.human.hHd : 0;
    const lx = 0, ly = 1.55 + (0.05 - 1.55) * hH, lz = 0.35 + (2.3 - 0.35) * hH;
    return [
      F.T[0] + F.R[0] * lx + F.R[1] * ly + F.R[2] * lz,
      F.T[1] + F.R[3] * lx + F.R[4] * ly + F.R[5] * lz,
      F.T[2] + F.R[6] * lx + F.R[7] * ly + F.R[8] * lz,
    ];
  }

  // 立即模式畫三角面（環境與身體共用，一律吃「世界座標版」wpos/wnorm）
  drawParts(p, parts) {
    // 群組霧的回退值（render() 每個繪製群組前會更新 _gFog*）
    const gfS = this._gFogStart != null ? this._gFogStart : 4.2;
    const gfD = this._gFogDens != null ? this._gFogDens : 0.050;
    for (const part of parts) {
      // 材質紋理分支：有標籤用標籤；沒標籤 → 環境(靜態 world)=0 不加、身體部件=5 皮膚毛孔
      if (this.shader) {
        this.shader.setUniform("uMat",
          part.mat != null ? part.mat : (part.world ? 0 : 5));
        // ★每部件霧覆寫：遠山用「更淡的霧」讓岩理透出來（環境的 0.05 濃霧在 95 單位外
        //   會把山吃成 94% 純色 → 讀起來像死黑剪影貼紙；淡霧才分得出遠近層次）
        this.shader.setUniform("uFogStart",
          part.fogStart != null ? part.fogStart : gfS);
        this.shader.setUniform("uFogDens",
          part.fogDens != null ? part.fogDens : gfD);
      }
      p.fill(part.color[0], part.color[1], part.color[2]);
      p.noStroke();
      p.beginShape(p.TRIANGLES);
      const { wpos, wnorm, faces } = part;
      for (let i = 0; i < faces.length; i++) {
        const v = faces[i] * 3;
        p.normal(wnorm[v], wnorm[v + 1], wnorm[v + 2]);
        p.vertex(wpos[v], wpos[v + 1], wpos[v + 2]);
      }
      p.endShape();
    }
  }

  // 立即模式畫線框邊（扁平三元組：part, idxA, idxB；吃 wpos）
  drawEdges(p, edges) {
    p.beginShape(p.LINES);
    for (let i = 0; i < edges.length; i += 3) {
      const part = edges[i], a = edges[i + 1] * 3, b = edges[i + 2] * 3;
      p.vertex(part.wpos[a], part.wpos[a + 1], part.wpos[a + 2]);
      p.vertex(part.wpos[b], part.wpos[b + 1], part.wpos[b + 2]);
    }
    p.endShape();
  }

  // 距離霧（跟 GLSL 同一條公式，海雪在 JS 端算）
  //   env=true → 用環境群組的「早起濃」參數（粒子/霧跟世界同步融進地平霾）
  fogK(dist, env) {
    const st = env ? 4.2 : 9, dn = env ? 0.050 : 0.035;
    return Math.min(0.94, 1 - Math.exp(-Math.max(dist - st, 0) * dn));
  }

  // ==========================================================================
  // 天空穹頂：垂直漸層的巨型反球（r=150）
  //   預設著色器 + 每頂點填色（顏色直接烘焙、不吃 GLSL 霧）→ 比 background()
  //   的單色多出「大氣層次」；閃電時整片天空一起紅移
  // ==========================================================================
  drawSky(p, mode, fl, t = 0) {
    const R = 150;
    const fog = envFogRGB(this.env, mode === "glow", fl);
    const dim = mode === "glow" ? 0.30 : 1;            // 純發光模式：天空壓暗
    const zen = this.env === "up" ? [6, 4, 10] : [2, 8, 20];    // 天頂
    const hor = this.env === "up" ? [66, 20, 18] : [13, 46, 88]; // 地平線（亮帶拉強 → 天空有戲劇感）
    const flAdd = this.env === "up" ? [60, 14, 10] : [24, 34, 46]; // 閃電增亮色
    const cl = v => (v > 255 ? 255 : v < 0 ? 0 : v);
    // 仰角 e = z/R：>0 天空（地平線→天頂）、<0 地平線下（快速融進霧色 → 無色縫）
    //   az = 方位角（海面微光用）
    const colAt = (e, az) => {
      let c;
      if (e >= 0) {
        const k = Math.pow(e, 0.5);                   // 近地平線變色快、高空大片深色
        c = [0, 1, 2].map(i => hor[i] + (zen[i] - hor[i]) * k);
      } else {
        const k = Math.min(1, -e * 2.5);
        c = [0, 1, 2].map(i => hor[i] + (fog[i] - hor[i]) * k);
      }
      const boost = 0.45 + 0.55 * (1 - Math.abs(e));  // 閃電時地平線一帶更亮
      const out = [0, 1, 2].map(i => cl((c[i] + flAdd[i] * fl * boost) * dim));
      // 深海水面微光：地平線一帶緩慢明暗波動（往上看水面光斑漂移 → 水平線不再是死平線）
      if (this.env === "sea" && t && e > -0.02 && e < 0.26) {
        const k2 = 1 - e / 0.26;
        const sh = Math.sin(az * 5 + t * 0.5) * Math.sin(az * 9 - t * 0.8)
                 * Math.sin(e * 42 + t * 0.35);
        const g2 = sh * 8 * k2;
        return out.map(v => cl(v + g2));
      }
      return out;
    };
    shaderOff(p);
    p.noStroke();
    // 24 經度帶（14 → 24：帶間插值誤差減半 → 漸層更平滑，色帶另由 post dither 治）
    const SEG = 40, RINGS = 24;
    for (let j = 0; j < RINGS; j++) {                 // 緯度帶一圈圈畫（TRIANGLE_STRIP）
      const e0 = -1 + (2 * j) / RINGS, e1 = -1 + (2 * (j + 1)) / RINGS;
      const r0 = Math.sqrt(Math.max(0, 1 - e0 * e0)) * R;
      const r1 = Math.sqrt(Math.max(0, 1 - e1 * e1)) * R;
      p.beginShape(p.TRIANGLE_STRIP);
      for (let i = 0; i <= SEG; i++) {
        const a = (i / SEG) * Math.PI * 2;
        const ca = Math.cos(a), sa = Math.sin(a);
        const c0 = colAt(e0, a);
        p.fill(c0[0], c0[1], c0[2]);
        p.vertex(r0 * ca, r0 * sa, e0 * R);
        const c1 = colAt(e1, a);
        p.fill(c1[0], c1[1], c1[2]);
        p.vertex(r1 * ca, r1 * sa, e1 * R);
      }
      p.endShape();
    }
  }

  // ==========================================================================
  // 逆世界：高空緩移的暗紅雲層（壓扁橢圓、慢速環繞）—— 閃電時被照亮
  //   depthMask 關掉 → 雲不寫深度，後畫的枯樹/生物能正確蓋在雲前面
  // ==========================================================================
  drawClouds(p, mode, t, fl) {
    if (!this.clouds) {                               // 第一次畫時才建（懶人建構）
      let seed = 909;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      this.clouds = [];
      for (let k = 0; k < 14; k++) {
        this.clouds.push({
          a: rnd() * 6.28, r: 8 + rnd() * 34, z: 9 + rnd() * 14,
          sz: 10 + rnd() * 16, spd: 0.004 + rnd() * 0.006,
          ph: rnd() * 6.28, al: 72 + rnd() * 55,
        });
      }
    }
    const dim = mode === "glow" ? 0.35 : 1;
    const eye = this.camEye;
    const g = p.drawingContext;
    if (g && g.depthMask) g.depthMask(false);
    shaderOff(p);
    p.noStroke();
    for (const c of this.clouds) {
      const a = c.a + t * c.spd;                      // 慢速環繞漂移
      const cx = Math.cos(a) * c.r, cy = Math.sin(a) * c.r;
      const cz = c.z + Math.sin(t * 0.1 + c.ph) * 0.8;
      // 公告牌基底（同霧團算法）→ 從任何角度看都是「一坨雲」，不會變成一條薄片
      let fx = eye[0] - cx, fy = eye[1] - cy, fz = eye[2] - cz;
      const d = Math.hypot(fx, fy, fz) || 1;
      fx /= d; fy /= d; fz /= d;
      let rx = fy, ry = -fx;                          // cross(法線, 世界上方 z)
      const rl = Math.hypot(rx, ry) || 1e-6;
      rx /= rl; ry /= rl;
      const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx;
      // 底色暗紅；閃電瞬間整朵被照亮（亮度與透明度一起拉高）
      const cr = Math.min(255, (44 + 95 * fl) * dim);
      const cg = Math.min(255, (18 + 28 * fl) * dim);
      const cb = Math.min(255, (19 + 20 * fl) * dim);
      p.fill(cr, cg, cb, Math.min(155, c.al * (0.85 + 0.6 * fl)));
      p.beginShape(p.TRIANGLE_FAN);
      p.vertex(cx, cy, cz);                           // 雲朵中心
      for (let i = 0; i <= 10; i++) {                 // 邊緣不規則 → 像雲不像圓餅
        const ang = (i / 10) * Math.PI * 2;
        const rr = c.sz * (0.65 + 0.35 * Math.sin(ang * 3 + c.ph));
        const cs = Math.cos(ang) * rr, sn = Math.sin(ang) * rr * 0.55; // 上下壓扁 → 雲層感
        p.vertex(cx + rx * cs + ux * sn, cy + ry * cs + uy * sn, cz + uz * sn);
      }
      p.endShape();
    }
    if (g && g.depthMask) g.depthMask(true);
  }

  // ==========================================================================
  // 貼地霧團：朝向鏡頭的軟圓盤（公告牌），沿地面緩飄 —— 兩種環境都用
  //   比霧色稍亮一點才有「團」的感覺；畫在實體之後 → 正確疊在遠景上
  // ==========================================================================
  drawMist(p, mode, t, fl) {
    if (!this.mists) {                                // 第一次畫時才建
      let seed = 555;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      this.mists = [];
      for (let k = 0; k < 11; k++) {
        this.mists.push({
          x: (rnd() - 0.5) * 80, y: (rnd() - 0.5) * 80,
          z: -10.4 + rnd() * 2.6, r: 7 + rnd() * 12,
          al: 34 + rnd() * 30, ph: rnd() * 6.28,
        });
      }
    }
    const eye = this.camEye;
    const hz = envHazeRGB(this.env, mode === "glow", fl);   // 霧目標 = 地平霾（比 bg 亮才有「團」）
    const dim = mode === "glow" ? 0.5 : 1;
    const mr = Math.min(255, hz[0] * 1.35 * dim),
          mg = Math.min(255, hz[1] * 1.35 * dim),
          mb = Math.min(255, hz[2] * 1.35 * dim);
    const g = p.drawingContext;
    if (g && g.depthMask) g.depthMask(false);
    shaderOff(p);
    p.noStroke();
    for (const m of this.mists) {
      const mx = m.x + Math.sin(t * 0.05 + m.ph) * 2.5;
      const my = m.y + Math.cos(t * 0.04 + m.ph * 1.7) * 2.5;
      // 公告牌基底（算法同海洋雪）：法線 = 霧團 → 攝影機
      let fx = eye[0] - mx, fy = eye[1] - my, fz = eye[2] - m.z;
      const d = Math.hypot(fx, fy, fz) || 1;
      fx /= d; fy /= d; fz /= d;
      let rx = fy, ry = -fx;                          // cross(法線, 世界上方 z)
      const rl = Math.hypot(rx, ry) || 1e-6;
      rx /= rl; ry /= rl;
      const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx;
      p.beginShape(p.TRIANGLE_FAN);
      p.fill(mr, mg, mb, m.al);                       // 中心濃
      p.vertex(mx, my, m.z);
      p.fill(mr, mg, mb, 0);                          // 邊緣 0 → 徑向淡出（軟霧團）
      for (let i = 0; i <= 20; i++) {
        const a = (i / 20) * Math.PI * 2;
        const rad = m.r * (0.8 + 0.2 * Math.sin(a * 3 + m.ph));  // 邊緣不規則
        const cs = Math.cos(a) * rad, sn = Math.sin(a) * rad * 0.6; // 壓扁 → 貼地
        p.vertex(mx + rx * cs + ux * sn, my + ry * cs + uy * sn, m.z + uz * sn);
      }
      p.endShape();
    }
    if (g && g.depthMask) g.depthMask(true);
  }

  // ==========================================================================
  // 接地陰影：每個投射物（樹/巖/巨影）+ 兩隻生物腳下的柔軟暗斑
  //   貼著地形的壓扁圓盤（每圈頂點都重新貼 floorZ → 跨在沙丘斜面上也不浮空）
  //   畫在實體之後、霧團之前 → 疊在地面正確、又被霧遠遠吃掉
  // ==========================================================================
  drawContactShadows(p, mode, walkers) {
    const ws = walkers ? (Array.isArray(walkers) ? walkers : [walkers]) : [];
    const dim = mode === "glow" ? 0.35 : 1;     // 純發光模式：陰影也壓淡
    const g = p.drawingContext;
    if (g && g.depthMask) g.depthMask(false);   // 不寫深度 → 不會擋到後畫的霧
    shaderOff(p);
    p.noStroke();
    // 一塊「柔邊」暗斑：中心不透明→邊緣透明，一圈圈同心圓做出羽化
    const blob = (cx, cy, r, a) => {
      const SEG2 = 14;
      for (let ring = 0; ring <= 3; ring++) {
        const f = ring / 3;
        p.beginShape(p.TRIANGLE_FAN);
        p.fill(0, 0, 0, a * dim * (1 - f * 0.85));   // 越外圈越透明（羽化邊緣）
        p.vertex(cx, cy, this.floorZ(cx, cy) + 0.07);
        for (let i = 0; i <= SEG2; i++) {
          const ang = (i / SEG2) * Math.PI * 2;
          const x = cx + Math.cos(ang) * r * f, y = cy + Math.sin(ang) * r * f;
          p.vertex(x, y, this.floorZ(x, y) + 0.07);
        }
        p.endShape();
      }
    };
    // 靜態投射物（建造時收集的清單）
    for (const s of this.shadows) blob(s.x, s.y, s.r, s.a);
    // 利維坦：離地越高 → 陰影越大越淡（懸浮感）
    //   提強（105→140 底、下限 25→40）：深海懸浮時 lift 大，舊參數掉到 25 幾乎看不見 → 沒有接地感
    const P = this.pose;
    const lift = Math.max(0, P.z - this.floorZ(P.x, P.y));
    blob(P.x, P.y, 3.4 + lift * 0.32, Math.max(40, 140 - lift * 6));
    // 地行獸：貼地小暗斑（吞食中會跟著縮小，最後消失）
    for (const w of ws) {
      if (w.eaten) continue;
      const sc = w.swallow ? Math.max(0.1, 1 - (w.swallow.t / w.swallow.dur) * 0.9) : 1;
      blob(w.x, w.y, 1.9 * sc, 115 * sc);
    }
    if (g && g.depthMask) g.depthMask(true);
  }

  // ==========================================================================
  // 閃電實體：打閃瞬間從雲底劈到地面的折線電光（主幹 + 分叉）
  //   亮度跟著 flashV 衰減；用「相機距離 × 係數」換算線寬（WEBGL 線寬是世界單位）
  //   depthMask 關掉 → 電光疊在所有實體上（閃電本來就最亮、蓋過一切）
  // ==========================================================================
  drawBolt(p, mode, fl) {
    // 偵測「亮起瞬間」（fl 從低跳到 >0.4）→ 重建一條隨機折線
    if (fl > 0.4 && this.prevFlash <= 0.4) {
      let seed = (Math.random() * 1e9) | 0;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      // ?bolt=x,y 指定劈落位置（除錯用）；預設隨機繞一圈
      const ang = Math.random() * Math.PI * 2, rad = 30 + Math.random() * 45;
      const bx = this.forcedBolt ? this.forcedBolt.x : Math.cos(ang) * rad;
      const by = this.forcedBolt ? this.forcedBolt.y : Math.sin(ang) * rad;
      let x = bx, y = by;
      const zTop = 14 + rnd() * 6;
      const pts = [[x, y, zTop]];
      const N = 7 + ((rnd() * 4) | 0);
      for (let i = 1; i <= N; i++) {                      // 主幹：每段隨機側折、直落而下
        x += (rnd() - 0.5) * 5.5;
        y += (rnd() - 0.5) * 5.5;
        pts.push([x, y, zTop - (zTop - (this.floorZ(x, y) + 0.5)) * (i / N)]);
      }
      const brs = [];                                     // 分叉：從主幹中段岔出 1~2 條短枝
      const nb = 1 + ((rnd() * 2) | 0);
      for (let b = 0; b < nb; b++) {
        const from = pts[2 + ((rnd() * (N - 3)) | 0)];
        const bp = [from.slice()];
        let bx = from[0], by = from[1], bz = from[2];
        const dir = rnd() * Math.PI * 2;
        for (let i = 0; i < 3; i++) {
          bx += Math.cos(dir) * 2.2 + (rnd() - 0.5) * 2;
          by += Math.sin(dir) * 2.2 + (rnd() - 0.5) * 2;
          bz -= (bz - this.floorZ(bx, by)) * 0.45;
          bp.push([bx, by, bz]);
        }
        brs.push(bp);
      }
      this.bolt = { pts, brs, life: 0.5 };                // life：電光殘影慢慢消
    }
    this.prevFlash = fl;
    if (!this.bolt || this.bolt.life <= 0) return;
    this.bolt.life -= 0.016;                               // 約 0.5 秒消散（視覺殘影）
    const a = Math.min(255, 235 * Math.min(1, fl * 1.4) * (this.bolt.life / 0.5));
    const w = this.camDist * 0.006;
    const g = p.drawingContext;
    if (g && g.depthMask) g.depthMask(false);
    shaderOff(p);
    p.noFill();
    // 外層：粗而淡的紅暈（霓虹暈開感）；內層：細而亮的白熱核心
    p.strokeWeight(w * 3.2);
    p.stroke(255, 90, 70, a * 0.35);
    p.beginShape(p.LINES);
    const allLines = [this.bolt.pts, ...this.bolt.brs];
    for (const line of allLines)
      for (let i = 0; i < line.length - 1; i++) {
        p.vertex(line[i][0], line[i][1], line[i][2]);
        p.vertex(line[i + 1][0], line[i + 1][1], line[i + 1][2]);
      }
    p.endShape();
    p.strokeWeight(w);
    p.stroke(255, 235, 225, a);                           // 白熱核心
    p.beginShape(p.LINES);
    for (const line of allLines)
      for (let i = 0; i < line.length - 1; i++) {
        p.vertex(line[i][0], line[i][1], line[i][2]);
        p.vertex(line[i + 1][0], line[i + 1][1], line[i + 1][2]);
      }
    p.endShape();
    if (g && g.depthMask) g.depthMask(true);
  }

  // ==========================================================================
  // 深海底光：海床上緩移的柔亮光斑（模擬上方透下的散射光在沙丘上游走）
  //   貼地壓扁圓盤、每圈貼 floorZ；緩慢漂移 + 明暗呼吸 → 海床不再是一片死平
  // ==========================================================================
  drawCaustics(p, mode, t) {
    if (!this.caustics) {
      let seed = 31415;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      this.caustics = [];
      for (let k = 0; k < 10; k++) {
        this.caustics.push({
          x: (rnd() - 0.5) * 70, y: (rnd() - 0.5) * 70,
          r: 3.5 + rnd() * 5.5, ph: rnd() * 6.28,
          sp: 0.05 + rnd() * 0.08, br: 0.6 + rnd() * 0.4,
        });
      }
    }
    const dim = mode === "glow" ? 0.4 : 1;
    const g = p.drawingContext;
    if (g && g.depthMask) g.depthMask(false);
    shaderOff(p);
    p.noStroke();
    for (const c of this.caustics) {
      const cx = c.x + Math.sin(t * c.sp + c.ph) * 3.5;
      const cy = c.y + Math.cos(t * c.sp * 0.7 + c.ph * 1.6) * 3.5;
      const breathe = 0.62 + 0.38 * Math.sin(t * 0.5 + c.ph * 2);  // 明暗呼吸
      const a = 26 * breathe * c.br * dim;
      // ★中心亮→邊緣透明的徑向漸層（舊版整片同一 alpha ＝ 生硬多邊形亮片貼在地上）
      p.beginShape(p.TRIANGLE_FAN);
      p.fill(120, 190, 235, a);
      p.vertex(cx, cy, this.floorZ(cx, cy) + 0.09);
      for (let i = 0; i <= 16; i++) {
        const ang = (i / 16) * Math.PI * 2;
        const rr = c.r * (0.8 + 0.2 * Math.sin(ang * 3 + c.ph));   // 邊緣不規則
        const x = cx + Math.cos(ang) * rr, y = cy + Math.sin(ang) * rr;
        p.fill(120, 190, 235, 0);                                  // 邊緣全透明 → 柔和光斑
        p.vertex(x, y, this.floorZ(x, y) + 0.09);
      }
      p.endShape();
    }
    if (g && g.depthMask) g.depthMask(true);
  }

  // ==========================================================================
  // 深海光柱：高處透下的柔和光帶（鏡頭朝向的直立公告牌、頂端緩擺、上亮下淡）
  //   不寫深度 → 實體仍然正確遮擋；遠的沉進霧色
  // ==========================================================================
  drawRays(p, mode, t) {
    if (!this.rays) {
      let seed = 888;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      this.rays = [];
      for (let k = 0; k < 6; k++) {
        const ang = rnd() * 6.28, rad = 6 + rnd() * 30;
        this.rays.push({
          x: Math.cos(ang) * rad, y: Math.sin(ang) * rad,
          w: 2.5 + rnd() * 4, ph: rnd() * 6.28,
          lean: 1.5 + rnd() * 2.5, sp: 0.10 + rnd() * 0.08,
        });
      }
    }
    const eye = this.camEye;
    const up = this.env === "up";                      // 逆世界：穿雲而出的暖紅光柱
    const fog = envFogRGB(this.env, mode === "glow", 0);
    const dim = mode === "glow" ? 0.5 : 1;             // 純發光模式壓暗
    const g = p.drawingContext;
    if (g && g.depthMask) g.depthMask(false);
    shaderOff(p);
    p.noStroke();
    for (const r of this.rays) {
      // 直立公告牌：水平右向量 = 讓直立平面朝向鏡頭
      let fx = eye[0] - r.x, fy = eye[1] - r.y;
      const fl2 = Math.hypot(fx, fy) || 1;
      fx /= fl2; fy /= fl2;
      const rx = fy, ry = -fx;
      const sw = Math.sin(t * r.sp + r.ph) * r.lean;   // 頂端搖擺
      const d = Math.hypot(r.x - eye[0], r.y - eye[1], 3 - eye[2]);
      const k = this.fogK(d);
      // 光柱色：深海＝蒼白藍光 (170,210,255)；逆世界＝風暴縫隙暖紅光 (255,150,95)
      const r0 = up ? 255 : 170, r1 = up ? 150 : 210, r2 = up ? 95 : 255;
      const cr = Math.min(255, (r0 + (fog[0] * 255 - r0) * k) * dim);
      const cg = Math.min(255, (r1 + (fog[1] * 255 - r1) * k) * dim);
      const cb = Math.min(255, (r2 + (fog[2] * 255 - r2) * k) * dim);
      const bz = up ? this.floorZ(r.x, r.y) + 0.4 : -11.5;   // 下端：up 落在起伏地面上
      // ★7 欄水平漸層：中心亮、兩側透明 → 柔和光柱（舊版左右是硬邊矩形＝塑膠布感）
      const COLS = 7;
      p.beginShape(p.TRIANGLE_STRIP);
      for (let i = 0; i < COLS; i++) {
        const u = -1 + (2 * i) / (COLS - 1);
        const f = Math.pow(Math.max(0, 1 - Math.abs(u)), 1.35);   // 水平軟邊衰減
        p.fill(cr, cg, cb, (up ? 95 : 80) * f);               // 上端：亮（峰值比舊版高、平均差不多）
        p.vertex(r.x + rx * (sw + u * r.w * 0.3), r.y + ry * (sw + u * r.w * 0.3), 26);
        p.fill(cr, cg, cb, 4 * f);                            // 下端：淡出
        p.vertex(r.x + rx * (u * r.w * 0.5), r.y + ry * (u * r.w * 0.5), bz);
      }
      p.endShape();
    }
    if (g && g.depthMask) g.depthMask(true);
  }

  // 逆世界專用：巨影背後的紅色風暴光暈
  //   畫法 = 螢幕朝向的同心圓盤（公告牌），疊 3 層外淡內亮 → 偽徑向漸層；
  //   顏色先按距離霧往天空色沉（遠看是暗紅餘燼，不會像貼紙一樣突兀）
  drawStormGlow(p, mode, t) {
    const g = this.stormGlow;
    if (!g) return;
    const eye = this.camEye;
    // 公告牌基底：法線 = 光暈 → 攝影機；右/上向量算法跟海洋雪一致
    let fx = eye[0] - g.x, fy = eye[1] - g.y, fz = eye[2] - g.z;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    let rx = fy, ry = -fx;                        // cross(法線, 世界上方 z)
    const rl = Math.hypot(rx, ry) || 1e-6;
    rx /= rl; ry /= rl;
    const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx;   // cross(右, 法線)

    // 霧化：光暈比實體耐霧一點（0.75 折扣）→ 紅光仍能透出來
    const k = this.fogK(fl) * 0.75;
    const bg = envFogRGB(this.env, mode === "glow", this.flash || 0);
    const sink = c => [0, 1, 2].map(i => c[i] * (1 - k) + bg[i] * k);

    shaderOff(p);
    p.noStroke();
    const pulse = 0.92 + 0.08 * Math.sin(t * 0.9);       // 緩慢呼吸，像風暴在悶燒
    // 多層同心圓疊加：每層只加一點透明度 → 合成後是平滑的徑向漸層（層數少會看到硬邊圓環）
    const layers = [                                      // [半徑比例, 透明度, 紅光色]
      [1.00, 30, [150, 34, 26]],
      [0.87, 34, [158, 36, 27]],
      [0.74, 38, [168, 38, 28]],
      [0.62, 44, [178, 41, 30]],
      [0.50, 50, [190, 44, 32]],
      [0.39, 58, [204, 50, 35]],
      [0.28, 68, [220, 58, 39]],
      [0.18, 82, [236, 74, 44]],
    ];
    for (const [rf, al, col] of layers) {
      const c = sink(col);
      p.fill(c[0], c[1], c[2], al * pulse);
      p.beginShape(p.TRIANGLE_FAN);
      p.vertex(g.x, g.y, g.z);                          // 圓心
      const rad = g.r * rf;
      for (let i = 0; i <= 24; i++) {                   // 24 段外圈（更圓）
        const a = (i / 24) * Math.PI * 2;
        const cs = Math.cos(a) * rad, sn = Math.sin(a) * rad;
        p.vertex(g.x + rx * cs + ux * sn,
                 g.y + ry * cs + uy * sn,
                 g.z + uz * sn);
      }
      p.endShape();
    }
  }

  // 海洋雪：朝向鏡頭的「軟光點」（中心亮、邊緣0 的漸變圓盤）—— 不再是硬方塊
  drawSnow(p, mode, t) {
    const eye = this.camEye, tgt = this.camTarget;
    // 視線方向 → 螢幕平面的「右 / 上」（方塊對稱，正負方向不影響外觀）
    let fx = tgt[0] - eye[0], fy = tgt[1] - eye[1], fz = tgt[2] - eye[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    let rx = fy, ry = -fx;                        // cross(視線, 世界上方 z)
    const rl = Math.hypot(rx, ry) || 1e-6;
    rx /= rl; ry /= rl;
    const ux = ry * fz, uy = -rx * fz, uz = rx * fy - ry * fx;   // cross(右, 視線)

    // 底色依環境：海洋雪（深海）/ 灰燼（逆世界），且跟 background() 同一份值
    const fog255 = envFogRGB(this.env, mode === "glow", this.flash || 0);
    const ash = ENV_PALETTE[this.env].ash;
    const mix3 = (a, b, k) => [0, 1, 2].map(i => a[i] * (1 - k) + b[i] * k);

    // 8 段環的偏移方向（所有粒子共用；實際半徑 = 尺寸 × 環點）→ 比 6 段更圓
    const ring = [];
    for (let i = 0; i < 8; i++) {
      const an = (i / 8) * 6.28319, cs = Math.cos(an), sn = Math.sin(an);
      ring.push([rx * cs + ux * sn, ry * cs + uy * sn, uz * sn]);
    }
    // 一顆軟光點：中心頂點 (alpha=a) + 8 段邊 (alpha=0)
    //   → p5 WEBGL 頂點顏色內插，徑向淡出 = 柔和光暈（方塊 → 光塵）
    const dot = (x, y, z, sz, cr, cg, cb, a) => {
      if (a <= 4) return;
      for (let i = 0; i < 8; i++) {
        const r0 = ring[i], r1 = ring[(i + 1) % 8];
        p.fill(cr, cg, cb, a);
        p.vertex(x, y, z);
        p.fill(cr, cg, cb, 0);
        p.vertex(x + r0[0] * sz, y + r0[1] * sz, z + r0[2] * sz);
        p.vertex(x + r1[0] * sz, y + r1[1] * sz, z + r1[2] * sz);
      }
    };

    shaderOff(p);
    p.noStroke();
    // ---- 海洋雪：單批次軟光點（每顆依霧化程度調色+淡出 → 比 3 階帶更順）----
    p.beginShape(p.TRIANGLES);
    for (const s of this.snow) {
      const d = Math.hypot(s.x - eye[0], s.y - eye[1], s.z - eye[2]);
      const k = this.fogK(d, true);                      // 環境霧參數（跟世界同步融解）
      if (k > 0.92) continue;
      const c = mix3(ash, fog255, Math.min(1, k * 0.85)); // 遠的融進底色
      const a = 215 * Math.pow(1 - k, 1.3);               // 遠的變淡
      const sz = (0.0042 * d + 0.005) * (0.65 + s.vs * 0.85)
               * (this.env === "up" ? 1.3 : 1);      // 逆世界灰燼稍大顆（螢幕約 4~9 px）
      dot(s.x, s.y, s.z, sz, c[0], c[1], c[2], a);
    }
    p.endShape();

    // ---- 餘燼（逆世界，紅熱上升、忽明忽暗、加法疊光）/ 氣泡（深海，青白上升）----
    const em = this.env === "up";
    if (em && p.blendMode) p.blendMode(p.ADD);             // 發光疊加：餘燼會「亮起來」
    p.beginShape(p.TRIANGLES);
    for (const s of this.motes) {
      const d = Math.hypot(s.x - eye[0], s.y - eye[1], s.z - eye[2]);
      const k = this.fogK(d, true);
      if (k > 0.85) continue;                          // 太遠融進霧 → 不畫
      const tw = 0.5 + 0.5 * Math.sin(t * 2.6 + s.ph * 5);   // 每顆獨立閃爍
      const al = (em ? 230 : 155) * (1 - k) * (em ? 0.3 + 0.7 * tw : 1);
      const cr = em ? 255 : 170, cg = em ? 96 + 70 * tw : 225, cb = em ? 40 : 255;
      const sz = (0.005 * d + 0.0065) * (0.75 + s.vs * 0.8);   // 餘燼光點（比雪塵大、收更細）
      dot(s.x, s.y, s.z, sz, cr, cg, cb, al);
    }
    // ---- 孢子囊（逆世界）：貼地蒼白青綠光點，慢呼吸脈動（跟餘燼同一個加法批次）----
    if (em && this.pods) {
      for (const s of this.pods) {
        const d = Math.hypot(s.x - eye[0], s.y - eye[1], s.z - eye[2]);
        const k = this.fogK(d, true);
        if (k > 0.88) continue;                          // 太遠融進霧 → 不畫
        const br = 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 0.9 + s.ph));  // 慢呼吸（~7 秒一週期）
        const al = 190 * (1 - k) * br;
        const sz = (0.0045 * d + 0.006) * (0.7 + s.vs * 0.8) * (0.75 + 0.35 * br);
        dot(s.x, s.y, s.z, sz, 120, 240, 215, al);       // 蒼白青綠（紅土世界裡的冷光對比）
      }
    }
    p.endShape();
    if (em && p.blendMode) p.blendMode(p.BLEND);            // 還原一般混合（後面還有別的 draw）
  }

  // ==========================================================================
  // 繪製：① 環境（世界座標） → ② 生物（姿態座標） → ③ 複眼 → ④ 海雪
  //   mode: "skin" 有機皮層 / "wire" 線框 / "glow" 純發光
  // ==========================================================================
  render(p, mode, params, t, walkers) {
    // walkers = 地行獸「陣列」（可為 null；深海不畫）—— 在正確的繪製階段幫忙插畫
    const ws = walkers ? (Array.isArray(walkers) ? walkers : [walkers]) : [];
    const bio = params.bio;
    const fl = this.flash || 0;                          // 紅色閃電亮度 0~1
    const pal = ENV_PALETTE[this.env] || ENV_PALETTE.sea;
    const m = Math.min(this.meals || 0, 6);              // 已進食數（0~6 隻）
    // 階段式演化：吃第 1 隻皮膚就明顯蒼白（30% 起步）、之後每隻 +12%
    const alien = m > 0 ? 0.30 + 0.70 * (m / 6) : 0;
    const eyePale = m >= 2 ? 1 : 0;   // Ⅱ 階段（第 2 隻）：複眼定型為蒼白死眼

    // ====== 先把身體部件「局部 → 世界」（姿態矩陣在 JS 端算，GL 不做變換） ======
    const F = this.poseFrame(t);
    for (const pt of this.bodySolid) this.worldize(pt, F);
    this.worldize(this.eyes, F);

    // ====== 天空穹頂 + 高空雲層（最底層；雲用 depthMask 關深度 → 實體能蓋住雲） ======
    this.drawSky(p, mode, fl, t);
    if (this.env === "up" && mode !== "wire") this.drawClouds(p, mode, t, fl);

    // ====== 閃電實體：打閃瞬間劈落的折線電光（疊在天空/雲上，被實體蓋住） ======
    if (this.env === "up" && mode !== "wire") this.drawBolt(p, mode, fl);

    // ====== 逆世界：巨影背後的紅色風暴光暈（先畫，後畫的實體會正確遮擋） ======
    if (this.env === "up" && mode !== "wire") this.drawStormGlow(p, mode, t);

    if (mode === "wire") {
      // ====== 線框骨骼：不着色、只畫唯一邊 ======
      // 注意：p5 WEBGL 線寬是世界單位 → 乘相機距離換算成約 1.6px
      shaderOff(p);
      p.stroke(60, 220, 255, 190);
      p.strokeWeight(this.camDist * 0.002);
      p.noFill();
      this.drawEdges(p, this.edgesWorldVis);   // 目前環境的世界線框（枯樹/藤蔓/巨影只在逆世界）
      this.drawEdges(p, this.edgesBody);       // 生物骨架（已是世界座標）
      for (const w of ws) if (!w.eaten) w.drawWire(p);   // 地行獸線框（吞食中照畫、吃完先藏）
    } else {
      // ====== 着色模式（皮層 / 純發光）：走自訂 GLSL + 距離霧 ======
      p.shader(this.shader);
      this.shader.setUniform("uMode", mode === "glow" ? 1 : 0);
      this.shader.setUniform("uBio", bio);
      this.shader.setUniform("uCamEye", this.camEye);
      // 環境光 / 頂光顏色依環境（深海=白頂光、逆世界=風暴暗紅）+ 閃電片光
      this.shader.setUniform("uAmb", pal.amb);
      this.shader.setUniform("uTopColor", pal.top);
      this.shader.setUniform("uFlash", fl);
      this.shader.setUniform("uT", t);                // 時間（裂縫餘燼呼吸）
      this.shader.setUniform("uFogColor",
        envHazeRGB(this.env, mode === "glow", fl).map(v => v / 255));   // 霧目標 = 地平霾（景深）
      // ---- 材質組參數（每個繪製群組各給一組：粗糙/濕潤/甲殼） ----
      // uBump=微觀凹凸強度 uSpec=高光強度 uShine=高光銳度 uAO=假環境光遮蔽
      this.shader.setUniform("uRim", 0.22);         // 環境：螢光邊壓低
      this.shader.setUniform("uFFlip", this.fbMode ? 1.0 : 0.0);   // framebuffer 繞序修正
      this.shader.setUniform("uBump", 1.0);         // 岩石/沙地：顆粒最重
      this.shader.setUniform("uSpec", 0.10);        // 乾燥表面：高光很弱
      this.shader.setUniform("uShine", 10.0);
      this.shader.setUniform("uAO", 0.68);          // 環境 AO 加深（0.60→0.68）→ 石縫/側面更立體、更接地
      this.shader.setUniform("uMottle", 1.0);       // 環境：地表大尺度色斑（更寫實）
      this.shader.setUniform("uAlien", 0.0);        // 環境不異形化
      // ---- 景深霧：環境 4.2 單位就起霧、密度 0.05 → 遠景分層融進地平霾 ----
      this.shader.setUniform("uFogStart", 4.2);
      this.shader.setUniform("uFogDens", 0.050);
      this._gFogStart = 4.2; this._gFogDens = 0.050;   // drawParts 霧覆寫的回退值
      this.shader.setUniform("uCrack", this.env === "up" ? 1.0 : 0.0);  // 逆世界地面：裂縫餘燼
      this.shader.setUniform("uTexOrg", [0, 0, 0]);   // 環境＝靜態 → 紋理座標＝世界座標
      this.shader.setUniform("uTexYaw", 0);
      this.drawParts(p, this.worldVis);             // 只畫目前環境的物件
      this.shader.setUniform("uMottle", 0.0);       // 生物：不加地表色斑
      this.shader.setUniform("uAlien", alien);      // 生物：異形化程度（進食累積）
      this.shader.setUniform("uFogStart", 9.0);     // 生物：9 單位內不進霧（主體清楚）
      this.shader.setUniform("uFogDens", 0.035);
      this._gFogStart = 9.0; this._gFogDens = 0.035;
      this.shader.setUniform("uCrack", 0.0);        // 生物不長裂縫光
      this.shader.setUniform("uRim", 1.0);          // 生物：完整螢光
      this.shader.setUniform("uBump", 0.55);        // 生物皮膚：微皺褶（不要太重，避免搶掉輪廓）
      this.shader.setUniform("uSpec", 0.55);        // 濕潤表皮 → 明顯反光斑
      this.shader.setUniform("uShine", 28.0);       // 又小又亮（像沾了水）
      this.shader.setUniform("uAO", 0.4);
      this.shader.setUniform("uTexOrg", [this.pose.x, this.pose.y, this.pose.z]);  // 皮膚紋理掛在身體框架
      this.shader.setUniform("uTexYaw", this.pose.heading);                        // → 移動/轉向時不游泳
      // 抽象碎片：抽象度 < 5% 收起來（讓「原始蝠翼造型」能完整重現）
      //（Skin 版 = 排除 faceHoles：眼窩/嘴縫不吃 uAlien 蒼白化，要保持近黑）
      const solid = (params.abs == null ? 75 : params.abs) >= 5
        ? this.bodySolidSkin : this.bodySolidNoShardsSkin;
      this.drawParts(p, solid);
      if (ws.length) {
        // 地行獸：半螢光（比較像環境生物，不搶主角的戲）+ 甲殼材質
        this.shader.setUniform("uAlien", 0.0);      // 獵物不會異形化（只有利維坦會）
        this.shader.setUniform("uRim", 0.45);       // 0.6→0.45：青光整圈包住＝鋁箔感，壓低讓甲殼材質出頭
        this.shader.setUniform("uBump", 0.8);
        this.shader.setUniform("uSpec", 0.35);      // 甲殼：比皮膚澀一點
        this.shader.setUniform("uShine", 16.0);
        this.shader.setUniform("uAO", 0.55);        // 低伏生物 → 貼地遮蔽更重
        for (const w of ws) if (!w.eaten) {
          this.shader.setUniform("uTexOrg", [w.x, w.y, w.z]);   // 甲殼紋理掛在地行獸框架
          this.shader.setUniform("uTexYaw", w.heading);
          w.drawSolid(p);
        }
      }
    }

    // ====== 接地陰影：樹/巖/巨影 + 兩隻生物腳下的柔軟暗斑（讓所有東西「落地」） ======
    if (mode !== "wire") this.drawContactShadows(p, mode, ws);
    // ====== 深海底光：海床上緩移的散射光斑（只在深海） ======
    if (this.env === "sea" && mode !== "wire") this.drawCaustics(p, mode, t);

    // ====== 複眼：自發光脈動（預設着色器、世界座標） ======
    // 用「填色」而非描邊（p5 WEBGL 描邊寬度是世界單位、會失控變巨塊）
    shaderOff(p);
    const eyes = this.eyes;
    const pulse = 0.7 + 0.3 * Math.sin(t * 3.0);
    const g = Math.min(255, 120 + 135 * pulse * bio);
    p.noStroke();
    // Ⅱ 階段（第 2 隻）：從「電光青」定型成「威可那式蒼白死眼」（骨白、不再脈動）
    p.fill((60 * pulse * bio + 30) * (1 - eyePale) + 238 * eyePale,
           g * (1 - eyePale) + 226 * eyePale,
           255 * (1 - eyePale) + 214 * eyePale);
    p.beginShape(p.TRIANGLES);
    const { wpos: ep, faces: ef } = eyes;
    for (let i = 0; i < ef.length; i++) {
      const v = ef[i] * 3;
      p.vertex(ep[v], ep[v + 1], ep[v + 2]);
    }
    p.endShape();
    // 光暈第二層：眼球輪廓細線（線寬 = 相機距離 × 係數 → 約 3px，隨縮放穩定）
    if (mode !== "skin") {
      p.noFill();
      p.stroke(120, 255, 255, 70);
      p.strokeWeight(this.camDist * 0.004);
      p.beginShape(p.LINES);
      for (let i = 0; i < ef.length; i += 3) {
        const a = ef[i] * 3, b = ef[i + 1] * 3, c = ef[i + 2] * 3;
        p.vertex(ep[a], ep[a + 1], ep[a + 2]); p.vertex(ep[b], ep[b + 1], ep[b + 2]);
        p.vertex(ep[b], ep[b + 1], ep[b + 2]); p.vertex(ep[c], ep[c + 1], ep[c + 2]);
      }
      p.endShape();
    }

    // 異形人臉的眼窩/嘴縫 + 頸鰓裂 + 角質爪：近黑無光（皮膚色部件已隨身體着色器畫過）
    if (mode !== "wire") this.drawParts(p, [this.faceHoles, this.gills, this.claws].filter(q => q));

    for (const w of ws) if (!w.eaten) w.drawEyes(p, t);   // 地行獸的琥珀色雙眼（脈動微光）
    if (this.burst && this.burst.length) this.drawBurst(p);   // 捕食爆點餘燼

    // ====== 貼地霧團（畫在實體之後 → 透明混合疊在遠景上） ======
    if (mode !== "wire") this.drawMist(p, mode, t, fl);
    // ====== 光柱（兩種環境：深海蒼白藍、逆世界穿雲暖紅；上亮下淡、頂端緩擺） ======
    if (mode !== "wire") this.drawRays(p, mode, t);

    // ====== 海洋雪：飄在世界中的懸浮微粒 ======
    this.drawSnow(p, mode, t);
  }
}
