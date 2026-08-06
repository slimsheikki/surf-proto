/**
 * The NPR material factory — every lit surface and every VFX quad is built
 * here so the cel look is one decision, not twelve.
 *
 * Approach (see the plan): keep Three's `MeshStandardMaterial` /
 * `MeshBasicMaterial` — with all their colour / map / vertex-colour / emissive /
 * fog / light plumbing intact — and inject GLSL through a *single shared*
 * `onBeforeCompile`. Three keys its program cache partly on
 * `onBeforeCompile.toString()`, so hundreds of per-instance enemy materials that
 * all run this one function compile **one** program and differ only by uniforms.
 * That is the whole performance story: per-instance materials, shared shader.
 *
 * What the injection does, gated by `uNprEnabled` (runtime) and `#define`s
 * (per-variant, compile-time):
 *   - quantize the directional N·L into hard bands via the `uToonRamp` texture,
 *   - lift shadows with a hemisphere + ambient floor (never pure black),
 *   - add a Fresnel rim (characters only, `NPR_RIM`),
 *   - optional retro post: Bayer screen-door alpha, colour quantize, UV wobble,
 *     vertex snap — all default-off through the retro uniforms.
 */

import {
  MeshBasicMaterial,
  MeshStandardMaterial,
  type MeshBasicMaterialParameters,
  type MeshStandardMaterialParameters,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { nprUniforms } from './NprUniforms';
import { NPR_BANDS, toonRamp } from './ToonRamp';

// Band ramp exists before the first frame; shared app-wide.
nprUniforms.uToonRamp.value = toonRamp(NPR_BANDS);

// ------------------------------------------------------------ GLSL fragments

const VERT_HEADER = /* glsl */ `
uniform float uVertexWobble;
uniform float uSnap;
`;

const PROJECT_VERTEX_NPR = /* glsl */ `
#include <project_vertex>
#ifdef NPR_VERT
if ( uVertexWobble > 0.5 ) {
  vec4 nprPos = gl_Position;
  nprPos.xyz /= nprPos.w;
  nprPos.xy = floor( nprPos.xy * uSnap ) / uSnap;
  nprPos.xyz *= nprPos.w;
  gl_Position = nprPos;
}
#endif
`;

const FRAG_HEADER = /* glsl */ `
uniform float uNprEnabled;
uniform sampler2D uToonRamp;
uniform vec3 uRimColor;
uniform float uRimPower;
uniform float uRimStrength;
uniform float uDither;
uniform float uQuantize;
uniform float uAffine;
uniform float uAffineAmp;
float nprBayer2( vec2 a ) { a = floor( a ); return fract( a.x * 0.5 + a.y * a.y * 0.75 ); }
float nprBayer( vec2 p ) { return nprBayer2( p * 0.5 ) * 0.25 + nprBayer2( p ); }
`;

// Recompute the diffuse term as banded Lambert + hemisphere floor, killing the
// PBR specular. `material.diffuseColor` already carries base × map × vertexColor.
const LIGHTS_END_NPR = /* glsl */ `
#include <lights_fragment_end>
#ifdef NPR_LIT
if ( uNprEnabled > 0.5 ) {
  vec3 nprAlbedo = material.diffuseColor;
  vec3 nprDirect = vec3( 0.0 );
  // Temporaries are hoisted out of the loop: Three unrolls the loop body in
  // place with no per-iteration scope, so a local declared inside would be a
  // redefinition once unrolled (this is why the stock light loops declare
  // their temporaries above the loop too).
  float nprNdL;
  float nprLit;
  #if ( NUM_DIR_LIGHTS > 0 )
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
      nprNdL = clamp( dot( geometryNormal, directionalLights[ i ].direction ), 0.0, 1.0 );
      nprLit = texture2D( uToonRamp, vec2( nprNdL, 0.5 ) ).r;
      nprDirect += directionalLights[ i ].color * nprLit;
    }
    #pragma unroll_loop_end
  #endif
  vec3 nprIndirect = ambientLightColor;
  #if ( NUM_HEMI_LIGHTS > 0 )
    #pragma unroll_loop_start
    for ( int i = 0; i < NUM_HEMI_LIGHTS; i ++ ) {
      nprIndirect += getHemisphereLightIrradiance( hemisphereLights[ i ], geometryNormal );
    }
    #pragma unroll_loop_end
  #endif
  reflectedLight.directDiffuse = nprAlbedo * nprDirect;
  reflectedLight.indirectDiffuse = nprAlbedo * nprIndirect;
  reflectedLight.directSpecular = vec3( 0.0 );
  reflectedLight.indirectSpecular = vec3( 0.0 );
  #ifdef NPR_RIM
  float nprFres = pow( 1.0 - clamp( dot( geometryNormal, geometryViewDir ), 0.0, 1.0 ), uRimPower );
  totalEmissiveRadiance += uRimColor * nprFres * uRimStrength;
  #endif
}
#endif
`;

const MAP_FRAGMENT_NPR = /* glsl */ `
#ifdef USE_MAP
  vec2 nprUv = vMapUv;
  #ifdef NPR_AFFINE
  if ( uAffine > 0.5 ) {
    vec2 nprCell = floor( vMapUv * 64.0 );
    nprUv += ( vec2(
      fract( sin( dot( nprCell, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ),
      fract( sin( dot( nprCell, vec2( 39.346, 11.135 ) ) ) * 24634.6345 )
    ) - 0.5 ) * uAffineAmp;
  }
  #endif
  diffuseColor *= texture2D( map, nprUv );
#endif
`;

const DITHER_NPR = /* glsl */ `
#include <dithering_fragment>
#ifdef NPR_POST
if ( uQuantize > 1.5 ) {
  gl_FragColor.rgb = floor( gl_FragColor.rgb * uQuantize + 0.5 ) / uQuantize;
}
if ( uDither > 0.5 ) {
  float nprT = nprBayer( gl_FragCoord.xy );
  if ( gl_FragColor.a < nprT ) discard;
  gl_FragColor.a = 1.0;
}
#endif
`;

// One shared function so every material's `onBeforeCompile.toString()` is
// identical → programs share the Three cache. Do not capture per-material state.
function nprOnBeforeCompile(shader: WebGLProgramParametersWithUniforms): void {
  shader.uniforms.uNprEnabled = nprUniforms.uNprEnabled;
  shader.uniforms.uToonRamp = nprUniforms.uToonRamp;
  shader.uniforms.uRimColor = nprUniforms.uRimColor;
  shader.uniforms.uRimPower = nprUniforms.uRimPower;
  shader.uniforms.uRimStrength = nprUniforms.uRimStrength;
  shader.uniforms.uDither = nprUniforms.uDither;
  shader.uniforms.uQuantize = nprUniforms.uQuantize;
  shader.uniforms.uAffine = nprUniforms.uAffine;
  shader.uniforms.uAffineAmp = nprUniforms.uAffineAmp;
  shader.uniforms.uVertexWobble = nprUniforms.uVertexWobble;
  shader.uniforms.uSnap = nprUniforms.uSnap;

  shader.vertexShader = VERT_HEADER + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', PROJECT_VERTEX_NPR);

  shader.fragmentShader = FRAG_HEADER + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <lights_fragment_end>',
    LIGHTS_END_NPR,
  );
  shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', MAP_FRAGMENT_NPR);
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <dithering_fragment>',
    DITHER_NPR,
  );
}

// ------------------------------------------------------------ variants

export type NprVariant = 'env' | 'character' | 'pickup' | 'vfx';

const VARIANT_DEFINES: Record<NprVariant, Record<string, string>> = {
  env: { NPR_LIT: '', NPR_VERT: '', NPR_POST: '', NPR_AFFINE: '' },
  character: { NPR_LIT: '', NPR_RIM: '', NPR_VERT: '', NPR_POST: '' },
  pickup: { NPR_LIT: '', NPR_POST: '' },
  vfx: { NPR_POST: '' },
};

/**
 * Attach the shared toon injection + the variant's defines to an
 * already-constructed material. Exposed for the handful of call sites that must
 * build their own material (e.g. `RampTexture` mutates `.map`/`.color` in place)
 * yet still want the NPR shading.
 */
export function patchToon(
  material: MeshStandardMaterial | MeshBasicMaterial,
  variant: NprVariant,
): void {
  material.defines = { ...(material.defines ?? {}), ...VARIANT_DEFINES[variant] };
  material.onBeforeCompile = nprOnBeforeCompile;
}

/** Lit environment surfaces (ramps, islands, platforms). Vertex colours + map ok. */
export function envMaterial(params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ metalness: 0, roughness: 1, ...params });
  patchToon(material, 'env');
  return material;
}

/** Characters — player, enemies, boss. Adds the Fresnel rim. */
export function characterMaterial(
  params: MeshStandardMaterialParameters = {},
): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ metalness: 0, roughness: 1, ...params });
  patchToon(material, 'character');
  return material;
}

/** Emissive-dominant pickups — XP orbs, shrine rings, boss projectiles. */
export function pickupMaterial(params: MeshStandardMaterialParameters = {}): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ metalness: 0, roughness: 1, ...params });
  patchToon(material, 'pickup');
  return material;
}

/** Unlit VFX quads/shells. Blending is the caller's choice (preserved). */
export function vfxMaterial(params: MeshBasicMaterialParameters = {}): MeshBasicMaterial {
  const material = new MeshBasicMaterial(params);
  patchToon(material, 'vfx');
  return material;
}
