"""The bot's engine. GitHub Actions runs this; the website asks for each action.

    python run.py due                       -> prints due=true/false (is a scheduled post due?)
    python run.py schedule                  -> makes (and, if auto_post, posts) the due scheduled posts
    ACTION=new ID=... TOPIC=... PHOTO=... python run.py action
    ACTION=post|picture|text|caption|skip ID=... [CAPTION=...] python run.py action

Drafts live in ./data (the "drafts" branch): data/drafts/<id>/draft.json, background.jpg, post.jpg
"""
import datetime as dt
import glob
import io
import json
import os
import sys
import traceback
from zoneinfo import ZoneInfo

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
SLOT_WINDOW = dt.timedelta(hours=3)  # GitHub's timer can run late; catch up within 3 hours


def now_utc():
    return dt.datetime.now(dt.timezone.utc)


def stamp():
    return now_utc().isoformat(timespec="seconds")


def load_brand():
    with open(os.path.join(ROOT, "brand.json"), encoding="utf-8") as f:
        return json.load(f)


def draft_path(draft_id, name="draft.json"):
    return os.path.join(DATA, "drafts", draft_id, name)


def load_draft(draft_id):
    with open(draft_path(draft_id), encoding="utf-8") as f:
        return json.load(f)


def save_draft(draft):
    draft["updated"] = stamp()
    os.makedirs(os.path.dirname(draft_path(draft["id"])), exist_ok=True)
    with open(draft_path(draft["id"]), "w", encoding="utf-8") as f:
        json.dump(draft, f, indent=2, ensure_ascii=False)


def read_bytes(path):
    with open(path, "rb") as f:
        return f.read()


def write_bytes(path, data):
    with open(path, "wb") as f:
        f.write(data)


def recent_headlines(limit=20):
    posted = []
    for path in glob.glob(os.path.join(DATA, "drafts", "*", "draft.json")):
        with open(path, encoding="utf-8") as f:
            d = json.load(f)
        if d.get("status") == "posted":
            posted.append(d)
    posted.sort(key=lambda d: d.get("updated", ""))
    return [d["headline"] for d in posted[-limit:]]


# ---------- schedule ----------

def due_slots(brand):
    tz = ZoneInfo(brand.get("timezone", "UTC"))
    now = now_utc().astimezone(tz)
    slots = []
    for t in brand.get("post_times", []):
        hour, minute = map(int, t.split(":"))
        for day in (now.date(), now.date() - dt.timedelta(days=1)):
            at = dt.datetime(day.year, day.month, day.day, hour, minute, tzinfo=tz)
            slot_id = "slot-" + at.strftime("%Y%m%d-%H%M")
            if at <= now < at + SLOT_WINDOW and not os.path.exists(draft_path(slot_id)):
                slots.append(slot_id)
    return slots


# ---------- the work ----------

def render(draft, brand, background):
    import images
    buf = io.BytesIO()
    background.save(buf, "JPEG", quality=95)
    write_bytes(draft_path(draft["id"], "background.jpg"), buf.getvalue())
    write_bytes(draft_path(draft["id"], "post.jpg"),
                images.compose(background, draft["headline"], draft["subtext"], brand))


def make_draft(draft_id, brand, topic=None, photo_file=None, slot=None):
    import content
    import images
    from PIL import Image

    need("ANTHROPIC_API_KEY")
    photo = read_bytes(os.path.join(DATA, photo_file)) if photo_file else None
    draft = {"id": draft_id, "status": "working", "created": stamp(), "topic": topic or "",
             "own_photo": bool(photo), "slot": slot}
    save_draft(draft)
    post = content.write_post(brand, topic, recent_headlines(), photo)
    draft.update(post)
    if photo:
        background = Image.open(io.BytesIO(photo)).convert("RGB")
    else:
        background = images.generate_background(post["image_prompt"], brand)
    render(draft, brand, background)
    draft["status"] = "draft"
    save_draft(draft)
    return draft


def new_picture(draft, brand):
    import images
    if draft.get("own_photo"):
        raise RuntimeError("This post uses your own photo. Upload a different photo instead.")
    render(draft, brand, images.generate_background(draft["image_prompt"], brand))


def new_text(draft, brand):
    import content
    from PIL import Image
    need("ANTHROPIC_API_KEY")
    background_file = draft_path(draft["id"], "background.jpg")
    photo = read_bytes(background_file) if draft.get("own_photo") else None
    post = content.write_post(brand, draft.get("topic") or None, [draft["headline"]] + recent_headlines(), photo)
    post["image_prompt"] = draft["image_prompt"]  # keep the same picture
    draft.update(post)
    render(draft, brand, Image.open(background_file).convert("RGB"))


def need(name):
    value = os.getenv(name)
    if not value:
        raise RuntimeError(f"The {name} secret is missing. Add it in GitHub: Settings → Secrets and variables → Actions.")
    return value


def publish(draft):
    import content
    import instagram
    need("IMGBB_API_KEY")
    link = instagram.publish(need("INSTAGRAM_ACCESS_TOKEN"),
                             read_bytes(draft_path(draft["id"], "post.jpg")),
                             content.full_caption(draft))
    draft["status"] = "posted"
    draft["posted"] = stamp()
    draft["permalink"] = link


def do_action(action, draft_id, topic="", caption="", photo=""):
    brand = load_brand()
    if action == "new":
        try:
            make_draft(draft_id, brand, topic or None, photo or None)
        except Exception as e:
            fail_new(draft_id, e)
        return

    draft = load_draft(draft_id)
    if draft.get("status") != "draft":
        print(f"Draft {draft_id} is {draft.get('status')}; nothing to do.")
        return
    draft.pop("error", None)
    try:
        if action == "post":
            publish(draft)
        elif action == "picture":
            new_picture(draft, brand)
        elif action == "text":
            new_text(draft, brand)
        elif action == "caption":
            draft["caption"] = caption
            draft["hashtags"] = []  # the edited text is the whole caption
        elif action == "skip":
            draft["status"] = "skipped"
        else:
            raise RuntimeError(f"Unknown action {action!r}")
    except Exception as e:
        traceback.print_exc()
        draft["error"] = str(e)
    save_draft(draft)


def fail_new(draft_id, err):
    traceback.print_exc()
    try:
        draft = load_draft(draft_id)
    except FileNotFoundError:
        draft = {"id": draft_id, "created": stamp()}
    draft["status"] = "failed"
    draft["error"] = str(err)
    save_draft(draft)


def run_schedule():
    brand = load_brand()
    for slot_id in due_slots(brand):
        try:
            draft = make_draft(slot_id, brand, slot=slot_id)
        except Exception as e:
            fail_new(slot_id, e)
            continue
        if brand.get("auto_post"):
            do_action("post", slot_id)
        print(f"{slot_id}: {load_draft(slot_id)['status']}")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "due":
        print("due=" + ("true" if due_slots(load_brand()) else "false"))
    elif cmd == "schedule":
        run_schedule()
    elif cmd == "action":
        draft_id = os.environ.get("ID", "").strip()
        if not draft_id or "/" in draft_id or ".." in draft_id:
            sys.exit("A valid ID is needed.")
        do_action(os.environ.get("ACTION", "").strip(), draft_id,
                  os.environ.get("TOPIC", ""), os.environ.get("CAPTION", ""), os.environ.get("PHOTO", "").strip())
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
