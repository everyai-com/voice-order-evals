#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMenu, money, priceTicket } from "../src/menu.mjs";
import { formatText } from "../src/report.mjs";
import { loadScenarios, parseRuns, redact, scoreAll, scriptTurn } from "../src/score.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const USAGE = `Usage:
  voe score <runs.jsonl> [--json] [--scenarios dir] [--menu file] [--budget-ms 800] [--allow-missing] [--verbose]
  voe list [--scenarios dir] [--json]
  voe price <ticket.json> [--menu file] [--json]

score  Scores an agent's runs (one JSON object per line, one line per scenario) for ticket
       exactness, policy compliance and latency. Scenarios without a run count as failures
       unless --allow-missing is set.
list   Lists the scenarios.
price  Recomputes a ticket's lines and totals from the menu (handy when writing scenarios).

Exit codes: 0 every scenario passed and p95 latency is within budget, 1 otherwise,
2 usage or input error.`;

function usageError(message) {
  console.error(`voe: ${message}\n\n${USAGE}`);
  process.exitCode = 2;
}

function parse(argv) {
  const options = { files: [], json: false, verbose: false, allowMissing: false, scenarios: join(root, "scenarios"), menu: join(root, "menu/menu.json"), budgetMs: undefined, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const value = () => {
      const next = eq > 0 ? arg.slice(eq + 1) : argv[++i];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--verbose" || flag === "-v") options.verbose = true;
    else if (flag === "--allow-missing") options.allowMissing = true;
    else if (flag === "--scenarios") options.scenarios = value();
    else if (flag === "--menu") options.menu = value();
    else if (flag === "--budget-ms") {
      const budget = Number(value());
      if (!Number.isFinite(budget) || budget <= 0) throw new Error("--budget-ms must be a positive number");
      options.budgetMs = budget;
    } else if (flag.startsWith("-")) throw new Error(`unknown option ${flag}`);
    else options.files.push(arg);
  }
  return options;
}

function loadInputs(options) {
  try {
    return { menu: loadMenu(options.menu), scenarios: loadScenarios(options.scenarios) };
  } catch (error) {
    console.error(`voe: could not load menu or scenarios: ${error.message}`);
    process.exitCode = 2;
    return null;
  }
}

function runList(options) {
  const inputs = loadInputs(options);
  if (!inputs) return;
  const rows = inputs.scenarios.map((s) => ({
    id: s.id,
    title: s.title,
    tags: s.tags,
    outcome: s.expected.outcome,
    caller_turns: s.caller_turns.map(scriptTurn).filter((t) => t.say !== undefined).length,
    policy_checks: s.policy_checks,
  }));
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const width = Math.max(...rows.map((r) => r.id.length));
  for (const r of rows) console.log(`${r.id.padEnd(width)}  ${r.outcome.padEnd(15)}  ${r.title}  [${r.tags.join(", ")}]`);
  console.log(`\n${rows.length} scenarios`);
}

function runPrice(options) {
  if (options.files.length !== 1) return usageError("price needs exactly one ticket file");
  let menu;
  let ticket;
  try {
    menu = loadMenu(options.menu);
    ticket = JSON.parse(readFileSync(options.files[0], "utf8"));
  } catch (error) {
    console.error(`voe: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const p = priceTicket(menu, ticket);
  const totals = { subtotal: p.subtotal_cents / 100, delivery_fee: p.delivery_fee_cents / 100, tax: p.tax_cents / 100, total: p.total_cents / 100 };
  if (options.json) console.log(JSON.stringify({ errors: p.errors, lines: p.lines.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit_cents / 100, line: l.line_cents / 100 })), totals }, null, 2));
  else {
    for (const l of p.lines) console.log(`${money(l.line_cents).padStart(9)}  ${l.description} x${l.quantity}`);
    console.log(`${money(p.subtotal_cents).padStart(9)}  subtotal\n${money(p.delivery_fee_cents).padStart(9)}  delivery fee\n${money(p.tax_cents).padStart(9)}  tax\n${money(p.total_cents).padStart(9)}  total`);
    for (const error of p.errors) console.log(`error: ${error}`);
  }
  process.exitCode = p.errors.length ? 1 : 0;
}

function runScore(options) {
  if (options.files.length !== 1) return usageError("score needs exactly one runs file");
  const inputs = loadInputs(options);
  if (!inputs) return;
  let text;
  try {
    text = readFileSync(options.files[0], "utf8");
  } catch (error) {
    console.error(`voe: could not read ${options.files[0]}: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  const { runs, errors } = parseRuns(text);
  if (errors.length) {
    console.error(`voe: ${options.files[0]} has invalid lines:\n  ${errors.join("\n  ")}`);
    process.exitCode = 2;
    return;
  }
  const report = redact(scoreAll({ ...inputs, runs, budgetMs: options.budgetMs, allowMissing: options.allowMissing }));
  console.log(options.json ? JSON.stringify(report, null, 2) : formatText(report, { verbose: options.verbose }));
  process.exitCode = report.ok ? 0 : 1;
}

const [command, ...rest] = process.argv.slice(2);
let options;
try {
  options = parse(rest);
} catch (error) {
  usageError(error.message);
}
if (options) {
  if (command === undefined) usageError("no command given");
  else if (command === "--help" || command === "-h" || command === "help" || options.help) console.log(USAGE);
  else if (command === "score") runScore(options);
  else if (command === "list") runList(options);
  else if (command === "price") runPrice(options);
  else usageError(`unknown command "${command}"`);
}
