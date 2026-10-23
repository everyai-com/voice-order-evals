import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadMenu } from "../src/menu.mjs";
import { latencyPairs, loadScenarios, parseRuns, percentile, redact, scoreAll, scoreRun } from "../src/score.mjs";

const path = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const menu = loadMenu(path("menu/menu.json"));
const scenarios = loadScenarios(path("scenarios"));
const runsOf = (file) => parseRuns(readFileSync(path(file), "utf8"));
const good = runsOf("examples/runs-good.jsonl");
const flawed = runsOf("examples/runs-flawed.jsonl");
const scenario = (id) => scenarios.find((s) => s.id === id);
const goodRun = (id) => structuredClone(good.runs.find((r) => r.scenario_id === id));

// What the flawed example agent gets wrong, scenario by scenario.
const FLAWED = {
  "abuse-01-abusive-caller": { policies: ["abuse_handling"] },
  "allergen-01-peanut-question": { policies: ["no_allergen_promise", "allergen_logged"] },
  "barge-01-size-correction": { ticket: false, policies: ["barge_in_yield"] },
  "deal-02-two-medium-extra-topping": { ticket: false, policies: ["no_invented_items", "required_phrases"] },
  "deal-03-carryout-only-switch-to-pickup": { ticket: false, policies: ["required_phrases"] },
  "escalate-01-asks-for-human": { policies: ["escalate_on_request"] },
  "hours-01-after-close": { outcome: false, policies: ["store_hours", "no_order_submitted"] },
  "lang-01-switch-to-spanish": { policies: ["language_followed"] },
  "mod-01-half-and-half": { ticket: false },
  "mod-02-extra-light-no": { ticket: false },
  "payment-01-card-read-aloud": { outcome: false, ticket: false, policies: ["no_card_by_voice", "payment_handoff"] },
  "prank-01-absurd-quantity": { outcome: false, policies: ["order_sanity", "no_order_submitted", "required_phrases"] },
  "prank-02-off-menu-items": { ticket: false, policies: ["no_invented_items", "required_phrases"] },
  "qty-01-change-quantity": { ticket: false },
  "silence-01-no-response": { policies: ["silence_handling"] },
  "simple-02-cheese-and-knots-delivery": { ticket: false, policies: ["no_invented_items"] },
  "simple-03-wings-and-soda": { policies: ["ai_disclosure"] },
  "upsell-01-declined-once": { policies: ["upsell_once"] },
  "zone-01-out-of-zone-switch-to-pickup": { ticket: false, policies: ["delivery_rules", "required_phrases"] },
};

test("both example files parse cleanly and cover every scenario", () => {
  for (const file of [good, flawed]) {
    assert.deepEqual(file.errors, []);
    assert.deepEqual(file.runs.map((r) => r.scenario_id).sort(), scenarios.map((s) => s.id).sort());
  }
});

test("the good example agent passes every scenario and the latency budget", () => {
  const report = scoreAll({ scenarios, runs: good.runs, menu });
  for (const r of report.results) assert.equal(r.pass, true, `${r.id}: ${JSON.stringify(r.policies.filter((p) => !p.ok))} ${JSON.stringify(r.ticket.problems ?? [])}`);
  assert.equal(report.ok, true);
  assert.equal(report.summary.latency.within_budget, true);
  assert.ok(report.summary.latency.p95_ms <= 800);
});

test("the flawed example agent fails exactly where it was built to fail", () => {
  const report = scoreAll({ scenarios, runs: flawed.runs, menu });
  for (const r of report.results) {
    const expected = FLAWED[r.id];
    const failing = r.policies.filter((p) => !p.ok).map((p) => p.id).sort();
    if (!expected) {
      assert.equal(r.pass, true, `${r.id} should pass but failed: ${failing.join(", ")} ${JSON.stringify(r.ticket.problems ?? [])}`);
      continue;
    }
    assert.equal(r.pass, false, r.id);
    assert.deepEqual(failing, [...(expected.policies ?? [])].sort(), `${r.id} policy failures`);
    assert.equal(r.outcome.ok, expected.outcome ?? true, `${r.id} outcome`);
    if (r.ticket.checked) assert.equal(r.ticket.exact, expected.ticket ?? true, `${r.id} ticket`);
  }
  assert.equal(report.summary.passed, scenarios.length - Object.keys(FLAWED).length);
  assert.equal(report.summary.latency.within_budget, false, "the flawed agent is also too slow");
  assert.equal(report.ok, false);
});

test("ticket problems are described in plain language", () => {
  const report = scoreAll({ scenarios, runs: flawed.runs, menu });
  const problems = (id) => report.results.find((r) => r.id === id).ticket.problems.join("\n");
  assert.match(problems("qty-01-change-quantity"), /quantity: large pepperoni pizza expected x3, got x2/);
  assert.match(problems("mod-01-half-and-half"), /missing: large cheese pizza: \+ mushrooms \(right half\)/);
  assert.match(problems("simple-02-cheese-and-knots-delivery"), /totals.delivery_fee: ticket says \$2.99, menu gives \$3.99/);
  assert.match(problems("deal-03-carryout-only-switch-to-pickup"), /not available for delivery/);
});

test("card numbers never appear in a report", () => {
  const report = redact(scoreAll({ scenarios, runs: flawed.runs, menu }));
  assert.doesNotMatch(JSON.stringify(report), /4111\s?1111\s?1111\s?1111/);
});

test("an outcome that contradicts the events fails", () => {
  const run = goodRun("escalate-01-asks-for-human");
  run.events = run.events.filter((e) => e.type !== "transfer");
  const result = scoreRun(scenario("escalate-01-asks-for-human"), run, menu);
  assert.equal(result.outcome.ok, false);
  assert.match(result.outcome.note, /needs a transfer event/);
});

test("a missing ticket fails the ticket check", () => {
  const run = goodRun("simple-01-large-pepperoni-pickup");
  run.ticket = null;
  const result = scoreRun(scenario("simple-01-large-pepperoni-pickup"), run, menu);
  assert.equal(result.ticket.exact, false);
  assert.deepEqual(result.ticket.problems, ["no ticket in the run"]);
});

test("missing, unknown and duplicate runs are reported", () => {
  const runs = good.runs.filter((r) => r.scenario_id !== "simple-01-large-pepperoni-pickup");
  runs.push({ ...good.runs[0] }, { ...good.runs[0], scenario_id: "no-such-scenario" });
  const report = scoreAll({ scenarios, runs, menu });
  assert.deepEqual(report.summary.missing_runs, ["simple-01-large-pepperoni-pickup"]);
  assert.deepEqual(report.summary.unknown_runs, ["no-such-scenario"]);
  assert.deepEqual(report.summary.duplicate_runs, [good.runs[0].scenario_id]);
  assert.equal(report.ok, false);
  const partial = scoreAll({ scenarios, runs: runs.slice(0, 3), menu, allowMissing: true });
  assert.equal(partial.summary.scenarios, 3);
});

test("latency is end of caller speech to first agent audio, with nearest-rank percentiles", () => {
  const turns = [
    { role: "agent", start_ms: 0, end_ms: 1000 },
    { role: "caller", start_ms: 1500, end_ms: 2500 },
    { role: "agent", start_ms: 3100, end_ms: 4000 },
    { role: "caller", start_ms: 4200, end_ms: 5000 },
    { role: "agent", start_ms: 4900, end_ms: 6000 },
    { role: "agent", start_ms: 12000, end_ms: 13000 },
  ];
  assert.deepEqual(latencyPairs(turns), { pairs: [600], overlaps: 1 });
  assert.equal(percentile([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 0.95), 1000);
  assert.equal(percentile([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000], 0.5), 500);
  assert.equal(percentile([], 0.5), null);
});

test("the latency budget can be changed", () => {
  assert.equal(scoreAll({ scenarios, runs: good.runs, menu, budgetMs: 500 }).summary.latency.within_budget, false);
  assert.equal(scoreAll({ scenarios, runs: flawed.runs, menu, budgetMs: 2000 }).summary.latency.within_budget, true);
});

test("invalid run lines are reported with line numbers", () => {
  const { runs, errors } = parseRuns(['{"scenario_id":"x","turns":[],"outcome":"order_placed"}', "not json", '{"scenario_id":"y","turns":[{"role":"bot","text":"hi","start_ms":0}],"outcome":"maybe"}', ""].join("\n"));
  assert.equal(runs.length, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^line 2:/);
  assert.match(errors[1], /^line 3: .*role must be.*outcome must be/);
});
