# Content Bot

A website that makes Instagram posts (picture + caption + hashtags) and posts them for you.
Everything runs free on GitHub, so no computer has to stay on.

- **Claude** writes the headline, caption and hashtags in your brand's voice.
- **Cloudflare Workers AI** makes the background picture. Its free plan covers roughly 100 pictures a day.
- The bot draws **your logo, colours and fonts** on every picture, so every post has the same look.
- Open the site and type a topic or upload a photo. A minute later the post appears with these buttons:
  **Post to Instagram**, **New picture**, **New text**, **Edit caption**, **Skip**.
- A **daily schedule** makes posts at your chosen times. They either wait for your OK or post themselves (Auto-post).

Running cost: Claude only, under 1 US cent per post. GitHub, Cloudflare and ImgBB are free.

> The repository must be **public**: GitHub Pages is free only for public repositories.
> Your keys are still safe, because they are stored as GitHub *secrets*, which nobody can read.
> Drafts and the code are visible to anyone who finds the repository.

---

## Setup (about 30 minutes, once)

### 1. Put this folder on GitHub
1. Make a GitHub account at github.com.
2. Click **New repository**, name it e.g. `content-bot`, choose **Public**, and create it.
3. Click **uploading an existing file**, drag in everything from this folder, and click **Commit**.
   Make sure the `.github` folder is uploaded too. If your computer hides it, upload it on its own.

### 2. Get the keys
| Key | Where | Notes |
|---|---|---|
| `ANTHROPIC_API_KEY` | console.anthropic.com → API keys | Add $5 credit under Billing first |
| `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → AI → Workers AI → **Use REST API** | Free account. Copy the Account ID, then **Create a Workers AI API Token** |
| `IMGBB_API_KEY` | imgbb.com (free account) → api.imgbb.com → **Get API key** | Gives Instagram a public link to fetch the picture from |
| `INSTAGRAM_ACCESS_TOKEN` | see step 3 | |
| `GH_PAT` | see step 4 | Used for the website login and the weekly Instagram refresh |
| `POLLINATIONS_TOKEN` *(optional)* | pollinations.ai | Backup picture maker, used only if Cloudflare fails |

### 3. Instagram token
1. The Instagram account must be a **Professional** account (Business or Creator).
   In the app: Settings → Account type and tools → Switch to professional account. It's free.
2. Go to developers.facebook.com → **My Apps → Create app**.
3. Choose the use case **"Manage messaging & content on Instagram"**.
4. Open **API setup with Instagram login** → **Generate access tokens** → **Add account**, and log in to the Instagram account.
5. Click **Generate token** and copy it.

### 4. GitHub token (the website login)
GitHub → your photo → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**:
- **Repository access:** Only select repositories → your bot repository
- **Permissions → Repository:** **Actions**, **Contents** and **Secrets**, each set to **Read and write**
- **Expiration:** the longest allowed. Put a reminder in your calendar to renew it.

Copy the token. You'll paste it in two places: as the `GH_PAT` secret, and once into the website.

### 5. Add the secrets
In your repository: **Settings → Secrets and variables → Actions → New repository secret**.
Add each key from the table, using exactly the name shown, e.g. `ANTHROPIC_API_KEY`.

### 6. Turn on the website
In the repository, go to **Settings → Pages**. Under **Source**, choose **Deploy from a branch**, then branch **main** and folder **/docs**, and click **Save**.
After a minute the site is live at `https://<your-username>.github.io/<repository-name>/`.

### 7. Open the site and connect
Open the site. Your username and repository fill themselves in. Paste the GitHub token and click **Connect**.
The token is saved in that browser only, so do this once on each phone or computer you use.

### 8. Set the brand
On the **Brand** tab:
- Upload the logo. A PNG with a transparent background looks best.
- Fill in what the account is about, the voice, the topics, and 3–5 example captions you like. The examples matter most for the style.
- Set the colours, logo position, picture style and posting times.

Then go to **Posts** and make a test post.

---

## Using it

| You do | It does |
|---|---|
| Type a topic → **Make post** | Writes and designs a post about it |
| Leave the topic empty → **Make post** | Picks one of your brand topics |
| Choose a photo → **Make post** | Puts your logo and text on *your* photo and writes the caption |
| **New picture** / **New text** | Remakes only that part |
| **Edit caption** | Type your own caption |
| **Post to Instagram** (tap twice) | Posts it and shows the link |
| **Auto-post** switch | ON: scheduled posts go live by themselves. OFF: they wait on the site for your OK |

Each action takes about a minute, because GitHub starts a small computer for it. You can close the page and come back.

**Tip:** keep Auto-post off for the first two weeks. AI sometimes gets facts wrong.

## Good to know
- **Schedule timing:** GitHub's timer can run 5–30 minutes late. The bot catches up on any slot within 3 hours.
- **Keeping the schedule alive:** GitHub pauses scheduled jobs in a repository that has had no changes for 60 days. Every post the bot makes counts as a change, so a running schedule stays alive. If it ever pauses, open the **Actions** tab and click **Enable**.
- **Instagram login:** it refreshes itself every Monday, using `GH_PAT`.
- **Instagram limit:** about 100 posts a day through the API, which is far more than you need.

## If something goes wrong
The error shows on the post card on the site. For details, open the **Actions** tab in the repository and click the red run.

- **"… secret is missing"**: add that secret (step 5).
- **"Could not make a picture"**: the Cloudflare ID or token is wrong, or today's free limit is used up (it resets daily).
- **Instagram error code 190**: the Instagram login died. Make a new token (step 3) and replace the `INSTAGRAM_ACCESS_TOKEN` secret.
- **The site says "Bad credentials"**: the GitHub token expired. Make a new one (step 4), update `GH_PAT`, then use **Setup → Forget on this device** and connect again.

## Files
- `docs/`: the website
- `.github/workflows/bot.yml`: the engine GitHub runs for every action and for the schedule
- `.github/workflows/refresh-instagram-login.yml`: keeps the Instagram login alive
- `run.py`: what the engine does
- `content.py`: writes the text (Claude)
- `images.py`: makes the picture and draws the logo, text and colours
- `instagram.py`: posts to Instagram
- `brand.json`: the brand look and voice. The Brand tab edits it for you
- Drafts are saved on the repository's `drafts` branch
