import type { Locator, Page } from "playwright";
import { chooseCandidate, planPayloadForm, type PayloadFieldKey } from "./ai";
import { observe, type Candidate } from "./observe";
import type { HealEvent } from "./types";
import type { JobPayload } from "./payload";
import { detectJourneyState } from "./journey-state";

type ModelBudget = { used: number; max: number; estimatedCostUsd: number; maxCostUsd: number; costPerCallUsd: number };
function claimModelCall(budget: ModelBudget) {
  if (budget.used >= budget.max) throw new Error("Model-call budget exhausted");
  if (budget.estimatedCostUsd + budget.costPerCallUsd > budget.maxCostUsd) throw new Error("Model-cost budget exhausted");
  budget.used += 1;
  budget.estimatedCostUsd += budget.costPerCallUsd;
}

// Resolve via the stable data-ai-id stamped at observe() time. This fixes
// the mis-click/mis-fill bug where healing used nth(id-1) over a freshly
// queried (differently ordered) visible list.
function locatorFor(page: Page, candidate: Candidate): Locator {
  if (candidate.ref) {
    return page.locator(`[data-ai-id="${candidate.ref}"]`).first();
  }
  return page.locator("button:visible,a:visible,input:visible,select:visible,textarea:visible,[role=button]:visible,[role=radio]:visible,[role=checkbox]:visible").nth(candidate.id - 1);
}

async function clickStable(page: Page, candidate: Candidate): Promise<void> {
  const locator = locatorFor(page, candidate);
  await locator.scrollIntoViewIfNeeded().catch(() => undefined);
  try {
    await locator.click({ timeout: 8000 });
    return;
  } catch {
    // Force / JS fallbacks: portal restyles inputs so the clickable node is
    // often a label/wrapper; a dispatched click still toggles the control.
    await locator.click({ timeout: 4000, force: true }).catch(() => undefined);
    const clicked = await locator.evaluate((el: HTMLElement) => {
      el.scrollIntoView({ block: "center" });
      el.click();
      return true;
    }).catch(() => false);
    if (!clicked) throw new Error(`Could not click candidate ${candidate.id}`);
  }
}

async function fillControl(page: Page, candidate: Candidate, value: string): Promise<boolean> {
  if (!value) return true;
  const control = locatorFor(page, candidate);
  if (!(await control.count().catch(() => 0))) return false;

  if (candidate.tag === "select") {
    const options = await control.locator("option").allTextContents().catch(() => [] as string[]);
    const exact = options.find((x) => x.trim().toLowerCase() === value.trim().toLowerCase());
    const partial = exact ?? options.find((x) => x.toLowerCase().includes(value.toLowerCase())) ?? options.find((x) => value.toLowerCase().includes(x.toLowerCase()));
    if (partial) {
      await control.selectOption({ label: partial }).catch(() => undefined);
      return true;
    }
    // Value-style match (e.g. Mr/Mrs option values).
    await control.selectOption(value).catch(() => undefined);
    return true;
  }

  if (/radio|checkbox/i.test(candidate.type) || candidate.role === "radio" || candidate.role === "checkbox") {
    // Radios/checkboxes carry no free text: presence of an assignment means
    // "select this option" (activation New/Transfer, Unsure, Wait-for-router).
    await control.check({ force: true }).catch(() => undefined);
    if (await control.isChecked().catch(() => false)) return true;
    await clickStable(page, candidate).catch(() => undefined);
    return control.isChecked().catch(() => false);
  }

  // Text-like input: REAL keystrokes first. The portal's address search (and
  // other validated fields) listens for `keyup` (debounced) — `fill()` sets
  // the value programmatically with no key events, so autosuggest never fires
  // and AI recovery would type an address no suggestion ever matches.
  await control.scrollIntoViewIfNeeded().catch(() => undefined);
  await control.click().catch(() => undefined);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await control.press("ControlOrMeta+a").catch(() => undefined);
    await control.press("Backspace").catch(() => undefined);
    await control.pressSequentially(value, { delay: 30 }).catch(() => undefined);
    const persisted = await control.inputValue().catch(() => "");
    if (persisted.trim() === value.trim()) return true;
    await page.waitForTimeout(200);
  }
  // Fallback for inputs that reject keystrokes: programmatic fill + synthetic
  // keyup/input/change (bubbled, so delegated jQuery handlers still run).
  await control.fill(value).catch(() => undefined);
  await control.evaluate((el: HTMLInputElement) => {
    el.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }).catch(() => undefined);
  const final = await control.inputValue().catch(() => "");
  if (final.trim() === value.trim()) return true;
  // Last resort: set via DOM + dispatch input/change so framework picks it up.
  await control.evaluate((el: HTMLInputElement, v: string) => {
    el.focus();
    el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value).catch(() => undefined);
  const last = await control.inputValue().catch(() => "");
  return last.trim() === value.trim();
}

export async function semanticLocator(page: Page, args: { step: number; intent: string; names: string[]; guarded?: boolean; modelBudget: ModelBudget }): Promise<{ locator: Locator; heal?: HealEvent }> {
  if (args.guarded) throw new Error("Guarded step cannot use free-form healing");
  const names = args.names.flatMap((n) => (/^(next|continue)$/i.test(n.trim()) ? [n, "Proceed"] : [n]));
  const o = await observe(page);
  for (const n of names) {
    const rx = new RegExp(escapeRx(n), "i");
    const role = page.getByRole("button", { name: rx }).first();
    if (await role.count() && await role.isVisible().catch(() => false)) return { locator: role, heal: { step: args.step, level: "L1", intent: args.intent, reason: "Recovered by accessible role/name", newLocator: `role=button name~${n}`, evidence: "Accessible name matched intent", verified: false } };
    const label = page.getByLabel(rx).first();
    if (await label.count() && await label.isVisible().catch(() => false)) return { locator: label, heal: { step: args.step, level: "L1", intent: args.intent, reason: "Recovered by label", newLocator: `label~${n}`, evidence: "Label matched intent", verified: false } };
    const test = o.candidates.find((c) => c.testId && rx.test(c.testId));
    if (test) return { locator: locatorFor(page, test), heal: { step: args.step, level: "L1", intent: args.intent, reason: "Recovered by test id", newLocator: `testid=${test.testId}`, evidence: test.fingerprint || "test id", verified: false } };
    const byText = page.locator("button, a, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: rx }).first();
    if (await byText.count() && await byText.isVisible().catch(() => false)) return { locator: byText, heal: { step: args.step, level: "L1", intent: args.intent, reason: "Recovered by visible text", newLocator: `text~${n}`, evidence: "Visible text matched intent", verified: false } };
    const landmark = o.candidates.find((c) => rx.test(`${c.landmark || ""} ${c.label} ${c.name} ${c.text}`));
    if (landmark) return { locator: locatorFor(page, landmark), heal: { step: args.step, level: "L1", intent: args.intent, reason: "Recovered by nearby landmark", newLocator: `landmark~${landmark.landmark || n}`, evidence: landmark.fingerprint || "landmark", verified: false } };
    const fingerprint = o.candidates.find((c) => rx.test(c.fingerprint || ""));
    if (fingerprint) return { locator: locatorFor(page, fingerprint), heal: { step: args.step, level: "L1", intent: args.intent, reason: "Recovered by DOM fingerprint", newLocator: `fingerprint:${fingerprint.fingerprint}`, evidence: fingerprint.fingerprint || "", verified: false } };
  }
  claimModelCall(args.modelBudget);
  const choice = await chooseCandidate({ intent: args.intent, observation: o, candidates: o.candidates });
  if (!choice || choice.confidence < 0.7) throw new Error("No high-confidence semantic recovery");
  const c = o.candidates.find((x) => x.id === choice.candidateId);
  if (!c) throw new Error("AI selected unknown candidate");
  return { locator: locatorFor(page, c), heal: { step: args.step, level: "L2", intent: args.intent, reason: choice.reason, newLocator: `candidate:${choice.candidateId}`, confidence: choice.confidence, evidence: JSON.stringify(c), verified: false } };
}

export async function recoverUnexpectedPage(page: Page, args: { step: number; goal: string; expected?: string; payload: JobPayload; modelBudget: ModelBudget; heals: HealEvent[] }): Promise<boolean> {
  if (args.expected && (await page.locator(args.expected).filter({ visible: true }).count())) return true;
  const observation = await observe(page);
  const pageText = `${observation.title} ${observation.headings.join(" ")} ${observation.bodyText}`;
  const captchaChallengeFrame = page.frames().some((frame) => /recaptcha.*(bframe|challenge)|hcaptcha.*(challenge|checkbox)/i.test(frame.url()));
  if (/verify you are human|i am not a robot|captcha challenge/i.test(pageText) || captchaChallengeFrame) throw new Error("HUMAN_REQUIRED:CAPTCHA");
  if (/one[- ]time|verification code|enter.*otp|email.*code/i.test(pageText)) throw new Error("HUMAN_REQUIRED:EMAIL_OTP");
  if (/card number|cvv|pay now|payment details/i.test(pageText)) throw new Error("Guarded payment state encountered during free-form recovery");
  const visibleInputs = observation.candidates.filter((candidate) => ["input", "select", "textarea"].includes(candidate.tag) && candidate.type !== "hidden" && !candidate.disabled);
  const safeActions = observation.candidates.filter((candidate) =>
    !candidate.disabled &&
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

  // ONE model call covers both fills + the follow-up nav action. The old code
  // spent a second call on chooseCandidate even when the form plan already
  // contained an action — doubling token/request cost per recovery.
  if (visibleInputs.length) {
    claimModelCall(args.modelBudget);
    const plan = await planPayloadForm({ goal: args.goal, observation, candidates: [...visibleInputs, ...safeActions] });
    if (plan && plan.confidence >= 0.6) {
      let filled = 0;
      for (const assignment of plan.assignments) {
        const value = valueFor(assignment.valueKey);
        if (!value) continue;
        const candidate = observation.candidates.find((x) => x.id === assignment.candidateId);
        if (!candidate || !["input", "select", "textarea"].includes(candidate.tag)) continue;
        if (await fillControl(page, candidate, value)) filled += 1;
      }

      if (plan.actionCandidateId) {
        const action = observation.candidates.find((x) => x.id === plan.actionCandidateId);
        if (action && safeActions.some((x) => x.id === action.id)) {
          const beforeState = await detectJourneyState(page);
          await clickStable(page, action);
          await page.waitForTimeout(800);
          const afterState = await detectJourneyState(page);
          const reachedExpected = args.expected ? (await page.locator(args.expected).filter({ visible: true }).count()) > 0 : false;
          const actionGone = (await locatorFor(page, action).count().catch(() => 0)) === 0;
          const verified = reachedExpected || afterState.stage !== beforeState.stage || (actionGone && afterState.signature !== beforeState.signature);
          args.heals.push({ step: args.step, level: "L3", intent: args.goal, reason: plan.reason, newLocator: `form-plan/action:${action.id}`, confidence: plan.confidence, evidence: `Mapped ${filled}/${plan.assignments.length} payload-backed field(s); ${beforeState.stage}->${afterState.stage}; action=${action.text || action.name || action.label}`, verified });
          if (verified) return true;
          // Fills stuck but nav happened — report progress so the caller can
          // re-verify instead of spending another model call immediately.
          if (filled > 0) return true;
        }
      } else if (filled > 0) {
        args.heals.push({ step: args.step, level: "L3", intent: args.goal, reason: plan.reason, newLocator: `form-plan/fills:${filled}`, confidence: plan.confidence, evidence: `Filled ${filled} payload-backed field(s), no nav action`, verified: false });
        return true;
      }
    }
  }

  if (safeActions.length) {
    claimModelCall(args.modelBudget);
    const choice = await chooseCandidate({
      intent: `${args.goal}. The current page may have changed structure, tags, ids, classes, labels, layout or step order. Choose only a safe navigation/dismiss action that advances the existing payload-backed journey. Do not invent a value or accept a new preference.`,
      observation,
      candidates: safeActions,
    });
    if (choice && choice.confidence >= 0.7) {
      const selected = safeActions.find((candidate) => candidate.id === choice.candidateId);
      if (selected) {
        const beforeState = await detectJourneyState(page);
        await clickStable(page, selected);
        await page.waitForTimeout(700);
        const afterState = await detectJourneyState(page);
        const reachedExpected = args.expected ? (await page.locator(args.expected).filter({ visible: true }).count()) > 0 : false;
        const actionGone = (await locatorFor(page, selected).count().catch(() => 0)) === 0;
        const verified = reachedExpected || afterState.stage !== beforeState.stage || (actionGone && afterState.signature !== beforeState.signature);
        args.heals.push({ step: args.step, level: "L3", intent: args.goal, reason: choice.reason, newLocator: `candidate:${choice.candidateId}`, confidence: choice.confidence, evidence: `${beforeState.stage}->${afterState.stage}; ${JSON.stringify(selected)}`, verified });
        if (verified) return true;
      }
    }
  }

  if (visibleInputs.length > 0) throw new Error("Unexpected form was inspected by AI but could not be completed exclusively from payload-backed values");
  return false;
}

function escapeRx(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
