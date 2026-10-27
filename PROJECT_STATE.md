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
| **Website (27 Oct)** | https://mi-media-content-lab.thebeliverone.workers.dev (Cloudflare worker `cloudflare/worker.js` + `wrangler.jsonc`, serves `docs/`; password in `~/mi-media-lab-password.txt`; `~/labkeys.sh` resets password + GitHub key; deploy `npx wrangler deploy`). Not committed/pushed yet. |
| Old test website | https://varsansri.github.io/content-bot-test/ (token screen; replaced by the one above) |
| Drafts | `drafts` branch of the repo |
| Setup guide for the recipient | `README.md` |

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
