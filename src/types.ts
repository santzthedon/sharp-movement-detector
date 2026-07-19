/** A single consensus (StablePrice) odds reading for one selection in one market. */
export interface OddsPoint {
  fixtureId: string;
  market: string; // SuperOddsType, e.g. "1X2_PARTICIPANT_RESULT"
  selection: string; // feed's participant terms: "part1", "draw", "part2"
  timestamp: number; // epoch ms
  decimalOdds: number; // e.g. 2.10
  inRunning?: boolean; // true if the odds tick arrived while the match was in play
  bookmaker?: string; // source label from the feed (TxLINE data is consensus StablePrice)
  messageId?: string; // feed's unique update id - needed to fetch its on-chain Merkle proof
}

/** Convenience derived value - implied win probability from decimal odds. */
export function impliedProbability(decimalOdds: number): number {
  return 1 / decimalOdds;
}

export interface FlaggedMove {
  fixtureId: string;
  market: string;
  selection: string;
  windowStart: number;
  windowEnd: number;
  startingProbability: number;
  peakProbability: number;
  probabilityDelta: number; // peak - starting, signed
  // The selection the move favoured is just `selection` shortening in price,
  // i.e. probabilityDelta > 0 for this selection.
  inRunning: boolean; // was the match in play when the move completed?
  messageId?: string; // messageId of the tick that completed the move (for on-chain proof)
  /** swing / baseline: how many "normal window ranges" this move measured. Absent when adaptive mode was off or warming up. */
  zScore?: number;
  /** median swing of prior windows - the "normal range" this move was compared against. */
  baselineSwing?: number;
}

export interface FixtureResult {
  fixtureId: string;
  winningSelection: string; // "part1" | "draw" | "part2", matching OddsPoint.selection
}

export interface BacktestRow extends FlaggedMove {
  actualWinner: string;
  correct: boolean; // did the direction of the move match the actual winner?
  regime: "pre-match" | "in-play";
  /** Implied probability at the CLV reference moment (closing line for pre-match, +horizon for in-play). */
  referenceProbability?: number;
  /** referenceProbability - peakProbability: positive = market kept moving our way after the flag. */
  clv?: number;
}
