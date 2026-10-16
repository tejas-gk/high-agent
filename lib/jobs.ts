import { randomUUID } from "node:crypto";

import { normalisePayload } from "@/src/payload";
import { runAgent } from "@/src/runner";
import type { HumanRequest, JobView, TraceEvent } from "@/src/types";

type Internal = JobView;
type PendingHumanInput = {
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RunControl = {
  paused: boolean;
  resumeGeneration: number;
  observedGeneration: number;
  waiters: Array<() => void>;
};

const globalJobs = globalThis as typeof globalThis & {
  __nbnJobs?: Map<string, Internal>;
  __nbnHumanInputs?: Map<string, PendingHumanInput>;
  __nbnRunControls?: Map<string, RunControl>;
};

const jobs = globalJobs.__nbnJobs ?? (globalJobs.__nbnJobs = new Map());
const humanInputs =
  globalJobs.__nbnHumanInputs ??
  (globalJobs.__nbnHumanInputs = new Map<string, PendingHumanInput>());

const runControls =
  globalJobs.__nbnRunControls ??
  (globalJobs.__nbnRunControls = new Map<string, RunControl>());

export function getJob(id: string) {
  return jobs.get(id);
}

export function listJobs() {
  return [...jobs.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20);
}

export function submitHumanInput(id: string, value: string) {
  const job = jobs.get(id);
  const pending = humanInputs.get(id);

  if (!job || !pending || job.status !== "waiting_for_human") {
    throw new Error("This job is not waiting for human input");
  }

  const clean = value.trim();
  if (!clean) {
    throw new Error("Human input cannot be empty");
  }

  clearTimeout(pending.timer);
  humanInputs.delete(id);
  job.humanRequest = undefined;
  job.status = "running";
  job.updatedAt = new Date().toISOString();
  pending.resolve(clean);

  return job;
}

export function pauseJob(id: string) {
  const job = jobs.get(id);
  const control = runControls.get(id);

  if (!job || !control) {
    throw new Error("Job not found");
  }
  if (job.status !== "running") {
    throw new Error("Only a running job can be paused");
  }

  control.paused = true;
  job.status = "paused";
  job.updatedAt = new Date().toISOString();
  return job;
}

export function resumeJob(id: string) {
  const job = jobs.get(id);
  const control = runControls.get(id);

  if (!job || !control) {
    throw new Error("Job not found");
  }
  if (job.status !== "paused") {
    throw new Error("This job is not paused");
  }

  control.paused = false;
  control.resumeGeneration += 1;
  job.status = "running";
  job.updatedAt = new Date().toISOString();

  const waiters = control.waiters.splice(0);
  for (const wake of waiters) wake();

  return job;
}

export function startJob(raw: unknown, mutate: boolean) {
  if (
    [...jobs.values()].some(
      (job) =>
        job.status === "queued" ||
        job.status === "running" ||
        job.status === "paused" ||
        job.status === "waiting_for_human",
    )
  ) {
    throw new Error("The test portal is limited to one active run at a time");
  }

  const payload = normalisePayload(raw);

  if (new URL(payload.portal.url).hostname !== "test-tangerine.hipeely.com") {
    throw new Error("Only the provided Tangerine test portal is allowed");
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const job: Internal = {
    id,
    status: "queued",
    createdAt: now,
    updatedAt: now,
    trace: [],
  };

  jobs.set(id, job);
  runControls.set(id, {
    paused: false,
    resumeGeneration: 0,
    observedGeneration: 0,
    waiters: [],
  });

  void (async () => {
    job.status = "running";
    job.updatedAt = new Date().toISOString();

    try {
      job.report = await runAgent({
        jobId: id,
        payload,
        mutate,
        emit: (event: TraceEvent) => {
          job.trace = [...job.trace, event].slice(-250);
          job.updatedAt = new Date().toISOString();
        },
        checkpoint: async () => {
          const control = runControls.get(id);
          if (!control) return "normal" as const;

          if (control.paused) {
            await new Promise<void>((resolve) => {
              control.waiters.push(resolve);
            });
          }

          if (control.observedGeneration < control.resumeGeneration) {
            control.observedGeneration = control.resumeGeneration;
            return "resumed" as const;
          }

          return "normal" as const;
        },
        requestHumanInput: (request) =>
          new Promise<string>((resolve, reject) => {
            const humanRequest: HumanRequest = {
              ...request,
              requestedAt: new Date().toISOString(),
            };

            job.humanRequest = humanRequest;
            job.status = "waiting_for_human";
            job.updatedAt = new Date().toISOString();

            const timer = setTimeout(() => {
              humanInputs.delete(id);
              job.humanRequest = undefined;
              reject(new Error("Human handoff timed out after 20 minutes"));
            }, 20 * 60 * 1000);

            humanInputs.set(id, { resolve, reject, timer });
          }),
      });
      job.status = job.report.status;
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      const pending = humanInputs.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        humanInputs.delete(id);
      }
      job.humanRequest = undefined;
      const control = runControls.get(id);
      if (control) {
        const waiters = control.waiters.splice(0);
        for (const wake of waiters) wake();
      }
      runControls.delete(id);
      job.updatedAt = new Date().toISOString();
    }
  })();

  return job;
}
