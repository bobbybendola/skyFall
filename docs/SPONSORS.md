# Sponsor tracks

Source: https://hive.hackberkeley.org/prizes (page version "Updated Oct 23, 9:55 PM"; re-read Oct 24, 58 prize cards). Re-check before submitting; "coming soon" listings may change. Stack at most four sponsor tracks (from our earlier notes; this rule is not on the prizes page, so confirm on Devpost).

General Cal Hacks prizes we are judged for anyway: Most Technically Complex Hack, Best Planet-First Hack, overall placings.

## Planned
### SpacetimeDB (core): 1st $2,048, 2nd $1,024, 3rd $512
Wants Spacetime as the core real-time backend: live shared state, instant sync between users/agents/systems, meaningful use. Their list of good fits names "shared simulations", "live dashboards" and "AI systems coordinating in a persistent world state", and says Spacetime must be "meaningfully used, not just added on the side". (A separate Scrabblebot Tournament prize exists; not ours.)
README section: which tables are shared state, what each reducer enforces, what updates live on every screen, how the GX10 worker coordinates through reducers.
Our pitch (debris pivot): SpacetimeDB is the backend, not a sync layer. It fetches NOAA/CelesTrak itself, chains GPU jobs (forecast → debris per object) through reducers with leases and CPU failover, archives every element set and forecast, and streams large result sets (breakdowns, footprints, 3D tracks) to every globe live. Demo beat: unplug the GX10 and the database hands its work to the CPU worker in degraded mode.

### SpaceXAI "Make it Legendary" (+ MLH "Build Your Hackathon A-Team")
Requirements as listed: project built with **Cursor**; must use the **Grok Imagine or Voice API**; bonus for Grok Bot for planning/collaboration. Space/public data theme. MLH A-Team: use Cursor as the core coding agent, integrate Grok Bot in the workflow, describe how in the project description, opt in to the "Make it Legendary" raffle at submission.
Our use (debris pivot): a debris-prediction tool directly relevant to constellation operators (shaped by our conversation with SpaceX), on real space data (CelesTrak, NOAA, Space-Track, GCAT); a **Grok Voice** assistant ("what's coming down near me, and does any of it survive?") answering from our tables; Grok Bot for team planning (separate from the in-app assistant). Grok Imagine is dropped. Keep `docs/TOOL_LOG.md`.
Check: exact Grok API capabilities (function calling, Voice) and credits.

### Anthropic (details "coming soon")
Criteria shown: a named community, a real problem, it works, thoughtful use of Claude (and where it could go wrong).
Our plan: name a community (flight dispatchers or amateur sky-watchers; decide in hour one); give Claude one job, such as a plain-language advisory and the reason a sighting was held. State failure modes in the README.

### Candidate: Mana.space, $5,000 cash (decide in the morning)
Use Mana meaningfully while building; link public Mana pages/chats in the submission; show one demo moment where Mana changed what or how fast we built. Scoring: meaningful use 30, usefulness 25, originality 25, execution 20, bonus up to +10 if the project lives inside Mana as an app or agent a judge can open. Tool-use prize, compatible with our build if a teammate does real work in Mana (e.g. the operator panel or phone page prototype). Ask the Mana table whether Mana use alongside Cursor counts.

### Watch: Annapurna Labs (coming soon)
AWS's chip team. No criteria yet; check the booth. Relevant to the GX10/hardware angle.

### MLH extras (planned)
- **Best .Tech Domain Name** (free .tech for up to 10 years): register the project domain and point it at the site.
- **Best Use of Vultr** (free credits): a Vultr server hosts the web build and runs the degraded CPU backup worker + compute (`USE_GPU=0`). Real role: keeps SKYFALL alive, visibly degraded, when the GX10 is offline.
- Not both domain prizes: skip GoDaddy Registry. Not both clouds: skip DigitalOcean.

## Optional, only if genuinely central
- **Bright Data / Apify:** both require real essential web data and Bright Data disqualifies mocked demo data. Default: skip.
- **Microsoft "Built for the Real World":** needs a production-minded agent and a named customer; skip unless the team commits to a customer.
- **MLH Commit Fellowship:** opt in at submission if the team wants to continue the project.

## Avoid
Convex (competes with SpacetimeDB), Tiger Data, MongoDB, Snowflake, DigitalOcean, Bitdeer (dilute the GX10 story; Vultr is used only as the degraded backup); Cartesia/ElevenLabs/Moss unless voice becomes core.

## Submission checklist
- [ ] README states real vs simulated
- [ ] Each chosen track has a README section matching its criteria
- [ ] Devpost submitted before Sunday 9:00 AM; track opt-ins done
- [ ] Demo video (if required) opens with the moment
- [ ] No secrets in git history; repo public if required
- [ ] Team size within rules (check: guide says 1 to 4, Devpost said 2 to 4)
