import type { Page } from "playwright";
import type { JobPayload } from "./payload";
import { clickAction, fillVerified } from "./runner-helpers";

const NEXT_PATTERN = /^(next|continue|proceed)\b/i;

async function visibleAction(page: Page, pattern: RegExp) {
  const actions = page.locator("button, a, [role='button'], input[type='submit'], input[type='button']");
  // Two passes: exact anchored match first, then substring — so "Proceed"
  // (mutated Continue/Next) and "Agree and Continue" both resolve without AI.
  for (const anchored of [true, false]) {
    for (let i = 0; i < (await actions.count()); i += 1) {
      const action = actions.nth(i);
      if (!(await action.isVisible().catch(() => false))) continue;
      if (await action.isDisabled().catch(() => false)) continue;
      const text = `${await action.innerText().catch(() => "")} ${await action.getAttribute("value").catch(() => "")} ${await action.getAttribute("aria-label").catch(() => "")}`.trim().replace(/\s+/g, " ");
      const hit = anchored ? pattern.test(text) : new RegExp(pattern.source.replace(/^\^/, ""), pattern.flags).test(text);
      if (hit) return action;
    }
  }
  return null;
}

async function pageSignature(page: Page) {
  return `${page.url()}|${(await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 1600)}`;
}

async function waitUntil(page: Page, predicate: () => Promise<boolean>, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate().catch(() => false)) return true;
    await page.waitForTimeout(300);
  }
  return false;
}

/**
 * Fill a field with real keystrokes and confirm the value stuck. The portal's
 * inputmask/datepicker can reformat or clear programmatic values, so we type,
 * verify, and on failure dispatch an authoritative inputmask-compatible event
 * sequence + blur. Returns true only when the field holds the value.
 */
async function fillSticky(page: Page, locator: import("playwright").Locator, value: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await locator.click().catch(() => undefined);
    await locator.press("ControlOrMeta+a").catch(() => undefined);
    await locator.press("Backspace").catch(() => undefined);
    await locator.pressSequentially(value, { delay: 40 }).catch(() => undefined);
    await page.waitForTimeout(150);
    if ((await locator.inputValue().catch(() => "")).trim() === value.trim()) return true;
    await locator.fill(value).catch(() => undefined);
    await page.waitForTimeout(150);
    if ((await locator.inputValue().catch(() => "")).trim() === value.trim()) return true;
  }
  // Authoritative fallback: set + emit the events inputmask/validator listen for.
  await locator.evaluate((el: HTMLInputElement, v: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }, value).catch(() => undefined);
  await page.waitForTimeout(150);
  return (await locator.inputValue().catch(() => "")).trim() === value.trim();
}

export async function fillContactAndAdvance(page: Page, payload: JobPayload): Promise<void> {
  const c = payload.customer;

  // Wait for the contact form to actually render before filling.
  await page.locator("#fname, #salutation").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => undefined);

  const title = page.locator("#salutation").filter({ visible: true }).first();
  if (await title.count()) {
    const options = await title.locator("option").allTextContents();
    const match = options.find((x) => x.trim().toLowerCase() === c.title.trim().toLowerCase());
    if (match) await title.selectOption({ label: match }).catch(() => undefined);
  }

  const fields: Array<[string, string]> = [["#fname", c.firstName], ["#lname", c.lastName], ["#mobile", c.phone]];
  for (const [selector, value] of fields) {
    const field = page.locator(selector).filter({ visible: true }).first();
    if (await field.count()) {
      const ok = await fillSticky(page, field, value);
      if (!ok) await fillVerified(page, field, value, 5_000).catch(() => undefined);
    }
  }

  const dob = page.locator("#dob").filter({ visible: true }).first();
  if (await dob.count()) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (await fillSticky(page, dob, c.dateOfBirth)) break;
      await page.waitForTimeout(300);
    }
  }

  const hear = page.locator("#hear_about_us").filter({ visible: true }).first();
  if (await hear.count()) {
    const options = await hear.locator("option").allTextContents();
    const other = options.find((x) => /other/i.test(x));
    if (other) await hear.selectOption({ label: other }).catch(() => undefined);
  }

  const privacy = page.locator("input[name='read_policy']").filter({ visible: true }).first();
  if (await privacy.count() && !(await privacy.isChecked().catch(() => false))) await privacy.check({ force: true }).catch(() => undefined);

  const next = await visibleAction(page, NEXT_PATTERN);
  if (!next) throw new Error("Contact details Next control not found (looked for Next/Continue/Proceed)");

  // Re-assert the date of birth immediately before each submit: the portal's
  // inputmask/datepicker can clear it when other fields are touched, which
  // surfaces as "Please enter your date of birth" and blocks Next.
  let advanced = false;
  for (let attempt = 0; attempt < 4 && !advanced; attempt += 1) {
    const dobNow = page.locator("#dob").filter({ visible: true }).first();
    if ((await dobNow.count()) && (await dobNow.inputValue().catch(() => "")).trim() === "") {
      await fillSticky(page, dobNow, c.dateOfBirth);
    }
    const before = await pageSignature(page);
    await clickAction(next);
    advanced = await waitUntil(page, async () => (await pageSignature(page)) !== before, 8_000);
  }
  if (!advanced) {
    throw new Error("Contact details Next did not advance; validation or portal state blocked progression");
  }
}

function donationPage(text: string) {
  return /would you like to add a \$?1 donation|small change big change|\bdonation\b/i.test(text);
}

async function chooseDonationNo(page: Page): Promise<boolean> {
  // Prefer the semantic label because the portal can use opaque radio values.
  const labelledNo = page.getByLabel(/^no$/i).filter({ visible: true }).first();
  if (await labelledNo.count()) {
    await labelledNo.check({ force: true }).catch(() => undefined);
    if (await labelledNo.isChecked().catch(() => false)) return true;
  }

  const labels = page.locator("label:visible");
  for (let i = 0; i < (await labels.count()); i += 1) {
    const label = labels.nth(i);
    const text = (await label.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (!/^no\b/i.test(text)) continue;
    await label.click({ force: true }).catch(() => undefined);
    return true;
  }

  const radios = page.locator('input[type="radio"]:visible');
  for (let i = 0; i < (await radios.count()); i += 1) {
    const radio = radios.nth(i);
    const value = `${await radio.getAttribute("value").catch(() => "")} ${await radio.getAttribute("id").catch(() => "")} ${await radio.getAttribute("name").catch(() => "")}`;
    if (/\bno\b|decline|false|0/i.test(value)) {
      await radio.check({ force: true }).catch(() => undefined);
      if (await radio.isChecked().catch(() => false)) return true;
    }
  }
  return false;
}

/** Step 15: decline the optional donation and do not return until the donation
 * screen has genuinely disappeared. A small validation/selection repaint is not
 * sufficient evidence that checkout advanced. */
export async function declineDonationAndAdvance(page: Page): Promise<void> {
  let body = await page.locator("body").innerText().catch(() => "");
  if (!donationPage(body)) return;

  if (!(await chooseDonationNo(page))) {
    throw new Error("Donation page detected but the No option could not be selected");
  }

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const next = await visibleAction(page, NEXT_PATTERN);
    if (!next) throw new Error("Donation page Next control not found (looked for Next/Continue/Proceed)");
    await next.scrollIntoViewIfNeeded().catch(() => undefined);
    await clickAction(next);

    const leftDonation = await waitUntil(page, async () => {
      const current = await page.locator("body").innerText().catch(() => "");
      return !donationPage(current);
    }, 8_000);
    if (leftDonation) return;

    // The first click may only surface client-side validation. Reassert No and
    // retry the same guarded step, but never pretend Step 15 completed while the
    // donation question remains visible.
    await chooseDonationNo(page);
    await page.waitForTimeout(300);
    body = await page.locator("body").innerText().catch(() => body);
  }

  throw new Error(`Donation Next did not leave donation page: ${body.replace(/\s+/g, " ").slice(0, 500)}`);
}
