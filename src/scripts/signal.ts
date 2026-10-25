import {
  AdditiveBlending, BufferAttribute, BufferGeometry, Plane, PerspectiveCamera, Points, Raycaster, Scene, ShaderMaterial,
  Vector2, Vector3, WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Murph's room: dust falls under gravity and settles on the floor. Each band of floor is one bit of the
// visitor's last 8 typed characters: where the bit is 1 the dust gathers into a line, like in the film.
// On send the dust lifts into a spiral and leaves as a single point of light.
export const BITS = 32; // 4 characters: wide bands that read as lines
const W = 26, D = 16, H = 9;

const vertexShader = /* glsl */ `
uniform float uTime, uBits[${BITS}], uSend, uPulse, uPR;
uniform vec3 uMouse;
attribute vec4 aR;
varying float vGlow, vFade, vBeam;

void main() {
  float band = floor(aR.x * ${BITS}.);
  float bit = uBits[int(band)];
  float t = uTime;

  // life cycle: fall for the first 55%, then rest on the floor
  float life = fract(aR.w + t * (0.025 + aR.z * 0.02));
  float fall = clamp(life / 0.55, 0., 1.);
  float y = ${H}. * (1. - fall) * (1. - fall * 0.15);
  float air = y / ${H}.;

  vec3 p = vec3((aR.x - .5) * ${W}., y, (aR.y - .5) * ${D}.);
  // drifting in the air, like dust in a sunbeam
  p.x += sin(t * .6 + aR.y * 40.) * .5 * air;
  p.z += cos(t * .5 + aR.x * 30.) * .4 * air;

  // gravity sorts the landed dust into the band's center line
  float bw = ${W}. / ${BITS}.;
  float center = ((band + .5) / ${BITS}. - .5) * ${W}.;
  float pull = bit * smoothstep(.5, 0., air);
  p.x = mix(p.x, center + (aR.z - .5) * bw * .28, pull);

  // a keystroke is a gravity wave through the floor
  float r = length(p.xz);
  p.y += uPulse * .35 * sin(r * 2.2 - t * 9.) * exp(-r * .12) * (1. - air);

  // the cursor is a small well that pushes dust aside
  vec2 dm = p.xz - uMouse.xz;
  float md = length(dm);
  p.xz += normalize(dm + 1e-4) * 1.4 * exp(-md * md * .6);

  // send: lift into a spiral and collapse to one point above the floor
  float s = smoothstep(aR.w * .45, aR.w * .45 + .55, uSend);
  float a = atan(p.z, p.x) + s * 6.28 * (1.5 + aR.z);
  float rad = mix(r, 0., s * s);
  vec3 vortex = vec3(cos(a) * rad, mix(p.y, 6.5, s), sin(a) * rad);
  p = mix(p, vortex, s);

  vec4 mv = modelViewMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * mv;
  // sunbeam from the window, in screen space so it lines up with .beam in Contact.astro (same polygon)
  vec2 uv = gl_Position.xy / gl_Position.w * .5 + .5;
  uv.y = 1. - uv.y;
  float bl = mix(.22, .42, uv.y), br = mix(.36, .70, uv.y);
  vBeam = smoothstep(bl - .03, bl + .05, uv.x) * smoothstep(br + .03, br - .05, uv.x);
  // dust only catches the light inside the beam, and some motes glint as they turn
  float glint = pow(.5 + .5 * sin(t * (1.5 + aR.z * 3.) + aR.w * 90.), 8.);
  vGlow = .1 + pull * 1.3 + s * 1.4 + vBeam * (.35 + air * .9 + glint * 1.4);
  vFade = 1. - smoothstep(.92, 1., uSend);
  gl_PointSize = (.8 + aR.z * 1.4 + pull * .7) * uPR * (24. / -mv.z);
}`;

const fragmentShader = /* glsl */ `
varying float vGlow, vFade, vBeam;
void main() {
  float d = length(gl_PointCoord - .5);
  float a = smoothstep(.5, 0., d);
  vec3 c = mix(vec3(.95, .85, .69), vec3(1., .6, .24), clamp(vGlow - .9, 0., 1.));
  c = mix(c, vec3(1., .86, .62), vBeam * .6); // warm sunlight
  gl_FragColor = vec4(c * vGlow * a * vFade, 1.);
}`;

/** Resolves null when WebGL is unavailable (the form still works on plain black). */
export function createSignal(canvas: HTMLCanvasElement) {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const count = innerWidth < 700 ? 12000 : 24000;

  const r = new Float32Array(count * 4);
  for (let i = 0; i < r.length; i++) r[i] = Math.random();
  const geo = new BufferGeometry();
  geo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3)); // unused, sets the draw count
  geo.setAttribute('aR', new BufferAttribute(r, 4));

  const bits = new Array(BITS).fill(0), target = new Array(BITS).fill(0);
  const uniforms = {
    uTime: { value: 0 }, uBits: { value: bits }, uSend: { value: 0 }, uPulse: { value: 0 },
    uPR: { value: 1 }, uMouse: { value: new Vector3(0, 0, 99) },
  };
  const dust = new Points(geo, new ShaderMaterial({
    uniforms, vertexShader, fragmentShader, blending: AdditiveBlending, depthWrite: false, transparent: true,
  }));
  dust.frustumCulled = false; // positions live in the shader
  const scene = new Scene();
  scene.add(dust);
  const camera = new PerspectiveCamera(42, 1, 0.1, 80);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new Vector2(), 0.45, 0.5, 0.2));
  composer.addPass(new OutputPass());

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    const s = Math.min(devicePixelRatio, 1.5);
    renderer.setPixelRatio(s);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(s);
    composer.setSize(w, h);
    uniforms.uPR.value = s;
    camera.aspect = w / Math.max(h, 1);
    // pull back on tall screens so the whole floor stays in frame
    camera.position.set(0, 10, 13 / Math.min(camera.aspect, 1.4) + 4);
    camera.lookAt(0, 0, -1);
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  // cursor onto the floor plane
  const ray = new Raycaster(), floor = new Plane(new Vector3(0, 1, 0), 0), ndc = new Vector2();
  canvas.parentElement!.addEventListener('pointermove', (e) => {
    const b = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    ray.ray.intersectPlane(floor, uniforms.uMouse.value);
  }, { passive: true });

  let send = 0, raf = 0, last = 0;
  const t0 = performance.now();
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = now - last;
    if (dt < 1000 / 60 - 1) return; // 60fps cap, like the other scenes
    last = now - (dt % (1000 / 60));
    for (let i = 0; i < BITS; i++) bits[i] += (target[i] - bits[i]) * 0.06;
    uniforms.uPulse.value *= 0.94;
    uniforms.uSend.value += (send - uniforms.uSend.value) * (send ? 0.018 : 0.04);
    uniforms.uTime.value = still ? 40 : (now - t0) / 1000;
    composer.render();
  };

  return {
    /** the bit pattern of the text being typed (length BITS, 0/1) */
    write(next: number[]) { next.forEach((b, i) => (target[i] = b)); uniforms.uPulse.value = 1; },
    /** 1 = lift the dust and transmit, 0 = let it fall again */
    send(v: number) { send = v; },
    start() { if (!raf) raf = requestAnimationFrame(loop); },
    stop() { cancelAnimationFrame(raf); raf = 0; },
  };
}
