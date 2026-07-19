# Demo video script — Sharp Movement Detector (~2.5 min)

Judges evaluate heavily on this video. Structure: hook → live autonomy →
evidence → honesty → close. Each scene lists WHAT'S ON SCREEN and NARRATION.

## Prep (do BEFORE recording — nothing should be seen loading)

```bash
cd ~/Downloads/sharp-movement-detector
npm run backtest        # instant - everything cached; warms the console output
npm run tune            # instant - have this output ready in a terminal tab
npm run live            # leave running; dashboard at http://localhost:8787
```

Open in browser tabs, in order:
1. https://santzthedon.github.io/sharp-movement-detector/  (replay explorer)
2. http://localhost:8787  (live dashboard)
3. https://github.com/santzthedon/sharp-movement-detector  (repo, for one glance)

Terminal: full screen, font size bumped (⌘+ a few times), one tab per command.
Do a 10-second test recording first and check audio levels.

---

## Scene 1 — The hook (0:00–0:20) · replay explorer, Canada vs Bosnia

> "When informed money bets on a football match, the odds move fast — before
> the rest of the market catches up. This is Sharp Movement Detector: an
> autonomous agent that watches TxLINE's consensus odds on Solana, flags
> those moves the moment they happen, and — the important part — grades
> itself on whether they meant anything."

Action: page is already open on the most-flagged match. Slowly move cursor
along the chart to an amber dot cluster.

## Scene 2 — Autonomous + live (0:20–1:00) · local dashboard + terminal

> "Once deployed, no human touches it. The agent pays for its data
> subscription on-chain, discovers fixtures from the TxLINE feed by itself,
> attaches an hour before kickoff, and detaches when the match is done."

Action: show localhost:8787 — pulse dot, watchlist, sparklines.
**If the final is in play:** linger on the live probability lines moving.
**If before kickoff:** the "standing by" card IS the story — say:
> "Right now it's standing by — tonight it will pick up the World Cup final
> on its own."

Then switch to the `npm run live` terminal, scroll to any SHARP MOVE line:

> "When a move is flagged, the agent immediately pulls the Merkle proof
> anchoring that exact odds tick to the root TxODDS commits on Solana. Every
> signal is cryptographically verifiable — nobody, including us, can
> fabricate or backdate the data behind a flag."

Point at the "on-chain proof: N Merkle nodes" line.

## Scene 3 — The evidence (1:00–1:50) · replay explorer + backtest terminal

> "But does it mean anything? We replayed the entire tournament — 103
> matches. Where TxLINE's score history had expired, the agent labeled
> results from the market itself: at the final whistle the winner trades at
> essentially 100 percent. That method agreed with official scores on all
> thirteen matches where both exist."

Action: explorer — click through 2–3 matches in the ledger (pick ones with
flags; end on France vs England).

> "Every flag is graded two ways: did the outcome win, and — the metric
> professional traders actually use — did the closing line keep moving our
> way. Our flagged outcomes won sixty-two percent of the time when the
> market priced them at forty-five."

Action: cursor to the stat row (63.2% / +1.87pp), then show the
`npm run tune` terminal briefly:

> "Thresholds aren't guesses — a grid search over the cached tournament
> picked a fifteen-minute window at three times each market's own
> volatility. The z-score matters: 'big' is relative. Two points is an
> earthquake in a liquid final and noise in a thin friendly — so the
> detector normalizes against every market's normal range."

## Scene 4 — The honesty (1:50–2:10) · explorer footer / stat row

> "We're deliberate about what we don't claim. In-play numbers are inflated
> by clock decay, so they're excluded from the objective. This is one
> tournament, tuned in-sample — about a one-in-ten chance the edge is luck.
> The system is built to keep grading itself on new data until it's proven
> one way or the other. And we chose deterministic statistics over machine
> learning on purpose: every flag is explainable in one sentence, and the
> pipeline logs everything needed to train a model when the data justifies
> it."

## Scene 5 — Close (2:10–2:30) · repo page, then back to explorer

> "TypeScript, Solana, TxLINE end to end: on-chain subscription, live
> ingestion, autonomous detection, on-chain proofs, and a public replay
> explorer anybody can browse. Sharp Movement Detector."

Action: one glance at the GitHub repo, end on the explorer stat row.

---

## Recording tips
- QuickTime: ⌘⇧5 → Record Entire Screen → built-in mic is fine, quiet room.
- Record scenes as separate clips; stitch in iMovie/CapCut. Retakes are free.
- Speak ~10% slower than feels natural.
- Hide bookmarks bar + notifications (⌘⇧5 has no Do Not Disturb — turn it on
  in Control Center first).
- If a live flag fires on camera during the final, abandon the script and
  narrate it — that clip becomes the opening of the video.
