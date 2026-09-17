/** Standard Elo with a configurable K-factor. */

export const ELO_K = parseInt(process.env.ELO_K || "32", 10);
export const START_ELO = 1000;

export function expectedScore(myElo: number, oppElo: number): number {
  return 1 / (1 + Math.pow(10, (oppElo - myElo) / 400));
}

export function eloDelta(myElo: number, oppElo: number, outcome: 0 | 1 | 0.5, k = ELO_K): number {
  return Math.round(k * (outcome - expectedScore(myElo, oppElo)));
}

/**
 * Team-aware Elo: each player is scored against the average rating of the
 * opposing side. Suspicious matches have their delta halved — never fully
 * trusted, never silently dropped (full transparency in match history).
 */
export function computeEloOutcomes(
  sides: Array<Array<{ playerId: string; elo: number; outcome: 0 | 0.5 | 1 }>>,
  suspicious: boolean
): Array<{ playerId: string; eloBefore: number; eloAfter: number }> {
  const out: Array<{ playerId: string; eloBefore: number; eloAfter: number }> = [];
  for (let i = 0; i < sides.length; i++) {
    const opp = sides[(i + 1) % sides.length];
    const oppAvg = opp.reduce((s, p) => s + p.elo, 0) / Math.max(1, opp.length);
    for (const p of sides[i]) {
      let d = eloDelta(p.elo, oppAvg, p.outcome);
      if (suspicious) d = Math.round(d / 2);
      out.push({ playerId: p.playerId, eloBefore: p.elo, eloAfter: p.elo + d });
    }
  }
  return out;
}
