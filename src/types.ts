export type RunStatus =
  | "queued"
  | "running"
  | "waiting_for_human"
  | "success"
  | "failed"
  | "escalated";

export type HumanRequestType = "EMAIL_OTP" | "CAPTCHA" | "THREE_DS";

export type HumanRequest = {
  type: HumanRequestType;
  step: number;
  message: string;
  requestedAt: string;
};

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

export type CompletedStep = {
  step: number;
  name: string;
  description: string;
  completedAt?: string;
};

export const STEP_DESCRIPTIONS: Record<number, Omit<CompletedStep, "step">> = {
  1: { name: "Open portal", description: "Opened and verified the approved Tangerine test portal." },
  2: { name: "Enter service address", description: "Entered the requested NBN service address into address search." },
  3: { name: "Confirm address", description: "Selected or manually confirmed the service address and received an address result." },
  4: { name: "Reach plan builder", description: "Cleared address-result UI and reached the NBN plan selection state." },
  5: { name: "Select NBN plan", description: "Selected the payload-requested NBN plan and verified it in the cart." },
  6: { name: "Clear plan dialogs", description: "Handled non-sensitive speed/equipment dialogs blocking progression." },
  7: { name: "Select router", description: "Selected the payload-requested router/BYO option." },
  8: { name: "Verify order cart", description: "Verified the configured order/cart before checkout." },
  9: { name: "Enter checkout", description: "Submitted Order Now and reached the checkout journey." },
  10: { name: "Cart integrity guard", description: "Verified checkout was not a modem-only or missing-plan order." },
  11: { name: "Email verification", description: "Submitted checkout email and completed guarded CAPTCHA/OTP handoff when required." },
  12: { name: "Contact details", description: "Filled customer contact details from the payload and verified progression." },
  13: { name: "Service and delivery", description: "Completed service/delivery address details and verified progression." },
  14: { name: "Connection details", description: "Completed activation/transfer/provider/date choices from the payload." },
  15: { name: "Donation", description: "Declined the optional donation and verified the donation page was left." },
  16: { name: "Payment details", description: "Filled payment details through the isolated deterministic payment executor and submitted Pay Now." },
  17: { name: "Payment confirmation", description: "Completed the guarded payment confirmation modal." },
  18: { name: "3-D Secure", description: "Completed the approved test 3-D Secure flow." },
  19: { name: "Transaction confirmed", description: "Observed and validated a non-empty transaction/order identifier." },
};

export function describeCompletedSteps(steps: number[]): CompletedStep[] {
  return steps.map((step) => ({ step, ...(STEP_DESCRIPTIONS[step] ?? { name: `Step ${step}`, description: "Completed and verified." }) }));
}

export type RunReport = {
  jobId: string;
  status: "success" | "failed" | "escalated";
  transactionId?: string;
  completedSteps: number[];
  completedStepDetails?: CompletedStep[];
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
  humanRequest?: HumanRequest;
  report?: RunReport;
  error?: string;
};
