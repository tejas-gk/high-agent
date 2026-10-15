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
    const candidates = page.locator(
        '#autocomplete, #autocomplete-stickysearch, input[placeholder*="address" i], input[id*="address" i]',
    );

    let input: import("playwright").Locator | null = null;
    for (let index = 0; index < (await candidates.count()); index += 1) {
        const candidate = candidates.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
            input = candidate;
            break;
        }
    }

    if (!input) {
        return;
    }

    await input.click();
    await input.fill("");

    for (const character of value) {
        await input.pressSequentially(character, { delay: 80 });
    }

    await page.waitForTimeout(1200);

    const activated = await page.evaluate(async (addressText: string) => {
        const token = document.querySelector('meta[name="_token"]')?.getAttribute("content") ?? "";
        const suggestResponse = await fetch("https://test-tangerine.hipeely.com/autosuggest", {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRF-TOKEN": token,
            },
            body: new URLSearchParams({ address: addressText }).toString(),
        });

        const suggestionData = await suggestResponse.json();
        const selectedId = suggestionData?.suggest?.[0]?.id;
        if (!selectedId) {
            return false;
        }

        const detailResponse = await fetch("https://test-tangerine.hipeely.com/addressdetails", {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRF-TOKEN": token,
            },
            body: new URLSearchParams({ address: String(selectedId), vocuesType: "", planModels: "" }).toString(),
        });

        const detailData = await detailResponse.json();
        const addressObj = detailData?.address ?? detailData;
        const liveWindow = window as typeof window & {
            check_vocus?: (value: unknown) => void;
        };

        if (typeof liveWindow.check_vocus === "function") {
            liveWindow.check_vocus(addressObj);
            return true;
        }

        return false;
    }, value);

    if (!activated) {
        const suggestion = page
            .locator('.search-suggestion, [data-id], .autocomplete-suggestion')
            .filter({ hasText: new RegExp(value.split(",")[0].trim().replace(/\s+/g, " "), "i") })
            .first();

        if (await suggestion.count()) {
            await clickAction(suggestion);
        }
    }

    await page.waitForSelector('#tech-wise-speed, button[data-product-name], [data-product-name]', {
        timeout: 30_000,
    });
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

async function addProductToCart(
    page: Page,
    product: {
        id: string;
        type: string;
        buttonId: string;
        allowAddress?: string;
    },
): Promise<Record<string, string>> {
    const token =
        (await page.locator('meta[name="_token"]').getAttribute("content")) ?? "";

    const totals = await page.evaluate(async (payload) => {
        const response = await fetch("https://test-tangerine.hipeely.com/add-to-cart", {
            method: "POST",
            credentials: "include",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRF-TOKEN": payload.token,
            },
            body: new URLSearchParams(payload.data).toString(),
        });

        const json = await response.json();
        const finalTotals = (json && typeof json === "object" && "final_totals" in json)
            ? (json.final_totals as Record<string, string>)
            : {};

        const grandTotal = String(
            finalTotals.grand_total ??
            finalTotals.grand_total_no_discount ??
            finalTotals.total_monthly ??
            "0",
        );

        const grandContainer = document.getElementById("nbn-grand-total");
        if (grandContainer) {
            grandContainer.textContent = `$${grandTotal}`;
        }

        const stickyCart = document.getElementById("sticky-main-cart");
        if (stickyCart) {
            stickyCart.textContent = `Total to Pay Today $${grandTotal}`;
        }

        return finalTotals;
    }, {
        token,
        data: {
            pid: product.id,
            ptype: product.type,
            pBtn: product.buttonId,
            cType: "nbn-broadband",
            callType: "add",
            allow_address: product.allowAddress ?? "Yes",
            qty: "1",
        },
    });

    const grandTotal = Number(
        totals.grand_total ??
        totals.grand_total_no_discount ??
        totals.total_monthly ??
        0,
    );

    if (!Number.isFinite(grandTotal) || grandTotal <= 0) {
        throw new Error("Cart did not activate after choosing a product");
    }

    return totals;
}

export async function selectPlan(page: Page, name: string): Promise<void> {
    const productButtons = page.locator('button[data-product-name][data-product-type="speed"]');

    for (let index = 0; index < (await productButtons.count()); index += 1) {
        const button = productButtons.nth(index);
        const productName = await button.getAttribute("data-product-name");

        if (productName && new RegExp(escapeRx(name), "i").test(productName)) {
            const productId = (await button.getAttribute("data-product-id")) ?? "";
            const buttonId = (await button.getAttribute("id")) ?? "";
            const allowAddress = (await button.getAttribute("data-address-allow")) ?? "Yes";

            await addProductToCart(page, {
                id: productId,
                type: "speed",
                buttonId,
                allowAddress,
            });
            await page.waitForTimeout(700);
            await assertCartPositive(page);
            return;
        }
    }

    throw new Error(`Plan card not found: ${name}`);
}

export async function selectRouter(page: Page, model: string): Promise<void> {
    if (/byo/i.test(model)) {
        const option = page.getByText(/bring your own|byo modem/i).first();
        if (await option.count()) {
            await option.click();
        }
        return;
    }

    const buttons = page.locator('button[data-product-type="modem"], button[data-product-name]');

    for (let index = 0; index < (await buttons.count()); index += 1) {
        const button = buttons.nth(index);
        const productName = await button.getAttribute("data-product-name");

        if (productName && new RegExp(escapeRx(model), "i").test(productName)) {
            const productId = (await button.getAttribute("data-product-id")) ?? "";
            const buttonId = (await button.getAttribute("id")) ?? "";
            const allowAddress = (await button.getAttribute("data-address-allow")) ?? "Yes";

            await addProductToCart(page, {
                id: productId,
                type: "modem",
                buttonId,
                allowAddress,
            });
            await page.waitForTimeout(700);
            await assertCartPositive(page);
            return;
        }
    }

    const tab = page.getByText(/eero|netcomm/i).first();
    if (await tab.count()) {
        await tab.click();
    }

    const item = page.getByText(new RegExp(escapeRx(model), "i")).first();
    if (await item.count()) {
        await item.click();
    }
}

export async function assertCartPositive(page: Page): Promise<void> {
    const bodyText = await page.locator("body").innerText();
    const totals = [...bodyText.matchAll(/\$\s*(\d+(?:\.\d{1,2})?)/g)].map(
        (match) => Number(match[1]),
    );

    if (!totals.length || Math.max(...totals) <= 0) {
        throw new Error("Cannot verify positive cart total");
    }
}

export async function dismissDialogs(page: Page): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const dialog = page.getByRole("dialog").first();
        if (!(await dialog.count())) {
            return;
        }

        const button = dialog
            .locator("button, a, [role='button'], input[type='submit'], input[type='button']")
            .filter({ hasText: /continue|close|dismiss|no thanks|got it/i })
            .first();

        if (!(await button.count())) {
            return;
        }

        await clickAction(button);
        await page.waitForTimeout(250);
    }
}

export async function fillContact(
    page: Page,
    payload: JobPayload,
): Promise<void> {
    await selectIf(page, /title|salutation/i, payload.customer.title);
    await fillIf(page, /first name|given name/i, payload.customer.firstName);
    await fillIf(page, /last name|family name/i, payload.customer.lastName);
    await fillIf(page, /mobile|phone/i, payload.customer.phone);
    await fillIf(page, /date of birth|dob/i, payload.customer.dateOfBirth, true);
    await selectIf(page, /hear about/i, "Other");
    await checkIf(page, /privacy/i);

    const next = page.getByRole("button", { name: /next|continue/i }).first();
    if (await next.count()) {
        await next.click();
    }

    await page.waitForTimeout(600);
}

export async function fillService(
    page: Page,
    payload: JobPayload,
): Promise<void> {
    if (payload.connectionAddress.mainAddress.streetNumber) {
        const useServiceAddress = page.getByLabel(/use service address/i).first();
        if (
            (await useServiceAddress.count()) &&
            (await useServiceAddress.isChecked())
        ) {
            await useServiceAddress.uncheck();
        }
    }

    const selfCarePortal = page.getByLabel(/self care portal/i).first();
    if (await selfCarePortal.count()) {
        await selfCarePortal.check();
    }

    const next = page.getByRole("button", { name: /next|continue/i }).first();
    if (await next.count()) {
        await next.click();
    }

    await page.waitForTimeout(600);
}

export async function fillConnection(
    page: Page,
    payload: JobPayload,
): Promise<void> {
    const activation = page
        .getByLabel(payload.connectionDetails.moveInDate ? /new/i : /transfer/i)
        .first();

    if (await activation.count()) {
        await activation.check();
    }

    if (payload.connectionDetails.avcId) {
        await fillIf(page, /avc/i, payload.connectionDetails.avcId);

        const check = page.getByRole("button", { name: /check/i }).first();
        if (await check.count()) {
            await check.click();
        }
    } else {
        const later = page.getByRole("button", { name: /provide later/i }).first();
        if (await later.count()) {
            await later.click();
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

    const unsure = page.getByLabel(/unsure/i).first();
    if (await unsure.count()) {
        await unsure.check();
    }

    const waitForRouter = page
        .getByLabel(/wait.*router|router.*deliver/i)
        .first();
    if (
        payload.addOns.router.enabled &&
        !/byo/i.test(payload.addOns.router.model || "") &&
        (await waitForRouter.count())
    ) {
        await waitForRouter.check();
    }

    const process = page
        .getByRole("button", { name: /process order|pay/i })
        .first();
    if (!(await process.count())) {
        throw new Error("Process Order and Pay not found");
    }

    await process.click();
    await page.waitForTimeout(700);
}

export async function verifyOrderSummary(
    page: Page,
    payload: JobPayload,
): Promise<void> {
    const bodyText = (await page.locator("body").innerText()).toUpperCase();

    if (!bodyText.includes(payload.plan.name.toUpperCase())) {
        throw new Error("Order summary plan mismatch");
    }

    const street = payload.connectionAddress.mainAddress.streetName.toUpperCase();
    if (street && !bodyText.includes(street)) {
        throw new Error("Order summary address mismatch");
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
    const field = page
        .getByLabel(label)
        .first()
        .or(page.getByPlaceholder(label).first());

    if (!(await field.count())) {
        return;
    }

    if (slow) {
        await field.fill("");
        await field.pressSequentially(value, { delay: 80 });
        return;
    }

    await field.fill(value);
}

export async function selectIf(
    page: Page,
    label: RegExp,
    value: string,
): Promise<void> {
    const field = page.getByLabel(label).first();
    if (!(await field.count())) {
        return;
    }

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
    const field = page.getByLabel(label).first();
    if ((await field.count()) && !(await field.isChecked())) {
        await field.check();
    }
}

export function escapeRx(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
