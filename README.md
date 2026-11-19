# Class Library

Shared-tablet class library on one Cloudflare Worker: static kiosk + admin pages, JSON API, D1 for data, R2 for cover images.

- `/` is the **kiosk** for the classroom tablet (scan, tap name, tap emoji, done).
- `/admin` is the **teacher page** (needs attention, dashboard, books, pupils, reports, kiosk link and PINs; supervisors also get All classes and Teachers).
- `/guide/` is the **user guide** with screenshots (PDF copy shipped alongside).

## Deploy (about 10 minutes)

```bash
npm install
npx wrangler login

# 1. Create the database and storage
npx wrangler d1 create class-library          # copy the database_id into wrangler.jsonc
npx wrangler r2 bucket create class-library-covers

# 2. Create the tables
npx wrangler d1 migrations apply class-library --remote   # applies 0001 and 0002 (v1.1)

# 3. Secrets
npx wrangler secret put ADMIN_KEY             # a long random string; this is your admin password
npx wrangler secret put GOOGLE_BOOKS_KEY      # optional: free key from Google Cloud raises the 1,000/day lookup limit

# 4. Ship it
npx wrangler deploy
```

Then:

1. Open `https://<your-worker>.workers.dev/admin` and sign in with `ADMIN_KEY`.
2. **+ New class**, then **Kiosk & PINs**: set the librarian PIN and the teacher PIN.
3. **Pupils**: paste names, one per line.
4. **Books**: scan to add, type an ISBN, or import an Excel sheet.
5. Open the **kiosk link** (Kiosk & PINs tab) once on the tablet, then Add to Home Screen. Turn on Guided Access (iPad) or screen pinning (Android) so pupils stay in the app.

Local development: `npx wrangler d1 migrations apply class-library --local` then `npx wrangler dev --var ADMIN_KEY:test`.

## How the rules work

| Rule | Behaviour |
| --- | --- |
| Limit | 3 books out at once (per class setting); lost books do not count |
| Overdue | Borrow blocked if any open book is past its 14-day due date |
| Returns | Never blocked; a return is processed before a borrow in the same sync |
| Block screen | Pupils see only "Please see your teacher". Teacher PIN approves an override, which is logged |
| Duplicates | A pupil cannot hold two copies of one title; copies are interchangeable |
| Offline | Actions save on the tablet and sync later; repeats are ignored by ID |
| Lost / found | Admin marks a loan lost (keeps the borrower), and found restores it |

## Teacher sign-in with Cloudflare Access (v1.1)

1. Zero Trust dashboard → Access → Applications → add a **self-hosted** app covering `<your-worker>/admin*` and `<your-worker>/api/admin*`. Policy: allow the teachers' emails (one-time PIN).
2. Leave `/`, `/api/kiosk/*`, `/api/cover/*` and `/guide/*` **outside** Access, or the kiosk stops working.
3. Secrets: `npx wrangler secret put ACCESS_TEAM_DOMAIN` (e.g. `myteam.cloudflareaccess.com`), `ACCESS_AUD` (the app's Audience tag), and optionally `SUPERADMIN_EMAILS` (comma-separated).
4. `ADMIN_KEY` still works as a break-glass supervisor login.
5. Supervisor → **Teachers** tab: add an email and tick the classes they may manage. Unregistered emails are refused.

## Changelog v1.1

Letter jump bar, My books, streaks and badges, suggestions, needs-attention home, inline book editing, per-teacher accounts, supervisor views, plain-language librarian log, user guide.

## Known limits of this build

- **Cloudflare Access sign-in was tested only against a mock signed token**, not real Cloudflare. Test with one teacher account before relying on it.
- **Badges trust the pupil's own "finished" tick**, softened by the 24-hour rule. Suggestions are heuristic and weak with few ratings.
- **The student librarian screen is minimal**: view problems, sync, undo last borrow. It cannot delete or export.
- **PIN brute force** is only slowed (0.8 s per wrong try). Use 6+ digit PINs.
- **The kiosk token lives on the tablet.** Anyone with the link can use the kiosk API for that class, so revoke it under Kiosk & PINs if the link leaks or the tablet goes missing.
- **Lookups need internet from Cloudflare.** Titles with no Google Books or Open Library match are saved with whatever you typed; add a title or a photo from the catalogue list.
- **Test the scanner on your real tablet** with 20 books before relying on it.
- No pupil photos or free-text responses are stored. The year-end **Archive class** button deletes all pupil names, loans and responses for that class.
