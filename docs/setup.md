# Setup: the steps only you can do

Everything here is free. Do the parts in order, and check each phase's acceptance test before you move on.

You'll use two secrets. Generate each one on any computer with Node installed:

```
npm run gen-token
```

- **API_TOKEN**: used by the phone app, Shortcuts, the tick workflow and Claude Code.
- **MCP_KEY**: goes only in the claude.ai connector URL. claude.ai custom connectors can't send a header, so the key sits in the URL path. Keep that URL private.

Never commit either secret. They only go in Vercel env vars, GitHub repo secrets, the app's Keychain and your Shortcuts.

---

## Phase 0: tonight, no code

1. Go to iPhone **Settings → Sounds & Haptics** and turn the alarm volume to max.
2. In **Shortcuts → Automation → + → Time of Day**, add the fixed times you want. Set each one to **Run Immediately** and give it a **Clock → Create Alarm** action.
3. Put the phone on Silent and let a test alarm ring.
   - [ ] It fires full screen with the phone on Silent.

## Phase 1: backend and MCP

1. **Push this repo to GitHub as a public repo.** It has to be public for free macOS build minutes.
2. **Create the Vercel project.** Go to vercel.com → Add New → Project → import `ai-life-plan`. Leave the framework preset as **Other** and leave the build settings empty, then click Deploy.
3. **Add a database.** In the project, open the **Storage** tab → Create Database → **Neon** (Serverless Postgres).
   - Pick the **Free** plan, choose the London region (`eu-west-2`) if it's offered, and connect it to the project.
   - This sets `DATABASE_URL` for you.
   - ⚠️ Make sure the plan says Free / $0 before you confirm.
4. **Add env vars.** Go to Project → Settings → Environment Variables and add `API_TOKEN` and `MCP_KEY` for Production.
5. **Redeploy.** Go to Deployments → ⋯ on the latest one → Redeploy.
6. **Smoke test.** Open `https://<your-app>.vercel.app/api/health` in a browser. You should see `{"ok":true}`.

   The tables are created automatically on the first authenticated request.
7. **Connect claude.ai.** Go to Settings → Connectors → **Add custom connector**.
   - Name: `Accountability`
   - URL: `https://<your-app>.vercel.app/mcp/<MCP_KEY>`

   Enable it in a chat via the tools menu.
8. **Connect Claude Code.** Run this in a terminal:
   ```
   claude mcp add --transport http accountability https://<your-app>.vercel.app/mcp --header "Authorization: Bearer <API_TOKEN>"
   ```
9. **Add the GitHub repo secrets** the rules tick needs. Go to repo → Settings → Secrets and variables → Actions → New repository secret:
   - `API_URL` = `https://<your-app>.vercel.app`
   - `API_TOKEN` = your API token

   The **Rules tick** workflow then runs every ~10 min. Check it under the Actions tab.

Acceptance:
- [ ] In claude.ai, ask Claude to *"add a gym block today 18:00–19:00 with alarms at -15 and 0"*. Then check the REST side returns it (or ask Claude to call `get_schedule`):
  ```
  curl -H "Authorization: Bearer <API_TOKEN>" https://<your-app>.vercel.app/api/schedule
  ```
  The block should come back.
- [ ] The connector works in both claude.ai and Claude Code.

Next, give Claude your places and default week. Paste something like this into claude.ai:

> Use the accountability tools. Add places: KCL Strand (51.5115, -0.1160, 200 m), my gym (lat, lng), home (lat, lng). Then set my week template: uni Mon–Thu 10:00–13:00 at kcl_strand, work …, gym Mon/Wed/Fri 18:00–19:00 at gym, sleep 23:30–07:30 every day with a -30 wind-down alarm. Set play_limit to 90 min.

## Phase 2: the app and its alarms

1. **Get a build.** Every push to `main` that touches `ios/` runs **iOS build** in GitHub Actions. You can also run it by hand: Actions → iOS build → Run workflow.

   When it goes green, the release **latest** has `Accountable.ipa`.
2. **One-time SideStore setup** (needs your computer for ~15 min). Follow the current guide at https://sidestore.io. It installs SideStore and creates the pairing file. Sign in to SideStore with your Apple ID.
3. **Install the app.** On the iPhone, open `https://github.com/<you>/ai-life-plan/releases/latest`. Download `Accountable.ipa`, then **Share → SideStore** (or SideStore → My Apps → + → pick the file).
4. **Configure it.** Open **Accountable → Settings**. Enter the server URL and API token and tap **Save**, then **Allow alarms**.
5. **Test AlarmKit first.** Tap **Test alarm in 1 min**, lock the phone and put it on Silent.
   - If it rings full screen, AlarmKit works on a free-account signature. 🎉
   - If you get "AlarmKit refused", tell Claude. The fallback is Shortcuts "Create Alarm" fed from `/api/schedule`.

Acceptance:
- [ ] Ask Claude for a block 10 minutes from now. Open the app (that triggers a sync); the Settings tab shows the alarm count go up, and the alarm rings full screen on Silent.
- [ ] Ask Claude to move it, open the app, and it rings at the new time. Ask Claude to delete it, open the app, and it doesn't ring.

**Every 7 days:** SideStore → My Apps → **Refresh All**. It nags you before the signature expires. Set a weekly reminder anyway.

## Phase 3: check-ins

The alarm's **On it** button is the stop button, and **+15 min** is the secondary button. AlarmKit only allows two buttons, so **Skip** (with a reason) lives on the in-app **Today** screen.

- [ ] Use On it, +15 and Skip once each, then open the app. Ask Claude to call `get_events` for today: all three should be there.

## Phase 4: signals

1. In the app, go to **Settings → Allow location (Always)**. Choose "Allow While Using", then accept the follow-up prompt to change it to **Always**.

   The app registers the places Claude added; "Geofences" in Settings shows the count.
2. Build the Shortcuts automations in [shortcuts.md](shortcuts.md).

Acceptance:
- [ ] Open a game during a work block. Within a minute the server inserts a "BACK TO WORK" alarm, and it rings after the next sync. Open the app to force one.
- [ ] Walk into the gym. `get_events` shows `place_enter` with `place: gym`.

## Phase 5: Claude in the loop

See [claude-checkins.md](claude-checkins.md) for the scheduled check-in prompts and how to schedule them.

- [ ] Miss a gym block on purpose. By the 21:00 check-in, Claude has rescheduled it.
