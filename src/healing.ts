import type { Locator, Page } from "playwright";
import { chooseCandidate } from "./ai";
import { observe } from "./observe";
import type { HealEvent } from "./types";

export async function semanticLocator(
    page: Page,
    args: {
        step: number;
        intent: string;
        names: string[];
        guarded?: boolean;
        modelBudget: { used: number; max: number };
    },
): Promise<{ locator: Locator; heal?: HealEvent }> {
    if (args.guarded) {
        throw new Error("Guarded step cannot use free-form healing");
    }

    for (const n of args.names) {
        const byText = page
            .locator(
                "button, a, [role='button'], input[type='submit'], input[type='button']",
            )
            .filter({ hasText: new RegExp(escapeRx(n), "i") });

        for (let index = 0; index < (await byText.count()); index += 1) {
            const candidate = byText.nth(index);
            if (await candidate.isVisible().catch(() => false)) {
                return {
                    locator: candidate,
                    heal: {
                        step: args.step,
                        level: "L1",
                        intent: args.intent,
                        reason: "Recovered by visible action text",
                        newLocator: `button|a text~${n}`,
                        evidence: "Visible action text matched intent",
                        verified: false,
                    },
                };
            }
        }

        const visibleText = page.getByText(new RegExp(escapeRx(n), "i")).first();
        if (await visibleText.count()) {
            return {
                locator: visibleText,
                heal: {
                    step: args.step,
                    level: "L1",
                    intent: args.intent,
                    reason: "Recovered by visible text",
                    newLocator: `text~${n}`,
                    evidence: "Visible text matched intent",
                    verified: false,
                },
            };
        }
    }

    if (args.modelBudget.used >= args.modelBudget.max) {
        throw new Error("Model-call budget exhausted");
    }

    const o = await observe(page);
    const choice = await chooseCandidate({
        intent: args.intent,
        observation: o,
        candidates: o.candidates,
    });
    args.modelBudget.used++;

    if (!choice || choice.confidence < 0.7) {
        throw new Error("No high-confidence semantic recovery");
    }

    const c = o.candidates.find((x) => x.id === choice.candidateId);
    if (!c) {
        throw new Error("AI selected unknown candidate");
    }

    const interactive = page
        .locator(
            "button:visible,a:visible,input:visible,select:visible,textarea:visible,[role=button]:visible,[role=radio]:visible,[role=checkbox]:visible",
        )
        .nth(choice.candidateId - 1);
    return {
        locator: interactive,
        heal: {
            step: args.step,
            level: "L2",
            intent: args.intent,
            reason: choice.reason,
            newLocator: `candidate:${choice.candidateId}`,
            confidence: choice.confidence,
            evidence: JSON.stringify(c),
            verified: false,
        },
    };
}

function escapeRx(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
