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
  requestHumanInput?: (request: { type: HumanRequestType; step: number; message: string }) => Promise<string>;
};

export async function runAgent({ jobId, payload, mutate, emit, requestHumanInput }: RunnerOptions): Promise<RunReport> {
  const started = Date.now();
  const completed: number[] = [];
  const heals: HealEvent[] = [];
  const modelBudget = { used: 0, max: 6 };
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

  const captchaPresent = async () => {
    const challengeFrame = page.frames().some((frame) => /recaptcha.*(bframe|challenge)|hcaptcha/i.test(frame.url()));
    if (challengeFrame) return true;
    const text = await page.locator("body").innerText().catch(() => "");
    return /verify you are human|i am not a robot|captcha challenge/i.test(text);
  };

  const humanCaptcha = async (step: number) => {
    if (!requestHumanInput) throw new Escalation("CAPTCHA requires human completion");
    log(step, "Human handoff: CAPTCHA requires manual completion; browser session preserved");
    await capturePreview();
    await requestHumanInput({
      type: "CAPTCHA", step,
      message: "A CAPTCHA is blocking the signup. Solve it in the opened Tangerine browser window, then return here and click ‘I solved the CAPTCHA — continue’. Do not close the browser.",
    });
    await page.waitForTimeout(500);
    if (await captchaPresent()) throw new Escalation("CAPTCHA is still active after human handoff");
    log(step, "CAPTCHA cleared by human; agent resumed the same browser session");
  };


  const humanResolveEscalation = async (step: number, reason: string) => {
    if (!requestHumanInput) throw new Escalation(reason);
    log(step, "Human handoff: recoverable escalation; browser session preserved", { reason });
    await capturePreview();
    await requestHumanInput({
      type: "MANUAL_ESCALATION",
      step,
      message: `The agent could not safely continue automatically: ${reason}. Resolve the issue directly in the open Tangerine browser without closing it, then click “I resolved it — continue”. The agent will re-observe the same session and continue from the current page.`,
    });
    await page.waitForTimeout(500);
    log(step, "Manual escalation marked resolved; re-observing current browser state");
  };

  const ensureExpectedState = async (step: number, goal: string, selector: string) => {
    if (await page.locator(selector).filter({ visible: true }).count()) return;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const recovered = await recoverUnexpectedPage(page, { step, goal, expected: selector, payload, modelBudget, heals });
        if (recovered && (await page.locator(selector).filter({ visible: true }).count())) {
          log(step, "AI re-planned around an unexpected page and verified recovery");
          return;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason === "HUMAN_REQUIRED:CAPTCHA") {
          await humanCaptcha(step);
          if (await page.locator(selector).filter({ visible: true }).count()) return;
          continue;
        }
        if (reason === "HUMAN_REQUIRED:EMAIL_OTP") throw new Escalation("Email OTP appeared outside the guarded checkout handoff");
        await humanResolveEscalation(step, reason);
        if (await page.locator(selector).filter({ visible: true }).count()) return;
        continue;
      }
    }
    throw new Escalation(`Could not safely reach expected state: ${goal}`);
  };


  const bodyMatches = async (pattern: RegExp) =>
    pattern.test((await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " "));

  const completeStepWithRecovery = async (
    step: number,
    goal: string,
    deterministic: () => Promise<void>,
    stillOnStep: RegExp,
  ) => {
    let deterministicError: unknown;
    try {
      await deterministic();
      await page.waitForTimeout(500);
      if (!(await bodyMatches(stillOnStep))) return;
    } catch (error) {
      deterministicError = error;
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const recovered = await recoverUnexpectedPage(page, {
          step, goal, payload, modelBudget, heals,
        });
        if (recovered) {
          await page.waitForTimeout(500);
          if (!(await bodyMatches(stillOnStep))) {
            log(step, "AI recovered the changed checkout step and verified progression");
            return;
          }
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason === "HUMAN_REQUIRED:CAPTCHA") {
          await humanCaptcha(step);
          continue;
        }
        if (reason === "HUMAN_REQUIRED:EMAIL_OTP") {
          throw new Escalation("Email OTP appeared during checkout recovery");
        }
        await humanResolveEscalation(step, reason);
        if (!(await bodyMatches(stillOnStep))) return;
        continue;
      }
    }

    const base = deterministicError instanceof Error ? deterministicError.message : String(deterministicError ?? "");
    const reason = `Could not safely complete ${goal}${base ? `: ${base}` : ""}`;
    await humanResolveEscalation(step, reason);
    if (!(await bodyMatches(stillOnStep))) return;
    throw new Escalation(reason);
  };

  try {
    await page.goto(payload.portal.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!page.url().includes("test-tangerine.hipeely.com")) throw new Error("Portal URL did not match approved test environment");
    done(1); log(1, "Portal opened");

    const selectAndOrder = async (): Promise<boolean> => {
      await typeAddress(page, payload.connectionAddress.mainAddress.fullAddress); done(2); log(2, "Address entered");
      const selected = await chooseAddressSuggestion(page, payload.connectionAddress.mainAddress.fullAddress);
      if (!selected) {
        const manual = page.locator("button, a, [role='button']").filter({ hasText: /enter.*address.*manually|check your address manually|can't find your address/i }).first();
        if (!(await manual.isVisible().catch(() => false))) throw new Escalation("Address suggestion unavailable; manual address path not found");
        await clickAction(manual); await fillManual(page, payload);
      }
      await waitForAddressResult(page);
      const techResult = await resolvePopup(page, /build your plan|see nbn|see other plans|continue with nbn|pre-?order/i);
      done(3); log(3, "Address confirmed", { techResult });
      await settlePopups(page); done(4);
      await selectPlan(page, payload.plan.name); await settlePopups(page);
      done(5); done(6);
      if (payload.addOns.router.enabled) {
        await selectRouter(page, payload.addOns.router.model || "BYO Modem");
        await settlePopups(page);
        done(7);
        try {
          await assertNbnPlanInCart(page, payload.plan.name);
        } catch {
          log(8, "Router selection reset the cart; re-selecting the requested plan");
          await selectPlan(page, payload.plan.name);
          await settlePopups(page);
          await assertNbnPlanInCart(page, payload.plan.name);
        }
      } else {
        await assertNbnPlanInCart(page, payload.plan.name);
      }
      done(8);

      let checkoutReached = false;
      for (let orderAttempt = 1; orderAttempt <= 3 && !checkoutReached; orderAttempt += 1) {
        await clickOrderNow(page);
        checkoutReached = /checkout|login/i.test(page.url());
        if (!checkoutReached) {
          const body = await page.locator("body").innerText().catch(() => "");
          if (/hold\s*on/i.test(body) && /modem|router|plan/i.test(body)) {
            throw new Escalation("Cart integrity alarm: modem/router present without a valid NBN plan");
          }
          await page.waitForTimeout(700);
        }
      }
      const popupId = await activePopupId(page);
      const onCheckout = /checkout|login/i.test(page.url());
      log(9, "Order Now clicked", { url: page.url(), popupId, onCheckout });
      return onCheckout;
    };

    let transactionId: string | undefined;
    const runOrder = async (): Promise<"ok" | "checkoutBounce"> => {
      if (!(await selectAndOrder())) return "checkoutBounce";
      const email = page.locator('#email, input[type="email"], input[name*="email" i]').filter({ visible: true }).first();
      if (!(await email.count())) throw new Escalation("Checkout email field not found");
      await fillVerified(page, email, payload.customer.email);
      const emailNext = page.locator("button, a, input[type='submit'], input[type='button']").filter({ hasText: /next/i }).filter({ visible: true }).first();
      if (!(await emailNext.count())) throw new Escalation("Checkout Next control not found");
      await clickAction(emailNext);

      await page.waitForTimeout(1000);
      const loginBody = await page.locator("body").innerText().catch(() => "");
      if (/no plan|plan.*missing|select.*plan|choose.*plan/i.test(loginBody) && /checkout|order/i.test(loginBody)) {
        throw new Escalation("Checkout reported a missing NBN plan; refusing to continue with an invalid cart");
      }
      if (await captchaPresent()) {
        await humanCaptcha(11);
        if (/checkout\/login/i.test(page.url()) && await emailNext.isVisible().catch(() => false)) await clickAction(emailNext);
      }

      let navigated = false;
      const emailDeadline = Date.now() + 12_000;
      while (Date.now() < emailDeadline && !navigated) {
        if (!/checkout\/login/i.test(page.url()) || (await page.locator("#fname, input[name='fname' i], #salutation").count())) { navigated = true; break; }
        await page.waitForTimeout(400);
      }

      const stillOnLogin = /checkout\/login/i.test(page.url());
      const otpField = page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i]').filter({ visible: true }).first();
      if (stillOnLogin && (await otpField.count())) {
        if (!requestHumanInput) throw new Escalation("Email OTP requires human submission");
        log(11, "Human handoff: waiting for email OTP; browser session preserved");
        const otp = await requestHumanInput({ type: "EMAIL_OTP", step: 11, message: "Check the verification email and enter the one-time code here. The agent will submit it and continue in the same browser session." });
        await otpField.fill(otp);
        const submitOtp = page.locator("button, input[type='submit'], input[type='button']").filter({ hasText: /verify|submit|continue|next/i }).filter({ visible: true }).first();
        if (!(await submitOtp.count())) throw new Escalation("OTP submit control not found after human handoff");
        await clickAction(submitOtp); await page.waitForTimeout(800);
        if (await otpField.isVisible().catch(() => false) && /checkout\/login/i.test(page.url())) throw new Escalation("OTP was not accepted; refusing to guess or retry automatically");
        log(11, "Email verification complete; resumed same browser session");
      }
      done(9); done(10); done(11);

      await completeStepWithRecovery(
        12,
        "Complete the contact details form using only payload-backed customer values",
        () => fillContactAndAdvance(page, payload),
        /first name|last name|date of birth|hear about us|privacy policy/i,
      );
      done(12); log(12, "Contact details submitted; progression verified");

      await completeStepWithRecovery(
        13,
        "Complete the service and delivery address step using only the supplied address",
        () => fillService(page, payload),
        /service address|delivery address|self care portal/i,
      );
      done(13); log(13, "Service/delivery step submitted; progression verified");

      await completeStepWithRecovery(
        14,
        "Complete connection activation/transfer details from the payload and assignment-safe defaults",
        () => fillConnection(page, payload),
        /process order|current provider|avc|new connection|transfer connection/i,
      );
      done(14); log(14, "Connection details submitted; progression verified");

      await declineDonationAndAdvance(page);
      done(15); log(15, "Donation step cleared; validating checkout summary");

      await verifyOrderSummary(page, payload);
      log(15, "Order summary verified; entering guarded payment boundary");
      sensitiveMode = true;
      const payResult = await executePayment(page, { jobId, cardRef: payload.payment.cardRef, nameOnCard: payload.payment.nameOnCard });
      log(16, "Payment fields filled by isolated executor", { last4: payResult.last4 });
      await checkAllVisible(page);
      const pay = page.locator("button, a, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: /pay now/i }).first();
      if (!(await pay.count())) {
        await humanResolveEscalation(16, "Final Pay Now control is missing. Resolve only the page/UI issue manually; do not submit payment yourself.");
        const retryPay = page.locator("button, a, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: /pay now/i }).first();
        if (!(await retryPay.count())) throw new Escalation("Final Pay Now control still missing after human recovery");
        await clickAction(retryPay); done(16);
      } else {
        await clickAction(pay); done(16);
      }


      const modal = page.getByRole("dialog").first();
      if (await modal.count()) {
        const checks = modal.locator('input[type="checkbox"]');
        for (let index = 0; index < (await checks.count()); index += 1) await checks.nth(index).check();
        const modalPay = modal.locator("button, a, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: /pay now/i }).first();
        if (!(await modalPay.count())) throw new Escalation("Confirmation Pay Now missing; guarded step will not heal");
        await clickAction(modalPay);
      }
      done(17);
      transactionId = await handle3dsAndTransaction(page); done(18); done(19);
      if (!/payment|card number|security code|cvv/i.test(await page.locator("body").innerText())) {
        sensitiveMode = false;
        await page.screenshot({ path: path.join(evidenceDir, `${transactionId}.png`), fullPage: true });
      }
      return "ok";
    };

    let orderStatus: "ok" | "checkoutBounce" = "checkoutBounce";
    for (let attempt = 1; attempt <= 3 && orderStatus === "checkoutBounce"; attempt += 1) {
      if (attempt > 1) {
        await resetSession();
        let navigated = false;
        for (let navAttempt = 1; navAttempt <= 3 && !navigated; navAttempt += 1) {
          try { await page.goto(payload.portal.url, { waitUntil: "domcontentloaded", timeout: 30_000 }); navigated = true; }
          catch { await page.waitForTimeout(2000); }
        }
        if (!navigated) continue;
        await page.waitForTimeout(4000);
      }
      orderStatus = await runOrder();
      if (orderStatus === "checkoutBounce") log(9, `Checkout bounce on attempt ${attempt}; retrying`, { url: page.url() });
    }
    if (orderStatus === "checkoutBounce") throw new Error("Order Now did not reach checkout after retries");
    const report = makeReport("success", transactionId); await writeReport(report); await leakScan(evidenceDir); return report;
  } catch (error) {
    const escalated = error instanceof Escalation;
    const reason = error instanceof Error ? error.message : String(error);
    const report = makeReport(escalated ? "escalated" : "failed", undefined, reason);
    if (!sensitiveMode) await page.screenshot({ path: path.join(evidenceDir, "failure.png"), fullPage: true }).catch(() => undefined);
    await writeReport(report); await leakScan(evidenceDir); return report;
  } finally {
    await context.close(); await browser.close();
  }
}
