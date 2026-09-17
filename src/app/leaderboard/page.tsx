"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/session";
import { Badge } from "@/components/ui";

type BoardKey = "global" | "weekly" | "season" | "region";

interface GlobalRow {
  rank: number; id: string; handle: string; region: string; elo: number; peakElo: number;
  psl: number | null; wins: number; losses: number; streak: number;
}
interface WeeklyRow {
  rank: number; id: string; handle: string; region: string; delta: number; matches: number; elo: number; psl: number | null;
}

const REGIONS = [
  ["global", "🌍 Global"], ["na", "🌎 NA"], ["sa", "🌎 SA"], ["eu", "🌍 EU"],
  ["mena", "🌍 MENA"], ["asia", "🌏 Asia"], ["oce", "🌏 OCE"], ["africa", "🌍 Africa"],
] as const;

export default function LeaderboardPage() {
  const [board, setBoard] = useState<BoardKey>("global");
  const [region, setRegion] = useState<string>("global");
  const [rows, setRows] = useState<Array<GlobalRow | WeeklyRow>>([]);
  const [meta, setMeta] = useState<{ since?: string; label?: string }>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const qs = board === "region" ? `board=region&region=${region}` : `board=${board}`;
    api<{ rows: Array<GlobalRow | WeeklyRow>; since?: string; label?: string }>(`/api/leaderboard?${qs}`)
      .then((d) => {
        setRows(d.rows);
        setMeta({ since: d.since, label: d.label });
      })
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [board, region]);

  const isWeeklyStyle = board === "weekly" || board === "season";

  return (
    <div className="space-y-6 py-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black">Leaderboards</h1>
          <p className="text-sm text-white/45">
            Ranked by Elo · PSL shown separately — {meta.label ?? (board === "weekly" ? "this week" : board === "season" ? "season-to-date" : "all time")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["global", "weekly", "season", "region"] as BoardKey[]).map((b) => (
            <button
              key={b}
              onClick={() => setBoard(b)}
              className={`rounded-xl px-4 py-2 text-sm font-semibold capitalize transition ${
                board === b ? "bg-gold-500 text-ink-950" : "border border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/[0.07]"
              }`}
            >
              {b === "season" ? "Seasonal" : b}
            </button>
          ))}
        </div>
      </div>

      {board === "region" && (
        <div className="flex flex-wrap gap-2">
          {REGIONS.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setRegion(id)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
                region === id ? "bg-white/15 text-white" : "border border-white/10 text-white/50 hover:bg-white/[0.05]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-[0.15em] text-white/35">
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">Player</th>
              <th className="px-4 py-3 text-right">{isWeeklyStyle ? "Elo Δ" : "Elo"}</th>
              <th className="px-4 py-3 text-right">{isWeeklyStyle ? "Matches" : "Peak"}</th>
              <th className="px-4 py-3 text-right">PSL /10</th>
              <th className="px-4 py-3 text-right">W – L</th>
              <th className="px-4 py-3 text-right">Streak</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-white/35">
                  No ranked activity yet — be the first on the board.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const w = r as WeeklyRow;
              const g = r as GlobalRow;
              return (
                <tr key={r.id} className="border-b border-white/[0.04] transition hover:bg-white/[0.03]">
                  <td className="px-4 py-3 font-mono">
                    {r.rank <= 3 ? <span className="text-lg">{["🥇", "🥈", "🥉"][r.rank - 1]}</span> : <span className="text-white/40">{r.rank}</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2 font-semibold">
                      {r.handle}
                      <span className="text-[10px] uppercase text-white/30">{r.region}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-bold">
                    {isWeeklyStyle ? (
                      <span className={w.delta >= 0 ? "text-arena-green" : "text-arena-red"}>
                        {w.delta >= 0 ? "+" : ""}{w.delta}
                      </span>
                    ) : (
                      g.elo
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-white/60">{isWeeklyStyle ? w.matches : g.peakElo}</td>
                  <td className="px-4 py-3 text-right font-mono text-gold-400">{r.psl != null ? r.psl.toFixed(2) : "—"}</td>
                  <td className="px-4 py-3 text-right font-mono text-white/60">
                    {isWeeklyStyle ? "—" : `${g.wins} – ${g.losses}`}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {!isWeeklyStyle && g.streak !== 0 ? (
                      <Badge tone={g.streak > 0 ? "green" : "red"}>
                        {g.streak > 0 ? `W${g.streak}` : `L${-g.streak}`}
                      </Badge>
                    ) : (
                      <span className="text-white/25">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-center text-xs text-white/30">
        Leaderboard movement is computed live during matches. Anti-farm pair cooldowns keep every game meaningful.
      </p>
    </div>
  );
}
