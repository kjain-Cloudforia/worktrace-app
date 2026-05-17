# ONBOARDING — WorkTrace for new teammates

You've been added to WorkTrace. This guide walks you from "I have a username and password" to "I'm signed in and logging my work day." Should take about 30 minutes.

If you're an **admin** onboarding someone else, jump to the [Admin section](#admin-onboarding-a-new-teammate) at the bottom.

---

## 1. What is WorkTrace?

A multi-module dashboard for tracking developer work. Right now there's one module live (**Timesheet** — a daily log of what you shipped, by project, written for non-technical readers). More modules coming.

The platform has two halves you should know about:
- **The dashboard** at `https://kjain-Cloudforia.github.io/worktrace-app/` — where you and the team *view* your data.
- **Your laptop's sync layer** at `~/Documents/DevPlatform/` — where you *generate* the data each day. Claude Code on your machine writes the timesheet entries; a `dpsync` command pushes them to GitHub.

You'll set up the dashboard side first (it's faster — 5 minutes) so you can confirm things work, then set up the laptop side (~20 minutes).

---

## 2. What admin gave you

The admin who onboarded you should have sent (via Slack DM / in person / similar — *not* email):
- Your **username** (a short lowercase slug, e.g. `kashish`)
- An **initial password** they chose for you
- The **dashboard URL** (`https://kjain-Cloudforia.github.io/worktrace-app/`)

If you're missing any of these, ping admin before continuing.

---

## 3. First sign-in (~2 minutes)

1. Open the dashboard URL.
2. Type your username and the initial password.
3. Click **Sign in**. The first sign-in takes about 2 seconds (your browser is deriving a key from your password — this is intentional, makes offline attacks slow).
4. You should land on the dashboard with one tile: **Timesheet**. It'll say *"No timesheet pushed yet. Run `dpsync` on your laptop."* — that's expected, we haven't set up the laptop side yet.

If sign-in fails: confirm with admin you have the exact password (case matters; the eye icon next to the field can help check what you typed).

---

## 4. Change your password (~1 minute)

The initial password admin gave you was chosen by them and might exist in their notes. Rotate it now to one only you know.

1. Click **Change password** in the top-right of the header.
2. Enter your current (initial) password.
3. Enter a new password twice.
   - Minimum 12 characters, at least one uppercase letter, at least one lowercase letter, at least one digit.
   - Pick something you can remember without writing down anywhere — a passphrase you'd type from memory.
4. Submit. You'll get signed out automatically. Sign in again with the new password to confirm it works.

> ⚠ **There is no "forgot password" for regular users.** If you lose this password, admin has to reset it for you (via the Admin Console — they have a recovery code that unlocks an escrow copy of your credentials). Possible, but you'll have to ask. So pick a password you'll remember.

---

## 5. Set up the laptop side (~20 minutes)

Now the actual work logging. You'll need:
- macOS or Linux (Windows works in principle but the shell hooks assume zsh)
- Python 3.10+
- Git
- [Claude Code](https://claude.com/claude-code) installed and signed in

### 5a. Clone your data repo

Admin should have created `<org>/worktrace-data-<your-username>` and added you as a collaborator with Write access. Accept the GitHub invitation if you haven't.

```bash
mkdir -p ~/Documents/DevPlatform
cd ~/Documents/DevPlatform
git clone git@github.com:<org>/worktrace-data-<your-username>.git sync
```

(If you don't have SSH set up with GitHub: use the HTTPS clone URL instead. The PAT below will handle authentication.)

### 5b. Get your PAT from admin

Admin generated a fine-grained GitHub PAT for you when they provisioned you. Ask them for the token string. It looks like `github_pat_11AB...` (40+ chars). Save it somewhere temporarily — you'll paste it into a config file in the next step.

### 5c. Create `config.json`

```bash
cd ~/Documents/DevPlatform
cat > config.json <<'EOF'
{
  "platform": {
    "user_id": "<your-username>",
    "display_name": "<Your Full Name>",
    "timezone": "Asia/Kolkata",
    "remote_data_repo": "git@github.com:<org>/worktrace-data-<your-username>.git",
    "github_token": "<paste your PAT here>",
    "auto_sync": false
  },
  "modules": {
    "timesheet": {
      "enabled": true,
      "work_hours": { "start": "14:00", "end": "05:00" },
      "headline_policy": "first-sentence-join"
    }
  }
}
EOF
chmod 600 config.json
```

Edit the placeholders to your actual values. The `chmod 600` is important — it makes the file readable only by your user account, since the PAT lives there in plaintext.

> If your work shift is different from `14:00 → 05:00 IST`, adjust the `work_hours` block. The Timesheet module buckets every entry by your shift window.

### 5d. Set up the shell hook (optional but recommended)

The shell hook auto-captures certain commands (Salesforce CLI deploys, etc.) so the Timesheet module has evidence of what you actually shipped. Skip if you don't use the Salesforce CLI.

```bash
cd ~/Documents/DevPlatform
# (admin will share shell-hook.zsh — copy it into this folder)
echo "source ~/Documents/DevPlatform/shell-hook.zsh" >> ~/.zshrc
source ~/.zshrc
```

### 5e. Tell Claude about your shift

Add this section to `~/.claude/CLAUDE.md` (create the file if it doesn't exist):

```markdown
# Personal config

## Work hours
- Work shift: **2 PM IST → 5 AM IST**.
- A single "work day" runs from 14:00 IST one calendar day to 05:00 IST the next.
- Use these IST shift boundaries for "today", "yesterday", "this week" — not UTC midnight or calendar-IST midnight.

## Shared timesheet
- Personal multi-project timesheet log lives at `~/Documents/DevPlatform/modules/timesheet/timesheet.md` (canonical, private to this laptop).
- Per-user config: `~/Documents/DevPlatform/config.json`.
```

Adjust the work-hours line if your shift is different.

### 5f. Smoke-test the sync

Make sure your local + remote line up:

```bash
cd ~/Documents/DevPlatform/sync
git pull
```

Should succeed silently. If it fails, your PAT might not have the right scope — ping admin.

### 5g. Run your first sync

(Once `dpsync.py` is available in `~/Documents/DevPlatform/` — admin will share it.)

```bash
cd ~/Documents/DevPlatform
python3 dpsync.py
```

This reads `modules/timesheet/timesheet.md`, generates a sanitized JSON summary, and pushes to your data repo. First-run output should mention "no changes" if you haven't started logging yet.

Refresh the dashboard — the Timesheet tile should now show whatever entries you've logged.

---

## 6. Daily workflow

Once everything is set up, your daily loop is:

1. **Work normally.** When you complete a deliverable (deploy, admin action, decision, finished investigation), tell Claude *"log today's work"* or similar. Claude appends a bullet to `~/Documents/DevPlatform/modules/timesheet/timesheet.md` under the appropriate work day + project header.
2. **At end of shift** (or whenever), run `python3 dpsync.py`. Your latest entries push to GitHub.
3. **Anyone with dashboard access** can see your entries by visiting the dashboard and signing in as themselves (everyone's data is fetched via their own PAT; admin's account also has read access to every data repo for the team roster view).

You can also ask Claude *"give me my status report for this week"* — it'll reconstruct everything you did from `timesheet.md` + Claude session JSONLs + the CLI command log, and present a consolidated report bucketed by IST shift days.

---

## 7. What if I forget my password?

Ping admin. They have a recovery code (24 chars, lives offline) that unlocks an escrow copy of your credentials. They'll set a new temporary password for you, send it out-of-band, and you change it on next login.

There's no email-based recovery and no self-service "forgot password" for regular users — by design, because the platform has no backend that could send recovery emails.

---

## 8. What if admin forgets their password?

Admin has their own recovery flow: the login screen has an **"Admin: forgot password?"** link that uses the recovery code to reset admin's password. If admin loses both the password AND the recovery code, there's a local Python fallback (`scripts/reset_admin.py`) that reads the admin PAT from `config.json`.

You as a regular user are unaffected by admin password issues — you can keep signing in normally.

---

## 9. Where to read more

| Question | File |
|---|---|
| How does the encryption work, exactly? | [`worktrace-auth/README.md`](https://github.com/kjain-Cloudforia/worktrace-auth/blob/main/README.md) |
| How do I add a new module to the dashboard? | [`worktrace-app/README.md`](./README.md) |
| What's the project history, what's shipped, what's next? | `~/Documents/DevPlatform/PROJECT_NOTES.md` (your local file) |
| What do the Python scripts in `scripts/` do? | `~/Documents/DevPlatform/scripts/README.md` |

---

## Admin: onboarding a new teammate

Walking a new teammate through the above takes ~30 min of their time. Your part takes ~5 min.

### Why YOU do all the GitHub setup (not them)

A common question: *"Can the new teammate just create their own data repo on their own GitHub account and share a PAT with me?"* Technically yes — the dashboard doesn't care whose account hosts the data repo, it just needs a working PAT. **But we recommend you create everything under your org, for four reasons:**

1. **Work-product ownership.** Daily timesheets and module data are billable-hours documentation owned by the firm. Keeping them in the firm's org means departing teammates can't take their history with them.
2. **Automatic admin read access.** Your admin PAT already has Read scope on every `<your-org>/worktrace-data-*` repo because you own the org. No per-user invitation dance. If teammates own their own repos, each one has to remember to invite you — and forget once means the Admin Console can't see them.
3. **Cleaner revocation.** When someone leaves, you delete or archive the repo in one click. If they own it, you have to *ask* them to delete it, and they might not.
4. **Less onboarding friction.** Doing it all yourself takes 5 minutes. Splitting the steps between you and the new teammate means more coordination, more places to drift, more "wait, did you do step 3?"

Treat user-owned repos as the *exception* (e.g. a contractor who insists), not the default. Nothing in the code prevents it — you just point `data_repo` at their repo path and use their PAT. But the default for full-time teammates should be org-owned.

### Pre-flight (GitHub, before you talk to them)

1. **Create their data repo:** `<org>/worktrace-data-<their-username>` — private, initialize with a tiny README, add them as collaborator with Write access.
2. **Generate a fine-grained PAT for them** under your account:
   - GitHub → Settings → Developer settings → Fine-grained tokens → Generate new
   - Name: `worktrace-<their-username>`
   - Resource owner: `<your org>`
   - Repository access: **Only select repositories** → `worktrace-data-<their-username>` + `worktrace-auth`
   - Permissions:
     - `worktrace-data-<their-username>` → Contents: Read + Write
     - `worktrace-auth` → Contents: Read + Write (so they can change their own password)
   - Expiration: 365 days (max)
   - Copy the token — you'll paste it into the dashboard once.

### In the dashboard

3. Sign in as admin → **Admin Console** tile → **+ Add team member**.
4. Fill the form:
   - Username, display name, data repo (auto-fills from username)
   - The PAT from step 2
   - An initial password you'll dictate to the user (memorable phrase, meets policy: 12+ chars, mixed case, digit)
   - Your recovery code (needed to build the escrow file)
5. Submit. The dashboard probes the PAT against the data repo, verifies your recovery code, encrypts the PAT under both the initial password and the recovery code, commits both files to `worktrace-auth`.
6. The success screen shows the initial password with a Copy button. Send it out-of-band.

### Hand-off

7. Send the new teammate:
   - Their username
   - The initial password (out-of-band — Slack DM, in person)
   - The dashboard URL
   - A link to this `ONBOARDING.md` for the laptop-side setup

8. Once they confirm they signed in, you're done.

If anything goes wrong (PAT doesn't work, repo doesn't exist, etc.), the dashboard surfaces a clear error before committing anything — no half-created users.
