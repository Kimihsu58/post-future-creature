// Minimal working tentacle - 100 lines, no bugs

let tentacles = [];

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
}

function draw() {
  background(10, 15, 20);
  
  orbitControl();
  ambientLight(60);
  directionalLight(255, 255, 255, 0, 0, -1);
  
  let t = millis() * 0.001;
  
  // Center sphere - PULSES
  push();
  noStroke();
  fill(0, 255, 200, 100 + 100 * sin(t * 2));
  sphere(30 + 10 * sin(t * 2));
  pop();
  
  // 8 tentacles - SIMPLE sine wave motion
  for (let i = 0; i < 8; i++) {
    let angle = i * TWO_PI / 8;
    let baseX = cos(angle) * 40;
    let baseY = sin(angle) * 40;
    
    stroke(100 + i * 20, 200, 150, 220);
    strokeWeight(5);
    noFill();
    
    beginShape();
    for (let seg = 0; seg <= 20; seg++) {
      let segT = seg / 20;
      let x = baseX + sin(t * 2 + segT * 3 + i) * 60 * segT;
      let y = baseY + cos(t * 1.5 + segT * 3 + i) * 60 * segT;
      let z = segT * 200 + sin(t + segT * 2 + i) * 40;
      vertex(x, y, z);
    }
    endShape();
    
    // Tip
    push();
    translate(
      baseX + sin(t * 2 + 3 + i) * 60,
      baseY + cos(t * 1.5 + 3 + i) * 60,
      200 + sin(t + 2 + i) * 40
    );
    noStroke();
    fill(255, 255, 200);
    sphere(8);
    pop();
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}