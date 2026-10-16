import type { Page } from "playwright";

export async function installMutationLayer(page: Page): Promise<void> {
  // NOTE: the injected callback must avoid named function bindings. tsx/esbuild
  // (keepNames) rewrites `const apply = () => {}` to reference an undefined
  // `__name` inside the page. Passing the logic as an anonymous IIFE argument
  // keeps it reusable without a named binding.
  await page.addInitScript(() => {
    ((apply: () => void) => {
      new MutationObserver(apply).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });

      window.addEventListener("load", apply);
      setTimeout(apply, 1200);
    })(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const target = buttons.find((button) =>
        /build your plan|order now|next|continue/i.test(
          button.textContent || "",
        ),
      );

      if (!target || target.getAttribute("data-agent-mutated")) {
        return;
      }

      target.setAttribute("data-agent-mutated", "true");

      if (target.id) {
        target.id = `mutated-${Math.random().toString(36).slice(2, 8)}`;
      }

      if (/build your plan/i.test(target.textContent || "")) {
        target.textContent = "See available plans";
      } else if (/continue|next/i.test(target.textContent || "")) {
        target.textContent = "Proceed";
      }

      const parent = target.parentElement;
      if (parent) {
        const wrapper = document.createElement("div");
        wrapper.setAttribute("data-layout", "v2-actions");
        parent.insertBefore(wrapper, target);
        wrapper.appendChild(target);
      }

      if (!document.querySelector("[data-agent-demo-popup]")) {
        const popup = document.createElement("div");
        popup.setAttribute("data-agent-demo-popup", "true");
        popup.setAttribute("role", "dialog");
        popup.style.cssText =
          "position:fixed;inset:auto 20px 20px auto;z-index:2147483647;background:white;border:1px solid #ddd;padding:16px;border-radius:12px;box-shadow:0 8px 30px #0002";

        popup.innerHTML =
          '<p style="margin:0 0 8px">Special offer</p><button type="button">Dismiss</button>';

        popup
          .querySelector("button")
          ?.addEventListener("click", () => popup.remove());
        document.body.appendChild(popup);
      }
    });
  });
}
