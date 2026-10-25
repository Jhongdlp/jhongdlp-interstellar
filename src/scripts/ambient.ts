import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Color, Mesh, PerspectiveCamera, PlaneGeometry, Points, Scene,
  ShaderMaterial, Vector2, WebGLRenderer,
} from 'three';

// The room behind the projects, lit only by the screen: the active project's color spills as a soft light
// behind it and onto the floor, a slow haze drifts, and sparse dust hangs at different depths so the track
// has parallax. Film grain and a vignette keep the black from looking flat.

const FRAME_MS = 1000 / 60;

const roomFrag = /* glsl */ `
uniform vec2 uRes;
uniform float uTime, uOn, uK;
uniform vec3 uTint;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + 1.), f.x), f.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (gl_FragCoord.xy - .5 * uRes) / uRes.y;

  // the screen's light: a wide soft halo behind it, a thin pool on the floor under it
  vec2 q = p * vec2(.55, 1.15);
  vec3 col = uTint * exp(-dot(q, q) * 3.2) * .13;
  float floorY = p.y + .4;
  col += uTint * exp(-floorY * floorY * 140.) * exp(-p.x * p.x * 1.6) * .06;

  // haze: two octaves of slow noise, moving with the track so it reads as volume
  vec2 h = p * 1.3 + vec2(uK * .22 + uTime * .012, uTime * .006);
  float fog = noise(h) * .65 + noise(h * 2.3 + 4.) * .35;
  col += mix(vec3(.96, .89, .78), uTint, .35) * smoothstep(.35, 1., fog) * .035;

  col *= uOn;
  // vignette, then grain (applied after so the black itself has texture)
  col *= 1. - dot(uv - .5, uv - .5) * 1.6;
  col += (hash(gl_FragCoord.xy + fract(uTime * 7.) * 91.) - .5) * .022 * (.35 + uOn);
  gl_FragColor = vec4(max(col, 0.), 1.);
}`;

const dustVert = /* glsl */ `
uniform float uTime, uPR, uOn;
attribute float aR;
varying float vA;
void main() {
  vec3 p = position;
  p.x += cos(uTime * .09 + aR * 20.) * .4;
  p.y += sin(uTime * .13 + aR * 30.) * .4;
  vec4 mv = modelViewMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * mv;
  float twinkle = .6 + .4 * sin(uTime * (.5 + aR * 1.4) + aR * 60.);
  vA = uOn * twinkle * (.2 + .8 * aR) * smoothstep(-42., -12., mv.z);
  gl_PointSize = max((1. + aR * aR * 2.6) * uPR * (13. / -mv.z), 1.);
}`;

const dustFrag = /* glsl */ `
uniform vec3 uColor;
varying float vA;
void main() {
  float a = smoothstep(.5, 0., length(gl_PointCoord - .5));
  gl_FragColor = vec4(uColor * a * vA, 1.);
}`;

/** tints: one CSS color per project. Resolves null without WebGL (the stage just stays black). */
export function createAmbient(canvas: HTMLCanvasElement, tints: string[]) {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power' });
  } catch {
    return null;
  }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const colors = tints.map((t) => new Color(t));
  const tint = new Color(), cream = new Color('#f6e4c6');

  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.z = 10;

  const room = { uRes: { value: new Vector2() }, uTime: { value: 0 }, uOn: { value: 0 }, uK: { value: 0 }, uTint: { value: tint } };
  const quad = new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({
    uniforms: room, fragmentShader: roomFrag, depthTest: false, depthWrite: false,
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0., 1.); }',
  }));
  quad.frustumCulled = false;
  quad.renderOrder = -1;
  scene.add(quad);

  // dust in a long box that covers the whole track (the camera slides along x with it)
  const count = innerWidth < 700 ? 600 : 1300;
  const pos = new Float32Array(count * 3), rnd = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = Math.random() * 110 - 45;
    pos[i * 3 + 1] = Math.random() * 36 - 18;
    pos[i * 3 + 2] = Math.random() * 36 - 32;
    rnd[i] = Math.random();
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(pos, 3));
  geo.setAttribute('aR', new BufferAttribute(rnd, 1));
  const dustColor = new Color();
  const dust = { uTime: room.uTime, uOn: room.uOn, uPR: { value: 1 }, uColor: { value: dustColor } };
  const points = new Points(geo, new ShaderMaterial({
    uniforms: dust, vertexShader: dustVert, fragmentShader: dustFrag,
    blending: AdditiveBlending, depthWrite: false, transparent: true,
  }));
  points.frustumCulled = false;
  scene.add(points);

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    const s = Math.min(devicePixelRatio, 1.5);
    renderer.setPixelRatio(s);
    renderer.setSize(w, h, false);
    room.uRes.value.set(w * s, h * s);
    dust.uPR.value = s;
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  let k = 0, on = 0, last = 0, drawnOff = false;
  const t0 = performance.now();
  const frame = (now: number) => {
    const dt = now - last;
    if (dt < FRAME_MS - 1) return;
    last = now - (dt % FRAME_MS);
    if (on < 0.002) { if (drawnOff) return; drawnOff = true; } else drawnOff = false;

    const i = Math.min(Math.floor(k), colors.length - 1);
    tint.copy(colors[i]).lerp(colors[Math.min(i + 1, colors.length - 1)], k - i);
    dustColor.copy(cream).lerp(tint, 0.3);
    room.uK.value = k;
    room.uOn.value = on;
    room.uTime.value = still ? 30 : (now - t0) / 1000;
    camera.position.x = k * 3.2;
    camera.position.y = Math.sin(room.uTime.value * 0.1) * 0.25; // a slow breath, like a handheld camera at rest
    renderer.render(scene, camera);
  };

  return {
    /** k: position on the track (0..n-1), on: 0..1 how lit the room is (follows the screen power-on) */
    set(nk: number, non: number) { k = nk; on = non; },
    start: () => { last = 0; drawnOff = false; renderer.setAnimationLoop(frame); },
    stop: () => renderer.setAnimationLoop(null),
  };
}
