# gta6-ccu-forecast

Forecasts Grand Theft Auto VI's launch-day Twitch concurrent viewers, hour by hour, as five
quantiles an hour — for the `gta6-twitch-ccu-forecast-01` bounty on [make.fun](https://make.fun).

[![make.fun](https://img.shields.io/badge/make.fun-bounty-7c3aed)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

## The problem

Grand Theft Auto VI releases on 19 November 2026. By the end of its first hour of release day the
Twitch category's viewer count is known; the other 23 hours are not. This entry forecasts all 23,
as the 5/25/50/75/95 percentiles of each hour's concurrent viewers.

Scored by mean pinball loss on the log scale. The log scale means a 20% miss costs the same at
10,000 viewers as at 1,000,000, so the forecast has to be right about *shape*, not just size — and
a spread that is too wide is punished at every hour, not only where it wraps the answer.

## The method

A comparable launch tells you the *shape* of a launch day even when its audience is a different
size from the target's. So each comparable contributes a relative curve:

    r_c(h) = curve_c(h) / curve_c(1)

Dividing by its own hour 1 strips out the size and leaves the shape. The five quantiles for hour
`h` are the magnitude-weighted quantiles of those ratios across comparables, multiplied by the
target's own hour-1 print.

Two details matter:

- **Magnitude weighting.** A comparable whose hour 1 is close to the target's hour 1 gets more
  weight, `1 / (1 + 2·|ln(h1_c / h1_target)|)`. A 4,000-viewer launch has a very different
  shape from a 500,000-viewer one, and the weight says so smoothly rather than with a hard cutoff.
- **Top 12 only.** At each hour, only the 12 closest comparables are used. The long tail is
  small-category noise, and dropping it was worth more than any other single change.

Hours where fewer than three comparables report fall back to the starter's persistence shape:
hour 1 flat, log-normal spread of 0.15 per √hour.

## How it was chosen

There is no local scorer for this bounty (the grader's reference data is server-side only), so
the method was chosen by **leave-one-out over the 37 comparable launches** in the kit: hide one
launch, forecast it from the others, score against its real counts.

Lower is better. Official pinball loss (the rules' `2·max(τd, (τ−1)d)`), on the 27 launches whose
hour 1 drew at least 20,000 viewers — the regime a GTA launch lives in:

| method | mean loss |
|---|---|
| starter's persistence (hour 1 flat) | 0.3214 |
| ratio, unweighted | 0.3804 |
| ratio, magnitude-weighted | 0.3006 |
| ratio, magnitude-weighted, top 12 | **0.2633** |

The weighting and the top-12 cut are not tuned to a knife edge: weight powers anywhere from 1.5
to 4.0 land within 0.0006 of each other, so the ordering is a property of the data, not of a
sweep. Over the full 37-launch set (including categories too small to resemble this one) the same
method scores 0.5432 against persistence's 0.9296.

Winsorising the ratios, fitting a log-normal to them, and blending empirical with parametric
quantiles were all tried and all scored worse — the empirical quantiles are better calibrated
because the shape of a launch day is genuinely bimodal (a spike at unlock, a trough in the small
hours, a second peak at prime time).

## Layout

    main.ts        the whole entry: reads every <id>.in in the input dir, writes <id>.out
    LICENSE        MIT

## Running it

Node 22, standard library only, no network:

    mkdir -p out
    MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

`input/` holds the kit's practice cases. Each run writes one `<id>.out` per `<id>.in`, byte for
byte identical across runs: no clock, no random, no environment beyond the two directories.

## Output format

Exactly 23 rows, hours 2–24, five strictly-ordered finite quantiles each, well under the 64 KiB
cap (~1.5 KiB per case):

```json
{"hours":[{"hour":2,"q":[16187.47,17550.59,18273.31,22644.79,28685.89]}, ...]}
```

MIT licensed.
