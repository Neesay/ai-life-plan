# Accountability Alarm System — Build Spec

18 Nov 2026

## Goals

Claude plans my day and enforces it through full-screen iPhone alarms I can't swipe past. It also gets enough signal back to know what I'm actually doing. The whole thing costs £0.

1. **Unavoidable alerts:** schedule blocks (uni, work, gym, play, sleep) fire as AlarmKit alarms that break through Silent mode and Focus.
2. **Claude in control:** Claude reads and writes my schedule through an MCP server, from claude.ai or Claude Code.
3. **Awareness:** the system logs check-ins, location (KCL, gym, home) and app usage (games/social), so Claude knows plan vs reality.
4. **Reactivity:** instant server rules escalate when I miss something; Claude re-plans at scheduled check-ins (e.g. 08:00, 13:00, 21:00) and runs a weekly review.
5. **Zero cost:** free Apple ID + SideStore re-sign every 7 days, GitHub Actions macOS builds, Vercel free tier.

**Success looks like:** for 2 straight weeks, every planned block fires an alarm on time, every response (or miss) is logged, and Claude's daily adjustments reach the phone by the next sync.

## Constraints and decisions

| Area | Decision | Why |
|---|---|---|
| Devices | iPhone on iOS 27 + iPad. No Mac. | What I have |
| Alerts | AlarmKit (iOS 26+) | Only third-party API that breaks through Silent + Focus with a full-screen alert |
| Signing | Free Apple ID via SideStore, re-sign every 7 days | No £79/yr developer fee |
| Build | GitHub Actions macOS runner, public repo | Free unlimited macOS minutes on public repos; no Mac needed |
| Backend | Vercel serverless (TypeScript) + free Postgres/KV | Free tier, Vercel already connected |
| Claude link | Remote MCP server (Streamable HTTP) on the same Vercel project | claude.ai custom connector + Claude Code can both use it |
| Push | None (free Apple ID can't use APNs) | App syncs on open + background refresh; alarms are pre-booked |
| Screen Time blocking | Stretch goal only | FamilyControls likely unavailable on a free account |
| Alarm sound | System default | AlarmKit custom sounds have been buggy |

**Rule:** no secrets in the repo. Schedule data lives only in the database. API token goes in Vercel env vars and the app's Keychain.

## Architecture

The app pulls the schedule and books alarms. The app and Shortcuts post events. Claude reads and edits everything through the MCP server. GitHub builds the app and pokes the rules engine.

### Backend (Vercel)

One Vercel project serves the REST API for the phone, the MCP server for Claude, and a cron for the rules engine. Timezone everywhere: Europe/London; store UTC.

#### Data model

| Table | Key fields |
|---|---|
| blocks | id, title, category (uni / work / gym / play / sleep / other), start_at, end_at, alarm_offsets_min[] (e.g. [-15, 0]), alarm_label, required_place (nullable), status (planned / done / missed / skipped / moved), version, updated_at |
| events | id, ts, type (checkin / place_enter / place_exit / app_open / alarm_fired / sync), block_id (nullable), payload json, source (app / shortcut / server) |
| places | id, name (KCL Strand, Gym, Home), lat, lng, radius_m |
| rules | id, name, condition json, action json, enabled |
| notes | id, ts, author (claude / me), text — Claude's plan reasoning and my replies |

#### REST API (bearer token)

- `GET /api/schedule?from&to` → blocks + a schedule version hash
- `POST /api/events` → append one or many events (used by app and Shortcuts)
- `GET /api/places` → geofences for the app to register
- `GET /api/status` → today's plan vs actual (for Claude and a simple web view)

#### MCP tools

- `get_today` / `get_schedule(from, to)` — plan with statuses
- `add_block`, `update_block`, `move_block`, `delete_block`
- `set_week_template(days)` — recurring default week
- `get_events(since, type?)` — what actually happened
- `get_summary(range)` — hours per category, gym count, missed blocks, gaming time
- `add_note(text)` — log Claude's reasoning for the next session
- `upsert_place`, `set_rule`

#### Rules engine (`POST /api/tick`)

Vercel's free Hobby plan only runs crons once a day, so the tick runs on every incoming event and sync, plus a GitHub Actions scheduled workflow that calls it every ~10 min (free on a public repo, can lag a few minutes).

- Block started + required_place set + no place_enter within 20 min → mark late, insert a follow-up alarm block 10 min out.
- app_open for a game during a work/uni block → insert a "back to work" alarm 2 min out.
- No check-in 30 min after a block's alarm → status missed.
- Daily play time over the limit → alarm + note.

New alarms reach the phone only at its next sync, so rules also write a note Claude sees at the next check-in.

### iOS app (SwiftUI, iOS 26+ target)

The app's one job: keep the phone's AlarmKit alarms identical to the server schedule, and report back what happened.

#### Alarms

- Request AlarmKit authorization on first launch; Info.plist needs `NSAlarmKitUsageDescription`.
- Each block × each offset = one fixed-date alarm. Title = alarm_label (e.g. "GO GYM", "STOP GAMING — APPLICATIONS"). Default sound.
- Store a local map block_id+offset → alarm UUID. On sync: cancel alarms no longer on the server, add new ones, reschedule moved ones.
- Book the next 48 h ahead so alarms still fire if a sync is missed.

#### Check-ins

- Alarm buttons via App Intents: On it, +15 min, Skip. Each intent writes an event to a local queue, then posts it.
- In-app Today screen: current block, next block, check-in buttons, a reason field for skips.
- On iOS 27, alarm state updates may only arrive when the app next runs, so never rely on background observers for logging. Flush the queue on every launch.

#### Sync triggers (no push)

- App launch and foreground
- BGAppRefreshTask (iOS decides timing)
- Geofence enter/exit wake-ups (piggyback a sync)
- A Shortcut that opens the app at fixed times (see Shortcuts section)

#### Location

- Core Location region monitoring for each place from `/api/places` (max 20 regions). Needs "Always" permission.
- Enter/exit → place_enter / place_exit event.

#### Settings screen

Server URL, API token (stored in Keychain), last sync time, alarm count booked, a "Sync now" button and a "Test alarm in 1 min" button.

### Shortcuts automations

Shortcuts covers the signals the app can't get on a free account, and acts as a backup if the app's signature lapses. Each automation is set to Run Immediately and posts to `POST /api/events` with "Get Contents of URL" (method POST, JSON body, `Authorization: Bearer <token>` header).

| Trigger | Event sent | Purpose |
|---|---|---|
| App opened: each game + TikTok, Instagram, YouTube | app_open {app} | Claude sees when play starts; rules fire "back to work" |
| Time of Day: 07:30, 12:30, 17:30, 21:30 | sync + open the alarm app | Forces a sync so new alarms get booked |
| Arrive / Leave KCL, gym, home | place_enter / place_exit | Backup for app geofences |
| Alarm stopped / snoozed | alarm_fired {action} | Backup log of responses |

I'll build these by hand on the iPhone. The repo should include a `docs/shortcuts.md` with exact step-by-step setup and the JSON body for each one.

## Build and install

GitHub's cloud Macs build an unsigned .ipa. SideStore signs it on the iPhone with my free Apple ID.

### CI (GitHub Actions)

1. Generate the Xcode project from `project.yml` with XcodeGen, so nobody needs the Xcode GUI.
2. On push to main: macos-latest runner, select the newest Xcode with the iOS 26+ SDK, `xcodebuild archive` with `CODE_SIGNING_ALLOWED=NO`.
3. Zip `Payload/<App>.app` into `<App>.ipa`; publish it as a GitHub Release asset (latest tag).
4. Second workflow: scheduled every ~10 min, `curl -X POST $API/api/tick` with the token from repo secrets.

### SideStore (one-time, needs any Windows/Linux/Mac computer for ~15 min)

1. Follow the current guide at sidestore.io to install SideStore and generate the pairing file.
2. Sign in to SideStore with my Apple ID.
3. On the iPhone, download the .ipa from the GitHub Release and open it in SideStore.
4. Every 7 days: SideStore → Refresh All (it nags before expiry).

Free-account limits: 3 sideloaded apps at once (SideStore counts as one), 7-day signatures, no push, FamilyControls likely blocked.

## Phased plan

Each phase ships something usable; don't start the next until its acceptance check passes on my real iPhone.

**Phase 0 — Tonight, no code.** Shortcuts Time of Day automations with "Create Alarm" for fixed times; Settings → Sounds & Haptics → Alarms and Timers volume to max.
- [ ] A test alarm fires full screen with the phone on Silent

**Phase 1 — Backend + MCP.** Repo scaffold, database, REST API, MCP server, token auth, deploy to Vercel.
- [ ] Claude adds a block via MCP and `GET /api/schedule` returns it
- [ ] Connector added in claude.ai and in Claude Code

**Phase 2 — App: alarms.** XcodeGen project, AlarmKit auth, sync + diff logic, settings screen, CI → .ipa release, SideStore install.
- [ ] A block Claude creates rings as a full-screen alarm on Silent, within one sync
- [ ] Moving or deleting the block updates/cancels the alarm

**Phase 3 — Check-ins.** App Intent buttons, local event queue, Today screen.
- [ ] Tapping On it / +15 / Skip shows up in get_events after the next app launch

**Phase 4 — Signals.** Geofences, Shortcuts automations (`docs/shortcuts.md`), `/api/tick` + scheduled workflow, rules.
- [ ] Opening a game during a work block produces a "back to work" alarm at the next sync
- [ ] Arriving at the gym logs place_enter

**Phase 5 — Claude in the loop.** Scheduled Claude check-ins (08:00, 13:00, 21:00) that read events, adjust the day and leave a note; Sunday weekly review.
- [ ] A missed gym block gets rescheduled automatically the same evening

**Stretch:** test FamilyControls on the free account for real app blocking; a tiny web dashboard.

## Risks and open questions

| Risk | Mitigation |
|---|---|
| AlarmKit may refuse to work on a free-account signature | Test in Phase 2 first thing with the "Test alarm" button; fallback = Shortcuts "Create Alarm" fed by `GET /api/schedule` |
| Missed 7-day re-sign → app won't open | Alarms already booked still exist; Shortcuts backup keeps logging; set a weekly reminder to refresh |
| No push → Claude's changes arrive late | Book 48 h ahead; fixed-time Shortcut syncs; geofence wake-ups |
| iOS 27 delays alarm state updates until app runs | Log check-ins via App Intents + local queue, never background observers |
| Vercel Hobby cron is daily only | Tick on every request + GitHub Actions schedule |
| Swiping an alarm away isn't detectable | Treat "no check-in within 30 min" as missed |
| Public repo | No secrets, no personal data in code; token in env vars and Keychain |

### Open questions

- [x] Which computer will I use for the one-time SideStore setup?
- [ ] My default weekly timetable (uni hours, gym days, work hours, play limit)
