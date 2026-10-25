import {
  AdditiveBlending, AmbientLight, BackSide, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CylinderGeometry,
  DirectionalLight, ExtrudeGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, PCFSoftShadowMap,
  PerspectiveCamera, PMREMGenerator, Points, PointsMaterial, RepeatWrapping, Scene, ShaderMaterial, Shape, SphereGeometry, Sprite,
  SpriteMaterial, SRGBColorSpace, TorusGeometry, Vector2, Vector3, WebGLRenderer, ACESFilmicToneMapping,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// Last frame of the film: the Endurance turning in orbit above an unknown world. A cold, distant sun
// lights only a band of the planet (oceans, rock, cloud) and the rest falls into night. Everything is
// kept dim and neutral on purpose: the only warm color on screen is the name in the footer.
const SUN = new Vector3(-0.5, 0.28, -1).normalize();
const PR = 26;                                    // planet radius
const PLANET = new Vector3(0, -PR - 1.4, -6);

const planetShader = {
  vertexShader: /* glsl */ `
    varying vec3 vN, vW;
    void main() {
      vN = normalize(mat3(modelMatrix) * normal);
      vW = (modelMatrix * vec4(position, 1.)).xyz;
      gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.);
    }`,
  fragmentShader: /* glsl */ `
    uniform vec3 uSun, uCam;
    uniform float uTime, uAtmo;
    varying vec3 vN, vW;

    float hash(vec3 p) { p = fract(p * .3183099 + .1); p *= 17.; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
    float noise(vec3 x) {
      vec3 i = floor(x), f = fract(x);
      f = f * f * (3. - 2. * f);
      return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
                 mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
    }
    float fbm(vec3 p) {
      float s = 0., a = .5;
      for (int i = 0; i < 7; i++) { s += a * noise(p); p = p * 2.03 + vec3(1.7, 9.2, 3.1); a *= .5; }
      return s;
    }

    void main() {
      vec3 n = normalize(vN), v = normalize(uCam - vW);
      float ndl = dot(n, uSun);
      float facing = dot(n, v);

      if (uAtmo > 0.) {
        // halo: inside of a bigger sphere, only a thin cold edge survives outside the silhouette
        float rim = pow(1. - abs(facing), 6.);
        gl_FragColor = vec4(vec3(.42, .6, 1.) * rim * smoothstep(-.3, .6, ndl) * .7, 1.);
        return;
      }

      // surface: dark oceans, grey rock, cloud bands sheared by a slow wind
      vec3 q = n * 3.2;
      float land = smoothstep(.5, .58, fbm(q * 1.3));
      vec3 surf = mix(vec3(.012, .022, .035), vec3(.11, .105, .1) * (.6 + .8 * fbm(q * 9.)), land);
      float cl = fbm(q * 2.4 + vec3(uTime * .006, 0., 0.) + fbm(q * 5.) * 1.6);
      cl = smoothstep(.48, .78, cl);
      surf = mix(surf, vec3(.6, .63, .68), cl * .85);

      float day = smoothstep(-.06, .55, ndl);          // soft terminator
      vec3 c = surf * day * .9;
      // ocean glint, only where there is open water
      vec3 h = normalize(uSun + v);
      c += vec3(.8, .85, .9) * pow(max(dot(n, h), 0.), 90.) * (1. - land) * (1. - cl) * day * .25;
      // thin blue air seen edge-on
      c += vec3(.25, .42, .85) * pow(1. - max(facing, 0.), 3.) * smoothstep(-.2, .5, ndl) * .3;
      gl_FragColor = vec4(c, 1.);
    }`,
};

/** small cold glow for the distant sun, drawn once into a canvas */
function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!, r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(255,255,255,1)');
  r.addColorStop(0.08, 'rgba(235,242,255,.7)');
  r.addColorStop(0.3, 'rgba(170,195,255,.08)');
  r.addColorStop(1, 'rgba(150,180,255,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 128, 128);
  return new CanvasTexture(c);
}

type Mat = MeshStandardMaterial | MeshBasicMaterial;

/** paints a texture once into a canvas: hull panels, crinkled foil or solar cells */
function paint(draw: (g: CanvasRenderingContext2D, s: number) => void, color = true) {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  draw(c.getContext('2d')!, 512);
  const t = new CanvasTexture(c);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 8;
  if (color) t.colorSpace = SRGBColorSpace;
  return t;
}
const rand = (() => { let seed = 11; return () => ((seed = (seed * 16807) % 2147483647) / 2147483647); })();

const hullPanels = (g: CanvasRenderingContext2D, s: number) => {
  // panels of slightly different tone, dark seams, rivet rows, a few scuffs
  const n = 8, w = s / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const v = 150 + rand() * 30 | 0;
    g.fillStyle = `rgb(${v},${v + 2},${v + 5})`;
    g.fillRect(i * w, j * w, w, w);
    if (rand() < 0.18) { g.fillStyle = 'rgba(0,0,0,.18)'; g.fillRect(i * w + 8, j * w + 8, w * 0.4, w * 0.25); }
  }
  g.strokeStyle = 'rgba(20,22,26,.85)';
  g.lineWidth = 2;
  for (let i = 0; i <= n; i++) {
    g.beginPath(); g.moveTo(i * w, 0); g.lineTo(i * w, s); g.moveTo(0, i * w); g.lineTo(s, i * w); g.stroke();
  }
  g.fillStyle = 'rgba(30,32,36,.7)';
  for (let i = 0; i < n; i++) for (let k = 4; k < s; k += 10) {
    g.fillRect(i * w + 4, k, 2, 2);
    g.fillRect(k, i * w + 4, 2, 2);
  }
  for (let k = 0; k < 40; k++) {
    g.fillStyle = `rgba(0,0,0,${rand() * 0.08})`;
    g.beginPath(); g.arc(rand() * s, rand() * s, 10 + rand() * 50, 0, 7); g.fill();
  }
};
const crinkle = (g: CanvasRenderingContext2D, s: number) => {
  // insulation foil: hundreds of small facets catching the light at different angles
  g.fillStyle = '#808080';
  g.fillRect(0, 0, s, s);
  for (let k = 0; k < 1400; k++) {
    const x = rand() * s, y = rand() * s, r = 6 + rand() * 22, v = 60 + rand() * 140 | 0;
    g.fillStyle = `rgba(${v},${v},${v},.55)`;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rand() - 0.5) * r * 2, y + (rand() - 0.2) * r);
    g.lineTo(x + (rand() - 0.5) * r * 2, y - rand() * r);
    g.fill();
  }
};
const cells = (g: CanvasRenderingContext2D, s: number) => {
  g.fillStyle = '#0a0f18';
  g.fillRect(0, 0, s, s);
  const w = s / 16;
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) {
    const v = 14 + rand() * 10 | 0;
    g.fillStyle = `rgb(${v},${v + 6},${v + 18})`;
    g.fillRect(i * w + 1.5, j * w + 1.5, w - 3, w - 3);
  }
};

/** a strut between two points, as a thin cylinder (used for trusses and handrails) */
const strut = new CylinderGeometry(1, 1, 1, 6);
const UP = new Vector3(0, 1, 0);
function rod(a: Vector3, b: Vector3, r: number, mat: Mat) {
  const m = new Mesh(strut, mat), d = b.clone().sub(a);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.quaternion.setFromUnitVectors(UP, d.clone().normalize());
  m.scale.set(r, d.length(), r);
  return m;
}

function buildShip() {
  const hullMap = paint(hullPanels), hullBump = paint(hullPanels, false), foilBump = paint(crinkle, false);
  const hull = new MeshStandardMaterial({ map: hullMap, bumpMap: hullBump, bumpScale: 1.2, metalness: 0.35, roughness: 0.65 });
  const darkHull = hull.clone();
  darkHull.color.set(0x55595f);
  const foil = new MeshStandardMaterial({ color: 0xc9ccd2, metalness: 0.8, roughness: 0.55, bumpMap: foilBump, bumpScale: 3, roughnessMap: foilBump });
  const shield = new MeshStandardMaterial({ color: 0x141518, metalness: 0.2, roughness: 0.85, bumpMap: foilBump, bumpScale: 0.6 });
  const steel = new MeshStandardMaterial({ color: 0x8a8d92, metalness: 0.7, roughness: 0.6 });
  const glass = new MeshStandardMaterial({ color: 0x020305, metalness: 0.6, roughness: 0.2, emissive: 0x1a2230, emissiveIntensity: 0.6 });
  const solar = new MeshStandardMaterial({ map: paint(cells), metalness: 0.4, roughness: 0.5 });
  const R = 3;
  const ship = new Group(), spin = new Group();
  ship.add(spin);
  const put = (parent: Object3D, geo: BufferGeometry, mat: Mat, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) => {
    const m = new Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parent.add(m);
    return m;
  };

  // habitat module, local frame: y along the ring, x outward, z toward the camera side
  const habitat = () => {
    const g = new Group();
    put(g, new RoundedBoxGeometry(0.5, 0.92, 0.58, 4, 0.07), hull);
    put(g, new RoundedBoxGeometry(0.52, 0.34, 0.6, 3, 0.06), foil, 0, 0.18);          // insulation band
    put(g, new RoundedBoxGeometry(0.46, 0.08, 0.54, 2, 0.02), darkHull, 0, -0.34);     // structural rib
    // three port windows and a handrail on the visible face
    for (const y of [-0.22, -0.05, 0.12]) put(g, new BoxGeometry(0.1, 0.07, 0.02), glass, -0.08, y, 0.292);
    g.add(rod(new Vector3(0.14, -0.4, 0.31), new Vector3(0.14, 0.4, 0.31), 0.008, steel));
    for (const y of [-0.4, 0, 0.4]) g.add(rod(new Vector3(0.14, y, 0.29), new Vector3(0.14, y, 0.315), 0.006, steel));
    return g;
  };
  // lander docked into the ring: wedge body with a black heat shield and two engine bells
  const lander = () => {
    const g = new Group();
    const s = new Shape();
    // side profile, drawn upside down so after the turn below the roof faces outward
    s.moveTo(-0.58, 0.17); s.lineTo(-0.6, -0.05); s.lineTo(-0.52, -0.2); s.lineTo(0.38, -0.17);
    s.lineTo(0.62, -0.02); s.quadraticCurveTo(0.66, 0.12, 0.42, 0.17); s.closePath();
    const body = new ExtrudeGeometry(s, { depth: 0.5, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.05, bevelSegments: 4, curveSegments: 12 });
    body.translate(0, 0, -0.25);
    // profile lies along x: turn it so the nose points along the ring (+y) and its roof faces outward (+x)
    put(g, body, hull, 0, 0, 0, 0, 0, Math.PI / 2);
    put(g, new BoxGeometry(0.05, 0.9, 0.54), shield, -0.19, -0.04, 0);
    put(g, new BoxGeometry(0.1, 0.3, 0.03), glass, 0.1, 0.32, 0.3, 0, 0, -0.35);   // canopy
    for (const z of [-0.12, 0.12]) put(g, new CylinderGeometry(0.05, 0.085, 0.12, 20, 1, true), steel, 0, -0.66, z);
    return g;
  };
  // pressurised tunnel with stiffening rings
  const tunnel = (len: number) => {
    const g = new Group();
    put(g, new CylinderGeometry(0.1, 0.1, len, 20), hull);
    for (const y of [-len / 2 + 0.04, 0, len / 2 - 0.04]) put(g, new TorusGeometry(0.105, 0.016, 8, 24), steel, 0, y, 0, Math.PI / 2);
    return g;
  };

  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    const m = k % 3 === 0 ? lander() : habitat();
    m.position.set(c * R, s * R, 0);
    m.rotation.z = a;
    spin.add(m);
    const b = a + Math.PI / 12, t = tunnel(0.66);
    t.position.set(Math.cos(b) * R, Math.sin(b) * R, 0);
    t.rotation.z = b;
    spin.add(t);
    // triangular lattice spoke from the hub to every lander
    if (k % 3 === 0) {
      const dir = new Vector3(c, s, 0), side = new Vector3(-s, c, 0), Z = new Vector3(0, 0, 1);
      const corner = (i: number) => side.clone().multiplyScalar(Math.cos(i * 2.094) * 0.09).add(Z.clone().multiplyScalar(Math.sin(i * 2.094) * 0.09));
      const from = 0.62, to = R - 0.3, steps = 9;
      for (let i = 0; i < 3; i++) {
        spin.add(rod(dir.clone().multiplyScalar(from).add(corner(i)), dir.clone().multiplyScalar(to).add(corner(i)), 0.012, steel));
        for (let j = 0; j < steps; j++) {
          const r0 = from + ((to - from) * j) / steps, r1 = from + ((to - from) * (j + 1)) / steps;
          spin.add(rod(dir.clone().multiplyScalar(r0).add(corner(i)), dir.clone().multiplyScalar(r1).add(corner((i + 1) % 3)), 0.006, steel));
        }
      }
    }
  }

  // hub: ribbed drum on the spin axis, docking port forward, antenna and a pair of solar wings aft
  const hub = new Group();
  spin.add(hub);
  put(hub, new CylinderGeometry(0.5, 0.5, 1.1, 40), hull, 0, 0, 0, Math.PI / 2);
  for (const z of [-0.45, -0.15, 0.15, 0.45]) put(hub, new TorusGeometry(0.505, 0.022, 8, 48), steel, 0, 0, z);
  put(hub, new CylinderGeometry(0.62, 0.62, 0.16, 40), foil, 0, 0, 0, Math.PI / 2);
  put(hub, new CylinderGeometry(0.2, 0.3, 0.3, 24), darkHull, 0, 0, 0.7, Math.PI / 2);
  put(hub, new TorusGeometry(0.21, 0.03, 10, 32), steel, 0, 0, 0.86);
  put(hub, new CylinderGeometry(0.3, 0.42, 0.25, 24), darkHull, 0, 0, -0.68, Math.PI / 2);
  hub.add(rod(new Vector3(0, 0, -0.8), new Vector3(0, 0, -1.5), 0.015, steel));
  put(hub, new SphereGeometry(0.22, 24, 12, 0, Math.PI * 2, 0, 1.1), steel, 0, 0, -1.5, -Math.PI / 2); // antenna dish
  for (const sx of [-1, 1]) {
    hub.add(rod(new Vector3(0.3 * sx, 0, -0.95), new Vector3(1.05 * sx, 0, -0.95), 0.02, steel));
    put(hub, new BoxGeometry(1.4, 0.012, 0.42), solar, 1.8 * sx, 0, -0.95);
  }

  const beacon = put(spin, new SphereGeometry(0.018, 8, 8), new MeshBasicMaterial({ color: 0xffffff }), 0, 0, 0.9);
  ship.traverse((o) => { o.castShadow = o.receiveShadow = true; });
  return { ship, spin, beacon };
}

/** Resolves null when WebGL is unavailable (the footer still works on plain black). */
export function createEndurance(canvas: HTMLCanvasElement) {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  } catch {
    return null;
  }
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const scene = new Scene();
  // a faint studio reflection so bare metal reads as metal instead of black
  scene.environment = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.05;
  const camera = new PerspectiveCamera(40, 1, 0.1, 200);

  // faint stars on a far shell; the planet hides the ones behind it
  const n = 2200, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = new Vector3().randomDirection().multiplyScalar(90);
    v.z = -Math.abs(v.z);
    pos.set([v.x, v.y, v.z], i * 3);
    const b = 0.12 + Math.random() ** 4 * 0.6;
    col.set([b * 0.92, b * 0.96, b], i * 3);
  }
  const sky = new BufferGeometry();
  sky.setAttribute('position', new BufferAttribute(pos, 3));
  sky.setAttribute('color', new BufferAttribute(col, 3));
  scene.add(new Points(sky, new PointsMaterial({ size: 1.3, sizeAttenuation: false, vertexColors: true })));

  const uniforms = { uSun: { value: SUN }, uCam: { value: camera.position }, uTime: { value: 0 }, uAtmo: { value: 0 } };
  // 256 segments: the horizon is a huge arc on screen, fewer and its facets show
  const planet = new Mesh(new SphereGeometry(PR, 256, 128), new ShaderMaterial({ ...planetShader, uniforms }));
  planet.position.copy(PLANET);
  const atmo = new Mesh(new SphereGeometry(PR * 1.02, 256, 128), new ShaderMaterial({
    ...planetShader, uniforms: { ...uniforms, uAtmo: { value: 1 } },
    side: BackSide, blending: AdditiveBlending, transparent: true, depthWrite: false,
  }));
  atmo.position.copy(PLANET);
  scene.add(planet, atmo);

  const sun = new Sprite(new SpriteMaterial({ map: glowTexture(), blending: AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.8 }));
  sun.position.copy(SUN).multiplyScalar(70);
  sun.scale.setScalar(7);
  scene.add(sun);

  // cold key from the sun, a faint blue bounce off the planet from below
  const key = new DirectionalLight(0xeef3ff, 2.4);
  const bounce = new DirectionalLight(0x4a6a9a, 0.25);
  bounce.position.set(0.3, -1, 0.8);
  scene.add(key, bounce, new AmbientLight(0x8090a0, 0.05));

  const { ship, spin, beacon } = buildShip();
  ship.position.set(0, 1.9, 0);
  scene.add(ship);
  // the ship shades itself: modules cast shadows across the tunnels and spokes
  key.position.copy(ship.position).addScaledVector(SUN, 12);
  key.target = ship;
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5, near: 1, far: 25 });
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;

  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new Vector2(), 0.18, 0.5, 0.88)); // only the sun and the glint bloom
  composer.addPass(new OutputPass());

  let dist = 11;
  const resize = () => {
    const { clientWidth: w, clientHeight: h } = canvas;
    const s = Math.min(devicePixelRatio, 1.5);
    renderer.setPixelRatio(s);
    renderer.setSize(w, h, false);
    composer.setPixelRatio(s);
    composer.setSize(w, h);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
    dist = 11 + Math.max(0, 1.3 - camera.aspect) * 9; // back off on narrow screens so the ring fits
    draw(performance.now());
  };

  const mouse = new Vector2(), m = new Vector2();
  canvas.parentElement!.addEventListener('pointermove', (e) => {
    const b = canvas.getBoundingClientRect();
    mouse.set((e.clientX - b.left) / b.width - 0.5, (e.clientY - b.top) / b.height - 0.5);
  }, { passive: true });

  let target = 0, p = 0;
  const t0 = performance.now();
  function draw(now: number) {
    const t = still ? 20 : (now - t0) / 1000;
    p += (target - p) * 0.06;
    m.lerp(mouse, 0.04);
    const w = (1 - p) ** 3;                       // 1 far away → 0 settled in orbit
    camera.position.set(m.x * 1.2, 0.7 + w * 3.5 - m.y * 0.5, dist + w * 6);
    camera.lookAt(0, 0.7 + w * 1.5, 0);
    spin.rotation.z = t * 0.12;                   // about one turn every 50s
    ship.rotation.set(-1.08 + m.y * 0.15 + Math.sin(t * 0.2) * 0.03, 0.38 + m.x * 0.35, 0.12);
    ship.position.y = 1.9 + Math.sin(t * 0.35) * 0.08;
    uniforms.uTime.value = t;
    beacon.visible = t % 2.4 < 0.08;              // strobe, once every few seconds
    composer.render();
  }
  new ResizeObserver(resize).observe(canvas);

  let raf = 0, last = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    const dt = now - last;
    if (dt < 1000 / 60 - 1) return; // 60fps cap, like the other scenes
    last = now - (dt % (1000 / 60));
    draw(now);
  };
  return {
    /** 0..1: how far the footer has scrolled into view */
    progress: (v: number) => { target = v; if (still) { p = v; draw(0); } },
    start: () => { if (!raf && !still) raf = requestAnimationFrame(loop); },
    stop: () => { cancelAnimationFrame(raf); raf = 0; },
  };
}
