# Supabase backend

## Structure

- `src/renderer.js` owns the interface and never talks to Supabase directly.
- `src/preload.js` exposes a small, validated IPC API.
- `src/main.js` owns the authenticated backend lifecycle and recording sync.
- `src/backend/supabase.js` contains Supabase Auth, encrypted token persistence, and database access.
- `supabase/migrations/` contains the versioned PostgreSQL schema and Row Level Security policies.

The desktop app uses the Supabase project URL and public/anonymous key. Those values are in `.env` for local development and are included in the packaged app so it can reach the configured project. The key is public by design; database access is protected by Auth and RLS. Never put `SUPABASE_SERVICE_ROLE_KEY` or `DATABASE_URL` in `.env`, the app, or an installer. Those are server-side credentials and are not needed by this client.

## Apply the database schema

In the Supabase SQL editor, run `supabase/migrations/202610290001_initial_recordings.sql`. It creates `recording_sessions` and `recording_events`, enables RLS, and restricts every operation to `auth.uid() = user_id`. Event rows also use a composite foreign key to prevent assigning an event to a session owned by another user.

For patient-file imports, also run `supabase/migrations/202611020001_patient_recording_metadata.sql`. It adds patient name, age, gender, recording date, import source, and import status to each owner-scoped recording session. Both migrations can be applied in filename order with `npm run db:migrate` when a trusted `DATABASE_URL` is supplied in the process environment; do not place that database credential in the desktop app's `.env`.

The app supports email/password sign-in and self-registration through Supabase Auth. Sign-up saves the doctor's name and phone number as Auth user metadata; the account button shows the doctor's name and opens an editable profile with name, email, and phone. In the Supabase dashboard, enable **Allow new users to sign up** in Auth settings and keep **Confirm email** enabled for normal use. When confirmation is required, the app asks the user to check their inbox and then return to sign in. Hosted Supabase's built-in email sender is limited to project team addresses; configure custom SMTP to deliver confirmation mail to other addresses. Password rules and abuse protections follow the Supabase project's Auth settings. Anyone who can access the app can request an account when public sign-ups are enabled; RLS still keeps each account's recordings private, but it does not verify that a registrant is a doctor. If registration must be restricted to approved clinicians, keep sign-ups disabled and use administrator-created accounts or add an approval/invitation workflow before production.

## Data flow

1. Incoming serial messages stay in memory until the doctor disconnects and chooses **Save recordings**. Closing the app before saving now asks before discarding them.
2. The save flow separates patient segments, stores each one locally in encrypted form, and uploads its metadata and ordered raw/parsed messages to the signed-in doctor's account.
3. Failed uploads stay encrypted on the computer and can be retried. A capture started under one signed-in account cannot be saved or synced under a different account.
4. The Recordings screen merges local sessions with that user's RLS-filtered cloud sessions. A cloud-only session can be reviewed and exported.

Patient imports require an active Supabase sign-in. The importer supports line-oriented text/CSV and the app's own exported CSV. Each detected patient is saved as an independent recording session and a date-folder CSV under the local recordings directory; patient metadata and ordered raw events sync to that signed-in account. Imported local sessions are shown and opened only when their `cloudOwnerId` matches the current account. In app exports, a repeated `date_header` after measurements starts a new segment (even when the device date repeats); a matching date marker directly after a compact demographics header remains attached to that patient. A newer demographic header replaces an earlier one if no measurements have started. A preview lets the doctor correct date, name, age, and gender before the import is committed. Patient cards offer separate raw-recording and graph actions.

Supabase Auth refresh tokens and local patient recording files are protected through Electron `safeStorage`; the renderer never receives the Supabase client or credentials. The service-role key is never used. Legacy local recording files are encrypted on app startup. A CSV the doctor explicitly exports remains a readable file so it can be used outside the app.

## Run and package

Keep only these variables in the project `.env`:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-publishable-or-anon-key
```

Install and run with `npm install` and `npm start`; run the regression suite with `npm test`. `npm run package:win` bundles `.env`, so verify it contains only the project URL and public key before producing an installer. Apply the SQL migration before signing in or syncing. A live Supabase sign-in and RLS test is still required against the connected project before deployment.

## Current boundary

This is an offline-capable desktop client with optional Supabase sync, not a separate server process. RLS scopes cloud records to the authenticated doctor. Local saved recordings are encrypted for the current Windows user; exports intentionally remain readable. Define retention, backup, audit, and deployment requirements before using identifiable patient data in production, and verify Windows account and device access controls at each deployment site.
