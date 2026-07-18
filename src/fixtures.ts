/**
 * Lists fixtures so you can pick IDs for BACKTEST_FIXTURE_IDS /
 * LIVE_FIXTURE_IDS in .env.
 *
 * Run: npm run fixtures
 * Optional .env: COMPETITION_ID (e.g. 72), FIXTURES_LOOKBACK_DAYS (default 13
 * - matches the scores endpoint's two-week history limit, so everything
 * marked DONE below is backtestable).
 */
import * as dotenv from "dotenv";
dotenv.config();
import { fetchFixtures } from "./oddsClient";

const DAY_MS = 86_400_000;

async function main() {
  const jwt = process.env.TXLINE_GUEST_JWT;
  const apiToken = process.env.TXLINE_API_TOKEN;
  if (!jwt || !apiToken) {
    throw new Error(
      "Set TXLINE_GUEST_JWT and TXLINE_API_TOKEN in .env (run `npm run auth` first)."
    );
  }

  const lookbackDays = Number(process.env.FIXTURES_LOOKBACK_DAYS || 13);
  const startEpochDay = Math.floor(Date.now() / DAY_MS) - lookbackDays;
  const competitionId = process.env.COMPETITION_ID
    ? Number(process.env.COMPETITION_ID)
    : undefined;

  const fixtures = await fetchFixtures(jwt, apiToken, startEpochDay, competitionId);
  fixtures.sort((a, b) => a.startTime - b.startTime);

  const now = Date.now();
  console.log(`${fixtures.length} fixture(s) starting on/after epoch day ${startEpochDay}:\n`);
  for (const f of fixtures) {
    // DONE here means "started >6h ago", the window where both the odds
    // interval history and /scores/historical are available for backtesting.
    const status =
      f.startTime < now - 6 * 3_600_000 ? "DONE" : f.startTime < now ? "LIVE" : "SOON";
    console.log(
      `[${status}] ${f.fixtureId}  ${new Date(f.startTime).toISOString()}  ` +
        `${f.competition} (${f.competitionId}): ${f.participant1} vs ${f.participant2}`
    );
  }
  console.log(
    "\nPut DONE fixture IDs into BACKTEST_FIXTURE_IDS, LIVE/SOON ones into LIVE_FIXTURE_IDS."
  );
}

main().catch((err) => {
  console.error("Fixture listing failed:", err?.response?.data || err);
  process.exit(1);
});
