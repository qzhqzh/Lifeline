import fs from 'node:fs';

const specPath = new URL('./object-sculpt-spec.json', import.meta.url);
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));

const actionProfile = (role, collider = 'box') => ({
  animationRole: role,
  pivot: { mode: 'center', localPosition: [0, 0, 0], axis: [0, 1, 0], confidence: 0.9 },
  transformChannels: {
    translate: true,
    rotate: true,
    scale: true,
    bend: false,
    twist: false,
    detach: role !== 'root',
    visibility: true,
    materialState: true,
  },
  sockets: [],
  collider: { type: collider, offset: [0, 0, 0], scale: [1, 1, 1], isTrigger: false },
  constraints: [],
  destruction: {
    breakable: false,
    fractureGroup: role,
    seamRefs: [],
    detachableFragments: [],
    breakImpulse: 0,
    debrisMaterial: 'crystal-navy',
  },
});

const recipe = (dominant, secondary, materialClass = 'plastic', confidence = 0.9) => ({
  dominantAlbedo: dominant,
  secondaryAlbedo: secondary,
  materialClass,
  materialClassConfidence: confidence,
  colorGradient: {
    type: 'linear',
    stops: [
      { position: 0, color: dominant },
      { position: 1, color: secondary },
    ],
  },
});

const attachment = (parentId, start, end) => ({
  parentId,
  parentSocket: `${parentId}-center`,
  localStart: start,
  localEnd: end,
  contactType: 'overlap',
  overlap: 0.03,
  gapTolerance: 0.01,
  evidenceRefs: ['full-object'],
});

const component = ({
  id,
  name,
  level,
  role,
  primitive,
  topologyClass,
  topologyRationale,
  parent = 'root',
  material,
  dimensions,
  position = [0, 0, 0],
  localFeatures = [],
  attach = null,
  collider = 'box',
  color = ['rgba(0, 17, 47, 1)', 'rgba(0, 51, 111, 1)'],
  materialClass = 'plastic',
}) => ({
  id,
  name,
  level,
  role,
  importance: level === 'macro' ? 0.95 : 0.8,
  confidence: 0.9,
  primitive,
  topologyClass,
  topologyRationale,
  colorMaterialRecipe: recipe(color[0], color[1], materialClass),
  geometryDescriptor: {
    topologyIntent: topologyRationale,
    edgeTreatment: { type: 'bevel', bevelRadius: 0.025, segments: 3 },
    deformationStack: [],
    uvStrategy: 'generated procedural coordinates',
    normalStrategy: 'vertex normals from generated geometry',
  },
  parent,
  attachment: attach,
  dimensions: { ...dimensions, units: 'relative', confidence: 0.9 },
  transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] },
  actionProfile: actionProfile(role, collider),
  material,
  materialLayers: [material],
  deformations: [],
  joints: [],
  seams: [],
  localFeatures,
  surfaceDetail: {
    macroRoughness: material.includes('emissive') ? 0.15 : 0.28,
    microRoughness: 0.04,
    bumpAmplitude: 0.01,
    normalPattern: 'subtle independent procedural highlight breakup',
    displacementPattern: '',
    occlusionPattern: 'contact AO at overlaps',
    edgeWearPattern: '',
    notes: 'Clean illustrated logo surface; no dirt or wear.',
  },
  evidenceRefs: ['full-object'],
  details: [],
  fidelityTier: 'reference-focused',
});

spec.suitability = 'conditional';
spec.scores = {
  object_isolation: 3,
  silhouette_readability: 3,
  depth_inference: 2,
  primitive_decomposition: 3,
  material_procedurality: 3,
  occlusion_risk: 2,
  interaction_fit: 3,
};
spec.preSpecAssessment.complexity.scores = {
  silhouetteComplexity: 2,
  componentCount: 2,
  hierarchyDepth: 2,
  repetitionDensity: 1,
  materialLayerCount: 2,
  localDetailDensity: 2,
  occlusionRisk: 2,
  actionReadinessNeed: 1,
};
spec.preSpecAssessment.unknownsToResolveBeforeImplementation = [];
const detailKinds = {
  'crystal-axial-seam': 'seam',
  'crystal-facet-highlights': 'bevel',
  'central-ecg-signature': 'linework',
  'lower-ecg-signature': 'linework',
  'orbit-depth-crossing': 'contour',
  'cyan-node-cores': 'gloss',
  'orange-alert-node': 'gloss',
  'orbit-cyan-inset': 'emissive',
};
for (const detail of spec.preSpecAssessment.detailInventory.details) {
  detail.kind = detailKinds[detail.id];
}
spec.referenceCamera = {
  solved: false,
  fovDegrees: 32,
  aspect: 1,
  orientation: { yaw: 0, pitch: 0, roll: 0 },
  positionHint: [0, 0, 8],
  note: 'Near-orthographic logo view; front camera alignment is authored from the transparent canvas bounds.',
};
spec.coordinateFrame = {
  front: '+Z toward the reference camera',
  up: '+Y matching image up',
  scaleReference: 'central crystal height = 5.6 world units',
};
spec.silhouette = {
  boundingShape: 'tall faceted crystal crossed by a wide tilted elliptical orbit',
  aspectRatios: ['crystal width:height = 1:2.75', 'full emblem width:height = 1.12:1'],
  symmetry: 'crystal bilateral; orbit/node composition asymmetric',
  dominantCurves: ['elliptical orbit', 'two angular ECG polylines'],
  negativeSpaces: ['upper-left orbit opening', 'upper-right orbit-to-crystal gap'],
  landmarks: ['upper crystal tip', 'central ECG peak', 'orange left node', 'cyan upper-right node', 'cyan lower-right node', 'lower crystal tip'],
};
spec.viewEvidence = [{
  id: 'full-object',
  view: 'front-primary',
  imageRegion: { x: 0, y: 0, width: 1, height: 1, units: 'normalized' },
  observations: [
    'Transparent 1024px logo reference with unambiguous silhouette.',
    'Orbit depth ordering is visible at crystal crossings.',
    'Cyan/white emissive linework and orange alert node are identity-critical.',
  ],
  confidence: 0.96,
}];

const navy = ['rgba(0, 17, 47, 1)', 'rgba(0, 51, 111, 1)'];
const cyan = ['rgba(0, 234, 255, 1)', 'rgba(191, 252, 255, 1)'];
const whiteCyan = ['rgba(255, 255, 255, 1)', 'rgba(0, 234, 255, 1)'];
const orange = ['rgba(255, 74, 22, 1)', 'rgba(255, 245, 102, 1)'];

spec.componentTree = [
  component({
    id: 'root', name: 'Lifeline Energy Emblem', level: 'macro', role: 'root', primitive: 'box',
    topologyClass: 'assembled-solid', topologyRationale: 'Stable transform root for four independently animated visual assemblies.',
    parent: null, material: 'utility-invisible', dimensions: { width: 6.4, height: 5.8, depth: 0.7 },
    collider: 'box', color: navy,
  }),
  component({
    id: 'crystal-core', name: 'Faceted central crystal', level: 'macro', role: 'body', primitive: 'extrude',
    topologyClass: 'assembled-solid', topologyRationale: 'Reference shows a planar pointed profile with shallow faceted depth and straight perimeter edges.',
    material: 'crystal-navy', dimensions: { width: 1.8, height: 5.6, depth: 0.5 }, color: navy, materialClass: 'metal',
    localFeatures: [
      { id: 'crystal-core.axial-seam', kind: 'emissive', description: 'Continuous vertical cyan seam', realization: 'geometry' },
    ],
  }),
  component({
    id: 'crystal-highlights', name: 'Crystal facet highlight strips', level: 'meso', role: 'surface-relief', primitive: 'plane-card',
    topologyClass: 'surface-relief', topologyRationale: 'Thin raised light strips sit flush with the front facets and do not change the outer silhouette.',
    parent: 'crystal-core', material: 'energy-white', dimensions: { width: 1.2, height: 3.2, depth: 0.03 }, position: [0, 0.55, 0.28],
    color: whiteCyan, attach: attachment('crystal-core', [0, -1.5, 0.25], [0, 1.5, 0.25]),
  }),
  component({
    id: 'orbit-shell', name: 'Elliptical orbital shell', level: 'macro', role: 'connector', primitive: 'tube',
    topologyClass: 'assembled-solid', topologyRationale: 'A continuous swept tube follows the visible elliptical route around the crystal.',
    material: 'orbit-navy', dimensions: { width: 6.2, height: 2.5, depth: 0.34 }, position: [0, -0.35, 0], color: navy,
    attach: attachment('root', [-3.1, -0.2, 0], [3.1, 0.4, 0]), collider: 'tube',
    localFeatures: [{ id: 'orbit-shell.depth-route', kind: 'contour', description: 'Authored front/back depth route through crystal crossings', realization: 'geometry' }],
  }),
  component({
    id: 'orbit-energy', name: 'Cyan orbital energy inset', level: 'meso', role: 'connector', primitive: 'tube',
    topologyClass: 'surface-relief', topologyRationale: 'A thinner luminous curve follows and overlaps the inner face of the structural orbit tube.',
    parent: 'orbit-shell', material: 'energy-cyan', dimensions: { width: 5.9, height: 2.2, depth: 0.12 }, position: [0, 0.02, 0.2], color: cyan,
    attach: attachment('orbit-shell', [-2.9, -0.1, 0.15], [2.9, 0.3, 0.15]), collider: 'tube',
    localFeatures: [{ id: 'orbit-energy.inset-route', kind: 'emissive', description: 'Reference-matched cyan inner route', realization: 'geometry' }],
  }),
  component({
    id: 'signal-central', name: 'Central ECG signal', level: 'macro', role: 'connector', primitive: 'tube',
    topologyClass: 'surface-relief', topologyRationale: 'Angular tube path is raised over the crystal front and defines the emblem identity.',
    material: 'energy-white', dimensions: { width: 3.4, height: 1.15, depth: 0.12 }, position: [0, 0.08, 0.45], color: whiteCyan,
    attach: attachment('root', [-1.7, 0, 0.35], [1.7, 0, 0.35]), collider: 'tube',
    localFeatures: [{ id: 'signal-central.ecg-profile', kind: 'linework', description: 'Primary five-turn ECG profile', realization: 'geometry' }],
  }),
  component({
    id: 'signal-orbit', name: 'Lower orbit ECG signal', level: 'meso', role: 'connector', primitive: 'tube',
    topologyClass: 'surface-relief', topologyRationale: 'Compact angular tube replaces a short lower-orbit segment and remains visibly raised.',
    parent: 'orbit-shell', material: 'energy-cyan', dimensions: { width: 1.15, height: 0.9, depth: 0.1 }, position: [-0.95, -1.02, 0.48], color: cyan,
    attach: attachment('orbit-shell', [-1.45, -0.75, 0.3], [-0.35, -0.75, 0.3]), collider: 'tube',
    localFeatures: [{ id: 'signal-orbit.ecg-profile', kind: 'linework', description: 'Secondary compact ECG profile', realization: 'geometry' }],
  }),
  component({
    id: 'node-cyan-group', name: 'Cyan orbit nodes', level: 'macro', role: 'node-group', primitive: 'instanced-cluster',
    topologyClass: 'assembled-solid', topologyRationale: 'Two repeated glossy spherical sockets share geometry and material while retaining stable pivots.',
    material: 'node-cyan', dimensions: { radius: 0.38 }, color: cyan,
    localFeatures: [{ id: 'node-cyan.core-highlight', kind: 'gloss', description: 'Offset white/cyan emissive cores', realization: 'geometry-and-material' }],
  }),
  component({
    id: 'node-orange', name: 'Orange alert node', level: 'meso', role: 'node', primitive: 'sphere',
    topologyClass: 'assembled-solid', topologyRationale: 'Single glossy sphere with nested emissive core attached to the left orbit endpoint.',
    parent: 'orbit-shell', material: 'node-orange', dimensions: { radius: 0.38 }, position: [-2.45, 0.2, 0.45], color: orange,
    attach: attachment('orbit-shell', [-2.45, 0.2, 0], [-2.45, 0.2, 0.45]), collider: 'sphere',
    localFeatures: [{ id: 'node-orange.alert-core', kind: 'gloss', description: 'Red-orange falloff with yellow-white core', realization: 'geometry-and-material' }],
  }),
];

const material = ({ id, name, color, roughness, metalness = 0, emissive = '#000000', intensity = 0, overrides = [] }) => ({
  id,
  name,
  type: intensity > 0 ? 'physical-emissive' : 'physical',
  shaderModel: 'MeshPhysicalMaterial',
  qualityTier: 'utility',
  baseColor: color,
  color,
  albedo: { dominant: color, secondary: [color, '#ffffff'], samplingNotes: 'Sampled from visible solid-color logo region.' },
  colorVariation: { palette: [color, '#ffffff'], pattern: 'facet-or-radial-gradient', amplitude: 0.12, heightCorrelation: 0 },
  textureResolution: 1024,
  textureProjection: { mode: 'procedural-object-space', repeat: [1, 1], anisotropy: 1, texelDensityIntent: 'Solid vector-like material; stable in object space.' },
  surfaceFrequencyBands: [
    { id: 'macro', frequency: 1, amplitude: 0.12, role: 'broad illustrated gradient' },
    { id: 'meso', frequency: 8, amplitude: 0.03, role: 'facet highlight transition' },
    { id: 'micro', frequency: 32, amplitude: 0.01, role: 'subtle highlight breakup' },
  ],
  roughness: { base: roughness, variation: 0.04, map: 'independent-procedural-roughness-field', localResponse: 'clean logo surface' },
  metalness: { base: metalness, variation: 0 },
  normal: { pattern: 'independent-subtle-normal-field', strength: 0.04, scale: 32, space: 'tangent' },
  bump: { pattern: 'none', amplitude: 0, scale: 1 },
  displacement: { pattern: 'none', amplitude: 0, scale: 1, silhouetteAffects: false },
  ambientOcclusion: { cavityStrength: 0.18, contactShadowBias: 0.25, notes: 'Only at geometric overlaps.' },
  wear: { edgeWear: 0, scratches: [], chips: [] },
  dirt: { amount: 0, cavityBias: 0, color: '#000000' },
  localOverrides: overrides,
  emissive: { color: emissive, intensity },
  clearcoat: roughness < 0.25 ? 0.9 : 0.35,
  notes: 'Procedural solid-color material for clean illustrated logo art; no photographic texture recovery required.',
});

spec.materials = [
  material({ id: 'utility-invisible', name: 'Invisible root utility', color: '#000000', roughness: 1 }),
  material({ id: 'crystal-navy', name: 'Faceted navy crystal', color: '#00112f', roughness: 0.24, metalness: 0.3, overrides: [{ id: 'crystal-navy.facet-highlights', region: 'front side facets', color: '#bffcff', roughness: 0.12, evidenceRefs: ['full-object'] }] }),
  material({ id: 'orbit-navy', name: 'Navy orbit shell', color: '#00245f', roughness: 0.3, metalness: 0.15 }),
  material({ id: 'energy-cyan', name: 'Cyan energy', color: '#00eaff', roughness: 0.12, emissive: '#00d9ff', intensity: 3.2 }),
  material({ id: 'energy-white', name: 'White cyan energy', color: '#ffffff', roughness: 0.08, emissive: '#bffcff', intensity: 3.8 }),
  material({ id: 'node-cyan', name: 'Glossy cyan nodes', color: '#006ba8', roughness: 0.1, emissive: '#00bfe8', intensity: 1.5, overrides: [{ id: 'node-cyan.core-highlight', region: 'upper-left core', color: '#ffffff', roughness: 0.04, evidenceRefs: ['full-object'] }] }),
  material({ id: 'node-orange', name: 'Orange alert node', color: '#ff4a16', roughness: 0.1, emissive: '#ff7800', intensity: 2.4, overrides: [{ id: 'node-orange.alert-core', region: 'center core', color: '#fff566', roughness: 0.04, evidenceRefs: ['full-object'] }] }),
];

spec.repetitionSystems = [{
  id: 'cyan-orbit-node-pair',
  componentRef: 'node-cyan-group',
  realization: 'instanced-geometry',
  buildsGeometry: true,
  geometry: 'shared sphere shell and nested emissive core',
  instances: [
    { id: 'node-upper-right', position: [2.25, 1.1, 0.15], scale: 1 },
    { id: 'node-lower-right', position: [1.95, -0.7, 0.5], scale: 1 },
  ],
  variation: 'same geometry; stable individual pivots',
}];

spec.qualityContract.definitionOfDone = [
  'Front render preserves the pointed crystal, tilted orbit, two ECG signatures, three-node placement, and cyan/orange color hierarchy.',
  'Three-quarter views reveal coherent shallow depth without breaking the front logo silhouette.',
  'Every macro assembly remains a named pivot group and every identity detail maps to geometry or a material override.',
];
spec.qualityContract.minimumSpecDepth = {
  macroComponents: 5,
  mesoComponents: 4,
  microFeatureGroups: 7,
  materialLayers: 7,
  repetitionSystems: 1,
  reviewViewpoints: 3,
};
spec.qualityContract.featureGroups = [
  { id: 'crystal-silhouette', name: 'Pointed faceted crystal and axial seam', required: true, qualityCriteria: ['Tip positions, width-to-height ratio, front facets, and cyan seam match the reference.'], evidenceRefs: ['full-object'], failureModes: ['crystal reads as a box', 'axial seam is broken'] },
  { id: 'orbit-depth-route', name: 'Elliptical orbit and depth crossings', required: true, qualityCriteria: ['Orbit follows the wide tilted ellipse and preserves front/behind crossings.'], evidenceRefs: ['full-object'], failureModes: ['orbit becomes a flat ring', 'crossings reverse'] },
  { id: 'ecg-linework', name: 'Primary and secondary ECG signatures', required: true, qualityCriteria: ['Both angular profiles preserve peak/trough order and scale.'], evidenceRefs: ['full-object'], failureModes: ['generic waveform', 'lower pulse omitted'] },
  { id: 'node-system', name: 'Three glossy orbit nodes', required: true, qualityCriteria: ['Two cyan nodes and one orange node retain placement, shell, rim, and offset core.'], evidenceRefs: ['full-object'], failureModes: ['wrong node count', 'orange hierarchy lost'] },
  { id: 'emissive-lookdev', name: 'Navy, cyan, white, and orange material hierarchy', required: true, qualityCriteria: ['Emission supports line readability while navy structural surfaces remain visible.'], evidenceRefs: ['full-object'], failureModes: ['bloom erases geometry', 'materials read flat or gray'] },
];
spec.qualityContract.visualDeltaChecks = [
  'crystal tip and width-to-height silhouette delta',
  'orbit ellipse, tilt, and crossing-order delta',
  'central and lower ECG vertex-placement delta',
  'three-node position, scale, and color-role delta',
  'navy-to-cyan/orange luminance hierarchy delta',
];
spec.qualityTargets.mustMatch = [
  'pointed crystal silhouette and cyan axial seam',
  'tilted elliptical orbit with correct front/back crossings',
  'central and lower ECG profiles',
  'two cyan nodes and one orange alert node',
  'navy structure with cyan/white/orange emission hierarchy',
];
spec.qualityTargets.niceToHave = ['soft illustrated halo', 'subtle internal facet gradients'];
spec.qualityTargets.reviewViewpoints = ['front', 'three-quarter-left', 'three-quarter-right'];
spec.featureReviewTargets = [
  { id: 'crystal-silhouette', name: 'Pointed crystal silhouette and axial seam', tier: 'critical', passIds: ['blockout', 'structural-pass', 'form-refinement'], minimumScore: 0.82, mustPass: true, componentRefs: ['crystal-core', 'crystal-highlights'], evidenceRefs: ['full-object'] },
  { id: 'orbit-depth-route', name: 'Tilted orbit and front/back crossings', tier: 'critical', passIds: ['blockout', 'structural-pass', 'form-refinement'], minimumScore: 0.8, mustPass: true, componentRefs: ['orbit-shell', 'orbit-energy'], evidenceRefs: ['full-object'] },
  { id: 'ecg-linework', name: 'Two ECG signal profiles', tier: 'critical', passIds: ['structural-pass', 'form-refinement'], minimumScore: 0.82, mustPass: true, componentRefs: ['signal-central', 'signal-orbit'], evidenceRefs: ['full-object'] },
  { id: 'node-system', name: 'Three-node placement and color roles', tier: 'critical', passIds: ['structural-pass', 'material-pass'], minimumScore: 0.8, mustPass: true, componentRefs: ['node-cyan-group', 'node-orange'], evidenceRefs: ['full-object'] },
  { id: 'emissive-lookdev', name: 'Navy and emissive color hierarchy', tier: 'important', passIds: ['material-pass', 'surface-pass', 'lighting-pass'], minimumScore: 0.72, mustPass: false, componentRefs: ['crystal-core', 'orbit-energy', 'signal-central', 'node-cyan-group', 'node-orange'], evidenceRefs: ['full-object'] },
];
spec.lookDevTargets.materialPass.referencePbrExtraction.requiredWhenSourceImagePresent = false;
spec.lookDevTargets.materialPass.referencePbrExtraction.acceptedLimitation = 'Synthetic transparent logo art uses solid procedural layers; photographic PBR recovery is not applicable.';
spec.lightingFromPhoto = [
  { type: 'key light', direction: [-2, 3, 4], color: '#8fdfff', intensity: 2.2, note: 'cool key for navy facets' },
  { type: 'fill light', direction: [3, -1, 4], color: '#1d5b9e', intensity: 0.8, note: 'preserve dark orbit readability' },
  { type: 'rim/environment light', direction: [0, 2, -3], color: '#00eaff', intensity: 1.1, note: 'cyan rear separation with contact shadow/AO at overlaps; ACES filmic tone mapping, exposure 1.15' },
];
spec.proceduralStrategy = [
  'Extrude the crystal from an authored pointed profile and layer shallow facet meshes.',
  'Sweep separate navy and cyan tubes along authored elliptical routes with explicit Z-depth crossings.',
  'Build ECG signals as tube geometry along fixed angular paths.',
  'Reuse node shell/core geometry for the cyan pair and author the orange alert variant separately.',
  'Use emissive materials plus selective bloom while keeping transparent background and 60 FPS target.',
];
spec.animationAnchors = ['root rotation pivot', 'independent orbit pivot', 'three node pulse pivots', 'energy material-state channels'];
spec.destructionAnchors = ['crystal-core detachable group', 'orbit-shell detachable group', 'node socket groups'];
spec.risks = [
  'Single reference does not define back-face bevels; back geometry mirrors the front at reduced detail.',
  'Illustrated glow must be approximated without washing out navy structural surfaces.',
  'Orbit depth ordering must remain correct under the front reference camera.',
];
spec.assumptions = [
  'Back-face bevels mirror the visible front at reduced detail.',
  'Orbit depth crossings use authored shallow Z offsets inferred from visible overlaps.',
  'Emission and halo radius approximate illustrated glow rather than measured luminance.',
];
spec.performanceBudget = {
  qualityPriority: 'reference-fidelity',
  targetTriangles: 45000,
  maxDrawCalls: 36,
  textureSize: 1024,
  fpsTarget: 60,
  optimizationPolicy: 'Preserve silhouette and emissive linework; instance the cyan node pair and reuse materials.',
};

for (const pass of spec.buildPasses) {
  pass.componentRefs = spec.componentTree.map((item) => item.id);
}

fs.writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
