export type RunStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "escalated";
export type TraceEvent = {
  at: string;
  level: "info" | "warn" | "error";
  step?: number;
  message: string;
  data?: Record<string, unknown>;
};
export type HealEvent = {
  step: number;
  level: "L0" | "L1" | "L2" | "L3";
  intent: string;
  reason: string;
  oldLocator?: string;
  newLocator?: string;
  confidence?: number;
  evidence: string;
  verified: boolean;
};
export type RunReport = {
  jobId: string;
  status: "success" | "failed" | "escalated";
  transactionId?: string;
  completedSteps: number[];
  heals: HealEvent[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  modelCalls: number;
  failureReason?: string;
  evidenceDir: string;
};
export type JobView = {
  id: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  trace: TraceEvent[];
  report?: RunReport;
  error?: string;
};
