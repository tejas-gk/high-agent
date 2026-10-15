import { randomUUID } from "node:crypto";

import { normalisePayload } from "@/src/payload";
import { runAgent } from "@/src/runner";
import type { JobView, TraceEvent } from "@/src/types";

type Internal = JobView;

const globalJobs = globalThis as typeof globalThis & {
  __nbnJobs?: Map<string, Internal>;
};

const jobs = globalJobs.__nbnJobs ?? (globalJobs.__nbnJobs = new Map());

export function getJob(id: string) {
  return jobs.get(id);
}

export function listJobs() {
  return [...jobs.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 20);
}

export function startJob(raw: unknown, mutate: boolean) {
  if (
    [...jobs.values()].some(
      (job) => job.status === "queued" || job.status === "running",
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
      });
      job.status = job.report.status;
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      job.updatedAt = new Date().toISOString();
    }
  })();

  return job;
}
