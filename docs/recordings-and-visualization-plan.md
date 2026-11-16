# Recordings and visualization implementation plan

## Status

The user confirmed on 2026-10-29 that the application connects successfully to the actual instrument. The app records locally, lists sessions, reviews raw messages, draws a provisional time-aligned graph with stacked native-value regions for TOFR, TOFC, and PTC, and exports CSV. Supabase Auth and an RLS-protected cloud schema now provide an optional sync path for recordings begun while signed in. The supplied sample exercises the parser automatically with `npm test`. A successful port connection alone does not confirm message semantics or date/time meaning.

Cloud records are owned by the authenticated Supabase user, enforced by database policies rather than UI filters. Keep local capture available when cloud services are unavailable. Before production use, apply and test the migration, validate live sync and RLS with two accounts, and define privacy, backup, retention, audit, and deployment requirements.

## Storage model for the current desktop application

- Treat each capture as one uniquely identified recording session. Keep the application-generated session ID as its stable identity.
- Keep every received line in sequence with its raw text, receive time, parsed fields, and parse status. Keep mode markers and date headers as events.
- Use the device's first date header as source metadata only. Do not use unverified device text as a physical folder name or as a unique key: its date format is not confirmed, headers can repeat, and two captures can have identical device timestamps.
- The current offline app has no doctor sign-in or server database. Keep recordings local for now and let the clinician explicitly export them. Add a local database only when search/scale needs justify the migration; SQLite is a good fit for a single-computer offline app.
- If the product later needs multiple doctors or devices to share records, choose the identity provider and server first, then enforce ownership in the backend (for example, per-user access policies). A UI-only doctor filter is not access control. Do not upload patient data until hosting, authentication, backup, and access-control choices are defined.
- Do not create one file per serial line. A recording session is the logical folder/group; the ordered raw events are its records. This avoids file clutter and preserves partial or malformed messages.

## Work that can proceed now

1. Add a recording review view that loads the original saved events and shows their raw and parsed values.
2. Build the time-aligned graph as a dynamic chart from stored events. Share a horizontal device-time axis across three stacked regions, each with its native vertical value scale (TOFR %, TOFC count, PTC count). Connect successive points chronologically with line segments and markers colored by metric. Preserve raw values and denominators; break the line at explicit date/session headers.
3. Mark the chart's date interpretation provisional until device time is confirmed. Do not combine the metrics into a clinical score or infer a patient result from the sample replay.
4. Exercise browsing, replay, rendering, and export with the supplied sample.

## Instrument validation before relying on the chart

Confirm serial settings, newline framing, date order, whether device times are hours/minutes, clock rollover, header meaning, and the meanings of `T`, `P`, `C`, and bare numeric values. Verify chart positions and threshold boundaries with known device readings. Keep the receive-time timestamp (UTC) separately from the device-supplied timestamp.

## Privacy and clinical scope

The app is a local data-capture and review tool. The chart and parser are exploratory until verified against the actual device protocol and intended clinical specification. Add patient identifiers only when necessary, and define account, retention, audit, backup, and deployment requirements before production use with identifiable patient data.

Imported multi-patient files are split into independently owned sessions after a review step. A repeated app-export `date_header` after measurements starts a new segment even when its date matches the prior segment; a same-date device marker immediately following a compact patient-demographics header stays attached to that patient. If another demographic header arrives before measurements, the newer header replaces the incomplete one. The app keeps imported patient files grouped under a date folder and plots only after the doctor chooses that patient's graph action.
