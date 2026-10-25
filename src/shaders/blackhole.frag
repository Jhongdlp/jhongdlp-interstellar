precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform vec2 uMouse;
uniform float uShot;   // 0..1 scroll: push in from the hero framing to the person, then drift aside
uniform float uFall;   // 0..1 scroll: after the about, the lens swings to the hole and falls in (ends black)
varying vec2 vUv;

#define HORIZON -.25    // ground line in uv (height units)
#define CENTER_Y -.225  // where the hole sits on screen
#define PITCH 0.085      // camera height over the disk plane (radians)
#define ROLL 0.11       // diagonal tilt of the view
#define RS 1.0          // Schwarzschild radius
#define DISK_IN 1.8
#define DISK_OUT 22.0
#define TAU 6.2831853
#define EYE 1.15        // foreground eye height over the field (meters)
#define PARALLAX 0.25    // how far the foreground camera slides with the mouse (meters)
float gF;               // foreground focal length
float gTx;              // foreground camera sideways offset: near things shift more (parallax)
float gZ = 1.;          // lens zoom of the about shot (1 = hero framing)

// ---------- noise ----------
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

// value noise periodic in y (period P cells) so the disk has no seam where atan wraps
float noiseP(vec2 p, float P) {
  vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
  float y0 = mod(i.y, P), y1 = mod(i.y + 1., P);
  return mix(mix(hash(vec2(i.x, y0)), hash(vec2(i.x + 1., y0)), f.x),
             mix(hash(vec2(i.x, y1)), hash(vec2(i.x + 1., y1)), f.x), f.y);
}
float fbmP(vec2 p, float P) { float a = .5, s = 0.; for (int i = 0; i < 4; i++) { s += a * noiseP(p, P); p *= 2.; P *= 2.; a *= .5; } return s; }
float noise(vec2 p) { return noiseP(p, 1e6); }
float fbm(vec2 p) { return fbmP(p, 1e6); }

// pattern-free hash for film grain (the cheap hash above shows stripes on pixel-aligned input)
float grain(vec2 p) { vec3 q = fract(p.xyx * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }

// ---------- sky ----------
vec3 stars(vec3 d) {
  vec3 g = d * 220.;                 // 3D grid: round dots, no stretching near the poles
  vec3 id = floor(g);
  float s = smoothstep(.99, 1., hash(id.xy + id.z * 17.31)) * smoothstep(.4 / gZ, 0., length(fract(g) - .5));
  return vec3(1., .88, .7) * s * (.3 + .9 * hash(id.yz + 7.));
}

// ---------- accretion disk ----------
// One layer of gas, sampled 'age' seconds after it was laid down. Keplerian shear winds any pattern
// into ever-finer rings (and aliasing), so diskColor cross-fades two short-lived layers instead.
vec4 gasLayer(vec2 xz, float r, float age, float seed, float sharp) {
  float spin = age * 2.2 / (r * sqrt(r));                    // Keplerian: inner gas laps the outer gas
  float a = fract((atan(xz.y, xz.x) - spin) / TAU);       // pattern advances with the gas (+angle)
  float rn = r + seed;                                     // fresh noise every cycle: no visible loop

  float broad = fbmP(vec2(rn * 1.4, a * 12.), 12.);        // clumps / hot spots you can watch orbit
  float fil = fbmP(vec2(rn * 4. + broad * 3., a * 6.), 6.);
  // gas lanes: short arcs, not full rings, so the rotation reads (a full ring spinning looks static)
  float streak = .6 * noiseP(vec2(rn * 16. + broad * 4., a * 24.), 24.)
               + .4 * mix(.5, noiseP(vec2(rn * 30. + broad * 6., a * 40.), 40.), sharp);

  // dust sparkles riding the same orbit
  float c = cos(spin), s = sin(spin);
  vec2 q = mat2(c, -s, s, c) * xz * 7. + seed;
  float spark = step(.985, hash(floor(q))) * smoothstep(.35, 0., length(fract(q) - .5));
  return vec4(broad, fil, streak, spark);
}

// Emission where a ray crosses the disk plane. nv = ray direction at the hit.
vec3 diskColor(vec3 p, vec3 nv) {
  float r = length(p.xz);
  if (r < DISK_IN || r > DISK_OUT) return vec3(0);

  // fine lanes fade out where the disk is seen edge-on: there they shrink below a pixel and sparkle
  float sharp = smoothstep(.04, .2, abs(nv.y));
  #define CYCLE 7.   // seconds a gas layer lives; shorter = less winding, more visible cross-fade
  float ph = uTime / CYCLE, f = fract(ph);
  // seeds wrap so they stay small: unbounded seeds lose float precision and the disk turns to static
  vec4 g = mix(gasLayer(p.xz, r, f * CYCLE, mod(floor(ph), 64.) * 13.7, sharp),
               gasLayer(p.xz, r, fract(ph + .5) * CYCLE, mod(floor(ph + .5), 64.) * 13.7 + 5.3, sharp),
               abs(2. * f - 1.));
  float broad = g.x, fil = g.y, streak = g.z, spark = g.w;

  float t = (r - DISK_IN) / (DISK_OUT - DISK_IN);
  float fall = exp(-t * 4.) * smoothstep(0., .015, t);   // hot inner edge, long soft fade

  vec3 hot = vec3(1., .68, .32), warm = vec3(1., .32, .04), cold = vec3(.42, .06, .0);
  vec3 col = mix(hot, warm, smoothstep(0., .1, t));
  col = mix(col, cold, smoothstep(.1, .55, t));

  // relativistic beaming: gas coming at us is brighter and whiter, the receding side dimmer and redder
  float beta = .35 * sqrt(.5 / (r - RS));                  // orbital speed (softened from the true ~.8c)
  float dg = sqrt(1. - beta * beta) / (1. - beta * dot(normalize(vec3(-p.z, 0., p.x)), -nv));
  vec3 dop = dg * dg * dg * pow(vec3(dg), vec3(0., .6, 1.2));
  float slab = clamp(.06 / abs(nv.y), 1., 8.);             // edge-on = longer path = brighter line

  return col * (fall * (.55 + .45 * broad) * (.7 + .5 * fil) * (.25 + 1.3 * streak * streak) * 1.35 * slab + spark * .5 * (1. - t) * (1. - t)) * dop;
}

// ---------- wheat field ----------
// Far field: golden texture with wind waves rolling across it.
vec3 fieldBase(vec2 uv) {
  float dy = HORIZON - uv.y;
  uv.x += gTx * dy / EYE;
  float depth = .1 / dy;
  float wave = fbm(vec2(uv.x * depth * 1.2 - uTime * .25, depth * .9));       // gusts sweeping the wheat
  float rows = .55 + .45 * fbm(vec2(uv.x * depth * 3., depth * 12.));
  // vertical stalk grain, faded to its average when a stalk gets thinner than ~2 px (else it aliases into static)
  float stalkAA = smoothstep(2., 4., uRes.y * gZ / 900.);
  float stalks = mix(.8, noise(vec2(uv.x * 900., uv.y * 40.)) * .4 + .6, stalkAA);
  float under = exp(-uv.x * uv.x * 1.6);                                       // brightest under the hole
  float lit = exp(-dy * 9.) * (.35 + .9 * under) + exp(-dy * 60.) * .6;
  vec3 gold = mix(vec3(.55, .2, .04), vec3(1., .55, .18), wave);
  return gold * lit * rows * stalks * (.6 + .8 * wave) + vec3(.02, .008, .002) * rows;
}

// Near field: layers of individual stalks in perspective, swaying, backlit by the disk.
vec3 wheat(vec2 uv, vec3 col, float occZ, float occCover) {
  float px = 1. / (uRes.y * gZ);
  for (int i = 0; i < 26; i++) {
    float t = float(i) / 25.;
    float d = 3. * pow(.09, t);              // depth: far -> near
    float off = .1 / d;
    float yb = HORIZON - off;                // where this row meets the ground
    float H = off * .78;                     // stalk height on screen (eye just above the wheat)
    if (uv.y < yb || uv.y > yb + H * 1.2) continue;
    float spacing = .0024 / d;
    if (spacing < 2.5 * px) continue;         // too fine to resolve: fieldBase covers it
    float light = mix(.3, 1., exp(-uv.x * uv.x * 1.6)) * mix(1., .12, t);
    float xs = (uv.x + gTx * off / EYE) / spacing + float(i) * 17.3;
    for (int j = -1; j <= 1; j++) {
      float cid = floor(xs) + float(j);
      vec3 r = vec3(hash(vec2(cid, float(i))), hash(vec2(cid + 3.1, float(i))), hash(vec2(cid + 7.7, float(i))));
      float h = H * (.7 + .45 * r.y);
      float q = (uv.y - yb) / h;             // 0 at ground, 1 at the tip
      if (q < 0. || q > 1.05) continue;
      float sway = (sin(uTime * 1.3 + cid * .21 + float(i)) * .6 + sin(uTime * .5 + uv.x * 3.) * .8) * .9;
      float bx = cid + .5 + (r.x - .5) * .7 + (sway + (r.z - .5) * 1.5) * q * q;
      float dist = abs(xs - bx) * spacing;
      float stemW = spacing * .05 + px * .35;
      float stem = (1. - smoothstep(stemW - px, stemW + px, dist)) * step(q, .8);
      vec2 e = vec2(dist / (spacing * .16 + px * .6), (q - .9) / .11);
      float head = 1. - smoothstep(.8, 1.1, length(e));
      // backlit: dark stems, translucent heads glowing gold, brighter toward the tip
      vec3 stemCol = vec3(.012, .005, .002) + vec3(1., .42, .1) * light * .12 * q;
      // rim of light on the upper edge of each head, the rest stays in shadow
      float tip = smoothstep(.85, 1., q + (r.y - .5) * .1);
      vec3 headCol = vec3(1., .5, .14) * light * (.15 + .95 * tip) * (.7 + .6 * r.z) + vec3(.02, .008, .003);
      float behind = EYE * gF / off > occZ ? 1. - occCover : 1.;   // row is farther than the truck
      col = mix(col, stemCol, stem * behind);
      col = mix(col, headCol, head * behind);
    }
  }
  return col;
}

// ---------- pickup truck (3D, raymarched SDF) ----------
// Foreground world: eye 1.7 m above the field, ground horizon on HORIZON. Units are meters.
#define TRUCK_DIST 42.
#define TRUCK_YAW -0.35   // negative turns the nose toward the camera

vec3 gTruckPos;

float sdBox3(vec3 p, vec3 b) { vec3 d = abs(p) - b; return length(max(d, 0.)) + min(max(d.x, max(d.y, d.z)), 0.); }
float sdRBox(vec3 p, vec3 b, float r) { return sdBox3(p, b - r) - r; }
float sdCylZ(vec3 p, float r, float h) { vec2 d = abs(vec2(length(p.xy), p.z)) - vec2(r, h); return min(max(d.x, d.y), 0.) + length(max(d, 0.)); }

// local frame: x = forward, y = up, z = across; origin on the ground under the truck's middle
float tires(vec3 p) {
  vec3 q = vec3(p.x, p.y - .38, abs(p.z) - .8);
  return min(sdCylZ(q - vec3(1.6, 0., 0.), .36, .12), sdCylZ(q - vec3(-1.55, 0., 0.), .36, .12)) - .03;
}
float cabSDF(vec3 p) {
  float cab = sdRBox(p - vec3(.35, 1.45, 0.), vec3(.62, .42, .86), .17);
  return max(cab, dot(vec2(p.x - .95, p.y - 1.05), normalize(vec2(1., .45))));   // raked windshield
}
float bodySDF(vec3 p) {
  float lower = sdRBox(p - vec3(-.05, .8, 0.), vec3(2.55, .28, .9), .07);
  float hood = max(sdRBox(p - vec3(1.75, 1.03, 0.), vec3(.78, .12, .86), .1), p.y - 1.15 + (p.x - 1.) * .06);   // hood slopes to the grille
  float fender = sdRBox(p - vec3(1.6, .92, 0.), vec3(.66, .22, .94), .12);
  float bed = max(sdRBox(p - vec3(-1.5, .97, 0.), vec3(1.1, .25, .9), .04), -sdBox3(p - vec3(-1.5, 1.15, 0.), vec3(1.03, .25, .83)));
  float arch = min(sdCylZ(vec3(p.x - 1.6, p.y - .38, p.z), .47, 1.2), sdCylZ(vec3(p.x + 1.55, p.y - .38, p.z), .47, 1.2));
  float bump = min(sdRBox(p - vec3(2.58, .55, 0.), vec3(.06, .08, .95), .03), sdRBox(p - vec3(-2.62, .55, 0.), vec3(.05, .07, .93), .03));
  float mirror = sdBox3(vec3(p.x - .95, p.y - 1.42, abs(p.z) - .98), vec3(.04, .07, .06));
  return min(min(max(min(min(lower, hood), min(fender, bed)), -arch), bump), mirror);
}
// ---------- person leaning on the tailgate, watching the hole (backlit: reads as a silhouette) ----------
float sdCap(vec3 p, vec3 a, vec3 b, float ra, float rb) {
  vec3 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  return length(pa - ba * h) - mix(ra, rb, h);
}
float sdEll(vec3 p, vec3 r) { float k0 = length(p / r), k1 = length(p / (r * r)); return k0 * (k0 - 1.) / k1; }
float smin(float a, float b, float k) { float h = clamp(.5 + .5 * (b - a) / k, 0., 1.); return mix(b, a, h) - k * h * (1. - h); }

// wide-brim hat: the protagonist's signature shape. q is the person's frame; tipped back with the head
float hatSDF(vec3 q) {
  q -= vec3(.005, 1.725, .005);
  float c = cos(.1), s = sin(.1);
  q.yz = mat2(c, s, -s, c) * q.yz;                                   // front brim lifts as they look up
  float rr = length(q.xz);
  // brim: thin, sides rolled up, front and back dipped (cattleman), soft rounded edge
  float brim = max(abs(q.y - 1.3 * q.x * q.x + .3 * q.z * q.z) - .005, rr - .155) - .002;
  // crown: oval, slightly tapered, with the long crease on top and two pinches at the front
  float oval = (length(q.xz / vec2(.078, .094)) - 1. + q.y * .6) * .085;
  float crown = max(oval, abs(q.y - .05) - .05) - .004;
  crown = max(crown, -sdEll(q - vec3(0., .108, -.01), vec3(.02, .028, .068)));
  crown = max(crown, -sdEll(vec3(abs(q.x), q.yz) - vec3(.064, .078, .064), vec3(.022, .032, .028)));
  float band = max(oval - .004, abs(q.y - .016) - .014);              // hatband: a thin ridge the rim light catches
  return min(min(brim, crown), band);
}

#define PERSON_POS vec2(-3.15, -1.01)   // truck-local x/z of the feet: behind the near rear corner
#define LEAN .1                         // body tilt toward the truck (radians)
float personSDF(vec3 p) {
  p.xz -= PERSON_POS;
  // x = toward the truck, z = facing the black hole
  vec3 q = vec3(dot(p.xz, vec2(.94, .34)), p.y, dot(p.xz, vec2(-.34, .94)));
  float bnd = max(length(q.xz - vec2(.2, .05)) - .6, abs(q.y - .95) - 1.);
  if (bnd > .1) return bnd;
  float c = cos(LEAN), s = sin(LEAN);
  q.xy = vec2(q.x * c - q.y * s, q.x * s + q.y * c);

  // legs: weight on the outer leg, the other crossed over at the ankle
  float d = sdCap(q, vec3(-.09, .93, 0.), vec3(-.1, .5, .02), .08, .055);
  d = min(d, sdCap(q, vec3(-.1, .5, .02), vec3(-.09, .09, 0.), .05, .035));
  d = min(d, sdCap(q, vec3(.09, .93, 0.), vec3(.04, .5, .07), .08, .055));
  d = min(d, sdCap(q, vec3(.04, .5, .07), vec3(-.16, .1, .07), .05, .035));
  d = min(d, sdCap(q, vec3(-.09, .05, -.04), vec3(-.09, .04, .17), .045, .035));   // shoes
  d = min(d, sdCap(q, vec3(-.16, .05, .03), vec3(-.2, .04, .23), .045, .035));
  // torso
  float t = sdEll(q - vec3(0., .95, 0.), vec3(.17, .11, .11));
  t = smin(t, sdEll(q - vec3(0., 1.13, 0.), vec3(.15, .14, .1)), .05);
  t = smin(t, sdEll(q - vec3(0., 1.31, -.01), vec3(.19, .16, .115)), .05);
  t = smin(t, sdCap(q, vec3(-.18, 1.42, -.01), vec3(.18, 1.44, -.01), .06, .06), .05);
  t = smin(t, sdCap(q, vec3(0., 1.44, 0.), vec3(.005, 1.57, .015), .05, .045), .03);    // neck
  t = smin(t, sdEll(q - vec3(0., .9, 0.), vec3(.2, .09, .14)), .04);                  // jacket hem, flared at the hips
  t = smin(t, sdCap(q, vec3(-.07, 1.5, -.03), vec3(.07, 1.5, -.03), .045, .045), .03);  // turned-up collar
  d = smin(d, t, .04);
  d = min(d, hatSDF(q));
  // head tipped up toward the sky, with hair
  float hd = sdEll(q - vec3(.005, 1.665, .02), vec3(.08, .105, .095));
  hd = smin(hd, sdEll(q - vec3(.005, 1.6, .085), vec3(.045, .045, .04)), .03);           // jaw/chin
  hd = smin(hd, sdEll(q - vec3(.005, 1.69, -.01), vec3(.088, .095, .095)), .02);         // hair
  d = min(d, hd);
  // truck-side arm: elbow on the tailgate, forearm along it
  d = smin(d, sdCap(q, vec3(.18, 1.43, -.01), vec3(.5, 1.28, .03), .05, .04), .03);
  d = min(d, sdCap(q, vec3(.5, 1.28, .03), vec3(.59, 1.3, .27), .04, .03));
  d = min(d, sdEll(q - vec3(.61, 1.3, .33), vec3(.035, .025, .06)));
  // other arm: hand in the pocket
  d = smin(d, sdCap(q, vec3(-.18, 1.42, -.01), vec3(-.25, 1.15, -.04), .05, .04), .03);
  d = min(d, sdCap(q, vec3(-.25, 1.15, -.04), vec3(-.17, .95, .05), .04, .035));
  return d * .9;   // the lean/tapers bend the field a bit: step conservatively
}

// a slab along segment a->b in the yz plane, half-width w across x, half-thickness r
float slab(vec3 p, vec2 a, vec2 b, float w, float r) {
  vec2 pa = p.yz - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0., 1.);
  return max(length(pa - ba * h) - r, abs(p.x) - w);
}

// second person, on a beach chair to the first one's left, same view
#define CHAIR_POS vec2(-4.25, -1.45)
float sitterSDF(vec3 p) {
  p.xz -= CHAIR_POS;
  vec3 q = vec3(dot(p.xz, vec2(.94, .34)), p.y, dot(p.xz, vec2(-.34, .94)));
  float bnd = max(length(q.xz - vec2(0., .05)) - .75, abs(q.y - .55) - .6);
  if (bnd > .1) return bnd;
  vec3 m = vec3(abs(q.x), q.yz);   // mirrored for symmetric chair parts

  // chair: sagging seat, reclined back, armrests, tube legs
  float d = slab(q, vec2(.3, .15), vec2(.22, -.3), .26, .015);
  d = min(d, slab(q, vec2(.22, -.3), vec2(.9, -.62), .26, .015));
  d = min(d, sdCap(m, vec3(.28, .42, -.32), vec3(.28, .42, .12), .02, .02));
  d = min(d, sdCap(m, vec3(.28, 0., .18), vec3(.28, .42, .12), .015, .015));
  d = min(d, sdCap(m, vec3(.28, 0., -.45), vec3(.28, .92, -.63), .015, .015));
  // legs: one bent, one stretched out
  d = min(d, sdCap(q, vec3(-.09, .34, -.15), vec3(-.1, .47, .25), .08, .055));
  d = min(d, sdCap(q, vec3(-.1, .47, .25), vec3(-.11, .08, .38), .05, .035));
  d = min(d, sdCap(q, vec3(.09, .34, -.15), vec3(.11, .3, .3), .08, .055));
  d = min(d, sdCap(q, vec3(.11, .3, .3), vec3(.13, .08, .66), .05, .035));
  d = min(d, sdCap(q, vec3(-.11, .04, .36), vec3(-.11, .04, .55), .045, .035));
  d = min(d, sdCap(q, vec3(.13, .06, .64), vec3(.14, .14, .8), .045, .035));
  // reclined torso
  float t = sdEll(q - vec3(0., .34, -.17), vec3(.17, .11, .12));
  t = smin(t, sdEll(q - vec3(0., .5, -.27), vec3(.15, .14, .1)), .05);
  t = smin(t, sdEll(q - vec3(0., .68, -.36), vec3(.19, .16, .115)), .05);
  t = smin(t, sdCap(q, vec3(-.18, .8, -.42), vec3(.18, .8, -.42), .06, .06), .05);
  t = smin(t, sdCap(q, vec3(0., .82, -.42), vec3(0., .93, -.43), .05, .045), .03);
  d = smin(d, t, .03);
  // head resting back, face up at the hole
  float hd = sdEll(q - vec3(0., 1.01, -.44), vec3(.08, .105, .095));
  hd = smin(hd, sdEll(q - vec3(0., .97, -.36), vec3(.045, .045, .04)), .03);
  hd = smin(hd, sdEll(q - vec3(0., 1.04, -.47), vec3(.09, .1, .1)), .02);
  d = min(d, hd);
  // arms on the armrests
  d = smin(d, sdCap(m, vec3(.18, .79, -.42), vec3(.26, .5, -.28), .05, .04), .03);
  d = min(d, sdCap(m, vec3(.26, .5, -.28), vec3(.27, .47, .02), .04, .03));
  return d * .9;
}

float truckSDF(vec3 p) { return min(min(min(bodySDF(p), cabSDF(p)), tires(p)), min(personSDF(p), sitterSDF(p))); }

vec3 toTruck(vec3 p) {
  p -= gTruckPos;
  float c = cos(TRUCK_YAW), s = sin(TRUCK_YAW);
  p.xz = mat2(c, -s, s, c) * p.xz;
  return p;
}
vec3 truckNormal(vec3 p) {
  vec2 e = vec2(.004, -.004);
  return normalize(e.xyy * truckSDF(p + e.xyy) + e.yyx * truckSDF(p + e.yyx) + e.yxy * truckSDF(p + e.yxy) + e.xxx * truckSDF(p + e.xxx));
}

// what the shiny surfaces reflect: the disk glow behind, dark sky above, golden field below
vec3 env(vec3 r, vec3 L) {
  vec3 c = vec3(1., .5, .15) * (pow(max(dot(r, L), 0.), 6.) * 2.5 + exp(-abs(r.y) * 12.) * .8);
  return c + (r.y < 0. ? vec3(.35, .15, .04) * .4 : vec3(.03, .015, .008));
}

// returns the shaded truck color in .rgb and its coverage in .a; outputs hit distance
vec4 truck(vec3 rd, out float hitZ) {
  hitZ = 1e9;
  vec3 ro = vec3(gTx, EYE, 0.);
  vec3 oc = ro - (gTruckPos + vec3(0., 1., 0.));
  float b = dot(oc, rd), h = b * b - dot(oc, oc) + 30.25;     // bounding sphere r = 5.5 m (truck + people)
  if (h < 0.) return vec4(0);
  float t = -b - sqrt(h), tEnd = -b + sqrt(h);
  float pxw = t * 1.5 / (uRes.y * gF * gZ);
  float minD = 1e5, hitT = -1.;
  for (int i = 0; i < 80; i++) {
    float d = truckSDF(toTruck(ro + rd * t));
    minD = min(minD, d);
    if (d < pxw * .25) { hitT = t; break; }
    t += d * .9;
    if (t > tEnd) break;
  }
  float cover = hitT > 0. ? 1. : 1. - smoothstep(0., pxw, minD);
  if (cover <= 0.) return vec4(0);
  if (hitT < 0.) hitT = t;
  hitZ = (ro + rd * hitT).z;

  vec3 p = toTruck(ro + rd * hitT);
  vec3 n = truckNormal(p);
  float c = cos(-TRUCK_YAW), s = sin(-TRUCK_YAW);
  vec3 nw = vec3(mat2(c, -s, s, c) * n.xz, n.y).xzy;          // normal back to world space

  vec3 L = normalize(vec3(-.35, .25, 1.));                     // the black hole, behind the truck
  float key = max(dot(nw, L), 0.);
  float ndv = max(dot(nw, -rd), 0.);
  float fres = .04 + .96 * pow(1. - ndv, 5.);
  vec3 refl = env(reflect(rd, nw), L);
  vec3 diffuse = vec3(1., .5, .16) * (key * .9 + pow(1. - ndv, 3.) * key * 2.)
               + vec3(.6, .28, .1) * .1 * (.5 + .5 * nw.y)
               + vec3(1., .5, .15) * .35 * pow(max(nw.y, 0.), 2.) * (.3 + .7 * key);   // roof and hood catch the glow

  vec3 col;
  float dTire = tires(p), dCab = cabSDF(p);
  float dMe = personSDF(p);
  if (min(dMe, sitterSDF(p)) < .01) {
    // backlit by the disk: dark body with soft wrap-around shading and a warm rim on the side edges
    // backlit by the disk: near-black body, thin golden rim where the edges face the light
    float rim = pow(1. - ndv, 2.5) * max(dot(nw, L) + .35, 0.);
    col = vec3(.005, .004, .003) + vec3(1., .5, .15) * rim * (dMe < .01 ? 1.25 : .8);
  } else if (dTire < .01) {
    vec3 hub = vec3(p.x - (p.x > 0. ? 1.6 : -1.55), p.y - .38, 0.);
    col = length(hub.xy) < .17 && abs(p.z) > .85 ? refl * .8 : vec3(.012) * diffuse + refl * fres * .3;
  } else if (dCab < .01 && p.y > 1.17 && p.y < 1.78 && p.x > -.2 && (abs(p.z) < .8 || p.x < .82)) {
    col = vec3(.008, .006, .005) + refl * (.25 + fres);        // glass
  } else if (p.x > 2.5 && p.y > .52 && p.y < .62 || p.x < -2.55 && p.y < .62) {
    col = refl * .9;                                           // chrome bumpers
  } else if (p.x > 2.4 && p.y > .78 && p.y < .98 && abs(p.z) > .5 && abs(p.z) < .8) {
    col = vec3(1., .85, .6) * 4.;                              // headlights on
  } else if (p.x < -2.5 && p.y > .82 && p.y < 1.05 && abs(p.z) > .72) {
    col = vec3(.12, .01, .005) + refl * fres * .3;              // tail lights off: just red plastic
  } else {
    vec3 paint = vec3(.1, .13, .15) * (.85 + .15 * noise(p.xy * 20.));   // dusty steel-blue paint
    col = paint * diffuse + refl * fres * .6;
  }
  col = mix(col, vec3(.5, .2, .06) * .2, .06);                 // light atmospheric haze
  return vec4(col, cover);
}

// ---------- geodesic raymarch ----------
vec3 blackHole(vec3 ro, vec3 rd) {
  vec3 p = ro, v = rd;
  float h2 = dot(cross(p, v), cross(p, v));
  vec3 col = vec3(0);
  float T = 1.;
  for (int i = 0; i < 260; i++) {
    float r = length(p);
    if (r < RS) { T = 0.; break; }
    if (r > DISK_OUT && dot(p, v) > 0.) break;   // outbound past the disk: nothing left to hit
    float dt = clamp(.08 * (r - RS * .9), .012, 1.2);
    vec3 pp = p;
    float r2 = r * r;
    v += -1.5 * h2 * p / (r2 * r2 * r) * dt;   // photon geodesic in Schwarzschild metric
    p += v * dt;
    if (pp.y * p.y < 0.) {                  // crossed the disk plane
      vec3 d = diskColor(mix(pp, p, pp.y / (pp.y - p.y)), normalize(v));
      col += T * d;
      T *= 1. - clamp(dot(d, vec3(.33)) * .5, 0., .9);
      if (T < .01) break;
    }
  }
  return col + T * stars(normalize(v));
}

// ---------- the about shot ----------
// From the hero framing, a long lens pushes in on the person at the tailgate, then drifts so they sit on a
// third and leave room for the text. Only focal length and lens shift change, so field, truck and sky
// magnify together like a real telephoto (no perspective breaks).
vec2 shot(vec2 uv, float aspect) {
  if (uShot <= 0.) return uv;
  float c = cos(TRUCK_YAW), s = sin(TRUCK_YAW);
  vec3 w = gTruckPos + vec3(mat2(c, s, -s, c) * PERSON_POS, 0.).xzy;   // the person's feet, world space
  bool wide = aspect > 1.;
  float frameH = wide ? 2.4 : 4.;                                      // meters of world in screen height
  vec2 P = vec2(w.x, HORIZON * w.z / gF + 1. - EYE) * gF / w.z;         // their middle (1 m up) on screen
  float a = smoothstep(0., .65, uShot), b = smoothstep(.5, .88, uShot); // push in, then drift aside
  gZ = pow(w.z / (frameH * gF) / 1.13, a) * mix(1., 1.13, b);           // starts at 1: the hero frame
  vec2 Q = mix(mix(P, vec2(0.), a), wide ? vec2(-.31 * aspect, -.02) : vec2(0., .2), b); // where they sit on screen
  vec2 A = P - Q / gZ;                                                  // world uv at the screen center
  if (uFall > 0.) {                                                     // lens back to wide, hole centered
    float l = smoothstep(0., .3, uFall);
    A = mix(A, vec2(0., CENTER_Y), l);
    gZ = exp(mix(log(gZ), 0., l));
  }
  return A + uv / gZ;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 uv0 = (vUv - .5) * vec2(aspect, 1.);

  float zoom = max(1., 1.05 * uRes.y / uRes.x);   // portrait screens: pull back so the whole arc fits
  gF = 1.75 / zoom;
  gTruckPos = vec3(-.25 * aspect * TRUCK_DIST / gF, 0., TRUCK_DIST);

  vec2 uv = shot(uv0, aspect);
  vec2 m = uMouse * .05 / gZ;              // mouse parallax stays the same size on screen when zoomed
  gTx = uMouse.x * PARALLAX / gZ;
  vec3 col = vec3(0);

  // the fall, like a ship: tilt up off the field, pull back until all of Gargantua fits, then dive in
  // banking and swinging around it until the camera crosses the horizon (everything goes black)
  float lift = smoothstep(0., .35, uFall), dive = smoothstep(.3, 1., uFall);
  vec2 fuv = uv + vec2(0., lift * 1.3 / gZ); // the field drops out of the bottom of the frame (in screen units)
  float D = mix(mix(14., 27., smoothstep(0., .4, uFall)), .3, pow(dive, 2.4));
  float roll = ROLL + dive * dive * .9;

  // camera a little above the disk, rolled for a diagonal, cinematic view
  float yaw = .15 + m.x + dive * dive * 1.6, pitch = PITCH + .22 * lift * (1. - dive) + m.y * .25;
  vec3 ro = vec3(sin(yaw) * cos(pitch), sin(pitch), -cos(yaw) * cos(pitch)) * D;
  vec3 fw = normalize(-ro), rt = normalize(cross(vec3(0, 1, 0), fw)), up = cross(fw, rt);
  vec2 suv = mat2(cos(roll), sin(roll), -sin(roll), cos(roll)) * vec2(uv.x, uv.y - CENTER_Y) * zoom;
  vec3 rd = normalize(fw * 1.75 + rt * suv.x + up * suv.y);

  // foreground camera (field + truck) shares the horizon with the black hole view
  vec3 frd = normalize(vec3(fuv.x, fuv.y - HORIZON, gF));
  float tz = 1e9;
  vec4 tr = lift < .999 ? truck(frd, tz) : vec4(0);

  float hy = fuv.y - HORIZON;
  if (tr.a < 1.) {                          // fully covered by the truck: skip the background
    if (hy < 0.) {
      col = fieldBase(fuv);
    } else {
      col = blackHole(ro, rd);
      // golden atmospheric haze low in the sky (lights the bottom of the shadow)
      col += vec3(1., .45, .12) * (exp(-hy * 6.) * .2 + exp(-hy * 60.) * .15 + exp(-hy * 600.) * 1.2);
    }
  }
  col = mix(col, tr.rgb, tr.a);
  if (lift < .999) col = wheat(fuv, col, tz, tr.a);

  // grade: push toward amber, then filmic rolloff so hot cores bleach to cream instead of clipping yellow
  col *= vec3(1.07, .95, .8);
  col = 1. - exp(-col * 1.2);
  col *= smoothstep(1.35, .35, length(uv0 * vec2(.7, 1.)));      // vignette
  // film grain, new pattern 24x/s; faded out in near-black so the sky stays pure black
  col += (grain(gl_FragCoord.xy + mod(floor(uTime * 24.), 256.) * vec2(37., 91.)) - .5) * .012 * smoothstep(.0, .06, max(col.r, max(col.g, col.b)));
  gl_FragColor = vec4(max(col, 0.), 1.);
}
