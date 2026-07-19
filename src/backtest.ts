/**
 * Runs the detector against completed fixtures and grades every flagged
 * move two ways:
 *
 * 1. Hit rate - did the flagged selection actually win? Intuitive but
 *    harsh: a genuinely correct 40%->48% signal still loses 52% of the
 *    time, so this needs hundreds of flags to mean anything.
 * 2. CLV (closing line value) - did the market KEEP moving in the flagged
 *    direction after we flagged? This grades against a continuous target,
 *    so it becomes statistically meaningful at tens of flags, and it's the
 *    metric professional traders actually use. Reference price:
 *      - pre-match flags: the closing line (last pre-kickoff tick)
 *      - in-play flags:   the price CLV_HORIZON_MINUTES after the flag
 *        (there is no "closing line" mid-match)
 *
 * Flags are reported PER REGIME (pre-match vs in-play) so the two can be
 * compared honestly. Caveat printed with the results: in-play CLV is
 * structurally inflated - once a team leads, its probability drifts toward
 * 100% as the clock runs down regardless of any skill in the flag.
 *
 * Run: npm run backtest
 * Requires .env: TXLINE_GUEST_JWT / TXLINE_API_TOKEN (from `npm run auth`)
 * and BACKTEST_FIXTURE_IDS (from `npm run fixtures`).
 */
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config();
import {
  fetchOddsHistory,
  fetchFixtureResult,
  fetchFixtures,
  deriveResultFromOdds,
} from "./oddsClient";
import { detectSharpMoves } from "./detector";
import { BacktestRow, OddsPoint } from "./types";

// Explicit list, or "auto" / empty = every completed fixture in the
// competition within the lookback window.
const FIXTURE_IDS = (process.env.BACKTEST_FIXTURE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s && s !== "auto");
const COMPETITION_ID = Number(process.env.COMPETITION_ID || 72);
const LOOKBACK_DAYS = Number(process.env.BACKTEST_LOOKBACK_DAYS || 45);
const DAY_MS = 86_400_000;

const WINDOW_MINUTES = Number(process.env.WINDOW_MINUTES || 60);
const PROBABILITY_THRESHOLD = Number(process.env.PROBABILITY_THRESHOLD || 0.02);
const Z_SCORE = Number(process.env.Z_SCORE || 3);
const CLV_HORIZON_MINUTES = Number(process.env.CLV_HORIZON_MINUTES || 30);

/** Price of `selection` at the reference moment for a flag. */
function referenceProbability(
  series: OddsPoint[], // one selection's ticks, sorted by time
  flagEnd: number,
  flagInRunning: boolean
): number | undefined {
  if (!flagInRunning) {
    // Closing line: the last pre-match tick.
    const closing = series.filter((p) => !p.inRunning).pop();
    return closing ? 1 / closing.decimalOdds : undefined;
  }
  // In-play: first tick at/after the horizon, else the last tick we have.
  const horizon = flagEnd + CLV_HORIZON_MINUTES * 60_000;
  const at = series.find((p) => p.timestamp >= horizon) ?? series[series.length - 1];
  return at && at.timestamp > flagEnd ? 1 / at.decimalOdds : undefined;
}

function summarize(rows: BacktestRow[], label: string): string {
  if (rows.length === 0) return `${label.padEnd(10)}  0 flags`;
  const hits = rows.filter((r) => r.correct).length;
  const clvs = rows.map((r) => r.clv).filter((c): c is number => c != null);
  const mean = clvs.reduce((a, b) => a + b, 0) / (clvs.length || 1);
  const sortedClv = [...clvs].sort((a, b) => a - b);
  const med = sortedClv.length ? sortedClv[Math.floor(sortedClv.length / 2)] : 0;
  const positive = clvs.filter((c) => c > 0).length;
  return (
    `${label.padEnd(10)}  ${String(rows.length).padStart(3)} flags | ` +
    `hit rate ${((hits / rows.length) * 100).toFixed(1)}% | ` +
    `CLV mean ${(mean * 100).toFixed(2)}pp median ${(med * 100).toFixed(2)}pp | ` +
    `${((positive / (clvs.length || 1)) * 100).toFixed(0)}% positive`
  );
}

async function main() {
  const jwt = process.env.TXLINE_GUEST_JWT;
  const apiToken = process.env.TXLINE_API_TOKEN;
  if (!jwt || !apiToken) {
    throw new Error(
      "Set TXLINE_GUEST_JWT and TXLINE_API_TOKEN in .env (run `npm run auth` first)."
    );
  }
  // Resolve the fixture universe: explicit IDs, or auto-discover every
  // completed fixture in the competition.
  let targets: { fixtureId: string; startTime?: number; label: string }[];
  if (FIXTURE_IDS.length > 0) {
    targets = FIXTURE_IDS.map((id) => ({ fixtureId: id, label: id }));
  } else {
    const startEpochDay = Math.floor(Date.now() / DAY_MS) - LOOKBACK_DAYS;
    const fixtures = await fetchFixtures(jwt, apiToken, startEpochDay, COMPETITION_ID);
    const cutoff = Date.now() - 4 * 3_600_000; // kicked off >4h ago = finished
    targets = fixtures
      .filter((f) => f.startTime < cutoff)
      .sort((a, b) => a.startTime - b.startTime)
      .map((f) => ({
        fixtureId: f.fixtureId,
        startTime: f.startTime,
        label: `${f.participant1} vs ${f.participant2}`,
      }));
    console.log(
      `Auto-discovered ${targets.length} completed fixtures (competition ${COMPETITION_ID}, ` +
        `last ${LOOKBACK_DAYS} days).`
    );
  }

  const rows: BacktestRow[] = [];
  let scoresResults = 0;
  let oddsResults = 0;
  let crossChecked = 0;
  let crossAgreed = 0;
  let skipped = 0;

  for (const [i, target] of targets.entries()) {
    const { fixtureId, startTime, label } = target;
    console.log(`[${i + 1}/${targets.length}] ${label} (${fixtureId})...`);
    let odds: OddsPoint[];
    try {
      odds = await fetchOddsHistory(fixtureId, jwt, apiToken, startTime);
    } catch (err: any) {
      console.error(`  skipping: ${err?.response?.status ?? ""} ${err?.message ?? err}`);
      skipped++;
      continue;
    }

    // Result: official scores when retention allows, else derived from the
    // converged in-play odds. When both exist, cross-validate the fallback.
    const official = await fetchFixtureResult(fixtureId, jwt, apiToken).catch(() => undefined);
    const derived = deriveResultFromOdds(odds);
    if (official && derived) {
      crossChecked++;
      if (official.winningSelection === derived.winningSelection) crossAgreed++;
    }
    const result = official ?? derived;
    if (!result) {
      console.error(`  skipping: no official score and odds never converged`);
      skipped++;
      continue;
    }
    official ? scoresResults++ : oddsResults++;
    fs.mkdirSync(".cache", { recursive: true });
    fs.writeFileSync(
      path.join(".cache", `result-${fixtureId}.json`),
      JSON.stringify({
        winningSelection: result.winningSelection,
        source: official ? "scores" : "odds-derived",
        label,
      })
    );

    const prematch = odds.filter((p) => !p.inRunning).length;
    console.log(
      `  ${odds.length} ticks (${prematch} pre-match) | winner ${result.winningSelection} ` +
        `(${official ? "official" : "odds-derived"})`
    );

    // Per-selection series for reference-price lookups.
    const bySelection = new Map<string, OddsPoint[]>();
    for (const p of odds) {
      const key = `${p.market}|${p.selection}`;
      if (!bySelection.has(key)) bySelection.set(key, []);
      bySelection.get(key)!.push(p);
    }
    for (const s of bySelection.values()) s.sort((a, b) => a.timestamp - b.timestamp);

    const flags = detectSharpMoves(odds, {
      windowMs: WINDOW_MINUTES * 60_000,
      probabilityThreshold: PROBABILITY_THRESHOLD,
      zScore: Z_SCORE,
    }).filter((f) => f.probabilityDelta > 0); // only "shortened toward" counts as a call

    for (const flag of flags) {
      const series = bySelection.get(`${flag.market}|${flag.selection}`) ?? [];
      const refProb = referenceProbability(series, flag.windowEnd, flag.inRunning);
      rows.push({
        ...flag,
        regime: flag.inRunning ? "in-play" : "pre-match",
        referenceProbability: refProb,
        // Positive = the market kept going our way after the flag (we "beat
        // the reference price"); negative = the move reverted (noise).
        clv: refProb != null ? refProb - flag.peakProbability : undefined,
        actualWinner: result.winningSelection,
        correct: flag.selection === result.winningSelection,
      });
    }
  }

  const pre = rows.filter((r) => r.regime === "pre-match");
  const inplay = rows.filter((r) => r.regime === "in-play");

  console.log("\n--- Sharp Movement Detector: Backtest Report ---");
  console.log(
    `Fixtures: ${scoresResults + oddsResults} scored (${scoresResults} official results, ` +
      `${oddsResults} odds-derived), ${skipped} skipped | ` +
      `odds-derived validation: ${crossAgreed}/${crossChecked} agree with official scores`
  );
  console.log(
    `Window ${WINDOW_MINUTES}min | floor ${(PROBABILITY_THRESHOLD * 100).toFixed(1)}pp | ` +
      `z-score ${Z_SCORE || "off"} | in-play CLV horizon ${CLV_HORIZON_MINUTES}min\n`
  );
  console.log(summarize(pre, "pre-match"));
  console.log(summarize(inplay, "in-play"));
  console.log(
    "\nNote: in-play numbers are structurally flattered - a leading team's " +
      "probability drifts toward 100% as the clock runs down, so in-play " +
      "hit rate/CLV measure persistence of the move, not predictive skill. " +
      "Pre-match CLV is the honest measure of edge."
  );

  console.log("");
  rows.forEach((r) => {
    const clvStr = r.clv != null ? `${r.clv >= 0 ? "+" : ""}${(r.clv * 100).toFixed(1)}pp CLV` : "no ref";
    const z = r.zScore ? ` z=${r.zScore.toFixed(1)}` : "";
    console.log(
      `[${r.correct ? "HIT " : "MISS"}][${r.regime === "pre-match" ? "PRE " : "PLAY"}] ` +
        `${r.fixtureId} ${r.selection} ` +
        `${(r.startingProbability * 100).toFixed(1)}%->${(r.peakProbability * 100).toFixed(1)}%${z} ` +
        `${clvStr} | winner: ${r.actualWinner}`
    );
  });

  fs.writeFileSync("backtest-report.json", JSON.stringify(rows, null, 2));
  console.log("\nFull report written to backtest-report.json");
}

main().catch((err) => {
  console.error("Backtest failed:", err?.response?.data || err);
  process.exit(1);
});
