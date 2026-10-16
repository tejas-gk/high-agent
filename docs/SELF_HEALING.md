# Self-healing policy

The recovery ladder is bounded by safety rather than arbitrary autonomous clicking.

- **L0:** re-observe, wait, scroll, dismiss a harmless overlay, retry.
- **L1:** deterministic fallback in the required order: accessible role/name, label, test id, visible text, nearby landmark, then DOM fingerprint.
- **L2:** AI semantic grounding over a redacted accessibility snapshot and pruned candidates. If `AI_VISION_ENABLED=true`, the same call also receives a low-quality screenshot; payment pages are never captured.
- **L3:** goal-state replanning. Checkout is routed from the page that is actually visible, so contact/service/connection/donation pages may be reordered. Unknown forms are mapped only to payload-backed values; new values are never invented.
- **L4:** escalate when confidence is low, a guarded state is reached, or any retry/heal/runtime/model-call/model-cost budget is exhausted.

A heal is not considered successful merely because the DOM changed. L3 verifies an independent milestone: the expected locator appears, the detected journey stage changes, or the acted control disappears while the structural state signature also changes.

OTP, CAPTCHA, card fields and final Pay Now remain guarded. Page content is untrusted data, never instructions.

Budgets are configurable with `AGENT_MAX_RUNTIME_MS`, `AGENT_MAX_HEALS`, `AGENT_MAX_RETRIES_PER_STEP`, `AGENT_MAX_MODEL_CALLS`, `AGENT_MAX_MODEL_COST_USD` and `AI_ESTIMATED_COST_PER_CALL_USD`.
