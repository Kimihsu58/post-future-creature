// ============================================================================
// post.js — 後製著色器：場景先畫進 framebuffer，再用這支 shader 統一「上質感」
// ----------------------------------------------------------------------------
// 效果（全部可調、疊在同一個 fragment shader 裡）：
//   1. Bloom 泛光      — 亮部（複眼/閃電/螢光邊）往外暈開，電影感的關鍵
//   2. 色散 CA         — 畫面邊緣 R/B 輕微分離，像真實鏡頭
//   3. 銳化           — 補償雙線性縮放的柔，細節更「利」
//   4. Filmic 調色     — 輕微對比 S 曲線 + 暗部冷青藍 / 亮部暖的分級（紅色場景拉出冷暖層次）
//   5. 暗角 Vignette  — 四角壓暗，目光自然集中到中央的生物
//   6. 膠片顆粒 Grain  — 極輕微的動態雜訊，消除數位乾淨感
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
uniform float uContrast;     // 對比提升 0~1
uniform float uGrade;        // 分級調色 0~1（暗部冷青藍、亮部暖）
uniform float uFlipY;        // framebuffer 座標 Y 是否翻轉（p5 相依，除錯用）

// 單通道 pseudo-random（膠片顆粒）
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

// 採樣場景（統一入口，方便插入翻轉/色散）
vec3 scene(vec2 uv) {
  return texture2D(uScene, vec2(uv.x, mix(uv.y, 1.0 - uv.y, uFlipY))).rgb;
}

void main() {
  vec2 uv = vUv;
  vec2 dir = uv - 0.5;                 // 離畫面中心的向量
  float r = length(dir);               // 中心 0 → 四角 ~0.7

  // ── 1. 色散：R 往外推、B 往內收（只有邊緣明顯，像鏡頭色差） ──
  float ca = uCA * r * r * 0.004;
  vec3 col;
  col.r = scene(uv + dir * ca).r;
  col.g = scene(uv).g;
  col.b = scene(uv - dir * ca).b;

  // ── 2. 銳化（unsharp mask）：原圖減去四周模糊值 → 細節更利 ──
  vec2 px = 1.0 / uRes;
  vec3 blur = (scene(uv + vec2(px.x, 0.0)) + scene(uv - vec2(px.x, 0.0)) +
               scene(uv + vec2(0.0, px.y)) + scene(uv - vec2(0.0, px.y))) * 0.25;
  col += (col - blur) * uSharp * 0.9;

  // ── 3. 泛光 Bloom：亮部在一圈取樣點上加權暈開（半徑 ~14px） ──
  //    沒有獨立降解析度 pass，用雙層 poisson 近似（便宜但夠用）
  vec2 bloomR = px * 14.0;
  vec3 bloom = vec3(0.0);
  const int N = 12;
  for (int i = 0; i < N; i++) {
    float a = 6.28318 * float(i) / float(N);
    vec2 o = vec2(cos(a), sin(a)) * bloomR;
    vec3 s = scene(uv + o);
    float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
    bloom += s * smoothstep(0.62, 1.0, lum);       // 只有亮的才進 bloom
  }
  bloom /= float(N);
  // 內圈再補一層近光暈
  for (int i = 0; i < N; i++) {
    float a = 6.28318 * (float(i) + 0.5) / float(N);
    vec2 o = vec2(cos(a), sin(a)) * bloomR * 0.35;
    vec3 s = scene(uv + o);
    float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
    bloom += s * smoothstep(0.62, 1.0, lum) * 1.4;
  }
  bloom /= float(N) + 1.4;
  col += bloom * uBloom * 2.2;

  // ── 4. Filmic 調色：輕 S 曲線（壓高光、拉對比） + 飽和微增 ──
  col = mix(col, col * col * (3.0 - 2.0 * col), uContrast * 0.45);
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum), col, 1.0 + uContrast * 0.22);

  // ── 4b. 分級調色：暗部推冷青藍、亮部推暖 → 紅色場景拉出冷暖層次（不再一片同色溫）──
  float l2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col += uGrade * (1.0 - smoothstep(0.0, 0.45, l2)) * vec3(-0.010, 0.005, 0.024);
  col += uGrade * smoothstep(0.55, 1.0, l2) * vec3(0.022, 0.010, -0.010);
  col = max(col, vec3(0.0));

  // ── 5. 暗角：四角壓暗（順滑，最外圈 ~45%） ──
  col *= 1.0 - smoothstep(0.35, 0.85, r) * uVig * 0.5;

  // ── 6. 膠片顆粒：極輕微、隨時間抖動 ──
  float g = hash(uv * uRes + fract(uTime) * 100.0);
  col += (g - 0.5) * uGrain * 0.06;

  gl_FragColor = vec4(col, 1.0);
}`;
