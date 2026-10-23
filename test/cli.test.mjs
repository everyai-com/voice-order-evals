import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const voe = (...args) => {
  const run = spawnSync(process.execPath, ["bin/voe.mjs", ...args], { cwd: root, encoding: "utf8" });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr };
};
const temp = (name, content) => {
  const file = join(mkdtempSync(join(tmpdir(), "voe-")), name);
  writeFileSync(file, content);
  return file;
};

test("score exits 0 for the good example agent", () => {
  const { code, stdout } = voe("score", "examples/runs-good.jsonl");
  assert.equal(code, 0);
  assert.match(stdout, /Scenarios passed {3}34\/34/);
  assert.match(stdout, /Result: PASS/);
});

test("score exits 1 for the flawed example agent and explains the failures", () => {
  const { code, stdout } = voe("score", "examples/runs-flawed.jsonl");
  assert.equal(code, 1);
  assert.match(stdout, /FAIL {2}payment-01-card-read-aloud/);
  assert.match(stdout, /policy {3}no_card_by_voice: agent asked for card details/);
  assert.match(stdout, /budget p95 <= 800 ms: FAIL/);
  assert.doesNotMatch(stdout, /4111/);
});

test("--json prints the full report", () => {
  const { code, stdout } = voe("score", "examples/runs-good.jsonl", "--json");
  assert.equal(code, 0);
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true);
  assert.equal(report.results.length, 34);
  assert.equal(report.summary.latency.budget_p95_ms, 800);
});

test("--scenarios and --allow-missing score a subset", () => {
  const lines = readFileSync(join(root, "examples/runs-good.jsonl"), "utf8").split("\n").filter((l) => l.includes('"scenario_id":"simple-01'));
  const file = temp("one.jsonl", lines.join("\n"));
  assert.equal(voe("score", file).code, 1, "33 scenarios have no run");
  assert.equal(voe("score", file, "--allow-missing").code, 0);
});

test("list prints every scenario", () => {
  const { code, stdout } = voe("list");
  assert.equal(code, 0);
  assert.match(stdout, /34 scenarios/);
  assert.equal(JSON.parse(voe("list", "--json").stdout).length, 34);
});

test("price recomputes a ticket from the menu", () => {
  const ticket = JSON.parse(readFileSync(join(root, "scenarios/deal-02-two-medium-extra-topping.json"), "utf8")).expected.ticket;
  const { code, stdout } = voe("price", temp("ticket.json", JSON.stringify(ticket)));
  assert.equal(code, 0);
  assert.match(stdout, /\$23\.37 {2}total/);
  const bad = voe("price", temp("bad-ticket.json", JSON.stringify({ order_type: "pickup", items: [{ item: "lobster" }] })));
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /error: items\[0\]: "lobster" is not on the menu/);
});

test("usage and input errors exit 2", () => {
  assert.equal(voe().code, 2);
  assert.equal(voe("score").code, 2);
  assert.equal(voe("grade", "x").code, 2);
  assert.equal(voe("score", "missing.jsonl").code, 2);
  assert.equal(voe("score", "examples/runs-good.jsonl", "--budget-ms", "fast").code, 2);
  assert.equal(voe("score", "examples/runs-good.jsonl", "--scenarios", "nowhere").code, 2);
  const bad = voe("score", temp("bad.jsonl", "{ not json\n"));
  assert.equal(bad.code, 2);
  assert.match(bad.stderr, /line 1/);
  assert.equal(voe("--help").code, 0);
});
