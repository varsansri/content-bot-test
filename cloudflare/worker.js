// Mi Media Content Lab on Cloudflare: the whole system except the brain.
// Serves the website (docs/), keeps projects, briefs, memory, assets and posts (D1 + KV), and hands
// jobs to the brain (Antigravity on the PC helper) through /api/agent/*.
//
// Secrets: PASSWORD, SESSION_KEY (website login), AGENT_TOKEN (the PC helper's key).
// Bindings: DB (D1), FILES (KV), ASSETS (static site).

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
  return { ...p, hashtags: parse(p.hashtags, []) };
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
    return json({ projects, project: pid, posts: posts.map(postOut), assets: assets.map(assetOut), memory, queue: queue.n, storage: await storage(env) });
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
    } else if (act === "remove") {
      await run(env, "UPDATE posts SET status = 'removed', updated = ? WHERE id = ?", t, post.id);
      if (post.headline) await remember(env, post.project_id, "feedback", `The owner rejected: "${post.headline}"${body.reason ? ` because: ${String(body.reason).slice(0, 200)}` : ""}.`, "feedback");
      await Promise.all([deleteFile(env, post.post_key), deleteFile(env, post.background_key)]);
      await run(env, "UPDATE posts SET post_key = '', background_key = '', bytes = 0 WHERE id = ?", post.id);
    } else {
      return fail("Unknown action.");
    }
    return json({ ok: true });
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
    const t = now();
    if (data.error) {
      await run(env, "UPDATE posts SET status = ?, error = ?, claimed_at = '', updated = ? WHERE id = ?",
        post.post_key ? "draft" : "failed", String(data.error).slice(0, 800), t, post.id);
      return json({ ok: true });
    }
    const keys = {};
    for (const name of ["post", "background"]) {
      const f = form.get(name);
      if (f && typeof f !== "string") keys[name] = await putFile(env, await f.arrayBuffer(), "image/jpeg");
    }
    if (!keys.post || !keys.background) return fail("Send both the post and the background picture.");
    await Promise.all([deleteFile(env, post.post_key), deleteFile(env, post.background_key)]);
    const postKey = keys.post;
    const bgKey = keys.background;
    const bytes = form.get("post").size + form.get("background").size;
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
