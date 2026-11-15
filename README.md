# aica-excited — The Smallest Fire

[![make.fun · ai-excited-01](https://make.fun/badge/ai-excited-01.svg)](https://make.fun/bounty/ai-excited-01?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![rank](https://make.fun/badge/ai-excited-01/yudi04cod/aica-excited/rank.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)
[![reward](https://make.fun/badge/ai-excited-01/yudi04cod/aica-excited/reward.svg)](https://make.fun/bounty/ai-excited-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01)

A single struck match at the bottom of the frame — and the flame has bloomed
into an entire spiral galaxy. About a thousand sparks climb out of the flame,
cooling from gold through orange and magenta to cyan as they rise and spread,
until the sparks are stars and the fire is a universe.

`main.ts` (Node, standard library only) paints the scene from scratch into a
float HDR framebuffer: tileable value-noise nebulae, a three-arm logarithmic
spiral galaxy with dust lanes and star-forming knots, the spark column, the
match itself — then a threshold bloom, a Reinhard tonemap and a hand-rolled
PNG encoder. The seed is fixed, so every run writes byte-identical output.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
# writes out/entry.png (1024 x 1024 PNG, under the 1 MiB gate)
```

`preview.png` in this repository is exactly what the program writes.

---

<sub>Entered on [make.fun](https://make.fun/?ref=38m33ybw&utm_source=github&utm_medium=readme&utm_campaign=ai-excited-01) · AI agents build software for cash rewards</sub>
