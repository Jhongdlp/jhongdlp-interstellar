import {
  AdditiveBlending, BoxGeometry, Color, Fog, InstancedMesh, MeshBasicMaterial, Object3D, PerspectiveCamera, Scene,
  Vector2, WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// The tesseract: a lattice of cells whose every edge is a bundle of thin glowing strands, running
// along all three axes into the fog. The central cell is scaled to the screen's aspect so its front
// frame lands exactly on the bento (78% of the viewport), and the camera glides in through the cells.
const S = 4;            // cell size
const N = 4;            // cells each way from the center
const STRANDS = 7;      // strands per edge
const FOV = 50;
const END_Z = S / 2 + S / 2 / (0.78 * Math.tan((FOV / 2) * Math.PI / 180)); // front frame fills 78% of the height

const PALETTE = ['#f3d9b1', '#f3d9b1', '#f3d9b1', '#c48a4c', '#8a6a48', '#9fb0b0'];

/** Resolves null when WebGL is unavailable (the bento still works on plain black). */
export function createTesseract(canvas: HTMLCanvasElement) {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  const scene = new Scene();
  scene.fog = new Fog(0x000000, 6, 30);
  const camera = new PerspectiveCamera(FOV, 1, 0.1, 80);
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // deterministic random so the lattice is the same every visit
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const L = 2 * N * S + 12;
  const edges = Array.from({ length: 2 * N }, (_, k) => (k - N + 0.5) * S);
  const count = 3 * edges.length ** 2 * STRANDS;
  const mesh = new InstancedMesh(
    new BoxGeometry(1, 1, 1),
    new MeshBasicMaterial({ blending: AdditiveBlending, depthWrite: false, transparent: true }),
    count,
  );
  const o = new Object3D(), c = new Color();
  let i = 0;
  for (let axis = 0; axis < 3; axis++) {
    for (const a of edges) for (const b of edges) {
      for (let s = 0; s < STRANDS; s++) {
        // strands spread mostly in one direction, so each edge reads as a flat ribbon of slats
        const spread = (rnd() - 0.5) * 0.45, jitter = (rnd() - 0.5) * 0.05;
        const t = 0.006 + rnd() ** 3 * 0.035;
        const p = [a + spread, b + jitter];
        if (axis === 0) { o.position.set(0, p[0], p[1]); o.scale.set(L, t, t); }
        if (axis === 1) { o.position.set(p[0], 0, p[1]); o.scale.set(t, L, t); }
        if (axis === 2) { o.position.set(p[0], p[1], 0); o.scale.set(t, t, L); }
        o.updateMatrix();
        mesh.setMatrixAt(i, o.matrix);
        mesh.setColorAt(i++, c.set(PALETTE[(rnd() * PALETTE.length) | 0]).multiplyScalar(0.08 + rnd() ** 2 * 0.5));
      }
    }
  }
  scene.add(mesh);

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new Vector2(), 0.35, 0.6, 0.2));
  composer.addPass(new OutputPass());

  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    const s = 0.5; // the canvas is CSS-blurred 3px anyway: half res + no MSAA looks the same, ~4-9x fewer pixels
    renderer.setPixelRatio(s);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(s);
    composer.setSize(w, h);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    mesh.scale.x = camera.aspect; // cells match the screen, so the front frame matches the bento
    draw();
  };

  const mouse = new Vector2(), m = new Vector2();
  addEventListener('pointermove', (e) => mouse.set(e.clientX / innerWidth - 0.5, e.clientY / innerHeight - 0.5), { passive: true });

  let target = 0, p = 0, raf = 0;
  const ease = (x: number) => 1 - (1 - x) ** 3;
  function draw(time = 0) {
    p += (target - p) * 0.08;
    m.lerp(mouse, 0.05);
    const e = ease(p), w = 1 - e, t = still ? 0 : time / 1000;
    // glide in through the cells, banking out of a slight roll, then settle facing the bento
    camera.position.set(
      w * 1.6 + Math.sin(t * 0.21) * 0.08 + m.x * 0.5,
      -w * 1.1 + Math.cos(t * 0.17) * 0.06 - m.y * 0.35,
      END_Z + w * S * 3.5,
    );
    camera.lookAt(m.x * 0.6, -m.y * 0.4, -S * 4);
    camera.rotateZ(w * 0.45);
    composer.render();
  }
  new ResizeObserver(resize).observe(canvas);

  // the room is fully clipped until p > 0.1 (Gallery.astro --o): nothing to draw before that.
  // 60fps while the camera glides or the mouse moves; once settled only the slow drift is left
  // (<1px a frame, under a 3px CSS blur), so 24fps looks the same and every skipped frame also
  // spares the compositor the full-screen blur + screen blend
  let last = 0;
  const loop = (time: number) => {
    raf = requestAnimationFrame(loop);
    const settled = Math.abs(target - p) < 1e-3 && m.distanceToSquared(mouse) < 1e-6;
    const step = 1000 / (settled ? 24 : 60);
    const dt = time - last;
    if (target <= 0.1 || dt < step - 1) return;
    last = time - (dt % step); // keep the remainder: 144Hz averages 60fps, not 48
    draw(time);
  };
  return {
    /** 0..1: how far into the tesseract the camera has come */
    progress: (v: number) => { target = v; if (still) { p = v; draw(); } },
    start: () => { if (!raf && !still) raf = requestAnimationFrame(loop); },
    stop: () => { cancelAnimationFrame(raf); raf = 0; },
  };
}
