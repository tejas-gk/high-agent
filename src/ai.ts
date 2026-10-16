import type { Candidate, Observation } from "./observe";

export type AiChoice = {
  candidateId: number;
  confidence: number;
  reason: string;
};

function aiConfig() {
  const key = process.env.AI_API_KEY?.trim();
  const configuredUrl = process.env.AI_API_URL?.trim();
  const configuredModel = process.env.AI_MODEL?.trim();
  if (!key) return null;

  const model = !configuredModel || configuredModel === "sarvam-m" ? "sarvam-105b" : configuredModel;
  let url = configuredUrl || "https://api.sarvam.ai/v1/chat/completions";

  // Sarvam's V2 route is beta/whitelisted. For the flagship model use the
  // generally available V1 route so a normal subscription key works.
  if (/api\.sarvam\.ai\/v2\/chat\/completions/i.test(url) && model === "sarvam-105b") {
    url = url.replace(/\/v2\/chat\/completions/i, "/v1/chat/completions");
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  };
  if (/api\.sarvam\.ai/i.test(url)) headers["api-subscription-key"] = key;
  return { key, url, model, headers };
}

// ---- Token-minimal serialization -------------------------------------------
// Full JSON.stringify of 24-40 candidates (~150 chars each) costs ~1k tokens
// per call. Compact one-line form keeps the same signal at ~1/3 the cost and
// drops empty attributes entirely.
function compactCandidate(c: Candidate): string {
  const parts: string[] = [`${c.id}${c.tag[0] ?? "?"}`];
  const label = c.text || c.label || c.name || c.placeholder;
  if (label) parts.push(`"${label.slice(0, 50)}"`);
  const extra: string[] = [];
  if (c.tag === "input" || c.tag === "select" || c.tag === "textarea") {
    if (c.label && c.label !== label) extra.push(`lbl:${c.label.slice(0, 30)}`);
    if (c.placeholder && c.placeholder !== label) extra.push(`ph:${c.placeholder.slice(0, 30)}`);
    if (c.name && c.name !== label) extra.push(`nm:${c.name.slice(0, 30)}`);
    if (c.type) extra.push(c.type);
    if (c.value) extra.push(`=${c.value.slice(0, 30)}`);
    if (c.checked) extra.push("checked");
  } else {
    if (c.type) extra.push(c.type);
  }
  if (c.disabled) extra.push("DISABLED");
  if (extra.length) parts.push(`[${extra.join(" ")}]`);
  return parts.join(" ");
}

function compactCandidates(candidates: Candidate[]): string {
  return candidates.map(compactCandidate).join(" | ");
}

function pageContext(o: Observation, maxBody = 500): string {
  const bits: string[] = [];
  if (o.title) bits.push(`T:${o.title.slice(0, 80)}`);
  if (o.headings.length) bits.push(`H:${o.headings.slice(0, 5).join(" / ").slice(0, 200)}`);
  if (o.bodyText) bits.push(`B:${o.bodyText.slice(0, maxBody)}`);
  return bits.join(" ");
}

// Tiny in-memory cache: identical (goal + page signature + candidates) reuses
// the last answer instead of spending another request/tokens. Retrying a
// stuck step otherwise re-asks the model every 500ms with the same DOM.
const cache = new Map<string, string>();
function cacheKey(kind: string, goal: string, o: Observation, candidates: Candidate[]): string {
  return `${kind}|${goal.slice(0, 120)}|${o.url}|${o.headings.join("|").slice(0, 160)}|${o.bodyText.slice(0, 300)}|${candidates.map((c) => `${c.id}:${c.text}|${c.label}|${c.name}|${c.placeholder}|${c.type}`).join(";").slice(0, 1200)}`;
}

async function chatJson(messages: Array<{ role: "system" | "user"; content: string }>, cacheHitKey?: string) {
  const config = aiConfig();
  if (!config) return null;
  if (cacheHitKey && cache.has(cacheHitKey)) return cache.get(cacheHitKey)!;
  const response = await fetch(config.url, {
    method: "POST",
    headers: config.headers,
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
    }),
  });
  if (!response.ok) {
    const safe = (await response.text().catch(() => ""))
      .replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]")
      .slice(0, 300);
    throw new Error(`AI grounding failed (${response.status})${safe ? `: ${safe}` : ""}`);
  }
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content ?? null;
  if (content && cacheHitKey) {
    if (cache.size > 50) cache.clear();
    cache.set(cacheHitKey, content);
  }
  return content;
}

export async function chooseCandidate(args: {
  intent: string;
  observation: Observation;
  candidates: Candidate[];
}): Promise<AiChoice | null> {
  // Skip disabled controls — clicking them never advances and wastes a call.
  const usable = args.candidates.filter((c) => !c.disabled).slice(0, 20);
  if (!usable.length) return null;
  const key = cacheKey("pick", args.intent, args.observation, usable);
  const content = await chatJson(
    [
      { role: "system", content: "Pick one visible browser control by id. JSON only." },
      {
        role: "user",
        content: [
          `Goal:${args.intent.slice(0, 200)}`,
          `Page:${pageContext(args.observation)}`,
          `C:${compactCandidates(usable)}`,
          `Note:"Proceed" means Next/Continue (renamed by layout). Never pay/OTP/captcha/donate/consent.`,
          `JSON:{"candidateId":n,"confidence":0..1,"reason":"<8 words"}`,
        ].join(" "),
      },
    ],
    key,
  );
  if (!content) return null;
  let parsed: AiChoice;
  try {
    parsed = JSON.parse(content) as AiChoice;
  } catch {
    return null;
  }
  if (!Number.isInteger(parsed.candidateId) || parsed.confidence < 0 || parsed.confidence > 1) return null;
  if (!usable.some((c) => c.id === parsed.candidateId)) return null;
  return parsed;
}

export type PayloadFieldKey =
  | "customer.title"
  | "customer.firstName"
  | "customer.lastName"
  | "customer.email"
  | "customer.phone"
  | "customer.dateOfBirth"
  | "address.fullAddress"
  | "address.streetNumber"
  | "address.streetName"
  | "address.streetType"
  | "address.suburb"
  | "address.state"
  | "address.postcode"
  | "address.unitNumber"
  | "connection.currentProvider"
  | "connection.avcId"
  | "connection.moveInDate"
  | "connection.deliveryDate"
  | "connection.activation"
  | "policy.unsure"
  | "policy.otherProvider";

export type AiFormPlan = {
  assignments: Array<{ candidateId: number; valueKey: PayloadFieldKey }>;
  actionCandidateId?: number;
  confidence: number;
  reason: string;
};

const ALLOWED_KEYS: PayloadFieldKey[] = [
  "customer.title", "customer.firstName", "customer.lastName", "customer.email",
  "customer.phone", "customer.dateOfBirth", "address.fullAddress", "address.streetNumber",
  "address.streetName", "address.streetType", "address.suburb", "address.state",
  "address.postcode", "address.unitNumber", "connection.currentProvider",
  "connection.avcId", "connection.moveInDate", "connection.deliveryDate",
  "connection.activation", "policy.unsure", "policy.otherProvider",
];

// Single-call form planner: maps fields AND picks the follow-up nav action in
// one request (previously up to 2 calls per recovery attempt). Inputs already
// holding a value are marked `=...` so the model skips re-filling them.
export async function planPayloadForm(args: {
  goal: string;
  observation: Observation;
  candidates: Candidate[];
}): Promise<AiFormPlan | null> {
  const usable = args.candidates.filter((c) => !c.disabled).slice(0, 30);
  if (!usable.length) return null;
  const key = cacheKey("form", args.goal, args.observation, usable);
  const content = await chatJson(
    [
      {
        role: "system",
        content: "Map form fields to allowed keys + one nav button. JSON only. Never invent values.",
      },
      {
        role: "user",
        content: [
          `Goal:${args.goal.slice(0, 200)}`,
          `Page:${pageContext(args.observation)}`,
          `Keys:${ALLOWED_KEYS.join(",")}`,
          `C:${compactCandidates(usable)}`,
          `Rules: map confident fields only; skip filled (=value) unless wrong; one nav Next/Continue/Proceed after fill; never Pay/OTP/captcha/donate/consent.`,
          `JSON:{"assignments":[{"candidateId":1,"valueKey":"customer.firstName"}],"actionCandidateId":10,"confidence":0.0,"reason":"<8 words"}`,
        ].join(" "),
      },
    ],
    key,
  );
  if (!content) return null;
  let parsed: AiFormPlan;
  try {
    parsed = JSON.parse(content) as AiFormPlan;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed.assignments) || typeof parsed.confidence !== "number") return null;
  const allowed = new Set<string>(ALLOWED_KEYS);
  const validIds = new Set(usable.map((c) => c.id));
  parsed.assignments = parsed.assignments.filter(
    (x) => Number.isInteger(x?.candidateId) && validIds.has(x.candidateId) && allowed.has(x.valueKey),
  );
  if (parsed.actionCandidateId !== undefined && !validIds.has(parsed.actionCandidateId)) {
    parsed.actionCandidateId = undefined;
  }
  return parsed;
}
