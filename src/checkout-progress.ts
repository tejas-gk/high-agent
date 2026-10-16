import type { Page } from "playwright";
import type { JobPayload } from "./payload";
import { clickAction, fillVerified } from "./runner-helpers";

async function visibleAction(page: Page, pattern: RegExp) {
  const actions = page.locator("button, a, [role='button'], input[type='submit'], input[type='button']");
  for (let i = 0; i < (await actions.count()); i += 1) {
    const action = actions.nth(i);
    if (!(await action.isVisible().catch(() => false))) continue;
    const text = `${await action.innerText().catch(() => "")} ${await action.getAttribute("value").catch(() => "")}`.trim();
    if (pattern.test(text)) return action;
  }
  return null;
}

async function waitForPageChange(page: Page, before: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const now = `${page.url()}|${(await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 1200)}`;
    if (now !== before) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/** Fill contact details and advance exactly one checkout step. Never repeatedly
 * click a generic Next button because Tangerine can keep the same URL across
 * several forms, which previously caused the runner to cycle/skip pages. */
export async function fillContactAndAdvance(page: Page, payload: JobPayload): Promise<void> {
  const c = payload.customer;
  const title = page.locator("#salutation").filter({ visible: true }).first();
  if (await title.count()) {
    const options = await title.locator("option").allTextContents();
    const match = options.find((x) => x.trim().toLowerCase() === c.title.trim().toLowerCase());
    if (match) await title.selectOption({ label: match });
  }

  const fields: Array<[string, string]> = [["#fname", c.firstName], ["#lname", c.lastName], ["#mobile", c.phone]];
  for (const [selector, value] of fields) {
    const field = page.locator(selector).filter({ visible: true }).first();
    if (await field.count()) await fillVerified(page, field, value, 20_000);
  }

  const dob = page.locator("#dob").filter({ visible: true }).first();
  if (await dob.count()) {
    await dob.fill("").catch(() => undefined);
    await dob.pressSequentially(c.dateOfBirth, { delay: 60 });
  }

  const hear = page.locator("#hear_about_us").filter({ visible: true }).first();
  if (await hear.count()) {
    const options = await hear.locator("option").allTextContents();
    const other = options.find((x) => /other/i.test(x));
    if (other) await hear.selectOption({ label: other });
  }

  const privacy = page.locator("input[name='read_policy']").filter({ visible: true }).first();
  if (await privacy.count() && !(await privacy.isChecked().catch(() => false))) await privacy.check({ force: true });

  const next = await visibleAction(page, /^(next|continue)\b/i);
  if (!next) throw new Error("Contact details Next control not found");
  const before = `${page.url()}|${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 1200)}`;
  await clickAction(next);
  if (!(await waitForPageChange(page, before))) throw new Error("Contact details Next did not advance; validation or portal state blocked progression");
}

/** Step 15. The donation page shown by Tangerine has a plain orange Next button.
 * Decline when a No option exists, click one visible Next, and verify the page
 * actually changes before payment logic is allowed to start. */
export async function declineDonationAndAdvance(page: Page): Promise<void> {
  const body = await page.locator("body").innerText().catch(() => "");
  if (!/donat|small change big change|give more back/i.test(body)) return;

  const radios = page.locator('input[type="radio"]:visible');
  for (let i = 0; i < (await radios.count()); i += 1) {
    const radio = radios.nth(i);
    const value = `${await radio.getAttribute("value").catch(() => "")} ${await radio.getAttribute("id").catch(() => "")}`;
    if (/\bno\b|decline|false|0/i.test(value)) {
      await radio.check({ force: true }).catch(() => undefined);
      break;
    }
  }

  const next = await visibleAction(page, /^(next|continue)\b/i);
  if (!next) throw new Error("Donation page Next control not found");
  const before = `${page.url()}|${body.replace(/\s+/g, " ").slice(0, 1200)}`;
  await next.scrollIntoViewIfNeeded().catch(() => undefined);
  await clickAction(next);
  if (!(await waitForPageChange(page, before, 15_000))) throw new Error("Donation Next did not advance to payment/summary");
}
