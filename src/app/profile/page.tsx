"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client/session";
import { Badge, Stat } from "@/components/ui";

interface RatingPoint { elo: number; delta: number; at: string; matchId: string | null }
interface MatchRow {
  id: string; mode: string; createdAt: string; status: string; winnerSide: number | null; suspicious: boolean;
  players: Array<{ playerId: string; handle: string; side: number; score: number | null; eloBefore: number | null; eloAfter: number | null; result: string }>;
}
interface Profile {
  player: {
    id: string; handle: string; region: string; psl: number | null; pslConfidence: number | null; scanVersion: string | null;
    elo: number; peakElo: number; wins: number; losses: number; streak: number; bestStreak: number;
    casualWins: number; casualLosses: number; createdAt: string;
  };
  ratings: RatingPoint[];
  matches: MatchRow[];
  scan: { id: string; psl: number; confidence: number; version: string; createdAt: string; quality: Record<string, number>; components: Record<string, number> } | null;
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="grid h-24 place-items-center text-xs text-white/30">Play ranked matches to chart your rating</div>;
  const w = 600, h = 96, pad = 6;
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${pad + (i / (points.length - 1)) * (w - 2 * pad)},${h - pad - ((p - min) / span) * (h - 2 * pad)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-24 w-full">
      <path d={d} fill="none" stroke="#eab84a" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={w - pad} cy={h - pad - ((points[points.length - 1] - min) / span) * (h - 2 * pad)} r="4" fill="#eab84a" />
    </svg>
  );
}

export default function ProfilePage() {
  const [data, setData] = useState<Profile | null>(null);
  const [handle, setHandle] = useState("");
  const [region, setRegion] = useState("global");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api<Profile>("/api/profile").then((d) => {
      setData(d);
      setHandle(d.player.handle);
      setRegion(d.player.region);
    }).catch(() => setData(null));
  }, []);

  if (!data) return <div className="grid min-h-[50vh] place-items-center text-white/40">Loading profile…</div>;

  const p = data.player;
  const total = p.wins + p.losses;
  const winRate = total ? ((p.wins / total) * 100).toFixed(1) : "0.0";
  const ratingsAsc = [...data.ratings].reverse();

  async function save() {
    try {
      await api("/api/session", { method: "PATCH", body: JSON.stringify({ handle, region }) });
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      api<Profile>("/api/profile").then(setData);
    } catch { /* rate limited */ }
  }

  return (
    <div className="space-y-6 py-8">
      {/* player card */}
      <div className="panel relative overflow-hidden p-6">
        <div className="bg-grid absolute inset-0 opacity-40" />
        <div className="relative flex flex-wrap items-center justify-between gap-6">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-black">{p.handle}</h1>
              <Badge tone="neutral">{p.region.toUpperCase()}</Badge>
              {p.pslConfidence != null && <Badge tone="green">verified</Badge>}
            </div>
            <p className="mt-1 text-xs text-white/40">
              member since {new Date(p.createdAt).toLocaleDateString()} · scan model {p.scanVersion ?? "—"}
            </p>
          </div>
          <div className="text-right">
            <div className="label-tech">PSL SCORE</div>
            <div className="font-mono text-5xl font-black text-gradient-gold">
              {p.psl != null ? p.psl.toFixed(2) : "—"}<span className="text-xl text-white/40"> /10</span>
            </div>
            {p.pslConfidence != null && <div className="text-xs text-white/40">confidence {(p.pslConfidence * 100).toFixed(0)}%</div>}
          </div>
        </div>
        <div className="relative mt-6 grid grid-cols-2 gap-3 sm:grid-cols-6">
          <Stat label="ELO" value={p.elo.toLocaleString()} accent="text-gold-400" />
          <Stat label="Peak" value={p.peakElo.toLocaleString()} />
          <Stat label="Wins" value={p.wins} accent="text-arena-green" />
          <Stat label="Losses" value={p.losses} accent="text-arena-red" />
          <Stat label="Win Rate" value={`${winRate}%`} />
          <Stat label="Current Streak" value={p.streak > 0 ? `W${p.streak}` : p.streak < 0 ? `L${-p.streak}` : "—"} accent={p.streak > 0 ? "text-arena-green" : p.streak < 0 ? "text-arena-red" : undefined} />
        </div>
        <div className="relative mt-3 text-center text-xs text-white/35">
          best streak {p.bestStreak} · casual {p.casualWins}W–{p.casualLosses}L (no rating impact)
        </div>
      </div>

      {/* rating history */}
      <div className="panel p-5">
        <h2 className="mb-2 font-bold">Rating history</h2>
        <Sparkline points={[1000, ...ratingsAsc.map((r) => r.elo)]} />
      </div>

      {/* scan audit */}
      {data.scan && (
        <div className="panel p-5">
          <h2 className="mb-1 font-bold">Latest certified scan — audit record</h2>
          <p className="mb-3 text-xs text-white/40">
            Version {data.scan.version} · {new Date(data.scan.createdAt).toLocaleString()} · quality metrics below are
            what the server validated. Score components are stored without any facial imagery.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {Object.entries(data.scan.components)
              .filter(([k]) => k.startsWith("group:"))
              .map(([k, v]) => (
                <div key={k} className="flex justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-sm">
                  <span className="text-white/60">{k.replace("group:", "")}</span>
                  <span className="font-mono font-bold text-gold-400">{v.toFixed(2)}</span>
                </div>
              ))}
            {Object.entries(data.scan.quality).map(([k, v]) => (
              <div key={k} className="flex justify-between rounded-lg bg-white/[0.03] px-3 py-2 text-sm">
                <span className="text-white/60">quality · {k}</span>
                <span className="font-mono text-white/80">{v}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* match history */}
      <div className="panel p-5">
        <h2 className="mb-3 font-bold">Match history</h2>
        {data.matches.length === 0 && <p className="text-sm text-white/35">No matches yet.</p>}
        <div className="space-y-2">
          {data.matches.map((m) => {
            const mine = m.players.find((x) => x.result !== "pending");
            const myEntry = m.players.find((x) => x.eloAfter != null || x.score != null) ?? m.players[0];
            void mine;
            const win = myEntry?.result === "win";
            const delta = myEntry?.eloBefore != null && myEntry?.eloAfter != null ? myEntry.eloAfter - myEntry.eloBefore : null;
            return (
              <div key={m.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-4 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <Badge tone={m.status === "aborted" ? "neutral" : win ? "green" : myEntry?.result === "loss" ? "red" : "neutral"}>
                    {m.status === "aborted" ? "ABORT" : win ? "WIN" : myEntry?.result === "loss" ? "LOSS" : myEntry?.result?.toUpperCase()}
                  </Badge>
                  <span className="font-medium capitalize">{m.mode}</span>
                  <span className="text-xs text-white/35">{new Date(m.createdAt).toLocaleString()}</span>
                  {m.suspicious && <Badge tone="gold">flagged</Badge>}
                </div>
                <div className="flex items-center gap-4 font-mono text-xs text-white/60">
                  {m.players.map((x) => (
                    <span key={x.playerId}>
                      {x.handle}: {x.score != null ? x.score.toFixed(2) : "—"}
                    </span>
                  ))}
                  {delta != null && (
                    <span className={delta >= 0 ? "text-arena-green" : "text-arena-red"}>
                      {delta >= 0 ? "+" : ""}{delta}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* settings */}
      <div className="panel p-5">
        <h2 className="mb-3 font-bold">Identity</h2>
        <div className="flex flex-wrap gap-3">
          <input className="input-dark max-w-xs" value={handle} maxLength={18} onChange={(e) => setHandle(e.target.value)} placeholder="handle" />
          <select className="input-dark max-w-[160px]" value={region} onChange={(e) => setRegion(e.target.value)}>
            {["global", "na", "sa", "eu", "mena", "asia", "oce", "africa"].map((r) => (
              <option key={r} value={r}>{r.toUpperCase()}</option>
            ))}
          </select>
          <button className="btn-gold !py-3" onClick={save}>{saved ? "Saved ✓" : "Save"}</button>
        </div>
        <p className="mt-2 text-xs text-white/35">Region feeds the regional leaderboard. Handles are display names — identity is your session token.</p>
      </div>
    </div>
  );
}
