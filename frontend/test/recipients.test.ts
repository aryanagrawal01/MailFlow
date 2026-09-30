import assert from "node:assert/strict";
import test from "node:test";
import { parseRecipients } from "../src/recipients.ts";

test("CSV import reads the email column and normalizes duplicates", () => {
  const report = parseRecipients("name,email\nA,Alice@example.com\nB,alice@EXAMPLE.com\nC,bob@example.org", "list.csv");
  assert.deepEqual(report.recipients, ["alice@example.com", "bob@example.org"]);
  assert.equal(report.valid, 2);
  assert.equal(report.duplicates, 1);
  assert.equal(report.invalid.length, 0);
});

test("text imports accept line, comma, and semicolon separators", () => {
  const report = parseRecipients("alice@example.com,\n bob@example.org;carol@example.net");
  assert.deepEqual(report.recipients, ["alice@example.com", "bob@example.org", "carol@example.net"]);
});

test("invalid and duplicate values are reported instead of submitted", () => {
  const report = parseRecipients("valid@example.com\nnot-an-email\nVALID@example.com\n");
  assert.deepEqual(report.recipients, ["valid@example.com"]);
  assert.deepEqual(report.invalid, ["not-an-email"]);
  assert.equal(report.duplicates, 1);
  assert.equal(report.total, 3);
});

test("CSV email header matching is case insensitive and quoted cells are handled", () => {
  const report = parseRecipients('Name,Email\n"Doe, Jane","jane@example.com"', "recipients.csv");
  assert.deepEqual(report.recipients, ["jane@example.com"]);
  assert.equal(report.invalid.length, 0);
});
