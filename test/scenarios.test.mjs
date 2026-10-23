import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadMenu, priceTicket } from "../src/menu.mjs";
import { BASELINE_CHECKS, CHECKS } from "../src/policies.mjs";
import { loadScenarios, scriptTurn, validateScenario } from "../src/score.mjs";

const menu = loadMenu(fileURLToPath(new URL("../menu/menu.json", import.meta.url)));
const scenarios = loadScenarios(fileURLToPath(new URL("../scenarios", import.meta.url)));
const byTag = (tag) => scenarios.filter((s) => s.tags.includes(tag));

test("there are at least 25 valid scenarios with unique ids", () => {
  assert.ok(scenarios.length >= 25, `${scenarios.length} scenarios`);
  assert.equal(new Set(scenarios.map((s) => s.id)).size, scenarios.length);
  for (const s of scenarios) assert.deepEqual(validateScenario(s), [], s.id);
});

test("every expected ticket is valid and its totals match the menu", () => {
  for (const s of scenarios.filter((x) => x.expected.ticket)) {
    const p = priceTicket(menu, s.expected.ticket);
    assert.deepEqual(p.errors, [], s.id);
    const t = s.expected.ticket.totals;
    assert.deepEqual(
      [t.subtotal, t.delivery_fee, t.tax, t.total].map((v) => Math.round(v * 100)),
      [p.subtotal_cents, p.delivery_fee_cents, p.tax_cents, p.total_cents],
      s.id,
    );
  }
});

test("every scenario runs the baseline policy checks", () => {
  for (const s of scenarios) for (const id of BASELINE_CHECKS) assert.ok(s.policy_checks.includes(id), `${s.id} is missing ${id}`);
});

test("scenarios cover every behaviour the pack promises", () => {
  const required = ["simple", "modifiers", "half-and-half", "extra-light-no", "quantity-change", "deals", "eligibility", "upsell", "delivery-zone", "store-hours", "allergen", "payment", "prank", "abuse", "escalation", "language", "barge-in", "correction", "silence"];
  for (const tag of required) assert.ok(byTag(tag).length > 0, `no scenario tagged ${tag}`);
  const outcomes = new Set(scenarios.map((s) => s.expected.outcome));
  for (const outcome of ["order_placed", "handoff_payment", "escalate", "decline", "abandoned"]) assert.ok(outcomes.has(outcome), outcome);
});

test("scenario-specific checks have what they need in the script", () => {
  for (const s of scenarios) {
    const turns = s.caller_turns.map(scriptTurn);
    const marked = (mark) => turns.some((t) => t.marks.includes(mark));
    if (s.policy_checks.includes("escalate_on_request")) assert.ok(marked("request_human"), s.id);
    if (s.policy_checks.includes("language_followed")) assert.ok(marked("switch_language"), s.id);
    if (s.policy_checks.includes("barge_in_yield")) assert.ok(marked("barge_in"), s.id);
    if (s.policy_checks.includes("silence_handling")) assert.ok(turns.some((t) => t.silence_ms), s.id);
    if (s.policy_checks.includes("required_phrases")) assert.ok(s.required_phrases?.length, s.id);
    if (s.tags.includes("allergen")) assert.ok(s.policy_checks.includes("allergen_logged"), s.id);
    if (s.expected.outcome === "handoff_payment") assert.ok(s.policy_checks.includes("payment_handoff"), s.id);
    if (["escalate", "decline", "abandoned"].includes(s.expected.outcome)) assert.ok(s.policy_checks.includes("no_order_submitted"), s.id);
    if (s.expected.ticket) assert.ok(s.policy_checks.includes("readback_before_submit"), s.id);
  }
});

test("every policy check is used by at least one scenario and has a description", () => {
  for (const [id, check] of Object.entries(CHECKS)) {
    assert.ok(check.description, id);
    assert.ok(scenarios.some((s) => s.policy_checks.includes(id)), `${id} is unused`);
  }
});

test("the validator rejects malformed scenarios", () => {
  const base = scenarios.find((s) => s.expected.ticket);
  const broken = (patch) => validateScenario({ ...structuredClone(base), ...patch });
  assert.match(broken({ id: "Bad Id" }).join(), /id must be/);
  assert.match(broken({ expected: { outcome: "maybe" } }).join(), /expected.outcome/);
  assert.match(broken({ expected: { outcome: "order_placed" } }).join(), /expected.ticket is required/);
  assert.match(broken({ expected: { outcome: "decline", ticket: base.expected.ticket } }).join(), /must be absent/);
  assert.match(broken({ policy_checks: ["vibes"] }).join(), /unknown policy check "vibes"/);
  assert.match(broken({ caller_turns: [{ marks: ["shout"] }] }).join(), /needs "say" or "silence_ms".*unknown mark/);
  assert.match(broken({ context: {} }).join(), /context.now/);
});
