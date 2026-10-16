import type { ITheme } from '@xterm/xterm';
import { translator, type Translate } from '../shared/i18n';
import { matchShortcut, shortcutLabel, type Shortcut } from '../shared/keys';
import {
  arrangeGrid,
  computeRects,
  contains,
  insert,
  leafIds,
  move,
  neighbour,
  nodeAt,
  preferredEdge,
  reconcile,
  remove,
  resizeSizes,
  setSizesAt,
  zoneAt,
  zonePreview,
  type Edge,
  type LayoutNode,
  type Placement,
  type Rect,
  type SplitterRect,
  type Zone,
} from '../shared/layout';
import type { HostMessage, Snapshot, TerminalInfo, ViewMessage, ViewSettings } from '../shared/protocol';
import { icons } from './icons';
import { onThemeChange, readTheme } from './theme';
import { Tile, type TileHost } from './tile';

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };

const vscode = acquireVsCodeApi();
/** The bottom panel gets a compact board: the panel title bar carries the actions. */
const HOST: 'panel' | 'editor' = document.body.dataset.host === 'panel' ? 'panel' : 'editor';
document.body.classList.add(`host-${HOST}`);
const GAP = 6;
const PADDING = HOST === 'panel' ? 4 : 6;
const MIN_TILE_WIDTH = 160;
const MIN_TILE_HEIGHT = 90;

type DragSource = { kind: 'tile'; id: string } | { kind: 'new' };
interface DropTarget {
  id?: string;
  zone: Zone;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, html?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (html !== undefined) node.innerHTML = html;
  return node;
}

function place(node: HTMLElement, rect: Rect): void {
  node.style.left = `${rect.x}px`;
  node.style.top = `${rect.y}px`;
  node.style.width = `${Math.max(0, rect.w)}px`;
  node.style.height = `${Math.max(0, rect.h)}px`;
}

class App implements TileHost {
  t: Translate = translator('en');
  isMac = /Mac/.test(navigator.platform);
  private settings: ViewSettings | undefined;
  private theme: ITheme;
  private readonly tiles = new Map<string, Tile>();
  private layout: LayoutNode | null = null;
  private sentLayout = '';
  private rects = new Map<string, Rect>();
  private splitterSpecs: SplitterRect[] = [];
  private readonly splitterEls: HTMLDivElement[] = [];
  private focusedId: string | undefined;
  private zoomedId: string | undefined;
  private liveResizing = false;
  private suppressClick = false;
  private initialised = false;

  private readonly board: HTMLDivElement;
  private readonly newButton: HTMLButtonElement;
  private readonly arrangeButton: HTMLButtonElement;
  private readonly empty: HTMLDivElement;
  private readonly dropIndicator: HTMLDivElement;
  private readonly ghost: HTMLDivElement;

  constructor(root: HTMLElement) {
    this.theme = readTheme(HOST);

    const toolbar = el('div', 'toolbar');
    toolbar.hidden = HOST === 'panel';
    this.newButton = el('button', 'tool-button primary');
    this.arrangeButton = el('button', 'tool-button');
    const spacer = el('div', 'spacer');
    toolbar.append(this.newButton, this.arrangeButton, spacer);

    this.board = el('div', 'board');
    this.empty = el('div', 'empty');
    this.dropIndicator = el('div', 'drop-indicator');
    this.dropIndicator.hidden = true;
    this.board.append(this.empty, this.dropIndicator);
    this.ghost = el('div', 'drag-ghost');
    this.ghost.hidden = true;
    root.append(toolbar, this.board, this.ghost);
    for (const b of [this.newButton, this.arrangeButton]) b.type = 'button';
    this.renderTexts();

    this.newButton.addEventListener('pointerdown', (event) => {
      if (event.button === 0) this.beginDrag({ kind: 'new' }, event, this.newButton);
    });
    this.newButton.addEventListener('click', () => {
      if (this.suppressClick) return;
      this.post({ type: 'create' });
    });
    this.arrangeButton.addEventListener('click', () => this.arrange());
    document.addEventListener('keydown', (event) => this.onDocumentKey(event));
    // Coming back to the tab focuses the webview itself; hand that on to the last terminal.
    window.addEventListener('focus', () => {
      const active = document.activeElement;
      if ((!active || active === document.body) && this.focusedId) this.focus(this.focusedId);
    });
    window.addEventListener('message', (event: MessageEvent<HostMessage>) => this.onMessage(event.data));
    let viewportTimer: number | undefined;
    const reportViewport = () => {
      window.clearTimeout(viewportTimer);
      viewportTimer = window.setTimeout(() => {
        this.post({ type: 'viewport', width: innerWidth, height: innerHeight, outerWidth, outerHeight });
      }, 30);
    };
    window.addEventListener('resize', reportViewport);
    reportViewport();
    new ResizeObserver(() => this.render(false)).observe(this.board);
    onThemeChange(() => {
      this.theme = readTheme(HOST);
      for (const tile of this.tiles.values()) tile.applyTheme(this.theme);
    });
    this.post({ type: 'ready' });
  }

  post(message: ViewMessage): void {
    vscode.postMessage(message);
  }

  private renderTexts(): void {
    const { t } = this;
    this.newButton.innerHTML = `${icons.plus}<span>${t('newTerminal')}</span>`;
    this.newButton.title = t('newTerminalHint', shortcutLabel('new', this.isMac));
    this.arrangeButton.innerHTML = `${icons.grid}<span>${t('arrange')}</span>`;
    this.arrangeButton.title = t('arrange');
    this.empty.replaceChildren();
    const art = el('div', 'empty-icon', icons.terminal);
    const title = el('div', 'empty-title');
    title.textContent = t('emptyTitle');
    const hint = el('div', 'empty-hint');
    hint.textContent = t('emptyHint');
    const create = el('button', 'tool-button primary large', `${icons.plus}<span>${t('newTerminal')}</span>`);
    create.type = 'button';
    create.addEventListener('click', () => this.post({ type: 'create' }));
    this.empty.append(art, title, hint, create);
  }

  // ---- messages ----

  private onMessage(message: HostMessage): void {
    switch (message.type) {
      case 'init':
        this.init(message);
        return;
      case 'output':
        for (const [id, data] of message.chunks) this.tiles.get(id)?.write(data);
        return;
      case 'created':
        this.onCreated(message.terminal, message.placement, message.focus, message.snapshot);
        return;
      case 'updated':
        this.tiles.get(message.terminal.id)?.update(message.terminal);
        return;
      case 'removed':
        this.removeTile(message.id);
        return;
      case 'settings':
        this.applySettings(message.settings);
        return;
      case 'arrange':
        this.arrange();
        return;
      case 'focus':
        this.focus(message.id);
        return;
    }
  }

  private init(message: Extract<HostMessage, { type: 'init' }>): void {
    for (const tile of this.tiles.values()) tile.dispose();
    this.tiles.clear();
    this.zoomedId = undefined;
    this.applySettings(message.settings);
    for (const info of message.terminals) {
      const snapshot = message.snapshots[info.id];
      const tile = this.addTile(info, snapshot);
      if (snapshot) tile.writeSnapshot(snapshot.data);
    }
    const { w, h } = this.boardSize();
    const ids = [...this.tiles.keys()];
    // Without a saved layout (first open, or a lost one) start from an even grid.
    this.layout = message.layout ? reconcile(message.layout, ids, w, h) : arrangeGrid(ids, w, h);
    this.initialised = true;
    this.render(false);
    this.openTiles();
    this.postLayout();
    const first = leafIds(this.layout)[0];
    if (first) this.focus(first);
  }

  private applySettings(settings: ViewSettings): void {
    const languageChanged = settings.language !== this.settings?.language;
    this.settings = settings;
    this.isMac = settings.platform === 'darwin';
    if (languageChanged) {
      this.t = translator(settings.language);
      document.documentElement.lang = settings.language;
      this.renderTexts();
    }
    for (const tile of this.tiles.values()) tile.applySettings(settings);
  }

  // ---- tiles ----

  private addTile(info: TerminalInfo, size?: { cols: number; rows: number }): Tile {
    if (!this.settings) throw new Error('settings arrive before terminals');
    const tile = new Tile(info, this.settings, this.theme, this, size);
    this.tiles.set(info.id, tile);
    this.board.insertBefore(tile.element, this.dropIndicator);
    return tile;
  }

  private openTiles(): void {
    for (const tile of this.tiles.values()) tile.open();
  }

  private onCreated(info: TerminalInfo, placement: Placement | undefined, focus: boolean, snapshot?: Snapshot): void {
    if (!this.initialised || this.tiles.has(info.id)) return;
    const tile = this.addTile(info, snapshot);
    if (snapshot) tile.writeSnapshot(snapshot.data);
    if (placement && contains(this.layout, placement.targetId)) {
      this.layout = insert(this.layout, info.id, placement.targetId, placement.zone);
    } else {
      const { w, h } = this.boardSize();
      this.layout = reconcile(this.layout, [...this.tiles.keys()], w, h);
    }
    this.zoomedId = undefined;
    this.render(true);
    this.openTiles();
    this.postLayout();
    if (focus) requestAnimationFrame(() => this.focus(info.id));
  }

  private removeTile(id: string): void {
    const tile = this.tiles.get(id);
    if (!tile) return;
    const rect = this.rects.get(id);
    tile.dispose();
    this.tiles.delete(id);
    this.layout = remove(this.layout, id);
    if (this.zoomedId === id) this.zoomedId = undefined;
    this.render(true);
    this.postLayout();
    if (this.focusedId === id) {
      this.focusedId = undefined;
      // Focus whichever tile took over the freed space.
      const next = rect ? this.tileAt(rect.x + rect.w / 2, rect.y + rect.h / 2) : undefined;
      const fallback = next ?? leafIds(this.layout)[0];
      if (fallback) this.focus(fallback);
    }
  }

  private tileAt(x: number, y: number): string | undefined {
    for (const [id, r] of this.rects) {
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return id;
    }
    return undefined;
  }

  focus(id: string): void {
    const tile = this.tiles.get(id);
    if (!tile) return;
    this.onTileFocus(id);
    tile.focus();
  }

  onTileFocus(id: string): void {
    if (this.focusedId === id) return;
    this.focusedId = id;
    for (const [tid, tile] of this.tiles) tile.setFocused(tid === id);
  }

  split(id: string, edge: Edge): void {
    this.post({ type: 'create', placement: { targetId: id, zone: edge }, cwdFrom: id });
  }

  toggleZoom(id: string): void {
    this.zoomedId = this.zoomedId === id ? undefined : id;
    this.render(true);
    this.focus(id);
  }

  isZoomed(id: string): boolean {
    return this.zoomedId === id;
  }

  isLiveResizing(): boolean {
    return this.liveResizing;
  }

  runShortcut(id: string, shortcut: Shortcut): void {
    switch (shortcut) {
      case 'new':
        this.post({ type: 'create' });
        return;
      case 'splitRight':
        this.split(id, 'right');
        return;
      case 'splitDown':
        this.split(id, 'bottom');
        return;
      case 'zoom':
        this.toggleZoom(id);
        return;
      case 'clear':
        this.tiles.get(id)?.clear();
        return;
      case 'find':
        this.tiles.get(id)?.openSearch();
        return;
      case 'focusLeft':
      case 'focusRight':
      case 'focusUp':
      case 'focusDown': {
        if (this.zoomedId) return;
        const edge = ({ focusLeft: 'left', focusRight: 'right', focusUp: 'top', focusDown: 'bottom' } as const)[shortcut];
        const next = neighbour(this.rects, id, edge);
        if (next) this.focus(next);
        return;
      }
    }
  }

  private onDocumentKey(event: KeyboardEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('input, textarea')) return;
    const shortcut = matchShortcut(event, this.isMac);
    if (!shortcut) return;
    if (shortcut === 'new' || this.focusedId) {
      event.preventDefault();
      event.stopPropagation();
      if (shortcut === 'new') this.post({ type: 'create' });
      else if (this.focusedId) this.runShortcut(this.focusedId, shortcut);
    }
  }

  arrange(): void {
    const { w, h } = this.boardSize();
    this.zoomedId = undefined;
    this.layout = arrangeGrid(leafIds(this.layout), w, h);
    this.render(true);
    this.postLayout();
  }

  private postLayout(): void {
    const json = JSON.stringify(this.layout);
    if (json === this.sentLayout) return;
    this.sentLayout = json;
    this.post({ type: 'layout', layout: this.layout });
  }

  // ---- rendering ----

  private boardSize(): { w: number; h: number } {
    return { w: this.board.clientWidth, h: this.board.clientHeight };
  }

  private bounds(): Rect {
    const { w, h } = this.boardSize();
    return { x: PADDING, y: PADDING, w: Math.max(0, w - PADDING * 2), h: Math.max(0, h - PADDING * 2) };
  }

  private render(animate: boolean): void {
    const bounds = this.bounds();
    const { tiles, splitters } = computeRects(this.layout, bounds, GAP);
    this.rects = tiles;
    this.splitterSpecs = splitters;
    this.board.classList.toggle('animate', animate && !this.liveResizing);
    for (const [id, tile] of this.tiles) {
      const rect = this.zoomedId === id ? bounds : tiles.get(id);
      tile.element.hidden = !rect;
      if (rect) place(tile.element, rect);
      tile.element.classList.toggle('behind', this.zoomedId !== undefined && this.zoomedId !== id);
      tile.setZoomed(this.zoomedId === id);
    }
    while (this.splitterEls.length < splitters.length) this.splitterEls.push(this.createSplitter(this.splitterEls.length));
    this.splitterEls.forEach((node, i) => {
      const spec = splitters[i];
      node.hidden = !spec || this.zoomedId !== undefined;
      if (!spec) return;
      place(node, spec.rect);
      node.classList.toggle('row', spec.dir === 'row');
      node.classList.toggle('column', spec.dir === 'column');
    });
    this.empty.hidden = this.tiles.size > 0 || !this.initialised;
  }

  // ---- splitters ----

  private createSplitter(index: number): HTMLDivElement {
    const node = el('div', 'splitter');
    this.board.insertBefore(node, this.dropIndicator);
    node.addEventListener('pointerdown', (event) => {
      const spec = this.splitterSpecs[index];
      const split = spec && nodeAt(this.layout, spec.path);
      if (!spec || !split || split.kind !== 'split' || event.button !== 0) return;
      event.preventDefault();
      const startSizes = [...split.sizes];
      const start = spec.dir === 'row' ? event.clientX : event.clientY;
      node.setPointerCapture(event.pointerId);
      node.classList.add('active');
      this.liveResizing = true;
      this.board.classList.add('resizing');
      const onMove = (e: PointerEvent) => {
        if (!this.layout) return;
        const delta = (spec.dir === 'row' ? e.clientX : e.clientY) - start;
        const min = spec.dir === 'row' ? MIN_TILE_WIDTH : MIN_TILE_HEIGHT;
        this.layout = setSizesAt(this.layout, spec.path, resizeSizes(startSizes, spec.index, delta, spec.span, min));
        this.render(false);
      };
      const onEnd = () => {
        node.removeEventListener('pointermove', onMove);
        node.removeEventListener('pointerup', onEnd);
        node.removeEventListener('pointercancel', onEnd);
        node.classList.remove('active');
        this.liveResizing = false;
        this.board.classList.remove('resizing');
        for (const tile of this.tiles.values()) tile.fitNow();
        this.postLayout();
      };
      node.addEventListener('pointermove', onMove);
      node.addEventListener('pointerup', onEnd);
      node.addEventListener('pointercancel', onEnd);
    });
    node.addEventListener('dblclick', () => {
      const spec = this.splitterSpecs[index];
      const split = spec && nodeAt(this.layout, spec.path);
      if (!spec || !split || split.kind !== 'split' || !this.layout) return;
      this.layout = setSizesAt(this.layout, spec.path, split.sizes.map(() => 1 / split.sizes.length));
      this.render(true);
      this.postLayout();
    });
    return node;
  }

  // ---- drag and drop ----

  beginTileDrag(id: string, event: PointerEvent, handle: HTMLElement): void {
    this.beginDrag({ kind: 'tile', id }, event, handle);
  }

  private beginDrag(source: DragSource, event: PointerEvent, handle: HTMLElement): void {
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let active = false;
    let target: DropTarget | null = null;

    // Capture the pointer only once the drag really starts: capturing on
    // pointerdown would retarget the clicks and double-clicks on the header.
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return;
        active = true;
        try {
          handle.setPointerCapture(pointerId);
        } catch {
          // The pointer is already gone; window listeners still see the moves.
        }
        this.startDragVisuals(source);
      }
      const ghostWidth = this.ghost.offsetWidth;
      const x = e.clientX + 14 + ghostWidth > window.innerWidth ? e.clientX - 14 - ghostWidth : e.clientX + 14;
      this.ghost.style.left = `${Math.max(4, x)}px`;
      this.ghost.style.top = `${Math.min(e.clientY + 14, window.innerHeight - 32)}px`;
      target = this.hitTest(e.clientX, e.clientY, source);
      this.showDropIndicator(target, source);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onUp, true);
      window.removeEventListener('pointercancel', onCancel, true);
      window.removeEventListener('keydown', onKey, true);
      try {
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      } catch {
        // Already released.
      }
      if (!active) return;
      this.endDragVisuals(source);
      // The click that follows a drag must not create a terminal.
      this.suppressClick = true;
      window.setTimeout(() => (this.suppressClick = false), 0);
      if (commit && target) this.drop(source, target);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId === pointerId) finish(true);
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) finish(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !active) return;
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
    window.addEventListener('keydown', onKey, true);
  }

  private startDragVisuals(source: DragSource): void {
    if (this.zoomedId) {
      this.zoomedId = undefined;
      this.render(true);
    }
    document.body.classList.add('dragging');
    this.ghost.replaceChildren();
    const icon = el('span', 'ghost-icon', source.kind === 'new' ? icons.plus : icons.terminal);
    const label = el('span');
    label.textContent = source.kind === 'new' ? this.t('newTerminal') : (this.tiles.get(source.id)?.title ?? '');
    this.ghost.append(icon, label);
    this.ghost.hidden = false;
    if (source.kind === 'tile') this.tiles.get(source.id)?.element.classList.add('drag-source');
  }

  private endDragVisuals(source: DragSource): void {
    document.body.classList.remove('dragging');
    this.ghost.hidden = true;
    this.dropIndicator.hidden = true;
    if (source.kind === 'tile') this.tiles.get(source.id)?.element.classList.remove('drag-source');
  }

  private hitTest(clientX: number, clientY: number, source: DragSource): DropTarget | null {
    const box = this.board.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    if (this.tiles.size === 0) {
      const inside = x >= 0 && y >= 0 && x <= box.width && y <= box.height;
      return source.kind === 'new' && inside ? { zone: 'center' } : null;
    }
    const id = this.tileAt(x, y);
    if (!id) return null;
    if (source.kind === 'tile' && id === source.id) return null;
    const rect = this.rects.get(id);
    return rect ? { id, zone: zoneAt(rect, x, y) } : null;
  }

  private showDropIndicator(target: DropTarget | null, source: DragSource): void {
    if (!target) {
      this.dropIndicator.hidden = true;
      return;
    }
    const tileRect = target.id ? this.rects.get(target.id) : undefined;
    let rect: Rect;
    let label: string;
    if (!tileRect) {
      rect = this.bounds();
      label = this.t('dropHere');
    } else if (target.zone === 'center' && source.kind === 'new') {
      rect = zonePreview(tileRect, preferredEdge(tileRect));
      label = this.t('dropHere');
    } else {
      rect = zonePreview(tileRect, target.zone);
      label = target.zone === 'center' ? this.t('dropSwap') : this.t('dropHere');
    }
    const inset = 3;
    place(this.dropIndicator, { x: rect.x + inset, y: rect.y + inset, w: rect.w - inset * 2, h: rect.h - inset * 2 });
    this.dropIndicator.dataset.label = label;
    this.dropIndicator.hidden = false;
  }

  private drop(source: DragSource, target: DropTarget): void {
    if (source.kind === 'tile') {
      if (!target.id) return;
      this.layout = move(this.layout, source.id, target.id, target.zone);
      this.render(true);
      this.postLayout();
      this.focus(source.id);
      return;
    }
    const rect = target.id ? this.rects.get(target.id) : undefined;
    if (!target.id || !rect) {
      this.post({ type: 'create' });
      return;
    }
    const zone: Edge = target.zone === 'center' ? preferredEdge(rect) : target.zone;
    this.post({ type: 'create', placement: { targetId: target.id, zone }, cwdFrom: target.id });
  }
}

const root = document.getElementById('app');
if (root) new App(root);
