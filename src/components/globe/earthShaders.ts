import * as THREE from 'three';
import { latLonToVector3 } from './globeData';

const MS_PER_DAY = 86_400_000;
const TROPICAL_YEAR_DAYS = 365.2422;
const EARTH_AXIAL_TILT_DEG = 23.44;

/**
 * Computes the real-time unit subsolar direction vector in the globe's geographic
 * coordinate frame from a UTC Date (declination + UTC hour angle + Equation of Time).
 */
export function getSubsolarDirection(date: Date = new Date()): THREE.Vector3 {
  const yearStartUtc = Date.UTC(date.getUTCFullYear(), 0, 1, 0, 0, 0, 0);
  const dayOfYear = (date.getTime() - yearStartUtc) / MS_PER_DAY;

  // Solar declination angle (latitude of subsolar point in degrees)
  const seasonalAngle = ((2 * Math.PI) / TROPICAL_YEAR_DAYS) * (dayOfYear + 10);
  const declinationDeg = -EARTH_AXIAL_TILT_DEG * Math.cos(seasonalAngle);

  // Equation of Time correction (in minutes)
  const bRad = ((2 * Math.PI) / TROPICAL_YEAR_DAYS) * (dayOfYear - 81);
  const eotMinutes =
    9.87 * Math.sin(2 * bRad) - 7.53 * Math.cos(bRad) - 1.5 * Math.sin(bRad);

  // UTC hours elapsed since 00:00 UTC -> subsolar longitude (noon UTC = 0° Prime Meridian)
  const utcHours =
    date.getUTCHours() +
    date.getUTCMinutes() / 60 +
    date.getUTCSeconds() / 3600 +
    date.getUTCMilliseconds() / 3_600_000;

  let subsolarLonDeg = (12 - utcHours) * 15 - eotMinutes / 4;
  // Wrap cleanly into [-180, 180]
  subsolarLonDeg = ((((subsolarLonDeg + 180) % 360) + 360) % 360) - 180;

  return latLonToVector3(declinationDeg, subsolarLonDeg, 1).normalize();
}

const EARTH_CORE_VERTEX_SHADER = /* glsl */ `
  uniform vec3 uSunDir;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying vec3 vWorldSunDir;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vWorldSunDir = normalize(mat3(modelMatrix) * uSunDir);

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const EARTH_CORE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uNightColor;
  uniform vec3 uDayColor;
  uniform vec3 uTwilightColor;
  uniform vec3 uSpecularColor;
  uniform vec3 uRimColor;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying vec3 vWorldSunDir;

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPosition);
    vec3 L = normalize(vWorldSunDir);

    // Real-time Solar Day/Night Terminator
    float sunDot = dot(N, L);
    float dayMask = smoothstep(-0.16, 0.24, sunDot);
    float diffuse = max(sunDot, 0.0);

    // Subtle atmospheric twilight band right across the terminator line
    float terminatorBand = exp(-pow(sunDot * 5.2, 2.0));

    // Base obsidian night hemisphere -> slate-blue illuminated daylight hemisphere
    vec3 baseColor = mix(uNightColor, uDayColor, dayMask * (0.48 + 0.52 * diffuse));
    baseColor += uTwilightColor * terminatorBand * 0.24;

    // Subtle slate-blue Blinn-Phong specular sheen across daylight oceans
    vec3 H = normalize(L + V);
    float ndh = max(dot(N, H), 0.0);
    float specular = pow(ndh, 42.0) * smoothstep(0.0, 0.28, sunDot) * 0.30;
    baseColor += uSpecularColor * specular;

    // Subtle orbital Fresnel edge contour tying the core into the outer atmosphere
    float ndv = clamp(dot(N, V), 0.0, 1.0);
    float innerFresnel = pow(1.0 - ndv, 3.0);
    float rimLightWeight = 0.36 + 0.42 * smoothstep(-0.35, 0.45, sunDot);
    baseColor += uRimColor * innerFresnel * rimLightWeight;

    gl_FragColor = vec4(baseColor, 1.0);
  }
`;

const ATMOSPHERE_VERTEX_SHADER = /* glsl */ `
  uniform vec3 uSunDir;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying vec3 vWorldSunDir;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPos.xyz;
    vWorldNormal = normalize(mat3(modelMatrix) * normal);
    vWorldSunDir = normalize(mat3(modelMatrix) * uSunDir);

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const ATMOSPHERE_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uCyanColor;
  uniform vec3 uGoldColor;

  varying vec3 vWorldNormal;
  varying vec3 vWorldPosition;
  varying vec3 vWorldSunDir;

  void main() {
    vec3 N = normalize(vWorldNormal);
    vec3 V = normalize(cameraPosition - vWorldPosition);
    vec3 L = normalize(vWorldSunDir);

    // On a BackSide sphere (r = 52.4) wrapping the planet core (r = 50.0):
    // -dot(N, V) is ~0.30 at the planetary limb and smoothly reaches 0.0 at outer edge.
    float viewDot = clamp(-dot(N, V), 0.0, 1.0);
    float limb = smoothstep(0.0, 0.38, viewDot);
    float glow = pow(limb, 2.1) * 0.92;

    // Modulate orbital cyan rim with warm gold scatter near the solar terminator
    float sunDot = dot(N, L);
    float terminatorWarmth = smoothstep(-0.32, 0.22, sunDot) * (1.0 - smoothstep(0.22, 0.85, sunDot));
    float dayBoost = 0.68 + 0.32 * smoothstep(-0.4, 0.35, sunDot);

    vec3 rimColor = mix(uCyanColor, uGoldColor, terminatorWarmth * 0.48);
    gl_FragColor = vec4(rimColor * glow * dayBoost, glow * dayBoost);
  }
`;

const PULSE_RING_VERTEX_SHADER = /* glsl */ `
  attribute vec3 aRingColor;
  attribute float aRingAlpha;

  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    vColor = aRingColor;
    vAlpha = aRingAlpha;
    vec4 worldPos = modelMatrix * instanceMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const PULSE_RING_FRAGMENT_SHADER = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;

  void main() {
    if (vAlpha <= 0.002) discard;
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

/**
 * Creates the custom GLSL ShaderMaterial for the obsidian Earth core (radius 50)
 * featuring a live UTC Solar Day/Night Terminator and subtle slate-blue specular sheen.
 */
export function createEarthCoreMaterial(
  sunDirection: THREE.Vector3 = getSubsolarDirection(),
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDirection.clone().normalize() },
      uNightColor: { value: new THREE.Color('#071226') },
      uDayColor: { value: new THREE.Color('#143563') },
      uTwilightColor: { value: new THREE.Color('#13658c') },
      uSpecularColor: { value: new THREE.Color('#6ed3ff') },
      uRimColor: { value: new THREE.Color('#00f0ff') },
    },
    vertexShader: EARTH_CORE_VERTEX_SHADER,
    fragmentShader: EARTH_CORE_FRAGMENT_SHADER,
  });
}

/**
 * Creates the BackSide additive Fresnel Atmospheric Rim Glow ShaderMaterial (radius 52.4),
 * projecting crisp #BRO cyan/gold orbital rim light with zero post-processing passes.
 */
export function createAtmosphereMaterial(
  sunDirection: THREE.Vector3 = getSubsolarDirection(),
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: { value: sunDirection.clone().normalize() },
      uCyanColor: { value: new THREE.Color('#00f0ff') },
      uGoldColor: { value: new THREE.Color('#ffaa00') },
    },
    vertexShader: ATMOSPHERE_VERTEX_SHADER,
    fragmentShader: ATMOSPHERE_FRAGMENT_SHADER,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

/**
 * Creates a lightweight instanced ShaderMaterial for arrival pulse rings,
 * enabling per-instance color and smooth radial alpha fade in a single draw call.
 */
export function createPulseRingMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: PULSE_RING_VERTEX_SHADER,
    fragmentShader: PULSE_RING_FRAGMENT_SHADER,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}
