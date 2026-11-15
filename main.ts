// Aica Excited — one image, painted entirely by code (Node, standard library only).
//
// A tiny match struck at the bottom of the frame ignites a whole spiral galaxy:
// the flame is small, the fire is a universe. The program paints the scene pixel
// by pixel into a float framebuffer (seeded value-noise nebulae, a logarithmic
// spiral galaxy with dust lanes, a stylised teardrop flame, a column of rising
// sparks), then blooms, tonemaps and PNG-encodes it. The seed is fixed and no
// clock or ambient randomness is read, so every run writes identical bytes.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts     (writes out/entry.png)

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const W = 1024;
const H = 1024;
const CONCEPT = 'match'; // 'match' | 'whale' | 'tree' — the studio keeps all three painters

// ---------------------------------------------------------------- utilities

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, v) => { const t = clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// Colour stops -> [r,g,b] in 0..1, picked to live in a deep-space neon palette.
function ramp(stops, t) {
  t = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (t - t0) / (t1 - t0 || 1);
      return [lerp(c0[0], c1[0], k), lerp(c0[1], c1[1], k), lerp(c0[2], c1[2], k)];
    }
  }
  return stops[stops.length - 1][1];
}
const INK = [0.012, 0.016, 0.05];
const VIOLET = [0.42, 0.16, 0.95];
const MAGENTA = [1.0, 0.16, 0.62];
const PINK = [1.0, 0.45, 0.75];
const CYAN = [0.15, 0.85, 1.0];
const TEAL = [0.05, 0.65, 0.75];
const GOLD = [1.0, 0.78, 0.35];
const WHITE = [1.0, 0.98, 0.95];

// ------------------------------------------------------- tileable value noise

const NT = 256;
const noiseTex = new Float32Array(NT * NT);
{
  const rand = mulberry32(1337);
  const grids = [];
  for (const period of [4, 8, 16, 32]) {
    const g = new Float32Array(period * period);
    for (let i = 0; i < g.length; i++) g[i] = rand();
    grids.push([period, g]);
  }
  const sampleGrid = (period, g, u, v) => {
    const x = u * period, y = v * period;
    const x0 = Math.floor(x) % period, y0 = Math.floor(y) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const fx = smooth(0, 1, x - Math.floor(x)), fy = smooth(0, 1, y - Math.floor(y));
    const a = g[y0 * period + x0], b = g[y0 * period + x1];
    const c = g[y1 * period + x0], d = g[y1 * period + x1];
    return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
  };
  for (let y = 0; y < NT; y++) {
    for (let x = 0; x < NT; x++) {
      const u = x / NT, v = y / NT;
      let val = 0, amp = 0.55;
      for (const [period, g] of grids) { val += amp * sampleGrid(period, g, u, v); amp *= 0.55; }
      noiseTex[y * NT + x] = val;
    }
  }
}
function texAt(u, v) {
  const x = ((u % 1) + 1) % 1, y = ((v % 1) + 1) % 1;
  const px = x * NT, py = y * NT;
  const x0 = Math.floor(px) % NT, y0 = Math.floor(py) % NT;
  const x1 = (x0 + 1) % NT, y1 = (y0 + 1) % NT;
  const fx = px - Math.floor(px), fy = py - Math.floor(py);
  const a = noiseTex[y0 * NT + x0], b = noiseTex[y0 * NT + x1];
  const c = noiseTex[y1 * NT + x0], d = noiseTex[y1 * NT + x1];
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}
// Fractal noise in pixel space; cycles = how many texture repeats span the frame.
function fbm(px, py, cycles) {
  const u = (px / W) * cycles, v = (py / H) * cycles;
  return 0.58 * texAt(u, v) + 0.27 * texAt(u * 2.03 + 0.371, v * 2.03 + 0.113)
       + 0.15 * texAt(u * 4.07 + 0.719, v * 4.07 + 0.531);
}

// ------------------------------------------------------------- frame buffer

const buf = new Float32Array(W * H * 3);
function addPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  buf[i] += r; buf[i + 1] += g; buf[i + 2] += b;
}
function setPx(x, y, r, g, b) {
  const i = (y * W + x) * 3;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
}
// Additive radial glow sprite with a soft cosine falloff.
function splat(cx, cy, radius, col, strength) {
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(W - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(H - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy) / radius;
      if (d >= 1) continue;
      const f = Math.cos(d * Math.PI * 0.5);
      const s = strength * f * f;
      addPx(x, y, col[0] * s, col[1] * s, col[2] * s);
    }
  }
}
// Filled ellipse, optionally rotated, painted with a flat colour at alpha.
function ellipse(cx, cy, rx, ry, rot, col, alpha) {
  const R = Math.max(rx, ry);
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
  const cosr = Math.cos(rot), sinr = Math.sin(rot);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const lx = (dx * cosr + dy * sinr) / rx, ly = (-dx * sinr + dy * cosr) / ry;
      const q = lx * lx + ly * ly;
      if (q >= 1) continue;
      const a = alpha * smooth(1, 0.82, q);
      const i = (y * W + x) * 3;
      buf[i] = lerp(buf[i], col[0], a);
      buf[i + 1] = lerp(buf[i + 1], col[1], a);
      buf[i + 2] = lerp(buf[i + 2], col[2], a);
    }
  }
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const L2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / L2;
  t = clamp(t, 0, 1);
  const qx = ax + dx * t - px, qy = ay + dy * t - py;
  return [Math.sqrt(qx * qx + qy * qy), t];
}

// ------------------------------------------------------------------- scenes

function paintSky(topCol, midCol, botCol, nebA, nebB, nebStrength) {
  for (let y = 0; y < H; y++) {
    const t = y / H;
    const c = t < 0.55 ? ramp([[0, topCol], [0.55, midCol]], t) : ramp([[0.55, midCol], [1, botCol]], t);
    for (let x = 0; x < W; x++) setPx(x, y, c[0], c[1], c[2]);
  }
  // Nebula clouds: shaped fbm, two colour families, additive.
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const n1 = fbm(x + 300, y + 80, 3);
      const n2 = fbm(x + 1400, y + 900, 4);
      const c1 = smooth(0.52, 0.85, n1) * nebStrength;
      const c2 = smooth(0.55, 0.9, n2) * nebStrength * 0.8;
      if (c1 > 0.003) addPx(x, y, nebA[0] * c1, nebA[1] * c1, nebA[2] * c1);
      if (c2 > 0.003) addPx(x, y, nebB[0] * c2, nebB[1] * c2, nebB[2] * c2);
    }
  }
}

function paintStars(count, seed, yMax, bright) {
  const rand = mulberry32(seed);
  for (let i = 0; i < count; i++) {
    const x = rand() * W, y = rand() * yMax;
    const big = rand();
    const r = big > 0.985 ? 3.4 : big > 0.93 ? 2.1 : 1.15;
    const temp = rand();
    const col = temp < 0.3 ? [0.72, 0.85, 1.0] : temp < 0.75 ? WHITE : [1.0, 0.88, 0.7];
    splat(x, y, r * 2.6, col, (0.25 + rand() * 0.75) * bright);
    if (big > 0.985) { // cross sparkle on the few brightest
      for (let k = -7; k <= 7; k++) {
        if (k === 0) continue;
        const f = (1 - Math.abs(k) / 8) * 0.35 * bright;
        addPx(Math.round(x + k), Math.round(y), col[0] * f, col[1] * f, col[2] * f);
        addPx(Math.round(x), Math.round(y + k), col[0] * f, col[1] * f, col[2] * f);
      }
    }
  }
}

function shootingStar(x0, y0, x1, y1, col) {
  const steps = 46;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    const x = lerp(x0, x1, t), y = lerp(y0, y1, t);
    splat(x, y, lerp(1.2, 6.5, t), col, 0.16 * (1 - t) + 0.02);
  }
  splat(x0, y0, 7, WHITE, 0.8);
}

// A logarithmic spiral galaxy, painted additively inside its disc.
// maskFn, when given, clips the light (the whale wears the galaxy as its skin).
function paintGalaxy(cx, cy, R, opt) {
  const tilt = opt.tilt ?? 0.82, arms = opt.arms ?? 2, twist = opt.twist ?? 2.4;
  const rot = opt.rot ?? 0, strength = opt.strength ?? 1, seed = opt.seed ?? 7;
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(W - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(H - 1, Math.ceil(cy + R));
  const cosr = Math.cos(rot), sinr = Math.sin(rot);
  const pal = [[0, [1.0, 0.97, 0.9]], [0.1, GOLD], [0.3, PINK], [0.55, MAGENTA], [0.8, VIOLET], [1, CYAN]];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (opt.maskFn && !opt.maskFn(x, y)) continue;
      let dx = x - cx, dy = (y - cy) / tilt;
      const lx = dx * cosr + dy * sinr, ly = -dx * sinr + dy * cosr;
      const r = Math.sqrt(lx * lx + ly * ly) / R;
      if (r >= 1) continue;
      const th = Math.atan2(ly, lx);
      const phase = arms * (th - twist * Math.log(r + 0.045));
      const armSignal = 0.5 + 0.5 * Math.cos(phase);
      const arm = Math.pow(armSignal, 6) * 1.6 + Math.pow(armSignal, 2) * 0.3;
      const grainRaw = fbm(x + seed * 131, y + seed * 57, 9);
      const grain = clamp((grainRaw - 0.32) * 1.9, 0.05, 1.3);
      const dust = fbm(x + 4000 + seed * 71, y + 2600, 7);
      const laneArm = Math.pow(0.5 + 0.5 * Math.cos(phase - 1.25), 2);
      const lane = 1 - 0.62 * laneArm * smooth(0.5, 0.75, dust) * smooth(0.03, 0.25, r);
      const core = Math.exp(-r * r * 42) * 1.5 + Math.exp(-r * r * 160) * 1.1;
      const disc = arm * Math.exp(-r * 1.9) * grain * lane;
      const halo = Math.exp(-r * 3.4) * 0.07;
      const edge = smooth(1.0, 0.7, r);
      const inten = (disc + core + halo) * edge * strength;
      if (inten < 0.004) continue;
      const c = ramp(pal, clamp(r * 1.12, 0, 1));
      addPx(x, y, c[0] * inten, c[1] * inten, c[2] * inten);
    }
  }
  // Star-forming knots sprinkled along the arms.
  const rand = mulberry32(seed * 977 + 13);
  for (let i = 0; i < 260; i++) {
    const rr = Math.pow(rand(), 0.62);
    const armIdx = Math.floor(rand() * arms);
    const th = (armIdx * 2 * Math.PI) / arms + twist * Math.log(rr + 0.045) + (rand() - 0.5) * 0.34;
    const lx = Math.cos(th) * rr * R, ly = Math.sin(th) * rr * R;
    const dx = lx * cosr - ly * sinr, dy = lx * sinr + ly * cosr;
    const x = cx + dx, y = cy + dy * tilt;
    if (opt.maskFn && !opt.maskFn(x, y)) continue;
    const col = rand() < 0.45 ? PINK : rand() < 0.6 ? CYAN : WHITE;
    splat(x, y, 1.4 + rand() * 2.6, col, (0.35 + rand() * 0.6) * strength);
  }
  splat(cx, cy, R * 0.13, [1.0, 0.95, 0.85], 0.7 * strength);
  splat(cx, cy, R * 0.36, GOLD, 0.12 * strength);
}

// ------------------------------------------------------------- concept: match
// A struck match at the bottom of the frame; its flame has bloomed into a galaxy.

function paintMatch() {
  paintSky([0.008, 0.006, 0.03], [0.03, 0.015, 0.09], [0.05, 0.01, 0.1], VIOLET, TEAL, 0.34);
  paintStars(650, 42, H, 0.8);

  // The galaxy the flame became.
  paintGalaxy(512, 336, 452, { tilt: 0.8, arms: 3, twist: 2.9, rot: -0.55, strength: 1.1, seed: 5 });
  shootingStar(168, 150, 356, 96, CYAN);

  // A soft cone of light binds the flame to the disc above it.
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const col = t < 0.4 ? [1.0, 0.55, 0.15] : t < 0.75 ? MAGENTA : VIOLET;
    splat(512 + Math.sin(t * 5.2) * 14, 892 - t * 420, 34 + t * 74, col, 0.055);
  }
  // Rising sparks: a column that widens and cools as it climbs into the disc.
  const rand = mulberry32(2024);
  for (let i = 0; i < 1050; i++) {
    const t = Math.pow(rand(), 0.8);
    const y = 908 - t * 470;
    const spread = 10 + t * 155;
    const x = 512 + (rand() - 0.5) * 2 * spread + Math.sin(t * 8.5 + rand() * 0.6) * 22 * t;
    const col = t < 0.22 ? GOLD : t < 0.5 ? [1.0, 0.5, 0.25] : t < 0.78 ? MAGENTA : CYAN;
    const s = (1 - t * 0.55) * (0.35 + rand() * 0.8);
    splat(x, y, 0.9 + rand() * 2.2, col, s);
  }

  // The matchstick: a dark tapered capsule leaning a touch, lit on one edge.
  const stick = (off, w, col, a) => {
    const ax = 486 + off, ay = 1030, bx = 510 + off, by = 924;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - w - 2)), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + w + 2));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - w - 2)), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + w + 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const [d, t] = distSeg(x, y, ax, ay, bx, by);
        const hw = lerp(w, w * 0.78, t);
        if (d >= hw) continue;
        const al = a * smooth(hw, hw * 0.55, d);
        const idx = (y * W + x) * 3;
        buf[idx] = lerp(buf[idx], col[0], al);
        buf[idx + 1] = lerp(buf[idx + 1], col[1], al);
        buf[idx + 2] = lerp(buf[idx + 2], col[2], al);
      }
    }
  };
  stick(0, 13.5, [0.1, 0.045, 0.016], 1);
  stick(-4.5, 6.5, [0.34, 0.16, 0.05], 0.85);

  // Match head and the flame it carries.
  ellipse(513, 914, 16.5, 25, -0.14, [0.23, 0.05, 0.03], 1);
  ellipse(509, 904, 8, 13, -0.14, [0.45, 0.12, 0.05], 0.9);
  splat(514, 868, 138, [1.0, 0.45, 0.1], 0.55);
  splat(514, 868, 62, [1.0, 0.6, 0.16], 0.7);
  ellipse(514, 862, 30, 52, 0.05, [1.0, 0.52, 0.08], 0.95);
  ellipse(514, 874, 18, 35, 0.03, [1.0, 0.8, 0.25], 0.98);
  ellipse(514, 886, 9, 18, 0, [1.0, 0.97, 0.88], 1);
  ellipse(514, 902, 7, 9, 0, [0.35, 0.6, 1.0], 0.95);
  splat(514, 818, 19, [1.0, 0.62, 0.15], 0.55);
}

// ------------------------------------------------------------- concept: whale
// A whale breaches out of a night ocean; its body is a window into a galaxy,
// and the spray off its back is turning into stars.

const whaleSpine = [];
{
  const P0 = [238, 655], P1 = [400, 348], P2 = [812, 292];
  for (let i = 0; i <= 48; i++) {
    const t = i / 48, u = 1 - t;
    const x = u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0];
    const y = u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1];
    const r = 13 + 112 * Math.pow(Math.sin(Math.PI * clamp(t * 0.94 + 0.03, 0, 1)), 0.85);
    whaleSpine.push([x, y, r]);
  }
}
function ellipseSdf(x, y, cx, cy, rx, ry, rot) {
  const dx = x - cx, dy = y - cy;
  const cosr = Math.cos(rot), sinr = Math.sin(rot);
  const lx = (dx * cosr + dy * sinr) / rx, ly = (-dx * sinr + dy * cosr) / ry;
  return (Math.sqrt(lx * lx + ly * ly) - 1) * Math.min(rx, ry);
}
function whaleDist(x, y) {
  let d = 1e9;
  for (let i = 1; i < whaleSpine.length; i++) {
    const [a, b] = [whaleSpine[i - 1], whaleSpine[i]];
    const [ds, t] = distSeg(x, y, a[0], a[1], b[0], b[1]);
    d = Math.min(d, ds - lerp(a[2], b[2], t));
  }
  // Tail fluke: two lobes fanning from the peduncle.
  d = Math.min(d, ellipseSdf(x, y, 196, 618, 92, 23, 0.62));
  d = Math.min(d, ellipseSdf(x, y, 210, 700, 88, 22, -0.5));
  // Pectoral fin, swept back under the belly.
  d = Math.min(d, ellipseSdf(x, y, 648, 520, 92, 19, 0.72));
  return d;
}
function paintWhale() {
  paintSky([0.006, 0.01, 0.045], [0.035, 0.02, 0.1], [0.02, 0.05, 0.09], MAGENTA, TEAL, 0.5);
  paintStars(800, 99, 700, 0.9);
  shootingStar(830, 130, 660, 84, PINK);

  const HORIZON = 692;
  // Ocean: deep gradient, a breathing glow under the breach, sparse glints.
  for (let y = HORIZON; y < H; y++) {
    const t = (y - HORIZON) / (H - HORIZON);
    const c = ramp([[0, [0.03, 0.13, 0.2]], [0.25, [0.015, 0.07, 0.13]], [1, [0.004, 0.012, 0.05]]], t);
    for (let x = 0; x < W; x++) setPx(x, y, c[0], c[1], c[2]);
  }
  splat(330, HORIZON + 26, 210, TEAL, 0.3);
  splat(560, HORIZON + 60, 300, VIOLET, 0.12);
  const grand = mulberry32(7);
  for (let i = 0; i < 420; i++) {
    const x = grand() * W, y = HORIZON + 6 + Math.pow(grand(), 1.6) * (H - HORIZON - 20);
    const len = 2 + grand() * 9, fade = (1 - (y - HORIZON) / (H - HORIZON)) * 0.5;
    const col = grand() < 0.6 ? CYAN : grand() < 0.8 ? PINK : GOLD;
    for (let k = 0; k < len; k++) addPx(Math.round(x + k), Math.round(y), col[0] * fade * 0.4, col[1] * fade * 0.4, col[2] * fade * 0.4);
  }

  // The whale: galaxy skin inside the silhouette, deep ink at the belly, a
  // cyan rim where the sky catches its back.
  const x0 = 90, x1 = 930, y0 = 140, y1 = 760;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = whaleDist(x, y);
      if (d > 3) continue;
      const idx = (y * W + x) * 3;
      if (d < 0) {
        const depth = clamp(-d / 130, 0, 1);
        const base = ramp([[0, [0.05, 0.03, 0.14]], [1, [0.02, 0.05, 0.16]]], depth);
        const a = smooth(3, -2, d);
        buf[idx] = lerp(buf[idx], base[0], a);
        buf[idx + 1] = lerp(buf[idx + 1], base[1], a);
        buf[idx + 2] = lerp(buf[idx + 2], base[2], a);
      }
    }
  }
  paintGalaxy(505, 415, 430, { tilt: 0.8, arms: 2, twist: 2.2, rot: 0.35, strength: 0.95, seed: 11, maskFn: (x, y) => whaleDist(x, y) < -3 });
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const d = whaleDist(x, y);
      if (d < -13 || d > 2.5) continue;
      const gx = (whaleDist(x + 2, y) - whaleDist(x - 2, y)) / 4;
      const gy = (whaleDist(x, y + 2) - whaleDist(x, y - 2)) / 4;
      const gl = Math.sqrt(gx * gx + gy * gy) || 1;
      const up = clamp(-gy / gl, 0, 1); // rim catches light where the surface faces up
      const s = smooth(2.5, -1, d) * smooth(-13, -4, d) * (0.25 + 0.95 * up);
      addPx(x, y, CYAN[0] * s * 0.8, CYAN[1] * s * 0.8, CYAN[2] * s * 0.85);
    }
  }
  // The eye: one bright glint on the head.
  splat(742, 330, 15, CYAN, 0.55);
  splat(742, 330, 4.5, WHITE, 1.1);

  // Spray: droplets thrown off the breach, already halfway to being stars.
  const rand = mulberry32(555);
  splat(268, HORIZON - 4, 66, [0.75, 0.95, 1.0], 0.4);
  for (let i = 0; i < 240; i++) {
    const ang = -Math.PI * (0.12 + rand() * 0.76);
    const v = 60 + rand() * 190;
    const steps = 5 + Math.floor(rand() * 9);
    for (let k = 1; k <= steps; k++) {
      const tt = k / steps;
      const px = 268 + Math.cos(ang) * v * tt;
      const py = HORIZON - 6 + Math.sin(ang) * v * tt + 150 * tt * tt;
      const col = rand() < 0.25 ? WHITE : CYAN;
      splat(px, py, 0.8 + (1 - tt) * 2.2, col, 0.5 * (1 - tt * 0.6));
    }
  }
}

// -------------------------------------------------------------- concept: tree
// A great tree whose canopy is a spiral galaxy and whose roots are lightning.

const treeMask = new Float32Array(W * H);
function maskSegment(x0, y0, x1, y1, w0, w1) {
  const R = Math.max(w0, w1) + 3;
  const xa = Math.max(0, Math.floor(Math.min(x0, x1) - R)), xb = Math.min(W - 1, Math.ceil(Math.max(x0, x1) + R));
  const ya = Math.max(0, Math.floor(Math.min(y0, y1) - R)), yb = Math.min(H - 1, Math.ceil(Math.max(y0, y1) + R));
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      const [d, t] = distSeg(x, y, x0, y0, x1, y1);
      const hw = lerp(w0, w1, t);
      const m = smooth(hw + 1.5, hw * 0.45, d);
      const idx = y * W + x;
      if (m > treeMask[idx]) treeMask[idx] = m;
    }
  }
}
function growTree(x, y, ang, len, wid, depth, rand) {
  const nx = x + Math.cos(ang) * len, ny = y + Math.sin(ang) * len;
  maskSegment(x, y, nx, ny, wid, wid * 0.68);
  if (depth <= 0 || wid < 1.1) return;
  const n = rand() < 0.24 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const spread = (i - (n - 1) / 2) * (0.34 + rand() * 0.22) + (rand() - 0.5) * 0.14;
    growTree(nx, ny, ang + spread, len * (0.72 + rand() * 0.12), wid * 0.66, depth - 1, rand);
  }
}
function paintTree() {
  paintSky([0.008, 0.008, 0.04], [0.03, 0.02, 0.1], [0.015, 0.04, 0.07], VIOLET, MAGENTA, 0.4);
  paintStars(700, 31, H, 0.85);

  // The canopy: a tilted spiral galaxy the branches reach into and hold up.
  paintGalaxy(512, 372, 408, { tilt: 0.74, arms: 2, twist: 3.1, rot: -0.35, strength: 1.05, seed: 21 });

  // Ground: two rolling hill silhouettes.
  const hillY = (x) => 922 + 24 * Math.sin(x * 0.0042 + 1.7) + 11 * Math.sin(x * 0.0113 + 0.4);
  for (let x = 0; x < W; x++) {
    const hy = hillY(x);
    for (let y = Math.floor(hy); y < H; y++) {
      const t = (y - hy) / (H - hy + 1);
      const c = ramp([[0, [0.012, 0.03, 0.045]], [1, [0.002, 0.006, 0.02]]], t);
      setPx(x, y, c[0], c[1], c[2]);
    }
  }

  // Trunk and branches, grown recursively into a mask.
  const rand = mulberry32(808);
  growTree(512, 1006, -Math.PI / 2, 128, 47, 9, rand);
  // Roots above the soil: short gnarled segments hugging the ground line.
  for (let i = 0; i < 6; i++) {
    const dir = i < 3 ? -1 : 1, k = (i % 3) + 1;
    const x1 = 512 + dir * (52 + k * 44), y1 = hillY(x1) + 4;
    maskSegment(512, 1002, x1, y1, 15 - k * 3, 4);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const m = treeMask[y * W + x];
      if (m <= 0.01) continue;
      const idx = (y * W + x) * 3;
      const c = [0.008, 0.01, 0.03];
      buf[idx] = lerp(buf[idx], c[0], m);
      buf[idx + 1] = lerp(buf[idx + 1], c[1], m);
      buf[idx + 2] = lerp(buf[idx + 2], c[2], m);
      // A breath of galaxy light on the branch edges, strongest mid-mask.
      const edge = m * (1 - m) * 4;
      buf[idx] += VIOLET[0] * edge * 0.12;
      buf[idx + 1] += VIOLET[1] * edge * 0.12;
      buf[idx + 2] += VIOLET[2] * edge * 0.12;
    }
  }
  // Lightning roots below the soil: the same branching, drawn as light.
  const bolt = (x, y, ang, len, depth, r2) => {
    const nx = x + Math.cos(ang) * len, ny = y + Math.sin(ang) * len;
    const steps = Math.max(2, Math.floor(len / 9));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      splat(lerp(x, nx, t), lerp(y, ny, t), 8 - depth * 0.5, VIOLET, 0.3);
      splat(lerp(x, nx, t), lerp(y, ny, t), 3, PINK, 0.34);
      splat(lerp(x, nx, t), lerp(y, ny, t), 1.3, WHITE, 0.22);
    }
    if (depth <= 0) return;
    bolt(nx, ny, ang + 0.3 + r2() * 0.3, len * 0.74, depth - 1, r2);
    bolt(nx, ny, ang - 0.3 - r2() * 0.3, len * 0.74, depth - 1, r2);
  };
  const r2 = mulberry32(4141);
  for (const a of [0.35, 0.75, 1.25, 1.85, 2.35, 2.75]) bolt(512, 1004, a, 54, 3, r2);

  // Falling motes: galaxy-light drifting down like slow sparks of pollen.
  const rand2 = mulberry32(616);
  for (let i = 0; i < 340; i++) {
    const x = 90 + rand2() * 844, y = 120 + Math.pow(rand2(), 0.7) * 800;
    const col = rand2() < 0.5 ? GOLD : rand2() < 0.75 ? CYAN : PINK;
    splat(x, y, 1 + rand2() * 2.2, col, 0.45 + rand2() * 0.6);
  }
}

// --------------------------------------------------------------------- post

function bloomAndTonemap() {
  const S = 4, SW = W / S, SH = H / S;
  const small = new Float32Array(SW * SH * 3);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < S; ky++) {
        for (let kx = 0; kx < S; kx++) {
          const i = ((y * S + ky) * W + x * S + kx) * 3;
          r += Math.max(0, buf[i] - 0.6); g += Math.max(0, buf[i + 1] - 0.6); b += Math.max(0, buf[i + 2] - 0.6);
        }
      }
      const o = (y * SW + x) * 3, n = S * S;
      small[o] = r / n; small[o + 1] = g / n; small[o + 2] = b / n;
    }
  }
  const blurred = new Float32Array(small.length);
  const R = 5;
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? small : blurred;
    const tmp = new Float32Array(small.length);
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -R; k <= R; k++) {
          const xx = clamp(x + k, 0, SW - 1);
          const i = (y * SW + xx) * 3;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
        const o = (y * SW + x) * 3;
        tmp[o] = r / n; tmp[o + 1] = g / n; tmp[o + 2] = b / n;
      }
    }
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -R; k <= R; k++) {
          const yy = clamp(y + k, 0, SH - 1);
          const i = (yy * SW + x) * 3;
          r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2]; n++;
        }
        const o = (y * SW + x) * 3;
        blurred[o] = r / n; blurred[o + 1] = g / n; blurred[o + 2] = b / n;
      }
    }
  }
  const out = new Uint8Array(W * H * 3);
  const cx = W / 2, cy = H / 2, maxD = Math.sqrt(cx * cx + cy * cy);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const bi = (Math.floor(y / S) * SW + Math.floor(x / S)) * 3;
      let r = buf[i] + blurred[bi] * 1.25;
      let g = buf[i + 1] + blurred[bi + 1] * 1.25;
      let b = buf[i + 2] + blurred[bi + 2] * 1.25;
      r *= 1.18; g *= 1.18; b *= 1.18;
      r = r / (1 + r); g = g / (1 + g); b = b / (1 + b);
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * 1.14; g = luma + (g - luma) * 1.14; b = luma + (b - luma) * 1.14;
      const d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) / maxD;
      const vig = 1 - 0.34 * smooth(0.52, 1.02, d);
      out[i] = clamp(Math.pow(clamp(r, 0, 1), 0.8) * vig, 0, 1) * 255;
      out[i + 1] = clamp(Math.pow(clamp(g, 0, 1), 0.8) * vig, 0, 1) * 255;
      out[i + 2] = clamp(Math.pow(clamp(b, 0, 1), 0.8) * vig, 0, 1) * 255;
    }
  }
  return out;
}

// ---------------------------------------------------------------- PNG codec

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function encodePng(pixels, w, h) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    let bestType = 0, bestScore = Infinity, bestRow = null;
    for (const type of [1, 2, 4]) {
      const filt = new Uint8Array(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0, b = prev[i], c = i >= 3 ? prev[i - 3] : 0;
        const pred = type === 1 ? a : type === 2 ? b : paeth(a, b, c);
        const v = (row[i] - pred) & 0xff;
        filt[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestType = type; bestRow = filt; }
    }
    const off = y * (stride + 1);
    raw[off] = bestType;
    raw.set(bestRow, off + 1);
    prev.set(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function downscale(pixels, w, h, f) {
  const nw = Math.floor(w / f), nh = Math.floor(h / f);
  const out = new Uint8Array(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < f; ky++) {
        for (let kx = 0; kx < f; kx++) {
          const i = ((y * f + ky) * w + x * f + kx) * 3;
          r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2];
        }
      }
      const o = (y * nw + x) * 3, n = f * f;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return [out, nw, nh];
}

// ---------------------------------------------------------------------- run

if (CONCEPT === 'whale') paintWhale();
else if (CONCEPT === 'tree') paintTree();
else paintMatch();

let pixels = bloomAndTonemap();
let png = encodePng(pixels, W, H);
let dims = [W, H];
if (png.length > 1000000) { // stay comfortably under the 1 MiB gate
  const [p2, w2, h2] = downscale(pixels, W, H, 2);
  const png2 = encodePng(p2, w2, h2);
  if (png2.length < png.length) { png = png2; dims = [w2, h2]; }
}
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), png);
console.log(`entry.png: ${png.length} bytes, ${dims[0]}x${dims[1]}, concept=${CONCEPT}`);
