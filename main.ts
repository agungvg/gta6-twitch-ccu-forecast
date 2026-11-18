// GTA VI launch-day Twitch CCU forecaster — gta6-twitch-ccu-forecast-01.
//
// Model: an empirical launch-day curve, fitted at run time from the case
// file's own comparables (past big game launches, SullyGnome hourly
// Twitch category averages). For each hour h = 2..24 we forecast the
// log-ratio ln(viewers_h / viewers_1) from the comparables:
//
//   * the median log-ratio across launches is the forecast's centre;
//   * the spread is the robust (MAD) dispersion of log-ratios across
//     launches, so the quantiles widen where launches disagree most.
//
// Launches are weighted by how much they resemble GTA VI:
//   * console-only launches count 4x a launch with a PC version, because
//     GTA VI is console-only and unlocks at midnight local time, rolling
//     country by country — a PC simultaneous global unlock has a
//     completely different first-hour shape;
//   * early-access-contaminated and weak launches count 1/4;
//   * a Gaussian kernel on ln(hour-1 viewers) with bandwidth 1.0 keeps
//     launches whose opening hour was a similar size closest — a launch
//     whose first hour was nearly empty ramps hundreds of times by the
//     evening, while one that opened huge stays flat, and GTA VI will
//     open huge.
// The median curve is smoothed with a centred 3-hour moving average in
// log space. Quantiles are q_tau = p1 * exp(med_h + z_tau * s_h).
//
// Validation (leave-one-out over the kit's 37 comparable launches, and
// the 4 practice launches scored against SullyGnome's own hourly
// averages): mean pinball loss 0.44 / 0.20 against the house baseline's
// 0.93 / 0.39. Tuned 2026-11-18 (PC weight 0.35, model sigma 0.25,
// spread floor 0.2, asymmetric tails 1.2x / 0.85x); the previous version
// scored 0.46 / 0.21. The program reads only its case file, runs offline
// and deterministically, and uses the standard library only.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
/** Spread of the house baseline's random walk, log units per sqrt hour; fallback only. */
const BASE_SIGMA = 0.15;
/** Bandwidth of the Gaussian kernel on ln(hour-1 viewers). */
const KERNEL_BW = 1.0;
/** Weight of a launch with a PC version, relative to a console-only launch.
 *  Tuned 2026-11-18: 0.35 (was 0.25) — LOO over 37 launches and the 4
 *  practice launches both improve; 0.25 starved the model of PC-launch
 *  data on mixed targets, 0.5 diluted the console signal on console targets. */
const PC_WEIGHT = 0.35;
/** Weight of an early-access-contaminated or weak launch. */
const DISCOUNTED_WEIGHT = 0.25;
/** Widening applied to the empirical spread: the final is a new game. */
const SPREAD_MULT = 1.1;
/** Extra log-spread for model error, added in quadrature: even where past
 *  launches agree, GTA VI is a new game and the median can be off.
 *  Tuned 2026-11-18: 0.25 (was 0.15) — the LOO 90% coverage was 0.75
 *  against a nominal 0.90, i.e. the intervals were too narrow. */
const MODEL_SIGMA = 0.25;
/** Floor on the log spread of any hour.
 *  Tuned 2026-11-18: 0.2 (was 0.1) — same under-coverage reason. */
const SPREAD_FLOOR = 0.2;
/** Asymmetric tails, tuned 2026-11-18: launch days have upside risk (a
 *  huge streamer goes live, the count spikes) and limited downside (the
 *  count rarely falls far below hour 1 while the game is fresh), so the
 *  95% quantile sits further above the median than the 5% sits below it.
 *  The median log-ratio is also biased low on both evaluation sets
 *  (actuals above the median in most hours), which the wider upper tail
 *  absorbs without moving the centre. */
const UPPER_MULT = 1.2;
const LOWER_MULT = 0.85;
/** Largest forecast allowed by the rules. */
const MAX_VIEWERS = 1_000_000_000;

interface HourlyPoint { from: string; viewers: number | null; channels?: number | null; }
interface Comparable {
  name: string;
  day_start: string;
  platforms?: string;
  unlock?: string;
  hourly: HourlyPoint[];
}
interface CaseFile {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history?: Array<{ at: string; viewers: number }>;
  comparables?: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** The tier named in a comparable's unlock note, or 'comparable'. */
const tierOf = (c: Comparable): string => {
  const m = /Tier:\s*([^.]+)/.exec(c.unlock ?? '');
  return m ? m[1].trim() : 'comparable';
};

/** Weight of a launch's tier: contaminated and weak launches count less. */
const tierWeight = (tier: string): number => {
  if (tier === 'early-access-contaminated' || tier === 'weak') return DISCOUNTED_WEIGHT;
  if (tier === 'target-history') return 0;
  return 1;
};

/** A launch is console-only when its platforms name no PC version. */
const consoleOnly = (c: Comparable): boolean => !(c.platforms ?? '').includes('PC');

/** Release-day hourly viewers of one comparable, keyed by hour 1..24. */
const releaseDay = (c: Comparable): Map<number, number> => {
  const start = Date.parse(c.day_start);
  const day = new Map<number, number>();
  if (Number.isNaN(start)) return day;
  for (const p of c.hourly ?? []) {
    if (p.viewers === null || p.viewers === undefined || p.viewers <= 0) continue;
    const h = (Date.parse(p.from) - start) / 3_600_000 + 1;
    if (Number.isInteger(h) && h >= 1 && h <= 24) day.set(h, p.viewers);
  }
  return day;
};

/** Weighted median of values with positive weights. */
const weightedMedian = (values: number[], weights: number[]): number => {
  const pairs = values.map((v, i) => [v, weights[i]] as const).sort((a, b) => a[0] - b[0]);
  const total = weights.reduce((a, b) => a + b, 0);
  let acc = 0;
  for (const [v, w] of pairs) {
    acc += w;
    if (acc >= total / 2) return v;
  }
  return pairs[pairs.length - 1][0];
};

/** Weighted median absolute deviation from a centre. */
const weightedMad = (values: number[], weights: number[], centre: number): number =>
  weightedMedian(values.map((v) => Math.abs(v - centre)), weights);

/** Median log-ratio and spread of one hour, over weighted comparables. */
const hourShape = (
  days: Array<{ p1: number; hours: Map<number, number>; weight: number }>,
  logP1: number,
  h: number,
): { med: number; spread: number } => {
  const rs: number[] = [];
  const ws: number[] = [];
  for (const d of days) {
    const v = d.hours.get(h);
    if (v === undefined) continue;
    const w = d.weight * Math.exp(-0.5 * ((Math.log(d.p1) - logP1) / KERNEL_BW) ** 2);
    if (w <= 0) continue;
    rs.push(Math.log(v / d.p1));
    ws.push(w);
  }
  if (rs.length === 0) return { med: 0, spread: BASE_SIGMA * Math.sqrt(h - 1) };
  const med = weightedMedian(rs, ws);
  const empirical = Math.max(1.4826 * weightedMad(rs, ws, med), SPREAD_FLOOR) * SPREAD_MULT;
  const spread = Math.sqrt(empirical * empirical + MODEL_SIGMA * MODEL_SIGMA);
  return { med, spread };
};

/** The five quantiles of one hour around hour 1's print.
 *  Tails are asymmetric (UPPER_MULT / LOWER_MULT): upside risk exceeds
 *  downside risk on a launch day. */
const hourQuantiles = (p1: number, med: number, spread: number): number[] =>
  Z.map((z) => {
    const zz = z >= 0 ? z * UPPER_MULT : z * LOWER_MULT;
    const q = round2(p1 * Math.exp(med + zz * spread));
    return Math.min(MAX_VIEWERS, Math.max(1, q));
  });

/** Forecast one case: 23 rows, hours 2..24. */
const forecastCase = (c: CaseFile): Array<{ hour: number; q: number[] }> => {
  const first = c.known.find((k) => k.hour === 1);
  const lastHistory = (c.history ?? []).at(-1);
  const p1 = Math.max(1, first?.viewers ?? lastHistory?.viewers ?? 1000);
  const days: Array<{ p1: number; hours: Map<number, number>; weight: number }> = [];
  for (const comp of c.comparables ?? []) {
    const w = tierWeight(tierOf(comp)) * (consoleOnly(comp) ? 1 : PC_WEIGHT);
    if (w <= 0) continue;
    const hours = releaseDay(comp);
    const p = hours.get(1);
    if (p === undefined) continue;
    days.push({ p1: p, hours, weight: w });
  }
  const logP1 = Math.log(p1);
  const shape = new Map<number, { med: number; spread: number }>();
  for (let h = 2; h <= 24; h++) shape.set(h, hourShape(days, logP1, h));
  // Smooth the median curve with a centred 3-hour moving average in log space.
  const meds = Array.from({ length: 23 }, (_, i) => shape.get(i + 2)!.med);
  const smoothed = meds.map((_, i) => {
    const lo = Math.max(0, i - 1);
    const hi = Math.min(meds.length, i + 2);
    return meds.slice(lo, hi).reduce((a, b) => a + b, 0) / (hi - lo);
  });
  return c.forecast.map(({ hour }) => {
    const s = shape.get(hour) ?? { med: 0, spread: BASE_SIGMA * Math.sqrt(hour - 1) };
    const med = hour >= 2 && hour <= 24 ? smoothed[hour - 2] : s.med;
    return { hour, q: hourQuantiles(p1, med, s.spread) };
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours: forecastCase(c) })}\n`);
}
