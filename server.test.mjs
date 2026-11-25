import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.mjs";

const post = (base, body) =>
  fetch(`${base}/api/rsvp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("rsvp: validate, store, upsert by phone, admin totals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dibi-"));
  const server = createApp({ dataFile: join(dir, "r.json"), adminKey: "k3y" }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(base)).status, 200);

    assert.equal((await post(base, { name: "", phone: "771234567" })).status, 400);
    assert.equal((await post(base, { name: "A", phone: "12" })).status, 400);
    assert.equal((await post(base, { name: "A", phone: "771234567", companions: ["1","2","3","4","5","6"] })).status, 400);
    assert.equal((await post(base, { name: "A", phone: "771234567", companions: ["Bob", "  "] })).status, 400);

    assert.equal((await post(base, { name: "Awa", phone: "77 123 45 67", companions: ["Moussa", "Fatou"], diet: ["veggie", "<script>"] })).status, 200);
    // same number, changed answer: replaces, does not duplicate
    assert.equal((await post(base, { name: "Awa", phone: "771234567", companions: ["Moussa"] })).status, 200);
    assert.equal((await post(base, { name: "Moussa", phone: "780000000" })).status, 200);
    // honeypot stores nothing
    assert.equal((await post(base, { name: "Bot", phone: "790000000", website: "x" })).status, 200);

    assert.equal((await fetch(`${base}/api/rsvps`)).status, 401);
    const list = await (await fetch(`${base}/api/rsvps`, { headers: { "x-admin-key": "k3y" } })).json();
    assert.deepEqual(list.totals, { responses: 2, people: 3 });
    assert.deepEqual(list.rsvps[0].diet, []);
  } finally {
    server.close();
  }
});
