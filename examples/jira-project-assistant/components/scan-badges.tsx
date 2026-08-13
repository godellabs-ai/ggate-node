"use client";

import { useState } from "react";
import { ChevronDown, ShieldAlert, ShieldCheck } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ScanRecord {
  surface: string;
  label: string;
  verdict: string;
  detection?: { source: string; detail: string };
  failOpen: boolean;
}

const VERDICT_STYLE: Record<string, string> = {
  pass: "text-emerald-700 bg-emerald-50 border-emerald-300 dark:text-emerald-300 dark:bg-emerald-950/40 dark:border-emerald-900",
  warn: "text-amber-700 bg-amber-50 border-amber-300 dark:text-amber-300 dark:bg-amber-950/40 dark:border-amber-900",
  block: "text-red-700 bg-red-50 border-red-300 dark:text-red-300 dark:bg-red-950/40 dark:border-red-900",
  hard_block: "text-rose-700 bg-rose-50 border-rose-300 ring-1 ring-rose-300 dark:text-rose-300 dark:bg-rose-950/40 dark:border-rose-900",
};

const DOT_STYLE: Record<string, string> = {
  pass: "bg-emerald-500",
  warn: "bg-amber-500",
  block: "bg-red-500",
  hard_block: "bg-rose-500",
};

export function VerdictPill({ verdict, label }: { verdict: string; label?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide",
        VERDICT_STYLE[verdict] ?? VERDICT_STYLE.pass,
      )}
    >
      <span className={cn("size-1.5 rounded-full", DOT_STYLE[verdict] ?? DOT_STYLE.pass)} />
      {label ?? verdict.replace("_", " ")}
    </span>
  );
}

/** Collapsible per-message trail of everything Godel's Gate scanned. */
export function ScanTrail({ scans }: { scans: ScanRecord[] }) {
  const [open, setOpen] = useState(false);
  if (!scans.length) return null;
  const worst = scans.some((s) => s.verdict === "block" || s.verdict === "hard_block")
    ? "block"
    : scans.some((s) => s.verdict === "warn")
      ? "warn"
      : "pass";

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-muted-foreground transition-colors hover:text-foreground"
      >
        {worst === "pass" ? (
          <ShieldCheck className="size-3.5 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <ShieldAlert className={cn("size-3.5", worst === "warn" ? "text-amber-500" : "text-red-500")} />
        )}
        {scans.length} scan{scans.length === 1 ? "" : "s"} · {worst === "pass" ? "all passed" : worst}
        <ChevronDown className={cn("size-3 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <ul className="mt-2 space-y-1 rounded-lg border border-border bg-muted/40 p-2.5">
          {scans.map((scan, index) => (
            <li key={index} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate font-medium text-muted-foreground">
                <span className="font-mono text-[11px] uppercase">{scan.surface.replace("_", " ")}</span>
                {" · "}
                {scan.label}
                {scan.detection ? ` — ${scan.detection.detail}` : ""}
              </span>
              <VerdictPill verdict={scan.verdict} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
