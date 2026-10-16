import type { Page } from "playwright";

export type JourneyStage =
  | "address"
  | "plan"
  | "checkout-login"
  | "contact"
  | "service-address"
  | "connection"
  | "donation"
  | "payment"
  | "three-d-secure"
  | "confirmation"
  | "unknown";

export type JourneyState = {
  stage: JourneyStage;
  step: number;
  signature: string;
  url: string;
};

export async function detectJourneyState(page: Page): Promise<JourneyState> {
  const url = page.url();
  const text = (await page.locator("body").innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 7000);
  const visible = async (selector: string) =>
    (await page.locator(selector).filter({ visible: true }).count().catch(() => 0)) > 0;

  let stage: JourneyStage = "unknown";
  let step = 0;

  if (/TRANSACTION\s*(?:ID|NUMBER)|ORDER\s*(?:CONFIRMED|NUMBER)|THANK YOU.*ORDER/i.test(text)) {
    stage = "confirmation"; step = 20;
  } else if (/3.?D SECURE|AUTHENTICATED.*ECI\s*05/i.test(text)) {
    stage = "three-d-secure"; step = 18;
  } else if ((await visible('#card_number, input[autocomplete="cc-number"], input[name*="cardnumber" i]')) ||
    /NAME ON CARD|PAYMENT DETAILS|PAY NOW/i.test(text)) {
    stage = "payment"; step = 16;
  } else if ((await visible('input[name*="donation" i]')) || /SMALL CHANGE BIG CHANGE|WOULD YOU LIKE TO (?:ADD|MAKE).*DONATION/i.test(text)) {
    stage = "donation"; step = 15;
  } else if ((await visible('input[name="new_or_transfer"], input[name*="avc" i], select[name*="provider" i]')) ||
    /PROCESS ORDER(?: AND)? PAY|CURRENT PROVIDER/i.test(text)) {
    stage = "connection"; step = 14;
  } else if ((await visible('#self_care_portal, input[name*="self_care" i]')) || /SELF CARE PORTAL|SERVICE ADDRESS|DELIVERY ADDRESS/i.test(text)) {
    stage = "service-address"; step = 13;
  } else if ((await visible('#fname, #salutation, #dob')) || (/CONTACT DETAILS/i.test(text) && !/ID VERIFICATION|LICEN[CS]E NUMBER/i.test(text))) {
    stage = "contact"; step = 12;
  } else if (/checkout\/login/i.test(url) || (await visible('input[type="email"], input[name*="email" i]'))) {
    stage = "checkout-login"; step = 11;
  } else if (/#order-speeds/i.test(url) || /CHOOSE PLAN|BUILD YOUR PLAN|NBN PLAN/i.test(text)) {
    stage = "plan"; step = 5;
  } else if (await visible('#autocomplete, #autocomplete-stickysearch')) {
    stage = "address"; step = 2;
  }

  const fields = await page.locator("input:visible,select:visible,textarea:visible").evaluateAll((els) =>
    els.slice(0, 20).map((el) => {
      const input = el as HTMLInputElement;
      return [el.tagName, input.type || "", input.name || "", input.id || "", input.checked ? "1" : "0"].join(":");
    }),
  ).catch(() => [] as string[]);
  const pathname = (() => { try { const u = new URL(url); return u.pathname + u.hash; } catch { return url; } })();
  return { stage, step, url, signature: [stage, pathname, fields.join("|")].join("::") };
}
