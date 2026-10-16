import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  arrangeGrid,
  computeRects,
  gridShape,
  insert,
  leaf,
  leafIds,
  move,
  neighbour,
  normalize,
  reconcile,
  remove,
  resizeSizes,
  sanitize,
  setSizesAt,
  swap,
  zoneAt,
  type LayoutNode,
  type Split,
} from '../src/shared/layout';

const row = (...children: LayoutNode[]): Split => ({ kind: 'split', dir: 'row', children, sizes: children.map(() => 1 / children.length) });
const column = (...children: LayoutNode[]): Split => ({ kind: 'split', dir: 'column', children, sizes: children.map(() => 1 / children.length) });

function sumsToOne(node: LayoutNode | null): void {
  if (!node || node.kind === 'leaf') return;
  const total = node.sizes.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(total - 1) < 1e-9, `sizes sum to ${total}`);
  assert.equal(node.sizes.length, node.children.length);
  node.children.forEach(sumsToOne);
}

describe('insert', () => {
  it('starts a tree from nothing', () => {
    assert.deepEqual(insert(null, 'a', undefined, 'right'), leaf('a'));
  });

  it('splits a single tile', () => {
    const tree = insert(leaf('a'), 'b', 'a', 'right');
    assert.deepEqual(tree, { kind: 'split', dir: 'row', children: [leaf('a'), leaf('b')], sizes: [0.5, 0.5] });
  });

  it('puts the new tile before the target for left and top', () => {
    assert.deepEqual(leafIds(insert(leaf('a'), 'b', 'a', 'left')), ['b', 'a']);
    assert.deepEqual(leafIds(insert(leaf('a'), 'b', 'a', 'top')), ['b', 'a']);
  });

  it('joins an existing split on the same axis and halves the target', () => {
    const tree = insert(row(leaf('a'), leaf('b')), 'c', 'a', 'right') as Split;
    assert.deepEqual(leafIds(tree), ['a', 'c', 'b']);
    assert.deepEqual(tree.sizes, [0.25, 0.25, 0.5]);
  });

  it('nests a split on the other axis', () => {
    const tree = insert(row(leaf('a'), leaf('b')), 'c', 'b', 'bottom') as Split;
    assert.equal(tree.dir, 'row');
    assert.deepEqual(tree.children[1], { kind: 'split', dir: 'column', children: [leaf('b'), leaf('c')], sizes: [0.5, 0.5] });
  });

  it('adds along the board edge when the target is unknown', () => {
    const tree = insert(row(leaf('a'), leaf('b')), 'c', 'nope', 'right') as Split;
    assert.deepEqual(leafIds(tree), ['a', 'b', 'c']);
    sumsToOne(tree);
  });
});

describe('remove', () => {
  it('collapses a split left with one child', () => {
    assert.deepEqual(remove(row(leaf('a'), leaf('b')), 'a'), leaf('b'));
  });

  it('returns null for the last tile', () => {
    assert.equal(remove(leaf('a'), 'a'), null);
  });

  it('gives the freed space to the neighbours and merges same-direction splits', () => {
    const tree = row(leaf('a'), column(leaf('b'), row(leaf('c'), leaf('d'))));
    const next = remove(tree, 'b') as Split;
    assert.equal(next.dir, 'row');
    assert.deepEqual(leafIds(next), ['a', 'c', 'd']);
    assert.equal(next.children.length, 3);
    sumsToOne(next);
  });
});

describe('move and swap', () => {
  it('swaps two tiles on center', () => {
    assert.deepEqual(leafIds(move(row(leaf('a'), leaf('b')), 'a', 'b', 'center')), ['b', 'a']);
  });

  it('moves a tile under another one', () => {
    const tree = move(row(leaf('a'), leaf('b'), leaf('c')), 'a', 'c', 'bottom') as Split;
    assert.deepEqual(leafIds(tree), ['b', 'c', 'a']);
    assert.equal(tree.children[1]?.kind, 'split');
    sumsToOne(tree);
  });

  it('ignores a drop onto itself', () => {
    const tree = row(leaf('a'), leaf('b'));
    assert.equal(move(tree, 'a', 'a', 'left'), tree);
  });

  it('swap keeps the shape', () => {
    const tree = row(leaf('a'), column(leaf('b'), leaf('c')));
    assert.deepEqual(swap(tree, 'a', 'c'), row(leaf('c'), column(leaf('b'), leaf('a'))));
  });
});

describe('grid', () => {
  it('puts two tiles side by side on a wide board', () => {
    assert.deepEqual(gridShape(2, 1600, 1000), { cols: 2, rows: 1 });
  });

  it('makes 2x2 for four tiles', () => {
    assert.deepEqual(gridShape(4, 1600, 1000), { cols: 2, rows: 2 });
  });

  it('makes 3x2 for six tiles', () => {
    assert.deepEqual(gridShape(6, 1600, 1000), { cols: 3, rows: 2 });
  });

  it('stacks on a tall board', () => {
    assert.deepEqual(gridShape(2, 600, 1400), { cols: 1, rows: 2 });
  });

  it('never leaves a whole row empty', () => {
    for (let n = 1; n <= 16; n++) {
      const { cols, rows } = gridShape(n, 1600, 1000);
      assert.ok(cols * rows >= n);
      assert.ok((rows - 1) * cols < n, `n=${n} cols=${cols} rows=${rows}`);
    }
  });

  it('keeps the order and balances rows', () => {
    const tree = arrangeGrid(['a', 'b', 'c', 'd', 'e'], 1600, 1000) as Split;
    assert.deepEqual(leafIds(tree), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(tree.dir, 'column');
    assert.deepEqual(
      tree.children.map((c) => leafIds(c).length),
      [3, 2],
    );
    sumsToOne(tree);
  });

  it('handles zero and one tile', () => {
    assert.equal(arrangeGrid([], 100, 100), null);
    assert.deepEqual(arrangeGrid(['a'], 100, 100), leaf('a'));
  });
});

describe('computeRects', () => {
  it('fills the bounds and leaves gaps for splitters', () => {
    const { tiles, splitters } = computeRects(row(leaf('a'), leaf('b')), { x: 0, y: 0, w: 206, h: 100 }, 6);
    assert.deepEqual(tiles.get('a'), { x: 0, y: 0, w: 100, h: 100 });
    assert.deepEqual(tiles.get('b'), { x: 106, y: 0, w: 100, h: 100 });
    assert.equal(splitters.length, 1);
    assert.deepEqual(splitters[0]?.rect, { x: 100, y: 0, w: 6, h: 100 });
    assert.equal(splitters[0]?.span, 200);
    assert.deepEqual(splitters[0]?.path, []);
  });

  it('reports nested splitter paths', () => {
    const { splitters } = computeRects(row(leaf('a'), column(leaf('b'), leaf('c'))), { x: 0, y: 0, w: 200, h: 200 }, 4);
    assert.deepEqual(
      splitters.map((s) => [s.path, s.index, s.dir]),
      [
        [[], 0, 'row'],
        [[1], 0, 'column'],
      ],
    );
  });
});

describe('resize', () => {
  it('moves the boundary by pixels', () => {
    const sizes = resizeSizes([0.5, 0.5], 0, 100, 1000, 50);
    assert.ok(Math.abs((sizes[0] ?? 0) - 0.6) < 1e-9);
    assert.ok(Math.abs((sizes[1] ?? 0) - 0.4) < 1e-9);
  });

  it('keeps the minimum size', () => {
    const sizes = resizeSizes([0.5, 0.5], 0, 900, 1000, 100);
    assert.ok(Math.abs((sizes[1] ?? 0) - 0.1) < 1e-9);
  });

  it('only touches the two neighbours', () => {
    const sizes = resizeSizes([0.2, 0.3, 0.5], 1, -50, 1000, 10);
    assert.equal(sizes[0], 0.2);
    assert.ok(Math.abs((sizes[1] ?? 0) - 0.25) < 1e-9);
    assert.ok(Math.abs((sizes[2] ?? 0) - 0.55) < 1e-9);
  });

  it('setSizesAt updates a nested split', () => {
    const tree = setSizesAt(row(leaf('a'), column(leaf('b'), leaf('c'))), [1], [0.75, 0.25]) as Split;
    assert.deepEqual((tree.children[1] as Split).sizes, [0.75, 0.25]);
  });
});

describe('zones and neighbours', () => {
  const rect = { x: 0, y: 0, w: 100, h: 100 };

  it('detects edges and the middle', () => {
    assert.equal(zoneAt(rect, 5, 50), 'left');
    assert.equal(zoneAt(rect, 95, 50), 'right');
    assert.equal(zoneAt(rect, 50, 5), 'top');
    assert.equal(zoneAt(rect, 50, 95), 'bottom');
    assert.equal(zoneAt(rect, 50, 50), 'center');
  });

  it('finds the tile in a direction', () => {
    const { tiles } = computeRects(row(leaf('a'), column(leaf('b'), leaf('c'))), { x: 0, y: 0, w: 200, h: 200 }, 0);
    assert.equal(neighbour(tiles, 'a', 'right'), 'b');
    assert.equal(neighbour(tiles, 'b', 'bottom'), 'c');
    assert.equal(neighbour(tiles, 'c', 'left'), 'a');
    assert.equal(neighbour(tiles, 'a', 'left'), undefined);
  });
});

describe('sanitize and reconcile', () => {
  it('drops unknown and duplicate ids and junk', () => {
    const raw = { kind: 'split', dir: 'row', children: [leaf('a'), leaf('x'), leaf('a'), { kind: 'bad' }, leaf('b')], sizes: [1, 1, 1, 1, 1] };
    const tree = sanitize(raw, new Set(['a', 'b']));
    assert.deepEqual(leafIds(tree), ['a', 'b']);
    sumsToOne(tree);
  });

  it('rejects non-objects', () => {
    assert.equal(sanitize('nope', new Set(['a'])), null);
    assert.equal(sanitize(null, new Set(['a'])), null);
  });

  it('repairs bad sizes', () => {
    const tree = sanitize({ kind: 'split', dir: 'row', children: [leaf('a'), leaf('b')], sizes: [-1, 'x'] }, new Set(['a', 'b'])) as Split;
    assert.deepEqual(tree.sizes, [0.5, 0.5]);
  });

  it('adds missing terminals and removes closed ones', () => {
    const tree = reconcile(row(leaf('a'), leaf('gone')), ['a', 'b', 'c'], 1600, 1000);
    assert.deepEqual(new Set(leafIds(tree)), new Set(['a', 'b', 'c']));
    sumsToOne(tree);
  });

  it('normalize merges nested same-direction splits', () => {
    const tree = normalize(row(leaf('a'), row(leaf('b'), leaf('c')))) as Split;
    assert.equal(tree.children.length, 3);
    assert.deepEqual(tree.sizes, [0.5, 0.25, 0.25]);
  });
});
