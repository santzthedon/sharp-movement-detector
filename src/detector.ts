import { OddsPoint, FlaggedMove, impliedProbability } from "./types";

export interface DetectorOptions {
  /** Size of the trailing window to scan for movement, in milliseconds. */
  windowMs: number;
  /**
   * Absolute floor on the swing in implied win probability, e.g. 0.02 = 2
   * percentage points. With adaptive mode on, this stops microscopic
   * twitches in ultra-flat markets from z-scoring as "large".
   */
  probabilityThreshold: number;
  /**
   * Adaptive (volatility-normalized) mode: flag only when the swing is also
   * >= zScore x this series' own typical window range (the median swing of
   * past windows). 0/undefined = fixed-threshold mode. A fixed threshold
   * treats every market the same, but "big" is relative: 2pp is an
   * earthquake in a liquid final that normally ranges 0.3pp/hour, and
   * routine noise in a thin friendly that ranges 1pp/hour. The z-score
   * self-calibrates per fixture.
   */
  zScore?: number;
}

/** How many completed prior windows we need before trusting the baseline. */
const MIN_BASELINE_SAMPLES = 10;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Scans a chronological odds series and flags windows where implied win
 * probability swung sharply - "sharply" meaning at least
 * `probabilityThreshold` absolute, and (in adaptive mode) at least
 * `zScore` times the series' own normal range.
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

    // Every iteration measures one window's swing; those measurements ARE
    // the volatility history. An entry becomes usable as baseline only
    // once the current window has slid completely past it - otherwise the
    // move under evaluation would inflate its own baseline and hide itself.
    const swingHistory: { ts: number; swing: number }[] = [];
    let eligibleCount = 0;

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

      // Advance the eligibility pointer: history entries recorded at or
      // before the current window's start no longer overlap it.
      while (
        eligibleCount < swingHistory.length &&
        swingHistory[eligibleCount].ts <= series[windowStartIdx].timestamp
      ) {
        eligibleCount++;
      }

      // Effective threshold: the absolute floor, raised (never lowered) by
      // the adaptive term once we have enough history to know "normal".
      // Median, not mean: one past genuine move must not redefine normal.
      let baseline: number | undefined;
      let threshold = opts.probabilityThreshold;
      if (opts.zScore && eligibleCount >= MIN_BASELINE_SAMPLES && swing >= threshold) {
        baseline = median(swingHistory.slice(0, eligibleCount).map((s) => s.swing));
        threshold = Math.max(threshold, opts.zScore * baseline);
      }

      if (swing >= threshold) {
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
            inRunning: Boolean(series[chronologicalSecond].inRunning),
            messageId: series[chronologicalSecond].messageId,
            zScore: baseline ? swing / baseline : undefined,
            baselineSwing: baseline,
          });

          active = true;
        }
        // else: still inside the same episode - don't re-emit.
      } else {
        active = false; // move has resolved - ready to detect the next one
      }

      swingHistory.push({ ts: series[j].timestamp, swing });
    }
  }

  return flags;
}
