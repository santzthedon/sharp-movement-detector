import { OddsPoint, FlaggedMove, impliedProbability } from "./types";

export interface DetectorOptions {
  /** Size of the trailing window to scan for movement, in milliseconds. */
  windowMs: number;
  /** Minimum swing in implied win probability within the window to flag, e.g. 0.08 = 8 percentage points. */
  probabilityThreshold: number;
}

/**
 * Scans a chronological odds series and flags windows where implied win
 * probability swung by more than `probabilityThreshold` within
 * `windowMs`.
 *
 * This is intentionally NOT the textbook definition of a "steam move"
 * (which requires watching *divergent individual bookmakers* converge).
 * TxLINE's StablePrice is already a blended consensus figure, so what this
 * detects is: the consensus itself moving sharply and quickly. That's a
 * reasonable, related signal - large, fast consensus moves still imply a
 * lot of underlying money moved - but it's a proxy, not the same thing.
 * Worth stating explicitly in your demo/writeup rather than glossing over.
 */
export function detectSharpMoves(
  points: OddsPoint[],
  opts: DetectorOptions
): FlaggedMove[] {
  const groups = new Map<string, OddsPoint[]>();
  for (const p of points) {
    const key = `${p.fixtureId}|${p.market}|${p.selection}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const flags: FlaggedMove[] = [];

  for (const series of groups.values()) {
    series.sort((a, b) => a.timestamp - b.timestamp);
    const probs = series.map((p) => impliedProbability(p.decimalOdds));

    let windowStartIdx = 0;
    // State machine, not timestamp suppression: a single underlying move
    // will keep the swing >= threshold for several consecutive ticks as
    // the window slides across it. `active` ensures we emit exactly one
    // flag per episode - we only arm again once the swing has dropped
    // back below threshold (the move has fully resolved).
    let active = false;

    for (let j = 0; j < series.length; j++) {
      // Slide the trailing window forward so it never exceeds windowMs.
      while (series[j].timestamp - series[windowStartIdx].timestamp > opts.windowMs) {
        windowStartIdx++;
      }

      // Find the largest probability swing within the current window.
      // O(window size) per step - fine at hackathon data volumes (hundreds
      // of updates per match). Swap for a monotonic deque if you need this
      // to scale to many fixtures streaming concurrently.
      let minP = Infinity;
      let maxP = -Infinity;
      let minIdx = windowStartIdx;
      let maxIdx = windowStartIdx;
      for (let k = windowStartIdx; k <= j; k++) {
        if (probs[k] < minP) {
          minP = probs[k];
          minIdx = k;
        }
        if (probs[k] > maxP) {
          maxP = probs[k];
          maxIdx = k;
        }
      }

      const swing = maxP - minP;

      if (swing >= opts.probabilityThreshold) {
        if (!active) {
          const chronologicalFirst = minIdx < maxIdx ? minIdx : maxIdx;
          const chronologicalSecond = minIdx < maxIdx ? maxIdx : minIdx;
          const signedDelta = probs[chronologicalSecond] - probs[chronologicalFirst];

          flags.push({
            fixtureId: series[j].fixtureId,
            market: series[j].market,
            selection: series[j].selection,
            windowStart: series[chronologicalFirst].timestamp,
            windowEnd: series[chronologicalSecond].timestamp,
            startingProbability: probs[chronologicalFirst],
            peakProbability: probs[chronologicalSecond],
            probabilityDelta: signedDelta,
          });

          active = true;
        }
        // else: still inside the same episode - don't re-emit.
      } else {
        active = false; // move has resolved - ready to detect the next one
      }
    }
  }

  return flags;
}
