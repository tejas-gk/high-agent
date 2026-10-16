import type { Page } from "playwright";

import { resolveCard } from "./vault";
import { isApprovedPortalHost } from "./portal-config";

const TILL_ORIGINS = (process.env.APPROVED_TILL_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

export async function executePayment(
  page: Page,
  args: { jobId: string; cardRef: string; nameOnCard: string },
) {
  const host = new URL(page.url()).hostname;

  if (!isApprovedPortalHost(host)) {
    throw new Error(`Unapproved portal origin: ${host}`);
  }

  const card = await resolveCard(args.cardRef, args.jobId);

  try {
    await fillFirst(page, [/name on card/i], args.nameOnCard);
    await fillFirst(
      page,
      [/expiry/i],
      `${card.expiryMonth}/${card.expiryYear}`,
    );

    const deadline = Date.now() + 60_000;
    let numberDone = false;
    let cvvDone = false;

    while (Date.now() < deadline && (!numberDone || !cvvDone)) {
      for (const frame of page.frames()) {
        let hostname = "";

        try {
          hostname = new URL(frame.url()).hostname;
        } catch {
          continue;
        }

        if (!hostname) {
          continue;
        }

        if (!TILL_ORIGINS.includes(new URL(frame.url()).origin)) {
          continue;
        }

        const number = frame
          .locator(
            'input[autocomplete="cc-number"],input[name*="cardnumber" i],input[name*="card-number" i]',
          )
          .first();

        if (!numberDone && (await number.count())) {
          await number.fill(card.pan);
          numberDone = true;
          continue;
        }

        const cvv = frame
          .locator(
            'input[autocomplete="cc-csc"],input[name*="cvv" i],input[name*="cvc" i]',
          )
          .first();

        if (!cvvDone && (await cvv.count())) {
          await cvv.fill(card.cvv);
          cvvDone = true;
        }
      }

      if (!numberDone || !cvvDone) {
        await page.waitForTimeout(500);
      }
    }

    if (!numberDone || !cvvDone) {
      throw new Error(
        "Approved payment iframe did not become available within 60s; verify APPROVED_TILL_ORIGINS",
      );
    }

    return { ok: true, last4: card.last4 };
  } finally {
    card.pan = "";
    card.cvv = "";
  }
}

async function fillFirst(page: Page, names: RegExp[], value: string) {
  for (const name of names) {
    const byLabel = page.getByLabel(name).first();
    if (await byLabel.count()) {
      await byLabel.fill(value);
      return;
    }

    const byPlaceholder = page.getByPlaceholder(name).first();
    if (await byPlaceholder.count()) {
      await byPlaceholder.fill(value);
      return;
    }
  }

  throw new Error(`Field not found: ${names[0]}`);
}
