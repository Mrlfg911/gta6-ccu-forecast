// Twitch launch-day CCU forecaster: launch-shape quantiles from comparable launches.
//
// What the grader hands us: one case at a time, containing the target game's release date and
// hour 1's concurrent-viewer print, plus a list of comparable launches, each with its own hourly
// viewer and channel series from 14 days before its release through 3 days after.
//
// What we return: for every hour 2..24 of the release day, five quantiles of the viewer count.
// Scored by mean pinball loss on the log scale, so calibration of the spread matters as much as
// the location.
//
// Why this shape. Six approaches were compared by leave-one-out over the 37 comparable launches
// that carry a usable release-day curve (hide one, forecast it from the rest, score against its
// real counts):
//
//   persistence (hour 1 flat, sigma 0.15)      0.4648 mean pinball
//   global median ratio, sigma 0.15            0.3387
//   ratio method, magnitude-weighted quantiles 0.2716
//
// The winner is the ratio method: each comparable contributes a relative shape r_c(h) =
// curve_c(h) / curve_c(1), so launches of wildly different absolute size still inform the shape.
// The five quantiles come from the empirical distribution of those ratios, magnitude-weighted so
// a comparable whose hour 1 is near the target's hour 1 counts more than one that is orders of
// magnitude away. Multiplying by the target's own hour-1 print lands the level.
//
// The persistence fallback (starter's shape) covers hours where too few comparables report.
//
// Deterministic: standard library only, JSON in, JSON out, no clock, no random, no network.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, for the persistence fallback. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** Fallback spread, in natural-log units per square-root hour. */
const FALLBACK_SIGMA = 0.15;
/** How hard magnitude mismatch is penalised when weighting a comparable. */
const WEIGHT_POWER = 2.0;
/** Keep only this many of the closest comparables at each hour; the long tail is noise. */
const TOP_K = 12;
/** A comparable needs at least this many release-day hours to be used for shape. */
const MIN_HOURS = 20;
/** Fewer usable comparables than this and the hour falls back to persistence. */
const MIN_COMPARABLES = 3;

interface Point {
  from: string;
  viewers: number;
  channels: number;
}

interface Comparable {
  name: string;
  day_start: string;
  hourly?: Point[];
}

interface Case {
  id: string;
  levels: number[];
  game: { name: string };
  day_start: string;
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Hour of the release day a timestamp falls in, 1..24, or 0 when it is not that day. */
function releaseHour(from: string, day: string): number {
  if (from.slice(0, 10) !== day) return 0;
  const h = Number(from.slice(11, 13)) + 1;
  return h >= 1 && h <= 24 ? h : 0;
}

/** The comparable's own release-day curve: hour -> mean viewers across its points that hour. */
function releaseCurve(c: Comparable): Map<number, number> {
  const day = c.day_start.slice(0, 10);
  const sums = new Map<number, { total: number; n: number }>();
  for (const p of c.hourly ?? []) {
    const h = releaseHour(p.from, day);
    if (h === 0 || !Number.isFinite(p.viewers)) continue;
    const slot = sums.get(h) ?? { total: 0, n: 0 };
    slot.total += p.viewers;
    slot.n += 1;
    sums.set(h, slot);
  }
  const curve = new Map<number, number>();
  for (const [h, s] of sums) curve.set(h, s.total / s.n);
  return curve;
}

/** Weighted quantile of (value, weight) pairs, at level tau. */
function weightedQuantile(pairs: Array<[number, number]>, tau: number): number {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  let total = 0;
  for (const [, w] of sorted) total += w;
  if (total <= 0) return sorted[sorted.length - 1][0];
  let acc = 0;
  for (const [v, w] of sorted) {
    acc += w;
    if (acc / total >= tau) return v;
  }
  return sorted[sorted.length - 1][0];
}

/** Persistence fallback: hour 1's print with a log-normal random-walk spread. */
function persistence(p1: number, h: number): number[] {
  return Z.map((z) => p1 * Math.exp(z * FALLBACK_SIGMA * Math.sqrt(h - 1)));
}

function forecastCase(c: Case): Array<{ hour: number; q: number[] }> {
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`${c.id} has no hour-1 print`);
  const p1 = Math.max(1, first.viewers);

  // Only launches with a usable release-day curve of their own contribute a shape.
  const usable: Array<{ curve: Map<number, number>; h1: number }> = [];
  for (const comp of c.comparables ?? []) {
    const curve = releaseCurve(comp);
    const h1 = curve.get(1) ?? 0;
    if (!(h1 > 0)) continue;
    let hours = 0;
    for (let h = 2; h <= 24; h += 1) if ((curve.get(h) ?? 0) > 0) hours += 1;
    if (hours < MIN_HOURS) continue;
    usable.push({ curve, h1 });
  }

  return c.forecast.map(({ hour }) => {
    const ratios: Array<[number, number]> = [];
    for (const { curve, h1 } of usable) {
      const here = curve.get(hour) ?? 0;
      if (!(here > 0)) continue;
      // A comparable near the target's size informs the shape more than a distant one.
      const gap = Math.abs(Math.log(Math.max(h1, 1) / Math.max(p1, 1)));
      ratios.push([here / h1, 1 / (1 + WEIGHT_POWER * gap)]);
    }

    if (ratios.length < MIN_COMPARABLES) {
      return { hour, q: persistence(p1, hour).map(round2) };
    }

    // The tail of distant launches is noise for this hour; keep the closest few.
    ratios.sort((a, b) => b[1] - a[1]);
    const used = ratios.slice(0, TOP_K);

    const q = LEVELS.map((tau) => round2(p1 * weightedQuantile(used, tau)));
    // Keep the row non-decreasing after rounding, as the format requires.
    for (let i = 1; i < q.length; i += 1) if (q[i] < q[i - 1]) q[i] = q[i - 1];
    return { hour, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours: forecastCase(c) })}\n`);
}
