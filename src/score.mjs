import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, mergeLines, money, priceTicket, storeStatus } from "./menu.mjs";
import { CHECKS } from "./policies.mjs";
import { maskCards } from "./text.mjs";

export const VERSION = "0.1.0";
export const OUTCOMES = ["order_placed", "handoff_payment", "escalate", "decline", "abandoned"];
export const EVENT_TYPES = ["submit_order", "payment_handoff", "transfer", "end_call", "allergen_logged", "upsell_offer", "tool_call"];
const MARKS = ["request_human", "switch_language", "barge_in"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** A scenario's caller turn as an object: { say, marks, lang } for speech, { silence_ms } for silence. */
export function scriptTurn(turn) {
  return typeof turn === "string" ? { say: turn, marks: [] } : { marks: [], ...turn };
}

export function validateScenario(scenario) {
  const errors = [];
  if (!isObject(scenario)) return ["scenario must be an object"];
  if (typeof scenario.id !== "string" || !/^[a-z0-9-]+$/.test(scenario.id)) errors.push("id must be lowercase letters, digits and dashes");
  if (typeof scenario.title !== "string" || !scenario.title) errors.push("title is required");
  if (!Array.isArray(scenario.tags) || !scenario.tags.length) errors.push("tags must be a non-empty array");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(scenario.context?.now ?? "")) errors.push("context.now must be a local ISO date-time");
  if (!Array.isArray(scenario.caller_turns) || !scenario.caller_turns.length) errors.push("caller_turns must be a non-empty array");
  for (const [i, raw] of (scenario.caller_turns ?? []).entries()) {
    const turn = scriptTurn(raw);
    if (turn.say === undefined && typeof turn.silence_ms !== "number") errors.push(`caller_turns[${i}] needs "say" or "silence_ms"`);
    for (const mark of turn.marks) if (!MARKS.includes(mark)) errors.push(`caller_turns[${i}] has unknown mark "${mark}"`);
  }
  if (!OUTCOMES.includes(scenario.expected?.outcome)) errors.push(`expected.outcome must be one of ${OUTCOMES.join(", ")}`);
  const needsTicket = ["order_placed", "handoff_payment"].includes(scenario.expected?.outcome);
  if (needsTicket && !isObject(scenario.expected.ticket)) errors.push("expected.ticket is required for order_placed and handoff_payment");
  if (!needsTicket && scenario.expected?.ticket) errors.push("expected.ticket must be absent when no order is placed");
  if (!Array.isArray(scenario.policy_checks)) errors.push("policy_checks must be an array");
  for (const id of scenario.policy_checks ?? []) if (!CHECKS[id]) errors.push(`unknown policy check "${id}"`);
  if (scenario.required_phrases !== undefined && !(Array.isArray(scenario.required_phrases) && scenario.required_phrases.every((g) => Array.isArray(g) && g.length))) {
    errors.push("required_phrases must be an array of non-empty arrays of alternatives");
  }
  return errors;
}

export function loadScenarios(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const scenarios = [];
  for (const file of files) {
    let scenario;
    try {
      scenario = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      throw new Error(`${file}: ${error.message}`);
    }
    const errors = validateScenario(scenario);
    if (errors.length) throw new Error(`${file}: ${errors.join("; ")}`);
    if (`${scenario.id}.json` !== file) throw new Error(`${file}: file name must be ${scenario.id}.json`);
    scenarios.push(scenario);
  }
  return scenarios;
}

/** Parses a JSONL runs file. Returns runs plus line-level errors. */
export function parseRuns(text) {
  const runs = [];
  const errors = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const run = JSON.parse(line);
      const problems = validateRun(run);
      if (problems.length) errors.push(`line ${i + 1}: ${problems.join("; ")}`);
      else runs.push(run);
    } catch (error) {
      errors.push(`line ${i + 1}: ${error.message}`);
    }
  });
  return { runs, errors };
}

export function validateRun(run) {
  const errors = [];
  if (!isObject(run)) return ["each line must be a JSON object"];
  if (typeof run.scenario_id !== "string") errors.push("scenario_id is required");
  if (!Array.isArray(run.turns)) errors.push("turns must be an array");
  for (const [i, turn] of (run.turns ?? []).entries()) {
    if (!isObject(turn) || !["caller", "agent"].includes(turn.role)) errors.push(`turns[${i}].role must be "caller" or "agent"`);
    else if (typeof turn.text !== "string") errors.push(`turns[${i}].text must be a string`);
    else if (typeof turn.start_ms !== "number") errors.push(`turns[${i}].start_ms must be a number`);
    else if (turn.role === "caller" && typeof turn.end_ms !== "number") errors.push(`turns[${i}].end_ms is required on caller turns`);
  }
  if (run.events !== undefined && !Array.isArray(run.events)) errors.push("events must be an array");
  for (const [i, event] of (run.events ?? []).entries()) {
    if (!isObject(event) || !EVENT_TYPES.includes(event.type)) errors.push(`events[${i}].type must be one of ${EVENT_TYPES.join(", ")}`);
    else if (typeof event.t_ms !== "number") errors.push(`events[${i}].t_ms must be a number`);
  }
  if (!OUTCOMES.includes(run.outcome)) errors.push(`outcome must be one of ${OUTCOMES.join(", ")}`);
  if (run.ticket !== undefined && run.ticket !== null && !isObject(run.ticket)) errors.push("ticket must be an object or null");
  return errors;
}

function outcomeConsistency(outcome, events) {
  const has = (type) => events.some((e) => e.type === type);
  const rules = {
    order_placed: [has("submit_order"), "needs a submit_order event and no transfer"],
    handoff_payment: [has("submit_order") && has("payment_handoff"), "needs submit_order and payment_handoff events"],
    escalate: [has("transfer") && !has("submit_order"), "needs a transfer event and no submit_order"],
    decline: [!has("submit_order") && !has("transfer"), "needs no submit_order or transfer event"],
    abandoned: [!has("submit_order") && !has("transfer") && has("end_call"), "needs an end_call event and no order or transfer"],
  };
  if (outcome === "order_placed" && has("transfer")) return rules.order_placed[1];
  const [ok, message] = rules[outcome];
  return ok ? null : message;
}

function checkOutcome(scenario, run, events) {
  const expected = scenario.expected.outcome;
  const inconsistency = outcomeConsistency(run.outcome, events);
  if (inconsistency) return { expected, actual: run.outcome, ok: false, note: `outcome "${run.outcome}" ${inconsistency}` };
  const ok = run.outcome === expected;
  return { expected, actual: run.outcome, ok, note: ok ? "as expected" : `expected ${expected}, got ${run.outcome}` };
}

const totalsCents = (totals) => Object.fromEntries(["subtotal", "delivery_fee", "tax", "total"].map((k) => [k, typeof totals?.[k] === "number" ? Math.round(totals[k] * 100) : null]));

function checkTicket(scenario, run, menu, pricing, expectedPricing) {
  const expected = scenario.expected.ticket;
  if (!expected) return { checked: false, exact: null, note: "no ticket expected" };
  if (!pricing) return { checked: true, exact: false, items_match: false, totals_ok: false, problems: ["no ticket in the run"] };

  const problems = [...pricing.errors.map((e) => `invalid: ${e}`)];
  const want = mergeLines(expectedPricing.lines);
  const got = mergeLines(pricing.lines);
  let itemsMatch = true;
  for (const [key, line] of want) {
    const other = got.get(key);
    if (!other) {
      itemsMatch = false;
      problems.push(`missing: ${describe(menu, line.canonical, line.quantity)}`);
    } else if (other.quantity !== line.quantity) {
      itemsMatch = false;
      problems.push(`quantity: ${line.description} expected x${line.quantity}, got x${other.quantity}`);
    }
  }
  for (const [key, line] of got) {
    if (!want.has(key)) {
      itemsMatch = false;
      problems.push(`unexpected: ${describe(menu, line.canonical, line.quantity)}`);
    }
  }

  const fields = ["order_type", ...(expected.order_type === "delivery" ? ["delivery_zip"] : []), ...(expected.payment ? ["payment"] : [])];
  for (const field of fields) {
    if (String(run.ticket[field]) !== String(expected[field])) problems.push(`${field}: expected ${expected[field]}, got ${run.ticket[field]}`);
  }

  const stated = totalsCents(run.ticket.totals);
  const recomputed = { subtotal: pricing.subtotal_cents, delivery_fee: pricing.delivery_fee_cents, tax: pricing.tax_cents, total: pricing.total_cents };
  let totalsOk = pricing.errors.length === 0;
  for (const [key, value] of Object.entries(recomputed)) {
    if (stated[key] !== value) {
      totalsOk = false;
      problems.push(stated[key] === null ? `totals.${key} missing (menu gives ${money(value)})` : `totals.${key}: ticket says ${money(stated[key])}, menu gives ${money(value)}`);
    }
  }
  const exact = itemsMatch && totalsOk && problems.length === 0;
  return { checked: true, exact, items_match: itemsMatch && pricing.errors.length === 0, totals_ok: totalsOk, stated_cents: stated, recomputed_cents: recomputed, problems };
}

/** Nearest-rank percentile of a list of numbers. */
export function percentile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
}

/** End of caller speech to first agent audio, for every agent turn that directly answers a caller turn. */
export function latencyPairs(turns) {
  const pairs = [];
  let overlaps = 0;
  turns.forEach((turn, i) => {
    const previous = turns[i - 1];
    if (turn.role !== "agent" || previous?.role !== "caller") return;
    const gap = turn.start_ms - previous.end_ms;
    if (gap < 0) overlaps++;
    else pairs.push(gap);
  });
  return { pairs, overlaps };
}

export function scoreRun(scenario, run, menu) {
  const turns = [...run.turns].sort((a, b) => a.start_ms - b.start_ms);
  const events = [...(run.events ?? [])].sort((a, b) => a.t_ms - b.t_ms);
  const pricing = run.ticket ? priceTicket(menu, run.ticket) : null;
  const expectedPricing = scenario.expected.ticket ? priceTicket(menu, scenario.expected.ticket) : null;
  const ctx = {
    scenario,
    run,
    menu,
    turns,
    events,
    agentTurns: turns.filter((t) => t.role === "agent"),
    callerTurns: turns.filter((t) => t.role === "caller"),
    scriptTurns: scenario.caller_turns.map(scriptTurn).filter((t) => t.say !== undefined),
    submitted: events.find((e) => e.type === "submit_order") ?? null,
    pricing,
    expectedPricing,
    storeStatus: storeStatus(menu, scenario.context.now),
  };

  const warnings = [];
  if (ctx.callerTurns.length !== ctx.scriptTurns.length) {
    warnings.push(`transcript has ${ctx.callerTurns.length} caller turns, the scenario scripts ${ctx.scriptTurns.length}`);
  }
  const outcome = checkOutcome(scenario, run, events);
  const ticket = checkTicket(scenario, run, menu, pricing, expectedPricing);
  const policies = scenario.policy_checks.map((id) => ({ id, ...CHECKS[id].run(ctx) }));
  const { pairs, overlaps } = latencyPairs(turns);
  const latency = { pairs: pairs.length, p50_ms: percentile(pairs, 0.5), p95_ms: percentile(pairs, 0.95), max_ms: pairs.length ? Math.max(...pairs) : null, overlaps, samples: pairs };
  const pass = outcome.ok && (ticket.checked ? ticket.exact : true) && policies.every((p) => p.ok);
  return { id: scenario.id, title: scenario.title, tags: scenario.tags, agent: run.agent ?? null, pass, outcome, ticket, policies, latency, warnings };
}

/** Scores every scenario that has a run. Scenarios without a run fail unless allowMissing is set. */
export function scoreAll({ scenarios, runs, menu, budgetMs = menu.policies.latency_budget_p95_ms, allowMissing = false }) {
  const byId = new Map();
  const duplicates = [];
  for (const run of runs) {
    if (byId.has(run.scenario_id)) duplicates.push(run.scenario_id);
    else byId.set(run.scenario_id, run);
  }
  const known = new Set(scenarios.map((s) => s.id));
  const unknown = [...byId.keys()].filter((id) => !known.has(id));
  const results = [];
  const missing = [];
  for (const scenario of scenarios) {
    const run = byId.get(scenario.id);
    if (run) results.push(scoreRun(scenario, run, menu));
    else if (!allowMissing) {
      missing.push(scenario.id);
      results.push({ id: scenario.id, title: scenario.title, tags: scenario.tags, pass: false, missing: true, outcome: { expected: scenario.expected.outcome, actual: null, ok: false, note: "no run for this scenario" }, ticket: { checked: false, exact: null }, policies: [], latency: { pairs: 0, samples: [] }, warnings: [] });
    }
  }

  const scored = results.filter((r) => !r.missing);
  const samples = scored.flatMap((r) => r.latency.samples);
  const p95 = percentile(samples, 0.95);
  const latency = {
    pairs: samples.length,
    p50_ms: percentile(samples, 0.5),
    p95_ms: p95,
    max_ms: samples.length ? Math.max(...samples) : null,
    overlaps: scored.reduce((n, r) => n + r.latency.overlaps, 0),
    budget_p95_ms: budgetMs,
    within_budget: p95 !== null && p95 <= budgetMs,
  };
  for (const result of results) delete result.latency.samples;

  const violations = {};
  let checks = 0;
  let checksPassed = 0;
  for (const result of scored) {
    for (const policy of result.policies) {
      checks++;
      if (policy.ok) checksPassed++;
      else violations[policy.id] = (violations[policy.id] ?? 0) + 1;
    }
  }
  const ticketed = scored.filter((r) => r.ticket.checked);
  const passed = results.filter((r) => r.pass).length;
  const summary = {
    scenarios: results.length,
    passed,
    pass_rate: results.length ? passed / results.length : 0,
    outcome_correct: { ok: scored.filter((r) => r.outcome.ok).length, of: results.length },
    ticket_exact: { ok: ticketed.filter((r) => r.ticket.exact).length, of: ticketed.length },
    items_match: { ok: ticketed.filter((r) => r.ticket.items_match).length, of: ticketed.length },
    totals_correct: { ok: ticketed.filter((r) => r.ticket.totals_ok).length, of: ticketed.length },
    policy: { checks, passed: checksPassed, violations },
    latency,
    missing_runs: missing,
    unknown_runs: unknown,
    duplicate_runs: duplicates,
  };
  return {
    tool: `voice-order-evals ${VERSION}`,
    menu: { brand: menu.brand, version: menu.menu_version },
    ok: passed === results.length && results.length > 0 && latency.within_budget,
    summary,
    results,
  };
}

/** Masks card-number-like text in every string of a report, so a report never repeats one. */
export function redact(value) {
  if (typeof value === "string") return maskCards(value);
  if (Array.isArray(value)) return value.map(redact);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v)]));
  return value;
}
