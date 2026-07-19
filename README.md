# Sharp Movement Detector — TxLINE World Cup Hackathon (Trading Tools & Agents)

Watches TxLINE's consensus (StablePrice) odds for a fixture, flags fast/large
swings in implied win probability, and — the part the brief actually asks
for — checks after the fact whether those flagged moves pointed toward the
real winner.

## What's here

```
src/
  config.ts       network + program config (copied from TxLINE's own docs)
  walletSetup.ts  generates a local Solana devnet keypair
  auth.ts         on-chain subscribe + API token activation
  fixtures.ts     lists fixtures so you can pick IDs for .env
  oddsClient.ts   fetches odds history / fixture results (routes verified against the OpenAPI spec)
  types.ts        normalized data shapes everything else depends on
  detector.ts     the actual detection logic
  backtest.ts     runs detector on completed fixtures, scores hit rate
  live.ts         polls live/delayed odds and logs flags as they happen
idl/txoracle.json   Anchor IDL (devnet build, from github.com/txodds/tx-on-chain)
types/txoracle.ts   generated program types (same source)
```

The IDL/types are the **devnet** versions. When flipping to mainnet, swap in
the repo-root `idl/txoracle.json` + `types/txoracle.ts` from
[txodds/tx-on-chain](https://github.com/txodds/tx-on-chain), which carry the
mainnet program types.

API routes and payload shapes in `oddsClient.ts` were verified against
TxLINE's OpenAPI spec (`https://txline.txodds.com/docs/docs.yaml`):

- `GET /api/fixtures/snapshot?startEpochDay=&competitionId=` — fixture list
- `GET /api/odds/updates/{epochDay}/{hourOfDay}/{interval}?fixtureId=` —
  historical odds in 5-minute buckets (this is how "odds history" works;
  there is no single per-fixture history route, so the client walks buckets)
- `GET /api/odds/updates/{fixtureId}` — current 5-minute live cache
- `GET /api/scores/historical/{fixtureId}` — full score-update sequence,
  **only for fixtures that started between six hours and two weeks ago** —
  that window bounds which fixtures are backtestable

Odds payloads carry parallel `PriceNames` / `Prices` / `Pct` arrays per
market; `Pct` is implied probability in percent (3 decimals) and is used
directly, with `Prices` (decimal odds ×1000) as fallback.

## Setup

```bash
npm install
npm run setup:wallet          # creates wallet-devnet.json + prints your pubkey
# fund it: paste the pubkey into https://faucet.solana.com (devnet)
cp .env.example .env          # NETWORK=devnet by default
npm run auth                  # creates TXL token account if needed, subscribes on-chain, prints tokens
# paste the printed TXLINE_GUEST_JWT / TXLINE_API_TOKEN into .env
npm run fixtures              # lists fixtures; copy IDs into .env
```

Once auth works on devnet, flip `.env`'s `NETWORK` to `mainnet` to hit the
real World Cup free tier (service level 1 = 60s delay, 12 = real-time) — the
devnet free tier exists for testing the wallet/auth flow, not for actual
match data. Remember to swap the IDL/types for the mainnet versions.

## Running the backtest (recommended primary demo)

```bash
# .env: BACKTEST_FIXTURE_IDS=<comma-separated completed fixture IDs>
#       (must have started 6h–2 weeks ago; `npm run fixtures` marks these DONE)
#       WINDOW_MINUTES=15  PROBABILITY_THRESHOLD=0.08
npm run backtest
```

Pulls full odds history per fixture, flags sharp moves, and grades every
flag **two ways, split by regime (pre-match vs in-play)**:

- **Hit rate** — did the flagged selection win? Intuitive but needs
  hundreds of flags to mean anything (a correct 40%→48% signal still loses
  most of the time).
- **CLV (closing line value)** — did the market *keep moving* in the
  flagged direction after the flag? Pre-match flags are graded against the
  closing line (last pre-kickoff price); in-play flags against the price
  `CLV_HORIZON_MINUTES` later. CLV grades against a continuous target, so
  it's statistically meaningful at tens of flags — it's the metric
  professional traders use to judge whether a signal has real information.

The report prints the caveat with the numbers: in-play results are
structurally flattered (a leading team's probability drifts toward 100% as
the clock runs down), so **pre-match CLV is the honest measure of edge**.
Everything is written to `backtest-report.json`.

## Running live (fully autonomous)

```bash
npm run live
```

With `LIVE_FIXTURE_IDS` empty (the default), the watcher **discovers
fixtures itself**: it polls the fixtures feed, attaches to anything from
`AUTODISCOVER_LEAD_MINUTES` before kickoff until ~4.5 h after, and detaches
when done — zero manual input from deploy onward. Set `LIVE_FIXTURE_IDS`
to pin an explicit list instead.

Each poll (every 60 s, matching the free delayed tier) prints a heartbeat
line with tick counts and current implied probabilities, so a quiet market
is visibly different from a stalled process. When a move is flagged, the
watcher also fetches the **on-chain Merkle proof** for the exact tick that
completed the move (`/api/odds/validation`): the proof hashes reconstruct
the batch root TxODDS commits on Solana, making every flagged signal
independently verifiable — nobody, including us, can fabricate or backdate
the data behind a flag.

## Tuning

- `WINDOW_MINUTES` — how wide a trailing window counts as "fast." Smaller =
  stricter definition of a sharp move.
- `PROBABILITY_THRESHOLD` — absolute floor on the swing (`0.02` = 2
  percentage points).
- `Z_SCORE` — the volatility-normalized threshold. A fixed threshold
  assumes 2pp means the same thing everywhere; it doesn't — 2pp is an
  earthquake in a liquid final that normally ranges 0.3pp/hour and routine
  noise in a thin friendly ranging 1pp/hour. The detector therefore
  measures each series' own *normal window range* (the **median** of past
  window swings — median, not mean, so one genuine past move doesn't
  redefine "normal"; and only windows fully *before* the current one, so a
  move can't inflate its own baseline and hide itself) and flags only when
  the swing is both ≥ the floor **and** ≥ `Z_SCORE` × that baseline. Flags
  carry their z-score, so every alert says how abnormal it was for *that*
  market. Set 0 to fall back to the fixed floor.
- `CLV_HORIZON_MINUTES` — reference point for in-play CLV grading.

Calibration note (measured on devnet, 2026-07-18, 9 completed World Cup
fixtures, ~1.3k pre-match 1X2 ticks each): TxLINE's demargined StablePrice
is *smooth* pre-match — swings of 8pp/15min simply never occur, and even
2pp/15min is rare. Genuine pre-match signal starts around **2pp per hour**
(the shipped floor). In-play is a different regime: goals move the
consensus 8pp+ within seconds.
- `PREMATCH_HOURS` — hours of pre-kickoff odds history the backtest pulls
  (default 3).
- `ODDS_MARKET_REGEX` — which `SuperOddsType` values count as the
  match-winner market. The spec doesn't enumerate the values, so the client
  logs every market/source label it sees on first fetch — tighten this once
  you've seen real data.
- `COMPETITION_ID` / `FIXTURES_LOOKBACK_DAYS` — filters for `npm run fixtures`.

## Worth saying explicitly in your submission

TxLINE's StablePrice is already a blended consensus across bookmakers, so
this detects **sharp movement in the consensus itself**, not the classic
"steam move" pattern of watching individual bookmakers converge (which needs
per-bookmaker data this API doesn't expose). It's a related, defensible
proxy — large fast consensus moves still imply real money moved — but it's
worth stating that distinction up front rather than overclaiming it.
