# Welcome to WorkTrace

You've been added to the team. This page is the **teammate-facing** overview — what WorkTrace is, what your daily flow will look like, and how the system protects your data.

For the actual laptop setup steps + the install command, see [**`worktrace-cli/NEW-TEAMMATE.md`**](https://github.com/kjain-Cloudforia/worktrace-cli/blob/main/NEW-TEAMMATE.md). That's the single source of truth for onboarding.

---

## What is WorkTrace?

A multi-module dashboard for tracking developer work across a small team. Right now there's one module live (**Timesheet** — a daily log of what you shipped, by project, written for a non-technical reader). More modules can be added without changing the shell.

Two halves of the system you'll touch:
- **The dashboard** at `https://kjain-Cloudforia.github.io/worktrace-app/` — where you and the team *view* the consolidated data.
- **Your laptop** at `~/Documents/DevPlatform/` — where you *generate* the data each day. Claude Code on your machine writes the timesheet entries; an auto-sync command pushes them to GitHub once per shift.

You don't need to learn how the architecture works to use it. If you're curious, the [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md) walks through the same ideas in plain language for non-technical readers.

---

## What admin gave you (or will give you)

Three values, delivered out-of-band (Slack DM / in person / Signal — **not email**):

1. Your **username** — a short lowercase slug like `xyz`. This is your sign-in identity.
2. Your **initial password** — admin chose this. You'll rotate it on first dashboard sign-in.
3. Your **GitHub PAT** — a long `github_pat_...` string. The install script pastes it in once; you don't need to remember it.

Plus a link to the dashboard: `https://kjain-Cloudforia.github.io/worktrace-app/`.

If you're missing any of these, ping admin before continuing.

---

## Setting up your laptop

**One paste in Terminal:**

```bash
curl -fsSL https://raw.githubusercontent.com/kjain-Cloudforia/worktrace-cli/main/install.sh | bash
```

It'll ask you for your **username** and your **PAT** — everything else (display name, timezone, shift hours, data repo URL) is auto-discovered from the WorkTrace account admin already provisioned for you.

Step-by-step details + troubleshooting are in **[`NEW-TEAMMATE.md`](https://github.com/kjain-Cloudforia/worktrace-cli/blob/main/NEW-TEAMMATE.md)**.

After the script finishes:
1. Open https://kjain-Cloudforia.github.io/worktrace-app/
2. Sign in with your username + the initial password admin gave you
3. Click **Change password** in the header → set a real password you'll remember

You're done. Total time: ~5 minutes including the password rotation.

> ⚠ **There's no "forgot password" self-service for regular users.** Admin has a recovery code that can reset your password if you lose it (~30 seconds via the dashboard). But pick a password you'll remember; this isn't a system where you can spam reset emails.

---

## Your daily flow

Once your laptop is set up, this is what happens:

```
Morning — you open Claude Code (any project workspace, not just DevPlatform)
   │
   │ First message of the day → auto-sync fires once:
   │   • Pulls latest CLAUDE.md rules from worktrace-cli (any updates admin pushed)
   │   • Pulls work_shift changes from the dashboard (if admin edited yours)
   │   • Pushes your previous-day timesheet to GitHub
   ▼
   "✓ Auto-synced WorkTrace at 09:00 America/Los_Angeles" appears in Claude's reply
   │
   ▼
You work normally — code, deploys, admin tasks, conversations
   │
   ▼
When you ship something deliverable, tell Claude:
   "log today's work — <what you did>"
   │
   ▼
Claude appends a bullet to your local ~/Documents/DevPlatform/modules/timesheet/timesheet.md
   under today's work-day section + the current project's sub-header
```

At the end of your shift (or whenever), ask Claude:

> *"Give me my status report for this week"*

Claude reads your timesheet, your Claude session history, and your CLI command log; reconstructs anything you didn't explicitly log; presents a consolidated report bucketed by your shift days; auto-appends the reconstructions to your timesheet.md; and asks **"Sync this to GitHub now?"** with a Yes/No prompt. Click Yes → dashboard reflects within seconds.

---

## Where things go

| Action | Lives on your laptop | Lives in your private GitHub data repo | Lives on the public dashboard |
|---|---|---|---|
| Your timesheet bullets | `~/Documents/DevPlatform/modules/timesheet/timesheet.md` | `modules/timesheet/data.json` (after push) | Rendered from the data.json |
| Your PAT | `~/Documents/DevPlatform/config.json` (chmod 600) | — | Encrypted under your password in worktrace-auth |
| Your work shift | `~/Documents/DevPlatform/config.json` | — | On `worktrace-auth/users/<you>.json` |
| Your password | **In your head only** | — | — |

Nothing of yours is shared with teammates by default. The dashboard shows your data when you sign in as yourself. Admin has read access to everyone's data repos for the team-roster view, but no one else does.

---

## What if I forget my password?

Ping admin. They open the Admin Console → click **Reset password** on your row → paste their recovery code + a new temporary password. You sign in with the temp password, rotate it. Takes ~30 seconds on their end.

There's no self-service "forgot password" link for regular users by design — the system has no backend that could send recovery emails. Admin is your recovery path.

For admin's own "forgot password", they have a recovery code (24-char Crockford-base32 string) stored offline. The dashboard's login screen has an "Admin: forgot password?" link that takes the code and resets the admin password.

---

## What if admin's processes change?

They edit the canonical `CLAUDE.shared.md` in [worktrace-cli](https://github.com/kjain-Cloudforia/worktrace-cli), commit, push. Your **next shift-start auto-sync** pulls the change and re-injects it into your `~/.claude/CLAUDE.md` between the managed-block markers. Your **next Claude session** uses the new rule.

You don't need to do anything. Updates propagate automatically.

If you want **permanent personal overrides** (e.g. "always remind me to commit before logging work" or "I prefer dense prose over bullets"), add them to `~/.claude/CLAUDE.md` OUTSIDE the managed-block markers. Anything outside is yours forever — the sync never touches it.

---

## Where to read more

| Topic | File |
|---|---|
| **Full new-teammate onboarding playbook (admin + your part)** | [`worktrace-cli/NEW-TEAMMATE.md`](https://github.com/kjain-Cloudforia/worktrace-cli/blob/main/NEW-TEAMMATE.md) |
| Plain-language tour for non-tech readers | [`HOW-IT-WORKS.md`](./HOW-IT-WORKS.md) |
| Platform architecture + module contract | [`README.md`](./README.md) |
| Encryption + recovery design | [`worktrace-auth/README.md`](https://github.com/kjain-Cloudforia/worktrace-auth/blob/main/README.md) |
| Admin operations (create / reset / revoke users) | [`worktrace-auth/CONTRIBUTING.md`](https://github.com/kjain-Cloudforia/worktrace-auth/blob/main/CONTRIBUTING.md) |
