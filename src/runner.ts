import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { recoverUnexpectedPage } from "./healing";
import { executePayment } from "./payment";
import { installMutationLayer } from "./mutation";
import { leakScan } from "./security";
import type { JobPayload } from "./payload";
import type { HealEvent, HumanRequestType, RunReport, TraceEvent } from "./types";
import {
  activePopupId,
  checkAllVisible,
  chooseAddressSuggestion,
  clickAction,
  clickOrderNow,
  Escalation,
  fillConnection,
  fillContact,
  fillManual,
  fillService,
  fillVerified,
  findAction,
  handle3dsAndTransaction,
  resolvePopup,
  selectPlan,
  selectRouter,
  settlePopups,
  typeAddress,
  verifyOrderSummary,
  waitForAddressResult,
} from "./runner-helpers";

export type RunnerOptions = {
  jobId: string;
  payload: JobPayload;
  mutate: boolean;
  emit: (event: TraceEvent) => void;
  requestHumanInput?: (request: {
    type: HumanRequestType;
    step: number;
    message: string;
  }) => Promise<string>;
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

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== "false" });
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
    // Once payment begins, keep the last safe preview. Never screenshot card fields.
    if (sensitiveMode) return;
    try {
      await page.screenshot({ path: previewPath, fullPage: false, animations: "disabled" });
    } catch (error) {
      console.warn(`[job:${jobId}] preview capture failed`, error);
    }
  };

  const log = (step: number, message: string, data?: Record<string, unknown>) => {
    const entry: TraceEvent = { at: new Date().toISOString(), level: "info", step, message, data };
    console.log(`[job:${jobId}] step ${step}: ${message}`, data ? JSON.stringify(data) : "");
    emit(entry);
    void capturePreview();
  };

  const done = (step: number) => {
    if (!completed.includes(step)) completed.push(step);
  };

  const makeReport = (
    status: "success" | "failed" | "escalated",
    transactionId?: string,
    failureReason?: string,
  ): RunReport => ({
    jobId,
    status,
    transactionId,
    completedSteps: completed,
    heals,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    modelCalls: modelBudget.used,
    failureReason,
    evidenceDir,
  });

  const writeReport = async (report: RunReport) => {
    await fs.writeFile(path.join(evidenceDir, "report.json"), JSON.stringify(report, null, 2));
  };

  const ensureExpectedState = async (step: number, goal: string, selector: string) => {
    if (await page.locator(selector).filter({ visible: true }).count()) return;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const recovered = await recoverUnexpectedPage(page, {
          step,
          goal,
          expected: selector,
          modelBudget,
          heals,
        });
        if (recovered && (await page.locator(selector).filter({ visible: true }).count())) {
          log(step, "AI re-planned around an unexpected page and verified recovery");
          return;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (reason.startsWith("HUMAN_REQUIRED:")) {
          throw new Escalation(reason.replace("HUMAN_REQUIRED:", "Human handoff required: "));
        }
        throw new Escalation(reason);
      }
    }

    throw new Escalation(`Could not safely reach expected state: ${goal}`);
  };

  try {
    await page.goto(payload.portal.url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!page.url().includes("test-tangerine.hipeely.com")) {
      throw new Error("Portal URL did not match approved test environment");
    }

    done(1);
    log(1, "Portal opened");

    const selectAndOrder = async (): Promise<boolean> => {
      await typeAddress(page, payload.connectionAddress.mainAddress.fullAddress);
      done(2);
      log(2, "Address entered");

      const selected = await chooseAddressSuggestion(page, payload.connectionAddress.mainAddress.fullAddress);
      if (!selected) {
        const manual = page
          .locator("button, a, [role='button']")
          .filter({ hasText: /enter.*address.*manually|check your address manually|can't find your address/i })
          .first();
        if (!(await manual.isVisible().catch(() => false))) {
          throw new Escalation("Address suggestion unavailable; manual address path not found");
        }
        await clickAction(manual);
        await fillManual(page, payload);
      }

      await waitForAddressResult(page);
      const techResult = await resolvePopup(page, /build your plan|see nbn|see other plans|continue with nbn|pre-?order/i);
      done(3);
      log(3, "Address confirmed", { techResult });

      await settlePopups(page);
      done(4);

      await selectPlan(page, payload.plan.name);
      await settlePopups(page);

      if (payload.addOns.router.enabled) {
        await selectRouter(page, payload.addOns.router.model || "BYO Modem");
        await settlePopups(page);
      }

      done(5);
      done(6);
      if (payload.addOns.router.enabled) done(7);
      done(8);

      await clickOrderNow(page);
      const popupId = await activePopupId(page);
      const onCheckout = /checkout|login/i.test(page.url());
      log(9, "Order Now clicked", { url: page.url(), popupId, onCheckout });
      return onCheckout;
    };

    let transactionId: string | undefined;

    const runOrder = async (): Promise<"ok" | "checkoutBounce"> => {
      if (!(await selectAndOrder())) return "checkoutBounce";

      const email = page
        .locator('#email, input[type="email"], input[name*="email" i]')
        .filter({ visible: true })
        .first();
      if (!(await email.count())) throw new Escalation("Checkout email field not found");
      await fillVerified(page, email, payload.customer.email);

      const emailNext = page
        .locator("button, a, input[type='submit'], input[type='button']")
        .filter({ hasText: /next/i })
        .filter({ visible: true })
        .first();
      if (!(await emailNext.count())) throw new Escalation("Checkout Next control not found");
      await clickAction(emailNext);

      let navigated = false;
      const emailDeadline = Date.now() + 12_000;
      while (Date.now() < emailDeadline && !navigated) {
        if (
          !/checkout\/login/i.test(page.url()) ||
          (await page.locator("#fname, input[name='fname' i], #salutation").count())
        ) {
          navigated = true;
          break;
        }
        await page.waitForTimeout(400);
      }

      const stillOnLogin = /checkout\/login/i.test(page.url());
      const otpField = page
        .locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i]')
        .filter({ visible: true })
        .first();

      if (stillOnLogin && (await otpField.count())) {
        if (!requestHumanInput) throw new Escalation("Email OTP requires human submission");

        log(11, "Human handoff: waiting for email OTP; browser session preserved");
        const otp = await requestHumanInput({
          type: "EMAIL_OTP",
          step: 11,
          message: "Check the verification email, enter the one-time code here, then the agent will continue automatically.",
        });

        await otpField.fill(otp);
        const submitOtp = page
          .locator("button, input[type='submit'], input[type='button']")
          .filter({ hasText: /verify|submit|continue|next/i })
          .filter({ visible: true })
          .first();
        if (!(await submitOtp.count())) throw new Escalation("OTP submit control not found after human handoff");

        await clickAction(submitOtp);
        await page.waitForTimeout(800);
        const otpStillVisible = await otpField.isVisible().catch(() => false);
        if (otpStillVisible && /checkout\/login/i.test(page.url())) {
          throw new Escalation("OTP was not accepted; refusing to guess or retry automatically");
        }
        log(11, "Human handoff complete; resumed same browser session");
      }

      done(11);

      // The normal path is deterministic. If the portal inserts/reorders a harmless
      // interstitial, Sarvam gets the redacted observation and may choose only a
      // safe navigation/dismiss action. New required customer values escalate.
      await ensureExpectedState(12, "Reach the contact details form", "#fname, input[name='fname' i], #salutation");
      await fillContact(page, payload);
      done(12);

      await fillService(page, payload);
      done(13);

      await fillConnection(page, payload);
      done(14);

      if (await page.getByText(/donat/i).count()) {
        const no = page
          .getByLabel(/^no$/i)
          .first()
          .or(page.locator('input[type="radio"][value="no" i]').first());
        if (await no.count()) await no.check();

        const next = await findAction(page, {
          step: 15,
          intent: "Decline donation and continue to payment",
          names: ["Next", "Continue"],
          modelBudget,
          heals,
        });
        await clickAction(next);
      }

      done(15);

      const beforeSummary = await page.evaluate(() => ({
        url: location.href,
        body: document.body.innerText.replace(/\s+/g, " ").slice(0, 400),
      }));
      log(15, "Before order summary", beforeSummary);
      await verifyOrderSummary(page, payload);

      // From here on screenshots/previews are disabled. Card data exists only in
      // the isolated deterministic payment executor, never in AI observations.
      sensitiveMode = true;
      const payResult = await executePayment(page, {
        jobId,
        cardRef: payload.payment.cardRef,
        nameOnCard: payload.payment.nameOnCard,
      });
      log(16, "Payment fields filled by isolated executor", { last4: payResult.last4 });
      await checkAllVisible(page);

      const pay = page
        .locator("button, a, [role='button'], input[type='submit'], input[type='button']")
        .filter({ hasText: /pay now/i })
        .first();
      if (!(await pay.count())) throw new Escalation("Final Pay Now control missing; guarded step will not heal");

      await clickAction(pay);
      done(16);

      const modal = page.getByRole("dialog").first();
      if (await modal.count()) {
        const checks = modal.locator('input[type="checkbox"]');
        for (let index = 0; index < (await checks.count()); index += 1) await checks.nth(index).check();

        const modalPay = modal
          .locator("button, a, [role='button'], input[type='submit'], input[type='button']")
          .filter({ hasText: /pay now/i })
          .first();
        if (!(await modalPay.count())) throw new Escalation("Confirmation Pay Now missing; guarded step will not heal");
        await clickAction(modalPay);
      }

      done(17);
      transactionId = await handle3dsAndTransaction(page);
      done(18);
      done(19);

      // Re-enable evidence only after the transaction has completed and card UI
      // is no longer present. The final screenshot is named after transaction ID.
      if (!/payment|card number|security code|cvv/i.test(await page.locator("body").innerText())) {
        sensitiveMode = false;
        await page.screenshot({ path: path.join(evidenceDir, `${transactionId}.png`), fullPage: true });
      }

      return "ok";
    };

    let orderStatus: "ok" | "checkoutBounce" = "checkoutBounce";
    for (let attempt = 1; attempt <= 6 && orderStatus === "checkoutBounce"; attempt += 1) {
      if (attempt > 1) {
        await resetSession();
        let navigated = false;
        for (let navAttempt = 1; navAttempt <= 3 && !navigated; navAttempt += 1) {
          try {
            await page.goto(payload.portal.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            navigated = true;
          } catch {
            await page.waitForTimeout(2000);
          }
        }
        if (!navigated) continue;
        await page.waitForTimeout(4000);
      }

      orderStatus = await runOrder();
      if (orderStatus === "checkoutBounce") {
        log(9, `Checkout bounce on attempt ${attempt}; retrying`, { url: page.url() });
      }
    }

    if (orderStatus === "checkoutBounce") throw new Error("Order Now did not reach checkout after retries");

    const report = makeReport("success", transactionId);
    await writeReport(report);
    await leakScan(evidenceDir);
    return report;
  } catch (error) {
    const escalated = error instanceof Escalation;
    const reason = error instanceof Error ? error.message : String(error);
    const report = makeReport(escalated ? "escalated" : "failed", undefined, reason);

    // Failure screenshots are also suppressed if the run entered payment mode.
    if (!sensitiveMode) {
      try {
        await page.screenshot({ path: path.join(evidenceDir, "failure.png"), fullPage: true });
      } catch {
        // Page may already be closed.
      }
    }

    await writeReport(report);
    await leakScan(evidenceDir);
    return report;
  } finally {
    await context.close();
    await browser.close();
  }
}
