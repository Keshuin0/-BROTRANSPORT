import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  ATMOSPHERE_RADIUS,
  BORDER_PORTS,
  CAMERA_PRESETS,
  COLOR_BRO_CYAN,
  COLOR_BRO_GOLD,
  CORRIDOR_ROUTES,
  GLOBE_RADIUS,
  HUB_LOCATIONS,
  VECTOR_EARTH_RADIUS,
  getWaitTimeSeverity,
  latLonToVector3,
  type BorderPortNode,
  type BorderWaitTimeDatum,
  type CorridorRoute,
  type GlobeNode,
} from './globeData';
import { buildVectorEarth } from './buildVectorEarth';
import {
  createAtmosphereMaterial,
  createEarthCoreMaterial,
  createPulseRingMaterial,
  getSubsolarDirection,
} from './earthShaders';

export interface GlobeEngineOptions {
  container: HTMLElement;
  onSelectNode?: (node: GlobeNode | null) => void;
  onHoverNode?: (node: GlobeNode | null) => void;
  onContextLost?: (lost: boolean) => void;
}

interface FreightPulseState {
  curve: THREE.QuadraticBezierCurve3;
  progress: number;
  speedPerSec: number;
  destHubIndex: number;
  color: THREE.Color;
}

interface HubPulseState {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  color: THREE.Color;
  progress: number; // -1 when dormant, [0..1] when expanding
}

interface FlyToState {
  targetDir: THREE.Vector3;
  targetDistance: number;
}

const UNIT_Y = new THREE.Vector3(0, 1, 0);
const UNIT_Z = new THREE.Vector3(0, 0, 1);
const RAYCAST_THROTTLE_MS = 60;
const CLICK_DRAG_THRESHOLD_PX = 6;
const PICK_SCREEN_RADIUS_PX = 18;
const IDLE_SPIN_RAD_PER_SEC = 0.032;
const SUN_UPDATE_INTERVAL_MS = 60_000;
const MIN_CAMERA_DISTANCE = 62;
const MAX_CAMERA_DISTANCE = 210;
const GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;

export class GlobeEngine {
  private readonly container: HTMLElement;
  private readonly onSelectNode?: (node: GlobeNode | null) => void;
  private readonly onHoverNode?: (node: GlobeNode | null) => void;
  private readonly onContextLost?: (lost: boolean) => void;

  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly controls: OrbitControls;

  private readonly earthCoreMaterial: THREE.ShaderMaterial;
  private readonly atmosphereMaterial: THREE.ShaderMaterial;
  private readonly earthCoreMesh: THREE.Mesh;

  private readonly hubMarkersMesh: THREE.InstancedMesh;
  private readonly borderBeaconsMesh: THREE.InstancedMesh;
  private readonly freightPulsesMesh: THREE.InstancedMesh;
  private readonly arrivalRingsMesh: THREE.InstancedMesh;
  private readonly ringAlphaAttr: THREE.InstancedBufferAttribute;
  private readonly focusReticleMesh: THREE.Mesh;
  private readonly focusReticleMat: THREE.MeshBasicMaterial;

  private readonly hubPositions: THREE.Vector3[] = [];
  private readonly hubPulseStates: HubPulseState[] = [];
  private readonly borderPorts: BorderPortNode[];
  private readonly borderPositions: THREE.Vector3[] = [];
  private readonly borderQuaternions: THREE.Quaternion[] = [];
  private readonly freightPulses: FreightPulseState[] = [];

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly tempMatrix = new THREE.Matrix4();
  private readonly tempPos = new THREE.Vector3();
  private readonly tempQuat = new THREE.Quaternion();
  private readonly tempScale = new THREE.Vector3();
  private readonly tempColor = new THREE.Color();
  private readonly tempDir = new THREE.Vector3();
  private readonly tempStepQuat = new THREE.Quaternion();
  private readonly tempIdentityQuat = new THREE.Quaternion();
  private readonly tempProjected = new THREE.Vector3();

  private animationFrameId: number | null = null;
  private resumeSpinTimeout: ReturnType<typeof setTimeout> | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private reducedMotionQuery: MediaQueryList | null = null;

  private isVisible = true;
  private isDocumentHidden = false;
  private isContextLost = false;
  private reducedMotion = false;
  private shouldSpin = true;
  private disposed = false;

  private lastFrameMs = 0;
  private lastRaycastMs = 0;
  private lastSunUpdateMs = 0;
  private lastMarkerScale = -1;

  private pointerDownPos: { x: number; y: number } | null = null;
  private hoveredNodeId: string | null = null;
  private selectedNodeId: string | null = null;
  private flyState: FlyToState | null = null;

  constructor(options: GlobeEngineOptions) {
    this.container = options.container;
    this.onSelectNode = options.onSelectNode;
    this.onHoverNode = options.onHoverNode;
    this.onContextLost = options.onContextLost;

    // Clone border port entries so live wait-time telemetry mutates instance state only
    this.borderPorts = BORDER_PORTS.map((port) => ({ ...port }));

    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);

    // 1. Scene & Camera (framed on North America by default)
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.5, 600);
    const initialPreset = CAMERA_PRESETS[2];
    const initialPos = latLonToVector3(initialPreset.lat, initialPreset.lon, initialPreset.distance);
    this.camera.position.copy(initialPos);

    // 2. Renderer (alpha, antialias, high-performance, clamped DPR <= 2)
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    this.container.appendChild(this.renderer.domElement);

    // 3. OrbitControls
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = MIN_CAMERA_DISTANCE;
    this.controls.maxDistance = MAX_CAMERA_DISTANCE;
    this.controls.rotateSpeed = 0.65;
    this.controls.zoomSpeed = 0.85;
    this.controls.target.set(0, 0, 0);
    this.controls.update();

    // 4. Real-Time Solar Terminator Earth Core (Draw Call 1)
    const sunDir = getSubsolarDirection(new Date());
    this.lastSunUpdateMs = Date.now();
    this.earthCoreMaterial = createEarthCoreMaterial(sunDir);
    const earthCoreGeometry = new THREE.SphereGeometry(GLOBE_RADIUS, 64, 64);
    this.earthCoreMesh = new THREE.Mesh(earthCoreGeometry, this.earthCoreMaterial);
    this.earthCoreMesh.name = 'earth-core';
    this.scene.add(this.earthCoreMesh);

    // 5. Fresnel Atmospheric Rim Glow (Draw Call 2)
    this.atmosphereMaterial = createAtmosphereMaterial(sunDir);
    const atmosphereGeometry = new THREE.SphereGeometry(ATMOSPHERE_RADIUS, 64, 64);
    const atmosphereMesh = new THREE.Mesh(atmosphereGeometry, this.atmosphereMaterial);
    atmosphereMesh.name = 'atmosphere-rim';
    this.scene.add(atmosphereMesh);

    // 6. GPU Vector Earth Coastlines, Country Borders & 30° Graticule (Draw Calls 3 & 4)
    const vectorEarth = buildVectorEarth(VECTOR_EARTH_RADIUS);
    this.scene.add(vectorEarth.graticule);
    this.scene.add(vectorEarth.borders);

    // 7. Merged 28 Corridor Trade Routes + 56 Freight Pulses (Draw Calls 5 & 8)
    const { corridorsLines, pulseStates } = this.buildCorridorsAndPulses();
    this.scene.add(corridorsLines);
    this.freightPulses.push(...pulseStates);

    const pulseGeo = new THREE.SphereGeometry(0.24, 10, 10);
    const pulseMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.96,
    });
    this.freightPulsesMesh = new THREE.InstancedMesh(pulseGeo, pulseMat, this.freightPulses.length);
    this.freightPulsesMesh.name = 'freight-pulses';
    this.freightPulsesMesh.frustumCulled = false;
    this.freightPulses.forEach((pulse, index) => {
      this.freightPulsesMesh.setColorAt(index, pulse.color);
    });
    if (this.freightPulsesMesh.instanceColor) {
      this.freightPulsesMesh.instanceColor.needsUpdate = true;
    }
    this.scene.add(this.freightPulsesMesh);

    // 8. 21 Logistics Hub Markers InstancedMesh (Draw Call 6)
    const hubGeo = new THREE.SphereGeometry(0.42, 16, 16);
    const hubMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.hubMarkersMesh = new THREE.InstancedMesh(hubGeo, hubMat, HUB_LOCATIONS.length);
    this.hubMarkersMesh.name = 'hub-markers';
    this.hubMarkersMesh.frustumCulled = false;
    HUB_LOCATIONS.forEach((hub, index) => {
      const pos = latLonToVector3(hub.lat, hub.lon, GLOBE_RADIUS + 0.14);
      this.hubPositions.push(pos);
      const normal = pos.clone().normalize();
      const ringQuat = new THREE.Quaternion().setFromUnitVectors(UNIT_Z, normal);
      const colorHex =
        hub.isHQ || hub.corridorTier === 'primary' ? COLOR_BRO_GOLD : COLOR_BRO_CYAN;
      const color = new THREE.Color(colorHex);
      this.hubMarkersMesh.setColorAt(index, color);
      this.hubPulseStates.push({
        position: latLonToVector3(hub.lat, hub.lon, GLOBE_RADIUS + 0.18),
        quaternion: ringQuat,
        color,
        progress: -1,
      });
    });
    if (this.hubMarkersMesh.instanceColor) {
      this.hubMarkersMesh.instanceColor.needsUpdate = true;
    }
    this.scene.add(this.hubMarkersMesh);

    // 9. 13 Border Port Beacons InstancedMesh (Draw Call 7)
    const beaconGeo = new THREE.OctahedronGeometry(0.48, 0);
    const beaconMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.borderBeaconsMesh = new THREE.InstancedMesh(beaconGeo, beaconMat, this.borderPorts.length);
    this.borderBeaconsMesh.name = 'border-port-beacons';
    this.borderBeaconsMesh.frustumCulled = false;
    this.borderPorts.forEach((port, index) => {
      const pos = latLonToVector3(port.lat, port.lon, GLOBE_RADIUS + 0.34);
      const normal = pos.clone().normalize();
      const quat = new THREE.Quaternion().setFromUnitVectors(UNIT_Y, normal);
      this.borderPositions.push(pos);
      this.borderQuaternions.push(quat);
      const { colorHex } = getWaitTimeSeverity(port.commercialWaitMinutes);
      this.tempColor.setHex(colorHex);
      this.borderBeaconsMesh.setColorAt(index, this.tempColor);
    });
    if (this.borderBeaconsMesh.instanceColor) {
      this.borderBeaconsMesh.instanceColor.needsUpdate = true;
    }
    this.scene.add(this.borderBeaconsMesh);

    // 10. 42 Arrival Pulse Rings (2 concentric per hub) InstancedMesh (Draw Call 9)
    const ringCount = HUB_LOCATIONS.length * 2;
    const ringGeo = new THREE.RingGeometry(0.42, 0.72, 28);
    const ringColors = new Float32Array(ringCount * 3);
    const ringAlphas = new Float32Array(ringCount);
    this.hubPulseStates.forEach((hubState, i) => {
      const inner = i * 2;
      const outer = i * 2 + 1;
      ringColors[inner * 3] = hubState.color.r;
      ringColors[inner * 3 + 1] = hubState.color.g;
      ringColors[inner * 3 + 2] = hubState.color.b;
      ringColors[outer * 3] = hubState.color.r;
      ringColors[outer * 3 + 1] = hubState.color.g;
      ringColors[outer * 3 + 2] = hubState.color.b;
      ringAlphas[inner] = 0;
      ringAlphas[outer] = 0;
    });
    ringGeo.setAttribute('aRingColor', new THREE.InstancedBufferAttribute(ringColors, 3));
    this.ringAlphaAttr = new THREE.InstancedBufferAttribute(ringAlphas, 1);
    ringGeo.setAttribute('aRingAlpha', this.ringAlphaAttr);

    const ringMat = createPulseRingMaterial();
    this.arrivalRingsMesh = new THREE.InstancedMesh(ringGeo, ringMat, ringCount);
    this.arrivalRingsMesh.name = 'arrival-pulse-rings';
    this.arrivalRingsMesh.frustumCulled = false;
    this.scene.add(this.arrivalRingsMesh);

    // 11. Selection / Hover Focus Reticle (Draw Call 10 when visible)
    const reticleGeo = new THREE.RingGeometry(0.72, 0.98, 32);
    this.focusReticleMat = new THREE.MeshBasicMaterial({
      color: COLOR_BRO_CYAN,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.focusReticleMesh = new THREE.Mesh(reticleGeo, this.focusReticleMat);
    this.focusReticleMesh.name = 'focus-reticle';
    this.focusReticleMesh.visible = false;
    this.scene.add(this.focusReticleMesh);

    // 11b. Deterministic Deep-Space Starfield (Fibonacci sphere + prime jitter, 1 draw call, zero Math.random())
    const starCount = 650;
    const starPositions = new Float32Array(starCount * 3);
    const starColors = new Float32Array(starCount * 3);
    const phi = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < starCount; i++) {
      const y = 1 - (i / (starCount - 1)) * 2;
      const rSlice = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = phi * i + ((i * 19) % 13) * 0.08;
      const dist = 210 + ((i * 37) % 97);
      starPositions[i * 3] = Math.cos(theta) * rSlice * dist;
      starPositions[i * 3 + 1] = y * dist;
      starPositions[i * 3 + 2] = Math.sin(theta) * rSlice * dist;
      const isWarm = i % 7 === 0;
      const tint = 0.55 + ((i * 13) % 45) / 100;
      starColors[i * 3] = isWarm ? tint : tint * 0.78;
      starColors[i * 3 + 1] = isWarm ? tint * 0.88 : tint * 0.94;
      starColors[i * 3 + 2] = isWarm ? tint * 0.65 : tint;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));
    starGeo.setAttribute('color', new THREE.BufferAttribute(starColors, 3));
    const starMat = new THREE.PointsMaterial({
      size: 1.05,
      sizeAttenuation: true,
      vertexColors: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    const starPoints = new THREE.Points(starGeo, starMat);
    starPoints.name = 'orbital-starfield';
    this.scene.add(starPoints);

    // 11c. Subtle Inclined Orbital Horizon Track
    const orbitSegments = 128;
    const orbitPts: number[] = [];
    const orbitRadius = ATMOSPHERE_RADIUS + 5.6;
    for (let i = 0; i < orbitSegments; i++) {
      const a0 = (i / orbitSegments) * Math.PI * 2;
      orbitPts.push(Math.cos(a0) * orbitRadius, 0, Math.sin(a0) * orbitRadius);
    }
    const orbitGeo = new THREE.BufferGeometry();
    orbitGeo.setAttribute('position', new THREE.Float32BufferAttribute(orbitPts, 3));
    const orbitMat = new THREE.LineBasicMaterial({
      color: COLOR_BRO_CYAN,
      transparent: true,
      opacity: 0.14,
      depthWrite: false,
    });
    const orbitLoop = new THREE.LineLoop(orbitGeo, orbitMat);
    orbitLoop.rotation.z = THREE.MathUtils.degToRad(23.44);
    orbitLoop.rotation.x = THREE.MathUtils.degToRad(-12);
    orbitLoop.name = 'orbital-horizon-ring';
    this.scene.add(orbitLoop);

    // 12. Motion preference, observers & event listeners
    this.initReducedMotion();
    this.bindEvents();
    this.initObservers();

    // Prime initial transforms so frame 1 is immediately populated
    this.updateMarkerMatrices(true);
    this.updateFreightPulses(0);
    this.updateArrivalRings(0);
    this.renderer.render(this.scene, this.camera);

    // Start frame loop (respecting visibility & reduced motion)
    this.lastFrameMs = performance.now();
    this.startLoop();
  }

  private buildCorridorsAndPulses(): {
    corridorsLines: THREE.LineSegments;
    pulseStates: FreightPulseState[];
  } {
    const segmentsPerRoute = 44;
    const positions: number[] = [];
    const colors: number[] = [];
    const pulseStates: FreightPulseState[] = [];
    const baseColor = new THREE.Color();

    CORRIDOR_ROUTES.forEach((route: CorridorRoute, routeIdx: number) => {
      const pStart = latLonToVector3(route.from.lat, route.from.lon, GLOBE_RADIUS + 0.12);
      const pEnd = latLonToVector3(route.to.lat, route.to.lon, GLOBE_RADIUS + 0.12);

      const distance = pStart.distanceTo(pEnd);
      const midPoint = new THREE.Vector3()
        .addVectors(pStart, pEnd)
        .multiplyScalar(0.5)
        .normalize()
        .multiplyScalar(GLOBE_RADIUS + Math.max(1.2, distance * 0.22));

      const curve = new THREE.QuadraticBezierCurve3(pStart, midPoint, pEnd);
      const pts = curve.getPoints(segmentsPerRoute);
      baseColor.setHex(route.color);

      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const tMid = (i + 0.5) / segmentsPerRoute;
        // Subtle luminous apex boost along each arc
        const intensity = 0.52 + 0.48 * Math.sin(tMid * Math.PI);
        const r = baseColor.r * intensity;
        const g = baseColor.g * intensity;
        const bCol = baseColor.b * intensity;

        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        colors.push(r, g, bCol, r, g, bCol);
      }

      const destHubIndex = HUB_LOCATIONS.findIndex((h) => h.id === route.toId);
      const pulseColor = new THREE.Color(route.color);

      // 2 deterministically staggered freight pulses per corridor = 56 pulses total
      for (let slot = 0; slot < 2; slot++) {
        const unitIdx = routeIdx * 2 + slot;
        const initialProgress = ((routeIdx * GOLDEN_RATIO_CONJUGATE) + slot * 0.5) % 1;
        // Frame-rate independent traversal speed: 0.058 .. 0.094 full-route/sec (~11s–17s)
        const speedPerSec = 0.058 + ((unitIdx * 7) % 11) * 0.0035;
        pulseStates.push({
          curve,
          progress: initialProgress,
          speedPerSec,
          destHubIndex: destHubIndex >= 0 ? destHubIndex : 0,
          color: pulseColor,
        });
      }
    });

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();

    const material = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });

    const corridorsLines = new THREE.LineSegments(geometry, material);
    corridorsLines.name = 'corridor-routes';
    return { corridorsLines, pulseStates };
  }

  private initReducedMotion(): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    this.reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion = this.reducedMotionQuery.matches;
    if (this.reducedMotion) {
      this.shouldSpin = false;
    }
    this.reducedMotionQuery.addEventListener('change', this.handleReducedMotionChange);
  }

  private initObservers(): void {
    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (!entry) return;
          const visible = entry.isIntersecting;
          if (visible !== this.isVisible) {
            this.isVisible = visible;
            if (visible) {
              this.lastFrameMs = performance.now();
              this.startLoop();
            } else {
              this.stopLoop();
            }
          }
        },
        { threshold: 0.05 },
      );
      this.intersectionObserver.observe(this.container);
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.handleResize();
      });
      this.resizeObserver.observe(this.container);
    }
  }

  private bindEvents(): void {
    const dom = this.renderer.domElement;
    dom.addEventListener('pointermove', this.handlePointerMove, { passive: true });
    dom.addEventListener('pointerdown', this.handlePointerDown, { passive: true });
    dom.addEventListener('pointerup', this.handlePointerUp, { passive: true });
    dom.addEventListener('pointerenter', this.handlePointerEnter, { passive: true });
    dom.addEventListener('pointerleave', this.handlePointerLeave, { passive: true });
    dom.addEventListener('webglcontextlost', this.handleContextLost, false);
    dom.addEventListener('webglcontextrestored', this.handleContextRestored, false);

    this.controls.addEventListener('start', this.handleControlsStart);
    this.controls.addEventListener('change', this.handleControlsChange);

    window.addEventListener('resize', this.handleResize, { passive: true });
    document.addEventListener('visibilitychange', this.handleVisibilityChange);
  }

  private readonly handleReducedMotionChange = (event: MediaQueryListEvent): void => {
    this.reducedMotion = event.matches;
    if (this.reducedMotion) {
      this.shouldSpin = false;
      this.flyState = null;
      this.stopLoop();
      this.renderSingleFrame();
    } else {
      this.shouldSpin = this.selectedNodeId === null;
      this.lastFrameMs = performance.now();
      this.startLoop();
    }
  };

  private readonly handleControlsStart = (): void => {
    this.flyState = null;
    this.pauseSpin();
  };

  private readonly handleControlsChange = (): void => {
    if (this.reducedMotion && !this.disposed && !this.isContextLost) {
      this.updateMarkerMatrices(false);
      this.updateFocusReticle();
      this.renderer.render(this.scene, this.camera);
    }
  };

  private readonly handlePointerEnter = (): void => {
    this.pauseSpin();
  };

  private readonly handlePointerLeave = (): void => {
    if (this.hoveredNodeId !== null) {
      this.hoveredNodeId = null;
      this.renderer.domElement.style.cursor = 'grab';
      this.onHoverNode?.(null);
      this.updateFocusReticle();
      if (this.reducedMotion) this.renderSingleFrame();
    }
    this.scheduleSpinResume();
  };

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.pointerDownPos = { x: event.clientX, y: event.clientY };
    this.pauseSpin();
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    const now = performance.now();
    if (now - this.lastRaycastMs < RAYCAST_THROTTLE_MS) return;
    this.lastRaycastMs = now;

    const hit = this.pickNodeAtClientPoint(event.clientX, event.clientY);
    const nextHoverId = hit ? hit.id : null;
    if (nextHoverId !== this.hoveredNodeId) {
      this.hoveredNodeId = nextHoverId;
      this.renderer.domElement.style.cursor = hit ? 'pointer' : 'grab';
      this.onHoverNode?.(hit);
      this.updateMarkerMatrices(true);
      this.updateFocusReticle();
      if (this.reducedMotion) this.renderSingleFrame();
    }
  };

  private readonly handlePointerUp = (event: PointerEvent): void => {
    const down = this.pointerDownPos;
    this.pointerDownPos = null;
    if (!down) return;

    const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
    if (moved > CLICK_DRAG_THRESHOLD_PX) return;

    const hit = this.pickNodeAtClientPoint(event.clientX, event.clientY);
    if (hit) {
      this.selectedNodeId = hit.id;
      this.updateMarkerMatrices(true);
      this.updateFocusReticle();
      this.onSelectNode?.(hit);

      const currentDist = this.camera.position.length();
      const targetDist = THREE.MathUtils.clamp(currentDist, 74, 104);
      this.flyTo(hit.lat, hit.lon, targetDist);
    } else if (this.selectedNodeId !== null) {
      this.selectedNodeId = null;
      this.updateMarkerMatrices(true);
      this.updateFocusReticle();
      this.onSelectNode?.(null);
      if (this.reducedMotion) this.renderSingleFrame();
    }
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.isContextLost = true;
    this.stopLoop();
    this.onContextLost?.(true);
  };

  private readonly handleContextRestored = (): void => {
    this.isContextLost = false;
    this.onContextLost?.(false);
    this.lastFrameMs = performance.now();
    this.renderSingleFrame();
    this.startLoop();
  };

  private readonly handleVisibilityChange = (): void => {
    this.isDocumentHidden = document.hidden;
    if (this.isDocumentHidden) {
      this.stopLoop();
    } else if (this.isVisible && !this.reducedMotion) {
      this.lastFrameMs = performance.now();
      this.startLoop();
    }
  };

  private readonly handleResize = (): void => {
    if (this.disposed) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    if (this.reducedMotion) {
      this.renderSingleFrame();
    }
  };

  private pauseSpin(): void {
    this.shouldSpin = false;
    if (this.resumeSpinTimeout) {
      clearTimeout(this.resumeSpinTimeout);
      this.resumeSpinTimeout = null;
    }
  }

  private scheduleSpinResume(): void {
    if (this.reducedMotion || this.selectedNodeId !== null) return;
    if (this.resumeSpinTimeout) clearTimeout(this.resumeSpinTimeout);
    this.resumeSpinTimeout = setTimeout(() => {
      if (!this.disposed && !this.reducedMotion && this.selectedNodeId === null) {
        this.shouldSpin = true;
      }
    }, 5000);
  }

  /**
   * Performs front-hemisphere raycast against Border Port Beacons & Hub Markers,
   * backed by a tight screen-space proximity pass for effortless pointer targeting.
   */
  private pickNodeAtClientPoint(clientX: number, clientY: number): GlobeNode | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    this.pointerNdc.set((localX / rect.width) * 2 - 1, -(localY / rect.height) * 2 + 1);

    this.raycaster.setFromCamera(this.pointerNdc, this.camera);

    // 1. Direct GPU InstancedMesh raycast (prioritize border ports over nearby hubs)
    const earthHits = this.raycaster.intersectObject(this.earthCoreMesh, false);
    const occlusionDist = earthHits.length > 0 ? earthHits[0].distance + 1.25 : Infinity;

    const beaconHits = this.raycaster.intersectObject(this.borderBeaconsMesh, false);
    for (const hit of beaconHits) {
      if (hit.instanceId !== undefined && hit.distance <= occlusionDist) {
        const port = this.borderPorts[hit.instanceId];
        if (port) return port;
      }
    }

    const hubHits = this.raycaster.intersectObject(this.hubMarkersMesh, false);
    for (const hit of hubHits) {
      if (hit.instanceId !== undefined && hit.distance <= occlusionDist) {
        const hub = HUB_LOCATIONS[hit.instanceId];
        if (hub) return hub;
      }
    }

    // 2. Front-hemisphere projected screen-proximity fallback (within 18px)
    let bestNode: GlobeNode | null = null;
    let bestDistPx = PICK_SCREEN_RADIUS_PX;

    const checkCandidates = <T extends GlobeNode>(nodes: readonly T[], positions: THREE.Vector3[]) => {
      for (let i = 0; i < nodes.length; i++) {
        const pos = positions[i];
        // Front-hemisphere visibility check: dot(outwardNormal, vectorToCamera) > 0.05
        this.tempDir.subVectors(this.camera.position, pos);
        if (pos.dot(this.tempDir) <= 0.05 * GLOBE_RADIUS) continue;

        this.tempProjected.copy(pos).project(this.camera);
        if (this.tempProjected.z > 1) continue;

        const sx = (this.tempProjected.x * 0.5 + 0.5) * rect.width;
        const sy = (-this.tempProjected.y * 0.5 + 0.5) * rect.height;
        const distPx = Math.hypot(sx - localX, sy - localY);
        if (distPx < bestDistPx) {
          bestDistPx = distPx;
          bestNode = nodes[i];
        }
      }
    };

    checkCandidates(this.borderPorts, this.borderPositions);
    checkCandidates(HUB_LOCATIONS, this.hubPositions);
    return bestNode;
  }

  /**
   * Smoothly flies the orbital camera to a geographic lat/lon and orbital distance
   * along a spherical great-circle path (never clipping through Earth).
   */
  public flyTo(lat: number, lon: number, distance = 96): void {
    if (this.disposed) return;
    const clampedDistance = THREE.MathUtils.clamp(
      distance,
      MIN_CAMERA_DISTANCE,
      MAX_CAMERA_DISTANCE,
    );
    const targetDir = latLonToVector3(lat, lon, 1).normalize();
    this.pauseSpin();

    if (this.reducedMotion) {
      this.flyState = null;
      this.camera.position.copy(targetDir).multiplyScalar(clampedDistance);
      this.controls.update();
      this.renderSingleFrame();
      return;
    }

    this.flyState = { targetDir, targetDistance: clampedDistance };
    if (this.animationFrameId === null && this.isVisible && !this.isDocumentHidden) {
      this.lastFrameMs = performance.now();
      this.startLoop();
    }
  }

  /**
   * Dynamically updates Border Port beacon colors and stored wait-time metadata:
   * - < 15 min: Cyan (#00f0ff)
   * - 15–45 min: Gold (#ffaa00)
   * - > 45 min: Crimson (#ff0055)
   */
  public updateBorderWaitTimes(data: readonly BorderWaitTimeDatum[]): void {
    if (this.disposed || data.length === 0) return;

    const byCode = new Map<string, BorderWaitTimeDatum>();
    for (const entry of data) {
      if (entry.cbpCode) {
        byCode.set(String(entry.cbpCode).trim(), entry);
      }
    }

    let updatedAny = false;
    let selectedPortUpdated: BorderPortNode | null = null;

    this.borderPorts.forEach((port, index) => {
      const datum = byCode.get(port.cbpCode);
      if (!datum) return;

      const waitMins =
        typeof datum.commercialWaitMinutes === 'number' &&
        Number.isFinite(datum.commercialWaitMinutes)
          ? Math.max(0, Math.round(datum.commercialWaitMinutes))
          : null;

      const fastMins =
        typeof datum.fastLaneWaitMinutes === 'number' &&
        Number.isFinite(datum.fastLaneWaitMinutes)
          ? Math.max(0, Math.round(datum.fastLaneWaitMinutes))
          : null;

      const { colorHex, status } = getWaitTimeSeverity(waitMins);
      const updatedPort: BorderPortNode = {
        ...port,
        commercialWaitMinutes: waitMins,
        fastLaneWaitMinutes: fastMins,
        status,
        updatedAt: datum.updatedAt ?? port.updatedAt,
      };
      this.borderPorts[index] = updatedPort;

      this.tempColor.setHex(colorHex);
      this.borderBeaconsMesh.setColorAt(index, this.tempColor);
      updatedAny = true;

      if (this.selectedNodeId === updatedPort.id) {
        selectedPortUpdated = updatedPort;
      }
    });

    if (updatedAny && this.borderBeaconsMesh.instanceColor) {
      this.borderBeaconsMesh.instanceColor.needsUpdate = true;
      this.updateFocusReticle();
      if (this.reducedMotion) {
        this.renderSingleFrame();
      }
    }

    if (selectedPortUpdated) {
      this.onSelectNode?.(selectedPortUpdated);
    }
  }

  /**
   * Programmatically clears the active node selection and resumes idle drift.
   */
  public clearSelection(): void {
    if (this.disposed) return;
    this.selectedNodeId = null;
    this.updateMarkerMatrices(true);
    this.updateFocusReticle();
    this.scheduleSpinResume();
    if (this.reducedMotion) {
      this.renderSingleFrame();
    }
  }

  /**
   * Returns the live WebGL draw call count recorded by Three.js on the previous frame.
   */
  public getDrawCallCount(): number {
    return this.renderer.info.render.calls;
  }

  private getNodeById(id: string | null): GlobeNode | null {
    if (!id) return null;
    const port = this.borderPorts.find((p) => p.id === id);
    if (port) return port;
    return HUB_LOCATIONS.find((h) => h.id === id) ?? null;
  }

  private computeMarkerScale(): number {
    const camDist = this.camera.position.length();
    return THREE.MathUtils.clamp(camDist / 132, 0.44, 1.32);
  }

  private updateMarkerMatrices(force: boolean): void {
    const markerScale = this.computeMarkerScale();
    if (!force && Math.abs(markerScale - this.lastMarkerScale) < 0.002) {
      return;
    }
    this.lastMarkerScale = markerScale;

    // 1. Hub Markers
    HUB_LOCATIONS.forEach((hub, index) => {
      const isFocused = hub.id === this.selectedNodeId || hub.id === this.hoveredNodeId;
      const s = markerScale * (hub.isHQ ? 1.28 : 1.0) * (isFocused ? 1.42 : 1.0);
      this.tempScale.setScalar(s);
      this.tempMatrix.compose(this.hubPositions[index], this.tempIdentityQuat, this.tempScale);
      this.hubMarkersMesh.setMatrixAt(index, this.tempMatrix);
    });
    this.hubMarkersMesh.instanceMatrix.needsUpdate = true;

    // 2. Border Port Beacons
    this.borderPorts.forEach((port, index) => {
      const isFocused = port.id === this.selectedNodeId || port.id === this.hoveredNodeId;
      const s = markerScale * (isFocused ? 1.48 : 1.05);
      this.tempScale.set(s * 0.85, s * 1.25, s * 0.85);
      this.tempMatrix.compose(
        this.borderPositions[index],
        this.borderQuaternions[index],
        this.tempScale,
      );
      this.borderBeaconsMesh.setMatrixAt(index, this.tempMatrix);
    });
    this.borderBeaconsMesh.instanceMatrix.needsUpdate = true;
  }

  private updateFocusReticle(): void {
    const activeId = this.selectedNodeId ?? this.hoveredNodeId;
    const node = this.getNodeById(activeId);
    if (!node) {
      this.focusReticleMesh.visible = false;
      return;
    }

    const markerScale = this.computeMarkerScale();
    const pos = latLonToVector3(node.lat, node.lon, GLOBE_RADIUS + 0.24);
    const normal = pos.clone().normalize();
    this.focusReticleMesh.position.copy(pos);
    this.focusReticleMesh.quaternion.setFromUnitVectors(UNIT_Z, normal);
    this.focusReticleMesh.scale.setScalar(markerScale * 1.25);

    if (node.kind === 'border_port') {
      this.focusReticleMat.color.setHex(getWaitTimeSeverity(node.commercialWaitMinutes).colorHex);
    } else {
      this.focusReticleMat.color.setHex(
        node.isHQ || node.corridorTier === 'primary' ? COLOR_BRO_GOLD : COLOR_BRO_CYAN,
      );
    }
    this.focusReticleMesh.visible = true;
  }

  private updateFreightPulses(dt: number): void {
    const pulseScale = this.computeMarkerScale() * 1.05;
    this.tempScale.setScalar(pulseScale);

    for (let i = 0; i < this.freightPulses.length; i++) {
      const unit = this.freightPulses[i];
      if (dt > 0) {
        unit.progress += unit.speedPerSec * dt;
        if (unit.progress >= 1.0) {
          unit.progress -= Math.floor(unit.progress);
          const hubState = this.hubPulseStates[unit.destHubIndex];
          if (hubState) {
            hubState.progress = 0.0;
          }
        }
      }

      unit.curve.getPointAt(unit.progress, this.tempPos);
      this.tempMatrix.compose(this.tempPos, this.tempIdentityQuat, this.tempScale);
      this.freightPulsesMesh.setMatrixAt(i, this.tempMatrix);
    }

    this.freightPulsesMesh.instanceMatrix.needsUpdate = true;
  }

  private updateArrivalRings(dt: number): void {
    const markerScale = this.computeMarkerScale();
    const alphaArray = this.ringAlphaAttr.array as Float32Array;
    const waveSpeedPerSec = 0.85;

    for (let i = 0; i < this.hubPulseStates.length; i++) {
      const hubState = this.hubPulseStates[i];
      if (hubState.progress >= 0 && dt > 0) {
        hubState.progress += waveSpeedPerSec * dt;
        if (hubState.progress >= 1.0) {
          hubState.progress = -1.0;
        }
      }

      const innerIdx = i * 2;
      const outerIdx = i * 2 + 1;

      if (hubState.progress >= 0 && !this.reducedMotion) {
        const p = hubState.progress;
        const innerScale = markerScale * (0.55 + 1.85 * p);
        const outerScale = markerScale * (0.7 + 3.25 * p);

        this.tempScale.setScalar(innerScale);
        this.tempMatrix.compose(hubState.position, hubState.quaternion, this.tempScale);
        this.arrivalRingsMesh.setMatrixAt(innerIdx, this.tempMatrix);
        alphaArray[innerIdx] = 0.78 * (1 - p);

        this.tempScale.setScalar(outerScale);
        this.tempMatrix.compose(hubState.position, hubState.quaternion, this.tempScale);
        this.arrivalRingsMesh.setMatrixAt(outerIdx, this.tempMatrix);
        alphaArray[outerIdx] = 0.45 * (1 - p) * (1 - p);
      } else {
        this.tempScale.setScalar(0);
        this.tempMatrix.compose(hubState.position, hubState.quaternion, this.tempScale);
        this.arrivalRingsMesh.setMatrixAt(innerIdx, this.tempMatrix);
        this.arrivalRingsMesh.setMatrixAt(outerIdx, this.tempMatrix);
        alphaArray[innerIdx] = 0;
        alphaArray[outerIdx] = 0;
      }
    }

    this.arrivalRingsMesh.instanceMatrix.needsUpdate = true;
    this.ringAlphaAttr.needsUpdate = true;
  }

  private updateFlyTo(dt: number): void {
    if (!this.flyState) return;

    const currentDist = this.camera.position.length();
    const currentDir = this.tempDir.copy(this.camera.position).normalize();
    const dot = THREE.MathUtils.clamp(currentDir.dot(this.flyState.targetDir), -1, 1);
    const angle = Math.acos(dot);

    const damping = 1 - Math.exp(-5.4 * dt);

    if (angle < 0.002 && Math.abs(currentDist - this.flyState.targetDistance) < 0.12) {
      this.camera.position
        .copy(this.flyState.targetDir)
        .multiplyScalar(this.flyState.targetDistance);
      this.flyState = null;
      return;
    }

    if (dot < -0.999) {
      // Exact antipode guard: rotate cleanly around world Y axis
      this.tempStepQuat.setFromAxisAngle(UNIT_Y, Math.PI * damping);
    } else {
      this.tempQuat.setFromUnitVectors(currentDir, this.flyState.targetDir);
      this.tempStepQuat.copy(this.tempIdentityQuat).slerp(this.tempQuat, damping);
    }

    currentDir.applyQuaternion(this.tempStepQuat).normalize();
    const nextDist = THREE.MathUtils.lerp(currentDist, this.flyState.targetDistance, damping);
    this.camera.position.copy(currentDir).multiplyScalar(nextDist);
  }

  private refreshSunDirectionIfDue(): void {
    const now = Date.now();
    if (now - this.lastSunUpdateMs < SUN_UPDATE_INTERVAL_MS) return;
    this.lastSunUpdateMs = now;
    const sunDir = getSubsolarDirection(new Date());
    (this.earthCoreMaterial.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
    (this.atmosphereMaterial.uniforms.uSunDir.value as THREE.Vector3).copy(sunDir);
  }

  private renderSingleFrame(): void {
    if (this.disposed || this.isContextLost) return;
    this.updateMarkerMatrices(false);
    this.updateFocusReticle();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private startLoop(): void {
    if (
      this.disposed ||
      this.isContextLost ||
      !this.isVisible ||
      this.isDocumentHidden ||
      this.reducedMotion ||
      this.animationFrameId !== null
    ) {
      return;
    }
    this.animationFrameId = requestAnimationFrame(this.animate);
  }

  private stopLoop(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private readonly animate = (nowMs: number): void => {
    if (this.disposed || this.isContextLost || !this.isVisible || this.isDocumentHidden) {
      this.animationFrameId = null;
      return;
    }

    this.animationFrameId = requestAnimationFrame(this.animate);

    // Clamped frame-rate independent deltaTime (seconds)
    const dt = Math.min(Math.max((nowMs - this.lastFrameMs) / 1000, 0), 0.1);
    this.lastFrameMs = nowMs;

    this.refreshSunDirectionIfDue();

    if (this.flyState) {
      this.updateFlyTo(dt);
    } else if (this.shouldSpin) {
      // Gentle deltaTime-normalized azimuthal orbital drift
      this.camera.position.applyAxisAngle(UNIT_Y, IDLE_SPIN_RAD_PER_SEC * dt);
    }

    this.controls.update();
    this.updateMarkerMatrices(false);
    this.updateFocusReticle();
    this.updateFreightPulses(dt);
    this.updateArrivalRings(dt);
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Complete lifecycle teardown: cancels rAF, disconnects observers, removes all
   * DOM/window listeners, and disposes every GPU geometry, material, and WebGL context.
   */
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.stopLoop();

    if (this.resumeSpinTimeout) {
      clearTimeout(this.resumeSpinTimeout);
      this.resumeSpinTimeout = null;
    }

    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    this.reducedMotionQuery?.removeEventListener('change', this.handleReducedMotionChange);
    this.reducedMotionQuery = null;

    const dom = this.renderer.domElement;
    dom.removeEventListener('pointermove', this.handlePointerMove);
    dom.removeEventListener('pointerdown', this.handlePointerDown);
    dom.removeEventListener('pointerup', this.handlePointerUp);
    dom.removeEventListener('pointerenter', this.handlePointerEnter);
    dom.removeEventListener('pointerleave', this.handlePointerLeave);
    dom.removeEventListener('webglcontextlost', this.handleContextLost);
    dom.removeEventListener('webglcontextrestored', this.handleContextRestored);

    this.controls.removeEventListener('start', this.handleControlsStart);
    this.controls.removeEventListener('change', this.handleControlsChange);

    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibilityChange);

    this.controls.dispose();

    const disposedGeometries = new Set<THREE.BufferGeometry>();
    const disposedMaterials = new Set<THREE.Material>();

    this.scene.traverse((obj) => {
      if ('geometry' in obj && obj.geometry instanceof THREE.BufferGeometry) {
        if (!disposedGeometries.has(obj.geometry)) {
          disposedGeometries.add(obj.geometry);
          obj.geometry.dispose();
        }
      }
      if ('material' in obj && obj.material) {
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const mat of mats) {
          if (mat instanceof THREE.Material && !disposedMaterials.has(mat)) {
            disposedMaterials.add(mat);
            mat.dispose();
          }
        }
      }
    });

    this.scene.clear();
    this.renderer.dispose();

    if (dom.parentNode === this.container) {
      this.container.removeChild(dom);
    }
  }
}
