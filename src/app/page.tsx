import Link from "next/link";
import { PSL_MODEL_VERSION } from "@/lib/psl/version";

const TRUST = [
  ["🛡", "Liveness-verified", "Randomized challenge sequence defeats photos, clips and replays"],
  ["📐", "Deterministic scoring", "Pinned geometric model — same face, same conditions, same number"],
  ["🔒", "On-device analysis", "No face image ever uploaded; only score components are stored"],
  ["⚖️", "Honest Elo", "Rematch cooldowns, pair caps, suspicion flags that halve gains"],
];

const STEPS = [
  ["01", "Verify", "Consent, camera, then a guided liveness scan: straight, left, right, blink, neutral."],
  ["02", "Score", "The pinned PSL-2026.1 model measures 13 geometric components and certifies your /10."],
  ["03", "Battle", "Randomized P2P matchmaking. Live countdown. Both faces scored. Higher number mogs."],
  ["04", "Climb", "Elo updates against opponent rating. Global, weekly, seasonal and regional boards."],
];

export default function Home() {
  return (
    <div className="space-y-20 py-14">
      {/* hero */}
      <section className="relative text-center">
        <div className="bg-grid pointer-events-none absolute inset-0 -z-10 rounded-3xl opacity-60" />
        <div className="mx-auto max-w-3xl space-y-6">
          <span className="chip mx-auto">
            <span className="h-1.5 w-1.5 rounded-full bg-arena-green" /> scoring model {PSL_MODEL_VERSION} · liveness v2 · anti-farm active
          </span>
          <h1 className="text-5xl font-black leading-[1.05] tracking-tight sm:text-7xl">
            CERTIFIED FACE GEOMETRY.
            <br />
            <span className="text-gradient-gold">RANKED MOG BATTLES.</span>
          </h1>
          <p className="mx-auto max-w-xl text-lg text-white/55">
            Mogbattle scores your face with a transparent, reproducible landmark pipeline — then matches you live
            against verified players in peer-to-peer duels. No black-box guesses. No fabricated precision.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link href="/play" className="btn-gold px-8 text-lg">
              Enter the Arena
            </Link>
            <Link href="/methodology" className="btn-ghost">
              Read the methodology
            </Link>
          </div>
          <div className="mx-auto mt-6 inline-flex items-center gap-3 rounded-2xl border border-gold-500/20 bg-gold-500/[0.06] px-5 py-3">
            <span className="font-mono text-3xl font-black text-gradient-gold">7.42</span>
            <span className="text-left text-xs text-white/50">
              example PSL /10 — deterministic components,
              <br /> confidence + quality shown with every score
            </span>
          </div>
        </div>
      </section>

      {/* trust grid */}
      <section>
        <h2 className="mb-4 text-center text-sm font-bold uppercase tracking-[0.25em] text-white/40">Built on trust</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TRUST.map(([icon, title, desc]) => (
            <div key={title} className="panel panel-hover p-5">
              <div className="text-2xl">{icon}</div>
              <div className="mt-2 font-bold">{title}</div>
              <div className="mt-1 text-sm text-white/50">{desc}</div>
            </div>
          ))}
        </div>
      </section>

      {/* steps */}
      <section className="panel relative overflow-hidden p-8">
        <div className="bg-grid absolute inset-0 opacity-30" />
        <div className="relative grid gap-8 md:grid-cols-4">
          {STEPS.map(([n, title, desc]) => (
            <div key={n}>
              <div className="font-mono text-sm font-bold text-gold-500">{n}</div>
              <div className="mt-1 text-lg font-bold">{title}</div>
              <p className="mt-1 text-sm text-white/50">{desc}</p>
            </div>
          ))}
        </div>
        <div className="relative mt-8 flex justify-center">
          <Link href="/play" className="btn-gold">Start verification →</Link>
        </div>
      </section>

      {/* honesty statement */}
      <section className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-center">
        <p className="text-sm leading-relaxed text-white/50">
          <span className="font-semibold text-white/80">Plain talk:</span> PSL is a facial-analysis score produced
          by this platform&apos;s geometric pipeline against stylized classical canons. It is reproducible and
          auditable — but it is <span className="text-white/80">not</span> a scientific universal and says nothing
          about human worth. If a capture can&apos;t be measured honestly, we ask for a rescan instead of inventing a
          number.
        </p>
      </section>
    </div>
  );
}
