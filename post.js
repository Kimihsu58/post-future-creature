// ============================================================================
// post.js — 後製著色器：場景先畫進 framebuffer，再用這支 shader 統一「上質感」
// ----------------------------------------------------------------------------
// 效果（全部可調、疊在同一個 fragment shader 裡）：
//   0. FXAA 抗鋸齒    — 邊緣感知的反鋸齒（治邊緣鋸齒，補超取樣的不足）
//   1. Bloom 泛光      — 亮部三層暈開（近光暈 5px / 主體 14px / 外圈 56px）
//   2. 色散 CA         — 畫面邊緣 R/B 輕微分離，像真實鏡頭
//   3. 銳化           — 補償雙線性縮放的柔，細節更「利」
//   4. ACES Tone Map  — 電影感的高光滾降（替代純 S 曲線，亮部不再死白）
//   5. 分級調色       — 暗部冷青藍 / 亮部暖（紅色場景拉出冷暖層次）
//   6. 暗角 Vignette  — 四角壓暗，目光自然集中到中央的生物
//   7. 膠片顆粒 Grain  — 極輕微的動態雜訊，消除數位乾淨感
//   8. Dither 去色帶   — 輸出端 ±1 LSB 三角抖動（治天空漸層色帶）
// ============================================================================

// 頂點：直接把座標當成 -1~1 的全螢幕四邊形（不經矩陣變換 → 相機狀態無關）
const POST_VERT = `
attribute vec3 aPosition;   // p5 自動提供（這裡就是 -1~1 的裁切座標）
attribute vec2 aTexCoord;   // 0~1 紋理座標
varying vec2 vUv;
void main() {
  vUv = aTexCoord;
  gl_Position = vec4(aPosition.xy, 0.0, 1.0);
}`;

const POST_FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uScene;    // 場景 framebuffer 的顏色
uniform vec2 uRes;           // 畫布解析度
uniform float uTime;         // 秒（顆粒用）
uniform float uBloom;        // 泛光強度 0~1
uniform float uCA;           // 色散強度 0~1
uniform float uVig;          // 暗角強度 0~1
uniform float uGrain;        // 顆粒強度 0~1
uniform float uSharp;        // 銳化強度 0~1
uniform float uContrast;     // 對比 / ACES 強度 0~1
uniform float uGrade;        // 分級調色 0~1（暗部冷青藍、亮部暖）
uniform float uFlipY;        // framebuffer 座標 Y 是否翻轉（p5 相依，除錯用）

// 單通道 pseudo-random（膠片顆粒 / dither）
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// 採樣場景（統一入口，方便插入翻轉/色散）
vec3 scene(vec2 uv) {
  return texture2D(uScene, vec2(uv.x, mix(uv.y, 1.0 - uv.y, uFlipY))).rgb;
}

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// ── FXAA（console 版 3.11 精簡）：邊緣感知反鋸齒 ──
// 5 點偵測亮度差 → 決定邊緣方向 → 沿邊緣做 4 點加權平均。
// 只在有邊緣處模糊（平坦區完全不動），比全畫面 MSAA 便宜也更銳利。
vec3 fxaa(vec2 uv, vec2 rcp) {
  vec3 rgbNW = scene(uv + vec2(-rcp.x,  rcp.y));
  vec3 rgbNE = scene(uv + vec2( rcp.x,  rcp.y));
  vec3 rgbSW = scene(uv + vec2(-rcp.x, -rcp.y));
  vec3 rgbSE = scene(uv + vec2( rcp.x, -rcp.y));
  vec3 rgbM  = scene(uv);
  float lNW = lum(rgbNW), lNE = lum(rgbNE);
  float lSW = lum(rgbSW), lSE = lum(rgbSE), lM = lum(rgbM);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  vec2 dir;
  dir.x = -((lNW + lNE) - (lSW + lSE));
  dir.y =  ((lNW + lSW) - (lNE + lSE));
  float dirReduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
  float rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
  dir = clamp(dir * rcpDirMin, vec2(-8.0), vec2(8.0)) * rcp;

  vec3 rgbA = 0.5 * (scene(uv + dir * (1.0 / 3.0 - 0.5)) +
                      scene(uv + dir * (2.0 / 3.0 - 0.5)));
  vec3 rgbB = rgbA * 0.5 + 0.25 * (scene(uv - dir * 0.5) +
                                    scene(uv + dir * 0.5));
  float lB = lum(rgbB);
  return (lB < lMin || lB > lMax) ? rgbA : rgbB;
}

// ── ACES 電影 tone mapping（Narkowicz 擬合）：高光滾降、暗部保留層次 ──
vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14),
               0.0, 1.0);
}

void main() {
  vec2 uv = vUv;
  vec2 dir = uv - 0.5;                 // 離畫面中心的向量
  float r = length(dir);               // 中心 0 → 四角 ~0.7
  vec2 px = 1.0 / uRes;

  // ── 0. FXAA 抗鋸齒（先於所有效果，拿到乾淨的邊緣） ──
  vec3 col = fxaa(uv, px);

  // ── 1. 色散：R 往外推、B 往內收（只有邊緣明顯，像鏡頭色差） ──
  float ca = uCA * r * r * 0.004;
  if (ca > 0.00001) {
    vec3 cOff;
    cOff.r = scene(uv + dir * ca).r;
    cOff.b = scene(uv - dir * ca).b;
    col.r = mix(col.r, cOff.r, 0.8);
    col.b = mix(col.b, cOff.b, 0.8);
  }

  // ── 2. 銳化（unsharp mask）：原圖減去四周模糊值 → 細節更利 ──
  vec3 blur = (scene(uv + vec2(px.x, 0.0)) + scene(uv - vec2(px.x, 0.0)) +
               scene(uv + vec2(0.0, px.y)) + scene(uv - vec2(0.0, px.y))) * 0.25;
  col += (col - blur) * uSharp * 0.9;

  // ── 3. 分層 Bloom：三圈 poisson 近似 ──
  //    近光暈（~5px）＋ 主體（14px）＋ 外圈大半徑（56px）→ 有核心也有大範圍暈光
  const int N = 12;
  vec3 bloom = vec3(0.0);
  float wSum = 0.0;
  // 外圈大半徑（8 點，門檻稍低讓中亮部也參與）
  {
    vec2 bloomR = px * 56.0;
    for (int i = 0; i < 8; i++) {
      float a = 6.28318 * (float(i) + 0.5) / 8.0;
      vec3 s = scene(uv + vec2(cos(a), sin(a)) * bloomR);
      bloom += s * smoothstep(0.52, 1.0, lum(s)) * 0.8;
      wSum += 0.8;
    }
  }
  // 主體圈（14px）
  {
    vec2 bloomR = px * 14.0;
    for (int i = 0; i < N; i++) {
      float a = 6.28318 * float(i) / float(N);
      vec3 s = scene(uv + vec2(cos(a), sin(a)) * bloomR);
      bloom += s * smoothstep(0.62, 1.0, lum(s));
      wSum += 1.0;
    }
  }
  // 近光暈（5px，加權最高 → 核心最亮）
  {
    vec2 bloomR = px * 5.0;
    for (int i = 0; i < N; i++) {
      float a = 6.28318 * (float(i) + 0.5) / float(N);
      vec3 s = scene(uv + vec2(cos(a), sin(a)) * bloomR);
      bloom += s * smoothstep(0.62, 1.0, lum(s)) * 1.6;
      wSum += 1.6;
    }
  }
  bloom /= wSum;
  col += bloom * uBloom * 2.2;

  // ── 4. ACES tone mapping：電影感高光滾降（uContrast 控制混合量） ──
  //    比純 S 曲線好處：亮部平滑壓縮不死白、暗部自然抬一點點
  col = mix(col, aces(col * 1.18), clamp(uContrast, 0.0, 1.0));
  float lumNow = lum(col);
  col = mix(vec3(lumNow), col, 1.0 + uContrast * 0.22);   // 飽和微增

  // ── 4b. 分級調色：暗部推冷青藍、亮部推暖 → 紅色場景拉出冷暖層次 ──
  float l2 = lum(col);
  col += uGrade * (1.0 - smoothstep(0.0, 0.45, l2)) * vec3(-0.010, 0.005, 0.024);
  col += uGrade * smoothstep(0.55, 1.0, l2) * vec3(0.022, 0.010, -0.010);
  col = max(col, vec3(0.0));

  // ── 5. 暗角：四角壓暗（順滑，最外圈 ~45%） ──
  col *= 1.0 - smoothstep(0.35, 0.85, r) * uVig * 0.5;

  // ── 6. 膠片顆粒：極輕微、隨時間抖動 ──
  float g = hash(uv * uRes + fract(uTime) * 100.0);
  col += (g - 0.5) * uGrain * 0.06;

  // ── 7. Dither 去色帶：輸出端 ±1 LSB 三角機率密度（TPDF）──
  //    8-bit 量化會把平滑漸層（天空）切成色帶；±1 LSB 的抖動把帶打散成人眼看不見的顆粒
  float d1 = hash(uv * uRes + fract(uTime * 13.7) * 71.0);
  float d2 = hash(uv * uRes + fract(uTime * 7.3) * 37.0 + 19.19);
  col += ((d1 + d2) - 1.0) * (1.0 / 255.0);

  gl_FragColor = vec4(col, 1.0);
}`;
