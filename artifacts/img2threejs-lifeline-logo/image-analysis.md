# Lifeline Logo — Reference Image Analysis

## Identification

- Work type: stylized technology/health emblem, `primaryDomain: object`, confidence `0.98`.
- Visible inventory: one faceted vertical crystal, one elliptical orbital band, two ECG polylines, three spherical nodes, cyan/white edge-light accents, and one orange status light.

## Overall form and silhouette

- The central body is a bilaterally symmetric extruded hexagonal spear/crystal profile, approximately `1:2.75` width-to-height.
- A tilted elliptical tube wraps in front of and behind the crystal. The composition is asymmetric because the orbital nodes and open upper-left segment are unevenly distributed.
- The reference is a near-orthographic front presentation with shallow perspective cues rather than a physically calibrated camera view.

## Component hierarchy

- `logoRoot`
  - `crystalAssembly`: front faceted body, shallow rear volume, cyan axial seam, white/cyan side highlights.
  - `orbitAssembly`: dark outer tube, cyan inner energy tube, three node sockets.
  - `signalAssembly`: central ECG stroke crossing the crystal and lower ECG stroke following the orbit.
  - `nodeAssembly`: upper-right cyan node, lower-right cyan node, left orange node.

## Spatial relationships

- `<orbitAssembly, wraps-around, crystalAssembly>` with front/behind depth crossings.
- `<signalAssembly, overlays, crystalAssembly+orbitAssembly>` as shallow raised emissive tubes.
- `<nodeAssembly, socketed-on, orbitAssembly>`; each sphere overlaps a local tube joint rather than floating.
- `<crystalAssembly, intersects-at-center, signalAssembly>` with the axial cyan seam continuous above and below the central pulse.

## Materials and finish

- Crystal: opaque, dark navy dielectric/painted-metal appearance; low-to-medium roughness with faceted cyan specular accents.
- Orbit shell: opaque navy, medium roughness; cyan inset is emissive and semi-gloss.
- ECG strokes: opaque white/cyan emissive tubes with bloom-like halos baked into the reference.
- Nodes: glossy dielectric spheres with dark-blue rims; cyan nodes use white/cyan emissive cores, while the left node uses orange/red emissive layers.

## Color recipe

- Background/negative space: transparent.
- Structural low values: near-black navy `#00112f` to deep blue `#00336f`.
- Energy accents: cyan `#00eaff`, pale cyan `#bffcff`, and white `#ffffff`.
- Alert node: red-orange `#ff4a16`, amber `#ff9b00`, yellow-white core `#fff566`.

## Identity-defining features

1. Tall pointed crystal silhouette with a continuous cyan axial seam.
2. Central ECG polyline with one narrow downstroke and a taller central spike.
3. Elliptical orbital band crossing in front at the lower half and returning behind at the upper-right.
4. Three glossy nodes at left, upper-right, and lower-right; only the left node is orange.
5. Secondary ECG pulse embedded in the lower orbital path.
6. Alternating cyan and white vertical facet highlights on the crystal.

## Uncertainty

- The back face, exact crystal thickness, and hidden orbit crossings are not visible; they will use symmetric shallow depth and explicit front/back offsets.
- Glow radius is illustration-driven rather than physically measured; it will be approximated with emissive materials and additive sprites/duplicate shells.
- The original is a logo, not a photograph of a manufactured object, so reconstruction targets front-view identity and interactive parallax rather than hidden-side realism.
