import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { executePayment } from "./payment";
import { installMutationLayer } from "./mutation";
import { leakScan } from "./security";
import type { JobPayload } from "./payload";
import type { HealEvent, RunReport, TraceEvent } from "./types";
import {
  activePopupId,
  assertNbnPlanInCart,
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
  waitForPlanInCart,
} from "./runner-helpers";

export type RunnerOptions = {
  jobId: string;
  payload: JobPayload;
  mutate: boolean;
  emit: (event: TraceEvent) => void;
};

export async function runAgent({
  jobId,
  payload,
  mutate,
  emit,
}: RunnerOptions): Promise<RunReport> {
  const started = Date.now();
  const completed: number[] = [];
  const heals: HealEvent[] = [];
  const modelBudget = { used: 0, max: 6 };
  const evidenceDir = path.resolve("artifacts", jobId);
  const previewPath = path.join(evidenceDir, "live.png");

  await fs.mkdir(evidenceDir, { recursive: true });

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
  });
  const context = await browser.newContext();
  let page = await context.newPage();

  if (mutate) {
    await installMutationLayer(page);
  }

  const resetSession = async () => {
    await page.close().catch(() => undefined);
    await context.clearCookies().catch(() => undefined);
    page = await context.newPage();
    if (mutate) {
      await installMutationLayer(page);
    }
  };

  const capturePreview = async () => {
    try {
      await page.screenshot({
        path: previewPath,
        fullPage: false,
        animations: "disabled",
      });
    } catch (error) {
      console.warn(`[job:${jobId}] preview capture failed`, error);
    }
  };

  const log = (
    step: number,
    message: string,
    data?: Record<string, unknown>,
  ) => {
    const entry: TraceEvent = {
      at: new Date().toISOString(),
      level: "info",
      step,
      message,
      data,
    };

    console.log(
      `[job:${jobId}] step ${step}: ${message}`,
      data ? JSON.stringify(data) : "",
    );
    emit(entry);
    void capturePreview();
  };

  const done = (step: number) => {
    if (!completed.includes(step)) {
      completed.push(step);
    }
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
    await fs.writeFile(
      path.join(evidenceDir, "report.json"),
      JSON.stringify(report, null, 2),
    );
  };

  try {
    await page.goto(payload.portal.url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    if (!page.url().includes("test-tangerine.hipeely.com")) {
      throw new Error("Portal URL did not match approved test environment");
    }

    done(1);
    log(1, "Portal opened");

    const selectAndOrder = async (): Promise<boolean> => {
      await typeAddress(page, payload.connectionAddress.mainAddress.fullAddress);
      done(2);
      log(2, "Address entered");

      const selected = await chooseAddressSuggestion(
        page,
        payload.connectionAddress.mainAddress.fullAddress,
      );
      if (!selected) {
        const manual = page
          .locator("button, a, [role='button']")
          .filter({
            hasText:
              /enter.*address.*manually|check your address manually|can't find your address/i,
          })
          .first();
        if (!(await manual.isVisible().catch(() => false))) {
          throw new Escalation("Address suggestion unavailable; manual address path not found");
        }
        await clickAction(manual);
        await fillManual(page, payload);
      }

      // The portal runs an address check behind a "Hold tight!" spinner and then
      // raises a result modal. Wait for it, then confirm the tech type.
      await waitForAddressResult(page);
      const techResult = await resolvePopup(
        page,
        /build your plan|see nbn|see other plans|continue with nbn|pre-?order/i,
      );
      done(3);
      log(3, "Address confirmed", { techResult });

      await settlePopups(page);
      done(4);

      // Plan + optional router must both survive in the sticky cart. The portal
      // has a known bug where selecting a modem can reset the cart to $0.00, so
      // select the pair together and retry the whole selection if it goes stale.
      let cartReady = false;
      for (let attempt = 1; attempt <= 3 && !cartReady; attempt += 1) {
        await selectPlan(page, payload.plan.name);
        await settlePopups(page);

        if (payload.addOns.router.enabled) {
          await selectRouter(page, payload.addOns.router.model || "BYO Modem");
        }

        try {
          await waitForPlanInCart(page, payload.plan.name, 6_000);
          await assertNbnPlanInCart(page, payload.plan.name);
          cartReady = true;
        } catch (error) {
          log(7, `Cart not ready after plan/router (attempt ${attempt})`, {
            error: String(error),
          });
        }
      }

      if (!cartReady) {
        throw new Error(
          "Sticky cart did not retain the NBN plan after selecting the router",
        );
      }

      done(5);
      done(6);
      if (payload.addOns.router.enabled) {
        done(7);
      }

      await assertNbnPlanInCart(page, payload.plan.name);
      done(8);

      await clickOrderNow(page);

      const popupId = await activePopupId(page);
      const onCheckout = /checkout|login/i.test(page.url());
      log(9, "Order Now clicked", { url: page.url(), popupId, onCheckout });
      return onCheckout;
    };

    // Headed runs occasionally bounce from /checkout back to the home page, or
    // fail to navigate at all, when the server session commits late or the BYO
    // modem add-to-cart poisons the cart. Start a clean session and rebuild the
    // order, retrying a few times before giving up.
    let atCheckout = false;
    for (let attempt = 1; attempt <= 5 && !atCheckout; attempt += 1) {
      if (attempt > 1) {
        await resetSession();
        await page.goto(payload.portal.url, {
          waitUntil: "domcontentloaded",
          timeout: 60_000,
        });
        await page.waitForTimeout(4000);
      }

      atCheckout = await selectAndOrder();

      if (!atCheckout) {
        log(9, `Checkout bounce on attempt ${attempt}; retrying`, {
          url: page.url(),
        });
      }
    }

    if (!atCheckout) {
      throw new Error("Order Now did not reach checkout after retries");
    }

    done(9);
    done(10);

    const email = page
      .locator('#email, input[type="email"], input[name*="email" i]')
      .filter({ visible: true })
      .first();
    if (!(await email.count())) {
      throw new Escalation("Checkout email field not found");
    }
    await fillVerified(page, email, payload.customer.email);

    const emailNext = page
      .locator("button, a, input[type='submit'], input[type='button']")
      .filter({ hasText: /next/i })
      .filter({ visible: true })
      .first();
    if (!(await emailNext.count())) {
      throw new Escalation("Checkout Next control not found");
    }
    await clickAction(emailNext);
    await page.waitForTimeout(1500);

    const otpField = page.locator(
      'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i]',
    );
    if (await otpField.count()) {
      throw new Escalation("Email OTP requires human submission");
    }

    done(11);

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

      if (await no.count()) {
        await no.check();
      }

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
    const payResult = await executePayment(page, {
      jobId,
      cardRef: payload.payment.cardRef,
      nameOnCard: payload.payment.nameOnCard,
    });

    log(16, "Payment fields filled by isolated executor", {
      last4: payResult.last4,
    });
    await checkAllVisible(page);

    const pay = page
      .locator("button, a, [role='button'], input[type='submit'], input[type='button']")
      .filter({ hasText: /pay now/i })
      .first();
    if (!(await pay.count())) {
      throw new Escalation(
        "Final Pay Now control missing; guarded step will not heal",
      );
    }

    await clickAction(pay);
    done(16);

    const modal = page.getByRole("dialog").first();
    if (await modal.count()) {
      const checks = modal.locator('input[type="checkbox"]');

      for (let index = 0; index < (await checks.count()); index += 1) {
        await checks.nth(index).check();
      }

      const modalPay = modal
        .locator("button, a, [role='button'], input[type='submit'], input[type='button']")
        .filter({ hasText: /pay now/i })
        .first();
      if (!(await modalPay.count())) {
        throw new Escalation(
          "Confirmation Pay Now missing; guarded step will not heal",
        );
      }

      await clickAction(modalPay);
    }

    done(17);

    const transactionId = await handle3dsAndTransaction(page);
    done(18);
    done(19);

    if (
      !/payment|card number|security code|cvv/i.test(
        await page.locator("body").innerText(),
      )
    ) {
      await page.screenshot({
        path: path.join(evidenceDir, `${transactionId}.png`),
        fullPage: true,
      });
    }

    const report = makeReport("success", transactionId);
    await writeReport(report);
    await leakScan(evidenceDir);

    return report;
  } catch (error) {
    const escalated = error instanceof Escalation;
    const reason = error instanceof Error ? error.message : String(error);
    const report = makeReport(
      escalated ? "escalated" : "failed",
      undefined,
      reason,
    );

    try {
      await page.screenshot({
        path: path.join(evidenceDir, "failure.png"),
        fullPage: true,
      });
    } catch {
      // Page may already be closed.
    }

    await writeReport(report);
    await leakScan(evidenceDir);
    return report;
  } finally {
    await context.close();
    await browser.close();
  }
}
