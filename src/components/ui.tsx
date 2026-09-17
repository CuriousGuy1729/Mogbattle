"use client";
import { useEffect, useRef, useState } from "react";

export function Stat({ label, value, accent }: { label: string; value: React.ReactNode; accent?: string }) {
  return (
    <div className="panel px-4 py-3 text-center">
      <div className={`font-mono text-xl font-bold ${accent ?? "text-white"}`}>{value}</div>
      <div className="label-tech mt-1">{label}</div>
    </div>
  );
}

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "gold" | "green" | "red" | "cyan" | "neutral" }) {
  const tones: Record<string, string> = {
    gold: "border-gold-500/40 bg-gold-500/10 text-gold-400",
    green: "border-arena-green/40 bg-arena-green/10 text-arena-green",
    red: "border-arena-red/40 bg-arena-red/10 text-arena-red",
    cyan: "border-arena-cyan/40 bg-arena-cyan/10 text-arena-cyan",
    neutral: "border-white/10 bg-white/[0.04] text-white/70",
  };
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${tones[tone]}`}>{children}</span>;
}

/** Animated count-up number for dramatic reveals. */
export function CountUp({ value, decimals = 2, duration = 1400, className = "" }: { value: number; decimals?: number; duration?: number; className?: string }) {
  const [display, setDisplay] = useState(0);
  const raf = useRef(0);

  useEffect(() => {
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(value * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, duration]);

  return <span className={`font-mono tabular-nums ${className}`}>{display.toFixed(decimals)}</span>;
}

export function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = value >= 0.8 ? "bg-arena-green" : value >= 0.62 ? "bg-gold-500" : "bg-arena-red";
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs">
        <span className="text-white/50">Scan confidence</span>
        <span className="font-mono text-white/80">{pct}%</span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${color} transition-all duration-700`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function QualityBar({ label, value, display }: { label: string; value: number; display?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = pct >= 75 ? "bg-arena-green" : pct >= 45 ? "bg-gold-500" : "bg-arena-red";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px]">
        <span className="text-white/45">{label}</span>
        <span className="font-mono text-white/70">{display ?? `${pct}%`}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/10">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 text-white/60">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-gold-500" />
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function Modal({ open, onClose, children, title }: { open: boolean; onClose: () => void; children: React.ReactNode; title?: string }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="panel max-h-[85vh] w-full max-w-lg overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        {title && <h3 className="mb-4 text-lg font-bold">{title}</h3>}
        {children}
      </div>
    </div>
  );
}
