# Timesheet Management

A single-file web app for uploading, analyzing and managing weekly employee timesheets. Data is stored in a shared Supabase (Postgres) database, so anyone with the link sees the same data.

## Hosting on GitHub Pages

1. Create a new GitHub repository and upload **`index.html`** from this folder to its root (or push this whole folder as the repo contents).
2. In the repo, go to **Settings → Pages** → under "Build and deployment", set Source to **Deploy from a branch**, branch `main`, folder `/ (root)` → Save.
3. GitHub gives you a URL like `https://<username>.github.io/<repo>/` within a minute or two — share that link.

## Login

- Admin: `admin` / `admin`
- Viewer (read-only): `viewer` / `viewer`

Change both passwords from **Settings → Users** after your first login.

## Data storage

All app data (users, settings, uploads, timesheet records, task merges) lives in a shared Supabase project, not in the browser — so it's the same for every visitor and persists across devices, browser clears, and future updates to this file. An Admin can delete data by week, by upload, or entirely from **Settings → Data** / **Upload History**.

## Notes

- Requires an internet connection (loads charting/spreadsheet libraries and talks to the Supabase database).
- This is a static file with a public database key — the database has been set up for open read/write for everyone with the link, matching a shared internal tool. Don't put sensitive data you wouldn't want a link-holder to see/edit.
