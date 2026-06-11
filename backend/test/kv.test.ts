import { test } from "node:test";
import assert from "node:assert/strict";
import { pad, evtKey, evtRange } from "../src/kv";

test("pad produces fixed width with leading zeros", () => {
  assert.equal(pad(0, 12), "000000000000");
  assert.equal(pad(123, 12), "000000000123");
  assert.equal(pad(7n, 6), "000007");
  assert.throws(() => pad(10n ** 13n, 12));
});

test("evtKey embeds zero-padded height/txIndex/logIndex", () => {
  assert.equal(evtKey(1234, 1, 0), "evt:000000001234:000001:000000");
});

test("lexicographic order equals numeric order", () => {
  const keys = [evtKey(2, 0, 0), evtKey(10, 0, 0), evtKey(10, 0, 1), evtKey(10, 1, 0), evtKey(100, 0, 0)];
  const sorted = [...keys].sort();
  assert.deepEqual(sorted, keys);
});

test("evtRange covers closed interval [from, to]", () => {
  const [lo, hi] = evtRange(5, 10);
  assert.equal(lo, "evt:000000000005:");
  assert.equal(hi, "evt:000000000011:");
  // 区间内
  assert.ok(evtKey(5, 0, 0) >= lo && evtKey(5, 0, 0) < hi);
  assert.ok(evtKey(10, 999, 12) >= lo && evtKey(10, 999, 12) < hi);
  // 区间外
  assert.ok(evtKey(4, 999999, 999999) < lo);
  assert.ok(evtKey(11, 0, 0) >= hi);
});
