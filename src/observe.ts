import type { Page } from "playwright";

export type Candidate = {
  id: number;
  tag: string;
  role: string;
  text: string;
  name: string;
  placeholder: string;
  type: string;
  label: string;
};

export type Observation = {
  url: string;
  title: string;
  headings: string[];
  candidates: Candidate[];
  bodyText: string;
};

export async function observe(page: Page): Promise<Observation> {
  // IMPORTANT: everything referenced inside page.evaluate must be defined in
  // the browser context. Do not call module-level helpers from this callback.
  return page.evaluate(() => {
    const clean = (value: string | null | undefined, max = 180): string =>
      (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

    const interactiveElements = Array.from(
      document.querySelectorAll(
        "button,a,input,select,textarea,[role=button],[role=radio],[role=checkbox]",
      ),
    ) as HTMLElement[];

    const candidates = interactiveElements
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return (
          bounds.width > 0 &&
          bounds.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      })
      .slice(0, 60)
      .map((element, index) => ({
        id: index + 1,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? "",
        text: clean(element.textContent),
        name: clean(
          element.getAttribute("aria-label") || element.getAttribute("name"),
        ),
        placeholder: clean(element.getAttribute("placeholder")),
        type: clean(element.getAttribute("type")),
        label: clean((() => {
          const aria = element.getAttribute("aria-label");
          if (aria) return aria;
          const id = element.getAttribute("id");
          if (id) {
            const explicit = document.querySelector(`label[for="${CSS.escape(id)}"]`);
            if (explicit?.textContent) return explicit.textContent;
          }
          const wrapping = element.closest("label");
          return wrapping?.textContent || "";
        })()),
      }));

    return {
      url: location.href,
      title: document.title,
      headings: Array.from(document.querySelectorAll("h1,h2,h3"))
        .slice(0, 12)
        .map((heading) => clean(heading.textContent)),
      candidates,
      bodyText: clean(document.body.innerText, 2500),
    };
  });
}
