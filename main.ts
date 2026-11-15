// The Smallest Fire — a make.fun ai-excited-01 entry.
//
// One picture, painted entirely by this program (Node, standard library only):
// a struck match at the bottom of the frame, and its flame has bloomed into a
// spiral galaxy. A column of sparks climbs out of the flame, cooling from gold
// through orange and magenta to cyan as it rises and spreads, until the sparks
// are stars and the fire is a universe: flame -> sparks -> galaxy, one thrust.
//
// The scene is accumulated in a float HDR framebuffer, bloomed, tonemapped and
// written as a PNG by a hand-rolled encoder. The seed is fixed and nothing
// reads a clock or ambient randomness, so two runs write identical bytes.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts   ->  out/entry.png

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SIZE = 1024; // the frame is SIZE x SIZE

// ------------------------------------------------------------ small helpers

// mulberry32: a tiny seeded PRNG, good enough for stars and sparks.
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const mix = (a, b, t) => a + (b - a) * t;
// Smoothstep between edges e0 and e1.
const sstep = (e0, e1, v) => {
  const t = clamp((v - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

// Piecewise-linear colour gradient: stops are [at, [r, g, b]] pairs.
function gradient(stops, t) {
  const x = clamp(t, 0, 1);
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      const k = (x - t0) / (t1 - t0 || 1);
      return [mix(c0[0], c1[0], k), mix(c0[1], c1[1], k), mix(c0[2], c1[2], k)];
    }
  }
  return stops[stops.length - 1][1];
}

// Palette of the piece: deep-space neon, warm at the match, cold at the rim.
const WHITE = [1.0, 0.98, 0.95];
const GOLD = [1.0, 0.78, 0.35];
const PINK = [1.0, 0.45, 0.75];
const MAGENTA = [1.0, 0.16, 0.62];
const VIOLET = [0.42, 0.16, 0.95];
const CYAN = [0.15, 0.85, 1.0];
const TEAL = [0.05, 0.65, 0.75];

// ------------------------------------------------------- tileable fbm noise
// A 256x256 texture holding four octaves of periodic value noise (periods
// 4, 8, 16, 32), so samples wrap seamlessly in both axes. fbm() then mixes
// three scales of that texture for cloudy, non-repeating-looking fields.

const NTEX = 256;
const noiseTex = (() => {
  const rand = rng(1337);
  const tex = new Float32Array(NTEX * NTEX);
  const octaves = [];
  for (const period of [4, 8, 16, 32]) {
    const grid = new Float32Array(period * period);
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    octaves.push([period, grid]);
  }
  const lattice = (period, grid, u, v) => {
    const gx = u * period, gy = v * period;
    const x0 = Math.floor(gx) % period, y0 = Math.floor(gy) % period;
    const x1 = (x0 + 1) % period, y1 = (y0 + 1) % period;
    const fx = sstep(0, 1, gx - Math.floor(gx)), fy = sstep(0, 1, gy - Math.floor(gy));
    const top = mix(grid[y0 * period + x0], grid[y0 * period + x1], fx);
    const bot = mix(grid[y1 * period + x0], grid[y1 * period + x1], fx);
    return mix(top, bot, fy);
  };
  for (let y = 0; y < NTEX; y++) {
    for (let x = 0; x < NTEX; x++) {
      let sum = 0, amp = 0.55;
      for (const [period, grid] of octaves) {
        sum += amp * lattice(period, grid, x / NTEX, y / NTEX);
        amp *= 0.55;
      }
      tex[y * NTEX + x] = sum;
    }
  }
  return tex;
})();

function noiseAt(u, v) {
  const uu = ((u % 1) + 1) % 1, vv = ((v % 1) + 1) % 1;
  const px = uu * NTEX, py = vv * NTEX;
  const x0 = Math.floor(px) % NTEX, y0 = Math.floor(py) % NTEX;
  const x1 = (x0 + 1) % NTEX, y1 = (y0 + 1) % NTEX;
  const fx = px - Math.floor(px), fy = py - Math.floor(py);
  const top = mix(noiseTex[y0 * NTEX + x0], noiseTex[y0 * NTEX + x1], fx);
  const bot = mix(noiseTex[y1 * NTEX + x0], noiseTex[y1 * NTEX + x1], fx);
  return mix(top, bot, fy);
}

// Fractal noise in pixel space; `cycles` is how many texture repeats span
// the frame, so larger cycles mean finer cloud detail.
function fbm(px, py, cycles) {
  const u = (px / SIZE) * cycles, v = (py / SIZE) * cycles;
  return 0.58 * noiseAt(u, v)
       + 0.27 * noiseAt(u * 2.03 + 0.371, v * 2.03 + 0.113)
       + 0.15 * noiseAt(u * 4.07 + 0.719, v * 4.07 + 0.531);
}

// ------------------------------------------------------------- frame buffer

const frame = new Float32Array(SIZE * SIZE * 3);

function addAt(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 3;
  frame[i] += r; frame[i + 1] += g; frame[i + 2] += b;
}

function putAt(x, y, r, g, b) {
  const i = (y * SIZE + x) * 3;
  frame[i] = r; frame[i + 1] = g; frame[i + 2] = b;
}

// Additive radial glow with a soft cosine profile: the workhorse brush for
// stars, sparks, knots and halos.
function glow(cx, cy, radius, colour, power) {
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(SIZE - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(SIZE - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy) / radius;
      if (d >= 1) continue;
      const fall = Math.cos(d * Math.PI * 0.5);
      const s = power * fall * fall;
      addAt(x, y, colour[0] * s, colour[1] * s, colour[2] * s);
    }
  }
}

// A filled ellipse (optionally rotated), alpha-blended with a soft rim.
function blob(cx, cy, rx, ry, rot, colour, alpha) {
  const reach = Math.max(rx, ry);
  const x0 = Math.max(0, Math.floor(cx - reach)), x1 = Math.min(SIZE - 1, Math.ceil(cx + reach));
  const y0 = Math.max(0, Math.floor(cy - reach)), y1 = Math.min(SIZE - 1, Math.ceil(cy + reach));
  const cosr = Math.cos(rot), sinr = Math.sin(rot);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = y - cy;
      const lx = (dx * cosr + dy * sinr) / rx, ly = (-dx * sinr + dy * cosr) / ry;
      const q = lx * lx + ly * ly;
      if (q >= 1) continue;
      const a = alpha * sstep(1, 0.82, q);
      const i = (y * SIZE + x) * 3;
      frame[i] = mix(frame[i], colour[0], a);
      frame[i + 1] = mix(frame[i + 1], colour[1], a);
      frame[i + 2] = mix(frame[i + 2], colour[2], a);
    }
  }
}

// Distance from a point to a segment, plus the parameter along it.
function segDist(px, py, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay;
  const len2 = ex * ex + ey * ey || 1;
  const t = clamp(((px - ax) * ex + (py - ay) * ey) / len2, 0, 1);
  const qx = ax + ex * t - px, qy = ay + ey * t - py;
  return [Math.sqrt(qx * qx + qy * qy), t];
}

// ------------------------------------------------------------------- sky

function paintBackdrop() {
  const top = [0.008, 0.006, 0.03], mid = [0.03, 0.015, 0.09], bot = [0.05, 0.01, 0.1];
  for (let y = 0; y < SIZE; y++) {
    const t = y / SIZE;
    const c = t < 0.55
      ? gradient([[0, top], [0.55, mid]], t)
      : gradient([[0.55, mid], [1, bot]], t);
    for (let x = 0; x < SIZE; x++) putAt(x, y, c[0], c[1], c[2]);
  }
  // Two nebula families, thresholded fbm so the clouds keep dark space
  // between them instead of washing the whole sky.
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const a = sstep(0.52, 0.85, fbm(x + 300, y + 80, 3)) * 0.34;
      const b = sstep(0.55, 0.9, fbm(x + 1400, y + 900, 4)) * 0.34 * 0.8;
      if (a > 0.003) addAt(x, y, VIOLET[0] * a, VIOLET[1] * a, VIOLET[2] * a);
      if (b > 0.003) addAt(x, y, TEAL[0] * b, TEAL[1] * b, TEAL[2] * b);
    }
  }
}

function paintStarfield(count, seed, brightness) {
  const rand = rng(seed);
  for (let i = 0; i < count; i++) {
    const x = rand() * SIZE, y = rand() * SIZE;
    const tier = rand();
    const r = tier > 0.985 ? 3.4 : tier > 0.93 ? 2.1 : 1.15;
    const temp = rand();
    const colour = temp < 0.3 ? [0.72, 0.85, 1.0] : temp < 0.75 ? WHITE : [1.0, 0.88, 0.7];
    glow(x, y, r * 2.6, colour, (0.25 + rand() * 0.75) * brightness);
    if (tier > 0.985) {
      // A small diffraction cross on the handful of brightest stars.
      for (let k = -7; k <= 7; k++) {
        if (k === 0) continue;
        const f = (1 - Math.abs(k) / 8) * 0.35 * brightness;
        addAt(Math.round(x + k), Math.round(y), colour[0] * f, colour[1] * f, colour[2] * f);
        addAt(Math.round(x), Math.round(y + k), colour[0] * f, colour[1] * f, colour[2] * f);
      }
    }
  }
}

function paintMeteor(x0, y0, x1, y1, colour) {
  const steps = 46;
  for (let i = 0; i < steps; i++) {
    const t = i / steps;
    glow(mix(x0, x1, t), mix(y0, y1, t), mix(1.2, 6.5, t), colour, 0.16 * (1 - t) + 0.02);
  }
  glow(x0, y0, 7, WHITE, 0.8);
}

// ---------------------------------------------------------------- galaxy
// A logarithmic spiral: the arm phase winds as twist * ln(r), three arms,
// ridges sharpened with a 6th-power cosine so the arms stay thin and bright
// instead of melting into a blob. Dust lanes ride a phase-shifted copy of
// the same spiral and carve dark channels against the arms; grain breaks
// the surface so nothing reads as a smooth airbrushed disc.

function paintGalaxy(cx, cy, radius, seed) {
  const TILT = 0.8, ARMS = 3, TWIST = 2.9, ROT = -0.55, POWER = 1.1;
  const cosr = Math.cos(ROT), sinr = Math.sin(ROT);
  const rampPal = [[0, [1.0, 0.97, 0.9]], [0.1, GOLD], [0.3, PINK], [0.55, MAGENTA], [0.8, VIOLET], [1, CYAN]];
  const x0 = Math.max(0, Math.floor(cx - radius)), x1 = Math.min(SIZE - 1, Math.ceil(cx + radius));
  const y0 = Math.max(0, Math.floor(cy - radius)), y1 = Math.min(SIZE - 1, Math.ceil(cy + radius));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx, dy = (y - cy) / TILT;
      const lx = dx * cosr + dy * sinr, ly = -dx * sinr + dy * cosr;
      const r = Math.sqrt(lx * lx + ly * ly) / radius;
      if (r >= 1) continue;
      const theta = Math.atan2(ly, lx);
      const phase = ARMS * (theta - TWIST * Math.log(r + 0.045));
      const onArm = 0.5 + 0.5 * Math.cos(phase);
      // Bright thin ridges on a broader spiral base, plus a faint floor so
      // the inter-arm disc glows instead of leaving a dark moat around the
      // core (which would make the galaxy read as a ring, not a spiral).
      const arms = Math.pow(onArm, 6) * 1.55 + Math.pow(onArm, 2) * 0.6 + 0.06;
      // Grain: clumpy starfields, clamped so dark patches stay in the disc.
      const grain = clamp((fbm(x + seed * 131, y + seed * 57, 9) - 0.32) * 1.9, 0.12, 1.3);
      // Dust: a second spiral, shifted 1.25 rad behind the arms, gated by
      // its own cloud field and kept out of the very centre.
      const laneShape = Math.pow(0.5 + 0.5 * Math.cos(phase - 1.25), 2);
      const lane = 1 - 0.62 * laneShape * sstep(0.5, 0.75, fbm(x + 4000 + seed * 71, y + 2600, 7)) * sstep(0.03, 0.25, r);
      const core = Math.exp(-r * r * 42) * 1.3 + Math.exp(-r * r * 160) * 0.95;
      const disc = arms * Math.exp(-r * 1.65) * grain * lane;
      const halo = Math.exp(-r * 3.4) * 0.07;
      // The edge fades across the outer 30% so the disc has no hard rim.
      const inten = (disc + core + halo) * sstep(1.0, 0.7, r) * POWER;
      if (inten < 0.004) continue;
      const c = gradient(rampPal, r * 1.12);
      addAt(x, y, c[0] * inten, c[1] * inten, c[2] * inten);
    }
  }
  // Star-forming knots sprinkled along the arm phase: the bright beads
  // that let the eye trace the spiral even at thumbnail size.
  const rand = rng(seed * 977 + 13);
  for (let i = 0; i < 260; i++) {
    const rr = Math.pow(rand(), 0.62);
    const armIndex = Math.floor(rand() * ARMS);
    const th = (armIndex * 2 * Math.PI) / ARMS + TWIST * Math.log(rr + 0.045) + (rand() - 0.5) * 0.34;
    const lx = Math.cos(th) * rr * radius, ly = Math.sin(th) * rr * radius;
    const px = cx + lx * cosr - ly * sinr, py = cy + (lx * sinr + ly * cosr) * TILT;
    const pick = rand();
    const colour = pick < 0.45 ? PINK : pick < 0.6 ? CYAN : WHITE;
    glow(px, py, 1.4 + rand() * 2.6, colour, (0.35 + rand() * 0.6) * POWER);
  }
  glow(cx, cy, radius * 0.13, [1.0, 0.95, 0.85], 0.7 * POWER);
  glow(cx, cy, radius * 0.36, GOLD, 0.12 * POWER);
}

// ------------------------------------------------------------ the match
// The flame sits at the bottom centre; everything above it is its light.

function paintMatchScene() {
  paintBackdrop();
  paintStarfield(650, 42, 0.8);

  paintGalaxy(512, 336, 452, 5);
  paintMeteor(168, 150, 356, 96, CYAN);

  // A soft cone of light binds the flame to the disc: eleven wide glows
  // climbing from the flame head to the galaxy's lower rim, cooling as
  // they rise from orange through magenta to violet.
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const colour = t < 0.4 ? [1.0, 0.55, 0.15] : t < 0.75 ? MAGENTA : VIOLET;
    glow(512 + Math.sin(t * 5.2) * 14, 892 - t * 420, 34 + t * 74, colour, 0.055);
  }

  // The spark column: about a thousand sparks leave the flame in a narrow
  // stream and spread as they climb, cooling gold -> orange -> magenta ->
  // cyan, until the topmost sparks are indistinguishable from stars.
  const rand = rng(2024);
  for (let i = 0; i < 1050; i++) {
    const t = Math.pow(rand(), 0.8);
    const y = 908 - t * 470;
    const spread = 10 + t * 155;
    const x = 512 + (rand() - 0.5) * 2 * spread + Math.sin(t * 8.5 + rand() * 0.6) * 22 * t;
    const colour = t < 0.22 ? GOLD : t < 0.5 ? [1.0, 0.5, 0.25] : t < 0.78 ? MAGENTA : CYAN;
    glow(x, y, 0.9 + rand() * 2.2, colour, (1 - t * 0.55) * (0.35 + rand() * 0.8));
  }

  // The matchstick: a tapered capsule leaning slightly, painted dark over
  // the sparks, then a narrower, warmer pass along its lit edge.
  const stickPass = (offset, width, colour, alpha) => {
    const ax = 486 + offset, ay = 1030, bx = 510 + offset, by = 924;
    const pad = width + 2;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - pad)), x1 = Math.min(SIZE - 1, Math.ceil(Math.max(ax, bx) + pad));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - pad)), y1 = Math.min(SIZE - 1, Math.ceil(Math.max(ay, by) + pad));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const [d, t] = segDist(x, y, ax, ay, bx, by);
        const half = mix(width, width * 0.78, t);
        if (d >= half) continue;
        const a = alpha * sstep(half, half * 0.55, d);
        const idx = (y * SIZE + x) * 3;
        frame[idx] = mix(frame[idx], colour[0], a);
        frame[idx + 1] = mix(frame[idx + 1], colour[1], a);
        frame[idx + 2] = mix(frame[idx + 2], colour[2], a);
      }
    }
  };
  stickPass(0, 13.5, [0.1, 0.045, 0.016], 1);
  stickPass(-4.5, 6.5, [0.34, 0.16, 0.05], 0.85);

  // The head of the match, and the flame standing on it: layered ellipses
  // from a wide orange body down through yellow to a white-hot core, with
  // the little blue root every real flame has at its base.
  blob(513, 914, 16.5, 25, -0.14, [0.23, 0.05, 0.03], 1);
  blob(509, 904, 8, 13, -0.14, [0.45, 0.12, 0.05], 0.9);
  glow(514, 868, 138, [1.0, 0.45, 0.1], 0.55);
  glow(514, 868, 62, [1.0, 0.6, 0.16], 0.7);
  blob(514, 862, 30, 52, 0.05, [1.0, 0.52, 0.08], 0.95);
  blob(514, 874, 18, 35, 0.03, [1.0, 0.8, 0.25], 0.98);
  blob(514, 886, 9, 18, 0, [1.0, 0.97, 0.88], 1);
  blob(514, 902, 7, 9, 0, [0.35, 0.6, 1.0], 0.95);
  glow(514, 818, 19, [1.0, 0.62, 0.15], 0.55);
}

// ------------------------------------------------------------ post chain
// Threshold bloom (only light above 0.6 blooms), a gentle exposure, a
// Reinhard shoulder, a saturation lift and a vignette to hold the corners.

function finish() {
  const DOWN = 4, SW = SIZE / DOWN, SH = SIZE / DOWN;
  const small = new Float32Array(SW * SH * 3);
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < DOWN; ky++) {
        for (let kx = 0; kx < DOWN; kx++) {
          const i = ((y * DOWN + ky) * SIZE + x * DOWN + kx) * 3;
          r += Math.max(0, frame[i] - 0.6);
          g += Math.max(0, frame[i + 1] - 0.6);
          b += Math.max(0, frame[i + 2] - 0.6);
        }
      }
      const o = (y * SW + x) * 3, n = DOWN * DOWN;
      small[o] = r / n; small[o + 1] = g / n; small[o + 2] = b / n;
    }
  }
  // Two rounds of separable box blur grow the bloom's reach.
  const bloom = new Float32Array(small.length);
  const RAD = 5;
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? small : bloom;
    const tmp = new Float32Array(small.length);
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -RAD; k <= RAD; k++) {
          const i = (y * SW + clamp(x + k, 0, SW - 1)) * 3;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
        const o = (y * SW + x) * 3;
        tmp[o] = r / n; tmp[o + 1] = g / n; tmp[o + 2] = b / n;
      }
    }
    for (let y = 0; y < SH; y++) {
      for (let x = 0; x < SW; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -RAD; k <= RAD; k++) {
          const i = (clamp(y + k, 0, SH - 1) * SW + x) * 3;
          r += tmp[i]; g += tmp[i + 1]; b += tmp[i + 2]; n++;
        }
        const o = (y * SW + x) * 3;
        bloom[o] = r / n; bloom[o + 1] = g / n; bloom[o + 2] = b / n;
      }
    }
  }
  const out = new Uint8Array(SIZE * SIZE * 3);
  const half = SIZE / 2, maxDist = Math.sqrt(half * half + half * half);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 3;
      const bi = (Math.floor(y / DOWN) * SW + Math.floor(x / DOWN)) * 3;
      let r = (frame[i] + bloom[bi] * 1.25) * 1.18;
      let g = (frame[i + 1] + bloom[bi + 1] * 1.25) * 1.18;
      let b = (frame[i + 2] + bloom[bi + 2] * 1.25) * 1.18;
      r = r / (1 + r); g = g / (1 + g); b = b / (1 + b); // Reinhard
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = luma + (r - luma) * 1.14;
      g = luma + (g - luma) * 1.14;
      b = luma + (b - luma) * 1.14;
      const d = Math.sqrt((x - half) * (x - half) + (y - half) * (y - half)) / maxDist;
      const vig = 1 - 0.34 * sstep(0.52, 1.02, d);
      out[i] = clamp(Math.pow(clamp(r, 0, 1), 0.8) * vig, 0, 1) * 255;
      out[i + 1] = clamp(Math.pow(clamp(g, 0, 1), 0.8) * vig, 0, 1) * 255;
      out[i + 2] = clamp(Math.pow(clamp(b, 0, 1), 0.8) * vig, 0, 1) * 255;
    }
  }
  return out;
}

// ------------------------------------------------------------ PNG writer
// A small encoder of my own: CRC32 table, chunk framing, and per-row
// filter selection among None/Sub/Up/Paeth scored by the sum of the
// filtered bytes read as signed magnitudes, then deflate at level 9.

const CRC_TABLE = (() => {
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
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function encodePng(pixels, w, h) {
  const stride = w * 3;
  const raw = Buffer.alloc((stride + 1) * h);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    let bestType = 0, bestScore = Infinity, bestRow = null;
    for (const type of [0, 1, 2, 4]) {
      const filt = new Uint8Array(stride);
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 3 ? row[i - 3] : 0, b = prev[i], c = i >= 3 ? prev[i - 3] : 0;
        const pred = type === 0 ? 0 : type === 1 ? a : type === 2 ? b : paeth(a, b, c);
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
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Box downscale by an integer factor, used only if the full-size PNG
// would come too close to the 1 MiB gate.
function halve(pixels, w, h) {
  const nw = Math.floor(w / 2), nh = Math.floor(h / 2);
  const out = new Uint8Array(nw * nh * 3);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < 2; ky++) {
        for (let kx = 0; kx < 2; kx++) {
          const i = ((y * 2 + ky) * w + x * 2 + kx) * 3;
          r += pixels[i]; g += pixels[i + 1]; b += pixels[i + 2];
        }
      }
      const o = (y * nw + x) * 3;
      out[o] = r / 4; out[o + 1] = g / 4; out[o + 2] = b / 4;
    }
  }
  return [out, nw, nh];
}

// ------------------------------------------------------------------ main

paintMatchScene();

const pixels = finish();
let png = encodePng(pixels, SIZE, SIZE);
let dims = [SIZE, SIZE];
if (png.length > 1000000) {
  const [small, w2, h2] = halve(pixels, SIZE, SIZE);
  const png2 = encodePng(small, w2, h2);
  if (png2.length < png.length) { png = png2; dims = [w2, h2]; }
}

const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'entry.png'), png);
console.log(`entry.png written: ${png.length} bytes at ${dims[0]}x${dims[1]}`);
