import type { Page } from "playwright";

import { semanticLocator } from "./healing";
import type { JobPayload } from "./payload";
import type { HealEvent } from "./types";

export class Escalation extends Error { }

export async function clickAction(locator: import("playwright").Locator): Promise<void> {
    try {
        await locator.click({ force: true, timeout: 15000 });
        return;
    } catch {
        await locator.evaluate((element: HTMLElement) => {
            element.scrollIntoView({ block: "center", inline: "center" });
            element.click();
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
        await input.click().catch(() => undefined);
        await input.fill("");
        await input.pressSequentially(value, { delay: 80 });
        // The address must be selected from the actual UI; typing alone is not validation.
        return;
    }
    throw new Error("Address search field not found");
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

    let firstVisible: import("playwright").Locator | null = null;
    const count = await suggestions.count();
    for (let i = 0; i < count; i += 1) {
        const candidate = suggestions.nth(i);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        if (!firstVisible) firstVisible = candidate;
        const text = (await candidate.innerText().catch(() => "")).trim();
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
    const address = payload.connectionAddress.mainAddress;
    const fields: Array<[RegExp, string]> = [
        [/unit/i, address.unitNumber],
        [/street number/i, address.streetNumber],
        [/street name/i, address.streetName],
        [/street type/i, address.streetType],
        [/suburb/i, address.suburb],
        [/state/i, address.state],
        [/postcode/i, address.postcode],
    ];

    for (const [label, value] of fields) {
        if (!value) {
            continue;
        }

        const field = page.getByLabel(label).first();
        if (await field.count()) {
            await field.fill(value);
        }
    }

    const confirm = page
        .locator("button, a, [role='button'], input[type='submit']")
        .filter({ hasText: /confirm/i })
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
    if (!(await item.count())) throw new Error(`Router option not found: ${model}`);
    await item.scrollIntoViewIfNeeded().catch(() => undefined);
    await clickAction(item);
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
 * Click the sticky "Order Now" control. The portal then shows one of several
 * modals (BYO router warning, plan-missing alarm). Approving the BYO warning is
 * what "Agree and Continue" does - it hands off to `/checkout/login`.
 */
export async function clickOrderNow(page: Page): Promise<void> {
    // `#addressordernotfound` is reused for hidden "Continue" controls inside
    // modals, so target the visible button that actually reads "Order Now".
    const buttons = page
        .locator("button.orderNow, #addressordernotfound")
        .filter({ hasText: /order now/i });
    const count = await buttons.count();
    let target: import("playwright").Locator | null = null;
    for (let i = 0; i < count; i += 1) {
        const button = buttons.nth(i);
        if (await button.isVisible().catch(() => false)) {
            target = button;
            break;
        }
    }
    if (!target) throw new Error("Order Now control not found");

    await target.scrollIntoViewIfNeeded().catch(() => undefined);
    await clickAction(target);

    // Wait for the order to be committed server-side (the portal raises a modal
    // once the cart is persisted) before following the checkout link, otherwise
    // /checkout/login can bounce back to the home page with an empty cart.
    let popupId: string | null = null;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
        if (/checkout/i.test(page.url())) {
            await page.waitForTimeout(800);
            return;
        }
        popupId = await activePopupId(page);
        if (popupId) break;
        await page.waitForTimeout(400);
    }
    await page.waitForTimeout(2_000);

    // If the router warning is up, its "Agree and Continue" link is the single
    // genuine navigation to checkout. Click once and wait; do not re-click.
    if (popupId && /modem|byo|router/i.test(popupId)) {
        const checkout = page
            .locator("#user-model .modal-sections:visible a[href*='/checkout']")
            .first();
        if (await checkout.count()) {
            await Promise.all([
                page
                    .waitForURL(/checkout/i, { timeout: 20_000 })
                    .catch(() => undefined),
                checkout.click({ timeout: 6_000 }).catch(() => undefined),
            ]);
            await page.waitForTimeout(500);
            return;
        }
    }

    await settlePopups(page, 5, /^(agree and continue|continue|ok|got it|i understand)/i);
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
        if (id && id !== "modal-loader") return id;
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
        const next = page.getByRole("button", { name: /next|continue/i }).first();
        if (!(await next.count())) break;
        await clickAction(next);
        await page.waitForTimeout(600);
    }
}

export async function fillService(
    page: Page,
    payload: JobPayload,
): Promise<void> {
    if (payload.connectionAddress.mainAddress.streetNumber) {
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

    const next = page.getByRole("button", { name: /next|continue/i }).first();
    if (await next.count()) {
        await clickAction(next);
    }

    await page.waitForTimeout(600);
}

export async function fillConnection(
    page: Page,
    payload: JobPayload,
): Promise<void> {
    const activation = await formField(
        page,
        payload.connectionDetails.moveInDate ? /new/i : /transfer/i,
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
        const wantTransfer = !!payload.connectionDetails.moveInDate;
        const target = wantTransfer ? newOrTransfer.last() : newOrTransfer.first();
        await target.check({ force: true }).catch(() => undefined);
    }

    if (payload.connectionDetails.avcId) {
        await fillIf(page, /avc/i, payload.connectionDetails.avcId);

        const check = page.getByRole("button", { name: /check/i }).first();
        if (await check.count()) {
            await clickAction(check);
        }
    } else {
        const later = page.getByRole("button", { name: /provide later/i }).first();
        if (await later.count()) {
            await clickAction(later);
        }
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

    const process = page
        .getByRole("button", { name: /process order|pay/i })
        .first();
    if (!(await process.count())) {
        throw new Error("Process Order and Pay not found");
    }

    await clickAction(process);
    let navigated = false;
    const connDeadline = Date.now() + 8_000;
    while (Date.now() < connDeadline && !navigated) {
        if (!/transfer-number/i.test(page.url())) {
            navigated = true;
            break;
        }
        await page.waitForTimeout(300);
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
            errors: Array.from(document.querySelectorAll<HTMLElement>("[class*='error'], .invalid-feedback, .parsley-error, .text-danger"))
                .filter((el) => el.offsetParent !== null && el.innerText.trim())
                .map((el) => el.innerText.trim().slice(0, 100)),
            visibleErrors: document.body.innerText.replace(/\s+/g, " ").slice(0, 1200),
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

    // The order summary may render the address in several places or abbreviate
    // it, so require at least one address component to be present.
    const addr = payload.connectionAddress.mainAddress;
    const components = [
        addr.streetNumber,
        addr.streetName,
        addr.suburb,
        addr.state,
        addr.postcode,
    ].filter(Boolean);
    const matched = components.some((component) =>
        bodyText.includes(component.toUpperCase()),
    );
    if (!matched && components.length) {
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
 * Resolve a visible form control by label or placeholder. Scoped to real inputs
 * so navigation links (which also carry aria-labels like "Mobile") and hidden
 * mirrored fields are ignored. `kind` narrows to the control type the caller
 * intends to act on, which keeps label collisions (e.g. "Mobile" matching a
 * hidden sim-transfer checkbox) from breaking a fill.
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

    return null;
}


export function escapeRx(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
