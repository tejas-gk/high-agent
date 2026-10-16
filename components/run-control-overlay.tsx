"use client";

import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import type { JobView } from "@/src/types";

export function RunControlOverlay() {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [busy, setBusy] = useState<"pause" | "resume" | null>(null);
  const [error, setError] = useState("");

  const active = useMemo(
    () =>
      jobs.find((job) =>
        ["queued", "running", "paused", "waiting_for_human"].includes(job.status),
      ) ?? null,
    [jobs],
  );

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      try {
        const response = await fetch("/api/jobs", { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as JobView[];
        if (!cancelled) setJobs(data);
      } catch {
        // The main run UI already surfaces request errors. Keep this overlay quiet
        // on transient polling failures.
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function action(kind: "pause" | "resume") {
    if (!active) return;
    setBusy(kind);
    setError("");

    try {
      const response = await fetch(
        `/api/jobs/${active.id}/${kind}`,
        { method: "POST" },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error || `Could not ${kind} run`);
      }

      setJobs((current) =>
        current.map((job) => (job.id === data.id ? data : job)),
      );
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setBusy(null);
    }
  }

  if (!active || active.status === "queued" || active.status === "waiting_for_human") {
    return null;
  }

  return (
    <div className="fixed bottom-5 right-5 z-[100] w-[320px] rounded-xl border bg-white/95 p-4 shadow-xl backdrop-blur">
      <div className="mb-3">
        <div className="text-sm font-semibold">Agent controls</div>
        <div className="mt-1 text-xs text-slate-500">
          {active.status === "paused"
            ? "Browser is paused. Navigate Tangerine manually if needed, then resume from the page currently open."
            : "Pause at the next safe checkpoint without closing the Playwright browser."}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          disabled={active.status !== "running" || busy !== null}
          onClick={() => void action("pause")}
        >
          {busy === "pause" ? "Pausing..." : "Pause agent"}
        </Button>

        <Button
          disabled={active.status !== "paused" || busy !== null}
          onClick={() => void action("resume")}
        >
          {busy === "resume" ? "Re-observing..." : "Resume current page"}
        </Button>
      </div>

      {error && <div className="mt-2 text-xs text-red-600">{error}</div>}
    </div>
  );
}
