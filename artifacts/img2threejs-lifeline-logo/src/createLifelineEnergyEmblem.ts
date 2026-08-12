import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions): THREE.MeshPhysicalMaterial {
  const textures = makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : new THREE.Color(typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F'),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clamp01(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: Math.max(1, readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: Math.max(1, readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clamp01(readLayerNumber(spec.specularIntensity, ['base'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    if (bumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = bumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    if (displacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = displacementScale;
      material.displacementBias = -displacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Lifeline Energy Emblem
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createLifelineEnergyEmblemModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Lifeline Energy Emblem";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 32, "aspect": 1, "orientation": {"yaw": 0, "pitch": 0, "roll": 0}, "positionHint": [0, 0, 8], "note": "Near-orthographic logo view; front camera alignment is authored from the transparent canvas bounds."}, "approximationNotes": []};

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["utility-invisible"] = createSculptMaterial(
    "utility-invisible",
    {"id": "utility-invisible", "name": "Invisible root utility", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "qualityTier": "utility", "baseColor": "#000000", "color": "#000000", "albedo": {"dominant": "#000000", "secondary": ["#000000", "#ffffff"], "samplingNotes": "Sampled from visible solid-color logo region."}, "colorVariation": {"palette": ["#000000", "#ffffff"], "pattern": "facet-or-radial-gradient", "amplitude": 0.12, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-object-space", "repeat": [1, 1], "anisotropy": 1, "texelDensityIntent": "Solid vector-like material; stable in object space."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.12, "role": "broad illustrated gradient"}, {"id": "meso", "frequency": 8, "amplitude": 0.03, "role": "facet highlight transition"}, {"id": "micro", "frequency": 32, "amplitude": 0.01, "role": "subtle highlight breakup"}], "roughness": {"base": 1, "variation": 0.04, "map": "independent-procedural-roughness-field", "localResponse": "clean logo surface"}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "independent-subtle-normal-field", "strength": 0.04, "scale": 32, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.25, "notes": "Only at geometric overlaps."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#000000"}, "localOverrides": [], "emissive": {"color": "#000000", "intensity": 0}, "clearcoat": 0.35, "notes": "Procedural solid-color material for clean illustrated logo art; no photographic texture recovery required."},
    options
  );
  materialMap["crystal-navy"] = createSculptMaterial(
    "crystal-navy",
    {"id": "crystal-navy", "name": "Faceted navy crystal", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "qualityTier": "utility", "baseColor": "#00112f", "color": "#00112f", "albedo": {"dominant": "#00112f", "secondary": ["#00112f", "#ffffff"], "samplingNotes": "Sampled from visible solid-color logo region."}, "colorVariation": {"palette": ["#00112f", "#ffffff"], "pattern": "facet-or-radial-gradient", "amplitude": 0.12, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-object-space", "repeat": [1, 1], "anisotropy": 1, "texelDensityIntent": "Solid vector-like material; stable in object space."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.12, "role": "broad illustrated gradient"}, {"id": "meso", "frequency": 8, "amplitude": 0.03, "role": "facet highlight transition"}, {"id": "micro", "frequency": 32, "amplitude": 0.01, "role": "subtle highlight breakup"}], "roughness": {"base": 0.24, "variation": 0.04, "map": "independent-procedural-roughness-field", "localResponse": "clean logo surface"}, "metalness": {"base": 0.3, "variation": 0}, "normal": {"pattern": "independent-subtle-normal-field", "strength": 0.04, "scale": 32, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.25, "notes": "Only at geometric overlaps."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#000000"}, "localOverrides": [{"id": "crystal-navy.facet-highlights", "region": "front side facets", "color": "#bffcff", "roughness": 0.12, "evidenceRefs": ["full-object"]}], "emissive": {"color": "#000000", "intensity": 0}, "clearcoat": 0.9, "notes": "Procedural solid-color material for clean illustrated logo art; no photographic texture recovery required."},
    options
  );
  materialMap["orbit-navy"] = createSculptMaterial(
    "orbit-navy",
    {"id": "orbit-navy", "name": "Navy orbit shell", "type": "physical", "shaderModel": "MeshPhysicalMaterial", "qualityTier": "utility", "baseColor": "#00245f", "color": "#00245f", "albedo": {"dominant": "#00245f", "secondary": ["#00245f", "#ffffff"], "samplingNotes": "Sampled from visible solid-color logo region."}, "colorVariation": {"palette": ["#00245f", "#ffffff"], "pattern": "facet-or-radial-gradient", "amplitude": 0.12, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-object-space", "repeat": [1, 1], "anisotropy": 1, "texelDensityIntent": "Solid vector-like material; stable in object space."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.12, "role": "broad illustrated gradient"}, {"id": "meso", "frequency": 8, "amplitude": 0.03, "role": "facet highlight transition"}, {"id": "micro", "frequency": 32, "amplitude": 0.01, "role": "subtle highlight breakup"}], "roughness": {"base": 0.3, "variation": 0.04, "map": "independent-procedural-roughness-field", "localResponse": "clean logo surface"}, "metalness": {"base": 0.15, "variation": 0}, "normal": {"pattern": "independent-subtle-normal-field", "strength": 0.04, "scale": 32, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.25, "notes": "Only at geometric overlaps."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#000000"}, "localOverrides": [], "emissive": {"color": "#000000", "intensity": 0}, "clearcoat": 0.35, "notes": "Procedural solid-color material for clean illustrated logo art; no photographic texture recovery required."},
    options
  );
  materialMap["energy-cyan"] = createSculptMaterial(
    "energy-cyan",
    {"id": "energy-cyan", "name": "Cyan energy", "type": "physical-emissive", "shaderModel": "MeshPhysicalMaterial", "qualityTier": "utility", "baseColor": "#00eaff", "color": "#00eaff", "albedo": {"dominant": "#00eaff", "secondary": ["#00eaff", "#ffffff"], "samplingNotes": "Sampled from visible solid-color logo region."}, "colorVariation": {"palette": ["#00eaff", "#ffffff"], "pattern": "facet-or-radial-gradient", "amplitude": 0.12, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-object-space", "repeat": [1, 1], "anisotropy": 1, "texelDensityIntent": "Solid vector-like material; stable in object space."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.12, "role": "broad illustrated gradient"}, {"id": "meso", "frequency": 8, "amplitude": 0.03, "role": "facet highlight transition"}, {"id": "micro", "frequency": 32, "amplitude": 0.01, "role": "subtle highlight breakup"}], "roughness": {"base": 0.12, "variation": 0.04, "map": "independent-procedural-roughness-field", "localResponse": "clean logo surface"}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "independent-subtle-normal-field", "strength": 0.04, "scale": 32, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.25, "notes": "Only at geometric overlaps."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#000000"}, "localOverrides": [], "emissive": {"color": "#00d9ff", "intensity": 3.2}, "clearcoat": 0.9, "notes": "Procedural solid-color material for clean illustrated logo art; no photographic texture recovery required."},
    options
  );
  materialMap["energy-white"] = createSculptMaterial(
    "energy-white",
    {"id": "energy-white", "name": "White cyan energy", "type": "physical-emissive", "shaderModel": "MeshPhysicalMaterial", "qualityTier": "utility", "baseColor": "#ffffff", "color": "#ffffff", "albedo": {"dominant": "#ffffff", "secondary": ["#ffffff", "#ffffff"], "samplingNotes": "Sampled from visible solid-color logo region."}, "colorVariation": {"palette": ["#ffffff", "#ffffff"], "pattern": "facet-or-radial-gradient", "amplitude": 0.12, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-object-space", "repeat": [1, 1], "anisotropy": 1, "texelDensityIntent": "Solid vector-like material; stable in object space."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.12, "role": "broad illustrated gradient"}, {"id": "meso", "frequency": 8, "amplitude": 0.03, "role": "facet highlight transition"}, {"id": "micro", "frequency": 32, "amplitude": 0.01, "role": "subtle highlight breakup"}], "roughness": {"base": 0.08, "variation": 0.04, "map": "independent-procedural-roughness-field", "localResponse": "clean logo surface"}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "independent-subtle-normal-field", "strength": 0.04, "scale": 32, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.25, "notes": "Only at geometric overlaps."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#000000"}, "localOverrides": [], "emissive": {"color": "#bffcff", "intensity": 3.8}, "clearcoat": 0.9, "notes": "Procedural solid-color material for clean illustrated logo art; no photographic texture recovery required."},
    options
  );
  materialMap["node-cyan"] = createSculptMaterial(
    "node-cyan",
    {"id": "node-cyan", "name": "Glossy cyan nodes", "type": "physical-emissive", "shaderModel": "MeshPhysicalMaterial", "qualityTier": "utility", "baseColor": "#006ba8", "color": "#006ba8", "albedo": {"dominant": "#006ba8", "secondary": ["#006ba8", "#ffffff"], "samplingNotes": "Sampled from visible solid-color logo region."}, "colorVariation": {"palette": ["#006ba8", "#ffffff"], "pattern": "facet-or-radial-gradient", "amplitude": 0.12, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-object-space", "repeat": [1, 1], "anisotropy": 1, "texelDensityIntent": "Solid vector-like material; stable in object space."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.12, "role": "broad illustrated gradient"}, {"id": "meso", "frequency": 8, "amplitude": 0.03, "role": "facet highlight transition"}, {"id": "micro", "frequency": 32, "amplitude": 0.01, "role": "subtle highlight breakup"}], "roughness": {"base": 0.1, "variation": 0.04, "map": "independent-procedural-roughness-field", "localResponse": "clean logo surface"}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "independent-subtle-normal-field", "strength": 0.04, "scale": 32, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.25, "notes": "Only at geometric overlaps."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#000000"}, "localOverrides": [{"id": "node-cyan.core-highlight", "region": "upper-left core", "color": "#ffffff", "roughness": 0.04, "evidenceRefs": ["full-object"]}], "emissive": {"color": "#00bfe8", "intensity": 1.5}, "clearcoat": 0.9, "notes": "Procedural solid-color material for clean illustrated logo art; no photographic texture recovery required."},
    options
  );
  materialMap["node-orange"] = createSculptMaterial(
    "node-orange",
    {"id": "node-orange", "name": "Orange alert node", "type": "physical-emissive", "shaderModel": "MeshPhysicalMaterial", "qualityTier": "utility", "baseColor": "#ff4a16", "color": "#ff4a16", "albedo": {"dominant": "#ff4a16", "secondary": ["#ff4a16", "#ffffff"], "samplingNotes": "Sampled from visible solid-color logo region."}, "colorVariation": {"palette": ["#ff4a16", "#ffffff"], "pattern": "facet-or-radial-gradient", "amplitude": 0.12, "heightCorrelation": 0}, "textureResolution": 1024, "textureProjection": {"mode": "procedural-object-space", "repeat": [1, 1], "anisotropy": 1, "texelDensityIntent": "Solid vector-like material; stable in object space."}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1, "amplitude": 0.12, "role": "broad illustrated gradient"}, {"id": "meso", "frequency": 8, "amplitude": 0.03, "role": "facet highlight transition"}, {"id": "micro", "frequency": 32, "amplitude": 0.01, "role": "subtle highlight breakup"}], "roughness": {"base": 0.1, "variation": 0.04, "map": "independent-procedural-roughness-field", "localResponse": "clean logo surface"}, "metalness": {"base": 0, "variation": 0}, "normal": {"pattern": "independent-subtle-normal-field", "strength": 0.04, "scale": 32, "space": "tangent"}, "bump": {"pattern": "none", "amplitude": 0, "scale": 1}, "displacement": {"pattern": "none", "amplitude": 0, "scale": 1, "silhouetteAffects": false}, "ambientOcclusion": {"cavityStrength": 0.18, "contactShadowBias": 0.25, "notes": "Only at geometric overlaps."}, "wear": {"edgeWear": 0, "scratches": [], "chips": []}, "dirt": {"amount": 0, "cavityBias": 0, "color": "#000000"}, "localOverrides": [{"id": "node-orange.alert-core", "region": "center core", "color": "#fff566", "roughness": 0.04, "evidenceRefs": ["full-object"]}], "emissive": {"color": "#ff7800", "intensity": 2.4}, "clearcoat": 0.9, "notes": "Procedural solid-color material for clean illustrated logo art; no photographic texture recovery required."},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_root_0 = null;
  const endpoint_root_0 = makeAttachmentEndpoint(attachment_root_0);
  const node_root_0 = new THREE.Group();
  node_root_0.name = "Lifeline Energy Emblem__pivot";
  if (endpoint_root_0) {
    node_root_0.position.copy(endpoint_root_0.start);
    node_root_0.rotation.set(0, 0, 0);
    node_root_0.scale.set(1, 1, 1);
  } else {
    node_root_0.position.set(0.0, 0.0, 0.0);
    node_root_0.rotation.set(0.0, 0.0, 0.0);
    node_root_0.scale.set(1.0, 1.0, 1.0);
  }
  node_root_0.userData.sculptComponent = {"id": "root", "name": "Lifeline Energy Emblem", "level": "macro", "role": "root", "importance": 0.95, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Stable transform root for four independently animated visual assemblies.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 17, 47, 1)", "secondaryAlbedo": "rgba(0, 51, 111, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 17, 47, 1)"}, {"position": 1, "color": "rgba(0, 51, 111, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Stable transform root for four independently animated visual assemblies.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 6.4, "height": 5.8, "depth": 0.7, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "utility-invisible", "materialLayers": ["utility-invisible"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_root_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}};
  (nodes["root"] ?? root).add(node_root_0);
  nodes["root"] = node_root_0;
  const mesh_root_0Geometry = endpoint_root_0
    ? new THREE.CylinderGeometry(endpoint_root_0.endRadius, endpoint_root_0.baseRadius, endpoint_root_0.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_root_0 = new THREE.Mesh(
    mesh_root_0Geometry,
    materialMap["utility-invisible"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_0.name = "Lifeline Energy Emblem";
  if (endpoint_root_0) {
    mesh_root_0.position.copy(endpoint_root_0.midpoint);
    mesh_root_0.quaternion.copy(endpoint_root_0.quaternion);
  }
  mesh_root_0.castShadow = options.castShadow ?? true;
  mesh_root_0.receiveShadow = options.receiveShadow ?? true;
  mesh_root_0.userData.sculptComponent = {"id": "root", "name": "Lifeline Energy Emblem", "level": "macro", "role": "root", "importance": 0.95, "confidence": 0.9, "primitive": "box", "topologyClass": "assembled-solid", "topologyRationale": "Stable transform root for four independently animated visual assemblies.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 17, 47, 1)", "secondaryAlbedo": "rgba(0, 51, 111, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 17, 47, 1)"}, {"position": 1, "color": "rgba(0, 51, 111, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Stable transform root for four independently animated visual assemblies.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 6.4, "height": 5.8, "depth": 0.7, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "utility-invisible", "materialLayers": ["utility-invisible"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_root_0.add(mesh_root_0);
  meshes["root"] = mesh_root_0;
  colliders["root"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["root"] ??= [];
  destructionGroups["root"].push(node_root_0);

  const attachment_crystal_core_1 = null;
  const endpoint_crystal_core_1 = makeAttachmentEndpoint(attachment_crystal_core_1);
  const node_crystal_core_1 = new THREE.Group();
  node_crystal_core_1.name = "Faceted central crystal__pivot";
  if (endpoint_crystal_core_1) {
    node_crystal_core_1.position.copy(endpoint_crystal_core_1.start);
    node_crystal_core_1.rotation.set(0, 0, 0);
    node_crystal_core_1.scale.set(1, 1, 1);
  } else {
    node_crystal_core_1.position.set(0.0, 0.0, 0.0);
    node_crystal_core_1.rotation.set(0.0, 0.0, 0.0);
    node_crystal_core_1.scale.set(1.0, 1.0, 1.0);
  }
  node_crystal_core_1.userData.sculptComponent = {"id": "crystal-core", "name": "Faceted central crystal", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Reference shows a planar pointed profile with shallow faceted depth and straight perimeter edges.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 17, 47, 1)", "secondaryAlbedo": "rgba(0, 51, 111, 1)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 17, 47, 1)"}, {"position": 1, "color": "rgba(0, 51, 111, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Reference shows a planar pointed profile with shallow faceted depth and straight perimeter edges.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.8, "height": 5.6, "depth": 0.5, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "crystal-navy", "materialLayers": ["crystal-navy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "crystal-core.axial-seam", "kind": "emissive", "description": "Continuous vertical cyan seam", "realization": "geometry"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_crystal_core_1.userData.actionProfile = {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}};
  (nodes["root"] ?? root).add(node_crystal_core_1);
  nodes["crystal-core"] = node_crystal_core_1;
  const mesh_crystal_core_1Geometry = endpoint_crystal_core_1
    ? new THREE.CylinderGeometry(endpoint_crystal_core_1.endRadius, endpoint_crystal_core_1.baseRadius, endpoint_crystal_core_1.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.3, -0.3], [0.3, -0.3], [0.3, 0.3], [-0.3, 0.3]], "depth": 0.1});
  const mesh_crystal_core_1 = new THREE.Mesh(
    mesh_crystal_core_1Geometry,
    materialMap["crystal-navy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crystal_core_1.name = "Faceted central crystal";
  if (endpoint_crystal_core_1) {
    mesh_crystal_core_1.position.copy(endpoint_crystal_core_1.midpoint);
    mesh_crystal_core_1.quaternion.copy(endpoint_crystal_core_1.quaternion);
  }
  mesh_crystal_core_1.castShadow = options.castShadow ?? true;
  mesh_crystal_core_1.receiveShadow = options.receiveShadow ?? true;
  mesh_crystal_core_1.userData.sculptComponent = {"id": "crystal-core", "name": "Faceted central crystal", "level": "macro", "role": "body", "importance": 0.95, "confidence": 0.9, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Reference shows a planar pointed profile with shallow faceted depth and straight perimeter edges.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 17, 47, 1)", "secondaryAlbedo": "rgba(0, 51, 111, 1)", "materialClass": "metal", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 17, 47, 1)"}, {"position": 1, "color": "rgba(0, 51, 111, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Reference shows a planar pointed profile with shallow faceted depth and straight perimeter edges.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"width": 1.8, "height": 5.6, "depth": 0.5, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "body", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "body", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "crystal-navy", "materialLayers": ["crystal-navy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "crystal-core.axial-seam", "kind": "emissive", "description": "Continuous vertical cyan seam", "realization": "geometry"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_crystal_core_1.add(mesh_crystal_core_1);
  meshes["crystal-core"] = mesh_crystal_core_1;
  colliders["crystal-core"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["body"] ??= [];
  destructionGroups["body"].push(node_crystal_core_1);

  const attachment_crystal_highlights_2 = {"parentId": "crystal-core", "parentSocket": "crystal-core-center", "localStart": [0, -1.5, 0.25], "localEnd": [0, 1.5, 0.25], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_crystal_highlights_2 = makeAttachmentEndpoint(attachment_crystal_highlights_2);
  const node_crystal_highlights_2 = new THREE.Group();
  node_crystal_highlights_2.name = "Crystal facet highlight strips__pivot";
  if (endpoint_crystal_highlights_2) {
    node_crystal_highlights_2.position.copy(endpoint_crystal_highlights_2.start);
    node_crystal_highlights_2.rotation.set(0, 0, 0);
    node_crystal_highlights_2.scale.set(1, 1, 1);
  } else {
    node_crystal_highlights_2.position.set(0.0, 0.55, 0.28);
    node_crystal_highlights_2.rotation.set(0.0, 0.0, 0.0);
    node_crystal_highlights_2.scale.set(1.0, 1.0, 1.0);
  }
  node_crystal_highlights_2.userData.sculptComponent = {"id": "crystal-highlights", "name": "Crystal facet highlight strips", "level": "meso", "role": "surface-relief", "importance": 0.8, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "Thin raised light strips sit flush with the front facets and do not change the outer silhouette.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1)", "secondaryAlbedo": "rgba(0, 234, 255, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(255, 255, 255, 1)"}, {"position": 1, "color": "rgba(0, 234, 255, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Thin raised light strips sit flush with the front facets and do not change the outer silhouette.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "crystal-core", "attachment": {"parentId": "crystal-core", "parentSocket": "crystal-core-center", "localStart": [0, -1.5, 0.25], "localEnd": [0, 1.5, 0.25], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.2, "height": 3.2, "depth": 0.03, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.55, 0.28], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-relief", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "surface-relief", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "energy-white", "materialLayers": ["energy-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_crystal_highlights_2.userData.actionProfile = {"animationRole": "surface-relief", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "surface-relief", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}};
  (nodes["crystal-core"] ?? root).add(node_crystal_highlights_2);
  nodes["crystal-highlights"] = node_crystal_highlights_2;
  const mesh_crystal_highlights_2Geometry = endpoint_crystal_highlights_2
    ? new THREE.CylinderGeometry(endpoint_crystal_highlights_2.endRadius, endpoint_crystal_highlights_2.baseRadius, endpoint_crystal_highlights_2.length, 32, 12)
    : new THREE.PlaneGeometry(1, 1, 24, 24);
  const mesh_crystal_highlights_2 = new THREE.Mesh(
    mesh_crystal_highlights_2Geometry,
    materialMap["energy-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_crystal_highlights_2.name = "Crystal facet highlight strips";
  if (endpoint_crystal_highlights_2) {
    mesh_crystal_highlights_2.position.copy(endpoint_crystal_highlights_2.midpoint);
    mesh_crystal_highlights_2.quaternion.copy(endpoint_crystal_highlights_2.quaternion);
  }
  mesh_crystal_highlights_2.castShadow = options.castShadow ?? true;
  mesh_crystal_highlights_2.receiveShadow = options.receiveShadow ?? true;
  mesh_crystal_highlights_2.userData.sculptComponent = {"id": "crystal-highlights", "name": "Crystal facet highlight strips", "level": "meso", "role": "surface-relief", "importance": 0.8, "confidence": 0.9, "primitive": "plane-card", "topologyClass": "surface-relief", "topologyRationale": "Thin raised light strips sit flush with the front facets and do not change the outer silhouette.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1)", "secondaryAlbedo": "rgba(0, 234, 255, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(255, 255, 255, 1)"}, {"position": 1, "color": "rgba(0, 234, 255, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Thin raised light strips sit flush with the front facets and do not change the outer silhouette.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "crystal-core", "attachment": {"parentId": "crystal-core", "parentSocket": "crystal-core-center", "localStart": [0, -1.5, 0.25], "localEnd": [0, 1.5, 0.25], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.2, "height": 3.2, "depth": 0.03, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.55, 0.28], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "surface-relief", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "surface-relief", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "energy-white", "materialLayers": ["energy-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_crystal_highlights_2.add(mesh_crystal_highlights_2);
  meshes["crystal-highlights"] = mesh_crystal_highlights_2;
  colliders["crystal-highlights"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["surface-relief"] ??= [];
  destructionGroups["surface-relief"].push(node_crystal_highlights_2);

  const attachment_orbit_shell_3 = {"parentId": "root", "parentSocket": "root-center", "localStart": [-3.1, -0.2, 0], "localEnd": [3.1, 0.4, 0], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_orbit_shell_3 = makeAttachmentEndpoint(attachment_orbit_shell_3);
  const node_orbit_shell_3 = new THREE.Group();
  node_orbit_shell_3.name = "Elliptical orbital shell__pivot";
  if (endpoint_orbit_shell_3) {
    node_orbit_shell_3.position.copy(endpoint_orbit_shell_3.start);
    node_orbit_shell_3.rotation.set(0, 0, 0);
    node_orbit_shell_3.scale.set(1, 1, 1);
  } else {
    node_orbit_shell_3.position.set(0.0, -0.35, 0.0);
    node_orbit_shell_3.rotation.set(0.0, 0.0, 0.0);
    node_orbit_shell_3.scale.set(1.0, 1.0, 1.0);
  }
  node_orbit_shell_3.userData.sculptComponent = {"id": "orbit-shell", "name": "Elliptical orbital shell", "level": "macro", "role": "connector", "importance": 0.95, "confidence": 0.9, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "A continuous swept tube follows the visible elliptical route around the crystal.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 17, 47, 1)", "secondaryAlbedo": "rgba(0, 51, 111, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 17, 47, 1)"}, {"position": 1, "color": "rgba(0, 51, 111, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "A continuous swept tube follows the visible elliptical route around the crystal.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-center", "localStart": [-3.1, -0.2, 0], "localEnd": [3.1, 0.4, 0], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 6.2, "height": 2.5, "depth": 0.34, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, -0.35, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "orbit-navy", "materialLayers": ["orbit-navy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "orbit-shell.depth-route", "kind": "contour", "description": "Authored front/back depth route through crystal crossings", "realization": "geometry"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_orbit_shell_3.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}};
  (nodes["root"] ?? root).add(node_orbit_shell_3);
  nodes["orbit-shell"] = node_orbit_shell_3;
  const mesh_orbit_shell_3Geometry = endpoint_orbit_shell_3
    ? new THREE.CylinderGeometry(endpoint_orbit_shell_3.endRadius, endpoint_orbit_shell_3.baseRadius, endpoint_orbit_shell_3.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  const mesh_orbit_shell_3 = new THREE.Mesh(
    mesh_orbit_shell_3Geometry,
    materialMap["orbit-navy"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_orbit_shell_3.name = "Elliptical orbital shell";
  if (endpoint_orbit_shell_3) {
    mesh_orbit_shell_3.position.copy(endpoint_orbit_shell_3.midpoint);
    mesh_orbit_shell_3.quaternion.copy(endpoint_orbit_shell_3.quaternion);
  }
  mesh_orbit_shell_3.castShadow = options.castShadow ?? true;
  mesh_orbit_shell_3.receiveShadow = options.receiveShadow ?? true;
  mesh_orbit_shell_3.userData.sculptComponent = {"id": "orbit-shell", "name": "Elliptical orbital shell", "level": "macro", "role": "connector", "importance": 0.95, "confidence": 0.9, "primitive": "tube", "topologyClass": "assembled-solid", "topologyRationale": "A continuous swept tube follows the visible elliptical route around the crystal.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 17, 47, 1)", "secondaryAlbedo": "rgba(0, 51, 111, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 17, 47, 1)"}, {"position": 1, "color": "rgba(0, 51, 111, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "A continuous swept tube follows the visible elliptical route around the crystal.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-center", "localStart": [-3.1, -0.2, 0], "localEnd": [3.1, 0.4, 0], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 6.2, "height": 2.5, "depth": 0.34, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, -0.35, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "orbit-navy", "materialLayers": ["orbit-navy"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "orbit-shell.depth-route", "kind": "contour", "description": "Authored front/back depth route through crystal crossings", "realization": "geometry"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_orbit_shell_3.add(mesh_orbit_shell_3);
  meshes["orbit-shell"] = mesh_orbit_shell_3;
  colliders["orbit-shell"] = {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["connector"] ??= [];
  destructionGroups["connector"].push(node_orbit_shell_3);

  const attachment_orbit_energy_4 = {"parentId": "orbit-shell", "parentSocket": "orbit-shell-center", "localStart": [-2.9, -0.1, 0.15], "localEnd": [2.9, 0.3, 0.15], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_orbit_energy_4 = makeAttachmentEndpoint(attachment_orbit_energy_4);
  const node_orbit_energy_4 = new THREE.Group();
  node_orbit_energy_4.name = "Cyan orbital energy inset__pivot";
  if (endpoint_orbit_energy_4) {
    node_orbit_energy_4.position.copy(endpoint_orbit_energy_4.start);
    node_orbit_energy_4.rotation.set(0, 0, 0);
    node_orbit_energy_4.scale.set(1, 1, 1);
  } else {
    node_orbit_energy_4.position.set(0.0, 0.02, 0.2);
    node_orbit_energy_4.rotation.set(0.0, 0.0, 0.0);
    node_orbit_energy_4.scale.set(1.0, 1.0, 1.0);
  }
  node_orbit_energy_4.userData.sculptComponent = {"id": "orbit-energy", "name": "Cyan orbital energy inset", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.9, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "A thinner luminous curve follows and overlaps the inner face of the structural orbit tube.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 234, 255, 1)", "secondaryAlbedo": "rgba(191, 252, 255, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 234, 255, 1)"}, {"position": 1, "color": "rgba(191, 252, 255, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "A thinner luminous curve follows and overlaps the inner face of the structural orbit tube.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "orbit-shell", "attachment": {"parentId": "orbit-shell", "parentSocket": "orbit-shell-center", "localStart": [-2.9, -0.1, 0.15], "localEnd": [2.9, 0.3, 0.15], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 5.9, "height": 2.2, "depth": 0.12, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.02, 0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "energy-cyan", "materialLayers": ["energy-cyan"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "orbit-energy.inset-route", "kind": "emissive", "description": "Reference-matched cyan inner route", "realization": "geometry"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_orbit_energy_4.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}};
  (nodes["orbit-shell"] ?? root).add(node_orbit_energy_4);
  nodes["orbit-energy"] = node_orbit_energy_4;
  const mesh_orbit_energy_4Geometry = endpoint_orbit_energy_4
    ? new THREE.CylinderGeometry(endpoint_orbit_energy_4.endRadius, endpoint_orbit_energy_4.baseRadius, endpoint_orbit_energy_4.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  const mesh_orbit_energy_4 = new THREE.Mesh(
    mesh_orbit_energy_4Geometry,
    materialMap["energy-cyan"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_orbit_energy_4.name = "Cyan orbital energy inset";
  if (endpoint_orbit_energy_4) {
    mesh_orbit_energy_4.position.copy(endpoint_orbit_energy_4.midpoint);
    mesh_orbit_energy_4.quaternion.copy(endpoint_orbit_energy_4.quaternion);
  }
  mesh_orbit_energy_4.castShadow = options.castShadow ?? true;
  mesh_orbit_energy_4.receiveShadow = options.receiveShadow ?? true;
  mesh_orbit_energy_4.userData.sculptComponent = {"id": "orbit-energy", "name": "Cyan orbital energy inset", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.9, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "A thinner luminous curve follows and overlaps the inner face of the structural orbit tube.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 234, 255, 1)", "secondaryAlbedo": "rgba(191, 252, 255, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 234, 255, 1)"}, {"position": 1, "color": "rgba(191, 252, 255, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "A thinner luminous curve follows and overlaps the inner face of the structural orbit tube.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "orbit-shell", "attachment": {"parentId": "orbit-shell", "parentSocket": "orbit-shell-center", "localStart": [-2.9, -0.1, 0.15], "localEnd": [2.9, 0.3, 0.15], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 5.9, "height": 2.2, "depth": 0.12, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.02, 0.2], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "energy-cyan", "materialLayers": ["energy-cyan"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "orbit-energy.inset-route", "kind": "emissive", "description": "Reference-matched cyan inner route", "realization": "geometry"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_orbit_energy_4.add(mesh_orbit_energy_4);
  meshes["orbit-energy"] = mesh_orbit_energy_4;
  colliders["orbit-energy"] = {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["connector"] ??= [];
  destructionGroups["connector"].push(node_orbit_energy_4);

  const attachment_signal_central_5 = {"parentId": "root", "parentSocket": "root-center", "localStart": [-1.7, 0, 0.35], "localEnd": [1.7, 0, 0.35], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_signal_central_5 = makeAttachmentEndpoint(attachment_signal_central_5);
  const node_signal_central_5 = new THREE.Group();
  node_signal_central_5.name = "Central ECG signal__pivot";
  if (endpoint_signal_central_5) {
    node_signal_central_5.position.copy(endpoint_signal_central_5.start);
    node_signal_central_5.rotation.set(0, 0, 0);
    node_signal_central_5.scale.set(1, 1, 1);
  } else {
    node_signal_central_5.position.set(0.0, 0.08, 0.45);
    node_signal_central_5.rotation.set(0.0, 0.0, 0.0);
    node_signal_central_5.scale.set(1.0, 1.0, 1.0);
  }
  node_signal_central_5.userData.sculptComponent = {"id": "signal-central", "name": "Central ECG signal", "level": "macro", "role": "connector", "importance": 0.95, "confidence": 0.9, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "Angular tube path is raised over the crystal front and defines the emblem identity.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1)", "secondaryAlbedo": "rgba(0, 234, 255, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(255, 255, 255, 1)"}, {"position": 1, "color": "rgba(0, 234, 255, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Angular tube path is raised over the crystal front and defines the emblem identity.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-center", "localStart": [-1.7, 0, 0.35], "localEnd": [1.7, 0, 0.35], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.4, "height": 1.15, "depth": 0.12, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.08, 0.45], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "energy-white", "materialLayers": ["energy-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "signal-central.ecg-profile", "kind": "linework", "description": "Primary five-turn ECG profile", "realization": "geometry"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_signal_central_5.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}};
  (nodes["root"] ?? root).add(node_signal_central_5);
  nodes["signal-central"] = node_signal_central_5;
  const mesh_signal_central_5Geometry = endpoint_signal_central_5
    ? new THREE.CylinderGeometry(endpoint_signal_central_5.endRadius, endpoint_signal_central_5.baseRadius, endpoint_signal_central_5.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  const mesh_signal_central_5 = new THREE.Mesh(
    mesh_signal_central_5Geometry,
    materialMap["energy-white"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_signal_central_5.name = "Central ECG signal";
  if (endpoint_signal_central_5) {
    mesh_signal_central_5.position.copy(endpoint_signal_central_5.midpoint);
    mesh_signal_central_5.quaternion.copy(endpoint_signal_central_5.quaternion);
  }
  mesh_signal_central_5.castShadow = options.castShadow ?? true;
  mesh_signal_central_5.receiveShadow = options.receiveShadow ?? true;
  mesh_signal_central_5.userData.sculptComponent = {"id": "signal-central", "name": "Central ECG signal", "level": "macro", "role": "connector", "importance": 0.95, "confidence": 0.9, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "Angular tube path is raised over the crystal front and defines the emblem identity.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 255, 255, 1)", "secondaryAlbedo": "rgba(0, 234, 255, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(255, 255, 255, 1)"}, {"position": 1, "color": "rgba(0, 234, 255, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Angular tube path is raised over the crystal front and defines the emblem identity.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": {"parentId": "root", "parentSocket": "root-center", "localStart": [-1.7, 0, 0.35], "localEnd": [1.7, 0, 0.35], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 3.4, "height": 1.15, "depth": 0.12, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0.08, 0.45], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "energy-white", "materialLayers": ["energy-white"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "signal-central.ecg-profile", "kind": "linework", "description": "Primary five-turn ECG profile", "realization": "geometry"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_signal_central_5.add(mesh_signal_central_5);
  meshes["signal-central"] = mesh_signal_central_5;
  colliders["signal-central"] = {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["connector"] ??= [];
  destructionGroups["connector"].push(node_signal_central_5);

  const attachment_signal_orbit_6 = {"parentId": "orbit-shell", "parentSocket": "orbit-shell-center", "localStart": [-1.45, -0.75, 0.3], "localEnd": [-0.35, -0.75, 0.3], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_signal_orbit_6 = makeAttachmentEndpoint(attachment_signal_orbit_6);
  const node_signal_orbit_6 = new THREE.Group();
  node_signal_orbit_6.name = "Lower orbit ECG signal__pivot";
  if (endpoint_signal_orbit_6) {
    node_signal_orbit_6.position.copy(endpoint_signal_orbit_6.start);
    node_signal_orbit_6.rotation.set(0, 0, 0);
    node_signal_orbit_6.scale.set(1, 1, 1);
  } else {
    node_signal_orbit_6.position.set(-0.95, -1.02, 0.48);
    node_signal_orbit_6.rotation.set(0.0, 0.0, 0.0);
    node_signal_orbit_6.scale.set(1.0, 1.0, 1.0);
  }
  node_signal_orbit_6.userData.sculptComponent = {"id": "signal-orbit", "name": "Lower orbit ECG signal", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.9, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "Compact angular tube replaces a short lower-orbit segment and remains visibly raised.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 234, 255, 1)", "secondaryAlbedo": "rgba(191, 252, 255, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 234, 255, 1)"}, {"position": 1, "color": "rgba(191, 252, 255, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Compact angular tube replaces a short lower-orbit segment and remains visibly raised.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "orbit-shell", "attachment": {"parentId": "orbit-shell", "parentSocket": "orbit-shell-center", "localStart": [-1.45, -0.75, 0.3], "localEnd": [-0.35, -0.75, 0.3], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.15, "height": 0.9, "depth": 0.1, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.95, -1.02, 0.48], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "energy-cyan", "materialLayers": ["energy-cyan"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "signal-orbit.ecg-profile", "kind": "linework", "description": "Secondary compact ECG profile", "realization": "geometry"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_signal_orbit_6.userData.actionProfile = {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}};
  (nodes["orbit-shell"] ?? root).add(node_signal_orbit_6);
  nodes["signal-orbit"] = node_signal_orbit_6;
  const mesh_signal_orbit_6Geometry = endpoint_signal_orbit_6
    ? new THREE.CylinderGeometry(endpoint_signal_orbit_6.endRadius, endpoint_signal_orbit_6.baseRadius, endpoint_signal_orbit_6.length, 32, 12)
    : buildTubeGeometry({"points": [[0.0, -0.5, 0.0], [0.0, 0.5, 0.0]], "radius": 0.05, "closed": false});
  const mesh_signal_orbit_6 = new THREE.Mesh(
    mesh_signal_orbit_6Geometry,
    materialMap["energy-cyan"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_signal_orbit_6.name = "Lower orbit ECG signal";
  if (endpoint_signal_orbit_6) {
    mesh_signal_orbit_6.position.copy(endpoint_signal_orbit_6.midpoint);
    mesh_signal_orbit_6.quaternion.copy(endpoint_signal_orbit_6.quaternion);
  }
  mesh_signal_orbit_6.castShadow = options.castShadow ?? true;
  mesh_signal_orbit_6.receiveShadow = options.receiveShadow ?? true;
  mesh_signal_orbit_6.userData.sculptComponent = {"id": "signal-orbit", "name": "Lower orbit ECG signal", "level": "meso", "role": "connector", "importance": 0.8, "confidence": 0.9, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "Compact angular tube replaces a short lower-orbit segment and remains visibly raised.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 234, 255, 1)", "secondaryAlbedo": "rgba(191, 252, 255, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 234, 255, 1)"}, {"position": 1, "color": "rgba(191, 252, 255, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Compact angular tube replaces a short lower-orbit segment and remains visibly raised.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "orbit-shell", "attachment": {"parentId": "orbit-shell", "parentSocket": "orbit-shell-center", "localStart": [-1.45, -0.75, 0.3], "localEnd": [-0.35, -0.75, 0.3], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.15, "height": 0.9, "depth": 0.1, "units": "relative", "confidence": 0.9}, "transform": {"position": [-0.95, -1.02, 0.48], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "connector", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "connector", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "energy-cyan", "materialLayers": ["energy-cyan"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "signal-orbit.ecg-profile", "kind": "linework", "description": "Secondary compact ECG profile", "realization": "geometry"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_signal_orbit_6.add(mesh_signal_orbit_6);
  meshes["signal-orbit"] = mesh_signal_orbit_6;
  colliders["signal-orbit"] = {"type": "tube", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["connector"] ??= [];
  destructionGroups["connector"].push(node_signal_orbit_6);

  const attachment_node_cyan_group_7 = null;
  const endpoint_node_cyan_group_7 = makeAttachmentEndpoint(attachment_node_cyan_group_7);
  const node_node_cyan_group_7 = new THREE.Group();
  node_node_cyan_group_7.name = "Cyan orbit nodes__pivot";
  if (endpoint_node_cyan_group_7) {
    node_node_cyan_group_7.position.copy(endpoint_node_cyan_group_7.start);
    node_node_cyan_group_7.rotation.set(0, 0, 0);
    node_node_cyan_group_7.scale.set(1, 1, 1);
  } else {
    node_node_cyan_group_7.position.set(0.0, 0.0, 0.0);
    node_node_cyan_group_7.rotation.set(0.0, 0.0, 0.0);
    node_node_cyan_group_7.scale.set(1.0, 1.0, 1.0);
  }
  node_node_cyan_group_7.userData.sculptComponent = {"id": "node-cyan-group", "name": "Cyan orbit nodes", "level": "macro", "role": "node-group", "importance": 0.95, "confidence": 0.9, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Two repeated glossy spherical sockets share geometry and material while retaining stable pivots.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 234, 255, 1)", "secondaryAlbedo": "rgba(191, 252, 255, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 234, 255, 1)"}, {"position": 1, "color": "rgba(191, 252, 255, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Two repeated glossy spherical sockets share geometry and material while retaining stable pivots.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"radius": 0.38, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "node-group", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "node-group", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "node-cyan", "materialLayers": ["node-cyan"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "node-cyan.core-highlight", "kind": "gloss", "description": "Offset white/cyan emissive cores", "realization": "geometry-and-material"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_node_cyan_group_7.userData.actionProfile = {"animationRole": "node-group", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "node-group", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}};
  (nodes["root"] ?? root).add(node_node_cyan_group_7);
  nodes["node-cyan-group"] = node_node_cyan_group_7;
  const mesh_node_cyan_group_7Geometry = endpoint_node_cyan_group_7
    ? new THREE.CylinderGeometry(endpoint_node_cyan_group_7.endRadius, endpoint_node_cyan_group_7.baseRadius, endpoint_node_cyan_group_7.length, 32, 12)
    : new THREE.BoxGeometry(1, 1, 1, 12, 12, 12);
  const mesh_node_cyan_group_7 = new THREE.Mesh(
    mesh_node_cyan_group_7Geometry,
    materialMap["node-cyan"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_node_cyan_group_7.name = "Cyan orbit nodes";
  if (endpoint_node_cyan_group_7) {
    mesh_node_cyan_group_7.position.copy(endpoint_node_cyan_group_7.midpoint);
    mesh_node_cyan_group_7.quaternion.copy(endpoint_node_cyan_group_7.quaternion);
  }
  mesh_node_cyan_group_7.castShadow = options.castShadow ?? true;
  mesh_node_cyan_group_7.receiveShadow = options.receiveShadow ?? true;
  mesh_node_cyan_group_7.userData.sculptComponent = {"id": "node-cyan-group", "name": "Cyan orbit nodes", "level": "macro", "role": "node-group", "importance": 0.95, "confidence": 0.9, "primitive": "instanced-cluster", "topologyClass": "assembled-solid", "topologyRationale": "Two repeated glossy spherical sockets share geometry and material while retaining stable pivots.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(0, 234, 255, 1)", "secondaryAlbedo": "rgba(191, 252, 255, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(0, 234, 255, 1)"}, {"position": 1, "color": "rgba(191, 252, 255, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Two repeated glossy spherical sockets share geometry and material while retaining stable pivots.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "root", "attachment": null, "dimensions": {"radius": 0.38, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "node-group", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "node-group", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "node-cyan", "materialLayers": ["node-cyan"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "node-cyan.core-highlight", "kind": "gloss", "description": "Offset white/cyan emissive cores", "realization": "geometry-and-material"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_node_cyan_group_7.add(mesh_node_cyan_group_7);
  meshes["node-cyan-group"] = mesh_node_cyan_group_7;
  colliders["node-cyan-group"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["node-group"] ??= [];
  destructionGroups["node-group"].push(node_node_cyan_group_7);

  const attachment_node_orange_8 = {"parentId": "orbit-shell", "parentSocket": "orbit-shell-center", "localStart": [-2.45, 0.2, 0], "localEnd": [-2.45, 0.2, 0.45], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]};
  const endpoint_node_orange_8 = makeAttachmentEndpoint(attachment_node_orange_8);
  const node_node_orange_8 = new THREE.Group();
  node_node_orange_8.name = "Orange alert node__pivot";
  if (endpoint_node_orange_8) {
    node_node_orange_8.position.copy(endpoint_node_orange_8.start);
    node_node_orange_8.rotation.set(0, 0, 0);
    node_node_orange_8.scale.set(1, 1, 1);
  } else {
    node_node_orange_8.position.set(-2.45, 0.2, 0.45);
    node_node_orange_8.rotation.set(0.0, 0.0, 0.0);
    node_node_orange_8.scale.set(1.0, 1.0, 1.0);
  }
  node_node_orange_8.userData.sculptComponent = {"id": "node-orange", "name": "Orange alert node", "level": "meso", "role": "node", "importance": 0.8, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Single glossy sphere with nested emissive core attached to the left orbit endpoint.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 74, 22, 1)", "secondaryAlbedo": "rgba(255, 245, 102, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(255, 74, 22, 1)"}, {"position": 1, "color": "rgba(255, 245, 102, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Single glossy sphere with nested emissive core attached to the left orbit endpoint.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "orbit-shell", "attachment": {"parentId": "orbit-shell", "parentSocket": "orbit-shell-center", "localStart": [-2.45, 0.2, 0], "localEnd": [-2.45, 0.2, 0.45], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"radius": 0.38, "units": "relative", "confidence": 0.9}, "transform": {"position": [-2.45, 0.2, 0.45], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "node", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "node", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "node-orange", "materialLayers": ["node-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "node-orange.alert-core", "kind": "gloss", "description": "Red-orange falloff with yellow-white core", "realization": "geometry-and-material"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_node_orange_8.userData.actionProfile = {"animationRole": "node", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "node", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}};
  (nodes["orbit-shell"] ?? root).add(node_node_orange_8);
  nodes["node-orange"] = node_node_orange_8;
  const mesh_node_orange_8Geometry = endpoint_node_orange_8
    ? new THREE.CylinderGeometry(endpoint_node_orange_8.endRadius, endpoint_node_orange_8.baseRadius, endpoint_node_orange_8.length, 32, 12)
    : new THREE.SphereGeometry(0.5, 64, 40);
  const mesh_node_orange_8 = new THREE.Mesh(
    mesh_node_orange_8Geometry,
    materialMap["node-orange"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_node_orange_8.name = "Orange alert node";
  if (endpoint_node_orange_8) {
    mesh_node_orange_8.position.copy(endpoint_node_orange_8.midpoint);
    mesh_node_orange_8.quaternion.copy(endpoint_node_orange_8.quaternion);
  }
  mesh_node_orange_8.castShadow = options.castShadow ?? true;
  mesh_node_orange_8.receiveShadow = options.receiveShadow ?? true;
  mesh_node_orange_8.userData.sculptComponent = {"id": "node-orange", "name": "Orange alert node", "level": "meso", "role": "node", "importance": 0.8, "confidence": 0.9, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Single glossy sphere with nested emissive core attached to the left orbit endpoint.", "colorMaterialRecipe": {"dominantAlbedo": "rgba(255, 74, 22, 1)", "secondaryAlbedo": "rgba(255, 245, 102, 1)", "materialClass": "plastic", "materialClassConfidence": 0.9, "colorGradient": {"type": "linear", "stops": [{"position": 0, "color": "rgba(255, 74, 22, 1)"}, {"position": 1, "color": "rgba(255, 245, 102, 1)"}]}}, "geometryDescriptor": {"topologyIntent": "Single glossy sphere with nested emissive core attached to the left orbit endpoint.", "edgeTreatment": {"type": "bevel", "bevelRadius": 0.025, "segments": 3}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "orbit-shell", "attachment": {"parentId": "orbit-shell", "parentSocket": "orbit-shell-center", "localStart": [-2.45, 0.2, 0], "localEnd": [-2.45, 0.2, 0.45], "contactType": "overlap", "overlap": 0.03, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"radius": 0.38, "units": "relative", "confidence": 0.9}, "transform": {"position": [-2.45, 0.2, 0.45], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "node", "pivot": {"mode": "center", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.9}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "node", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0, "debrisMaterial": "crystal-navy"}}, "material": "node-orange", "materialLayers": ["node-orange"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "node-orange.alert-core", "kind": "gloss", "description": "Red-orange falloff with yellow-white core", "realization": "geometry-and-material"}], "surfaceDetail": {"macroRoughness": 0.28, "microRoughness": 0.04, "bumpAmplitude": 0.01, "normalPattern": "subtle independent procedural highlight breakup", "displacementPattern": "", "occlusionPattern": "contact AO at overlaps", "edgeWearPattern": "", "notes": "Clean illustrated logo surface; no dirt or wear."}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "reference-focused"};
  node_node_orange_8.add(mesh_node_orange_8);
  meshes["node-orange"] = mesh_node_orange_8;
  colliders["node-orange"] = {"type": "sphere", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false};
  destructionGroups["node"] ??= [];
  destructionGroups["node"].push(node_node_orange_8);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "Synthetic transparent logo art uses solid procedural layers; photographic PBR recovery is not applicable."}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createLifelineEnergyEmblemLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Lifeline Energy Emblem look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"type": "key light", "direction": [-2, 3, 4], "color": "#8fdfff", "intensity": 2.2, "note": "cool key for navy facets"}, {"type": "fill light", "direction": [3, -1, 4], "color": "#1d5b9e", "intensity": 0.8, "note": "preserve dark orbit readability"}, {"type": "rim/environment light", "direction": [0, 2, -3], "color": "#00eaff", "intensity": 1.1, "note": "cyan rear separation with contact shadow/AO at overlaps; ACES filmic tone mapping, exposure 1.15"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": false, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "Synthetic transparent logo art uses solid procedural layers; photographic PBR recovery is not applicable."}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createLifelineEnergyEmblemEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameLifelineEnergyEmblemCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createLifelineEnergyEmblemPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureLifelineEnergyEmblemRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createLifelineEnergyEmblemInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
