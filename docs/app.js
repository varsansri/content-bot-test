// Mi Media Content Lab website. Everything is stored by the Cloudflare worker (/api/*);
// the brain (Antigravity on the PC helper) picks up queued posts from there.

const $ = (sel, el = document) => el.querySelector(sel);

const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode: keep in memory only */ }
  },
};

let state = null; // { projects, project, posts, assets, memory, queue, storage }
let projectId = store.get("project", "");
let tab = store.get("tab", "create");
let filter = store.get("filter", "review");
let count = 1;
let aspect = store.get("aspect", "4:5");
let logoChoice = ""; // asset id, "none", or "" for the project default
let editing = null;
let pollTimer = null;
let memFilter = store.get("memFilter", "pinned");

// ---------- server ----------

async function api(path, { method = "GET", body, form } = {}) {
  const res = await fetch(path, {
    method,
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(res.status === 401 ? "Please log in again." : data.message || `Something went wrong (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function refresh() {
  try {
    state = await api(`/api/state?project=${encodeURIComponent(projectId)}`);
    projectId = state.project;
    store.set("project", projectId);
    render();
  } catch (e) {
    if (e.status === 401) return showLogin();
    toast(e.message);
  }
}

function poll() {
  clearTimeout(pollTimer);
  const busyNow = state && (state.queue > 0 || state.posts.some((p) => ["queued", "working"].includes(p.status)));
  pollTimer = setTimeout(async () => { await refresh(); poll(); }, busyNow ? 6000 : 30000);
}

// ---------- helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const project = () => state && state.projects.find((p) => p.id === projectId);
const brief = () => (project() && project().brief) || {};
const logos = () => (state ? state.assets.filter((a) => a.kind === "logo") : []);
const defaultLogo = () => brief().default_logo || (logos()[0] && logos()[0].id) || "none";

function bytes(n) {
  if (!n) return "0 KB";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function ago(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

const brainOnline = () => state && state.storage.pc && Date.now() - Date.parse(state.storage.pc.last_seen) < 5 * 60000;

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message); } finally { btn.disabled = false; }
}

// ---------- rendering ----------

const SECTIONS = ["login", "welcome", "create", "assets", "memory", "brief", "storage"];

function showSection(name) {
  for (const id of SECTIONS) $(`#${id}`).hidden = id !== name;
}

function render() {
  $("#tabs").hidden = $("#project-bar").hidden = !state.projects.length;
  if (!state.projects.length) return showSection("welcome");
  $("#project-pick").innerHTML = state.projects.map((p) => `<option value="${esc(p.id)}" ${p.id === projectId ? "selected" : ""}>${esc(p.name)}</option>`).join("");
  document.querySelectorAll(".tab[data-tab]").forEach((t) => t.classList.toggle("on", t.dataset.tab === tab));
  showSection(tab);
  renderBrain();
  renderCreate();
  renderList();
  if (tab === "assets") renderAssets();
  if (tab === "memory") renderMemory();
  if (tab === "brief" && $("#brief-form").dataset.project !== projectId) renderBrief();
  if (tab === "storage") renderStorage();
}

function renderBrain() {
  const waiting = state.queue;
  $("#brain-line").innerHTML = brainOnline()
    ? `<b class="ok">●</b> Brain online (your PC, Antigravity)${state.storage.pc.job ? " · making a post now" : ""}${waiting ? ` · ${waiting} waiting` : ""}`
    : `<b class="bad">●</b> Brain offline${state.storage.pc ? ` (last seen ${ago(state.storage.pc.last_seen)})` : ""}. Posts wait until the PC helper runs.${waiting ? ` ${waiting} waiting.` : ""}`;
}

const RATIO = { "4:5": "4 / 5", "1:1": "1 / 1", "9:16": "9 / 16" };
const SIZE_NAME = { "4:5": "Portrait", "1:1": "Square", "9:16": "Story" };
const STATUS = { queued: "Waiting for the brain", working: "Being made", draft: "Ready to review", approved: "Approved", failed: "Failed" };
const inFilter = (p) => filter === "all" || (filter === "approved" ? p.status === "approved" : p.status !== "approved");

function currentLogo() {
  if (logoChoice === "none") return "none";
  return logos().some((l) => l.id === logoChoice) ? logoChoice : defaultLogo();
}

function renderCreate() {
  const photo = $("#new-photo").files[0];
  const n = photo ? 1 : count;
  $("#count").textContent = n;
  $("#count-minus").disabled = !!photo || count <= 1;
  $("#count-plus").disabled = !!photo || count >= 10;
  document.querySelectorAll("#sizes .size").forEach((b) => b.classList.toggle("on", b.dataset.aspect === aspect));
  $("#new-go").textContent = `Make ${n} ${SIZE_NAME[aspect].toLowerCase()} post${n > 1 ? "s" : ""}`;
  if (!state) return;
  const cur = currentLogo();
  $("#logo-pick").innerHTML = logos().map((l) => `<button type="button" class="logo-tile ${l.id === cur ? "on" : ""}" data-logo="${esc(l.id)}">
      <span class="logo-pic"><img src="${esc(l.url)}" alt=""></span><small>${esc(l.name)}</small></button>`).join("") +
    `<button type="button" class="logo-tile ${cur === "none" ? "on" : ""}" data-logo="none"><span class="logo-pic none">–</span><small>No logo</small></button>` +
    (logos().length ? "" : `<p class="muted small">Add logos in the Assets tab.</p>`);
}

function renderList() {
  const posts = state.posts;
  const counts = { review: posts.filter((p) => p.status !== "approved").length, approved: posts.filter((p) => p.status === "approved").length, all: posts.length };
  document.querySelectorAll("#filters button").forEach((b) => {
    b.classList.toggle("on", b.dataset.filter === filter);
    b.querySelector("span").textContent = counts[b.dataset.filter] ? `(${counts[b.dataset.filter]})` : "";
  });
  const items = posts.filter(inFilter);
  $("#empty").hidden = items.length > 0;
  $("#empty").textContent = filter === "review" ? "Nothing to review. Make some posts above." : "Nothing here yet.";
  $("#list").innerHTML = items.map(cardHtml).join("");
}

function fullCaption(p) {
  return p.caption + (p.hashtags && p.hashtags.length ? "\n\n" + p.hashtags.join(" ") : "");
}

function cardHtml(p) {
  const making = p.status === "queued" || p.status === "working";
  const img = p.post_key ? `/api/file/${p.post_key}` : "";
  const overlay = making
    ? `<div class="busy">${p.status === "working" ? "The brain is making this…" : brainOnline() ? "Waiting in line…" : "Waiting for the brain…"}<br>
       <span class="muted small">${p.status === "working" ? "about 3 minutes" : brainOnline() ? "it makes posts one by one" : "start the PC helper"}</span></div>` : "";
  let html = `<article class="card" data-id="${esc(p.id)}">
    <div class="pic" style="aspect-ratio: ${RATIO[p.aspect] || RATIO["4:5"]}">${img ? `<img src="${img}" alt="${esc(p.headline)}" loading="lazy">` : ""}${overlay}</div>
    <div class="body">
    <span class="chip ${p.status}">${STATUS[p.status] || esc(p.status)}</span><span class="when">${SIZE_NAME[p.aspect] || "Portrait"} · ${esc(new Date(p.updated).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))}</span>`;
  if (p.error) html += `<div class="err">${esc(p.error)}</div>`;
  if (p.topic && !p.caption) html += `<p class="muted small">Topic: ${esc(p.topic)}</p>`;
  if (editing === p.id) {
    return html + `<textarea class="edit-box" rows="10">${esc(fullCaption(p))}</textarea>
      <div class="actions"><button class="primary" data-act="save-caption">Save caption</button><button data-act="cancel-edit">Cancel</button></div></div></article>`;
  }
  if (p.caption) {
    html += `<div class="caption">${esc(p.caption)}</div>`;
    if (p.hashtags.length) html += `<div class="tags">${esc(p.hashtags.join(" "))}</div>`;
  }
  if (img && p.caption && !making) {
    html += `<div class="actions"><a class="btn" href="${img}" download="${esc(p.id)}.jpg">⬇ Download picture</a><button data-act="copy">📋 Copy caption</button></div>`;
  }
  if (p.status === "draft") {
    html += `<div class="actions">
      <button class="primary" data-act="approve">✓ Approve</button>
      ${p.photo_id ? "" : `<button data-act="picture">🖼 New picture</button>`}
      <button data-act="text">✍️ New words</button>
      <button data-act="edit">✏️ Edit caption</button>
      <button class="danger" data-act="remove">🗑 Remove</button></div>`;
  } else if (p.status === "approved") {
    html += `<div class="actions"><button data-act="text">✍️ New words</button><button class="danger" data-act="remove">🗑 Remove</button></div>`;
  } else if (p.status === "failed") {
    html += `<div class="actions"><button data-act="retry">Try again</button><button class="danger" data-act="remove">🗑 Remove</button></div>`;
  }
  return html + `</div></article>`;
}

function renderAssets() {
  $("#asset-handle-row").hidden = $("#asset-kind").value !== "logo";
  const groups = [["logo", "Logos"], ["reference", "References"], ["photo", "Photos"]];
  const def = defaultLogo();
  $("#asset-list").innerHTML = groups.map(([kind, title]) => {
    const list = state.assets.filter((a) => a.kind === kind);
    if (!list.length) return "";
    return `<div class="panel"><h2>${title}</h2><div class="asset-grid">${list.map((a) => `<div class="asset" data-id="${esc(a.id)}">
      <span class="asset-pic ${kind === "logo" ? "dark" : ""}"><img src="${esc(a.url)}" alt="" loading="lazy"></span>
      <div class="asset-fields">
        <b>${esc(a.name)}</b> ${kind === "logo" && a.id === def ? `<span class="chip approved">Default</span>` : ""}
        <span class="muted small">${bytes(a.bytes)}</span>
        <label>How to use it <input data-k="note" value="${esc(a.note)}"></label>
        ${kind === "logo" ? `<div class="grid2 tight">
          <label>Handle on the picture <input data-k="handle" value="${esc(a.settings.handle || "")}" placeholder="${esc(brief().instagram_handle || "@yourbrand")}"></label>
          <label>Width (px) <input data-k="width" type="number" min="40" max="900" value="${esc(a.settings.width || 180)}"></label></div>` : ""}
        <div class="row">
          <button data-asset-act="save">Save</button>
          ${kind === "logo" && a.id !== def ? `<button data-asset-act="default">Make default</button>` : ""}
          <button class="danger" data-asset-act="delete">Delete</button>
        </div>
      </div></div>`).join("")}</div></div>`;
  }).join("") || `<p class="muted center">No assets yet. Add the project's logo above.</p>`;
}

const MEM_KIND = { hint: "Hint", rule: "Your rule", lesson: "Lesson", feedback: "Your feedback", log: "Work log" };
const memMatch = (m) => memFilter === "all" || (memFilter === "pinned" ? m.pinned : !m.pinned && m.kind === memFilter);

function renderMemory() {
  const mem = state.memory;
  const counts = { pinned: mem.filter((m) => m.pinned).length, all: mem.length };
  for (const k of ["lesson", "feedback", "log"]) counts[k] = mem.filter((m) => !m.pinned && m.kind === k).length;
  document.querySelectorAll("#memory-filters button").forEach((b) => {
    b.classList.toggle("on", b.dataset.mf === memFilter);
    b.querySelector("span").textContent = counts[b.dataset.mf] ? `(${counts[b.dataset.mf]})` : "";
  });
  const list = mem.filter(memMatch);
  $("#memory-list").innerHTML = list.map((m) => `<div class="memory ${m.pinned ? "pinned" : ""}" data-id="${esc(m.id)}">
      <button class="ghost star small-btn" data-mem-act="pin" aria-label="${m.pinned ? "Remove highlight" : "Highlight"}" title="${m.pinned ? "Highlighted: always followed" : "Highlight it"}">${m.pinned ? "★" : "☆"}</button>
      <div class="memory-body">
        <span class="memory-note">${esc(m.note)}</span>
        <span class="memory-meta"><span class="chip ${esc(m.kind)}">${MEM_KIND[m.kind] || esc(m.kind)}</span>
          ${m.source === "brain" ? "by the brain" : m.source === "you" ? "by you" : "from your review"} · ${esc(new Date(m.created).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }))}</span>
      </div>
      <button class="ghost danger small-btn" data-mem-act="delete" aria-label="Delete">✕</button></div>`).join("") ||
    `<p class="muted center">${memFilter === "pinned" ? "Nothing highlighted yet. The brain stars important hints by itself, or star any note." : "Nothing here yet. It fills up as the brain makes posts and you review them."}</p>`;
}

const FIELDS = [
  "About the brand",
  ["brand_name", "Brand name", "text"],
  ["instagram_handle", "Instagram handle (shown on every picture unless the logo has its own)", "text"],
  ["about", "What the account is about and who follows it", "area"],
  "Captions",
  ["voice", "How the captions should sound", "area"],
  ["language", "Language", "text"],
  ["topics", "Topics the brain can pick from (one per line)", "lines"],
  ["example_captions", "Example captions you like (blank line between them)", "blocks"],
  ["always_hashtags", "Hashtags on every post", "tags"],
  ["hashtag_count", "How many extra hashtags", "number"],
  "Picture look",
  ["image_style", "Picture style (added to every AI picture)", "area"],
  ["black_and_white", "Make every picture black and white", "bool"],
  ["colors.text", "Text colour", "color"],
  ["colors.accent", "Accent bar colour", "color"],
  ["colors.overlay", "Shade colour behind text", "color"],
  ["overlay_strength", "Shade strength (0 to 1)", "decimal"],
  ["logo_position", "Logo position", "select:top-left,top-right,bottom-left,bottom-right"],
];

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
function setPath(obj, path, value) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => (o[k] ||= {}), obj)[last] = value;
}

function fieldHtml(field, i) {
  if (typeof field === "string") return `<h3>${esc(field)}</h3>`;
  const [key, label, type] = field;
  const v = getPath(brief(), key);
  const name = `f${i}`;
  if (type === "area") return `<label>${label}<textarea name="${name}" rows="3">${esc(v)}</textarea></label>`;
  if (type === "lines") return `<label>${label}<textarea name="${name}" rows="5">${esc((v || []).join("\n"))}</textarea></label>`;
  if (type === "blocks") return `<label>${label}<textarea name="${name}" rows="8">${esc((v || []).join("\n\n"))}</textarea></label>`;
  if (type === "tags") return `<label>${label}<input name="${name}" value="${esc((v || []).join(" "))}"></label>`;
  if (type === "bool") return `<label class="check"><input type="checkbox" name="${name}" ${v ? "checked" : ""}>${label}</label>`;
  if (type === "color") return `<label>${label}<input type="color" name="${name}" value="${esc(v || "#ffffff")}"></label>`;
  if (type === "number") return `<label>${label}<input type="number" name="${name}" value="${esc(v ?? 8)}" min="0" max="30"></label>`;
  if (type === "decimal") return `<label>${label}<input type="number" name="${name}" value="${esc(v ?? 0.8)}" min="0" max="1" step="0.05"></label>`;
  if (type.startsWith("select:")) {
    const opts = type.slice(7).split(",").map((o) => `<option ${o === (v || "top-left") ? "selected" : ""}>${o}</option>`).join("");
    return `<label>${label}<select name="${name}">${opts}</select></label>`;
  }
  return `<label>${label}<input name="${name}" value="${esc(v)}"></label>`;
}

function readField(field, i) {
  const type = field[2];
  const el = $(`#brief-form [name="f${i}"]`);
  const raw = type === "bool" ? el.checked : el.value;
  if (type === "lines") return raw.split("\n").map((s) => s.trim()).filter(Boolean);
  if (type === "blocks") return raw.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  if (type === "tags") return raw.split(/[\s,]+/).filter(Boolean).map((t) => (t.startsWith("#") ? t : "#" + t));
  if (type === "number" || type === "decimal") return Number(raw);
  return raw;
}

function renderBrief() {
  if (!project()) return;
  $("#brief-form").innerHTML = `<label>Project name<input name="project-name" value="${esc(project().name)}"></label>` + FIELDS.map(fieldHtml).join("");
  $("#brief-form").dataset.project = projectId;
}

function renderStorage() {
  const { cloud, pc } = state.storage;
  const pct = Math.min(100, (cloud.total / cloud.limit) * 100);
  $("#cloud-bar").style.width = `${Math.max(pct, 0.5)}%`;
  $("#cloud-bar").className = pct > 85 ? "bad" : pct > 60 ? "warn" : "";
  $("#cloud-text").textContent = `${bytes(cloud.total)} used of ${bytes(cloud.limit)} free (${pct.toFixed(1)}%)`;
  const names = Object.fromEntries(state.projects.map((p) => [p.id, p.name]));
  const byProject = {};
  for (const r of cloud.rows) (byProject[r.project_id] ||= { assets: [0, 0], posts: [0, 0] })[r.kind] = [r.n, r.bytes];
  $("#cloud-rows").innerHTML = `<table class="tbl"><tr><th>Project</th><th>Assets</th><th>Posts</th><th>Total</th></tr>` +
    (Object.entries(byProject).map(([id, v]) => `<tr><td>${esc(names[id] || "(deleted)")}</td><td>${v.assets[0]} · ${bytes(v.assets[1])}</td>
      <td>${v.posts[0]} · ${bytes(v.posts[1])}</td><td>${bytes(v.assets[1] + v.posts[1])}</td></tr>`).join("") ||
      `<tr><td colspan="4" class="muted">Nothing stored yet.</td></tr>`) + `</table>`;
  $("#pc-rows").innerHTML = pc ? `<table class="tbl">
      <tr><td>Status</td><td>${brainOnline() ? `<b class="ok">●</b> Online` : `<b class="bad">●</b> Offline`} · last seen ${ago(pc.last_seen)}</td></tr>
      <tr><td>Helper's job files</td><td>${bytes(pc.helper_bytes)}</td></tr>
      <tr><td>Antigravity's folder</td><td>${bytes(pc.antigravity_bytes)}</td></tr>
      <tr><td>Free space on the PC</td><td>${bytes(pc.disk_free)} of ${bytes(pc.disk_total)}</td></tr></table>`
    : `<p class="muted">The PC helper has not connected yet.</p>`;
}

// ---------- actions ----------

async function onNewPost() {
  const btn = $("#new-go");
  await busy(btn, async () => {
    const photo = $("#new-photo").files[0];
    let photoId = "";
    if (photo) {
      btn.textContent = "Uploading your photo…";
      const form = new FormData();
      form.append("file", await shrinkPhoto(photo), "photo.jpg");
      form.append("project_id", projectId);
      form.append("kind", "photo");
      form.append("name", photo.name);
      photoId = (await api("/api/assets", { method: "POST", form })).id;
    }
    const n = photo ? 1 : count;
    await api("/api/posts", { method: "POST", body: { project_id: projectId, topic: $("#new-topic").value.trim(), count: n, aspect, logo_id: currentLogo(), photo_id: photoId } });
    toast(n > 1 ? `${n} posts are in line. They appear below as the brain makes them.` : "Your post is in line. It appears below when it is made.");
    $("#new-topic").value = "";
    $("#new-photo").value = "";
    filter = "review";
    store.set("filter", filter);
    await refresh();
    poll();
  });
  renderCreate();
}

async function shrinkPhoto(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, "image/jpeg", 0.9));
}

// A second tap within 4 seconds confirms, so nothing is deleted by accident.
function confirmTwice(btn, message) {
  const t = Date.now();
  if (btn.dataset.armed && t - Number(btn.dataset.armed) < 4000) return true;
  btn.dataset.armed = t;
  toast(message);
  return false;
}

async function onCardClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const id = btn.closest(".card").dataset.id;
  const act = btn.dataset.act;
  const post = state.posts.find((p) => p.id === id);
  if (act === "edit") { editing = id; return renderList(); }
  if (act === "cancel-edit") { editing = null; return renderList(); }
  if (act === "copy") {
    await navigator.clipboard.writeText(fullCaption(post)).then(() => toast("Caption copied."), () => toast("Could not copy."));
    return;
  }
  if (act === "remove" && !confirmTwice(btn, "Tap Remove again to delete this post.")) return;
  await busy(btn, async () => {
    if (act === "save-caption") {
      const text = btn.closest(".card").querySelector(".edit-box").value.trim();
      if (text.length > 2200) throw new Error("Instagram allows 2,200 characters at most.");
      await api(`/api/posts/${id}/caption`, { method: "POST", body: { caption: text } });
      editing = null;
    } else {
      await api(`/api/posts/${id}/${act}`, { method: "POST", body: {} });
      if (act === "approve") toast("Approved. Download it for now; auto-posting comes with Zernio.");
    }
    await refresh();
    poll();
  });
}

async function onAssetAdd() {
  const file = $("#asset-file").files[0];
  if (!file) return toast("Pick a file first.");
  await busy($("#asset-add"), async () => {
    const form = new FormData();
    form.append("file", file);
    form.append("project_id", projectId);
    form.append("kind", $("#asset-kind").value);
    form.append("name", $("#asset-name").value.trim() || file.name);
    form.append("note", $("#asset-note").value.trim());
    form.append("handle", $("#asset-handle").value.trim());
    await api("/api/assets", { method: "POST", form });
    for (const id of ["#asset-file", "#asset-name", "#asset-note", "#asset-handle"]) $(id).value = "";
    toast("Asset saved.");
    await refresh();
  });
}

async function onAssetClick(e) {
  const btn = e.target.closest("button[data-asset-act]");
  if (!btn) return;
  const row = btn.closest(".asset");
  const id = row.dataset.id;
  const act = btn.dataset.assetAct;
  if (act === "delete" && !confirmTwice(btn, "Tap Delete again to remove this asset.")) return;
  await busy(btn, async () => {
    if (act === "delete") {
      await api(`/api/assets/${id}`, { method: "DELETE" });
    } else if (act === "default") {
      await api(`/api/projects/${projectId}`, { method: "PUT", body: { brief: { default_logo: id } } });
      toast("Default logo changed.");
    } else {
      const settings = {};
      const handle = row.querySelector('[data-k="handle"]');
      const width = row.querySelector('[data-k="width"]');
      if (handle) settings.handle = handle.value.trim();
      if (width) settings.width = Number(width.value) || 180;
      await api(`/api/assets/${id}`, { method: "PUT", body: { note: row.querySelector('[data-k="note"]').value.trim(), settings } });
      toast("Saved.");
    }
    await refresh();
  });
}

async function onBriefSave() {
  await busy($("#brief-save"), async () => {
    const out = {};
    FIELDS.forEach((field, i) => { if (typeof field !== "string") setPath(out, field[0], readField(field, i)); });
    out.colors = { ...(brief().colors || {}), ...out.colors };
    await api(`/api/projects/${projectId}`, { method: "PUT", body: { name: $('#brief-form [name="project-name"]').value.trim(), brief: out } });
    toast("Brief saved. New posts follow it.");
    await refresh();
    renderBrief();
  });
}

async function newProject(name) {
  if (!name) return toast("Give the project a name.");
  const { id } = await api("/api/projects", { method: "POST", body: { name, copy_from: projectId } });
  projectId = id;
  store.set("project", id);
  tab = "brief";
  store.set("tab", tab);
  await refresh();
  renderBrief();
  toast(`${name} created. Fill in its brief and add its logo in Assets.`);
}

// ---------- log in + navigation ----------

function showLogin(message = "") {
  clearTimeout(pollTimer);
  $("#tabs").hidden = $("#project-bar").hidden = true;
  showSection("login");
  $("#login-status").textContent = message;
}

async function onLogin(e) {
  e.preventDefault();
  await busy($("#login-go"), async () => {
    $("#login-status").textContent = "Checking…";
    try {
      await api("/api/login", { method: "POST", body: { password: $("#login-pass").value } });
    } catch (err) {
      $("#login-status").textContent = err.status === 401 ? "Wrong password." : err.message;
      return;
    }
    $("#login-pass").value = "";
    $("#login-status").textContent = "";
    await refresh();
    poll();
  });
}

function init() {
  $("#login").addEventListener("submit", onLogin);
  $("#logout").addEventListener("click", async () => { await fetch("/api/logout", { method: "POST" }).catch(() => {}); location.reload(); });
  document.querySelectorAll(".tab[data-tab]").forEach((t) => t.addEventListener("click", () => {
    tab = t.dataset.tab;
    store.set("tab", tab);
    if (tab === "brief") renderBrief();
    render();
  }));
  $("#project-pick").addEventListener("change", async (e) => {
    projectId = e.target.value;
    logoChoice = "";
    editing = null;
    await refresh();
    renderBrief();
  });
  $("#project-new").addEventListener("click", () => {
    const name = prompt("Name of the new project (for example Mi Media):");
    if (name) newProject(name.trim()).catch((err) => toast(err.message));
  });
  $("#first-go").addEventListener("click", () => newProject($("#first-name").value.trim()).catch((err) => toast(err.message)));

  $("#new-go").addEventListener("click", onNewPost);
  $("#count-minus").addEventListener("click", () => { count = Math.max(1, count - 1); renderCreate(); });
  $("#count-plus").addEventListener("click", () => { count = Math.min(10, count + 1); renderCreate(); });
  $("#new-photo").addEventListener("change", renderCreate);
  $("#sizes").addEventListener("click", (e) => {
    const b = e.target.closest(".size");
    if (!b) return;
    aspect = b.dataset.aspect;
    store.set("aspect", aspect);
    renderCreate();
  });
  $("#logo-pick").addEventListener("click", (e) => {
    const b = e.target.closest(".logo-tile");
    if (!b) return;
    logoChoice = b.dataset.logo;
    renderCreate();
  });
  $("#filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-filter]");
    if (!b) return;
    filter = b.dataset.filter;
    store.set("filter", filter);
    renderList();
  });
  $("#list").addEventListener("click", onCardClick);

  $("#asset-kind").addEventListener("change", () => { $("#asset-handle-row").hidden = $("#asset-kind").value !== "logo"; });
  $("#asset-add").addEventListener("click", onAssetAdd);
  $("#asset-list").addEventListener("click", onAssetClick);

  $("#memory-add").addEventListener("click", () => busy($("#memory-add"), async () => {
    const note = $("#memory-note").value.trim();
    if (!note) throw new Error("Write something to remember.");
    await api("/api/memory", { method: "POST", body: { project_id: projectId, note, pinned: $("#memory-pin").checked } });
    $("#memory-note").value = "";
    await refresh();
  }));
  $("#memory-list").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-mem-act]");
    if (!btn) return;
    const id = btn.closest(".memory").dataset.id;
    const m = state.memory.find((x) => x.id === id);
    busy(btn, async () => {
      if (btn.dataset.memAct === "pin") await api(`/api/memory/${id}`, { method: "PUT", body: { pinned: !m.pinned } });
      else await api(`/api/memory/${id}`, { method: "DELETE" });
      await refresh();
    });
  });
  $("#memory-filters").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mf]");
    if (!b) return;
    memFilter = b.dataset.mf;
    store.set("memFilter", memFilter);
    renderMemory();
  });

  $("#brief-save").addEventListener("click", onBriefSave);
  $("#project-delete").addEventListener("click", (e) => {
    if (!confirmTwice(e.target, `Tap again to delete ${project().name} for good.`)) return;
    busy(e.target, async () => {
      await api(`/api/projects/${projectId}`, { method: "DELETE" });
      projectId = "";
      tab = "create";
      store.set("tab", tab);
      await refresh();
    });
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden && state) refresh().then(poll); });
  refresh().then(() => state && poll());
}

init();
