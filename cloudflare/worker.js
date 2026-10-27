// Mi Media Content Lab on Cloudflare. Serves the website (docs/) and passes its GitHub calls
// through with the GitHub token kept here, so people only ever type the site password.
//
// Secrets (wrangler secret put): PASSWORD, SESSION_KEY, GITHUB_TOKEN.

const REPO = "varsansri/content-bot-test";
const COOKIE = "lab";
const SESSION_DAYS = 30;

// The only GitHub calls the website makes. Anything else is refused, so the password
// cannot be used to touch other repos, secrets or the workflow files.
const ALLOWED = [
  ["GET", /^$/],
  ["GET", /^\/git\/ref\/heads\/drafts$/],
  ["GET", /^\/git\/trees\/drafts\?recursive=1$/],
  ["GET", /^\/git\/blobs\/[0-9a-f]{40}$/],
  ["POST", /^\/git\/(trees|commits|refs)$/],
  ["POST", /^\/actions\/workflows\/bot\.yml\/dispatches$/],
  ["GET", /^\/actions\/runs\?[\w=&]+$/],
  ["GET", /^\/contents\/(brand\.json|assets\/[\w.-]+|uploads\/[\w.-]+)\?ref=(main|drafts)$/],
  ["PUT", /^\/contents\/(brand\.json|assets\/[\w.-]+|uploads\/[\w.-]+)$/],
];

const enc = new TextEncoder();

async function hmac(key, text) {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(text)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Changing PASSWORD logs everyone out, because it is part of the signing key.
const sessionKey = (env) => env.SESSION_KEY + "|" + env.PASSWORD;

async function makeSession(env) {
  const exp = Date.now() + SESSION_DAYS * 86400000;
  return `${exp}.${await hmac(sessionKey(env), String(exp))}`;
}

async function loggedIn(req, env) {
  const m = (req.headers.get("Cookie") || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([0-9a-f]{64})`));
  if (!m || Number(m[1]) < Date.now()) return false;
  return (await hmac(sessionKey(env), m[1])) === m[2];
}

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers } });

const cookie = (value, maxAge) => `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;

async function login(req, env) {
  let password = "";
  try { password = String((await req.json()).password || ""); } catch { /* empty */ }
  const a = await hmac(env.SESSION_KEY, password);
  const b = await hmac(env.SESSION_KEY, env.PASSWORD);
  if (!env.PASSWORD || a !== b) {
    await new Promise((r) => setTimeout(r, 1000)); // slows down guessing
    return json({ message: "Wrong password." }, 401);
  }
  return json({ ok: true }, 200, { "Set-Cookie": cookie(await makeSession(env), SESSION_DAYS * 86400) });
}

async function github(req, env, path) {
  const method = req.method;
  if (!ALLOWED.some(([m, re]) => m === method && re.test(path))) return json({ message: "Not allowed." }, 403);

  let body;
  if (method !== "GET") {
    body = await req.text();
    let parsed = {};
    try { parsed = JSON.parse(body || "{}"); } catch { return json({ message: "Bad request." }, 400); }
    if (path === "/git/refs" && parsed.ref !== "refs/heads/drafts") return json({ message: "Not allowed." }, 403);
    if (method === "PUT" && !["main", "drafts"].includes(parsed.branch)) return json({ message: "Not allowed." }, 403);
  }

  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: req.headers.get("Accept") || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "mi-media-content-lab",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body,
  });
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": res.headers.get("Content-Type") || "application/octet-stream", "Cache-Control": "no-store" },
  });
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;

    if (p === "/api/login" && req.method === "POST") return login(req, env);
    if (p === "/api/logout" && req.method === "POST") return json({ ok: true }, 200, { "Set-Cookie": cookie("", 0) });

    if (p.startsWith("/api/")) {
      // Cookies are SameSite=Strict; also refuse writes from other sites.
      const origin = req.headers.get("Origin");
      if (req.method !== "GET" && origin && origin !== url.origin) return json({ message: "Not allowed." }, 403);
      if (!(await loggedIn(req, env))) return json({ message: "Please log in." }, 401);
      if (p === "/api/gh" || p.startsWith("/api/gh/")) return github(req, env, p.slice("/api/gh".length) + url.search);
      return json({ message: "Not found." }, 404);
    }

    return env.ASSETS.fetch(req);
  },
};
