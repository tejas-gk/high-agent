import type { Page } from "playwright";

export type Candidate = {
  id: number;
  ref: string;
  tag: string;
  role: string;
  text: string;
  name: string;
  placeholder: string;
  type: string;
  label: string;
  testId?: string;
  landmark?: string;
  fingerprint?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
};

export type Observation = {
  url: string;
  title: string;
  headings: string[];
  candidates: Candidate[];
  bodyText: string;
  accessibilityTree?: string;
  screenshotDataUrl?: string;
};

function redact(input: string) {
  return input
    .replace(/\b\d{12,19}\b/g, "[REDACTED_CARD]")
    .replace(/\b(?:cvv|cvc|security code)\s*[:=]?\s*\d{3,4}\b/gi, "[REDACTED_CVV]");
}

export async function observe(page: Page): Promise<Observation> {
  const observation = await page.evaluate(() => {
    const interactiveElements = Array.from(document.querySelectorAll(
      "button,a,input,select,textarea,[role=button],[role=radio],[role=checkbox]",
    )) as HTMLElement[];

    const candidates = interactiveElements.filter((element) => {
      if ((element as HTMLInputElement).type === "hidden") return false;
      const b = element.getBoundingClientRect();
      if (b.width <= 0 || b.height <= 0) return false;
      const style = getComputedStyle(element);
      return style.visibility !== "hidden" && style.display !== "none";
    }).slice(0, 40).map((element, index) => {
      const ref = `ai-${index + 1}`;
      element.setAttribute("data-ai-id", ref);
      const tag = element.tagName.toLowerCase();
      const input = element as HTMLInputElement;
      const id = element.getAttribute("id") ?? "";
      const aria = element.getAttribute("aria-label") ?? "";
      let label = aria;
      if (!label && id) {
        try { label = document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent ?? ""; } catch {}
      }
      if (!label) label = element.closest("label")?.textContent ?? "";
      const checkable = /checkbox|radio/i.test(input.type || "") || /radio|checkbox/i.test(element.getAttribute("role") || "");
      const sensitive = /card|cvv|cvc|security.?code|expiry/i.test(
        [input.name, input.id, aria, label, input.placeholder].filter(Boolean).join(" "),
      );
      let value = "";
      if (!sensitive && tag === "select") {
        const s = element as HTMLSelectElement;
        value = s.options?.[s.selectedIndex]?.textContent ?? s.value ?? "";
      } else if (!sensitive && (tag === "textarea" || (tag === "input" && !checkable))) value = input.value ?? "";
      const landmarkEl = element.closest("form,main,section,nav,[role=dialog],[role=region]");
      const landmark = landmarkEl
        ? (landmarkEl.getAttribute("aria-label") || landmarkEl.querySelector("h1,h2,h3")?.textContent || landmarkEl.getAttribute("role") || landmarkEl.tagName)
        : "";
      const testId = element.getAttribute("data-testid") || element.getAttribute("data-test") || element.getAttribute("data-cy") || "";
      const fingerprint = [tag, element.getAttribute("role") || "", input.type || "", input.name || "", label || "", input.placeholder || "", landmark || ""]
        .join("|").replace(/\s+/g, " ").trim().slice(0, 220);
      return {
        id: index + 1, ref, tag,
        role: (element.getAttribute("role") ?? "").slice(0, 30),
        text: /input|select|textarea/.test(tag) ? "" : (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80),
        name: (aria || input.name || "").replace(/\s+/g, " ").trim().slice(0, 80),
        placeholder: (input.placeholder || "").replace(/\s+/g, " ").trim().slice(0, 80),
        type: (input.type || "").slice(0, 30),
        label: (label || "").replace(/\s+/g, " ").trim().slice(0, 80),
        testId: testId || undefined,
        landmark: (landmark || "").replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
        fingerprint: fingerprint || undefined,
        value: value.replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
        checked: checkable ? !!input.checked : undefined,
        disabled: (element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true" || undefined,
      };
    });

    return {
      url: location.href,
      title: (document.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
      headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 8)
        .map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 100)),
      candidates,
      bodyText: (document.body.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1800),
    };
  });

  observation.bodyText = redact(observation.bodyText);
  const paymentRisk = /card number|cvv|cvc|security code|payment details|pay now/i.test(
    `${observation.title} ${observation.headings.join(" ")} ${observation.bodyText}`,
  );
  if (!paymentRisk) {
    const aria = await page.locator("body").ariaSnapshot({ timeout: 2500 }).catch(() => "");
    observation.accessibilityTree = redact(aria).slice(0, 6000);
    if (process.env.AI_VISION_ENABLED === "true") {
      const shot = await page.screenshot({ type: "jpeg", quality: 28, fullPage: false, animations: "disabled" }).catch(() => null);
      if (shot) observation.screenshotDataUrl = `data:image/jpeg;base64,${shot.toString("base64")}`;
    }
  }
  return observation;
}
