// sketch.js  (simplified assembly for debugging)

let torsoModel, headCoreModel, petalModel;
let upperArmModel, lowerArmModel, clawModel;
let upperLegModel, lowerLegModel, footModel;

function preload() {
  torsoModel     = loadModel('models/torso.obj', true);
  headCoreModel  = loadModel('models/head_core.obj', true);
  petalModel     = loadModel('models/petal.obj', true);
  upperArmModel  = loadModel('models/upper_arm.obj', true);
  lowerArmModel  = loadModel('models/lower_arm.obj', true);
  clawModel      = loadModel('models/claw.obj', true);
  upperLegModel  = loadModel('models/upper_leg.obj', true);
  lowerLegModel  = loadModel('models/lower_leg.obj', true);
  footModel      = loadModel('models/foot.obj', true);
}

function setup() {
  createCanvas(windowWidth, windowHeight, WEBGL);
}

function draw() {
  background(5, 7, 11);

  // Simple, even lighting
  ambientLight(70);
  directionalLight(180, 180, 180, 0, 0, -1);

  orbitControl();

  // Scene orientation only: no scale/animation tricks
  push();
  rotateX(-HALF_PI);
  scale(30);

  // Torso
  model(torsoModel);

  // Head
  push();
  translate(0, 0, 0.8);
  model(headCoreModel);
  for (let i = 0; i < 5; i++) {
    push();
    rotateZ((TWO_PI / 5) * i);
    rotateX(0.6);
    model(petalModel);
    pop();
  }
  pop();

  // Arms
  for (let side of [-1, 1]) {
    push();
    translate(side * 0.3, 0, 0.5);
    rotateX(PI);
    model(upperArmModel);
    translate(0, 0, 1.2);
    model(lowerArmModel);
    translate(0, 0, 1.0);
    model(clawModel);
    pop();
  }

  // Legs
  for (let side of [-1, 1]) {
    push();
    translate(side * 0.15, 0, -0.7);
    rotateX(PI);
    model(upperLegModel);
    translate(0, 0, 1.3);
    model(lowerLegModel);
    translate(0, 0, 1.1);
    model(footModel);
    pop();
  }

  pop();
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}
