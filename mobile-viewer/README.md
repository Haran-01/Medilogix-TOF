# MedilogiX Recordings (mobile web viewer)

This is a separate, browser-based viewer for phones and tablets. It is intentionally excluded from the Windows Electron installer. The page is named **Recordings** and provides account sign-in, date folders, patient details, measurement graphs, and received readings. It does not create, edit, delete, or upload recordings.

## Build

From the project root, run:

```sh
npm run build:mobile
```

The static site is generated in `release/mobile-viewer`. The build reads `SUPABASE_URL` and `SUPABASE_ANON_KEY` from the environment, falling back to the root `.env` for local builds. It never reads or packages a database password or service-role key. The anonymous key is a public client key. Every data request uses the signed-in user's access token and relies on the existing authenticated row-level security policies.

## Publish

Publish the *contents* of `release/mobile-viewer` to a static web host that serves HTTPS. Configure that site's HTTPS URL in the Supabase project's allowed redirect/site URLs if needed for account email flows. The viewer uses password sign-in only, so users need an existing account in the same project as the desktop application. Share the HTTPS address with users; they can add it to their phone home screen through the browser menu.

The viewer keeps its short-lived login session in the current browser tab's session storage and clears it on sign-out. It does not cache patient records for offline use.
