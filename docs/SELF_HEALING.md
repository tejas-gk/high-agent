# Self-healing policy

The recovery ladder is bounded by safety rather than allowing arbitrary autonomous clicking.

- **L0:** re-observe, wait, scroll, dismiss known harmless overlays, retry.
- **L1:** deterministic semantic locator fallback using visible text/roles/labels.
- **L2:** AI grounding chooses from a redacted list of existing browser candidates.
- **L3:** when a harmless interstitial or reordered page appears, AI may choose a safe navigation/dismiss action, followed by deterministic verification.
- **L4:** escalate when confidence is low, the model budget is exhausted, a new required customer value is needed, or a guarded state appears.

OTP, CAPTCHA, payment fields and final payment controls are never free-form healed. Page content is treated as untrusted data, not model instructions.