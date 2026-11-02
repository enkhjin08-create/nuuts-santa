/* ============================================================
   Нууц Санта — API (Netlify Functions v2 + Netlify Blobs)

   Түлхүүрүүд (store: "nuuts-santa"):
     g/{gid}/meta            → бүлгийн мэдээлэл (adminKey-тай)
     g/{gid}/p/{token}       → оролцогч (token = хувийн нууц линк)
     g/{gid}/t/{recipientId} → Санта ↔ хүлээн авагчийн нэрээ нууцалсан чат

   Хэрэв "environment has not been configured" алдаа гарвал Netlify дээр
   NETLIFY_SITE_ID ба NETLIFY_BLOBS_TOKEN орчны хувьсагчийг тохируулна.
   ============================================================ */
import { getStore } from "@netlify/blobs";

function store() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN;
  if (siteID && token) return getStore({ name: "nuuts-santa", siteID, token, consistency: "strong" });
  return getStore({ name: "nuuts-santa", consistency: "strong" });
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const fail = (msg, status = 400) => json({ error: msg }, status);

const rid = (n = 10) => {
  const a = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(bytes, (b) => a[b % a.length]).join("");
};
const clean = (s, max = 200) => String(s ?? "").replace(/[<>]/g, "").trim().slice(0, max);

async function getMeta(s, gid) {
  if (!gid || !/^[a-z0-9]{4,20}$/.test(gid)) return null;
  return s.get(`g/${gid}/meta`, { type: "json" });
}
async function listParticipants(s, gid) {
  const { blobs } = await s.list({ prefix: `g/${gid}/p/` });
  const all = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return all.filter(Boolean).sort((a, b) => a.joinedAt - b.joinedAt);
}
async function getMe(s, gid, token) {
  if (!token || !/^[a-z0-9]{10,40}$/.test(token)) return null;
  return s.get(`g/${gid}/p/${token}`, { type: "json" });
}
/* ---------- Олон өдрийн горим ----------
   Санта бүх хугацаанд НЭГ хүндээ өдөр бүр жижиг бэлэг өгнө. Сүүлийн өдөр (байгууллагын
   шинэ жил дээр) бүгд ил болж, хүлээн авагч өөрийн Сантад ТОМ бэлэг буцааж өгнө. */
const DEFAULT_THEMES = [
  "🍫 Амттан", "❤️ Улаан өнгөтэй зүйл", "☕ Өглөөний кофе эсвэл цай", "✍️ Гараар хийсэн зүйл",
  "🌸 Цэцэг эсвэл ургамал", "😂 Инээдтэй бэлэг", "🧦 Дулаан зүйл", "💌 Урам өгөх захидал",
  "🐱 Хөөрхөн амьтантай зүйл", "🍊 Жимс", "🎵 Дуртай дуу эсвэл playlist", "✨ Гялалзсан зүйл",
];
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || "");
function dayList(m) {
  if (!m.multiDay || !isDate(m.startDate) || !isDate(m.endDate)) return [];
  const out = [];
  const d = new Date(m.startDate + "T00:00:00Z"), end = new Date(m.endDate + "T00:00:00Z");
  while (d <= end && out.length < 60) {
    const wd = d.getUTCDay();
    if (!(m.workdaysOnly && (wd === 0 || wd === 6))) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
function applyMultiDay(m, b) {
  if (b.multiDay !== undefined) m.multiDay = !!b.multiDay;
  if (b.startDate !== undefined) m.startDate = isDate(b.startDate) ? b.startDate : "";
  if (b.endDate !== undefined) m.endDate = isDate(b.endDate) ? b.endDate : "";
  if (b.workdaysOnly !== undefined) m.workdaysOnly = !!b.workdaysOnly;
  if (b.dailyBudget !== undefined) m.dailyBudget = Math.max(0, Math.min(1000000, Number(b.dailyBudget) || 0));
  if (Array.isArray(b.themes)) m.themes = b.themes.map((t) => clean(t, 60)).filter(Boolean).slice(0, 60);
  if (!m.themes || !m.themes.length) m.themes = [...DEFAULT_THEMES];
  if (m.multiDay && m.startDate && m.endDate && m.startDate > m.endDate) throw new Error("Эхлэх өдөр дуусах өдрөөс өмнө байх ёстой");
}
const publicGroup = (m, count, names) => ({
  id: m.id, name: m.name, mode: m.mode, budget: m.budget, date: m.date, note: m.note,
  drawn: !!m.drawnAt, count, names,
  multiDay: !!m.multiDay, startDate: m.startDate || "", endDate: m.endDate || "", workdaysOnly: !!m.workdaysOnly,
  dailyBudget: m.dailyBudget || 0, themes: m.themes || DEFAULT_THEMES, days: dayList(m), revealed: !!m.revealedAt,
});
const cleanWish = (w = {}) => ({
  items: (Array.isArray(w.items) ? w.items : []).slice(0, 6).map((i) => ({
    text: clean(i.text, 120), url: clean(i.url, 300), img: clean(i.img, 300), price: Number(i.price) || 0, brand: clean(i.brand, 30),
  })).filter((i) => i.text),
  likes: clean(w.likes, 300), dislikes: clean(w.dislikes, 300), size: clean(w.size, 100),
});
async function newParticipant(s, gid, { name, dept, wish }, byAdmin = false) {
  const p = {
    id: rid(8), token: rid(16), name: clean(name, 40), dept: clean(dept, 40), byAdmin,
    wish: cleanWish(wish), joinedAt: Date.now(), assignedTo: null, seenAt: null, gave: {}, guess: null,
  };
  if (!p.name) throw new Error("Нэрээ бичнэ үү");
  await s.setJSON(`g/${gid}/p/${p.token}`, p);
  return p;
}

/* Сугалаа: хүн бүр нэг хүнд бэлэг өгч, нэг хүнээс авна. Өөрийгөө, хориглосон хосыг,
   (сонгосон бол) нэг хэлтсийнхнийг сугалахгүй. Санамсаргүй сэлгэлтийг олон удаа оролдоно. */
function draw(people, exclusions, sameDeptBlocked) {
  const blocked = new Set();
  for (const [a, b] of exclusions) { blocked.add(a + ">" + b); blocked.add(b + ">" + a); }
  const ok = (g, r) => g.id !== r.id && !blocked.has(g.id + ">" + r.id) &&
    !(sameDeptBlocked && g.dept && r.dept && g.dept.toLowerCase() === r.dept.toLowerCase());
  for (let attempt = 0; attempt < 5000; attempt++) {
    const order = [...people];
    for (let i = order.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [order[i], order[j]] = [order[j], order[i]];
    }
    // Нэг том тойрог: order[i] → order[i+1] (хоёр хүн бие биеэ сугалахаас сэргийлнэ)
    let good = true;
    for (let i = 0; i < order.length; i++) {
      if (!ok(order[i], order[(i + 1) % order.length])) { good = false; break; }
    }
    if (good) return order.map((g, i) => [g, order[(i + 1) % order.length]]);
  }
  return null;
}

export default async (req) => {
  if (req.method !== "POST") return fail("POST only", 405);
  let b;
  try { b = await req.json(); } catch { return fail("Буруу хүсэлт"); }
  const s = store();
  const gid = clean(b.gid, 20).toLowerCase();

  try {
    switch (b.action) {
      /* ---------- Бүлэг үүсгэх ---------- */
      case "create": {
        const name = clean(b.name, 60);
        if (!name) return fail("Бүлгийн нэрээ бичнэ үү");
        const meta = {
          id: rid(6), adminKey: rid(16), name,
          mode: b.mode === "company" ? "company" : "friends",
          budget: Math.max(0, Math.min(10000000, Number(b.budget) || 0)),
          date: clean(b.date, 20), note: clean(b.note, 300),
          sameDeptBlocked: !!b.sameDeptBlocked, exclusions: [],
          createdAt: Date.now(), drawnAt: null, revealedAt: null,
        };
        applyMultiDay(meta, b);
        await s.setJSON(`g/${meta.id}/meta`, meta);
        let me = null;
        if (b.joinAsMember && clean(b.organizerName, 40)) {
          me = await newParticipant(s, meta.id, { name: b.organizerName, dept: b.organizerDept });
        }
        return json({ gid: meta.id, adminKey: meta.adminKey, token: me?.token || null });
      }

      /* ---------- Нийтэд нээлттэй: нэгдэх хуудас ---------- */
      case "group": {
        const m = await getMeta(s, gid);
        if (!m) return fail("Бүлэг олдсонгүй", 404);
        const ps = await listParticipants(s, gid);
        return json(publicGroup(m, ps.length, ps.map((p) => p.name)));
      }

      case "join": {
        const m = await getMeta(s, gid);
        if (!m) return fail("Бүлэг олдсонгүй", 404);
        if (m.drawnAt) return fail("Сугалаа аль хэдийн татагдсан тул шинээр нэгдэх боломжгүй");
        const ps = await listParticipants(s, gid);
        if (ps.length >= 300) return fail("Бүлэг дүүрсэн байна");
        const nm = clean(b.name, 40).toLowerCase();
        if (ps.some((p) => p.name.toLowerCase() === nm)) return fail("Ийм нэртэй хүн аль хэдийн нэгдсэн байна. Овгийн эхний үсгээ нэмээрэй.");
        const p = await newParticipant(s, gid, b);
        return json({ token: p.token });
      }

      /* ---------- Оролцогчийн хувийн хуудас ---------- */
      case "me": {
        const m = await getMeta(s, gid);
        const me = m && (await getMe(s, gid, b.token));
        if (!me) return fail("Линк буруу байна", 404);
        let recipient = null, santaThread = [], myThread = [], multi = null;
        if (m.drawnAt && me.assignedTo) {
          const ps = await listParticipants(s, gid);
          const r = ps.find((p) => p.id === me.assignedTo);
          if (r) recipient = { name: r.name, dept: r.dept, wish: r.wish };
          if (m.multiDay) {
            const santa = ps.find((p) => p.assignedTo === me.id);
            multi = {
              myGave: me.gave || {},                 // би Сантагийн хувьд аль өдрүүдэд өгсөн
              received: santa?.gave || {},           // миний Санта аль өдрүүдэд өгсөн (хэн болох нь нууц)
              myGuess: me.guess || null,
              others: ps.filter((p) => p.id !== me.id).map((p) => ({ id: p.id, name: p.name })),
            };
            if (m.revealedAt && santa) {
              multi.mySanta = { name: santa.name, dept: santa.dept, wish: santa.wish };
              multi.guessedRight = me.guess === santa.id;
              multi.leaderboard = ps.filter((p) => p.guess && ps.find((x) => x.assignedTo === p.id)?.id === p.guess).map((p) => p.name);
            }
          }
          if (!me.seenAt) { me.seenAt = Date.now(); await s.setJSON(`g/${gid}/p/${me.token}`, me); }
          santaThread = (await s.get(`g/${gid}/t/${me.assignedTo}`, { type: "json" })) || [];
          myThread = (await s.get(`g/${gid}/t/${me.id}`, { type: "json" })) || [];
        }
        return json({
          group: publicGroup(m, 0, []),
          me: { name: me.name, dept: me.dept, wish: me.wish },
          recipient, santaThread, myThread, multi,
        });
      }

      case "wish": {
        const m = await getMeta(s, gid);
        const me = m && (await getMe(s, gid, b.token));
        if (!me) return fail("Линк буруу байна", 404);
        me.wish = cleanWish(b.wish);
        await s.setJSON(`g/${gid}/p/${me.token}`, me);
        return json({ ok: true });
      }

      /* Нэрээ нууцалсан чат: to="recipient" → Санта өөрийн хүлээн авагч руу бичнэ;
         to="santa" → хүлээн авагч өөрийн Сантад хариулна. */
      case "msg": {
        const m = await getMeta(s, gid);
        const me = m && (await getMe(s, gid, b.token));
        if (!me || !m.drawnAt) return fail("Линк буруу байна", 404);
        const text = clean(b.text, 400);
        if (!text) return fail("Хоосон мессеж");
        const threadId = b.to === "recipient" ? me.assignedTo : me.id;
        const from = b.to === "recipient" ? "santa" : "me";
        const key = `g/${gid}/t/${threadId}`;
        const t = (await s.get(key, { type: "json" })) || [];
        if (t.length >= 200) return fail("Мессежийн хязгаарт хүрсэн");
        t.push({ from, text, kind: b.kind === "hint" ? "hint" : "msg", at: Date.now() });
        await s.setJSON(key, t);
        return json({ ok: true, thread: t });
      }

      case "gave": {
        const m = await getMeta(s, gid);
        const me = m && (await getMe(s, gid, b.token));
        if (!me || !m.drawnAt || !m.multiDay) return fail("Линк буруу байна", 404);
        if (!dayList(m).includes(b.day)) return fail("Энэ өдөр хугацаанд багтахгүй");
        me.gave = me.gave || {};
        if (b.value) me.gave[b.day] = Date.now(); else delete me.gave[b.day];
        await s.setJSON(`g/${gid}/p/${me.token}`, me);
        return json({ ok: true, gave: me.gave });
      }

      case "guess": {
        const m = await getMeta(s, gid);
        const me = m && (await getMe(s, gid, b.token));
        if (!me || !m.drawnAt || !m.multiDay) return fail("Линк буруу байна", 404);
        if (m.revealedAt) return fail("Аль хэдийн ил болсон");
        me.guess = b.pid && b.pid !== me.id ? clean(b.pid, 20) : null;
        await s.setJSON(`g/${gid}/p/${me.token}`, me);
        return json({ ok: true });
      }

      /* ---------- Зохион байгуулагч ---------- */
      case "admin":
      case "bulkAdd":
      case "remove":
      case "settings":
      case "draw":
      case "undraw":
      case "reveal":
      case "unreveal": {
        const m = await getMeta(s, gid);
        if (!m || !b.adminKey || b.adminKey !== m.adminKey) return fail("Админ линк буруу байна", 403);
        let ps = await listParticipants(s, gid);

        if (b.action === "bulkAdd") {
          if (m.drawnAt) return fail("Сугалааны дараа хүн нэмэх боломжгүй");
          const lines = String(b.text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 300);
          const existing = new Set(ps.map((p) => p.name.toLowerCase()));
          for (const line of lines) {
            const [name, dept] = line.split(/\t|,|;/).map((x) => x.trim());
            if (!name || existing.has(name.toLowerCase())) continue;
            existing.add(name.toLowerCase());
            await newParticipant(s, gid, { name, dept }, true);
          }
          ps = await listParticipants(s, gid);
        }
        if (b.action === "remove") {
          if (m.drawnAt) return fail("Сугалааны дараа хүн хасах боломжгүй. Эхлээд сугалааг цуцална уу.");
          const p = ps.find((x) => x.id === b.pid);
          if (p) await s.delete(`g/${gid}/p/${p.token}`);
          m.exclusions = m.exclusions.filter(([a, c]) => a !== b.pid && c !== b.pid);
          await s.setJSON(`g/${gid}/meta`, m);
          ps = ps.filter((x) => x.id !== b.pid);
        }
        if (b.action === "settings") {
          if (b.name !== undefined) m.name = clean(b.name, 60) || m.name;
          if (b.budget !== undefined) m.budget = Math.max(0, Number(b.budget) || 0);
          if (b.date !== undefined) m.date = clean(b.date, 20);
          if (b.note !== undefined) m.note = clean(b.note, 300);
          if (b.sameDeptBlocked !== undefined) m.sameDeptBlocked = !!b.sameDeptBlocked;
          applyMultiDay(m, b);
          if (Array.isArray(b.exclusions)) {
            const ids = new Set(ps.map((p) => p.id));
            m.exclusions = b.exclusions.filter((e) => Array.isArray(e) && ids.has(e[0]) && ids.has(e[1]) && e[0] !== e[1]).slice(0, 200);
          }
          await s.setJSON(`g/${gid}/meta`, m);
        }
        if (b.action === "draw") {
          if (m.drawnAt) return fail("Сугалаа аль хэдийн татагдсан");
          if (ps.length < 3) return fail("Дор хаяж 3 хүн хэрэгтэй");
          const pairs = draw(ps, m.exclusions, m.sameDeptBlocked);
          if (!pairs) return fail("Хориглолт хэт олон байгаа тул сугалаа таарсангүй. Хэлтсийн хориглолтыг эсвэл зарим хосыг хасаад дахин оролдоно уу.");
          await Promise.all(pairs.map(([g, r]) => s.setJSON(`g/${gid}/p/${g.token}`, { ...g, assignedTo: r.id, seenAt: null })));
          m.drawnAt = Date.now();
          await s.setJSON(`g/${gid}/meta`, m);
          ps = await listParticipants(s, gid);
        }
        if (b.action === "undraw") {
          await Promise.all(ps.map((p) => s.setJSON(`g/${gid}/p/${p.token}`, { ...p, assignedTo: null, seenAt: null, gave: {}, guess: null })));
          const { blobs } = await s.list({ prefix: `g/${gid}/t/` });
          await Promise.all(blobs.map((x) => s.delete(x.key)));
          m.drawnAt = null; m.revealedAt = null;
          await s.setJSON(`g/${gid}/meta`, m);
          ps = await listParticipants(s, gid);
        }
        if (b.action === "reveal" || b.action === "unreveal") {
          if (!m.drawnAt) return fail("Эхлээд сугалаа татна уу");
          m.revealedAt = b.action === "reveal" ? Date.now() : null;
          await s.setJSON(`g/${gid}/meta`, m);
        }
        const today = isDate(b.today) ? b.today : null;
        // Админ хэн хэнийг сугалсныг ХАРАХГҮЙ — зөвхөн линк, харсан эсэх
        return json({
          group: { ...publicGroup(m, ps.length, []), sameDeptBlocked: m.sameDeptBlocked, exclusions: m.exclusions },
          participants: ps.map((p) => ({
            id: p.id, name: p.name, dept: p.dept,
            // Өөрөө нэгдсэн хүний линкийг админд харуулахгүй (нууцлал). Админ нэмсэн хүний линкийг тарааж өгөх ёстой тул харуулна.
            token: p.byAdmin ? p.token : null,
            hasWish: !!(p.wish?.items?.length || p.wish?.likes), seen: !!p.seenAt,
            gaveToday: today ? !!p.gave?.[today] : false, gaveCount: Object.keys(p.gave || {}).length, guessed: !!p.guess,
          })),
        });
      }
      default:
        return fail("Тодорхойгүй үйлдэл");
    }
  } catch (e) {
    return fail(e.message || "Серверийн алдаа", 500);
  }
};

export const config = { path: "/api" };
