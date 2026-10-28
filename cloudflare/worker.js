// Mi Media Content Lab on Cloudflare: the whole system.
// Serves the website (docs/), keeps projects, briefs, memory, assets and posts (D1 + KV) and makes posts.
// Brain: with a Gemini key saved, Gemini writes and Workers AI draws (/api/brain/*), and the open website
// draws the brand frame (docs/compose.js). Without one, Antigravity on the PC helper does it (/api/agent/*).
//
// Secrets: PASSWORD, SESSION_KEY (website login), AGENT_TOKEN (the PC helper's key).
// The Zernio and Gemini keys are not secrets here: they are typed into the Platforms tab and kept in D1 settings.
// Bindings: DB (D1), FILES (KV), AI (Workers AI), ASSETS (static site).

const COOKIE = "lab";
const SESSION_DAYS = 30;
const MAX_FILE = 20 * 1024 * 1024; // KV allows 25 MB per value
const KV_FREE_BYTES = 1024 * 1024 * 1024; // free plan storage
const STALE_JOB_MIN = 15; // a claimed job with no result after this goes back to the queue
const ASPECTS = ["4:5", "1:1", "9:16"];

const enc = new TextEncoder();
const now = () => new Date().toISOString();
const uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });
const fail = (message, status = 400) => json({ message }, status);

// ---------- login ----------

async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Changing PASSWORD logs everyone out, because it is part of the signing key.
const sessionKey = (env) => env.SESSION_KEY + "|" + env.PASSWORD;

async function loggedIn(req, env) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]{64})`));
  if (!m || Number(m[1]) < Date.now()) return false;
  return (await hmac(sessionKey(env), m[1])) === m[2];
}

async function isHelper(req, env) {
  const token = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
  return !!env.AGENT_TOKEN && !!token && (await hmac(env.SESSION_KEY, token)) === (await hmac(env.SESSION_KEY, env.AGENT_TOKEN));
}

const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

async function login(req, env) {
  let password = "";
  try { password = String((await req.json()).password || ""); } catch { /* empty */ }
  if (!env.PASSWORD || (await hmac(env.SESSION_KEY, password)) !== (await hmac(env.SESSION_KEY, env.PASSWORD))) {
    await new Promise((r) => setTimeout(r, 1000)); // slows down guessing
    return fail("Wrong password.", 401);
  }
  const exp = Date.now() + SESSION_DAYS * 86400000;
  const session = `${exp}.${await hmac(sessionKey(env), String(exp))}`;
  return json({ ok: true }, 200, { "Set-Cookie": cookie(session, SESSION_DAYS * 86400) });
}

// ---------- data helpers ----------

const all = async (env, sql, ...args) => (await env.DB.prepare(sql).bind(...args).all()).results;
const one = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).first();
const run = (env, sql, ...args) => env.DB.prepare(sql).bind(...args).run();

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

function postOut(p) {
  return { ...p, hashtags: parse(p.hashtags, []), social: parse(p.social, {}) };
}
function assetOut(a) {
  return { ...a, settings: parse(a.settings, {}), url: `/api/file/${a.file_key}` };
}
function projectOut(p) {
  return { ...p, brief: parse(p.brief, {}) };
}

async function putFile(env, data, mime) {
  if (data.byteLength > MAX_FILE) throw new Error("That file is too big (20 MB at most).");
  const key = uid("f");
  await env.FILES.put(key, data, { metadata: { mime, bytes: data.byteLength } });
  return key;
}

async function deleteFile(env, key) {
  if (key) await env.FILES.delete(key);
}

// kind: hint (highlighted, read first) | rule (from you) | lesson (brain) | feedback | log (what the brain made, when)
async function remember(env, projectId, source, note, kind = "lesson", pinned = 0) {
  note = String(note || "").trim().slice(0, 600);
  if (!note) return;
  if (kind !== "log" && (await one(env, "SELECT id FROM memory WHERE project_id = ? AND lower(note) = lower(?)", projectId, note))) return;
  await run(env, "INSERT INTO memory (id, project_id, source, note, kind, pinned, created) VALUES (?, ?, ?, ?, ?, ?, ?)",
    uid("m"), projectId, source, note, kind, pinned ? 1 : 0, now());
}

// What the brain reads before a post: every highlighted note, then the newest lessons and feedback, then its recent work log.
async function memoryForBrain(env, projectId) {
  const [hints, lessons, log] = await Promise.all([
    all(env, "SELECT kind, source, note, created FROM memory WHERE project_id = ? AND pinned = 1 ORDER BY created DESC LIMIT 40", projectId),
    all(env, "SELECT kind, source, note, created FROM memory WHERE project_id = ? AND pinned = 0 AND kind != 'log' ORDER BY created DESC LIMIT 40", projectId),
    all(env, "SELECT kind, source, note, created FROM memory WHERE project_id = ? AND kind = 'log' ORDER BY created DESC LIMIT 12", projectId),
  ]);
  return { hints: hints.reverse(), lessons: lessons.reverse(), log: log.reverse() };
}

async function requeueStale(env) {
  const cutoff = new Date(Date.now() - STALE_JOB_MIN * 60000).toISOString();
  await run(env, "UPDATE posts SET status = 'queued', claimed_at = '' WHERE status = 'working' AND claimed_at < ?", cutoff);
}

async function storage(env) {
  const rows = await all(env, `SELECT project_id, 'assets' AS kind, COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM assets GROUP BY project_id
    UNION ALL SELECT project_id, 'posts', COUNT(*), COALESCE(SUM(bytes), 0) FROM posts WHERE bytes > 0 GROUP BY project_id`);
  const total = rows.reduce((s, r) => s + r.bytes, 0);
  const helper = await one(env, "SELECT last_seen, info FROM helper WHERE id = 'pc'");
  return {
    cloud: { total, limit: KV_FREE_BYTES, rows },
    pc: helper ? { last_seen: helper.last_seen, ...parse(helper.info, {}) } : null,
  };
}

// ---------- Zernio: posting to Instagram, Threads, X, LinkedIn, YouTube ----------
// The Zernio key is typed into the Platforms tab and kept in D1 (settings); it never goes back to the browser.
// Each project keeps the Zernio account ids it posts to in brief.channels.

const ZERNIO = "https://zernio.com/api/v1";
// limit = caption length the platform takes; video = only takes videos, so a picture post skips it.
const PLATFORMS = {
  instagram: { name: "Instagram", limit: 2200 },
  threads: { name: "Threads", limit: 500 },
  twitter: { name: "X", limit: 280 },
  linkedin: { name: "LinkedIn", limit: 3000 },
  youtube: { name: "YouTube", limit: 5000, video: true },
};

async function setting(env, k) {
  const row = await one(env, "SELECT v FROM settings WHERE k = ?", k).catch(() => null); // no settings table yet = no keys
  return row ? row.v : "";
}

async function zernio(env, path, { method = "GET", body, key } = {}) {
  key ||= await setting(env, "zernio_key");
  if (!key) throw new Error("Add your Zernio API key in the Platforms tab first.");
  const res = await fetch(ZERNIO + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error("Zernio did not accept the API key. Check it in the Platforms tab.");
  if (!res.ok && res.status !== 207) throw new Error(`Zernio: ${data.error || data.message || `error ${res.status}`}`);
  return data;
}

async function zernioAccounts(env, key) {
  const { accounts = [] } = await zernio(env, "/accounts?category=social", { key });
  return accounts.filter((a) => PLATFORMS[a.platform]).map((a) => ({
    id: a._id,
    platform: a.platform,
    name: a.username ? `@${String(a.username).replace(/^@/, "")}` : a.displayName || PLATFORMS[a.platform].name,
    picture: a.profilePicture || "",
    ok: a.isActive !== false && !a.needsReconnection,
  }));
}

// Caption + hashtags inside a platform's limit: drop hashtags first, then shorten at a word.
function fitText(text, tags, limit) {
  for (let n = tags.length; n >= 0; n--) {
    const out = text + (n ? "\n\n" + tags.slice(0, n).join(" ") : "");
    if (out.length <= limit) return out;
  }
  const cut = text.slice(0, limit - 1);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), limit / 2)).trimEnd() + "…";
}

function textFor(platform, post) {
  const tags = parse(post.hashtags, []);
  const limit = PLATFORMS[platform].limit;
  // X: a long caption becomes the headline and subtext instead of a cut-off caption.
  const text = platform === "twitter" && post.caption.length > limit ? [post.headline, post.subtext].filter(Boolean).join("\n\n") : post.caption;
  return fitText(text, platform === "twitter" ? tags.slice(0, 3) : tags, limit);
}

// What the site shows about a post on the platforms, from Zernio's post.
function socialFrom(zp, accounts, when) {
  const targets = (zp.platforms || []).map((t) => {
    const id = t.accountId && typeof t.accountId === "object" ? t.accountId._id : t.accountId;
    const a = accounts.find((x) => x.id === id) || {};
    return { platform: t.platform, name: a.name || "", status: t.status || zp.status || "", url: t.platformPostUrl || "", error: t.errorMessage || "" };
  });
  return { id: zp._id, status: zp.status || "", when: when || zp.scheduledFor || "", targets };
}

function postStatusFrom(social, fallback) {
  if (social.targets.some((t) => t.status === "published")) return "posted";
  if (["scheduled", "pending", "publishing", "processing"].includes(social.status) || social.targets.some((t) => ["pending", "processing", "uploading"].includes(t.status))) return "scheduled";
  return fallback;
}

async function publish(env, post, body) {
  if (!post.post_key || !["draft", "approved", "posted"].includes(post.status)) throw new Error("Only a finished post can go out.");
  const accounts = await zernioAccounts(env);
  const chosen = accounts.filter((a) => (body.account_ids || []).includes(a.id) && !PLATFORMS[a.platform].video);
  if (!chosen.length) throw new Error("Tick at least one platform.");
  let when = "";
  if (body.when) {
    const t = Date.parse(body.when);
    if (!(t > Date.now() + 2 * 60000)) throw new Error("Pick a time at least a few minutes from now.");
    when = new Date(t).toISOString();
  }
  // Give Zernio the picture, then make the post with each platform's own text.
  const picture = await env.FILES.get(post.post_key, { type: "arrayBuffer" });
  if (!picture) throw new Error("The picture is missing. Make a new picture first.");
  const slot = await zernio(env, "/media/presign", { method: "POST", body: { filename: `${post.id}.jpg`, contentType: "image/jpeg", size: picture.byteLength } });
  const up = await fetch(slot.uploadUrl, { method: "PUT", body: picture, headers: { "Content-Type": "image/jpeg" } });
  if (!up.ok) throw new Error(`Zernio did not take the picture (error ${up.status}).`);
  const res = await zernio(env, "/posts", {
    method: "POST",
    body: {
      title: post.headline,
      content: textFor("instagram", post),
      mediaItems: [{ type: "image", url: slot.publicUrl, altText: post.headline }],
      platforms: chosen.map((a) => ({
        platform: a.platform,
        accountId: a.id,
        customContent: textFor(a.platform, post),
        ...(a.platform === "instagram" && post.aspect === "9:16" ? { platformSpecificData: { contentType: "story" } } : {}),
      })),
      ...(when ? { scheduledFor: when } : { publishNow: true }),
    },
  });
  if (!res.post) throw new Error(`Zernio: ${res.error || res.message || "the post was not made"}`);
  const social = socialFrom(res.post, chosen, when);
  const failed = social.targets.filter((t) => t.status === "failed");
  const status = when ? "scheduled" : postStatusFrom(social, post.status);
  await run(env, "UPDATE posts SET status = ?, social = ?, error = ?, updated = ? WHERE id = ?", status, JSON.stringify(social),
    failed.map((t) => `${PLATFORMS[t.platform] ? PLATFORMS[t.platform].name : t.platform}: ${t.error || "failed"}`).join("\n").slice(0, 800), now(), post.id);
  if (status === "posted") await remember(env, post.project_id, "feedback",
    `Posted "${post.headline}" to ${social.targets.filter((t) => t.status === "published").map((t) => PLATFORMS[t.platform].name).join(", ")}.`, "log");
  return { status, social };
}

// Ask Zernio how a scheduled or posted post is doing.
async function checkSocial(env, post) {
  const social = parse(post.social, {});
  if (!social.id) throw new Error("This post has not been sent to Zernio.");
  const [{ post: zp }, accounts] = await Promise.all([zernio(env, `/posts/${social.id}`), zernioAccounts(env).catch(() => [])]);
  if (!zp) throw new Error("Zernio no longer has this post.");
  const fresh = socialFrom(zp, accounts, social.when);
  fresh.targets.forEach((t, i) => { t.name ||= (social.targets[i] || {}).name || ""; });
  const status = postStatusFrom(fresh, "approved");
  const failed = fresh.targets.filter((t) => t.status === "failed");
  await run(env, "UPDATE posts SET status = ?, social = ?, error = ?, updated = ? WHERE id = ?", status, JSON.stringify(fresh),
    failed.map((t) => `${PLATFORMS[t.platform] ? PLATFORMS[t.platform].name : t.platform}: ${t.error || "failed"}`).join("\n").slice(0, 800), now(), post.id);
}

// ---------- cloud brain: Gemini writes, Workers AI draws ----------
// The Gemini key is typed into the Platforms tab and kept in D1 (settings), like the Zernio key.
// While it is saved the PC helper gets no jobs: the open website asks /api/brain/make for each queued post,
// draws the brand frame on the picture and sends it back to /api/brain/result.

const GEMINI = "https://generativelanguage.googleapis.com";
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"]; // next one when a model is busy or gone
const PICTURE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const SHAPE_WORDS = { "4:5": "Vertical portrait composition", "1:1": "Square composition", "9:16": "Tall vertical 9:16 composition" };

async function geminiCheck(key) {
  const res = await fetch(`${GEMINI}/v1beta/models?pageSize=1`, { headers: { "x-goog-api-key": key } });
  if (res.ok) return;
  const data = await res.json().catch(() => ({}));
  throw new Error("Gemini did not accept that key: " + ((data.error && data.error.message) || `HTTP ${res.status}`));
}

async function gemini(key, body) {
  let last = "";
  for (const model of GEMINI_MODELS) {
    const res = await fetch(`${GEMINI}/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const cand = (data.candidates || [])[0] || {};
      const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || "").join("");
      if (text.trim()) return text;
      last = `no answer (${cand.finishReason || (data.promptFeedback && data.promptFeedback.blockReason) || "empty"})`;
      continue;
    }
    last = (data.error && data.error.message) || `HTTP ${res.status}`;
    if (res.status === 429) last = "the free Gemini allowance is used up for now. Try again later. " + last.split("\n")[0];
    if (![404, 429, 500, 503].includes(res.status)) break; // a bad key or request fails the same on every model
  }
  throw new Error("Gemini: " + last);
}

// Pictures go to Gemini through its Files API, straight from KV (they are deleted by Google after 48 hours).
async function geminiFile(env, key, fileKey, mime) {
  const data = await env.FILES.get(fileKey, { type: "arrayBuffer" });
  if (!data) return null;
  const start = await fetch(`${GEMINI}/upload/v1beta/files`, {
    method: "POST",
    headers: { "x-goog-api-key": key, "Content-Type": "application/json", "X-Goog-Upload-Protocol": "resumable", "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(data.byteLength), "X-Goog-Upload-Header-Content-Type": mime },
    body: JSON.stringify({ file: { display_name: fileKey } }),
  });
  const upload = start.headers.get("x-goog-upload-url");
  if (!upload) return null;
  const done = await fetch(upload, { method: "POST", headers: { "X-Goog-Upload-Offset": "0", "X-Goog-Upload-Command": "upload, finalize" }, body: data });
  const file = (await done.json().catch(() => ({}))).file;
  return file && file.uri ? { file_data: { mime_type: mime, file_uri: file.uri } } : null;
}

// The brief in the shape the brain and the post design expect, with this post's logo (same as pc_helper.brand_for).
function brandFor(project, assets, post) {
  const brand = parse(project.brief, {});
  brand.brand_name ||= project.name;
  brand.fonts ||= { headline: "fonts/Poppins-Bold.ttf", body: "fonts/Poppins-Regular.ttf" };
  const logos = assets.filter((a) => a.kind === "logo");
  const choice = post.logo_id || brand.default_logo || (logos[0] ? logos[0].id : "none");
  const logo = logos.find((a) => a.id === choice);
  brand.logo = null; // missing = no logo
  if (logo) {
    const s = parse(logo.settings, {});
    brand.logo = { url: `/api/file/${logo.file_key}`, width: Number(s.width) || 180, position: brand.logo_position || "top-left" };
    if (s.handle) brand.instagram_handle = s.handle;
  }
  return brand;
}

function systemPrompt(brand) {
  const examples = (brand.example_captions || []).map((c) => `- ${c}`).join("\n\n");
  return `You write Instagram posts for the brand "${brand.brand_name}" (${brand.instagram_handle || ""}).

About the account: ${brand.about || ""}
Voice: ${brand.voice || ""}
Write in: ${brand.language || "English"}

Every post is one picture (4:5) with a short headline printed on it, plus a caption.

Rules for each field:
- topic: the subject of this post in a few words.
- headline: printed big on the picture. At most 8 words. Punchy, no hashtags, no emojis.
- subtext: one short line printed under the headline (at most 14 words), or "" if not needed.
- caption: the Instagram caption. Hook in the first line, then useful content, then a call to action. Line breaks are fine. Do NOT put hashtags in the caption. Under 1500 characters.
- hashtags: ${brand.hashtag_count || 8} relevant hashtags, each starting with #. Mix popular and niche.
- image_prompt: a description for an AI image generator of the BACKGROUND picture only. Visual scene, no words. Never ask for text, letters, logos or watermarks in the picture. The style is added automatically, so describe only the scene.

Example captions in the brand's voice:
${examples || "- (none given)"}`;
}

function memoryText(memory, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  const line = (m) => `- [${fmt.format(new Date(m.created))}] ${m.note}`;
  const parts = [];
  if (memory.hints.length) parts.push("KEY HINTS AND RULES (highlighted; always follow these first):\n" + memory.hints.map(line).join("\n"));
  if (memory.lessons.length) parts.push("Lessons and the owner's feedback (newest last):\n" + memory.lessons.map((m) => line(m) + (m.kind === "feedback" ? " (feedback)" : "")).join("\n"));
  if (memory.log.length) parts.push("Your recent work log (what you made, when):\n" + memory.log.map(line).join("\n"));
  return parts.join("\n\n");
}

async function writeText(env, key, brand, post, memory, recent, references, photo) {
  let ask = post.topic ? `Write a post about: ${post.topic}`
    : "Pick a fresh angle from one of these topics and write a post:\n" + (brand.topics || []).map((t) => `- ${t}`).join("\n");
  if (recent.length) ask += "\n\nDo not repeat these recent headlines or their ideas:\n" + recent.map((h) => `- ${h}`).join("\n");
  const timeZone = brand.timezone || "Asia/Kolkata";
  const remembered = memoryText(memory, timeZone);
  if (remembered) ask += "\n\nYOUR MEMORY OF THIS PROJECT:\n" + remembered;
  ask += `\n\nNow is ${new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "long", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date())}.`;

  const parts = [];
  for (const r of references) {
    const part = await geminiFile(env, key, r.file_key, r.mime).catch(() => null);
    if (part) parts.push(part, { text: `(Reference picture: ${r.note || r.name})` });
    else ask += `\n\nReference (not shown): ${r.note || r.name}`;
  }
  if (references.length) ask += "\n\nLook at the attached reference pictures for style and facts.";
  if (photo) {
    const part = await geminiFile(env, key, photo.file_key, photo.mime).catch(() => null);
    if (part) parts.push(part);
    ask += `\n\nThe ${part ? "attached photo" : `owner's photo "${photo.name}"`} will be the picture of this post. Write about it. image_prompt can be "".`;
  }
  ask += "\n\nYou may search the web for current facts or trends if it helps.";
  parts.push({ text: ask + "\n\nReply with ONLY one JSON object with exactly these keys: topic, headline, subtext, caption, hashtags (a list), "
    + "image_prompt, learned (a list of 0-2 short NEW lessons about what this owner likes, taken from the feedback above; "
    + "[] if nothing new), hint (ONE short new rule worth highlighting so the next post comes out right, for example a "
    + "picture style the owner keeps approving; \"\" unless it is new, important and not already in your key hints). No other text." });

  const body = { systemInstruction: { parts: [{ text: systemPrompt(brand) }] }, contents: [{ role: "user", parts }], generationConfig: { temperature: 1 } };
  let reply;
  try {
    reply = await gemini(key, { ...body, tools: [{ google_search: {} }] });
  } catch {
    reply = await gemini(key, body); // web search is limited on the free allowance; write without it
  }
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  const out = start >= 0 && end > start ? parse(reply.slice(start, end + 1), null) : null;
  if (!out) throw new Error("Gemini did not send the post text. Reply: " + reply.trim().slice(-200));
  if (!out.headline || !out.caption) throw new Error("Gemini's text is missing the headline or caption.");
  const seen = new Map();
  for (const t of [...(brand.always_hashtags || []), ...(out.hashtags || []).map((t) => (String(t).startsWith("#") ? String(t) : "#" + t))]) {
    if (!seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t); // one of each, whatever the capitals
  }
  return {
    headline: String(out.headline), subtext: String(out.subtext || ""), caption: String(out.caption),
    hashtags: [...seen.values()].slice(0, 30), image_prompt: String(out.image_prompt || ""),
    learned: (out.learned || []).map(String).slice(0, 2), hint: String(out.hint || "").trim().slice(0, 300),
  };
}

async function makePicture(env, prompt, brand, aspect) {
  const style = brand.image_style || "";
  const avoid = brand.image_avoid || "text, letters, words, watermark, logo";
  const full = `${prompt}. Style: ${style}. ${SHAPE_WORDS[aspect] || SHAPE_WORDS["4:5"]}. No ${avoid}.`.slice(0, 2000);
  const out = await env.AI.run(PICTURE_MODEL, { prompt: full, steps: 8 });
  if (!out || !out.image) throw new Error("Cloudflare's picture AI sent no picture.");
  const bin = atob(out.image);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

// Claim the oldest queued post and make its words and background. The website draws the frame and sends /api/brain/result.
async function brainMake(env) {
  const key = await setting(env, "gemini_key");
  if (!key) throw new Error("Add your Gemini API key in the Platforms tab first.");
  await requeueStale(env);
  const post = await one(env, "SELECT * FROM posts WHERE status = 'queued' ORDER BY created LIMIT 1");
  if (!post) return { id: null };
  const claimed = await run(env, "UPDATE posts SET status = 'working', claimed_at = ? WHERE id = ? AND status = 'queued'", now(), post.id);
  if (!claimed.meta.changes) return brainMake(env); // another open page took it; try the next one
  const [project, assets, memory, recent] = await Promise.all([
    one(env, "SELECT * FROM projects WHERE id = ?", post.project_id),
    all(env, "SELECT * FROM assets WHERE project_id = ?", post.project_id),
    memoryForBrain(env, post.project_id),
    all(env, "SELECT headline FROM posts WHERE project_id = ? AND headline != '' AND id != ? ORDER BY created DESC LIMIT 25", post.project_id, post.id),
  ]);
  let bgKey = "";
  try {
    const brand = brandFor(project, assets, post);
    const photo = post.photo_id ? assets.find((a) => a.id === post.photo_id) : null;
    let data = {};
    if (post.job === "new" || post.job === "text") {
      const references = assets.filter((a) => a.kind === "reference" && a.mime.startsWith("image/") && a.bytes < 8_000_000).slice(0, 4);
      data = await writeText(env, key, brand, post, memory, recent.map((r) => r.headline), references, photo);
    }
    if (photo) {
      bgKey = await putFile(env, await env.FILES.get(photo.file_key, { type: "arrayBuffer" }), photo.mime); // a copy: removing the post must not delete the photo
    } else if (post.job === "text" && post.background_key) {
      bgKey = post.background_key;
    } else {
      bgKey = await putFile(env, await makePicture(env, data.image_prompt || post.image_prompt || data.headline || post.headline, brand, post.aspect), "image/jpeg");
    }
    const { logo, colors, fonts, overlay_strength, black_and_white, instagram_handle } = brand;
    return {
      id: post.id, aspect: post.aspect, data, background_key: bgKey,
      headline: data.headline ?? post.headline, subtext: data.subtext ?? post.subtext,
      brand: { logo, colors, fonts, overlay_strength, black_and_white, instagram_handle },
    };
  } catch (e) {
    await saveResult(env, post, { error: e.message || "Something went wrong." }, null, bgKey);
    return { id: post.id, error: e.message };
  }
}

async function fileBytes(env, key) {
  const { value, metadata } = await env.FILES.getWithMetadata(key, { type: "stream" });
  if (value) await value.cancel();
  return (metadata && metadata.bytes) || 0;
}

// A finished (or failed) post from either brain. bgKey is the background already in KV.
async function saveResult(env, post, data, postFile, bgKey, bgBytes) {
  const t = now();
  if (data.error) {
    if (bgKey && bgKey !== post.background_key) await deleteFile(env, bgKey);
    await run(env, "UPDATE posts SET status = ?, error = ?, claimed_at = '', updated = ? WHERE id = ?",
      post.post_key ? "draft" : "failed", String(data.error).slice(0, 800), t, post.id);
    return;
  }
  const postKey = await putFile(env, await postFile.arrayBuffer(), "image/jpeg");
  await Promise.all([deleteFile(env, post.post_key), bgKey !== post.background_key && deleteFile(env, post.background_key)]);
  const bytes = postFile.size + (bgBytes ?? (await fileBytes(env, bgKey)));
  await run(env, `UPDATE posts SET status = 'draft', job = 'new', error = '', claimed_at = '', headline = ?, subtext = ?, caption = ?, hashtags = ?,
    image_prompt = ?, post_key = ?, background_key = ?, bytes = ?, updated = ? WHERE id = ?`,
    String(data.headline ?? post.headline), String(data.subtext ?? post.subtext), String(data.caption ?? post.caption),
    JSON.stringify(data.hashtags ?? parse(post.hashtags, [])), String(data.image_prompt ?? post.image_prompt), postKey, bgKey, bytes, t, post.id);
  // The brain's own notes: a dated log line for every job, its lessons, and at most one highlighted hint.
  const what = { new: "Made", picture: "Made a new picture for", text: "Rewrote the words of" }[post.job] || "Made";
  await remember(env, post.project_id, "brain",
    `${what} post "${String(data.headline ?? post.headline)}" (${post.aspect})${post.topic ? ` about: ${post.topic.slice(0, 160)}` : " from the brief topics"}.`, "log");
  for (const note of (data.learned || []).slice(0, 2)) await remember(env, post.project_id, "brain", note, "lesson");
  if (data.hint) await remember(env, post.project_id, "brain", data.hint, "hint", 1);
}

// ---------- website API ----------

async function site(req, env, url) {
  const p = url.pathname;
  const m = req.method;
  const body = m === "GET" || m === "DELETE" ? {} : (req.headers.get("Content-Type") || "").includes("multipart") ? null : await req.json().catch(() => ({}));

  // Everything the page needs for one project, in one call.
  if (p === "/api/state" && m === "GET") {
    await requeueStale(env);
    const projects = (await all(env, "SELECT * FROM projects ORDER BY created")).map(projectOut);
    const pid = url.searchParams.get("project") || (projects[0] && projects[0].id) || "";
    const [posts, assets, memory] = pid ? await Promise.all([
      all(env, "SELECT * FROM posts WHERE project_id = ? AND status != 'removed' ORDER BY created DESC LIMIT 60", pid),
      all(env, "SELECT * FROM assets WHERE project_id = ? ORDER BY created", pid),
      all(env, "SELECT * FROM memory WHERE project_id = ? ORDER BY pinned DESC, created DESC LIMIT 300", pid),
    ]) : [[], [], []];
    const queue = await one(env, "SELECT COUNT(*) AS n FROM posts WHERE status IN ('queued', 'working')");
    const gem = await setting(env, "gemini_key");
    return json({ projects, project: pid, posts: posts.map(postOut), assets: assets.map(assetOut), memory, queue: queue.n, storage: await storage(env),
      brain: { cloud: !!gem, key_tail: gem.slice(-4) } });
  }

  // Platforms tab: the Gemini key (the cloud brain).
  if (p === "/api/brain") {
    if (m === "PUT") {
      const key = String(body.key || "").trim();
      if (!key) return fail("Paste the Gemini API key.");
      await geminiCheck(key); // fails here if the key is wrong
      await run(env, "INSERT INTO settings (k, v) VALUES ('gemini_key', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key);
      return json({ ok: true });
    }
    if (m === "DELETE") {
      await run(env, "DELETE FROM settings WHERE k = 'gemini_key'");
      return json({ ok: true });
    }
  }
  if (p === "/api/brain/make" && m === "POST") return json(await brainMake(env));

  let rm;
  if ((rm = p.match(/^\/api\/brain\/result\/([\w-]+)$/)) && m === "POST") {
    const post = await one(env, "SELECT * FROM posts WHERE id = ?", rm[1]);
    if (!post || post.status !== "working") return fail("This post is not being made any more.", 409);
    const form = await req.formData();
    const data = parse(form.get("data") || "{}", {});
    const bgKey = String(form.get("background_key") || "");
    const postFile = form.get("post");
    if (!data.error && (!postFile || typeof postFile === "string" || !bgKey)) return fail("Send the finished post.");
    if (bgKey && bgKey !== post.background_key && await one(env, `SELECT 1 FROM assets WHERE file_key = ?1
      UNION ALL SELECT 1 FROM posts WHERE post_key = ?1 OR background_key = ?1`, bgKey)) return fail("That background belongs to something else.");
    await saveResult(env, post, data, data.error ? null : postFile, bgKey);
    return json({ ok: true });
  }

  if (p === "/api/projects" && m === "POST") {
    const name = String(body.name || "").trim().slice(0, 80);
    if (!name) return fail("Give the project a name.");
    const from = body.copy_from ? await one(env, "SELECT brief FROM projects WHERE id = ?", body.copy_from) : null;
    const id = uid("p");
    const brief = { ...parse(from ? from.brief : "{}", {}), brand_name: name, default_logo: "" };
    await run(env, "INSERT INTO projects (id, name, brief, created) VALUES (?, ?, ?, ?)", id, name, JSON.stringify(brief), now());
    return json({ id });
  }

  let mm;
  if ((mm = p.match(/^\/api\/projects\/([\w-]+)$/))) {
    if (m === "PUT") {
      const cur = await one(env, "SELECT * FROM projects WHERE id = ?", mm[1]);
      if (!cur) return fail("No such project.", 404);
      const name = String(body.name ?? cur.name).trim().slice(0, 80) || cur.name;
      const brief = body.brief ? { ...parse(cur.brief, {}), ...body.brief } : parse(cur.brief, {});
      await run(env, "UPDATE projects SET name = ?, brief = ? WHERE id = ?", name, JSON.stringify(brief), mm[1]);
      return json({ ok: true });
    }
    if (m === "DELETE") {
      const files = await all(env, `SELECT file_key AS k FROM assets WHERE project_id = ?1
        UNION ALL SELECT post_key FROM posts WHERE project_id = ?1 UNION ALL SELECT background_key FROM posts WHERE project_id = ?1`, mm[1]);
      await Promise.all(files.map((f) => deleteFile(env, f.k)));
      await env.DB.batch(["projects WHERE id", "assets WHERE project_id", "posts WHERE project_id", "memory WHERE project_id"]
        .map((t) => env.DB.prepare(`DELETE FROM ${t} = ?`).bind(mm[1])));
      return json({ ok: true });
    }
  }

  // Make posts: one queued job per post; the brain picks them up in order.
  if (p === "/api/posts" && m === "POST") {
    const project = await one(env, "SELECT id FROM projects WHERE id = ?", body.project_id);
    if (!project) return fail("Pick a project first.");
    const count = body.photo_id ? 1 : Math.max(1, Math.min(10, Number(body.count) || 1));
    const aspect = ASPECTS.includes(body.aspect) ? body.aspect : "4:5";
    const t = now();
    const ids = [];
    const stmts = [];
    for (let i = 0; i < count; i++) {
      const id = uid("post");
      ids.push(id);
      stmts.push(env.DB.prepare(`INSERT INTO posts (id, project_id, status, job, topic, aspect, logo_id, photo_id, created, updated)
        VALUES (?, ?, 'queued', 'new', ?, ?, ?, ?, ?, ?)`).bind(id, project.id, String(body.topic || "").slice(0, 1000), aspect,
        String(body.logo_id || ""), String(body.photo_id || ""), new Date(Date.parse(t) + i).toISOString(), t));
    }
    await env.DB.batch(stmts);
    return json({ ids });
  }

  if ((mm = p.match(/^\/api\/posts\/([\w-]+)\/(\w+)$/)) && m === "POST") {
    const post = await one(env, "SELECT * FROM posts WHERE id = ?", mm[1]);
    if (!post) return fail("No such post.", 404);
    const act = mm[2];
    const t = now();
    if (act === "picture" || act === "text") {
      if (!["draft", "approved", "failed"].includes(post.status)) return fail("Wait until this post is finished.");
      if (act === "picture" && post.photo_id) return fail("This post uses your own photo.");
      await run(env, "UPDATE posts SET status = 'queued', job = ?, error = '', updated = ? WHERE id = ?", post.status === "failed" && !post.post_key ? "new" : act, t, post.id);
    } else if (act === "retry") {
      await run(env, "UPDATE posts SET status = 'queued', job = 'new', error = '', updated = ? WHERE id = ?", t, post.id);
    } else if (act === "caption") {
      const caption = String(body.caption || "").slice(0, 2200);
      await run(env, "UPDATE posts SET caption = ?, hashtags = '[]', updated = ? WHERE id = ?", caption, t, post.id);
      await remember(env, post.project_id, "feedback", `The owner rewrote the caption of "${post.headline}". Their version starts: ${caption.slice(0, 300)}`, "feedback");
    } else if (act === "approve") {
      await run(env, "UPDATE posts SET status = 'approved', updated = ? WHERE id = ?", t, post.id);
      await remember(env, post.project_id, "feedback", `The owner approved: "${post.headline}" (${post.aspect}).`, "feedback");
    } else if (act === "publish") {
      return json(await publish(env, post, body));
    } else if (act === "check") {
      await checkSocial(env, post);
    } else if (act === "unschedule") {
      const social = parse(post.social, {});
      if (post.status !== "scheduled" || !social.id) return fail("This post is not scheduled.");
      await zernio(env, `/posts/${social.id}`, { method: "DELETE" });
      await run(env, "UPDATE posts SET status = 'approved', social = '{}', error = '', updated = ? WHERE id = ?", t, post.id);
    } else if (act === "remove") {
      // A scheduled post is cancelled on Zernio too; already-published posts stay on the platforms.
      const social = parse(post.social, {});
      if (post.status === "scheduled" && social.id) await zernio(env, `/posts/${social.id}`, { method: "DELETE" });
      await run(env, "UPDATE posts SET status = 'removed', updated = ? WHERE id = ?", t, post.id);
      if (post.headline) await remember(env, post.project_id, "feedback", `The owner rejected: "${post.headline}"${body.reason ? ` because: ${String(body.reason).slice(0, 200)}` : ""}.`, "feedback");
      await Promise.all([deleteFile(env, post.post_key), deleteFile(env, post.background_key)]);
      await run(env, "UPDATE posts SET post_key = '', background_key = '', bytes = 0 WHERE id = ?", post.id);
    } else {
      return fail("Unknown action.");
    }
    return json({ ok: true });
  }

  // Platforms tab: the Zernio key and the accounts connected in Zernio.
  if (p === "/api/platforms") {
    if (m === "PUT") {
      const key = String(body.key || "").trim();
      if (!key) return fail("Paste the Zernio API key.");
      const accounts = await zernioAccounts(env, key); // fails here if the key is wrong
      await run(env, "INSERT INTO settings (k, v) VALUES ('zernio_key', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", key);
      return json({ has_key: true, key_tail: key.slice(-4), accounts, platforms: PLATFORMS });
    }
    if (m === "DELETE") {
      await run(env, "DELETE FROM settings WHERE k = 'zernio_key'");
      return json({ ok: true });
    }
    const key = await setting(env, "zernio_key");
    if (!key) return json({ has_key: false, accounts: [], platforms: PLATFORMS });
    try {
      return json({ has_key: true, key_tail: key.slice(-4), accounts: await zernioAccounts(env), platforms: PLATFORMS });
    } catch (e) {
      return json({ has_key: true, key_tail: key.slice(-4), accounts: [], platforms: PLATFORMS, error: e.message });
    }
  }

  if (p === "/api/assets" && m === "POST") {
    const form = await req.formData();
    const file = form.get("file");
    const projectId = String(form.get("project_id") || "");
    if (!file || typeof file === "string") return fail("Pick a file.");
    if (!(await one(env, "SELECT id FROM projects WHERE id = ?", projectId))) return fail("No such project.");
    const kind = ["logo", "reference", "photo"].includes(form.get("kind")) ? form.get("kind") : "reference";
    const key = await putFile(env, await file.arrayBuffer(), file.type || "application/octet-stream");
    const id = uid("a");
    const settings = kind === "logo" ? { width: 180, handle: String(form.get("handle") || "").trim() } : {};
    await run(env, "INSERT INTO assets (id, project_id, kind, name, note, file_key, mime, bytes, settings, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, projectId, kind, String(form.get("name") || file.name || "file").slice(0, 80), String(form.get("note") || "").slice(0, 500),
      key, file.type || "application/octet-stream", file.size, JSON.stringify(settings), now());
    return json({ id });
  }

  if ((mm = p.match(/^\/api\/assets\/([\w-]+)$/))) {
    const asset = await one(env, "SELECT * FROM assets WHERE id = ?", mm[1]);
    if (!asset) return fail("No such asset.", 404);
    if (m === "PUT") {
      const settings = { ...parse(asset.settings, {}), ...(body.settings || {}) };
      await run(env, "UPDATE assets SET name = ?, note = ?, settings = ? WHERE id = ?",
        String(body.name ?? asset.name).slice(0, 80), String(body.note ?? asset.note).slice(0, 500), JSON.stringify(settings), asset.id);
      return json({ ok: true });
    }
    if (m === "DELETE") {
      await deleteFile(env, asset.file_key);
      await run(env, "DELETE FROM assets WHERE id = ?", asset.id);
      return json({ ok: true });
    }
  }

  if (p === "/api/memory" && m === "POST") {
    // Your notes are rules; highlighted unless you say otherwise.
    await remember(env, String(body.project_id || ""), "you", body.note, "rule", body.pinned === false ? 0 : 1);
    return json({ ok: true });
  }
  if ((mm = p.match(/^\/api\/memory\/([\w-]+)$/))) {
    if (m === "DELETE") {
      await run(env, "DELETE FROM memory WHERE id = ?", mm[1]);
      return json({ ok: true });
    }
    if (m === "PUT") {
      await run(env, "UPDATE memory SET pinned = ? WHERE id = ?", body.pinned ? 1 : 0, mm[1]);
      return json({ ok: true });
    }
  }

  return fail("Not found.", 404);
}

// ---------- brain (PC helper) API ----------

async function agent(req, env, url) {
  const p = url.pathname;

  if (p === "/api/agent/heartbeat" && req.method === "POST") {
    const info = await req.json().catch(() => ({}));
    await run(env, "INSERT INTO helper (id, last_seen, info) VALUES ('pc', ?, ?) ON CONFLICT(id) DO UPDATE SET last_seen = excluded.last_seen, info = excluded.info",
      now(), JSON.stringify(info).slice(0, 4000));
    return json({ ok: true });
  }

  // Claim the oldest queued post and send everything the brain needs to make it.
  if (p === "/api/agent/next" && req.method === "POST") {
    if (await setting(env, "gemini_key")) return json({ job: null }); // the cloud brain makes the posts now
    await requeueStale(env);
    const post = await one(env, "SELECT * FROM posts WHERE status = 'queued' ORDER BY created LIMIT 1");
    if (!post) return json({ job: null });
    const claimed = await run(env, "UPDATE posts SET status = 'working', claimed_at = ? WHERE id = ? AND status = 'queued'", now(), post.id);
    if (!claimed.meta.changes) return json({ job: null });
    const [project, assets, memory, recent] = await Promise.all([
      one(env, "SELECT * FROM projects WHERE id = ?", post.project_id),
      all(env, "SELECT * FROM assets WHERE project_id = ?", post.project_id),
      memoryForBrain(env, post.project_id),
      all(env, "SELECT headline FROM posts WHERE project_id = ? AND headline != '' AND id != ? ORDER BY created DESC LIMIT 25", post.project_id, post.id),
    ]);
    return json({
      job: postOut(post),
      project: projectOut(project),
      assets: assets.map(assetOut),
      memory,
      recent_headlines: recent.map((r) => r.headline),
    });
  }

  let mm;
  if ((mm = p.match(/^\/api\/agent\/result\/([\w-]+)$/)) && req.method === "POST") {
    const post = await one(env, "SELECT * FROM posts WHERE id = ?", mm[1]);
    if (!post) return fail("No such post.", 404);
    const form = await req.formData();
    const data = parse(form.get("data") || "{}", {});
    if (data.error) {
      await saveResult(env, post, data, null, "");
      return json({ ok: true });
    }
    const postFile = form.get("post");
    const background = form.get("background");
    if (!postFile || typeof postFile === "string" || !background || typeof background === "string") return fail("Send both the post and the background picture.");
    await saveResult(env, post, data, postFile, await putFile(env, await background.arrayBuffer(), "image/jpeg"), background.size);
    return json({ ok: true });
  }

  if ((mm = p.match(/^\/api\/agent\/file\/([\w-]+)$/))) return file(env, mm[1]);
  return fail("Not found.", 404);
}

async function file(env, key) {
  const { value, metadata } = await env.FILES.getWithMetadata(key, { type: "stream" });
  if (!value) return fail("No such file.", 404);
  return new Response(value, { headers: { "Content-Type": (metadata && metadata.mime) || "application/octet-stream", "Cache-Control": "private, max-age=86400" } });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/api/login" && req.method === "POST") return await login(req, env);
      if (p === "/api/logout" && req.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });

      if (p.startsWith("/api/agent/")) {
        if (!(await isHelper(req, env))) return fail("Not allowed.", 401);
        return await agent(req, env, url);
      }

      if (p.startsWith("/api/")) {
        // Cookies are SameSite=Strict; also refuse writes from other sites.
        const origin = req.headers.get("Origin");
        if (req.method !== "GET" && origin && origin !== url.origin) return fail("Not allowed.", 403);
        if (!(await loggedIn(req, env))) return fail("Please log in.", 401);
        let mm;
        if ((mm = p.match(/^\/api\/file\/([\w-]+)$/))) return await file(env, mm[1]);
        return await site(req, env, url);
      }
    } catch (e) {
      return fail(e.message || "Something went wrong.", 500);
    }
    return env.ASSETS.fetch(req);
  },
};
