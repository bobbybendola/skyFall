# Demo plan (about 2 minutes), debris version

## Setup
- Big screen: the 3D globe (`/`). The GX10 on the table, visible.
- Second screen or right panel: compute (GPU/CPU, particle-steps) and the selected object's breakdown.
- Vultr CPU worker running as the backup. QR code to the site for judges' phones.

## Script
1. **0:00–0:15, problem.** "Thousands of satellites now come down on short lifetimes, and some pieces survive. Here's the sky right now." The globe spins with every real object that is decaying, colored by when it re-enters.
2. **0:15–0:40, forecast.** Click the next object coming down. Show its re-entry window ("Oct 25, 05:20 ±6 h, 100% within 3 days"), its orbit path and the live NOAA data behind it. "The GX10 re-simulates tens of thousands of versions of every orbit, every 20 minutes."
3. **0:40–1:15, the moment: debris.** Press play on the clock. The object breaks up at ~78 km and pieces stream down in 3D: structure and panels burn up, the steel reaction wheels and titanium tank survive. Impact zones light up, colored by material. Breakdown panel: "18% chance any piece survives; ~3 kg; impact energy of a falling brick." Click "why": archetype, sources, "modeled estimate".
4. **1:15–1:35, validation.** "Last night <object> came down. Here's what we predicted 12 hours before, and the official decay time." (Real numbers only; if it was off, say by how much.)
5. **1:35–1:50, GX10 + SpacetimeDB.** Unplug the GX10 worker: within about 10 s the amber "DEGRADED: CPU fallback active" banner appears. A new job then goes to the CPU backup, with fewer samples and wide zones. "The GPU is what makes this precise; the database is what keeps it alive." Rehearsal steps and the exact timings: `docs/DEMO_RUNBOOK.md`.
6. **1:50–2:00, close + Grok.** Ask by voice: "Is anything coming down near Berkeley this week, and does any of it survive?" Grok answers from our tables. Close with the limits: public data, generic archetypes, probabilities not pinpoints.

## Must work, in priority order
1. Live objects on the globe with forecasts
2. Debris animation + impact zones for at least one real object, computed on the GX10
3. Breakdown panel with sources
4. GPU → CPU failover with the banner
5. Validation numbers
6. Assistant

## Fallbacks
- Pre-computed debris result for the demo object (published earlier from the GX10) if a live run is slow
- 60-second recorded video
- If the GX10 misbehaves: show degraded mode honestly and the timing comparison from an earlier run

## Pre-demo checklist
- [ ] Script 5× clean; failover rehearsed
- [ ] Feeds fresh; forecast < 20 min old; debris for the demo object present
- [ ] "Modeled estimate" labels visible; no simulated data presented as real
- [ ] Charging, adapters, notifications off
