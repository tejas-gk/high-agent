import type { Locator, Page } from "playwright";
import { chooseCandidate } from "./ai";
import { observe } from "./observe";
import type { HealEvent } from "./types";

export async function semanticLocator(
  page: Page,
  args: {
    step: number;
    intent: string;
    names: string[];
    guarded?: boolean;
    modelBudget: { used: number; max: number };
  },
): Promise<{ locator: Locator; heal?: HealEvent }> {
  if (args.guarded) throw new Error("Guarded step cannot use free-form healing");

  for (const n of args.names) {
    const byText = page
      .locator("button, a, [role='button'], input[type='submit'], input[type='button']")
      .filter({ hasText: new RegExp(escapeRx(n), "i") });

    for (let index = 0; index < (await byText.count()); index += 1) {
      const candidate = byText.nth(index);
      if (await candidate.isVisible().catch(() => false)) {
        return { locator: candidate, heal: { step: args.step, level: "L1", intent: args.intent, reason: "Recovered by visible action text", newLocator: `button|a text~${n}`, evidence: "Visible action text matched intent", verified: false } };
      }
    }

    const visibleText = page.getByText(new RegExp(escapeRx(n), "i")).first();
    if (await visibleText.count()) {
      return { locator: visibleText, heal: { step: args.step, level: "L1", intent: args.intent, reason: "Recovered by visible text", newLocator: `text~${n}`, evidence: "Visible text matched intent", verified: false } };
    }
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

export async function recoverUnexpectedPage(
  page: Page,
  args: { step: number; goal: string; expected?: string; modelBudget: { used: number; max: number }; heals: HealEvent[] },
): Promise<boolean> {
  if (args.expected && (await page.locator(args.expected).filter({ visible: true }).count())) return true;

  const observation = await observe(page);
  const pageText = `${observation.title} ${observation.headings.join(" ")} ${observation.bodyText}`;
  const captchaFrameVisible = await page
    .locator('iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[title*="recaptcha" i], iframe[title*="captcha" i]')
    .filter({ visible: true })
    .count()
    .then((count) => count > 0)
    .catch(() => false);
  const captchaChallengeFrame = page.frames().some((frame) => /recaptcha.*(bframe|challenge)|hcaptcha/i.test(frame.url()));

  if (/captcha|i am not a robot|recaptcha|hcaptcha/i.test(pageText) || captchaFrameVisible || captchaChallengeFrame) {
    throw new Error("HUMAN_REQUIRED:CAPTCHA");
  }
  if (/one[- ]time|verification code|enter.*otp|email.*code/i.test(pageText)) throw new Error("HUMAN_REQUIRED:EMAIL_OTP");
  if (/card number|cvv|pay now|payment details/i.test(pageText)) throw new Error("Guarded payment state encountered during free-form recovery");

  const visibleInputs = observation.candidates.filter((candidate) => ["input", "select", "textarea"].includes(candidate.tag) && candidate.type !== "hidden");
  if (visibleInputs.length > 0) throw new Error("Unexpected required form needs a payload-backed value; escalating instead of inventing data");
  if (args.modelBudget.used >= args.modelBudget.max) throw new Error("Model-call budget exhausted");

  const safeActions = observation.candidates.filter((candidate) => {
    if (!(candidate.tag === "button" || candidate.tag === "a" || candidate.role === "button")) return false;
    return !/pay|purchase|submit order|place order|otp|verify code|captcha/i.test(`${candidate.text} ${candidate.name}`);
  });
  if (!safeActions.length) return false;

  const choice = await chooseCandidate({ intent: `${args.goal}. This is an unexpected interstitial or reordered page. Choose only a safe navigation/dismiss action that moves toward the goal; do not answer a new customer preference.`, observation, candidates: safeActions });
  args.modelBudget.used++;
  if (!choice || choice.confidence < 0.75) return false;
  const selected = safeActions.find((candidate) => candidate.id === choice.candidateId);
  if (!selected) return false;

  const before = `${page.url()}|${observation.headings.join("|")}|${observation.bodyText.slice(0, 300)}`;
  const interactive = page.locator("button:visible,a:visible,input:visible,select:visible,textarea:visible,[role=button]:visible,[role=radio]:visible,[role=checkbox]:visible").nth(choice.candidateId - 1);
  await interactive.scrollIntoViewIfNeeded().catch(() => undefined);
  await interactive.click({ timeout: 10_000 }).catch(async () => { await interactive.evaluate((element: HTMLElement) => element.click()); });
  await page.waitForTimeout(700);

  const afterObservation = await observe(page);
  const after = `${page.url()}|${afterObservation.headings.join("|")}|${afterObservation.bodyText.slice(0, 300)}`;
  const reachedExpected = args.expected ? (await page.locator(args.expected).filter({ visible: true }).count()) > 0 : false;
  const changed = before !== after;
  args.heals.push({ step: args.step, level: "L3", intent: args.goal, reason: choice.reason, newLocator: `candidate:${choice.candidateId}`, confidence: choice.confidence, evidence: JSON.stringify(selected), verified: reachedExpected || changed });
  return reachedExpected || changed;
}

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
