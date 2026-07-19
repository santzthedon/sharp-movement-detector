/**
 * Autonomous live watcher. Polls odds every POLL_INTERVAL_MS, flags sharp
 * moves as they happen, and attaches each flag's on-chain Merkle proof.
 * This is the piece that satisfies "Autonomous Operation" in the judging
 * criteria - once started, it runs unattended.
 *
 * Fixture selection is automatic by default: with LIVE_FIXTURE_IDS unset,
 * the watcher discovers fixtures itself from /fixtures/snapshot, attaching
 * from AUTODISCOVER_LEAD_MINUTES before kickoff until ~4.5h after (covers
 * extra time + settling), and detaching after. Set LIVE_FIXTURE_IDS to
 * pin an explicit list instead.
 *
 * The free World Cup tier's 60-second-delay level is what this is built
 * for (no need to hammer the endpoint faster than the data actually
 * updates).
 *
 * Run: npm run live
 */
import * as dotenv from "dotenv";
dotenv.config();
import { fetchRecentOdds, fetchFixtures, fetchOddsProof, FixtureInfo } from "./oddsClient";
import { detectSharpMoves } from "./detector";
import { OddsPoint, FlaggedMove } from "./types";
import { startDashboard, DashboardFlag, DashboardState } from "./dashboard";

const PINNED_FIXTURE_IDS = (process.env.LIVE_FIXTURE_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const WINDOW_MINUTES = Number(process.env.WINDOW_MINUTES || 60);
const PROBABILITY_THRESHOLD = Number(process.env.PROBABILITY_THRESHOLD || 0.02);
const Z_SCORE = Number(process.env.Z_SCORE || 3);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 60_000);

// Auto-discovery: attach this long before kickoff...
const LEAD_MS = Number(process.env.AUTODISCOVER_LEAD_MINUTES || 60) * 60_000;
// ...and detach this long after (90min + HT + ET + penalties + settling).
const TAIL_MS = 4.5 * 3_600_000;
const DISCOVER_EVERY_MS = 10 * 60_000;
const COMPETITION_ID = process.env.COMPETITION_ID
  ? Number(process.env.COMPETITION_ID)
  : undefined;
const DAY_MS = 86_400_000;

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
const watchlist = new Map<string, string>(); // fixtureId -> display label
let lastDiscovery = 0;
let polling = false;

// State the dashboard renders. Flags are kept newest-first, capped at 50.
const dashboardFlags: DashboardFlag[] = [];
const startedAt = Date.now();

/** Downsample a series to ~150 points so the dashboard payload stays small. */
function downsample(pts: OddsPoint[]): [number, number][] {
  const step = Math.max(1, Math.floor(pts.length / 150));
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i += step) {
    out.push([pts[i].timestamp, 1 / pts[i].decimalOdds]);
  }
  if (pts.length) out.push([pts[pts.length - 1].timestamp, 1 / pts[pts.length - 1].decimalOdds]);
  return out;
}

function dashboardState(): DashboardState {
  const fixtures = [...watchlist.entries()].map(([fixtureId, label]) => {
    const odds = buffers.get(fixtureId) ?? [];
    const bySel = new Map<string, OddsPoint[]>();
    for (const p of odds) {
      if (!bySel.has(p.selection)) bySel.set(p.selection, []);
      bySel.get(p.selection)!.push(p);
    }
    const latest: Record<string, number> = {};
    const series: Record<string, [number, number][]> = {};
    for (const [sel, pts] of bySel) {
      latest[sel] = 1 / pts[pts.length - 1].decimalOdds;
      series[sel] = downsample(pts);
    }
    return { fixtureId, label, ticksInWindow: odds.length, latest, series };
  });
  return {
    startedAt,
    mode: PINNED_FIXTURE_IDS.length > 0 ? "pinned fixtures" : "auto-discovery",
    settings: `window ${WINDOW_MINUTES}min, floor ${PROBABILITY_THRESHOLD * 100}pp, z=${Z_SCORE || "off"}`,
    pollSeconds: Math.round(POLL_INTERVAL_MS / 1000),
    fixtures,
    flags: dashboardFlags,
  };
}

async function refreshWatchlist(jwt: string, apiToken: string) {
  if (PINNED_FIXTURE_IDS.length > 0) {
    for (const id of PINNED_FIXTURE_IDS) watchlist.set(id, id);
    return;
  }
  if (Date.now() - lastDiscovery < DISCOVER_EVERY_MS) return;
  lastDiscovery = Date.now();

  let fixtures: FixtureInfo[];
  try {
    // Look back one epoch day so matches that kicked off before UTC
    // midnight are still found.
    const startEpochDay = Math.floor((Date.now() - TAIL_MS) / DAY_MS);
    fixtures = await fetchFixtures(jwt, apiToken, startEpochDay, COMPETITION_ID);
  } catch (err: any) {
    console.error("Fixture discovery failed:", err?.response?.data || err.message);
    return; // keep watching the current list; retry next cycle
  }

  const now = Date.now();
  const wanted = new Map<string, string>();
  for (const f of fixtures) {
    if (f.startTime <= now + LEAD_MS && f.startTime >= now - TAIL_MS) {
      wanted.set(f.fixtureId, `${f.participant1} vs ${f.participant2}`);
    }
  }

  for (const [id, label] of wanted) {
    if (!watchlist.has(id)) console.log(`[watchlist] + ${id} (${label})`);
  }
  for (const [id, label] of watchlist) {
    if (!wanted.has(id)) {
      console.log(`[watchlist] - ${id} (${label}) - out of window`);
      buffers.delete(id);
    }
  }
  watchlist.clear();
  for (const [id, label] of wanted) watchlist.set(id, label);
}

async function pollOnce(jwt: string, apiToken: string) {
  if (polling) return; // previous poll still in flight - don't stack
  polling = true;
  try {
    await refreshWatchlist(jwt, apiToken);
    await pollAll(jwt, apiToken);
  } finally {
    polling = false;
  }
}

async function pollAll(jwt: string, apiToken: string) {
  if (watchlist.size === 0) {
    console.log(`[${new Date().toISOString()}] no fixtures in the watch window - standing by`);
    return;
  }
  for (const [fixtureId, label] of watchlist) {
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
      `[${new Date().toISOString()}] ${label}: ${odds.length} ticks in window | ${snapshot || "no data"}`
    );

    const flags = detectSharpMoves(odds, {
      windowMs,
      probabilityThreshold: PROBABILITY_THRESHOLD,
      zScore: Z_SCORE,
    });

    for (const flag of flags) {
      const key = flagKey(flag);
      if (seenFlagKeys.has(key)) continue;
      seenFlagKeys.add(key);

      const z = flag.zScore ? ` (z=${flag.zScore.toFixed(1)}, normal range ${(flag.baselineSwing! * 100).toFixed(2)}pp)` : "";
      console.log(
        `[${new Date().toISOString()}] SHARP MOVE: ${label} -> ${flag.selection} ` +
          `${(flag.startingProbability * 100).toFixed(1)}% -> ${(flag.peakProbability * 100).toFixed(1)}% ` +
          `over ${((flag.windowEnd - flag.windowStart) / 60_000).toFixed(1)} min${z}`
      );

      const dashFlag: DashboardFlag = {
        at: flag.windowEnd,
        fixtureLabel: label,
        selection: flag.selection,
        from: flag.startingProbability,
        to: flag.peakProbability,
        minutes: (flag.windowEnd - flag.windowStart) / 60_000,
        zScore: flag.zScore,
        proof: flag.messageId ? "pending..." : undefined,
      };
      dashboardFlags.unshift(dashFlag);
      if (dashboardFlags.length > 50) dashboardFlags.pop();

      // Anchor the flag: fetch the Merkle proof tying the exact tick that
      // completed this move to the batch root TxODDS commits on Solana.
      // This makes the signal independently verifiable - nobody, including
      // us, can fabricate or backdate the tick a flag was based on.
      if (flag.messageId) {
        try {
          const proof = await fetchOddsProof(flag.messageId, flag.windowEnd, jwt, apiToken);
          const desc =
            `${proof.proofNodes} Merkle nodes` +
            (proof.batchRoot ? `, batch root ${String(proof.batchRoot).slice(0, 16)}...` : "");
          console.log(`    on-chain proof: ${desc} (messageId ${flag.messageId})`);
          dashFlag.proof = desc;
        } catch (err: any) {
          console.log(
            `    on-chain proof unavailable (${err?.response?.status ?? err?.message}) - ` +
              `tick may not be batched yet`
          );
          dashFlag.proof = "not yet batched on-chain";
        }
      }
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

  console.log(
    PINNED_FIXTURE_IDS.length > 0
      ? `Watching ${PINNED_FIXTURE_IDS.length} pinned fixture(s) every ${POLL_INTERVAL_MS / 1000}s ` +
          `(window=${WINDOW_MINUTES}min, floor=${PROBABILITY_THRESHOLD * 100}%, z=${Z_SCORE || "off"})...`
      : `Auto-discovery mode: watching all fixtures from ${LEAD_MS / 60_000}min before kickoff ` +
          `to ${TAIL_MS / 3_600_000}h after, every ${POLL_INTERVAL_MS / 1000}s ` +
          `(window=${WINDOW_MINUTES}min, floor=${PROBABILITY_THRESHOLD * 100}%, z=${Z_SCORE || "off"})...`
  );

  startDashboard(Number(process.env.DASHBOARD_PORT || 8787), dashboardState);

  await pollOnce(jwt, apiToken);
  setInterval(() => pollOnce(jwt, apiToken), POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Live runner failed:", err);
  process.exit(1);
});
