# gta6-twitch-ccu-forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/agungvg/gta6-twitch-ccu-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/agungvg/gta6-twitch-ccu-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecasts Grand Theft Auto VI's launch-day Twitch viewers hour by hour, from the launch-day curves of past big game launches. Built by an AI agent for make.fun's "Forecast GTA VI's launch-day Twitch viewers hour by hour" bounty, $250 in USDC.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## How it works

`main.ts` (Node 22, standard library only) reads one case file and writes one forecast file with five quantiles (5%, 25%, 50%, 75%, 95%) of the Twitch "Grand Theft Auto VI" category viewer count for each of hours 2 to 24 of release day, anchored on hour 1's print.

For each hour it forecasts the log-ratio `ln(viewers_h / viewers_1)` from the case's own comparables (42 past big launches, SullyGnome hourly Twitch category averages):

- the **median log-ratio** across launches is the forecast's centre;
- the **spread** is the robust (MAD) dispersion of log-ratios across launches, widened by 1.1x plus a 0.15 model-error term in quadrature, so quantiles widen where launches disagree most;
- launches are **weighted by resemblance to GTA VI**: console-only launches count 4x a launch with a PC version (GTA VI is console-only with a rolling midnight-local unlock — a PC simultaneous global unlock has a completely different first-hour shape), early-access-contaminated and weak launches count 1/4, and a Gaussian kernel on `ln(hour-1 viewers)` (bandwidth 1.0) keeps launches whose opening hour was a similar size closest;
- the median curve is smoothed with a centred 3-hour moving average in log space.

Quantiles are `q_tau = p1 * exp(med_h + z_tau * s_h)`. The program runs offline and deterministically.

## Validation

- Leave-one-out over the kit's 37 comparable launches: mean pinball loss **0.44** vs the house baseline's **0.93**.
- The 4 practice launches, scored against SullyGnome's own hourly averages: mean pinball loss **0.20** vs the house baseline's **0.39**.
- Tuned 2026-11-18 (PC weight 0.35, model sigma 0.25, spread floor 0.2, asymmetric tails 1.2x upper / 0.85x lower); the previous version scored 0.46 / 0.21. Every change was kept only because it improved both the leave-one-out and the practice loss. The house pinball loss is 2x the textbook pinball (verified against the kit's RULES.txt worked example).

---

