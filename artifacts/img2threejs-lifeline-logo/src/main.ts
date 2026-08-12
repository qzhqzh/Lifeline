import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import './styles.css';

type EmblemRuntime = {
  root: THREE.Group;
  orbit: THREE.Group;
  pulseCores: THREE.Object3D[];
  materials: Record<string, THREE.MeshPhysicalMaterial>;
};

const COLORS = {
  navy: 0x00112f,
  navyMid: 0x00366f,
  cyan: 0x00eaff,
  cyanPale: 0xbffcff,
  white: 0xffffff,
  orange: 0xff5b18,
  amber: 0xffa000,
  yellow: 0xfff56a,
};

function physical(
  color: number,
  options: { emissive?: number; intensity?: number; roughness?: number; metalness?: number; clearcoat?: number } = {},
) {
  return new THREE.MeshPhysicalMaterial({
    color,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.intensity ?? 0,
    roughness: options.roughness ?? 0.24,
    metalness: options.metalness ?? 0.1,
    clearcoat: options.clearcoat ?? 0.75,
    clearcoatRoughness: 0.12,
    side: THREE.DoubleSide,
  });
}

function tube(points: THREE.Vector3[], radius: number, material: THREE.Material, closed = false, smooth = true) {
  const curve: THREE.Curve<THREE.Vector3> = smooth
    ? new THREE.CatmullRomCurve3(points, closed, 'centripetal', 0.38)
    : (() => {
        const path = new THREE.CurvePath<THREE.Vector3>();
        for (let index = 1; index < points.length; index += 1) {
          path.add(new THREE.LineCurve3(points[index - 1], points[index]));
        }
        return path;
      })();
  const geometry = new THREE.TubeGeometry(curve, Math.max(36, points.length * 18), radius, 12, closed);
  return new THREE.Mesh(geometry, material);
}

function extrudedProfile(points: Array<[number, number]>, depth: number, material: THREE.Material) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index += 1) shape.lineTo(points[index][0], points[index][1]);
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSize: 0.035,
    bevelThickness: 0.025,
    bevelSegments: 3,
    steps: 1,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function flatShape(points: Array<[number, number]>, material: THREE.Material, z: number) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let index = 1; index < points.length; index += 1) shape.lineTo(points[index][0], points[index][1]);
  shape.closePath();
  const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
  mesh.position.z = z;
  return mesh;
}

function glowTexture(color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable');
  const gradient = context.createRadialGradient(64, 64, 2, 64, 64, 62);
  gradient.addColorStop(0, '#ffffff');
  gradient.addColorStop(0.14, color);
  gradient.addColorStop(0.45, `${color}66`);
  gradient.addColorStop(1, `${color}00`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function glowSprite(color: string, scale: number) {
  const material = new THREE.SpriteMaterial({
    map: glowTexture(color),
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.78,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.setScalar(scale);
  return sprite;
}

function createNode(
  shellMaterial: THREE.MeshPhysicalMaterial,
  coreMaterial: THREE.MeshPhysicalMaterial,
  glowColor: string,
  position: THREE.Vector3,
) {
  const group = new THREE.Group();
  group.position.copy(position);
  group.scale.setScalar(0.8);
  const halo = glowSprite(glowColor, 1.12);
  halo.position.z = 0.02;
  halo.material.opacity = 0.56;
  group.add(halo);

  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.37, 0.055, 12, 48), shellMaterial);
  rim.position.z = 0.03;
  group.add(rim);

  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.32, 40, 28), shellMaterial);
  group.add(shell);

  const core = new THREE.Mesh(new THREE.SphereGeometry(0.105, 24, 16), coreMaterial);
  core.position.set(-0.075, 0.075, 0.285);
  group.add(core);
  return { group, core };
}

export function createLifelineEnergyEmblem(): EmblemRuntime {
  const materials = {
    crystal: physical(COLORS.navy, { roughness: 0.2, metalness: 0.38, clearcoat: 0.85 }),
    facetBlue: physical(0x003a79, { roughness: 0.18, metalness: 0.3 }),
    facetDeep: physical(0x000d29, { roughness: 0.28, metalness: 0.18 }),
    orbit: physical(0x00275f, { roughness: 0.24, metalness: 0.34 }),
    cyan: physical(COLORS.cyan, { emissive: COLORS.cyan, intensity: 2.15, roughness: 0.08 }),
    cyanSoft: physical(COLORS.cyanPale, { emissive: COLORS.cyan, intensity: 1.45, roughness: 0.08 }),
    white: physical(COLORS.white, { emissive: COLORS.cyanPale, intensity: 1.9, roughness: 0.06 }),
    nodeCyan: physical(0x006ba8, { emissive: 0x003b70, intensity: 0.8, roughness: 0.08, clearcoat: 1 }),
    nodeOrange: physical(COLORS.orange, { emissive: 0x9d1500, intensity: 1.1, roughness: 0.08, clearcoat: 1 }),
    coreCyan: physical(COLORS.white, { emissive: COLORS.cyan, intensity: 3.4, roughness: 0.04 }),
    coreOrange: physical(COLORS.yellow, { emissive: COLORS.amber, intensity: 3.8, roughness: 0.04 }),
  };

  const root = new THREE.Group();
  root.name = 'lifeline-energy-emblem';

  const crystal = new THREE.Group();
  crystal.name = 'crystal-core';
  const profile: Array<[number, number]> = [
    [0, 2.72], [0.78, 1.75], [0.78, -1.8], [0.48, -2.2], [0, -2.82],
    [-0.48, -2.2], [-0.78, -1.8], [-0.78, 1.75],
  ];
  crystal.add(extrudedProfile(profile, 0.48, materials.crystal));
  crystal.add(flatShape([[-0.72, 1.7], [-0.08, 2.55], [-0.08, -2.58], [-0.68, -1.74]], materials.facetBlue, 0.252));
  crystal.add(flatShape([[0.08, 2.55], [0.72, 1.7], [0.68, -1.74], [0.08, -2.58]], materials.facetDeep, 0.253));
  crystal.add(flatShape([[-0.52, 1.48], [-0.45, 1.6], [-0.45, -0.72], [-0.52, -0.6]], materials.white, 0.275));
  crystal.add(flatShape([[0.48, 1.5], [0.54, 1.4], [0.54, -0.6], [0.48, -0.72]], materials.cyanSoft, 0.275));
  const seam = tube([
    new THREE.Vector3(0, -2.64, 0.33),
    new THREE.Vector3(0, -0.55, 0.33),
    new THREE.Vector3(0, 0.62, 0.33),
    new THREE.Vector3(0, 2.58, 0.33),
  ], 0.025, materials.cyan, false, false);
  crystal.add(seam);
  root.add(crystal);

  const orbit = new THREE.Group();
  orbit.name = 'orbit-shell';
  const orbitPoints = [
    new THREE.Vector3(-2.45, 0.28, 0.22),
    new THREE.Vector3(-2.82, -0.22, 0.28),
    new THREE.Vector3(-2.35, -1.02, 0.48),
    new THREE.Vector3(-0.75, -1.42, 0.58),
    new THREE.Vector3(0.95, -1.28, 0.62),
    new THREE.Vector3(2.12, -0.73, 0.54),
    new THREE.Vector3(2.62, 0.06, 0.14),
    new THREE.Vector3(2.48, 0.72, -0.16),
    new THREE.Vector3(1.88, 1.25, -0.22),
  ];
  orbit.add(tube(orbitPoints, 0.17, materials.orbit));
  const innerPoints = orbitPoints.map((point) => point.clone().multiply(new THREE.Vector3(0.965, 0.9, 1)).add(new THREE.Vector3(0, 0.03, 0.075)));
  orbit.add(tube(innerPoints, 0.04, materials.cyan));
  orbit.add(tube([
    new THREE.Vector3(-2.43, 0.3, 0.18),
    new THREE.Vector3(-1.58, 0.78, -0.32),
    new THREE.Vector3(-0.84, 1.0, -0.34),
  ], 0.14, materials.orbit));
  orbit.add(tube([
    new THREE.Vector3(0.86, 1.32, -0.34),
    new THREE.Vector3(1.35, 1.3, -0.28),
    new THREE.Vector3(1.88, 1.25, -0.22),
  ], 0.14, materials.orbit));
  root.add(orbit);

  const centralSignal = tube([
    new THREE.Vector3(-1.52, 0.02, 0.55),
    new THREE.Vector3(-0.58, 0.02, 0.55),
    new THREE.Vector3(-0.42, 0.47, 0.55),
    new THREE.Vector3(-0.22, -0.36, 0.55),
    new THREE.Vector3(0.02, 0.98, 0.55),
    new THREE.Vector3(0.22, -0.38, 0.55),
    new THREE.Vector3(0.4, 0.43, 0.55),
    new THREE.Vector3(0.58, 0.02, 0.55),
    new THREE.Vector3(1.52, 0.02, 0.55),
  ], 0.034, materials.white, false, false);
  centralSignal.name = 'signal-central';
  root.add(centralSignal);

  const lowerSignal = tube([
    new THREE.Vector3(-1.3, -1.14, 0.72),
    new THREE.Vector3(-1.14, -1.14, 0.72),
    new THREE.Vector3(-1.06, -0.62, 0.72),
    new THREE.Vector3(-0.96, -1.43, 0.72),
    new THREE.Vector3(-0.84, -0.51, 0.72),
    new THREE.Vector3(-0.71, -1.37, 0.72),
    new THREE.Vector3(-0.59, -0.99, 0.72),
    new THREE.Vector3(-0.46, -1.06, 0.72),
  ], 0.03, materials.cyan, false, false);
  lowerSignal.name = 'signal-orbit';
  root.add(lowerSignal);

  const pulseCores: THREE.Object3D[] = [];
  const orangeNode = createNode(materials.nodeOrange, materials.coreOrange, '#ff5b18', new THREE.Vector3(-2.3, -0.1, 0.42));
  orangeNode.group.name = 'node-orange';
  root.add(orangeNode.group);
  pulseCores.push(orangeNode.core);

  const upperNode = createNode(materials.nodeCyan, materials.coreCyan, '#00dfff', new THREE.Vector3(1.88, 0.96, -0.04));
  upperNode.group.name = 'node-upper-right';
  root.add(upperNode.group);
  pulseCores.push(upperNode.core);

  const lowerNode = createNode(materials.nodeCyan, materials.coreCyan, '#00dfff', new THREE.Vector3(1.62, -0.78, 0.72));
  lowerNode.group.name = 'node-lower-right';
  root.add(lowerNode.group);
  pulseCores.push(lowerNode.core);

  const crystalHalo = glowSprite('#009dff', 5.6);
  crystalHalo.position.set(0, 0.1, -0.55);
  crystalHalo.material.opacity = 0.16;
  root.add(crystalHalo);

  return { root, orbit, pulseCores, materials };
}

const canvas = document.querySelector<HTMLCanvasElement>('#scene');
if (!canvas) throw new Error('Missing #scene canvas');
const sceneCanvas = canvas;
const query = new URLSearchParams(window.location.search);
const embeddedMode = query.get('embed') === '1';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
camera.position.set(0, 0.15, 9.3);

const renderer = new THREE.WebGLRenderer({ canvas: sceneCanvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(embeddedMode ? 0x020304 : 0x000000, embeddedMode ? 1 : 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

const controls = new OrbitControls(camera, sceneCanvas);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.minDistance = 6.5;
controls.maxDistance = 13;
controls.maxPolarAngle = Math.PI * 0.72;
controls.minPolarAngle = Math.PI * 0.28;
controls.target.set(0, -0.08, 0);

scene.add(new THREE.HemisphereLight(0x85cfff, 0x02040a, 1.15));
const key = new THREE.DirectionalLight(0xa7eaff, 3.6);
key.position.set(-3, 4, 6);
scene.add(key);
const fill = new THREE.PointLight(0x176dcc, 18, 18, 2);
fill.position.set(4, -1, 4);
scene.add(fill);
const rim = new THREE.PointLight(0x00d9ff, 14, 15, 2);
rim.position.set(0, 3, -5);
scene.add(rim);

const emblem = createLifelineEnergyEmblem();
emblem.root.rotation.x = -0.035;
const reviewView = query.get('view');
const diagnosticMode = query.get('diagnostic') === '1';
emblem.root.position.y = reviewView === null ? -0.12 : 0.18;
emblem.root.scale.setScalar(reviewView === null ? 0.79 : 0.56);
if (reviewView === 'three-quarter-left') emblem.root.rotation.y = -0.52;
if (reviewView === 'three-quarter-right') emblem.root.rotation.y = 0.52;
scene.add(emblem.root);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.35, 0.78);
if (diagnosticMode) {
  bloom.strength = 0;
  renderer.toneMappingExposure = 0.92;
  emblem.root.traverse((object) => {
    if (object instanceof THREE.Sprite) object.visible = false;
  });
}
composer.addPass(bloom);

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let motionEnabled = reviewView === null && !reducedMotion;
let returningFront = false;
const frontRotation = new THREE.Euler(-0.035, 0, 0);

function resize() {
  const { clientWidth, clientHeight } = sceneCanvas;
  const width = Math.max(1, clientWidth);
  const height = Math.max(1, clientHeight);
  renderer.setSize(width, height, false);
  composer.setSize(width, height);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

const clock = new THREE.Clock();
function render() {
  const elapsed = clock.getElapsedTime();
  resize();
  if (motionEnabled && !returningFront) {
    emblem.root.rotation.y = Math.sin(elapsed * 0.34) * 0.18;
    emblem.root.rotation.x = -0.035 + Math.sin(elapsed * 0.22) * 0.025;
  }
  if (returningFront) {
    emblem.root.rotation.x = THREE.MathUtils.lerp(emblem.root.rotation.x, frontRotation.x, 0.1);
    emblem.root.rotation.y = THREE.MathUtils.lerp(emblem.root.rotation.y, 0, 0.1);
    emblem.root.rotation.z = THREE.MathUtils.lerp(emblem.root.rotation.z, 0, 0.1);
    camera.position.lerp(new THREE.Vector3(0, 0.15, 9.3), 0.1);
    if (Math.abs(emblem.root.rotation.y) < 0.002 && camera.position.distanceTo(new THREE.Vector3(0, 0.15, 9.3)) < 0.01) returningFront = false;
  }
  emblem.pulseCores.forEach((core, index) => {
    const pulse = 1 + Math.max(0, Math.sin(elapsed * 2.15 - index * 1.1)) * 0.16;
    core.scale.setScalar(pulse);
  });
  controls.update();
  composer.render();
  document.documentElement.classList.add('webgl-ready');
  requestAnimationFrame(render);
}

document.querySelector<HTMLButtonElement>('#front-view')?.addEventListener('click', () => {
  returningFront = true;
  controls.target.set(0, -0.08, 0);
});

const motionButton = document.querySelector<HTMLButtonElement>('#toggle-motion');
if (motionButton && !motionEnabled) {
  motionButton.setAttribute('aria-pressed', 'false');
  motionButton.textContent = '继续旋转';
}
motionButton?.addEventListener('click', () => {
  motionEnabled = !motionEnabled;
  motionButton.setAttribute('aria-pressed', String(motionEnabled));
  motionButton.textContent = motionEnabled ? '暂停旋转' : '继续旋转';
});

sceneCanvas.addEventListener('dblclick', () => { returningFront = true; });
window.addEventListener('resize', resize);
render();
