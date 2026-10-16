import type { Page } from "playwright";

export type Candidate = {
  id: number;
  /** Stable locator stamped as data-ai-id in the DOM; use `[data-ai-id="..."]` to act. Survives re-query ordering drift. */
  ref: string;
  tag: string;
  role: string;
  text: string;
  name: string;
  placeholder: string;
  type: string;
  label: string;
  /** Current value for inputs/textareas/selects (truncated). Lets AI skip already-filled fields. */
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
};

export async function observe(page: Page): Promise<Observation> {
  // IMPORTANT: everything inside this callback runs in the browser context and
  // must be self-contained. Do NOT bind named helper functions here: tsx/esbuild
  // (keepNames) rewrites `const fn = () => {}` / `function fn(){}` into
  // `__name(fn, ...)`, and `__name` does not exist in the page. Anonymous arrow
  // callbacks passed inline (e.g. .map(...)) are safe. Cleaning is therefore
  // inlined rather than factored into a `clean()` helper.
  return page.evaluate(() => {
    const interactiveElements = Array.from(
      document.querySelectorAll(
        "button,a,input,select,textarea,[role=button],[role=radio],[role=checkbox]",
      ),
    ) as HTMLElement[];

    const candidates = interactiveElements
      .filter((element) => {
        if ((element as HTMLInputElement).type === "hidden") return false;
        const bounds = element.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) return false;
        const style = window.getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none";
      })
      .slice(0, 40)
      .map((element, index) => {
        // Stamp a stable id so the runner can locate by attribute instead of
        // nth() index, which drifts when the DOM re-renders between observe
        // and action (the root cause of mis-clicks / mis-fills).
        const ref = `ai-${index + 1}`;
        element.setAttribute("data-ai-id", ref);
        const tag = element.tagName.toLowerCase();
        const input = element as HTMLInputElement;
        const isCheckable = /checkbox|radio/i.test(input.type || "") || element.getAttribute("role") === "radio" || element.getAttribute("role") === "checkbox";
        let value = "";
        if (tag === "select") {
          const sel = element as HTMLSelectElement;
          value = (sel.options?.[sel.selectedIndex]?.textContent ?? sel.value ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        } else if (tag === "textarea" || (tag === "input" && !isCheckable)) {
          value = (input.value ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
        }
        const aria = element.getAttribute("aria-label") ?? "";
        const id = element.getAttribute("id") ?? "";
        let labelText = aria;
        if (!labelText && id) {
          try {
            const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (explicit?.textContent) labelText = explicit.textContent;
          } catch { /* ignore bad ids */ }
        }
        if (!labelText) {
          const wrapping = element.closest("label");
          if (wrapping?.textContent) labelText = wrapping.textContent;
        }
        return {
          id: index + 1,
          ref,
          tag,
          role: (element.getAttribute("role") ?? "").replace(/\s+/g, " ").trim().slice(0, 20),
          text: tag === "input" || tag === "select" || tag === "textarea" ? "" : (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
          name: (element.getAttribute("aria-label") || element.getAttribute("name") || "").replace(/\s+/g, " ").trim().slice(0, 60),
          placeholder: (element.getAttribute("placeholder") ?? "").replace(/\s+/g, " ").trim().slice(0, 60),
          type: (element.getAttribute("type") ?? "").replace(/\s+/g, " ").trim().slice(0, 20),
          label: labelText.replace(/\s+/g, " ").trim().slice(0, 60),
          value: value || undefined,
          checked: isCheckable ? !!input.checked : undefined,
          disabled: (element as HTMLButtonElement).disabled || element.getAttribute("aria-disabled") === "true" ? true : undefined,
        };
      });

    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .slice(0, 8)
      .map((heading) => (heading.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 80));

    return {
      url: location.href,
      title: (document.title ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
      headings,
      candidates,
      bodyText: (document.body.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1200),
    };
  });
}
