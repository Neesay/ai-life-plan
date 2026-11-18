# Claude check-ins (Phase 5)

The server rules react straight away, and Claude re-plans at fixed check-ins. Each check-in is a scheduled Claude run that uses the **Accountability** MCP connector.

## How to schedule them

You have two free options:

- **claude.ai:** start each check-in by hand from a pinned project chat. Set iPhone reminders for 08:00, 13:00 and 21:00.
- **Claude Code routines:** ask Claude Code to *"schedule these check-ins"*. It uses the `/schedule` skill to create cloud routines on cron (London time) that run the prompts below with the connector attached. Before you confirm, check that routines are included in your current plan at no extra cost.

## Morning: 08:00

> Accountability check-in (morning). Call get_today, get_notes (last 2 days) and get_summary for the last 7 days. Fix today's plan: make sure every essential block (uni, work, gym) is in a realistic slot, that nothing overlaps, and that alarm labels are short and blunt. If yesterday had misses, put the most important one back today. Changes must be at least 30 min in the future so the 12:30 sync catches them. Finish with add_note: what you changed and why, in 2–4 lines.

## Midday: 13:00

> Accountability check-in (midday). Call get_today and get_events since 08:00. Compare plan and reality: what was done, missed, skipped (read the reasons) and distraction minutes. Adjust the afternoon and evening. Don't stack missed work; move it into real gaps or tomorrow. If distraction time is high, add a short "phone down" block or tighten play_limit with set_rule. Finish with add_note.

## Evening: 21:00

> Accountability check-in (evening). Call get_today, get_events since 00:00 and get_notes for today. Any gym block missed today must be rescheduled (later tonight if it's realistic and before 21:30 start, otherwise tomorrow's best free slot) with move_block or add_block. Check tonight's sleep block and tomorrow morning's first block. Make sure tomorrow's plan exists. Finish with add_note summarising the day in 3 lines: wins, misses, one change for tomorrow.

## Weekly review: Sunday 19:00

> Accountability weekly review. Call get_summary for the past 7 days, get_notes for the past 7 days and get_week_template. Report: hours planned vs done per category, gym sessions, missed and skipped blocks with patterns (which days and times fail), and distraction minutes per app. Then propose one concrete change to the week template, and to a rule if needed. Apply it with set_week_template / set_rule only if it's clearly better; otherwise leave it as a note for me to approve. Finish with add_note.

## Phase 5 acceptance

- [ ] A gym block that's missed (no check-in 30 min after start → `missed`) is moved by the 21:00 check-in.
- [ ] The phone books the new time at its next sync.
