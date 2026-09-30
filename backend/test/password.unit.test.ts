import assert from "node:assert/strict";
import { test } from "node:test";
import { hashPassword, verifyPassword } from "../src/auth/password.js";

test("password hashes use unique salts and verify without storing plaintext", async () => {
  const password = "correct-horse-battery-staple";
  const first = await hashPassword(password);
  const second = await hashPassword(password);
  assert.match(first, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(first, second);
  assert.equal(await verifyPassword(password, first), true);
  assert.equal(await verifyPassword("not-the-password", first), false);
  assert.equal(await verifyPassword(password, "not-a-valid-password-hash"), false);
});
