/**
 * Offline parameter tuning. Loads every cached fixture (odds + result,
 * produced by `npm run backtest`) and grid-searches the detector's
 * WINDOW_MINUTES x Z_SCORE space, grading each combination by PRE-MATCH
 * closing-line value - the honest edge metric (in-play numbers are
 * structurally inflated by clock decay, so they are deliberately not part
 * of the objective).
 *
 * Everything runs from .cache/ - no API calls - so the whole grid takes
 * seconds and is exactly reproducible.
 *
 * Run: npm run backtest (once, to populate the cache), then npm run tune
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();
import { detectSharpMoves } from "./detector";
import { OddsPoint } from "./types";

const MARKET_RE = new RegExp(process.env.ODDS_MARKET_REGEX || "^1X2_PARTICIPANT_RESULT$", "i");
const FLOOR = Number(process.env.PROBABILITY_THRESHOLD || 0.02);

const WINDOWS_MIN = [15, 30, 60, 120];
const Z_SCORES = [0, 2, 2.5, 3, 4, 5];
/** A combo needs at least this many flags before its stats mean anything. */
const MIN_FLAGS = 15;

interface Fixture {
  fixtureId: string;
  label: string;
  winner: string;
  resultSource: string;
  prematch: OddsPoint[]; // pre-match 1x2 ticks, time-sorted
  closing: Map<string, number>; // selection -> closing-line implied probability
}

function loadFixtures(): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const file of fs.readdirSync(".cache")) {
    const m = file.match(/^odds-(\d+)-h\d+\.json$/);
    if (!m) continue;
    const fixtureId = m[1];
    const resultFile = path.join(".cache", `result-${fixtureId}.json`);
    if (!fs.existsSync(resultFile)) continue;
    const result = JSON.parse(fs.readFileSync(resultFile, "utf-8"));
    const points: OddsPoint[] = JSON.parse(
      fs.readFileSync(path.join(".cache", file), "utf-8")
    ).filter((p: OddsPoint) => MARKET_RE.test(p.market));
    points.sort((a, b) => a.timestamp - b.timestamp);

    const prematch = points.filter((p) => !p.inRunning);
    const closing = new Map<string, number>();
    for (const p of prematch) closing.set(p.selection, 1 / p.decimalOdds); // last write wins
    if (prematch.length === 0) continue;

    fixtures.push({
      fixtureId,
      label: result.label ?? fixtureId,
      winner: result.winningSelection,
      resultSource: result.source,
      prematch,
      closing,
    });
  }
  return fixtures;
}

function evaluate(fixtures: Fixture[], windowMin: number, zScore: number) {
  let flags = 0;
  let hits = 0;
  const clvs: number[] = [];
  for (const f of fixtures) {
    const found = detectSharpMoves(f.prematch, {
      windowMs: windowMin * 60_000,
      probabilityThreshold: FLOOR,
      zScore,
    }).filter((fl) => fl.probabilityDelta > 0);
    for (const fl of found) {
      flags++;
      if (fl.selection === f.winner) hits++;
      const close = f.closing.get(fl.selection);
      if (close != null) clvs.push(close - fl.peakProbability);
    }
  }
  const meanClv = clvs.length ? clvs.reduce((a, b) => a + b, 0) / clvs.length : 0;
  const positive = clvs.length ? clvs.filter((c) => c > 0).length / clvs.length : 0;
  return { flags, hitRate: flags ? hits / flags : 0, meanClv, positive };
}

function main() {
  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    throw new Error("No cached fixtures found - run `npm run backtest` first to populate .cache/.");
  }
  const bySource = fixtures.reduce<Record<string, number>>((acc, f) => {
    acc[f.resultSource] = (acc[f.resultSource] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `Tuning on ${fixtures.length} cached fixtures ` +
      `(${Object.entries(bySource).map(([k, v]) => `${v} ${k}`).join(", ")}), ` +
      `pre-match CLV objective, floor ${(FLOOR * 100).toFixed(1)}pp\n`
  );

  console.log("window  z      flags  hit%    mean CLV   CLV>0");
  console.log("------  -----  -----  ------  ---------  -----");
  const results: { windowMin: number; zScore: number; r: ReturnType<typeof evaluate> }[] = [];
  for (const windowMin of WINDOWS_MIN) {
    for (const zScore of Z_SCORES) {
      const r = evaluate(fixtures, windowMin, zScore);
      results.push({ windowMin, zScore, r });
      console.log(
        `${String(windowMin).padStart(4)}m   ${String(zScore || "off").padEnd(5)}  ` +
          `${String(r.flags).padStart(5)}  ${(r.hitRate * 100).toFixed(1).padStart(6)}  ` +
          `${((r.meanClv >= 0 ? "+" : "") + (r.meanClv * 100).toFixed(2) + "pp").padStart(9)}  ` +
          `${(r.positive * 100).toFixed(0).padStart(4)}%`
      );
    }
  }

  const eligible = results.filter((x) => x.r.flags >= MIN_FLAGS);
  const best = eligible.sort((a, b) => b.r.meanClv - a.r.meanClv)[0];
  if (best) {
    console.log(
      `\nRecommended (best mean pre-match CLV with >= ${MIN_FLAGS} flags): ` +
        `WINDOW_MINUTES=${best.windowMin} Z_SCORE=${best.zScore}` +
        ` -> ${best.r.flags} flags, ${(best.r.hitRate * 100).toFixed(1)}% hit, ` +
        `${(best.r.meanClv * 100).toFixed(2)}pp mean CLV, ${(best.r.positive * 100).toFixed(0)}% positive`
    );
    console.log(
      "Caveat: this is a single-tournament sample tuned in-sample; treat it as a " +
        "sensible default, not a proven edge. Out-of-sample validation needs the " +
        "next tournament (or leagues on mainnet)."
    );
  } else {
    console.log(`\nNo combination produced >= ${MIN_FLAGS} flags - grid may need looser values.`);
  }
}

main();
