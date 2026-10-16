# Human handoff operator flow

When the job status changes to `waiting_for_human`, the browser has **not** been closed or restarted.

1. Read the Human action required card in the dashboard.
2. Complete the requested guarded action. For email OTP, copy the code from the test inbox into the dashboard field.
3. Select **Submit & resume agent**.
4. The value is sent directly to the deterministic Playwright runner. It is not included in Sarvam prompts or the agent trace.
5. The runner verifies the guarded page has cleared and continues from the same browser session.

If the OTP is rejected, the runner escalates rather than guessing or repeatedly submitting values. A pending handoff expires after 10 minutes.

CAPTCHA is a stop/handoff condition. Payment is also a stop/handoff condition by default: the agent parks on the payment page, never touches card fields, leaves the browser open, and waits for the human to pay. Unattended vault-card payment is opt-in via `AUTO_PAY=true`.