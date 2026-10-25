import {
  ACESFilmicToneMapping, Mesh, OrthographicCamera, PlaneGeometry, Scene, ShaderMaterial, Vector2, WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import fragmentShader from '../shaders/blackhole.frag?raw';

const vertexShader = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`;

const MAX_PIXELS = 1.2e6;   // raymarch cost scales with pixels: cap it so 1440p/4K cost the same as 1080p
const FRAME_MS = 1000 / 60;  // cap at 60fps: 144Hz screens would otherwise render 2.4x the work

/** Raymarched black hole. Resolves null when WebGL is unavailable (CSS fallback stays visible). */
export async function createBlackHole(canvas: HTMLCanvasElement, onFrame?: (seconds: number) => void) {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const uniforms = {
    uRes: { value: new Vector2() },
    uTime: { value: 0 },
    uMouse: { value: new Vector2() },
    uShot: { value: 0 },
    uFall: { value: 0 },
  };
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  scene.add(new Mesh(new PlaneGeometry(2, 2), new ShaderMaterial({ uniforms, vertexShader, fragmentShader })));

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new Vector2(), 0.6, 0.6, 0.75));
  composer.addPass(new OutputPass());

  let dirty = true;
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    const budget = Math.sqrt(MAX_PIXELS / Math.max(w * h, 1));
    const s = Math.min(Math.min(devicePixelRatio, 1.5) * 0.75, budget);
    renderer.setPixelRatio(s);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(s);
    composer.setSize(w, h);
    uniforms.uRes.value.set(w * s, h * s);
    dirty = true;
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const mouse = new Vector2();
  let fall = 0;
  let shot = 0; // scroll target of the about shot; the camera eases toward it so wheel steps feel like a dolly
  addEventListener('pointermove', (e) => mouse.set((e.clientX / innerWidth) * 2 - 1, -((e.clientY / innerHeight) * 2 - 1)));

  // compile off the main thread (KHR_parallel_shader_compile) so the big shader doesn't freeze the page
  await renderer.compileAsync(scene, camera).catch(() => {});
  // first frame now (also compiles the bloom passes), so the canvas is never blank once .ready is set
  composer.render();

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const t0 = performance.now();
  let last = 0;
  const frame = (now: number) => {
    const dt = now - last;
    if (dt < FRAME_MS - 1) return;
    last = now - (dt % FRAME_MS);

    uniforms.uMouse.value.lerp(mouse, 0.03);
    const s = uniforms.uShot;
    s.value += (shot - s.value) * 0.07;
    if (Math.abs(shot - s.value) > 1e-4) dirty = true;
    const f = uniforms.uFall;
    f.value += (fall - f.value) * 0.07;
    if (f.value > 0.995) return; // inside the hole: the last frame is already black, stop paying for it
    // reduced motion: time is frozen, so only redraw when the mouse parallax or size changes
    if (reduceMotion && !dirty && uniforms.uMouse.value.distanceToSquared(mouse) < 1e-8) return;
    dirty = false;
    const t = (performance.now() - t0) / 1000;
    uniforms.uTime.value = reduceMotion ? 0 : t;
    composer.render();
    onFrame?.(t);
  };

  return {
    start: () => { last = 0; dirty = true; renderer.setAnimationLoop(frame); },
    stop: () => renderer.setAnimationLoop(null),
    /** 0..1: camera move from the hero framing to the person (scroll-driven, eased per frame). */
    shot: (v: number) => { shot = v; },
    /** 0..1: fall into the hole (scroll-driven, eased per frame). */
    fall: (v: number) => { fall = v; },
  };
}
