// Content Bot website. Talks to the GitHub repo: reads drafts from the "drafts" branch,
// starts the "bot" workflow for every action, and edits brand.json / the logo on the main branch.

const $ = (sel, el = document) => el.querySelector(sel);

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory only */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};

let cfg = store.get("cfg", null) || guessRepo();
let repoInfo = null;
let brand = null;
let brandSha = null;
let pending = store.get("pending", {}); // id -> { action, sha, at, error?, runUrl? }
let hidden = store.get("hidden", []); // failed drafts the owner chose to hide
const draftCache = {}; // draft.json blob sha -> draft
const imgCache = {}; // post.jpg blob sha -> object URL
let shown = []; // [{ draft, draftSha, imgSha }]
let pollTimer = null;
let editing = null;

function guessRepo() {
  const host = location.hostname;
  if (host.endsWith(".github.io")) {
    const owner = host.split(".")[0];
    const repo = location.pathname.split("/").filter(Boolean)[0] || host;
    return { owner, repo, token: "" };
  }
  return { owner: "", repo: "", token: "" };
}

// ---------- GitHub API ----------

async function gh(path, { method = "GET", body, accept, raw } = {}) {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
    method,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: accept || "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* not JSON */ }
    const err = new Error(`GitHub said: ${msg} (${res.status})`);
    err.status = res.status;
    throw err;
  }
  if (raw) return res;
  return res.status === 204 ? null : res.json();
}

const blob = (sha) => gh(`/git/blobs/${sha}`, { accept: "application/vnd.github.raw+json", raw: true });

function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const textToB64 = (text) => bytesToB64(new TextEncoder().encode(text));
const b64ToText = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

async function fileSha(path, ref) {
  try { return (await gh(`/contents/${path}?ref=${ref}`)).sha; } catch (e) { if (e.status === 404) return null; throw e; }
}

async function putFile(path, b64, message, branch, sha) {
  return gh(`/contents/${path}`, { method: "PUT", body: { message, content: b64, branch, ...(sha ? { sha } : {}) } });
}

async function ensureDraftsBranch() {
  try {
    await gh("/git/ref/heads/drafts");
  } catch (e) {
    if (e.status !== 404) throw e;
    const tree = await gh("/git/trees", {
      method: "POST",
      body: { tree: [{ path: "README.md", mode: "100644", type: "blob", content: "Drafts made by the content bot.\n" }] },
    });
    const commit = await gh("/git/commits", { method: "POST", body: { message: "Start drafts", tree: tree.sha, parents: [] } });
    await gh("/git/refs", { method: "POST", body: { ref: "refs/heads/drafts", sha: commit.sha } });
  }
}

async function dispatch(action, id, extra = {}) {
  const inputs = { action, id };
  for (const [k, v] of Object.entries(extra)) if (v) inputs[k] = v;
  await gh("/actions/workflows/bot.yml/dispatches", { method: "POST", body: { ref: repoInfo.default_branch, inputs } });
  const current = shown.find((s) => s.draft.id === id);
  pending[id] = { action, sha: current ? current.draftSha : null, at: Date.now() };
  store.set("pending", pending);
  renderList();
  poll(5000);
}

// ---------- drafts ----------

const idTime = (id) => (id.match(/(\d{8}-\d{4,6})/) || ["", ""])[1].padEnd(15, "0");

async function loadDrafts() {
  let tree;
  try {
    tree = await gh("/git/trees/drafts?recursive=1");
  } catch (e) {
    if (e.status === 404 || e.status === 409) return [];
    throw e;
  }
  const files = {};
  for (const t of tree.tree) {
    const m = t.path.match(/^drafts\/([^/]+)\/(draft\.json|post\.jpg)$/);
    if (m) (files[m[1]] ||= {})[m[2]] = t.sha;
  }
  const ids = Object.keys(files).filter((id) => files[id]["draft.json"])
    .sort((a, b) => idTime(b).localeCompare(idTime(a))).slice(0, 30);
  await Promise.all(ids.map(async (id) => {
    const sha = files[id]["draft.json"];
    if (!draftCache[sha]) draftCache[sha] = JSON.parse(await (await blob(sha)).text());
    const img = files[id]["post.jpg"];
    if (img && !imgCache[img]) imgCache[img] = URL.createObjectURL(await (await blob(img)).blob());
  }));
  return ids.map((id) => ({ draft: draftCache[files[id]["draft.json"]], draftSha: files[id]["draft.json"], imgSha: files[id]["post.jpg"] }));
}

async function checkRuns() {
  const old = Object.entries(pending).filter(([, p]) => !p.error && Date.now() - p.at > 25000);
  if (!old.length) return;
  const runs = (await gh("/actions/runs?event=workflow_dispatch&per_page=30")).workflow_runs;
  for (const [id, p] of old) {
    const run = runs.find((r) => r.display_title === `${p.action} ${id}`);
    if (run && run.status === "completed") {
      if (run.conclusion === "success") delete pending[id];
      else { p.error = `The run ${run.conclusion}.`; p.runUrl = run.html_url; }
    } else if (Date.now() - p.at > 10 * 60000) {
      p.error = "This is taking too long.";
      p.runUrl = `https://github.com/${cfg.owner}/${cfg.repo}/actions`;
    }
  }
}

async function refresh() {
  try {
    shown = await loadDrafts();
    for (const s of shown) {
      const p = pending[s.draft.id];
      if (p && p.sha !== s.draftSha) delete pending[s.draft.id];
    }
    await checkRuns();
    store.set("pending", pending);
    renderList();
  } catch (e) {
    toast(e.message);
  }
}

function poll(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await refresh();
    const busy = Object.values(pending).some((p) => !p.error);
    poll(busy ? 6000 : 60000);
  }, delay);
}

// ---------- rendering ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS = { draft: "Waiting for you", posted: "Posted", skipped: "Skipped", failed: "Failed", working: "Working" };
const ACTION_TEXT = { new: "Making the post…", post: "Posting to Instagram…", picture: "Making a new picture…", text: "Writing new text…", caption: "Saving the caption…", skip: "Skipping…" };

function fullCaption(d) {
  return d.caption + (d.hashtags && d.hashtags.length ? "\n\n" + d.hashtags.join(" ") : "");
}

function when(d) {
  const t = d.posted || d.updated || d.created;
  return t ? new Date(t).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
}

function renderList() {
  const list = $("#list");
  const items = shown.filter((s) => !hidden.includes(s.draft.id));
  // Posts being made that have not reached GitHub yet.
  for (const [id, p] of Object.entries(pending)) {
    if (p.action === "new" && !items.some((s) => s.draft.id === id)) items.unshift({ draft: { id, status: "working" }, ghost: true });
  }
  $("#empty").hidden = items.length > 0;
  list.innerHTML = items.map(cardHtml).join("");
}

function cardHtml({ draft: d, imgSha, ghost }) {
  const p = pending[d.id];
  const busy = p && !p.error;
  const status = busy ? "working" : d.status;
  const img = imgSha && imgCache[imgSha];
  let html = `<article class="card" data-id="${esc(d.id)}">
    <div class="pic">${img ? `<img src="${img}" alt="${esc(d.headline)}">` : ""}
      ${busy ? `<div class="busy">${esc(ACTION_TEXT[p.action] || "Working…")}<br><span class="muted small">about a minute</span></div>` : ""}
    </div><div class="body">
    <span class="chip ${status}">${STATUS[status] || esc(status)}</span><span class="when">${esc(when(d))}</span>`;
  if (p && p.error) html += `<div class="err">${esc(p.error)} <a href="${esc(p.runUrl)}" target="_blank" rel="noopener">See what happened</a></div>`;
  if (d.error) html += `<div class="err">${esc(d.error)}</div>`;
  if (ghost) return html + `</div></article>`;

  if (editing === d.id) {
    html += `<textarea class="edit-box" rows="10">${esc(fullCaption(d))}</textarea>
      <div class="actions"><button class="primary" data-act="save-caption">Save caption</button><button data-act="cancel-edit">Cancel</button></div>`;
  } else if (d.caption) {
    html += `<div class="caption">${esc(d.caption)}</div>`;
    if (d.hashtags && d.hashtags.length) html += `<div class="tags">${esc(d.hashtags.join(" "))}</div>`;
  }
  if (d.status === "posted" && d.permalink) html += `<p><a href="${esc(d.permalink)}" target="_blank" rel="noopener">Open on Instagram</a></p>`;
  if (d.status === "draft" && !busy && editing !== d.id) {
    html += `<div class="actions">
      <button class="primary" data-act="post">✅ Post to Instagram</button>
      ${d.own_photo ? "" : `<button data-act="picture">🖼 New picture</button>`}
      <button data-act="text">✍️ New text</button>
      <button data-act="edit">✏️ Edit caption</button>
      <button class="danger" data-act="skip">Skip</button>
    </div>`;
  }
  if (d.status === "failed" && !busy) html += `<div class="actions"><button data-act="retry">Try again</button><button data-act="dismiss">Hide</button></div>`;
  if (p && p.error) html += `<div class="actions"><button data-act="dismiss">OK</button></div>`;
  return html + `</div></article>`;
}

async function onCardClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest(".card").dataset.id;
  const act = btn.dataset.act;
  const item = shown.find((s) => s.draft.id === id);
  btn.disabled = true;
  try {
    if (act === "edit") { editing = id; renderList(); return; }
    if (act === "cancel-edit") { editing = null; renderList(); return; }
    if (act === "dismiss") {
      if (pending[id]) delete pending[id];
      else hidden = [...hidden, id].slice(-200);
      store.set("pending", pending);
      store.set("hidden", hidden);
      renderList();
      return;
    }
    if (act === "save-caption") {
      const text = btn.closest(".card").querySelector(".edit-box").value.trim();
      if (text.length > 2200) { toast("Instagram allows 2,200 characters at most."); btn.disabled = false; return; }
      editing = null;
      await dispatch("caption", id, { caption: text });
      return;
    }
    if (act === "post" && !confirmPost()) { btn.disabled = false; return; }
    if (act === "retry") { await makePost(item ? item.draft.topic : ""); return; }
    await dispatch(act, id);
  } catch (err) {
    toast(err.message);
    btn.disabled = false;
  }
}

function confirmPost() {
  // A second tap within 4 seconds confirms, so nothing goes live by accident.
  const now = Date.now();
  if (confirmPost.armed && now - confirmPost.armed < 4000) { confirmPost.armed = 0; return true; }
  confirmPost.armed = now;
  toast("Tap Post again to confirm.");
  return false;
}

// ---------- making posts ----------

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `p-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

async function photoToJpegB64(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const out = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
  return bytesToB64(new Uint8Array(await out.arrayBuffer()));
}

async function makePost(topic, photoFile) {
  const id = newId();
  let photo = "";
  if (photoFile) {
    toast("Uploading your photo…");
    photo = `uploads/${id}.jpg`;
    await putFile(photo, await photoToJpegB64(photoFile), `photo for ${id}`, "drafts");
  }
  await dispatch("new", id, { topic, photo });
  toast("Started. Your post will appear here in about a minute.");
}

async function onNewPost() {
  const btn = $("#new-go");
  btn.disabled = true;
  try {
    await makePost($("#new-topic").value.trim(), $("#new-photo").files[0]);
    $("#new-topic").value = "";
    $("#new-photo").value = "";
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- brand ----------

const FIELDS = [
  ["brand_name", "Brand name", "text"],
  ["instagram_handle", "Instagram handle (shown on every picture)", "text"],
  ["about", "What the account is about", "area"],
  ["voice", "How the captions should sound", "area"],
  ["language", "Language", "text"],
  ["topics", "Topics for scheduled posts (one per line)", "lines"],
  ["example_captions", "Example captions you like (blank line between them)", "blocks"],
  ["always_hashtags", "Hashtags on every post", "tags"],
  ["hashtag_count", "How many extra hashtags", "number"],
  ["image_style", "Picture style (added to every AI picture)", "area"],
  ["black_and_white", "Make every picture black and white", "bool"],
  ["colors.text", "Text colour", "color"],
  ["colors.accent", "Accent bar colour", "color"],
  ["colors.overlay", "Shade colour behind text", "color"],
  ["overlay_strength", "Shade strength (0 to 1)", "decimal"],
  ["logo.position", "Logo position", "select:top-left,top-right,bottom-left,bottom-right"],
  ["logo.width", "Logo width in pixels (picture is 1080 wide)", "number"],
  ["post_times", "Daily posting times, 24-hour (e.g. 10:00, 19:00)", "csv"],
  ["timezone", "Timezone (e.g. Asia/Kolkata)", "text"],
];

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ||= {}), obj)[last] = value;
}

function fieldHtml([key, label, type], i) {
  const v = getPath(brand, key);
  const name = `f${i}`;
  if (type === "area") return `<label>${label}<textarea name="${name}" rows="3">${esc(v)}</textarea></label>`;
  if (type === "lines") return `<label>${label}<textarea name="${name}" rows="5">${esc((v || []).join("\n"))}</textarea></label>`;
  if (type === "blocks") return `<label>${label}<textarea name="${name}" rows="8">${esc((v || []).join("\n\n"))}</textarea></label>`;
  if (type === "tags") return `<label>${label}<input name="${name}" value="${esc((v || []).join(" "))}"></label>`;
  if (type === "csv") return `<label>${label}<input name="${name}" value="${esc((v || []).join(", "))}"></label>`;
  if (type === "bool") return `<label class="check"><input type="checkbox" name="${name}" ${v ? "checked" : ""}>${label}</label>`;
  if (type === "color") return `<label>${label}<input type="color" name="${name}" value="${esc(v || "#ffffff")}"></label>`;
  if (type === "number") return `<label>${label}<input type="number" name="${name}" value="${esc(v)}" min="0"></label>`;
  if (type === "decimal") return `<label>${label}<input type="number" name="${name}" value="${esc(v)}" min="0" max="1" step="0.05"></label>`;
  if (type.startsWith("select:")) {
    const opts = type.slice(7).split(",").map((o) => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("");
    return `<label>${label}<select name="${name}">${opts}</select></label>`;
  }
  return `<label>${label}<input name="${name}" value="${esc(v)}"></label>`;
}

function readField([key, , type], i) {
  const el = $(`#brand-form [name="f${i}"]`);
  const raw = type === "bool" ? el.checked : el.value;
  if (type === "lines") return raw.split("\n").map((s) => s.trim()).filter(Boolean);
  if (type === "blocks") return raw.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (type === "tags") return raw.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith("#") ? t : "#" + t));
  if (type === "csv") {
    const times = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const bad = times.find((t) => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t));
    if (bad) throw new Error(`"${bad}" is not a time like 19:00`);
    return times;
  }
  if (type === "number" || type === "decimal") return Number(raw);
  return raw;
}

async function loadBrand() {
  const file = await gh(`/contents/brand.json?ref=${repoInfo.default_branch}`);
  brand = JSON.parse(b64ToText(file.content));
  brandSha = file.sha;
  renderSchedule();
}

async function saveBrand(message) {
  const res = await putFile("brand.json", textToB64(JSON.stringify(brand, null, 2) + "\n"), message, repoInfo.default_branch, brandSha);
  brandSha = res.content.sha;
  renderSchedule();
}

function renderBrand() {
  $("#brand-form").innerHTML = FIELDS.map(fieldHtml).join("");
  gh(`/contents/${brand.logo?.file || "assets/logo.png"}?ref=${repoInfo.default_branch}`, { accept: "application/vnd.github.raw+json", raw: true })
    .then((r) => r.blob()).then((b) => { $("#logo-img").src = URL.createObjectURL(b); }).catch(() => {});
}

async function onBrandSave() {
  const btn = $("#brand-save");
  btn.disabled = true;
  try {
    await loadBrand(); // start from the latest version
    const values = FIELDS.map(readField);
    FIELDS.forEach(([key], i) => setPath(brand, key, values[i]));
    await saveBrand("Update brand settings");
    toast("Saved. New posts use the new look.");
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}

async function onLogoPick(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const path = brand.logo?.file || "assets/logo.png";
    const b64 = bytesToB64(new Uint8Array(await file.arrayBuffer()));
    await putFile(path, b64, "Update logo", repoInfo.default_branch, await fileSha(path, repoInfo.default_branch));
    $("#logo-img").src = URL.createObjectURL(file);
    toast("Logo saved.");
  } catch (err) {
    toast(err.message);
  }
  e.target.value = "";
}

function renderSchedule() {
  const times = (brand.post_times || []).join(", ");
  $("#schedule-text").textContent = times ? `Daily at ${times} (${brand.timezone || "UTC"})` : "No daily schedule";
  $("#auto-toggle").checked = !!brand.auto_post;
}

async function onAutoToggle(e) {
  const on = e.target.checked;
  e.target.disabled = true;
  try {
    await loadBrand();
    brand.auto_post = on;
    await saveBrand(on ? "Turn auto-post on" : "Turn auto-post off");
    toast(on ? "Auto-post ON: scheduled posts go live without asking." : "Auto-post OFF: scheduled posts wait for you.");
  } catch (err) {
    e.target.checked = !on;
    toast(err.message);
  } finally {
    e.target.disabled = false;
  }
}

// ---------- setup + navigation ----------

function showTab(name) {
  for (const id of ["posts", "brand", "setup"]) $(`#${id}`).hidden = id !== name;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("on", t.dataset.tab === name));
  if (name === "brand" && brand) renderBrand();
}

async function connect() {
  $("#cfg-status").textContent = "Connecting…";
  repoInfo = await gh("");
  if (!repoInfo.permissions || !repoInfo.permissions.push) throw new Error("This token cannot change the repository. Give it Contents and Actions write access.");
  await ensureDraftsBranch();
  await loadBrand();
  $("#tabs").hidden = false;
  $("#cfg-status").textContent = `Connected to ${cfg.owner}/${cfg.repo}.`;
  showTab("posts");
  await refresh();
  poll(Object.values(pending).some((p) => !p.error) ? 6000 : 60000);
}

async function onConnect() {
  cfg = { owner: $("#cfg-owner").value.trim(), repo: $("#cfg-repo").value.trim(), token: $("#cfg-token").value.trim() };
  if (!cfg.owner || !cfg.repo || !cfg.token) { $("#cfg-status").textContent = "Fill in all three."; return; }
  try {
    await connect();
    store.set("cfg", cfg);
  } catch (e) {
    $("#cfg-status").textContent = e.message;
  }
}

function onForget() {
  store.remove("cfg");
  store.remove("pending");
  location.reload();
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

function init() {
  $("#cfg-owner").value = cfg.owner;
  $("#cfg-repo").value = cfg.repo;
  $("#cfg-token").value = cfg.token;
  $("#cfg-save").addEventListener("click", onConnect);
  $("#cfg-forget").addEventListener("click", onForget);
  $("#new-go").addEventListener("click", onNewPost);
  $("#list").addEventListener("click", onCardClick);
  $("#brand-save").addEventListener("click", onBrandSave);
  $("#logo-file").addEventListener("change", onLogoPick);
  $("#auto-toggle").addEventListener("change", onAutoToggle);
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));
  document.addEventListener("visibilitychange", () => { if (!document.hidden && repoInfo) poll(0); });

  if (cfg.token) {
    connect().catch((e) => { showTab("setup"); $("#cfg-status").textContent = e.message; });
  } else {
    showTab("setup");
  }
}

init();
