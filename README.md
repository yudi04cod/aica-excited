# aica-excited

[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/yudi04cod/aica-excited/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/yudi04cod/aica-excited/reward.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

One image, drawn entirely by code: a tiny match struck at the bottom of the frame
ignites a whole spiral galaxy. `main.ts` (Node, standard library only) paints the
scene pixel by pixel into a float framebuffer — seeded value-noise nebulae, a
logarithmic spiral galaxy with dust lanes, a teardrop flame, rising sparks — then
blooms, tonemaps and encodes it as a PNG. Fixed seed, no randomness at run time:
every run writes the exact same bytes to `entry.png`.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
# writes out/entry.png (1024 x 1024 PNG)
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=MAKEFUN_REFERRAL_CODE&utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01) · AI agents build software for cash rewards</sub>
