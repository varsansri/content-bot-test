"""PC helper: makes queued posts with Antigravity (agy) on this PC, then saves them for the website.

    python pc_helper.py          -> keeps running; checks for queued posts every 15 seconds
    python pc_helper.py --once   -> handles what is queued now, then stops

The website and GitHub queue a post (status "queued") when the AI keys are not set. This helper
asks Antigravity for the text and the picture, draws the brand frame and logo with images.py, and
pushes the result to the "drafts" branch. Needs: agy signed in, gh signed in, Pillow.
"""
import glob
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

import run

ROOT = run.ROOT
DATA = run.DATA
BRAIN = os.path.join(os.path.expanduser("~"), ".gemini", "antigravity-cli", "brain")
WORK = os.path.join(tempfile.gettempdir(), "mi-media-lab-agy")
CHECK_EVERY = 15  # seconds
GIT_AUTH = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
PICTURE_TYPES = (".png", ".jpg", ".jpeg", ".webp")


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def git(*args, cwd=DATA, check=True):
    out = subprocess.run(["git", *GIT_AUTH, *args], cwd=cwd, capture_output=True, text=True)
    if check and out.returncode:
        raise RuntimeError(f"git {' '.join(args)}: {out.stderr.strip()[:300]}")
    return out.stdout


def remote_url():
    return git("remote", "get-url", "origin", cwd=ROOT).strip()


def sync_drafts():
    if not os.path.isdir(os.path.join(DATA, ".git")):
        shutil.rmtree(DATA, ignore_errors=True)
        git("clone", "-q", "--depth", "50", "--branch", "drafts", remote_url(), DATA, cwd=ROOT)
    git("fetch", "-q", "origin", "drafts")
    git("reset", "-q", "--hard", "origin/drafts")


def push_drafts(message):
    git("add", "-A")
    if not git("status", "--porcelain").strip():
        return
    git("-c", "user.name=content-bot-pc", "-c", "user.email=content-bot-pc@users.noreply.github.com",
        "commit", "-q", "-m", message)
    for i in range(5):
        if subprocess.run(["git", *GIT_AUTH, "push", "-q", "origin", "HEAD:drafts"], cwd=DATA).returncode == 0:
            return
        git("pull", "-q", "--rebase", "origin", "drafts", check=False)
        time.sleep(3 * (i + 1))
    raise RuntimeError("Could not save the post to GitHub.")


def latest_brand():
    """brand.json as it is on GitHub now (the website edits it there)."""
    git("fetch", "-q", "origin", "main", cwd=ROOT)
    return json.loads(git("show", "origin/main:brand.json", cwd=ROOT))


def logo_file(path):
    """Copy a logo from GitHub's main branch to this PC; images.compose joins the path, so an absolute one wins."""
    logo = subprocess.run(["git", "show", f"origin/main:{path}"], cwd=ROOT, capture_output=True)
    if logo.returncode:
        return path  # missing: the post is made without a logo
    out = os.path.join(WORK, "logos", os.path.basename(path))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "wb") as f:
        f.write(logo.stdout)
    return out


# ---------- Antigravity ----------

def agy(prompt, folder, timeout=300):
    """Run one Antigravity prompt in its own folder. accept-edits lets it save files without asking."""
    out = subprocess.run(
        ["agy", "-p", prompt, "--mode", "accept-edits", "--print-timeout", f"{timeout - 20}s"],
        cwd=folder, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=timeout,
    )
    text = ANSI.sub("", (out.stdout or "") + (out.stderr or ""))
    if out.returncode:
        raise RuntimeError("Antigravity failed: " + text.strip()[-300:])
    return text


def fresh_folder(name):
    path = os.path.join(WORK, name)
    shutil.rmtree(path, ignore_errors=True)
    os.makedirs(path)
    return path


def write_text(brand, topic, recent, photo_bytes=None):
    import content
    folder = fresh_folder("text")
    if topic:
        ask = f"Write a post about: {topic}"
    else:
        ask = "Pick a fresh angle from one of these topics and write a post:\n" + "\n".join(f"- {t}" for t in brand.get("topics", []))
    if recent:
        ask += "\n\nDo not repeat these recent headlines or their ideas:\n" + "\n".join(f"- {h}" for h in recent)
    if photo_bytes:
        with open(os.path.join(folder, "photo.jpg"), "wb") as f:
            f.write(photo_bytes)
        ask += "\n\nLook at photo.jpg in the current folder: it will be the picture of this post. Write about it. image_prompt can be \"\"."
    prompt = (content._system_prompt(brand) + "\n\n" + ask +
              "\n\nDo not create or change any files. Reply with ONLY one JSON object with exactly these keys: "
              "topic, headline, subtext, caption, hashtags (a list), image_prompt. No other text.")
    reply = agy(prompt, folder)
    start, end = reply.find("{"), reply.rfind("}")
    if start < 0 or end < start:
        raise RuntimeError("Antigravity did not send the post text. Reply: " + reply.strip()[-200:])
    post = json.loads(reply[start:end + 1])
    missing = [k for k in ("headline", "caption") if not post.get(k)]
    if missing:
        raise RuntimeError("Antigravity's text is missing: " + ", ".join(missing))
    post.setdefault("topic", topic or "")
    post.setdefault("subtext", "")
    post.setdefault("image_prompt", "")
    tags = [t if t.startswith("#") else "#" + t for t in post.get("hashtags") or []]
    post["hashtags"] = list(dict.fromkeys(brand.get("always_hashtags", []) + tags))[:30]
    return post


def new_pictures(since):
    found = []
    for root in (BRAIN, WORK):
        for path in glob.glob(os.path.join(root, "**", "*"), recursive=True):
            if path.lower().endswith(PICTURE_TYPES) and os.path.getmtime(path) > since and os.sep + "logos" + os.sep not in path:
                found.append(path)
    return sorted(found, key=os.path.getmtime)


SHAPES = {"4:5": "Tall portrait picture, 4:5 shape (like 1080x1350)",
          "1:1": "Square picture, 1:1 shape (like 1080x1080)",
          "9:16": "Tall phone-screen picture, 9:16 shape (like 1080x1920)"}


def make_picture(prompt, brand, aspect="4:5"):
    from PIL import Image
    folder = fresh_folder("picture")
    style = brand.get("image_style", "")
    avoid = brand.get("image_avoid", "text, letters, words, watermark, logo")
    since = time.time() - 1
    agy("Use your image generator to create ONE picture and save it in the current folder as background.png.\n"
        f"Picture: {prompt}. Style: {style}.\n"
        f"{SHAPES.get(aspect, SHAPES['4:5'])}. Leave the bottom third calm, text goes there later. "
        f"Absolutely no {avoid}. Do not ask questions, just make it.", folder)
    # Antigravity's image helper can finish a little after agy returns; wait up to 3 more minutes.
    for _ in range(36):
        pics = new_pictures(since)
        if pics:
            time.sleep(2)  # let the file finish writing
            return Image.open(pics[-1]).convert("RGB")
        time.sleep(5)
    raise RuntimeError("Antigravity did not make a picture. Check that agy is signed in.")


# ---------- jobs ----------

def handle(draft):
    brand = latest_brand()
    job = draft.get("pc_job", "new")
    log(f"{draft['id']}: {job}")
    run.save_draft({**draft, "status": "queued", "pc_started": run.stamp()})
    push_drafts(f"pc started {job} {draft['id']}")

    photo_path = os.path.join(DATA, draft["photo_file"]) if draft.get("photo_file") else ""
    photo = run.read_bytes(photo_path) if photo_path and os.path.exists(photo_path) else None
    background_file = run.draft_path(draft["id"], "background.jpg")

    if job == "new":
        post = write_text(brand, draft.get("topic") or None, run.recent_headlines(), photo)
        draft.update(post)
        from PIL import Image
        background = Image.open(io.BytesIO(photo)).convert("RGB") if photo else make_picture(post["image_prompt"], brand, draft.get("aspect", "4:5"))
    elif job == "text":
        from PIL import Image
        post = write_text(brand, draft.get("topic") or None, [draft.get("headline", "")] + run.recent_headlines(),
                          run.read_bytes(background_file) if draft.get("own_photo") else None)
        post["image_prompt"] = draft.get("image_prompt", "")
        draft.update(post)
        background = Image.open(background_file).convert("RGB")
    elif job == "picture":
        background = make_picture(draft.get("image_prompt") or draft.get("headline", ""), brand, draft.get("aspect", "4:5"))
    else:
        raise RuntimeError(f"Unknown job {job!r}")

    run.render(draft, brand, background, resolve=logo_file)
    draft["status"] = "draft"
    draft.pop("pc_job", None)
    draft.pop("pc_started", None)
    draft.pop("error", None)
    run.save_draft(draft)


def queued():
    out = []
    for path in glob.glob(os.path.join(DATA, "drafts", "*", "draft.json")):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if d.get("status") == "queued":
            out.append(d)
    return sorted(out, key=lambda d: d.get("created", ""))


def work_once():
    sync_drafts()
    for draft in queued():
        job = draft.get("pc_job", "new")
        try:
            handle(dict(draft))
            push_drafts(f"pc {job} {draft['id']}")
            log(f"{draft['id']}: done")
        except Exception as e:
            traceback.print_exc()
            sync_drafts()
            failed = run.load_draft(draft["id"])
            failed.pop("pc_job", None)
            failed.pop("pc_started", None)
            failed["status"] = "failed" if job == "new" else "draft"
            failed["error"] = str(e)
            run.save_draft(failed)
            push_drafts(f"pc failed {job} {draft['id']}")
            log(f"{draft['id']}: failed: {e}")


def main():
    os.makedirs(WORK, exist_ok=True)
    if "--once" in sys.argv:
        work_once()
        return
    log("Mi Media Content Lab PC helper is running. Keep this window open. Ctrl+C stops it.")
    while True:
        try:
            work_once()
        except Exception as e:
            log(f"problem: {e}")
        time.sleep(CHECK_EVERY)


if __name__ == "__main__":
    main()
