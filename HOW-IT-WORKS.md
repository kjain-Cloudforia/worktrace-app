# How WorkTrace works — a plain-language tour

*For non-technical readers. No code, no jargon, just the ideas.*

WorkTrace is the dashboard at `https://kjain-Cloudforia.github.io/worktrace-app/`. It shows what each teammate has been working on — what they shipped, when, and on which project. This document explains what's happening underneath when you sign in and see your data.

---

## The big idea: three lockers in a hallway

Imagine three lockers:

1. **The "code" locker.** Has the dashboard's instructions (HTML and JavaScript). **Open to anyone.** Anyone in the world can grab the code and run it in their browser. There's nothing sensitive here — it's just instructions, like a recipe book.

2. **The "sealed envelopes" locker.** Has one sealed, locked envelope per teammate. **Also open to anyone.** People can take the envelopes off the shelf and stare at them all day, but every envelope is locked. Without the right key, they're useless.

3. **The "private files" lockers** — one per teammate. **Private — only that teammate can open theirs**, plus the admin (the team lead).

The clever trick is that **two of the three lockers are completely public**. We didn't have to build a server or pay for hosting a backend, because anything sensitive is already locked inside an envelope *before* it goes into the public locker. The locks do the protection, not the building.

---

## What happens when you sign in

Say you type your username `kashish` and your password `MyStrongPassword123!`, and hit "Sign in." Behind the scenes, in about two seconds:

1. Your browser walks to the **"sealed envelopes" locker** (public) and grabs the envelope labeled `kashish`. Anyone could do this — but only you have what's needed to open it.

2. Your browser takes your password and runs it through a deliberate **slow-math process** for about 2 seconds. This produces a digital key. (More on why this is slow in a moment.)

3. Your browser uses that key to **unlock the envelope**. Inside is a slip of paper: a **GitHub access token**. This is the actual credential — the thing GitHub recognizes as "yes, this person is allowed to read kashish's private files."

4. Your browser uses that token to walk to **your private-files locker** and grab your actual work data — your Timesheet entries.

5. Your dashboard fills with your data.

**Your password never leaves your browser.** It only exists in your computer's memory for the few seconds it takes to do the slow-math and unlock the envelope. The dashboard doesn't send your password to any server. It doesn't have to — the unlocking happens entirely on your own machine.

---

## What's the "2-second slow-math"?

This is the most important security idea. It's also the one that sounds magical until you see it.

The problem we're solving: passwords are short. They're meant to be memorable — like `MyStrongPassword123!` — which means a bad guy with a fast computer could try millions of password guesses per second. That'd be terrible. Even strong-feeling passwords would crack quickly.

So we **deliberately make the unlock process slow.** The math goes like this:

> Take your password. Scramble it. Take the scrambled result, scramble it again. Repeat **600,000 times in a row**, where each step's output feeds into the next step. The number you end up with after the 600,000th round is your key.

**The crucial thing:** you can't skip ahead. To know the result of step 600,000, you have to do steps 1 through 599,999 first. The math is sequential — there's no shortcut. It's like simmering a stew: a recipe that says "stir 600,000 times over 2 hours" can't be done in the microwave. The chemistry has to happen step by step.

**Why this is the defense:**

| Person | How many times they do the math | Total time |
|---|---|---|
| **You** signing in once | 1 time | 2 seconds (fine) |
| **A bad guy** trying to guess 1 billion passwords | 1 billion times | ~63 years on a fast computer |

That's the whole defense. **Two seconds is a tiny price for you, once a day.** **Two billion seconds is a gigantic cost for anyone trying to break in.**

There's one more clever bit. Each teammate's envelope has its own random "spice" mixed into the math (we call this a **salt**). So even if two teammates happen to pick the same password by coincidence — say both pick `Summer2026!` — their final keys come out completely different. An attacker can't compute one giant cheat-sheet that cracks everyone; they have to start over from scratch for each person.

---

## Your daily routine

On your laptop, in a folder called `~/Documents/DevPlatform/`, there's a plain text file called `timesheet.md`. Each day, you (with help from your AI assistant) write a short paragraph or a few bullet points: *what did I ship today, on which project, what changed and why?*

When you're ready, you run a small command called `dpsync` in your terminal. It does three things:

1. Reads your `timesheet.md`.
2. Builds a sanitized summary in a structured format the dashboard understands.
3. Uploads that summary to your private-files locker on GitHub.

That's the whole loop:

```
You work → AI writes to timesheet.md → dpsync uploads → Dashboard shows it
```

Nothing is shared until you run `dpsync`. The dashboard literally cannot show data you haven't pushed. If you forget to run `dpsync` for a week, your dashboard tile will look the same as it did a week ago — your private locker hasn't received an update.

---

## What if I forget my password?

This is where the **recovery code** comes in. The admin keeps a 24-character code (something like `WV8K-VXH7-QY8C-T5TY-W41G-E79Z`) stored offline — in 1Password, on paper, somewhere safe.

When the system was set up, we built a **second sealed envelope for each teammate.** Same contents (the GitHub access token), but this envelope is locked with the recovery code instead of the user's password. We call these "escrow" envelopes.

So if you forget your password:

1. You ping the admin.
2. Admin opens the Admin Console on the dashboard, clicks "Reset password" on your row.
3. Admin pastes the recovery code and picks a temporary password for you.
4. The dashboard uses the recovery code to open your *escrow envelope* (the second one), grabs the GitHub token inside, and re-locks it inside a brand new envelope using your temporary password.
5. Admin sends you the temporary password (in person or via Slack), you sign in, and you change it to a real one you'll remember.

**The two envelopes are completely independent.** Admin's flow never sees your password. Your daily sign-in never sees the recovery code. They just both end up at the same GitHub token, through different doors.

---

## What if the admin forgets THEIR password?

Same trick. There's a third locked envelope (`admin.recovery.json`) that contains **admin's** GitHub token, locked with the same recovery code.

The login screen has a small "Admin: forgot password?" link. Admin pastes the recovery code, picks a new password, and they're back in.

If admin loses *both* the password AND the recovery code, there's a last-resort script on the laptop that reads admin's GitHub token directly from a local config file (where it's stored in plain text, on the laptop only). That rebuilds the admin envelope from scratch. It only works if the laptop itself is still around.

---

## Why is it safe even though the envelopes are in a public locker?

Three reasons stacked on top of each other:

1. **The 2-second slow-math.** Doing the unlock-math takes 2 seconds for one password. Doing it a billion times takes 63 years. Even with custom hardware that's a thousand times faster, breaking a strong password would take longer than most companies exist.

2. **The salt — each envelope has its own random spice.** An attacker can't compute one giant cheat-sheet for the whole team. Each envelope is its own separate attack target.

3. **The lock itself (AES-GCM) is what banks use** for credit-card transactions, what messaging apps use to encrypt your texts, and what every major company uses to protect data at rest. If it broke tomorrow, the entire internet would have bigger problems than your timesheet.

For these defenses to fail at the same time, the laws of mathematics would have to change.

---

## The big picture

```
Your password (only in your head)
       │
       │ 2 seconds of slow-math, done by your browser
       ▼
The envelope unlocks → a GitHub token appears (only in your browser)
       │
       │ used to fetch your private data
       ▼
Your dashboard fills with your work entries

       Separately, for emergencies:

The recovery code (only in 1Password / offline storage)
       │
       │ admin pastes it once when something goes wrong
       ▼
Either:
  ▸ Opens admin's recovery envelope → admin can set a new admin password
  ▸ Opens any user's escrow envelope → admin can hand that user a fresh password
```

The password is for **daily life.** The recovery code is for **emergencies.** They unlock different envelopes, but both eventually get you to the same kind of GitHub token inside.

That's the whole system.

---

## A few things you'll never see

For completeness, here are some things WorkTrace **doesn't** do — partly because we don't need them, partly because they'd be worse:

- **It doesn't send your password anywhere.** No server receives it, no log records it, no API call mentions it. Your password is yours, used by your browser, then gone from memory.
- **It doesn't send password-reset emails.** There's no email server in the system. Recovery happens entirely through the recovery code, which admin holds offline.
- **It doesn't keep a "session cookie" between visits.** When you close the dashboard tab, your unlocked token disappears. Next time you open the dashboard, you sign in again — fast (about 2 seconds), but real, every time.
- **It doesn't trust a central server with your data.** Each teammate's data lives in their own private GitHub repo, scoped to a token that only they (and admin) can use. There's no big shared database that a single breach could expose.

---

## Glossary

| Term | What it means in this document |
|---|---|
| **Sealed envelope** | An encrypted file. Looks like random gibberish until unlocked. |
| **GitHub token** | A digital pass that proves "I'm allowed to read these files on GitHub." The thing inside every envelope. |
| **Slow-math** | A deliberately slow calculation that turns a password into a digital key. Slow on purpose, to defeat brute-force attackers. (Technical name: PBKDF2.) |
| **Salt** | A small random number unique to each teammate, mixed into the slow-math so two people with the same password end up with different keys. |
| **Lock (AES-GCM)** | The actual encryption algorithm sealing the envelopes. Industry standard; used by banks and messaging apps. |
| **Recovery code** | A 24-character emergency code held offline by admin. Unlocks the special "escrow" envelopes for resetting forgotten passwords. |
| **Escrow envelope** | A backup-copy envelope holding the same GitHub token, but locked with the recovery code instead of the user's password. |

---

*If you have questions about this, ask Kashish.*
