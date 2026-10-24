# Setup: accounts and steps

Do these in order. Items marked **(blocking)** stop the build until done. Put every key in `.env` (never commit it); names are in `.env.example`.

## A. Do first (tonight)

1. **Space-Track account** (blocking for the live TIP feed, not for the demo).
   - Register: https://www.space-track.org/auth/createAccount. Give an honest "organization / interests" (e.g. "Student, Cal Hacks 13.0 hackathon, re-entry visualization") and accept the User Agreement.
   - The page does not say how long approval takes, so start it now. Problems: admin@space-track.org.
   - Once approved: put `SPACETRACK_USER` / `SPACETRACK_PASS` in `.env`. One account for the team: the agreement forbids sharing logins, so only the poller machine uses it.
   - On first login, confirm the open items in `docs/LIVE_DATA_SOURCES.md`: TIP field names, and whether `class/tip` works on a free account.
   - While waiting: download `gp_history` for the replay event once you have access (once per lifetime, store in `data/replay/`).

2. **SpacetimeDB CLI** (blocking). On each laptop that builds the module:
   ```powershell
   iwr https://windows.spacetimedb.com -useb | iex      # Windows
   ```
   (macOS/Linux: `curl -sSf https://install.spacetimedb.com | sh`.) Open a new terminal, then:
   ```bash
   spacetime --version
   spacetime login            # browser sign-in with GitHub or Google
   ```
   Restart Claude Code / Cursor afterwards so they see the new PATH.

3. **Pick where the database runs for the demo.**
   - **Maincloud (recommended for the demo):** phones reach it over any network, which avoids venue Wi-Fi blocking laptop-to-phone traffic. Free tier; free databases pause when idle and resume on the next connection. Publish:
     ```bash
     spacetime publish skyfall-calhacks --server maincloud --module-path spacetimedb   # (check flags)
     ```
     The name must be unused on maincloud (check naming rules); record it in `.env` as `SPACETIMEDB_MODULE` and `VITE_SPACETIMEDB_MODULE`.
   - **Local (development):** `spacetime start` on a laptop, then publish with `--server local`. Phones only work if they can reach the laptop's IP.

4. **GitHub.** Repo: https://github.com/bobbybendola/skyFall (private). Add teammates:
   `gh api -X PUT repos/bobbybendola/skyFall/collaborators/<username> -f permission=push`. Make it public before submission if Devpost requires it. Work goes through PRs into `main`.

## B. No sign-up needed (already usable)
- **CelesTrak** GP and `SPECIAL=DECAYING`: no account. The module fetches it itself; see the politeness rules in `docs/LIVE_DATA_SOURCES.md` (one download per 2-hour update, never retry in a loop).
- **NOAA SWPC** Kp and F10.7: no account. The module fetches it itself every 15 minutes.
- **Launch Library 2**: no account (15 requests per hour). Optional context only.

## C. Sponsor tracks (before Saturday afternoon)
5. **xAI (Grok Imagine / Voice)**: create an API key at the xAI console (https://console.x.ai, check). Ask the SpaceXAI sponsor table about hackathon credits. `.env`: `XAI_API_KEY`.
6. **Cursor**: install and sign in on every laptop; the SpaceXAI and MLH A-Team tracks require building with it. Log notable uses in `docs/TOOL_LOG.md`.
7. **Grok Bot**: use it for planning so the MLH A-Team requirement holds; log it.
8. **Anthropic** (if Claude gets its job in the app): API key from https://console.anthropic.com. `.env`: `ANTHROPIC_API_KEY`.
9. **Devpost**: every teammate joins the Cal Hacks 13.0 hackathon and the project. Submission is due **Sunday 9:00 AM**.

## D. Machines
10. **GX10**: confirm SSH access and that it can reach maincloud (outbound WebSocket). Follow `docs/GX10_SETUP.md` to the CUDA smoke test. Fall back to `USE_GPU=0` if it stalls past 45 minutes.
11. **CPU fallback worker**: any laptop. Runs `gx10-compute` with `USE_GPU=0` and the worker with `WORKER_TIER=cpu`.
12. **Local tools**: Node 22+ and Python 3.11+ on each laptop.

## E. First run, once the CLI works (in order)
```bash
cd spacetimedb && npm install
spacetime publish <db> --server <maincloud|local> --module-path .        # (check flags)
spacetime generate --lang typescript --out-dir ../web/src/module_bindings --module-path .                 # (check flags)
spacetime generate --lang typescript --out-dir ../services/gx10-bridge/src/module_bindings --module-path .
```
Then claim roles before anyone else connects:
1. The operator console (`tools/demo-ctl`) calls `register_worker("operator")`.
2. Each worker prints its identity on start; the operator runs `approve_worker(<hex>)` for it.
3. The poller machine calls `register_worker("poller")`.
4. The operator seeds the replay object (`ingest_object`) and loads its script (`load_replay_script`).

Check that the scheduled jobs run:
```bash
spacetime sql <db> "SELECT * FROM feed_status"        # noaa_swpc should show a recent last_ok_at
spacetime logs <db>
```
If `noaa_swpc` never succeeds, outbound HTTP from procedures is not available on that host. The fallback is in `docs/ARCHITECTURE.md`.
