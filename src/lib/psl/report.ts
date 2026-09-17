/**
 * Report-model helpers: turn a stored PSL result (or its flattened
 * `components` map) into the group/metric breakdown the PSL Rater renders.
 *
 * Everything here is derived from the pinned model constants, so a restored
 * scan (which only stores the flattened components) renders identically to a
 * fresh scan.
 */
import type { GroupScore, MetricResult, PslResult } from "./types";
import {
  GROUP_LABELS,
  GROUP_WEIGHTS,
  METRIC_SPECS,
  SYMMETRY_REF,
  type GroupKey,
} from "./version";

/** Rebuild the full breakdown from the flattened components map. */
export function groupsFromComponents(components: Record<string, number>): GroupScore[] {
  const byGroup = new Map<string, MetricResult[]>();
  for (const spec of METRIC_SPECS) {
    const v = components[`metric:${spec.key}`];
    if (v == null) continue;
    const z = Math.max(-(spec.maxZ ?? 4), Math.min(spec.maxZ ?? 4, (v - spec.refMean) / spec.refSd));
    if (!byGroup.has(spec.group)) byGroup.set(spec.group, []);
    byGroup.get(spec.group)!.push({
      key: spec.key,
      label: spec.label,
      value: v,
      refMean: spec.refMean,
      refSd: spec.refSd,
      z,
    });
  }
  const asym = components["metric:asymmetryIndex"];
  if (asym != null) {
    byGroup.set("symmetry", [
      {
        key: "asymmetryIndex",
        label: "Mean mirrored landmark deviation",
        value: asym,
        refMean: SYMMETRY_REF.refMean,
        refSd: SYMMETRY_REF.refSd,
        z: asym / SYMMETRY_REF.refSd,
      },
    ]);
  }
  const out: GroupScore[] = [];
  for (const [key, metrics] of byGroup) {
    out.push({
      key,
      label: GROUP_LABELS[key as GroupKey] ?? key,
      weight: GROUP_WEIGHTS[key as GroupKey] ?? 0,
      score: components[`group:${key}`] ?? 0,
      metrics,
    });
  }
  return out;
}

/** Human-friendly rendering of a metric value. */
export function fmtMetric(key: string, value: number): string {
  if (key === "canthalTiltDeg") return `${value >= 0 ? "+" : ""}${value.toFixed(1)}°`;
  if (key === "asymmetryIndex") return `${(value * 100).toFixed(2)}%`;
  if (key === "faceWidthInEyeWidths") return `${value.toFixed(2)} eye-widths`;
  return value.toFixed(3);
}

/** Reference value in the same display format. */
export function fmtRef(key: string, ref: number): string {
  if (key === "canthalTiltDeg") return `+${ref.toFixed(1)}°`;
  if (key === "asymmetryIndex") return `${(ref * 100).toFixed(1)}%`;
  if (key === "faceWidthInEyeWidths") return `${ref.toFixed(1)} eye-widths`;
  return ref.toFixed(3);
}

/** Short verdict for a metric's deviation from its reference. */
export function metricVerdict(m: MetricResult): { text: string; tone: "gold" | "green" | "cyan" | "neutral" | "red" } {
  const abs = Math.abs(m.z);
  if (abs <= 0.5) return { text: "on reference", tone: "gold" };
  if (abs <= 1.2) return { text: `${abs.toFixed(1)} SD ${m.z > 0 ? "above" : "below"}`, tone: "green" };
  if (abs <= 2.2) return { text: `${abs.toFixed(1)} SD ${m.z > 0 ? "above" : "below"}`, tone: "cyan" };
  return { text: `${abs.toFixed(1)} SD ${m.z > 0 ? "above" : "below"}`, tone: "red" };
}

export function groupsFromResult(r: PslResult): GroupScore[] {
  return r.groups;
}
