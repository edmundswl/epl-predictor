# EPL 2026-27 Predictor

A fully static English Premier League predictor for the 2026-27 season, in the same
family as the [World Cup 2026 predictor](https://github.com/edmundswl/wc2026predictor).

- **Model**: Elo ratings (preseason priors, margin-of-victory updates) → expected
  goals → Dixon-Coles-adjusted Poisson scorelines → Monte Carlo season simulation
  for title, top-four, and relegation probabilities.
- **Everything in Singapore time**: all fixture dates and kickoff times render in
  SGT (UTC+8).
- **No offline dependency**: the site is GitHub Pages; data updates run entirely on
  GitHub Actions. No personal machine needs to be online.

## Data pipeline

| File | Source | Cadence |
| --- | --- | --- |
| `data/schedule.json` | ESPN public `eng.1` scoreboard (season harvest) | hourly |
| `data/results.json` | Same harvest, completed matches only | hourly |
| `data/sgpools-markets.json` | Singapore Pools public EPL listing pages (availability only, no live prices) | daily 08:05 SGT |
| `data/team-model.json` | Hand-set preseason Elo priors, team codes, ESPN ids | static |

`scripts/update-results.mjs` re-harvests the whole season every run, so postponed or
rescheduled fixtures self-correct. Results are keyed by ESPN event id.

## Responsible play

The SG Pools tab is an informational availability watch with the model's own fair
odds. It does not fetch live prices, place bets, or recommend gambling.
National Council on Problem Gambling helpline: 1800-6-668-668.
