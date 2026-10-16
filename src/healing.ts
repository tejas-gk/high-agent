import type { Locator, Page } from "playwright";
import { chooseCandidate, planPayloadForm, type PayloadFieldKey } from "./ai";
import { observe } from "./observe";
import type { HealEvent } from "./types";
import type { JobPayload } from "./payload";

export async function semanticLocator(page: Page, args: { step: number; intent: string; names: string[]; guarded?: boolean; modelBudget: { used: number; max: number } }): Promise<{ locator: Locator; heal?: HealEvent }> {
  if (args.guarded) throw new Error("Guarded step cannot use free-form healing");
  for (const n of args.names) {
    const byText = page.locator("button, a, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: new RegExp(escapeRx(n), "i") });
    for (let index = 0; index < (await byText.count()); index += 1) {
      const candidate = byText.nth(index);
      if (await candidate.isVisible().catch(() => false)) return { locator: candidate, heal: { step: args.step, level: "L1", intent: args.intent, reason: "Recovered by visible action text", newLocator: `button|a text~${n}`, evidence: "Visible action text matched intent", verified: false } };
    }
    const visibleText = page.getByText(new RegExp(escapeRx(n), "i")).first();
    if (await visibleText.count()) return { locator: visibleText, heal: { step: args.step, level: "L1", intent: args.intent, reason: "Recovered by visible text", newLocator: `text~${n}`, evidence: "Visible text matched intent", verified: false } };
  }
  if (args.modelBudget.used >= args.modelBudget.max) throw new Error("Model-call budget exhausted");
  const o = await observe(page);
  const choice = await chooseCandidate({ intent: args.intent, observation: o, candidates: o.candidates });
  args.modelBudget.used++;
  if (!choice || choice.confidence < 0.7) throw new Error("No high-confidence semantic recovery");
  const c = o.candidates.find((x) => x.id === choice.candidateId);
  if (!c) throw new Error("AI selected unknown candidate");
  const interactive = page.locator("button:visible,a:visible,input:visible,select:visible,textarea:visible,[role=button]:visible,[role=radio]:visible,[role=checkbox]:visible").nth(choice.candidateId - 1);
  return { locator: interactive, heal: { step: args.step, level: "L2", intent: args.intent, reason: choice.reason, newLocator: `candidate:${choice.candidateId}`, confidence: choice.confidence, evidence: JSON.stringify(c), verified: false } };
}

export async function recoverUnexpectedPage(page: Page, args: { step: number; goal: string; expected?: string; payload: JobPayload; modelBudget: { used: number; max: number }; heals: HealEvent[] }): Promise<boolean> {
  if (args.expected && (await page.locator(args.expected).filter({ visible: true }).count())) return true;
  const observation = await observe(page);
  const pageText = `${observation.title} ${observation.headings.join(" ")} ${observation.bodyText}`;
  const captchaChallengeFrame = page.frames().some((frame) => /recaptcha.*(bframe|challenge)|hcaptcha.*(challenge|checkbox)/i.test(frame.url()));
  if (/verify you are human|i am not a robot|captcha challenge/i.test(pageText) || captchaChallengeFrame) throw new Error("HUMAN_REQUIRED:CAPTCHA");
  if (/one[- ]time|verification code|enter.*otp|email.*code/i.test(pageText)) throw new Error("HUMAN_REQUIRED:EMAIL_OTP");
  if (/card number|cvv|pay now|payment details/i.test(pageText)) throw new Error("Guarded payment state encountered during free-form recovery");
  if (args.modelBudget.used >= args.modelBudget.max) throw new Error("Model-call budget exhausted");

  const visibleInputs = observation.candidates.filter((candidate) => ["input", "select", "textarea"].includes(candidate.tag) && candidate.type !== "hidden");
  const safeActions = observation.candidates.filter((candidate) =>
    (candidate.tag === "button" || candidate.tag === "a" || candidate.role === "button") &&
    !/pay|purchase|submit order|place order|otp|verify code|captcha|donation|agree|consent/i.test(`${candidate.text} ${candidate.name} ${candidate.label}`)
  );

  const valueFor = (key: PayloadFieldKey): string => {
    const p = args.payload;
    const map: Record<PayloadFieldKey, string> = {
      "customer.title": p.customer.title,
      "customer.firstName": p.customer.firstName,
      "customer.lastName": p.customer.lastName,
      "customer.email": p.customer.email,
      "customer.phone": p.customer.phone,
      "customer.dateOfBirth": p.customer.dateOfBirth,
      "address.fullAddress": p.connectionAddress.mainAddress.fullAddress,
      "address.streetNumber": p.connectionAddress.mainAddress.streetNumber,
      "address.streetName": p.connectionAddress.mainAddress.streetName,
      "address.streetType": p.connectionAddress.mainAddress.streetType,
      "address.suburb": p.connectionAddress.mainAddress.suburb,
      "address.state": p.connectionAddress.mainAddress.state,
      "address.postcode": p.connectionAddress.mainAddress.postcode,
      "address.unitNumber": p.connectionAddress.mainAddress.unitNumber,
      "connection.currentProvider": p.connectionDetails.currentProvider,
      "connection.avcId": p.connectionDetails.avcId,
      "connection.moveInDate": p.connectionDetails.moveInDate,
      "connection.deliveryDate": p.connectionDeliveryDate,
      "connection.activation": p.connectionDetails.moveInDate ? "New" : "Transfer",
      "policy.unsure": "Unsure",
      "policy.otherProvider": "Other",
    };
    return map[key] ?? "";
  };

  if (visibleInputs.length) {
    const plan = await planPayloadForm({ goal: args.goal, observation, candidates: [...visibleInputs, ...safeActions] });
    args.modelBudget.used++;
    if (plan && plan.confidence >= 0.72) {
      for (const assignment of plan.assignments) {
        const value = valueFor(assignment.valueKey);
        if (!value) continue;
        const candidate = observation.candidates.find((x) => x.id === assignment.candidateId);
        if (!candidate || !["input","select","textarea"].includes(candidate.tag)) continue;
        const control = page.locator("button:visible,a:visible,input:visible,select:visible,textarea:visible,[role=button]:visible,[role=radio]:visible,[role=checkbox]:visible").nth(candidate.id - 1);
        if (candidate.tag === "select") {
          const options = await control.locator("option").allTextContents().catch(() => []);
          const exact = options.find((x) => x.trim().toLowerCase() === value.trim().toLowerCase());
          const partial = exact ?? options.find((x) => x.toLowerCase().includes(value.toLowerCase()));
          if (partial) await control.selectOption({ label: partial }).catch(() => undefined);
        } else if (/radio|checkbox/i.test(candidate.type) || candidate.role === "radio" || candidate.role === "checkbox") {
          await control.check({ force: true }).catch(() => undefined);
        } else {
          await control.fill(value).catch(() => undefined);
          const persisted = await control.inputValue().catch(() => "");
          if (persisted.trim() !== value.trim()) await control.fill(value).catch(() => undefined);
        }
      }

      if (plan.actionCandidateId) {
        const action = observation.candidates.find((x) => x.id === plan.actionCandidateId);
        if (action && safeActions.some((x) => x.id === action.id)) {
          const before = `${page.url()}|${observation.headings.join("|")}|${observation.bodyText.slice(0, 300)}`;
          const locator = page.locator("button:visible,a:visible,input:visible,select:visible,textarea:visible,[role=button]:visible,[role=radio]:visible,[role=checkbox]:visible").nth(action.id - 1);
          await locator.scrollIntoViewIfNeeded().catch(() => undefined);
          await locator.click({ timeout: 10_000 }).catch(async () => { await locator.evaluate((element: HTMLElement) => element.click()); });
          await page.waitForTimeout(800);
          const afterObservation = await observe(page);
          const reachedExpected = args.expected ? (await page.locator(args.expected).filter({ visible: true }).count()) > 0 : false;
          const changed = before !== `${page.url()}|${afterObservation.headings.join("|")}|${afterObservation.bodyText.slice(0, 300)}`;
          args.heals.push({ step: args.step, level: "L3", intent: args.goal, reason: plan.reason, newLocator: `form-plan/action:${action.id}`, confidence: plan.confidence, evidence: `Mapped ${plan.assignments.length} payload-backed field(s); action=${action.text || action.name || action.label}`, verified: reachedExpected || changed });
          if (reachedExpected || changed) return true;
        }
      }
    }
  }

  if (safeActions.length) {
    const choice = await chooseCandidate({
      intent: `${args.goal}. The current page may have changed structure, tags, ids, classes, labels, layout or step order. Choose only a safe navigation/dismiss action that advances the existing payload-backed journey. Do not invent a value or accept a new preference.`,
      observation,
      candidates: safeActions,
    });
    args.modelBudget.used++;
    if (choice && choice.confidence >= 0.75) {
      const selected = safeActions.find((candidate) => candidate.id === choice.candidateId);
      if (selected) {
        const before = `${page.url()}|${observation.headings.join("|")}|${observation.bodyText.slice(0, 300)}`;
        const interactive = page.locator("button:visible,a:visible,input:visible,select:visible,textarea:visible,[role=button]:visible,[role=radio]:visible,[role=checkbox]:visible").nth(selected.id - 1);
        await interactive.scrollIntoViewIfNeeded().catch(() => undefined);
        await interactive.click({ timeout: 10_000 }).catch(async () => { await interactive.evaluate((element: HTMLElement) => element.click()); });
        await page.waitForTimeout(700);
        const afterObservation = await observe(page);
        const after = `${page.url()}|${afterObservation.headings.join("|")}|${afterObservation.bodyText.slice(0, 300)}`;
        const reachedExpected = args.expected ? (await page.locator(args.expected).filter({ visible: true }).count()) > 0 : false;
        const changed = before !== after;
        args.heals.push({ step: args.step, level: "L3", intent: args.goal, reason: choice.reason, newLocator: `candidate:${choice.candidateId}`, confidence: choice.confidence, evidence: JSON.stringify(selected), verified: reachedExpected || changed });
        if (reachedExpected || changed) return true;
      }
    }
  }

  if (visibleInputs.length > 0) throw new Error("Unexpected form was inspected by AI but could not be completed exclusively from payload-backed values");
  return false;
}

function escapeRx(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
