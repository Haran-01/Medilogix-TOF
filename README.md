# Medilogix TOF

Windows desktop application for discovering the instrument's USB serial port, displaying incoming messages, and saving patient recordings.

## Current phase

- Uses the desktop USB serial picker to discover devices on demand; COM12 is never assumed.
- Includes a sample replay mode so the live monitor and recording/export flow can be explored without the instrument.
- Buffers each incoming line in memory with its receive time, order, parsed fields, and original text; nothing is saved until the user disconnects and selects **Save recordings**.
- On save, splits the complete capture into patient recordings using the same parser and review form as imported files. Incomplete lines and interruptions remain visible in the capture.
- Lists previous sessions, opens saved raw messages, shows a provisional time-aligned chart with stacked native-value regions for TOFR, TOFC, and PTC and metric-colored chronological connecting segments, and exports a chosen session as CSV.
- Imports multi-patient text/CSV files, previews separated patient headers for correction, and stores each patient's messages and chart independently under the signed-in doctor's account.
- Keeps local session IDs separate from device date strings. Live readings stay in memory until the doctor chooses **Save recordings**; saved local files are encrypted for the current Windows user and signed-in recordings sync under that account. See the [backend setup](docs/backend-and-supabase.md), [recordings and visualization plan](docs/recordings-and-visualization-plan.md), [visualization requirements](docs/visualization-requirements.md), and saved [graph reference](docs/references/visualization-reference.png).

## Run on Windows

Install a supported Node.js release, then from the project folder run:

```powershell
npm install
npm start
```

Run the protocol regression checks with:

```powershell
npm test
```

The selected baud rate defaults to 115200 to match the current serial-monitor setup. When you connect, choose the instrument from the detected USB serial devices. The application currently uses 8 data bits, no parity, and 1 stop bit. The user has confirmed that the instrument connects successfully. It is receive-only and does not send commands to the instrument. Disconnect after capturing the desired data, select **Save recordings**, review each detected patient's details, then save. The unsaved capture exists only in memory and is lost if the app closes before saving. Sign in or create an account to save patient recordings to the signed-in doctor's account. Public email/password sign-ups must be enabled in Supabase Auth settings.

Without the instrument, choose **Try sample data** on the Live monitor screen. The app replays the supplied sample into a visibly marked demo capture. Watch the lines arrive, then choose **Save recordings** after replay ends and review the patient details before storing it. Demo readings are simulated and are not a live device connection.

To create a Windows installer:

```powershell
npm run package:win
```

The installer is written to `release/`. Serial sessions are stored in the Electron application data folder, under `recordings/`; use **Open recordings folder** in the app to locate them. Each session includes `session.json` metadata and `records.jsonl` captured messages. Signed-in sessions are also synchronized to the configured Supabase project. CSV export is available from the Recordings screen.

## Protocol status

The parser preserves every raw message and currently labels common TOF ratio, TOF count, PTC count, mode, and date-header patterns as **provisional**. Confirm these patterns, timestamps, and device-specific line settings against the instrument before relying on interpreted fields or adding clinical trend labels. Raw capture remains available for messages the parser cannot identify.
