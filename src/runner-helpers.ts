import type { Page } from "playwright";

import { semanticLocator } from "./healing";
import type { JobPayload } from "./payload";
import type { HealEvent } from "./types";

export class Escalation extends Error { }

export async function clickAction(locator: import("playwright").Locator): Promise<void> {
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    // Normal click first so client-side validation runs; force + JS click as
    // fallbacks for restyled/overlaid controls.
    try {
        await locator.click({ timeout: 8000 });
        return;
    } catch { /* fall through to force */ }
    try {
        await locator.click({ force: true, timeout: 8000 });
        return;
    } catch {
        await locator.evaluate((element: HTMLElement) => {
            element.scrollIntoView({ block: "center", inline: "center" });
            (element as HTMLElement).click();
        });
    }
}

export async function findAction(
    page: Page,
    args: {
        step: number;
        intent: string;
        names: string[];
        modelBudget: { used: number; max: number };
        heals: HealEvent[];
    },
): Promise<import("playwright").Locator> {
    for (const name of args.names) {
        const candidate = page.locator(
            "button, a, [role='button'], input[type='submit'], input[type='button']",
        );

        const matches = candidate.filter({
            hasText: new RegExp(escapeRx(name), "i"),
        });
        const count = await matches.count();

        for (let index = 0; index < count; index += 1) {
            const locator = matches.nth(index);
            if (await locator.isVisible().catch(() => false)) {
                return locator;
            }
        }
    }

    await page.waitForTimeout(500);
    const recovered = await semanticLocator(page, {
        step: args.step,
        intent: args.intent,
        names: args.names,
        modelBudget: args.modelBudget,
    });

    if (recovered.heal) {
        args.heals.push(recovered.heal);
    }

    return recovered.locator;
}

export async function typeAddress(page: Page, value: string): Promise<void> {
    // Prefer the real, visible autocomplete. The `#delivery_address` input is a
    // hidden clone used by the manual-address modal and must be skipped.
    const candidates = page.locator(
        "#autocomplete, #autocomplete-stickysearch, input[placeholder*='address' i]",
    );
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
        const input = candidates.nth(index);
        if (!(await input.isVisible().catch(() => false))) continue;
        await typeIntoAutocomplete(page, input, value);
        return;
    }
    const textboxes = page.getByRole("textbox");
    for (let index = 0; index < (await textboxes.count()); index += 1) {
        const input = textboxes.nth(index);
        if (!(await input.isVisible().catch(() => false))) continue;
        const meta = `${await input.getAttribute("placeholder").catch(() => "")} ${await input.getAttribute("aria-label").catch(() => "")} ${await input.getAttribute("name").catch(() => "")}`;
        if (!/address|service|street|suburb|postcode/i.test(meta)) continue;
        await typeIntoAutocomplete(page, input, value);
        return;
    }
    throw new Error("Address search field not found");
}

/**
 * Type into the portal's address autocomplete with REAL keystrokes and then
 * wait for the autosuggest result. The portal listens for `keyup` (debounced
 * 600ms) before firing its autosuggest AJAX — `fill()` sets the value
 * programmatically without key events, so suggestions never appear. Waiting
 * here (instead of relying on the caller's 400ms check) keeps step 2
 * deterministic and avoids spending model calls on a timing gap.
 */
async function typeIntoAutocomplete(page: Page, input: import("playwright").Locator, value: string): Promise<void> {
    await input.scrollIntoViewIfNeeded().catch(() => undefined);
    await input.click().catch(() => undefined);
    // Clear with real keys so stale suggestions are dismissed by the page.
    await input.press("ControlOrMeta+a").catch(() => undefined);
    await input.press("Backspace").catch(() => undefined);
    await input.fill("").catch(() => undefined);
    await input.pressSequentially(value, { delay: 60 });
    // Debounce (600ms) + autosuggest round-trip: poll for any suggestion row.
    const deadline = Date.now() + 10_000;
    const rows = page.locator(
        "#search-result .autocomplete-suggestion, #popup_search-result .autocomplete-suggestion, #search-result-sticky .autocomplete-suggestion",
    );
    while (Date.now() < deadline) {
        if ((await rows.count().catch(() => 0)) > 0) return;
        await page.waitForTimeout(300);
    }
    // No rows within 10s — leave the typed value in place; the caller decides
    // (manual-address path) instead of failing here.
}

export async function chooseAddressSuggestion(page: Page, address: string): Promise<boolean> {
    const street = address.split(",")[0]?.trim() ?? address;
    const suggestions = page.locator(
        "#search-result .autocomplete-suggestion, #popup_search-result .autocomplete-suggestion, #search-result-sticky .autocomplete-suggestion, .autocomplete-suggestion",
    );
    try {
        await suggestions
            .first()
            .waitFor({ state: "visible", timeout: 30000 });
    } catch {
        return false;
    }

    // The "Sorry! Address Not Found" row shares the .autocomplete-suggestion
    // class but is not selectable — ignore it, or the fallback below would
    // click it and the addressdetails call breaks.
    const isSorry = (text: string) => /sorry|not found|no results|unable to/i.test(text);
    let firstVisible: import("playwright").Locator | null = null;
    const count = await suggestions.count();
    for (let i = 0; i < count; i += 1) {
        const candidate = suggestions.nth(i);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const text = (await candidate.innerText().catch(() => "")).trim();
        if (isSorry(text)) continue;
        if (!firstVisible) firstVisible = candidate;
        if (text.toLowerCase().includes(street.toLowerCase())) {
            await clickAction(candidate);
            return true;
        }
    }

    // No exact street match; the closest option is the first visible suggestion.
    if (firstVisible) {
        await clickAction(firstVisible);
        return true;
    }
    return false;
}

export async function fillManual(
    page: Page,
    payload: JobPayload,
): Promise<void> {
    // Manual-address modal field ids: #unitno, #streetno, #streetname,
    // #streettype (select), #suburb, #state (select), #postcode. Street Type
    // and State are <select>s — fill() throws on them, so selectOption is
    // required. The submit reads "Find Address", not "Confirm".
    const address = payload.connectionAddress.mainAddress;
    const textFields: Array<[RegExp, string]> = [
        [/unit/i, address.unitNumber],
        [/street number/i, address.streetNumber],
        [/street name/i, address.streetName],
        [/suburb/i, address.suburb],
        [/postcode/i, address.postcode],
    ];
    for (const [label, value] of textFields) {
        if (!value) continue;
        const field = page.getByLabel(label).first();
        if (await field.count()) {
            await field.fill(value).catch(() => undefined);
        }
    }
    // Selects: match by visible label text ("WAY", "WA"); fall back to value.
    const selectFields: Array<[RegExp, string]> = [
        [/street type/i, address.streetType],
        [/^state/i, address.state],
    ];
    for (const [label, value] of selectFields) {
        if (!value) continue;
        const field = page.getByLabel(label).first();
        if (!(await field.count())) continue;
        const options = await field.locator("option").allTextContents().catch(() => [] as string[]);
        const exact = options.find((x) => x.trim().toLowerCase() === value.trim().toLowerCase());
        const partial = exact ?? options.find((x) => x.toLowerCase().includes(value.toLowerCase())) ?? options.find((x) => value.toLowerCase().includes(x.toLowerCase()));
        if (partial) await field.selectOption({ label: partial }).catch(() => undefined);
        else await field.selectOption(value).catch(() => undefined);
    }

    const confirm = page
        .locator("button, a, [role='button'], input[type='submit']")
        .filter({ hasText: /find address|confirm/i })
        .first();
    if (await confirm.count()) {
        await clickAction(confirm);
    }
}

/**
 * Read actual cart state from the checkout UI. Never synthesize totals or
 * invoke undocumented add-to-cart endpoints; those can desynchronise the session.
 */
export async function assertNbnPlanInCart(page: Page, name: string): Promise<void> {
    const popupId = await activePopupId(page);
    if (popupId && /hold.?on/i.test(popupId)) {
        throw new Error("Cart integrity alarm: router present without active plan");
    }

    await assertCartPositive(page);

    // The order summary names the plan; when present it must match the payload.
    const summary = await page.evaluate(() => {
        const node = document.querySelector("#order-summary, .order-summary, #grand-total-summary");
        return node ? (node as HTMLElement).innerText.replace(/\s+/g, " ") : "";
    });
    if (summary && !summary.toLowerCase().includes(name.toLowerCase())) {
        throw new Error(`Order summary plan mismatch: expected ${name}`);
    }
}

/** Read the sticky cart's rendered totals. */
async function stickyCartText(page: Page): Promise<string> {
    return page.evaluate(() => {
        const node = document.querySelector("#sticky-main-cart");
        return node ? (node as HTMLElement).innerText.replace(/\s+/g, " ") : "";
    });
}

/** Wait until the sticky cart reports a positive amount, then succeed. */
export async function waitForPlanInCart(
    page: Page,
    name: string,
    timeoutMs = 20_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const popupId = await activePopupId(page);
        if (popupId && /hold.?on/i.test(popupId)) {
            throw new Error("Cart integrity alarm: router present without active plan");
        }
        const text = await stickyCartText(page);
        const totals = [...text.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)].map((m) =>
            Number(m[1]),
        );
        if (totals.length && Math.max(...totals) > 0) return;
        await page.waitForTimeout(500);
    }
    throw new Error(`NBN plan not confirmed in cart: ${name}`);
}


export async function selectPlan(page: Page, name: string): Promise<void> {
    const plans = page.locator('button[data-product-type="speed"][data-product-name]');
    const count = await plans.count();
    let target: import("playwright").Locator | null = null;

    for (let i = 0; i < count; i += 1) {
        const button = plans.nth(i);
        if (!(await button.isVisible().catch(() => false))) continue;
        const product = (await button.getAttribute("data-product-name")) ?? "";
        if (product.toLowerCase() === name.toLowerCase()) {
            target = button;
            break;
        }
        if (!target && product.toLowerCase().includes(name.toLowerCase())) {
            target = button;
        }
    }

    if (!target) {
        const label = page.getByText(new RegExp(escapeRx(name), "i")).filter({ visible: true }).first();
        if (await label.count()) {
            const container = label.locator("xpath=ancestor::*[self::article or self::section or self::div][.//button or .//*[@role='button']][1]");
            const choose = container.locator("button,[role='button'],a").filter({ visible: true }).filter({ hasText: /select|choose|add|plan/i }).first();
            if (await choose.count()) target = choose;
        }
    }
    if (!target) throw new Error(`Plan card not found: ${name}`);

    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await clickAction(target);
    await page.waitForTimeout(1500);
    await settlePopups(page);
    await waitForPlanInCart(page, name);
}

export async function selectRouter(page: Page, model: string): Promise<void> {
    if (/byo|bring your own/i.test(model)) {
        const tab = page.locator("#bring-your-own-modem-tab");
        if (await tab.count()) {
            await tab.scrollIntoViewIfNeeded().catch(() => undefined);
            await clickAction(tab);
            await page.waitForTimeout(800);
        }

        const option = page.locator('button[data-product-name="BYO Modem"]').first();
        if (!(await option.count())) throw new Error("BYO router option not found");
        await option.scrollIntoViewIfNeeded().catch(() => undefined);
        await clickAction(option);
        await page.waitForTimeout(1200);
        await settlePopups(page);
        return;
    }

    const tabName = /eero/i.test(model)
        ? "#amazon-eero-7-tab"
        : /netcomm/i.test(model)
            ? "#netcomm-tab"
            : null;
    if (tabName) {
        const tab = page.locator(tabName);
        if (await tab.count()) {
            await tab.scrollIntoViewIfNeeded().catch(() => undefined);
            await clickAction(tab);
            await page.waitForTimeout(800);
        }
    }

    const item = page
        .locator("button[data-product-type='modem'][data-product-name]")
        .filter({ hasText: new RegExp(escapeRx(model), "i") })
        .first()
        .or(page.getByText(new RegExp(escapeRx(model), "i")).first());
    let routerTarget = item;
    if (!(await routerTarget.count())) {
        const label = page.getByText(new RegExp(escapeRx(model), "i")).filter({ visible: true }).first();
        if (await label.count()) {
            const container = label.locator("xpath=ancestor::*[self::article or self::section or self::div][.//button or .//*[@role='button']][1]");
            const choose = container.locator("button,[role='button'],a").filter({ visible: true }).filter({ hasText: /select|choose|add|outright|bring your own|byo/i }).first();
            if (await choose.count()) routerTarget = choose;
        }
    }
    if (!(await routerTarget.count())) throw new Error(`Router option not found: ${model}`);
    await routerTarget.scrollIntoViewIfNeeded().catch(() => undefined);
    await clickAction(routerTarget);
    await page.waitForTimeout(1200);
    await settlePopups(page);
}

export async function assertCartPositive(page: Page): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
        const text = await stickyCartText(page);
        const totals = [...text.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)].map((m) =>
            Number(m[1]),
        );
        if (totals.length && Math.max(...totals) > 0) return;
        await page.waitForTimeout(500);
    }
    throw new Error("Cannot verify positive cart total");
}

/**
 * A cart that was already verified positive can still "bounce": the portal
 * drops the session back to the home page ("/") with the sticky cart reset to
 * $0.00 (server-side cart expiry, or `/address-order` erroring out before the
 * order is committed). There is nothing to heal on an empty home page, so the
 * whole plan/router/order sequence has to be re-driven from scratch.
 */
export async function cartBounced(page: Page): Promise<boolean> {
    if (/checkout/i.test(page.url())) return false;
    const text = await stickyCartText(page).catch(() => "");
    const totals = [...text.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)].map((m) =>
        Number(m[1]),
    );
    return !(totals.length && Math.max(...totals) > 0);
}

/**
 * Click the sticky "Order Now" control. The portal then shows one of several
 * modals (BYO router warning, plan-missing alarm). Approving the BYO warning is
 * what "Agree and Continue" does - it hands off to `/checkout/login`.
 */
export async function clickOrderNow(page: Page): Promise<void> {
    // Reaching `/checkout/login` is done by clicking the "Order Now" control in
    // the page's order summary. `#addressordernotfound` is reused for hidden
    // "Continue" controls inside modals, so target the visible control that
    // reads like an order submit. The portal sometimes bounces the click to the
    // home page ("/") before the cart is committed server-side; when that
    // happens the plan page is restored and the click retried in place.
    const submitText = /order now|place order|proceed to order|proceed to checkout|review your order/i;
    const origin = page.url();
    const onCheckout = () => /checkout/i.test(page.url());
    const onRoot = () => {
        try { return new URL(page.url()).pathname === "/"; } catch { return false; }
    };

    const findOrderNow = async (): Promise<import("playwright").Locator | null> => {
        // Order-summary submit first (the control the user clicks), then the
        // sticky cart, then any visible control whose label reads like a submit.
        const scopes = [
            page.locator("button.orderNow, #addressordernotfound, .order_box button, .order_box a").filter({ hasText: submitText }),
            page.locator("#sticky-main-cart a.orderNow, #sticky-main-cart [data-btn-value]").filter({ hasText: submitText }),
            page.locator("a.orderNow[data-btn-value], [data-btn-value].orderNow").filter({ hasText: submitText }),
            page.locator("button, a, [role='button']").filter({ hasText: submitText }),
        ];
        for (const scope of scopes) {
            const count = await scope.count().catch(() => 0);
            for (let i = 0; i < count; i += 1) {
                const button = scope.nth(i);
                if (await button.isVisible().catch(() => false)) return button;
            }
        }
        return null;
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        let target = await findOrderNow();
        const findDeadline = Date.now() + 10_000;
        while (!target && Date.now() < findDeadline && !onCheckout()) {
            await page.waitForTimeout(400);
            target = await findOrderNow();
        }
        if (onCheckout()) return;
        if (!target) {
            // The session likely bounced to the home page; restore the plan page
            // and retry rather than failing into semantic recovery.
            if (onRoot()) {
                await page.goto(origin, { waitUntil: "domcontentloaded" }).catch(() => undefined);
                await page.waitForTimeout(1_500);
                continue;
            }
            throw new Error("Order Now control not found");
        }

        if (process.env.DEBUG_ORDER === "true") {
            const html = await target.evaluate((el) => (el as HTMLElement).outerHTML.slice(0, 200)).catch(() => "");
            console.error(`[order-now] attempt=${attempt} url=${page.url()} target=${html}`);
        }

        await target.scrollIntoViewIfNeeded().catch(() => undefined);
        await clickAction(target);

        // Wait for the order to be committed server-side (the portal raises a
        // modal once the cart is persisted) before following the checkout link.
        let popupId: string | null = null;
        const deadline = Date.now() + 12_000;
        while (Date.now() < deadline) {
            if (onCheckout()) {
                await page.waitForTimeout(800);
                return;
            }
            popupId = await activePopupId(page);
            if (popupId) break;
            await page.waitForTimeout(400);
        }
        await page.waitForTimeout(2_000);
        if (process.env.DEBUG_ORDER === "true") {
            console.error(`[order-now] after click url=${page.url()} popupId=${popupId}`);
        }

        // The router/BYO/eero warning modal's "Agree and Continue" link is the
        // single genuine navigation to checkout. Click once and wait.
        if (popupId && /modem|byo|router|eero/i.test(popupId)) {
            const checkout = page
                .locator("#user-model .modal-sections:visible a[href*='/checkout']")
                .first();
            if (await checkout.count()) {
                await Promise.all([
                    page.waitForURL(/checkout/i, { timeout: 20_000 }).catch(() => undefined),
                    checkout.click({ timeout: 6_000 }).catch(() => undefined),
                ]);
                await page.waitForTimeout(500);
                return;
            }
        }

        if (onCheckout()) return;

        if (onRoot()) {
            // Bounced to the home page after the click: restore the plan page and
            // retry so the order can be committed on a settled session.
            await page.goto(origin, { waitUntil: "domcontentloaded" }).catch(() => undefined);
            await page.waitForTimeout(1_500);
            continue;
        }

        await settlePopups(page, 5, /^(agree and continue|continue|ok|got it|i understand)/i);
        if (onCheckout()) return;
    }
}


/**
 * The portal funnels every dialog through a single Bootstrap modal
 * (`#user-model`). Only one `.modal-sections` block is visible at a time; the
 * rest are `display:none`. Reading the visible block is the reliable way to
 * know what the page is actually asking.
 */
export async function activePopupId(page: Page): Promise<string | null> {
    try {
        return await page.evaluate(() => {
            const sections = Array.from(
                document.querySelectorAll<HTMLElement>("#user-model .modal-sections"),
            );
            const visible = sections.find((section) => section.offsetParent !== null);
            if (visible) return visible.id || "modal-sections";
            const loader = document.querySelector<HTMLElement>("#modal-loader");
            if (loader && loader.offsetParent !== null) return "modal-loader";
            return null;
        });
    } catch {
        // A navigation can destroy the execution context mid-poll; treat as no
        // popup so callers can re-evaluate against the new document.
        return null;
    }
}

const DEFAULT_POPUP_ACTIONS =
    /^(continue|agree and continue|continue to checkout|build your plan|see nbn|see other plans|continue with plan|pre-?order|order wi-fi router|ok|got it|i understand|next)/i;

export async function resolvePopup(
    page: Page,
    prefer: RegExp = DEFAULT_POPUP_ACTIONS,
): Promise<string | null> {
    const id = await activePopupId(page);
    if (!id || id === "modal-loader") return null;

    const section = page.locator(`#user-model #${id}`).first();
    const sectionText = await section.innerText().catch(() => "");
    if (/hold\s*on/i.test(`${id} ${sectionText}`) && /modem|router|plan/i.test(sectionText)) {
        throw new Error("Cart integrity alarm: modem/router present without a valid NBN plan");
    }
    const actions = section.locator("button, a.btn, a[role='button']");
    const count = await actions.count();

    for (let i = 0; i < count; i += 1) {
        const action = actions.nth(i);
        const text = (await action.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (!prefer.test(text)) continue;
        if (!(await action.isVisible().catch(() => false))) continue;
        await clickAction(action);
        return text || "action";
    }

    const close = section.locator(".poppup_close, button.close").first();
    if (await close.count()) {
        await clickAction(close);
        return "close";
    }
    return null;
}

/** Drain any sequence of blocking popups (e.g. Heads up! then Continue). */
export async function settlePopups(
    page: Page,
    max = 5,
    prefer: RegExp = DEFAULT_POPUP_ACTIONS,
): Promise<void> {
    for (let attempt = 0; attempt < max; attempt += 1) {
        const id = await activePopupId(page);
        if (!id) return;
        if (id === "modal-loader") {
            await page.waitForTimeout(700);
            continue;
        }
        const acted = await resolvePopup(page, prefer);
        if (!acted) return;
        await page.waitForTimeout(500);
    }
}

/** Wait until the address-check spinner finishes and a result popup is shown. */
export async function waitForAddressResult(
    page: Page,
    timeoutMs = 45_000,
): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const id = await activePopupId(page);
        if (id && id !== "modal-loader") {
            const section = page.locator(`#user-model #${id}`).first();
            const text = await section.innerText().catch(() => "");
            if (/address not found|unable to (?:find|locate)|couldn.?t find.*address/i.test(text)) {
                throw new Escalation("Address Not Found");
            }
            if (/nearly there/i.test(text)) {
                const radios = section.locator('input[type="radio"]:visible');
                if (await radios.count()) await radios.first().check({ force: true }).catch(() => undefined);
                const select = section.locator("select:visible").first();
                if (await select.count()) {
                    const options = await select.locator("option").evaluateAll((els) =>
                        els.map((el) => ({ value: (el as HTMLOptionElement).value, text: (el.textContent || "").trim() }))
                    ).catch(() => [] as Array<{ value: string; text: string }>);
                    const usable = options.find((x) => x.value && !/select|choose/i.test(x.text));
                    if (usable) await select.selectOption(usable.value).catch(() => undefined);
                }
                const next = section.locator("button,a,[role='button']").filter({ hasText: /continue|confirm|next/i }).filter({ visible: true }).first();
                if (await next.count()) {
                    await clickAction(next);
                    await page.waitForTimeout(700);
                    continue;
                }
            }
            return id;
        }
        await page.waitForTimeout(500);
    }
    return null;
}

export async function dismissDialogs(page: Page): Promise<void> {
    await settlePopups(page);
}


export async function fillContact(
    page: Page,
    payload: JobPayload,
): Promise<void> {
    const c = payload.customer;
    // Set every DOM value in one synchronous evaluation so the portal's
    // reactive framework cannot wipe fields between Playwright input events.
    const title = JSON.stringify(c.title);
    const firstName = JSON.stringify(c.firstName);
    const lastName = JSON.stringify(c.lastName);
    const phone = JSON.stringify(c.phone);
    const dob = JSON.stringify(c.dateOfBirth);
    const script = [
        `(function(){`,
        `const setInput=(id,value)=>{const el=document.getElementById(id);if(el&&value){el.value=value;el.dispatchEvent(new Event("input",{bubbles:true}));}};`,
        `const sel=document.querySelector("#salutation");if(sel&&${title}){const m=Array.from(sel.options).find((o)=>o.text.trim()===${title}||o.value===${title});if(m)sel.value=m.value;sel.dispatchEvent(new Event("change",{bubbles:true}));}`,
        `setInput("fname",${firstName});setInput("lname",${lastName});setInput("mobile",${phone});setInput("dob",${dob});`,
        `const hear=document.querySelector("#hear_about_us");if(hear){const m=Array.from(hear.options).find((o)=>o.text.trim().toLowerCase().includes("other"));if(m)hear.value=m.value;hear.dispatchEvent(new Event("change",{bubbles:true}));}`,
        `const privacy=document.querySelector("input[name='read_policy']");if(privacy)privacy.checked=true;`,
        `})()`,
    ].join("");
    await page.evaluate(script);

    const contactUrl = page.url();
    for (let attempt = 1; attempt <= 6 && page.url() === contactUrl; attempt += 1) {
        const next = page.getByRole("button", { name: /next|continue|proceed/i }).first();
        if ((await next.count())) {
            await clickAction(next);
        } else {
            const fallback = page.locator("button, a, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: /next|continue|proceed/i }).first();
            if (!(await fallback.count())) break;
            await clickAction(fallback);
        }
        await page.waitForTimeout(600);
    }
}

export async function fillService(
    page: Page,
    payload: JobPayload,
): Promise<void> {
    const addr = payload.connectionAddress.mainAddress;
    // Populate explicit service/delivery fields when the portal renders them
    // (manual path / verification screen). Silent no-op when the address was
    // already carried over and no fields exist.
    const addressFills: Array<[RegExp, string, "text" | "select"]> = [
        [/unit/i, addr.unitNumber, "text"],
        [/street number|street no/i, addr.streetNumber, "text"],
        [/street name/i, addr.streetName, "text"],
        [/street type/i, addr.streetType, "text"],
        [/suburb|city/i, addr.suburb, "text"],
        [/state/i, addr.state, "select"],
        [/postcode|post code|zip/i, addr.postcode, "text"],
        [/full address|service address|delivery address|street address/i, addr.fullAddress, "text"],
    ];
    for (const [label, value, kind] of addressFills) {
        if (!value) continue;
        const field = await formField(page, label, kind === "select" ? "select" : "text");
        if (!field) {
            if (kind === "select") {
                const asText = await formField(page, label, "text");
                if (!asText) continue;
                await asText.fill(value).catch(() => undefined);
            }
            continue;
        }
        const tag = await field.evaluate((el) => el.tagName.toLowerCase()).catch(() => "input");
        if (tag === "select") {
            await selectIf(page, label, value).catch(() => undefined);
        } else {
            await field.fill(value).catch(() => undefined);
            const persisted = await field.inputValue().catch(() => "");
            if (persisted.trim() !== value.trim()) {
                await field.fill(value).catch(() => undefined);
            }
        }
    }

    if (addr.streetNumber) {
        const useServiceAddress = await formField(page, /use service address/i, "check");
        if (
            useServiceAddress &&
            (await useServiceAddress.isChecked().catch(() => false))
        ) {
            await useServiceAddress.uncheck().catch(() => undefined);
        }
    }

    const selfCarePortal = await formField(page, /self care portal/i, "check");
    if (selfCarePortal) {
        await selfCarePortal.check().catch(() => undefined);
    }

    // Accept Next/Continue/Proceed (mutation renames Continue/Next to Proceed).
    const next = page.getByRole("button", { name: /next|continue|proceed/i }).first();
    if (await next.count()) {
        await clickAction(next);
    } else {
        const fallback = page.locator("button, a, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: /next|continue|proceed/i }).first();
        if (await fallback.count()) await clickAction(fallback);
    }

    await page.waitForTimeout(600);
}

export async function fillConnection(
    page: Page,
    payload: JobPayload,
): Promise<void> {
    // The connection step often opens behind a blocking "Heads up!" equipment
    // notice whose Continue must be dismissed before the fields are usable.
    await settlePopups(page, 5, /^(continue|ok|got it|i understand|agree and continue|close)/i);

    // Assignment rule: a move-in date means New connection; otherwise Transfer.
    const wantsNew = !!payload.connectionDetails.moveInDate;
    const activation = await formField(
        page,
        wantsNew ? /new/i : /transfer/i,
        "check",
    );
    if (activation) {
        await activation.check({ force: true }).catch(() => undefined);
    }

    // Explicitly pick New vs Transfer connection (the portal renders these as
    // restyled radios sharing a single container label).
    const newOrTransfer = page
        .locator("input[name='new_or_transfer']")
        .filter({ visible: true });
    if (await newOrTransfer.count()) {
        let matched = false;
        for (let i = 0; i < (await newOrTransfer.count()); i += 1) {
            const radio = newOrTransfer.nth(i);
            const id = await radio.getAttribute("id").catch(() => null);
            const value = (await radio.getAttribute("value").catch(() => "")) || "";
            const label = id ? await page.locator(`label[for="${id}"]`).innerText().catch(() => "") : "";
            const semantic = `${value} ${label}`;
            if ((wantsNew && /\bnew\b/i.test(semantic)) || (!wantsNew && /transfer/i.test(semantic))) {
                await radio.check({ force: true }).catch(() => undefined);
                matched = true;
                break;
            }
        }
        if (!matched) {
            const target = wantsNew ? newOrTransfer.first() : newOrTransfer.last();
            await target.check({ force: true }).catch(() => undefined);
        }
    }

    if (payload.connectionDetails.avcId) {
        await fillIf(page, /avc/i, payload.connectionDetails.avcId);

        const check = page.locator("button, a, [role='button'], input[type='submit'], input[type='button']").filter({ hasText: /^\s*check\s*$/i }).filter({ visible: true }).first();
        if (await check.count()) {
            await clickAction(check);
        }
    } else {
        // Payload has no AVC ID (transfer without AVC). The portal still marks
        // the field required unless "Provide Later" is explicitly chosen; the
        // control may be a button, link or label, so match any of them.
        const later = page.locator("button, a, [role='button'], input[type='button'], input[type='submit'], label")
            .filter({ hasText: /provide later/i }).filter({ visible: true }).first();
        if (await later.count()) {
            await clickAction(later);
        } else {
            const text = page.getByText(/provide later/i).filter({ visible: true }).first();
            if (await text.count()) await clickAction(text);
        }
        await page.waitForTimeout(400);
    }

    if (payload.connectionDetails.currentProvider) {
        await selectIf(
            page,
            /provider/i,
            payload.connectionDetails.currentProvider,
        ).catch(() => selectIf(page, /provider/i, "Other"));
    }

    if (
        payload.connectionDeliveryDate &&
        payload.connectionDeliveryDate !== "ASAP"
    ) {
        await fillIf(
            page,
            /connection date|preferred date/i,
            payload.connectionDeliveryDate,
        );
    }

    const unsure = await formField(page, /unsure/i, "check");
    if (unsure) {
        await unsure.check().catch(() => undefined);
    }

    const waitForRouter = await formField(page, /wait.*router|router.*deliver/i, "check");
    if (
        payload.addOns.router.enabled &&
        !/byo/i.test(payload.addOns.router.model || "") &&
        waitForRouter
    ) {
        await waitForRouter.check().catch(() => undefined);
    }

    // The global header contains a "Pay Bill" nav link (`<a href=".../paybill">`)
    // with `target="_blank"`. A loose /pay/i matcher would click that instead of
    // the form's real "Process Order & Pay" control, so match the explicit
    // "process order" text first and never fall back to plain links.
    const processSpecific = page
        .locator("button, input[type='submit'], input[type='button'], a.btn, a[role='button']")
        .filter({ hasText: /process\s*order/i }).filter({ visible: true }).first();
    const process = (await processSpecific.count())
        ? processSpecific
        : page
            .locator("button, input[type='submit'], input[type='button'], a.btn, a[role='button']")
            .filter({ hasText: /pay now|proceed to pay|continue to pay|^pay$/i })
            .filter({ visible: true }).first();
    if (!(await process.count())) {
        throw new Error("Process Order and Pay not found");
    }

    let navigated = false;
    const connDeadline = Date.now() + 40_000;
    let settledAfterClick = false;
    while (Date.now() < connDeadline && !navigated) {
        await settlePopups(page, 3, /^(continue|ok|got it|i understand|agree and continue)/i);
        await clickAction(process).catch(() => undefined);
        const sliceDeadline = Math.min(Date.now() + 6_000, connDeadline);
        while (Date.now() < sliceDeadline) {
            const text = await page.locator("body").innerText().catch(() => "");
            if (!/transfer-number/i.test(page.url()) || /donation|small change big change|payment details|name on card/i.test(text)) {
                navigated = true;
                break;
            }
            // Post-submit the portal can raise a confirmation popup (e.g. an
            // equipment/AVC notice) whose Continue must be clicked before it
            // proceeds; settle once per click.
            if (!settledAfterClick) {
                settledAfterClick = true;
                await settlePopups(page, 3, /^(continue|ok|got it|i understand|agree and continue|yes)/i).catch(() => undefined);
            }
            // If the AVC "12 digits" validation reappeared, re-choose Provide Later.
            if (/must contain 12 digits/i.test(text)) {
                const later = page.locator("button, a, [role='button'], label").filter({ hasText: /provide later/i }).filter({ visible: true }).first();
                if (await later.count()) await clickAction(later).catch(() => undefined);
            }
            await page.waitForTimeout(400);
        }
        settledAfterClick = false;
    }

    if (!navigated) {
        await page.screenshot({ path: "/tmp/opencode/conn-fail.png" }).catch(() => undefined);
        const state = await page.evaluate(() => ({
            newOrTransfer: Array.from(
                document.querySelectorAll<HTMLInputElement>("input[name='new_or_transfer']"),
            ).map((el) => `${(el as HTMLInputElement).value}=${(el as HTMLInputElement).checked}`),
            sq24: Array.from(
                document.querySelectorAll<HTMLInputElement>("input[name='sq24']"),
            ).map((el) => `${(el as HTMLInputElement).value}=${(el as HTMLInputElement).checked}`),
            avcValue: (document.querySelector<HTMLInputElement>("input[name*='avc' i], #avc")?.value) ?? null,
            providerSelect: (() => {
                const sel = document.querySelector<HTMLSelectElement>("select[name*='provider' i]");
                return sel ? { name: sel.name, value: sel.value } : null;
            })(),
            provideLaterHtml: Array.from(document.querySelectorAll<HTMLElement>("a,button,label,span"))
                .find((el) => /provide later/i.test(el.textContent || ""))?.outerHTML.slice(0, 200) ?? null,
            checks: Array.from(document.querySelectorAll<HTMLInputElement>("input[type='checkbox']"))
                .slice(0, 12).map((el) => `${el.name || el.id}=${el.checked}`),
            submitDisabled: (document.querySelector<HTMLButtonElement>("button:not([disabled])")?.textContent || "").trim().slice(0, 40),
            errors: Array.from(document.querySelectorAll<HTMLElement>("[class*='error'], .invalid-feedback, .parsley-error, .text-danger, .help-block"))
                .filter((el) => el.offsetParent !== null && el.innerText.trim())
                .map((el) => el.innerText.trim().slice(0, 120)),
            visibleErrors: document.body.innerText.replace(/\s+/g, " ").slice(0, 1400),
        }));
        throw new Error(
            `Process Order & Pay did not advance from connection page: ${JSON.stringify(state)}`,
        );
    }
}

export async function verifyOrderSummary(
    page: Page,
    payload: JobPayload,
): Promise<void> {
    const bodyText = (await page.locator("body").innerText()).toUpperCase();

    if (!bodyText.includes(payload.plan.name.toUpperCase())) {
        throw new Error("Order summary plan mismatch");
    }

    // The address appears in the order summary only on some steps (review /
    // address pages); the final payment page shows plan + totals but no
    // address. Only enforce the address component when a summary address
    // section is actually rendered, so a component can never silently vanish
    // where it is meant to be shown.
    const addr = payload.connectionAddress.mainAddress;
    const components = [
        addr.streetNumber,
        addr.streetName,
        addr.suburb,
        addr.state,
        addr.postcode,
    ].filter(Boolean);
    const showsAddress = /(service|delivery|installation|connection)\s+address|your\s+address/i.test(bodyText);
    const matched = components.some((component) =>
        bodyText.includes(component.toUpperCase()),
    );
    if (showsAddress && !matched && components.length) {
        throw new Error(
            `Order summary address mismatch; body=${bodyText.slice(0, 300)}`,
        );
    }

    if (!/\$\s*[1-9]\d*(?:\.\d{1,2})?/.test(bodyText)) {
        throw new Error("Order summary price missing or zero");
    }
}

export async function checkAllVisible(page: Page): Promise<void> {
    const checkboxes = page.locator('input[type="checkbox"]:visible');

    for (let index = 0; index < (await checkboxes.count()); index += 1) {
        const checkbox = checkboxes.nth(index);

        if (!(await checkbox.isChecked())) {
            await checkbox.check();
        }
    }
}

export async function handle3dsAndTransaction(page: Page): Promise<string> {
    const deadline = Date.now() + 60_000;

    while (Date.now() < deadline) {
        for (const targetPage of [page, ...page.context().pages()]) {
            const bodyText = (
                await targetPage
                    .locator("body")
                    .innerText()
                    .catch(() => "")
            ).slice(0, 6000);
            const match = bodyText.match(
                /(?:transaction|order)\s*(?:id|number)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
            );

            if (
                match &&
                !/^(FAILED|FAILURE|ERROR|PENDING|UNKNOWN)$/i.test(match[1]) &&
                !/transaction failed|payment failed|declined/i.test(bodyText)
            ) {
                return match[1];
            }

            if (/transaction failed|payment failed|declined/i.test(bodyText)) {
                throw new Error("Payment provider reported a failed transaction");
            }

            if (/3.?d secure|authenticated|eci\s*05/i.test(bodyText)) {
                const auth = targetPage.getByText(/authenticated.*eci\s*05/i).first();
                if (await auth.count()) {
                    await auth.click().catch(() => undefined);
                }

                const option = targetPage.locator("select").first();
                if (await option.count()) {
                    const optionLabels = await option.locator("option").allTextContents();
                    const match = optionLabels.find((label) =>
                        /authenticated.*eci\s*05/i.test(label),
                    );

                    if (match) {
                        await option.selectOption({ label: match }).catch(() => undefined);
                    }
                }

                const submit = targetPage
                    .getByRole("button", { name: /submit/i })
                    .first();
                if (await submit.count()) {
                    await submit.click().catch(() => undefined);
                }
            }
        }

        await page.waitForTimeout(750);
    }

    throw new Error(
        "Neither 3-D Secure completion nor transaction ID appeared within 60s",
    );
}

export async function fillIf(
    page: Page,
    label: RegExp,
    value: string,
    slow = false,
): Promise<void> {
    const field = await formField(page, label);
    if (!field) return;

    if (slow) {
        await field.fill("");
        await field.pressSequentially(value, { delay: 60 });
        return;
    }

    await field.fill(value);
}

export async function selectIf(
    page: Page,
    label: RegExp,
    value: string,
): Promise<void> {
    const field = await formField(page, label, "select");
    if (!field) return;

    const options = await field.locator("option").allTextContents();
    const match =
        options.find(
            (option) => option.trim().toLowerCase() === value.trim().toLowerCase(),
        ) ??
        options.find((option) =>
            option.toLowerCase().includes(value.toLowerCase()),
        );

    if (match) {
        await field.selectOption({ label: match });
        return;
    }

    await field.selectOption(value);
}

export async function checkIf(page: Page, label: RegExp): Promise<void> {
    const field = await formField(page, label, "check");
    if (!field) return;
    if (await field.isChecked().catch(() => false)) return;

    // Portal checkboxes are usually restyled inputs that a normal click cannot
    // reach; force the check and fall back to clicking the associated label.
    await field.check({ force: true }).catch(() => undefined);
    if (await field.isChecked().catch(() => false)) return;

    const id = await field.getAttribute("id").catch(() => null);
    if (id) {
        const associated = page.locator(`label[for="${id}"]`).first();
        if (await associated.count()) {
            await associated.click({ force: true }).catch(() => undefined);
        }
    }
}

/**
 * Fill a control and read the value back, re-filling until it sticks. The
 * portal's reactive framework occasionally wipes a field after it is filled.
 */
export async function fillVerified(
    page: Page,
    locator: import("playwright").Locator,
    value: string,
    timeoutMs = 10_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        await locator.fill(value).catch(() => undefined);
        const actual = await locator.inputValue().catch(() => "");
        if (actual.trim() === value.trim()) return;
        await page.waitForTimeout(300);
    }
    throw new Error(`Could not persist field value for ${value}`);
}

/**
 * Resolve a visible form control by label, placeholder, or surrounding text.
 * Scoped to real inputs so navigation links and hidden mirrored fields are
 * ignored. Falls back to scanning visible inputs' id/name/placeholder/label
 * context, which catches portals where <label> is a sibling rather than a
 * programmatically associated label (getByLabel/getByPlaceholder miss those).
 */
async function formField(
    page: Page,
    label: RegExp,
    kind: "text" | "select" | "check" = "text",
): Promise<import("playwright").Locator | null> {
    const selector =
        kind === "select"
            ? "select"
            : kind === "check"
                ? "input[type='checkbox'], input[type='radio']"
                : "input:not([type='checkbox']):not([type='radio']):not([type='submit']):not([type='button']):not([type='hidden']), textarea";
    const scoped = page.locator(selector).filter({ visible: true });

    const byLabel = page.getByLabel(label).and(scoped).first();
    if (await byLabel.count()) return byLabel;

    if (kind === "text") {
        const byPlaceholder = page.getByPlaceholder(label).and(scoped).first();
        if (await byPlaceholder.count()) return byPlaceholder;
    }

    // Fallback: match against id/name/placeholder/aria-label plus the nearest
    // textual context (associated <label>, wrapping label, parent text).
    // This is what makes AVC/provider/date/checkbox fills actually land.
    try {
        const count = await scoped.count();
        for (let i = 0; i < count; i += 1) {
            const meta = await scoped.nth(i).evaluate((el) => {
                const input = el as HTMLInputElement;
                const id = input.id || "";
                let assoc = "";
                if (id) {
                    try {
                        const l = document.querySelector(`label[for="${CSS.escape(id)}"]`);
                        if (l?.textContent) assoc = l.textContent;
                    } catch { /* ignore */ }
                }
                const wrap = (input.closest("label")?.textContent || "").slice(0, 200);
                const parent = (input.parentElement?.innerText || "").slice(0, 200);
                return `${id} ${input.getAttribute("name") || ""} ${input.getAttribute("placeholder") || ""} ${input.getAttribute("aria-label") || ""} ${input.getAttribute("value") || ""} ${assoc} ${wrap} ${parent}`.replace(/\s+/g, " ");
            }).catch(() => "");
            // Reset lastIndex for global regexes callers may pass.
            label.lastIndex = 0;
            if (meta && label.test(meta)) return scoped.nth(i);
        }
    } catch { /* fall through to null */ }
    label.lastIndex = 0;

    return null;
}


export function escapeRx(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
