# NBN Agent Control Room

A structured Next.js + shadcn-style dashboard and Playwright agent for the CIMET hands-on NBN sign-up exercise.

## Architecture

`payload -> validation/normalisation -> job runner -> Playwright observe/act/verify -> L0/L1/L2/L3 healing -> isolated payment executor -> 3DS -> transaction ID -> report + leak scan`

The model is **not** used for normal form filling. It is a bounded fallback for semantic re-grounding when deterministic locators stop working. Payment, OTP, CAPTCHA and final Pay Now are guarded and never free-form healed.

## Run

```bash
npm install
npx playwright install chromium
cp .env.example .env.local
npm run dev
```

Open `http://localhost:3000` and run the supplied sample payload. The app permits only `test-tangerine.hipeely.com` and one active job at a time.

CLI single-command runner:

```bash
npm run agent -- payload.example.json
```

Mutation demo:

```bash
npm run agent -- payload.example.json --mutate
```

Leak check:

```bash
npm run leak-check
```

## AI healing

L0 re-observes/retries. L1 tries role/name, label, test id, visible text, landmarks and DOM fingerprint. L2 grounds the model on a redacted accessibility snapshot plus pruned controls, and can include a screenshot with `AI_VISION_ENABLED=true` (never on payment pages). L3 is goal-state based: checkout pages can be reordered and new payload-answerable fields can be handled without changing code. Every heal needs an independent structural postcondition. Configure an OpenAI-compatible chat-completions endpoint with `AI_API_KEY`, `AI_API_URL`, and `AI_MODEL`.

Run budgets cover total time, retries per step, heal count, model calls and estimated model cost; each appears in the final report.

## Payment boundary

The job payload contains only `vault://test-cards/visa-success`. Portal host approval is configuration-driven through `PORTAL_ALLOWED_HOSTS` (defaulting to the supplied Tangerine test host), so adding another test retailer does not require changing the runner's origin guard. The goal-state recovery layer handles unknown/reordered payload-backed forms without retailer-specific step-order code.

 `src/vault.ts` resolves the public exercise test card just-in-time for one job. `src/payment.ts` is deterministic and never calls the model. PAN/CVV are cleared from the local card object after use, payment screenshots are not taken, and saved artifacts are scanned for the test PAN/CVV.

The 3DS test branch selects `Authenticated (ECI 05)` only in the provided test environment. Unknown payment state is not automatically retried.

## Mutation layer

`src/mutation.ts` injects a browser-session-only mutation before page scripts run. It renames an ID, changes a safe non-payment label, moves the control in the DOM, and injects a dismissible popup. It does not modify Tangerine's server and does not mutate payment controls.

## Interview demo

1. Run clean journey.
2. Show JSON report and transaction ID.
3. Run with mutation enabled.
4. Show healing event and independent postcondition.
5. Run `npm run leak-check`.
6. Keep a screen recording of the clean run as backup.

## Important

This project is intentionally locked to the provided test environment and public test data. Do not use real customer or card data.
