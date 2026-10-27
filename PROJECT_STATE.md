# Mi Media Content Lab — project state

Last updated: 26 Oct 2026

## What it is
An Instagram content bot. You give it instructions on a **website** (GitHub Pages), and **GitHub Actions** does the work:
- Claude writes the headline, caption and hashtags.
- Free Cloudflare AI makes the background picture.
- The bot's own code draws the logo, fonts and colours on every post, so the look never changes.
- The post goes to Instagram after approval, or automatically on a daily schedule (Auto-post).

27 Oct: he is NOT handing it over. He runs it on his accounts and other people use it only through the browser site (password, no tokens). It still must not depend on this PC.

## Where things are
| What | Where |
|---|---|
| Code | `C:\Users\varsa\instagram-content-bot` (git, branch `main`) |
| Handover zip | `C:\Users\varsa\instagram-content-bot.zip` (no keys inside) |
| Test repo (public) | https://github.com/varsansri/content-bot-test |
| **Website (27 Oct)** | https://mi-media-content-lab.thebeliverone.workers.dev (Cloudflare worker `cloudflare/worker.js` + `wrangler.jsonc`, serves `docs/`; password in `~/mi-media-lab-password.txt`; `~/labkeys.sh` resets password + GitHub key; deploy `npx wrangler deploy`). Pushed to main 27 Oct. |
| Old test website | https://varsansri.github.io/content-bot-test/ (token screen; replaced by the one above) |
| Drafts | `drafts` branch of the repo |
| Setup guide for the recipient | `README.md` |

## 27 Oct (late): site = the whole system, Antigravity = brain only (LIVE, verified)
- Cloudflare worker `cloudflare/worker.js` holds everything: D1 `mi-media-lab` (projects, assets, posts, memory, helper; schema in cloudflare/schema.sql) + KV `mi-media-lab-files` (all files). GitHub is no longer used by the site.
- Site tabs: project picker + Create / Assets / Memory / Brief / Storage. Memory = notes the brain reads before every post (you / brain lessons / feedback from approve, reject, caption edits).
- `pc_helper.py` now only: POST /api/agent/next every 20 s -> agy text + picture -> compose -> upload -> delete job files. Low priority. Config ~/.mi-media-lab/config.json (url + AGENT_TOKEN). Heartbeat reports PC storage.
- Projects: Reaching Dreams (2 logos, brief) and Mi Media (empty brief, no logo yet).
- Test post "Write your goals down. Here is why." made end to end through the site (~3 min).
- Old GitHub `bot` workflow still has its schedule on (auto mode blocked disabling it): `! gh workflow disable bot.yml -R varsansri/content-bot-test`.
- Next: Zernio (posting/scheduling), Higgsfield (video), later swap the brain to an API key.

## Antigravity PC helper (27 Oct, first version; replaced by the above)
- No AI keys are set on GitHub, so run.py queues new/text/picture jobs (status "queued", `pc_job`).
- `pc_helper.py` on this PC polls the drafts branch every 15 s, asks `agy -p --mode accept-edits` (no yes/no prompts) for the JSON text and the picture (it saves under ~/.gemini/antigravity-cli/brain), draws the brand frame with images.py, pushes to drafts.
- Start it: double-click `Desktop\Mi Media Lab helper.bat`. Run only ONE helper at a time. PC off = posts wait as "Waiting for your PC".
- Test p-20261027-test-agy2: about 3 minutes, good picture + caption. p-...-agy1 failed (missing anthropic import, fixed).
- Not handled yet: auto-post for scheduled slots made on the PC; posting to Instagram (no keys).

## Logo library (27 Oct, LIVE)
- brand.json `logos` [{name, file, width, handle}]; `logo.file` = default. Reaching Dreams round mark (default) + full white wordmark in assets/logos/ (from ~/reachingdreams-work).
- Site: Logo tiles in Create (or No logo); Brand tab adds/removes/sets default. Post stores `logo`; run.with_logo applies width + handle.
- Mi Media logo NOT added: none on this PC; mimedialabs.in shows a gambling brand "LV88", mimedialabs.com suspended. Add it via Brand -> Add a logo.

## Done and verified
- The post design is checked visually: logo, headline, subtext, @handle and accent bar on a 1080×1350 picture.
- Every engine action passed an offline test with fake AI: new, new picture, new text, edit caption, skip, post (errors show clearly), own photo, schedule slots.
- The website was tested with fake GitHub data: drafts, buttons, "making the post" card, schedule line, Auto-post switch. No sideways scrolling.
- A live GitHub run with no keys took 22 seconds. It saved a draft that failed politely with "ANTHROPIC_API_KEY secret is missing". The website deploys (HTTP 200).

## Not tested yet
These need keys: Claude writing, Cloudflare pictures, ImgBB upload, the Instagram post, the weekly Instagram token refresh, and connecting the website with a GitHub token.

## Next steps
1. **Keys:** he fills `.env` in Notepad (the first four keys; Instagram later), then runs `! bash ~/botkeys.sh`. The script sends them to GitHub as secrets and deletes the file.
2. **Real test:** make one post via `gh workflow run bot.yml -R varsansri/content-bot-test -f action=new -f id=<id> -f topic=...` and show him the picture. Post to Instagram (ideally a spare test account) only after his go.
3. **Connect the website:** his GitHub web login is broken, so he can't make a fine-grained token. I offered to connect the site with this PC's `gh` login; it can change all his repos and would be saved in the browser. **Waiting for his yes/no.**
4. **Google Nano Banana pictures:** I offered it as an optional switch in the Brand tab (likely about ₹4–6 per picture, no free allowance; uses the logo as a style reference). **Waiting for his yes/no.**
5. **Antigravity CLI (`agy`):** installed 26 Oct via winget (Google.AntigravityCLI 1.4.7, but `agy --version` says 1.1.22; try `agy update`). He still has to sign in with `! agy`. Then check whether `agy -p` can make images. It cannot run inside GitHub Actions, because it needs a browser Google sign-in.
6. **Before handover:** fill `brand.json` with the recipient's brand and logo, and rebuild the zip.

## Helper scripts (in `C:\Users\varsa`)
- `botlive.sh`: created the public repo and turned on Pages (already run).
- `botkeys.sh`: pushes the keys in `.env` to the repo as secrets, then deletes `.env`.
