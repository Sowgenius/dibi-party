// Dibi Party: static page + RSVP API. Node stdlib only.
//   PORT=3000 ADMIN_KEY=<secret> node server.mjs
// Host list:  GET /api/rsvps  with header "x-admin-key: <secret>"  (or ?key=<secret>)
import http from "node:http";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const MAX_PARTY = 6;
const DIET = new Set(["veggie", "mild", "juice"]);
const MAX_BODY = 8 * 1024;

// Whitelist: no user-controlled path ever reaches the filesystem.
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/fonts/bricolage.woff2": ["fonts/bricolage.woff2", "font/woff2"],
};

const HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

/** Validate untrusted input. Returns { value } or { error }. */
export function parseRsvp(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { error: "Requête invalide." };
  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

  const name = str(raw.name, 80);
  if (!name) return { error: "Ton nom est nécessaire." };

  const phoneRaw = str(raw.phone, 24);
  if (!/^[+0-9 ().\-]+$/.test(phoneRaw)) return { error: "Numéro de téléphone invalide." };
  const digits = phoneRaw.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return { error: "Numéro de téléphone invalide." };

  if (raw.attending !== "yes" && raw.attending !== "no") return { error: "Dis-moi si tu viens ou non." };
  const attending = raw.attending === "yes";

  let guests = 0;
  if (attending) {
    guests = raw.guests;
    if (!Number.isInteger(guests) || guests < 1 || guests > MAX_PARTY)
      return { error: `Le nombre de personnes doit être entre 1 et ${MAX_PARTY}.` };
  }

  const diet = attending && Array.isArray(raw.diet) ? [...new Set(raw.diet.filter((d) => DIET.has(d)))] : [];
  const guestNames = attending && guests > 1 ? str(raw.guestNames, 200) : "";
  const note = str(raw.note, 300);

  return { value: { key: digits, rsvp: { name, phone: phoneRaw, attending, guests, guestNames, diet, note } } };
}

export function createApp({ dataFile, adminKey = "" }) {
  let db = {};
  let ready = readFile(dataFile, "utf8").then(
    (t) => { db = JSON.parse(t); },
    (e) => { if (e.code !== "ENOENT") throw e; },
  );
  // Writes are chained so two submissions never interleave; temp + rename keeps the file whole.
  let writing = Promise.resolve();
  const save = () => (writing = writing.then(async () => {
    await mkdir(dirname(dataFile), { recursive: true });
    const tmp = `${dataFile}.tmp`;
    await writeFile(tmp, JSON.stringify(db, null, 2));
    await rename(tmp, dataFile);
  }));

  // ponytail: in-memory per-IP limiter; use the reverse proxy's limiter if you run several instances.
  const hits = new Map();
  const limited = (ip) => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.clear();
    return recent.length > 15;
  };

  const send = (res, status, body, type = "application/json; charset=utf-8", extra = {}) => {
    res.writeHead(status, { ...HEADERS, "content-type": type, "cache-control": "no-store", ...extra });
    res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };

  const isAdmin = (req, url) => {
    if (!adminKey) return false; // no key configured = list disabled
    const given = Buffer.from(String(req.headers["x-admin-key"] ?? url.searchParams.get("key") ?? ""));
    const want = Buffer.from(adminKey);
    return given.length === want.length && timingSafeEqual(given, want);
  };

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("too large"), { status: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

  return http.createServer(async (req, res) => {
    try {
      await ready;
      const url = new URL(req.url, "http://x");

      if (req.method === "GET" && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(res, 200, await readFile(join(ROOT, file)), type, {
          "cache-control": type.startsWith("font") ? "public, max-age=31536000, immutable" : "no-cache",
        });
      }

      if (url.pathname === "/api/rsvp" && req.method === "POST") {
        if (limited(req.socket.remoteAddress ?? "")) return send(res, 429, { error: "Trop de tentatives. Réessaie dans une minute." });
        if (!String(req.headers["content-type"]).startsWith("application/json")) return send(res, 415, { error: "Requête invalide." });
        let raw;
        try { raw = JSON.parse(await readBody(req)); } catch (e) {
          if (e.status === 413) return send(res, 413, { error: "Message trop long." });
          return send(res, 400, { error: "Requête invalide." });
        }
        // Honeypot: bots fill it. Pretend success, store nothing.
        if (raw && typeof raw.website === "string" && raw.website !== "") return send(res, 200, { rsvp: { name: "toi", phone: "", attending: false, guests: 0 } });

        const parsed = parseRsvp(raw);
        if (parsed.error) return send(res, 400, { error: parsed.error });
        const { key, rsvp } = parsed.value;
        const now = new Date().toISOString();
        db[key] = { ...rsvp, createdAt: db[key]?.createdAt ?? now, updatedAt: now };
        await save();
        return send(res, 200, { rsvp });
      }

      if (url.pathname === "/api/rsvps" && req.method === "GET") {
        if (!isAdmin(req, url)) return send(res, 401, { error: "Non autorisé." });
        const list = Object.values(db).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        const yes = list.filter((r) => r.attending);
        return send(res, 200, {
          totals: { responses: list.length, yes: yes.length, no: list.length - yes.length, people: yes.reduce((n, r) => n + r.guests, 0) },
          rsvps: list,
        });
      }

      send(res, 404, { error: "Introuvable." });
    } catch (err) {
      console.error("request failed:", err);
      if (!res.headersSent) send(res, 500, { error: "Erreur serveur. Réessaie dans un instant." });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const adminKey = process.env.ADMIN_KEY ?? "";
  if (!adminKey) console.warn("ADMIN_KEY not set: GET /api/rsvps is disabled.");
  createApp({ dataFile: process.env.DATA_FILE ?? join(ROOT, "data", "rsvps.json"), adminKey })
    .listen(port, () => console.log(`Dibi Party on http://localhost:${port}`));
}
