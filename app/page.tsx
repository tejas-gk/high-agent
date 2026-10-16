"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleAlert,
  KeyRound,
  Play,
  RefreshCw,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { JobView } from "@/src/types";

const SAMPLE = {
  portal: { url: "https://test-tangerine.hipeely.com/nbn/nbn-broadband#speeds" },
  customer: {
    title: "Mr",
    firstName: "Sam",
    lastName: "Test",
    email: "prime150@yopmail.com",
    phone: "0412345678",
    dateOfBirth: "01/02/1988",
  },
  connectionAddress: {
    mainAddress: {
      fullAddress: "17 Rochester Way, MEADOW SPRINGS WA 6210",
      streetNumber: "17",
      streetName: "Rochester",
      streetType: "Way",
      suburb: "MEADOW SPRINGS",
      state: "WA",
      postcode: "6210",
      unitNumber: "",
      country: "Australia",
    },
  },
  plan: { name: "VALUE PLUS", speed: "25 Mbps" },
  addOns: { router: { enabled: true, model: "BYO Modem" } },
  connectionDetails: {
    currentProvider: "Exetel",
    avcId: "",
    moveInDate: "",
    movingProperty: false,
  },
  connectionDeliveryDate: "ASAP",
  payment: {
    method: "Credit Card",
    cardRef: "vault://test-cards/visa-success",
    nameOnCard: "Sam Test",
  },
};

export default function Home() {
  const [raw, setRaw] = useState(JSON.stringify(SAMPLE, null, 2));
  const [mutate, setMutate] = useState(false);
  const [job, setJob] = useState<JobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [humanValue, setHumanValue] = useState("");
  const [resuming, setResuming] = useState(false);

  useEffect(() => {
    if (!job || !["queued", "running", "waiting_for_human"].includes(job.status)) return;

    const timer = setInterval(async () => {
      const response = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
      if (response.ok) setJob(await response.json());
    }, 1200);

    return () => clearInterval(timer);
  }, [job]);

  const status = job?.status ?? "idle";
  const previewUrl = job ? `/api/jobs/${job.id}/preview?ts=${Date.now()}` : "";
  const progress = useMemo(() => {
    if (!job) return 0;
    return (
      job.report?.completedSteps.length ??
      Math.min(19, new Set(job.trace.map((entry) => entry.step).filter(Boolean)).size)
    );
  }, [job]);

  async function run() {
    setBusy(true);
    setError("");
    setHumanValue("");

    try {
      const payload = JSON.parse(raw);
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload, mutate }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Run failed");
      setJob(data);
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setBusy(false);
    }
  }

  async function resume() {
    if (!job || !humanValue.trim()) return;
    setResuming(true);
    setError("");

    try {
      const response = await fetch(`/api/jobs/${job.id}/human`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: humanValue }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not resume run");
      setHumanValue("");
      setJob(data);
    } catch (event) {
      setError(event instanceof Error ? event.message : String(event));
    } finally {
      setResuming(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-7xl p-6 lg:p-10">
        <div className="mb-8">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium text-blue-600">
            <Bot className="h-4 w-4" /> CIMET hands-on technical round
          </div>
        </div>

        <div className="grid gap-6 lg:grid-cols-[1.05fr_.95fr]">
          <Card>
            <CardHeader>
              <CardTitle>Run configuration</CardTitle>
              <CardDescription>
                Only the supplied Tangerine test portal is accepted. The payload contains cardRef, never PAN/CVV.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
                className="min-h-[520px] text-xs"
              />

              <label className="flex items-start gap-3 rounded-lg border bg-slate-50 p-4">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={mutate}
                  onChange={(event) => setMutate(event.target.checked)}
                />
                <span>
                  <span className="block text-sm font-medium">Mutation demonstration</span>
                  <span className="text-xs text-muted-foreground">
                    Rewrites a safe non-payment control only inside this Playwright browser session to prove self-healing. The upstream website is never modified.
                  </span>
                </span>
              </label>

              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>
              )}

              <Button
                onClick={run}
                disabled={busy || ["running", "queued", "waiting_for_human"].includes(status)}
                className="w-full"
              >
                <Play className="h-4 w-4" />
                {busy ? "Starting…" : mutate ? "Run mutated journey" : "Run clean journey"}
              </Button>
            </CardContent>
          </Card>

          <div className="space-y-6">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle>Live run</CardTitle>
                    <CardDescription>{job ? job.id : "No active job"}</CardDescription>
                  </div>
                  <StatusBadge status={status} />
                </div>
              </CardHeader>
              <CardContent>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span>Journey progress</span>
                  <span className="font-medium">{progress}/19</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className="h-full bg-blue-600 transition-all"
                    style={{ width: `${Math.round((progress / 19) * 100)}%` }}
                  />
                </div>

                {job?.report && (
                  <div className="mt-5 grid grid-cols-3 gap-3">
                    <Metric label="Heals" value={String(job.report.heals.length)} />
                    <Metric label="Model calls" value={String(job.report.modelCalls)} />
                    <Metric label="Duration" value={`${Math.round(job.report.durationMs / 1000)}s`} />
                  </div>
                )}
              </CardContent>
            </Card>

            {job?.status === "waiting_for_human" && job.humanRequest && (
              <Card className="border-amber-300 bg-amber-50">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-amber-900">
                    <KeyRound className="h-5 w-5" /> Human action required
                  </CardTitle>
                  <CardDescription className="text-amber-800">
                    {job.humanRequest.message} The browser is paused in memory and will resume from this exact step.
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="text-xs font-medium uppercase tracking-wide text-amber-800">
                    {job.humanRequest.type} · Step {job.humanRequest.step}
                  </div>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={humanValue}
                    onChange={(event) => setHumanValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void resume();
                    }}
                    placeholder="Enter verification code"
                    className="w-full rounded-md border bg-white px-3 py-2 text-sm outline-none ring-offset-2 focus:ring-2 focus:ring-amber-500"
                  />
                  <Button onClick={resume} disabled={resuming || !humanValue.trim()} className="w-full">
                    {resuming ? "Resuming…" : "Submit & resume agent"}
                  </Button>
                  <p className="text-xs text-amber-800">
                    The code is sent directly to the deterministic browser runner. It is not sent to Sarvam and is not added to the agent trace.
                  </p>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle>Live portal preview</CardTitle>
                <CardDescription>Current page screenshot captured from the running browser session.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="overflow-hidden rounded-lg border bg-slate-100">
                  {job ? (
                    <img
                      key={job.id + status + String(progress)}
                      src={previewUrl}
                      alt="Live portal preview"
                      className="aspect-[4/3] w-full bg-white object-contain"
                    />
                  ) : (
                    <div className="flex aspect-[4/3] items-center justify-center bg-slate-100 text-sm text-slate-500">No preview yet</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5" /> Agent trace
                </CardTitle>
                <CardDescription>Redacted operational events. Payment secrets and human OTP values never enter this stream.</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="max-h-[390px] space-y-2 overflow-auto rounded-lg bg-slate-950 p-4 font-mono text-xs text-slate-200">
                  {!job?.trace.length ? (
                    <div className="text-slate-500">Waiting for a run…</div>
                  ) : (
                    job.trace.map((entry, index) => (
                      <div key={`${entry.at}-${index}`}>
                        <span className="text-slate-500">{entry.at.slice(11, 19)}</span>{" "}
                        <span className="text-blue-300">{entry.step ? `step:${entry.step}` : "system"}</span>{" "}
                        {entry.message}
                      </div>
                    ))
                  )}
                </div>
              </CardContent>
            </Card>

            {job?.report && (
              <Card>
                <CardHeader>
                  <CardTitle>Run report</CardTitle>
                  <CardDescription>Final evidence-backed outcome.</CardDescription>
                </CardHeader>
                <CardContent>
                  <pre className="max-h-72 overflow-auto rounded-lg bg-slate-950 p-4 text-xs text-slate-200">
                    {JSON.stringify(job.report, null, 2)}
                  </pre>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const good = status === "success";
  const waiting = status === "waiting_for_human";
  const bad = status === "failed" || status === "escalated";

  return (
    <Badge
      className={
        good
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : waiting
            ? "border-amber-300 bg-amber-100 text-amber-800"
            : bad
              ? "border-amber-200 bg-amber-50 text-amber-700"
              : "bg-white"
      }
    >
      {good ? (
        <CheckCircle2 className="mr-1 h-3 w-3" />
      ) : waiting || bad ? (
        <CircleAlert className="mr-1 h-3 w-3" />
      ) : (
        <RefreshCw className="mr-1 h-3 w-3" />
      )}
      {status}
    </Badge>
  );
}
