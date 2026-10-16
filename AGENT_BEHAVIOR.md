# Agent behaviour

The runner intentionally uses a hybrid model rather than asking an LLM to drive every click.

## Normal journey
Known, high-confidence steps run through deterministic Playwright helpers. Every important action is followed by state verification.

## Unexpected pages and UI drift
When an expected safe state is missing, the recovery layer observes a redacted page representation and asks the configured AI model to select from visible candidates. The model may choose only a safe navigation or dismiss action. The runner then verifies that the page changed or the expected state was reached and records an L3 healing event.

The model is never allowed to invent customer data. If an unexpected page introduces a required form field that cannot be answered from the input payload, the run escalates rather than guessing.

## Human handoff
Email OTP pauses the run with `waiting_for_human`. The same Playwright browser/context remains alive. The UI displays a Human action required card. The submitted OTP is passed directly to the deterministic browser runner and is never sent to the AI model or agent trace. After verification, the run continues from the same browser session.

CAPTCHA and other guarded states are not free-form healed.

## Payment boundary
The AI never receives PAN/CVV or payment DOM values. `cardRef` is resolved only inside the deterministic payment executor. Live preview capture is disabled before payment fields are populated and failure screenshots remain disabled while sensitive payment mode is active. The final transaction screenshot is captured only after payment UI is gone.

## Mutation demo
Mutation mode changes only the DOM inside the isolated Playwright browser session. It does not modify the Tangerine server or upstream website. The controlled mutation changes safe non-payment UI details so the recovery ladder can demonstrate resilience.