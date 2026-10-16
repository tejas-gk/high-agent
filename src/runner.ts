import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { recoverUnexpectedPage } from "./healing";
import { executePayment } from "./payment";
import { installMutationLayer } from "./mutation";
import { leakScan } from "./security";
import { declineDonationAndAdvance, fillContactAndAdvance } from "./checkout-progress";
import type { JobPayload } from "./payload";
import { describeCompletedSteps, type HealEvent, type HumanRequestType, type RunReport, type TraceEvent } from "./types";
import {
  activePopupId, assertNbnPlanInCart, checkAllVisible, chooseAddressSuggestion, clickAction, clickOrderNow,
  Escalation, fillConnection, fillManual, fillService, fillVerified,
  handle3dsAndTransaction, resolvePopup, selectPlan, selectRouter,
  settlePopups, typeAddress, verifyOrderSummary, waitForAddressResult,
} from "./runner-helpers";

export type RunnerOptions = {
  jobId: string;
  payload: JobPayload;
  mutate: boolean;
  emit: (event: TraceEvent) => void;
  checkpoint?: () => Promise<"normal" | "resumed">;
  requestHumanInput?: (request: { type: HumanRequestType; step: number; message: string }) => Promise<string>;
};

export async function runAgent({ jobId, payload, mutate, emit, checkpoint, requestHumanInput }: RunnerOptions): Promise<RunReport> {
  const started = Date.now();
  const completed: number[] = [];
  const heals: HealEvent[] = [];
  const modelBudget = { used: 0, max: 10 };
  const evidenceDir = path.resolve("artifacts", jobId);
  const previewPath = path.join(evidenceDir, "live.png");
  let sensitiveMode = false;
  await fs.mkdir(evidenceDir, { recursive: true });

  const browser = await chromium.launch({ headless: process.env.HEADLESS === "true" });
  const context = await browser.newContext();
  let page = await context.newPage();
  if (mutate) await installMutationLayer(page);

  const resetSession = async () => {
    await page.close().catch(() => undefined);
    await context.clearCookies().catch(() => undefined);
    page = await context.newPage();
    if (mutate) await installMutationLayer(page);
  };
  const capturePreview = async () => {
    if (sensitiveMode) return;
    await page.screenshot({ path: previewPath, fullPage: false, animations: "disabled" }).catch(() => undefined);
  };
  const log = (step: number, message: string, data?: Record<string, unknown>) => {
    emit({ at: new Date().toISOString(), level: "info", step, message, data });
    void capturePreview();
  };
  const done = (step: number) => { if (!completed.includes(step)) completed.push(step); };
  const makeReport = (status: "success" | "failed" | "escalated", transactionId?: string, failureReason?: string): RunReport => ({
    jobId, status, transactionId, completedSteps: completed, completedStepDetails: describeCompletedSteps(completed), heals,
    startedAt: new Date(started).toISOString(), finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started, modelCalls: modelBudget.used, failureReason, evidenceDir,
  });
  const writeReport = (report: RunReport) => fs.writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
  const bodyText = async () => (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ");

  // Returns the next workflow step implied by the page that is currently open.
  // This lets a paused run resume from a page the human navigated to manually,
  // rather than blindly returning to the step that originally paused.
  const detectJourneyStep = async (): Promise<number> => {
    const text = (await bodyText()).toUpperCase();
    const url = page.url();

    if (/TRANSACTION\s*(?:ID|NUMBER)|ORDER\s*(?:CONFIRMED|NUMBER)|THANK YOU.*ORDER/i.test(text)) return 20;
    if (/3.?D SECURE|AUTHENTICATED.*ECI\s*05/i.test(text)) return 18;
    if (/LASTLY,?\s*WE JUST NEED TO TAKE YOUR PAYMENT|PAYMENT DETAILS|NAME ON CARD|CARD NUMBER|PAY NOW/i.test(text)) return 16;
    if (/SMALL CHANGE BIG CHANGE|DONATION/i.test(text)) return 15;
    if (/PROCESS ORDER(?: AND)? PAY|CURRENT PROVIDER|\bAVC\b/i.test(text)) return 14;
    if (/SERVICE ADDRESS|DELIVERY ADDRESS|SELF CARE PORTAL/i.test(text)) return 13;
    if (/CONTACT DETAILS|SALUTATION|FIRST NAME/i.test(text) && !/ID VERIFICATION|LICEN[CS]E NUMBER/i.test(text)) return 12;
    if (/checkout\/login/i.test(url) || /EMAIL ADDRESS|CHECKOUT LOGIN/i.test(text)) return 11;
    if (/BUILD YOUR PLAN|SELECT.*NBN.*PLAN|CHOOSE.*NBN.*PLAN/i.test(text)) return 5;
    if (/CHECK YOUR ADDRESS|ENTER.*SERVICE ADDRESS|ADDRESS SEARCH/i.test(text)) return 2;

    return 0;
  };

  const checkpointAndMaybeSkip = async (step: number): Promise<boolean> => {
    const mode = checkpoint ? await checkpoint() : "normal";
    if (mode === "resumed") {
      log(step, "Run resumed; re-observing the browser from its current page", { url: page.url() });
    }

    const detectedStep = await detectJourneyStep();
    if (detectedStep > step) {
      log(step, "Current browser page is already beyond this step; reconciling and continuing forward", {
        detectedStep,
        url: page.url(),
      });
      return true;
    }

    return false;
  };

  const captchaPresent = async () => {
    const challengeFrame = page.frames().some((frame) => /recaptcha.*(bframe|challenge)|hcaptcha/i.test(frame.url()));
    return challengeFrame || /verify you are human|i am not a robot|captcha challenge/i.test(await bodyText());
  };

  const humanCaptcha = async (step: number) => {
    if (!requestHumanInput) throw new Escalation("CAPTCHA requires human completion");
    while (await captchaPresent()) {
      log(step, "Human handoff: CAPTCHA requires manual completion; browser session preserved");
      await requestHumanInput({ type: "CAPTCHA", step, message: "Solve the CAPTCHA in the open Tangerine browser, then continue here. The same browser session stays open." });
      await page.waitForTimeout(500);
    }
    log(step, "CAPTCHA cleared by human; resumed same browser session");
  };

  const humanResolveEscalation = async (step: number, reason: string) => {
    if (!requestHumanInput) throw new Escalation(reason);
    log(step, "Human handoff: recoverable escalation; browser session preserved", { reason });
    await capturePreview();
    await requestHumanInput({
      type: "MANUAL_ESCALATION", step,
      message: `The agent could not safely continue automatically: ${reason}. Resolve the issue in the open Tangerine browser without closing it, then click “I resolved it — continue”. The agent will re-observe this same session.`,
    });
    await page.waitForTimeout(500);
    log(step, "Manual escalation returned; re-observing current browser state");
  };

  // Recoverable pre-payment steps NEVER become terminal merely because one
  // human handoff did not finish the step. They alternate semantic recovery
  // and human handoff until the independent postcondition is actually true.
  const runRecoverable = async (args: {
    step: number;
    goal: string;
    deterministic: () => Promise<void>;
    verified: () => Promise<boolean>;
    attempts?: number;
  }) => {
    if (await checkpointAndMaybeSkip(args.step)) return;

    let reason = "postcondition not reached";
    try {
      await args.deterministic();
      await page.waitForTimeout(400);
      if (await args.verified()) return;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
      log(args.step, "Deterministic action failed; invoking semantic recovery", { reason });
    }

    let cycle = 0;
    while (!(await args.verified())) {
      if (await checkpointAndMaybeSkip(args.step)) return;
      cycle += 1;
      const semanticAttempts = args.attempts ?? 2;
      for (let attempt = 1; attempt <= semanticAttempts && !(await args.verified()); attempt += 1) {
        if (modelBudget.used >= modelBudget.max) {
          reason = "Model-call budget exhausted; human completion required";
          break;
        }
        try {
          const recovered = await recoverUnexpectedPage(page, { step: args.step, goal: args.goal, payload, modelBudget, heals });
          await page.waitForTimeout(500);
          if (recovered && await args.verified()) {
            log(args.step, "Semantic recovery succeeded and postcondition verified", { cycle, attempt });
            return;
          }
          reason = "Semantic recovery acted but the required postcondition is still false";
        } catch (error) {
          const nextReason = error instanceof Error ? error.message : String(error);
          if (nextReason === "HUMAN_REQUIRED:CAPTCHA") {
            await humanCaptcha(args.step);
            if (await args.verified()) return;
            reason = "CAPTCHA cleared, but the step still needs completion";
            continue;
          }
          if (nextReason === "HUMAN_REQUIRED:EMAIL_OTP") {
            reason = "Email OTP requires human completion";
            break;
          }
          reason = nextReason;
          log(args.step, "Semantic recovery could not verify progression", { reason, cycle, attempt });
        }
      }

      if (await args.verified()) return;
      await humanResolveEscalation(args.step, reason);
      if (await args.verified()) {
        log(args.step, "Human recovery verified; continuing same run", { cycle });
        return;
      }
      log(args.step, "Human handoff completed but postcondition is still false; keeping browser open and recovery active", { cycle });
    }
  };

  const checkoutReached = async () => /checkout|login/i.test(page.url()) ||
    (await page.locator('#email, input[type="email"], input[name*="email" i]').filter({ visible: true }).count()) > 0;

  try {
    await page.goto(payload.portal.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!page.url().includes("test-tangerine.hipeely.com")) throw new Error("Portal URL did not match approved test environment");
    done(1); log(1, "Portal opened and approved origin verified");

    const selectAndOrder = async (): Promise<boolean> => {
      await runRecoverable({
        step: 2, goal: "Enter the supplied service address and expose an address suggestion or manual-address path",
        deterministic: () => typeAddress(page, payload.connectionAddress.mainAddress.fullAddress),
        verified: async () => (await page.locator(".autocomplete-suggestion:visible").count()) > 0 ||
          (await page.locator("button:visible,a:visible,[role='button']:visible").filter({ hasText: /manual|can't find|cannot find/i }).count()) > 0,
      });
      done(2); log(2, "Service address entered and address path verified");

      await runRecoverable({
        step: 3, goal: "Confirm the supplied service address and reach the NBN technology/plan result",
        deterministic: async () => {
          const selected = await chooseAddressSuggestion(page, payload.connectionAddress.mainAddress.fullAddress);
          if (!selected) {
            const manual = page.locator("button, a, [role='button']").filter({ hasText: /enter.*address.*manually|check your address manually|can't find your address/i }).filter({ visible: true }).first();
            if (!(await manual.count())) throw new Error("Address suggestion unavailable and manual path not found");
            await clickAction(manual); await fillManual(page, payload);
          }
          await waitForAddressResult(page);
          await resolvePopup(page, /build your plan|see nbn|see other plans|continue with nbn|pre-?order/i);
          await settlePopups(page);
        },
        verified: async () => /speed|plan|nbn|build your plan/i.test(await bodyText()),
      });
      done(3); done(4); log(4, "Address confirmed and plan builder reached");

      await runRecoverable({
        step: 5, goal: `Select exactly the requested NBN plan “${payload.plan.name}” and keep a positive cart`,
        deterministic: async () => { await selectPlan(page, payload.plan.name); await settlePopups(page); },
        verified: async () => { try { await assertNbnPlanInCart(page, payload.plan.name); return true; } catch { return false; } },
      });
      done(5); done(6); log(6, "Requested NBN plan selected; blocking dialogs cleared");

      if (payload.addOns.router.enabled) {
        await runRecoverable({
          step: 7, goal: `Select the requested router option “${payload.addOns.router.model || "BYO Modem"}” without losing the NBN plan`,
          deterministic: async () => { await selectRouter(page, payload.addOns.router.model || "BYO Modem"); await settlePopups(page); },
          verified: async () => { try { await assertNbnPlanInCart(page, payload.plan.name); return true; } catch { return false; } },
        });
        done(7); log(7, "Router choice completed");
      }

      try { await assertNbnPlanInCart(page, payload.plan.name); }
      catch {
        await runRecoverable({
          step: 8, goal: `Restore and verify the requested NBN plan “${payload.plan.name}” in a positive cart`,
          deterministic: async () => { await selectPlan(page, payload.plan.name); await settlePopups(page); },
          verified: async () => { try { await assertNbnPlanInCart(page, payload.plan.name); return true; } catch { return false; } },
        });
      }
      done(8); log(8, "Order cart positively verified");

      await runRecoverable({
        step: 9, goal: "Proceed from the verified NBN cart into checkout using the semantic equivalent of Order Now/Checkout",
        deterministic: async () => {
          for (let attempt = 0; attempt < 3 && !(await checkoutReached()); attempt += 1) { await clickOrderNow(page); await page.waitForTimeout(700); }
        },
        verified: checkoutReached, attempts: 3,
      });
      done(9); done(10); log(10, "Checkout reached and cart-integrity guard passed", { url: page.url(), popupId: await activePopupId(page) });
      return true;
    };

    let transactionId: string | undefined;
    const runOrder = async (): Promise<"ok" | "checkoutBounce"> => {
      if (!(await selectAndOrder())) return "checkoutBounce";

      await runRecoverable({
        step: 11, goal: "Enter the payload email on checkout login and advance to contact details or guarded OTP/CAPTCHA",
        deterministic: async () => {
          const email = page.locator('#email, input[type="email"], input[name*="email" i]').filter({ visible: true }).first();
          if (!(await email.count())) throw new Error("Checkout email field not found");
          await fillVerified(page, email, payload.customer.email);
          const next = page.locator("button:visible,a:visible,input[type='submit']:visible,input[type='button']:visible").filter({ hasText: /next|continue/i }).first();
          if (!(await next.count())) throw new Error("Checkout Next control not found");
          await clickAction(next); await page.waitForTimeout(900);
        },
        verified: async () => (await captchaPresent()) ||
          (await page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]').filter({ visible: true }).count()) > 0 ||
          (await page.locator("#fname, input[name='fname' i], #salutation").filter({ visible: true }).count()) > 0 || /contact details/i.test(await bodyText()),
      });

      if (await captchaPresent()) await humanCaptcha(11);
      const otpField = page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i]').filter({ visible: true }).first();
      if (await otpField.count()) {
        if (!requestHumanInput) throw new Escalation("Email OTP requires human submission");
        const otp = await requestHumanInput({ type: "EMAIL_OTP", step: 11, message: "Enter the one-time email verification code. It goes directly to Playwright and is not sent to Sarvam." });
        await otpField.fill(otp);
        const submit = page.locator("button:visible,input[type='submit']:visible,input[type='button']:visible").filter({ hasText: /verify|submit|continue|next/i }).first();
        if (await submit.count()) await clickAction(submit);
        await page.waitForTimeout(800);
      }
      done(11); log(11, "Email verification stage completed");

      await runRecoverable({ step: 12, goal: "Complete contact details using only payload-backed customer values and advance", deterministic: () => fillContactAndAdvance(page, payload), verified: async () => /service address|delivery address|self care portal|connection details|new connection|transfer connection/i.test(await bodyText()), attempts: 3 });
      done(12); log(12, "Contact details completed and next state verified");
      await runRecoverable({ step: 13, goal: "Complete service and delivery address using only the supplied payload address and advance", deterministic: () => fillService(page, payload), verified: async () => /current provider|avc|new connection|transfer connection|process order|donation|small change big change/i.test(await bodyText()), attempts: 3 });
      done(13); log(13, "Service/delivery details completed and next state verified");
      await runRecoverable({ step: 14, goal: "Complete connection activation/transfer/provider/date choices and Process Order and Pay", deterministic: () => fillConnection(page, payload), verified: async () => /donation|small change big change|name on card|payment details|card number|pay now/i.test(await bodyText()), attempts: 3 });
      done(14); log(14, "Connection details completed and next state verified");
      await runRecoverable({ step: 15, goal: "Decline the optional donation and advance to payment/order summary", deterministic: () => declineDonationAndAdvance(page), verified: async () => /name on card|payment details|card number|pay now|order summary/i.test(await bodyText()), attempts: 2 });
      done(15); log(15, "Donation declined; payment/order-summary state verified");

      // Pause/resume is allowed across normal checkout pages. If the human
      // advanced beyond Pay Now while paused, never submit payment a second time.
      if (checkpoint) await checkpoint();
      const resumedPaymentStep = await detectJourneyStep();
      if (resumedPaymentStep >= 18) {
        sensitiveMode = true;
        log(17, "Resume detected a post-payment state; skipping payment submission to avoid a duplicate charge", {
          detectedStep: resumedPaymentStep,
          url: page.url(),
        });
        done(16);
        done(17);
        transactionId = await handle3dsAndTransaction(page);
        done(18);
        done(19);
        return "ok";
      }

      await verifyOrderSummary(page, payload);
      sensitiveMode = true;
      const payResult = await executePayment(page, { jobId, cardRef: payload.payment.cardRef, nameOnCard: payload.payment.nameOnCard });
      log(16, "Payment fields filled by isolated executor", { last4: payResult.last4 });
      await checkAllVisible(page);
      let pay = page.locator("button, a, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: /pay now/i }).first();
      while (!(await pay.count())) {
        await humanResolveEscalation(16, "Final Pay Now control is missing. Resolve only the page/UI issue manually; do not submit payment yourself.");
        pay = page.locator("button, a, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: /pay now/i }).first();
      }
      await clickAction(pay); done(16);

      const modal = page.getByRole("dialog").first();
      if (await modal.count()) {
        const checks = modal.locator('input[type="checkbox"]');
        for (let i = 0; i < await checks.count(); i += 1) await checks.nth(i).check();
        const modalPay = modal.locator("button, a, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: /pay now/i }).first();
        if (!(await modalPay.count())) throw new Escalation("Confirmation Pay Now missing; guarded step will not free-form heal");
        await clickAction(modalPay);
      }
      done(17);
      transactionId = await handle3dsAndTransaction(page); done(18); done(19);
      if (!/payment|card number|security code|cvv/i.test(await bodyText())) {
        sensitiveMode = false;
        await page.screenshot({ path: path.join(evidenceDir, `${transactionId}.png`), fullPage: true });
      }
      return "ok";
    };

    let orderStatus: "ok" | "checkoutBounce" = "checkoutBounce";
    for (let attempt = 1; attempt <= 3 && orderStatus === "checkoutBounce"; attempt += 1) {
      if (attempt > 1) {
        await resetSession();
        try { await page.goto(payload.portal.url, { waitUntil: "domcontentloaded", timeout: 30_000 }); } catch { continue; }
        await page.waitForTimeout(2000);
      }
      orderStatus = await runOrder();
    }
    if (orderStatus === "checkoutBounce") throw new Escalation("Checkout could not be reached after guarded retries");
    const report = makeReport("success", transactionId); await writeReport(report); await leakScan(evidenceDir); return report;
  } catch (error) {
    const escalated = error instanceof Escalation;
    const reason = error instanceof Error ? error.message : String(error);
    const report = makeReport(escalated ? "escalated" : "failed", undefined, reason);
    if (!sensitiveMode) await page.screenshot({ path: path.join(evidenceDir, "failure.png"), fullPage: true }).catch(() => undefined);
    await writeReport(report); await leakScan(evidenceDir); return report;
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
