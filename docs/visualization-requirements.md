# Visualization reference and serial protocol notes

Recorded: 2026-10-25.

## User requirement

Build a professional application with a simple interface for the project's USB serial instrument. First establish reliable connection and recording; visualization comes later. The supplied image is the original visual reference; the user's current chart direction below supersedes its combined severity-axis layout.

- Visual reference: [reference image](references/visualization-reference.png).
- Original sample, copied without editing: [device sample](references/device-sample.csv).
- The instrument currently appears as USB Serial Device (COM12); discover ports dynamically rather than assuming COM12.
- Screenshot of the existing serial monitor showed 115200 baud. Other connection parameters require confirmation.

## Current chart direction

On 2026-10-31, the user clarified the current layout using two examples: a shared horizontal time axis, with three vertically stacked metric regions (TOFR at top, TOFC in the middle, PTC at the bottom), each with its own native vertical value scale. Plot each observation in its metric region, then connect successive observations in chronological order across metric-region boundaries. Color points and connecting intervals by metric (green TOFR, yellow TOFC, orange PTC). Keep source values and denominators (normally TOFC /4 and PTC /20). Break the connecting line at explicit date/session headers. This supersedes earlier shared clinical-severity bands and separate-horizontal-axis interpretations; do not transform counts into a clinical severity score.

## What the reference shows

The main plot is a combined neuromuscular monitoring trend. Its vertical position combines different measurement types using separate bands; it is not a single ordinary percentage axis.

- Horizontal axis: time, with a session start date/time and elapsed duration visible.
- Upper region: TOF ratio (TOFR), with reference labels `TOFR > 90%`, `TOFR > 40%`, and `TOFR > 10%`.
- Middle region: TOF count (TOFC), including the label `TOFC > 0`.
- Lower region: post-tetanic count (PTC), including `PTC > 0` and `PTC = 0`.
- Right-side bands, top to bottom: Recovered, Minimal, Shallow, Moderate, Deep, Profound. These are reference display labels; do not treat them as validated interpretation rules for this custom instrument.
- Connected small measurement markers, predominantly green in the upper region, yellow near the transition to count measurements, orange in the lower region, and red at the lowest region.
- Colored dashed horizontal threshold lines and a white chart background with a dark frame.
- A descending trend, low plateau, and ascending trend in the example. This shape is an example, not a template to impose on recordings.
- Zoom controls and a horizontal time-navigation slider.

The surrounding screen also shows mode, set current, measured current, latest result, and session actions. The supplied CSV does not contain clearly identified current, battery, or circuit-status readings. Display such values only when supplied by a documented device message; otherwise show an unavailable state or omit the field. Use the project's own identity for the application.

## Provisional interpretation of the sample

These interpretations are consistent with the reference and manufacturer documentation but the custom instrument's protocol is not yet confirmed.

| Sample | Proposed interpretation | Confirmation needed |
| --- | --- | --- |
| `23:01,100` | Device time and TOF ratio of 100% | Meaning of bare numeric values and time format |
| `23:04,C,3/4` | Device time and TOF count of 3 responses out of 4 | Exact meaning of `C` |
| `P` | Switch to PTC mode | Whether marker applies to subsequent records |
| `23:10,13/20` | Device time and PTC count of 13 responses out of 20 | Exact denominator and mode rules |
| `T` | Switch to TOF mode | Whether marker applies to subsequent records |
| `07:06:2000,T` | Date-like header and TOF mode indicator | Date order, clock validity, and whether a repeated header starts a new device session |

TOF ratio and TOF count are distinct: a ratio compares the fourth response amplitude to the first, whereas a count reports how many responses were detected. Therefore `3/4` must not become 75% TOFR, and `13/20` must not become 65% TOFR. Store metric type with each value.

Manufacturer background: [STIMPOD NMS450X instructions, section 3.14–3.15](https://www.xavant.com/wp-content/uploads/2025/02/STIMPOD-NMS450X-EN-Instructions-for-Use-V3.pdf). This source explains the standard concepts; it does not establish the custom instrument's serial protocol or the exact vertical mapping of the supplied reference graph.

## Observed sample sequence

Preserve the order received:

1. Date-like header `07:06:2000,T`.
2. `23:00,C,0/4` precedes the numeric sequence. Keep this point; do not remove it to produce a smooth curve.
3. Numeric values: 100, 40, 15.
4. Counts: 3/4, 2/4, 1/4, 0/4, 0/4.
5. `P`, then counts: 13/20, 9/20, 3/20, 0/20, 0/20, 9/20, 14/20, 18/20.
6. `T`, then 2/4 followed by numeric values 29, 83, 97.
7. Repeated date-like header, then `23:52,100`.

The middle sequence is broadly consistent with a descending and ascending combined trend. It is not the exact dataset plotted in the image: the displayed dates and time span differ. Do not claim the sample reconstructs the pictured curve exactly.

## Implementation requirements for the later graph

1. Use one shared horizontal device-time scale and three stacked plot regions with independent native vertical scales for TOFR (%), TOFC count, and PTC count. Keep source values and denominators unchanged. Do not invent a common clinical severity mapping.
2. Preserve real sample timing. Establish whether timestamps mean hours/minutes or minutes/seconds before assigning durations. Do not space irregularly timed readings evenly.
3. Retain raw input, reception timestamp with timezone/UTC representation, record sequence, source time text, parsed metric type, value, denominator, mode, and parse status. Treat mode markers and date headers as events, not numeric points.
4. Do not silently drop malformed or unknown messages. Preserve them and flag parsing issues independently of serial capture.
5. Show exact source values and timestamps when inspecting a point: for example TOFR 40%, TOFC 2/4, or PTC 9/20.
6. Plot actual readings with visible markers and straight chronological connecting segments, including transitions between metric regions. Do not fabricate readings or smooth away transitions. Disconnections and identified session changes must produce visible gaps rather than implied continuous measurements.
7. Label each metric region and its native scale. Use stable metric colors for point markers and connecting intervals. Keep labels clear of tick values and retain time navigation.
8. Support both live incoming data and review of stored sessions through the same plotting model.
9. Keep storage and serial acquisition independent of rendering; navigating or pausing the chart must not pause recording.
10. Validate the parser and piecewise plot mapping against confirmed device protocol and known examples before treating the chart's depth labels as instrument interpretations.

## Open protocol questions

- Confirm numeric values are TOFR percentages and the meanings of `T`, `P`, and `C`.
- Confirm timestamp units, rollover behavior, date format, and the meaning of repeated headers.
- Establish treatment of missing readings, device restarts, and mode transitions.
- Confirm exact band mapping and threshold boundary behavior against the intended reference.

These questions do not prevent raw serial capture and storage in phase one.
