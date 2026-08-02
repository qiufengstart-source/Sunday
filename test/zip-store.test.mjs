import assert from "node:assert/strict";
import test from "node:test";
import { buildZipStore } from "../zip-store.mjs";

test("buildZipStore creates a readable store zip with one file", () => {
  const payload = new TextEncoder().encode("hello-asset");
  const zip = buildZipStore([{ name: "01_test.png", data: payload }]);
  assert.ok(zip.byteLength > payload.length);
  // local file header signature
  assert.equal(zip[0], 0x50);
  assert.equal(zip[1], 0x4b);
  assert.equal(zip[2], 0x03);
  assert.equal(zip[3], 0x04);
  const asText = new TextDecoder().decode(zip);
  assert.match(asText, /01_test\.png/);
  assert.match(asText, /hello-asset/);
});

test("buildZipStore supports multiple files", () => {
  const zip = buildZipStore([
    { name: "a.png", data: new Uint8Array([1, 2, 3]) },
    { name: "b.png", data: new Uint8Array([4, 5]) },
  ]);
  const asText = new TextDecoder().decode(zip);
  assert.match(asText, /a\.png/);
  assert.match(asText, /b\.png/);
  // end of central directory signature
  assert.ok(asText.includes("PK"));
});
