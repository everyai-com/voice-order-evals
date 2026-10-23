import { CHECKS } from "./policies.mjs";

const pct = (n, of) => (of ? `${((100 * n) / of).toFixed(1)}%` : "n/a");
const ms = (value) => (value === null || value === undefined ? "-" : `${value} ms`);

function ticketCell(result) {
  if (result.missing) return "-";
  if (!result.ticket.checked) return "n/a";
  return result.ticket.exact ? "ok" : "FAIL";
}

/** Plain-text report: one line per scenario, details for failures, then the summary. */
export function formatText(report, { verbose = false } = {}) {
  const s = report.summary;
  const lines = [`${report.tool}: ${s.scenarios} scenarios, menu "${report.menu.brand}" ${report.menu.version}`, ""];
  const width = Math.max(...report.results.map((r) => r.id.length), 10);
  for (const r of report.results) {
    const policyOk = r.policies.filter((p) => p.ok).length;
    lines.push(
      `  ${r.pass ? "PASS" : "FAIL"}  ${r.id.padEnd(width)}  ${String(r.outcome.actual ?? "no run").padEnd(15)}  ticket ${ticketCell(r).padEnd(4)}  policy ${`${policyOk}/${r.policies.length}`.padEnd(5)}  p95 ${ms(r.latency.p95_ms)}`,
    );
  }

  const failures = report.results.filter((r) => !r.pass || (verbose && r.warnings?.length));
  if (failures.length) {
    lines.push("", "Details");
    for (const r of failures) {
      lines.push(`  ${r.id}`);
      if (!r.outcome.ok) lines.push(`    outcome  ${r.outcome.note}`);
      for (const problem of r.ticket.problems ?? []) if (!r.ticket.exact) lines.push(`    ticket   ${problem}`);
      for (const p of r.policies) if (!p.ok) lines.push(`    policy   ${p.id}: ${p.note}`);
      for (const w of r.warnings ?? []) lines.push(`    warning  ${w}`);
    }
  }

  if (verbose) {
    lines.push("", "Policy checks");
    for (const [id, check] of Object.entries(CHECKS)) lines.push(`  ${id.padEnd(22)} ${check.description}`);
  }

  const l = s.latency;
  const violations = Object.entries(s.policy.violations).sort((a, b) => b[1] - a[1]).map(([id, n]) => `${id} ${n}`).join(", ");
  lines.push(
    "",
    "Summary",
    `  Scenarios passed   ${s.passed}/${s.scenarios} (${pct(s.passed, s.scenarios)})`,
    `  Outcome correct    ${s.outcome_correct.ok}/${s.outcome_correct.of}`,
    `  Ticket exact       ${s.ticket_exact.ok}/${s.ticket_exact.of}   items, sizes, modifiers, quantities, order type and payment all match`,
    `  Totals correct     ${s.totals_correct.ok}/${s.totals_correct.of}   stated subtotal, fee, tax and total equal the menu recomputation`,
    `  Policy checks      ${s.policy.passed}/${s.policy.checks}${violations ? `   violations: ${violations}` : ""}`,
    `  Latency            p50 ${ms(l.p50_ms)}, p95 ${ms(l.p95_ms)}, max ${ms(l.max_ms)} over ${l.pairs} turns; budget p95 <= ${l.budget_p95_ms} ms: ${l.within_budget ? "PASS" : "FAIL"}`,
  );
  if (l.overlaps) lines.push(`                     ${l.overlaps} agent turn(s) started before the caller finished and are not counted`);
  if (s.missing_runs.length) lines.push(`  Missing runs       ${s.missing_runs.length}: ${s.missing_runs.join(", ")}`);
  if (s.unknown_runs.length) lines.push(`  Unknown runs       ${s.unknown_runs.join(", ")} (no scenario with that id; ignored)`);
  if (s.duplicate_runs.length) lines.push(`  Duplicate runs     ${s.duplicate_runs.join(", ")} (first one scored)`);
  lines.push(`Result: ${report.ok ? "PASS" : "FAIL"}`);
  return lines.join("\n");
}
