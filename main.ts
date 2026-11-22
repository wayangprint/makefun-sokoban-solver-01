// Sokoban solver: push-optimal, room by room.
//
// How it works, in brief:
//   * A level is a one-square-wide hallway with one to four small rooms off
//     it, each room opening onto the hallway through a single door. A box
//     pushed out of a room into the hallway can never be pushed back, so
//     every box stays in its own room and the level's push optimum is the
//     sum of the rooms' push optima. The solver therefore splits the level
//     into rooms and solves each room on its own.
//   * One room is solved with a breadth-first search over pushes: a state
//     is the sorted box squares plus the player's reachable region (named
//     by its lowest square). Expanding states in order of pushes made makes
//     the first solved state found push-optimal for that room.
//   * Two deadlocks are pruned, neither of which can cut a solvable state:
//     dead squares (a box standing on one can never reach any goal, found
//     by pulling backwards from the goals) and frozen 2x2 blocks of walls
//     and boxes holding a box off its goal. A visited-state table keeps the
//     search from revisiting a state.
//   * Rooms are stitched together by walking: the player walks to a room's
//     door, pushes the room's boxes onto their goals, walks back out, and
//     moves on to the next room. Every finished move list is replayed on
//     the full level before it is written out.
//   * Fully deterministic: no clock, no randomness, no environment input
//     beyond the two MAKEFUN_* directories. Search budgets are counted in
//     states, never in seconds, and every tie is broken by fixed order.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, counted in states. A room that needs more than the first
// budget gets one retry with the larger one before the solver falls back
// to a search over the whole level.
const ROOM_STATE_CAP = 250_000;
const ROOM_STATE_CAP_RETRY = 1_000_000;
const WHOLE_STATE_CAP = 250_000;

interface Step {
  dx: number;
  dy: number;
  walk: string;
  push: string;
}

// Fixed expansion order: up, down, left, right. Every tie in the search
// and in every walk breaks this way, so two runs answer byte for byte.
const DIRS: Step[] = [
  { dx: 0, dy: -1, walk: 'u', push: 'U' },
  { dx: 0, dy: 1, walk: 'd', push: 'D' },
  { dx: -1, dy: 0, walk: 'l', push: 'L' },
  { dx: 1, dy: 0, walk: 'r', push: 'R' },
];

interface Board {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Room {
  id: number;
  boxes: number[];
  goals: number[];
}

const at = (b: Board, x: number, y: number): number => y * b.w + x;
const inBoard = (b: Board, x: number, y: number): boolean =>
  x >= 0 && y >= 0 && x < b.w && y < b.h;
const isFloor = (b: Board, x: number, y: number): boolean =>
  inBoard(b, x, y) && b.wall[at(b, x, y)] === 0;

/** Parse XSB text. Short rows and anything outside the rows are walls. */
function parseLevel(text: string): Board {
  const rows = text
    .split('\n')
    .map((r) => (r.endsWith('\r') ? r.slice(0, -1) : r))
    .filter((r) => r.length > 0);
  const h = rows.length;
  const w = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = at({ w, h } as Board, x, y);
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') {
        goal[i] = 1;
        goals.push(i);
      }
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, goals, boxes, player };
}

/**
 * The squares from which a lone box can still be pushed onto some goal.
 * Found by pulling backwards from the goals: a box on square F can be
 * pushed to a live square L when the player can stand on the far side of
 * F, that is, when both F and the square beyond it (away from L) are
 * floor. Goals themselves are live.
 */
function liveSquares(b: Board): Uint8Array {
  const live = new Uint8Array(b.w * b.h);
  const queue: number[] = [];
  for (const g of b.goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi]!;
    const cx = c % b.w;
    const cy = Math.floor(c / b.w);
    for (const d of DIRS) {
      const fx = cx - d.dx;
      const fy = cy - d.dy;
      const sx = fx - d.dx;
      const sy = fy - d.dy;
      if (!isFloor(b, fx, fy) || !isFloor(b, sx, sy)) continue;
      const fi = at(b, fx, fy);
      if (live[fi] === 1) continue;
      live[fi] = 1;
      queue.push(fi);
    }
  }
  return live;
}

/**
 * Flood-fill the player's reachable region from `start` (boxes in
 * `blocked` count as walls) and return its lowest square. `seen`/`stamp`
 * mark the region so callers can test membership afterwards; `stack` is
 * scratch space reused across calls.
 */
function markRegion(
  b: Board,
  blocked: Uint8Array,
  start: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  let low = start;
  let n = 0;
  stack[n++] = start;
  seen[start] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const px = p % b.w;
    const py = Math.floor(p / b.w);
    for (const d of DIRS) {
      const qx = px + d.dx;
      const qy = py + d.dy;
      if (!inBoard(b, qx, qy)) continue;
      const q = at(b, qx, qy);
      if (b.wall[q] === 0 && blocked[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

/**
 * Whether the box just pushed onto `cell` is caught in a frozen 2x2
 * block: four squares, each a wall or a box, holding at least one box
 * off its goal. Such a box can never move again, so the state is dead.
 * Squares outside the board count as walls.
 */
function frozenAt(b: Board, occupied: Uint8Array, cell: number): boolean {
  const x = cell % b.w;
  const y = Math.floor(cell / b.w);
  const corners: [number, number][] = [
    [x, y],
    [x - 1, y],
    [x, y - 1],
    [x - 1, y - 1],
  ];
  for (const [bx, by] of corners) {
    let sealed = true;
    let stranded = false;
    for (const [cx, cy] of [
      [bx, by],
      [bx + 1, by],
      [bx, by + 1],
      [bx + 1, by + 1],
    ] as [number, number][]) {
      if (!inBoard(b, cx, cy)) continue; // outside the board: a wall
      const ci = at(b, cx, cy);
      if (b.wall[ci] === 0 && occupied[ci] === 0) {
        sealed = false;
        break;
      }
      if (occupied[ci] === 1 && b.goal[ci] === 0) stranded = true;
    }
    if (sealed && stranded) return true;
  }
  return false;
}

/** Shortest walk from `from` to `to` around walls and boxes, or null. */
function walkTo(
  b: Board,
  blocked: Uint8Array,
  from: number,
  to: number,
): string | null {
  if (from === to) return '';
  const size = b.w * b.h;
  const prev = new Int32Array(size).fill(-1);
  const how: string[] = new Array<string>(size);
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    const px = p % b.w;
    const py = Math.floor(p / b.w);
    for (const d of DIRS) {
      const qx = px + d.dx;
      const qy = py + d.dy;
      if (!inBoard(b, qx, qy)) continue;
      const q = at(b, qx, qy);
      if (b.wall[q] === 1 || blocked[q] === 1 || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = d.walk;
      queue.push(q);
    }
  }
  if (prev[to] === -1) return null;
  let out = '';
  for (let p = to; p !== from; p = prev[p]!) out = how[p]! + out;
  return out;
}

interface PushSolution {
  pushes: number;
  moves: string;
}

/**
 * Push-optimal solution of one board (a whole level or a single room cut
 * out of it), or null when the search runs out of its state budget or
 * the board has no solution. States expand in push order, so the first
 * solved state met is optimal; the visited table keys a state by its
 * sorted boxes plus its region's lowest square.
 */
function pushBfs(b: Board, cap: number): PushSolution | null {
  const size = b.w * b.h;
  const live = liveSquares(b);
  for (const box of b.boxes) if (live[box] === 0) return null;
  const solved = (boxes: number[]): boolean =>
    boxes.every((x) => b.goal[x] === 1);
  if (solved(b.boxes)) return { pushes: 0, moves: '' };
  if (b.player < 0) return null;

  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  const occupied = new Uint8Array(size);
  let stamp = 0;

  const keyOf = (boxes: number[], low: number): string =>
    boxes.join(',') + '#' + low;

  // Parallel arrays hold every state found: its boxes, the player's
  // square after the push that made it, and its parent plus that push.
  const sBoxes: number[][] = [b.boxes.slice()];
  const sPlayer: number[] = [b.player];
  const sParent: number[] = [-1];
  const sFrom: number[] = [-1];
  const sTo: number[] = [-1];
  const index = new Map<string, number>();
  for (const box of b.boxes) occupied[box] = 1;
  const startLow = markRegion(b, occupied, b.player, seen, ++stamp, stack);
  for (const box of b.boxes) occupied[box] = 0;
  index.set(keyOf(b.boxes, startLow), 0);

  let found = -1;
  for (let head = 0; head < sBoxes.length && found < 0; head++) {
    const boxes = sBoxes[head]!;
    const player = sPlayer[head]!;
    for (const box of boxes) occupied[box] = 1;
    markRegion(b, occupied, player, seen, ++stamp, stack);
    const regionStamp = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const box = boxes[bi]!;
      const bx = box % b.w;
      const by = Math.floor(box / b.w);
      for (const d of DIRS) {
        const tx = bx + d.dx;
        const ty = by + d.dy;
        if (!inBoard(b, tx, ty)) continue;
        const dest = at(b, tx, ty);
        if (b.wall[dest] === 1 || occupied[dest] === 1 || live[dest] === 0) continue;
        const sx = bx - d.dx;
        const sy = by - d.dy;
        if (!inBoard(b, sx, sy)) continue;
        if (seen[at(b, sx, sy)] !== regionStamp) continue;
        // Try the push: box moves to dest, player ends on its old square.
        occupied[box] = 0;
        occupied[dest] = 1;
        let nextBoxes: number[] | null = null;
        let nextKey = '';
        if (!frozenAt(b, occupied, dest)) {
          nextBoxes = boxes.slice();
          nextBoxes[bi] = dest;
          nextBoxes.sort((p, q) => p - q);
          const low = markRegion(b, occupied, box, mark, ++stamp, stack);
          nextKey = keyOf(nextBoxes, low);
          if (index.has(nextKey)) nextBoxes = null;
        }
        occupied[dest] = 0;
        occupied[box] = 1;
        if (nextBoxes === null) continue;
        if (sBoxes.length >= cap) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        index.set(nextKey, sBoxes.length);
        sBoxes.push(nextBoxes);
        sPlayer.push(box);
        sParent.push(head);
        sFrom.push(box);
        sTo.push(dest);
        if (solved(nextBoxes)) {
          found = sBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the move list: for each push on the path, walk the player to
  // the square behind the box, then push.
  const chain: number[] = [];
  for (let s = found; s > 0; s = sParent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = b.player;
  let boxes = b.boxes.slice();
  for (const s of chain) {
    const nextBoxes = sBoxes[s]!;
    const fromBox = sFrom[s]!;
    const toBox = sTo[s]!;
    const d = DIRS.find(
      (dd) => dd.dy * b.w + dd.dx === toBox - fromBox,
    )!;
    for (const x of boxes) occupied[x] = 1;
    const walk = walkTo(b, occupied, player, fromBox - (d.dy * b.w + d.dx));
    for (const x of boxes) occupied[x] = 0;
    if (walk === null) return null;
    moves += walk + d.push;
    player = fromBox;
    boxes = nextBoxes;
  }
  return { pushes: chain.length, moves };
}

/**
 * Split a level into rooms. The hallway is the player's row; its floor
 * squares from which no box can reach a goal are cut away, and each
 * remaining connected floor component holding boxes is a room. Returns
 * null when the level is not a hallway plus rooms (a box in the hallway,
 * a goal outside any room, or a room whose box and goal counts differ).
 */
function roomsOf(b: Board): Room[] | null {
  const live = liveSquares(b);
  const hallRow = Math.floor(b.player / b.w);
  const cut = new Uint8Array(b.w * b.h);
  for (let x = 0; x < b.w; x++) {
    const i = at(b, x, hallRow);
    if (b.wall[i] === 0 && live[i] === 0) cut[i] = 1;
  }
  if (b.boxes.some((box) => cut[box] === 1)) return null;

  const comp = new Int32Array(b.w * b.h).fill(-1);
  const comps: number[][] = [];
  for (let s = 0; s < b.w * b.h; s++) {
    if (b.wall[s] === 1 || cut[s] === 1 || comp[s] >= 0) continue;
    const id = comps.length;
    const squares: number[] = [s];
    comp[s] = id;
    for (let i = 0; i < squares.length; i++) {
      const p = squares[i]!;
      const px = p % b.w;
      const py = Math.floor(p / b.w);
      for (const d of DIRS) {
        const qx = px + d.dx;
        const qy = py + d.dy;
        if (!inBoard(b, qx, qy)) continue;
        const q = at(b, qx, qy);
        if (b.wall[q] === 1 || cut[q] === 1 || comp[q] >= 0) continue;
        comp[q] = id;
        squares.push(q);
      }
    }
    comps.push(squares);
  }

  const rooms: Room[] = comps.map((_, id) => ({ id, boxes: [], goals: [] }));
  for (const box of b.boxes) rooms[comp[box]!]!.boxes.push(box);
  for (const g of b.goals) {
    if (comp[g]! < 0) return null;
    rooms[comp[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** Replay a move string on a board; null when any step is illegal. */
function simulate(
  b: Board,
  boxes: number[],
  player: number,
  moves: string,
): { boxes: number[]; player: number } | null {
  const boxAt = new Map<number, number>();
  boxes.forEach((cell, i) => boxAt.set(cell, i));
  let p = player;
  const out = boxes.slice();
  for (const ch of moves.toLowerCase()) {
    const d = DIRS.find((dd) => dd.walk === ch);
    if (d === undefined) return null;
    const px = p % b.w;
    const py = Math.floor(p / b.w);
    const nx = px + d.dx;
    const ny = py + d.dy;
    if (!inBoard(b, nx, ny)) return null;
    const next = at(b, nx, ny);
    if (b.wall[next] === 1) return null;
    const hit = boxAt.get(next);
    if (hit !== undefined) {
      const bx = nx + d.dx;
      const by = ny + d.dy;
      if (!inBoard(b, bx, by)) return null;
      const beyond = at(b, bx, by);
      if (b.wall[beyond] === 1 || boxAt.has(beyond)) return null;
      boxAt.delete(next);
      boxAt.set(beyond, hit);
      out[hit] = beyond;
    }
    p = next;
  }
  return { boxes: out, player: p };
}

/** Solve the level room by room, in room order (scan order). */
function solveRooms(b: Board, rooms: Room[]): string | null {
  const done = new Set<number>();
  let player = b.player;
  let boxes = b.boxes.slice();
  let moves = '';
  for (const room of rooms) {
    // The sub-board is the whole level with every other room's boxes
    // walled off (a finished room's boxes sit on its goals, so its
    // goals are the walls instead). The player walks in from wherever
    // the previous room left it.
    const wall = b.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const fill = done.has(other.id) ? other.goals : other.boxes;
      for (const cell of fill) wall[cell] = 1;
    }
    const goal = new Uint8Array(b.w * b.h);
    for (const g of room.goals) goal[g] = 1;
    const sub: Board = {
      w: b.w,
      h: b.h,
      wall,
      goal,
      goals: room.goals.slice().sort((p, q) => p - q),
      boxes: room.boxes.slice().sort((p, q) => p - q),
      player,
    };
    let solved = pushBfs(sub, ROOM_STATE_CAP);
    if (solved === null) solved = pushBfs(sub, ROOM_STATE_CAP_RETRY);
    if (solved === null) return null;
    const stepped = simulate(b, boxes, player, solved.moves);
    if (stepped === null) return null;
    boxes = stepped.boxes;
    player = stepped.player;
    moves += solved.moves;
    done.add(room.id);
  }
  return moves;
}

/** Fallback: one push-optimal search over the whole level. */
function solveWhole(b: Board): string | null {
  const solved = pushBfs(b, WHOLE_STATE_CAP);
  return solved === null ? null : solved.moves;
}

/** Solve one level's text, returning moves or '' when unsolved. */
function solveLevel(text: string): string {
  const b = parseLevel(text);
  if (b.player < 0 || b.boxes.length === 0) return '';
  if (b.boxes.every((x) => b.goal[x] === 1)) return '';
  if (b.boxes.length !== b.goals.length) return '';

  let moves: string | null = null;
  const rooms = roomsOf(b);
  if (rooms !== null) moves = solveRooms(b, rooms);
  if (moves === null) moves = solveWhole(b);
  if (moves === null) return '';

  // Never trust a move list without replaying it on the full level.
  const end = simulate(b, b.boxes.slice(), b.player, moves);
  if (end === null || !end.boxes.every((x) => b.goal[x] === 1)) {
    if (rooms !== null) {
      const retry = solveWhole(b);
      if (retry !== null) {
        const again = simulate(b, b.boxes.slice(), b.player, retry);
        if (again !== null && again.boxes.every((x) => b.goal[x] === 1)) {
          return retry;
        }
      }
    }
    return '';
  }
  return moves;
}

for (const entry of readdirSync(INPUT_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()) {
  let moves = '';
  try {
    moves = solveLevel(readFileSync(join(INPUT_DIR, entry, 'level.txt'), 'utf8'));
  } catch {
    moves = '';
  }
  mkdirSync(join(OUTPUT_DIR, entry), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, entry, 'solution.txt'), moves + '\n');
}
