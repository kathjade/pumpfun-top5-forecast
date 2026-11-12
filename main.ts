// Deterministic trajectory + newcomer-field forecast for pumpfun-top5-forecast-01.
// Uses only the supplied history and Node's standard library; no network or installs.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const task = JSON.parse(readFileSync(join(inputDir, 'task.json'), 'utf8')) as {
  places: number; output: string; size: { edges: number[] }; reads: string[];
};
type Row = { rank: number; mint: string; market_cap_lamports: string; created_at: string; venue: string; mayhem?: boolean };
type Mark = { at: string; ok: boolean; rows: Row[] | null };
const marks: Mark[] = readFileSync(join(inputDir, 'history.ndjson'), 'utf8').trim().split('\n')
  .filter(Boolean).map((line) => JSON.parse(line) as Mark).filter((m) => m.ok && Array.isArray(m.rows));
if (!marks.length) throw new Error('history contains no successful marks');
const chart = [...marks.at(-1)!.rows!].sort((a, b) => a.rank - b.rank);
if (chart.length < task.places) throw new Error('latest chart is too small');

const logCap = (r: Row): number => Math.log10(Number(BigInt(r.market_cap_lamports))) - 9;
const millis = (s: string): number => Date.parse(s);
const observed = new Map<string, Array<{ t: number; x: number; row: Row }>>();
for (const mark of marks) for (const row of mark.rows ?? []) {
  const xs = observed.get(row.mint) ?? [];
  xs.push({ t: millis(mark.at), x: logCap(row), row }); observed.set(row.mint, xs);
}
const cutoff = millis(marks.at(-1)!.at);
const latestRows = new Map<string, Row>();
for (const mark of marks) for (const row of mark.rows ?? []) latestRows.set(row.mint, row);
// Include every mint the supplied history has ever ranked, not just the final chart.
const candidates = [...observed.keys()].map((mint) => {
  const row = latestRows.get(mint)!;
  const all = observed.get(mint) ?? [];
  const xs = all.filter((x) => x.t <= cutoff).slice(-12);
  const staleHours = Math.max(0, (cutoff - (all.at(-1)?.t ?? cutoff)) / 3_600_000);
  let slope = 0, variance = 0;
  if (xs.length >= 2) {
    const first = xs[0]!, last = xs.at(-1)!;
    const hours = Math.max((last.t - first.t) / 3_600_000, 1 / 6);
    slope = (last.x - first.x) / hours;
    const changes: number[] = [];
    for (let i = 1; i < xs.length; i++) {
      const a = xs[i - 1]!, b = xs[i]!;
      const dt = Math.max((b.t - a.t) / 3_600_000, 1 / 6);
      changes.push((b.x - a.x) / Math.sqrt(dt));
    }
    const mean = changes.reduce((a, b) => a + b, 0) / changes.length;
    variance = changes.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, changes.length - 1);
  }
  const age = Math.max(0, (cutoff - millis(row.created_at)) / 3_600_000);
  const cap = logCap(row);
  const pool = row.venue === 'pool' || row.mayhem === true;
  // Long-horizon trend is strongly shrunk: short pump bursts rarely persist for 7-13 hours.
  const drift = Math.max(-0.075, Math.min(0.075, slope * 0.075 - 0.025 - Math.max(0, age - 2) * 0.002));
  const vol = Math.max(pool ? 0.16 : 0.24, Math.min(0.62, Math.sqrt(variance || 0.16) * (pool ? 0.55 : 0.72)));
  const survival = Math.max(0.30, Math.min(0.985,
    (pool ? 0.985 : 0.95) - Math.max(0, age - 1) * (pool ? 0.002 : 0.008) - staleHours * (pool ? 0.04 : 0.10)));
  const staleAdjustedCap = cap - Math.min(1.5, staleHours * (pool ? 0.10 : 0.22));
  return { mint: row.mint, row, cap: staleAdjustedCap, age, pool, drift, vol, survival };
});

// Fixed-seed PRNG keeps output byte-identical across runs on the same history.
let state = 0x6d2b79f5;
for (const ch of marks.at(-1)!.at) state = (Math.imul(state ^ ch.charCodeAt(0), 0x45d9f3b) >>> 0);
const random = (): number => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 4294967296; };
const normal = (): number => {
  const u = Math.max(random(), 1e-12), v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));
const bins = task.size.edges.length + 1;
const horizons = task.reads.map((_, i) => 7 + i);
const sims = 900;
const counts = Array.from({ length: task.places }, () => new Map<string, number>());
const sizeCounts = Array.from({ length: task.places }, () => new Float64Array(bins));
const rankWeight = new Map<string, number>();
const top5 = chart.slice(0, task.places).map((r) => r.mint);
const lastTopLog = logCap(chart[0]!);

for (let sim = 0; sim < sims; sim++) {
  const values = candidates.map((c) => c.cap);
  const active = candidates.map(() => true);
  let answerIndex = 0;
  for (let hour = 1; hour <= Math.max(...horizons); hour++) {
    for (let j = 0; j < candidates.length; j++) {
      if (!active[j]) continue;
      const c = candidates[j]!;
      let x = values[j]! + c.drift + c.vol * normal();
      if (random() < (c.pool ? 0.012 : 0.025)) x += 0.65 + Math.abs(normal()) * 0.48;
      if (random() < (c.pool ? 0.018 : 0.07)) x -= 0.65 + Math.abs(normal()) * 0.60;
      values[j] = clamp(x, 0.2, 7.2);
      if (random() > c.survival) active[j] = false;
    }
    if (!horizons.includes(hour)) continue;
    // A latent field represents launches after the final historical mark, whose mints are unknowable.
    const field: number[] = [];
    const fieldCount = Math.round(14 + hour * 2.0);
    for (let k = 0; k < fieldCount; k++) {
      let x = lastTopLog - 2.15 + hour * 0.045 + 0.90 * normal();
      if (random() < 0.035) x += 0.8 + Math.abs(normal()) * 0.45;
      field.push(clamp(x, 0.2, 7.0));
    }
    const ranked: Array<{ mint?: string; x: number }> = [];
    for (let j = 0; j < candidates.length; j++) if (active[j]) ranked.push({ mint: candidates[j]!.mint, x: values[j]! });
    for (const x of field) ranked.push({ x });
    ranked.sort((a, b) => b.x - a.x || (a.mint ?? '').localeCompare(b.mint ?? ''));
    for (let place = 0; place < task.places; place++) {
      const winner = ranked[place]; if (!winner) continue;
      if (winner.mint) {
        const m = counts[place]!; m.set(winner.mint, (m.get(winner.mint) ?? 0) + 1);
        rankWeight.set(winner.mint, (rankWeight.get(winner.mint) ?? 0) + 1 / (place + 1));
      }
      const x = winner.x;
      let bin = 0;
      while (bin < task.size.edges.length && x >= task.size.edges[bin]!) bin++;
      sizeCounts[place]![bin] += 1;
    }
    answerIndex++;
  }
}

// Average over the seven answer horizons; retain substantial unnamed mass for unseen/new coins.
const knownMass = [0.27, 0.31, 0.35, 0.39, 0.42];
const probabilities: Array<{ mint: string; place: number; p: number }> = [];
for (let place = 0; place < task.places; place++) {
  const dist = [...counts[place]!.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = dist.reduce((n, [, c]) => n + c, 0) || 1;
  for (const [mint, n] of dist.slice(0, 75)) {
    const p = Math.floor((n / total * knownMass[place]!) * 1e6) / 1e6;
    if (p > 0) probabilities.push({ mint, place: place + 1, p });
  }
}
const sizes: Array<{ place: number; bin: number; p: number }> = [];
for (let place = 0; place < task.places; place++) {
  for (let bin = 0; bin < bins; bin++) {
    const p = Math.floor((sizeCounts[place]![bin]! / (sims * horizons.length)) * 1e6) / 1e6;
    if (p > 0) sizes.push({ place: place + 1, bin, p });
  }
}
const chosen = [...rankWeight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, task.places).map(([m]) => m);
for (const mint of top5) if (chosen.length < task.places && !chosen.includes(mint)) chosen.push(mint);
const output = { probabilities, top5: chosen, sizes };
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, task.output), `${JSON.stringify(output)}\n`);
