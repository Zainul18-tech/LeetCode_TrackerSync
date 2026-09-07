# LeetCode → Supabase Daily Sync

Pulls each student's easy/medium/hard solved counts + streak from the
`alfa-leetcode-api` and upserts them into `public.student_summary` every
morning, using a GitHub Actions cron job (no server needed).

## 1. Get a Supabase Service Role key

You need the **service role** key (not the anon/public key) so the script
can write to `student_summary` even with RLS enabled.

- Supabase Dashboard → your project → **Settings → API**
- Copy:
  - `Project URL` → this is `SUPABASE_URL`
  - `service_role` secret key → this is `SUPABASE_SERVICE_ROLE_KEY`

⚠️ Never put the service role key in your frontend or commit it to the repo.
It only goes into GitHub Actions secrets (step 3).

## 2. Push this folder to a GitHub repo

```bash
cd leetcode-sync
git init
git add .
git commit -m "Add LeetCode daily sync"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

A private repo is fine — Actions works the same way.

## 3. Add GitHub Actions secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Value |
|---|---|
| `SUPABASE_URL` | your Project URL from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | your service_role key from step 1 |
| `LEETCODE_API_BASE` *(optional)* | only add this if you're self-hosting the `alfa-leetcode-api` Docker image somewhere instead of using the public `https://alfa-leetcode-api.onrender.com` |

## 4. That's it — the workflow is already wired up

`.github/workflows/daily-sync.yml` runs automatically every day at
**01:00 UTC (06:30 IST)**. Change the `cron` line if you want a different time
([crontab.guru](https://crontab.guru) helps write the expression — remember
GitHub Actions cron is always in UTC).

To test it right now without waiting for the schedule:
**Actions tab → "Daily LeetCode Stats Sync" → Run workflow.**

## 5. (Optional) Self-hosting the alfa-leetcode-api image

Since you already have the `alfaarghya/alfa-leetcode-api` Docker image, you
can self-host it instead of relying on the public onrender.com instance
(which has rate limits and cold starts):

```bash
docker run -d -p 3000:3000 --name leetcode-api alfaarghya/alfa-leetcode-api:2.0.4
```

Deploy that container to any always-on host you like (Render, Railway, a VPS,
etc.), then set the `LEETCODE_API_BASE` secret to that URL, e.g.
`https://your-leetcode-api.yourdomain.com`. The sync script doesn't change —
it just calls whichever base URL you give it.

## 6. Running it locally (for testing)

```bash
npm install
SUPABASE_URL="https://xxxx.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key" \
npm run sync
```

## How the streak columns work

Each morning, only *yesterday's* activity is guaranteed complete (today's
submissions might still be coming in). So each run:

- Computes the consecutive-day streak **ending yesterday** from LeetCode's
  submission calendar → stored as the new `current_streak`
- Moves whatever `current_streak` was *before* this run into
  `yesterday_streak` → so you can compare "streak yesterday vs streak now"
  and tell whether a student's streak just grew or just broke

If you want different semantics (e.g. `yesterday_streak` should literally
always equal "streak as of yesterday" rather than "previous run's value"),
just tell me and I'll adjust the logic in `sync-leetcode-stats.mjs`.

## Files

- `sync-leetcode-stats.mjs` — the actual sync logic
- `package.json` — dependencies (`@supabase/supabase-js`)
- `.github/workflows/daily-sync.yml` — the cron schedule
