# Demo plan (about 2 minutes)

## Setup
- Big screen: map (`/`). Second small screen: GX10 status panel (or the right panel).
- The GX10 visible on the table.
- Teammates have the phone page (`/report`) open.
- Replay loaded. Screen label: "Simulated sightings, replay of <event>".

## Script
1. **0:00 to 0:15, problem.** "Once a week something falls out of orbit uncontrolled. The landing time can be off by hours, so airspace gets closed over huge areas." Show the large red corridor.
2. **0:15 to 0:35, live feeds.** Show the real Space-Track watchlist, element freshness and space weather updating. Press **Replay**.
3. **0:35 to 1:20, the moment.** Teammates tap sightings; pins appear within about a second and the corridor tightens in visible steps. Submit one bad report (a plane image); show it rejected with a reason.
4. **1:20 to 1:40, the GX10.** Show variants re-simulated ticking up per sighting. "Every pin re-runs thousands of orbits locally."
5. **1:40 to 2:00, close.** Before and after area (use the real number from the run). State limits: kilometre-accurate public data, simulated sightings, narrowing not pinpointing.

## What must work, in priority order
1. A phone pin appears on the big screen almost instantly
2. The corridor visibly shrinks per sighting
3. GX10 panel shows real work
4. Live feed panel shows real data with timestamps

## Fallbacks
- "Auto-fire sightings" button if phones or Wi-Fi fail
- 60-second recorded video of a good run
- `USE_GPU=0` mode if the GPU misbehaves (say so honestly)
- If asked "why not the cloud?": the simulation reruns on every report and the vision queue is continuous; running it locally keeps latency low. Say plainly that the core GPU work is physics simulation plus a vision model, not an LLM.

## Pre-demo checklist
- [ ] Run the full script 5 times in a row
- [ ] Reset button clears demo sightings and corridor
- [ ] Feeds show recent success times
- [ ] Screen labels say replay/simulated
- [ ] Charging, adapters, tabs closed, notifications off

## Question to ask sponsors at the first check-in
"This is the shared-state core and a replay. What real feed or user would you want live in the next version?"
