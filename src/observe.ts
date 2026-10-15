import type { Page } from "playwright";

export type Candidate = {
  id: number;
  tag: string;
  role: string;
  text: string;
  name: string;
  placeholder: string;
  type: string;
};

export type Observation = {
  url: string;
  title: string;
  headings: string[];
  candidates: Candidate[];
  bodyText: string;
};

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 180);
}

function toCandidate(element: Element, index: number): Candidate {
  const htmlElement = element as HTMLElement;

  return {
    id: index + 1,
    tag: htmlElement.tagName.toLowerCase(),
    role: htmlElement.getAttribute("role") ?? "",
    text: cleanText(htmlElement.textContent),
    name: cleanText(
      htmlElement.getAttribute("aria-label") ||
        htmlElement.getAttribute("name"),
    ),
    placeholder: cleanText(htmlElement.getAttribute("placeholder")),
    type: cleanText(htmlElement.getAttribute("type")),
  };
}

export async function observe(page: Page): Promise<Observation> {
  return page.evaluate(() => {
    const interactiveElements = Array.from(
      document.querySelectorAll(
        "button,a,input,select,textarea,[role=button],[role=radio],[role=checkbox]",
      ),
    ) as HTMLElement[];

    const candidates = interactiveElements
      .filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      })
      .slice(0, 40)
      .map((element, index) => toCandidate(element, index));

    return {
      url: location.href,
      title: document.title,
      headings: Array.from(document.querySelectorAll("h1,h2,h3"))
        .slice(0, 12)
        .map((heading) => cleanText(heading.textContent)),
      candidates,
      bodyText: cleanText(document.body.innerText).slice(0, 2500),
    };
  });
}
