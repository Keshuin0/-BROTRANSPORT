import * as THREE from 'three';

let renderer: THREE.WebGLRenderer | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let scene: THREE.Scene | null = null;
let particles: THREE.Points | null = null;
let grid: THREE.GridHelper | null = null;
let radarLine: THREE.Line | null = null;

let width = 0;
let height = 0;
let mouseX = 0;
let mouseY = 0;
let targetRotationX = 0;
let targetRotationY = 0;
let currentRotationX = 0;
let currentRotationY = 0;

let scanFreqMultiplier = 1.0;
let noiseMultiplier = 1.0;
let rotationMultiplier = 1.0;

self.onmessage = (event) => {
  const { type, canvas, w, h, mx, my, value } = event.data;

  if (type === 'init' && canvas) {
    init(canvas, w, h);
  } else if (type === 'resize') {
    resize(w, h);
  } else if (type === 'mousemove') {
    mouseX = mx;
    mouseY = my;
    targetRotationY = mouseX * 0.5;
    targetRotationX = mouseY * 0.3;
  } else if (type === 'update_freq') {
    scanFreqMultiplier = value;
  } else if (type === 'update_noise') {
    noiseMultiplier = value;
  } else if (type === 'update_rotation') {
    rotationMultiplier = value;
  }
};

function init(canvas: HTMLCanvasElement, w: number, h: number) {
  width = w;
  height = h;

  // Scene
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x0b0f19, 0.015);

  // Camera
  camera = new THREE.PerspectiveCamera(45, width / height, 1, 1000);
  camera.position.set(0, 45, 100);
  camera.lookAt(0, 5, 0);

  // Renderer (Offscreen)
  renderer = new THREE.WebGLRenderer({
    canvas: canvas,
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);

  // Tactical Radar Grid Floor
  const gridColors = new THREE.Color(0x3b82f6); // blue-500
  grid = new THREE.GridHelper(200, 40, gridColors, new THREE.Color(0x1e293b));
  grid.position.y = -10;
  scene.add(grid);

  // Create Tactical LIDAR Conveyor Particles
  const particleCount = 2500;
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(particleCount * 3);
  const colors = new Float32Array(particleCount * 3);

  // Generate particles representing a convoy block
  let index = 0;
  for (let c = 0; c < 3; c++) {
    const truckZ = (c - 1) * 45; // Spacing of trucks in convoy
    
    // Truck cab particle outline
    for (let i = 0; i < 500; i++) {
      // Cab geometry
      let px = (Math.random() - 0.5) * 8;
      let py = Math.random() * 9 - 10;
      let pz = truckZ + (Math.random() - 0.5) * 14;

      positions[index * 3] = px;
      positions[index * 3 + 1] = py;
      positions[index * 3 + 2] = pz;

      // Color coding: Blue/Amber tactical mix
      const isAmber = Math.random() > 0.8;
      colors[index * 3] = isAmber ? 0.96 : 0.23; // R
      colors[index * 3 + 1] = isAmber ? 0.62 : 0.51; // G
      colors[index * 3 + 2] = isAmber ? 0.04 : 0.96; // B

      index++;
    }

    // Trailer long cargo bed outline
    for (let i = 0; i < 300; i++) {
      let px = (Math.random() - 0.5) * 8;
      let py = Math.random() * 5 - 10;
      let pz = truckZ - 12 + (Math.random() - 0.5) * 20;

      positions[index * 3] = px;
      positions[index * 3 + 1] = py;
      positions[index * 3 + 2] = pz;

      colors[index * 3] = 0.23;
      colors[index * 3 + 1] = 0.51;
      colors[index * 3 + 2] = 0.96;

      index++;
    }
  }

  // Fill remaining particles with background scanning noise
  while (index < particleCount) {
    positions[index * 3] = (Math.random() - 0.5) * 200;
    positions[index * 3 + 1] = (Math.random() - 0.5) * 4 - 8;
    positions[index * 3 + 2] = (Math.random() - 0.5) * 200;

    colors[index * 3] = 0.11;
    colors[index * 3 + 1] = 0.16;
    colors[index * 3 + 2] = 0.23;
    index++;
  }

  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // Custom circular glowing points shader
  const material = new THREE.PointsMaterial({
    size: 1.2,
    vertexColors: true,
    transparent: true,
    opacity: 0.85,
    sizeAttenuation: true,
  });

  particles = new THREE.Points(geometry, material);
  scene.add(particles);

  // Radar Sweeping Green Line
  const radarGeom = new THREE.BufferGeometry();
  const radarPositions = new Float32Array([
    -100, -10, 0,
     100, -10, 0
  ]);
  radarGeom.setAttribute('position', new THREE.BufferAttribute(radarPositions, 3));
  const radarMat = new THREE.LineBasicMaterial({
    color: 0xf59e0b, // Amber-500
    linewidth: 2,
  });
  radarLine = new THREE.Line(radarGeom, radarMat);
  scene.add(radarLine);

  animate();
}

function resize(w: number, h: number) {
  width = w;
  height = h;

  if (camera) {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  if (renderer) {
    renderer.setSize(width, height, false);
  }
}

let lastTime = 0;
function animate() {
  requestAnimationFrame(animate);

  const time = performance.now() * 0.001;
  const delta = time - lastTime;
  lastTime = time;

  // Animate sweep line back and forth
  if (radarLine) {
    radarLine.position.z = Math.sin(time * 0.6 * scanFreqMultiplier) * 90;
  }

  // Smooth mouse rotation dampening
  currentRotationX += (targetRotationX - currentRotationX) * 0.05;
  currentRotationY += (targetRotationY - currentRotationY) * 0.05;

  if (scene) {
    // Base rotating movement
    scene.rotation.y = time * 0.04 * rotationMultiplier + currentRotationY;
    scene.rotation.x = currentRotationX;
  }

  // Animate noise particles slightly
  if (particles) {
    const positions = particles.geometry.attributes.position.array as Float32Array;
    const count = positions.length / 3;
    // Only animate the background noise particles (index >= 2400)
    for (let i = 2400; i < count; i++) {
      positions[i * 3 + 1] += Math.sin(time * 2 + i) * 0.005 * noiseMultiplier;
    }
    particles.geometry.attributes.position.needsUpdate = true;
  }

  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}
