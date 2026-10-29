# Recordings and visualization implementation plan

## Status

The user confirmed on 2026-10-29 that the application connects successfully to the actual instrument. The app already records locally, lists sessions, reviews raw messages, draws a provisional reference-style graph, and exports CSV. The supplied sample exercises the parser automatically with `npm test`. The next device validation is to capture a short real session, review the saved raw messages and parsed types, and export it. A successful port connection alone does not confirm message semantics, date/time meaning, or clinical graph mapping.

Keep the app local-only for this phase. Doctor accounts and shared/server storage require an authentication provider, backend ownership enforcement, and deployment/privacy requirements; a local profile selector would not provide secure per-doctor access control.

## Storage model for the current desktop application

- Treat each capture as one uniquely identified recording session. Keep the application-generated session ID as its stable identity.
- Keep every received line in sequence with its raw text, receive time, parsed fields, and parse status. Keep mode markers and date headers as events.
- Use the device's first date header as source metadata only. Do not use unverified device text as a physical folder name or as a unique key: its date format is not confirmed, headers can repeat, and two captures can have identical device timestamps.
- The current offline app has no doctor sign-in or server database. Keep recordings local for now and let the clinician explicitly export them. Add a local database only when search/scale needs justify the migration; SQLite is a good fit for a single-computer offline app.
- If the product later needs multiple doctors or devices to share records, choose the identity provider and server first, then enforce ownership in the backend (for example, per-user access policies). A UI-only doctor filter is not access control. Do not upload patient data until hosting, authentication, backup, and access-control choices are defined.
- Do not create one file per serial line. A recording session is the logical folder/group; the ordered raw events are its records. This avoids file clutter and preserves partial or malformed messages.

## Work that can proceed now

1. Add a recording review view that loads the original saved events and shows their raw and parsed values.
2. Build the reference-style trend as a dynamic chart from stored events, keeping TOFR, TOFC, and PTC distinct and retaining the raw source values.
3. Mark the chart's date and clinical interpretation provisional until the device protocol and chart mapping are confirmed. Never infer a patient result from the sample replay.
4. Exercise browsing, replay, rendering, and export with the supplied sample.

## Instrument validation before relying on the chart

Confirm serial settings, newline framing, date order, whether device times are hours/minutes, clock rollover, header meaning, and the meanings of `T`, `P`, `C`, and bare numeric values. Verify chart positions and threshold boundaries with known device readings. Keep the receive-time timestamp (UTC) separately from the device-supplied timestamp.

## Privacy and clinical scope

The app is a local data-capture and review tool. The chart and parser are exploratory until verified against the actual device protocol and intended clinical specification. Add patient identifiers only when necessary, and define account, retention, audit, backup, and deployment requirements before production use with identifiable patient data.
