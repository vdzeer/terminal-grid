// The board layout is a split tree, the same model VS Code uses for editor
// groups. Every function here is pure: it takes a tree and returns a new one.

export type Dir = 'row' | 'column';
export type Edge = 'left' | 'right' | 'top' | 'bottom';
export type Zone = Edge | 'center';

export interface Leaf {
  kind: 'leaf';
  id: string;
}

export interface Split {
  kind: 'split';
  /** `row` puts children side by side, `column` stacks them. */
  dir: Dir;
  children: LayoutNode[];
  /** Fractions of the split's length, one per child, summing to 1. */
  sizes: number[];
}

export type LayoutNode = Leaf | Split;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SplitterRect {
  /** Child indexes from the root down to the split this splitter belongs to. */
  path: number[];
  /** The splitter sits between child `index` and child `index + 1`. */
  index: number;
  dir: Dir;
  rect: Rect;
  /** Pixel length of the split along its axis, minus the gaps. */
  span: number;
}

export interface Placement {
  targetId: string;
  zone: Edge;
}

export const leaf = (id: string): Leaf => ({ kind: 'leaf', id });

export function axisOf(edge: Edge): Dir {
  return edge === 'left' || edge === 'right' ? 'row' : 'column';
}

function isBefore(edge: Edge): boolean {
  return edge === 'left' || edge === 'top';
}

export function leafIds(node: LayoutNode | null): string[] {
  if (!node) return [];
  if (node.kind === 'leaf') return [node.id];
  return node.children.flatMap(leafIds);
}

export function contains(node: LayoutNode | null, id: string): boolean {
  return leafIds(node).includes(id);
}

function equalSizes(n: number): number[] {
  return Array.from({ length: n }, () => 1 / n);
}

function normalizeSizes(sizes: number[]): number[] {
  const clean = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (total <= 0) return equalSizes(sizes.length);
  return clean.map((s) => s / total);
}

/**
 * Drops single-child splits, merges a split into its parent when both run in
 * the same direction, and makes the sizes of every split sum to 1.
 */
export function normalize(node: LayoutNode | null): LayoutNode | null {
  if (!node || node.kind === 'leaf') return node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  const own = normalizeSizes(node.sizes.length === node.children.length ? node.sizes : equalSizes(node.children.length));
  node.children.forEach((raw, i) => {
    const child = normalize(raw);
    if (!child) return;
    const size = own[i] ?? 0;
    if (child.kind === 'split' && child.dir === node.dir) {
      child.children.forEach((grandchild, j) => {
        children.push(grandchild);
        sizes.push(size * (child.sizes[j] ?? 0));
      });
    } else {
      children.push(child);
      sizes.push(size);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0] ?? null;
  return { kind: 'split', dir: node.dir, children, sizes: normalizeSizes(sizes) };
}

/**
 * Puts `newId` next to `targetId` on the given edge. Without a target (or with
 * one that is not in the tree) the new tile goes along that edge of the board.
 */
export function insert(root: LayoutNode | null, newId: string, targetId: string | undefined, edge: Edge): LayoutNode {
  const fresh = leaf(newId);
  if (!root) return fresh;
  const axis = axisOf(edge);
  const before = isBefore(edge);

  if (targetId === undefined || !contains(root, targetId)) {
    if (root.kind === 'split' && root.dir === axis) {
      const n = root.children.length;
      const scaled = root.sizes.map((s) => (s * n) / (n + 1));
      return {
        ...root,
        children: before ? [fresh, ...root.children] : [...root.children, fresh],
        sizes: before ? [1 / (n + 1), ...scaled] : [...scaled, 1 / (n + 1)],
      };
    }
    return { kind: 'split', dir: axis, children: before ? [fresh, root] : [root, fresh], sizes: [0.5, 0.5] };
  }

  const place = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') {
      if (node.id !== targetId) return node;
      return { kind: 'split', dir: axis, children: before ? [fresh, node] : [node, fresh], sizes: [0.5, 0.5] };
    }
    const index = node.children.findIndex((c) => c.kind === 'leaf' && c.id === targetId);
    if (index >= 0 && node.dir === axis) {
      const half = (node.sizes[index] ?? 0) / 2;
      const children = [...node.children];
      const sizes = [...node.sizes];
      sizes[index] = half;
      children.splice(before ? index : index + 1, 0, fresh);
      sizes.splice(before ? index : index + 1, 0, half);
      return { ...node, children, sizes };
    }
    return { ...node, children: node.children.map(place) };
  };
  return normalize(place(root)) ?? fresh;
}

export function remove(root: LayoutNode | null, id: string): LayoutNode | null {
  const drop = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === 'leaf') return node.id === id ? null : node;
    const children: LayoutNode[] = [];
    const sizes: number[] = [];
    node.children.forEach((child, i) => {
      const next = drop(child);
      if (next) {
        children.push(next);
        sizes.push(node.sizes[i] ?? 0);
      }
    });
    return { ...node, children, sizes };
  };
  return root ? normalize(drop(root)) : null;
}

export function swap(root: LayoutNode | null, a: string, b: string): LayoutNode | null {
  if (!root || a === b) return root;
  const walk = (node: LayoutNode): LayoutNode => {
    if (node.kind === 'leaf') {
      if (node.id === a) return leaf(b);
      if (node.id === b) return leaf(a);
      return node;
    }
    return { ...node, children: node.children.map(walk) };
  };
  return walk(root);
}

/** Moves a tile next to another one, or swaps the two for the center zone. */
export function move(root: LayoutNode | null, id: string, targetId: string, zone: Zone): LayoutNode | null {
  if (!root || id === targetId || !contains(root, id) || !contains(root, targetId)) return root;
  if (zone === 'center') return swap(root, id, targetId);
  return insert(remove(root, id), id, targetId, zone);
}

/** Columns and rows for `n` tiles on a board of `width` x `height` pixels. */
export function gridShape(n: number, width: number, height: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  const w = width > 0 ? width : 1600;
  const h = height > 0 ? height : 1000;
  // A terminal tile reads best a little wider than tall.
  const idealAspect = 1.2;
  let best = { cols: n, rows: 1, score: Number.POSITIVE_INFINITY };
  // Rows are filled evenly (see arrangeGrid), so the widest row decides the tile size.
  for (let rows = 1; rows <= n; rows++) {
    const cols = Math.ceil(n / rows);
    if ((rows - 1) * cols >= n) continue; // a whole row would stay empty
    const aspect = w / cols / (h / rows);
    const empty = rows * cols - n;
    const score = Math.abs(Math.log(aspect / idealAspect)) + (0.15 * empty) / n;
    if (score < best.score) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows };
}

/** Lays the tiles out as an even grid, keeping their order. */
export function arrangeGrid(ids: string[], width: number, height: number): LayoutNode | null {
  if (ids.length === 0) return null;
  if (ids.length === 1) return leaf(ids[0] as string);
  const { rows } = gridShape(ids.length, width, height);
  const base = Math.floor(ids.length / rows);
  const extra = ids.length % rows;
  const rowNodes: LayoutNode[] = [];
  let cursor = 0;
  for (let r = 0; r < rows; r++) {
    const count = base + (r < extra ? 1 : 0);
    const slice = ids.slice(cursor, cursor + count).map(leaf);
    cursor += count;
    const only = slice[0];
    if (slice.length === 1 && only) rowNodes.push(only);
    else rowNodes.push({ kind: 'split', dir: 'row', children: slice, sizes: equalSizes(slice.length) });
  }
  return normalize({ kind: 'split', dir: 'column', children: rowNodes, sizes: equalSizes(rows) });
}

export function nodeAt(root: LayoutNode | null, path: number[]): LayoutNode | null {
  let node: LayoutNode | null = root;
  for (const i of path) {
    if (!node || node.kind !== 'split') return null;
    node = node.children[i] ?? null;
  }
  return node;
}

export function setSizesAt(root: LayoutNode, path: number[], sizes: number[]): LayoutNode {
  if (path.length === 0) {
    if (root.kind !== 'split' || sizes.length !== root.children.length) return root;
    return { ...root, sizes: normalizeSizes(sizes) };
  }
  if (root.kind !== 'split') return root;
  const [head, ...rest] = path as [number, ...number[]];
  const child = root.children[head];
  if (!child) return root;
  const children = [...root.children];
  children[head] = setSizesAt(child, rest, sizes);
  return { ...root, children };
}

/**
 * Moves the boundary between child `index` and `index + 1` by `deltaPx`,
 * keeping both neighbours at least `minPx` long.
 */
export function resizeSizes(sizes: number[], index: number, deltaPx: number, spanPx: number, minPx: number): number[] {
  const a = sizes[index];
  const b = sizes[index + 1];
  if (a === undefined || b === undefined || spanPx <= 0) return sizes;
  const pair = a + b;
  const min = Math.min(minPx / spanPx, pair / 2);
  const nextA = Math.min(Math.max(a + deltaPx / spanPx, min), pair - min);
  const next = [...sizes];
  next[index] = nextA;
  next[index + 1] = pair - nextA;
  return next;
}

export function computeRects(
  root: LayoutNode | null,
  bounds: Rect,
  gap: number,
): { tiles: Map<string, Rect>; splitters: SplitterRect[] } {
  const tiles = new Map<string, Rect>();
  const splitters: SplitterRect[] = [];
  const walk = (node: LayoutNode, rect: Rect, path: number[]): void => {
    if (node.kind === 'leaf') {
      tiles.set(node.id, rect);
      return;
    }
    const horizontal = node.dir === 'row';
    const length = horizontal ? rect.w : rect.h;
    const span = Math.max(0, length - gap * (node.children.length - 1));
    const start = horizontal ? rect.x : rect.y;
    let offset = 0;
    node.children.forEach((child, i) => {
      const from = Math.round(start + offset);
      offset += (node.sizes[i] ?? 0) * span;
      const to = i === node.children.length - 1 ? start + length : Math.round(start + offset);
      const childRect = horizontal
        ? { x: from, y: rect.y, w: to - from, h: rect.h }
        : { x: rect.x, y: from, w: rect.w, h: to - from };
      walk(child, childRect, [...path, i]);
      if (i < node.children.length - 1) {
        splitters.push({
          path,
          index: i,
          dir: node.dir,
          span,
          rect: horizontal ? { x: to, y: rect.y, w: gap, h: rect.h } : { x: rect.x, y: to, w: rect.w, h: gap },
        });
        offset += gap;
      }
    });
  };
  if (root) walk(root, bounds, []);
  return { tiles, splitters };
}

/** Which zone of `rect` the point falls in: an edge band or the middle. */
export function zoneAt(rect: Rect, x: number, y: number): Zone {
  const px = rect.w > 0 ? (x - rect.x) / rect.w : 0.5;
  const py = rect.h > 0 ? (y - rect.y) / rect.h : 0.5;
  const distances: [Edge, number][] = [
    ['left', px],
    ['right', 1 - px],
    ['top', py],
    ['bottom', 1 - py],
  ];
  distances.sort((p, q) => p[1] - q[1]);
  const nearest = distances[0] as [Edge, number];
  return nearest[1] > 0.28 ? 'center' : nearest[0];
}

/** The part of `rect` a tile dropped on `zone` would take. */
export function zonePreview(rect: Rect, zone: Zone): Rect {
  switch (zone) {
    case 'left':
      return { ...rect, w: rect.w / 2 };
    case 'right':
      return { ...rect, x: rect.x + rect.w / 2, w: rect.w / 2 };
    case 'top':
      return { ...rect, h: rect.h / 2 };
    case 'bottom':
      return { ...rect, y: rect.y + rect.h / 2, h: rect.h / 2 };
    case 'center':
      return rect;
  }
}

/** Splits along the longer side of the tile, the way a new pane usually goes. */
export function preferredEdge(rect: Rect | undefined): Edge {
  if (!rect) return 'right';
  return rect.w >= rect.h * 1.4 ? 'right' : 'bottom';
}

/** The nearest tile in a direction, for keyboard focus moves. */
export function neighbour(tiles: Map<string, Rect>, fromId: string, edge: Edge): string | undefined {
  const from = tiles.get(fromId);
  if (!from) return undefined;
  const cx = from.x + from.w / 2;
  const cy = from.y + from.h / 2;
  let best: { id: string; score: number } | undefined;
  for (const [id, r] of tiles) {
    if (id === fromId) continue;
    let ahead: number;
    let overlap: number;
    if (edge === 'left' || edge === 'right') {
      ahead = edge === 'left' ? from.x - (r.x + r.w) : r.x - (from.x + from.w);
      overlap = Math.min(from.y + from.h, r.y + r.h) - Math.max(from.y, r.y);
    } else {
      ahead = edge === 'top' ? from.y - (r.y + r.h) : r.y - (from.y + from.h);
      overlap = Math.min(from.x + from.w, r.x + r.w) - Math.max(from.x, r.x);
    }
    if (ahead < -1 || overlap <= 0) continue;
    const rx = r.x + r.w / 2;
    const ry = r.y + r.h / 2;
    const score = ahead * 1000 + Math.hypot(rx - cx, ry - cy);
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id;
}

/**
 * Reads a layout that came from storage or from the webview. Anything that is
 * not a well-formed tree of known ids is dropped; each id appears once.
 */
export function sanitize(raw: unknown, valid: ReadonlySet<string>): LayoutNode | null {
  const seen = new Set<string>();
  const read = (value: unknown, depth: number): LayoutNode | null => {
    if (depth > 32 || typeof value !== 'object' || value === null) return null;
    const v = value as Record<string, unknown>;
    if (v.kind === 'leaf') {
      if (typeof v.id !== 'string' || !valid.has(v.id) || seen.has(v.id)) return null;
      seen.add(v.id);
      return leaf(v.id);
    }
    if (v.kind === 'split' && (v.dir === 'row' || v.dir === 'column') && Array.isArray(v.children)) {
      const sizes = Array.isArray(v.sizes) ? v.sizes : [];
      const children: LayoutNode[] = [];
      const kept: number[] = [];
      v.children.forEach((child, i) => {
        const node = read(child, depth + 1);
        if (!node) return;
        children.push(node);
        const s = sizes[i];
        kept.push(typeof s === 'number' ? s : 0);
      });
      return { kind: 'split', dir: v.dir, children, sizes: kept };
    }
    return null;
  };
  return normalize(read(raw, 0));
}

/** Makes sure every id is in the tree exactly once, adding missing ones. */
export function reconcile(root: LayoutNode | null, ids: string[], width: number, height: number): LayoutNode | null {
  const valid = new Set(ids);
  let tree = sanitize(root, valid);
  for (const id of ids) {
    if (contains(tree, id)) continue;
    if (!tree) {
      tree = leaf(id);
      continue;
    }
    const { tiles } = computeRects(tree, { x: 0, y: 0, w: width || 1600, h: height || 1000 }, 0);
    let largest: { id: string; area: number; rect: Rect } | undefined;
    for (const [tid, r] of tiles) {
      if (!largest || r.w * r.h > largest.area) largest = { id: tid, area: r.w * r.h, rect: r };
    }
    tree = insert(tree, id, largest?.id, preferredEdge(largest?.rect));
  }
  return tree;
}
