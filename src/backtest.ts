/**
 * Runs the detector against completed fixtures and checks whether flagged
 * moves actually pointed toward the eventual winner.
 *
 * Run: npm run backtest
 * Requires .env to have TXLINE_GUEST_JWT / TXLINE_API_TOKEN (from `npm run auth`)
 * and BACKTEST_FIXTURE_IDS set to a comma-separated list of *completed*
 * World Cup fixture IDs (pull real ones from the /fixtures endpoint once
 * you've confirmed its shape in oddsClient.ts).
 */
import * as fs from "fs";
import * as dotenv from "dotenv";
dotenv.config();
import { fetchOddsHistory, fetchFixtureResult } from "./oddsClient";
import { detectSharpMoves } from "./detector";
import { BacktestRow } from "./types";

const FIXTURE_IDS = (process.env.BACKTEST_FIXTURE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WINDOW_MINUTES = Number(process.env.WINDOW_MINUTES || 15);
const PROBABILITY_THRESHOLD = Number(process.env.PROBABILITY_THRESHOLD || 0.08);
// In-play consensus odds jump sharply on every goal, so counting those
// moves would trivially inflate the hit rate ("odds moved toward the team
// that just scored"). Pre-match-only is the honest default; set
// PREMATCH_ONLY=false to include in-play ticks anyway.
const PREMATCH_ONLY = (process.env.PREMATCH_ONLY ?? "true") !== "false";

async function main() {
  const jwt = process.env.TXLINE_GUEST_JWT;
  const apiToken = process.env.TXLINE_API_TOKEN;
  if (!jwt || !apiToken) {
    throw new Error(
      "Set TXLINE_GUEST_JWT and TXLINE_API_TOKEN in .env (run `npm run auth` first)."
    );
  }
  if (FIXTURE_IDS.length === 0) {
    throw new Error(
      "Set BACKTEST_FIXTURE_IDS in .env - comma-separated list of completed fixture IDs to test against."
    );
  }

  const rows: BacktestRow[] = [];

  for (const fixtureId of FIXTURE_IDS) {
    console.log(`Fetching odds history for ${fixtureId}...`);
    let allOdds, result;
    try {
      allOdds = await fetchOddsHistory(fixtureId, jwt, apiToken);
      result = await fetchFixtureResult(fixtureId, jwt, apiToken);
    } catch (err: any) {
      console.error(
        `  Skipping ${fixtureId}: ${err?.response?.status ?? ""} ${err?.message ?? err}`
      );
      continue;
    }

    const odds = PREMATCH_ONLY ? allOdds.filter((p) => !p.inRunning) : allOdds;
    console.log(
      `  ${allOdds.length} odds ticks (${odds.length} used${PREMATCH_ONLY ? ", pre-match only" : ""})`
    );

    const flags = detectSharpMoves(odds, {
      windowMs: WINDOW_MINUTES * 60_000,
      probabilityThreshold: PROBABILITY_THRESHOLD,
    }).filter((f) => f.probabilityDelta > 0); // only count "shortened toward" as a call

    for (const flag of flags) {
      rows.push({
        ...flag,
        actualWinner: result.winningSelection,
        correct: flag.selection === result.winningSelection,
      });
    }
  }

  const hits = rows.filter((r) => r.correct).length;
  const total = rows.length;

  console.log("\n--- Sharp Movement Detector: Backtest Report ---");
  console.log(
    `Window: ${WINDOW_MINUTES} min | Threshold: ${PROBABILITY_THRESHOLD * 100}% implied-probability swing`
  );
  console.log(`Flagged moves: ${total}`);
  console.log(`Correct calls: ${hits}`);
  console.log(`Hit rate: ${total > 0 ? ((hits / total) * 100).toFixed(1) : "n/a"}%\n`);

  rows.forEach((r) => {
    console.log(
      `[${r.correct ? "HIT " : "MISS"}] ${r.fixtureId} ${r.market} -> ${r.selection} ` +
        `(${(r.startingProbability * 100).toFixed(1)}% -> ${(r.peakProbability * 100).toFixed(1)}%) ` +
        `actual winner: ${r.actualWinner}`
    );
  });

  fs.writeFileSync("backtest-report.json", JSON.stringify(rows, null, 2));
  console.log("\nFull report written to backtest-report.json");
}

main().catch((err) => {
  console.error("Backtest failed:", err?.response?.data || err);
  process.exit(1);
});
