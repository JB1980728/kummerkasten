// Kummerkasten – Cloudflare Worker + D1
// Anonym: keine Namen, keine IP-Adressen, keine Cookies. Geräte werden nur als
// gesalzener Hash erkannt, damit man nicht doppelt zustimmt oder doppelt an der Fragerunde teilnimmt.
// Fragerunden-Antworten werden OHNE Geräte-Bezug gespeichert.
import HTML from "./index.html";

// Segelboot-Zonen: wind = läuft gut, anker = bremst, felsen = Risiko, insel = Ziel
const KINDS = ["wind", "anker", "felsen", "insel", "danke", "aha"];
const NO_BETTER = ["wind", "danke", "aha"];
const LEGACY = { kummer: "anker", lob: "wind" };
const CATEGORIES = ["inhalt", "tempo", "organisation", "tools", "miteinander", "sonstiges"];
const STATUSES = ["neu", "gehoert", "besprochen", "umgesetzt"];
const TYPES = ["entdecker", "shopper", "urlauber", "gefangener"];

const BLOCK = [
  "arschloch", "wichser", "hurensohn", "fotze", "spast", "behindert", "missgeburt", "schlampe",
  "hure", "nutte", "idiot", "vollidiot", "depp", "trottel", "penner", "bastard", "scheisskerl",
  "fick", "ficken", "verpiss", "halts maul", "drecksau", "schwein", "kotzbrocken", "opfer",
];

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

async function sha(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

function clean(v, max) {
  if (typeof v !== "string") return "";
  return v.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}

function isBad(t) {
  const low = t.toLowerCase();
  if (/(https?:\/\/|www\.|\.com\b|\.de\b)/.test(low)) return "Bitte ohne Links.";
  if (/@[a-z0-9_.-]{2,}/.test(low)) return "Bitte ohne Namen oder Erwähnungen.";
  const norm = low
    .replace(/[0]/g, "o").replace(/[1!|]/g, "i").replace(/[3]/g, "e").replace(/[4@]/g, "a").replace(/[5$]/g, "s")
    .replace(/[^a-zäöüß\s]/g, "");
  const squashed = norm.replace(/\s+/g, "");
  for (const w of BLOCK) {
    if (norm.split(/\s+/).some(t => t === w || (w.length > 5 && t.includes(w))) || (w.length > 6 && squashed.includes(w))) {
      return "Bitte ohne Beleidigungen. Sag, was dich stört, nicht wer.";
    }
  }
  return null;
}

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, category TEXT, mood INTEGER, text TEXT, better TEXT,
      status TEXT DEFAULT 'neu', action TEXT, votes INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0,
      created_at INTEGER, done_at INTEGER)`),
    db.prepare("CREATE TABLE IF NOT EXISTS votes (entry_id INTEGER, voter TEXT, PRIMARY KEY (entry_id, voter))"),
    db.prepare("CREATE TABLE IF NOT EXISTS moods (id INTEGER PRIMARY KEY AUTOINCREMENT, mood INTEGER, created_at INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS rl (who TEXT, ts INTEGER)"),
    db.prepare("CREATE TABLE IF NOT EXISTS rounds (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT, open INTEGER DEFAULT 1, created_at INTEGER)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER, mood INTEGER, type TEXT,
      nerven TEXT, gut TEXT, aendern TEXT, mitreden TEXT, day TEXT)`),
    db.prepare("CREATE TABLE IF NOT EXISTS survey_done (round_id INTEGER, voter TEXT, PRIMARY KEY (round_id, voter))"),
    db.prepare(`CREATE TABLE IF NOT EXISTS actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER, text TEXT, owner TEXT, due TEXT,
      status TEXT DEFAULT 'offen', note TEXT, created_at INTEGER, updated_at INTEGER)`),
  ]);
  const r = await db.prepare("SELECT COUNT(*) AS n FROM rounds").first();
  if (!r?.n) {
    await db.prepare("INSERT INTO rounds (label, open, created_at) VALUES (?, 1, ?)").bind("Erste Runde", Date.now()).run();
  }
  schemaReady = true;
}

async function voterId(request, env) {
  const t = request.headers.get("x-device") || "";
  if (!/^[a-z0-9]{16,64}$/i.test(t)) return null;
  return sha("kk-v1:" + t + ":" + (env.SALT || "kummerkasten"));
}

async function rateLimited(db, who, limit, windowMs) {
  const now = Date.now();
  await db.prepare("DELETE FROM rl WHERE ts < ?").bind(now - 3600_000).run();
  const row = await db.prepare("SELECT COUNT(*) AS n FROM rl WHERE who = ? AND ts > ?").bind(who, now - windowMs).first();
  if ((row?.n || 0) >= limit) return true;
  await db.prepare("INSERT INTO rl (who, ts) VALUES (?, ?)").bind(who, now).run();
  return false;
}

async function isRetro(request, env) {
  const pw = request.headers.get("x-retro") || "";
  if (!pw || !env.PASS_HASH) return false;
  return (await sha("kk-pass:" + pw)) === env.PASS_HASH;
}

const currentRound = db => db.prepare("SELECT * FROM rounds ORDER BY id DESC LIMIT 1").first();

function publicEntry(r, mine) {
  return {
    id: r.id, kind: LEGACY[r.kind] || r.kind, category: r.category, text: r.text, better: r.better || "",
    status: r.status, action: r.action || "", votes: r.votes, created: r.created_at, done: r.done_at || null,
    hidden: !!r.hidden, mine: mine ? mine.has(r.id) : false,
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function surveyResults(db, roundId) {
  const rows = (await db.prepare("SELECT mood, type, nerven, gut, aendern, mitreden FROM answers WHERE round_id = ?").bind(roundId).all()).results || [];
  const moods = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const types = { entdecker: 0, shopper: 0, urlauber: 0, gefangener: 0 };
  const texts = { nerven: [], gut: [], aendern: [], mitreden: [] };
  for (const r of rows) {
    if (moods[r.mood] !== undefined) moods[r.mood]++;
    if (types[r.type] !== undefined) types[r.type]++;
    for (const k of Object.keys(texts)) if (r[k]) texts[k].push(r[k]);
  }
  for (const k of Object.keys(texts)) shuffle(texts[k]); // Reihenfolge verrät nichts
  return { total: rows.length, moods, types, texts };
}

async function handleApi(request, env, url) {
  const db = env.DB;
  await ensureSchema(db);
  const path = url.pathname;
  const method = request.method;

  // ---------- Pinnwand lesen ----------
  if (path === "/api/entries" && method === "GET") {
    const retro = await isRetro(request, env);
    const rows = (await db.prepare(
      `SELECT * FROM entries ${retro ? "" : "WHERE hidden = 0"} ORDER BY created_at DESC LIMIT 500`
    ).all()).results || [];
    const voter = await voterId(request, env);
    let mine = new Set();
    if (voter) {
      const v = (await db.prepare("SELECT entry_id FROM votes WHERE voter = ?").bind(voter).all()).results || [];
      mine = new Set(v.map(x => x.entry_id));
    }
    const since = Date.now() - 21 * 86400_000;
    const moods = (await db.prepare("SELECT mood, COUNT(*) AS n FROM moods WHERE created_at > ? GROUP BY mood").bind(since).all()).results || [];
    const moodMap = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const m of moods) moodMap[m.mood] = m.n;
    return json({ entries: rows.map(r => publicEntry(r, mine)), moods: moodMap, retro });
  }

  // ---------- Neuer Eintrag und/oder Stimmung ----------
  if (path === "/api/entries" && method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
    const retro = await isRetro(request, env);
    const voter = await voterId(request, env);
    if (!voter) return json({ error: "Bitte die Seite neu laden." }, 400);
    if (!retro && await rateLimited(db, "post:" + voter, 8, 10 * 60_000)) {
      return json({ error: "Kurze Pause, bitte. Du hast gerade viel eingeworfen." }, 429);
    }
    const kind = KINDS.includes(body.kind) ? body.kind : (LEGACY[body.kind] || "anker");
    const category = CATEGORIES.includes(body.category) ? body.category : "sonstiges";
    const mood = Number.isInteger(body.mood) && body.mood >= 1 && body.mood <= 5 ? body.mood : null;
    const text = clean(body.text, 500);
    const better = NO_BETTER.includes(kind) ? "" : clean(body.better, 300);
    if (!text && !mood) return json({ error: "Schreib etwas oder wähl eine Stimmung." }, 400);
    for (const t of [text, better]) {
      if (!t) continue;
      const bad = isBad(t);
      if (bad) return json({ error: bad }, 400);
    }
    if (text && text.length < 4) return json({ error: "Etwas mehr Text, bitte." }, 400);
    const now = Date.now();
    const stmts = [];
    if (mood) stmts.push(db.prepare("INSERT INTO moods (mood, created_at) VALUES (?, ?)").bind(mood, now));
    if (text) stmts.push(db.prepare(
      "INSERT INTO entries (kind, category, mood, text, better, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(kind, category, mood, text, better || null, now));
    await db.batch(stmts);
    return json({ ok: true, entry: !!text });
  }

  // ---------- Zustimmen (an/aus) ----------
  const voteMatch = path.match(/^\/api\/entries\/(\d+)\/vote$/);
  if (voteMatch && method === "POST") {
    const id = Number(voteMatch[1]);
    const voter = await voterId(request, env);
    if (!voter) return json({ error: "Bitte die Seite neu laden." }, 400);
    if (await rateLimited(db, "vote:" + voter, 60, 10 * 60_000)) return json({ error: "Zu viele Klicks, kurz warten." }, 429);
    const entry = await db.prepare("SELECT id FROM entries WHERE id = ? AND hidden = 0").bind(id).first();
    if (!entry) return json({ error: "Eintrag nicht gefunden." }, 404);
    const had = await db.prepare("SELECT 1 FROM votes WHERE entry_id = ? AND voter = ?").bind(id, voter).first();
    if (had) {
      await db.batch([
        db.prepare("DELETE FROM votes WHERE entry_id = ? AND voter = ?").bind(id, voter),
        db.prepare("UPDATE entries SET votes = MAX(votes - 1, 0) WHERE id = ?").bind(id),
      ]);
    } else {
      await db.batch([
        db.prepare("INSERT INTO votes (entry_id, voter) VALUES (?, ?)").bind(id, voter),
        db.prepare("UPDATE entries SET votes = votes + 1 WHERE id = ?").bind(id),
      ]);
    }
    const row = await db.prepare("SELECT votes FROM entries WHERE id = ?").bind(id).first();
    return json({ votes: row.votes, voted: !had });
  }

  // ---------- Retro: Status, Maßnahme, Ausblenden ----------
  const patchMatch = path.match(/^\/api\/entries\/(\d+)$/);
  if (patchMatch && method === "PATCH") {
    if (!(await isRetro(request, env))) return json({ error: "Nur im Retro-Modus." }, 403);
    const id = Number(patchMatch[1]);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
    const sets = [], vals = [];
    if (STATUSES.includes(body.status)) {
      sets.push("status = ?"); vals.push(body.status);
      sets.push("done_at = ?"); vals.push(body.status === "umgesetzt" ? Date.now() : null);
    }
    if (typeof body.action === "string") { sets.push("action = ?"); vals.push(clean(body.action, 300) || null); }
    if (typeof body.hidden === "boolean") { sets.push("hidden = ?"); vals.push(body.hidden ? 1 : 0); }
    if (!sets.length) return json({ error: "Nichts zu ändern." }, 400);
    await db.prepare(`UPDATE entries SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
    const row = await db.prepare("SELECT * FROM entries WHERE id = ?").bind(id).first();
    return json({ entry: publicEntry(row) });
  }

  if (path === "/api/retro/check" && method === "POST") {
    return (await isRetro(request, env)) ? json({ ok: true }) : json({ error: "Passwort stimmt nicht." }, 403);
  }

  // ---------- Fragerunde ----------
  if (path === "/api/survey" && method === "GET") {
    const round = await currentRound(db);
    const voter = await voterId(request, env);
    const done = voter ? await db.prepare("SELECT 1 FROM survey_done WHERE round_id = ? AND voter = ?").bind(round.id, voter).first() : null;
    const count = await db.prepare("SELECT COUNT(*) AS n FROM answers WHERE round_id = ?").bind(round.id).first();
    const retro = await isRetro(request, env);
    const out = { round: { id: round.id, label: round.label, open: !!round.open, created: round.created_at }, done: !!done, count: count?.n || 0 };
    // Ergebnisse sieht jeder, der selbst geantwortet hat (damit niemand beim Antworten beeinflusst wird),
    // und alle, sobald die Runde geschlossen ist.
    if (retro || done || !round.open) out.results = await surveyResults(db, round.id);
    return json(out);
  }

  if (path === "/api/survey" && method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
    const voter = await voterId(request, env);
    if (!voter) return json({ error: "Bitte die Seite neu laden." }, 400);
    const round = await currentRound(db);
    if (!round.open) return json({ error: "Die Fragerunde ist gerade geschlossen." }, 400);
    if (await rateLimited(db, "survey:" + voter, 5, 10 * 60_000)) return json({ error: "Kurz warten, bitte." }, 429);
    const done = await db.prepare("SELECT 1 FROM survey_done WHERE round_id = ? AND voter = ?").bind(round.id, voter).first();
    if (done) return json({ error: "Du hast in dieser Runde schon mitgemacht. Danke!" }, 409);
    const mood = Number.isInteger(body.mood) && body.mood >= 1 && body.mood <= 5 ? body.mood : null;
    const type = TYPES.includes(body.type) ? body.type : null;
    if (!mood || !type) return json({ error: "Bitte Stimmung und Typ auswählen." }, 400);
    const f = { nerven: clean(body.nerven, 600), gut: clean(body.gut, 600), aendern: clean(body.aendern, 600), mitreden: clean(body.mitreden, 600) };
    for (const t of Object.values(f)) {
      if (!t) continue;
      const bad = isBad(t);
      if (bad) return json({ error: bad }, 400);
    }
    const now = Date.now();
    // Nur der Tag wird gespeichert, keine Uhrzeit, damit sich Antworten nicht über die Abgabezeit zuordnen lassen.
    const day = new Date(now).toISOString().slice(0, 10);
    await db.batch([
      db.prepare("INSERT INTO survey_done (round_id, voter) VALUES (?, ?)").bind(round.id, voter),
      db.prepare("INSERT INTO answers (round_id, mood, type, nerven, gut, aendern, mitreden, day) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(round.id, mood, type, f.nerven || null, f.gut || null, f.aendern || null, f.mitreden || null, day),
      db.prepare("INSERT INTO moods (mood, created_at) VALUES (?, ?)").bind(mood, now),
    ]);
    return json({ ok: true });
  }

  if (path === "/api/survey/round" && method === "POST") {
    if (!(await isRetro(request, env))) return json({ error: "Nur im Retro-Modus." }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
    const round = await currentRound(db);
    if (body.action === "new") {
      const label = clean(body.label, 60) || "Retro-Check";
      await db.batch([
        db.prepare("UPDATE rounds SET open = 0"), // alte Runden schließen, ihre Ergebnisse sind dann für alle sichtbar
        db.prepare("INSERT INTO rounds (label, open, created_at) VALUES (?, 1, ?)").bind(label, Date.now()),
      ]);
    } else if (body.action === "toggle") {
      await db.prepare("UPDATE rounds SET open = ? WHERE id = ?").bind(round.open ? 0 : 1, round.id).run();
    } else return json({ error: "Unbekannte Aktion." }, 400);
    return json({ ok: true });
  }

  // ---------- Verlauf: alle Runden mit Ergebnissen und Maßnahmen (für alle sichtbar) ----------
  if (path === "/api/history" && method === "GET") {
    const rounds = (await db.prepare("SELECT * FROM rounds ORDER BY id DESC LIMIT 50").all()).results || [];
    const acts = (await db.prepare("SELECT * FROM actions ORDER BY id ASC").all()).results || [];
    const voter = await voterId(request, env);
    const cur = rounds[0];
    const doneCur = voter && cur ? await db.prepare("SELECT 1 FROM survey_done WHERE round_id = ? AND voter = ?").bind(cur.id, voter).first() : null;
    const retro = await isRetro(request, env);
    const out = [];
    for (const r of rounds) {
      const isCur = cur && r.id === cur.id;
      const hide = isCur && r.open && !doneCur && !retro; // laufende Runde erst nach eigener Antwort
      const res = await surveyResults(db, r.id);
      out.push({
        id: r.id, label: r.label, open: !!r.open, created: r.created_at, current: !!isCur,
        total: res.total, moods: hide ? null : res.moods, types: hide ? null : res.types,
        actions: acts.filter(a => a.round_id === r.id).map(a => ({
          id: a.id, text: a.text, owner: a.owner || "", due: a.due || "", status: a.status, note: a.note || "", updated: a.updated_at,
        })),
      });
    }
    return json({ rounds: out });
  }

  // ---------- Maßnahmen (nur im Retro-Modus änderbar) ----------
  const ACT_STATUS = ["offen", "laeuft", "erledigt", "verworfen"];
  if (path === "/api/actions" && method === "POST") {
    if (!(await isRetro(request, env))) return json({ error: "Nur im Retro-Modus." }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
    const text = clean(body.text, 300);
    if (text.length < 3) return json({ error: "Bitte die Maßnahme kurz beschreiben." }, 400);
    const round = Number.isInteger(body.round_id) ? { id: body.round_id } : await currentRound(db);
    const now = Date.now();
    await db.prepare("INSERT INTO actions (round_id, text, owner, due, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'offen', ?, ?)")
      .bind(round.id, text, clean(body.owner, 80) || null, clean(body.due, 40) || null, now, now).run();
    return json({ ok: true });
  }
  const actMatch = path.match(/^\/api\/actions\/(\d+)$/);
  if (actMatch && (method === "PATCH" || method === "DELETE")) {
    if (!(await isRetro(request, env))) return json({ error: "Nur im Retro-Modus." }, 403);
    const id = Number(actMatch[1]);
    if (method === "DELETE") { await db.prepare("DELETE FROM actions WHERE id = ?").bind(id).run(); return json({ ok: true }); }
    let body;
    try { body = await request.json(); } catch { return json({ error: "Ungültige Anfrage." }, 400); }
    const sets = [], vals = [];
    if (ACT_STATUS.includes(body.status)) { sets.push("status = ?"); vals.push(body.status); }
    for (const [k, max] of [["text", 300], ["owner", 80], ["due", 40], ["note", 300]]) {
      if (typeof body[k] === "string") { sets.push(`${k} = ?`); vals.push(clean(body[k], max) || null); }
    }
    if (!sets.length) return json({ error: "Nichts zu ändern." }, 400);
    sets.push("updated_at = ?"); vals.push(Date.now());
    await db.prepare(`UPDATE actions SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
    return json({ ok: true });
  }

  return json({ error: "Nicht gefunden." }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try { return await handleApi(request, env, url); }
      catch (err) { return json({ error: "Da ist etwas schiefgelaufen. Bitte gleich nochmal." }, 500); }
    }
    return new Response(HTML, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  },
};
