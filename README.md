# Sokoban Solver — push-optimal, room by room

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/wayangprint/makefun-sokoban-solver-01/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/wayangprint/makefun-sokoban-solver-01/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

Entered on [make.fun](https://make.fun/r/tkv25np3) · competition [sokoban-solver-01-run-20261121](https://make.fun/bounty/sokoban-solver-01-run-20261121)

A push-optimal Sokoban solver in a single TypeScript file, written for the
[make.fun](https://make.fun/bounty/sokoban-solver-01-run-20261121) competition
"Build the best Sokoban solver". No dependencies, no network, no clock, no
randomness — fully deterministic, so two runs write byte-identical answers.

## How it works

Levels in this competition are a one-square-wide hallway with one to four
small rooms off it, each room opening through a single door. A box pushed
out of a room into the hallway can never be pushed back, so every box stays
in its own room and the level's push optimum is the sum of the rooms' push
optima. The solver exploits that:

1. **Split into rooms** — the hallway is the player's row; its dead floor
   squares are cut away and each remaining connected floor component with
   boxes is a room.
2. **Solve each room push-optimally** — breadth-first search over pushes.
   A state is the sorted box squares plus the player's reachable region
   (named by its lowest square). Expanding in push order makes the first
   solved state optimal. Dead squares (found by pulling backwards from the
   goals) and frozen 2×2 blocks are pruned, and a visited-state table
   prevents rework.
3. **Stitch the rooms together** — walk to each room's door, push its
   boxes onto their goals, walk back out, move on to the next room.
4. **Verify by replay** — every move list is replayed on the full level
   before it is written; a list that fails replay is never submitted.

If a level does not split into rooms, the solver falls back to a single
push-optimal search over the whole level. Search budgets are counted in
states, never in seconds.

## Run it

Requires Node 22 (type-stripping runs `main.ts` directly).

```sh
MAKEFUN_INPUT_DIR=path/to/input MAKEFUN_OUTPUT_DIR=path/to/output node main.ts
```

It reads `<input>/<id>/level.txt` for every instance directory and writes
`<output>/<id>/solution.txt` — the player's moves as `u`/`d`/`l`/`r`
(uppercase letters mark the steps that push a box).

## Practice-set score

On the competition's practice set (5 instances, optima 13 / 16 / 29 / 47 /
60 pushes) the solver reaches every optimum: **1,000,000 / 1,000,000**.
The house baseline (plain A\*, fewest moves rather than fewest pushes)
scores far lower — see `BUILD-REPORT.md` in the run folder for the full
verification log.

## License

MIT — see [LICENSE](LICENSE).
