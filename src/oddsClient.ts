/**
 * Thin wrapper around TxLINE's data endpoints.
 *
 * Routes + schemas verified against the live OpenAPI spec
 * (https://txline.txodds.com/docs/docs.yaml, fetched 2026-07-18):
 *
 *   GET /api/fixtures/snapshot?startEpochDay=&competitionId=
 *     -> Fixture[] { FixtureId, StartTime, Competition, CompetitionId,
 *                    Participant1, Participant2, Participant1IsHome, Ts }
 *   GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}?fixtureId=
 *     -> OddsPayload[] for one historical 5-minute interval
 *        (epochDay = days since Unix epoch, hourOfDay 0-23, interval 0-11)
 *   GET /api/odds/updates/{fixtureId}
 *     -> OddsPayload[] from the current in-memory 5-minute cache only
 *   GET /api/scores/historical/{fixtureId}
 *     -> full update sequence; only works while the fixture's start time is
 *        between six hours and two weeks in the past. NOTE: despite the
 *        spec declaring application/json with lowercase fields, the real
 *        response (checked 2026-07-18 on devnet) is SSE-formatted text
 *        ("data: {...}" lines) with PascalCase fields, so it gets parsed
 *        accordingly here.
 *
 * OddsPayload (real devnet values, 2026-07-18): Bookmaker is
 * "TXLineStablePriceDemargined"; the match-winner market is
 * SuperOddsType "1X2_PARTICIPANT_RESULT" with PriceNames
 * ["part1","draw","part2"], where MarketPeriod null = full match and
 * "half=1" = first-half line. Pct is implied probability in percent as a
 * 3-decimal string ("52.632", or "NA" for quarter-handicap lines) and
 * Prices are decimal odds x1000 (1970 <-> 1.97). Pct is used first;
 * Prices are the fallback. Suspended lines arrive with empty
 * Prices/Pct arrays and are skipped.
 *
 * Everything downstream (detector.ts, backtest.ts, live.ts) only depends on
 * the normalized OddsPoint/FixtureResult types in types.ts.
 */
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { API_BASE } from "./config";
import { OddsPoint, FixtureResult } from "./types";

const FIVE_MIN_MS = 300_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** How much pre-match odds history the backtest pulls, in hours. */
const PREMATCH_HOURS = Number(process.env.PREMATCH_HOURS || 3);

/**
 * Which SuperOddsType values count as the match-winner market. Confirmed
 * against real devnet data; override via ODDS_MARKET_REGEX if you want to
 * run the detector on other markets (e.g. OVERUNDER_PARTICIPANT_GOALS).
 */
const MARKET_RE = new RegExp(process.env.ODDS_MARKET_REGEX || "^1X2_PARTICIPANT_RESULT$", "i");

function authHeaders(jwt: string, apiToken: string) {
  return {
    Authorization: `Bearer ${jwt}`,
    "X-Api-Token": apiToken,
  };
}

// --- Fixtures ---

export interface FixtureInfo {
  fixtureId: string;
  startTime: number; // epoch ms
  competition: string;
  competitionId: number;
  participant1: string;
  participant2: string;
  participant1IsHome: boolean;
}

/** Lists fixtures starting at or within 30 days after `startEpochDay`. */
export async function fetchFixtures(
  jwt: string,
  apiToken: string,
  startEpochDay?: number,
  competitionId?: number
): Promise<FixtureInfo[]> {
  const res = await axios.get(`${API_BASE}/fixtures/snapshot`, {
    params: { startEpochDay, competitionId },
    headers: authHeaders(jwt, apiToken),
  });
  return (res.data ?? []).map((f: any) => ({
    fixtureId: String(f.FixtureId),
    startTime: Number(f.StartTime),
    competition: f.Competition,
    competitionId: Number(f.CompetitionId),
    participant1: f.Participant1,
    participant2: f.Participant2,
    participant1IsHome: Boolean(f.Participant1IsHome),
  }));
}

// --- Odds ---

/**
 * Pulls odds updates for one fixture across a time range by walking the
 * historical 5-minute interval route. ~12 requests per hour of range.
 */
const FETCH_CONCURRENCY = Number(process.env.FETCH_CONCURRENCY || 6);

export async function fetchOddsRange(
  fixtureId: string,
  fromMs: number,
  toMs: number,
  jwt: string,
  apiToken: string,
  opts: { allMarkets?: boolean } = {}
): Promise<OddsPoint[]> {
  const buckets: number[] = [];
  for (let t = Math.floor(fromMs / FIVE_MIN_MS) * FIVE_MIN_MS; t <= toMs; t += FIVE_MIN_MS) {
    buckets.push(t);
  }
  const points: OddsPoint[] = [];
  // Small worker pool: bulk backfills walk ~80 buckets per fixture, and
  // sequential fetching makes a 100-fixture backfill take hours.
  let next = 0;
  const worker = async () => {
    while (next < buckets.length) {
      const t = buckets[next++];
      const epochDay = Math.floor(t / DAY_MS);
      const hourOfDay = Math.floor((t % DAY_MS) / HOUR_MS);
      const interval = Math.floor((t % HOUR_MS) / FIVE_MIN_MS);
      try {
        const res = await axios.get(
          `${API_BASE}/odds/updates/${epochDay}/${hourOfDay}/${interval}`,
          { params: { fixtureId }, headers: authHeaders(jwt, apiToken) }
        );
        points.push(...normalizeOddsPayloads(res.data));
      } catch (err: any) {
        // Intervals with no stored data can 404/500 - skip, keep walking.
        if (![404, 500].includes(err?.response?.status)) throw err;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FETCH_CONCURRENCY, buckets.length) }, worker)
  );
  points.sort((a, b) => a.timestamp - b.timestamp);
  logMarketInventory(points);
  return opts.allMarkets ? points : points.filter((p) => MARKET_RE.test(p.market));
}

/**
 * Full odds history for a completed fixture. Resolves the fixture's time
 * window from its score updates when those still exist (scores retention
 * is ~2 weeks), else from `startTimeHint` (kickoff time from the fixtures
 * feed, whose retention covers the whole tournament).
 */
export async function fetchOddsHistory(
  fixtureId: string,
  jwt: string,
  apiToken: string,
  startTimeHint?: number
): Promise<OddsPoint[]> {
  const cached = readOddsCache(fixtureId);
  if (cached) return cached.filter((p) => MARKET_RE.test(p.market));

  let startTime: number;
  let lastTs: number;
  const scores = await fetchScoresHistorical(fixtureId, jwt, apiToken).catch(() => []);
  if (scores.length > 0) {
    startTime = Number(scores[0].StartTime);
    lastTs = Math.max(...scores.map((s: any) => Number(s.Ts)));
  } else if (startTimeHint) {
    startTime = startTimeHint;
    // No score updates to bound the end - 3h after kickoff covers 90min +
    // stoppage + halftime with margin (the regulation 1x2 market settles
    // at the final whistle regardless).
    lastTs = startTimeHint + 3 * HOUR_MS;
  } else {
    throw new Error(
      `No historical scores for fixture ${fixtureId} (retention is ~2 weeks) and no ` +
        `startTimeHint provided - pass the kickoff time from the fixtures feed.`
    );
  }

  const points = await fetchOddsRange(
    fixtureId,
    startTime - PREMATCH_HOURS * HOUR_MS,
    Math.min(lastTs + FIVE_MIN_MS, Date.now()),
    jwt,
    apiToken,
    { allMarkets: true }
  );
  writeOddsCache(fixtureId, points);
  return points.filter((p) => MARKET_RE.test(p.market));
}

// Completed fixtures' history is immutable, so cache it on disk - walking
// ~80 five-minute buckets per fixture is by far the slowest part of a
// backtest, and caching makes parameter-tuning reruns near-instant.
function cachePath(fixtureId: string): string {
  return path.join(".cache", `odds-${fixtureId}-h${PREMATCH_HOURS}.json`);
}

function readOddsCache(fixtureId: string): OddsPoint[] | undefined {
  const file = cachePath(fixtureId);
  if (!fs.existsSync(file)) return undefined;
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function writeOddsCache(fixtureId: string, points: OddsPoint[]) {
  fs.mkdirSync(".cache", { recursive: true });
  fs.writeFileSync(cachePath(fixtureId), JSON.stringify(points));
}

/**
 * Fallback result source for fixtures older than the scores retention
 * window: at the final whistle the in-play 1x2 market has converged on the
 * outcome (the winner trades at ~100%), so the last in-play ticks label
 * the fixture. Returns undefined when the market never converged (feed
 * stopped early / suspended) rather than guessing. The backtest
 * cross-validates this method against official scores on every fixture
 * where both are available.
 */
export function deriveResultFromOdds(points: OddsPoint[]): FixtureResult | undefined {
  const finals = new Map<string, OddsPoint>();
  for (const p of points) {
    if (p.inRunning) finals.set(p.selection, p); // points are time-sorted
  }
  if (finals.size === 0) return undefined;
  let best: OddsPoint | undefined;
  for (const p of finals.values()) {
    if (!best || 1 / p.decimalOdds > 1 / best.decimalOdds) best = p;
  }
  if (!best || 1 / best.decimalOdds < 0.8) return undefined; // never converged
  return { fixtureId: best.fixtureId, winningSelection: best.selection };
}

/**
 * Recent odds for a live fixture: walks intervals from `sinceMs` to now.
 * The current 5-minute interval is still being written server-side, so the
 * `/odds/updates/{fixtureId}` live-cache route fills in the newest ticks.
 */
export async function fetchRecentOdds(
  fixtureId: string,
  sinceMs: number,
  jwt: string,
  apiToken: string
): Promise<OddsPoint[]> {
  const historical = await fetchOddsRange(fixtureId, sinceMs, Date.now(), jwt, apiToken);
  try {
    const res = await axios.get(`${API_BASE}/odds/updates/${fixtureId}`, {
      headers: authHeaders(jwt, apiToken),
    });
    const live = normalizeOddsPayloads(res.data).filter((p) => MARKET_RE.test(p.market));
    const seen = new Set(historical.map((p) => `${p.selection}|${p.timestamp}`));
    for (const p of live) {
      if (!seen.has(`${p.selection}|${p.timestamp}`)) historical.push(p);
    }
  } catch {
    // Live cache being empty/unavailable is fine - historical walk covers it.
  }
  return historical.sort((a, b) => a.timestamp - b.timestamp);
}

// --- On-chain validation ---

export interface OddsProof {
  /** Merkle root of the batch this update belongs to (committed on-chain). */
  batchRoot?: string;
  /** Total proof nodes across sub-tree and main-tree branches. */
  proofNodes: number;
  raw: any;
}

/**
 * Fetches the Merkle proof anchoring one odds update to the batch root
 * TxODDS commits on Solana. This is what makes a flagged signal
 * *verifiable*: the proof hashes reconstruct the on-chain root, so nobody
 * (including us) can fabricate or backdate the tick a flag was based on.
 */
export async function fetchOddsProof(
  messageId: string,
  ts: number,
  jwt: string,
  apiToken: string
): Promise<OddsProof> {
  const res = await axios.get(`${API_BASE}/odds/validation`, {
    params: { messageId, ts },
    headers: authHeaders(jwt, apiToken),
  });
  const d = res.data ?? {};
  const sub = Array.isArray(d.subTreeProof) ? d.subTreeProof.length : 0;
  const main = Array.isArray(d.mainTreeProof) ? d.mainTreeProof.length : 0;
  return {
    batchRoot: d.summary?.oddsSubTreeRoot,
    proofNodes: sub + main,
    raw: d,
  };
}

// --- Scores ---

/**
 * The response is SSE-formatted text ("data: {...}" / "id: N" lines) even
 * though the spec declares a JSON array - parse the data lines ourselves.
 */
async function fetchScoresHistorical(
  fixtureId: string,
  jwt: string,
  apiToken: string
): Promise<any[]> {
  const res = await axios.get(`${API_BASE}/scores/historical/${fixtureId}`, {
    headers: authHeaders(jwt, apiToken),
    responseType: "text",
    transformResponse: [(d) => d], // keep raw text even if axios sniffs JSON
  });
  const updates: any[] = [];
  for (const line of String(res.data ?? "").split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      updates.push(JSON.parse(line.slice(6)));
    } catch {
      // partial/garbled line - skip
    }
  }
  return updates.sort((a, b) => Number(a.Ts) - Number(b.Ts));
}

/** Final result for a completed fixture, derived from its last score update. */
export async function fetchFixtureResult(
  fixtureId: string,
  jwt: string,
  apiToken: string
): Promise<FixtureResult> {
  const scores = await fetchScoresHistorical(fixtureId, jwt, apiToken);
  const withScore = scores.filter((s) => s.Score);
  if (withScore.length === 0) {
    throw new Error(`Fixture ${fixtureId} has no score data in its updates.`);
  }
  // Prefer the explicit final whistle; otherwise take the latest scored update.
  const last =
    withScore.filter((s) => s.Action === "game_finalised").pop() ??
    withScore[withScore.length - 1];
  // The 1x2 market settles on the regulation (90-minute) result, i.e.
  // H1+H2 goals; a period with no goals omits the Goals key entirely.
  const goals = (participant: any): number => {
    const h1 = participant?.H1?.Goals;
    const h2 = participant?.H2?.Goals;
    if (h1 != null || h2 != null) return Number(h1 ?? 0) + Number(h2 ?? 0);
    return Number(participant?.Total?.Goals ?? 0);
  };
  const p1Goals = goals(last.Score.Participant1);
  const p2Goals = goals(last.Score.Participant2);
  const winningSelection = p1Goals > p2Goals ? "part1" : p2Goals > p1Goals ? "part2" : "draw";
  return { fixtureId: String(last.FixtureId ?? fixtureId), winningSelection };
}

// --- Normalization ---

/**
 * One OddsPayload holds a whole market line (parallel PriceNames / Prices /
 * Pct arrays); fan it out into one OddsPoint per selection.
 */
function normalizeOddsPayloads(raw: any): OddsPoint[] {
  const payloads: any[] = Array.isArray(raw) ? raw : [];
  const points: OddsPoint[] = [];
  for (const o of payloads) {
    const names: string[] = o?.PriceNames ?? [];
    if (names.length === 0 || o?.Ts == null) continue;
    // MarketPeriod null = the full-match line; "half=1" etc. are period
    // sub-markets that don't settle on the final result.
    if (o.MarketPeriod != null) continue;
    const pcts: string[] = o.Pct ?? [];
    const prices: number[] = o.Prices ?? [];
    names.forEach((name, i) => {
      let prob: number | undefined;
      if (pcts[i] && pcts[i] !== "NA") prob = Number(pcts[i]) / 100;
      else if (prices[i]) prob = 1000 / Number(prices[i]);
      if (!prob || !(prob > 0 && prob < 1)) return;
      points.push({
        fixtureId: String(o.FixtureId),
        market: String(o.SuperOddsType ?? "unknown"),
        selection: normalizeSelection(name),
        timestamp: Number(o.Ts),
        decimalOdds: 1 / prob,
        inRunning: Boolean(o.InRunning),
        bookmaker: o.Bookmaker,
        messageId: o.MessageId,
      });
    });
  }
  return points;
}

// Selections stay in the feed's own participant terms (part1/draw/part2),
// which sidesteps home/away mapping entirely - fetchFixtureResult expresses
// the winner in the same terms.
function normalizeSelection(name: string): string {
  return name.trim().toLowerCase();
}

// One-time visibility into what the feed actually contains, so
// ODDS_MARKET_REGEX can be tuned against reality instead of guesses.
let inventoryLogged = false;
function logMarketInventory(points: OddsPoint[]) {
  if (inventoryLogged || points.length === 0) return;
  inventoryLogged = true;
  const markets = [...new Set(points.map((p) => p.market))];
  const bookmakers = [...new Set(points.map((p) => p.bookmaker))];
  console.log(
    `[oddsClient] markets seen: ${markets.join(", ")} | sources: ${bookmakers.join(", ")} | ` +
      `keeping markets matching ${MARKET_RE}`
  );
}
