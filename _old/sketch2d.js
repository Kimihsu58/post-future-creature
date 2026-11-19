// sketch.js
// Post-future creature: fiber-optic tentacles, robotic limbs, glitch skin, hive-mind dots.
// Beginner-friendly: everything is drawn with p5.js 2D functions.

let tentacles = [];
let particles = [];

const NUM_TENTACLES = 10;   // how many tentacles
const SEGMENTS = 16;        // segments per tentacle
const SEG_LEN = 12;         // length of each segment (px)
const BODY_R = 60;          // body radius

let glitchTimer = 0;        // counts frames, used to trigger glitch bursts

function setup() {
  createCanvas(windowWidth, windowHeight);
  initCreature();
}

function initCreature() {
  tentacles = [];
  let cx = width / 2;
  let cy = height / 2;
  for (let t = 0; t < NUM_TENTACLES; t++) {
    let angle = (TWO_PI / NUM_TENTACLES) * t;
    let bx = cx + cos(angle) * BODY_R * 0.5;
    let by = cy + sin(angle) * BODY_R * 0.5;
    tentacles.push(new Tentacle(bx, by, angle, SEGMENTS, SEG_LEN));
  }
  // Hive-mind: many tiny units that move in sync around the creature
  particles = [];
  for (let i = 0; i < 140; i++) {
    particles.push({
      a: random(TWO_PI),
      r: random(BODY_R + 20, BODY_R + 220),
      speed: random(0.004, 0.018),
      size: random(1, 3)
    });
  }
}

function draw() {
  background(5, 7, 11); // solid background: no trails/motion smear

  let cx = width / 2;
  let cy = height / 2;
  // mouse target (default to center if not moved yet)
  let mx = (mouseX > 0) ? mouseX : cx;
  let my = (mouseY > 0) ? mouseY : cy;

  // Update tentacle anchor bases so they stay around the body even if window resized
  for (let t = 0; t < tentacles.length; t++) {
    let angle = (TWO_PI / NUM_TENTACLES) * t;
    tentacles[t].base.x = cx + cos(angle) * BODY_R * 0.5;
    tentacles[t].base.y = cy + sin(angle) * BODY_R * 0.5;
    tentacles[t].update(mx, my);
  }

  // Draw hive-mind particles first (behind body)
  drawHive(cx, cy);

  // Draw body
  drawBody(cx, cy);

  // Draw tentacles on top
  for (let tent of tentacles) tent.draw();

  // Glitch effect on top: random horizontal slices shifted
  applyGlitch();

  // Scanlines
  drawScanlines();
}

function drawBody(cx, cy) {
  push();
  noStroke();
  // Outer glow
  for (let r = BODY_R + 30; r > BODY_R; r -= 4) {
    let a = map(r, BODY_R, BODY_R + 30, 120, 0);
    fill(60, 180, 140, a);
    circle(cx, cy, r * 2);
  }
  // Core body with noisy edge (glitch/nature surface)
  beginShape();
  for (let a = 0; a < TWO_PI; a += 0.08) {
    let n = noise(cos(a) * 2 + 100, sin(a) * 2 + 100, frameCount * 0.005);
    let r = BODY_R + (n - 0.5) * 24;
    vertex(cx + cos(a) * r, cy + sin(a) * r);
  }
  endShape(CLOSE);
  // Inner dark core
  fill(5, 7, 11, 200);
  circle(cx, cy, BODY_R * 1.1);
  pop();
}

function drawHive(cx, cy) {
  push();
  noStroke();
  let sharedPhase = frameCount * 0.02;
  for (let p of particles) {
    let a = p.a + sharedPhase * (p.speed * 60);
    let x = cx + cos(a) * p.r;
    let y = cy + sin(a) * p.r;
    let flicker = 0.85 + 0.15 * sin(frameCount * 0.1 + p.a * 5);
    fill(120, 255, 200, 180 * flicker);
    circle(x, y, p.size);
  }
  pop();
}

function applyGlitch() {
  // Trigger a glitch burst every ~90 frames
  glitchTimer++;
  if (glitchTimer < 5) {
    // during burst, draw a few shifted slices
    let slices = 6;
    for (let i = 0; i < slices; i++) {
      let y = random(height);
      let h = random(2, 12);
      let shift = random(-24, 24);
      let band = get(0, y, width, h);
      image(band, shift, y);
    }
  }
  if (glitchTimer > 180) glitchTimer = 0;
}

function drawScanlines() {
  push();
  stroke(255, 255, 255, 8);
  strokeWeight(1);
  for (let y = 0; y < height; y += 4) {
    line(0, y, width, y);
  }
  pop();
}

// ---------- Tentacle class ----------
class Tentacle {
  constructor(bx, by, baseAngle, n, l) {
    this.base = createVector(bx, by);
    this.n = n;
    this.l = l;
    this.noiseOffset = random(1000);
    // start stretched along base angle
    this.pts = [];
    this.prev = [];
    for (let i = 0; i <= n; i++) {
      let v = createVector(bx + cos(baseAngle) * (i * l),
                           by + sin(baseAngle) * (i * l));
      this.pts.push(v);
      this.prev.push(v.copy());
    }
  }

  update(mx, my) {
    // pin base at its (possibly moved) anchor
    this.pts[0].set(this.base.x, this.base.y);

    // Verlet: keep velocity from previous frame, add small noise wave
    for (let i = 1; i < this.pts.length; i++) {
      let p = this.pts[i];
      let pp = this.prev[i];
      let vx = (p.x - pp.x) * 0.9;
      let vy = (p.y - pp.y) * 0.9;
      let n = noise(this.noiseOffset + i * 0.25 + frameCount * 0.008);
      vx += (n - 0.5) * 2.0;
      vy += (n - 0.5) * 2.0;
      this.prev[i].set(p.x, p.y);
      p.x += vx;
      p.y += vy;
    }

    // Pull the tip toward the mouse
    let tip = this.pts[this.pts.length - 1];
    tip.x += (mx - tip.x) * 0.15;
    tip.y += (my - tip.y) * 0.15;

    // Solve distance constraints (iterations for stability)
    for (let iter = 0; iter < 6; iter++) {
      this.pts[0].set(this.base.x, this.base.y); // keep base pinned
      for (let i = this.pts.length - 1; i >= 1; i--) {
        let a = this.pts[i - 1];
        let b = this.pts[i];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = sqrt(dx * dx + dy * dy);
        if (d > 0) {
          let diff = (d - this.l) / d;
          // move a toward b, b toward a
          if (i > 1) {
            a.x += dx * diff * 0.5;
            a.y += dy * diff * 0.5;
          }
          b.x -= dx * diff * 0.5;
          b.y -= dy * diff * 0.5;
        }
      }
      this.pts[0].set(this.base.x, this.base.y);
    }
  }

  draw() {
    // Fiber-optic look: thicker at base (index 0), thinner at tip
    for (let i = 0; i < this.pts.length - 1; i++) {
      let t = i / (this.pts.length - 1);
      let w = lerp(7, 1, t);
      strokeWeight(w);
      // color shift from cyan (base) to green (tip)
      let r = lerp(80, 40, t);
      let g = lerp(220, 255, t);
      let b = lerp(200, 120, t);
      stroke(r, g, b, 210);
      line(this.pts[i].x, this.pts[i].y,
           this.pts[i + 1].x, this.pts[i + 1].y);
    }
    // glowing tip
    noStroke();
    fill(180, 255, 220, 230);
    circle(this.pts[this.pts.length - 1].x,
           this.pts[this.pts.length - 1].y, 8);
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  initCreature();
}
