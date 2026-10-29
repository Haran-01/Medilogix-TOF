# Medilogix TOF

Windows desktop application for discovering the instrument's USB serial port, displaying incoming messages, and saving local recording sessions.

## Current phase

- Uses the desktop USB serial picker to discover devices on demand; COM12 is never assumed.
- Includes a sample replay mode so the live monitor and recording/export flow can be explored without the instrument.
- Starts a local recording when a port is opened and retains each incoming line with its receive time, order, parsed fields, and original text.
- Marks incomplete lines and interruptions so they remain visible in saved data.
- Lists previous sessions, opens saved raw messages, shows a provisional reference-style chart, and exports a chosen session as CSV.
- Keeps local session IDs separate from unverified device date strings. See the [recordings and visualization plan](docs/recordings-and-visualization-plan.md), [visualization requirements](docs/visualization-requirements.md), and saved [graph reference](docs/references/visualization-reference.png).

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

The selected baud rate defaults to 115200 to match the current serial-monitor setup. When you connect, choose the instrument from the detected USB serial devices. The application currently uses 8 data bits, no parity, and 1 stop bit. The user has confirmed that the instrument connects successfully. It is receive-only and does not send commands to the instrument.

Without the instrument, choose **Try sample data** on the Live monitor screen. The app replays the supplied sample into a visibly marked demo session. You can watch the lines arrive, disconnect early, then find the saved demo under **Recordings** and export it as CSV. Demo readings are simulated and are not a live device connection.

To create a Windows installer:

```powershell
npm run package:win
```

The installer is written to `release/`. Serial sessions are stored in the Electron application data folder, under `recordings/`; use **Open recordings folder** in the app to locate them. Each session includes `session.json` metadata and `records.jsonl` captured messages. CSV export is available from the Recordings screen.

## Protocol status

The parser preserves every raw message and currently labels common TOF ratio, TOF count, PTC count, mode, and date-header patterns as **provisional**. Confirm these patterns, timestamps, and device-specific line settings against the instrument before relying on interpreted fields or adding clinical trend labels. Raw capture remains available for messages the parser cannot identify.
