# Shortcuts automations

These are built by hand on the iPhone, in **Shortcuts → Automation → + (New Automation)**.

For **every** automation:
- Choose **Run Immediately**, not "Run After Confirmation".
- Turn **Notify When Run** off.

Most automations post one event to the server with a single **Get Contents of URL** action. Set it up the same way each time:

| Field | Value |
|---|---|
| URL | `https://<your-app>.vercel.app/api/events` |
| Method | `POST` |
| Headers | `Authorization` → `Bearer <API_TOKEN>` |
| Request Body | `JSON` |

Under Request Body you add fields. Pick **Text** for strings and **Dictionary** for `payload`.

Don't send `ts`; the server timestamps the event when it arrives.

> **Tip:** build one automation fully, then make the rest with **Duplicate**. Long-press the automation, then change the trigger and the body.

---

## 1. Distraction apps opened / closed → `app_open` / `app_close`

Make **two automations per group**: one for opening apps, one for closing them. Use one group for games and one for social apps, which makes 4 automations.

**Trigger:** App → choose the apps (e.g. all your games) → tick **Is Opened** → Run Immediately.

**Action:** Get Contents of URL, with this JSON body:

| Key | Type | Value |
|---|---|---|
| `type` | Text | `app_open` |
| `source` | Text | `shortcut` |
| `payload` | Dictionary | `app` (Text) = `games`, `kind` (Text) = `game` |

```json
{ "type": "app_open", "source": "shortcut", "payload": { "app": "games", "kind": "game" } }
```

Duplicate it with trigger **Is Closed** and `"type": "app_close"`. The server uses the open/close pairs to count minutes against the play limit.

Then make the social group the same way: TikTok, Instagram and YouTube with `"app": "social", "kind": "social"`.

> If you want per-app detail in Claude's weekly review, make one automation per app with `app` set to its name (e.g. `TikTok`) instead of one per group.

**What it triggers:** if a **work** or **uni** block is running, the server books a "BACK TO WORK" alarm 2 minutes out. There's a 10-minute cooldown. If you're over your daily play limit, it books a "PLAY LIMIT HIT" alarm. Either alarm reaches the phone at its next sync.

## 2. Fixed-time syncs → book new alarms

The phone can't get push notifications, so these four make sure Claude's changes land on it.

**Trigger:** Time of Day → `07:30` → Daily → Run Immediately.

**Action:** search for **Accountable → Sync Schedule**. This runs the full sync in the background without opening the app.

Make one each for **07:30, 12:30, 17:30 and 21:30**. The easiest way is to duplicate it and change the time.

> If the **Sync Schedule** action ever fails (for example, after the app's 7-day signature lapses), add an **Open URLs** action with `accountable://sync` as a backup. It opens the app and syncs.

## 3. Arrive / Leave places → `place_enter` / `place_exit`

These back up the app's own geofences. The place values must match the place ids Claude created. Ask Claude to run `list_places` to see them; they look like `kcl_strand`, `gym`, `home`.

**Trigger:** Arrive → Location: choose the place → Any Time → Run Immediately.

**Action:** Get Contents of URL, with this body:

```json
{ "type": "place_enter", "source": "shortcut", "payload": { "place": "gym" } }
```

Duplicate it with trigger **Leave** and `"type": "place_exit"`.

Repeat for each place: enter and exit for KCL, gym and home, which makes 6 automations.

**What it triggers:** arriving at a block's `required_place` (from 30 min before it starts until it ends) marks the block **done**. If you're not there 20 min after it starts, the server books a "LATE — GET TO GYM" alarm.

## 4. Alarm stopped / snoozed → `alarm_fired` (backup log)

**Trigger:** Alarm → **Any Alarm** → **Is Stopped** → Run Immediately.

**Action:** Get Contents of URL, with this body:

```json
{ "type": "alarm_fired", "source": "shortcut", "payload": { "action": "stopped" } }
```

Duplicate it for **Is Snoozed** with `"action": "snoozed"`.

> iOS may only fire this trigger for Clock-app alarms, not AlarmKit ones. That's fine: the app's own On it / +15 buttons are the main log, and this one is only a backup.

## 5. Daily steps → `steps` (10k goal)

**Trigger:** Time of Day → `20:35` → Daily → Run Immediately.

**Actions**, in this order:
1. **Find Health Samples**:
   - Type: **Steps**
   - Start Date **is today**
2. **Calculate Statistics** → **Sum** of the Health Samples.
3. **Round Number**: round the statistics result.
4. **Get Contents of URL**: POST to `/api/events` with this JSON body:

| Key | Type | Value |
|---|---|---|
| `type` | Text | `steps` |
| `source` | Text | `shortcut` |
| `payload` | Dictionary | `count` (Number) = the **Rounded Number** variable |

```json
{ "type": "steps", "source": "shortcut", "payload": { "count": 7421 } }
```

**What it triggers:** if you're under 10,000 steps, a quiet notification says how many are left, for example *"WALK — 2,579 STEPS TO GO"*. Claude also sees `steps_by_day` in the weekly summary.

The first run asks for permission to read your step count. Allow it.

> You can also add a second copy at 18:00. The server only nudges after 20:30, but Claude's 21:00 check-in will see the earlier number too.

---

## Quick test

Run any Get Contents of URL automation by hand from the Shortcuts app. It should return something like this:

```json
{ "received": 1, "inserted": 1, "duplicates": 0, "changes": [], "rule_actions": [] }
```

A `401` means the Authorization header is wrong. It must be exactly `Bearer ` followed by the token.
