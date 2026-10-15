import fs from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

import { executePayment } from "./payment";
import { installMutationLayer } from "./mutation";
import { leakScan } from "./security";
import type { JobPayload } from "./payload";
import type { HealEvent, RunReport, TraceEvent } from "./types";
import {
  assertCartPositive,
  checkAllVisible,
  clickAction,
  dismissDialogs,
  Escalation,
  fillConnection,
  fillContact,
  fillManual,
  fillService,
  findAction,
  handle3dsAndTransaction,
  selectPlan,
  selectRouter,
  typeAddress,
  verifyOrderSummary,
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
  const page = await context.newPage();

  if (mutate) {
    await installMutationLayer(page);
  }

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

    await typeAddress(page, payload.connectionAddress.mainAddress.fullAddress);
    done(2);
    log(2, "Address entered");

    const suggestion = page
      .locator('[role="option"], li, button')
      .filter({ hasText: /ROCHESTER|MEADOW|6210/i })
      .first();

    if (await suggestion.count()) {
      await clickAction(suggestion);
    } else {
      const manual = page
        .locator("button, a, [role='button']")
        .filter({
          hasText:
            /enter.*address.*manually|check your address manually|can't find your address/i,
        })
        .first();

      if (
        (await manual.count()) &&
        (await manual.isVisible().catch(() => false))
      ) {
        await clickAction(manual);
        await fillManual(page, payload);
      }
    }

    done(3);
    await dismissDialogs(page);

    const build = await findAction(page, {
      step: 4,
      intent: "Build the NBN plan after confirming the address",
      names: ["Build Your Plan", "See plans", "available plans"],
      modelBudget,
      heals,
    });
    await clickAction(build);
    await page.waitForTimeout(1200);
    done(4);

    await selectPlan(page, payload.plan.name);
    done(5);
    await dismissDialogs(page);
    done(6);

    if (payload.addOns.router.enabled) {
      await selectRouter(page, payload.addOns.router.model || "BYO Modem");
      await assertCartPositive(page);
      done(7);
    }

    done(8);
    await assertCartPositive(page);

    const order = await findAction(page, {
      step: 9,
      intent: "Continue from selected NBN plan to checkout",
      names: ["Order Now", "Continue", "Checkout"],
      modelBudget,
      heals,
    });
    await clickAction(order);
    await page.waitForTimeout(1000);

    if (await page.getByText(/hold on/i).count()) {
      throw new Error(
        "Cart integrity alarm: router present without active plan",
      );
    }

    done(9);
    done(10);

    const email = page
      .getByLabel(/email/i)
      .first()
      .or(page.locator('input[type="email"]').first());
    await email.fill(payload.customer.email);

    const emailNext = await findAction(page, {
      step: 11,
      intent: "Continue after entering checkout email",
      names: ["Next", "Continue"],
      modelBudget,
      heals,
    });
    await clickAction(emailNext);
    await page.waitForTimeout(800);

    if (await page.getByText(/verification code|one.time|otp/i).count()) {
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
    const report = makeReport(
      escalated ? "escalated" : "failed",
      undefined,
      error instanceof Error ? error.message : String(error),
    );

    await writeReport(report);
    await leakScan(evidenceDir);
    return report;
  } finally {
    await context.close();
    await browser.close();
  }
}
