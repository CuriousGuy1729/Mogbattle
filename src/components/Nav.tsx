"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ensureSession, type MyPlayer } from "@/lib/client/session";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/play", label: "Arena" },
  { href: "/leaderboard", label: "Leaderboards" },
  { href: "/lab", label: "Calibration Lab" },
  { href: "/methodology", label: "Methodology" },
  { href: "/profile", label: "Profile" },
];

export default function Nav() {
  const pathname = usePathname();
  const [me, setMe] = useState<MyPlayer | null>(null);

  useEffect(() => {
    ensureSession()
      .then((s) => setMe(s.player))
      .catch(() => {});
  }, [pathname]);

  return (
    <header className="sticky top-0 z-40 border-b border-white/5 bg-ink-950/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-4">
        <Link href="/" className="group flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-b from-gold-400 to-gold-600 text-lg font-black text-ink-950 shadow-glow">
            M
          </span>
          <span className="text-lg font-black tracking-wide">
            MOG<span className="text-gradient-gold">BATTLE</span>
          </span>
        </Link>
        <nav className="hidden items-center gap-1 md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition ${
                pathname === l.href ? "bg-white/[0.06] text-gold-400" : "text-white/60 hover:bg-white/[0.04] hover:text-white"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          {me && (
            <Link href="/profile" className="chip hover:border-gold-500/40">
              <span className="h-1.5 w-1.5 rounded-full bg-arena-green" />
              <span className="max-w-[90px] truncate">{me.handle}</span>
              {me.psl != null && <span className="font-mono text-gold-400">{me.psl.toFixed(2)}</span>}
            </Link>
          )}
          <Link href="/play" className="btn-gold hidden !px-4 !py-2 text-sm sm:inline-flex">
            Enter Arena
          </Link>
        </div>
      </div>
      <nav className="flex justify-around border-t border-white/5 py-1 md:hidden">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`rounded px-2 py-1.5 text-[11px] font-medium ${pathname === l.href ? "text-gold-400" : "text-white/50"}`}
          >
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
