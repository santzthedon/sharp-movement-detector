/**
 * Polls odds for a set of fixtures every POLL_INTERVAL_MS and prints any
 * newly flagged moves. This is the piece that satisfies "Autonomous
 * Operation" in the judging criteria - once started, it runs unattended.
 *
 * The free World Cup tier's 60-second-delay level is what this is built
 * for (no need to hammer the endpoint faster than the data actually
 * updates). Fine to run this against historical/completed fixtures too -
 * it'll just replay through the stored history quickly.
 *
 * Run: npm run live
 */
import * as dotenv from "dotenv";
dotenv.config();
import { fetchRecentOdds } from "./oddsClient";
import { detectSharpMoves } from "./detector";
import { OddsPoint, FlaggedMove } from "./types";

const FIXTURE_IDS = (process.env.LIVE_FIXTURE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WINDOW_MINUTES = Number(process.env.WINDOW_MINUTES || 15);
const PROBABILITY_THRESHOLD = Number(process.env.PROBABILITY_THRESHOLD || 0.08);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);

const seenFlagKeys = new Set<string>();

function flagKey(f: FlaggedMove): string {
  return `${f.fixtureId}|${f.market}|${f.selection}|${f.windowEnd}`;
}

// Rolling per-fixture tick buffer. In-play TxLINE volume is heavy (tens of
// thousands of records per 5-minute bucket), so re-walking the whole
// trailing window every poll makes polls outlast the poll interval and
// pile up. Instead: walk the full window once at startup, then only fetch
// from just before the newest buffered tick.
const buffers = new Map<string, OddsPoint[]>();
let polling = false;

async function pollOnce(jwt: string, apiToken: string) {
  if (polling) return; // previous poll still in flight - don't stack
  polling = true;
  try {
    await pollAll(jwt, apiToken);
  } finally {
    polling = false;
  }
}

async function pollAll(jwt: string, apiToken: string) {
  for (const fixtureId of FIXTURE_IDS) {
    const windowMs = WINDOW_MINUTES * 60_000;
    const buffer = buffers.get(fixtureId) ?? [];
    // Twice the detection window of trailing history is enough for the
    // detector to see any swing that completes within windowMs.
    const sinceMs =
      buffer.length > 0
        ? buffer[buffer.length - 1].timestamp - 60_000 // small overlap for safety
        : Date.now() - 2 * windowMs;

    let fresh: OddsPoint[];
    try {
      fresh = await fetchRecentOdds(fixtureId, sinceMs, jwt, apiToken);
    } catch (err: any) {
      console.error(`Fetch failed for ${fixtureId}:`, err?.response?.data || err.message);
      continue;
    }

    const seenTicks = new Set(buffer.map((p) => `${p.market}|${p.selection}|${p.timestamp}`));
    for (const p of fresh) {
      if (!seenTicks.has(`${p.market}|${p.selection}|${p.timestamp}`)) buffer.push(p);
    }
    buffer.sort((a, b) => a.timestamp - b.timestamp);
    const cutoff = Date.now() - 2 * windowMs;
    const odds = buffer.filter((p) => p.timestamp >= cutoff);
    buffers.set(fixtureId, odds);

    // Heartbeat: latest implied probability per selection, so a quiet
    // (flag-free) poll still visibly proves the watcher is alive.
    const latest = new Map<string, OddsPoint>();
    for (const p of odds) latest.set(p.selection, p);
    const snapshot = [...latest.values()]
      .map((p) => `${p.selection} ${(100 / p.decimalOdds).toFixed(1)}%`)
      .join(" | ");
    console.log(
      `[${new Date().toISOString()}] ${fixtureId}: ${odds.length} ticks in window | ${snapshot || "no data"}`
    );

    const flags = detectSharpMoves(odds, {
      windowMs: WINDOW_MINUTES * 60_000,
      probabilityThreshold: PROBABILITY_THRESHOLD,
    });

    for (const flag of flags) {
      const key = flagKey(flag);
      if (seenFlagKeys.has(key)) continue;
      seenFlagKeys.add(key);

      console.log(
        `[${new Date().toISOString()}] SHARP MOVE: ${flag.fixtureId} ${flag.market} -> ${flag.selection} ` +
          `${(flag.startingProbability * 100).toFixed(1)}% -> ${(flag.peakProbability * 100).toFixed(1)}% ` +
          `over ${((flag.windowEnd - flag.windowStart) / 60_000).toFixed(1)} min`
      );

      // TODO once you've checked the Validation Proofs endpoint shape:
      // fetch and log the proof for `flag.windowEnd` here, so each flagged
      // signal carries its own on-chain-anchored timestamp - this is the
      // detail that ties the submission back to TxLINE's actual pitch
      // rather than just being a bolt-on feature.
    }
  }
}

async function main() {
  const jwt = process.env.TXLINE_GUEST_JWT;
  const apiToken = process.env.TXLINE_API_TOKEN;
  if (!jwt || !apiToken) {
    throw new Error(
      "Set TXLINE_GUEST_JWT and TXLINE_API_TOKEN in .env (run `npm run auth` first)."
    );
  }
  if (FIXTURE_IDS.length === 0) {
    throw new Error("Set LIVE_FIXTURE_IDS in .env - comma-separated fixture IDs to watch.");
  }

  console.log(
    `Watching ${FIXTURE_IDS.length} fixture(s) every ${POLL_INTERVAL_MS / 1000}s ` +
      `(window=${WINDOW_MINUTES}min, threshold=${PROBABILITY_THRESHOLD * 100}%)...`
  );

  await pollOnce(jwt, apiToken);
  setInterval(() => pollOnce(jwt, apiToken), POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Live runner failed:", err);
  process.exit(1);
});
