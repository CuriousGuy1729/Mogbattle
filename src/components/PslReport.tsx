"use client";
/**
 * The PSL Rater: renders a PSL /10 appeal score as a full looksmaxxing
 * breakdown — every pinned facial-ratio metric with its measured value,
 * reference target, and standardized deviation.
 *
 * The score is NOT an AI guess. It is the deterministic geometric pipeline:
 * stabilized landmarks → canonical alignment → dimensionless ratios →
 * z-scores vs pinned references → weighted group scores → /10.
 */
import { CountUp, ConfidenceBar, Badge } from "@/components/ui";
import type { GroupScore } from "@/lib/psl/types";
import { fmtMetric, fmtRef, metricVerdict } from "@/lib/psl/report";
import Link from "next/link";

const scoreTone = (s: number) =>
  s >= 7.5 ? "text-gradient-gold" : s >= 6 ? "text-arena-cyan" : s >= 4 ? "text-white" : "text-arena-red";

export default function PslReport({
  score,
  confidence,
  version,
  groups,
  extras,
  compact = false,
}: {
  score: number;
  confidence: number;
  version: string;
  groups: GroupScore[];
  extras?: { fwHR?: number | null };
  compact?: boolean;
}) {
  return (
    <div className="space-y-5">
      {/* headline */}
      <div className="panel relative overflow-hidden p-6">
        <div className="bg-grid absolute inset-0 opacity-40" />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="label-tech">PSL appeal score · geometric rater</div>
            <div className={`mt-1 font-mono text-6xl font-black ${scoreTone(score)}`}>
              <CountUp value={score} decimals={2} />
              <span className="text-2xl text-white/40"> /10</span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge tone="gold">{version}</Badge>
              <Badge tone="neutral">ratio-based · no black box</Badge>
              {extras?.fwHR != null && (
                <Badge tone="cyan">fWHR {extras.fwHR.toFixed(3)} · informational</Badge>
              )}
            </div>
          </div>
          <div className="w-full max-w-[220px]">
            <ConfidenceBar value={confidence} />
          </div>
        </div>
      </div>

      {/* group breakdown */}
      <div className={`grid gap-4 ${compact ? "" : "md:grid-cols-2"}`}>
        {groups.map((g) => (
          <div key={g.key} className="panel p-5">
            <div className="mb-3 flex items-center justify-between gap-2 border-b border-white/5 pb-2">
              <div className="text-sm font-bold text-white/90">{g.label}</div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-lg font-black text-gradient-gold">{g.score.toFixed(2)}</span>
                <span className="text-[10px] text-white/30">w {(g.weight * 100).toFixed(0)}%</span>
              </div>
            </div>
            <div className="space-y-2.5">
              {g.metrics.map((m) => {
                const v = metricVerdict(m);
                return (
                  <div key={m.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <div className="min-w-0 flex-1 text-xs text-white/60">{m.label}</div>
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <span className="text-white/90">{fmtMetric(m.key, m.value)}</span>
                      <span className="text-white/25">ref {fmtRef(m.key, m.refMean)}</span>
                      <Badge tone={v.tone}>{v.text}</Badge>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px] leading-relaxed text-white/35">
        Every number above is a dimensionless facial ratio measured from your stabilized landmarks and compared to the
        pinned reference for this model version. Same face → same readings → same score. This is a platform facial-analysis
        score, not a judgment of worth.{" "}
        <Link href="/methodology" className="text-gold-400 underline-offset-2 hover:underline">
          How it&apos;s calculated
        </Link>
      </p>
    </div>
  );
}
