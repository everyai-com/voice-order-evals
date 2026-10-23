# Contributing

This is a v0.1 draft. The most useful contributions:

- **Scenarios** for phone-ordering behaviour the pack does not cover yet: substitutions, order cancellation, repeat orders, accents and disfluent speech written out as text, coupons, scheduled orders.
- **False positives and misses** in the text checks. Send the agent sentence that was misjudged and what the right call was.
- **Menu shapes** the pricing engine cannot express (choice groups in combo meals, per-store prices, tax by item class).

## Writing a scenario

1. Copy a similar file in `scenarios/` and give it a new `id`; the file name must be `<id>.json`.
2. Write the caller turns as a script. Mark special turns with `marks` (`request_human`, `switch_language`, `barge_in`), or use `{ "silence_ms": N }` for silence.
3. Write the expected ticket, then compute its totals: `node bin/voe.mjs price ticket.json`.
4. List every policy check that applies, including the baseline ones (the tests enforce them).
5. Run `npm test`. The tests recompute every expected total from the menu and check that each scenario-specific check has what it needs.

Scenarios must be synthetic. No real restaurant, menu, store, person, phone number, address or card number. Card numbers in scenarios must be published test numbers.

## Ground rules

- No runtime dependencies. Node.js 20 or later.
- Scoring stays deterministic: no model calls in the scorer.
- Add a test for any behaviour you change.
