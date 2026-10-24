# Sponsor tracks

Source: https://hive.hackberkeley.org/prizes (read Oct 23, 9:55 PM). Re-check before submitting; "coming soon" listings may change. Stack at most four tracks.

## Planned
### SpacetimeDB (core)
Wants Spacetime as the core real-time backend: live shared state, instant sync between users/agents/systems, meaningful use.
README section: which tables are shared state, what each reducer enforces, what updates live on every screen, how the GX10 worker coordinates through reducers.
Our pitch: SpacetimeDB is the backend, not a sync layer. It runs the GPU job queue with leases and CPU failover, reporter trust, the replay clock and corridor history, and it fetches NOAA/CelesTrak itself through scheduled procedures. Demo beat: unplug the GX10 and the database hands its work to the CPU worker.

### SpaceXAI "Make it Legendary" (+ MLH "Build Your Hackathon A-Team")
Requirements as listed: project built with **Cursor**; must use the **Grok Imagine or Voice API**; bonus for Grok Bot for planning/collaboration. Space/public data theme. MLH A-Team: use Cursor as the core coding agent, integrate Grok Bot in the workflow, describe how in the project description, opt in to the "Make it Legendary" raffle at submission.
Our use: real space data (Space-Track, CelesTrak, NOAA); Grok Imagine for the synthetic test set; Grok Voice for sighting reports/spoken updates if time; Grok Bot for planning. Keep `docs/TOOL_LOG.md`.
Check: exact Grok API capabilities and credits.

### Anthropic (details "coming soon")
Criteria shown: a named community, a real problem, it works, thoughtful use of Claude (and where it could go wrong).
Our plan: name a community (flight dispatchers or amateur sky-watchers; decide in hour one); give Claude one job, such as a plain-language advisory and the reason a sighting was held. State failure modes in the README.

## Optional, only if genuinely central
- **Bright Data / Apify:** both require real essential web data and Bright Data disqualifies mocked demo data. Default: skip.
- **Microsoft "Built for the Real World":** needs a production-minded agent and a named customer; skip unless the team commits to a customer.
- **MLH Commit Fellowship:** opt in at submission if the team wants to continue the project.

## Avoid
Convex (competes with SpacetimeDB), Tiger Data, MongoDB, Snowflake, Vultr, DigitalOcean, Bitdeer (dilute the GX10 story); Cartesia/ElevenLabs/Moss unless voice becomes core.

## Submission checklist
- [ ] README states real vs simulated
- [ ] Each chosen track has a README section matching its criteria
- [ ] Devpost submitted before Sunday 9:00 AM; track opt-ins done
- [ ] Demo video (if required) opens with the moment
- [ ] No secrets in git history; repo public if required
- [ ] Team size within rules (check: guide says 1 to 4, Devpost said 2 to 4)
