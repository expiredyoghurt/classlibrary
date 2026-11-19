// Class Library API — Cloudflare Worker (static assets in /public, D1 = DB, R2 = COVERS)

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
const err = (status, code, message) => json({ error: code, message }, status);
const uid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();

// ---------- ISBN helpers ----------
function cleanIsbn(v) { return String(v ?? '').replace(/[^0-9Xx]/g, '').toUpperCase(); }
function isbn10to13(i10) {
  const core = '978' + i10.slice(0, 9);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 === 0 ? 1 : 3);
  return core + String((10 - (sum % 10)) % 10);
}
function validIsbn10(s) {
  if (!/^\d{9}[\dX]$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += (s[i] === 'X' ? 10 : Number(s[i])) * (10 - i);
  return sum % 11 === 0;
}
function validIsbn13(s) {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10 === Number(s[12]);
}
// returns a valid ISBN-13 or null
export function normalizeIsbn(v) {
  const s = cleanIsbn(v);
  if (s.length === 13 && validIsbn13(s)) return s;
  if (s.length === 10 && validIsbn10(s)) return isbn10to13(s);
  return null;
}

// ---------- crypto ----------
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const pinHash = (classId, pin) => sha256(`${classId}:${String(pin)}`);
function safeEqual(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function randomToken() {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function audit(env, class_id, actor, action, detail) {
  await env.DB.prepare('INSERT INTO audit_log (id, class_id, actor, action, detail, at) VALUES (?,?,?,?,?,?)')
    .bind(uid(), class_id, actor, action, typeof detail === 'string' ? detail : JSON.stringify(detail ?? {}), nowIso()).run();
}

async function checkPin(env, classId, kind, pin) {
  if (!pin) return false;
  const row = await env.DB.prepare('SELECT pin_hash FROM class_pins WHERE class_id=? AND kind=?').bind(classId, kind).first();
  if (!row) return false;
  return safeEqual(row.pin_hash, await pinHash(classId, pin));
}

// ---------- ISBN lookup chain ----------
async function fetchJson(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'ClassLibraryApp/1.0' } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function fetchImage(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'ClassLibraryApp/1.0' }, redirect: 'follow' });
    if (!r.ok) return null;
    const type = r.headers.get('content-type') || '';
    if (!type.startsWith('image/')) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 1500) return null; // placeholder / 1x1 gif
    return { buf, type };
  } catch { return null; }
}

async function lookupIsbn(env, isbn13) {
  const out = { isbn13, title: null, authors: null, publisher: null, year: null, description: null, categories: null, coverUrl: null, source: null };
  // 1) Google Books
  const key = env.GOOGLE_BOOKS_KEY ? `&key=${encodeURIComponent(env.GOOGLE_BOOKS_KEY)}` : '';
  const g = await fetchJson(`https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn13}&maxResults=1${key}`);
  const v = g?.items?.[0]?.volumeInfo;
  if (v) {
    out.title = [v.title, v.subtitle].filter(Boolean).join(': ');
    out.authors = (v.authors || []).join(', ') || null;
    out.publisher = v.publisher || null;
    out.year = v.publishedDate ? parseInt(v.publishedDate.slice(0, 4), 10) || null : null;
    out.description = v.description || null;
    out.categories = (v.categories || []).join(' / ') || null;
    const img = v.imageLinks?.thumbnail || v.imageLinks?.smallThumbnail;
    out.coverUrl = img ? img.replace('http://', 'https://').replace('&edge=curl', '') : null;
    out.source = 'google';
  }
  // 2) Open Library for anything missing
  if (!out.title || !out.authors || !out.coverUrl) {
    const o = await fetchJson(`https://openlibrary.org/isbn/${isbn13}.json`);
    if (o) {
      if (!out.title && o.title) out.title = o.title;
      if (!out.publisher && o.publishers?.[0]) out.publisher = o.publishers[0];
      if (!out.categories && o.subjects?.length) out.categories = o.subjects.slice(0, 4).map((x) => (typeof x === 'string' ? x : x.name)).join(' / ');
      if (!out.year && o.publish_date) out.year = parseInt(String(o.publish_date).match(/\d{4}/)?.[0] ?? '', 10) || null;
      if (!out.authors && o.authors?.[0]?.key) {
        const a = await fetchJson(`https://openlibrary.org${o.authors[0].key}.json`);
        if (a?.name) out.authors = a.name;
      }
      out.source = out.source ? out.source + '+openlibrary' : 'openlibrary';
    }
    if (!out.coverUrl) out.coverUrl = `https://covers.openlibrary.org/b/isbn/${isbn13}-M.jpg?default=false`;
  }
  return out;
}

async function saveBookWithCover(env, meta, { overwrite = false } = {}) {
  const existing = await env.DB.prepare('SELECT * FROM books WHERE isbn13=?').bind(meta.isbn13).first();
  let coverKey = existing?.cover_key ?? null;
  if (meta.coverUrl && (!coverKey || overwrite)) {
    const img = await fetchImage(meta.coverUrl);
    if (img) {
      coverKey = `covers/${meta.isbn13}.jpg`;
      await env.COVERS.put(coverKey, img.buf, { httpMetadata: { contentType: img.type } });
    }
  }
  const merged = {
    title: meta.title ?? existing?.title ?? null,
    authors: meta.authors ?? existing?.authors ?? null,
    publisher: meta.publisher ?? existing?.publisher ?? null,
    year: meta.year ?? existing?.year ?? null,
    description: meta.description ?? existing?.description ?? null,
    categories: meta.categories ?? existing?.categories ?? null,
    source: meta.source ?? existing?.source ?? 'manual',
  };
  await env.DB.prepare(
    `INSERT INTO books (isbn13,title,authors,publisher,year,description,categories,cover_key,source,fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(isbn13) DO UPDATE SET title=excluded.title, authors=excluded.authors, publisher=excluded.publisher,
       year=excluded.year, description=excluded.description, categories=excluded.categories, cover_key=excluded.cover_key, source=excluded.source, fetched_at=excluded.fetched_at`
  ).bind(meta.isbn13, merged.title, merged.authors, merged.publisher, merged.year, merged.description, merged.categories, coverKey, merged.source, nowIso()).run();
  return { isbn13: meta.isbn13, ...merged, cover_key: coverKey };
}

// ---------- kiosk ----------
async function kioskClass(env, request) {
  const token = request.headers.get('x-kiosk-token');
  if (!token) return null;
  return env.DB.prepare('SELECT * FROM classes WHERE kiosk_token=? AND archived_at IS NULL').bind(token).first();
}

const displayName = (p) => `${p.first_name} ${p.last_initial}.`;

async function kioskBootstrap(env, cls) {
  env.DB.prepare('UPDATE classes SET last_seen_at=? WHERE id=?').bind(nowIso(), cls.id).run().catch(() => {});
  const [pupils, books, loans, favs] = await Promise.all([
    env.DB.prepare('SELECT id, first_name, last_initial, emoji FROM pupils WHERE class_id=? AND active=1 ORDER BY first_name, last_initial').bind(cls.id).all(),
    env.DB.prepare(
      `SELECT h.isbn13, h.copies, b.title, b.authors, (b.cover_key IS NOT NULL OR b.cover_url IS NOT NULL) AS has_cover
       FROM holdings h JOIN books b ON b.isbn13=h.isbn13 WHERE h.class_id=? AND h.withdrawn=0 ORDER BY b.title`
    ).bind(cls.id).all(),
    env.DB.prepare('SELECT id, pupil_id, isbn13, due_at, lost_at FROM loans WHERE class_id=? AND returned_at IS NULL').bind(cls.id).all(),
    env.DB.prepare(
      `SELECT l.isbn13 FROM loans l JOIN responses r ON r.loan_id=l.id JOIN holdings h ON h.class_id=l.class_id AND h.isbn13=l.isbn13 AND h.withdrawn=0
       WHERE l.class_id=? AND r.stars IS NOT NULL GROUP BY l.isbn13 ORDER BY AVG(r.stars) DESC, COUNT(*) DESC LIMIT 8`
    ).bind(cls.id).all(),
  ]);
  return {
    class: { id: cls.id, name: cls.name, loan_days: cls.loan_days, max_loans: cls.max_loans },
    pupils: pupils.results.map((p) => ({ id: p.id, name: displayName(p), emoji: p.emoji })),
    books: books.results,
    loans: loans.results,
    favourites: favs.results.map((f) => f.isbn13),
    version: VERSION,
    now: nowIso(),
  };
}

async function applyAction(env, cls, a) {
  const at = a.at && !isNaN(Date.parse(a.at)) ? new Date(a.at).toISOString() : nowIso();
  const isbn = normalizeIsbn(a.isbn13);
  if (!a.id || !a.pupil_id || !isbn || !['borrow', 'return'].includes(a.type)) return { id: a.id, status: 'invalid' };

  const pupil = await env.DB.prepare('SELECT id FROM pupils WHERE id=? AND class_id=? AND active=1').bind(a.pupil_id, cls.id).first();
  if (!pupil) return { id: a.id, status: 'rejected', reason: 'pupil' };

  if (a.type === 'borrow') {
    const dup = await env.DB.prepare('SELECT id FROM loans WHERE id=?').bind(a.id).first();
    if (dup) return { id: a.id, status: 'duplicate' };

    const holding = await env.DB.prepare('SELECT copies FROM holdings WHERE class_id=? AND isbn13=? AND withdrawn=0').bind(cls.id, isbn).first();
    if (!holding) return { id: a.id, status: 'rejected', reason: 'not_in_class' };

    const overridden = a.override_pin ? await checkPin(env, cls.id, 'override', a.override_pin) : false;
    if (a.override_pin && !overridden) return { id: a.id, status: 'rejected', reason: 'bad_pin' };

    const open = await env.DB.prepare('SELECT isbn13, due_at FROM loans WHERE class_id=? AND pupil_id=? AND returned_at IS NULL AND lost_at IS NULL').bind(cls.id, a.pupil_id).all();
    const rows = open.results;
    const blocks = [];
    if (rows.length >= cls.max_loans) blocks.push('limit');
    if (rows.some((r) => r.due_at < at)) blocks.push('overdue');
    if (blocks.length && !overridden) return { id: a.id, status: 'blocked', reason: blocks[0] };
    if (rows.some((r) => r.isbn13 === isbn)) return { id: a.id, status: 'rejected', reason: 'has_title' };

    const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM loans WHERE class_id=? AND isbn13=? AND returned_at IS NULL').bind(cls.id, isbn).first();
    if (used.n >= holding.copies) return { id: a.id, status: 'rejected', reason: 'unavailable' };

    const due = new Date(Date.parse(at) + cls.loan_days * 86400000).toISOString();
    await env.DB.prepare('INSERT INTO loans (id,class_id,pupil_id,isbn13,borrowed_at,due_at,source) VALUES (?,?,?,?,?,?,?)')
      .bind(a.id, cls.id, a.pupil_id, isbn, at, due, a.source || 'kiosk').run();
    if (overridden) await audit(env, cls.id, 'override-pin', 'borrow_override', { loan: a.id, pupil: a.pupil_id, isbn, blocks });
    return { id: a.id, status: 'ok', due_at: due };
  }

  // return — never blocked
  const claim = await env.DB.prepare('INSERT OR IGNORE INTO audit_log (id,class_id,actor,action,detail,at) VALUES (?,?,?,?,?,?)')
    .bind(a.id, cls.id, a.source || 'kiosk', 'return', JSON.stringify({ pupil: a.pupil_id, isbn }), at).run();
  if (claim.meta.changes === 0) return { id: a.id, status: 'duplicate' };

  const loan = await env.DB.prepare(
    'SELECT id FROM loans WHERE class_id=? AND pupil_id=? AND isbn13=? AND returned_at IS NULL AND lost_at IS NULL ORDER BY borrowed_at DESC LIMIT 1'
  ).bind(cls.id, a.pupil_id, isbn).first();
  if (!loan) {
    await env.DB.prepare('UPDATE audit_log SET action=? WHERE id=?').bind('return_unmatched', a.id).run();
    return { id: a.id, status: 'flagged', reason: 'no_open_loan' };
  }
  await env.DB.prepare('UPDATE loans SET returned_at=? WHERE id=?').bind(at, loan.id).run();
  const r = a.response;
  if (r && (r.stars || r.emoji || r.recommend !== undefined || r.finished !== undefined)) {
    const stars = r.stars >= 1 && r.stars <= 5 ? Math.round(r.stars) : null;
    await env.DB.prepare('INSERT OR REPLACE INTO responses (loan_id,stars,emoji,recommend,finished,created_at) VALUES (?,?,?,?,?,?)')
      .bind(loan.id, stars, r.emoji ? String(r.emoji).slice(0, 8) : null,
        r.recommend === undefined || r.recommend === null ? null : (r.recommend ? 1 : 0),
        r.finished === undefined || r.finished === null ? null : (r.finished ? 1 : 0), at).run();
  }
  return { id: a.id, status: 'ok', loan_id: loan.id };
}

async function kioskSync(env, cls, body) {
  const actions = Array.isArray(body?.actions) ? body.actions.slice(0, 100) : [];
  actions.sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const results = [];
  for (const a of actions) {
    try { results.push(await applyAction(env, cls, a)); }
    catch (e) { results.push({ id: a?.id, status: 'error', reason: String(e.message || e) }); }
  }
  return { results, bootstrap: await kioskBootstrap(env, cls) };
}

// ---------- pupil summary: badges, streak, suggestions ----------
const LADDER = [
  [1, 'First finish', '🌱'], [3, 'Page turner', '📗'], [5, 'Bookworm', '🐛'],
  [10, 'Book explorer', '🧭'], [15, 'Story master', '🏅'], [25, 'Library legend', '👑'],
];
const weekIndex = (t) => Math.floor((t + 3 * 86400000) / (7 * 86400000)); // weeks start Monday (UTC)
const MIN_HELD_MS = 24 * 3600 * 1000;

async function pupilSummary(env, cls, pupilId) {
  const rows = (await env.DB.prepare(
    `SELECT l.isbn13, l.borrowed_at, l.returned_at, l.lost_at, r.stars, r.recommend, r.finished
     FROM loans l LEFT JOIN responses r ON r.loan_id=l.id WHERE l.class_id=? AND l.pupil_id=?`
  ).bind(cls.id, pupilId).all()).results;

  // Only a returned loan that was held 24h+ and marked finished counts toward badges and streaks.
  const counted = rows.filter((l) => l.returned_at && !l.lost_at && l.finished === 1 && Date.parse(l.returned_at) - Date.parse(l.borrowed_at) >= MIN_HELD_MS);
  const finished = counted.length;
  const earned = LADDER.filter((b) => finished >= b[0]).map((b) => ({ name: b[1], icon: b[2], at: b[0] }));
  const next = LADDER.find((b) => finished < b[0]);
  const weeks = new Set(counted.map((l) => weekIndex(Date.parse(l.returned_at))));
  let streak = 0, w = weekIndex(Date.now());
  if (!weeks.has(w)) w -= 1; // this week not done yet: streak still alive from last week
  while (weeks.has(w)) { streak++; w--; }
  const ratings = rows.filter((l) => l.stars).length;
  if (ratings >= 5) earned.push({ name: 'Critic', icon: '⭐', at: 0 });
  if (streak >= 2) earned.push({ name: `${streak}-week streak`, icon: '🔥', at: 0 });

  const loans = (await env.DB.prepare(
    `SELECT l.id, l.isbn13, l.due_at, b.title FROM loans l LEFT JOIN books b ON b.isbn13=l.isbn13
     WHERE l.class_id=? AND l.pupil_id=? AND l.returned_at IS NULL AND l.lost_at IS NULL ORDER BY l.due_at`
  ).bind(cls.id, pupilId).all()).results;

  return { finished, earned, next: next ? { name: next[1], icon: next[2], at: next[0], remaining: next[0] - finished } : null, streak, loans, suggestions: await suggestions(env, cls, pupilId, rows) };
}

const splitAuthors = (a) => String(a || '').toLowerCase().split(/,|&| and /).map((x) => x.trim()).filter(Boolean);
const splitCats = (c) => String(c || '').toLowerCase().split('/').map((x) => x.trim()).filter(Boolean);

async function suggestions(env, cls, pupilId, history, limit = 3) {
  const cand = (await env.DB.prepare(
    `SELECT h.isbn13, h.copies, b.title, b.authors, b.categories, b.publisher, (b.cover_key IS NOT NULL) AS has_cover,
            (SELECT COUNT(*) FROM loans o WHERE o.class_id=h.class_id AND o.isbn13=h.isbn13 AND o.returned_at IS NULL) AS out,
            (SELECT AVG(r.stars) FROM loans l JOIN responses r ON r.loan_id=l.id WHERE l.class_id=h.class_id AND l.isbn13=h.isbn13) AS avg_stars,
            (SELECT COUNT(*) FROM loans l JOIN responses r ON r.loan_id=l.id WHERE l.class_id=h.class_id AND l.isbn13=h.isbn13 AND r.recommend=1) AS recs
     FROM holdings h JOIN books b ON b.isbn13=h.isbn13 WHERE h.class_id=? AND h.withdrawn=0 AND b.title IS NOT NULL`
  ).bind(cls.id).all()).results;

  const seen = new Set(history.map((l) => l.isbn13));
  const liked = history.filter((l) => l.returned_at && (l.stars >= 4 || l.recommend === 1 || l.finished === 1));
  const likedBooks = cand.filter((c) => liked.some((l) => l.isbn13 === c.isbn13));
  const likeAuthors = new Map(), likeCats = new Map();
  for (const b of likedBooks) {
    splitAuthors(b.authors).forEach((a) => likeAuthors.set(a, b));
    splitCats(b.categories).forEach((c) => likeCats.set(c, b));
  }

  const scored = cand.filter((c) => !seen.has(c.isbn13) && c.copies - c.out > 0).map((c) => {
    let score = 0, reason = null;
    for (const a of splitAuthors(c.authors)) if (likeAuthors.has(a)) { score += 4; reason = reason || `More by ${c.authors.split(',')[0].trim()}`; }
    let shared = 0, via = null;
    for (const k of splitCats(c.categories)) if (likeCats.has(k)) { shared++; via = via || likeCats.get(k); }
    if (shared) { score += Math.min(shared, 2) * 2; reason = reason || `Like “${via.title}”`; }
    if (c.avg_stars >= 4) { score += 1.5; reason = reason || `Classmates rated it ★${(Math.round(c.avg_stars * 10) / 10)}`; }
    score += Math.min(c.recs, 3) * 0.5;
    if (c.recs && !reason) reason = 'Classmates recommend it';
    return { c, score, reason: reason || 'Something new to try' };
  });
  // stable shuffle for ties so the same few books are not always shown
  scored.forEach((x) => { x.tie = Math.random(); });
  scored.sort((a, b) => b.score - a.score || a.tie - b.tie);
  return scored.slice(0, limit).map((x) => ({ isbn13: x.c.isbn13, title: x.c.title, authors: x.c.authors, has_cover: !!x.c.has_cover, reason: x.reason }));
}

// ---------- admin auth ----------
const VERSION = '1.1.0';

const b64urlToBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
let jwksCache = { at: 0, keys: null };
async function accessKeys(env) {
  if (env.ACCESS_JWKS_JSON) return JSON.parse(env.ACCESS_JWKS_JSON).keys; // test override
  if (jwksCache.keys && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error('jwks');
  jwksCache = { at: Date.now(), keys: (await r.json()).keys };
  return jwksCache.keys;
}
// Verifies a Cloudflare Access JWT (RS256) and returns the email, or null.
async function verifyAccessJwt(env, token) {
  try {
    if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD || !token) return null;
    const [h, p, sig] = token.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    if (header.alg !== 'RS256') return null;
    const jwk = (await accessKeys(env)).find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    if (payload.nbf && payload.nbf > now + 30) return null;
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    return payload.email ? String(payload.email).toLowerCase() : null;
  } catch { return null; }
}
function cookie(request, name) {
  const m = (request.headers.get('cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
}
// Returns { email, role: 'superadmin'|'teacher', classIds: Set|null (null = all) } or null.
async function adminUser(env, request) {
  const key = request.headers.get('x-admin-key');
  if (env.ADMIN_KEY && key && safeEqual(key, env.ADMIN_KEY)) return { email: 'admin-key', name: 'Admin key', role: 'superadmin', classIds: null };
  const jwt = request.headers.get('cf-access-jwt-assertion') || cookie(request, 'CF_Authorization');
  const email = await verifyAccessJwt(env, jwt);
  if (!email) return null;
  const supers = String(env.SUPERADMIN_EMAILS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const row = await env.DB.prepare('SELECT email,name,role FROM users WHERE email=?').bind(email).first();
  if (supers.includes(email) || row?.role === 'superadmin') return { email, name: row?.name || email, role: 'superadmin', classIds: null };
  if (!row) return { email, role: 'unregistered', classIds: new Set() };
  const cls = await env.DB.prepare('SELECT class_id FROM user_classes WHERE email=?').bind(email).all();
  return { email, name: row.name || email, role: 'teacher', classIds: new Set(cls.results.map((c) => c.class_id)) };
}
const canClass = (u, classId) => u.classIds === null || u.classIds.has(classId);

const pupilFull = (p) => `${p.first_name} ${p.full_surname || p.last_initial + '.'}`;

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // neutralise spreadsheet formulas
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

async function report(env, classId, name) {
  const now = nowIso();
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((r) => r.results);
  if (name === 'overdue') {
    const rows = await q(
      `SELECT l.id AS loan_id, p.first_name, p.last_initial, p.full_surname, b.title, l.isbn13, l.borrowed_at, l.due_at
       FROM loans l JOIN pupils p ON p.id=l.pupil_id LEFT JOIN books b ON b.isbn13=l.isbn13
       WHERE l.class_id=? AND l.returned_at IS NULL AND l.lost_at IS NULL AND l.due_at < ? ORDER BY l.due_at`, classId, now);
    return rows.map((r) => ({ loan_id: r.loan_id, pupil: pupilFull(r), title: r.title, isbn13: r.isbn13, borrowed: r.borrowed_at.slice(0, 10), due: r.due_at.slice(0, 10), days_late: Math.floor((Date.parse(now) - Date.parse(r.due_at)) / 86400000) }));
  }
  if (name === 'on-loan') {
    const rows = await q(
      `SELECT l.id AS loan_id, p.first_name, p.last_initial, p.full_surname, b.title, l.isbn13, l.borrowed_at, l.due_at
       FROM loans l JOIN pupils p ON p.id=l.pupil_id LEFT JOIN books b ON b.isbn13=l.isbn13
       WHERE l.class_id=? AND l.returned_at IS NULL AND l.lost_at IS NULL ORDER BY l.due_at`, classId);
    return rows.map((r) => ({ loan_id: r.loan_id, pupil: pupilFull(r), title: r.title, isbn13: r.isbn13, borrowed: r.borrowed_at.slice(0, 10), due: r.due_at.slice(0, 10) }));
  }
  if (name === 'lost') {
    const rows = await q(
      `SELECT l.id AS loan_id, p.first_name, p.last_initial, p.full_surname, b.title, l.isbn13, l.lost_at, l.note
       FROM loans l JOIN pupils p ON p.id=l.pupil_id LEFT JOIN books b ON b.isbn13=l.isbn13
       WHERE l.class_id=? AND l.lost_at IS NOT NULL AND l.returned_at IS NULL ORDER BY l.lost_at DESC`, classId);
    return rows.map((r) => ({ loan_id: r.loan_id, pupil: pupilFull(r), title: r.title, isbn13: r.isbn13, lost_on: r.lost_at.slice(0, 10), note: r.note }));
  }
  if (name === 'popular') {
    return q(
      `SELECT b.title, b.authors, h.isbn13, COUNT(l.id) AS borrows, ROUND(AVG(r.stars),1) AS avg_stars,
              SUM(CASE WHEN r.recommend=1 THEN 1 ELSE 0 END) AS recommends
       FROM holdings h JOIN books b ON b.isbn13=h.isbn13
       LEFT JOIN loans l ON l.class_id=h.class_id AND l.isbn13=h.isbn13
       LEFT JOIN responses r ON r.loan_id=l.id
       WHERE h.class_id=? GROUP BY h.isbn13 HAVING borrows>0 ORDER BY borrows DESC, avg_stars DESC LIMIT 100`, classId);
  }
  if (name === 'never-borrowed') {
    return q(
      `SELECT b.title, b.authors, h.isbn13 FROM holdings h JOIN books b ON b.isbn13=h.isbn13
       WHERE h.class_id=? AND h.withdrawn=0 AND NOT EXISTS (SELECT 1 FROM loans l WHERE l.class_id=h.class_id AND l.isbn13=h.isbn13)
       ORDER BY b.title`, classId);
  }
  if (name === 'pupils') {
    const rows = await q(
      `SELECT p.first_name, p.last_initial, p.full_surname, COUNT(l.id) AS borrowed,
              SUM(CASE WHEN l.returned_at IS NOT NULL THEN 1 ELSE 0 END) AS returned,
              SUM(CASE WHEN r.finished=1 THEN 1 ELSE 0 END) AS finished,
              ROUND(AVG(r.stars),1) AS avg_stars_given
       FROM pupils p LEFT JOIN loans l ON l.pupil_id=p.id LEFT JOIN responses r ON r.loan_id=l.id
       WHERE p.class_id=? AND p.active=1 GROUP BY p.id ORDER BY borrowed DESC, p.first_name`, classId);
    return rows.map((r) => ({ pupil: pupilFull(r), borrowed: r.borrowed, returned: r.returned, finished: r.finished, avg_stars_given: r.avg_stars_given }));
  }
  if (name === 'history') {
    const rows = await q(
      `SELECT p.first_name, p.last_initial, p.full_surname, b.title, l.isbn13, l.borrowed_at, l.returned_at, l.lost_at, r.stars, r.emoji, r.recommend, r.finished
       FROM loans l JOIN pupils p ON p.id=l.pupil_id LEFT JOIN books b ON b.isbn13=l.isbn13 LEFT JOIN responses r ON r.loan_id=l.id
       WHERE l.class_id=? ORDER BY l.borrowed_at DESC LIMIT 1000`, classId);
    return rows.map((r) => ({ pupil: pupilFull(r), title: r.title, isbn13: r.isbn13, borrowed: r.borrowed_at.slice(0, 10), returned: r.returned_at?.slice(0, 10) ?? '', lost: r.lost_at?.slice(0, 10) ?? '', stars: r.stars, emoji: r.emoji, recommend: r.recommend, finished: r.finished }));
  }
  return null;
}


async function attention(env, classId) {
  const items = [];
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).all().then((x) => x.results);
  const cls = await env.DB.prepare('SELECT last_seen_at FROM classes WHERE id=?').bind(classId).first();
  const [pins, counts, overdue, nocover, notitle, lost, flagged] = await Promise.all([
    q('SELECT kind FROM class_pins WHERE class_id=?', classId),
    env.DB.prepare('SELECT (SELECT COUNT(*) FROM holdings WHERE class_id=? AND withdrawn=0) AS titles, (SELECT COUNT(*) FROM pupils WHERE class_id=? AND active=1) AS pupils').bind(classId, classId).first(),
    report(env, classId, 'overdue'),
    q(`SELECT b.isbn13, b.title FROM holdings h JOIN books b ON b.isbn13=h.isbn13 WHERE h.class_id=? AND h.withdrawn=0 AND b.cover_key IS NULL AND b.title IS NOT NULL`, classId),
    q(`SELECT b.isbn13 FROM holdings h JOIN books b ON b.isbn13=h.isbn13 WHERE h.class_id=? AND h.withdrawn=0 AND (b.title IS NULL OR b.title='')`, classId),
    report(env, classId, 'lost'),
    q(`SELECT COUNT(*) AS n FROM audit_log WHERE class_id=? AND action='return_unmatched' AND at > ?`, classId, new Date(Date.now() - 14 * 86400000).toISOString()),
  ]);
  if (!counts.pupils) items.push({ level: 'todo', title: 'No pupils yet', detail: 'Add your class list so pupils can pick their names.', tab: 'pupils' });
  if (!counts.titles) items.push({ level: 'todo', title: 'No books yet', detail: 'Scan, type or import ISBNs.', tab: 'books' });
  const kinds = new Set(pins.map((p) => p.kind));
  if (!kinds.has('override')) items.push({ level: 'todo', title: 'Teacher PIN not set', detail: 'Without it you cannot approve a blocked borrow from the kiosk.', tab: 'setup' });
  if (!kinds.has('librarian')) items.push({ level: 'todo', title: 'Librarian PIN not set', detail: 'The class librarian cannot unlock the kiosk helper screen.', tab: 'setup' });
  if (overdue.length) items.push({ level: 'act', title: `${overdue.length} overdue book${overdue.length > 1 ? 's' : ''}`, detail: [...new Set(overdue.map((o) => o.pupil))].slice(0, 6).join(', '), tab: 'dash' });
  if (lost.length) items.push({ level: 'info', title: `${lost.length} lost book${lost.length > 1 ? 's' : ''}`, detail: 'Mark as found when one turns up.', tab: 'dash' });
  if (notitle.length) items.push({ level: 'act', title: `${notitle.length} book${notitle.length > 1 ? 's have' : ' has'} no title`, detail: 'The lookup found nothing. Type the title in the Books tab.', tab: 'books' });
  if (nocover.length) items.push({ level: 'info', title: `${nocover.length} book${nocover.length > 1 ? 's have' : ' has'} no cover`, detail: 'Take a photo from the Books tab so pupils can find them by cover.', tab: 'books' });
  if (flagged[0]?.n) items.push({ level: 'info', title: `${flagged[0].n} return${flagged[0].n > 1 ? 's' : ''} had no matching loan (last 14 days)`, detail: 'Usually a book returned under the wrong name. Check the Activity log.', tab: 'reports' });
  const seen = cls?.last_seen_at ? Date.parse(cls.last_seen_at) : 0;
  if (!seen) items.push({ level: 'todo', title: 'Kiosk has never connected', detail: 'Open the kiosk link on the tablet (Kiosk & PINs tab).', tab: 'setup' });
  else if (Date.now() - seen > 3 * 86400000) items.push({ level: 'act', title: 'Kiosk has not synced for 3+ days', detail: `Last seen ${new Date(seen).toISOString().slice(0, 16).replace('T', ' ')} UTC. Check the tablet is on and online.`, tab: 'setup' });
  return { items, counts, last_seen_at: cls?.last_seen_at || null };
}

const EMOJIS = ['🦊', '🐼', '🐯', '🦁', '🐸', '🐙', '🦄', '🐳', '🦋', '🐢', '🦉', '🐨', '🐧', '🦖', '🚀', '⭐', '🌈', '🍎', '⚽', '🎨'];

async function handleAdmin(request, env, url) {
  const user = await adminUser(env, request);
  if (!user) return err(401, 'unauthorized', 'Sign in required');
  const path = url.pathname.replace(/^\/api\/admin/, '');
  const m = request.method;
  const isUpload = /^\/books\/\d{13}\/cover$/.test(path);
  const body = ['POST', 'PUT', 'PATCH'].includes(m) && !isUpload ? await request.json().catch(() => ({})) : {};
  let r;
  const isSuper = user.role === 'superadmin';
  const forbid = () => err(403, 'forbidden', 'You do not have access to this');

  if (path === '/me') {
    return json({ email: user.email, name: user.name || user.email, role: user.role, version: VERSION, access_configured: !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) });
  }
  if (user.role === 'unregistered') return err(403, 'not_registered', `${user.email} is signed in but has not been added as a teacher. Ask the supervisor.`);

  // class-scoped routes: a teacher may only touch assigned classes
  const mc = path.match(/^\/classes\/([\w-]+)/);
  if (mc && !canClass(user, mc[1])) return forbid();
  const mp = path.match(/^\/pupils\/([\w-]+)$/);
  if (mp && !isSuper) {
    const p = await env.DB.prepare('SELECT class_id FROM pupils WHERE id=?').bind(mp[1]).first();
    if (!p || !canClass(user, p.class_id)) return forbid();
  }
  const mb = path.match(/^\/books\/(\d{13})(?:\/cover)?$/);
  if (mb && !isSuper) {
    const ids = [...user.classIds];
    const held = ids.length ? await env.DB.prepare(`SELECT 1 FROM holdings WHERE isbn13=? AND class_id IN (${ids.map(() => '?').join(',')})`).bind(mb[1], ...ids).first() : null;
    if (!held) return forbid();
  }
  if (/^\/(teachers|overview|audit)/.test(path) && !isSuper) return forbid();

  if (m === 'GET' && path === '/classes') {
    const rows = await env.DB.prepare('SELECT id,name,kiosk_token,loan_days,max_loans,archived_at,last_seen_at FROM classes ORDER BY name').all();
    return json(rows.results.filter((c) => canClass(user, c.id)));
  }
  if (m === 'GET' && path === '/overview') {
    const rows = (await env.DB.prepare(
      `SELECT c.id, c.name, c.last_seen_at,
        (SELECT COUNT(*) FROM holdings h WHERE h.class_id=c.id AND h.withdrawn=0) AS titles,
        (SELECT COUNT(*) FROM pupils p WHERE p.class_id=c.id AND p.active=1) AS pupils,
        (SELECT COUNT(*) FROM loans l WHERE l.class_id=c.id AND l.returned_at IS NULL AND l.lost_at IS NULL) AS on_loan,
        (SELECT COUNT(*) FROM loans l WHERE l.class_id=c.id AND l.returned_at IS NULL AND l.lost_at IS NULL AND l.due_at < ?) AS overdue,
        (SELECT COUNT(*) FROM loans l WHERE l.class_id=c.id AND l.lost_at IS NOT NULL AND l.returned_at IS NULL) AS lost,
        (SELECT GROUP_CONCAT(uc.email) FROM user_classes uc WHERE uc.class_id=c.id) AS teachers
       FROM classes c WHERE c.archived_at IS NULL ORDER BY c.name`).bind(nowIso()).all()).results;
    return json(rows.map((x) => ({ ...x, teachers: x.teachers ? x.teachers.split(',') : [] })));
  }
  if (m === 'GET' && path === '/teachers') {
    const us = (await env.DB.prepare('SELECT email,name,role FROM users ORDER BY email').all()).results;
    const map = (await env.DB.prepare('SELECT email,class_id FROM user_classes').all()).results;
    return json(us.map((u) => ({ ...u, class_ids: map.filter((x) => x.email === u.email).map((x) => x.class_id) })));
  }
  if (m === 'POST' && path === '/teachers') {
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err(400, 'email', 'A valid email is required');
    const role = body.role === 'superadmin' ? 'superadmin' : 'teacher';
    await env.DB.prepare('INSERT INTO users (email,name,role,created_at) VALUES (?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name, role=excluded.role')
      .bind(email, body.name ? String(body.name).slice(0, 60) : null, role, nowIso()).run();
    const ids = Array.isArray(body.class_ids) ? body.class_ids.filter((x) => /^[\w-]+$/.test(x)) : [];
    await env.DB.batch([
      env.DB.prepare('DELETE FROM user_classes WHERE email=?').bind(email),
      ...ids.map((id) => env.DB.prepare('INSERT OR IGNORE INTO user_classes (email,class_id) VALUES (?,?)').bind(email, id)),
    ]);
    await audit(env, null, user.email, 'teacher_saved', { email, role, classes: ids.length });
    return json({ ok: true });
  }
  if (m === 'POST' && path === '/teachers/remove') {
    const email = String(body.email || '').toLowerCase();
    await env.DB.batch([env.DB.prepare('DELETE FROM user_classes WHERE email=?').bind(email), env.DB.prepare('DELETE FROM users WHERE email=?').bind(email)]);
    await audit(env, null, user.email, 'teacher_removed', { email });
    return json({ ok: true });
  }
  if (m === 'GET' && path === '/audit') {
    const rows = await env.DB.prepare('SELECT a.class_id, c.name AS class_name, a.actor, a.action, a.detail, a.at FROM audit_log a LEFT JOIN classes c ON c.id=a.class_id ORDER BY a.at DESC LIMIT 300').all();
    return json(rows.results);
  }
  if ((r = path.match(/^\/classes\/([\w-]+)\/attention$/)) && m === 'GET') {
    return json(await attention(env, r[1]));
  }
  if ((r = path.match(/^\/books\/(\d{13})$/)) && m === 'POST') {
    const sets = [], vals = [];
    for (const f of ['title', 'authors', 'publisher', 'categories']) if (body[f] !== undefined) { sets.push(`${f}=?`); vals.push(String(body[f]).trim().slice(0, 200) || null); }
    if (body.year !== undefined) { sets.push('year=?'); vals.push(parseInt(body.year, 10) || null); }
    if (sets.length) await env.DB.prepare(`UPDATE books SET ${sets.join(',')} WHERE isbn13=?`).bind(...vals, r[1]).run();
    if (body.class_id && canClass(user, body.class_id) && (body.copies !== undefined || body.withdrawn !== undefined)) {
      if (body.copies !== undefined) await env.DB.prepare('UPDATE holdings SET copies=? WHERE class_id=? AND isbn13=?').bind(Math.max(1, Math.min(20, parseInt(body.copies, 10) || 1)), body.class_id, r[1]).run();
      if (body.withdrawn !== undefined) await env.DB.prepare('UPDATE holdings SET withdrawn=? WHERE class_id=? AND isbn13=?').bind(body.withdrawn ? 1 : 0, body.class_id, r[1]).run();
    }
    await audit(env, body.class_id || null, user.email, 'book_edited', { isbn: r[1], fields: Object.keys(body).filter((k) => k !== 'class_id') });
    return json({ ok: true });
  }
  if (m === 'POST' && path === '/classes') {
    if (!isSuper) return forbid();
    if (!body.name) return err(400, 'name', 'Class name required');
    const id = uid(), token = randomToken();
    await env.DB.prepare('INSERT INTO classes (id,name,kiosk_token,loan_days,max_loans) VALUES (?,?,?,?,?)')
      .bind(id, String(body.name).slice(0, 60), token, Number(body.loan_days) || 14, Number(body.max_loans) || 3).run();
    return json({ id, name: body.name, kiosk_token: token });
  }
  if ((r = path.match(/^\/classes\/([\w-]+)\/pin$/)) && m === 'POST') {
    if (!['librarian', 'override'].includes(body.kind) || !/^\d{4,8}$/.test(String(body.pin ?? ''))) return err(400, 'pin', 'kind and 4-8 digit pin required');
    await env.DB.prepare('INSERT OR REPLACE INTO class_pins (class_id,kind,pin_hash) VALUES (?,?,?)').bind(r[1], body.kind, await pinHash(r[1], body.pin)).run();
    await audit(env, r[1], user.email, 'pin_set', { kind: body.kind });
    return json({ ok: true });
  }
  if ((r = path.match(/^\/classes\/([\w-]+)\/rotate-token$/)) && m === 'POST') {
    const token = randomToken();
    await env.DB.prepare('UPDATE classes SET kiosk_token=? WHERE id=?').bind(token, r[1]).run();
    await audit(env, r[1], user.email, 'token_rotated', {});
    return json({ kiosk_token: token });
  }
  if ((r = path.match(/^\/classes\/([\w-]+)\/archive$/)) && m === 'POST') {
    const c = r[1];
    await env.DB.batch([
      env.DB.prepare('DELETE FROM responses WHERE loan_id IN (SELECT id FROM loans WHERE class_id=?)').bind(c),
      env.DB.prepare('DELETE FROM loans WHERE class_id=?').bind(c),
      env.DB.prepare('DELETE FROM pupils WHERE class_id=?').bind(c),
      env.DB.prepare('UPDATE classes SET archived_at=? WHERE id=?').bind(nowIso(), c),
    ]);
    await audit(env, c, user.email, 'class_archived', {});
    return json({ ok: true });
  }
  if ((r = path.match(/^\/classes\/([\w-]+)\/dashboard$/)) && m === 'GET') {
    const c = r[1];
    const [onLoan, overdue, lost] = await Promise.all([report(env, c, 'on-loan'), report(env, c, 'overdue'), report(env, c, 'lost')]);
    const counts = await env.DB.prepare('SELECT (SELECT COUNT(*) FROM holdings WHERE class_id=? AND withdrawn=0) AS titles, (SELECT COUNT(*) FROM pupils WHERE class_id=? AND active=1) AS pupils').bind(c, c).first();
    return json({ counts, onLoan, overdue, lost });
  }
  if ((r = path.match(/^\/classes\/([\w-]+)\/reports\/([\w-]+)$/)) && m === 'GET') {
    const rows = await report(env, r[1], r[2]);
    if (!rows) return err(404, 'report', 'Unknown report');
    if (url.searchParams.get('format') === 'csv') {
      return new Response(toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${r[2]}.csv"` } });
    }
    return json(rows);
  }
  if ((r = path.match(/^\/classes\/([\w-]+)\/pupils$/))) {
    const c = r[1];
    if (m === 'GET') {
      const rows = await env.DB.prepare('SELECT id,first_name,last_initial,full_surname,emoji,active FROM pupils WHERE class_id=? ORDER BY active DESC, first_name').bind(c).all();
      return json(rows.results);
    }
    if (m === 'POST') {
      const list = Array.isArray(body.pupils) ? body.pupils : [body];
      const added = [], skipped = [];
      const taken = new Set((await env.DB.prepare('SELECT emoji FROM pupils WHERE class_id=? AND active=1').bind(c).all()).results.map((x) => x.emoji));
      for (const p of list.slice(0, 100)) {
        const first = String(p.first_name ?? '').trim().slice(0, 30);
        const last = String(p.last_name ?? p.full_surname ?? '').trim();
        const initial = (String(p.last_initial ?? last).trim()[0] || '').toUpperCase();
        if (!first || !initial) { skipped.push({ ...p, reason: 'name' }); continue; }
        const dup = await env.DB.prepare('SELECT 1 FROM pupils WHERE class_id=? AND first_name=? AND last_initial=?').bind(c, first, initial).first();
        if (dup) { skipped.push({ first_name: first, last_initial: initial, reason: 'duplicate display name — add a 2nd letter to one first name' }); continue; }
        const emoji = p.emoji || EMOJIS.find((e) => !taken.has(e)) || EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
        taken.add(emoji);
        const id = uid();
        await env.DB.prepare('INSERT INTO pupils (id,class_id,first_name,last_initial,full_surname,emoji) VALUES (?,?,?,?,?,?)')
          .bind(id, c, first, initial, body.store_surname && last ? last : null, emoji).run();
        added.push({ id, name: `${first} ${initial}.`, emoji });
      }
      return json({ added, skipped });
    }
  }
  if ((r = path.match(/^\/pupils\/([\w-]+)$/)) && m === 'POST') {
    const sets = [], vals = [];
    if (body.emoji) { sets.push('emoji=?'); vals.push(String(body.emoji).slice(0, 8)); }
    if (body.active !== undefined) { sets.push('active=?'); vals.push(body.active ? 1 : 0); }
    if (body.first_name) { sets.push('first_name=?'); vals.push(String(body.first_name).slice(0, 30)); }
    if (!sets.length) return err(400, 'empty', 'Nothing to update');
    await env.DB.prepare(`UPDATE pupils SET ${sets.join(',')} WHERE id=?`).bind(...vals, r[1]).run();
    return json({ ok: true });
  }
  if ((r = path.match(/^\/classes\/([\w-]+)\/books$/))) {
    const c = r[1];
    if (m === 'GET') {
      const rows = await env.DB.prepare(
        `SELECT h.isbn13,h.copies,h.withdrawn,b.title,b.authors,b.cover_key IS NOT NULL AS has_cover,b.source,
                (SELECT COUNT(*) FROM loans l WHERE l.class_id=h.class_id AND l.isbn13=h.isbn13 AND l.returned_at IS NULL) AS out
         FROM holdings h JOIN books b ON b.isbn13=h.isbn13 WHERE h.class_id=? ORDER BY b.title`).bind(c).all();
      return json(rows.results);
    }
    if (m === 'POST') {
      const isbn = normalizeIsbn(body.isbn13 ?? body.isbn);
      if (!isbn) return err(400, 'isbn', 'Invalid ISBN');
      const known = await env.DB.prepare('SELECT * FROM books WHERE isbn13=?').bind(isbn).first();
      let meta = { isbn13: isbn, title: body.title || null, authors: body.authors || null, publisher: body.publisher || null, year: body.year || null, description: null, coverUrl: null, source: null };
      let looked = false;
      if (!known || !known.title || !known.cover_key) {
        const found = await lookupIsbn(env, isbn);
        looked = true;
        meta = { ...found, title: body.title || found.title, authors: body.authors || found.authors, publisher: body.publisher || found.publisher, year: body.year || found.year };
        if (!found.source) meta.source = 'manual';
      }
      const saved = await saveBookWithCover(env, meta);
      const copies = Math.max(1, Math.min(20, Number(body.copies) || 1));
      const had = await env.DB.prepare('SELECT id,copies FROM holdings WHERE class_id=? AND isbn13=?').bind(c, isbn).first();
      if (had) {
        const newCopies = body.set_copies ? copies : had.copies + (body.add ? copies : 0);
        await env.DB.prepare('UPDATE holdings SET copies=?, withdrawn=0 WHERE id=?').bind(newCopies, had.id).run();
      } else {
        await env.DB.prepare('INSERT INTO holdings (id,class_id,isbn13,copies) VALUES (?,?,?,?)').bind(uid(), c, isbn, copies).run();
      }
      return json({ ...saved, copies: had ? undefined : copies, existed: !!had, looked_up: looked, needs_attention: !saved.title || !saved.cover_key });
    }
  }
  if ((r = path.match(/^\/classes\/([\w-]+)\/import$/)) && m === 'POST') {
    const rows = Array.isArray(body.rows) ? body.rows.slice(0, 25) : [];
    const out = [];
    for (const row of rows) {
      const isbn = normalizeIsbn(row.isbn);
      if (!isbn) { out.push({ isbn: row.isbn, status: 'invalid_isbn' }); continue; }
      try {
        const known = await env.DB.prepare('SELECT title, cover_key FROM books WHERE isbn13=?').bind(isbn).first();
        let meta = { isbn13: isbn, title: row.title || null, authors: row.authors || null, publisher: row.publisher || null, year: row.year ? parseInt(row.year, 10) || null : null, description: null, coverUrl: null, source: row.title ? 'import' : null };
        if (!known || !known.cover_key || (!known.title && !row.title)) {
          const found = await lookupIsbn(env, isbn);
          meta = { ...found, title: row.title || found.title, authors: row.authors || found.authors, publisher: row.publisher || found.publisher, year: meta.year || found.year, source: found.source || meta.source || 'import' };
        }
        const saved = await saveBookWithCover(env, meta);
        const copies = Math.max(1, Math.min(20, parseInt(row.copies, 10) || 1));
        await env.DB.prepare(
          'INSERT INTO holdings (id,class_id,isbn13,copies) VALUES (?,?,?,?) ON CONFLICT(class_id,isbn13) DO UPDATE SET copies=excluded.copies, withdrawn=0'
        ).bind(uid(), r[1], isbn, copies).run();
        out.push({ isbn: isbn, status: saved.title ? (saved.cover_key ? 'ok' : 'no_cover') : 'no_match', title: saved.title });
      } catch (e) { out.push({ isbn, status: 'error', message: String(e.message || e) }); }
    }
    return json({ results: out });
  }
  if ((r = path.match(/^\/books\/(\d{13})\/cover$/)) && m === 'POST') {
    const type = request.headers.get('content-type') || 'image/jpeg';
    if (!type.startsWith('image/')) return err(400, 'type', 'Image required');
    const buf = await request.arrayBuffer();
    if (buf.byteLength > 2_000_000) return err(413, 'size', 'Image too large');
    const key = `covers/${r[1]}.jpg`;
    await env.COVERS.put(key, buf, { httpMetadata: { contentType: type } });
    await env.DB.prepare('UPDATE books SET cover_key=? WHERE isbn13=?').bind(key, r[1]).run();
    return json({ ok: true });
  }
  if ((r = path.match(/^\/loans\/([\w-]+)\/(lost|found)$/)) && m === 'POST') {
    const loan = await env.DB.prepare('SELECT * FROM loans WHERE id=?').bind(r[1]).first();
    if (!loan) return err(404, 'loan', 'Loan not found');
    if (!canClass(user, loan.class_id)) return forbid();
    if (r[2] === 'lost') {
      if (loan.returned_at || loan.lost_at) return err(409, 'state', 'Loan is not open');
      await env.DB.prepare('UPDATE loans SET lost_at=?, note=? WHERE id=?').bind(nowIso(), body.note ? String(body.note).slice(0, 200) : null, loan.id).run();
    } else {
      if (!loan.lost_at || loan.returned_at) return err(409, 'state', 'Loan is not marked lost');
      const t = nowIso();
      await env.DB.prepare('UPDATE loans SET found_at=?, returned_at=? WHERE id=?').bind(t, t, loan.id).run();
    }
    await audit(env, loan.class_id, user.email, `loan_${r[2]}`, { loan: loan.id, pupil: loan.pupil_id, isbn: loan.isbn13 });
    return json({ ok: true });
  }
  if ((r = path.match(/^\/classes\/([\w-]+)\/audit$/)) && m === 'GET') {
    const rows = await env.DB.prepare('SELECT actor,action,detail,at FROM audit_log WHERE class_id=? ORDER BY at DESC LIMIT 200').bind(r[1]).all();
    return json(rows.results);
  }
  return err(404, 'not_found', 'Unknown admin endpoint');
}

// ---------- router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (!path.startsWith('/api/')) return env.ASSETS.fetch(request);

      if (path === '/api/version') return json({ version: VERSION });
      if (path.startsWith('/api/admin/')) return await handleAdmin(request, env, url);

      if (path.startsWith('/api/cover/')) {
        const isbn = path.split('/').pop();
        if (!/^\d{13}$/.test(isbn)) return err(400, 'isbn', 'Bad ISBN');
        const book = await env.DB.prepare('SELECT cover_key FROM books WHERE isbn13=?').bind(isbn).first();
        if (!book?.cover_key) return new Response('', { status: 404 });
        const obj = await env.COVERS.get(book.cover_key);
        if (!obj) return new Response('', { status: 404 });
        return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'public, max-age=604800' } });
      }

      if (path.startsWith('/api/kiosk/')) {
        const cls = await kioskClass(env, request);
        if (!cls) return err(401, 'unauthorized', 'Unknown or revoked kiosk token');
        if (path === '/api/kiosk/bootstrap' && request.method === 'GET') return json(await kioskBootstrap(env, cls));
        if (path === '/api/kiosk/sync' && request.method === 'POST') return json(await kioskSync(env, cls, await request.json().catch(() => ({}))));
        const sm = path.match(/^\/api\/kiosk\/pupil\/([\w-]+)\/summary$/);
        if (sm && request.method === 'GET') {
          const ok = await env.DB.prepare('SELECT 1 FROM pupils WHERE id=? AND class_id=? AND active=1').bind(sm[1], cls.id).first();
          if (!ok) return err(404, 'pupil', 'Unknown pupil');
          return json(await pupilSummary(env, cls, sm[1]));
        }
        if (path === '/api/version') return json({ version: VERSION });
        if (path === '/api/kiosk/unlock' && request.method === 'POST') {
          const b = await request.json().catch(() => ({}));
          if (!['librarian', 'override'].includes(b.kind)) return err(400, 'kind', 'kind required');
          const ok = await checkPin(env, cls.id, b.kind, b.pin);
          if (!ok) await new Promise((res) => setTimeout(res, 800)); // slow brute-force attempts
          return json({ ok });
        }
        return err(404, 'not_found', 'Unknown kiosk endpoint');
      }
      return err(404, 'not_found', 'Not found');
    } catch (e) {
      console.error('unhandled', e);
      return err(500, 'server', 'Something went wrong');
    }
  },
};
